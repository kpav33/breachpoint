// Bot brain (Phase 6). Pure TypeScript on top of core/ — no Phaser. Each
// tick it produces one InputCommand, exactly like a keyboard does; only
// core/simulation.applyInput() ever moves the bot. Lives in src/ai/ (not
// src/game/) and uses .ts-extension imports + no parameter properties, so
// the headless server can run it under `node --experimental-strip-types`.
import { Buttons } from '../core/types.ts';
import type {
  GameState,
  GrenadeType,
  InputCommand,
  PlayerState,
  SimEvent,
  Vec2,
} from '../core/types.ts';
import type { MapData } from '../core/map.ts';
import { canSee, smokeSegments } from '../core/vision.ts';
import { findPath, smoothPath } from '../core/pathfinding.ts';
import { grenadeChargeSpeed, predictGrenadePath } from '../core/simulation.ts';
import {
  BOT_AIM_JITTER_SEC,
  BOT_ENGAGE_RANGE_PX,
  BOT_FLASH_MAX_DIST_PX,
  BOT_FLASH_MIN_DIST_PX,
  BOT_FOOTSTEP_MIN_SPEED,
  BOT_GRENADE_COOLDOWN_SEC,
  BOT_GUARD_TURN_RATE,
  BOT_HE_MAX_DIST_PX,
  BOT_REPATH_SEC,
  BOT_SCAN_EVERY_TICKS,
  BOT_SEARCH_SEC,
  BOT_SEARCH_TURN_RATE,
  BOT_SMOKE_SETUP_RANGE_PX,
  BOT_STRAFE_MAX_SEC,
  BOT_STRAFE_MIN_SEC,
  BOT_STUCK_SEC,
  BOT_WAYPOINT_REACHED_PX,
  BOT_THROW_CHARGE_STEPS,
  BOT_THROW_PREPUSH_DELAY_SEC,
  BOT_THROW_REPLAN_SEC,
  BOT_THROW_TOLERANCE_PX,
  HE_RADIUS_PX,
  PLAYER_MAX_HP,
  PLAYER_RADIUS,
  SMOKE_RADIUS_PX,
  WEAPONS,
} from '../core/config.ts';
import type { BotProfile } from '../core/config.ts';

/** A committed multi-tick throw: aim held steady, charge the key, then release. */
interface PendingThrow {
  type: GrenadeType;
  angle: number;
  /** Ticks to hold the throw key before releasing (controls charge → distance). */
  holdTicks: number;
  ticksHeld: number;
  /** Where the dry-run said it will land — for the debug overlay. */
  target: Vec2;
}

const THROW_BUTTON: Record<GrenadeType, number> = {
  he: Buttons.ThrowHE,
  flash: Buttons.ThrowFlash,
  smoke: Buttons.ThrowSmoke,
};

export type BotState = 'patrol' | 'engage' | 'hunt' | 'retreat';

/**
 * A standing order from the match layer: go somewhere and either hold E
 * there (plant/defuse) or stand guard. Combat states always take priority;
 * with no objective the bot free-roams between its roam points.
 */
export interface BotObjective {
  pos: Vec2;
  /** Consider the objective reached within this range, px. */
  radiusPx: number;
  /** Hold the Use button once in range (plant/defuse). */
  holdUse?: boolean;
}

const DEG_TO_RAD = Math.PI / 180;

export class BotController {
  state: BotState = 'patrol';

  private path: Vec2[] = [];
  private pathIndex = 0;
  private pathGoal: Vec2 | null = null;
  private repathTimer = 0;
  private progressPos: Vec2 = { x: 0, y: 0 };
  private stuckTimer = 0;

  /** Where an enemy was last seen or heard; null = no lead to chase. */
  private lastKnown: Vec2 | null = null;
  private visibleTime = 0;
  private reactionLeft = 0;
  private burstLeft = 0;
  private burstPause = 0;
  private aimOffsetRad = 0;
  private aimJitterLeft = 0;
  private strafeDir: 1 | -1 = 1;
  private strafeLeft = 0;
  private searchLeft = 0;
  private searchAngle = 0;
  private objective: BotObjective | null = null;
  private onStation = false;
  private guardAngle = 0;
  /** Seconds of flashbang blindness remaining. */
  private blindLeft = 0;
  /** Seconds until this bot may throw another grenade. */
  private throwCooldown = 0;
  /** Seconds until the next throw-planning dry-run (bounds its cost). */
  private planCooldown = 0;
  /** A committed throw being wound up over several ticks (null = none). */
  private pendingThrow: PendingThrow | null = null;
  /** The last-known spot we already flashed, so we don't re-flash it. */
  private flashedLead: Vec2 | null = null;
  /** Ticks until the next LOS raycast scan (staggered per bot, Phase 9.5). */
  private scanCountdown = 0;
  /** Enemy sighted by the last scan; tracked between scans while alive. */
  private visibleTargetId: string | null = null;

