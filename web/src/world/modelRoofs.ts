import * as THREE from 'three';
import type { Prism, RoofSpec } from './houseData';
import type { World } from './collision';
import { facesUp } from './roofField';
import { terrain } from './terrain';

/**
 * Our models' roofs as floors and solids (world/roofField.ts), from their meshes as drawn, once a model is in place: the
 * triangles that face up and lie more than ABOVE metres over the ground there (roofs, dormers, chimney tops, a shelter's
 * roof; not terraces, steps, benches or fences: those stay as they are), a roof's own mesh from lower down. Under each it is solid down to the top of the block that stands under it (the
 * open-data block kept for walking into), or a slab where none does (an overhang, a porch, a stand's roof). Instanced
 * things (trees, lamps, posts), leaves, nets, details and what `leaveOut` names are left out.
 */
const ABOVE = 1.5;
/** Meshes of roofs (tiles, slates, a roof's own mesh): a triangle counts once any of it is this far over the ground. */
const ROOFS = /roof|tiles|slate/i;
const ROOF_ABOVE = 1.0;
/** Meshes that are never a roof, by their name or their material's: see-through nets (a goal's), cables, greenery. */
const NOT_ROOFS = /net|cable|wire|foliage|leaf|leaves|hedge/i;
/** Metres over the ground a block must reach to be the building under a roof (not paving or a low wall). */
const BUILDING = 1.0;

/** Milliseconds of work between two pauses (`pause`: a frame goes by). */
const SLICE = 6;
/** Triangles looked at between two looks at the clock. */
const CHUNK = 2000;

const a = new THREE.Vector3();

/** The meshes of `roots` whose roofs count: drawn, not instanced, not leaves, a LOD's near level only. */
function roofMeshes(roots: THREE.Object3D[]): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  for (const root of roots) {
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
  }
  return out;
}

/**
 * Adds the roofs of `roots` (models in place) to the world's, a few milliseconds at a time with a `pause` between (a
 * frame: the village's models are many triangles). `ground` is the flat ground's height (terrain heights are over it).
 * Resolves to the triangles kept.
 */
export async function addModelRoofs(world: World, roots: THREE.Object3D[], ground: number, leaveOut: (x: number, z: number) => boolean = () => false,
  pause: () => Promise<unknown> = () => Promise.resolve()): Promise<number> {
  let kept = 0;
  let since = performance.now();
  const tri: number[] = [];
  const under: number[] = [];
  for (const mesh of roofMeshes(roots)) {
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
    // Every corner where it stands, once.
    const w = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) a.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).toArray(w, i * 3);
    const index = mesh.geometry.index;
    const corners = index ? index.count : pos.count;
    // Drawn from one side: only what faces up from above (not a soffit, a ceiling); a mirrored mesh turns its faces.
    const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.Material[];
    const both = mats.some((m) => m.side === THREE.DoubleSide);
    // A mesh of roofs (by its name or its material's) counts as soon as any of a triangle reaches ROOF_ABOVE: a shed's or an
    // annex's roof where the ground the collision has lies higher than the model's own (World cuts what lies lower).
    const roofy = [mesh.name, mesh.userData.material, ...mats.map((m) => m.name)].some((n) => typeof n === 'string' && ROOFS.test(n));
    const turned = mesh.matrixWorld.determinant() < 0;
    for (let from = 0; from < corners; from += CHUNK * 3) {
      tri.length = under.length = 0;
      for (let k = from; k + 2 < Math.min(corners, from + CHUNK * 3); k += 3) {
        const i = (index ? index.getX(k) : k) * 3;
        const j = (index ? index.getX(turned ? k + 2 : k + 1) : turned ? k + 2 : k + 1) * 3;
        const l = (index ? index.getX(turned ? k + 1 : k + 2) : turned ? k + 1 : k + 2) * 3;
        if (!facesUp(w[i], w[i + 1], w[i + 2], w[j], w[j + 1], w[j + 2], w[l], w[l + 1], w[l + 2], both)) continue;
        const low = Math.min(w[i + 1], w[j + 1], w[l + 1]);
        const high = Math.max(w[i + 1], w[j + 1], w[l + 1]);
        const mx = (w[i] + w[j] + w[l]) / 3;
        const mz = (w[i + 2] + w[j + 2] + w[l + 2]) / 3;
        const floor = ground + terrain.height(mx, mz);
        if ((roofy ? high < floor + ROOF_ABOVE : low < floor + ABOVE) || leaveOut(mx, mz)) continue;
        // The building under it: the highest block whose top lies under this triangle's middle.
        const top = world.blockTop(mx, mz, low + 0.05);
        tri.push(w[i], w[i + 1], w[i + 2], w[j], w[j + 1], w[j + 2], w[l], w[l + 1], w[l + 2]);
        under.push(top > floor + BUILDING ? top : Infinity);
      }
      if (under.length) kept += world.roofs.add(tri, under);
      if (performance.now() - since > SLICE) {
        await pause();
        since = performance.now();
      }
    }
  }
  return kept;
}

/** The models that keep their own hand-made blocks and floors (their roof walks, stairs and platforms are game places). */
const OWN = ['church', 'sparrenhof', 'tree_huts'];

/**
 * The village's models' roofs (`models`: as loaded, each with its `landmark`), but the church's, the Sparrenhof's, the
 * tree huts' and the end house's at Molenhoek (a private home: its own blocks, floors and roof, `endHouse`), with
 * its eaves (0.8 m round it).
 */
export function villageRoofs(world: World, models: THREE.Object3D[], ground: number, endHouse: { contains(x: number, z: number): boolean } | null,
  pause: () => Promise<unknown>): Promise<number> {
  const roofed = models.filter((m) => !OWN.includes(String(m.userData.landmark)));
  const AROUND = [[0, 0], [0.8, 0], [-0.8, 0], [0, 0.8], [0, -0.8]];
  const end = (x: number, z: number) => !!endHouse && AROUND.some(([a, b]) => endHouse.contains(x + a, z + b));
  return addModelRoofs(world, roofed, ground, end, pause);
}

/**
 * The two private homes round the house (world/homeLocks.ts): the main house (its floors, stairs and roofs in the house
 * data) and the bungalow (its veranda, and its roof: the ring's roof over a room), each with a margin. Our models'
 * trim there (the bungalow's roof trim) adds no roof: their own blocks and floors stay as they are.
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
  return (x, z) => boxes.some(([x0, z0, x1, z1]) => x >= x0 && x <= x1 && z >= z0 && z <= z1);
}
