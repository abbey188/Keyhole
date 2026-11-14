# Hosting Keyhole (testnet) on one small server

One server runs everything: the web app (static files), the release service, the storage node, HTTPS (Caddy) and the services (systemd). Cost: a small server (about 4 to 6 USD a month) plus a domain (about 1 to 12 USD a year, or a free DuckDNS name). Nothing here touches mainnet or real money.

**Why its own deployment:** the service keys of the contract we developed against live only in the development sandbox's `.env`, which is temporary, and secrets must not be pasted anywhere. So the server creates its own keyless testnet contract (same code, same Wasm hash, new keys that never leave the server). The setup script does this.

## Accounts to create (you)
1. **A server.** Hetzner Cloud (CX22, 4 GB) or DigitalOcean (4 GB droplet). Image: **Ubuntu 24.04**. Add your SSH public key when asked (or use the provider's console). Note the server's IP address.
2. **A name for it.** Easiest: buy a cheap domain (Cloudflare Registrar, Namecheap, Porkbun) or take a free one at duckdns.org. Create one **A record** pointing at the server's IP, for example `keyhole.yourdomain.com`. Wait a few minutes.
3. **A NEAR AI Cloud API key** from cloud.near.ai (sign in, create an API key). You will type it into the server later, hidden. Never paste it into chat or a file in the repo.

## On the server (as root)
```bash
apt-get update && apt-get install -y git
ssh-keygen -t ed25519 -N "" -f /root/.ssh/id_ed25519
cat /root/.ssh/id_ed25519.pub
```
Copy that public key line into GitHub: repository **abbey188/Keyhole → Settings → Deploy keys → Add deploy key**, tick **Allow write access** (so the server can push its public deployment record), save. Then:
```bash
git clone git@github.com:abbey188/Keyhole.git /srv/keyhole
/srv/keyhole/deploy/hosting/setup-vps.sh keyhole.yourdomain.com
```
The script takes roughly 10 to 15 minutes (Rust is the slow part). It asks once for the NEAR AI key (hidden). At the end it prints two checks and the address to open.

## Prove the new deployment (about 10 minutes)
The new contract needs its own evidence, and the judge page reads the records the setup wrote:
```bash
sudo -u keyhole -H bash -lc 'cd /srv/keyhole/tools/testnet && . ~/.cargo/env && npx tsx src/smoke.ts && npx tsx src/conformance.ts && npx tsx src/attack-lab.ts'
```
Then save the public records (no secrets are in `deploy/`) on a branch for review:
```bash
cd /srv/keyhole && git checkout -b deploy/hosted && git add deploy && git commit -m "Hosted deployment records" && git push -u origin deploy/hosted
```
Tell me when it is pushed and I will check the records, merge them, and rebuild.

## Keep it healthy
- **Uptime check:** free account at uptimerobot.com, an HTTPS monitor on `https://keyhole.yourdomain.com/rs/v1/health` (it should answer `{"ok":true}`).
- **Funds:** each new safe that uses the sponsor costs the relayer about 0.5 testnet NEAR (`RS_SPONSOR_MAX=40` caps it). If sponsoring stops, top up: `cd /srv/keyhole/tools/testnet && npx tsx src/topup.ts` (moves spare NEAR from the other demo accounts), or get testnet NEAR from the public faucet.
- **Logs:** `journalctl -u keyhole-release -f` and `journalctl -u keyhole-node -f`.
- **Restart:** `systemctl restart keyhole-release keyhole-node`.
- **Update the app after a new commit:** `cd /srv/keyhole && git pull && sudo -u keyhole -H bash -lc 'cd /srv/keyhole && pnpm install --frozen-lockfile && VITE_RELEASE_URL=https://keyhole.yourdomain.com/rs VITE_NODE_URL=https://keyhole.yourdomain.com/node pnpm --filter @keyhole/web build' && systemctl restart keyhole-release keyhole-node`.
- **Back up** `/srv/keyhole/.env` and `/srv/keyhole-data` if you want to keep this deployment: the `.env` holds the service keys, and without it the contract cannot be served again.

## What is not covered
No backups are automated, there is a single server, and the script was written without a real server to test on: treat the first run as a test and send me any error. The release service remains a single trusted party (see `SECURITY.md`). If hosting is not stable by 14:00 UTC we fall back to the recorded demo plus the local run.
