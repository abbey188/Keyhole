//! Deals: hand over a Handover box, optionally for a NEAR price held in escrow (spec 06).
//! Ownership and money move atomically in `complete_deal`; the box key half is released by the
//! release service only after the chain shows the deal Completed.
//! Thin slice: NEAR escrow only (stablecoin escrow is a stretch), no arbiter or held-back tail.

use super::*;
use near_sdk::json_types::U128;
use near_sdk::{Gas, PromiseError};

const DAY_MS: u64 = 86_400_000;
/// Gas a caller must attach to `complete_deal` (payout promise plus callback).
const GAS_COMPLETE: Gas = Gas::from_tgas(40);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
/// A funded deal that nobody completes can be expired this long after its waiting period.
const STALE_FUNDED_MS: u64 = 7 * DAY_MS;

#[near(serializers = [json])]
pub struct DealArgs {
    pub deal_id: String,
    pub box_id: String,
    pub buyer: AccountId,
    pub price: U128,
    pub waiting_ms: u64,
    pub offer_expires_at_ms: u64,
    pub bmk_commit: String,
    /// Blob holding the key envelope sealed to the buyer (registered and certified beforehand).
    pub envelope_blob: String,
    pub s2_commit: String,
    /// Index of the release-service key that signed `rs_ack`.
    pub rs_idx: u8,
    /// Release service's signature over `deal_ack_msg(deal_id, s2_commit)`: it holds the second key half.
    pub rs_ack: String,
}

impl Keyhole {
    fn get_deal_rec(&self, id: &[u8; 16]) -> DealRec {
        self.deals.get(id).unwrap_or_else(|| env::panic_str("Unknown deal")).clone()
    }

    /// Ends a deal that never completed: unfreezes the box and refunds any funded amount.
    fn end_cancelled(&mut self, id: [u8; 16], by: &AccountId) {
        let d = self.get_deal_rec(&id);
        require!(matches!(d.state, DealState::Ready | DealState::Funded), "Deal can no longer be cancelled");
        let now = env::block_timestamp_ms();
        {
            let rec = self.deals.get_mut(&id).unwrap();
            rec.state = DealState::Cancelled;
            rec.ended_at = Some(now);
            rec.funded = 0;
        }
        if let Some(b) = self.boxes.get_mut(&d.box_id) {
            if b.state == BoxState::InDeal(id) {
                b.state = BoxState::Open;
            }
        }
        emit::deal_cancelled(&hex::encode(id), by);
        if d.funded > 0 {
            self.send_with_fallback(hex::encode(id), d.buyer.clone(), d.funded, false);
        }
    }

    /// Sends NEAR and, if the transfer fails, credits `claimable` in a callback so nothing is lost.
    fn send_with_fallback(&self, deal_id: String, to: AccountId, amount: u128, payout: bool) {
        let p = Promise::new(to.clone()).transfer(NearToken::from_yoctonear(amount));
        let cb = Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK);
        let _ = if payout {
            p.then(cb.on_payout(deal_id, to, U128(amount)))
        } else {
            p.then(cb.on_refund(deal_id, to, U128(amount)))
        };
    }

    fn move_box(&mut self, id: [u8; 16], from: &AccountId, to: &AccountId) {
        let mut src = self.owner_boxes.get(from).cloned().unwrap_or_default();
        src.retain(|x| x != &id);
        self.owner_boxes.insert(from.clone(), src);
        let mut dst = self.owner_boxes.get(to).cloned().unwrap_or_default();
        require!(dst.len() < 1000, "Buyer has too many boxes");
        dst.push(id);
        self.owner_boxes.insert(to.clone(), dst);
    }

    fn credit(&mut self, to: &AccountId, amount: u128) {
        let cur = self.claimable.get(to).copied().unwrap_or(0);
        self.claimable.insert(to.clone(), cur + amount);
    }
}

