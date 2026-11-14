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
const { Houses, inside } = await import('./houseKeys.ts');
const { planBases, planSteps, cutAt, isPlinthOf, area } = await import('./housePlan.ts');
const { makeTerrain } = await import('../../shared/terrain.mjs');

const read = (file) => JSON.parse(fs.readFileSync(new URL(file, import.meta.url), 'utf8'));
const shell = read('../data/house_shell.json');
const terrain = makeTerrain(read('../../shared/terrain.json'));
const groundAt = (x, z) => shell.ground + terrain.height(x, z);
// The two sets the houses are built from: the village and the ring round the home.
const sets = { village: read('../data/village.json'), ring: shell.surroundings };
const isBrick = (m) => /^nb_(red|brown|yellow|white|grey|dark)$/.test(m);

for (const [name, set] of Object.entries(sets)) {
  const prisms = set.prisms ?? [];
  const houses = new Houses(prisms);
  const bases = planBases(prisms, set.openings ?? [], houses, groundAt);

  test(`${name}: every plinth stays within 0.8 m of its own ground, all along its wall`, () => {
    let bands = 0;
    for (const [, b] of bases) {
      bands++;
      const ring = b.ring;
      for (let i = 0; i < ring.length; i++) {
        const [ax, az] = ring[i];
        const [bx, bz] = ring[(i + 1) % ring.length];
        const ca = cutAt(b, groundAt(ax, az));
        const cb = cutAt(b, groundAt(bx, bz));
        for (let s = 0; s <= 8; s++) {
          const t = s / 8;
          const x = ax + (bx - ax) * t;
          const z = az + (bz - az) * t;
          const over = ca + (cb - ca) * t - groundAt(x, z); // the cut is straight between two points of the outline
          assert.ok(over <= 0.8 + 1e-6, `${name}: a band ${over.toFixed(2)} m over the ground at (${x.toFixed(1)}, ${z.toFixed(1)})`);
        }
      }
    }
    assert.ok(bands > (name === 'village' ? 800 : 100), `${name}: ${bands} walls with a base`);
  });

  test(`${name}: no plinth reaches a ground-floor window's sill`, () => {
    for (const o of set.openings ?? []) {
      if (o.k !== 'w' || o.y[1] - o.y[0] >= 1.9) continue;
      const l = Math.hypot(o.n[0], o.n[1]) || 1;
      const x = (o.a[0] + o.b[0]) / 2 - (o.n[0] / l) * 0.3;
      const z = (o.a[1] + o.b[1]) / 2 - (o.n[1] / l) * 0.3;
      for (const [w, b] of bases) {
        if (b.kind === 'none' || o.y[0] < w.y0 || o.y[0] > w.y1 || !inside(w.p[0], x, z)) continue;
        // The highest the cut gets anywhere on this wall, 10 cm or more under the sill (5 to 10 cm under the window).
        const top = Math.max(...b.ring.map(([px, pz]) => cutAt(b, groundAt(px, pz))));
        assert.ok(top <= o.y[0] - 0.2 + 1e-6, `${name}: a plinth at ${top.toFixed(2)} by a window at ${o.y[0].toFixed(2)} (${x.toFixed(1)}, ${z.toFixed(1)})`);
      }
    }
  });

  test(`${name}: every door step stands on the ground, and no riser is over 18 cm`, () => {
    let flights = 0;
    for (const o of set.openings ?? []) {
      const steps = planSteps(o, houses, groundAt);
      if (steps.length > 1) flights++;
      const l = Math.hypot(o.n[0], o.n[1]);
      const w = Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]);
      steps.forEach((s, k) => {
        for (const t of [s.from, (s.from + s.to) / 2, s.to]) {
          for (const u of [-0.5, 0, 0.5]) {
            const x = (o.a[0] + o.b[0]) / 2 + (o.n[0] / l) * t + ((o.b[0] - o.a[0]) / w) * u * (w + 0.3);
            const z = (o.a[1] + o.b[1]) / 2 + (o.n[1] / l) * t + ((o.b[1] - o.a[1]) / w) * u * (w + 0.3);
            assert.ok(s.bottom <= groundAt(x, z) - 0.04, `${name}: a step over the ground at (${x.toFixed(1)}, ${z.toFixed(1)})`);
          }
        }
        if (k) assert.ok(steps[k - 1].top - s.top <= 0.18 + 1e-6, `${name}: a riser of ${(steps[k - 1].top - s.top).toFixed(2)} m`);
      });
      if (steps.length === 1) assert.ok(steps[0].top - steps[0].bottom <= 0.35 + 0.3, `${name}: one step ${(steps[0].top - steps[0].bottom).toFixed(2)} m high`);
    }
    assert.ok(flights > 0, `${name}: some doors get a flight`);
  });

  test(`${name}: no band is painted over a plinth the data has`, () => {
    const brick = prisms.filter((p) => isBrick(p.m) && !p.d);
    const boxOf = (p) => {
      const xs = p.p[0].map((q) => q[0]);
      const zs = p.p[0].map((q) => q[1]);
      return [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
    };
    const keys = new Set([...bases.keys()].map((w) => houses.keyOf(w)));
    for (const w of prisms.filter((p) => isBrick(p.m) && !p.d && area(p.p[0]) >= 12)) {
      if (!keys.has(houses.keyOf(w))) continue; // a house with a band on some wall: none of its walls has a plinth in the data
      const [x0, z0, x1, z1] = boxOf(w);
      for (const q of brick) {
        const [a0, b0, a1, b1] = boxOf(q);
        if (a0 > x1 || a1 < x0 || b0 > z1 || b1 < z0) continue;
        if (w.y0 > Math.max(...w.p[0].map(([x, z]) => groundAt(x, z))) + 0.25) continue; // not on the ground
        assert.ok(!isPlinthOf(q, w), `${name}: a band over the data's plinth at (${q.p[0][0][0]}, ${q.p[0][0][1]})`);
      }
    }
  });
}
