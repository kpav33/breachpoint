import Phaser from "phaser";
import {
  FLASH_RANGE_PX,
  HE_RADIUS_PX,
  MONEY_CAP,
  PLAYER_MAX_HP,
  ROUND_TIME_SEC,
  SMOKE_RADIUS_PX,
  TICK_RATE,
  WEAPONS,
} from "../core/config";
import { Buttons } from "../core/types";
import type { GrenadeType, Vec2 } from "../core/types";
import {
  applyInput,
  createPlayer,
  predictGrenadePath,
  spawnGrenade,
  stepWorld,
} from "../core/simulation";
import { tryBuy, trySell } from "../match/MatchState";
import type { BuyItem } from "../match/MatchState";
import { PlayerView } from "../game/entities/PlayerView";
import { keyDisplayName, loadSettings } from "../game/settings";
import { DROPPED_GUN, HIT, ME_RING, SMOKE_CLOUD, TRACER } from "../game/theme";
import { GameScene } from "./GameScene";
import type { HudData } from "./UIScene";

const FIXED_DT = 1 / TICK_RATE;
const GRENADE_TYPES: GrenadeType[] = ["smoke", "flash", "he"];
/** How long a thrown grenade's trail + coverage marker linger, ms. */
const TRAIL_FADE_MS = 8000;

/** A remembered throw, replayable exactly via spawnGrenade. */
interface RecordedThrow {
  pos: Vec2;
  angle: number;
  type: GrenadeType;
  flat: boolean;
}

/**
 * Utility practice mode (Phase 10): a solo offline sandbox — no bots, no
 * rounds, no bomb — with infinite money/ammo/grenades, a live trajectory
 * preview (dry-runs the deterministic sim), post-throw trails with
 * smoke/flash/HE coverage markers, and a "rethrow last grenade" key.
 * All practice logic is client-side on top of the untouched simulation.
 */
export class PracticeScene extends GameScene {
  /** N: draw the predicted arc + landing coverage for previewType. */
  private previewOn = true;
  private previewType: GrenadeType = "smoke";
  /** B: the buy panel (usable anytime here) is open. */
  private buyOpen = false;
  private lastThrow: RecordedThrow | null = null;
  private rethrowQueued = false;
  /** Walk held on the latest sampled input — previews the flat roll. */
  private walkHeld = false;
  /** Actual flight paths, live (keyed by projectile id) and fading out. */
  private liveTrails = new Map<number, { type: GrenadeType; points: Vec2[] }>();
  private fadingTrails: {
    type: GrenadeType;
    points: Vec2[];
    end: Vec2;
    age: number;
  }[] = [];
  private practiceGfx!: Phaser.GameObjects.Graphics;

  constructor() {
    super("Practice");
  }

  init(data: Parameters<GameScene["init"]>[0]): void {
    super.init(data);
    this.previewOn = true;
    this.previewType = "smoke";
    this.buyOpen = false;
    this.lastThrow = null;
    this.rethrowQueued = false;
    this.liveTrails = new Map();
    this.fadingTrails = [];
  }

  create(): void {
    super.create();
    // No rounds: park the match in LIVE forever (updateMatch never runs).
    this.match.phase = "live";
    this.match.phaseTimeLeft = ROUND_TIME_SEC;
    // Preview and trails must stay readable through the fog (depth 50) —
    // seeing where a lineup lands behind walls is the point of the mode.
    this.practiceGfx = this.add.graphics().setDepth(55);

    const b = loadSettings().keybinds;
    const k = (name: keyof typeof b): string => keyDisplayName(b[name]);
    this.setBanner(
      {
        eyebrow: "PRACTICE",
        headline: "UTILITY SANDBOX",
        sub:
          `${k("he")}/${k("flash")}/${k("smoke")} throw (arcs over walls) · ` +
          `${k("walk")}+throw flat roll · N preview on/off · ` +
          "M preview type · T rethrow last · B buy",
      },
      9000,
    );
  }

