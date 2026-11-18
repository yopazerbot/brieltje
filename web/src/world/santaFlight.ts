/**
 * Santa's flight over the village at night (world/santa.ts): when it is, and where the sleigh is along the way. No
 * graphics in here, so the tests run it as is (santaFlight.test.mjs).
 *
 * When: from a clock every page shares (the server's, as the villagers' and the cats'), so everyone sees him fly at
 * the same moment without a message going over the network. A flight starts every PERIOD seconds, OFFSET into it
 * (ten minutes apart, at five past the ten), and takes SECONDS. Santa gets into the sleigh BOARD seconds before
 * and gets out REST seconds after it has landed. Whether he flies at all is up to the page: only when it is dark
 * there (world/santa.ts), so a page in the daytime keeps him parked.
 *
 * Where: one smooth line (Catmull-Rom through the points below, in world metres; `h` is metres above the square),
 * from the parking spot on the church square, up and out to the west, round over the fields, the north of the
 * village and the east, and back in from the east to land where he started, facing the same way. The sleigh speeds
 * up from standing, flies at an even pace and slows down to stand again. He rises and comes down nearly straight,
 * a few metres from his spot, so the team clears the tree, the houses round the square and the church tower (which
 * stands south of the square, out of the way of both); the rest is 60 to 115 m up.
 */

export const FLIGHT = { period: 600, offset: 300, seconds: 110, board: 20, rest: 15 };

/** Where the sleigh stands on the square (its middle) and which way it faces (yaw: 0 faces +z). */
export const PARK = { x: 536.6, z: -759.5, yaw: -Math.PI / 2 };

export interface FlightPoint {
  x: number;
  z: number;
  /** Metres above the square */
  h: number;
}

/** The way round, after the takeoff and before the landing (world x, z; height above the square). */
const ROUTE: FlightPoint[] = [
  { x: 468, z: -785, h: 62 },
  { x: 385, z: -760, h: 85 },
  { x: 335, z: -630, h: 100 },
  { x: 430, z: -500, h: 112 },
  { x: 610, z: -455, h: 104 },
  { x: 755, z: -545, h: 92 },
  { x: 785, z: -700, h: 80 },
  { x: 690, z: -762, h: 62 },
  { x: 612, z: -761, h: 50 },
];

/** The points the line goes through: the takeoff ahead of the parking spot, the route, the landing from behind it. */
export function flightPoints(park = PARK): FlightPoint[] {
  const fx = Math.sin(park.yaw);
  const fz = Math.cos(park.yaw);
  const at = (d: number, h: number): FlightPoint => ({ x: park.x + fx * d, z: park.z + fz * d, h });
  return [at(0, 0), at(1.5, 1.2), at(4, 6), at(7, 14), at(12, 26), at(22, 40), ...ROUTE, at(-22, 40), at(-12, 26), at(-7, 14), at(-4, 6), at(-1.5, 1.2), at(0, 0)];
}

export interface FlightPath {
  /** Samples along the line, even in their parameter (not in length) */
  pts: FlightPoint[];
  /** The length along the line to each sample (m) */
  len: number[];
  total: number;
}

const STEPS = 24; // samples between two points

/** The smooth line through the points, sampled, with the length along it. */
export function buildPath(points = flightPoints()): FlightPath {
  const P = [points[0], ...points, points[points.length - 1]];
  const pts: FlightPoint[] = [];
  for (let i = 1; i < P.length - 2; i++) {
    const [a, b, c, d] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    for (let k = 0; k < STEPS; k++) {
      const t = k / STEPS;
      const cr = (p0: number, p1: number, p2: number, p3: number) =>
        0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
      pts.push({ x: cr(a.x, b.x, c.x, d.x), z: cr(a.z, b.z, c.z, d.z), h: Math.max(0, cr(a.h, b.h, c.h, d.h)) });
    }
  }
  pts.push(points[points.length - 1]);
  const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z, pts[i].h - pts[i - 1].h));
  return { pts, len, total: len[len.length - 1] };
}

const EASE = 0.12; // the share of the time spent speeding up, and again slowing down

/** How far along (0 to 1 of the length) at a share u (0 to 1) of the flight's time: speeding up, even, slowing down. */
export function along(u: number): number {
  const a = EASE;
  const c = 2 * a * (1 - a);
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  if (u < a) return (u * u) / c;
  if (u > 1 - a) return 1 - ((1 - u) * (1 - u)) / c;
  return (u - a / 2) / (1 - a);
}

/** The point at a length s along the line (m). */
export function pointAt(path: FlightPath, s: number, out: FlightPoint = { x: 0, z: 0, h: 0 }): FlightPoint {
  const { pts, len } = path;
  const d = Math.min(Math.max(s, 0), path.total);
  let lo = 0;
  let hi = len.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (len[mid] <= d) lo = mid;
    else hi = mid;
  }
  const f = len[hi] > len[lo] ? (d - len[lo]) / (len[hi] - len[lo]) : 0;
  out.x = pts[lo].x + (pts[hi].x - pts[lo].x) * f;
  out.z = pts[lo].z + (pts[hi].z - pts[lo].z) * f;
  out.h = pts[lo].h + (pts[hi].h - pts[lo].h) * f;
  return out;
}

export interface FlightNow {
  /** Seconds since this window's flight began (negative: before it, while he boards) */
  t: number;
  /** When this window's flight begins (s on the clock) */
  start: number;
}

/** The flight window the clock (s) is in: the one whose start is nearest ahead of its boarding, or now. */
export function flightNow(clockS: number): FlightNow {
  const { period, offset, board } = FLIGHT;
  const start = Math.floor((clockS - offset + board) / period) * period + offset;
  return { t: clockS - start, start };
}

/** Where he is in a window: 'parked', 'boarding' (in the seat, about to go), 'flying' or 'landed' (still in the seat). */
export function flightPhase(t: number): 'parked' | 'boarding' | 'flying' | 'landed' {
  if (t < -FLIGHT.board) return 'parked';
  if (t < 0) return 'boarding';
  if (t < FLIGHT.seconds) return 'flying';
  if (t < FLIGHT.seconds + FLIGHT.rest) return 'landed';
  return 'parked';
}
