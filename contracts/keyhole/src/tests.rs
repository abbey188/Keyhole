//! Unit tests for the contract core (invariants C2 to C5, C9; see spec 10 section 3).

use super::*;
use keyhole_proto::{hashing::sha256, msgs, receipt, sig};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::testing_env;

pub(crate) const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
pub(crate) const T0: u64 = 1_700_000_000_000;
pub(crate) const HOUR: u64 = 3_600_000;
pub(crate) const CONTRACT: &str = "keyhole.testnet";

pub(crate) fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}
pub(crate) fn set(pred: &str, deposit: u128, now_ms: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acct(CONTRACT))
        .predecessor_account_id(acct(pred))
        .signer_account_id(acct(pred))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(now_ms * 1_000_000)
        .build());
}
pub(crate) fn hex16(n: u8) -> String {
    hex::encode([n; 16])
}
pub(crate) fn hex32(n: u8) -> String {
    hex::encode([n; 32])
}
pub(crate) const RS_SEED: [u8; 32] = [7u8; 32];
pub(crate) fn cfg() -> ConfigArgs {
    ConfigArgs {
        chain_id: "testnet".into(),
        node_keys: vec![hex::encode(sig::public_key(&[1u8; 32]))],
        threshold: 1,
        rs_keys: vec![hex::encode(sig::public_key(&RS_SEED))],
        allowed_tokens: vec![],
        min_grant_ms: 60_000,
        max_lease_ms: 300_000,
        min_wait_ms: 20_000,
        max_wait_ms: 30 * 24 * HOUR,
        grace_ms: 7 * 24 * HOUR,
        reg_window_ms: HOUR,
        retention_ms: 7 * 24 * HOUR,
        withdraw_delay_ms: 60_000,
        per_session_stake: near_sdk::json_types::U128(NEAR / 500),
        rate_yocto_per_mib_day: near_sdk::json_types::U128(1_000_000_000_000_000_000),
        max_blob_bytes: 256 * 1024 * 1024,
        node_accounts: vec![acct("node1.testnet")],
    }
}
pub(crate) fn new_contract() -> Keyhole {
    set("deployer.testnet", 0, T0);
    Keyhole::new(cfg())
}
pub(crate) fn with_box() -> Keyhole {
    let mut c = new_contract();
    set("alice.testnet", NEAR / 10, T0);
    c.create_box(hex16(1), Kind::Handover, vec![1, 2, 3].into(), 3 * HOUR);
    c
}
pub(crate) const REQ_SEED: [u8; 32] = [5u8; 32];
pub(crate) fn bearer() -> RequesterArg {
    RequesterArg::Bearer(hex::encode(sig::public_key(&REQ_SEED)))
}
pub(crate) fn grant_args(gid: u8, bid: u8, requester: RequesterArg, from: u64, to: u64, max_sessions: u16) -> GrantArgs {
    GrantArgs {
        grant_id: hex16(gid),
        box_id: hex16(bid),
        requester,
        mode: Mode::View,
        not_before_ms: from,
        not_after_ms: to,
        max_sessions,
        scope_hash: hex32(0xaa),
        policy_hash: hex32(0xbb),
    }
}
pub(crate) fn with_grant() -> Keyhole {
    let mut c = with_box();
    set("alice.testnet", NEAR / 10, T0);
    c.create_grant(grant_args(1, 1, bearer(), T0, T0 + 2 * HOUR, 3));
    c
}
pub(crate) fn open_at(c: &mut Keyhole, gid: u8, sid: u8, seed: &[u8; 32], now: u64, ts: u64) -> bool {
    set("relayer.testnet", 0, now);
    let spk = [9u8; 32];
    let msg = msgs::open_msg("testnet", CONTRACT, &[gid; 16], &[sid; 16], &spk, ts);
    let s = hex::encode(sig::sign(seed, &msg));
    c.open_session(hex16(gid), hex16(sid), hex::encode(spk), ts, Some(s))
}
pub(crate) fn events(name: &str) -> Vec<near_sdk::serde_json::Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .filter_map(|j| near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(j).ok())
        .filter(|v| v["event"] == name)
        .collect()
}

