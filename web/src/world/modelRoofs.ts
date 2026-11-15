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
 * Model by model, the nearest to the player first (`near`), in two passes. First the corners of its roof that stand over
 * a block it stands for (the open-data block kept for walking into) cap that block at the lowest of them (World.capBlock:
 * one height per block, so it never changes under a body, and no floor stands on air over the roof). Then each triangle
 * whose three corners stand over a building is solid down to that building's top: a closed building, walled to its roof.
 * Any other (an eave over open ground, a shelter, a canopy, a porch, a stand) is an open slab: landed on from above,
 * walked under from the side.
 */
const ABOVE = 1.5;
/** Meshes of roofs (tiles, slates, a roof's own mesh): a triangle counts once any of it is this far over the ground. */
const ROOFS = /roof|tiles|slate/i;
const ROOF_ABOVE = 1.0;
/** Meshes that are never a roof, by their name or their material's: see-through nets (a goal's), cables, greenery. */
const NOT_ROOFS = /net|cable|wire|foliage|leaf|leaves|hedge/i;
/** Metres over the ground a block must reach to be the building under a roof (not paving, a low wall or a fence). */
const BUILDING = 2.0;

/** Milliseconds of work between two pauses: a frame goes by in between (`nextFrame`), so drawing never waits on it. */
const SLICE = 4;
/** Corners or triangles looked at between two looks at the clock. */
const CHUNK = 256;

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

/** Metres: a triangle with some corners over a building and some not is halved until its sides are this short. */
const SPLIT = 1.5;
/** How many times a triangle is halved at most (a 20 m roof face down to pieces of about 1.3 m). */
const DEPTH = 8;

/** A model's roof triangles once found: their corners (x, y, z three times each) and the building under each corner. */
interface Found {
  c: number[];
  b: number[];
  /** The building at a spot (World.buildingAt), asked once per small square */
  ask: (x: number, z: number) => number;
}

/**
 * Adds the roofs of `roots` (models in place, each its own model) to the world's, at most SLICE ms at a time with a
 * `pause` between, the model nearest `near()` first. `ground` is the flat ground's height (terrain heights are over it).
 * Resolves to the triangles kept.
 */
