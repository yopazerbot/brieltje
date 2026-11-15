// Tests for the gnomes and the timed routes (shared/goals.mjs, shared/gnomes.json, shared/routes.json): where the data
// stands, what is read back from storage, and a run along a route.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBounds } from './bounds.mjs';
import { homeAt, inEndGarden } from './homes.mjs';
import { PORTALS } from './portals.mjs';
import { noShoot } from './zones.mjs';
import { DONE_MS, dropRace, finishRace, formatTime, newRace, OFFER_AWAY, OFFER_MS, passes, pointsOf, readBest, readFound, startable, stepRace, stepRun, TIMEOUT_MS, writeBest, writeFound } from './goals.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const GNOMES = read('./gnomes.json');
const { routes: ROUTES } = read('./routes.json');
const map = loadBounds(read('./bounds.json')).map;
const ids = GNOMES.gnomes.map((g) => g.id);

/** Every spot of the data: the gnomes, the golden one, each gate and checkpoint. */
const spots = [
  ...GNOMES.gnomes.map((g) => ({ name: g.id, x: g.x, z: g.z, gnome: true })),
  { name: 'golden', x: GNOMES.golden.x, z: GNOMES.golden.z, gnome: true },
  ...ROUTES.flatMap((r) => pointsOf(r).map(([x, z], i) => ({ name: `${r.id}#${i}`, x, z, gnome: false }))),
];

test('30 gnomes, g01 to g30, each once, with a reach of 1.5 m', () => {
  assert.equal(GNOMES.reach, 1.5);
  assert.deepEqual(ids, Array.from({ length: 30 }, (_, i) => `g${String(i + 1).padStart(2, '0')}`));
  assert.equal(new Set(ids).size, 30);
  for (const g of GNOMES.gnomes) {
    assert.equal(typeof g.village, 'boolean', g.id);
    assert.ok(g.y === undefined || Number.isFinite(g.y), g.id);
  }
});

test('every gnome, the golden one, every gate and checkpoint is at least 5 m inside the map', () => {
  for (const s of spots) assert.ok(map.depth(s.x, s.z) >= 5, `${s.name} is ${map.depth(s.x, s.z).toFixed(1)} m inside`);
});

test('none in a home at any height, nor in the end house garden', () => {
  for (const s of spots) {
    for (let y = -6; y <= 30; y += 0.25) {
      assert.equal(homeAt(s.x, s.z, y), null, `${s.name} in a home at ${y}`);
      assert.equal(inEndGarden(s.x, s.z, y), false, `${s.name} in the end garden at ${y}`);
    }
  }
});

test('gnomes stand at least 15 m apart', () => {
  const g = spots.filter((s) => s.gnome && s.name !== 'golden');
  for (let i = 0; i < g.length; i++) {
    for (let j = i + 1; j < g.length; j++) assert.ok(Math.hypot(g[i].x - g[j].x, g[i].z - g[j].z) >= 15, `${g[i].name} and ${g[j].name}`);
  }
});

test('none within 4 m of a portal', () => {
  for (const s of spots) for (const p of PORTALS) assert.ok(Math.hypot(s.x - p.x, s.z - p.z) >= 4, `${s.name} at portal ${p.id}`);
});

test('no route point on the school grounds', () => {
  for (const s of spots) if (!s.gnome) assert.equal(noShoot(s.x, s.z), null, s.name);
});

test('routes: three, by foot, bike and car, each leg from 8 to 260 m', () => {
  assert.deepEqual(ROUTES.map((r) => r.by).sort(), ['bike', 'car', 'foot']);
  assert.equal(new Set(ROUTES.map((r) => r.id)).size, ROUTES.length);
  for (const r of ROUTES) {
    assert.ok(Number.isInteger(r.rev) && r.rev >= 1, r.id);
    assert.match(r.colour, /^#[0-9a-f]{6}$/i);
    const pts = [r.gate, ...pointsOf(r)];
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      assert.ok(d >= 8 && d <= 260, `${r.id} leg ${i}: ${d.toFixed(1)} m`);
    }
  }
});

