use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

use crate::util::{hash32, id16};

// ------------------------------------------------------------------ enums

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    /// About me: ID, credentials. Never changes owner.
    Bound,
    /// Things: can be handed over through a deal.
    Handover,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BoxState {
    Open,
    InDeal([u8; 16]),
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    View,
    Claims,
}

#[near(serializers = [borsh])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Requester {
    Bearer([u8; 32]),
    Account(AccountId),
}

/// Upper bound on the storage one session uses: record (measured 82 bytes) plus the close data (41 bytes), with margin.
pub const SESSION_STORAGE_BYTES: u128 = 160;

// ----------------------------------------------------------------- config

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Config {
    pub chain_id: String,
    pub node_keys: Vec<[u8; 32]>,
    pub threshold: u8,
    pub rs_keys: Vec<[u8; 32]>,
    pub allowed_tokens: Vec<AccountId>,
    pub min_grant_ms: u64,
    pub max_lease_ms: u64,
    pub min_wait_ms: u64,
    pub max_wait_ms: u64,
    pub grace_ms: u64,
    pub reg_window_ms: u64,
    pub retention_ms: u64,
    pub withdraw_delay_ms: u64,
    pub per_session_stake: u128,
    pub rate_yocto_per_mib_day: u128,
    pub max_blob_bytes: u64,
    pub node_accounts: Vec<AccountId>,
}

/// Initialization arguments (keys are hex).
#[near(serializers = [json])]
pub struct ConfigArgs {
    pub chain_id: String,
    pub node_keys: Vec<String>,
    pub threshold: u8,
    pub rs_keys: Vec<String>,
    pub allowed_tokens: Vec<AccountId>,
    pub min_grant_ms: u64,
    pub max_lease_ms: u64,
    pub min_wait_ms: u64,
    pub max_wait_ms: u64,
    pub grace_ms: u64,
    pub reg_window_ms: u64,
    pub retention_ms: u64,
    pub withdraw_delay_ms: u64,
    pub per_session_stake: U128,
    pub rate_yocto_per_mib_day: U128,
    pub max_blob_bytes: u64,
    /// Account that receives each node's storage fees (same order as `node_keys`).
    pub node_accounts: Vec<AccountId>,
}

impl ConfigArgs {
    pub fn into_config(self) -> Config {
        near_sdk::require!(!self.node_keys.is_empty() && self.node_keys.len() <= 16, "1 to 16 node keys");
        near_sdk::require!(
            self.threshold >= 1 && (self.threshold as usize) <= self.node_keys.len(),
            "threshold must be between 1 and the number of node keys"
        );
        near_sdk::require!(self.node_accounts.len() == self.node_keys.len(), "one account per node key");
        near_sdk::require!(self.min_wait_ms <= self.max_wait_ms, "min_wait_ms must not exceed max_wait_ms");
        // Every opened session leaves a permanent record (and a close adds to it); its stake must pay for that storage.
        near_sdk::require!(
            self.per_session_stake.0 >= near_sdk::env::storage_byte_cost().as_yoctonear() * SESSION_STORAGE_BYTES,
            "per_session_stake does not cover a session record's storage"
        );
        Config {
            chain_id: self.chain_id,
            node_keys: self.node_keys.iter().map(|k| hash32(k)).collect(),
            threshold: self.threshold,
            rs_keys: self.rs_keys.iter().map(|k| hash32(k)).collect(),
            allowed_tokens: self.allowed_tokens,
            min_grant_ms: self.min_grant_ms,
            max_lease_ms: self.max_lease_ms,
            min_wait_ms: self.min_wait_ms,
            max_wait_ms: self.max_wait_ms,
            grace_ms: self.grace_ms,
            reg_window_ms: self.reg_window_ms,
            retention_ms: self.retention_ms,
            withdraw_delay_ms: self.withdraw_delay_ms,
            per_session_stake: self.per_session_stake.0,
            rate_yocto_per_mib_day: self.rate_yocto_per_mib_day.0,
            max_blob_bytes: self.max_blob_bytes,
            node_accounts: self.node_accounts,
        }
    }
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub chain_id: String,
    pub node_keys: Vec<String>,
    pub threshold: u8,
    pub rs_keys: Vec<String>,
    pub allowed_tokens: Vec<AccountId>,
    pub min_grant_ms: u64,
    pub max_lease_ms: u64,
    pub min_wait_ms: u64,
    pub max_wait_ms: u64,
    pub grace_ms: u64,
    pub reg_window_ms: u64,
    pub retention_ms: u64,
    pub withdraw_delay_ms: u64,
    pub per_session_stake: U128,
    pub rate_yocto_per_mib_day: U128,
    pub max_blob_bytes: u64,
    pub node_accounts: Vec<AccountId>,
}

