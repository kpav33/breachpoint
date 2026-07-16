// Player settings persisted to localStorage. Applied at scene creation
// (bot difficulty, keybinds) or immediately (volume).
import Phaser from 'phaser';
import type { BotDifficulty } from '../core/config';

/** Every rebindable action, in the order the settings panel lists them. */
export const BIND_ACTIONS = [
  'up',
  'down',
  'left',
  'right',
  'walk',
  'use',
  'reload',
  'drop',
  'he',
  'flash',
  'smoke',
  'slotPrimary',
  'slotSecondary',
  'slotMelee',
] as const;

export type BindAction = (typeof BIND_ACTIONS)[number];

/** Values are Phaser KeyCodes names (keys of Phaser.Input.Keyboard.KeyCodes). */
export type Keybinds = Record<BindAction, string>;

export const DEFAULT_BINDS: Keybinds = {
  up: 'W',
  down: 'S',
  left: 'A',
  right: 'D',
  walk: 'SHIFT',
  use: 'E',
  reload: 'R',
  drop: 'G',
  he: 'X',
  flash: 'F',
  smoke: 'C',
  slotPrimary: 'ONE',
  slotSecondary: 'TWO',
  slotMelee: 'THREE',
};

/** Panel labels for each action. */
export const BIND_LABELS: Record<BindAction, string> = {
  up: 'MOVE UP',
  down: 'MOVE DOWN',
  left: 'MOVE LEFT',
  right: 'MOVE RIGHT',
  walk: 'WALK (SLOW)',
  use: 'USE / PLANT / DEFUSE',
  reload: 'RELOAD',
  drop: 'DROP WEAPON',
  he: 'HE GRENADE',
  flash: 'FLASHBANG',
  smoke: 'SMOKE',
  slotPrimary: 'PRIMARY',
  slotSecondary: 'SECONDARY',
  slotMelee: 'KNIFE',
};

/** Short display form for a KeyCodes name (e.g. ONE → "1", SHIFT → "SHIFT"). */
export function keyDisplayName(codeName: string): string {
  const digits: Record<string, string> = {
    ZERO: '0', ONE: '1', TWO: '2', THREE: '3', FOUR: '4',
    FIVE: '5', SIX: '6', SEVEN: '7', EIGHT: '8', NINE: '9',
  };
  return digits[codeName] ?? codeName;
}

function isKeyCodeName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    Object.prototype.hasOwnProperty.call(Phaser.Input.Keyboard.KeyCodes, name)
  );
}

export interface Settings {
  /** Master volume, 0..1. */
  volume: number;
  botDifficulty: BotDifficulty;
  /** Display name used in online matches. */
  playerName: string;
  keybinds: Keybinds;
}

const KEY = 'breachpoint.settings';

const DEFAULTS: Settings = {
  volume: 0.8,
  botDifficulty: 'normal',
  playerName: 'Player',
  keybinds: DEFAULT_BINDS,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const binds = { ...DEFAULT_BINDS };
    if (typeof parsed.keybinds === 'object' && parsed.keybinds !== null) {
      for (const action of BIND_ACTIONS) {
        const v = (parsed.keybinds as Record<string, unknown>)[action];
        if (isKeyCodeName(v)) binds[action] = v;
      }
    }
    return {
      volume: typeof parsed.volume === 'number' ? Math.min(Math.max(parsed.volume, 0), 1) : DEFAULTS.volume,
      botDifficulty: ['easy', 'normal', 'hard'].includes(parsed.botDifficulty as string)
        ? (parsed.botDifficulty as BotDifficulty)
        : DEFAULTS.botDifficulty,
      playerName:
        typeof parsed.playerName === 'string' && parsed.playerName.trim()
          ? parsed.playerName.trim().slice(0, 16)
          : DEFAULTS.playerName,
      keybinds: binds,
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Private-mode storage failures are non-fatal.
  }
}