  private rngState: number;

  // Fields are declared explicitly (not TS parameter properties): the server
  // runs this file under `node --experimental-strip-types`, which rejects
  // parameter properties. Same rule as src/core/.
  readonly id: string;
  private enemyIds: string[];
  private readonly profile: BotProfile;
  private readonly map: MapData;
  /** Points the bot roams between while it has nothing better to do. */
  private readonly roamPoints: Vec2[];

  constructor(
    id: string,
    enemyIds: string[],
    profile: BotProfile,
    map: MapData,
    roamPoints: Vec2[],
    seed: number,
  ) {
    this.id = id;
    this.enemyIds = enemyIds;
    this.profile = profile;
    this.map = map;
    this.roamPoints = roamPoints;
    this.rngState = seed | 0 || 1;
    // Offset the scan cycle per bot so they don't all raycast on the same tick.
    this.scanCountdown = (seed >>> 0) % BOT_SCAN_EVERY_TICKS;
  }

  /** Set who this bot fights (rosters may not exist yet at construction). */
  setEnemies(ids: string[]): void {
    this.enemyIds = ids;
  }

  /** Flashbang hit: no vision (ears still work) for `seconds`. */
  flash(seconds: number): void {
    this.blindLeft = Math.max(this.blindLeft, seconds);
  }

  /** Replace the standing order (null = free roam). */
  setObjective(obj: BotObjective | null): void {
    const moved =
      (obj === null) !== (this.objective === null) ||
      (obj !== null &&
        this.objective !== null &&
        Math.hypot(obj.pos.x - this.objective.pos.x, obj.pos.y - this.objective.pos.y) > 32);
    this.objective = obj;
    if (moved) {
      this.onStation = false;
      if (this.state === 'patrol') this.clearPath();
    }
  }

  /** Forget everything — call on (re)spawn. */
  reset(): void {
    this.state = 'patrol';
    this.path = [];
    this.pathIndex = 0;
    this.pathGoal = null;
    this.repathTimer = 0;
    this.stuckTimer = 0;
    this.lastKnown = null;
    this.visibleTargetId = null;
    this.visibleTime = 0;
    this.reactionLeft = 0;
    this.burstLeft = 0;
    this.burstPause = 0;
    this.searchLeft = 0;
    this.onStation = false;
    this.blindLeft = 0;
    this.pendingThrow = null;
    this.flashedLead = null;
    // throwCooldown deliberately survives respawn so a fresh round doesn't let
    // a bot instantly chuck everything; it drains over the buy/first seconds.
  }

  /** Gunshots set last-known-position when in earshot (walls don't block sound). */
  hear(gameState: GameState, ev: SimEvent): void {
    if (ev.type !== 'shot' || !this.enemyIds.includes(ev.playerId)) return;
    const me = gameState.players[this.id];
    if (!me || me.hp <= 0) return;
    const dist = Math.hypot(ev.from.x - me.pos.x, ev.from.y - me.pos.y);
    if (dist > this.profile.hearingRangePx) return;
    this.noticeEnemyAt(ev.from);
  }

  update(gameState: GameState, dt: number): InputCommand {
    const me = gameState.players[this.id];
    const cmd: InputCommand = {
      tick: gameState.tick,
      moveX: 0,
      moveY: 0,
      aimAngle: me?.angle ?? 0,
      buttons: 0,
    };
    if (!me || me.hp <= 0) return cmd;

    const target = this.perceive(gameState, me, dt);
    this.transition(me, target);

    // A grenade throw (in progress, or freshly decided) owns the bot for its
    // wind-up ticks: it aims, holds the key, and releases — no moving/shooting.
    if (this.stepGrenades(gameState, me, cmd, dt)) return cmd;

    switch (this.state) {
      case 'engage':
        this.doEngage(me, target!, cmd, dt);
        break;
      case 'hunt':
        this.doHunt(me, cmd, dt);
        break;
      case 'retreat':
        this.doRetreat(me, target, cmd, dt);
        break;
      case 'patrol':
        this.doPatrol(me, cmd, dt);
        break;
    }

    this.manageWeapon(me, target, cmd);
    return cmd;
  }

