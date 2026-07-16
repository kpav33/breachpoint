import Phaser from 'phaser';
import type { MapGrid, Team, Vec2 } from '../core/types';
import type { BuyItem, MatchPhase } from '../match/MatchState';
import { isWall } from '../core/collision';
import {
  BOMB,
  BOMB_CSS,
  BOMB_PLANT_CSS,
  DANGER,
  FACTION,
  FACTION_CSS,
  FONT_DATA,
  FONT_DISPLAY,
  LINE,
  MONEY,
  PANEL_ALPHA,
  PANEL_FILL,
  TEXT_1,
  TEXT_2,
  TEXT_3,
  WORLD,
} from '../game/theme';
import { GAME_WIDTH, GAME_HEIGHT, applyHiDPI } from '../game/display';
import { keyDisplayName, loadSettings } from '../game/settings';

export interface BuyMenuItem {
  item: BuyItem;
  label: string;
  price: number;
  /** Purchasable right now (money, team, not owned). */
  enabled: boolean;
}

export interface MinimapDot {
  x: number;
  y: number;
  team: Team;
  isMe: boolean;
}

export interface MinimapData {
  dots: MinimapDot[];
  planted: Vec2 | null;
  dropped: Vec2 | null;
}

export interface ScoreboardRow {
  name: string;
  team: Team;
  kills: number;
  deaths: number;
  money: number;
  alive: boolean;
  /** RTT ms for online humans; null offline and for bots (shown as BOT). */
  ping: number | null;
}

/** Player-facing connection telemetry (null in offline games). */
export interface HudNet {
  /** Rolling RTT, ms; null until the first pong lands. */
  rttMs: number | null;
  /** Short warning while the connection or server is unhealthy, else null. */
  problem: string | null;
}

/** Two-line banner lockup: tracked eyebrow (context) over a headline (event). */
export interface Banner {
  eyebrow: string | null;
  headline: string;
  sub: string | null;
  /** Faction outcomes color the eyebrow only — headline stays neutral. */
  eyebrowColor?: string;
}

/** Everything the HUD shows, assembled by GameScene once per frame. */
export interface HudData {
  hp: number;
  armor: number;
  /** Carried gear line, e.g. "HE · SMOKE · KIT" (empty = hidden). */
  gear: string;
  minimap: MinimapData;
  weaponLabel: string;
  ammoLabel: string;
  ammoWarn: boolean;
  money: number;
  round: number;
  scoreT: number;
  scoreCT: number;
  aliveT: number;
  aliveCT: number;
  phase: MatchPhase;
  /** Round clock during LIVE, phase countdown otherwise. */
  clockSec: number;
  bombPlanted: boolean;
  bombTimeLeft: number;
  carryingBomb: boolean;
  /** Local plant/defuse progress (null = none). */
  action: { label: string; frac: number } | null;
  banner: Banner | null;
  spectating: string | null;
  /** Non-null only while the buy menu should be open. */
  buyMenu: BuyMenuItem[] | null;
  scoreboard: ScoreboardRow[];
  /** Connection telemetry — null offline (hides the ping readout). */
  net: HudNet | null;
}

export interface HudSource {
  getHud(): HudData;
  buy(item: BuyItem): void;
  /** Static collision grid for the minimap walls (read once). */
  getGrid(): MapGrid;
  /** Present only online: relay a chat line (teamOnly = team chat). */
  sendChat?(text: string, teamOnly: boolean): void;
}

const BUY_ROWS = 10;
const MINIMAP_W = 152;

/**
 * Parallel HUD scene, styled per the Breachpoint visual system: Plex Mono
 * for everything that ticks, Plex Sans Condensed for loud short words, one
 * shared panel recipe. Pull-model — reads HudData from GameScene each frame
 * and renders it. No game logic, no world objects.
 */
