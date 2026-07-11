// Plain-data state types shared by client and (later) server.

export interface Vec2 {
  x: number;
  y: number;
}

/** Bitmask flags for InputCommand.buttons. */
export const Buttons = {
  Shoot: 1 << 0,
  Walk: 1 << 1,
  Reload: 1 << 2,
  Use: 1 << 3,
  SelectMelee: 1 << 4,
  SelectSecondary: 1 << 5,
  SelectPrimary: 1 << 6,
  NextWeapon: 1 << 7,
  PrevWeapon: 1 << 8,
} as const;

/**
 * One tick's worth of intent from a device or bot. This is the only thing
 * that moves a player, and the only thing sent over the wire later.
 */
export interface InputCommand {
  tick: number;
  /** Movement intent, each in [-1, 1]. Simulation normalizes the vector. */
  moveX: number;
  moveY: number;
  /** Aim direction in radians, world space. */
  aimAngle: number;
  /** Bitmask of Buttons flags. */
  buttons: number;
}

export type Team = 'T' | 'CT';

export type WeaponId = 'knife' | 'pistol' | 'smg' | 'rifle' | 'sniper';

/** Static weapon definition — the table itself lives in config.ts. */
export interface WeaponDef {
  id: WeaponId;
  /** 0 = melee, 1 = secondary, 2 = primary. */
  slotIndex: 0 | 1 | 2;
  damage: number;
  rpm: number;
  /** 0 = no ammo tracking (knife). */
  magSize: number;
  reserveSize: number;
  reloadTime: number;
  /** Spread while standing still, degrees (half-angle of the cone). */
  spreadBaseDeg: number;
  /** Extra spread at full movement speed, degrees. */
  spreadMoveDeg: number;
  /** Bloom added per shot / its cap / its decay rate, degrees. */
  bloomPerShotDeg: number;
  bloomMaxDeg: number;
  bloomDecayDegPerSec: number;
  /** Linear damage falloff: 1.0 until start, falloffMinMult at end. */
  falloffStartPx: number;
  falloffEndPx: number;
  falloffMinMult: number;
  /** Hitscan range in px (short for the knife). */
  maxRangePx: number;
  price: number;
  speedMult: number;
}

export interface WeaponSlot {
  weaponId: WeaponId;
  magAmmo: number;
  reserveAmmo: number;
}

export interface PlayerState {
  id: string;
  team: Team;
  pos: Vec2;
  vel: Vec2;
  angle: number;
  hp: number;
  /** Ordered by WeaponDef.slotIndex: [melee, secondary, primary?]. */
  slots: WeaponSlot[];
  activeSlot: number;
  /** Seconds until the active weapon may fire again (also covers switching). */
  fireCooldown: number;
  /** Seconds of reload remaining; 0 = not reloading. */
  reloadRemaining: number;
  /** Accumulated spread bloom from sustained fire, degrees. */
  bloomDeg: number;
}

/** Placeholder — grenades become real projectile entities in Phase 8. */
export interface ProjectileState {
  id: number;
  pos: Vec2;
  vel: Vec2;
}

/**
 * Things that happened inside a tick that rendering/audio care about.
 * The scene drains these after stepping; the server will broadcast them.
 */
export type SimEvent =
  | {
      type: 'shot';
      playerId: string;
      weaponId: WeaponId;
      from: Vec2;
      to: Vec2;
      hit: 'wall' | 'player' | 'none';
      hitPlayerId?: string;
    }
  | { type: 'death'; playerId: string; killerId: string }
  | { type: 'reload'; playerId: string; weaponId: WeaponId };

export interface GameState {
  tick: number;
  players: Record<string, PlayerState>;
  projectiles: ProjectileState[];
  events: SimEvent[];
  /** Deterministic RNG state (spread rolls) — replays/server stay in sync. */
  rngState: number;
}

/** An axis-aligned wall edge, world px. Consumed by raycasts and vision. */
export interface Segment {
  a: Vec2;
  b: Vec2;
}

/** Tile collision grid, extracted from the Tiled walls layer. */
export interface MapGrid {
  tileSize: number;
  /** Grid dimensions in tiles. */
  width: number;
  height: number;
  /** cells[row][col] — 0 = walkable, non-zero = solid wall. */
  cells: number[][];
}

/** The static map data the simulation needs (MapData satisfies this). */
export interface SimMap {
  grid: MapGrid;
  segments: Segment[];
}
