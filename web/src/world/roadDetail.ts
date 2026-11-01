import * as THREE from 'three';
import data from '../data/roadDetail.json';
import type { Prism, Surroundings } from './houseData';
import { blockMaterial, prismGeometry } from './houseMeshes';
import { solidNormals } from './normals';
import { terrain } from './terrain';
import { tileKey, type Piece } from './tiles';

/**
 * The streets in detail (tools/road_detail.py measures them, from the GRB and a Street View tour): in place of the
 * village data's plain road surface, each street as it is. Kapellenhoek's concrete slabs with their sealed joints
 * and cracks, gutters of setts with cast-iron gullies, kerbs, pavers on the pavements, manholes and its dashed
 * centre line by the church square; Briel's narrow concrete widened with asphalt, its old lanes; Kerkhofstraat's
 * asphalt between light setts; gravel and earth shoulders where the grass comes up to the road; the footpaths in
 * concrete tiles, pavers or gravel; the school's plateau with its zebra crossing; the give-way line at Kapelleweg.
 *
 * Everything is built along each street's stations (every 2.5 m): the surfaces as strips across the street with
 * their texture running along it and their colour per vertex (darker wheel tracks and edges, each concrete slab a
 * shade of its own), the paint, joints, cracks and iron as flat shapes a few millimetres above. The pieces go into
 * the tiles like the rest of the surroundings (world/tiles.ts): one draw call per material for each set of tiles,
 * the paint among the small details. The surfaces share the village's materials (the pavers, concrete and gravel
 * with their tint per vertex), so they add no graphics memory but the concrete road's texture, and they replace
 * the road surface they cover pixel for pixel. The old road blocks stay for walking on; the pavements and the
 * school's plateau get blocks of their own, a few centimetres high (a kerb is no wall: the player steps up 50 cm,
 * a car rolls over 30).
 *
 * In Smetlede's centre, whose grey clinkers the village data draws: the parking bays on the church square in darker
 * clinkers edged with a row of light ones, and the chip shop's forecourt by the school in the square's clinkers
 * (`patches`, from data/smetlede.json), laid a few centimetres over the paving they lie on.
 */

interface Run {
  name: string;
  pf: string;
  /** Metres along the street at the first station */
  s0: number;
  /** The stations, x and z */
  p: number[];
  /** The carriageway's half width either side of each station (+ normal, then - normal) */
  w: number[];
  /** Per station: 1, 2 a kerb on the + or - side; 4, 8 lowered there (a drive) */
  k: number[];
  /** Per station and side: beyond a kerb the pavement's width, else the paved apron before the grass */
  q: number[];
}

interface Spot {
  x: number;
  z: number;
  /** Along the street (unit) */
  u: [number, number];
  /** Half widths across it */
  w: [number, number];
}

interface Detail {
  hide: string[];
  runs: Run[];
  fills: { m: string; r: number[][] }[];
  /** Clinkers laid over the village's paving in a tint of their own (the square's bays, the chip shop's forecourt) */
  patches?: { t: string; r: number[][] }[];
  school: { p: number[]; w: number[]; x: [number, number]; red: [number, number] };
  zebras: Spot[];
  teeth: Spot[];
}

const DETAIL = data as unknown as Detail;

type Surface = 'concrete' | 'asphalt' | 'pavers' | 'tiles' | 'gravel' | 'clinker';

/** How each kind of street looks (tools/road_detail.py's PROFILES say which street is which). */
interface Profile {
  road: Surface;
  tint: string;
  /** Concrete: metres between the joints across, a joint down the middle (wide roads), the share of slabs cracked */
  slab?: number;
  centreJoint?: boolean;
  cracks?: number;
  /** A concrete core this wide either side of the centre line, asphalt in this tint beyond it (Briel) */
  core?: number;
  edge?: string;
  /** Concrete: a strip of another surface down the middle of the carriageway, `w` either side of it */
  middle?: { w: number; m: Surface; tint: string };
  /**
   * Beside a kerb: the gutter of setts, the kerb, the pavement. `setts`: where there is no kerb, the setts lie just
   * outside the carriageway, and the road surface beyond them (the apron) is in `apron` (else the carriageway's).
   */
  gutter?: { w: number; tint: string };
  setts?: boolean;
  apron?: Surface;
  /** The apron's colour (else the pavements') */
  apronTint?: string;
  kerb?: { h: number; tint: string };
  walk?: { m: Surface; tint: string };
  /** Where no kerb: gravel or earth between the road and the grass, this wide */
  shoulder?: { w: number; tint: string };
  /** A dashed white centre line */
  dash?: boolean;
  /** Metres between the gullies in the gutters and between the manholes down the middle */
  gullies?: number;
  manholes?: number;
  /** How much darker the wheel tracks are (0 to 1) */
  wear: number;
  /** A footpath: just its surface, a little above the grass */
  path?: boolean;
}

