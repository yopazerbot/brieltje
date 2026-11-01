import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { terrain } from './terrain';
import type { DipSpec, Opening, Prism, RoofSpec, Surroundings } from './houseData';
import { blockMaterial, paint, prismGeometry, tintedMaterial } from './houseMeshes';
import type { Piece, TileData } from './tiles';
import { fieldRows } from './fields';
import { sway } from './wind';
import { paneGeometry, paneLook, paneMaterial, COVER } from './windows';
import { waterClock, waterMaterial } from './water';
import { leafy } from './leaves';

/**
 * Around the plot, from Flemish open data (GRB footprints, DHM laser heights;
 * see tools/neighbours.py): the pitched roofs and gables of neighbouring
 * houses (their walls are ordinary blocks), and trees where the laser scan
 * found tall vegetation. Trees are made in code: a tapered trunk and a crown
 * of lumpy leaf clusters, in three shapes, drawn as instances (a few draw
 * calls for all of them).
 *
 * The neighbours' roofs carry tiles in their own colour, their gables the
 * brick of the walls below, and their walls windows, doors and garage doors
 * (made up in the style of the street by tools/facades.py): frames, doors
 * and sills are one draw call, the glass (mirroring the sky, with curtains,
 * nets and blinds behind it: world/windows.ts) another.
 * Fence posts along the garden fences are one more. Every pitched roof has gutters along its
 * eaves and downpipes to the ground (zinc grey unless the street survey says otherwise), all in
 * one draw call too. The street lamps on the poles, the cables between the poles and the solar
 * panels on the roofs (where the aerial photo shows them) are a few more.
 *
 * All of it is built per tile (world/tiles.ts), with materials shared by every tile; roof tiles
 * and the bricks of the gables carry their colour per vertex, so a tile is about twenty draw
 * calls whatever colours its roofs and walls have.
 */

const gableMat = new THREE.MeshStandardMaterial({ color: '#b98068', roughness: 0.9, side: THREE.DoubleSide });
const barkMat = new THREE.MeshStandardMaterial({ color: '#5b4a3a', roughness: 1, vertexColors: true });
const windowGlass = new THREE.MeshPhysicalMaterial({ color: '#dfeff5', roughness: 0.05, transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide });
const skylightFrame = new THREE.MeshStandardMaterial({ color: '#3a3634', roughness: 0.6, side: THREE.DoubleSide });
const gableFrame = new THREE.MeshStandardMaterial({ color: '#f3f1ec', roughness: 0.5, side: THREE.DoubleSide });
const leafMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
sway(leafMat, 0.03, 0.012, true); // the crowns move in the wind and are turning (world/wind.ts)
leafy(leafMat, 3); // and have leaves (world/leaves.ts), a tile of them 3 m across: clumps of about 40 cm
const gutterMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.55 });
const frameMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 });
// Opaque and glossy: from outside, windows mostly mirror the sky over what hangs behind them (world/windows.ts).
const paneMat = paneMaterial();
const postMat = new THREE.MeshStandardMaterial({ color: '#cfccc4', roughness: 0.9 });
const lampMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.5 });
const cableMat = new THREE.MeshStandardMaterial({ color: '#1d1e20', roughness: 0.6 });
const panelEdgeMat = new THREE.MeshStandardMaterial({ color: '#8f9398', roughness: 0.45, metalness: 0.6, side: THREE.DoubleSide });
let panelMat: THREE.MeshStandardMaterial | null = null;
/** Materials made on first use and shared by every tile (the roof tiles, the bungalow's gables and ceilings). */
const mats = new Map<string, THREE.Material>();
const material = (key: string, make: () => THREE.Material) => {
  if (!mats.has(key)) mats.set(key, make());
  return mats.get(key)!;
};

interface RoofParts {
  /** Gutters and downpipes (vertex colours) */
  gutters?: THREE.BufferGeometry | null;
  roof: THREE.BufferGeometry;
  gables: THREE.BufferGeometry;
  glass: THREE.BufferGeometry | null;
  frames: THREE.BufferGeometry | null;
  gableFrames: THREE.BufferGeometry | null;
  panels: THREE.BufferGeometry | null;
}

/**
 * Gable roof over a rectangle: ridge along the long sides, 30 cm overhang. Faces are wound to
 * point outwards, so the underside can have its own colour. Roof windows are holes in the
 * slopes, gable windows holes in the gables, each with glass and a frame.
 */
type V3 = THREE.Vector3;
type Tri = (out: number[], p: V3, q: V3, s: V3, up: boolean) => void;
type Quad = (out: number[], p: V3, q: V3, s: V3, t: V3, up?: boolean) => void;

/**
 * A hip roof (all four sides slope, the ridge shortened at both ends, 45 degrees in plan) or a
 * shed roof (one slope from the low side p[0]-p[1] to the high side, with the end walls and the
 * high wall up to it in the wall's brick). Same overhang as the gable roofs.
 */
function sloped(r: RoofSpec, c: THREE.Vector2[], L: number, W: number, along: THREE.Vector2, across: THREE.Vector2, o: number,
  wall: (a: number, b: number, y: number) => V3, tri: Tri, quad: Quad): RoofParts {
  const roofPos: number[] = [];
  const roofUv: number[] = [];
  const wallPos: number[] = [];
  const wallUv: number[] = [];
  /** Positions added since `from`, with texture coordinates in metres: u along `dir`, v up the slope or the wall. */
  const uvs = (pos: number[], uv: number[], from: number, dir: THREE.Vector2, stretch: number) => {
    for (let i = from; i < pos.length; i += 3) {
      const x = pos[i] - c[0].x;
      const z = pos[i + 2] - c[0].y;
      uv.push(x * dir.x + z * dir.y, pos[i + 1] * stretch);
    }
  };
  if (r.shape === 'hip') {
    const edge = r.y - 0.15; // the overhang drops a little, as on the gable roofs
    const run = W / 2 + o;
    const stretch = Math.hypot(r.ridge - edge, run) / Math.max(0.01, r.ridge - edge);
    const half = Math.min(L, W) / 2;
    const r0 = wall(half, W / 2, r.ridge);
    const r1 = wall(Math.max(half, L - half), W / 2, r.ridge);
    const e = [wall(-o, -o, edge), wall(L + o, -o, edge), wall(L + o, W + o, edge), wall(-o, W + o, edge)];
    for (const [pts, dir] of [[[e[0], e[1], r1, r0], along], [[e[2], e[3], r0, r1], along], [[e[3], e[0], r0], across], [[e[1], e[2], r1], across]] as const) {
      const from = roofPos.length;
      if (pts.length === 4 && pts[2].distanceTo(pts[3]) > 0.01) quad(roofPos, pts[0], pts[1], pts[2], pts[3]);
      else tri(roofPos, pts[0], pts[1], pts[2], true);
      uvs(roofPos, roofUv, from, dir, stretch);
    }
  } else {
    const k = (r.ridge - r.y) / Math.max(0.5, W); // rise per metre across
    const stretch = Math.hypot(1, k) / Math.max(0.01, k);
    const from = roofPos.length;
    quad(roofPos, wall(-o, -o, r.y - k * o), wall(L + o, -o, r.y - k * o), wall(L + o, W + o, r.ridge + k * o), wall(-o, W + o, r.ridge + k * o));
    uvs(roofPos, roofUv, from, along, stretch);
    // The walls under the slope: a triangle at each end, the high wall along the back.
    for (const a of [0, L]) {
      const w0 = wallPos.length;
      tri(wallPos, wall(a, 0, r.y), wall(a, W, r.y), wall(a, W, r.ridge), false);
      uvs(wallPos, wallUv, w0, across, 1);
    }
    const w0 = wallPos.length;
    quad(wallPos, wall(0, W, r.y), wall(L, W, r.y), wall(L, W, r.ridge), wall(0, W, r.ridge), false);
    uvs(wallPos, wallUv, w0, along, 1);
  }
  const make = (pos: number[], uv: number[]) => {
    const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    return g;
  };
  // An empty wall set still needs the attributes the merged gables have.
  return { roof: make(roofPos, roofUv), gables: make(wallPos, wallUv), glass: null, frames: null, gableFrames: null, panels: null };
}

