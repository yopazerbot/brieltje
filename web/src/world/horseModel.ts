import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';

/**
 * The horse's model (horse.glb), fetched once for the herd (world/horses.ts) and Sinterklaas's grey
 * (world/sinterklaas.ts). Each gets a copy of its own to paint and pose; the copies share the model's
 * shapes until they are painted.
 */
let job: Promise<GLTF> | null = null;
export function horseModel(): Promise<THREE.Object3D> {
  return (job ??= new GLTFLoader().loadAsync('/models/horse.glb')).then((gltf) => gltf.scene.clone(true));
}
