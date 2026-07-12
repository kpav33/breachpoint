// Online client (Phase 9a pipe + 9b netcode quality):
//
// - Client-side prediction: our own player runs the same core/simulation
//   locally the moment input is sampled — movement feels instant.
// - Server reconciliation: snapshots carry the last input tick the server
//   applied; we rewind to the authoritative state and replay unacked inputs.
// - Entity interpolation: everyone else renders INTERP_DELAY_MS in the past,
//   lerped between the two surrounding snapshots.
// - Lag compensation: each input reports the interpolated server tick we
//   were rendering (viewTick); the server rewinds targets to it for shots.
//
// Everything presentational (fog, effects, audio, HUD, banners) is inherited
// unchanged from GameScene.
import type { Room } from 'colyseus.js';
import { INTERP_DELAY_MS, TICK_RATE } from '../core/config';
import { Buttons } from '../core/types';
import type { GameState, InputCommand, PlayerState } from '../core/types';
import { applyInput, createGameState } from '../core/simulation';
import { GameScene } from './GameScene';
import type { GameConfig } from './MenuScene';
import { movementFrozen } from '../match/MatchState';
import type { BuyItem } from '../match/MatchState';
import { hostPrivate, joinByCode, quickPlay } from '../net/NetClient';
import { MSG_BUY, MSG_INPUT, MSG_SNAPSHOT, MSG_WELCOME } from '../net/protocol';
import type { InputMessage, Snapshot, Welcome } from '../net/protocol';
import { PlayerView } from '../game/entities/PlayerView';
import { loadMap } from '../game/map/MapLoader';
import { FONT_DATA, FONT_DISPLAY, TEXT_1, TEXT_3 } from '../game/theme';

const FIXED_DT = 1 / TICK_RATE;

/** How this client connects — chosen in the lobby. */
export type JoinSpec =
  | { mode: 'quick' }
  | { mode: 'host' }
  | { mode: 'code'; roomId: string };

/** Scene-start payload for the online game (extends the offline GameConfig). */
export interface OnlineInit extends Partial<GameConfig> {
  join?: JoinSpec;
  /** Player display name. */
  name?: string;
}

/** Buttons that client prediction may apply. Everything else (firing,
 * reloading, throws, weapon switches) stays server-authoritative so we never
 * double-fire effects or desync ammo — only movement/aim are predicted. */
const PREDICT_BUTTONS = Buttons.Walk;

/** Positions extracted from one snapshot, kept for interpolation. */
interface BufferEntry {
  atMs: number;
  tick: number;
  players: Record<string, { x: number; y: number; angle: number; hp: number }>;
  projectiles: Record<number, { x: number; y: number }>;
}

function lerpAngle(a: number, b: number, t: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * t;
}

export class OnlineGameScene extends GameScene {
  private room: Room | null = null;
  /** Snapshots received since the last frame, stamped at arrival. */
  private pending: { atMs: number; snap: Snapshot }[] = [];
  /** Recent snapshot positions for entity interpolation (~1s). */
  private snapBuffer: BufferEntry[] = [];
  /** Inputs sent but not yet acknowledged by a snapshot. */
  private pendingInputs: InputCommand[] = [];
  /** Locally simulated copy of our own player (prediction target). */
  private predicted: PlayerState | null = null;
  /** Scratch GameState so applyInput can run on the predicted player. */
  private predictScratch: GameState = createGameState();
  /** Interpolated server tick currently on screen — sent as lag-comp basis. */
  private viewTick = 0;
  private welcomed = false;
  private connectionError: string | null = null;
  private disconnectedNoticeShown = false;
  private statusText: Phaser.GameObjects.Text | null = null;
  private statusSub: Phaser.GameObjects.Text | null = null;
  /** Persistent "share this code" label (top-left). */
  private codeLabel: Phaser.GameObjects.Text | null = null;
  /** Client-side input sequence number (the server tick is authoritative). */
  private sendTick = 0;
  private joinSpec: JoinSpec = { mode: 'quick' };
  private playerName = 'Player';