export async function addModelRoofs(world: World, roots: THREE.Object3D[], ground: number, leaveOut: (x: number, z: number) => boolean = () => false,
  pause: () => Promise<unknown> = nextFrame, near: () => { x: number; z: number } | null = () => null, keepBlocks = leaveOut): Promise<number> {
  let kept = 0;
  let since = performance.now();
  const tick = async () => {
    if (performance.now() - since < SLICE) return;
    await pause();
    since = performance.now();
  };
  // Each model's box, a mesh at a time (a mesh's own box is a pass over its corners).
  const boxes: THREE.Box3[] = [];
  const part = new THREE.Box3();
  for (const root of roots) {
    const box = new THREE.Box3();
    root.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => (o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry?.attributes.position && meshes.push(o as THREE.Mesh));
    for (const mesh of meshes) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      box.union(part.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld));
      await tick();
    }
    boxes.push(box);
  }
  const left = roots.map((_, i) => i);
  const far = (i: number, at: { x: number; z: number }) => boxes[i].distanceToPoint(a.set(at.x, (boxes[i].min.y + boxes[i].max.y) / 2, at.z));
  while (left.length) {
    // The nearest model to the player now (a landing, a respawn or a travel onto one gets its roof first).
    const at = near();
    if (at) left.sort((i, j) => far(i, at) - far(j, at));
    const r = left.shift()!;
    const root = roots[r];
    // The building at a spot, asked once per 25 cm square (the models' meshes share their corners' spots).
    const asked = new Map<number, number>();
    const ask = (x: number, z: number) => {
      const key = (Math.round(x * 4) + 40000) * 80000 + Math.round(z * 4) + 40000;
      let b = asked.get(key);
      if (b === undefined) asked.set(key, (b = world.buildingAt(x, z, BUILDING)));
      return b;
    };
    const found: Found = { c: [], b: [], ask };
    const lowest = new Map<number, number>(); // the lowest roof corner over each block the model stands for
    // First pass: each mesh's corners where they stand, its roof triangles, the buildings under their corners.
    for (const mesh of roofMeshes(root)) {
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
        if (i % CHUNK === 0) await tick();
      }
      const building = new Int32Array(pos.count).fill(-2); // -2: not asked yet
      const buildingOf = (v: number) => (building[v] === -2 ? (building[v] = ask(w[v * 3], w[v * 3 + 2])) : building[v]);
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
        if (k % 48 === 0) await tick(); // every 16 triangles: one may be halved many times
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
        keep(found, lowest, world, [w[i * 3], w[i * 3 + 1], w[i * 3 + 2], w[j * 3], w[j * 3 + 1], w[j * 3 + 2], w[l * 3], w[l * 3 + 1], w[l * 3 + 2]], [buildingOf(i), buildingOf(j), buildingOf(l)], 0);
      }
    }
    // The blocks it stands for, capped at the lowest of its own roof over them (its corners over them, and its roof looked
    // at every half metre inside each: a block can lie under one triangle whose corners stand over a larger block).
    if (found.b.length) {
      const own = new RoofField();
      for (let i = 0; i < found.c.length; i += CHUNK * 9) {
        own.add(found.c.slice(i, i + CHUNK * 9), Infinity);
        await tick();
      }
      const box = boxes[r];
      for (const k of world.modelledIn(box.min.x, box.min.z, box.max.x, box.max.z)) {
        if (!world.blockPoints(k).some((p) => keepBlocks(...p))) world.capUnder(own, k); // not a left-out building's (a private home's)
        await tick();
      }
    }
    for (const [b, y] of lowest) if (!world.blockPoints(b).some((p) => keepBlocks(...p))) world.capBlock(b, y);
    // Second pass: solid down to the building's top where a corner stands over one, else an open slab (settle).
    const tri: number[] = [];
    const under: number[] = [];
    for (let t = 0; t < found.b.length; t += 3) {
      if (t % (CHUNK * 3) === 0) {
        if (under.length) kept += world.roofs.add(tri, under);
        tri.length = under.length = 0;
        await tick();
      } else if (t % 48 === 0) await tick(); // every 16 triangles: one may be halved many times (settle)
      // A block switched off by its cap (a lid stacked on the house, often wider than it, out to the eaves): the
      // building under that corner is asked again (the house block, or none past its walls).
      const b = [0, 1, 2].map((c) => {
        const k = found.b[t + c];
        return k >= 0 && !Number.isFinite(world.blockTopOf(k)) ? world.buildingAt(found.c[(t + c) * 3], found.c[(t + c) * 3 + 2], BUILDING) : k;
      });
      settle(world, found.c.slice(t * 3, t * 3 + 9), b, 0, tri, under);
    }
    if (under.length) kept += world.roofs.add(tri, under);
  }
  return kept;
}

/**
 * A roof triangle (`c`, `b` as in keep) into `tri` and `under`: solid down to the lowest top of the buildings under its
 * corners where any stands over one, else an open slab. One whose corners or middles stand over different buildings, or
 * over a building and past it (a lid that reached out to the eaves was switched off; a lower annex under the house's
 * roof), is halved again, as keep does, so the solid follows the walls and each block's top.
 */
