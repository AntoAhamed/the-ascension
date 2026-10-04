/**
 * Samples the flame's actual colours down its vertical centre and reports
 * contrast against the badge behind it.
 *
 * The ASCII preview flattens everything above mid-luma to '#', which made the
 * violet base look like a dead flat block. This checks the numbers so that
 * impression is either confirmed and fixed, or ruled out.
 *
 *   node client/scripts/probe-colors.mjs
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const png = readFileSync(resolve(HERE, '..', 'public', 'icon-preview-512.png'));

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
const stride = width * 4;
const px = Buffer.alloc(width * stride);
for (let y = 0; y < width; y++) {
  raw.copy(px, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
}

const hex = (o) =>
  '#' + [px[o], px[o + 1], px[o + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
const lumaAt = (o) => 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2];
const satAt = (o) => {
  const mx = Math.max(px[o], px[o + 1], px[o + 2]);
  const mn = Math.min(px[o], px[o + 1], px[o + 2]);
  return mx === 0 ? 0 : (mx - mn) / mx;
};

// Saturation ALONE is not a flame test. The badge is #080a16, which is very
// dark but still numerically "saturated" (max-min over max = 0.64) because the
// ratio ignores absolute magnitude. Pair it with a luma floor.

/**
 * Is this pixel part of the flame rather than the badge?
 *
 * Alpha cannot answer it: the rounded badge is opaque across nearly the whole
 * canvas, so an alpha test happily reports "interior" for plain badge. The
 * flame colours are highly saturated, the badge is near-black and desaturated,
 * so saturation separates them cleanly.
 */
const isFlame = (o) => px[o + 3] > 200 && satAt(o) > 0.25 && lumaAt(o) > 60;

console.log(`  ${width}x${width}. Centre-column sweep, only fully-opaque flame pixels.\n`);
console.log('     y    %height   colour     luma   vs badge');
console.log('   ---  --------  --------  -----  --------');

const top = 88;
const bot = 424;
const steps = 14;
for (let i = 0; i <= steps; i++) {
  const t = i / steps;
  const y = Math.round(top + t * (bot - top));
  // Widest opaque run on this row, sampled at its centre.
  let minX = Infinity;
  let maxX = -Infinity;
  for (let x = 0; x < width; x++) {
    if (isFlame((y * width + x) * 4)) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  if (minX === Infinity || maxX - minX < 20) continue; // no flame / too thin
  const o = (y * width + Math.round((minX + maxX) / 2)) * 4;
  const badge = 8 + Math.round((y / width) * 8);
  const contrast = Math.abs(lumaAt(o) - badge);
  console.log(
    `   ${String(y).padStart(3)}  ${String(Math.round(t * 100)).padStart(7)}%  ${hex(o)}  ${String(
      Math.round(lumaAt(o))
    ).padStart(5)}  ${String(Math.round(contrast)).padStart(8)}`
  );
}

// Worst-case separation between the flame and the badge behind it.
let worst = 999;
let worstY = 0;
let worstHex = '#000000';
for (let y = 0; y < width; y++) {
  for (let x = 0; x < width; x++) {
    const o = (y * width + x) * 4;
    if (!isFlame(o)) continue;
    const badge = 8 + Math.round((y / width) * 8);
    const d = Math.abs(lumaAt(o) - badge);
    if (d < worst) {
      worst = d;
      worstY = y;
      worstHex = hex(o);
    }
  }
}
console.log(`\n  dimmest flame pixel: ${worstHex} (luma ${Math.round(worst + (8 + Math.round((worstY / width) * 8)))}) at y=${worstY}`);
console.log(`\n  minimum flame/badge luma separation: ${worst} at y=${worstY}`);
console.log(`  verdict: ${worst < 10 ? 'TOO LOW - base blends into badge' : 'ok, always distinguishable'}`);