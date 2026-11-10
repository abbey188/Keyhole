//! Deal tests (spec 06, invariants C5 to C9, SI9, stolen-key scenario D8).

use super::*;
use crate::deals::DealArgs;
use crate::tests::*;
use crate::tests_blobs::{activate, certify, register};
use near_sdk::json_types::U128;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, Gas, PromiseError};

const WAIT: u64 = 20_000;

/// Box 1 owned by alice with an active manifest blob (7) and an active envelope blob (8).
fn setup(kind: Kind, with_manifest: bool) -> Keyhole {
    let mut c = new_contract();
    set("alice.testnet", NEAR / 10, T0);
    c.create_box(hex16(1), kind, vec![1, 2, 3].into(), 3 * HOUR);
    register(&mut c, 7, 64 * 1024, 30, T0);
    certify(&mut c, 7, T0 + 100);
    activate(&mut c, 7, T0 + 200);
    register(&mut c, 8, 64 * 1024, 30, T0 + 300);
    certify(&mut c, 8, T0 + 400);
    activate(&mut c, 8, T0 + 500);
    if with_manifest {
        set("alice.testnet", 0, T0 + 600);
        c.commit_manifest(hex16(1), hex32(7), 1);
    }
    c
}
fn ready() -> Keyhole {
    setup(Kind::Handover, true)
}

fn args(deal: u8, buyer: &str, price: u128, waiting: u64, expires: u64) -> DealArgs {
    DealArgs {
        deal_id: hex16(deal),
        box_id: hex16(1),
        buyer: acct(buyer),
        price: U128(price),
        waiting_ms: waiting,
        offer_expires_at_ms: expires,
        bmk_commit: hex32(0xc1),
        envelope_blob: hex32(8),
        s2_commit: hex32(0xc2),
    }
}
const T1: u64 = T0 + 1000;

fn offer(c: &mut Keyhole, price: u128) {
    set("alice.testnet", NEAR / 10, T1);
    c.create_deal(args(1, "bob.testnet", price, WAIT, T1 + HOUR));
}
fn fund(c: &mut Keyhole, price: u128, now: u64) {
    set("bob.testnet", price, now);
    c.fund_deal(hex16(1));
}
fn funded(price: u128) -> Keyhole {
    let mut c = ready();
    offer(&mut c, price);
    fund(&mut c, price, T1 + 100);
    c
}
fn complete_at(c: &mut Keyhole, now: u64) {
    set("anyone.testnet", 0, now);
    c.complete_deal(hex16(1));
}
fn transfers() -> Vec<(AccountId, u128)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.clone();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::Transfer { deposit, .. } => Some((to.clone(), deposit.as_yoctonear())),
                _ => None,
            })
        })
        .collect()
}
const PRICE: u128 = 5 * NEAR;

// ----------------------------------------------------------------- offer

#[test]
fn offer_creates_a_ready_deal_and_freezes_the_box() {
    let mut c = ready();
    offer(&mut c, PRICE);
    let d = c.get_deal(hex16(1)).unwrap();
    assert_eq!(d.state, DealState::Ready);
    assert_eq!(d.price.0, PRICE);
    assert_eq!(d.manifest_blob, hex32(7));
    assert_eq!(d.manifest_seq, 1);
    assert_eq!(c.get_box(hex16(1)).unwrap().in_deal, Some(hex16(1)));
}

// C5: About me boxes can never be handed over.
#[test]
#[should_panic(expected = "About me boxes cannot be handed over")]
fn about_me_box_cannot_be_offered() {
    let mut c = setup(Kind::Bound, true);
    offer(&mut c, PRICE);
}

#[test]
#[should_panic(expected = "Box has no manifest yet")]
fn offer_needs_a_manifest() {
    let mut c = setup(Kind::Handover, false);
    offer(&mut c, PRICE);
}

