import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { AIR_GAP, CarBody, groundPlane, PITCH_MAX, rideHeight, ROLL_MAX, skid, VY_MAX } from './carBody.ts';
import * as grip from './carGrip.ts';
import { KNOCK } from '../../shared/bikeKnock.mjs';

// Run the actual animation and movement code without the browser-only sound/texture imports.
const source = readFileSync(new URL('./car.ts', import.meta.url), 'utf8');
const specs = JSON.parse(readFileSync(new URL('../../shared/car.json', import.meta.url), 'utf8'));
const definition = (name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  return stripTypeScriptTypes(source.slice(start, source.indexOf('\n}', start) + 2));
};
const constants = ['WHEELBASE', 'WHEEL_R', 'ACCEL', 'BRAKE', 'REVERSE', 'HANDBRAKE', 'REGEN', 'GRIP', 'ESC', 'STEER', 'TYRE', 'STEER_HALF', 'STEER_FALL', 'STEER_IN', 'STICK_CURVE', 'REVERSE_HOLD', 'SPIN_FROM', 'SPIN_DAMP', 'CAM_FOLLOW', 'CAM_SLIDE', 'CAM_SWING', 'CLEAR', 'SPIN_STEP', 'DRAW', 'ROLL_H', 'TILT', 'HANG', 'NOSE', 'NOSE_RATE', 'AIRBORNE', 'ROUGH', 'CALM', 'angle']
  .map(name => source.match(new RegExp(`^const ${name} = .*?;`, 'm'))?.[0]).join('\n');
const classCode = source.slice(source.indexOf('export class Car')).replace('export class Car', 'class Car');
// The marks and sounds a car makes, counted instead of drawn and played.
const laid = [];
const skidMarks = { lay: (...a) => laid.push(a) };
// The weather the tyres feel (world/mood.ts), set by the tests.
const mood = { wet: 0, snow: 0 };
const Car = new Function('THREE', 'netClock', 'CarBody', 'groundPlane', 'skid', 'PITCH_MAX', 'ROLL_MAX', 'AIR_GAP', 'rideHeight', 'skidMarks', 'G', 'MASS', 'surfaceGrip', 'tyreForces', 'YAW_INERTIA', 'mood', 'KNOCK',
  stripTypeScriptTypes(`${constants}\n${classCode}`, { mode: 'transform' }) + '\nreturn Car;')(THREE, { time: 0 }, CarBody, groundPlane, skid, PITCH_MAX, ROLL_MAX, AIR_GAP, rideHeight, skidMarks,
  grip.G, grip.MASS, grip.surfaceGrip, grip.tyreForces, grip.YAW_INERTIA, mood, KNOCK);

