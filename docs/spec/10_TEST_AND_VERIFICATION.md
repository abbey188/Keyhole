# 10 Test and verification plan

Principle: every claim in 09 section 6 has a test that fails if the claim is false. Tests are the product's evidence; the README links each claim to its test and, where possible, to a transaction on testnet.

## 1. Test ID namespaces
| Prefix | Area | Defined in |
|---|---|---|
| X | Cryptographic vectors and properties | 02 |
| C | Contract invariants | 04 section 8 |
| S | Storage | 03 section 14 and below |
| A | Access, sessions, receipts, release service | 05 section 9 |
| D | Deals, plus model-check properties P1 to P7 | 06 |
| Q | Claims and AI | 07 |
| W | Web app | 08 section 11 |
| R | Revocation and re-key | below |
| K | Spikes (feasibility measurements) | 11 |

## 2. Cryptography (X)
- **Known-answer tests** from the standards: HKDF-SHA256 (RFC 5869 appendix vectors), X25519 (RFC 7748), Ed25519 (RFC 8032), SHA-256 (NIST), XChaCha20-Poly1305 (the IETF draft vectors), Merkle trees (RFC 6962 reference vectors).
- **Cross-implementation vectors.** A reference implementation (Rust crate `vault-proto`) generates JSON vectors for: key hierarchy from a fixed PRF output, segment encryption with fixed nonces, padding lengths, Merkle roots and audit paths for several sizes, split-key shares, sealed boxes with fixed ephemeral keys, `blob_id`, receipt commitments and chain heads, claim canonicalization. The TypeScript client, the Rust node, the RS and the contract all must reproduce them byte for byte. Any mismatch fails CI.
- **Properties** (property-based tests): decrypt(encrypt(x)) = x for random sizes including 0 and boundaries; any single-bit flip in ciphertext, AAD, nonce or key fails authentication; units cannot be reordered, truncated or spliced between items (AAD binding); padding never reveals length beyond the Padmé bucket; split shares reconstruct exactly and each share alone passes a uniformity test (chi-squared on many samples); HKDF outputs for different info strings are distinct; Merkle proofs verify for every leaf and fail for any altered sibling; `blob_id` changes when root, length or leaf size changes.
- **Misuse tests:** nonce reuse detection in test builds; key commitment mismatch rejected; wrong epoch rejected.
- **Fuzzing** the AEAD unit parser and the Borsh FastFS envelope parser with random and mutated inputs (never panics, never accepts invalid).

## 3. Contract (C)
Levels: (1) unit tests for pure logic; (2) sandbox integration tests on a local NEAR sandbox node using `near-sandbox` / `near-api` with `fast_forward` to move time [DOCS: testing quickstart]; (3) stateful property tests; (4) adversarial contracts; (5) gas and storage measurement; (6) a testnet smoke run.
| ID | Test |
|---|---|
| C1 | After launch the account's access key list is empty (testnet check script) |
| C2 | Random sequences of all methods: `receipts_head` changes only on open and close; recompute the chain from events and compare |
| C3 | Create grants of every duration around the ceiling; boundary accepted, over rejected |
| C4 | Open with: revoked, expired, not yet valid, wrong epoch, exhausted, duplicate session id, bad signature, stale timestamp, wrong requester account: each fails with the right error |
| C5 | `nft_transfer` and `nft_transfer_call` always panic; Bound boxes never change owner; Handover boxes change owner only through `complete_deal` |
| C6 | Money conservation across all deal paths (cancel at each state, expire, complete, payout failure, refund failure, token pause) using a mock FT with failure injection |
| C7 | `complete_deal` before `waiting_until` fails; after cancel fails; from wrong state fails |
| C8 | After complete: owner is buyer, epoch bumped, grants created earlier fail `open_session` |
| C9 | Every owner-only method rejects a non-owner and the previous owner after a deal |
| C10 | After any sequence: `contract.balance ≥ storage_stake + escrow + claimable + prepaid_session_stakes` |
| C11 | No transfer to an address that is not a recorded party (scan promise batch) |
| C12 | No method alters `node_keys`, `rs_keys`, `allowed_tokens` (storage diff test) |
- **Stateful property test:** a generator produces random legal and illegal action sequences across multiple accounts and times (proptest-style); after each action the invariant set C2, C3, C6, C8, C10 is checked against the contract state.
- **Adversarial contracts:** a malicious token that calls back into `ft_on_transfer` with lies; a token that fails `ft_transfer`; a receiver contract that panics; a caller that attaches too little gas to `complete_deal`; a caller that tries to call `#[private]` callbacks directly.
- **Static review:** run the `near-contract-audit` checklist (reentrancy-like callback ordering, unhandled promises, unsafe math, access control, callback security) and a `cargo audit` and `cargo clippy` clean run before the final deployment.
- **Gas and storage:** record gas for each method at typical and worst sizes; assert storage deposit equals measured delta; assert refunds on delete.

