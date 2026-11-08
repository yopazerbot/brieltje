import * as THREE from 'three';
import { leafLight } from './leaves';
import { sway } from './wind';
import { ATLAS, Spray } from './cardTrees';

/**
 * The leaves of the trees and hedges as cards on Medium and up: small flat sprays of leaves, cut out
 * (alpha-tested, nothing blended), each tree's crown a few hundred of them round its branches
 * (world/cardTrees.ts). Their pictures are painted here in code when the game starts, nothing to
 * download: one atlas of four sprays, 512 px each, a broad-leaved twig (oak, lime, beech, fruit trees),
 * a birch's hanging twig with small toothed leaves, a poplar's upright twig and a spruce's frond of
 * needles. Grey for how light each leaf is (the crown's own colour comes per corner: its species, its
 * autumn and how deep in the crown it sits), the alpha the leaf's outline.
 *
 * The smaller copies the graphics chip uses further off (mipmaps) are made here too, keeping as much of
 * each spray solid as up close: left to the chip, the outline thins out with distance until a crown far
 * off is a few specks.
 *
 * The bark is a second, smaller atlas: furrowed bark and a birch's white bark with its dark marks.
 */

/** Pixels per spray in the leaf atlas (2 x 2 of them: world/cardTrees.ts Spray). */
const TILE = ATLAS / 2;
const SIZE = ATLAS;

type Rand = () => number;
/** Painting a step at a time (paintSoon): each `yield` a place to stop for the frame. */
type Steps = Generator<void, void>;
const random = (seed: number): Rand => {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
};
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** One spray's pixels while it is painted: light (grey) and coverage, with a slight per-leaf tint. */
class Canvas {
  readonly r = new Float32Array(TILE * TILE);
  readonly g = new Float32Array(TILE * TILE);
  readonly b = new Float32Array(TILE * TILE);
  readonly a = new Float32Array(TILE * TILE);

  /** Lay a colour over a pixel with coverage `cover` (0 to 1), as paint over paint. */
  put(x: number, y: number, cover: number, r: number, g: number, b: number): void {
    if (x < 0 || y < 0 || x >= TILE || y >= TILE || cover <= 0) return;
    const k = y * TILE + x;
    const c = Math.min(1, cover);
    this.r[k] = r * c + this.r[k] * (1 - c);
    this.g[k] = g * c + this.g[k] * (1 - c);
    this.b[k] = b * c + this.b[k] * (1 - c);
    this.a[k] = c + this.a[k] * (1 - c);
  }

  /** A twig from (x0, y0) to (x1, y1), w0 to w1 px across, bark-brown. */
  twig(x0: number, y0: number, x1: number, y1: number, w0: number, w1: number, shade = 1): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy || 1;
    const pad = Math.max(w0, w1) + 1;
    for (let y = Math.floor(Math.min(y0, y1) - pad); y <= Math.ceil(Math.max(y0, y1) + pad); y++) {
      for (let x = Math.floor(Math.min(x0, x1) - pad); x <= Math.ceil(Math.max(x0, x1) + pad); x++) {
        const t = clamp01(((x - x0) * dx + (y - y0) * dy) / len2);
        const d = Math.hypot(x - (x0 + dx * t), y - (y0 + dy * t));
        const half = (w0 + (w1 - w0) * t) / 2;
        const cover = clamp01(half - d + 0.5);
        const lit = shade * (0.42 + 0.14 * clamp01(1 - d / Math.max(half, 0.5)));
        this.put(x, y, cover, lit * 1.05, lit * 0.92, lit * 0.78);
      }
    }
  }

  /**
   * A leaf with its stalk at (x, y), pointing at `angle` (radians, 0 along +x), `length` px long and
   * `width` px across at its widest. `outline(u)`: its half-width, 0 to 1, along it (u from -1 at the
   * stalk to 1 at the tip); `light`: how much light it catches; `tint`: yellower (> 0) or bluer (< 0).
   */
  leaf(x: number, y: number, angle: number, length: number, width: number, outline: (u: number) => number, light: number, tint: number): void {
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const half = length / 2;
    const cx = x + ca * half;
    const cy = y + sa * half;
    const reach = Math.max(half, width / 2) + 2;
    // One half of the leaf turned a little more to the light than the other, as a leaf folds along its rib.
    const fold = 0.08;
    for (let py = Math.floor(cy - reach); py <= Math.ceil(cy + reach); py++) {
      for (let px = Math.floor(cx - reach); px <= Math.ceil(cx + reach); px++) {
        const ox = px - cx;
        const oy = py - cy;
        const u = (ox * ca + oy * sa) / half;
        if (u <= -1 || u >= 1) continue;
        const v = oy * ca - ox * sa; // px across
        const edge = outline(u) * (width / 2);
        const cover = clamp01(edge - Math.abs(v) + 0.5);
        if (cover <= 0) continue;
        const inside = clamp01(1 - Math.abs(v) / Math.max(edge, 0.5));
        const rib = Math.abs(v) < 0.9 ? 1.1 : 1;
        // Side veins running from the rib towards the tip.
        const vein = 1 - 0.04 * Math.pow(Math.abs(Math.sin((u * 5.5 - Math.abs(v) / Math.max(1, width) * 6) * Math.PI)), 12);
        const lit = light * (0.78 + 0.22 * Math.pow(inside, 0.6)) * (v > 0 ? 1 + fold : 1 - fold) * rib * vein * (0.94 + 0.08 * (u + 1) / 2);
        this.put(px, py, cover, lit * (1 + tint * 0.6), lit, lit * (1 - tint));
      }
    }
  }

  /** A needle: a short, thin, slightly lighter line on its upper side. */
  needle(x: number, y: number, angle: number, length: number, light: number): void {
    const x1 = x + Math.cos(angle) * length;
    const y1 = y + Math.sin(angle) * length;
    const dx = x1 - x;
    const dy = y1 - y;
    const len2 = dx * dx + dy * dy;
    for (let py = Math.floor(Math.min(y, y1) - 2); py <= Math.ceil(Math.max(y, y1) + 2); py++) {
      for (let px = Math.floor(Math.min(x, x1) - 2); px <= Math.ceil(Math.max(x, x1) + 2); px++) {
        const t = clamp01(((px - x) * dx + (py - y) * dy) / len2);
        const d = Math.hypot(px - (x + dx * t), py - (y + dy * t));
        const half = 0.95 * (1 - 0.5 * t);
        const cover = clamp01(half - d + 0.5);
        const lit = light * (0.85 + 0.25 * t);
        this.put(px, py, cover, lit * 0.96, lit, lit * 1.02);
      }
    }
  }
}

