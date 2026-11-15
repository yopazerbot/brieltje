import STREETS from '../data/streets.json';
import { makeRoads } from '../../shared/roadPath.mjs';

/**
 * Directions along the roads, like a car's navigation: from where you are to the waypoint set on
 * the big map, over the road register's centre lines (tools/streets.py, about 500 points). The way
 * itself is worked out in shared/roadPath.mjs (also a timed race's line, world/goals.ts, and the
 * autopilot of tools/dev/goals.mjs): where you stand and the waypoint join the network at the
 * nearest point of the nearest road; when going straight there is about as short (a waypoint across
 * the garden), the route is just that line. Dijkstra over a few hundred points takes well under a
 * millisecond, so it is worked out again as you move.
 */

type P = [number, number];

const EDGES = STREETS.graph.edges as P[];
/** The road network, shared by the waypoint and a race's line */
export const ROADS = makeRoads({ points: STREETS.graph.points as P[], edges: EDGES });

// Each stretch's street name (tools/streets.py), by its two points.
const NAMES = STREETS.graph.names as string[];
const STREET = new Map<number, string>();
(STREETS.graph.street as number[]).forEach((s, i) => s >= 0 && STREET.set(EDGES[i][0] * 4096 + EDGES[i][1], NAMES[s]));

/** The street you are in: the nearest road's name, if a road is within `within` metres. */
export function streetAt(x: number, z: number, within = 40): string | undefined {
  const near = ROADS.nearest(x, z);
  return near.d <= within ? STREET.get(near.a * 4096 + near.b) : undefined;
}

/** The way from `from` to `to` (model x, z): a polyline, and its length in metres. */
export function route(from: P, to: P): { line: P[]; length: number } {
  const { line, length } = ROADS.route(from, to);
  return { line, length };
}
