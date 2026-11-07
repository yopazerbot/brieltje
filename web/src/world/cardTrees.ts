import * as THREE from 'three';

/**
 * The trees on Medium and up, by kind, built from leaf cards round real branches (world/leafCards.ts paints
 * the cards): oaks, limes and beeches with broad, lumpy crowns on a few big limbs; birches, narrow, their
 * twigs hanging; Lombardy poplars, tall narrow columns on a straight stem; spruces, a cone of drooping
 * fronds in tiers up a trunk that runs to the tip (the wood round the Sparrenhof); and fruit trees in the
 * gardens, low and wide on a short trunk.
 *
 * Each crown is made once per kind (two broad-leaved ones) in its own units, 1 across and `HEIGHT` up from
 * its middle, and every tree of that kind is a copy (an instance), turned, leaning and stretched to its size:
 * the ~4200 trees stay a few draw calls. In the tiles round the eye a crown has some 300 cards and its
 * branches show through the gaps; further off a crown has a third of that, in bigger cards (world/tiles.ts lod).
 *
 * Each card corner carries the crown's colour, darker the deeper it sits in the crown and towards its
 * underside (light comes in from outside and above), and a normal pointing out of the crown, not out of
 * the card: the light then falls on the crown as a whole, soft, lit on the sun's side.
 *
 * Where each kind grows (`treeKind`): in the wood round the Sparrenhof spruces with the odd birch; in the
 * other woods mostly broad-leaved trees with birches, poplars and a few spruces; along the roads and fields
 * the tall trees are partly poplars; in the gardens the small trees are partly fruit trees. All from the
 * tree's place, so everyone sees the same tree.
 */

/** The leaf atlas (world/leafCards.ts paints it): its size in pixels, and its four sprays, 2 x 2. */
export const ATLAS = 1024;
export const Spray = { Broad: 0, Birch: 1, Poplar: 2, Spruce: 3 } as const;
export type Spray = (typeof Spray)[keyof typeof Spray];

/** A spray's square in the atlas: u0, v0 (its corner) and its size, inset two texels so its neighbours don't bleed in. */
export function sprayRect(kind: Spray): [number, number, number] {
  const inset = 2 / ATLAS;
  return [(kind % 2) / 2 + inset, Math.floor(kind / 2) / 2 + inset, 0.5 - inset * 2];
}

/** The bark atlas's halves in u (world/leafCards.ts): furrowed bark and birch, inset from where they meet. */
export const BARK_U: Record<'bark' | 'birch', [number, number]> = { bark: [0.002, 0.498], birch: [0.502, 0.998] };

export const Kind = { Broad: 0, Birch: 1, Poplar: 2, Spruce: 3, Fruit: 4 } as const;
export type Kind = (typeof Kind)[keyof typeof Kind];
export const KINDS = 5;
/** Each kind's crown, half its height where its radius is 1. */
export const HEIGHT = [1.15, 1.7, 4, 2.6, 0.75];
/** Where the trunk meets the crown (and the trunk's own copy ends), up from the crown's middle in its units. */
export const FORK = [-0.62, -1.0, -3.5, -2.35, -0.42];
/** The trunks' shapes: furrowed bark, a poplar's grey, a spruce's red-brown, a birch's white. */
export const TRUNK_OF = [0, 3, 1, 2, 0];
export const TRUNKS = 4;

type V = THREE.Vector3;
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = v3(0, 1, 0);

