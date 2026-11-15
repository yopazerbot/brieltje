// The way along the roads, like a car's navigation (the waypoint's line in src/ui/route.ts, a race's line in
// src/world/goals.ts, the autopilot in tools/dev/goals.mjs): over the road register's centre lines (src/data/streets.json
// `graph`, about 500 points, the field tracks too). Where you stand and where you go join the network at the nearest
// point of the nearest road; when going straight there is about as short (across a garden, the church square), or the
// roads go round three times as far (across a field), the way is just the straight line. Plain numbers, no page.

/** Shorter than this (m) straight: no roads. */
export const STRAIGHT_UNDER = 40;
/** A way along the roads more than this many times the straight line: the straight line. */
export const DETOUR_MAX = 3;

/** The network of `graph` ({ points: [x, z][], edges: [a, b][] }): `nearest(x, z)` and `route(from, to)`. */
export function makeRoads(graph) {
  const POINTS = graph.points;
  const EDGES = graph.edges;
  const NEXT = POINTS.map(() => []);
  for (const [a, b] of EDGES) {
    const d = Math.hypot(POINTS[a][0] - POINTS[b][0], POINTS[a][1] - POINTS[b][1]);
    NEXT[a].push({ to: b, d });
    NEXT[b].push({ to: a, d });
  }

  /** The nearest point on any road to (x, z): which stretch, where on it, how far. */
  function nearest(x, z) {
    let best = { a: 0, b: 0, p: [x, z], d: Infinity };
    for (const [a, b] of EDGES) {
      const [ax, az] = POINTS[a];
      const [bx, bz] = POINTS[b];
      const ex = bx - ax;
      const ez = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
      const p = [ax + ex * t, az + ez * t];
      const d = Math.hypot(x - p[0], z - p[1]);
      if (d < best.d) best = { a, b, p, d };
    }
    return best;
  }

  /** The way from `from` to `to` ([x, z]): a polyline, its length in metres, and whether it goes along the roads. */
  function route(from, to) {
    const straight = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const line = { line: [from, to], length: straight, roads: false };
    const s = nearest(from[0], from[1]);
    const t = nearest(to[0], to[1]);
    if (!EDGES.length || straight < STRAIGHT_UNDER || straight <= s.d + t.d) return line;
    // Two extra points: where you join the roads (n) and where you leave them (n + 1).
    const n = POINTS.length;
    const at = (i) => (i === n ? s.p : i === n + 1 ? t.p : POINTS[i]);
    const links = (i) => {
      const out = i < n ? [...NEXT[i]] : [];
      for (const [k, j] of [[n, s], [n + 1, t]]) {
        if (i === k) out.push({ to: j.a, d: Math.hypot(at(k)[0] - POINTS[j.a][0], at(k)[1] - POINTS[j.a][1]) }, { to: j.b, d: Math.hypot(at(k)[0] - POINTS[j.b][0], at(k)[1] - POINTS[j.b][1]) });
        else if (i === j.a || i === j.b) out.push({ to: k, d: Math.hypot(at(k)[0] - POINTS[i][0], at(k)[1] - POINTS[i][1]) });
      }
      // Joining and leaving on the same stretch: straight along it.
      if (s.a === t.a && s.b === t.b && (i === n || i === n + 1)) out.push({ to: i === n ? n + 1 : n, d: Math.hypot(s.p[0] - t.p[0], s.p[1] - t.p[1]) });
      return out;
    };
    const dist = new Map([[n, 0]]);
    const prev = new Map();
    const open = new Set([n]);
    while (open.size) {
      let i = -1;
      let best = Infinity;
      for (const k of open) if (dist.get(k) < best) [i, best] = [k, dist.get(k)];
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
    if (!prev.has(n + 1)) return line;
    const way = [to];
    for (let i = n + 1; i !== undefined; i = prev.get(i)) way.push(at(i));
    way.push(from);
    way.reverse();
    const length = dist.get(n + 1) + s.d + t.d;
    return length > straight * DETOUR_MAX ? line : { line: way, length, roads: true };
  }

  return { nearest, route };
}

/** The point of `line` nearest to (x, z): the segment it is on (from index i to i + 1), the point, how far. */
export function onLine(line, x, z) {
  let best = { i: 0, p: line[0] ?? [x, z], d: Infinity };
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, az] = line[i];
    const [bx, bz] = line[i + 1];
    const ex = bx - ax, ez = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
    const p = [ax + ex * t, az + ez * t];
    const d = Math.hypot(x - p[0], z - p[1]);
    if (d < best.d) best = { i, p, d };
  }
  if (line.length === 1) best.d = Math.hypot(x - line[0][0], z - line[0][1]);
  return best;
}

/** The length of a polyline (m). */
export function lengthOf(line) {
  let m = 0;
  for (let i = 1; i < line.length; i++) m += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  return m;
}