// Leaf outlines, half-width 0 to 1 along the leaf (u -1 at the stalk, 1 at the tip).
/** Oval with a pointed tip and a fine toothed edge: lime, beech, apple. */
const ovate = (u: number) => Math.sqrt(Math.max(0, 1 - u * u)) * (1.05 - 0.28 * u) * (1 - 0.35 * Math.pow(Math.max(0, u), 3)) * (1 + 0.035 * Math.sin(u * 38));
/** Oak: deep round lobes along an oval. */
const lobed = (u: number) => Math.sqrt(Math.max(0, 1 - u * u)) * (0.95 - 0.1 * u) * (0.72 + 0.28 * Math.abs(Math.cos((u + 1) * 2.3 * Math.PI)));
/** Birch: a broad base drawn out to a long point, coarsely toothed. */
const birch = (u: number) => Math.pow(Math.max(0, 1 - u * u), 0.65) * (1.15 - 0.6 * (u + 1) / 2) * (1 + 0.09 * Math.sin(u * 30));
/** Poplar: diamond-shaped, broadest a third along. */
const deltoid = (u: number) => (u < -0.35 ? (u + 1) / 0.65 : (1 - u) / 1.35) * (1 + 0.04 * Math.sin(u * 26));

/** A twig that bends a little: points along it from (x, y) at `angle`, `length` px, curving by `bend` per step. */
function path(x: number, y: number, angle: number, length: number, bend: number, steps = 8): [number, number, number][] {
  const out: [number, number, number][] = [[x, y, angle]];
  const step = length / steps;
  for (let i = 0; i < steps; i++) {
    angle += bend;
    x += Math.cos(angle) * step;
    y += Math.sin(angle) * step;
    out.push([x, y, angle]);
  }
  return out;
}

/** Along a path, a point (and its heading) at fraction t. */
function along(p: [number, number, number][], t: number): [number, number, number] {
  const f = clamp01(t) * (p.length - 1);
  const i = Math.min(p.length - 2, Math.floor(f));
  const k = f - i;
  return [p[i][0] + (p[i + 1][0] - p[i][0]) * k, p[i][1] + (p[i + 1][1] - p[i][1]) * k, p[i][2] + (p[i + 1][2] - p[i][2]) * k];
}

function drawPath(c: Canvas, p: [number, number, number][], w0: number, w1: number): void {
  for (let i = 0; i < p.length - 1; i++) {
    const t0 = i / (p.length - 1);
    const t1 = (i + 1) / (p.length - 1);
    c.twig(p[i][0], p[i][1], p[i + 1][0], p[i + 1][1], w0 + (w1 - w0) * t0, w0 + (w1 - w0) * t1);
  }
}

/**
 * A broad-leaved spray: a twig from the bottom middle (where the card meets its branch) with side twigs,
 * leaves alternating along them, broader round the middle of the card than at its foot. Half of them oak
 * leaves, half ovals: up close they read as a mixed wood, further off just as leaves.
 */
