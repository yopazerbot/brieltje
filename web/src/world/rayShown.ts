import type * as THREE from 'three';

/**
 * The materials of the trees that are built twice (leaf cards and smooth crowns, world/leafCards.ts `enlist`): the
 * version not shown is hidden by its material, which three's raycast doesn't look at.
 */
export const swappedMaterials = new WeakSet<THREE.Material>();

/**
 * Whether a ray's hit is on something drawn: not on a hidden object, nor on a tree whose other version is shown (a
 * shot stopped on a crown nobody could see). Only those trees' materials count: a hit box (a zombie's, a player's, a
 * clown's, a cat's) and a pane's stand-in are invisible on purpose and must still be hit.
 */
export function drawn(o: THREE.Object3D): boolean {
  if (!o.visible) return false;
  const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
  if (!m) return true;
  const hidden = (x: THREE.Material) => swappedMaterials.has(x) && !x.visible;
  return Array.isArray(m) ? !m.every(hidden) : !hidden(m);
}