pub(crate) fn deal_stub(seller: &str, buyer: &str) -> DealRec {
    DealRec {
        box_id: [1u8; 16],
        seller: acct(seller),
        buyer: acct(buyer),
        price: 0,
        state: DealState::Ready,
        created_at: T0,
        offer_expires_at: T0 + HOUR,
        waiting_ms: 20_000,
        waiting_until: None,
        manifest_blob: [0u8; 32],
        manifest_seq: 1,
        bmk_commit: [0u8; 32],
        envelope_blob: [0u8; 32],
        s2_commit: [0u8; 32],
        funded: 0,
        ended_at: None,
        deposit: 0,
    }
}

// ------------------------------------------------------------------ init

#[test]
fn init_stores_config() {
    let c = new_contract();
    let v = c.get_config();
    assert_eq!(v.chain_id, "testnet");
    assert_eq!(v.threshold, 1);
    assert_eq!(v.node_keys.len(), 1);
}

#[test]
#[should_panic(expected = "threshold must be between")]
fn init_rejects_threshold_above_node_count() {
    set("deployer.testnet", 0, T0);
    let mut c = cfg();
    c.threshold = 2;
    let _ = Keyhole::new(c);
}

#[test]
#[should_panic(expected = "bad hex")]
fn init_rejects_bad_keys() {
    set("deployer.testnet", 0, T0);
    let mut c = cfg();
    c.node_keys = vec!["zz".into()];
    let _ = Keyhole::new(c);
}

// ------------------------------------------------------------------ boxes

#[test]
fn create_box_and_views() {
    let c = with_box();
    let b = c.get_box(hex16(1)).unwrap();
    assert_eq!(b.owner, acct("alice.testnet"));
    assert_eq!(b.key_epoch, 0);
    assert_eq!(b.receipts_seq, 0);
    assert_eq!(b.receipts_head, hex::encode([0u8; 32]));
    assert_eq!(c.boxes_of(acct("alice.testnet"), None, None).len(), 1);
    assert_eq!(c.boxes_of(acct("bob.testnet"), None, None).len(), 0);
    assert_eq!(c.nft_token(hex16(1)).unwrap().owner_id, acct("alice.testnet"));
    assert_eq!(c.nft_total_supply().0, 1);
    assert_eq!(c.nft_tokens_for_owner(acct("alice.testnet"), None, None).len(), 1);
    assert!(c.nft_token(hex16(2)).is_none());
    assert_eq!(c.nft_metadata().symbol, "KEYHOLE");
}

#[test]
fn create_box_emits_mint_event() {
    let _c = with_box();
    let mint = get_logs().iter().any(|l| l.contains("\"nep171\"") && l.contains("nft_mint"));
    assert!(mint);
}

#[test]
#[should_panic(expected = "Box id already used")]
fn box_id_cannot_be_reused() {
    let mut c = with_box();
    set("bob.testnet", NEAR / 10, T0);
    c.create_box(hex16(1), Kind::Bound, vec![].into(), HOUR);
}

#[test]
#[should_panic(expected = "wrapped_bmk too large")]
fn oversized_wrapped_key_rejected() {
    let mut c = new_contract();
    set("alice.testnet", NEAR / 10, T0);
    c.create_box(hex16(1), Kind::Bound, vec![0u8; 129].into(), HOUR);
}

#[test]
#[should_panic(expected = "max_grant_ms below the minimum")]
fn ceiling_below_minimum_rejected() {
    let mut c = new_contract();
    set("alice.testnet", NEAR / 10, T0);
    c.create_box(hex16(1), Kind::Bound, vec![].into(), 1_000);
}

#[test]
#[should_panic(expected = "Attach at least")]
fn create_box_needs_storage_deposit() {
    let mut c = new_contract();
    set("alice.testnet", 1, T0);
    c.create_box(hex16(1), Kind::Bound, vec![].into(), HOUR);
}

#[test]
fn excess_deposit_is_refunded() {
    let mut c = new_contract();
    set("alice.testnet", 5 * NEAR, T0);
    c.create_box(hex16(1), Kind::Bound, vec![].into(), HOUR);
    // A refund transfer back to the caller was scheduled.
    assert!(!get_created_receipts().is_empty());
}

// C5: boxes never move except through a deal.
#[test]
#[should_panic(expected = "only through a deal")]
fn nft_transfer_always_panics() {
    let mut c = with_box();
    set("alice.testnet", 1, T0);
    c.nft_transfer(acct("bob.testnet"), hex16(1), None, None);
}

