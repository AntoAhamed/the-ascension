/**
 * Renders the brand mark to PNG with zero dependencies.
 *
 * Why this exists: SVG favicons are the modern answer, but two important cases
 * still need a real raster:
 *   - Safari/iOS home-screen icons ignore <link rel="icon"> entirely and read
 *     <link rel="apple-touch-icon">, which must be a PNG.
 *   - Browsers that predate SVG favicon support fall back to /favicon.ico.
 *
 * Installing sharp/resvg just to emit six static PNGs would add a native
 * dependency to a project whose whole premise is `npm install` and go. So the
 * mark is defined here as plain math and encoded straight to PNG: a cubic
 * Bezier flame, scan-converted at 4x4 supersampling for anti-aliasing, deflated
 * with the zlib that ships inside Node.
 *
 * The SVG in client/public/favicon.svg is the same geometry authored by hand,
 * so the two must stay in sync (the design is documented once, below).
 *
 *   node client/scripts/render-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', 'public');

/* ------------------------------------------------------------------ *
 * Brand palette — mirrors tailwind.config.js exactly.                  *
 * ------------------------------------------------------------------ */
const VOID_900 = [0x08, 0x0a, 0x16];
const VOID_850 = [0x0b, 0x0e, 0x1e];
const NEON_CYAN = [0x22, 0xd3, 0xee];
const NEON_VIOLET = [0xa7, 0x8b, 0xfa];
const NEON_GOLD = [0xff, 0xd1, 0x66];
const NEON_AMBER = [0xfb, 0xbf, 0x24];

const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Sampled cubic Bezier. */
function bezier(p0, p1, p2, p3, steps = 48) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pts.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return pts;
}

/**
 * The outer flame silhouette, in a normalised 0..1 box (y increasing downward).
 *
 * A rising flame rather than a trophy or shield: it ties together the three
 * things the product is about — streaks (the Grandmaster rank icon is already a
 * flame), ascending through the rank ladder, and heat while you work. It also
 * survives being shrunk to 16px, which a trophy's stem and handles emphatically
 * do not.
 *
 * The shape is deliberately asymmetric. Fire is recognised by two features and
 * a symmetrical teardrop has neither: the tip leans left, and the right flank
 * tucks inward at roughly a third height to form the notch that reads as a
 * flame licking off a body. One continuous outline, clockwise from the base.
 */
function flameOutline() {
  return FLAME_CURVES.flatMap(([a, b, c, d]) => bezier(a, b, c, d));
}

/**
 * The inner core flame — the hot centre.
 *
 * Deliberately small and confined to the base. An earlier version spanned most
 * of the flame's height, which mixed 82% toward white across the whole upper
 * body and bleached the gradient into a flat pale block. A core should read as
 * a heat source inside the shape, not repaint the shape.
 */
function coreOutline() {
  return CORE_CURVES.flatMap(([a, b, c, d]) => bezier(a, b, c, d));
}

/** Even-odd point-in-polygon. */
function inside(poly, px, py) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * The gradient, parameterised by 0 at the BASE to 1 at the TIP.
 *
 * It brightens upward — violet at the base rising through cyan to gold at the
 * tip — so the mark itself reads as "ascension", and it matches the rank
 * accents (Apprentice violet -> Practitioner cyan -> Apex gold). Gold is the
 * brightest point, so it lands on the tip where the eye goes first.
 */
function flameColor(t) {
  const stops = [
    [0.0, NEON_VIOLET],
    [0.45, NEON_CYAN],
    [0.8, NEON_AMBER],
    [1.0, NEON_GOLD],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [p0, c0] = stops[i];
    const [p1, c1] = stops[i + 1];
    if (t >= p0 && t <= p1) return mix(c0, c1, (t - p0) / (p1 - p0));
  }
  return NEON_GOLD;
}

/**
 * Coverage of the badge background at a point.
 *
 * @param {number} radius corner radius in viewBox units, scaled to `size`.
 *   Pass 0 for the square background a maskable icon needs.
 *
 * Note the explicit zero case. The corner-arc test below decides a point's
 * membership by measuring from an arc centre, and with r = 0 that centre lands
 * on the corner itself, so every interior point measures a non-zero distance
 * and fails. A square badge would come out empty rather than square.
 */
function roundRectCoverage(px, py, size, radius) {
  const r = Math.min(radius * (size / VIEWBOX), size / 2);
  // A square badge must be full bleed. Android's mask can be any shape, and
  // transparent pixels inside it show the launcher's wallpaper instead of the
  // brand, so the margin that keeps the rounded corners off the canvas edge
  // cannot apply here.
  const inset = r === 0 ? 0 : size * 0.035;
  const lo = inset;
  const hi = size - inset;
  if (px < lo || px > hi || py < lo || py > hi) return 0;

  if (r === 0) return 1;

  // Measure from the nearest corner arc's centre.
  const cx = px < lo + r ? lo + r : px > hi - r ? hi - r : px;
  const cy = py < lo + r ? lo + r : py > hi - r ? hi - r : py;
  return Math.hypot(px - cx, py - cy) <= r ? 1 : 0;
}

