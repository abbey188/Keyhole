#!/usr/bin/env bash
# Sets up a fresh Ubuntu 24.04 server (2 GB RAM or more) to host Keyhole on NEAR TESTNET. Run as root from the cloned repo:
#   /srv/keyhole/deploy/hosting/setup-vps.sh your.domain.example
# What it does: installs Node, Rust, Caddy; creates its OWN keyless testnet deployment (keys are generated here and never leave this
# server); asks you (silently) for your NEAR AI Cloud key; builds the web app; starts the services under systemd; turns on HTTPS.
# UNTESTED on a real server when written: read it, run it, and report anything that fails. Safe to re-run.
set -euo pipefail
DOMAIN="${1:?usage: setup-vps.sh <domain, e.g. keyhole.example.org>}"
REPO=/srv/keyhole
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
[ -d "$REPO/.git" ] || { echo "clone the repository to $REPO first (see docs/HOSTING.md)"; exit 1; }
getent hosts "$DOMAIN" >/dev/null || { echo "DNS for $DOMAIN does not resolve yet; add the A record and wait a few minutes"; exit 1; }

echo "== system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git build-essential pkg-config libssl-dev ufw gnupg debian-keyring debian-archive-keyring apt-transport-https openssl
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi
corepack enable && corepack prepare pnpm@10.28.0 --activate

echo "== service user and folders"
id keyhole >/dev/null 2>&1 || useradd -m -s /bin/bash keyhole
mkdir -p /srv/keyhole-data/release /srv/keyhole-data/node
git config --global --add safe.directory "$REPO"
chown -R keyhole:keyhole "$REPO" /srv/keyhole-data
as_keyhole() { sudo -u keyhole -H bash -lc "cd $REPO && $*"; }

echo "== Rust (for building the contract)"
sudo -u keyhole -H bash -lc 'command -v cargo >/dev/null || (curl https://sh.rustup.rs -sSf | sh -s -- -y --target wasm32-unknown-unknown)'
sudo -u keyhole -H bash -lc '. ~/.cargo/env && rustup target add wasm32-unknown-unknown'

echo "== dependencies"
as_keyhole 'pnpm install --frozen-lockfile'

echo "== your own keyless testnet deployment (takes a few minutes)"
as_keyhole '. ~/.cargo/env && ./scripts/testnet-setup.sh'
as_keyhole 'grep -q "^KEYHOLE_CONTRACT=" .env' || { echo "setup did not produce a contract; see the output above"; exit 1; }

echo "== settings"
ENVF="$REPO/.env"
if ! grep -q '^NEARAI_API_KEY=.\+' "$ENVF"; then
  read -r -s -p "Paste your NEAR AI Cloud API key (typing is hidden; it is stored only in $ENVF): " KEY; echo
  [ -n "$KEY" ] || { echo "no key entered"; exit 1; }
  sed -i '/^NEARAI_API_KEY=/d' "$ENVF"; printf 'NEARAI_API_KEY=%s\n' "$KEY" >> "$ENVF"; unset KEY
fi
for kv in "APP_ORIGIN=https://$DOMAIN" "TRUST_PROXY=1" "NODE_ENV=production" "RELEASE_HOST=127.0.0.1" "NODE_HOST=127.0.0.1" \
          "RELEASE_DATA_DIR=/srv/keyhole-data/release" "NODE_DATA_DIR=/srv/keyhole-data/node" "RS_SPONSOR_MAX=40" "RS_SPONSOR_NEAR=1"; do
  k="${kv%%=*}"; sed -i "/^$k=/d" "$ENVF"; echo "$kv" >> "$ENVF"
done
chown keyhole:keyhole "$ENVF"; chmod 600 "$ENVF"

echo "== build the web app for https://$DOMAIN"
as_keyhole "VITE_RELEASE_URL=https://$DOMAIN/rs VITE_NODE_URL=https://$DOMAIN/node pnpm --filter @keyhole/web build"

echo "== services"
for svc in release node; do
cat > /etc/systemd/system/keyhole-$svc.service <<UNIT
[Unit]
Description=Keyhole $svc service (testnet)
After=network-online.target
Wants=network-online.target
[Service]
User=keyhole
WorkingDirectory=$REPO/services/$svc
EnvironmentFile=$ENVF
ExecStart=/usr/bin/env pnpm exec tsx src/main.ts
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true
[Install]
WantedBy=multi-user.target
UNIT
done
systemctl daemon-reload
systemctl enable --now keyhole-release keyhole-node

echo "== HTTPS and firewall"
mkdir -p /etc/caddy && sed "s/{\$DOMAIN}/$DOMAIN/" "$REPO/deploy/hosting/Caddyfile" > /etc/caddy/Caddyfile
systemctl enable caddy && systemctl restart caddy
ufw allow OpenSSH >/dev/null; ufw allow 80,443/tcp >/dev/null; ufw --force enable >/dev/null

echo "== checks"
sleep 5
curl -fsS "https://$DOMAIN/rs/v1/health" && echo " <- release service answers over HTTPS"
curl -fsSI "https://$DOMAIN/" | head -1
echo
echo "Done. Open https://$DOMAIN/ and https://$DOMAIN/#judge"
echo "Next: docs/HOSTING.md step 'Prove the new deployment' and 'Keep it healthy'."