#[test]
#[should_panic(expected = "only through a deal")]
fn nft_transfer_call_always_panics() {
    let mut c = with_box();
    set("alice.testnet", 1, T0);
    c.nft_transfer_call(acct("bob.testnet"), hex16(1), None, None, "".into());
}

// C9: owner-only.
#[test]
#[should_panic(expected = "Only the box owner")]
fn only_owner_sets_wrapped_key() {
    let mut c = with_box();
    set("mallory.testnet", 0, T0);
    c.set_wrapped_bmk(hex16(1), vec![9].into());
}

#[test]
fn owner_updates_wrapped_key() {
    let mut c = with_box();
    set("alice.testnet", 0, T0);
    c.set_wrapped_bmk(hex16(1), vec![9, 9].into());
    assert_eq!(c.get_box(hex16(1)).unwrap().wrapped_bmk.0, vec![9, 9]);
}

#[test]
fn delete_empty_box_refunds_and_updates_index() {
    let mut c = with_box();
    set("alice.testnet", 0, T0);
    let _ = c.delete_box(hex16(1));
    assert!(c.get_box(hex16(1)).is_none());
    assert_eq!(c.boxes_of(acct("alice.testnet"), None, None).len(), 0);
    assert_eq!(c.nft_total_supply().0, 0);
}

#[test]
#[should_panic(expected = "still has grants")]
fn cannot_delete_box_with_grants() {
    let mut c = with_grant();
    set("alice.testnet", 0, T0);
    let _ = c.delete_box(hex16(1));
}

// ----------------------------------------------------------------- grants

#[test]
fn create_grant_and_views() {
    let c = with_grant();
    let g = c.get_grant(hex16(1)).unwrap();
    assert_eq!(g.sessions_used, 0);
    assert_eq!(g.epoch, 0);
    assert!(g.requester.starts_with("bearer:"));
    assert_eq!(c.get_box(hex16(1)).unwrap().live_grants, 1);
    let v = c.grant_valid(hex16(1));
    assert!(v.valid, "{}", v.reason);
}

// C3: the per-box ceiling.
#[test]
fn ceiling_boundary_accepted_and_over_rejected() {
    let mut c = with_box(); // ceiling 3h
    set("alice.testnet", NEAR / 10, T0);
    c.create_grant(grant_args(1, 1, bearer(), T0, T0 + 3 * HOUR, 1)); // exactly the ceiling
    assert!(c.get_grant(hex16(1)).is_some());
}

#[test]
#[should_panic(expected = "longer than the box ceiling")]
fn grant_over_ceiling_rejected() {
    let mut c = with_box();
    set("alice.testnet", NEAR / 10, T0);
    c.create_grant(grant_args(1, 1, bearer(), T0, T0 + 3 * HOUR + 1, 1));
}

#[test]
#[should_panic(expected = "shorter than the minimum")]
fn grant_under_minimum_rejected() {
    let mut c = with_box();
    set("alice.testnet", NEAR / 10, T0);
    c.create_grant(grant_args(1, 1, bearer(), T0, T0 + 30_000, 1));
}

#[test]
#[should_panic(expected = "not_after must be in the future")]
fn grant_in_the_past_rejected() {
    let mut c = with_box();
    set("alice.testnet", NEAR / 10, T0);
    c.create_grant(grant_args(1, 1, bearer(), T0 - 2 * HOUR, T0 - HOUR, 1));
}

#[test]
#[should_panic(expected = "Only the box owner")]
fn only_owner_creates_grants() {
    let mut c = with_box();
    set("mallory.testnet", NEAR / 10, T0);
    c.create_grant(grant_args(1, 1, bearer(), T0, T0 + HOUR, 1));
}

#[test]
#[should_panic(expected = "Grant id already used")]
fn grant_id_unique() {
    let mut c = with_grant();
    set("alice.testnet", NEAR / 10, T0);
    c.create_grant(grant_args(1, 1, bearer(), T0, T0 + HOUR, 1));
}

#[test]
#[should_panic(expected = "Attach at least")]
fn grant_must_prepay_session_stake() {
    let mut c = with_box();
    set("alice.testnet", NEAR / 100, T0); // far below 1000 sessions x stake
    c.create_grant(grant_args(1, 1, bearer(), T0, T0 + HOUR, 1000));
}