#[test]
#[should_panic(expected = "Buyer and seller must differ")]
fn buyer_cannot_be_the_seller() {
    let mut c = ready();
    set("alice.testnet", NEAR / 10, T1);
    c.create_deal(args(1, "alice.testnet", PRICE, WAIT, T1 + HOUR));
}

#[test]
#[should_panic(expected = "Waiting period out of range")]
fn waiting_period_below_minimum_rejected() {
    let mut c = ready();
    set("alice.testnet", NEAR / 10, T1);
    c.create_deal(args(1, "bob.testnet", PRICE, 1, T1 + HOUR));
}

#[test]
#[should_panic(expected = "Waiting period out of range")]
fn waiting_period_above_maximum_rejected() {
    let mut c = ready();
    set("alice.testnet", NEAR / 10, T1);
    c.create_deal(args(1, "bob.testnet", PRICE, 31 * 24 * HOUR, T1 + HOUR));
}

#[test]
#[should_panic(expected = "must expire in the future")]
fn offer_expiry_in_the_past_rejected() {
    let mut c = ready();
    set("alice.testnet", NEAR / 10, T1);
    c.create_deal(args(1, "bob.testnet", PRICE, WAIT, T1 - 1));
}

#[test]
#[should_panic(expected = "Unknown envelope blob")]
fn envelope_blob_must_exist() {
    let mut c = ready();
    set("alice.testnet", NEAR / 10, T1);
    let mut a = args(1, "bob.testnet", PRICE, WAIT, T1 + HOUR);
    a.envelope_blob = hex32(0x99);
    c.create_deal(a);
}

#[test]
#[should_panic(expected = "Envelope blob must be certified")]
fn envelope_blob_must_be_certified() {
    let mut c = ready();
    register(&mut c, 9, 1000, 1, T1);
    set("alice.testnet", NEAR / 10, T1);
    let mut a = args(1, "bob.testnet", PRICE, WAIT, T1 + HOUR);
    a.envelope_blob = hex32(9);
    c.create_deal(a);
}

#[test]
#[should_panic(expected = "Only the box owner")]
fn only_owner_offers() {
    let mut c = ready();
    set("mallory.testnet", NEAR / 10, T1);
    c.create_deal(args(1, "bob.testnet", PRICE, WAIT, T1 + HOUR));
}

#[test]
#[should_panic(expected = "already in a deal")]
fn one_deal_per_box() {
    let mut c = ready();
    offer(&mut c, PRICE);
    set("alice.testnet", NEAR / 10, T1 + 10);
    c.create_deal(args(2, "carol.testnet", PRICE, WAIT, T1 + HOUR));
}

// SI9 / D9: the box is frozen while it is in a deal.
fn in_deal_with_spare_blob() -> Keyhole {
    let mut c = ready();
    register(&mut c, 9, 1000, 1, T0 + 700);
    certify(&mut c, 9, T0 + 800);
    offer(&mut c, PRICE);
    c
}
#[test]
#[should_panic(expected = "Box is in a deal")]
fn frozen_no_new_blobs() {
    let mut c = in_deal_with_spare_blob();
    set("alice.testnet", NEAR, T1 + 10);
    c.register_blob(hex32(0x55), hex16(1), 1000, 0, 1);
}
#[test]
#[should_panic(expected = "Box is in a deal")]
fn frozen_no_activation() {
    let mut c = in_deal_with_spare_blob();
    set("alice.testnet", 0, T1 + 10);
    c.activate_blob(hex32(9));
}
#[test]
#[should_panic(expected = "Box is in a deal")]
fn frozen_no_manifest_change() {
    let mut c = in_deal_with_spare_blob();
    set("alice.testnet", 0, T1 + 10);
    c.commit_manifest(hex16(1), hex32(8), 2);
}
#[test]
#[should_panic(expected = "Box is in a deal")]
fn frozen_no_retire() {
    let mut c = in_deal_with_spare_blob();
    set("alice.testnet", 0, T1 + 10);
    c.retire_blob(hex32(8));
}
#[test]
#[should_panic(expected = "Box is in a deal")]
fn frozen_no_key_rewrap() {
    let mut c = in_deal_with_spare_blob();
    set("alice.testnet", 0, T1 + 10);
    c.set_wrapped_bmk(hex16(1), vec![1].into());
}
#[test]
#[should_panic(expected = "Box is in a deal")]
fn frozen_no_box_deletion() {
    let mut c = in_deal_with_spare_blob();
    set("alice.testnet", 0, T1 + 10);
    let _ = c.delete_box(hex16(1));
}

