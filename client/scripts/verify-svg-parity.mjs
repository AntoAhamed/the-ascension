/**
 * Checks the generated favicon.svg against the rasterised PNGs.
 *
 * The SVG is the file most browsers actually load, but nothing here can render
 * SVG, so it would otherwise ship unverified. This re-implements the two
 * renderers' geometry independently and asserts they agree: the bezier control
 * points in the SVG's path data must trace the same outline the PNG raster
 * scanned, and the whole mark must sit inside the 512 viewBox.
 *
 *   node client/scripts/verify-svg-parity.mjs
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUB = resolve(HERE, '..', 'public');
const svg = readFileSync(resolve(PUB, 'favicon.svg'), 'utf8');

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

// --- parse the path data back out of the SVG -------------------------------
const paths = [...svg.matchAll(/<path[^>]*d="([^"]+)"/g)].map((m) => m[1]);
check('two <path> elements emitted', paths.length === 2, `found ${paths.length}`);

/**
 * Parse "M x y C x y x y x y ..." into cubic segments.
 *
 * The coordinate count is asserted rather than inferred. A leftover 6 numbers
 * used to be read as one extra segment, which silently invented a curve out of
 * the last segment's control points and reported a bounding box reaching a
 * control point that no real curve passes through.
 */
function parsePath(d) {
  const nums = d.match(/-?\d*\.?\d+/g).map(Number);
  if (nums.length < 8 || (nums.length - 2) % 6 !== 0) {
    throw new Error(`malformed path: ${nums.length} coordinates, expected 2 + 6n`);
  }
  const segs = [];
  let cur = [nums[0], nums[1]];
  for (let i = 2; i + 5 < nums.length; i += 6) {
    segs.push([cur, [nums[i], nums[i + 1]], [nums[i + 2], nums[i + 3]], [nums[i + 4], nums[i + 5]]]);
    cur = [nums[i + 4], nums[i + 5]];
  }
  return segs;
}

const bezierAt = (seg, t) => {
  const [p0, p1, p2, p3] = seg;
  const u = 1 - t;
  return [
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
  ];
};

const flameSegs = parsePath(paths[0]);

// --- 1. all geometry inside the viewBox ------------------------------------
let outOfBounds = null;
for (const seg of flameSegs) {
  for (let t = 0; t <= 1; t += 0.01) {
    const [x, y] = bezierAt(seg, t);
    if (x < 0 || y < 0 || x > 512 || y > 512) {
      outOfBounds = `(${x.toFixed(1)}, ${y.toFixed(1)})`;
      break;
    }
  }
  if (outOfBounds) break;
}
check('flame path stays within the 512 viewBox', !outOfBounds, `escapes at ${outOfBounds}`);

// --- 2. the flame fills a sensible share of the canvas ---------------------
// 200 samples per segment. A bezier rarely reaches its extreme at an anchor
// point, so a coarse sample under-reports the true extent; 200 samples puts the
// error well under a pixel at this canvas size.
const pts = flameSegs.flatMap((s) =>
  Array.from({ length: 201 }, (_, i) => bezierAt(s, i / 200))
);
const xs = pts.map((p) => p[0]);
const ys = pts.map((p) => p[1]);
const bbox = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
console.log(`\n  SVG flame bbox: x ${bbox.x.toFixed(1)}..${(bbox.x + bbox.w).toFixed(1)}  y ${bbox.y.toFixed(1)}..${(bbox.y + bbox.h).toFixed(1)}`);
check('flame occupies 45-75% of canvas width', bbox.w / 512 > 0.45 && bbox.w / 512 < 0.75, `${(bbox.w / 512 * 100).toFixed(0)}%`);
check('flame occupies 55-85% of canvas height', bbox.h / 512 > 0.55 && bbox.h / 512 < 0.85, `${(bbox.h / 512 * 100).toFixed(0)}%`);

// --- 3. the PNG raster traces the same outline -----------------------------
function readPNG(file) {
  const png = readFileSync(resolve(PUB, file));
  let off = 8;
  let w = 0;
  const idat = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') w = data.readUInt32BE(0);
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const px = Buffer.alloc(w * stride);
  for (let y = 0; y < w; y++) raw.copy(px, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  return { w, px };
}

const { w: W, px } = readPNG('icon-preview-512.png');
const satAt = (o) => {
  const mx = Math.max(px[o], px[o + 1], px[o + 2]);
  const mn = Math.min(px[o], px[o + 1], px[o + 2]);
  return mx === 0 ? 0 : (mx - mn) / mx;
};
const lumaAt = (o) => 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2];
const isFlame = (x, y) => {
  const o = (y * W + x) * 4;
  return px[o + 3] > 200 && satAt(o) > 0.25 && lumaAt(o) > 60;
};

