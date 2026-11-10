//! Blob lifecycle (spec 03 section 4): Registered, Complete (certified by node acknowledgements),
//! Active, Retired. Thin slice: Erasable mode only. Fees accrue linearly from registration to
//! `paid_until`, are claimable by the acknowledging nodes, and the unaccrued part is refunded on retire.

use super::*;

const DAY_MS: u64 = 86_400_000;
const MIB: u64 = 1024 * 1024;

/// `a * b / c` without overflowing for the magnitudes used here.
pub(crate) fn muldiv(a: u128, b: u128, c: u128) -> u128 {
    (a / c) * b + (a % c) * b / c
}

/// Fee accrued by `rec` up to `now` (linear from registration to `paid_until`).
pub(crate) fn accrued(rec: &BlobRec, now: u64) -> u128 {
    let start = rec.registered_at;
    let end = rec.paid_until.max(start + 1);
    let t = now.clamp(start, end) - start;
    muldiv(rec.fee_escrow, t as u128, (end - start) as u128)
}

impl Keyhole {
    pub(crate) fn pay(&self, to: AccountId, amount: u128) {
        if amount > 0 {
            let _ = Promise::new(to).transfer(NearToken::from_yoctonear(amount));
        }
    }

    fn blob_owner(&self, rec: &BlobRec) -> AccountId {
        self.boxes.get(&rec.box_id).unwrap_or_else(|| env::panic_str("Unknown box")).owner.clone()
    }

    fn require_blob_owner(&self, rec: &BlobRec) {
        require!(env::predecessor_account_id() == self.blob_owner(rec), "Only the box owner can do this");
    }

    fn get_blob_rec(&self, id: &[u8; 32]) -> BlobRec {
        self.blobs.get(id).unwrap_or_else(|| env::panic_str("Unknown blob")).clone()
    }

    /// Pays each acknowledging node its unclaimed accrued share and refunds the rest to the owner.
    fn settle_fees_on_retire(&mut self, id: &[u8; 32], rec: &BlobRec, now: u64, owner: AccountId) {
        let total_accrued = accrued(rec, now);
        let count = rec.ack_bitmap.count_ones() as u128;
        let mut paid = 0u128;
        if count > 0 {
            let share = total_accrued / count;
            for idx in 0..self.config.node_keys.len() {
                if rec.ack_bitmap & (1 << idx) != 0 {
                    let due = share.saturating_sub(rec.claimed[idx]);
                    paid += rec.claimed[idx] + due;
                    self.pay(self.config.node_accounts[idx].clone(), due);
                }
            }
        }
        let refund = rec.fee_escrow.saturating_sub(paid);
        self.pay(owner, refund);
        let _ = id;
    }

    fn do_retire(&mut self, id: [u8; 32], now: u64) {
        let rec = self.get_blob_rec(&id);
        require!(matches!(rec.state, BlobState::Complete | BlobState::Active), "Blob cannot be retired in this state");
        let owner = self.blob_owner(&rec);
        self.settle_fees_on_retire(&id, &rec, now, owner);
        let r = self.blobs.get_mut(&id).unwrap();
        r.state = BlobState::Retired;
        r.retired_at = Some(now);
        r.fee_escrow = 0;
        self.pending_erasure.insert(id);
        emit::blob_retired(&hex::encode(rec.box_id), &hex::encode(id), rec.reg_id);
    }

    fn remove_blob(&mut self, id: [u8; 32]) {
        let rec = self.get_blob_rec(&id);
        let owner = self.blob_owner(&rec);
        self.blobs.remove(&id);
        self.pending_erasure.remove(&id);
        if let Some(b) = self.boxes.get_mut(&rec.box_id) {
            b.live_blobs = b.live_blobs.saturating_sub(1);
        }
        self.pay(owner, rec.deposit);
    }
}

#[near]
impl Keyhole {
    /// Registers a blob for a box. The deposit covers the record's storage and the storage fee.
    #[payable]
    pub fn register_blob(&mut self, blob_id: String, box_id: String, size: u64, mode: u8, days: u32) {
        let bid = hash32(&blob_id);
        let boxid = id16(&box_id);
        require!(mode == 0, "Only Erasable mode is available in this deployment");
        require!(size > 0 && size <= self.config.max_blob_bytes, "Blob size out of range");
        require!((1..=3650).contains(&days), "days must be 1 to 3650");
        require!(self.blobs.get(&bid).is_none(), "Blob id already registered");
        {
            let b = self.box_mut_owner(&boxid);
            require!(b.state == BoxState::Open, "Box is in a deal");
            b.live_blobs += 1;
        }
        let now = env::block_timestamp_ms();
        let n = self.config.node_keys.len();
        let mibs = size.div_ceil(MIB) as u128;
        let fee = self
            .config
            .rate_yocto_per_mib_day
            .checked_mul(mibs)
            .and_then(|x| x.checked_mul(days as u128))
            .and_then(|x| x.checked_mul(n as u128))
            .unwrap_or_else(|| env::panic_str("Fee overflow"));
        let reg_id = self.next_reg_id;
        self.next_reg_id += 1;
        let before = env::storage_usage();
        let rec = BlobRec {
            reg_id,
            box_id: boxid,
            size,
            leaves: size.div_ceil(keyhole_proto::LEAF_SIZE as u64) as u32,
            mode,
            state: BlobState::Registered,
            registered_at: now,
            certified_at: None,
            retired_at: None,
            paid_until: now + days as u64 * DAY_MS,
            fee_escrow: fee,
            claimed: vec![0u128; n],
            ack_bitmap: 0,
            erase_bitmap: 0,
            deposit: 0,
        };
        self.blobs.insert(bid, rec);
        self.blobs.flush();
        let cost = settle_storage(before, NearToken::from_yoctonear(fee));
        self.blobs.get_mut(&bid).unwrap().deposit = cost.as_yoctonear() - fee;
        emit::blob_registered(&box_id, &blob_id, reg_id, size, mode);
    }

