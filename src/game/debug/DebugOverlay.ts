import Phaser from 'phaser';

/**
 * Debug overlay scaffold, toggled with backtick (`).
 *
 * Phase 0: FPS counter. Every later phase extends this with its invisible
 * state — collision grid (Ph1), wall segments (Ph2), raycasts + spread cone
 * (Ph3), visibility polygon (Ph4), bot states + paths (Ph6). Add a line via
 * setLine() for text stats; draw geometry into `gfx` from the owning scene.
 */
export class DebugOverlay {
  /** Scratch graphics for debug geometry, cleared every frame while visible. */
  readonly gfx: Phaser.GameObjects.Graphics;

  private readonly text: Phaser.GameObjects.Text;
  private readonly lines = new Map<string, string>();
  private visible = false;

  constructor(private readonly scene: Phaser.Scene) {
    this.text = scene.add
      .text(8, 8, '', {
        fontFamily: 'monospace',
        fontSize: '14px',
        color: '#00ff88',
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        padding: { x: 6, y: 4 },
      })
      .setScrollFactor(0)
      .setDepth(1000)
      .setVisible(false);

    this.gfx = scene.add.graphics().setDepth(999).setVisible(false);

    scene.input.keyboard?.on('keydown-BACKTICK', () => this.toggle());
  }

  toggle(): void {
    this.visible = !this.visible;
    this.text.setVisible(this.visible);
    this.gfx.setVisible(this.visible);
    if (!this.visible) this.gfx.clear();
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Set or update a named stat line, e.g. setLine('fps', '60.0'). */
  setLine(key: string, value: string): void {
    this.lines.set(key, value);
  }

  /** Call once per frame from the owning scene's update(). */
  update(): void {
    if (!this.visible) return;
    this.gfx.clear();
    this.setLine('fps', this.scene.game.loop.actualFps.toFixed(1));
    this.text.setText(
      [...this.lines.entries()].map(([k, v]) => `${k}: ${v}`).join('\n'),
    );
  }
}
