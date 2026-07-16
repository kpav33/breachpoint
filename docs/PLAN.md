# Top-Down 2D Counter-Strike — Implementation Plan

**Stack:** Phaser 3 · TypeScript · Vite · Tiled (map editor) · Colyseus + Node (Phase 9+)
**Strategy:** Bots-first, multiplayer-ready architecture from day one. Each phase ends with something playable.

**Locked-in design decisions:**

- **Vision:** ~110° view-cone in the aim direction + small 360° awareness circle (2–3 tiles). Implemented as full visibility polygon ∩ cone, behind a config flag — full-circle mode kept as an easy/testing option.
- **Economy:** simplified four-number model (start money, flat kill reward, win reward, escalating loss bonus). Full CS-style economy deferred to Phase 9+ when human teammates make save/force decisions meaningful.
- **Art direction:** flat geometric/vector style — circle players with weapon rect + direction notch, clean-lined walls, solid-color floors. No pixel art, no sprite animation frames. Visual appeal comes from the Phase 5 juice layer (tracers, shake, particles, decals). Rendering is decoupled from simulation, so real sprites can replace shapes later without touching game logic.

---

## Architecture Rules (read before every phase)

These three rules are what make Phase 9 (multiplayer) a bolt-on instead of a rewrite. Break them and you'll pay later.

1. **`src/core/` never imports Phaser.** It's pure TypeScript: plain-data state objects + functions that transform them. The future server runs this exact code.
2. **Input is data.** Keyboard/mouse produce `InputCommand` objects (`{tick, moveX, moveY, aimAngle, buttons}`). The simulation consumes commands; nothing else moves a player. Commands are what get sent over the wire later.
3. **Simulation runs on a fixed timestep** (e.g. 30 or 60 Hz ticks), rendering interpolates between ticks. Variable-dt physics makes deterministic server replay impossible.

```
Input devices → InputCommand → core/simulation.applyInput() → GameState
                                                                  ↓
                                    Phaser sprites/FX merely *render* GameState
```

---

## Phase 0 — Project Setup

**Goal:** Empty Phaser scene renders, tooling works.

- [x] `npm create vite@latest` (vanilla-ts template), install `phaser`
- [x] Folder skeleton per the agreed structure (`core/`, `game/`, `scenes/`, `match/`)
- [x] `main.ts` with Phaser config: `Phaser.AUTO`, pixelArt: true if going pixel style, scale mode `FIT`
- [x] BootScene → GameScene flow with a placeholder rectangle "player"
- [x] ESLint rule or convention check: nothing in `core/` may import from `phaser` or `game/`
- [x] Git repo, `.gitignore`
- [x] Debug overlay scaffold (toggle with backtick): starts as an FPS/tick counter. **Extend it every phase** — collision grid + player circle (Ph1), wall segments (Ph2), raycasts + spread cone (Ph3), visibility polygon outline + raw rays (Ph4), bot state labels + A\* paths + last-known-position markers (Ph6). The three hardest systems to debug (vision, raycasts, bot AI) are all invisible without this

**Done when:** `npm run dev` shows a scene with a movable-later rectangle at 60fps.

---

## Phase 1 — Core Simulation & Movement

**Goal:** A player that moves and collides, driven entirely by `core/`.

- [x] `core/types.ts`: `Vec2`, `PlayerState` (pos, vel, angle, hp, weaponId, ammo…), `InputCommand`, `GameState` (players, projectiles, tick)
- [x] `core/config.ts`: `TICK_RATE`, `MOVE_SPEED`, `PLAYER_RADIUS`, walk-vs-run speeds
- [x] `core/simulation.ts`: `applyInput(state, cmd, dt)` — normalize diagonal movement, apply velocity, resolve collision
- [x] `core/collision.ts`: circle-vs-tile-grid resolution (check the 4–9 tiles around the player, push out along shortest axis). Slide along walls, don't stick
- [x] Fixed-timestep loop in GameScene: accumulate `delta`, step simulation at `1/TICK_RATE`, render interpolated position (`lerp(prevPos, currPos, alpha)`)
- [x] `InputSystem.ts`: WASD → move vector, mouse → `aimAngle` (via `Phaser.Math.Angle.Between` from player screen pos to pointer), produce one `InputCommand` per tick
- [x] Player sprite rotates to `aimAngle`; camera follows player

**Gotchas:**

