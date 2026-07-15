import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene';
import { MenuScene } from './scenes/MenuScene';
import { GameScene } from './scenes/GameScene';
import { LobbyScene } from './scenes/LobbyScene';
import { OnlineGameScene } from './scenes/OnlineGameScene';
import { UIScene } from './scenes/UIScene';
import { PauseScene } from './scenes/PauseScene';
import { WORLD } from './game/theme';
import { GAME_WIDTH, GAME_HEIGHT, DPR } from './game/display';

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  // Backing store is oversampled by DPR; scenes stay in logical 1280×720
  // coordinates via applyHiDPI() camera zoom (see game/display.ts).
  width: GAME_WIDTH * DPR,
  height: GAME_HEIGHT * DPR,
  backgroundColor: WORLD.void,
  // Flat geometric/vector art style — keep antialiasing on, no pixelArt.
  antialias: true,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [BootScene, MenuScene, LobbyScene, GameScene, OnlineGameScene, UIScene, PauseScene],
});
