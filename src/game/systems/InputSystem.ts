import Phaser from 'phaser';
import { Buttons } from '../../core/types';
import type { InputCommand, Vec2 } from '../../core/types';

/**
 * Turns keyboard + mouse into one InputCommand per tick. This is the only
 * place device state is read; everything downstream consumes plain data.
 */
export class InputSystem {
  private readonly keys: Record<'w' | 'a' | 's' | 'd' | 'shift', Phaser.Input.Keyboard.Key>;

  constructor(private readonly scene: Phaser.Scene) {
    const kb = scene.input.keyboard;
    if (!kb) throw new Error('Keyboard plugin unavailable');
    const K = Phaser.Input.Keyboard.KeyCodes;
    this.keys = {
      w: kb.addKey(K.W),
      a: kb.addKey(K.A),
      s: kb.addKey(K.S),
      d: kb.addKey(K.D),
      shift: kb.addKey(K.SHIFT),
    };
  }

  sample(tick: number, playerPos: Vec2): InputCommand {
    const moveX = (this.keys.d.isDown ? 1 : 0) - (this.keys.a.isDown ? 1 : 0);
    const moveY = (this.keys.s.isDown ? 1 : 0) - (this.keys.w.isDown ? 1 : 0);

    // Aim must be computed in world space — account for camera scroll,
    // never use raw pointer coords.
    const pointer = this.scene.input.activePointer;
    const world = this.scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const aimAngle = Math.atan2(world.y - playerPos.y, world.x - playerPos.x);

    let buttons = 0;
    if (this.keys.shift.isDown) buttons |= Buttons.Walk;
    if (pointer.isDown) buttons |= Buttons.Shoot;

    return { tick, moveX, moveY, aimAngle, buttons };
  }
}
