import Phaser from 'phaser';
import type { SimEvent, Vec2 } from '../../core/types';

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

/**
 * Short-lived render-only effects (tracers, muzzle flashes, impact sparks,
 * death rings). Consumes SimEvents; never touches simulation state.
 */
export class EffectsSystem {
  private readonly gfx: Phaser.GameObjects.Graphics;
  private readonly fx: Fx[] = [];

  constructor(scene: Phaser.Scene) {
    this.gfx = scene.add.graphics().setDepth(10);
  }

  handle(ev: SimEvent, victimPos?: Vec2): void {
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
      } else if (ev.hit === 'player') {
        this.fx.push({ kind: 'flash', at: ev.to, radius: 5, color: 0xff5544, age: 0, dur: 110 });
      }
    } else if (ev.type === 'death' && victimPos) {
      this.fx.push({ kind: 'ring', at: victimPos, maxRadius: 26, color: 0xff5544, age: 0, dur: 260 });
    }
  }

  /** Call once per frame; dt in ms. */
  update(dt: number): void {
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
}