function* paintBroad(c: Canvas, rand: Rand): Steps {
  const main = path(TILE / 2 + (rand() - 0.5) * 20, 4, Math.PI / 2 + (rand() - 0.5) * 0.2, TILE * 0.8, (rand() - 0.5) * 0.06);
  const twigs: [number, number, number][][] = [main];
  for (let i = 0; i < 9; i++) {
    const [x, y, a] = along(main, 0.12 + i * 0.095);
    const side = i % 2 ? 1 : -1;
    twigs.push(path(x, y, a + side * (0.65 + rand() * 0.4), TILE * (0.42 - i * 0.03), -side * 0.05));
  }
  for (const t of twigs) drawPath(c, t, t === main ? 6 : 3.5, 1.6);
  for (const t of twigs) {
    const n = t === main ? 14 : 11;
    for (let i = 0; i < n; i++) {
      const [x, y, a] = along(t, 0.15 + (0.85 * (i + rand() * 0.5)) / n);
      const side = i % 2 ? 1 : -1;
      const len = 54 + rand() * 30;
      const oak = rand() < 0.45;
      c.leaf(x, y, a + side * (0.55 + rand() * 0.5), len, len * (oak ? 0.62 : 0.58), oak ? lobed : ovate, 0.62 + rand() * 0.38, (rand() - 0.5) * 0.12);
    }
    const [x, y, a] = along(t, 1);
    c.leaf(x, y, a + (rand() - 0.5) * 0.3, 66, 38, ovate, 0.75 + rand() * 0.25, 0);
    yield;
  }
}

/** A birch's twigs: thin and hanging (the card hangs from its branch), with many small, toothed leaves, open between. */
function* paintBirch(c: Canvas, rand: Rand): Steps {
  for (let k = 0; k < 7; k++) {
    const t = path(TILE / 2 + (k - 3) * 30 + (rand() - 0.5) * 20, 4, Math.PI / 2 + (k - 3) * 0.13 + (rand() - 0.5) * 0.15, TILE * (0.78 + rand() * 0.18), (rand() - 0.5) * 0.08, 10);
    drawPath(c, t, 3, 1.2);
    for (let i = 0; i < 12; i++) {
      const [x, y, a] = along(t, 0.12 + (0.88 * (i + rand() * 0.6)) / 12);
      const side = i % 2 ? 1 : -1;
      const len = 44 + rand() * 22;
      c.leaf(x, y, a + side * (0.7 + rand() * 0.5), len, len * 0.68, birch, 0.6 + rand() * 0.4, 0.05 + (rand() - 0.5) * 0.1);
    }
    yield;
  }
}

/** A poplar's upright twig: short side shoots close to it, dense with small diamond leaves on long stalks. */
function* paintPoplar(c: Canvas, rand: Rand): Steps {
  const main = path(TILE / 2, 4, Math.PI / 2, TILE * 0.9, (rand() - 0.5) * 0.03);
  drawPath(c, main, 6, 2);
  for (let i = 0; i < 10; i++) {
    const [x, y, a] = along(main, 0.08 + i * 0.09);
    const side = i % 2 ? 1 : -1;
    const shoot = path(x, y, a + side * (0.45 + rand() * 0.25), TILE * (0.26 - i * 0.012), -side * 0.03, 5);
    drawPath(c, shoot, 3, 1.5);
    for (let j = 0; j < 5; j++) {
      const [lx, ly, la] = along(shoot, 0.2 + j * 0.2);
      const len = 48 + rand() * 20;
      c.leaf(lx, ly, la + (j % 2 ? 1 : -1) * (0.5 + rand() * 0.6), len, len * 0.8, deltoid, 0.6 + rand() * 0.4, (rand() - 0.5) * 0.1);
    }
    yield;
  }
}

/**
 * A spruce's frond seen from above, as it lies out from the trunk: a twig from the bottom middle with side
 * shoots in a flat fan, each shoot thick with short needles all round, lighter where they face up.
 */
function* paintSpruce(c: Canvas, rand: Rand): Steps {
  const main = path(TILE / 2, 2, Math.PI / 2, TILE * 0.95, (rand() - 0.5) * 0.04, 12);
  const shoots: [number, number, number][][] = [main];
  for (let i = 0; i < 16; i++) {
    const [x, y, a] = along(main, 0.05 + i * 0.058);
    for (const side of [-1, 1]) {
      const reach = TILE * 0.36 * Math.sin(Math.PI * (0.12 + 0.8 * (i / 16))) * (0.8 + rand() * 0.3);
      const shoot = path(x, y, a + side * (0.85 + rand() * 0.25), reach, -side * 0.06, 6);
      shoots.push(shoot);
      // A few side shoots of their own.
      if (reach > 80) {
        for (const t of [0.4, 0.7]) {
          const [sx, sy, sa] = along(shoot, t);
          shoots.push(path(sx, sy, sa + side * 0.6, reach * 0.3, 0, 3));
        }
      }
    }
  }
  for (const s of shoots) drawPath(c, s, s === main ? 5 : 2.4, 1.2);
  for (const s of shoots) {
    const steps = Math.max(4, Math.round(Math.hypot(s[s.length - 1][0] - s[0][0], s[s.length - 1][1] - s[0][1]) / 2.2));
    for (let i = 0; i < steps; i++) {
      const [x, y, a] = along(s, i / steps);
      for (const side of [-1, 1]) {
        const len = 10 + rand() * 6;
        // Needles point forward along the shoot, out on both sides, the upper ones lighter.
        c.needle(x, y, a + side * (0.55 + rand() * 0.5), len, side > 0 ? 0.7 + rand() * 0.3 : 0.5 + rand() * 0.25);
      }
    }
    yield;
  }
}

