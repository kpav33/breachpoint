import Phaser from 'phaser';
import type { SimEvent, Vec2, WeaponId } from '../../core/types';

interface Tracer {
  kind: 'tracer';
  from: Vec2;
  to: Vec2;
}
interface Flash {
  kind: 'flash';
  at: Vec2;
  radius: number;
  color: number;
}
interface Spark {
  kind: 'spark';
  at: Vec2;
  rays: { angle: number; len: number }[];
}
interface Ring {
  kind: 'ring';
  at: Vec2;
  maxRadius: number;
  color: number;
}
type Fx = (Tracer | Flash | Spark | Ring) & { age: number; dur: number };

interface Casing {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  spin: number;
  age: number;
}

/** Render-side kick per weapon: camera shake intensity + recoil nudge px. */
const KICK: Record<WeaponId, { shake: number; recoil: number }> = {
  knife: { shake: 0, recoil: 0 },
  pistol: { shake: 0.0012, recoil: 3 },
  deagle: { shake: 0.0022, recoil: 6 },
  smg: { shake: 0.0014, recoil: 3 },
  rifle: { shake: 0.002, recoil: 5 },
  sniper: { shake: 0.005, recoil: 12 },
  shotgun: { shake: 0.004, recoil: 9 },
};

const CASING_MAX = 64;
const CASING_LIFE = 2.8; // seconds; fades over the last 0.5s

/**
 * Render-only feedback: tracers, flashes, sparks, shell casings, permanent
 * decals (blood, bullet holes), camera shake + recoil. Consumes SimEvents;
 * never touches simulation state.
 */
export class EffectsSystem {
  private readonly gfx: Phaser.GameObjects.Graphics;
  private readonly casingGfx: Phaser.GameObjects.Graphics;
  private readonly decals: Phaser.GameObjects.RenderTexture;
  private readonly stamp: Phaser.GameObjects.Graphics;
  private readonly fx: Fx[] = [];
  private readonly casings: Casing[] = [];
  private recoil = { x: 0, y: 0 };

  constructor(
    private readonly scene: Phaser.Scene,
    mapWidthPx: number,
    mapHeightPx: number,
  ) {
    // Depths: floor 0 < decals 2 < walls 3 < players 5 < this.gfx 10.
    this.decals = scene.add
      .renderTexture(0, 0, mapWidthPx, mapHeightPx)
      .setOrigin(0)
      .setDepth(2);
    this.stamp = scene.make.graphics(undefined, false);
    this.casingGfx = scene.add.graphics().setDepth(4);
    this.gfx = scene.add.graphics().setDepth(10);
  }

  /** localId: whose screen this is — their own shots kick the camera. */
  handle(ev: SimEvent, localId: string, victimPos?: Vec2): void {
    if (ev.type === 'shot') {
      this.fx.push({ kind: 'tracer', from: ev.from, to: ev.to, age: 0, dur: 70 });
      this.fx.push({ kind: 'flash', at: ev.from, radius: 6, color: 0xffe9a0, age: 0, dur: 50 });

      if (ev.hit === 'wall') {
        this.fx.push({
          kind: 'spark',
          at: ev.to,
          rays: Array.from({ length: 4 }, () => ({
            angle: Math.random() * Math.PI * 2,
            len: 4 + Math.random() * 5,
          })),
          age: 0,
          dur: 120,
        });
        this.stampBulletHole(ev.to);
      } else if (ev.hit === 'player') {
        this.bulletImpact(ev.to);
      }

      if (ev.weaponId !== 'knife') this.ejectCasing(ev.from, ev.to);

      if (ev.playerId === localId) {
        const kick = KICK[ev.weaponId];
        if (kick.shake > 0) this.scene.cameras.main.shake(50, kick.shake);
        const dx = ev.to.x - ev.from.x;
        const dy = ev.to.y - ev.from.y;
        const len = Math.hypot(dx, dy) || 1;
        this.recoil.x += (dx / len) * kick.recoil;
        this.recoil.y += (dy / len) * kick.recoil;
      }
    } else if (ev.type === 'death' && victimPos) {
      this.fx.push({ kind: 'ring', at: victimPos, maxRadius: 26, color: 0xff5544, age: 0, dur: 260 });
      this.stampBlood(victimPos, 8);
    }
  }

  /**
   * Blood puff where a bullet landed on a player. Split out because online
   * this is the one half of your own shot that only the server can place — it
   * rolled the spread — so it keeps coming from the echoed event even when the
   * rest of the shot was drawn from client prediction.
   */
  bulletImpact(at: Vec2): void {
    this.fx.push({ kind: 'flash', at, radius: 5, color: 0xff5544, age: 0, dur: 110 });
    this.stampBlood(at, 3);
  }