  /** For the debug overlay: current path and the point being chased. */
  get debugInfo(): {
    state: BotState;
    path: Vec2[];
    pathIndex: number;
    lastKnown: Vec2 | null;
    throwTarget: Vec2 | null;
  } {
    return {
      state: this.state,
      path: this.path,
      pathIndex: this.pathIndex,
      lastKnown: this.lastKnown,
      throwTarget: this.pendingThrow?.target ?? null,
    };
  }

  /** Whether this bot buys/uses grenades (difficulty-gated). */
  get usesUtility(): boolean {
    return this.profile.usesUtility;
  }

  // --- Perception -----------------------------------------------------

  /** Nearest visible enemy (bot vision = same cone/LOS rules as the player). */
  private perceive(gameState: GameState, me: PlayerState, dt: number): PlayerState | null {
    this.blindLeft = Math.max(0, this.blindLeft - dt);
    if (this.blindLeft > 0) this.visibleTargetId = null; // flashed: ears only

    // Hearing is cheap (no raycasts) — runs every tick.
    for (const id of this.enemyIds) {
      const enemy = gameState.players[id];
      if (!enemy || enemy.hp <= 0) continue;
      const dist = Math.hypot(enemy.pos.x - me.pos.x, enemy.pos.y - me.pos.y);
      const speed = Math.hypot(enemy.vel.x, enemy.vel.y);
      if (speed >= BOT_FOOTSTEP_MIN_SPEED && dist <= this.profile.hearingRangePx) {
        this.noticeEnemyAt(enemy.pos);
      }
    }

    // The LOS raycast scan is the expensive part: run it every Nth tick
    // (offset per bot); between scans keep tracking the last sighted enemy.
    if (--this.scanCountdown <= 0) {
      this.scanCountdown = BOT_SCAN_EVERY_TICKS;
      this.visibleTargetId = null;
      if (this.blindLeft <= 0) {
        // Smoke blocks bot sight exactly like it blocks the player's fog.
        const segments =
          gameState.smokes.length > 0
            ? [...this.map.segments, ...smokeSegments(gameState.smokes)]
            : this.map.segments;
        let bestDist = Infinity;
        for (const id of this.enemyIds) {
          const enemy = gameState.players[id];
          if (!enemy || enemy.hp <= 0) continue;
          const dist = Math.hypot(enemy.pos.x - me.pos.x, enemy.pos.y - me.pos.y);
          if (dist < bestDist && canSee(me, enemy.pos, segments)) {
            this.visibleTargetId = id;
            bestDist = dist;
          }
        }
      }
    }

    let target: PlayerState | null = this.visibleTargetId
      ? (gameState.players[this.visibleTargetId] ?? null)
      : null;
    if (target && target.hp <= 0) target = null;
    if (!target) this.visibleTargetId = null;

    if (target) {
      if (this.visibleTime === 0) this.reactionLeft = this.profile.reactionSec;
      this.visibleTime += dt;
      this.reactionLeft = Math.max(0, this.reactionLeft - dt);
      this.lastKnown = { x: target.pos.x, y: target.pos.y };
      this.searchLeft = 0;
    } else {
      this.visibleTime = 0;
    }
    return target;
  }

  private noticeEnemyAt(pos: Vec2): void {
    if (this.visibleTime > 0) return; // eyes beat ears
    this.lastKnown = { x: pos.x, y: pos.y };
    this.searchLeft = 0;
  }

  private transition(me: PlayerState, target: PlayerState | null): void {
    const hpFrac = me.hp / PLAYER_MAX_HP;
    let next: BotState;
    if (this.profile.retreatHpFrac > 0 && hpFrac <= this.profile.retreatHpFrac && this.lastKnown) {
      next = 'retreat';
    } else if (target) {
      next = 'engage';
    } else if (this.lastKnown) {
      next = 'hunt';
    } else {
      next = 'patrol';
    }
    if (next !== this.state) {
      this.state = next;
      this.clearPath();
      if (next === 'engage') this.strafeLeft = 0;
      // Lead fully lost: allow flashing the next corner we get a lead on.
      if (next === 'patrol') this.flashedLead = null;
    }
  }