let pMinX = Infinity, pMaxX = -Infinity, pMinY = Infinity, pMaxY = -Infinity;
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    if (!isFlame(x, y)) continue;
    if (x < pMinX) pMinX = x;
    if (x > pMaxX) pMaxX = x;
    if (y < pMinY) pMinY = y;
    if (y > pMaxY) pMaxY = y;
  }
}
const pngBox = { x: pMinX, y: pMinY, w: pMaxX - pMinX, h: pMaxY - pMinY };
console.log(`  PNG  flame bbox: x ${pngBox.x}..${pngBox.x + pngBox.w}  y ${pngBox.y}..${pngBox.y + pngBox.h}\n`);

// The two rasterisers legitimately disagree by a few px. The PNG bbox is
// measured from pixels that clear the saturation and luma thresholds, and every
// flame edge is an antialiased blend that fails those tests, so the detected
// extent is systematically inset. Worse, the PNG's 4x4 supersampling quantises
// coverage to 0%, 6%, 19%, 44%... so the outermost *detected* pixel sits inside
// the true outline by up to half a sample cell. A 12px tolerance at 512 covers
// that without being so loose that a genuine geometry change would slip past
// (a shifted control point moves an edge by tens of px).
const perEdge = {
  left: Math.abs(bbox.x - pngBox.x),
  right: Math.abs(bbox.x + bbox.w - (pngBox.x + pngBox.w)),
  top: Math.abs(bbox.y - pngBox.y),
  bottom: Math.abs(bbox.y + bbox.h - (pngBox.y + pngBox.h)),
};
for (const [edge, d] of Object.entries(perEdge)) {
  check(`${edge} edge within 12px`, d <= 12, `${d.toFixed(1)}px`);
}

// --- 4. gradient direction is gold at the tip, violet at the base ------------
const grad = svg.match(/<linearGradient id="flame"[^>]*>([\s\S]*?)<\/linearGradient>/)[1];
const stops = [...grad.matchAll(/stop-color="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
check('flame gradient has 4 stops', stops.length === 4, `found ${stops.length}`);
check('gradient base is violet (#a78bfa)', stops[0] === '#a78bfa', stops[0]);
check('gradient tip is gold (#ffd166)', stops[3] === '#ffd166', stops[3]);
check('gradient runs y1=1 (base) to y2=0 (tip)', /id="flame" x1="0.5" y1="1" x2="0.5" y2="0"/.test(svg));

// --- 5. badge is present and rounded ---------------------------------------
check('rounded badge rect present', /<rect width="512" height="512" rx="112"/.test(svg));
check('viewBox is 0 0 512 512', /viewBox="0 0 512 512"/.test(svg));

// --- 6. the pinned-tab mask is a bare silhouette ----------------------------
// Chromium recolours a mask-icon using its alpha channel alone, so a mask that
// carried the dark badge would render as a solid block with the flame lost
// inside it. Assert the background is absent rather than trusting the comment.
const maskSvg = readFileSync(resolve(PUB, 'favicon-mask.svg'), 'utf8');
check('mask icon has no badge rect', !/<rect/.test(maskSvg), 'mask icon includes a rect');
check('mask icon has no gradient', !/Gradient/.test(maskSvg), 'mask icon includes a gradient');
check('mask icon has no opacity', !/opacity/.test(maskSvg), 'mask icon includes opacity');
const maskSegs = parsePath([...maskSvg.matchAll(/<path[^>]*d="([^"]+)"/g)][0][1]);
const maskPts = maskSegs.flatMap((s) => Array.from({ length: 201 }, (_, i) => bezierAt(s, i / 200)));
const maskMinX = Math.min(...maskPts.map((p) => p[0]));
const maskMaxX = Math.max(...maskPts.map((p) => p[0]));
check(
  'mask flame matches the favicon flame horizontally',
  Math.abs(maskMinX - bbox.x) <= 1 && Math.abs(maskMaxX - (bbox.x + bbox.w)) <= 1,
  `mask x ${maskMinX.toFixed(1)}..${maskMaxX.toFixed(1)} vs favicon ${bbox.x.toFixed(1)}..${(bbox.x + bbox.w).toFixed(1)}`
);

// --- 7. every icon file referenced by index.html actually exists ------------
const html = readFileSync(resolve(HERE, '..', 'index.html'), 'utf8');
const referenced = [...html.matchAll(/(?:href|src)="\/([^"]+\.(?:svg|png|ico|webmanifest))"/g)].map(
  (m) => m[1]
);
check('index.html references at least 5 icon files', referenced.length >= 5, `found ${referenced.length}`);
for (const file of referenced) {
  let ok = true;
  try {
    readFileSync(resolve(PUB, file));
  } catch {
    ok = false;
  }
  check(`public/${file} exists`, ok, 'referenced by index.html but not generated');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);