/**
 * Gutters along a roof's eaves and a downpipe from each down to the ground, against the wall:
 * the eaves of both long sides of a gable roof, all four of a hip roof, the low side of a shed.
 */
function gutters(r: RoofSpec, c: THREE.Vector2[], L: number, W: number, along: THREE.Vector2, across: THREE.Vector2, o: number, eave: number): THREE.BufferGeometry | null {
  const color = new THREE.Color(r.gutter ?? '#8f9396');
  const base = r.base ?? r.y - 2.7;
  const up = new THREE.Vector3(0, 1, 0);
  const box = (at: THREE.Vector3, d: THREE.Vector3, n: THREE.Vector3, w: number, h: number, t: number) => {
    if (d.clone().cross(up).dot(n) < 0) d = d.clone().negate(); // right-handed, so faces point out
    return slab(at, d, n, w, h, t, color);
  };
  const v3 = (v: THREE.Vector2, y = 0) => new THREE.Vector3(v.x, y, v.y);
  const corner = (a: number, b: number) => c[0].clone().addScaledVector(along, a).addScaledVector(across, b);
  // Each eave: from, to (with the overhang), outward, and whether it gets a downpipe.
  const lines: [THREE.Vector2, THREE.Vector2, THREE.Vector2][] = [[corner(-o, -o), corner(L + o, -o), across.clone().negate()]];
  if (r.shape !== 'shed') lines.push([corner(-o, W + o), corner(L + o, W + o), across.clone()]);
  if (r.shape === 'hip') lines.push([corner(-o, -o), corner(-o, W + o), along.clone().negate()], [corner(L + o, -o), corner(L + o, W + o), along.clone()]);
  const out: THREE.BufferGeometry[] = [];
  lines.forEach(([p, q, n], k) => {
    const d = v3(q.clone().sub(p).normalize());
    const nn = v3(n);
    const length = p.distanceTo(q);
    out.push(box(v3(p.clone().add(q).multiplyScalar(0.5).addScaledVector(n, 0.07), eave - 0.06), d, nn, length, 0.1, 0.13));
    if (k > 1 || eave - base < 1.5) return; // downpipes on the two long sides only
    // Near one end (opposite ends on the two sides): along the wall, then a short bend out to the gutter.
    const at = k === 0 ? p.clone().addScaledVector(q.clone().sub(p).normalize(), o + 0.3) : q.clone().addScaledVector(p.clone().sub(q).normalize(), o + 0.3);
    const wall = at.clone().addScaledVector(n, -o + 0.06);
    out.push(box(v3(wall, (base + eave - 0.2) / 2), d, nn, 0.08, eave - 0.2 - base, 0.08));
    out.push(box(v3(wall.clone().addScaledVector(n, (o + 0.01) / 2), eave - 0.17), d, nn, 0.08, 0.07, o + 0.07));
  });
  const g = mergeGeometries(out);
  out.forEach((x) => x.dispose());
  return g;
}

