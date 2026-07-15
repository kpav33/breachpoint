import Phaser from 'phaser';
import { SettingsPanel } from '../game/ui/SettingsPanel';
import { GAME_WIDTH, GAME_HEIGHT, applyHiDPI } from '../game/display';
import { FACTION_CSS, FONT_DISPLAY, LINE, PANEL_ALPHA, PANEL_FILL, TEXT_1, TEXT_2 } from '../game/theme';

/**
 * Pause overlay launched over a paused Game+UI. Single-player, so the
 * simulation genuinely stops (Phaser scene pause halts update loops).
 * Online the server keeps running — this is just a menu overlay there.
 */
export class PauseScene extends Phaser.Scene {
  private settingsPanel!: SettingsPanel;
  /** Which game scene launched us ('Game' or 'OnlineGame'). */
  private gameKey = 'Game';

  constructor() {
    super('Pause');
  }

  init(data: { gameKey?: string }): void {
    this.gameKey = data.gameKey ?? 'Game';
  }

  create(): void {
    applyHiDPI(this);
    const w = GAME_WIDTH;
    const h = GAME_HEIGHT;

    this.add.rectangle(w / 2, h / 2, w, h, 0x000000, 0.55);
    this.add
      .rectangle(w / 2, h / 2, 300, 240, PANEL_FILL, PANEL_ALPHA)
      .setStrokeStyle(1, LINE, 1);
    this.add
      .text(w / 2, h / 2 - 88, 'PAUSED', {
        fontFamily: FONT_DISPLAY,
        fontSize: '24px',
        fontStyle: '700',
        color: TEXT_1,
      })
      .setOrigin(0.5);

    this.button(w / 2, h / 2 - 30, 'RESUME', () => this.resume());
    this.button(w / 2, h / 2 + 18, 'SETTINGS', () => this.settingsPanel.toggle());
    this.button(w / 2, h / 2 + 66, 'QUIT TO MENU', () => {
      this.scene.stop(this.gameKey);
      this.scene.stop('UI');
      this.scene.stop();
      this.scene.start('Menu');
    });

    this.settingsPanel = new SettingsPanel(this, w / 2 + 330, h / 2);

    this.input.keyboard!.on('keydown-ESC', () => this.resume());
  }

  private resume(): void {
    this.scene.resume(this.gameKey);
    this.scene.resume('UI');
    this.scene.stop();
  }

  private button(x: number, y: number, label: string, onClick: () => void): void {
    const t = this.add
      .text(x, y, label, {
        fontFamily: FONT_DISPLAY,
        fontSize: '18px',
        fontStyle: '700',
        color: TEXT_2,
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerover', () => t.setColor(FACTION_CSS.T))
      .on('pointerout', () => t.setColor(TEXT_2))
      .on('pointerdown', onClick);
  }
}
