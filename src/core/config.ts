// Gameplay constants. All tunable simulation numbers live here — never
// hardcode them at usage sites.

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