/** Make the pixels of a spray: paint it, then lift its leaves to an average light of `mean`. */
function* paint(kind: Spray, seed: number, mean: number): Generator<void, Canvas> {
  const c = new Canvas();
  const rand = random(seed);
  if (kind === Spray.Broad) yield* paintBroad(c, rand);
  else if (kind === Spray.Birch) yield* paintBirch(c, rand);
  else if (kind === Spray.Poplar) yield* paintPoplar(c, rand);
  else yield* paintSpruce(c, rand);
  yield;
  let sum = 0;
  let n = 0;
  for (let k = 0; k < TILE * TILE; k++) {
    if (c.a[k] > 0.5) {
      sum += c.g[k] / c.a[k];
      n++;
    }
  }
  const lift = n ? mean / (sum / n) : 1;
  yield;
  for (let k = 0; k < TILE * TILE; k++) {
    const a = c.a[k];
    // The colour under the leaf (unpremultiplied); round the outline the spray's own average, so the
    // smaller copies don't darken towards the edge.
    if (a > 0.001) {
      c.r[k] = Math.min(1, (c.r[k] / a) * lift);
      c.g[k] = Math.min(1, (c.g[k] / a) * lift);
      c.b[k] = Math.min(1, (c.b[k] / a) * lift);
    } else {
      c.r[k] = c.g[k] = c.b[k] = mean;
    }
  }
  return c;
}

/**
 * A spray's coverage faded out towards the edges of its square, to nothing on its outer texels, in every copy.
 * Smaller copies average the leaves into a haze that reaches the square's edges, and their alpha is scaled up to
 * keep the spray's share past the cut (build): the haze along the edges then passed the cut too, and the card's
 * straight edges showed, a faint rectangle round each spray of a crown seen from a little way off (a birch's
 * hanging twigs against the sky most of all). The poplar's and the spruce's sprays also ran into their square's
 * edge on the full picture. And a sample at a card's edge reads into the next spray once a copy is small enough
 * for the two texels' inset (world/cardTrees.ts sprayRect) to be under one of its texels: an empty edge on both
 * sprays keeps that empty. The fade is EDGE_FADE of the square (at least two texels), so the scale that follows
 * makes up the coverage inside it.
 */
function fadeEdges(a: Float32Array, s: number): void {
  // The smallest copies (a spray a few texels across: a crown far off, its cards a pixel or two) keep their haze,
  // or nothing of the spray would be left in them.
  if (s < 8) return;
  const margin = Math.max(2, s * EDGE_FADE);
  for (let y = 0; y < s; y++) {
    const dy = Math.min(y, s - 1 - y);
    for (let x = 0; x < s; x++) {
      const d = Math.min(dy, x, s - 1 - x); // texels from the edge: 0 on the outer ring
      if (d >= margin) continue;
      const t = d / margin;
      a[y * s + x] *= t * t * (3 - 2 * t);
    }
  }
}
/** The share of a spray's square, from each edge, over which its coverage fades out (fadeEdges). */
const EDGE_FADE = 0.06;

/**
 * The atlas with its smaller copies, each spray on its own so they don't run into each other, and each
 * copy's coverage kept: its alpha scaled until as much of the spray passes the cut as in the full picture.
 */
