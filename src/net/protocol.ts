// Wire protocol shared by the Colyseus server (server/) and the browser
// client. Phase 9a is the naive JSON pipe: clients stream InputCommands up,
// the server broadcasts full-state snapshots down. No Phaser in here — the
// server imports this file, so it follows the same purity rules as core/
// (and uses explicit .ts extensions so it runs under node type-stripping).
import type { GameState, InputCommand } from '../core/types.ts';
import type { MatchState } from '../match/MatchState.ts';

/** Room name registered on the server and joined by clients. */
export const ROOM_NAME = 'match';

// Client → server messages.
/** Payload: InputMessage — one per client tick. */
export const MSG_INPUT = 'input';
/** Payload: BuyItem — server validates via match/tryBuy. */
export const MSG_BUY = 'buy';

// Server → client messages.
/** Payload: Welcome — sent once on join. */
export const MSG_WELCOME = 'welcome';
/** Payload: Snapshot — broadcast at SNAPSHOT_RATE. */
export const MSG_SNAPSHOT = 'snapshot';

/** joinOrCreate options; only the room creator's values take effect. */
export interface JoinOptions {
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
}
