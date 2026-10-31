import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { VillageData } from './houseData';
import { tintedMaterial } from './houseMeshes';
import { terrain } from './terrain';

/**
 * Streets of houses as our own Blender models (tools/molenhoek.py), in place of the village's blocks there, which
 * stay for walking into: Molenhoek, its forty-seven houses from the church square to the junction where the map
 * ends and the street as it was rebuilt in 2026 (asphalt, red cycle lanes, kerbs, pavements); Kapellenhoek, its
 * houses from the church square to past its junction with Briel and the first stretch of Kapelleweg, on the
 * village's own street.
 *
 * Their textured meshes name a shared game texture; the vertex colours tint it, so every brick colour is one
 * draw call and no graphics memory but the asphalt's. The small things (frames, gutters, railings, sills, signs)
 * come in three parts along the street, each drawn only within DETAIL metres of its own middle.
 */
const DETAIL = 200;

interface Extras {
  origin: [number, number];
  landmark: string;
  /** Each modelled house's GRB outline: the village's blocks inside it give way */
  outlines: [number, number][][];
  /**
   * The new solid things (garden walls, hedges, posts, the cabinet) in world heights, and a rebuilt street's
   * surfaces for walking and driving on (`lift`: heights above the relief), with what a shot sounds like on them
   */
  solids: { p: [number, number][]; y0: number; y1: number; m?: string; lift?: boolean }[];
  /** A rebuilt stretch whose concrete poles became steel lamp posts: its centre line and reach (empty: none) */
  poles: { line: [number, number][]; reach: number };
  /** A rebuilt street's outline: the pavings of the old one inside it give way (empty: the village's street stays) */
  street: [number, number][];
  /** From which x the rebuilt street is new asphalt over the old road (whose blocks there give way too), if any */
  newStreetFrom?: number;
  /** The village's trees that give way to the model's conifers: x, z and radius */
  clearTrees: [number, number, number][];
}

/** `name`: the model, /models/<name>.glb, and the landmark the village's blocks it replaces are tagged with. */
export async function loadStreetModel(renderer: THREE.WebGLRenderer, ground: number, name: string): Promise<THREE.Object3D> {
  // Development only: ?no<name> leaves the village's blocks, for comparing the cost.
  if (import.meta.env.DEV && new URLSearchParams(location.search).has(`no${name}`)) throw new Error('off');
  const scene = (await new GLTFLoader().loadAsync(`/models/${name}.glb`)).scene;
  const root = scene.children.find((o) => o.userData.origin) ?? scene;
  const small: THREE.Mesh[] = [];
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const old = mesh.material as THREE.MeshStandardMaterial;
    const u = old.userData as { texture?: string; normalScale?: number; lod?: number };
    if (u.texture) {
      const m = tintedMaterial(u.texture, '#ffffff', renderer);
      m.vertexColors = true;
      m.normalScale.setScalar(u.normalScale ?? 1);
      mesh.material = m;
      old.dispose();
    }
    mesh.receiveShadow = true;
    if (u.lod) small.push(mesh);
  });
  // Each part of the small things is measured from its own middle (the mesh's packed positions are scaled and
  // moved by its node, so the middle is taken through that).
  for (const mesh of small) {
    mesh.geometry.computeBoundingSphere();
    mesh.updateMatrix();
    const middle = mesh.geometry.boundingSphere!.center.clone().applyMatrix4(mesh.matrix);
    const lod = new THREE.LOD();
    lod.position.copy(middle);
    mesh.position.sub(middle);
    mesh.parent!.add(lod);
    lod.addLevel(mesh, 0);
    lod.addLevel(new THREE.Object3D(), DETAIL);
  }
  const [x, z] = (root.userData as Extras).origin;
  scene.position.set(x, ground + terrain.height(x, z), z);
  scene.userData = { ...root.userData, landmark: name };
  return scene;
}

