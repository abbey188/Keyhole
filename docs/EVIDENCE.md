# Evidence log

Claims with proof. Entries are added only when they exist; each says what it shows and what it does not show.

## Tests that exist now
| What | Command | Shows | Does not show |
|---|---|---|---|
| Protocol crate | `cargo test -p keyhole-proto` | RFC 5869/7748/8032 and NIST vectors, property tests, Merkle proofs, padding, split keys, sealed boxes, receipt chain tamper evidence | Anything about NEAR itself |
| Contract unit tests | `cargo test -p keyhole-contract` | Contract rules in a mocked runtime: owner-only actions, grant ceilings, session checks and signatures, receipt chain recomputation, blob lifecycle, deal state machine, escrow conservation, frozen boxes, payout failure fallback | Behaviour on a real network, gas costs, cross-contract promise timing |
| TypeScript crypto | `pnpm --filter @keyhole/crypto test` | The browser/service implementation reproduces the Rust vectors byte for byte | The web app itself |
| Chain client | `pnpm --filter @keyhole/chain test` | Final-only JSON-RPC reads fail closed on any error; event parsing; **MOCK** `FakeChain` applies the contract's rules with held finality, outages and a controllable clock | That `FakeChain` equals the real contract (sandbox conformance is step 2); `NearWriter` is not exercised |
| Storage node | `pnpm --filter @keyhole/node test` | Leaf admission rules, root bound to blob id, acks bound to registration, ticketed reads re-checked against the chain, erase and attest, HTTP front | Physical erasure; behaviour over a real network |
| Client store | `pnpm --filter @keyhole/store test` | Verified reads, bypass of corrupting, truncating, misplacing nodes (seeded random faults), fail-closed writes with too few acks | FastFS fallback (not built) |
| Release service | `pnpm --filter @keyhole/release test` | A1 to A9, owner and deal authentication, scope hash binding, an end-to-end loop (encrypt, store on three nodes, share, read, decrypt, revoke, re-secure and erase) | A real relayer, real latency, load or soak runs |

## On-chain evidence
None yet. This section will list the deployed contract id, its code hash, and transaction hashes for a full run (box, grant, receipt, revoke, deal, completion), each with a link.