#[near]
impl Keyhole {
    /// Seller offers a Handover box to a buyer. The box is frozen (rule R3) and its manifest pinned.
    #[payable]
    pub fn create_deal(&mut self, deal: DealArgs) {
        let did = id16(&deal.deal_id);
        let bid = id16(&deal.box_id);
        require!(self.deals.get(&did).is_none(), "Deal id already used");
        let now = env::block_timestamp_ms();
        require!(deal.offer_expires_at_ms > now, "Offer must expire in the future");
        require!(
            deal.waiting_ms >= self.config.min_wait_ms && deal.waiting_ms <= self.config.max_wait_ms,
            "Waiting period out of range"
        );
        let seller = env::predecessor_account_id();
        require!(deal.buyer != seller, "Buyer and seller must differ");
        // The release service must already hold the key half this offer commits to; otherwise a seller could be
        // paid for a box whose key nobody can release.
        let rs_pk = *self.config.rs_keys.get(deal.rs_idx as usize).unwrap_or_else(|| env::panic_str("Unknown release service key"));
        let ack = keyhole_proto::release::deal_ack_msg(&did, &hash32(&deal.s2_commit));
        require!(env::ed25519_verify(&hash64(&deal.rs_ack), &ack, &rs_pk), "Release service acknowledgement is not valid");
        let env_id = hash32(&deal.envelope_blob);
        let envelope = self.blobs.get(&env_id).unwrap_or_else(|| env::panic_str("Unknown envelope blob"));
        require!(envelope.box_id == bid, "Envelope blob belongs to another box");
        require!(matches!(envelope.state, BlobState::Complete | BlobState::Active), "Envelope blob must be certified");
        let (manifest_blob, manifest_seq) = {
            let b = self.box_mut_owner(&bid);
            require!(b.kind == Kind::Handover, "About me boxes cannot be handed over");
            require!(b.state == BoxState::Open, "Box is already in a deal");
            let m = b.manifest_blob.unwrap_or_else(|| env::panic_str("Box has no manifest yet"));
            b.state = BoxState::InDeal(did);
            (m, b.manifest_seq)
        };
        let before = env::storage_usage();
        let rec = DealRec {
            box_id: bid,
            seller: seller.clone(),
            buyer: deal.buyer.clone(),
            price: deal.price.0,
            state: DealState::Ready,
            created_at: now,
            offer_expires_at: deal.offer_expires_at_ms,
            waiting_ms: deal.waiting_ms,
            waiting_until: None,
            manifest_blob,
            manifest_seq,
            bmk_commit: hash32(&deal.bmk_commit),
            envelope_blob: env_id,
            s2_commit: hash32(&deal.s2_commit),
            funded: 0,
            ended_at: None,
            deposit: 0,
        };
        self.deals.insert(did, rec);
        self.deals.flush();
        let cost = settle_storage(before, NearToken::from_yoctonear(0));
        self.deals.get_mut(&did).unwrap().deposit = cost.as_yoctonear();
        emit::deal_created(&deal.deal_id, &deal.box_id, &seller, &deal.buyer, &deal.price.0.to_string());
    }

    /// Buyer funds the escrow with exactly the price. Starts the waiting period.
    #[payable]
    pub fn fund_deal(&mut self, deal_id: String) {
        let did = id16(&deal_id);
        let d = self.get_deal_rec(&did);
        require!(env::predecessor_account_id() == d.buyer, "Only the buyer can fund this deal");
        require!(d.state == DealState::Ready, "Deal is not awaiting funding");
        let now = env::block_timestamp_ms();
        require!(now <= d.offer_expires_at, "Offer has expired");
        require!(env::attached_deposit().as_yoctonear() == d.price, "Attach exactly the price");
        let until = now + d.waiting_ms;
        let r = self.deals.get_mut(&did).unwrap();
        r.state = DealState::Funded;
        r.funded = d.price;
        r.waiting_until = Some(until);
        emit::deal_funded(&deal_id, until);
    }

    /// Either party may cancel before completion; the escrow is refunded to the buyer.
    pub fn cancel_deal(&mut self, deal_id: String) {
        let did = id16(&deal_id);
        let d = self.get_deal_rec(&did);
        let caller = env::predecessor_account_id();
        require!(caller == d.seller || caller == d.buyer, "Only the seller or the buyer can cancel");
        self.end_cancelled(did, &caller);
    }

