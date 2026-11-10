//! NEP-297 style event logs. No event contains plaintext, names or labels.

use near_sdk::serde_json::{json, Value};
use near_sdk::{env, AccountId};

fn log(standard: &str, version: &str, event: &str, data: Value) {
    let v = json!({ "standard": standard, "version": version, "event": event, "data": data });
    env::log_str(&format!("EVENT_JSON:{v}"));
}

fn keyhole(event: &str, data: Value) {
    log("keyhole", "1.0.0", event, data);
}

pub mod emit {
    use super::*;

    pub fn nft_mint(owner: &AccountId, token_id: &str) {
        log("nep171", "1.2.0", "nft_mint", json!([{ "owner_id": owner, "token_ids": [token_id] }]));
    }
    pub fn nft_transfer(old: &AccountId, new: &AccountId, token_id: &str) {
        log(
            "nep171",
            "1.2.0",
            "nft_transfer",
            json!([{ "old_owner_id": old, "new_owner_id": new, "token_ids": [token_id] }]),
        );
    }
    pub fn box_created(box_id: &str, kind: &str) {
        keyhole("box_created", json!({ "box_id": box_id, "kind": kind }));
    }
    pub fn box_deleted(box_id: &str) {
        keyhole("box_deleted", json!({ "box_id": box_id }));
    }
    pub fn grant_created(box_id: &str, grant_id: &str) {
        keyhole("grant_created", json!({ "box_id": box_id, "grant_id": grant_id }));
    }
    pub fn grant_revoked(box_id: &str, grant_id: &str) {
        keyhole("grant_revoked", json!({ "box_id": box_id, "grant_id": grant_id }));
    }
    pub fn grant_deleted(box_id: &str, grant_id: &str) {
        keyhole("grant_deleted", json!({ "box_id": box_id, "grant_id": grant_id }));
    }
    pub fn session_opened(box_id: &str, grant_id: &str, session_id: &str, seq: u64, head: &str, commitment: &str) {
        keyhole(
            "session_opened",
            json!({ "box_id": box_id, "grant_id": grant_id, "session_id": session_id, "seq": seq, "head": head, "commitment": commitment }),
        );
    }
    pub fn session_closed(box_id: &str, session_id: &str, seq: u64, head: &str, commitment: &str) {
        keyhole(
            "session_closed",
            json!({ "box_id": box_id, "session_id": session_id, "seq": seq, "head": head, "commitment": commitment }),
        );
    }
}