/** Whether (x, z) lies inside the outline or within `slack` metres of it. */
function near(ring: [number, number][], x: number, z: number, slack: number): boolean {
  let hit = false;
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
    const dx = xj - xi;
    const dz = zj - zi;
    const t = Math.max(0, Math.min(1, ((x - xi) * dx + (z - zi) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(xi + dx * t - x, zi + dz * t - z));
  }
  return hit || best <= slack;
}

/**
 * Fits the village data to a street model, before its tiles are built: the blocks, roofs and windows of the
 * modelled houses are tagged as the landmark's (so they aren't drawn, but stay for walking into), the new solid
 * things join the blocks for walking into, and, where the street was rebuilt, the concrete poles along it become
 * steel lamp posts without cables. `first`: the number of the village's first pole in the game's list (cables
 * name poles by that number).
 */
export function fitStreetModel(data: VillageData, model: THREE.Object3D, first: number): void {
  const x = model.userData as Extras;
  const name = x.landmark;
  const outlines = x.outlines;
  const middle = (ring: [number, number][]) => [ring.reduce((s, q) => s + q[0], 0) / ring.length, ring.reduce((s, q) => s + q[1], 0) / ring.length];
  const mine = (ring: [number, number][]) => {
    const [mx, mz] = middle(ring);
    return outlines.some((o) => near(o, mx, mz, 0.5) || ring.filter(([px, pz]) => near(o, px, pz, 0.35)).length >= ring.length * 0.8);
  };
  const street = x.street;
  // Only what lies by a rebuilt street needs the closer looks below.
  const sx0 = Math.min(...street.map((q) => q[0])) - 5;
  const sx1 = Math.max(...street.map((q) => q[0])) + 5;
  const sz0 = Math.min(...street.map((q) => q[1])) - 5;
  const sz1 = Math.max(...street.map((q) => q[1])) + 5;
  const byStreet = (ring: [number, number][]) => street.length > 0 && ring.some(([px, pz]) => px > sx0 && px < sx1 && pz > sz0 && pz < sz1);
  const onStreet = (ring: [number, number][]) => ring.filter(([px, pz]) => near(street, px, pz, 0.2)).length >= ring.length * 0.6;
  for (const p of data.prisms ?? []) {
    if (p.lm) continue;
    if (p.d === undefined && mine(p.p[0])) p.lm = name;
    else if (p.d && !/hedge|fence/.test(p.m) && byStreet(p.p[0])) {
      if (p.m !== 'road' && onStreet(p.p[0])) p.lm = name; // pavings the new street covers
      // The old road where the new asphalt lies over it: drawn by the model, so it can't rise through in a dip.
      else if (p.m === 'road' && x.newStreetFrom !== undefined && p.p[0].every(([px]) => px > x.newStreetFrom!) && onStreet(p.p[0])) p.lm = name;
      // The old road and the pavings beside the new street: cut finer, so they follow the relief's own squares and
      // stay under the new surfaces (cut every 8 m, they rose through them in places).
      else if (p.p[0].some(([px, pz]) => near(street, px, pz, 4))) p.d = Math.min(p.d, 4);
    }
  }
  for (const r of data.roofs) {
    if (!r.lm && mine(r.p)) r.lm = name;
  }
  // The broad trees the laser scan saw round the portal give way to the model's conifers.
  data.trees = data.trees.filter((t) => !x.clearTrees.some(([cx, cz, r]) => Math.hypot(t.x - cx, t.z - cz) <= r));
  data.landmarks = [...(data.landmarks ?? []), ...outlines.map((p) => ({ name, p, base: 0, ground: 0 }))];
  for (const s of x.solids) data.prisms?.push({ m: s.m ?? 'concrete', y0: s.y0, y1: s.y1, p: [s.p], lm: name, ...(s.lift ? { d: 4, n: 'street' } : {}) });

  const { line, reach } = x.poles;
  if (line.length < 2) return;
  const onStretch = (px: number, pz: number) => {
    for (let i = 1; i < line.length; i++) {
      const [ax, az] = line[i - 1];
      const [bx, bz] = line[i];
      const dx = bx - ax;
      const dz = bz - az;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz)));
      if (Math.hypot(ax + dx * t - px, az + dz * t - pz) <= reach) return true;
    }
    return false;
  };
  // The pavements' back edges (the street's outline is the one edge west to east, then the other back).
  const half = street.length / 2;
  const edges = [street.slice(0, half), street.slice(half)];
  /** The nearest point on either back edge to (px, pz). */
  const backEdge = (px: number, pz: number): [number, number] => {
    let best: [number, number] = [px, pz];
    let bestD = Infinity;
    for (const e of edges) {
      for (let i = 1; i < e.length; i++) {
        const [ax, az] = e[i - 1];
        const [bx, bz] = e[i];
        const dx = bx - ax;
        const dz = bz - az;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)));
        const d = Math.hypot(ax + dx * t - px, az + dz * t - pz);
        if (d < bestD) {
          bestD = d;
          best = [ax + dx * t, az + dz * t];
        }
      }
    }
    return best;
  };
  const posts = new Set<number>();
  (data.poles ?? []).forEach((p, i) => {
    if (!p.k && onStretch(p.x, p.z)) {
      p.k = 'post';
      posts.add(first + i);
      const pole = (data.prisms ?? []).find((q) => q.m === 'pole' && !q.lm && Math.hypot(q.p[0][0][0] - p.x, q.p[0][0][1] - p.z) < 0.6);
      if (pole) pole.lm = name; // the concrete pole itself: no longer drawn, still there for walking into
      // A post that would stand on the new street's lanes or pavement stands just behind the pavement instead,
      // as the new posts do: off the walking line. Its block for walking into goes with it.
      if (near(street, p.x, p.z, 0) && street.length >= 4) {
        const [ex, ez] = backEdge(p.x, p.z);
        const len = Math.hypot(ex - p.x, ez - p.z) || 1;
        const nx = ex + ((ex - p.x) / len) * 0.25;
        const nz = ez + ((ez - p.z) / len) * 0.25;
        if (pole) pole.p = pole.p.map((ring) => ring.map(([qx, qz]) => [qx + nx - p.x, qz + nz - p.z] as [number, number]));
        p.x = nx;
        p.z = nz;
      }
    }
  });
  data.wires = (data.wires ?? []).filter(([a, b]) => !posts.has(a) && !posts.has(b));
}
