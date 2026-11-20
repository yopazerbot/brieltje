import * as THREE from 'three';
import { groundNoise } from './groundNoise';
import { terrain, terrainTexture } from './terrain';
import './airHaze'; // its haze function in the fog chunk (the tree strips' own haze below uses it)

/**
 * The countryside beyond the data, as it looks from the air at the end of autumn round Lede: blocks of land between
 * tracks and lanes, each cut into long strips of a few dozen metres, pasture most of them, the others ploughed, in
 * stubble or green with winter cereal (with the tractor's tramlines), a hedgerow or a row of trees along some of their
 * edges, small woods turning brown, and the odd farmstead in its ring of trees.
 *
 * Painted once at the start on a canvas (nothing to download) as a tile of 2 km that repeats, turned a little against
 * the map so its repeats don't line up with the streets. The grass (world/houseMeshes.ts grassMaterial) shows it where
 * the data has nothing: outside the data's area (a soft mask of it, setArea below), and beyond the draw
 * distance, where the tiles' fields and houses are no longer drawn. Below that the ground is as before. Seen from the
 * street it lies in the haze; from the parachute or the helicopter the land runs on as farmland to the horizon instead
 * of one green carpet. The horizon's ring (world/horizon.ts) carries it on past the end of the ground.
 *
 * One mipmapped texture read per pixel of the grass where it shows, and one of the mask. Generic: no real fields,
 * farms or roads are copied; only the kind of land is Flanders'.
 */

/** Pixels across the tile. */
const S = 1024;
/** Metres a pixel. */
const M = 2;
/** Radians the tile is turned against the map. */
const TURN = 0.31;

type Pt = [number, number];
type Rgb = [number, number, number];

/** The kinds of land and how often each comes, with their colour (sRGB, the albedo the grass would have). */
const USES: { use: string; share: number; colour: Rgb }[] = [
  { use: 'pasture', share: 0.42, colour: [78, 88, 37] },
  { use: 'cereal', share: 0.15, colour: [86, 80, 50] },
  { use: 'ploughed', share: 0.13, colour: [86, 68, 47] },
  { use: 'stubble', share: 0.11, colour: [104, 90, 58] },
  { use: 'cover', share: 0.08, colour: [66, 84, 35] },
  { use: 'beet', share: 0.05, colour: [60, 76, 33] },
  { use: 'nursery', share: 0.06, colour: [72, 73, 43] },
];

/** A row of trees in the far land, for its strips (canvas pixels; `tall`: the crowns' tops, metres). */
interface TreeRow {
  crowns: { x: number; y: number; r: number }[];
  tall: number;
  closed: boolean;
}

