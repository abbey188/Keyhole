//! Sealed box: ephemeral X25519 key, HKDF-SHA256 with a purpose-specific `info`, XChaCha20-Poly1305.
//! Wire format `eph_pub(32) || nonce(24) || ciphertext || tag(16)`, same layout as NEAR AI's E2EE v2.

use crate::{aead, kdf::hkdf32, Error};
use x25519_dalek::{PublicKey, StaticSecret};

/// X25519 public key for a secret.
pub fn public_key(secret: &[u8; 32]) -> [u8; 32] {
    PublicKey::from(&StaticSecret::from(*secret)).to_bytes()
}

fn derive(shared: &[u8; 32], info: &[u8]) -> [u8; 32] {
    hkdf32(shared, info)
}

/// Seals with caller-supplied ephemeral secret and nonce (vectors, tests).
pub fn seal_with(
    recipient_pk: &[u8; 32],
    plaintext: &[u8],
    info: &[u8],
    eph_secret: &[u8; 32],
    nonce: &[u8; aead::NONCE_LEN],
) -> Result<Vec<u8>, Error> {
    let eph = StaticSecret::from(*eph_secret);
    let shared = eph.diffie_hellman(&PublicKey::from(*recipient_pk));
    if !shared.was_contributory() {
        return Err(Error::Invalid);
    }
    let key = derive(shared.as_bytes(), info);
    let eph_pub = PublicKey::from(&eph).to_bytes();
    let unit = aead::seal_with_nonce(&key, nonce, plaintext, &eph_pub);
    let mut out = Vec::with_capacity(32 + unit.len());
    out.extend_from_slice(&eph_pub);
    out.extend_from_slice(&unit);
    Ok(out)
}

/// Seals with fresh random ephemeral key and nonce.
pub fn seal(recipient_pk: &[u8; 32], plaintext: &[u8], info: &[u8]) -> Result<Vec<u8>, Error> {
    use rand_core::{OsRng, RngCore};
    let mut eph = [0u8; 32];
    let mut nonce = [0u8; aead::NONCE_LEN];
    OsRng.fill_bytes(&mut eph);
    OsRng.fill_bytes(&mut nonce);
    seal_with(recipient_pk, plaintext, info, &eph, &nonce)
}

/// Opens a sealed box with the recipient's X25519 secret.
pub fn open(recipient_secret: &[u8; 32], data: &[u8], info: &[u8]) -> Result<Vec<u8>, Error> {
    if data.len() < 32 + aead::NONCE_LEN + aead::TAG_LEN {
        return Err(Error::Invalid);
    }
    let mut eph_pub = [0u8; 32];
    eph_pub.copy_from_slice(&data[..32]);
    let sk = StaticSecret::from(*recipient_secret);
    let shared = sk.diffie_hellman(&PublicKey::from(eph_pub));
    if !shared.was_contributory() {
        return Err(Error::Invalid);
    }
    let key = derive(shared.as_bytes(), info);
    aead::open(&key, &data[32..], &eph_pub)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 7748 section 6.1 Diffie-Hellman test vector validates the X25519 primitive wiring.
    #[test]
    fn rfc7748_vector() {
        let a = hex::decode("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a").unwrap();
        let b_pub = hex::decode("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f").unwrap();
        let a_pub = hex::decode("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a").unwrap();
        let mut a32 = [0u8; 32];
        a32.copy_from_slice(&a);
        assert_eq!(hex::encode(public_key(&a32)), hex::encode(a_pub));
        let mut b32 = [0u8; 32];
        b32.copy_from_slice(&b_pub);
        let shared = StaticSecret::from(a32).diffie_hellman(&PublicKey::from(b32));
        assert_eq!(
            hex::encode(shared.as_bytes()),
            "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742"
        );
    }

    #[test]
    fn roundtrip_and_binding() {
        let sk = [7u8; 32];
        let pk = public_key(&sk);
        let sealed = seal(&pk, b"half-key", b"keyhole/v1/seal").unwrap();
        assert_eq!(open(&sk, &sealed, b"keyhole/v1/seal").unwrap(), b"half-key");
        // Wrong recipient, wrong info and any tampering fail.
        assert!(open(&[8u8; 32], &sealed, b"keyhole/v1/seal").is_err());
        assert!(open(&sk, &sealed, b"other").is_err());
        let mut t = sealed.clone();
        let last = t.len() - 1;
        t[last] ^= 1;
        assert!(open(&sk, &t, b"keyhole/v1/seal").is_err());
        let mut t2 = sealed.clone();
        t2[0] ^= 1; // altered ephemeral key
        assert!(open(&sk, &t2, b"keyhole/v1/seal").is_err());
    }

    #[test]
    fn fresh_randomness_each_time() {
        let pk = public_key(&[7u8; 32]);
        assert_ne!(seal(&pk, b"x", b"i").unwrap(), seal(&pk, b"x", b"i").unwrap());
    }

    #[test]
    fn low_order_point_rejected() {
        // The all-zero public key is a low-order point: the shared secret is not contributory.
        assert!(seal_with(&[0u8; 32], b"x", b"i", &[5u8; 32], &[0u8; 24]).is_err());
    }
}
