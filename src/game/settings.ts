// Player settings persisted to localStorage. Applied at scene creation
// (bot difficulty) or immediately (volume).
import type { BotDifficulty } from '../core/config';

export interface Settings {
  /** Master volume, 0..1. */
  volume: number;
  botDifficulty: BotDifficulty;
  /** Display name used in online matches. */
  playerName: string;
}

const KEY = 'breachpoint.settings';

const DEFAULTS: Settings = {
  volume: 0.8,
  botDifficulty: 'normal',
  playerName: 'Player',
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      volume: typeof parsed.volume === 'number' ? Math.min(Math.max(parsed.volume, 0), 1) : DEFAULTS.volume,
      botDifficulty: ['easy', 'normal', 'hard'].includes(parsed.botDifficulty as string)
        ? (parsed.botDifficulty as BotDifficulty)
        : DEFAULTS.botDifficulty,
      playerName:
        typeof parsed.playerName === 'string' && parsed.playerName.trim()
          ? parsed.playerName.trim().slice(0, 16)
          : DEFAULTS.playerName,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Private-mode storage failures are non-fatal.
  }
}
