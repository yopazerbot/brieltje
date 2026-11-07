import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * One connected canopy, with broad branch lobes and, on the full shape, smaller clusters of leaves on
 * them, with dips between: the outline breaks up into clusters instead of a smooth ball. Lighter
 * underneath than before (the sky's light comes through and between the leaves).
 */
export function treeCrown(seed: number, simple = false): THREE.BufferGeometry {
  let state = seed;
  const random = () => ((state = (state * 16807) % 2147483647) / 2147483647);
  const phase = random() * Math.PI * 2;
  const lobes = Array.from({ length: 7 }, (_, i) => {
    const a = phase + i * 2.39996;
    const y = -0.3 + random() * 1.05;
    const r = Math.sqrt(1 - y * y);
    return new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
  });
  // Clusters of leaves, about 20 degrees across, all over: only the full shape has the corners to show them.
  const clusters = Array.from({ length: simple ? 0 : 22 }, () => {
    const y = random() * 1.7 - 0.85;
    const a = random() * Math.PI * 2;
    const r = Math.sqrt(1 - y * y);
    return new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
  });
  // 980 triangles near, 180 far: no more than the old compound crowns.
  const source = new THREE.IcosahedronGeometry(1, simple ? 2 : 6);
  source.deleteAttribute('uv');
  source.deleteAttribute('normal');
  const geometry = mergeVertices(source);
  source.dispose();
  const pos = geometry.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const direction = new THREE.Vector3();
  const light = new THREE.Color('#677748');
  const dark = new THREE.Color('#2f4426');
  const color = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    direction.fromBufferAttribute(pos, i).normalize();
    let radius = 0.73;
    for (const lobe of lobes) radius += 0.19 * Math.pow(Math.max(0, direction.dot(lobe)), 7);
    let cluster = 0;
    for (const c of clusters) cluster = Math.max(cluster, Math.pow(Math.max(0, direction.dot(c)), 40));
    // Clusters stand out a little; between them the surface dips back towards the branches.
    radius += clusters.length ? 0.06 * cluster - 0.025 : 0;
    radius += 0.045 * Math.sin(direction.x * 5 + phase) * Math.sin(direction.z * 4 - phase);
    // Unequal shoulders and a tapered lower crown leave visible branch structure, not a ball on a pole.
    const lower = direction.y < -0.25 ? 1 + (direction.y + 0.25) * 0.18 : 1;
    const x = direction.x * radius * lower * 1.23;
    const y = direction.y * radius * 1.04 + 0.035 * Math.sin(direction.x * 3 + phase);
    const z = direction.z * radius * lower * 1.15;
    pos.setXYZ(i, x, y, z);
    // Darker deep in the dips, lighter on the clusters; underneath not as dark as before: the sky's light
    // comes through and between the leaves.
    const sky = THREE.MathUtils.smoothstep(direction.y, -0.8, 0.85);
    const patch = 0.96 + 0.04 * Math.sin(direction.x * 4 + direction.z * 3 + phase);
    const depth = clusters.length ? 0.88 + 0.16 * cluster : 1;
    color.copy(dark).lerp(light, 0.42 + sky * 0.58).multiplyScalar(patch * depth);
    colors.set([color.r, color.g, color.b], i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * A flared foot, a trunk that leans and bends a little (each tree is turned its own way, so they lean every
 * which way), two tapering forks into the crown and a lower bough below it, all in the same bark draw.
 */
export function treeTrunk(): THREE.BufferGeometry {
  // Open: the foot stands in the ground and the top in the crown.
  const stem = new THREE.CylinderGeometry(0.035, 0.1, 1, 7, 3, true).translate(0, 0.5, 0);
  const pos = stem.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const flare = 1 + 0.3 * Math.pow(1 - y, 6);
    pos.setXYZ(i, pos.getX(i) * flare + 0.07 * Math.sin(y * 2.5) * y + 0.045 * y * y,
      y, pos.getZ(i) * flare + 0.035 * Math.sin(y * 4) * y);
  }
  stem.computeVertexNormals();
  const parts = [stem];
  const bough = (a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number) => {
    const branch = new THREE.CylinderGeometry(r1, r0, a.distanceTo(b), 3, 1, true);
    branch.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
    branch.translate(...a.clone().add(b).multiplyScalar(0.5).toArray());
    parts.push(branch);
  };
  for (const sign of [-1, 1]) bough(new THREE.Vector3(0.05, 0.58 + sign * 0.05, 0), new THREE.Vector3(sign * 0.65, 1.12, sign * 0.22), 0.045, 0.012);
  bough(new THREE.Vector3(0.03, 0.44, 0), new THREE.Vector3(-0.2, 0.74, 0.55), 0.03, 0.008);
  const geometry = mergeGeometries(parts);
  parts.forEach((part) => part.dispose());
  const vertices = geometry.getAttribute('position');
  const colors = new Float32Array(vertices.count * 3);
  for (let i = 0; i < vertices.count; i++) {
    const shade = 1 - 0.5 * THREE.MathUtils.smoothstep(vertices.getY(i), 0.3, 1.1);
    colors.fill(shade, i * 3, i * 3 + 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}