function roof(r: RoofSpec): RoofParts {
  const c = r.p.map(([x, z]) => new THREE.Vector2(x, z));
  // Make c[0]-c[1] a long side (unless windows are measured from the corners as given).
  if (!r.fixed && !r.windows && !r.gableWindows && c[0].distanceTo(c[1]) < c[1].distanceTo(c[2])) c.push(c.shift()!);
  const L = c[0].distanceTo(c[1]);
  const W = c[0].distanceTo(c[3]);
  const along = c[1].clone().sub(c[0]).normalize();
  const across = c[3].clone().sub(c[0]).normalize();
  const o = 0.3;
  const eave = r.y - 0.15; // the overhang drops a little
  const gutter = gutters(r, c, L, W, along, across, o, eave);
  const mid = new THREE.Vector3(c[0].x + (c[2].x - c[0].x) / 2, (r.y + r.ridge) / 2, c[0].y + (c[2].y - c[0].y) / 2);
  /** The roof surface at (a along, b across), and a point of a gable at (b across, height y). */
  const at = (a: number, b: number, lift = 0): THREE.Vector3 => {
    const q = c[0].clone().addScaledVector(along, a).addScaledVector(across, b);
    const t = b <= W / 2 ? (b + o) / (W / 2 + o) : (W + o - b) / (W / 2 + o);
    return new THREE.Vector3(q.x, eave + t * (r.ridge - eave) + lift, q.y);
  };
  const wall = (a: number, b: number, y: number) => {
    const q = c[0].clone().addScaledVector(along, a).addScaledVector(across, b);
    return new THREE.Vector3(q.x, y, q.y);
  };
  /** A triangle, wound so that its face points away from `inside` (or up, for the slopes). */
  const tri = (out: number[], p: THREE.Vector3, q: THREE.Vector3, s: THREE.Vector3, up: boolean) => {
    const n = q.clone().sub(p).cross(s.clone().sub(p));
    const outward = up ? n.y > 0 : n.dot(p.clone().add(q).add(s).divideScalar(3).sub(mid)) > 0;
    const [b2, b3] = outward ? [q, s] : [s, q];
    out.push(...p.toArray(), ...b2.toArray(), ...b3.toArray());
  };
  const quad = (out: number[], p: THREE.Vector3, q: THREE.Vector3, s: THREE.Vector3, t: THREE.Vector3, up = true) => {
    tri(out, p, q, s, up);
    tri(out, p, s, t, up);
  };
  const geo = (pos: number[]) => {
    if (!pos.length) return null;
    const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  };
  if (r.shape === 'hip' || r.shape === 'shed') return { ...sloped(r, c, L, W, along, across, o, wall, tri, quad), gutters: gutter };

  // Slopes: one each side of the ridge, cut into strips around the roof windows.
  const roofPos: number[] = [];
  const glassPos: number[] = [];
  const framePos: number[] = [];
  const holes = r.windows ?? [];
  for (const [b0, b1] of [[-o, W / 2], [W / 2, W + o]]) {
    const own = holes.filter((h) => h.b[0] >= b0 - 1e-6 && h.b[1] <= b1 + 1e-6);
    const cuts = [-o, L + o, ...own.flatMap((h) => h.a)].sort((x, y) => x - y);
    for (let i = 0; i < cuts.length - 1; i++) {
      const [a0, a1] = [cuts[i], cuts[i + 1]];
      if (a1 - a0 < 1e-6) continue;
      const m = (a0 + a1) / 2;
      let b = b0;
      for (const h of own.filter((h) => h.a[0] <= m && m <= h.a[1]).sort((x, y) => x.b[0] - y.b[0])) {
        if (h.b[0] > b) quad(roofPos, at(a0, b), at(a1, b), at(a1, h.b[0]), at(a0, h.b[0]));
        b = h.b[1];
      }
      if (b1 > b) quad(roofPos, at(a0, b), at(a1, b), at(a1, b1), at(a0, b1));
    }
    for (const h of own) {
      const [ha0, ha1] = h.a;
      const [hb0, hb1] = h.b;
      quad(glassPos, at(ha0, hb0), at(ha1, hb0), at(ha1, hb1), at(ha0, hb1));
      const f = 0.06; // frame: four strips just above the slope
      quad(framePos, at(ha0, hb0, 0.03), at(ha1, hb0, 0.03), at(ha1, hb0 + f, 0.03), at(ha0, hb0 + f, 0.03));
      quad(framePos, at(ha0, hb1 - f, 0.03), at(ha1, hb1 - f, 0.03), at(ha1, hb1, 0.03), at(ha0, hb1, 0.03));
      quad(framePos, at(ha0, hb0, 0.03), at(ha0 + f, hb0, 0.03), at(ha0 + f, hb1, 0.03), at(ha0, hb1, 0.03));
      quad(framePos, at(ha1 - f, hb0, 0.03), at(ha1, hb0, 0.03), at(ha1, hb1, 0.03), at(ha1 - f, hb1, 0.03));
    }
  }

  // Gables: a triangle at each end, with holes for gable windows.
  const gablePos: number[] = [];
  const gableFramePos: number[] = [];
  for (const end of [0, 1] as const) {
    const a = end === 0 ? 0 : L;
    const shape = new THREE.Shape([new THREE.Vector2(0, r.y), new THREE.Vector2(W, r.y), new THREE.Vector2(W / 2, r.ridge - 0.1)]);
    const own = (r.gableWindows ?? []).filter((g) => g.end === end);
    for (const g of own) {
      shape.holes.push(new THREE.Path([new THREE.Vector2(g.b[0], g.y[0]), new THREE.Vector2(g.b[1], g.y[0]), new THREE.Vector2(g.b[1], g.y[1]), new THREE.Vector2(g.b[0], g.y[1])]));
      const n = end === 0 ? -0.02 : 0.02; // glass and frame just outside the gable
      quad(glassPos, wall(a + n, g.b[0], g.y[0]), wall(a + n, g.b[1], g.y[0]), wall(a + n, g.b[1], g.y[1]), wall(a + n, g.b[0], g.y[1]), false);
      const f = 0.06;
      for (const [x0, x1, y0, y1] of [[g.b[0], g.b[1], g.y[0], g.y[0] + f], [g.b[0], g.b[1], g.y[1] - f, g.y[1]], [g.b[0], g.b[0] + f, g.y[0], g.y[1]], [g.b[1] - f, g.b[1], g.y[0], g.y[1]]]) {
        quad(gableFramePos, wall(a + 2 * n, x0, y0), wall(a + 2 * n, x1, y0), wall(a + 2 * n, x1, y1), wall(a + 2 * n, x0, y1), false);
      }
    }
    const flat = new THREE.ShapeGeometry(shape);
    const p = flat.attributes.position;
    const idx = flat.index!;
    for (let i = 0; i < idx.count; i += 3) {
      const v = [0, 1, 2].map((k) => wall(a, p.getX(idx.getX(i + k)), p.getY(idx.getX(i + k))));
      tri(gablePos, v[0], v[1], v[2], false);
    }
    flat.dispose();
  }

  // Panels: upright quads with a sloping top (sides of roof-window wells, walls up to the roof).
  const panelPos: number[] = [];
  for (const q of r.panels ?? []) {
    const [ax, az] = q.a;
    const [bx, bz] = q.b;
    const v = [new THREE.Vector3(ax, q.y0, az), new THREE.Vector3(bx, q.y0, bz), new THREE.Vector3(bx, q.yb, bz), new THREE.Vector3(ax, q.ya, az)];
    panelPos.push(...v[0].toArray(), ...v[1].toArray(), ...v[2].toArray(), ...v[0].toArray(), ...v[2].toArray(), ...v[3].toArray());
  }
  // Texture coordinates in metres: tiles run along the ridge with their rows parallel to the
  // eaves (v up the slope); gables run across with v the height, so brick courses line up
  // with the walls below.
  const slope = Math.hypot(r.ridge - eave, W / 2 + o) / Math.max(0.01, r.ridge - eave);
  const roofGeo = geo(roofPos)!;
  const gableGeo = geo(gablePos)!;
  for (const [g, uvOf] of [
    [roofGeo, (x: number, y: number, z: number) => [(x - c[0].x) * along.x + (z - c[0].y) * along.y, (y - eave) * slope]],
    [gableGeo, (x: number, y: number, z: number) => [(x - c[0].x) * across.x + (z - c[0].y) * across.y, y]],
  ] as const) {
    const p = g.attributes.position;
    const uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) uv.set(uvOf(p.getX(i), p.getY(i), p.getZ(i)), i * 2);
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  return { roof: roofGeo, gables: gableGeo, glass: geo(glassPos), frames: geo(framePos), gableFrames: geo(gableFramePos), panels: geo(panelPos), gutters: gutter };
}

/** A box `w` wide (along `d`), `h` high and `t` deep (along `n`), centred at `at`, in one colour. */
function slab(at: THREE.Vector3, d: THREE.Vector3, n: THREE.Vector3, w: number, h: number, t: number, color: THREE.Color): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, t).toNonIndexed();
  g.deleteAttribute('uv');
  g.applyMatrix4(new THREE.Matrix4().makeBasis(d, new THREE.Vector3(0, 1, 0), n).setPosition(at));
  const colors = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([color.r, color.g, color.b], i);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/**
 * Windows, doors and garage doors on the neighbours' walls: a frame standing a few
 * centimetres proud of the brick, glass (or a door panel) in it, a centre bar on wide
 * windows and a stone sill under each window. `ground`: the flat ground's height, to tell
 * the ground floor's windows from those above.
 */
