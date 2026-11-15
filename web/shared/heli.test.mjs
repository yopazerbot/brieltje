// The helicopter's flight (shared/heli.mjs) as the page runs it: a frame of 1/60 s sub-stepped at 120 a second.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EV, HELI, SKIDS, heliBump, heliFly, heliPlace, heliStart } from './heli.mjs';

const DATA = JSON.parse(readFileSync(new URL('./heli.json', import.meta.url), 'utf8'));
const DT = 1 / 60;
const flat = (more = {}) => ({ ground: () => 0, ceiling: 120, wind: [0, 0], edge: null, pad: null, ...more });
const speed = (s) => Math.hypot(s.vx, s.vz);

/** At a hover `y` m up over flat ground, rotor at speed, settled. */
function hovering(y, env = flat()) {
  const s = heliStart({ x: 0, y: 0, z: 0, yaw: 0 });
  Object.assign(s, { y, holdY: y, ground: false, engine: true, rotor: 1, coll: 0.5 });
  for (let i = 0; i < 300; i++) heliFly(s, {}, env, DT);
  s.ev = 0;
  return s;
}
function fly(s, secs, input, env = flat(), each) {
  for (let t = 0; t < secs; t += DT) {
    heliFly(s, typeof input === 'function' ? input(s, t) : input, env, DT);
    if (each?.(s, t)) return t;
    s.ev = 0;
  }
  return secs;
}
const finite = (s) => ['x', 'y', 'z', 'vx', 'vy', 'vz', 'yaw', 'pitch', 'roll', 'rotor', 'coll'].every((k) => Number.isFinite(s[k]));

test('the sizes the flight uses are the ones in heli.json', () => {
  assert.deepEqual(SKIDS, DATA.size.skids);
  assert.equal(HELI.ROTOR_R, DATA.size.rotor.r);
  assert.equal(HELI.ROTOR_Y, DATA.size.rotor.y);
  for (const m of DATA.machines) assert.ok(DATA.paints[m.paint], m.id);
});

test('the same inputs give the same flight, twice', () => {
  const script = (s, t) => ({ fwd: Math.sin(t), side: Math.cos(t * 0.7), turn: Math.sin(t * 1.3), lift: t < 12 ? 1 : Math.sin(t * 0.4) });
  const wind = flat({ wind: [3, -2] });
  const one = heliStart();
  const two = heliStart();
  let high = 0;
  fly(one, 40, script, wind, (q) => void (high = Math.max(high, q.y)));
  fly(two, 40, script, wind);
  assert.deepEqual(one, two);
  assert.ok(high > 5, 'it flew');
});

test('no NaN and no runaway for any input held for a minute, nor for odd time steps', () => {
  const inputs = [
    { fwd: 1, lift: 1, turn: 1 }, { fwd: -1, side: -1, lift: -1, turn: -1 }, { side: 1, lift: 1 }, { fwd: 1, side: 1, turn: -1, lift: 0.3 },
    { fwd: NaN, side: Infinity, turn: -Infinity, lift: 'up' }, { fwd: 1e9, lift: 1e9 },
  ];
  for (const input of inputs) {
    const s = heliStart();
    fly(s, 60, (q, t) => (t > 30 && Math.floor(t) % 2 ? Object.fromEntries(Object.entries(input).map(([k, v]) => [k, typeof v === 'number' ? -v : v])) : input));
    assert.ok(finite(s), JSON.stringify(input));
    assert.ok(speed(s) <= HELI.V_CAP + 1e-9 && s.y <= 120 + 1e-9 && s.y >= -1e-9, JSON.stringify({ input, y: s.y, v: speed(s) }));
  }
  for (const dt of [0, -1, 1e-9, 0.5, 10, NaN, Infinity]) {
    const s = hovering(30);
    for (let i = 0; i < 20; i++) heliFly(s, { fwd: 1, lift: 1, turn: 1 }, flat(), dt);
    assert.ok(finite(s), `dt ${dt}`);
    assert.ok(s.y <= 120 + 1e-9 && speed(s) <= HELI.V_CAP + 1e-9, `dt ${dt}`);
  }
});

