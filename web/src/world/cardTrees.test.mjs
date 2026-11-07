import test from 'node:test';
import assert from 'node:assert/strict';
import { cardCrown, cardTrunk, crownFit, HEIGHT, Kind, KINDS, TRUNKS, treeKind, VARIANTS } from './cardTrees.ts';

const finite = (g, name) => [...g.getAttribute(name).array].every(Number.isFinite);

test('every kind of crown is finite, within its triangle budget, its cards inside their atlas square', () => {
  for (let kind = 0; kind < KINDS; kind++) for (let v = 0; v < VARIANTS[kind]; v++) for (const far of [false, true]) {
    const { cards, branches } = cardCrown(kind, v, far);
    const triangles = cards.index.count / 3;
    assert.ok(triangles >= (far ? 40 : 150), `kind ${kind} ${far ? 'far' : 'near'}: ${triangles} triangles is too thin`);
    assert.ok(triangles <= (far ? 400 : 1000), `kind ${kind} ${far ? 'far' : 'near'}: ${triangles} triangles`);
    for (const name of ['position', 'normal', 'uv', 'color']) assert.ok(finite(cards, name), `${name} of kind ${kind}`);
    assert.ok([...cards.getAttribute('uv').array].every((u) => u >= 0 && u <= 1));
    const box = cards.boundingBox;
    // The crown stays within its design: 1 across (with lumps), HEIGHT up and down from its middle.
    assert.ok(box.max.y <= HEIGHT[kind] * 1.25 && box.min.y >= -HEIGHT[kind] * 1.3, `kind ${kind} height ${box.min.y}..${box.max.y}`);
    assert.ok(Math.max(-box.min.x, box.max.x, -box.min.z, box.max.z) <= 1.45, `kind ${kind} width`);
    assert.equal(branches === null, far, 'branches only on the near crowns');
    if (branches) assert.ok(finite(branches, 'position') && branches.index.count / 3 <= 900);
  }
});

test('trunks are small and finite', () => {
  for (let k = 0; k < TRUNKS; k++) {
    const g = cardTrunk(k);
    assert.ok(g.index.count / 3 <= 100);
    for (const name of ['position', 'normal', 'uv', 'color']) assert.ok(finite(g, name));
  }
});

test('kinds: the Sparrenhof wood is mostly spruce, other woods mostly broad-leaved, and the same tree is always the same kind', () => {
  const count = (spots, wood) => {
    const n = new Array(KINDS).fill(0);
    for (const t of spots) n[treeKind(t, wood)]++;
    return n;
  };
  const near = Array.from({ length: 400 }, (_, i) => ({ x: 600 + (i % 20) * 3.1, z: 930 + Math.floor(i / 20) * 2.9, h: 25, r: 4 }));
  const spruce = count(near, true);
  assert.ok(spruce[Kind.Spruce] > 300, `spruces round the Sparrenhof: ${spruce}`);
  const other = Array.from({ length: 400 }, (_, i) => ({ x: -200 + (i % 20) * 3.1, z: 100 + Math.floor(i / 20) * 2.9, h: 22, r: 4 }));
  const mixed = count(other, true);
  assert.ok(mixed[Kind.Broad] > 200 && mixed[Kind.Spruce] < 60, `other woods: ${mixed}`);
  const t = { x: 12.3, z: -45.6, h: 9, r: 3 };
  assert.equal(treeKind(t, false), treeKind({ ...t }, false));
});

test('a crown fits its tree: its top near the tree top, a poplar narrow, a spruce in a wood bare below', () => {
  for (let kind = 0; kind < KINDS; kind++) {
    const t = { x: 1, z: 2, h: 20, r: 4 };
    const fit = crownFit(kind, t, 5.2, false);
    assert.ok(Math.abs(fit.middle + fit.half - t.h) < 0.01);
    assert.ok(fit.radius > 0 && fit.half > 0);
  }
  assert.ok(crownFit(Kind.Poplar, { x: 0, z: 0, h: 25, r: 4.5 }, 6.5, false).radius < 3.3);
  const spruce = crownFit(Kind.Spruce, { x: 0, z: 0, h: 25, r: 4.5 }, 6.5, true);
  assert.ok(spruce.middle - spruce.half > 8, 'a spruce in a wood loses its low branches');
});
