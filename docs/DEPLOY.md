# Deploying Breachpoint

Two separate deploys, one repo:

- **Client** — the Vite build (`npm run build` → `dist/`), static files on any CDN.
  For Docker hosts (e.g. Coolify) use `Dockerfile.client` (nginx image; set
  `VITE_SERVER_URL` as a *build-time* variable) — don't use Nixpacks, its pinned
  Node 22.11 is below the >=22.12 that Vite 8's rolldown binding requires.
- **Server** — the Colyseus game server (`server/`), a long-lived Node process.

## Healthchecks

Both deploys expose `GET /health` → `200 OK`:

- **Server** — served by the plain-HTTP side of the Colyseus listener
  (`server/index.ts`); all other paths 404, game traffic is WebSocket-only.
  The `Dockerfile` declares a Docker `HEALTHCHECK` that probes it with
  `node` (the `node:22-slim` base has no curl/wget), so Docker hosts like
  Coolify report container health automatically — leave Coolify's own
  "Enable Healthcheck" toggle **off** for the server, since its UI check
  shells out to curl, which isn't in the image.
- **Client** — an nginx `location = /health` in `Dockerfile.client`, plus a
  Docker `HEALTHCHECK` via busybox wget. Coolify's UI healthcheck also works
  here (scheme http, host localhost, port 80, path `/health`).

The server is **stateful**: rooms and the authoritative simulation live in the
Node process's memory. That rules out serverless/edge functions — it needs a
host that runs a persistent process. Run **exactly one** instance (no
horizontal autoscaling) unless you add a shared Colyseus presence/driver;
otherwise two instances can't see each other's rooms.

## 1. Server → Render (free) or Fly.io (paid) / Railway / a VPS

The repo ships a `Dockerfile` (server-only; runs `node --experimental-strip-types`,
no build step) and a `fly.toml`.

**Cost reality check:** none of the managed hosts have a standing free tier for
a long-lived process except Render. Fly and Railway are pay-as-you-go (Fly's old
free allowance survives only for grandfathered orgs); an always-on
`shared-cpu-1x`/512mb Fly machine runs roughly $3–4/month. Use Render free for
playtesting, Fly when the game needs to be reliably reachable.

### Render (free tier — what we use for testing)

**New → Web Service** → connect the repo → Render detects the root `Dockerfile`
and offers the **Docker** runtime. Take it: the image installs prod deps only and
skips the Vite/Phaser client toolchain. With Docker selected there is no build or
start command to set — the image's `CMD` is the entrypoint. Instance type Free,
region closest to your players, **no env vars needed** (Render injects `PORT`, and
`server/index.ts` reads it).

Free instances **spin down after 15 minutes with no inbound traffic**, and waking
one takes ~1 minute. Spun-down time doesn't burn the 750 free instance-hours/month,
and WebSocket messages from a live match count as traffic, so an in-progress game
keeps the server awake — you only eat the cold start on the first connect. The
client's first join attempt against a cold server may time out and look like a bug;
retry once.

To check the server is alive, hit the **matchmaking** endpoint — *not* `/`, which
hangs forever because Colyseus defines no root route:

```bash
curl -X POST -H 'Content-Type: application/json' -d '{}' \
  https://<app>.onrender.com/matchmake/joinOrCreate/match
```

Free instances are also shared and CPU-throttled. The server runs a fixed-tick sim
plus bot AI every tick; if a tick overruns its budget the whole simulation slows and
every client feels it — indistinguishable from network lag in the browser. Rule out
the host before chasing a netcode bug: if it's smooth against a local `npm run server`
and rough on Render free, that's the tier, not the code.

### Fly.io

```bash
fly launch --no-deploy      # once: creates the app from fly.toml
fly deploy                  # build + ship the Dockerfile
```

TLS (`wss://`) is automatic on `*.fly.dev` with `force_https = true`. Note the
app URL, e.g. `wss://breachpoint-server.fly.dev`.

`fly.toml` deliberately sets `auto_stop_machines = false` / `min_machines_running = 1`:
the server is stateful, so letting Fly scale it to zero would kill live matches. That
also means you pay for it continuously — there's no idle-to-zero saving here the way
there is for a stateless web app.

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

**Port:** the server listens on `$PORT` (default 2567). Render/Fly/Railway set
`$PORT` for you — never hardcode 2567 in a host's config.

## 2. Client → Netlify / Cloudflare Pages / Vercel

- Build command: `npm run build`
- Output directory: `dist`
- Environment variable: **`VITE_SERVER_URL`** = your server's `wss://` URL
  (e.g. `wss://breachpoint.onrender.com`). The client falls back to
  `ws://<page-host>:2567` only when it's unset (local dev).

Two ways this bites you:

- **Set it before the first build.** Vite inlines `import.meta.env` at build time —
  adding the variable to an already-built site does nothing until you redeploy.
- **It must be `wss://`**, not `https://` or `ws://`. The page is served over HTTPS
  and browsers block plaintext WebSocket connections from an HTTPS origin.

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

- Multi-instance scaling (Redis presence + driver). Note: the lobby's room
  browser (built-in Colyseus `LobbyRoom`, defined in `server/index.ts`)
  subscribes to the local matchmaker — with multiple instances it needs the
  Redis driver to see rooms across instances.
- Persistence / accounts / matchmaking rating.