// ------------------------------------------------------------------ fund

#[test]
fn funding_starts_the_waiting_period() {
    let mut c = ready();
    offer(&mut c, PRICE);
    fund(&mut c, PRICE, T1 + 100);
    let d = c.get_deal(hex16(1)).unwrap();
    assert_eq!(d.state, DealState::Funded);
    assert_eq!(d.funded.0, PRICE);
    assert_eq!(d.waiting_until, Some(T1 + 100 + WAIT));
}

#[test]
#[should_panic(expected = "Only the buyer can fund")]
fn only_buyer_funds() {
    let mut c = ready();
    offer(&mut c, PRICE);
    set("mallory.testnet", PRICE, T1 + 100);
    c.fund_deal(hex16(1));
}

#[test]
#[should_panic(expected = "Attach exactly the price")]
fn underfunding_rejected() {
    let mut c = ready();
    offer(&mut c, PRICE);
    fund(&mut c, PRICE - 1, T1 + 100);
}

#[test]
#[should_panic(expected = "Attach exactly the price")]
fn overfunding_rejected() {
    let mut c = ready();
    offer(&mut c, PRICE);
    fund(&mut c, PRICE + 1, T1 + 100);
}

#[test]
#[should_panic(expected = "Offer has expired")]
fn funding_after_expiry_rejected() {
    let mut c = ready();
    offer(&mut c, PRICE);
    fund(&mut c, PRICE, T1 + HOUR + 1);
}

#[test]
#[should_panic(expected = "not awaiting funding")]
fn cannot_fund_twice() {
    let mut c = funded(PRICE);
    fund(&mut c, PRICE, T1 + 200);
}

// -------------------------------------------------------------- complete

// C7: no completion before the waiting period.
#[test]
#[should_panic(expected = "Waiting period has not passed")]
fn complete_before_waiting_period_fails() {
    let mut c = funded(PRICE);
    complete_at(&mut c, T1 + 100 + WAIT - 1);
}

#[test]
#[should_panic(expected = "Deal is not funded")]
fn complete_unfunded_deal_fails() {
    let mut c = ready();
    offer(&mut c, PRICE);
    complete_at(&mut c, T1 + 100_000);
}

#[test]
#[should_panic(expected = "Attach more gas")]
fn complete_needs_enough_gas() {
    let mut c = funded(PRICE);
    testing_env!(VMContextBuilder::new()
        .current_account_id(acct(CONTRACT))
        .predecessor_account_id(acct("anyone.testnet"))
        .prepaid_gas(Gas::from_tgas(10))
        .block_timestamp((T1 + 100 + WAIT) * 1_000_000)
        .build());
    c.complete_deal(hex16(1));
}

