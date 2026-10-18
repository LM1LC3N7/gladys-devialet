// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a dark gradient, a white
// rounded speaker seen from the side with its round driver, and sound waves.
// Plain Node (zlib), no dependency. Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const DARK = [14, 14, 18];
const GREY = [52, 52, 64];
const WHITE = [244, 244, 246];
const SHADE = [196, 198, 206];
const DRIVER = [150, 152, 162];
const ACCENT = [212, 175, 96];

const CX = 360;
const CY = 262;

/** The colour of one pixel. */
function pixel(x, y) {
  let color = mix(DARK, GREY, (x / WIDTH) * 0.6 + (y / HEIGHT) * 0.4);
  // Soft shadow under the speaker.
  const shadow = Math.hypot((x - CX) / 170, (y - 470) / 16);
  color = mix(color, [0, 0, 0], (1 - shadow) * 0.6);
  // The body: an egg, wider at the back.
  const ex = (x - CX) / (x < CX ? 190 : 175);
  const ey = (y - CY) / 160;
  const body = (Math.hypot(ex, ey) - 1) * 160;
  const shading = 0.15 + 0.5 * ((y - CY + 160) / 320);
  color = mix(color, mix(WHITE, SHADE, shading), smooth(0, body));
  // The side driver: rings of grey, a dark centre, a gold dust cap.
  const d = Math.hypot(x - CX, y - CY);
  color = mix(color, SHADE, smooth(0, d - 112));
  color = mix(color, DRIVER, smooth(0, d - 100));
  color = mix(color, mix(DRIVER, DARK, 0.4), smooth(0, d - 70) * (1 - smooth(0, d - 64)) * 0.6);
  color = mix(color, ACCENT, smooth(0, d - 30));
  // Sound waves to the right.
  const wd = Math.hypot(x - CX, y - CY);
  const angle = Math.abs(Math.atan2(y - CY, x - CX));
  if (x > CX && angle < 0.55) {
    for (const r of [250, 300, 350]) {
      color = mix(color, ACCENT, smooth(5, Math.abs(wd - r)) * (1 - angle / 0.55) * 0.9);
    }
  }
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
