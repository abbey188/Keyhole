# Attestations and artifact hashes

What can be checked about this repository, and how. Items marked PLANNED do not exist yet.

| Attestation | How to check | Status |
|---|---|---|
| Contract Wasm hash | `./scripts/verify.sh` prints `sha256` of the release build; the deployed code hash is read with `near contract inspect`/RPC `view_code` | Build hash: available. Deployed hash: PLANNED (needs deployment, recorded in docs/EVIDENCE.md) |
| Contract has no access keys | RPC `view_access_key_list` returns an empty list (invariant C1) | PLANNED (after launch script) |
| Cross-language protocol vectors | `vectors/keyhole-v1.json`; Rust and TypeScript tests both reproduce it byte for byte | Available |
| RFC conformance of primitives | Tests in `crates/keyhole-proto` and `packages/crypto` use the RFC 5869, 7748, 8032 and NIST vectors | Available |
| Release manifest (hashes of the served web app, contract id, public keys) | `docs/release-manifest.json`, compared with the served files by `tools/vault-verify-app` | PLANNED |
| NEAR AI TEE attestation of the model used for claims | Attestation report and chat signature recorded with each claim (nonce, signing address, NRAS and TDX evidence) | PLANNED (needs the API key) |
| Receipt chain | Recompute from public events and the owner's records; compare with the box's on-chain head | Verification code exists in both languages; live data PLANNED |
| Build provenance | CI prints hashes; GitHub artifact attestations can be added when the repository is public | PLANNED |
| Dependency and licence inventory | `THIRD_PARTY_NOTICES.md`; `cargo tree` and `pnpm list` | PLANNED (SBOM) |
