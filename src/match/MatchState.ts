// Match structure (Phase 7): round phases, teams, economy, bomb defuse.
// Pure TypeScript on top of core/ — no Phaser. The scene calls updateMatch()
// once per fixed tick (after the simulation step) and drains match.events;
// the future server runs this file unchanged.
import { Buttons } from '../core/types.ts';
import type {
  GameState,
  GrenadeType,
  InputCommand,
  PlayerState,
  SimEvent,
  Team,
  Vec2,
  WeaponId,
  WeaponSlot,
} from '../core/types.ts';
import type { MapData } from '../core/map.ts';
import { spawnZoneRect } from '../core/map.ts';
import { isWall } from '../core/collision.ts';
import { damagePlayer, nextRand, respawnPlayer } from '../core/simulation.ts';
import { defaultLoadout, givePrimary, makeSlot } from '../core/weapons.ts';
import {
  ARMOR_MAX,
  ARMOR_PRICE,
  BOMB_DAMAGE,
  BOMB_DEFUSE_KIT_TIME_SEC,
  BOMB_DEFUSE_RANGE_PX,
  BOMB_DEFUSE_TIME_SEC,
  BOMB_PICKUP_RANGE_PX,
  BOMB_PLANT_TIME_SEC,
  BOMB_RADIUS_PX,
  BOMB_TIMER_SEC,
  BUY_GRACE_SEC,
  BUY_TIME_SEC,
  DEFUSE_KIT_PRICE,
  GRENADES,
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
  WEAPON_DROP_TOSS_PX,
  WEAPON_PICKUP_RANGE_PX,
  WEAPON_SWITCH_TIME,
  WIN_REWARD,
} from '../core/config.ts';

export type MatchPhase = 'warmup' | 'buy' | 'live' | 'round_end' | 'match_end';

export type RoundEndReason = 'elimination' | 'detonation' | 'defusal' | 'time';

export interface PlayerMatchStats {
  kills: number;
  deaths: number;
  money: number;
  hasDefuseKit: boolean;
}

