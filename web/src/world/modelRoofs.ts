import * as THREE from 'three';
import type { Prism, RoofSpec } from './houseData';
import type { World } from './collision';
import { facesUp, inBoxes, RoofField } from './roofField';
import { terrain } from './terrain';
import { distanceToHome, END_GARDEN, HOMES } from '../../shared/homes.mjs';

/**
 * Our models' roofs as floors and solids (world/roofField.ts), from their meshes as drawn, once a model is in place: the
 * triangles that face up and lie more than ABOVE metres over the ground there (roofs, dormers, chimney tops, a shelter's
 * roof; not terraces, steps, benches or fences: those stay as they are), a roof's own mesh from lower down. Instanced
 * things (trees, lamps, posts), leaves, nets, details and what `leaveOut` names are left out.
 *
 * Model by model, the nearest to the player first (`near`): its triangles go into the world's roofs as drawn, as slabs,
 * not cut to the walls; what is solid under a point is asked when a body asks (World.roofHere: down to the building under
 * that point; an eave over open ground, a shelter, a canopy, a porch stays a slab, landed on from above and walked under).
 * Then each open-data block it stands for (kept for walking into) is capped at the lowest of its roof over it
 * (World.roofOver, World.capBlock: one height per block, so it never changes under a body, and no floor stands on air over
 * the roof).
 */
const ABOVE = 1.5;
/** Meshes of roofs (tiles, slates, a roof's own mesh): a triangle counts once any of it is this far over the ground. */
const ROOFS = /roof|tiles|slate/i;
const ROOF_ABOVE = 1.0;
/** Meshes that are never a roof, by their name or their material's: see-through nets (a goal's), cables, greenery. */
const NOT_ROOFS = /net|cable|wire|foliage|leaf|leaves|hedge/i;
/** Milliseconds of work between two pauses: a frame goes by in between (`nextFrame`), so drawing never waits on it. */
const SLICE = 2;
/** Corners or triangles looked at between two looks at the clock. */
const CHUNK = 64;

/** The next frame drawn and done with: a pause between two slices of work. */
export const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

const a = new THREE.Vector3();

/** The meshes of `root` whose roofs count: drawn, not instanced, not leaves or nets, a LOD's near level only. */
function roofMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
    if (mesh.userData.ignoreRay || mesh.userData.vehicle || mesh.userData.detail || !mesh.geometry.attributes.position) return;
    for (let p: THREE.Object3D = mesh; p.parent; p = p.parent) {
      const lod = p.parent as THREE.LOD;
      if (lod.isLOD && lod.levels[0]?.object !== p) return;
    }
    const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.Material[];
    if (NOT_ROOFS.test(mesh.name)) return;
    if (!mats.every((m) => m.visible === false || m.alphaTest > 0 || NOT_ROOFS.test(m.name))) out.push(mesh);
  });
  return out;
}

/**
 * Adds the roofs of `roots` (models in place, each its own model) to the world's, at most SLICE ms at a time with a
 * `pause` between, the model nearest `near()` first. `ground` is the flat ground's height (terrain heights are over it).
 * Resolves to the triangles kept.
 */