test('readFound keeps known ids only, once each, and nothing from junk', () => {
  assert.deepEqual(readFound(writeFound(['g01', 'g07'], true), ids), { found: ['g01', 'g07'], told: true });
  for (const junk of [null, undefined, '', 'x', '[]', '{}', '{"v":2,"found":["g01"]}', '{"v":1,"found":"x"}', '{"found":"x"}', '{"v":1,"found":{"0":"g01"}}', 'null', '42']) {
    assert.deepEqual(readFound(junk, ids), { found: [], told: false }, String(junk));
  }
  assert.deepEqual(readFound('{"v":1,"found":["g01","g01","zz","__proto__",5,null,{"id":"g02"}],"told":"yes"}', ids), { found: ['g01'], told: false });
  const many = JSON.stringify({ v: 1, found: Array.from({ length: 10000 }, (_, i) => (i % 2 ? 'g03' : 'nope')), told: true });
  assert.deepEqual(readFound(many, ids), { found: ['g03'], told: true });
  const proto = readFound('{"v":1,"__proto__":{"found":["g01"]},"found":[]}', ids);
  assert.deepEqual(proto.found, []);
  assert.equal(({}).found, undefined);
});

test('readBest keeps known keys with times from 3 s to an hour', () => {
  const keys = ['foot@1', 'bike@1', 'car@1'];
  assert.deepEqual(readBest(writeBest({ 'foot@1': 23400.4, 'bike@1': 1000 }), keys), { 'foot@1': 23400 });
  for (const junk of [null, '', '{', '{"v":1}', '{"v":1,"best":[]}', '{"v":1,"best":"x"}', '{"best":{"foot@1":5000}}']) {
    assert.deepEqual(readBest(junk, keys), {}, String(junk));
  }
  const bad = '{"v":1,"best":{"foot@1":"5000","bike@1":-5000,"car@1":1e12,"foot@0":5000,"__proto__":{"car@1":5000}}}';
  assert.deepEqual(readBest(bad, keys), {});
  assert.deepEqual(readBest('{"v":1,"best":{"foot@1":NaN}}', keys), {});
  assert.deepEqual(readBest(JSON.stringify({ v: 1, best: { 'car@1': 3600000, 'bike@1': 3000 } }), keys), { 'car@1': 3600000, 'bike@1': 3000 });
  const out = JSON.parse(writeBest({ 'foot@1': NaN, 'bike@1': -1, 'car@1': 61234 }));
  assert.deepEqual(out, { v: 1, best: { 'car@1': 61234 } });
});

test('passes: a step comes within r of a point', () => {
  assert.equal(passes(0, 0, 10, 0, 5, 1, 2), true);
  assert.equal(passes(0, 0, 10, 0, 5, 3, 2), false);
  assert.equal(passes(0, 0, 10, 0, 12, 0, 1.5), false);
  assert.equal(passes(0, 0, 10, 0, 11, 0, 1.5), true);
  assert.equal(passes(3, 3, 3, 3, 3, 4, 1.5), true); // no step: the point itself
});

const ROUTE = { id: 'r', rev: 1, by: 'foot', radius: 2, colour: '#ffffff', gate: [0, 0], checkpoints: [[20, 0], [20, 20], [0, 20]] };
/** Walks from point to point in steps of `len` m, `ms` ms each, and lists the events. */
function walk(path, by = 'foot', len = 1, ms = 200, start = 1000) {
  let run = null, now = start, at = { x: path[0][0], z: path[0][1] };
  const events = [];
  for (const [tx, tz] of path.slice(1)) {
    for (;;) {
      const d = Math.hypot(tx - at.x, tz - at.z);
      const s = Math.min(len, d);
      const to = d > 0 ? { x: at.x + ((tx - at.x) / d) * s, z: at.z + ((tz - at.z) / d) * s } : { ...at };
      now += ms;
      const r = stepRun(run, ROUTE, at, to, by, now);
      run = r.run;
      if (r.event) events.push(r.event === 'finish' ? `finish ${r.time}` : r.event);
      at = to;
      if (s === d) break;
    }
  }
  return { events, run };
}

