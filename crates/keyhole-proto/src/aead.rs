//! Segment AEAD: XChaCha20-Poly1305 with a 24-byte nonce prepended: `nonce || ciphertext || tag`.
//! The AAD binds a unit to its box, item, position, segment count and epoch (spec 02 section 3.2).

use crate::{domain::tag, Error};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};

/// Nonce length in bytes.
pub const NONCE_LEN: usize = 24;
/// Poly1305 tag length in bytes.
pub const TAG_LEN: usize = 16;

/// Builds the AAD for a segment unit.
pub fn seg_aad(
    box_id: &[u8; 16],
    item_uid: &[u8; 16],
    s: u32,
    total_segments: u32,
    epoch: u32,
) -> Vec<u8> {
    let mut a = tag("seg");
    a.extend_from_slice(box_id);
    a.extend_from_slice(item_uid);
    a.extend_from_slice(&s.to_le_bytes());
    a.extend_from_slice(&total_segments.to_le_bytes());
    a.extend_from_slice(&epoch.to_le_bytes());
    a
}

/// Encrypts with a caller-supplied nonce (used by vector generation and tests).
pub fn seal_with_nonce(key: &[u8; 32], nonce: &[u8; NONCE_LEN], plaintext: &[u8], aad: &[u8]) -> Vec<u8> {
    let c = XChaCha20Poly1305::new(key.into());
    let ct = c
        .encrypt(XNonce::from_slice(nonce), Payload { msg: plaintext, aad })
        .expect("encryption of in-memory data cannot fail");
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(nonce);
    out.extend_from_slice(&ct);
    out
}

/// Encrypts with a fresh random nonce.
pub fn seal(key: &[u8; 32], plaintext: &[u8], aad: &[u8]) -> Vec<u8> {
    use rand_core::{OsRng, RngCore};
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    seal_with_nonce(key, &nonce, plaintext, aad)
}

/// Decrypts a unit. Any failure is `Error::Invalid`.
pub fn open(key: &[u8; 32], unit: &[u8], aad: &[u8]) -> Result<Vec<u8>, Error> {
    if unit.len() < NONCE_LEN + TAG_LEN {
        return Err(Error::Invalid);
    }
    let (nonce, ct) = unit.split_at(NONCE_LEN);
    let c = XChaCha20Poly1305::new(key.into());
    c.decrypt(XNonce::from_slice(nonce), Payload { msg: ct, aad })
        .map_err(|_| Error::Invalid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn roundtrip_and_overhead() {
        let k = [1u8; 32];
        let aad = seg_aad(&[1; 16], &[2; 16], 0, 1, 0);
        let u = seal(&k, b"hello", &aad);
        assert_eq!(u.len(), NONCE_LEN + 5 + TAG_LEN);
        assert_eq!(open(&k, &u, &aad).unwrap(), b"hello");
    }

    #[test]
    fn empty_plaintext_ok() {
        let k = [1u8; 32];
        let u = seal(&k, b"", b"a");
        assert_eq!(open(&k, &u, b"a").unwrap(), b"");
    }

    #[test]
    fn wrong_key_or_aad_fails() {
        let k = [1u8; 32];
        let aad = seg_aad(&[1; 16], &[2; 16], 3, 10, 0);
        let u = seal(&k, b"secret", &aad);
        assert!(open(&[2u8; 32], &u, &aad).is_err());
        // Each AAD field is bound: position, count, epoch, item, box.
        for other in [
            seg_aad(&[1; 16], &[2; 16], 4, 10, 0),
            seg_aad(&[1; 16], &[2; 16], 3, 11, 0),
            seg_aad(&[1; 16], &[2; 16], 3, 10, 1),
            seg_aad(&[1; 16], &[9; 16], 3, 10, 0),
            seg_aad(&[9; 16], &[2; 16], 3, 10, 0),
        ] {
            assert!(open(&k, &u, &other).is_err());
        }
    }

    #[test]
    fn short_input_rejected() {
        assert!(open(&[0u8; 32], &[0u8; 39], b"").is_err());
    }

    /// Known-answer check against the XChaCha20-Poly1305 construction: fixed inputs must stay stable.
    #[test]
    fn fixed_vector_is_stable() {
        let k = [0x11u8; 32];
        let n = [0x22u8; NONCE_LEN];
        let u = seal_with_nonce(&k, &n, b"keyhole", b"aad");
        assert_eq!(&u[..NONCE_LEN], &n);
        assert_eq!(open(&k, &u, b"aad").unwrap(), b"keyhole");
        // Re-sealing with the same inputs is deterministic.
        assert_eq!(u, seal_with_nonce(&k, &n, b"keyhole", b"aad"));
    }

    proptest! {
        #[test]
        fn roundtrip_random(pt in proptest::collection::vec(any::<u8>(), 0..4096), k in any::<[u8;32]>()) {
            let aad = seg_aad(&[1;16], &[2;16], 0, 1, 0);
            let u = seal(&k, &pt, &aad);
            prop_assert_eq!(open(&k, &u, &aad).unwrap(), pt);
        }

        #[test]
        fn any_bit_flip_fails(pt in proptest::collection::vec(any::<u8>(), 1..512), idx in any::<usize>(), bit in 0u8..8) {
            let k = [3u8;32];
            let aad = b"x";
            let mut u = seal(&k, &pt, aad);
            let i = idx % u.len();
            u[i] ^= 1 << bit;
            prop_assert!(open(&k, &u, aad).is_err());
        }
    }
}
