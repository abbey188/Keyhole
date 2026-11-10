/** JSON shapes returned by the box contract's views (contracts/keyhole/src/types.rs). Hex strings are lowercase. */

export type Kind = "Bound" | "Handover";
export type GrantMode = "View" | "Claims";
export type BlobState = "Registered" | "Complete" | "Active" | "Retired";
export type DealState = "Ready" | "Funded" | "Completed" | "Cancelled";

export interface ConfigView {
  chain_id: string;
  node_keys: string[];
  threshold: number;
  rs_keys: string[];
  allowed_tokens: string[];
  min_grant_ms: number;
  max_lease_ms: number;
  min_wait_ms: number;
  max_wait_ms: number;
  grace_ms: number;
  reg_window_ms: number;
  retention_ms: number;
  withdraw_delay_ms: number;
  per_session_stake: string;
  rate_yocto_per_mib_day: string;
  max_blob_bytes: number;
  node_accounts: string[];
}

export interface BoxView {
  box_id: string;
  owner: string;
  kind: Kind;
  in_deal: string | null;
  key_epoch: number;
  wrapped_bmk: string; // base64
  manifest_blob: string | null;
  manifest_seq: number;
  receipts_head: string;
  receipts_seq: number;
  max_grant_ms: number;
  live_grants: number;
  live_blobs: number;
  created_at: number;
}

export interface GrantView {
  grant_id: string;
  box_id: string;
  epoch: number;
  /** `bearer:<pk hex>` or `account:<id>` */
  requester: string;
  mode: GrantMode;
  not_before_ms: number;
  not_after_ms: number;
  max_sessions: number;
  sessions_used: number;
  scope_hash: string;
  policy_hash: string;
  revoked_at: number | null;
}

export type GrantInvalidReason = "" | "unknown" | "revoked" | "not_yet" | "expired" | "exhausted" | "epoch";
export interface ValidView {
  valid: boolean;
  reason: GrantInvalidReason;
}

export interface SessionView {
  session_id: string;
  grant_id: string;
  opened_at: number;
  closed_at: number | null;
  log_root: string | null;
}

export interface BlobView {
  blob_id: string;
  reg_id: number;
  box_id: string;
  size: number;
  leaves: number;
  mode: number;
  state: BlobState;
  registered_at: number;
  certified_at: number | null;
  paid_until: number;
  ack_bitmap: number;
  erase_bitmap: number;
}

export interface DealView {
  deal_id: string;
  box_id: string;
  seller: string;
  buyer: string;
  price: string;
  state: DealState;
  created_at: number;
  offer_expires_at: number;
  waiting_ms: number;
  waiting_until: number | null;
  manifest_blob: string;
  manifest_seq: number;
  bmk_commit: string;
  envelope_blob: string;
  s2_commit: string;
  funded: string;
}

/** NEP-297 events the contract logs (`EVENT_JSON:` lines), parsed. */
export interface KeyholeEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface TxResult {
  txHash: string;
  /** Events emitted by the transaction. The promise resolves only when the transaction is FINAL. */
  events: KeyholeEvent[];
}

export interface GrantArgs {
  grantId: string;
  boxId: string;
  requester: { bearer: string } | { account: string };
  mode: GrantMode;
  notBeforeMs: number;
  notAfterMs: number;
  maxSessions: number;
  scopeHash: string;
  policyHash: string;
}
