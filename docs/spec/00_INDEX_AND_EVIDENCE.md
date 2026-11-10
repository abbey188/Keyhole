# Keyhole (working name; earlier drafts say Vault): technical specification set, 2026-11-10

Scope: the whole system, built to the depth needed to implement without further design decisions. Nothing here is code. Sections are tagged by evidence so nobody mistakes a plan for a result.

## How to read the tags
| Tag | Meaning |
|---|---|
| [TESTED] | We ran it on NEAR testnet or in a local browser and have the result in `context/findings/` |
| [CODE] | Read in the actual source of a repo (shallow clone, not run) |
| [DOCS] | Stated in official documentation or the Walrus paper; not run by us |
| [DESIGN] | Our design; nothing like it has been run |
| [UNVERIFIED] | A fact or capability we depend on but have not confirmed; each has a spike in 11_BUILD_PLAN |

## Files
| File | Contents |
|---|---|
| 01_ARCHITECTURE | Actors, components, trust boundaries, data flows, naming |
| 02_CRYPTO_AND_KEYS | Key hierarchy, passkey derivation, AEAD, chunking, Merkle, split keys, page keys, wire formats |
| 03_STORAGE_VAULT_STORE | Storage protocol, blob state machine, certificates, modes, FastFS integration, node API, Walrus comparison |
| 04_CONTRACT | Box contract: data model, every method, events, invariants, storage and gas |
| 05_ACCESS_SESSIONS_RECEIPTS | Grants, sessions, receipt-first release, hash chain, release service, threshold upgrade |
| 06_DEALS_HANDOVER_ESCROW | Fair-exchange problem, deal state machine, key delivery, stablecoin escrow, model checking |
| 07_CLAIMS_AND_PRIVATE_AI | Claims, extraction pipeline, evidence grades, NEAR AI integration, Ask my box |
| 08_WEB_APP_AND_VIEWER | Client architecture, screens, viewer, request links, app integrity |
| 09_THREAT_MODEL_AND_LIMITS | Adversaries, attacks, mitigations, residual risk, what we do not claim |
| 10_TEST_AND_VERIFICATION | Test strategy, invariants with IDs, vectors, chaos, model checker |
| 11_BUILD_PLAN_AND_SPIKES | Repo layout, spikes with pass criteria, milestones, open decisions |
| 14_NAMING_AND_BOX_ACCOUNTS | Keyhole naming, public vocabulary, the box NFT with a controlled box account |
| 13_DEMO_PLAN | The three-minute demo script and priorities |
| 12_THIN_SLICE_AND_ZK | The locked thin slice, cut line, drop order; zero-knowledge and RISC Zero findings and decision |

## Verified facts the spec stands on
| Fact | Tag | Source |
|---|---|---|
| FastFS stores files in transaction args, method `__fastdata_fastfs`; works with a receiver that has no contract; served at `https://{predecessor}.fastfs.io/{receiver}/{path}` | [TESTED] | findings/fastfs_test |
| 1 KB to 1.4 MB uploads byte-identical, cost about 0.0005 NEAR per MB; 1.6 MB rejected by the 1.5 MiB tx limit | [TESTED] | findings/fastfs_test |
| FastFS has two Borsh forms; Partial parts up to 1 MiB, offset aligned to 1 MiB, file up to 32 MiB, nonce 1..i32::MAX, path 1024 B, mime 256 B | [CODE] | fastdata-indexer `fastfs.rs` |
| FastFS server returns a multi-part file only when every part with the same nonce is present; exposes tx hash, block height, timestamp headers; ETag = receipt_id-nonce; CORS open | [CODE] | fastfs-server `main.rs` |
| WebAuthn PRF returns a deterministic 32 bytes in a Chromium virtual authenticator | [TESTED] | findings/fastfs_test |
| NEAR account keys: ed25519, secp256k1, ML-DSA-65 (no P-256) | [DOCS] | docs.near.org accounts FAQ |
| near-sdk 5.30.1 exposes `env::ed25519_verify`, `env::p256_verify(sig64, prehash32, pubkey33)`, `env::ml_dsa_verify`, `env::sha256_array`, `env::block_timestamp_ms`, `Promise::new_yield` | [CODE] | cargo registry, local |
| Storage staking 1e19 yoctoNEAR per byte (1 NEAR per 100 KB); account creation 0.007 NEAR; 770 bytes free | [DOCS] | docs.near.org storage-staking |
| Tx size limit 1,572,864 B; per-tx gas limit 1 PGas since protocol 83; 1 Tgas = 0.0001 NEAR at minimum price | [DOCS] | docs.near.org |
| FT standard: `ft_transfer_call` -> receiver `ft_on_transfer`; receiver must be registered via `storage_deposit` (min 0.00125 NEAR on tested token) | [DOCS] | docs.near.org FT |
| Walrus: n = 3f+1 nodes, writes need 2f+1 acks forming a certificate posted on-chain (Point of Availability); reads need 2f+1 slivers; blob ID is a Merkle commitment; deletable blobs and `BlobDeleted` event exist; the paper does not detail refunds or node payment | [DOCS] | arXiv 2505.05370, docs.wal.app |
| NEAR AI Cloud E2EE v2: Ed25519 keys converted to X25519, HKDF-SHA256 info `ed25519_encryption`, XChaCha20-Poly1305, wire `[eph 32][nonce 24][ct+tag]`, hex in JSON; attestation report needs an API key | [DOCS] | near-ai-cloud skill references |

## Unverified items we depend on (each has a spike)
U1 `p256_verify` available on testnet runtime (spike K3). U2 FastFS indexes calls to a receiver that has contract code and a `__fastdata_fastfs` method (we tested only no-contract receivers) (K2). U3 multi-part (Partial) upload and reassembly (K1). U4 NEAR AI E2EE accepts image content or we fall back to client OCR text; U4b client-side attestation verification in a browser (K7). U5 PRF on real iOS/Android/Windows Hello and across synced passkeys (K5). U6 `ed25519_verify` gas per call in our contract (K4). U7 end-to-end latency of `open_session` to `final` (K6). U8 NEAR AI key and rate limits (K7). Spike definitions with pass criteria and fallbacks are in 11_BUILD_PLAN_AND_SPIKES.

## Decisions fixed by this spec (changes from earlier notes)
1. Sale money lives in **per-deal escrow**. Money *inside* a box is an **optional module** (`equip_money`, 14) that creates a box account controlled by the NFT, with a withdrawal delay; boxes without it have no account and no balance.
2. Boxes are **records in one contract** with an NFT each; the box account exists only when Money is equipped. Box ids and addresses are random, not readable names.
3. **Content that must be revocable lives in Erasable storage.** Durable and Permanent are for artifacts whose permanence is the point.
4. **Receipt-first release:** no key leaves the release service before the receipt is final on-chain.
5. **Fair exchange is solved relative to the release service**, not on-chain alone (see 06 for why that is unavoidable).
6. **Claims are extracted once at upload by the owner's client** and disclosed under policy; no live model sees plaintext on a third party's request in the MVP.
7. The deployed contract has **no admin and no upgrade key**.