export class UIScene extends Phaser.Scene {
  private source!: HudSource;
  private clockText!: Phaser.GameObjects.Text;
  private scoreLineT!: Phaser.GameObjects.Text;
  private scoreLineMid!: Phaser.GameObjects.Text;
  private scoreLineCT!: Phaser.GameObjects.Text;
  private roundText!: Phaser.GameObjects.Text;
  private hpText!: Phaser.GameObjects.Text;
  private moneyText!: Phaser.GameObjects.Text;
  private weaponText!: Phaser.GameObjects.Text;
  private ammoText!: Phaser.GameObjects.Text;
  private bombText!: Phaser.GameObjects.Text;
  private eyebrowText!: Phaser.GameObjects.Text;
  private headlineText!: Phaser.GameObjects.Text;
  private subText!: Phaser.GameObjects.Text;
  private spectateText!: Phaser.GameObjects.Text;
  private actionGfx!: Phaser.GameObjects.Graphics;
  private actionText!: Phaser.GameObjects.Text;
  private buyPanel!: Phaser.GameObjects.Container;
  private buyTitle!: Phaser.GameObjects.Text;
  private buyRows: { key: Phaser.GameObjects.Text; name: Phaser.GameObjects.Text; price: Phaser.GameObjects.Text }[] = [];
  private boardPanel!: Phaser.GameObjects.Container;
  private boardHeadT!: Phaser.GameObjects.Text;
  private boardHeadScore!: Phaser.GameObjects.Text;
  private boardHeadCT!: Phaser.GameObjects.Text;
  private boardBodyT!: Phaser.GameObjects.Text;
  private boardBodyCT!: Phaser.GameObjects.Text;
  private killFeed: { text: Phaser.GameObjects.Text; ttl: number }[] = [];
  private tabKey!: Phaser.Input.Keyboard.Key;
  private buyMenuShown: BuyMenuItem[] | null = null;
  private armorText!: Phaser.GameObjects.Text;
  private gearText!: Phaser.GameObjects.Text;
  private minimapDots!: Phaser.GameObjects.Graphics;
  private minimapScale = 1;
  private minimapOrigin = { x: 14, y: 14 };
  private pingText!: Phaser.GameObjects.Text;
  private netWarnText!: Phaser.GameObjects.Text;
  /** Display name of the Use bind, for the bomb-carry hint. */
  private useKeyName = 'E';
  // Chat (online only — offline has no HudSource.sendChat).
  private chatLines: { text: Phaser.GameObjects.Text; ttl: number }[] = [];
  private chatInput!: Phaser.GameObjects.Text;
  private chatOpen = false;
  private chatTeamOnly = false;
  private chatBuffer = '';

  constructor() {
    super('UI');
  }

  init(data: { source: HudSource }): void {
    this.source = data.source;
  }

  private dataStyle(size: number, color = TEXT_1, weight = '600'): Phaser.Types.GameObjects.Text.TextStyle {
    return { fontFamily: FONT_DATA, fontSize: `${size}px`, fontStyle: weight, color };
  }

  private displayStyle(size: number, color = TEXT_1, weight = '700'): Phaser.Types.GameObjects.Text.TextStyle {
    return { fontFamily: FONT_DISPLAY, fontSize: `${size}px`, fontStyle: weight, color };
  }

  /** Shared panel recipe: dark fill, 1px line border. */
  private panel(w: number, h: number): Phaser.GameObjects.Rectangle {
    return this.add
      .rectangle(0, 0, w, h, PANEL_FILL, PANEL_ALPHA)
      .setStrokeStyle(1, LINE, 1)
      .setOrigin(0.5);
  }

