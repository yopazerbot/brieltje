import * as THREE from 'three';

const prepared = new WeakSet<THREE.Mesh>();
/** Faces in a leaf of the tree, and how deep it goes, as before. */
const LEAF = 128;
const DEPTH = 24;
/** Steps of work between the points where a slice may stop (a yield every so many faces). */
const STEP = 8192;

/**
 * A big static mesh's shot index (a tree of boxes over its triangles), so a shot tests a few hundred of them, not
 * all. Built as a job that can stop between small steps (prepareShotRaycasts runs it in idle slices after play has
 * begun); the mesh keeps three's own raycast until the job is done, so a shot before then still hits.
 *
 * Kept in typed arrays: the faces in leaf order (one permuted list), each node's box, its two children or its run of
 * faces. A leaf is searched by three's own raycast on a stand-in geometry over that one permuted list of triangles,
 * drawn from the leaf's start for its count, so every hit carries exactly what three's would.
 */
function* indexJob(mesh: THREE.Mesh): Generator<void, boolean> {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  const count = geometry.index?.count ?? position?.count ?? 0;
  if (prepared.has(mesh) || !position || count < 6000 ||
      (mesh as THREE.SkinnedMesh).isSkinnedMesh || (mesh as THREE.InstancedMesh).isInstancedMesh ||
      Array.isArray(mesh.material) || Object.keys(geometry.morphAttributes).length ||
      ('usage' in position ? position.usage : position.data.usage) !== THREE.StaticDrawUsage ||
      mesh.raycast !== THREE.Mesh.prototype.raycast) return false;
  const index = geometry.index;
  const vertex = index ? (i: number) => index.getX(i) : (i: number) => i;
  const faces = Math.floor(count / 3);
  // Each face's bounds and centre, once (the tree's boxes are made from these, not from the vertices again).
  const lo = new Float32Array(faces * 3);
  const hi = new Float32Array(faces * 3);
  const mid = new Float32Array(faces * 3);
  for (let f = 0; f < faces; f++) {
    for (let axis = 0; axis < 3; axis++) {
      const a = position.getComponent(vertex(f * 3), axis);
      const b = position.getComponent(vertex(f * 3 + 1), axis);
      const c = position.getComponent(vertex(f * 3 + 2), axis);
      lo[f * 3 + axis] = Math.min(a, b, c);
      hi[f * 3 + axis] = Math.max(a, b, c);
      mid[f * 3 + axis] = (a + b + c) / 3;
    }
    if (f % STEP === STEP - 1) yield;
  }
  const order = new Uint32Array(faces);
  for (let f = 0; f < faces; f++) order[f] = f;
  // Nodes: a box (6 floats), then left and right child (-1 for a leaf) and the run of faces in `order`.
  let boxes = new Float32Array(6 * 64);
  let links = new Int32Array(4 * 64);
  let nodes = 0;
  const node = (start: number, size: number) => {
    if (nodes * 6 >= boxes.length) {
      const b = new Float32Array(boxes.length * 2);
      b.set(boxes);
      boxes = b;
      const l = new Int32Array(links.length * 2);
      l.set(links);
      links = l;
    }
    links.set([-1, -1, start, size], nodes * 4);
    return nodes++;
  };
  const todo: [number, number][] = [[node(0, faces), 0]];
  let work = 0;
  while (todo.length) {
    const [n, depth] = todo.pop()!;
    const start = links[n * 4 + 2];
    const size = links[n * 4 + 3];
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let k = start; k < start + size; k++) {
      const f = order[k] * 3;
      for (let axis = 0; axis < 3; axis++) {
        if (lo[f + axis] < box[axis]) box[axis] = lo[f + axis];
        if (hi[f + axis] > box[axis + 3]) box[axis + 3] = hi[f + axis];
      }
      if (++work % STEP === 0) yield;
    }
    boxes.set(box, n * 6);
    if (size <= LEAF || depth >= DEPTH) continue;
    const sx = box[3] - box[0];
    const sy = box[4] - box[1];
    const sz = box[5] - box[2];
    const axis = sx >= sy && sx >= sz ? 0 : sy >= sz ? 1 : 2;
    const middle = (box[axis] + box[axis + 3]) / 2;
    // Split in place round the middle of the longest side (the faces left of it first).
    let i = start;
    let j = start + size - 1;
    while (i <= j) {
      if (mid[order[i] * 3 + axis] < middle) i++;
      else {
        const t = order[i];
        order[i] = order[j];
        order[j--] = t;
      }
      if (++work % STEP === 0) yield;
    }
    const left = i - start;
    if (left === 0 || left === size) continue; // all on one side: a leaf as it is
    const l = node(start, left);
    const r = node(i, size - left);
    links[n * 4] = l;
    links[n * 4 + 1] = r;
    todo.push([r, depth + 1], [l, depth + 1]);
  }
  // The mesh may have changed while the job waited between slices: then it keeps three's raycast.
  if (mesh.geometry !== geometry || mesh.raycast !== THREE.Mesh.prototype.raycast || Array.isArray(mesh.material)) return false;
  // The triangles in leaf order: the stand-in's index (the vertices are the mesh's own, shared: nothing is rendered).
  const triangles = new Uint32Array(faces * 3);
  for (let k = 0; k < faces; k++) {
    const f = order[k] * 3;
    triangles[k * 3] = vertex(f);
    triangles[k * 3 + 1] = vertex(f + 1);
    triangles[k * 3 + 2] = vertex(f + 2);
    if (k % STEP === STEP - 1) yield;
  }
  if (mesh.geometry !== geometry || mesh.raycast !== THREE.Mesh.prototype.raycast || Array.isArray(mesh.material)) return false;
  const part = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(geometry.attributes)) part.setAttribute(name, attribute);
  part.setIndex(new THREE.BufferAttribute(triangles, 1));
  // Set per leaf from its box, never computed: computeBoundingSphere() would walk all the shared vertices.
  part.boundingBox = new THREE.Box3();
  part.boundingSphere = new THREE.Sphere();
  const stand = new THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>(part, mesh.material);
  const tree = { boxes: boxes.slice(0, nodes * 6), links: links.slice(0, nodes * 4) };
  const inverse = new THREE.Matrix4(), localRay = new THREE.Ray(), test = new THREE.Box3();
  const hits: THREE.Intersection[] = [];
  const stack: number[] = [];
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
    stack.length = 0;
    stack.push(0);
    while (stack.length) {
      const n = stack.pop()!;
      const b = tree.boxes;
      test.min.set(b[n * 6], b[n * 6 + 1], b[n * 6 + 2]);
      test.max.set(b[n * 6 + 3], b[n * 6 + 4], b[n * 6 + 5]);
      if (!localRay.intersectsBox(test)) continue;
      const left = tree.links[n * 4];
      if (left >= 0) {
        stack.push(tree.links[n * 4 + 1], left);
        continue;
      }
      part.boundingBox!.copy(test);
      test.getBoundingSphere(part.boundingSphere!);
      part.setDrawRange(tree.links[n * 4 + 2] * 3, tree.links[n * 4 + 3] * 3);
      stand.material = mesh.material;
      stand.matrixWorld.copy(mesh.matrixWorld);
      hits.length = 0;
      stand.raycast(raycaster, hits);
      for (const hit of hits) {
        const faceIndex = order[hit.faceIndex!];
        // Tiles alter their draw range as the camera moves: never hit a hidden triangle.
        if (faceIndex * 3 < start || faceIndex * 3 >= end) continue;
        hit.object = mesh;
        hit.faceIndex = faceIndex;
        intersections.push(hit);
      }
    }
  };
  prepared.add(mesh);
  return true;
}

/** Index one static map mesh at once (false: it keeps three's own raycast). */
export function prepareShotMesh(mesh: THREE.Mesh): boolean {
  const job = indexJob(mesh);
  for (;;) {
    const step = job.next();
    if (step.done) return step.value;
  }
}

/**
 * Index every big static mesh under `root` in idle slices of a few milliseconds (after play has begun: it took 1.4 s
 * of loading at once). Each mesh keeps three's raycast until its own index is done.
 */
export async function prepareShotRaycasts(root: THREE.Object3D, sliceMs = 4): Promise<void> {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  const idle = () => new Promise<number>((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback((d) => resolve(d.timeRemaining()), { timeout: 100 });
    else setTimeout(() => resolve(0), 0);
  });
  let until = performance.now() + sliceMs;
  for (const mesh of meshes) {
    const job = indexJob(mesh);
    while (!job.next().done) {
      if (performance.now() < until) continue;
      const spare = await idle();
      until = performance.now() + Math.min(sliceMs, Math.max(spare - 1, 2));
    }
  }
}
