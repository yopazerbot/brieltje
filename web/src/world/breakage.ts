import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import raw from '../data/house_shell.json';
import { blockKind, gapWidth, partRings, pieceKey, SMASH, smashPieces, stripRing, type SmashKind, type SmashPiece } from '../../shared/smash.mjs';
import type { Breaker } from './carDamage';
import type { Brush, World } from './collision';
import type { Prism, Ring } from './houseData';
import { isSprigs } from './hedgeCards';
import { prismGeometry } from './houseMeshes';
import { terrain } from './terrain';
import type { Tiles } from './tiles';

/**
 * What a car breaks going through it at speed (Yoshi left it to the merger, 21 Nov 2026): a garden hedge it ploughs
 * through, a light garden fence it flattens (shared/smash.mjs says which). Slower, the hedge is a soft wall and the
 * fence a wall, as before (world/carDamage.ts give).
 *
 * As the big open-world driving games do it: the street's light things break at a speed a little over a walk, the car
 * loses much of its speed going through (a hedge most) and takes a light mark; what is broken stays broken while
 * someone is near and comes back when nobody sees it. Here a gap is a thing of the whole game: the driver's page opens
 * it at once (the car drives on through it) and reports it (`smash`); the server checks it and tells every page and
 * every late joiner (server/carSmash.mjs), and mends it after a while. Every page draws the same gap: its place, width
 * and the car's heading come from the server, the broken stems and the litter from a seed of the piece and the spot.
 *
 * - The block on the plan (world/collision.ts split) is cut straight across its line at the gap's edges: cars, walkers
 *   and the camera go through the gap. Shots go as before (the server decides every hit); the zombies' grids keep the
 *   hedges and fences whole (server/navCache.mjs).
 * - The look: the block's triangles in the tiles' merged meshes are folded away (no new draw for the whole block), and
 *   one small mesh draws what stands: the two parts, their ends broken down in steps, low stubs across the gap, snapped
 *   stems bent the way the car went and flattened leaves past it; a fence's span lies flat the way it was pushed, its
 *   concrete posts snapped off at the foot (the tiles' own posts folded away, world/tiles.ts editInstances), and the
 *   hedges' leaf sprigs in the gap are taken away on Medium and up. Ordinary materials: nothing new per pixel.
 */

/** A gap: m along its piece from the middle, m wide, the car's heading, and whether only this page has it yet. */
interface Gap {
  s: number;
  w: number;
  a: number;
  mine: boolean;
}

/** What a page shows of a broken block: triangles folded away, instances hidden, the mesh of what stands. */
interface Look {
  folds: { mesh: THREE.Mesh; tris: number[]; saved: Float32Array | Uint32Array | Uint16Array; indexed: boolean }[];
  hidden: { mesh: THREE.InstancedMesh; k: number; saved: Float32Array }[];
  group: THREE.Group;
}

/** A piece standing on this page: its number, its line, its block in the world and as drawn, its gaps. */
interface Held {
  id: number;
  piece: SmashPiece & { kind: 'hedge' | 'fence' };
  index: number;
  prism: Prism;
  gaps: Gap[];
  parts: number[];
  look: Look | null;
}

/** A young tree in the cars' way (world/car.ts Obstacle): its circle, and its number once it is a piece. */
interface TreeSpot {
  x: number;
  z: number;
  r: number;
  young?: boolean;
  piece?: number;
}

/** A young tree standing on this page: its circle (the cars'), and how it lies once snapped. */
interface HeldTree {
  id: number;
  spot: TreeSpot;
  r: number;
  down: { a: number; mine: boolean } | null;
  look: { hidden: { mesh: THREE.InstancedMesh; k: number; saved: Float32Array }[]; group: THREE.Group } | null;
}

/** What breaking looks and sounds like (world/crash.ts smash). */
export interface BreakFx {
  smash(kind: SmashKind, x: number, y: number, z: number, nx: number, nz: number, speed: number): void;
}

/** m: a part's broken end, stepped down over these lengths and heights (shares of the hedge's height). */
const RAGGED: [number, number, number][] = [[0, 0.18, 0.78], [0.18, 0.34, 0.52], [-0.22, 0, 0.3]];
/** The colour of a hedge's snapped stems (beech and privet bark, the wood showing) */
const STEM = new THREE.MeshStandardMaterial({ color: '#5b4733', roughness: 0.95 });
const SPLINTER = new THREE.MeshStandardMaterial({ color: '#a8875c', roughness: 0.9 });
/** A hedge's stems and their broken ends in one draw: the colours per box */
const WOOD = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93 });
const BARK = new THREE.Color('#5b4733');
const PALE = new THREE.Color('#a8875c');
/** A fence's concrete posts, as world/surroundings.ts draws them */
const POST = new THREE.MeshStandardMaterial({ color: '#cfccc4', roughness: 0.9 });
const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);

/** A small seeded random (every page draws the same stems for the same gap). */
function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Whether (x, z) is in a ring or within `r` of its outline. */
function nearRing(x: number, z: number, ring: Ring, r: number): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
    const ex = xi - xj, ez = zi - zj, l2 = ex * ex + ez * ez;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - xj) * ex + (z - zj) * ez) / l2)) : 0;
    if (Math.hypot(xj + ex * t - x, zj + ez * t - z) < r) return true;
  }
  return hit;
}

