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

export interface PlayerState {
  id: string;
  pos: Vec2;
  vel: Vec2;
  angle: number;
  hp: number;
  weaponId: string;
  ammo: number;
}

/** Placeholder — grenades become real projectile entities in Phase 8. */
export interface ProjectileState {
  id: number;
  pos: Vec2;
  vel: Vec2;
}

export interface GameState {
  tick: number;
  players: Record<string, PlayerState>;
  projectiles: ProjectileState[];
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
