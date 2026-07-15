import Phaser from 'phaser';

/** Logical (design-space) canvas size — all layout code positions against these. */
export const GAME_WIDTH = 1280;
export const GAME_HEIGHT = 720;

/**
 * Device-pixel oversampling factor. The canvas backing store is
 * GAME_WIDTH×DPR pixels so text and edges stay sharp on hi-DPI screens;
 * cameras zoom by DPR so every scene still works in logical 1280×720
 * coordinates. Capped at 2 — beyond that the fill cost outweighs the
 * visible gain.
 */
export const DPR = Math.min(window.devicePixelRatio || 1, 2);

/**
 * Call once from every scene's create(). Zooms the camera so logical
 * coordinates map onto the oversampled canvas (scrollFactor-0 objects
 * included), and rasterizes all Text objects at DPR so glyphs are crisp
 * (Phaser 3 has no game-wide text resolution setting).
 */
/**
 * Position for a scrollFactor(0) object so logical screen coordinates land
 * correctly under the hi-DPI camera zoom. The camera scales scroll-fixed
 * objects around the canvas center (screen = center + zoom·(pos − center)),
 * which displaces them by a constant — these bake in the inverse shift.
 * Required for every scrollFactor(0) object on a scrolling camera; objects
 * with scrollFactor 1 are unaffected.
 */
export function screenX(x: number): number {
  return x + (GAME_WIDTH / 2) * (DPR - 1);
}
export function screenY(y: number): number {
  return y + (GAME_HEIGHT / 2) * (DPR - 1);
}

export function applyHiDPI(scene: Phaser.Scene): void {
  scene.cameras.main.setZoom(DPR);
  scene.cameras.main.centerOn(GAME_WIDTH / 2, GAME_HEIGHT / 2);
  scene.events.on(
    Phaser.Scenes.Events.ADDED_TO_SCENE,
    (obj: Phaser.GameObjects.GameObject) => {
      if (obj instanceof Phaser.GameObjects.Text) obj.setResolution(DPR);
    },
  );
}
