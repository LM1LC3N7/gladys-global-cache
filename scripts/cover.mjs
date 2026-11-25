// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a dark-to-plum gradient, a
// small network gateway box (status LEDs, three IR outputs) sending infrared
// waves to a TV, and a relay contact below it. Plain Node (zlib), no
// dependency (from gladys-2n-intercom).
// Run: npm run cover
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

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const DARK = [14, 18, 36];
const PLUM = [92, 52, 120];
const WHITE = [255, 255, 255];
const RED = [255, 80, 80];
const GREEN = [90, 220, 140];
const GREY = [52, 60, 80];

/** Distance to the border of a rounded rectangle (negative inside). */
function roundedBox(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Distance to a segment. */
function segment(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

function pixel(x, y) {
  let color = mix(DARK, PLUM, (x / WIDTH) * 0.6 + (y / HEIGHT) * 0.4);
  // The gateway: a flat box, three LEDs, three jacks.
  color = mix(color, WHITE, smooth(1, roundedBox(x, y, 230, 230, 130, 46, 14)) * 0.95);
  for (const [i, led] of [GREEN, GREEN, RED].entries()) {
    color = mix(color, led, smooth(1, Math.hypot(x - (150 + i * 26), y - 230) - 7));
  }
  for (let i = 0; i < 3; i += 1) {
    color = mix(color, GREY, smooth(1, Math.hypot(x - (270 + i * 30), y - 230) - 9));
  }
  // Infrared waves toward the TV.
  const r = Math.hypot(x - 370, y - 230);
  if (x > 380 && Math.abs(y - 230) < (x - 370) * 0.6) {
    for (const radius of [40, 64, 88]) {
      color = mix(color, RED, smooth(3, Math.abs(r - radius)) * 0.85);
    }
  }
  // The TV: a frame and its foot.
  color = mix(color, WHITE, smooth(5, Math.abs(roundedBox(x, y, 610, 210, 120, 80, 8))));
  color = mix(color, WHITE, smooth(1, roundedBox(x, y, 610, 210, 112, 72, 4)) * 0.12);
  color = mix(color, WHITE, smooth(1, roundedBox(x, y, 610, 305, 40, 6, 3)));
  // A relay contact below the gateway: two terminals and an open blade.
  color = mix(color, WHITE, smooth(1, Math.hypot(x - 170, y - 400) - 12));
  color = mix(color, WHITE, smooth(1, Math.hypot(x - 300, y - 400) - 12));
  color = mix(color, WHITE, smooth(3, segment(x, y, 170, 400, 280, 360)));
  color = mix(color, WHITE, smooth(3, segment(x, y, 230, 278, 230, 330)) * 0.7);
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
