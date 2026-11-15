import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The hand-made houses among the generated ones (world/villageHouses.ts, tools/village_houses_b1.py): every listed
// model is there, holds no image, stands in for a real wall block of the data, and hides every data roof over it.
const { VILLAGE_HOUSES } = await import('./villageHouses.ts');

const village = JSON.parse(fs.readFileSync(new URL('../data/village.json', import.meta.url), 'utf8'));
const modelFile = (name) => new URL(`../../public/models/${name}.glb`, import.meta.url);

/** The glTF's JSON chunk of a .glb, and whether it carries a binary chunk with an image in it. */
function readGlb(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.toString('ascii', 0, 4), 'glTF', `${file.pathname} is not a .glb`);
  const length = buf.readUInt32LE(12);
  return JSON.parse(buf.toString('utf8', 20, 20 + length));
}

const inside = (ring, [x, z]) => {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
};
const middle = (ring) => [ring.reduce((s, q) => s + q[0], 0) / ring.length, ring.reduce((s, q) => s + q[1], 0) / ring.length];
const same = (a, b) => a.length === b.length && a.every((p, i) => Math.abs(p[0] - b[i][0]) < 1e-3 && Math.abs(p[1] - b[i][1]) < 1e-3);
const roofRing = (r) => (Array.isArray(r.p[0][0]) ? r.p[0] : r.p);

for (const [name] of VILLAGE_HOUSES) {
  test(`${name}: its model is there, without images`, () => {
    assert.ok(fs.existsSync(modelFile(name)), `web/public/models/${name}.glb is missing: a name is listed in the commit that adds its file`);
    const gltf = readGlb(modelFile(name));
    assert.equal((gltf.images ?? []).length, 0, 'no image in the file: materials name the game\'s own textures');
    assert.equal((gltf.textures ?? []).length, 0);
  });

  test(`${name}: it stands in for a wall block of the data and hides every data roof over it`, () => {
    const gltf = readGlb(modelFile(name));
    const root = gltf.nodes.find((n) => n.extras?.landmark === name);
    assert.ok(root, 'its root names it as its landmark');
    const replaces = root.extras.replaces;
    assert.ok(Array.isArray(replaces) && replaces.length > 0, 'its root has `replaces`');
    const outline = replaces[0];
    assert.ok((village.prisms ?? []).some((p) => same(p.p[0], outline)), 'its first `replaces` ring is the outline of a wall block in village.json');
    // A house's front corner can be a corner of the street's paving too: a ring of the road would hide the street.
    for (const ring of replaces) {
      const block = (village.prisms ?? []).find((p) => same(p.p[0], ring));
      assert.ok(!block || !/^(road|pave|concrete|gravel)/.test(block.m), `a \`replaces\` ring is a ${block?.m} block, not a house's`);
    }
    // main.ts withoutLandmarks hides a data roof when the average of its corners lies inside a `replaces` ring. Any
    // roof with a corner inside the house's outline, or its middle within 1 m of it, belongs to the house: it must go.
    const near = (p) => inside(outline, p) || outline.some((q, i) => {
      const r = outline[(i + 1) % outline.length];
      const dx = r[0] - q[0], dz = r[1] - q[1];
      const t = Math.max(0, Math.min(1, ((p[0] - q[0]) * dx + (p[1] - q[1]) * dz) / (dx * dx + dz * dz || 1)));
      return Math.hypot(q[0] + dx * t - p[0], q[1] + dz * t - p[1]) < 1;
    });
    const left = village.roofs.filter((r) => {
      const ring = roofRing(r);
      const over = ring.some((p) => inside(outline, p)) || near(middle(ring));
      return over && !replaces.some((rep) => inside(rep, middle(ring)));
    });
    assert.deepEqual(left.map((r) => roofRing(r)[0]), [], 'a data roof over the house would still be drawn');
  });

  test(`${name}: its blocks are rings on the plan with a height`, () => {
    const root = readGlb(modelFile(name)).nodes.find((n) => n.extras?.landmark === name);
    for (const b of root.extras.blocks ?? []) {
      assert.ok(b.p[0].length >= 3 && b.y1 > b.y0, `block ${JSON.stringify(b).slice(0, 80)}`);
      assert.equal(root.extras.blocksOnGround, true, 'its blocks are measured from the ground at its origin');
    }
  });
}
