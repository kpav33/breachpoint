// Bot trigger discipline across fire modes. Semi-automatic weapons fire only
// on the press edge, so a bot that simply holds the trigger through its burst
// would get ONE shot per burst — a silent, severe nerf on pistol rounds. These
// tests pin the pulsing behavior that prevents that.
import { TICK_RATE, BOT_PROFILES, WEAPONS } from '../src/core/config.ts';
import { createGameState, createPlayer, applyInput, stepWorld } from '../src/core/simulation.ts';
import { givePrimary } from '../src/core/weapons.ts';
import { BotController } from '../src/ai/BotController.ts';

let failures = 0;
function check(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
}

const dt = 1 / TICK_RATE;
// Open arena so line of sight is never the limiting factor.
const grid = {
  tileSize: 32,
  width: 60,
  height: 60,
  cells: Array.from({ length: 60 }, () => new Array(60).fill(0)),
};
const map = { grid, segments: [] };
const SECONDS = 3;

/** Shots a bot of `profile` lands on a visible enemy in SECONDS, using `weapon`. */
function shotsFired(profile, weapon) {
  const bot = new BotController('b1', ['e1'], BOT_PROFILES[profile], map, [], 0x1234);
  const state = createGameState();
  const me = createPlayer('b1', 'T', 900, 960);
  const foe = createPlayer('e1', 'CT', 1200, 960);
  foe.hp = 100000; // never dies, so the engagement runs the whole window
  state.players.b1 = me;
  state.players.e1 = foe;
  if (weapon !== 'pistol') {
    givePrimary(me, weapon);
    me.activeSlot = 2;
  }
  let shots = 0;
  for (let i = 0; i < TICK_RATE * SECONDS; i++) {
    applyInput(state, 'b1', bot.update(state, dt), map, dt);
    shots += state.events.filter((e) => e.type === 'shot' && e.playerId === 'b1').length;
    state.events.length = 0;
    stepWorld(state, map, dt);
  }
  return shots;
}

// A bot holding the trigger down manages exactly one shot per burst cycle
// (burstSec + burstPauseSec), so exceeding that count proves it re-presses.
// That comparison only means something when a burst is long enough to fit more
// than one shot: easy's 0.18 s burst is shorter than the pistol's 0.2 s cycle,
// so it is capped at one shot per burst by profile design, not by fire mode.
const pistolInterval = 60 / WEAPONS.pistol.rpm;
for (const profile of ['easy', 'normal', 'hard']) {
  const p = BOT_PROFILES[profile];
  const burstCycles = Math.ceil(SECONDS / (p.burstSec + p.burstPauseSec));
  const shots = shotsFired(profile, 'pistol');
  check(shots > 1, `${profile} bot keeps firing a semi-auto across bursts (${shots} shots)`);
  if (p.burstSec >= pistolInterval) {
    check(
      shots > burstCycles,
      `${profile} bot fires more than once per burst (${shots} > ${burstCycles} cycles)`,
    );
  }
}

// Full-auto is unaffected by the edge rule and should still out-shoot semi-auto.
{
  check(WEAPONS.rifle.auto && !WEAPONS.pistol.auto, 'rifle is auto, pistol is not');
  const rifle = shotsFired('normal', 'rifle');
  const pistol = shotsFired('normal', 'pistol');
  check(rifle > pistol, `full-auto sustains more fire than semi-auto (${rifle} vs ${pistol})`);
}

// Harder bots shoot more (tighter burst discipline), fire mode notwithstanding.
{
  const easy = shotsFired('easy', 'pistol');
  const hard = shotsFired('hard', 'pistol');
  check(hard > easy, `hard bots out-shoot easy bots with a semi-auto (${hard} vs ${easy})`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
