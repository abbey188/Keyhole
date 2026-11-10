//! Split-key access (spec 02 section 5): `SK = S1 XOR S2`, where `S1` derives from a per-grant seed
//! that lives only in the recipient's link fragment, and `S2` is held by the release service and
//! released only while the on-chain grant is valid. Either share alone is uniformly random.

use crate::{domain::tag, kdf::hkdf32};

/// The recipient's share for segment `s` of item `item_uid`.
pub fn s1(seed: &[u8; 32], item_uid: &[u8; 16], s: u32) -> [u8; 32] {
    let mut info = tag("s1");
    info.extend_from_slice(item_uid);
    info.extend_from_slice(&s.to_le_bytes());
    hkdf32(seed, &info)
}

fn xor(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut o = [0u8; 32];
    for i in 0..32 {
        o[i] = a[i] ^ b[i];
    }
    o
}

/// The release service's share: `S2 = SK XOR S1`.
pub fn s2(segment_key: &[u8; 32], s1: &[u8; 32]) -> [u8; 32] {
    xor(segment_key, s1)
}

/// Reconstructs the segment key from both shares.
pub fn combine(s1: &[u8; 32], s2: &[u8; 32]) -> [u8; 32] {
    xor(s1, s2)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kdf::segment_key;

    #[test]
    fn shares_reconstruct_and_are_per_grant() {
        let sk = segment_key(&[4u8; 32], 2);
        let seed_a = [1u8; 32];
        let seed_b = [2u8; 32];
        let item = [9u8; 16];
        let a1 = s1(&seed_a, &item, 2);
        let a2 = s2(&sk, &a1);
        assert_eq!(combine(&a1, &a2), sk);
        // A different grant has a different S1 and therefore a different S2 for the same key.
        let b1 = s1(&seed_b, &item, 2);
        assert_ne!(a1, b1);
        assert_ne!(a2, s2(&sk, &b1));
        // S1 of the wrong grant does not reconstruct the key.
        assert_ne!(combine(&b1, &a2), sk);
    }

    #[test]
    fn neither_share_equals_the_key() {
        let sk = segment_key(&[4u8; 32], 0);
        let a1 = s1(&[1u8; 32], &[9u8; 16], 0);
        assert_ne!(a1, sk);
        assert_ne!(s2(&sk, &a1), sk);
    }

    #[test]
    fn shares_differ_per_segment_and_item() {
        let seed = [1u8; 32];
        assert_ne!(s1(&seed, &[1u8; 16], 0), s1(&seed, &[1u8; 16], 1));
        assert_ne!(s1(&seed, &[1u8; 16], 0), s1(&seed, &[2u8; 16], 0));
    }
}
