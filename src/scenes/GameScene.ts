import Phaser from 'phaser';
import { PLAYER_RADIUS, TICK_RATE } from '../core/config';
import type { GameState } from '../core/types';
import type { MapData } from '../core/map';
import { applyInput, createGameState, createPlayer } from '../core/simulation';
import { isWall } from '../core/collision';
import { InputSystem } from '../game/systems/InputSystem';
import { PlayerView } from '../game/entities/PlayerView';
import { DebugOverlay } from '../game/debug/DebugOverlay';
import { loadMap, MAP_KEY } from '../game/map/MapLoader';

const PLAYER_ID = 'p1';
const FIXED_DT = 1 / TICK_RATE;
/** Cap per-frame delta so a background tab doesn't spiral the accumulator. */
const MAX_FRAME_DELTA_MS = 250;

/**
 * Thin orchestrator: owns the fixed-timestep loop, feeds InputCommands to
 * the core simulation, and renders interpolated state. No game logic here.
 */
export class GameScene extends Phaser.Scene {
  private state!: GameState;
  private map!: MapData;
  private inputSystem!: InputSystem;
  private playerView!: PlayerView;
  private debug!: DebugOverlay;

  private accumulator = 0;
  private prev = { x: 0, y: 0, angle: 0 };

  constructor() {
    super('Game');
  }

  create(): void {
    this.map = loadMap(this).data;
    const { grid } = this.map;

    this.state = createGameState();
    const spawn = this.map.spawnsT[0];
    const player = createPlayer(PLAYER_ID, spawn.x, spawn.y);
    this.state.players[PLAYER_ID] = player;
    this.prev = { x: player.pos.x, y: player.pos.y, angle: player.angle };

    this.inputSystem = new InputSystem(this);
    this.playerView = new PlayerView(this, player.pos.x, player.pos.y);

    this.cameras.main.setBounds(
      0,
      0,
      grid.width * grid.tileSize,
      grid.height * grid.tileSize,
    );
    this.cameras.main.startFollow(this.playerView);

    this.debug = new DebugOverlay(this);
  }

  update(_time: number, delta: number): void {
    this.accumulator += Math.min(delta, MAX_FRAME_DELTA_MS) / 1000;
    const player = this.state.players[PLAYER_ID];

    while (this.accumulator >= FIXED_DT) {
      this.prev = { x: player.pos.x, y: player.pos.y, angle: player.angle };
      const cmd = this.inputSystem.sample(this.state.tick, player.pos);
      applyInput(this.state, PLAYER_ID, cmd, this.map.grid, FIXED_DT);
      this.state.tick++;
      this.accumulator -= FIXED_DT;
    }

    const alpha = this.accumulator / FIXED_DT;
    const rx = Phaser.Math.Linear(this.prev.x, player.pos.x, alpha);
    const ry = Phaser.Math.Linear(this.prev.y, player.pos.y, alpha);
    this.playerView.setPosition(rx, ry);
    this.playerView.rotation =
      this.prev.angle + Phaser.Math.Angle.Wrap(player.angle - this.prev.angle) * alpha;

    this.debug.setLine('map', MAP_KEY);
    this.debug.setLine('tick', String(this.state.tick));
    this.debug.setLine(
      'pos',
      `${player.pos.x.toFixed(1)}, ${player.pos.y.toFixed(1)}`,
    );
    this.debug.setLine(
      'vel',
      `${player.vel.x.toFixed(0)}, ${player.vel.y.toFixed(0)}`,
    );
    this.debug.setLine('segments', String(this.map.segments.length));
    this.debug.update();
    if (this.debug.isVisible) this.drawDebug(rx, ry);
  }

  /**
   * Debug layer: collision-grid outlines, merged wall segments (cyan, with
   * endpoint dots), bombsite rects, spawn points, player collision circle.
   */
  private drawDebug(playerX: number, playerY: number): void {
    const g = this.debug.gfx;
    const { grid, segments, bombsites, spawnsT, spawnsCT } = this.map;
    const ts = grid.tileSize;

    g.lineStyle(1, 0xff4455, 0.25);
    for (let ty = 0; ty < grid.height; ty++) {
      for (let tx = 0; tx < grid.width; tx++) {
        if (isWall(grid, tx, ty)) g.strokeRect(tx * ts, ty * ts, ts, ts);
      }
    }

    g.lineStyle(2, 0x00e5ff, 0.9);
    for (const s of segments) {
      g.lineBetween(s.a.x, s.a.y, s.b.x, s.b.y);
      g.fillStyle(0x00e5ff, 0.9);
      g.fillCircle(s.a.x, s.a.y, 2);
      g.fillCircle(s.b.x, s.b.y, 2);
    }

    g.lineStyle(2, 0xc8a35a, 0.8);
    for (const site of bombsites) {
      g.strokeRect(site.x, site.y, site.width, site.height);
    }

    g.fillStyle(0xff9950, 1);
    for (const p of spawnsT) g.fillCircle(p.x, p.y, 4);
    g.fillStyle(0x6699ff, 1);
    for (const p of spawnsCT) g.fillCircle(p.x, p.y, 4);

    g.lineStyle(1, 0x00ff88, 1);
    g.strokeCircle(playerX, playerY, PLAYER_RADIUS);
  }
}
