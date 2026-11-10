//! RFC 6962 / RFC 9162 style Merkle tree over blob leaves, generic over SHA-256.
//! Leaf hash: H(0x00 || leaf). Node hash: H(0x01 || left || right). Split at the largest power of two
//! below the leaf count. `blob_id` binds the root to the stream length and parameters.

use crate::domain::tag;

/// H(0x00 || piece).
pub fn leaf_hash<H: Fn(&[u8]) -> [u8; 32]>(h: &H, piece: &[u8]) -> [u8; 32] {
    let mut m = Vec::with_capacity(1 + piece.len());
    m.push(0x00);
    m.extend_from_slice(piece);
    h(&m)
}

/// H(0x01 || left || right).
pub fn node_hash<H: Fn(&[u8]) -> [u8; 32]>(h: &H, l: &[u8; 32], r: &[u8; 32]) -> [u8; 32] {
    let mut m = [0u8; 65];
    m[0] = 0x01;
    m[1..33].copy_from_slice(l);
    m[33..].copy_from_slice(r);
    h(&m)
}

fn split_point(n: usize) -> usize {
    // Largest power of two strictly less than n (n >= 2).
    let mut k = 1usize;
    while k << 1 < n {
        k <<= 1;
    }
    k
}

/// Merkle root over already-hashed leaves. Panics on an empty slice (a blob always has a leaf).
pub fn root<H: Fn(&[u8]) -> [u8; 32]>(h: &H, leaves: &[[u8; 32]]) -> [u8; 32] {
    assert!(!leaves.is_empty());
    if leaves.len() == 1 {
        return leaves[0];
    }
    let k = split_point(leaves.len());
    node_hash(h, &root(h, &leaves[..k]), &root(h, &leaves[k..]))
}

/// Audit path (sibling hashes, deepest first) for leaf `index`.
pub fn audit_path<H: Fn(&[u8]) -> [u8; 32]>(h: &H, leaves: &[[u8; 32]], index: usize) -> Vec<[u8; 32]> {
    assert!(index < leaves.len());
    if leaves.len() == 1 {
        return Vec::new();
    }
    let k = split_point(leaves.len());
    if index < k {
        let mut p = audit_path(h, &leaves[..k], index);
        p.push(root(h, &leaves[k..]));
        p
    } else {
        let mut p = audit_path(h, &leaves[k..], index - k);
        p.push(root(h, &leaves[..k]));
        p
    }
}

/// Verifies an inclusion proof (RFC 9162 section 2.1.3.2).
///
/// Note: the proof does not authenticate `tree_size`; take it from the blob record, whose `blob_id`
/// binds the stream length.
pub fn verify_inclusion<H: Fn(&[u8]) -> [u8; 32]>(
    h: &H,
    leaf: &[u8; 32],
    index: usize,
    tree_size: usize,
    path: &[[u8; 32]],
    expected_root: &[u8; 32],
) -> bool {
    if index >= tree_size {
        return false;
    }
    let mut fnn = index;
    let mut sn = tree_size - 1;
    let mut r = *leaf;
    for p in path {
        if sn == 0 {
            return false;
        }
        if fnn & 1 == 1 || fnn == sn {
            r = node_hash(h, p, &r);
            if fnn & 1 == 0 {
                while fnn & 1 == 0 && fnn != 0 {
                    fnn >>= 1;
                    sn >>= 1;
                }
            }
        } else {
            r = node_hash(h, &r, p);
        }
        fnn >>= 1;
        sn >>= 1;
    }
    sn == 0 && &r == expected_root
}

/// `blob_id = H(tag "blobid" || root || u64 stream_len || u32 leaf_size || u8 version)`.
pub fn blob_id<H: Fn(&[u8]) -> [u8; 32]>(
    h: &H,
    root: &[u8; 32],
    stream_len: u64,
    leaf_size: u32,
    version: u8,
) -> [u8; 32] {
    let mut m = tag("blobid");
    m.extend_from_slice(root);
    m.extend_from_slice(&stream_len.to_le_bytes());
    m.extend_from_slice(&leaf_size.to_le_bytes());
    m.push(version);
    h(&m)
}

