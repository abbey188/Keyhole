# Claims and the tests that prove them

A claim is listed only with a test that fails if the claim is false. "Planned" means the test does not exist yet and the claim is not yet made.

| Claim | Proof | Status |
|---|---|---|
| Protocol primitives match published standards | `crates/keyhole-proto` tests: RFC 5869 (HKDF), RFC 7748 (X25519), RFC 8032 (Ed25519), NIST SHA-256 | Tested |
| Rust and TypeScript implementations agree byte for byte | `vectors/keyhole-v1.json` checked by `cargo test -p keyhole-proto --test vectors` and `packages/crypto/test/vectors.test.ts` | Tested |
| A segment ciphertext cannot be moved to another box, item, position, count or epoch | `aead::tests::wrong_key_or_aad_fails`, `AEAD AAD fields are all bound` | Tested |
| Any edit, removal or reordering of receipts changes the chain head | `receipt::tests::chain_detects_any_edit_or_removal`; contract `receipt_chain_recomputes_from_events` | Tested |
| Neither key share alone equals the segment key; shares are per grant | `split::tests` | Tested |
| Boxes never change owner except through a completed deal | `nft_transfer_always_panics`, `nft_transfer_call_always_panics`, `completion_moves_box_money_and_kills_old_access`, `about_me_box_cannot_be_offered` | Tested (mocked runtime) |
| Grants cannot exceed the box ceiling | `ceiling_boundary_accepted_and_over_rejected`, `grant_over_ceiling_rejected` | Tested (mocked runtime) |
| Opening a session needs a valid recipient signature or the named account; forged, stale, replayed or out-of-budget opens fail | `tests.rs` session tests (wrong signer, tampered message, other contract, stale timestamp, duplicate id, budget, revoked, expired, wrong epoch) | Tested (mocked runtime) |
| A completed deal kills all earlier access | `grants_from_before_the_deal_stop_working` | Tested (mocked runtime) |
| A box in a deal is frozen (no new blobs, activation, manifest change, retire, re-wrap, delete) | `tests_deals.rs` `frozen_*` | Tested (mocked runtime) |
| The escrow pays the seller exactly once; a failed payout or refund is credited and claimable, not lost | `completion_moves_box_money_and_kills_old_access`, `failed_payout_is_credited_and_claimable`, `failed_refund_is_credited_to_the_buyer`, `claim_twice_fails` | Tested (mocked runtime) |
| Completion cannot happen before the waiting period; anyone can complete; a stolen-key offer can be cancelled in the window | `complete_before_waiting_period_fails`, `anyone_can_complete_so_neither_party_can_stall`, `offer_from_a_stolen_key_can_be_cancelled_in_the_window` | Tested (mocked runtime) |
| A blob needs a node certificate before it can be used; acknowledgements cannot be replayed across registrations | `tests_blobs.rs` (`certify_*`, `old_acknowledgement_cannot_certify_a_reregistration`) | Tested (mocked runtime) |
| The deployed contract has no access keys (C1) | RPC key list of `keyhole-06728d.testnet` is empty; `tools/testnet/src/launch.ts --check`; launch tx in `docs/EVIDENCE.md` | Tested on testnet |
| No key is released before the receipt is final on-chain (A1) | `services/release/test/release.test.ts` "A1" (finality held; a relayer that lies or returns no event) | Tested (MOCK chain) |
| Revoked, expired, wrong-epoch or exhausted grants get no further key; revoke mid-session stops the next release (A2) | `release.test.ts` "A2", `e2e.test.ts` "A2 end to end" (including node reads with an earlier ticket) | Tested (MOCK chain) |
| Neither key share alone reveals the key (A3) | `release.test.ts` "A3" (chi-squared on shares) and `crates/keyhole-proto` `split::tests` | Tested |
| Forged opens, replays, over-budget opens and a second concurrent session are refused; bad signatures never reach the relayer and back off (A4, A5) | `release.test.ts` "A4/A5" | Tested (MOCK chain) |
| Keys are released only for segments in the grant's scope (A6) | `release.test.ts` "A6" | Tested |
| Open and close extend the on-chain receipt chain; the owner's feed and signed log match it (A7) | `release.test.ts` "A7" | Tested (MOCK chain; real contract chain is tested in Rust) |
| Named-account requesters: the account opens on chain itself, then attaches; a token needs the account's key, a final receipt, and a session key that matches the on-chain commitment | `services/release/test/named.test.ts`; on testnet `tools/testnet/src/smoke-named.ts`, record `deploy/smoke-named-testnet.json` | Tested (mock and testnet) |
| FakeChain behaves like the deployed contract on a 122-call scenario (outcomes and observable state) | `packages/chain/test/conformance.test.ts` against `deploy/conformance-testnet.json` (recorded on testnet) | Tested. Money, gas and long time boundaries are not compared |
| Key releases are rate limited per grant (A8) | `release.test.ts` "A8" | Tested. Per-IP limit exists but is not covered by a test |
| The release service fails closed on RPC loss and never reads its own clock (A9) | `release.test.ts` "A9" (outage; system clock shifted by hours) | Tested |
| A deal's second key half is released only to the buyer after the deal is Completed, and only if it matches the on-chain commitment | `release.test.ts` "deal key release" | Tested (MOCK chain) |
| A storage node accepts leaves only for registered blobs with a valid proof; acks are bound to the registration (S5, S7) | `services/node/test/node.test.ts` | Tested (MOCK chain) |
| A node stops serving a blob the moment the chain says Retired, then erases and attests | `node.test.ts` "retire and erase" | Tested (MOCK chain). Attestation is a signed claim, not proof of physical erasure |
| A node returning modified, misplaced or truncated data is detected and bypassed; reads never return unverified bytes (S8) | `packages/store/test/store.test.ts` "S8" (including a seeded random-fault property test) | Tested |
| With one node down writes and reads continue; with two of three down writes fail closed (S9) | `store.test.ts` "S9" | Tested (in-process nodes). FastFS fallback not built |
| After revoke and re-secure, cached keys open only what was already in hand; old ciphertext is erased and the new one needs new keys (R1, S6) | `services/release/test/e2e.test.ts` "R1/S6" | Tested (MOCK chain) |
| A real session opened through the release service on testnet yields a receipt chain that recomputes from public data to the box's on-chain head | `tools/testnet/src/smoke.ts`, record `deploy/smoke-testnet.json` | Tested on testnet |
| A real sale moves ownership and payment together; key half released only after Completed; earlier grants die; a funded deal can be cancelled and refunded | `tools/testnet/src/smoke-deal.ts`, record `deploy/smoke-deal-testnet.json` | Tested on testnet (DEMO config) |
| Session storage is paid by its user: deleting a grant keeps the stake of every opened session, and a stake too small for a session record is refused at init | contract tests `deleting_a_grant_keeps_the_stake_of_every_opened_session`, `the_session_stake_covers_the_bytes_a_session_and_its_close_use`, `a_stake_too_small_for_a_session_record_is_refused_at_init` | Tested (mocked runtime) |
| A sale offer needs the release service's signed acknowledgement that it holds the key half | contract tests `offer_without_a_valid_acknowledgement_is_rejected` and three more; refused on testnet in `smoke-deal.ts` | Tested (mock and testnet) |
| One stale "missing" answer from an RPC does not make the node erase live data | `services/node/test/node.test.ts` "S5" | Tested |
| A captured owner request cannot be replayed; bad opens from one caller do not lock a grant for others; a failed close can be retried | `services/release/test/release.test.ts` "review fixes" | Tested (MOCK chain) |

Limits of the current evidence: contract tests run in a mocked runtime, not on a network; service tests run against `FakeChain`, a labelled MOCK that re-implements the contract's rules (it is not yet checked against the real contract in a sandbox); in-process nodes stand in for network nodes; gas and timing are unmeasured; the web app does not exist yet. The release-service formats (scope hash, deal S2 commitment and ack, auth bodies, log chain) are now in the Rust crate (`release.rs`) and pinned by the `release` section of `vectors/keyhole-v1.json`, checked by `packages/crypto/test/vectors.test.ts`.
| B6 | Ask grants: budget committed in the grant, sealed question log, out-of-scope refusal | `services/release/test/ask.test.ts`, `apps/web/test/ask-access.test.ts`, `apps/web/e2e/b6.mjs` |
| VERIFY-ANS | Answer package checks (signature, source roots, receipt) in fixed order | `apps/web/test/verify-answer.test.ts`, `apps/web/e2e/b6.mjs` |
| B5 | Redaction with a self-test before saving | `apps/web/test/redact.test.ts`, `apps/web/e2e/b5.mjs` |
