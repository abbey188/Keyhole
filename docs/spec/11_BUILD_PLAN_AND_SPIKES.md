# 11 Build plan, spikes and open decisions

Ordering is by risk and dependency, not by calendar. The window closes 2026-11-14 23:59 UTC; nothing below is a promise about what fits, only the order in which uncertainty is removed and layers become real.

## 1. Repository layout (public submission repo, separate from this research repo; creating it needs the owner's explicit OK)
```
vault/
  README.md              machine-readable: do X, see Y; links claims to tests and transactions
  CLAIMS.md              each claim, its test id, its limits (from 09 section 6)
  SECURITY_NOTES.md      findings and fixes from the checks in 10 section 9
  AGENTS.md, llms.txt    pointers for machine readers
  LICENSE                permissive licence chosen by the owner
  contracts/vault/       Rust, near-sdk 5.x; tests/ (sandbox), model/ (state-machine explorer)
  crates/vault-proto/    shared Rust: constants, hashing, Merkle, formats, vector generator
  packages/crypto/       TypeScript: noble-based implementation, vector tests
  packages/client/       TypeScript: chain, store, rs, ai, docs modules
  apps/web/              owner app and recipient page
  services/release/      Rust (axum): release service, relayer, AI relay
  services/node/         Rust (axum): storage node
  tools/                 verify.sh, vault-verify-app, synthetic document generator, demo reset
  docs/                  this spec set (copied in) and diagrams
```
Pre-existing work and licences: only code written in the window counts for judging and any earlier code must be disclosed (hackathon rules as recorded in `context/official/RULES_AND_LIMITS`). We copy no code from FastNEAR, Papermark (AGPL), Tatchi (licence unconfirmed), or Send; we read them for ideas only and say so. Libraries we use are permissively licensed and listed in the README.

## 2. Technology choices and reasons
| Area | Choice | Why |
|---|---|---|
| Contract | Rust, near-sdk 5.x, `cargo near`, sandbox tests | Toolchain present locally [TESTED compile earlier]; standard |
| Shared protocol code | One Rust crate compiled natively and to WASM for browser tests? Browser uses TypeScript instead | One source of truth for formats and vectors; cross-checked by vectors |
| Node and RS | Rust (axum) | Shares `vault-proto`; small static binaries; easy to run N copies |
| Client | TypeScript, Vite, noble libs, pdf.js, tesseract.js | Audited small crypto libs; no native deps |
| Chain access | near-api-js v7 or near-kit | Maintained; NEP-366 and NEP-413 helpers |
| E2E tests | Playwright with virtual authenticator | Already used for the PRF test |
| Hosting (decision needed) | Small container host for RS, relay, nodes; static host for the app | See decisions |

## 3. Spikes (each removes one unverified item; pass criteria and fallback)
| ID | Question (maps to U-item in 00) | Method | Pass | Fallback |
|---|---|---|---|---|
| K1 | Multi-part FastFS (U3): upload 1, 2, 32 parts, reassemble | Extend `findings/fastfs_test` to Partial; fetch from fastfs.io | Byte-identical, correct part counting | Single-part (≤1.4 MB) items plus node storage |
| K2 | FastFS indexes calls to a receiver that has contract code and a `__fastdata_fastfs` method; hashing gas (U2) | Deploy a tiny contract with the method; send parts; fetch; read gas used | Indexed and served; gas near estimate | Use a plain-account receiver (tested) for Fast mode and drop Verified mode |
| K3 | `p256_verify` available on testnet (U1) | Call from a test contract with a known signature | Returns true for valid | Drop the passkey-on-chain stretch |
| K4 | `ed25519_verify` gas; `certify_blob` and `open_session` cost (U6) | Measure in sandbox then testnet | Within planned budgets | Reduce T or batch |
| K5 | PRF on real devices and synced passkeys (U5) | Real iPhone, Android, Windows Hello, Mac Safari; two-device sync test | PRF works and is stable across synced devices on at least two platforms | Passphrase path as primary on the failing platforms, labelled |
| K6 | Latency from `open_session` submit to `final` (U7) | Testnet runs, 50 samples | Median within a few seconds | Show a progress state; optimistic UI never releases keys |
| K7 | NEAR AI: key obtained; E2EE chat round trip; attestation verification in a browser; image input under E2EE; rate limits (U4, U4b, U8) | Use the near-ai-cloud references and the verifier repo | Round trip decrypts; attestation verified client-side; limits known | Text-only OCR path; pinned-key fallback; labelled mock |
| K8 | Browser throughput: render, OCR, encrypt, Merkle (S7 in 08) | 20-page PDF benchmark across devices | Under a few seconds without OCR; OCR time reported | Reduce DPI, run OCR only on claim extraction |
| K9 | Node recovery from FastFS | Delete a node's data; rebuild; verify | Root matches | Node-to-node copy |
| K10 | FT escrow on a test token with failure injection | Mock token contract; callbacks | C6 passes under failure injection | NEAR-only escrow |
| K12 | Box account creation from a contract with a by-hash global contract reference; keyless; callable only by the collection; cost (see 14) | Sandbox and testnet batch | Account created, locked, authorized only by the collection | Tiny regular contract instead of a global one |
| K11 | Sponsored onboarding with implicit accounts and NEP-366 | Create account, delegate actions through the relayer | Account created and acts with no user NEAR | Relayer sends small funding per user |
Spikes run before dependent implementation. A failed spike changes the spec text in the affected file, not silently the code.

