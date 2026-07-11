// Bot brain (Phase 6). Pure TypeScript on top of core/ — no Phaser. Each
// tick it produces one InputCommand, exactly like a keyboard does; only
// core/simulation.applyInput() ever moves the bot.
import { Buttons } from '../../core/types';
import type { GameState, InputCommand, PlayerState, SimEvent, Vec2 } from '../../core/types';
import type { MapData } from '../../core/map';
import { canSee } from '../../core/vision';
import { findPath, smoothPath } from '../../core/pathfinding';
import {
  BOT_AIM_JITTER_SEC,
  BOT_ENGAGE_RANGE_PX,
  BOT_FOOTSTEP_MIN_SPEED,
  BOT_REPATH_SEC,
  BOT_SEARCH_SEC,
  BOT_SEARCH_TURN_RATE,
  BOT_STRAFE_MAX_SEC,
  BOT_STRAFE_MIN_SEC,
  BOT_STUCK_SEC,
  BOT_WAYPOINT_REACHED_PX,
  PLAYER_MAX_HP,
  PLAYER_RADIUS,
  WEAPONS,
} from '../../core/config';
import type { BotProfile } from '../../core/config';

export type BotState = 'patrol' | 'engage' | 'hunt' | 'retreat';

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

  private rngState: number;

  constructor(
    readonly id: string,
    private readonly enemyIds: string[],
    private readonly profile: BotProfile,
    private readonly map: MapData,
    /** Points the bot roams between while it has nothing better to do. */
    private readonly roamPoints: Vec2[],
    seed: number,
  ) {
    this.rngState = seed | 0 || 1;
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
    this.visibleTime = 0;
    this.reactionLeft = 0;
    this.burstLeft = 0;
    this.burstPause = 0;
    this.searchLeft = 0;
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
  get debugInfo(): { state: BotState; path: Vec2[]; pathIndex: number; lastKnown: Vec2 | null } {
    return { state: this.state, path: this.path, pathIndex: this.pathIndex, lastKnown: this.lastKnown };
  }

  // --- Perception -----------------------------------------------------

  /** Nearest visible enemy (bot vision = same cone/LOS rules as the player). */
  private perceive(gameState: GameState, me: PlayerState, dt: number): PlayerState | null {
    let target: PlayerState | null = null;
    let bestDist = Infinity;
    for (const id of this.enemyIds) {
      const enemy = gameState.players[id];
      if (!enemy || enemy.hp <= 0) continue;
      const dist = Math.hypot(enemy.pos.x - me.pos.x, enemy.pos.y - me.pos.y);

      // Hearing: running footsteps give away position without LOS.
      const speed = Math.hypot(enemy.vel.x, enemy.vel.y);
      if (speed >= BOT_FOOTSTEP_MIN_SPEED && dist <= this.profile.hearingRangePx) {
        this.noticeEnemyAt(enemy.pos);
      }

      if (dist < bestDist && canSee(me, enemy.pos, this.map.segments)) {
        target = enemy;
        bestDist = dist;
      }
    }

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
    if (best) this.navigate(me, best, cmd, dt);

    // Keep shooting over the shoulder while falling back.
    if (target) {
      const dx = target.pos.x - me.pos.x;
      const dy = target.pos.y - me.pos.y;
      cmd.aimAngle = Math.atan2(dy, dx) + this.aimOffsetRad;
      this.fireControl(me, Math.hypot(dx, dy), cmd, dt);
    }
  }

  private doPatrol(me: PlayerState, cmd: InputCommand, dt: number): void {
    if (!this.pathGoal || this.arrived()) {
      const goal = this.pickRoamPoint(me.pos);
      if (goal) this.setPath(me, goal);
    }
    this.followPath(me, cmd, dt);
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
