import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { World } from './collision';
import type { PropSpec } from './houseData';

/**
 * Fixed things in the house made in Blender (the coffee machine in its niche, the
 * toilets): loaded with their own materials and put where the house data says. A solid
 * one blocks the way with its outline on the floor.
 */
export function loadProps(specs: PropSpec[], scene: THREE.Scene, world: World): void {
  const loader = new GLTFLoader();
  const cache = new Map<string, Promise<THREE.Group>>();
  specs.forEach((s, i) => {
    if (!cache.has(s.model)) cache.set(s.model, loader.loadAsync(`/models/${s.model}.glb`).then((g) => g.scene));
    cache.get(s.model)!.then((model) => {
      const prop = model.clone();
      prop.position.set(s.x, s.y, s.z);
      prop.rotation.y = s.yaw;
      prop.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.castShadow = o.receiveShadow = true;
        o.userData.material = s.hit ?? 'steel'; // what a bullet hit looks and sounds like
      });
      scene.add(prop);
      if (!s.solid) return;
      prop.updateMatrixWorld(true);
      const local = new THREE.Box3().setFromObject(model);
      const c = Math.cos(s.yaw);
      const n = Math.sin(s.yaw);
      const ring = ([[local.min.x, local.min.z], [local.max.x, local.min.z], [local.max.x, local.max.z], [local.min.x, local.max.z]] as const).map(
        ([x, z]) => [s.x + x * c + z * n, s.z - x * n + z * c] as [number, number],
      );
      world.setMoving(`prop-${i}`, ring, s.y, s.y + local.max.y);
    }, () => {}); // missing model: nothing there
  });
}
