// The cats' walks (shared/cats.json), shared by the page (src/world/cats.ts draws them) and the server (server/game.mjs:
// a cat shot down is believed only within reach of where it is). Each cat walks a fixed loop on the shared clock, so
// every player sees it in the same place without the server sending positions, and the server works out itself where
// each one is: nothing of that is taken from a page.

/** m: what a page may show differently from the server (its clock's offset, the network's delay), as for the villagers */
export const CAT_SLACK = 10;

/**
 * Where cat `i` of `cats` (shared/cats.json) is at time `t` (s on the shared clock): walking between the corners of its
 * loop at `cats.speed`, pausing `cats.pause` at each. Each cat is 7 s further along than the one before it.
 */
export function catWalk(cats, i, t) {
  const loop = cats.cats[i];
  const legs = loop.map((p, k) => {
    const q = loop[(k + 1) % loop.length];
    return { from: p, to: q, time: Math.hypot(q[0] - p[0], q[1] - p[1]) / cats.speed };
  });
  const cycle = legs.reduce((s, l) => s + l.time + cats.pause, 0);
  const at = t + i * 7;
  let u = ((at % cycle) + cycle) % cycle;
  for (const l of legs) {
    const heading = Math.atan2(l.to[0] - l.from[0], l.to[1] - l.from[1]);
    if (u < cats.pause) return { x: l.from[0], z: l.from[1], heading, walking: false };
    u -= cats.pause;
    if (u < l.time) {
      const f = u / l.time;
      return { x: l.from[0] + (l.to[0] - l.from[0]) * f, z: l.from[1] + (l.to[1] - l.from[1]) * f, heading, walking: true };
    }
    u -= l.time;
  }
  return { x: loop[0][0], z: loop[0][1], heading: 0, walking: false };
}

/**
 * For the server: whether cat `i` is within `reach` metres (and CAT_SLACK) of (x, y, z) at time `t`, counted in three
 * dimensions from where it walks on `floor(x, z)` (the server's ground). Not a number of the list: never.
 */
export function catWithin(cats, i, t, x, y, z, reach, floor) {
  if (!Number.isInteger(i) || i < 0 || i >= cats.cats.length) return false;
  const p = catWalk(cats, i, t);
  return Math.hypot(p.x - x, floor(p.x, p.z) - y, p.z - z) <= reach + CAT_SLACK;
}
