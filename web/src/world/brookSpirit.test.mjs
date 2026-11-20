import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// The brook spirit's model and maps (tools/brook_spirit.py, tools/brook_spirit_mist.py) as world/brookSpirit.ts,
// world/spiritSkin.ts and world/spiritMist.ts read them.
const url = new URL('../../public/models/brook-spirit.glb', import.meta.url);
const bytes = readFileSync(url);
const { scene } = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');

/** The GLB's own JSON chunk (after the 12-byte header and the chunk's 8). */
const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'));

const triangles = (o) => (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;

test('the brook spirit: its parts near and far, with UVs and tangents, the maps outside it, in its budget', () => {
  const parts = ['Heart', 'Core', 'Tendrils', 'HeartFar', 'CoreFar', 'TendrilsFar', 'Leaf', 'Drop'];
  for (const name of parts) {
    const o = scene.getObjectByName(name);
    assert.ok(o?.isMesh, name);
  }
  for (const name of ['Heart', 'Core', 'Tendrils', 'HeartFar', 'CoreFar', 'TendrilsFar', 'Leaf']) {
    const g = scene.getObjectByName(name).geometry;
    assert.ok(g.attributes.uv, `${name}: where it lies in its maps`);
    for (let i = 0; i < g.attributes.uv.count; i++) {
      const u = g.attributes.uv.getX(i);
      const v = g.attributes.uv.getY(i);
      assert.ok(u >= 0 && u <= 1 && v >= 0 && v <= 1, `${name}: uv ${u}, ${v} inside the maps`);
    }
  }
  for (const name of ['Core', 'Tendrils', 'CoreFar', 'TendrilsFar']) assert.ok(scene.getObjectByName(name).geometry.attributes.tangent, `${name}: tangents for the normal map`);
  assert.ok(!json.images?.length && !json.textures?.length, 'no image in the model: the maps are files of their own');
  const near = ['Heart', 'Core', 'Tendrils'].reduce((n, k) => n + triangles(scene.getObjectByName(k)), 0);
  const far = ['HeartFar', 'CoreFar', 'TendrilsFar'].reduce((n, k) => n + triangles(scene.getObjectByName(k)), 0);
  assert.ok(near <= 60000, `near: ${near} triangles`);
  assert.ok(far <= 4500, `far: ${far} triangles`);
  assert.ok(statSync(url).size < 2.5 * 1024 * 1024, `the file: ${statSync(url).size} bytes`);
});

/** A WebP file's size in pixels (lossy, lossless or extended). */
function webpSize(b) {
  assert.equal(b.toString('ascii', 0, 4), 'RIFF');
  assert.equal(b.toString('ascii', 8, 12), 'WEBP');
  const kind = b.toString('ascii', 12, 16);
  if (kind === 'VP8X') return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  if (kind === 'VP8L') {
    const n = b.readUInt32LE(21);
    return [1 + (n & 0x3fff), 1 + ((n >> 14) & 0x3fff)];
  }
  return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
}

test('the maps: KTX2 full size and half, one WebP each (the fallback), in their sizes, nothing else', () => {
  const names = ['body_color', 'body_normal', 'body_orm', 'tendril_color', 'tendril_normal', 'tendril_orm', 'mist_a', 'mist_b'];
  const dir = (sub) => new URL(`../../public/models/brook-spirit/${sub}`, import.meta.url);
  let total = 0;
  let phone = 0;
  for (const name of names) {
    const mist = name.startsWith('mist');
    const w = readFileSync(new URL(`${name}.webp`, dir('')));
    assert.deepEqual(webpSize(w), [1024, 1024], `${name}.webp: 1024 pixels`);
    total += w.length;
    for (const [sub, side] of [['ktx2/', mist ? 1024 : 2048], ['ktx2/half/', mist ? 512 : 1024]]) {
      const k = readFileSync(new URL(`${name}.ktx2`, dir(sub)));
      assert.deepEqual([...k.subarray(0, 12)], [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a], `${sub}${name}.ktx2: a KTX2 file`);
      assert.deepEqual([k.readUInt32LE(20), k.readUInt32LE(24)], [side, side], `${sub}${name}.ktx2: ${side} pixels`);
      assert.ok(k.readUInt32LE(40) > 1, `${sub}${name}.ktx2: with its mipmaps`);
      assert.ok(k.length < 2.6 * 1024 * 1024, `${sub}${name}.ktx2: ${k.length} bytes`);
      total += k.length;
      if (sub === 'ktx2/half/') phone += k.length;
    }
  }
  for (const sub of ['', 'ktx2/', 'ktx2/half/']) {
    const files = readdirSync(dir(sub)).filter((f) => !f.startsWith('.') && f !== 'half' && f !== 'ktx2');
    assert.equal(files.length, names.length, `${sub || 'the folder'}: only the maps (${files.join(', ')})`);
  }
  assert.ok(total < 11 * 1024 * 1024, `all the maps: ${(total / 1048576).toFixed(1)} MB`);
  assert.ok(phone < 2.5 * 1024 * 1024, `what a phone fetches: ${(phone / 1048576).toFixed(1)} MB`);
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
      assert.ok(a.length >= 6 && a.length <= 8, `${name}: 6 to 8 m long (${a.length})`);
      assert.ok(a.radius >= 0.2 && a.radius <= 0.26, `${name}: 0.4 to 0.5 m across at the root (${a.radius * 2})`);
    }
    // The two longest at the front (+z), the others shorter.
    const lengths = arms.map((a) => a.length);
    assert.ok(arms[0].dir[2] > 0.8 && arms[1].dir[2] > 0.8 && Math.min(lengths[0], lengths[1]) > Math.max(...lengths.slice(2)), `${name}: the front ones the longest`);
    const pos = o.geometry.attributes.position;
    const ta = o.geometry.attributes.uv1;
    assert.ok(ta, `${name}: (t, arm) on its corners`);
    const seen = new Set();
    for (let i = 0; i < pos.count; i++) {
      const arm = Math.round(ta.getY(i));
      assert.ok(arm >= 0 && arm < 7 && Math.abs(ta.getY(i) - arm) < 1e-4, `${name}: corner ${i} on arm ${ta.getY(i)}`);
      seen.add(arm);
      const a = arms[arm];
      // t is where the corner lies along its straight arm (the shader works it out from the position the same way).
      const along = (pos.getX(i) - a.root[0]) * a.dir[0] + (pos.getY(i) - a.root[1]) * a.dir[1] + (pos.getZ(i) - a.root[2]) * a.dir[2];
      const t = Math.min(1, Math.max(0, along / a.length));
      assert.ok(Math.abs(t - ta.getX(i)) < 0.02, `${name}: corner ${i} at t ${ta.getX(i)}, lies at ${t}`);
    }
    assert.equal(seen.size, 7, `${name}: corners on all seven arms`);
  }
});

test('the core: a shell open at the front, its hollow marked, nothing in front of the opening\'s edge', () => {
  for (const name of ['Core', 'CoreFar']) {
    const g = scene.getObjectByName(name).geometry;
    assert.ok(g.attributes.uv1, `${name}: inside on its corners`);
    const pos = g.attributes.position;
    let inside = 0;
    for (let i = 0; i < pos.count; i++) {
      // Within the shape's own squash (spiritSkin.ts CORE_BEND), the angle from the front.
      const x = pos.getX(i) / 1.12;
      const y = pos.getY(i) / 0.92;
      const z = pos.getZ(i);
      const th = Math.acos(Math.max(-1, Math.min(1, z / Math.hypot(x, y, z))));
      assert.ok(th > 0.78 - 0.08 - 1e-3, `${name}: corner ${i} at ${th.toFixed(3)} rad, in front of the opening's edge`);
      inside += g.attributes.uv1.getX(i) > 0.99 ? 1 : 0;
    }
    assert.ok(inside > 0, `${name}: a hollow`);
  }
});
