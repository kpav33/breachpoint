// Generates the placeholder sound set into public/assets/audio/ as 16-bit
// mono WAVs (jsfxr-style synthesis: noise bursts, envelopes, filters).
// Swap these files for real ones (Kenney.nl etc.) without touching code.
// Run: node tools/generate-audio.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../public/assets/audio');
mkdirSync(OUT_DIR, { recursive: true });

const RATE = 22050;

function writeWav(name, samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  writeFileSync(join(OUT_DIR, name), buf);
  console.log(`wrote ${name} (${(n / RATE).toFixed(2)}s)`);
}

const secs = (s) => Math.round(s * RATE);

/** Mulberry32 so regeneration is deterministic. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lowpass(s, alpha) {
  let y = 0;
  return s.map((x) => (y += alpha * (x - y)));
}

/** Noise burst → lowpass → exponential decay, plus optional low sine thump. */
function gunshot({ dur, lpAlpha, decay, thumpHz = 0, thumpAmt = 0, seed = 1 }) {
  const n = secs(dur);
  const rand = rng(seed);
  let s = Array.from({ length: n }, () => rand() * 2 - 1);
  s = lowpass(s, lpAlpha);
  return s.map((x, i) => {
    const t = i / RATE;
    const env = Math.exp(-decay * t);
    const thump = thumpAmt * Math.sin(2 * Math.PI * thumpHz * t) * Math.exp(-18 * t);
    return x * env * 0.9 + thump;
  });
}

writeWav('shot_pistol.wav', gunshot({ dur: 0.14, lpAlpha: 0.55, decay: 38, thumpHz: 140, thumpAmt: 0.25, seed: 11 }));
writeWav('shot_smg.wav', gunshot({ dur: 0.1, lpAlpha: 0.6, decay: 48, thumpHz: 160, thumpAmt: 0.2, seed: 22 }));
writeWav('shot_rifle.wav', gunshot({ dur: 0.2, lpAlpha: 0.45, decay: 30, thumpHz: 95, thumpAmt: 0.4, seed: 33 }));
writeWav('shot_sniper.wav', gunshot({ dur: 0.55, lpAlpha: 0.3, decay: 12, thumpHz: 60, thumpAmt: 0.6, seed: 44 }));
writeWav('shot_deagle.wav', gunshot({ dur: 0.22, lpAlpha: 0.5, decay: 26, thumpHz: 110, thumpAmt: 0.45, seed: 66 }));
writeWav('shot_shotgun.wav', gunshot({ dur: 0.3, lpAlpha: 0.35, decay: 18, thumpHz: 80, thumpAmt: 0.55, seed: 77 }));

// Knife: short airy whoosh — bandpass-ish noise under a sine-shaped envelope.
{
  const n = secs(0.13);
  const rand = rng(55);
  let s = Array.from({ length: n }, () => rand() * 2 - 1);
  s = lowpass(s, 0.35);
  const hp = s.map((x, i) => x - (i > 0 ? s[i - 1] * 0.7 : 0)); // crude highpass
  writeWav('shot_knife.wav', hp.map((x, i) => x * Math.sin((Math.PI * i) / n) * 0.5));
}

// Reload: two mechanical clicks ~130 ms apart.
{
  const n = secs(0.32);
  const rand = rng(66);
  const s = new Array(n).fill(0);
  for (const at of [0, 0.13]) {
    const start = secs(at);
    for (let i = 0; i < secs(0.03); i++) {
      const t = i / RATE;
      s[start + i] +=
        (rand() * 2 - 1) * Math.exp(-140 * t) * 0.7 +
        Math.sin(2 * Math.PI * 1100 * t) * Math.exp(-160 * t) * 0.4;
    }
  }
  writeWav('reload.wav', s);
}

// Footsteps: low damped thump, three variants.
for (const [i, seed] of [77, 88, 99].entries()) {
  const n = secs(0.09);
  const rand = rng(seed);
  let s = Array.from({ length: n }, () => rand() * 2 - 1);
  s = lowpass(s, 0.12 + 0.03 * i);
  writeWav(`footstep${i + 1}.wav`, s.map((x, j) => x * Math.exp(-55 * (j / RATE)) * 0.8));
}

// Hit confirm: short bright ping (UI sound).
{
  const n = secs(0.09);
  writeWav(
    'hit.wav',
    Array.from({ length: n }, (_, i) => {
      const t = i / RATE;
      const f = 1300 - 400 * (i / n);
      return Math.sin(2 * Math.PI * f * t) * Math.exp(-45 * t) * 0.5;
    }),
  );
}