## 4. Storage (S)
| ID | Test |
|---|---|
| S1 | Blob never ACTIVE without a certificate; certificate with T−1 signatures rejected; duplicate-index signatures rejected |
| S2 | `blob_id` binds root, length and leaf size |
| S3 | Only the box owner can register, activate, extend, retire |
| S4 | RETIRED is terminal; Permanent cannot be retired; Handover boxes reject Durable and Permanent |
| S5 | Ack replay across `reg_id`, contract id or chain id rejected |
| S6 | Retire then re-key: nodes stop serving at once, erase and attest; after content re-key a recipient holding the old segment key cannot decrypt anything obtainable from nodes; with a Durable blob the same recipient still can (the documented soft case) |
| S7 | Node accepts leaves only for registered blobs with proof; rejects bad proofs and wrong reg ids |
| S8 | A node returning a modified leaf is detected by the client and bypassed |
| S9 | Kill one node: reads and writes continue; kill two (N=3): writes fail closed; Durable reads fall back to FastFS |
| S10 | Phase 2: challenge flow with a node that holds no data fails; with data passes (when implemented) |
| S11 | Registration expiry: unregistered blobs abandon after `REG_WINDOW` with refund |
| S12 | Fee accrual and refund arithmetic (property test) |
| S13 | FastFS multipart: upload 1, 2 and 32 parts; read back; missing-part behaviour 404; verification against the root (spike K1) |
| S14 | Node rebuild from FastFS after data loss, verified against the root (spike K9) |
Fault injection harness: a proxy in front of each node injecting delay, drop, corruption and disconnects, with seeded randomness for reproducibility.

## 5. Access and release service (A)
| ID | Test |
|---|---|
| A1 | No key released before the `session_opened` event is final: fault-inject an RPC that delays finality; assert no release until it arrives |
| A2 | No release after revoke, expiry, epoch change or budget exhaustion; revoke during a session stops the next release within lease or finality |
| A3 | Statistical independence: S1 and S2 each pass uniformity tests; a decrypt attempt with S2 alone or S1 alone fails |
| A4 | Forged and tampered open requests are rejected by the contract; RS cannot produce a valid open without the recipient key |
| A5 | Duplicate session ids and over-budget opens rejected; one active session per link by default |
| A6 | Release only for segments in the scope; out-of-scope requests rejected |
| A7 | Recompute the receipt chain from public events and the owner's records; matches the contract head; deleting a record breaks verification |
| A8 | Rate limits hold under load; legitimate viewing is unaffected |
| A9 | RPC loss, node loss and clock skew (RS clock shifted by hours): fails closed or unaffected; time comes only from chain blocks |
| R1 | After revoke and re-secure in Erasable mode, an adversary holding old keys and old ciphertext copies obtained before erasure can decrypt only what was already in hand; ciphertext fetched after erasure is unavailable |
Load and soak: sustained key requests, many grants, many sessions, restart RS mid-session, verify only leases are lost.