/**
 * Render the mark at `size` px.
 *
 * @param {number} size
 * @param {{pad?: number, radius?: number}} opts
 *   pad: inset applied to the flame as a fraction of the canvas, so the mark
 *   keeps its optical margin at every size
 *   radius: badge corner radius in viewBox units, scaled to `size`. Zero gives
 *   the square background a maskable icon needs.
 */
function render(size, { pad = PAD, radius = BADGE_RADIUS } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const SS = 4; // 4x4 supersampling
  const outer = flameOutline();
  const core = coreOutline();

  // Flame box inside the canvas, honouring the padding.
  const inset = size * pad;
  const box = size - inset * 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let badge = 0;
      let flameHits = 0;
      let coreHits = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;

          badge += roundRectCoverage(fx, fy, size, radius);

          const nx = (fx - inset) / box;
          const ny = (fy - inset) / box;
          if (inside(outer, nx, ny)) {
            flameHits++;
            if (inside(core, nx, ny)) coreHits++;
          }
        }
      }

      const total = SS * SS;
      const badgeA = badge / total;
      const flameA = flameHits / total;
      const coreA = coreHits / total;

      // Composite: badge underneath, flame over it.
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      if (badgeA > 0) {
        // Vertical background wash so the badge is not a flat block: deeper at
        // the bottom, slightly lifted at the top, echoing the app's panels.
        const wash = 1 - (y / size) * 0.55;
        r = VOID_900[0] * wash;
        g = VOID_900[1] * wash;
        b = VOID_900[2] * wash;
        a = badgeA;
      }

      if (flameA > 0) {
        // flameColor() takes 0 at the base and 1 at the tip, but canvas y
        // increases downward, so the height fraction has to be inverted or the
        // gradient runs the wrong way (gold at the root, violet at the point).
        const t = 1 - Math.min(1, Math.max(0, (y - inset) / box));
        let [fr, fg, fb] = flameColor(t);
        // Core is the hot centre. It warms toward a yellow-white rather than a
        // neutral white: mixing cyan toward pure white lands on a pale mint
        // (#e2edcd) that reads as sickly rather than hot.
        if (coreA > 0) {
          const k = coreA / flameA;
          [fr, fg, fb] = mix([fr, fg, fb], [255, 243, 208], k * 0.7);
        }
        const alpha = flameA;
        r = r * (1 - alpha) + fr * alpha;
        g = g * (1 - alpha) + fg * alpha;
        b = b * (1 - alpha) + fb * alpha;
        a = Math.max(a, alpha);
      }

      const o = (y * size + x) * 4;
      px[o] = Math.round(Math.min(255, r));
      px[o + 1] = Math.round(Math.min(255, g));
      px[o + 2] = Math.round(Math.min(255, b));
      px[o + 3] = Math.round(Math.min(255, a * 255));
    }
  }
  return px;
}

/* ------------------------------------------------------------------ *
 * SVG emission.                                                       *
 * ------------------------------------------------------------------ */

/**
 * Emits a path 'd' string using real cubic bezier commands, straight from the
 * control points the raster uses.
 *
 * This is the whole reason the SVG is generated rather than hand-written: an
 * authored approximation of the same curves drifts from the PNG the moment
 * either file is edited, and the two icons are served to different browsers.
 * Deriving both from one source makes divergence impossible.
 */
function svgPath(curves) {
  const f = (n) => Math.round(n * 100) / 100;
  // `M` moves the pen to the first anchor and takes no control points. Every
  // curve, including the opening one, then contributes a `C` carrying exactly
  // six coordinates.
  //
  // Both halves of that are load-bearing. Sending all four control points after
  // `M` makes SVG read the surplus pairs as implicit *lineto* commands, and
  // re-sending p0 after each `C` makes the renderer treat it as the head of an
  // implicitly repeated curve. Either mistake still draws a closed, plausible
  // looking flame that is subtly the wrong shape.
  let d = `M ${f(curves[0][0][0])} ${f(curves[0][0][1])}`;
  for (const [, p1, p2, p3] of curves) {
    d += ` C ${f(p1[0])} ${f(p1[1])} ${f(p2[0])} ${f(p2[1])} ${f(p3[0])} ${f(p3[1])}`;
  }
  return `${d} Z`;
}