function* build(sprays: Canvas[], cut: number): Generator<void, { image: Uint8Array; mipmaps: { data: Uint8Array; width: number; height: number }[] }> {
  let level = sprays.map((c) => ({ size: TILE, r: c.r, g: c.g, b: c.b, a: c.a }));
  for (const l of level) fadeEdges(l.a, l.size);
  const target = sprays.map((c) => {
    let n = 0;
    for (let k = 0; k < TILE * TILE; k++) if (c.a[k] >= cut) n++;
    return n / (TILE * TILE);
  });
  const mipmaps: { data: Uint8Array; width: number; height: number }[] = [];
  for (let size = SIZE; size >= 1; size >>= 1) {
    const data = new Uint8Array(size * size * 4);
    const half = Math.max(1, size >> 1);
    for (let k = 0; k < level.length; k++) {
      const l = level[k];
      const ox = (k % 2) * half;
      const oy = Math.floor(k / 2) * half;
      const s = l.size;
      if (s < TILE) fadeEdges(l.a, s);
      // The alpha's scale for this copy, so the share of it past the cut stays the spray's own.
      let scale = 1;
      if (s < TILE) {
        let lo = 0.5;
        let hi = 4;
        for (let i = 0; i < 16; i++) {
          const mid = (lo + hi) / 2;
          let n = 0;
          for (let p = 0; p < s * s; p++) if (l.a[p] * mid >= cut) n++;
          if (n / (s * s) < target[k]) lo = mid;
          else hi = mid;
        }
        scale = (lo + hi) / 2;
      }
      for (let y = 0; y < s && y < half; y++) {
        for (let x = 0; x < s && x < half; x++) {
          const p = y * s + x;
          const o = ((oy + y) * size + ox + x) * 4;
          data[o] = Math.round(l.r[p] * 255);
          data[o + 1] = Math.round(l.g[p] * 255);
          data[o + 2] = Math.round(l.b[p] * 255);
          data[o + 3] = Math.round(clamp01(l.a[p] * scale) * 255);
        }
      }
      yield;
    }
    mipmaps.push({ data, width: size, height: size });
    // The next copy: each 2 x 2 block averaged, the colour weighted by coverage.
    const next: typeof level = [];
    for (const l of level) {
      const s = Math.max(1, l.size >> 1);
      const r = new Float32Array(s * s);
      const g = new Float32Array(s * s);
      const b = new Float32Array(s * s);
      const a = new Float32Array(s * s);
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          let wr = 0;
          let wg = 0;
          let wb = 0;
          let wa = 0;
          let w = 0;
          for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
            const p = Math.min(l.size - 1, y * 2 + dy) * l.size + Math.min(l.size - 1, x * 2 + dx);
            const k = l.a[p] + 0.02;
            wr += l.r[p] * k;
            wg += l.g[p] * k;
            wb += l.b[p] * k;
            wa += l.a[p];
            w += k;
          }
          const q = y * s + x;
          r[q] = wr / w;
          g[q] = wg / w;
          b[q] = wb / w;
          a[q] = wa / 4;
        }
      }
      next.push({ size: s, r, g, b, a });
      if (s >= 64) yield;
    }
    level = next;
  }
  return { image: mipmaps[0].data, mipmaps };
}

/** Where an alpha-tested card is cut: the same in the picture's copies and in the material. */
export const CUT = 0.5;
let atlas: THREE.DataTexture | null = null;

