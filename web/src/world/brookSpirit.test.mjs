import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// The brook spirit's model (tools/brook_spirit.py, web/public/models/brook-spirit.glb) as world/brookSpirit.ts reads it.
const url = new URL('../../public/models/brook-spirit.glb', import.meta.url);
const bytes = readFileSync(url);
const { scene } = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');

/** The GLB's own JSON chunk (after the 12-byte header and the chunk's 8). */
const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'));

const triangles = (o) => (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;

test('the brook spirit: its parts near and far, coloured on their corners, no image, in its budget', () => {
  const parts = ['Heart', 'Core', 'Tendrils', 'HeartFar', 'CoreFar', 'TendrilsFar'];
  for (const name of parts) {
    const o = scene.getObjectByName(name);
    assert.ok(o?.isMesh, name);
    assert.ok(o.geometry.attributes.color, `${name}: a colour on its corners`);
  }
  assert.ok(!json.images?.length && !json.textures?.length, 'no image textures');
  const near = ['Heart', 'Core', 'Tendrils'].reduce((n, k) => n + triangles(scene.getObjectByName(k)), 0);
  const far = ['HeartFar', 'CoreFar', 'TendrilsFar'].reduce((n, k) => n + triangles(scene.getObjectByName(k)), 0);
  assert.ok(near <= 25000, `near: ${near} triangles`);
  assert.ok(far <= 3000, `far: ${far} triangles`);
  assert.ok(statSync(url).size < 500 * 1024, `the file: ${statSync(url).size} bytes`);
});

test('the tendrils: seven arms with their frames, every corner knows its arm and how far along it lies', () => {
  for (const name of ['Tendrils', 'TendrilsFar']) {
    const o = scene.getObjectByName(name);
    const arms = JSON.parse(String(o.userData.arms));
    assert.equal(arms.length, 7, `${name}: seven arms`);
    for (const a of arms) {
      const len = (v) => Math.hypot(...v);
      const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
      for (const k of ['dir', 'up', 'side']) assert.ok(Math.abs(len(a[k]) - 1) < 1e-3, `${name}: ${k} of length 1`);
      assert.ok(Math.abs(dot(a.dir, a.up)) < 1e-3 && Math.abs(dot(a.dir, a.side)) < 1e-3 && Math.abs(dot(a.up, a.side)) < 1e-3, `${name}: a square frame`);
      assert.ok(a.length >= 3 && a.length <= 5, `${name}: 3 to 5 m long (${a.length})`);
    }
    // The two longest at the front (+z), the others shorter.
    const lengths = arms.map((a) => a.length);
    assert.ok(arms[0].dir[2] > 0.8 && arms[1].dir[2] > 0.8 && Math.min(lengths[0], lengths[1]) > Math.max(...lengths.slice(2)), `${name}: the front ones the longest`);
    const pos = o.geometry.attributes.position;
    const uv = o.geometry.attributes.uv;
    const uv1 = o.geometry.attributes.uv1;
    assert.ok(uv && uv1, `${name}: (t, arm) and (glow, under) on its corners`);
    const seen = new Set();
    for (let i = 0; i < pos.count; i++) {
      const arm = Math.round(uv.getY(i));
      assert.ok(arm >= 0 && arm < 7 && Math.abs(uv.getY(i) - arm) < 1e-4, `${name}: corner ${i} on arm ${uv.getY(i)}`);
      seen.add(arm);
      const a = arms[arm];
      // t is where the corner lies along its straight arm (the shader works it out from the position the same way).
      const along = (pos.getX(i) - a.root[0]) * a.dir[0] + (pos.getY(i) - a.root[1]) * a.dir[1] + (pos.getZ(i) - a.root[2]) * a.dir[2];
      const t = Math.min(1, Math.max(0, along / a.length));
      assert.ok(Math.abs(t - uv.getX(i)) < 0.02, `${name}: corner ${i} at t ${uv.getX(i)}, lies at ${t}`);
      assert.ok(uv1.getX(i) >= 0 && uv1.getX(i) <= 1, `${name}: glow 0..1`);
    }
    assert.equal(seen.size, 7, `${name}: corners on all seven arms`);
  }
  // Glowing nodes only on the near model.
  const glow = scene.getObjectByName('Tendrils').geometry.attributes.uv1;
  let lit = 0;
  for (let i = 0; i < glow.count; i++) lit += glow.getX(i) > 0.5 ? 1 : 0;
  assert.ok(lit > 500, `the nodes: ${lit} glowing corners`);
});

test('the core: a shell open at the front, its hollow marked, nothing in front of the opening\'s edge', () => {
  for (const name of ['Core', 'CoreFar']) {
    const g = scene.getObjectByName(name).geometry;
    assert.ok(g.attributes.uv, `${name}: inside on its corners`);
    const pos = g.attributes.position;
    let inside = 0;
    for (let i = 0; i < pos.count; i++) {
      // Within the shape's own squash (brookSpirit.ts CORE_BEND), the angle from the front.
      const x = pos.getX(i) / 1.12;
      const y = pos.getY(i) / 0.92;
      const z = pos.getZ(i);
      const th = Math.acos(Math.max(-1, Math.min(1, z / Math.hypot(x, y, z))));
      assert.ok(th > 0.78 - 0.08 - 1e-3, `${name}: corner ${i} at ${th.toFixed(3)} rad, in front of the opening's edge`);
      inside += g.attributes.uv.getX(i) > 0.99 ? 1 : 0;
    }
    assert.ok(inside > 0, `${name}: a hollow`);
  }
});
