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
const { plotCovers } = await import('./plots.ts');
const { BlockGrid, Houses, inside } = await import('./houseKeys.ts');
const { makeTerrain } = await import('../../shared/terrain.mjs');

const read = (file) => JSON.parse(fs.readFileSync(new URL(file, import.meta.url), 'utf8'));
const village = read('../data/village.json');
const shell = read('../data/house_shell.json');
const detail = read('../data/roadDetail.json');
const roads = read('../data/roads.json');
const football = read('../../shared/football.json');
const cars = read('../../shared/car.json');
const terrain = makeTerrain(read('../../shared/terrain.json'));
const groundAt = (x, z) => shell.ground + terrain.height(x, z);

// The village as world/villagePlots.ts hands it over: its blocks as the tiles draw them (the road blocks the streets in
// detail draw over left out), the small things and parked cars, the rings kept clear (here without our models': those
// come from the models, in the page's own input below).
const hidden = new Set(detail.hide);
const prisms = village.prisms.filter((p) => !hidden.has(`${p.m}|${p.p[0][0][0]}|${p.p[0][0][1]}|${p.p[0].length}`));
const houses = new Houses(prisms);
const inputs = {
  raw: {
    prisms,
    openings: village.openings,
    trees: village.trees,
    dips: village.dips ?? [],
    runs: detail.runs,
    things: [
      ...roads.boxes.map(([x, z]) => [x, z, 0.2]),
      ...roads.signs.map(([x, z]) => [x, z, 0.15]),
      ...roads.bikes.map(([x, z]) => [x, z, 0.9]),
      ...(village.posts ?? []).map(([x, z]) => [x, z, 0.1]),
      ...(village.poles ?? []).map((p) => [p.x, p.z, 0.2]),
    ],
    cars: [...roads.parked.map(([x, z, yaw]) => [x, z, yaw]), ...Object.values(cars.cars).filter((c) => c.village).map((c) => [c.park.x, c.park.z, c.park.yaw])],
    keyAt: (x, z) => houses.at(x, z),
    keepOut: [football.platform.ring, football.plot],
    models: (village.landmarks ?? []).map((l) => l.p),
    groundAt,
  },
};
// And, given a file from tools/dev/houseSets.mjs, the page's own input (with our models' outlines and open ground).
if (process.env.HOUSE_SETS) {
  const page = JSON.parse(fs.readFileSync(process.env.HOUSE_SETS, 'utf8')).plots[0];
  const h = new Houses(page.prisms);
  inputs.page = { ...page, keyAt: (x, z) => h.at(x, z), groundAt };
}

/** The streets as their detail draws them, built here on their own: each side's hard strip as quads between stations. */
const quads = [];
for (const r of detail.runs) {
  const n = r.p.length / 2;
  const x = (k) => r.p[2 * k];
  const z = (k) => r.p[2 * k + 1];
  const normal = (k) => {
    const [a, b] = [Math.max(0, k - 2), Math.min(n - 1, k + 2)];
    const [tx, tz] = [x(b) - x(a), z(b) - z(a)];
    const l = Math.hypot(tx, tz) || 1;
    return [-tz / l, tx / l];
  };
  for (let k = 0; k < n - 1; k++) {
    const [n0, n1] = [normal(k), normal(k + 1)];
    for (const [s, i] of [[1, 0], [-1, 1]]) {
      const e0 = s * (r.w[2 * k + i] + r.q[2 * k + i]);
      const e1 = s * (r.w[2 * k + 2 + i] + r.q[2 * k + 2 + i]);
      quads.push([[x(k), z(k)], [x(k + 1), z(k + 1)], [x(k + 1) + n1[0] * e1, z(k + 1) + n1[1] * e1], [x(k) + n0[0] * e0, z(k) + n0[1] * e0]]);
    }
  }
}
const roadCovers = prisms.filter((p) => p.d !== undefined && p.y1 <= 0 && (p.m === 'road' || p.m === 'pave_grey')).map((p) => p.p[0]);
const near = (ring, x, z, m) => ring.some(([px, pz]) => Math.abs(px - x) < m && Math.abs(pz - z) < m);
const onStreet = (x, z) => quads.some((q) => near(q, x, z, 40) && inside(q, x, z)) || roadCovers.some((r) => near(r, x, z, 400) && inside(r, x, z));

const grids = new Map();
const blocksOf = (input) => {
  if (!grids.has(input)) {
    const g = new BlockGrid();
    for (const p of input.prisms) g.add(p);
    grids.set(input, g);
  }
  return grids.get(input);
};

