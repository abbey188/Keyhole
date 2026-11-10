//! Ed25519 helpers (NEAR keys, node acks, release-service logs, claims).

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};

/// Public key for a 32-byte seed.
pub fn public_key(seed: &[u8; 32]) -> [u8; 32] {
    SigningKey::from_bytes(seed).verifying_key().to_bytes()
}

/// Signs `msg` with the key derived from `seed`.
pub fn sign(seed: &[u8; 32], msg: &[u8]) -> [u8; 64] {
    SigningKey::from_bytes(seed).sign(msg).to_bytes()
}

/// Verifies an Ed25519 signature. Returns false on any malformed input.
pub fn verify(pk: &[u8; 32], msg: &[u8], sig: &[u8; 64]) -> bool {
    match VerifyingKey::from_bytes(pk) {
        Ok(vk) => vk.verify(msg, &Signature::from_bytes(sig)).is_ok(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 8032 section 7.1 test 1 (empty message).
    #[test]
    fn rfc8032_test1() {
        let seed: [u8; 32] = hex::decode("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
            .unwrap()
            .try_into()
            .unwrap();
        assert_eq!(
            hex::encode(public_key(&seed)),
            "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
        );
        assert_eq!(
            hex::encode(sign(&seed, b"")),
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
        );
    }

    #[test]
    fn sign_verify_and_tamper() {
        let seed = [3u8; 32];
        let pk = public_key(&seed);
        let sig = sign(&seed, b"msg");
        assert!(verify(&pk, b"msg", &sig));
        assert!(!verify(&pk, b"msg2", &sig));
        let mut bad = sig;
        bad[0] ^= 1;
        assert!(!verify(&pk, b"msg", &bad));
        assert!(!verify(&[0u8; 32], b"msg", &sig));
    }
}
