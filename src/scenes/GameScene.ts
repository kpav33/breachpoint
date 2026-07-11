import Phaser from 'phaser';
import { PLAYER_MAX_HP, PLAYER_RADIUS, TICK_RATE, WEAPONS } from '../core/config';
import type { GameState, Vec2 } from '../core/types';
import type { MapData } from '../core/map';
import {
  applyInput,
  createGameState,
  createPlayer,
  respawnPlayer,
} from '../core/simulation';
import { isWall } from '../core/collision';
import { activeWeapon, currentSpreadDeg, givePrimary } from '../core/weapons';
import { InputSystem } from '../game/systems/InputSystem';
import { EffectsSystem } from '../game/systems/EffectsSystem';
import { PlayerView } from '../game/entities/PlayerView';
import { DebugOverlay } from '../game/debug/DebugOverlay';
import { loadMap, MAP_KEY } from '../game/map/MapLoader';

const PLAYER_ID = 'p1';
const DUMMY_ID = 'dummy';
const FIXED_DT = 1 / TICK_RATE;
/** Cap per-frame delta so a background tab doesn't spiral the accumulator. */
const MAX_FRAME_DELTA_MS = 250;

/**
 * Thin orchestrator: owns the fixed-timestep loop, feeds InputCommands to
 * the core simulation, drains SimEvents into effects, renders interpolated
 * state. No game logic here.
 */
export class GameScene extends Phaser.Scene {
  private state!: GameState;
  private map!: MapData;
  private inputSystem!: InputSystem;
  private effects!: EffectsSystem;
  private views!: Record<string, PlayerView>;
  private debug!: DebugOverlay;
  private ammoText!: Phaser.GameObjects.Text;

  private accumulator = 0;
  private prev = { x: 0, y: 0, angle: 0 };
  private dummySpawn!: Vec2;

  constructor() {
    super('Game');
  }

  create(): void {
    this.map = loadMap(this).data;
    const { grid } = this.map;

    this.state = createGameState();
    const spawn = this.map.spawnsT[0];
    this.state.players[PLAYER_ID] = createPlayer(PLAYER_ID, spawn.x, spawn.y, 'rifle');
    this.prev = { x: spawn.x, y: spawn.y, angle: 0 };

    // Stationary practice target across the T spawn room. Phase 6 replaces
    // this with real bots feeding InputCommands.
    this.dummySpawn = { x: spawn.x + 320, y: spawn.y - 64 };
    this.state.players[DUMMY_ID] = createPlayer(DUMMY_ID, this.dummySpawn.x, this.dummySpawn.y);

    this.inputSystem = new InputSystem(this);
    this.effects = new EffectsSystem(this);
    this.views = {
      [PLAYER_ID]: new PlayerView(this, spawn.x, spawn.y),
      [DUMMY_ID]: new PlayerView(this, this.dummySpawn.x, this.dummySpawn.y, 0xd9534f),
    };

    this.cameras.main.setBounds(0, 0, grid.width * grid.tileSize, grid.height * grid.tileSize);
    this.cameras.main.startFollow(this.views[PLAYER_ID]);

    this.ammoText = this.add
      .text(12, this.scale.height - 30, '', {
        fontFamily: 'monospace',
        fontSize: '16px',
        color: '#c8d2dc',
      })
      .setScrollFactor(0)
      .setDepth(500);

    this.debug = new DebugOverlay(this);
    this.bindLoadoutCheats();
  }

  /** Debug loadout swaps (F1–F3) until the Phase 7 buy menu exists. */
  private bindLoadoutCheats(): void {
    const kb = this.input.keyboard!;
    const cheats = { F1: 'smg', F2: 'rifle', F3: 'sniper' } as const;
    for (const [key, weapon] of Object.entries(cheats)) {
      kb.on(`keydown-${key}`, () => givePrimary(this.state.players[PLAYER_ID], weapon));
    }
  }

