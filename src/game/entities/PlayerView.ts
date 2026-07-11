import Phaser from 'phaser';
import { PLAYER_RADIUS } from '../../core/config';

const HP_BAR_WIDTH = 26;

/**
 * Render-only representation of a player: flat circle + direction notch,
 * plus an HP bar that stays screen-aligned while the body rotates.
 * Never mutates simulation state — GameScene drives it from interpolated
 * PlayerState each frame.
 */
export class PlayerView extends Phaser.GameObjects.Container {
  private readonly aimBody: Phaser.GameObjects.Container;
  private readonly circle: Phaser.GameObjects.Arc;
  private readonly hpFill: Phaser.GameObjects.Rectangle;
  private readonly baseColor: number;
  private flashUntil = 0;

  constructor(scene: Phaser.Scene, x: number, y: number, color = 0x4da6ff) {
    super(scene, x, y);
    this.baseColor = color;

    this.circle = scene.add.circle(0, 0, PLAYER_RADIUS, color);
    this.circle.setStrokeStyle(2, 0x0d0f12, 1);
    const notch = scene.add.rectangle(PLAYER_RADIUS - 2, 0, 9, 4, 0xe8f0f8);
    this.aimBody = scene.add.container(0, 0, [this.circle, notch]);

    const barY = -PLAYER_RADIUS - 8;
    const hpBg = scene.add.rectangle(0, barY, HP_BAR_WIDTH, 4, 0x0d0f12, 0.8);
    this.hpFill = scene.add.rectangle(0, barY, HP_BAR_WIDTH, 4, 0x66cc66);

    this.add([this.aimBody, hpBg, this.hpFill]);
    scene.add.existing(this);
  }

  /** Rotate only the body — the HP bar stays horizontal. */
  setAim(rotation: number): void {
    this.aimBody.rotation = rotation;
  }

  setHpFrac(frac: number): void {
    const f = Phaser.Math.Clamp(frac, 0, 1);
    this.hpFill.width = HP_BAR_WIDTH * f;
    this.hpFill.x = (-HP_BAR_WIDTH * (1 - f)) / 2;
    this.hpFill.fillColor = f > 0.5 ? 0x66cc66 : f > 0.25 ? 0xd9b24a : 0xd9534f;
  }

  /** Brief white flash when taking a hit. */
  flashDamage(): void {
    this.circle.fillColor = 0xffffff;
    this.flashUntil = this.scene.time.now + 80;
    this.scene.time.delayedCall(90, () => {
      if (this.scene && this.scene.time.now >= this.flashUntil) {
        this.circle.fillColor = this.baseColor;
      }
    });
  }
}
