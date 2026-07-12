// Gameplay constants. All tunable simulation numbers live here — never
// hardcode them at usage sites.
import type { GrenadeType, WeaponDef, WeaponId } from './types.ts';

/** Fixed simulation tick rate in Hz. Rendering interpolates between ticks. */
export const TICK_RATE = 60;

/** Collision/map tile size in world pixels. */
export const TILE_SIZE = 32;

export const PLAYER_RADIUS = 12;
export const PLAYER_MAX_HP = 100;

/** Run speed in px/s (default movement). */
export const MOVE_SPEED = 200;
/** Walk speed in px/s (shift held — slower, and silent in later phases). */
export const WALK_SPEED = 110;

/** Seconds a weapon is unusable after switching to it. */
export const WEAPON_SWITCH_TIME = 0.4;

// --- Vision (Phase 4) ---------------------------------------------------
/** Full width of the view cone, degrees. */
export const VISION_CONE_DEG = 110;
/** 360° awareness radius around the player (2.5 tiles). */
export const AWARENESS_RADIUS = 80;
/** Max sight distance in px. */
export const VISION_RANGE = 900;
/** Playtesting/easy-mode toggle: ignore the cone, see all around. */
export const FULL_CIRCLE_VISION = false;

// --- Match structure (Phase 7) --------------------------------------------
/** Players per team (1 human + bots on T, all bots on CT). */
export const TEAM_SIZE = 3;
export const FRIENDLY_FIRE = false;
/** First team to this many round wins takes the match. */
export const ROUNDS_TO_WIN = 13;

export const WARMUP_TIME_SEC = 3;
/** Buy/freeze time at round start — players can buy but not move. */
export const BUY_TIME_SEC = 8;
/** LIVE round length; expiry without a plant is a CT win. */
export const ROUND_TIME_SEC = 100;
/** Pause between rounds showing the result. */
export const ROUND_END_TIME_SEC = 4;

// Economy — simplified four-number model (see docs/PLAN.md design decisions).
export const START_MONEY = 800;
export const KILL_REWARD = 300;
export const WIN_REWARD = 3250;
/** Base loss bonus + escalation per consecutive loss, and its cap. */
export const LOSS_BONUS_BASE = 1400;
export const LOSS_BONUS_STEP = 500;
export const LOSS_BONUS_MAX = 3400;
export const MONEY_CAP = 16000;
export const DEFUSE_KIT_PRICE = 400;
export const ARMOR_PRICE = 650;
export const ARMOR_MAX = 100;
/** Fraction of incoming damage the armor soaks up (until it breaks). */
export const ARMOR_ABSORPTION = 0.5;

// Grenades (Phase 8) — projectile entities in the simulation.
export interface GrenadeDef {
  price: number;
  /** Seconds from throw to detonation/activation. */
  fuseSec: number;
}
export const GRENADES: Record<GrenadeType, GrenadeDef> = {
  he: { price: 300, fuseSec: 1.6 },
  flash: { price: 200, fuseSec: 1.2 },
  smoke: { price: 300, fuseSec: 1.0 },
};
export const GRENADE_THROW_SPEED = 420;
/** Exponential velocity decay coefficient, per second. */
export const GRENADE_FRICTION = 1.6;
/** Grenade body radius for wall bounces, px. */
export const GRENADE_RADIUS_PX = 5;
/** Seconds a throw locks the trigger (no same-instant shooting). */
export const GRENADE_THROW_LOCKOUT_SEC = 0.5;
export const HE_DAMAGE = 90;
export const HE_RADIUS_PX = 280;
/** Flash: full blind at the source, scaling to zero at this range. */
export const FLASH_RANGE_PX = 700;
export const FLASH_MAX_BLIND_SEC = 2.2;
/** Blind factor when the flash pops behind the viewer. */
export const FLASH_BEHIND_MULT = 0.35;
export const SMOKE_RADIUS_PX = 88;
export const SMOKE_DURATION_SEC = 12;

