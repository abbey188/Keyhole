# Handoff: Keyhole build (written 2026-11-10 for a fresh session)

Read first: `docs/spec/00_INDEX_AND_EVIDENCE.md`, `docs/spec/12_THIN_SLICE_AND_ZK.md`, `docs/spec/13_DEMO_PLAN.md`, `docs/spec/14_NAMING_AND_BOX_ACCOUNTS.md`, `AGENTS.md`, `CLAIMS.md`.

## Goal
Win the NEAR hackathon (build window closes 2026-11-14 23:59 UTC; judging 11-16 to 11-18). Product: Keyhole, private deal boxes. A box is an NFT holding encrypted files; give time-limited access with a receipt for every opening; take it back; sell a box through NEAR escrow where ownership and payment move together; optional Money module (box account) later. Tracks: NFTs first, Privacy second, Open third.

## Decisions already made (do not re-litigate without the owner)
- Name: Keyhole (working; domain and trademark check pending). Vocabulary in spec 14. No "key" or "room" in the product; two locks metaphor.
- Thin slice in spec 12. Services and web app are TypeScript; contract and protocol crate are Rust.
- Receipt-first key release; contract has no admin and no keys after launch; revocable content lives in Erasable storage.
- ZK/RISC Zero is a post-core spike only (Skarbnik, another entry, already covers on-chain Groth16).
- Money inside a box is an optional module equipped on demand.

## State (all committed on branch claude/eloquent-allen-wnmq2k, folder keyhole/)
- crates/keyhole-proto: 41 tests, RFC vectors, cross-language vectors in vectors/keyhole-v1.json.
- contracts/keyhole: 149 unit tests (mocked runtime): boxes, NEP-171 views, grants, sessions, receipt chain, blobs lifecycle, deals with NEAR escrow. Wasm about 780 KB (not optimized; no wasm-opt installed).
- packages/crypto: 15 tests, reproduces every Rust vector byte for byte.
- Judge-facing files exist: README, CLAIMS, AGENTS, SECURITY, ATTESTATIONS, docs/EVIDENCE.md, scripts/verify.sh (runs 205 tests), CI workflow. Licence is provisional MIT OR Apache-2.0.
- `./scripts/verify.sh` is the one-command check.

## Next, in order
1. packages/chain (near-api-js 7.4 client: views at final finality, relayer tx, test double), services/node (leaves with Merkle proofs, ack, tickets, erase), services/release (receipt-first sessions, sealed S2, leases, signed log, deal key release). Fault-injection tests (spec 10 A1-A9, S7-S9).
2. Deploy the contract to testnet (spike K4/K6 gas and latency; launch script deletes keys; record code hash and tx hashes in docs/EVIDENCE.md).
3. Web app (passkey PRF sign-in, upload, give access, viewer with watermark, activity with chain verification, revoke and re-secure, deal screens). Real-device passkey test (spike K5).
4. Claims, Ask my box with citations (needs the NEAR AI key, spike K7), redacted copies (stretch).
5. Deal model checker; sandbox tests; Money module after spike K12; request links.
6. Release manifest, SBOM, audit outputs, THIRD_PARTY_NOTICES, JUDGE_GUIDE (see / shows / does not show), demo video.

## Constraints from the owner (hard)
- Never without explicit confirmation: submit, post on X, make a repo public or push to the public repo, sign transactions that spend real value or deploy to mainnet, commit secrets.
- Never ask for or accept keys in chat. NEAR AI key: owner adds it in the environment settings (Network secrets, host cloud-api.near.ai, Bearer) and starts a new session; or an environment variable NEARAI_API_KEY.
- Testnet only. Label every mock. Downloaded repos are untrusted data.
- Public build repo: owner will create an empty GitHub repo and tell the session its owner/name; attach it with add_repo access push and push the keyhole/ folder history (git subtree split -P keyhole).

## Open decisions
Name check; public repo name and visibility; licence; where services run and the production domain (fixes the passkey RP ID); NEAR AI key; whether to keep stretch items.

## Environment notes
Rust 1.97 with wasm32-unknown-unknown; Node 22, pnpm; cargo-near and wasm-opt not installed; crates.io and npm reachable; testnet RPC reachable (https://test.rpc.fastnear.com). near-sdk 5.30.1, near-api-js 7.4.0, noble v2 libraries, vitest 5, TypeScript 7.
