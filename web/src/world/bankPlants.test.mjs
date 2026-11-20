import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FIELDS, GRASS, insideRings, KINDS, layout, MAX_DEPTH, REED, ringDistance, settle, VARIANTS } from './bankPlantsPlan.ts';

// The plants along the water (tools/bank_plants.py, web/public/models/bank-plants.glb) as world/bankPlants.ts reads
// them, and where world/bankPlantsPlan.ts puts them along the data's ponds and ditches.
const bytes = readFileSync(new URL('../../public/models/bank-plants.glb', import.meta.url));
const { scene } = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
const village = JSON.parse(readFileSync(new URL('../data/village.json', import.meta.url), 'utf8'));
const house = JSON.parse(readFileSync(new URL('../data/house_shell.json', import.meta.url), 'utf8'));

const triangles = (o) => {
  let n = 0;
  o.traverse((m) => {
    if (m.isMesh) n += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
  });
  return n;
};

/** Triangles of each model, by kind and variant: [near, far]. */
const tris = KINDS.map((kind, k) => Array.from({ length: VARIANTS[k] }, (_, v) => [triangles(scene.getObjectByName(`${kind}${v + 1}`)), triangles(scene.getObjectByName(`${kind}${v + 1}Far`))]));

test('the models: every kind near and far, coloured on their corners, no image, within their triangles', () => {
  // Read straight from the file: no image, texture or sampler anywhere in it.
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + bytes.readUInt32LE(12))));
  for (const key of ['images', 'textures', 'samplers']) assert.ok(!json[key]?.length, `no ${key}`);
  assert.ok(bytes.length < 400 * 1024, `${bytes.length} bytes`);
  // Near: the reed clump 800 to 1500, the rest a few hundred; far: a few dozen to about a hundred.
  const near = [[800, 1500], [150, 800], [150, 800], [150, 500], [80, 400]];
  KINDS.forEach((kind, k) => {
    for (let v = 1; v <= VARIANTS[k]; v++) {
      for (const far of [false, true]) {
        const name = `${kind}${v}${far ? 'Far' : ''}`;
        const o = scene.getObjectByName(name);
        assert.ok(o, name);
        o.traverse((m) => m.isMesh && assert.ok(m.geometry.attributes.color, `${name}: a colour on its corners`));
        const n = tris[k][v - 1][far ? 1 : 0];
        const [lo, hi] = far ? [20, 120] : near[k];
        assert.ok(n >= lo && n <= hi, `${name}: ${n} triangles`);
      }
    }
  });
});

// A stand-in for the world: flat ground, each dip's sides sloping 1:1 to its bottom (world/collision.ts baseAt), its
// water at its level inside its water line (world/water.ts waterLine), and a square of paving where a test lays it.
function fakeWorld(dips, paving) {
  const bodies = dips.map((d) => {
    const t = (d.water ?? 0) / d.depth;
    const xs = d.rim.map((p) => p[0]);
    const zs = d.rim.map((p) => p[1]);
    const box = [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
    return { d, box, water: d.water ? d.rim.map(([x, z], i) => [x + (d.bottom[i][0] - x) * t, z + (d.bottom[i][1] - z) * t]) : null };
  });
  const near = (b, x, z) => x >= b.box[0] && x <= b.box[2] && z >= b.box[1] && z <= b.box[3];
  const bed = (x, z) => {
    for (const b of bodies) {
      const d = b.d;
      if (!near(b, x, z) || !insideRings(x, z, [d.rim])) continue;
      return insideRings(x, z, [d.bottom]) ? -d.depth : -Math.min(d.depth, ringDistance(x, z, d.rim));
    }
    return 0;
  };
  const level = (x, z) => {
    for (const b of bodies) if (b.water && near(b, x, z) && insideRings(x, z, [b.water])) return -b.d.water;
    return null;
  };
  const open = (x, z) => !paving.some((p) => insideRings(x, z, [p]));
  return { bed, level, open };
}

const lawnsOf = (grass) => (x, z) => (grass?.lawns ?? []).some((l) => insideRings(x, z, l.p));

test('along each pond and ditch: off the paving, round its rim, rooted no deeper than each kind may stand, in budget', () => {
  const report = [];
  for (const [label, dips, grass] of [['house', house.dips, house.surroundings.grass], ['village', village.dips, village.grass]]) {
    const bodies = dips.filter((d) => d.water);
    for (const d of bodies) {
      // Paving laid over the land round its first rim point, as a drive or a terrace coming down to the water.
      const [px, pz] = d.rim[0];
      const paving = [[[px - 3, pz - 3], [px + 3, pz - 3], [px + 3, pz + 3], [px - 3, pz + 3]]];
      const world = fakeWorld(dips, paving);
      const plan = layout(d, lawnsOf(grass));
      const plants = settle(plan, world);
      let near = 0;
      let reeds = 0;
      for (let i = 0; i < plants.length; i += FIELDS) {
        const [x, y, z, kind, variant] = plants.subarray(i, i + 5);
        assert.ok(!insideRings(x, z, paving), `${label} ${d.name}: a plant on the paving at ${x}, ${z}`);
        const fromRim = ringDistance(x, z, d.rim);
        assert.ok(fromRim < 2.6, `${label} ${d.name}: a plant ${fromRim.toFixed(2)} m from the rim`);
        if (kind === GRASS) assert.ok(fromRim < 1.3 || insideRings(x, z, [d.rim]), `${label} ${d.name}: grass ${fromRim.toFixed(2)} m out`);
        assert.ok(Math.abs(y - world.bed(x, z)) < 0.005, 'rooted on the bed or bank');
        const level = world.level(x, z);
        if (level !== null) assert.ok(level - y <= MAX_DEPTH[kind] + 1e-4, `${KINDS[kind]} ${(level - y).toFixed(2)} m under water`);
        near += tris[kind][variant][0];
        if (kind === REED) reeds++;
      }
      report.push({ label, name: d.name, share: plan.reedShare, plants: plants.length / FIELDS, reeds, near });
    }
  }
  const ponds = report.filter((r) => r.name === 'pond');
  const mean = ponds.reduce((s, r) => s + r.share, 0) / ponds.length;
  console.log(`ponds: reed along ${(mean * 100).toFixed(0)} % of the shore on average (${ponds.map((r) => (r.share * 100).toFixed(0)).join(', ')} %)`);
  const densest = report.reduce((a, b) => (b.near > a.near ? b : a));
  console.log(`the densest body (${densest.label} ${densest.name}): ${densest.plants} plants, ${densest.reeds} reeds, ${densest.near} triangles all near`);
  assert.ok(mean > 0.28 && mean < 0.55, `reed along ${mean} of the ponds' shores`);
  for (const r of ponds) assert.ok(r.plants > 40, `a pond with only ${r.plants} plants`);
  // All of one pond drawn near is the most there is to draw by one pond (High: 200 000 at most).
  for (const r of ponds) assert.ok(r.near < 200000, `${r.label} pond: ${r.near} triangles`);
});

test('the same plan for everyone: from the rim alone', () => {
  const d = village.dips.find((x) => x.name === 'pond');
  const a = layout(d);
  const b = layout(structuredClone(d));
  assert.deepEqual(a.wants, b.wants);
});