const SETTS = '#8d8b86';
const KERB_TINT = '#b6b8b8';
const PAVERS = '#aaa8a3';
const EARTH = '#8c7f6a';
const KH: Profile = {
  road: 'concrete', tint: '#b2afa7', slab: 5, centreJoint: true, cracks: 0.2, gutter: { w: 0.32, tint: SETTS }, kerb: { h: 0.11, tint: KERB_TINT },
  walk: { m: 'pavers', tint: PAVERS }, shoulder: { w: 0.4, tint: '#a19a8d' }, gullies: 24, manholes: 45, wear: 0.34,
};
const PROFILES: Record<string, Profile> = {
  // Kapellenhoek: pale worn concrete slabs, setts, kerbs and pavers where houses stand, gravel where they don't;
  // by the church square a dashed centre line.
  kh: KH,
  kh_dash: { ...KH, dash: true },
  // Kapelleweg: a narrow concrete lane between grass and gravel.
  kw: { road: 'concrete', tint: '#b7b4ac', slab: 5, cracks: 0.3, shoulder: { w: 0.35, tint: EARTH }, wear: 0.2 },
  // Its last stretch, by the new terrace at Molenhoek's end: two pale concrete strips with dark clinkers between
  // them, the verge up to the gardens bare earth, not yet finished.
  kw_path: {
    road: 'concrete', tint: '#c0bdb5', slab: 5, cracks: 0, middle: { w: 0.45, m: 'clinker', tint: '#4d4744' }, apron: 'gravel', apronTint: '#6f6a62',
    wear: 0.06,
  },
  // Briel: narrow concrete, widened with grey asphalt along both edges.
  briel: {
    road: 'concrete', tint: '#b4b1a9', slab: 5, cracks: 0.25, core: 1.75, edge: '#78797b', gutter: { w: 0.3, tint: SETTS }, kerb: { h: 0.1, tint: KERB_TINT },
    walk: { m: 'pavers', tint: PAVERS }, shoulder: { w: 0.35, tint: EARTH }, wear: 0.26,
  },
  // Briel's old lanes (the lane by the house): cracked concrete, three metres, grass up to it.
  lane: { road: 'concrete', tint: '#afaca4', slab: 7.5, cracks: 0.85, shoulder: { w: 0.3, tint: EARTH }, wear: 0.16 },
  // Kerkhofstraat: dark asphalt between light setts (with or without a kerb), low kerbs, pavers.
  kerkhof: {
    road: 'asphalt', tint: '#56585b', gutter: { w: 0.45, tint: '#a3a19b' }, setts: true, apron: 'pavers', kerb: { h: 0.06, tint: KERB_TINT }, walk: { m: 'pavers', tint: PAVERS },
    shoulder: { w: 0.3, tint: EARTH }, gullies: 22, manholes: 40, wear: 0.1,
  },
  // The other streets: asphalt, setts and kerbs where the GRB has a pavement.
  asphalt: {
    road: 'asphalt', tint: '#595b5e', gutter: { w: 0.3, tint: SETTS }, kerb: { h: 0.1, tint: KERB_TINT }, walk: { m: 'pavers', tint: PAVERS },
    shoulder: { w: 0.35, tint: EARTH }, gullies: 25, manholes: 50, wear: 0.1,
  },
  lane_asphalt: { road: 'asphalt', tint: '#5e6062', shoulder: { w: 0.35, tint: EARTH }, wear: 0.08 },
  lane_loose: { road: 'gravel', tint: '#b2a690', shoulder: { w: 0.3, tint: EARTH }, wear: 0.12 },
  // The footpaths.
  path_tiles: { road: 'tiles', tint: '#b3b0a8', wear: 0, path: true },
  path_pavers: { road: 'pavers', tint: '#a3a19c', wear: 0.05, path: true },
  path_gravel: { road: 'gravel', tint: '#bfb29a', wear: 0.15, path: true },
};

/** The material behind each surface: the village's own families, tinted per vertex. */
const MATERIAL: Record<Surface, string> = { concrete: 'rd_concrete', asphalt: 'rd_asphalt', pavers: 'pave_walk', tiles: 'rd_tiles', gravel: 'gravel', clinker: 'pave_grey' };
/** What a bullet hitting each one looks and sounds like. */
const TAG: Record<Surface, string> = { concrete: 'road', asphalt: 'road', pavers: 'pave_light', tiles: 'pave_light', gravel: 'gravel', clinker: 'pave_grey' };

const KERB = 0.12; // m: the kerb's width (tools/road_detail.py measures the pavement from its back)
const LIFT = 0.006; // m: the paint, joints and iron above the surface they lie on
const PATCH_LIFT = 0.03; // m: the bays and the forecourt above the village's paving (its blocks follow the relief more coarsely)
const COVER_ORDER = 0.5; // drawn with the other ground covers (world/surroundings.ts)
const PIECE = 10; // stations in one piece of a strip (25 m): each piece goes into the tile it lies in
const AREA = 540; // m round the plot's middle: the ring's (loaded at the start); beyond, the village's
const CX = 4.45;
const CZ = -3;

/** A hash of a few numbers, 0..1, the same every time (the slabs, cracks and wear don't change between visits). */
function hash(...v: number[]): number {
  let h = 2166136261;
  for (const x of v) {
    h ^= Math.round(x * 1000) | 0;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** A smooth value along a street, 0..1, changing over about `scale` metres. */
function wave(s: number, scale: number, seed: number): number {
  const t = s / scale;
  const i = Math.floor(t);
  const f = t - i;
  const a = hash(i, seed);
  const b = hash(i + 1, seed);
  return a + (b - a) * f * f * (3 - 2 * f);
}

/** Geometry for one material in one tile, grown a strip at a time: positions, texture coordinates in metres, colours. */
class Mesh {
  pos: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];

  vertex(x: number, y: number, z: number, u: number, v: number, c: THREE.Color): number {
    this.pos.push(x, y, z);
    this.uv.push(u, v);
    this.col.push(Math.round(Math.min(1, c.r) * 255), Math.round(Math.min(1, c.g) * 255), Math.round(Math.min(1, c.b) * 255));
    return this.pos.length / 3 - 1;
  }

  /** A triangle turned to face `up` (y) or, for an upright face, away from the point (ox, oz). */
  tri(a: number, b: number, c: number, out?: [number, number]): void {
    const p = this.pos;
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const facing = out ? nx * out[0] + nz * out[1] : ny;
    if (facing >= 0) this.idx.push(a, b, c);
    else this.idx.push(a, c, b);
  }

  quad(a: number, b: number, c: number, d: number, out?: [number, number]): void {
    this.tri(a, b, c, out);
    this.tri(a, c, d, out);
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(this.col), 3, true));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return solidNormals(g); // some of the strips' triangles have no area (world/normals.ts)
  }
}

/** The pieces being built, by tile and material. */
class Parts {
  private meshes = new Map<string, { mesh: Mesh; material: THREE.Material; tag: string; order?: number; small?: boolean }>();
  readonly blocks: Prism[] = [];

  constructor(readonly village: boolean) {}

