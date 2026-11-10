//! Blob lifecycle tests (spec 03 invariants SI1 to SI9, spec 10 section 4).

use crate::blobs::{accrued, muldiv};
use crate::tests::*;
use super::*;
use keyhole_proto::{msgs, sig};
use near_sdk::test_utils::get_created_receipts;

const NODE_SEED: [u8; 32] = [1u8; 32];
const MIB: u64 = 1024 * 1024;

pub(crate) fn register(c: &mut Keyhole, blob: u8, size: u64, days: u32, now: u64) {
    set("alice.testnet", NEAR, now);
    c.register_blob(hex32(blob), hex16(1), size, 0, days);
}

pub(crate) fn ack_with(c: &Keyhole, blob: u8, seed: &[u8; 32], idx: u8) -> AckArg {
    let rec = c.blobs.get(&[blob; 32]).unwrap();
    let m = msgs::ack_msg("testnet", CONTRACT, rec.reg_id, &[blob; 32], rec.mode, rec.paid_until);
    AckArg { idx, sig: hex::encode(sig::sign(seed, &m)) }
}

pub(crate) fn certify(c: &mut Keyhole, blob: u8, now: u64) {
    let a = ack_with(c, blob, &NODE_SEED, 0);
    set("anyone.testnet", 0, now);
    c.certify_blob(hex32(blob), vec![a]);
}

pub(crate) fn activate(c: &mut Keyhole, blob: u8, now: u64) {
    set("alice.testnet", 0, now);
    c.activate_blob(hex32(blob));
}

/// A box owned by alice with one active blob (id byte 7).
pub(crate) fn box_with_active_blob() -> Keyhole {
    let mut c = with_box();
    register(&mut c, 7, 64 * 1024, 30, T0);
    certify(&mut c, 7, T0 + 1000);
    activate(&mut c, 7, T0 + 2000);
    c
}

fn erase_sig(c: &Keyhole, blob: u8, seed: &[u8; 32]) -> String {
    let rec = c.blobs.get(&[blob; 32]).unwrap();
    hex::encode(sig::sign(seed, &msgs::erase_msg("testnet", CONTRACT, rec.reg_id, &[blob; 32])))
}

// -------------------------------------------------------------- register

#[test]
fn register_creates_a_registered_blob() {
    let mut c = with_box();
    register(&mut c, 7, 3 * MIB, 10, T0);
    let b = c.get_blob(hex32(7)).unwrap();
    assert_eq!(b.state, BlobState::Registered);
    assert_eq!(b.size, 3 * MIB);
    assert_eq!(b.leaves, 48);
    assert_eq!(b.paid_until, T0 + 10 * 86_400_000);
    assert_eq!(c.get_box(hex16(1)).unwrap().live_blobs, 1);
    assert_eq!(c.next_reg_id, 2);
}

#[test]
#[should_panic(expected = "Only Erasable mode")]
fn only_erasable_mode_in_this_deployment() {
    let mut c = with_box();
    set("alice.testnet", NEAR, T0);
    c.register_blob(hex32(7), hex16(1), 1000, 1, 1);
}

#[test]
#[should_panic(expected = "Blob size out of range")]
fn zero_size_rejected() {
    let mut c = with_box();
    set("alice.testnet", NEAR, T0);
    c.register_blob(hex32(7), hex16(1), 0, 0, 1);
}

#[test]
#[should_panic(expected = "Blob size out of range")]
fn oversize_rejected() {
    let mut c = with_box();
    set("alice.testnet", NEAR, T0);
    c.register_blob(hex32(7), hex16(1), 256 * 1024 * 1024 + 1, 0, 1);
}

#[test]
#[should_panic(expected = "days must be")]
fn zero_days_rejected() {
    let mut c = with_box();
    set("alice.testnet", NEAR, T0);
    c.register_blob(hex32(7), hex16(1), 1000, 0, 0);
}

#[test]
#[should_panic(expected = "Blob id already registered")]
fn duplicate_blob_id_rejected() {
    let mut c = with_box();
    register(&mut c, 7, 1000, 1, T0);
    register(&mut c, 7, 1000, 1, T0);
}

// SI3: owner only.
#[test]
#[should_panic(expected = "Only the box owner")]
fn only_owner_registers() {
    let mut c = with_box();
    set("mallory.testnet", NEAR, T0);
    c.register_blob(hex32(7), hex16(1), 1000, 0, 1);
}

#[test]
#[should_panic(expected = "Attach at least")]
fn register_needs_deposit() {
    let mut c = with_box();
    set("alice.testnet", 1, T0);
    c.register_blob(hex32(7), hex16(1), 1000, 0, 1);
}

// ------------------------------------------------------------- certify

