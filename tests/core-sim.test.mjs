// Core simulation tests: collision, raycasts, spread/damage falloff, and a
// replay-based determinism check. This is the code both client and server
// share — where a silent regression breaks multiplayer fairness.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Buttons } from '../src/core/types.ts';
import { isWall, resolveCircleGrid } from '../src/core/collision.ts';
import { castRay, raySegmentDist } from '../src/core/raycast.ts';
import { currentSpreadDeg, damageAtRange, givePrimary } from '../src/core/weapons.ts';
import {
  GRENADE_CHARGE_GRACE_SEC,
  GRENADE_CHARGE_TIME_SEC,
  GRENADE_THROW_SPEED,
  GRENADE_THROW_SPEED_MIN,
  MOVE_SPEED,
  TICK_RATE,
  WEAPONS,
} from '../src/core/config.ts';
import { applyInput, createGameState, createPlayer, stepWorld } from '../src/core/simulation.ts';
import { parseTiledMap } from '../src/core/map.ts';

let failures = 0;
function check(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
}
function close(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}

// --- Raycast -----------------------------------------------------------------
{
  const seg = { a: { x: 100, y: -50 }, b: { x: 100, y: 50 } };
  const d = raySegmentDist({ x: 0, y: 0 }, { x: 1, y: 0 }, seg);
  check(d !== null && close(d, 100), 'ray hits a perpendicular wall at the right distance');
  check(raySegmentDist({ x: 0, y: 0 }, { x: -1, y: 0 }, seg) === null, 'ray pointing away misses');
  check(
    raySegmentDist({ x: 0, y: 100 }, { x: 1, y: 0 }, seg) === null,
    'ray passing beyond the segment end misses',
  );
  const hit = castRay({ x: 0, y: 0 }, 0, [seg], 500);
  check(hit.hitWall && close(hit.dist, 100) && close(hit.point.x, 100), 'castRay picks the wall');
  const miss = castRay({ x: 0, y: 0 }, Math.PI, [seg], 500);
  check(!miss.hitWall && close(miss.dist, 500), 'castRay clamps to maxDist on a miss');
}

// --- Collision ----------------------------------------------------------------
{
  // 3×3 grid, solid center tile (tileSize 32 → tile spans 32..64).
  const grid = {
    tileSize: 32,
    width: 3,
    height: 3,
    cells: [
      [0, 0, 0],
      [0, 1, 0],
      [0, 0, 0],
    ],
  };
  check(isWall(grid, 1, 1) && !isWall(grid, 0, 0), 'isWall reads cells');
  check(isWall(grid, -1, 0) && isWall(grid, 3, 0), 'outside the grid is solid');

  // Circle overlapping the tile's left face gets pushed out along -x only.
  const pos = { x: 30, y: 48 };
  resolveCircleGrid(pos, 8, grid);
  check(close(pos.x, 24, 1e-6) && close(pos.y, 48, 1e-6), 'push-out resolves along the face normal');

  // A circle in open space is untouched.
  const free = { x: 16, y: 16 };
  resolveCircleGrid(free, 8, grid);
  check(free.x === 16 && free.y === 16, 'no correction in open space');
}

// --- Spread + damage falloff ---------------------------------------------------
{
  const rifle = WEAPONS.rifle;
  check(close(damageAtRange(rifle, 0), rifle.damage), 'full damage before falloff start');
  check(
    close(damageAtRange(rifle, rifle.falloffEndPx), rifle.damage * rifle.falloffMinMult),
    'min multiplier at falloff end',
  );
  const mid = (rifle.falloffStartPx + rifle.falloffEndPx) / 2;
  check(
    close(damageAtRange(rifle, mid), rifle.damage * (1 - 0.5 * (1 - rifle.falloffMinMult))),
    'linear falloff at the midpoint',
  );
  check(
    close(damageAtRange(rifle, rifle.falloffEndPx * 10), rifle.damage * rifle.falloffMinMult),
    'falloff clamps past the end',
  );

  const state = createGameState(1);
  state.players.p = createPlayer('p', 'T', 100, 100);
  givePrimary(state.players.p, 'rifle');
  state.players.p.activeSlot = 2;
  const standing = currentSpreadDeg(state.players.p);
  check(close(standing, rifle.spreadBaseDeg), 'standing spread = base');
  state.players.p.vel = { x: MOVE_SPEED, y: 0 };
  check(
    close(currentSpreadDeg(state.players.p), rifle.spreadBaseDeg + rifle.spreadMoveDeg),
    'full-speed spread adds the movement penalty',
  );
}

