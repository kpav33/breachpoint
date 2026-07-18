// Colyseus server entry point (Phase 9a). Runs directly under Node via type
// stripping — no build step: `npm run server`. Imports the same src/core and
// src/match code the browser client runs.
import http from 'node:http';
import { LobbyRoom, Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { DEFAULT_SERVER_PORT } from '../src/core/config.ts';
import { LOBBY_ROOM_NAME, ROOM_NAME } from '../src/net/protocol.ts';
import { MatchRoom } from './MatchRoom.ts';

const port = Number(process.env.PORT ?? DEFAULT_SERVER_PORT);

// All game traffic is WebSocket (handled via the upgrade event); the plain
// HTTP side only serves GET /health for container/Coolify healthchecks.
const httpServer = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('OK');
  } else {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});

const server = new Server({ transport: new WebSocketTransport({ server: httpServer }) });
server.define(ROOM_NAME, MatchRoom);
// Built-in room-list feed for the client lobby's room browser (Phase 10).
// Public MatchRooms are pushed to subscribers on create/join/leave/dispose;
// metadata edits are pushed manually via updateLobby (see publishMetadata).
server.define(LOBBY_ROOM_NAME, LobbyRoom);

void server.listen(port).then(() => {
  console.log(`breachpoint server listening on ws://localhost:${port}`);
});
