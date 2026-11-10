# Keyhole (working name)

Boxes for sensitive files on NEAR. The goal: you keep a box, give someone access for a set time, see every opening, take the access back, and, if you want, sell the box, with the payment and the ownership moving together. **Today this works at the protocol and contract level, driven by scripts and tests; there is no user interface.**

> **Status (v0.2-testnet): in development; there is no app, and nothing is hosted.** What exists and passes today: the protocol crate, a TypeScript crypto package that matches it byte for byte, the NEAR contract (boxes, access, receipts, blobs, sales with escrow) with unit tests, and the storage node, client store and release service. The contract is **deployed on NEAR testnet** (demo configuration, no access keys) and has been exercised by real-chain runs (a session and receipt chain, a sale with escrow, a named-account requester) in which the storage node and release service ran as in-process components of the test scripts, not as hosted services; the mock chain used by the service tests reproduces the real contract's behaviour on a recorded scenario. What does not exist yet: hosted services, the web app (so no passkey sign-in, upload screen or viewer), claims and private-AI features, and the money module. Testnet only, a demo configuration, no external audit. See `docs/EVIDENCE.md` and `CLAIMS.md` for exactly what is proven.

## Try it (needs Rust with wasm32 target, Node 22, pnpm)
Deployed contract, code hash and every transaction: `docs/EVIDENCE.md` and `deploy/`.
1. `./scripts/verify.sh`
2. You should see passing test summaries for the protocol crate, the contract, the TypeScript crypto package, and the chain client, storage node, client store and release service, then the contract Wasm hash.

## What it is for
Ask for proof, not files. A landlord, lender or buyer sees an answer or a time-limited view, and every use leaves a record nobody, including us, can edit.

## Privacy and security, defined
Security: outsiders cannot read your files (browser-side encryption, keys only you hold, no server holds a whole key). Privacy: others learn only what you allow, for as long as you allow. **Not anonymity:** box ownership, grant windows, receipt timing and sale terms are public on-chain.

## Why a chain
Five promises need a referee that is not us: receipts nobody can edit, access windows nobody can quietly extend, ownership that changes only through a completed sale, payment and ownership that move together, and proofs a third party can check. Each has a test (see `CLAIMS.md`).

## Limits
Photos of a screen cannot be prevented; a recipient keeps what they saw; a stolen passkey is full compromise except for delayed sales; the release service is a trusted party in the first version; the contract has no upgrade path; testnet only; no external audit.

## Layout and design
`docs/spec/` holds the full technical design. `AGENTS.md` is the repository map.

## Licence
MIT OR Apache-2.0 (provisional, to be confirmed by the owner). Third-party notices: `THIRD_PARTY_NOTICES.md` (to be generated).
