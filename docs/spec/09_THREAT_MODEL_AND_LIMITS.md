# 09 Threat model, residual risks and what we claim

## 1. Assets
(1) Plaintext of items. (2) Keys (passkey PRF secret, data root, BMK, segment keys, key halves). (3) The truth of the receipt chain. (4) Money in escrow. (5) Availability of a user's data. (6) Metadata: who deals with whom, when, how often. (7) The integrity of the app and of the contract rules.

## 2. Who can see or do what (knowledge table)
| Party | Learns | Cannot learn |
|---|---|---|
| Owner | Everything they stored | Nothing hidden from them |
| Recipient with a valid session | The segments released to them, for as long as they keep what they saw | Other segments, other items, the box master key |
| Release service (RS) | Grant windows, scope structure (item_uids and segment indexes, not names), S2 halves, access patterns, IP addresses of requesters | Plaintext; segment keys without S1 |
| Storage node | Ciphertext, blob sizes (padded), access patterns, IP addresses | Plaintext, any key |
| Chain observer (public) | Box ids and owner accounts, grant windows and status, receipt commitments and timing, blob sizes (padded), deal terms, account ids, escrow movements | Names, contents, who the recipients are (digests only) |
| FastFS indexer or public reader | Public ciphertext of Durable and Permanent blobs, uploader account, size, timestamps | Plaintext without keys |
| NEAR AI relay | Ciphertext of prompts and responses under E2EE, timing, volume | Prompt or answer plaintext |
| NEAR AI model TEE | Plaintext prompt during inference | (Hardware attacks out of scope) |

## 3. Adversaries
A1 Network observer. A2 Malicious or careless recipient. A3 Compromised or malicious RS. A4 Malicious or failed storage node. A5 Public chain observer. A6 Attacker with the owner's device, passkey or session. A7 Malicious seller. A8 Malicious buyer. A9 Supply-chain or web-delivery attacker. A10 Relayer abuse. A11 Contract implementation bugs. A12 Legal and abuse pressure on operators. A13 AI-specific attacks. A14 Future cryptanalysis (harvest now, decrypt later).

## 4. Attack catalogue
Columns: attack, what it targets, mitigation, residual risk, test (10).

### A2 Recipient
| Attack | Mitigation | Residual | Test |
|---|---|---|---|
| Photograph or screenshot the viewer | Per-session watermark baked into pixels; minimal exposure (pages, not files); claims mode shows no document | Cannot be prevented; attribution depends on the watermark surviving | W3 |
| Keep decrypted keys or pages after revoke | Lease-bounded release; revoke stops future releases; content re-key plus erase (Erasable) makes cached keys useless against stored ciphertext | They keep what they already saw and any plaintext they saved | R1, S6 |
| Share the link | Budget and one active session; named-requester grants for businesses; watermark label | Bearer links are bearer; sharing is possible | A5 |
| Bulk exfiltrate through the viewer | Segment-by-segment release with rate limits; receipts show unusual page access | A patient attacker can page through a short document | A8 |
| Replay an old open request | Fresh `ts`, unique `session_id`, contract duplicate check, signature domain | None known | C4 |
| Forge a receipt or an open | Contract verifies the recipient's signature | None known | A4 |
| Two recipients collude | They can combine their own halves anyway | Same data; no extra | n/a |

### A3 Release service
| Attack | Mitigation | Residual | Test |
|---|---|---|---|
| Release keys without a receipt | Contract is the only writer of the chain; honest clients and auditors compare releases (RS log) to the chain; the viewer only proceeds after the receipt returns | A malicious RS can release a half to someone off-protocol; the missing receipt is detectable in the signed log versus the chain, after the fact | A1 |
| Skip or alter receipts | Impossible on-chain; the chain head is in the contract | None | C2 |
| Keep releasing after expiry | Release checks `final` state each time; an attacker RS can ignore the check, so the time limit is only as honest as RS | Real: RS is trusted for expiry; threshold RS and enclave reduce it; recipients who hold both halves cannot be stopped from using what they held | A2 |
| Combine its halves with leaked links | RS holds S2 only; a leaked link plus RS reveals content | Real: this is the main compromise path | A3 |
| Withhold service | Fail closed; owner access is independent of RS | Denial of service | A9 |
| Forge session logs | Logs are signed with a key listed in the contract config; page-level log commits via `close_session` | A malicious RS can omit entries, detectable only by comparing | n/a |
| Steal S2 vectors from its database | Per-grant material encrypted at rest; S1 not stored | S2 alone is useless; DB theft plus links is the same as above | A3 |

