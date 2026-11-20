import type { Opening, Prism, RoofSpec, Surroundings } from './houseData';
import { BlockGrid, Houses } from './houseKeys';
import { planBases, planDownpipes, planFloating, planOpeningTops, planReveals, type BasePlan, type Downpipe, type GroundAt, type OpeningTop, type RevealPlan } from './housePlan';
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
  /** The windows and doors set back in their walls, and the holes for them (world/housePlan.ts, world/wallCut.ts) */
  reveals: RevealPlan;
  /** The flat roofs' downpipes (world/housePlan.ts) */
  downpipes: Map<Prism, Downpipe>;
  /** The highest frame top along a wall line, for the eaves' soffits to stay over (world/housePlan.ts) */
  openingTop: OpeningTop;
  /** The data's single slopes to what is drawn in their place: halves joined, ramps turned, wedges closed (world/roofPlan.ts) */
  drawn: Map<RoofSpec, RoofSpec>;
  /** The house under a roof (a drawn one): both halves of a pair take the larger half's, so they look one roof */
  keyOf: (r: RoofSpec) => number;
  /** The openings that would stand out of their house (over its walls and roof, or under its walls): not drawn (world/housePlan.ts) */
  floating: Set<Opening>;
}

const built = new WeakMap<object, HouseIndex>();

/** Development only: the sets the roofs were planned on, as the page has them (tools/dev/houseSets.mjs reads them). */
export const plannedSets: Pick<Surroundings, 'roofs' | 'prisms' | 'openings' | 'solar' | 'unfiltered'>[] = [];

/** The house under a roof: the walls round the middle of its outline. */
export const roofKey = (houses: Houses, r: RoofSpec): number => {
  const [cx, cz] = r.p.reduce(([x, z], q) => [x + q[0] / r.p.length, z + q[1] / r.p.length], [0, 0]);
  return houses.at(cx, cz, r.wall);
};

/** `groundAt`: the ground's height at (x, z). */
export function houseIndex(set: Pick<Surroundings, 'roofs' | 'prisms' | 'openings' | 'solar' | 'unfiltered'>, groundAt: GroundAt): HouseIndex {
  let index = built.get(set);
  if (index) return index;
  if (import.meta.env?.DEV) plannedSets.push(set);
  const prisms: Prism[] = set.prisms ?? [];
  const houses = new Houses(prisms);
  const lids = new BlockGrid();
  for (const p of prisms) if (p.m === 'nb_roof') lids.add(p);
  // The walls and lids round a point, from the grids built here already.
  const standing = (x: number, z: number) => [...houses.wallsAt(x, z).map((w) => w.p), ...lids.at(x, z)];
  const plan = planRoofs(set.roofs, prisms, set.openings ?? [], set.solar ?? [], standing, set.unfiltered && { roofs: set.unfiltered.roofs, prisms: set.unfiltered.prisms ?? [] });
  const roofs = set.roofs.map((r) => plan.drawn.get(r) ?? r);
  // Both halves of a pair take one house's key: that of the larger half (the one with the ridge row), or of the other
  // where only that one has walls under its middle (else the key would come from the spot, not the house).
  const walled = (r: RoofSpec) => {
    const [cx, cz] = r.p.reduce(([x, z], q) => [x + q[0] / r.p.length, z + q[1] / r.p.length], [0, 0]);
    return houses.wallsAt(cx, cz).length > 0;
  };
  const keyOf = (r: RoofSpec): number => {
    const other = plan.partner.get(r);
    if (!other) return roofKey(houses, r);
    const [big, small] = r.crown !== undefined ? [r, other] : [other, r];
    return roofKey(houses, walled(big) || !walled(small) ? big : small);
  };
  const pitched = new Set<number>();
  for (const r of roofs) if (r.shape !== 'shed' || r.closed || plan.partner.has(r)) pitched.add(keyOf(r));
  // No opening over the top of its walls (or the roof drawn over them) or under their foot: not drawn, cut or trimmed.
  const floating = planFloating(set.openings ?? [], houses, roofs);
  const openings = (set.openings ?? []).filter((o) => !floating.has(o));
  const bases = planBases(prisms, openings, houses, groundAt);
  index = {
    houses,
    chimneys: chimneyRoofs(roofs, prisms, keyOf, (r) => plan.partner.get(r)),
    pitched,
    bases,
    lids,
    reveals: planReveals(openings, houses, bases, groundAt),
    downpipes: planDownpipes(prisms, openings, houses, lids, groundAt),
    openingTop: planOpeningTops(openings),
    drawn: plan.drawn,
    keyOf,
    floating,
  };
  built.set(set, index);
  return index;
}
