import * as THREE from 'three';
import type { Opening, Prism, RoofSpec } from './houseData';
import { prismGeometry } from './houseMeshes';
import { brickLook, Houses, isBrick } from './facadeLook';
import { houseStyle, PLINTH_BRICK_SHADE, rollerDown, type HouseStyle } from './houseStyle';

/**
 * The details that make an open-data house (world/surroundings.ts) read as a house and not a block, built in code from
 * each house's style (world/houseStyle.ts): a chimney on the ridge, verge boards along the gables and ridge tiles on
 * top, a plinth or a damp base at the foot of the walls, lintels over the openings, a bluestone step under each door,
 * leaf shutters or lowered roller shutters at some windows.
 *
 * Everything rides in meshes the tiles already draw (world/tiles.ts merges by material): the chimneys and plinths in
 * the brick, the ridge tiles in the roof tiles, the rest in the frames (`face` quads and boxes, vertex colours, no
 * texture). So no draw call is added. Drawn only: nothing here stops a player.
 */

const UP = new THREE.Vector3(0, 1, 0);
/** The brick texture's mean (linear), as world/facadeLook.ts's render uses it: a bare brick wall shows its tint times about this. */
const BRICK_MEAN = 0.56;
/** A soldier course over an opening: the wall's tint times this (and the texture's mean, as it has none). */
const SOLDIER = 0.78;
/** A damp base: the bottom of the wall at this times its tint, back to its own at the cut. */
const DAMP = 0.82;
/** Metres above the highest ground round the house where a damp base has faded out. */
const DAMP_TOP = 0.8;
/** The roofs' overhang, as world/surroundings.ts draws them. */
const OVERHANG = 0.3;

/** A roof's rectangle: its corners (c[0]-c[1] along the ridge, or the low side of a shed), lengths and directions. */
export interface RoofFrame {
  c: THREE.Vector2[];
  L: number;
  W: number;
  along: THREE.Vector2;
  across: THREE.Vector2;
}

export function roofFrame(r: RoofSpec): RoofFrame {
  const c = r.p.map(([x, z]) => new THREE.Vector2(x, z));
  // Make c[0]-c[1] a long side (unless windows are measured from the corners as given).
  if (!r.fixed && !r.windows && !r.gableWindows && c[0].distanceTo(c[1]) < c[1].distanceTo(c[2])) c.push(c.shift()!);
  return {
    c,
    L: c[0].distanceTo(c[1]),
    W: c[0].distanceTo(c[3]),
    along: c[1].clone().sub(c[0]).normalize(),
    across: c[3].clone().sub(c[0]).normalize(),
  };
}

