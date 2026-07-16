// Thin Colyseus client wrapper. The server URL comes from VITE_SERVER_URL
// in production builds and falls back to the dev server on the page's host.
import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';
import { DEFAULT_SERVER_PORT } from '../core/config.ts';
import { ROOM_NAME } from './protocol.ts';
import type { JoinOptions } from './protocol.ts';

export function serverUrl(): string {
  return import.meta.env.VITE_SERVER_URL ?? `ws://${location.hostname}:${DEFAULT_SERVER_PORT}`;
}

let client: Client | null = null;
function getClient(): Client {
  return (client ??= new Client(serverUrl()));
}

/** Public matchmaking: join an open public room or create one (creator's
 *  options pick map/rounds). This is the "room browser" — the server places
 *  you into a room with a free slot or spins a fresh one up. */
export function quickPlay(options: JoinOptions): Promise<Room> {
  return getClient().joinOrCreate(ROOM_NAME, options);
}

/** Host a private room (hidden from matchmaking; share `room.roomId` to invite). */
export function hostPrivate(options: JoinOptions): Promise<Room> {
  return getClient().create(ROOM_NAME, { ...options, private: true });
}

/** Join a specific room by its id / share code. */
export function joinByCode(roomId: string, options: JoinOptions): Promise<Room> {
  return getClient().joinById(roomId, options);
}

/** Re-attach to a held seat using a token from a previous connection. */
export function reconnect(token: string): Promise<Room> {
  return getClient().reconnect(token);
}

// --- Reconnection token persistence (survives a page refresh) --------------
// sessionStorage is deliberate: per-tab, so two tabs can't fight over one
// seat, and it dies with the browser session.
const TOKEN_KEY = 'breachpoint.reconnect';
/** Past this age we assume the server-side grace window has expired. */
const TOKEN_MAX_AGE_MS = 90_000;

export function saveReconnectToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token, at: Date.now() }));
  } catch {
    // Storage failures (private mode) just mean no refresh-reconnect.
  }
}

export function clearReconnectToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

/** The stored token, if it is still young enough to plausibly work. */
export function loadReconnectToken(): string | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { token?: unknown; at?: unknown };
    if (typeof parsed.token !== 'string' || typeof parsed.at !== 'number') return null;
    if (Date.now() - parsed.at > TOKEN_MAX_AGE_MS) {
      clearReconnectToken();
      return null;
    }
    return parsed.token;
  } catch {
    return null;
  }
}
