// Match structure (Phase 7): round phases, teams, economy, bomb defuse.
// Pure TypeScript on top of core/ — no Phaser. The scene calls updateMatch()
// once per fixed tick (after the simulation step) and drains match.events;
// the future server runs this file unchanged.
import { Buttons } from '../core/types';
import type { GameState, InputCommand, SimEvent, Team, Vec2, WeaponId } from '../core/types';
import type { MapData } from '../core/map';
import { damagePlayer, nextRand, respawnPlayer } from '../core/simulation';
import { defaultLoadout, givePrimary } from '../core/weapons';
import {
  BOMB_DAMAGE,
  BOMB_DEFUSE_KIT_TIME_SEC,
  BOMB_DEFUSE_RANGE_PX,
  BOMB_DEFUSE_TIME_SEC,
  BOMB_PICKUP_RANGE_PX,
  BOMB_PLANT_TIME_SEC,
  BOMB_RADIUS_PX,
  BOMB_TIMER_SEC,
  BUY_TIME_SEC,
  DEFUSE_KIT_PRICE,
  KILL_REWARD,
  LOSS_BONUS_BASE,
  LOSS_BONUS_MAX,
  LOSS_BONUS_STEP,
  MONEY_CAP,
  ROUNDS_TO_WIN,
  ROUND_END_TIME_SEC,
  ROUND_TIME_SEC,
  WARMUP_TIME_SEC,
  WEAPONS,
  WIN_REWARD,
} from '../core/config';

export type MatchPhase = 'warmup' | 'buy' | 'live' | 'round_end' | 'match_end';

export type RoundEndReason = 'elimination' | 'detonation' | 'defusal' | 'time';

export interface PlayerMatchStats {
  kills: number;
  deaths: number;
  money: number;
  hasDefuseKit: boolean;
}

export interface BombState {
  /** Living T currently holding the bomb (null = dropped or planted). */
  carrierId: string | null;
  /** On the ground after the carrier died. */
  droppedAt: Vec2 | null;
  plantedAt: Vec2 | null;
  /** Detonation countdown once planted. */
  timeLeft: number;
  plant: { playerId: string; progress: number } | null;
  defuse: { playerId: string; progress: number } | null;
}

export type MatchEvent =
  | { type: 'round_start'; round: number }
  | { type: 'round_end'; winner: Team; reason: RoundEndReason }
  | { type: 'match_end'; winner: Team }
  | { type: 'planted'; pos: Vec2 }
  | { type: 'defused' }
  | { type: 'exploded'; pos: Vec2 }
  | { type: 'bomb_dropped'; pos: Vec2 }
  | { type: 'bomb_pickup'; playerId: string }
  | { type: 'kill'; killerId: string; victimId: string };

export interface MatchState {
  phase: MatchPhase;
  /** Seconds left in the current phase (the round timer during LIVE). */
  phaseTimeLeft: number;
  round: number;
  score: Record<Team, number>;
  lossStreak: Record<Team, number>;
  stats: Record<string, PlayerMatchStats>;
  bomb: BombState;
  /** Which bombsite the T side is hitting this round (index into map.bombsites). */
  targetSite: number;
  lastRound: { winner: Team; reason: RoundEndReason } | null;
  /** Round payout deferred to the next round start (kill money lands first). */
  pendingPayout: { winner: Team; winAmount: number; lossAmount: number } | null;
  events: MatchEvent[];
}

function emptyBomb(): BombState {
  return {
    carrierId: null,
    droppedAt: null,
    plantedAt: null,
    timeLeft: 0,
    plant: null,
    defuse: null,
  };
}

export function createMatchState(playerIds: string[], startMoney: number): MatchState {
  const stats: Record<string, PlayerMatchStats> = {};
  for (const id of playerIds) {
    stats[id] = { kills: 0, deaths: 0, money: startMoney, hasDefuseKit: false };
  }
  return {
    phase: 'warmup',
    phaseTimeLeft: WARMUP_TIME_SEC,
    round: 0,
    score: { T: 0, CT: 0 },
    lossStreak: { T: 0, CT: 0 },
    stats,
    bomb: emptyBomb(),
    targetSite: 0,
    lastRound: null,
    pendingPayout: null,
    events: [],
  };
}