/** The leaf atlas's pixels, painted a step at a time (paintSoon). */
function* leafSteps(): Generator<void, THREE.DataTexture> {
  const sprays = [yield* paint(Spray.Broad, 4242, 0.78), yield* paint(Spray.Birch, 777, 0.82), yield* paint(Spray.Poplar, 9001, 0.8), yield* paint(Spray.Spruce, 31337, 0.74)];
  const { image, mipmaps } = yield* build(sprays, CUT);
  const t = new THREE.DataTexture(image, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.mipmaps = mipmaps;
  t.generateMipmaps = false;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = 4;
  t.colorSpace = THREE.NoColorSpace; // a grey to multiply the crown's colour with
  t.needsUpdate = true;
  return t;
}

/** Run painting steps to the end at once. */
function drainNow<T>(steps: Generator<void, T>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** The leaf atlas: painted already (paintSoon), or now at once (about a tenth of a second). */
export function leafAtlas(): THREE.DataTexture {
  atlas ??= drainNow(leafSteps());
  return atlas;
}

/** Value noise's corner values, repeating every `px` by `py` cells. */
function hash(i: number, j: number, px: number, py: number, seed: number): number {
  const ii = ((i % px) + px) % px;
  const jj = ((j % py) + py) % py;
  const v = Math.sin(ii * 127.1 + jj * 311.7 + seed * 74.7) * 43758.5453;
  return v - Math.floor(v);
}

/** Value noise that repeats every `period` cells (for bark that tiles). */
function noise(x: number, y: number, px: number, py: number, seed: number): number {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  return (hash(i, j, px, py, seed) * (1 - sx) + hash(i + 1, j, px, py, seed) * sx) * (1 - sy) + (hash(i, j + 1, px, py, seed) * (1 - sx) + hash(i + 1, j + 1, px, py, seed) * sx) * sy;
}

const BARK_W = 256;
const BARK_H = 512;
let bark: THREE.DataTexture | null = null;

/** The pixels from x0 to x1 (whole numbers, any range up to a width), wrapped round into 0 to `w`. */
function* wrapped(x0: number, x1: number, w: number): Generator<number> {
  for (let x = x0; x <= x1 && x < x0 + w; x++) yield ((x % w) + w) % w;
}

/**
 * The bark atlas, 512 x 512: on the left furrowed bark (deep cracks running up the trunk between long plates,
 * in a brownish grey; the trunks' colours per corner make it oak, lime, poplar or spruce), on the right a birch's
 * (white, with dark marks across the trunk and black patches). Both repeat up and round the trunk. Colour, with
 * how high each point stands (the cracks deep) in the alpha, for the material's relief. Each mark and patch is laid
 * on over its own small box of pixels, round the trunk and up it as the bark repeats.
 */
function* barkSteps(): Generator<void, THREE.DataTexture> {
  const W = BARK_W * 2;
  const data = new Uint8Array(W * BARK_H * 4);
  const rand = random(2024);
  const marks: [number, number, number, number][] = [];
  for (let i = 0; i < 70; i++) marks.push([rand() * BARK_W, rand() * BARK_H, 10 + rand() * 40, 1.5 + rand() * 3]);
  const patches: [number, number, number][] = [];
  for (let i = 0; i < 9; i++) patches.push([rand() * BARK_W, rand() * BARK_H, 12 + rand() * 22]);
  // The birch's white and relief, before its marks and patches.
  const white = new Float64Array(BARK_W * BARK_H);
  const relief = new Float64Array(BARK_W * BARK_H).fill(0.8);
  for (let y = 0; y < BARK_H; y++) {
    for (let x = 0; x < BARK_W; x++) {
      // Furrowed: plates between cracks that wander a little as they run up.
      const wander = noise(x / 24, y / 64, BARK_W / 24, BARK_H / 64, 1) * 2.2;
      const ridge = Math.abs(Math.sin(((x / BARK_W) * 12 + wander) * Math.PI));
      const plate = Math.pow(ridge, 0.45);
      const grain = noise(x / 3, y / 14, BARK_W / 3, BARK_H / 14, 2);
      const blotch = noise(x / 40, y / 40, BARK_W / 40, BARK_H / 40, 3);
      const breaks = 1 - 0.45 * THREE.MathUtils.smoothstep(noise(x / 8, y / 5, BARK_W / 8, BARK_H / 5, 4), 0.7, 0.8);
      const height = clamp01(plate * breaks * (0.8 + 0.2 * grain));
      const lit = 0.22 + 0.5 * height + 0.08 * (blotch - 0.5);
      const o = (y * W + x) * 4;
      data[o] = Math.round(clamp01(lit * 1.02) * 255);
      data[o + 1] = Math.round(clamp01(lit * 0.95) * 255);
      data[o + 2] = Math.round(clamp01(lit * 0.86) * 255);
      data[o + 3] = Math.round(height * 255);
      // Birch: white with a faint sheen across.
      white[y * BARK_W + x] = 0.86 + 0.08 * noise(x / 30, y / 6, BARK_W / 30, BARK_H / 6, 5) - 0.05 * noise(x / 4, y / 2, BARK_W / 4, BARK_H / 2, 6);
    }
    if ((y & 15) === 15) yield;
  }
  // Dark lenticels across the trunk.
  for (const [mx, my, len, thick] of marks) {
    for (const y of wrapped(Math.floor(my - thick), Math.ceil(my + thick), BARK_H)) {
      let dy = Math.abs(y - my);
      dy = Math.min(dy, BARK_H - dy);
      if (dy >= thick) continue;
      for (const x of wrapped(Math.floor(mx - len / 2), Math.ceil(mx + len / 2), BARK_W)) {
        let dx = Math.abs(x - mx);
        dx = Math.min(dx, BARK_W - dx);
        if (dx >= len / 2) continue;
        const k = (1 - dy / thick) * (1 - Math.pow((2 * dx) / len, 4));
        const p = y * BARK_W + x;
        white[p] = white[p] * (1 - 0.8 * k);
        relief[p] = Math.min(relief[p], 0.8 - 0.6 * k);
      }
    }
  }
  yield;
  // The odd black patch, its edge ragged (the raggedness reaches 0.175 of its radius either way).
  for (const [px, py, r] of patches) {
    const rx = (1.175 * r) / 1.2;
    const ry = (1.175 * r) / 0.8;
    for (const y of wrapped(Math.floor(py - ry), Math.ceil(py + ry), BARK_H)) {
      let dy = Math.abs(y - py);
      dy = Math.min(dy, BARK_H - dy);
      for (const x of wrapped(Math.floor(px - rx), Math.ceil(px + rx), BARK_W)) {
        let dx = Math.abs(x - px);
        dx = Math.min(dx, BARK_W - dx);
        const ragged = 0.35 * (noise(x / 5, y / 5, BARK_W / 5, BARK_H / 5, 7) - 0.5);
        const d = Math.hypot(dx * 1.2, dy * 0.8) / r + ragged;
        if (d < 1) {
          const p = y * BARK_W + x;
          white[p] *= 0.12 + 0.88 * clamp01((d - 0.75) / 0.25);
          relief[p] = Math.min(relief[p], 0.3 + 0.5 * d);
        }
      }
    }
  }
  yield;
  for (let y = 0; y < BARK_H; y++) {
    for (let x = 0; x < BARK_W; x++) {
      const p = y * BARK_W + x;
      const o = (y * W + x + BARK_W) * 4;
      data[o] = Math.round(clamp01(white[p]) * 255);
      data[o + 1] = Math.round(clamp01(white[p] * 0.985) * 255);
      data[o + 2] = Math.round(clamp01(white[p] * 0.95) * 255);
      data[o + 3] = Math.round(relief[p] * 255);
    }
  }
  const t = new THREE.DataTexture(data, W, BARK_H, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** The bark atlas: painted already (paintSoon), or now at once. */
export function barkAtlas(): THREE.DataTexture {
  bark ??= drainNow(barkSteps());
  return bark;
}

/** Wait for a moment the page is idle (or a frame, where the browser can't say). */
const idle = (): Promise<IdleDeadline | null> =>
  new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback((d) => resolve(d), { timeout: 250 });
    else setTimeout(() => resolve(null), 16);
  });

/** Paint a little at a time while the page is idle, a few milliseconds a slice, so play never stalls for it. */
async function sliced<T>(steps: Generator<void, T>): Promise<T> {
  for (;;) {
    const d = await idle();
    const end = performance.now() + Math.min(8, Math.max(3, d ? d.timeRemaining() : 4));
    while (performance.now() < end) {
      const r = steps.next();
      if (r.done) return r.value;
    }
  }
}

/**
 * Which trees are drawn: the leaf-card ones (Medium and up) or the plain ones (Low and phones: the smooth crowns,
 * the street models' cone conifers). Both kinds are built (not on a phone, which never shows the cards); their
 * materials are shown or hidden as a whole.
 *
 * Play begins with the plain trees whatever the preset: the atlases the cards need are painted after that, in idle
 * slices (paintSoon), only once a preset calls for the cards, and the cards come in once their pictures and
 * shaders are ready. Low and phones never paint them.
 */
const trees = {
  /** The preset asks for the cards */
  want: false,
  /** The cards are drawn */
  full: false,
  /** A phone: the cards are never built nor painted */
  never: false,
  /** Play has begun: the atlases may be painted (when wanted) */
  may: false,
  /** Painted, and their maps on the cards' materials */
  ready: false,
  painting: null as Promise<void> | null,
  /** Uploads the atlases and compiles the cards' shaders before they show (main.ts) */
  prepare: null as ((textures: THREE.Texture[]) => Promise<unknown>) | null,
  cards: new Set<THREE.MeshStandardMaterial>(),
  plain: new Set<THREE.Material>(),
  swaps: new Set<(full: boolean) => void>(),
  /** Told whenever the cards come or go (watchCards), not for the ground's bake */
  watch: new Set<(full: boolean) => void>(),
};

/** Draw the cards (`full`) or the plain trees. */
function show(full: boolean): void {
  trees.full = full;
  for (const m of trees.cards) m.visible = full;
  for (const m of trees.plain) m.visible = !full;
  for (const f of trees.swaps) f(full);
  for (const f of trees.watch) f(full);
}

/** The atlases painted in idle slices, then on the cards' materials, then the cards shown if still wanted. */
function paintSoon(): void {
  if (trees.painting || trees.ready || !trees.may || !trees.want) return;
  trees.painting = (async () => {
    atlas ??= await sliced(leafSteps());
    bark ??= await sliced(barkSteps());
    for (const m of trees.cards) {
      m.map = m.userData.bark ? bark : atlas;
      m.needsUpdate = true;
    }
    trees.ready = true;
    await trees.prepare?.([atlas, bark]).catch(() => undefined);
    trees.painting = null;
    show(trees.want);
  })();
}

/** Ask for the leaf-card trees (`full`: Medium and up, not a phone) or the plain ones. The plain ones show until the cards are ready. */
export function switchTrees(full: boolean): void {
  trees.want = full && !trees.never;
  if (trees.want && !trees.ready) {
    paintSoon();
    show(false);
  } else if (!trees.painting) show(trees.want);
}

/**
 * Play has begun: from now on the atlases are painted when a preset asks for the cards. `prepare` uploads them and
 * compiles the cards' shaders (in the background where the browser can) before the cards show.
 */
export function treesMayPaint(prepare: (textures: THREE.Texture[]) => Promise<unknown>): void {
  trees.may = true;
  trees.prepare = prepare;
  paintSoon();
}

/** On a phone (main.ts): the cards never show, so they are never built (world/surroundings.ts, hedgeCards.ts, streetConifers.ts). */
export function neverCards(): void {
  trees.never = true;
  switchTrees(false);
}

/** Whether the cards can ever show here (not a phone): if not, nothing of them is built. */
export const cardsBuilt = () => !trees.never;

/** Whether the leaf-card trees are drawn. */
export const cardsShown = () => trees.full;

/**
 * For the shaders compiled ahead (main.ts precompile): the meshes of cards whose pictures aren't painted yet are left
 * out (their materials would compile without them, and again once painted). Gives back what puts them back.
 */
export function unpaintedOut(root: THREE.Object3D): () => void {
  if (trees.ready) return () => {};
  const out: [THREE.Mesh, THREE.Material][] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && trees.cards.has(mesh.material as THREE.MeshStandardMaterial)) out.push([mesh, mesh.material as THREE.Material]);
  });
  for (const [mesh] of out) (mesh as { material: THREE.Material | null }).material = null;
  return () => {
    for (const [mesh, m] of out) mesh.material = m;
  };
}

