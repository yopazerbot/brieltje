import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { World } from './collision';
import type { PropSpec } from './houseData';
import { mirrorRoom } from './mirrorLook';

/**
 * Fixed things in the house made in Blender (the coffee machine in its niche, the
 * toilets, the bath, the basins and their taps): loaded with their own materials and put
 * where the house data says. A solid one blocks the way with its outline on the floor. A
 * model file can hold several pieces (fittings.glb: the bath, the basins, the taps and the
 * rest), each at the file's origin: `part` names the one to place, and the file is fetched
 * once for all of them.
 */
export function loadProps(specs: PropSpec[], scene: THREE.Scene, world: World, tag = ''): void {
  const loader = new GLTFLoader();
  const cache = new Map<string, Promise<THREE.Group>>();
  specs.forEach((s, i) => {
    if (!cache.has(s.model)) cache.set(s.model, loader.loadAsync(`/models/${s.model}.glb`).then((g) => g.scene));
    cache.get(s.model)!.then((model) => {
      const piece = s.part ? model.getObjectByName(s.part) : model;
      if (!piece) return; // a part the file doesn't have: nothing there
      const prop = piece.clone();
      prop.position.set(s.x, s.y, s.z);
      prop.rotation.y = s.yaw;
      prop.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.castShadow = o.receiveShadow = true;
        o.userData.material = s.hit ?? 'steel'; // what a bullet hit looks and sounds like
        // A mirror's glass (named so in the model, tools/fittings.py) shows a room (world/mirrorLook.ts).
        const m = o.material as THREE.MeshStandardMaterial;
        if (m.name === 'Mirror' && m.isMeshStandardMaterial) mirrorRoom(m);
      });
      scene.add(prop);
      if (!s.solid) return;
      prop.updateMatrixWorld(true);
      const local = new THREE.Box3().setFromObject(piece);
      const c = Math.cos(s.yaw);
      const n = Math.sin(s.yaw);
      const ring = ([[local.min.x, local.min.z], [local.max.x, local.min.z], [local.max.x, local.max.z], [local.min.x, local.max.z]] as const).map(
        ([x, z]) => [s.x + x * c + z * n, s.z - x * n + z * c] as [number, number],
      );
      world.setMoving(`prop-${tag}${i}`, ring, s.y, s.y + local.max.y);
    }, () => {}); // missing model: nothing there
  });
}
