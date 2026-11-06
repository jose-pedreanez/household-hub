// Generates the PWA icons (PNG) without image dependencies: a green tile with a white basket.
// Usage: node scripts/make-icons.mjs   (writes public/icons/*.png)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const out = path.resolve(import.meta.dirname, "../public/icons");
fs.mkdirSync(out, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel((x + 0.5) / size, (y + 0.5) / size);
      const i = y * (size * 4 + 1) + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const GREEN = [47, 111, 79, 255];
const WHITE = [255, 255, 255, 255];
const CLEAR = [0, 0, 0, 0];

function roundedRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

/** Basket glyph in unit coordinates, scaled by `s` around the centre. */
function basket(x, y, s) {
  const u = (x - 0.5) / s + 0.5;
  const v = (y - 0.5) / s + 0.5;
  // handle: ring segment above the basket
  const d = Math.hypot(u - 0.5, v - 0.47);
  if (v < 0.47 && d > 0.19 && d < 0.25) return true;
  // body: trapezoid
  if (v >= 0.45 && v <= 0.78) {
    const t = (v - 0.45) / 0.33;
    const half = 0.33 - 0.07 * t;
    if (Math.abs(u - 0.5) <= half) {
      // vertical slats cut out of the body
      const slat = Math.abs(((u - 0.5) / 0.11) % 1);
      const inner = v > 0.52 && v < 0.72 && Math.abs(u - 0.5) < half - 0.05;
      return !(inner && slat > 0.42 && slat < 0.58);
    }
  }
  return false;
}

const variants = [
  { file: "icon-192.png", size: 192, maskable: false },
  { file: "icon-512.png", size: 512, maskable: false },
  { file: "apple-touch-icon.png", size: 180, maskable: true },
  { file: "icon-maskable-512.png", size: 512, maskable: true },
];
for (const v of variants) {
  const buf = png(v.size, (x, y) => {
    const inTile = v.maskable || roundedRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.22);
    if (!inTile) return CLEAR;
    return basket(x, y, v.maskable ? 0.72 : 0.86) ? WHITE : GREEN;
  });
  fs.writeFileSync(path.join(out, v.file), buf);
}
console.log(`icons written to ${out}`);