// --- First-shot accuracy ------------------------------------------------------
// A stationary, unbloomed aimed weapon must put its first shot exactly on the
// crosshair (CS-style). Guarding this behaviorally, not just as a config value:
// at long range even a fraction of a degree misses a PLAYER_RADIUS target.
{
  for (const id of ['pistol', 'deagle', 'smg', 'rifle']) {
    check(WEAPONS[id].spreadBaseDeg === 0, `${id}: no base spread (first shot is pinpoint)`);
  }

  const grid = {
    tileSize: 32,
    width: 60,
    height: 30,
    cells: Array.from({ length: 30 }, () => new Array(60).fill(0)),
  };
  const map = { grid, segments: [] }; // open field: nothing blocks the ray
  const DT = 1 / TICK_RATE;
  const RANGE_PX = 1200; // far enough that old base spread (2°) missed often

  // Across seeds, so this proves determinism-of-aim rather than a lucky roll.
  let hits = 0;
  const SEEDS = 25;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const s = createGameState(seed);
    s.players.shooter = createPlayer('shooter', 'T', 200, 500);
    s.players.target = createPlayer('target', 'CT', 200 + RANGE_PX, 500);
    givePrimary(s.players.shooter, 'rifle');
    s.players.shooter.activeSlot = 2;
    // Stationary, aimed dead at the target, single trigger pull.
    applyInput(s, 'shooter', { tick: 0, moveX: 0, moveY: 0, aimAngle: 0, buttons: Buttons.Shoot }, map, DT);
    if (s.events.some((e) => e.type === 'shot' && e.hitPlayerId === 'target')) hits++;
  }
  check(hits === SEEDS, `stationary first shot always hits at ${RANGE_PX}px (${hits}/${SEEDS})`);

  // The counterpart: moving still spoils accuracy, so the tradeoff survives.
  let movingHits = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const s = createGameState(seed);
    s.players.shooter = createPlayer('shooter', 'T', 200, 500);
    s.players.target = createPlayer('target', 'CT', 200 + RANGE_PX, 500);
    givePrimary(s.players.shooter, 'rifle');
    s.players.shooter.activeSlot = 2;
    applyInput(s, 'shooter', { tick: 0, moveX: 0, moveY: 1, aimAngle: 0, buttons: Buttons.Shoot }, map, DT);
    if (s.events.some((e) => e.type === 'shot' && e.hitPlayerId === 'target')) movingHits++;
  }
  check(movingHits < SEEDS, `moving still spoils long-range accuracy (${movingHits}/${SEEDS} hit)`);
}