class Parts {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];

  vertex(p: V, n: V, u: number, v: number, c: THREE.Color): number {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.col.push(c.r, c.g, c.b);
    return this.pos.length / 3 - 1;
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** A crown's shape for the cards' light and shade: its outward normal at a point, and how deep in it the point lies (0 middle, 1 outside). */
interface Shape {
  normal(p: V): V;
  depth(p: V): number;
}

/** An ellipsoid crown, radius 1 across and `h` up, its normals as an ellipsoid's, flattened a little towards the vertical. */
function ellipsoid(h: number, lift = 0): Shape {
  return {
    normal: (p) => v3(p.x, (p.y - lift) / (h * h), p.z).normalize().lerp(UP, 0.12).normalize(),
    depth: (p) => Math.hypot(p.x, (p.y - lift) / h, p.z),
  };
}

/** A column or cone round the vertical axis: `radius(y)` across at each height. */
function column(h: number, radius: (y: number) => number): Shape {
  return {
    normal: (p) => {
      const out = v3(p.x, 0, p.z);
      if (out.lengthSq() < 1e-6) out.set(1, 0, 0);
      out.normalize();
      // Slanting up where the column narrows upwards; tops face the sky.
      const slope = (radius(p.y - 0.05) - radius(p.y + 0.05)) / 0.1;
      return out.add(v3(0, Math.max(0, slope) * 0.8 + 0.25 + Math.max(0, p.y / h - 0.85) * 3, 0)).normalize();
    },
    depth: (p) => Math.hypot(p.x, p.z) / Math.max(0.05, radius(p.y)),
  };
}

/**
 * One card: a spray from `rect` of the atlas, its foot (where the twig is) at `base`, reaching `length` along
 * `along` and `width` across along `across`. Its corners take the crown's normal and a colour darker with depth.
 */
function card(out: Parts, base: V, along: V, across: V, length: number, width: number, rect: [number, number, number], colour: THREE.Color, shape: Shape, shade: (p: V, depth: number) => number): void {
  const half = across.clone().multiplyScalar(width / 2);
  const tip = along.clone().multiplyScalar(length);
  const corners = [base.clone().sub(half), base.clone().add(half), base.clone().add(half).add(tip), base.clone().sub(half).add(tip)];
  const [u0, v0, s] = rect;
  const uvs = [[u0, v0], [u0 + s, v0], [u0 + s, v0 + s], [u0, v0 + s]];
  const c = new THREE.Color();
  const first = corners.map((p, k) => out.vertex(p, shape.normal(p), uvs[k][0], uvs[k][1], c.copy(colour).multiplyScalar(shade(p, shape.depth(p)))));
  out.idx.push(first[0], first[1], first[2], first[0], first[2], first[3]);
}

/** A tapering branch from a to b, `sides` round, its bark from the bark atlas's `u` half, darker inside the crown. */
function branch(out: Parts, a: V, b: V, r0: number, r1: number, sides: number, u: [number, number], colour: THREE.Color, shade = 1): void {
  const axis = b.clone().sub(a);
  const length = axis.length();
  axis.normalize();
  const side = Math.abs(axis.y) > 0.9 ? v3(1, 0, 0) : UP.clone();
  const x = side.clone().cross(axis).normalize();
  const y = axis.clone().cross(x).normalize();
  const c = colour.clone().multiplyScalar(shade);
  const ring = (centre: V, r: number, v: number) =>
    Array.from({ length: sides + 1 }, (_, i) => {
      const a = (i / sides) * Math.PI * 2;
      const n = x.clone().multiplyScalar(Math.cos(a)).addScaledVector(y, Math.sin(a));
      return out.vertex(centre.clone().addScaledVector(n, r), n, u[0] + (u[1] - u[0]) * (i / sides), v, c);
    });
  const lo = ring(a, r0, 0);
  const hi = ring(b, r1, length * 3);
  for (let i = 0; i < sides; i++) out.idx.push(lo[i], lo[i + 1], hi[i + 1], lo[i], hi[i + 1], hi[i]);
}

const random = (seed: number) => {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
};

/** A unit vector at azimuth `a` and elevation `e` (radians). */
const heading = (a: number, e: number) => v3(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e));

/** A random unit vector. */
const anyway = (rand: () => number) => {
  const y = rand() * 2 - 1;
  const a = rand() * Math.PI * 2;
  const r = Math.sqrt(1 - y * y);
  return v3(Math.cos(a) * r, y, Math.sin(a) * r);
};

