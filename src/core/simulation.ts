import { Buttons } from './types.ts';
import type { GameState, InputCommand, MapGrid, PlayerState } from './types.ts';
import { MOVE_SPEED, PLAYER_MAX_HP, PLAYER_RADIUS, WALK_SPEED } from './config.ts';
import { resolveCircleGrid } from './collision.ts';

export function createGameState(): GameState {
  return { tick: 0, players: {}, projectiles: [] };
}

export function createPlayer(id: string, x: number, y: number): PlayerState {
  return {
    id,
    pos: { x, y },
    vel: { x: 0, y: 0 },
    angle: 0,
    hp: PLAYER_MAX_HP,
    weaponId: 'knife',
    ammo: 0,
  };
}

/**
 * The single entry point that moves a player. Applies one InputCommand for
 * one fixed timestep: normalize movement intent, integrate velocity,
 * resolve collision against the tile grid, face the aim direction.
 */
export function applyInput(
  state: GameState,
  playerId: string,
  cmd: InputCommand,
  grid: MapGrid,
  dt: number,
): void {
  const p = state.players[playerId];
  if (!p || p.hp <= 0) return;

  let mx = cmd.moveX;
  let my = cmd.moveY;
  // Normalize before scaling by speed, or diagonals are 41% faster.
  const len = Math.hypot(mx, my);
  if (len > 1) {
    mx /= len;
    my /= len;
  }

  const speed = cmd.buttons & Buttons.Walk ? WALK_SPEED : MOVE_SPEED;
  p.vel.x = mx * speed;
  p.vel.y = my * speed;

  p.pos.x += p.vel.x * dt;
  p.pos.y += p.vel.y * dt;
  resolveCircleGrid(p.pos, PLAYER_RADIUS, grid);

  p.angle = cmd.aimAngle;
}
