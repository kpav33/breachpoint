// Gameplay constants. All tunable simulation numbers live here — never
// hardcode them at usage sites.
import type { WeaponDef, WeaponId } from './types.ts';

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

/** Difficulty used for spawned bots until a menu exposes the choice. */
export const BOT_DIFFICULTY: BotDifficulty = 'normal';

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
