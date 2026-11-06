// Where the Zombies game is played, shared by the server (together, the admin picks) and the page (alone,
// you pick, in the Play tab). Each place is by a portal (shared/portals.mjs) and has an edge that holds
// while the game runs, as bounds.json's `party` does round the two houses.
//
// - `house` and `bungalow`: the party area round the two houses, the houses open together (their floors
//   in the zombies' grid); starting at the bungalow is the same game from its side.
// - In Smetlede: a circle of `radius` m round `center` (a little off the portal, round its square or
//   its stretch of street), each point pulled in to stay 2 m inside the map's edge. The village's own
//   blocks, hedges and fences are the zombies' walls there, its buildings shut.
// - Not the school: nobody shoots on its grounds (shared/zones.mjs), and the church's circle stops
//   short of them.

import { makeBounds } from './bounds.mjs';
import { PORTALS } from './portals.mjs';

export const ARENAS = [
  { id: 'house', home: [4.5, 18] },
  { id: 'bungalow', home: [97, 172] },
  { id: 'church', center: [548, -768], radius: 48 },
  { id: 'molenhoek', center: [758, -712], radius: 48 },
  { id: 'molenhoek_mid', center: [1062, -567], radius: 48 },
  { id: 'molenhoek_end', center: [1510, -363], radius: 48 },
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
