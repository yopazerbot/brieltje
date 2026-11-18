import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TRUCK } from '../../shared/assaultFields.mjs';

// The camp's models (tools/camp.py, web/public/models/camp.glb) as world/campModels.ts, world/truck.ts and world/car.ts
// read them.
const bytes = readFileSync(new URL('../../public/models/camp.glb', import.meta.url));
const { scene } = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
scene.updateMatrixWorld(true);

const triangles = (root) => {
  let n = 0;
  root.traverse((o) => {
    if (o.isMesh) n += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
  });
  return n;
};
const box = (root) => new THREE.Box3().setFromObject(root);

test('the camp: tents and the supply truck, near and far, coloured on their corners, with team parts', () => {
  for (const name of ['Tent', 'TentFar', 'SupplyTruck', 'SupplyTruckFar']) {
    const o = scene.getObjectByName(name);
    assert.ok(o, name);
    const mats = new Set();
    o.traverse((m) => {
      if (!m.isMesh) return;
      mats.add(m.material.name);
      assert.ok(m.geometry.attributes.color, `${name}: a colour on its corners`);
      assert.ok(m.geometry.index, `${name}: indexed (the camp merges them)`);
    });
    assert.deepEqual([...mats].sort(), ['Lit', 'Team'], `${name}: its materials`);
  }
  // Seen from the air too: modest near, a few hundred triangles far.
  assert.ok(triangles(scene.getObjectByName('Tent')) < 10000);
  assert.ok(triangles(scene.getObjectByName('SupplyTruck')) < 14000);
  for (const far of ['TentFar', 'SupplyTruckFar']) assert.ok(triangles(scene.getObjectByName(far)) < 600, far);
  // The supply truck within its walking barrier (world/assaultCamp.ts: 1.3 x 3.6 m half sizes; the server measures its
  // ammo from 1.4 x 3.4, server/assaultSupply.mjs: the shackles, the hook and the mirrors stick out past that by a hand).
  const s = box(scene.getObjectByName('SupplyTruck'));
  assert.ok(s.max.z <= 3.6 && s.min.z >= -3.6 && s.max.x <= 1.5, `its size ${s.min.toArray()} .. ${s.max.toArray()}`);
  // A tent within its walking barrier but for its guy ropes and its net's edge (world/assaultCamp.ts TENT).
  const t = box(scene.getObjectByName('TentFar'));
  assert.ok(t.max.x <= 2.7 && t.max.z <= 3.4 && t.min.z >= -3.4, `the tent's far copy within its barrier (the net hangs off its back): ${t.min.toArray()} .. ${t.max.toArray()}`);
});

test('the spawn truck: the cars\' parts by name, its wheels at the physics\' axles, a far copy, its size', () => {
  const truck = scene.getObjectByName('SpawnTruck');
  assert.ok(truck);
  const wheels = ['Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR'].map((n) => truck.getObjectByName(n));
  assert.ok(wheels.every(Boolean), 'four wheel pivots');
  const at = wheels.map((w) => w.getWorldPosition(new THREE.Vector3()));
  for (const [i, p] of at.entries()) {
    assert.ok(Math.abs(Math.abs(p.x) - 0.93) < 1e-3 && Math.abs(p.y - 0.52) < 1e-3, `${wheels[i].name} at ${p.toArray()}`);
    assert.ok(Math.abs(p.z - (i < 2 ? -2.35 : 2.1)) < 1e-3, `${wheels[i].name} along: ${p.z}`);
  }
  // The left wheels are turned round (world/car.ts prepare reads it after reordering to YXZ).
  for (const w of wheels) {
    const e = new THREE.Euler().setFromQuaternion(w.quaternion, 'YXZ');
    assert.equal(Math.abs(e.y) > 1, w.name.endsWith('L'), w.name);
  }
  assert.ok(truck.getObjectByName('Far'), 'a far copy');
  const names = new Set();
  truck.traverse((o) => o.isMesh && names.add(o.material.name));
  for (const n of ['Drab', 'Paint', 'Glass', 'LightBar', 'TailLight']) assert.ok(names.has(n), `material ${n}`);
  // Its body within TRUCK's size (the shackles and the folding steps stick out a little).
  const body = box(truck.getObjectByName('SpawnBody'));
  assert.ok(body.max.z - body.min.z <= TRUCK.length + 0.3, `length ${body.max.z - body.min.z}`);
  assert.ok(body.min.y >= -0.01);
  // The headlights are at the front, either side (world/carLights.ts finds the lamps' spots from them).
  const head = [];
  truck.getObjectByName('SpawnBody').traverse((o) => {
    if (o.isMesh && o.material.name === 'LightBar') head.push(new THREE.Box3().setFromObject(o));
  });
  assert.ok(head.length && head.every((b) => b.max.z < -TRUCK.length / 2 + 0.5 && b.max.x > 0.7 && b.min.x < -0.7));
});
