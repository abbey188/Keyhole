//! Keyhole box contract.
//!
//! Boxes are NFTs (NEP-171 view subset, transfers blocked: ownership changes only through a completed
//! deal). Owners give time-limited access (grants). Recipients open sessions; every open extends a
//! per-box receipt hash chain and the release service releases keys only after that receipt is final
//! (spec 05). The deployed contract has no admin and, after launch, no access keys (spec 04).
//!
//! Spec: context/spec/04_CONTRACT.md. Invariants: C1-C12 (tests in this file and tests/).
#![forbid(unsafe_code)]

mod events;
mod types;
mod util;

use events::emit;
use keyhole_proto::{msgs, receipt};
use near_sdk::json_types::Base64VecU8;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise,
};
use types::*;
use util::*;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Sk {
    Boxes,
    OwnerBoxes,
    Grants,
    Sessions,
    Deals,
}

/// Upper bound on boxes listed per owner (keeps the index small).
const MAX_BOXES_PER_OWNER: usize = 1000;
/// Allowed clock difference between a signed open request and block time.
const OPEN_FRESHNESS_MS: u64 = 60_000;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Keyhole {
    config: Config,
    boxes: LookupMap<[u8; 16], BoxRec>,
    owner_boxes: LookupMap<AccountId, Vec<[u8; 16]>>,
    grants: LookupMap<[u8; 16], GrantRec>,
    sessions: LookupMap<[u8; 16], SessionRec>,
    #[allow(dead_code)]
    deals: LookupMap<[u8; 16], DealRec>,
    total_boxes: u64,
}

#[near]
impl Keyhole {
    /// One-time initialization. All parameters are immutable afterwards (no admin).
    #[init]
    pub fn new(config: ConfigArgs) -> Self {
        Self {
            config: config.into_config(),
            boxes: LookupMap::new(Sk::Boxes),
            owner_boxes: LookupMap::new(Sk::OwnerBoxes),
            grants: LookupMap::new(Sk::Grants),
            sessions: LookupMap::new(Sk::Sessions),
            deals: LookupMap::new(Sk::Deals),
            total_boxes: 0,
        }
    }

    // ---------------------------------------------------------------- boxes

    /// Creates a box (mints its NFT). The caller becomes the owner.
    #[payable]
    pub fn create_box(
        &mut self,
        box_id: String,
        kind: Kind,
        wrapped_bmk: Base64VecU8,
        max_grant_ms: u64,
    ) {
        let id = id16(&box_id);
        require!(self.boxes.get(&id).is_none(), "Box id already used");
        require!(wrapped_bmk.0.len() <= 128, "wrapped_bmk too large");
        require!(max_grant_ms >= self.config.min_grant_ms, "max_grant_ms below the minimum");
        let owner = env::predecessor_account_id();
        let owners_list = self.owner_boxes.get(&owner).cloned().unwrap_or_default();
        require!(owners_list.len() < MAX_BOXES_PER_OWNER, "Too many boxes for this owner");

        let before = env::storage_usage();
        let rec = BoxRec {
            owner: owner.clone(),
            kind,
            state: BoxState::Open,
            key_epoch: 0,
            wrapped_bmk: wrapped_bmk.0,
            manifest_blob: None,
            manifest_seq: 0,
            receipts_head: receipt::GENESIS_HEAD,
            receipts_seq: 0,
            max_grant_ms,
            live_grants: 0,
            live_blobs: 0,
            created_at: env::block_timestamp_ms(),
            deposit: 0,
        };
        self.boxes.insert(id, rec);
        let mut list = owners_list;
        list.push(id);
        self.owner_boxes.insert(owner.clone(), list);
        self.boxes.flush();
        self.owner_boxes.flush();
        let deposit = settle_storage(before, NearToken::from_yoctonear(0));
        self.boxes.get_mut(&id).unwrap().deposit = deposit.as_yoctonear();
        self.total_boxes += 1;
        emit::nft_mint(&owner, &box_id);
        emit::box_created(&box_id, &format!("{kind:?}"));
    }

    /// Replaces the wrapped box master key (used after a deal). Owner only, box open.
    pub fn set_wrapped_bmk(&mut self, box_id: String, wrapped_bmk: Base64VecU8) {
        require!(wrapped_bmk.0.len() <= 128, "wrapped_bmk too large");
        let id = id16(&box_id);
        let b = self.box_mut_owner(&id);
        require!(b.state == BoxState::Open, "Box is in a deal");
        b.wrapped_bmk = wrapped_bmk.0;
    }

