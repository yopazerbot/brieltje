import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Cuts, GroundLayers, RANK, area2, coverPieces, coverRank, cutAsks, cutCovers, minus, overlaps, packAsks, packCovers } from './groundLayers.ts';

const area = (pieces) => pieces.reduce((s, p) => s + Math.abs(area2(p)) / 2, 0);
/** Whether (x, z) lies in a convex polygon. */
const inside = (p, x, z) => {
  const turn = Math.sign(area2(p));
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const c = (p[i][0] - p[j][0]) * (z - p[j][1]) - (p[i][1] - p[j][1]) * (x - p[j][0]);
    if (c * turn < 0) return false;
  }
  return true;
};

test('a square less a triangle over its corner keeps the rest of its area, in convex pieces turned as it is', () => {
  const square = [[0, 0], [4, 0], [4, 4], [0, 4]];
  const corner = [[2, -1], [5, -1], [5, 2]];
  const pieces = minus(square, corner);
  // The triangle covers the part of the square under the line from (2, -1) to (5, 2): a corner of 1 by 1.
  assert.ok(Math.abs(area(pieces) - (16 - 0.5)) < 1e-9);
  for (const p of pieces) assert.ok(area2(p) > 0, 'the pieces keep the square\'s turn');
  // No piece covers a point under the triangle, and every point of the square outside it is in one piece.
  for (let x = 0.05; x < 4; x += 0.1) {
    for (let z = 0.05; z < 4; z += 0.1) {
      const under = inside(corner, x, z);
      const n = pieces.filter((p) => inside(p, x, z)).length;
      assert.equal(n, under ? 0 : 1, `at ${x}, ${z}`);
    }
  }
});

test('surfaces that only touch along an edge are not cut', () => {
  const a = [[0, 0], [2, 0], [2, 2]];
  const b = [[0, 0], [2, 2], [0, 2]];
  assert.equal(overlaps(a, b), false);
  const layers = new GroundLayers();
  layers.claim(a, RANK.model, layers.group());
  const cut = layers.cut(b, RANK.paving, layers.group());
  assert.equal(cut.length, 1);
  assert.equal(cut[0], b);
});

test('the higher rank wins, and of one rank the one claimed first', () => {
  const layers = new GroundLayers();
  const road = [[0, 0], [10, 0], [10, 2]];
  const paving = [[0, 0], [10, 0], [10, 2]];
  const gRoad = layers.group();
  const gPaving = layers.group();
  layers.claim(road, RANK.carriageway, gRoad);
  layers.claim(paving, RANK.paving, gPaving);
  assert.equal(layers.cut(road, RANK.carriageway, gRoad)[0], road, 'the road keeps its spot');
  assert.equal(layers.cut(paving, RANK.paving, gPaving).length, 0, 'the paving under it goes');
  // Two of one rank: the first stays whole, the second gives way.
  const g2 = layers.group();
  layers.claim(road, RANK.carriageway, g2);
  assert.equal(layers.cut(road, RANK.carriageway, gRoad)[0], road);
  assert.equal(layers.cut(road, RANK.carriageway, g2).length, 0);
});

test('the open data\'s covers by what lies on top: road over paving over gravel over fields; a verge under paving', () => {
  assert.ok(coverRank('road') > coverRank('pave_light'));
  assert.ok(coverRank('pave_light') > coverRank('gravel'));
  assert.ok(coverRank('gravel') > coverRank('track'));
  assert.ok(coverRank('track') > coverRank('forest'));
  assert.ok(RANK.verge < coverRank('pave_warm'));
  assert.ok(RANK.carriageway > coverRank('road'));
  assert.equal(coverRank('nb_hedge'), undefined);
});

test('the village\'s covers, claimed and cut in order, leave one surface per spot with none of their ground lost', () => {
  const village = JSON.parse(readFileSync(new URL('../data/village.json', import.meta.url), 'utf8'));
  // Fan the outer rings that are convex enough to fan (most of the open data's covers are not; this is a sample).
  const covers = village.prisms.filter((p) => p.d !== undefined && p.y1 - p.y0 <= 0.15 && coverRank(p.m) !== undefined && p.p.length === 1);
  const layers = new GroundLayers();
  const fans = [];
  for (const p of covers) {
    const ring = p.p[0];
    const turn = Math.sign(area2(ring));
    let convex = ring.length >= 3 && ring.length <= 12;
    for (let i = 0; i < ring.length && convex; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length], c = ring[(i + 2) % ring.length];
      if (((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) * turn < -1e-9) convex = false;
    }
    if (!convex) continue;
    const group = layers.group();
    const tris = [];
    for (let k = 1; k + 1 < ring.length; k++) tris.push([ring[0], ring[k], ring[k + 1]]);
    for (const t of tris) layers.claim(t, coverRank(p.m), group);
    fans.push({ rank: coverRank(p.m), group, tris });
  }
  assert.ok(fans.length > 300, `${fans.length} covers to try`);
  // Each kept piece is claimed by its own cover and beaten by none: sample its middle against all the others.
  const kept = [];
  for (const f of fans) for (const t of f.tris) for (const piece of layers.cut(t, f.rank, f.group)) kept.push({ ...f, piece });
  const mid = (p) => [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];
  let doubled = 0;
  for (let i = 0; i < kept.length; i += 7) {
    const [x, z] = mid(kept[i].piece);
    for (let j = 0; j < kept.length; j++) if (j !== i && Math.abs(area2(kept[j].piece)) > 1e-6 && inside(kept[j].piece, x, z)) doubled++;
  }
  assert.equal(doubled, 0, 'no spot is drawn twice');
  // The ground drawn is as large as the union of the covers: compare with the sum less the overlaps' samples.
  const before = fans.reduce((s, f) => s + area(f.tris), 0);
  const after = area(kept.map((k) => k.piece));
  assert.ok(after <= before + 1e-6 && after > before * 0.95, `${after.toFixed(1)} of ${before.toFixed(1)} m²`);
});

