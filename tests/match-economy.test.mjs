// Match-layer tests: tryBuy legality (incl. prototype-pollution keys),
// economy math (win reward / escalating loss bonus), bomb plant/defuse/
// detonation timing.
import { readFileSync } from 'node:fs';
import { Buttons } from '../src/core/types.ts';
import { createGameState, createPlayer } from '../src/core/simulation.ts';
import { parseTiledMap } from '../src/core/map.ts';
import {
  BOMB_DEFUSE_KIT_TIME_SEC,
  BOMB_DEFUSE_TIME_SEC,
  BOMB_PLANT_TIME_SEC,
  BOMB_TIMER_SEC,
  ARMOR_MAX,
  BUY_GRACE_SEC,
  KILL_REWARD,
  LOSS_BONUS_BASE,
  LOSS_BONUS_STEP,
  WEAPONS,
  WIN_REWARD,
} from '../src/core/config.ts';
import { createMatchState, tryBuy, trySell, updateMatch } from '../src/match/MatchState.ts';

const map = parseTiledMap(
  JSON.parse(readFileSync(new URL('../public/assets/maps/de_yard.json', import.meta.url), 'utf8')),
);
const DT = 0.05;

let failures = 0;
function check(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
}

function setup() {
  const game = createGameState(9);
  game.players.t1 = createPlayer('t1', 'T', 100, 100);
  game.players.c1 = createPlayer('c1', 'CT', 800, 800);
  const match = createMatchState(['t1', 'c1'], 800, 13);
  return { game, match };
}
function advance(match, game, seconds, cmds = {}) {
  for (let t = 0; t < seconds; t += DT) updateMatch(match, game, cmds, map, [], DT);
}
const useCmd = { tick: 0, moveX: 0, moveY: 0, aimAngle: 0, buttons: Buttons.Use };

// --- tryBuy legality ---------------------------------------------------------
{
  const { game, match } = setup();
  advance(match, game, 6); // warmup → buy phase
  check(match.phase === 'buy', 'reached buy phase');

  check(!tryBuy(match, game, map, 't1', '__proto__'), '__proto__ rejected');
  check(!tryBuy(match, game, map, 't1', 'toString'), 'inherited key rejected');
  check(!tryBuy(match, game, map, 't1', 'knife'), 'the knife is not for sale');
  check(game.players.t1.slots.length === 2 && match.stats.t1.money === 800, 'no side effects');

  check(!tryBuy(match, game, map, 't1', 'kit'), 'Ts cannot buy a defuse kit');
  check(tryBuy(match, game, map, 'c1', 'kit'), 'CTs can');
  check(!tryBuy(match, game, map, 'c1', 'kit'), 'no double kit');

  check(!tryBuy(match, game, map, 't1', 'sniper'), 'cannot afford the sniper on start money');
  check(tryBuy(match, game, map, 't1', 'deagle'), 'secondary upgrade allowed');
  check(match.stats.t1.money === 800 - WEAPONS.deagle.price, 'money deducted');
  check(!tryBuy(match, game, map, 't1', 'deagle'), 'already owned');

  match.stats.t1.money = 500; // top up (deagle left only $100)
  check(tryBuy(match, game, map, 't1', 'flash'), 'grenade purchase');
  check(!tryBuy(match, game, map, 't1', 'flash'), 'no duplicate grenade of one type');

  // Outside buy time nothing sells.
  advance(match, game, 20);
  check(match.phase === 'live', 'reached live');
  check(!tryBuy(match, game, map, 't1', 'smg'), 'no buying during live');
}