test('stepRun: through the gate the right way starts, the points count in order, the gate again finishes', () => {
  const lap = walk([[-5, 0], [20, 0], [20, 20], [0, 20], [0, 0], [0, -1]]);
  assert.deepEqual(lap.events.filter((e) => !e.startsWith('finish')), ['start', 'checkpoint', 'checkpoint', 'checkpoint']);
  const finish = lap.events.find((e) => e.startsWith('finish'));
  assert.ok(finish, 'finished');
  // From the start (the step into the gate, at x -1) to the finish (the step into it again, at z 1): 80 steps of 200 ms.
  const ms = Number(finish.split(' ')[1]);
  assert.equal(ms, 80 * 200);
  assert.equal(lap.run, null);
});

test('stepRun: another way of moving does not start; the wrong way does not start', () => {
  assert.deepEqual(walk([[-5, 0], [20, 0]], 'bike').events, []);
  assert.deepEqual(walk([[5, 0], [-5, 0]]).events, []);
});

test('stepRun: a skipped point does not count, the order is kept', () => {
  // Start, then straight to the third point: nothing; the gate is not the finish yet either.
  const { events } = walk([[-5, 0], [3, 0], [0, 20], [0, 0], [0, -3]]);
  assert.deepEqual(events, ['start']);
});

test('stepRun: a long step, a change of vehicle or two minutes without a point stop the run', () => {
  const r0 = stepRun(null, ROUTE, { x: -3, z: 0 }, { x: -1, z: 0 }, 'foot', 0);
  assert.equal(r0.event, 'start');
  assert.equal(stepRun(r0.run, ROUTE, { x: -1, z: 0 }, { x: 10, z: 0 }, 'foot', 100).event, 'stop');
  assert.equal(stepRun(r0.run, ROUTE, { x: -1, z: 0 }, { x: 0, z: 0 }, 'bike', 100).event, 'stop');
  assert.equal(stepRun(r0.run, ROUTE, { x: -1, z: 0 }, { x: -1, z: 0 }, null, 100).event, 'stop');
  assert.equal(stepRun(r0.run, ROUTE, { x: -1, z: 0 }, { x: -1, z: 0 }, 'foot', TIMEOUT_MS).event, null);
  assert.equal(stepRun(r0.run, ROUTE, { x: -1, z: 0 }, { x: -1, z: 0 }, 'foot', TIMEOUT_MS + 1).event, 'stop');
  // A hop across the gate (a trip, a respawn, a teleport) starts nothing, the right way or not.
  assert.equal(stepRun(null, ROUTE, { x: -20, z: 0 }, { x: 20, z: 0 }, 'foot', 0).event, null);
  assert.equal(stepRun(null, ROUTE, { x: -5.5, z: 0 }, { x: 0, z: 0 }, 'foot', 0).event, null);
  assert.equal(stepRun(null, ROUTE, { x: -4.5, z: 0 }, { x: 0, z: 0 }, 'foot', 0).event, 'start');
  assert.equal(stepRun(null, { ...ROUTE, by: 'car', radius: 8 }, { x: -25, z: 0 }, { x: -7, z: 0 }, 'car', 0).event, 'start');
  assert.equal(stepRun(null, { ...ROUTE, by: 'car', radius: 8 }, { x: -30, z: 0 }, { x: -7, z: 0 }, 'car', 0).event, null);
  // Standing in the gate after a finish does not start again: it starts only coming in from outside.
  assert.equal(stepRun(null, ROUTE, { x: 0, z: 0.5 }, { x: 1, z: 0 }, 'foot', 0).event, null);
});