- Normalize the move vector _before_ scaling by speed, or diagonals are 41% faster.
- Aim angle must be computed in _world_ space (account for camera scroll), not raw pointer coords.

**Done when:** smooth WASD movement, mouse aiming, sliding along a hardcoded test wall grid.

---

## Phase 2 — Map Pipeline (Tiled)

**Goal:** Real maps authored in Tiled, loaded into both rendering and collision.

- [x] Install Tiled, make a small test map: layers `floor`, `walls`, object layers `spawns_t`, `spawns_ct`, `bombsites`
- [x] Export as JSON into `public/assets/maps/`
- [x] `MapLoader.ts`: load tilemap in Phaser for rendering **and** extract the walls layer into a plain `number[][]` collision grid for `core/`
- [x] Spawn points and bombsite rects parsed from object layers into `MapData`
- [x] Wall tiles also exported as a list of edge segments (or rects) — the raycaster in Phase 3/4 needs geometry, not just a grid. Merge adjacent tiles into longer segments for performance
- [x] Build one real map (a Dust2-style two-site layout works: mid, two lanes, connectors)

**Done when:** the map renders, the player collides with authored walls, spawn points work.

---

## Phase 3 — Shooting & Weapons

**Goal:** Hitscan gunplay with real weapon variety.

- [x] `core/raycast.ts`: segment-vs-segment and ray-vs-wall-segments intersection returning nearest hit point + distance. This function is shared with the vision system — write it once, well
- [x] `core/weapons.ts` + weapon table in `config.ts`: damage, fire rate, magazine, reload time, spread (base + bloom while moving/firing), range falloff, price, movement speed multiplier. Start with: knife, pistol, SMG, rifle, sniper
- [x] Fire logic in simulation: on `shoot` button, if fire-rate timer elapsed and ammo > 0 → cast ray from player at `aimAngle + randomSpread`, check wall hit vs player-circle hits (nearest wins), apply damage
- [x] Reload (R), weapon switching (1/2/3 + scroll), ammo tracking in `PlayerState`
- [x] Death: hp ≤ 0 → mark dead, drop to spectator-ish state (respawn instantly for now; rounds come in Phase 7)
- [x] Rendering side (`EffectsSystem`): tracer line (fade over ~60ms), muzzle flash, impact spark on walls, hit marker on player hits

**Gotchas:**

- Spread should be an _angle_ offset, not a position offset, or accuracy behaves weirdly at range.
- Ray-vs-player: closest-point-on-segment to circle center; compare distance to `PLAYER_RADIUS`.
- Don't let the shooter's own circle block their ray (skip self).

**Done when:** you can shoot a dummy target, weapons feel distinct, tracers and impacts render.

---

## Phase 4 — Vision / Fog of War

**Goal:** The CS feel — you only see what your character can see.

- [x] Visibility polygon in `core/` or `game/systems/VisionSystem.ts`: cast rays to every wall-segment corner (± tiny epsilon angles), sort hit points by angle, build polygon. Red Blob Games' "2D Visibility" article is the reference implementation
- [x] Render: draw polygon into a `Graphics`/RenderTexture used as a **geometry mask** over a darkness layer (or invert: darkness everywhere, punch out the polygon)
- [x] **View-cone (decided):** intersect the visibility polygon with a ~110° cone around `aimAngle`, plus a 360° awareness circle of 2–3 tiles radius around the player. Cone angle, awareness radius, and a `fullCircleVision` toggle all live in `core/config.ts` for playtesting
- [x] Enemies inside the awareness circle are always visible regardless of facing (prevents cheap point-blank backstabs feeling unfair)
- [x] Enemy culling: enemies (and their tracers/sounds markers) only render if inside the visibility polygon — a point-in-polygon test, or cheaper: single raycast player→enemy checking wall occlusion
- [x] Performance pass: only recompute when the player moves/rotates beyond a threshold; only consider wall segments within screen radius

**Gotchas:**

- Cast 3 rays per corner (angle − ε, angle, angle + ε) or the polygon flickers at edges.
- This is the most fiddly math in the project. Budget a full session for debugging; render the raw rays while developing.

**Done when:** walls block sight, enemies pop in/out of view correctly, stable 60fps.

---

## Phase 5 — Game Feel & Audio

**Goal:** Make shooting _feel_ good before adding brains and rules.

