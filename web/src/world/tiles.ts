import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Surroundings } from './houseData';

/**
 * The surroundings in tiles of TILE metres, centred on the plot's middle (tools/build_house.py
 * cuts the ground covers, hedges and fences along the same lines), drawn with as few draw calls
 * as the ring alone took before the village came.
 *
 * The area is a strip from the house to the church of Smetlede, so the tiles are sorted along
 * that line (by `axial`), and each material is one mesh with the tiles in that order: the tiles
 * within the draw distance along the line are one run of it, drawn with one draw call (a draw
 * range). Trees, fence posts and street lamps are instanced shapes, their instances in the same
 * order. A tile is within reach when its nearest point is closer than the draw distance, which
 * follows the haze (the fog hides about 85% at 725 m); the run drawn goes from the first tile
 * within reach to the last (in a strip, the few between are mostly within reach too). This is
 * checked four times a second and after a jump, not per mesh per frame. The ring (loaded at the
 * start) and the village (loaded later) are two such sets. Small details (windows and doors,
 * gutters, cables, lamps, fence posts, solar panels) stop at DETAIL metres: a few pixels in the
 * haze there, and the most triangles for what they show.
 *
 * The sun's real-time shadow only covers the house, so in the shadow pass the ring's meshes draw
 * only the tiles round the house.
 */

export const TILE = 200;
const CX = 4.45;
const CZ = -3;
// The line from the plot's middle to the church (model coordinates).
const UX = (521.5 - CX) / Math.hypot(521.5 - CX, -744.2 - CZ);
const UZ = (-744.2 - CZ) / Math.hypot(521.5 - CX, -744.2 - CZ);
/** A tile's half length along the line. */
const HALF = (TILE / 2) * (Math.abs(UX) + Math.abs(UZ));
/** Metres along the line from the house: the tiles round the house that the sun's shadow can reach. */
const SHADOW = 160;
/** Metres: the draw distance of small details. */
const DETAIL = 400;

/** Where a point lies along the line from the house to the church (metres from the house). */
export function axial(x: number, z: number): number {
  return (x - CX) * UX + (z - CZ) * UZ;
}

/** The tile (i, j) that a point lies in, as a key. */
export function tileKey(x: number, z: number): string {
  return `${Math.floor((x - CX) / TILE + 0.5)},${Math.floor((z - CZ) / TILE + 0.5)}`;
}

/** The surroundings data sorted into tiles; poles stay one list (cables join poles of two tiles), each tile names its own. */
export interface TileData extends Omit<Surroundings, 'poles'> {
  /** Numbers of the poles that stand in this tile */
  poleIds: number[];
}

export function splitTiles(data: Surroundings, poleOffset = 0): Map<string, TileData> {
  const tiles = new Map<string, TileData>();
  const tile = (x: number, z: number) => {
    const key = tileKey(x, z);
    let t = tiles.get(key);
    if (!t) {
      t = { roofs: [], trees: [], openings: [], posts: [], prisms: [], solar: [], wires: [], poleIds: [] };
      tiles.set(key, t);
    }
    return t;
  };
  const middle = (pts: [number, number][]) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of pts) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
    }
    return [(x0 + x1) / 2, (z0 + z1) / 2] as const;
  };
  for (const p of data.prisms ?? []) tile(...middle(p.p[0])).prisms!.push(p);
  for (const r of data.roofs) tile(...middle(r.p)).roofs.push(r);
  for (const t of data.trees) tile(t.x, t.z).trees.push(t);
  for (const o of data.openings ?? []) tile((o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2).openings!.push(o);
  for (const p of data.posts ?? []) tile(p[0], p[1]).posts!.push(p);
  for (const s of data.solar ?? []) tile(...middle(s.q.map((q) => [q[0], q[2]] as [number, number]))).solar!.push(s);
  (data.poles ?? []).forEach((p, i) => tile(p.x, p.z).poleIds.push(poleOffset + i));
  // A cable goes with the tile of its first pole that this data has.
  const own = (i: number) => i - poleOffset >= 0 && i - poleOffset < (data.poles ?? []).length;
  for (const w of data.wires ?? []) {
    const p = data.poles![(own(w[0]) ? w[0] : w[1]) - poleOffset];
    tile(p.x, p.z).wires!.push(w);
  }
  return tiles;
}

/** One part of a tile: geometry merged per material, or one shape repeated (trees, posts, lamps). */
export interface Piece {
  material: THREE.Material;
  geometry: THREE.BufferGeometry;
  /** What a bullet hit on it looks and sounds like (a surface name) */
  tag: string;
  /** Throws a shadow */
  shadow: boolean;
  /** Copies of a shared shape, placed so; without: the geometry once, where it is */
  at?: THREE.Matrix4[];
  /** Drawn after the rest (glass) */
  order?: number;
  /** A small detail: drawn within DETAIL metres */
  small?: boolean;
}

