import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const painted = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65 });

/**
 * A model that is turned by its joints (the clowns, the horses): one mesh per joint, its
 * materials' colours painted on the vertices, so it costs one draw call a joint instead of one
 * per material on it. `recolor` gives some materials (by name) another colour, such as a
 * horse's coat. Parts with a texture (the strongman's leopard print) stay as they are.
 */
export function paintJoints(root: THREE.Object3D, joints: string[], recolor: Record<string, THREE.ColorRepresentation> = {}): void {
  root.updateMatrixWorld(true);
  for (const name of joints) {
    const joint = root.getObjectByName(name);
    if (!joint) continue;
    const meshes: THREE.Mesh[] = [];
    const collect = (o: THREE.Object3D) => {
      if (o instanceof THREE.Mesh && !(o.material as THREE.MeshStandardMaterial).map) meshes.push(o);
      for (const c of o.children) if (!joints.includes(c.name)) collect(c);
    };
    collect(joint);
    if (!meshes.length) continue;
    const toJoint = joint.matrixWorld.clone().invert();
    const parts = meshes.map((m) => {
      const g = new THREE.BufferGeometry();
      const src = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
      g.setAttribute('position', src.attributes.position.clone());
      g.setAttribute('normal', src.attributes.normal.clone());
      g.applyMatrix4(toJoint.clone().multiply(m.matrixWorld));
      const mat = m.material as THREE.MeshStandardMaterial;
      const c = new THREE.Color(recolor[mat.name] ?? mat.color ?? '#ffffff');
      const colors = new Float32Array(g.attributes.position.count * 3);
      for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      return g;
    });
    const mesh = new THREE.Mesh(mergeGeometries(parts), painted);
    mesh.castShadow = true;
    mesh.userData.ignoreRay = true;
    for (const m of meshes) {
      if (m === joint) {
        // The joint is itself a mesh: keep it as the node, without its own drawing.
        m.geometry = new THREE.BufferGeometry();
      } else m.removeFromParent();
    }
    joint.add(mesh);
  }
}
