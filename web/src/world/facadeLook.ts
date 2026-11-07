import * as THREE from 'three';
import type { Prism } from './houseData';

/**
 * Each open-data house its own look (world/surroundings.ts builds them): the shade of its brick within
 * its kind, some white and buff houses rendered in cream instead of bare brick, its roof covering, and
 * now and then dark green window frames. The open data gives only outlines and heights, so this is made
 * up, fixed by where the house stands: every player sees the same, and nothing is a real house's colour.
 *
 * All of it rides on the vertices of the geometry the tiles already merge (a colour, a byte for render,
 * a byte for glaze), so the walls stay one draw call per tile and the roofs another, as before.
 */

/** A number from 0 to 1 that depends only on the numbers given. */
export function stable(...v: number[]): number {
  let h = 2166136261;
  for (const x of v) h = Math.imul(h ^ Math.round(x * 1000), 16777619) ^ (h >>> 13);
  return ((h >>> 0) % 100003) / 100003;
}

/** The neighbours' bricks (houseMeshes.ts's nb_ family), the walls of a house. */
const BRICK = /^nb_(red|brown|yellow|white|grey|dark)$/;
export const isBrick = (m: string): boolean => BRICK.test(m);

/**
 * Shades of each brick within its kind (sRGB, for the generated brick texture), as Flemish streets have
 * them: red, orange-red, deep red and purple-brown reds; brown and red-brown; yellow and buff; white-painted.
 */
const SHADES: Record<string, string[]> = {
  nb_red: ['#b5644c', '#c0714f', '#a4523e', '#94503f', '#b86a55', '#9c4c3c'],
  nb_brown: ['#8e5a44', '#7a4c3b', '#9a6549', '#6f4a3e', '#85543f'],
  nb_yellow: ['#d4b88f', '#c9a66f', '#dcc39c', '#c2a27e', '#d0ad7c'],
  nb_white: ['#f2eee6', '#ece6da', '#f4f1ea'],
  nb_grey: ['#a39c93', '#8f8a85', '#b0a99f', '#9a958e'],
  nb_dark: ['#4b4a49', '#3f3e3e'],
};
/** Cream and off-white render (sRGB). */
const RENDER = ['#efe4cb', '#f2ecdf', '#e9dcc0', '#f4efe4'];

export interface BrickLook {
  tint: THREE.Color;
  /** Rendered (1) or bare brick (0) */
  render: number;
}

/** A house's walls: `m` its brick in the data, `key` the house's key (a stable random 0 to 1). */
export function brickLook(m: string, key: number): BrickLook {
  const pick = (list: string[], h: number) => list[Math.floor(h * list.length) % list.length];
  // About two in five white houses and one in eight yellow ones are rendered rather than bare brick.
  const render = (m === 'nb_white' && key < 0.4) || (m === 'nb_yellow' && key < 0.12) ? 1 : 0;
  const tint = new THREE.Color(render ? pick(RENDER, stable(key, 3)) : pick(SHADES[m] ?? SHADES.nb_red, stable(key, 5)));
  tint.multiplyScalar(0.94 + 0.12 * stable(key, 7)); // and a little lighter or darker, house by house
  return { tint, render };
}

/**
 * A roof's covering from its colour on the aerial photo (`photo`, sRGB) and its house's key: whether it
 * is light, dark or reddish there decides the kind, the key which one of that kind. Dark roofs: anthracite
 * tiles or black glazed ones; mid grey: grey tiles, a few slate; reddish: terracotta and red-brown; light and
 * a little warm: half of them faded red-brown. `gloss`: 1 for glazed tiles and slate, 0 for matt.
 */
export function roofLook(photo: string, key: number): { color: THREE.Color; gloss: number } {
  const c = new THREE.Color(photo);
  const s = c.clone().convertLinearToSRGB();
  const light = (s.r + s.g + s.b) / 3;
  const warm = s.r - s.b;
  const k = stable(key, 11);
  const jitter = 0.92 + 0.16 * stable(key, 13);
  const of = (hex: string, gloss = 0) => ({ color: new THREE.Color(hex).multiplyScalar(jitter), gloss });
  if (warm > 0.09) return of(['#a5533a', '#b4613f', '#8c4a3a', '#9a5843'][Math.floor(k * 4)]);
  if (light < 0.25) return k < 0.45 ? of('#1e2024', 1) : of(k < 0.75 ? '#33363b' : '#2b2d31');
  if (light < 0.45) return k < 0.22 ? of('#4a5059', 0.7) : { color: c.multiplyScalar(jitter), gloss: 0 };
  if (warm > 0.03 && k < 0.5) return of(k < 0.25 ? '#9a5a48' : '#a8664e');
  return { color: c.multiplyScalar(jitter), gloss: 0 };
}

/** Window frame colour: the data's, but about one house in fourteen has dark green frames. */
export function frameColour(data: string, key: number): THREE.Color {
  return new THREE.Color(stable(key, 17) < 0.07 ? '#2f4a3a' : data);
}