/** A direction across `along` for a card, turned at random about it. */
const crossing = (along: V, rand: () => number) => {
  const other = Math.abs(along.y) > 0.9 ? v3(1, 0, 0) : UP;
  const x = other.clone().cross(along).normalize();
  const y = along.clone().cross(x).normalize();
  const a = rand() * Math.PI;
  return x.multiplyScalar(Math.cos(a)).addScaledVector(y, Math.sin(a)).normalize();
};

export interface CardCrown {
  /** The leaf cards */
  cards: THREE.BufferGeometry;
  /** The limbs and twigs inside, in the bark's material (none on the far crowns) */
  branches: THREE.BufferGeometry | null;
}

/**
 * The crown's geometry, drawn in towards the top of its trunk where cards reach past its design (1 across, HEIGHT
 * up): the copy's stretch then fits the tree, and the trunk still meets the limbs.
 */
function fitted(leaves: Parts, wood: Parts | null, kind: Kind): CardCrown {
  const fork = FORK[kind];
  let top = 0;
  let side = 0;
  for (let i = 0; i < leaves.pos.length; i += 3) {
    top = Math.max(top, leaves.pos[i + 1]);
    side = Math.max(side, Math.hypot(leaves.pos[i], leaves.pos[i + 2]));
  }
  const k = Math.min(1, (HEIGHT[kind] * 1.04 - fork) / (top - fork), 1.12 / side);
  for (const p of [leaves, wood]) {
    if (!p) continue;
    for (let i = 0; i < p.pos.length; i += 3) {
      p.pos[i] *= k;
      p.pos[i + 1] = fork + (p.pos[i + 1] - fork) * k;
      p.pos[i + 2] *= k;
    }
  }
  return { cards: leaves.geometry(), branches: wood?.geometry() ?? null };
}

const GREEN: Record<Kind, string> = {
  [Kind.Broad]: '#5f7442',
  [Kind.Birch]: '#7d8a48',
  [Kind.Poplar]: '#667a45',
  [Kind.Spruce]: '#33482c',
  [Kind.Fruit]: '#6a7a44',
};
export const BARK: string[] = ['#8f8476', '#a7a49a', '#80614f', '#ffffff'];

/** The light and shade inside a crown: dark deep in it, a little darker underneath; `open` how much light gets in. */
function shading(h: number, open: number) {
  return (p: V, depth: number) => {
    const inner = THREE.MathUtils.smoothstep(depth, 0.25, 1.0);
    const under = THREE.MathUtils.smoothstep(p.y / h, -1.0, 0.6);
    return (open + (1 - open) * inner) * (0.78 + 0.22 * under);
  };
}