  /** Whether (x, z) belongs to this set (the ring round the plot, or the village beyond it). */
  mine(x: number, z: number): boolean {
    return Math.hypot(x - CX, z - CZ) > AREA === this.village;
  }

  get(x: number, z: number, material: THREE.Material, tag: string, order?: number, small?: boolean): Mesh {
    const key = `${tileKey(x, z)}|${material.uuid}`;
    let e = this.meshes.get(key);
    if (!e) this.meshes.set(key, (e = { mesh: new Mesh(), material, tag, order, small }));
    return e.mesh;
  }

  tiles(): { key: string; pieces: Piece[] }[] {
    const by = new Map<string, Piece[]>();
    for (const [key, e] of this.meshes) {
      if (!e.mesh.idx.length) continue;
      const tile = key.split('|')[0];
      const list = by.get(tile) ?? [];
      list.push({ material: e.material, geometry: e.mesh.geometry(), tag: e.tag, shadow: false, order: e.order, small: e.small });
      by.set(tile, list);
    }
    return [...by].map(([key, pieces]) => ({ key, pieces }));
  }
}

/**
 * A street's frame: its stations with their normals and metres along it, and where a point (s metres along, o
 * across, + to the normal's side) lies.
 */
class Frame {
  readonly n: number;
  readonly x: number[] = [];
  readonly z: number[] = [];
  readonly nx: number[] = [];
  readonly nz: number[] = [];
  readonly s: number[] = [];

  constructor(p: number[], s0: number) {
    this.n = p.length / 2;
    for (let k = 0; k < this.n; k++) {
      this.x.push(p[2 * k]);
      this.z.push(p[2 * k + 1]);
    }
    for (let k = 0; k < this.n; k++) {
      // As tools/road_detail.py's normals(): along the line from two stations back to two on.
      const a = Math.max(0, k - 2);
      const b = Math.min(this.n - 1, k + 2);
      const tx = this.x[b] - this.x[a];
      const tz = this.z[b] - this.z[a];
      const len = Math.hypot(tx, tz) || 1;
      this.nx.push(-tz / len);
      this.nz.push(tx / len);
      this.s.push(k === 0 ? s0 : this.s[k - 1] + Math.hypot(this.x[k] - this.x[k - 1], this.z[k] - this.z[k - 1]));
    }
  }

  /** Station k, offset o across. */
  at(k: number, o: number): [number, number] {
    return [this.x[k] + this.nx[k] * o, this.z[k] + this.nz[k] * o];
  }

  /** The point s metres along (between stations), o across. */
  point(s: number, o: number): [number, number] {
    let k = 0;
    while (k < this.n - 2 && this.s[k + 1] < s) k++;
    const t = Math.max(0, Math.min(1, (s - this.s[k]) / (this.s[k + 1] - this.s[k] || 1)));
    const x = this.x[k] + (this.x[k + 1] - this.x[k]) * t;
    const z = this.z[k] + (this.z[k + 1] - this.z[k]) * t;
    const nx = this.nx[k] + (this.nx[k + 1] - this.nx[k]) * t;
    const nz = this.nz[k] + (this.nz[k + 1] - this.nz[k]) * t;
    const len = Math.hypot(nx, nz) || 1;
    return [x + (nx / len) * o, z + (nz / len) * o];
  }
}

/** The tile set's builder: everything of the streets in the ring, or in the village. */
class Builder {
  readonly parts: Parts;
  private paint: THREE.MeshStandardMaterial;
  private mats = new Map<Surface | 'kerb', THREE.Material>();
  private c = new THREE.Color();

  constructor(village: boolean, private renderer: THREE.WebGLRenderer, private ground: number, paint: THREE.MeshStandardMaterial) {
    this.parts = new Parts(village);
    this.paint = paint;
  }

  /** The old road surface's top above the relief (tools/build_house.py lays the road 2 cm over the lawn). */
  get road(): number {
    return this.ground + 0.02;
  }

  material(s: Surface | 'kerb'): THREE.Material {
    let m = this.mats.get(s);
    if (!m) this.mats.set(s, (m = blockMaterial(s === 'kerb' ? 'concrete' : MATERIAL[s], this.renderer).material));
    return m;
  }

  y(x: number, z: number, lift: number): number {
    return lift + terrain.height(x, z);
  }

  /**
   * A strip along stations k0..k1 between offsets o0(k) and o1(k) (o0 < o1), in columns at the fractions `cols`
   * across it, lifted lift(k, o) above the relief; its colour col(k, o) and texture u across, v along (scaled).
   */
  strip(f: Frame, k0: number, k1: number, o0: (k: number) => number, o1: (k: number) => number, surface: Surface | 'kerb',
    lift: (k: number, o: number) => number, col: (k: number, o: number, out: THREE.Color) => THREE.Color, cols = [0, 1], scale = 1,
    tag?: string, order = COVER_ORDER): void {
    if (k1 <= k0) return;
    if (k1 - k0 > PIECE) {
      // In pieces, each in the tile (and the set) where it lies.
      for (let a = k0; a < k1; a += PIECE) this.strip(f, a, Math.min(k1, a + PIECE), o0, o1, surface, lift, col, cols, scale, tag, order);
      return;
    }
    const mid = (k0 + k1) >> 1;
    if (!this.parts.mine(f.x[mid], f.z[mid])) return;
    const mesh = this.parts.get(f.x[mid], f.z[mid], this.material(surface), tag ?? (surface === 'kerb' ? 'concrete' : TAG[surface]), order);
    const first = mesh.pos.length / 3;
    for (let k = k0; k <= k1; k++) {
      const a = o0(k);
      const b = o1(k);
      for (const t of cols) {
        const o = a + (b - a) * t;
        const [x, z] = f.at(k, o);
        mesh.vertex(x, this.y(x, z, lift(k, o)), z, o * scale, f.s[k] * scale, col(k, o, this.c));
      }
    }
    const w = cols.length;
    for (let r = 0; r < k1 - k0; r++) {
      for (let j = 0; j < w - 1; j++) {
        const a = first + r * w + j;
        mesh.quad(a, a + 1, a + w + 1, a + w);
      }
    }
  }

