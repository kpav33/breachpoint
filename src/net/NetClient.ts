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
