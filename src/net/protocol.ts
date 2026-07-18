// Wire protocol shared by the Colyseus server (server/) and the browser
// client. Phase 9a is the naive JSON pipe: clients stream InputCommands up,
// the server broadcasts full-state snapshots down. No Phaser in here — the
// server imports this file, so it follows the same purity rules as core/
// (and uses explicit .ts extensions so it runs under node type-stripping).
import type { GameState, InputCommand, Team } from '../core/types.ts';
import type { MatchState } from '../match/MatchState.ts';

/** Room name registered on the server and joined by clients. */
export const ROOM_NAME = 'match';

/**
 * The built-in Colyseus LobbyRoom streaming the public room list (Phase 10
 * room browser). Not part of the game wire format — its messages ("rooms",
 * "+", "-") are Colyseus's own.
 */
export const LOBBY_ROOM_NAME = 'lobby';

/** Metadata every MatchRoom publishes; the lobby's room browser renders it. */
export interface RoomMetadata {
  /** Room display name (the creator's player name or "Match"). */
  name: string;
  mapKey: string;
  /** Connected humans (total occupancy incl. bots is always capacity). */
  humans: number;
  /** Human seats (maxClients). */
  capacity: number;
  phase: string;
  round: number;
}

/**
 * Wire-format version. The deployed client (CDN) and server ship
 * independently — bump this on ANY breaking change to the messages or
 * embedded state shapes so stale clients get a clear "refresh" error
 * instead of confusing desyncs.
 */
export const PROTOCOL_VERSION = 4;

// Client → server messages.
/** Payload: InputMessage — one per client tick. */
export const MSG_INPUT = 'input';
/** Payload: BuyItem — buy/refund toggle, validated via match/tryBuy+trySell. */
export const MSG_BUY = 'buy';
/** Payload: Ping — sent every PING_INTERVAL_MS; the server echoes it back. */
export const MSG_PING = 'ping';
/** Payload: ChatSend — server validates, rate-limits and relays. */
export const MSG_CHAT = 'chat';

// Server → client messages.
/** Payload: Welcome — sent once on join. */
export const MSG_WELCOME = 'welcome';
/** Payload: Snapshot — broadcast at SNAPSHOT_RATE. */
export const MSG_SNAPSHOT = 'snapshot';
/** Payload: Ping — the client's ping echoed verbatim (RTT = now − t). */
export const MSG_PONG = 'pong';
/** Payload: ChatMessage — a relayed chat line (team chat only reaches teammates). */
export const MSG_CHAT_MSG = 'chat_msg';

/** joinOrCreate options; only the room creator's values take effect. */
export interface JoinOptions {
  /** Client's PROTOCOL_VERSION — the server rejects mismatches on join. */
  protocol?: number;
  mapKey?: string;
  roundsToWin?: number;
  /** Player display name (join) and, for the creator, the room's name. */
  name?: string;
  /** Host a private room — hidden from the room list, joinable only by id. */
  private?: boolean;
}

export interface Welcome {
  /** The player id this client controls inside GameState. */
  playerId: string;
  /** Map the room is running (creator's pick), e.g. "de_yard". */
  mapKey: string;
}

/** RTT probe. `t` is an opaque client timestamp, echoed back unchanged. */
export interface Ping {
  t: number;
  /**
   * The client's current rolling RTT estimate, ms (absent until the first
   * pong lands). The server collects these into `Snapshot.pings` so every
   * client can show a scoreboard ping column.
   */
  rtt?: number;
}

/**
 * Server tick health, measured over a rolling window (Phase 9.5). Lets the
 * client distinguish "my connection is bad" from "the server is overloaded".
 */
export interface ServerPerf {
  /** Average cost of one simulation tick over the window, ms. */
  tickMs: number;
  /** Worst single tick in the window, ms. */
  tickMsMax: number;
  /** Share of tickMs spent running bot brains, ms. */
  botMs: number;
  /** Achieved ticks per second (target: TICK_RATE). */
  tps: number;
}

/** Chat line from a client. Untrusted: the server clamps and rate-limits. */
export interface ChatSend {
  text: string;
  /** True = team chat (only teammates receive it). */
  team?: boolean;
}

/** A validated chat line relayed by the server. */
export interface ChatMessage {
  /** Sender display name (server-side names are already authoritative). */
  name: string;
  team: Team;
  text: string;
  teamOnly: boolean;
}

/** One tick of client intent plus what that client was looking at. */
export interface InputMessage {
  cmd: InputCommand;
  /**
   * The (interpolated) server tick this client was rendering when the
   * command was produced — the server rewinds targets to it before resolving
   * shots (lag compensation).
   */
  viewTick: number;
}

/**
 * Authoritative full state. The embedded `events` arrays carry only events
 * emitted since the previous snapshot, so clients drain them exactly once.
 */
export interface Snapshot {
  game: GameState;
  match: MatchState;
  /** Display names by player id (plus the "bomb" pseudo-killer). */
  names: Record<string, string>;
  /**
   * Per player: `cmd.tick` of the last InputCommand the server applied.
   * Clients drop acknowledged inputs and replay the rest (reconciliation).
   */
  acks: Record<string, number>;
  /** Server tick health over the last measurement window. */
  perf: ServerPerf;
  /** Last reported RTT per human player, ms (bots have no entry). */
  pings: Record<string, number>;
}
