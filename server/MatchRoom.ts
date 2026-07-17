// Authoritative match room (Phase 9). Runs the exact same pure simulation
// the single-player GameScene runs — core/simulation + match/MatchState, and
// the shared bot brains from src/ai — on a fixed timestep. Humans feed
// InputCommands; empty slots are filled with server-run bots. Broadcasts
// full-state JSON snapshots at SNAPSHOT_RATE; clients predict/interpolate.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Room, updateLobby } from 'colyseus';
import type { Client } from 'colyseus';

import { Buttons } from '../src/core/types.ts';
import type { GameState, InputCommand, Team, Vec2 } from '../src/core/types.ts';
import {
  BOT_PROFILES,
  FLASH_BEHIND_MULT,
  FLASH_MAX_BLIND_SEC,
  FLASH_RANGE_PX,
  INPUT_HOLD_MAX_SEC,
  INPUT_QUEUE_MAX,
  LAG_COMP_MAX_REWIND_SEC,
  PERF_WINDOW_SEC,
  RECONNECT_GRACE_SEC,
  ROUNDS_TO_WIN,
  SNAPSHOT_RATE,
  START_MONEY,
  TEAM_SIZE,
  TICK_RATE,
  WARMUP_TIME_SEC,
} from '../src/core/config.ts';
import { applyInput, createGameState, createPlayer, stepWorld } from '../src/core/simulation.ts';
import { parseTiledMap } from '../src/core/map.ts';
import type { MapData, TiledMap } from '../src/core/map.ts';
import { canSee, smokeSegments } from '../src/core/vision.ts';
import {
  createMatchState,
  handlePlayerDisconnect,
  movementFrozen,
  tryBuy,
  trySell,
  updateMatch,
} from '../src/match/MatchState.ts';
import type { BuyItem, MatchState } from '../src/match/MatchState.ts';
import { BotController } from '../src/ai/BotController.ts';
import { assignBotObjectives, buildBotWorld } from '../src/ai/objectives.ts';
import type { BotWorld } from '../src/ai/objectives.ts';
import {
  MSG_BUY,
  MSG_CHAT,
  MSG_CHAT_MSG,
  MSG_INPUT,
  MSG_PING,
  MSG_PONG,
  MSG_SNAPSHOT,
  MSG_WELCOME,
  PROTOCOL_VERSION,
} from '../src/net/protocol.ts';
import type {
  ChatMessage,
  InputMessage,
  JoinOptions,
  Ping,
  RoomMetadata,
  ServerPerf,
  Snapshot,
  Welcome,
} from '../src/net/protocol.ts';

const FIXED_DT = 1 / TICK_RATE;
/** Cap a hitching event-loop delta so the accumulator can't spiral. */
const MAX_TICK_DELTA_MS = 250;
const DEFAULT_MAP = 'de_yard';
/** Each team is kept at this size; bots fill whatever humans don't. */
const TEAM_TARGET = TEAM_SIZE;
/** Ticks of input silence before a repeated command decays to idle. */
const INPUT_HOLD_MAX_TICKS = Math.round(TICK_RATE * INPUT_HOLD_MAX_SEC);

const MAPS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../public/assets/maps');

/** Chat limits: length clamp + sliding-window rate limit per client. */
const CHAT_MAX_LEN = 96;
const CHAT_WINDOW_MS = 4000;
const CHAT_MAX_PER_WINDOW = 3;

/** Buttons that fire on key-down; never repeat them when reusing a stale command. */
const ONE_SHOT_BUTTONS =
  Buttons.Reload |
  Buttons.SelectMelee |
  Buttons.SelectSecondary |
  Buttons.SelectPrimary |
  Buttons.NextWeapon |
  Buttons.PrevWeapon |
  Buttons.ThrowHE |
  Buttons.ThrowFlash |
  Buttons.ThrowSmoke |
  Buttons.Drop;

function loadMapData(mapKey: string): MapData {
  const file = join(MAPS_DIR, `${mapKey}.json`);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as TiledMap;
  return parseTiledMap(raw);
}

function idleCommand(): InputCommand {
  return { tick: 0, moveX: 0, moveY: 0, aimAngle: 0, buttons: 0 };
}