  // --- Behaviors --------------------------------------------------------

  private doEngage(me: PlayerState, target: PlayerState, cmd: InputCommand, dt: number): void {
    const dx = target.pos.x - me.pos.x;
    const dy = target.pos.y - me.pos.y;
    const dist = Math.hypot(dx, dy);

    // Aim: at the target, plus a gaussian error that shrinks with focus.
    this.aimJitterLeft -= dt;
    if (this.aimJitterLeft <= 0) {
      this.aimJitterLeft = BOT_AIM_JITTER_SEC;
      const focus = Math.min(this.visibleTime / this.profile.aimFocusSec, 1);
      const sigmaDeg =
        this.profile.aimErrorDeg + (this.profile.aimErrorMinDeg - this.profile.aimErrorDeg) * focus;
      this.aimOffsetRad = this.gaussian() * sigmaDeg * DEG_TO_RAD;
    }
    cmd.aimAngle = Math.atan2(dy, dx) + this.aimOffsetRad;

    // Strafe perpendicular to the target; close in when out of range.
    this.strafeLeft -= dt;
    if (this.strafeLeft <= 0) {
      this.strafeLeft = BOT_STRAFE_MIN_SEC + this.rand() * (BOT_STRAFE_MAX_SEC - BOT_STRAFE_MIN_SEC);
      this.strafeDir = this.rand() < 0.5 ? -1 : 1;
    }
    const ux = dx / (dist || 1);
    const uy = dy / (dist || 1);
    let mx = -uy * this.strafeDir;
    let my = ux * this.strafeDir;
    if (dist > BOT_ENGAGE_RANGE_PX) {
      mx = mx * 0.5 + ux;
      my = my * 0.5 + uy;
    }
    const len = Math.hypot(mx, my) || 1;
    cmd.moveX = mx / len;
    cmd.moveY = my / len;

    this.fireControl(me, dist, cmd, dt);
  }

  private doHunt(me: PlayerState, cmd: InputCommand, dt: number): void {
    if (!this.lastKnown) return;

    const distToLead = Math.hypot(this.lastKnown.x - me.pos.x, this.lastKnown.y - me.pos.y);
    if (this.searchLeft > 0 || distToLead <= BOT_WAYPOINT_REACHED_PX * 2) {
      // Arrived: stand and sweep the cone around before giving up.
      if (this.searchLeft <= 0) {
        this.searchLeft = BOT_SEARCH_SEC;
        this.searchAngle = me.angle;
      }
      this.searchLeft -= dt;
      this.searchAngle += BOT_SEARCH_TURN_RATE * dt;
      cmd.aimAngle = this.searchAngle;
      if (this.searchLeft <= 0) this.lastKnown = null;
      return;
    }

    this.navigate(me, this.lastKnown, cmd, dt);
  }

  private doRetreat(me: PlayerState, target: PlayerState | null, cmd: InputCommand, dt: number): void {
    const threat = this.lastKnown!;
    // Fall back to the roam point farthest from the threat.
    let best: Vec2 | null = null;
    let bestDist = -1;
    for (const p of this.roamPoints) {
      const d = Math.hypot(p.x - threat.x, p.y - threat.y);
      if (d > bestDist) {
        bestDist = d;
        best = p;
      }
    }
    if (best) {
      // Reaching safety ends the retreat — forget the threat and get back to
      // the objective, or a wounded bot would hide for the rest of the round.
      if (!target && Math.hypot(best.x - me.pos.x, best.y - me.pos.y) <= BOT_WAYPOINT_REACHED_PX * 2) {
        this.lastKnown = null;
        return;
      }
      this.navigate(me, best, cmd, dt);
    }

    // Keep shooting over the shoulder while falling back.
    if (target) {
      const dx = target.pos.x - me.pos.x;
      const dy = target.pos.y - me.pos.y;
      cmd.aimAngle = Math.atan2(dy, dx) + this.aimOffsetRad;
      this.fireControl(me, Math.hypot(dx, dy), cmd, dt);
    }
  }