function settle(world: World, c: number[], b: number[], depth: number, tri: number[], under: number[]): void {
  const tops = b.map((k) => (k >= 0 ? world.blockTopOf(k) : NaN));
  const len = (p: number, q: number) => Math.hypot(c[p * 3] - c[q * 3], c[p * 3 + 2] - c[q * 3 + 2]);
  const sides = [len(0, 1), len(1, 2), len(2, 0)];
  const longest = Math.max(...sides);
  // Each piece over one building (or none): its corners and, for one larger than SPLIT, its middles tell.
  let split = b[0] !== b[1] || b[1] !== b[2];
  if (!split && longest > SPLIT && depth < DEPTH) {
    const s = sides.indexOf(longest);
    const middles = [[(c[s * 3] + c[((s + 1) % 3) * 3]) / 2, (c[s * 3 + 2] + c[((s + 1) % 3) * 3 + 2]) / 2], [(c[0] + c[3] + c[6]) / 3, (c[2] + c[5] + c[8]) / 3]];
    split = middles.some(([x, z]) => world.buildingAt(x, z, BUILDING) !== b[0]);
  }
  if (split && longest > SPLIT && depth < DEPTH) {
    const s = sides.indexOf(longest);
    const [p, q, r] = [s, (s + 1) % 3, (s + 2) % 3];
    const m = [0, 1, 2].map((k) => (c[p * 3 + k] + c[q * 3 + k]) / 2);
    const mb = world.buildingAt(m[0], m[2], BUILDING);
    const at = (v: number) => c.slice(v * 3, v * 3 + 3);
    settle(world, [...at(p), ...m, ...at(r)], [b[p], mb, b[r]], depth + 1, tri, under);
    settle(world, [...m, ...at(q), ...at(r)], [mb, b[q], b[r]], depth + 1, tri, under);
    return;
  }
  tri.push(...c);
  // Solid down to the lowest of the buildings under any of its corners: what of it stands past the walls stops nobody and
  // lifts nobody there (World.roofBlocks, World.roofOut: only where a wall stands under it), and none of the building
  // under it is left open to stand in.
  const found = tops.filter((y) => Number.isFinite(y));
  under.push(found.length ? Math.min(...found) : Infinity);
}

/**
 * Keep a roof triangle (`c`: its corners, `b`: the building under each, -1 none): a corner over a block a model stands
 * for gives that block a height to be capped at (`lowest`). A triangle with some corners over a building and some not,
 * or over buildings with a passage or a yard between them, is halved through its longest side until its sides are under
 * SPLIT, so the solid follows the walls.
 */
function keep(found: Found, lowest: Map<number, number>, world: World, c: number[], b: number[], depth: number): void {
  const len = (p: number, q: number) => Math.hypot(c[p * 3] - c[q * 3], c[p * 3 + 2] - c[q * 3 + 2]);
  const sides = [len(0, 1), len(1, 2), len(2, 0)];
  const longest = Math.max(...sides);
  const over = b.map((k) => k >= 0);
  let mixed = over[0] !== over[1] || over[1] !== over[2];
  if (!mixed && longest > 2 * SPLIT && depth < DEPTH) {
    // All corners over buildings, but a passage or a yard between them under it; or none, but a building under its
    // middle (a big roof face whose corners all stand out at the eaves, past the walls): its middles tell.
    const s = sides.indexOf(longest);
    const middles = [[(c[s * 3] + c[((s + 1) % 3) * 3]) / 2, (c[s * 3 + 2] + c[((s + 1) % 3) * 3 + 2]) / 2], [(c[0] + c[3] + c[6]) / 3, (c[2] + c[5] + c[8]) / 3]];
    mixed = middles.some(([x, z]) => found.ask(x, z) >= 0 !== over[0]);
  }
  if (mixed && longest > SPLIT && depth < DEPTH) {
    const s = sides.indexOf(longest);
    const [p, q, r] = [s, (s + 1) % 3, (s + 2) % 3];
    const m = [0, 1, 2].map((k) => (c[p * 3 + k] + c[q * 3 + k]) / 2);
    const mb = found.ask(m[0], m[2]);
    const at = (v: number) => c.slice(v * 3, v * 3 + 3);
    keep(found, lowest, world, [...at(p), ...m, ...at(r)], [b[p], mb, b[r]], depth + 1);
    keep(found, lowest, world, [...m, ...at(q), ...at(r)], [mb, b[q], b[r]], depth + 1);
    return;
  }
  for (let k = 0; k < 3; k++) {
    if (b[k] >= 0 && world.modelledBlock(b[k])) lowest.set(b[k], Math.min(lowest.get(b[k]) ?? Infinity, c[k * 3 + 1]));
  }
  found.c.push(...c);
  found.b.push(...b);
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
