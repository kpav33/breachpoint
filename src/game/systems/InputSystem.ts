import Phaser from 'phaser';
import { Buttons } from '../../core/types';
import type { InputCommand, Vec2 } from '../../core/types';
import { BIND_ACTIONS, DEFAULT_BINDS, loadSettings } from '../settings';
import type { BindAction, Keybinds } from '../settings';

/**
 * Turns keyboard + mouse into one InputCommand per tick. This is the only
 * place device state is read; everything downstream consumes plain data.
 * Key assignments come from the persisted settings (see game/settings.ts);
 * call reloadBinds() after the settings panel changes them mid-session.
 */
export class InputSystem {
  private keys!: Record<BindAction, Phaser.Input.Keyboard.Key>;
  private wheelDelta = 0;

  constructor(private readonly scene: Phaser.Scene) {
    this.applyBinds(loadSettings().keybinds);
    scene.input.on(
      'wheel',
      (_p: unknown, _o: unknown, _dx: number, dy: number) => (this.wheelDelta += dy),
    );
  }

  /** Re-read persisted keybinds (after the pause-menu panel changed them). */
  reloadBinds(): void {
    const kb = this.scene.input.keyboard;
    if (!kb) return;
    for (const key of Object.values(this.keys)) kb.removeKey(key);
    this.applyBinds(loadSettings().keybinds);
  }

  private applyBinds(binds: Keybinds): void {
    const kb = this.scene.input.keyboard;
    if (!kb) throw new Error('Keyboard plugin unavailable');
    const codes = Phaser.Input.Keyboard.KeyCodes as unknown as Record<string, number>;
    this.keys = {} as Record<BindAction, Phaser.Input.Keyboard.Key>;
    for (const action of BIND_ACTIONS) {
      const name = binds[action] in codes ? binds[action] : DEFAULT_BINDS[action];
      this.keys[action] = kb.addKey(codes[name]);
    }
  }

  sample(tick: number, playerPos: Vec2): InputCommand {
    const moveX = (this.keys.right.isDown ? 1 : 0) - (this.keys.left.isDown ? 1 : 0);
    const moveY = (this.keys.down.isDown ? 1 : 0) - (this.keys.up.isDown ? 1 : 0);

    // Aim must be computed in world space — account for camera scroll,
    // never use raw pointer coords.
    const pointer = this.scene.input.activePointer;
    const world = this.scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const aimAngle = Math.atan2(world.y - playerPos.y, world.x - playerPos.x);

    const JustDown = Phaser.Input.Keyboard.JustDown;
    let buttons = 0;
    if (pointer.isDown) buttons |= Buttons.Shoot;
    if (this.keys.walk.isDown) buttons |= Buttons.Walk;
    if (this.keys.use.isDown) buttons |= Buttons.Use; // held: plant/defuse
    if (JustDown(this.keys.reload)) buttons |= Buttons.Reload;
    if (JustDown(this.keys.drop)) buttons |= Buttons.Drop;
    if (JustDown(this.keys.he)) buttons |= Buttons.ThrowHE;
    if (JustDown(this.keys.flash)) buttons |= Buttons.ThrowFlash;
    if (JustDown(this.keys.smoke)) buttons |= Buttons.ThrowSmoke;
    if (JustDown(this.keys.slotPrimary)) buttons |= Buttons.SelectPrimary;
    if (JustDown(this.keys.slotSecondary)) buttons |= Buttons.SelectSecondary;
    if (JustDown(this.keys.slotMelee)) buttons |= Buttons.SelectMelee;
    if (this.wheelDelta > 0) buttons |= Buttons.NextWeapon;
    else if (this.wheelDelta < 0) buttons |= Buttons.PrevWeapon;
    this.wheelDelta = 0;

    return { tick, moveX, moveY, aimAngle, buttons };
  }
}