export class MatchRoom extends Room {
  maxClients = TEAM_TARGET * 2;

  private game!: GameState;
  private match!: MatchState;
  private map!: MapData;
  private mapKey = DEFAULT_MAP;
  private matchName = 'Match';
  private names: Record<string, string> = { bomb: 'the bomb' };
  /** Last RTT each human reported via MSG_PING, ms (for scoreboards). */
  private pings: Record<string, number> = {};
  /** Recent chat timestamps per client (rate limiting). */
  private chatStamps = new Map<string, number[]>();
  /** Buffered inputs per player, applied one per tick (oldest first). */
  private queues = new Map<string, InputMessage[]>();
  /** Last applied command per player — reused (minus one-shots) when the buffer runs dry. */
  private lastCmd = new Map<string, InputCommand>();
  /** Consecutive ticks each player's command has been a repeat (no real input). */
  private repeatTicks = new Map<string, number>();
  /** `cmd.tick` of the last real (non-repeated) input applied — the ack. */
  private lastInputTick = new Map<string, number>();
  /** Last viewTick each player reported (reused for repeated commands). */
  private lastViewTick = new Map<string, number>();
  /** Post-tick position history ring for lag-compensated hit resolution. */
  private history: { tick: number; pos: Map<string, Vec2> }[] = [];

  // Bots (server-run, filling empty slots) + their shared world data.
  private bots: Record<string, BotController> = {};
  private botWorld!: BotWorld;
  private readonly botProfile = BOT_PROFILES.normal;
  private botCounter = 0;
  private tIds: string[] = [];
  private ctIds: string[] = [];

  private joinCounter = 0;
  private accumulator = 0;
  private snapshotAcc = 0;

  // Tick instrumentation (Phase 9.5): rolling PERF_WINDOW_SEC stats, so a
  // tick-budget overrun is distinguishable from network lag on the client.
  private perf: ServerPerf = { tickMs: 0, tickMsMax: 0, botMs: 0, tps: 0 };
  private perfTickMsSum = 0;
  private perfTickMsMax = 0;
  private perfBotMsSum = 0;
  private perfTicks = 0;
  private perfWindowStart = performance.now();
  private perfLogAcc = 0;
  /** Bot-brain time inside the current step(), accumulated by step itself. */
  private botMsThisTick = 0;

  onCreate(options: JoinOptions): void {
    if (
      typeof options.mapKey === 'string' &&
      /^[a-z0-9_]+$/.test(options.mapKey) &&
      existsSync(join(MAPS_DIR, `${options.mapKey}.json`))
    ) {
      this.mapKey = options.mapKey;
    }
    this.map = loadMapData(this.mapKey);
    this.botWorld = buildBotWorld(this.map);
    this.game = createGameState((Math.random() * 0xffffffff) >>> 0);
    const roundsToWin =
      typeof options.roundsToWin === 'number' && options.roundsToWin >= 1 && options.roundsToWin <= 30
        ? Math.floor(options.roundsToWin)
        : ROUNDS_TO_WIN;
    this.match = createMatchState([], START_MONEY, roundsToWin);

    if (typeof options.name === 'string' && options.name.trim()) {
      this.matchName = options.name.trim().slice(0, 24);
    }
    if (options.private) this.setPrivate(true);

    // Start full of bots; humans replace them as they join.
    this.fillBots();
    this.rebuildRoster();
    this.publishMetadata();

    this.onMessage(MSG_INPUT, (client, cmd: unknown) => this.onInput(client, cmd));
    this.onMessage(MSG_BUY, (client, item: unknown) => this.onBuy(client, item));
    this.onMessage(MSG_PING, (client, msg: unknown) => this.onPing(client, msg));
    this.onMessage(MSG_CHAT, (client, msg: unknown) => this.onChat(client, msg));
    this.setSimulationInterval((dtMs) => this.tick(dtMs), 1000 / TICK_RATE);
    console.log(`room ${this.roomId} created — map ${this.mapKey}, first to ${roundsToWin}`);
  }

