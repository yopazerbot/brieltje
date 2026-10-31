import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { VillageData } from './houseData';
import { tintedMaterial } from './houseMeshes';
import { terrain } from './terrain';

/**
 * The street Molenhoek round its portal: our own Blender model (tools/molenhoek.py) of its seventeen
 * nearest houses and of the street as it was rebuilt in 2026 (asphalt, red cycle lanes, kerbs,
 * pavements), in place of the village's blocks there, which stay for walking into.
 *
 * Its textured meshes name a shared game texture; the vertex colours tint it, so every brick colour
 * is one draw call and no graphics memory but the asphalt's. The small things (frames, gutters,
 * railings, signs) are drawn only within DETAIL metres of the portal's street.
 */
const DETAIL = 200;

interface Extras {
  origin: [number, number];
  landmark: string;
  /** Each modelled house's GRB outline: the village's blocks inside it give way */
  outlines: [number, number][][];
  /**
   * The new solid things (garden walls, posts, the cabinet) in world heights, and the new street's surfaces
   * for walking and driving on (`lift`: heights above the relief), with what a shot sounds like on them
   */
  solids: { p: [number, number][]; y0: number; y1: number; m?: string; lift?: boolean }[];
  /** The stretch whose concrete poles became steel lamp posts: its centre line and reach */
  poles: { line: [number, number][]; reach: number };
  /** The new street's outline: the pavings of the old one inside it give way */
  street: [number, number][];
  /** The village's trees that give way to the model's conifers: x, z and radius */
  clearTrees: [number, number, number][];
}

export async function loadMolenhoek(renderer: THREE.WebGLRenderer, ground: number): Promise<THREE.Object3D> {
  // Development only: ?nomolenhoek leaves the village's blocks, for comparing the cost.
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('nomolenhoek')) throw new Error('off');
  const scene = (await new GLTFLoader().loadAsync('/models/molenhoek.glb')).scene;
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
  for (const mesh of small) {
    const lod = new THREE.LOD();
    mesh.parent!.add(lod);
    lod.addLevel(mesh, 0);
    lod.addLevel(new THREE.Object3D(), DETAIL);
  }
  const [x, z] = (root.userData as Extras).origin;
  scene.position.set(x, ground + terrain.height(x, z), z);
  scene.userData = { ...root.userData, landmark: 'molenhoek' };
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
 * Fits the village data to the model, before its tiles are built: the blocks, roofs and windows of the
 * modelled houses are tagged as the landmark's (so they aren't drawn, but stay for walking into), the
 * new solid things join the blocks for walking into, and the concrete poles along the stretch become
 * steel lamp posts without cables, as the street has had since it was rebuilt. `first`: the number of
 * the village's first pole in the game's list (cables name poles by that number).
 */
export function fitVillage(data: VillageData, model: THREE.Object3D, first: number): void {
  const x = model.userData as Extras;
  const outlines = x.outlines;
  const middle = (ring: [number, number][]) => [ring.reduce((s, q) => s + q[0], 0) / ring.length, ring.reduce((s, q) => s + q[1], 0) / ring.length];
  const mine = (ring: [number, number][]) => {
    const [mx, mz] = middle(ring);
    return outlines.some((o) => near(o, mx, mz, 0.5) || ring.filter(([px, pz]) => near(o, px, pz, 0.35)).length >= ring.length * 0.8);
  };
  const street = x.street;
  const onStreet = (ring: [number, number][]) => ring.filter(([px, pz]) => near(street, px, pz, 0.2)).length >= ring.length * 0.6;
  for (const p of data.prisms ?? []) {
    if (p.lm) continue;
    if (p.d === undefined && mine(p.p[0])) p.lm = 'molenhoek';
    else if (p.m === 'road' && p.d) {
      // The old road under the new one: cut finer, so it follows the relief's own squares and stays under it.
      if (p.p[0].some(([px, pz]) => px > 640 && px < 900 && pz > -760 && pz < -680)) p.d = 4;
    } else if (p.d && !/hedge|fence/.test(p.m) && onStreet(p.p[0])) p.lm = 'molenhoek'; // pavings the new street covers
  }
  for (const r of data.roofs) {
    if (!r.lm && mine(r.p)) r.lm = 'molenhoek';
  }
  // The broad trees the laser scan saw round the portal give way to the model's conifers.
  data.trees = data.trees.filter((t) => !x.clearTrees.some(([cx, cz, r]) => Math.hypot(t.x - cx, t.z - cz) <= r));
  data.landmarks = [...(data.landmarks ?? []), ...outlines.map((p) => ({ name: 'molenhoek', p, base: 0, ground: 0 }))];
  for (const s of x.solids) data.prisms?.push({ m: s.m ?? 'concrete', y0: s.y0, y1: s.y1, p: [s.p], lm: 'molenhoek', ...(s.lift ? { d: 4, n: 'street' } : {}) });

  const { line, reach } = x.poles;
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
  const posts = new Set<number>();
  (data.poles ?? []).forEach((p, i) => {
    if (!p.k && onStretch(p.x, p.z)) {
      p.k = 'post';
      posts.add(first + i);
      for (const q of data.prisms ?? []) {
        // the concrete pole itself: no longer drawn, still there for walking into
        if (q.m === 'pole' && !q.lm && Math.hypot(q.p[0][0][0] - p.x, q.p[0][0][1] - p.z) < 0.6) q.lm = 'molenhoek';
      }
    }
  });
  data.wires = (data.wires ?? []).filter(([a, b]) => !posts.has(a) && !posts.has(b));
}
