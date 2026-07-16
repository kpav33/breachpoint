// Headless reconnect-grace test: handlePlayerDisconnect must bench the
// avatar (gun + bomb drop, plant cancelled) while leaving stats untouched.
import { readFileSync } from 'node:fs';
import { createGameState, createPlayer } from '../src/core/simulation.ts';
import { givePrimary } from '../src/core/weapons.ts';
import { parseTiledMap } from '../src/core/map.ts';
import {
  createMatchState,
  handlePlayerDisconnect,
  updateMatch,
} from '../src/match/MatchState.ts';

const map = parseTiledMap(
  JSON.parse(readFileSync(new URL('../public/assets/maps/de_yard.json', import.meta.url), 'utf8')),
);

let failures = 0;
function check(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
}

const game = createGameState(3);
game.players.t1 = createPlayer('t1', 'T', 300, 300);
game.players.c1 = createPlayer('c1', 'CT', 900, 900);
const match = createMatchState(['t1', 'c1'], 800, 13);
for (let t = 0; t < 61; t += 0.1) updateMatch(match, game, {}, map, [], 0.1);
if (match.phase !== 'live') throw new Error(`expected live, got ${match.phase}`);

givePrimary(game.players.t1, 'rifle');
match.bomb.carrierId = 't1';
match.bomb.plant = { playerId: 't1', progress: 1 };
match.stats.t1.kills = 3;
match.stats.t1.money = 4200;

handlePlayerDisconnect(match, game, 't1');

check(game.players.t1.hp === 0, 'avatar benched (hp 0)');
check(
  match.droppedWeapons.some((d) => d.slot.weaponId === 'rifle'),
  'rifle hit the ground',
);
check(match.bomb.carrierId === null && match.bomb.droppedAt !== null, 'bomb dropped');
check(match.bomb.plant === null, 'plant-in-progress cancelled');
check(match.stats.t1.kills === 3 && match.stats.t1.money === 4200, 'stats/money untouched');
check(game.players.t1.id === 't1', 'player entry still exists (seat held)');

// Calling it again (or for a ghost id) must be harmless.
handlePlayerDisconnect(match, game, 't1');
handlePlayerDisconnect(match, game, 'nobody');
check(match.droppedWeapons.length === 1, 'idempotent — no double drop');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
