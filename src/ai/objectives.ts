// Standing orders for bots, derived from the current bomb/round state.
// Pure TypeScript shared by the single-player GameScene and the online
// server so bots behave identically in both — no Phaser here.
import type { Vec2 } from '../core/types.ts';
import type { MapData } from '../core/map.ts';
import { walkablePointNear } from '../core/pathfinding.ts';
import { BOMB_DEFUSE_RANGE_PX } from '../core/config.ts';
import type { MatchState } from '../match/MatchState.ts';
import type { BotController } from './BotController.ts';

/** Points bots roam between and the plant/defend anchors per bombsite. */
export interface BotWorld {
  roamPoints: Vec2[];
  /** One per bombsite: its center snapped to a walkable tile. */
  siteAnchors: Vec2[];
}

export function buildBotWorld(map: MapData): BotWorld {
  const roamPoints: Vec2[] = [
    ...map.bombsites.map((s) => ({ x: s.x + s.width / 2, y: s.y + s.height / 2 })),
    ...map.spawnsT,
    ...map.spawnsCT,
  ];
  const siteAnchors = map.bombsites.map((s) => {
    const center = { x: s.x + s.width / 2, y: s.y + s.height / 2 };
    return walkablePointNear(map.grid, center) ?? center;
  });
  return { roamPoints, siteAnchors };
}

/**
 * Assign each bot its objective for this tick. Ids in `tIds`/`ctIds` without a
 * bot (i.e. humans) are skipped, so this works in mixed human/bot matches.
 */
export function assignBotObjectives(
  bots: Record<string, BotController>,
  match: MatchState,
  siteAnchors: Vec2[],
  tIds: string[],
  ctIds: string[],
): void {
  const bomb = match.bomb;
  if (match.phase !== 'live') {
    for (const bot of Object.values(bots)) bot.setObjective(null);
    return;
  }
  const anchor = siteAnchors[match.targetSite] ?? siteAnchors[0];

  let retrieverAssigned = false;
  for (const id of tIds) {
    const bot = bots[id];
    if (!bot) continue;
    if (bomb.carrierId === id && !bomb.plantedAt) {
      bot.setObjective({ pos: anchor, radiusPx: 20, holdUse: true });
    } else if (bomb.droppedAt && !retrieverAssigned) {
      bot.setObjective({ pos: bomb.droppedAt, radiusPx: 6 });
      retrieverAssigned = true;
    } else if (bomb.plantedAt) {
      bot.setObjective({ pos: bomb.plantedAt, radiusPx: 150 });
    } else {
      bot.setObjective({ pos: anchor, radiusPx: 160 });
    }
  }
  ctIds.forEach((id, i) => {
    const bot = bots[id];
    if (!bot) return;
    if (bomb.plantedAt) {
      bot.setObjective({ pos: bomb.plantedAt, radiusPx: BOMB_DEFUSE_RANGE_PX - 15, holdUse: true });
    } else {
      bot.setObjective({ pos: siteAnchors[i % siteAnchors.length], radiusPx: 120 });
    }
  });
}
