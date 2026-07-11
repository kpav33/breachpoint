import Phaser from 'phaser';
import { Buttons } from '../../core/types';
import type { InputCommand, Vec2 } from '../../core/types';

/**
 * Turns keyboard + mouse into one InputCommand per tick. This is the only
 * place device state is read; everything downstream consumes plain data.
 */
export class InputSystem {
  private readonly keys: Record<
    'w' | 'a' | 's' | 'd' | 'shift' | 'r' | 'one' | 'two' | 'three',
    Phaser.Input.Keyboard.Key
  >;
  private wheelDelta = 0;

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
      r: kb.addKey(K.R),
      one: kb.addKey(K.ONE),
      two: kb.addKey(K.TWO),
      three: kb.addKey(K.THREE),
    };
    scene.input.on(
      'wheel',
      (_p: unknown, _o: unknown, _dx: number, dy: number) => (this.wheelDelta += dy),
    );
  }

  sample(tick: number, playerPos: Vec2): InputCommand {
    const moveX = (this.keys.d.isDown ? 1 : 0) - (this.keys.a.isDown ? 1 : 0);
    const moveY = (this.keys.s.isDown ? 1 : 0) - (this.keys.w.isDown ? 1 : 0);

    // Aim must be computed in world space — account for camera scroll,
    // never use raw pointer coords.
    const pointer = this.scene.input.activePointer;
    const world = this.scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const aimAngle = Math.atan2(world.y - playerPos.y, world.x - playerPos.x);

    const JustDown = Phaser.Input.Keyboard.JustDown;
    let buttons = 0;
    if (pointer.isDown) buttons |= Buttons.Shoot;
    if (this.keys.shift.isDown) buttons |= Buttons.Walk;
    if (JustDown(this.keys.r)) buttons |= Buttons.Reload;
    if (JustDown(this.keys.one)) buttons |= Buttons.SelectPrimary;
    if (JustDown(this.keys.two)) buttons |= Buttons.SelectSecondary;
    if (JustDown(this.keys.three)) buttons |= Buttons.SelectMelee;
    if (this.wheelDelta > 0) buttons |= Buttons.NextWeapon;
    else if (this.wheelDelta < 0) buttons |= Buttons.PrevWeapon;
    this.wheelDelta = 0;

    return { tick, moveX, moveY, aimAngle, buttons };
  }
}
