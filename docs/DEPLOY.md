# Deploying Breachpoint

Two separate deploys, one repo:

- **Client** — the Vite build (`npm run build` → `dist/`), static files on any CDN.
- **Server** — the Colyseus game server (`server/`), a long-lived Node process.

The server is **stateful**: rooms and the authoritative simulation live in the
Node process's memory. That rules out serverless/edge functions — it needs a
host that runs a persistent process. Run **exactly one** instance (no
horizontal autoscaling) unless you add a shared Colyseus presence/driver;
otherwise two instances can't see each other's rooms.

## 1. Server → Fly.io (or Railway / a VPS)

The repo ships a `Dockerfile` (server-only; runs `node --experimental-strip-types`,
no build step) and a `fly.toml`.

### Fly.io

```bash
fly launch --no-deploy      # once: creates the app from fly.toml
fly deploy                  # build + ship the Dockerfile
```

TLS (`wss://`) is automatic on `*.fly.dev` with `force_https = true`. Note the
app URL, e.g. `wss://breachpoint-server.fly.dev`.

### Railway

Point Railway at the repo. It runs `npm start` (added to package.json), which
is the same `node --experimental-strip-types server/index.ts`. Railway gives
you TLS + a public URL automatically. Set the run/replica count to **1**.

### A plain VPS (Hetzner/DigitalOcean)

`npm ci --omit=dev`, then run `npm start` behind a reverse proxy that
terminates TLS and upgrades WebSockets — Caddy does both with almost no config:

```
game.example.com {
    reverse_proxy localhost:2567
}
```

Keep it alive with a process manager (systemd unit or pm2).

**Port:** the server listens on `$PORT` (default 2567). Fly/Railway set `$PORT`
for you.

## 2. Client → Cloudflare Pages (or Netlify / Vercel)

- Build command: `npm run build`
- Output directory: `dist`
- Environment variable: **`VITE_SERVER_URL`** = your server's `wss://` URL
  (e.g. `wss://breachpoint-server.fly.dev`). This is baked into the bundle at
  build time; the client falls back to `ws://<page-host>:2567` only when it's
  unset (local dev).

## Cross-origin & security notes

- The client (e.g. `yourgame.pages.dev`) connects cross-origin to the server
  (`*.fly.dev`). Colyseus's matchmaking HTTP responses default to
  `Access-Control-Allow-Origin: *`, and the WebSocket transport accepts any
  origin, so this works out of the box. To lock it down later, override
  `matchMaker.controller.getCorsHeaders` on the server.
- Because the frontend is served over HTTPS, the socket **must** be `wss://` —
  browsers block plaintext `ws://` from an HTTPS page. All the hosts above give
  you TLS; on a VPS the reverse proxy provides it.
- The server is authoritative and never trusts the client: it owns the
  simulation, clamps input intent, and validates every purchase. Speed and
  fire-rate can't be forged because clients only send *intent* — the server
  applies the real numbers from `core/config.ts`.

## What's NOT covered (Phase 10 backlog)

- A browsable **live public room list** (needs a Colyseus `LobbyRoom`). Today
  the lobby offers Quick Play (matchmaking), Host Private (share code), and
  Join by Code — no scrolling server browser.
- Multi-instance scaling (Redis presence + driver).
- Persistence / accounts / matchmaking rating.