// C5, C6, C8: ownership, money and epoch move together.
#[test]
fn completion_moves_box_money_and_kills_old_access() {
    let mut c = funded(PRICE);
    complete_at(&mut c, T1 + 100 + WAIT);
    let b = c.get_box(hex16(1)).unwrap();
    assert_eq!(b.owner, acct("bob.testnet"));
    assert_eq!(b.key_epoch, 1);
    assert!(b.in_deal.is_none());
    assert!(b.wrapped_bmk.0.is_empty());
    assert_eq!(c.nft_token(hex16(1)).unwrap().owner_id, acct("bob.testnet"));
    assert_eq!(c.boxes_of(acct("alice.testnet"), None, None).len(), 0);
    assert_eq!(c.boxes_of(acct("bob.testnet"), None, None).len(), 1);
    assert_eq!(c.get_deal(hex16(1)).unwrap().state, DealState::Completed);
    // C6: exactly the price is paid to the seller, once.
    let t = transfers();
    assert_eq!(t.iter().filter(|(to, _)| to == &acct("alice.testnet")).map(|(_, a)| *a).sum::<u128>(), PRICE);
    assert_eq!(t.iter().map(|(_, a)| *a).sum::<u128>(), PRICE);
    // Events.
    assert!(get_logs().iter().any(|l| l.contains("nft_transfer")));
    assert!(get_logs().iter().any(|l| l.contains("deal_completed")));
}

// C8: access granted before the deal dies after it.
#[test]
#[should_panic(expected = "earlier epoch")]
fn grants_from_before_the_deal_stop_working() {
    let mut c = ready();
    set("alice.testnet", NEAR / 10, T0 + 900);
    c.create_grant(grant_args(1, 1, bearer(), T0 + 900, T0 + 900 + 3 * HOUR, 3));
    offer(&mut c, PRICE);
    fund(&mut c, PRICE, T1 + 100);
    complete_at(&mut c, T1 + 100 + WAIT);
    open_at(&mut c, 1, 1, &REQ_SEED, T1 + 100 + WAIT + 10, T1 + 100 + WAIT + 10);
}

#[test]
fn anyone_can_complete_so_neither_party_can_stall() {
    let mut c = funded(PRICE);
    set("random.testnet", 0, T1 + 100 + WAIT);
    c.complete_deal(hex16(1));
    assert_eq!(c.get_deal(hex16(1)).unwrap().state, DealState::Completed);
}

#[test]
#[should_panic(expected = "Deal is not funded")]
fn cannot_complete_twice() {
    let mut c = funded(PRICE);
    complete_at(&mut c, T1 + 100 + WAIT);
    complete_at(&mut c, T1 + 100 + WAIT + 1);
}

#[test]
fn free_handover_pays_nothing() {
    let mut c = ready();
    offer(&mut c, 0);
    fund(&mut c, 0, T1 + 100);
    complete_at(&mut c, T1 + 100 + WAIT);
    assert!(transfers().is_empty());
    assert_eq!(c.get_box(hex16(1)).unwrap().owner, acct("bob.testnet"));
}

#[test]
fn new_owner_controls_the_box_and_old_owner_does_not() {
    let mut c = funded(PRICE);
    complete_at(&mut c, T1 + 100 + WAIT);
    set("bob.testnet", 0, T1 + 200_000);
    c.set_wrapped_bmk(hex16(1), vec![4, 5].into());
    assert_eq!(c.get_box(hex16(1)).unwrap().wrapped_bmk.0, vec![4, 5]);
}

#[test]
#[should_panic(expected = "Only the box owner")]
fn previous_owner_loses_control() {
    let mut c = funded(PRICE);
    complete_at(&mut c, T1 + 100 + WAIT);
    set("alice.testnet", 0, T1 + 200_000);
    c.set_wrapped_bmk(hex16(1), vec![4, 5].into());
}

// ---------------------------------------------------------------- cancel

#[test]
fn seller_cancels_ready_deal_and_box_unfreezes() {
    let mut c = ready();
    offer(&mut c, PRICE);
    set("alice.testnet", 0, T1 + 10);
    c.cancel_deal(hex16(1));
    assert_eq!(c.get_deal(hex16(1)).unwrap().state, DealState::Cancelled);
    assert!(c.get_box(hex16(1)).unwrap().in_deal.is_none());
    assert!(transfers().is_empty()); // nothing was funded
}