#[test]
fn revoke_ends_the_grant() {
    let mut c = with_grant();
    set("alice.testnet", 0, T0 + 1000);
    c.revoke_grant(hex16(1));
    let v = c.grant_valid(hex16(1));
    assert!(!v.valid);
    assert_eq!(v.reason, "revoked");
    assert_eq!(c.get_grant(hex16(1)).unwrap().revoked_at, Some(T0 + 1000));
}

#[test]
#[should_panic(expected = "Only the box owner")]
fn only_owner_revokes() {
    let mut c = with_grant();
    set("mallory.testnet", 0, T0);
    c.revoke_grant(hex16(1));
}

#[test]
#[should_panic(expected = "already revoked")]
fn double_revoke_rejected() {
    let mut c = with_grant();
    set("alice.testnet", 0, T0);
    c.revoke_grant(hex16(1));
    c.revoke_grant(hex16(1));
}

#[test]
fn grant_valid_reasons() {
    let mut c = with_box();
    set("alice.testnet", NEAR / 10, T0);
    c.create_grant(grant_args(1, 1, bearer(), T0 + HOUR, T0 + 2 * HOUR, 1));
    assert_eq!(c.grant_valid(hex16(1)).reason, "not_yet");
    set("x.testnet", 0, T0 + 3 * HOUR);
    assert_eq!(c.grant_valid(hex16(1)).reason, "expired");
    assert_eq!(c.grant_valid(hex16(9)).reason, "unknown");
}

#[test]
fn delete_grant_after_retention() {
    let mut c = with_grant();
    set("anyone.testnet", 0, T0 + 2 * HOUR + 7 * 24 * HOUR + 1);
    let _ = c.delete_grant(hex16(1));
    assert!(c.get_grant(hex16(1)).is_none());
    assert_eq!(c.get_box(hex16(1)).unwrap().live_grants, 0);
}

#[test]
#[should_panic(expected = "retention period has not passed")]
fn delete_grant_before_retention_rejected() {
    let mut c = with_grant();
    set("anyone.testnet", 0, T0 + 2 * HOUR + 1);
    let _ = c.delete_grant(hex16(1));
}

// Rule R3: during a deal only grants to the buyer are allowed.
#[test]
fn deal_rule_allows_only_buyer_grants() {
    let mut c = with_box();
    let deal = [0xd1u8; 16];
    c.deals.insert(deal, deal_stub("alice.testnet", "bob.testnet"));
    c.boxes.get_mut(&[1u8; 16]).unwrap().state = BoxState::InDeal(deal);
    set("alice.testnet", NEAR / 10, T0);
    c.create_grant(grant_args(1, 1, RequesterArg::Account(acct("bob.testnet")), T0, T0 + HOUR, 1));
    assert!(c.get_grant(hex16(1)).is_some());
}

#[test]
#[should_panic(expected = "Box is in a deal")]
fn deal_rule_rejects_other_accounts() {
    let mut c = with_box();
    let deal = [0xd1u8; 16];
    c.deals.insert(deal, deal_stub("alice.testnet", "bob.testnet"));
    c.boxes.get_mut(&[1u8; 16]).unwrap().state = BoxState::InDeal(deal);
    set("alice.testnet", NEAR / 10, T0);
    c.create_grant(grant_args(1, 1, RequesterArg::Account(acct("carol.testnet")), T0, T0 + HOUR, 1));
}

#[test]
#[should_panic(expected = "Box is in a deal")]
fn deal_rule_rejects_bearer_links() {
    let mut c = with_box();
    let deal = [0xd1u8; 16];
    c.deals.insert(deal, deal_stub("alice.testnet", "bob.testnet"));
    c.boxes.get_mut(&[1u8; 16]).unwrap().state = BoxState::InDeal(deal);
    set("alice.testnet", NEAR / 10, T0);
    c.create_grant(grant_args(1, 1, bearer(), T0, T0 + HOUR, 1));
}

// --------------------------------------------------------------- sessions

#[test]
fn open_session_extends_receipt_chain() {
    let mut c = with_grant();
    assert!(open_at(&mut c, 1, 1, &REQ_SEED, T0 + 1000, T0 + 1000));
    let b = c.get_box(hex16(1)).unwrap();
    assert_eq!(b.receipts_seq, 1);
    assert_ne!(b.receipts_head, hex::encode([0u8; 32]));
    assert_eq!(c.get_grant(hex16(1)).unwrap().sessions_used, 1);
    let s = c.get_session(hex16(1)).unwrap();
    assert_eq!(s.opened_at, T0 + 1000);
    assert_eq!(events("session_opened").len(), 1);
}

