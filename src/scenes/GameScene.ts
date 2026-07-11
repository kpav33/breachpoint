import Phaser from 'phaser';
import {
  BOT_DIFFICULTY,
  BOT_PROFILES,
  PLAYER_MAX_HP,
  PLAYER_RADIUS,
  TICK_RATE,
  WEAPONS,
} from '../core/config';
import type { GameState, Vec2, WeaponId } from '../core/types';
import type { MapData } from '../core/map';
import {
  applyInput,
  createGameState,
  createPlayer,
  respawnPlayer,
} from '../core/simulation';
import { isWall } from '../core/collision';
import { activeWeapon, currentSpreadDeg, givePrimary } from '../core/weapons';
import { canSee } from '../core/vision';
import { InputSystem } from '../game/systems/InputSystem';
import { EffectsSystem } from '../game/systems/EffectsSystem';
import { VisionSystem } from '../game/systems/VisionSystem';
import { AudioSystem } from '../game/systems/AudioSystem';
import { PlayerView } from '../game/entities/PlayerView';
import { BotController } from '../game/bots/BotController';
import { DebugOverlay } from '../game/debug/DebugOverlay';
import { loadMap, MAP_KEY } from '../game/map/MapLoader';

const PLAYER_ID = 'p1';
/** 1v3 deathmatch vs bots until Phase 7 brings teams and rounds. */
const BOT_LOADOUTS: { id: string; weapon: WeaponId; color: number }[] = [
  { id: 'bot1', weapon: 'smg', color: 0xd9534f },
  { id: 'bot2', weapon: 'rifle', color: 0xd97b3c },
  { id: 'bot3', weapon: 'pistol', color: 0xc94f70 },
];
const FIXED_DT = 1 / TICK_RATE;
/** Cap per-frame delta so a background tab doesn't spiral the accumulator. */
const MAX_FRAME_DELTA_MS = 250;

interface RenderSnapshot {
  x: number;
  y: number;
  angle: number;
}

/**
 * Thin orchestrator: owns the fixed-timestep loop, feeds InputCommands to
 * the core simulation (from the keyboard and from bot brains alike), drains
 * SimEvents into effects, renders interpolated state. No game logic here.
 */
export class GameScene extends Phaser.Scene {
  private state!: GameState;
  private map!: MapData;
  private inputSystem!: InputSystem;
  private effects!: EffectsSystem;
  private vision!: VisionSystem;
  private audio!: AudioSystem;
  private views!: Record<string, PlayerView>;
  private bots!: Record<string, BotController>;
  private botSpawns!: Record<string, Vec2>;
  private debug!: DebugOverlay;
  private ammoText!: Phaser.GameObjects.Text;
  private scoreText!: Phaser.GameObjects.Text;
  private damageIndicatorGfx!: Phaser.GameObjects.Graphics;
  private damageIndicators: { angle: number; age: number }[] = [];
  private kills = 0;
  private deaths = 0;

  private accumulator = 0;
  private prev: Record<string, RenderSnapshot> = {};
  /** F6: freeze bot brains (they stand still) for inspecting behavior. */
  private botsFrozen = false;

  constructor() {
    super('Game');
  }

  create(): void {
    this.map = loadMap(this).data;
    const { grid } = this.map;

    this.state = createGameState();
    const spawn = this.map.spawnsT[0];
    this.state.players[PLAYER_ID] = createPlayer(PLAYER_ID, spawn.x, spawn.y, 'rifle');

    this.inputSystem = new InputSystem(this);
    this.effects = new EffectsSystem(this, grid.width * grid.tileSize, grid.height * grid.tileSize);
    this.vision = new VisionSystem(this, this.map.segments);
    this.audio = new AudioSystem(this);
    this.damageIndicatorGfx = this.add.graphics().setScrollFactor(0).setDepth(600);
    this.views = { [PLAYER_ID]: new PlayerView(this, spawn.x, spawn.y) };
    this.prev[PLAYER_ID] = { x: spawn.x, y: spawn.y, angle: 0 };

    this.spawnBots();

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
    this.scoreText = this.add
      .text(this.scale.width / 2, 12, '', {
        fontFamily: 'monospace',
        fontSize: '16px',
        color: '#c8d2dc',
      })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(500);
    this.updateScoreText();

    this.debug = new DebugOverlay(this);
    this.bindLoadoutCheats();
  }

