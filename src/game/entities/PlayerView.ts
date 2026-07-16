import Phaser from 'phaser';
import { PLAYER_RADIUS } from '../../core/config';
import type { Team } from '../../core/types';
import { BOMB, FACTION, HP_GOOD, HP_LOW, HP_MID, ME_RING, WORLD } from '../theme';

const HP_BAR_WIDTH = 26;

/**
 * Render-only representation of a player, per the visual system's "12px
 * circle anatomy": fixed faction hue, facing notch (white for you, body
 * color for others), a 3px white outline ring marking "you", an HP bar
 * drawn only when damaged, and a bomb-carrier tag in objective orange.
 * Never mutates simulation state — GameScene drives it from interpolated
 * PlayerState each frame.
 */
export class PlayerView extends Phaser.GameObjects.Container {
  private readonly aimBody: Phaser.GameObjects.Container;
  private readonly circle: Phaser.GameObjects.Arc;
  private readonly hpBg: Phaser.GameObjects.Rectangle;
  private readonly hpFill: Phaser.GameObjects.Rectangle;
  private readonly bombMarker: Phaser.GameObjects.Rectangle;
  private readonly baseColor: number;
  private flashUntil = 0;

  constructor(scene: Phaser.Scene, x: number, y: number, team: Team, isMe = false) {
    super(scene, x, y);
    this.baseColor = FACTION[team];

    // Drop shadow (2.5D look): offset toward bottom-right, never rotates.
    const shadow = scene.add.ellipse(3, 4, PLAYER_RADIUS * 2 + 2, PLAYER_RADIUS * 2 + 2, WORLD.void2, 0.4);

    this.circle = scene.add.circle(0, 0, PLAYER_RADIUS, this.baseColor);
    // "You" is the white ring; everyone else gets a dark grounding stroke.
    this.circle.setStrokeStyle(isMe ? 3 : 2, isMe ? ME_RING : 0x0d1014, 1);
    const notch = scene.add.rectangle(
      PLAYER_RADIUS - 2,
      0,
      9,
      4,
      isMe ? ME_RING : this.baseColor,
    );
    if (!isMe) notch.setStrokeStyle(1, 0x0d1014, 1);
    this.aimBody = scene.add.container(0, 0, [this.circle, notch]);

    const barY = -PLAYER_RADIUS - 8;
    this.hpBg = scene.add.rectangle(0, barY, HP_BAR_WIDTH, 4, 0x0d1014, 0.8);
    this.hpFill = scene.add.rectangle(0, barY, HP_BAR_WIDTH, 4, HP_GOOD);
    // Bomb-carrier tag beside the HP bar (screen-aligned, doesn't rotate).
    this.bombMarker = scene.add
      .rectangle(HP_BAR_WIDTH / 2 + 7, barY, 6, 6, BOMB)
      .setVisible(false);

    this.add([shadow, this.aimBody, this.hpBg, this.hpFill, this.bombMarker]);
    this.setDepth(5);
    scene.add.existing(this);
  }

  /** Rotate only the body — the HP bar stays horizontal. */
  setAim(rotation: number): void {
    this.aimBody.rotation = rotation;
  }

  setHpFrac(frac: number): void {
    const f = Phaser.Math.Clamp(frac, 0, 1);
    // Full-health players stay clean — the bar only appears once damaged.
    const show = f < 1;
    this.hpBg.setVisible(show);
    this.hpFill.setVisible(show);
    if (!show) return;
    this.hpFill.width = HP_BAR_WIDTH * f;
    this.hpFill.x = (-HP_BAR_WIDTH * (1 - f)) / 2;
    this.hpFill.fillColor = f > 0.5 ? HP_GOOD : f > 0.25 ? HP_MID : HP_LOW;
  }

  setBombCarrier(carrying: boolean): void {
    this.bombMarker.setVisible(carrying);
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
