import * as THREE from 'three';
import HELIS from '../../shared/heli.json';
import type { World } from './collision';

/**
 * The helicopters' landing pads (shared/heli.json pads): each machine's home and the church's platform. Listed for
 * the minimap's rings while you fly, the landing magnet (shared/heli.mjs env.pad) and the dev tools. A pad on the
 * ground is drawn here: a 10 m disc of pale pavers 3 cm over the meadow, a yellow circle 5 m across and a white "H",
 * thin geometry with no texture. The church's platform is the church's own model (tools/church.py draws it, its deck,
 * nets and rails are the church's blocks: tools/church_access.py); the dev hook testDeck is kept as a fallback for a
 * page without the village.
 */
export interface Pad {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** A deck with a line (a length and a width): its pull also turns the nose along it (shared/heli.mjs). */
  long: boolean;
}

/** The pads that are there: a `planned` one (nothing built there yet) has no ring and no pull. */
export const PADS: Pad[] = HELIS.pads.filter((p) => !('planned' in p && p.planned)).map((p) => ({ id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw, long: 'l' in p }));

/** The nearest pad within `reach` m on the plan, or null. */
export function padNear(x: number, z: number, reach = 12): Pad | null {
  let best: Pad | null = null;
  let d = reach;
  for (const p of PADS) {
    const e = Math.hypot(p.x - x, p.z - z);
    if (e < d) {
      d = e;
      best = p;
    }
  }
  return best;
}

/** The pads on the ground (`marked`), drawn: one group, five draw calls each. */
export function groundPads(groundY: (x: number, z: number) => number): THREE.Group {
  const group = new THREE.Group();
  const flat = (color: string, rough: number) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: rough });
    m.polygonOffset = true;
    m.polygonOffsetFactor = -2;
    m.polygonOffsetUnits = -2;
    return m;
  };
  const pavers = flat('#b9b2a5', 0.85);
  const yellow = flat('#f2c230', 0.6);
  const white = flat('#f3f1ea', 0.6);
  for (const spec of HELIS.pads) {
    if (!('marked' in spec) || !spec.marked) continue;
    const pad = new THREE.Group();
    const y = groundY(spec.x, spec.z);
    pad.position.set(spec.x, y + 0.03, spec.z);
    pad.rotation.y = spec.yaw;
    const lay = (g: THREE.BufferGeometry, m: THREE.Material, lift: number) => {
      const mesh = new THREE.Mesh(g.rotateX(-Math.PI / 2), m);
      mesh.position.y = lift;
      mesh.receiveShadow = true;
      mesh.userData.ignoreRay = true;
      pad.add(mesh);
    };
    lay(new THREE.CircleGeometry(5, 40), pavers, 0);
    lay(new THREE.RingGeometry(2.3, 2.5, 40), yellow, 0.005);
    // The H: two uprights and a bar, across the machine's way.
    const bar = (w: number, l: number, x: number, z: number) => new THREE.PlaneGeometry(w, l).translate(x, -z, 0);
    lay(bar(0.28, 2.2, -0.65, 0), white, 0.006);
    lay(bar(0.28, 2.2, 0.65, 0), white, 0.006);
    lay(bar(1.1, 0.26, 0, 0), white, 0.006);
    group.add(pad);
  }
  return group;
}

/**
 * Dev, a fallback for a page without the village (the church's own deck comes with it): a plain deck of the church
 * platform's size (6 by 10 m, across the church's axis) at its place and height, solid for walking and landing, drawn
 * as a grey slab; null when there is no such pad. Its block stays until the page reloads.
 */
export function testDeck(world: World, scene: THREE.Object3D): THREE.Mesh | null {
  const spec = HELIS.pads.find((p) => p.id === 'church');
  if (!spec || !('w' in spec)) return null;
  const w = spec.w ?? 6;
  const l = spec.l ?? 10;
  const c = Math.cos(spec.yaw), s = Math.sin(spec.yaw);
  // The deck's long side across the machine's way (it parks across the church's axis): l along its heading.
  const corner = (a: number, b: number): [number, number] => [spec.x + a * c + b * s, spec.z - a * s + b * c];
  const ring: [number, number][] = [corner(-w / 2, -l / 2), corner(w / 2, -l / 2), corner(w / 2, l / 2), corner(-w / 2, l / 2)];
  world.addPrisms([{ m: 'concrete', y0: spec.y - 0.3, y1: spec.y, p: [ring], n: 'Helipad' }]);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, l), new THREE.MeshStandardMaterial({ color: '#8d8f8c', roughness: 0.8 }));
  mesh.position.set(spec.x, spec.y - 0.15, spec.z);
  mesh.rotation.y = spec.yaw;
  scene.add(mesh);
  return mesh;
}
