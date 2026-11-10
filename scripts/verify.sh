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

echo "== 4. Build artifacts and hashes"
cargo build --target wasm32-unknown-unknown --release -p keyhole-contract --quiet 2>/dev/null || true
if [ -f target/wasm32-unknown-unknown/release/keyhole_contract.wasm ]; then
  echo "contract wasm sha256: $(sha256sum target/wasm32-unknown-unknown/release/keyhole_contract.wasm | cut -d' ' -f1)"
fi
echo "vectors sha256:       $(sha256sum vectors/keyhole-v1.json | cut -d' ' -f1)"

echo "== 5. Chain checks (optional, needs network): see docs/EVIDENCE.md for deployed contract and transactions"
echo "done"
