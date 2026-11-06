import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { World } from './collision';
import type { Prism } from './houseData';
import { DOCK } from './mower';

/**
 * The everyday things in the gardens of the main house and the bungalow (tools/garden_life.py):
 * a letterbox at each entrance, a bike against the side wall, garden tools, planters on
 * the terrace, the robot mower's station (world/mower.ts); at the bungalow a teak table with chairs
 * under a parasol, two loungers and a kettle barbecue. Each garden is one mesh painted per vertex
 * (one draw call). No washing line at the main house (Yoshi). The bulky things block the way. At the bungalow, which the sun's real-time shadow doesn't reach, a soft
 * dark patch lies under each thing.
 */

/** A model's parts in one geometry, every material's colour painted on its points (`colors` repaints by material name). */
export function painted(object: THREE.Object3D, colors: Record<string, string> = {}, each?: (material: string, geometry: THREE.BufferGeometry) => void): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  object.updateMatrixWorld(true);
  const root = new THREE.Matrix4().copy(object.matrixWorld).invert();
  object.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const mat = o.material as THREE.MeshStandardMaterial;
    let g = o.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(root, o.matrixWorld).premultiply(object.matrix));
    if (g.index) g = g.toNonIndexed();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    const c = new THREE.Color(colors[mat.name] ?? mat.color);
    const rgb = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < rgb.length; i += 3) rgb.set([c.r, c.g, c.b], i);
    g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    each?.(mat.name, g);
    parts.push(g);
  });
  return mergeGeometries(parts);
}

/** Where a thing stands: model, place on the plan, turn (its front +z turned by yaw), lean, repaint, the box it blocks. */
interface Place {
  model: string;
  x: number;
  z: number;
  yaw: number;
  /** Lean about its own left-right axis (radians, + forwards) */
  tilt?: number;
  colors?: Record<string, string>;
  /** Blocks the way: width, depth and height of its box */
  solid?: [number, number, number];
  /** Radius of the dark patch under it (the bungalow) */
  blob?: number;
}

// The front of a facade, along it and out of it, for the bungalow (turned 39.8 degrees off the grid).
const OUT: [number, number] = [0.768, 0.64]; // out of the veranda side, into the garden
const ALONG: [number, number] = [0.64, -0.768]; // along the veranda, towards the road
const FACING_HOUSE = Math.atan2(-OUT[0], -OUT[1]); // a front turned to the bungalow
const FACING_GARDEN = Math.atan2(OUT[0], OUT[1]);
/** A point in the bungalow's garden: `out` metres out from the middle of the veranda's glass, `along` along it. */
const garden = (out: number, along: number): [number, number] => [88.7 + OUT[0] * out + ALONG[0] * along, 195.35 + OUT[1] * out + ALONG[1] * along];

const HOUSE: Place[] = [
  // The letterbox where the front path meets the street. No wheelie bins (Yoshi).
  { model: 'Letterbox', x: 11.05, z: 16.8, yaw: 0, solid: [0.12, 0.12, 1.35] },
  // The bike on its stand in the side passage, against the left wall.
  { model: 'Bike', x: -0.5, z: 6.2, yaw: Math.PI, solid: [0.55, 1.8, 1.05] },
  // Tools on the strip beside the path to the back, the rake against the hedge.
  { model: 'Wheelbarrow', x: -1.6, z: -8.7, yaw: 0.35, solid: [0.7, 1.5, 0.62] },
  { model: 'Rake', x: -2.1, z: -7.5, yaw: Math.PI / 2, tilt: -0.26 },
  // The mower's station beside the path.
  { model: 'Dock', x: DOCK.x, z: DOCK.z + 0.08, yaw: DOCK.yaw },
  // On the terrace: two planters with grass, a box ball and the watering can beside the outside stair.
  { model: 'Planter', x: 8.6, z: -3.45, yaw: 0, solid: [0.42, 0.42, 0.75] },
  { model: 'Planter', x: 8.6, z: -4.05, yaw: 0, solid: [0.42, 0.42, 0.75] },
  { model: 'BoxPot', x: 2.0, z: -3.45, yaw: 0, solid: [0.48, 0.48, 0.4] },
  { model: 'WateringCan', x: 2.55, z: -3.3, yaw: -0.6 },
];

