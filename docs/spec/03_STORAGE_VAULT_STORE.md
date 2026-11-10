# 03 Storage: Vault Store

Vault Store is a storage protocol with an on-chain control plane (the box contract) and an off-chain data plane (storage nodes), plus FastFS as an optional chain-resident replica. It borrows the control-plane/data-plane split and the certificate idea from Walrus, replaces erasure coding with simple replication at our size, and adds three things Walrus does not give you: access-gated reads, real deletion with attestation, and the chain as a replica.

## 1. Goals and non-goals
Goals: confidentiality by encryption (nodes never see keys); integrity verifiable by any reader against an on-chain root; availability certified by a quorum before a blob becomes usable; deletable on demand with attestation; per-blob choice of durability; cost far below contract state.
Non-goals in the MVP: a permissionless node network, staking and slashing, proofs of storage in production, erasure coding, Byzantine-fault tolerance beyond one faulty node.

## 2. Parameters (set at contract init, immutable per deployment)
| Name | Demo value | Meaning |
|---|---|---|
| N, T | 3, 2 | nodes in the registry, acks needed for a certificate. Parameterized: 4,3 gives Walrus-style 3f+1 / 2f+1 with f=1 |
| LEAF | 64 KiB | Merkle leaf size (02) |
| BLOCK | 1 MiB | FastFS part size; 16 leaves |
| MAX_BLOB | 256 MiB | cap per blob in Erasable mode; 32 MiB in Durable/Permanent (FastFS limit) |
| REG_WINDOW | 1 h | time to certify after registering |
| GRACE | 7 d | after paid-until before expiry is final |
| RATE | constant yoctoNEAR per MiB-day | fee rate; demo value chosen to show the flow, not market-derived |
| node_keys[N] | Ed25519 public keys | the node registry; fixed at init, no admin to change (a new deployment replaces it) |

## 3. Blob record
```
Blob { blob_id[32], reg_id u64, box_id[16], size u64 (stream bytes), leaves u32,
       mode u8 (0 Erasable, 1 Durable, 2 Permanent),
       state u8, registered_at, certified_at?, paid_until, fee_escrow u128, fee_claimed u128,
       ack_bitmap u16, erase_bitmap u16,
       block_hashes? Vec<[u8;32]> (Durable/Permanent only, one per 1 MiB block, <=32),
       mirror_bitmap u32 (blocks verified on-chain, Verified mode) }
```
Approximate state per blob: 160 B plus 32 B per mirrored block, so about 0.0016 NEAR stake plus 0.0003 NEAR per mirrored block; the owner pays this inside the registration deposit and gets it back when the record is deleted.

## 4. Lifecycle state machine
```
                register_blob
   (none) ───────────────────────► REGISTERED ──(REG_WINDOW passes, anyone: abandon_blob)──► ABANDONED (refund, record deleted)
                                        │ certify_blob (T valid node acks)  [Permanent: mirror complete]
                                        ▼
                                    COMPLETE ──(owner: activate_blob(manifest update))──► ACTIVE
                                        │                                                   │ │
                                        │ retire_blob (owner)                               │ │ extend_blob (owner, +fee)
                                        ▼                                                   │ │
                                     RETIRED ◄──────────────── retire_blob (owner) ─────────┘ │
                                        ▲                                                     │ paid_until passes
                                        │ expire_blob (anyone, after paid_until + GRACE)      ▼
                                        └────────────────────────────────────────────── (ACTIVE, lapsed) ──► EXPIRED ► RETIRED
```
| Transition | Guard | Effect | Event |
|---|---|---|---|
| register_blob | caller owns box; box not InHandover; size within cap for mode; deposit ≥ storage stake + fee; blob_id not currently live | assign `reg_id`; escrow fee; set REGISTERED | `blob_registered` |
| certify_blob | state REGISTERED; before `registered_at + REG_WINDOW`; ≥T distinct valid node signatures over this `reg_id` | set COMPLETE, `certified_at`, `ack_bitmap`; Permanent: only if all mirror blocks verified | `blob_certified` |
| activate_blob | state COMPLETE; caller owns box; supplies `manifest_blob_id`, `manifest_seq = box.seq+1` | box now references the blob; state ACTIVE | `blob_activated` |
| abandon_blob | REGISTERED and window passed (anyone) | refund escrow minus nothing; delete record | `blob_abandoned` |
| extend_blob | ACTIVE; deposit | `paid_until += days`; add to escrow | `blob_extended` |
| retire_blob | caller owns box; state COMPLETE or ACTIVE or EXPIRED; mode ≠ Permanent | state RETIRED; refund unclaimed escrow pro rata; add to `pending_erasure` | `blob_retired` |
| attest_erasure | state RETIRED; valid node signature over `reg_id` | set bit in `erase_bitmap`; when all N set or after GRACE remove from `pending_erasure` | `blob_erased` |
| expire_blob | ACTIVE and now > `paid_until + GRACE` (anyone) | state RETIRED, same as retire | `blob_retired` |
Permanent blobs never leave ACTIVE; retire is rejected because the bytes cannot be erased, and the UI says so.

