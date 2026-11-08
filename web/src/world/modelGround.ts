import * as THREE from 'three';
import { area2, groundLayers, plane, RANK, runNow, runSoon, weightsIn, type Pt } from './groundLayers';
import type { GroundCutter } from './groundCutter';
import { clipDiagonal, clipToBox } from './houseMeshes';
import { terrain } from './terrain';

/**
 * Our models' own ground (the café's gravel and setts, the church square, the school's yard, Molenhoek's and
 * Kapellenhoek's streets and drives, the house's terrace): claimed before and over everything else
 * (world/groundLayers.ts), so the village's covers and the streets in detail give way under it. A model's ground is
 * what faces up within LOW to HIGH metres of the grass, as the ground's surface is there: its forecourts, yards, kerbs
 * and doorsteps, not a bench or a raised floor; and only where it lies over the grass (under it the grass shows, not
 * the model's ground, and the cover over the grass there stays).
 *
 * Where two of the models' own surfaces facing up lie within GAP (world/groundLayers.ts) of one another, up to OWN over
 * the grass (a band of setts on the gravel, lines on the yard, a pavement drawn over the street, a floor on its plinth,
 * a sill laid twice), each spot keeps the higher one, as the depth buffer would show them if it could tell them apart:
 * the lower is cut away there in the model's geometry itself. The cut pieces keep every attribute of the triangle they
 * come from (its light layout too, so the baked light still fits).
 */

/** m: a surface facing up this far under the grass, or over it, is a model's ground */
const LOW = -0.25;
const HIGH = 0.2;
/** m: up to here over the grass a model's surfaces facing up are cut under its own (a step, a sill, a raised floor) */
const OWN = 1.5;
/** Leaves, hedges and plants: not hard ground, and their layers are meant to show between one another */
const SOFT = /leaf|leaves|hedge|foliage|grass|ivy|plant|conifer/i;

interface Face {
  mesh: THREE.Mesh;
  /** The triangle's number in its geometry */
  f: number;
  /** Its corners on the plan */
  t: Pt[];
  /** Its height (the middle's) */
  y: number;
  /** Its corners' heights */
  ys: number[];
  /** Over the ground's band: beats only the model's own surfaces */
  raised: boolean;
  group: number;
}

/** m: a model's ground lying less than this over the grass is under it (the grass shows there, not the model's) */
const SHOWS = 0.005;

/**
 * The parts of a triangle on the plan where its plane `p` (y = a x + b z + c) lies over the grass: cut along the
 * ground's grid and diagonals (world/terrain.ts), on each piece of which the ground is flat, so the line where the
 * two meet is straight there.
 */
function overGrass(t: Pt[], p: number[], ground: number): Pt[][] {
  const xs = t.map((v) => v[0]);
  const zs = t.map((v) => v[1]);
  const step = terrain.step;
  const gx0 = terrain.x0 + Math.floor((Math.min(...xs) - terrain.x0) / step) * step;
  const gz0 = terrain.z0 + Math.floor((Math.min(...zs) - terrain.z0) / step) * step;
  const over = (x: number, z: number) => p[0] * x + p[1] * z + p[2] - ground - terrain.height(x, z) - SHOWS;
  if (t.every(([x, z]) => over(x, z) > 0.05)) return [t]; // well over the grass everywhere (the ground under it bends little)
  const out: Pt[][] = [];
  for (let gx = gx0; gx < Math.max(...xs); gx += step) {
    for (let gz = gz0; gz < Math.max(...zs); gz += step) {
      const box = clipToBox(t, gx, gz, gx + step, gz + step);
      if (box.length < 3) continue;
      for (const side of [1, -1]) {
        const half = clipDiagonal(box, gx, gz, side);
        if (half.length < 3) continue;
        // Keep where over > 0 (Sutherland-Hodgman with the heights over the grass, linear on this piece).
        const d = half.map(([x, z]) => over(x, z));
        const kept: Pt[] = [];
        for (let i = 0; i < half.length; i++) {
          const j = (i + half.length - 1) % half.length;
          if (d[j] > 0 !== d[i] > 0) {
            const f = d[j] / (d[j] - d[i]);
            kept.push([half[j][0] + (half[i][0] - half[j][0]) * f, half[j][1] + (half[i][1] - half[j][1]) * f]);
          }
          if (d[i] > 0) kept.push(half[i]);
        }
        if (kept.length >= 3 && Math.abs(area2(kept)) > 1e-8) out.push(kept);
      }
    }
  }
  return out;
}

/** Every attribute of a geometry, read as numbers. */
function read(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, i: number, k: number): number {
  return k === 0 ? a.getX(i) : k === 1 ? a.getY(i) : k === 2 ? a.getZ(i) : a.getW(i);
}

