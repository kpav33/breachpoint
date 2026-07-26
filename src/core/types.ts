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
  ThrowHE: 1 << 9,
  ThrowFlash: 1 << 10,
  ThrowSmoke: 1 << 11,
  /** Drop the active weapon on the ground (G). */
  Drop: 1 << 12,
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

export type WeaponId =
  | 'knife'
  | 'pistol'
  | 'deagle'
  | 'smg'
  | 'rifle'
  | 'sniper'
  | 'shotgun';

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
  /**
   * Spread while standing still, degrees (half-angle of the cone). This is an
   * always-applied floor, so it is **0 for every aimed weapon**: a stationary,
   * unbloomed first shot must land exactly on the crosshair (CS-style
   * first-shot accuracy — precise aim has to be rewarded). Non-zero only where
   * scatter is the point (shotgun) or as a token amount (sniper). Inaccuracy
   * comes from spreadMoveDeg (moving) and bloom (firing too fast) instead.
   */
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
  /** Rays per trigger pull (shotgun); damage is per pellet. Default 1. */
  pellets?: number;
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
  /** Kevlar 0..ARMOR_MAX — absorbs a fraction of damage until it breaks. */
  armor: number;
  /** Ordered by WeaponDef.slotIndex: [melee, secondary, primary?]. */
  slots: WeaponSlot[];
  activeSlot: number;
  /** Seconds until the active weapon may fire again (also covers switching). */
  fireCooldown: number;
  /** Seconds of reload remaining; 0 = not reloading. */
  reloadRemaining: number;
  /** Accumulated spread bloom from sustained fire, degrees. */
  bloomDeg: number;
  /** Grenade inventory — at most one of each type. */
  grenades: GrenadeType[];
  /**
   * Hold-to-charge throw: the grenade whose throw key is currently held
   * (null = not charging), and how many ticks it's been held. On release the
   * simulation converts the held ticks into a launch speed (tap = full,
   * longer hold = shorter throw) and spawns the grenade.
   */
  chargingGrenade: GrenadeType | null;
  chargeTicks: number;
}

export type GrenadeType = 'he' | 'flash' | 'smoke';

/** What killed a player: a weapon (gunfire/knife), an HE grenade, or the bomb. */
export type DeathCause = WeaponId | 'he' | 'bomb';

/** A thrown grenade in flight. */
export interface ProjectileState {
  id: number;
  type: GrenadeType;
  ownerId: string;
  pos: Vec2;
  vel: Vec2;
  /** Height above the floor on the fake vertical axis, px (0 = on the ground). */
  z: number;
  /** Vertical speed on the fake axis, px/s (positive = rising). */
  vz: number;
  /** Inside a wall footprint it entered from above (sliding across the top). */
  overWall: boolean;
  /** Seconds until detonation/activation. */
  fuse: number;
}

/** An active smoke cloud — blocks vision (not bullets or movement). */
export interface SmokeState {
  id: number;
  pos: Vec2;
  timeLeft: number;
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
  | { type: 'death'; playerId: string; killerId: string; cause: DeathCause }
  | { type: 'reload'; playerId: string; weaponId: WeaponId }
  | { type: 'grenade_throw'; playerId: string; gtype: GrenadeType; from: Vec2 }
  /** For smoke this marks activation — the cloud lives in state.smokes. */
  | { type: 'grenade_explode'; gtype: GrenadeType; pos: Vec2; ownerId: string };

export interface GameState {
  tick: number;
  players: Record<string, PlayerState>;
  projectiles: ProjectileState[];
  smokes: SmokeState[];
  nextProjectileId: number;
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
