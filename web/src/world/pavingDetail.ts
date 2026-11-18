import * as THREE from 'three';
import STREETS from '../data/streets.json';
import DETAIL from '../data/roadDetail.json';
import type { Prism } from './houseData';
import { terrain } from './terrain';

/**
 * The hard ground that isn't road (Yoshi, 18 Nov 2026: the church square, parking places, pavements, the school's
 * yard): on foot the paving fills a third of the view, and the square was one tile pattern repeating evenly, clean
 * as on its first day. Now it shows its use, in four parts, cheap where it is everywhere and real geometry only
 * where it is small:
 *
 * - **No visible repeat.** On the paving's materials (detailPaving): one read of a small tile of soft noise in four
 *   channels, laid at an angle to the courses and 41 m across, gives stretches a little lighter or darker, warmer or
 *   cooler and a little rougher or smoother over 2 to 14 m. On the square's clinkers each paver also gets a shade of
 *   its own from its place in the world (worked out from the texture's own courses, no read), so the 2.2 m texture no
 *   longer repeats paver for paver; now and then one is a replaced, darker one. That fades where a paver is under
 *   two pixels, before it could shimmer.
 * - **Use.** A mask over the square, worked out once on the CPU from the village data (paveMask: 0.125 m a pixel,
 *   0.25 on phones): wheel tracks along the streets that cross it and into the parking bays, a walked band along
 *   the house fronts (polished: a little darker and smoother), oil drips under where an engine stands in each bay,
 *   a few darker spills, and the spots where nobody walks or drives (along walls, beds and the grass, in corners).
 *   One more read where the mask lies.
 * - **Weeds.** In those quiet spots grass grows in the clinkers' joints (drawn in the joints themselves, from the
 *   courses), and small tufts of grass and rosettes of weeds stand along the edges: real blades, one mesh. No moss
 *   (Yoshi, 18 Nov 2026).
 * - **Iron.** Drain gullies at the low points along the streets and in the square's hollows, round manhole covers
 *   down the streets, small utility lids near the house fronts: flat cast-iron shapes a few millimetres over the
 *   clinkers, from one small atlas drawn at the start (nothing to download), one mesh.
 *
 * The school's yard and Molenhoek's and Kapellenhoek's pavers (our models' own ground) and the footpaths' concrete
 * tiles get the first part only (detailModelPaving, detailPaving 'plain').
 */

type Pt = [number, number];

/** Development only: ?nopaving leaves all of this out, to compare looks and cost. */
const OFF = import.meta.env.DEV && new URLSearchParams(location.search).has('nopaving');
const PHONE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

// ---------------------------------------------------------------- the noise tile

const NOISE_SIZE = 128;

/** One channel of seamless value noise (smoothed random values on a wrapping grid, octaves of `cells`). */
function noiseChannel(octaves: [number, number][], seed: number): Float32Array {
  let s = seed;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const out = new Float32Array(NOISE_SIZE * NOISE_SIZE);
  for (const [cells, amp] of octaves) {
    const grid = Array.from({ length: cells * cells }, rand);
    const at = (i: number, j: number) => grid[(((j % cells) + cells) % cells) * cells + (((i % cells) + cells) % cells)];
    for (let y = 0; y < NOISE_SIZE; y++) {
      for (let x = 0; x < NOISE_SIZE; x++) {
        const fx = (x / NOISE_SIZE) * cells;
        const fy = (y / NOISE_SIZE) * cells;
        const i = Math.floor(fx);
        const j = Math.floor(fy);
        const u = fx - i;
        const v = fy - j;
        const su = u * u * (3 - 2 * u);
        const sv = v * v * (3 - 2 * v);
        const top = at(i, j) + (at(i + 1, j) - at(i, j)) * su;
        const bottom = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * su;
        out[y * NOISE_SIZE + x] += (top + (bottom - top) * sv) * amp;
      }
    }
  }
  // Stretched to the full range, so a threshold means the same share everywhere.
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of out) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  for (let k = 0; k < out.length; k++) out[k] = (out[k] - lo) / (hi - lo || 1);
  return out;
}

let noiseTile: THREE.DataTexture | null = null;

/**
 * Four channels of soft noise in one 128 px tile (64 KB): stretches of about 14 m (r), 6 m (g), 2.4 m (b) and
 * another of 10 m (a), when the tile is laid 41 m across.
 */
