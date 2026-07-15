---
name: verify
description: Launch and drive the breachpoint game headlessly to verify rendering/gameplay changes with screenshots.
---

# Verifying breachpoint changes at runtime

Browser game (Phaser + Vite). Verify by driving it in headless Chrome and
reading screenshots.

## Launch

```bash
npm run dev -- --port 5199 --strictPort > /tmp/vite.log 2>&1 &
```

Ready in ~2s. Kill by PID when done (`pkill -f 5199` also catches your own
grep — check `ss -tln | grep 5199` instead).

## Drive + screenshot

No Playwright in the repo; system Chrome exists at
`/usr/bin/google-chrome-stable`. Install `playwright-core` (no browser
download) in a scratch dir and script it:

```js
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
await page.goto('http://localhost:5199/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500); // boot + font load
```

Vary `deviceScaleFactor` (1 / 1.25 / 2) to exercise the hi-DPI path
(`src/game/display.ts` — canvas backing store should be logical size × DPR,
capped at 2).

## Flows worth driving

Everything is canvas — no DOM selectors. Click/key by logical coordinates
(with viewport exactly 1280×720, page coords == game logical coords):

- Menu → game: click COMPETITIVE at `(640, 346)` (buttons at
  `h*0.48 + i*62`), wait ~3s. Warmup lasts a few seconds, then buy time.
- Scoreboard: hold `Tab`. Pause overlay: `Escape`. Buy panel shows during
  buy time automatically.
- Fog of war: visible as the dark mask + vision cone in any in-game shot.
  The awareness circle must be CENTERED ON the white-ringed player and the
  cone must point at the mouse — look closely; an offset mask still "looks
  dark everywhere" at a glance and is easy to misread as passing.
  Screen-space (`scrollFactor(0)`) objects break under camera zoom unless
  positioned via `screenX()/screenY()` (see `src/game/display.ts`), and the
  bug only shows when DPR > 1 — always include a DPR 1.25 or 2 run.
- Hook `page.on('pageerror')` and console errors — Phaser fails silently
  to a black canvas otherwise.

## Gotchas

- A single 404 in the browser console on load is pre-existing (favicon),
  not a regression.
- Online mode needs `npm run server` (port 2567) — offline flows don't.