  /** An upright face along stations k0..k1 at offset o(k), from lift lo(k) to hi(k), facing away from the centre line (out) or towards it. */
  riser(f: Frame, k0: number, k1: number, o: (k: number) => number, lo: (k: number) => number, hi: (k: number) => number, tint: string, outward: boolean): void {
    if (k1 <= k0) return;
    if (k1 - k0 > PIECE) {
      for (let a = k0; a < k1; a += PIECE) this.riser(f, a, Math.min(k1, a + PIECE), o, lo, hi, tint, outward);
      return;
    }
    const mid = (k0 + k1) >> 1;
    if (!this.parts.mine(f.x[mid], f.z[mid])) return;
    const mesh = this.parts.get(f.x[mid], f.z[mid], this.material('kerb'), 'concrete');
    const c = this.c.set(tint);
    for (let k = k0; k < k1; k++) {
      const [ax, az] = f.at(k, o(k));
      const [bx, bz] = f.at(k + 1, o(k + 1));
      const side = Math.sign(o(k)) || 1;
      const out: [number, number] = [f.nx[k] * side * (outward ? 1 : -1), f.nz[k] * side * (outward ? 1 : -1)];
      const v0 = mesh.vertex(ax, this.y(ax, az, lo(k)), az, f.s[k], lo(k), c);
      const v1 = mesh.vertex(bx, this.y(bx, bz, lo(k + 1)), bz, f.s[k + 1], lo(k + 1), c);
      const v2 = mesh.vertex(bx, this.y(bx, bz, hi(k + 1)), bz, f.s[k + 1], hi(k + 1), c);
      const v3 = mesh.vertex(ax, this.y(ax, az, hi(k)), az, f.s[k], hi(k), c);
      mesh.quad(v0, v1, v2, v3, out);
    }
  }

  /** Paint or iron: a flat shape on the street (points as [s, o]), lift above the relief at each point. */
  flat(f: Frame, pts: [number, number][], tint: string, lift: (s: number, o: number) => number): void {
    const [mx, mz] = f.point(pts[0][0], pts[0][1]);
    if (!this.parts.mine(mx, mz)) return;
    const mesh = this.parts.get(mx, mz, this.paint, 'road', COVER_ORDER + 0.05, true);
    const c = this.c.set(tint);
    const ids = pts.map(([s, o]) => {
      const [x, z] = f.point(s, o);
      return mesh.vertex(x, this.y(x, z, lift(s, o) + LIFT), z, s, o, c);
    });
    for (let i = 1; i + 1 < ids.length; i++) mesh.tri(ids[0], ids[i], ids[i + 1]);
  }

  /**
   * A line of paint along the street from (s0, o0) to (s1, o1), `width` wide: in pieces of under a metre, each
   * lifted onto the relief at its corners (one long piece would dip under the surface between them).
   */
  line(f: Frame, s0: number, o0: number, s1: number, o1: number, width: number, tint: string, lift: (s: number, o: number) => number): void {
    const ds = s1 - s0;
    const dO = o1 - o0;
    const len = Math.hypot(ds, dO) || 1;
    const ps = (-dO / len) * (width / 2);
    const po = (ds / len) * (width / 2);
    const n = Math.ceil(len / 0.8);
    for (let i = 0; i < n; i++) {
      const [a, b] = [i / n, (i + 1) / n];
      const sa = s0 + ds * a, oa = o0 + dO * a, sb = s0 + ds * b, ob = o0 + dO * b;
      this.flat(f, [[sa - ps, oa - po], [sb - ps, ob - po], [sb + ps, ob + po], [sa + ps, oa + po]], tint, lift);
    }
  }

  /** A walking block over stations k0..k1 between offsets o0 and o1, its top `top` above the old road. */
  block(f: Frame, k0: number, k1: number, o0: (k: number) => number, o1: (k: number) => number, top: number, m = 'pave_light'): void {
    const mid = (k0 + k1) >> 1;
    if (k1 <= k0 || !this.parts.mine(f.x[mid], f.z[mid])) return;
    const ring: [number, number][] = [];
    for (let k = k0; k <= k1; k++) ring.push(f.at(k, o0(k)));
    for (let k = k1; k >= k0; k--) ring.push(f.at(k, o1(k)));
    this.parts.blocks.push({ m, y0: this.ground - 0.2, y1: this.road + top, p: [ring.map(([x, z]) => [Math.round(x * 1000) / 1000, Math.round(z * 1000) / 1000] as [number, number])], d: 4, n: 'street' });
  }

  // ---------------------------------------------------------------- a street

