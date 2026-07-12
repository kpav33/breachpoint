import Phaser from 'phaser';
import { preloadMapAssets } from '../game/map/MapLoader';
import { AudioSystem } from '../game/systems/AudioSystem';

/** Loads global assets before the game starts, then hands off to GameScene. */
export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  preload(): void {
    preloadMapAssets(this);
    AudioSystem.preload(this);
  }

  create(): void {
    // HUD fonts load via <link> in index.html; wait so Phaser text never
    // renders a fallback face for the first frames. Fail open after 2s.
    const wanted = [
      "600 16px 'IBM Plex Mono'",
      "700 16px 'IBM Plex Sans Condensed'",
    ];
    Promise.race([
      Promise.all(wanted.map((f) => document.fonts.load(f))),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]).then(() => this.scene.start('Menu'));
  }
}