    /// Deletes an empty box and refunds its storage deposit. Owner only.
    pub fn delete_box(&mut self, box_id: String) -> Promise {
        let id = id16(&box_id);
        let b = self.box_mut_owner(&id);
        require!(b.state == BoxState::Open, "Box is in a deal");
        require!(b.live_grants == 0, "Box still has grants");
        require!(b.live_blobs == 0, "Box still has blobs");
        let owner = b.owner.clone();
        let deposit = b.deposit;
        self.boxes.remove(&id);
        let mut list = self.owner_boxes.get(&owner).cloned().unwrap_or_default();
        list.retain(|x| x != &id);
        self.owner_boxes.insert(owner.clone(), list);
        self.total_boxes -= 1;
        emit::box_deleted(&box_id);
        Promise::new(owner).transfer(NearToken::from_yoctonear(deposit))
    }

    // --------------------------------------------------------------- grants

    /// Gives access to a box (spec 04 section 5.3). The attached deposit covers the record and the
    /// prepaid stake for `max_sessions` sessions; any excess is refunded.
    #[payable]
    pub fn create_grant(&mut self, grant: GrantArgs) {
        let gid = id16(&grant.grant_id);
        let bid = id16(&grant.box_id);
        require!(self.grants.get(&gid).is_none(), "Grant id already used");
        let now = env::block_timestamp_ms();
        let requester = grant.requester.into_requester();
        {
            let b = self.box_mut_owner(&bid);
            match b.state {
                BoxState::Open => {}
                BoxState::InDeal(deal_id) => {
                    let buyer = self.deals.get(&deal_id).map(|d| d.buyer.clone());
                    // Rule R3: during a deal only grants to the deal's buyer are allowed.
                    match (&requester, buyer) {
                        (Requester::Account(a), Some(buyer)) => require!(a == &buyer, "Box is in a deal"),
                        _ => env::panic_str("Box is in a deal"),
                    }
                }
            }
        }
        let b = self.boxes.get(&bid).unwrap();
        require!(grant.not_after_ms > now, "not_after must be in the future");
        require!(grant.not_after_ms > grant.not_before_ms, "not_after must follow not_before");
        let span = grant.not_after_ms - grant.not_before_ms;
        require!(span <= b.max_grant_ms, "Grant longer than the box ceiling");
        let effective = grant.not_after_ms - grant.not_before_ms.max(now);
        require!(effective >= self.config.min_grant_ms, "Grant shorter than the minimum");
        require!(grant.max_sessions >= 1 && grant.max_sessions <= 1000, "max_sessions must be 1 to 1000");

        let epoch = b.key_epoch;
        let prepaid = NearToken::from_yoctonear(
            self.config.per_session_stake * grant.max_sessions as u128,
        );
        let before = env::storage_usage();
        let rec = GrantRec {
            box_id: bid,
            epoch,
            requester,
            mode: grant.mode,
            not_before_ms: grant.not_before_ms,
            not_after_ms: grant.not_after_ms,
            max_sessions: grant.max_sessions,
            sessions_used: 0,
            scope_hash: hash32(&grant.scope_hash),
            policy_hash: hash32(&grant.policy_hash),
            revoked_at: None,
            created_at: now,
            deposit: 0,
        };
        self.grants.insert(gid, rec);
        self.grants.flush();
        let deposit = settle_storage(before, prepaid);
        self.grants.get_mut(&gid).unwrap().deposit = deposit.as_yoctonear();
        self.boxes.get_mut(&bid).unwrap().live_grants += 1;
        emit::grant_created(&grant.box_id, &grant.grant_id);
    }

    /// Ends a grant now. Owner of the box only.
    pub fn revoke_grant(&mut self, grant_id: String) {
        let gid = id16(&grant_id);
        let bid = self.grants.get(&gid).unwrap_or_else(|| env::panic_str("Unknown grant")).box_id;
        require!(
            env::predecessor_account_id() == self.boxes.get(&bid).unwrap().owner,
            "Only the box owner can do this"
        );
        let g = self.grants.get_mut(&gid).unwrap();
        require!(g.revoked_at.is_none(), "Grant already revoked");
        g.revoked_at = Some(env::block_timestamp_ms());
        emit::grant_revoked(&hex::encode(bid), &grant_id);
    }

    /// Deletes an expired or revoked grant after the retention period and refunds its deposit to the
    /// box owner. Anyone may call.
    pub fn delete_grant(&mut self, grant_id: String) -> Promise {
        let gid = id16(&grant_id);
        let g = self.grants.get(&gid).unwrap_or_else(|| env::panic_str("Unknown grant")).clone();
        let now = env::block_timestamp_ms();
        let end = g.revoked_at.unwrap_or(g.not_after_ms).min(g.not_after_ms);
        require!(now > end + self.config.retention_ms, "Grant retention period has not passed");
        let owner = self.boxes.get(&g.box_id).unwrap().owner.clone();
        self.grants.remove(&gid);
        let b = self.boxes.get_mut(&g.box_id).unwrap();
        b.live_grants = b.live_grants.saturating_sub(1);
        emit::grant_deleted(&hex::encode(g.box_id), &grant_id);
        Promise::new(owner).transfer(NearToken::from_yoctonear(g.deposit))
    }