  run(r: Run): void {
    const pf = PROFILES[r.pf] ?? PROFILES.asphalt;
    const f = new Frame(r.p, r.s0);
    const n = f.n;
    const wa = (k: number) => r.w[2 * k];
    const wb = (k: number) => r.w[2 * k + 1];
    const kerb = (k: number, side: 0 | 1) => !!(r.k[k] & (1 << side)) && !!pf.kerb;
    const low = (k: number, side: 0 | 1) => !!(r.k[k] & (4 << side));
    const qa = (k: number) => r.q[2 * k];
    const qb = (k: number) => r.q[2 * k + 1];
    const road = this.road;
    if (pf.path) {
      this.path(f, r, pf);
      return;
    }
    // The gutter is part of the carriageway: the slabs or the asphalt stop at it.
    const gw = pf.gutter?.w ?? 0;
    const inA = (k: number) => wa(k) - (kerb(k, 0) ? gw : 0);
    const inB = (k: number) => -(wb(k) - (kerb(k, 1) ? gw : 0));
    // Wheel tracks: one lane down the middle on a narrow road, two lanes on a wide one.
    const widths = Array.from({ length: n }, (_, k) => wa(k) + wb(k)).sort((a, b) => a - b);
    const wide = widths[n >> 1] >= 4.8;
    const tracks = (k: number) => (wide ? [wa(k) / 2 - 0.85, wa(k) / 2 + 0.85, -wb(k) / 2 - 0.85, -wb(k) / 2 + 0.85] : [(wa(k) - wb(k)) / 2 - 0.85, (wa(k) - wb(k)) / 2 + 0.85]);
    const base = new THREE.Color(pf.tint);
    const edgeTint = new THREE.Color(pf.edge ?? pf.tint);
    const seed = hash(r.p[0], r.p[1]);
    /** The carriageway's colour at (k, o): its tint, darker in the wheel tracks and towards the edges, slowly changing along. */
    const shade = (tint: THREE.Color, slab: number) => (k: number, o: number, out: THREE.Color) => {
      let track = 0;
      for (const t of tracks(k)) track = Math.max(track, Math.exp(-(((o - t) / 0.32) ** 2)));
      const edge = Math.min(o - inB(k), inA(k) - o);
      const dirt = edge < 0.5 ? 0.92 + 0.16 * Math.max(0, edge) : 1;
      const along = 0.95 + 0.1 * wave(f.s[k], 9, seed);
      const blotch = 0.94 + 0.12 * hash(k, Math.round(o * 4), seed);
      return out.copy(tint).multiplyScalar((1 - pf.wear * track) * dirt * along * slab * blotch);
    };
    const flatLift = () => road;
    const surface = pf.road;
    // Columns across the carriageway (fractions of its width, the wheel tracks between them): enough to shade them.
    const COLS = [0, 0.06, 0.16, 0.24, 0.32, 0.4, 0.5, 0.6, 0.68, 0.76, 0.84, 0.94, 1];

    if (surface === 'concrete') {
      // Slabs: a joint across every `slab` metres (at a station), down the middle on a wide road; each slab its
      // own shade; a core of concrete with asphalt beyond on Briel.
      const every = Math.max(1, Math.round((pf.slab ?? 5) / 2.5));
      const core = pf.core;
      const lo = (k: number) => (core ? Math.max(inB(k), -core) : inB(k));
      const hi = (k: number) => (core ? Math.min(inA(k), core) : inA(k));
      const mid = pf.middle;
      const centre = (k: number) => (lo(k) + hi(k)) / 2;
      const halves: [(k: number) => number, (k: number) => number][] = mid
        ? [[lo, (k) => centre(k) - mid.w], [(k) => centre(k) + mid.w, hi]]
        : pf.centreJoint && wide ? [[lo, () => 0], [() => 0, hi]] : [[lo, hi]];
      for (let k0 = 0; k0 < n - 1; k0 += every) {
        const k1 = Math.min(n - 1, k0 + every);
        const sAt = Math.round(f.s[k0]);
        halves.forEach(([a, b], h) => {
          const tone = 0.93 + 0.14 * hash(sAt, h, seed);
          this.strip(f, k0, k1, a, b, 'concrete', flatLift, shade(base, tone), halves.length > 1 ? [0, 0.25, 0.5, 0.75, 1] : COLS);
        });
        // The joint across, sealed dark (across each concrete strip where the middle is another surface), and now
        // and then a crack sealed in black.
        if (k0 > 0) for (const [a, b] of mid ? halves : [[lo, hi]]) this.line(f, f.s[k0], a(k0), f.s[k0], b(k0), 0.04, '#64635f', flatLift);
        if (hash(sAt, 7, seed) < (pf.cracks ?? 0)) this.crack(f, f.s[k0], f.s[k1], lo(k0), hi(k0), hash(sAt, 9, seed));
      }
      if (halves.length > 1 && !mid) {
        for (let k = 0; k < n - 1; k++) this.line(f, f.s[k], 0, f.s[k + 1], 0, 0.025, '#66655f', flatLift);
      }
      if (mid) {
        // The middle strip, each piece of it a shade of its own.
        const tint = new THREE.Color(mid.tint);
        for (let k0 = 0; k0 < n - 1; k0 += 8) {
          this.strip(f, k0, Math.min(n - 1, k0 + 8), (k) => centre(k) - mid.w, (k) => centre(k) + mid.w, mid.m, flatLift,
            (k, o, out) => out.copy(tint).multiplyScalar(0.92 + 0.12 * hash(k, Math.round(o * 3), seed)), [0, 0.5, 1]);
        }
      }
      if (core) {
        // The asphalt widening either side of the core.
        const ea = (k: number) => Math.max(hi(k), inA(k));
        const eb = (k: number) => Math.min(lo(k), inB(k));
        this.strip(f, 0, n - 1, hi, ea, 'asphalt', flatLift, shade(edgeTint, 1), [0, 0.5, 1]);
        this.strip(f, 0, n - 1, eb, lo, 'asphalt', flatLift, shade(edgeTint, 1), [0, 0.5, 1]);
      }
    } else {
      for (let k0 = 0; k0 < n - 1; k0 += 8) this.strip(f, k0, Math.min(n - 1, k0 + 8), inB, inA, surface, flatLift, shade(base, 1), COLS);
    }

    // Either side: the gutter, the kerb and the pavement, or the apron and the shoulder.
    for (const side of [0, 1] as const) {
      const sign = side === 0 ? 1 : -1;
      const w = side === 0 ? wa : wb;
      const q = side === 0 ? qa : qb;
      // Runs of stations with a kerb (and without), each drawn as one strip.
      for (const [k0, k1, kerbed] of spans(n, (k) => kerb(k, side))) {
        if (kerbed && pf.kerb && pf.gutter) {
          const h = (k: number) => (low(k, side) ? 0.025 : pf.kerb!.h);
          const g0 = (k: number) => sign * (w(k) - gw);
          const g1 = (k: number) => sign * w(k);
          const setts = new THREE.Color(pf.gutter.tint);
          // The gutter: setts, in two rows, the texture's pavers at half size.
          this.strip(f, k0, k1, side === 0 ? g0 : g1, side === 0 ? g1 : g0, 'pavers', flatLift, (k, _o, out) => out.copy(setts).multiplyScalar(0.94 + 0.12 * hash(k, side, seed)), [0, 1], 2, 'concrete');
          // The kerb: its face to the road and its top.
          const kerbTint = new THREE.Color(pf.kerb.tint);
          this.riser(f, k0, k1, (k) => sign * w(k), () => road, (k) => road + h(k), pf.kerb.tint, false);
          const t0 = (k: number) => sign * w(k);
          const t1 = (k: number) => sign * (w(k) + KERB);
          this.strip(f, k0, k1, side === 0 ? t0 : t1, side === 0 ? t1 : t0, 'kerb', (k) => road + h(k), (_k, _o, out) => out.copy(kerbTint), [0, 1], 1, 'concrete', 0);
          // The pavement: sloping a little towards the road, down to the drive or the grass at its back.
          const p0 = (k: number) => sign * (w(k) + KERB);
          const p1 = (k: number) => sign * (w(k) + KERB + Math.max(0, q(k)));
          const walkTint = new THREE.Color(pf.walk!.tint);
          const inner = (k: number) => road + h(k) - 0.005;
          const outer = (k: number) => road + Math.max(0.025, h(k) - 0.04);
          const walkLift = (k: number, o: number) => (Math.abs(o) - (w(k) + KERB) < 0.01 ? inner(k) : outer(k));
          for (const [a, b, paved] of spans(k1 - k0 + 1, (i) => q(k0 + i) > 0)) {
            const ka = k0 + a;
            const kb = k0 + b;
            if (!paved) {
              this.riser(f, ka, kb, t1, () => this.ground, (k) => road + h(k), pf.kerb.tint, true);
              continue;
            }
            this.strip(f, ka, kb, side === 0 ? p0 : p1, side === 0 ? p1 : p0, pf.walk!.m, walkLift, (k, _o, out) => out.copy(walkTint).multiplyScalar(0.95 + 0.08 * wave(f.s[k], 6, seed + side)), [0, 1], 1, 'pave_light');
            this.riser(f, ka, kb, p1, () => this.ground, outer, pf.walk!.tint, true);
            for (let c = ka; c < kb; c += 8) this.block(f, c, Math.min(kb, c + 8), side === 0 ? t0 : p1, side === 0 ? p1 : t0, h(c) - 0.02);
          }
          // Cast-iron gullies in the gutter.
          if (pf.gullies) this.gullies(f, k0, k1, sign, w, gw, pf.gullies, seed + side);
        } else {
          // Setts just outside the carriageway where the street has them without a kerb (Kerkhofstraat).
          const st = pf.setts && pf.gutter ? gw : 0;
          if (st) {
            const g0 = (k: number) => sign * w(k);
            const g1 = (k: number) => sign * (w(k) + st);
            const setts = new THREE.Color(pf.gutter!.tint);
            this.strip(f, k0, k1, side === 0 ? g0 : g1, side === 0 ? g1 : g0, 'pavers', flatLift, (k, _o, out) => out.copy(setts).multiplyScalar(0.94 + 0.12 * hash(k, side, seed)), [0, 1], 2, 'concrete');
          }
          // No kerb: the paved apron the road surface has beyond the carriageway, then gravel or earth to the grass.
          const reach = (k: number) => Math.max(st, q(k));
          const e0 = (k: number) => sign * (w(k) + st);
          const e1 = (k: number) => sign * (w(k) + reach(k));
          const apronSurface: Surface = pf.apron ?? (pf.core ? 'asphalt' : surface);
          const apron = pf.apron ? new THREE.Color(pf.apronTint ?? pf.walk?.tint ?? PAVERS) : (pf.core ? edgeTint : base).clone().multiplyScalar(0.94);
          if (q(k0) > st || q(k1) > st) this.strip(f, k0, k1, side === 0 ? e0 : e1, side === 0 ? e1 : e0, apronSurface, flatLift, (_k, _o, out) => out.copy(apron), [0, 1]);
          if (pf.shoulder) {
            const sh = pf.shoulder;
            const s0 = (k: number) => sign * (w(k) + reach(k));
            const s1 = (k: number) => sign * (w(k) + reach(k) + sh.w * (0.75 + 0.5 * hash(k, side, seed)));
            const tint = new THREE.Color(sh.tint);
            // Meets the slabs at their height and the field softly: down to just over the grass at its outer edge.
            const shLift = (k: number, o: number) => (Math.abs(Math.abs(o) - Math.abs(s0(k))) < 0.01 ? road : this.ground + 0.012);
            this.strip(f, k0, k1, side === 0 ? s0 : s1, side === 0 ? s1 : s0, 'gravel', shLift, (k, _o, out) => out.copy(tint).multiplyScalar(0.9 + 0.2 * hash(k, side + 3, seed)), [0, 1], 1, 'gravel');
          }
        }
      }
    }

    // Down the middle: manholes on the sewered streets, a dashed line by the church square.
    if (pf.manholes) {
      for (let s = Math.ceil((f.s[0] + 8) / pf.manholes) * pf.manholes; s < f.s[n - 1] - 4; s += pf.manholes) this.manhole(f, s, 0.2 * (hash(s, seed) - 0.5));
    }
    if (pf.dash) {
      for (let s = Math.ceil(f.s[0] / 9) * 9; s + 3 < f.s[n - 1]; s += 9) this.line(f, s, 0, s + 3, 0, 0.1, '#dddcd5', flatLift);
    }
  }

