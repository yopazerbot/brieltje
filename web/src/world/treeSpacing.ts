/**
 * Keeps garden trees from growing into each other or into hedges and walls. Pure maths, no THREE:
 * the same trees give the same answer on every visit (tallest first, ties by place).
 */
export interface SpacedTree { x: number; z: number; y: number; h: number; r: number }
/** A tall block (hedge, wall): its footprint ring and its height above the ground. */
export interface TreeObstacle { ring: [number, number][]; height: number }

/** The widest a crown reaches from its trunk, per metre of `crownR` (stretch 1.12 x lobes 1.23 x radius). */
export const CROWN_REACH = 1.2;
/** A crown may shrink to this share of its size; below it the tree is left out. */
export const MIN_CROWN_SHARE = 0.55;
/** Clear space kept between a crown and a hedge or wall, in metres. */
export const CROWN_MARGIN = 0.15;

/** Distance from a point to a ring: 0 when inside it. */
export function distanceToRing(x: number, z: number, ring: [number, number][]): number {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[j];
    const [bx, bz] = ring[i];
    if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) inside = !inside;
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
  }
  return inside ? 0 : best;
}

/**
 * For each tree, the share (0 to 1) of its crown to keep: 1 when nothing is in the way, less when
 * a neighbour's crown or a hedge or wall is close, 0 when it would have to shrink too far (drop it).
 * `crownR(t)` and `crownBottom(t)` (height of the crown's underside above the ground) come from the caller.
 */
export function spaceTrees(
  trees: readonly SpacedTree[],
  obstacles: readonly TreeObstacle[],
  crownR: (t: SpacedTree) => number,
  crownBottom: (t: SpacedTree) => number,
): number[] {
  const order = trees.map((_, i) => i).sort((a, b) => trees[b].h - trees[a].h || trees[a].x - trees[b].x || trees[a].z - trees[b].z);
  const share = new Array<number>(trees.length).fill(1);
  const kept: number[] = [];
  for (const i of order) {
    const t = trees[i];
    const reach = crownR(t) * CROWN_REACH;
    let s = 1;
    for (const o of obstacles) {
      if (o.height <= crownBottom(t)) continue; // the crown is above it
      s = Math.min(s, (distanceToRing(t.x, t.z, o.ring) - CROWN_MARGIN) / reach);
    }
    for (const j of kept) {
      const u = trees[j];
      const room = Math.hypot(t.x - u.x, t.z - u.z) - crownR(u) * CROWN_REACH * share[j];
      s = Math.min(s, room / reach);
    }
    s = Math.min(1, s);
    share[i] = s < MIN_CROWN_SHARE ? 0 : s;
    if (share[i] > 0) kept.push(i);
  }
  return share;
}
