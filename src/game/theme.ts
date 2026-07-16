// Breachpoint visual system v1 (design/Breachpoint Design System.dc.html).
// Every render-side color comes from these tokens — never invent one-off hex
// values at usage sites; if a role has no token, add it here first.
// Two fog temperatures ship as a set; NIGHTFALL is the default. Player, HUD
// and effect tokens are identical between them — only the world shifts.
import type { Team } from '../core/types';

export interface WorldPalette {
  /** Off-map void (page + fog tint). */
  void: number;
  void2: number;
  floor: number;
  floorLine: number;
  site: number;
  siteLine: number;
  wall: number;
  wallTop: number;
  wallDark: number;
}

const NIGHTFALL: WorldPalette = {
  void: 0x0d1014,
  void2: 0x0a0d11,
  floor: 0x1b2027,
  floorLine: 0x20262e,
  site: 0x2c2820,
  siteLine: 0x544824,
  wall: 0x3f4a56,
  wallTop: 0x57646f,
  wallDark: 0x2b333c,
};

const EMBER: WorldPalette = {
  void: 0x120f0c,
  void2: 0x0d0a08,
  floor: 0x221d17,
  floorLine: 0x28221a,
  site: 0x2e2417,
  siteLine: 0x5a4a22,
  wall: 0x4b443b,
  wallTop: 0x61574a,
  wallDark: 0x332d25,
};

export const WORLD_PALETTES = { NIGHTFALL, EMBER };
/** Active fog temperature. Swap to EMBER to re-theme the whole world. */
const ACTIVE: keyof typeof WORLD_PALETTES = 'NIGHTFALL';
export const WORLD: WorldPalette = WORLD_PALETTES[ACTIVE];

/**
 * 2.5D wall extrusion (Phase 10 prototype, render-only): wall tops are
 * displaced away from the camera center by (pos − center) × this factor,
 * with side faces filling the gap. 0 would be flat; ~0.1 is very tall.
 */
export const WALL_EXTRUDE = 0.09;

/** Fixed faction colors — the same on every client (multiplayer-proof). */
export const FACTION: Record<Team, number> = {
  T: 0xef7d3a,
  CT: 0x4d9be6,
};
export const FACTION_CSS: Record<Team, string> = {
  T: '#ef7d3a',
  CT: '#4d9be6',
};
/** "You" reads through a white outline ring + white notch, never a hue. */
export const ME_RING = 0xffffff;

export const HP_GOOD = 0x5fd08a;
export const HP_MID = 0xe8b13a;
export const HP_LOW = 0xe5484d;

// HUD text hierarchy + status colors (CSS strings for Phaser text).
export const TEXT_1 = '#e8eef4';
export const TEXT_2 = '#99a6b3';
export const TEXT_3 = '#5d6a77';
export const MONEY = '#6bd08a';
export const WARN = '#f0b429';
export const DANGER = '#e5484d';
export const DANGER_NUM = 0xe5484d;

/** Shared panel recipe: this fill + LINE border, 6–10px radius. */
export const PANEL_FILL = 0x0f1319;
export const PANEL_ALPHA = 0.94;
export const LINE = 0x2a323b;

// Effects & objective.
export const BOMB = 0xffb020;
export const BOMB_CSS = '#ffb020';
export const BOMB_PLANT = 0xff4d4d;
export const BOMB_PLANT_CSS = '#ff4d4d';
export const TRACER = 0xffe9a0;
/** Dropped weapon lying on the ground. */
export const DROPPED_GUN = 0x8a97a5;
/** Smoke-grenade cloud fill (sits between players and the fog layer). */
export const SMOKE_CLOUD = 0x11161c;
export const HIT = 0xff5544;
export const BLOOD = 0x7a1c1c;
export const BRASS = 0xd9b24a;
export const BULLET_HOLE = 0x14171c;

// Typography. Plex Mono carries every ticking number (fixed advance =
// no reflow); Plex Sans Condensed carries banners and loud short words.
export const FONT_DATA = "'IBM Plex Mono', monospace";
export const FONT_DISPLAY = "'IBM Plex Sans Condensed', sans-serif";
