//! Canonical byte strings that are signed or verified on-chain. Strings are length-prefixed (u16 LE)
//! so no two different inputs encode to the same bytes. Integers are little-endian.

use crate::domain::tag;

fn lp(out: &mut Vec<u8>, s: &str) {
    let b = s.as_bytes();
    assert!(b.len() <= u16::MAX as usize);
    out.extend_from_slice(&(b.len() as u16).to_le_bytes());
    out.extend_from_slice(b);
}

/// Message a bearer-link recipient signs to open a session (verified by the contract).
pub fn open_msg(
    chain_id: &str,
    contract_id: &str,
    grant_id: &[u8; 16],
    session_id: &[u8; 16],
    session_pk: &[u8; 32],
    ts_ms: u64,
) -> Vec<u8> {
    let mut m = tag("open");
    lp(&mut m, chain_id);
    lp(&mut m, contract_id);
    m.extend_from_slice(grant_id);
    m.extend_from_slice(session_id);
    m.extend_from_slice(session_pk);
    m.extend_from_slice(&ts_ms.to_le_bytes());
    m
}

/// Message a storage node signs to acknowledge it holds a whole blob (verified by the contract).
pub fn ack_msg(
    chain_id: &str,
    contract_id: &str,
    reg_id: u64,
    blob_id: &[u8; 32],
    mode: u8,
    valid_until_ms: u64,
) -> Vec<u8> {
    let mut m = tag("ack");
    lp(&mut m, chain_id);
    lp(&mut m, contract_id);
    m.extend_from_slice(&reg_id.to_le_bytes());
    m.extend_from_slice(blob_id);
    m.push(mode);
    m.extend_from_slice(&valid_until_ms.to_le_bytes());
    m
}

/// Message a storage node signs to attest that it erased a retired blob.
pub fn erase_msg(chain_id: &str, contract_id: &str, reg_id: u64, blob_id: &[u8; 32]) -> Vec<u8> {
    let mut m = tag("erase");
    lp(&mut m, chain_id);
    lp(&mut m, contract_id);
    m.extend_from_slice(&reg_id.to_le_bytes());
    m.extend_from_slice(blob_id);
    m
}

/// Message the release service signs when closing a session with a log root.
pub fn close_msg(
    chain_id: &str,
    contract_id: &str,
    session_id: &[u8; 16],
    log_root: &[u8; 32],
    closed_at_ms: u64,
) -> Vec<u8> {
    let mut m = tag("close");
    lp(&mut m, chain_id);
    lp(&mut m, contract_id);
    m.extend_from_slice(session_id);
    m.extend_from_slice(log_root);
    m.extend_from_slice(&closed_at_ms.to_le_bytes());
    m
}

/// Message an owner signs to authorize uploading a grant's scope to the release service.
pub fn rs_put_msg(chain_id: &str, grant_id: &[u8; 16], body_sha256: &[u8; 32], ts_ms: u64) -> Vec<u8> {
    let mut m = tag("rs-put");
    lp(&mut m, chain_id);
    m.extend_from_slice(grant_id);
    m.extend_from_slice(body_sha256);
    m.extend_from_slice(&ts_ms.to_le_bytes());
    m
}

/// Ticket body a release service signs for a storage node read.
pub fn ticket_msg(blob_id: &[u8; 32], session_id: &[u8; 16], exp_ms: u64) -> Vec<u8> {
    let mut m = tag("ticket");
    m.extend_from_slice(blob_id);
    m.extend_from_slice(session_id);
    m.extend_from_slice(&exp_ms.to_le_bytes());
    m
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn open_msg_binds_every_field() {
        let g = [1u8; 16];
        let s = [2u8; 16];
        let pk = [3u8; 32];
        let base = open_msg("testnet", "k.testnet", &g, &s, &pk, 10);
        assert_ne!(base, open_msg("mainnet", "k.testnet", &g, &s, &pk, 10));
        assert_ne!(base, open_msg("testnet", "j.testnet", &g, &s, &pk, 10));
        assert_ne!(base, open_msg("testnet", "k.testnet", &[9u8; 16], &s, &pk, 10));
        assert_ne!(base, open_msg("testnet", "k.testnet", &g, &[9u8; 16], &pk, 10));
        assert_ne!(base, open_msg("testnet", "k.testnet", &g, &s, &[9u8; 32], 10));
        assert_ne!(base, open_msg("testnet", "k.testnet", &g, &s, &pk, 11));
    }
    #[test]
    fn length_prefix_prevents_ambiguity() {
        // "ab"+"c" and "a"+"bc" must not collide.
        let g = [0u8; 16];
        let a = open_msg("ab", "c", &g, &g, &[0u8; 32], 0);
        let b = open_msg("a", "bc", &g, &g, &[0u8; 32], 0);
        assert_ne!(a, b);
    }
    #[test]
    fn different_message_kinds_do_not_collide() {
        let id = [0u8; 32];
        assert_ne!(ack_msg("t", "c", 1, &id, 0, 0), erase_msg("t", "c", 1, &id));
    }
}