  private doPatrol(me: PlayerState, cmd: InputCommand, dt: number): void {
    if (this.objective) {
      this.doObjective(me, this.objective, cmd, dt);
      return;
    }
    if (!this.pathGoal || this.arrived()) {
      const goal = this.pickRoamPoint(me.pos);
      if (goal) this.setPath(me, goal);
    }
    this.followPath(me, cmd, dt);
  }

  /** Travel to the objective, then plant/defuse or stand guard sweeping. */
  private doObjective(me: PlayerState, obj: BotObjective, cmd: InputCommand, dt: number): void {
    const dist = Math.hypot(obj.pos.x - me.pos.x, obj.pos.y - me.pos.y);
    if (dist > obj.radiusPx) {
      this.onStation = false;
      this.navigate(me, obj.pos, cmd, dt);
      return;
    }
    if (!this.onStation) {
      this.onStation = true;
      this.guardAngle = me.angle;
      this.clearPath();
    }
    if (obj.holdUse) {
      // Stand still (plant/defuse progress cancels on movement) and hold E.
      cmd.aimAngle = dist > 1 ? Math.atan2(obj.pos.y - me.pos.y, obj.pos.x - me.pos.x) : me.angle;
      cmd.buttons |= Buttons.Use;
    } else {
      this.guardAngle += BOT_GUARD_TURN_RATE * dt;
      cmd.aimAngle = this.guardAngle;
    }
  }

  // --- Grenades ---------------------------------------------------------

  /**
   * Decide and carry out grenade throws. Returns true while a throw is winding
   * up (the bot stands still, faces the target, holds then releases the key),
   * so the caller skips normal movement/fire. Throws are never blind: a plan is
   * committed only if a dry-run of the deterministic grenade sim lands within
   * BOT_THROW_TOLERANCE_PX of the intended target — otherwise the bot keeps the
   * nade rather than lob it into a wall.
   */
  private stepGrenades(gameState: GameState, me: PlayerState, cmd: InputCommand, dt: number): boolean {
    this.throwCooldown = Math.max(0, this.throwCooldown - dt);
    this.planCooldown = Math.max(0, this.planCooldown - dt);
    if (!this.profile.usesUtility) return false;

    if (this.pendingThrow) {
      this.executePendingThrow(cmd);
      return true;
    }
    if (this.throwCooldown > 0 || this.planCooldown > 0 || this.blindLeft > 0) return false;
    if (me.fireCooldown > 0) return false; // mid gun-cooldown: the sim won't start a charge

    this.planCooldown = BOT_THROW_REPLAN_SEC; // bound the dry-run cost
    const plan = this.considerThrow(gameState, me, dt);
    if (!plan) return false;
    this.pendingThrow = { ...plan, ticksHeld: 0 };
    this.executePendingThrow(cmd);
    return true;
  }

  /** Hold the throw key steady for holdTicks, then release (spawns the nade). */
  private executePendingThrow(cmd: InputCommand): void {
    const t = this.pendingThrow!;
    cmd.moveX = 0;
    cmd.moveY = 0;
    cmd.aimAngle = t.angle;
    if (t.ticksHeld < t.holdTicks) {
      cmd.buttons |= THROW_BUTTON[t.type];
      t.ticksHeld++;
      return;
    }
    // Release tick: leave the throw bit clear so the sim launches the grenade.
    this.pendingThrow = null;
    this.throwCooldown = BOT_GRENADE_COOLDOWN_SEC;
    if (t.type === 'flash') {
      // Don't peek into our own flash — hold before advancing so it pops first.
      this.reactionLeft = Math.max(this.reactionLeft, BOT_THROW_PREPUSH_DELAY_SEC);
    }
  }

