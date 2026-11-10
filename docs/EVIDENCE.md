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

## On-chain evidence (NEAR testnet, recorded 2026-11-10)
Everything below ran against a real deployment; raw records are in `deploy/` (`testnet.json`, `smoke-testnet.json`, `smoke-deal-testnet.json`). The configuration is a labelled **DEMO** configuration (15 s sale waiting period, 1 h retention and grace, N=1 storage node, T=1) and the release service and node ran in-process in the test script, not as deployed services.

### Deployment (current: v2)
| | |
|---|---|
| Contract account | [`keyhole-8ee967.testnet`](https://explorer.testnet.near.org/accounts/keyhole-8ee967.testnet) |
| Wasm (wasm-opt output, 359,358 bytes) sha256 | `59d0402a8e787b5df44fb15d25f9adfa10b69d669492779fb16b4deb7ec5b6e2` |
| Source commit and reproduction | `277ae3474fba14da3956b4cc35d8788cdc4146d2`; building that commit with `./scripts/build-wasm.sh` reproduces this sha256 exactly (checked 2026-11-10 in a clean worktree). A later checkout gives a different hash because the protocol crate gained unused code. |
| NEAR code hash (base58, read from chain) | `73bTrdrc22BP4xrDwWoT3h92ZKKsHULn758Y12xCGPzy` (matches the sha256 above) |
| Deploy + `new(config)` in ONE transaction | [3PhHVXaGkR…](https://explorer.testnet.near.org/transactions/3PhHVXaGkR9Zbrsjda7w5bxcRqcSX3wZ1qyz5gCRBavZ) (28.1 Tgas, 3958 ms) |
| Launch: delete every access key | [R67wmr4SCz…](https://explorer.testnet.near.org/transactions/R67wmr4SCzw1iU84wPv2kXF5nqhyruLPiJT8439duQ7) (1 key deleted) |
| **C1** access key list of the contract account | empty (RPC `view_access_key_list` at final); re-check any time with `pnpm --filter @keyhole/testnet-tools exec tsx src/launch.ts --check` |

v1 (`deploy/testnet-v1-superseded.json`) is superseded. It was built without `--cfg near`, so every `require!` failure surfaced as a bare `unreachable` trap with no message (near-sdk-env only emits its `panic_utf8` host call under that cfg). The flag is now set in `.cargo/config.toml`; the v2 Wasm imports `panic_utf8` and the real messages appear in the smoke run. v1 still exists on testnet and is keyless; it is not used.

### Smoke test with real components (`tools/testnet/src/smoke.ts`: 19 checks passed)
`NearWriter` and `RpcReader` against the contract, the real `StorageNode` (reading chain state at final) and the real `ReleaseService` (relaying through the real chain): box, two blobs (register, node ack, certify, activate), manifest commit, a bearer grant opened with a real recipient signature, a scoped grant opened through the release service (token only after the receipt was final: about 4.9 s from request to token), sealed key release and recombination, a verified leaf read with a release-service ticket, close with a signed log root, **receipt chain recomputed from public data equals the box's on-chain head**, revoke (release service and node both refuse afterwards), three rejected opens (forged signature, revoked grant, replayed session id) with the contract's own messages, retire, erase attestation and removal of the record.

### A real sale (`tools/testnet/src/smoke-deal.ts`: 15 checks passed, testnet NEAR only)
Offer; seller leaves the second key half with the release service and gets a signed acknowledgement; stranger grants refused while the box is in a deal; buyer funds 0.1 NEAR; completion before the waiting period refused; release service refuses the buyer's key half before Completed; after Completed ownership moved, epoch bumped, seller received the price from escrow, the contract kept no escrow, a grant from before the sale no longer opens, the previous owner is refused; buyer received the key half and rebuilt the box key matching `bmk_commit`; a second deal was funded, cancelled and refunded.

### Gas and time to final (spikes K4 and K6)
Gas is gas burnt by the transaction and all its receipts (from the final outcome); rejected calls still burn gas, shown for the relayer's cost. Time is from submit until the transaction was FINAL, measured from this container to the public RPC `test.rpc.fastnear.com`. 45 successful transactions across the three smoke runs: median 4.0 s, 90th percentile 4.8 s, minimum 3.3 s, maximum 10.8 s (one slow outlier). Largest call: `complete_deal` (payout promise and callback) at about 6 Tgas, far below the 300 Tgas transaction limit.
| Method | Result | Calls | Gas burnt (Tgas) | Submit to final (ms, median) | Example transaction |
|---|---|---|---|---|---|
| `activate_blob` | ok | 5 | 2.6 to 2.6 | 3730 | [5V115DuvDX…](https://explorer.testnet.near.org/transactions/5V115DuvDXPc8trhQscTjv39R6zbvHH9vqxCNbD4tXMo) |
| `attest_erasure` | ok | 1 | 4.0 | 4130 | [HCnXFy3yHA…](https://explorer.testnet.near.org/transactions/HCnXFy3yHAHmbBhKBmPdT6o1bQCkEWYZmSJ5DndrTjhX) |
| `cancel_deal` | ok | 1 | 5.7 | 4962 | [8LhWbpS9PR…](https://explorer.testnet.near.org/transactions/8LhWbpS9PRPSr4jHtmmDire6DQfFUybrFFNA6nudSWWv) |
| `certify_blob` | ok | 7 | 2.8 to 2.8 | 3645 | [Eygmiz9f16…](https://explorer.testnet.near.org/transactions/Eygmiz9f16bU2apr8hnLfjpciAoMLTQCnpiQHTYdAFKo) |
| `close_session` | ok | 1 | 3.2 | 3761 | [BKSiYPbciQ…](https://explorer.testnet.near.org/transactions/BKSiYPbciQQbT3fv9MkL1QXpJQNSzcxuyvdEZNNLwK7S) |
| `commit_manifest` | ok | 3 | 2.6 | 3972 | [9hunhmRDXe…](https://explorer.testnet.near.org/transactions/9hunhmRDXekhRTUxwsQbmm8tRj8KfuMh3A8WBXLEPDJR) |
| `complete_deal` | ok | 1 | 6.3 | 5332 | [292tzBw8WM…](https://explorer.testnet.near.org/transactions/292tzBw8WMfuVF5FUTGLvBwskp2hZ3R4kJXoQcKGM26C) |
| `complete_deal` | rejected (expected) | 1 | 2.1 | 3388 | [2ZFBf3skN1…](https://explorer.testnet.near.org/transactions/2ZFBf3skN1zKvF3bQiTYbZRaok45QiHzsE4ar9B6hEqD) |
| `create_box` | ok | 4 | 3.6 to 3.6 | 4361 | [HhJ9iJKSJG…](https://explorer.testnet.near.org/transactions/HhJ9iJKSJGvyi9R8jMpB3AeST69iR6nWbNSWhJTzLBUd) |
| `create_deal` | ok | 2 | 3.8 | 3943 | [Gf3puv7EuC…](https://explorer.testnet.near.org/transactions/Gf3puv7EuCDHGSpDUxHsxD5Le98oZJnu8kpMNPMyTUwp) |
| `create_grant` | ok | 4 | 3.6 to 3.6 | 4287 | [FruVE9n8vZ…](https://explorer.testnet.near.org/transactions/FruVE9n8vZZcW8m2VboZcQEp8oLF6vYJuHwYdEBneq3W) |
| `create_grant` | rejected (expected) | 2 | 2.5 to 2.6 | 3603 | [Gm9Kbuv5pj…](https://explorer.testnet.near.org/transactions/Gm9Kbuv5pjjhUR6VfDGBMa1rpwbTbhs5oQBmKyZutBFP) |
| `fund_deal` | ok | 2 | 2.5 | 3784 | [J56CiBhTmq…](https://explorer.testnet.near.org/transactions/J56CiBhTmqdWSKCnnxUqQiqgG1mZW6Gx9QZjMSfQwLbz) |
| `open_session` | ok | 4 | 3.2 to 3.4 | 3918 | [2chbQiJJ5Y…](https://explorer.testnet.near.org/transactions/2chbQiJJ5Yb7xaQYzwBEiFu9X7YUc5jgqovpijuQ7zDN) |
| `open_session` | rejected (expected) | 4 | 2.1 to 2.5 | 4083 | [EpdSWjUUvc…](https://explorer.testnet.near.org/transactions/EpdSWjUUvcdU31P8s4XcD5YZuUjkK59ZVbyJKeZfZooW) |
| `register_blob` | ok | 7 | 3.6 to 3.6 | 4283 | [c5tFGTPtCx…](https://explorer.testnet.near.org/transactions/c5tFGTPtCxDqYRRzxhibdfebwoBgVK3XphEiG63fm2m) |
| `retire_blob` | ok | 1 | 4.3 | 3614 | [FsXv2gfvP9…](https://explorer.testnet.near.org/transactions/FsXv2gfvP9Mtjmrb58Pk232Eb6KAxpW2qkGfqbSq6xw8) |
| `revoke_grant` | ok | 2 | 2.6 | 3942 | [4zjfJNvGFp…](https://explorer.testnet.near.org/transactions/4zjfJNvGFpfhfDD8ESojcBDuwWbZ1t7yXi1pEAmWqSYu) |

### A named-account requester on testnet (`tools/testnet/src/smoke-named.ts`: 9 checks passed)
The named account sent `open_session` itself, then attached the session to the release service, which read the receipt event for that transaction from the real RPC (`EXPERIMENTAL_tx_status`) and recomputed the commitment. Refused: a session key that is not the one in the receipt; a key that does not control the account. Accepted: the real key; the account recombined the segment key; the receipt chain recomputed with the account digest equals the on-chain head; a second attach was refused; revoke stopped further keys. Record: `deploy/smoke-named-testnet.json`.

### FakeChain against the real contract (`deploy/conformance-testnet.json`, `packages/chain/src/conformance.ts`)
One scenario of 118 contract calls (40 succeed, the rest are rejections) ran against the deployed contract (502 s) and recorded, for every call, success or the contract's exact panic message plus a snapshot of observable state (owner, epoch, counters, blob and deal states). `packages/chain/test/conformance.test.ts` runs the same scenario against the MOCK and requires an identical trace, call by call. Result: **no divergence in outcomes or state across the scenario.** The comparison is sensitive (altering one golden outcome, dropping the grant-ceiling rule, or ignoring the waiting period each make it fail). Before the comparison the mock lacked the deal methods and a transaction-events lookup; both were added. Not modelled by the mock and not compared: money and balances, gas, storage deposits, block-time boundaries that need waiting, the `claim` payout-failure paths, `delete_*` retention paths.

### Services as real processes
`services/release` and `services/node` were started with `pnpm start` equivalents (`tsx src/main.ts`) from environment variables against the deployed contract: each checked at boot that the contract lists its public key at its index, and answered `/v1/pubkeys`, `/v1/pubkey` and `/v1/health`. Not a hosted deployment.

### What the real runs found that the tests had not
1. **Panics carried no message** in the first deployment (build flag, see above). Fixed and covered by the smoke test, which checks the contract's own messages.
2. **The real RPC answers an unknown access key as a normal result with an `error` string**, not a JSON-RPC error. The reader treated it as an outage (fail closed, but an authentication failure surfaced as 503). Fixed with tests that use the real shapes.
3. `cargo test --workspace` failed (and would have failed in CI) because another crate turns on serde_json's `preserve_order`, changing key order in the vectors text; the comparison now parses JSON.
4. The `wasm32` target was not installed in this container, so `verify.sh` had never printed a Wasm hash; the build script now installs nothing silently and `verify.sh` prints the hash of the optimized Wasm.

### NEAR AI Cloud (check made 2026-11-10)
`GET https://cloud-api.near.ai/v1/models` returned HTTP 200 with 63 models (text and image inputs; Anthropic, and other providers' models). No `NEARAI_API_KEY` was present in the environment, and the listing may not require one, so **this shows the endpoint is reachable from here, not that a key works**. Nothing was sent that would use one.

What the on-chain runs do not show: methods not exercised on chain (`delete_grant`, `delete_box`, `delete_deal`, `set_wrapped_bmk`, `extend_blob`, `claim_fee`, `abandon_blob`, `expire_blob`, `expire_deal`, `finalize_retired`, `claim`, payout and refund failure paths; the Rust unit tests cover their logic); behaviour under load; larger blobs (the test blobs are 64 to 128 KiB); a deployed, separately hosted node and release service.