impl Config {
    pub fn view(&self) -> ConfigView {
        ConfigView {
            chain_id: self.chain_id.clone(),
            node_keys: self.node_keys.iter().map(hex::encode).collect(),
            threshold: self.threshold,
            rs_keys: self.rs_keys.iter().map(hex::encode).collect(),
            allowed_tokens: self.allowed_tokens.clone(),
            min_grant_ms: self.min_grant_ms,
            max_lease_ms: self.max_lease_ms,
            min_wait_ms: self.min_wait_ms,
            max_wait_ms: self.max_wait_ms,
            grace_ms: self.grace_ms,
            reg_window_ms: self.reg_window_ms,
            retention_ms: self.retention_ms,
            withdraw_delay_ms: self.withdraw_delay_ms,
            per_session_stake: U128(self.per_session_stake),
            rate_yocto_per_mib_day: U128(self.rate_yocto_per_mib_day),
            max_blob_bytes: self.max_blob_bytes,
            node_accounts: self.node_accounts.clone(),
        }
    }
}

// ------------------------------------------------------------------ boxes

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct BoxRec {
    pub owner: AccountId,
    pub kind: Kind,
    pub state: BoxState,
    pub key_epoch: u32,
    pub wrapped_bmk: Vec<u8>,
    pub manifest_blob: Option<[u8; 32]>,
    pub manifest_seq: u64,
    pub receipts_head: [u8; 32],
    pub receipts_seq: u64,
    pub max_grant_ms: u64,
    pub live_grants: u32,
    pub live_blobs: u32,
    pub created_at: u64,
    pub deposit: u128,
}

#[near(serializers = [json])]
pub struct BoxView {
    pub box_id: String,
    pub owner: AccountId,
    pub kind: Kind,
    pub in_deal: Option<String>,
    pub key_epoch: u32,
    pub wrapped_bmk: near_sdk::json_types::Base64VecU8,
    pub manifest_blob: Option<String>,
    pub manifest_seq: u64,
    pub receipts_head: String,
    pub receipts_seq: u64,
    pub max_grant_ms: u64,
    pub live_grants: u32,
    pub live_blobs: u32,
    pub created_at: u64,
}

impl BoxRec {
    pub fn view(&self, box_id: &str) -> BoxView {
        BoxView {
            box_id: box_id.to_string(),
            owner: self.owner.clone(),
            kind: self.kind,
            in_deal: match self.state {
                BoxState::Open => None,
                BoxState::InDeal(d) => Some(hex::encode(d)),
            },
            key_epoch: self.key_epoch,
            wrapped_bmk: self.wrapped_bmk.clone().into(),
            manifest_blob: self.manifest_blob.map(hex::encode),
            manifest_seq: self.manifest_seq,
            receipts_head: hex::encode(self.receipts_head),
            receipts_seq: self.receipts_seq,
            max_grant_ms: self.max_grant_ms,
            live_grants: self.live_grants,
            live_blobs: self.live_blobs,
            created_at: self.created_at,
        }
    }
}