- [x] Screen shake (small, on firing heavy weapons and taking damage)
- [x] Camera recoil nudge opposite to aim on fire
- [x] Blood decals / wall bullet-hole decals (RenderTexture stamps, cap the count)
- [x] Shell casing particles
- [x] Audio sourcing: Kenney.nl audio packs (CC0, shippable), Freesound.org (verify licenses), or jsfxr/bfxr for generated placeholder effects. Grab a full placeholder set in one sitting rather than hunting per-sound
  - **Current state: synthesized placeholders** from `tools/generate-audio.mjs`. Before shipping (Phase 8 polish at the latest), replace the WAVs in `public/assets/audio/` with real assets (Kenney.nl is the shippable CC0 option) — same filenames, no code changes needed. See `public/assets/audio/README.md` for the file list.
- [x] Audio: per-weapon gunshots, reload, footsteps (rate tied to speed), hit confirm, death. Distance-based volume + pan for other players' sounds
- [x] Footstep sounds of _unseen_ enemies are a core CS mechanic — play them positionally even when the enemy isn't rendered
- [ ] Damage direction indicator on HUD — **not implemented** (only remaining Phase 5 item)

**Done when:** a 60-second clip of you shooting a dummy looks and sounds satisfying.

---

## Phase 6 — Bots

**Goal:** Opponents worth playing against.

- [x] `pathfinding.ts`: A\* over the collision grid (diagonals allowed with corner-cut check). Path smoothing: skip waypoints if a raycast between them is clear
- [x] `BotController.ts` state machine:
  - **PATROL / MOVE_TO_OBJECTIVE** — pick target (bombsite, roam waypoint), follow A\* path
  - **ENGAGE** — enemy visible (use the same raycast LOS check): aim with error, fire in bursts, strafe
  - **HUNT** — lost sight: move to last-known-position, then search nearby
  - **RETREAT** (optional) — low hp: fall back
- [x] Bot "vision": LOS raycast + field-of-view cone + reaction delay (200–500ms before first shot) — this alone creates believable difficulty
- [x] Aim error: gaussian angle offset that shrinks the longer the target is visible; scales with difficulty setting
- [x] Hearing: gunshots/footsteps within radius set last-known-position
- [x] Bots consume the same `InputCommand` interface — a bot is just another command producer feeding the simulation. **Do not** let bots mutate state directly
- [x] Difficulty presets (reaction time, aim error, hp awareness)

**Done when:** a 1v3 deathmatch vs bots is genuinely fun and occasionally kills you.

---

## Phase 7 — Match Structure (the CS package)

**Goal:** Rounds, economy, bomb defuse.

- [x] `MatchState.ts`: phases `WARMUP → BUY → LIVE → ROUND_END → (repeat) → MATCH_END`, round timer, score, first-to-13 (or configurable)
- [x] Teams: T / CT, team spawns from map data, friendly-fire toggle
- [x] Economy (simplified, per design decisions): four numbers in `config.ts` — `START_MONEY`, flat `KILL_REWARD`, `WIN_REWARD`, and `LOSS_BONUS` escalating per consecutive loss (reset on win). Money cap. Keep weapon list at 5–8 items so the buy menu is one screen. Full CS economy (per-weapon kill rewards, utility meta) is a Phase 9+ backlog item
- [x] Buy menu (UIScene or React overlay): only during BUY phase, in spawn zone
- [x] Bomb: T-side carrier, plant (hold E in bombsite, ~3s), 40s timer, defuse (hold E, 10s / 5s with kit), explosion kills in radius, win conditions (elimination, detonation, defusal, time expiry)
- [x] Dead players spectate teammates until round end (no respawn during LIVE)
- [x] HUD: hp/armor, ammo, money, round timer, alive counts, bomb-planted state, kill feed
- [x] Bot objective logic: Ts move to a site and plant, CTs rotate/defend — wire objectives into the Phase 6 state machine
- [x] Scoreboard (Tab): kills/deaths/money

**Done when:** a full 13-round match vs bots plays start to finish with economy and bomb logic working.

---

## Phase 8 — Content & Polish (pre-multiplayer checkpoint)

- [x] Second map
- [x] 2–3 more weapons + grenades (grenades are _projectile entities_ in the simulation: HE = radial damage, flash = whiteout if in view polygon + facing, smoke = temporary wall segments for the vision system — this is a very satisfying trick)
- [x] Armor/helmet purchase, damage model with armor _(implemented as a single `armor` buy item with `ARMOR_ABSORPTION` damage soak — no separate helmet/headshot model)_
- [x] Minimap (scaled-down render of walls + teammate dots)
- [ ] Settings: volume ✓ (+ bot difficulty, persisted in `src/game/settings.ts`) — **sensitivity and keybinds not implemented**
- [x] Menu flow polish, pause