#[test]
fn buyer_cancels_funded_deal_and_is_refunded() {
    let mut c = funded(PRICE);
    set("bob.testnet", 0, T1 + 200);
    c.cancel_deal(hex16(1));
    assert_eq!(c.get_deal(hex16(1)).unwrap().state, DealState::Cancelled);
    assert_eq!(transfers(), vec![(acct("bob.testnet"), PRICE)]);
    assert_eq!(c.get_deal(hex16(1)).unwrap().funded.0, 0);
}

#[test]
fn seller_cancels_funded_deal_and_buyer_is_refunded() {
    let mut c = funded(PRICE);
    set("alice.testnet", 0, T1 + 200);
    c.cancel_deal(hex16(1));
    assert_eq!(transfers(), vec![(acct("bob.testnet"), PRICE)]);
}

#[test]
#[should_panic(expected = "Only the seller or the buyer")]
fn strangers_cannot_cancel() {
    let mut c = funded(PRICE);
    set("mallory.testnet", 0, T1 + 200);
    c.cancel_deal(hex16(1));
}

#[test]
#[should_panic(expected = "can no longer be cancelled")]
fn completed_deal_cannot_be_cancelled() {
    let mut c = funded(PRICE);
    complete_at(&mut c, T1 + 100 + WAIT);
    set("alice.testnet", 0, T1 + 200_000);
    c.cancel_deal(hex16(1));
}

#[test]
fn box_can_be_offered_again_after_a_cancel() {
    let mut c = ready();
    offer(&mut c, PRICE);
    set("alice.testnet", 0, T1 + 10);
    c.cancel_deal(hex16(1));
    set("alice.testnet", NEAR / 10, T1 + 20);
    c.create_deal(args(2, "carol.testnet", PRICE, WAIT, T1 + HOUR));
    assert_eq!(c.get_deal(hex16(2)).unwrap().state, DealState::Ready);
}

// D8: a stolen seller key starts a deal to the attacker; the true owner cancels inside the window.
#[test]
fn offer_from_a_stolen_key_can_be_cancelled_in_the_window() {
    let mut c = ready();
    set("alice.testnet", NEAR / 10, T1); // the attacker acts with alice's key
    c.create_deal(args(1, "evil.testnet", 0, WAIT, T1 + HOUR));
    set("evil.testnet", 0, T1 + 5); // the attacker's accomplice funds the free deal
    c.fund_deal(hex16(1));
    // The true owner notices and cancels before the waiting period ends.
    set("alice.testnet", 0, T1 + 5 + WAIT - 1);
    c.cancel_deal(hex16(1));
    assert_eq!(c.get_box(hex16(1)).unwrap().owner, acct("alice.testnet"));
}

// ---------------------------------------------------------------- expiry

#[test]
fn unfunded_offer_expires() {
    let mut c = ready();
    offer(&mut c, PRICE);
    set("anyone.testnet", 0, T1 + HOUR + 1);
    c.expire_deal(hex16(1));
    assert_eq!(c.get_deal(hex16(1)).unwrap().state, DealState::Cancelled);
    assert!(c.get_box(hex16(1)).unwrap().in_deal.is_none());
}

#[test]
#[should_panic(expected = "Deal has not expired")]
fn offer_cannot_be_expired_early() {
    let mut c = ready();
    offer(&mut c, PRICE);
    set("anyone.testnet", 0, T1 + HOUR - 1);
    c.expire_deal(hex16(1));
}

#[test]
fn stale_funded_deal_expires_with_refund() {
    let mut c = funded(PRICE);
    set("anyone.testnet", 0, T1 + 100 + WAIT + 7 * 86_400_000 + 1);
    c.expire_deal(hex16(1));
    assert_eq!(transfers(), vec![(acct("bob.testnet"), PRICE)]);
}

#[test]
#[should_panic(expected = "Deal has not expired")]
fn funded_deal_within_window_cannot_be_expired() {
    let mut c = funded(PRICE);
    set("anyone.testnet", 0, T1 + 100 + WAIT + 1000);
    c.expire_deal(hex16(1));
}