function vehicle(spec = specs.cars.tesla, groundAt = () => ({ y: 0, name: 'street', mat: 'asphalt' })) {
  return Object.assign(Object.create(Car.prototype), {
    spec, x: 0, y: 0, z: 0, yaw: 0, steer: 0, vx: 0, vz: 0, speed: 0, lastSpeed: 0, vy: 0, air: false, flying: false, hang: 0, lastY: 0, riseShown: 0,
    halfL: spec.length / 2, halfW: spec.width / 2, key: 'test-car', ready: true, trees: [],
    group: new THREE.Group(), body: new THREE.Group(), chassis: new THREE.Group(), front: [], wheels: [], spin: 0,
    blurMat: new THREE.MeshStandardMaterial(), taillight: new THREE.MeshStandardMaterial(), lamps: { update() {} },
    world: { boxFree: () => true, boxInBounds: () => true, groundAt, setMoving() {}, touching: () => null },
    motion: new CarBody(), along: 0, side: 0, yawRate: 0, lastX: 0, lastZ: 0, lastYaw: 0, fresh: true,
    turn: 0, pedal: 0, brakePedal: 0, ax: 0, ay: 0, grip: [1, 1, 1, 1], slideF: 0, slideR: 0, crashed: false, reverse: false, stood: 0, brakeWas: false,
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

test('the handbrake stops hard in a straight line: about 0.9 to 1 g dry, less when wet and on grass, the rear wheels marking', () => {
  laid.length = 0;
  const dry = rolling(50);
  let lit = false;
  dry.lamps = { update: (dt, shown, on, braking) => { lit ||= braking; } };
  const d = stopping(dry, handbrake);
  assert.ok(d.g > 0.9 && d.g < 1.1, `dry: ${d.g.toFixed(2)} g over ${d.metres.toFixed(1)} m`);
  assert.ok(Math.abs(dry.x) < 0.01 && Math.abs(dry.yaw) < 1e-3, 'straight, the wheel straight');
  assert.ok(lit, 'the brake lights come on');
  assert.ok(laid.length > 5, `the locked rear wheels mark the road (${laid.length})`);
  const wet = stopping(rolling(50, 'asphalt', 1), handbrake);
  assert.ok(wet.metres > d.metres * 1.04 && wet.metres < d.metres * 1.25 && wet.g > 0.65, `wet: ${wet.g.toFixed(2)} g over ${wet.metres.toFixed(1)} m`);
  const grass = stopping(rolling(50, ''), handbrake);
  assert.ok(grass.metres > wet.metres && grass.g > 0.35, `grass: ${grass.g.toFixed(2)} g over ${grass.metres.toFixed(1)} m`);
});

test('ABS: full braking stops at about 1 g without locking, and the car still steers', () => {
  const d = stopping(rolling(50), brake);
  assert.ok(d.g > 1.0 && d.g < 1.15, `dry: ${d.g.toFixed(2)} g over ${d.metres.toFixed(1)} m`);
  const wetStop = stopping(rolling(50, 'asphalt', 1), brake).g;
  assert.ok(wetStop < d.g && wetStop > 0.85 && wetStop < 1.02, `a little less on a wet road, not ice (${wetStop.toFixed(2)} g)`);
  const turning = rolling(60);
  run(turning, 1, { ...brake, steer: 1 });
  assert.ok(-turning.yaw > 0.4, `braking hard it still turns right (${(-turning.yaw * 57.3).toFixed(0)} degrees in a second)`);
  // The tail steps out a little as it slows (the wheel turns further at a lower speed): about 20 degrees by the
  // end of the second, not round.
  assert.ok(Math.abs(slipAngle(turning)) < 0.45 && turning.slideR < 0.75 * turning.speed, `its wheels rolling, not sliding round (${slipAngle(turning).toFixed(2)} rad, the rear sliding ${turning.slideR.toFixed(2)} m/s)`);
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
  for (const kmh of [60, 90, 150, 200]) {
    const fast = handbrakeTurn(kmh, 5);
    assert.ok(fast.most < 200, `${kmh} km/h held 5 s: at most about half round (${fast.most.toFixed(0)} degrees)`);
  }
});

/**
 * The handbrake held `hold` s at `kmh` with the wheel full over to the right, then let go with a little throttle
 * for 2 s: degrees turned when let go and the most at any time (counted through, not wrapped), and the seconds
 * after letting go until the rear grips again (the slide under 5 degrees, the spin nearly gone).
 */
function handbrakeTurn(kmh, hold, wet = 0, snow = 0) {
  const car = rolling(kmh, 'asphalt', wet);
  mood.snow = snow;
  let turned = 0;
  let most = 0;
  let atRelease = 0;
  let grips = null;
  let last = car.yaw;
  for (let i = 0; i < (hold + 2) * 60; i++) {
    const t = i / 60;
    car.drive(1 / 60, t < hold ? { ...handbrake, steer: 1 } : { ...throttle, throttle: 0.4 }, []);
    car.update(1 / 60, true);
    turned -= Math.atan2(Math.sin(car.yaw - last), Math.cos(car.yaw - last));
    last = car.yaw;
    most = Math.max(most, turned);
    if (t < hold) atRelease = turned;
    // (Swung half round it may still roll on backwards: rolling straight that way grips too.)
    const slide = Math.atan2(-car.vx * Math.cos(car.yaw) + car.vz * Math.sin(car.yaw), Math.max(0.5, Math.abs(car.speed)));
    if (t >= hold && grips === null && Math.abs(slide) < 0.087 && Math.abs(car.turn) < 0.15) grips = t - hold;
  }
  mood.wet = mood.snow = 0;
  return { atRelease: (atRelease * 180) / Math.PI, most: (most * 180) / Math.PI, grips: grips ?? Infinity };
}

test('a handbrake turn swings a quarter round from 40 km/h and half round from 60 km/h, never further, and the rear grips again', () => {
  const quarter = handbrakeTurn(40, 0.8);
  assert.ok(quarter.most > 75 && quarter.most < 100, `40 km/h, 0.8 s: ${quarter.most.toFixed(0)} degrees`);
  assert.ok(quarter.grips < 0.5, `40 km/h: gripping again ${quarter.grips.toFixed(2)} s after letting go`);
  const half = handbrakeTurn(60, 1.6);
  assert.ok(half.most > 165 && half.most < 195, `60 km/h, 1.6 s: ${half.most.toFixed(0)} degrees`);
  assert.ok(half.grips < 0.5, `60 km/h: gripping again ${half.grips.toFixed(2)} s after letting go`);
  // In the rain and on snow it swings less far and slides a little longer, but grips again within the 2 s.
  const wet = handbrakeTurn(60, 1.2, 1);
  const snow = handbrakeTurn(50, 1.2, 0, 1);
  assert.ok(wet.most < 200 && wet.grips < 1, `wet: ${wet.most.toFixed(0)} degrees, grips in ${wet.grips.toFixed(2)} s`);
  assert.ok(snow.most < 200 && snow.grips < 1.5, `snow: ${snow.most.toFixed(0)} degrees, grips in ${snow.grips.toFixed(2)} s`);
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
  assert.ok(dry > 1.0 && dry < 1.3, `dry: ${dry.toFixed(2)} g round the turn`);
  const wetTurn = lateral(80, 'asphalt', 1);
  assert.ok(wetTurn < dry * 0.95 && wetTurn > dry * 0.8, `wet: a little wider, it still turns (${wetTurn.toFixed(2)} g against ${dry.toFixed(2)})`);
  assert.ok(lateral(50, '', 0) < 0.72, 'grass');
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

/** Round and round at `kmh` (the throttle holding it), the wheel at `steer`: the circle it settles on (m), and the wheel's angle. */
function circle(kmh, steer = 1) {
  const car = rolling(kmh);
  const rates = [];
  for (let i = 0; i < 6 * 60; i++) {
    const v = Math.hypot(car.vx, car.vz);
    car.drive(1 / 60, { ...throttle, throttle: Math.max(0, Math.min(1, (kmh / 3.6 - v) * 0.8)), steer }, []);
    car.update(1 / 60, true);
    if (i >= 4 * 60) rates.push(Math.abs(car.turn));
  }
  const rate = rates.reduce((a, b) => a + b, 0) / rates.length;
  return { radius: Math.hypot(car.vx, car.vz) / rate, wheel: Math.abs(car.steer) };
}

test('sharper turning: the circle at 20, 30, 50, 100 and 200 km/h with the wheel full over, calm flat out', () => {
  for (const [kmh, radius] of [[20, 5.2], [30, 6.5], [50, 15.8], [100, 69], [200, 375]]) {
    const c = circle(kmh);
    assert.ok(Math.abs(c.radius - radius) < radius * 0.1, `${kmh} km/h: ${c.radius.toFixed(1)} m (about ${radius} m)`);
  }
});

test('the brake stops from 50, 100 and 200 km/h in about 9.4, 36 and 136 m; wet a tenth longer, snow more', () => {
  for (const [kmh, metres] of [[50, 9.4], [100, 36], [200, 136]]) {
    const d = stopping(rolling(kmh), brake);
    assert.ok(Math.abs(d.metres - metres) < metres * 0.08, `${kmh} km/h: ${d.metres.toFixed(1)} m (about ${metres})`);
  }
  const dry = stopping(rolling(50), brake).metres;
  const wet = stopping(rolling(50, 'asphalt', 1), brake).metres;
  mood.snow = 1;
  const snow = stopping(rolling(50), brake).metres;
  mood.snow = 0;
  assert.ok(wet > dry * 1.04 && wet < dry * 1.2, `wet ${wet.toFixed(1)} m against ${dry.toFixed(1)} m`);
  assert.ok(snow > dry * 1.4 && snow < dry * 1.9, `snow ${snow.toFixed(1)} m`);
});

/** Frames of `input` (a function of the frame's time) until `seconds`: the car's speed along itself each frame. */
function speeds(car, seconds, input) {
  const out = [];
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    car.drive(1 / 60, input(i / 60), []);
    car.update(1 / 60, true);
    out.push({ t: (i + 1) / 60, speed: car.speed, v: Math.hypot(car.vx, car.vz), lit: car.braking });
  }
  return out;
}

test('the brake held from 50 km/h stops the car, keeps it standing with its brake lights on, and reverses only after a moment', () => {
  const log = speeds(rolling(50), 4, () => brake);
  const stood = log.find((f) => f.v < 0.05).t;
  const back = log.find((f) => f.speed < -0.05).t;
  assert.ok(back - stood >= 0.3 && back - stood < 0.5, `stood at ${stood.toFixed(2)} s, backwards at ${back.toFixed(2)} s`);
  assert.ok(log.filter((f) => f.t < stood).every((f) => f.speed >= 0), 'never backwards while it rolls');
  assert.ok(log.filter((f) => f.t >= stood && f.t < stood + 0.25).every((f) => f.lit), 'the brake lights on while it stands on the brake');
  assert.ok(log[log.length - 1].speed < -2, `then it drives backwards (${log[log.length - 1].speed.toFixed(2)} m/s)`);
});

test('the brake pumped from 30 km/h never goes backwards; let go and pressed again at rest, it reverses at once', () => {
  const car = rolling(30);
  const pumped = [];
  for (let t = 0; t < 5 && !(pumped.length && pumped[pumped.length - 1].v < 0.05); t += 1 / 60) {
    pumped.push(...speeds(car, 1 / 60, () => (Math.floor(t / 0.1) % 2 ? { ...brake, brake: 0 } : brake)));
  }
  assert.ok(pumped[pumped.length - 1].v < 0.05, 'it stands');
  assert.ok(pumped.every((f) => f.speed > -0.05), `never backwards on the way (${Math.min(...pumped.map((f) => f.speed)).toFixed(3)} m/s)`);
  speeds(car, 0.3, () => ({ ...brake, brake: 0 }));
  const again = speeds(car, 1, () => brake);
  const back = again.find((f) => f.speed < -0.05)?.t ?? Infinity;
  assert.ok(back < 0.2, `backwards ${back.toFixed(2)} s after the new press`);
  // The throttle while it rolls back brakes it, then drives it forwards.
  const forward = speeds(car, 1.5, () => throttle);
  assert.ok(forward[forward.length - 1].speed > 2, `forwards again (${forward[forward.length - 1].speed.toFixed(2)} m/s)`);
});

test('a stick pushed half way turns the wheel about a third of the way; full over it turns all the way', () => {
  for (const kmh of [20, 50]) {
    const half = circle(kmh, 0.5).wheel / circle(kmh, 1).wheel;
    assert.ok(Math.abs(half - 0.35) < 0.03, `${kmh} km/h: ${half.toFixed(2)} of the lock`);
  }
});

// A bike knocked aside (world/bike.ts struck, shared/bikeKnock.mjs): the car drives on, a little slower, with a bump.
test('knocking a bike costs the car 3 % of its speed (at least 0.3 m/s) and a thump; it keeps its way and drives on', () => {
  for (const [kmh, want] of [[100, 97], [40, 38.8], [8, 8 - 0.3 * 3.6], [0.5, 0]]) {
    const car = vehicle();
    car.noise.owner = car;
    const v = kmh / 3.6;
    Object.assign(car, { vx: 0.6 * v, vz: -0.8 * v, speed: v });
    car.nudge(v);
    const after = Math.hypot(car.vx, car.vz) * 3.6;
    assert.ok(Math.abs(after - want) < 0.01, `${kmh} km/h: ${after.toFixed(2)} km/h after, ${want} wanted`);
    if (after > 0) assert.ok(Math.abs(car.vx / car.vz - 0.6 / -0.8) < 1e-9, 'the same way');
    assert.ok(Math.abs(car.speed * 3.6 - after) < 0.01, 'its speed along itself goes down with it');
    assert.equal(car.thumps.length, 1, 'a thump');
    assert.ok(finite(car));
  }
  const still = vehicle();
  still.noise.owner = still;
  still.nudge(0);
  assert.equal(Math.hypot(still.vx, still.vz), 0, 'standing: nothing to lose');
  // It drives on afterwards: the next frames at the wheel are a car's frames as before.
  const car = vehicle();
  run(car, 2, throttle);
  const before = Math.hypot(car.vx, car.vz);
  car.nudge(before);
  run(car, 0.5, throttle);
  assert.ok(Math.hypot(car.vx, car.vz) > before * 0.97, 'it pulls on');
});

// In the air (world/carBody.ts rideHeight, world/car.ts drive): leaving the ground and landing.

/** Rolling along -z at `v` m/s with `input`, frame by frame: when it took off and landed, how high and how fast. */
function flight(car, v, seconds, input = { throttle: 0, brake: 0, steer: 0, handbrake: false }) {
  Object.assign(car, { vz: -v, speed: v, lastSpeed: v });
  car.noise.owner = car;
  const out = { off: null, on: null, frames: 0, most: 0, vyMost: 0, nose: 0, hang: 0, landings: [] };
  const onCrash = Car.onCrash;
  Car.onCrash = (h) => out.landings.push(h);
  try {
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      const was = car.air;
      car.drive(1 / 60, input, []);
      car.update(1 / 60, true);
      // Over the ground under its four wheels, as the car takes it (world/car.ts drive).
      const [c, s] = [Math.cos(car.yaw), Math.sin(car.yaw)];
      const floor = car.axle.at.reduce((sum, [lx, lz]) => sum + car.world.groundAt(car.x + lx * c + lz * s, car.z - lx * s + lz * c, car.y, 0.3).y / 4, 0);
      out.most = Math.max(out.most, car.y - floor);
      out.vyMost = Math.max(out.vyMost, Math.abs(car.vy));
      if (car.air) {
        out.frames++;
        out.nose = Math.min(out.nose, car.ride.pitch);
        out.hang = Math.max(out.hang, car.hang);
      }
      if (car.air && !was) out.off = { t: i / 60, z: car.z, speed: Math.hypot(car.vx, car.vz) };
      if (!car.air && was) out.on = { t: i / 60, z: car.z, speed: Math.hypot(car.vx, car.vz) };
    }
  } finally {
    Car.onCrash = onCrash;
  }
  return out;
}

test('off a 1 m ledge at 20 m/s it flies about 0.45 s and lands about 9 m on, its speed and heading kept, the nose down a little', (t) => {
  const car = vehicle(specs.cars.tesla, (x, z) => ({ y: z > -5 ? 1 : 0, mat: 'asphalt' }));
  car.y = 1;
  const heard = [];
  car.noise.update = (n) => heard.push([car.air, !!n.air]);
  const f = flight(car, 20, 2);
  assert.ok(f.off && f.on, 'it took off and landed');
  // Its sound is told it is in the air while it is (the tyres go still, world/carSound.ts), and back on the ground after.
  assert.ok(heard.some(([a]) => a) && heard.every(([a, n]) => a === n), 'the tyres hear when it flies');
  assert.equal(heard.at(-1)[1], false, 'rolling again after');
  const air = f.on.t - f.off.t;
  assert.ok(Math.abs(air - 0.45) < 0.04, `in the air ${air.toFixed(3)} s`);
  assert.ok(Math.abs(f.off.z - f.on.z - 9) < 0.6, `flew ${(f.off.z - f.on.z).toFixed(2)} m`);
  assert.ok(f.on.speed > 0.97 * f.off.speed, `kept its speed (${f.off.speed.toFixed(2)} to ${f.on.speed.toFixed(2)} m/s)`);
  assert.equal(car.yaw, 0, 'and its heading');
  assert.ok(f.nose < -0.03 && f.nose > -0.11, `the nose dropped a little (${f.nose.toFixed(3)} rad)`);
  assert.ok(f.hang > 0.05, `the wheels hung down (${f.hang.toFixed(3)} m)`);
  assert.ok(Math.abs(car.y) < 1e-9 && !car.air, 'on the lower ground again');
  const land = f.landings.find((h) => h.land);
  assert.ok(land && Math.abs(land.speed - 4.43) < 0.3, `landed at ${land?.speed.toFixed(2)} m/s (a metre's fall is 4.4)`);
  assert.ok(car.thumps.some(([, , , s]) => Math.abs(s - land.speed) < 1e-9), 'a thump as loud');
  assert.ok(f.landings.every((h) => h.land), 'no crash');
  t.diagnostic(`air ${air.toFixed(3)} s, flew ${(f.off.z - f.on.z).toFixed(2)} m, landed at ${land.speed.toFixed(2)} m/s, ${f.off.speed.toFixed(2)} to ${f.on.speed.toFixed(2)} m/s, nose ${f.nose.toFixed(3)} rad, wheels hung ${f.hang.toFixed(3)} m`);
});

test('in the air the tyres hold nothing: no pull, no brake, no steering', () => {
  for (const input of [throttle, brake, { ...throttle, steer: 1 }, handbrake]) {
    const car = vehicle(specs.cars.tesla, (x, z) => ({ y: z > -5 ? 1 : 0, mat: 'asphalt' }));
    car.y = 1;
    Object.assign(car, { z: -4.9, vz: -20, speed: 20, lastSpeed: 20 });
    car.drive(1 / 60, input, []);
    assert.ok(car.air, 'off the ledge');
    const [turn, vx, vz] = [car.turn, car.vx, car.vz];
    for (let i = 0; i < 20; i++) car.drive(1 / 60, input, []);
    assert.ok(car.air, 'still flying');
    // It goes on as it went, turning only as it already turned (from its frame on the ground).
    assert.ok(car.turn === turn && Math.abs(Math.atan2(car.vx, car.vz) - Math.atan2(vx, vz)) < 1e-12, `${JSON.stringify(input)}: the wheel turns nothing`);
    // The air alone: 0.0004 v2 m/s2, 0.05 m/s in a third of a second at 20 m/s.
    assert.ok(car.vz - vz > 0.04 && car.vz - vz < 0.06, `${JSON.stringify(input)}: no pull or brake, only the air (${vz} to ${car.vz} m/s)`);
  }
});

test('on flat ground at any speed, however it is driven, it never leaves the ground', () => {
  const car = vehicle();
  let air = 0;
  let most = 0;
  for (const [s, input] of [[30, throttle], [2, { ...throttle, steer: 1 }], [1.5, handbrake], [2, { ...throttle, steer: -1 }], [3, brake], [0.4, { ...brake, steer: 1 }], [30, throttle], [3, brake]]) {
    for (let i = 0; i < s * 60; i++) {
      car.drive(1 / 60, input, []);
      car.update(1 / 60, true);
      air += car.air ? 1 : 0;
      most = Math.max(most, Math.abs(car.y), Math.abs(car.vy));
    }
  }
  assert.equal(air, 0, 'never in the air');
  assert.equal(most, 0, 'its height never moved');
});

test('a 3 cm step at 5 km/h, up or down, does not lift it; nor do 1 cm joints in the paving at 100 or 200 km/h', () => {
  for (const [name, at, v] of [
    ['3 cm up', (x, z) => (z < -2 ? 0.03 : 0), 5 / 3.6],
    ['3 cm down', (x, z) => (z < -2 ? 0 : 0.03), 5 / 3.6],
    ['joints at 100', (x, z) => 0.01 * (Math.floor(-z / 4) % 2), 100 / 3.6],
    ['joints at 200', (x, z) => 0.01 * (Math.floor(-z / 4) % 2), 200 / 3.6],
    ['a 3 cm kerb up at 50', (x, z) => (z < -2 ? 0.03 : 0), 50 / 3.6],
  ]) {
    const car = vehicle(specs.cars.tesla, (x, z) => ({ y: at(x, z), mat: 'concrete' }));
    car.y = at(0, 0);
    const f = flight(car, v, 4, { ...throttle, throttle: v > 5 ? 0.6 : 0.05 });
    assert.equal(f.frames, 0, `${name}: never in the air`);
    assert.ok(f.most < 0.03 && f.vyMost < 0.6, `${name}: it follows it (${f.most.toFixed(3)} m over it at most, ${f.vyMost.toFixed(2)} m/s)`);
    assert.equal(f.landings.length, 0, `${name}: nothing to land from`);
  }
});

test('off a pavement\'s 8 cm kerb at 50 km/h, through an 8 cm dip in a country road at 200, over a seam in the paving or a wavy street, its wheels keep the ground', () => {
  for (const [name, at, v] of [
    ['kerb', (x, z) => (z < -2 ? 0 : 0.08), 50 / 3.6],
    // Down 6.8 % for 1.2 m, as on the straight road in the fields (tools/dev/carAir.mjs).
    ['dip', (x, z) => -Math.max(0, Math.min(0.08, (-z - 20) * 0.068)), 200 / 3.6],
    // Down a 13 % slope onto paving that starts 2.7 cm proud of the ground and goes on down with it (Briel at
    // 78, 254: one sample under the car's middle took the car's speed down away there, and it flew 15 cm).
    ['seam', (x, z) => 0.13 * z + (z < -20 ? 0.027 : 0), 50 / 3.6],
    // A street whose surface rises and falls 16 cm about every 5 m (Schildekensstraat at 119, -1063): under the
    // middle alone it threw the car at 61 km/h; the wheels a wheelbase apart ride it out.
    ['waves', (x, z) => 0.08 * Math.sin((2 * Math.PI * z) / 5), 70 / 3.6],
  ]) {
    const car = vehicle(specs.cars.tesla, (x, z) => ({ y: at(x, z), mat: 'concrete' }));
    car.y = at(0, 0);
    car.vy = ((at(0, -0.05) - at(0, 0)) / 0.05) * v; // already going down the slope with it
    const f = flight(car, v, 2, { ...throttle, throttle: 0.6 });
    assert.equal(f.frames, 0, `${name}: never in the air (${f.most.toFixed(3)} m over the ground at most)`);
    assert.equal(f.landings.length, 0, `${name}: no landing`);
  }
});

test('a crest at speed throws it, gently driven it follows; a kerb up never throws it', (t) => {
  // Up 10 % for 10 m, then down 10 %.
  const hill = (x, z) => ({ y: Math.max(0, 1 - Math.abs(-z - 20) * 0.1), mat: 'asphalt' });
  const slow = flight(vehicle(specs.cars.tesla, hill), 5, 8);
  assert.equal(slow.frames, 0, 'at 18 km/h it keeps to the road');
  const fast = flight(vehicle(specs.cars.tesla, hill), 25, 3);
  assert.ok(fast.frames > 6 && fast.most > 0.1, `at 90 km/h it flies off the top (${fast.frames} frames, ${fast.most.toFixed(2)} m)`);
  // A 25 cm kerb up at 50 km/h: lifted onto it, never thrown over it.
  const kerb = flight(vehicle(specs.cars.tesla, (x, z) => ({ y: z < -3 ? 0.25 : 0, mat: 'concrete' })), 50 / 3.6, 2);
  assert.equal(kerb.frames, 0, 'up the kerb, no flight');
  assert.ok(kerb.most < 0.01, `never over it (${kerb.most.toFixed(3)} m)`);
  t.diagnostic(`crest at 90 km/h: ${fast.frames} frames in the air, ${fast.most.toFixed(2)} m over the ground; at 18 km/h ${slow.most.toFixed(3)} m`);
});

test('its speed up or down never passes 15 m/s: off a 40 m drop it lands at 15', () => {
  const car = vehicle(specs.cars.tesla, (x, z) => ({ y: z > -5 ? 40 : 0, mat: undefined }));
  car.y = 40;
  const f = flight(car, 20, 5);
  assert.ok(f.on, 'it landed');
  assert.ok(f.vyMost <= VY_MAX && VY_MAX < 16, `at most ${f.vyMost} m/s (the server takes 16)`);
  assert.ok(Math.abs(f.landings[0].speed - 15) < 1e-9 && f.landings[0].what === '', 'on the bare ground at 15 m/s');
  assert.ok(f.on.speed > 0.9 * 20, `no damage, a little speed lost (${f.on.speed.toFixed(1)} m/s)`);
  assert.ok(finite(car) && Math.abs(car.motion.sink) <= 0.16);
});

test('rideHeight stays finite and on or over the ground at any frame time and input', () => {
  for (const dt of [1 / 60, 0.5, 5, 1e-6, 0, -1, NaN, 1 / 240]) {
    for (const floor of [0, 1e6, -1e6, NaN, Infinity, 0.03]) {
      const h = { y: 0, vy: 0, air: false };
      for (let i = 0; i < 5; i++) {
        rideHeight(h, floor, dt);
        assert.ok(Number.isFinite(h.y) && Number.isFinite(h.vy) && Math.abs(h.vy) <= VY_MAX, `dt ${dt}, floor ${floor}`);
        if (Number.isFinite(floor) && dt > 0) assert.ok(h.y >= Math.min(floor, 0) - 1e-9, 'never under the ground');
      }
    }
  }
  const h = { y: NaN, vy: Infinity, air: true };
  rideHeight(h, 2, 1 / 60);
  assert.deepEqual(h, { y: 2, vy: 0, air: false }, 'not a number: put on the ground');
  assert.ok(AIR_GAP > 0.03 && AIR_GAP <= 0.12);
});

test('a landing sinks the body deeper the harder it lands, and it settles', (t) => {
  let last = 0;
  const dips = [];
  for (const v of [1, 2, 4.43, 6, 8, 15]) {
    const body = new CarBody();
    body.land(v);
    let least = 0;
    for (let i = 0; i < 90; i++) {
      body.step(1 / 60, 0, 0);
      least = Math.min(least, body.sink);
    }
    assert.ok(least < last || v === 15, `${v} m/s sinks deeper (${least.toFixed(3)} m)`);
    assert.ok(least >= -0.16, 'never more than 16 cm');
    if (v === 4.43) assert.ok(least < -0.06 && least > -0.1, `a metre's fall: about 8 cm (${least.toFixed(3)})`);
    last = least;
    dips.push(`${v} m/s: ${(least * 100).toFixed(1)} cm`);
    assert.ok(Math.abs(body.sink) < 2e-3 && Math.abs(body.heave) < 1e-9 && Math.abs(body.pitch) < 1e-9, `settled after 1.5 s (${body.sink})`);
  }
  const body = new CarBody();
  body.land(NaN);
  body.land(-3);
  body.step(1 / 60, 0, 0);
  assert.equal(body.sink, 0, 'nothing from no landing');
  t.diagnostic(`the body sinks ${dips.join(', ')}`);
});

test('a car someone else drives is drawn in the air from its track, its wheels hanging, and lands with a thump', () => {
  // The server's states twenty a second: along -z at 20 m/s, off a 1 m ledge at z = -10.
  const fall = (t) => Math.max(0, 1 - Math.max(0, t - 0.5) ** 2 * 4.905);
  let now = 0;
  const car = vehicle(specs.cars.tesla, (x, z) => ({ y: z > -10 ? 1 : 0, mat: 'gravel' }));
  car.noise.owner = car;
  Object.assign(car, { y: 1, pose: [], track: { at: (time, pose) => {
    const k = Math.floor(now * 20) / 20;
    const y = fall(k) + (fall(k + 0.05) - fall(k)) * (now - k) * 20;
    pose.length = 0;
    pose.push(0, y, -20 * now, 0, 0);
    return true;
  } } });
  const landings = [];
  const onCrash = Car.onCrash;
  Car.onCrash = (h) => landings.push(h);
  let flew = 0;
  let drawnOver = 0;
  let hang = 0;
  try {
    for (let i = 0; i < 2 * 60; i++) {
      now = i / 60;
      car.update(1 / 60, false);
      if (car.flying) {
        flew++;
        hang = Math.max(hang, car.hang);
        drawnOver = Math.max(drawnOver, car.group.position.y - (car.z > -10 ? 1 : 0));
      }
    }
  } finally {
    Car.onCrash = onCrash;
  }
  assert.ok(flew > 10, `drawn flying (${flew} frames)`);
  assert.ok(drawnOver > 0.3, `drawn well over the ground, not on it (${drawnOver.toFixed(2)} m)`);
  assert.ok(hang > 0.04, `its wheels hanging (${hang.toFixed(3)} m)`);
  assert.equal(landings.length, 1, 'one landing');
  assert.ok(landings[0].land && landings[0].speed > 2.5 && landings[0].what === 'gravel', `seen landing at ${landings[0].speed.toFixed(2)} m/s on gravel`);
  assert.ok(car.thumps.length >= 1, 'a thump');
  assert.ok(!car.flying && car.hang < 0.01, 'on its wheels again');
});
