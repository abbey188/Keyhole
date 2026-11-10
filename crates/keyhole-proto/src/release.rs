//! Byte formats shared by the release service, its clients and tests (spec 05): scope hash, deal key-half
//! commitment and acknowledgement, authentication body hashes, and the page-level log chain.
//! Generic over a SHA-256 function like `receipt`. Pinned by `vectors/keyhole-v1.json` (section `release`).

use crate::domain::tag;

/// Lowercase hex (the crate has no non-test hex dependency).
fn hex_lower(b: &[u8]) -> String {
    const D: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(D[(x >> 4) as usize] as char);
        s.push(D[(x & 15) as usize] as char);
    }
    s
}

/// One shared item in a grant's scope (without any key material).
pub struct ScopeItem<'a> {
    pub item_uid: &'a [u8; 16],
    pub blob_id: &'a [u8; 32],
    pub segments: &'a [u32],
}

/// Canonical scope bytes: `{"v":1,"items":[{"item_uid":"..","blob_id":"..","segments":[0,1]}]}` with items sorted by
/// the string `item_uid_hex + blob_id_hex` and segments ascending. Matches `JSON.stringify` of the same structure.
pub fn canonical_scope(items: &[ScopeItem]) -> Vec<u8> {
    let mut rows: Vec<(String, String, Vec<u32>)> = items
        .iter()
        .map(|i| {
            let mut s = i.segments.to_vec();
            s.sort_unstable();
            (hex_lower(i.item_uid), hex_lower(i.blob_id), s)
        })
        .collect();
    rows.sort_by(|a, b| format!("{}{}", a.0, a.1).cmp(&format!("{}{}", b.0, b.1)));
    let body: Vec<String> = rows
        .iter()
        .map(|(u, b, s)| {
            let segs: Vec<String> = s.iter().map(|x| x.to_string()).collect();
            format!("{{\"item_uid\":\"{}\",\"blob_id\":\"{}\",\"segments\":[{}]}}", u, b, segs.join(","))
        })
        .collect();
    format!("{{\"v\":1,\"items\":[{}]}}", body.join(",")).into_bytes()
}

/// `scope_hash = SHA-256("keyhole/v1/scope" 0x00 || canonical_scope)`.
pub fn scope_hash<H: Fn(&[u8]) -> [u8; 32]>(h: &H, items: &[ScopeItem]) -> [u8; 32] {
    let mut m = tag("scope");
    m.extend_from_slice(&canonical_scope(items));
    h(&m)
}

/// `s2_commit = SHA-256("keyhole/v1/dealS2" 0x00 || deal_id || B2)` (spec 06 section 5).
pub fn deal_s2_commit<H: Fn(&[u8]) -> [u8; 32]>(h: &H, deal_id: &[u8; 16], b2: &[u8; 32]) -> [u8; 32] {
    let mut m = tag("dealS2");
    m.extend_from_slice(deal_id);
    m.extend_from_slice(b2);
    h(&m)
}

/// Message the release service signs to tell a buyer it holds B2 for a deal.
pub fn deal_ack_msg(deal_id: &[u8; 16], s2_commit: &[u8; 32]) -> Vec<u8> {
    let mut m = tag("deal-ack");
    m.extend_from_slice(deal_id);
    m.extend_from_slice(s2_commit);
    m
}

/// Body hash signed inside `rs_put_msg` for an authenticated call: `SHA-256("keyhole/v1/rs-auth/<purpose>" 0x00 || parts...)`.
pub fn auth_body<H: Fn(&[u8]) -> [u8; 32]>(h: &H, purpose: &str, parts: &[&[u8]]) -> [u8; 32] {
    let mut m = tag(&format!("rs-auth/{purpose}"));
    for p in parts {
        m.extend_from_slice(p);
    }
    h(&m)
}

/// The body hash an owner signs to delete a grant's material (SHA-256 of the empty string; no valid PUT body is empty).
pub fn empty_body_hash<H: Fn(&[u8]) -> [u8; 32]>(h: &H) -> [u8; 32] {
    h(&[])
}

/// Head of an empty log.
pub const LOG_GENESIS: [u8; 32] = [0u8; 32];

