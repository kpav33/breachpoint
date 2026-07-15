import Phaser from 'phaser';
import type { Segment, SmokeState, Vec2 } from '../../core/types';
import { AWARENESS_RADIUS, FULL_CIRCLE_VISION } from '../../core/config';
import { smokeSegments, visibilityPolygon } from '../../core/vision';
import type { VisionResult } from '../../core/vision';
import { WORLD } from '../theme';
import { GAME_WIDTH, GAME_HEIGHT, screenX, screenY } from '../display';

/** How dark the unseen world is (0..1). Render-side constant. */
const DARKNESS_ALPHA = 0.86;
/** Recompute thresholds — skip polygon work for sub-pixel/degree changes. */
const MOVE_THRESHOLD = 2;
const ROTATE_THRESHOLD = 0.017; // ~1°

/**
 * Fog of war: a screen-sized darkness layer with the player's vision
 * (cone polygon + wall-clipped awareness circle) erased out of it.
 * Purely render-side — visibility *decisions* come from core/vision.canSee.
 */
export class VisionSystem {
  /** Toggleable at runtime (debug F5); starts from core config. */
  fullCircle = FULL_CIRCLE_VISION;

  /** Last computed polygons + rays, world coords — read by the debug overlay. */
  cone: VisionResult = { polygon: [], rays: [] };
  awareness: VisionResult = { polygon: [], rays: [] };
  recomputes = 0;

  private readonly rt: Phaser.GameObjects.RenderTexture;
  private readonly stamp: Phaser.GameObjects.Graphics;
  private lastOrigin: Vec2 = { x: NaN, y: NaN };
  private lastAim = NaN;
  private lastFullCircle: boolean | null = null;
  private lastSmokeCount = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly segments: Segment[],
  ) {
    this.rt = scene.add
      .renderTexture(screenX(0), screenY(0), GAME_WIDTH, GAME_HEIGHT)
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(50);
    this.stamp = scene.make.graphics(undefined, false);
  }

  /** Call once per frame with the interpolated render position/angle. */
  update(origin: Vec2, aimAngle: number, smokes: SmokeState[] = []): void {
    const moved =
      Math.abs(origin.x - this.lastOrigin.x) > MOVE_THRESHOLD ||
      Math.abs(origin.y - this.lastOrigin.y) > MOVE_THRESHOLD;
    const turned = Math.abs(Phaser.Math.Angle.Wrap(aimAngle - this.lastAim)) > ROTATE_THRESHOLD;
    // While smoke is up, recompute every frame — clouds appear/expire without
    // the viewer moving. Cheap: smoke is rare and brief.
    const smoky = smokes.length > 0 || this.lastSmokeCount > 0;
    if (
      moved ||
      turned ||
      smoky ||
      this.fullCircle !== this.lastFullCircle ||
      Number.isNaN(this.lastAim)
    ) {
      const segs =
        smokes.length > 0 ? [...this.segments, ...smokeSegments(smokes)] : this.segments;
      this.cone = visibilityPolygon(origin, aimAngle, segs, {
        fullCircle: this.fullCircle,
      });
      this.awareness = this.fullCircle
        ? { polygon: [], rays: [] }
        : visibilityPolygon(origin, aimAngle, segs, {
            fullCircle: true,
            maxDist: AWARENESS_RADIUS,
          });
      this.lastOrigin = { x: origin.x, y: origin.y };
      this.lastAim = aimAngle;
      this.lastFullCircle = this.fullCircle;
      this.lastSmokeCount = smokes.length;
      this.recomputes++;
    }

    // Redraw every frame (camera scroll changes even when the polygon
    // doesn't): fill darkness, erase the vision shape in screen space.
    // worldView (not scrollX/Y) so this stays correct under hi-DPI camera zoom.
    const cam = this.scene.cameras.main;
    const toScreen = (p: Vec2) => ({ x: p.x - cam.worldView.x, y: p.y - cam.worldView.y });

    this.rt.clear();
    // Fog is the void color at high alpha, so the unseen world sinks toward
    // the palette's darkness temperature instead of plain black.
    this.rt.fill(WORLD.void2, DARKNESS_ALPHA);
    const g = this.stamp;
    g.clear();
    g.fillStyle(0xffffff, 1);
    if (this.cone.polygon.length > 2) g.fillPoints(this.cone.polygon.map(toScreen), true);
    if (this.awareness.polygon.length > 2)
      g.fillPoints(this.awareness.polygon.map(toScreen), true);
    this.rt.erase(g);
  }

  get rayCount(): number {
    return this.cone.rays.length + this.awareness.rays.length;
  }
}
