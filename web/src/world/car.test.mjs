import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CarBody, groundPlane, PITCH_MAX, ROLL_MAX, skid } from './carBody.ts';
import * as grip from './carGrip.ts';

// Run the actual animation and movement code without the browser-only sound/texture imports.
const source = readFileSync(new URL('./car.ts', import.meta.url), 'utf8');
const specs = JSON.parse(readFileSync(new URL('../../shared/car.json', import.meta.url), 'utf8'));
const definition = (name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  return stripTypeScriptTypes(source.slice(start, source.indexOf('\n}', start) + 2));
};
const constants = ['WHEELBASE', 'WHEEL_R', 'ACCEL', 'BRAKE', 'REVERSE', 'HANDBRAKE', 'REGEN', 'GRIP', 'ESC', 'STEER', 'CLEAR', 'SPIN_STEP', 'DRAW', 'ROLL_H', 'TILT', 'ROUGH', 'CALM', 'angle']
  .map(name => source.match(new RegExp(`^const ${name} = .*?;`, 'm'))?.[0]).join('\n');
const classCode = source.slice(source.indexOf('export class Car')).replace('export class Car', 'class Car');
// The marks and sounds a car makes, counted instead of drawn and played.
const laid = [];
const skidMarks = { lay: (...a) => laid.push(a) };
// The weather the tyres feel (world/mood.ts), set by the tests.
const mood = { wet: 0, snow: 0 };
const Car = new Function('THREE', 'netClock', 'CarBody', 'groundPlane', 'skid', 'PITCH_MAX', 'ROLL_MAX', 'skidMarks', 'G', 'MASS', 'surfaceGrip', 'tyreForces', 'YAW_INERTIA', 'mood',
  stripTypeScriptTypes(`${constants}\n${classCode}`, { mode: 'transform' }) + '\nreturn Car;')(THREE, { time: 0 }, CarBody, groundPlane, skid, PITCH_MAX, ROLL_MAX, skidMarks,
  grip.G, grip.MASS, grip.surfaceGrip, grip.tyreForces, grip.YAW_INERTIA, mood);

function vehicle(spec = specs.cars.tesla, groundAt = () => ({ y: 0, name: 'street', mat: 'asphalt' })) {
  return Object.assign(Object.create(Car.prototype), {
    spec, x: 0, y: 0, z: 0, yaw: 0, steer: 0, vx: 0, vz: 0, speed: 0, lastSpeed: 0,
    halfL: spec.length / 2, halfW: spec.width / 2, key: 'test-car', ready: true, trees: [],
    group: new THREE.Group(), body: new THREE.Group(), chassis: new THREE.Group(), front: [], wheels: [], spin: 0,
    blurMat: new THREE.MeshStandardMaterial(), taillight: new THREE.MeshStandardMaterial(), lamps: { update() {} },
    world: { boxFree: () => true, boxInBounds: () => true, groundAt, setMoving() {}, touching: () => null },
    motion: new CarBody(), along: 0, side: 0, yawRate: 0, lastX: 0, lastZ: 0, lastYaw: 0, fresh: true,
    turn: 0, pedal: 0, brakePedal: 0, ax: 0, ay: 0, grip: [1, 1, 1, 1], slideF: 0, slideR: 0, crashed: false,
    axle: { at: [[-0.82, -1.45], [0.82, -1.45], [-0.82, 1.42], [0.82, 1.42]], base: 2.87, track: 1.64, hub: [0, 0, 0, 0] },
    under: [0, 0, 0, 0], rise: [0, 0, 0, 0], rough: [false, false, false, false],
    ride: { pitch: 0, roll: 0, lift: 0, twist: 0 }, plane: { pitch: 0, roll: 0, lift: 0, twist: 0 }, still: 0, knock: 0,
    trail: [null, null, null, null], thumps: [], spinKick: 0, hit: null,
    camBack: 0, camSide: 0, fovScale: 1, camHeading: 0, camYaw: 0, camPitch: 0.22, lookIdle: 0,
    noise: { update() {}, thump(...a) { this.owner.thumps.push(a); }, dispose() {} },
  });
}
/** A car at the wheel for `seconds` of 60 fps frames: driven, then drawn, as main.ts does. */
function run(car, seconds, input, dt = 1 / 60) {
  car.noise.owner = car;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    car.drive(dt, input, []);
    car.update(dt, true);
  }
}
const finite = (car) => [car.motion.pitch, car.motion.roll, car.motion.heave, car.ride.pitch, car.ride.roll, car.ride.lift, car.x, car.z, car.yaw]
  .every(Number.isFinite);
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