/// Entry bytes: the JSON array `[t,"session_id","item_uid",seg,"action"]`. Identifiers are lowercase hex or plain
/// ASCII words, so no escaping is needed (checked).
pub fn log_entry_bytes(t: u64, session_id: &str, item_uid: &str, seg: i64, action: &str) -> Vec<u8> {
    for s in [session_id, item_uid, action] {
        assert!(s.bytes().all(|b| (0x20..0x7f).contains(&b) && b != b'"' && b != b'\\'), "log fields must be plain ASCII");
    }
    format!("[{t},\"{session_id}\",\"{item_uid}\",{seg},\"{action}\"]").into_bytes()
}

/// `next = SHA-256("keyhole/v1/rs-log" 0x00 || prev || entry_bytes)`.
pub fn log_next<H: Fn(&[u8]) -> [u8; 32]>(h: &H, prev: &[u8; 32], entry: &[u8]) -> [u8; 32] {
    let mut m = tag("rs-log");
    m.extend_from_slice(prev);
    m.extend_from_slice(entry);
    h(&m)
}

/// Message the release service signs over a session's log head: tag, session id, head, entry count (u32 LE).
pub fn log_head_msg(session_id: &[u8; 16], head: &[u8; 32], count: u32) -> Vec<u8> {
    let mut m = tag("rs-log-head");
    m.extend_from_slice(session_id);
    m.extend_from_slice(head);
    m.extend_from_slice(&count.to_le_bytes());
    m
}

#[cfg(test)]
mod tests {
    use super::*;
    fn h(d: &[u8]) -> [u8; 32] {
        crate::hashing::sha256(d)
    }

    #[test]
    fn scope_is_canonical_regardless_of_order() {
        let (u1, u2) = ([1u8; 16], [2u8; 16]);
        let b = [9u8; 32];
        let a = [ScopeItem { item_uid: &u2, blob_id: &b, segments: &[3, 1] }, ScopeItem { item_uid: &u1, blob_id: &b, segments: &[0] }];
        let c = [ScopeItem { item_uid: &u1, blob_id: &b, segments: &[0] }, ScopeItem { item_uid: &u2, blob_id: &b, segments: &[1, 3] }];
        assert_eq!(scope_hash(&h, &a), scope_hash(&h, &c));
        let d = [ScopeItem { item_uid: &u1, blob_id: &b, segments: &[0] }, ScopeItem { item_uid: &u2, blob_id: &b, segments: &[1, 3, 4] }];
        assert_ne!(scope_hash(&h, &a), scope_hash(&h, &d));
    }

    #[test]
    fn canonical_scope_text() {
        let (u, b) = ([0xabu8; 16], [0xcdu8; 32]);
        let s = String::from_utf8(canonical_scope(&[ScopeItem { item_uid: &u, blob_id: &b, segments: &[2, 0] }])).unwrap();
        assert_eq!(s, format!("{{\"v\":1,\"items\":[{{\"item_uid\":\"{}\",\"blob_id\":\"{}\",\"segments\":[0,2]}}]}}", "ab".repeat(16), "cd".repeat(32)));
    }

    #[test]
    fn deal_commitment_binds_deal_and_key_half() {
        let (d1, d2, b2) = ([1u8; 16], [2u8; 16], [7u8; 32]);
        assert_ne!(deal_s2_commit(&h, &d1, &b2), deal_s2_commit(&h, &d2, &b2));
        assert_ne!(deal_s2_commit(&h, &d1, &b2), deal_s2_commit(&h, &d1, &[8u8; 32]));
    }

    #[test]
    fn auth_bodies_are_purpose_separated() {
        assert_ne!(auth_body(&h, "deal-put", &[&[1, 2]]), auth_body(&h, "deal-key", &[&[1, 2]]));
        assert_ne!(auth_body(&h, "deal-put", &[]), empty_body_hash(&h));
    }

    #[test]
    fn log_chain_detects_edits_and_reordering() {
        let e1 = log_entry_bytes(1, "aa", "", -1, "open");
        let e2 = log_entry_bytes(2, "aa", "bb", 0, "release");
        let ab = log_next(&h, &log_next(&h, &LOG_GENESIS, &e1), &e2);
        let ba = log_next(&h, &log_next(&h, &LOG_GENESIS, &e2), &e1);
        assert_ne!(ab, ba);
        let e2x = log_entry_bytes(2, "aa", "bb", 1, "release");
        assert_ne!(ab, log_next(&h, &log_next(&h, &LOG_GENESIS, &e1), &e2x));
    }

    #[test]
    #[should_panic]
    fn log_fields_with_quotes_are_refused() {
        log_entry_bytes(1, "a\"b", "", 0, "x");
    }
}