/** A gun lying on the ground (death drop or manual G drop), ammo included. */
export interface DroppedWeapon {
  id: number;
  slot: WeaponSlot;
  pos: Vec2;
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
  /** Sides were just swapped; fires right before the next round_start. */
  | { type: 'halftime' }
  /** winner null = draw (both sides reached roundsToWin − 1). */
  | { type: 'match_end'; winner: Team | null }
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
  /** First team to this many round wins takes the match. */
  roundsToWin: number;
  /** Per-player money at match start (halftime resets back to it). */
  startMoney: number;
  /** Teams switch sides once, after roundsToWin − 1 rounds have been played. */
  sidesSwapped: boolean;
  score: Record<Team, number>;
  lossStreak: Record<Team, number>;
  stats: Record<string, PlayerMatchStats>;
  bomb: BombState;
  /** Guns on the ground this round (cleared at round start). */
  droppedWeapons: DroppedWeapon[];
  nextDropId: number;
  /**
   * Items each player bought this round's buy window — the only things
   * trySell will refund. Cleared at round start, so carried-over and
   * scavenged gear is never sellable.
   */
  purchases: Record<string, BuyItem[]>;
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

export function createMatchState(
  playerIds: string[],
  startMoney: number,
  roundsToWin: number = ROUNDS_TO_WIN,
): MatchState {
  const stats: Record<string, PlayerMatchStats> = {};
  for (const id of playerIds) {
    stats[id] = { kills: 0, deaths: 0, money: startMoney, hasDefuseKit: false };
  }
  return {
    phase: 'warmup',
    phaseTimeLeft: WARMUP_TIME_SEC,
    round: 0,
    roundsToWin,
    startMoney,
    sidesSwapped: false,
    score: { T: 0, CT: 0 },
    lossStreak: { T: 0, CT: 0 },
    stats,
    bomb: emptyBomb(),
    droppedWeapons: [],
    nextDropId: 1,
    purchases: {},
    targetSite: 0,
    lastRound: null,
    pendingPayout: null,
    events: [],
  };
}

/**
 * When buying (and refunding) is allowed: the buy phase, or the first
 * BUY_GRACE_SEC of LIVE while the player is inside their team's spawn zone
 * — mirroring CS's buy time + buy zone. The plant ends the grace early
 * (the round clock freezes then, so time-elapsed alone would never expire).
 */
export function canBuy(
  match: MatchState,
  game: GameState,
  map: MapData,
  playerId: string,
): boolean {
  if (match.phase === 'buy') return true;
  if (match.phase !== 'live' || match.bomb.plantedAt) return false;
  if (ROUND_TIME_SEC - match.phaseTimeLeft > BUY_GRACE_SEC) return false;
  const p = game.players[playerId];
  if (!p) return false;
  const zone = spawnZoneRect(map, p.team);
  return (
    p.pos.x >= zone.x &&
    p.pos.x <= zone.x + zone.width &&
    p.pos.y >= zone.y &&
    p.pos.y <= zone.y + zone.height
  );
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

/** Everything money can buy. */
export type BuyItem = WeaponId | GrenadeType | 'kit' | 'armor';

/**
 * Buy a weapon, armor or a defuse kit while buying is open (see canBuy).
 * Mutates loadout + money and records the purchase (for trySell); returns
 * false (with no change) when the purchase is not allowed.
 */
export function tryBuy(
  match: MatchState,
  game: GameState,
  map: MapData,
  playerId: string,
  item: BuyItem,
): boolean {
  if (!canBuy(match, game, map, playerId)) return false;
  const p = game.players[playerId];
  const stats = match.stats[playerId];
  if (!p || !stats || p.hp <= 0) return false;

  if (item === 'kit') {
    if (p.team !== 'CT' || stats.hasDefuseKit || stats.money < DEFUSE_KIT_PRICE) return false;
    stats.money -= DEFUSE_KIT_PRICE;
    stats.hasDefuseKit = true;
    recordPurchase(match, playerId, item);
    return true;
  }

  if (item === 'armor') {
    if (p.armor >= ARMOR_MAX || stats.money < ARMOR_PRICE) return false;
    stats.money -= ARMOR_PRICE;
    p.armor = ARMOR_MAX;
    recordPurchase(match, playerId, item);
    return true;
  }

  if (item === 'he' || item === 'flash' || item === 'smoke') {
    if (p.grenades.includes(item) || stats.money < GRENADES[item].price) return false;
    stats.money -= GRENADES[item].price;
    p.grenades.push(item);
    recordPurchase(match, playerId, item);
    return true;
  }

  // Never trust the caller: reject anything that isn't a real weapon id.
  // Must be an OWN property — `item in WEAPONS` / `WEAPONS[item]` would match
  // inherited keys like "__proto__" or "toString" and buy a garbage weapon
  // (whose undefined stats then poison the simulation with NaNs).
  if (!Object.prototype.hasOwnProperty.call(WEAPONS, item)) return false;
  const def = WEAPONS[item as WeaponId];
  if (def.slotIndex === 0) return false; // the knife is forever
  if (p.slots[def.slotIndex]?.weaponId === item) return false; // already own it
  if (stats.money < def.price) return false;
  stats.money -= def.price;
  if (def.slotIndex === 2) {
    givePrimary(p, item);
  } else {
    // Secondary upgrade (e.g. pistol → deagle): replace slot 1 and draw it.
    p.slots[1] = makeSlot(item);
    p.activeSlot = 1;
    p.reloadRemaining = 0;
  }
  recordPurchase(match, playerId, item);
  return true;
}

function recordPurchase(match: MatchState, playerId: string, item: BuyItem): void {
  (match.purchases[playerId] ??= []).push(item);
}

/** Is this item refundable for this player right now (bought this round)? */
export function canSell(match: MatchState, playerId: string, item: BuyItem): boolean {
  return (match.purchases[playerId] ?? []).includes(item);
}

/**
 * Refund an item bought this round at full price, while buying is still
 * open. The item must still be in the player's possession (an already
 * thrown grenade or dropped gun is gone for good). Returns false with no
 * change when the sale is not allowed.
 */
export function trySell(
  match: MatchState,
  game: GameState,
  map: MapData,
  playerId: string,
  item: BuyItem,
): boolean {
  if (!canBuy(match, game, map, playerId)) return false;
  const p = game.players[playerId];
  const stats = match.stats[playerId];
  if (!p || !stats || p.hp <= 0) return false;
  const bought = match.purchases[playerId] ?? [];
  const receipt = bought.indexOf(item);
  if (receipt < 0) return false;

  if (item === 'kit') {
    if (!stats.hasDefuseKit) return false;
    stats.hasDefuseKit = false;
    addMoney(stats, DEFUSE_KIT_PRICE);
  } else if (item === 'armor') {
    // Damaged armor (possible during the live grace window) is non-refundable.
    if (p.armor < ARMOR_MAX) return false;
    p.armor = 0;
    addMoney(stats, ARMOR_PRICE);
  } else if (item === 'he' || item === 'flash' || item === 'smoke') {
    const idx = p.grenades.indexOf(item);
    if (idx < 0) return false;
    p.grenades.splice(idx, 1);
    addMoney(stats, GRENADES[item].price);
  } else {
    // Only items tryBuy accepted ever enter purchases, so this is a WeaponId.
    const def = WEAPONS[item as WeaponId];
    if (p.slots[def.slotIndex]?.weaponId !== item) return false;
    if (def.slotIndex === 2) {
      p.slots.length = 2;
    } else {
      p.slots[1] = makeSlot('pistol');
    }
    if (p.activeSlot >= p.slots.length) p.activeSlot = 1;
    p.reloadRemaining = 0;
    addMoney(stats, def.price);
  }
  bought.splice(receipt, 1);
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
        const winner =
          match.score.T >= match.roundsToWin ? 'T' : match.score.CT >= match.roundsToWin ? 'CT' : null;
        const played = match.score.T + match.score.CT;
        // With a halftime swap the match caps at 2·(roundsToWin − 1) rounds;
        // reaching it without a winner is the (roundsToWin−1)-all draw.
        const maxRounds = 2 * (match.roundsToWin - 1);
        if (winner) {
          match.phase = 'match_end';
          match.phaseTimeLeft = 0;
          match.events.push({ type: 'match_end', winner });
        } else if (maxRounds > 0 && played >= maxRounds) {
          match.phase = 'match_end';
          match.phaseTimeLeft = 0;
          match.events.push({ type: 'match_end', winner: null });
        } else {
          if (!match.sidesSwapped && played === match.roundsToWin - 1) {
            swapSides(match, game);
          }
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

    // The victim's best gun hits the ground where they fell (eco scavenging).
    if (victim) dropBestWeapon(match, victim, victim.pos);

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

  updateManualDrops(match, game, cmds, map);
  updateWeaponPickups(match, game);

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

/**
 * A player's connection dropped but their seat is being held (reconnect
 * grace window): the avatar dies silently — best gun and bomb hit the
 * ground, any plant/defuse is cancelled — but stats/money stay untouched,
 * so a returning player re-enters exactly like a mid-round joiner.
 */
export function handlePlayerDisconnect(match: MatchState, game: GameState, id: string): void {
  const p = game.players[id];
  if (!p) return;
  if (p.hp > 0) {
    dropBestWeapon(match, p, p.pos);
    p.hp = 0;
  }
  if (match.bomb.carrierId === id) {
    match.bomb.carrierId = null;
    match.bomb.droppedAt = { x: p.pos.x, y: p.pos.y };
    match.events.push({ type: 'bomb_dropped', pos: { ...match.bomb.droppedAt } });
  }
  if (match.bomb.plant?.playerId === id) match.bomb.plant = null;
  if (match.bomb.defuse?.playerId === id) match.bomb.defuse = null;
}

/** The knife (slot 0) and the default pistol never drop. */
function droppableSlotIndex(p: PlayerState): number {
  if (p.slots[2]) return 2;
  if (p.slots[1] && p.slots[1].weaponId !== 'pistol') return 1;
  return -1;
}

/** Take the slot out of the player's loadout and put it on the ground. */
function dropSlot(match: MatchState, p: PlayerState, slotIndex: number, at: Vec2): void {
  const slot = p.slots[slotIndex];
  match.droppedWeapons.push({ id: match.nextDropId++, slot: { ...slot }, pos: { x: at.x, y: at.y } });
  if (slotIndex === 2) {
    p.slots.length = 2;
  } else {
    p.slots[1] = makeSlot('pistol');
  }
  if (p.activeSlot >= p.slots.length) p.activeSlot = 1;
  p.reloadRemaining = 0;
}

/** On death: the most valuable gun (primary, else upgraded secondary) drops. */
function dropBestWeapon(match: MatchState, p: PlayerState, at: Vec2): void {
  const idx = droppableSlotIndex(p);
  if (idx >= 0) dropSlot(match, p, idx, at);
}

/** G drops the active weapon, tossed ahead so the dropper walks off it. */
function updateManualDrops(
  match: MatchState,
  game: GameState,
  cmds: Record<string, InputCommand>,
  map: MapData,
): void {
  for (const p of Object.values(game.players)) {
    if (p.hp <= 0) continue;
    const cmd = cmds[p.id];
    if (!cmd || (cmd.buttons & Buttons.Drop) === 0) continue;
    // Only the active weapon drops, and only if it's droppable.
    if (p.activeSlot !== droppableSlotIndex(p)) continue;

    let at: Vec2 = {
      x: p.pos.x + Math.cos(p.angle) * WEAPON_DROP_TOSS_PX,
      y: p.pos.y + Math.sin(p.angle) * WEAPON_DROP_TOSS_PX,
    };
    const ts = map.grid.tileSize;
    if (isWall(map.grid, Math.floor(at.x / ts), Math.floor(at.y / ts))) at = { ...p.pos };
    dropSlot(match, p, p.activeSlot, at);
    // Deliberate swap to the next weapon — same lockout as a manual switch.
    p.fireCooldown = Math.max(p.fireCooldown, WEAPON_SWITCH_TIME);
  }
}

/** Walking over a dropped gun picks it up when the matching slot is free. */
function updateWeaponPickups(match: MatchState, game: GameState): void {
  if (match.droppedWeapons.length === 0) return;
  for (const p of Object.values(game.players)) {
    if (p.hp <= 0) continue;
    for (let i = 0; i < match.droppedWeapons.length; i++) {
      const drop = match.droppedWeapons[i];
      const def = WEAPONS[drop.slot.weaponId];
      // "Slot free" = no primary, or still carrying the default pistol.
      const canTake =
        def.slotIndex === 2 ? !p.slots[2] : def.slotIndex === 1 && p.slots[1].weaponId === 'pistol';
      if (!canTake) continue;
      if (Math.hypot(p.pos.x - drop.pos.x, p.pos.y - drop.pos.y) > WEAPON_PICKUP_RANGE_PX) continue;
      p.slots[def.slotIndex] = { ...drop.slot };
      match.droppedWeapons.splice(i, 1);
      i--;
    }
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
  // Blast deaths are emitted mid-updateMatch — after the caller took its
  // tickEvents slice — and next tick's slice starts past them, so they must
  // be processed here or they never reach processDeaths (no death stat, no
  // kill event, no weapon drop).
  const evStart = game.events.length;
  for (const p of Object.values(game.players)) {
    if (p.hp <= 0) continue;
    const dist = Math.hypot(p.pos.x - at.x, p.pos.y - at.y);
    if (dist >= BOMB_RADIUS_PX) continue;
    const dmg = Math.round(BOMB_DAMAGE * (1 - dist / BOMB_RADIUS_PX));
    damagePlayer(game, p.id, dmg, 'bomb');
  }
  processDeaths(match, game, game.events.slice(evStart));
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
 * Halftime: every player switches team, scores follow the players to their
 * new side, and the economy restarts (start money, no gear, streaks cleared)
 * so the second half opens like round 1. The following startRound() respawns
 * everyone at their new team's spawns.
 */
function swapSides(match: MatchState, game: GameState): void {
  match.sidesSwapped = true;
  for (const p of Object.values(game.players)) {
    p.team = p.team === 'T' ? 'CT' : 'T';
    p.slots = defaultLoadout();
    p.activeSlot = 1;
    p.armor = 0;
    p.grenades = [];
  }
  const t = match.score.T;
  match.score.T = match.score.CT;
  match.score.CT = t;
  match.lossStreak = { T: 0, CT: 0 };
  match.pendingPayout = null;
  for (const stats of Object.values(match.stats)) {
    stats.money = match.startMoney;
    stats.hasDefuseKit = false;
  }
  match.events.push({ type: 'halftime' });
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
  match.droppedWeapons = [];
  match.purchases = {};

  const spawnIdx: Record<Team, number> = { T: 0, CT: 0 };
  const ts: string[] = [];
  for (const p of Object.values(game.players)) {
    // The fallen lose their gear (armor, kit, grenades); survivors keep it.
    if (p.hp <= 0) {
      p.slots = defaultLoadout();
      p.activeSlot = 1;
      p.armor = 0;
      p.grenades = [];
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