/** A few claims of every kind, some with heights, over a 30 m square. */
function someClaims() {
  const layers = new GroundLayers();
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const ranks = [RANK.model, RANK.carriageway, RANK.pavement, RANK.paving, RANK.gravel];
  for (let i = 0; i < 400; i++) {
    const x = rnd() * 30, z = rnd() * 30;
    const t = [[x, z], [x + 1 + rnd() * 4, z + rnd()], [x + rnd(), z + 1 + rnd() * 4]];
    const rank = ranks[i % ranks.length];
    const ys = rank === RANK.model ? t.map(() => rnd() * 0.1) : undefined;
    layers.claim(t, rank, layers.group(), ys, rank === RANK.model && i % 3 === 0);
  }
  return layers;
}

test('cuts worked out ahead (as the ground\'s worker does) read back the very pieces, and whole ones as themselves', () => {
  const layers = someClaims();
  const asks = [];
  for (let i = 0; i < 200; i++) {
    const x = (i % 20) * 1.5, z = Math.floor(i / 20) * 3;
    const t = [[x, z], [x + 2, z], [x + 1, z + 2]];
    asks.push(i % 4 === 0 ? { t, rank: RANK.model, group: 1e6 + i, ys: [0.02, 0.05, 0.03] } : { t, rank: [RANK.pavement, RANK.paving, RANK.verge][i % 3], group: 1e6 + i });
  }
  const ahead = new Cuts(cutAsks(layers, packAsks(asks)));
  let cut = 0;
  for (const a of asks) {
    const now = layers.cut(a.t, a.rank, a.group, a.ys);
    const read = ahead.next(a.t);
    if (now.length === 1 && now[0] === a.t) assert.equal(read[0], a.t, 'whole: the same polygon');
    else {
      cut++;
      assert.deepEqual(read, now);
    }
  }
  ahead.done();
  assert.ok(cut > 20, `${cut} of them cut`);
});

test('a cover\'s pieces cut ahead are those its build cuts, in the same order', () => {
  const layers = someClaims();
  const grid = { x0: -0.5, z0: -0.25, step: 4 };
  const covers = [
    { tris: [[[1, 1], [25, 2], [3, 27]], [[25, 2], [28, 28], [3, 27]]], cell: 8, precise: false, rank: RANK.paving, group: 5e6 },
    { tris: [[[10, 10], [20, 11], [12, 19]]], cell: 4, precise: true, rank: RANK.gravel, group: Infinity },
  ];
  const { out, starts } = cutCovers(layers, packCovers(covers, grid));
  covers.forEach((c, i) => {
    const ahead = new Cuts(out, starts[i], i + 1 < covers.length ? starts[i + 1] : out.length);
    let n = 0;
    coverPieces(c.tris, c.cell, c.precise, grid, (h, fi) => {
      const now = layers.cut(h, c.rank, c.group + fi);
      const read = ahead.next(h);
      assert.deepEqual(read, now.length === 1 && now[0] === h ? [h] : now);
      n++;
    });
    ahead.done();
    assert.ok(n > 3);
  });
});

const near = [[12, 12], [15, 12.5], [13, 15]];
const far = [[25, 25], [28, 25.5], [26, 28]];

test('claims copied to another set (the worker\'s), in runs, cut the same', () => {
  const layers = someClaims();
  const copy = new GroundLayers();
  copy.addClaims(layers.claimsFrom(0, 150));
  copy.addClaims(layers.claimsFrom(150));
  assert.equal(copy.size, layers.size);
  for (const [t, rank] of [[near, RANK.paving], [far, RANK.gravel], [near, RANK.verge]]) assert.deepEqual(copy.cut(t, rank, 1e7), layers.cut(t, rank, 1e7));
});

test('claims let go but round a spot still cut the same there, and nothing elsewhere', () => {
  const layers = someClaims();
  const before = layers.cut(near, RANK.paving, 1e7);
  layers.release([[10, 10, 17, 17]]);
  assert.ok(layers.size < 150, `${layers.size} kept`);
  assert.deepEqual(layers.cut(near, RANK.paving, 1e7), before);
  assert.equal(layers.cut(far, RANK.gravel, 1e7)[0], far, 'away from the spot nothing is left to cut it');
});