function paint(): { pixels: Uint8Array; rows: TreeRow[] } {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  let seed = 90917;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const vary = (c: Rgb, v: number): Rgb => {
    const k = 1 + (rand() - 0.5) * v;
    return [c[0] * k * (1 + (rand() - 0.5) * v * 0.4), c[1] * k, c[2] * k * (1 + (rand() - 0.5) * v * 0.4)];
  };
  const css = (c: Rgb, a = 1) => `rgba(${c.map((v) => Math.round(Math.min(255, Math.max(0, v)))).join(',')},${a})`;
  /**
   * Draw at the tile's place and wherever the shape spills over an edge, once more on the other side; each copy with
   * the same random numbers, so the copies match where they meet.
   */
  const wrapped = (pts: Pt[], pad: number, draw: () => void) => {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs) - pad, Math.max(...xs) + pad, Math.min(...ys) - pad, Math.max(...ys) + pad];
    const start = seed;
    let after = seed;
    for (const ox of [-S, 0, S]) {
      for (const oy of [-S, 0, S]) {
        if (x1 + ox < 0 || x0 + ox > S || y1 + oy < 0 || y0 + oy > S) continue;
        seed = start;
        g.save();
        g.translate(ox, oy);
        draw();
        g.restore();
        after = seed;
      }
    }
    seed = after;
  };
  const rows: TreeRow[] = [];
  const path = (pts: Pt[]) => {
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) g.lineTo(p[0], p[1]);
    g.closePath();
  };
  const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const pickUse = () => {
    let r = rand();
    for (const u of USES) if ((r -= u.share) < 0) return u;
    return USES[0];
  };

  g.fillStyle = css(USES[0].colour);
  g.fillRect(0, 0, S, S);

  // The blocks between the lanes: a grid of about 400 m with its corners moved about, wrapping round the tile.
  const N = 5;
  const cell = S / N;
  const jitter = Array.from({ length: N * N }, () => [(rand() - 0.5) * cell * 0.5, (rand() - 0.5) * cell * 0.5] as Pt);
  const corner = (i: number, j: number): Pt => {
    const [dx, dy] = jitter[(((j % N) + N) % N) * N + (((i % N) + N) % N)];
    return [i * cell + dx, j * cell + dy];
  };
  /** Edges where a hedgerow or a row of trees stands, drawn after the fields. */
  const hedges: { a: Pt; b: Pt; trees: boolean }[] = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const quad: Pt[] = [corner(i, j), corner(i + 1, j), corner(i + 1, j + 1), corner(i, j + 1)];
      // Some blocks in two, the halves' strips at right angles.
      const halves: Pt[][] = [];
      if (rand() < 0.45) {
        const t = 0.35 + rand() * 0.3;
        const m0 = lerp(quad[0], quad[3], t);
        const m1 = lerp(quad[1], quad[2], t);
        halves.push([quad[0], quad[1], m1, m0], [m0, m1, quad[2], quad[3]]);
        if (rand() < 0.4) hedges.push({ a: m0, b: m1, trees: rand() < 0.4 });
      } else halves.push(quad);
      for (const h of halves) {
        // The strips across one pair of sides, long along the other.
        const [a, b, c, d] = rand() < 0.5 ? h : [h[1], h[2], h[3], h[0]];
        const across = Math.hypot(b[0] - a[0], b[1] - a[1]);
        let t = 0;
        while (t < 1) {
          const width = (rand() < 0.15 ? 40 + rand() * 30 : 12 + rand() * 26) / across;
          const t1 = 1 - t < width * 1.5 ? 1 : t + width;
          const strip: Pt[] = [lerp(a, b, t), lerp(a, b, t1), lerp(d, c, t1), lerp(d, c, t)];
          const use = pickUse();
          const colour = vary(use.colour, 0.22);
          // Along the strip: its long direction and the tractor's lines in it.
          const long: Pt = [strip[3][0] - strip[0][0], strip[3][1] - strip[0][1]];
          const len = Math.hypot(long[0], long[1]);
          const u: Pt = [long[0] / len, long[1] / len];
          const n: Pt = [-u[1], u[0]];
          const mid = lerp(lerp(strip[0], strip[2], 0.5), lerp(strip[1], strip[3], 0.5), 0.5);
          wrapped(strip, 2, () => {
            path(strip);
            g.fillStyle = css(colour);
            g.fill();
            g.save();
            path(strip);
            g.clip();
            const line = (o: number, w: number, c: string) => {
              g.strokeStyle = c;
              g.lineWidth = w;
              g.beginPath();
              g.moveTo(mid[0] + n[0] * o - u[0] * len, mid[1] + n[1] * o - u[1] * len);
              g.lineTo(mid[0] + n[0] * o + u[0] * len, mid[1] + n[1] * o + u[1] * len);
              g.stroke();
            };
            const reach = across * (t1 - t) + 40;
            if (use.use === 'cereal' || use.use === 'beet') {
              // Tramlines, a pair of wheel tracks every 18 to 24 m, bare soil in them.
              const step = 9 + Math.floor(rand() * 3);
              for (let o = -reach + rand() * step; o < reach; o += step) {
                line(o - 0.45, 0.6, css([92, 76, 52], 0.75));
                line(o + 0.45, 0.6, css([92, 76, 52], 0.75));
              }
            } else if (use.use === 'stubble') {
              // The combine's swaths, lighter and darker by turns.
              for (let o = -reach; o < reach; o += 6) line(o, 3, css([128, 112, 74], 0.35));
            } else if (use.use === 'ploughed') {
              // The plough's lands and their dead furrows.
              for (let o = -reach + rand() * 14; o < reach; o += 12 + rand() * 4) line(o, 0.8, css([58, 44, 30], 0.5));
            } else if (use.use === 'nursery') {
              for (let o = -reach; o < reach; o += 2) line(o, 0.9, css([40, 52, 26], 0.55));
            } else if (use.use === 'pasture' && rand() < 0.5) {
              // Mown or grazed in bands.
              for (let o = -reach; o < reach; o += 5) line(o, 2, css([98, 104, 48], 0.08));
            }
            // A grassy margin round every field that isn't grass.
            if (use.use !== 'pasture') {
              path(strip);
              g.strokeStyle = css(vary(USES[0].colour, 0.1), 0.8);
              g.lineWidth = 1.2;
              g.stroke();
            }
            g.restore();
          });
          if (t1 < 1 && rand() < 0.1) hedges.push({ a: strip[1], b: strip[2], trees: rand() < 0.3 });
          t = t1;
        }
      }
    }
  }
  // The lanes and tracks along the blocks' edges, some with a hedgerow.
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      for (const [a, b] of [[corner(i, j), corner(i + 1, j)], [corner(i, j), corner(i, j + 1)]] as [Pt, Pt][]) {
        const r = rand();
        if (r < 0.14) {
          wrapped([a, b], 4, () => {
            g.strokeStyle = css([72, 72, 74]);
            g.lineWidth = 2.2;
            g.beginPath();
            g.moveTo(...a);
            g.lineTo(...b);
            g.stroke();
          });
        } else if (r < 0.4) {
          wrapped([a, b], 4, () => {
            g.strokeStyle = css([126, 118, 98], 0.9);
            g.lineWidth = 1.6;
            g.beginPath();
            g.moveTo(...a);
            g.lineTo(...b);
            g.stroke();
          });
        }
        if (rand() < 0.5) hedges.push({ a: [a[0] + 2, a[1] + 2], b: [b[0] + 2, b[1] + 2], trees: rand() < 0.35 });
      }
    }
  }
  // Hedgerows: lumps along the edge, dark green and brown; a row of trees: bigger crowns, spaced (and stood up as
  // a strip, farTrees below).
  for (const { a, b, trees } of hedges) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const crowns: { x: number; y: number; r: number; c: Rgb }[] = [];
    for (let d = 0, k = 1; d < len; d += trees ? 3.5 + k * 2 : 1.3) {
      k = rand();
      if (!trees && rand() < 0.12) continue; // a gap
      const [x, y] = lerp(a, b, d / len);
      crowns.push({ x, y, r: trees ? 1.8 + k * 1.4 : 1 + k * 0.8, c: vary(rand() < 0.3 ? [62, 50, 30] : [42, 50, 27], 0.3) });
    }
    if (trees) rows.push({ crowns, tall: 11 + rand() * 7, closed: false });
    wrapped([a, b], 6, () => {
      for (const c of crowns) {
        g.fillStyle = css(c.c);
        g.beginPath();
        g.arc(c.x, c.y, c.r, 0, Math.PI * 2);
        g.fill();
      }
    });
  }
  // Small woods: crowns packed in a rough oval, green, rust and brown.
  for (let k = 0; k < 7; k++) {
    const cx = rand() * S;
    const cy = rand() * S;
    const rx = 20 + rand() * 45;
    const ry = rx * (0.5 + rand() * 0.6);
    const turn = rand() * Math.PI;
    const outline: Pt[] = [[cx - rx, cy - rx], [cx + rx, cy + rx]];
    const crowns = Array.from({ length: Math.round(rx * ry * 0.12) }, () => {
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand());
      const x = Math.cos(a) * d * rx;
      const y = Math.sin(a) * d * ry;
      const pick = rand();
      const colour: Rgb = pick < 0.45 ? [38, 42, 24] : pick < 0.75 ? [60, 46, 28] : pick < 0.9 ? [78, 54, 30] : [30, 34, 22];
      return { x: cx + x * Math.cos(turn) - y * Math.sin(turn), y: cy + x * Math.sin(turn) + y * Math.cos(turn), r: 2 + rand() * 3, c: vary(colour, 0.25) };
    });
    // Its edge stood up as a strip: a crown every 6 m or so round the oval.
    const round = Math.PI * (rx + ry);
    const count = Math.max(8, Math.round(round / 3));
    const edge = Array.from({ length: count }, (_, i) => {
      const a = (i / count) * Math.PI * 2;
      const x = Math.cos(a) * rx * 0.92;
      const y = Math.sin(a) * ry * 0.92;
      return { x: cx + x * Math.cos(turn) - y * Math.sin(turn), y: cy + x * Math.sin(turn) + y * Math.cos(turn), r: 2.5 };
    });
    rows.push({ crowns: edge, tall: 15 + rand() * 6, closed: true });
    wrapped(outline, 6, () => {
      for (const c of crowns) {
        g.fillStyle = css(c.c);
        g.beginPath();
        g.arc(c.x, c.y, c.r, 0, Math.PI * 2);
        g.fill();
      }
    });
  }
  // Farmsteads: a yard, a house and its sheds and barns, trees round them.
  for (let k = 0; k < 14; k++) {
    const cx = rand() * S;
    const cy = rand() * S;
    const turn = rand() * Math.PI;
    const roofs: Rgb[] = [[112, 58, 42], [84, 84, 86], [60, 60, 63], [128, 74, 50]];
    const parts = [{ x: 0, y: 0, w: 16 + rand() * 8, h: 12 + rand() * 6, c: [118, 114, 102] as Rgb }];
    for (let b = 0; b < 2 + Math.floor(rand() * 3); b++) {
      parts.push({ x: (rand() - 0.5) * 14, y: (rand() - 0.5) * 10, w: 4 + rand() * 9, h: 3 + rand() * 4, c: roofs[Math.floor(rand() * roofs.length)] });
    }
    const trees = Array.from({ length: 8 + Math.floor(rand() * 10) }, () => {
      const a = rand() * Math.PI * 2;
      const d = 11 + rand() * 6;
      return { a, x: Math.cos(a) * d, y: Math.sin(a) * d * 0.8, r: 1.6 + rand() * 1.6 };
    }).sort((p, q) => p.a - q.a);
    rows.push({
      crowns: trees.map((t) => ({ x: cx + t.x * Math.cos(turn) - t.y * Math.sin(turn), y: cy + t.x * Math.sin(turn) + t.y * Math.cos(turn), r: t.r })),
      tall: 10 + rand() * 4,
      closed: true,
    });
    wrapped([[cx - 20, cy - 20], [cx + 20, cy + 20]], 0, () => {
      g.save();
      g.translate(cx, cy);
      g.rotate(turn);
      for (const p of parts) {
        g.fillStyle = css(vary(p.c, 0.15));
        g.fillRect(p.x - p.w / 2, p.y - p.h / 2, p.w, p.h);
      }
      for (const t of trees) {
        g.fillStyle = css(vary([42, 48, 26], 0.3));
        g.beginPath();
        g.arc(t.x, t.y, t.r, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
    });
  }
  return { pixels: new Uint8Array(g.getImageData(0, 0, S, S).data.buffer), rows };
}

/** The far land's texture, the area's mask and where it lies: shared by the grass and the horizon's ring. */
export const farLandUniforms = {
  farLand: { value: null as THREE.Texture | null },
  farMask: { value: null as THREE.Texture | null },
  /** The mask's corner (x, z) and size (x, z), in metres */
  farMaskBox: { value: new THREE.Vector4(-1e6, -1e6, 2e6, 2e6) },
};

/** The far land's albedo at a point of the ground (world x, z). Needs the uniforms above. */
export const FAR_LAND_GLSL = /* glsl */ `
  uniform sampler2D farLand;
  uniform sampler2D farMask;
  uniform vec4 farMaskBox;
  vec3 farLandAt(vec2 xz) {
    vec2 uv = mat2(${Math.cos(TURN).toFixed(5)}, ${Math.sin(TURN).toFixed(5)}, ${(-Math.sin(TURN)).toFixed(5)}, ${Math.cos(TURN).toFixed(5)}) * xz / ${(S * M).toFixed(1)};
    return texture2D(farLand, uv).rgb;
  }
  /** 1 outside the data's area, 0 inside it (soft over a few dozen metres). */
  float farLandOutside(vec2 xz) {
    vec2 uv = (xz - farMaskBox.xy) / farMaskBox.zw;
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 1.0;
    return 1.0 - texture2D(farMask, uv).r;
  }
`;

let treeRows: TreeRow[] = [];

/** Paint the far land and an empty mask (everything counts as inside until the area comes: setArea). Once. */
function make(renderer: THREE.WebGLRenderer): void {
  if (farLandUniforms.farLand.value) return;
  const { pixels, rows } = paint();
  treeRows = rows;
  const land = new THREE.DataTexture(pixels, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  land.colorSpace = THREE.SRGBColorSpace;
  land.wrapS = land.wrapT = THREE.RepeatWrapping;
  land.magFilter = THREE.LinearFilter;
  land.minFilter = THREE.LinearMipmapLinearFilter;
  land.generateMipmaps = true;
  land.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  land.needsUpdate = true;
  farLandUniforms.farLand.value = land;
  const mask = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  mask.magFilter = mask.minFilter = THREE.LinearFilter;
  mask.needsUpdate = true;
  farLandUniforms.farMask.value = mask;
}

/** Pixels across the area's mask (about 6 m each). */
const MASK = 512;

/**
 * The data's area (the village data's outline, which takes in the ring round the house): inside it the grass stays
 * as it is (meadows, lawns: the data says what is there), outside it the far land shows. Drawn into a small mask with
 * a soft edge of some 40 m, so the two meet without a line.
 */
export function setArea(area: [number, number][] | undefined): void {
  if (!area || area.length < 3 || !farLandUniforms.farMask.value) return;
  const pad = 200;
  const xs = area.map((p) => p[0]);
  const zs = area.map((p) => p[1]);
  const x0 = Math.min(...xs) - pad;
  const z0 = Math.min(...zs) - pad;
  const w = Math.max(...xs) + pad - x0;
  const h = Math.max(...zs) + pad - z0;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = MASK;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, MASK, MASK);
  g.fillStyle = '#fff';
  g.beginPath();
  area.forEach(([x, z], i) => {
    const px = ((x - x0) / w) * MASK;
    const py = ((z - z0) / h) * MASK;
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  });
  g.closePath();
  g.fill();
  // Softened: a box blur three times over (nearly a Gaussian), along x and then z.
  const src = g.getImageData(0, 0, MASK, MASK).data;
  let a = new Float32Array(MASK * MASK);
  for (let i = 0; i < a.length; i++) a[i] = src[i * 4] / 255;
  let b = new Float32Array(MASK * MASK);
  const R = 3;
  for (let pass = 0; pass < 6; pass++) {
    // A running sum along each row (x) or column (z): the edges count their own value again.
    const [step, line] = pass % 2 === 0 ? [1, MASK] : [MASK, 1];
    for (let l = 0; l < MASK; l++) {
      const start = l * line;
      const at = (k: number) => a[start + Math.min(MASK - 1, Math.max(0, k)) * step];
      let sum = 0;
      for (let k = -R; k <= R; k++) sum += at(k);
      for (let k = 0; k < MASK; k++) {
        b[start + k * step] = sum / (2 * R + 1);
        sum += at(k + R + 1) - at(k - R);
      }
    }
    [a, b] = [b, a];
  }
  const data = new Uint8Array(MASK * MASK * 4);
  for (let i = 0; i < a.length; i++) {
    // A little inside the outline before the far land begins: the data's own edge fields and meadows keep their look.
    const v = Math.round(Math.min(1, a[i] * 1.6) * 255);
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  const old = farLandUniforms.farMask.value;
  const mask = new THREE.DataTexture(data, MASK, MASK);
  mask.magFilter = mask.minFilter = THREE.LinearFilter;
  mask.needsUpdate = true;
  farLandUniforms.farMask.value = mask;
  farLandUniforms.farMaskBox.value.set(x0, z0, w, h);
  old?.dispose();
}

/**
 * The grass shows the far land outside the data's area and beyond `reach` (the tiles' draw distance, read each time
 * the shader's uniforms go up). Chained after what the material already has (the ground's shading).
 */
export function patchFarLand(material: THREE.MeshStandardMaterial, renderer: THREE.WebGLRenderer, reach: () => number): void {
  make(renderer);
  const farReach = {
    get value() {
      return reach();
    },
  };
  const before = material.onBeforeCompile;
  material.onBeforeCompile = (shader, r) => {
    before.call(material, shader, r);
    Object.assign(shader.uniforms, farLandUniforms, { farReach });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vFarXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFarXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float farReach;\nvarying vec2 vFarXZ;\n${FAR_LAND_GLSL}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float farW = max(farLandOutside(vFarXZ), smoothstep(farReach, farReach + 150.0, length(vFarXZ - cameraPosition.xz)));
        if (farW > 0.002) diffuseColor.rgb = mix(diffuseColor.rgb, farLandAt(vFarXZ) * mix(0.9, 1.08, gs.b), farW);`,
      );
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${key()}|farLand`;
  material.needsUpdate = true;
}

/** A point of the tile (canvas pixels) in the world (metres), the tile's turn undone. */
function toWorld(x: number, y: number): [number, number] {
  const u = (x / S) * S * M;
  const v = (y / S) * S * M;
  return [Math.cos(TURN) * u + Math.sin(TURN) * v, -Math.sin(TURN) * u + Math.cos(TURN) * v];
}

/** sRGB 0-255 to the linear colour a vertex carries. */
const linear = (c: Rgb): Rgb => c.map((v) => Math.pow(v / 255, 2.2)) as Rgb;

/** The kinds of crown in the far tree lines. */
const BROAD = 0;
const BARE = 1;
const CONIFER = 2;
const POPLAR = 3;

/**
 * The strips of the far tree lines (see FarTrees): for each two crowns next to each other a piece of strip, its top
 * the two crowns' outlines meeting halfway. Every crown has its kind, height and colour:
 *
 * - at the end of November most broad-leaved crowns have turned (ochre, rust, brown) and a quarter are bare, a
 *   purple-grey haze of twigs; a few are still dull green; a wood's edge has its dark spruces here and there, a
 *   farmstead the odd ornamental conifer, and one hedgerow in eight is a row of poplars, tall and slim;
 * - a broad crown is round on top (a half ellipse as wide as the tree), a conifer pointed, a poplar a tall narrow
 *   round-topped column; where two trees stand apart the strip dips between them to the hedge or the lower crowns behind;
 * - the normal of each column leans the way the crown's outline faces there (along the row on its shoulders, up on
 *   its top), so the low sun lights one side of every crown and leaves the other in its own shade;
 * - `crown`: the crown's top height at the column, and how bare it is, for the shader's ragged, see-through top.
 */
function treeStrips(rows: TreeRow[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const along: number[] = [];
  const crown: number[] = [];
  const index: number[] = [];
  let seed = 5309;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // Colours (sRGB, the leaves' albedo in the light): still green, olive, ochre, rust, brown; bare twigs; spruce.
  const turned: Rgb[] = [[72, 84, 45], [86, 86, 48], [112, 96, 50], [106, 76, 44], [90, 70, 46]];
  const twigs: Rgb = [86, 78, 76];
  const spruce: Rgb = [44, 56, 40];
  const pick = (kind: number): Rgb => {
    if (kind === BARE) return twigs;
    if (kind === CONIFER) return spruce;
    if (kind === POPLAR) return rand() < 0.5 ? [110, 100, 54] : [92, 90, 52];
    const r = rand();
    return turned[r < 0.18 ? 0 : r < 0.32 ? 1 : r < 0.6 ? 2 : r < 0.84 ? 3 : 4];
  };
  for (const row of rows) {
    // Each row's own run of colour (one farm's trees, one wood's edge), every crown halfway between it and its own.
    const rowHue = pick(BROAD);
    const crowns = row.closed ? [...row.crowns, row.crowns[0]] : row.crowns;
    // The row's mix: a wood's edge (closed and tall), a farmstead's ring (closed), or a hedgerow's trees.
    const poplars = !row.closed && rand() < 0.12;
    const wood = row.closed && row.tall >= 15;
    const kindOf = (): number => {
      if (poplars) return POPLAR;
      const r = rand();
      if (r < (wood ? 0.14 : row.closed ? 0.08 : 0.02)) return CONIFER;
      return r < 0.32 ? BARE : BROAD;
    };
    const tops = crowns.map((c, i) => {
      // The ring's closing crown is its first again.
      const kind = row.closed && i === crowns.length - 1 ? -1 : kindOf();
      const tall = row.tall * (kind === POPLAR ? 1.55 : kind === CONIFER ? 1.1 : 1) * (rand() < 0.2 ? 0.5 + rand() * 0.3 : 0.75 + rand() * 0.45);
      const k = 0.85 + rand() * 0.3;
      const own = pick(kind);
      const c0 = kind === CONIFER ? own : own.map((v, j) => (v + rowHue[j]) / 2);
      return { at: toWorld(c.x, c.y), kind, h: tall, c: linear([c0[0] * k, c0[1] * k, c0[2] * k]), bare: kind === BARE ? 0.7 + rand() * 0.3 : kind === POPLAR ? 0.35 : rand() * 0.3 };
    });
    if (row.closed && tops.length > 1) tops[tops.length - 1] = { ...tops[0], at: tops[tops.length - 1].at };
    let run = rand() * 100; // metres along the row, for the leaves' pattern
    for (let i = 0; i + 1 < tops.length; i++) {
      const a = tops[i];
      const b = tops[i + 1];
      const dx = b.at[0] - a.at[0];
      const dz = b.at[1] - a.at[1];
      const len = Math.hypot(dx, dz);
      if (len < 0.5 || len > 26 || (!row.closed && rand() < 0.08)) continue; // a gap in the row
      const ux = dx / len;
      const uz = dz / len;
      // Halfway the strip drops to the hedge, or to the crowns of a wood behind, where the trees stand apart.
      const low = Math.min(a.h, b.h) * (wood ? 0.72 : poplars ? 0.5 : 0.38);
      // Each half belongs to one crown: its outline from its middle (s 0) out to halfway (s = len / 2).
      for (const [t0, t1, tree, side] of [[0, 0.5, a, 1], [0.5, 1, b, -1]] as const) {
        // A broad crown reaches past halfway where trees stand close: neighbours overlap, a shallow dip between them.
        const half = tree.kind === POPLAR ? 2.4 : tree.kind === CONIFER ? 2.6 : Math.min(len * 0.66, 3 + tree.h * 0.25);
        const base = pos.length / 3;
        for (let k = 0; k <= 3; k++) {
          const t = t0 + ((t1 - t0) * k) / 3;
          const s = Math.abs(t - (side > 0 ? 0 : 1)) * len; // metres from this crown's middle
          const q = Math.min(1, s / half);
          let h: number;
          if (tree.kind === CONIFER) h = tree.h * (1 - 0.75 * q);
          else if (tree.kind === POPLAR) h = tree.h * (1 - 0.2 * q * q); // a column, round-topped, not a spike
          else h = tree.h * (0.58 + 0.42 * Math.sqrt(Math.max(0, 1 - q * q)));
          h = Math.max(low, s > half ? low : h);
          // Facing along the row on the crown's shoulders (away from its middle), up on its top, and across the row
          // (the shader turns that part towards the eye).
          const out = side * (tree.kind === CONIFER ? 0.6 : 0.7) * q;
          const up = tree.kind === CONIFER ? 0.9 : 0.5 + 1.1 * (1 - q);
          // Lower down the crowns merge into one mass: the foot faces only across the row.
          const n = new THREE.Vector3(-uz + ux * out, up, ux + uz * out).normalize();
          const foot = new THREE.Vector3(-uz, 0.6, ux).normalize();
          const x = a.at[0] + dx * t;
          const z = a.at[1] + dz * t;
          pos.push(x, -0.8, z, x, h, z);
          nor.push(foot.x, foot.y, foot.z, n.x, n.y, n.z);
          // The foot in the crowns' own shade, and where two crowns meet a little darker.
          const meet = 1 - 0.22 * q * q;
          col.push(tree.c[0] * 0.5, tree.c[1] * 0.5, tree.c[2] * 0.5, tree.c[0] * meet, tree.c[1] * meet, tree.c[2] * meet);
          along.push(run + t * len, run + t * len);
          crown.push(h, tree.bare, h, tree.bare);
          if (k > 0) {
            const v = base + (k - 1) * 2;
            index.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
          }
        }
      }
      run += len;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geometry.setAttribute('along', new THREE.Float32BufferAttribute(along, 1));
  geometry.setAttribute('crown', new THREE.Float32BufferAttribute(crown, 2));
  geometry.setIndex(index);
  return geometry;
}

/**
 * The far land's rows of trees, its woods' edges and its farmsteads' rings stood up: a strip each, its top in a bump
 * for every crown, a few metres to some 20 high, on the ground's relief. From the air, at a slant, the land then has
 * tree lines along its fields, not only dark lines painted on it; seen from right above a strip is a line and the
 * painting shows. Solid (nothing blended; only the ragged tops cut out), one draw call: one tile of them, copied (instanced) to where
 * the tile repeats round the eye. Only outside the data's area: inside it the vertex shader folds them flat (height
 * 0), as the mask says, so they never stand among the real hedges and trees.
 */
export class FarTrees {
  readonly mesh: THREE.InstancedMesh;

  constructor(renderer: THREE.WebGLRenderer, ground: number) {
    make(renderer);
    // The relief's heights (world/terrain.ts), each texel's centre on its grid point; past the grid its edge, as the skirt.
    const terrainMap = terrainTexture();
    const terrainBox = new THREE.Vector4(terrain.x0 - terrain.step / 2, terrain.z0 - terrain.step / 2, terrain.nx * terrain.step, terrain.nz * terrain.step);
    const geometry = treeStrips(treeRows);
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide });
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, farLandUniforms, { ftTerrain: { value: terrainMap }, ftBox: { value: terrainBox }, ftNoise: { value: groundNoise() } });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
uniform sampler2D ftTerrain;
uniform vec4 ftBox;
attribute float along;
attribute vec2 crown;
varying vec2 vFt;
varying vec2 vFtCrown;
${FAR_LAND_GLSL}`)
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vFt = vec2(along, transformed.y);
          vFtCrown = crown;
          vec2 ftXZ = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xz;
          // Folded flat inside the data's area; on the relief's ground outside it.
          transformed.y *= step(0.5, farLandOutside(ftXZ));
          transformed.y += texture2D(ftTerrain, clamp((ftXZ - ftBox.xy) / ftBox.zw, 0.0, 1.0)).r;`,
        );
      // Leaves: lighter and darker clumps of a few metres, finer ones near by (the noise tile's mipmaps fade them).
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D ftNoise;\nvarying vec2 vFt;\nvarying vec2 vFtCrown;')
        // Seen from its back a strip's normal was turned round whole, down into the ground: no sun, no sky, a black
        // cut-out against the fields. Its part across the row is turned towards whoever looks instead (on both sides),
        // keeping its parts along the row and up: each crown's shoulders and top face the same way from either side.
        .replace(
          '#include <normal_fragment_begin>',
          `#include <normal_fragment_begin>
          #ifdef DOUBLE_SIDED
            normal *= faceDirection;
          #endif
          {
            vec3 ftFace = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
            ftFace *= sign(dot(ftFace, vViewPosition) + 1e-6);
            float ftAway = dot(normal, ftFace);
            if (ftAway < 0.0) normal = normalize(normal - 2.0 * ftAway * ftFace);
          }`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          float ftClump = texture2D(ftNoise, vFt / vec2(6.0, 5.0)).r;
          float ftLeaf = texture2D(ftNoise, vFt / vec2(1.3, 1.1) + 0.41).r;
          diffuseColor.rgb *= 0.62 + 0.5 * ftClump + 0.3 * (ftLeaf - 0.5);
          // The top ragged, not a cut line: clumps of leaves and twigs against the sky, the bare crowns' upper half a
          // see-through haze of twigs. Far off the noise's mipmaps even out and the top is just a little lower.
          float ftUp = clamp(vFt.y / max(vFtCrown.x, 1.0), 0.0, 1.0);
          float ftRag = ftLeaf * 0.6 + ftClump * 0.4;
          if (ftRag < smoothstep(0.72, 1.0, ftUp) * (0.6 + 0.3 * vFtCrown.y) + smoothstep(0.35, 0.95, ftUp) * vFtCrown.y * 0.32) discard;`,
        )
        // A strip stands for a mass of crowns, most of whose leaves are in the shade of others: the sun and the sky
        // reach a part of it only, so a wood's edge facing a low sun isn't paler than the flat fields in front of it.
        // And it doesn't mirror the sky as a smooth surface facing up does at a glancing look (the pale sheen that
        // turned the strips into a ghost of a tree line): leaves scatter it.
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
          reflectedLight.directDiffuse *= 0.5 + 0.25 * smoothstep(0.3, 0.9, ftClump);
          reflectedLight.indirectDiffuse *= 0.7;
          reflectedLight.directSpecular *= 0.1;
          reflectedLight.indirectSpecular *= 0.1;`,
        )
        // The haze over them a quarter less than over the ground at their distance (the ground haze is thick enough
        // to hide the tiles' end; the horizon's lines too keep under half of it at their tops): a tree line a few
        // hundred metres off keeps its green instead of a pale ghost of it. Further out the haze takes them over more,
        // to nearly all of it at a kilometre and a half: line behind line, each paler, as tree lines go in autumn haze.
        .replace(
          '#include <fog_fragment>',
          `#ifdef USE_FOG
            #ifdef FOG_EXP2
              float fogFactor = 1.0 - airHaze(vFogDepth, fogDensity);
            #else
              float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
            #endif
            gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor * mix(0.75, 0.95, smoothstep(500.0, 1500.0, vFogDepth)));
          #endif`,
        );
    };
    material.customProgramCacheKey = () => 'farTrees';
    this.mesh = new THREE.InstancedMesh(geometry, material, 9);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 9; i++) {
      const [x, z] = toWorld((Math.floor(i / 3) - 1) * S, ((i % 3) - 1) * S);
      this.mesh.setMatrixAt(i, m.makeTranslation(x, 0, z));
    }
    this.mesh.position.y = ground;
    this.mesh.frustumCulled = false; // its copies move with the eye
    this.mesh.userData.ignoreRay = true;
    this.mesh.raycast = () => {};
    this.mesh.onBeforeRender = (_r, _s, camera) => this.follow(camera.position);
  }

  /**
   * The copies sit at the eye's tile and the eight round it (the camera's far plane, 2 km, reaches about one tile);
   * only the whole set moves, through its own place, set while it is drawn: right for every camera at once (the
   * split screen's two too), with no instance data to send again.
   */
  private follow(eye: THREE.Vector3): void {
    const tile = S * M;
    const cu = Math.floor((Math.cos(TURN) * eye.x - Math.sin(TURN) * eye.z) / tile);
    const cv = Math.floor((Math.sin(TURN) * eye.x + Math.cos(TURN) * eye.z) / tile);
    const [x, z] = toWorld(cu * S, cv * S);
    if (this.mesh.position.x !== x || this.mesh.position.z !== z) {
      this.mesh.position.x = x;
      this.mesh.position.z = z;
      this.mesh.updateMatrixWorld();
    }
  }
}
