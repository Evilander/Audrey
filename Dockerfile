# ---- Build stage ------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /build

# better-sqlite3 needs python3 + make + g++ to compile its native bindings.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
COPY mcp-server ./mcp-server

# Compile TypeScript -> dist/, then drop dev deps so the runtime stage gets a
# production-only node_modules when we COPY it across.
RUN npm run build \
  && npm prune --omit=dev

# ---- Runtime stage ----------------------------------------------------------
FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    AUDREY_HOST=0.0.0.0 \
    AUDREY_PORT=3487 \
    AUDREY_DATA_DIR=/data \
    AUDREY_DEVICE=cpu

# Run as a dedicated non-root user. `node` ships with the official image
# (uid/gid 1000), so reuse it instead of creating a parallel account. The data
# dir is created and chowned at image-build time so the container does not need
# privileged operations at runtime to populate /data.
RUN mkdir -p /data && chown -R node:node /data /app

COPY --chown=node:node --from=build /build/dist ./dist
COPY --chown=node:node --from=build /build/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json README.md LICENSE ./

USER node

VOLUME ["/data"]
EXPOSE 3487

# /health is unauthenticated by design (src/routes.ts) so the probe needs no
# Bearer header. Keeping the probe auth-free also means the container stays
# healthy if the operator rotates AUDREY_API_KEY without restarting the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "--input-type=module", "-e", "fetch('http://127.0.0.1:' + (process.env.AUDREY_PORT || '3487') + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));"]

CMD ["node", "dist/mcp-server/index.js", "serve"]