  create(): void {
    applyHiDPI(this);
    this.useKeyName = keyDisplayName(loadSettings().keybinds.use);
    const w = GAME_WIDTH;
    const h = GAME_HEIGHT;
    const text = (
      x: number,
      y: number,
      style: Phaser.Types.GameObjects.Text.TextStyle,
      originX = 0,
      originY = 0,
    ): Phaser.GameObjects.Text =>
      this.add.text(x, y, '', style).setOrigin(originX, originY).setDepth(10);

    // Top center: clock over score.
    this.clockText = text(w / 2, 10, this.dataStyle(26), 0.5);
    this.scoreLineT = text(w / 2 - 14, 44, this.displayStyle(17, FACTION_CSS.T, '700'), 1);
    this.scoreLineMid = text(w / 2, 44, this.displayStyle(17, TEXT_2, '600'), 0.5);
    this.scoreLineCT = text(w / 2 + 14, 44, this.displayStyle(17, FACTION_CSS.CT, '700'), 0);
    this.roundText = text(w / 2, 66, this.displayStyle(12, TEXT_3, '600'), 0.5);
    // Connection warning, blinking under the score line.
    this.netWarnText = text(w / 2, 88, this.displayStyle(13, DANGER, '700'), 0.5);

    // Bottom left: ping + hp + armor + money. Bottom right: gear + weapon + ammo.
    this.pingText = text(14, h - 58, this.dataStyle(11, TEXT_3, '500'), 0, 1);
    this.hpText = text(14, h - 36, this.dataStyle(22), 0, 1);
    this.armorText = text(120, h - 36, this.dataStyle(15, TEXT_2), 0, 1);
    this.moneyText = text(14, h - 12, this.dataStyle(17, MONEY), 0, 1);
    this.gearText = text(w - 14, h - 58, this.dataStyle(11, TEXT_3, '500'), 1, 1);
    this.weaponText = text(w - 14, h - 36, this.displayStyle(15, TEXT_2, '600'), 1, 1);
    this.ammoText = text(w - 14, h - 12, this.dataStyle(22), 1, 1);

    this.createMinimap();

    // Bottom center: bomb hint, low and out of the aiming path.
    this.bombText = text(w / 2, h - 14, this.displayStyle(13, BOMB_CSS, '600'), 0.5, 1);

    // Center banner lockup — eyebrow / headline / sub.
    this.eyebrowText = text(w / 2, h * 0.3, this.displayStyle(13, TEXT_2, '600'), 0.5, 0.5);
    this.headlineText = text(w / 2, h * 0.3 + 26, this.displayStyle(36, TEXT_1, '700'), 0.5, 0.5);
    this.subText = text(w / 2, h * 0.3 + 56, this.displayStyle(14, TEXT_2, '600'), 0.5, 0.5);
    this.spectateText = text(w / 2, h * 0.82, this.displayStyle(14, TEXT_3, '600'), 0.5);

    this.actionGfx = this.add.graphics().setDepth(10);
    this.actionText = text(w / 2, h * 0.6 - 20, this.dataStyle(13), 0.5);

    this.createBuyPanel();
    this.createScoreboard();

    const kb = this.input.keyboard!;
    kb.addCapture('TAB');
    this.tabKey = kb.addKey(Phaser.Input.Keyboard.KeyCodes.TAB);
    const buyKeys = [
      'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'ZERO',
    ] as const;
    buyKeys.forEach((key, i) => {
      kb.on(`keydown-${key}`, () => {
        if (this.chatOpen) return; // typing, not buying
        const menu = this.buyMenuShown;
        if (menu && menu[i]?.enabled) this.source.buy(menu[i].item);
      });
    });

    // Chat: Y opens all-chat, U team chat; Enter sends, ESC cancels.
    this.chatInput = this.add
      .text(14, h - 76, '', this.dataStyle(13))
      .setOrigin(0, 1)
      .setDepth(11)
      .setVisible(false);
    kb.on('keydown', (ev: KeyboardEvent) => this.onChatKey(ev));
  }

  /** True while the player is typing — game input must be suppressed. */
  get chatBlocksInput(): boolean {
    return this.chatOpen;
  }

  /** A relayed chat line, colored by the sender's team. */
  addChatLine(name: string, team: Team, text: string, teamOnly: boolean): void {
    const line = this.add
      .text(14, 0, `${teamOnly ? '(TEAM) ' : ''}${name}: ${text}`, {
        ...this.dataStyle(13, FACTION_CSS[team], '500'),
        wordWrap: { width: 460 },
      })
      .setOrigin(0, 1)
      .setDepth(11);
    this.chatLines.push({ text: line, ttl: 8000 });
    while (this.chatLines.length > 6) this.chatLines.shift()!.text.destroy();
  }

  private onChatKey(ev: KeyboardEvent): void {
    if (!this.chatOpen) {
      if (!this.source.sendChat) return; // offline: no chat
      if (ev.key === 'y' || ev.key === 'Y') this.openChat(false);
      else if (ev.key === 'u' || ev.key === 'U') this.openChat(true);
      return;
    }
    if (ev.key === 'Enter') {
      const text = this.chatBuffer.trim();
      if (text) this.source.sendChat?.(text, this.chatTeamOnly);
      this.closeChat();
    } else if (ev.key === 'Escape') {
      this.closeChat();
    } else if (ev.key === 'Backspace') {
      this.chatBuffer = this.chatBuffer.slice(0, -1);
      this.refreshChatInput();
    } else if (ev.key.length === 1 && this.chatBuffer.length < 96) {
      this.chatBuffer += ev.key;
      this.refreshChatInput();
    }
  }