  onJoin(client: Client, options: JoinOptions): void {
    // Version handshake: client (CDN) and server deploy independently — a
    // stale client gets a clear error instead of silent wire-format desyncs.
    // (Reconnections skip onJoin, so held seats are unaffected.)
    if (options.protocol !== PROTOCOL_VERSION) {
      throw new Error(
        `client/server version mismatch (client ${options.protocol ?? 'none'}, server ${PROTOCOL_VERSION}) — refresh the page`,
      );
    }
    const id = client.sessionId;
    const team = this.smallerHumanTeam();
    // Take a bot's slot so the team stays at target size.
    if (this.teamSize(team) >= TEAM_TARGET) this.kickOneBot(team);

    const spawns = team === 'T' ? this.map.spawnsT : this.map.spawnsCT;
    const at = spawns[this.teamSize(team) % spawns.length];
    this.game.players[id] = createPlayer(id, team, at.x, at.y);
    this.match.stats[id] = { kills: 0, deaths: 0, money: START_MONEY, hasDefuseKit: false };
    const name =
      typeof options.name === 'string' && options.name.trim().length > 0
        ? options.name.trim().slice(0, 16)
        : `Player ${++this.joinCounter}`;
    this.names[id] = name;
    this.queues.set(id, []);
    // Humans always have a ping entry (0 until their first report) — the
    // scoreboard uses "no entry" to mean "bot".
    this.pings[id] = 0;

    // Mid-round joiners sit out until the next round respawns everyone.
    if (this.match.phase === 'live' || this.match.phase === 'round_end') {
      this.game.players[id].hp = 0;
    }

    this.rebuildRoster();
    this.publishMetadata();
    const welcome: Welcome = { playerId: id, mapKey: this.mapKey };
    client.send(MSG_WELCOME, welcome);
    console.log(`${name} (${id}) joined as ${team}`);
  }

  async onLeave(client: Client, consented?: boolean): Promise<void> {
    const id = client.sessionId;
    // Voluntary quit (ESC → menu) or match already over: clean up now.
    if (consented || this.match.phase === 'match_end' || !this.game.players[id]) {
      this.dropSeat(id);
      console.log(`${id} left`);
      return;
    }

    // Connection drop: hold the seat. The avatar dies in place (gun + bomb
    // drop), stats stay, and no bot backfills while the window is open.
    const name = this.names[id];
    handlePlayerDisconnect(this.match, this.game, id);
    this.names[id] = `${name} (dc)`;
    this.queues.set(id, []);
    this.lastCmd.delete(id);
    console.log(`${name} (${id}) disconnected — holding seat ${RECONNECT_GRACE_SEC}s`);

    try {
      const reconnected = await this.allowReconnection(client, RECONNECT_GRACE_SEC);
      this.names[id] = name;
      // onJoin does not run again — resend the welcome so a fresh page
      // (refresh flow) learns its player id and map.
      const welcome: Welcome = { playerId: id, mapKey: this.mapKey };
      reconnected.send(MSG_WELCOME, welcome);
      console.log(`${name} (${id}) reconnected`);
    } catch {
      this.dropSeat(id);
      console.log(`${id} left (grace expired)`);
    }
  }

  /** Final removal: free the slot and backfill a bot for the remaining humans. */
  private dropSeat(id: string): void {
    const team = this.game.players[id]?.team;
    this.removePlayer(id);
    if (team && this.humanCount() > 0 && this.teamSize(team) < TEAM_TARGET) {
      this.addBot(team);
    }
    this.rebuildRoster();
    this.publishMetadata();
  }

  // --- Roster / bot management -------------------------------------------

  /** Remove a player (human or bot) and all its bookkeeping; drops the bomb. */
  private removePlayer(id: string): void {
    const p = this.game.players[id];
    if (!p) return;
    if (this.match.bomb.carrierId === id) {
      this.match.bomb.carrierId = null;
      this.match.bomb.droppedAt = { x: p.pos.x, y: p.pos.y };
      this.match.events.push({ type: 'bomb_dropped', pos: { ...this.match.bomb.droppedAt } });
    }
    if (this.match.bomb.plant?.playerId === id) this.match.bomb.plant = null;
    if (this.match.bomb.defuse?.playerId === id) this.match.bomb.defuse = null;
    delete this.game.players[id];
    delete this.match.stats[id];
    delete this.names[id];
    delete this.bots[id];
    delete this.pings[id];
    this.queues.delete(id);
    this.lastCmd.delete(id);
    this.repeatTicks.delete(id);
    this.lastInputTick.delete(id);
    this.lastViewTick.delete(id);
  }

