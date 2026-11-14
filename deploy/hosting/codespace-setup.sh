#!/usr/bin/env bash
# One-time setup of Keyhole (NEAR TESTNET) inside a GitHub Codespace, so the app has a public https link without paying for a server.
# Run in the Codespace terminal from the repository root:   ./deploy/hosting/codespace-setup.sh
# It creates this Codespace's OWN keyless testnet deployment (keys stay in this Codespace's .env), asks for your NEAR AI Cloud key
# (hidden), builds the web app for this Codespace's public address, and then starts everything.
# UNTESTED in a real Codespace when written: run it, and send any error. Limits: see docs/HOSTING.md (idle stop, 12 h lifetime, free hours).
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${CODESPACE_NAME:?run this inside a GitHub Codespace}"
DOM="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
WEB="https://$CODESPACE_NAME-5173.$DOM"; RS="https://$CODESPACE_NAME-8788.$DOM"; NODE="https://$CODESPACE_NAME-8787.$DOM"

command -v cargo >/dev/null || { curl https://sh.rustup.rs -sSf | sh -s -- -y --target wasm32-unknown-unknown; }
. "$HOME/.cargo/env"; rustup target add wasm32-unknown-unknown
corepack enable && corepack prepare pnpm@10.28.0 --activate
pnpm install --frozen-lockfile
./scripts/testnet-setup.sh

if ! grep -q '^NEARAI_API_KEY=.\+' .env; then
  read -r -s -p "Paste your NEAR AI Cloud API key (hidden; stored only in this Codespace's .env): " KEY; echo
  [ -n "$KEY" ] || { echo "no key entered"; exit 1; }
  sed -i '/^NEARAI_API_KEY=/d' .env; printf 'NEARAI_API_KEY=%s\n' "$KEY" >> .env; unset KEY
fi
for kv in "APP_ORIGIN=$WEB" "NODE_ENV=production" "TRUST_PROXY=1" "RS_SPONSOR_MAX=40" "RS_SPONSOR_NEAR=1"; do
  k="${kv%%=*}"; sed -i "/^$k=/d" .env; echo "$kv" >> .env
done
chmod 600 .env
echo "VITE_RELEASE_URL=$RS" > apps/web/.env.production.local
echo "VITE_NODE_URL=$NODE" >> apps/web/.env.production.local
pnpm --filter @keyhole/web build
echo; echo "Setup done. Starting…"
exec ./deploy/hosting/codespace-start.sh
