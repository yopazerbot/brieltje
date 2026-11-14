import type { Prism, RoofSpec, Surroundings } from './houseData';
import { Houses } from './houseKeys';
import { planBases, type BasePlan, type GroundAt } from './housePlan';
import { chimneyRoofs } from './houseTrim';

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
}

const built = new WeakMap<object, HouseIndex>();

/** The house under a roof: the walls round the middle of its outline. */
export const roofKey = (houses: Houses, r: RoofSpec): number => {
  const [cx, cz] = r.p.reduce(([x, z], q) => [x + q[0] / r.p.length, z + q[1] / r.p.length], [0, 0]);
  return houses.at(cx, cz, r.wall);
};

/** `groundAt`: the ground's height at (x, z). */
export function houseIndex(set: Pick<Surroundings, 'roofs' | 'prisms' | 'openings'>, groundAt: GroundAt): HouseIndex {
  let index = built.get(set);
  if (index) return index;
  const prisms: Prism[] = set.prisms ?? [];
  const houses = new Houses(prisms);
  const keyOf = (r: RoofSpec) => roofKey(houses, r);
  const pitched = new Set<number>();
  for (const r of set.roofs) if (r.shape !== 'shed') pitched.add(keyOf(r));
  index = { houses, chimneys: chimneyRoofs(set.roofs, prisms, keyOf), pitched, bases: planBases(prisms, set.openings ?? [], houses, groundAt) };
  built.set(set, index);
  return index;
}