  /** A footpath: its surface, a little over the grass, in the profile's material. */
  path(f: Frame, r: Run, pf: Profile): void {
    const lift = () => this.ground + 0.015;
    const tint = new THREE.Color(pf.tint);
    const seed = hash(r.p[0], r.p[1]);
    const half = (k: number) => r.w[2 * k];
    for (let k0 = 0; k0 < f.n - 1; k0 += 10) {
      this.strip(f, k0, Math.min(f.n - 1, k0 + 10), (k) => -half(k), half, pf.road, lift, (k, o, out) => {
        const worn = pf.wear * Math.exp(-((o / 0.35) ** 2));
        return out.copy(tint).multiplyScalar((0.94 + 0.12 * hash(k, seed)) * (1 - worn));
      }, [0, 0.5, 1]);
    }
  }

  /** A crack across part of a slab, sealed in black: a few wandering segments. */
  crack(f: Frame, s0: number, s1: number, o0: number, o1: number, r: number): void {
    const lift = () => this.road;
    let s = s0 + (s1 - s0) * (0.2 + 0.6 * r);
    let o = o0 + 0.1;
    const steps = 5;
    const run = (o1 - o0 - 0.2) / steps;
    for (let i = 0; i < steps; i++) {
      const ns = Math.max(s0 + 0.2, Math.min(s1 - 0.2, s + (hash(r, i) - 0.5) * 0.9));
      const no = o + run * (0.7 + 0.6 * hash(i, r));
      this.line(f, s, o, ns, Math.min(o1 - 0.1, no), 0.02, '#363635', lift);
      s = ns;
      o = no;
      if (o > o1 - 0.15) break;
    }
  }