  /** Bring both teams up to target size with fresh bots. */
  private fillBots(): void {
    for (const team of ['T', 'CT'] as const) {
      while (this.teamSize(team) < TEAM_TARGET) this.addBot(team);
    }
  }

  private addBot(team: Team): void {
    const id = `bot${++this.botCounter}`;
    const spawns = team === 'T' ? this.map.spawnsT : this.map.spawnsCT;
    const at = spawns[this.teamSize(team) % spawns.length];
    this.game.players[id] = createPlayer(id, team, at.x, at.y);
    this.match.stats[id] = { kills: 0, deaths: 0, money: START_MONEY, hasDefuseKit: false };
    this.names[id] = `Bot ${this.botCounter}`;
    this.bots[id] = new BotController(
      id,
      [],
      this.botProfile,
      this.map,
      this.botWorld.roamPoints,
      (0x9e3779b9 ^ (this.botCounter * 40503)) >>> 0,
    );
    // A bot added mid-round sits out until the next round, like a human joiner.
    if (this.match.phase === 'live' || this.match.phase === 'round_end') {
      this.game.players[id].hp = 0;
    }
  }

  private kickOneBot(team: Team): boolean {
    for (const id of Object.keys(this.bots)) {
      if (this.game.players[id]?.team === team) {
        this.removePlayer(id);
        return true;
      }
    }
    return false;
  }

  /** Recompute team rosters and re-point every bot at its enemy list. */
  private rebuildRoster(): void {
    this.tIds = [];
    this.ctIds = [];
    for (const p of Object.values(this.game.players)) {
      (p.team === 'T' ? this.tIds : this.ctIds).push(p.id);
    }
    for (const id of this.tIds) this.bots[id]?.setEnemies(this.ctIds);
    for (const id of this.ctIds) this.bots[id]?.setEnemies(this.tIds);
  }

  private teamSize(team: Team): number {
    let n = 0;
    for (const p of Object.values(this.game.players)) if (p.team === team) n++;
    return n;
  }

  private humanCount(): number {
    let n = 0;
    for (const id of Object.keys(this.game.players)) if (!this.bots[id]) n++;
    return n;
  }

  /** The team with fewer humans (ties → T), so humans spread across sides. */
  private smallerHumanTeam(): Team {
    let t = 0;
    let ct = 0;
    for (const id of Object.keys(this.game.players)) {
      if (this.bots[id]) continue;
      if (this.game.players[id].team === 'T') t++;
      else ct++;
    }
    return t <= ct ? 'T' : 'CT';
  }

  /** Room-list metadata (drives the client lobby's room browser). */
  private publishMetadata(): void {
    const meta: RoomMetadata = {
      name: this.matchName,
      mapKey: this.mapKey,
      humans: this.humanCount(),
      capacity: this.maxClients,
      phase: this.match.phase,
      round: this.match.round,
    };
    // setMetadata alone doesn't notify LobbyRoom subscribers — join/leave/
    // dispose do, but metadata-only changes (round advancing) need the push.
    void this.setMetadata(meta).then(() => updateLobby(this));
  }

  private onInput(client: Client, msg: unknown): void {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as Record<string, unknown>;
    if (typeof m.cmd !== 'object' || m.cmd === null || typeof m.viewTick !== 'number') return;
    const c = m.cmd as Record<string, unknown>;
    if (
      typeof c.tick !== 'number' ||
      typeof c.moveX !== 'number' ||
      typeof c.moveY !== 'number' ||
      typeof c.aimAngle !== 'number' ||
      typeof c.buttons !== 'number' ||
      !Number.isFinite(c.moveX) ||
      !Number.isFinite(c.moveY) ||
      !Number.isFinite(c.aimAngle) ||
      !Number.isFinite(m.viewTick)
    ) {
      return;
    }
    const queue = this.queues.get(client.sessionId);
    if (!queue) return;
    // Never trust the client: clamp movement intent to unit range and coerce
    // buttons to a uint32 bitmask. Actual speed/fire-rate come from the sim.
    queue.push({
      cmd: {
        tick: Math.floor(c.tick),
        moveX: Math.max(-1, Math.min(1, c.moveX)),
        moveY: Math.max(-1, Math.min(1, c.moveY)),
        aimAngle: c.aimAngle,
        buttons: c.buttons >>> 0,
      },
      viewTick: Math.floor(m.viewTick),
    });
    // Bound the buffer so a flooding client can't grow it without limit.
    while (queue.length > INPUT_QUEUE_MAX) queue.shift();
  }

