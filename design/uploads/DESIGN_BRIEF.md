# Breachpoint — Visual Design Brief

A brief for designing the look of **Breachpoint**, a top-down 2D tactical shooter
in the spirit of Counter-Strike. This document explains what the game is, what
is already built, every visual surface that needs design attention, and the
constraints your deliverables must fit. The output of this brief feeds directly
into our "content & polish" phase (Phase 8), where we apply the design system.

---

## 1. The game in one paragraph

Breachpoint is a round-based bomb-defuse shooter viewed from directly above.
Terrorists (T) carry a bomb to one of two sites and plant it; Counter-Terrorists
(CT) defend and defuse. You see only what your character sees — a ~110° vision
cone plus a small awareness circle, with everything else hidden under fog of
war. Rounds are short and lethal (no mid-round respawns, spectate your
teammates when dead), money from kills and round results buys better weapons
between rounds, first team to 13 rounds wins. Today it's single-player versus
bots; online multiplayer is planned, so nothing about the design should assume
single-player-only UI.

**Tone:** tense, precise, readable. Closer to a competitive tool than an
arcade toy. The pleasure comes from information — who saw whom first — so
*readability is the top design value*, juice second, decoration a distant third.

## 2. Hard constraints (cannot change)

- **Flat geometric / vector art style.** This is a locked design decision:
  circle players with a weapon rectangle + direction notch, clean-lined walls,
  solid-color floors. No pixel art, no sprite animation frames, no skeuomorphic
  textures. Visual richness comes from motion (tracers, shake, particles,
  decals) and color, not detail.
- **Everything is drawn in code** (Phaser shapes, graphics calls, tinted
  rects). A palette change is a hex-constant change. Deliverables should
  therefore be **specs and tokens, not image assets** — though reference
  mockups (images) of screens are extremely welcome.
- **Canvas is 1280×720**, scaled to fit the window (letterboxed). UI must work
  at that logical resolution; text is currently monospace at 14–34px.
- **Players are 12px-radius circles** on 32px map tiles. Team identity, facing,
  health, and "carrying the bomb" must all read at that size, over both lit
  floor and near-black fog.
- **Fog of war darkens everything outside vision** to ~14% brightness
  (a `#04060a` overlay at 0.86 alpha). Every world color must survive two
  states: fully lit and barely visible at the fog edge.
- A web-loadable font (Google Fonts or similar) is fine to propose; numbers
  benefit from tabular figures (timers, money, ammo).

## 3. What exists today (all placeholder)

### World palette

| Element | Current value | Notes |
|---|---|---|
| Page/void background | `#1a1d21` | outside the map |
| Floor tiles | `#22262c` | |
| Bombsite floor | `#2e2a22` | warm tint zone + giant 15%-alpha "A"/"B" letters |
| Walls | `#4a5460`, edge `#39424c` | crates/pillars use the same wall color |
| Fog | `#04060a` @ 0.86 | covers everything unseen |

### Players

| Element | Current value |
|---|---|
| You (T) | `#4da6ff` circle, white notch |
| T teammates | `#3d8fd9`, `#62b8e8` |
| CT enemies | `#d9534f`, `#d97b3c`, `#c94f70` |
| HP bar above head | green `#66cc66` → amber `#d9b24a` → red `#d9534f` |
| Bomb-carrier tag | 6px orange `#ff9500` square beside the HP bar |
| Damage flash | body flashes white |

Note the current mapping is "blue = my team, warm = enemy" rather than CS's
"T = orange, CT = blue" faction identity. Open question for you: keep
relative (ally/enemy) coloring, switch to fixed faction colors, or blend
(faction hue, ally/enemy brightness)?

### Effects & world objects

- Tracers + muzzle flash: pale yellow `#ffe9a0`
- Hit flash / death ring: red `#ff5544`; blood decals `#7a1c1c`
- Bullet holes: dark `#14171c`; shell casings brass `#d9b24a`
- Bomb (dropped / planted): orange `#ff9500`, planted pulses with a red ring;
  beeps accelerate as the timer runs down
- Camera: recoil nudge + shake on fire/damage

### HUD & screens (all monospace text on `#c8d2dc`, mostly unstyled)

| Surface | Contents today |
|---|---|
| Top center | round clock (turns red bomb countdown after plant), `T 2 : 3 CT round 5`, alive counts |
| Bottom left | `HP 100  $3400` |
| Bottom right | weapon + ammo `RIFLE 17/90` (red when empty) |
| Bottom center | `CARRYING THE BOMB — hold E in a site to plant` / `BOMB PLANTED` |
| Center banners | `ROUND 3`, `BUY TIME`, `BOMB PLANTED`, `T WIN THE ROUND — bomb detonated`, match end |
| Progress bar | orange plant/defuse bar with label, mid-screen |
| Kill feed | top right, `Killer ✕ Victim`, colored by killer team, fades out |
| Buy menu | plain text list, left side, during buy phase: `[1] SMG $1200 …` |
| Scoreboard (hold Tab) | dark panel, both teams, K/D/money, `†` for dead |
| Damage direction | red arc segment around screen center pointing at the shooter |
| Spectating | `SPECTATING T-Bot 2` |

### Not built yet (Phase 8+, design now so we build it styled)

- Main menu / mode select, settings (volume, sensitivity, keybinds), pause
- Minimap (scaled-down walls + teammate dots)
- Armor indicator next to HP; grenade slots in the HUD
- Post-match summary screen

## 4. What we need from you

1. **A palette as named tokens** — hex values mapped to the roles in the
   tables above (floor, wall, fog, each team, HUD text hierarchy, money,
   warning/danger, bomb/objective orange, success). Must hold up under the
   fog multiplier and for common color-vision deficiencies (T-vs-CT must
   never rely on red-vs-green alone).
2. **Faction & identity decision** — the ally/enemy vs faction-color question
   above, including "which circle is me" (outline? brighter? marker?).
3. **Typography** — one or two web fonts + sizes/weights for: timers, money,
   ammo, banners, feed, scoreboard. Tabular numerals where numbers tick.
4. **HUD layout mockups** (1280×720) for: in-round, buy phase, bomb planted,
   dead/spectating, scoreboard overlay, round-end banner, match end. Keep the
   center of the screen sacred — that's where aiming happens.
5. **Component specs** — banner treatment (we currently just print big text),
   progress bar, kill feed rows, buy menu (single screen, number-key driven —
   it can become a proper grid/panel), scoreboard table.
6. **World styling pass** — wall/floor/site treatment suggestions within the
   flat-vector constraint (e.g. wall top-edge highlight, site striping,
   spawn-zone markings), and effect color tuning (tracer, blood, explosion).
7. **A small do/don't sheet** so future additions (grenades, armor, minimap,
   second map) stay on-system.

**Format:** an MD/text spec with hex tokens we can paste into config, plus
mockup images for the HUD layouts. Anything interactive is unnecessary.

## 5. Context for judgment calls

- Matches are 20–40 minutes of repeated 1–2 minute rounds; the HUD is stared
  at for hours — calm > flashy, and nothing should pulse or animate unless it
  encodes urgency (bomb timer is the canonical exception).
- Information hierarchy in a firefight: (1) enemy positions/facing, (2) my
  hp/ammo, (3) bomb state, (4) everything else.
- The fog is the signature look. Design *with* the darkness — the lit cone is
  effectively a spotlight on a stage; the palette should make that dramatic
  rather than muddy.
- Sound placeholders are synthesized; real SFX come later (Kenney CC0) — if
  audio character affects your visual tone choices, assume "clean, dry,
  tactical", not sci-fi.
