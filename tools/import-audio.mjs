#!/usr/bin/env node
// Import real CC0 sound assets into public/assets/audio/, converting them to
// the game's expected format (mono 22.05 kHz 16-bit WAV) with the correct
// filenames — so nothing in the code changes (per public/assets/audio/README).
//
// Sources (all CC0):
//   - Kenney "Impact Sounds"     (impacts, footsteps)
//   - Kenney "Interface Sounds"  (bomb UI beeps/confirms)
//   - "The Free Firearm Sound Library" / "Prepared SFX Library" (gunshots)
//   - "100 CC0 SFX"              (explosion, reload clack, whoosh, hiss)
//
// The firearm files are 10–17 s recordings of MANY test shots at 96 kHz; each
// gunshot below is auto-trimmed to a single shot (strip leading silence, keep
// a short window). Harmless for the already-short Kenney/100-CC0 clips.
//
// Usage:
//   1. Extract the four packs somewhere (default: the folder below).
//   2. Install ffmpeg  (WSL: sudo apt install ffmpeg).
//   3. node tools/import-audio.mjs [sourceDir]
//
// Nothing is overwritten in git history — only the WAVs under
// public/assets/audio/ are (re)written. Re-run any time you swap a pick.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public/assets/audio');

// Where the extracted packs live. Override with an argv or the SOUNDS_DIR env.
const SOURCE_DIR =
  process.argv[2] ||
  process.env.SOUNDS_DIR ||
  '/mnt/c/Users/kleme/Downloads/sounds';

// Target output format (matches the placeholders the code was tuned against).
const SAMPLE_RATE = 22050;

/**
 * One import: `out` is the target basename (no extension — always .wav).
 * `src` is the unique source basename to find recursively under SOURCE_DIR.
 * Optional processing:
 *   trim       — keep only the first N seconds (after any silence strip)
 *   strip      — remove leading silence first (gunshots: jump to the first bang)
 *   semitones  — pitch shift (negative = deeper); used to make the bomb boom
 *                distinct from the HE blast when both come from one explosion.
 */
const MAP = [
  // --- Gunshots: trim one shot out of the long multi-shot recordings --------
  { out: 'shot_pistol', src: 'X_31P.wav', strip: true, trim: 0.35 }, // Walther PPQ
  { out: 'shot_deagle', src: 'V_22P.wav', strip: true, trim: 0.4 }, // S&W 642 revolver
  { out: 'shot_smg', src: 'P_16P.wav', strip: true, trim: 0.3 }, // PPSh
  { out: 'shot_rifle', src: 'C_27P.wav', strip: true, trim: 0.35 }, // AK-47
  { out: 'shot_sniper', src: 'M_21P.wav', strip: true, trim: 0.55 }, // Mosin Nagant
  { out: 'shot_shotgun', src: 'N_26P.wav', strip: true, trim: 0.5 }, // Mossberg

  // --- Impacts / feedback ---------------------------------------------------
  { out: 'hit', src: 'impactGeneric_light_000.ogg' },
  { out: 'hurt', src: 'impactSoft_medium_000.ogg' },
  { out: 'death', src: 'impactSoft_heavy_000.ogg' },
  { out: 'flash_pop', src: 'impactGlass_light_000.ogg' },
  { out: 'reload', src: 'metal_02.ogg' },

  // --- Explosions: same source, bomb pitched down to sound bigger/distinct ---
  { out: 'he_explode', src: 'explosion.ogg' },
  { out: 'bomb_explode', src: 'explosion.ogg', semitones: -3 },

  // --- Bomb UI --------------------------------------------------------------
  { out: 'bomb_plant', src: 'confirmation_001.ogg' },
  { out: 'bomb_defused', src: 'confirmation_004.ogg' },
  { out: 'bomb_beep', src: 'tick_001.ogg' },

  // --- Footsteps + utility --------------------------------------------------
  { out: 'footstep1', src: 'footstep_concrete_000.ogg' },
  { out: 'footstep2', src: 'footstep_concrete_001.ogg' },
  { out: 'footstep3', src: 'footstep_concrete_002.ogg' },
  { out: 'grenade_throw', src: 'paper_02.ogg' },
  { out: 'smoke_pop', src: 'noise_01.ogg' },
  { out: 'shot_knife', src: 'paper_01.ogg', trim: 0.3 }, // placeholder swish
];

function ensureFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    console.error('ffmpeg not found. Install it first (WSL: sudo apt install ffmpeg).');
    process.exit(1);
  }
}

/** Recursively find the single file matching `basename` (case-insensitive). */
function findFile(dir, basename) {
  const hits = [];
  const want = basename.toLowerCase();
  (function walk(d) {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (name.toLowerCase() === want) hits.push(p);
    }
  })(dir);
  return hits;
}

/** Peak target after normalization, dBFS (a hair below 0 to avoid clipping). */
const TARGET_PEAK_DB = -1.0;

/**
 * The processing chain (everything except loudness): strip leading silence,
 * optional pitch shift, trim to one shot, and — only where we hard-cut — a
 * 30 ms fade-out so the cut doesn't click. Long clips that end naturally get
 * no fade, so their tail isn't truncated.
 */
function processChain(entry) {
  const parts = [];
  // Jump to the first sound (drop leading silence) for the gun recordings.
  if (entry.strip) {
    parts.push('silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02');
  }
  // Pitch shift (deeper bomb). asetrate changes pitch+speed; atempo undoes the
  // speed so only pitch drops. semitones<0 => factor<1 => lower.
  if (entry.semitones) {
    const factor = Math.pow(2, entry.semitones / 12);
    parts.push(`asetrate=${SAMPLE_RATE}*${factor.toFixed(6)}`);
    parts.push(`aresample=${SAMPLE_RATE}`);
    parts.push(`atempo=${(1 / factor).toFixed(6)}`);
  }
  // Keep just one shot / clip.
  if (entry.trim) {
    parts.push(`atrim=0:${entry.trim}`);
    parts.push(`afade=t=out:st=${Math.max(0, entry.trim - 0.03).toFixed(3)}:d=0.03`);
  }
  return parts;
}

/**
 * Measure the post-processing peak so we can normalize to TARGET_PEAK_DB.
 * Runs the processing chain into volumedetect and parses max_volume. Returns
 * the gain in dB to apply (0 if it can't be measured).
 */
function measureGainDb(src, chain) {
  const af = [...chain, 'volumedetect'].join(',') || 'volumedetect';
  // volumedetect prints its stats to stderr (even on a clean exit), so capture
  // it via spawnSync rather than execFileSync (which only returns stdout).
  const res = spawnSync('ffmpeg', ['-i', src, '-af', af, '-f', 'null', '-'], {
    encoding: 'utf8',
  });
  const m = (res.stderr || '').match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
  if (!m) return 0;
  return TARGET_PEAK_DB - parseFloat(m[1]);
}

function main() {
  ensureFfmpeg();
  if (!existsSync(SOURCE_DIR)) {
    console.error(`Source dir not found: ${SOURCE_DIR}\nPass it as an argument: node tools/import-audio.mjs <dir>`);
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  let ok = 0;
  const missing = [];
  for (const entry of MAP) {
    const hits = findFile(SOURCE_DIR, entry.src);
    if (hits.length === 0) {
      missing.push(entry.src);
      console.warn(`SKIP  ${entry.out}.wav — source "${entry.src}" not found`);
      continue;
    }
    if (hits.length > 1) {
      console.warn(`WARN  "${entry.src}" matched ${hits.length} files; using the first:\n      ${hits[0]}`);
    }
    const outPath = join(OUT_DIR, `${entry.out}.wav`);
    const chain = processChain(entry);
    const gainDb = measureGainDb(hits[0], chain);
    const af = [...chain, `volume=${gainDb.toFixed(2)}dB`].join(',');
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-i', hits[0],
        '-af', af,
        '-ac', '1',
        '-ar', String(SAMPLE_RATE),
        '-sample_fmt', 's16',
        outPath,
      ],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
    ok++;
    console.log(`OK    ${entry.out}.wav  ←  ${entry.src}  (${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(1)} dB)`);
  }

  console.log(`\nDone: ${ok}/${MAP.length} imported into public/assets/audio/`);
  if (missing.length) {
    console.log(`Missing sources (${missing.length}): ${missing.join(', ')}`);
    console.log('Check the pack folders are extracted under the source dir, then re-run.');
  }
}

main();