/**
 * The control points behind the outlines, before they get flattened.
 *
 * flameOutline() and coreOutline() return already-sampled point arrays, which is
 * all the raster needs, but SVG wants the true control points to emit crisp
 * cubic commands rather than a 300-point polyline. Declaring the curves once
 * here and deriving both representations below keeps a single source of truth.
 */
const FLAME_CURVES = [
  // Rounded base, left -> centre.
  [[0.09, 0.79], [0.01, 0.93], [0.28, 1.0], [0.5, 1.0]],
  // Wide right flank sweeping up from the base.
  [[0.5, 1.0], [0.79, 1.0], [0.95, 0.87], [0.9, 0.62]],
  // Right side rising, then tucking inward: this is the notch.
  [[0.9, 0.62], [0.86, 0.41], [0.63, 0.35], [0.66, 0.21]],
  // Up to the leaning tip.
  [[0.66, 0.21], [0.69, 0.08], [0.53, 0.05], [0.43, 0.0]],
  // Down the left of the tip.
  [[0.43, 0.0], [0.3, 0.06], [0.29, 0.23], [0.33, 0.37]],
  // Left flank back to the base.
  [[0.33, 0.37], [0.17, 0.45], [0.11, 0.58], [0.09, 0.79]],
];

const CORE_CURVES = [
  [[0.5, 0.9], [0.3, 0.86], [0.3, 0.68], [0.36, 0.56]],
  [[0.36, 0.56], [0.42, 0.47], [0.55, 0.47], [0.58, 0.4]],
  [[0.58, 0.4], [0.6, 0.33], [0.5, 0.29], [0.45, 0.27]],
  [[0.45, 0.27], [0.38, 0.31], [0.38, 0.43], [0.42, 0.53]],
  [[0.42, 0.53], [0.34, 0.64], [0.4, 0.85], [0.5, 0.9]],
];

// The flame sits inside the same inset+pad box as the raster, expressed in the
// SVG's 512-unit viewBox.
const VIEWBOX = 512;

/** Flame inset for the ordinary icon, as a fraction of the canvas. */
const PAD = 0.17;

/**
 * Flame inset for the maskable icon.
 *
 * Android crops a maskable icon to the launcher's shape — often a circle — and
 * will clip anything outside the middle ~80%. The flame's tip and base are
 * precisely what a circular crop removes, so the inset widens from 17% to 27%.
 */
const MASKABLE_PAD = 0.27;

/** Scaled control points for one padding variant. */
function mapper(pad) {
  const inset = VIEWBOX * pad;
  const box = VIEWBOX - inset * 2;
  return (curves) => curves.map((curve) => curve.map(([nx, ny]) => [inset + nx * box, inset + ny * box]));
}

/**
 * Builds the favicon markup.
 *
 * @param {{pad: number, radius: number}} opts
 *   pad: flame inset as a fraction of the canvas
 *   radius: badge corner radius, in viewBox units
 *
 * Two variants come out of this. The plain one uses a 17% inset and generously
 * rounded corners. The maskable one widens the inset to 27% and squares off the
 * corners, because Android crops a maskable icon to the launcher's shape — often
 * a circle — and will happily lop off the flame's tip and base, which are
 * exactly the parts that make it recognisable. A square badge keeps the
 * background reaching the canvas edge instead of leaving transparent corners
 * inside a circular mask.
 */
function buildSVG({ pad, radius }) {
  const scaleCurves = mapper(pad);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}" role="img" aria-label="The Ascension">
  <!--
    GENERATED FILE - do not edit by hand.
    Produced by client/scripts/render-icons.mjs. The PNG rasters in this
    directory come from the same bezier control points, so the two cannot drift.

    A rising flame rather than a trophy or shield: it ties together streaks (the
    Grandmaster rank icon is already a flame), ascending through the rank ladder,
    and heat while you work. It also survives being shrunk to 16px, which a
    trophy's stem and handles emphatically do not.

    The silhouette is deliberately asymmetric. Fire is recognised by two features
    a symmetrical teardrop lacks: the tip leans left, and the right flank tucks
    inward about a third of the way up to form the notch that reads as a flame
    licking off a body.

    The gradient brightens upward - violet at the base through cyan to gold at the
    tip - so the mark itself reads as "ascension", and it matches the rank
    accents (Apprentice violet -> Practitioner cyan -> Apex gold).
  -->
  <defs>
    <!-- y1=1 (base) to y2=0 (tip): brightest colour at the tip, where the eye
         lands first. -->
    <linearGradient id="flame" x1="0.5" y1="1" x2="0.5" y2="0">
      <stop offset="0%" stop-color="#a78bfa"/>
      <stop offset="45%" stop-color="#22d3ee"/>
      <stop offset="80%" stop-color="#fbbf24"/>
      <stop offset="100%" stop-color="#ffd166"/>
    </linearGradient>

    <linearGradient id="badge" x1="0.5" y1="0" x2="0.5" y2="1">
      <stop offset="0%" stop-color="#0d1020"/>
      <stop offset="100%" stop-color="#05060f"/>
    </linearGradient>

    <!-- Hot core. Warms toward a yellow-white rather than a neutral white:
         mixing cyan toward pure white lands on a pale mint that reads sickly. -->
    <linearGradient id="core" x1="0.5" y1="0.95" x2="0.5" y2="0.55">
      <stop offset="0%" stop-color="#fffdf0"/>
      <stop offset="100%" stop-color="#fff3d0"/>
    </linearGradient>
  </defs>

  <rect width="${VIEWBOX}" height="${VIEWBOX}" rx="${radius}" fill="url(#badge)"/>
  <path fill="url(#flame)" d="${svgPath(scaleCurves(FLAME_CURVES))}"/>
  <path fill="url(#core)" opacity="0.78" d="${svgPath(scaleCurves(CORE_CURVES))}"/>
