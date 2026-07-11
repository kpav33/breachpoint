import Phaser from 'phaser';
import type { Team, WeaponId } from '../core/types';
import type { MatchPhase } from '../match/MatchState';

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
  banner: string | null;
  subBanner: string | null;
  spectating: string | null;
  /** Non-null only while the buy menu should be open. */
  buyMenu: BuyMenuItem[] | null;
  scoreboard: ScoreboardRow[];
}

export interface HudSource {
  getHud(): HudData;
  buy(item: WeaponId | 'kit'): void;
}

const FONT = { fontFamily: 'monospace', color: '#c8d2dc' };

/**
 * Parallel HUD scene (Phase 7): clock/score, hp/money/ammo, bomb state,
 * buy menu, kill feed, Tab scoreboard. Pull-model: reads HudData from the
 * GameScene each frame and renders it — no game logic, no world objects.
 */
export class UIScene extends Phaser.Scene {
  private source!: HudSource;
  private clockText!: Phaser.GameObjects.Text;
  private scoreText!: Phaser.GameObjects.Text;
  private aliveText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text; // hp + money
  private ammoText!: Phaser.GameObjects.Text;
  private bombText!: Phaser.GameObjects.Text;
  private bannerText!: Phaser.GameObjects.Text;
  private subBannerText!: Phaser.GameObjects.Text;
  private spectateText!: Phaser.GameObjects.Text;
  private actionGfx!: Phaser.GameObjects.Graphics;
  private actionText!: Phaser.GameObjects.Text;
  private buyText!: Phaser.GameObjects.Text;
  private scoreboardText!: Phaser.GameObjects.Text;
  private scoreboardBg!: Phaser.GameObjects.Rectangle;
  private killFeed: { text: Phaser.GameObjects.Text; ttl: number }[] = [];
  private tabKey!: Phaser.Input.Keyboard.Key;
  private buyMenuShown: BuyMenuItem[] | null = null;

  constructor() {
    super('UI');
  }

  init(data: { source: HudSource }): void {
    this.source = data.source;
  }

  create(): void {
    const w = this.scale.width;
    const h = this.scale.height;
    const text = (
      x: number,
      y: number,
      size: number,
      originX = 0,
      originY = 0,
    ): Phaser.GameObjects.Text =>
      this.add
        .text(x, y, '', { ...FONT, fontSize: `${size}px` })
        .setOrigin(originX, originY)
        .setDepth(10);

    this.clockText = text(w / 2, 10, 24, 0.5);
    this.scoreText = text(w / 2, 40, 16, 0.5);
    this.aliveText = text(w / 2, 62, 14, 0.5);
    this.statusText = text(12, h - 30, 16);
    this.ammoText = text(w - 12, h - 30, 16, 1);
    this.bombText = text(w / 2, h - 30, 14, 0.5).setColor('#ff9500');
    this.bannerText = text(w / 2, h * 0.34, 34, 0.5, 0.5);
    this.subBannerText = text(w / 2, h * 0.34 + 34, 16, 0.5, 0.5);
    this.spectateText = text(w / 2, h * 0.82, 16, 0.5).setColor('#9aa4ae');
    this.actionGfx = this.add.graphics().setDepth(10);
    this.actionText = text(w / 2, h * 0.6 - 22, 14, 0.5);
    this.buyText = text(24, h * 0.25, 16).setLineSpacing(6);
    this.scoreboardBg = this.add
      .rectangle(w / 2, h / 2, 460, 300, 0x0d0f12, 0.88)
      .setDepth(20)
      .setVisible(false);
    this.scoreboardText = text(w / 2 - 210, h / 2 - 130, 15).setDepth(21).setLineSpacing(8);

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

  /** Push one kill-feed line (already formatted/colored by the caller). */
  addKillFeedLine(line: string, color: string): void {
    const t = this.add
      .text(this.scale.width - 12, 0, line, { ...FONT, fontSize: '14px', color })
      .setOrigin(1, 0)
      .setDepth(10);
    this.killFeed.unshift({ text: t, ttl: 6000 });
    while (this.killFeed.length > 5) this.killFeed.pop()!.text.destroy();
  }

  update(_time: number, delta: number): void {
    const d = this.source.getHud();

    const mm = Math.floor(Math.max(d.clockSec, 0) / 60);
    const ss = Math.floor(Math.max(d.clockSec, 0) % 60);
    if (d.bombPlanted) {
      this.clockText.setText(`${Math.ceil(d.bombTimeLeft)}`).setColor('#ff5544');
    } else {
      this.clockText.setText(`${mm}:${String(ss).padStart(2, '0')}`).setColor('#c8d2dc');
    }
    this.scoreText.setText(`T ${d.scoreT}  :  ${d.scoreCT} CT    round ${d.round}`);
    this.aliveText.setText(`${d.aliveT} alive  v  ${d.aliveCT} alive`);
    this.statusText.setText(`HP ${d.hp}    $${d.money}`);
    this.ammoText.setText(`${d.weaponLabel}  ${d.ammoLabel}`);
    this.ammoText.setColor(d.ammoWarn ? '#d9534f' : '#c8d2dc');
    this.bombText.setText(
      d.carryingBomb ? 'CARRYING THE BOMB — hold E in a site to plant' : d.bombPlanted ? 'BOMB PLANTED' : '',
    );
    this.bannerText.setText(d.banner ?? '');
    this.subBannerText.setText(d.subBanner ?? '');
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
        entry.text.setAlpha(Math.min(1, entry.ttl / 1500));
      }
    }
    this.killFeed.forEach((entry, i) => entry.text.setY(84 + i * 20));
  }

  private drawActionBar(d: HudData): void {
    const g = this.actionGfx;
    g.clear();
    if (!d.action) {
      this.actionText.setText('');
      return;
    }
    const w = 220;
    const x = this.scale.width / 2 - w / 2;
    const y = this.scale.height * 0.6;
    this.actionText.setText(d.action.label);
    g.fillStyle(0x0d0f12, 0.8);
    g.fillRect(x, y, w, 12);
    g.fillStyle(0xff9500, 1);
    g.fillRect(x + 2, y + 2, (w - 4) * Phaser.Math.Clamp(d.action.frac, 0, 1), 8);
  }

  private drawBuyMenu(d: HudData): void {
    this.buyMenuShown = d.buyMenu;
    if (!d.buyMenu) {
      this.buyText.setText('');
      return;
    }
    const lines = ['BUY  (press number)', ''];
    d.buyMenu.forEach((item, i) => {
      const mark = item.enabled ? ' ' : '×';
      lines.push(`${mark}[${i + 1}] ${item.label.padEnd(12)} $${item.price}`);
    });
    this.buyText.setText(lines.join('\n'));
  }

  private drawScoreboard(d: HudData): void {
    const show = this.tabKey.isDown;
    this.scoreboardBg.setVisible(show);
    this.scoreboardText.setVisible(show);
    if (!show) return;
    const lines = ['  PLAYER        K   D   $', ''];
    for (const team of ['T', 'CT'] as Team[]) {
      lines.push(`— ${team} —`);
      for (const r of d.scoreboard.filter((r) => r.team === team)) {
        const dead = r.alive ? ' ' : '†';
        lines.push(
          `${dead} ${r.name.padEnd(12)} ${String(r.kills).padStart(2)}  ${String(r.deaths).padStart(2)}  ${r.money}`,
        );
      }
      lines.push('');
    }
    this.scoreboardText.setText(lines.join('\n'));
  }
}