  /** Just you — no bots, no CT side. */
  protected buildRoster(): void {
    const at = this.map.spawnsT[0];
    this.state.players[this.humanId] = createPlayer(
      this.humanId,
      "T",
      at.x,
      at.y,
    );
    this.views[this.humanId] = new PlayerView(this, at.x, at.y, "T", true);
    this.prev[this.humanId] = { x: at.x, y: at.y, angle: 0 };
    this.names[this.humanId] = "You";
    this.tIds.push(this.humanId);
  }

  protected bindLoadoutCheats(): void {
    super.bindLoadoutCheats();
    const kb = this.input.keyboard!;
    kb.on("keydown-N", () => (this.previewOn = !this.previewOn));
    kb.on("keydown-M", () => {
      const i = GRENADE_TYPES.indexOf(this.previewType);
      this.previewType = GRENADE_TYPES[(i + 1) % GRENADE_TYPES.length];
    });
    kb.on("keydown-T", () => (this.rethrowQueued = true));
    kb.on("keydown-B", () => (this.buyOpen = !this.buyOpen));
  }

  /** Sandbox tick: input → sim → world, no bots, no match rules. */
  protected advanceSimulation(dtSec: number): void {
    this.accumulator += dtSec;
    const player = this.state.players[this.humanId];

    while (this.accumulator >= FIXED_DT) {
      this.prev[this.humanId] = {
        x: player.pos.x,
        y: player.pos.y,
        angle: player.angle,
      };

      const before = this.state.nextProjectileId;
      const cmd = this.inputSystem.sample(this.state.tick, player.pos);
      this.walkHeld = (cmd.buttons & Buttons.Walk) !== 0;
      applyInput(this.state, this.humanId, cmd, this.map, FIXED_DT);
      // A new projectile inside applyInput = the player threw: record it
      // (post-move pos/angle are exactly what tryThrow launched from; a
      // freshly spawned flat roll is recognizable by its zero launch vz).
      if (this.state.nextProjectileId > before) {
        const g = this.state.projectiles[this.state.projectiles.length - 1];
        this.lastThrow = {
          pos: { ...player.pos },
          angle: player.angle,
          type: g.type,
          flat: g.vz === 0,
        };
        this.previewType = g.type; // preview follows what you practice
      }

      if (this.rethrowQueued) {
        this.rethrowQueued = false;
        if (this.lastThrow) {
          spawnGrenade(
            this.state,
            this.humanId,
            this.lastThrow.pos,
            this.lastThrow.angle,
            this.lastThrow.type,
            this.lastThrow.flat,
          );
        }
      }

      stepWorld(this.state, this.map, FIXED_DT);
      this.restock();
      this.state.tick++;
      this.accumulator -= FIXED_DT;
    }
  }

  /** Infinite everything: hp, reserve ammo, one of each grenade, money. */
  private restock(): void {
    const p = this.state.players[this.humanId];
    p.hp = PLAYER_MAX_HP;
    for (const type of GRENADE_TYPES) {
      if (!p.grenades.includes(type)) p.grenades.push(type);
    }
    for (const slot of p.slots) {
      slot.reserveAmmo = WEAPONS[slot.weaponId].reserveSize;
    }
    this.match.stats[this.humanId].money = MONEY_CAP;
  }

  update(time: number, delta: number): void {
    super.update(time, delta);
    if (!this.worldReady) return;
    this.trackTrails(delta);
    this.drawPractice();
  }

  getHud(): HudData {
    const hud = super.getHud();
    // The buy panel opens anywhere, anytime (B) — money is bottomless.
    hud.buyMenu = this.buyOpen ? this.buildBuyMenu() : null;
    return hud;
  }

  buy(item: BuyItem): void {
    // tryBuy is phase-gated to BUY; the sandbox has no phases, so borrow it.
    const phase = this.match.phase;
    this.match.phase = "buy";
    if (!tryBuy(this.match, this.state, this.map, this.humanId, item)) {
      trySell(this.match, this.state, this.map, this.humanId, item);
    }
    this.match.phase = phase;
  }

