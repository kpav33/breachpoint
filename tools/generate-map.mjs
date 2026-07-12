// Generates public/assets/maps/de_yard.json (Tiled 1.10 JSON format) and the
// tiles.png tileset it references. The map stays editable in Tiled; this
// script exists so layout tweaks are reproducible until real Tiled authoring
// takes over. Run: node tools/generate-map.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../public/assets/maps');
mkdirSync(OUT_DIR, { recursive: true });

const W = 60;
const H = 40;
const TS = 32;

// gids: 1 = floor, 2 = wall, 3 = bombsite floor
const FLOOR = 1;
const WALL = 2;
const SITE = 3;

// ---------------------------------------------------------------- layouts --
// Each layout starts fully solid, carves rooms/corridors, then drops crates
// back in, and returns bombsite rects + spawn points (tile coords).

function makeCanvas() {
  const solid = Array.from({ length: H }, () => new Array(W).fill(true));
  return {
    solid,
    carve: (x0, y0, x1, y1) => {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) solid[y][x] = false;
    },
    fill: (x0, y0, x1, y1) => {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) solid[y][x] = true;
    },
  };
}

// Dust2-ish two-site layout: A site NW, B site NE, CT spawn top-middle,
// T spawn bottom-middle, mid corridor, long lane west, tunnels east.
function layoutYard() {
  const { solid, carve, fill } = makeCanvas();
  carve(3, 3, 16, 12); //   A site room
  carve(43, 3, 56, 12); //  B site room
  carve(23, 2, 36, 7); //   CT spawn
  carve(16, 4, 23, 6); //   CT → A hall
  carve(36, 4, 43, 6); //   CT → B hall
  carve(27, 7, 32, 32); //  mid corridor
  carve(3, 13, 7, 32); //   long A lane (west)
  carve(52, 13, 56, 32); // B tunnel (east)
  carve(20, 31, 39, 37); // T spawn
  carve(3, 30, 20, 32); //  bottom connector west
  carve(39, 30, 56, 32); // bottom connector east
  carve(8, 15, 27, 17); //  short: A lane → mid
  carve(32, 19, 52, 21); // mid → B tunnel

  fill(9, 6, 10, 7); //    A site crate
  fill(13, 9, 14, 9); //   A site low wall
  fill(48, 6, 49, 7); //   B site crate
  fill(45, 10, 45, 11); // B site pillar
  fill(29, 17, 30, 18); // mid crate (short junction)
  fill(28, 33, 29, 34); // T spawn crate

  return {
    solid,
    bombsiteTiles: [
      { name: 'A', x0: 6, y0: 5, x1: 11, y1: 9 },
      { name: 'B', x0: 46, y0: 5, x1: 51, y1: 9 },
    ],
    spawnsT: [24, 27, 30, 33, 36].map((x) => ({ x, y: 35 })),
    spawnsCT: [26, 28, 30, 32, 34].map((x) => ({ x, y: 4 })),
  };
}

// Split: sites on the east/west flanks at mid-height, spawns north/south,
// three vertical lanes joined by top/bottom corridors and a mid cross.
function layoutSplit() {
  const { solid, carve, fill } = makeCanvas();
  carve(3, 14, 16, 25); //  A site room (west)
  carve(43, 14, 56, 25); // B site room (east)
  carve(22, 3, 37, 9); //   CT spawn (north)
  carve(22, 31, 37, 37); // T spawn (south)
  carve(28, 9, 31, 31); //  mid corridor (vertical)
  carve(6, 4, 53, 7); //    top corridor
  carve(6, 7, 9, 17); //    NW drop into A
  carve(50, 7, 53, 17); //  NE drop into B
  carve(6, 33, 53, 36); //  bottom corridor
  carve(6, 22, 9, 33); //   SW rise from A
  carve(50, 22, 53, 33); // SE rise from B
  carve(16, 19, 28, 20); // A → mid cross
  carve(31, 19, 43, 20); // mid → B cross

  fill(7, 18, 8, 19); //    A site crate
  fill(12, 22, 13, 23); //  A site cover
  fill(51, 18, 52, 19); //  B site crate
  fill(46, 22, 47, 23); //  B site cover
  // Mid crates hug the wall so the remaining gap stays two tiles wide.
  fill(28, 14, 29, 15); //  mid crate north (west wall)
  fill(30, 24, 31, 25); //  mid crate south (east wall)
  fill(33, 7, 34, 8); //    CT spawn crate
  fill(24, 33, 25, 34); //  T spawn crate

  return {
    solid,
    bombsiteTiles: [
      { name: 'A', x0: 5, y0: 17, x1: 10, y1: 21 },
      { name: 'B', x0: 49, y0: 17, x1: 54, y1: 21 },
    ],
    spawnsT: [24, 27, 30, 33, 36].map((x) => ({ x, y: 35 })),
    spawnsCT: [24, 27, 30, 33, 36].map((x) => ({ x, y: 5 })),
  };
}

