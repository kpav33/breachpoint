// Shared ray math for gunfire (Phase 3) and the vision system (Phase 4).
import type { Segment, Vec2 } from './types.ts';

/**
 * Distance along a ray (origin + t·dir, dir unit-length) to a segment,
 * or null if it misses.
 */
export function raySegmentDist(origin: Vec2, dir: Vec2, seg: Segment): number | null {
  const ex = seg.b.x - seg.a.x;
  const ey = seg.b.y - seg.a.y;
  const denom = dir.x * ey - dir.y * ex;
  if (Math.abs(denom) < 1e-12) return null; // parallel
  const wx = seg.a.x - origin.x;
  const wy = seg.a.y - origin.y;
  const t = (wx * ey - wy * ex) / denom;
  const s = (dir.y * wx - dir.x * wy) / denom;
  if (t < 0 || s < 0 || s > 1) return null;
  return t;
}

export interface RayHit {
  dist: number;
  point: Vec2;
  /** False when the ray reached maxDist without touching a wall. */
  hitWall: boolean;
}

/** Nearest wall hit along the ray, clamped to maxDist. */
export function castRay(
  origin: Vec2,
  angle: number,
  segments: Segment[],
  maxDist: number,
): RayHit {
  const dir = { x: Math.cos(angle), y: Math.sin(angle) };
  let nearest = maxDist;
  let hitWall = false;
  for (const seg of segments) {
    const t = raySegmentDist(origin, dir, seg);
    if (t !== null && t < nearest) {
      nearest = t;
      hitWall = true;
    }
  }
  return {
    dist: nearest,
    point: { x: origin.x + dir.x * nearest, y: origin.y + dir.y * nearest },
    hitWall,
  };
}

/**
 * Distance along a ray to a circle, or null if it misses (or the origin is
 * already past the circle). Standard quadratic; dir must be unit-length.
 */
export function rayCircleDist(
  origin: Vec2,
  dir: Vec2,
  center: Vec2,
  radius: number,
): number | null {
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const b = ox * dir.x + oy * dir.y;
  const c = ox * ox + oy * oy - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : null;
}
