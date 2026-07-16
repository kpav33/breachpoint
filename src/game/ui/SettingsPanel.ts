import Phaser from 'phaser';
import type { BotDifficulty } from '../../core/config';
import { BIND_ACTIONS, BIND_LABELS, keyDisplayName, loadSettings, saveSettings } from '../settings';
import type { BindAction, Settings } from '../settings';
import {
  BOMB_CSS,
  FACTION_CSS,
  FONT_DATA,
  FONT_DISPLAY,
  LINE,
  PANEL_ALPHA,
  PANEL_FILL,
  TEXT_1,
  TEXT_2,
  TEXT_3,
} from '../theme';

const DIFFICULTIES: BotDifficulty[] = ['easy', 'normal', 'hard'];

const PANEL_W = 360;
const ROW_H = 24;

/**
 * Shared settings panel (menu + pause): volume and bot difficulty as
 * ◄ value ► rows, plus click-to-rebind keybinds. Changes persist
 * immediately; volume applies live, keybinds apply on match (re)entry —
 * GameScene reloads them when the pause overlay closes.
 */
export class SettingsPanel {
  readonly container: Phaser.GameObjects.Container;
  private settings: Settings;
  private volumeValue!: Phaser.GameObjects.Text;
  private difficultyValue!: Phaser.GameObjects.Text;
  private bindValues = new Map<BindAction, Phaser.GameObjects.Text>();
  /** Action currently waiting for a key press (null = not capturing). */
  private capturing: BindAction | null = null;

  constructor(
    private readonly scene: Phaser.Scene,
    x: number,
    y: number,
  ) {
    this.settings = loadSettings();
    scene.sound.volume = this.settings.volume;

    const w = PANEL_W;
    const h = 168 + BIND_ACTIONS.length * ROW_H + 26;
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

    const top = -h / 2;
    this.volumeValue = this.addArrowRow(top + 48, 'VOLUME', w, () => this.bumpVolume(-0.1), () => this.bumpVolume(0.1));
    this.difficultyValue = this.addArrowRow(top + 80, 'BOT DIFFICULTY', w, () => this.cycleDifficulty(-1), () => this.cycleDifficulty(1));

    const bindsTitle = scene.add
      .text(-w / 2 + 20, top + 118, 'KEYBINDS · CLICK TO REBIND', {
        fontFamily: FONT_DISPLAY,
        fontSize: '12px',
        fontStyle: '600',
        color: TEXT_3,
      })
      .setOrigin(0, 0);
    this.container.add(bindsTitle);
    BIND_ACTIONS.forEach((action, i) => this.addBindRow(top + 144 + i * ROW_H, action, w));

    scene.input.keyboard?.on('keydown', (ev: KeyboardEvent) => this.onKeyDown(ev));
    this.refresh();
  }

  /** True while a rebind is waiting for a key (pause's ESC must not fire). */
  get isCapturing(): boolean {
    return this.capturing !== null;
  }

  private addArrowRow(
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

  private addBindRow(y: number, action: BindAction, panelW: number): void {
    const s = this.scene;
    const label = s.add.text(-panelW / 2 + 20, y, BIND_LABELS[action], {
      fontFamily: FONT_DATA,
      fontSize: '12px',
      fontStyle: '500',
      color: TEXT_2,
    });
    const value = s.add
      .text(panelW / 2 - 20, y, '', { fontFamily: FONT_DATA, fontSize: '12px', fontStyle: '600', color: TEXT_1 })
      .setOrigin(1, 0)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.beginCapture(action));
    this.container.add([label, value]);
    this.bindValues.set(action, value);
  }

  private beginCapture(action: BindAction): void {
    this.capturing = action;
    this.refresh();
  }

  /** One panel-level listener: consumes the next key while capturing. */
  private onKeyDown(ev: KeyboardEvent): void {
    if (this.capturing === null || !this.container.visible) return;
    const action = this.capturing;
    this.capturing = null;
    if (ev.keyCode === Phaser.Input.Keyboard.KeyCodes.ESC) {
      this.refresh(); // cancelled
      return;
    }
    const name = SettingsPanel.keyCodeName(ev.keyCode);
    if (!name) {
      this.refresh(); // unmappable key: keep the old bind
      return;
    }
    // Conflict = swap: the action that held this key inherits the old one.
    const old = this.settings.keybinds[action];
    for (const other of BIND_ACTIONS) {
      if (other !== action && this.settings.keybinds[other] === name) {
        this.settings.keybinds[other] = old;
      }
    }
    this.settings.keybinds[action] = name;
    saveSettings(this.settings);
    this.refresh();
  }

  /** Reverse lookup: DOM keyCode → Phaser KeyCodes name (e.g. 71 → "G"). */
  private static keyCodeName(keyCode: number): string | null {
    const codes = Phaser.Input.Keyboard.KeyCodes as unknown as Record<string, number>;
    for (const [name, code] of Object.entries(codes)) {
      if (code === keyCode) return name;
    }
    return null;
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
    for (const [action, text] of this.bindValues) {
      if (this.capturing === action) {
        text.setText('PRESS KEY…');
        text.setColor(BOMB_CSS);
      } else {
        text.setText(keyDisplayName(this.settings.keybinds[action]));
        text.setColor(TEXT_1);
      }
    }
  }

  toggle(): void {
    this.capturing = null;
    this.container.setVisible(!this.container.visible);
    this.refresh();
  }

  get visible(): boolean {
    return this.container.visible;
  }
}
