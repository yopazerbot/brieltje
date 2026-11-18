/**
 * Where the small Christmas market on the church square stands (world/christmasMarket.ts builds it): four wooden
 * chalets in a row along the long house's gable on the square's west side, their counters to the tree, and three
 * standing tables between them and the tree. No graphics in here, so a test can check the spots (christmasMarket.test.mjs).
 *
 * The square is mostly spoken for: the cars' way through it (the traffic's lanes, web/src/data/roads.json), the
 * parking bays in front of the church and in the column by the shop, the tree, Sinterklaas's (and after him Santa's)
 * loop east of the tree, the bike rack and the portal by the street, the bus stop, the notice board. The open paving
 * west of the tree, between the long house and the tree, is the one stretch clear of all of them: the market fills it.
 * Sint-Maarten rides there in his week in November, three weeks before the market comes (world/season.ts), so the
 * two never meet.
 */

/** A chalet's size (m): along its front, front to back, and how far its counter reaches out of the front. */
export const CHALET = { w: 2.2, d: 2.0, counter: 0.22 };

export type Goods = 'choco' | 'waffles' | 'smoutebollen' | 'decorations';

export interface ChaletSpot {
  /** The middle of its front wall on the ground */
  x: number;
  z: number;
  /** The way its front faces, as an angle about up: the front looks along (sin face, cos face) */
  face: number;
  goods: Goods;
}

const EAST = Math.PI / 2;

/** The chalets, south to north along the long house's gable, facing the tree (east). */
export const CHALETS: readonly ChaletSpot[] = [
  { x: 518.6, z: -762.1, face: EAST, goods: 'choco' },
  { x: 518.6, z: -764.5, face: EAST, goods: 'waffles' },
  { x: 518.6, z: -766.9, face: EAST, goods: 'smoutebollen' },
  { x: 518.6, z: -769.3, face: EAST, goods: 'decorations' },
];

/** The standing tables between the counters and the tree: middle and the cover's widest radius. */
export const TABLES: readonly { x: number; z: number }[] = [
  { x: 521.8, z: -763.5 },
  { x: 523.7, z: -765.9 },
  { x: 522.3, z: -768.0 },
];
export const TABLE_R = 0.42;

/** A chalet's outline on the plan (its walls and its counter), corners in order. */
export function chaletRing(c: ChaletSpot): [number, number][] {
  const fx = Math.sin(c.face);
  const fz = Math.cos(c.face);
  // Across the front: the front turned a quarter.
  const ax = fz;
  const az = -fx;
  const half = CHALET.w / 2 + 0.02;
  const corners: [number, number][] = [
    [-half, CHALET.counter],
    [half, CHALET.counter],
    [half, -CHALET.d - 0.02],
    [-half, -CHALET.d - 0.02],
  ];
  return corners.map(([u, v]) => [c.x + ax * u + fx * v, c.z + az * u + fz * v]);
}

/** A table's outline on the plan: an octagon round its cover. */
export function tableRing(t: { x: number; z: number }): [number, number][] {
  const ring: [number, number][] = [];
  for (let i = 0; i < 8; i++) ring.push([t.x + Math.sin((i / 8) * Math.PI * 2) * TABLE_R, t.z + Math.cos((i / 8) * Math.PI * 2) * TABLE_R]);
  return ring;
}