test('formatTime: m:ss.d, a comma in Dutch', () => {
  assert.equal(formatTime(23400), '0:23.4');
  assert.equal(formatTime(67449, true), '1:07,4');
  assert.equal(formatTime(0), '0:00.0');
  assert.equal(formatTime(3600000), '60:00.0');
  assert.equal(formatTime(NaN), '0:00.0');
});

// A race asked for: the rings show only once the race key is pressed (src/world/goals.ts draws what `armed` says).
const CAR = ROUTES.find((r) => r.by === 'car');
const FOOT = ROUTES.find((r) => r.by === 'foot');
/** Frames of stepRace in a row: each [me, pressed, ms, shownMs]; returns the race after them and the events. */
function frames(steps, race = newRace()) {
  const events = [];
  for (const [me, pressed = false, ms = 0, shown = 16] of steps) {
    const r = stepRace(race, ROUTES, me, pressed, ms, shown);
    race = r.race;
    if (r.event) events.push(r.why ? `${r.event}:${r.why}` : r.event);
  }
  return { race, events };
}

test('a race: nothing armed until the key, an offer on getting in, armed by the key in the car', () => {
  const at = { x: 0, z: 0 };
  let { race, events } = frames([[{ ...at, by: 'foot' }], [{ ...at, by: 'car' }]]);
  assert.equal(race.armed, null, 'nothing armed, so nothing is shown');
  assert.equal(race.offer, CAR.id, 'getting in offers the car route');
  assert.deepEqual(events, []);
  ({ race, events } = frames([[{ ...at, by: 'car' }, true, 100]], race));
  assert.equal(race.armed, CAR.id);
  assert.equal(race.offer, null);
  assert.deepEqual(events, ['armed']);
  // A passenger is offered nothing, and the key does nothing for one.
  ({ race, events } = frames([[{ ...at, by: null }], [{ ...at, by: null }, true]]));
  assert.equal(race.offer, null);
  assert.equal(race.armed, null);
  assert.deepEqual(events, []);
});

test('a race: the offer counts down only while on screen, and goes on getting out', () => {
  const at = { x: 0, z: 0 };
  let { race } = frames([[{ ...at, by: 'car' }, false, 0, 0], [{ ...at, by: 'car' }, false, 5000, 0]]);
  assert.equal(race.offer, CAR.id, 'not shown yet (the car keys show first): still offered');
  ({ race } = frames([[{ ...at, by: 'car' }, false, 6000, OFFER_MS - 1]], race));
  assert.equal(race.offer, CAR.id);
  ({ race } = frames([[{ ...at, by: 'car' }, false, 6100, 2]], race));
  assert.equal(race.offer, null, 'shown long enough');
  // The key still starts it in the car, without an offer on screen.
  ({ race } = frames([[{ ...at, by: 'car' }, true, 7000]], race));
  assert.equal(race.armed, CAR.id);
  ({ race } = frames([[{ ...at, by: 'foot' }], [{ ...at, by: 'car' }]]));
  ({ race } = frames([[{ ...at, by: 'foot' }]], race));
  assert.equal(race.offer, null, 'out of the car: no car offer');
});

test('a race: started at the gate only once armed, and only the armed route', () => {
  const [gx, gz] = CAR.gate, [fx, fz] = CAR.checkpoints[0];
  const len = Math.hypot(fx - gx, fz - gz), ux = (fx - gx) / len, uz = (fz - gz) / len;
  const before = { x: gx - ux * 10, z: gz - uz * 10 }, past = { x: gx + ux * 2, z: gz + uz * 2 };
  // Through the gate the right way: stepRun starts a run; goals.ts asks it only for the armed route.
  assert.equal(stepRun(null, CAR, before, past, 'car', 0).event, 'start');
  assert.equal(startable(newRace(), ROUTES, 'car'), CAR);
  assert.equal(startable(newRace(), ROUTES, 'foot'), null, 'on foot only on a visit to the walking start');
  assert.equal(startable(newRace(), ROUTES, null), null);
});

