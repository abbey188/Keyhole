#!/usr/bin/env bash
# Starts the node, the release service and the web dev server locally (testnet). Secrets come from .env (gitignored).
set -euo pipefail
cd "$(dirname "$0")/.."
DATA="${KEYHOLE_DATA:-./data}"
set -a; . ./.env; set +a
(cd services/release && RELEASE_DATA_DIR="$DATA/release" exec npx tsx src/main.ts) > "${LOGDIR:-/tmp}/keyhole-release.log" 2>&1 &
(cd services/node && NODE_DATA_DIR="$DATA/node" exec npx tsx src/main.ts) > "${LOGDIR:-/tmp}/keyhole-node.log" 2>&1 &
(cd apps/web && exec npx vite --host 127.0.0.1 --port 5173) > "${LOGDIR:-/tmp}/keyhole-web.log" 2>&1 &
wait