// ----------------------------------------------------------------- grants

#[near(serializers = [json])]
pub enum RequesterArg {
    /// Bearer link: the recipient's ephemeral Ed25519 public key (hex).
    Bearer(String),
    /// Named requester: a NEAR account.
    Account(AccountId),
}

impl RequesterArg {
    pub fn into_requester(self) -> Requester {
        match self {
            RequesterArg::Bearer(pk) => Requester::Bearer(hash32(&pk)),
            RequesterArg::Account(a) => Requester::Account(a),
        }
    }
}

#[near(serializers = [json])]
pub struct GrantArgs {
    pub grant_id: String,
    pub box_id: String,
    pub requester: RequesterArg,
    pub mode: Mode,
    pub not_before_ms: u64,
    pub not_after_ms: u64,
    pub max_sessions: u16,
    pub scope_hash: String,
    pub policy_hash: String,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct GrantRec {
    pub box_id: [u8; 16],
    pub epoch: u32,
    pub requester: Requester,
    pub mode: Mode,
    pub not_before_ms: u64,
    pub not_after_ms: u64,
    pub max_sessions: u16,
    pub sessions_used: u16,
    pub scope_hash: [u8; 32],
    pub policy_hash: [u8; 32],
    pub revoked_at: Option<u64>,
    pub created_at: u64,
    pub deposit: u128,
}

#[near(serializers = [json])]
pub struct GrantView {
    pub grant_id: String,
    pub box_id: String,
    pub epoch: u32,
    pub requester: String,
    pub mode: Mode,
    pub not_before_ms: u64,
    pub not_after_ms: u64,
    pub max_sessions: u16,
    pub sessions_used: u16,
    pub scope_hash: String,
    pub policy_hash: String,
    pub revoked_at: Option<u64>,
}

impl GrantRec {
    pub fn view(&self, grant_id: &str) -> GrantView {
        GrantView {
            grant_id: grant_id.to_string(),
            box_id: hex::encode(self.box_id),
            epoch: self.epoch,
            requester: match &self.requester {
                Requester::Bearer(pk) => format!("bearer:{}", hex::encode(pk)),
                Requester::Account(a) => format!("account:{a}"),
            },
            mode: self.mode,
            not_before_ms: self.not_before_ms,
            not_after_ms: self.not_after_ms,
            max_sessions: self.max_sessions,
            sessions_used: self.sessions_used,
            scope_hash: hex::encode(self.scope_hash),
            policy_hash: hex::encode(self.policy_hash),
            revoked_at: self.revoked_at,
        }
    }
}

#[near(serializers = [json])]
pub struct ValidView {
    pub valid: bool,
    pub reason: String,
}

// --------------------------------------------------------------- sessions

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct SessionRec {
    pub grant_id: [u8; 16],
    pub opened_at: u64,
    pub closed: Option<(u64, [u8; 32])>,
}

#[near(serializers = [json])]
pub struct SessionView {
    pub session_id: String,
    pub grant_id: String,
    pub opened_at: u64,
    pub closed_at: Option<u64>,
    pub log_root: Option<String>,
}

impl SessionRec {
    pub fn view(&self, session_id: &str) -> SessionView {
        SessionView {
            session_id: session_id.to_string(),
            grant_id: hex::encode(self.grant_id),
            opened_at: self.opened_at,
            closed_at: self.closed.map(|c| c.0),
            log_root: self.closed.map(|c| hex::encode(c.1)),
        }
    }
}

// ------------------------------------------------------------------ blobs

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BlobState {
    Registered,
    Complete,
    Active,
    Retired,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct BlobRec {
    pub reg_id: u64,
    pub box_id: [u8; 16],
    pub size: u64,
    pub leaves: u32,
    pub mode: u8,
    pub state: BlobState,
    pub registered_at: u64,
    pub certified_at: Option<u64>,
    pub retired_at: Option<u64>,
    pub paid_until: u64,
    pub fee_escrow: u128,
    pub claimed: Vec<u128>,
    pub ack_bitmap: u16,
    pub erase_bitmap: u16,
    pub deposit: u128,
}

#[near(serializers = [json])]
pub struct BlobView {
    pub blob_id: String,
    pub reg_id: u64,
    pub box_id: String,
    pub size: u64,
    pub leaves: u32,
    pub mode: u8,
    pub state: BlobState,
    pub registered_at: u64,
    pub certified_at: Option<u64>,
    pub paid_until: u64,
    pub ack_bitmap: u16,
    pub erase_bitmap: u16,
}

impl BlobRec {
    pub fn view(&self, blob_id: &str) -> BlobView {
        BlobView {
            blob_id: blob_id.to_string(),
            reg_id: self.reg_id,
            box_id: hex::encode(self.box_id),
            size: self.size,
            leaves: self.leaves,
            mode: self.mode,
            state: self.state,
            registered_at: self.registered_at,
            certified_at: self.certified_at,
            paid_until: self.paid_until,
            ack_bitmap: self.ack_bitmap,
            erase_bitmap: self.erase_bitmap,
        }
    }
}

#[near(serializers = [json])]
pub struct AckArg {
    pub idx: u8,
    pub sig: String,
}

// ------------------------------------------------------------------ deals

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DealState {
    /// Terms pinned, key envelope delivered; waiting for the buyer's funding.
    Ready,
    /// Escrow funded; waiting period running.
    Funded,
    Completed,
    Cancelled,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct DealRec {
    pub box_id: [u8; 16],
    pub seller: AccountId,
    pub buyer: AccountId,
    pub price: u128,
    pub state: DealState,
    pub created_at: u64,
    pub offer_expires_at: u64,
    pub waiting_ms: u64,
    pub waiting_until: Option<u64>,
    pub manifest_blob: [u8; 32],
    pub manifest_seq: u64,
    pub bmk_commit: [u8; 32],
    pub envelope_blob: [u8; 32],
    pub s2_commit: [u8; 32],
    pub funded: u128,
    pub ended_at: Option<u64>,
    pub deposit: u128,
}

#[near(serializers = [json])]
pub struct DealView {
    pub deal_id: String,
    pub box_id: String,
    pub seller: AccountId,
    pub buyer: AccountId,
    pub price: U128,
    pub state: DealState,
    pub created_at: u64,
    pub offer_expires_at: u64,
    pub waiting_ms: u64,
    pub waiting_until: Option<u64>,
    pub manifest_blob: String,
    pub manifest_seq: u64,
    pub bmk_commit: String,
    pub envelope_blob: String,
    pub s2_commit: String,
    pub funded: U128,
}

impl DealRec {
    pub fn view(&self, deal_id: &str) -> DealView {
        DealView {
            deal_id: deal_id.to_string(),
            box_id: hex::encode(self.box_id),
            seller: self.seller.clone(),
            buyer: self.buyer.clone(),
            price: U128(self.price),
            state: self.state,
            created_at: self.created_at,
            offer_expires_at: self.offer_expires_at,
            waiting_ms: self.waiting_ms,
            waiting_until: self.waiting_until,
            manifest_blob: hex::encode(self.manifest_blob),
            manifest_seq: self.manifest_seq,
            bmk_commit: hex::encode(self.bmk_commit),
            envelope_blob: hex::encode(self.envelope_blob),
            s2_commit: hex::encode(self.s2_commit),
            funded: U128(self.funded),
        }
    }
}

// -------------------------------------------------------------------- NFT

#[near(serializers = [json])]
pub struct JsonToken {
    pub token_id: String,
    pub owner_id: AccountId,
}

#[near(serializers = [json])]
pub struct NftMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
}

#[allow(dead_code)]
fn _unused(_: [u8; 16]) -> [u8; 16] {
    id16("00000000000000000000000000000000")
}
