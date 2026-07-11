import Phaser from 'phaser';
import type { PlayerState, Vec2, WeaponId } from '../../core/types';

/** Base volume + audible range (px) per sound. range 0 = UI sound, no spatialization. */
const SOUNDS = {
  shot_knife: { vol: 0.5, range: 300 },
  shot_pistol: { vol: 0.55, range: 1200 },
  shot_smg: { vol: 0.5, range: 1200 },
  shot_rifle: { vol: 0.6, range: 1400 },
  shot_sniper: { vol: 0.7, range: 1800 },
  reload: { vol: 0.5, range: 400 },
  footstep1: { vol: 0.35, range: 480 },
  footstep2: { vol: 0.35, range: 480 },
  footstep3: { vol: 0.35, range: 480 },
  hit: { vol: 0.45, range: 0 },
  hurt: { vol: 0.55, range: 0 },
  death: { vol: 0.65, range: 800 },
  bomb_plant: { vol: 0.6, range: 1000 },
  bomb_beep: { vol: 0.5, range: 1800 },
  bomb_defused: { vol: 0.6, range: 1200 },
  // The whole map hears the bomb go off.
  bomb_explode: { vol: 0.9, range: 4000 },
} as const;
export type SoundKey = keyof typeof SOUNDS;

/**
 * Footsteps only above this speed — walking (shift) is silent, a core CS
 * mechanic. Every run speed exceeds it (min 170 px/s with sniper), every
 * walk speed stays under it (max 121 px/s with knife).
 */
const FOOTSTEP_MIN_SPEED = 140;
/** Distance in px traveled between footsteps. */
const FOOTSTEP_STRIDE = 55;
/** World px from listener to screen-edge pan. */
const PAN_RANGE = 640;

/**
 * Positional audio: volume falls off with distance from the listener,
 * pan follows the horizontal offset. Footsteps of *unseen* players play
 * too — hearing through fog is intended.
 */
export class AudioSystem {
  private listener: Vec2 = { x: 0, y: 0 };
  private strideAcc: Record<string, number> = {};

  constructor(private readonly scene: Phaser.Scene) {}

  static preload(scene: Phaser.Scene): void {
    for (const key of Object.keys(SOUNDS)) {
      scene.load.audio(key, `assets/audio/${key}.wav`);
    }
  }

  setListener(p: Vec2): void {
    this.listener.x = p.x;
    this.listener.y = p.y;
  }

  shotKey(weaponId: WeaponId): SoundKey {
    return `shot_${weaponId}` as SoundKey;
  }

  play(key: SoundKey, at?: Vec2): void {
    const def = SOUNDS[key];
    let volume = def.vol;
    let pan = 0;
    if (at && def.range > 0) {
      const dx = at.x - this.listener.x;
      const dist = Math.hypot(dx, at.y - this.listener.y);
      if (dist >= def.range) return;
      volume *= Math.pow(1 - dist / def.range, 1.4);
      if (volume < 0.02) return;
      pan = Phaser.Math.Clamp(dx / PAN_RANGE, -1, 1) * 0.75;
    }
    const snd = this.scene.sound.add(key);
    snd.once('complete', () => snd.destroy());
    if ('setPan' in snd) (snd as Phaser.Sound.WebAudioSound).setPan(pan);
    snd.play({ volume, rate: 0.94 + Math.random() * 0.12 });
  }

  /** Distance-accumulated footsteps for every moving player; dt in seconds. */
  updateFootsteps(players: PlayerState[], dt: number): void {
    for (const p of players) {
      const speed = Math.hypot(p.vel.x, p.vel.y);
      if (p.hp <= 0 || speed < FOOTSTEP_MIN_SPEED) {
        this.strideAcc[p.id] = 0;
        continue;
      }
      this.strideAcc[p.id] = (this.strideAcc[p.id] ?? 0) + speed * dt;
      if (this.strideAcc[p.id] >= FOOTSTEP_STRIDE) {
        this.strideAcc[p.id] = 0;
        const variant = (1 + Math.floor(Math.random() * 3)) as 1 | 2 | 3;
        this.play(`footstep${variant}`, p.pos);
      }
    }
  }
}
