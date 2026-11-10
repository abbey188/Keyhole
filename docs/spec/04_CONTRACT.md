# 04 The box contract

One Rust contract (near-sdk 5.x [CODE: 5.30.1 in the local registry]) holds boxes, blobs, grants, sessions, the receipt chain, deals and escrow. It has no admin, no upgrade method and, after initialization, no access keys. Everything stateful that a dishonest operator, seller or buyer could abuse lives here.

> Update 2026-11-10: each box also has a keyless **box account** controlled by the box NFT (money, address, public namespace); see 14. Naming and vocabulary are decided there too.

## 1. Deployment and immutability
1. Create the contract account; deploy the Wasm; call `new(config)` once.
2. Delete every access key on the account (`DeleteKey` for each). With no keys, nobody can redeploy or change code or state outside methods. A verification script calls `view_access_key_list` and asserts it is empty (invariant C1); the README states the account id and the Wasm hash.
3. Consequence: a bug cannot be patched. The mitigation is bounded exposure (testnet, per-deployment, small deposits), full tests and a contract audit pass before the final deployment, and a "deployment generation" model: a fix is a new contract id; boxes do not migrate. The app pins the generation it was built against.
4. The account must hold enough balance for its storage stake; user deposits fund it (section 3). It can never withdraw its own balance because it has no keys and no method pays out anything except tracked escrow, refunds and fees.

`config` (immutable): `chain_id`, `node_keys[N]`, `T`, `rs_keys[]` (RS log-signing keys), `allowed_tokens[]` (FT contracts for deal prices), `RATE`, `LEAF`, `MAX_BLOB`, durations (`MIN_GRANT_MS`, `MAX_LEASE_MS`, `MIN_WAIT_MS`, `MAX_WAIT_MS`, `GRACE_MS`, `REG_WINDOW_MS`, `RETENTION_MS`), and `PER_SESSION_STAKE`.

## 2. Types
```
BoxId, GrantId, SessionId, DealId = [u8;16]     BlobId = [u8;32]     Ms = u64 (block time, milliseconds)
Kind    = Bound | Handover
BoxState= Open | InDeal(DealId)
Box     { id, owner: AccountId, kind, state, key_epoch: u32,
          wrapped_bmk: Vec<u8> (<=128 B), manifest_blob: Option<BlobId>, manifest_seq: u64,
          receipts_head: [u8;32], receipts_seq: u64,
          policy { max_grant_ms: u64 },
          created_at: Ms, deposit: u128 }
Blob    (see 03 section 3)
Requester = Bearer(pk: [u8;32]) | Account(AccountId)
Mode    = View | Claims
Grant   { id, box_id, epoch: u32, requester, mode, not_before, not_after: Ms,
          max_sessions: u16, sessions_used: u16, scope_hash: [u8;32], policy_hash: [u8;32],
          status: Active | Revoked(Ms), created_at: Ms, deposit: u128 }
Session { id, grant_id, opened_at: Ms, closed: Option<(Ms,[u8;32])> }
Deal    (see 06 section 4)
Credit  claimable: Map<(AccountId, Token), u128>
Token   = Near | Ft(AccountId)
```
Identifiers are random 128-bit values chosen by the client (uniqueness checked), so box and grant ids reveal nothing and cannot be enumerated.

## 3. Storage accounting (pattern used everywhere)
Every method that creates a record measures `env::storage_usage()` before and after, requires `attached_deposit >= delta * STORAGE_PRICE`, stores the amount in the record's `deposit`, and refunds any excess to the caller. Deleting a record sends `deposit` back to the record's owner. This closes the "small deposit" attack where a caller makes the contract pay for state [DOCS: NEAR security, storage]. Per-session state is prepaid at `create_grant` as `max_sessions * PER_SESSION_STAKE`, because recipients with bearer links have no account to pay. Unused prepayment is refunded on grant deletion.

## 4. NFT interface (NEP-171 subset)
Token id = lowercase hex of `BoxId`. Implemented: `nft_token`, `nft_tokens_for_owner`, `nft_total_supply`, `nft_metadata` (NEP-177: generic title "Vault box", no media, no per-box name, so nothing about contents is published). `nft_transfer` and `nft_transfer_call` always panic with "Boxes change owner only through a deal". NEP-171 `nft_mint` is emitted by `create_box`; `nft_transfer` is emitted only by `complete_deal`. Bound boxes never change owner (C5). This keeps the box visible in standard NFT tooling while preventing ordinary transfer.

## 5. Methods
Conventions: "owner" = `predecessor_account_id == box.owner`. All time checks use `env::block_timestamp_ms()`. Every state change emits an event (section 6). Return types in brackets.

