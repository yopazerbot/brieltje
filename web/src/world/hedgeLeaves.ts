import * as THREE from 'three';

/**
 * The face of the clipped hedges: small leaves packed in layers, painted here in code when the game starts (nothing
 * to download, about a tenth of a second), on every preset and on phones. A colour picture and a relief picture (a
 * normal map), 512 px for HEDGE_TILE metres, so a leaf is 3 to 5 cm long, as on privet, hornbeam or beech clipped
 * close. They took over from a photo of a forest floor (twigs and fallen leaves of 30 to 50 cm on a hedge's face).
 *
 * The leaves grow in sprigs and are laid on from the inside out: the first ones deep in the hedge, in its shade, the
 * last ones at its face in full light. Between the outer sprigs the deeper, darker leaves show, and here and there a
 * gap reaches the dark twigs inside: the face has depth instead of being a flat picture. Each leaf is turned its own
 * way and folded along its rib, which the relief picture carries, so the sun catches some leaves and not others.
 *
 * The colour's average is TARGET, as bright as the old photo's and a little greener (each hedge's tint, in
 * world/houseMeshes.ts and the street models, multiplies it): seen from afar a hedge keeps its brightness.
 */

/** How far one copy of the pictures reaches, in metres. */
export const HEDGE_TILE = 0.6;
/** How rough the leaves are, all over (no roughness picture): a little gloss where the sun catches them. */
export const HEDGE_ROUGH = 0.8;
const N = 512;
/** The pictures' average colour (linear): as bright as the forest-floor photo the hedges had, a little greener. */
const TARGET: [number, number, number] = [0.24, 0.185, 0.052];

let made: { color: THREE.DataTexture; normal: THREE.DataTexture } | null = null;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/** Oval, a little broader below the middle, with a short point: privet, hornbeam, beech. */
const outline = (u: number) => Math.sqrt(Math.max(0, 1 - u * u)) * (1.04 - 0.22 * u) * (1 - 0.3 * Math.pow(Math.max(0, u), 4));

