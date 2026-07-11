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

- [ ] `npm create vite@latest` (vanilla-ts template), install `phaser`
- [ ] Folder skeleton per the agreed structure (`core/`, `game/`, `scenes/`, `match/`)
- [ ] `main.ts` with Phaser config: `Phaser.AUTO`, pixelArt: true if going pixel style, scale mode `FIT`
- [ ] BootScene → GameScene flow with a placeholder rectangle "player"
- [ ] ESLint rule or convention check: nothing in `core/` may import from `phaser` or `game/`
- [ ] Git repo, `.gitignore`
- [ ] Debug overlay scaffold (toggle with backtick): starts as an FPS/tick counter. **Extend it every phase** — collision grid + player circle (Ph1), wall segments (Ph2), raycasts + spread cone (Ph3), visibility polygon outline + raw rays (Ph4), bot state labels + A* paths + last-known-position markers (Ph6). The three hardest systems to debug (vision, raycasts, bot AI) are all invisible without this

**Done when:** `npm run dev` shows a scene with a movable-later rectangle at 60fps.

---

## Phase 1 — Core Simulation & Movement

**Goal:** A player that moves and collides, driven entirely by `core/`.

- [ ] `core/types.ts`: `Vec2`, `PlayerState` (pos, vel, angle, hp, weaponId, ammo…), `InputCommand`, `GameState` (players, projectiles, tick)
- [ ] `core/config.ts`: `TICK_RATE`, `MOVE_SPEED`, `PLAYER_RADIUS`, walk-vs-run speeds
- [ ] `core/simulation.ts`: `applyInput(state, cmd, dt)` — normalize diagonal movement, apply velocity, resolve collision
- [ ] `core/collision.ts`: circle-vs-tile-grid resolution (check the 4–9 tiles around the player, push out along shortest axis). Slide along walls, don't stick
- [ ] Fixed-timestep loop in GameScene: accumulate `delta`, step simulation at `1/TICK_RATE`, render interpolated position (`lerp(prevPos, currPos, alpha)`)
- [ ] `InputSystem.ts`: WASD → move vector, mouse → `aimAngle` (via `Phaser.Math.Angle.Between` from player screen pos to pointer), produce one `InputCommand` per tick
- [ ] Player sprite rotates to `aimAngle`; camera follows player

**Gotchas:**
- Normalize the move vector *before* scaling by speed, or diagonals are 41% faster.
- Aim angle must be computed in *world* space (account for camera scroll), not raw pointer coords.

**Done when:** smooth WASD movement, mouse aiming, sliding along a hardcoded test wall grid.

---

## Phase 2 — Map Pipeline (Tiled)

**Goal:** Real maps authored in Tiled, loaded into both rendering and collision.

- [ ] Install Tiled, make a small test map: layers `floor`, `walls`, object layers `spawns_t`, `spawns_ct`, `bombsites`
- [ ] Export as JSON into `public/assets/maps/`
- [ ] `MapLoader.ts`: load tilemap in Phaser for rendering **and** extract the walls layer into a plain `number[][]` collision grid for `core/`
- [ ] Spawn points and bombsite rects parsed from object layers into `MapData`
- [ ] Wall tiles also exported as a list of edge segments (or rects) — the raycaster in Phase 3/4 needs geometry, not just a grid. Merge adjacent tiles into longer segments for performance
- [ ] Build one real map (a Dust2-style two-site layout works: mid, two lanes, connectors)

**Done when:** the map renders, the player collides with authored walls, spawn points work.

---

## Phase 3 — Shooting & Weapons

**Goal:** Hitscan gunplay with real weapon variety.

- [ ] `core/raycast.ts`: segment-vs-segment and ray-vs-wall-segments intersection returning nearest hit point + distance. This function is shared with the vision system — write it once, well
- [ ] `core/weapons.ts` + weapon table in `config.ts`: damage, fire rate, magazine, reload time, spread (base + bloom while moving/firing), range falloff, price, movement speed multiplier. Start with: knife, pistol, SMG, rifle, sniper
- [ ] Fire logic in simulation: on `shoot` button, if fire-rate timer elapsed and ammo > 0 → cast ray from player at `aimAngle + randomSpread`, check wall hit vs player-circle hits (nearest wins), apply damage
- [ ] Reload (R), weapon switching (1/2/3 + scroll), ammo tracking in `PlayerState`
- [ ] Death: hp ≤ 0 → mark dead, drop to spectator-ish state (respawn instantly for now; rounds come in Phase 7)
- [ ] Rendering side (`EffectsSystem`): tracer line (fade over ~60ms), muzzle flash, impact spark on walls, hit marker on player hits