  /** Pick the most useful throw available right now, or null. */
  private considerThrow(
    gameState: GameState,
    me: PlayerState,
    dt: number,
  ): Omit<PendingThrow, 'ticksHeld'> | null {
    const g = me.grenades;

    // 1) Smoke an executing bombsite that isn't smoked yet (T attackers, while
    //    approaching — never mid-fight).
    if (this.state === 'patrol' && me.team === 'T' && g.includes('smoke') && this.objective && !this.objective.holdUse) {
      const site = this.objective.pos;
      const d = Math.hypot(site.x - me.pos.x, site.y - me.pos.y);
      if (d > 90 && d < BOT_SMOKE_SETUP_RANGE_PX && !this.smokeCovers(gameState, site)) {
        const plan = this.planThrow(me, 'smoke', site, dt);
        if (plan) return plan;
      }
    }

    // 2) Flash a known enemy corner before pushing it (lost sight = hunt).
    if (this.state === 'hunt' && this.lastKnown && g.includes('flash')) {
      const d = Math.hypot(this.lastKnown.x - me.pos.x, this.lastKnown.y - me.pos.y);
      if (
        d > BOT_FLASH_MIN_DIST_PX &&
        d < BOT_FLASH_MAX_DIST_PX &&
        !this.sameSpot(this.flashedLead, this.lastKnown)
      ) {
        const plan = this.planThrow(me, 'flash', this.lastKnown, dt);
        if (plan) {
          this.flashedLead = { x: this.lastKnown.x, y: this.lastKnown.y };
          return plan;
        }
      }
    }

    // 3) HE a known enemy position (never on top of ourselves).
    if (this.state === 'hunt' && this.lastKnown && g.includes('he')) {
      const d = Math.hypot(this.lastKnown.x - me.pos.x, this.lastKnown.y - me.pos.y);
      if (d > HE_RADIUS_PX * 0.8 && d < BOT_HE_MAX_DIST_PX) {
        const plan = this.planThrow(me, 'he', this.lastKnown, dt);
        if (plan) return plan;
      }
    }

    return null;
  }

  /**
   * Dry-run the grenade sim for a handful of charge levels (both the overhand
   * arc and the flat roll), aimed straight at `target`, and return the throw
   * whose landing spot is nearest — but only if it lands within tolerance (and,
   * for HE, not on top of the bot). Null = nothing lands well enough.
   */
  private planThrow(
    me: PlayerState,
    type: GrenadeType,
    target: Vec2,
    dt: number,
  ): Omit<PendingThrow, 'ticksHeld'> | null {
    const angle = Math.atan2(target.y - me.pos.y, target.x - me.pos.x);
    let best: { d: number; holdTicks: number; end: Vec2 } | null = null;
    for (const flat of [false, true]) {
      for (const charge of BOT_THROW_CHARGE_STEPS) {
        const speed = grenadeChargeSpeed(charge, dt);
        const path = predictGrenadePath(me.pos, angle, type, this.map, dt, flat, speed);
        const end = path[path.length - 1];
        const d = Math.hypot(end.x - target.x, end.y - target.y);
        // holdTicks = charge + 1: the sim's chargeTicks lands on `charge`.
        if (!best || d < best.d) best = { d, holdTicks: charge + 1, end };
      }
    }
    if (!best || best.d > BOT_THROW_TOLERANCE_PX) return null;
    if (type === 'he' && Math.hypot(best.end.x - me.pos.x, best.end.y - me.pos.y) < HE_RADIUS_PX * 0.8) {
      return null;
    }
    return { type, angle, holdTicks: best.holdTicks, target: { x: best.end.x, y: best.end.y } };
  }

  private smokeCovers(gameState: GameState, pt: Vec2): boolean {
    return gameState.smokes.some((s) => Math.hypot(s.pos.x - pt.x, s.pos.y - pt.y) < SMOKE_RADIUS_PX);
  }

  private sameSpot(a: Vec2 | null, b: Vec2 | null): boolean {
    return !!a && !!b && Math.hypot(a.x - b.x, a.y - b.y) < 48;
  }

  // --- Firing -----------------------------------------------------------

  /** Burst discipline: fire burstSec, pause burstPauseSec, repeat. */
  private fireControl(me: PlayerState, dist: number, cmd: InputCommand, dt: number): void {
    if (this.reactionLeft > 0) return;
    const def = WEAPONS[me.slots[me.activeSlot].weaponId];
    if (dist - PLAYER_RADIUS > def.maxRangePx) return;

    if (this.burstLeft > 0) {
      this.burstLeft -= dt;
      cmd.buttons |= Buttons.Shoot;
      if (this.burstLeft <= 0) this.burstPause = this.profile.burstPauseSec;
    } else {
      this.burstPause -= dt;
      if (this.burstPause <= 0) this.burstLeft = this.profile.burstSec;
    }
  }