function paint(): { color: Uint8Array; normal: Uint8Array } {
  let s = 61031;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const r = new Float32Array(N * N);
  const g = new Float32Array(N * N);
  const b = new Float32Array(N * N);
  const nx = new Float32Array(N * N);
  const ny = new Float32Array(N * N);
  // Deep inside: dark, the brown of old twigs and dead leaves.
  r.fill(0.05);
  g.fill(0.035);
  b.fill(0.018);
  const at = (x: number, y: number) => (((y % N) + N) % N) * N + (((x % N) + N) % N);
  const put = (k: number, cover: number, cr: number, cg: number, cb: number, ux: number, uy: number) => {
    r[k] += (cr - r[k]) * cover;
    g[k] += (cg - g[k]) * cover;
    b[k] += (cb - b[k]) * cover;
    nx[k] += (ux - nx[k]) * cover;
    ny[k] += (uy - ny[k]) * cover;
  };
  // A few twigs deep inside, seen through the gaps.
  for (let i = 0; i < 70; i++) {
    const x0 = rand() * N;
    const y0 = rand() * N;
    const a = rand() * Math.PI * 2;
    const len = 40 + rand() * 120;
    const w = 1.2 + rand() * 1.6;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const lit = 0.06 + rand() * 0.04;
    const x1 = x0 + ca * len;
    const y1 = y0 + sa * len;
    for (let y = Math.floor(Math.min(y0, y1) - 3); y <= Math.ceil(Math.max(y0, y1) + 3); y++) {
      for (let x = Math.floor(Math.min(x0, x1) - 3); x <= Math.ceil(Math.max(x0, x1) + 3); x++) {
        const t = clamp01(((x - x0) * ca + (y - y0) * sa) / len);
        const d = Math.hypot(x - (x0 + ca * len * t), y - (y0 + sa * len * t));
        const cover = clamp01(w / 2 - d + 0.5);
        if (cover > 0) put(at(x, y), cover, lit * 1.15, lit * 0.9, lit * 0.6, 0, 0);
      }
    }
  }
  // The leaves grow in sprigs: clusters round a shoot's tip, some reaching to the face, some staying deeper. Each
  // leaf's depth is its sprig's reach and its own place in it; they are laid on from deep to the face.
  const leaves: [number, number, number][] = [];
  const SPRIGS = 150;
  for (let c = 0; c < SPRIGS; c++) {
    const sx = rand() * N;
    const sy = rand() * N;
    const reach = rand();
    const n = 7 + Math.floor(rand() * 7);
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand()) * 34;
      // The middle of a sprig stands out furthest.
      leaves.push([sx + Math.cos(a) * d, sy + Math.sin(a) * d, reach * 0.6 + (1 - d / 34) * 0.25 + rand() * 0.15]);
    }
  }
  for (let i = 0; i < 300; i++) leaves.push([rand() * N, rand() * N, rand() * 0.7]);
  leaves.sort((p, q) => p[2] - q[2]);
  for (const [cx, cy, depth] of leaves) {
    // In the hedge's shade deep down, in the open at its face.
    const light = 0.08 + 0.92 * Math.pow(depth, 2);
    const len = 26 + rand() * 20;
    // Narrower where it is turned away from the eye.
    const wide = len * (0.44 + rand() * 0.14) * (0.45 + 0.55 * Math.sqrt(rand()));
    const a = rand() * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    // How the leaf is turned: tilted up to about 25 degrees, a little more often upwards and out than down.
    const tilt = 0.08 + rand() * 0.35;
    const dir = rand() * Math.PI * 2;
    const tx = Math.sin(tilt) * Math.cos(dir);
    const ty = Math.sin(tilt) * Math.sin(dir) + 0.08;
    // Its own green: some yellower, some bluer, an odd one browner.
    const hue = rand();
    const yellow = (rand() - 0.45) * 0.25 + (hue > 0.95 ? 0.3 : 0);
    const shade = light * (0.85 + rand() * 0.3);
    const cr = shade * 0.27 * (1 + yellow);
    const cg = shade * 0.18 * (1 + yellow * 0.25);
    const cb = shade * 0.054 * (1 - yellow * 0.6);
    const half = len / 2;
    const reach = Math.ceil(half + 2);
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const u = (dx * ca + dy * sa) / half;
        if (u <= -1 || u >= 1) continue;
        const v = dy * ca - dx * sa;
        const edge = outline(u) * (wide / 2);
        const cover = clamp01(edge - Math.abs(v) + 0.5);
        if (cover <= 0) continue;
        const across = Math.max(-1, Math.min(1, v / Math.max(edge, 0.5))); // -1 to 1
        // Folded along the rib and curled at the edges: each half of the leaf faces a little away from the other.
        const fold = 0.14 * Math.sign(across) + 0.14 * across;
        const ux = tx + -sa * fold + ca * u * 0.08;
        const uy = ty + ca * fold + sa * u * 0.08;
        // A shade darker at the edge and lighter along the rib.
        const tone = (0.86 + 0.14 * Math.sqrt(1 - Math.abs(across))) * (Math.abs(v) < 0.8 ? 1.1 : 1);
        put(at(Math.round(cx) + dx, Math.round(cy) + dy), cover, cr * tone, cg * tone, cb * tone, ux, uy);
      }
    }
  }
  // Brought to the average colour TARGET.
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let k = 0; k < N * N; k++) {
    sr += r[k];
    sg += g[k];
    sb += b[k];
  }
  const kr = (TARGET[0] * N * N) / sr;
  const kg = (TARGET[1] * N * N) / sg;
  const kb = (TARGET[2] * N * N) / sb;
  const color = new Uint8Array(N * N * 4);
  const normal = new Uint8Array(N * N * 4);
  for (let k = 0; k < N * N; k++) {
    color[k * 4] = Math.round(toSrgb(clamp01(r[k] * kr)) * 255);
    color[k * 4 + 1] = Math.round(toSrgb(clamp01(g[k] * kg)) * 255);
    color[k * 4 + 2] = Math.round(toSrgb(clamp01(b[k] * kb)) * 255);
    color[k * 4 + 3] = 255;
    const x = nx[k];
    const y = ny[k];
    const z = Math.sqrt(Math.max(0.05, 1 - x * x - y * y));
    const l = Math.hypot(x, y, z);
    normal[k * 4] = Math.round((0.5 + (0.5 * x) / l) * 255);
    normal[k * 4 + 1] = Math.round((0.5 + (0.5 * y) / l) * 255);
    normal[k * 4 + 2] = Math.round((0.5 + (0.5 * z) / l) * 255);
    normal[k * 4 + 3] = 255;
  }
  return { color, normal };
}

function texture(data: Uint8Array, space: THREE.ColorSpace): THREE.DataTexture {
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = space;
  t.needsUpdate = true;
  return t;
}

/** The hedges' colour or relief picture, painted on first use (some tens of milliseconds). */
export function hedgeTexture(kind: 'color' | 'normal'): THREE.DataTexture {
  if (!made) {
    const { color, normal } = paint();
    made = { color: texture(color, THREE.SRGBColorSpace), normal: texture(normal, THREE.NoColorSpace) };
  }
  return made[kind];
}

/** The pictures' average colour (linear), what a hedge's colour is multiplied by on average (world/hedgeCards.ts). */
export const hedgeMean = (): [number, number, number] => [...TARGET];
