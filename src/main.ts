import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene';
import { MenuScene } from './scenes/MenuScene';
import { GameScene } from './scenes/GameScene';
import { PracticeScene } from './scenes/PracticeScene';
import { LobbyScene } from './scenes/LobbyScene';
import { OnlineGameScene } from './scenes/OnlineGameScene';
import { UIScene } from './scenes/UIScene';
import { PauseScene } from './scenes/PauseScene';
import { WORLD } from './game/theme';
import { renderScale, installScaleHandler } from './game/display';

const rs = renderScale();

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  // Backing store matches the canvas's on-screen device-pixel size exactly
  // (no CSS resampling → crisp text); scenes stay in logical 1280×720
  // coordinates via applyHiDPI() camera zoom (see game/display.ts).
  width: rs.backingW,
  height: rs.backingH,
  backgroundColor: WORLD.void,
  // Flat geometric/vector art style — keep antialiasing on, no pixelArt.
  antialias: true,
  scale: {
    // Scale.NONE: display.ts owns fitting/centering. The CSS zoom shrinks
    // the device-pixel backing store to its CSS size (and keeps Phaser's
    // pointer mapping correct).
    mode: Phaser.Scale.NONE,
    zoom: rs.cssW / rs.backingW,
    autoCenter: Phaser.Scale.NO_CENTER,
  },
  scene: [BootScene, MenuScene, LobbyScene, GameScene, PracticeScene, OnlineGameScene, UIScene, PauseScene],
});

installScaleHandler(game);
