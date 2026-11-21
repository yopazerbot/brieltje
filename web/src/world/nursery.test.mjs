import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// The tree nurseries' plants (tools/nursery.py, web/public/models/nursery.glb) as world/nursery.ts reads them.
const url = new URL('../../public/models/nursery.glb', import.meta.url);
const bytes = readFileSync(url);
const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
const { scene } = gltf;
scene.updateMatrixWorld(true);

// Each model (world/nursery.ts MODELS), the most triangles its near, far and stand-in copies may have (the reach of each
// level follows from them and the budget per preset), and its height at most.
const MODELS = {
  Whip1: [800, 80, 12, 3.2],
  Whip2: [800, 80, 12, 3.2],
  Standard: [900, 160, 12, 3.4],
  Maiden: [800, 80, 12, 2.2],
  Conifer: [2000, 200, 24, 1.6],
  BoxBall: [2000, 160, 24, 0.7],
  Dogwood: [1200, 160, 16, 1.2],
  Rose: [1400, 200, 16, 0.8],
  Hedge: [1800, 300, 32, 1.4],
};

const triangles = (o) => (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;

test('the nursery: every plant near, far and as a stand-in, coloured on its corners, within its triangles', () => {
  for (const [name, [near, far, stub, tall]] of Object.entries(MODELS)) {
    for (const [n, most] of [[name, near], [`${name}Far`, far], [`${name}Stub`, stub]]) {
      const o = scene.getObjectByName(n);
      assert.ok(o?.isMesh, `${n}: one mesh`);
      const colour = o.geometry.attributes.color;
      assert.ok(colour && colour.itemSize === 4, `${n}: a colour on its corners, with the alpha that marks a stem to widen`);
      assert.ok(o.geometry.index, `${n}: indexed`);
      assert.ok(triangles(o) <= most, `${n}: ${triangles(o)} triangles, at most ${most}`);
      // Standing on its foot, about a young tree's or shrub's size; the hedge's 1.2 m of row along x.
      const box = new THREE.Box3().setFromObject(o);
      assert.ok(box.min.y > -0.15 && box.min.y < 0.2 && box.max.y < tall, `${n}: its height ${box.min.y} .. ${box.max.y}`);
      assert.ok(Math.max(-box.min.x, box.max.x, -box.min.z, box.max.z) < 1.0, `${n}: its spread`);
    }
  }
});

test('the nursery: no image, no texture, a small file', () => {
  const json = gltf.parser.json;
  assert.equal(json.images?.length ?? 0, 0, 'no images');
  assert.equal(json.textures?.length ?? 0, 0, 'no textures');
  assert.ok(statSync(url).size < 300 * 1024, `${statSync(url).size} bytes`);
});