#[cfg(all(test, feature = "crypto"))]
mod tests {
    use super::*;
    use crate::hashing::sha256;
    use proptest::prelude::*;

    fn leaves(n: usize) -> Vec<[u8; 32]> {
        let h = |d: &[u8]| sha256(d);
        (0..n).map(|i| leaf_hash(&h, &(i as u64).to_le_bytes())).collect()
    }

    #[test]
    fn every_leaf_of_every_size_verifies() {
        let h = |d: &[u8]| sha256(d);
        for n in 1..=70 {
            let ls = leaves(n);
            let r = root(&h, &ls);
            for i in 0..n {
                let p = audit_path(&h, &ls, i);
                assert!(verify_inclusion(&h, &ls[i], i, n, &p, &r), "n={n} i={i}");
            }
        }
    }

    #[test]
    fn wrong_leaf_index_size_or_sibling_fails() {
        let h = |d: &[u8]| sha256(d);
        let n = 13;
        let ls = leaves(n);
        let r = root(&h, &ls);
        let p = audit_path(&h, &ls, 5);
        assert!(verify_inclusion(&h, &ls[5], 5, n, &p, &r));
        assert!(!verify_inclusion(&h, &ls[4], 5, n, &p, &r)); // wrong leaf
        assert!(!verify_inclusion(&h, &ls[5], 6, n, &p, &r)); // wrong index
        // A size that makes the index invalid or changes the path length fails. A size with the same
        // path shape (13 vs 14 here) is NOT rejected: the proof does not authenticate the tree size,
        // which is why callers take it from the blob record (blob_id binds the stream length).
        assert!(!verify_inclusion(&h, &ls[5], 5, 5, &p, &r));
        assert!(!verify_inclusion(&h, &ls[5], 5, 2, &p, &r));
        let mut bad = p.clone();
        bad[0][0] ^= 1;
        assert!(!verify_inclusion(&h, &ls[5], 5, n, &bad, &r)); // altered sibling
        assert!(!verify_inclusion(&h, &ls[5], 5, n, &p[1..], &r)); // truncated path
        assert!(!verify_inclusion(&h, &ls[5], 20, n, &p, &r)); // index beyond size
    }

    #[test]
    fn known_small_tree_shape() {
        // For 3 leaves: root = node(node(l0,l1), l2) (RFC 6962 split at 2).
        let h = |d: &[u8]| sha256(d);
        let ls = leaves(3);
        let expect = node_hash(&h, &node_hash(&h, &ls[0], &ls[1]), &ls[2]);
        assert_eq!(root(&h, &ls), expect);
    }

    #[test]
    fn blob_id_binds_parameters() {
        let h = |d: &[u8]| sha256(d);
        let r = [7u8; 32];
        let b = blob_id(&h, &r, 1000, 65536, 1);
        assert_ne!(b, blob_id(&h, &[8u8; 32], 1000, 65536, 1));
        assert_ne!(b, blob_id(&h, &r, 1001, 65536, 1));
        assert_ne!(b, blob_id(&h, &r, 1000, 32768, 1));
        assert_ne!(b, blob_id(&h, &r, 1000, 65536, 2));
    }

    proptest! {
        #[test]
        fn random_trees_prove_and_reject(n in 1usize..200, i in 0usize..200, flip in 0usize..32) {
            let h = |d: &[u8]| sha256(d);
            let ls = leaves(n);
            let i = i % n;
            let r = root(&h, &ls);
            let p = audit_path(&h, &ls, i);
            prop_assert!(verify_inclusion(&h, &ls[i], i, n, &p, &r));
            let mut bad_root = r;
            bad_root[flip] ^= 1;
            prop_assert!(!verify_inclusion(&h, &ls[i], i, n, &p, &bad_root));
        }
    }
}
