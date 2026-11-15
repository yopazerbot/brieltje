// The trees' trunks as blocks (Yoshi, 15 Nov 2026: "bugs like walking through trees"): one thin upright block per drawn
// tree, from the same data the trees are drawn from (village.json's and the ring's `trees`, the street models'
// conifers), as wide and as high as its drawn trunk. On the page they stop walking, riding, horses, cars and grenades
// and are never a floor (world/collision.ts: a block named `trunk`); the zombies walk round them at every place, alone
// and together (shared/arenas.mjs, server/game.mjs). The crowns and the branches stay air: a spruce's or a shrub's
// branches to the ground too.

/** m: a trunk's block starts this far under the tree's foot (the ground's slope under it) */
const FOOT = -0.3;
/** m: the zombies' trunks reach this high, over the highest floor among the trees (the tree huts): never a step */
export const ZOMBIE_TRUNK_TOP = 12;

/**
 * m: a trunk's half width at chest height, 12 to 35 cm: the drawn trunk's (world/surroundings.ts buildTrees: girth
 * max(1, h / 6.5), 10 cm at chest height for a girth of 1), for a tree `h` m tall.
 */
export function trunkRadius(h) {
  return Math.min(0.35, Math.max(0.12, 0.1 * Math.max(1, h / 6.5)));
}

/** m over its foot: how high the drawn trunk goes up into its crown (world/surroundings.ts buildTrees), at least 2 m. */
export function trunkHeight(t) {
  const crownR = Math.min(7, Math.max(t.r ?? 0, t.h * 0.26));
  const crownH = Math.min(t.h * 0.75, Math.max(crownR * 2.2, t.h * 0.6));
  return Math.max(2, t.h - crownH * 0.6);
}

const round = (v) => Math.round(v * 1000) / 1000;

/**
 * One block per tree, in the trees' order (`trees`: { x, y, z, h, r }, y its foot in the game's heights, as drawn):
 * an octagon round its foot, named `trunk`, from its foot (a tree in a ditch or a pond's bank too) up to its crown.
 * `top`: how high over its foot for all (the zombies'), else each as high as its drawn trunk.
 */
export function trunkPrisms(trees, top) {
  return trees.map((t) => {
    const r = trunkRadius(t.h);
    const ring = [];
    for (let k = 0; k < 8; k++) {
      const a = ((k + 0.5) / 8) * Math.PI * 2;
      ring.push([round(t.x + Math.cos(a) * r), round(t.z + Math.sin(a) * r)]);
    }
    return { m: 'oak', n: 'trunk', y0: Math.round((t.y + FOOT) * 100) / 100, y1: Math.round((t.y + (top ?? trunkHeight(t))) * 100) / 100, p: [ring] };
  });
}

/** The trunks within `box` (minX, maxX, minZ, maxZ; 2 m more) for the zombies' grid, ZOMBIE_TRUNK_TOP over their foot. */
export function zombieTrunks(trees, box) {
  const near = trees.filter((t) => t.x >= box.minX - 2 && t.x <= box.maxX + 2 && t.z >= box.minZ - 2 && t.z <= box.maxZ + 2);
  return trunkPrisms(near, ZOMBIE_TRUNK_TOP);
}
