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
