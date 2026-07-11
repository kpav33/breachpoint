// Pure map-data parsing: Tiled JSON → MapData. No Phaser here — the future
// server loads the same JSON and runs this same code. Phaser-side rendering
// of the tilemap lives in game/map/MapLoader.ts.
import type { MapGrid, Segment, Vec2 } from './types.ts';
import { isWall } from './collision.ts';

export interface BombsiteRect {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MapData {
  grid: MapGrid;
  /** Merged wall edges for raycasting/vision (Phase 3/4). */
  segments: Segment[];
  spawnsT: Vec2[];
  spawnsCT: Vec2[];
  bombsites: BombsiteRect[];
}

// Minimal slice of the Tiled JSON format that we consume.
interface TiledObject {
  name: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
}
interface TiledLayer {
  name: string;
  type: string;
  data?: number[];
  objects?: TiledObject[];
}
export interface TiledMap {
  width: number;
  height: number;
  tilewidth: number;
  layers: TiledLayer[];
}

export function parseTiledMap(map: TiledMap): MapData {
  const layer = (name: string): TiledLayer => {
    const found = map.layers.find((l) => l.name === name);
    if (!found) throw new Error(`Map is missing required layer "${name}"`);
    return found;
  };

  const walls = layer('walls');
  const cells: number[][] = [];
  for (let y = 0; y < map.height; y++) {
    const row = new Array<number>(map.width);
    for (let x = 0; x < map.width; x++) {
      row[x] = walls.data![y * map.width + x] !== 0 ? 1 : 0;
    }
    cells.push(row);
  }
  const grid: MapGrid = {
    tileSize: map.tilewidth,
    width: map.width,
    height: map.height,
    cells,
  };

  const points = (name: string): Vec2[] =>
    layer(name).objects!.map((o) => ({ x: o.x, y: o.y }));

  return {
    grid,
    segments: buildWallSegments(grid),
    spawnsT: points('spawns_t'),
    spawnsCT: points('spawns_ct'),
    bombsites: layer('bombsites').objects!.map((o) => ({
      name: o.name,
      x: o.x,
      y: o.y,
      width: o.width ?? 0,
      height: o.height ?? 0,
    })),
  };
}

/**
 * Extract the boundary between solid and walkable cells as axis-aligned
 * segments, merging collinear runs so a 10-tile wall face is one segment.
 * Interior faces (solid↔solid, incl. out-of-bounds) produce nothing, so the
 * raycaster/vision only ever sees edges a player could actually look at.
 */
export function buildWallSegments(grid: MapGrid): Segment[] {
  const segs: Segment[] = [];
  const ts = grid.tileSize;

  // Horizontal edges (top and bottom faces of solid cells), merged along x.
  for (let y = 0; y < grid.height; y++) {
    for (const dir of [-1, 1]) {
      let run = -1;
      for (let x = 0; x <= grid.width; x++) {
        const edge = x < grid.width && isWall(grid, x, y) && !isWall(grid, x, y + dir);
        if (edge && run < 0) run = x;
        if (!edge && run >= 0) {
          const ey = (dir === -1 ? y : y + 1) * ts;
          segs.push({ a: { x: run * ts, y: ey }, b: { x: x * ts, y: ey } });
          run = -1;
        }
      }
    }
  }
  // Vertical edges (left and right faces), merged along y.
  for (let x = 0; x < grid.width; x++) {
    for (const dir of [-1, 1]) {
      let run = -1;
      for (let y = 0; y <= grid.height; y++) {
        const edge = y < grid.height && isWall(grid, x, y) && !isWall(grid, x + dir, y);
        if (edge && run < 0) run = y;
        if (!edge && run >= 0) {
          const ex = (dir === -1 ? x : x + 1) * ts;
          segs.push({ a: { x: ex, y: run * ts }, b: { x: ex, y: y * ts } });
          run = -1;
        }
      }
    }
  }
  return segs;
}