test('the rotor gives no lift before it is up to speed, then it lifts off', () => {
  const s = heliStart();
  let off = null;
  fly(s, 15, { lift: 1 }, flat(), (q, t) => {
    if (q.y > 0.05 && off === null) {
      off = t;
      assert.ok(q.rotor >= HELI.LIFT_RPM, `lifted at rotor ${q.rotor}`);
    }
    return q.y > 3;
  });
  assert.ok(off !== null && off < 8, `off at ${off}`);
  assert.ok(s.engine);
});

test('lifting off with every stick pushed and landing while moving are no bump', () => {
  for (const input of [{ fwd: 1, side: 1, turn: 1 }, { fwd: -1, side: -1, turn: -1 }, { fwd: 1 }]) {
    const s = heliStart();
    fly(s, 12, { ...input, lift: 1 }, flat(), (q) => assert.ok(!(q.ev & EV.BUMP), JSON.stringify(input)));
    fly(s, 12, { ...input, lift: -1 }, flat(), (q) => assert.ok(!(q.ev & EV.BUMP), `down ${JSON.stringify(input)}`));
  }
});

test('hands off, the hover holds within 0.3 m for 20 s, in still air and in a 4.5 m/s wind', () => {
  for (const wind of [[0, 0], [4.5, 0], [-3.2, 3.2]]) {
    const env = flat({ wind });
    const s = hovering(30, env);
    const x0 = s.x, y0 = s.y, z0 = s.z;
    fly(s, 20, {}, env, (q) => {
      assert.ok(Math.hypot(q.x - x0, q.y - y0, q.z - z0) < 0.3, `wind ${wind}: off by ${Math.hypot(q.x - x0, q.y - y0, q.z - z0)}`);
    });
  }
});

test('full up climbs at CLIMB_MAX within 5 %, and never faster; full down sinks at SINK', () => {
  const s = hovering(20);
  let most = 0;
  fly(s, 6, { lift: 1 }, flat(), (q, t) => {
    most = Math.max(most, q.vy);
    if (t > 3) assert.ok(Math.abs(q.vy - HELI.CLIMB_MAX) < 0.05 * HELI.CLIMB_MAX, `climb ${q.vy}`);
  });
  assert.ok(most <= HELI.CLIMB_MAX + 1e-9);
  fly(s, 6, { lift: -1 }, flat(), (q, t) => {
    if (t > 4.5) assert.ok(Math.abs(-q.vy - HELI.SINK) < 0.05 * HELI.SINK, `sink ${q.vy}`);
  });
});

test('full forward reaches the top speed and never passes the cap, even with a tail wind', () => {
  for (const wind of [[0, 0], [0, -4.5]]) {
    const s = hovering(40);
    let most = 0;
    fly(s, 40, { fwd: 1 }, flat({ wind }), (q) => {
      most = Math.max(most, speed(q));
    });
    assert.ok(speed(s) > 0.97 * HELI.V_TOP, `top ${speed(s)}`);
    assert.ok(most <= HELI.V_CAP + 1e-9, `most ${most}`);
  }
});

test('let go at top speed: it stops within 12 s and never rises more than 3 m', () => {
  const s = hovering(40);
  fly(s, 40, { fwd: 1 });
  const y0 = s.y;
  const t = fly(s, 20, {}, flat(), (q) => {
    assert.ok(Math.abs(q.y - y0) < 3, `height ${q.y - y0}`);
    return speed(q) < 0.5;
  });
  assert.ok(t < 12, `stopped after ${t} s`);
  // And it stays: level and still.
  fly(s, 5, {});
  assert.ok(speed(s) < 0.3 && Math.abs(s.pitch) < 0.02 && Math.abs(s.roll) < 0.02);
});

