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
    pub fn blob_registered(box_id: &str, blob_id: &str, reg_id: u64, size: u64, mode: u8) {
        keyhole("blob_registered", json!({ "box_id": box_id, "blob_id": blob_id, "reg_id": reg_id, "size": size, "mode": mode }));
    }
    pub fn blob_certified(blob_id: &str, reg_id: u64, ack_bitmap: u16) {
        keyhole("blob_certified", json!({ "blob_id": blob_id, "reg_id": reg_id, "ack_bitmap": ack_bitmap }));
    }
    pub fn blob_activated(box_id: &str, blob_id: &str) {
        keyhole("blob_activated", json!({ "box_id": box_id, "blob_id": blob_id }));
    }
    pub fn manifest_committed(box_id: &str, blob_id: &str, seq: u64) {
        keyhole("manifest_committed", json!({ "box_id": box_id, "blob_id": blob_id, "seq": seq }));
    }
    pub fn blob_extended(blob_id: &str, paid_until: u64) {
        keyhole("blob_extended", json!({ "blob_id": blob_id, "paid_until": paid_until }));
    }
    pub fn blob_retired(box_id: &str, blob_id: &str, reg_id: u64) {
        keyhole("blob_retired", json!({ "box_id": box_id, "blob_id": blob_id, "reg_id": reg_id }));
    }
    pub fn blob_erased(blob_id: &str, reg_id: u64, erase_bitmap: u16) {
        keyhole("blob_erased", json!({ "blob_id": blob_id, "reg_id": reg_id, "erase_bitmap": erase_bitmap }));
    }
    pub fn blob_abandoned(box_id: &str, blob_id: &str) {
        keyhole("blob_abandoned", json!({ "box_id": box_id, "blob_id": blob_id }));
    }
    pub fn deal_created(deal_id: &str, box_id: &str, seller: &AccountId, buyer: &AccountId, price: &str) {
        keyhole("deal_created", json!({ "deal_id": deal_id, "box_id": box_id, "seller": seller, "buyer": buyer, "price": price }));
    }
    pub fn deal_funded(deal_id: &str, waiting_until: u64) {
        keyhole("deal_funded", json!({ "deal_id": deal_id, "waiting_until": waiting_until }));
    }
    pub fn deal_cancelled(deal_id: &str, by: &AccountId) {
        keyhole("deal_cancelled", json!({ "deal_id": deal_id, "by": by }));
    }
    pub fn deal_completed(deal_id: &str, box_id: &str, new_epoch: u32) {
        keyhole("deal_completed", json!({ "deal_id": deal_id, "box_id": box_id, "epoch": new_epoch }));
    }
    pub fn payout_failed(deal_id: &str, to: &AccountId, amount: &str) {
        keyhole("payout_failed", json!({ "deal_id": deal_id, "to": to, "amount": amount }));
    }
    pub fn claimed(by: &AccountId, amount: &str) {
        keyhole("claimed", json!({ "by": by, "amount": amount }));
    }
}