#[test]
fn certify_moves_to_complete() {
    let mut c = with_box();
    register(&mut c, 7, 1000, 1, T0);
    certify(&mut c, 7, T0 + 1000);
    let b = c.get_blob(hex32(7)).unwrap();
    assert_eq!(b.state, BlobState::Complete);
    assert_eq!(b.ack_bitmap, 1);
    assert_eq!(b.certified_at, Some(T0 + 1000));
}

// SI1: no certificate, no certification.
#[test]
#[should_panic(expected = "Not enough acknowledgements")]
fn certify_without_acks_fails() {
    let mut c = with_box();
    register(&mut c, 7, 1000, 1, T0);
    set("anyone.testnet", 0, T0 + 1000);
    c.certify_blob(hex32(7), vec![]);
}

#[test]
#[should_panic(expected = "Bad node signature")]
fn certify_with_wrong_node_key_fails() {
    let mut c = with_box();
    register(&mut c, 7, 1000, 1, T0);
    let a = ack_with(&c, 7, &[9u8; 32], 0);
    set("anyone.testnet", 0, T0 + 1000);
    c.certify_blob(hex32(7), vec![a]);
}

#[test]
#[should_panic(expected = "Unknown node")]
fn certify_with_unknown_node_index_fails() {
    let mut c = with_box();
    register(&mut c, 7, 1000, 1, T0);
    let a = ack_with(&c, 7, &NODE_SEED, 3);
    set("anyone.testnet", 0, T0 + 1000);
    c.certify_blob(hex32(7), vec![a]);
}

#[test]
#[should_panic(expected = "Duplicate node acknowledgement")]
fn certify_rejects_duplicate_node() {
    let mut c = with_box();
    register(&mut c, 7, 1000, 1, T0);
    let a = ack_with(&c, 7, &NODE_SEED, 0);
    let b = ack_with(&c, 7, &NODE_SEED, 0);
    set("anyone.testnet", 0, T0 + 1000);
    c.certify_blob(hex32(7), vec![a, b]);
}

#[test]
#[should_panic(expected = "Registration window has passed")]
fn certify_after_window_fails() {
    let mut c = with_box();
    register(&mut c, 7, 1000, 1, T0);
    certify(&mut c, 7, T0 + 2 * HOUR);
}

// SI5: acknowledgements bind to one registration.
#[test]
#[should_panic(expected = "Bad node signature")]
fn old_acknowledgement_cannot_certify_a_reregistration() {
    let mut c = with_box();
    register(&mut c, 7, 1000, 1, T0);
    let stale = ack_with(&c, 7, &NODE_SEED, 0); // reg_id 1
    set("anyone.testnet", 0, T0 + 2 * HOUR);
    c.abandon_blob(hex32(7));
    register(&mut c, 7, 1000, 1, T0 + 3 * HOUR); // reg_id 2, different paid_until too
    set("anyone.testnet", 0, T0 + 3 * HOUR + 1000);
    c.certify_blob(hex32(7), vec![stale]);
}

#[test]
#[should_panic(expected = "not awaiting certification")]
fn cannot_certify_twice() {
    let mut c = with_box();
    register(&mut c, 7, 1000, 1, T0);
    certify(&mut c, 7, T0 + 1000);
    let a = ack_with(&c, 7, &NODE_SEED, 0);
    set("anyone.testnet", 0, T0 + 1500);
    c.certify_blob(hex32(7), vec![a]);
}

// ------------------------------------------------------------ activate

#[test]
fn activate_after_certify() {
    let c = box_with_active_blob();
    assert_eq!(c.get_blob(hex32(7)).unwrap().state, BlobState::Active);
}

#[test]
#[should_panic(expected = "certified first")]
fn cannot_activate_uncertified_blob() {
    let mut c = with_box();
    register(&mut c, 7, 1000, 1, T0);
    activate(&mut c, 7, T0 + 1000);
}

#[test]
#[should_panic(expected = "Only the box owner")]
fn only_owner_activates() {
    let mut c = with_box();
    register(&mut c, 7, 1000, 1, T0);
    certify(&mut c, 7, T0 + 1000);
    set("mallory.testnet", 0, T0 + 2000);
    c.activate_blob(hex32(7));
}

// ------------------------------------------------------------ manifest

#[test]
fn commit_manifest_sets_pointer_and_requires_sequence() {
    let mut c = box_with_active_blob();
    set("alice.testnet", 0, T0 + 3000);
    c.commit_manifest(hex16(1), hex32(7), 1);
    let b = c.get_box(hex16(1)).unwrap();
    assert_eq!(b.manifest_blob, Some(hex32(7)));
    assert_eq!(b.manifest_seq, 1);
}