// C2: the head changes only through opens and closes, and can be recomputed from events.
#[test]
fn receipt_chain_recomputes_from_events() {
    let mut c = with_grant();
    let mut commitments = Vec::new();
    for i in 1u8..=3 {
        open_at(&mut c, 1, i, &REQ_SEED, T0 + 1000 * i as u64, T0 + 1000 * i as u64);
        let ev = events("session_opened");
        let last = ev.last().unwrap();
        let cm: [u8; 32] = hex::decode(last["data"]["commitment"].as_str().unwrap()).unwrap().try_into().unwrap();
        commitments.push(cm);
    }
    let h = |d: &[u8]| sha256(d);
    let b = c.get_box(hex16(1)).unwrap();
    assert_eq!(hex::encode(receipt::recompute_chain(&h, &commitments)), b.receipts_head);
    // Any omission or edit breaks the match.
    let mut missing = commitments.clone();
    missing.remove(1);
    assert_ne!(hex::encode(receipt::recompute_chain(&h, &missing)), b.receipts_head);
    let mut edited = commitments.clone();
    edited[0][0] ^= 1;
    assert_ne!(hex::encode(receipt::recompute_chain(&h, &edited)), b.receipts_head);
}

#[test]
#[should_panic(expected = "Grant revoked")]
fn open_after_revoke_fails() {
    let mut c = with_grant();
    set("alice.testnet", 0, T0 + 500);
    c.revoke_grant(hex16(1));
    open_at(&mut c, 1, 1, &REQ_SEED, T0 + 1000, T0 + 1000);
}

#[test]
#[should_panic(expected = "Grant expired")]
fn open_after_expiry_fails() {
    let mut c = with_grant();
    open_at(&mut c, 1, 1, &REQ_SEED, T0 + 2 * HOUR + 1, T0 + 2 * HOUR + 1);
}

#[test]
#[should_panic(expected = "not yet valid")]
fn open_before_start_fails() {
    let mut c = with_box();
    set("alice.testnet", NEAR / 10, T0);
    c.create_grant(grant_args(1, 1, bearer(), T0 + HOUR, T0 + 2 * HOUR, 1));
    open_at(&mut c, 1, 1, &REQ_SEED, T0 + 10, T0 + 10);
}

#[test]
#[should_panic(expected = "earlier epoch")]
fn open_after_epoch_bump_fails() {
    let mut c = with_grant();
    c.boxes.get_mut(&[1u8; 16]).unwrap().key_epoch += 1; // what a completed deal does
    open_at(&mut c, 1, 1, &REQ_SEED, T0 + 1000, T0 + 1000);
}

#[test]
#[should_panic(expected = "budget exhausted")]
fn session_budget_enforced() {
    let mut c = with_box();
    set("alice.testnet", NEAR / 10, T0);
    c.create_grant(grant_args(1, 1, bearer(), T0, T0 + HOUR, 1));
    open_at(&mut c, 1, 1, &REQ_SEED, T0 + 1000, T0 + 1000);
    open_at(&mut c, 1, 2, &REQ_SEED, T0 + 2000, T0 + 2000);
}

#[test]
#[should_panic(expected = "Session id already used")]
fn duplicate_session_id_rejected() {
    let mut c = with_grant();
    open_at(&mut c, 1, 1, &REQ_SEED, T0 + 1000, T0 + 1000);
    open_at(&mut c, 1, 1, &REQ_SEED, T0 + 2000, T0 + 2000);
}

#[test]
#[should_panic(expected = "Bad signature")]
fn wrong_signer_rejected() {
    let mut c = with_grant();
    open_at(&mut c, 1, 1, &[6u8; 32], T0 + 1000, T0 + 1000);
}

#[test]
#[should_panic(expected = "Bad signature")]
fn tampered_message_rejected() {
    let mut c = with_grant();
    set("relayer.testnet", 0, T0 + 1000);
    let spk = [9u8; 32];
    // Signed for session 1, submitted for session 2.
    let msg = msgs::open_msg("testnet", CONTRACT, &[1u8; 16], &[1u8; 16], &spk, T0 + 1000);
    let s = hex::encode(sig::sign(&REQ_SEED, &msg));
    c.open_session(hex16(1), hex16(2), hex::encode(spk), T0 + 1000, Some(s));
}

