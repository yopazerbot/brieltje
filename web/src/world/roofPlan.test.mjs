import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';

// The modules import each other without extensions, as Vite has them: add .ts here.
registerHooks({
  resolve(specifier, context, next) {
    if (/^\.\.?\//.test(specifier) && !/\.(m?js|ts|json)$/.test(specifier)) specifier += '.ts';
    return next(specifier, context);
  },
});
const { planRoofs, ROOF_OVERRIDES, TURN_PITCH } = await import('./roofPlan.ts');
const { BlockGrid, Houses, inside, isBrick } = await import('./houseKeys.ts');

const read = (file) => JSON.parse(fs.readFileSync(new URL(file, import.meta.url), 'utf8'));
const shell = read('../data/house_shell.json');
// The two sets the houses are built from: the village and the ring round the home.
const sets = { village: read('../data/village.json'), ring: shell.surroundings };

/**
 * What the plan made of the committed data (counted when it was written; a change in the data or the rule shows here).
 * One ramp in the village is kept: a taller part's window looks out over its low end, which the turned gable would hide.
 */
const EXPECT = {
  village: { pair: 176, levelled: 98, close: 79, turn: 8, keep: 163 },
  ring: { pair: 30, levelled: 12, close: 14, turn: 0, keep: 20 },
};

const frame = (r) => {
  const c = r.p;
  const L = Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]);
  const W = Math.hypot(c[3][0] - c[0][0], c[3][1] - c[0][1]);
  return { c, L, W, ax: (c[1][0] - c[0][0]) / L, az: (c[1][1] - c[0][1]) / L, bx: (c[3][0] - c[0][0]) / W, bz: (c[3][1] - c[0][1]) / W };
};
const local = (f, x, z) => [(x - f.c[0][0]) * f.ax + (z - f.c[0][1]) * f.az, (x - f.c[0][0]) * f.bx + (z - f.c[0][1]) * f.bz];

/** The top of a drawn roof at `b` across (the tiles' surface, without the overhang's drop at the eaves). */
const surfaceAt = (r, f, b) => {
  if (r.closed) {
    const { at, far } = r.closed;
    return b <= at ? r.y + ((r.ridge - r.y) * b) / at : far + ((r.ridge - far) * (f.W - b)) / (f.W - at);
  }
  if (r.shape === 'shed') return r.y + ((r.ridge - r.y) * b) / f.W;
  return r.y + (r.ridge - r.y) * (1 - Math.abs(b - f.W / 2) / (f.W / 2)); // a gable (a turned ramp)
};

