import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// The woods' undergrowth (tools/undergrowth.py, web/public/models/undergrowth.glb) as world/undergrowth.ts reads it.
const url = new URL('../../public/models/undergrowth.glb', import.meta.url);
const bytes = readFileSync(url);
const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
const { scene } = gltf;
scene.updateMatrixWorld(true);

// Each kind's models (world/undergrowth.ts MODELS) and the most triangles a near and a far copy may have: the woods
// draw a few dozen near copies and a few thousand far ones, so these keep the undergrowth within its budget per preset.
const MODELS = {
  BrackenGreen: [2000, 130],
  BrackenArch: [2000, 130],
  BrackenFlat: [2000, 130],
  Bramble1: [2400, 240],
  Bramble2: [2400, 240],
  Holly: [3000, 200],
  Hazel: [2000, 140],
  Beech: [2000, 180],
  Branch: [500, 80],
  Log: [400, 40],
  Stump: [300, 40],
};

const triangles = (o) => (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;

test('the undergrowth: every plant near and far, coloured on its corners, within its triangles', () => {
  for (const [name, [near, far]] of Object.entries(MODELS)) {
    for (const [n, most] of [[name, near], [`${name}Far`, far]]) {
      const o = scene.getObjectByName(n);
      assert.ok(o?.isMesh, `${n}: one mesh`);
      assert.ok(o.geometry.attributes.color, `${n}: a colour on its corners`);
      assert.ok(o.geometry.index, `${n}: indexed`);
      assert.ok(triangles(o) <= most, `${n}: ${triangles(o)} triangles, at most ${most}`);
      // Standing on its foot, about a plant's size.
      const box = new THREE.Box3().setFromObject(o);
      assert.ok(box.min.y > -0.1 && box.max.y < 1.8, `${n}: its height ${box.min.y} .. ${box.max.y}`);
      assert.ok(Math.max(-box.min.x, box.max.x, -box.min.z, box.max.z) < 1.6, `${n}: its spread`);
    }
  }
});

test('the undergrowth: no image, no texture, a small file', () => {
  const json = gltf.parser.json;
  assert.equal(json.images?.length ?? 0, 0, 'no images');
  assert.equal(json.textures?.length ?? 0, 0, 'no textures');
  assert.ok(statSync(url).size < 450 * 1024, `${statSync(url).size} bytes`);
});
