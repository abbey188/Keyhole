//! Padmé padding (Nikitin et al., PoPETs 2019; cited from memory) with ISO 7816-4 style fill:
//! append 0x80 then zeros up to `padme(len + 1)`. Leaks only a length bucket, overhead at most about 12%.

use crate::Error;

/// The Padmé padded length for a message of `len` bytes.
pub fn padme_len(len: usize) -> usize {
    if len < 2 {
        return len;
    }
    let l = (usize::BITS - 1 - len.leading_zeros()) as usize; // floor(log2 len)
    let s = (usize::BITS - 1 - l.leading_zeros()) as usize + 1; // floor(log2 l) + 1
    let last_bits = l - s;
    let mask = (1usize << last_bits) - 1;
    (len + mask) & !mask
}

/// Pads `msg` so that the output length is `padme_len(msg.len() + 1)`.
pub fn pad(msg: &[u8]) -> Vec<u8> {
    let target = padme_len(msg.len() + 1);
    let mut out = Vec::with_capacity(target);
    out.extend_from_slice(msg);
    out.push(0x80);
    out.resize(target, 0);
    out
}

/// Removes padding added by [`pad`].
pub fn unpad(padded: &[u8]) -> Result<Vec<u8>, Error> {
    let mut i = padded.len();
    while i > 0 && padded[i - 1] == 0 {
        i -= 1;
    }
    if i == 0 || padded[i - 1] != 0x80 {
        return Err(Error::Invalid);
    }
    Ok(padded[..i - 1].to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn small_values_and_known_points() {
        assert_eq!(padme_len(0), 0);
        assert_eq!(padme_len(1), 1);
        assert_eq!(padme_len(2), 2);
        // Padmé never shrinks and is monotone non-decreasing.
        let mut prev = 0;
        for n in 0..5000 {
            let p = padme_len(n);
            assert!(p >= n);
            assert!(p >= prev);
            prev = p;
        }
    }

    #[test]
    fn overhead_bound_for_large_messages() {
        for n in [100usize, 1000, 12345, 1 << 20, (1 << 20) + 1, 33_554_431] {
            let p = padme_len(n);
            assert!(p - n <= n / 8 + 1, "n={n} padded={p}");
        }
    }

    #[test]
    fn roundtrip_including_trailing_zero_messages() {
        for msg in [vec![], vec![0u8], vec![0u8; 10], b"abc".to_vec(), vec![0x80u8], vec![1, 0, 0]] {
            let p = pad(&msg);
            assert_eq!(unpad(&p).unwrap(), msg);
            assert_eq!(p.len(), padme_len(msg.len() + 1));
        }
    }

    #[test]
    fn malformed_padding_rejected() {
        assert!(unpad(&[]).is_err());
        assert!(unpad(&[0, 0, 0]).is_err());
        assert!(unpad(&[1, 2, 3]).is_err());
    }

    proptest! {
        #[test]
        fn pad_unpad(msg in proptest::collection::vec(any::<u8>(), 0..3000)) {
            let p = pad(&msg);
            prop_assert_eq!(unpad(&p).unwrap(), msg);
        }
    }
}
