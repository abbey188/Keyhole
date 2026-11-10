# 12 The thin slice (locked) and the zero-knowledge exploration

Locked 2026-11-10 by the owner's instruction. The full design in 00 to 11 stays the reference; this file says what is built first, what is mocked, what is cut, and in what order things are dropped if time runs short. The window closes 2026-11-14 23:59 UTC.

## 1. The slice in one paragraph
A person signs in with a passkey, adds a document to a box, gives a named person time-limited access through a link, watches the receipt appear, revokes it, and sells the box to a buyer through a NEAR escrow that moves ownership and payment together, with a signed claim ("income at least X") disclosed instead of the file. Every promise has a test; every mock is labelled.

## 2. Built (all of it real unless marked)
| Area | In the slice | Parameters and notes |
|---|---|---|
| Contract | Boxes with NEP-171 view interface and blocked transfers; **an optional Money module: `equip_money` creates a box account controlled by the NFT, holding money with a withdrawal delay; built after the records-only core and dropped without harm if it slips (14)**; Bound and Handover kinds; blobs with the Registered, Complete, Active, Retired lifecycle; grants; `open_session` with receipt chain; deals with NEAR escrow, cancel, complete, expire; epoch bump; claimable fallback; no admin and keys deleted at launch | Storage N=1, T=1 (parameterized, the spec's N and T unchanged); `MIN_WAIT_MS` short in the demo deployment and labelled |
| Crypto | Passkey PRF derivation (passphrase fallback), key hierarchy, segment AEAD with AAD binding, Padmé padding, Merkle tree and `blob_id`, split keys with per-grant S1 and S2, sealed box, cross-language vectors | Page-level keys for documents; item-level for anything else |
| Storage | One storage node (Rust) with ticketed reads, leaf proofs, ack, retire and erase; client store module | Erasable mode only |
| Release service | Receipt-first sessions, leases, sealed S2 release, signed session log, relayer for sponsored gas, deal key release | One service; fails closed |
| Web | Passkey sign-in, Home, Box (Files, Access, Activity with chain verification, Deal), Give access sheet, link screen, Revoke and re-secure, recipient landing and viewer with baked-in watermark, deal screens for both roles, proof drawer | Two browsers side by side for the demo |
| Claims | Local OCR, rule extraction, model extraction over end-to-end encrypted calls when the NEAR AI key works, owner review, signed claim as an item, Claims-mode grant, offline verifier | If no key: the model step is a labelled mock and grade B is unavailable (grade C only) |
| Proof | `verify.sh`, CLAIMS.md, README for machine readers, release manifest, security notes | |
| Tests | X vectors and properties; C1 to C12 in sandbox; A1 to A9; S1 to S9 relevant subset for one node; D1 to D4, D8 to D10; model checker with the property table; W1 to W8 | See 10 |

## 3. Promoted into the slice and stretch (updated 2026-11-10 after the demo discussion)
**Promoted into the slice:** Ask my box (owner-only Q&A with page citations, see 07 section 9). It reuses the OCR text index and the E2EE route already needed for claims, so it costs little extra; it is the clearest private-AI moment in the demo and depends on the NEAR AI key (spike K7).
**Stretch, in this order, only after the core loop is green:**
1. Redacted copies: AI-assisted redaction with owner review and burned-in black bars (07 section 9b); parity with the redaction features of existing data rooms and the visual motif of the product.
2. Request links (signed payload, domain verification).
3. FastFS Durable mode for single-part items (the path is already tested), as an optional checkbox.
4. Stablecoin escrow on a labelled test token.
5. Per-box account keys and sponsored gas (private mode steps 1 to 3).

## 4. Cut (documented in the README as roadmap)
Multiple storage nodes and real certificates with T greater than 1; Permanent mode; Verified mode and multi-part FastFS; storage proofs and fees paid to nodes; threshold or enclave release service; dispute arbiter and held-back tail; passkey verification on-chain; confidential payments; live free-text Check; guardian recovery; zero-knowledge proofs (section 6) unless the spike passes.

## 5. Drop order if time runs short (first to drop first)
1. Stretch items in reverse order. 2. Live model extraction becomes the labelled mock (Ask my box is then shown from a recorded run with a key, or labelled mock). 3. Page-level keys become item-level keys. 4. Activity chain verification stays; the polished proof drawer reduces to links. 5. The box account stays minimal (money only; FastFS namespace is stretch); NEAR escrow stays; the buyer re-secure step becomes a clearly labelled manual step. 6. Never dropped: the contract invariants, receipt-first release, revoke with failing re-open, the claims table with tests, honest limits.

## 6. Zero-knowledge and RISC Zero: what we learned and the decision
### 6.1 What the Skarbnik repo does (read, not run) [CODE: github.com/pgreyy/skarbnik at commit 26e898a, 2026-11-09]
- It is a repair bounty: a vendor keeps a secret test input, an agent submits a patch, a RISC Zero zkVM program evaluates the patch against the secret, and a **Groth16 proof of PASS or FAIL is verified inside a NEAR contract** using NEAR's BN254 host functions (`alt_bn128_pairing_check`, `alt_bn128_g1_multiexp`, `alt_bn128_g1_sum`).
- The contract recomputes RISC Zero's claim digest from an allowlisted image id and the journal, forms the five public inputs, and runs the pairing equation (`contract/src/groth16.rs`, following risc0-groth16 3.0.5 and risc0-zkvm 3.0.6).
- Reported on-chain cost: about 36.4 Tgas for an accepted proof, of which the pairing check is about 30 Tgas (their `docs/numbers.md`). At the minimum gas price that is about 0.0036 NEAR.
- A "Level 1" path trusts OutLayer to verify instead of the contract (lighter, trusted); a "Level 2" path (default) verifies on-chain.
- Proving cost reported: on a rented L40S GPU about 29 s to prove plus 21 s to shrink plus 289 to 338 s for the Groth16 wrap, about 17 minutes from reveal to verdict, about $0.04 of GPU per proof; on a laptop CPU about 2.4 hours to prove and about 4 hours end to end; the Groth16 wrap needs about 7 GiB of memory and Docker.
- Licence: Apache-2.0 or MIT, with a third-party notices file; the contract was tested with 155 tests; testnet only; it states its own limits.
- It is itself a hackathon entry (live site, demo video dated 2026-11-09). We are not building the same thing and should not look as if we are.

### 6.2 Where zero-knowledge could help this product (ranked)
| Idea | What it would prove | Value | Cost and risk |
|---|---|---|---|
| **Delivery proof for deals** | The seller's key envelope is consistent with the public commitments (`bmk_commit`, `dek_commit`) and a random sample of segments (indices from a block hash after funding) decrypt under the committed key and hash into the on-chain root | Closes the biggest honest gap in deals (garbage delivery) and weakens the dependence on the release service for correctness | Highest: AEAD and Merkle verification inside a zkVM for megabytes; proving time unknown; needs a GPU or long CPU runs; cannot run in a browser; the prover sees the secret so it must run locally or in a TEE |
| **Claims from issuer-signed credentials** | A guest verifies an issuer signature over a structured credential and evaluates a predicate; the journal is `{issuer, predicate, params, result, holder binding}` | Gives a cryptographically proved evidence tier above grade B: "without revealing" | Medium: requires an issuer that signs machine-readable data; real payslips rarely are; the demo issuer would be a labelled mock; passports and web data are already covered by Self, zkPassport and Reclaim, whose proofs we could accept later instead of building our own |
| ZK for receipts or metadata privacy | Membership or unlinkability proofs | Small and hard | Not worth it |

### 6.3 Practical constraints we must respect
- Proving does not run in a browser. Our rule that plaintext never leaves the device means a prover would be a local program (CLI or desktop helper) or an attested TEE, which is a new component.
- This sandbox has 4 cores, 15 GiB memory, Docker, and no GPU. A tiny guest could be proved here; anything realistic would need rented GPU time. We have not run any RISC Zero code.
- The Groth16 verifier crate in Skarbnik (`verifier/groth16-near`) is open source. Reusing it is allowed by its licence if we keep the notices, disclose it as third-party code, and say what we built on top. It is also the same idea as a competing entry, so reuse buys little originality; the originality would have to be the guest program (what is proved).
- On-chain verification costs about 36 Tgas per proof, which fits easily within limits [DOCS: 1 PGas per transaction].

### 6.4 Decision
**Zero-knowledge is not in the thin slice.** It is a time-boxed spike after the core loop and the deal flow are green:
- **Spike Z1:** a tiny RISC Zero guest that verifies an Ed25519 signature on a small JSON credential and evaluates one predicate; produce a receipt in development mode, then a Groth16 receipt if Docker and memory allow; verify it in a sandbox contract with a locally written verifier or the published crate. Pass: the on-chain verification accepts the valid receipt and rejects a tampered journal. Record proving time and gas.
- **Spike Z2 (only if Z1 passes and time remains):** estimate guest cycles for decrypting and hashing 2 MiB of sampled segments to decide whether the delivery proof is feasible.
- If Z1 passes, the README presents it as an optional higher evidence tier ("Proved") with the mock issuer labelled; if it fails, it stays on the roadmap with the numbers measured.
Reason for deferring: the product's weakest points are not cryptographic proofs, the nearest competing entry already occupies this ground with more evidence than we could assemble, and unmeasured proving costs are exactly the kind of risk that sinks a four-day build.
