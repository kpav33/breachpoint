// Bot grenade reasoning: bots throw utility *at* a known enemy position (not
// randomly), refuse throws that wouldn't land near the target, and only do so
// when their difficulty enables utility. Shared headless AI, no Phaser.
import { TICK_RATE, BOT_PROFILES } from '../src/core/config.ts';
import { createGameState, createPlayer, applyInput, stepWorld, predictGrenadePath } from '../src/core/simulation.ts';
import { BotController } from '../src/ai/BotController.ts';

let failures = 0;
function check(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
}

const dt = 1 / TICK_RATE;
// Open arena — no walls, so a throw's reach is bounded purely by charge/friction.
const grid = { tileSize: 32, width: 60, height: 60, cells: Array.from({ length: 60 }, () => new Array(60).fill(0)) };
const map = { grid, segments: [] };
const BOT = { x: 960, y: 960 };

function makeBot(profileName) {
  const bot = new BotController('b1', ['e1'], BOT_PROFILES[profileName], map, [], 0x1234);
  const state = createGameState();
  const me = createPlayer('b1', 'T', BOT.x, BOT.y);
  me.grenades = ['flash', 'he', 'smoke'];
  state.players['b1'] = me;
  return { bot, state, me };
}

// Run the bot for up to `maxTicks`, driving the sim with its own commands.
// Returns the first grenade it threw (captured from projectiles), or null.
function runUntilThrow(bot, state, maxTicks) {
  for (let i = 0; i < maxTicks; i++) {
    const before = state.projectiles.length;
    const cmd = bot.update(state, dt);
    applyInput(state, 'b1', cmd, map, dt);
    if (state.projectiles.length > before) {
      return state.projectiles[state.projectiles.length - 1];
    }
    stepWorld(state, map, dt);
  }
  return null;
}

// --- Purposeful throw: a normal bot flashes a reachable known position --------
{
  const { bot, state, me } = makeBot('normal');
  const target = { x: BOT.x, y: BOT.y + 210 }; // 210px away: in the flash band, reachable
  bot.hear(state, { type: 'shot', playerId: 'e1', from: target });

  const nade = runUntilThrow(bot, state, 120);
  check(!!nade, 'normal bot throws a grenade at a known enemy position');
  if (nade) {
    // Dry-run the thrown grenade and confirm it lands near the intended spot —
    // i.e. it was aimed, not lobbed at random.
    const speed = Math.hypot(nade.vel.x, nade.vel.y);
    const angle = Math.atan2(nade.vel.y, nade.vel.x);
    const path = predictGrenadePath(me.pos, angle, nade.type, map, dt, nade.vz === 0, speed);
    const end = path[path.length - 1];
    const landErr = Math.hypot(end.x - target.x, end.y - target.y);
    check(landErr < 80, `thrown grenade lands near the target (err ${landErr.toFixed(0)}px)`);
  }
}

// --- Difficulty gate: an easy bot never uses utility --------------------------
{
  const { bot, state } = makeBot('easy');
  bot.hear(state, { type: 'shot', playerId: 'e1', from: { x: BOT.x, y: BOT.y + 210 } });
  const nade = runUntilThrow(bot, state, 120);
  check(nade === null, 'easy bot (no utility) never throws');
}

// --- Reasoning refuses an unreachable throw -----------------------------------
{
  // 400px is inside the flash *trigger* band but past a flash's actual reach,
  // so no charge level lands near it — on the spot, the bot must not throw.
  const { bot, state } = makeBot('normal');
  bot.hear(state, { type: 'shot', playerId: 'e1', from: { x: BOT.x, y: BOT.y + 400 } });
  bot.update(state, dt); // single tick, before it walks closer
  check(bot.debugInfo.throwTarget === null, 'bot refuses a throw that would not land near the target');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