for (const [name, input] of Object.entries(inputs)) {
  const plots = plotCovers(input);

  test(`${name}: the paths and drives come out about as counted when they were planned`, () => {
    assert.ok(plots.paths >= 120 && plots.paths <= 290, `${plots.paths} paths`);
    assert.ok(plots.drives >= 25 && plots.drives <= 80, `${plots.drives} drives`);
    assert.equal(plots.covers.length, plots.paths + plots.drives);
    for (const c of plots.covers) {
      assert.ok(['pave_warm', 'pave_light', 'gravel', 'concrete'].includes(c.m), c.m);
      assert.ok(c.d !== undefined && c.y1 <= 0, 'a ground cover, under the ground as the data\'s');
    }
    // One surface per house.
    const by = new Map();
    plots.covers.forEach((c, i) => {
      const w = plots.ways[i];
      const key = input.keyAt(w.from[0] - w.n[0] * 0.3, w.from[1] - w.n[1] * 0.3);
      assert.ok(!by.has(key) || by.get(key) === c.m, `two surfaces on one house at (${w.from[0].toFixed(1)}, ${w.from[1].toFixed(1)})`);
      by.set(key, c.m);
    });
  });

  test(`${name}: the same input gives the same plots`, () => {
    assert.deepEqual(plotCovers(input).covers, plots.covers);
  });

  test(`${name}: each way reaches the street its detail draws, its end along the street's edge`, () => {
    for (const w of plots.ways) {
      // Both far corners on the drawn street or within 10 cm of it, and the end's middle too.
      const [, , c2, c3] = w.ring;
      for (const [x, z] of [c2, c3, [(c2[0] + c3[0]) / 2, (c2[1] + c3[1]) / 2]]) {
        let gap = Infinity;
        for (let t = 0; t <= 0.1 + 1e-9; t += 0.02) if (onStreet(x + w.n[0] * t, z + w.n[1] * t)) gap = Math.min(gap, t);
        assert.ok(gap <= 0.1, `a ${w.kind} from (${w.from[0].toFixed(1)}, ${w.from[1].toFixed(1)}) ends short of its street at (${x.toFixed(1)}, ${z.toFixed(1)})`);
      }
    }
  });

  test(`${name}: no way runs through a wall, hedge, fence, pole or other thing, a pond, field or wood, or near our models`, () => {
    const ponds = (input.dips ?? []).filter((d) => d.water !== undefined);
    const things = input.things;
    for (const w of plots.ways) {
      const [a, b, c2, c3] = w.ring;
      const len = Math.hypot((c2[0] + c3[0]) / 2 - (a[0] + b[0]) / 2, (c2[1] + c3[1]) / 2 - (a[1] + b[1]) / 2);
      const grid = blocksOf(input);
      const close = (px, pz) => Math.abs(px - w.from[0]) < 30 && Math.abs(pz - w.from[1]) < 30;
      const wayThings = things.filter(([tx, tz]) => close(tx, tz));
      const wayPonds = ponds.filter((d) => d.rim.some(([px, pz]) => close(px, pz)));
      const at = (x, z, what) => assert.fail(`a ${w.kind} from (${w.from[0].toFixed(1)}, ${w.from[1].toFixed(1)}) through ${what} at (${x.toFixed(1)}, ${z.toFixed(1)})`);
      for (let t = 0.3; t < len - 0.1; t += 0.1) {
        for (const s of [-1, -0.5, 0, 0.5, 1]) {
          const x = (a[0] + b[0]) / 2 + w.n[0] * t + -w.n[1] * w.half * s;
          const z = (a[1] + b[1]) / 2 + w.n[1] * t + w.n[0] * w.half * s;
          const y = groundAt(x, z);
          for (const p of grid.at(x, z)) {
            const cover = p.d !== undefined && p.y1 <= 0;
            if (cover && (p.m.startsWith('field') || p.m === 'forest')) at(x, z, 'a field');
            if (!cover && (p.d !== undefined || (p.y0 < y + 1.5 && p.y1 > y - 0.05))) at(x, z, p.m);
          }
          for (const d of wayPonds) if (inside(d.rim, x, z)) at(x, z, 'a pond');
          for (const [tx, tz, r] of wayThings) if (Math.hypot(tx - x, tz - z) <= r) at(x, z, 'a small thing');
        }
      }
      for (const ring of input.keepOut) for (const [x, z] of w.ring) assert.ok(!inside(ring, x, z), `a ${w.kind} in a ring kept out at (${x.toFixed(1)}, ${z.toFixed(1)})`);
      for (const ring of input.models) {
        for (const [x, z] of [w.from, ...w.ring]) {
          let d = Infinity;
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [ax, az] = ring[j];
            const [bx, bz] = ring[i];
            const [dx, dz] = [bx - ax, bz - az];
            const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
            d = Math.min(d, Math.hypot(ax + dx * t - x, az + dz * t - z));
          }
          assert.ok(!inside(ring, x, z) && d >= 12 - 1e-6, `a ${w.kind} ${d.toFixed(1)} m from one of our models at (${x.toFixed(1)}, ${z.toFixed(1)})`);
        }
      }
    }
  });

  test(`${name}: each way meets its street at 45 degrees or more`, () => {
    for (const w of plots.ways) {
      const [, , c2, c3] = w.ring;
      // The end runs along the street's edge: its slant against the way's square end.
      const [ex, ez] = [c3[0] - c2[0], c3[1] - c2[1]];
      const across = Math.abs(ex * w.n[0] + ez * w.n[1]) / Math.hypot(ex, ez);
      assert.ok(across <= Math.cos(Math.PI / 4) + 1e-6, `a ${w.kind} from (${w.from[0].toFixed(1)}, ${w.from[1].toFixed(1)}) meets its street at a slant`);
    }
  });
}