/** One mesh of a set and where each tile's part of it starts (vertices, indices or instances). */
interface Run {
  mesh: THREE.Mesh;
  offsets: number[];
  /** Instanced: every instance's matrix in tile order, to copy the shown run from */
  source?: Float32Array;
  small?: boolean;
}

interface TileSet {
  /** The tiles' middles along the line, sorted */
  at: number[];
  /** Each tile's square, and what stands on it reaching a little over its edge */
  boxes: THREE.Box3[];
  runs: Run[];
  shown: [number, number];
  /** The tiles whose small details are shown */
  detail: [number, number];
  /** Metres: the small details' reach in this set */
  detailReach: number;
  /** Metres: how far this set's tiles are drawn at most (the draw distance if that is nearer) */
  reach: number;
}

export class Tiles {
  /** The sets' meshes (casters for the ground's shading, targets for shots). */
  readonly group = new THREE.Group();
  /** Metres: beyond this a tile is hidden. */
  drawDistance = 725;
  private sets: TileSet[] = [];
  private tracked: { object: THREE.Object3D; box: THREE.Box3; reach: number }[] = [];
  private wait = 0;
  private last = new THREE.Vector3(Infinity, Infinity, Infinity);

  /**
   * A set of tiles (the ring, or the village): each material's pieces merged in tile order into
   * one mesh, each repeated shape into one instanced mesh. `near`: its meshes throw the sun's
   * shadow round the house. `detailReach`: how far its small details are drawn (DETAIL unless given); `reach`: how far its
   * tiles are drawn at most (the draw distance unless given).
   */
  addSet(tiles: { key: string; pieces: Piece[] }[], near: boolean, detailReach = DETAIL, reach = Infinity): void {
    const order = tiles
      .map((t) => {
        const [i, j] = t.key.split(',').map(Number);
        return { ...t, at: axial(CX + i * TILE, CZ + j * TILE) };
      })
      .sort((a, b) => a.at - b.at);
    const n = order.length;
    const merged = new Map<string, { piece: Piece; per: THREE.BufferGeometry[][] }>();
    const shapes = new Map<string, { piece: Piece; per: THREE.Matrix4[][] }>();
    order.forEach((tile, i) => {
      for (const p of tile.pieces) {
        const key = `${p.material.uuid}|${p.shadow}|${p.small ?? false}|${p.at ? p.geometry.uuid : ''}`;
        const into = p.at ? shapes : merged;
        let e = into.get(key);
        if (!e) into.set(key, (e = { piece: p, per: Array.from({ length: n }, () => []) }));
        if (p.at) (e.per[i] as THREE.Matrix4[]).push(...p.at);
        else (e.per[i] as THREE.BufferGeometry[]).push(p.geometry);
      }
    });
    const boxes = order.map((t) => {
      const [i, j] = t.key.split(',').map(Number);
      return new THREE.Box3(new THREE.Vector3(CX + (i - 0.5) * TILE - 30, -30, CZ + (j - 0.5) * TILE - 30), new THREE.Vector3(CX + (i + 0.5) * TILE + 30, 80, CZ + (j + 0.5) * TILE + 30));
    });
    const set: TileSet = { at: order.map((t) => t.at), boxes, runs: [], shown: [0, n - 1], detail: [0, n - 1], detailReach, reach };
    const style = (mesh: THREE.Mesh, p: Piece) => {
      mesh.castShadow = p.shadow && near;
      mesh.receiveShadow = true;
      mesh.renderOrder = p.order ?? 0;
      mesh.userData.material = p.tag;
      mesh.userData.set = this.sets.length; // 0: the ring, 1: the village
      mesh.name = p.tag;
      this.group.add(mesh);
    };
    for (const { piece, per } of merged.values()) {
      const list = per.flat();
      const geometry = list.length > 1 ? mergeGeometries(list) : list[0];
      if (list.length > 1) list.forEach((g) => g.dispose());
      const size = (g: THREE.BufferGeometry) => g.index?.count ?? g.attributes.position.count;
      const offsets = [0];
      for (const geos of per) offsets.push(offsets[offsets.length - 1] + geos.reduce((s, g) => s + size(g), 0));
      const mesh = new THREE.Mesh(geometry, piece.material);
      style(mesh, piece);
      const run: Run = { mesh, offsets, small: piece.small };
      set.runs.push(run);
      if (mesh.castShadow) {
        // In the shadow pass only the tiles round the house (and of those, the shown ones).
        let s0 = 0;
        while (s0 < n && set.at[s0] < -SHADOW - HALF) s0++;
        let s1 = n - 1;
        while (s1 >= 0 && set.at[s1] > SHADOW + HALF) s1--;
        mesh.onBeforeShadow = () => {
          const shown = run.small ? set.detail : set.shown;
          const a = Math.max(s0, shown[0]);
          const b = Math.min(s1, shown[1]);
          geometry.setDrawRange(offsets[a], b >= a ? offsets[b + 1] - offsets[a] : 0);
        };
        mesh.onAfterShadow = () => this.range(set, run);
      }
    }
    for (const { piece, per } of shapes.values()) {
      const all = per.flat();
      const mesh = new THREE.InstancedMesh(piece.geometry, piece.material, Math.max(1, all.length));
      const source = new Float32Array(all.length * 16);
      all.forEach((m, k) => m.toArray(source, k * 16));
      const offsets = [0];
      for (const ms of per) offsets.push(offsets[offsets.length - 1] + ms.length);
      style(mesh, piece);
      set.runs.push({ mesh, offsets, source, small: piece.small });
    }
    this.sets.push(set);
    for (const run of set.runs) this.range(set, run);
    this.wait = 0;
  }

