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
const { Houses, inside } = await import('./houseKeys.ts');
const { planBases } = await import('./housePlan.ts');
const { makeTerrain } = await import('../../shared/terrain.mjs');

const read = (file) => JSON.parse(fs.readFileSync(new URL(file, import.meta.url), 'utf8'));
const village = read('../data/village.json');
const shell = read('../data/house_shell.json');
const detail = read('../data/roadDetail.json');
const roads = read('../data/roads.json');
const football = read('../../shared/football.json');
const terrain = makeTerrain(read('../../shared/terrain.json'));
const groundAt = (x, z) => shell.ground + terrain.height(x, z);

// The village as world/villagePlots.ts hands it over (without the models here: their rings come from the models).
const prisms = village.prisms;
const hidden = new Set(detail.hide);
const streetCovers = prisms.filter((p) => hidden.has(`${p.m}|${p.p[0][0][0]}|${p.p[0][0][1]}|${p.p[0].length}`));
const houses = new Houses(prisms);
const keepOut = [...(village.landmarks ?? []).map((l) => l.p), football.platform.ring, football.plot];
const input = {
  prisms,
  streetCovers,
  openings: village.openings,
  trees: village.trees,
  dips: village.dips ?? [],
  runs: detail.runs,
  boxes: roads.boxes,
  standing: planBases(prisms, village.openings, houses, groundAt).keys(),
  keyAt: (x, z) => houses.at(x, z),
  keepOut,
  groundAt,
};
const plots = plotCovers(input);

test('the paths and drives come out about as counted when they were planned', () => {
  assert.ok(plots.paths >= 230 && plots.paths <= 290, `${plots.paths} paths`);
  assert.ok(plots.drives >= 50 && plots.drives <= 80, `${plots.drives} drives`);
  assert.equal(plots.covers.length, plots.paths + plots.drives + plots.strips);
  for (const c of plots.covers) {
    assert.ok(['pave_warm', 'pave_light', 'gravel', 'concrete'].includes(c.m), c.m);
    assert.ok(c.d !== undefined && c.y1 <= 0, 'a ground cover, under the ground as the data\'s');
  }
});

test('the same data gives the same plots', () => {
  assert.deepEqual(plotCovers({ ...input, standing: planBases(prisms, village.openings, houses, groundAt).keys() }).covers, plots.covers);
});

test('no way runs through a wall, hedge, fence, pond, field, wood or a ring kept out; each ends at a street', () => {
  const stations = [];
  for (const r of detail.runs) for (let k = 0; k < r.p.length / 2; k++) stations.push([r.p[2 * k], r.p[2 * k + 1], Math.max(r.w[2 * k] + r.q[2 * k], r.w[2 * k + 1] + r.q[2 * k + 1])]);
  const streets = [...streetCovers, ...prisms.filter((p) => p.d !== undefined && p.y1 <= 0 && (p.m === 'road' || p.m === 'pave_grey'))];
  const atStreet = (x, z) => stations.some(([sx, sz, w]) => Math.hypot(sx - x, sz - z) <= w) || streets.some((p) => inside(p.p[0], x, z));
  const ponds = (village.dips ?? []).filter((d) => d.water !== undefined);
  for (const w of plots.ways) {
    const len = Math.hypot(w.to[0] - w.from[0], w.to[1] - w.from[1]);
    assert.ok(len <= (w.kind === 'drive' ? 16 : 14) + 1e-6, `${w.kind} ${len.toFixed(1)} m`);
    const n = [(w.to[0] - w.from[0]) / len, (w.to[1] - w.from[1]) / len];
    const side = [-n[1], n[0]];
    // Within 0.5 m past its end the centre line is on a street.
    let reached = false;
    for (let t = len; t <= len + 0.5; t += 0.1) if (atStreet(w.from[0] + n[0] * t, w.from[1] + n[1] * t)) reached = true;
    assert.ok(reached, `a ${w.kind} from (${w.from[0].toFixed(1)}, ${w.from[1].toFixed(1)}) ends short of a street`);
    const near = prisms.filter((p) => Math.abs(p.p[0][0][0] - w.from[0]) < 60 && Math.abs(p.p[0][0][1] - w.from[1]) < 60);
    for (let t = 0.3; t < len; t += 0.25) {
      for (const s of [0, -w.half, w.half]) {
        const x = w.from[0] + n[0] * t + side[0] * s;
        const z = w.from[1] + n[1] * t + side[1] * s;
        const y = groundAt(x, z);
        for (const p of near) {
          if (!inside(p.p[0], x, z)) continue;
          const cover = p.d !== undefined && p.y1 <= 0;
          assert.ok(!(cover && (p.m.startsWith('field') || p.m === 'forest')), `a ${w.kind} through a field at (${x.toFixed(1)}, ${z.toFixed(1)})`);
          assert.ok(cover || (p.d === undefined && !(p.y0 < y + 1.5 && p.y1 > y + 0.25)), `a ${w.kind} through ${p.m} at (${x.toFixed(1)}, ${z.toFixed(1)})`);
        }
        for (const ring of keepOut) assert.ok(!inside(ring, x, z), `a ${w.kind} in a ring kept out at (${x.toFixed(1)}, ${z.toFixed(1)})`);
        for (const d of ponds) assert.ok(!inside(d.rim, x, z), `a ${w.kind} through a pond at (${x.toFixed(1)}, ${z.toFixed(1)})`);
      }
    }
  }
});