function buildOpenings(list: Opening[], ground: number): Piece[] {
  const solid: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  const sill = new THREE.Color('#d8d3c7');
  list.forEach((o, i) => {
    const a = new THREE.Vector3(o.a[0], 0, o.a[1]);
    const b = new THREE.Vector3(o.b[0], 0, o.b[1]);
    const w = a.distanceTo(b);
    const d = b.clone().sub(a).normalize();
    const n = new THREE.Vector3(o.n[0], 0, o.n[1]).normalize();
    // Keep the box's frame right-handed (d x up = n) whichever way the wall runs, so faces point out.
    if (d.clone().cross(new THREE.Vector3(0, 1, 0)).dot(n) < 0) d.negate();
    const [y0, y1] = o.y;
    const h = y1 - y0;
    const mid = a.clone().add(b).multiplyScalar(0.5).setY((y0 + y1) / 2);
    const out = (k: number) => mid.clone().addScaledVector(n, k);
    const frame = new THREE.Color(o.f);
    solid.push(slab(out(0.02), d, n, w + 0.1, h + 0.1, 0.05, frame));
    if (o.k === 'w') {
      const upper = y0 - (ground + terrain.height(mid.x, mid.z)) > 2;
      glass.push(paneGeometry(out(0.053), d, n, w, h, paneLook(mid.x, mid.z, n.x, n.z, upper, i, h >= 1.9), mid.x + mid.y + mid.z * 1.7));
      if (w > 1.3) solid.push(slab(out(0.056), d, n, 0.06, h, 0.02, frame));
      if (h < 1.9) solid.push(slab(out(0.06).setY(y0 - 0.075), d, n, w + 0.2, 0.05, 0.14, sill)); // not under garden doors
    } else if (o.k === 'd') {
      const panel = new THREE.Color(o.c ?? '#6b4a32');
      solid.push(slab(out(0.05), d, n, w, h, 0.02, panel));
      glass.push(paneGeometry(out(0.067).setY(y0 + h * 0.72), d, n, w * 0.3, h * 0.35, { ...paneLook(mid.x, mid.z, n.x, n.z, false, i), cell: COVER.none }, mid.x + mid.z * 1.7));
      solid.push(slab(out(0.07).addScaledVector(d, w * 0.38).setY(y0 + 1.05), d, n, 0.03, 0.18, 0.03, new THREE.Color('#9a9a96')));
    } else {
      // Garage door: horizontal sections with a groove between them.
      const panel = new THREE.Color(o.c ?? '#ece8df');
      const k = 5;
      for (let s = 0; s < k; s++) solid.push(slab(out(0.05).setY(y0 + (h * (s + 0.5)) / k), d, n, w, h / k - 0.02, 0.02, panel));
    }
  });
  const out: Piece[] = [];
  const add = (geos: THREE.BufferGeometry[], material: THREE.Material, tag: string) => {
    if (!geos.length) return;
    out.push({ material, geometry: mergeGeometries(geos), tag, shadow: false, small: true });
    geos.forEach((g) => g.dispose());
  };
  add(solid, frameMat, 'alu');
  add(glass, paneMat, 'black_glass');
  return out;
}

const postGeo = new THREE.BoxGeometry(0.1, 1, 0.1).translate(0, 0.5, 0);

/** Concrete posts along the garden fences: [x, z, height] each, standing on the ground. */
function buildPosts(list: [number, number, number][], ground: number): Piece {
  const at = list.map(([x, z, h]) => new THREE.Matrix4().makeScale(1, h, 1).setPosition(x, ground + terrain.height(x, z) - 0.05, z));
  return { material: postMat, geometry: postGeo, tag: 'concrete', shadow: false, at, small: true };
}

/**
 * A ball of leaves of radius `r`, lumpy but smooth: an icosphere with its points pushed in and out by
 * a wave over it, and indexed: every corner is worked out once instead of once per triangle. No
 * texture coordinates: the leaves (world/leaves.ts) are laid on from the sides.
 */
function leafBall(r: number, detail: number, rand: () => number, lumpy = 1): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, detail);
  g.deleteAttribute('uv');
  g.rotateX(rand() * Math.PI).rotateY(rand() * Math.PI * 2);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nor = g.attributes.normal as THREE.BufferAttribute;
  const w = rand() * 6;
  for (let k = 0; k < pos.count; k++) {
    const x = pos.getX(k) / r, y = pos.getY(k) / r, z = pos.getZ(k) / r;
    const f = 1 + lumpy * (0.11 * Math.sin(x * 4.1 + w) * Math.sin(z * 3.7 + w * 2) + 0.07 * Math.sin(y * 5.3 + w * 3));
    pos.setXYZ(k, x * r * f, y * r * f, z * r * f);
    nor.setXYZ(k, x, y, z);
  }
  const out = mergeVertices(g);
  g.dispose();
  return out;
}

/**
 * A tree crown: balls of leaves round a core, darker inside and below (the leaves there get less of the
 * sky), each ball a little lighter or darker than the next. Unit size: about 1 m radius, centred at y = 0.
 * Full: a core and 12 to 14 balls of 80 triangles; simple: a core of 80 and five of 20; bough: three of
 * 20 (a tall tree's lower boughs). The leaves (world/leaves.ts) give the balls their texture and outline.
 */
function crown(seed: number, kind: 'full' | 'simple' | 'bough' = 'full'): THREE.BufferGeometry {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  // Balls as [x, y, z, radius, detail]: on a shell round the middle, fewer underneath, the core inside.
  // The core comes last: where the balls round it are drawn first, the graphics chip skips what they hide of it.
  const balls: [number, number, number, number, number][] = [];
  const n = kind === 'full' ? 12 + Math.floor(rand() * 3) : kind === 'simple' ? 5 : 3;
  for (let i = 0; i < n; i++) {
    // A spiral down the shell, so the balls spread evenly whatever their number.
    const y = 0.92 - (1.7 * (i + 0.5)) / n;
    const a = i * 2.39996 + rand() * 0.6;
    const ring = Math.sqrt(1 - y * y);
    const d = kind === 'bough' ? 0.45 : 0.5 + rand() * 0.1;
    const r = kind === 'full' ? 0.3 + rand() * 0.12 : kind === 'simple' ? 0.4 + rand() * 0.08 : 0.5 + rand() * 0.1;
    balls.push([Math.cos(a) * ring * d, y * d * 0.85 + 0.08, Math.sin(a) * ring * d, r, kind === 'full' ? 1 : 0]);
  }
  if (kind !== 'bough') balls.push([0, 0.05, 0, kind === 'full' ? 0.6 : 0.68, 1]);
  const parts: THREE.BufferGeometry[] = [];
  const tints: number[] = [];
  for (const [x, y, z, r, detail] of balls) {
    const g = leafBall(r, detail, rand).translate(x, y, z);
    // The normals between the ball's own and the whole crown's: lit as one crown, not as a heap of balls.
    const pos = g.attributes.position as THREE.BufferAttribute;
    const nor = g.attributes.normal as THREE.BufferAttribute;
    const own = new THREE.Vector3();
    const whole = new THREE.Vector3();
    for (let k = 0; k < pos.count; k++) {
      own.fromBufferAttribute(nor, k);
      whole.fromBufferAttribute(pos, k).normalize();
      own.lerp(whole, 0.5).normalize();
      nor.setXYZ(k, own.x, own.y, own.z);
    }
    parts.push(g);
    tints.push(0.88 + rand() * 0.24);
  }
  const geo = mergeGeometries(parts);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const light = new THREE.Color('#628040');
  const dark = new THREE.Color('#203318');
  const c = new THREE.Color();
  const p = new THREE.Vector3();
  let k = 0;
  parts.forEach((part, b) => {
    for (let i = 0; i < part.attributes.position.count; i++, k++) {
      p.fromBufferAttribute(pos, k);
      // Out in the crown and up: lit. Deep inside and underneath: in the crown's own shade.
      const out = Math.min(1, p.length() / 0.95);
      const up = Math.min(1, Math.max(0, p.y * 0.6 + 0.5));
      c.copy(dark).lerp(light, Math.min(1, out * out * 0.55 + up * 0.5)).multiplyScalar(tints[b]);
      colors.set([c.r, c.g, c.b], k * 3);
    }
    part.dispose();
  });
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  // As wide as the old single lumps reached (about 1 either way), less the cut-away outline.
  return kind === 'bough' ? geo : geo.scale(1.15, 1, 1.15);
}

