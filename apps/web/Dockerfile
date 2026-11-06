# Household Hub web app — Next.js standalone build on Node 24 (Debian slim, glibc).
# better-sqlite3 ships prebuilt binaries for linux x64/arm64, so no compiler is needed.

FROM node:24.12.0-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: better-sqlite3 loads bundled prebuilds, but this image's npm (11.6) ignores its
# "gypfile": false and would try to compile it with node-gyp. No other dependency needs an install
# script to build or run the app (only fsevents, macOS-only, and unrs-resolver, lint-only).
RUN npm ci --no-audit --no-fund --ignore-scripts

FROM node:24.12.0-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24.12.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    HUB_DATA_DIR=/data \
    HUB_CONFIG_DIR=/config
RUN mkdir -p /data /config && chown node:node /data
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "server.js"]