const LAYOUTS = { de_yard: layoutYard, de_split: layoutSplit };

function writeMap(name, layout) {
  const { solid, bombsiteTiles, spawnsT, spawnsCT } = layout();

  const floorData = [];
  const wallData = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inSite = bombsiteTiles.some((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
      floorData.push(inSite && !solid[y][x] ? SITE : FLOOR);
      wallData.push(solid[y][x] ? WALL : 0);
    }
  }

  let nextObjectId = 1;
  const pointObj = (p) => ({
    id: nextObjectId++,
  name: '',
  type: '',
  x: (p.x + 0.5) * TS,
  y: (p.y + 0.5) * TS,
  width: 0,
  height: 0,
  point: true,
  rotation: 0,
  visible: true,
});
const rectObj = (b) => ({
  id: nextObjectId++,
  name: b.name,
  type: '',
  x: b.x0 * TS,
  y: b.y0 * TS,
  width: (b.x1 - b.x0 + 1) * TS,
  height: (b.y1 - b.y0 + 1) * TS,
  rotation: 0,
  visible: true,
});

const map = {
  compressionlevel: -1,
  type: 'map',
  version: '1.10',
  tiledversion: '1.10.2',
  orientation: 'orthogonal',
  renderorder: 'right-down',
  infinite: false,
  width: W,
  height: H,
  tilewidth: TS,
  tileheight: TS,
  nextlayerid: 6,
  nextobjectid: nextObjectId + 20,
  layers: [
    { id: 1, name: 'floor', type: 'tilelayer', width: W, height: H, x: 0, y: 0, opacity: 1, visible: true, data: floorData },
    { id: 2, name: 'walls', type: 'tilelayer', width: W, height: H, x: 0, y: 0, opacity: 1, visible: true, data: wallData },
    { id: 3, name: 'spawns_t', type: 'objectgroup', x: 0, y: 0, opacity: 1, visible: true, draworder: 'topdown', objects: spawnsT.map(pointObj) },
    { id: 4, name: 'spawns_ct', type: 'objectgroup', x: 0, y: 0, opacity: 1, visible: true, draworder: 'topdown', objects: spawnsCT.map(pointObj) },
    { id: 5, name: 'bombsites', type: 'objectgroup', x: 0, y: 0, opacity: 1, visible: true, draworder: 'topdown', objects: bombsiteTiles.map(rectObj) },
  ],
  tilesets: [
    {
      firstgid: 1,
      name: 'tiles',
      image: 'tiles.png',
      imagewidth: TS * 3,
      imageheight: TS,
      tilewidth: TS,
      tileheight: TS,
      tilecount: 3,
      columns: 3,
      margin: 0,
      spacing: 0,
    },
  ],
  };

  writeFileSync(join(OUT_DIR, `${name}.json`), JSON.stringify(map));
  console.log(`wrote ${name}.json (${W}x${H})`);
}

for (const [name, layout] of Object.entries(LAYOUTS)) writeMap(name, layout);

// ------------------------------------------------------------- tiles.png ---
// Minimal PNG writer (RGBA, no interlace) — three flat 32×32 tiles.
function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, pixelAt) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelAt(x, y);
      const o = row + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (h) => [(h >> 16) & 0xff, (h >> 8) & 0xff, h & 0xff];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
// Nightfall world palette — keep in sync with src/game/theme.ts (WORLD).
const COLORS = {
  floor: hex(0x1b2027),
  floorLine: hex(0x20262e),
  site: hex(0x2c2820),
  siteLine: hex(0x544824),
  wall: hex(0x3f4a56),
  wallTop: hex(0x57646f),
  wallDark: hex(0x2b333c),
};
const png = encodePng(TS * 3, TS, (x, y) => {
  const tile = Math.floor(x / TS); // 0 floor, 1 wall, 2 site
  const lx = x % TS;
  if (tile === 0) {
    // Faint 1px grid line on the north/west edges of every tile.
    return lx === 0 || y === 0 ? COLORS.floorLine : COLORS.floor;
  }
  if (tile === 2) {
    // Objective ground: warm tint + faint 45° striping.
    const stripe = (lx + y) % 12 < 2;
    return stripe ? mix(COLORS.site, COLORS.siteLine, 0.3) : COLORS.site;
  }
  // Wall block: lighter top cap fakes height + shows which side is cover;
  // dark right/bottom shadow grounds it.
  if (y < 3) return COLORS.wallTop;
  if (lx >= TS - 3 || y >= TS - 3) return COLORS.wallDark;
  return COLORS.wall;
});
writeFileSync(join(OUT_DIR, 'tiles.png'), png);

console.log(`wrote tiles.png to ${OUT_DIR}`);