for (const [name, set] of Object.entries(sets)) {
  const prisms = set.prisms ?? [];
  const openings = set.openings ?? [];
  const plan = planRoofs(set.roofs, prisms, openings, set.solar ?? []);
  const changed = [...plan.drawn].filter(([r]) => plan.cases.get(r).kind !== 'keep');

  test(`${name}: the single slopes come out as counted (pairs, levelled, closed, turned, kept)`, () => {
    const n = { pair: 0, levelled: 0, close: 0, turn: 0, keep: 0 };
    for (const [, c] of plan.cases) {
      n[c.kind]++;
      if (c.levelled) n.levelled++;
    }
    assert.deepEqual(n, EXPECT[name]);
    assert.equal(ROOF_OVERRIDES.length, 0, 'no roof overridden');
  });

  test(`${name}: the same data gives the same roofs, also from the page's grids (world/houseIndex.ts)`, () => {
    const houses = new Houses(prisms);
    const lids = new BlockGrid();
    for (const p of prisms) if (p.m === 'nb_roof') lids.add(p);
    const standing = (x, z) => [...houses.wallsAt(x, z).map((w) => w.p), ...lids.at(x, z)];
    for (const again of [planRoofs(set.roofs, prisms, openings, set.solar ?? []), planRoofs(set.roofs, prisms, openings, set.solar ?? [], standing)]) {
      assert.equal(again.drawn.size, plan.drawn.size);
      for (const [r, d] of plan.drawn) assert.deepEqual(again.drawn.get(r), d);
    }
  });

  test(`${name}: every pair is mutual, with one top, one tile colour, one ridge row and no gap at the apex`, () => {
    let pairs = 0;
    for (const [r, c] of plan.cases) {
      if (c.kind !== 'pair') continue;
      const a = plan.drawn.get(r);
      const b = plan.partner.get(a);
      assert.ok(b, 'a pair has a partner');
      assert.equal(plan.partner.get(b), a, 'the partner names it back');
      assert.equal(a.ridge, b.ridge, 'one top');
      assert.equal(a.tiles, b.tiles, 'one tile colour');
      assert.ok(a.tight && b.tight, 'both stop at the high edge');
      assert.equal((a.crown !== undefined) + (b.crown !== undefined), 1, 'one ridge row');
      // The high edges: the other half's high corners on or within this one's high edge (no gap between them).
      const f = frame(b);
      for (const q of [a.p[2], a.p[3]]) assert.ok(local(f, q[0], q[1])[1] <= f.W + 0.05, `${name}: a gap at the apex at (${q[0].toFixed(1)}, ${q[1].toFixed(1)})`);
      // Nothing above the pair's top.
      assert.ok(a.ridge <= Math.max(r.ridge, b.ridge) + 1e-9);
      pairs++;
    }
    assert.equal(pairs, EXPECT[name].pair);
  });

  test(`${name}: closed wedges stay under the data's top with their ridge inside the roof; turned ramps stay low`, () => {
    for (const [r, d] of changed) {
      const f = frame(r);
      if (d.closed) {
        const { at, far } = d.closed;
        assert.ok(r.y <= far && far < d.ridge && d.ridge <= r.ridge + 1e-9, `${name}: heights ${r.y} ${far} ${d.ridge} ${r.ridge}`);
        assert.ok(at >= 0.3 && at <= f.W - 0.25, `${name}: ridge at ${at.toFixed(2)} of ${f.W.toFixed(2)}`);
      }
      if (plan.cases.get(r).kind === 'turn') {
        assert.ok(!d.shape && d.fixed, 'a turned ramp is a gable');
        assert.ok(d.ridge - d.y <= (TURN_PITCH * f.L) / 2 + 1e-9, `${name}: a turned ridge ${(d.ridge - d.y).toFixed(2)} m over its eaves`);
        assert.ok(d.ridge <= r.ridge + 1e-9);
      }
    }
  });

  test(`${name}: no changed roof hides a window, has one on its own drawn walls, or stands over a taller wall`, () => {
    for (const [r, d] of changed) {
      const c = plan.cases.get(r);
      const f = frame(r);
      const box = (q) => Math.abs(q[0] - r.p[0][0]) < 40 && Math.abs(q[1] - r.p[0][1]) < 40;
      for (const o of openings) {
        if (!box(o.a)) continue;
        const [a, b] = local(f, (o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2);
        if (a < -0.3 || a > f.L + 0.3 || b < -0.3 || b > f.W + 0.3) continue;
        // On the roof's own walls (closed, turned, levelled): none above the eaves.
        const l = Math.hypot(o.n[0], o.n[1]) || 1;
        const [ia, ib] = local(f, (o.a[0] + o.b[0]) / 2 - (o.n[0] / l) * 0.3, (o.a[1] + o.b[1]) / 2 - (o.n[1] / l) * 0.3);
        const own = ia >= 0 && ia <= f.L && ib >= 0 && ib <= f.W;
        if (own && (c.kind !== 'pair' || c.levelled) && o.y[1] > r.y + 0.15) {
          const carried = prisms.some((p) => p.d === undefined && p.m !== 'nb_roof' && isBrick(p.m) && o.y[1] - 0.1 < p.y1 + 0.05 && o.y[1] - 0.1 > p.y0 - 0.05 && inside(p.p[0], (o.a[0] + o.b[0]) / 2 - (o.n[0] / l) * 0.3, (o.a[1] + o.b[1]) / 2 - (o.n[1] / l) * 0.3));
          assert.ok(carried, `${name}: a window over the eaves on the drawn walls at (${o.a[0].toFixed(1)}, ${o.a[1].toFixed(1)})`);
        }
        // A window by the roof that looks out over it from above its eaves (a taller part's, a neighbour's) and showed over
        // the data's tiles: the drawn tiles there no higher than the data's or the window's foot, so none is newly hidden.
        // Halves of a pair closer than 0.6 m move to their mean as they are: by at most 0.3 m.
        const [x, z] = [(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2];
        const [cx, cz] = [f.c[0][0] + f.ax * (f.L / 2) + f.bx * (f.W / 2), f.c[0][1] + f.az * (f.L / 2) + f.bz * (f.W / 2)];
        if (o.y[1] <= r.y + 0.15 || o.n[0] * (cx - x) + o.n[1] * (cz - z) <= 0) continue;
        const fd = frame(d);
        const now = surfaceAt(d, fd, Math.max(0, Math.min(fd.W, local(fd, x, z)[1])));
        const was = surfaceAt(r, f, Math.max(0, Math.min(f.W, b)));
        const slack = c.kind === 'pair' && !c.levelled ? 0.3 : 0.05;
        if (was < o.y[1]) assert.ok(now <= Math.max(was, o.y[0]) + slack, `${name}: a window ${(now - Math.max(was, o.y[0])).toFixed(2)} m under the new roof at (${o.a[0].toFixed(1)}, ${o.a[1].toFixed(1)})`);
      }
      // No wall block under it reaches over its eaves (the blocks are what players and the server collide with).
      const [mx, mz] = [f.c[0][0] + f.ax * (f.L / 2) + f.bx * (f.W / 2), f.c[0][1] + f.az * (f.L / 2) + f.bz * (f.W / 2)];
      for (const p of prisms) {
        if (p.d !== undefined || !isBrick(p.m) || Math.abs(p.p[0][0][0] - mx) > 40) continue;
        if (inside(p.p[0], mx, mz)) assert.ok(p.y1 <= r.y + 0.3, `${name}: a wall ${(p.y1 - r.y).toFixed(2)} m over the eaves under a changed roof`);
      }
    }
  });
}