### 5.1 Boxes
| Method | Auth | Guards | Effects |
|---|---|---|---|
| `create_box(id, kind, wrapped_bmk, policy) payable` | any | id unused; `policy.max_grant_ms ≥ MIN_GRANT_MS`; storage deposit | store box; owner = caller; epoch 0; mint |
| `set_wrapped_bmk(id, wrapped)` | owner | state Open | replace (used after a deal) |
| `update_policy(id, policy)` | owner | state Open; cannot raise `max_grant_ms` above existing grants' validity retroactively | store |
| `delete_box(id)` | owner | state Open; no non-terminal blobs; no live grants | refund deposit; burn NFT event |
Views: `get_box`, `boxes_of(account, from, limit)`.

### 5.2 Blobs (state machine in 03)
`register_blob`, `certify_blob`, `activate_blob`, `abandon_blob`, `extend_blob`, `retire_blob`, `attest_erasure`, `expire_blob`, `claim_fee`, and `__fastdata_fastfs` (Verified mode). `register_blob` additionally enforces: box state Open; kind Handover ⇒ mode Erasable (SI6); size ≤ cap for the mode. `activate_blob` sets `box.manifest_blob`, increments `manifest_seq`, and requires box state Open (a box in a deal cannot change its manifest: SI9). Views: `get_blob`, `pending_erasure(node_idx, from, limit)`.

### 5.3 Grants
| Method | Auth | Guards | Effects |
|---|---|---|---|
| `create_grant(g) payable` | owner | box Open, or InDeal with `requester = Account(deal.buyer)` only (06 rule R3); `not_after > now`; `not_after - not_before ≤ box.policy.max_grant_ms`; `not_after - max(now, not_before) ≥ MIN_GRANT_MS`; deposit covers record + `max_sessions * PER_SESSION_STAKE` | store with `epoch = box.key_epoch`, status Active |
| `revoke_grant(id)` | owner | grant Active | status Revoked(now) |
| `delete_grant(id)` | anyone | now > `not_after + RETENTION_MS` or Revoked and `RETENTION_MS` passed | refund deposit to box owner |
Views: `get_grant(id)`, `grant_valid(id) -> {valid: bool, reason}` evaluated at the queried block. RS and nodes call the view at `final` finality.
Requests: a business-initiated request is a signed payload in a URL (08), not a contract object, so there is no request spam surface on-chain.

### 5.4 Sessions and receipts
`open_session(grant_id, session_id, session_pk, ts_ms, req_sig?) -> bool`
1. Load grant; reject unless status Active and `not_before ≤ now ≤ not_after`.
2. Reject unless `grant.epoch == box.key_epoch` (a deal or epoch bump kills older grants: C8).
3. Reject unless `sessions_used < max_sessions`. A box that is Open or InDeal accepts sessions on existing grants (06 rule R3); epoch bump at deal completion kills them.
4. Requester check: `Account(a)` ⇒ `predecessor == a`; `Bearer(pk)` ⇒ `ed25519_verify(req_sig, openmsg, pk)` where `openmsg = "keyhole/v1/open" 0x00 || chain_id || contract_id || grant_id || session_id || session_pk || u64 ts_ms`, and `|ts_ms - now| ≤ 60 s`. A relayer therefore cannot forge an open.
5. Reject duplicate `session_id`.
6. Effects: store `Session`; `sessions_used += 1`; update the receipt chain:
```
commitment = SHA-256("keyhole/v1/receipt" 0x00 || grant_id || session_id || session_pk || requester_digest || u64 now)
head'      = SHA-256("keyhole/v1/chain" 0x00 || head || commitment)      seq' = seq + 1
```
`requester_digest` is the hash of the account id, or of `pk` for bearer links. The receipt details (grant, scope labels, who, what, window) are an encrypted item kept in the box (07/08); the commitment on-chain lets anyone check a revealed receipt against the chain, and a gap or edit breaks the hash chain.
`close_session(session_id, log_root, closed_at, rs_idx, rs_sig)`: verifies `rs_sig` from `rs_keys[rs_idx]` over `("keyhole/v1/close" || contract || session_id || log_root || closed_at)`, stores the close, and extends the chain with a close commitment. Closing is optional; correctness does not depend on it. `log_root` commits the page-level log RS keeps (05).
Why events and a chain head instead of one state entry per receipt: a receipt entry costs about 0.001 NEAR of stake; a head plus events costs one 32-byte field. Events are pruned by regular nodes after about 5 epochs [TESTED/DOCS], so the owner client stores the receipt details and re-verifies the chain against the head, and a self-hosted or archival indexer keeps the events.

