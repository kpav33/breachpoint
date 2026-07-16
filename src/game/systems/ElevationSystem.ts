import Phaser from 'phaser';
import type { MapGrid, Vec2 } from '../../core/types';
import { isWall } from '../../core/collision';
import { WALL_EXTRUDE, WORLD } from '../theme';
import { GAME_WIDTH, GAME_HEIGHT, screenX, screenY } from '../display';

/** Above players (5) and tracers (10), below smoke (40) and fog (50). */
const WALL_DEPTH = 20;
/**
 * Second, low-alpha copy above the fog (50): inside the vision polygon it
 * blends invisibly into the identical full-color pass below, but in fogged
 * areas the raised blocks still read as faint silhouettes — without it the
 * whole effect hides exactly where the fog is (extrusion grows with distance
 * from the screen center, which is where vision ends).
 */
const GHOST_DEPTH = 52;
const GHOST_ALPHA = 0.3;
/** Cull margin beyond the camera view — covers the largest top displacement. */
const VIEW_MARGIN_PX = 140;

interface WallRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 2.5D look (Phase 10 prototype): fake wall height, GTA1/Hotline Miami
 * style. The sim, fog, aiming and minimap all stay strictly top-down —
 * this class only *draws* walls as extruded blocks whose tops shear away
 * from the camera center, redrawn per frame as the camera moves. Toggle
 * off (F7) to fall back to the flat tilemap walls layer.
 */
export class ElevationSystem {
  enabled = true;

  private readonly gfx: Phaser.GameObjects.Graphics;
  /**
   * Ghost pass compositing: the geometry is stamped *opaquely* into a
   * screen-sized RenderTexture whose object alpha does the fading. Drawing
   * translucent shapes directly would stack alpha wherever faces overlap
   * and every internal seam of a wall mass would glow through the fog.
   */
  private readonly ghostRT: Phaser.GameObjects.RenderTexture;
  private readonly ghostStamp: Phaser.GameObjects.Graphics;
  private readonly rects: WallRect[];
  /** The flat tilemap walls layer, hidden while extrusion is on. */
  private readonly flatWalls: Phaser.Tilemaps.TilemapLayer | null;

  constructor(
    scene: Phaser.Scene,
    grid: MapGrid,
    flatWalls: Phaser.Tilemaps.TilemapLayer | null,
  ) {
    this.gfx = scene.add.graphics().setDepth(WALL_DEPTH);
    this.ghostRT = scene.add
      .renderTexture(screenX(0), screenY(0), GAME_WIDTH, GAME_HEIGHT)
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(GHOST_DEPTH)
      .setAlpha(GHOST_ALPHA);
    this.ghostStamp = scene.make.graphics(undefined, false);
    this.rects = meshWallRects(grid);
    this.flatWalls = flatWalls;
  }

  /**
   * Redraw for this frame. `center` is the perspective origin — the followed
   * player's render position (NOT the camera midpoint: when the camera is
   * clamped at map bounds those differ, and camera-centered shear makes
   * nearby wall tops overhang the player). `view` is the camera world rect.
   */
  update(center: Vec2, view: Phaser.Geom.Rectangle): void {
    this.flatWalls?.setVisible(!this.enabled);
    this.gfx.clear();
    this.ghostRT.clear();
    if (!this.enabled) return;

    const minX = view.x - VIEW_MARGIN_PX;
    const minY = view.y - VIEW_MARGIN_PX;
    const maxX = view.right + VIEW_MARGIN_PX;
    const maxY = view.bottom + VIEW_MARGIN_PX;
    const visible: WallRect[] = [];
    for (const r of this.rects) {
      if (r.x + r.w >= minX && r.x <= maxX && r.y + r.h >= minY && r.y <= maxY) {
        visible.push(r);
      }
    }

    this.draw(this.gfx, visible, center, 1);
    this.ghostStamp.clear();
    this.draw(this.ghostStamp, visible, center, 1);
    this.ghostRT.draw(this.ghostStamp, -view.x, -view.y);
  }

  private draw(
    g: Phaser.GameObjects.Graphics,
    rects: WallRect[],
    center: Vec2,
    alpha: number,
  ): void {
    const px = (wx: number): number => wx + (wx - center.x) * WALL_EXTRUDE;
    const py = (wy: number): number => wy + (wy - center.y) * WALL_EXTRUDE;

    // Pass 1 — side faces, only the ones facing the camera center. N/S faces
    // take the lighter wall tone, E/W the dark one (simple fixed lighting).
    for (const r of rects) {
      const x0 = r.x;
      const y0 = r.y;
      const x1 = r.x + r.w;
      const y1 = r.y + r.h;
      if (center.y < y0) {
        g.fillStyle(WORLD.wall, alpha);
        g.fillPoints(quad(x0, y0, x1, y0, px, py), true);
      } else if (center.y > y1) {
        g.fillStyle(WORLD.wall, alpha);
        g.fillPoints(quad(x1, y1, x0, y1, px, py), true);
      }
      if (center.x < x0) {
        g.fillStyle(WORLD.wallDark, alpha);
        g.fillPoints(quad(x0, y1, x0, y0, px, py), true);
      } else if (center.x > x1) {
        g.fillStyle(WORLD.wallDark, alpha);
        g.fillPoints(quad(x1, y0, x1, y1, px, py), true);
      }
    }

    // Pass 2 — tops. Drawn after every side so height always wins overlaps.
    for (const r of rects) {
      const pts = [
        new Phaser.Geom.Point(px(r.x), py(r.y)),
        new Phaser.Geom.Point(px(r.x + r.w), py(r.y)),
        new Phaser.Geom.Point(px(r.x + r.w), py(r.y + r.h)),
        new Phaser.Geom.Point(px(r.x), py(r.y + r.h)),
      ];
      g.fillStyle(WORLD.wallTop, alpha);
      g.fillPoints(pts, true);
      g.lineStyle(1, WORLD.wallDark, 0.9 * alpha);
      g.strokePoints(pts, true, true);
    }
  }
}

/** Quad between a base edge (a→b) and its projected top edge. */
function quad(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: (x: number) => number,
  py: (y: number) => number,
): Phaser.Geom.Point[] {
  return [
    new Phaser.Geom.Point(ax, ay),
    new Phaser.Geom.Point(bx, by),
    new Phaser.Geom.Point(px(bx), py(by)),
    new Phaser.Geom.Point(px(ax), py(ay)),
  ];
}

/** Greedy-mesh the wall tiles into maximal rectangles (world px). */
function meshWallRects(grid: MapGrid): WallRect[] {
  const ts = grid.tileSize;
  const used: boolean[][] = Array.from({ length: grid.height }, () =>
    new Array<boolean>(grid.width).fill(false),
  );
  const rects: WallRect[] = [];

  for (let ty = 0; ty < grid.height; ty++) {
    for (let tx = 0; tx < grid.width; tx++) {
      if (used[ty][tx] || !isWall(grid, tx, ty)) continue;
      // Grow right, then grow the whole run down while every cell is wall.
      let w = 1;
      while (tx + w < grid.width && !used[ty][tx + w] && isWall(grid, tx + w, ty)) w++;
      let h = 1;
      grow: while (ty + h < grid.height) {
        for (let i = 0; i < w; i++) {
          if (used[ty + h][tx + i] || !isWall(grid, tx + i, ty + h)) break grow;
        }
        h++;
      }
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) used[ty + dy][tx + dx] = true;
      }
      rects.push({ x: tx * ts, y: ty * ts, w: w * ts, h: h * ts });
    }
  }
  return rects;
}