  /** Reload when empty (or topping up while quiet); drop to pistol when dry. */
  private manageWeapon(me: PlayerState, target: PlayerState | null, cmd: InputCommand): void {
    const slot = me.slots[me.activeSlot];
    const def = WEAPONS[slot.weaponId];
    if (def.magSize === 0) return;
    if (slot.magAmmo === 0 && slot.reserveAmmo === 0) {
      cmd.buttons |= Buttons.SelectSecondary;
      return;
    }
    if (slot.magAmmo === 0 || (!target && slot.magAmmo < def.magSize / 2)) {
      cmd.buttons |= Buttons.Reload;
    }
  }

  // --- Navigation -------------------------------------------------------

  /** Path to `goal`, repathing when it moves, on a timer, or when stuck. */
  private navigate(me: PlayerState, goal: Vec2, cmd: InputCommand, dt: number): void {
    this.repathTimer -= dt;
    const goalMoved =
      !this.pathGoal || Math.hypot(goal.x - this.pathGoal.x, goal.y - this.pathGoal.y) > 48;
    if (goalMoved || (this.repathTimer <= 0 && !this.arrived())) {
      this.setPath(me, goal);
    }
    this.followPath(me, cmd, dt);
  }

  private setPath(me: PlayerState, goal: Vec2): void {
    const raw = findPath(this.map.grid, me.pos, goal);
    if (raw) {
      // Smooth from the bot's own position, then drop it back off the path.
      this.path = smoothPath([{ x: me.pos.x, y: me.pos.y }, ...raw], this.map.segments, PLAYER_RADIUS).slice(1);
    } else {
      this.path = [];
    }
    this.pathIndex = 0;
    this.pathGoal = { x: goal.x, y: goal.y };
    this.repathTimer = BOT_REPATH_SEC;
    this.stuckTimer = 0;
    this.progressPos = { x: me.pos.x, y: me.pos.y };
  }

  private clearPath(): void {
    this.path = [];
    this.pathIndex = 0;
    this.pathGoal = null;
  }

  private arrived(): boolean {
    return this.pathIndex >= this.path.length;
  }

  private followPath(me: PlayerState, cmd: InputCommand, dt: number): void {
    while (
      this.pathIndex < this.path.length &&
      Math.hypot(this.path[this.pathIndex].x - me.pos.x, this.path[this.pathIndex].y - me.pos.y) <=
        BOT_WAYPOINT_REACHED_PX
    ) {
      this.pathIndex++;
    }
    if (this.arrived()) return;

    const wp = this.path[this.pathIndex];
    const dx = wp.x - me.pos.x;
    const dy = wp.y - me.pos.y;
    const len = Math.hypot(dx, dy) || 1;
    cmd.moveX = dx / len;
    cmd.moveY = dy / len;
    cmd.aimAngle = Math.atan2(dy, dx); // face where you're going

    // Stuck detection: no progress → force a repath next navigate/patrol.
    this.stuckTimer += dt;
    if (Math.hypot(me.pos.x - this.progressPos.x, me.pos.y - this.progressPos.y) > 12) {
      this.progressPos = { x: me.pos.x, y: me.pos.y };
      this.stuckTimer = 0;
    } else if (this.stuckTimer >= BOT_STUCK_SEC) {
      if (this.pathGoal && this.state !== 'patrol') this.setPath(me, this.pathGoal);
      else this.clearPath();
      this.stuckTimer = 0;
    }
  }

  private pickRoamPoint(from: Vec2): Vec2 | null {
    if (this.roamPoints.length === 0) return null;
    // Prefer somewhere actually elsewhere; give up after a few rolls.
    for (let i = 0; i < 4; i++) {
      const p = this.roamPoints[Math.floor(this.rand() * this.roamPoints.length)];
      if (Math.hypot(p.x - from.x, p.y - from.y) > 200) return p;
    }
    return this.roamPoints[Math.floor(this.rand() * this.roamPoints.length)];
  }

  // --- RNG (per-bot xorshift so headless runs are reproducible) ---------

  private rand(): number {
    let x = this.rngState | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x | 0;
    return (x >>> 0) / 4294967296;
  }

  /** Standard normal via Box-Muller. */
  private gaussian(): number {
    const u = Math.max(this.rand(), 1e-9);
    const v = this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}
