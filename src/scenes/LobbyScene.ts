import Phaser from 'phaser';
import type { Room } from 'colyseus.js';
import { ROUNDS_TO_WIN } from '../core/config';
import { MAPS } from '../game/map/MapLoader';
import { loadSettings, saveSettings } from '../game/settings';
import { GAME_WIDTH, GAME_HEIGHT, applyHiDPI } from '../game/display';
import {
  FACTION_CSS,
  FONT_DATA,
  FONT_DISPLAY,
  LINE,
  PANEL_ALPHA,
  PANEL_FILL,
  TEXT_1,
  TEXT_2,
  TEXT_3,
} from '../game/theme';
import { joinLobby } from '../net/NetClient';
import type { RoomMetadata } from '../net/protocol';
import type { GameConfig } from './MenuScene';
import type { JoinSpec, OnlineInit } from './OnlineGameScene';

/** What the Colyseus LobbyRoom sends per listed room (subset we render). */
interface RoomListing {
  roomId: string;
  clients: number;
  maxClients: number;
  metadata?: Partial<RoomMetadata>;
}

/** Most rooms shown at once — the panel height caps the list. */
const MAX_ROWS = 7;

/**
 * Online lobby: pick a map, then Quick Play (public matchmaking — the server
 * drops you into an open room or makes one), Host Private (get a share code),
 * Join by Code — or click a room in the live OPEN MATCHES browser (a
 * Colyseus LobbyRoom subscription, Phase 10).
 */
export class LobbyScene extends Phaser.Scene {
  private mapIndex = 0;
  private mapValue!: Phaser.GameObjects.Text;
  private nameValue!: Phaser.GameObjects.Text;
  private playerName = 'Player';
  /** Live room-list subscription; left on scene shutdown. */
  private lobby: Room | null = null;
  private rooms = new Map<string, RoomListing>();
  private listStatus!: Phaser.GameObjects.Text;
  private listRows: Phaser.GameObjects.Text[] = [];
  private listX = 0;
  private listTop = 0;

  constructor() {
    super('Lobby');
  }

