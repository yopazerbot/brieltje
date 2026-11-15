import assert from 'node:assert/strict';
import test from 'node:test';
import { answerGuess, bendShare, clearSpot, fallEnd, KNOCK, KNOCK_HOME_MS, knockBike, sweptHit, tumblePose } from './bikeKnock.mjs';
import { HOMES } from './homes.mjs';
import { PORTALS } from './portals.mjs';
import SPAWNS from './spawns.json' with { type: 'json' };

// A car knocks a bike nobody rides (shared/bikeKnock.mjs): the same place for the same hit, on the page
// and on the server. A car drives along -z (yaw 0) at `kmh` from 3 m behind a bike standing at the origin.
const OPEN = () => true;
const BIKE = { x: 0, z: 0, yaw: 0 };
const hit = (kmh, bike = BIKE, ok = OPEN, car = { x: 0, z: 3 }) => knockBike(bike, car, 0, -kmh / 3.6, ok);
const near = (a, b, eps = 0.05) => Math.abs(a - b) < eps;

test('slow it tips over where it stands; faster it is thrown further, 8 m at most', () => {
  assert.equal(hit(1), null, 'a car at 1 km/h (a car standing on a bike) knocks nothing');
  const tip = hit(8);
  assert.ok(near(tip.dist, KNOCK.near), `8 km/h: tipped over ${tip.dist} m away`);
  assert.ok(near(hit(40).dist, 3.04), `40 km/h: ${hit(40).dist}`);
  assert.ok(near(hit(100).dist, 6.71), `100 km/h: ${hit(100).dist}`);
  assert.ok(near(hit(200).dist, 8, 1e-9) && hit(200).v <= KNOCK.top, 'flat out: 8 m, the speed held to the fastest car');
  assert.ok(near(hit(1000).dist, 8, 1e-9) && hit(1000).v === KNOCK.top, 'a made-up speed: no further than flat out');
  for (const kmh of [8, 40, 100, 200]) {
    const r = hit(kmh);
    assert.ok(r.lie === 1 || r.lie === -1, 'it lies on a side');
    assert.equal(r.ms, Math.round(350 + 110 * r.dist), 'the fall takes longer the further it goes');
  }
});

test('thrown ahead and aside to the side it was on (to the right when dead ahead), lying away from the car', () => {
  const ahead = hit(60);
  assert.ok(ahead.x > 0 && ahead.z < 0, `dead ahead: ahead and to the right ${JSON.stringify(ahead)}`);
  assert.ok(near(Math.atan2(ahead.x, -ahead.z), KNOCK.aside, 1e-6), '25 degrees aside');
  const left = hit(60, { x: -0.5, z: 0, yaw: 0 });
  assert.ok(left.x < -0.5 && left.z < 0, `on the car's left: thrown to the left ${JSON.stringify(left)}`);
  // Its lie: the side of the bike that faces the throw (its right is (-fz, fx) of its nose) is the one it lies on.
  for (const r of [ahead, left, hit(15), hit(140, { x: 0.4, z: 0, yaw: 1.2 })]) {
    const fx = -Math.sin(r.yaw), fz = -Math.cos(r.yaw);
    const from = r === left ? { x: -0.5, z: 0 } : r.dist > 7 ? { x: 0.4, z: 0 } : BIKE;
    const along = (r.x - from.x) * -fz + (r.z - from.z) * fx;
    assert.ok(Math.sign(along) === r.lie, `lies on the side it went to: ${JSON.stringify(r)}`);
  }
});

test('the same hit gives the same place, every time', () => {
  const ok = (x, z) => !(x > 2 && z < -3);
  const a = knockBike({ x: 1.23, z: -4.56, yaw: 0.7 }, { x: 1.1, z: -2 }, 3.3, -21.7, ok);
  const b = knockBike({ x: 1.23, z: -4.56, yaw: 0.7 }, { x: 1.1, z: -2 }, 3.3, -21.7, ok);
  assert.deepEqual(a, b);
});

test('the path ends before the first place it may not lie; a wall at once and it tips over in place', () => {
  const asked = [];
  const wall = (x, z, yaw) => {
    asked.push([x, z, yaw]);
    return Math.hypot(x, z) < 2.1;
  };
  const r = hit(100, BIKE, wall);
  assert.ok(r.dist <= 2.1 && r.dist > 2.1 - KNOCK.step, `stopped before the wall: ${r.dist}`);
  assert.ok(asked.every(([x, z, yaw]) => [x, z, yaw].every(Number.isFinite)), 'only finite places asked');
  assert.ok(asked.length <= Math.ceil(KNOCK.far / KNOCK.step), 'no more steps than 8 m');
  // Hemmed in: it tips over where it stands, turned only if that may lie there, else as it stood, else not at all.
  const B = { x: 3, z: 1, yaw: 0.5 };
  const here = (x, z) => x === B.x && z === B.z;
  const turned = hit(100, B, (x, z) => here(x, z), { x: 3, z: 4 });
  assert.ok(here(turned.x, turned.z) && turned.dist === 0 && turned.yaw !== B.yaw, `tipped over in place, turned: ${JSON.stringify(turned)}`);
  const asStood = hit(100, B, (x, z, yaw) => here(x, z) && yaw === B.yaw, { x: 3, z: 4 });
  assert.ok(here(asStood.x, asStood.z) && asStood.yaw === B.yaw && (asStood.lie === 1 || asStood.lie === -1), `tipped over as it stood: ${JSON.stringify(asStood)}`);
  assert.equal(hit(100, B, () => false, { x: 3, z: 4 }), null, 'nowhere it may lie, not even where it stands: it stays standing');
  // Through a gap in a wall it does not jump: one refused step ends the path even if the far side is free.
  const gap = hit(100, BIKE, (x, z) => !(Math.hypot(x, z) > 1 && Math.hypot(x, z) < 1.5));
  assert.ok(gap.dist <= 1, `no jump over the wall: ${gap.dist}`);
});