/** A broad-leaved crown (oak, lime, beech) or a fruit tree's: a few limbs from the fork, twigs from them, cards in clumps at the twigs' ends. */
function broadCrown(seed: number, far: boolean, kind: typeof Kind.Broad | typeof Kind.Fruit): CardCrown {
  const rand = random(seed);
  const h = HEIGHT[kind];
  const fruit = kind === Kind.Fruit;
  const phase = rand() * Math.PI * 2;
  const lobes = Array.from({ length: 7 }, (_, i) => heading(phase + i * 2.39996, -0.3 + rand() * 1.1));
  // The crown's outline: an ellipsoid with lumps where the limbs are.
  const reach = (d: V) => {
    let r = 0.8;
    for (const l of lobes) r += 0.2 * Math.pow(Math.max(0, d.dot(l)), 6);
    return v3(d.x * r, d.y * r * h, d.z * r);
  };
  const shape = ellipsoid(h);
  const shade = shading(h, 0.35);
  const leaves = new Parts();
  const wood = far ? null : new Parts();
  const rect = sprayRect(Spray.Broad);
  const green = new THREE.Color(GREEN[kind]);
  const bark = new THREE.Color(BARK[TRUNK_OF[kind]]);
  const fork = v3(0, FORK[kind], 0);
  const size = far ? 0.72 : 0.42;
  const clump = (at: V, n: number) => {
    for (let i = 0; i < n; i++) {
      const base = at.clone().add(anyway(rand).multiplyScalar(size * 0.55));
      const out = shape.normal(base);
      const along = out.multiplyScalar(0.8).add(anyway(rand).multiplyScalar(0.55)).add(v3(0, 0.25, 0)).normalize();
      const s = size * (0.8 + rand() * 0.4);
      const tone = green.clone().multiplyScalar(0.88 + rand() * 0.24);
      card(leaves, base, along, crossing(along, rand), s, s, rect, tone, shape, shade);
    }
  };
  const limbs = fruit ? 4 + Math.floor(rand() * 2) : 4 + Math.floor(rand() * 3);
  for (let i = 0; i < limbs; i++) {
    const a = phase + (i / limbs) * Math.PI * 2 + (rand() - 0.5) * 0.6;
    const e = fruit ? 0.25 + rand() * 0.35 : 0.5 + rand() * 0.5;
    const start = fork.clone().add(v3(0, rand() * 0.12, 0));
    const end = reach(heading(a, e)).multiplyScalar(fruit ? 0.72 : 0.6);
    wood && branch(wood, start, end, 0.045, 0.016, 5, BARK_U.bark, bark, 0.7);
    const twigs = 3 + Math.floor(rand() * 2);
    for (let j = 0; j < twigs; j++) {
      const from = start.clone().lerp(end, 0.4 + (0.6 * (j + 1)) / twigs);
      const dir = heading(a + (rand() - 0.5) * 1.4, (fruit ? 0.35 : 0.1) + rand() * 0.9);
      const tip = reach(dir).multiplyScalar(0.84 + rand() * 0.12);
      wood && branch(wood, from, tip, 0.016, 0.005, 3, BARK_U.bark, bark, 0.8);
      clump(tip, far ? 3 : 9);
      clump(from.clone().lerp(tip, 0.55), far ? 1 : 4);
    }
    clump(end, far ? 1 : 4);
  }
  // Fill: leaves all over the outside where the clumps leave big gaps, and a few deeper in.
  for (let i = 0; i < (far ? 26 : 90); i++) {
    const d = anyway(rand);
    if (d.y < -0.75) continue;
    clump(reach(d).multiplyScalar(0.78 + rand() * 0.18), 1);
  }
  for (let i = 0; i < (far ? 4 : 40); i++) clump(reach(anyway(rand)).multiplyScalar(0.45 + rand() * 0.25), 1);
  return fitted(leaves, wood, kind);
}

/** A birch: a stem up to near the top, thin branches climbing from it, twigs hanging from their outer halves with small leaves. */
function birchCrown(seed: number, far: boolean): CardCrown {
  const rand = random(seed);
  const h = HEIGHT[Kind.Birch];
  const shape = ellipsoid(h, 0.1);
  const shade = shading(h, 0.45);
  const leaves = new Parts();
  const wood = far ? null : new Parts();
  const rect = sprayRect(Spray.Birch);
  const green = new THREE.Color(GREEN[Kind.Birch]);
  const white = new THREE.Color(BARK[3]);
  const top = v3((rand() - 0.5) * 0.1, h * 0.92, (rand() - 0.5) * 0.1);
  const foot = v3(0, FORK[Kind.Birch] - 0.1, 0);
  wood && branch(wood, foot, top, 0.04, 0.006, 5, BARK_U.birch, white, 0.9);
  const size = far ? 0.6 : 0.34;
  const n = far ? 10 : 14;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const from = foot.clone().lerp(top, 0.15 + t * 0.75);
    const a = i * 2.39996 + rand() * 0.4;
    const width = Math.sqrt(Math.max(0.05, 1 - Math.pow(from.y / (h * 1.05), 2)));
    const end = from.clone().add(heading(a, 0.6 + rand() * 0.35).multiplyScalar(width * (0.85 + rand() * 0.2)));
    end.y = Math.min(end.y, h * 0.95);
    wood && branch(wood, from, end, 0.014, 0.004, 3, BARK_U.birch, white, 0.85);
    // Hanging twigs from the branch's outer half.
    const hangs = far ? 3 : 7;
    for (let j = 0; j < hangs; j++) {
      const at = from.clone().lerp(end, 0.45 + (0.55 * (j + rand() * 0.5)) / hangs).add(anyway(rand).multiplyScalar(0.08));
      const out = shape.normal(at);
      const along = v3(0, -1, 0).multiplyScalar(0.85).addScaledVector(out, 0.4).add(anyway(rand).multiplyScalar(0.2)).normalize();
      const s = size * (0.85 + rand() * 0.35);
      // Hung from the top: its foot (the twig's start) up, the card running down from it.
      card(leaves, at, along, crossing(along, rand), s * 1.15, s * 0.85, rect, green.clone().multiplyScalar(0.9 + rand() * 0.2), shape, shade);
      if (!far && rand() < 0.6) {
        const along2 = along.clone().add(anyway(rand).multiplyScalar(0.4)).normalize();
        card(leaves, at.clone().addScaledVector(along, s * 0.5), along2, crossing(along2, rand), s, s * 0.8, rect, green.clone().multiplyScalar(0.9 + rand() * 0.2), shape, shade);
      }
    }
  }
  return fitted(leaves, wood, Kind.Birch);
}