  create(): void {
    applyHiDPI(this);
    this.playerName = loadSettings().playerName;
    this.rooms = new Map();
    this.listRows = [];
    const w = GAME_WIDTH;
    const h = GAME_HEIGHT;

    this.add
      .text(w / 2, h * 0.14, 'ONLINE', {
        fontFamily: FONT_DISPLAY,
        fontSize: '48px',
        fontStyle: '700',
        color: TEXT_1,
      })
      .setOrigin(0.5);

    // Left column: identity, map pick, join actions.
    const cx = w * 0.3;

    // Player name (click to change).
    this.nameValue = this.add
      .text(cx, h * 0.27, '', {
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
    const mapY = h * 0.35;
    this.add
      .text(cx - 90, mapY, 'MAP', { fontFamily: FONT_DISPLAY, fontSize: '14px', fontStyle: '600', color: TEXT_3 })
      .setOrigin(1, 0.5);
    this.arrow(cx - 62, mapY, '◄', () => this.cycleMap(-1));
    this.mapValue = this.add
      .text(cx + 4, mapY, '', { fontFamily: FONT_DATA, fontSize: '14px', fontStyle: '600', color: TEXT_1 })
      .setOrigin(0.5);
    this.arrow(cx + 70, mapY, '►', () => this.cycleMap(1));
    this.refreshMap();

    this.button(cx, h * 0.48, 'QUICK PLAY', 'join or create a public match', () =>
      this.start({ mode: 'quick' }),
    );
    this.button(cx, h * 0.48 + 66, 'HOST PRIVATE', 'get a code to share with friends', () =>
      this.start({ mode: 'host' }),
    );
    this.button(cx, h * 0.48 + 132, 'JOIN BY CODE', 'enter a room code', () => {
      const code = window.prompt('Enter room code:')?.trim();
      if (code) this.start({ mode: 'code', roomId: code });
    });

    // Right column: live room browser.
    this.buildRoomPanel(w * 0.71, h * 0.52);
    this.connectLobby();

    this.button(w / 2, h - 48, 'BACK', null, () => this.scene.start('Menu'));
    this.input.keyboard?.on('keydown-ESC', () => this.scene.start('Menu'));
    this.events.once('shutdown', () => {
      void this.lobby?.leave();
      this.lobby = null;
    });
  }

  // --- Room browser ---------------------------------------------------------

  private buildRoomPanel(cx: number, cy: number): void {
    const width = 440;
    const height = 420;
    this.add
      .rectangle(cx, cy, width, height, PANEL_FILL, PANEL_ALPHA)
      .setStrokeStyle(1, LINE);
    this.listX = cx - width / 2 + 24;
    const top = cy - height / 2;
    this.add.text(this.listX, top + 20, 'OPEN MATCHES', {
      fontFamily: FONT_DISPLAY,
      fontSize: '18px',
      fontStyle: '700',
      color: TEXT_1,
    });
    this.listStatus = this.add.text(this.listX, top + 50, 'connecting…', {
      fontFamily: FONT_DATA,
      fontSize: '11px',
      fontStyle: '500',
      color: TEXT_3,
    });
    this.listTop = top + 84;
  }

  /** Subscribe to the server's room list and mirror its updates. */
  private connectLobby(): void {
    joinLobby()
      .then((room) => {
        // The scene may have moved on while the join was in flight.
        if (!this.scene.isActive()) {
          void room.leave();
          return;
        }
        this.lobby = room;
        room.onMessage('rooms', (list: RoomListing[]) => {
          this.rooms.clear();
          for (const r of list) this.rooms.set(r.roomId, r);
          this.renderRooms();
        });
        room.onMessage('+', ([roomId, data]: [string, RoomListing]) => {
          this.rooms.set(roomId, data);
          this.renderRooms();
        });
        room.onMessage('-', (roomId: string) => {
          this.rooms.delete(roomId);
          this.renderRooms();
        });
      })
      .catch(() => {
        if (this.scene.isActive()) this.listStatus.setText('server unreachable');
      });
  }

  private renderRooms(): void {
    for (const t of this.listRows) t.destroy();
    this.listRows = [];

    const rooms = [...this.rooms.values()].slice(0, MAX_ROWS);
    this.listStatus.setText(
      rooms.length === 0 ? 'no open matches — quick play to create one' : `${this.rooms.size} open`,
    );

    rooms.forEach((r, i) => {
      const y = this.listTop + i * 46;
      const meta = r.metadata ?? {};
      const full = r.clients >= r.maxClients;
      const phase =
        meta.phase === 'warmup' || meta.round === undefined || meta.round === 0
          ? 'warmup'
          : `round ${meta.round}`;

      const name = this.add
        .text(this.listX, y, (meta.name ?? r.roomId).toUpperCase(), {
          fontFamily: FONT_DISPLAY,
          fontSize: '17px',
          fontStyle: '700',
          color: full ? TEXT_3 : TEXT_2,
        })
        .setOrigin(0, 0.5);
      const sub = this.add
        .text(
          this.listX,
          y + 17,
          `${meta.mapKey ?? '?'} · ${r.clients}/${r.maxClients} players · ${full ? 'full' : phase}`,
          { fontFamily: FONT_DATA, fontSize: '11px', fontStyle: '500', color: TEXT_3 },
        )
        .setOrigin(0, 0.5);
      if (!full) {
        name
          .setInteractive({ useHandCursor: true })
          .on('pointerover', () => name.setColor(FACTION_CSS.T))
          .on('pointerout', () => name.setColor(TEXT_2))
          .on('pointerdown', () => this.start({ mode: 'code', roomId: r.roomId }));
      }
      this.listRows.push(name, sub);
    });
  }

  // --- Actions ---------------------------------------------------------------

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

  private cycleMap(dir: number): void {
    this.mapIndex = (this.mapIndex + dir + MAPS.length) % MAPS.length;
    this.refreshMap();
  }

  private refreshName(): void {
    this.nameValue.setText(`NAME: ${this.playerName}  ✎`);
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
