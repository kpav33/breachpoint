// Visibility polygon + line-of-sight checks. Pure math — the client uses
// it for fog-of-war rendering, bots (Phase 6) and the server (Phase 9)
// reuse canSee() for their own vision decisions.
// Reference: Red Blob Games, "2D Visibility".
import type { Segment, SmokeState, Vec2 } from './types.ts';
import { castRay } from './raycast.ts';
import {
  AWARENESS_RADIUS,
  PLAYER_RADIUS,
  SMOKE_RADIUS_PX,
  VISION_CONE_DEG,
  VISION_RANGE,
} from './config.ts';

const DEG_TO_RAD = Math.PI / 180;
/** Corner rays are cast at angle ± this epsilon so the polygon hugs edges. */
const CORNER_EPS = 1e-4;
/** Extra rays every N radians so the max-range arc isn't coarse chords. */
const ARC_STEP = 6 * DEG_TO_RAD;

/** Wrap to [-π, π]. */
export function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * Smoke clouds as temporary wall segments (octagons) for the vision system.
 * Smoke blocks sight only — bullets and movement pass through, so these
 * segments are consumed by vision/canSee, never by the shot raycast.
 */
export function smokeSegments(smokes: SmokeState[]): Segment[] {
  const segs: Segment[] = [];
  for (const s of smokes) {
    const n = 8;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      segs.push({
        a: { x: s.pos.x + Math.cos(a0) * SMOKE_RADIUS_PX, y: s.pos.y + Math.sin(a0) * SMOKE_RADIUS_PX },
        b: { x: s.pos.x + Math.cos(a1) * SMOKE_RADIUS_PX, y: s.pos.y + Math.sin(a1) * SMOKE_RADIUS_PX },
      });
    }
  }
  return segs;
}

function segDistSq(p: Vec2, seg: Segment): number {
  const ex = seg.b.x - seg.a.x;
  const ey = seg.b.y - seg.a.y;
  const lenSq = ex * ex + ey * ey;
  let t = lenSq > 0 ? ((p.x - seg.a.x) * ex + (p.y - seg.a.y) * ey) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = p.x - (seg.a.x + ex * t);
  const dy = p.y - (seg.a.y + ey * t);
  return dx * dx + dy * dy;
}

export interface VisionOptions {
  /** Ignore the cone and see 360°. */
  fullCircle?: boolean;
  maxDist?: number;
}

export interface VisionResult {
  /** In cone mode the fan starts at the origin; full-circle omits it. */
  polygon: Vec2[];
  /** Raw rays (relative angle + hit distance) for the debug overlay. */
  rays: { angle: number; dist: number }[];
}

/**
 * Visibility polygon around `origin`, restricted to the view cone unless
 * fullCircle. Rays go to every nearby segment corner (± ε), the cone
 * boundaries, and evenly spaced arc fillers; hits sorted by angle form the
 * polygon. Cone clipping falls out of construction — no polygon clipping.
 */
export function visibilityPolygon(
  origin: Vec2,
  aimAngle: number,
  segments: Segment[],
  opts: VisionOptions = {},
): VisionResult {
  const full = opts.fullCircle ?? false;
  const maxDist = opts.maxDist ?? VISION_RANGE;
  const half = full ? Math.PI : (VISION_CONE_DEG * DEG_TO_RAD) / 2;

  const nearSq = maxDist * maxDist;
  const near = segments.filter((s) => segDistSq(origin, s) <= nearSq);

  // Candidate ray angles, relative to aim, within [-half, half].
  const rel: number[] = [];
  for (const seg of near) {
    for (const corner of [seg.a, seg.b]) {
      const a = wrapAngle(Math.atan2(corner.y - origin.y, corner.x - origin.x) - aimAngle);
      for (const c of [a - CORNER_EPS, a, a + CORNER_EPS]) {
        if (Math.abs(c) <= half) rel.push(c);
      }
    }
  }
  for (let a = -half; a < half; a += ARC_STEP) rel.push(a);
  rel.push(half);
  if (full) rel.push(-Math.PI, Math.PI); // seam of the wrap

  rel.sort((a, b) => a - b);

  const polygon: Vec2[] = full ? [] : [origin];
  const rays: VisionResult['rays'] = [];
  let prev = Infinity;
  for (const a of rel) {
    if (Math.abs(a - prev) < 1e-6) continue;
    prev = a;
    const hit = castRay(origin, aimAngle + a, near, maxDist);
    polygon.push(hit.point);
    rays.push({ angle: a, dist: hit.dist });
  }
  return { polygon, rays };
}

/**
 * Can `viewer` see a point at `target`? True when the target is inside the
 * awareness circle, or inside the view cone and range — and in both cases
 * no wall blocks the line of sight. Same rules the fog-of-war renders.
 */
export function canSee(
  viewer: { pos: Vec2; angle: number },
  target: Vec2,
  segments: Segment[],
  fullCircle = false,
): boolean {
  const dx = target.x - viewer.pos.x;
  const dy = target.y - viewer.pos.y;
  const dist = Math.hypot(dx, dy);
  if (dist > VISION_RANGE) return false;

  const inAwareness = dist <= AWARENESS_RADIUS;
  if (!inAwareness && !fullCircle) {
    const rel = wrapAngle(Math.atan2(dy, dx) - viewer.angle);
    if (Math.abs(rel) > (VISION_CONE_DEG * DEG_TO_RAD) / 2) return false;
  }

  if (dist < 1) return true;
  // Aim at the target center but stop short by a body radius, so a target
  // peeking a corner with its center barely exposed still reads as seen.
  const ray = castRay(
    viewer.pos,
    Math.atan2(dy, dx),
    segments,
    Math.max(dist - PLAYER_RADIUS, 0),
  );
  return !ray.hitWall;
}
