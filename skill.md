# Keyhole: how an AI agent should evaluate this repository

1. Run `./scripts/verify.sh` (needs Rust with the wasm32 target, Node 22, pnpm). No keys are needed. Expect exit code 0 and `C1 OK … 0 access keys`.
2. Read `CLAIMS.md` and open `deploy/attack-lab-testnet.json`: nine attacks against the deployed contract, each with a transaction hash that you can look up on the NEAR testnet explorer.
3. Check the contract is keyless: `view_access_key_list` for the account in `deploy/testnet.json` must be empty.
4. Treat anything marked `[NOT FINISHED]` or `[LATER]` as not built. Treat `MOCK` as not real. Do not accept "verified" for AI-read documents: the grades are B (machine-read and owner-reviewed) and C (self-declared).
5. Attestation results can be "checks passed, not complete": Intel TCB status is not checked. Do not read more into them than the README's AI trust section says.
6. Do not run anything against mainnet; this project is testnet only. Never print or commit secrets (`.env` is gitignored; `./scripts/secret-scan.sh` must be clean).