/** Players may buy only here (and are frozen in place). */
export function canBuy(match: MatchState): boolean {
  return match.phase === 'buy';
}

/** True while inputs should be reduced to aiming only. */
export function movementFrozen(match: MatchState): boolean {
  return match.phase === 'buy' || match.phase === 'warmup' || match.phase === 'match_end';
}

export function aliveCount(game: GameState, team: Team): number {
  let n = 0;
  for (const p of Object.values(game.players)) {
    if (p.team === team && p.hp > 0) n++;
  }
  return n;
}

function addMoney(stats: PlayerMatchStats, amount: number): void {
  stats.money = Math.min(stats.money + amount, MONEY_CAP);
}

/**
 * Buy a primary weapon or a defuse kit during BUY. Mutates loadout + money;
 * returns false (with no change) when the purchase is not allowed.
 */
export function tryBuy(
  match: MatchState,
  game: GameState,
  playerId: string,
  item: WeaponId | 'kit',
): boolean {
  if (!canBuy(match)) return false;
  const p = game.players[playerId];
  const stats = match.stats[playerId];
  if (!p || !stats || p.hp <= 0) return false;

  if (item === 'kit') {
    if (p.team !== 'CT' || stats.hasDefuseKit || stats.money < DEFUSE_KIT_PRICE) return false;
    stats.money -= DEFUSE_KIT_PRICE;
    stats.hasDefuseKit = true;
    return true;
  }

  const def = WEAPONS[item];
  if (def.slotIndex !== 2) return false; // knife/pistol are never bought
  if (p.slots[2]?.weaponId === item) return false; // already own it
  if (stats.money < def.price) return false;
  stats.money -= def.price;
  givePrimary(p, item);
  return true;
}

/**
 * Advance the match by one fixed tick. `cmds` are the InputCommands applied
 * to the simulation this tick (plant/defuse read the Use button from them);
 * `tickEvents` are the SimEvents emitted during this tick only.
 */
export function updateMatch(
  match: MatchState,
  game: GameState,
  cmds: Record<string, InputCommand>,
  map: MapData,
  tickEvents: SimEvent[],
  dt: number,
): void {
  processDeaths(match, game, tickEvents);

  switch (match.phase) {
    case 'warmup':
      match.phaseTimeLeft -= dt;
      if (match.phaseTimeLeft <= 0) startRound(match, game, map);
      break;
    case 'buy':
      match.phaseTimeLeft -= dt;
      if (match.phaseTimeLeft <= 0) {
        match.phase = 'live';
        match.phaseTimeLeft = ROUND_TIME_SEC;
      }
      break;
    case 'live':
      updateLive(match, game, cmds, map, dt);
      break;
    case 'round_end':
      match.phaseTimeLeft -= dt;
      if (match.phaseTimeLeft <= 0) {
        const winner = match.score.T >= ROUNDS_TO_WIN ? 'T' : match.score.CT >= ROUNDS_TO_WIN ? 'CT' : null;
        if (winner) {
          match.phase = 'match_end';
          match.phaseTimeLeft = 0;
          match.events.push({ type: 'match_end', winner });
        } else {
          startRound(match, game, map);
        }
      }
      break;
    case 'match_end':
      break;
  }
}

/** Kill rewards, stats, and the bomb hitting the ground with its carrier. */
function processDeaths(match: MatchState, game: GameState, tickEvents: SimEvent[]): void {
  for (const ev of tickEvents) {
    if (ev.type !== 'death') continue;
    const victim = game.players[ev.playerId];
    const killer = game.players[ev.killerId]; // undefined for 'bomb'
    const victimStats = match.stats[ev.playerId];
    if (victimStats) victimStats.deaths++;
    if (killer && victim && killer.team !== victim.team) {
      const killerStats = match.stats[ev.killerId];
      if (killerStats) {
        killerStats.kills++;
        addMoney(killerStats, KILL_REWARD);
      }
    }
    match.events.push({ type: 'kill', killerId: ev.killerId, victimId: ev.playerId });

    if (match.bomb.carrierId === ev.playerId && victim) {
      match.bomb.carrierId = null;
      match.bomb.droppedAt = { x: victim.pos.x, y: victim.pos.y };
      match.events.push({ type: 'bomb_dropped', pos: { ...match.bomb.droppedAt } });
    }
    if (match.bomb.defuse?.playerId === ev.playerId) match.bomb.defuse = null;
    if (match.bomb.plant?.playerId === ev.playerId) match.bomb.plant = null;
  }
}