function paveNoise(): THREE.DataTexture {
  if (noiseTile) return noiseTile;
  const ch = [
    noiseChannel([[3, 0.75], [6, 0.25]], 1931),
    noiseChannel([[7, 0.7], [14, 0.3]], 7411),
    noiseChannel([[17, 0.65], [34, 0.35]], 3089),
    noiseChannel([[4, 0.8], [8, 0.2]], 5153),
  ];
  const data = new Uint8Array(NOISE_SIZE * NOISE_SIZE * 4);
  for (let k = 0; k < NOISE_SIZE * NOISE_SIZE; k++) for (let c = 0; c < 4; c++) data[k * 4 + c] = Math.round(ch[c][k] * 255);
  noiseTile = new THREE.DataTexture(data, NOISE_SIZE, NOISE_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  noiseTile.wrapS = noiseTile.wrapT = THREE.RepeatWrapping;
  noiseTile.magFilter = THREE.LinearFilter;
  noiseTile.minFilter = THREE.LinearMipmapLinearFilter;
  noiseTile.generateMipmaps = true;
  noiseTile.needsUpdate = true;
  return noiseTile;
}

// ---------------------------------------------------------------- the shader

const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
blank.needsUpdate = true;

/** Shared by every paving material: the noise, the square's mask and where it lies (x0, z0, 1 / width, 1 / depth). */
const uniforms = {
  paveNoise: { value: null as THREE.Texture | null },
  paveMask: { value: blank as THREE.Texture },
  paveArea: { value: new THREE.Vector4(1e7, 1e7, 0, 0) },
};

/**
 * The clinkers' courses as the texture lays them (tools/textures.py clinker): one tile is 10 pavers along u and 20
 * courses along v, each other course shifted half a paver (the texture's even courses counted from v = 0, as it is
 * stored upside down in both its files, world/textureFiles.ts). `pdCell`: the paver's place; `pdJoint`: metres to
 * its nearest joint.
 */
const CLINKER = /* glsl */ `
  vec2 pdU = vMapUv * vec2(10.0, 20.0);
  float pdCourse = floor(pdU.y);
  float pdShift = 0.5 * (1.0 - mod(pdCourse, 2.0));
  vec2 pdCell = vec2(floor(pdU.x + pdShift), pdCourse);
  vec2 pdIn = vec2(fract(pdU.x + pdShift), fract(pdU.y));
  float pdJoint = min(min(pdIn.x, 1.0 - pdIn.x) * 0.22, min(pdIn.y, 1.0 - pdIn.y) * 0.11);
  // Fades out where a paver is under about two pixels.
  float pdSharp = 1.0 - smoothstep(0.25, 0.55, max(fwidth(pdU.x), fwidth(pdU.y)));
  float pdOwn = pdHash(pdCell);
  float pdOdd = pdHash(pdCell + 71.3);
  // Each paver a shade of its own, and one in a hundred and fifty a replaced one, darker and a little browner.
  vec3 pdTone = vec3(0.93 + 0.14 * pdOwn);
  if (pdOdd > 0.993) pdTone *= vec3(0.8, 0.78, 0.74);
  pdC *= mix(vec3(1.0), pdTone, pdSharp);`;

/** Grass in the clinkers' joints where nobody walks (the mask's fourth channel), and darker joints there. */
const JOINT_WEEDS = /* glsl */ `
  if (pm.a > 0.02) {
    float pdPx = max(max(fwidth(vPaveXZ.x), fwidth(vPaveXZ.y)), 1e-4);
    float pdWeed = smoothstep(0.25, 0.75, pm.a * (0.55 + 0.9 * pdN.b)) * (0.4 + 0.6 * pdHash(pdCell + 13.7));
    float pdDirt = clamp((0.006 - pdJoint) / pdPx + 0.5, 0.0, 1.0);
    pdC *= 1.0 - 0.35 * pm.a * pdDirt * pdSharp;
    float pdW = 0.002 + 0.014 * pdWeed;
    float pdGreen = clamp((pdW - pdJoint) / pdPx + 0.5, 0.0, 1.0) * step(0.05, pdWeed);
    vec3 pdLeaf = vec3(0.075, 0.1, 0.03) * (0.7 + 0.6 * pdF);
    // Where the joints are too fine to draw, a faint green over the spot instead.
    pdC = mix(pdC, pdLeaf, mix(0.25 * pdWeed, pdGreen * 0.9, pdSharp));
  }`;

function fragment(clinker: boolean): string {
  return /* glsl */ `
  float pdRough = 1.0;
  {
    vec3 pdC = diffuseColor.rgb;
    // Stretches over metres, in a tile turned off the courses so its own repeat never lines up with theirs.
    vec2 pdT = vec2(vPaveXZ.x * 0.866 - vPaveXZ.y * 0.5, vPaveXZ.x * 0.5 + vPaveXZ.y * 0.866) / 41.0;
    vec4 pdN = texture2D(paveNoise, pdT);
    pdC *= mix(0.88, 1.07, pdN.r) * mix(0.95, 1.04, pdN.g);
    pdC *= mix(vec3(1.025, 1.0, 0.97), vec3(0.975, 0.995, 1.025), pdN.a);
    pdRough = mix(0.9, 1.06, pdN.g);
    ${clinker ? CLINKER : ''}
    // The square's use (its mask): wear, oil, spills, and where nobody comes.
    vec2 pmUv = (vPaveXZ - paveArea.xy) * paveArea.zw;
    vec4 pm = vec4(0.0);
    if (pmUv.x > 0.0 && pmUv.y > 0.0 && pmUv.x < 1.0 && pmUv.y < 1.0) pm = texture2D(paveMask, pmUv);
    float pdF = 0.5;
    if (pm.g + pm.b + pm.a > 0.01) pdF = texture2D(paveNoise, vPaveXZ / 1.9).b; // ragged edges, a hand's width
    // Worn: polished a little darker and smoother.
    float pdWorn = pm.r * (0.55 + 0.9 * pdN.b);
    pdC *= 1.0 - 0.16 * pdWorn;
    pdRough *= 1.0 - 0.3 * pdWorn;
    // Oil under the engines: dark, a little glossy; spills: grey-brown.
    float pdOil = clamp(pm.g * 1.8 - 0.12 + (pdF - 0.5) * 0.8, 0.0, 1.0) * step(0.02, pm.g);
    pdC = mix(pdC, pdC * vec3(0.36, 0.34, 0.33), pdOil * 0.85);
    pdRough *= 1.0 - 0.3 * pdOil;
    float pdSpill = clamp(pm.b * 1.4 - 0.25 + (pdF - 0.5) * 0.7, 0.0, 1.0);
    pdC = mix(pdC, pdC * vec3(0.74, 0.7, 0.62), pdSpill * 0.8);
    // Quiet spots a little grimier.
    pdC *= 1.0 - 0.08 * pm.a;
    ${clinker ? JOINT_WEEDS : ''}
    diffuseColor.rgb = pdC;
  }`;
}

const PARS = /* glsl */ `
uniform sampler2D paveNoise;
uniform sampler2D paveMask;
uniform vec4 paveArea;
varying vec2 vPaveXZ;
float pdHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}`;

/**
 * Give a paving material the stretches, the square's use and (`clinker`: the square's clinkers, whose courses are
 * known) a shade per paver and grass in the joints. Chained after what the material has (the ground's shading, the
 * rain): call it after those.
 */
export function detailPaving(material: THREE.MeshStandardMaterial, kind: 'clinker' | 'plain'): void {
  if (OFF || material.userData.paving) return;
  material.userData.paving = true;
  uniforms.paveNoise.value ??= paveNoise();
  const clinker = kind === 'clinker' && !!material.map;
  const before = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vPaveXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPaveXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${fragment(clinker)}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor * pdRough, 0.04, 1.0);');
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${key()}|paving-${clinker ? 'clinker' : 'plain'}`;
  material.needsUpdate = true;
}

/** Our models' own paving (the school's yard, Molenhoek's and Kapellenhoek's pavers, the café's slabs): the stretches. */
const MODEL_PAVING = /^(school_yard|mh_pavers|caf_slabs)$/;

export function detailModelPaving(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !MODEL_PAVING.test(mesh.name)) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) detailPaving(m as THREE.MeshStandardMaterial, 'plain');
    }
  });
}

// ---------------------------------------------------------------- the square's mask, worked out once

interface Seg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

/** A small seeded random source. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function inRing(ring: Pt[], x: number, z: number): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < xi + ((z - zi) * (xj - xi)) / (zj - zi)) hit = !hit;
  }
  return hit;
}

function segDist(s: Seg, x: number, z: number): number {
  const dx = s.bx - s.ax;
  const dz = s.bz - s.az;
  const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(s.ax + dx * t - x, s.az + dz * t - z);
}

/** A parking bay (data/roadDetail.json's dark patches): its ends' middles, the open one (the aisle's) first. */
interface Bay {
  ring: Pt[];
  open: Pt;
  closed: Pt;
  /** Across the bay, unit */
  across: Pt;
  width: number;
}

function smooth01(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

class Mask {
  readonly w: number;
  readonly h: number;
  readonly ch: Float32Array[];
  readonly inside: Uint8Array;
  constructor(
    readonly x0: number,
    readonly z0: number,
    readonly res: number,
    width: number,
    depth: number,
    readonly rings: Pt[][],
  ) {
    this.w = Math.ceil(width / res);
    this.h = Math.ceil(depth / res);
    this.ch = [0, 1, 2, 3].map(() => new Float32Array(this.w * this.h));
    this.inside = new Uint8Array(this.w * this.h);
  }

  /** Mark which pixels lie on the paving (even-odd over all its rings), row by row. */
  fill(): void {
    for (let j = 0; j < this.h; j++) {
      const z = this.z0 + (j + 0.5) * this.res;
      const xs: number[] = [];
      for (const ring of this.rings) {
        for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
          const [xi, zi] = ring[i];
          const [xk, zk] = ring[k];
          if (zi > z !== zk > z) xs.push(xi + ((z - zi) * (xk - xi)) / (zk - zi));
        }
      }
      xs.sort((a, b) => a - b);
      for (let n = 0; n + 1 < xs.length; n += 2) {
        const i0 = Math.max(0, Math.ceil((xs[n] - this.x0) / this.res - 0.5));
        const i1 = Math.min(this.w - 1, Math.floor((xs[n + 1] - this.x0) / this.res - 0.5));
        for (let i = i0; i <= i1; i++) this.inside[j * this.w + i] = 1;
      }
    }
  }

  /** Whether (x, z) lies on the paving. */
  on(x: number, z: number): boolean {
    const i = Math.floor((x - this.x0) / this.res);
    const j = Math.floor((z - this.z0) / this.res);
    return i >= 0 && j >= 0 && i < this.w && j < this.h && this.inside[j * this.w + i] === 1;
  }

  /** The channel's value at (x, z), nearest pixel. */
  at(c: number, x: number, z: number): number {
    const i = Math.floor((x - this.x0) / this.res);
    const j = Math.floor((z - this.z0) / this.res);
    return i >= 0 && j >= 0 && i < this.w && j < this.h ? this.ch[c][j * this.w + i] : 0;
  }

  /** Over every pixel within `r` metres of segment `s`: `f(distance)` into channel `c`, by `op`. */
  seg(c: number, s: Seg, r: number, f: (d: number) => number, op: 'max' | 'add' = 'max'): void {
    const i0 = Math.max(0, Math.floor((Math.min(s.ax, s.bx) - r - this.x0) / this.res));
    const i1 = Math.min(this.w - 1, Math.ceil((Math.max(s.ax, s.bx) + r - this.x0) / this.res));
    const j0 = Math.max(0, Math.floor((Math.min(s.az, s.bz) - r - this.z0) / this.res));
    const j1 = Math.min(this.h - 1, Math.ceil((Math.max(s.az, s.bz) + r - this.z0) / this.res));
    const a = this.ch[c];
    for (let j = j0; j <= j1; j++) {
      const z = this.z0 + (j + 0.5) * this.res;
      for (let i = i0; i <= i1; i++) {
        const k = j * this.w + i;
        if (!this.inside[k]) continue;
        const d = segDist(s, this.x0 + (i + 0.5) * this.res, z);
        if (d > r) continue;
        const v = f(d);
        a[k] = op === 'max' ? Math.max(a[k], v) : a[k] + v;
      }
    }
  }

  /** A soft round blob of `v` at (x, z), `r` metres, stretched `sx` along `dir` (unit). */
  blob(c: number, x: number, z: number, r: number, v: number, dir: Pt = [1, 0], sx = 1): void {
    const reach = r * Math.max(1, sx);
    const i0 = Math.max(0, Math.floor((x - reach - this.x0) / this.res));
    const i1 = Math.min(this.w - 1, Math.ceil((x + reach - this.x0) / this.res));
    const j0 = Math.max(0, Math.floor((z - reach - this.z0) / this.res));
    const j1 = Math.min(this.h - 1, Math.ceil((z + reach - this.z0) / this.res));
    const a = this.ch[c];
    for (let j = j0; j <= j1; j++) {
      const dz = this.z0 + (j + 0.5) * this.res - z;
      for (let i = i0; i <= i1; i++) {
        const k = j * this.w + i;
        if (!this.inside[k]) continue;
        const dx = this.x0 + (i + 0.5) * this.res - x;
        const along = (dx * dir[0] + dz * dir[1]) / sx;
        const across = -dx * dir[1] + dz * dir[0];
        const d = Math.hypot(along, across) / r;
        if (d >= 1) continue;
        a[k] = Math.max(a[k], v * (1 - d * d) * (1 - d * d));
      }
    }
  }

  texture(): THREE.DataTexture {
    const n = this.w * this.h;
    const data = new Uint8Array(n * 4);
    for (let k = 0; k < n; k++) for (let c = 0; c < 4; c++) data[k * 4 + c] = Math.round(Math.max(0, Math.min(1, this.ch[c][k])) * 255);
    const t = new THREE.DataTexture(data, this.w, this.h, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    return t;
  }
}

/** The streets' centre lines (data/streets.json, the road register's graph) where they cross the paving. */
function streetSegs(mask: Mask): Seg[] {
  const pts = STREETS.graph.points as Pt[];
  const out: Seg[] = [];
  for (const [a, b] of STREETS.graph.edges as Pt[]) {
    const [ax, az] = pts[a];
    const [bx, bz] = pts[b];
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(len / 1));
    let start = -1;
    for (let k = 0; k <= n + 1; k++) {
      const on = k <= n && mask.on(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n);
      if (on && start < 0) start = k;
      if (!on && start >= 0) {
        const t0 = start / n;
        const t1 = (k - 1) / n;
        if (t1 > t0) out.push({ ax: ax + (bx - ax) * t0, az: az + (bz - az) * t0, bx: ax + (bx - ax) * t1, bz: az + (bz - az) * t1 });
        start = -1;
      }
    }
  }
  return out;
}

/** The parking bays on the paving, each with its open end (nearest a street) and closed end. */
function bays(mask: Mask, streets: Seg[]): Bay[] {
  const out: Bay[] = [];
  for (const p of (DETAIL as unknown as { patches?: { t: string; r: number[][] }[] }).patches ?? []) {
    if (p.t !== '#5d5c59') continue; // the bays' dark fill (the light ones are their edging and a forecourt)
    const flat = p.r[0];
    const ring: Pt[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      const q: Pt = [flat[i], flat[i + 1]];
      if (!ring.some(([x, z]) => Math.hypot(x - q[0], z - q[1]) < 0.05)) ring.push(q);
    }
    if (ring.length !== 4 || !mask.on((ring[0][0] + ring[2][0]) / 2, (ring[0][1] + ring[2][1]) / 2)) continue;
    // The short sides are the ends.
    const side = (k: number) => Math.hypot(ring[(k + 1) % 4][0] - ring[k][0], ring[(k + 1) % 4][1] - ring[k][1]);
    const k = side(0) < side(1) ? 0 : 1;
    const mid = (a: number): Pt => [(ring[a][0] + ring[(a + 1) % 4][0]) / 2, (ring[a][1] + ring[(a + 1) % 4][1]) / 2];
    let e0 = mid(k);
    let e1 = mid(k + 2);
    const toStreet = (q: Pt) => Math.min(...streets.map((s) => segDist(s, q[0], q[1])), Infinity);
    if (toStreet(e1) < toStreet(e0)) [e0, e1] = [e1, e0];
    const width = side(k);
    const across: Pt = [(ring[(k + 1) % 4][0] - ring[k][0]) / width, (ring[(k + 1) % 4][1] - ring[k][1]) / width];
    out.push({ ring, open: e0, closed: e1, across, width });
  }
  return out;
}

/** The paving's edges, in pieces of about a metre, and whether a street or other paving goes on past each (not quiet). */
function edges(rings: Pt[][], others: Prism[]): { s: Seg; quiet: boolean; out: Pt }[] {
  const roads = others.filter((p) => p.m === 'road' || p.m.startsWith('pave_') || p.m === 'concrete');
  const boxes = roads.map((p) => {
    const xs = p.p[0].map((q) => q[0]);
    const zs = p.p[0].map((q) => q[1]);
    return [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
  });
  const paved = (x: number, z: number) => roads.some((p, i) => {
    const b = boxes[i];
    return x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3] && inRing(p.p[0] as Pt[], x, z);
  });
  const out: { s: Seg; quiet: boolean; out: Pt }[] = [];
  for (const ring of rings) {
    // Turned which way: outward is to the right of a counter-clockwise ring in x, z.
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
    const sign = area > 0 ? 1 : -1;
    for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i];
      const [bx, bz] = ring[(i + 1) % ring.length];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.01) continue;
      const n = Math.max(1, Math.round(len));
      const o: Pt = [(sign * (bz - az)) / len, (sign * -(bx - ax)) / len];
      for (let k = 0; k < n; k++) {
        const s: Seg = { ax: ax + ((bx - ax) * k) / n, az: az + ((bz - az) * k) / n, bx: ax + ((bx - ax) * (k + 1)) / n, bz: az + ((bz - az) * (k + 1)) / n };
        const mx = (s.ax + s.bx) / 2;
        const mz = (s.az + s.bz) / 2;
        // Which side is out: the one off the paving.
        let out1 = o;
        if (rings.some((r) => inRing(r, mx + o[0] * 0.3, mz + o[1] * 0.3))) out1 = [-o[0], -o[1]];
        const quiet = !paved(mx + out1[0] * 0.6, mz + out1[1] * 0.6);
        out.push({ s, quiet, out: out1 });
      }
    }
  }
  return out;
}

/** Where the iron goes and the tufts grow, decided with the mask. */
interface Spot {
  x: number;
  z: number;
  /** Turned (radians) */
  a: number;
  kind: 'manhole' | 'gully' | 'lid' | 'grate';
}

export interface PavingPlan {
  mask: THREE.DataTexture;
  area: THREE.Vector4;
  covers: Spot[];
  tufts: { x: number; z: number; big: number; seed: number }[];
  /** The paving's height over the relief (its prisms' top) */
  lift: number;
}

/** Everything about the square worked out from the data, between frames (`between`). */
export async function planPaving(prisms: Prism[], between: () => Promise<unknown>): Promise<PavingPlan | null> {
  const paving = prisms.filter((p) => p.m === 'pave_grey');
  if (!paving.length || OFF) return null;
  const rings = paving.map((p) => p.p[0] as Pt[]);
  const xs = rings.flat().map((q) => q[0]);
  const zs = rings.flat().map((q) => q[1]);
  const x0 = Math.min(...xs) - 1;
  const z0 = Math.min(...zs) - 1;
  const mask = new Mask(x0, z0, PHONE ? 0.25 : 0.125, Math.max(...xs) + 1 - x0, Math.max(...zs) + 1 - z0, rings);
  mask.fill();
  const rnd = seeded(40961);
  const [WEAR, OIL, SPILL, QUIET] = [0, 1, 2, 3];
  const streets = streetSegs(mask);
  const parked = bays(mask, streets);
  const sides = edges(rings, prisms);
  await between();

  // Wheel tracks: a lane each way 1.5 m either side of the centre line, two wheels 0.75 m either side of each lane's
  // middle; a softer, wider polish over the whole carriageway.
  for (const s of streets) {
    const len = Math.hypot(s.bx - s.ax, s.bz - s.az) || 1;
    const nx = -(s.bz - s.az) / len;
    const nz = (s.bx - s.ax) / len;
    mask.seg(WEAR, s, 3.5, (d) => 0.32 * (1 - smooth01(1.2, 3.5, d)));
    for (const o of [-2.25, -0.75, 0.75, 2.25]) {
      const t = { ax: s.ax + nx * o, az: s.az + nz * o, bx: s.bx + nx * o, bz: s.bz + nz * o };
      mask.seg(WEAR, t, 0.45, (d) => 0.75 * (1 - smooth01(0.08, 0.45, d)));
    }
  }
  await between();
  // Into the bays: the wheels' tracks from the aisle to where they stop, and oil under the engine (nose in: at the
  // closed end) in most of them, as drips round a darker middle and an older, fainter ring.
  for (const b of parked) {
    const len = Math.hypot(b.closed[0] - b.open[0], b.closed[1] - b.open[1]) || 1;
    const ux = (b.closed[0] - b.open[0]) / len;
    const uz = (b.closed[1] - b.open[1]) / len;
    for (const o of [-0.78, 0.78]) {
      const ox = b.across[0] * o;
      const oz = b.across[1] * o;
      mask.seg(WEAR, { ax: b.open[0] - ux * 3 + ox, az: b.open[1] - uz * 3 + oz, bx: b.closed[0] - ux * 0.9 + ox, bz: b.closed[1] - uz * 0.9 + oz }, 0.4, (d) => 0.5 * (1 - smooth01(0.08, 0.4, d)));
    }
    if (rnd() < 0.25) continue; // a clean one
    const cx = b.closed[0] - ux * (1.0 + 0.3 * rnd()) + b.across[0] * (rnd() - 0.5) * 0.3;
    const cz = b.closed[1] - uz * (1.0 + 0.3 * rnd()) + b.across[1] * (rnd() - 0.5) * 0.3;
    const strength = 0.45 + 0.5 * rnd();
    mask.blob(OIL, cx, cz, 0.6 + 0.3 * rnd(), 0.4 * strength, [ux, uz], 1.4);
    mask.blob(OIL, cx, cz, 0.3 + 0.18 * rnd(), strength);
    for (let k = 0, n = 2 + Math.floor(rnd() * 5); k < n; k++) {
      const a = rnd() * Math.PI * 2;
      const r = 0.15 + 0.4 * rnd();
      mask.blob(OIL, cx + Math.cos(a) * r, cz + Math.sin(a) * r, 0.05 + 0.08 * rnd(), strength * (0.6 + 0.4 * rnd()));
    }
  }
  // The odd drip where cars wait down the streets.
  for (const s of streets) {
    const len = Math.hypot(s.bx - s.ax, s.bz - s.az);
    for (let d = 3 + 9 * rnd(); d < len; d += 6 + 14 * rnd()) {
      const t = d / len;
      const o = (rnd() < 0.5 ? -1.5 : 1.5) + (rnd() - 0.5) * 0.4;
      const nx = -(s.bz - s.az) / len;
      const nz = (s.bx - s.ax) / len;
      mask.blob(OIL, s.ax + (s.bx - s.ax) * t + nx * o, s.az + (s.bz - s.az) * t + nz * o, 0.1 + 0.18 * rnd(), 0.35 + 0.35 * rnd());
    }
  }
  await between();

  // Along walls, beds and the grass: nobody walks within a foot or so, so that is where weeds and grime keep; a
  // metre or two further in people walk along the fronts.
  for (const e of sides) {
    if (!e.quiet) continue;
    mask.seg(QUIET, e.s, 1.1, (d) => 1 - smooth01(0.1, 1.1, d), 'max');
    mask.seg(WEAR, e.s, 2.6, (d) => 0.3 * smooth01(0.6, 1.2, d) * (1 - smooth01(1.8, 2.6, d)));
  }
  await between();

  // A few darker spills over the square, each a cluster of blobs.
  const onPaving: Pt[] = [];
  for (let tries = 0; onPaving.length < 14 && tries < 400; tries++) {
    const x = x0 + rnd() * mask.w * mask.res;
    const z = z0 + rnd() * mask.h * mask.res;
    if (mask.on(x, z)) onPaving.push([x, z]);
  }
  for (const [x, z] of onPaving) {
    const v = 0.35 + 0.45 * rnd();
    for (let k = 0, n = 3 + Math.floor(rnd() * 4); k < n; k++) {
      const a = rnd() * Math.PI * 2;
      mask.blob(SPILL, x + Math.cos(a) * rnd() * 0.7, z + Math.sin(a) * rnd() * 0.7, 0.25 + 0.6 * rnd(), v * (0.6 + 0.4 * rnd()), [Math.cos(a), Math.sin(a)], 1 + rnd());
    }
  }
  // The quiet spots in patches (weeds don't come up in a ruled band), and none where the wheels and feet go.
  const patchy = noiseChannel([[9, 0.7], [23, 0.3]], 977);
  const q = mask.ch[QUIET];
  const wear = mask.ch[WEAR];
  for (let j = 0; j < mask.h; j++) {
    for (let i = 0; i < mask.w; i++) {
      const k = j * mask.w + i;
      if (!q[k]) continue;
      // The patch noise laid 60 m across.
      const x = mask.x0 + (i + 0.5) * mask.res;
      const z = mask.z0 + (j + 0.5) * mask.res;
      const ni = Math.floor((((x / 60) % 1) + 1) % 1 * NOISE_SIZE);
      const nj = Math.floor((((z / 60) % 1) + 1) % 1 * NOISE_SIZE);
      q[k] *= smooth01(0.3, 0.7, patchy[nj * NOISE_SIZE + ni]) * (1 - Math.min(1, wear[k] * 1.6));
    }
  }
  await between();

  // The iron. Manhole covers down the streets every 30 to 40 m; gullies at the low points of the carriageway's sides;
  // a grate in each hollow of the open square; small lids by the fronts.
  const covers: Spot[] = [];
  const inBay = (x: number, z: number) => parked.some((b) => inRing(b.ring, x, z));
  const free = (x: number, z: number, r: number) =>
    mask.on(x, z) && !inBay(x, z) && !parked.some((b) => b.ring.some(([bx, bz]) => Math.hypot(bx - x, bz - z) < 1)) && covers.every((c) => Math.hypot(c.x - x, c.z - z) > r) && clearOfEdge(x, z, 0.5);
  const clearOfEdge = (x: number, z: number, m: number) => [[m, 0], [-m, 0], [0, m], [0, -m]].every(([dx, dz]) => mask.on(x + dx, z + dz));
  for (const s of streets) {
    const len = Math.hypot(s.bx - s.ax, s.bz - s.az);
    const ux = (s.bx - s.ax) / (len || 1);
    const uz = (s.bz - s.az) / (len || 1);
    const angle = Math.atan2(uz, ux);
    for (let d = 8 + 10 * rnd(); d < len - 4; d += 30 + 10 * rnd()) {
      const o = (rnd() - 0.5) * 0.6;
      const x = s.ax + ux * d - uz * o;
      const z = s.az + uz * d + ux * o;
      if (free(x, z, 6)) covers.push({ x, z, a: rnd() * Math.PI, kind: 'manhole' });
    }
    for (const side of [-1, 1]) {
      for (let w0 = 0; w0 < len; w0 += 18) {
        let best: { x: number; z: number; y: number } | null = null;
        for (let d = w0; d < Math.min(len, w0 + 18); d += 1) {
          const x = s.ax + ux * d - uz * 3.1 * side;
          const z = s.az + uz * d + ux * 3.1 * side;
          if (!mask.on(x, z)) continue;
          const y = terrain.height(x, z);
          if (!best || y < best.y) best = { x, z, y };
        }
        if (best && free(best.x, best.z, 8)) covers.push({ x: best.x, z: best.z, a: angle, kind: 'gully' });
      }
    }
  }
  // Hollows in the open: lower than everything within 7 m, and not by a street's gully.
  for (let z = z0 + 2; z < z0 + mask.h * mask.res - 2; z += 2) {
    for (let x = x0 + 2; x < x0 + mask.w * mask.res - 2; x += 2) {
      if (!mask.on(x, z) || !clearOfEdge(x, z, 2)) continue;
      const y = terrain.height(x, z);
      let lowest = true;
      for (let a = 0; a < 12 && lowest; a++) {
        for (const r of [3, 7]) if (terrain.height(x + Math.cos((a / 12) * Math.PI * 2) * r, z + Math.sin((a / 12) * Math.PI * 2) * r) < y - 0.005) lowest = false;
      }
      if (lowest && free(x, z, 10)) covers.push({ x, z, a: 0, kind: 'grate' });
    }
  }
  // Lids by the fronts: water and gas connections, a metre from the wall.
  for (const e of sides) {
    if (!e.quiet || rnd() > 0.07) continue;
    const t = rnd();
    const x = e.s.ax + (e.s.bx - e.s.ax) * t - e.out[0] * (0.7 + 0.5 * rnd());
    const z = e.s.az + (e.s.bz - e.s.az) * t - e.out[1] * (0.7 + 0.5 * rnd());
    if (mask.on(x, z) && !inBay(x, z) && covers.every((c) => Math.hypot(c.x - x, c.z - z) > 7)) covers.push({ x, z, a: Math.atan2(e.out[1], e.out[0]), kind: 'lid' });
  }
  await between();

  // Tufts: along the quiet edges, a hand to a foot in, where the mask's quiet patches are.
  const tufts: PavingPlan['tufts'] = [];
  for (const e of sides) {
    if (!e.quiet) continue;
    for (let k = 0; k < 5; k++) {
      const t = rnd();
      const inset = 0.04 + 0.32 * rnd() * rnd();
      const x = e.s.ax + (e.s.bx - e.s.ax) * t - e.out[0] * inset;
      const z = e.s.az + (e.s.bz - e.s.az) * t - e.out[1] * inset;
      const quiet = mask.at(QUIET, x - e.out[0] * 0.1, z - e.out[1] * 0.1);
      if (quiet < 0.2 || rnd() > quiet * 0.75 || inBay(x, z) || covers.some((c) => Math.hypot(c.x - x, c.z - z) < 0.6)) continue;
      tufts.push({ x, z, big: quiet, seed: Math.floor(rnd() * 1e9) });
    }
  }
  return { mask: mask.texture(), area: new THREE.Vector4(x0, z0, 1 / (mask.w * mask.res), 1 / (mask.h * mask.res)), covers, tufts, lift: paving[0].y1 };
}

/** The mask on the paving's materials from now on. */
export function usePavingPlan(plan: PavingPlan): void {
  uniforms.paveMask.value = plan.mask;
  uniforms.paveArea.value.copy(plan.area);
}

// ---------------------------------------------------------------- the iron and the tufts, as meshes

/** Atlas cells (u0, v0) of 0.5 each: the round cover, the gully's grate, the small lid, the square grate. */
const CELL: Record<Spot['kind'], [number, number]> = { manhole: [0, 0], gully: [0.5, 0], lid: [0, 0.5], grate: [0.5, 0.5] };
/** Metres: each kind's size (round: diameter; else along, across) */
const SIZE: Record<Spot['kind'], [number, number]> = { manhole: [0.7, 0.7], gully: [0.6, 0.42], lid: [0.34, 0.34], grate: [0.5, 0.5] };

/** The cast iron, drawn once into a canvas: colour, and a height for the bumps (white is up). */
function ironAtlas(): { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  const S = 512;
  const c = document.createElement('canvas');
  const h = document.createElement('canvas');
  c.width = c.height = h.width = h.height = S;
  const g = c.getContext('2d')!;
  const b = h.getContext('2d')!;
  const rnd = seeded(2203);
  const both = (draw: (x: CanvasRenderingContext2D, colour: boolean) => void) => {
    draw(g, true);
    draw(b, false);
  };
  // Concrete round everything (the frame's bed), then each cell.
  g.fillStyle = '#86837c';
  g.fillRect(0, 0, S, S);
  b.fillStyle = '#808080';
  b.fillRect(0, 0, S, S);
  const iron = '#34312e';
  const worn = '#5b5752';
  const rust = '#4a3426';
  // Round cover (cell 0, 0; in the canvas the top left, as its rows go down): a ring frame, a cover of raised studs.
  both((x, colour) => {
    const cx = 128;
    const cy = 128;
    x.fillStyle = colour ? '#4a4642' : '#a0a0a0';
    x.beginPath();
    x.arc(cx, cy, 126, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = colour ? '#141210' : '#202020';
    x.beginPath();
    x.arc(cx, cy, 112, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = colour ? iron : '#707070';
    x.beginPath();
    x.arc(cx, cy, 109, 0, Math.PI * 2);
    x.fill();
    // Studs on a square grid, cut by the rim.
    for (let i = -6; i <= 6; i++) {
      for (let j = -6; j <= 6; j++) {
        const px = cx + i * 15;
        const py = cy + j * 15;
        if (Math.hypot(px - cx, py - cy) > 98) continue;
        x.fillStyle = colour ? (rnd() < 0.5 ? worn : '#55514c') : '#d0d0d0';
        x.fillRect(px - 4.5, py - 4.5, 9, 9);
      }
    }
    // Two lifting holes.
    x.fillStyle = colour ? '#0c0b0a' : '#000000';
    for (const s of [-1, 1]) x.fillRect(cx + s * 70 - 6, cy - 3, 12, 6);
  });
  // The gully (cell 0.5, 0): a frame, its grate's bars across, the slots between dark.
  both((x, colour) => {
    const x0 = 256 + 14;
    const y0 = 14 + 26;
    const w = 228;
    const hh = 228 - 52;
    x.fillStyle = colour ? '#2e2620' : '#a0a0a0';
    x.fillRect(x0, y0, w, hh);
    x.fillStyle = colour ? '#0b0907' : '#000000';
    x.fillRect(x0 + 14, y0 + 14, w - 28, hh - 28);
    for (let k = 0; k < 9; k++) {
      x.fillStyle = colour ? (k % 2 ? '#3d3027' : rust) : '#c0c0c0';
      x.fillRect(x0 + 14 + k * ((w - 28) / 9) + 9, y0 + 14, 9, hh - 28);
    }
    x.fillStyle = colour ? '#3a2e25' : '#b0b0b0';
    x.fillRect(x0 + 14, y0 + hh / 2 - 5, w - 28, 10);
  });
  // The small lid (cell 0, 0.5): diamond tread.
  both((x, colour) => {
    const x0 = 22;
    const y0 = 256 + 22;
    x.fillStyle = colour ? '#45413d' : '#a0a0a0';
    x.fillRect(x0, y0, 212, 212);
    x.fillStyle = colour ? '#111' : '#202020';
    x.fillRect(x0 + 16, y0 + 16, 180, 180);
    x.fillStyle = colour ? iron : '#707070';
    x.fillRect(x0 + 19, y0 + 19, 174, 174);
    x.save();
    x.beginPath();
    x.rect(x0 + 24, y0 + 24, 164, 164);
    x.clip();
    for (let i = -8; i < 16; i++) {
      for (let j = 0; j < 16; j++) {
        const px = x0 + 24 + i * 14 + (j % 2) * 7;
        const py = y0 + 24 + j * 12;
        x.fillStyle = colour ? (rnd() < 0.6 ? worn : '#4c4844') : '#d0d0d0';
        x.beginPath();
        x.moveTo(px, py - 4);
        x.lineTo(px + 6, py);
        x.lineTo(px, py + 4);
        x.lineTo(px - 6, py);
        x.fill();
      }
    }
    x.restore();
  });
  // The square grate (cell 0.5, 0.5): a grid of square holes.
  both((x, colour) => {
    const x0 = 256 + 16;
    const y0 = 256 + 16;
    x.fillStyle = colour ? '#2f2722' : '#a8a8a8';
    x.fillRect(x0, y0, 224, 224);
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        x.fillStyle = colour ? '#090807' : '#000000';
        x.fillRect(x0 + 18 + i * 24.5, y0 + 18 + j * 24.5, 16, 16);
      }
    }
  });
  // Rust and grime in a light speckle over the colour.
  for (let k = 0; k < 2500; k++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(90,60,40,0.18)' : 'rgba(20,18,16,0.18)';
    g.fillRect(rnd() * S, rnd() * S, 2 + rnd() * 5, 2 + rnd() * 5);
  }
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  const bump = new THREE.CanvasTexture(h);
  return { map, bump };
}

/** One tuft: thin blades of grass, or a flat rosette of leaves (a dandelion or plantain), as triangles. */
function tuft(t: PavingPlan['tufts'][number], y: number, pos: number[], col: number[], idx: number[]): void {
  const rnd = seeded(t.seed % 2147483646 || 1);
  const green = (k: number) => {
    // Late in the year: some blades yellowing.
    const dry = rnd() < 0.25 ? 0.5 + 0.5 * rnd() : 0;
    const base: [number, number, number] = [0.09 + 0.04 * rnd(), 0.13 + 0.05 * rnd(), 0.035 + 0.02 * rnd()];
    const tip: [number, number, number] = [0.24 + 0.2 * dry + 0.06 * rnd(), 0.32 + 0.06 * dry + 0.08 * rnd(), 0.07 + 0.03 * rnd()];
    return k === 0 ? base : tip;
  };
  const vert = (x: number, yy: number, z: number, c: [number, number, number]) => {
    pos.push(x, yy, z);
    col.push(...c);
    return pos.length / 3 - 1;
  };
  if (rnd() < 0.3) {
    // A rosette: leaves lying out from the middle, a little raised.
    const n = 5 + Math.floor(rnd() * 4);
    const a0 = rnd() * Math.PI * 2;
    const dark: [number, number, number] = [0.07, 0.12, 0.035];
    for (let k = 0; k < n; k++) {
      const a = a0 + (k / n) * Math.PI * 2 + (rnd() - 0.5) * 0.4;
      const len = (0.07 + 0.07 * rnd()) * (0.6 + 0.6 * t.big);
      const wid = 0.016 + 0.014 * rnd();
      const rise = len * (0.15 + 0.35 * rnd());
      const ux = Math.cos(a);
      const uz = Math.sin(a);
      const leaf: [number, number, number] = [0.13 + 0.05 * rnd(), 0.24 + 0.08 * rnd(), 0.06 + 0.03 * rnd()];
      const v0 = vert(t.x, y + 0.004, t.z, dark);
      const v1 = vert(t.x + ux * len * 0.45 - uz * wid, y + rise * 0.6, t.z + uz * len * 0.45 + ux * wid, leaf);
      const v2 = vert(t.x + ux * len, y + rise, t.z + uz * len, leaf);
      const v3 = vert(t.x + ux * len * 0.45 + uz * wid, y + rise * 0.6, t.z + uz * len * 0.45 - ux * wid, leaf);
      idx.push(v0, v1, v2, v0, v2, v3);
    }
    return;
  }
  const n = 9 + Math.floor(rnd() * 12 * (0.5 + t.big));
  for (let k = 0; k < n; k++) {
    const fx = t.x + (rnd() - 0.5) * 0.07;
    const fz = t.z + (rnd() - 0.5) * 0.07;
    const a = rnd() * Math.PI * 2;
    const h = (0.06 + 0.12 * rnd()) * (0.6 + 0.6 * t.big);
    const w = 0.005 + 0.004 * rnd();
    const lean = h * (0.15 + 0.5 * rnd());
    const la = rnd() * Math.PI * 2;
    const lx = Math.cos(la) * lean;
    const lz = Math.sin(la) * lean;
    const px = -Math.sin(a) * w;
    const pz = Math.cos(a) * w;
    const [c0, c1] = [green(0), green(1)];
    const mid: [number, number, number] = [(c0[0] + c1[0]) / 2, (c0[1] + c1[1]) / 2, (c0[2] + c1[2]) / 2];
    const a0 = vert(fx - px, y, fz - pz, c0);
    const a1 = vert(fx + px, y, fz + pz, c0);
    const b0 = vert(fx - px * 0.7 + lx * 0.3, y + h * 0.55, fz - pz * 0.7 + lz * 0.3, mid);
    const b1 = vert(fx + px * 0.7 + lx * 0.3, y + h * 0.55, fz + pz * 0.7 + lz * 0.3, mid);
    const tip = vert(fx + lx, y + h, fz + lz, c1);
    idx.push(a0, a1, b1, a0, b1, b0, b0, b1, tip);
  }
}

/**
 * The square's iron and tufts as two meshes (world coordinates, one draw call each). `shade` puts the ground's
 * shading on their materials (world/groundShade.ts), so they lie in the houses' shadows as the paving does.
 */
export function pavingMeshes(plan: PavingPlan, shade: (m: THREE.MeshStandardMaterial) => void): THREE.Group {
  const group = new THREE.Group();
  group.name = 'paving_detail';
  const top = (x: number, z: number) => plan.lift + terrain.height(x, z);

  // The iron: each a flat shape (the round cover a 20-gon) lifted 6 mm, on the relief at every corner.
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (const c of plan.covers) {
    const [u0, v0] = CELL[c.kind];
    const [sa, sb] = SIZE[c.kind];
    const cos = Math.cos(c.a);
    const sin = Math.sin(c.a);
    const put = (lx: number, lz: number, u: number, v: number) => {
      const x = c.x + lx * cos - lz * sin;
      const z = c.z + lx * sin + lz * cos;
      pos.push(x, top(x, z) + 0.006, z);
      uv.push(u0 + u * 0.5, 1 - (v0 + v * 0.5));
      return pos.length / 3 - 1;
    };
    if (c.kind === 'manhole') {
      const mid = put(0, 0, 0.5, 0.5);
      const ring = Array.from({ length: 20 }, (_, i) => {
        const a = (i / 20) * Math.PI * 2;
        return put((Math.cos(a) * sa) / 2, (Math.sin(a) * sa) / 2, 0.5 + Math.cos(a) * 0.5 * (126 / 128), 0.5 + Math.sin(a) * 0.5 * (126 / 128));
      });
      for (let i = 0; i < 20; i++) idx.push(mid, ring[(i + 1) % 20], ring[i]);
      continue;
    }
    // The atlas cell holds the shape in a margin of concrete; the gully's is wider than deep.
    const m = c.kind === 'gully' ? [0.02, 0.1] : c.kind === 'lid' ? [0.06, 0.06] : [0.04, 0.04];
    const q = [put(-sa / 2, -sb / 2, m[0], m[1]), put(sa / 2, -sb / 2, 1 - m[0], m[1]), put(sa / 2, sb / 2, 1 - m[0], 1 - m[1]), put(-sa / 2, sb / 2, m[0], 1 - m[1])];
    idx.push(q[0], q[2], q[1], q[0], q[3], q[2]);
  }
  if (idx.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const { map, bump } = ironAtlas();
    const material = new THREE.MeshStandardMaterial({ map, bumpMap: bump, bumpScale: 1.5, roughness: 0.62, metalness: 0.35, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    material.name = 'paving_iron';
    shade(material);
    const mesh = new THREE.Mesh(g, material);
    mesh.name = 'paving_iron';
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // The tufts.
  const tp: number[] = [];
  const tc: number[] = [];
  const ti: number[] = [];
  for (const t of plan.tufts) tuft(t, top(t.x, t.z), tp, tc, ti);
  if (ti.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(tp, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(tc, 3));
    // Lit as the ground at their foot: their normals straight up.
    const up = new Float32Array(tp.length);
    for (let i = 1; i < up.length; i += 3) up[i] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(up, 3));
    g.setIndex(ti);
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide });
    material.name = 'paving_weeds';
    shade(material);
    const mesh = new THREE.Mesh(g, material);
    mesh.name = 'paving_weeds';
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
