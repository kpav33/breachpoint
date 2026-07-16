// Headless weapon drop/pickup test (pure match logic, no Phaser).
import { readFileSync } from 'node:fs';
import { Buttons } from '../src/core/types.ts';
import {
  createGameState,
  createPlayer,
  damagePlayer,
} from '../src/core/simulation.ts';
import { givePrimary } from '../src/core/weapons.ts';
import { parseTiledMap } from '../src/core/map.ts';
import { createMatchState, updateMatch } from '../src/match/MatchState.ts';

const map = parseTiledMap(
  JSON.parse(readFileSync(new URL('../public/assets/maps/de_yard.json', import.meta.url), 'utf8')),
);

let failures = 0;
function check(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
}

const game = createGameState(7);
game.players.t1 = createPlayer('t1', 'T', 400, 400);
game.players.c1 = createPlayer('c1', 'CT', 900, 900);
const match = createMatchState(['t1', 'c1'], 800, 13);

function tick(cmds = {}) {
  const evs = game.events.slice();
  game.events.length = 0;
  updateMatch(match, game, cmds, map, evs, 1 / 60);
}
function advance(seconds) {
  for (let t = 0; t < seconds; t += 0.1) updateMatch(match, game, {}, map, [], 0.1);
}
const cmd = (buttons) => ({ tick: 0, moveX: 0, moveY: 0, aimAngle: 0, buttons });

advance(61); // warmup + buy -> live
check(match.phase === 'live', 'reached live phase');

// --- Manual drop (G) --------------------------------------------------------
givePrimary(game.players.t1, 'rifle');
game.players.t1.slots[2].magAmmo = 7; // distinctive ammo to prove it survives
game.players.t1.activeSlot = 2;
game.players.t1.pos = { x: 400, y: 400 }; // startRound respawned him at a spawn
game.players.t1.angle = 0; // tossing straight right
tick({ t1: cmd(Buttons.Drop) });
check(match.droppedWeapons.length === 1, 'manual drop created a world entity');
check(game.players.t1.slots.length === 2, 'dropper lost the primary');
check(game.players.t1.activeSlot === 1, 'dropper switched to secondary');
const drop = match.droppedWeapons[0];
check(drop.slot.weaponId === 'rifle' && drop.slot.magAmmo === 7, 'drop kept weapon + ammo');
check(Math.abs(drop.pos.x - 440) < 1 && Math.abs(drop.pos.y - 400) < 1, 'tossed ~40px ahead');

// Dropper standing still does NOT re-grab (it landed outside pickup range).
tick();
check(match.droppedWeapons.length === 1, 'dropper does not instantly re-pick it up');

// Knife/pistol can't be dropped.
game.players.t1.activeSlot = 1;
tick({ t1: cmd(Buttons.Drop) });
check(match.droppedWeapons.length === 1, 'default pistol refuses to drop');

// --- Walk-over pickup -------------------------------------------------------
game.players.c1.pos = { x: drop.pos.x + 5, y: drop.pos.y }; // within 32px
tick();
check(match.droppedWeapons.length === 0, 'walk-over picked the gun up');
check(game.players.c1.slots[2]?.weaponId === 'rifle', 'picker-upper has the rifle');
check(game.players.c1.slots[2]?.magAmmo === 7, 'ammo preserved through pickup');

// Full slot blocks pickup.
givePrimary(game.players.t1, 'smg');
game.players.t1.pos = { x: 500, y: 500 };
game.players.t1.activeSlot = 2;
game.players.t1.angle = Math.PI / 2;
tick({ t1: cmd(Buttons.Drop) }); // t1 drops the smg at ~(500, 540)
game.players.c1.pos = { x: 500, y: 540 }; // c1 (has rifle) stands on it
tick();
check(match.droppedWeapons.length === 1, 'full primary slot blocks pickup');

// --- Death drop -------------------------------------------------------------
damagePlayer(game, 'c1', 999, 't1'); // c1 dies carrying the rifle
tick();
check(
  match.droppedWeapons.some((d) => d.slot.weaponId === 'rifle'),
  'death dropped the victim’s rifle',
);
check(game.players.c1.slots.length === 2, 'corpse no longer holds the primary');

// --- Round reset clears the floor -------------------------------------------
advance(6); // round_end -> next round
check(match.phase === 'buy' && match.droppedWeapons.length === 0, 'new round starts clean');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
