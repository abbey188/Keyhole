# Fly.io image: web app + release service + storage node behind one Caddy, on one machine with one volume (/data).
# No secrets are baked in. The first boot creates this app's OWN keyless testnet contract from the prebuilt Wasm (no Rust needed).
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl curl && rm -rf /var/lib/apt/lists/*
COPY --from=caddy:2 /usr/bin/caddy /usr/bin/caddy
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
ENV KEYHOLE_WASM=/app/deploy/keyhole_opt.wasm
EXPOSE 8080
ENTRYPOINT ["bash", "/app/deploy/fly/entrypoint.sh"]
