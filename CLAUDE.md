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
- `src/game/` — Phaser-side: entities, systems (input, vision, effects, audio), map loading, bot AI
- `src/scenes/` — Boot, Menu, Game (thin orchestrator), UI (HUD, parallel scene)
- `src/match/` — rounds, economy, bomb logic, game modes
- `public/assets/` — sprites, Tiled map JSON, tilesets, audio

## Commands

- `npm run dev` — Vite dev server
- `npm run build` — production build
- `npm run lint` — ESLint (includes the core/ import restriction)
<!-- Update this section as commands are added (tests, typecheck, etc.) -->

## Workflow

- Gameplay constants (speeds, weapon stats, cone angle, economy numbers) always live in `core/config.ts` — never hardcode them at usage sites.
- Extend the debug overlay (backtick toggle) whenever you add a system that has invisible state (rays, polygons, bot states, paths).
- After completing a phase: run lint + build, summarize what changed, and update this file if commands or conventions changed. Do not start the next phase unprompted.
