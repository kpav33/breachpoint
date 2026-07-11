import type { PlayerState, WeaponDef, WeaponId, WeaponSlot } from './types.ts';
import { MOVE_SPEED, WEAPONS } from './config.ts';

export function makeSlot(weaponId: WeaponId): WeaponSlot {
  const def = WEAPONS[weaponId];
  return { weaponId, magAmmo: def.magSize, reserveAmmo: def.reserveSize };
}

/** [knife, pistol, primary?] — ordered by WeaponDef.slotIndex. */
export function defaultLoadout(primary?: WeaponId): WeaponSlot[] {
  const slots = [makeSlot('knife'), makeSlot('pistol')];
  if (primary) slots.push(makeSlot(primary));
  return slots;
}

export function activeWeapon(p: PlayerState): WeaponDef {
  return WEAPONS[p.slots[p.activeSlot].weaponId];
}

/**
 * Set the player's primary (slot 2), fully stocked, and switch to it.
 * Used by debug loadout keys now; the Phase 7 buy menu reuses it.
 */
export function givePrimary(p: PlayerState, weaponId: WeaponId): void {
  p.slots[2] = makeSlot(weaponId);
  p.activeSlot = 2;
  p.reloadRemaining = 0;
}

/**
 * Effective spread half-angle in degrees for the player's current weapon
 * and movement speed. Spread is an *angle*, never a position offset.
 */
export function currentSpreadDeg(p: PlayerState): number {
  const def = activeWeapon(p);
  const speedFrac = Math.min(Math.hypot(p.vel.x, p.vel.y) / MOVE_SPEED, 1);
  return def.spreadBaseDeg + def.spreadMoveDeg * speedFrac + p.bloomDeg;
}

/** Linear range falloff: full damage until start, minMult at end. */
export function damageAtRange(def: WeaponDef, dist: number): number {
  if (dist <= def.falloffStartPx) return def.damage;
  const span = def.falloffEndPx - def.falloffStartPx;
  const frac = Math.min((dist - def.falloffStartPx) / span, 1);
  return def.damage * (1 - frac * (1 - def.falloffMinMult));
}