export class Breakage implements Breaker {
  /** The shared list (shared/smash.mjs), once the village's data is in; until then nothing breaks */
  private pieces: SmashPiece[] | null = null;
  private ids = new Map<string, number>();
  private held = new Map<number, Held>();
  private trees = new Map<number, HeldTree>();
  private waiting: { first: number; prisms: Prism[]; drawn?: Set<string> }[] = [];
  private waitingTrees: TreeSpot[][] = [];
  /** What the server told before the list was ready (a welcome comes before the village) */
  private early: [number, number, number, number][] | null = null;
  private triCells = new WeakMap<THREE.BufferGeometry, Map<number, number[]>>();
  /** The meshes of what stands of the broken pieces (in the tiles' group: shot at and shading the ground as the tiles) */
  readonly group = new THREE.Group();
  /** Sends a report to the server (main.ts: when connected) */
  send: ((m: { t: 'smash'; id: number; s: number; w: number }) => void) | null = null;

  constructor(private world: World, private tiles: Tiles, private fx: BreakFx) {
    this.group.name = 'breakage';
    tiles.group.add(this.group);
  }

  /** The village's data as it came (before anything is added to it): the list is made, the blocks waiting are tagged. */
  village(data: { prisms?: Prism[]; trees?: { x: number; z: number; h: number }[] }): void {
    const ring = (raw as unknown as { surroundings?: { prisms?: Prism[]; trees?: { x: number; z: number; h: number }[] } }).surroundings;
    this.pieces = smashPieces([{ prisms: ring?.prisms, trees: ring?.trees }, { prisms: data.prisms, trees: data.trees?.slice() }]);
    this.pieces.forEach((p, i) => p.kind && this.ids.set(p.key, i));
    for (const w of this.waiting.splice(0)) this.tag(w.first, w.prisms, w.drawn);
    for (const list of this.waitingTrees.splice(0)) this.addTrees(list);
    if (this.early) this.setAll(this.early);
  }

  /** The cars' tree circles (world/car.ts, main.ts `trunks`): the young ones that are pieces get their number. */
  addTrees(list: TreeSpot[]): void {
    if (!this.pieces) {
      this.waitingTrees.push(list);
      return;
    }
    for (const o of list) {
      if (!o.young || o.piece !== undefined) continue;
      const id = this.ids.get(`tree:${Math.round(o.x * 100)},${Math.round(o.z * 100)}`); // shared/smash.mjs treeKey
      if (id === undefined || this.pieces[id].kind !== 'sapling' || this.trees.has(id)) continue;
      o.piece = id;
      this.trees.set(id, { id, spot: o, r: o.r, down: null, look: null });
    }
  }

  treeMin(o: { piece?: number }): number {
    const t = o.piece === undefined ? undefined : this.trees.get(o.piece);
    return t && !t.down ? SMASH.sapling.min : Infinity;
  }

  snap(o: { piece?: number }, yaw: number, speed: number): { keep: number; lose: number; dent: number } | null {
    const t = o.piece === undefined ? undefined : this.trees.get(o.piece);
    if (!t || t.down) return null;
    const a = Math.round(yaw * 100) / 100;
    this.fell(t, a, true);
    this.fx.smash('sapling', t.spot.x, this.groundAt(t.spot.x, t.spot.z) + 0.6, t.spot.z, -Math.sin(yaw), -Math.cos(yaw), speed);
    this.send?.({ t: 'smash', id: t.id, s: 0, w: 0 });
    return { keep: SMASH.sapling.keep, lose: SMASH.sapling.lose, dent: 0.3 };
  }

