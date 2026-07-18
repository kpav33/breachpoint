import Phaser from 'phaser';

/** Logical (design-space) canvas size — all layout code positions against these. */
export const GAME_WIDTH = 1280;
export const GAME_HEIGHT = 720;

/**
 * Cap on device-pixel oversampling — beyond 2 the fill cost outweighs the
 * visible gain (on >2 DPR displays the canvas is minified slightly instead).
 */
const MAX_DPR = 2;

/** Emitted on game.events after the render scale changes (window resize). */
export const RENDER_SCALE_CHANGED = 'renderscale-changed';

/**
 * The canvas backing store is sized to the exact number of device pixels the
 * canvas occupies on screen — one canvas pixel is one screen pixel, so the
 * browser never resamples (resampling is what blurred text under Scale.FIT).
 * Cameras zoom by zoomX/zoomY so every scene still works in logical 1280×720
 * coordinates.
 */
export interface RenderScale {
  /** Backing-store (device-pixel) canvas size. */
  backingW: number;
  backingH: number;
  /** CSS-pixel size the canvas is displayed at (backing / effective DPR). */
  cssW: number;
  cssH: number;
  /** Logical→backing scale; camera zoom and text resolution. */
  zoomX: number;
  zoomY: number;
}

function compute(): RenderScale {
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const fit = Math.min(window.innerWidth / GAME_WIDTH, window.innerHeight / GAME_HEIGHT);
  // Floor the DEVICE-pixel size, then derive the CSS size from it, so the
  // displayed rect is always a whole number of device pixels and never
  // overflows the window.
  const backingW = Math.max(1, Math.floor(GAME_WIDTH * fit * dpr));
  const backingH = Math.max(1, Math.floor(GAME_HEIGHT * fit * dpr));
  return {
    backingW,
    backingH,
    cssW: backingW / dpr,
    cssH: backingH / dpr,
    zoomX: backingW / GAME_WIDTH,
    zoomY: backingH / GAME_HEIGHT,
  };
}

let scale = compute();

export function renderScale(): RenderScale {
  return scale;
}

/**
 * Position for a scrollFactor(0) object so logical screen coordinates land
 * correctly under the hi-DPI camera zoom. The camera scales scroll-fixed
 * objects around the canvas center (screen = center + zoom·(pos − center)),
 * which displaces them by a constant — these bake in the inverse shift.
 * Required for every scrollFactor(0) object on a scrolling camera; objects
 * with scrollFactor 1 are unaffected. The shift depends on the current
 * render scale, so objects positioned with these must re-run their layout
 * via onRenderScale() to survive a window resize.
 */
export function screenX(x: number): number {
  return x + (GAME_WIDTH / 2) * (scale.zoomX - 1);
}
export function screenY(y: number): number {
  return y + (GAME_HEIGHT / 2) * (scale.zoomY - 1);
}

/**
 * Run `fn` now and again whenever the render scale changes, until the scene
 * shuts down. Use for anything positioned via screenX()/screenY().
 */
export function onRenderScale(scene: Phaser.Scene, fn: () => void): void {
  fn();
  scene.game.events.on(RENDER_SCALE_CHANGED, fn);
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
    scene.game.events.off(RENDER_SCALE_CHANGED, fn);
  });
}

function setTextResolution(objects: Phaser.GameObjects.GameObject[]): void {
  for (const obj of objects) {
    if (obj instanceof Phaser.GameObjects.Text) obj.setResolution(scale.zoomX);
    else if (obj instanceof Phaser.GameObjects.Container) setTextResolution(obj.list);
  }
}

/**
 * Call once from every scene's create(). Zooms the camera so logical
 * coordinates map onto the device-pixel canvas (scrollFactor-0 objects
 * included), rasterizes all Text objects at that zoom so glyphs are crisp
 * (Phaser 3 has no game-wide text resolution setting), and keeps both in
 * sync across window resizes.
 */
export function applyHiDPI(scene: Phaser.Scene): void {
  const apply = (): void => {
    scene.cameras.main.setZoom(scale.zoomX, scale.zoomY);
    scene.cameras.main.centerOn(GAME_WIDTH / 2, GAME_HEIGHT / 2);
  };
  apply();
  scene.events.on(Phaser.Scenes.Events.ADDED_TO_SCENE, (obj: Phaser.GameObjects.GameObject) => {
    if (obj instanceof Phaser.GameObjects.Text) obj.setResolution(scale.zoomX);
  });
  const onChange = (): void => {
    apply();
    setTextResolution(scene.children.list);
  };
  scene.game.events.on(RENDER_SCALE_CHANGED, onChange);
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
    scene.game.events.off(RENDER_SCALE_CHANGED, onChange);
  });
}

/**
 * Display the canvas at exactly its device-pixel size, centered on a whole
 * device pixel (a fractional offset would re-blur everything the exact
 * backing size just fixed). Uses the REAL devicePixelRatio for alignment,
 * not the MAX_DPR-capped one.
 */
function positionCanvas(canvas: HTMLCanvasElement): void {
  const dpr = window.devicePixelRatio || 1;
  const left = Math.round(((window.innerWidth - scale.cssW) / 2) * dpr) / dpr;
  const top = Math.round(((window.innerHeight - scale.cssH) / 2) * dpr) / dpr;
  canvas.style.display = 'block';
  canvas.style.width = `${scale.cssW}px`;
  canvas.style.height = `${scale.cssH}px`;
  canvas.style.marginLeft = `${Math.max(0, left)}px`;
  canvas.style.marginTop = `${Math.max(0, top)}px`;
}

/**
 * Call once right after creating the Phaser.Game. Styles the canvas to its
 * exact on-screen size and re-derives everything (backing store, camera
 * zooms, text resolutions, screenX/screenY consumers) when the window
 * resizes or moves to a screen with a different devicePixelRatio.
 */
export function installScaleHandler(game: Phaser.Game): void {
  game.events.once(Phaser.Core.Events.READY, () => positionCanvas(game.canvas));

  let pending: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener('resize', () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      scale = compute();
      game.scale.resize(scale.backingW, scale.backingH);
      // CSS zoom drives both the canvas style size and Phaser's pointer
      // coord mapping (displayScale). Re-set it: the effective DPR changes
      // when the window moves to a screen with a different density.
      game.scale.setZoom(scale.cssW / scale.backingW);
      positionCanvas(game.canvas);
      // Recompute canvas bounds so pointer coords map onto the new size.
      game.scale.refresh();
      game.events.emit(RENDER_SCALE_CHANGED);
    }, 100);
  });
}
