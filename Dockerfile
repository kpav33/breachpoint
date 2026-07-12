# Headless Colyseus game server (Phase 9). Runs src/core + src/match + src/ai
# directly via Node's type stripping — no build step. The static client is
# deployed separately to a CDN (see docs/DEPLOY.md); this image is server-only.
FROM node:22-slim

WORKDIR /app

# Install only production deps (colyseus). The client toolchain isn't needed.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Server code + the pure sim/match/ai it imports + the map JSON it loads.
COPY server ./server
COPY src/core ./src/core
COPY src/match ./src/match
COPY src/ai ./src/ai
COPY src/net/protocol.ts ./src/net/protocol.ts
COPY public/assets/maps ./public/assets/maps

ENV PORT=2567
EXPOSE 2567

CMD ["node", "--experimental-strip-types", "server/index.ts"]
