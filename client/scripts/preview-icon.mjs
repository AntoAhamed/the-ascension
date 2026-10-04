/**
 * Prints the flame as ASCII so its silhouette can be verified without a viewer.
 * Coverage maps to block characters, so a malformed outline is obvious.
 *
 *   node client/scripts/preview-icon.mjs [cols]
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const COLS = Number(process.argv[2] ?? 44);

const png = readFileSync(resolve(HERE, '..', 'public', 'icon-preview-512.png'));

// --- minimal PNG decode of our own output (RGBA8, filter 0) ---
let off = 8;
let width = 0;
const idat = [];
while (off < png.length) {
  const len = png.readUInt32BE(off);
  const type = png.toString('ascii', off + 4, off + 8);
  const data = png.subarray(off + 8, off + 8 + len);
  if (type === 'IHDR') width = data.readUInt32BE(0);
  if (type === 'IDAT') idat.push(data);
  off += 12 + len;
}
const raw = inflateSync(Buffer.concat(idat));
const px = Buffer.alloc(width * width * 4);
for (let y = 0; y < width; y++) {
  raw.copy(px, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1));
}

const RAMP = ' .:-=+*#%@';

console.log(`  ${width}x${width} source -> ${COLS} cols. Luma ramp, '.' = transparent\n`);
const step = width / COLS;
for (let y = 0; y < COLS; y++) {
  let row = '';
  for (let x = 0; x < COLS; x++) {
    const sx = Math.floor(x * step);
    const sy = Math.floor(y * step);
    const o = (sy * width + sx) * 4;
    const a = px[o + 3] / 255;
    // Weighted luma so cyan (perceptually bright) reads brighter than violet.
    const luma = (0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]) / 255;
    const v = luma * a;
    row += RAMP[Math.max(0, Math.min(9, Math.round(v * 9)))];
  }
  console.log('  ' + row);
}

// --- quantitative checks -------------------------------------------------
let transparentOutside = 0;
for (let y = 0; y < width; y++) {
  for (let x = 0; x < width; x++) {
    const o = (y * width + x) * 4;
    const corner = x < 8 || y < 8 || x > width - 9 || y > width - 9;
    if (corner && px[o + 3] < 8) transparentOutside++;
  }
}
console.log(`\n  corner pixels fully transparent : ${transparentOutside} / 512 (expect >0, rounded corners)`);

// Vertical extent of opaque flame pixels, to confirm it is not clipped.
let minY = Infinity;
let maxY = -Infinity;
let minX = Infinity;
let maxX = -Infinity;
for (let y = 0; y < width; y++) {
  for (let x = 0; x < width; x++) {
    const o = (y * width + x) * 4;
    const luma = (0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]) / 255;
    if (px[o + 3] > 40 && luma > 0.5) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
}
console.log(`  bright flame bbox               : x ${minX}..${maxX}  y ${minY}..${maxY}`);
console.log(`  touches canvas edge (clipping?) : ${
  minX <= 1 || minY <= 1 || maxX >= width - 2 || maxY >= width - 2 ? 'YES - BUG' : 'no'
}`);