// The ponds' and ditches' banks and water (world/bankShape.ts) against every pond and ditch in the data: the water
// never lies above a bank and never runs uphill along a ditch; the walked floor (world/collision.ts) is the drawn
// bank; the water is where the bank is under its level and nowhere else (world/water.ts); every pond is deep
// enough to swim in and no ditch is; the rim, where the ground is cut, is the relief itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import * as THREE from 'three';
import { makeTerrain } from '../../shared/terrain.mjs';

// The modules import each other without extensions, as Vite has them: add .ts here.
registerHooks({
  resolve(specifier, context, next) {
    if (/^\.\.?\//.test(specifier) && !/\.(m?js|ts|json)$/.test(specifier)) specifier += '.ts';
    return next(specifier, context);
  },
});
const { bankOf, bankAt } = await import('./bankShape.ts');

/** A module's code without its imports and exports, run with `deps` in scope; returns the names asked for. */
function load(file, deps, names) {
  const src = readFileSync(new URL(file, import.meta.url), 'utf8')
    .replace(/^import[^;]*;\s*$/gm, '')
    .replace(/^export (?=(class|function|const|interface|type) )/gm, '');
  const code = stripTypeScriptTypes(src, { mode: 'transform' });
  return new Function(...Object.keys(deps), `${code}\nreturn { ${names.join(', ')} };`)(...Object.values(deps));
}

const read = (file) => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
const terrain = makeTerrain(read('../../shared/terrain.json'));
const shell = read('../data/house_shell.json');
const village = read('../data/village.json');
const GROUND = shell.ground;
const dips = [...(shell.dips ?? []), ...(village.dips ?? [])].filter((d) => d.water);
const banks = dips.map((d) => bankOf(d, GROUND, terrain.height));

const { RoofField, climb } = load('./roofField.ts', {}, ['RoofField', 'climb']);
const { World } = load('./collision.ts', { terrain, RoofField, climb, bankAt, bankOf }, ['World']);
const water = load('./water.ts', { THREE, bankAt, bankOf, terrain, mood: { current: 'sunny', next: 'sunny', blend: 0 } }, ['addWater', 'waterLevel', 'wetGround', 'FLOAT']);
for (let i = 0; i < dips.length; i++) water.addWater(dips[i], banks[i].line, banks[i].lowLevel, banks[i]);

function inside(x, z, r) {
  let hit = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if (r[i][1] > z !== r[j][1] > z && x < ((r[j][0] - r[i][0]) * (z - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) hit = !hit;
  }
  return hit;
}

/** Points spread over a bank's box, the same every run. */
function* samples(b, n) {
  let s = 12345;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < n; k++) yield [b.minX + rand() * (b.maxX - b.minX), b.minZ + rand() * (b.maxZ - b.minZ)];
}

/** The drawn surface at (x, z), found among all the bank's triangles (not through its grid of squares). */
function drawnAt(b, x, z) {
  for (let t = 0; t < b.tris.length; t += 3) {
    const [p, q, r] = [b.tris[t], b.tris[t + 1], b.tris[t + 2]];
    const d = (b.z[q] - b.z[r]) * (b.x[p] - b.x[r]) + (b.x[r] - b.x[q]) * (b.z[p] - b.z[r]);
    if (!d) continue;
    const u = ((b.z[q] - b.z[r]) * (x - b.x[r]) + (b.x[r] - b.x[q]) * (z - b.z[r])) / d;
    const v = ((b.z[r] - b.z[p]) * (x - b.x[r]) + (b.x[p] - b.x[r]) * (z - b.z[r])) / d;
    if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
    return u * b.y[p] + v * b.y[q] + (1 - u - v) * b.y[r];
  }
  return null;
}

test('every pond and ditch in the data has banks', () => {
  assert.ok(dips.length >= 40, `${dips.length} ponds and ditches`);
  for (const b of banks) assert.ok(b && b.tris.length > 0 && b.wet.length > 0);
});

test('the water never lies above either bank, and never runs uphill along a ditch', () => {
  for (const b of banks) {
    const K = b.across;
    for (let j = 0; j < b.stations; j++) {
      const level = b.level[j * K];
      const lower = Math.min(b.y[j * K], b.y[j * K + K - 1]);
      assert.ok(level <= lower - (b.pond ? 0.15 : 0.25), `${b.pond ? 'pond' : 'ditch'} at ${b.x[j * K].toFixed(1)}, ${b.z[j * K].toFixed(1)}: water ${level.toFixed(2)}, bank ${lower.toFixed(2)}`);
    }
    // Along a ditch, from its upper end (0 m along) down: never higher than upstream.
    const order = Array.from({ length: b.stations }, (_, j) => j).sort((p, q) => b.along[p * K] - b.along[q * K]);
    for (let i = 1; i < order.length; i++) assert.ok(b.level[order[i] * K] <= b.level[order[i - 1] * K] + 1e-6, 'uphill');
  }
});

test('a long ditch on sloping ground falls along its length, near its banks all the way', () => {
  // The one along the field to the north-west of the plot: its banks fall some 5 m from one end to the other.
  const i = banks.findIndex((b) => !b.pond && b.maxZ - b.minZ > 250);
  const b = banks[i];
  const K = b.across;
  const fall = Math.max(...Array.from({ length: b.stations }, (_, j) => b.level[j * K])) - b.lowLevel;
  assert.ok(fall > 3, `falls ${fall.toFixed(2)} m`);
  for (let j = 0; j < b.stations; j++) {
    const lower = Math.min(b.y[j * K], b.y[j * K + K - 1]);
    assert.ok(lower - b.level[j * K] < 1.2, `the water ${(lower - b.level[j * K]).toFixed(2)} m under the bank`);
  }
});

test('the walked floor is the drawn bank, and the rim the relief itself', () => {
  const world = new World([], GROUND);
  world.addDips(dips);
  let checked = 0;
  for (let i = 0; i < dips.length; i++) {
    const b = banks[i];
    for (const [x, z] of samples(b, 60)) {
      if (!inside(x, z, dips[i].rim)) continue;
      const drawn = drawnAt(b, x, z);
      if (drawn === null) continue; // a sliver of the rim's corner the triangles leave out: the relief there
      const walked = world.groundAt(x, z, 50, 100).y;
      assert.ok(Math.abs(walked - drawn) < 0.05, `at ${x.toFixed(2)}, ${z.toFixed(2)}: walked ${walked.toFixed(3)}, drawn ${drawn.toFixed(3)}`);
      checked++;
    }
    for (let j = 0; j < b.stations; j++) {
      for (const v of [j * b.across, j * b.across + b.across - 1]) assert.ok(Math.abs(b.y[v] - GROUND - terrain.height(b.x[v], b.z[v])) < 1e-4, 'the rim off the relief');
    }
  }
  assert.ok(checked > 500, `${checked} points`);
});

test('the water is where the bank is under its level, and dry land has none', () => {
  for (let i = 0; i < dips.length; i++) {
    const b = banks[i];
    for (const [x, z] of samples(b, 40)) {
      const level = water.waterLevel(x, z);
      const p = bankAt(b, x, z);
      if (!inside(x, z, dips[i].rim)) {
        // Outside every rim: dry (the boxes of two ditches can overlap).
        if (!dips.some((d) => inside(x, z, d.rim))) assert.equal(level, null, `water outside the rim at ${x}, ${z}`);
        continue;
      }
      if (p && p.level > p.y + 0.01) assert.ok(level !== null && Math.abs(level - p.level) < 1e-6);
      if (p && p.level < p.y - 0.01) assert.equal(level, null);
    }
    // A metre outside the rim, on the lawn: dry.
    const [rx, rz] = dips[i].rim[0];
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const l = Math.hypot(rx - cx, rz - cz);
    const ox = rx + ((rx - cx) / l) * 1;
    const oz = rz + ((rz - cz) / l) * 1;
    if (!dips.some((d) => inside(ox, oz, d.rim))) assert.equal(water.waterLevel(ox, oz), null);
  }
});

test('every pond is deep enough to swim in, and no ditch is', () => {
  const world = new World([], GROUND);
  world.addDips(dips);
  for (let i = 0; i < dips.length; i++) {
    const b = banks[i];
    let swim = false;
    let wade = false;
    for (const [x, z] of samples(b, 400)) {
      if (!inside(x, z, dips[i].rim)) continue;
      const ground = world.groundAt(x, z, 50, 100);
      const wet = water.wetGround(x, z, { ...ground });
      if (!wet) continue;
      wade = true;
      swim ||= wet.swimming;
    }
    assert.ok(wade, `no water to walk into in the ${b.pond ? 'pond' : 'ditch'} at ${b.minX.toFixed(0)}, ${b.minZ.toFixed(0)}`);
    assert.equal(swim, b.pond, `${b.pond ? 'pond' : 'ditch'} at ${b.minX.toFixed(0)}, ${b.minZ.toFixed(0)}`);
  }
});
