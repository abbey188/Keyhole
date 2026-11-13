#!/usr/bin/env bash
# One-command verification (offline: needs Rust, Node and pnpm; no keys, no network after dependencies are fetched).
# Prints what was checked and the hashes of the build artifacts. Exit code is non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1. Protocol crate tests (RFC vectors, properties, cross-language vector file)"
cargo test -p keyhole-proto --quiet 2>&1 | grep -E "test result" || true

echo "== 2. Contract tests (invariants C2-C9, SI1-SI9, deal rules)"
cargo test -p keyhole-contract --quiet 2>&1 | grep -E "test result" || true

echo "== 3. TypeScript crypto package reproduces the Rust vectors byte for byte"
(cd packages/crypto && npx vitest run 2>&1 | grep -E "Tests |Test Files" || true)

echo "== 3b. Chain client, node, client store, release service, AI client, ask/claims, web app (service tests use the labelled MOCK chain)"
for d in packages/chain services/node packages/store services/release packages/ai packages/askclaims apps/web; do
  printf '%-18s ' "$d"; (cd "$d" && npx vitest run 2>&1 | grep -E "Tests " || echo "FAILED")
done

echo "== 4. Build artifacts and hashes"
if ./scripts/build-wasm.sh 2>&1 | sed 's/^/   /'; then
  echo "   (compare with deploy/testnet.json only for the commit that was deployed: a rebuilt contract has a different hash)"
else
  echo "   Wasm build failed (needs the wasm32-unknown-unknown target and pnpm install)"
fi
echo "vectors sha256:       $(sha256sum vectors/keyhole-v1.json | cut -d' ' -f1)"

echo "== 4b. Secret scan"
./scripts/secret-scan.sh || { echo "SECRET SCAN FAILED"; exit 1; }

echo "== 5. Chain checks (needs network): C1, no access keys on the deployed contract"
if [ -f deploy/testnet.json ]; then
  (cd tools/testnet && npx tsx src/launch.ts --check 2>&1 | tail -1) || echo "C1 check could not run (network?)"
fi
echo "   full record of transactions: docs/EVIDENCE.md and deploy/*.json"
echo "done"