  /** Gullies in the gutter on one side, every `every` metres: an iron grate in a concrete frame. */
  gullies(f: Frame, k0: number, k1: number, sign: number, w: (k: number) => number, gw: number, every: number, seed: number): void {
    const lift = () => this.road;
    for (let s = Math.ceil((f.s[k0] + 3 + 6 * hash(seed)) / every) * every; s < f.s[k1] - 1; s += every) {
      const k = Math.min(f.n - 1, Math.max(0, f.s.findIndex((v) => v >= s)));
      const o = sign * (w(k) - gw / 2);
      const rect = (hs: number, ho: number): [number, number][] => [[s - hs, o - ho], [s + hs, o - ho], [s + hs, o + ho], [s - hs, o + ho]];
      this.flat(f, rect(0.3, Math.min(0.2, gw / 2 + 0.03)), '#777570', lift);
      this.flat(f, rect(0.25, Math.min(0.16, gw / 2 - 0.01)), '#2e2f31', () => lift() + 0.002);
      for (let i = -2; i <= 2; i++) this.line(f, s + i * 0.09, o - 0.12, s + i * 0.09, o + 0.12, 0.025, '#4c4d4f', () => lift() + 0.003);
    }
  }

  /** A round manhole cover in the middle of the road. */
  manhole(f: Frame, s: number, o: number): void {
    const lift = () => this.road;
    const disc = (r: number): [number, number][] => Array.from({ length: 12 }, (_, i) => [s + Math.cos((i / 12) * Math.PI * 2) * r, o + Math.sin((i / 12) * Math.PI * 2) * r]);
    this.flat(f, disc(0.36), '#5c5c5a', lift);
    this.flat(f, disc(0.31), '#3d3e40', () => lift() + 0.002);
  }

  // ---------------------------------------------------------------- the rest of the road surface, the school, the signs on the road

