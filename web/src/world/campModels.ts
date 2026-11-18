import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Attack and defend's field camp models (tools/camp.py, one GLB fetched once): the canvas tent and the camp's supply
 * truck, each near and far, for world/assaultCamp.ts to merge into the camp; and the spawn truck, a car of world/car.ts
 * (world/truck.ts). The props' colour is on their corners, the shade and the dirt baked in; their "Team" parts carry only
 * the shade, and the camp multiplies in the team's colour.
 */

/** A prop's parts in its own frame (its front along -z, the ground at y = 0): position, normal and colour (3 floats). */
export interface CampProp {
  parts: { geometry: THREE.BufferGeometry; team: boolean }[];
}

export interface CampModels {
  tent: CampProp;
  tentFar: CampProp;
  supply: CampProp;
  supplyFar: CampProp;
  /** The spawn truck as the cars' models are: material names, pivots Wheel_FL ... Wheel_RR at the axles, "Far" */
  spawnTruck: THREE.Group;
}

/** One prop out of the scene: each mesh's geometry in the prop's frame, with only what the camp's merge needs. */
function prop(scene: THREE.Object3D, name: string): CampProp {
  const root = scene.getObjectByName(name);
  if (!root) throw new Error(`camp.glb: no ${name}`);
  const toRoot = root.matrixWorld.clone().invert();
  const parts: CampProp['parts'] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const src = o.geometry as THREE.BufferGeometry;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', src.attributes.position.clone());
    g.setAttribute('normal', src.attributes.normal.clone());
    const n = src.attributes.position.count;
    const c = src.attributes.color;
    const rgb = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) rgb.set(c ? [c.getX(i), c.getY(i), c.getZ(i)] : [1, 1, 1], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    if (src.index) g.setIndex(src.index.clone());
    g.applyMatrix4(toRoot.clone().multiply(o.matrixWorld));
    parts.push({ geometry: g, team: (o.material as THREE.Material).name === 'Team' });
  });
  return { parts };
}

let job: Promise<CampModels> | null = null;

/** The camp's models, fetched and parsed the first time they are asked for. */
export function campModels(): Promise<CampModels> {
  return (job ??= new GLTFLoader().loadAsync('/models/camp.glb').then((gltf) => {
    const scene = gltf.scene;
    scene.updateMatrixWorld(true);
    const spawnTruck = scene.getObjectByName('SpawnTruck') as THREE.Group | undefined;
    if (!spawnTruck) throw new Error('camp.glb: no SpawnTruck');
    const models = { tent: prop(scene, 'Tent'), tentFar: prop(scene, 'TentFar'), supply: prop(scene, 'SupplyTruck'), supplyFar: prop(scene, 'SupplyTruckFar'), spawnTruck };
    spawnTruck.removeFromParent();
    return models;
  }));
}
