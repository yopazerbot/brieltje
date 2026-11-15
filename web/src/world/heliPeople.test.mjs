// The people in the helicopter (world/heliPeople.ts): the model's points they use are the model's own, every hand and
// foot of all four seats stays in the cabin, within reach of the figure's short arms and legs at every stick
// deflection, the poses follow the machine's frame (no frame behind it), and the names stand one over the other.
// The full fit against the drawn model (nothing through the shell, a seat or a neighbour) is tools/dev/helipeople.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as THREE from 'three';

const SEAT_HIP = 0.8; // net/swat.ts
const source = readFileSync(new URL('./heliPeople.ts', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replaceAll('export ', '');
const P = new Function('THREE', 'SEAT_HIP', 'hasSwat', `${stripTypeScriptTypes(source)}; return { POINTS, SEATS, FITS, PILOT, PASSENGER, gripAt, seatPlaces, place, HeliPeople };`)(THREE, SEAT_HIP, () => true);
const manifest = JSON.parse(readFileSync(new URL('../../../docs/helicopter/manifest.json', import.meta.url), 'utf8'));
const heliJson = JSON.parse(readFileSync(new URL('../../shared/heli.json', import.meta.url), 'utf8'));
const node = (n) => manifest.nodes[n].position;
const seatAt = (i) => new THREE.Vector3(...node(`Seat_${i}`));
const near = (a, b, eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < eps);

/**
 * The figure's own measures, as seated by heliPeople.ts (measured in the game by heliPeople.report, tools/dev/helipeople.mjs):
 * its arm and leg lengths, and its shoulders and hip joints (left, right) from the seat's point in the model's frame, the
 * pilot's (leant over the sticks) and a passenger's. Measure again when FITS or the figure changes.
 */
const ARM = 0.413;
const LEG = 0.934;
const SHOULDERS = { pilot: [[-0.155, 0.541, -0.147], [0.154, 0.541, -0.149]], passenger: [[-0.153, 0.573, 0.023], [0.153, 0.573, 0.023]] };
const HIPS = { pilot: [[-0.119, 0.094, -0.035], [0.119, 0.094, -0.035]], passenger: [[-0.119, 0.112, -0.024], [0.119, 0.112, -0.024]] };

test("the points are the model's own (docs/helicopter/manifest.json)", () => {
  assert.ok(near(P.POINTS.gripCyclic, node('Grip_Cyclic')));
  assert.ok(near(P.POINTS.pivotCyclic, node('Stick_Cyclic')));
  assert.ok(near(P.POINTS.gripCollective, node('Grip_Collective')));
  assert.ok(near(P.POINTS.pivotCollective, node('Stick_Collective')));
  assert.ok(near(P.POINTS.pedals[0], node('Pedal_L')) && near(P.POINTS.pedals[1], node('Pedal_R')));
  assert.equal(P.POINTS.floor, heliJson.size.floor);
  assert.equal(P.SEATS, 4);
  for (let i = 0; i < 4; i++) assert.ok(manifest.nodes[`Seat_${i}`].rotation_deg.every((d) => d === 0), 'the four seats face the nose');
});

test('the sticks: still at rest, a full throw moves a grip under 15 cm, the lever up raises its grip', () => {
  const v = new THREE.Vector3();
  const still = { fwd: 0, side: 0, lift: 0 };
  assert.ok(near(P.gripAt('cyclic', still, v).toArray(), node('Grip_Cyclic')));
  assert.ok(near(P.gripAt('collective', still, v).toArray(), node('Grip_Collective')));
  const grip = new THREE.Vector3(...node('Grip_Cyclic'));
  assert.ok(P.gripAt('cyclic', { fwd: 1, side: 0, lift: 0 }, v).z < grip.z, 'forward: towards the nose');
  assert.ok(P.gripAt('cyclic', { fwd: 0, side: 1, lift: 0 }, v).x > grip.x, 'right: to the right');
  for (const s of [{ fwd: 1, side: 1, lift: 0 }, { fwd: -1, side: -1, lift: 0 }, { fwd: 9, side: -9, lift: 0 }]) assert.ok(P.gripAt('cyclic', s, v).distanceTo(grip) < 0.15);
  assert.ok(P.gripAt('collective', { fwd: 0, side: 0, lift: 1 }, v).y > node('Grip_Collective')[1] + 0.05);
});

/** All four places in frame `m` at the sticks' `sticks`. */
const places = (m, sticks = { fwd: 0, side: 0, lift: 0 }, look = 0) => {
  const list = [0, 1, 2, 3].map(P.place);
  P.seatPlaces(list, seatAt, m, 0, look, 0, sticks);
  return list;
};

test('every hand and foot in the cabin and within reach, at every stick deflection', () => {
  const corners = [];
  for (const fwd of [-1, 0, 1]) for (const side of [-1, 0, 1]) for (const lift of [0, 1]) corners.push({ fwd, side, lift });
  for (const sticks of corners) {
    const list = places(new THREE.Matrix4(), sticks);
    list.forEach(({ seat }, i) => {
      const fit = P.FITS[i];
      const hip = seatAt(i);
      for (const p of [...seat.car.hands, ...seat.car.feet]) {
        assert.ok(Math.abs(p.x) < 0.7 && p.y > P.POINTS.floor && p.y < 2.0 && p.z > -2.4 && p.z < 1.0, `seat ${i}: ${p.toArray()} in the cabin`);
      }
      // Within the figure's reach: the legs from its hip joints, the arms from its shoulders (the stick's fist round the grip).
      const role = i ? 'passenger' : 'pilot';
      seat.car.feet.forEach((f, k) => {
        const d = hip.clone().add(new THREE.Vector3(...HIPS[role][k])).distanceTo(f);
        assert.ok(d <= LEG, `seat ${i}: a foot within a leg (${d.toFixed(3)} m, sticks ${JSON.stringify(sticks)})`);
      });
      seat.car.hands.forEach((h, k) => {
        const d = hip.clone().add(new THREE.Vector3(...SHOULDERS[role][k])).distanceTo(h);
        // At most 2 cm short (the check in the game allows 3): at a full diagonal of the cyclic the right hand is 1.6 cm short.
        assert.ok(d <= ARM + 0.02, `seat ${i}: a hand within an arm (${d.toFixed(3)} m, sticks ${JSON.stringify(sticks)})`);
        if (!sticks.fwd && !sticks.side && !sticks.lift) assert.ok(d <= ARM, `seat ${i}: at rest a hand within an arm (${d.toFixed(3)} m)`);
      });
    });
  }
});

test('the poses follow the machine: the same places in its frame, banked or not, never a frame behind', () => {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(10, 30, -5), new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.4, 1.1, -0.6, 'YXZ')), new THREE.Vector3(1, 1, 1));
  const inv = m.clone().invert();
  const flat = places(new THREE.Matrix4());
  const banked = places(m);
  banked.forEach(({ seat }, i) => {
    const f = flat[i].seat;
    const back = (p) => new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(inv);
    assert.ok(back(seat.root).distanceTo(new THREE.Vector3(f.root.x, f.root.y, f.root.z)) < 1e-6);
    for (const k of [0, 1]) {
      assert.ok(seat.car.hands[k].clone().applyMatrix4(inv).distanceTo(f.car.hands[k]) < 1e-6);
      assert.ok(seat.car.feet[k].clone().applyMatrix4(inv).distanceTo(f.car.feet[k]) < 1e-6);
    }
    const q = new THREE.Quaternion().setFromRotationMatrix(m).multiply(f.quat);
    assert.ok(Math.abs(Math.abs(q.dot(seat.quat)) - 1) < 1e-9, 'the figure turned and leant with the machine');
  });
});