  private openChat(teamOnly: boolean): void {
    this.chatOpen = true;
    this.chatTeamOnly = teamOnly;
    this.chatBuffer = '';
    this.chatInput.setVisible(true);
    this.refreshChatInput();
  }

  private closeChat(): void {
    this.chatOpen = false;
    this.chatBuffer = '';
    this.chatInput.setVisible(false);
  }

  private refreshChatInput(): void {
    this.chatInput.setText(`${this.chatTeamOnly ? 'SAY (TEAM)' : 'SAY'}: ${this.chatBuffer}_`);
  }

  /** Walls drawn once from the collision grid; dots redrawn per frame. */
  private createMinimap(): void {
    const grid = this.source.getGrid();
    const worldW = grid.width * grid.tileSize;
    this.minimapScale = MINIMAP_W / worldW;
    const mh = grid.height * grid.tileSize * this.minimapScale;
    const { x, y } = this.minimapOrigin;

    this.add
      .rectangle(x - 4, y - 4, MINIMAP_W + 8, mh + 8, PANEL_FILL, PANEL_ALPHA)
      .setOrigin(0)
      .setStrokeStyle(1, LINE, 1)
      .setDepth(9);
    const walls = this.add.graphics().setDepth(9);
    const ts = grid.tileSize * this.minimapScale;
    walls.fillStyle(WORLD.wall, 0.9);
    for (let ty = 0; ty < grid.height; ty++) {
      for (let tx = 0; tx < grid.width; tx++) {
        if (isWall(grid, tx, ty)) walls.fillRect(x + tx * ts, y + ty * ts, ts + 0.5, ts + 0.5);
      }
    }
    this.minimapDots = this.add.graphics().setDepth(9);
  }

  private drawMinimap(d: HudData): void {
    const g = this.minimapDots;
    const { x, y } = this.minimapOrigin;
    const s = this.minimapScale;
    g.clear();
    for (const dot of d.minimap.dots) {
      g.fillStyle(dot.isMe ? 0xffffff : dot.team === 'T' ? FACTION.T : FACTION.CT, 1);
      g.fillCircle(x + dot.x * s, y + dot.y * s, dot.isMe ? 3 : 2.4);
    }
    const bomb = d.minimap.planted ?? d.minimap.dropped;
    if (bomb) {
      g.fillStyle(BOMB, d.minimap.planted && Math.floor(this.time.now / 400) % 2 === 0 ? 0.4 : 1);
      g.fillRect(x + bomb.x * s - 2.5, y + bomb.y * s - 2.5, 5, 5);
    }
  }

  private createBuyPanel(): void {
    const x = 30;
    const y = GAME_HEIGHT * 0.22;
    const width = 250;
    const rowH = 28;
    const height = 54 + BUY_ROWS * rowH;

    const bg = this.panel(width, height).setPosition(width / 2, height / 2);
    this.buyTitle = this.add
      .text(16, 14, 'BUY', this.displayStyle(15, TEXT_1, '700'))
      .setDepth(11);
    const hint = this.add
      .text(width - 16, 17, 'PRESS 1–9, 0', this.dataStyle(10, TEXT_3, '500'))
      .setOrigin(1, 0)
      .setDepth(11);

    const rows: Phaser.GameObjects.GameObject[] = [];
    for (let i = 0; i < BUY_ROWS; i++) {
      const ry = 48 + i * rowH;
      const key = this.add
        .text(16, ry, `${(i + 1) % 10}`, this.dataStyle(14, FACTION_CSS.T))
        .setDepth(11);
      const name = this.add.text(42, ry, '', this.displayStyle(15, TEXT_1, '600')).setDepth(11);
      const price = this.add
        .text(width - 16, ry, '', this.dataStyle(14, MONEY))
        .setOrigin(1, 0)
        .setDepth(11);
      this.buyRows.push({ key, name, price });
      rows.push(key, name, price);
    }
    this.buyPanel = this.add
      .container(x, y, [bg, this.buyTitle, hint, ...rows])
      .setDepth(10)
      .setVisible(false);
  }