**This is a legitimate "ship it" point for a single-player game.**

---

## Phase 9 — Multiplayer

**Goal:** Authoritative online PvP reusing `core/` unchanged.

### 9a. Server foundation

- [x] Monorepo restructure: went with the simpler option — `server/` imports `src/core` + `src/match` via relative paths, runs under `node --experimental-strip-types` (no build step)
- [x] Colyseus room (`server/MatchRoom.ts`): fixed-tick loop (same `TICK_RATE`), runs `core/simulation` + `match/MatchState` as the source of truth
- [x] Clients send `InputCommand`s (with client tick numbers); server buffers per-player queues and applies them (one per tick, one-shot buttons never repeated), broadcasts full-state snapshots at `SNAPSHOT_RATE` (15/s)
- [x] Naive first pass: `OnlineGameScene` (subclass of GameScene — fog/effects/audio/HUD reused) renders raw snapshots (it will feel laggy — that's expected, it proves the pipe works)

### 9b. Netcode quality

- [x] **Client-side prediction:** client runs the same simulation locally for _its own_ player immediately on input (movement + aim only — firing/reload/switches stay server-authoritative so effects never double)
- [x] **Server reconciliation:** snapshots include last-processed input tick (`acks`); client rewinds to server state and replays unacknowledged inputs (`OnlineGameScene.reconcile`)
- [x] **Entity interpolation:** remote players + grenades render `INTERP_DELAY_MS` (100ms) in the past, lerping between the two surrounding snapshots
- [x] **Lag compensation for hits:** server keeps `LAG_COMP_MAX_REWIND_SEC` (1s) of position history; each input carries the client's interpolated `viewTick` and shots resolve against targets rewound to it
- [ ] Reference reading: Gabriel Gambetta "Fast-Paced Multiplayer" parts 1–4; Valve's Source Multiplayer Networking article

### 9c. Meta

- [x] Lobby (`LobbyScene`): Quick Play (public matchmaking), Host Private (share code), Join by Code. A browsable live room list needs a Colyseus `LobbyRoom` — deferred to Phase 10 (see `docs/DEPLOY.md`).
- [x] Server-side validation: input intent clamped ([-1,1] move, uint32 buttons), buy legality via `tryBuy` (phase/team/money) — hardened against prototype-key injection (`__proto__`/`toString`) with an own-property check. Speed/fire-rate can't be forged since the server owns the sim.
- [x] Fill empty slots with bots: shared `BotController` + `assignBotObjectives` (moved to `src/ai/`, runs headless on the server). Teams kept at `TEAM_SIZE`; humans replace bots on join, bots backfill on leave.
- [x] Deploy: `Dockerfile` (server-only, type-stripping, no build step), `fly.toml`, `docs/DEPLOY.md` (Fly/Railway/VPS + Cloudflare Pages, `VITE_SERVER_URL`, wss, CORS).

**Done when:** two browsers on different networks play a full match with hit registration that feels fair at ~80ms ping. _(Deployed and playable online — server on Render free, client on Netlify. Pipe works end-to-end; it's noticeably laggy, but Render's free tier is shared/CPU-throttled and the fixed-tick sim + bots may not fit in a tick there, so the netcode itself isn't yet fairly measured. Retest against a local server and/or a paid instance before tuning netcode.)_

---

## Phase 9.5 — Netcode validation, telemetry & hardening (next up)

The multiplayer pipe works end-to-end but has never been fairly measured (see the
Phase 9 done-when note), and players currently get zero feedback about connection
quality. This phase is about knowing — and showing — whether the game feels bad
because of the connection, the server tier, or the code.

### Measurement first (dev-facing)

- [x] **Server tick instrumentation:** time each tick (rolling avg/max ms), log it and expose it to clients. This settles "is the sim + bots overrunning the tick budget on Render free?" permanently — a tick overrun is indistinguishable from network lag in the browser — `MatchRoom` keeps a rolling `PERF_WINDOW_SEC` window (avg/max tick ms, bot ms, achieved TPS), logs it every ~10 s, and ships it in every snapshot as `Snapshot.perf`
- [ ] **Fair netcode retest:** two browsers vs a local `npm run server`, then vs a small paid instance. Only after this do we know whether prediction/reconciliation/interp need tuning at all
- [x] **net_graph-style debug panel** (extend the backtick overlay, per convention): RTT, snapshot arrival rate, interp buffer depth, reconciliation corrections/sec, bytes in/out per second. Build this first — it *is* the measurement tool; the player-facing HUD below is its polished subset — `OnlineGameScene.extendDebug()` adds `net rtt / net snap / net recon / net traffic / server` lines (traffic is ≈JSON size of decoded messages, not wire bytes)
- [x] **Per-tick cost profiling + bot staggering:** bot LOS raycasts and A\* repaths are the likely hot spots; stagger bot thinking (each bot thinks every Nth tick) — standard, low-risk win that directly helps cheap hosting — bot time is profiled separately in `Snapshot.perf.botMs`; the LOS raycast scan runs every `BOT_SCAN_EVERY_TICKS` (offset per bot), while hearing/movement/aim still update every tick

### Player-facing telemetry (standard competitive-game UX)

- [x] **Ping (RTT):** `MSG_PING`/`MSG_PONG` pair in `protocol.ts` — client sends a timestamp every ~2s (`PING_INTERVAL_MS`), server echoes, client keeps a rolling average. Colyseus doesn't measure this for us. Shown on the debug panel; the HUD readout below is still open
- [x] **HUD ping display** (corner readout) + **per-player ping column on the Tab scoreboard** (server collects everyone's RTT, includes it in snapshots) — clients piggyback their rolling RTT on `MSG_PING`; the server relays them as `Snapshot.pings`. Bots render as "BOT"; offline games hide the readout and the column entirely
- [x] **Connection-quality indicator:** "connection problem" icon when the interpolation buffer runs dry / snapshots arrive late (client watches inter-arrival times against the fixed 15/s `SNAPSHOT_RATE`). Reconciliation already knows when predictions diverge — corrections/sec is a free health metric — blinking warning under the score line: "CONNECTION PROBLEM" when the newest snapshot is >3 intervals old, "SERVER OVERLOADED" when `Snapshot.perf.tps` drops under 90% of `TICK_RATE` (corrections/sec stayed debug-panel-only — it's a tuning signal, not a player-facing one)
- [x] **Server tick health in snapshots** (actual achieved TPS): lets the client distinguish "my connection is bad" from "the server is overloaded" — given the free-tier hosting, arguably the most valuable single number to show — `Snapshot.perf` (tick avg/max ms, bot ms, TPS); surfaced on the debug panel, not yet on the player HUD

### CS-staple gameplay gaps (audited 2026-07 — these are absent from the code)

- [x] **Halftime side swap:** no team-swap logic exists in `src/match/` — a first-to-13 match plays every round on the same side, which is unfair on asymmetric defuse maps. Swap teams (and reset economy) after round 12. Biggest gameplay gap. Note: adding halftime makes a 12–12 draw possible — decide draw vs simple overtime then (today first-to-13 with no swap can't draw) — **done:** `swapSides()` in MatchState fires after roundsToWin−1 rounds (scores follow the players, economy/streaks/gear reset, `halftime` event → SWITCHING SIDES banner + roster/view rebuild on both client and server). 12–12 (generally (rtw−1)-all) is a **draw** (`match_end` with `winner: null`, "MATCH DRAWN" banner); overtime stays a backlog idea
- [x] **Weapon drop / pickup:** only the *bomb* drops on death (`MatchState`). Guns should drop as world entities and be picked up by walking over them (+ manual drop key, G) — eco-round scavenging and passing a teammate a rifle are core CS economy moves — **done:** `DroppedWeapon` entities in MatchState (ammo preserved); death drops the best gun, G drops the active one (tossed ~40 px ahead, wall-checked), walk-over pickup when the slot is free, floor cleared at round start. **Key change: HE grenade moved G → X** to free G for drop (proper rebinding comes with the keybind-settings item)
- [ ] **Damage direction indicator** (carried over from Phase 5 — still the only unbuilt Phase 5 item)
- [ ] **Mouse sensitivity + keybind settings** (carried over from Phase 8 — settings panel only has volume and bot difficulty)

### Multiplayer product gaps

- [ ] **Reconnect handling:** no `allowReconnection` on the server — a browser refresh or Wi-Fi blip mid-match permanently replaces the player with a bot. Grace window (~60s) where the seat is held and the player can rejoin with money/score intact
- [ ] **In-game chat:** nothing in the protocol. Minimal all-chat + team chat (with basic rate limiting); expected in anything competitive

### Hardening

- [ ] **Tests for `src/core/` + `src/match/`** (vitest — currently there are none): collision resolution, raycast intersections, spread/damage falloff, `tryBuy` incl. the `__proto__` injection case, economy math, bomb timing. This is the code both client and server share — exactly where a regression silently breaks multiplayer fairness. *Started:* `tests/*.test.mjs` (halftime/draw, weapon drop/pickup) run via `npm test` on the plain node runner — port/extend these when vitest lands
- [ ] **Replay-based regression tests:** record an input stream, replay it through the deterministic sim, assert the final state (hash). Doubles as groundwork for Phase 10 demo/replay recording
- [ ] **Real audio assets:** replace the synthesized WAVs in `public/assets/audio/` (Kenney.nl CC0) — same filenames, no code changes; overdue per the Phase 5 note
- [ ] **Protocol version handshake:** add a `PROTOCOL_VERSION` constant to `protocol.ts`, sent in join options and checked in `onAuth`/`onJoin` — the deployed client (Netlify) and server (Render) ship independently, so a wire-format change silently breaks live clients with confusing symptoms instead of a clear "please refresh" error
- [ ] **CI (GitHub Actions):** no workflows exist — run `npm run lint` + `npm run build` (+ tests once they exist) on push, so a broken commit can't reach the deploy hooks unnoticed

---

## Phase 10 — Post-launch niceties (backlog)

Browsable live room list in the lobby (needs a Colyseus `LobbyRoom` — deferred from Phase 9c) · spectator mode with free camera · demo/replay recording (store input streams — cheap, since sim is deterministic; the Phase 9.5 replay tests lay the groundwork) · basic stats persistence · Elo/matchmaking · mobile touch controls · Steam-style skins if you hate free time.

**2.5D look (worth a prototype):** keep the top-down camera and the 2D sim exactly as-is, but render walls with fake height — floor footprint + extruded side faces shearing away from the camera center (GTA1/Hotline Miami style), plus drop shadows under players. Pure rendering change confined to `MapLoader`/the render layer: world x/y still maps straight to screen x/y, so aiming, fog, and the minimap keep working untouched. Prototype on one map before committing; do it after the Phase 9.5 replay tests exist to prove the sim stayed untouched.

**Utility practice mode** (the CS "grenade practice map" experience — learning lineups is core to competitive play): an offline sandbox on any map with no bots/rounds, infinite money and grenades, a toggleable grenade trajectory preview (draw the predicted arc + landing spot before throwing — the sim's projectile step is deterministic, so the client can just dry-run it), post-throw trail rendering, smoke/flash coverage visualization, and a "rethrow last grenade" key. Most of it is client-only debug-overlay-style drawing on top of the existing offline GameScene.

---

## Starter Weapon Table (tune later)

| Weapon | Dmg | RPM | Mag | Reload | Spread° | Price | Speed× |
| ------ | --- | --- | --- | ------ | ------- | ----- | ------ |
| Knife  | 35  | 120 | —   | —      | —       | free  | 1.10   |
| Pistol | 26  | 300 | 12  | 1.8s   | 1.5     | free  | 1.00   |
| SMG    | 20  | 750 | 30  | 2.2s   | 3.0     | $1200 | 1.00   |
| Rifle  | 33  | 600 | 30  | 2.5s   | 2.0     | $2700 | 0.93   |
| Sniper | 110 | 40  | 10  | 3.0s   | 0.1     | $4750 | 0.85   |

## Key References

- Red Blob Games — 2D Visibility (visibility polygon algorithm)
- Gabriel Gambetta — Fast-Paced Multiplayer series (prediction/reconciliation/interpolation)
- Valve Developer Wiki — Source Multiplayer Networking (lag compensation)
- Phaser 3 examples site + Tiled docs (tilemap workflow)
- Red Blob Games — A\* pathfinding introduction

## Suggested Milestone Cadence

Each phase is roughly 1–3 focused weekends. Sequence is dependency-ordered: 0→1→2→3 are strict prerequisites; 4/5/6 can be shuffled; 7 needs 6; 9 needs everything and rewards the discipline of rules 1–3.
