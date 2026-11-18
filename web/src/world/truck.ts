import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TRUCK } from '../../shared/assaultFields.mjs';

/**
 * Attack and defend's spawn truck (server/assault.mjs), built in code: a big boxy lorry with a short cab and a tall box
 * behind it, made like the Teslas' models so world/car.ts drives and draws it as one of them (its "model" is
 * 'proc:truck', shared/assaultFields.mjs TRUCK). Its parts carry the same material names (Paint in the team's colour,
 * Glass, Trim, Plate, Tyre, Rim, LightBar, TailLight) and its four wheels are pivots named Wheel_FL ... Wheel_RR at their
 * axles. A generic shape of our own, no make or badge. Each material's parts are merged into one mesh: 18 draw calls in
 * all, fewer than a Tesla. Its nose is along -z, the ground at y = 0, as the cars' models.
 */

const L = TRUCK.length;
const W = TRUCK.width;
const H = TRUCK.height;
const WHEEL_R = 0.52;
const WHEEL_W = 0.36;
const FRONT_AXLE = -L / 2 + 1.25;
const REAR_AXLE = L / 2 - 1.5;
const WHEEL_X = W / 2 - 0.32;

/** A box from (x0, y0, z0) to (x1, y1, z1), in the model's frame. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
}

/** The cars' materials multiply in a shade per corner (vertexColors): white everywhere here, the light does the rest. */
function white(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.attributes.position.count;
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  return g;
}

/** All of `list` in one geometry, not indexed. */
function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = list.map((q) => (q.index ? q.toNonIndexed() : q));
  const g = mergeGeometries(flat) ?? new THREE.BufferGeometry();
  list.forEach((q) => q.dispose());
  flat.forEach((q) => q.dispose());
  return g;
}

/** One mesh of `geometry`, its material named `name` (world/car.ts prepare swaps in the game's material of that name). */
function part(name: string, geometry: THREE.BufferGeometry): THREE.Mesh {
  const mat = new THREE.MeshStandardMaterial();
  mat.name = name;
  return new THREE.Mesh(white(geometry), mat);
}

/**
 * The truck's body parts by material name, in the model's frame (its wheels' tyres with them, at their axles): for the
 * spawn truck (truckModel) and the camp's supply truck (world/assaultCamp.ts, merged into the camp in colours of its own).
 */