  /** Bots roam between the map's landmarks when they have no better lead. */
  private spawnBots(): void {
    const roamPoints: Vec2[] = [
      ...this.map.bombsites.map((s) => ({ x: s.x + s.width / 2, y: s.y + s.height / 2 })),
      ...this.map.spawnsT,
      ...this.map.spawnsCT,
    ];
    const profile = BOT_PROFILES[BOT_DIFFICULTY];

    this.bots = {};
    this.botSpawns = {};
    BOT_LOADOUTS.forEach(({ id, weapon, color }, i) => {
      const at = this.map.spawnsCT[i % this.map.spawnsCT.length];
      this.state.players[id] = createPlayer(id, at.x, at.y, weapon);
      this.bots[id] = new BotController(id, [PLAYER_ID], profile, this.map, roamPoints, 0x1234 + i);
      this.botSpawns[id] = at;
      this.views[id] = new PlayerView(this, at.x, at.y, color);
      this.prev[id] = { x: at.x, y: at.y, angle: 0 };
    });
  }

  /** Debug loadout swaps (F1–F3) until the Phase 7 buy menu exists. */
  private bindLoadoutCheats(): void {
    const kb = this.input.keyboard!;
    const cheats = { F1: 'smg', F2: 'rifle', F3: 'sniper' } as const;
    for (const [key, weapon] of Object.entries(cheats)) {
      kb.on(`keydown-${key}`, () => givePrimary(this.state.players[PLAYER_ID], weapon));
    }
    kb.on('keydown-F5', () => (this.vision.fullCircle = !this.vision.fullCircle));
    kb.on('keydown-F6', () => (this.botsFrozen = !this.botsFrozen));
  }

  update(_time: number, delta: number): void {
    this.accumulator += Math.min(delta, MAX_FRAME_DELTA_MS) / 1000;
    const player = this.state.players[PLAYER_ID];

    while (this.accumulator >= FIXED_DT) {
      for (const p of Object.values(this.state.players)) {
        this.prev[p.id] = { x: p.pos.x, y: p.pos.y, angle: p.angle };
      }
      const cmd = this.inputSystem.sample(this.state.tick, player.pos);
      applyInput(this.state, PLAYER_ID, cmd, this.map, FIXED_DT);
      if (!this.botsFrozen) {
        for (const bot of Object.values(this.bots)) {
          const botCmd = bot.update(this.state, FIXED_DT);
          applyInput(this.state, bot.id, botCmd, this.map, FIXED_DT);
        }
      }
      this.state.tick++;
      this.accumulator -= FIXED_DT;
    }

    this.drainEvents();
    this.effects.update(delta);
    this.updateDamageIndicators(delta);
    const rendered = this.renderPlayers();
    this.audio.setListener(rendered);
    this.audio.updateFootsteps(Object.values(this.state.players), delta / 1000);
    this.vision.update({ x: rendered.x, y: rendered.y }, rendered.angle);

    // Enemy culling: same rules as the fog-of-war (wall LOS + cone + range).
    for (const { id } of BOT_LOADOUTS) {
      const bot = this.state.players[id];
      this.views[id].setVisible(
        canSee(player, bot.pos, this.map.segments, this.vision.fullCircle),
      );
    }

    this.updateAmmoText(player);

    this.debug.setLine('map', MAP_KEY);
    this.debug.setLine('tick', String(this.state.tick));
    this.debug.setLine('pos', `${player.pos.x.toFixed(1)}, ${player.pos.y.toFixed(1)}`);
    this.debug.setLine('weapon', activeWeapon(player).id);
    this.debug.setLine('spread', `${currentSpreadDeg(player).toFixed(2)}°`);
    for (const { id } of BOT_LOADOUTS) {
      const info = this.bots[id].debugInfo;
      const hp = this.state.players[id].hp;
      this.debug.setLine(id, `${info.state} hp:${hp}${this.botsFrozen ? ' (frozen F6)' : ''}`);
    }
    this.debug.setLine(
      'vision',
      `${this.vision.rayCount} rays, ${this.vision.fullCircle ? '360°' : 'cone'} (F5)`,
    );
    this.debug.update();
    if (this.debug.isVisible) this.drawDebug(player);
  }