  /** Shake for taking a hit (no weapon involved). */
  damageShake(): void {
    this.scene.cameras.main.shake(80, 0.003);
  }

  /** Explosion visual: bright core flash + expanding ring. */
  explosion(at: Vec2, radius: number): void {
    this.fx.push({ kind: 'flash', at, radius: 26, color: 0xffe9a0, age: 0, dur: 130 });
    this.fx.push({ kind: 'ring', at, maxRadius: radius * 0.55, color: 0xffb020, age: 0, dur: 320 });
    this.stampBulletHole(at); // scorch mark
  }

  private stampBulletHole(at: Vec2): void {
    const g = this.stamp;
    g.clear();
    g.fillStyle(0x14171c, 0.9);
    g.fillCircle(0, 0, 1.8);
    g.fillStyle(0x30363e, 0.5);
    g.fillCircle(0.8, -0.8, 0.9);
    this.decals.draw(g, at.x, at.y);
  }

  private stampBlood(at: Vec2, size: number): void {
    const g = this.stamp;
    g.clear();
    g.fillStyle(0x7a1c1c, 0.65);
    const blobs = size >= 6 ? 7 : 4;
    for (let i = 0; i < blobs; i++) {
      g.fillCircle(
        (Math.random() - 0.5) * size * 2.2,
        (Math.random() - 0.5) * size * 2.2,
        size * (0.35 + Math.random() * 0.5),
      );
    }
    this.decals.draw(g, at.x, at.y);
  }

  private ejectCasing(from: Vec2, to: Vec2): void {
    const aim = Math.atan2(to.y - from.y, to.x - from.x);
    const eject = aim + Math.PI / 2 + (Math.random() - 0.5) * 0.6;
    const speed = 110 + Math.random() * 70;
    this.casings.push({
      x: from.x,
      y: from.y,
      vx: Math.cos(eject) * speed,
      vy: Math.sin(eject) * speed,
      rot: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 14,
      age: 0,
    });
    if (this.casings.length > CASING_MAX) this.casings.shift();
  }

  /** Call once per frame; dt in ms. */
  update(dt: number): void {
    this.updateFx(dt);
    this.updateCasings(dt / 1000);

    // Recoil offset decays back to center; positive followOffset shifts the
    // view opposite the shot direction.
    const decay = Math.exp(-dt / 90);
    this.recoil.x *= decay;
    this.recoil.y *= decay;
    this.scene.cameras.main.setFollowOffset(this.recoil.x, this.recoil.y);
  }

  private updateFx(dt: number): void {
    const g = this.gfx;
    g.clear();
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      f.age += dt;
      if (f.age >= f.dur) {
        this.fx.splice(i, 1);
        continue;
      }
      const fade = 1 - f.age / f.dur;
      switch (f.kind) {
        case 'tracer':
          g.lineStyle(2, 0xffe9a0, 0.8 * fade);
          g.lineBetween(f.from.x, f.from.y, f.to.x, f.to.y);
          break;
        case 'flash':
          g.fillStyle(f.color, 0.9 * fade);
          g.fillCircle(f.at.x, f.at.y, f.radius * (0.5 + 0.5 * fade));
          break;
        case 'spark':
          g.lineStyle(1, 0xd0d4da, fade);
          for (const r of f.rays) {
            const reach = r.len * (f.age / f.dur);
            g.lineBetween(
              f.at.x + Math.cos(r.angle) * reach * 0.4,
              f.at.y + Math.sin(r.angle) * reach * 0.4,
              f.at.x + Math.cos(r.angle) * reach,
              f.at.y + Math.sin(r.angle) * reach,
            );
          }
          break;
        case 'ring':
          g.lineStyle(2, f.color, fade);
          g.strokeCircle(f.at.x, f.at.y, f.maxRadius * (f.age / f.dur));
          break;
      }
    }
  }

  private updateCasings(dt: number): void {
    const g = this.casingGfx;
    g.clear();
    const friction = Math.exp(-dt * 5);
    for (let i = this.casings.length - 1; i >= 0; i--) {
      const c = this.casings[i];
      c.age += dt;
      if (c.age >= CASING_LIFE) {
        this.casings.splice(i, 1);
        continue;
      }
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.vx *= friction;
      c.vy *= friction;
      c.rot += c.spin * dt;
      c.spin *= friction;

      const alpha = Math.min(1, (CASING_LIFE - c.age) / 0.5);
      g.save();
      g.translateCanvas(c.x, c.y);
      g.rotateCanvas(c.rot);
      g.fillStyle(0xd9b24a, alpha);
      g.fillRect(-2, -1, 4, 2);
      g.restore();
    }
  }
}
