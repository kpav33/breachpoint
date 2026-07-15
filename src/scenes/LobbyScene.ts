import Phaser from 'phaser';
import { ROUNDS_TO_WIN } from '../core/config';
import { MAPS } from '../game/map/MapLoader';
import { loadSettings, saveSettings } from '../game/settings';
import { GAME_WIDTH, GAME_HEIGHT, applyHiDPI } from '../game/display';
import { FACTION_CSS, FONT_DATA, FONT_DISPLAY, TEXT_1, TEXT_2, TEXT_3 } from '../game/theme';
import type { GameConfig } from './MenuScene';
import type { JoinSpec, OnlineInit } from './OnlineGameScene';

/**
 * Online lobby: pick a map, then Quick Play (public matchmaking — the server
 * drops you into an open room or makes one), Host Private (get a share code),
 * or Join by Code. A browsable live room list would need a Colyseus
 * LobbyRoom; that's deferred (see docs/PLAN.md Phase 10 backlog).
 */
export class LobbyScene extends Phaser.Scene {
  private mapIndex = 0;
  private mapValue!: Phaser.GameObjects.Text;
  private nameValue!: Phaser.GameObjects.Text;
  private playerName = 'Player';

  constructor() {
    super('Lobby');
  }

  create(): void {
    applyHiDPI(this);
    this.playerName = loadSettings().playerName;
    const w = GAME_WIDTH;
    const h = GAME_HEIGHT;

    this.add
      .text(w / 2, h * 0.16, 'ONLINE', {
        fontFamily: FONT_DISPLAY,
        fontSize: '48px',
        fontStyle: '700',
        color: TEXT_1,
      })
      .setOrigin(0.5);

    // Player name (click to change).
    this.nameValue = this.add
      .text(w / 2, h * 0.28, '', {
        fontFamily: FONT_DATA,
        fontSize: '14px',
        fontStyle: '600',
        color: TEXT_2,
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.changeName());
    this.refreshName();

    // Map selector.
    const mapY = h * 0.36;
    this.add
      .text(w / 2 - 90, mapY, 'MAP', { fontFamily: FONT_DISPLAY, fontSize: '14px', fontStyle: '600', color: TEXT_3 })
      .setOrigin(1, 0.5);
    this.arrow(w / 2 - 62, mapY, '◄', () => this.cycleMap(-1));
    this.mapValue = this.add
      .text(w / 2 + 4, mapY, '', { fontFamily: FONT_DATA, fontSize: '14px', fontStyle: '600', color: TEXT_1 })
      .setOrigin(0.5);
    this.arrow(w / 2 + 70, mapY, '►', () => this.cycleMap(1));
    this.refreshMap();

    this.button(w / 2, h * 0.5, 'QUICK PLAY', 'join or create a public match', () =>
      this.start({ mode: 'quick' }),
    );
    this.button(w / 2, h * 0.5 + 66, 'HOST PRIVATE', 'get a code to share with friends', () =>
      this.start({ mode: 'host' }),
    );
    this.button(w / 2, h * 0.5 + 132, 'JOIN BY CODE', 'enter a room code', () => {
      const code = window.prompt('Enter room code:')?.trim();
      if (code) this.start({ mode: 'code', roomId: code });
    });

    this.button(w / 2, h - 48, 'BACK', null, () => this.scene.start('Menu'));
    this.input.keyboard?.on('keydown-ESC', () => this.scene.start('Menu'));
  }

  private start(join: JoinSpec): void {
    const data: OnlineInit = {
      roundsToWin: ROUNDS_TO_WIN,
      mapKey: MAPS[this.mapIndex],
      join,
      name: this.playerName,
    } satisfies OnlineInit & Partial<GameConfig>;
    this.scene.start('OnlineGame', data);
  }

  private changeName(): void {
    const next = window.prompt('Your name:', this.playerName)?.trim();
    if (!next) return;
    this.playerName = next.slice(0, 16);
    saveSettings({ ...loadSettings(), playerName: this.playerName });
    this.refreshName();
  }

  private refreshName(): void {
    this.nameValue.setText(`NAME: ${this.playerName}  ✎`);
  }

  private cycleMap(dir: number): void {
    this.mapIndex = (this.mapIndex + dir + MAPS.length) % MAPS.length;
    this.refreshMap();
  }

  private refreshMap(): void {
    this.mapValue.setText(MAPS[this.mapIndex].toUpperCase());
  }

  private button(x: number, y: number, label: string, sub: string | null, onClick: () => void): void {
    const t = this.add
      .text(x, y, label, { fontFamily: FONT_DISPLAY, fontSize: '26px', fontStyle: '700', color: TEXT_2 })
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