## 4. Build order (milestones with exit tests from 10 section 12)
**M0 Foundations.** Fix the domain (RP ID), the repo, licences and secrets handling; run K3 K4 K5 K11 early because they gate the passkey and contract designs. Exit: spikes recorded.
**M1 Protocol core.** `vault-proto` and the TypeScript `crypto` package with the cross-language vectors; the contract with boxes, blobs (Erasable), grants, sessions and receipts; invariants C1 to C12 where applicable; no admin; launch script that deletes keys. Exit: X and C tests.
**M2 Storage and release.** Storage node (three local instances), certificates, retire and erasure; release service with receipt-first; client store and rs modules; fault injection. Exit: S and A tests, R1.
**M3 Owner and recipient experience.** Passkey sign-in, upload pipeline, box screens, Give access sheet, recipient viewer with watermark, activity with chain verification, revoke and re-secure. Exit: W tests and a recorded end-to-end run.
**M4 Deals.** Deal contract paths, key delivery, buyer re-secure flow, escrow in NEAR then FT; model checker and conformance. Exit: D tests, model check table.
**M5 Claims and AI.** Extraction pipeline with local OCR, rule cross-check, owner review, claims as items, claims-mode grants and viewer; live model if K7 passes else labelled mock. Exit: Q tests.
**M6 Durable and Permanent modes, Verified publication.** FastFS paths per 03 section 8, if K1 K2 K9 pass. Exit: S13 S14.
**M7 Proof and polish.** verify.sh, README for machines, CLAIMS.md, security checks, demo reset, accessibility, the release manifest, optional private-mode steps 1 to 3 (per-box keys, sponsored gas, commitments already in), optional threshold RS design doc.
**M8 Submission (owner confirms each externally visible step).** Public repo creation and push, demo video, the X post, and the submission itself each require the owner's explicit confirmation; the build window rules (public repo, licence, disclosure) are met by then.

## 5. Services and operations (minimal)
Three processes: node (x3), release service with relayer and AI relay, static web host. Configuration through environment variables only; secrets (relayer key, RS signing key, NEAR AI key) are never committed and are entered through the platform's secret store; the NEAR AI key is requested through the secure credential flow, never pasted in chat. Logging excludes tokens, links and any secret; access logs keep a hash of the IP truncated for abuse control with a short retention. Health endpoints; a runbook line per failure mode in 03 section 12.

## 6. Demo and docs deliverables
- **Demo (about 3 minutes):** two browsers side by side (owner and recipient or buyer), synthetic flat-sale papers, claims shown, give access, revoke, deal with a short labelled waiting period, receipts and proof drawer, honest-limits slide. A fallback recording exists.
- **README:** what it is in one paragraph, the privacy and security definition from 09 section 5, do-X-see-Y steps with links, how to run locally and against testnet, the claims table with tests, limits, licences, what is mocked.
- **CLAIMS.md and SECURITY_NOTES.md** as above. `AGENTS.md` and `llms.txt` describe the repo for machine readers.

## 7. Decisions needed from the owner (nothing proceeds on these without an answer)
1. Project name (working title Vault).
2. OK to create the public submission repo and to push to it later.
3. NEAR AI Cloud key (via cloud.near.ai or the nearbuilders.org route); entered only through the secure credential form.
4. Where the services run (container host) and the production domain (fixes the passkey RP ID forever).
5. Licence for the repo.
6. Whether to include the optional dispute path and the private-mode steps in the first build.
7. Demo scenes: default is a flat sale (claims, access, deal) plus a short rental application.
8. Whether a second, separate submission is wanted (limit two disclosed projects).
9. Real-device passkey testing: who tests on which phone.
10. Stablecoin on testnet: use a real test stablecoin if one is confirmed, otherwise a labelled mock token.

## 8. What would change the plan
K5 failing on major platforms would make the passphrase path primary and weaken the story; K7 failing leaves claims as a labelled mock; K2 failing removes Verified mode; a contract bug found late forces a new deployment id and a re-run of M1 tests. These are known and stated rather than hidden.
