import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * The Zombies game's things made in Blender (tools/zombie_items.py, public/models/zombie-items.glb), for world/rewards.ts:
 * the rewards' signs (an ammo can, a scope, a first-aid bag, a plate carrier, grenades, a weapons crate), the claymore,
 * the turret's tripod and head, the music box and its lid, a stake and a rail. Each mesh is in the frame rewards.ts gives
 * that part. Fetched once, when a game first shows one of them; until then, or if it can't be fetched, rewards.ts
 * draws its own shapes.
 *
 * One material for all (their textures baked on one atlas), lit as the rest, with a little of its own colour glowing so
 * a reward still reads at dusk; and one for what paintball paints, bright paint pink all over (the olive under a tint
 * stays dark).
 */

export type ItemName = 'sign_ammo' | 'sign_scope' | 'sign_medkit' | 'sign_armor' | 'sign_nades' | 'sign_gun' | 'claymore' |
  'turret_legs' | 'turret_head' | 'lull_body' | 'lull_lid' | 'stake' | 'rail';
const NAMES: ItemName[] = ['sign_ammo', 'sign_scope', 'sign_medkit', 'sign_armor', 'sign_nades', 'sign_gun', 'claymore',
  'turret_legs', 'turret_head', 'lull_body', 'lull_lid', 'stake', 'rail'];
const URL = '/models/zombie-items.glb';
/** How much of their own colour glows (an emissive, the texture times this) */
const GLOW = 0.12;
const PAINT = '#ff5fa2';

let job: Promise<boolean> | null = null;
const geos = new Map<ItemName, THREE.BufferGeometry>();
let base: THREE.MeshStandardMaterial | null = null;
let paint: THREE.MeshStandardMaterial | null = null;

/** Fetch the models (once); true once they are in. */
export function loadItemModels(): Promise<boolean> {
  return (job ??= new GLTFLoader().loadAsync(URL).then((gltf) => {
    for (const name of NAMES) {
      const m = gltf.scene.getObjectByName(name) as THREE.Mesh | undefined;
      if (!m?.isMesh) throw new Error(`zombie items: no ${name}`);
      geos.set(name, m.geometry);
      base ??= m.material as THREE.MeshStandardMaterial;
    }
    const b = base!;
    b.emissiveMap = b.map;
    b.emissive.setScalar(GLOW);
    paint = b.clone();
    paint.map = paint.emissiveMap = null;
    paint.color.set(PAINT);
    paint.emissive.set(PAINT).multiplyScalar(GLOW);
    return true;
  }).catch(() => {
    geos.clear();
    return false;
  }));
}

/** Whether the models are in (loadItemModels). */
export const itemsIn = (): boolean => geos.size > 0;

/** A mesh of part `name` (shared geometry and material; `painted`: paint pink), or null before the models are in. */
export function itemMesh(name: ItemName, painted = false): THREE.Mesh | null {
  const g = geos.get(name);
  if (!g || !base || !paint) return null;
  const m = new THREE.Mesh(g, painted ? paint : base);
  m.castShadow = true;
  m.receiveShadow = true;
  m.userData.ignoreRay = true;
  return m;
}

/** The shared geometry and material of part `name` (the rows of stakes, instanced), or null before the models are in. */
export function itemParts(name: ItemName): { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial } | null {
  const g = geos.get(name);
  return g && base ? { geometry: g, material: base } : null;
}