// Hurt: low thud + noise grit.
{
  const n = secs(0.14);
  const rand = rng(111);
  let noise = Array.from({ length: n }, () => rand() * 2 - 1);
  noise = lowpass(noise, 0.2);
  writeWav(
    'hurt.wav',
    noise.map((x, i) => {
      const t = i / RATE;
      return (x * 0.5 + Math.sin(2 * Math.PI * 180 * t) * 0.6) * Math.exp(-30 * t);
    }),
  );
}

// Death: descending tone + noise tail.
{
  const n = secs(0.4);
  const rand = rng(222);
  let noise = Array.from({ length: n }, () => rand() * 2 - 1);
  noise = lowpass(noise, 0.25);
  writeWav(
    'death.wav',
    noise.map((x, i) => {
      const t = i / RATE;
      const f = 380 - 260 * (i / n);
      return (Math.sin(2 * Math.PI * f * t) * 0.55 + x * 0.3) * Math.exp(-9 * t);
    }),
  );
}

// --- Bomb set (Phase 7) ----------------------------------------------------

// Plant confirm: two quick ascending chirps.
{
  const n = secs(0.3);
  writeWav(
    'bomb_plant.wav',
    Array.from({ length: n }, (_, i) => {
      const t = i / RATE;
      const seg = t < 0.15 ? 0 : 1;
      const lt = t - seg * 0.15;
      const f = (seg === 0 ? 620 : 830) + 400 * lt;
      return Math.sin(2 * Math.PI * f * lt) * Math.exp(-28 * lt) * 0.5;
    }),
  );
}

// Countdown beep: short square-ish blip.
{
  const n = secs(0.08);
  writeWav(
    'bomb_beep.wav',
    Array.from({ length: n }, (_, i) => {
      const t = i / RATE;
      return Math.sign(Math.sin(2 * Math.PI * 880 * t)) * Math.exp(-40 * t) * 0.3;
    }),
  );
}

// Defused: gentle descending "all clear" two-tone.
{
  const n = secs(0.5);
  writeWav(
    'bomb_defused.wav',
    Array.from({ length: n }, (_, i) => {
      const t = i / RATE;
      const seg = t < 0.22 ? 0 : 1;
      const lt = t - seg * 0.22;
      const f = seg === 0 ? 740 : 520;
      return Math.sin(2 * Math.PI * f * lt) * Math.exp(-14 * lt) * 0.45;
    }),
  );
}

// Explosion: heavy lowpassed noise + sub sine, long tail.
{
  const n = secs(1.3);
  const rand = rng(333);
  let noise = Array.from({ length: n }, () => rand() * 2 - 1);
  noise = lowpass(noise, 0.12);
  writeWav(
    'bomb_explode.wav',
    noise.map((x, i) => {
      const t = i / RATE;
      const sub = Math.sin(2 * Math.PI * (55 - 20 * Math.min(t, 1)) * t) * Math.exp(-4 * t) * 0.8;
      return x * Math.exp(-5 * t) * 0.9 + sub;
    }),
  );
}

// --- Grenade set (Phase 8) -------------------------------------------------

// Throw: short soft whoosh.
{
  const n = secs(0.12);
  const rand = rng(444);
  let s = Array.from({ length: n }, () => rand() * 2 - 1);
  s = lowpass(s, 0.35);
  writeWav('grenade_throw.wav', s.map((x, i) => x * Math.sin((Math.PI * i) / n) * 0.4));
}

// HE explosion: like the bomb but smaller and shorter.
{
  const n = secs(0.7);
  const rand = rng(555);
  let noise = Array.from({ length: n }, () => rand() * 2 - 1);
  noise = lowpass(noise, 0.16);
  writeWav(
    'he_explode.wav',
    noise.map((x, i) => {
      const t = i / RATE;
      const sub = Math.sin(2 * Math.PI * 70 * t) * Math.exp(-8 * t) * 0.6;
      return x * Math.exp(-8 * t) * 0.85 + sub;
    }),
  );
}

// Flashbang: sharp high crack + ringing tone tail.
{
  const n = secs(0.8);
  const rand = rng(666);
  writeWav(
    'flash_pop.wav',
    Array.from({ length: n }, (_, i) => {
      const t = i / RATE;
      const crack = (rand() * 2 - 1) * Math.exp(-60 * t) * 0.9;
      const ring = Math.sin(2 * Math.PI * 2600 * t) * Math.exp(-3.5 * t) * 0.25;
      return crack + ring;
    }),
  );
}

// Smoke pop: dull short hiss burst.
{
  const n = secs(0.5);
  const rand = rng(777);
  let s = Array.from({ length: n }, () => rand() * 2 - 1);
  s = lowpass(s, 0.3);
  writeWav('smoke_pop.wav', s.map((x, i) => x * Math.exp(-10 * (i / RATE)) * 0.5));
}
