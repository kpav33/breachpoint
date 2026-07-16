// Headless halftime/draw test — drives the pure match logic exactly like the
// server does (node --experimental-strip-types loads the .ts sources).
import { readFileSync } from 'node:fs';
import { createGameState, createPlayer } from '../src/core/simulation.ts';
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

function setup(roundsToWin) {
  const game = createGameState(42);
  const ids = ['t1', 't2', 'c1', 'c2'];
  game.players.t1 = createPlayer('t1', 'T', 100, 100);
  game.players.t2 = createPlayer('t2', 'T', 120, 100);
  game.players.c1 = createPlayer('c1', 'CT', 800, 800);
  game.players.c2 = createPlayer('c2', 'CT', 820, 800);
  const match = createMatchState(ids, 800, roundsToWin);
  return { game, match };
}

function advance(match, game, seconds) {
  for (let t = 0; t < seconds; t += 0.1) updateMatch(match, game, {}, map, [], 0.1);
}

function drain(match) {
  const evs = match.events.slice();
  match.events.length = 0;
  return evs;
}

function playRound(match, game, winnerTeam) {
  advance(match, game, 61); // through warmup/buy into live
  if (match.phase !== 'live') throw new Error(`expected live, got ${match.phase}`);
  for (const p of Object.values(game.players)) {
    if (p.team !== winnerTeam) p.hp = 0;
  }
  advance(match, game, 0.2);
  advance(match, game, 6);
}

// --- Scenario 1: halftime swap, then the swapped team closes out ------------
{
  const { game, match } = setup(3);
  playRound(match, game, 'T');
  drain(match);
  check(match.score.T === 1 && match.score.CT === 0, 'round 1: T leads 1-0');
  check(game.players.t1.team === 'T' && !match.sidesSwapped, 'round 1: no swap yet');

  match.stats.t1.money = 5000;
  playRound(match, game, 'T');
  const evs = drain(match);
  check(evs.some((e) => e.type === 'halftime'), 'halftime event emitted after round 2');
  check(match.sidesSwapped === true, 'sidesSwapped set');
  check(game.players.t1.team === 'CT' && game.players.c1.team === 'T', 'teams flipped');
  check(match.score.T === 0 && match.score.CT === 2, 'score followed the players (0-2)');
  check(match.stats.t1.money === 800, 'economy reset to start money');
  check(match.lossStreak.T === 0 && match.lossStreak.CT === 0, 'loss streaks cleared');
  check(match.phase === 'buy', 'second half started (buy phase)');

  playRound(match, game, 'CT');
  const end = drain(match).find((e) => e.type === 'match_end');
  check(end?.winner === 'CT', 'match won 3-0 by the players now on CT');
  check(match.phase === 'match_end', 'phase is match_end');
}

// --- Scenario 2: 1-1 draw with roundsToWin 2 --------------------------------
{
  const { game, match } = setup(2);
  playRound(match, game, 'T');
  drain(match);
  check(match.sidesSwapped, 'rtw=2: swap after round 1');
  playRound(match, game, 'T');
  const end = drain(match).find((e) => e.type === 'match_end');
  check(end !== undefined && end.winner === null, 'match_end winner=null (draw)');
  check(match.score.T === 1 && match.score.CT === 1, 'final score 1-1');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