### 5.5 Deals and escrow (specified in 06; interface here)
`create_deal(...) payable`, `fund_deal(deal_id) payable`, `ft_on_transfer(sender_id, amount, msg) -> PromiseOrValue<U128>`, `deliver_envelope(deal_id, envelope_blob, s2_commit)`, `cancel_deal(deal_id)`, `complete_deal(deal_id)`, `expire_deal(deal_id)`, `claim(token)`, plus callbacks `on_payout` and `on_refund` (`#[private]`). Views: `get_deal`, `deals_of(account)`, `claimable_of(account, token)`.

## 6. Events (NEP-297 `EVENT_JSON:` logs, standard `vault` v1)
`box_created`, `box_deleted`, `blob_registered`, `blob_certified`, `blob_activated`, `blob_extended`, `blob_retired`, `blob_erased`, `blob_abandoned`, `grant_created`, `grant_revoked`, `grant_deleted`, `session_opened{box_id, grant_id, session_id, seq, head, commitment}`, `session_closed`, `deal_created`, `deal_funded`, `deal_envelope`, `deal_cancelled`, `deal_completed`, `deal_expired`, `payout_failed`, `claimed`, plus NEP-171 mint and transfer. Logs are the source for indexers and for UI history; none contains plaintext or labels.

## 7. Security and NEAR-specific hazards (each has a test in 10)
| Hazard | Rule |
|---|---|
| Async callbacks are not atomic; a promise can fail after state changed | Checks-effects-interactions: update state, then send promises; every payout has a callback that credits `claimable` on failure |
| Callbacks callable by anyone | Callbacks are `#[private]`; they read `promise_result` rather than caller-supplied values [DOCS: security, callbacks] |
| FT callback trust | `ft_on_transfer` accepts only `predecessor ∈ allowed_tokens`, checks `sender == deal.buyer`, exact amount, correct deal state; returns the whole amount unused on any mismatch |
| Unregistered recipient on an FT | Payout fails, falls into `claimable`, claimed after the recipient calls `storage_deposit` on the token |
| Gas griefing in `complete_deal` | Require `prepaid_gas ≥ GAS_COMPLETE`; split gas deterministically between payout and callback |
| Storage drain | Section 3 pattern everywhere |
| Replay of signatures | Domain-separated messages include chain id, contract id and unique session or reg ids |
| Collection misuse | One unique storage prefix per collection; flush on write [DOCS: collections error-prone patterns] |
| Timestamp trust | Only block time; never an argument, except the freshness-checked `ts_ms` in signed open requests |
| Receipt omission | `open_session` is the only way to extend the chain, and release requires it (05) |
| Contract holds more than it owes | Accounting invariant C10 below |

## 8. Invariants (formal list; test IDs map in 10)
C1 The contract account has no access keys after launch. C2 `receipts_head` changes only in `open_session` and `close_session`. C3 No grant outlives `box.policy.max_grant_ms` from creation. C4 `open_session` fails for revoked, expired, not-yet-valid, wrong-epoch, exhausted, duplicate or badly signed requests. C5 Bound boxes never change owner; Handover boxes change owner only inside `complete_deal`. C6 For every deal, escrow in equals payout to seller plus refund to buyer plus credits, and each unit is paid at most once. C7 `complete_deal` fails before `waiting_until` and after a cancel. C8 After a deal completes, `box.owner == buyer`, `key_epoch` increased, and every earlier grant fails `open_session`. C9 Owner-only methods reject others. C10 Contract balance ≥ storage stake + escrow + claimable + prepaid session stakes at all times. C11 No method sends funds except to a recorded owner, buyer, seller, node (fees) or claimant. C12 No path changes `node_keys`, `rs_keys` or `allowed_tokens`.

## 9. Gas and cost model (all [UNVERIFIED] until measured in spike S4/S6)
| Operation | Dominant cost | Estimate to verify |
|---|---|---|
| `certify_blob` | T ed25519 verifications | low single-digit Tgas |
| `open_session` | one ed25519 verification, sha256 of small inputs, 2 small writes | well under 20 Tgas |
| `__fastdata_fastfs` Verified | sha256 over 1 MiB, about 24.1 million gas per byte [config-derived] | about 25 Tgas per block, about 0.0025 NEAR |
| `complete_deal` | owner change, promise for payout, callback | tens of Tgas |
At minimum gas price 1 Tgas is 0.0001 NEAR [DOCS], so none of these approach the 1 PGas per-transaction limit [DOCS, protocol 83].
Storage: box about 0.002 NEAR, blob about 0.0016, grant about 0.002 plus session prepayments, all refundable.

## 10. Optional extension (not in MVP)
Guardian co-sign on a deal using the contract-tools approval/simple multisig patterns [CODE: near-sdk-contract-tools `approval`]; passkey-signed approvals through `p256_verify` (02, U1); Yield/Resume promises (`Promise::new_yield` [CODE]) to make `open_session` synchronous with an RS response. The last was considered and rejected for the MVP: it would put sealed key material on-chain permanently for little gain.