Access is possible only in ACTIVE (and in COMPLETE for the owner verifying before activation). RS refuses tickets for any other state.

## 5. Certificate (availability)
Each node `i` signs, with its registry key, over:
```
ackmsg = "keyhole/v1/ack" 0x00 || "testnet" || contract_id || u64 reg_id || blob_id(32) || u8 mode || u64 valid_until_ms
```
`valid_until_ms >= registered_at + paid period`; the node commits to hold the data until then. Binding to `contract_id`, chain id and `reg_id` stops replays across deployments and across re-registrations of the same blob_id (a re-registered blob needs fresh acks).
`certify_blob(blob_id, acks: [(idx, sig)])` verifies each signature with `env::ed25519_verify`, requires T distinct indices, and records the bitmap. Cost: T signature verifications per certificate, gas [UNVERIFIED U6, measure; expect low single-digit Tgas total].
Meaning of a certificate: at least T of N nodes signed that they recomputed the Merkle root from all leaves they hold and it matched. With N=3, T=2 and at most one faulty node, at least one honest node holds the full blob. This is Walrus's Point of Availability idea at smaller scale [DOCS: Walrus acks from 2f+1 nodes form the certificate posted on-chain].

## 6. Write protocol
1. Client builds the blob stream, Merkle tree, `blob_id`, and (Durable/Permanent) 1 MiB block hashes.
2. Client calls `register_blob` (deposit attached). Chain returns `reg_id` via event and view.
3. Client sends leaves to each node in parallel: `PUT /v1/blobs/{blob_id}/leaves/{i}` with body = 64 KiB piece, headers `X-Reg-Id`, `X-Proof` (audit path). Node checks: blob is REGISTERED on chain (view `get_blob` at final), `reg_id` matches, proof verifies against the registered root; it stores the leaf.
4. When a node holds every leaf it recomputes the root; if equal to `blob_id`'s root it returns a signed ack (`POST /v1/blobs/{blob_id}/ack` returns the signature).
5. Client collects ≥T acks, submits `certify_blob`. Any account can submit (client or relayer).
6. For Durable: client also uploads FastFS parts (section 8) in parallel with step 3 and may use `__fastdata_fastfs` Verified mode (below).
7. Client uploads the new manifest blob the same way and calls `activate_blob`.
Spam resistance: a node accepts leaves only for blobs registered on-chain with escrow paid, so uploading garbage requires paying the registration; leaves that fail the proof are rejected.
Time budget: registration finality is about 2 to 3 seconds [DOCS-level; measure U7]; leaf upload is network bound; certificate and activation are two more transactions. Walrus reports small-blob writes of about 25 s because of chain interaction [DOCS: paper section VII]; we expect single-digit seconds for small items because our quorum is local-sized. [DESIGN, measure.]

## 7. Read protocol
1. RS authorizes a session (05) and issues a **ticket**: `Sig_RS("keyhole/v1/ticket" 0x00 || blob_id || session_id || exp)` (or a shorter-lived MAC with a key shared with nodes).
2. Client requests `GET /v1/blobs/{blob_id}/leaves?from=a&to=b` with `X-Ticket`, receives the leaves and per-leaf audit paths.
3. Client verifies every leaf against the root it holds (from the box record or the manifest), then decrypts the AEAD unit(s) it has keys for.
4. If a node returns bad or no data, client retries another node (any one honest node suffices). If all fail and the blob is Durable, client reads FastFS (section 8) and verifies identically.
The owner's own reads use an owner-signed ticket (the node verifies the signer is the box owner on-chain); they never depend on RS.

