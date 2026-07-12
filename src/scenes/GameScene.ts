import Phaser from 'phaser';
import {
  BOMB_DEFUSE_KIT_TIME_SEC,
  BOMB_DEFUSE_TIME_SEC,
  BOMB_PLANT_TIME_SEC,
  BOMB_TIMER_SEC,
  BOT_PROFILES,
  FLASH_BEHIND_MULT,
  FLASH_MAX_BLIND_SEC,
  FLASH_RANGE_PX,
  HE_RADIUS_PX,
  ROUNDS_TO_WIN,
  SMOKE_RADIUS_PX,
  ARMOR_MAX,
  ARMOR_PRICE,
  DEFUSE_KIT_PRICE,
  GRENADES,
  PLAYER_MAX_HP,
  PLAYER_RADIUS,
  ROUND_TIME_SEC,
  START_MONEY,
  TEAM_SIZE,
  TICK_RATE,
  WEAPONS,
} from '../core/config';
import type { GameState, InputCommand, MapGrid, Segment, Team, Vec2 } from '../core/types';
import type { MapData } from '../core/map';
import { applyInput, createGameState, createPlayer, stepWorld } from '../core/simulation';
import { isWall } from '../core/collision';
import { activeWeapon, currentSpreadDeg, givePrimary } from '../core/weapons';
import { canSee, smokeSegments } from '../core/vision';
import {
  aliveCount,
  canBuy,
  createMatchState,
  movementFrozen,
  tryBuy,
  updateMatch,
} from '../match/MatchState';
import type { BuyItem, MatchState } from '../match/MatchState';
import { InputSystem } from '../game/systems/InputSystem';
import { EffectsSystem } from '../game/systems/EffectsSystem';
import { VisionSystem } from '../game/systems/VisionSystem';
import { AudioSystem } from '../game/systems/AudioSystem';
import { PlayerView } from '../game/entities/PlayerView';
import { BotController } from '../ai/BotController';
import { assignBotObjectives, buildBotWorld } from '../ai/objectives';
import { DebugOverlay } from '../game/debug/DebugOverlay';
import { loadMap, MAP_KEY } from '../game/map/MapLoader';
import { loadSettings } from '../game/settings';
import type { GameConfig } from './MenuScene';
import type {
  Banner,
  BuyMenuItem,
  HudData,
  HudSource,
  MinimapData,
  MinimapDot,
  ScoreboardRow,
} from './UIScene';
import { UIScene } from './UIScene';
import {
  BOMB,
  BOMB_CSS,
  BOMB_PLANT,
  DANGER_NUM,
  FACTION,
  FACTION_CSS,
  HIT,
  LINE,
  ME_RING,
  SMOKE_CLOUD,
} from '../game/theme';