  /** Show a run's part for the set's shown tiles. */
  private range(set: TileSet, run: Run): void {
    const [a, b] = run.small ? set.detail : set.shown;
    const start = b >= a ? run.offsets[a] : 0;
    const count = b >= a ? run.offsets[b + 1] - start : 0;
    const mesh = run.mesh;
    mesh.visible = count > 0;
    if (!run.source) {
      mesh.geometry.setDrawRange(start, count);
      return;
    }
    const im = mesh as THREE.InstancedMesh;
    im.instanceMatrix.array.set(run.source.subarray(start * 16, (start + count) * 16));
    im.instanceMatrix.clearUpdateRanges();
    im.instanceMatrix.addUpdateRange(0, count * 16);
    im.instanceMatrix.needsUpdate = true;
    im.count = count;
    if (count) im.computeBoundingSphere();
  }

  /** Something else that is hidden beyond the draw distance (the house, the bungalow), where it stands; or beyond each, if nearer. */
  track(object: THREE.Object3D, box = new THREE.Box3().setFromObject(object), reach = Infinity): void {
    this.tracked.push({ object, box, reach });
    this.wait = 0;
  }

  /** Show what is within the draw distance of the eye: a few times a second, or at once after a jump. */
  update(dt: number, eye: THREE.Vector3): void {
    this.wait -= dt;
    if (this.wait > 0 && eye.distanceToSquared(this.last) < 30 * 30) return;
    this.wait = 0.25;
    this.last.copy(eye);
    for (const t of this.tracked) t.object.visible = t.box.distanceToPoint(eye) <= Math.min(t.reach, this.drawDistance);
    const within = (set: TileSet, reach: number): [number, number] => {
      let a = 0;
      while (a < set.boxes.length && set.boxes[a].distanceToPoint(eye) > reach) a++;
      let b = set.boxes.length - 1;
      while (b >= a && set.boxes[b].distanceToPoint(eye) > reach) b--;
      return [a, b];
    };
    for (const set of this.sets) {
      const shown = within(set, Math.min(set.reach, this.drawDistance));
      const detail = within(set, Math.min(set.detailReach, set.reach, this.drawDistance));
      const same = (p: [number, number], q: [number, number]) => p[0] === q[0] && p[1] === q[1];
      if (same(shown, set.shown) && same(detail, set.detail)) continue;
      set.shown = shown;
      set.detail = detail;
      for (const run of set.runs) this.range(set, run);
    }
  }

  /** Every tile shown (for working out the ground's shading); update() hides the far ones again. */
  showAll(): void {
    for (const set of this.sets) {
      set.shown = [0, set.at.length - 1];
      set.detail = [0, set.at.length - 1];
      for (const run of set.runs) this.range(set, run);
    }
    this.wait = 0;
    this.last.set(Infinity, Infinity, Infinity);
  }

  /** How many tiles are shown now, of how many, and in how many meshes (draw calls at most). */
  get counts(): { shown: number; all: number; meshes: number } {
    let shown = 0;
    let all = 0;
    for (const s of this.sets) {
      shown += Math.max(0, s.shown[1] - s.shown[0] + 1);
      all += s.at.length;
    }
    return { shown, all, meshes: this.group.children.length };
  }
}