#[test]
#[should_panic(expected = "Bad signature")]
fn signature_for_other_contract_rejected() {
    let mut c = with_grant();
    set("relayer.testnet", 0, T0 + 1000);
    let spk = [9u8; 32];
    let msg = msgs::open_msg("testnet", "other.testnet", &[1u8; 16], &[1u8; 16], &spk, T0 + 1000);
    let s = hex::encode(sig::sign(&REQ_SEED, &msg));
    c.open_session(hex16(1), hex16(1), hex::encode(spk), T0 + 1000, Some(s));
}

#[test]
#[should_panic(expected = "not fresh")]
fn stale_timestamp_rejected() {
    let mut c = with_grant();
    open_at(&mut c, 1, 1, &REQ_SEED, T0 + 1000, T0 + 1000 - 120_000);
}

#[test]
#[should_panic(expected = "Signature required")]
fn missing_signature_rejected() {
    let mut c = with_grant();
    set("relayer.testnet", 0, T0 + 1000);
    c.open_session(hex16(1), hex16(1), hex32(9), T0 + 1000, None);
}

#[test]
fn named_requester_must_be_the_caller() {
    let mut c = with_box();
    set("alice.testnet", NEAR / 10, T0);
    c.create_grant(grant_args(1, 1, RequesterArg::Account(acct("landlord.testnet")), T0, T0 + HOUR, 2));
    set("landlord.testnet", 0, T0 + 1000);
    assert!(c.open_session(hex16(1), hex16(1), hex32(9), T0 + 1000, None));
    assert_eq!(c.get_box(hex16(1)).unwrap().receipts_seq, 1);
}

#[test]
#[should_panic(expected = "Wrong requester account")]
fn other_account_cannot_use_named_grant() {
    let mut c = with_box();
    set("alice.testnet", NEAR / 10, T0);
    c.create_grant(grant_args(1, 1, RequesterArg::Account(acct("landlord.testnet")), T0, T0 + HOUR, 2));
    set("mallory.testnet", 0, T0 + 1000);
    c.open_session(hex16(1), hex16(1), hex32(9), T0 + 1000, None);
}

// ------------------------------------------------------------------ close

fn close_args(sid: u8, root: u8, at: u64, seed: &[u8; 32]) -> (String, String, u64, u8, String) {
    let msg = msgs::close_msg("testnet", CONTRACT, &[sid; 16], &[root; 32], at);
    (hex16(sid), hex32(root), at, 0, hex::encode(sig::sign(seed, &msg)))
}

#[test]
fn close_session_extends_chain() {
    let mut c = with_grant();
    open_at(&mut c, 1, 1, &REQ_SEED, T0 + 1000, T0 + 1000);
    let seq_before = c.get_box(hex16(1)).unwrap().receipts_seq;
    let (s, r, at, idx, sg) = close_args(1, 0x33, T0 + 5000, &RS_SEED);
    set("relayer.testnet", 0, T0 + 5000);
    c.close_session(s, r, at, idx, sg);
    let b = c.get_box(hex16(1)).unwrap();
    assert_eq!(b.receipts_seq, seq_before + 1);
    assert_eq!(c.get_session(hex16(1)).unwrap().closed_at, Some(T0 + 5000));
}

#[test]
#[should_panic(expected = "Session already closed")]
fn double_close_rejected() {
    let mut c = with_grant();
    open_at(&mut c, 1, 1, &REQ_SEED, T0 + 1000, T0 + 1000);
    let (s, r, at, idx, sg) = close_args(1, 0x33, T0 + 5000, &RS_SEED);
    set("relayer.testnet", 0, T0 + 5000);
    c.close_session(s.clone(), r.clone(), at, idx, sg.clone());
    c.close_session(s, r, at, idx, sg);
}

#[test]
#[should_panic(expected = "Bad signature")]
fn close_with_wrong_key_rejected() {
    let mut c = with_grant();
    open_at(&mut c, 1, 1, &REQ_SEED, T0 + 1000, T0 + 1000);
    let (s, r, at, idx, sg) = close_args(1, 0x33, T0 + 5000, &[8u8; 32]);
    set("relayer.testnet", 0, T0 + 5000);
    c.close_session(s, r, at, idx, sg);
}