test('a race: the key again stops it, before or during the run', () => {
  const at = { x: 0, z: 0 };
  const { race, events } = frames([[{ ...at, by: 'bike' }], [{ ...at, by: 'bike' }, true, 10], [{ ...at, by: 'bike' }, true, 20]]);
  assert.equal(race.armed, null);
  assert.deepEqual(events, ['armed', 'stopped:key']);
  assert.equal(race.offer, null, 'no new offer after you stopped it yourself');
});

test('a race: getting out, getting down or a hop stops it', () => {
  const at = { x: 0, z: 0 };
  let { race, events } = frames([[{ ...at, by: 'car' }, true], [{ ...at, by: 'foot' }]]);
  assert.equal(race.armed, null);
  assert.deepEqual(events, ['armed', 'stopped:left']);
  ({ race, events } = frames([[{ ...at, by: 'bike' }, true], [{ ...at, by: null }]]));
  assert.deepEqual(events, ['armed', 'stopped:left'], 'down, or as a passenger');
  ({ race, events } = frames([[{ ...at, by: 'car' }, true], [{ x: 300, z: 0, by: 'car' }]]));
  assert.deepEqual(events, ['armed', 'stopped:left'], 'a trip through a portal');
  ({ race, events } = frames([[{ ...at, by: 'car' }, true], [{ x: 15, z: 0, by: 'car' }]]));
  assert.equal(race.armed, CAR.id, 'driving on at speed is no hop');
  assert.equal(dropRace(race).armed, null, 'a run stopped on its own ends the race');
});

test('a race: after a finish the gate stays a while, then it ends and the route is offered again', () => {
  const at = { x: 0, z: 0, by: 'car' };
  const { race } = frames([[at, true, 0]]);
  const done = finishRace(race, 1000);
  let r = frames([[at, false, 1000 + DONE_MS - 1]], done);
  assert.equal(r.race.armed, CAR.id, 'still shown with the result');
  r = frames([[at, false, 1000 + DONE_MS]], r.race);
  assert.equal(r.race.armed, null);
  assert.deepEqual(r.events, ['ended']);
  assert.equal(r.race.offer, CAR.id, 'the key starts another go');
  // During the result, the key starts a new go at once.
  r = frames([[at, true, 1500]], done);
  assert.equal(r.race.armed, CAR.id);
  assert.equal(r.race.done, 0);
  assert.deepEqual(r.events, ['armed']);
});

test('a race: the walking route offered on foot by its start, once a visit', () => {
  const [gx, gz] = FOOT.gate;
  const near = { x: gx + 10, z: gz, by: 'foot' }, far = { x: gx + OFFER_AWAY + 5, z: gz, by: 'foot' };
  const walk = (from, to, n) => Array.from({ length: n + 1 }, (_, i) => [{ x: from.x + ((to.x - from.x) * i) / n, z: from.z + ((to.z - from.z) * i) / n, by: 'foot' }]);
  let { race } = frames([[far], ...walk(far, near, 40)]);
  assert.equal(race.offer, FOOT.id);
  assert.ok(race.visit);
  ({ race } = frames([[near, false, 0, OFFER_MS]], race));
  assert.equal(race.offer, null, 'shown long enough');
  ({ race } = frames([...walk(near, { x: gx + 30, z: gz }, 20), ...walk({ x: gx + 30, z: gz }, near, 20)], race));
  assert.equal(race.offer, null, 'not again on the same visit (never 40 m away)');
  ({ race } = frames([...walk(near, far, 40), ...walk(far, near, 40)], race));
  assert.equal(race.offer, FOOT.id, 'again after going 40 m away');
  // The key starts it there; in a car next to it, the car's offer is for the car.
  assert.equal(frames([[near, true]], race).race.armed, FOOT.id);
  const inCar = frames([[{ ...near, by: 'car' }]], race).race;
  assert.equal(inCar.offer, CAR.id);
  assert.equal(frames([[{ ...near, by: 'car' }, true]], inCar).race.armed, CAR.id);
  // Far from the start on foot the key does nothing.
  assert.equal(frames([[far, true]]).race.armed, null);
});