function updateLive(
  match: MatchState,
  game: GameState,
  cmds: Record<string, InputCommand>,
  map: MapData,
  dt: number,
): void {
  const bomb = match.bomb;

  if (bomb.plantedAt) {
    bomb.timeLeft -= dt;
    if (bomb.timeLeft <= 0) {
      explode(match, game, bomb.plantedAt);
      return;
    }
    updateDefuse(match, game, cmds, dt);
    if (match.phase !== 'live') return; // defused ended the round
  } else {
    updatePickup(match, game);
    updatePlant(match, game, cmds, map, dt);
    // The round clock only runs until the plant.
    match.phaseTimeLeft -= dt;
    if (match.phaseTimeLeft <= 0) {
      endRound(match, 'CT', 'time');
      return;
    }
  }

  // Eliminations. With the bomb planted, dead Ts still win via detonation,
  // so only a CT wipe ends the round immediately.
  if (aliveCount(game, 'CT') === 0) {
    endRound(match, 'T', 'elimination');
  } else if (!bomb.plantedAt && aliveCount(game, 'T') === 0) {
    endRound(match, 'CT', 'elimination');
  }
}

/** Is `pos` inside bombsite rect `site`? */
function inSite(pos: Vec2, site: { x: number; y: number; width: number; height: number }): boolean {
  return (
    pos.x >= site.x && pos.x <= site.x + site.width && pos.y >= site.y && pos.y <= site.y + site.height
  );
}

const STANDING_SPEED = 1;

function updatePlant(
  match: MatchState,
  game: GameState,
  cmds: Record<string, InputCommand>,
  map: MapData,
  dt: number,
): void {
  const bomb = match.bomb;
  const carrier = bomb.carrierId ? game.players[bomb.carrierId] : null;
  const cmd = carrier ? cmds[carrier.id] : undefined;
  const planting =
    carrier &&
    carrier.hp > 0 &&
    cmd !== undefined &&
    (cmd.buttons & Buttons.Use) !== 0 &&
    Math.hypot(carrier.vel.x, carrier.vel.y) < STANDING_SPEED &&
    map.bombsites.some((s) => inSite(carrier.pos, s));

  if (!planting) {
    bomb.plant = null;
    return;
  }
  if (!bomb.plant || bomb.plant.playerId !== carrier.id) {
    bomb.plant = { playerId: carrier.id, progress: 0 };
  }
  bomb.plant.progress += dt;
  if (bomb.plant.progress >= BOMB_PLANT_TIME_SEC) {
    bomb.plantedAt = { x: carrier.pos.x, y: carrier.pos.y };
    bomb.timeLeft = BOMB_TIMER_SEC;
    bomb.carrierId = null;
    bomb.plant = null;
    match.events.push({ type: 'planted', pos: { ...bomb.plantedAt } });
  }
}

function updateDefuse(
  match: MatchState,
  game: GameState,
  cmds: Record<string, InputCommand>,
  dt: number,
): void {
  const bomb = match.bomb;
  const at = bomb.plantedAt!;

  let defuser: string | null = null;
  for (const p of Object.values(game.players)) {
    if (p.team !== 'CT' || p.hp <= 0) continue;
    const cmd = cmds[p.id];
    if (!cmd || (cmd.buttons & Buttons.Use) === 0) continue;
    if (Math.hypot(p.vel.x, p.vel.y) >= STANDING_SPEED) continue;
    if (Math.hypot(p.pos.x - at.x, p.pos.y - at.y) > BOMB_DEFUSE_RANGE_PX) continue;
    defuser = p.id;
    break;
  }

  if (!defuser) {
    bomb.defuse = null;
    return;
  }
  if (!bomb.defuse || bomb.defuse.playerId !== defuser) {
    bomb.defuse = { playerId: defuser, progress: 0 };
  }
  bomb.defuse.progress += dt;
  const needed = match.stats[defuser]?.hasDefuseKit
    ? BOMB_DEFUSE_KIT_TIME_SEC
    : BOMB_DEFUSE_TIME_SEC;
  if (bomb.defuse.progress >= needed) {
    bomb.plantedAt = null;
    bomb.defuse = null;
    match.events.push({ type: 'defused' });
    endRound(match, 'CT', 'defusal');
  }
}