/** Float colours on every vertex (the frames' mesh). */
function colourAll(g: THREE.BufferGeometry, colour: THREE.Color): THREE.BufferGeometry {
  const colors = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([colour.r, colour.g, colour.b], i);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/**
 * One upright quad `w` wide (along the horizontal `d`) and `h` high, centred at `at`, facing `n`: two triangles, for
 * flat things a few centimetres in front of a wall (a box is twelve). Position, normal and a float colour, as the frames.
 */
export function face(at: THREE.Vector3, d: THREE.Vector3, n: THREE.Vector3, w: number, h: number, colour: THREE.Color): THREE.BufferGeometry {
  const dx = d.clone().multiplyScalar(w / 2);
  if (dx.clone().cross(UP).dot(n) < 0) dx.negate(); // d x up = n: the quad faces n
  const uy = UP.clone().multiplyScalar(h / 2);
  const p = [at.clone().sub(dx).sub(uy), at.clone().add(dx).sub(uy), at.clone().add(dx).add(uy), at.clone().sub(dx).add(uy)];
  const pos = new Float32Array(18);
  [0, 1, 2, 0, 2, 3].forEach((k, i) => pos.set(p[k].toArray(), i * 3));
  const nor = new Float32Array(18);
  for (let i = 0; i < 6; i++) nor.set([n.x, n.y, n.z], i * 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return colourAll(g, colour);
}

/**
 * A strip `h` wide hanging from the line p to q (which may slope), in the plane upright to `n` and facing it: two
 * triangles, the frames' attributes.
 */
export function strip(p: THREE.Vector3, q: THREE.Vector3, n: THREE.Vector3, h: number, colour: THREE.Color): THREE.BufferGeometry {
  const x = q.clone().sub(p).normalize();
  const down = n.clone().cross(x).normalize();
  if (down.y > 0) down.negate();
  down.multiplyScalar(h);
  const v = [p, q, q.clone().add(down), p.clone().add(down)];
  // Wound to face n.
  const k = v[1].clone().sub(v[0]).cross(v[2].clone().sub(v[0])).dot(n) > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
  const pos = new Float32Array(18);
  k.forEach((j, i) => pos.set(v[j].toArray(), i * 3));
  const nor = new Float32Array(18);
  for (let i = 0; i < 6; i++) nor.set([n.x, n.y, n.z], i * 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return colourAll(g, colour);
}

/**
 * A box along the line p to q (which may slope): `h` across it in the plane that holds the line and is upright to
 * `n`, `t` thick along `n`. The same attributes as the frames' boxes.
 */
export function board(p: THREE.Vector3, q: THREE.Vector3, n: THREE.Vector3, h: number, t: number, colour: THREE.Color): THREE.BufferGeometry {
  const x = q.clone().sub(p);
  const length = x.length();
  x.normalize();
  const z = n.clone().addScaledVector(x, -n.dot(x)).normalize();
  const y = z.clone().cross(x);
  const g = new THREE.BoxGeometry(length, h, t).toNonIndexed();
  g.deleteAttribute('uv');
  g.applyMatrix4(new THREE.Matrix4().makeBasis(x, y, z).setPosition(p.clone().add(q).multiplyScalar(0.5)));
  return colourAll(g, colour);
}

/** A box `w` wide (along `d`), `h` high and `t` deep (along `n`), centred at `at`. */
function box(at: THREE.Vector3, d: THREE.Vector3, n: THREE.Vector3, w: number, h: number, t: number, colour: THREE.Color): THREE.BufferGeometry {
  const half = d.clone().multiplyScalar(w / 2);
  return board(at.clone().sub(half), at.clone().add(half), n, h, t, colour);
}

/** The area of a ring on the plan. */
function area(ring: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(a / 2);
}

// ---- Roof edges: verge boards along the gables, ridge tiles on top ----

export interface RoofEdges {
  /** The verge boards' colour (the house's trim) */
  trim: THREE.Color;
  /** Whether nothing stands against the roof's edge at (x, z) (on a terraced row, a neighbour's house) */
  free: (x: number, z: number) => boolean;
}

/**
 * Verge boards and ridge tiles for a roof (world/surroundings.ts `roof`): a board 16 cm deep and 3 cm thick at the
 * tiles' edge along each sloping gable edge (gable roofs), along both sloping ends and the high edge (shed roofs); a
 * row of ridge tiles along the ridge (gable and hip roofs). Leaves out an edge where a neighbour's wall stands against it.
 * `trim` goes to the frames' mesh, `ridge` (with texture coordinates in metres) to the roof tiles'.
 */
export function roofEdges(r: RoofSpec, f: RoofFrame, e: RoofEdges): { trim: THREE.BufferGeometry | null; ridge: THREE.BufferGeometry | null } {
  const { c, L, W, along, across } = f;
  const o = OVERHANG;
  const eave = r.y - 0.15;
  const pt = (a: number, b: number, y: number) => {
    const q = c[0].clone().addScaledVector(along, a).addScaledVector(across, b);
    return new THREE.Vector3(q.x, y, q.y);
  };
  const along3 = new THREE.Vector3(along.x, 0, along.y);
  const across3 = new THREE.Vector3(across.x, 0, across.y);
  const free = (a: number, b: number) => {
    const q = c[0].clone().addScaledVector(along, a).addScaledVector(across, b);
    return e.free(q.x, q.y);
  };
  const boards: THREE.BufferGeometry[] = [];
  /**
   * A verge board at the edge from p to q (on the roof's surface), its outside facing n: only its face, a centimetre
   * beyond the tiles' edge with its top flush with them. (A whole board's thin top caught the sun as a dotted line of
   * light pixels from a distance, as the gutters do.)
   */
  const verge = (p: THREE.Vector3, q: THREE.Vector3, n: THREE.Vector3) => {
    const shift = n.clone().multiplyScalar(0.01);
    boards.push(strip(p.clone().add(shift), q.clone().add(shift), n, 0.16, e.trim));
  };
  if (r.shape === 'shed') {
    const k = (r.ridge - r.y) / Math.max(0.5, W);
    const low = r.y - k * o;
    // Where a wall stands against the high side (the other half of a house, a taller house), the ends stop at it.
    const open = free(L / 2, W + o + 0.3);
    const end = open ? W + o : W;
    const high = r.ridge + k * (end - W);
    for (const [a, side] of [[-o, -1], [L + o, 1]] as const) {
      if (free(a + side * 0.3, W / 2)) verge(pt(a, -o, low), pt(a, end, high), along3.clone().multiplyScalar(side));
    }
    if (open) verge(pt(-o, W + o, high), pt(L + o, W + o, high), across3);
  } else if (r.shape !== 'hip') {
    for (const [a, side] of [[-o, -1], [L + o, 1]] as const) {
      if (!free(a + side * 0.3, W / 2)) continue;
      const n = along3.clone().multiplyScalar(side);
      const top = pt(a, W / 2, r.ridge);
      verge(pt(a, -o, eave), top, n);
      verge(top, pt(a, W + o, eave), n);
    }
  }
  const trim = boards.length ? merge(boards) : null;

  // Ridge tiles: a low rounded row over the ridge line, its edges on the slopes.
  let ridge: THREE.BufferGeometry | null = null;
  if (r.shape !== 'shed') {
    const k = (r.ridge - eave) / (W / 2 + o); // drop per metre across
    let a0 = -o;
    let a1 = L + o;
    if (r.shape === 'hip') {
      const half = Math.min(L, W) / 2;
      a0 = half;
      a1 = Math.max(half, L - half);
    }
    if (a1 - a0 > 0.3) ridge = ridgeRow(pt(a0, W / 2, r.ridge), pt(a1, W / 2, r.ridge), across3, k);
  }
  return { trim, ridge };
}

/** A row of ridge tiles from p to q (on the ridge), across the ridge along `side`, the slopes dropping k per metre. */
function ridgeRow(p: THREE.Vector3, q: THREE.Vector3, side: THREE.Vector3, k: number): THREE.BufferGeometry {
  const s = 0.13;
  // The cross-section: [across, up] from the ridge line.
  const section: [number, number][] = [[-s, 0.005 - s * k], [-0.07, 0.055], [0, 0.075], [0.07, 0.055], [s, 0.005 - s * k]];
  const length = p.distanceTo(q);
  const dir = q.clone().sub(p).normalize();
  const at = (from: THREE.Vector3, [b, y]: [number, number]) => from.clone().addScaledVector(side, b).addScaledVector(UP, y);
  const pos: number[] = [];
  const uv: number[] = [];
  const push = (v: THREE.Vector3, u: number, w: number) => {
    pos.push(v.x, v.y, v.z);
    uv.push(u, w);
  };
  for (let i = 0; i < section.length - 1; i++) {
    const [s0, s1] = [section[i], section[i + 1]];
    const [v0, v1, v2, v3] = [at(p, s0), at(q, s0), at(q, s1), at(p, s1)];
    // Wound so that the faces point up (every face of the row does, its edges on the slopes too).
    const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, ua: number[], ub: number[], uc: number[]) => {
      if (b.clone().sub(a).cross(c.clone().sub(a)).y >= 0) {
        push(a, ua[0], ua[1]);
        push(b, ub[0], ub[1]);
        push(c, uc[0], uc[1]);
      } else {
        push(a, ua[0], ua[1]);
        push(c, uc[0], uc[1]);
        push(b, ub[0], ub[1]);
      }
    };
    const u0 = [0, s0[0]];
    const u1 = [length, s0[0]];
    const u2 = [length, s1[0]];
    const u3 = [0, s1[0]];
    tri(v0, v1, v2, u0, u1, u2);
    tri(v0, v2, v3, u0, u2, u3);
  }
  // The two ends: a fan over the cross-section, facing out along the ridge.
  for (const [from, out] of [[p, dir.clone().negate()], [q, dir]] as const) {
    const v = section.map((x) => at(from, x));
    for (let i = 1; i < v.length - 1; i++) {
      const n = v[i].clone().sub(v[0]).cross(v[i + 1].clone().sub(v[0]));
      const [b, c] = n.dot(out) >= 0 ? [v[i], v[i + 1]] : [v[i + 1], v[i]];
      push(v[0], section[0][0], section[0][1]);
      push(b, 0, 0);
      push(c, 0, 0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const count = list.reduce((s, g) => s + g.attributes.position.count, 0);
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'color']) {
    const a = new Float32Array(count * 3);
    let at = 0;
    for (const g of list) {
      a.set(g.attributes[name].array as Float32Array, at);
      at += g.attributes[name].array.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(a, 3));
  }
  list.forEach((g) => g.dispose());
  return out;
}

// ---- Chimneys ----

/**
 * The roof of each house in this tile that gets the house's chimney (if its style has one): the largest gable or hip
 * roof over brick walls that is high and big enough, of a house with no chimney in the data already (a small brick
 * block standing above the eaves inside one of its roofs). Custom roofs (with windows, panels or a ceiling) and a
 * landmark's are left alone.
 */
export function chimneyRoofs(roofs: RoofSpec[], prisms: Prism[], keyOf: (r: RoofSpec) => number): Map<RoofSpec, number> {
  const stacks = prisms.filter((p) => isBrick(p.m) && !p.d && area(p.p[0]) < 1.5);
  const best = new Map<number, { r: RoofSpec; size: number }>();
  const surveyed = new Set<number>();
  for (const r of roofs) {
    if (r.lm || r.ceiling) continue;
    const key = keyOf(r);
    const f = roofFrame(r);
    // A chimney in the data inside this roof's rectangle: this house has one.
    const inside = (x: number, z: number) => {
      const dx = x - f.c[0].x;
      const dz = z - f.c[0].y;
      const a = dx * f.along.x + dz * f.along.y;
      const b = dx * f.across.x + dz * f.across.y;
      return a >= -0.3 && a <= f.L + 0.3 && b >= -0.3 && b <= f.W + 0.3;
    };
    for (const s of stacks) {
      if (s.y1 <= r.y) continue;
      const ring = s.p[0];
      const x = ring.reduce((t, q) => t + q[0], 0) / ring.length;
      const z = ring.reduce((t, q) => t + q[1], 0) / ring.length;
      if (inside(x, z)) surveyed.add(key);
    }
    const shape = r.shape ?? 'gable';
    if (!r.wall || !isBrick(r.wall) || (shape !== 'gable' && shape !== 'hip') || r.windows || r.gableWindows || r.panels) continue;
    if (r.ridge - r.y < 1.5 || r.y - (r.base ?? r.y - 2.7) < 2.3 || f.L < 6 || f.W < 4.5) continue;
    if (shape === 'hip' && f.L - f.W < 1) continue;
    const size = f.L * f.W;
    const b = best.get(key);
    if (!b || size > b.size) best.set(key, { r, size });
  }
  const out = new Map<RoofSpec, number>();
  for (const [key, { r }] of best) if (!surveyed.has(key)) out.set(r, key);
  return out;
}

/**
 * A chimney on a roof's ridge: its stack as a block of the walls' brick (drawn as a wall, with the house's shade), and
 * its concrete cap and clay pots for the frames' mesh.
 */
export function chimney(r: RoofSpec, f: RoofFrame, ch: NonNullable<HouseStyle['chimney']>): { stack: Prism; parts: THREE.BufferGeometry[] } {
  const { c, L, W, along, across } = f;
  const eave = r.y - 0.15;
  const k = (r.ridge - eave) / (W / 2 + OVERHANG);
  let a: number;
  if (r.shape === 'hip') {
    // Just inside the end of the ridge (or in its middle when it is short).
    const half = Math.min(L, W) / 2;
    const r0 = half;
    const r1 = Math.max(half, L - half);
    a = r1 - r0 < ch.along + 0.6 ? (r0 + r1) / 2 : ch.end === 0 ? r0 + ch.along / 2 + 0.3 : r1 - ch.along / 2 - 0.3;
  } else a = ch.end === 0 ? ch.from : L - ch.from;
  const pt = (da: number, db: number): [number, number] => {
    const q = c[0].clone().addScaledVector(along, a + da).addScaledVector(across, W / 2 + db);
    return [q.x, q.y];
  };
  const [al, ac] = [ch.along / 2, ch.across / 2];
  const y1 = r.ridge + ch.rise;
  // Down to below where the slopes meet its sides.
  const stack: Prism = { m: r.wall!, y0: r.ridge - k * ac - 0.2, y1, p: [[pt(-al, -ac), pt(al, -ac), pt(al, ac), pt(-al, ac)]] };
  const [mx, mz] = pt(0, 0);
  const d = new THREE.Vector3(along.x, 0, along.y);
  const n = new THREE.Vector3(across.x, 0, across.y);
  const parts = [box(new THREE.Vector3(mx, y1 + 0.03, mz), d, n, ch.along + 0.08, 0.06, ch.across + 0.08, new THREE.Color('#b9b5ac'))];
  const pot = new THREE.Color('#a5533a');
  const offsets = ch.pots === 2 ? [-ch.across / 4, ch.across / 4] : ch.pots === 1 ? [0] : [];
  for (const b of offsets) parts.push(box(new THREE.Vector3(mx + n.x * b, y1 + 0.06 + 0.15, mz + n.z * b), d, n, 0.2, 0.3, 0.2, pot));
  return { stack, parts };
}

// ---- The foot of the walls: plinth or damp ----

export interface WallBase {
  /** Height (model y) of the line between the base and the wall above */
  cut: number;
  tint: THREE.Color;
  render: number;
  /** The plinth's colour and render; null for a damp base (darker at the bottom, fading out at the cut) */
  plinth: { colour: THREE.Color; render: number } | null;
}

/**
 * The bases of the house walls in a tile: per wall block of a house (brick, at least 2.2 m high and 12 m² on the plan,
 * standing on the ground) a plinth up to its style's height above the highest ground round the house, or a damp base.
 * A house of which a wall stands on a plinth in the data (a low brick block with a corner and height under it) keeps
 * its plain walls. `groundAt`: the ground's height at (x, z).
 */
export function wallBases(prisms: Prism[], houses: Houses, groundAt: (x: number, z: number) => number): Map<Prism, WallBase> {
  // The low brick blocks (up to 1.2 m high, 12 m² or more), their corners in cells of half a metre.
  const cell = (x: number, z: number) => `${Math.round(x * 2)}|${Math.round(z * 2)}`;
  const low = new Map<string, { p: Prism; x: number; z: number }[]>();
  for (const p of prisms) {
    if (!isBrick(p.m) || p.d || p.y1 - p.y0 > 1.2 || area(p.p[0]) < 12) continue;
    for (const [x, z] of p.p[0]) {
      const at = cell(x, z);
      const list = low.get(at) ?? [];
      list.push({ p, x, z });
      low.set(at, list);
    }
  }
  /** Whether a plinth in the data goes round this wall: a low block with two or more corners within 25 cm of the
   * wall's, from the wall's foot (a band round it) or up to it (a block under it). */
  const onPlinth = (w: Prism) => {
    const hits = new Map<Prism, number>();
    for (const [x, z] of w.p[0]) {
      const seen = new Set<Prism>();
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          for (const q of low.get(`${Math.round(x * 2) + i}|${Math.round(z * 2) + j}`) ?? []) {
            if (seen.has(q.p) || Math.hypot(q.x - x, q.z - z) > 0.25) continue;
            if (Math.abs(q.p.y0 - w.y0) > 0.15 && Math.abs(q.p.y1 - w.y0) > 0.15) continue;
            seen.add(q.p);
            hits.set(q.p, (hits.get(q.p) ?? 0) + 1);
          }
        }
      }
    }
    return [...hits.values()].some((n) => n >= 2);
  };
  const walls = prisms.filter((p) => isBrick(p.m) && !p.d && !p.lm && p.y1 - p.y0 >= 2.2 && area(p.p[0]) >= 12);
  const top = new Map<number, number>();
  const plinthed = new Set<number>();
  for (const p of walls) {
    const key = houses.keyOf(p);
    let g = top.get(key) ?? -Infinity;
    for (const [x, z] of p.p[0]) g = Math.max(g, groundAt(x, z));
    top.set(key, g);
  }
  // (Only walls on the ground: a low wall round a terrace stands at the foot of the storey above it.)
  for (const p of walls) if (p.y0 <= top.get(houses.keyOf(p))! + 0.25 && onPlinth(p)) plinthed.add(houses.keyOf(p));
  const out = new Map<Prism, WallBase>();
  for (const p of walls) {
    const key = houses.keyOf(p);
    if (plinthed.has(key)) continue;
    const g = top.get(key)!;
    if (p.y0 > g + 0.25) continue; // stands on something else (an upper storey, a terrace)
    const look = brickLook(p.m, key);
    const style = houseStyle(key, p.m, look.render === 1);
    const kind = style.plinth;
    const cut = kind.kind === 'none' ? g + DAMP_TOP : g + kind.height;
    if (cut <= p.y0 + 0.1 || cut >= p.y1 - 1.2) continue;
    // A painted or tarred plinth shows its colour (render shows the vertex colour at about the texture's mean).
    const plinth = kind.kind === 'none'
      ? null
      : { colour: kind.colour ? new THREE.Color(kind.colour).multiplyScalar(1 / BRICK_MEAN) : look.tint.clone().multiplyScalar(PLINTH_BRICK_SHADE), render: kind.render ? 1 : look.render };
    out.set(p, { cut, tint: look.tint, render: look.render, plinth });
  }
  return out;
}

/**
 * A wall block cut in two at its base's height: below, the plinth's colour (or the damp's darker shade fading out
 * up to the cut), above, the wall's. The brick courses run on through (texture coordinates are heights in metres).
 * The colour and render byte as world/facadeLook.ts's walls have them.
 */
export function bandedWalls(p: Prism, base: WallBase): THREE.BufferGeometry {
  const g = prismGeometry(p, 2);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const mid = p.y0 + (p.y1 - p.y0) / 2;
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(pos.getY(i) - mid) > 1e-3) continue;
    pos.setY(i, base.cut);
    uv.setY(i, base.cut);
  }
  const colors = new Uint8Array(pos.count * 3);
  const facade = new Uint8Array(pos.count);
  const byte = (c: THREE.Color) => [c.r, c.g, c.b].map((v) => Math.round(Math.min(1, v) * 255));
  const wall = byte(base.tint);
  const damp = byte(base.tint.clone().multiplyScalar(DAMP));
  const plinth = base.plinth ? byte(base.plinth.colour) : null;
  for (let t = 0; t < pos.count; t += 3) {
    const below = (pos.getY(t) + pos.getY(t + 1) + pos.getY(t + 2)) / 3 < base.cut - 1e-4;
    for (let i = t; i < t + 3; i++) {
      if (below && plinth) {
        colors.set(plinth, i * 3);
        facade[i] = Math.round(base.plinth!.render * 255);
      } else {
        colors.set(!plinth && pos.getY(i) < base.cut - 1e-4 ? damp : wall, i * 3);
        facade[i] = Math.round(base.render * 255);
      }
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
  g.setAttribute('facade', new THREE.BufferAttribute(facade, 1, true));
  return g;
}

// ---- Round the openings ----

export interface OpeningContext {
  houses: Houses;
  /** The ground's height at (x, z) */
  groundAt: (x: number, z: number) => number;
  /** The keys of the houses with a pitched roof in this tile */
  pitched: Set<number>;
  /** All the tile's openings (leaf shutters keep clear of the others) */
  list: Opening[];
}

/**
 * What goes round one window, door or garage door (world/surroundings.ts `buildOpenings` places the frame): a lintel
 * over it, a bluestone step under a door, leaf shutters beside a ground-floor window, a lowered roller shutter in front
 * of a window. For the frames' mesh. `d`, `n`: the wall's direction (d x up = n) and its outside; `mid` the opening's middle.
 */
export function openingTrim(o: Opening, d: THREE.Vector3, n: THREE.Vector3, w: number, mid: THREE.Vector3, ctx: OpeningContext): THREE.BufferGeometry[] {
  const house = ctx.houses.wallAt(mid.x - n.x * 0.3, mid.z - n.z * 0.3);
  if (!house) return [];
  const look = brickLook(house.m, house.key);
  const style = houseStyle(house.key, house.m, look.render === 1, ctx.pitched.has(house.key));
  const [y0, y1] = o.y;
  const h = y1 - y0;
  const out = (k: number, y = mid.y) => mid.clone().addScaledVector(n, k).setY(y);
  const parts: THREE.BufferGeometry[] = [];
  // Lintel: over the frame (5 cm above the opening), unless the wall ends there.
  if (style.lintel !== 'none' && y1 + 0.25 < house.p.y1) {
    if (style.lintel === 'stone') parts.push(face(out(0.03, y1 + 0.05 + 0.09), d, n, w + 0.24, 0.18, new THREE.Color('#d9d4c8')));
    else parts.push(face(out(0.03, y1 + 0.05 + 0.055), d, n, w + 0.1, 0.11, look.tint.clone().multiplyScalar(SOLDIER * BRICK_MEAN)));
  }
  if (o.k === 'd') {
    // A bluestone step from just under the ground in front up to the threshold.
    const ground = Math.min(...[-1, 0, 1].map((s) => {
      const q = out(0.35).addScaledVector(d, (s * (w + 0.3)) / 2);
      return ctx.groundAt(q.x, q.z);
    }));
    const bottom = Math.max(ground - 0.05, y0 - 1.2);
    if (y0 - bottom >= 0.06) parts.push(box(out(0.175, (y0 + bottom) / 2), d, n, w + 0.3, y0 - bottom, 0.35, new THREE.Color('#6b7177')));
  }
  if (o.k !== 'w') return parts;
  const upper = y0 - ctx.groundAt(mid.x, mid.z) > 2;
  if (style.shutters && !upper && w < 1.9 && h < 1.9) {
    const colour = new THREE.Color(style.shutters);
    for (const side of [-1, 1]) {
      const centre = out(0.035).addScaledVector(d, side * (w / 2 + 0.06 + w / 4));
      const edge = centre.clone().addScaledVector(d, (side * w) / 4);
      // Only where the wall goes on and no other opening is in the way.
      const back = ctx.houses.wallAt(edge.x - n.x * 0.3, edge.z - n.z * 0.3);
      if (!back || back.key !== house.key || blocked(ctx.list, o, centre, d, n, w / 2, y0, y1)) continue;
      parts.push(face(centre, d, n, w / 2, h + 0.1, colour));    }
  }
  if (style.rollers) {
    const down = rollerDown(mid.x, mid.y, mid.z);
    if (down > 0) {
      // Strips 16 cm high with a centimetre between them, down from the top of the window.
      const colour = new THREE.Color(style.rollers);
      const reach = down * h;      for (let top = y1; top > y1 - reach + 1e-3; top -= 0.17) {
        const strip = Math.min(0.16, top - (y1 - reach));
        parts.push(face(out(0.075, top - strip / 2), d, n, w, strip, colour));
      }
    }
  }
  return parts;
}

/** Whether another opening on the same wall overlaps a leaf shutter `width` wide, centred at `at`, between heights y0 and y1. */
function blocked(list: Opening[], self: Opening, at: THREE.Vector3, d: THREE.Vector3, n: THREE.Vector3, width: number, y0: number, y1: number): boolean {
  for (const q of list) {
    if (q === self || q.y[1] < y0 - 0.05 || q.y[0] > y1 + 0.05) continue;
    const mx = (q.a[0] + q.b[0]) / 2;
    const mz = (q.a[1] + q.b[1]) / 2;
    if (Math.abs((mx - at.x) * n.x + (mz - at.z) * n.z) > 0.3) continue; // not on this wall
    const half = Math.hypot(q.b[0] - q.a[0], q.b[1] - q.a[1]) / 2 + 0.05;
    if (Math.abs((mx - at.x) * d.x + (mz - at.z) * d.z) < half + width / 2) return true;
  }
  return false;
}