**Gotchas:**
- Spread should be an *angle* offset, not a position offset, or accuracy behaves weirdly at range.
- Ray-vs-player: closest-point-on-segment to circle center; compare distance to `PLAYER_RADIUS`.
- Don't let the shooter's own circle block their ray (skip self).

**Done when:** you can shoot a dummy target, weapons feel distinct, tracers and impacts render.

---

## Phase 4 — Vision / Fog of War

**Goal:** The CS feel — you only see what your character can see.

- [ ] Visibility polygon in `core/` or `game/systems/VisionSystem.ts`: cast rays to every wall-segment corner (± tiny epsilon angles), sort hit points by angle, build polygon. Red Blob Games' "2D Visibility" article is the reference implementation
- [ ] Render: draw polygon into a `Graphics`/RenderTexture used as a **geometry mask** over a darkness layer (or invert: darkness everywhere, punch out the polygon)
- [ ] **View-cone (decided):** intersect the visibility polygon with a ~110° cone around `aimAngle`, plus a 360° awareness circle of 2–3 tiles radius around the player. Cone angle, awareness radius, and a `fullCircleVision` toggle all live in `core/config.ts` for playtesting
- [ ] Enemies inside the awareness circle are always visible regardless of facing (prevents cheap point-blank backstabs feeling unfair)
- [ ] Enemy culling: enemies (and their tracers/sounds markers) only render if inside the visibility polygon — a point-in-polygon test, or cheaper: single raycast player→enemy checking wall occlusion
- [ ] Performance pass: only recompute when the player moves/rotates beyond a threshold; only consider wall segments within screen radius

**Gotchas:**
- Cast 3 rays per corner (angle − ε, angle, angle + ε) or the polygon flickers at edges.
- This is the most fiddly math in the project. Budget a full session for debugging; render the raw rays while developing.

**Done when:** walls block sight, enemies pop in/out of view correctly, stable 60fps.

---

## Phase 5 — Game Feel & Audio

**Goal:** Make shooting *feel* good before adding brains and rules.

- [ ] Screen shake (small, on firing heavy weapons and taking damage)
- [ ] Camera recoil nudge opposite to aim on fire
- [ ] Blood decals / wall bullet-hole decals (RenderTexture stamps, cap the count)
- [ ] Shell casing particles
- [ ] Audio sourcing: Kenney.nl audio packs (CC0, shippable), Freesound.org (verify licenses), or jsfxr/bfxr for generated placeholder effects. Grab a full placeholder set in one sitting rather than hunting per-sound
- [ ] Audio: per-weapon gunshots, reload, footsteps (rate tied to speed), hit confirm, death. Distance-based volume + pan for other players' sounds
- [ ] Footstep sounds of *unseen* enemies are a core CS mechanic — play them positionally even when the enemy isn't rendered
- [ ] Damage direction indicator on HUD

**Done when:** a 60-second clip of you shooting a dummy looks and sounds satisfying.

---

## Phase 6 — Bots

**Goal:** Opponents worth playing against.

- [ ] `pathfinding.ts`: A* over the collision grid (diagonals allowed with corner-cut check). Path smoothing: skip waypoints if a raycast between them is clear
- [ ] `BotController.ts` state machine:
  - **PATROL / MOVE_TO_OBJECTIVE** — pick target (bombsite, roam waypoint), follow A* path
  - **ENGAGE** — enemy visible (use the same raycast LOS check): aim with error, fire in bursts, strafe
  - **HUNT** — lost sight: move to last-known-position, then search nearby
  - **RETREAT** (optional) — low hp: fall back
- [ ] Bot "vision": LOS raycast + field-of-view cone + reaction delay (200–500ms before first shot) — this alone creates believable difficulty
- [ ] Aim error: gaussian angle offset that shrinks the longer the target is visible; scales with difficulty setting
- [ ] Hearing: gunshots/footsteps within radius set last-known-position
- [ ] Bots consume the same `InputCommand` interface — a bot is just another command producer feeding the simulation. **Do not** let bots mutate state directly
- [ ] Difficulty presets (reaction time, aim error, hp awareness)

**Done when:** a 1v3 deathmatch vs bots is genuinely fun and occasionally kills you.

---

## Phase 7 — Match Structure (the CS package)

**Goal:** Rounds, economy, bomb defuse.

