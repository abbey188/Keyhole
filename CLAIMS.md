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
| The deployed contract has no access keys | RPC key list is empty | Planned |
| No key is released before the receipt is final on-chain | Release service test with delayed finality | Planned |
| Revoked, expired or wrong-epoch grants get no further key from the release service | Release service tests | Planned |
| Erased data is unreadable after re-key | Storage and re-key tests | Planned |

Limits of the current evidence: contract tests run in a mocked runtime, not on a network; gas and timing are unmeasured; no service or web app exists yet.
