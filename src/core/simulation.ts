import { Buttons } from './types.ts';
import type {
  DeathCause,
  GameState,
  GrenadeType,
  InputCommand,
  PlayerState,
  ProjectileState,
  SimMap,
  Team,
  Vec2,
  WeaponId,
} from './types.ts';
import {
  ACCURACY_RECOVERY_SEC,
  ARMOR_ABSORPTION,
  FRIENDLY_FIRE,
  GRENADES,
  GRENADE_CHARGE_GRACE_SEC,
  GRENADE_CHARGE_TIME_SEC,
  GRENADE_FRICTION,
  GRENADE_GRAVITY,
  GRENADE_LAUNCH_VZ,
  GRENADE_RADIUS_PX,
  GRENADE_THROW_LOCKOUT_SEC,
  GRENADE_THROW_SPEED,
  GRENADE_THROW_SPEED_MIN,
  HE_DAMAGE,
  HE_RADIUS_PX,
  MOVE_SPEED,
  PLAYER_MAX_HP,
  PLAYER_RADIUS,
  SMOKE_DURATION_SEC,
  TAG_MAX_SLOW,
  TAG_PER_DAMAGE,
  TAG_RECOVERY_SEC,
  WALK_SPEED,
  WALL_HEIGHT_PX,
  WEAPONS,
  WEAPON_SWITCH_TIME,
} from './config.ts';
import { isWall, resolveCircleGrid } from './collision.ts';
import { rayCircleDist, raySegmentDist } from './raycast.ts';
import { currentSpreadDeg, damageAtRange, defaultLoadout } from './weapons.ts';

