# Hosting Keyhole (testnet) on one small server

One server runs everything: the web app (static files), the release service, the storage node, HTTPS (Caddy) and the services (systemd). Cost: a small server (about 4 to 6 USD a month) plus a domain (about 1 to 12 USD a year, or a free DuckDNS name). Nothing here touches mainnet or real money.

**Why its own deployment:** the service keys of the contract we developed against live only in the development sandbox's `.env`, which is temporary, and secrets must not be pasted anywhere. So the server creates its own keyless testnet contract (same code, same Wasm hash, new keys that never leave the server). The setup script does this.

## Frontend on Vercel, services on Fly (recommended)
One Vercel project serves the whole site from `apps/web`: the landing page at `/`, the docs pages (`/trust`, `/security`, `/limits`, `/developers`, `/proof`), the app at `/app`, `/verify`, and access links (`#open=`). One origin, so the passkey domain is the same everywhere. If Fly stops, the site and the proof pages still load; only actions that need the services fail.
**Vercel:** Add New → Project → import `abbey188/Keyhole` (allow the GitHub app to see only this repo).
- Root Directory `apps/web`; tick **Include source files outside of the Root Directory in the Build Step**. Framework preset Vite. `apps/web/vercel.json` sets the install and build commands, the output (`dist`), the rewrite of page paths to the app, and the security headers.
- Node.js version 22. Production branch: the branch you approve (`main` after the merge).
- Environment variables: `VITE_RELEASE_URL=https://<fly app>.fly.dev/rs`, `VITE_NODE_URL=https://<fly app>.fly.dev/node`, `VITE_DEPLOY_RECORD=fly`.
- Add your domain under Settings → Domains **before anyone creates a safe**: passkeys belong to the exact address they were created on.
**Fly:** set `FRONTEND_ORIGIN=https://<your Vercel address or domain>` (Secrets), then **Deploy app** from the dashboard so the machine runs the current code. The machine then allows only that origin and serves only `/rs` and `/node`.
**AI relay safeguards (Fly secrets or env):** `RS_RELAY_PER_DAY` (hard daily cap on calls reaching NEAR AI, default 1500), `RS_RELAY_PER_MIN` (default 90), `AI_RELAY_DISABLED=1` (kill switch: the relay answers 503, everything else keeps working), and the existing per-IP limit and sponsor caps (`RS_PER_IP_PER_MINUTE`, `RS_SPONSOR_MAX`). The NEAR AI key balance is the final spend cap.

## Fly.io: your own domain for the app
The app is served at `https://<app>.fly.dev`. To use your own domain, e.g. `app.yourdomain.com`:
1. Fly dashboard → your app → **Certificates** → add `app.yourdomain.com`. Fly shows the DNS record to create (a CNAME to `<app>.fly.dev`; it may also show an `_acme-challenge` record). Add it at the registrar and wait until the certificate shows as issued.
2. Fly dashboard → your app → **Settings** (or `fly.toml` `[env]`): set `PUBLIC_ORIGIN=https://app.yourdomain.com`, then **Deploy app** / restart. On start the machine notices the address changed, rebuilds the web app once (about a minute) and allows that origin in CORS and CSP.
3. **Choose the address before anyone creates a safe.** Passkeys belong to the exact address they were created on: safes made on another address will not open on the new one.
A landing page (for example from v0) can live on Vercel at the root domain or `www`, with an "Open app" button linking to the app address. Nothing from this repository needs to go to Vercel.

## Free option, no card, no server: a static showcase
Checked against the providers' documentation (2026-11-14): Cloudflare Pages accepts a drag-and-drop zip or folder (up to 1,000 files, 25 MiB each; the page does not say whether a payment method is needed) and Netlify Drop publishes a dropped folder with no Git repository (no account needed for an anonymous temporary deploy; free-plan limits not stated on that page).
It serves the proof pages only: the live "0 access keys" check, every claim with its proof, the attack results, the Verify page (runs in the browser), and the recorded demo. The interactive product is **not** running there, and the home page says so. Build it with:
```bash
cd apps/web && VITE_SHOWCASE=1 VITE_VIDEO_URL=<link to the video> VITE_REPO_URL=<public repo link, only if the repo is public> npx vite build
```
then drop `apps/web/dist` into Cloudflare Pages (Workers & Pages → Create application → Drag and drop) or Netlify Drop. A static build was checked in a browser with no services running: the judge page showed "0 access keys" from public testnet RPC, the Verify page loaded, and no request failed.

## Free option, no card: a GitHub Codespace (blocked for this account)
Checked against GitHub's documentation (2026-11-14): a free personal account gets 120 compute hours and 15 GB-month of storage a month and needs **no payment method** (usage simply stops when the quota is used up). A Codespace's disk survives stops, a forwarded port can be made **public** at `https://<codespace>-<port>.app.github.dev`, the idle stop is 30 minutes by default and can be raised to 240, and every Codespace has a **12-hour maximum lifetime**. A 2-core Codespace therefore gives about 60 hours of running time a month.
Use it for a live link during a window you control, not for unattended judging: it stops when idle or after 12 hours, and you restart it by reopening it and running `./deploy/hosting/codespace-start.sh`.
1. Repository page → **Code → Codespaces → Create codespace on main** (2-core machine). In your GitHub settings → Codespaces, set the idle timeout to 240 minutes.
2. In its terminal: `./deploy/hosting/codespace-setup.sh` (about 10 to 15 minutes; asks once, hidden, for your NEAR AI key).
3. It prints the app, judge-page and health links. Keep that terminal open.
Not verified: whether your GitHub account's billing lock also blocks creating a Codespace. Try step 1 first; if it is refused, use the recorded demo plus local run.
Facts checked: Render's free web service has an ephemeral disk and sleeps after 15 minutes (docs.render.com free tier); Hugging Face Docker Spaces need a paid plan; Oracle Always Free needs a card and its current allowance could not be confirmed.

## Accounts to create for a paid server (you)
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