// Bomb.
export const BOMB_PLANT_TIME_SEC = 3;
export const BOMB_TIMER_SEC = 40;
export const BOMB_DEFUSE_TIME_SEC = 10;
export const BOMB_DEFUSE_KIT_TIME_SEC = 5;
/** Max reach to start defusing a planted bomb, px. */
export const BOMB_DEFUSE_RANGE_PX = 60;
/** Walking over a dropped bomb within this range picks it up (T only). */
export const BOMB_PICKUP_RANGE_PX = 32;
/** Explosion: full damage at the bomb, linear falloff to zero at the edge. */
export const BOMB_DAMAGE = 500;
export const BOMB_RADIUS_PX = 550;

// --- Bots (Phase 6) -------------------------------------------------------
export type BotDifficulty = 'easy' | 'normal' | 'hard';

/** Per-difficulty bot tuning. All the knobs that make bots feel dumber/smarter. */
export interface BotProfile {
  /** Delay between first sighting an enemy and being allowed to fire, sec. */
  reactionSec: number;
  /** Gaussian aim error (σ, degrees) at first sight. */
  aimErrorDeg: number;
  /** Aim error after focusing on a visible target for aimFocusSec. */
  aimErrorMinDeg: number;
  /** Seconds of continuous sight to shrink aim error to the minimum. */
  aimFocusSec: number;
  /** Trigger discipline: hold fire this long, then pause. */
  burstSec: number;
  burstPauseSec: number;
  /** Gunshots and running footsteps within this radius set last-known-pos. */
  hearingRangePx: number;
  /** Fall back below this hp fraction (0 = never retreats). */
  retreatHpFrac: number;
}

export const BOT_PROFILES: Record<BotDifficulty, BotProfile> = {
  easy: {
    reactionSec: 0.5,
    aimErrorDeg: 7,
    aimErrorMinDeg: 3.5,
    aimFocusSec: 2.0,
    burstSec: 0.18,
    burstPauseSec: 0.7,
    hearingRangePx: 450,
    retreatHpFrac: 0.35,
  },
  normal: {
    reactionSec: 0.32,
    aimErrorDeg: 4.5,
    aimErrorMinDeg: 1.6,
    aimFocusSec: 1.5,
    burstSec: 0.25,
    burstPauseSec: 0.45,
    hearingRangePx: 700,
    retreatHpFrac: 0.25,
  },
  hard: {
    reactionSec: 0.2,
    aimErrorDeg: 2.6,
    aimErrorMinDeg: 0.8,
    aimFocusSec: 1.1,
    burstSec: 0.35,
    burstPauseSec: 0.28,
    hearingRangePx: 950,
    retreatHpFrac: 0.12,
  },
};

