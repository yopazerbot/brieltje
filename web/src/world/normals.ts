import * as THREE from 'three';

/**
 * A geometry's vertex normals, none of them of zero length.
 *
 * three.js leaves a corner's normal at zero when the triangles round it add up to nothing: triangles with no area
 * (an outline cut along the ground's grid, a corner the open data repeats) or two faces of one strip back to back.
 * The lighting normalises the normal for every pixel, and a normal of no length gives NaN. A pixel on such a
 * triangle came out NaN in the scene's picture: on an Apple chip a black row along the far edge of the ground,
 * flickering just under the sky as the eye moved. The output pass can't be trusted to catch it (Metal may compile
 * with fast maths, which assumes there is no NaN). So such a corner takes the normal of the other corners of its
 * triangle, or straight up when they have none either (these are ground surfaces and the tops of blocks). Normals
 * that were fine stay as they are.
 */
export function solidNormals(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!g.attributes.normal) g.computeVertexNormals();
  const n = g.attributes.normal as THREE.BufferAttribute;
  const a = n.array;
  const zero = (i: number) => a[i * 3] === 0 && a[i * 3 + 1] === 0 && a[i * 3 + 2] === 0;
  let any = false;
  for (let i = 0; i < n.count && !any; i++) any = zero(i);
  if (!any) return g;
  const index = g.index;
  const at = (k: number) => (index ? index.getX(k) : k);
  const corners = index ? index.count : n.count;
  const sum = new THREE.Vector3();
  const fixes: number[] = [];
  for (let t = 0; t + 2 < corners; t += 3) {
    const tri = [at(t), at(t + 1), at(t + 2)];
    if (!zero(tri[0]) && !zero(tri[1]) && !zero(tri[2])) continue;
    sum.set(0, 0, 0);
    for (const v of tri) if (!zero(v)) sum.x += a[v * 3], sum.y += a[v * 3 + 1], sum.z += a[v * 3 + 2];
    if (sum.lengthSq() < 1e-8) sum.set(0, 1, 0);
    sum.normalize();
    for (const v of tri) if (zero(v)) fixes.push(v, sum.x, sum.y, sum.z);
  }
  // Set once every triangle is seen, so a corner just fixed doesn't pass for a good one.
  for (let k = 0; k < fixes.length; k += 4) n.setXYZ(fixes[k], fixes[k + 1], fixes[k + 2], fixes[k + 3]);
  for (let i = 0; i < n.count; i++) if (zero(i)) n.setXYZ(i, 0, 1, 0); // used by no triangle: never drawn
  n.needsUpdate = true;
  return g;
}