  constructor() {
    super('OnlineGame');
  }

  init(data: OnlineInit): void {
    super.init(data);
    this.joinSpec = data.join ?? { mode: 'quick' };
    this.playerName = data.name?.trim() || 'Player';
    this.room = null;
    this.pending = [];
    this.snapBuffer = [];
    this.pendingInputs = [];
    this.predicted = null;
    this.predictScratch = createGameState();
    this.viewTick = 0;
    this.welcomed = false;
    this.connectionError = null;
    this.disconnectedNoticeShown = false;
    this.statusText = null;
    this.statusSub = null;
    this.codeLabel = null;
    this.sendTick = 0;
  }

  create(): void {
    const w = this.scale.width;
    const h = this.scale.height;
    this.statusText = this.add
      .text(w / 2, h / 2 - 10, 'CONNECTING…', {
        fontFamily: FONT_DISPLAY,
        fontSize: '28px',
        fontStyle: '700',
        color: TEXT_1,
      })
      .setOrigin(0.5);
    this.statusSub = this.add
      .text(w / 2, h / 2 + 24, 'ESC — back to menu', {
        fontFamily: FONT_DATA,
        fontSize: '12px',
        fontStyle: '500',
        color: TEXT_3,
      })
      .setOrigin(0.5);

    this.input.keyboard?.on('keydown-ESC', () => {
      if (!this.worldReady) {
        this.scene.stop();
        this.scene.start('Menu');
      }
    });
    // Leaving the scene (quit to menu) leaves the room.
    this.events.once('shutdown', () => {
      void this.room?.leave();
      this.room = null;
    });

    void this.connect();
  }

  private async connect(): Promise<void> {
    const options = {
      mapKey: this.config.mapKey,
      roundsToWin: this.config.roundsToWin,
      name: this.playerName,
    };
    try {
      const room =
        this.joinSpec.mode === 'host'
          ? await hostPrivate(options)
          : this.joinSpec.mode === 'code'
            ? await joinByCode(this.joinSpec.roomId, options)
            : await quickPlay(options);
      if (!this.scene.isActive()) {
        void room.leave();
        return;
      }
      this.room = room;
      this.showRoomCode(room.roomId);
      room.onMessage(MSG_WELCOME, (w: Welcome) => {
        this.humanId = w.playerId;
        this.config.mapKey = w.mapKey;
        this.welcomed = true;
      });
      room.onMessage(MSG_SNAPSHOT, (s: Snapshot) =>
        this.pending.push({ atMs: performance.now(), snap: s }),
      );
      room.onError((code, message) => {
        this.connectionError = message ?? `room error ${code}`;
      });
      room.onLeave(() => {
        this.room = null;
      });
    } catch (err) {
      this.connectionError = err instanceof Error ? err.message : String(err);
    }
  }

  /** Persistent top-left label so any player can share the room code. */
  private showRoomCode(roomId: string): void {
    this.codeLabel?.destroy();
    this.codeLabel = this.add
      .text(12, 10, `ROOM CODE  ${roomId}`, {
        fontFamily: FONT_DATA,
        fontSize: '12px',
        fontStyle: '600',
        color: TEXT_3,
      })
      .setScrollFactor(0)
      .setDepth(700);
  }

  update(time: number, delta: number): void {
    if (!this.worldReady) {
      this.bootstrapWhenReady();
      return;
    }
    // Kicked/removed server-side while the socket lives: treat as disconnect.
    if (!this.state.players[this.humanId]) {
      this.showDisconnected();
      return;
    }
    super.update(time, delta);
    if (this.room === null) this.showDisconnected();
  }

  /** World setup happens on the first snapshot: we need the roster to exist. */
  private bootstrapWhenReady(): void {
    if (this.connectionError && this.statusText) {
      this.statusText.setText('CONNECTION FAILED');
      this.statusSub?.setText(`${this.connectionError} · ESC — back to menu`);
      return;
    }
    if (!this.welcomed || this.pending.length === 0) return;

    this.ingestSnapshots();
    this.map = loadMap(this, this.config.mapKey).data;
    this.views = {};
    this.syncRoster();
    this.createPresentation();
    this.statusText?.destroy();
    this.statusSub?.destroy();
    this.statusText = null;
    this.statusSub = null;
  }

