import Phaser from 'phaser';
import { PLAYER_RADIUS, TICK_RATE, TILE_SIZE } from '../core/config';
import type { GameState, MapGrid } from '../core/types';
import { applyInput, createGameState, createPlayer } from '../core/simulation';
import { isWall } from '../core/collision';
import { InputSystem } from '../game/systems/InputSystem';
import { PlayerView } from '../game/entities/PlayerView';
import { DebugOverlay } from '../game/debug/DebugOverlay';

const PLAYER_ID = 'p1';
const FIXED_DT = 1 / TICK_RATE;
/** Cap per-frame delta so a background tab doesn't spiral the accumulator. */
const MAX_FRAME_DELTA_MS = 250;

/** Hardcoded test arena — replaced by the Tiled pipeline in Phase 2. */
function buildTestGrid(): MapGrid {
  const width = 50;
  const height = 30;
  const cells: number[][] = Array.from({ length: height }, () =>
    new Array<number>(width).fill(0),
  );
  for (let x = 0; x < width; x++) {
    cells[0][x] = 1;
    cells[height - 1][x] = 1;
  }
  for (let y = 0; y < height; y++) {
    cells[y][0] = 1;
    cells[y][width - 1] = 1;
  }
  // Interior walls: [tileX, tileY, tilesWide, tilesHigh]
  const rects = [
    [8, 6, 12, 1],
    [8, 6, 1, 8],
    [20, 14, 1, 10],
    [20, 23, 13, 1],
    [30, 5, 1, 9],
    [36, 18, 8, 1],
    [12, 20, 6, 1],
    [40, 4, 1, 8],
  ];
  for (const [rx, ry, rw, rh] of rects) {
    for (let y = ry; y < ry + rh; y++) {
      for (let x = rx; x < rx + rw; x++) cells[y][x] = 1;
    }
  }
  return { tileSize: TILE_SIZE, width, height, cells };
}

/**
 * Thin orchestrator: owns the fixed-timestep loop, feeds InputCommands to
 * the core simulation, and renders interpolated state. No game logic here.
 */
export class GameScene extends Phaser.Scene {
  private state!: GameState;
  private grid!: MapGrid;
  private inputSystem!: InputSystem;
  private playerView!: PlayerView;
  private debug!: DebugOverlay;

  private accumulator = 0;
  private prev = { x: 0, y: 0, angle: 0 };

  constructor() {
    super('Game');
  }

  create(): void {
    this.grid = buildTestGrid();
    this.renderWalls();

    const worldW = this.grid.width * TILE_SIZE;
    const worldH = this.grid.height * TILE_SIZE;

    this.state = createGameState();
    const player = createPlayer(PLAYER_ID, worldW / 2, worldH / 2);
    this.state.players[PLAYER_ID] = player;
    this.prev = { x: player.pos.x, y: player.pos.y, angle: player.angle };

    this.inputSystem = new InputSystem(this);
    this.playerView = new PlayerView(this, player.pos.x, player.pos.y);

    this.cameras.main.setBounds(0, 0, worldW, worldH);
    this.cameras.main.startFollow(this.playerView);

    this.debug = new DebugOverlay(this);
  }

  update(_time: number, delta: number): void {
    this.accumulator += Math.min(delta, MAX_FRAME_DELTA_MS) / 1000;
    const player = this.state.players[PLAYER_ID];

    while (this.accumulator >= FIXED_DT) {
      this.prev = { x: player.pos.x, y: player.pos.y, angle: player.angle };
      const cmd = this.inputSystem.sample(this.state.tick, player.pos);
      applyInput(this.state, PLAYER_ID, cmd, this.grid, FIXED_DT);
      this.state.tick++;
      this.accumulator -= FIXED_DT;
    }

    const alpha = this.accumulator / FIXED_DT;
    const rx = Phaser.Math.Linear(this.prev.x, player.pos.x, alpha);
    const ry = Phaser.Math.Linear(this.prev.y, player.pos.y, alpha);
    this.playerView.setPosition(rx, ry);
    this.playerView.rotation =
      this.prev.angle + Phaser.Math.Angle.Wrap(player.angle - this.prev.angle) * alpha;

    this.debug.setLine('tick', String(this.state.tick));
    this.debug.setLine(
      'pos',
      `${player.pos.x.toFixed(1)}, ${player.pos.y.toFixed(1)}`,
    );
    this.debug.setLine(
      'vel',
      `${player.vel.x.toFixed(0)}, ${player.vel.y.toFixed(0)}`,
    );
    this.debug.update();
    if (this.debug.isVisible) this.drawDebug(rx, ry);
  }

  private renderWalls(): void {
    this.add.rectangle(
      0,
      0,
      this.grid.width * TILE_SIZE,
      this.grid.height * TILE_SIZE,
      0x22262c,
    ).setOrigin(0);
    const g = this.add.graphics();
    g.fillStyle(0x4a5460);
    for (let ty = 0; ty < this.grid.height; ty++) {
      for (let tx = 0; tx < this.grid.width; tx++) {
        if (this.grid.cells[ty][tx] !== 0) {
          g.fillRect(tx * TILE_SIZE, ty * TILE_SIZE, TILE_SIZE, TILE_SIZE);
        }
      }
    }
  }

  /** Debug layer: collision grid outlines + the player's collision circle. */
  private drawDebug(playerX: number, playerY: number): void {
    const g = this.debug.gfx;
    g.lineStyle(1, 0xff4455, 0.5);
    for (let ty = 0; ty < this.grid.height; ty++) {
      for (let tx = 0; tx < this.grid.width; tx++) {
        if (isWall(this.grid, tx, ty)) {
          g.strokeRect(tx * TILE_SIZE, ty * TILE_SIZE, TILE_SIZE, TILE_SIZE);
        }
      }
    }
    g.lineStyle(1, 0x00ff88, 1);
    g.strokeCircle(playerX, playerY, PLAYER_RADIUS);
  }
}
