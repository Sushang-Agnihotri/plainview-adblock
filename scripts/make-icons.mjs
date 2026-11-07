// Generate the extension icons (a shield with a check mark) as PNG files.
// No image libraries needed: shapes are rasterised with 4x4 supersampling.
// Usage: node scripts/make-icons.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'src', 'icons');

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shield outline in a unit square: flat-ish top, curved sides meeting at a point.
function inShield(x, y) {
  const top = 0.08; const bottom = 0.94; const halfW = 0.40;
  if (y < top || y > bottom) return false;
  const t = (y - top) / (bottom - top);
  // width stays full for the upper half, then narrows smoothly to the tip
  const w = t < 0.45 ? halfW : halfW * Math.cos(((t - 0.45) / 0.55) * (Math.PI / 2));
  // subtle notch at the top centre
  const notch = 0.04 * Math.max(0, 1 - Math.abs(x - 0.5) / halfW);
  if (y < top + notch) return false;
  return Math.abs(x - 0.5) <= w;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax; const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function inCheck(x, y, thick) {
  return distToSegment(x, y, 0.32, 0.50, 0.45, 0.63) < thick || distToSegment(x, y, 0.45, 0.63, 0.70, 0.36) < thick;
}

function render(size, color) {
  const buf = Buffer.alloc(size * size * 4);
  const S = 4;
  const thick = size <= 16 ? 0.075 : 0.06;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let shield = 0; let check = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (px + (sx + 0.5) / S) / size;
          const y = (py + (sy + 0.5) / S) / size;
          if (inShield(x, y)) {
            if (inCheck(x, y, thick)) check++; else shield++;
          }
        }
      }
      const n = S * S;
      const a = (shield + check) / n;
      if (!a) continue;
      // blend: shield colour with white check mark
      const cw = check / (shield + check);
      const i = (py * size + px) * 4;
      buf[i] = Math.round(color[0] * (1 - cw) + 255 * cw);
      buf[i + 1] = Math.round(color[1] * (1 - cw) + 255 * cw);
      buf[i + 2] = Math.round(color[2] * (1 - cw) + 255 * cw);
      buf[i + 3] = Math.round(a * 255);
    }
  }
  return png(size, buf);
}

await mkdir(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await writeFile(path.join(outDir, `icon-${size}.png`), render(size, [47, 111, 219]));
  if (size <= 32) await writeFile(path.join(outDir, `off-${size}.png`), render(size, [138, 147, 163]));
}
console.log(`Icons written to ${path.relative(root, outDir)}`);