/**
 * Claim the ground of the models (placed in the scene, before the village's covers and streets are built) and cut each
 * model's own lower surfaces under its higher ones. `ground`: the grass's height over the relief. Returns how many of
 * their triangles were cut.
 */
export function claimModelGround(models: THREE.Object3D[], ground: number): number {
  const found = runNow(claiming(models, ground));
  return runNow(cutting(found, (face) => groundLayers.cut(face.t, RANK.model, face.group, face.ys)));
}

/**
 * The same between frames (runSoon), for the village's models while play goes on: once their ground is claimed, the
 * cuts of their own surfaces are worked out by `cutter` (world/groundCutter.ts) while the page goes on, and put in
 * later. Resolves once claimed, with what resolves once they are cut.
 */
export async function claimModelGroundSoon(models: THREE.Object3D[], ground: number, between: () => Promise<unknown>, cutter: GroundCutter): Promise<Promise<number>> {
  const found = await runSoon(claiming(models, ground), between);
  const cuts = cutter.cut(found.faces.map((face) => ({ t: face.t, rank: RANK.model, group: face.group, ys: face.ys })));
  return cuts.then((c) => {
    const job = cutting(found, (face) => c.next(face.t));
    return runSoon(job, between).finally(() => c.done());
  });
}

/** The models' surfaces facing up near the grass, claimed, and how many meshes share each geometry. */
interface Found {
  faces: Face[];
  users: Map<THREE.BufferGeometry, number>;
}

function* claiming(models: THREE.Object3D[], ground: number): Generator<void, Found> {
  const faces: Face[] = [];
  const users = new Map<THREE.BufferGeometry, number>();
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const meshes: THREE.Mesh[] = [];
  for (const model of models) {
    model.updateMatrixWorld(true);
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
      const mat = mesh.material as THREE.Material;
      const g = mesh.geometry;
      users.set(g, (users.get(g) ?? 0) + 1);
      // Glass, cut-out leaves and grates don't hide what lies under them; leaves and hedges aren't hard ground.
      if (Array.isArray(mesh.material) || mat.transparent || mat.alphaTest > 0 || g.groups.length > 1 || !g.attributes.position) return;
      if (SOFT.test(mesh.name) || SOFT.test(mat.name)) return;
      meshes.push(mesh);
    });
  }
  for (const mesh of meshes) {
    const pos = mesh.geometry.attributes.position;
    const index = mesh.geometry.index;
    const count = index ? index.count : pos.count;
    // Each corner placed in the world once (the triangles share them), as doubles: the very numbers as placed per triangle.
    const at = new Float64Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      v[0].fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      at[3 * i] = v[0].x;
      at[3 * i + 1] = v[0].y;
      at[3 * i + 2] = v[0].z;
    }
    for (let f = 0; f * 3 + 2 < count; f++) {
      for (let k = 0; k < 3; k++) {
        const i = index ? index.getX(f * 3 + k) : f * 3 + k;
        v[k].set(at[3 * i], at[3 * i + 1], at[3 * i + 2]);
      }
      // Facing up: its normal within about 37 degrees of straight up.
      const ux = v[1].x - v[0].x, uy = v[1].y - v[0].y, uz = v[1].z - v[0].z;
      const wx = v[2].x - v[0].x, wy = v[2].y - v[0].y, wz = v[2].z - v[0].z;
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      if (ny < 1e-8 || ny < 0.8 * Math.hypot(nx, ny, nz)) continue;
      let low = true;
      let raised = false;
      for (let k = 0; k < 3 && low; k++) {
        const rel = v[k].y - ground - terrain.height(v[k].x, v[k].z);
        if (rel < LOW || rel > OWN) low = false;
        if (rel > HIGH) raised = true;
      }
      if (!low) continue;
      const t: Pt[] = [[v[0].x, v[0].z], [v[1].x, v[1].z], [v[2].x, v[2].z]];
      faces.push({ mesh, f, t, y: (v[0].y + v[1].y + v[2].y) / 3, ys: [v[0].y, v[1].y, v[2].y], raised, group: 0 });
    }
    yield;
  }
  // The higher first: of one rank the first claimed wins (a band of setts on the gravel, lines on the yard).
  faces.sort((a, b) => b.y - a.y);
  for (const face of faces) {
    face.group = groundLayers.group();
    // Over the model's own surfaces (and the other models') everywhere,
    groundLayers.claim(face.t, RANK.model, face.group, face.ys, true);
    if (face.raised) continue;
    // over the covers and streets only where it lies over the grass: under it the model's ground doesn't show, and what
    // lay over it there stays.
    const p = plane(face.t, face.ys);
    for (const piece of overGrass(face.t, p, ground)) {
      for (let k = 1; k + 1 < piece.length; k++) {
        const t = [piece[0], piece[k], piece[k + 1]];
        groundLayers.claim(t, RANK.model, face.group, t.map(([x, z]) => p[0] * x + p[1] * z + p[2]));
      }
    }
  }
  return { faces, users };
}

