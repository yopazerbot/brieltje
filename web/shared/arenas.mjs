// Where the Zombies game is played, shared by the server (together, the admin picks) and the page (alone,
// you pick, in the Play tab). Each place is by a portal (shared/portals.mjs) and has an edge that holds
// while the game runs, as bounds.json's `party` does round the two houses.
//
// - `house` and `bungalow`: the party area round the two houses, the houses open together (their floors
//   in the zombies' grid); starting at the bungalow is the same game from its side.
// - In Smetlede: a circle of `radius` m round `center` (a little off the portal, round its square or
//   its stretch of street), each point pulled in to stay 2 m inside the map's edge. The village's own
//   blocks, hedges and fences are the zombies' walls there, its buildings shut.
// - `sparrenhof`: the café at the edge of the wood, a circle as in Smetlede. The horde comes out deep among the
//   trees (`woods`) and walks out between their trunks; the café's outside stairs and roofs, and the tree huts in the
//   wood round it, are in the zombies' grid.
// - Not the school: nobody shoots on its grounds (shared/zones.mjs), and the church's circle stops
//   short of them.

import { makeBounds } from './bounds.mjs';
import { churchPrisms } from './church.mjs';
import { PORTALS } from './portals.mjs';
import { cafePrisms, woodSpots, woodTrunks } from './sparrenhof.mjs';

export const ARENAS = [
  { id: 'house', home: [4.5, 18] },
  { id: 'bungalow', home: [97, 172] },
  { id: 'church', center: [548, -768], radius: 48 },
  { id: 'molenhoek', center: [758, -712], radius: 48 },
  { id: 'molenhoek_mid', center: [1062, -567], radius: 48 },
  { id: 'molenhoek_end', center: [1510, -363], radius: 48 },
  // The café at the edge of the wood (Yoshi, 7 Nov 2026): the horde comes out from among the trees round it, and its
  // stairs to the roofs are the zombies' too (shared/sparrenhof.mjs).
  { id: 'sparrenhof', center: [662, 952], radius: 48, woods: true },
];

/** The place `id`, or home (an unknown or forged id plays at home). */
export function arenaOf(id) {
  return ARENAS.find((a) => a.id === id) ?? ARENAS[0];
}

/** Its portal. */
export function portalOf(a) {
  return PORTALS.find((p) => p.id === a.id);
}

/** Its edge (a Bounds): the party area's at home, else the circle, kept inside the map's edge (`edges`: { map, party }). */
export function arenaEdge(a, edges) {
  if (!a.center) return edges.party;
  const [cx, cz] = a.center;
  const ring = [];
  for (let k = 0; k < 40; k++) {
    const t = (k / 40) * Math.PI * 2;
    let r = a.radius;
    while (r > 5 && edges.map.depth(cx + Math.sin(t) * r, cz + Math.cos(t) * r) < 2) r -= 1;
    ring.push([Math.round((cx + Math.sin(t) * r) * 100) / 100, Math.round((cz + Math.cos(t) * r) * 100) / 100]);
  }
  return makeBounds(ring);
}

/** Where the horde heads with nobody to chase: the houses' middle at home, else where you come out of the portal. */
export function arenaHome(a) {
  if (a.home) return { x: a.home[0], z: a.home[1] };
  const p = portalOf(a);
  return { x: p.out[0], z: p.out[1] };
}

/**
 * The village's blocks the zombies' grid needs for a place in Smetlede: those whose outline reaches
 * within 2 m of its edge's box (`prisms`: village.json's).
 */
export function arenaPrisms(prisms, edge) {
  const x0 = edge.minX - 2, x1 = edge.maxX + 2, z0 = edge.minZ - 2, z1 = edge.maxZ + 2;
  return prisms.filter((p) => p.p.some((ring) => ring.some(([x, z]) => x > x0 && x < x1 && z > z0 && z < z1)));
}

/**
 * What the zombies' grid takes at a place in Smetlede (`village`: village.json's prisms and trees; `church` and `cafe`:
 * shared/church.mjs and shared/sparrenhof.mjs): the village's blocks round its edge, with the church's and the café's
 * own in place of their plain ones, and where the grid is finer with every floor (the church tower, the café's stairs
 * to its roofs); in a wood (`woods`) the trees' trunks too, which the zombies walk between. The same on the page
 * (alone) and on the server (together).
 */
export function villageGround(a, edge, village, church, cafe) {
  let prisms = cafePrisms(churchPrisms(village.prisms ?? [], church), cafe);
  if (a.woods) prisms = prisms.concat(woodTrunks(village.trees ?? [], cafe, edge));
  const areas = a.id === 'church' ? [church.area] : a.id === 'sparrenhof' ? (cafe.areas ?? [cafe.area]) : [];
  return { prisms: arenaPrisms(prisms, edge), areas };
}

/** Where the horde comes out (nav.spawnSpots): in a wood (`woods`) deep among its trees, while there are enough such spots. */
export function arenaSpots(a, spots, village, cafe) {
  if (!a.woods) return spots;
  const wood = woodSpots(spots, village.prisms ?? [], cafe);
  return wood.length >= 12 ? wood : spots;
}
