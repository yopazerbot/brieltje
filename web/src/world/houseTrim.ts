import * as THREE from 'three';
import type { Opening, Prism, RoofSpec } from './houseData';
import { prismGeometry } from './houseMeshes';
import { brickLook, Houses, isBrick } from './facadeLook';
import { houseStyle, PLINTH_BRICK_SHADE, rollerDown, type HouseStyle } from './houseStyle';
import { cutAt, planSteps, type BasePlan } from './housePlan';
import { inside, stable } from './houseKeys';
import { COVER, paneGeometry, type PaneLook } from './windows';
// The game's own south (its map's), so the panels face the sun at midday.
import { SOUTH } from '../ui/bigmap';

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
 * tiles' edge along each sloping gable edge (gable roofs), along both sloping ends and the high edge (shed roofs), up and
 * down both slopes at the ends of a closed one; a row of ridge tiles along the ridge (gable and hip roofs, a closed shed,
 * the larger half of a pair: world/roofPlan.ts). Leaves out an edge where a neighbour's wall stands against it.
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
  if (r.closed) {
    // A wedge closed with a second slope (world/roofPlan.ts): up the near slope to the ridge, down the far one.
    const { at, far } = r.closed;
    const k = (r.ridge - r.y) / Math.max(0.01, at);
    const kF = (r.ridge - far) / Math.max(0.01, W - at);
    for (const [a, side] of [[-o, -1], [L + o, 1]] as const) {
      if (!free(a + side * 0.3, W / 2)) continue;
      const n = along3.clone().multiplyScalar(side);
      const top = pt(a, at, r.ridge);
      verge(pt(a, -o, r.y - k * o), top, n);
      verge(top, pt(a, W + o, far - kF * o), n);
    }
  } else if (r.shape === 'shed') {
    const k = (r.ridge - r.y) / Math.max(0.5, W);
    const low = r.y - k * o;
    // Where something stands against the high side (the other half of a pair, a taller wall: world/roofPlan.ts), the
    // slope and the ends stop at it.
    const open = !r.tight;
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
  if (r.closed) {
    const { at, far } = r.closed;
    ridge = ridgeRow(pt(-o, at, r.ridge), pt(L + o, at, r.ridge), across3, (r.ridge - r.y) / Math.max(0.01, at), (r.ridge - far) / Math.max(0.01, W - at));
  } else if (r.crown !== undefined) {
    // The larger half of a pair: the pair's ridge row along its high edge, over the other half's slope too.
    ridge = ridgeRow(pt(-o, W, r.ridge), pt(L + o, W, r.ridge), across3, (r.ridge - r.y) / Math.max(0.5, W), r.crown);
  } else if (r.shape !== 'shed') {
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

/**
 * A row of ridge tiles from p to q (on the ridge), across the ridge along `side`, the slopes dropping k per metre (k2 on
 * the side `side` points to, when the two differ).
 */
function ridgeRow(p: THREE.Vector3, q: THREE.Vector3, side: THREE.Vector3, k: number, k2 = k): THREE.BufferGeometry {
  const s = 0.13;
  // The cross-section: [across, up] from the ridge line.
  const section: [number, number][] = [[-s, 0.005 - s * k], [-0.07, 0.055], [0, 0.075], [0.07, 0.055], [s, 0.005 - s * k2]];
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

/**
 * An edge trim round a flat roof's lid (an nb_roof block): a band 14 cm high over the given sides (world/housePlan.ts
 * `flatEdgeSides`), 4 cm in front of them, from 12 cm under the lid's top to 2 cm over it, a little longer than the
 * side so the corners close.
 */
export function flatEdge(p: Prism, colour: THREE.Color, sides: number[]): THREE.BufferGeometry[] {
  const ring = p.p[0];
  const out: THREE.BufferGeometry[] = [];
  for (const i of sides) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % ring.length];
    const length = Math.hypot(bx - ax, bz - az);
    const d = new THREE.Vector3((bx - ax) / length, 0, (bz - az) / length);
    const n = new THREE.Vector3(d.z, 0, -d.x);
    const mx = (ax + bx) / 2;
    const mz = (az + bz) / 2;
    if (inside(ring, mx + n.x * 0.05, mz + n.z * 0.05)) n.negate(); // outward
    out.push(face(new THREE.Vector3(mx + n.x * 0.04, p.y1 - 0.05, mz + n.z * 0.04), d, n, length + 0.08, 0.14, colour));
  }
  return out;
}

// ---- On the slopes: solar panels and roof windows ----

export type SolarArray = { q: [number, number, number][]; n: [number, number] };

/**
 * Solar panels and roof windows for a gable roof, by its house's style: an array of one or two rows of panels
 * (1.0 by 1.7 m) on the slope that faces south (none when both slopes face east and west), and one or two roof
 * windows of 0.78 by 1.18 m on the other slope (or the one the panels leave free). The panels go to world/surroundings.ts
 * `buildSolar` with the data's own; a roof window is a dark frame (for the frames' mesh) and glass lying on the tiles in
 * the windows' own glass (world/windows.ts: a dark room with its light off, so it mirrors the sky as their panes do by
 * day); no hole, as there is no room under these roofs to look into. `taken`: whether the data puts panels on this roof.
 */
export function roofExtras(r: RoofSpec, f: RoofFrame, style: HouseStyle, taken: boolean): { solar: SolarArray[]; frames: THREE.BufferGeometry[]; glass: THREE.BufferGeometry[] } {
  const none = { solar: [], frames: [], glass: [] };
  if ((r.shape ?? 'gable') !== 'gable' || r.lm || r.ceiling || r.windows || r.gableWindows || r.panels || taken) return none;
  const { c, L, W, along, across } = f;
  const o = OVERHANG;
  const eave = r.y - 0.15;
  const run = W / 2 + o;
  const S = Math.hypot(run, r.ridge - eave); // eave to ridge along the slope
  if (r.ridge - eave < 0.8 || L < 3) return none;
  /** A point on slope `s` (0: the side of p[0]-p[1], 1: the far side), `a` along, `u` up the slope from the eave, `lift` off the tiles. */
  const normal = (s: number) => new THREE.Vector3(across.x * (s ? 1 : -1) * (r.ridge - eave), run, across.y * (s ? 1 : -1) * (r.ridge - eave)).normalize();
  const at = (s: number, a: number, u: number, lift: number): THREE.Vector3 => {
    const b = s ? W + o - (u * run) / S : -o + (u * run) / S;
    const q = c[0].clone().addScaledVector(along, a).addScaledVector(across, b);
    return new THREE.Vector3(q.x, eave + (u / S) * (r.ridge - eave), q.y).addScaledVector(normal(s), lift);
  };
  // Which slope faces south, and how well.
  const facing = [-1, 1].map((k) => (across.x * SOUTH.x + across.y * SOUTH.z) * k); // (across.y is z)
  const sunny = facing[0] >= facing[1] ? 0 : 1;
  const solar: SolarArray[] = [];
  let used = -1;
  if (style.solar && facing[sunny] > 0.3) {
    const cols = Math.min(style.solar, Math.floor((L - 1.2) / 1.02));
    const rows = S >= 0.5 + 2 * 1.72 + 0.8 ? 2 : S >= 0.5 + 1.72 + 0.8 ? 1 : 0;
    if (cols >= 4 && rows) {
      const [a0, a1] = [L / 2 - cols * 0.51, L / 2 + cols * 0.51];
      const [u0, u1] = [0.5, 0.5 + rows * 1.72];
      // Corners 12 cm over the tiles (buildSolar's edge drops to them).
      solar.push({ q: [at(sunny, a0, u0, 0.12), at(sunny, a1, u0, 0.12), at(sunny, a1, u1, 0.12), at(sunny, a0, u1, 0.12)].map((v) => v.toArray() as [number, number, number]), n: [cols, rows] });
      used = sunny;
    }
  }
  const frames: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  if (style.roofWindows && r.ridge - r.y >= 3 && S >= 2.6) {
    const s = used === 0 ? 1 : used === 1 ? 0 : 1 - sunny; // the street side is not known: the slope the panels leave free
    const places = style.roofWindows === 2 && L >= 6 ? [L / 3, (2 * L) / 3] : [L / 2];
    const frame = new THREE.Color('#1f1d1b');
    const n = normal(s);
    const side = new THREE.Vector3(along.x, 0, along.y);
    const upSlope = n.clone().cross(side).normalize(); // side x upSlope = n
    const u = S * 0.5;
    places.forEach((a, k) => {
      frames.push(slopeQuad([at(s, a - 0.39, u - 0.59, 0.03), at(s, a + 0.39, u - 0.59, 0.03), at(s, a + 0.39, u + 0.59, 0.03), at(s, a - 0.39, u + 0.59, 0.03)], n, frame));
      // The pane, made upright at the origin as the windows' are, then laid on the slope.
      const centre = at(s, a, u, 0.045);
      const pane = paneGeometry(new THREE.Vector3(), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), 0.66, 1.06, { ...ROOF_PANE, seed: 0.62 + 0.3 * stable(centre.x, centre.z, k) }, centre.x + centre.z * 1.7);
      glass.push(pane.applyMatrix4(new THREE.Matrix4().makeBasis(side, upSlope, n).setPosition(centre)));
    });
  }
  return { solar, frames, glass };
}

