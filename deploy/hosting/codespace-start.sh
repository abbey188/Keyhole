#!/usr/bin/env bash
# Starts the node, the release service and the web app in this Codespace, makes the three ports public, prints the link, and keeps the
# terminal printing a line a minute (terminal output counts as activity, so the Codespace is not stopped for idleness within its idle limit).
# Run it again after the Codespace has stopped and been reopened. Stop with Ctrl+C.
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${CODESPACE_NAME:?run this inside a GitHub Codespace}"
DOM="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
mkdir -p data/logs
set -a; . ./.env; set +a
(cd services/release && RELEASE_DATA_DIR="$PWD/../../data/release" nohup pnpm exec tsx src/main.ts > ../../data/logs/release.log 2>&1 &)
(cd services/node && NODE_DATA_DIR="$PWD/../../data/node" nohup pnpm exec tsx src/main.ts > ../../data/logs/node.log 2>&1 &)
(cd apps/web && nohup pnpm exec vite preview --host 127.0.0.1 --port 5173 --strictPort > ../../data/logs/web.log 2>&1 &)
sleep 6
gh codespace ports visibility 5173:public 8787:public 8788:public -c "$CODESPACE_NAME" || echo "Could not set the ports public automatically: open the PORTS tab, right-click each of 5173, 8787, 8788 → Port Visibility → Public."
echo
echo "App:    https://$CODESPACE_NAME-5173.$DOM/"
echo "Proof:  https://$CODESPACE_NAME-5173.$DOM/#judge"
echo "Health: https://$CODESPACE_NAME-8788.$DOM/v1/health"
echo "Keep this terminal open. Logs: data/logs/*.log"
while true; do echo "alive $(date -u +%H:%M:%S)"; sleep 60; done