/** A Lombardy poplar: a straight stem to the top, short branches all the way up, steep, clad in upright sprays: a narrow column. */
function poplarCrown(seed: number, far: boolean): CardCrown {
  const rand = random(seed);
  const h = HEIGHT[Kind.Poplar];
  const radius = (y: number) => {
    const t = THREE.MathUtils.clamp(y / h, -1, 1);
    return Math.sqrt(Math.max(0, 1 - t * t)) * (1.05 - 0.3 * t) * 0.95 + 0.05;
  };
  const shape = column(h, radius);
  const shade = shading(h, 0.4);
  const leaves = new Parts();
  const wood = far ? null : new Parts();
  const rect = sprayRect(Spray.Poplar);
  const green = new THREE.Color(GREEN[Kind.Poplar]);
  const bark = new THREE.Color(BARK[TRUNK_OF[Kind.Poplar]]);
  const foot = v3(0, FORK[Kind.Poplar] - 0.2, 0);
  const top = v3(0, h, 0);
  wood && branch(wood, foot, top, 0.07, 0.01, 5, BARK_U.bark, bark, 0.8);
  const levels = far ? 16 : 26;
  const size = far ? 0.9 : 0.55;
  for (let i = 0; i < levels; i++) {
    const y = -h * 0.92 + (i / (levels - 1)) * h * 1.84;
    for (let k = 0; k < (far ? 3 : 3); k++) {
      const a = i * 2.39996 + k * 2.1 + rand() * 0.5;
      const r = radius(y);
      const from = v3(0, y - 0.3, 0);
      const end = v3(Math.cos(a) * r * 0.8, y + 0.35 + rand() * 0.3, Math.sin(a) * r * 0.8);
      wood && branch(wood, from, end, 0.016, 0.004, 3, BARK_U.bark, bark, 0.75);
      for (let j = 0; j < (far ? 1 : 3); j++) {
        const at = from.clone().lerp(end, 0.4 + 0.25 * j + rand() * 0.1);
        const out = shape.normal(at);
        const along = UP.clone().multiplyScalar(0.85).addScaledVector(out, 0.45).add(anyway(rand).multiplyScalar(0.25)).normalize();
        const s = size * (0.8 + rand() * 0.4) * Math.min(1, 0.35 + r);
        card(leaves, at, along, crossing(along, rand), s * 1.1, s * 0.85, rect, green.clone().multiplyScalar(0.88 + rand() * 0.24), shape, shade);
      }
    }
  }
  return fitted(leaves, wood, Kind.Poplar);
}

/**
 * A spruce: a stem to the tip and tiers of branches round it, longest at the bottom. Each branch carries its
 * fronds laid out flat along it, and a curtain of hanging shoots below them (from the side, a spruce's branches
 * look like that: a shelf with a fringe).
 */