test('a full turn at 30 m/s keeps its height within 2 m and banks', () => {
  const s = hovering(40);
  const fwd = 30 / HELI.V_TOP;
  fly(s, 20, { fwd });
  const y0 = s.y;
  let turned = 0, last = s.yaw, bank = 0;
  const t = fly(s, 60, { fwd, turn: 1 }, flat(), (q) => {
    turned += Math.atan2(Math.sin(q.yaw - last), Math.cos(q.yaw - last));
    last = q.yaw;
    bank = Math.max(bank, q.roll);
    assert.ok(Math.abs(q.y - y0) < 2, `height ${q.y - y0}`);
    return turned <= -2 * Math.PI; // to the right: the heading goes down
  });
  assert.ok(t < 40, `turn took ${t}`);
  assert.ok(bank > 0.3, `bank ${bank}`); // banked to the right
});

test('a descent on full down touches under LAND_SOFT and settles, on the ground and on a 6 by 10 m deck 12.7 m up', () => {
  const deck = { x0: -3, x1: 3, z0: -5, z1: 5, y: 12.7 };
  const onDeck = (x, z, top) => (x > deck.x0 && x < deck.x1 && z > deck.z0 && z < deck.z1 && deck.y <= top ? deck.y : 0);
  for (const ground of [() => 0, onDeck]) {
    const env = flat({ ground });
    const s = hovering(30, env);
    let touch = null;
    fly(s, 40, { lift: -1 }, env, (q) => {
      if (q.ev & (EV.BUMP | EV.BOUNCE)) assert.fail('not soft');
      if (q.ground && touch === null) touch = q.y;
      return q.ground;
    });
    assert.ok(s.ground && s.down === 0);
    assert.ok(Math.abs(s.y - ground(0, 0, 99)) < 0.05, `rests at ${s.y}`);
    // Holding down, the engine stops after STOP_HOLD.
    fly(s, HELI.STOP_HOLD + 0.2, { lift: -1 }, env);
    assert.equal(s.engine, false);
  }
});

test('half on the deck and half off, it does not settle; ground effect helps under one rotor radius only', () => {
  // The left skids over a deck 2 m up, the right ones over the ground: 45 degrees, past SLOPE_MAX.
  const env = flat({ ground: (x, z, top) => (x < 0 && top >= 2 ? 2 : 0) });
  const s = hovering(6, env);
  fly(s, 10, { lift: -1 }, env);
  assert.equal(s.ground, false);
  assert.ok(s.y >= 2 - 1e-6 && s.y < 3);
  // The lever it needs at a hover: less near the floor.
  const lever = (y) => hovering(y).coll;
  assert.ok(lever(1) < lever(4) && lever(4) < lever(8) - 1e-4);
  assert.ok(Math.abs(lever(8) - lever(20)) < 1e-6);
});

test('touchdowns by sink speed: settle, one bounce, a bump that sets it down and stops the engine for DOWN_TIME', () => {
  const drop = (vy) => {
    const s = hovering(0.6);
    Object.assign(s, { vy, holdY: -5 });
    let ev = 0;
    fly(s, 0.5, {}, flat(), (q) => {
      ev |= q.ev;
    });
    return { s, ev };
  };
  assert.ok(drop(-2).ev & EV.SETTLE);
  assert.ok(drop(-4).ev & EV.BOUNCE);
  const hard = drop(-8);
  assert.ok(hard.ev & EV.BUMP);
  assert.equal(hard.s.engine, false);
  assert.ok(hard.s.down > 0);
  fly(hard.s, HELI.DOWN_TIME + 0.1, { lift: 1 });
  assert.equal(hard.s.down, 0);
  fly(hard.s, HELI.START_HOLD + 0.1, { lift: 1 });
  assert.ok(hard.s.engine, 'starts again after the time down');
});

test('a bump in the air sets it down on the floor below within 3 s, level, and nothing breaks', () => {
  const s = hovering(60);
  heliBump(s, 10);
  const t = fly(s, 20, { fwd: 1, lift: 1 }, flat(), (q) => q.ground);
  assert.ok(t < 16, `took ${t}`);
  assert.ok(s.ground && Math.abs(s.pitch) < 0.05 && Math.abs(s.roll) < 0.05 && s.y < 0.05);
  assert.ok(finite(s));
});

