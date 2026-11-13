#!/usr/bin/env bash
# Resets the local demo to a clean state: stops the local services, clears their data, restarts them.
# Testnet accounts, the contract and .env are untouched. Usage: ./scripts/demo-reset.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DATA="${KEYHOLE_DATA:-./data}"
pkill -f "services/release" 2>/dev/null || true
pkill -f "services/node" 2>/dev/null || true
pkill -f "vite --host 127.0.0.1 --port 5173" 2>/dev/null || true
sleep 1
rm -rf "$DATA/release" "$DATA/node"
mkdir -p "$DATA"
export NODE_USE_ENV_PROXY="${NODE_USE_ENV_PROXY:-1}" RS_SPONSOR_MAX="${RS_SPONSOR_MAX:-300}" RS_SPONSOR_NEAR="${RS_SPONSOR_NEAR:-1}"
nohup ./scripts/dev-services.sh >/dev/null 2>&1 &
for i in $(seq 1 30); do
  curl -s -o /dev/null localhost:8787/ && curl -s -o /dev/null localhost:8788/ && curl -s -o /dev/null localhost:5173/ && { echo "demo reset: node 8787, release 8788, web http://localhost:5173/ are up with empty data"; exit 0; }
  sleep 1
done
echo "services did not come up; see \${LOGDIR:-/tmp}/keyhole-*.log" >&2; exit 1