  private onBuy(client: Client, item: unknown): void {
    if (typeof item !== 'string') return;
    // Buy/refund toggle. tryBuy validates phase/zone/team/money/legality and
    // rejects unknown items; trySell only refunds items tryBuy recorded.
    if (!tryBuy(this.match, this.game, this.map, client.sessionId, item as BuyItem)) {
      trySell(this.match, this.game, this.map, client.sessionId, item as BuyItem);
    }
  }

  /** Echo the client's timestamp back verbatim; the client computes the RTT. */
  private onPing(client: Client, msg: unknown): void {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as Record<string, unknown>;
    if (typeof m.t !== 'number' || !Number.isFinite(m.t)) return;
    // Piggybacked self-reported RTT, clamped to a sane display range.
    if (typeof m.rtt === 'number' && Number.isFinite(m.rtt)) {
      this.pings[client.sessionId] = Math.min(999, Math.max(0, Math.round(m.rtt)));
    }
    const pong: Ping = { t: m.t };
    client.send(MSG_PONG, pong);
  }

  /** Validate, rate-limit and relay chat. Team chat only reaches teammates. */
  private onChat(client: Client, msg: unknown): void {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as Record<string, unknown>;
    if (typeof m.text !== 'string') return;
    // Strip control characters, collapse whitespace runs, clamp length.
    // eslint-disable-next-line no-control-regex
    const text = m.text.replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_LEN);
    if (!text) return;

    const id = client.sessionId;
    const sender = this.game.players[id];
    if (!sender) return;

    const now = Date.now();
    const stamps = (this.chatStamps.get(id) ?? []).filter((t) => now - t < CHAT_WINDOW_MS);
    if (stamps.length >= CHAT_MAX_PER_WINDOW) {
      this.chatStamps.set(id, stamps);
      return; // flooding: drop silently
    }
    stamps.push(now);
    this.chatStamps.set(id, stamps);