    /// Certifies a blob: at least `threshold` distinct storage nodes signed that they hold the whole
    /// blob (and recomputed its Merkle root). Anyone may submit the acknowledgements.
    pub fn certify_blob(&mut self, blob_id: String, acks: Vec<AckArg>) {
        let bid = hash32(&blob_id);
        let rec = self.get_blob_rec(&bid);
        require!(rec.state == BlobState::Registered, "Blob is not awaiting certification");
        let now = env::block_timestamp_ms();
        require!(now <= rec.registered_at + self.config.reg_window_ms, "Registration window has passed");
        let msg = msgs::ack_msg(&self.config.chain_id, env::current_account_id().as_str(), rec.reg_id, &bid, rec.mode, rec.paid_until);
        let mut bitmap = 0u16;
        for a in acks {
            let idx = a.idx as usize;
            require!(idx < self.config.node_keys.len(), "Unknown node");
            require!(bitmap & (1 << idx) == 0, "Duplicate node acknowledgement");
            require!(env::ed25519_verify(&hash64(&a.sig), &msg, &self.config.node_keys[idx]), "Bad node signature");
            bitmap |= 1 << idx;
        }
        require!(bitmap.count_ones() as u8 >= self.config.threshold, "Not enough acknowledgements");
        let r = self.blobs.get_mut(&bid).unwrap();
        r.state = BlobState::Complete;
        r.certified_at = Some(now);
        r.ack_bitmap = bitmap;
        emit::blob_certified(&blob_id, rec.reg_id, bitmap);
    }

    /// Makes a certified blob Active (usable). Owner only; the box must not be in a deal.
    pub fn activate_blob(&mut self, blob_id: String) {
        let bid = hash32(&blob_id);
        let rec = self.get_blob_rec(&bid);
        self.require_blob_owner(&rec);
        require!(self.boxes.get(&rec.box_id).unwrap().state == BoxState::Open, "Box is in a deal");
        require!(rec.state == BlobState::Complete, "Blob must be certified first");
        self.blobs.get_mut(&bid).unwrap().state = BlobState::Active;
        emit::blob_activated(&hex::encode(rec.box_id), &blob_id);
    }

    /// Points the box at its current encrypted manifest blob. Sequence numbers only go up by one.
    pub fn commit_manifest(&mut self, box_id: String, manifest_blob: String, seq: u64) {
        let boxid = id16(&box_id);
        let mid = hash32(&manifest_blob);
        let rec = self.get_blob_rec(&mid);
        require!(rec.box_id == boxid, "Manifest blob belongs to another box");
        require!(rec.state == BlobState::Active, "Manifest blob must be active");
        let b = self.box_mut_owner(&boxid);
        require!(b.state == BoxState::Open, "Box is in a deal");
        require!(seq == b.manifest_seq + 1, "Manifest sequence must increase by one");
        b.manifest_blob = Some(mid);
        b.manifest_seq = seq;
        emit::manifest_committed(&box_id, &manifest_blob, seq);
    }

    /// Cancels a registration that never got certified after the window; refunds everything.
    pub fn abandon_blob(&mut self, blob_id: String) {
        let bid = hash32(&blob_id);
        let rec = self.get_blob_rec(&bid);
        require!(rec.state == BlobState::Registered, "Blob is not awaiting certification");
        require!(env::block_timestamp_ms() > rec.registered_at + self.config.reg_window_ms, "Registration window is still open");
        let owner = self.blob_owner(&rec);
        self.blobs.remove(&bid);
        if let Some(b) = self.boxes.get_mut(&rec.box_id) {
            b.live_blobs = b.live_blobs.saturating_sub(1);
        }
        self.pay(owner, rec.deposit + rec.fee_escrow);
        emit::blob_abandoned(&hex::encode(rec.box_id), &blob_id);
    }