function spruceCrown(seed: number, far: boolean): CardCrown {
  const rand = random(seed);
  const h = HEIGHT[Kind.Spruce];
  const radius = (y: number) => Math.pow(THREE.MathUtils.clamp((h - y) / (2 * h), 0, 1), 0.85);
  const shape = column(h, radius);
  const shade = shading(h, 0.3);
  const leaves = new Parts();
  const wood = far ? null : new Parts();
  const rect = sprayRect(Spray.Spruce);
  const green = new THREE.Color(GREEN[Kind.Spruce]);
  const bark = new THREE.Color(BARK[TRUNK_OF[Kind.Spruce]]);
  const foot = v3(0, FORK[Kind.Spruce] - 0.3, 0);
  wood && branch(wood, foot, v3(0, h, 0), 0.07, 0.008, 5, BARK_U.bark, bark, 0.75);
  // The leading shoot at the tip: two fronds crossed upright.
  for (const a of [0, Math.PI / 2]) {
    const across = v3(Math.cos(a), 0, Math.sin(a));
    card(leaves, v3(0, h * 0.62, 0), UP, across, h * 0.4, 0.42, rect, green, shape, shading(h, 0.3));
  }
  const tiers = far ? 12 : 22;
  const per = far ? 5 : 6;
  for (let i = 0; i < tiers; i++) {
    const y = -h + 0.05 + (i / tiers) * h * 1.92;
    const r = radius(y);
    for (let k = 0; k < per; k++) {
      const a = i * 2.39996 + (k / per) * Math.PI * 2 + rand() * 0.5;
      const out = v3(Math.cos(a), 0, Math.sin(a));
      const length = r * (0.92 + rand() * 0.16);
      const droop = -0.15 - rand() * 0.15;
      const from = v3(0, y, 0);
      const end = from.clone().add(heading(a, droop).multiplyScalar(length));
      end.y += length * 0.12; // the tips turn up again
      // Every third tier's branches: inside the fronds the rest don't show.
      wood && i % 3 === 0 && branch(wood, from, end, 0.018, 0.004, 3, BARK_U.bark, bark, 0.65);
      const tangent = v3(-out.z, 0, out.x);
      const pieces = far ? 1 : Math.max(1, Math.round(length / 0.33));
      const step = length / pieces;
      for (let j = 0; j < pieces; j++) {
        const base = from.clone().lerp(end, j / pieces).addScaledVector(out, -step * 0.15);
        const along = end.clone().sub(from).normalize();
        const bank = tangent.clone().addScaledVector(UP, (rand() - 0.5) * 0.5).normalize();
        const s = step * 1.35;
        const tone = green.clone().multiplyScalar(0.88 + rand() * 0.24);
        card(leaves, base, along, bank, s, s * 0.95, rect, tone, shape, shade);
        // The hanging fringe under the shelf.
        if (!far || j === 0) {
          const hang = v3(0, -1, 0).addScaledVector(out, 0.35).normalize();
          const hb = base.clone().addScaledVector(along, s * 0.5);
          card(leaves, hb.addScaledVector(hang, -s * 0.1), hang, tangent, s * 0.7, s * 0.95, rect, tone.clone().multiplyScalar(0.85), shape, shade);
        }
      }
    }
  }
  return fitted(leaves, wood, Kind.Spruce);
}

/** A crown of a kind: `variant` picks one of the broad-leaved shapes; `far` the lighter version for further off. */
export function cardCrown(kind: Kind, variant: number, far: boolean): CardCrown {
  const seed = 1000 + kind * 7919 + variant * 104729;
  if (kind === Kind.Broad || kind === Kind.Fruit) return broadCrown(seed, far, kind);
  if (kind === Kind.Birch) return birchCrown(seed, far);
  if (kind === Kind.Poplar) return poplarCrown(seed, far);
  return spruceCrown(seed, far);
}

/** A columnar conifer's height in its own units (its radius 1): the copy's stretch is its radius across and height / COLUMN_HEIGHT up. */
export const COLUMN_HEIGHT = 7;

