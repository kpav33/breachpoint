// A* over the tile collision grid + raycast path smoothing (Phase 6).
// Pure math — bots consume it client-side today, the server reuses it later.
import type { MapGrid, Segment, Vec2 } from './types.ts';
import { isWall } from './collision.ts';
import { raySegmentDist } from './raycast.ts';

function tileCenter(grid: MapGrid, tx: number, ty: number): Vec2 {
  return { x: (tx + 0.5) * grid.tileSize, y: (ty + 0.5) * grid.tileSize };
}

/** Octile distance — admissible heuristic for 8-directional movement. */
function octile(dx: number, dy: number): number {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  return Math.max(ax, ay) + (Math.SQRT2 - 1) * Math.min(ax, ay);
}

// 8 neighbor offsets; diagonals carry the corner-cut check in findPath.
const DIRS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
] as const;

/**
 * Nearest walkable tile to (tx, ty) within `maxRadius` rings, or null.
 * Goals can land inside solid tiles (a heard gunshot's muzzle point, a
 * bombsite center occupied by a crate) — snap them out instead of failing.
 */
function nearestWalkable(
  grid: MapGrid,
  tx: number,
  ty: number,
  maxRadius: number,
): { tx: number; ty: number } | null {
  if (!isWall(grid, tx, ty)) return { tx, ty };
  for (let r = 1; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
        if (!isWall(grid, tx + dx, ty + dy)) return { tx: tx + dx, ty: ty + dy };
      }
    }
  }
  return null;
}

/**
 * Nearest walkable tile center to a world point (the point itself may be
 * inside a wall — e.g. a bombsite center occupied by a crate).
 */
export function walkablePointNear(grid: MapGrid, pos: Vec2, maxRadius = 4): Vec2 | null {
  const ts = grid.tileSize;
  const t = nearestWalkable(grid, Math.floor(pos.x / ts), Math.floor(pos.y / ts), maxRadius);
  return t ? tileCenter(grid, t.tx, t.ty) : null;
}

/**
 * A* from `start` to `goal` (both world px). Diagonals allowed only when
 * both adjacent orthogonal tiles are walkable (no corner cutting). A goal
 * inside a solid tile snaps to the nearest walkable one. Returns waypoints
 * at tile centers — the start tile is omitted, and the exact `goal` replaces
 * the goal tile's center when it wasn't snapped — or null when unreachable.
 */
export function findPath(grid: MapGrid, start: Vec2, goal: Vec2): Vec2[] | null {
  const ts = grid.tileSize;
  const startSnap = nearestWalkable(grid, Math.floor(start.x / ts), Math.floor(start.y / ts), 1);
  if (!startSnap) return null;
  const { tx: sx, ty: sy } = startSnap;
  const snapped = nearestWalkable(grid, Math.floor(goal.x / ts), Math.floor(goal.y / ts), 3);
  if (!snapped) return null;
  const { tx: gx, ty: gy } = snapped;
  const end =
    gx === Math.floor(goal.x / ts) && gy === Math.floor(goal.y / ts)
      ? { x: goal.x, y: goal.y }
      : tileCenter(grid, gx, gy);
  if (sx === gx && sy === gy) return [end];

  const w = grid.width;
  const size = w * grid.height;
  const startIdx = sy * w + sx;
  const goalIdx = gy * w + gx;

  const gScore = new Float64Array(size).fill(Infinity);
  const fScore = new Float64Array(size).fill(Infinity);
  const cameFrom = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);

  // Binary min-heap over fScore, storing node indices.
  const heap: number[] = [startIdx];
  const push = (idx: number): void => {
    heap.push(idx);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (fScore[heap[parent]] <= fScore[heap[i]]) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  };
  const pop = (): number => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && fScore[heap[l]] < fScore[heap[m]]) m = l;
        if (r < heap.length && fScore[heap[r]] < fScore[heap[m]]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };

  gScore[startIdx] = 0;
  fScore[startIdx] = octile(gx - sx, gy - sy);

  while (heap.length > 0) {
    const cur = pop();
    if (cur === goalIdx) break;
    if (closed[cur]) continue; // stale duplicate heap entry
    closed[cur] = 1;

    const cx = cur % w;
    const cy = (cur - cx) / w;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (isWall(grid, nx, ny)) continue;
      // Corner-cut check: a diagonal step needs both orthogonals open.
      if (dx !== 0 && dy !== 0 && (isWall(grid, cx + dx, cy) || isWall(grid, cx, cy + dy)))
        continue;
      const nIdx = ny * w + nx;
      if (closed[nIdx]) continue;
      const tentative = gScore[cur] + (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1);
      if (tentative >= gScore[nIdx]) continue;
      gScore[nIdx] = tentative;
      fScore[nIdx] = tentative + octile(gx - nx, gy - ny);
      cameFrom[nIdx] = cur;
      push(nIdx);
    }
  }

  if (cameFrom[goalIdx] < 0) return null;

  const path: Vec2[] = [end];
  for (let idx = cameFrom[goalIdx]; idx !== startIdx && idx >= 0; idx = cameFrom[idx]) {
    const tx = idx % w;
    path.push(tileCenter(grid, tx, (idx - tx) / w));
  }
  return path.reverse();
}

/**
 * Can a circle of `radius` travel a→b without crossing a wall? Three
 * parallel rays: the center line plus one at each side of the body.
 */
export function pathClear(a: Vec2, b: Vec2, segments: Segment[], radius: number): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return true;
  const dir = { x: dx / len, y: dy / len };
  for (const off of [-radius, 0, radius]) {
    const origin = { x: a.x - dir.y * off, y: a.y + dir.x * off };
    for (const seg of segments) {
      const t = raySegmentDist(origin, dir, seg);
      if (t !== null && t < len) return false;
    }
  }
  return true;
}

/**
 * Greedy smoothing: from each kept waypoint, skip ahead to the farthest
 * waypoint reachable in a straight (clearance-checked) line.
 */
export function smoothPath(path: Vec2[], segments: Segment[], radius: number): Vec2[] {
  if (path.length <= 2) return path;
  const out: Vec2[] = [path[0]];
  let i = 0;
  while (i < path.length - 1) {
    let j = path.length - 1;
    while (j > i + 1 && !pathClear(path[i], path[j], segments, radius)) j--;
    out.push(path[j]);
    i = j;
  }
  return out;
}
