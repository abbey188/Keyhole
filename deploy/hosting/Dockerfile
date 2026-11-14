# UNTESTED: the sandbox this was written in has no container daemon, so this image has never been built. The same install and start
# steps were run directly (clean-clone test), but treat the image as a starting point and run `docker build` once before relying on it.
# One image for both services. Select with the command: `release` or `node`. No secrets are baked in: pass them as environment
# variables at run time (see .env.example). Build from the repository root:  docker build -f deploy/hosting/Dockerfile -t keyhole-services .
FROM node:22-slim
ENV NODE_ENV=production TRUST_PROXY=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter "@keyhole/release..." --filter "@keyhole/node..." --ignore-scripts
RUN useradd -m keyhole && mkdir -p /data && chown keyhole /data
USER keyhole
ENV RELEASE_HOST=0.0.0.0 NODE_HOST=0.0.0.0 RELEASE_DATA_DIR=/data/release NODE_DATA_DIR=/data/node
VOLUME /data
COPY --chown=keyhole deploy/hosting/entrypoint.sh /entrypoint.sh
ENTRYPOINT ["sh", "/entrypoint.sh"]
CMD ["release"]