### A4 Storage node
| Attack | Mitigation | Residual | Test |
|---|---|---|---|
| Serve modified bytes | Merkle verification on every leaf | None | S8 |
| Withhold data | Other nodes and the FastFS replica (Durable) | Availability loss if T nodes fail | S9 |
| Ack without storing | Nodes recompute the root before acking; Phase 2 challenges | Not detected in the MVP; our nodes | S10 |
| Claim fees without storing | Phase 2 challenges | Not prevented in the MVP | n/a |
| Claim erasure falsely | Crypto-shredding by re-key; attestation is a claim | Physical erasure unprovable | S6 |
| Operator reads ciphertext | Useless without keys | Size and access-pattern metadata | n/a |

### A5 Chain observer
| Attack | Mitigation | Residual |
|---|---|---|
| Link boxes to a person | Random box ids, generic NFT metadata, no names on-chain | The owner account is public; if it is linked to identity elsewhere, so are boxes; per-box accounts (private mode) are roadmap |
| Infer activity | Commitments instead of details; batching roadmap | Timing and frequency of opens visible |
| Learn deal terms | Public by design | Price and accounts visible; private payment leg is roadmap (confidential transfers exist on NEAR but are untested here and cannot settle atomically with our escrow) |
| Observe money in a box | None; balances and flows are public by design | Deposits, withdrawals, senders and amounts of a box account are public and linked to the owner through the collection |
| Harvest ciphertext (Durable and Permanent) | Symmetric 256-bit keys | Permanent exposure of ciphertext if keys ever leak |

### A6 Stolen device or passkey
| Attack | Mitigation | Residual |
|---|---|---|
| Read everything | Passkey user-verification on each unlock; idle timeout | With the passkey the attacker has full data access: this is not a defence the design provides |
| Give access to the attacker or accomplices | Per-box ceiling limits duration; every grant is a visible receipt | They can still do it |
| Sell the box | Deal waiting period and cancel; owner notified through the app and events | If the owner never looks, a completed deal moves the box; the waiting period default is 24 h |
| Destroy data | Retire and delete are owner actions; Erasable erases | Loss. Mitigated only by Durable mode or exports |

### A7 Seller
| Attack | Mitigation | Residual |
|---|---|---|
| Sell the same box twice | One deal per box; box frozen | None |
| Change content during a deal | Frozen: no register, activate or retire | None |
| Deliver garbage or wrong data | Index preview, preview grants, claims, `bmk_commit`, `dek_commit`, optional held-back tail with arbiter | Not eliminated: the fair-exchange limit (06) |
| Keep keys and ciphertext | Buyer re-keys and nodes erase old ciphertext | The seller retains what they already had |
| Revoke buyer's grants unfairly | Seller owns the box until completion | By design |

### A8 Buyer
| Attack | Mitigation | Residual |
|---|---|---|
| Preview everything, then cancel | Seller controls preview scope, budgets, watermarks | Policy trade-off; privacy of what was seen cannot be recalled |
| Falsely claim garbage to get a refund | Held-back tail with an arbiter limits exposure; seller-signed manifest is evidence | Without an arbiter there is no dispute process |
| Fund with a malicious or misbehaving token | Allow-listed token contracts only | Allowed tokens' own risks (freeze, pause) |
| Cancel at the last second | Allowed; no loss | Seller time wasted |

### A9 Supply chain and delivery
| Attack | Mitigation | Residual |
|---|---|---|
| Malicious JavaScript served by us | Open source, reproducible build, published release manifest, verify script, stretch FastFS hosting, strict CSP, SRI | Residual trust in the host until FastFS hosting; a user cannot easily verify at runtime |
| Compromised dependency | Lockfile, pinned versions, minimal audited crypto libraries | Residual |
| Phishing link site | Link format and domain stated in the product; recipients only ever enter nothing secret | Users can be tricked into visiting a lookalike; the fragment would go to it |