  private drainEvents(): void {
    for (const ev of this.state.events) {
      if (ev.type === 'shot') {
        for (const bot of Object.values(this.bots)) bot.hear(this.state, ev);
        this.effects.handle(ev, PLAYER_ID);
        this.audio.play(this.audio.shotKey(ev.weaponId), ev.from);
        if (ev.hitPlayerId) {
          this.views[ev.hitPlayerId]?.flashDamage();
          if (ev.playerId === PLAYER_ID) this.audio.play('hit');
          if (ev.hitPlayerId === PLAYER_ID) {
            this.audio.play('hurt');
            this.effects.damageShake();
            const shooter = this.state.players[ev.playerId];
            const me = this.state.players[PLAYER_ID];
            this.damageIndicators.push({
              angle: Math.atan2(shooter.pos.y - me.pos.y, shooter.pos.x - me.pos.x),
              age: 0,
            });
          }
        }
      } else if (ev.type === 'reload') {
        this.audio.play('reload', this.state.players[ev.playerId].pos);
      } else if (ev.type === 'death') {
        const victim = this.state.players[ev.playerId];
        this.effects.handle(ev, PLAYER_ID, victim.pos);
        this.audio.play('death', victim.pos);
        if (ev.playerId === PLAYER_ID) this.deaths++;
        else if (ev.killerId === PLAYER_ID) this.kills++;
        this.updateScoreText();
        // Instant respawn until rounds arrive in Phase 7.
        const at = this.botSpawns[ev.playerId] ?? this.map.spawnsT[0];
        respawnPlayer(this.state, ev.playerId, at);
        this.prev[ev.playerId] = { x: at.x, y: at.y, angle: 0 };
        this.bots[ev.playerId]?.reset();
      }
    }
    this.state.events.length = 0;
  }

  private updateScoreText(): void {
    this.scoreText.setText(`K ${this.kills}  /  D ${this.deaths}`);
  }

  /** Red arc at screen center pointing toward recent damage sources. */
  private updateDamageIndicators(dt: number): void {
    const g = this.damageIndicatorGfx;
    g.clear();
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;
    for (let i = this.damageIndicators.length - 1; i >= 0; i--) {
      const ind = this.damageIndicators[i];
      ind.age += dt;
      if (ind.age >= 700) {
        this.damageIndicators.splice(i, 1);
        continue;
      }
      const fade = 1 - ind.age / 700;
      g.lineStyle(5, 0xd9302c, 0.8 * fade);
      g.beginPath();
      g.arc(cx, cy, 64, ind.angle - 0.5, ind.angle + 0.5);
      g.strokePath();
    }
  }

  /** Interpolate every view; returns the local player's render pos/angle. */
  private renderPlayers(): RenderSnapshot {
    const alpha = this.accumulator / FIXED_DT;
    let local: RenderSnapshot = { x: 0, y: 0, angle: 0 };
    for (const p of Object.values(this.state.players)) {
      const prev = this.prev[p.id] ?? { x: p.pos.x, y: p.pos.y, angle: p.angle };
      const x = Phaser.Math.Linear(prev.x, p.pos.x, alpha);
      const y = Phaser.Math.Linear(prev.y, p.pos.y, alpha);
      const angle = prev.angle + Phaser.Math.Angle.Wrap(p.angle - prev.angle) * alpha;
      const view = this.views[p.id];
      view.setPosition(x, y);
      view.setAim(angle);
      view.setHpFrac(p.hp / PLAYER_MAX_HP);
      if (p.id === PLAYER_ID) local = { x, y, angle };
    }
    return local;
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
   * collision circle + spread cone (Ph3), vision rays (Ph4), bot paths (Ph6).
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

    // Vision (Phase 4): raw rays faint, polygon outlines bright.
    const cone = this.vision.cone;
    g.lineStyle(1, 0xffff66, 0.15);
    for (const ray of cone.rays) {
      const a = player.angle + ray.angle;
      g.lineBetween(
        player.pos.x,
        player.pos.y,
        player.pos.x + Math.cos(a) * ray.dist,
        player.pos.y + Math.sin(a) * ray.dist,
      );
    }
    if (cone.polygon.length > 2) {
      g.lineStyle(1, 0x66ff99, 0.9);
      g.strokePoints(cone.polygon, true);
    }
    if (this.vision.awareness.polygon.length > 2) {
      g.lineStyle(1, 0x6699ff, 0.9);
      g.strokePoints(this.vision.awareness.polygon, true);
    }

    // Bots (Phase 6): remaining path waypoints + last-known-position marker.
    for (const { id } of BOT_LOADOUTS) {
      const bot = this.state.players[id];
      if (bot.hp <= 0) continue;
      const info = this.bots[id].debugInfo;
      g.lineStyle(1, 0xff88ff, 0.9);
      let from: Vec2 = bot.pos;
      for (let i = info.pathIndex; i < info.path.length; i++) {
        g.lineBetween(from.x, from.y, info.path[i].x, info.path[i].y);
        g.strokeCircle(info.path[i].x, info.path[i].y, 3);
        from = info.path[i];
      }
      if (info.lastKnown) {
        g.lineStyle(1, 0xffaa00, 0.9);
        g.strokeCircle(info.lastKnown.x, info.lastKnown.y, 8);
        g.lineBetween(
          info.lastKnown.x - 6, info.lastKnown.y - 6,
          info.lastKnown.x + 6, info.lastKnown.y + 6,
        );
      }
    }
  }
}
