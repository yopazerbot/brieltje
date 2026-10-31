import STREETS from '../data/streets.json';

/**
 * Directions along the roads, like a car's navigation: from where you are to the waypoint set on
 * the big map, over the road register's centre lines (tools/streets.py, about 300 points). Where
 * you stand and the waypoint join the network at the nearest point of the nearest road; when going
 * straight there is about as short (a waypoint across the garden), the route is just that line.
 * Dijkstra over a few hundred points takes well under a millisecond, so it is worked out again
 * as you move.
 */

type P = [number, number];

const POINTS = STREETS.graph.points as P[];
const EDGES = STREETS.graph.edges as P[];
const NEXT: { to: number; d: number }[][] = POINTS.map(() => []);
for (const [a, b] of EDGES) {
  const d = Math.hypot(POINTS[a][0] - POINTS[b][0], POINTS[a][1] - POINTS[b][1]);
  NEXT[a].push({ to: b, d });
  NEXT[b].push({ to: a, d });
}

/** The nearest point on any road to (x, z): which stretch, where on it, how far. */
function nearest(x: number, z: number): { a: number; b: number; p: P; d: number } {
  let best = { a: 0, b: 0, p: [x, z] as P, d: Infinity };
  for (const [a, b] of EDGES) {
    const [ax, az] = POINTS[a];
    const [bx, bz] = POINTS[b];
    const ex = bx - ax;
    const ez = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
    const p: P = [ax + ex * t, az + ez * t];
    const d = Math.hypot(x - p[0], z - p[1]);
    if (d < best.d) best = { a, b, p, d };
  }
  return best;
}

/** The way from `from` to `to` (model x, z): a polyline, and its length in metres. */
export function route(from: P, to: P): { line: P[]; length: number } {
  const straight = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const s = nearest(from[0], from[1]);
  const t = nearest(to[0], to[1]);
  if (!EDGES.length || straight < 40 || straight <= s.d + t.d) return { line: [from, to], length: straight };
  // Two extra points: where you join the roads (n) and where you leave them (n + 1).
  const n = POINTS.length;
  const at = (i: number): P => (i === n ? s.p : i === n + 1 ? t.p : POINTS[i]);
  const links = (i: number): { to: number; d: number }[] => {
    const out = i < n ? [...NEXT[i]] : [];
    for (const [k, j] of [[n, s], [n + 1, t]] as const) {
      if (i === k) out.push({ to: j.a, d: Math.hypot(at(k)[0] - POINTS[j.a][0], at(k)[1] - POINTS[j.a][1]) }, { to: j.b, d: Math.hypot(at(k)[0] - POINTS[j.b][0], at(k)[1] - POINTS[j.b][1]) });
      else if (i === j.a || i === j.b) out.push({ to: k, d: Math.hypot(at(k)[0] - POINTS[i][0], at(k)[1] - POINTS[i][1]) });
    }
    // Joining and leaving on the same stretch: straight along it.
    if (s.a === t.a && s.b === t.b && (i === n || i === n + 1)) out.push({ to: i === n ? n + 1 : n, d: Math.hypot(s.p[0] - t.p[0], s.p[1] - t.p[1]) });
    return out;
  };
  const dist = new Map<number, number>([[n, 0]]);
  const prev = new Map<number, number>();
  const open = new Set<number>([n]);
  while (open.size) {
    let i = -1;
    let best = Infinity;
    for (const k of open) if (dist.get(k)! < best) [i, best] = [k, dist.get(k)!];
    open.delete(i);
    if (i === n + 1) break;
    for (const { to: j, d } of links(i)) {
      const nd = best + d;
      if (nd < (dist.get(j) ?? Infinity)) {
        dist.set(j, nd);
        prev.set(j, i);
        open.add(j);
      }
    }
  }
  if (!prev.has(n + 1)) return { line: [from, to], length: straight };
  const line: P[] = [to];
  for (let i: number | undefined = n + 1; i !== undefined; i = prev.get(i)) line.push(at(i));
  line.push(from);
  line.reverse();
  const length = dist.get(n + 1)! + s.d + t.d;
  // A road way much longer than walking straight there (across a field): go straight.
  return length > straight * 3 ? { line: [from, to], length: straight } : { line, length };
}