/** A roof window's glass: nothing hung behind it, a dark room with its light off (a seed over one half), glossy. */
const ROOF_PANE: PaneLook = { cell: COVER.none, tint: new THREE.Color('#ffffff'), roughness: 0.05, f0: 0.2, mirror: false, room: 0.1, sill: 0, seed: 0.9 };

/** A quad of four corners (in order round it), facing n: the frames' attributes. */
function slopeQuad(v: THREE.Vector3[], n: THREE.Vector3, colour: THREE.Color): THREE.BufferGeometry {
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

// ---- Chimneys ----

/**
 * The roof of each house in this tile that gets the house's chimney (if its style has one): the largest gable or hip
 * roof over brick walls that is high and big enough, of a house with no chimney in the data already (a small brick
 * block standing above the eaves inside one of its roofs). Custom roofs (with windows, panels or a ceiling) and a
 * landmark's are left alone. A closed single slope counts as a gable, and so does the larger half of a pair (the one with
 * the ridge row: world/roofPlan.ts) with the other half's width (`partnerOf`).
 */
export function chimneyRoofs(roofs: RoofSpec[], prisms: Prism[], keyOf: (r: RoofSpec) => number, partnerOf: (r: RoofSpec) => RoofSpec | undefined = () => undefined): Map<RoofSpec, number> {
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
    const other = r.crown !== undefined ? partnerOf(r) : undefined;
    const shape = r.closed || other ? 'gable' : r.shape ?? 'gable';
    if (!r.wall || !isBrick(r.wall) || (shape !== 'gable' && shape !== 'hip') || r.windows || r.gableWindows || r.panels) continue;
    const width = other ? f.W + roofFrame(other).W : f.W;
    if (r.ridge - r.y < 1.5 || r.y - (r.base ?? r.y - 2.7) < 2.3 || f.L < 6 || width < 4.5) continue;
    if (other) {
      // The other half reaches both ends of the ridge (the stack stands on both halves, near an end).
      const span = other.p.map(([x, z]) => (x - f.c[0].x) * f.along.x + (z - f.c[0].y) * f.along.y);
      if (Math.min(...span) > 0.5 || Math.max(...span) < f.L - 0.5) continue;
    }
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
  // The ridge across from the low side, and the steeper slope's drop per metre: a gable's middle; a closed single
  // slope's ridge; the high edge of a pair's larger half (world/roofPlan.ts).
  let ridgeAt = W / 2;
  let k = (r.ridge - eave) / (W / 2 + OVERHANG);
  if (r.closed) {
    ridgeAt = r.closed.at;
    k = Math.max((r.ridge - r.y) / Math.max(0.01, r.closed.at), (r.ridge - r.closed.far) / Math.max(0.01, W - r.closed.at));
  } else if (r.crown !== undefined) {
    ridgeAt = W;
    k = Math.max((r.ridge - r.y) / Math.max(0.5, W), r.crown);
  }
  let a: number;
  if (r.shape === 'hip') {
    // Just inside the end of the ridge (or in its middle when it is short).
    const half = Math.min(L, W) / 2;
    const r0 = half;
    const r1 = Math.max(half, L - half);
    a = r1 - r0 < ch.along + 0.6 ? (r0 + r1) / 2 : ch.end === 0 ? r0 + ch.along / 2 + 0.3 : r1 - ch.along / 2 - 0.3;
  } else a = ch.end === 0 ? ch.from : L - ch.from;
  const pt = (da: number, db: number): [number, number] => {
    const q = c[0].clone().addScaledVector(along, a + da).addScaledVector(across, ridgeAt + db);
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

/**
 * A wall block cut in two along its base (world/housePlan.ts `planBases`): the cut runs its plan's height over the
 * ground at every point of the outline (which has points added where the ground bends), so the band follows the ground.
 * Below it the plinth's colour, or for a damp base the wall's own a little darker at the foot fading out up to the cut;
 * above it the wall's. The brick courses run on through (texture coordinates are heights in metres). The colour and
 * render byte as world/facadeLook.ts's walls have them; `key` the wall's house.
 */
export function bandedWalls(p: Prism, plan: BasePlan, key: number, groundAt: (x: number, z: number) => number): THREE.BufferGeometry {
  const g = prismGeometry({ ...p, p: [plan.ring, ...p.p.slice(1)] }, 2);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const mid = p.y0 + (p.y1 - p.y0) / 2;
  // Each corner's row: 0 at the foot, 1 the cut, 2 the top.
  const row = new Uint8Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    row[i] = Math.abs(y - mid) < 1e-3 ? 1 : y < mid ? 0 : 2;
    if (row[i] !== 1) continue;
    const cut = cutAt(plan, groundAt(pos.getX(i), pos.getZ(i)));
    pos.setY(i, cut);
    uv.setY(i, cut);
  }
  const look = brickLook(p.m, key);
  const colors = new Uint8Array(pos.count * 3);
  const facade = new Uint8Array(pos.count);
  const byte = (c: THREE.Color) => [c.r, c.g, c.b].map((v) => Math.round(Math.min(1, v) * 255));
  const wall = byte(look.tint);
  const damp = byte(look.tint.clone().multiplyScalar(DAMP));
  // A painted, cement or tarred plinth shows its colour (render shows the vertex colour at about the texture's mean).
  const plinth = plan.kind === 'none' ? null
    : byte(plan.colour ? new THREE.Color(plan.colour).multiplyScalar(1 / BRICK_MEAN) : look.tint.clone().multiplyScalar(PLINTH_BRICK_SHADE));
  const plinthRender = plan.render ? 255 : look.render * 255;
  for (let t = 0; t < pos.count; t += 3) {
    const below = row[t] < 2 && row[t + 1] < 2 && row[t + 2] < 2;
    for (let i = t; i < t + 3; i++) {
      if (below && plinth) {
        colors.set(plinth, i * 3);
        facade[i] = plinthRender;
      } else {
        colors.set(!plinth && row[i] === 0 ? damp : wall, i * 3);
        facade[i] = look.render * 255;
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
 * of a window. `flat`: the parts lying flat on the wall, for the trims' mesh; `solid`: the steps, for the frames'. `d`,
 * `n`: the wall's direction (d x up = n) and its outside; `mid` the opening's middle. `back`: how far the window sits
 * back from the wall's face (world/housePlan.ts `planReveals`): the roller shutter goes with it, in front of the glass.
 */
export function openingTrim(o: Opening, d: THREE.Vector3, n: THREE.Vector3, w: number, mid: THREE.Vector3, ctx: OpeningContext, back = 0): { flat: THREE.BufferGeometry[]; solid: THREE.BufferGeometry[] } {
  // The wall block the opening is in (a house is often blocks stacked on each other: the one at its height).
  const [wx, wz] = [mid.x - n.x * 0.3, mid.z - n.z * 0.3];
  const house = ctx.houses.wallAt(wx, wz, mid.y);
  if (!house) return { flat: [], solid: [] };
  const look = brickLook(house.m, house.key);
  const style = houseStyle(house.key, house.m, look.render === 1, ctx.pitched.has(house.key));
  const [y0, y1] = o.y;
  const h = y1 - y0;
  const out = (k: number, y = mid.y) => mid.clone().addScaledVector(n, k).setY(y);
  const parts: THREE.BufferGeometry[] = []; // flat on the wall (the trims' material, with its polygon offset)
  const solid: THREE.BufferGeometry[] = [];
  // Lintel: over the frame (5 cm above the opening), unless no wall of the house goes on above it.
  if (style.lintel !== 'none' && ctx.houses.holds(wx, wz, y1 + 0.25)) {
    if (style.lintel === 'stone') parts.push(face(out(0.03, y1 + 0.05 + 0.09), d, n, w + 0.24, 0.18, new THREE.Color('#d9d4c8')));
    else parts.push(face(out(0.03, y1 + 0.05 + 0.055), d, n, w + 0.1, 0.11, look.tint.clone().multiplyScalar(SOLDIER * BRICK_MEAN)));
  }
  // Bluestone steps up to a door, each block down to the ground under it (world/housePlan.ts).
  for (const s of planSteps(o, ctx.houses, ctx.groundAt)) {
    solid.push(box(out((s.from + s.to) / 2, (s.top + s.bottom) / 2), d, n, w + 0.3, s.top - s.bottom, s.to - s.from, new THREE.Color('#6b7177')));
  }
  if (o.k !== 'w') return { flat: parts, solid };
  const upper = y0 - ctx.groundAt(mid.x, mid.z) > 2;
  if (style.shutters && !upper && w < 1.9 && h < 1.9) {
    const colour = new THREE.Color(style.shutters);
    for (const side of [-1, 1]) {
      const centre = out(0.035).addScaledVector(d, side * (w / 2 + 0.06 + w / 4));
      const edge = centre.clone().addScaledVector(d, (side * w) / 4);
      // Only where the wall goes on and no other opening is in the way.
      const back = ctx.houses.wallAt(edge.x - n.x * 0.3, edge.z - n.z * 0.3, mid.y);
      if (!back || back.key !== house.key || blocked(ctx.list, o, centre, d, n, w / 2, y0, y1)) continue;
      parts.push(face(centre, d, n, w / 2, h + 0.1, colour));
    }
  }
  if (style.rollers) {
    const down = rollerDown(mid.x, mid.y, mid.z);
    if (down > 0) {
      // Strips 16 cm high with a centimetre between them, down from the top of the window.
      const colour = new THREE.Color(style.rollers);
      const reach = down * h;
      for (let top = y1; top > y1 - reach + 1e-3; top -= 0.17) {
        const strip = Math.min(0.16, top - (y1 - reach));
        parts.push(face(out(0.075 - back, top - strip / 2), d, n, w, strip, colour));
      }
    }
  }
  return { flat: parts, solid };
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