    const teamOnly = m.team === true;
    const out: ChatMessage = { name: this.names[id], team: sender.team, text, teamOnly };
    if (teamOnly) {
      // The server filters recipients — clients never see other-team chatter.
      for (const c of this.clients) {
        if (this.game.players[c.sessionId]?.team === sender.team) c.send(MSG_CHAT_MSG, out);
      }
    } else {
      this.broadcast(MSG_CHAT_MSG, out);
    }
  }

  private tick(dtMs: number): void {
    this.accumulator += Math.min(dtMs, MAX_TICK_DELTA_MS) / 1000;
    while (this.accumulator >= FIXED_DT) {
      const t0 = performance.now();
      this.botMsThisTick = 0;
      this.step();
      const cost = performance.now() - t0;
      this.perfTickMsSum += cost;
      this.perfBotMsSum += this.botMsThisTick;
      if (cost > this.perfTickMsMax) this.perfTickMsMax = cost;
      this.perfTicks++;
      this.accumulator -= FIXED_DT;
    }
    this.rollPerfWindow();

    this.snapshotAcc += Math.min(dtMs, MAX_TICK_DELTA_MS) / 1000;
    if (this.snapshotAcc >= 1 / SNAPSHOT_RATE) {
      this.snapshotAcc %= 1 / SNAPSHOT_RATE;
      this.broadcastSnapshot();
    }
  }

  /** Fold the accumulated tick costs into `perf` every PERF_WINDOW_SEC. */
  private rollPerfWindow(): void {
    const now = performance.now();
    const elapsed = (now - this.perfWindowStart) / 1000;
    if (elapsed < PERF_WINDOW_SEC) return;
    this.perf = {
      tickMs: this.perfTicks > 0 ? this.perfTickMsSum / this.perfTicks : 0,
      tickMsMax: this.perfTickMsMax,
      botMs: this.perfTicks > 0 ? this.perfBotMsSum / this.perfTicks : 0,
      tps: this.perfTicks / elapsed,
    };
    this.perfTickMsSum = 0;
    this.perfTickMsMax = 0;
    this.perfBotMsSum = 0;
    this.perfTicks = 0;
    this.perfWindowStart = now;

    this.perfLogAcc += elapsed;
    if (this.perfLogAcc >= 10) {
      this.perfLogAcc = 0;
      const p = this.perf;
      console.log(
        `room ${this.roomId} tick avg ${p.tickMs.toFixed(2)}ms max ${p.tickMsMax.toFixed(2)}ms ` +
          `(bots ${p.botMs.toFixed(2)}ms) @ ${p.tps.toFixed(1)} tps`,
      );
    }
  }

  /** One fixed simulation tick — mirrors GameScene's local loop exactly. */
  private step(): void {
    // Idle in warmup until a human is present on both (bot-filled) teams.
    if (this.match.phase === 'warmup' && this.humanCount() === 0) {
      this.match.phaseTimeLeft = WARMUP_TIME_SEC;
    }

    const botsActive = this.match.phase === 'live' || this.match.phase === 'round_end';
    if (botsActive) {
      const b0 = performance.now();
      assignBotObjectives(this.bots, this.match, this.botWorld.siteAnchors, this.tIds, this.ctIds);
      this.botMsThisTick += performance.now() - b0;
    }

    const evStart = this.game.events.length;
    const matchEvStart = this.match.events.length;
    const frozen = movementFrozen(this.match);
    const cmds: Record<string, InputCommand> = {};

    for (const id of Object.keys(this.game.players)) {
      const bot = this.bots[id];
      let cmd: InputCommand;
      let viewTick = this.game.tick; // bots resolve shots at the present

      if (bot) {
        const b0 = performance.now();
        cmd = botsActive ? bot.update(this.game, FIXED_DT) : idleCommand();
        this.botMsThisTick += performance.now() - b0;
      } else {
        const queued = this.queues.get(id)?.shift();
        if (queued) {
          cmd = queued.cmd;
          this.repeatTicks.set(id, 0);
          this.lastInputTick.set(id, queued.cmd.tick);
          this.lastViewTick.set(id, queued.viewTick);
        } else {
          cmd = this.repeatCommand(id);
        }
        viewTick = this.lastViewTick.get(id) ?? this.game.tick;
      }

      this.lastCmd.set(id, cmd);
      if (frozen) cmd = { ...cmd, moveX: 0, moveY: 0, buttons: 0 };
      cmds[id] = cmd;

      if (cmd.buttons & Buttons.Shoot) {
        // Lag compensation: resolve shots against the world the shooter saw
        // (their interpolated render tick), then restore positions.
        this.withRewind(id, viewTick, () => applyInput(this.game, id, cmd, this.map, FIXED_DT));
      } else {
        applyInput(this.game, id, cmd, this.map, FIXED_DT);
      }
    }

    stepWorld(this.game, this.map, FIXED_DT);
    updateMatch(this.match, this.game, cmds, this.map, this.game.events.slice(evStart), FIXED_DT);
    this.game.tick++;
    this.recordHistory();

    this.reactToEvents(this.game.events.slice(evStart), this.match.events.slice(matchEvStart));
  }

  /** Feed this tick's events to the bots (hearing, flashes) and round resets. */
  private reactToEvents(
    simEvents: GameState['events'],
    matchEvents: MatchState['events'],
  ): void {
    for (const ev of simEvents) {
      if (ev.type === 'shot') {
        for (const bot of Object.values(this.bots)) bot.hear(this.game, ev);
      } else if (ev.type === 'grenade_explode' && ev.gtype === 'flash') {
        this.flashBots(ev.pos);
      }
    }
    for (const ev of matchEvents) {
      if (ev.type === 'halftime') {
        // Teams flipped inside the sim: re-sort rosters + bot enemy lists.
        this.rebuildRoster();
      } else if (ev.type === 'round_start') {
        for (const bot of Object.values(this.bots)) bot.reset();
        this.autoBuyBots();
        this.publishMetadata();
      }
    }
  }

  /** Blind bots that can see a flash pop (same rules as the client HUD). */
  private flashBots(pos: Vec2): void {
    const segments =
      this.game.smokes.length > 0
        ? [...this.map.segments, ...smokeSegments(this.game.smokes)]
        : this.map.segments;
    for (const [id, bot] of Object.entries(this.bots)) {
      const p = this.game.players[id];
      if (!p || p.hp <= 0) continue;
      const dx = pos.x - p.pos.x;
      const dy = pos.y - p.pos.y;
      const dist = Math.hypot(dx, dy);
      if (dist > FLASH_RANGE_PX) continue;
      if (!canSee({ pos: p.pos, angle: p.angle }, pos, segments, true)) continue;
      const facing = Math.cos(Math.atan2(dy, dx) - p.angle) > 0 ? 1 : FLASH_BEHIND_MULT;
      bot.flash(FLASH_MAX_BLIND_SEC * (1 - dist / FLASH_RANGE_PX) * facing);
    }
  }

  /** Greedy bot spending at round start: best affordable primary, CTs a kit. */
  private autoBuyBots(): void {
    for (const id of Object.keys(this.bots)) {
      if (!tryBuy(this.match, this.game, this.map, id, 'rifle')) {
        tryBuy(this.match, this.game, this.map, id, 'smg');
      }
      if (this.game.players[id]?.team === 'CT') {
        tryBuy(this.match, this.game, this.map, id, 'kit');
      }
    }
  }

  /** Snapshot everyone's post-tick position into the rewind ring. */
  private recordHistory(): void {
    const pos = new Map<string, Vec2>();
    for (const p of Object.values(this.game.players)) {
      if (p.hp > 0) pos.set(p.id, { x: p.pos.x, y: p.pos.y });
    }
    this.history.push({ tick: this.game.tick, pos });
    const maxLen = Math.round(TICK_RATE * LAG_COMP_MAX_REWIND_SEC);
    if (this.history.length > maxLen) this.history.shift();
  }

  /**
   * Run `fn` with every *other* living player moved back to where they were
   * at `viewTick` (clamped to the history window), restoring positions after.
   * Only positions rewind — damage dealt inside persists.
   */
  private withRewind(shooterId: string, viewTick: number, fn: () => void): void {
    const oldest = this.history[0]?.tick ?? this.game.tick;
    const clamped = Math.max(oldest, Math.min(viewTick, this.game.tick));
    const entry = this.history.find((h) => h.tick === clamped);
    if (!entry) {
      fn();
      return;
    }
    const saved: { p: { pos: Vec2 }; x: number; y: number }[] = [];
    for (const p of Object.values(this.game.players)) {
      if (p.id === shooterId) continue;
      const at = entry.pos.get(p.id);
      if (!at) continue;
      saved.push({ p, x: p.pos.x, y: p.pos.y });
      p.pos.x = at.x;
      p.pos.y = at.y;
    }
    fn();
    for (const s of saved) {
      s.p.pos.x = s.x;
      s.p.pos.y = s.y;
    }
  }

  /**
   * Reuse the previous command (aim/movement hold), minus one-shot buttons.
   * Only briefly: past INPUT_HOLD_MAX_TICKS of silence the avatar idles —
   * a paused overlay, hidden tab or dead connection must not leave it
   * running/firing on its last order indefinitely.
   */
  private repeatCommand(id: string): InputCommand {
    const last = this.lastCmd.get(id);
    if (!last) return idleCommand();
    const held = (this.repeatTicks.get(id) ?? 0) + 1;
    this.repeatTicks.set(id, held);
    if (held > INPUT_HOLD_MAX_TICKS) {
      return { ...idleCommand(), aimAngle: last.aimAngle };
    }
    return { ...last, buttons: last.buttons & ~ONE_SHOT_BUTTONS };
  }

  /** Full state down the wire; event arrays are per-snapshot deltas. */
  private broadcastSnapshot(): void {
    const snapshot: Snapshot = {
      game: this.game,
      match: this.match,
      names: this.names,
      acks: Object.fromEntries(this.lastInputTick),
      perf: this.perf,
      pings: this.pings,
    };
    this.broadcast(MSG_SNAPSHOT, snapshot);
    this.game.events = [];
    this.match.events = [];
  }
}