// --- Economy: win reward + escalating loss bonus -------------------------------
{
  const { game, match } = setup();
  const killLoser = () => {
    game.players.t1.hp = 0; // CT wins by elimination
    advance(match, game, 0.2);
    advance(match, game, 6); // round_end → next buy (payout lands here)
  };
  advance(match, game, 26); // into live (round 1)
  const before = { t: match.stats.t1.money, c: match.stats.c1.money };
  killLoser();
  check(
    match.stats.c1.money === before.c + WIN_REWARD,
    'winner gets WIN_REWARD at next round start',
  );
  check(
    match.stats.t1.money === before.t + LOSS_BONUS_BASE,
    'first loss pays LOSS_BONUS_BASE',
  );
  const afterFirst = match.stats.t1.money;
  advance(match, game, 20); // buy → live (round 2)
  killLoser();
  check(
    match.stats.t1.money === afterFirst + LOSS_BONUS_BASE + LOSS_BONUS_STEP,
    'second consecutive loss escalates by LOSS_BONUS_STEP',
  );
  check(match.lossStreak.T === 2 && match.lossStreak.CT === 0, 'loss streaks tracked');

  // Kill reward is instant (not deferred like round payouts).
  advance(match, game, 20);
  const shooter = match.stats.c1.money;
  updateMatch(match, game, {}, map, [
    { type: 'death', playerId: 't1', killerId: 'c1', cause: 'rifle' },
  ], DT);
  check(match.stats.c1.money === shooter + KILL_REWARD, 'kill pays KILL_REWARD immediately');
}

// --- Bomb timing ---------------------------------------------------------------
{
  // Plant: carrier standing in a site holding Use for BOMB_PLANT_TIME_SEC.
  const { game, match } = setup();
  advance(match, game, 26);
  check(match.phase === 'live', 'live for bomb test');
  const site = map.bombsites[0];
  const inSite = { x: site.x + site.width / 2, y: site.y + site.height / 2 };
  match.bomb.carrierId = 't1';
  game.players.t1.pos = { ...inSite };
  game.players.t1.vel = { x: 0, y: 0 };

  advance(match, game, BOMB_PLANT_TIME_SEC - 0.2, { t1: useCmd });
  check(match.bomb.plantedAt === null, 'not planted before the timer');
  advance(match, game, 0.4, { t1: useCmd });
  check(match.bomb.plantedAt !== null, 'planted after BOMB_PLANT_TIME_SEC of holding Use');
  check(Math.abs(match.bomb.timeLeft - BOMB_TIMER_SEC) < 0.3, 'detonation timer armed');

  // Detonation: T wins when the timer runs out (T is far from the blast).
  game.players.t1.pos = { x: 100, y: 100 };
  advance(match, game, BOMB_TIMER_SEC + 0.2);
  check(match.phase === 'round_end', 'round ended at detonation');
  check(match.lastRound?.winner === 'T' && match.lastRound?.reason === 'detonation', 'T win by detonation');

  // Defuse: kit halves the time.
  advance(match, game, 6 + 20); // next round → live
  match.bomb.plantedAt = { ...inSite };
  match.bomb.timeLeft = BOMB_TIMER_SEC;
  game.players.c1.pos = { ...inSite };
  game.players.c1.vel = { x: 0, y: 0 };
  advance(match, game, BOMB_DEFUSE_TIME_SEC - 0.2, { c1: useCmd });
  check(match.phase === 'live' && match.bomb.plantedAt !== null, 'not defused early (no kit)');
  advance(match, game, 0.4, { c1: useCmd });
  check(match.lastRound?.reason === 'defusal', 'defused after BOMB_DEFUSE_TIME_SEC');

  // With a kit.
  advance(match, game, 6 + 20);
  match.stats.c1.hasDefuseKit = true;
  match.bomb.plantedAt = { ...inSite };
  match.bomb.timeLeft = BOMB_TIMER_SEC;
  game.players.c1.pos = { ...inSite };
  game.players.c1.vel = { x: 0, y: 0 };
  advance(match, game, BOMB_DEFUSE_KIT_TIME_SEC + 0.2, { c1: useCmd });
  check(match.lastRound?.reason === 'defusal', 'kit defuse completes in half the time');
}