/** A trunk 1 m tall, tapering; darker towards the top, where it goes up into the crown's shade. */
function trunkShape(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.06, 0.1, 1, 7, 2).translate(0, 0.5, 0);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  for (let k = 0; k < pos.count; k++) colors.fill(1 - 0.55 * THREE.MathUtils.smoothstep(pos.getY(k), 0.3, 1), k * 3, k * 3 + 3);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/**
 * Drawing order (opaque things go by material otherwise): walls and roofs first, then trees,
 * then the ground covers, then the lawn (main.ts). What a house hides is then not worked out first:
 * the graphics chip skips pixels behind what is already drawn.
 */
const TREE_ORDER = 0.4;
const COVER_ORDER = 0.5;
const GROUND_COVERS = new Set(['road', 'field_soil', 'field_dark', 'field_crop', 'forest', 'pave_light', 'pave_warm', 'pave_grey', 'pave_walk', 'gravel', 'track']);

/** m: trees this tall get a second, lower crown (their lower boughs). */
const LOW_BOUGHS = 15;

/** The tree shapes: three crowns in full and simplified, the lower boughs and a trunk; made once. */
let treeShapes: { full: THREE.BufferGeometry[]; simple: THREE.BufferGeometry[]; bough: THREE.BufferGeometry; trunk: THREE.BufferGeometry } | null = null;

type Pole = NonNullable<Surroundings['poles']>[number];

/**
 * One tile of the surroundings, as pieces for the batches (world/tiles.ts): its blocks (walls,
 * ground covers, hedges, fences) merged per material, and its roofs, windows, posts, lamps,
 * panels and trees. `poles` is the whole list of poles (a tile's cables reach poles in the next
 * one); `detail` says where trees get their full crowns (round the house and the church).
 */
export function buildTile(data: TileData, poles: Pole[], renderer: THREE.WebGLRenderer, ground: number, detail: (x: number, z: number) => boolean): Piece[] {
  // Geometry per material, merged at the end: blocks, roofs and gables together.
  const parts = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; tag: string; shadow: boolean; order?: number; small?: boolean }>();
  const put = (mat: THREE.Material, g: THREE.BufferGeometry, tag: string, shadow = true, order?: number, small?: boolean) => {
    const e = parts.get(mat);
    if (e) e.geos.push(g);
    else parts.set(mat, { geos: [g], tag, shadow, order, small });
  };
  const coloured = (m: THREE.Material) => (m as THREE.MeshStandardMaterial).vertexColors;
  for (const p of data.prisms ?? []) {
    const { material: mat, tint, tag } = blockMaterial(p.m, renderer);
    const g = prismGeometry(p);
    fieldRows(g, p); // the fields' rows (world/fields.ts)
    put(mat, coloured(mat) ? paint(g, tint) : g, tag, true, GROUND_COVERS.has(p.m) ? COVER_ORDER : undefined);
  }

  // Roofs: the tiles in their colour per vertex, the gables in the brick of the walls below. A roof
  // over a room (the bungalow's) has a ceiling colour: then the outside (front faces) and the
  // underside (back faces) differ.
  const tiles = material('tiles', () => Object.assign(tintedMaterial('roof_tiles', '#ffffff', renderer, THREE.DoubleSide), { vertexColors: true }));
  const gutterGeos: THREE.BufferGeometry[] = [];
  for (const r of data.roofs) {
    const g = roof(r);
    if (g.gutters) gutterGeos.push(g.gutters);
    const side = r.ceiling ? THREE.FrontSide : THREE.DoubleSide;
    const tint = r.tiles ?? '#4a3f3a';
    if (r.ceiling) put(material(`tiles|${tint}|${side}`, () => tintedMaterial('roof_tiles', tint, renderer, side)), g.roof, 'nb_roof');
    else put(tiles, paint(g.roof, new THREE.Color(tint)), 'nb_roof');
    if (r.wall) {
      const { material: mat, tint: brick, tag } = blockMaterial(r.wall, renderer);
      put(mat, coloured(mat) ? paint(g.gables, brick) : g.gables, tag);
    } else {
      put(r.gable || r.ceiling ? material(`gable|${r.gable}|${side}`, () => new THREE.MeshStandardMaterial({ color: r.gable ?? '#b98068', roughness: 0.9, side })) : gableMat, g.gables, 'nb_roof');
    }
    if (r.ceiling) {
      const under = material(`under|${r.ceiling}`, () => new THREE.MeshStandardMaterial({ color: r.ceiling, roughness: 0.95, side: THREE.BackSide }));
      put(under, g.roof.clone(), 'nb_roof', false);
      put(under, g.gables.clone(), 'nb_roof', false);
    }
    const inside = r.ceiling ? material(`inside|${r.ceiling}`, () => new THREE.MeshStandardMaterial({ color: r.ceiling, roughness: 0.9, side: THREE.DoubleSide })) : gableMat;
    if (g.glass) put(windowGlass, g.glass, 'glass', false, 1);
    if (g.frames) put(skylightFrame, g.frames, 'nb_roof');
    if (g.gableFrames) put(gableFrame, g.gableFrames, 'nb_roof');
    if (g.panels) put(inside, g.panels, 'nb_roof');
  }
  if (gutterGeos.length) put(gutterMat, mergeGeometries(gutterGeos), 'steel', true, undefined, true);
  gutterGeos.forEach((g) => g.dispose());
  const out: Piece[] = [];
  for (const [mat, { geos, tag, shadow, order, small }] of parts) {
    out.push({ material: mat, geometry: geos.length > 1 ? mergeGeometries(geos) : geos[0], tag, shadow, order, small });
    if (geos.length > 1) geos.forEach((g) => g.dispose());
  }
  if (data.openings?.length) out.push(...buildOpenings(data.openings, ground));
  if (data.poleIds.length || data.wires?.length) out.push(...buildLamps(poles, data.poleIds, data.wires ?? [], ground));
  if (data.solar?.length) out.push(...buildSolar(data.solar));
  if (data.posts?.length) out.push(buildPosts(data.posts, ground));
  if (data.trees.length) out.push(...buildTrees(data.trees, detail));
  return out;
}

/**
 * Trees: three crown shapes and a trunk, each tree a copy of one. Round the house and the church
 * full crowns that cast shadows; elsewhere (the woods and tree rows further out) simpler crowns
 * (180 triangles instead of about 1000) that cast none. A tall tree has its lower boughs too: a crown
 * of 20 triangles under the big one, without a shadow, drawn within the draw distance of details.
 */
