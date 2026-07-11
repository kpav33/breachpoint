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
    this.scene.start('Game');
  }
}