// --- Bomb blast deaths reach the match layer -----------------------------------
{
  // Regression: blast deaths are emitted inside updateMatch, after the
  // caller's tickEvents slice — explode() must process them itself or they
  // never count (no death stat, no kill event, no weapon drop).
  const { game, match } = setup();
  advance(match, game, 26);
  check(match.phase === 'live', 'live for blast-death test');
  const site = map.bombsites[0];
  const inSite = { x: site.x + site.width / 2, y: site.y + site.height / 2 };
  match.bomb.plantedAt = { ...inSite };
  match.bomb.timeLeft = 0.1;
  game.players.c1.pos = { ...inSite }; // standing on the bomb
  game.players.t1.pos = { x: 100, y: 100 }; // out of the blast

  const deathsBefore = match.stats.c1.deaths;
  const evStart = match.events.length;
  advance(match, game, 0.3);
  check(match.lastRound?.reason === 'detonation', 'round ended by detonation');
  check(game.players.c1.hp === 0, 'CT on the bomb died in the blast');
  check(match.stats.c1.deaths === deathsBefore + 1, 'blast death counted in stats');
  const kills = match.events
    .slice(evStart)
    .filter((ev) => ev.type === 'kill' && ev.victimId === 'c1');
  check(
    kills.length === 1 && kills[0].killerId === 'bomb',
    'exactly one kill event, credited to the bomb',
  );
  check(
    match.droppedWeapons.length === 0 || match.droppedWeapons.every((d) => d.slot.weaponId !== 'knife'),
    'no bogus drops from the blast',
  );

  // The stray events must not be re-processed on later ticks (double count).
  advance(match, game, 0.5);
  check(match.stats.c1.deaths === deathsBefore + 1, 'blast death not double-counted');
}

// --- Sell-back (refunds) -------------------------------------------------------
{
  const { game, match } = setup();
  advance(match, game, 6); // warmup → buy phase
  const t1 = match.stats.t1;
  const c1 = match.stats.c1;

  tryBuy(match, game, map, 't1', 'deagle');
  check(trySell(match, game, map, 't1', 'deagle'), 'weapon refund accepted');
  check(t1.money === 800, 'weapon refund restores full price');
  check(game.players.t1.slots[1].weaponId === 'pistol', 'secondary reverted to pistol');
  check(!trySell(match, game, map, 't1', 'deagle'), 'no double refund');

  tryBuy(match, game, map, 't1', 'smoke');
  check(trySell(match, game, map, 't1', 'smoke') && t1.money === 800, 'grenade refund');
  check(!game.players.t1.grenades.includes('smoke'), 'grenade removed on refund');

  tryBuy(match, game, map, 'c1', 'kit');
  check(trySell(match, game, map, 'c1', 'kit') && c1.money === 800, 'kit refund');
  check(!c1.hasDefuseKit, 'kit removed on refund');

  tryBuy(match, game, map, 'c1', 'armor');
  game.players.c1.armor = 50;
  check(!trySell(match, game, map, 'c1', 'armor'), 'damaged armor is non-refundable');
  game.players.c1.armor = ARMOR_MAX;
  check(trySell(match, game, map, 'c1', 'armor') && c1.money === 800, 'full armor refunds');

  // Carried-over gear is never sellable: survive a round with a bought kit.
  tryBuy(match, game, map, 'c1', 'kit');
  advance(match, game, 20); // → live
  game.players.t1.hp = 0; // CT wins by elimination, c1 survives
  advance(match, game, 0.2);
  advance(match, game, 6); // round_end → next buy phase
  check(match.phase === 'buy' && c1.hasDefuseKit, 'survivor kept the kit');
  check(!trySell(match, game, map, 'c1', 'kit'), 'carried-over kit is not refundable');
}

// --- Buy grace period (live, spawn zone only) ----------------------------------
{
  const { game, match } = setup();
  advance(match, game, 6); // buy phase (players respawned at team spawns)
  match.stats.t1.money = 5000;
  advance(match, game, 8.05); // → ~3s into live
  check(match.phase === 'live', 'live for grace test');

  check(tryBuy(match, game, map, 't1', 'rifle'), 'can buy during grace at spawn');
  check(trySell(match, game, map, 't1', 'rifle'), 'can refund during grace at spawn');
  check(match.stats.t1.money === 5000, 'grace refund restores price');

  const spawn = { ...game.players.t1.pos };
  const site = map.bombsites[0];
  game.players.t1.pos = { x: site.x + site.width / 2, y: site.y + site.height / 2 };
  check(!tryBuy(match, game, map, 't1', 'rifle'), 'no buying outside the spawn zone');
  game.players.t1.pos = spawn;

  match.bomb.plantedAt = { x: 0, y: 0 };
  check(!tryBuy(match, game, map, 't1', 'rifle'), 'a plant closes the grace window');
  match.bomb.plantedAt = null;

  advance(match, game, BUY_GRACE_SEC); // well past the window
  check(!tryBuy(match, game, map, 't1', 'rifle'), 'grace window expires');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