function buildTrees(trees: Surroundings['trees'], detail: (x: number, z: number) => boolean): Piece[] {
  treeShapes ??= {
    full: [0, 1, 2].map((k) => crown(1234 + k * 999)),
    simple: [0, 1, 2].map((k) => crown(1234 + k * 999, 'simple')),
    bough: crown(4321, 'bough').scale(1.15, 1, 1.15),
    trunk: trunkShape(),
  };
  const shapes = treeShapes;
  const crowns: THREE.Matrix4[][] = [[], [], [], [], [], []];
  const boughs: THREE.Matrix4[] = [];
  const trunks: THREE.Matrix4[] = [];
  const q = new THREE.Quaternion();
  const lean = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const axis = new THREE.Vector3();
  for (const t of trees) {
    // The shape by position, so a tree looks the same whichever tile or file it comes in.
    const k = (Math.abs(Math.round(t.x * 7 + t.z * 13)) % 3) + (detail(t.x, t.z) ? 0 : 3);
    // A tall tree's crown is most of its height and wide (the woods' oaks, beeches and poplars of
    // 20 to 25 m start branching at a third of it); the laser scan's crown radius stops at 4.5 m, so a
    // tall tree was a small ball on a long bare pole. Trees up to about 15 m hardly change.
    const crownR = Math.min(7, Math.max(t.r, t.h * 0.26));
    const crownH = Math.min(t.h * 0.75, Math.max(crownR * 2.2, t.h * 0.6));
    const trunkH = t.h - crownH * 0.6;
    const turn = (t.x * 7.3 + t.z * 3.1) % (Math.PI * 2);
    q.setFromAxisAngle(up, turn);
    // Each crown its own: a little wider one way than the other, taller or flatter, leaning a few
    // degrees, all from its place (three shapes turned and stretched read as many).
    const h = (n: number) => {
      const v = Math.sin(t.x * (12.9898 + n) + t.z * (78.233 - n)) * 43758.5453;
      return v - Math.floor(v);
    };
    const tilt = (h(3) - 0.5) * 0.14;
    lean.setFromAxisAngle(axis.set(Math.cos(h(4) * 6.283), 0, Math.sin(h(4) * 6.283)), tilt).multiply(q);
    const size = new THREE.Vector3(crownR * (0.88 + 0.24 * h(1)), crownH * 0.6 * (0.9 + 0.2 * h(5)), crownR * (0.88 + 0.24 * h(2)));
    crowns[k].push(new THREE.Matrix4().compose(new THREE.Vector3(t.x, t.y + t.h - crownH * 0.55, t.z), lean, size));
    if (t.h >= LOW_BOUGHS) {
      // Under it the lower boughs, a little to one side, down to about a quarter of the height: the bare
      // trunk below them, as at the edge of a wood. No shadow of their own: the crown above casts one over
      // the same ground.
      const r = crownR * 0.85;
      const side = crownR * 0.18;
      boughs.push(new THREE.Matrix4().compose(
        new THREE.Vector3(t.x + Math.cos(turn) * side, t.y + t.h * 0.41, t.z + Math.sin(turn) * side), q, new THREE.Vector3(r, t.h * 0.17, r)));
    }
    const girth = Math.max(1, t.h / 6.5); // a 25 m trunk about 75 cm across at the foot
    trunks.push(new THREE.Matrix4().compose(new THREE.Vector3(t.x, t.y, t.z), q, new THREE.Vector3(girth, trunkH, girth)));
  }
  const out: Piece[] = crowns.flatMap((at, k) =>
    at.length ? [{ material: leafMat, geometry: k < 3 ? shapes.full[k] : shapes.simple[k - 3], tag: 'hedge', shadow: k < 3, at, order: TREE_ORDER }] : [],
  );
  if (boughs.length) out.push({ material: leafMat, geometry: shapes.bough, tag: 'hedge', shadow: false, at: boughs, order: TREE_ORDER, small: true });
  out.push({ material: barkMat, geometry: shapes.trunk, tag: 'hedge', shadow: false, at: trunks, order: TREE_ORDER });
  return out;
}

/**
 * What hangs on the concrete poles along the road (the poles are prisms, 9.2 m tall): a street
 * lamp on a short arm towards the road (arm and head each in its colour per vertex), and the
 * low-voltage cables from pole to pole, two of them, sagging about 1 % of the span. `ids`: the
 * poles in this tile; `wires`: its cables.
 */
let lampGeo: THREE.BufferGeometry | null = null;
const centreLamps: Partial<Record<'post' | 'striped' | 'lantern', THREE.BufferGeometry>> = {};

/**
 * The street lamps round Smetlede's church square (Street View), from the foot of the post, the arm along
 * +x: a grey steel post with a flat LED head on a short arm (the prism is the post), the same on a post
 * striped yellow and black (the one at the school's gate), or a dark green lantern post. Each round tube
 * stands round the prism that is the post for walking and driving into.
 */
function centreLamp(kind: 'post' | 'striped' | 'lantern'): THREE.BufferGeometry {
  const c = (hex: string) => new THREE.Color(hex);
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, hex: string) =>
    paint(new THREE.BoxGeometry(w, h, d).translate(x, y, z).toNonIndexed(), c(hex));
  const tube = (r0: number, r1: number, y0: number, y1: number, hex: string, sides = 8) =>
    paint(new THREE.CylinderGeometry(r1, r0, y1 - y0, sides, 1, false).translate(0, (y0 + y1) / 2, 0).toNonIndexed(), c(hex));
  const parts: THREE.BufferGeometry[] = [];
  if (kind === 'lantern') {
    const green = '#1f3529';
    parts.push(tube(0.16, 0.12, 0, 0.55, green), tube(0.075, 0.065, 0.55, 3.3, green), tube(0.1, 0.1, 3.3, 3.38, green));
    parts.push(tube(0.17, 0.24, 3.38, 3.95, '#efe9d2', 4), tube(0.27, 0.02, 3.95, 4.25, green, 4), tube(0.03, 0.01, 4.25, 4.4, green));
    for (const a of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
      parts.push(box(0.025, 0.6, 0.025, Math.cos(a + Math.PI / 4) * 0.2, 3.66, Math.sin(a + Math.PI / 4) * 0.2, green)); // the corner bars
    }
  } else {
    const top = kind === 'striped' ? 6.5 : 6.0;
    if (kind === 'striped') {
      for (let k = 0, y = 0; y < top; k++, y += 0.5) parts.push(tube(0.085, 0.085, y, Math.min(top, y + 0.5), k % 2 ? '#1c1c1c' : '#e2b320'));
    } else {
      parts.push(tube(0.1, 0.1, 0, 0.6, '#9a9c9c'), tube(0.08, 0.07, 0.6, top, '#a3a5a5'));
    }
    parts.push(box(0.62, 0.05, 0.05, 0.31, top, 0, '#8d9196'), box(0.56, 0.08, 0.24, 0.62 + 0.24, top - 0.02, 0, '#3b3e42'));
  }
  return mergeGeometries(parts);
}
function buildLamps(poles: Pole[], ids: number[], wires: [number, number][], ground: number): Piece[] {
  const out: Piece[] = [];
  const ARM_Y = 7.4;
  lampGeo ??= mergeGeometries([
    paint(new THREE.BoxGeometry(1.5, 0.07, 0.07).translate(0.75, 0, 0).toNonIndexed(), new THREE.Color('#8d9196')),
    paint(new THREE.BoxGeometry(0.62, 0.11, 0.26).translate(0.31 + 1.45, -0.04, 0).toNonIndexed(), new THREE.Color('#3b3e42')),
  ]);
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.12); // the arm rises a little
  const concrete = ids.filter((id) => !poles[id].k);
  if (concrete.length) {
    const at = concrete.map((id) => {
      const p = poles[id];
      const q = new THREE.Quaternion().setFromAxisAngle(up, Math.atan2(-p.arm[1], p.arm[0])).multiply(tilt);
      const foot = p.y ?? ground; // the ground at the pole (on the relief)
      return new THREE.Matrix4().compose(new THREE.Vector3(p.x + p.arm[0] * 0.1, foot + ARM_Y, p.z + p.arm[1] * 0.1), q, one);
    });
    out.push({ material: lampMat, geometry: lampGeo, tag: 'steel', shadow: true, at, small: true });
  }
  // Smetlede's centre: street lamps on steel posts, turned towards the road.
  for (const kind of ['post', 'striped', 'lantern'] as const) {
    const own = ids.filter((id) => poles[id].k === kind);
    if (!own.length) continue;
    const at = own.map((id) => {
      const p = poles[id];
      const q = new THREE.Quaternion().setFromAxisAngle(up, Math.atan2(-p.arm[1], p.arm[0]));
      return new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y ?? ground, p.z), q, one);
    });
    out.push({ material: lampMat, geometry: (centreLamps[kind] ??= centreLamp(kind)), tag: 'steel', shadow: true, at, small: true });
  }
  // Cables: thin boxes along a sagging curve, ten pieces a span, merged.
  const cables: THREE.BufferGeometry[] = [];
  const piece = new THREE.BoxGeometry(1, 0.028, 0.028);
  for (const [i, j] of wires) {
    const a = poles[i];
    const b = poles[j];
    if (!a || !b) continue;
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    for (const [h, side] of [[8.85, 0.13], [8.35, -0.13]] as const) {
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 10; k++) {
        const t = k / 10;
        // Hooked on the road side of each pole, the second cable a little lower on the other side.
        const off = (p: typeof a) => [p.arm[0] * side, p.arm[1] * side];
        const [ax, az] = off(a);
        const [bx, bz] = off(b);
        const ya = (a.y ?? ground) + h;
        const yb = (b.y ?? ground) + h;
        pts.push(new THREE.Vector3(a.x + ax + (b.x + bx - a.x - ax) * t, ya + (yb - ya) * t - span * 0.012 * 4 * t * (1 - t), a.z + az + (b.z + bz - a.z - az) * t));
      }
      for (let k = 0; k < 10; k++) {
        const d = pts[k + 1].clone().sub(pts[k]);
        const g = piece.clone();
        g.scale(d.length(), 1, 1);
        g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), d.clone().normalize()));
        g.translate((pts[k].x + pts[k + 1].x) / 2, (pts[k].y + pts[k + 1].y) / 2, (pts[k].z + pts[k + 1].z) / 2);
        cables.push(g);
      }
    }
  }
  if (cables.length) {
    out.push({ material: cableMat, geometry: mergeGeometries(cables), tag: 'steel', shadow: false, small: true });
    cables.forEach((g) => g.dispose());
  }
  return out;
}