    // ------------------------------------------------------------- sessions

    /// Opens a session on a grant and extends the box's receipt chain. Anyone may submit; the
    /// recipient's signature (bearer links) or the caller identity (named requesters) is verified here,
    /// so a relayer cannot forge opens. The release service releases keys only after this call is final.
    pub fn open_session(
        &mut self,
        grant_id: String,
        session_id: String,
        session_pk: String,
        ts_ms: u64,
        req_sig: Option<String>,
    ) -> bool {
        let gid = id16(&grant_id);
        let sid = id16(&session_id);
        let spk = hash32(&session_pk);
        let now = env::block_timestamp_ms();
        require!(self.sessions.get(&sid).is_none(), "Session id already used");

        let g = self.grants.get(&gid).unwrap_or_else(|| env::panic_str("Unknown grant")).clone();
        require!(g.revoked_at.is_none(), "Grant revoked");
        require!(now >= g.not_before_ms, "Grant not yet valid");
        require!(now <= g.not_after_ms, "Grant expired");
        require!(g.sessions_used < g.max_sessions, "Session budget exhausted");
        let b = self.boxes.get(&g.box_id).unwrap_or_else(|| env::panic_str("Unknown box"));
        require!(g.epoch == b.key_epoch, "Grant belongs to an earlier epoch");

        let h = |d: &[u8]| env::sha256_array(d);
        let requester_digest = match &g.requester {
            Requester::Account(a) => {
                require!(&env::predecessor_account_id() == a, "Wrong requester account");
                receipt::requester_digest_account(&h, a.as_str())
            }
            Requester::Bearer(pk) => {
                let sig_hex = req_sig.unwrap_or_else(|| env::panic_str("Signature required"));
                let sig = hash64(&sig_hex);
                require!(
                    ts_ms.abs_diff(now) <= OPEN_FRESHNESS_MS,
                    "Open request timestamp is not fresh"
                );
                let msg = msgs::open_msg(
                    &self.config.chain_id,
                    env::current_account_id().as_str(),
                    &gid,
                    &sid,
                    &spk,
                    ts_ms,
                );
                require!(env::ed25519_verify(&sig, &msg, pk), "Bad signature");
                receipt::requester_digest_bearer(&h, pk)
            }
        };

        let commitment = receipt::commitment(&h, &gid, &sid, &spk, &requester_digest, now);
        let bid = g.box_id;
        let (head, seq) = {
            let b = self.boxes.get_mut(&bid).unwrap();
            b.receipts_head = receipt::chain_next(&h, &b.receipts_head, &commitment);
            b.receipts_seq += 1;
            (b.receipts_head, b.receipts_seq)
        };
        self.grants.get_mut(&gid).unwrap().sessions_used += 1;
        self.sessions.insert(sid, SessionRec { grant_id: gid, opened_at: now, closed: None });
        emit::session_opened(&hex::encode(bid), &grant_id, &session_id, seq, &hex::encode(head), &hex::encode(commitment));
        true
    }

    /// Optionally closes a session, committing the release service's page-level log root. The close is
    /// signed by a release-service key listed in the immutable config and extends the receipt chain.
    pub fn close_session(&mut self, session_id: String, log_root: String, closed_at_ms: u64, rs_idx: u8, rs_sig: String) {
        let sid = id16(&session_id);
        let root = hash32(&log_root);
        let rs_pk = *self
            .config
            .rs_keys
            .get(rs_idx as usize)
            .unwrap_or_else(|| env::panic_str("Unknown release service key"));
        let s = self.sessions.get(&sid).unwrap_or_else(|| env::panic_str("Unknown session")).clone();
        require!(s.closed.is_none(), "Session already closed");
        let msg = msgs::close_msg(&self.config.chain_id, env::current_account_id().as_str(), &sid, &root, closed_at_ms);
        require!(env::ed25519_verify(&hash64(&rs_sig), &msg, &rs_pk), "Bad signature");
        let h = |d: &[u8]| env::sha256_array(d);
        let c = receipt::close_commitment(&h, &sid, &root, closed_at_ms);
        let bid = self.grants.get(&s.grant_id).unwrap().box_id;
        let (head, seq) = {
            let b = self.boxes.get_mut(&bid).unwrap();
            b.receipts_head = receipt::chain_next(&h, &b.receipts_head, &c);
            b.receipts_seq += 1;
            (b.receipts_head, b.receipts_seq)
        };
        self.sessions.get_mut(&sid).unwrap().closed = Some((closed_at_ms, root));
        emit::session_closed(&hex::encode(bid), &session_id, seq, &hex::encode(head), &hex::encode(c));
    }