export function truckParts(): { name: string; geometry: THREE.BufferGeometry }[] {
  const cabBack = -L / 2 + 2.15;
  const hw = W / 2;
  // The body: a short cab, a tall box, a bumper and a frame under them.
  const paint = [
    box(-hw, 0.95, -L / 2 + 0.12, hw, 2.15, cabBack), // the cab's lower half
    box(-hw + 0.06, 2.15, -L / 2 + 0.45, hw - 0.06, 2.85, cabBack), // its upper half, set back above the bonnet line
    box(-hw - 0.02, 1.05, cabBack + 0.12, hw + 0.02, H, L / 2 - 0.1), // the box
  ];
  const trim = [
    box(-0.55, 0.62, -L / 2 + 0.3, 0.55, 0.95, L / 2 - 0.3), // the frame
    box(-hw, 0.55, -L / 2, hw, 0.95, -L / 2 + 0.16), // the front bumper
    box(-hw + 0.1, 0.62, L / 2 - 0.12, hw - 0.1, 0.95, L / 2), // the rear step
    box(-hw - 0.03, 2.95, cabBack + 0.08, hw + 0.03, 3.05, cabBack + 0.16), // a rail where the box meets the cab
    box(-hw - 0.05, 1.0, -L / 2 + 0.7, -hw, 1.6, -L / 2 + 1.0), // the steps up into the cab
    box(hw, 1.0, -L / 2 + 0.7, hw + 0.05, 1.6, -L / 2 + 1.0),
    // Mud guards over the wheels.
    ...[FRONT_AXLE, REAR_AXLE].flatMap((z) => [box(-hw - 0.04, 1.1, z - 0.7, -hw + 0.02, 1.2, z + 0.7), box(hw - 0.02, 1.1, z - 0.7, hw + 0.04, 1.2, z + 0.7)]),
  ];
  // The box's sides: a wide white band at the middle, the team's colour round it, readable from far off.
  const plate = [
    box(-hw - 0.05, 1.75, cabBack + 0.6, -hw - 0.02, 2.45, L / 2 - 0.6),
    box(hw + 0.02, 1.75, cabBack + 0.6, hw + 0.05, 2.45, L / 2 - 0.6),
    box(-hw + 0.25, 1.55, L / 2 - 0.1, hw - 0.25, 2.95, L / 2 - 0.06), // the back doors' white panel
  ];
  const glass = [
    box(-hw + 0.14, 2.18, -L / 2 + 0.43, hw - 0.14, 2.78, -L / 2 + 0.47), // the windscreen
    box(-hw + 0.04, 2.2, -L / 2 + 0.6, -hw + 0.08, 2.75, cabBack - 0.15), // the side windows
    box(hw - 0.08, 2.2, -L / 2 + 0.6, hw - 0.04, 2.75, cabBack - 0.15),
  ];
  const lamps = [box(-hw + 0.15, 1.35, -L / 2 + 0.08, -hw + 0.55, 1.6, -L / 2 + 0.13), box(hw - 0.55, 1.35, -L / 2 + 0.08, hw - 0.15, 1.6, -L / 2 + 0.13)];
  const tail = [box(-hw + 0.08, 1.15, L / 2 - 0.08, -hw + 0.3, 1.45, L / 2 - 0.04), box(hw - 0.3, 1.15, L / 2 - 0.08, hw - 0.08, 1.45, L / 2 - 0.04)];
  // A beacon on the cab's roof: the spawn truck is the one with the light.
  const beacon = [box(-0.18, 2.85, -L / 2 + 1.0, 0.18, 3.05, -L / 2 + 1.3)];
  const tyres = [[-WHEEL_X, FRONT_AXLE], [WHEEL_X, FRONT_AXLE], [-WHEEL_X, REAR_AXLE], [WHEEL_X, REAR_AXLE]].map(([x, z]) => new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, WHEEL_W, 20).rotateZ(Math.PI / 2).translate(x, WHEEL_R, z));
  return [
    { name: 'Paint', geometry: merge(paint) },
    { name: 'Trim', geometry: merge(trim) },
    { name: 'Plate', geometry: merge(plate) },
    { name: 'Glass', geometry: merge(glass) },
    { name: 'LightBar', geometry: merge([...lamps, ...beacon]) },
    { name: 'TailLight', geometry: merge(tail) },
    { name: 'Tyre', geometry: merge(tyres) },
  ];
}

/** A wheel at its axle (a pivot named as the cars' models name theirs): the tyre, the rim's dish, the hub. */
function wheel(name: string, x: number, z: number): THREE.Group {
  const pivot = new THREE.Group();
  pivot.name = name;
  pivot.position.set(x, WHEEL_R, z);
  const side = Math.sign(x);
  const tyre = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, WHEEL_W, 20).rotateZ(Math.PI / 2);
  const rim = new THREE.CylinderGeometry(WHEEL_R * 0.62, WHEEL_R * 0.62, 0.04, 16).rotateZ(Math.PI / 2).translate(side * (WHEEL_W / 2 + 0.005), 0, 0);
  const hub = new THREE.CylinderGeometry(0.12, 0.12, 0.06, 10).rotateZ(Math.PI / 2).translate(side * (WHEEL_W / 2 + 0.03), 0, 0);
  pivot.add(part('Tyre', merge([tyre])), part('Rim', merge([rim])), part('RimDark', merge([hub])));
  return pivot;
}

/** The spawn truck's model: a fresh group each call (world/car.ts clones what it is given anyway). */
export function truckModel(): THREE.Group {
  const g = new THREE.Group();
  for (const { name, geometry } of truckParts()) {
    if (name === 'Tyre') geometry.dispose(); // the wheels turn: each its own pivot below
    else g.add(part(name, geometry));
  }
  g.add(wheel('Wheel_FL', -WHEEL_X, FRONT_AXLE), wheel('Wheel_FR', WHEEL_X, FRONT_AXLE), wheel('Wheel_RL', -WHEEL_X, REAR_AXLE), wheel('Wheel_RR', WHEEL_X, REAR_AXLE));
  return g;
}
