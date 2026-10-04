/**
 * Pixel-level checks on the generated icon set.
 *
 * The geometry and gradient are covered by verify-svg-parity.mjs. This covers
 * the things only the rasters can answer: that the maskable variant really does
 * keep the flame inside Android's safe zone, that the badge fills the canvas
 * where it should and rounds only where it should, and that every shipped PNG
 * is a structurally valid file of the size its filename claims.
 *
 *   node client/scripts/probe-assets.mjs
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUB = resolve(HERE, '..', 'public');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}  -> ${detail}`);
  }
};

/** Decodes one of our own PNGs (RGBA8, filter 0, non-interlaced). */
function readPNG(file) {
  const buf = readFileSync(resolve(PUB, file));
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) throw new Error(`${file}: bad PNG signature`);
  }
  let off = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let color = 0;
  let sawIEND = false;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      color = data[9];
      if (data[12] !== 0) throw new Error(`${file}: interlaced, unexpected`);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      sawIEND = true;
    }
    off += 12 + len;
  }
  if (!sawIEND) throw new Error(`${file}: missing IEND`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    raw.copy(px, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return { w, h, depth, color, px };
}

const lumaAt = (px, w, o) => 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2];
const satAt = (px, o) => {
  const mx = Math.max(px[o], px[o + 1], px[o + 2]);
  const mn = Math.min(px[o], px[o + 1], px[o + 2]);
  return mx === 0 ? 0 : (mx - mn) / mx;
};
const isFlame = (px, w, o) => px[o + 3] > 200 && satAt(px, o) > 0.25 && lumaAt(px, w, o) > 60;

function flameBBox({ w, h, px }) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isFlame(px, w, (y * w + x) * 4)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { x0, y0, x1, y1 };
}

// --- 1. every shipped PNG is valid and the size its name claims -------------
console.log('  file integrity');
const expected = {
  'favicon-16x16.png': 16,
  'favicon-32x32.png': 32,
  'favicon-64x64.png': 64,
  'apple-touch-icon.png': 180,
  'icon-192.png': 192,
  'icon-512.png': 512,
  'maskable-icon-512.png': 512,
  'icon-preview-512.png': 512,
};
const decoded = {};
for (const [name, size] of Object.entries(expected)) {
  try {
    const img = readPNG(name);
    decoded[name] = img;
    const ok = img.w === size && img.h === size && img.depth === 8 && img.color === 6;
    check(
      `${name} is ${size}x${size} RGBA8`,
      ok,
      `got ${img.w}x${img.h} depth ${img.depth} color ${img.color}`
    );
  } catch (err) {
    check(`${name} is ${size}x${size} RGBA8`, false, err.message);
  }
}

// --- 2. the maskable variant respects Android's safe zone -------------------
console.log('\n  maskable safe zone');
const mask = decoded['maskable-icon-512.png'];
if (mask) {
  const bb = flameBBox(mask);
  const insetPx = 512 * 0.27;
  const insetMeasured = Math.min(bb.x0, bb.y0, mask.w - 1 - bb.x1, mask.h - 1 - bb.y1);
  console.log(
    `  flame bbox x ${bb.x0}..${bb.x1}  y ${bb.y0}..${bb.y1}; smallest inset ${insetMeasured}px`
  );
  // Android guarantees only the middle 80% survives an aggressive mask.
  check(
    'flame clears the 80% safe zone on all four sides',
    insetMeasured >= 512 * 0.2,
    `smallest inset ${insetMeasured}px < ${Math.round(512 * 0.2)}px`
  );
  check(
    'maskable background is square, not rounded',
    mask.px[3] > 200,
    'top-left corner is transparent'
  );
  check(
    'maskable background reaches every edge',
    [0, mask.w - 1].every((x) =>
      [0, mask.h - 1].every((y) => mask.px[(y * mask.w + x) * 4 + 3] > 200)
    ),
    'a corner is transparent'
  );
}

// --- 3. the ordinary icon rounds its corners and stays clear of the edges ----
console.log('\n  ordinary badge shape');
const main = decoded['icon-preview-512.png'];
if (main) {
  const corner = main.px[3];
  const centre = main.px[((256 * main.w + 256) * 4) + 3];
  check('badge is opaque through the middle', centre > 250, `alpha ${centre}`);
  check('badge corners are transparent (rounded)', corner < 40, `alpha ${corner}`);

  const bb = flameBBox(main);
  const inset = Math.min(bb.x0, bb.y0, main.w - 1 - bb.x1, main.h - 1 - bb.y1);
  check(
    'flame clears the badge edge by at least 12% of the canvas',
    inset >= 512 * 0.12,
    `inset ${inset}px`
  );
}

// --- 4. the 16px raster still reads as a flame ------------------------------
console.log('\n  legibility at 16px');
const tiny = decoded['favicon-16x16.png'];
if (tiny) {
  let lit = 0;
  let total = 0;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const o = (y * 16 + x) * 4;
      if (tiny.px[o + 3] < 40) continue;
      total++;
      if (lumaAt(tiny.px, 16, o) > 60) lit++;
    }
  }
  const litFrac = lit / total;
  console.log(`  ${lit}/${total} opaque pixels carry the flame (${Math.round(litFrac * 100)}%)`);
  // Too few and the mark is a dark blob in the tab strip; too many and the
  // flame has swollen into the badge.
  check(
    '16px raster keeps a distinguishable flame',
    litFrac > 0.15 && litFrac < 0.75,
    `${Math.round(litFrac * 100)}% of the badge is flame`
  );
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);