/** A living T walking over the dropped bomb picks it up. */
function updatePickup(match: MatchState, game: GameState): void {
  const bomb = match.bomb;
  if (!bomb.droppedAt || bomb.carrierId) return;
  for (const p of Object.values(game.players)) {
    if (p.team !== 'T' || p.hp <= 0) continue;
    if (
      Math.hypot(p.pos.x - bomb.droppedAt.x, p.pos.y - bomb.droppedAt.y) <= BOMB_PICKUP_RANGE_PX
    ) {
      bomb.carrierId = p.id;
      bomb.droppedAt = null;
      match.events.push({ type: 'bomb_pickup', playerId: p.id });
      return;
    }
  }
}

function explode(match: MatchState, game: GameState, at: Vec2): void {
  for (const p of Object.values(game.players)) {
    if (p.hp <= 0) continue;
    const dist = Math.hypot(p.pos.x - at.x, p.pos.y - at.y);
    if (dist >= BOMB_RADIUS_PX) continue;
    const dmg = Math.round(BOMB_DAMAGE * (1 - dist / BOMB_RADIUS_PX));
    damagePlayer(game, p.id, dmg, 'bomb');
  }
  match.events.push({ type: 'exploded', pos: { x: at.x, y: at.y } });
  match.bomb.plantedAt = null;
  endRound(match, 'T', 'detonation');
}

function endRound(match: MatchState, winner: Team, reason: RoundEndReason): void {
  const loser: Team = winner === 'T' ? 'CT' : 'T';
  match.score[winner]++;
  match.lossStreak[winner] = 0;
  match.lossStreak[loser]++;

  // Simplified economy: flat win reward, escalating loss bonus (capped).
  const lossBonus = Math.min(
    LOSS_BONUS_BASE + LOSS_BONUS_STEP * (match.lossStreak[loser] - 1),
    LOSS_BONUS_MAX,
  );
  match.pendingPayout = { winner, winAmount: WIN_REWARD, lossAmount: lossBonus };

  match.lastRound = { winner, reason };
  match.phase = 'round_end';
  match.phaseTimeLeft = ROUND_END_TIME_SEC;
  match.events.push({ type: 'round_end', winner, reason });
}

/**
 * Reset the world for the next round: pay out the previous one, respawn
 * everyone at team spawns, restock survivors, re-arm a random T with the
 * bomb, pick the T side's target site.
 */
function startRound(match: MatchState, game: GameState, map: MapData): void {
  if (match.pendingPayout) {
    const { winner, winAmount, lossAmount } = match.pendingPayout;
    for (const p of Object.values(game.players)) {
      const stats = match.stats[p.id];
      if (stats) addMoney(stats, p.team === winner ? winAmount : lossAmount);
    }
    match.pendingPayout = null;
  }

  match.round++;
  match.phase = 'buy';
  match.phaseTimeLeft = BUY_TIME_SEC;
  match.bomb = emptyBomb();

  const spawnIdx: Record<Team, number> = { T: 0, CT: 0 };
  const ts: string[] = [];
  for (const p of Object.values(game.players)) {
    // The fallen lose their gear (and kit); survivors keep everything.
    if (p.hp <= 0) {
      p.slots = defaultLoadout();
      p.activeSlot = 1;
      const stats = match.stats[p.id];
      if (stats) stats.hasDefuseKit = false;
    }
    const spawns = p.team === 'T' ? map.spawnsT : map.spawnsCT;
    const at = spawns[spawnIdx[p.team]++ % spawns.length];
    respawnPlayer(game, p.id, at);
    if (p.team === 'T') ts.push(p.id);
  }

  match.bomb.carrierId = ts[Math.floor(nextRand(game) * ts.length)] ?? null;
  match.targetSite = Math.floor(nextRand(game) * Math.max(map.bombsites.length, 1));
  match.events.push({ type: 'round_start', round: match.round });
}