  /**
   * Replaces local simulation: adopt authoritative snapshots (reconciling
   * our predicted player), sample + send + locally predict our inputs at
   * TICK_RATE, then pose everyone else at the interpolated past.
   */
  protected advanceSimulation(dtSec: number): void {
    this.ingestSnapshots();
    if (!this.room) return;

    this.accumulator += dtSec;
    while (this.accumulator >= FIXED_DT) {
      this.predictTick();
      this.accumulator -= FIXED_DT;
    }

    this.overlayInterpolated();
  }

  /** Adopt the latest snapshot wholesale; merge event deltas so none are lost. */
  private ingestSnapshots(): void {
    if (this.pending.length === 0) return;
    const simEvents = this.pending.flatMap((p) => p.snap.game.events);
    const matchEvents = this.pending.flatMap((p) => p.snap.match.events);

    for (const { atMs, snap } of this.pending) {
      const entry: BufferEntry = { atMs, tick: snap.game.tick, players: {}, projectiles: {} };
      for (const p of Object.values(snap.game.players)) {
        entry.players[p.id] = { x: p.pos.x, y: p.pos.y, angle: p.angle, hp: p.hp };
      }
      for (const g of snap.game.projectiles) {
        entry.projectiles[g.id] = { x: g.pos.x, y: g.pos.y };
      }
      this.snapBuffer.push(entry);
    }
    while (this.snapBuffer.length > 40) this.snapBuffer.shift();

    const last = this.pending[this.pending.length - 1].snap;
    this.pending = [];

    this.state = last.game;
    this.state.events = simEvents;
    this.match = last.match;
    this.match.events = matchEvents;
    this.names = last.names;

    this.reconcile(last);
    if (this.worldReady) this.syncRoster();
  }

  /**
   * Server reconciliation: start from the authoritative copy of our player,
   * drop inputs the server has applied, replay the rest through the same
   * simulation. Ends exactly where prediction would have — unless the server
   * disagreed (collision, correction), in which case we adopt its truth.
   */
  private reconcile(snap: Snapshot): void {
    const serverMe = this.state.players[this.humanId];
    if (!serverMe) return;

    const ack = snap.acks[this.humanId] ?? -1;
    this.pendingInputs = this.pendingInputs.filter((c) => c.tick > ack);

    this.predicted = structuredClone(serverMe);
    for (const cmd of this.pendingInputs) this.applyPredicted(cmd);

    // Point the render state at the predicted player so everything downstream
    // (camera, fog, HUD) follows the responsive local copy.
    this.state.players[this.humanId] = this.predicted;
    this.prev[this.humanId] ??= {
      x: this.predicted.pos.x,
      y: this.predicted.pos.y,
      angle: this.predicted.angle,
    };
  }

  /** One client tick: sample input, send it, predict it locally. */
  private predictTick(): void {
    if (!this.predicted || !this.room) return;

    let cmd = this.inputSystem.sample(this.sendTick++, this.predicted.pos);
    // Mirror the server's freeze so prediction can't run where it won't.
    if (movementFrozen(this.match)) cmd = { ...cmd, moveX: 0, moveY: 0, buttons: 0 };

    const msg: InputMessage = { cmd, viewTick: Math.round(this.viewTick) };
    this.room.send(MSG_INPUT, msg);
    this.pendingInputs.push(cmd);
    if (this.pendingInputs.length > TICK_RATE * 2) this.pendingInputs.shift();

    this.prev[this.humanId] = {
      x: this.predicted.pos.x,
      y: this.predicted.pos.y,
      angle: this.predicted.angle,
    };
    this.applyPredicted(cmd);
  }