/**
 * Materials of leaf-card trees (`cards`) and of what stands in for them on Low and phones (`plain`), shown as the
 * setting is now; `swap` for what a material alone can't switch (called with whether the cards show).
 */
export function enlist(cards: THREE.MeshStandardMaterial[], plain: THREE.Material[], swap?: (full: boolean) => void): void {
  for (const m of cards) {
    trees.cards.add(m);
    m.visible = trees.full;
    if (trees.ready && !m.map) {
      m.map = m.userData.bark ? barkAtlas() : leafAtlas();
      m.needsUpdate = true;
    }
  }
  for (const m of plain) {
    trees.plain.add(m);
    m.visible = !trees.full;
  }
  if (swap) {
    trees.swaps.add(swap);
    swap(trees.full);
  }
}

/** Hear whether the cards are drawn, now and whenever that changes (world/undergrowth.ts: its brambles and shrubs follow). */
export function watchCards(f: (full: boolean) => void): void {
  trees.watch.add(f);
  f(trees.full);
}

/** For the ground's bake (world/groundShade.ts bakeStandIns): the plain trees throw its shadows, cut-out cards can't. */
export function plainForBake(on: boolean): void {
  if (!trees.full) return;
  for (const m of trees.plain) m.visible = on;
  for (const f of trees.swaps) f(!on);
}