## 6. Deals (D) and model checking
- **Exhaustive model.** A small program (Rust or Python) models the state in 06 section 9 and explores all reachable states under all interleavings of: seller actions, buyer actions, attacker actions with a stolen key (for either party), time ticks, RS honest or faulty, payout success or failure. It asserts P1 to P7 and prints a table of which properties hold for an honest RS and which fail for a faulty RS (documenting the trust precisely). State space is tiny, so exploration is exhaustive.
- **Conformance.** Traces from the model are replayed against the sandbox contract; the observable state (owner, epoch, deal state, balances) must match step by step. Disagreements indicate a spec or contract bug.
- **Scenario tests:** D1 happy path with NEAR; D2 happy path with a mock FT; D3 cancel by seller at each state; D4 cancel by buyer; D5 expiry paths; D6 payout failure then claim; D7 held-back dispute paths with an arbiter (when implemented); D8 stolen-key offer cancelled by the true owner in the window; D9 content freeze during a deal; D10 grants to the buyer during a deal allowed, to others rejected.
- **Cryptographic delivery checks:** `bmk_commit` matches reconstructed BMK; `s2_commit` mismatch makes RS refuse; envelope tampering detected; the buyer cannot reconstruct BMK before `Completed` (the half is not released).

## 7. Claims and AI (Q)
See 07 section 13. Plus: a **document corpus** of synthetic leases, payslips, IDs, bank statements with known ground truth; extraction accuracy and agreement rate reported honestly in the README (with the limits). An **injection corpus** of documents containing instructions; the output must never change shape. **Attestation negatives:** wrong signing address, expired nonce, tampered NRAS token, replayed report: all fail closed. Without an API key the AI tests run against a recorded and clearly labelled mock server; the README states which results are mock.

## 8. Web (W)
See 08 section 11. Additions: network capture asserting no request carries the fragment; an automated check that no decrypted plaintext is written to storage; Lighthouse accessibility pass; mobile viewport screenshots; cross-browser runs (Chromium, WebKit, Firefox) for everything except PRF which is tested where available (spike K5).

## 9. Security checks
Secret scanning on the repo (including history) before any push; dependency audit (`npm audit`, `cargo audit`); license check (no AGPL code imported); the CSP test; a manual checklist derived from the catalogue in 09 where each attack row has an attempted exploitation noted (pass or finding). Findings and fixes are recorded in `SECURITY_NOTES.md`.

## 10. The one-command verification
`./verify.sh` (read-only, no keys needed) for a judge or a machine reader:
1. Prints the deployed contract id, Wasm hash and checks that the account has no access keys (C1).
2. Fetches the published release manifest and compares it to the served app files.
3. For a named demo box, recomputes the receipt chain from chain events and the published receipt details and confirms it matches the contract (A7).
4. Verifies a published Check Receipt offline (Q8).
5. Reads a published deal's events and checks the conservation arithmetic (C6).
6. Prints each claim from 09 with its test id and a pass or fail from the last CI run, with links to transactions.
Output is plain text. Mocks are marked MOCK.

## 11. CI and reproducibility
CI runs X, C (unit and sandbox), S and A with fault injection, the model checker and conformance traces, W with a virtual authenticator, lint and type checks, secret scan, dependency audit. Builds are reproducible (pinned toolchains; the Wasm and web bundle hashes are printed and compared against the release manifest). Coverage reporting for the contract and crypto crates; no coverage threshold is claimed as a safety property.

## 12. Acceptance by milestone
M1 crypto vectors pass in both languages; contract invariants C1 to C12 pass in sandbox. M2 storage S1 to S9 pass with three local nodes; A1 to A9 pass. M3 web W1 to W8 pass; deals D1 to D10 and the model check pass. M4 claims Q1 to Q8 pass (live or labelled mock). M5 verify.sh passes against testnet deployments; README claims all link to tests.
