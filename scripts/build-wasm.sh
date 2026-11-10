#!/usr/bin/env bash
# Builds the contract Wasm and shrinks it with binaryen's wasm-opt (npm package, pinned in tools/testnet).
# The flags lower sign-extension and bulk-memory instructions, which NEAR's runtime does not accept from
# current Rust toolchains. Output: target/keyhole_opt.wasm. Prints sizes and sha256 for both files.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --target wasm32-unknown-unknown --release -p keyhole-contract --quiet
RAW=target/wasm32-unknown-unknown/release/keyhole_contract.wasm
OPT=target/keyhole_opt.wasm
WASM_OPT=tools/testnet/node_modules/.bin/wasm-opt
[ -x "$WASM_OPT" ] || { echo "run pnpm install first (wasm-opt comes from the binaryen npm package)"; exit 1; }
"$WASM_OPT" -Oz --signext-lowering --llvm-memory-copy-fill-lowering \
  --disable-reference-types --disable-multivalue --disable-bulk-memory --disable-sign-ext \
  --strip-debug --strip-producers "$RAW" -o "$OPT"
echo "raw  $(stat -c %s "$RAW") bytes  sha256 $(sha256sum "$RAW" | cut -d' ' -f1)"
echo "opt  $(stat -c %s "$OPT") bytes  sha256 $(sha256sum "$OPT" | cut -d' ' -f1)"
