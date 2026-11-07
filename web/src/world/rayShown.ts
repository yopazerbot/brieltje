import type * as THREE from 'three';

/**
 * Whether a ray's hit is on something drawn. three's raycast skips hidden objects but not hidden materials, and the
 * trees are built twice (leaf cards and smooth crowns, world/leafCards.ts switchTrees), the version not shown hidden
 * by its material: without this a shot stopped on a crown nobody could see.
 */
export function drawn(o: THREE.Object3D): boolean {
  if (!o.visible) return false;
  const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
  if (!m) return true;
  return Array.isArray(m) ? m.some((x) => x.visible) : m.visible;
}
