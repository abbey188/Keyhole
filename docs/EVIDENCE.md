# Evidence log

Claims with proof. Entries are added only when they exist; each says what it shows and what it does not show.

## Tests that exist now
| What | Command | Shows | Does not show |
|---|---|---|---|
| Protocol crate | `cargo test -p keyhole-proto` | RFC 5869/7748/8032 and NIST vectors, property tests, Merkle proofs, padding, split keys, sealed boxes, receipt chain tamper evidence | Anything about NEAR itself |
| Contract unit tests | `cargo test -p keyhole-contract` | Contract rules in a mocked runtime: owner-only actions, grant ceilings, session checks and signatures, receipt chain recomputation, blob lifecycle, deal state machine, escrow conservation, frozen boxes, payout failure fallback | Behaviour on a real network, gas costs, cross-contract promise timing |
| TypeScript crypto | `pnpm --filter @keyhole/crypto test` | The browser/service implementation reproduces the Rust vectors byte for byte | The web app itself |

## On-chain evidence
None yet. This section will list the deployed contract id, its code hash, and transaction hashes for a full run (box, grant, receipt, revoke, deal, completion), each with a link.