test('the ceiling holds: thrust fades under it and it never goes over', () => {
  const s = hovering(100);
  let most = 0;
  fly(s, 30, { lift: 1 }, flat(), (q) => {
    most = Math.max(most, q.y);
  });
  assert.ok(most <= 120 + 1e-9 && most > 110, `most ${most}`);
  assert.ok(s.atCeiling);
});

test('the edge cushion: flying at it flat out, it slows to nothing and stays inside', () => {
  const edge = { x: 0, z: -300, nx: 0, nz: 1 }; // the edge 300 m ahead (the nose faces -z), inward +z
  const s = hovering(40);
  let deepest = Infinity;
  fly(s, 60, { fwd: 1 }, flat({ edge }), (q) => {
    deepest = Math.min(deepest, q.z - edge.z);
  });
  assert.ok(deepest > 0, `went ${deepest} m past`);
  assert.ok(speed(s) < 1);
});

test('a pad pulls a hands-off hover over it to its centre', () => {
  const pad = { x: 2.5, y: 0, z: -1.5 };
  const env = flat({ pad });
  const s = hovering(4, env);
  fly(s, 15, {}, env);
  assert.ok(Math.hypot(s.x - pad.x, s.z - pad.z) < 0.3);
});

test('heliPlace sets it down still; a running rotor keeps the engine on', () => {
  const s = hovering(30);
  heliPlace(s, 10, 5, -3, 1, 1);
  assert.deepEqual([s.x, s.y, s.z, s.yaw, s.vx, s.vy, s.ground, s.engine], [10, 5, -3, 1, 0, 0, true, true]);
});

test('bumped and come to rest on its boom or cabin (held up by the page), the time down runs out and it starts again', () => {
  for (const rest of [2.5, 9]) {
    const s = hovering(rest + 3);
    heliBump(s, 8);
    // The page's walls: the boom or the cabin lies on something at `rest` that the skids don't stand on.
    const hold = () => {
      if (s.y < rest) {
        s.y = rest;
        s.vy = Math.max(0, s.vy);
      }
    };
    let t = 0;
    for (; t < 30 && s.down > 0; t += DT) {
      heliFly(s, {}, flat(), DT);
      hold();
    }
    assert.ok(s.down === 0 && t < HELI.DOWN_TIME + 4, `down ${s.down} after ${t} s resting ${rest} m up`);
    assert.equal(s.ground, false); // not on a floor: the skids hang over the garden
    fly(s, HELI.START_HOLD + 0.2, { lift: 1 }, flat(), hold);
    assert.ok(s.engine, `starts again resting ${rest} m up`);
  }
});

test('the nose goes only where it is turned: sideways flies sideways, a crosswind leans it but never turns it', () => {
  const cases = [
    { input: { side: 1 }, wind: [0, 0], secs: 8 },
    { input: { side: -1 }, wind: [0, 0], secs: 8 },
    { input: { fwd: 1 }, wind: [4.5, 0], secs: 8 }, // the strongest wind world/wind.ts blows, straight across the nose
    { input: { fwd: -1 }, wind: [2, 0], secs: 20 },
  ];
  for (const c of cases) {
    const env = flat({ wind: c.wind });
    const s = hovering(40, env);
    const yaw0 = s.yaw, x0 = s.x;
    fly(s, c.secs, c.input, env);
    assert.ok(Math.abs(s.yaw - yaw0) < 0.01, `${JSON.stringify(c)}: the nose turned ${s.yaw - yaw0} rad`);
    if (c.input.fwd) assert.ok(Math.abs(s.x - x0) < 2, `${JSON.stringify(c)}: blown ${s.x - x0} m off its line`);
    if (c.input.side) assert.ok(Math.abs(Math.hypot(s.vx, s.vz) - HELI.V_SLOW) < 1, `${JSON.stringify(c)}: ${Math.hypot(s.vx, s.vz)} m/s sideways`);
  }
});
