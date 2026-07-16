# Top-Down 2D Tactical Shooter (CS-style)

Top-down 2D Counter-Strike-like: round-based bomb defuse vs bots first, online multiplayer later. Flat geometric/vector art style.

**Stack:** Phaser 3 · TypeScript · Vite · Tiled maps · Colyseus + Node (later phases only)

## Implementation plan

The full phased plan lives in `docs/PLAN.md`. Before starting any work, read the current phase (and its "Gotchas") there. Work on ONE phase at a time — never implement ahead of the phase the user asked for. The "Locked-in design decisions" section at the top of the plan is final; do not revisit those choices.

## Architecture rules (non-negotiable, multiplayer depends on them)

1. **`src/core/` never imports Phaser** (or anything from `src/game/`, `src/scenes/`, or the DOM). It is pure TypeScript: plain-data state + functions that transform it. A future Node server will import and run this code unchanged. Enforced by ESLint `no-restricted-imports` — never weaken that rule to make something compile.
2. **Input is data.** Devices and bots produce `InputCommand` objects; only `core/simulation.applyInput()` mutates player state. Nothing else moves a player — not tweens, not physics callbacks, not bot code.
3. **Fixed-timestep simulation** at `TICK_RATE` from `core/config.ts`; rendering interpolates between ticks. Never step the simulation with a variable dt.

## Structure map

- `src/core/` — pure simulation: types, config, simulation, collision, raycast, weapons
- `src/ai/` — headless bot brains (`BotController`) + objective assignment, shared by client and server (no Phaser)
- `src/game/` — Phaser-side: entities, systems (input, vision, effects, audio), map loading
- `src/scenes/` — Boot, Menu, Lobby, Game (thin orchestrator; OnlineGame and Practice subclass it), UI (HUD, parallel scene), Pause (overlay)
- `src/match/` — rounds, economy, bomb logic, game modes (headless — runs on the server)
- `src/net/` — wire protocol (`protocol.ts`, shared with the server) + browser Colyseus client wrapper
- `server/` — authoritative Colyseus server; imports `src/core` + `src/match` + `src/ai` via relative paths, no Phaser (ESLint-enforced)
- `public/assets/` — sprites, Tiled map JSON, tilesets, audio

## Commands

- `npm run dev` — Vite dev server
- `npm run server` (alias `npm start`) — Colyseus game server on port 2567 (`PORT` env overrides; client reads `VITE_SERVER_URL`, defaulting to `ws://<page-host>:2567`)
- `npm run build` — production build (typechecks client, server, then bundles the client)
- `npm run lint` — ESLint (includes the core/ and server/ import restrictions)
- `npm test` — headless match-logic tests (`tests/*.test.mjs`, plain node runner, no Phaser)
- Deploy: `Dockerfile` + `fly.toml` ship the server; see `docs/DEPLOY.md` (server on Fly/Railway/VPS, client on a CDN)
- `node tools/generate-map.mjs` — regenerate all maps (`de_yard`, `de_split`, `de_cross`, `de_docks`) + `tiles.png` from the layouts defined in the script (maps are Tiled-format JSON, editable in Tiled once real authoring starts; new maps also go in `MAPS` in `MapLoader.ts`)
- `node tools/generate-audio.mjs` — regenerate the placeholder sound set in `public/assets/audio/` (synthesized WAVs; swap files for real assets without code changes)
<!-- Update this section as commands are added (tests, typecheck, etc.) -->

## Workflow

- Server-shared code (`src/core/`, `src/match/`, `src/ai/`, `src/net/protocol.ts`) runs unbuilt under `node --experimental-strip-types`. Two rules there: relative imports use explicit `.ts` extensions (e.g. `from './types.ts'`), and **no TypeScript parameter properties** in constructors (strip-only mode rejects them) — declare fields explicitly and assign in the body.
- Never index a lookup table (e.g. `WEAPONS`) with an untrusted string: `obj[key]`/`key in obj` match inherited keys like `__proto__`/`toString`. Use `Object.prototype.hasOwnProperty.call(obj, key)` before indexing (see `tryBuy`).
- Gameplay constants (speeds, weapon stats, cone angle, economy numbers) always live in `core/config.ts` — never hardcode them at usage sites.
- The canvas is oversampled for hi-DPI screens (`src/game/display.ts`): every scene's `create()` starts with `applyHiDPI(this)`, and layout code uses the logical `GAME_WIDTH`/`GAME_HEIGHT` constants — never `this.scale.width/height` (those return the oversampled backing-store size). Any `setScrollFactor(0)` object must be positioned through `screenX()`/`screenY()` from `display.ts` — the camera zoom scales scroll-fixed objects around the canvas center, so raw logical coords land in the wrong place whenever DPR > 1.
- Render-side colors and fonts always come from `src/game/theme.ts` tokens (the visual system spec lives in `design/`; brief in `docs/DESIGN_BRIEF.md`) — never invent one-off hex values in game code. World tile colors in `tools/generate-map.mjs` mirror `theme.ts` WORLD and must stay in sync.
- Extend the debug overlay (backtick toggle) whenever you add a system that has invisible state (rays, polygons, bot states, paths).
- After completing a phase: run lint + build, summarize what changed, and update this file if commands or conventions changed. Do not start the next phase unprompted.