## 8. Chain replica through FastFS
### 8.1 Encoding [CODE]
FastFS data is the Borsh-encoded enum `FastfsData`:
```
enum FastfsData { Simple(Box<SimpleFastfs>) = 0, Partial(Box<PartialFastfs>) = 1 }
PartialFastfs { relative_path: String, offset: u32, full_size: u32,
                mime_type: String, content_chunk: Vec<u8>, nonce: u32 }
Borsh: tag u8 | String = u32 len + bytes | Vec<u8> = u32 len + bytes | u32 little-endian
```
Validity (from the indexer): `relative_path` ≤ 1024 B; `offset` multiple of 1 MiB and < 32 MiB; `0 < full_size ≤ 32 MiB`; `mime_type` non-empty and ≤ 256 B; chunk ≤ 1 MiB; `1 ≤ nonce ≤ i32::MAX`. Entries failing validation are ignored by the indexer.
The upload is a `FunctionCall` of method `__fastdata_fastfs` with these Borsh bytes as arguments, 100 Tgas attached in our test [TESTED], receiver = our contract account (or any account). One part = one transaction, at most 1,572,864 B per transaction [DOCS], so a 1 MiB part with its envelope fits.

### 8.2 Our usage
- Path: `b/<blob_id hex>` (unique per blob, so the server's "latest row wins" behaviour is never exercised; the server's row ordering is a [CODE, not fully read] detail we avoid depending on).
- Parts: one per 1 MiB block of the stream, `offset = k * 1 MiB`, `full_size = stream length` (last part shorter), one random `nonce` for the whole blob (same for all parts), `mime_type = application/octet-stream`.
- Upload order: any; the server reassembles only when all parts with the same nonce are present [CODE], and returns 404 otherwise, so a blob is "published" when its last part lands.
- Uploader and receiver: uploader = the owner's account or the relayer; receiver = the box contract. Public URL: `https://{uploader}.fastfs.io/{contract}/b/<blob_id hex>` [CODE + TESTED for single-part files].
- Reads: the client fetches the URL, trims to `stream_len`, and verifies every leaf against the Merkle root exactly as for node reads. The response headers `x-fastdata-tx-hash`, block height and timestamp [CODE] are shown in the proof drawer.
- Size cap 32 MiB per blob in these modes [CODE].
- Cost: about 0.00059 NEAR per 1 MiB part and 0.00012 NEAR per transaction [TESTED, single-part]; a 10 MiB blob is about 0.007 NEAR, linear extrapolation. Multi-part [UNVERIFIED U3].

### 8.3 Verified mode
The contract exports a method named `__fastdata_fastfs` that accepts raw bytes. On a call it parses the Partial envelope, requires `relative_path` to equal `b/<blob_id hex>` for a REGISTERED Durable or Permanent blob, requires `offset/1 MiB = k` and `sha256(content_chunk) == block_hashes[k]`, sets bit k in `mirror_bitmap`, and returns. The indexer still sees the call (the transaction is on-chain with that method name and arguments) [UNVERIFIED U2: indexing of calls to a receiver that has contract code but where the method does not fail; the successful-call case needs testing]. Cost: sha256 at about 24.1 million gas per byte [from protocol config as recorded in the v2 spec, to be re-measured] is about 25 Tgas per 1 MiB block, about 0.0025 NEAR, roughly 4 times the raw upload cost. Benefit: the contract itself certifies that the public copy is complete and matches the root, so Permanent mode needs no trusted nodes at all.

### 8.4 Recovery from chain
A node (or the owner) rebuilds a Durable blob by fetching the FastFS URL, verifying leaves against the root, storing it, and acking again. This replaces a custom node-to-node repair protocol: the chain copy is a replica every node can rebuild from.
Self-hosting the read side: the indexer and server are open source [CODE]; running them needs the FastData pipeline and ScyllaDB. We default to the public `fastfs.io`; the spec requires only that clients verify, so a hostile indexer cannot serve bad bytes unnoticed.

## 9. Storage modes
| Mode | Bytes live in | Use for | Delete means | Revocation strength |
|---|---|---|---|---|
| **Erasable** (default) | Nodes only | Everything sensitive | Nodes erase and attest | Strong: re-key plus erase defeats cached keys |
| **Durable** | Nodes and FastFS | Records where recovery matters more than revocation | Nodes erase; owner shreds the box epoch; public ciphertext stays but is unreadable once the keys are gone | Soft: a recipient with cached keys can still decrypt the public copy forever |
| **Permanent** | FastFS only | Signed attestations, public manifests of integrity, audit bundles | Not possible | None, by design |
Invariants: a box of kind Handover may hold only Erasable blobs for its content (enforced in `register_blob`); Permanent blobs are excluded from `retire_blob`; the UI shows revocation strength per box.