/** Each model's own lower surfaces, cut under its higher ones (`cut`: a face's pieces), in their geometry. */
function* cutting({ faces, users }: Found, cutOf: (face: Face) => Pt[][]): Generator<void, number> {
  const cuts = new Map<THREE.Mesh, Map<number, { t: Pt[]; pieces: Pt[][] }>>();
  let cut = 0;
  for (let n = 0; n < faces.length; n++) {
    const face = faces[n];
    if (n % 500 === 499) yield;
    const pieces = cutOf(face);
    if (pieces.length === 1 && pieces[0] === face.t) continue;
    let m = cuts.get(face.mesh);
    if (!m) cuts.set(face.mesh, (m = new Map()));
    m.set(face.f, { t: face.t, pieces });
    cut++;
  }
  for (const [mesh, faceCuts] of cuts) {
    // A geometry that other meshes share gets a copy of its own first.
    if ((users.get(mesh.geometry) ?? 1) > 1) mesh.geometry = mesh.geometry.clone();
    mesh.geometry = recut(mesh.geometry, faceCuts);
    yield;
  }
  return cut;
}

/** The geometry with the triangles in `faceCuts` replaced by their pieces, every attribute carried over by weights. */
function recut(g: THREE.BufferGeometry, faceCuts: Map<number, { t: Pt[]; pieces: Pt[][] }>): THREE.BufferGeometry {
  const index = g.index?.array;
  const pos = g.attributes.position;
  const count = index ? g.index!.count : pos.count;
  const old = pos.count;
  // The new corners: each a mix of three old ones (their numbers, then their weights).
  const from: number[] = [];
  const weights: number[] = [];
  const added: number[] = [];
  for (const [f, c] of faceCuts) {
    const i0 = index ? index[f * 3] : f * 3;
    const i1 = index ? index[f * 3 + 1] : f * 3 + 1;
    const i2 = index ? index[f * 3 + 2] : f * 3 + 2;
    for (const piece of c.pieces) {
      // The pieces are turned as the triangle is on the plan, so their triangles face up as it does.
      if (Math.abs(area2(piece)) < 1e-8) continue;
      const first = old + from.length / 3;
      for (const [x, z] of piece) {
        from.push(i0, i1, i2);
        weights.push(...weightsIn(c.t, x, z));
      }
      for (let k = 1; k + 1 < piece.length; k++) added.push(first, first + k, first + k + 1);
    }
  }
  const tris = new Uint32Array(count - faceCuts.size * 3 + added.length);
  let n = 0;
  for (let f = 0; f * 3 + 2 < count; f++) {
    if (faceCuts.has(f)) continue;
    for (let k = 0; k < 3; k++) tris[n++] = index ? index[f * 3 + k] : f * 3 + k;
  }
  tris.set(added, n);
  const fresh = from.length / 3;
  const out = new THREE.BufferGeometry();
  // As plain floats: three reads a normalised attribute (glTF's light layouts and colours) as the fractions it stands for.
  for (const [name, a] of Object.entries(g.attributes)) {
    const size = a.itemSize;
    const array = new Float32Array((old + fresh) * size);
    const plain = a as THREE.BufferAttribute;
    if ((a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) {
      for (let i = 0; i < old; i++) for (let k = 0; k < size; k++) array[i * size + k] = read(a, i, k);
    } else if (!a.normalized) {
      array.set(plain.array.subarray(0, old * size));
    } else {
      const src = plain.array;
      const top = src instanceof Uint8Array ? 255 : src instanceof Uint16Array ? 65535 : src instanceof Int8Array ? 127 : src instanceof Int16Array ? 32767 : 1;
      const signed = src instanceof Int8Array || src instanceof Int16Array;
      for (let i = 0; i < old * size; i++) array[i] = signed ? Math.max(src[i] / top, -1) : src[i] / top;
    }
    for (let v = 0; v < fresh; v++) {
      const o = (old + v) * size;
      let len = 0;
      for (let k = 0; k < size; k++) {
        const x = array[from[3 * v] * size + k] * weights[3 * v] + array[from[3 * v + 1] * size + k] * weights[3 * v + 1] + array[from[3 * v + 2] * size + k] * weights[3 * v + 2];
        array[o + k] = x;
        len += x * x;
      }
      if (name === 'normal' && len > 0) for (let k = 0; k < size; k++) array[o + k] /= Math.sqrt(len);
    }
    out.setAttribute(name, new THREE.BufferAttribute(array, size));
  }
  out.setIndex(new THREE.BufferAttribute(tris, 1));
  out.userData = { ...g.userData };
  out.computeBoundingBox();
  out.computeBoundingSphere();
  g.dispose();
  return out;
}