### A11 Contract bugs
| Risk | Mitigation |
|---|---|
| No upgrade path to fix bugs | Bounded exposure per deployment; audit pass with the near-contract-audit checklist; invariant tests; testnet only for the hackathon |
| Callback and promise failure patterns | CEI ordering, `#[private]` callbacks, `claimable` fallback, tests with forced failures |
| Storage drain and small-deposit attacks | Deposit-for-delta pattern |
| Arithmetic and overflow | Checked arithmetic; fuzzed amounts |
| Gas griefing | Required prepaid gas; deterministic gas split |

### A12 Legal and abuse
Encrypted storage means operators host data they cannot inspect. Operators can refuse service and nodes can stop serving a blob by local policy, but they cannot read it. Testnet-only and demo data only; no claim of takedown capability. A production service would need terms, a reporting process and legal review, which are out of scope.

### A13 AI-specific
| Attack | Mitigation | Residual |
|---|---|---|
| Prompt injection in a document | Schema-constrained output, rule cross-check, owner review | A convincing injection plus a careless owner |
| Model error | Owner review; grade B explicit about what it means | Wrong claims signed by the owner are the owner's |
| Attestation spoofing or key substitution | Client-side attestation verification; fail closed; fallback pinned key with a stated weaker trust | Depends on NVIDIA and Intel roots; side-channel attacks out of scope |
| Hardware attacks on TEEs (published physical attacks exist) | Stated limitation; Private tier means isolation from remote attackers and NEAR's software admins, not from a physically capable insider | Real |
| Cost drain | Relay rate limits, per-vault budgets | Demo key exposure risk is contained by the relay |

### A14 Future cryptanalysis
Public ciphertext is protected by symmetric 256-bit keys that never pass through public-key encryption (keys derive from BMK, which is wrapped under a passkey-derived symmetric key). Grover's algorithm halves effective strength to about 128 bits, still adequate. The transient X25519 envelopes (handover, session sealing, E2EE to the model) are vulnerable to a future quantum adversary only if recorded; they protect short-lived material. Signatures (Ed25519) do not protect secrecy. A post-quantum migration would swap envelopes for ML-KEM and signatures for ML-DSA (the runtime exposes `ml_dsa_verify` [CODE]).

## 5. Privacy and security, stated precisely
- **Security** (keeping others out): browser-side encryption with owner-held keys; no server holds a whole key; integrity by Merkle roots; rules enforced by a contract with no admin.
- **Privacy** (control over what the right people learn): scoped segments, time-limited release, claims instead of files, owner-held receipt details.
- **Not anonymity.** Public metadata exists (section 2).

## 6. Claims we make (each has a test) and claims we do not make
| Claim | Test |
|---|---|
| Our servers never hold a whole key or plaintext (outside the enclave) | A3 statistical share test; code review; a network capture shows no plaintext |
| A revoked, expired or wrong-epoch grant gets no further key from RS | A2, C4 |
| No key is released before the receipt is final on-chain | A1 |
| The activity record cannot be edited by us | C1, C2, receipt chain recomputation A7 |
| Tampered storage bytes are detected | S8 |
| Boxes change owner only through a completed deal | C5 |
| A deal's payment and ownership move atomically | C6, C8 and the model check |
| Erasable data is erased on retire and old ciphertext is useless after re-key | S6 |
We do **not** claim: anonymity; protection from photographs; protection from a recipient who keeps what they saw; protection from a stolen passkey; that AI answers are true; that a certificate means data is being stored (MVP); compliance with HIPAA, GDPR, SOC 2 or any regime; production readiness; physical erasure; fair exchange without trusting the release service.

## 7. Residual risk register (ranked)
1. RS is a trusted third party for expiry and for deal keys (threshold and enclave upgrades planned).
2. A recipient keeps what they saw.
3. Stolen passkey equals full compromise except for delayed sales.
4. No storage proofs in the MVP, so node honesty is assumed.
5. Web delivery trust until the app is verifiable or served from the chain.
6. Public metadata and timing.
7. Seller delivery correctness in deals.
8. Contract bugs without an upgrade path.
9. PRF behaviour on untested devices; no recovery beyond platform sync and an optional file.
10. AI extraction is probabilistic; hardware TEE attacks out of scope.