- [ ] `MatchState.ts`: phases `WARMUP → BUY → LIVE → ROUND_END → (repeat) → MATCH_END`, round timer, score, first-to-13 (or configurable)
- [ ] Teams: T / CT, team spawns from map data, friendly-fire toggle
- [ ] Economy (simplified, per design decisions): four numbers in `config.ts` — `START_MONEY`, flat `KILL_REWARD`, `WIN_REWARD`, and `LOSS_BONUS` escalating per consecutive loss (reset on win). Money cap. Keep weapon list at 5–8 items so the buy menu is one screen. Full CS economy (per-weapon kill rewards, utility meta) is a Phase 9+ backlog item
- [ ] Buy menu (UIScene or React overlay): only during BUY phase, in spawn zone
- [ ] Bomb: T-side carrier, plant (hold E in bombsite, ~3s), 40s timer, defuse (hold E, 10s / 5s with kit), explosion kills in radius, win conditions (elimination, detonation, defusal, time expiry)
- [ ] Dead players spectate teammates until round end (no respawn during LIVE)
- [ ] HUD: hp/armor, ammo, money, round timer, alive counts, bomb-planted state, kill feed
- [ ] Bot objective logic: Ts move to a site and plant, CTs rotate/defend — wire objectives into the Phase 6 state machine
- [ ] Scoreboard (Tab): kills/deaths/money

**Done when:** a full 13-round match vs bots plays start to finish with economy and bomb logic working.

---

## Phase 8 — Content & Polish (pre-multiplayer checkpoint)

- [ ] Second map
- [ ] 2–3 more weapons + grenades (grenades are *projectile entities* in the simulation: HE = radial damage, flash = whiteout if in view polygon + facing, smoke = temporary wall segments for the vision system — this is a very satisfying trick)
- [ ] Armor/helmet purchase, damage model with armor
- [ ] Minimap (scaled-down render of walls + teammate dots)
- [ ] Settings: volume, sensitivity, keybinds
- [ ] Menu flow polish, pause

**This is a legitimate "ship it" point for a single-player game.**

---

## Phase 9 — Multiplayer

**Goal:** Authoritative online PvP reusing `core/` unchanged.

### 9a. Server foundation
- [ ] Monorepo restructure: `packages/core` (the existing `src/core/`), `packages/client`, `packages/server` — or simpler: server imports core via relative path/workspace
- [ ] Colyseus room: fixed-tick loop (same `TICK_RATE`), runs `core/simulation` as the source of truth
- [ ] Clients send `InputCommand`s (with client tick numbers); server buffers and applies them, broadcasts snapshots ~10–20×/s
- [ ] Naive first pass: client renders raw snapshots (it will feel laggy — that's expected, it proves the pipe works)

### 9b. Netcode quality
- [ ] **Client-side prediction:** client runs the same simulation locally for *its own* player immediately on input
- [ ] **Server reconciliation:** snapshots include last-processed input tick; client rewinds to server state and replays unacknowledged inputs. If you kept `core/` pure, this is ~50 lines
- [ ] **Entity interpolation:** render *other* players ~100ms in the past, lerping between the two surrounding snapshots
- [ ] **Lag compensation for hits:** server keeps ~1s of position history; when a shot arrives, rewind targets to `clientTime − interpolationDelay` before raycasting
- [ ] Reference reading: Gabriel Gambetta "Fast-Paced Multiplayer" parts 1–4; Valve's Source Multiplayer Networking article

### 9c. Meta
- [ ] Lobby / room list / join by code (Colyseus handles most of this)
- [ ] Server-side validation: clamp move speeds, fire rates, buy legality (never trust the client — you already don't, since the server owns the sim)
- [ ] Fill empty slots with bots (they already speak `InputCommand`)
- [ ] Deploy: Node server on a VPS/Fly.io/Railway; static client on any CDN. WebSocket + HTTPS (wss)

**Done when:** two browsers on different networks play a full match with hit registration that feels fair at ~80ms ping.

---

## Phase 10 — Post-launch niceties (backlog)

Spectator mode with free camera · demo/replay recording (store input streams — cheap, since sim is deterministic) · basic stats persistence · Elo/matchmaking · mobile touch controls · Steam-style skins if you hate free time.

---

## Starter Weapon Table (tune later)

| Weapon | Dmg | RPM | Mag | Reload | Spread° | Price | Speed× |
|--------|-----|-----|-----|--------|---------|-------|--------|
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
- Red Blob Games — A* pathfinding introduction

## Suggested Milestone Cadence

Each phase is roughly 1–3 focused weekends. Sequence is dependency-ordered: 0→1→2→3 are strict prerequisites; 4/5/6 can be shuffled; 7 needs 6; 9 needs everything and rewards the discipline of rules 1–3.
