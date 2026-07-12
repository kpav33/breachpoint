import Phaser from 'phaser';
import { ROUNDS_TO_WIN } from '../core/config';
import { SettingsPanel } from '../game/ui/SettingsPanel';
import { FACTION_CSS, FONT_DATA, FONT_DISPLAY, TEXT_1, TEXT_2, TEXT_3 } from '../game/theme';
import { MAPS } from '../game/map/MapLoader';

/** Passed to GameScene via scene.start data. */
export interface GameConfig {
  roundsToWin: number;
  mapKey: string;
}

interface Mode {
  label: string;
  sub: string;
  roundsToWin: number;
}

const MODES: Mode[] = [
  { label: 'COMPETITIVE', sub: `first to ${ROUNDS_TO_WIN}`, roundsToWin: ROUNDS_TO_WIN },
  { label: 'CASUAL', sub: 'first to 5 · vs bots', roundsToWin: 5 },
];

/** Title screen: mode select, map select, settings. */
export class MenuScene extends Phaser.Scene {
  private mapIndex = 0;
  private mapValue!: Phaser.GameObjects.Text;
  private settingsPanel!: SettingsPanel;

  constructor() {
    super('Menu');
  }

  create(): void {
    const w = this.scale.width;
    const h = this.scale.height;

    this.add
      .text(w / 2, h * 0.2, 'TACTICAL · TOP-DOWN', {
        fontFamily: FONT_DATA,
        fontSize: '13px',
        fontStyle: '600',
        color: TEXT_3,
      })
      .setOrigin(0.5);
    this.add
      .text(w / 2, h * 0.31, 'BREACHPOINT', {
        fontFamily: FONT_DISPLAY,
        fontSize: '64px',
        fontStyle: '700',
        color: TEXT_1,
      })
      .setOrigin(0.5);

    MODES.forEach((mode, i) => {
      this.button(w / 2, h * 0.48 + i * 62, mode.label, mode.sub, () => {
        const config: GameConfig = {
          roundsToWin: mode.roundsToWin,
          mapKey: MAPS[this.mapIndex],
        };
        this.scene.start('Game', config);
      });
    });

    // Map select row.
    const mapY = h * 0.48 + MODES.length * 62 + 8;
    this.add
      .text(w / 2 - 90, mapY, 'MAP', { fontFamily: FONT_DISPLAY, fontSize: '14px', fontStyle: '600', color: TEXT_3 })
      .setOrigin(1, 0.5);
    this.arrow(w / 2 - 62, mapY, '◄', () => this.cycleMap(-1));
    this.mapValue = this.add
      .text(w / 2 + 4, mapY, '', { fontFamily: FONT_DATA, fontSize: '14px', fontStyle: '600', color: TEXT_1 })
      .setOrigin(0.5);
    this.arrow(w / 2 + 70, mapY, '►', () => this.cycleMap(1));
    this.refreshMap();

    this.button(w / 2, mapY + 66, 'SETTINGS', null, () => this.settingsPanel.toggle());

    this.settingsPanel = new SettingsPanel(this, w / 2, h * 0.52);

    this.add
      .text(w / 2, h - 24, 'WASD move · mouse aim/shoot · SHIFT walk · R reload · E plant/defuse · TAB score', {
        fontFamily: FONT_DATA,
        fontSize: '11px',
        fontStyle: '500',
        color: TEXT_3,
      })
      .setOrigin(0.5);
  }

  private cycleMap(dir: number): void {
    this.mapIndex = (this.mapIndex + dir + MAPS.length) % MAPS.length;
    this.refreshMap();
  }

  private refreshMap(): void {
    this.mapValue.setText(MAPS[this.mapIndex].toUpperCase());
  }

  private button(
    x: number,
    y: number,
    label: string,
    sub: string | null,
    onClick: () => void,
  ): void {
    const t = this.add
      .text(x, y, label, {
        fontFamily: FONT_DISPLAY,
        fontSize: '26px',
        fontStyle: '700',
        color: TEXT_2,
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerover', () => t.setColor(FACTION_CSS.T))
      .on('pointerout', () => t.setColor(TEXT_2))
      .on('pointerdown', onClick);
    if (sub) {
      this.add
        .text(x, y + 22, sub, { fontFamily: FONT_DATA, fontSize: '11px', fontStyle: '500', color: TEXT_3 })
        .setOrigin(0.5);
    }
  }

  private arrow(x: number, y: number, glyph: string, fn: () => void): void {
    this.add
      .text(x, y, glyph, { fontFamily: FONT_DATA, fontSize: '14px', fontStyle: '600', color: FACTION_CSS.T })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', fn);
  }
}
