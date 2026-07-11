import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../main';
import { DebugOverlay } from '../game/debug/DebugOverlay';

/**
 * Thin orchestrator scene. Phase 0: renders a placeholder rectangle
 * "player" and the debug overlay. Movement arrives in Phase 1, driven by
 * the core/ simulation.
 */
export class GameScene extends Phaser.Scene {
  private debug!: DebugOverlay;

  constructor() {
    super('Game');
  }

  create(): void {
    this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, 32, 32, 0x4da6ff);

    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT - 24, 'Phase 0 — press ` for debug overlay', {
        fontFamily: 'monospace',
        fontSize: '13px',
        color: '#555c66',
      })
      .setOrigin(0.5);

    this.debug = new DebugOverlay(this);
  }

  update(): void {
    this.debug.update();
  }
}
