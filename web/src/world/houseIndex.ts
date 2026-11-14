import type { Prism, RoofSpec, Surroundings } from './houseData';
import { BlockGrid, Houses } from './houseKeys';
import { planBases, type BasePlan, type GroundAt } from './housePlan';
import { chimneyRoofs } from './houseTrim';
import { planRoofs } from './roofPlan';

/**
 * What the open-data houses' parts need to know about a whole set (the ring's or the village's), built once per set the
 * first time one of its tiles is built (world/surroundings.ts `buildTile`): which house every block belongs to, the roof
 * of each house that carries its chimney, and the houses with a pitched roof. The tiles cut a set in squares of 200 m,
 * and a house standing on a tile's edge has blocks, roofs and openings in two tiles: with this they get the same key,
 * the same style and the same parts from both, and an opening finds its wall across the edge.
 */
export interface HouseIndex {
  houses: Houses;
  /** The roof that carries each house's chimney (if its style has one), and the house's key */
  chimneys: Map<RoofSpec, number>;
  /** The keys of the houses with a gable or hip roof */
  pitched: Set<number>;
  /** The band at the foot of each house wall that gets one (world/housePlan.ts) */
  bases: Map<Prism, BasePlan>;
  /** The flat roofs' lids (nb_roof blocks), to keep their edge trims out of each other */
  lids: BlockGrid;
  /** The data's single slopes to what is drawn in their place: halves joined, ramps turned, wedges closed (world/roofPlan.ts) */
  drawn: Map<RoofSpec, RoofSpec>;
  /** The house under a roof (a drawn one): both halves of a pair take the larger half's, so they look one roof */
  keyOf: (r: RoofSpec) => number;
}

const built = new WeakMap<object, HouseIndex>();

/** The house under a roof: the walls round the middle of its outline. */
export const roofKey = (houses: Houses, r: RoofSpec): number => {
  const [cx, cz] = r.p.reduce(([x, z], q) => [x + q[0] / r.p.length, z + q[1] / r.p.length], [0, 0]);
  return houses.at(cx, cz, r.wall);
};

/** `groundAt`: the ground's height at (x, z). */
export function houseIndex(set: Pick<Surroundings, 'roofs' | 'prisms' | 'openings' | 'solar'>, groundAt: GroundAt): HouseIndex {
  let index = built.get(set);
  if (index) return index;
  const prisms: Prism[] = set.prisms ?? [];
  const houses = new Houses(prisms);
  const lids = new BlockGrid();
  for (const p of prisms) if (p.m === 'nb_roof') lids.add(p);
  // The walls and lids round a point, from the grids built here already.
  const standing = (x: number, z: number) => [...houses.wallsAt(x, z).map((w) => w.p), ...lids.at(x, z)];
  const plan = planRoofs(set.roofs, prisms, set.openings ?? [], set.solar ?? [], standing);
  const roofs = set.roofs.map((r) => plan.drawn.get(r) ?? r);
  // A pair's smaller half takes the key of the half with the ridge row (the larger).
  const keyOf = (r: RoofSpec): number => {
    const other = plan.partner.get(r);
    return roofKey(houses, other?.crown !== undefined ? other : r);
  };
  const pitched = new Set<number>();
  for (const r of roofs) if (r.shape !== 'shed' || r.closed || plan.partner.has(r)) pitched.add(keyOf(r));
  index = {
    houses,
    chimneys: chimneyRoofs(roofs, prisms, keyOf, (r) => plan.partner.get(r)),
    pitched,
    bases: planBases(prisms, set.openings ?? [], houses, groundAt),
    lids,
    drawn: plan.drawn,
    keyOf,
  };
  built.set(set, index);
  return index;
}