#[test]
#[should_panic(expected = "Unknown release service key")]
fn close_with_unknown_key_index_rejected() {
    let mut c = with_grant();
    open_at(&mut c, 1, 1, &REQ_SEED, T0 + 1000, T0 + 1000);
    let (s, r, at, _idx, sg) = close_args(1, 0x33, T0 + 5000, &RS_SEED);
    set("relayer.testnet", 0, T0 + 5000);
    c.close_session(s, r, at, 3, sg);
}

#[test]
#[should_panic(expected = "Unknown session")]
fn close_unknown_session_rejected() {
    let mut c = with_grant();
    let (s, r, at, idx, sg) = close_args(1, 0x33, T0 + 5000, &RS_SEED);
    set("relayer.testnet", 0, T0 + 5000);
    c.close_session(s, r, at, idx, sg);
}

// ---------------------------------------------------------------- storage paid by its user (review S1, S4)

fn transfers() -> Vec<u128> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| r.actions.into_iter())
        .filter_map(|a| match a {
            near_sdk::mock::MockAction::Transfer { deposit, .. } => Some(deposit.as_yoctonear()),
            _ => None,
        })
        .collect()
}

#[test]
fn deleting_a_grant_keeps_the_stake_of_every_opened_session() {
    let mut c = with_grant(); // 3 sessions prepaid
    let stake = NEAR / 500;
    let deposit = c.grants.get(&[1u8; 16]).unwrap().deposit;
    assert!(open_at(&mut c, 1, 0x51, &REQ_SEED, T0 + 1000, T0 + 1000));
    assert!(open_at(&mut c, 1, 0x52, &REQ_SEED, T0 + 2000, T0 + 2000));
    set("anyone.testnet", 0, T0 + 2 * HOUR + 7 * 24 * HOUR + 1);
    let _ = c.delete_grant(hex16(1));
    // two sessions were opened: their stakes stay; the unused one and the record's storage come back
    assert_eq!(transfers(), vec![deposit - 2 * stake]);
    // the session records are still there (they are the receipts)
    assert!(c.get_session(hex16(0x51)).is_some());
}

#[test]
fn an_unused_grant_is_refunded_in_full() {
    let mut c = with_grant();
    let deposit = c.grants.get(&[1u8; 16]).unwrap().deposit;
    set("anyone.testnet", 0, T0 + 2 * HOUR + 7 * 24 * HOUR + 1);
    let _ = c.delete_grant(hex16(1));
    assert_eq!(transfers(), vec![deposit]);
}

#[test]
fn the_session_stake_covers_the_bytes_a_session_and_its_close_use() {
    let mut c = with_grant();
    c.grants.flush();
    c.boxes.flush();
    set("relayer.testnet", 0, T0 + 1000);
    let before = env::storage_usage();
    assert!(open_at(&mut c, 1, 0x51, &REQ_SEED, T0 + 1000, T0 + 1000));
    c.sessions.flush();
    c.grants.flush();
    c.boxes.flush();
    let used = (env::storage_usage() - before) as u128;
    // a close adds an Option payload of 8 + 32 bytes
    assert!(used + 41 <= SESSION_STORAGE_BYTES, "session uses {used} bytes");
    assert!(c.config.per_session_stake >= env::storage_byte_cost().as_yoctonear() * SESSION_STORAGE_BYTES);
}

#[test]
#[should_panic(expected = "per_session_stake does not cover")]
fn a_stake_too_small_for_a_session_record_is_refused_at_init() {
    set("deployer.testnet", 0, T0);
    let mut cfg = cfg();
    cfg.per_session_stake = near_sdk::json_types::U128(NEAR / 1000);
    Keyhole::new(cfg);
}

#[test]
#[should_panic(expected = "Attach at least")]
fn growing_the_wrapped_key_needs_a_deposit() {
    let mut c = with_box(); // 3 bytes
    set("alice.testnet", 0, T0 + 1);
    c.set_wrapped_bmk(hex16(1), vec![7u8; 100].into());
}

#[test]
fn growing_the_wrapped_key_with_a_deposit_adds_to_the_box_deposit() {
    let mut c = with_box();
    let d0 = c.boxes.get(&[1u8; 16]).unwrap().deposit;
    set("alice.testnet", NEAR / 100, T0 + 1);
    c.set_wrapped_bmk(hex16(1), vec![7u8; 100].into());
    let d1 = c.boxes.get(&[1u8; 16]).unwrap().deposit;
    assert_eq!(d1 - d0, 97 * env::storage_byte_cost().as_yoctonear());
}