export async function addModelRoofs(world: World, roots: THREE.Object3D[], ground: number, leaveOut: (x: number, z: number) => boolean = () => false,
  pause: () => Promise<unknown> = nextFrame, near: () => { x: number; z: number } | null = () => null, keepBlocks = leaveOut): Promise<number> {
  let kept = 0;
  const stats = world.roofs.fill;
  // Work goes on only while the clock is under SLICE: no `await` on the way (an await lets other waiting work run inside
  // this frame's slice), only when it is time for a pause.
  let since = performance.now();
  const due = () => performance.now() - since >= SLICE;
  const rest = async () => {
    const work = performance.now() - since;
    stats.slices++;
    stats.workMs += work;
    stats.longestMs = Math.max(stats.longestMs, work);
    await pause();
    since = performance.now();
  };
  // Where each model stands (its own place: no pass over its meshes, which for a big one is a long frame).
  const spots = roots.map((root) => {
    root.updateWorldMatrix(true, false);
    return new THREE.Vector3().setFromMatrixPosition(root.matrixWorld);
  });
  const left = roots.map((_, i) => i);
  const far = (i: number, at: { x: number; z: number }) => Math.hypot(spots[i].x - at.x, spots[i].z - at.z);
  // Kept from model to model (no fresh arrays and fields each time: less for the garbage collector to do mid-play).
  const tris: number[] = [];
  const chunk = new Float32Array(CHUNK * 9);
  const own = new RoofField();
  const feed = async (field: RoofField) => {
    let added = 0;
    for (let i = 0; i < tris.length; i += CHUNK * 9) {
      const n = Math.min(CHUNK * 9, tris.length - i);
      for (let k = 0; k < n; k++) chunk[k] = tris[i + k];
      added += field.add(chunk.subarray(0, n), Infinity);
      if (due()) await rest();
    }
    return added;
  };
  while (left.length) {
    // The nearest model to the player now (a landing, a respawn or a travel onto one gets its roof first).
    const at = near();
    if (at) left.sort((i, j) => far(i, at) - far(j, at));
    const r = left.shift()!;
    // Its roof's triangles as drawn: corners where they stand, those that face up over the ground; and their box.
    tris.length = 0;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const mesh of roofMeshes(roots[r])) {
      const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
      const w = new Float32Array(pos.count * 3);
      const e = mesh.matrixWorld.elements;
      const src = pos.array;
      const plain = !pos.normalized && !(pos as unknown as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && pos.itemSize === 3;
      for (let i = 0; i < pos.count; i++) {
        if (plain) {
          // The matrix by hand, on the array itself (the slow way below for packed or quantised corners).
          const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2];
          w[i * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
          w[i * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
          w[i * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
        } else a.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).toArray(w, i * 3);
        if (i % CHUNK === 0 && due()) await rest();
      }
      const index = mesh.geometry.index?.array;
      const corners = index ? index.length : pos.count;
      // Drawn from one side: only what faces up from above (not a soffit, a ceiling); a mirrored mesh turns its faces.
      const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.Material[];
      const both = mats.some((m) => m.side === THREE.DoubleSide);
      // A mesh of roofs (by its name or its material's) counts as soon as any of a triangle reaches ROOF_ABOVE: a shed's or
      // an annex's roof where the ground the collision has lies higher than the model's own (World cuts what lies lower).
      const roofy = [mesh.name, mesh.userData.material, ...mats.map((m) => m.name)].some((n) => typeof n === 'string' && ROOFS.test(n));
      const turned = mesh.matrixWorld.determinant() < 0;
      for (let k = 0; k + 2 < corners; k += 3) {
        if (k % (CHUNK * 3) === 0 && due()) await rest();
        const i = index ? index[k] : k;
        const j = index ? index[turned ? k + 2 : k + 1] : turned ? k + 2 : k + 1;
        const l = index ? index[turned ? k + 1 : k + 2] : turned ? k + 1 : k + 2;
        if (!facesUp(w[i * 3], w[i * 3 + 1], w[i * 3 + 2], w[j * 3], w[j * 3 + 1], w[j * 3 + 2], w[l * 3], w[l * 3 + 1], w[l * 3 + 2], both)) continue;
        const low = Math.min(w[i * 3 + 1], w[j * 3 + 1], w[l * 3 + 1]);
        const high = Math.max(w[i * 3 + 1], w[j * 3 + 1], w[l * 3 + 1]);
        const mx = (w[i * 3] + w[j * 3] + w[l * 3]) / 3;
        const mz = (w[i * 3 + 2] + w[j * 3 + 2] + w[l * 3 + 2]) / 3;
        const floor = ground + terrain.height(mx, mz);
        if ((roofy ? high < floor + ROOF_ABOVE : low < floor + ABOVE) || leaveOut(mx, mz)) continue;
        tris.push(w[i * 3], w[i * 3 + 1], w[i * 3 + 2], w[j * 3], w[j * 3 + 1], w[j * 3 + 2], w[l * 3], w[l * 3 + 1], w[l * 3 + 2]);
        x0 = Math.min(x0, w[i * 3], w[j * 3], w[l * 3]);
        x1 = Math.max(x1, w[i * 3], w[j * 3], w[l * 3]);
        z0 = Math.min(z0, w[i * 3 + 2], w[j * 3 + 2], w[l * 3 + 2]);
        z1 = Math.max(z1, w[i * 3 + 2], w[j * 3 + 2], w[l * 3 + 2]);
      }
    }
    if (!tris.length) continue;
    // Into the world's roofs as drawn, as slabs: what is solid under a point is asked when it is asked (World.roofHere:
    // the building under that point), so nothing is cut to the walls here.
    kept += await feed(world.roofs);
    // The blocks it stands for, capped at the lowest of its own roof over them (World.roofOver: looked at every metre
    // inside each and at its corners).
    own.clear();
    await feed(own);
    // The blocks under its roof's box.
    if (due()) await rest();
    const blocks = world.modelledIn(x0, z0, x1, z1);
    if (due()) await rest();
    for (const k of blocks) {
      if (world.blockPoints(k).some((p) => keepBlocks(...p))) continue; // a left-out building's (a private home's)
      // A metre-wide column at a time; capped once all are looked at, so it never moves twice.
      let low = Infinity;
      for (let c = 0, n = Math.max(1, world.columns(k)); c < n; c++) {
        low = Math.min(low, world.roofOver(own, k, c, 1));
        if (due()) await rest();
      }
      world.capBlock(k, low);
    }
  }
  return kept;
}

/** The models that keep their own hand-made blocks and floors (their roof walks, stairs and platforms are game places). */
const OWN = ['church', 'sparrenhof', 'tree_huts'];

/**
 * The village's models' roofs (`models`: as loaded, each with its `landmark`), the nearest to `near()` first, but the
 * church's, the Sparrenhof's, the tree huts' and the end house's at Molenhoek (a private home: its own blocks, floors and
 * roof, `endHouse`, with its eaves 0.8 m round it), and none in `leave` (boxes: the school's play tower, whose ladder,
 * platform, little roof and slide are its own: world/playground.ts).
 */
export function villageRoofs(world: World, models: THREE.Object3D[], ground: number, endHouse: { contains(x: number, z: number): boolean; encloses(x: number, z: number): boolean } | null,
  leave: readonly (readonly number[])[], near: () => { x: number; z: number } | null, pause: () => Promise<unknown> = nextFrame): Promise<number> {
  const roofed = models.filter((m) => !OWN.includes(String(m.userData.landmark)));
  const AROUND = [[0, 0], [0.8, 0], [-0.8, 0], [0, 0.8], [0, -0.8]];
  // Every home in the shared data too (a new one is left out with no change here), and the end house's fenced garden
  // (reached only through it): no roof added there, and their blocks keep their heights.
  const out = (x: number, z: number) => inBoxes(leave, x, z) || inHomes(x, z) || (!!endHouse && (endHouse.encloses(x, z) || AROUND.some(([a, b]) => endHouse.contains(x + a, z + b))));
  return addModelRoofs(world, roofed, ground, out, pause, near, out);
}

/** Metres round a home's rings (shared/homes.mjs) where no model's roof is added and no block is capped: its eaves. */
const HOME_MARGIN = 1.5;

function inRing(x: number, z: number, ring: readonly (readonly number[])[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * Whether (x, z) is in or within HOME_MARGIN of a private home (any band of any home in shared/homes.mjs) or of the end
 * house's garden: places a model's roof leaves as they are (world/homeLocks.ts keeps whoever has no code out of them).
 */
export function inHomes(x: number, z: number): boolean {
  const m = HOME_MARGIN;
  for (const h of HOMES) {
    const b = h.box;
    if (x < b[0] - m || x > b[2] + m || z < b[1] - m || z > b[3] + m) continue;
    if (distanceToHome(h.id, x, z) <= m) return true;
  }
  const g = END_GARDEN.ring;
  return inRing(x, z, g) || g.some((p, i) => {
    const q = g[(i + 1) % g.length];
    const dx = q[0] - p[0], dz = q[1] - p[1];
    const t = Math.max(0, Math.min(1, ((x - p[0]) * dx + (z - p[1]) * dz) / (dx * dx + dz * dz || 1e-9)));
    return Math.hypot(x - p[0] - dx * t, z - p[1] - dz * t) <= m;
  });
}

/**
 * The two private homes round the house (world/homeLocks.ts): the main house (its floors, stairs and roofs in the house
 * data) and the bungalow (its veranda, and its roof: the ring's roof over a room), each with a margin. Our models'
 * trim there (the bungalow's roof trim) adds no roof: their own blocks and floors stay as they are. Every home in the
 * shared data as well (inHomes).
 */
export function privateHomes(prisms: Prism[], roofs: RoofSpec[]): (x: number, z: number) => boolean {
  const boxes: [number, number, number, number][] = [];
  const box = (pts: [number, number][], margin: number) => {
    if (!pts.length) return;
    const xs = pts.map((q) => q[0]);
    const zs = pts.map((q) => q[1]);
    boxes.push([Math.min(...xs) - margin, Math.min(...zs) - margin, Math.max(...xs) + margin, Math.max(...zs) + margin]);
  };
  const named = (re: RegExp) => prisms.filter((p) => re.test(p.n ?? '')).flatMap((p) => p.p[0]);
  box(named(/^(?!.*\(old house\)).*(floor|stairs|roof|terras)/i), 1);
  box([...named(/^veranda \(old house\)$/i), ...roofs.filter((r) => r.ceiling).flatMap((r) => r.p)], 0.6);
  return (x, z) => inHomes(x, z) || boxes.some(([x0, z0, x1, z1]) => x >= x0 && x <= x1 && z >= z0 && z <= z1);
}
