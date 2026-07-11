import type { MapGrid, Vec2 } from './types.ts';

/** Tiles outside the grid are treated as solid. */
export function isWall(grid: MapGrid, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) return true;
  return grid.cells[ty][tx] !== 0;
}

const MAX_ITERATIONS = 3;

/**
 * Push a circle out of any solid tiles it overlaps, mutating `pos`.
 * Push direction is from the closest point on the tile AABB toward the
 * circle center, so contacts with a wall face resolve purely along the
 * normal — the tangential velocity survives and the player slides.
 */
export function resolveCircleGrid(pos: Vec2, radius: number, grid: MapGrid): void {
  const ts = grid.tileSize;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let corrected = false;

    const minTx = Math.floor((pos.x - radius) / ts);
    const maxTx = Math.floor((pos.x + radius) / ts);
    const minTy = Math.floor((pos.y - radius) / ts);
    const maxTy = Math.floor((pos.y + radius) / ts);

    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        if (!isWall(grid, tx, ty)) continue;

        const left = tx * ts;
        const top = ty * ts;
        const cx = Math.max(left, Math.min(pos.x, left + ts));
        const cy = Math.max(top, Math.min(pos.y, top + ts));
        const dx = pos.x - cx;
        const dy = pos.y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 >= radius * radius) continue;

        if (d2 > 1e-9) {
          // Internal-edge culling: when the closest point is a tile corner
          // shared with another solid tile, the wall face continues past it —
          // suppress the push component along the shared edge, or the circle
          // catches phantom corners while sliding along a flat wall.
          const onLeft = cx === left;
          const onRight = cx === left + ts;
          const onTop = cy === top;
          const onBottom = cy === top + ts;
          let nx = dx;
          let ny = dy;
          if ((onLeft || onRight) && (onTop || onBottom)) {
            const hNeighborSolid = isWall(grid, tx + (onLeft ? -1 : 1), ty);
            const vNeighborSolid = isWall(grid, tx, ty + (onTop ? -1 : 1));
            if (hNeighborSolid && vNeighborSolid) continue;
            if (vNeighborSolid) ny = 0;
            else if (hNeighborSolid) nx = 0;
          }
          if (ny === 0 && nx !== 0) {
            pos.x += Math.sign(nx) * (radius - Math.abs(nx));
          } else if (nx === 0 && ny !== 0) {
            pos.y += Math.sign(ny) * (radius - Math.abs(ny));
          } else if (nx !== 0 || ny !== 0) {
            const d = Math.hypot(nx, ny);
            const push = radius - d;
            pos.x += (nx / d) * push;
            pos.y += (ny / d) * push;
          } else {
            continue;
          }
        } else {
          // Center is inside the tile — push out along the shallowest axis.
          const outLeft = pos.x - left;
          const outRight = left + ts - pos.x;
          const outTop = pos.y - top;
          const outBottom = top + ts - pos.y;
          const m = Math.min(outLeft, outRight, outTop, outBottom);
          if (m === outLeft) pos.x = left - radius;
          else if (m === outRight) pos.x = left + ts + radius;
          else if (m === outTop) pos.y = top - radius;
          else pos.y = top + ts + radius;
        }
        corrected = true;
      }
    }

    if (!corrected) return;
  }
}