// --- Variable throw strength (hold-to-charge) --------------------------------
{
  const dt = 1 / TICK_RATE;
  const grid = {
    tileSize: 32,
    width: 30,
    height: 30,
    cells: Array.from({ length: 30 }, () => new Array(30).fill(0)),
  };
  const map = { grid, segments: [] };

  // Hold the HE throw for `holdTicks` ticks, then release; return the grenade.
  function throwAfter(holdTicks) {
    const st = createGameState();
    const p = createPlayer('p1', 'T', 200, 200);
    p.grenades = ['he'];
    st.players['p1'] = p;
    const cmd = (buttons) => ({ tick: 0, moveX: 0, moveY: 0, aimAngle: 0, buttons });
    for (let i = 0; i < holdTicks; i++) applyInput(st, 'p1', cmd(Buttons.ThrowHE), map, dt);
    applyInput(st, 'p1', cmd(0), map, dt); // release
    return { g: st.projectiles[0], p };
  }
  const speedOf = (g) => Math.hypot(g.vel.x, g.vel.y);
  const fullHold = Math.ceil((GRENADE_CHARGE_GRACE_SEC + GRENADE_CHARGE_TIME_SEC) / dt) + 3;

  const tap = throwAfter(1);
  check(tap.g && close(speedOf(tap.g), GRENADE_THROW_SPEED, 1e-6), 'a tap throws at full speed');
  check(tap.p.grenades.length === 0, 'throwing consumes the grenade');
  check(tap.p.chargingGrenade === null && tap.p.chargeTicks === 0, 'charge state clears on release');

  const held = throwAfter(fullHold);
  check(
    held.g && close(speedOf(held.g), GRENADE_THROW_SPEED_MIN, 1e-6),
    'a full hold throws at the minimum speed',
  );

  const mid = throwAfter(Math.ceil(fullHold / 2));
  const midSpeed = mid.g ? speedOf(mid.g) : 0;
  check(
    midSpeed < GRENADE_THROW_SPEED && midSpeed > GRENADE_THROW_SPEED_MIN,
    'a partial hold lands between full and minimum',
  );

  // Holding the throw key must not spawn until release.
  {
    const st = createGameState();
    const p = createPlayer('p1', 'T', 200, 200);
    p.grenades = ['he'];
    st.players['p1'] = p;
    for (let i = 0; i < 10; i++) {
      applyInput(st, 'p1', { tick: 0, moveX: 0, moveY: 0, aimAngle: 0, buttons: Buttons.ThrowHE }, map, dt);
    }
    check(st.projectiles.length === 0 && p.chargingGrenade === 'he', 'grenade charges while held, no throw yet');
  }
}

// --- Replay determinism + regression hash --------------------------------------
// A scripted input stream through the real map must always land on the same
// final state. If this hash changes, the simulation's behavior changed —
// bump it ONLY when that change is intentional (it invalidates replays and
// breaks in-flight client/server compatibility).
{
  const map = parseTiledMap(
    JSON.parse(readFileSync(new URL('../public/assets/maps/de_yard.json', import.meta.url), 'utf8')),
  );
  const DT = 1 / TICK_RATE;

  function run() {
    const state = createGameState(1234);
    state.players.a = createPlayer('a', 'T', 200, 1100);
    state.players.b = createPlayer('b', 'CT', 400, 1100);
    givePrimary(state.players.a, 'rifle');
    state.players.a.activeSlot = 2;
    for (let tick = 0; tick < 600; tick++) {
      // Deterministic pseudo-input: wander + aim sweep, shooting in bursts.
      for (const [i, id] of ['a', 'b'].entries()) {
        const phase = tick / 60 + i * 2;
        applyInput(
          state,
          id,
          {
            tick,
            moveX: Math.sin(phase),
            moveY: Math.cos(phase * 0.7),
            aimAngle: phase % (Math.PI * 2),
            buttons: tick % 90 < 20 ? Buttons.Shoot : 0,
          },
          map,
          DT,
        );
      }
      stepWorld(state, map, DT);
      state.tick++;
      state.events.length = 0; // scenes drain these every tick
    }
    return state;
  }

  const h1 = createHash('sha256').update(JSON.stringify(run())).digest('hex').slice(0, 16);
  const h2 = createHash('sha256').update(JSON.stringify(run())).digest('hex').slice(0, 16);
  check(h1 === h2, 'simulation is deterministic (same inputs → same state)');
  // Bumped when hold-to-charge added chargingGrenade/chargeTicks to
  // PlayerState — the replay throws no grenades, so this reflects the two new
  // serialized fields (null/0), not a behavior change.
  const GOLDEN = '92d7fe13e2d368d3';
  check(
    h1 === GOLDEN,
    `replay regression hash unchanged (got ${h1}) — a mismatch means sim behavior changed; update GOLDEN only if that was intentional`,
  );
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