  /** Record real flight paths; retire trails whose grenade detonated. */
  private trackTrails(delta: number): void {
    const seen = new Set<number>();
    for (const g of this.state.projectiles) {
      seen.add(g.id);
      let trail = this.liveTrails.get(g.id);
      if (!trail) {
        trail = { type: g.type, points: [{ x: g.pos.x, y: g.pos.y }] };
        this.liveTrails.set(g.id, trail);
      }
      const last = trail.points[trail.points.length - 1];
      if (Math.hypot(g.pos.x - last.x, g.pos.y - last.y) > 1) {
        trail.points.push({ x: g.pos.x, y: g.pos.y });
      }
    }
    for (const [id, trail] of this.liveTrails) {
      if (seen.has(id)) continue;
      this.liveTrails.delete(id);
      this.fadingTrails.push({
        type: trail.type,
        points: trail.points,
        end: trail.points[trail.points.length - 1],
        age: 0,
      });
    }
    for (let i = this.fadingTrails.length - 1; i >= 0; i--) {
      this.fadingTrails[i].age += delta;
      if (this.fadingTrails[i].age >= TRAIL_FADE_MS)
        this.fadingTrails.splice(i, 1);
    }
  }

  private drawPractice(): void {
    const g = this.practiceGfx;
    g.clear();

    for (const trail of this.liveTrails.values()) {
      this.drawPath(g, trail.points, this.typeColor(trail.type), 0.5, false);
    }
    for (const trail of this.fadingTrails) {
      const alpha = 1 - trail.age / TRAIL_FADE_MS;
      this.drawPath(
        g,
        trail.points,
        this.typeColor(trail.type),
        0.45 * alpha,
        false,
      );
      this.drawCoverage(g, trail.type, trail.end, alpha);
    }

    if (this.previewOn) {
      const me = this.state.players[this.humanId];
      const path = predictGrenadePath(
        me.pos,
        me.angle,
        this.previewType,
        this.map,
        FIXED_DT,
        this.walkHeld,
      );
      this.drawPath(g, path, TRACER, 0.55, true);
      const end = path[path.length - 1];
      g.fillStyle(this.typeColor(this.previewType), 0.9);
      g.fillCircle(end.x, end.y, 4);
      this.drawCoverage(g, this.previewType, end, 0.8);
    }
  }

  /** Polyline through per-tick points; `dashed` skips alternate segments. */
  private drawPath(
    g: Phaser.GameObjects.Graphics,
    points: Vec2[],
    color: number,
    alpha: number,
    dashed: boolean,
  ): void {
    if (points.length < 2) return;
    g.lineStyle(2, color, alpha);
    for (let i = 0; i < points.length - 1; i += dashed ? 2 : 1) {
      g.lineBetween(points[i].x, points[i].y, points[i + 1].x, points[i + 1].y);
    }
  }

  /** Where the grenade takes effect: smoke bloom, HE damage ring, flash range. */
  private drawCoverage(
    g: Phaser.GameObjects.Graphics,
    type: GrenadeType,
    at: Vec2,
    alpha: number,
  ): void {
    if (type === "smoke") {
      g.fillStyle(SMOKE_CLOUD, 0.35 * alpha);
      g.fillCircle(at.x, at.y, SMOKE_RADIUS_PX);
      g.lineStyle(2, DROPPED_GUN, 0.7 * alpha);
      g.strokeCircle(at.x, at.y, SMOKE_RADIUS_PX);
    } else if (type === "he") {
      g.lineStyle(2, HIT, 0.5 * alpha);
      g.strokeCircle(at.x, at.y, HE_RADIUS_PX);
    } else {
      g.lineStyle(2, ME_RING, 0.2 * alpha);
      g.strokeCircle(at.x, at.y, FLASH_RANGE_PX);
    }
  }

  private typeColor(type: GrenadeType): number {
    return type === "he" ? HIT : type === "flash" ? ME_RING : DROPPED_GUN;
  }

  protected extendDebug(): void {
    this.debug.setLine(
      "practice",
      `preview ${this.previewOn ? this.previewType : "off"} (N/M) · ` +
        `last throw ${this.lastThrow?.type ?? "—"} (T rethrows)`,
    );
  }
}