/** A byte per vertex (0 to 1) under `name`, as the tiles merge them (the same type on every geometry). */
export function byteAttribute(g: THREE.BufferGeometry, name: string, value: number): THREE.BufferGeometry {
  g.setAttribute(name, new THREE.BufferAttribute(new Uint8Array(g.attributes.position.count).fill(Math.round(value * 255)), 1, true));
  return g;
}

/**
 * The houses of one tile: walls of the same brick that touch (a house's main block and its annex) are one
 * house, with one key (a stable random 0 to 1), fixed by the corner of its walls furthest west (then north).
 */
export class Houses {
  private walls: { p: Prism; ring: [number, number][]; box: [number, number, number, number] }[] = [];
  private keys = new Map<Prism, number>();

  constructor(prisms: Prism[]) {
    const own = prisms.filter((p) => isBrick(p.m));
    const parent = own.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const corner = new Map<string, number>();
    own.forEach((p, i) => {
      for (const [x, z] of p.p[0]) {
        const at = `${p.m}|${Math.round(x * 20)}|${Math.round(z * 20)}`;
        const j = corner.get(at);
        if (j === undefined) corner.set(at, i);
        else parent[find(i)] = find(j);
      }
    });
    const first = new Map<number, [number, number]>();
    own.forEach((p, i) => {
      const r = find(i);
      for (const [x, z] of p.p[0]) {
        const f = first.get(r);
        if (!f || x < f[0] - 1e-6 || (Math.abs(x - f[0]) < 1e-6 && z < f[1])) first.set(r, [x, z]);
      }
    });
    own.forEach((p, i) => {
      const [x, z] = first.get(find(i))!;
      this.keys.set(p, stable(Math.round(x * 10) / 10, Math.round(z * 10) / 10, 29));
      const xs = p.p[0].map((q) => q[0]);
      const zs = p.p[0].map((q) => q[1]);
      this.walls.push({ p, ring: p.p[0], box: [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)] });
    });
  }

  /** The key of the house a wall block belongs to. */
  keyOf(p: Prism): number {
    return this.keys.get(p) ?? stable(p.p[0][0][0], p.p[0][0][1], 29);
  }

  /** The key of the house whose walls stand round (x, z), preferring brick `m`; or one of the spot itself. */
  at(x: number, z: number, m?: string): number {
    let found: Prism | null = null;
    for (const w of this.walls) {
      if (x < w.box[0] || x > w.box[2] || z < w.box[1] || z > w.box[3] || !inside(w.ring, x, z)) continue;
      found = w.p;
      if (!m || w.p.m === m) break;
    }
    return found ? this.keyOf(found) : stable(Math.round(x), Math.round(z), 31);
  }
}

/** Whether (x, z) lies inside a ring. */
function inside(ring: [number, number][], x: number, z: number): boolean {
  let yes = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) yes = !yes;
  }
  return yes;
}

const rendered = new WeakSet<THREE.Material>();
const glazed = new WeakSet<THREE.Material>();

/**
 * The neighbours' brick material reads the render byte (`facade`): there the brick's pattern and relief
 * flatten to a smooth coat in the wall's colour. Patched once; the brick stays one material.
 */
export function renderable<T extends THREE.Material>(m: T): T {
  if (rendered.has(m)) return m;
  rendered.add(m);
  const before = m.onBeforeCompile;
  const key = m.customProgramCacheKey.bind(m);
  m.onBeforeCompile = (shader, renderer) => {
    before.call(m, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float facade;\nvarying float vFacade;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFacade = facade;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFacade;')
      .replace(
        '#include <color_fragment>',
        // The brick texture's mean (linear) is about 0.56: render keeps a trace of its mottling, not its joints.
        `#include <color_fragment>
        #if defined( USE_MAP ) && defined( USE_COLOR )
        diffuseColor.rgb = mix(diffuseColor.rgb, vColor.rgb * (0.56 + 0.12 * (dot(sampledDiffuseColor.rgb, vec3(0.3333)) - 0.56)), vFacade);
        #endif`,
      )
      .replace('#include <normal_fragment_maps>', THREE.ShaderChunk.normal_fragment_maps.replace('mapN.xy *= normalScale;', 'mapN.xy *= normalScale * (1.0 - 0.85 * vFacade);'));
  };
  m.customProgramCacheKey = () => `${key()}|render`;
  m.needsUpdate = true;
  return m;
}

/** The roof tiles' material reads the glaze byte (`gloss`): glazed tiles and slate shine. Patched once. */
export function glazeable<T extends THREE.Material>(m: T): T {
  if (glazed.has(m)) return m;
  glazed.add(m);
  const before = m.onBeforeCompile;
  const key = m.customProgramCacheKey.bind(m);
  m.onBeforeCompile = (shader, renderer) => {
    before.call(m, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float gloss;\nvarying float vGloss;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGloss = gloss;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGloss;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor *= 1.0 - 0.6 * vGloss;');
  };
  m.customProgramCacheKey = () => `${key()}|glaze`;
  m.needsUpdate = true;
  return m;
}