  update(_time: number, delta: number): void {
    this.accumulator += Math.min(delta, MAX_FRAME_DELTA_MS) / 1000;
    const player = this.state.players[PLAYER_ID];

    while (this.accumulator >= FIXED_DT) {
      this.prev = { x: player.pos.x, y: player.pos.y, angle: player.angle };
      const cmd = this.inputSystem.sample(this.state.tick, player.pos);
      applyInput(this.state, PLAYER_ID, cmd, this.map, FIXED_DT);
      this.state.tick++;
      this.accumulator -= FIXED_DT;
    }

    this.drainEvents();
    this.effects.update(delta);
    this.renderPlayers();
    this.updateAmmoText(player);

    this.debug.setLine('map', MAP_KEY);
    this.debug.setLine('tick', String(this.state.tick));
    this.debug.setLine('pos', `${player.pos.x.toFixed(1)}, ${player.pos.y.toFixed(1)}`);
    this.debug.setLine('weapon', activeWeapon(player).id);
    this.debug.setLine('spread', `${currentSpreadDeg(player).toFixed(2)}°`);
    this.debug.setLine('dummy hp', String(this.state.players[DUMMY_ID].hp));
    this.debug.update();
    if (this.debug.isVisible) this.drawDebug(player);
  }

  private drainEvents(): void {
    for (const ev of this.state.events) {
      if (ev.type === 'shot') {
        this.effects.handle(ev);
        if (ev.hitPlayerId) this.views[ev.hitPlayerId]?.flashDamage();
      } else if (ev.type === 'death') {
        const victim = this.state.players[ev.playerId];
        this.effects.handle(ev, victim.pos);
        // Instant respawn until rounds arrive in Phase 7.
        const at = ev.playerId === DUMMY_ID ? this.dummySpawn : this.map.spawnsT[0];
        respawnPlayer(this.state, ev.playerId, at);
      }
    }
    this.state.events.length = 0;
  }

  private renderPlayers(): void {
    const player = this.state.players[PLAYER_ID];
    const alpha = this.accumulator / FIXED_DT;
    const view = this.views[PLAYER_ID];
    view.setPosition(
      Phaser.Math.Linear(this.prev.x, player.pos.x, alpha),
      Phaser.Math.Linear(this.prev.y, player.pos.y, alpha),
    );
    view.setAim(
      this.prev.angle + Phaser.Math.Angle.Wrap(player.angle - this.prev.angle) * alpha,
    );
    view.setHpFrac(player.hp / PLAYER_MAX_HP);

    const dummy = this.state.players[DUMMY_ID];
    this.views[DUMMY_ID].setPosition(dummy.pos.x, dummy.pos.y);
    this.views[DUMMY_ID].setHpFrac(dummy.hp / PLAYER_MAX_HP);
  }

  private updateAmmoText(player: (typeof this.state.players)[string]): void {
    const slot = player.slots[player.activeSlot];
    const def = WEAPONS[slot.weaponId];
    if (player.reloadRemaining > 0) {
      this.ammoText.setText(`${def.id.toUpperCase()}  RELOADING…`);
      this.ammoText.setColor('#d9b24a');
    } else {
      const ammo = def.magSize > 0 ? `${slot.magAmmo}/${slot.reserveAmmo}` : '—';
      this.ammoText.setText(`${def.id.toUpperCase()}  ${ammo}`);
      this.ammoText.setColor(def.magSize > 0 && slot.magAmmo === 0 ? '#d9534f' : '#c8d2dc');
    }
  }

  /**
   * Debug layer: collision grid, wall segments, bombsites, spawns, player
   * collision circle + current spread cone (Phase 3).
   */
  private drawDebug(player: (typeof this.state.players)[string]): void {
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
    for (const s of segments) g.lineBetween(s.a.x, s.a.y, s.b.x, s.b.y);

    g.lineStyle(2, 0xc8a35a, 0.8);
    for (const site of bombsites) g.strokeRect(site.x, site.y, site.width, site.height);

    g.fillStyle(0xff9950, 1);
    for (const p of spawnsT) g.fillCircle(p.x, p.y, 4);
    g.fillStyle(0x6699ff, 1);
    for (const p of spawnsCT) g.fillCircle(p.x, p.y, 4);

    // Spread cone: two edge rays at ± the current effective spread.
    const spreadRad = (currentSpreadDeg(player) * Math.PI) / 180;
    const coneLen = 300;
    g.lineStyle(1, 0xffe9a0, 0.8);
    for (const off of [-spreadRad, spreadRad]) {
      g.lineBetween(
        player.pos.x,
        player.pos.y,
        player.pos.x + Math.cos(player.angle + off) * coneLen,
        player.pos.y + Math.sin(player.angle + off) * coneLen,
      );
    }

    g.lineStyle(1, 0x00ff88, 1);
    g.strokeCircle(player.pos.x, player.pos.y, PLAYER_RADIUS);
  }
}