test('whatever pose comes back, the place it may lie said yes to it (2000 seeded hits against random walls)', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let none = 0;
  for (let i = 0; i < 2000; i++) {
    // A random patchwork of places it may and may not lie, by position and heading.
    const cut = rnd();
    const ok = (x, z, yaw) => Math.sin(x * 3.1 + cut * 9) + Math.cos(z * 2.7 - cut * 5) + 0.6 * Math.sin(yaw * 2) > 0.2;
    const bike = { x: rnd() * 20 - 10, z: rnd() * 20 - 10, yaw: rnd() * 6 - 3 };
    const a = rnd() * 6.28;
    const v = 0.6 + rnd() * 60;
    const r = knockBike(bike, { x: bike.x - Math.cos(a) * 2.5, z: bike.z - Math.sin(a) * 2.5 }, Math.cos(a) * v, Math.sin(a) * v, ok);
    if (!r) {
      none++;
      assert.ok(!ok(bike.x, bike.z, bike.yaw), 'nothing only when even where it stood may not');
      continue;
    }
    assert.ok(ok(r.x, r.z, r.yaw), `${i}: ${JSON.stringify(r)}`);
  }
  assert.ok(none > 0 && none < 2000);
});

test('the page\'s guess and the server\'s answer: bent over the rest of the fall, there already, or gone to anew', () => {
  const fall = { from: { ...BIKE, lean: 0 }, to: { x: 1, z: -3, yaw: 0.4, lie: 1 }, v: 11 };
  // The same side: the difference is bent in over the rest of the fall, from where the fall is now.
  const a = answerGuess(fall, 0.3, { x: 0.2, z: -0.5, yaw: 0.1, lie: 0 }, { x: 1.3, z: -2.6, yaw: 0.5, lie: 1 });
  assert.ok(a.bend && Math.abs(a.bend.dx - 0.3) < 1e-9 && Math.abs(a.bend.dz - 0.4) < 1e-9 && Math.abs(a.bend.dyaw - 0.1) < 1e-9 && a.bend.u === 0.3);
  assert.equal(bendShare(a.bend, 0.3), 0, 'none of it shows at once');
  assert.equal(bendShare(a.bend, 1), 1, 'all of it at the end');
  assert.ok(bendShare(a.bend, 0.65) > 0.4 && bendShare(a.bend, 0.65) < 0.6, 'smoothly between');
  const end = fallEnd({ ...fall, bend: a.bend });
  assert.ok(Math.abs(end.x - 1.3) < 1e-9 && Math.abs(end.z + 2.6) < 1e-9 && Math.abs(end.yaw - 0.5) < 1e-9 && end.lie === 1, 'it ends where the server has it');
  assert.deepEqual(fallEnd(fall), { x: 1, z: -3, yaw: 0.4, lie: 1 }, 'without a bend: where the page put it');
  // The other side, or after the fall somewhere else: it goes there anew. Lying where the server has it: nothing to do.
  assert.equal(answerGuess(fall, 0.5, BIKE, { x: 1, z: -3, yaw: 0.4, lie: -1 }), 'go');
  assert.equal(answerGuess(null, 1, { x: 1, z: -3, yaw: 0.4, lie: 1 }, { x: 1.02, z: -3, yaw: 0.41, lie: 1 }), 'there');
  assert.equal(answerGuess(null, 1, { x: 1, z: -3, yaw: 0.4, lie: 1 }, { x: 2, z: -3, yaw: 0.4, lie: 1 }), 'go');
  // Back up on its wheels (a guess the server didn't take up): `lie` 0 eases to standing, no hop, no roll.
  const up = { from: { x: 1, z: -3, yaw: 0.4, lean: 1.45 }, to: { x: 0, z: 0, yaw: 0, lie: 0 }, v: 0 };
  for (let u = 0; u <= 1; u += 0.1) assert.equal(tumblePose(up, u).hop, 0);
  assert.ok(Math.abs(tumblePose(up, 1).lean) < 1e-9 && tumblePose(up, 1).x === 0, 'standing where it stood');
});