test('one name per seat, one over the other; the pilot looks into the turn, the passengers out of their windows', () => {
  const list = places(new THREE.Matrix4(), undefined, 0.3);
  assert.deepEqual(list.map((p) => p.seat.tagUp), [0, 1, 2, 3]);
  assert.equal(list[0].seat.car.head, 0.3);
  assert.ok(list[1].seat.car.head > 0.1 && list[3].seat.car.head > 0.1, 'the left seats look left');
  assert.ok(list[2].seat.car.head < -0.1, 'the right one looks right');
  assert.equal(list[0].seat.bike.grips, list[0].seat.car.hands, 'the pilot leans over the sticks (as on a bike), hands on them');
  assert.equal(list[1].seat.bike, undefined);
});

test('seat(name): only a machine drawn this frame, the seat the server gave, never for no name', () => {
  const people = new P.HeliPeople(() => null);
  const heli = { seats: ['a', null, 'b', null], s: { yaw: 0 }, seatPoint: seatAt };
  people.occupied.set(heli, { heli, ok: true, places: [0, 1, 2, 3].map(P.place), dummies: [null, null, null, null] });
  assert.equal(people.seat('b'), people.occupied.get(heli).places[2].seat);
  assert.equal(people.seat('a').tagUp, 0);
  assert.equal(people.seat('c'), null);
  assert.equal(people.seat(''), null);
  people.occupied.get(heli).ok = false; // its far copy drawn: they show only as names
  assert.equal(people.seat('b'), null);
});
