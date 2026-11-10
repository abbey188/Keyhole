//! Receipt commitments and the hash chain kept in each box record (spec 04 section 5.4, 05 section 6).
//! Generic over a SHA-256 function so the contract can pass `env::sha256_array`.

use crate::domain::tag;

/// Digest identifying a bearer-link requester: SHA-256 of tag "requester-bearer" and the public key.
pub fn requester_digest_bearer<H: Fn(&[u8]) -> [u8; 32]>(h: &H, pk: &[u8; 32]) -> [u8; 32] {
    let mut m = tag("requester-bearer");
    m.extend_from_slice(pk);
    h(&m)
}

/// Digest identifying a named requester account.
pub fn requester_digest_account<H: Fn(&[u8]) -> [u8; 32]>(h: &H, account_id: &str) -> [u8; 32] {
    let mut m = tag("requester-account");
    m.extend_from_slice(&(account_id.len() as u16).to_le_bytes());
    m.extend_from_slice(account_id.as_bytes());
    h(&m)
}

/// Commitment to one receipt. The details behind it stay encrypted in the box.
pub fn commitment<H: Fn(&[u8]) -> [u8; 32]>(
    h: &H,
    grant_id: &[u8; 16],
    session_id: &[u8; 16],
    session_pk: &[u8; 32],
    requester_digest: &[u8; 32],
    opened_at_ms: u64,
) -> [u8; 32] {
    let mut m = tag("receipt");
    m.extend_from_slice(grant_id);
    m.extend_from_slice(session_id);
    m.extend_from_slice(session_pk);
    m.extend_from_slice(requester_digest);
    m.extend_from_slice(&opened_at_ms.to_le_bytes());
    h(&m)
}

/// Commitment for a session close (extends the same chain).
pub fn close_commitment<H: Fn(&[u8]) -> [u8; 32]>(
    h: &H,
    session_id: &[u8; 16],
    log_root: &[u8; 32],
    closed_at_ms: u64,
) -> [u8; 32] {
    let mut m = tag("receipt-close");
    m.extend_from_slice(session_id);
    m.extend_from_slice(log_root);
    m.extend_from_slice(&closed_at_ms.to_le_bytes());
    h(&m)
}

/// The initial chain head of a new box.
pub const GENESIS_HEAD: [u8; 32] = [0u8; 32];

/// Next chain head: `H(tag "chain" || head || commitment)`.
pub fn chain_next<H: Fn(&[u8]) -> [u8; 32]>(h: &H, head: &[u8; 32], commitment: &[u8; 32]) -> [u8; 32] {
    let mut m = tag("chain");
    m.extend_from_slice(head);
    m.extend_from_slice(commitment);
    h(&m)
}

/// Recomputes a chain from a list of commitments, starting at genesis. Returns the final head.
pub fn recompute_chain<H: Fn(&[u8]) -> [u8; 32]>(h: &H, commitments: &[[u8; 32]]) -> [u8; 32] {
    commitments
        .iter()
        .fold(GENESIS_HEAD, |head, c| chain_next(h, &head, c))
}

#[cfg(all(test, feature = "crypto"))]
mod tests {
    use super::*;
    use crate::hashing::sha256;

    #[test]
    fn chain_detects_any_edit_or_removal() {
        let h = |d: &[u8]| sha256(d);
        let cs: Vec<[u8; 32]> = (0u8..5).map(|i| [i; 32]).collect();
        let head = recompute_chain(&h, &cs);

        let mut edited = cs.clone();
        edited[2][0] ^= 1;
        assert_ne!(head, recompute_chain(&h, &edited));

        let mut removed = cs.clone();
        removed.remove(3);
        assert_ne!(head, recompute_chain(&h, &removed));

        let mut reordered = cs.clone();
        reordered.swap(0, 1);
        assert_ne!(head, recompute_chain(&h, &reordered));

        // Appending changes the head too.
        let mut appended = cs.clone();
        appended.push([9u8; 32]);
        assert_ne!(head, recompute_chain(&h, &appended));
    }

    #[test]
    fn commitment_binds_fields() {
        let h = |d: &[u8]| sha256(d);
        let g = [1u8; 16];
        let s = [2u8; 16];
        let pk = [3u8; 32];
        let rd = requester_digest_bearer(&h, &pk);
        let c = commitment(&h, &g, &s, &pk, &rd, 100);
        assert_ne!(c, commitment(&h, &g, &s, &pk, &rd, 101));
        assert_ne!(c, commitment(&h, &[9u8; 16], &s, &pk, &rd, 100));
        assert_ne!(requester_digest_bearer(&h, &pk), requester_digest_account(&h, "a.testnet"));
    }
}