</svg>
`;
}

// The radius of the raster's rounded badge, in the same units the SVG uses, so
// the two agree. 112/512 keeps the corners at ~22% of the side, which reads as
// a squircle rather than a circle.
const BADGE_RADIUS = 112;

writeFileSync(resolve(OUT, 'favicon.svg'), buildSVG({ pad: PAD, radius: BADGE_RADIUS }));
console.log('  favicon.svg                    vector  (generated)');

/* ------------------------------------------------------------------ *
 * Minimal PNG encoder (RGBA, 8-bit, non-interlaced).                  *
 * ------------------------------------------------------------------ */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(rgba, size) {
  // Each scanline is prefixed with filter type 0 (None).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * Emit.                                                              *
 * ------------------------------------------------------------------ */
mkdirSync(OUT, { recursive: true });

// name, pixel size, flame inset.
const targets = [
  // Legacy sizes that non-SVG browsers and /favicon.ico auto-discovery want.
  ['favicon-32x32.png', 32, PAD],
  ['favicon-16x16.png', 16, PAD],
  ['favicon-64x64.png', 64, PAD],
  // iOS home screen. 180x180 is Apple's required size. iOS applies its own
  // squircle mask, so the padding is loosened slightly to clear its corners.
  ['apple-touch-icon.png', 180, 0.19],
  // PWA / Android splash source.
  ['icon-192.png', 192, PAD],
  ['icon-512.png', 512, PAD],
];

for (const [name, size, pad] of targets) {
  const png = encodePNG(render(size, { pad }), size);
  writeFileSync(resolve(OUT, name), png);
  console.log(`  ${name.padEnd(24)} ${String(size).padStart(3)}px  ${png.length} bytes`);
}

// A full-size copy for eyeballing the artwork after a geometry change.
writeFileSync(resolve(OUT, 'icon-preview-512.png'), encodePNG(render(512, { pad: PAD }), 512));
console.log('  icon-preview-512.png          512px  (visual check)');

// Maskable: wider inset, square background, so an Android circular or squircle
// mask never clips the flame's tip and base.
const maskable = encodePNG(render(512, { pad: MASKABLE_PAD, radius: 0 }), 512);
writeFileSync(resolve(OUT, 'maskable-icon-512.png'), maskable);
console.log(`  maskable-icon-512.png         512px  ${maskable.length} bytes`);

writeFileSync(resolve(OUT, 'maskable.svg'), buildSVG({ pad: MASKABLE_PAD, radius: 0 }));
console.log('  maskable.svg                  vector  (generated)');

/**
 * The pinned-tab silhouette.
 *
 * Chromium's mask-icon uses only the alpha channel and recolours the result, so
 * this file has to be the flame alone on a transparent field. Pointing
 * mask-icon at favicon.svg instead would flatten the dark rounded badge into a
 * solid block and bury the flame inside it.
 *
 * Drawn as a single opaque shape — outer flame plus core merged — because any
 * internal gap would become a hole punched through the tab's recoloured fill.
 */
function buildMaskSVG() {
  const scaleCurves = mapper(PAD);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}" role="img" aria-label="The Ascension">
  <!-- GENERATED FILE - see client/scripts/render-icons.mjs -->
  <path fill="#000" d="${svgPath(scaleCurves(FLAME_CURVES))}"/>
  <path fill="#000" d="${svgPath(scaleCurves(CORE_CURVES))}"/>
</svg>
`;
}

writeFileSync(resolve(OUT, 'favicon-mask.svg'), buildMaskSVG());
console.log('  favicon-mask.svg              vector  (pinned-tab silhouette)');