/**
 * A columnar conifer (Leyland cypress, thuja) of the front gardens, from its foot (0) to its tip (COLUMN_HEIGHT): a
 * narrow cone, broadest a fifth of the way up, thick with upright fronds all over, darker inside. No trunk: the
 * models keep their own short one at the foot.
 */
export function columnConifer(seed = 77): THREE.BufferGeometry {
  const rand = random(seed);
  const h = COLUMN_HEIGHT;
  // The street models' cones (tools/molenhoek.py conifer): their radius at each height, as a share of the widest.
  const profile = [[0, 0.75], [0.06, 0.9], [0.18, 1.0], [0.45, 0.85], [0.72, 0.55], [0.92, 0.22], [1, 0.02]];
  const radius = (y: number) => {
    const t = THREE.MathUtils.clamp(y / h, 0, 1);
    for (let i = 1; i < profile.length; i++) {
      if (t <= profile[i][0]) {
        const [t0, r0] = profile[i - 1];
        const [t1, r1] = profile[i];
        return r0 + ((r1 - r0) * (t - t0)) / (t1 - t0);
      }
    }
    return 0.02;
  };
  const shape = column(h, (y) => radius(y));
  const shade = (p: V, depth: number) => (0.3 + 0.7 * THREE.MathUtils.smoothstep(depth, 0.2, 1.0)) * (0.8 + 0.2 * THREE.MathUtils.smoothstep(p.y / h, 0, 0.7));
  const leaves = new Parts();
  const rect = sprayRect(Spray.Spruce);
  const green = new THREE.Color('#3f5a32');
  for (let y = 0.25; y < h - 0.2; y += 0.2) {
    const r = radius(y);
    const around = Math.max(3, Math.round(r * 8));
    for (let k = 0; k < around; k++) {
      const a = (k / around) * Math.PI * 2 + y * 2.39996 + rand() * 0.4;
      const out = v3(Math.cos(a), 0, Math.sin(a));
      const base = out.clone().multiplyScalar(r * (0.45 + rand() * 0.2)).setY(y - 0.2);
      const along = UP.clone().multiplyScalar(0.8).addScaledVector(out, 0.5).add(anyway(rand).multiplyScalar(0.2)).normalize();
      const s = Math.max(0.3, 0.75 * Math.min(1, r + 0.3)) * (0.85 + rand() * 0.3);
      card(leaves, base, along, crossing(along, rand), s, s * 0.8, rect, green.clone().multiplyScalar(0.88 + rand() * 0.24), shape, shade);
    }
  }
  // The tip.
  for (const a of [0, Math.PI / 2]) card(leaves, v3(0, h * 0.86, 0), UP, v3(Math.cos(a), 0, Math.sin(a)), h * 0.15, 0.4, rect, green, shape, shade);
  return leaves.geometry();
}

/** How many shapes each kind has (the broad-leaved trees two, so neighbours differ). */
export const VARIANTS = [2, 1, 1, 1, 1];

/**
 * A trunk of a kind, 1 high, from the ground to where it meets the crown: 0.1 across at its flared foot, 0.065
 * at its top, a little bent (a spruce's and a poplar's straight). Its bark repeats up it (world/leafCards.ts).
 */
export function cardTrunk(shape: number): THREE.BufferGeometry {
  const out = new Parts();
  const birch = shape === 3;
  const straight = shape === 1 || shape === 2;
  const sides = 8;
  const rows = 6;
  const colour = new THREE.Color(BARK[shape]);
  const u = birch ? BARK_U.birch : BARK_U.bark;
  const c = new THREE.Color();
  const rings: number[][] = [];
  for (let j = 0; j <= rows; j++) {
    const y = j / rows;
    const r = (0.1 - 0.035 * y) * (1 + 0.35 * Math.pow(1 - y, 8));
    const bend = straight ? 0 : 0.06 * Math.sin(y * 2.5) * y;
    // A birch's foot is dark and cracked; any trunk is a little darker at the bottom (splashed, mossy).
    const foot = birch ? 0.35 + 0.65 * THREE.MathUtils.smoothstep(y, 0.02, 0.12) : 0.8 + 0.2 * THREE.MathUtils.smoothstep(y, 0, 0.15);
    c.copy(colour).multiplyScalar(foot);
    rings.push(Array.from({ length: sides + 1 }, (_, i) => {
      const a = (i / sides) * Math.PI * 2;
      const n = v3(Math.cos(a), 0.04, Math.sin(a)).normalize();
      return out.vertex(v3(Math.cos(a) * r + bend, y, Math.sin(a) * r), n, u[0] + (u[1] - u[0]) * (i / sides), y, c);
    }));
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < sides; i++) out.idx.push(rings[j][i], rings[j + 1][i], rings[j + 1][i + 1], rings[j][i], rings[j + 1][i + 1], rings[j][i + 1]);
  }
  return out.geometry();
}

