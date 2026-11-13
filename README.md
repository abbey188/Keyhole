# Keyhole: a private-NFT safe

**A Keyhole safe is an NFT that holds your files.** They are encrypted on your device. You let someone in for a set time, every opening is written into a log nobody can edit, you can end access, and you can hand the whole safe to someone else, which kills every key you gave out. An AI that runs inside attested hardware can read the safe for you, and you can share a *claim* ("income is at least £3,000") instead of the document.

> **Status: working on NEAR testnet, demo configuration, no external audit.** Everything below is backed by a test or a transaction (see [CLAIMS.md](CLAIMS.md), [docs/EVIDENCE.md](docs/EVIDENCE.md), and the judge page). Things not finished are marked `[NOT FINISHED]`; things deliberately left for later are marked `[LATER]`. Do not put real sensitive files in it.

## See the proof in 2 minutes (no keys, no accounts)
1. `git clone … && cd Keyhole && pnpm install`
2. `./scripts/verify.sh` → you should see passing test summaries (Rust protocol and contract, TypeScript packages, services, app), the Wasm hash, and `C1 OK: … has 0 access keys`.
3. `pnpm --filter @keyhole/web dev`, then open **http://localhost:5173/#judge**. You see the deployed contract with a *live* check that it has 0 access keys, every claim with its proof, nine real attacks against the contract that were refused (each with its transaction), and measured numbers.

## Run the whole product yourself (about 5 minutes, testnet only)
The deployed contract's service keys are ours, so the full demo runs against **your own** keyless copy of the contract:
1. `./scripts/testnet-setup.sh` builds the contract, creates funded testnet accounts through the public faucet, deploys, and deletes the contract's access keys. Secrets go to `./.env` (gitignored).
2. `./scripts/dev-services.sh` starts the storage node, the release service and the web app.
3. Open **http://localhost:5173/** (use `localhost`, not an IP: passkeys need it).

For the AI features the local service relays encrypted traffic to NEAR AI; set `NEARAI_API_KEY` in your environment before step 2 (it never reaches the browser).

## Do this, see that
| You do | You see | Proof |
|---|---|---|
| Create with a passkey, make a safe | A safe card ("Safe #1, locked to you") created on the contract | `apps/web/e2e/a1.mjs` |
| Add a PDF | It is encrypted on your device, stored on the node, recorded on chain; you can preview and download it | `a2.mjs` |
| Give access to "Maria" for 2 hours | A link. Open it in another browser: "Opening securely", then watermarked pages with a countdown and no download button | `a3.mjs` |
| Open the Visitors tab | The visit appears, **Verified** against the contract's chain. "Try a doctored copy" shows **Broken** | `a4.mjs` |
| Press End access, then reload the link | "This access has ended" | `a3.mjs` |
| Claims tab: pick the payslip | Facts read on your device, an optional private-model cross-check, your review, then a signed claim you can share *instead of* the payslip | `b4.mjs` |
| Ask tab: "How much is the monthly rent?" | An answer quoting your own page, with the model, the attestation evidence and what that does and does not prove | `b3.mjs` |
| Give access with "Let them ask up to 5 questions"; the recipient asks | Answers only from the shared files; anything else: "This access does not cover that."; you see every question in Visitors | `b6.mjs` |
| Verify page → paste an answer package | Signature, source roots and receipt checked in fixed order; unchecked steps say "not run" | `b6.mjs`, `verify-answer.test.ts` |
| Hand over → paste the new owner's address | Ownership moves, every old link dies, the new owner re-locks with keys you never had | `a6.mjs` |

## The trust model in one table
| Who | Sees your plaintext? | What limits them |
|---|---|---|
| Your device | Yes (the only place by default) | Passkey-derived keys |
| Storage node | No: ciphertext | Every read is verified against an on-chain commitment |
| NEAR contract | No | **Keyless** after launch: nobody can change its rules or move a safe |
| **Release service** | No, but it holds **half** of each shared key and decides when to hand it out | Reads the chain itself, fails closed. **It is a single trusted party in this build.** Threshold release across independent services is `[LATER]` |
| AI model | Only the few pages you choose to ask about, end-to-end encrypted | Attested hardware (see below) |

**Public on chain:** a safe's serial, owner account, grant windows, receipt times and the receipt chain head, handover terms. **Private:** contents, names, file counts, exact sizes, what was viewed page by page, claims until you share them. This is *confidentiality with public accountability*, not anonymity.

## AI trust model: what attestation proves, and what it does not
Private AI here means: the client checks a hardware attestation from NEAR AI Cloud, then sends the needed text **end-to-end encrypted to the key that attestation names**. Only models owned by `nearai` or marked "attested 3p" are ever treated as Private; routed models never receive file content.

*What the checks prove (they really run: `packages/ai`, 18 tamper tests):* the report is fresh (our nonce), the signing key is the one bound into a genuine Intel TDX quote, the quote chains to Intel's root, debug mode is off, the measured workload configuration matches, and the GPU evidence passes NVIDIA's verification service.
*What they do not prove:* that the model's answers are correct; which model weights ran (the quote does not name them); the hardware's current security level (Intel TCB status and revocations are **not checked**, so results read "checks passed, not complete"); that the GPU belongs to the same machine as the CPU quote; or that the operator behaves well outside the enclave. We say "private inference in attested hardware", never "mathematically private". Splitting the work helps: search and pattern-matching run on your device, and only the needed text leaves it.

Claims use fixed wording: grade **B** "machine-read and owner-reviewed", grade **C** "self-declared". A claim is the owner's statement backed by a document, not a certificate. We never call a machine-read claim "verified". Grade A (issuer-signed) and zero-knowledge "Proved" are `[LATER]`.

## What is built
Built and tested: the protocol and contract (boxes as NFTs with blocked transfers, grants, receipt chain, blobs, handover with escrow), storage node, release service, client store, the web app (passkey sign-in, files, give access with a watermarked viewer, visitor log with verification, re-lock, handover, Ask, Claims, Verify, judge page), the attestation client, and an attack lab. Mock components are labelled `MOCK` in code (the mock chain is compared with the real contract on a recorded scenario).

`[NOT FINISHED]`: the AI relay is rate-capped (90 per minute in total, `RS_RELAY_PER_MIN`) but not tied to visit sessions (local demo only); the Verify page does not re-run the attestation or re-match quotes; real-device passkey test (a virtual authenticator is used); scanned-document search (no OCR); audio and video playback (stored, owner-download only); persistent encrypted copy of access links.
`[LATER]`: threshold release, release service in a hardware enclave, zero-knowledge proofs, auditor view, redaction, issuer-signed claims, multi-party rooms.

## Honest limits
A photo of the screen cannot be prevented. A recipient keeps whatever they saw. A stolen passkey is a full compromise. The contract has no upgrade path by design. Testnet only; demo timings. No external audit (see [SECURITY.md](SECURITY.md) for the internal review and its open items).

## Build window and disclosure
The NEAR contract, protocol crate and services were first written on **2026-11-10 and 11** (see the git history); the web app, browser flows, AI integration (attestation client, Ask, Claims), the relay, the judge page, the attack lab and the proof layer were built from **2026-11-13**. We state both so the build window can be judged accurately. Most of the code was written by AI assistants under the owner's direction; libraries and licences are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Design: `docs/spec/`; repository map: [AGENTS.md](AGENTS.md); plan: [docs/PLAN_2026-11-13.md](docs/PLAN_2026-11-13.md).

## Licence
MIT OR Apache-2.0 (see `LICENSE-MIT`, `LICENSE-APACHE`); the owner confirms before publishing `[NOT FINISHED]`.
