import Phaser from 'phaser';
import { parseTiledMap } from '../../core/map';
import type { MapData, TiledMap } from '../../core/map';
import { WORLD } from '../theme';

export const MAP_KEY = 'de_yard';
/** Playable maps — every key has `assets/maps/<key>.json` (same tileset). */
export const MAPS = ['de_yard', 'de_split', 'de_cross', 'de_docks'];
export const TILESET_KEY = 'tiles';

export interface LoadedMap {
  data: MapData;
  tilemap: Phaser.Tilemaps.Tilemap;
}

/** Queue map assets — call from BootScene.preload(). */
export function preloadMapAssets(scene: Phaser.Scene): void {
  scene.load.image(TILESET_KEY, 'assets/maps/tiles.png');
  for (const key of MAPS) {
    scene.load.tilemapTiledJSON(key, `assets/maps/${key}.json`);
  }
}

/**
 * Build the render-side tilemap layers and extract the plain MapData
 * (collision grid, wall segments, spawns, bombsites) for the simulation.
 */
export function loadMap(scene: Phaser.Scene, key: string = MAP_KEY): LoadedMap {
  const tilemap = scene.make.tilemap({ key });
  const tileset = tilemap.addTilesetImage('tiles', TILESET_KEY);
  if (!tileset) throw new Error(`Tileset "tiles" not found in map "${key}"`);
  // Explicit depths so decals (2) sit above the floor but under walls.
  tilemap.createLayer('floor', tileset)?.setDepth(0);
  tilemap.createLayer('walls', tileset)?.setDepth(3);

  const raw = scene.cache.tilemap.get(key).data as TiledMap;
  const data = parseTiledMap(raw);

  const siteLineCss = `#${WORLD.siteLine.toString(16).padStart(6, '0')}`;
  const boundary = scene.add.graphics().setDepth(4);
  for (const site of data.bombsites) {
    // Giant low-alpha letter + dashed boundary: "objective ground", readable
    // even at the fog edge.
    scene.add
      .text(site.x + site.width / 2, site.y + site.height / 2, site.name, {
        fontFamily: "'IBM Plex Sans Condensed', sans-serif",
        fontSize: '84px',
        fontStyle: '700',
        color: siteLineCss,
      })
      .setOrigin(0.5)
      .setAlpha(0.3)
      .setDepth(4);
    boundary.lineStyle(2, WORLD.siteLine, 0.55);
    drawDashedRect(boundary, site.x, site.y, site.width, site.height, 10, 7);
  }

  return { data, tilemap };
}

function drawDashedRect(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  dash: number,
  gap: number,
): void {
  const edges: [number, number, number, number][] = [
    [x, y, x + w, y],
    [x + w, y, x + w, y + h],
    [x + w, y + h, x, y + h],
    [x, y + h, x, y],
  ];
  for (const [x0, y0, x1, y1] of edges) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const ux = (x1 - x0) / len;
    const uy = (y1 - y0) / len;
    for (let d = 0; d < len; d += dash + gap) {
      const e = Math.min(d + dash, len);
      g.lineBetween(x0 + ux * d, y0 + uy * d, x0 + ux * e, y0 + uy * e);
    }
  }
}