## 10. Fees and incentives (what is real and what is not in the MVP)
- Registration escrows `fee = RATE * ceil(size / MiB) * days * N`.
- A node whose ack is in the certificate may call `claim_fee(blob_id)` to receive its accrued share: `fee/N * min(now, paid_until) - claimed` per day, only while the blob is ACTIVE.
- Retire refunds the unclaimed escrow to the owner pro rata.
- **No proofs of storage in the MVP.** A node can ack and claim without storing. Our nodes are our own in the demo, so the fee flow demonstrates the accounting, not the incentive. Phase 2: contract-driven random-leaf challenges (Walrus uses a randomness-based challenge with a Certificate of Storage [DOCS]). Our version: the contract derives a leaf index from `env::random_seed()` and the blob id, the node must return that 64 KiB leaf with its audit path within a window, the contract hashes it (about 1.6 Tgas at 24.1 million gas per byte) and checks it against the root; a miss withholds fee and records a strike. Block-hash randomness is weak against block producers; acceptable for non-adversarial operators, to be replaced by a proper beacon if nodes become permissionless.

## 11. Deletion semantics (honest)
- `retire_blob` is the authoritative request. Nodes must stop serving at once (they read chain state) and erase within a bounded time, then post `attest_erasure`.
- An erasure attestation is a signed claim, not proof. Physical erasure on SSDs and in backups is not guaranteed by an unlink or overwrite.
- The real guarantee in Erasable mode is **cryptographic**: after content re-key, the old ciphertext decrypts under keys nobody holds any more, and the owner derives new keys; stored remnants of old ciphertext are unreadable by anyone but a party who kept the old keys.
- Durable and Permanent public copies are never erased; Durable relies on key shredding only.

## 12. Failure modes
| Failure | Effect | Handling |
|---|---|---|
| One node down | Reads and acks continue from others | Client tries each node; T=2 of 3 |
| Two nodes down (N=3) | No new certificates; reads only if the one up holds the data | Alert; Durable blobs readable from FastFS |
| Node returns bad bytes | Merkle verification fails | Client rejects and tries another |
| Node acks without storing | Detected only by a challenge (Phase 2) or a read failure | MVP: our nodes; documented |
| RPC outage | Nodes and RS cannot read chain state | Fail closed for sharing; owner reads continue if the node trusts its last `final` view and owner signature, optional |
| Chain reorg before finality | Possible for optimistic reads | RS and nodes use `final` for authorization |
| FastFS indexer down or lagging | Durable fallback unavailable | Nodes still serve; self-host option |
| Contract bug | Funds or state stuck | No upgrade key by design: bounded exposure per deployment; audit and tests before deploy |

## 13. Comparison with Walrus (what we copy and what we change)
| Aspect | Walrus [DOCS] | Vault Store |
|---|---|---|
| Control plane | Sui objects: Blob, Storage resource, events | Box contract on NEAR: Blob record, events |
| Committee | n=3f+1 with 2f+1 quorums, hundreds of operators | N=3..4, T=2..3, our nodes; parameterized |
| Encoding | Red Stuff 2D erasure coding, about 4.5x | Full replication (3x at N=3); XOR parity (2 data + 1 parity, 1.5x) possible at N=3 |
| Blob id | Merkle commitment over slivers | SHA-256 over Merkle root of 64 KiB leaves plus parameters |
| Certificate | 2f+1 signed acks posted on-chain (PoA) | T signed acks verified in the contract |
| Storage period | Epochs of 2 weeks | Wall-clock days from block time |
| Deletion | Burn blob object to reclaim fee; the paper does not detail node-side erasure | `retire_blob`, node erasure plus attestation, key shredding |
| Reads | Public by default; privacy added by Seal | Ticket-gated and always encrypted; plus FastFS public fallback for Durable |
| Challenges | Randomness-based Certificate of Storage | Phase 2, contract-driven random leaf |
| Chain replica | No | Yes: FastFS |
| Maturity | Mainnet, large network | None: this is a spec |
Walrus limitations the paper states that also bound us: reconfiguration is not evaluated, a malicious writer can upload inconsistent encodings (we avoid this: nodes recompute the root before acking), and write latency is dominated by the chain.

## 14. Properties we claim and test
SI1 A blob is never ACTIVE without a certificate. SI2 `blob_id` binds root, length and parameters. SI3 Only the owner of the box can register, activate, extend or retire. SI4 RETIRED is terminal. SI5 Acks cannot be replayed across `reg_id`, contract or chain. SI6 A Handover box cannot hold Durable or Permanent content. SI7 Permanent blobs cannot be retired. SI8 Reads never return unverified bytes. SI9 A box in a deal cannot register, activate or retire blobs (its manifest is constant). Tests in 10 (S1 to S14).