/**
 * The material of the leaf cards: the atlas's grey times the colour per corner, cut out, both sides drawn and
 * lit alike (each card's light follows the crown's shape round it, not the card's own face: a crown reads as one
 * soft mass of leaves, lit on the sun's side, with the sun shining through where you look against it), and the
 * crowns sway and turn as the old ones did (world/wind.ts). Its shadow is cut out the same way: three.js's own
 * shadow material takes the map and the cut from it. The map (leafAtlas) is put on once it is painted, after play
 * has begun and only when a preset asks for the cards (paintSoon): on Low and phones it is never painted.
 */
export function leafCardMaterial(lean: number, flutter: number, turning: boolean, through: number): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ alphaTest: CUT, side: THREE.DoubleSide, vertexColors: true, roughness: 0.9 });
  sway(material, lean, flutter, turning);
  const before = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.fragmentShader = leafLight(shader.fragmentShader, through).replace(
      '#include <normal_fragment_begin>',
      // The same normal on both sides of a card: the crown's, not the card's face turned to the eye.
      '#include <normal_fragment_begin>\n#ifdef DOUBLE_SIDED\nnormal *= faceDirection;\nnonPerturbedNormal = normal;\n#endif',
    );
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${key()}|leafCards${through}`;
  enlist([material], []);
  return material;
}

/**
 * The bark of the trunks and branches on Medium and up: the bark atlas, its relief from the atlas's alpha, the
 * colour per corner (each kind of tree its own bark). Up the trunk the bark repeats every two trunk-widths
 * whatever the tree's height (the instance's own stretch, in the vertex shader), so a tall trunk's bark isn't drawn out.
 * Its map (barkAtlas) too is put on once painted (paintSoon).
 */
export function barkMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  material.userData.bark = true;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
      #if defined(USE_INSTANCING) && defined(USE_MAP)
      vMapUv.y *= length(instanceMatrix[1].xyz) / max(0.05, length(instanceMatrix[0].xyz));
      #endif`,
    );
    // Relief from the alpha: the cracks darker where the light falls across them.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      #ifdef USE_MAP
      float barkHigh = texture2D(map, vMapUv).a;
      vec2 barkSlope = vec2(dFdx(barkHigh), dFdy(barkHigh));
      diffuseColor.rgb *= 0.75 + 0.25 * barkHigh;
      #endif`,
    ).replace(
      '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>
      #ifdef USE_MAP
      {
        vec3 barkX = normalize(dFdx(-vViewPosition));
        vec3 barkY = normalize(dFdy(-vViewPosition));
        vec3 barkR1 = cross(barkY, normal);
        vec3 barkR2 = cross(normal, barkX);
        float barkDet = dot(barkX, barkR1);
        vec3 barkGrad = sign(barkDet) * (barkSlope.x * barkR1 + barkSlope.y * barkR2) * 3.0;
        normal = normalize(abs(barkDet) * normal - barkGrad);
      }
      #endif`,
    );
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${key()}|cardBark`;
  enlist([material], []);
  return material;
}