    /// Anyone may expire an unfunded offer past its expiry, or a funded deal that nobody completed.
    pub fn expire_deal(&mut self, deal_id: String) {
        let did = id16(&deal_id);
        let d = self.get_deal_rec(&did);
        let now = env::block_timestamp_ms();
        let expired = match d.state {
            DealState::Ready => now > d.offer_expires_at,
            DealState::Funded => now > d.waiting_until.unwrap_or(0) + STALE_FUNDED_MS,
            _ => false,
        };
        require!(expired, "Deal has not expired");
        self.end_cancelled(did, &env::predecessor_account_id());
    }

    /// Completes a funded deal after its waiting period. Anyone may call: neither party can stall.
    /// Moves the box NFT to the buyer, bumps the key epoch (all earlier access dies), and pays the seller.
    pub fn complete_deal(&mut self, deal_id: String) {
        require!(env::prepaid_gas() >= GAS_COMPLETE, "Attach more gas");
        let did = id16(&deal_id);
        let d = self.get_deal_rec(&did);
        require!(d.state == DealState::Funded, "Deal is not funded");
        let now = env::block_timestamp_ms();
        require!(now >= d.waiting_until.unwrap_or(u64::MAX), "Waiting period has not passed");
        // Effects first (checks-effects-interactions): state, ownership, epoch.
        {
            let r = self.deals.get_mut(&did).unwrap();
            r.state = DealState::Completed;
            r.ended_at = Some(now);
            r.funded = 0;
        }
        let new_epoch = {
            let b = self.boxes.get_mut(&d.box_id).unwrap_or_else(|| env::panic_str("Unknown box"));
            b.owner = d.buyer.clone();
            b.key_epoch += 1;
            b.state = BoxState::Open;
            b.wrapped_bmk = Vec::new();
            b.key_epoch
        };
        self.move_box(d.box_id, &d.seller, &d.buyer);
        emit::nft_transfer(&d.seller, &d.buyer, &hex::encode(d.box_id));
        emit::deal_completed(&deal_id, &hex::encode(d.box_id), new_epoch);
        // Interactions last.
        if d.funded > 0 {
            self.send_with_fallback(deal_id, d.seller.clone(), d.funded, true);
        }
    }

    /// Removes a finished deal record after the retention period and refunds its storage deposit.
    pub fn delete_deal(&mut self, deal_id: String) {
        let did = id16(&deal_id);
        let d = self.get_deal_rec(&did);
        require!(matches!(d.state, DealState::Completed | DealState::Cancelled), "Deal is still active");
        require!(env::block_timestamp_ms() > d.ended_at.unwrap_or(0) + self.config.retention_ms, "Retention period has not passed");
        self.deals.remove(&did);
        self.pay(d.seller, d.deposit);
    }

    /// Withdraws NEAR credited after a failed payout or refund.
    pub fn claim(&mut self) {
        let who = env::predecessor_account_id();
        let amount = self.claimable.remove(&who).unwrap_or(0);
        require!(amount > 0, "Nothing to claim");
        let _ = Promise::new(who.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_claim(who, U128(amount)));
    }

    #[private]
    pub fn on_payout(&mut self, deal_id: String, to: AccountId, amount: U128, #[callback_result] result: Result<(), PromiseError>) {
        if result.is_err() {
            self.credit(&to, amount.0);
            emit::payout_failed(&deal_id, &to, &amount.0.to_string());
        }
    }

    #[private]
    pub fn on_refund(&mut self, deal_id: String, to: AccountId, amount: U128, #[callback_result] result: Result<(), PromiseError>) {
        if result.is_err() {
            self.credit(&to, amount.0);
            emit::payout_failed(&deal_id, &to, &amount.0.to_string());
        }
    }

    #[private]
    pub fn on_claim(&mut self, to: AccountId, amount: U128, #[callback_result] result: Result<(), PromiseError>) {
        if result.is_err() {
            self.credit(&to, amount.0);
        } else {
            emit::claimed(&to, &amount.0.to_string());
        }
    }

    pub fn get_deal(&self, deal_id: String) -> Option<DealView> {
        self.deals.get(&id16(&deal_id)).map(|d| d.view(&deal_id))
    }

    pub fn claimable_of(&self, account_id: AccountId) -> U128 {
        U128(self.claimable.get(&account_id).copied().unwrap_or(0))
    }
}