  private createScoreboard(): void {
    const w = GAME_WIDTH;
    const h = GAME_HEIGHT;
    const bw = 620; // fits the online PING column with a comfortable gutter
    const bh = 300;

    const bg = this.panel(bw, bh);
    this.boardHeadT = this.add
      .text(-bw / 2 + 26, -bh / 2 + 22, 'TERRORISTS', this.displayStyle(16, FACTION_CSS.T, '700'))
      .setOrigin(0, 0);
    this.boardHeadScore = this.add
      .text(0, -bh / 2 + 22, '', this.dataStyle(16, TEXT_1))
      .setOrigin(0.5, 0);
    this.boardHeadCT = this.add
      .text(bw / 2 - 26, -bh / 2 + 22, 'COUNTER-TERRORISTS', this.displayStyle(16, FACTION_CSS.CT, '700'))
      .setOrigin(1, 0);
    this.boardBodyT = this.add
      .text(-bw / 2 + 26, -bh / 2 + 58, '', this.dataStyle(13, TEXT_2, '500'))
      .setOrigin(0, 0)
      .setLineSpacing(9);
    this.boardBodyCT = this.add
      .text(bw / 2 - 26, -bh / 2 + 58, '', this.dataStyle(13, TEXT_2, '500'))
      .setOrigin(1, 0)
      .setLineSpacing(9);
    const legend = this.add
      .text(0, bh / 2 - 20, '† = ELIMINATED THIS ROUND', this.dataStyle(10, TEXT_3, '500'))
      .setOrigin(0.5, 1);

    this.boardPanel = this.add
      .container(w / 2, h / 2, [
        bg,
        this.boardHeadT,
        this.boardHeadScore,
        this.boardHeadCT,
        this.boardBodyT,
        this.boardBodyCT,
        legend,
      ])
      .setDepth(20)
      .setVisible(false);
  }

  /** Push one kill-feed line. Your own death overrides to danger red. */
  addKillFeedLine(line: string, color: string, victimIsMe = false): void {
    const t = this.add
      .text(GAME_WIDTH - 14, 0, line, this.dataStyle(13, victimIsMe ? DANGER : color, '600'))
      .setOrigin(1, 0)
      .setDepth(10);
    this.killFeed.unshift({ text: t, ttl: 5000 });
    while (this.killFeed.length > 5) this.killFeed.pop()!.text.destroy();
  }

  update(_time: number, delta: number): void {
    const d = this.source.getHud();

    if (d.bombPlanted) {
      this.clockText.setText(`0:${String(Math.max(Math.ceil(d.bombTimeLeft), 0)).padStart(2, '0')}`);
      this.clockText.setColor(BOMB_PLANT_CSS);
    } else {
      const mm = Math.floor(Math.max(d.clockSec, 0) / 60);
      const ss = Math.floor(Math.max(d.clockSec, 0) % 60);
      this.clockText.setText(`${mm}:${String(ss).padStart(2, '0')}`);
      this.clockText.setColor(d.phase === 'live' && d.clockSec < 15 ? DANGER : TEXT_1);
    }
    this.scoreLineT.setText(`T ${d.scoreT}`);
    this.scoreLineMid.setText(':');
    this.scoreLineCT.setText(`${d.scoreCT} CT`);
    this.roundText.setText(
      d.round > 0 ? `ROUND ${d.round} · ${d.aliveT}v${d.aliveCT} ALIVE` : '',
    );
    this.hpText.setText(`${d.hp} HP`);
    this.armorText.setText(d.armor > 0 ? `${d.armor} AR` : '');
    this.armorText.setX(14 + this.hpText.width + 14);
    this.moneyText.setText(`$${d.money}`);
    this.gearText.setText(d.gear);
    this.weaponText.setText(d.weaponLabel);
    this.ammoText.setText(d.ammoLabel);
    this.ammoText.setColor(d.ammoWarn ? DANGER : TEXT_1);
    this.bombText.setText(
      d.carryingBomb
        ? `CARRYING THE BOMB — HOLD ${this.useKeyName} IN A SITE TO PLANT`
        : d.bombPlanted
          ? 'BOMB PLANTED'
          : '',
    );

    // The banner yields while the scoreboard is up (it bleeds through the
    // translucent panel otherwise).
    const banner = this.tabKey.isDown ? null : d.banner;
    this.eyebrowText.setText(banner?.eyebrow ?? '');
    this.eyebrowText.setColor(banner?.eyebrowColor ?? TEXT_2);
    this.headlineText.setText(banner?.headline ?? '');
    this.subText.setText(banner?.sub ?? '');
    this.spectateText.setText(d.spectating ? `SPECTATING ${d.spectating}` : '');

    this.pingText.setText(d.net?.rttMs != null ? `PING ${Math.round(d.net.rttMs)} MS` : '');
    const warn = d.net?.problem ?? null;
    this.netWarnText.setText(warn ?? '');
    this.netWarnText.setVisible(warn !== null && Math.floor(this.time.now / 400) % 2 === 0);

    this.drawActionBar(d);
    this.drawBuyMenu(d);
    this.drawScoreboard(d);
    this.drawMinimap(d);

    for (let i = this.killFeed.length - 1; i >= 0; i--) {
      const entry = this.killFeed[i];
      entry.ttl -= delta;
      if (entry.ttl <= 0) {
        entry.text.destroy();
        this.killFeed.splice(i, 1);
      } else {
        entry.text.setAlpha(Math.min(1, entry.ttl / 1200));
      }
    }
    this.killFeed.forEach((entry, i) => entry.text.setY(86 + i * 20));

    // Chat log: stacked above the input line, newest at the bottom.
    for (let i = this.chatLines.length - 1; i >= 0; i--) {
      const entry = this.chatLines[i];
      entry.ttl -= delta;
      if (entry.ttl <= 0) {
        entry.text.destroy();
        this.chatLines.splice(i, 1);
      } else {
        entry.text.setAlpha(Math.min(1, entry.ttl / 1500));
      }
    }
    const chatBase = GAME_HEIGHT - 96;
    this.chatLines.forEach((entry, i) =>
      entry.text.setY(chatBase - (this.chatLines.length - 1 - i) * 18),
    );
  }

