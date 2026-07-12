import Phaser from 'phaser';
import type { Team, WeaponId } from '../core/types';
import type { MatchPhase } from '../match/MatchState';
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
} from '../game/theme';

export interface BuyMenuItem {
  item: WeaponId | 'kit';
  label: string;
  price: number;
  /** Purchasable right now (money, team, not owned). */
  enabled: boolean;
}

export interface ScoreboardRow {
  name: string;
  team: Team;
  kills: number;
  deaths: number;
  money: number;
  alive: boolean;
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
}

export interface HudSource {
  getHud(): HudData;
  buy(item: WeaponId | 'kit'): void;
}

const BUY_ROWS = 4;

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
    const w = this.scale.width;
    const h = this.scale.height;
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

    // Bottom left: hp + money. Bottom right: weapon + ammo.
    this.hpText = text(14, h - 36, this.dataStyle(22), 0, 1);
    this.moneyText = text(14, h - 12, this.dataStyle(17, MONEY), 0, 1);
    this.weaponText = text(w - 14, h - 36, this.displayStyle(15, TEXT_2, '600'), 1, 1);
    this.ammoText = text(w - 14, h - 12, this.dataStyle(22), 1, 1);

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
    const buyKeys = ['ONE', 'TWO', 'THREE', 'FOUR'] as const;
    buyKeys.forEach((key, i) => {
      kb.on(`keydown-${key}`, () => {
        const menu = this.buyMenuShown;
        if (menu && menu[i]?.enabled) this.source.buy(menu[i].item);
      });
    });
  }

  private createBuyPanel(): void {
    const x = 30;
    const y = this.scale.height * 0.3;
    const width = 250;
    const rowH = 34;
    const height = 54 + BUY_ROWS * rowH;

    const bg = this.panel(width, height).setPosition(width / 2, height / 2);
    this.buyTitle = this.add
      .text(16, 14, 'BUY', this.displayStyle(15, TEXT_1, '700'))
      .setDepth(11);
    const hint = this.add
      .text(width - 16, 17, 'PRESS 1–4', this.dataStyle(10, TEXT_3, '500'))
      .setOrigin(1, 0)
      .setDepth(11);

    const rows: Phaser.GameObjects.GameObject[] = [];
    for (let i = 0; i < BUY_ROWS; i++) {
      const ry = 48 + i * rowH;
      const key = this.add.text(16, ry, `${i + 1}`, this.dataStyle(14, FACTION_CSS.T)).setDepth(11);
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
    const w = this.scale.width;
    const h = this.scale.height;
    const bw = 560;
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
      .text(this.scale.width - 14, 0, line, this.dataStyle(13, victimIsMe ? DANGER : color, '600'))
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
    this.moneyText.setText(`$${d.money}`);
    this.weaponText.setText(d.weaponLabel);
    this.ammoText.setText(d.ammoLabel);
    this.ammoText.setColor(d.ammoWarn ? DANGER : TEXT_1);
    this.bombText.setText(
      d.carryingBomb
        ? 'CARRYING THE BOMB — HOLD E IN A SITE TO PLANT'
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

    this.drawActionBar(d);
    this.drawBuyMenu(d);
    this.drawScoreboard(d);

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
    const x = this.scale.width / 2 - w / 2;
    const y = this.scale.height * 0.6;
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
    const body = (team: Team): string => {
      const header = 'PLAYER         K  D     $';
      const rows = d.scoreboard
        .filter((r) => r.team === team)
        .map(
          (r) =>
            `${r.alive ? ' ' : '†'} ${r.name.padEnd(12)} ${String(r.kills).padStart(2)} ${String(r.deaths).padStart(2)} ${String(r.money).padStart(5)}`,
        );
      return [header, ...rows].join('\n');
    };
    this.boardBodyT.setText(body('T'));
    this.boardBodyCT.setText(body('CT'));
  }
}