    /// Adds paid days to a blob.
    #[payable]
    pub fn extend_blob(&mut self, blob_id: String, days: u32) {
        let bid = hash32(&blob_id);
        let rec = self.get_blob_rec(&bid);
        self.require_blob_owner(&rec);
        require!(matches!(rec.state, BlobState::Complete | BlobState::Active), "Blob cannot be extended in this state");
        require!((1..=3650).contains(&days), "days must be 1 to 3650");
        let n = self.config.node_keys.len() as u128;
        let mibs = rec.size.div_ceil(MIB) as u128;
        let fee = self.config.rate_yocto_per_mib_day * mibs * days as u128 * n;
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= fee, format!("Attach at least {fee} yoctoNEAR"));
        if attached > fee {
            self.pay(env::predecessor_account_id(), attached - fee);
        }
        let r = self.blobs.get_mut(&bid).unwrap();
        r.paid_until += days as u64 * DAY_MS;
        r.fee_escrow += fee;
        emit::blob_extended(&blob_id, r.paid_until);
    }

    /// Retires a blob (owner): nodes must stop serving and erase; fees are settled.
    pub fn retire_blob(&mut self, blob_id: String) {
        let bid = hash32(&blob_id);
        let rec = self.get_blob_rec(&bid);
        self.require_blob_owner(&rec);
        let b = self.boxes.get(&rec.box_id).unwrap();
        require!(b.state == BoxState::Open, "Box is in a deal");
        require!(b.manifest_blob != Some(bid), "Replace the manifest before retiring its blob");
        self.do_retire(bid, env::block_timestamp_ms());
    }

    /// Retires a blob whose paid period and grace have both passed. Anyone may call.
    pub fn expire_blob(&mut self, blob_id: String) {
        let bid = hash32(&blob_id);
        let rec = self.get_blob_rec(&bid);
        let now = env::block_timestamp_ms();
        require!(now > rec.paid_until + self.config.grace_ms, "Blob is still within its paid period");
        require!(self.boxes.get(&rec.box_id).map(|b| b.state == BoxState::Open).unwrap_or(true), "Box is in a deal");
        self.do_retire(bid, now);
    }

    /// A node attests that it erased a retired blob; when all nodes have, the record is removed.
    pub fn attest_erasure(&mut self, blob_id: String, idx: u8, sig: String) {
        let bid = hash32(&blob_id);
        let rec = self.get_blob_rec(&bid);
        require!(rec.state == BlobState::Retired, "Blob is not retired");
        let i = idx as usize;
        require!(i < self.config.node_keys.len(), "Unknown node");
        let msg = msgs::erase_msg(&self.config.chain_id, env::current_account_id().as_str(), rec.reg_id, &bid);
        require!(env::ed25519_verify(&hash64(&sig), &msg, &self.config.node_keys[i]), "Bad node signature");
        let bitmap = rec.erase_bitmap | (1 << i);
        self.blobs.get_mut(&bid).unwrap().erase_bitmap = bitmap;
        emit::blob_erased(&blob_id, rec.reg_id, bitmap);
        let full: u16 = ((1u32 << self.config.node_keys.len()) - 1) as u16;
        if bitmap == full {
            self.remove_blob(bid);
        }
    }

    /// Removes a retired blob record after the grace period even if some nodes never attested.
    pub fn finalize_retired(&mut self, blob_id: String) {
        let bid = hash32(&blob_id);
        let rec = self.get_blob_rec(&bid);
        require!(rec.state == BlobState::Retired, "Blob is not retired");
        require!(env::block_timestamp_ms() > rec.retired_at.unwrap_or(0) + self.config.grace_ms, "Grace period has not passed");
        self.remove_blob(bid);
    }

    /// Pays an acknowledging node its accrued share so far. Anyone may trigger the payment.
    pub fn claim_fee(&mut self, blob_id: String, idx: u8) {
        let bid = hash32(&blob_id);
        let rec = self.get_blob_rec(&bid);
        require!(matches!(rec.state, BlobState::Complete | BlobState::Active), "Blob is not live");
        let i = idx as usize;
        require!(i < self.config.node_keys.len() && rec.ack_bitmap & (1 << i) != 0, "Node did not acknowledge this blob");
        let share = accrued(&rec, env::block_timestamp_ms()) / rec.ack_bitmap.count_ones() as u128;
        let due = share.saturating_sub(rec.claimed[i]);
        require!(due > 0, "Nothing to claim");
        self.blobs.get_mut(&bid).unwrap().claimed[i] += due;
        self.pay(self.config.node_accounts[i].clone(), due);
    }

    pub fn get_blob(&self, blob_id: String) -> Option<BlobView> {
        self.blobs.get(&hash32(&blob_id)).map(|b| b.view(&blob_id))
    }

    /// Retired blobs a node has not yet attested as erased.
    pub fn blobs_to_erase(&self, node_idx: u8, from: Option<u32>, limit: Option<u32>) -> Vec<BlobView> {
        let i = node_idx as usize;
        self.pending_erasure
            .iter()
            .filter_map(|id| self.blobs.get(id).map(|b| (id, b)))
            .filter(|(_, b)| b.erase_bitmap & (1 << i) == 0)
            .skip(from.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .map(|(id, b)| b.view(&hex::encode(id)))
            .collect()
    }
}
