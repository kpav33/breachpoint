import { Buttons } from './types.ts';
import type {
  GameState,
  InputCommand,
  PlayerState,
  SimMap,
  Team,
  Vec2,
  WeaponId,
} from './types.ts';
import {
  FRIENDLY_FIRE,
  MOVE_SPEED,
  PLAYER_MAX_HP,
  PLAYER_RADIUS,
  WALK_SPEED,
  WEAPONS,
  WEAPON_SWITCH_TIME,
} from './config.ts';
import { resolveCircleGrid } from './collision.ts';
import { rayCircleDist, raySegmentDist } from './raycast.ts';
import { currentSpreadDeg, damageAtRange, defaultLoadout } from './weapons.ts';

export function createGameState(rngSeed = 0x9e3779b9): GameState {
  return { tick: 0, players: {}, projectiles: [], events: [], rngState: rngSeed };
}

export function createPlayer(
  id: string,
  team: Team,
  x: number,
  y: number,
  primary?: WeaponId,
): PlayerState {
  const slots = defaultLoadout(primary);
  return {
    id,
    team,
    pos: { x, y },
    vel: { x: 0, y: 0 },
    angle: 0,
    hp: PLAYER_MAX_HP,
    slots,
    activeSlot: slots.length - 1,
    fireCooldown: 0,
    reloadRemaining: 0,
    bloomDeg: 0,
  };
}

/** Reset a player for (re)spawn: full hp, stocked mags, timers cleared. */
export function respawnPlayer(state: GameState, playerId: string, pos: Vec2): void {
  const p = state.players[playerId];
  if (!p) return;
  p.pos = { x: pos.x, y: pos.y };
  p.vel = { x: 0, y: 0 };
  p.hp = PLAYER_MAX_HP;
  for (const slot of p.slots) {
    const def = WEAPONS[slot.weaponId];
    slot.magAmmo = def.magSize;
    slot.reserveAmmo = def.reserveSize;
  }
  p.fireCooldown = 0;
  p.reloadRemaining = 0;
  p.bloomDeg = 0;
}

/**
 * Apply damage and emit the death event. The only way hp goes down —
 * gunfire and match-layer sources (bomb explosion) both route through here.
 */
export function damagePlayer(
  state: GameState,
  playerId: string,
  damage: number,
  killerId: string,
): void {
  const p = state.players[playerId];
  if (!p || p.hp <= 0) return;
  p.hp = Math.max(0, p.hp - damage);
  if (p.hp === 0) {
    state.events.push({ type: 'death', playerId: p.id, killerId });
  }
}

/** Deterministic xorshift32 in [0, 1) — all sim randomness rolls through here. */
export function nextRand(state: GameState): number {
  let x = state.rngState | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.rngState = x | 0;
  return (x >>> 0) / 4294967296;
}

const DEG_TO_RAD = Math.PI / 180;

/**
 * The single entry point that mutates a player. Applies one InputCommand
 * for one fixed timestep: weapon selection, timers, movement + collision,
 * aim, reload, fire.
 */
export function applyInput(
  state: GameState,
  playerId: string,
  cmd: InputCommand,
  map: SimMap,
  dt: number,
): void {
  const p = state.players[playerId];
  if (!p || p.hp <= 0) return;

  selectWeapon(p, cmd.buttons);
  tickTimers(p, dt);
  move(p, cmd, map, dt);
  p.angle = cmd.aimAngle;
  if (cmd.buttons & Buttons.Reload) tryStartReload(state, p);
  if (cmd.buttons & Buttons.Shoot) tryFire(state, p, map);
}

function selectWeapon(p: PlayerState, buttons: number): void {
  let target = p.activeSlot;
  if (buttons & Buttons.SelectMelee) target = 0;
  else if (buttons & Buttons.SelectSecondary) target = 1;
  else if (buttons & Buttons.SelectPrimary) target = 2;
  else if (buttons & Buttons.NextWeapon) target = (p.activeSlot + 1) % p.slots.length;
  else if (buttons & Buttons.PrevWeapon)
    target = (p.activeSlot + p.slots.length - 1) % p.slots.length;

  if (target === p.activeSlot || target >= p.slots.length) return;
  p.activeSlot = target;
  p.reloadRemaining = 0; // switching cancels a reload
  p.bloomDeg = 0;
  p.fireCooldown = Math.max(p.fireCooldown, WEAPON_SWITCH_TIME);
}