const BUY_ITEMS: { item: BuyItem; label: string }[] = [
  { item: 'deagle', label: 'Deagle' },
  { item: 'shotgun', label: 'Shotgun' },
  { item: 'smg', label: 'SMG' },
  { item: 'rifle', label: 'Rifle' },
  { item: 'sniper', label: 'Sniper' },
  { item: 'armor', label: 'Armor' },
  { item: 'kit', label: 'Defuse kit' },
  { item: 'he', label: 'HE grenade' },
  { item: 'flash', label: 'Flashbang' },
  { item: 'smoke', label: 'Smoke' },
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
 * Thin orchestrator: fixed-timestep loop feeding InputCommands (keyboard +
 * bot brains) into core/simulation, match rules layered on via
 * match/MatchState, SimEvents/MatchEvents drained into effects/audio/HUD.
 * No game logic here.
 */
export class GameScene extends Phaser.Scene implements HudSource {
  /** The player this client controls (fixed locally; assigned by the server online). */
  protected humanId = 'p1';
  protected state!: GameState;
  protected match!: MatchState;
  protected map!: MapData;
  protected inputSystem!: InputSystem;
  protected effects!: EffectsSystem;
  protected vision!: VisionSystem;
  protected audio!: AudioSystem;
  protected views!: Record<string, PlayerView>;
  protected bots: Record<string, BotController> = {};
  protected names: Record<string, string> = { bomb: 'the bomb' };
  protected tIds: string[] = [];
  protected ctIds: string[] = [];
  /** Bombsite centers snapped to walkable tiles (bot plant/defend anchors). */
  private siteAnchors: Vec2[] = [];
  private debug!: DebugOverlay;
  private ui!: UIScene;
  private bombGfx!: Phaser.GameObjects.Graphics;
  private damageIndicatorGfx!: Phaser.GameObjects.Graphics;
  private damageIndicators: { angle: number; age: number }[] = [];
  private banner: (Banner & { ttl: number }) | null = null;
  private lastPlantPos: Vec2 = { x: 0, y: 0 };
  private beepAcc = 0;
  private followedId: string | null = null;
  private smokeGfx!: Phaser.GameObjects.Graphics;
  private flashRect!: Phaser.GameObjects.Rectangle;
  /** Seconds of local flashbang whiteout remaining. */
  private blindLeft = 0;
  /** Wall + active smoke segments for this frame's sight checks. */
  private frameSegments: Segment[] = [];

  protected accumulator = 0;
  protected prev: Record<string, RenderSnapshot> = {};
  /** F6: freeze bot brains (they stand still) for inspecting behavior. */
  private botsFrozen = false;
  /** False until the world exists — online defers setup to the first snapshot. */
  protected worldReady = false;

  protected config: GameConfig = { roundsToWin: ROUNDS_TO_WIN, mapKey: MAP_KEY };

  constructor(key: string = 'Game') {
    super(key);
  }

  init(data: Partial<GameConfig>): void {
    this.config = {
      roundsToWin: data.roundsToWin ?? ROUNDS_TO_WIN,
      mapKey: data.mapKey ?? MAP_KEY,
    };
    // Scenes are reused across matches — reset per-match state.
    this.bots = {};
    this.tIds = [];
    this.ctIds = [];
    this.prev = {};
    this.names = { bomb: 'the bomb' };
    this.banner = null;
    this.damageIndicators = [];
    this.accumulator = 0;
    this.followedId = null;
    this.botsFrozen = false;
    this.blindLeft = 0;
    this.frameSegments = [];
    this.worldReady = false;
  }

  create(): void {
    this.map = loadMap(this, this.config.mapKey).data;
    this.state = createGameState();
    this.views = {};
    this.buildRoster();
    this.match = createMatchState(
      Object.keys(this.state.players),
      START_MONEY,
      this.config.roundsToWin,
    );
    this.createPresentation();
  }

  /**
   * Everything visual/system-side that needs map + state + views to exist.
   * The online scene calls this only after the first server snapshot.
   */
  protected createPresentation(): void {
    const { grid } = this.map;

    this.siteAnchors = buildBotWorld(this.map).siteAnchors;

    this.inputSystem = new InputSystem(this);
    this.effects = new EffectsSystem(this, grid.width * grid.tileSize, grid.height * grid.tileSize);
    this.vision = new VisionSystem(this, this.map.segments);
    this.audio = new AudioSystem(this);
    this.bombGfx = this.add.graphics().setDepth(4);
    // Smoke clouds cover players (5) but sit under the fog layer (50).
    this.smokeGfx = this.add.graphics().setDepth(40);
    this.damageIndicatorGfx = this.add.graphics().setScrollFactor(0).setDepth(600);
    this.flashRect = this.add
      .rectangle(this.scale.width / 2, this.scale.height / 2, this.scale.width, this.scale.height, 0xffffff)
      .setScrollFactor(0)
      .setDepth(650)
      .setAlpha(0);
    this.blindLeft = 0;

    this.cameras.main.setBounds(0, 0, grid.width * grid.tileSize, grid.height * grid.tileSize);
    this.follow(this.humanId);

    this.debug = new DebugOverlay(this);
    this.bindLoadoutCheats();

    this.scene.launch('UI', { source: this });
    this.ui = this.scene.get('UI') as unknown as UIScene;
    this.worldReady = true;
  }

  /** 1 human + bots on T vs all-bot CT side, sized by TEAM_SIZE. */
  protected buildRoster(): void {
    const { roamPoints } = buildBotWorld(this.map);
    const profile = BOT_PROFILES[loadSettings().botDifficulty];

    const add = (id: string, team: Team, name: string, isBot: boolean): void => {
      const spawns = team === 'T' ? this.map.spawnsT : this.map.spawnsCT;
      const idx = team === 'T' ? this.tIds.length : this.ctIds.length;
      const at = spawns[idx % spawns.length];
      this.state.players[id] = createPlayer(id, team, at.x, at.y);
      this.views[id] = new PlayerView(this, at.x, at.y, team, id === this.humanId);
      this.prev[id] = { x: at.x, y: at.y, angle: 0 };
      this.names[id] = name;
      (team === 'T' ? this.tIds : this.ctIds).push(id);
      if (isBot) {
        // Enemies are filled in below once both rosters exist.
        this.bots[id] = new BotController(id, [], profile, this.map, roamPoints, 0xbeef + idx * 7 + (team === 'CT' ? 1000 : 0));
      }
    };

    add(this.humanId, 'T', 'You', false);
    for (let i = 1; i < TEAM_SIZE; i++) {
      add(`t${i + 1}`, 'T', `T-Bot ${i + 1}`, true);
    }
    for (let i = 0; i < TEAM_SIZE; i++) {
      add(`ct${i + 1}`, 'CT', `CT-Bot ${i + 1}`, true);
    }
    for (const id of this.tIds) this.bots[id]?.setEnemies(this.ctIds);
    for (const id of this.ctIds) this.bots[id]?.setEnemies(this.tIds);
  }

  /** Debug loadout swaps (F1–F3) bypassing the economy. */
  protected bindLoadoutCheats(): void {
    const kb = this.input.keyboard!;
    const cheats = { F1: 'smg', F2: 'rifle', F3: 'sniper' } as const;
    for (const [key, weapon] of Object.entries(cheats)) {
      kb.on(`keydown-${key}`, () => givePrimary(this.state.players[this.humanId], weapon));
    }
    kb.on('keydown-F5', () => (this.vision.fullCircle = !this.vision.fullCircle));
    kb.on('keydown-F6', () => (this.botsFrozen = !this.botsFrozen));
    this.bindPauseKey();
  }

  protected bindPauseKey(): void {
    this.input.keyboard!.on('keydown-ESC', () => {
      this.scene.pause();
      this.scene.pause('UI');
      this.scene.launch('Pause', { gameKey: this.scene.key });
    });
  }

  update(_time: number, delta: number): void {
    if (!this.worldReady) return;
    this.advanceSimulation(Math.min(delta, MAX_FRAME_DELTA_MS) / 1000);

    this.frameSegments =
      this.state.smokes.length > 0
        ? [...this.map.segments, ...smokeSegments(this.state.smokes)]
        : this.map.segments;

    this.assignObjectives();
    this.drainSimEvents();
    this.drainMatchEvents();
    this.updateBanner(delta);
    this.updateBombAudioVisual(delta);
    this.drawGrenades();
    this.updateFlashOverlay(delta);
    this.effects.update(delta);
    this.updateDamageIndicators(delta);

    const subjectId = this.viewSubjectId();
    this.follow(subjectId);
    const rendered = this.renderPlayers(subjectId);
    this.audio.setListener(rendered);
    this.audio.updateFootsteps(Object.values(this.state.players), delta / 1000);
    this.vision.update({ x: rendered.x, y: rendered.y }, rendered.angle, this.state.smokes);
    this.cullEnemies(subjectId);

    this.updateDebug(this.state.players[this.humanId]);
  }

  /**
   * Advance the authoritative world by `dtSec` of wall-clock time: fixed
   * ticks of local simulation here; the online subclass replaces this with
   * "send inputs, apply server snapshots".
   */
  protected advanceSimulation(dtSec: number): void {
    this.accumulator += dtSec;
    const player = this.state.players[this.humanId];

    while (this.accumulator >= FIXED_DT) {
      for (const p of Object.values(this.state.players)) {
        this.prev[p.id] = { x: p.pos.x, y: p.pos.y, angle: p.angle };
      }
      const evStart = this.state.events.length;
      const cmds: Record<string, InputCommand> = {};

      let cmd = this.inputSystem.sample(this.state.tick, player.pos);
      if (movementFrozen(this.match)) cmd = { ...cmd, moveX: 0, moveY: 0, buttons: 0 };
      cmds[this.humanId] = cmd;
      applyInput(this.state, this.humanId, cmd, this.map, FIXED_DT);

      const botsActive =
        !this.botsFrozen && (this.match.phase === 'live' || this.match.phase === 'round_end');
      if (botsActive) {
        for (const bot of Object.values(this.bots)) {
          const botCmd = bot.update(this.state, FIXED_DT);
          cmds[bot.id] = botCmd;
          applyInput(this.state, bot.id, botCmd, this.map, FIXED_DT);
        }
      }

      stepWorld(this.state, this.map, FIXED_DT);
      updateMatch(
        this.match,
        this.state,
        cmds,
        this.map,
        this.state.events.slice(evStart),
        FIXED_DT,
      );
      this.state.tick++;
      this.accumulator -= FIXED_DT;
    }
  }

  // --- HudSource (pulled by UIScene every frame) ------------------------

  getHud(): HudData {
    const me = this.state.players[this.humanId];
    const stats = this.match.stats[this.humanId];
    const bomb = this.match.bomb;
    const slot = me.slots[me.activeSlot];
    const def = WEAPONS[slot.weaponId];
    const subjectId = this.viewSubjectId();

    let action: HudData['action'] = null;
    if (bomb.plant?.playerId === this.humanId) {
      action = { label: 'PLANTING', frac: bomb.plant.progress / BOMB_PLANT_TIME_SEC };
    } else if (bomb.defuse?.playerId === this.humanId) {
      const needed = stats.hasDefuseKit ? BOMB_DEFUSE_KIT_TIME_SEC : BOMB_DEFUSE_TIME_SEC;
      action = { label: 'DEFUSING', frac: bomb.defuse.progress / needed };
    }

    const gear = [
      ...me.grenades.map((g) => g.toUpperCase()),
      ...(stats.hasDefuseKit ? ['KIT'] : []),
    ].join(' · ');

    return {
      hp: me.hp,
      armor: me.armor,
      gear,
      minimap: this.buildMinimap(subjectId),
      weaponLabel: def.id.toUpperCase(),
      ammoLabel:
        me.reloadRemaining > 0
          ? 'RELOADING…'
          : def.magSize > 0
            ? `${slot.magAmmo}/${slot.reserveAmmo}`
            : '—',
      ammoWarn: def.magSize > 0 && slot.magAmmo === 0 && me.reloadRemaining === 0,
      money: stats.money,
      round: this.match.round,
      scoreT: this.match.score.T,
      scoreCT: this.match.score.CT,
      aliveT: aliveCount(this.state, 'T'),
      aliveCT: aliveCount(this.state, 'CT'),
      phase: this.match.phase,
      clockSec: this.match.phaseTimeLeft,
      bombPlanted: bomb.plantedAt !== null,
      bombTimeLeft: bomb.timeLeft,
      carryingBomb: bomb.carrierId === this.humanId,
      action,
      banner: this.banner ?? this.phaseBanner(),
      spectating: subjectId !== this.humanId ? this.names[subjectId] : null,
      buyMenu: canBuy(this.match) && me.hp > 0 ? this.buildBuyMenu() : null,
      scoreboard: this.buildScoreboard(),
    };
  }

  buy(item: BuyItem): void {
    tryBuy(this.match, this.state, this.humanId, item);
  }

  getGrid(): MapGrid {
    return this.map.grid;
  }

  /** Teammates always; enemies only while their world view is visible. */
  private buildMinimap(subjectId: string): MinimapData {
    const subject = this.state.players[subjectId];
    const dots: MinimapDot[] = [];
    for (const p of Object.values(this.state.players)) {
      if (p.hp <= 0) continue;
      if (
        p.team !== subject.team &&
        !canSee(subject, p.pos, this.frameSegments, this.vision.fullCircle)
      ) {
        continue;
      }
      dots.push({ x: p.pos.x, y: p.pos.y, team: p.team, isMe: p.id === this.humanId });
    }
    return {
      dots,
      planted: this.match.bomb.plantedAt,
      dropped: this.match.bomb.droppedAt,
    };
  }

  /** Default banner when no event banner is live. */
  private phaseBanner(): Banner | null {
    switch (this.match.phase) {
      case 'warmup':
        return { eyebrow: 'BREACHPOINT', headline: 'WARMUP', sub: null };
      case 'buy':
        return {
          eyebrow: `ROUND ${this.match.round}`,
          headline: 'BUY TIME',
          sub: 'press 1–4 to buy · movement unlocks at round start',
        };
      default:
        return null;
    }
  }

  private buildBuyMenu(): BuyMenuItem[] {
    const me = this.state.players[this.humanId];
    const stats = this.match.stats[this.humanId];
    return BUY_ITEMS.map(({ item, label }) => {
      let price: number;
      let owned: boolean;
      if (item === 'kit') {
        price = DEFUSE_KIT_PRICE;
        owned = stats.hasDefuseKit || me.team !== 'CT';
      } else if (item === 'armor') {
        price = ARMOR_PRICE;
        owned = me.armor >= ARMOR_MAX;
      } else if (item === 'he' || item === 'flash' || item === 'smoke') {
        price = GRENADES[item].price;
        owned = me.grenades.includes(item);
      } else {
        price = WEAPONS[item].price;
        owned = me.slots[WEAPONS[item].slotIndex]?.weaponId === item;
      }
      return { item, label, price, enabled: !owned && stats.money >= price };
    });
  }

  private buildScoreboard(): ScoreboardRow[] {
    return [...this.tIds, ...this.ctIds].map((id) => {
      const p = this.state.players[id];
      const s = this.match.stats[id];
      return {
        name: this.names[id],
        team: p.team,
        kills: s.kills,
        deaths: s.deaths,
        money: s.money,
        alive: p.hp > 0,
      };
    });
  }

  // --- Match plumbing -----------------------------------------------------

  /** Standing orders for bots, derived from the current bomb/round state. */
  private assignObjectives(): void {
    assignBotObjectives(this.bots, this.match, this.siteAnchors, this.tIds, this.ctIds);
  }

  private drainSimEvents(): void {
    for (const ev of this.state.events) {
      if (ev.type === 'shot') {
        for (const bot of Object.values(this.bots)) bot.hear(this.state, ev);
        this.effects.handle(ev, this.humanId);
        this.audio.play(this.audio.shotKey(ev.weaponId), ev.from);
        if (ev.hitPlayerId) {
          this.views[ev.hitPlayerId]?.flashDamage();
          if (ev.playerId === this.humanId) this.audio.play('hit');
          if (ev.hitPlayerId === this.humanId) {
            this.audio.play('hurt');
            this.effects.damageShake();
            const shooter = this.state.players[ev.playerId];
            const me = this.state.players[this.humanId];
            if (shooter && me) {
              this.damageIndicators.push({
                angle: Math.atan2(shooter.pos.y - me.pos.y, shooter.pos.x - me.pos.x),
                age: 0,
              });
            }
          }
        }
      } else if (ev.type === 'reload') {
        const p = this.state.players[ev.playerId];
        if (p) this.audio.play('reload', p.pos);
      } else if (ev.type === 'grenade_throw') {
        this.audio.play('grenade_throw', ev.from);
      } else if (ev.type === 'grenade_explode') {
        this.handleGrenadeExplode(ev.gtype, ev.pos);
      } else if (ev.type === 'death') {
        const victim = this.state.players[ev.playerId];
        if (victim) {
          this.effects.handle(ev, this.humanId, victim.pos);
          this.audio.play('death', victim.pos);
        }
        // No respawn during the round — the fallen return at round start.
        this.views[ev.playerId]?.setVisible(false);
      }
    }
    this.state.events.length = 0;
  }

  private handleGrenadeExplode(gtype: 'he' | 'flash' | 'smoke', pos: Vec2): void {
    if (gtype === 'he') {
      this.audio.play('he_explode', pos);
      this.effects.explosion(pos, HE_RADIUS_PX);
      const me = this.state.players[this.humanId];
      if (me.hp > 0 && Math.hypot(me.pos.x - pos.x, me.pos.y - pos.y) < HE_RADIUS_PX * 1.5) {
        this.effects.damageShake();
      }
    } else if (gtype === 'smoke') {
      this.audio.play('smoke_pop', pos);
    } else {
      this.audio.play('flash_pop', pos);
      this.applyFlash(pos);
    }
  }

  /** Flash blinds whoever can see it — full when facing it, reduced behind. */
  private applyFlash(pos: Vec2): void {
    const blindFor = (viewer: { pos: Vec2; angle: number }): number => {
      const dx = pos.x - viewer.pos.x;
      const dy = pos.y - viewer.pos.y;
      const dist = Math.hypot(dx, dy);
      if (dist > FLASH_RANGE_PX) return 0;
      // Occlusion (walls + smoke) uses the same rules as all sight checks —
      // but not the view cone: a flash at your back still blinds you.
      if (!canSee({ pos: viewer.pos, angle: viewer.angle }, pos, this.frameSegments, true)) return 0;
      const facing = Math.cos(Math.atan2(dy, dx) - viewer.angle) > 0 ? 1 : FLASH_BEHIND_MULT;
      return FLASH_MAX_BLIND_SEC * (1 - dist / FLASH_RANGE_PX) * facing;
    };

    const me = this.state.players[this.humanId];
    if (me.hp > 0) this.blindLeft = Math.max(this.blindLeft, blindFor(me));
    for (const [id, bot] of Object.entries(this.bots)) {
      const p = this.state.players[id];
      if (p.hp > 0) bot.flash(blindFor(p));
    }
  }

  private updateFlashOverlay(delta: number): void {
    this.blindLeft = Math.max(0, this.blindLeft - delta / 1000);
    this.flashRect.setAlpha(Math.min(1, this.blindLeft / 0.9));
  }

  /** Grenades in flight (bombGfx layer) + smoke clouds (above players). */
  private drawGrenades(): void {
    const g = this.bombGfx;
    for (const p of this.state.projectiles) {
      const band = p.type === 'he' ? HIT : p.type === 'flash' ? ME_RING : LINE;
      g.fillStyle(SMOKE_CLOUD, 1);
      g.fillCircle(p.pos.x, p.pos.y, 4);
      g.lineStyle(2, band, 1);
      g.strokeCircle(p.pos.x, p.pos.y, 4);
    }

    const s = this.smokeGfx;
    s.clear();
    for (const cloud of this.state.smokes) {
      // Fade out over the last 1.5s; light wobble so it reads as volume.
      const fade = Math.min(1, cloud.timeLeft / 1.5);
      const wobble = 1 + 0.03 * Math.sin(this.time.now / 300 + cloud.id);
      s.fillStyle(SMOKE_CLOUD, 0.94 * fade);
      s.fillCircle(cloud.pos.x, cloud.pos.y, SMOKE_RADIUS_PX * wobble);
      s.lineStyle(2, LINE, 0.5 * fade);
      s.strokeCircle(cloud.pos.x, cloud.pos.y, SMOKE_RADIUS_PX * wobble);
    }
  }

  private drainMatchEvents(): void {
    for (const ev of this.match.events) {
      switch (ev.type) {
        case 'round_start':
          this.onRoundStart();
          break;
        case 'round_end': {
          const reasonText = {
            elimination: 'enemy team eliminated',
            detonation: 'bomb detonated',
            defusal: 'bomb defused',
            time: 'time ran out',
          }[ev.reason];
          this.setBanner(
            {
              eyebrow: `ROUND ${this.match.round}`,
              eyebrowColor: FACTION_CSS[ev.winner],
              headline: `${ev.winner} WIN THE ROUND`,
              sub: reasonText,
            },
            3800,
          );
          break;
        }
        case 'match_end':
          this.setBanner(
            {
              eyebrow: `FINAL · T ${this.match.score.T} : ${this.match.score.CT} CT`,
              eyebrowColor: FACTION_CSS[ev.winner],
              headline: `${ev.winner === 'T' ? 'TERRORISTS' : 'COUNTER-TERRORISTS'} WIN THE MATCH`,
              sub: 'ESC — quit to menu',
            },
            Number.POSITIVE_INFINITY,
          );
          break;
        case 'planted':
          this.lastPlantPos = { ...ev.pos };
          this.beepAcc = 0;
          this.audio.play('bomb_plant', ev.pos);
          this.setBanner(
            { eyebrow: 'OBJECTIVE', eyebrowColor: BOMB_CSS, headline: 'BOMB PLANTED', sub: `${BOMB_TIMER_SEC} seconds to detonation` },
            2500,
          );
          break;
        case 'defused':
          this.audio.play('bomb_defused', this.lastPlantPos);
          break;
        case 'exploded':
          this.audio.play('bomb_explode', ev.pos);
          this.effects.damageShake();
          break;
        case 'kill': {
          const killerTeam = this.state.players[ev.killerId]?.team;
          const color = killerTeam ? FACTION_CSS[killerTeam] : BOMB_CSS;
          this.ui.addKillFeedLine(
            `${this.names[ev.killerId] ?? ev.killerId} ✕ ${this.names[ev.victimId] ?? ev.victimId}`,
            color,
            ev.victimId === this.humanId,
          );
          break;
        }
        case 'bomb_dropped':
        case 'bomb_pickup':
          break; // world/HUD rendering reads bomb state directly
      }
    }
    this.match.events.length = 0;
  }

  /** New round: everyone is back (match already respawned them). */
  private onRoundStart(): void {
    for (const [id, view] of Object.entries(this.views)) {
      view.setVisible(true);
      const p = this.state.players[id];
      this.prev[id] = { x: p.pos.x, y: p.pos.y, angle: p.angle };
    }
    for (const bot of Object.values(this.bots)) bot.reset();
    this.follow(this.humanId);
    this.banner = null; // the buy-phase default banner takes over
    this.autoBuyBots();
  }

  /** Greedy bot spending: best affordable primary, then a kit for CTs. */
  private autoBuyBots(): void {
    for (const id of Object.keys(this.bots)) {
      if (!tryBuy(this.match, this.state, id, 'rifle')) {
        tryBuy(this.match, this.state, id, 'smg');
      }
      if (this.state.players[id].team === 'CT') tryBuy(this.match, this.state, id, 'kit');
    }
  }

  private setBanner(banner: Banner, ttl: number): void {
    this.banner = { ...banner, ttl };
  }

  private updateBanner(delta: number): void {
    if (!this.banner) return;
    this.banner.ttl -= delta;
    if (this.banner.ttl <= 0) this.banner = null;
  }

  /** Dropped/planted bomb markers + accelerating countdown beeps. */
  private updateBombAudioVisual(delta: number): void {
    const bomb = this.match.bomb;
    const g = this.bombGfx;
    g.clear();
    this.drawSpawnZones(g);
    if (bomb.droppedAt) {
      g.fillStyle(BOMB, 1);
      g.fillRect(bomb.droppedAt.x - 5, bomb.droppedAt.y - 4, 10, 8);
      g.lineStyle(1, 0x0d1014, 1);
      g.strokeRect(bomb.droppedAt.x - 5, bomb.droppedAt.y - 4, 10, 8);
    }
    if (bomb.plantedAt) {
      const pulse = 0.5 + 0.5 * Math.sin(this.time.now / 90);
      g.fillStyle(BOMB, 1);
      g.fillCircle(bomb.plantedAt.x, bomb.plantedAt.y, 6);
      g.lineStyle(2, BOMB_PLANT, 0.4 + 0.6 * pulse);
      g.strokeCircle(bomb.plantedAt.x, bomb.plantedAt.y, 10 + 4 * pulse);

      if (this.match.phase === 'live') {
        this.beepAcc += delta / 1000;
        const interval = 0.15 + 0.85 * (bomb.timeLeft / BOMB_TIMER_SEC);
        if (this.beepAcc >= interval) {
          this.beepAcc = 0;
          this.audio.play('bomb_beep', bomb.plantedAt);
        }
      }
    }

    for (const [id, view] of Object.entries(this.views)) {
      view.setBombCarrier(bomb.carrierId === id);
    }
  }

  /**
   * Faction-tinted hatched spawn rectangles, shown during buy/freeze time
   * and faded out over the first second of LIVE — orient without
   * cluttering the firefight.
   */
  private drawSpawnZones(g: Phaser.GameObjects.Graphics): void {
    let alpha = 0;
    if (this.match.phase === 'buy' || this.match.phase === 'warmup') alpha = 1;
    else if (this.match.phase === 'live') {
      const intoLive = ROUND_TIME_SEC - this.match.phaseTimeLeft;
      alpha = Phaser.Math.Clamp(1 - intoLive / 1.2, 0, 1);
    }
    if (alpha <= 0) return;

    const pad = 44;
    for (const team of ['T', 'CT'] as const) {
      const spawns = team === 'T' ? this.map.spawnsT : this.map.spawnsCT;
      const minX = Math.min(...spawns.map((p) => p.x)) - pad;
      const maxX = Math.max(...spawns.map((p) => p.x)) + pad;
      const minY = Math.min(...spawns.map((p) => p.y)) - pad;
      const maxY = Math.max(...spawns.map((p) => p.y)) + pad;
      g.lineStyle(2, FACTION[team], 0.4 * alpha);
      g.strokeRect(minX, minY, maxX - minX, maxY - minY);
      g.lineStyle(1, FACTION[team], 0.14 * alpha);
      for (let x = minX - (maxY - minY); x < maxX; x += 14) {
        // 45° hatching, clipped to the rect's vertical span.
        const x0 = Math.max(x, minX);
        const y0 = minY + (x0 - x);
        const x1 = Math.min(x + (maxY - minY), maxX);
        const y1 = minY + (x1 - x);
        if (y0 < maxY) g.lineBetween(x0, y0, x1, y1);
      }
    }
  }

  // --- Camera / rendering -------------------------------------------------

  /** Who the camera, fog and audio belong to: you, or a living teammate. */
  private viewSubjectId(): string {
    const me = this.state.players[this.humanId];
    if (me.hp > 0) return this.humanId;
    for (const id of me.team === 'T' ? this.tIds : this.ctIds) {
      if (this.state.players[id].hp > 0) return id;
    }
    return this.humanId;
  }

  private follow(id: string): void {
    if (this.followedId === id) return;
    this.followedId = id;
    this.cameras.main.startFollow(this.views[id]);
  }

  /** Enemies (and dead bodies) hide behind the fog's rules. */
  private cullEnemies(subjectId: string): void {
    const subject = this.state.players[subjectId];
    for (const id of subject.team === 'T' ? this.ctIds : this.tIds) {
      const enemy = this.state.players[id];
      if (enemy.hp <= 0) continue; // death handler hid the view
      this.views[id].setVisible(
        canSee(subject, enemy.pos, this.frameSegments, this.vision.fullCircle),
      );
    }
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
      g.lineStyle(5, DANGER_NUM, 0.8 * fade);
      g.beginPath();
      g.arc(cx, cy, 64, ind.angle - 0.5, ind.angle + 0.5);
      g.strokePath();
    }
  }

  /** Interpolate every view; returns the subject's render pos/angle. */
  private renderPlayers(subjectId: string): RenderSnapshot {
    const alpha = this.accumulator / FIXED_DT;
    let subject: RenderSnapshot = { x: 0, y: 0, angle: 0 };
    for (const p of Object.values(this.state.players)) {
      const prev = this.prev[p.id] ?? { x: p.pos.x, y: p.pos.y, angle: p.angle };
      const x = Phaser.Math.Linear(prev.x, p.pos.x, alpha);
      const y = Phaser.Math.Linear(prev.y, p.pos.y, alpha);
      const angle = prev.angle + Phaser.Math.Angle.Wrap(p.angle - prev.angle) * alpha;
      const view = this.views[p.id];
      view.setPosition(x, y);
      view.setAim(angle);
      view.setHpFrac(p.hp / PLAYER_MAX_HP);
      if (p.id === subjectId) subject = { x, y, angle };
    }
    return subject;
  }

  // --- Debug ----------------------------------------------------------------

  private updateDebug(player: (typeof this.state.players)[string]): void {
    this.debug.setLine('map', this.config.mapKey);
    this.debug.setLine('tick', String(this.state.tick));
    this.debug.setLine('phase', `${this.match.phase} ${this.match.phaseTimeLeft.toFixed(1)}s`);
    this.debug.setLine(
      'bomb',
      this.match.bomb.plantedAt
        ? `planted ${this.match.bomb.timeLeft.toFixed(1)}s`
        : (this.match.bomb.carrierId ?? 'none'),
    );
    this.debug.setLine('pos', `${player.pos.x.toFixed(1)}, ${player.pos.y.toFixed(1)}`);
    this.debug.setLine('weapon', activeWeapon(player).id);
    this.debug.setLine('spread', `${currentSpreadDeg(player).toFixed(2)}°`);
    for (const [id, bot] of Object.entries(this.bots)) {
      const hp = this.state.players[id].hp;
      this.debug.setLine(id, `${bot.debugInfo.state} hp:${hp}${this.botsFrozen ? ' (frozen F6)' : ''}`);
    }
    this.debug.setLine(
      'vision',
      `${this.vision.rayCount} rays, ${this.vision.fullCircle ? '360°' : 'cone'} (F5)`,
    );
    this.debug.update();
    if (this.debug.isVisible) this.drawDebug(player);
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
    for (const [id, botCtrl] of Object.entries(this.bots)) {
      const bot = this.state.players[id];
      if (bot.hp <= 0) continue;
      const info = botCtrl.debugInfo;
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