  private drawActionBar(d: HudData): void {
    const g = this.actionGfx;
    g.clear();
    if (!d.action) {
      this.actionText.setText('');
      return;
    }
    // Fill color = the action's owner: objective orange to plant, CT blue
    // to defuse.
    const fill = d.action.label === 'DEFUSING' ? FACTION.CT : BOMB;
    const w = 220;
    const x = GAME_WIDTH / 2 - w / 2;
    const y = GAME_HEIGHT * 0.6;
    this.actionText.setText(`${d.action.label} ${Math.round(d.action.frac * 100)}%`);
    g.fillStyle(PANEL_FILL, PANEL_ALPHA);
    g.fillRect(x, y, w, 12);
    g.lineStyle(1, LINE, 1);
    g.strokeRect(x, y, w, 12);
    g.fillStyle(fill, 1);
    g.fillRect(x + 2, y + 2, (w - 4) * Phaser.Math.Clamp(d.action.frac, 0, 1), 8);
  }

  private drawBuyMenu(d: HudData): void {
    this.buyMenuShown = d.buyMenu;
    this.buyPanel.setVisible(d.buyMenu !== null);
    if (!d.buyMenu) return;
    d.buyMenu.forEach((item, i) => {
      const row = this.buyRows[i];
      if (!row) return;
      row.name.setText(item.label.toUpperCase());
      row.price.setText(`$${item.price}`);
      const alpha = item.enabled ? 1 : 0.5;
      row.key.setAlpha(alpha);
      row.name.setAlpha(alpha);
      row.price.setAlpha(alpha);
      row.price.setColor(item.enabled ? MONEY : DANGER);
    });
  }

  private drawScoreboard(d: HudData): void {
    const show = this.tabKey.isDown;
    this.boardPanel.setVisible(show);
    if (!show) return;
    this.boardHeadScore.setText(`${d.scoreT} : ${d.scoreCT}`);
    // The PING column only exists online (offline no row has a ping).
    const hasPing = d.scoreboard.some((r) => r.ping !== null);
    const body = (team: Team): string => {
      const header = 'PLAYER         K  D     $' + (hasPing ? ' PING' : '');
      const rows = d.scoreboard
        .filter((r) => r.team === team)
        .map(
          (r) =>
            `${r.alive ? ' ' : '†'} ${r.name.padEnd(12)} ${String(r.kills).padStart(2)} ${String(r.deaths).padStart(2)} ${String(r.money).padStart(5)}` +
            (hasPing ? ` ${(r.ping === null ? 'BOT' : String(r.ping)).padStart(4)}` : ''),
        );
      return [header, ...rows].join('\n');
    };
    this.boardBodyT.setText(body('T'));
    this.boardBodyCT.setText(body('CT'));
  }
}
