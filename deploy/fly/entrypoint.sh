#!/usr/bin/env bash
# Runs inside the Fly machine. Persistent state lives on the volume at /data (keys in /data/.env, the deployment record, the built web app,
# the services' data). The machine's own filesystem is rebuilt from the image on every start, so nothing else is relied on.
set -euo pipefail
cd /app
ORIGIN="https://${FLY_APP_NAME:?FLY_APP_NAME is set by Fly}.fly.dev"
mkdir -p /data/release /data/node /data/web
touch /data/.env && chmod 600 /data/.env && ln -sf /data/.env /app/.env
export APP_ORIGIN="$ORIGIN"
caddy run --config /app/deploy/fly/Caddyfile --adapter caddyfile &

if ! grep -q '^KEYHOLE_CONTRACT=' /data/.env; then
  echo "[boot] first start: creating this app's own keyless testnet deployment"
  (cd tools/testnet && npx tsx src/accounts.ts && npx tsx src/deploy.ts && npx tsx src/launch.ts)
  grep -q '^RS_STORE_KEY=' /data/.env || echo "RS_STORE_KEY=$(openssl rand -hex 32)" >> /data/.env
  mkdir -p /data/records && cp deploy/*.json /data/records/
  rm -rf /data/web/dist
fi
[ -d /data/records ] && cp /data/records/*.json deploy/

if [ ! -d /data/web/dist ]; then
  echo "[boot] building the web app for $ORIGIN"
  VITE_RELEASE_URL="$ORIGIN/rs" VITE_NODE_URL="$ORIGIN/node" pnpm --filter @keyhole/web build
  cp -r apps/web/dist /data/web/dist
fi

set -a; . /data/.env; set +a
export RELEASE_HOST=127.0.0.1 NODE_HOST=127.0.0.1 RELEASE_DATA_DIR=/data/release NODE_DATA_DIR=/data/node NODE_ENV=production
(cd services/release && exec pnpm exec tsx src/main.ts) &
(cd services/node && exec pnpm exec tsx src/main.ts) &
echo "[boot] up: $ORIGIN"
wait -n
echo "[boot] a process exited; stopping so Fly restarts the machine" >&2
exit 1
