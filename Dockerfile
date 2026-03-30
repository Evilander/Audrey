FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    AUDREY_HOST=0.0.0.0 \
    AUDREY_PORT=3487 \
    AUDREY_DATA_DIR=/data \
    AUDREY_DEVICE=cpu

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY mcp-server ./mcp-server
COPY types ./types
COPY README.md LICENSE ./

VOLUME ["/data"]
EXPOSE 3487

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "--input-type=module", "-e", "const headers = process.env.AUDREY_API_KEY ? { Authorization: 'Bearer ' + process.env.AUDREY_API_KEY } : {}; fetch('http://127.0.0.1:3487/health', { headers }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));"]

CMD ["node", "mcp-server/index.js", "serve"]
