import Phaser from 'phaser';
import { PLAYER_RADIUS } from '../../core/config';

/**
 * Render-only representation of a player: flat circle + direction notch,
 * per the art direction. Never mutates simulation state — GameScene sets
 * its position/rotation from interpolated PlayerState each frame.
 */
export class PlayerView extends Phaser.GameObjects.Container {
  constructor(scene: Phaser.Scene, x: number, y: number, color = 0x4da6ff) {
    super(scene, x, y);
    const body = scene.add.circle(0, 0, PLAYER_RADIUS, color);
    body.setStrokeStyle(2, 0x0d0f12, 1);
    const notch = scene.add.rectangle(PLAYER_RADIUS - 2, 0, 9, 4, 0xe8f0f8);
    this.add([body, notch]);
    scene.add.existing(this);
  }
}
