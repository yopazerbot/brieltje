import * as THREE from 'three';
import { COLUMN_HEIGHT, columnConifer } from './cardTrees';
import { cardsBuilt, enlist, leafCardMaterial } from './leafCards';
import { terrain } from './terrain';

/**
 * The columnar conifers in the street models' front gardens and by the Molenhoek portal (tools/molenhoek.py: Leyland
 * cypresses and thujas) as leaf-card conifers on Medium and up (world/cardTrees.ts columnConifer), in place of the
 * models' textured cones. On Low and phones the cones stay.
 *
 * The cones are found in the model's foliage mesh (its hedges, box balls and cones are one mesh): a cone's tip is its
 * highest point, the only foliage that high over the ground, and the cone round it is the foliage within its radius,
 * from its foot to its tip. The mesh gets a second set of triangles without the cones (the cones' own swapped in on
 * Low), and the conifers one instanced mesh, each copy as tall and wide as its cone and in its colour.
 */

/** Metres over the ground: foliage this high is a conifer's (the clipped hedges stop lower). */
const TALL = 2.9;

interface Cone {
  x: number;
  z: number;
  /** Foot and tip, in the model's own heights */
  foot: number;
  tip: number;
  r: number;
  colour: THREE.Color;
}

const material = leafCardMaterial(0.015, 0.006, false, 0.2);
let shape: THREE.BufferGeometry | null = null;

/**
 * Swap the cones of a street model for leaf-card conifers (`scene`: the model as loaded, before it is placed; `at`:
 * where its origin will stand on the map, x and z, for the ground under each cone).
 */
export function cardConifers(scene: THREE.Object3D, at: [number, number]): void {
  if (!cardsBuilt()) return; // a phone keeps the cones
  scene.updateMatrixWorld(true);
  let foliage: THREE.Mesh | null = null;
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.name === 'mh_foliage') foliage = o as THREE.Mesh;
  });
  if (!foliage) return;
  const mesh = foliage as THREE.Mesh;
  const geometry = mesh.geometry;
  const pos = geometry.getAttribute('position');
  const col = geometry.getAttribute('color');
  const index = geometry.getIndex();
  if (!index) return;
  // Every corner in the model's space, and how high it stands over the ground under it.
  const p: THREE.Vector3[] = [];
  const over: number[] = [];
  const base = terrain.height(at[0], at[1]);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    p.push(v.clone());
    over.push(v.y + base - terrain.height(at[0] + v.x, at[1] + v.z));
  }
  // Tips: the highest corners, each one not already on a cone found (the cone widens down from its tip).
  const high = p.map((_, i) => i).filter((i) => over[i] > TALL).sort((a, b) => p[b].y - p[a].y);
  const cones: Cone[] = [];
  for (const i of high) {
    const q = p[i];
    const on = cones.some((c) => Math.hypot(q.x - c.x, q.z - c.z) <= 0.45 * (c.tip - q.y) + 0.2);
    if (on) continue;
    const foot = q.y - over[i];
    cones.push({ x: q.x, z: q.z, foot, tip: q.y, r: 0, colour: new THREE.Color(1, 1, 1) });
  }
  if (!cones.length) return;
  // Each cone's axis and width from its corners a little above the foot (its broadest tiers), and its colour.
  for (const c of cones) {
    const h = c.tip - c.foot;
    let sx = 0;
    let sz = 0;
    let n = 0;
    const lower: number[] = [];
    const tone = new THREE.Color(0, 0, 0);
    for (let i = 0; i < p.length; i++) {
      const up = p[i].y - c.foot;
      if (up < 0.1 * h || up > 0.3 * h) continue;
      const d = Math.hypot(p[i].x - c.x, p[i].z - c.z);
      if (d > 1.8) continue;
      sx += p[i].x;
      sz += p[i].z;
      n++;
      lower.push(d);
      if (col) tone.r += col.getX(i), tone.g += col.getY(i), tone.b += col.getZ(i);
    }
    if (n) {
      c.x = sx / n;
      c.z = sz / n;
      lower.sort((a, b) => a - b);
      c.r = Math.max(0.35, lower[Math.floor(lower.length / 2)]);
      if (col) c.colour.setRGB(tone.r / n, tone.g / n, tone.b / n);
    } else {
      c.r = Math.max(0.35, h * 0.13);
    }
  }
  // The cones' triangles: every corner within its cone.
  const inCone = (i: number) =>
    cones.some((c) => p[i].y >= c.foot + 0.2 && p[i].y <= c.tip + 0.05 && Math.hypot(p[i].x - c.x, p[i].z - c.z) <= c.r * 1.2 + 0.06);
  const keep: number[] = [];
  const gone: number[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t);
    const b = index.getX(t + 1);
    const c = index.getX(t + 2);
    (inCone(a) && inCone(b) && inCone(c) ? gone : keep).push(a, b, c);
  }
  if (!gone.length) return;
  const without = geometry.clone();
  without.setIndex(keep);
  // The conifers: one copy each, as tall and wide as its cone, its colour lifted from the cone's (the model's
  // colours are for the dark hedge texture).
  shape ??= columnConifer();
  const conifers = new THREE.InstancedMesh(shape, material, cones.length);
  const q = new THREE.Quaternion();
  cones.forEach((c, k) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (c.x * 7.1 + c.z * 3.3) % (Math.PI * 2));
    conifers.setMatrixAt(k, new THREE.Matrix4().compose(new THREE.Vector3(c.x, c.foot, c.z), q, new THREE.Vector3(c.r, (c.tip - c.foot) / COLUMN_HEIGHT, c.r)));
    // A dying one stays brown; the others take their cone's green.
    const lum = c.colour.r * 0.3 + c.colour.g * 0.59 + c.colour.b * 0.11;
    conifers.setColorAt(k, c.colour.clone().multiplyScalar(lum > 0 ? 0.55 / lum : 1).lerp(new THREE.Color(1, 1, 1), 0.35));
  });
  conifers.castShadow = true;
  conifers.receiveShadow = true;
  conifers.name = 'mh_foliage';
  conifers.userData.material = 'hedge';
  conifers.computeBoundingSphere();
  // In the model's space: its parent is the scene itself, placed with it.
  scene.add(conifers);
  const whole = geometry;
  enlist([], [], (full) => {
    mesh.geometry = full ? without : whole;
    conifers.visible = full;
  });
}