#[test]
#[should_panic(expected = "must increase by one")]
fn manifest_sequence_cannot_skip() {
    let mut c = box_with_active_blob();
    set("alice.testnet", 0, T0 + 3000);
    c.commit_manifest(hex16(1), hex32(7), 2);
}

#[test]
#[should_panic(expected = "must be active")]
fn manifest_blob_must_be_active() {
    let mut c = with_box();
    register(&mut c, 7, 1000, 1, T0);
    certify(&mut c, 7, T0 + 1000);
    set("alice.testnet", 0, T0 + 2000);
    c.commit_manifest(hex16(1), hex32(7), 1);
}

// -------------------------------------------------------------- abandon

#[test]
fn abandon_after_window_removes_record_and_refunds() {
    let mut c = with_box();
    register(&mut c, 7, 1000, 1, T0);
    set("anyone.testnet", 0, T0 + 2 * HOUR);
    c.abandon_blob(hex32(7));
    assert!(c.get_blob(hex32(7)).is_none());
    assert_eq!(c.get_box(hex16(1)).unwrap().live_blobs, 0);
    assert!(!get_created_receipts().is_empty());
}

#[test]
#[should_panic(expected = "window is still open")]
fn abandon_before_window_rejected() {
    let mut c = with_box();
    register(&mut c, 7, 1000, 1, T0);
    set("anyone.testnet", 0, T0 + 1000);
    c.abandon_blob(hex32(7));
}

// --------------------------------------------------------------- retire

#[test]
fn retire_moves_to_retired_and_queues_erasure() {
    let mut c = box_with_active_blob();
    set("alice.testnet", 0, T0 + 5000);
    c.retire_blob(hex32(7));
    assert_eq!(c.get_blob(hex32(7)).unwrap().state, BlobState::Retired);
    assert_eq!(c.blobs_to_erase(0, None, None).len(), 1);
    assert_eq!(c.blobs_to_erase(1, None, None).len(), 1); // a node that has not attested yet
}

// SI4: Retired is terminal.
#[test]
#[should_panic(expected = "cannot be retired in this state")]
fn retired_cannot_be_retired_again() {
    let mut c = box_with_active_blob();
    set("alice.testnet", 0, T0 + 5000);
    c.retire_blob(hex32(7));
    c.retire_blob(hex32(7));
}

#[test]
#[should_panic(expected = "certified first")]
fn retired_cannot_be_reactivated() {
    let mut c = box_with_active_blob();
    set("alice.testnet", 0, T0 + 5000);
    c.retire_blob(hex32(7));
    c.activate_blob(hex32(7));
}

#[test]
#[should_panic(expected = "Replace the manifest")]
fn cannot_retire_the_current_manifest() {
    let mut c = box_with_active_blob();
    set("alice.testnet", 0, T0 + 3000);
    c.commit_manifest(hex16(1), hex32(7), 1);
    c.retire_blob(hex32(7));
}

#[test]
#[should_panic(expected = "Only the box owner")]
fn only_owner_retires() {
    let mut c = box_with_active_blob();
    set("mallory.testnet", 0, T0 + 5000);
    c.retire_blob(hex32(7));
}

#[test]
fn erasure_attestation_removes_record_when_all_nodes_attest() {
    let mut c = box_with_active_blob();
    set("alice.testnet", 0, T0 + 5000);
    c.retire_blob(hex32(7));
    let s = erase_sig(&c, 7, &NODE_SEED);
    set("node1.testnet", 0, T0 + 6000);
    c.attest_erasure(hex32(7), 0, s);
    assert!(c.get_blob(hex32(7)).is_none());
    assert_eq!(c.get_box(hex16(1)).unwrap().live_blobs, 0);
    assert!(c.blobs_to_erase(0, None, None).is_empty());
}

#[test]
#[should_panic(expected = "Bad node signature")]
fn erasure_attestation_needs_the_node_key() {
    let mut c = box_with_active_blob();
    set("alice.testnet", 0, T0 + 5000);
    c.retire_blob(hex32(7));
    let s = erase_sig(&c, 7, &[9u8; 32]);
    c.attest_erasure(hex32(7), 0, s);
}

#[test]
#[should_panic(expected = "Blob is not retired")]
fn cannot_attest_erasure_of_a_live_blob() {
    let mut c = box_with_active_blob();
    let s = erase_sig(&c, 7, &NODE_SEED);
    c.attest_erasure(hex32(7), 0, s);
}

#[test]
fn finalize_after_grace_removes_without_attestations() {
    let mut c = box_with_active_blob();
    set("alice.testnet", 0, T0 + 5000);
    c.retire_blob(hex32(7));
    set("anyone.testnet", 0, T0 + 5000 + 7 * 86_400_000 + 1);
    c.finalize_retired(hex32(7));
    assert!(c.get_blob(hex32(7)).is_none());
}

