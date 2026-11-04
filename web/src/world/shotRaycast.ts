import * as THREE from 'three';

interface Branch { box: THREE.Box3; left?: Branch; right?: Branch; mesh?: THREE.Mesh; faces?: number[] }
const prepared = new WeakSet<THREE.Mesh>();

/** Index static map triangles during loading, never on the first trigger pull. */
export function prepareShotMesh(mesh: THREE.Mesh): boolean {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  const count = geometry.index?.count ?? position?.count ?? 0;
  if (prepared.has(mesh) || !position || count < 6000 ||
      (mesh as THREE.SkinnedMesh).isSkinnedMesh || (mesh as THREE.InstancedMesh).isInstancedMesh ||
      Array.isArray(mesh.material) || Object.keys(geometry.morphAttributes).length ||
      ('usage' in position ? position.usage : position.data.usage) !== THREE.StaticDrawUsage ||
      mesh.raycast !== THREE.Mesh.prototype.raycast) return false;
  const vertex = (i: number) => geometry.index ? geometry.index.getX(i) : i;
  const centres = new Float32Array(Math.floor(count / 3) * 3);
  const point = new THREE.Vector3();
  const faces = Array.from({ length: Math.floor(count / 3) }, (_, i) => i);
  for (const face of faces) {
    for (let axis = 0; axis < 3; axis++) {
      let sum = 0;
      for (let j = 0; j < 3; j++) sum += position.getComponent(vertex(face * 3 + j), axis);
      centres[face * 3 + axis] = sum / 3;
    }
  }
  const build = (ids: number[], depth = 0): Branch => {
    const box = new THREE.Box3();
    for (const face of ids) for (let j = 0; j < 3; j++) box.expandByPoint(point.fromBufferAttribute(position, vertex(face * 3 + j)));
    const size = box.getSize(new THREE.Vector3());
    const axis = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2;
    const middle = (box.min.getComponent(axis) + box.max.getComponent(axis)) / 2;
    if (ids.length > 128 && depth < 24) {
      const left: number[] = [], right: number[] = [];
      for (const face of ids) (centres[face * 3 + axis] < middle ? left : right).push(face);
      if (left.length && right.length) return { box, left: build(left, depth + 1), right: build(right, depth + 1) };
    }
    const part = new THREE.BufferGeometry();
    // Share vertex attributes: only the small triangle-index lists are new. Nothing is rendered.
    for (const [name, attribute] of Object.entries(geometry.attributes)) part.setAttribute(name, attribute);
    part.setIndex(ids.flatMap((face) => [vertex(face * 3), vertex(face * 3 + 1), vertex(face * 3 + 2)]));
    part.boundingBox = box;
    part.computeBoundingSphere();
    return { box, mesh: new THREE.Mesh(part, mesh.material), faces: ids };
  };
  const tree = build(faces);
  const inverse = new THREE.Matrix4(), localRay = new THREE.Ray();
  const hits: THREE.Intersection[] = [];
  mesh.raycast = (raycaster, intersections) => {
    const start = Math.max(0, geometry.drawRange.start);
    const end = Math.min(count, geometry.drawRange.start + geometry.drawRange.count);
    if (end <= start) return;
    if (start % 3 || (Number.isFinite(end) && end % 3)) {
      THREE.Mesh.prototype.raycast.call(mesh, raycaster, intersections);
      return;
    }
    inverse.copy(mesh.matrixWorld).invert();
    localRay.copy(raycaster.ray).applyMatrix4(inverse);
    const visit = (node: Branch) => {
      if (!localRay.intersectsBox(node.box)) return;
      if (node.left && node.right) { visit(node.left); visit(node.right); return; }
      const part = node.mesh!;
      part.material = mesh.material;
      part.matrixWorld.copy(mesh.matrixWorld);
      hits.length = 0;
      part.raycast(raycaster, hits);
      for (const hit of hits) {
        const faceIndex = node.faces![hit.faceIndex!];
        // Tiles alter their draw range as the camera moves: never hit a hidden triangle.
        if (faceIndex * 3 < start || faceIndex * 3 >= end) continue;
        hit.object = mesh;
        hit.faceIndex = faceIndex;
        intersections.push(hit);
      }
    };
    visit(tree);
  };
  prepared.add(mesh);
  return true;
}

export async function prepareShotRaycasts(root: THREE.Object3D): Promise<void> {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  for (const mesh of meshes) {
    if (prepareShotMesh(mesh)) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