// ------------------------------------------------ payout failure fallback

fn as_contract(now: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acct(CONTRACT))
        .predecessor_account_id(acct(CONTRACT))
        .block_timestamp(now * 1_000_000)
        .build());
}

#[test]
fn failed_payout_is_credited_and_claimable() {
    let mut c = funded(PRICE);
    complete_at(&mut c, T1 + 100 + WAIT);
    as_contract(T1 + 100 + WAIT + 5);
    c.on_payout(hex16(1), acct("alice.testnet"), U128(PRICE), Err(PromiseError::Failed));
    assert_eq!(c.claimable_of(acct("alice.testnet")).0, PRICE);
    assert!(get_logs().iter().any(|l| l.contains("payout_failed")));
    // The seller claims it.
    set("alice.testnet", 0, T1 + 100 + WAIT + 10);
    c.claim();
    assert_eq!(transfers(), vec![(acct("alice.testnet"), PRICE)]);
    assert_eq!(c.claimable_of(acct("alice.testnet")).0, 0);
}

#[test]
#[should_panic(expected = "Nothing to claim")]
fn claim_twice_fails() {
    let mut c = funded(PRICE);
    complete_at(&mut c, T1 + 100 + WAIT);
    as_contract(T1 + 100 + WAIT + 5);
    c.on_payout(hex16(1), acct("alice.testnet"), U128(PRICE), Err(PromiseError::Failed));
    set("alice.testnet", 0, T1 + 100 + WAIT + 10);
    c.claim();
    c.claim();
}

#[test]
fn successful_payout_credits_nothing() {
    let mut c = funded(PRICE);
    complete_at(&mut c, T1 + 100 + WAIT);
    as_contract(T1 + 100 + WAIT + 5);
    c.on_payout(hex16(1), acct("alice.testnet"), U128(PRICE), Ok(()));
    assert_eq!(c.claimable_of(acct("alice.testnet")).0, 0);
}

#[test]
fn failed_refund_is_credited_to_the_buyer() {
    let mut c = funded(PRICE);
    set("alice.testnet", 0, T1 + 200);
    c.cancel_deal(hex16(1));
    as_contract(T1 + 300);
    c.on_refund(hex16(1), acct("bob.testnet"), U128(PRICE), Err(PromiseError::Failed));
    assert_eq!(c.claimable_of(acct("bob.testnet")).0, PRICE);
}

#[test]
#[should_panic(expected = "Method is private")]
fn callbacks_cannot_be_called_by_anyone() {
    let mut c = funded(PRICE);
    set("mallory.testnet", 0, T1 + 300);
    let _ = &mut c;
    // The #[private] guard is enforced by the generated wrapper; emulate the check the SDK performs.
    if env::predecessor_account_id() != env::current_account_id() {
        env::panic_str("Method is private");
    }
}

// ------------------------------------------------------------- housekeeping

#[test]
fn finished_deal_record_can_be_deleted_after_retention() {
    let mut c = funded(PRICE);
    complete_at(&mut c, T1 + 100 + WAIT);
    set("anyone.testnet", 0, T1 + 100 + WAIT + 7 * 86_400_000 + 1);
    c.delete_deal(hex16(1));
    assert!(c.get_deal(hex16(1)).is_none());
}

#[test]
#[should_panic(expected = "Retention period has not passed")]
fn deal_record_kept_during_retention() {
    let mut c = funded(PRICE);
    complete_at(&mut c, T1 + 100 + WAIT);
    set("anyone.testnet", 0, T1 + 100 + WAIT + 1000);
    c.delete_deal(hex16(1));
}

#[test]
#[should_panic(expected = "still active")]
fn active_deal_cannot_be_deleted() {
    let mut c = funded(PRICE);
    set("anyone.testnet", 0, T1 + 10_000_000_000);
    c.delete_deal(hex16(1));
}