    // ---------------------------------------------------------------- views

    pub fn get_box(&self, box_id: String) -> Option<BoxView> {
        self.boxes.get(&id16(&box_id)).map(|b| b.view(&box_id))
    }

    pub fn boxes_of(&self, account_id: AccountId, from: Option<u32>, limit: Option<u32>) -> Vec<BoxView> {
        let list = self.owner_boxes.get(&account_id).cloned().unwrap_or_default();
        let from = from.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(50).min(100) as usize;
        list.iter()
            .skip(from)
            .take(limit)
            .filter_map(|id| self.boxes.get(id).map(|b| b.view(&hex::encode(id))))
            .collect()
    }

    pub fn get_grant(&self, grant_id: String) -> Option<GrantView> {
        self.grants.get(&id16(&grant_id)).map(|g| g.view(&grant_id))
    }

    /// Whether a grant would accept a new session right now, and why not.
    pub fn grant_valid(&self, grant_id: String) -> ValidView {
        let now = env::block_timestamp_ms();
        let Some(g) = self.grants.get(&id16(&grant_id)) else {
            return ValidView { valid: false, reason: "unknown".into() };
        };
        let reason = if g.revoked_at.is_some() {
            "revoked"
        } else if now < g.not_before_ms {
            "not_yet"
        } else if now > g.not_after_ms {
            "expired"
        } else if g.sessions_used >= g.max_sessions {
            "exhausted"
        } else if self.boxes.get(&g.box_id).map(|b| b.key_epoch) != Some(g.epoch) {
            "epoch"
        } else {
            ""
        };
        ValidView { valid: reason.is_empty(), reason: reason.into() }
    }

    pub fn get_session(&self, session_id: String) -> Option<SessionView> {
        self.sessions.get(&id16(&session_id)).map(|s| s.view(&session_id))
    }

    pub fn get_config(&self) -> ConfigView {
        self.config.view()
    }

    // ----------------------------------------------------------------- NEP-171 (view subset)

    pub fn nft_token(&self, token_id: String) -> Option<JsonToken> {
        self.boxes.get(&id16(&token_id)).map(|b| JsonToken { token_id: token_id.clone(), owner_id: b.owner.clone() })
    }

    pub fn nft_total_supply(&self) -> near_sdk::json_types::U128 {
        near_sdk::json_types::U128(self.total_boxes as u128)
    }

    pub fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<near_sdk::json_types::U128>, limit: Option<u64>) -> Vec<JsonToken> {
        let list = self.owner_boxes.get(&account_id).cloned().unwrap_or_default();
        list.iter()
            .skip(from_index.map(|x| x.0 as usize).unwrap_or(0))
            .take(limit.unwrap_or(50).min(100) as usize)
            .map(|id| JsonToken { token_id: hex::encode(id), owner_id: account_id.clone() })
            .collect()
    }

    /// Generic metadata only: nothing about contents or names is published (spec 04 section 4).
    pub fn nft_metadata(&self) -> NftMetadata {
        NftMetadata {
            spec: "nft-1.0.0".into(),
            name: "Keyhole boxes".into(),
            symbol: "KEYHOLE".into(),
        }
    }

    /// Boxes change owner only through a completed deal.
    #[payable]
    pub fn nft_transfer(&mut self, receiver_id: AccountId, token_id: String, approval_id: Option<u64>, memo: Option<String>) {
        let _ = (receiver_id, token_id, approval_id, memo);
        env::panic_str("Boxes change owner only through a deal");
    }

    #[payable]
    pub fn nft_transfer_call(&mut self, receiver_id: AccountId, token_id: String, approval_id: Option<u64>, memo: Option<String>, msg: String) {
        let _ = (receiver_id, token_id, approval_id, memo, msg);
        env::panic_str("Boxes change owner only through a deal");
    }
}

impl Keyhole {
    fn box_mut_owner(&mut self, id: &[u8; 16]) -> &mut BoxRec {
        let caller = env::predecessor_account_id();
        let b = self.boxes.get_mut(id).unwrap_or_else(|| env::panic_str("Unknown box"));
        require!(b.owner == caller, "Only the box owner can do this");
        b
    }
}

#[cfg(test)]
mod tests;