  fill(m: string, rings: number[][]): void {
    const r0 = rings[0];
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < r0.length; i += 2) {
      cx += r0[i];
      cz += r0[i + 1];
    }
    cx /= r0.length / 2;
    cz /= r0.length / 2;
    if (!this.parts.mine(cx, cz)) return;
    const p: [number, number][][] = rings.map((r) => Array.from({ length: r.length / 2 }, (_, i) => [r[2 * i], r[2 * i + 1]] as [number, number]));
    const g = prismGeometry({ m, y0: this.road - 0.06, y1: this.road, p, d: 4 });
    let material: THREE.Material;
    let tag = 'road';
    let tint: THREE.Color;
    if (m === 'road') {
      material = blockMaterial('road', this.renderer).material; // Molenhoek's: the village's own road surface
      tint = new THREE.Color(1, 1, 1);
    } else if (m === 'forecourt') {
      material = this.material('pavers');
      tag = 'pave_light';
      tint = new THREE.Color('#b9b5ad');
    } else {
      const pf = PROFILES[m.slice(3)] ?? PROFILES.asphalt;
      // Beside Briel's core the widening is asphalt.
      const surface: Surface = pf.core ? 'asphalt' : pf.road;
      material = this.material(surface);
      tint = new THREE.Color(pf.core ? pf.edge! : pf.tint).multiplyScalar(0.97);
    }
    const mesh = this.parts.get(cx, cz, material, tag, COVER_ORDER);
    const pos = g.attributes.position;
    const uv = g.attributes.uv;
    const first = mesh.pos.length / 3;
    for (let i = 0; i < pos.count; i++) mesh.vertex(pos.getX(i), pos.getY(i), pos.getZ(i), uv.getX(i), uv.getY(i), tint);
    for (let i = 0; i < pos.count; i += 3) mesh.idx.push(first + i, first + i + 1, first + i + 2);
    g.dispose();
  }

  /** Clinkers in the tint `t` over the village's paving: a parking bay's dark fill or light edging, a forecourt. */
  patch(t: string, rings: number[][]): void {
    const r0 = rings[0];
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < r0.length; i += 2) {
      cx += r0[i];
      cz += r0[i + 1];
    }
    cx /= r0.length / 2;
    cz /= r0.length / 2;
    if (!this.parts.mine(cx, cz)) return;
    const p: [number, number][][] = rings.map((r) => Array.from({ length: r.length / 2 }, (_, i) => [r[2 * i], r[2 * i + 1]] as [number, number]));
    const g = prismGeometry({ m: 'pave_grey', y0: this.road + PATCH_LIFT - 0.01, y1: this.road + PATCH_LIFT, p, d: 4 });
    const tint = new THREE.Color(t);
    const mesh = this.parts.get(cx, cz, this.material('clinker'), 'pave_grey', COVER_ORDER);
    const pos = g.attributes.position;
    const uv = g.attributes.uv;
    const first = mesh.pos.length / 3;
    for (let i = 0; i < pos.count; i++) mesh.vertex(pos.getX(i), pos.getY(i), pos.getZ(i), uv.getX(i), uv.getY(i), tint);
    for (let i = 0; i < pos.count; i += 3) mesh.idx.push(first + i, first + i + 1, first + i + 2);
    g.dispose();
  }

  /**
   * The school's plateau on Smetlededorp: the carriageway raised 6 cm with a ramp at either end, grey pavers as
   * the street, red-brown ones where the crossing is, and the zebra on it.
   */
  school(s: Detail['school'], zebras: Spot[]): void {
    const f = new Frame(s.p, 0);
    const TOP = 0.06;
    const RAMP = 1.2;
    const end = f.s[f.n - 1];
    const lift = (k: number) => this.road + TOP * Math.min(1, f.s[k] / RAMP, (end - f.s[k]) / RAMP);
    const wa = (k: number) => s.w[2 * k];
    const wb = (k: number) => -s.w[2 * k + 1];
    const grey = new THREE.Color('#8e8d8a');
    const red = new THREE.Color('#94564a');
    const isRed = (k: number) => f.x[k] >= s.red[0] && f.x[k] <= s.red[1];
    for (const [k0, k1, r] of spans(f.n, isRed)) {
      const tint = r ? red : grey;
      this.strip(f, k0, k1, wb, wa, 'clinker', (k) => lift(k), (k, _o, out) => out.copy(tint).multiplyScalar(0.96 + 0.08 * hash(k, 5)), [0, 0.5, 1], 1, 'pave_grey', COVER_ORDER - 0.05);
    }
    // Its sides: the step down to the street's pavers.
    this.riser(f, 0, f.n - 1, wa, () => this.road - 0.02, lift, '#7d7c79', true);
    this.riser(f, 0, f.n - 1, wb, () => this.road - 0.02, lift, '#7d7c79', true);
    const inner = (k: number) => f.s[k] > RAMP && end - f.s[k] > RAMP;
    for (const [k0, k1, top] of spans(f.n, inner)) if (top) this.block(f, k0, k1, wb, wa, TOP - 0.01, 'pave_grey');
    for (const z of zebras) {
      // Bands along the street, half a metre wide and as far apart, three metres long, across the whole carriageway.
      let best = 0;
      for (let k = 0; k < f.n; k++) if (Math.hypot(f.x[k] - z.x, f.z[k] - z.z) < Math.hypot(f.x[best] - z.x, f.z[best] - z.z)) best = k;
      const sm = f.s[best];
      const topLift = () => this.road + TOP;
      for (let o = -z.w[1] + 0.45; o < z.w[0] - 0.4; o += 1.0) this.flat(f, [[sm - 1.5, o], [sm + 1.5, o], [sm + 1.5, o + 0.5], [sm - 1.5, o + 0.5]], '#e4e3dd', topLift);
    }
  }

  /** Shark's teeth across the carriageway where a street gives way: white triangles pointing at the drivers. */
  teeth(t: Spot): void {
    // The street's frame near the spot: a short one from the spot back along the street.
    const back = 3;
    const f = new Frame([t.x, t.z, t.x - t.u[0] * back, t.z - t.u[1] * back], 0);
    const lift = () => this.road;
    for (let o = -t.w[1] + 0.3; o + 0.5 < t.w[0] - 0.2; o += 0.75) {
      // The base along the give-way line, the point 0.6 m back towards the driver.
      this.flat(f, [[0.4, -o], [0.4, -(o + 0.5)], [1.0, -(o + 0.25)]], '#e2e1db', lift);
    }
  }
}

/** Runs of consecutive indices 0..n-1 where `test` is the same: [first, last, value], each sharing its last with the next's first. */
function spans(n: number, test: (k: number) => boolean): [number, number, boolean][] {
  const out: [number, number, boolean][] = [];
  let start = 0;
  for (let k = 1; k <= n; k++) {
    if (k === n || test(k) !== test(start)) {
      // A kerb running out at k ends there: the strip reaches the station where it stops.
      out.push([start, Math.min(n - 1, k), test(start)]);
      start = k;
    }
  }
  return out.filter(([a, b]) => b > a);
}

const hidden = new Set(DETAIL.hide);
/** Development only: ?noroads leaves the village's plain road surface, for comparing looks and cost. */
const OFF = import.meta.env.DEV && new URLSearchParams(location.search).has('noroads');

/** The surroundings without the road blocks (and footpaths' gravel) drawn here instead; they stay for walking on. */
export function withRoadDetail<T extends Surroundings>(s: T): T {
  if (!s.prisms || OFF) return s;
  return { ...s, prisms: s.prisms.filter((p) => !hidden.has(`${p.m}|${p.p[0][0][0]}|${p.p[0][0][1]}|${p.p[0].length}`)) };
}

/**
 * The paint, joints and iron: plain colours, matte (a glossy dark line catches the sky at a low angle), a few
 * millimetres up and pulled forward in depth so the surface under them never shows through, even far off. The
 * ground's shading darkens them in the shade of the houses and trees, as it does the road (main.ts).
 */
export const roadPaint = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });

/**
 * The streets' pieces for the tiles, and their blocks for walking on: the ring's (round the plot, at the start) or
 * the village's (when it loads). `ground`: the lawn's height over the relief.
 */
export function buildRoadDetail(village: boolean, renderer: THREE.WebGLRenderer, ground: number): { tiles: { key: string; pieces: Piece[] }[]; blocks: Prism[] } {
  if (OFF) return { tiles: [], blocks: [] };
  const b = new Builder(village, renderer, ground, roadPaint);
  for (const r of DETAIL.runs) b.run(r);
  for (const fl of DETAIL.fills) b.fill(fl.m, fl.r);
  if (village) b.school(DETAIL.school, DETAIL.zebras);
  for (const p of DETAIL.patches ?? []) b.patch(p.t, p.r);
  for (const t of DETAIL.teeth) b.teeth(t);
  return { tiles: b.parts.tiles(), blocks: b.parts.blocks };
}