#[test]
#[should_panic(expected = "Grace period has not passed")]
fn finalize_before_grace_rejected() {
    let mut c = box_with_active_blob();
    set("alice.testnet", 0, T0 + 5000);
    c.retire_blob(hex32(7));
    set("anyone.testnet", 0, T0 + 6000);
    c.finalize_retired(hex32(7));
}

#[test]
fn box_can_be_deleted_after_blobs_are_erased() {
    let mut c = box_with_active_blob();
    set("alice.testnet", 0, T0 + 5000);
    c.retire_blob(hex32(7));
    let s = erase_sig(&c, 7, &NODE_SEED);
    c.attest_erasure(hex32(7), 0, s);
    set("alice.testnet", 0, T0 + 7000);
    let _ = c.delete_box(hex16(1));
    assert!(c.get_box(hex16(1)).is_none());
}

#[test]
#[should_panic(expected = "still has blobs")]
fn box_with_live_blobs_cannot_be_deleted() {
    let mut c = box_with_active_blob();
    set("alice.testnet", 0, T0 + 5000);
    let _ = c.delete_box(hex16(1));
}

// --------------------------------------------------------------- expiry

#[test]
fn expire_after_paid_period_and_grace() {
    let mut c = box_with_active_blob(); // 30 days
    let end = T0 + 30 * 86_400_000 + 7 * 86_400_000 + 1;
    set("anyone.testnet", 0, end);
    c.expire_blob(hex32(7));
    assert_eq!(c.get_blob(hex32(7)).unwrap().state, BlobState::Retired);
}

#[test]
#[should_panic(expected = "still within its paid period")]
fn cannot_expire_early() {
    let mut c = box_with_active_blob();
    set("anyone.testnet", 0, T0 + 31 * 86_400_000);
    c.expire_blob(hex32(7));
}

// --------------------------------------------------------------- extend

#[test]
fn extend_adds_days_and_fee() {
    let mut c = box_with_active_blob();
    let before = c.blobs.get(&[7u8; 32]).unwrap().clone();
    set("alice.testnet", NEAR, T0 + 5000);
    c.extend_blob(hex32(7), 10);
    let after = c.blobs.get(&[7u8; 32]).unwrap();
    assert_eq!(after.paid_until, before.paid_until + 10 * 86_400_000);
    assert!(after.fee_escrow > before.fee_escrow);
}

#[test]
#[should_panic(expected = "Only the box owner")]
fn only_owner_extends() {
    let mut c = box_with_active_blob();
    set("mallory.testnet", NEAR, T0 + 5000);
    c.extend_blob(hex32(7), 10);
}

// ----------------------------------------------------------------- fees

#[test]
fn muldiv_handles_large_values_without_overflow() {
    let big = 10u128.pow(30);
    assert_eq!(muldiv(big, 10u128.pow(12), 10u128.pow(12)), big);
    assert_eq!(muldiv(10, 3, 4), 7); // 7.5 rounds down
    assert_eq!(muldiv(0, 5, 3), 0);
}

#[test]
fn accrual_is_linear_and_capped() {
    let mut c = with_box();
    register(&mut c, 7, MIB, 10, T0);
    let rec = c.blobs.get(&[7u8; 32]).unwrap().clone();
    let day = 86_400_000;
    assert_eq!(accrued(&rec, T0), 0);
    assert_eq!(accrued(&rec, T0 + 5 * day), rec.fee_escrow / 2);
    assert_eq!(accrued(&rec, T0 + 10 * day), rec.fee_escrow);
    assert_eq!(accrued(&rec, T0 + 99 * day), rec.fee_escrow); // capped at the paid period
    assert_eq!(accrued(&rec, T0 - 5), 0); // before registration
}

#[test]
fn claim_fee_pays_the_node_once() {
    let mut c = box_with_active_blob();
    set("anyone.testnet", 0, T0 + 10 * 86_400_000);
    c.claim_fee(hex32(7), 0);
    let r = c.blobs.get(&[7u8; 32]).unwrap();
    assert!(r.claimed[0] > 0);
    assert_eq!(r.claimed[0], accrued(r, T0 + 10 * 86_400_000));
}

#[test]
#[should_panic(expected = "Nothing to claim")]
fn claim_fee_cannot_be_repeated_at_the_same_time() {
    let mut c = box_with_active_blob();
    set("anyone.testnet", 0, T0 + 10 * 86_400_000);
    c.claim_fee(hex32(7), 0);
    c.claim_fee(hex32(7), 0);
}
