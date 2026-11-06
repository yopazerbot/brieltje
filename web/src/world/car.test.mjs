import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Run the actual animation and movement code without the browser-only sound/texture imports.
const source = readFileSync(new URL('./car.ts', import.meta.url), 'utf8');
const specs = JSON.parse(readFileSync(new URL('../../shared/car.json', import.meta.url), 'utf8'));
const definition = (name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  return stripTypeScriptTypes(source.slice(start, source.indexOf('\n}', start) + 2));
};
const constants = ['WHEELBASE', 'WHEEL_R', 'ACCEL', 'BRAKE', 'REVERSE', 'HANDBRAKE', 'GRIP', 'STEER', 'CLEAR', 'SPIN_STEP', 'DRAW', 'angle']
  .map(name => source.match(new RegExp(`^const ${name} = .*?;`, 'm'))?.[0]).join('\n');
const classCode = source.slice(source.indexOf('export class Car')).replace('export class Car', 'class Car');
const Car = new Function('THREE', 'netClock', stripTypeScriptTypes(`${constants}\n${classCode}`, { mode: 'transform' }) + '\nreturn Car;')(THREE, { time: 0 });

function vehicle(spec = specs.cars.tesla) {
  return Object.assign(Object.create(Car.prototype), {
    spec, x: 0, y: 0, z: 0, yaw: 0, steer: 0, vx: 0, vz: 0, speed: 0, lastSpeed: 0,
    halfL: spec.length / 2, halfW: spec.width / 2, key: 'test-car', ready: true, trees: [],
    group: new THREE.Group(), body: new THREE.Group(), front: [], wheels: [], spin: 0, roll: 0, pitch: 0,
    blurMat: new THREE.MeshStandardMaterial(), taillight: new THREE.MeshStandardMaterial(),
    world: { boxFree: () => true, boxInBounds: () => true, groundAt: () => ({ y: 0, name: 'street' }), setMoving() {} },
    hum() {},
  });
}
const throttle = { throttle: 1, brake: 0, steer: 0, handbrake: false };
const brake = { ...throttle, throttle: 0, brake: 1 };

for (const name of ['model-y', 'model-3']) {
  test(`${name}: all four wheels roll once, with both front wheels steering`, async () => {
    const bytes = readFileSync(new URL(`../../public/models/${name}.glb`, import.meta.url));
    const { scene } = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    const materials = {};
    scene.traverse(o => { if (o.isMesh) materials[o.material.name] = o.material; });
    const prepare = new Function('THREE', 'MATERIALS', 'SHADOW_PARTS', `${definition('blurDisc')}\n${definition('prepare')}\nreturn prepare;`)(THREE, materials, new Set());
    const parts = prepare(scene, {}, new THREE.MeshStandardMaterial());
    assert.deepEqual(parts.wheels.map(w => w.pivot.name).sort(), ['Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR']);
    assert.deepEqual(parts.front.map(w => w.name).sort(), ['Wheel_FL', 'Wheel_FR']);
    const car = vehicle();
    Object.assign(car, parts, { speed: 3, steer: .23 });
    const before = new Map();
    scene.updateMatrixWorld(true);
    for (const { pivot } of parts.wheels) pivot.traverse(o => { before.set(o, o.getWorldQuaternion(new THREE.Quaternion())); });
    car.update(1 / 60, true);
    scene.updateMatrixWorld(true);
    for (const { pivot } of parts.wheels) {
      const roll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -3 / 60 / .356);
      const expected = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), pivot.name.includes('_F') ? .23 : 0).multiply(roll);
      pivot.traverse(o => {
        const delta = o.getWorldQuaternion(new THREE.Quaternion()).multiply(before.get(o).clone().invert());
        assert.ok(delta.angleTo(expected) < 1e-5, `${pivot.name}/${o.name} must rotate with its axle`);
      });
      assert.equal(pivot.children.filter(o => o.userData.ignoreRay).length, 1, 'one blur disc per wheel');
    }
  });
}

test('both Teslas reach about 200 km/h progressively, including their spawned variants', () => {
  for (const spec of Object.values(specs.cars)) {
    const car = vehicle(spec);
    car.drive(1, throttle, []);
    assert.ok(car.speed > 5 && car.speed < 6, 'initial acceleration stays around the existing 6 m/s²');
    for (let i = 0; i < 4 * 60; i++) car.drive(1 / 60, throttle, []);
    assert.ok(car.speed < 30, 'five seconds must not instantly reach top speed');
    for (let i = 0; i < 55 * 60; i++) car.drive(1 / 60, throttle, []);
    assert.ok(car.speed * 3.6 >= 199 && car.speed * 3.6 <= 201);
    assert.ok(car.speed <= spec.maxSpeed);
  }
  for (const kind of Object.values(specs.placed.kinds)) assert.equal(specs.cars[kind.base].maxSpeed, 55.6);
});

test('braking still stops a fast car and reverse stays capped', () => {
  const car = vehicle();
  Object.assign(car, { speed: 55.6, vz: -55.6 });
  let seconds = 0;
  while (car.speed > 0 && seconds < 8) { car.drive(1 / 60, brake, []); seconds += 1 / 60; }
  assert.ok(seconds < 7);
  for (let i = 0; i < 30 * 60; i++) car.drive(1 / 60, brake, []);
  assert.ok(car.speed < 0 && car.speed >= -car.spec.reverseSpeed);
});

test('a fast car cannot tunnel through a thin wall', () => {
  const car = vehicle();
  Object.assign(car, { speed: 55.6, vz: -55.6 });
  car.world.boxFree = (x, z, yaw, halfL) => z - halfL > -49.98 || z + halfL < -50.02;
  for (let i = 0; i < 90; i++) {
    car.drive(1 / 30, throttle, []);
    assert.ok(car.z > -50, 'the car must stay on this side of the wall');
  }
});

test('tree checks include the full distance of a long fast frame', () => {
  const car = vehicle();
  Object.assign(car, { speed: 55.6, vz: -55.6, trees: [{ x: 0, z: -12, r: .35 }] });
  car.drive(.25, throttle, []);
  assert.ok(car.z > -12 + car.halfL, 'a tree outside the old 8 m search still stops the car');
});

test('passengers and remote viewers can see the full speed above the old 144 km/h display cap', () => {
  const car = vehicle();
  Object.assign(car, { speed: 55.6, lastSpeed: 55.6, pose: [], track: { at: (time, pose) => { pose.push(0, 0, -55.6, 0, 0); return true; } } });
  car.update(1, false);
  assert.ok(car.speed * 3.6 > 199);
});
