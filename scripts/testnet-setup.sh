#!/usr/bin/env bash
# One-command testnet setup for your OWN copy of the stack (about 3 minutes): builds the contract, creates funded testnet accounts through the
# public faucet, deploys a new contract with your own service keys, deletes its access keys, and writes secrets to ./.env (gitignored).
# Testnet only. Nothing here touches mainnet or real funds. Re-running with an existing .env does nothing destructive.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d node_modules ] || pnpm install
if [ -f .env ] && grep -q '^KEYHOLE_CONTRACT=' .env && [ -f deploy/testnet.json ]; then
  echo "A deployment already exists in .env and deploy/testnet.json. Delete both to start over."; exit 0
fi
./scripts/build-wasm.sh
(cd tools/testnet && npx tsx src/accounts.ts && npx tsx src/deploy.ts && npx tsx src/launch.ts)
grep -q '^RS_STORE_KEY=' .env || echo "RS_STORE_KEY=$(openssl rand -hex 32)" >> .env
echo
echo "Done. Next: ./scripts/dev-services.sh   then open http://localhost:5173/"
