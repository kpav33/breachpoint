import Phaser from 'phaser';

/**
 * Loads global assets before the game starts. Nothing to load yet in
 * Phase 0 — hands off straight to GameScene.
 */
export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  preload(): void {
    // Global assets (sprites, maps, audio) load here in later phases.
  }

  create(): void {
    this.scene.start('Game');
  }
}