/** One solar panel, drawn once: dark blue cells in a 6 x 10 grid with thin light lines, an aluminium frame. */
function panelTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 96;
  c.height = 160;
  const g = c.getContext('2d')!;
  g.fillStyle = '#b8bcc0';
  g.fillRect(0, 0, 96, 160);
  g.fillStyle = '#5d6672';
  g.fillRect(3, 3, 90, 154);
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 10; j++) {
      g.fillStyle = (i * 7 + j * 3) % 5 ? '#18202d' : '#1b2433';
      g.fillRect(4 + i * 15, 4 + j * 15.2, 14, 14.2);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/**
 * Solar panel arrays on the roofs: each a quad `n` panels across and up (texture repeated per
 * panel), 12 cm above the tiles, with an aluminium edge down to the roof.
 */
function buildSolar(list: NonNullable<Surroundings['solar']>): Piece[] {
  const top: number[] = [];
  const uv: number[] = [];
  const edge: number[] = [];
  for (const s of list) {
    const [a, b, c, d] = s.q.map((p) => new THREE.Vector3(...p));
    const [cols, rows] = s.n;
    // Two triangles, facing up.
    const n = b.clone().sub(a).cross(d.clone().sub(a));
    const quad = n.y >= 0 ? [a, b, c, a, c, d] : [a, c, b, a, d, c];
    const uvOf = (p: THREE.Vector3) => (p === a ? [0, 0] : p === b ? [cols, 0] : p === c ? [cols, rows] : [0, rows]);
    for (const p of quad) {
      top.push(p.x, p.y, p.z);
      uv.push(...uvOf(p));
    }
    // The edge: down to the roof (12 cm), or for a tilted row on a flat roof, down to the roof under it.
    const floor = Math.min(a.y, b.y, c.y, d.y) - (s.flat ? 0.05 : 0.12);
    const corners = [a, b, c, d];
    for (let k = 0; k < 4; k++) {
      const p = corners[k];
      const q = corners[(k + 1) % 4];
      const drop = (v: THREE.Vector3) => new THREE.Vector3(v.x, s.flat ? floor : v.y - 0.12, v.z);
      const pd = drop(p);
      const qd = drop(q);
      edge.push(...p.toArray(), ...q.toArray(), ...qd.toArray(), ...p.toArray(), ...qd.toArray(), ...pd.toArray());
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(top, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  panelMat ??= new THREE.MeshStandardMaterial({ map: panelTexture(), roughness: 0.22, metalness: 0.35 });
  const e = new THREE.BufferGeometry();
  e.setAttribute('position', new THREE.Float32BufferAttribute(edge, 3));
  e.computeVertexNormals();
  return [
    { material: panelMat, geometry: g, tag: 'glass', shadow: true, small: true },
    { material: panelEdgeMat, geometry: e, tag: 'steel', shadow: false, small: true },
  ];
}

/** The water in a pond or ditch: a flat surface where the banks reach its level. */
export function waterMesh(d: DipSpec, ground: number): THREE.Mesh | null {
  if (!d.water) return null;
  const t = d.water / d.depth;
  const ring = d.rim.map(([x, z], i) => new THREE.Vector2(x + (d.bottom[i][0] - x) * t, -(z + (d.bottom[i][1] - z) * t)));
  const g = new THREE.ShapeGeometry(new THREE.Shape(ring)).rotateX(-Math.PI / 2).translate(0, ground + (d.low ?? 0) - d.water, 0);
  const mesh = new THREE.Mesh(g, waterMaterial()); // rippling in the wind (world/water.ts)
  mesh.onBeforeRender = waterClock;
  mesh.receiveShadow = true;
  mesh.userData.material = 'glass';
  mesh.name = `${d.name} water`;
  return mesh;
}

/**
 * The horizon beyond the data: a ring of distant tree lines, hedgerows, poplar rows and the odd
 * farm roof, as a Flemish horizon looks, drawn once on a canvas in pale, hazy greens. It stands
 * 900 m from the eye and moves with it (main.ts), hiding the far edge of the ground wherever
 * you are, from the house to the village. One draw call; cut out, so no blending.
 */
export function buildHorizon(center: THREE.Vector3, ground: number): THREE.Object3D {
  const W = 2048;
  const H = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  let s = 99;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  /** One band of crowns along the canvas, `top` the typical height in pixels from the bottom. */
  const band = (color: string, top: number, spread: number, gaps: number) => {
    g.fillStyle = color;
    let x = -20;
    while (x < W + 20) {
      if (rand() < gaps) {
        x += 30 + rand() * 120; // open fields between the tree lines
        continue;
      }
      const poplar = rand() < 0.03;
      const r = poplar ? 4 + rand() * 3 : 8 + rand() * 18;
      const h = poplar ? top * (1.25 + rand() * 0.2) : top * (0.6 + rand() * spread);
      g.beginPath();
      g.ellipse(x, H - h + r, r, poplar ? h / 2 : r, 0, 0, Math.PI * 2);
      g.fill();
      g.fillRect(x - r, H - h + r, r * 2, h);
      x += r * (poplar ? 1.6 : 1.1);
    }
  };
  band('#8d9b95', 26, 0.7, 0.12); // far: paler and bluer
  // A few farm roofs among the trees.
  for (let k = 0; k < 9; k++) {
    const x = rand() * W;
    const w = 30 + rand() * 50;
    const h = 8 + rand() * 6;
    g.fillStyle = rand() < 0.5 ? '#8c7a74' : '#7c7f80';
    g.beginPath();
    g.moveTo(x, H - 3);
    g.lineTo(x, H - h);
    g.lineTo(x + w / 2, H - h - w * 0.25);
    g.lineTo(x + w, H - h);
    g.lineTo(x + w, H - 3);
    g.fill();
  }
  band('#6f7f67', 16, 0.6, 0.22); // nearer: a little greener
  g.fillStyle = '#76846c';
  g.fillRect(0, H - 4, W, 4); // hedgerows along the fields
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.repeat.set(6, 1);
  // The canvas is 128 m high at 900 m: it looks as a tree line of about 12 m and poplars of
  // about 20 m would at 420 m (where it stood when the data reached 230 m out).
  const radius = 900;
  const height = 128;
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, height, 96, 1, true),
    new THREE.MeshBasicMaterial({ map, alphaTest: 0.5, side: THREE.BackSide, fog: false }),
  );
  // Its foot below the lowest point of the relief's ground, so no gap shows under it from anywhere.
  let lowest = 0;
  for (let j = 0; j < terrain.nz; j++) for (let i = 0; i < terrain.nx; i++) lowest = Math.min(lowest, terrain.at(i, j));
  mesh.position.set(center.x, ground + lowest - 1 + height / 2, center.z);
  mesh.userData.ignoreRay = true;
  mesh.raycast = () => {};
  return mesh;
}

/**
 * A dip in the lawn (the garden's wadi): its flat bottom and the sloping sides up to the rim,
 * in the lawn's own material with UVs in metres like the grass round it (which has the rim cut out).
 */
export function dipMesh(d: DipSpec, ground: number, material: THREE.Material): THREE.Mesh {
  const low = ground + (d.low ?? 0) - d.depth; // on the relief: below the lowest ground round its rim
  const pos: number[] = [];
  const tri = (a: [number, number, number], b: [number, number, number], c: [number, number, number]) => {
    // Face up: swap two corners if the triangle came out the wrong way round.
    const up = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    pos.push(...a, ...(up >= 0 ? [...b, ...c] : [...c, ...b]));
  };
  const n = d.rim.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const r0: [number, number, number] = [d.rim[i][0], ground + terrain.height(d.rim[i][0], d.rim[i][1]), d.rim[i][1]];
    const r1: [number, number, number] = [d.rim[j][0], ground + terrain.height(d.rim[j][0], d.rim[j][1]), d.rim[j][1]];
    const b0: [number, number, number] = [d.bottom[i][0], low, d.bottom[i][1]];
    const b1: [number, number, number] = [d.bottom[j][0], low, d.bottom[j][1]];
    tri(r0, b0, r1);
    tri(r1, b0, b1);
  }
  const sides = new THREE.BufferGeometry();
  sides.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const uv = new Float32Array((pos.length / 3) * 2);
  for (let k = 0; k < pos.length / 3; k++) uv.set([pos[k * 3], -pos[k * 3 + 2]], k * 2);
  sides.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  sides.computeVertexNormals();
  const floor = new THREE.ShapeGeometry(new THREE.Shape(d.bottom.map(([x, z]) => new THREE.Vector2(x, -z))))
    .rotateX(-Math.PI / 2)
    .translate(0, low, 0)
    .toNonIndexed();
  const mesh = new THREE.Mesh(mergeGeometries([floor, sides]), material);
  floor.dispose();
  sides.dispose();
  mesh.receiveShadow = true;
  mesh.userData.material = 'grass';
  mesh.name = d.name;
  return mesh;
}

/**
 * Hedges: the textured blocks get leafy lumps along the top and both sides,
 * so they read as clipped beech or privet instead of a box. One instanced
 * mesh for all lumps: balls of 20 triangles, smooth, with leaves (world/leaves.ts) that
 * give them a ragged outline.
 */
export function buildHedges(prisms: Prism[]): THREE.Object3D {
  let shape = 11;
  const lump = leafBall(1, 0, () => ((shape = (shape * 16807) % 2147483647) / 2147483647), 0.6);
  const spots: THREE.Matrix4[] = [];
  const colors: THREE.Color[] = [];
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const q = new THREE.Quaternion();
  for (const p of prisms) {
    if (p.m !== 'hedge') continue;
    const ring = p.p[0].map(([x, z]) => new THREE.Vector2(x, z));
    // The long side of the (rectangular) hedge block and its width.
    let best = 0;
    for (let i = 0; i < ring.length; i++) if (ring[i].distanceTo(ring[(i + 1) % ring.length]) > ring[best].distanceTo(ring[(best + 1) % ring.length])) best = i;
    const a = ring[best];
    const b = ring[(best + 1) % ring.length];
    const c = ring[(best + 2) % ring.length];
    const dir = b.clone().sub(a);
    const length = dir.length();
    dir.normalize();
    const across = c.clone().sub(b);
    const width = across.length();
    across.normalize();
    const mid = (t: number, side: number) => a.clone().addScaledVector(dir, t).addScaledVector(across, width / 2 + side * (width / 2 - 0.02));
    for (let t = 0.1; t < length - 0.05; t += 0.3) {
      // Half sunk into the block: the texture still shows between them.
      const places: [THREE.Vector2, number][] = [];
      for (const off of [-0.6, 0, 0.6]) places.push([mid(t + (rand() - 0.5) * 0.1, off), p.y1 - 0.06]);
      for (const side of [-1, 1]) for (const h of [0.35, 0.65, 0.92]) places.push([mid(t + (rand() - 0.5) * 0.15, side), p.y0 + (p.y1 - p.y0) * h]);
      for (const [pt, y] of places) {
        const r = 0.13 + rand() * 0.09;
        q.setFromEuler(new THREE.Euler(rand() * 3, rand() * 3, rand() * 3));
        spots.push(new THREE.Matrix4().compose(new THREE.Vector3(pt.x, y, pt.y), q, new THREE.Vector3(r, r * 0.85, r)));
        colors.push(new THREE.Color('#2c4121').lerp(new THREE.Color('#4f6b33'), rand()));
      }
    }
  }
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.95 });
  sway(mat, 0.06, 0.05);
  leafy(mat, 1, 0.6); // a tile of leaves 1 m across: clumps of about 14 cm, a clipped hedge's small leaves
  const mesh = new THREE.InstancedMesh(lump, mat, Math.max(1, spots.length));
  spots.forEach((m, i) => {
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, colors[i]);
  });
  mesh.count = spots.length;
  mesh.receiveShadow = true; // the hedge block itself casts the shadow
  mesh.userData.material = 'hedge';
  mesh.userData.ignoreRay = false;
  mesh.computeBoundingSphere();
  return mesh;
}