test('a car into a wall bounces back a little, says where it hit, and an off-centre post turns it', () => {
  const crashes = [];
  Car.onCrash = (hit) => crashes.push(hit);
  const car = vehicle();
  Object.assign(car, { speed: 12, vz: -12, z: -10 });
  car.world.boxFree = (x, z, yaw, halfL) => z - halfL > -20; // a wall across at z = -20
  car.world.touching = () => ({ mat: 'brick' });
  for (let i = 0; i < 60 && !crashes.length; i++) car.drive(1 / 60, { throttle: 0, brake: 0, steer: 0, handbrake: false }, []);
  assert.equal(crashes.length, 1, 'one crash');
  const [hit] = crashes;
  assert.ok(hit.speed > 10 && hit.speed < 13, `at about its speed (${hit.speed})`);
  assert.equal(hit.what, 'brick');
  assert.ok(Math.abs(hit.z + 20) < 0.5 && Math.abs(hit.x) < 0.1, `at its front, against the wall (${hit.x}, ${hit.z})`);
  assert.ok(hit.nz > 0.99, 'the way out is back');
  assert.ok(car.speed < 0 && car.speed > -4, `rolled back a little, not stopped dead (${car.speed})`);
  assert.ok(car.z - car.halfL > -20, 'not into the wall');

  // A post in front of its left corner: it turns away (to the right) as it bounces.
  const post = vehicle();
  Object.assign(post, { speed: 10, vz: -10, z: -10 });
  post.world.boxFree = (x, z, yaw, halfL, halfW) => {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const u = (-0.7 - x) * fx + (-20 - z) * fz;
    const w = -(-0.7 - x) * fz + (-20 - z) * fx;
    return Math.abs(u) > halfL + 0.1 || Math.abs(w) > halfW + 0.1;
  };
  for (let i = 0; i < 90; i++) post.drive(1 / 60, { throttle: 0, brake: 0, steer: 0, handbrake: false }, []);
  assert.ok(post.yaw < -0.02, `turned to the right, away from the post (${post.yaw})`);
  Car.onCrash = () => {};
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

test('the body spring dips under braking, then settles with one small overshoot', () => {
  const body = new CarBody();
  for (let i = 0; i < 120; i++) body.step(1 / 60, -9, 0);
  assert.ok(body.pitch < -0.03 && body.pitch > -PITCH_MAX, `nose down under braking (${body.pitch})`);
  let most = 0;
  for (let i = 0; i < 180; i++) {
    body.step(1 / 60, 0, 0);
    most = Math.max(most, body.pitch);
  }
  assert.ok(most > 0.002 && most < 0.5 * PITCH_MAX, `it rocks back past level a little (${most})`);
  assert.ok(Math.abs(body.pitch) < 1e-3 && Math.abs(body.roll) < 1e-3, 'level again after three seconds');
  for (let i = 0; i < 120; i++) body.step(1 / 60, 0, 12);
  assert.ok(body.roll > 0.04 && body.roll <= ROLL_MAX, 'a right turn lifts the right side');
});

test('the body spring stays finite and in range at any frame time and input', () => {
  const body = new CarBody();
  for (const dt of [1 / 60, 0.5, 5, 1e-6, 0, -1, NaN, 1 / 240, 1 / 15]) {
    for (const [a, b] of [[40, -40], [-1e9, 1e9], [NaN, 3], [Infinity, -Infinity], [0, 0]]) {
      body.step(dt, a, b);
      body.kick(NaN, 1e9, -1e9);
      assert.ok([body.pitch, body.roll, body.heave].every(Number.isFinite), `dt ${dt}, inputs ${a} ${b}`);
      assert.ok(Math.abs(body.pitch) <= 2 * PITCH_MAX && Math.abs(body.roll) <= 2 * ROLL_MAX && Math.abs(body.heave) <= 0.08);
    }
  }
});

test('flat out at 200 km/h with full lock, handbrake and frame spikes, the car stays finite and its body in range', () => {
  const car = vehicle();
  run(car, 60, throttle);
  assert.ok(car.speed * 3.6 > 199);
  for (const [dt, input] of [[1 / 60, { ...throttle, steer: 1 }], [0.25, { ...throttle, steer: -1, handbrake: true }], [1 / 144, brake], [0.1, { ...brake, steer: 1 }], [1, throttle]]) {
    run(car, 2, input, dt);
    assert.ok(finite(car), `finite with dt ${dt}`);
    assert.ok(Math.abs(car.motion.pitch) <= PITCH_MAX * 1.2 && Math.abs(car.motion.roll) <= ROLL_MAX * 1.2, `in range with dt ${dt}`);
  }
  assert.ok([car.body.rotation.x, car.body.rotation.z, car.group.rotation.x, car.group.rotation.z].every(Number.isFinite));
});

test('the car tilts to the slope under its wheels and lifts its side on a kerb, with a knock as a wheel goes up', () => {
  // Rising 10% towards the back (+z): the nose points down the slope.
  const slope = vehicle(specs.cars.tesla, (x, z) => ({ y: 0.1 * z, mat: 'asphalt' }));
  run(slope, 1, { throttle: 0, brake: 0, steer: 0, handbrake: false });
  assert.ok(Math.abs(slope.ride.pitch + Math.atan(0.1)) < 0.005, `pitch ${slope.ride.pitch}`);
  assert.ok(Math.abs(slope.ride.roll) < 1e-6);
  // A 10 cm kerb under the right wheels from 5 m ahead on.
  const kerb = vehicle(specs.cars.tesla, (x, z) => ({ y: x > 0.4 && z < -5 ? 0.1 : 0, mat: 'concrete' }));
  run(kerb, 4, { ...throttle, throttle: 0.4 });
  assert.ok(kerb.z < -12, 'it drove past the kerb');
  assert.ok(Math.abs(kerb.ride.roll - Math.atan2(0.1, 1.64)) < 0.01, `right side up (${kerb.ride.roll})`);
  assert.ok(kerb.thumps.length >= 1, 'a thump as a wheel goes up the kerb');
});

test('sliding hard leaves marks on paving, gentle driving and grass leave none', () => {
  laid.length = 0;
  const calm = vehicle();
  run(calm, 4, { ...throttle, throttle: 0.5, steer: 0.1 });
  assert.equal(laid.length, 0, 'no marks from gentle driving');
  const slide = vehicle();
  run(slide, 6, throttle);
  run(slide, 1.5, { ...throttle, throttle: 0, steer: 1, handbrake: true });
  assert.ok(laid.length > 10, `marks from a handbrake turn (${laid.length})`);
  assert.ok(laid.every((a) => a.every(Number.isFinite) && a[6] > 0 && a[6] <= 1));
  laid.length = 0;
  const grass = vehicle(specs.cars.tesla, () => ({ y: 0, name: 'Garden' }));
  run(grass, 6, throttle);
  run(grass, 1.5, { ...throttle, throttle: 0, steer: 1, handbrake: true });
  assert.equal(laid.length, 0, 'none on grass');
  assert.deepEqual(skid(0.5, 5, -20, 30, true), { front: 0, rear: 0 }, 'nothing at a crawl');
});

test('a car someone else drives leans from its smoothed track: nose down when it brakes, no jolts between ticks', () => {
  // The server's states twenty a second, drawn between them: braking from 20 m/s at 8 m/s2 along -z.
  const at = (t) => (t < 1 ? -20 * t : t < 3.5 ? -20 - 20 * (t - 1) + 4 * (t - 1) ** 2 : -45);
  let now = 0;
  const car = vehicle();
  Object.assign(car, { pose: [], track: { at: (time, pose) => {
    const k = Math.floor(now * 20) / 20;
    const z = at(k) + (at(k + 0.05) - at(k)) * (now - k) * 20;
    pose.length = 0;
    pose.push(0, 0, z, 0, 0);
    return true;
  } } });
  let least = 0;
  let jolt = 0;
  let last = 0;
  for (let i = 0; i < 4 * 60; i++) {
    now = i / 60;
    car.update(1 / 60, false);
    least = Math.min(least, car.motion.pitch);
    if (i > 2) jolt = Math.max(jolt, Math.abs(car.motion.pitch - last));
    last = car.motion.pitch;
  }
  assert.ok(least < -0.025, `nose down while it brakes (${least})`);
  assert.ok(jolt < 0.006, `smooth from frame to frame (${jolt})`);
});

/** A car going straight at `kmh` (along -z), on `mat` (none: grass), the road `wet` (0 to 1). */
function rolling(kmh, mat = 'asphalt', wet = 0) {
  mood.wet = wet;
  const car = vehicle(specs.cars.tesla, () => ({ y: 0, name: mat ? 'street' : 'Garden', mat: mat || undefined }));
  Object.assign(car, { vz: -kmh / 3.6, speed: kmh / 3.6, lastSpeed: kmh / 3.6 });
  car.noise.owner = car;
  car.update(1 / 60, true);
  return car;
}
/** Held until it stands: how far it went (m) and how hard it stopped (g). */
function stopping(car, input) {
  const v = Math.hypot(car.vx, car.vz);
  let t = 0;
  while (Math.hypot(car.vx, car.vz) > 0.05 && t < 20) {
    car.drive(1 / 60, input, []);
    car.update(1 / 60, true);
    t += 1 / 60;
  }
  mood.wet = 0;
  return { metres: Math.hypot(car.x, car.z), g: v / t / 9.81, t };
}
const handbrake = { throttle: 0, brake: 0, steer: 0, handbrake: true };
/** Its body slip: the angle (rad) between where it points and where it goes. */
const slipAngle = (car) => Math.atan2(-car.vx * Math.cos(car.yaw) + car.vz * Math.sin(car.yaw), Math.hypot(car.vx, car.vz) > 0.5 ? car.speed : 1);

test('the handbrake stops hard in a straight line: about 0.8 to 0.9 g dry, less when wet and on grass, the rear wheels marking', () => {
  laid.length = 0;
  const dry = rolling(50);
  let lit = false;
  dry.lamps = { update: (dt, shown, on, braking) => { lit ||= braking; } };
  const d = stopping(dry, handbrake);
  assert.ok(d.g > 0.8 && d.g < 0.95, `dry: ${d.g.toFixed(2)} g over ${d.metres.toFixed(1)} m`);
  assert.ok(Math.abs(dry.x) < 0.01 && Math.abs(dry.yaw) < 1e-3, 'straight, the wheel straight');
  assert.ok(lit, 'the brake lights come on');
  assert.ok(laid.length > 5, `the locked rear wheels mark the road (${laid.length})`);
  const wet = stopping(rolling(50, 'asphalt', 1), handbrake);
  assert.ok(wet.metres > d.metres * 1.25 && wet.g > 0.5, `wet: ${wet.g.toFixed(2)} g over ${wet.metres.toFixed(1)} m`);
  const grass = stopping(rolling(50, ''), handbrake);
  assert.ok(grass.metres > wet.metres && grass.g > 0.35, `grass: ${grass.g.toFixed(2)} g over ${grass.metres.toFixed(1)} m`);
});

test('ABS: full braking stops at about 0.9 g without locking, and the car still steers', () => {
  const d = stopping(rolling(50), brake);
  assert.ok(d.g > 0.85 && d.g < 0.97, `dry: ${d.g.toFixed(2)} g over ${d.metres.toFixed(1)} m`);
  assert.ok(stopping(rolling(50, 'asphalt', 1), brake).g < 0.75, 'less on a wet road');
  const turning = rolling(60);
  run(turning, 1, { ...brake, steer: 1 });
  assert.ok(-turning.yaw > 0.4, `braking hard it still turns right (${(-turning.yaw * 57.3).toFixed(0)} degrees in a second)`);
  assert.ok(Math.abs(slipAngle(turning)) < 0.35 && turning.slideR < 0.5 * turning.speed, `its wheels rolling, not sliding round (${slipAngle(turning).toFixed(2)} rad, the rear sliding ${turning.slideR.toFixed(2)} m/s)`);
});

test('a handbrake turn: with the wheel turned the back swings round, and it recovers once let go', () => {
  laid.length = 0;
  const swing = rolling(40);
  run(swing, 0.8, { ...handbrake, steer: 1 });
  const plain = rolling(40);
  run(plain, 0.8, { ...brake, steer: 1 });
  assert.ok(-swing.yaw > 0.8 && -swing.yaw > 1.5 * -plain.yaw, `swung round ${(-swing.yaw * 57.3).toFixed(0)} degrees (braking alone ${(-plain.yaw * 57.3).toFixed(0)})`);
  assert.ok(Math.abs(slipAngle(swing)) > 0.25, 'sliding sideways');
  assert.ok(laid.length > 10, 'marks from the rear');
  run(swing, 1.5, { ...throttle, throttle: 0.4 });
  assert.ok(Math.abs(slipAngle(swing)) < 0.05 && Math.abs(swing.turn) < 0.1, 'gripping and going straight again');
  // Pulled at speed and held, it doesn't keep spinning.
  const fast = rolling(90);
  run(fast, 2, { ...handbrake, steer: 1 });
  assert.ok(-fast.yaw < Math.PI, `at most about half round (${(-fast.yaw * 57.3).toFixed(0)} degrees)`);
});

test('cornering too fast it runs wide, more on a wet road or grass, and never past its top speed however it slides', () => {
  const lateral = (kmh, mat, wet) => {
    const car = rolling(kmh, mat, wet);
    for (let i = 0; i < 180; i++) {
      const v = Math.hypot(car.vx, car.vz);
      car.drive(1 / 60, { ...throttle, throttle: Math.max(0, Math.min(1, (kmh / 3.6 - v) * 0.8)), steer: 1 }, []);
      car.update(1 / 60, true);
    }
    mood.wet = 0;
    return Math.abs(car.turn) * Math.hypot(car.vx, car.vz) / 9.81;
  };
  const dry = lateral(80, 'asphalt', 0);
  assert.ok(dry > 0.75 && dry < 1.1, `dry: ${dry.toFixed(2)} g round the turn`);
  assert.ok(lateral(80, 'asphalt', 1) < dry * 0.85, 'wet');
  assert.ok(lateral(50, '', 0) < 0.6, 'grass');
  // The server allows a driver the car's top speed (and a little for the network): never more, sliding or not.
  const car = rolling(200);
  let most = 0;
  let step = 0;
  for (let i = 0; i < 1200; i++) {
    const [x, z] = [car.x, car.z];
    car.drive(1 / 60, { throttle: i % 120 < 70 ? 1 : 0, brake: i % 300 > 280 ? 1 : 0, steer: i % 90 < 45 ? 1 : -1, handbrake: i % 50 < 22 }, []);
    car.update(1 / 60, true);
    most = Math.max(most, Math.hypot(car.vx, car.vz));
    step = Math.max(step, Math.hypot(car.x - x, car.z - z) * 60);
  }
  assert.ok(most <= car.spec.maxSpeed + 1e-9 && step <= car.spec.maxSpeed + 1e-6, `${most} m/s, ${step} m/s between frames`);
  assert.ok(finite(car));
});