  /** Run one InputCommand through core/simulation for the predicted player. */
  private applyPredicted(cmd: InputCommand): void {
    if (!this.predicted) return;
    const masked = { ...cmd, buttons: cmd.buttons & PREDICT_BUTTONS };
    this.predictScratch.players = { [this.humanId]: this.predicted };
    applyInput(this.predictScratch, this.humanId, masked, this.map, FIXED_DT);
    this.predictScratch.events.length = 0;
  }

  /**
   * Entity interpolation: pose every remote player (and grenade) at
   * `now - INTERP_DELAY_MS`, lerped between the two surrounding snapshots.
   * Writes pos and prev together so the base renderer lands exactly there.
   */
  private overlayInterpolated(): void {
    const buf = this.snapBuffer;
    if (buf.length === 0) return;
    const renderMs = performance.now() - INTERP_DELAY_MS;

    const i1 = buf.findIndex((e) => e.atMs >= renderMs);
    let s0: BufferEntry;
    let s1: BufferEntry;
    if (i1 < 0) {
      // Starved: hold the newest snapshot.
      s0 = s1 = buf[buf.length - 1];
    } else if (i1 === 0) {
      s0 = s1 = buf[0];
    } else {
      s0 = buf[i1 - 1];
      s1 = buf[i1];
    }
    const span = s1.atMs - s0.atMs;
    const t = span > 0 ? (renderMs - s0.atMs) / span : 1;
    this.viewTick = s0.tick + (s1.tick - s0.tick) * t;

    for (const p of Object.values(this.state.players)) {
      if (p.id === this.humanId) continue; // predicted, not interpolated
      const a = s0.players[p.id];
      const b = s1.players[p.id];
      if (!a || !b) continue; // brand-new player: latest state stands
      p.pos.x = a.x + (b.x - a.x) * t;
      p.pos.y = a.y + (b.y - a.y) * t;
      p.angle = lerpAngle(a.angle, b.angle, t);
      this.prev[p.id] = { x: p.pos.x, y: p.pos.y, angle: p.angle };
    }

    for (const g of this.state.projectiles) {
      const a = s0.projectiles[g.id];
      const b = s1.projectiles[g.id];
      if (!a || !b) continue;
      g.pos.x = a.x + (b.x - a.x) * t;
      g.pos.y = a.y + (b.y - a.y) * t;
    }
  }

  /** Create/destroy PlayerViews as players join and leave the room. */
  private syncRoster(): void {
    this.tIds = [];
    this.ctIds = [];
    for (const p of Object.values(this.state.players)) {
      (p.team === 'T' ? this.tIds : this.ctIds).push(p.id);
      if (!this.views[p.id]) {
        this.views[p.id] = new PlayerView(this, p.pos.x, p.pos.y, p.team, p.id === this.humanId);
        this.views[p.id].setVisible(p.hp > 0);
        this.prev[p.id] = { x: p.pos.x, y: p.pos.y, angle: p.angle };
      }
    }
    for (const id of Object.keys(this.views)) {
      if (!this.state.players[id]) {
        this.views[id].destroy();
        delete this.views[id];
        delete this.prev[id];
      }
    }
  }

  /** Purchases are server-validated; the result arrives in the next snapshot. */
  buy(item: BuyItem): void {
    this.room?.send(MSG_BUY, item);
  }

  /** No local cheats online — keep the vision toggle and pause overlay only. */
  protected bindLoadoutCheats(): void {
    this.input.keyboard?.on('keydown-F5', () => (this.vision.fullCircle = !this.vision.fullCircle));
    this.bindPauseKey();
  }

  /** Online there's no roster to build locally — the server owns it. */
  protected buildRoster(): void {}

  private showDisconnected(): void {
    if (this.disconnectedNoticeShown) return;
    this.disconnectedNoticeShown = true;
    const w = this.scale.width;
    this.add
      .text(w / 2, 90, 'DISCONNECTED — ESC · QUIT TO MENU', {
        fontFamily: FONT_DISPLAY,
        fontSize: '20px',
        fontStyle: '700',
        color: TEXT_1,
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(700);
  }
}
