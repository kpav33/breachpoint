# Top-Down 2D Counter-Strike — Implementation Plan

**Stack:** Phaser 3 · TypeScript · Vite · Tiled (map editor) · Colyseus + Node (Phase 9+)
**Strategy:** Bots-first, multiplayer-ready architecture from day one. Each phase ends with something playable.

**Locked-in design decisions:**

- **Vision:** ~110° view-cone in the aim direction + small 360° awareness circle (2–3 tiles). Implemented as full visibility polygon ∩ cone, behind a config flag — full-circle mode kept as an easy/testing option.
- **Economy:** simplified four-number model (start money, flat kill reward, win reward, escalating loss bonus). Full CS-style economy deferred to Phase 9+ when human teammates make save/force decisions meaningful.
- **Art direction:** flat geometric/vector style — circle players with weapon rect + direction notch, clean-lined walls, solid-color floors. No pixel art, no sprite animation frames. Visual appeal comes from the Phase 5 juice layer (tracers, shake, particles, decals). Rendering is decoupled from simulation, so real sprites can replace shapes later without touching game logic.
- **Friendly fire: off for launch** (`FRIENDLY_FIRE` in `core/config.ts`; with it off, bullets pass *through* teammates and HE blasts skip them — but your own HE still hurts you, and the bomb damages everyone). CS turns FF on only in competitive, backed by anti-grief tooling we don't have. Revisit post-launch as a **per-match option** (competitive-style ruleset), which requires: moving the flag from compile-time config into match/room settings (protocol bump), bot trigger discipline (bots don't check for teammates in the firing line — with FF on they'd routinely shoot you), and some team-damage penalty online. Note the gameplay shift when it flips: teammates become bullet-blocking cover.

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
- [x] Damage direction indicator on HUD — red arc at screen center toward the shooter, 700 ms fade (`updateDamageIndicators`; the earlier "not implemented" note was a bad audit — verified in-game 2026-07)

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
- [x] Clients send `InputCommand`s (with client tick numbers); server buffers per-player queues and applies them (one per tick, one-shot buttons never repeated), broadcasts full-state snapshots at `SNAPSHOT_RATE` (15/s at the time; raised to 30/s in Phase 9.5 Workstream B)
- [x] Naive first pass: `OnlineGameScene` (subclass of GameScene — fog/effects/audio/HUD reused) renders raw snapshots (it will feel laggy — that's expected, it proves the pipe works)

### 9b. Netcode quality

- [x] **Client-side prediction:** client runs the same simulation locally for _its own_ player immediately on input (movement + aim only — firing/reload/switches stay server-authoritative so effects never double)
- [x] **Server reconciliation:** snapshots include last-processed input tick (`acks`); client rewinds to server state and replays unacknowledged inputs (`OnlineGameScene.reconcile`)
- [x] **Entity interpolation:** remote players + grenades render `INTERP_DELAY_MS` (100ms then; 50ms since Workstream B) in the past, lerping between the two surrounding snapshots
- [x] **Lag compensation for hits:** server keeps `LAG_COMP_MAX_REWIND_SEC` (1s) of position history; each input carries the client's interpolated `viewTick` and shots resolve against targets rewound to it
- [ ] Reference reading: Gabriel Gambetta "Fast-Paced Multiplayer" parts 1–4; Valve's Source Multiplayer Networking article

### 9c. Meta

- [x] Lobby (`LobbyScene`): Quick Play (public matchmaking), Host Private (share code), Join by Code. The browsable live room list (Colyseus `LobbyRoom`) was deferred to Phase 10 and has since been built — see the Phase 10 backlog.
- [x] Server-side validation: input intent clamped ([-1,1] move, uint32 buttons), buy legality via `tryBuy` (phase/team/money) — hardened against prototype-key injection (`__proto__`/`toString`) with an own-property check. Speed/fire-rate can't be forged since the server owns the sim.
- [x] Fill empty slots with bots: shared `BotController` + `assignBotObjectives` (moved to `src/ai/`, runs headless on the server). Teams kept at `TEAM_SIZE`; humans replace bots on join, bots backfill on leave.
- [x] Deploy: `Dockerfile` (server-only, type-stripping, no build step), `fly.toml`, `docs/DEPLOY.md` (Fly/Railway/VPS + Cloudflare Pages, `VITE_SERVER_URL`, wss, CORS).

**Done when:** two browsers on different networks play a full match with hit registration that feels fair at ~80ms ping. _(Done — deployed and playable online at https://breachpoint.kpav.eu/. Confirmed 2026-07 to feel smooth/non-laggy at ~50ms ping, which vindicates the earlier diagnosis: the original "noticeably laggy" was Render free-tier CPU throttling, not the netcode. Movement prediction/reconciliation/interpolation are working as intended.)_ **Correction (2026-07, later):** the "smooth" verdict covered movement feel and hit *fairness* only — it never measured **shot feedback latency** or **update rate**. A follow-up review found real problems with how *shooting* feels online (firing isn't predicted, 15 Hz snapshots, 100 ms interp delay). See "Shooting feel" under Phase 9.5 — this line should not be read as "the shooting netcode needs no work."

---

## Phase 9.5 — Netcode validation, telemetry & hardening (next up)

The multiplayer pipe works end-to-end but has never been fairly measured (see the
Phase 9 done-when note), and players currently get zero feedback about connection
quality. This phase is about knowing — and showing — whether the game feels bad
because of the connection, the server tier, or the code.

### Measurement first (dev-facing)

- [x] **Server tick instrumentation:** time each tick (rolling avg/max ms), log it and expose it to clients. This settles "is the sim + bots overrunning the tick budget on Render free?" permanently — a tick overrun is indistinguishable from network lag in the browser — `MatchRoom` keeps a rolling `PERF_WINDOW_SEC` window (avg/max tick ms, bot ms, achieved TPS), logs it every ~10 s, and ships it in every snapshot as `Snapshot.perf`
- [x] **Fair netcode retest:** two browsers vs a local `npm run server`, then vs a small paid instance. Only after this do we know whether prediction/reconciliation/interp need tuning at all — **local half done (2026-07, headless):** server is nowhere near the tick budget (tick 0.1–0.2 ms avg / 3.8 ms max incl. bots, steady 60 tps with 2 clients + bots); a render-free Node probe measured true RTT 0.8 ms avg / 1.7 ms max and snapshot delivery exactly 15.0/s (gap p95 81 ms vs 66.7 target); reconciliation corrections ~0–1.5/s in-browser. Conclusion: the netcode + sim are healthy — the deployed lag was almost certainly Render free-tier CPU throttling. **Human feel test done (2026-07):** the live deploy at https://breachpoint.kpav.eu/ feels smooth and non-laggy at ~50 ms real ping — for *movement*. **Superseded (2026-07, later):** this test did not isolate the shooting experience; a code review found the gun feels detached and aiming feels unrewarding online for structural reasons (unpredicted firing + low update rate), unrelated to raw ping. Do not treat "netcode confirmed good" as covering shooting — see "Shooting feel" below.
- [x] **net_graph-style debug panel** (extend the backtick overlay, per convention): RTT, snapshot arrival rate, interp buffer depth, reconciliation corrections/sec, bytes in/out per second. Build this first — it *is* the measurement tool; the player-facing HUD below is its polished subset — `OnlineGameScene.extendDebug()` adds `net rtt / net snap / net recon / net traffic / server` lines (traffic is ≈JSON size of decoded messages, not wire bytes)
- [x] **Per-tick cost profiling + bot staggering:** bot LOS raycasts and A\* repaths are the likely hot spots; stagger bot thinking (each bot thinks every Nth tick) — standard, low-risk win that directly helps cheap hosting — bot time is profiled separately in `Snapshot.perf.botMs`; the LOS raycast scan runs every `BOT_SCAN_EVERY_TICKS` (offset per bot), while hearing/movement/aim still update every tick

### Gunplay fidelity pass (CS-alignment) — do BEFORE the netcode work

Audited 2026-07 against CS gunplay. The core loop already matches CS (hitscan, bloom
= shoot-too-fast drift, movement penalty, range falloff, armor, per-weapon move
speed, reload-cancel-on-switch, switch time). These items close the remaining gaps.
The netcode "Shooting feel" work below is deliberately sequenced **last**, as the
most complex part — this pass lands first.

Cross-cutting costs: these are `core/` changes, so they affect **online and offline
identically**, bump the **golden replay hash**, and several add small `PlayerState`
fields → a `PROTOCOL_VERSION` bump. Status: **the pass is complete.** Fire control
landed as version 7 (`triggerHeld`, hash `c09aea069df80501`); movement/combat
coupling as **version 8** (`moveSpread`, `tagged`, hash `f6441eae02e790ca`).
Next up is the netcode "Shooting feel" work below.

- [x] **First-shot accuracy (laser-perfect)** — **done (2026-07).** `spreadBaseDeg`
      → **0** for rifle, smg, pistol, deagle; shotgun (4°) and sniper (0.1°) kept.
      Movement penalty and bloom untouched → tap for precision, spray/movement
      drift. Locked in behaviorally by a new test in `tests/core-sim.test.mjs`
      (stationary first shot hits a target at 1200 px on **25/25** seeds; the same
      shot while moving hits **0/25**) — a config-value assertion alone wouldn't
      catch a regression in how spread is applied. **The golden replay hash did NOT
      change**, contrary to this plan's earlier prediction: `nextRand` is called once
      per pellet regardless of spread *magnitude*, so `rngState` is identical, and
      the replay's single player-hit (1 of 40 shots) was well-centered enough to land
      either way. No protocol bump. The `WeaponDef.spreadBaseDeg` doc comment in
      `core/types.ts` now records why 0 is the intended value for aimed weapons.
- [x] **Semi-auto fire modes** — **done (2026-07).** `WeaponDef.auto` (required, so
      every weapon declares it); **true for smg, rifle and knife**, false for pistol,
      deagle, sniper, shotgun. *Deviation from this plan's earlier text, which listed
      the knife as semi:* CS repeats knife slashes while the button is held, and
      making it semi would only add click-spam to a fallback weapon. Edge detection
      is `PlayerState.triggerHeld`, recorded in `applyInput` **after** `tryFire` so
      the fire check sees the previous tick. No server change needed: `repeatCommand`
      keeps Shoot held on stale commands, and the edge rule makes that a no-op for
      semi-auto (auto weapons still ride out packet loss as before).
      **Bots needed a matching fix** — `fireControl` held the trigger for the whole
      burst, which under the edge rule is one shot per burst (a severe silent nerf on
      pistol rounds). Bots now press only on ticks where the gun can actually fire,
      so the sim sees a release between shots: measured 8–9 pistol shots/3 s for
      normal/hard vs ~4 when held. Pinned by a new `tests/bot-fire.test.mjs`.
- [x] **Accuracy recovery after stopping (counter-strafe analogue)** — **done
      (2026-07).** `currentSpreadDeg` now reads `PlayerState.moveSpread` (0..1)
      instead of live velocity: it snaps up the instant you move and decays linearly
      over `ACCURACY_RECOVERY_SEC` (0.25 s) once you stop, so releasing the key and
      firing in the same tick no longer gives a pinpoint shot. Updated in `move()`
      after velocity is set. Note the target is still *actual* speed over
      `MOVE_SPEED` (unchanged), so anything that slows you — heavy weapon, walking,
      being tagged — also steadies your aim, as in CS.
- [x] **Tagging (getting shot slows you)** — **done (2026-07).** `PlayerState.tagged`
      (0..1) rises on bullet hits by `hpLost * TAG_PER_DAMAGE` and bleeds off over
      `TAG_RECOVERY_SEC` (0.5 s); movement is scaled by `1 - tagged * TAG_MAX_SLOW`
      (up to 40 % slower). One rifle body shot → ~74 % speed. Two deliberate design
      calls: it is **gunfire-only** (knife included, but *not* HE/bomb — explosions
      already control space via damage, and a slow on top would make utility
      oppressive), and it scales by **health actually lost**, so **armor blunts the
      stagger as well as the damage**. Bot duel sanity check after the pass: kills
      still land in 5/5 duels, ~1 s (hard) / ~1.8 s (normal) / ~7 s (easy).
      Debug overlay gained `spread` (now showing the move factor) and `tagged` lines,
      per the invisible-state convention.
- [x] **Shotgun shell-by-shell reload** — **done (2026-07).** Optional
      `WeaponDef.shellReload`; for such weapons `reloadTime` means **per shell**, so
      the shotgun went 3.0 s/mag → 0.5 s/shell (still 3.0 s from empty, but
      interruptible after any shell). `tickTimers` loads one shell and re-arms the
      timer until the mag is full or the reserve is dry; `tryFire` cancels an
      in-progress shell reload and keeps the shells already loaded (magazine reloads
      still must finish). HUD change: shell reloads keep showing the live ammo count
      with a trailing "…" instead of `RELOADING…`, since watching shells tick up is
      the whole point of the mechanic.
- [x] **Auto-reload on empty mag** — **done (2026-07).** `autoReload` runs at the end
      of `applyInput`: mag at 0 → `tryStartReload` (which already no-ops on a dry
      reserve or an in-progress reload). Manual R still works early. Skipped while a
      grenade is charged so a throw isn't interrupted. Side benefit: the HUD's
      `ammoWarn` now means "genuinely out of ammo" rather than "press R".

Recorded decisions (no code — so they aren't re-litigated):

- **Keep random-bloom spread, NOT deterministic CS spray patterns.** Deterministic
  recoil doesn't map to cursor-aim — the crosshair *is* the mouse, so there's
  nothing to "pull down" (also why mouse-sensitivity is N/A). Random bloom is the
  correct analogue and still rewards tap/burst over spray.
- **No headshots / hitboxes** — 2D circle players take uniform damage; locked by the
  top-down art direction.
- **Wall penetration (wallbangs) deferred** — rays stop at the first wall for now; a
  penetration model (damage-reduced pass-through on thin walls) is a possible future
  addition, explicitly out of this pass.

### Shooting feel — the open netcode issue (diagnosed 2026-07)

Playtest report: shooting online feels janky even at ~50 ms ping — the gun feels
slightly behind the click, and precise aiming feels pointless (you may as well
spray). This is **not** raw latency or server throttling (those were ruled out
above) and **not** the spread/bloom mechanic (that's working as intended and is
staying). It's three structural choices in the current netcode, in impact order:

1. **Firing is not client-predicted.** `PREDICT_BUTTONS = Buttons.Walk` in
   `OnlineGameScene` masks out `Buttons.Shoot`; every bit of shot feedback (muzzle
   flash, gunshot sound, tracer, hit marker) is driven by `state.events`, which on
   the client only arrive inside snapshots (`drainSimEvents` in `GameScene`, fed by
   `ingestSnapshots`). So click → feedback = RTT + wait-for-next-server-tick +
   wait-for-next-snapshot + a client frame ≈ **90–150 ms at 50 ms ping**. This is
   the "gun feels detached" sensation, and it's the biggest single contributor.
2. **`SNAPSHOT_RATE` is only 15 Hz (66.7 ms).** It compounds twice: it batches
   your own shot events (adds up to 66 ms on top of #1), and it means enemy
   positions update only 15×/s, so you track targets reconstructed from samples
   66 ms apart — they move in visible steps. The server has huge headroom
   (tick 0.1–0.2 ms avg), so this is cheap to raise; the cost is bandwidth (JSON
   snapshots — may need delta/binary encoding if bytes matter).
3. **`INTERP_DELAY_MS = 100` means you always aim ~100 ms in the past.** Lag
   compensation rewinds targets to your `viewTick` server-side, so hits still
   *register* fairly — but the *act of aiming* is against a stale, choppy target.
   Fairness ≠ feel; the aiming feel is what's off. Combined with #2 this is why
   precise aim feels unrewarding ("spray and pray" as a rational response, not a
   spread-mechanic complaint).

Planned work — **sequenced last**, after the Gunplay fidelity pass above (netcode is
the most complex part). Two workstreams: **A** (the isolated big feel win) shipped
and measured before **B** (tuning, whose numbers are best chosen against a live
feel-test after A). Decisions locked with the user 2026-07: **predict the full local
gun state** (not effects only) and draw the **predicted tracer centered on aim** (not
spread — simplest, and it never visually lies about where you aimed).

Key insight that makes A safe: the client's prediction scratch state holds **only
the local player** (`predictScratch` in `OnlineGameScene`), and `firePellet` finds
targets by iterating `state.players`. With no other players present, predicted
firing physically cannot apply damage or emit death events — the effect/damage
split is free. So the de-dup rule is simply: **the local player renders their own
shots from prediction; the server's echoed `shot` event supplies only hit
confirmation** (hit marker, victim flash, damage numbers — what only the server
knows). No per-event tick-matching needed.

**Carried over from the gunplay pass — read before starting A:**

- **Tagging creates a NEW source of reconciliation corrections, by design.**
  `move()` scales speed by `1 - tagged * TAG_MAX_SLOW`, but the client only learns
  it has been tagged when a snapshot says so (up to one snapshot interval + latency
  late). In that window the client predicts full speed while the server has already
  slowed the player → divergence → a correction. Expect `corrections/s` on the
  net_graph to spike **during firefights specifically**; that is the mechanism, not
  a regression — do not "fix" it by unpredicting movement. Workstream B halves the
  window for free by doubling the snapshot rate. (Reconciliation itself handles it
  correctly: `reconcile` clones the server's player, `tagged` included, then replays
  pending inputs through the same `applyInput`.)
- **Semi-auto interacts with prediction.** `triggerHeld` is written in `applyInput`
  *after* `tryFire`, so a predicted shot depends on the previous tick's trigger
  state. Replaying unacked inputs re-runs that logic deterministically, which is
  fine — but it means the "replay silently, render only on the live tick" rule in
  step 2 below is load-bearing: without it a semi-auto shot would re-render its
  effects on every reconciliation.

**Workstream A — predict local shot feedback** (client-only; no `core/` change, no
protocol bump, no golden-hash change; offline play untouched):

- [x] Extend `PREDICT_BUTTONS` to add Shoot + Reload + weapon-switch (Select*/Next/
      Prev). ~~**Grenades stay server-authoritative** — they spawn world projectiles
      that would ghost/desync if predicted, so Throw* is deliberately excluded.~~
      **Corrected while implementing:** Throw\* had to be **included**, and excluding
      it was not merely conservative but actively broken — a third non-obvious
      interaction, in the same family as the two notes above. `handleGrenadeCharge`
      treats "was charging, throw bit now absent" as a *release*. A player the server
      says is charging therefore looked to the masked replay like they released on
      **every** tick: phantom grenade spliced out of the predicted inventory (HUD
      gear flicker), `GRENADE_THROW_LOCKOUT_SEC` spuriously blocking predicted fire,
      and no charge ring, since `chargingGrenade` was nulled the moment it arrived.
      (That bug was already latent with the movement-only mask; predicting fire is
      what would have made it visible.) Including Throw\* predicts the *charge* only
      — the projectile spawns into `predictScratch`, which is never drawn or stepped
      and is now cleared each apply, and the predicted `grenade_throw` event is never
      presented. The grenade itself still arrives from the server.
- [x] Split effect-rendering from reconciliation replay: `reconcile`'s replay of
      pending inputs must stay **silent**; only the live `predictTick` renders new
      predicted effects. That presents each shot exactly once (rendered when live,
      replayed silently until acked). — `applyPredicted(cmd, live)`; only
      `predictTick` passes `live: true`.
- [x] Route predicted `shot`/`reload` events from the scratch state into the
      existing effects/audio path — muzzle flash, gunshot, tracer, bloom, ammo
      decrement, reload timer all become instant. Predicted tracer is **centered on
      aim** (recompute endpoint via a centered wall raycast); the sim still rolls
      real spread server-side for the actual hit. — `presentPredicted` +
      `centerOnAim`. Consequence of centering: a shotgun blast now presents **one**
      tracer/flash/casing rather than eight identical stacked copies (the scatter
      shows up as server-confirmed blood), and wall sparks/bullet holes mark the aim
      line rather than the true spread endpoint.
- [x] Add a protected seam in `drainSimEvents` (base `GameScene`) so
      `OnlineGameScene` suppresses the *presentational* part of the local player's
      own `shot`/`reload` echoes (keep the `hitPlayerId` block). Death/grenade/hit
      events still come from the server — you never predict your own death. —
      `gunFxPredicted(playerId)` + `presentShot()`; the echo of a suppressed local
      shot still contributes `effects.bulletImpact(ev.to)` on a player hit, the one
      piece of a shot only the server can place.
- [x] Extend the net_graph overlay: predicted-shots/s + a prediction-vs-server
      mismatch counter (invisible-state convention; catches reconcile regressions —
      e.g. a dropped input causing a one-frame phantom flash before ammo snaps). —
      `net predict` line (`gunSig` compares active slot / weapon / mag / reserve /
      reloading across each reconcile). Note buys, pickups and drops are server-only
      and legitimately trip it, so read it as "≈0 during a firefight".
- [x] **Headless verification (2026-07):** local server + browser client, pistol at
      ~250 ms simulated RTT — ammo decrements on the *same frame* as the click (far
      inside one RTT, so it can only be predicted), the centered tracer draws down
      the aim line, `net predict` registers the shot, six semi-auto clicks consumed
      exactly six rounds (no double-fire from replay), and gun-mismatches +
      corrections both stayed at 0.0/s.
- [x] Playtest at ~50 ms: confirm the gun responds to clicks; watch the mismatch
      counter stays near zero. — **done on the live deploy 2026-07-26:** "before
      online play felt like every shot had a real delay to it, now it's much
      smoother." The diagnosis held — unpredicted firing was indeed the dominant
      contributor. **Workstream A is complete**; B is now unblocked and its numbers
      can be chosen against this baseline.

**Noted during A's playtest (not a regression):** `SERVER OVERLOADED` appeared
occasionally when the server shares a machine with the browser (local testing).
The tps measurement is real, but it had no hysteresis and is 2 s coarse, and
`MAX_TICK_DELTA_MS` drops rather than makes up ticks after a >250 ms stall — so one
CPU hitch read as ~2–4 s of banner. **Fixed in Workstream B** (hysteresis via
`TPS_ALERT_HOLD_MS`, and `SNAPSHOT_LATE_MS` re-based off wall-clock instead of
snapshot intervals) — see B's third item.

**Workstream B — update-rate + interp tuning** (after A, measurement-driven; no
protocol bump, no core change):

- [x] `SNAPSHOT_RATE` 15 → 30 (every 2nd server tick — server has the headroom).
- [x] `INTERP_DELAY_MS` 100 → ~50 (≥1.5 snapshot intervals of cushion at 30 Hz). —
      50 exactly (1.5 × 33.3 ms).
- [x] **Indicator thresholds re-based** (they were expressed in snapshot intervals,
      so doubling the rate would have made both twitchy): `SNAPSHOT_LATE_MS` is now
      `max(200, 3 intervals)` — a wall-clock floor, because faster snapshots make a
      gap cheaper, not more alarming — and SERVER OVERLOADED needs the low-TPS
      condition to hold `TPS_ALERT_HOLD_MS` (1.5 × `PERF_WINDOW_SEC`) before it
      raises, so one CPU hitch can't accuse the server. Clears on the first healthy
      snapshot. This is the fix for the banner noticed during A's playtest.
- [x] Read `net traffic` under load; if bandwidth bites, note delta/binary snapshot
      encoding as a **follow-up** (don't build speculatively). — **measured
      2026-07-26** with a render-free 2-client Node probe against a local server,
      plus the in-browser net_graph:
      - Delivery is now **exactly 30.0/s with gap p95 34 ms** (target 33.3). Compare
        the 15 Hz baseline: 15.0/s with gap p95 81 ms vs 66.7 target — so the
        jitter improved proportionally, not just the rate.
      - Snapshots are **4.0 KB** each (full-state JSON, 10-player roster), i.e.
        **~117 KB/s per client down**, up from ~58. Server outbound scales linearly
        with humans: 2 clients = 234 KB/s, so a **full 10-human room ≈ 1.17 MB/s
        (~9.2 Mbit/s)**. Client uplink is unchanged and trivial (~7.6 KB/s).
      - Server cost is unaffected: **tick 0.09–0.22 ms avg, 0.6 ms max, 60.0 tps**
        with 2 clients + bots. The rate rise is free on CPU, paid in bytes.
      - **Verdict: does not bite yet at realistic room counts, but it's the next
        scaling wall** — a free-tier instance hosting a couple of full rooms is into
        tens of Mbit/s. Follow-up (do NOT build speculatively): delta-encode
        snapshots (send only changed fields against the client's last ack) and/or a
        binary encoding; either is a protocol bump. Revisit when rooms actually fill
        or the host starts charging for egress.
- [x] Re-test tracking smoothness + shot feel at ~50 and ~80 ms ping. — **done
      2026-07-26: "feels pretty good now."** One caveat left deliberately unclosed:
      50 ms is only 1.5 snapshot intervals of cushion, and local testing can't
      produce real jitter. If online play ever gets choppy at higher ping, check
      **`starved/s`** on the net_graph first and raise `INTERP_DELAY_MS` back toward
      66 (2 intervals) — do **not** drop the snapshot rate, which is what fixed
      target tracking.

**Status: the "Shooting feel" issue is closed.** A (predicted shot feedback) and B
(30 Hz snapshots, 50 ms interp, re-based connection indicators) both shipped and were
confirmed on the live deploy 2026-07-26. All three diagnosed causes are addressed; no
protocol bump and no `core/` simulation change was needed for either workstream.

Reference reading for this specific problem (see Key References): Gambetta parts
**1–2** (client-side prediction + server reconciliation — the same idea extended to
firing effects) and the Valve wiki (interp, `cl_updaterate`/`cl_cmdrate` — the
direct analogue of `SNAPSHOT_RATE` — and how lag comp coexists with interpolation).
Gambetta part 4 / the Valve lag-comp section describe what's *already* built and
working; the fixes above live in parts 1–2 plus the update-rate discussion.

### Player-facing telemetry (standard competitive-game UX)

- [x] **Ping (RTT):** `MSG_PING`/`MSG_PONG` pair in `protocol.ts` — client sends a timestamp every ~2s (`PING_INTERVAL_MS`), server echoes, client keeps a rolling average. Colyseus doesn't measure this for us. Shown on the debug panel; the HUD readout below is still open
- [x] **HUD ping display** (corner readout) + **per-player ping column on the Tab scoreboard** (server collects everyone's RTT, includes it in snapshots) — clients piggyback their rolling RTT on `MSG_PING`; the server relays them as `Snapshot.pings`. Bots render as "BOT"; offline games hide the readout and the column entirely
- [x] **Connection-quality indicator:** "connection problem" icon when the interpolation buffer runs dry / snapshots arrive late (client watches inter-arrival times against the fixed 15/s `SNAPSHOT_RATE`). Reconciliation already knows when predictions diverge — corrections/sec is a free health metric — blinking warning under the score line: "CONNECTION PROBLEM" when the newest snapshot is >3 intervals old, "SERVER OVERLOADED" when `Snapshot.perf.tps` drops under 90% of `TICK_RATE` (corrections/sec stayed debug-panel-only — it's a tuning signal, not a player-facing one)
- [x] **Server tick health in snapshots** (actual achieved TPS): lets the client distinguish "my connection is bad" from "the server is overloaded" — given the free-tier hosting, arguably the most valuable single number to show — `Snapshot.perf` (tick avg/max ms, bot ms, TPS); surfaced on the debug panel, not yet on the player HUD

### CS-staple gameplay gaps (audited 2026-07 — these are absent from the code)

- [x] **Halftime side swap:** no team-swap logic exists in `src/match/` — a first-to-13 match plays every round on the same side, which is unfair on asymmetric defuse maps. Swap teams (and reset economy) after round 12. Biggest gameplay gap. Note: adding halftime makes a 12–12 draw possible — decide draw vs simple overtime then (today first-to-13 with no swap can't draw) — **done:** `swapSides()` in MatchState fires after roundsToWin−1 rounds (scores follow the players, economy/streaks/gear reset, `halftime` event → SWITCHING SIDES banner + roster/view rebuild on both client and server). 12–12 (generally (rtw−1)-all) is a **draw** (`match_end` with `winner: null`, "MATCH DRAWN" banner); overtime stays a backlog idea
- [x] **Weapon drop / pickup:** only the *bomb* drops on death (`MatchState`). Guns should drop as world entities and be picked up by walking over them (+ manual drop key, G) — eco-round scavenging and passing a teammate a rifle are core CS economy moves — **done:** `DroppedWeapon` entities in MatchState (ammo preserved); death drops the best gun, G drops the active one (tossed ~40 px ahead, wall-checked), walk-over pickup when the slot is free, floor cleared at round start. **Key change: HE grenade moved G → X** to free G for drop (proper rebinding comes with the keybind-settings item)
- [x] **Damage direction indicator** (carried over from Phase 5 — still the only unbuilt Phase 5 item) — **turns out it was already built** in the Phase 5 commit (`updateDamageIndicators`, red arc toward the shooter) and the 2026-07 audit missed it; verified working in-game. Only gap: HE/bomb damage doesn't trigger it (bullets only) — fine for now
- [x] **Mouse sensitivity + keybind settings** (carried over from Phase 8 — settings panel only has volume and bot difficulty) — **keybinds done:** every action (move/walk/use/reload/drop/grenades/weapon slots) is rebindable in the settings panel (click → press key; conflicts swap; ESC cancels), persisted in `Settings.keybinds`, applied live on unpause via `InputSystem.reloadBinds()`; menu footer + bomb hint read the live binds. **Mouse sensitivity is N/A by design:** aim is absolute cursor position (pointer → world angle), not relative mouse movement — there is nothing for a sensitivity multiplier to act on

### Multiplayer product gaps

- [x] **Reconnect handling:** no `allowReconnection` on the server — a browser refresh or Wi-Fi blip mid-match permanently replaces the player with a bot. Grace window (~60s) where the seat is held and the player can rejoin with money/score intact — **done:** `allowReconnection(client, RECONNECT_GRACE_SEC)` holds the seat on non-consented leaves (avatar benched via `handlePlayerDisconnect`: gun/bomb drop, plant cancelled, stats intact; name tagged "(dc)"); voluntary quits and match_end clean up immediately. Client auto-retries mid-session drops (6 attempts) and survives page refreshes via a sessionStorage token (re-stamped every ping) + a "RECONNECT TO MATCH" menu button; the server resends `MSG_WELCOME` on reconnect so a fresh page relearns its player id. E2E-verified (refresh → menu → same match)
- [x] **In-game chat:** nothing in the protocol. Minimal all-chat + team chat (with basic rate limiting); expected in anything competitive — **done:** Y = all-chat, U = team chat, Enter sends / ESC cancels; game input is suppressed while typing. Server validates (control chars stripped, 96-char clamp), rate-limits (3 msgs / 4 s sliding window) and relays — team chat is filtered server-side so it never reaches enemy clients. Lines render bottom-left in sender faction color, fading after 8 s. Online only (no `sendChat` source offline). Two-client e2e-verified incl. team filtering

### Hardening

- [x] **Tests for `src/core/` + `src/match/`**: collision resolution, raycast intersections, spread/damage falloff, `tryBuy` incl. the `__proto__` injection case, economy math, bomb timing. This is the code both client and server share — exactly where a regression silently breaks multiplayer fairness — **done** in `tests/*.test.mjs` via `npm test`. Deliberate deviation from the original "vitest" note: the plain **node runner + `--experimental-strip-types`** is already how the server loads this exact code, needs zero new dependencies/config, and runs in CI — switch to vitest only if tests ever need Phaser-side mocking
- [x] **Replay-based regression tests:** record an input stream, replay it through the deterministic sim, assert the final state (hash). Doubles as groundwork for Phase 10 demo/replay recording — **done** in `tests/core-sim.test.mjs`: 600 scripted ticks (movement + burst fire) on de_yard, asserts determinism (two runs identical) and a golden sha256 of the final state. A hash mismatch means sim behavior changed — update the `GOLDEN` constant only when intentional
- [ ] **Real audio assets:** replace the synthesized WAVs in `public/assets/audio/` — same filenames, no code changes; overdue per the Phase 5 note. **Needs human ears** (22 sounds to audition — see `public/assets/audio/README.md`). **Tooling built (2026-07):** `tools/import-audio.mjs` imports CC0 packs (Kenney Impact + Interface, OpenGameArt "Free Firearm Sound Library", "100 CC0 SFX") — it ffmpeg-converts to mono 22 kHz WAV, auto-trims one shot out of the long multi-shot firearm recordings, pitches the bomb blast down to distinguish it from HE, and two-pass peak-normalizes, all driven by a `MAP` table (swap picks + re-run). **First CC0 pass rejected (2026-07):** the user auditioned that specific mapping and preferred the original synthesized placeholders (cleaner/arcade character), so the placeholders were regenerated (`node tools/generate-audio.mjs`) and remain in place. Still open — either curate better-fitting CC0 clips through the same script, or keep the synth set for launch. The script + sourcing notes stay as the starting point for a future attempt.
- [x] **Protocol version handshake:** add a `PROTOCOL_VERSION` constant to `protocol.ts`, sent in join options and checked in `onAuth`/`onJoin` — the deployed client (Netlify) and server (Render) ship independently, so a wire-format change silently breaks live clients with confusing symptoms instead of a clear "please refresh" error — **done** (checked in `onJoin`; reconnections skip it so held seats survive). Currently version 2 (the Phase 9.5 additions were already breaking). **Bump it on any wire-format change**
- [x] **CI (GitHub Actions):** no workflows exist — run `npm run lint` + `npm run build` (+ tests once they exist) on push, so a broken commit can't reach the deploy hooks unnoticed — **done:** `.github/workflows/ci.yml` runs lint + build + `npm test` on pushes to main and on PRs (Node 22, npm cache)

---

## Phase 10 — Post-launch niceties (backlog)

~~Browsable live room list in the lobby~~ — **done (2026-07):** built-in Colyseus `LobbyRoom` defined in `server/index.ts`; MatchRoom's existing metadata (name/map/humans/capacity/phase/round, `RoomMetadata` in `protocol.ts`) is pushed to subscribers via `updateLobby` on every `publishMetadata`. LobbyScene shows a live OPEN MATCHES panel (updates in place as rooms appear/fill/close; full rooms grayed; click to join; private rooms stay hidden). Additive change — no protocol bump. Still open: spectator mode with free camera · demo/replay recording (store input streams — cheap, since sim is deterministic; the Phase 9.5 replay tests lay the groundwork) · basic stats persistence · Elo/matchmaking · mobile touch controls · Steam-style skins if you hate free time.

**Aim sensitivity — requested 2026-07-26, and bigger than a slider.** Players want to
tune aim feel to taste. The blocker is that aiming is currently **absolute**:
`InputSystem.sample()` takes the world point under the OS cursor and does
`atan2(world - playerPos)`, so the crosshair *is* the cursor. There is no scalar to
multiply — any "sensitivity" factor would only make the crosshair stop tracking the
pointer, which reads as broken rather than adjustable. (Same root cause as the locked
"no CS spray patterns" decision: absolute aim means there's nothing to pull down.)

Doing it properly means an optional **relative aim mode**: pointer lock, accumulate
`movementX/Y` into a virtual crosshair (or straight into an aim angle), scale those
deltas by the sensitivity setting. Confined to `game/` + `scenes/` — `aimAngle` stays
the same absolute-radians field on the wire, so **no `core/` change and no protocol
bump**. The persisted-settings mechanism and settings panel already exist
(`game/settings.ts` + `SettingsPanel`), so the slider itself is the cheap part. What
actually needs designing:

- **ESC collides with pointer lock.** ESC is the pause key, and the browser also uses
  it to exit lock — pausing and unlocking will fight. Needs a deliberate resolution.
- **The game must draw its own crosshair** (the OS cursor is hidden under lock) and
  clamp the virtual one to the viewport.
- **Lock has to release for UI** — buy menu, chat, scoreboard, pause — and re-acquire
  cleanly, which requires a user gesture on re-entry.
- **Camera zoom** changes the px→world mapping, so sensitivity must be defined against
  logical units, not device pixels.
- Keep absolute aim as the default and the mode as opt-in; the two feel completely
  different and mixing them per-match would be disorienting.

**2.5D look (worth a prototype):** keep the top-down camera and the 2D sim exactly as-is, but render walls with fake height — floor footprint + extruded side faces shearing away from the camera center (GTA1/Hotline Miami style), plus drop shadows under players. Pure rendering change confined to `MapLoader`/the render layer: world x/y still maps straight to screen x/y, so aiming, fog, and the minimap keep working untouched. Prototype on one map before committing; do it after the Phase 9.5 replay tests exist to prove the sim stayed untouched. — **done (2026-07), kept:** `ElevationSystem` (render-only) greedy-meshes the collision grid into wall rects and redraws them per frame as extruded blocks (`WALL_EXTRUDE` in `theme.ts`; tops `wallTop`, N/S faces `wall`, E/W `wallDark`); drop shadows added to `PlayerView`. Two lessons baked in: (1) the shear centers on the **followed player's render position**, not the camera midpoint — at map bounds the clamped camera de-centers and camera-centered shear makes wall tops overhang (hide) your own player; (2) a low-alpha "ghost" copy renders **above the fog** via an opaque RenderTexture stamp faded once with `setAlpha` (`GHOST_ALPHA`) — without it the effect is invisible (shear grows exactly where fog is), and per-shape translucency would alpha-stack every internal seam. F7 toggles back to the flat tilemap walls layer; sim untouched (golden replay hash unchanged). Also since (2026-07): **two more maps** — `de_cross` (contested central plaza, diagonal sites) and `de_docks` (east–west three-lane, stacked east sites) — generated layouts with a flood-fill connectivity audit run over all four maps.

**Team voice chat (WebRTC, mostly free):** peer-to-peer WebRTC audio mesh between teammates — at TEAM_SIZE 3 each client holds ≤2 audio connections, so no media server (SFU) is needed. The existing Colyseus MatchRoom does the **signaling only** (a few new message types relaying SDP offers/answers + ICE candidates between teammates; audio bytes never touch the game server). NAT traversal is tiered: **STUN** is a free config line (`stun:stun.l.google.com:19302`) and covers most player pairs; **TURN** (relays audio when both peers are behind strict NATs, ~10–20% of pairs) is the only piece needing hosted bandwidth — ship without it first, add coturn next to the game server later if "some pairs can't hear each other" reports show up (note: Render free can't host TURN — it needs UDP). Client side: push-to-talk keybind in the settings panel, speaking indicator on HUD/scoreboard, per-player mute, graceful mic-permission handling. Deliberately NOT positional/proximity voice — CS-style team radio; the AudioSystem pan/distance logic stays out of it. Do not hand-roll audio over the Colyseus WebSocket instead: TCP stutters on loss, the free-tier server would pay for every audio byte, and WebRTC's codecs/echo-cancellation come free.

**Variable grenade throw strength:** today a throw is direction + fixed `GRENADE_THROW_SPEED`, so with exponential friction every grenade travels the same ~`speed / GRENADE_FRICTION` px unless it banks off a wall — direction is the player's only control, and in a top-down game (no vertical arc) *where the grenade stops* is everything for smokes/flashes. Add a strength axis: preferred shape is **hold-to-charge** (hold the throw key, strength ramps over ~0.5–1 s, release to throw; tap = full-strength throw so the common case stays snappy), which pairs naturally with the existing `predictGrenadePath` preview growing live as you charge. Alternatives considered: CS-style discrete strengths (full/lob/underhand — reproducible but coarse) and throw-to-cursor (precise but kills the lineup skill element). Implementation is small and server-safe: throw buttons already arrive as bitmask *holds* in `InputCommand`, so core counts held ticks per player and spawns on release — all inside `applyInput`, deterministic; `grenadeLaunch`/`predictGrenadePath` gain a charge/speed param; min/max speeds + charge time in `core/config.ts`. `BotController` picks a strength — bots can solve the exact speed to stop at a target point in closed form from the friction constant, making bot utility smarter. Changes sim behavior → golden replay hash update + protocol check when it lands. — **done (2026-07):** hold-to-charge with **tap = full strength, hold = shorter** (the model the user confirmed — CS-style "full on tap, short throws available"; the plan's earlier "strength ramps" wording was inverted). Throw keys became *held* bits (`InputSystem` sends `isDown`, not `JustDown`; removed from the server's `ONE_SHOT_BUTTONS`); `applyInput` accumulates `PlayerState.chargingGrenade`/`chargeTicks` and spawns on release via `grenadeChargeSpeed(ticks, dt)` — `GRENADE_THROW_SPEED` (max/tap) down to `GRENADE_THROW_SPEED_MIN` over `GRENADE_CHARGE_TIME_SEC` after a `GRENADE_CHARGE_GRACE_SEC` tap window. `grenadeLaunch`/`spawnGrenade`/`predictGrenadePath` gained a `speed` param. Feedback: a depleting throw-strength ring around the local player (`GameScene.drawChargeRing`), and the practice preview shrinks live with the charge (records + rethrows the exact speed). The existing WALK = flat-roll modifier is orthogonal (charge = distance, WALK = arc-vs-bounce). `PROTOCOL_VERSION` 4 → 5 (two new PlayerState fields on the wire); golden replay hash bumped (fields serialize as null/0 — no behavior change; replay throws no grenades). **Hold-to-charge over-wall arc mode composes** — charge sets horizontal speed under the fixed launch arc.

**Bots now use grenades with reasoning (2026-07):** `BotController` plans throws by **dry-running the deterministic grenade sim** (`predictGrenadePath`) for a handful of charge levels × both throw modes, aimed straight at a target, and commits only when a candidate lands within `BOT_THROW_TOLERANCE_PX` — so bots never lob blindly into a wall or an unreachable corner (they keep the nade instead). Three purposeful triggers: **smoke** an executing bombsite that isn't smoked yet (T, while approaching — checks `gameState.smokes` so they don't double-smoke), **flash** a known enemy corner before pushing it (HUNT state, once per lead, then holds `BOT_THROW_PREPUSH_DELAY_SEC` so it pops before peeking), and **HE** a known enemy position (never within its own blast). A committed throw owns the bot for its wind-up ticks (stand still, face target, hold the key `charge+1` ticks, release). Gated by a per-bot cooldown + a replan interval that bounds the dry-run cost, and by difficulty via `BotProfile.usesUtility` (**easy = off**, normal/hard = on); utility bots also buy `smoke/flash/he` in `autoBuyBots` when the economy allows. Debug overlay draws the planned landing spot (backtick). The closed-form "solve exact speed" idea from the plan was unnecessary — the search is simpler and robust. Bots will throw arcs over walls when that's what lands near the target, but don't yet do pre-set map lineups. Tested headless in `tests/bot-grenades.test.mjs`.

**Over-wall grenade throws (fake z-axis):** grenades get a height `z` + vertical velocity `vz` with gravity — extra numbers on `ProjectileState`, world stays 2D. In `stepGrenade`: launch with upward `vz`; while `z > WALL_HEIGHT` (one nominal constant — the sim's collision grid has no height data, and the 2.5D render's `WALL_EXTRUDE` is uniform anyway) skip the wall-bounce checks; on landing, friction slide + side bounces as today. **Decided:** a grenade whose arc descends onto a wall tile bounces off its side once below wall height (the behavior that falls out of the skip rule for free) — revisit only if it feels bad in play. Much of the game is accidentally ready for this: `explodeHE` is radial with no wall occlusion (landing behind a wall already hurts people there — becomes intended behavior), flash is view-polygon+facing (defenders behind the wall blinded, thrower isn't — the CS pop-flash), smoke lands as wall segments unchanged, and the preview/practice mode dry-runs the real `stepGrenade` + draws above fog, so over-wall lineup previews work automatically. Composes with variable throw strength (above): charge sets horizontal speed under a fixed launch arc, so one mechanic controls both distance and which walls you clear; optionally CS-style overhand (arcs) vs underhand (flat roll for corner bounces). Real work is render-side: scale sprite with `z` + separate a drop shadow (players already have one), draw airborne grenades above the extruded wall tops. Bots keep flat line-of-sight throws initially; over-wall lineups are a separable upgrade. Costs when it lands: gameplay balance shifts (walls no longer block utility — the point), golden replay hash update, `z` added to grenade snapshots → protocol version bump. — **done (2026-07):** `z`/`vz` on `ProjectileState`; `GRENADE_LAUNCH_VZ`/`GRENADE_GRAVITY`/`WALL_HEIGHT_PX` in `core/config.ts` (airtime ≈ 0.89 s — keep below the shortest fuse or that type pops mid-air); `stepGrenade` integrates the arc and skips wall bounces while `z > WALL_HEIGHT_PX`. Bounce-off-side decision refined once in testing: a non-rising grenade already inside a wall footprint (descended onto a thick wall from above) slides across the top friction-free until it drops off an edge — without the friction exemption it stranded mid-wall; a rising point-blank throw still bounces back off the face (verified headless: mid-range clears, point-blank bounces, long-range arrives below wall height and bounces off the side per the decision). Render: airborne grenades on a dedicated layer at depth 45 (above extruded walls 20, below fog 50 — over-wall throws vanish into unseen areas), body lifts up-screen (`y − z/2`) and grows with height, `WORLD.void2` shadow stays on the floor. `z` interpolated in `OnlineGameScene` buffers; `PROTOCOL_VERSION` 3 → 4. Golden replay hash unchanged (replay throws no grenades); preview/practice/HE/flash/smoke needed zero changes as predicted. Bots still throw only from line of sight — over-wall bot lineups remain a separable upgrade. **Follow-up (same month):** playtest surfaced the missing mode choice — every throw arced, killing the bounce-a-flash-around-a-corner play. **Decided: modifier key picks the mode** — throw key alone = overhand arc (over walls), WALK (SHIFT) + throw = underhand flat roll (`vz` 0, exact old behavior: stays low, bounces off walls). The walk bit already rides in `InputCommand.buttons`, so zero wire change and the server sim gets it for free; practice preview follows the held modifier live and T rethrows with the recorded mode. The descended-onto-a-wall heuristic (`vz`-based) couldn't coexist with flat rolls, so it became an explicit `overWall` flag on `ProjectileState`: set only when the grenade drifts over a footprint while above wall height, kept until it slides off — point-blank and flat throws never earn it and bounce off the face as always. Hold-to-charge throw strength (the entry above) remains open and would layer on top of the arc mode.

**Utility practice mode** (the CS "grenade practice map" experience — learning lineups is core to competitive play): an offline sandbox on any map with no bots/rounds, infinite money and grenades, a toggleable grenade trajectory preview (draw the predicted arc + landing spot before throwing — the sim's projectile step is deterministic, so the client can just dry-run it), post-throw trail rendering, smoke/flash coverage visualization, and a "rethrow last grenade" key. Most of it is client-only debug-overlay-style drawing on top of the existing offline GameScene. — **done (2026-07):** PRACTICE on the menu → `PracticeScene` (GameScene subclass, match parked in LIVE, no bots/rounds). Keys: N preview on/off, M cycle preview type, T rethrow last (exact recorded pos/angle via `spawnGrenade`), B buy panel anywhere, X/F/C throw as usual; hp/ammo/nades/money restocked every tick. Preview dry-runs the real sim (`predictGrenadePath`/`stepGrenade` extracted from `stepWorld`, behavior-identical — golden replay hash unchanged) and draws above the fog so lineups landing out of sight stay visible; trails + smoke/HE/flash coverage markers fade over 8 s.

---

## Starter Weapon Table (tune later)

Spread° is the **base** (standing-still) spread — 0 for aimed weapons since the
first-shot-accuracy pass; inaccuracy now comes from movement + bloom instead.

| Weapon | Dmg | RPM | Mag | Reload | Spread° | Price | Speed× |
| ------ | --- | --- | --- | ------ | ------- | ----- | ------ |
| Knife  | 35  | 120 | —   | —      | —       | free  | 1.10   |
| Pistol | 26  | 300 | 12  | 1.8s   | 0       | free  | 1.00   |
| SMG    | 20  | 750 | 30  | 2.2s   | 0       | $1200 | 1.00   |
| Rifle  | 33  | 600 | 30  | 2.5s   | 0       | $2700 | 0.93   |
| Sniper | 110 | 40  | 10  | 3.0s   | 0.1     | $4750 | 0.85   |

## Key References

- Red Blob Games — 2D Visibility (visibility polygon algorithm)
- Gabriel Gambetta — Fast-Paced Multiplayer series (prediction/reconciliation/interpolation)
- Valve Developer Wiki — Source Multiplayer Networking (lag compensation)
- Phaser 3 examples site + Tiled docs (tilemap workflow)
- Red Blob Games — A\* pathfinding introduction

## Suggested Milestone Cadence

Each phase is roughly 1–3 focused weekends. Sequence is dependency-ordered: 0→1→2→3 are strict prerequisites; 4/5/6 can be shuffled; 7 needs 6; 9 needs everything and rewards the discipline of rules 1–3.