/** A tree from the open data: where it stands, its height and crown radius (metres). */
export interface TreeSpot {
  x: number;
  z: number;
  h: number;
  r: number;
}

/** A number 0 to 1 from the tree's place and `n`, the same every time. */
export function spotHash(x: number, z: number, n: number): number {
  const v = Math.sin(x * (12.9898 + n) + z * (78.233 - n)) * 43758.5453;
  return v - Math.floor(v);
}

/** The Sparrenhof's wood: within this many metres of the café its trees are spruces. */
const SPRUCE_WOOD: [number, number, number] = [638, 942, 320];

/** Which kind a tree is: `wood` if it stands in a wood of the open data. */
export function treeKind(t: TreeSpot, wood: boolean): Kind {
  const roll = spotHash(t.x, t.z, 11);
  if (wood && Math.hypot(t.x - SPRUCE_WOOD[0], t.z - SPRUCE_WOOD[1]) < SPRUCE_WOOD[2]) {
    return roll < 0.86 ? Kind.Spruce : roll < 0.95 ? Kind.Birch : Kind.Broad;
  }
  if (wood) return roll < 0.68 ? Kind.Broad : roll < 0.82 ? Kind.Birch : roll < 0.92 ? Kind.Poplar : Kind.Spruce;
  if (t.h >= 16) return roll < 0.3 ? Kind.Poplar : Kind.Broad;
  if (t.h >= 7.5) return roll < 0.2 ? Kind.Birch : roll < 0.3 ? Kind.Spruce : Kind.Broad;
  return roll < 0.45 ? Kind.Fruit : roll < 0.6 ? Kind.Birch : Kind.Broad;
}

/**
 * Where a tree's crown sits and how big it is, in metres: its middle's height over the tree's foot, its radius
 * across and its half-height (the copy's stretch: the radius across, and the half-height over the kind's
 * `HEIGHT`). `crownR`: the radius the open data's crown gets (world/surroundings.ts, after the spacing round the
 * house); `wood`: in a wood, where trees grow taller and narrower and lose their low branches.
 */
export function crownFit(kind: Kind, t: TreeSpot, crownR: number, wood: boolean): { middle: number; radius: number; half: number } {
  let radius: number;
  let half: number;
  if (kind === Kind.Poplar) {
    radius = THREE.MathUtils.clamp(t.h * 0.11, 1.2, 3.2);
    half = t.h * 0.44;
  } else if (kind === Kind.Spruce) {
    radius = THREE.MathUtils.clamp(t.h * (wood ? 0.15 : 0.19), 1.3, 4.4);
    half = t.h * (wood ? 0.3 : 0.44);
  } else if (kind === Kind.Birch) {
    radius = Math.min(crownR, Math.max(1.4, t.h * 0.2));
    half = Math.min(t.h * 0.36, radius * 2);
  } else if (kind === Kind.Fruit) {
    radius = THREE.MathUtils.clamp(crownR, 1.6, 4);
    half = Math.min(t.h * 0.38, radius * 0.8);
  } else {
    radius = crownR;
    half = Math.min(t.h * 0.75, Math.max(crownR * 2.2, t.h * 0.6)) * 0.6;
  }
  radius = Math.min(radius, crownR * 1.15);
  return { middle: t.h - half, radius, half };
}