/** Enemy movement above this speed is audible to bots (walking is silent). */
export const BOT_FOOTSTEP_MIN_SPEED = 140;
/** A path waypoint counts as reached within this distance, px. */
export const BOT_WAYPOINT_REACHED_PX = 10;
/** How often a bot recomputes its path while chasing a moving goal, sec. */
export const BOT_REPATH_SEC = 0.6;
/** No progress along a path for this long forces a repath, sec. */
export const BOT_STUCK_SEC = 0.7;
/** Seconds spent scanning around the last-known-position before giving up. */
export const BOT_SEARCH_SEC = 4;
/** Aim sweep speed while searching, rad/s. */
export const BOT_SEARCH_TURN_RATE = 2.4;
/** Strafe direction flips after a random interval in this range, sec. */
export const BOT_STRAFE_MIN_SEC = 0.35;
export const BOT_STRAFE_MAX_SEC = 0.9;
/** Bots close distance while engaging beyond this range, px. */
export const BOT_ENGAGE_RANGE_PX = 520;
/** Aim error is re-rolled at this interval so it wanders, not vibrates. */
export const BOT_AIM_JITTER_SEC = 0.12;
/** Aim sweep speed while standing guard on an objective, rad/s. */
export const BOT_GUARD_TURN_RATE = 1.2;

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  knife: {
    id: 'knife',
    slotIndex: 0,
    damage: 35,
    rpm: 120,
    magSize: 0,
    reserveSize: 0,
    reloadTime: 0,
    spreadBaseDeg: 0,
    spreadMoveDeg: 0,
    bloomPerShotDeg: 0,
    bloomMaxDeg: 0,
    bloomDecayDegPerSec: 0,
    falloffStartPx: 0,
    falloffEndPx: 1,
    falloffMinMult: 1,
    maxRangePx: 45,
    price: 0,
    speedMult: 1.1,
  },
  pistol: {
    id: 'pistol',
    slotIndex: 1,
    damage: 26,
    rpm: 300,
    magSize: 12,
    reserveSize: 36,
    reloadTime: 1.8,
    spreadBaseDeg: 1.5,
    spreadMoveDeg: 1.2,
    bloomPerShotDeg: 0.7,
    bloomMaxDeg: 2.5,
    bloomDecayDegPerSec: 5,
    falloffStartPx: 350,
    falloffEndPx: 1200,
    falloffMinMult: 0.55,
    maxRangePx: 2400,
    price: 0,
    speedMult: 1.0,
  },
  deagle: {
    id: 'deagle',
    slotIndex: 1,
    damage: 53,
    rpm: 240,
    magSize: 7,
    reserveSize: 21,
    reloadTime: 2.2,
    spreadBaseDeg: 0.8,
    spreadMoveDeg: 4.0,
    bloomPerShotDeg: 2.0,
    bloomMaxDeg: 6.0,
    bloomDecayDegPerSec: 8,
    falloffStartPx: 400,
    falloffEndPx: 1400,
    falloffMinMult: 0.65,
    maxRangePx: 2400,
    price: 700,
    speedMult: 1.0,
  },
  shotgun: {
    id: 'shotgun',
    slotIndex: 2,
    damage: 9,
    rpm: 68,
    magSize: 6,
    reserveSize: 24,
    reloadTime: 3.0,
    spreadBaseDeg: 4.0,
    spreadMoveDeg: 1.5,
    bloomPerShotDeg: 0,
    bloomMaxDeg: 0,
    bloomDecayDegPerSec: 0,
    falloffStartPx: 120,
    falloffEndPx: 550,
    falloffMinMult: 0.1,
    maxRangePx: 900,
    price: 1100,
    speedMult: 0.96,
    pellets: 8,
  },
  smg: {
    id: 'smg',
    slotIndex: 2,
    damage: 20,
    rpm: 750,
    magSize: 30,
    reserveSize: 90,
    reloadTime: 2.2,
    spreadBaseDeg: 3.0,
    spreadMoveDeg: 1.5,
    bloomPerShotDeg: 0.35,
    bloomMaxDeg: 3.0,
    bloomDecayDegPerSec: 6,
    falloffStartPx: 300,
    falloffEndPx: 1000,
    falloffMinMult: 0.5,
    maxRangePx: 2400,
    price: 1200,
    speedMult: 1.0,
  },
  rifle: {
    id: 'rifle',
    slotIndex: 2,
    damage: 33,
    rpm: 600,
    magSize: 30,
    reserveSize: 90,
    reloadTime: 2.5,
    spreadBaseDeg: 2.0,
    spreadMoveDeg: 2.5,
    bloomPerShotDeg: 0.45,
    bloomMaxDeg: 3.5,
    bloomDecayDegPerSec: 5,
    falloffStartPx: 500,
    falloffEndPx: 1600,
    falloffMinMult: 0.7,
    maxRangePx: 2400,
    price: 2700,
    speedMult: 0.93,
  },
  sniper: {
    id: 'sniper',
    slotIndex: 2,
    damage: 110,
    rpm: 40,
    magSize: 10,
    reserveSize: 20,
    reloadTime: 3.0,
    spreadBaseDeg: 0.1,
    spreadMoveDeg: 5.0,
    bloomPerShotDeg: 0,
    bloomMaxDeg: 0,
    bloomDecayDegPerSec: 0,
    falloffStartPx: 2400,
    falloffEndPx: 2401,
    falloffMinMult: 1,
    maxRangePx: 2400,
    price: 4750,
    speedMult: 0.85,
  },
};