export function createGameState(rngSeed = 0x9e3779b9): GameState {
  return {
    tick: 0,
    players: {},
    projectiles: [],
    smokes: [],
    nextProjectileId: 1,
    events: [],
    rngState: rngSeed,
  };
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
    armor: 0,
    grenades: [],
    slots,
    activeSlot: slots.length - 1,
    fireCooldown: 0,
    reloadRemaining: 0,
    bloomDeg: 0,
    moveSpread: 0,
    tagged: 0,
    triggerHeld: false,
    chargingGrenade: null,
    chargeTicks: 0,
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
  p.moveSpread = 0;
  p.tagged = 0;
  p.triggerHeld = false;
  p.chargingGrenade = null;
  p.chargeTicks = 0;
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
  cause: DeathCause,
): void {
  const p = state.players[playerId];
  if (!p || p.hp <= 0) return;
  // Armor soaks a fraction of the hit until its durability runs out.
  const absorbed = Math.min(p.armor, Math.round(damage * ARMOR_ABSORPTION));
  p.armor -= absorbed;
  p.hp = Math.max(0, p.hp - (damage - absorbed));
  if (p.hp === 0) {
    state.events.push({ type: 'death', playerId: p.id, killerId, cause });
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
  handleGrenadeCharge(state, p, cmd, dt);
  // Can't shoot while a grenade is charged and ready to throw.
  const triggerDown = (cmd.buttons & Buttons.Shoot) !== 0;
  if (triggerDown && p.chargingGrenade === null) tryFire(state, p, map);
  // Recorded after firing so tryFire sees last tick's state: semi-automatic
  // weapons fire only on the press edge, never while the button stays down.
  p.triggerHeld = triggerDown;
  autoReload(state, p);
}

/**
 * An empty magazine reloads itself — once the mag runs dry there is nothing
 * else a player could want, and making them press R is just a delay. Pressing
 * R early still works. Skipped while a grenade is charged so a throw isn't
 * interrupted.
 */
function autoReload(state: GameState, p: PlayerState): void {
  if (p.chargingGrenade !== null) return;
  if (p.slots[p.activeSlot].magAmmo > 0) return;
  tryStartReload(state, p); // no-ops when the reserve is dry or already reloading
}

/** Which grenade a throw button asks for this tick (HE > flash > smoke), or null. */
function heldGrenade(buttons: number): GrenadeType | null {
  if (buttons & Buttons.ThrowHE) return 'he';
  if (buttons & Buttons.ThrowFlash) return 'flash';
  if (buttons & Buttons.ThrowSmoke) return 'smoke';
  return null;
}

/**
 * Map held charge ticks to a launch speed. Up to GRENADE_CHARGE_GRACE_SEC of
 * hold is a full-power tap; past that, the speed ramps linearly down to
 * GRENADE_THROW_SPEED_MIN over GRENADE_CHARGE_TIME_SEC. Shared by the sim and
 * the client's charge readout so they never disagree.
 */
export function grenadeChargeSpeed(chargeTicks: number, dt: number): number {
  const held = chargeTicks * dt;
  const frac = clamp01((held - GRENADE_CHARGE_GRACE_SEC) / GRENADE_CHARGE_TIME_SEC);
  return GRENADE_THROW_SPEED + (GRENADE_THROW_SPEED_MIN - GRENADE_THROW_SPEED) * frac;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Hold-to-charge throw. While a throw key is held the player accumulates
 * charge ticks; releasing it (or letting go to switch to another throw) spawns
 * the grenade at a speed derived from how long it was held. A quick tap
 * therefore throws at full strength; holding shortens the throw.
 */
function handleGrenadeCharge(
  state: GameState,
  p: PlayerState,
  cmd: InputCommand,
  dt: number,
): void {
  const held = heldGrenade(cmd.buttons);
  if (p.chargingGrenade !== null) {
    if (held === p.chargingGrenade) {
      // Cap so ticks can't grow unbounded; the extra +1 leaves room past the
      // point strength bottoms out without changing the launch speed.
      const maxTicks = Math.ceil((GRENADE_CHARGE_GRACE_SEC + GRENADE_CHARGE_TIME_SEC) / dt) + 1;
      p.chargeTicks = Math.min(p.chargeTicks + 1, maxTicks);
      return;
    }
    releaseCharge(state, p, cmd, dt);
    return;
  }
  if (held !== null && p.fireCooldown <= 0 && p.grenades.includes(held)) {
    p.chargingGrenade = held;
    p.chargeTicks = 0;
  }
}

function releaseCharge(state: GameState, p: PlayerState, cmd: InputCommand, dt: number): void {
  const type = p.chargingGrenade!;
  const ticks = p.chargeTicks;
  p.chargingGrenade = null;
  p.chargeTicks = 0;
  if (p.fireCooldown > 0) return;
  const idx = p.grenades.indexOf(type);
  if (idx < 0) return;
  p.grenades.splice(idx, 1);
  // Walk held = underhand flat roll (stays low, bounces off walls);
  // otherwise the throw is an overhand arc that clears walls.
  const flat = (cmd.buttons & Buttons.Walk) !== 0;
  spawnGrenade(state, p.id, p.pos, p.angle, type, flat, grenadeChargeSpeed(ticks, dt));
  p.fireCooldown = Math.max(p.fireCooldown, GRENADE_THROW_LOCKOUT_SEC);
}

/** Launch kinematics shared by the real throw and the trajectory preview. */
function grenadeLaunch(
  from: Vec2,
  angle: number,
  type: GrenadeType,
  flat: boolean,
  speed: number,
): { pos: Vec2; vel: Vec2; z: number; vz: number; overWall: boolean; fuse: number } {
  const dir = { x: Math.cos(angle), y: Math.sin(angle) };
  return {
    pos: { x: from.x + dir.x * (PLAYER_RADIUS + 4), y: from.y + dir.y * (PLAYER_RADIUS + 4) },
    vel: { x: dir.x * speed, y: dir.y * speed },
    z: 0,
    vz: flat ? 0 : GRENADE_LAUNCH_VZ,
    overWall: false,
    fuse: GRENADES[type].fuseSec,
  };
}

/**
 * Put a live grenade into the world, thrown from `from` toward `angle`.
 * tryThrow routes through here; practice mode's "rethrow last" calls it
 * directly with a recorded position/angle.
 */
export function spawnGrenade(
  state: GameState,
  ownerId: string,
  from: Vec2,
  angle: number,
  type: GrenadeType,
  flat = false,
  speed: number = GRENADE_THROW_SPEED,
): void {
  const l = grenadeLaunch(from, angle, type, flat, speed);
  state.projectiles.push({
    id: state.nextProjectileId++,
    type,
    ownerId,
    pos: l.pos,
    vel: l.vel,
    z: l.z,
    vz: l.vz,
    overWall: l.overWall,
    fuse: l.fuse,
  });
  state.events.push({ type: 'grenade_throw', playerId: ownerId, gtype: type, from: { ...from } });
}

/**
 * Advance world entities (grenades in flight, smoke clouds) by one tick.
 * Call once per tick after all players' applyInput.
 */
export function stepWorld(state: GameState, map: SimMap, dt: number): void {
  for (let i = state.projectiles.length - 1; i >= 0; i--) {
    const g = state.projectiles[i];
    stepGrenade(g, map, dt);
    if (g.fuse > 0) continue;
    state.projectiles.splice(i, 1);
    if (g.type === 'he') {
      explodeHE(state, g);
    } else if (g.type === 'smoke') {
      state.smokes.push({ id: g.id, pos: { ...g.pos }, timeLeft: SMOKE_DURATION_SEC });
    }
    state.events.push({ type: 'grenade_explode', gtype: g.type, pos: { ...g.pos }, ownerId: g.ownerId });
  }

  for (let i = state.smokes.length - 1; i >= 0; i--) {
    state.smokes[i].timeLeft -= dt;
    if (state.smokes[i].timeLeft <= 0) state.smokes.splice(i, 1);
  }
}

/**
 * Integrate one grenade for one tick: gravity arc on the fake z axis, then
 * axis-separated move with damped wall bounces (skipped while flying above
 * WALL_HEIGHT_PX — over-wall throws), friction, fuse. Shared verbatim by the
 * live world step and the
 * trajectory preview so the predicted arc can never drift from reality.
 */
export function stepGrenade(
  g: { pos: Vec2; vel: Vec2; z: number; vz: number; overWall: boolean; fuse: number },
  map: SimMap,
  dt: number,
): void {
  g.vz -= GRENADE_GRAVITY * dt;
  g.z += g.vz * dt;
  if (g.z <= 0) {
    g.z = 0;
    g.vz = 0;
  }
  // Walls only exist for the grenade while it flies at or below wall height.
  // overWall marks a footprint it drifted above while flying higher than the
  // wall: it slides across the top, friction-free so it can't strand
  // mid-wall, until it drops off an edge. A throw that starts overlapping a
  // wall at ground level (point-blank, flat rolls) never earns the flag, so
  // it bounces off the face as before.
  const low = g.z <= WALL_HEIGHT_PX;
  const inside = grenadeHitsWall(map, g.pos.x, g.pos.y);
  g.overWall = inside && (g.overWall || !low);
  const solid = low && !g.overWall;
  const friction = low && g.overWall ? 1 : Math.exp(-GRENADE_FRICTION * dt);
  const nx = g.pos.x + g.vel.x * dt;
  if (solid && grenadeHitsWall(map, nx, g.pos.y)) g.vel.x = -g.vel.x * 0.55;
  else g.pos.x = nx;
  const ny = g.pos.y + g.vel.y * dt;
  if (solid && grenadeHitsWall(map, g.pos.x, ny)) g.vel.y = -g.vel.y * 0.55;
  else g.pos.y = ny;
  g.vel.x *= friction;
  g.vel.y *= friction;
  g.fuse -= dt;
}

/**
 * Dry-run a throw from `from` toward `angle` at the fixed tick rate and
 * return the arc, one point per tick; the last point is where the fuse
 * expires (landing/detonation spot). Pure — touches no game state.
 */
export function predictGrenadePath(
  from: Vec2,
  angle: number,
  type: GrenadeType,
  map: SimMap,
  dt: number,
  flat = false,
  speed: number = GRENADE_THROW_SPEED,
): Vec2[] {
  const g = grenadeLaunch(from, angle, type, flat, speed);
  const points: Vec2[] = [{ x: g.pos.x, y: g.pos.y }];
  // Fuses are ~1–2s; the guard only exists to survive a bad dt.
  let guard = 1000;
  while (g.fuse > 0 && guard-- > 0) {
    stepGrenade(g, map, dt);
    points.push({ x: g.pos.x, y: g.pos.y });
  }
  return points;
}

function grenadeHitsWall(map: SimMap, x: number, y: number): boolean {
  const ts = map.grid.tileSize;
  const r = GRENADE_RADIUS_PX;
  return (
    isWall(map.grid, Math.floor((x - r) / ts), Math.floor(y / ts)) ||
    isWall(map.grid, Math.floor((x + r) / ts), Math.floor(y / ts)) ||
    isWall(map.grid, Math.floor(x / ts), Math.floor((y - r) / ts)) ||
    isWall(map.grid, Math.floor(x / ts), Math.floor((y + r) / ts))
  );
}

/** Radial damage with linear falloff. Hurts the thrower; FF rules apply to others. */
function explodeHE(state: GameState, g: ProjectileState): void {
  const owner = state.players[g.ownerId];
  for (const q of Object.values(state.players)) {
    if (q.hp <= 0) continue;
    if (!FRIENDLY_FIRE && owner && q.team === owner.team && q.id !== g.ownerId) continue;
    const dist = Math.hypot(q.pos.x - g.pos.x, q.pos.y - g.pos.y);
    if (dist >= HE_RADIUS_PX) continue;
    damagePlayer(state, q.id, Math.round(HE_DAMAGE * (1 - dist / HE_RADIUS_PX)), g.ownerId, 'he');
  }
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
  p.tagged = Math.max(0, p.tagged - dt / TAG_RECOVERY_SEC);

  if (p.reloadRemaining > 0) {
    p.reloadRemaining = Math.max(0, p.reloadRemaining - dt);
    if (p.reloadRemaining === 0) {
      const slot = p.slots[p.activeSlot];
      // Shell-by-shell loads one round per cycle and re-arms the timer until
      // the mag is full or the reserve runs out; magazines swap in one go.
      const take = def.shellReload
        ? Math.min(1, def.magSize - slot.magAmmo, slot.reserveAmmo)
        : Math.min(def.magSize - slot.magAmmo, slot.reserveAmmo);
      slot.magAmmo += take;
      slot.reserveAmmo -= take;
      if (def.shellReload && slot.magAmmo < def.magSize && slot.reserveAmmo > 0) {
        p.reloadRemaining = def.reloadTime;
      }
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
  // Recent damage drags the victim down (tagging), so whoever shoots first
  // also wins the footrace out of the duel.
  const tagMult = 1 - p.tagged * TAG_MAX_SLOW;
  const speed = (cmd.buttons & Buttons.Walk ? WALK_SPEED : MOVE_SPEED) * def.speedMult * tagMult;
  p.vel.x = mx * speed;
  p.vel.y = my * speed;

  p.pos.x += p.vel.x * dt;
  p.pos.y += p.vel.y * dt;
  resolveCircleGrid(p.pos, PLAYER_RADIUS, map.grid);

  // Movement ruins accuracy immediately, but recovers gradually: rise to the
  // current speed at once, then bleed back down over ACCURACY_RECOVERY_SEC.
  // The target is actual speed over MOVE_SPEED (unchanged from before this
  // was smoothed), so anything that slows you — a heavy weapon, walking, being
  // tagged — also steadies your aim, as in CS.
  const target = Math.min(Math.hypot(p.vel.x, p.vel.y) / MOVE_SPEED, 1);
  p.moveSpread =
    target >= p.moveSpread
      ? target
      : Math.max(target, p.moveSpread - dt / ACCURACY_RECOVERY_SEC);
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
  const slot = shooter.slots[shooter.activeSlot];
  const def = WEAPONS[slot.weaponId];
  // Semi-automatic: one shot per press, so holding the trigger does nothing.
  if (!def.auto && shooter.triggerHeld) return;
  if (shooter.fireCooldown > 0) return;
  if (def.magSize > 0 && slot.magAmmo <= 0) return;
  if (shooter.reloadRemaining > 0) {
    // Shell-by-shell reloads are interruptible — firing cancels the reload and
    // keeps the shells already loaded. Magazine reloads must finish.
    if (!def.shellReload) return;
    shooter.reloadRemaining = 0;
  }

  // One trigger pull = one ammo, `pellets` independent rays (shotgun > 1).
  const spreadDeg = currentSpreadDeg(shooter);
  for (let pellet = 0; pellet < (def.pellets ?? 1); pellet++) {
    firePellet(state, shooter, def, map, spreadDeg);
  }

  if (def.magSize > 0) slot.magAmmo--;
  // Add to the (possibly slightly negative) remainder for an exact average rate.
  shooter.fireCooldown = Math.min(shooter.fireCooldown, 0) + 60 / def.rpm;
  shooter.bloomDeg = Math.min(shooter.bloomDeg + def.bloomPerShotDeg, def.bloomMaxDeg);
}

/** One hitscan ray: spread roll, nearest wall/enemy hit, damage + event. */
function firePellet(
  state: GameState,
  shooter: PlayerState,
  def: (typeof WEAPONS)[WeaponId],
  map: SimMap,
  spreadDeg: number,
): void {
  // Spread is an angle offset, never a position offset.
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
    const hpBefore = victim.hp;
    damagePlayer(state, victim.id, Math.round(damageAtRange(def, hitDist)), shooter.id, def.id);
    // Tagging is deliberately a gunfire-only effect (the knife counts):
    // explosions already control space through raw damage, and stacking a slow
    // on top of an HE would make utility oppressive. Scaled by the health
    // actually lost, so armor blunts the stagger as well as the damage.
    victim.tagged = Math.min(1, victim.tagged + (hpBefore - victim.hp) * TAG_PER_DAMAGE);
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
}
