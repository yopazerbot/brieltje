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
const { Houses, BlockGrid, inside } = await import('./houseKeys.ts');
const { planBases, planSteps, cutAt, isPlinthOf, area, planReveals, planDownpipes, alongFace, FRAME } = await import('./housePlan.ts');
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

  const reveals = planReveals(set.openings ?? [], houses, bases, groundAt);

  test(`${name}: most windows and doors sit back in their walls, each hole on its face, clear of the others, with the wall behind it`, () => {
    const all = (set.openings ?? []).length;
    assert.ok(reveals.holes.size > 0.65 * all, `${name}: ${reveals.holes.size} of ${all} openings set back`);
    let holes = 0;
    for (const [p, faces] of reveals.faces) {
      for (const f of faces) {
        const end = f.points[f.points.length - 1].s;
        for (const h of f.holes) {
          holes++;
          assert.equal(reveals.holes.get(h.o), h);
          assert.ok(h.s0 >= 0.1 - 1e-9 && h.s1 <= end - 0.1 + 1e-9, `${name}: a hole ${h.s0.toFixed(2)} to ${h.s1.toFixed(2)} on a face ${end.toFixed(2)} long`);
          assert.ok(h.y0 >= p.y0 + 0.05 - 1e-9 && h.y1 <= p.y1 - 0.1 + 1e-9, `${name}: a hole from ${h.y0.toFixed(2)} to ${h.y1.toFixed(2)} in a wall from ${p.y0} to ${p.y1}`);
          assert.ok(h.depth >= 0.1 && h.depth <= 0.16, `${name}: a frame ${h.depth} m back`);
          // The opening itself, with its frame round it, is the hole.
          assert.ok(Math.abs(h.y1 - h.y0 - (h.o.y[1] - h.o.y[0]) - 2 * FRAME) < 1e-9);
          for (const g of f.holes) if (g !== h) assert.ok(g.s1 + 0.06 <= h.s0 || h.s1 + 0.06 <= g.s0 || g.y1 + 0.06 <= h.y0 || h.y1 + 0.06 <= g.y0, `${name}: two holes closer than 6 cm`);
          // The block's own inside behind each side of the hole, as deep as the frame sits and 10 cm more.
          for (const s of [h.s0 + 0.02, h.s1 - 0.02]) {
            const x = alongFace(f.points, s, (q) => q.x) - f.n[0] * (h.depth + 0.1);
            const z = alongFace(f.points, s, (q) => q.z) - f.n[1] * (h.depth + 0.1);
            assert.ok(inside(p.p[0], x, z), `${name}: no wall behind a hole at (${x.toFixed(1)}, ${z.toFixed(1)})`);
          }
          // A band's top keeps off the hole's edges.
          if (f.points[0].cut !== null) {
            for (const s of [h.s0, h.s1]) {
              const c = alongFace(f.points, s, (q) => q.cut);
              assert.ok(Math.abs(c - h.y0) >= 0.03 - 1e-9 && Math.abs(c - h.y1) >= 0.03 - 1e-9, `${name}: a band's top ${c.toFixed(2)} by a hole's edge`);
            }
          }
          for (const k of h.streaks) {
            assert.ok(k.s - k.half >= h.s0 && k.s + k.half <= h.s1, `${name}: a streak wider than its sill`);
            assert.ok(k.top - k.bottom >= 0.2 - 1e-9 && k.top - k.bottom <= 1.2 + 1e-9 && k.mid < k.top && k.mid > k.bottom, `${name}: a streak from ${k.top.toFixed(2)} to ${k.bottom.toFixed(2)}`);
            const x = alongFace(f.points, k.s, (q) => q.x);
            const z = alongFace(f.points, k.s, (q) => q.z);
            assert.ok(k.bottom >= groundAt(x, z) + 0.3 - 1e-9, `${name}: a streak down to the ground at (${x.toFixed(1)}, ${z.toFixed(1)})`);
            if (f.points[0].cut !== null) assert.ok(k.bottom >= alongFace(f.points, k.s, (q) => q.cut) + 0.05 - 1e-9, `${name}: a streak into the band`);
          }
        }
      }
    }
    assert.equal(holes, reveals.holes.size);
  });

  test(`${name}: the flat roofs' downpipes stand against a wall and reach the ground`, () => {
    const lids = new BlockGrid();
    for (const p of prisms) if (p.m === 'nb_roof') lids.add(p);
    const pipes = planDownpipes(prisms, set.openings ?? [], houses, lids, groundAt);
    assert.ok(pipes.size > (name === 'village' ? 500 : 80), `${name}: ${pipes.size} downpipes`);
    for (const [lid, d] of pipes) {
      assert.ok(Math.abs(d.bottom - (groundAt(d.x, d.z) - 0.05)) < 1e-9 && d.top - d.bottom >= 1.5 && d.top <= lid.y1, `${name}: a downpipe from ${d.top.toFixed(2)} to ${d.bottom.toFixed(2)}`);
      assert.ok(houses.holds(d.x - d.n[0] * 0.15, d.z - d.n[1] * 0.15, (d.top + d.bottom) / 2), `${name}: a downpipe off its wall at (${d.x.toFixed(1)}, ${d.z.toFixed(1)})`);
      assert.ok(!houses.wallsAt(d.x, d.z).length, `${name}: a downpipe in a wall at (${d.x.toFixed(1)}, ${d.z.toFixed(1)})`);
    }
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
