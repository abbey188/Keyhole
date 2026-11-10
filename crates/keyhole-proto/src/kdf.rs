//! Key hierarchy (spec 02 section 2). All keys are 32 bytes, derived with HKDF-SHA256.

use crate::domain::tag;
use hkdf::Hkdf;
use sha2::Sha256;

/// HKDF-SHA256 with no salt, extracting from `ikm` and expanding with `info` to 32 bytes.
pub fn hkdf32(ikm: &[u8], info: &[u8]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(None, ikm);
    let mut out = [0u8; 32];
    hk.expand(info, &mut out).expect("32 bytes is a valid HKDF-SHA256 length");
    out
}

fn info(purpose: &str, extra: &[u8]) -> Vec<u8> {
    let mut v = tag(purpose);
    v.extend_from_slice(extra);
    v
}

/// The two WebAuthn PRF salts (the browser/authenticator hashes them with its own fixed prefix).
pub const PRF_SALT_ACCOUNT: &[u8] = b"keyhole/v1/prf/account";
/// Salt for the data-root PRF output.
pub const PRF_SALT_DATA: &[u8] = b"keyhole/v1/prf/data";

/// Ed25519 seed for the NEAR account key at `index` (0 = main account).
pub fn account_seed(prf1: &[u8; 32], index: u32) -> [u8; 32] {
    hkdf32(prf1, &info("near-ed25519", &index.to_le_bytes()))
}

/// Data root DR from the second PRF output.
pub fn data_root(prf2: &[u8; 32]) -> [u8; 32] {
    hkdf32(prf2, &info("data-root", &[]))
}

/// Key that wraps a box's master key for its owner.
pub fn box_wrap_key(dr: &[u8; 32], box_id: &[u8; 16]) -> [u8; 32] {
    hkdf32(dr, &info("box-wrap", box_id))
}

/// Owner X25519 secret (receives handover envelopes).
pub fn x25519_secret(dr: &[u8; 32]) -> [u8; 32] {
    hkdf32(dr, &info("x25519", &0u32.to_le_bytes()))
}

/// Ed25519 seed for the claims-signing key.
pub fn claims_seed(dr: &[u8; 32]) -> [u8; 32] {
    hkdf32(dr, &info("claims-ed25519", &0u32.to_le_bytes()))
}

/// Epoch key BK_e from the box master key.
pub fn epoch_key(bmk: &[u8; 32], epoch: u32) -> [u8; 32] {
    hkdf32(bmk, &info("epoch", &epoch.to_le_bytes()))
}

/// Manifest key, independent of item-key derivation so the manifest can be shared without content.
pub fn manifest_key(bmk: &[u8; 32], epoch: u32) -> [u8; 32] {
    hkdf32(bmk, &info("manifest", &epoch.to_le_bytes()))
}

/// Item data-encryption key from the epoch key and a unique item uid.
pub fn item_dek(bk: &[u8; 32], item_uid: &[u8; 16]) -> [u8; 32] {
    hkdf32(bk, &info("item", item_uid))
}

/// Key of segment `s` of an item.
pub fn segment_key(dek: &[u8; 32], s: u32) -> [u8; 32] {
    hkdf32(dek, &info("seg", &s.to_le_bytes()))
}

/// Key commitment published for an item: SHA-256(tag "dekc" || DEK).
pub fn dek_commit(dek: &[u8; 32]) -> [u8; 32] {
    let mut m = tag("dekc");
    m.extend_from_slice(dek);
    crate::hashing::sha256(&m)
}

/// Commitment to a box master key used in deals: SHA-256(tag "bmk" || BMK).
pub fn bmk_commit(bmk: &[u8; 32]) -> [u8; 32] {
    let mut m = tag("bmk");
    m.extend_from_slice(bmk);
    crate::hashing::sha256(&m)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 5869 test case 3 (SHA-256, empty salt and info) validates the HKDF building block.
    #[test]
    fn hkdf_rfc5869_case3_prefix() {
        let ikm = [0x0bu8; 22];
        let hk = Hkdf::<Sha256>::new(None, &ikm);
        let mut okm = [0u8; 42];
        hk.expand(b"", &mut okm).unwrap();
        assert_eq!(
            hex::encode(okm),
            "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8"
        );
    }

    #[test]
    fn hierarchy_separates_every_purpose() {
        let prf = [5u8; 32];
        let dr = data_root(&prf);
        let bmk = [6u8; 32];
        let ks = [
            account_seed(&prf, 0),
            account_seed(&prf, 1),
            dr,
            box_wrap_key(&dr, &[1u8; 16]),
            box_wrap_key(&dr, &[2u8; 16]),
            x25519_secret(&dr),
            claims_seed(&dr),
            epoch_key(&bmk, 0),
            epoch_key(&bmk, 1),
            manifest_key(&bmk, 0),
            item_dek(&epoch_key(&bmk, 0), &[1u8; 16]),
            item_dek(&epoch_key(&bmk, 0), &[2u8; 16]),
            segment_key(&[7u8; 32], 0),
            segment_key(&[7u8; 32], 1),
        ];
        for i in 0..ks.len() {
            for j in (i + 1)..ks.len() {
                assert_ne!(ks[i], ks[j], "keys {i} and {j} collide");
            }
        }
    }

    #[test]
    fn derivation_is_deterministic() {
        let prf = [9u8; 32];
        assert_eq!(data_root(&prf), data_root(&prf));
        assert_eq!(account_seed(&prf, 3), account_seed(&prf, 3));
    }

    #[test]
    fn commitments_differ_by_purpose() {
        let k = [1u8; 32];
        assert_ne!(dek_commit(&k), bmk_commit(&k));
    }
}
