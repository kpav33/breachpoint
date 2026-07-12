import Phaser from 'phaser';
import type { BotDifficulty } from '../../core/config';
import { loadSettings, saveSettings } from '../settings';
import type { Settings } from '../settings';
import { FACTION_CSS, FONT_DATA, FONT_DISPLAY, LINE, PANEL_ALPHA, PANEL_FILL, TEXT_1, TEXT_2 } from '../theme';

const DIFFICULTIES: BotDifficulty[] = ['easy', 'normal', 'hard'];

/**
 * Shared settings panel (menu + pause): volume and bot difficulty as
 * ◄ value ► rows. Changes persist immediately; volume applies live.
 */
export class SettingsPanel {
  readonly container: Phaser.GameObjects.Container;
  private settings: Settings;
  private volumeValue!: Phaser.GameObjects.Text;
  private difficultyValue!: Phaser.GameObjects.Text;

  constructor(
    private readonly scene: Phaser.Scene,
    x: number,
    y: number,
  ) {
    this.settings = loadSettings();
    scene.sound.volume = this.settings.volume;

    const w = 320;
    const h = 150;
    const bg = scene.add
      .rectangle(0, 0, w, h, PANEL_FILL, PANEL_ALPHA)
      .setStrokeStyle(1, LINE, 1);
    const title = scene.add
      .text(-w / 2 + 20, -h / 2 + 14, 'SETTINGS', {
        fontFamily: FONT_DISPLAY,
        fontSize: '15px',
        fontStyle: '700',
        color: TEXT_1,
      })
      .setOrigin(0, 0);

    this.container = scene.add.container(x, y, [bg, title]).setDepth(50).setVisible(false);

    this.volumeValue = this.addRow(-h / 2 + 56, 'VOLUME', w, () => this.bumpVolume(-0.1), () => this.bumpVolume(0.1));
    this.difficultyValue = this.addRow(-h / 2 + 96, 'BOT DIFFICULTY', w, () => this.cycleDifficulty(-1), () => this.cycleDifficulty(1));
    this.refresh();
  }

  private addRow(
    y: number,
    label: string,
    panelW: number,
    onLeft: () => void,
    onRight: () => void,
  ): Phaser.GameObjects.Text {
    const s = this.scene;
    const labelText = s.add.text(-panelW / 2 + 20, y, label, {
      fontFamily: FONT_DISPLAY,
      fontSize: '13px',
      fontStyle: '600',
      color: TEXT_2,
    });
    const arrow = (ax: number, glyph: string, fn: () => void): Phaser.GameObjects.Text =>
      s.add
        .text(ax, y, glyph, { fontFamily: FONT_DATA, fontSize: '14px', fontStyle: '600', color: FACTION_CSS.T })
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', fn);
    const left = arrow(panelW / 2 - 118, '◄', onLeft);
    const value = s.add
      .text(panelW / 2 - 72, y, '', { fontFamily: FONT_DATA, fontSize: '13px', fontStyle: '600', color: TEXT_1 })
      .setOrigin(0.5, 0);
    const right = arrow(panelW / 2 - 36, '►', onRight);
    this.container.add([labelText, left, value, right]);
    return value;
  }

  private bumpVolume(delta: number): void {
    this.settings.volume = Math.round(Math.min(Math.max(this.settings.volume + delta, 0), 1) * 10) / 10;
    this.scene.sound.volume = this.settings.volume;
    saveSettings(this.settings);
    this.refresh();
  }

  private cycleDifficulty(dir: number): void {
    const i = DIFFICULTIES.indexOf(this.settings.botDifficulty);
    this.settings.botDifficulty =
      DIFFICULTIES[(i + dir + DIFFICULTIES.length) % DIFFICULTIES.length];
    saveSettings(this.settings);
    this.refresh();
  }

  private refresh(): void {
    this.volumeValue.setText(`${Math.round(this.settings.volume * 100)}%`);
    this.difficultyValue.setText(this.settings.botDifficulty.toUpperCase());
  }

  toggle(): void {
    this.container.setVisible(!this.container.visible);
  }

  get visible(): boolean {
    return this.container.visible;
  }
}