  /** Young tree `t` snapped, falling the way `a` (a heading) goes: out of the cars' way, drawn lying, a stump left. */
  private fell(t: HeldTree, a: number, mine: boolean): void {
    t.down = { a, mine };
    t.spot.r = 0; // no car stops at it (its stump stays a block for walkers: world/trunkBlocks.ts)
    this.unfell(t, false);
    const { x, z } = t.spot;
    const hidden: { mesh: THREE.InstancedMesh; k: number; saved: Float32Array }[] = [];
    const group = new THREE.Group();
    // Every drawn copy of the tree (its trunk, its crown near and far, its shadow's stand-ins) turned over about a point
    // a little up its trunk, the way the car went.
    const [fx, fz] = [-Math.sin(a), -Math.cos(a)];
    const axis = new THREE.Vector3(fz, 0, -fx);
    let base = Infinity;
    const at: { mesh: THREE.InstancedMesh; k: number }[] = [];
    this.tiles.editInstances((mesh) => mesh.userData.material === 'hedge' && !isSprigs(mesh), (src, mesh) => { // the trees' runs (world/surroundings.ts tags them so)
      for (let k = 0; k < src.length / 16; k++) {
        if (Math.abs(src[k * 16 + 12] - x) < 0.3 && Math.abs(src[k * 16 + 14] - z) < 0.3 && src[k * 16 + 5] !== 0) {
          at.push({ mesh, k });
          base = Math.min(base, src[k * 16 + 13]);
        }
      }
      return false;
    });
    if (at.length) {
      const rand = seeded(t.id * 7919 + 5);
      const pivot = new THREE.Vector3(x, base + 0.3 + rand() * 0.15, z);
      // Over to the ground, or leaning on what stands in the way (a wall, a fence, a car): never through it.
      const tall = Math.max(1.5, (this.pieces?.[t.id]?.h ?? 4) - 0.3);
      const lies = 1.32 + rand() * 0.12;
      const tilt = [lies, 1.1, 0.85, 0.6, 0.4].find((k) => !this.world.blocked(
        { x: x + fx * 0.4 * Math.sin(k), y: pivot.y + 0.4 * Math.cos(k) + 0.2, z: z + fz * 0.4 * Math.sin(k) },
        { x: x + fx * tall * Math.sin(k), y: pivot.y + tall * Math.cos(k) + 0.2, z: z + fz * tall * Math.sin(k) }, 0.25)) ?? 0.3;
      const turn = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z)
        .multiply(new THREE.Matrix4().makeRotationAxis(axis, tilt))
        .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
      const m = new THREE.Matrix4();
      const meshes = new Set(at.map((e) => e.mesh));
      this.tiles.editInstances((mesh) => meshes.has(mesh), (src, mesh) => {
        for (const e of at) {
          if (e.mesh !== mesh) continue;
          hidden.push({ mesh, k: e.k, saved: src.slice(e.k * 16, e.k * 16 + 16) });
          m.fromArray(src, e.k * 16).premultiply(turn).toArray(src, e.k * 16);
        }
        return true;
      });
      // The stump, snapped: bark, its broken top pale.
      const h = pivot.y - base + 0.05;
      const stump = mergeGeometries([box.clone().applyMatrix4(new THREE.Matrix4().makeTranslation(x, base - 0.05, z).multiply(new THREE.Matrix4().makeScale(0.11, h, 0.11)))]);
      const top = box.clone().applyMatrix4(new THREE.Matrix4().makeTranslation(x, base - 0.05 + h, z).multiply(new THREE.Matrix4().makeRotationY(a)).multiply(new THREE.Matrix4().makeScale(0.09, 0.07, 0.05)));
      const sm = new THREE.Mesh(stump, STEM);
      const tm = new THREE.Mesh(top, SPLINTER);
      for (const mesh of [sm, tm]) {
        mesh.receiveShadow = true;
        mesh.userData.material = 'wood';
        group.add(mesh);
      }
    }
    t.look = { hidden, group };
    this.group.add(group);
  }

  /** Young tree `t` standing again (`stand`: back in the cars' way). */
  private unfell(t: HeldTree, stand = true): void {
    const look = t.look;
    if (look) {
      const meshes = new Set(look.hidden.map((e) => e.mesh));
      if (meshes.size) {
        this.tiles.editInstances((m) => meshes.has(m), (src, mesh) => {
          for (const e of look.hidden) if (e.mesh === mesh) src.set(e.saved, e.k * 16);
          return true;
        });
      }
      for (const child of look.group.children) (child as THREE.Mesh).geometry.dispose();
      look.group.removeFromParent();
      t.look = null;
    }
    if (stand) {
      t.down = null;
      t.spot.r = t.r;
    }
  }

  /**
   * Blocks added to the world from `first` on (World.addPrisms): those that are pieces get their number. `drawn`: the
   * keys of those drawn by the tiles (not those a model of ours stands for); without, all are.
   */
  addBlocks(first: number, prisms: readonly Prism[], drawn?: readonly Prism[]): void {
    const keys = drawn ? new Set(drawn.filter((p) => blockKind(p)).map((p) => pieceKey(p))) : undefined;
    if (this.pieces) this.tag(first, prisms, keys);
    else this.waiting.push({ first, prisms: [...prisms], drawn: keys });
  }

  private tag(first: number, prisms: readonly Prism[], drawn?: Set<string>): void {
    prisms.forEach((p, i) => {
      if (!blockKind(p)) return;
      const key = pieceKey(p);
      const id = this.ids.get(key);
      if (id === undefined || this.held.has(id) || (drawn && !drawn.has(key))) return;
      const piece = this.pieces![id];
      if (piece.kind !== 'hedge' && piece.kind !== 'fence') return;
      this.held.set(id, { id, piece: piece as Held['piece'], index: first + i, prism: p, gaps: [], parts: [], look: null });
      this.world.tagPiece(first + i, id);
    });
  }

  // --- the car (world/carDamage.ts Breaker) -----------------------------------------------------------------------

  width(b: Brush, yaw: number, halfL: number, halfW: number): number {
    const h = b.piece === undefined ? undefined : this.held.get(b.piece);
    return h ? gapWidth(h.piece, yaw, halfL, halfW) : 0;
  }

  min(b: Brush): number {
    const h = b.piece === undefined ? undefined : this.held.get(b.piece);
    return h ? SMASH[h.piece.kind].min : Infinity;
  }

  smash(b: Brush, x: number, z: number, yaw: number, width: number, speed: number): { keep: number; lose: number; dent: number } | null {
    const h = b.piece === undefined ? undefined : this.held.get(b.piece);
    if (!h) return null;
    const p = h.piece;
    // Where the car's middle line crosses the piece's line.
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const nx = -p.uz, nz = p.ux;
    const fn = fx * nx + fz * nz;
    if (Math.abs(fn) < 0.3) return null;
    const t = -((x - p.cx) * nx + (z - p.cz) * nz) / fn;
    const s = Math.round(Math.max(-p.half, Math.min(p.half, (x + fx * t - p.cx) * p.ux + (z + fz * t - p.cz) * p.uz)) * 100) / 100;
    const w = Math.round(width * 100) / 100;
    if (h.gaps.length >= SMASH.perPiece || h.gaps.some((g) => Math.abs(g.s - s) < (g.w + w) * 0.375)) return null;
    h.gaps.push({ s, w, a: Math.round(yaw * 100) / 100, mine: true });
    this.rebuild(h);
    const [gx, gz] = [p.cx + p.ux * s, p.cz + p.uz * s];
    this.fx.smash(p.kind, gx, this.groundAt(gx, gz) + 0.6, gz, fx, fz, speed);
    this.send?.({ t: 'smash', id: h.id, s, w });
    const k = SMASH[p.kind];
    return { keep: k.keep, lose: k.lose, dent: p.kind === 'hedge' ? 0.15 : 0.4 };
  }

  // --- the server -------------------------------------------------------------------------------------------------

  /** A gap the server took (this page's own, now sure; or another car's): opened if new. `fresh`: joining, no noise. */
  heard(id: number, s: number, w: number, a: number, fresh = false): void {
    const t = this.trees.get(id);
    if (t && Number.isFinite(a)) {
      if (t.down?.mine) {
        t.down.mine = false;
        if (t.down.a !== a) this.fell(t, a, false);
      } else if (!t.down) {
        this.fell(t, a, false);
        if (!fresh) this.fx.smash('sapling', t.spot.x, this.groundAt(t.spot.x, t.spot.z) + 0.6, t.spot.z, -Math.sin(a), -Math.cos(a), SMASH.sapling.min * 2);
      }
      return;
    }
    const h = this.held.get(id);
    if (!h || ![s, w, a].every(Number.isFinite)) return;
    const own = h.gaps.find((g) => g.mine && Math.abs(g.s - s) < 0.6);
    if (own) {
      own.mine = false;
      if (own.s !== s || own.w !== w || own.a !== a) { // the server's numbers, so every page draws the same
        Object.assign(own, { s, w, a });
        this.rebuild(h);
      }
      return;
    }
    if (h.gaps.some((g) => Math.abs(g.s - s) < 0.02)) return;
    h.gaps.push({ s, w, a, mine: false });
    this.rebuild(h);
    if (!fresh) {
      const [gx, gz] = [h.piece.cx + h.piece.ux * s, h.piece.cz + h.piece.uz * s];
      this.fx.smash(h.piece.kind, gx, this.groundAt(gx, gz) + 0.6, gz, -Math.sin(a), -Math.cos(a), SMASH[h.piece.kind].min * 2);
    }
  }

  /** The server refused this page's own report: the gap it opened ahead closes. */
  refused(id: number, s: number): void {
    const t = this.trees.get(id);
    if (t?.down?.mine) return this.unfell(t);
    const h = this.held.get(id);
    const i = h?.gaps.findIndex((g) => g.mine && Math.abs(g.s - s) < 0.011) ?? -1;
    if (!h || i < 0) return;
    h.gaps.splice(i, 1);
    this.rebuild(h);
  }

  /** Mended (the server's `mend`): these gaps, or (`all`) every one. */
  mend(list: [number, number][] | null): void {
    for (const t of this.trees.values()) if (t.down && (!list || list.some(([id]) => id === t.id))) this.unfell(t);
    for (const h of this.held.values()) {
      if (!h.gaps.length) continue;
      const before = h.gaps.length;
      h.gaps = list ? h.gaps.filter((g) => !list.some(([id, s]) => id === h.id && Math.abs(g.s - s) < 0.011)) : [];
      if (h.gaps.length !== before) this.rebuild(h);
    }
  }

  /** The server's whole list (a welcome): everything else mended, these broken, quietly. */
  setAll(list: [number, number, number, number][]): void {
    if (!this.pieces) {
      this.early = list;
      return;
    }
    this.early = null;
    this.mend(null);
    for (const [id, s, w, a] of list) this.heard(id, s, w, a, true);
  }

  /** How many gaps this page shows (the dev tools). */
  get count(): number {
    let n = 0;
    for (const h of this.held.values()) n += h.gaps.length;
    for (const t of this.trees.values()) if (t.down) n++;
    return n;
  }

  /** The pieces of a kind near (x, z) within `r` m, for the dev tools: [id, s at the nearest point, distance]. */
  nearest(kind: 'hedge' | 'fence', x: number, z: number, r = 30): [number, number, number][] {
    const out: [number, number, number][] = [];
    for (const h of this.held.values()) {
      const p = h.piece;
      if (p.kind !== kind) continue;
      const s = Math.max(-p.half, Math.min(p.half, (x - p.cx) * p.ux + (z - p.cz) * p.uz));
      const d = Math.hypot(p.cx + p.ux * s - x, p.cz + p.uz * s - z);
      if (d < r) out.push([h.id, s, d]);
    }
    return out.sort((a, b) => a[2] - b[2]);
  }

  /** The young trees that snap near (x, z) within `r` m, for the dev tools: [id, x, z, distance]. */
  nearestTrees(x: number, z: number, r = 30): [number, number, number, number][] {
    const out: [number, number, number, number][] = [];
    for (const t of this.trees.values()) {
      const d = Math.hypot(t.spot.x - x, t.spot.z - z);
      if (d < r) out.push([t.id, t.spot.x, t.spot.z, d]);
    }
    return out.sort((a, b) => a[3] - b[3]);
  }

  /** A piece's line and its block's outline (the dev tools). */
  pieceOf(id: number): { piece: SmashPiece; ring: Ring; y0: number; y1: number } | null {
    const h = this.held.get(id);
    return h ? { piece: h.piece, ring: h.prism.p[0], y0: h.prism.y0, y1: h.prism.y1 } : null;
  }

  // --- the block and its look -------------------------------------------------------------------------------------

  private groundAt(x: number, z: number): number {
    return this.world.groundAt(x, z, 50, 100).y;
  }

  /** The block cut again for its gaps, and drawn again. */
  private rebuild(h: Held): void {
    this.world.unsplit(h.index, h.parts);
    h.parts = h.gaps.length ? this.world.split(h.index, partRings(h.prism.p[0], h.piece, h.gaps)) : [];
    if (!h.gaps.length) {
      this.world.setSolid(h.index, true);
      if (h.look) this.unlook(h.look);
      h.look = null;
      return;
    }
    if (!h.look) h.look = { folds: [], hidden: [], group: new THREE.Group() };
    const look = h.look;
    const template = look.folds.length ? null : this.fold(h, look);
    if (template === undefined) return; // nothing of it drawn by the tiles: only its block changes
    for (const child of look.group.children) (child as THREE.Mesh).geometry.dispose();
    look.group.clear();
    if (h.piece.kind === 'hedge') this.hedgeLook(h, look);
    else this.fenceLook(h, look);
    if (!look.group.parent) this.group.add(look.group);
  }

  /** The tiles' triangles of the block folded away (and its sprigs or posts in the gaps hidden); undefined: none found. */
  private fold(h: Held, look: Look): null | undefined {
    const ring = h.prism.p[0];
    const xs = ring.map((v) => v[0]), zs = ring.map((v) => v[1]);
    const [x0, x1, z0, z1] = [Math.min(...xs) - 0.1, Math.max(...xs) + 0.1, Math.min(...zs) - 0.1, Math.max(...zs) + 0.1];
    for (const obj of this.tiles.group.children) {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh || mesh.userData.material !== h.prism.m) continue;
      const g = mesh.geometry;
      const pos = g.attributes.position as THREE.BufferAttribute;
      const index = g.index;
      const tris: number[] = [];
      for (const t of this.trianglesIn(g, x0, z0, x1, z1)) {
        let cx = 0, cz = 0;
        for (let v = 0; v < 3; v++) {
          const k = index ? index.getX(t * 3 + v) : t * 3 + v;
          cx += pos.getX(k) / 3;
          cz += pos.getZ(k) / 3;
        }
        if (nearRing(cx, cz, ring, 0.04)) tris.push(t);
      }
      if (!tris.length) continue;
      if (index) {
        const saved = new Uint32Array(tris.length * 3);
        tris.forEach((t, i) => {
          for (let v = 0; v < 3; v++) saved[i * 3 + v] = index.getX(t * 3 + v);
          for (let v = 0; v < 3; v++) index.setX(t * 3 + v, saved[i * 3]);
        });
        index.needsUpdate = true;
        look.folds.push({ mesh, tris, saved, indexed: true });
      } else {
        const saved = new Float32Array(tris.length * 9);
        tris.forEach((t, i) => {
          for (let v = 0; v < 3; v++) for (let c = 0; c < 3; c++) saved[i * 9 + v * 3 + c] = pos.getComponent(t * 3 + v, c);
          for (let v = 1; v < 3; v++) pos.setXYZ(t * 3 + v, saved[i * 9], saved[i * 9 + 1], saved[i * 9 + 2]);
          pos.setXYZ(t * 3, saved[i * 9], saved[i * 9 + 1], saved[i * 9 + 2]);
        });
        pos.needsUpdate = true;
        look.folds.push({ mesh, tris, saved, indexed: false });
      }
    }
    return look.folds.length ? null : undefined;
  }

  /** A geometry's triangles whose boxes overlap a rectangle (a grid of 8 m made the first time it is asked). */
  private trianglesIn(g: THREE.BufferGeometry, x0: number, z0: number, x1: number, z1: number): number[] {
    const CELL = 8;
    let cells = this.triCells.get(g);
    const key = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);
    if (!cells) {
      cells = new Map();
      const pos = g.attributes.position as THREE.BufferAttribute;
      const index = g.index;
      const n = (index ? index.count : pos.count) / 3;
      for (let t = 0; t < n; t++) {
        const k = index ? index.getX(t * 3) : t * 3;
        const i = Math.floor(pos.getX(k) / CELL), j = Math.floor(pos.getZ(k) / CELL);
        const c = key(i, j);
        const list = cells.get(c);
        if (list) list.push(t);
        else cells.set(c, [t]);
      }
      this.triCells.set(g, cells);
    }
    const out: number[] = [];
    // A triangle is filed by its first corner: one up to a cell away still reaches into the rectangle.
    for (let i = Math.floor(x0 / CELL) - 1; i <= Math.floor(x1 / CELL) + 1; i++) {
      for (let j = Math.floor(z0 / CELL) - 1; j <= Math.floor(z1 / CELL) + 1; j++) out.push(...(cells.get(key(i, j)) ?? []));
    }
    return out;
  }

  /** Put back what `fold` and the instances' hiding took, and drop the look's mesh. */
  private unlook(look: Look): void {
    for (const f of look.folds) {
      const g = f.mesh.geometry;
      if (f.indexed) {
        const index = g.index!;
        f.tris.forEach((t, i) => {
          for (let v = 0; v < 3; v++) index.setX(t * 3 + v, f.saved[i * 3 + v]);
        });
        index.needsUpdate = true;
      } else {
        const pos = g.attributes.position as THREE.BufferAttribute;
        f.tris.forEach((t, i) => {
          for (let v = 0; v < 3; v++) pos.setXYZ(t * 3 + v, f.saved[i * 9 + v * 3], f.saved[i * 9 + v * 3 + 1], f.saved[i * 9 + v * 3 + 2]);
        });
        pos.needsUpdate = true;
      }
    }
    this.showInstances(look);
    for (const child of look.group.children) (child as THREE.Mesh).geometry.dispose();
    look.group.removeFromParent();
  }

  private showInstances(look: Look): void {
    if (!look.hidden.length) return;
    const meshes = new Set(look.hidden.map((e) => e.mesh));
    this.tiles.editInstances((m) => meshes.has(m), (src, mesh) => {
      for (const e of look.hidden) if (e.mesh === mesh) src.set(e.saved, e.k * 16);
      return true;
    });
    look.hidden = [];
  }

  /**
   * Hide the instances of the tiles' meshes `pick` takes that stand in the gaps of `h` (within `across` m of its line),
   * keeping them for `unlook`; `seen(x, z, matrix)` hears of each.
   */
  private hideInstances(h: Held, look: Look, pick: (m: THREE.InstancedMesh) => boolean, across: number, seen?: (x: number, z: number, m: THREE.Matrix4) => void): void {
    this.showInstances(look);
    const p = h.piece;
    const m4 = new THREE.Matrix4();
    this.tiles.editInstances(pick, (src, mesh) => {
      let any = false;
      for (let k = 0; k < src.length / 16; k++) {
        const x = src[k * 16 + 12], z = src[k * 16 + 14];
        const dx = x - p.cx, dz = z - p.cz;
        if (Math.abs(-dx * p.uz + dz * p.ux) > across) continue;
        const s = dx * p.ux + dz * p.uz;
        if (!h.gaps.some((g) => Math.abs(s - g.s) <= g.w / 2)) continue;
        look.hidden.push({ mesh, k, saved: src.slice(k * 16, k * 16 + 16) });
        if (seen) seen(x, z, m4.fromArray(src, k * 16));
        for (let c = 0; c < 15; c++) src[k * 16 + c] = 0; // scaled to nothing
        any = true;
      }
      return any;
    });
  }

  /** The block's own outline cut from `a` to `b` along its line, at a share `k` of its height: a Prism to draw. */
  private slice(h: Held, a: number, b: number, k = 1, ring = h.prism.p[0]): Prism | null {
    const r = stripRing(ring, h.piece, a, b);
    return r ? { ...h.prism, p: [r], y1: h.prism.y0 + (h.prism.y1 - h.prism.y0) * k } : null;
  }

  /** Geometries with the attributes of the tiles' mesh (`like`: its first folded vertex's values), merged into one. */
  private merged(geos: THREE.BufferGeometry[], like?: { mesh: THREE.Mesh; vertex: number }): THREE.BufferGeometry | null {
    if (!geos.length) return null;
    if (like) {
      const src = like.mesh.geometry;
      for (const g of geos) {
        for (const [name, attr] of Object.entries(src.attributes)) {
          if (g.getAttribute(name)) continue;
          const a = attr as THREE.BufferAttribute;
          const n = g.attributes.position.count;
          // The folded vertex's values; on a phone the tiles drop these arrays once drawn (world/tiles.ts), and keep the
          // first vertex's values for this (`sample`).
          const sample = (like.mesh.userData.sample as Record<string, THREE.TypedArray> | undefined)?.[name];
          const from: THREE.TypedArray | null = a.array ? a.array.slice(like.vertex * a.itemSize, (like.vertex + 1) * a.itemSize) : (sample ?? null);
          if (!from) continue;
          const array = new (from.constructor as new (n: number) => THREE.TypedArray)(n * a.itemSize);
          for (let i = 0; i < n; i++) array.set(from, i * a.itemSize);
          g.setAttribute(name, new THREE.BufferAttribute(array, a.itemSize, a.normalized));
        }
        for (const name of Object.keys(g.attributes)) if (!src.getAttribute(name)) g.deleteAttribute(name);
      }
    }
    const out = geos.length > 1 ? mergeGeometries(geos.map((g) => (g.index ? g.toNonIndexed() : g))) : geos[0];
    if (geos.length > 1) geos.forEach((g) => g.dispose());
    return out;
  }

  /** The tiles' mesh the block was drawn in and a vertex of it, for the material and the attributes. */
  private like(look: Look): { mesh: THREE.Mesh; vertex: number } | undefined {
    const f = look.folds[0];
    if (!f) return undefined;
    const vertex = f.indexed ? f.saved[0] : f.tris[0] * 3;
    return { mesh: f.mesh, vertex };
  }

  /** A mesh of `geos` in the tiles' material, shading and throwing shadow as the tiles' mesh does. */
  private addLike(look: Look, geos: THREE.BufferGeometry[]): void {
    const like = this.like(look);
    const g = this.merged(geos, like);
    if (!g || !like) return;
    const mesh = new THREE.Mesh(g, like.mesh.material);
    mesh.castShadow = like.mesh.castShadow;
    mesh.receiveShadow = true;
    mesh.renderOrder = like.mesh.renderOrder;
    mesh.userData.material = like.mesh.userData.material;
    mesh.position.copy(like.mesh.position);
    look.group.add(mesh);
  }

  /** Boxes (each a matrix of the unit box standing on its foot) in one material; `colors`: each its own (one draw). */
  private addBoxes(look: Look, matrices: THREE.Matrix4[], material: THREE.Material, tag: string, colors?: THREE.Color[]): void {
    if (!matrices.length) return;
    const g = mergeGeometries(matrices.map((m, i) => {
      const b = box.clone().applyMatrix4(m);
      if (colors) {
        const c = colors[i];
        b.setAttribute('color', new THREE.Float32BufferAttribute(new Array(b.attributes.position.count).fill([c.r, c.g, c.b]).flat(), 3));
      }
      return b;
    }));
    const mesh = new THREE.Mesh(g, material);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.userData.material = tag;
    look.group.add(mesh);
  }

  /**
   * A hedge with gaps: its parts, each broken end stepped down (RAGGED), low stubs across the gap, snapped stems bent
   * the way the car went, flattened leaves past it; its sprigs in the gap gone.
   */
  private hedgeLook(h: Held, look: Look): void {
    const p = h.piece;
    const height = h.prism.y1 - h.prism.y0;
    const geos: THREE.BufferGeometry[] = [];
    const stems: THREE.Matrix4[] = [];
    const splinters: THREE.Matrix4[] = [];
    // What stands, drawn back from each gap by the ragged ends' length.
    const back = RAGGED[1][1];
    for (const r of partRings(h.prism.p[0], p, h.gaps.map((g) => ({ s: g.s, w: g.w + 2 * back })))) geos.push(prismGeometry({ ...h.prism, p: [r] }));
    for (const g of h.gaps) {
      const rand = seeded(h.id * 7919 + Math.round(g.s * 100) * 31 + 17);
      const [fx, fz] = [-Math.sin(g.a), -Math.cos(g.a)];
      const edge = [g.s - g.w / 2, g.s + g.w / 2];
      // The broken ends: stepped down towards the gap, a little different each side.
      for (const [side, e] of [[-1, edge[0]], [1, edge[1]]] as const) { // -1: the part before the gap, 1: after it
        for (const [a, b, k] of RAGGED) {
          const lo = e + side * a, hi = e + side * b; // out from the gap's edge into the part (a negative `a`: into the gap)
          const q = this.slice(h, Math.min(lo, hi), Math.max(lo, hi), Math.min(1, k * (0.85 + 0.3 * rand())));
          if (q) geos.push(prismGeometry(q));
        }
      }
      // Low stubs across the gap: what the car flattened, a hand or two high.
      for (let s = edge[0] + 0.2; s < edge[1] - 0.2; s += 0.22 + rand() * 0.12) {
        const q = this.slice(h, s, s + 0.14 + rand() * 0.1, Math.min(0.35, (0.05 + rand() * 0.15) / Math.max(0.5, height)));
        if (q) geos.push(prismGeometry(q));
      }
      // Flattened leaves past it, the way the car went: low patches on the ground.
      for (let i = 0; i < 4; i++) {
        const s = g.s + (rand() - 0.5) * g.w * 0.8;
        const out = 0.6 + rand() * 2.2;
        const [cx, cz] = [p.cx + p.ux * s + fx * out, p.cz + p.uz * s + fz * out];
        const half = 0.25 + rand() * 0.35, side = 0.2 + rand() * 0.25, turn = g.a + (rand() - 0.5) * 0.8;
        const [ax, az] = [-Math.sin(turn), -Math.cos(turn)];
        const ring: Ring = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [cx + ax * half * u - az * side * v, cz + az * half * u + ax * side * v]);
        geos.push(prismGeometry({ ...h.prism, p: [ring], y0: h.prism.y0, y1: h.prism.y0 + 0.17 + rand() * 0.06 }));
      }
      // Snapped stems: from the stubs, bent over the way the car went; their broken ends pale.
      const n = Math.round(g.w * 7);
      const thick = Math.max(0.2, p.thick);
      const tilt = new THREE.Matrix4();
      for (let i = 0; i < n; i++) {
        const s = edge[0] + 0.15 + rand() * (g.w - 0.3);
        const across = (rand() - 0.5) * thick * 0.9;
        const x = p.cx + p.ux * s - p.uz * across, z = p.cz + p.uz * s + p.ux * across;
        const y = this.baseAt(h, x, z) + 0.05 + rand() * 0.12;
        const len = 0.3 + rand() * 0.55, r = 0.012 + rand() * 0.014;
        const lean = 0.7 + rand() * 0.75; // rad from upright, over towards where the car went
        const way = g.a + (rand() - 0.5) * 0.9;
        const m = new THREE.Matrix4().makeTranslation(x, y, z)
          .multiply(tilt.makeRotationY(way))
          .multiply(new THREE.Matrix4().makeRotationX(-lean))
          .multiply(new THREE.Matrix4().makeScale(r, len, r));
        stems.push(m);
        if (rand() < 0.5) splinters.push(new THREE.Matrix4().makeTranslation(x, y - 0.02, z).multiply(new THREE.Matrix4().makeScale(r * 1.2, 0.06, r * 1.2)));
      }
    }
    this.addLike(look, geos);
    this.addBoxes(look, [...stems, ...splinters], WOOD, 'wood', [...stems.map(() => BARK), ...splinters.map(() => PALE)]);
    // The leaf sprigs (Medium and up) in the gaps.
    this.hideInstances(h, look, isSprigs, p.thick / 2 + 0.7);
  }

  /** A fence with gaps: its parts standing, each gap's span lying flat the way it was pushed, its posts snapped. */
  private fenceLook(h: Held, look: Look): void {
    const p = h.piece;
    const geos: THREE.BufferGeometry[] = [];
    for (const r of partRings(h.prism.p[0], p, h.gaps)) geos.push(prismGeometry({ ...h.prism, p: [r] }));
    const posts: THREE.Matrix4[] = [];
    const stumps: THREE.Matrix4[] = [];
    const nx = -p.uz, nz = p.ux;
    // The posts in the gaps, the tiles' own hidden: where they stood, snapped off at the foot.
    const stood: { x: number; z: number; h: number }[] = [];
    this.hideInstances(h, look, (m) => (m.geometry as THREE.BoxGeometry).parameters?.width === 0.1 && (m.geometry as THREE.BoxGeometry).parameters?.height === 1, 0.25, (x, z, m) => {
      const e = m.elements;
      stood.push({ x, z, h: Math.hypot(e[4], e[5], e[6]) });
    });
    for (const g of h.gaps) {
      const rand = seeded(h.id * 7919 + Math.round(g.s * 100) * 31 + 23);
      const [fx, fz] = [-Math.sin(g.a), -Math.cos(g.a)];
      const fall = Math.sign(fx * nx + fz * nz) || 1; // the side it was pushed over to
      // The span in two halves, flat or nearly, each bent at its own angle, lying on the ground beyond the line.
      const halves: [number, number][] = [[g.s - g.w / 2, g.s], [g.s, g.s + g.w / 2]];
      for (const [a, b] of halves) {
        const q = this.slice(h, a + 0.03, b - 0.03);
        if (!q) continue;
        const geo = prismGeometry({ ...q, d: undefined });
        const mid = (a + b) / 2;
        const [bx, bz] = [p.cx + p.ux * mid, p.cz + p.uz * mid];
        const by = this.baseAt(h, bx, bz) - h.prism.y0;
        const angle = fall * (1.38 + rand() * 0.14);
        const axis = new THREE.Vector3(p.ux, 0, p.uz);
        const m = new THREE.Matrix4().makeTranslation(bx, by + h.prism.y0 + 0.05, bz)
          .multiply(new THREE.Matrix4().makeRotationAxis(axis, angle))
          .multiply(new THREE.Matrix4().makeTranslation(-bx, -h.prism.y0, -bz));
        geo.applyMatrix4(m);
        geos.push(geo);
      }
      // A post snapped off at its foot for each that stood in the gap; at least one where the car struck.
      const here = stood.filter((q) => Math.abs((q.x - p.cx) * p.ux + (q.z - p.cz) * p.uz - g.s) <= g.w / 2);
      if (!here.length) here.push({ x: p.cx + p.ux * g.s, z: p.cz + p.uz * g.s, h: h.prism.y1 - h.prism.y0 + 0.1 });
      for (const q of here) {
        const y = this.baseAt(h, q.x, q.z) - 0.05;
        stumps.push(new THREE.Matrix4().makeTranslation(q.x, y, q.z).multiply(new THREE.Matrix4().makeScale(0.1, 0.12 + rand() * 0.1, 0.1)));
        const lean = fall * (1.35 + rand() * 0.15);
        posts.push(new THREE.Matrix4().makeTranslation(q.x + nx * fall * 0.08, y + 0.08, q.z + nz * fall * 0.08)
          .multiply(new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(p.ux, 0, p.uz), lean))
          .multiply(new THREE.Matrix4().makeScale(0.1, Math.max(0.4, q.h - 0.2), 0.1)));
      }
    }
    this.addLike(look, geos);
    this.addBoxes(look, [...posts, ...stumps], POST, 'concrete');
  }

  /** The ground under a piece's foot at (x, z), as its block stands on it (the tiles' heights: the relief). */
  private baseAt(h: Held, x: number, z: number): number {
    return (h.prism.d ? terrain.height(x, z) : 0) + h.prism.y0 + 0.15;
  }
}