test('made-up numbers knock nothing', () => {
  for (const v of [NaN, Infinity, -Infinity, undefined, '5', null]) {
    assert.equal(knockBike({ x: 0, z: 0, yaw: 0 }, { x: 0, z: 3 }, v, -10, OPEN), null, String(v));
    assert.equal(knockBike({ x: v, z: 0, yaw: 0 }, { x: 0, z: 3 }, 0, -10, OPEN), null, String(v));
    assert.equal(sweptHit({ halfL: 2.4, halfW: 1 }, { x: v, z: 5, yaw: 0 }, { x: 0, z: -5, yaw: 0 }, { x: 0, z: 0, yaw: 0, halfL: 0.9, halfW: 0.3 }), null);
    assert.equal(clearSpot(v, 0, 0, 0), false);
  }
});

test('the fall: from where it stood to where it lies, a hop when thrown, the lean going over', () => {
  for (const kmh of [8, 40, 100]) {
    const r = hit(kmh);
    const fall = { from: { ...BIKE, lean: -0.09 }, to: r, v: r.v };
    const a = tumblePose(fall, 0);
    const b = tumblePose(fall, 1);
    assert.ok(near(a.x, 0, 1e-9) && near(a.z, 0, 1e-9) && near(a.lean, -0.09, 1e-9) && a.hop === 0, `starts where it stood: ${JSON.stringify(a)}`);
    assert.ok(near(b.x, r.x, 1e-9) && near(b.z, r.z, 1e-9) && near(b.yaw, r.yaw, 1e-9) && near(b.hop, 0, 1e-9), `ends where it lies: ${JSON.stringify(b)}`);
    const lean = Math.atan2(Math.sin(b.lean), Math.cos(b.lean));
    assert.ok(near(lean, r.lie * KNOCK.lie, 1e-9), `on its side: ${b.lean}`);
    let top = 0;
    for (let u = 0; u <= 1; u += 0.01) top = Math.max(top, tumblePose(fall, u).hop);
    assert.ok(top <= 0.8 + 1e-9 && (kmh < 10 ? top === 0 : top > 0), `a hop when thrown, at most 0.8 m: ${top}`);
    // Past 3 m it rolls over once on the way.
    assert.equal(Math.abs(b.lean) > Math.PI, r.dist > 3);
  }
  assert.deepEqual(tumblePose({ from: { ...BIKE, lean: 0 }, to: hit(40), v: 11 }, NaN), tumblePose({ from: { ...BIKE, lean: 0 }, to: hit(40), v: 11 }, 1));
});

test('the sweep: a fast car between two updates still meets the bike; one passing beside it does not', () => {
  const car = { halfL: 4.79 / 2, halfW: 1.92 / 2 };
  const bike = { x: 0, z: 0, yaw: 0, halfL: 0.925, halfW: 0.31 };
  // 55 m/s, an update every 33 ms: 1.8 m apart, either side of the bike, the boxes never overlap at either end.
  const from = { x: 0, z: 4.5, yaw: 0 };
  const to = { x: 0, z: -4.5, yaw: 0 };
  assert.ok(sweptHit(car, from, to, bike), 'met between the two');
  assert.equal(sweptHit(car, { x: 5, z: 4.5, yaw: 0 }, { x: 5, z: -4.5, yaw: 0 }, bike), null, '5 m aside');
  assert.equal(sweptHit(car, { x: 0, z: 30, yaw: 0 }, { x: 0, z: 20, yaw: 0 }, bike), null, 'not yet there');
  const at = sweptHit(car, { x: 0, z: 10, yaw: 0 }, { x: 0, z: -10, yaw: 0 }, bike);
  assert.ok(at.z > 0 && at.z <= car.halfL + bike.halfL + KNOCK.sweep, `where they first meet: ${at.z}`);
  // Already on it (standing on it, or rolling on over one it just tipped over): no new hit.
  assert.equal(sweptHit(car, { x: 0, z: 1, yaw: 0 }, { x: 0, z: -1, yaw: 0 }, bike), null);
});

test('never on a portal, a start place or in a locked home; open ground is fine', () => {
  for (const p of PORTALS) {
    assert.equal(clearSpot(p.x, p.z, 0, 0), false, `${p.id}'s pad`);
    assert.equal(clearSpot(p.out[0], p.out[1], 0, 0), false, `${p.id}'s way out`);
    assert.equal(clearSpot(p.car[0], p.car[1], 0, 0), false, `${p.id}'s car spot`);
  }
  for (const s of SPAWNS) assert.equal(clearSpot(s.x + 1.5, s.z, s.y, 0), false, `start place ${s.name}`);
  for (const h of HOMES) {
    for (const band of h.bands) {
      const [x0, z0, x1, z1] = band.box;
      let found = 0;
      for (let x = x0; x <= x1; x += 0.5) for (let z = z0; z <= z1; z += 0.5) {
        const y = band.y0 + 0.5;
        // A spot well inside the band (all of a lying bike's box in it).
        if (![[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].every(([a, b]) => clearSpot(x + a, z + b, y, 0) === false)) continue;
        found++;
      }
      assert.ok(found > 0, `${h.id}: refused inside`);
    }
  }
  assert.equal(clearSpot(30, 22, -0.1, 0), true, 'the road in front of the house');
  assert.equal(KNOCK_HOME_MS, 300_000, 'back on its spot after 5 minutes');
});