const [tx, tz] = garden(3.6, 0);
const BUNGALOW: Place[] = [
  // The teak table and four chairs on the paved patch out from the veranda, the parasol over them.
  { model: 'Table', x: tx, z: tz, yaw: FACING_GARDEN, solid: [1.6, 0.9, 0.74], blob: 1.1 },
  ...([-1, 1] as const).flatMap((side) =>
    ([-0.42, 0.42] as const).map((a): Place => {
      const [x, z] = garden(3.6 + side * 0.8, a);
      return { model: 'Chair', x, z, yaw: side > 0 ? FACING_HOUSE : FACING_GARDEN, solid: [0.5, 0.5, 0.45], blob: 0.4 };
    }),
  ),
  { model: 'Parasol', x: tx, z: tz, yaw: 0.3, blob: 1.6 },
  // Two loungers on the lawn, heads to the house; the barbecue by the end of the veranda.
  ...([-2.5, -1.65] as const).map((a): Place => {
    const [x, z] = garden(6.2, a);
    return { model: 'Lounger', x, z, yaw: FACING_HOUSE, solid: [0.65, 1.9, 0.4], blob: 0.9 };
  }),
  { model: 'Barbecue', ...xz(garden(1.6, 2.6)), yaw: FACING_HOUSE + 0.4, solid: [0.62, 0.62, 1.05], blob: 0.45 },
  // Box balls either side of the veranda's steps.
  { model: 'BoxPot', ...xz(garden(0.55, -1.0)), yaw: 0, solid: [0.48, 0.48, 0.4], blob: 0.3 },
  { model: 'BoxPot', ...xz(garden(0.55, 1.0)), yaw: 0, solid: [0.48, 0.48, 0.4], blob: 0.3 },
  // The letterbox where the drive meets the road.
  { model: 'Letterbox', x: 84.43, z: 170.25, yaw: Math.atan2(0.64, -0.77), solid: [0.12, 0.12, 1.35], blob: 0.2 },
];

function xz([x, z]: [number, number]): { x: number; z: number } {
  return { x, z };
}

export class Yard {
  readonly group = new THREE.Group();
  readonly house: THREE.Mesh;
  readonly bungalow: THREE.Mesh;

  constructor(models: Map<string, THREE.Object3D>, world: World, groundY: (x: number, z: number) => number) {
    const shapes = new Map<string, THREE.BufferGeometry>();
    const shape = (p: Place) => {
      const key = `${p.model}${JSON.stringify(p.colors ?? {})}`;
      if (!shapes.has(key)) shapes.set(key, painted(models.get(p.model)!, p.colors));
      return shapes.get(key)!;
    };
    const solids: Prism[] = [];
    const blobs: THREE.BufferGeometry[] = [];
    const build = (places: Place[]) => {
      const parts: THREE.BufferGeometry[] = [];
      for (const p of places) {
        if (!models.has(p.model)) continue;
        const y = groundY(p.x, p.z);
        const m = new THREE.Matrix4().makeRotationY(p.yaw).multiply(new THREE.Matrix4().makeRotationX(p.tilt ?? 0)).setPosition(p.x, y, p.z);
        parts.push(shape(p).clone().applyMatrix4(m));
        if (p.solid) {
          const [w, d, h] = p.solid;
          const c = Math.cos(p.yaw);
          const s = Math.sin(p.yaw);
          const ring = ([[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]] as const).map(([a, b]) => [p.x + a * c + b * s, p.z - a * s + b * c] as [number, number]);
          solids.push({ m: 'yard', y0: y - 0.05, y1: y + h, p: [ring] });
        }
        if (p.blob) blobs.push(new THREE.PlaneGeometry(p.blob * 2, p.blob * 2).rotateX(-Math.PI / 2).translate(p.x, y + 0.02, p.z));
      }
      return parts.length ? mergeGeometries(parts) : new THREE.BufferGeometry();
    };
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });
    this.house = new THREE.Mesh(build(HOUSE), material);
    this.house.castShadow = this.house.receiveShadow = true;
    this.bungalow = new THREE.Mesh(build(BUNGALOW), material);
    this.bungalow.receiveShadow = true;
    for (const m of [this.house, this.bungalow]) {
      m.userData.material = 'steel'; // what a bullet hit looks and sounds like
      this.group.add(m);
    }
    world.addPrisms(solids);

    // Soft dark patches under the bungalow's things: one mesh, a round falloff drawn by its shader.
    if (blobs.length) {
      const patch = new THREE.Mesh(
        mergeGeometries(blobs.map((g) => g.toNonIndexed())),
        new THREE.ShaderMaterial({
          transparent: true,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          vertexShader: /* glsl */ `
            varying vec2 vUv;
            void main() {
              vUv = uv;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
          fragmentShader: /* glsl */ `
            varying vec2 vUv;
            void main() {
              float r = length(vUv - 0.5) * 2.0;
              gl_FragColor = vec4(0.0, 0.0, 0.0, 0.32 * smoothstep(1.0, 0.25, r));
            }`,
        }),
      );
      patch.userData.ignoreRay = true;
      patch.renderOrder = 2;
      this.bungalow.add(patch);
    }
  }
}