function tickTimers(p: PlayerState, dt: number): void {
  // Allow up to one tick of negative remainder so float error can't stretch
  // the effective fire interval (e.g. 600 rpm decaying to ~514).
  p.fireCooldown = Math.max(p.fireCooldown - dt, -dt);

  const def = WEAPONS[p.slots[p.activeSlot].weaponId];
  p.bloomDeg = Math.max(0, p.bloomDeg - def.bloomDecayDegPerSec * dt);

  if (p.reloadRemaining > 0) {
    p.reloadRemaining = Math.max(0, p.reloadRemaining - dt);
    if (p.reloadRemaining === 0) {
      const slot = p.slots[p.activeSlot];
      const take = Math.min(def.magSize - slot.magAmmo, slot.reserveAmmo);
      slot.magAmmo += take;
      slot.reserveAmmo -= take;
    }
  }
}

function move(p: PlayerState, cmd: InputCommand, map: SimMap, dt: number): void {
  let mx = cmd.moveX;
  let my = cmd.moveY;
  // Normalize before scaling by speed, or diagonals are 41% faster.
  const len = Math.hypot(mx, my);
  if (len > 1) {
    mx /= len;
    my /= len;
  }

  const def = WEAPONS[p.slots[p.activeSlot].weaponId];
  const speed = (cmd.buttons & Buttons.Walk ? WALK_SPEED : MOVE_SPEED) * def.speedMult;
  p.vel.x = mx * speed;
  p.vel.y = my * speed;

  p.pos.x += p.vel.x * dt;
  p.pos.y += p.vel.y * dt;
  resolveCircleGrid(p.pos, PLAYER_RADIUS, map.grid);
}

function tryStartReload(state: GameState, p: PlayerState): void {
  const slot = p.slots[p.activeSlot];
  const def = WEAPONS[slot.weaponId];
  if (def.magSize === 0) return;
  if (p.reloadRemaining > 0 || slot.magAmmo >= def.magSize || slot.reserveAmmo <= 0) return;
  p.reloadRemaining = def.reloadTime;
  state.events.push({ type: 'reload', playerId: p.id, weaponId: def.id });
}

function tryFire(state: GameState, shooter: PlayerState, map: SimMap): void {
  if (shooter.fireCooldown > 0 || shooter.reloadRemaining > 0) return;
  const slot = shooter.slots[shooter.activeSlot];
  const def = WEAPONS[slot.weaponId];
  if (def.magSize > 0 && slot.magAmmo <= 0) return;

  // Spread is an angle offset, never a position offset.
  const spreadDeg = currentSpreadDeg(shooter);
  const angle = shooter.angle + (nextRand(state) * 2 - 1) * spreadDeg * DEG_TO_RAD;
  const dir = { x: Math.cos(angle), y: Math.sin(angle) };

  let hitDist = def.maxRangePx;
  let hit: 'wall' | 'player' | 'none' = 'none';
  let victim: PlayerState | null = null;

  for (const seg of map.segments) {
    const t = raySegmentDist(shooter.pos, dir, seg);
    if (t !== null && t < hitDist) {
      hitDist = t;
      hit = 'wall';
    }
  }
  for (const q of Object.values(state.players)) {
    if (q.id === shooter.id || q.hp <= 0) continue; // never hit yourself
    // With friendly fire off, bullets pass through teammates entirely.
    if (!FRIENDLY_FIRE && q.team === shooter.team) continue;
    const t = rayCircleDist(shooter.pos, dir, q.pos, PLAYER_RADIUS);
    if (t !== null && t < hitDist) {
      hitDist = t;
      hit = 'player';
      victim = q;
    }
  }

  if (victim) {
    damagePlayer(state, victim.id, Math.round(damageAtRange(def, hitDist)), shooter.id);
  }

  const muzzle = PLAYER_RADIUS + 2;
  state.events.push({
    type: 'shot',
    playerId: shooter.id,
    weaponId: def.id,
    from: { x: shooter.pos.x + dir.x * muzzle, y: shooter.pos.y + dir.y * muzzle },
    to: { x: shooter.pos.x + dir.x * hitDist, y: shooter.pos.y + dir.y * hitDist },
    hit,
    hitPlayerId: victim?.id,
  });

  if (def.magSize > 0) slot.magAmmo--;
  // Add to the (possibly slightly negative) remainder for an exact average rate.
  shooter.fireCooldown = Math.min(shooter.fireCooldown, 0) + 60 / def.rpm;
  shooter.bloomDeg = Math.min(shooter.bloomDeg + def.bloomPerShotDeg, def.bloomMaxDeg);
}
