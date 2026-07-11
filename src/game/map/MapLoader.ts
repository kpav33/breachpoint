import Phaser from 'phaser';
import { parseTiledMap } from '../../core/map';
import type { MapData, TiledMap } from '../../core/map';

export const MAP_KEY = 'de_yard';
export const TILESET_KEY = 'tiles';

export interface LoadedMap {
  data: MapData;
  tilemap: Phaser.Tilemaps.Tilemap;
}

/** Queue map assets — call from BootScene.preload(). */
export function preloadMapAssets(scene: Phaser.Scene): void {
  scene.load.image(TILESET_KEY, 'assets/maps/tiles.png');
  scene.load.tilemapTiledJSON(MAP_KEY, 'assets/maps/de_yard.json');
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

  for (const site of data.bombsites) {
    scene.add
      .text(site.x + site.width / 2, site.y + site.height / 2, site.name, {
        fontFamily: 'monospace',
        fontSize: '72px',
        color: '#c8a35a',
      })
      .setOrigin(0.5)
      .setAlpha(0.15)
      .setDepth(4);
  }

  return { data, tilemap };
}
