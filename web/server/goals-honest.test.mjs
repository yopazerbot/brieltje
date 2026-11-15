// The routes in the game (server/game.mjs) with its real world, through its own state handler: honest laps with a
// realistic connection (jitter, hiccups up to 800 ms, the bursts after them, standing starts) are never refused, and
// what a review's edited pages tried counts nothing or nothing faster than the rules allow. A fake clock: the server's
// time is the states' arrival times. Run: node --test server/goals-honest.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Game } from './game.mjs';
import { cutPath } from './floors.mjs';
import { makeRoads } from '../shared/roadPath.mjs';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const ROUTES = Object.fromEntries(json('../shared/routes.json').routes.map((r) => [r.id, r]));
const NET = makeRoads(json('../src/data/streets.json').graph);

/** The walking route, kept clear of the server's blocks (tools/dev/boards_ws_check.mjs LAP): 8 m before the gate on. */
const LAP = [[539.47, -769.59], [542, -762], [547, -747], [539.5, -735], [540.5, -739], [532.5, -747.5], [527, -752], [514.5, -769.5], [519.5, -782], [519.5, -781], [521.5, -779.5], [527, -777], [542, -762]];

/** Along the road register from ring to ring (the sat-nav's line), with `detours` for legs that cross a block. */
function roadPath(route, detours = {}) {
  const centres = [route.gate, ...route.checkpoints, route.gate];
  let road = [];
  for (let i = 1; i < centres.length; i++) {
    const line = NET.route(centres[i - 1], centres[i]);
    const pts = Array.isArray(line) ? line : line?.line ?? [centres[i - 1], centres[i]];
    road = road.concat(road.length ? pts.slice(1) : pts);
  }
  for (const [from, way] of Object.entries(detours)) {
    const k = road.findIndex((p) => `${p[0]},${p[1]}` === from);
    if (k >= 0) road.splice(k, 2, ...way);
  }
  return road;
}
/** The bike's road path crosses one block between its last checkpoints: round it (as the page rides it). */
const BIKE_PATH = roadPath(ROUTES.bike, { '520,-706': [[520, -706], [541.5, -706.5], [542, -707], [545, -726]] });
const CAR_PATH = roadPath(ROUTES.car);
/** A point `d` m before the start of `path`, straight back from its first leg. */
const before = (path, d) => {
  const [[ax, az], [bx, bz]] = path;
  const l = Math.hypot(bx - ax, bz - az);
  return [ax - ((bx - ax) / l) * d, az - ((bz - az) / l) * d];
};
/**
 * The tightest line through the rings (server/floors.mjs), 15 cm inside each, with a point before the gate from which
 * the step into it heads for the first checkpoint (as the review's edited pages drove it).
 */
function cutLine(route) {
  const centres = [route.gate, ...route.checkpoints, route.gate];
  const pts = cutPath(route).pts.map(([x, z], i) => {
    const [cx, cz] = centres[i], d = Math.hypot(x - cx, z - cz);
    return [x + ((cx - x) * 0.15) / d, z + ((cz - z) * 0.15) / d];
  });
  const [gx, gz] = route.gate, [fx, fz] = route.checkpoints[0];
  const dl = Math.hypot(fx - gx, fz - gz), u = [(fx - gx) / dl, (fz - gz) / dl];
  const e = [pts[0][0] - gx, pts[0][1] - gz];
  let p = [-u[1], u[0]];
  if (e[0] * p[0] + e[1] * p[1] < 0) p = [-p[0], -p[1]];
  let q = pts[0];
  for (let k = 0.3; k < 30; k += 0.1) {
    q = [pts[0][0] + k * (p[0] * 0.97 - u[0] * 0.24), pts[0][1] + k * (p[1] * 0.97 - u[1] * 0.24)];
    if (Math.hypot(q[0] - gx, q[1] - gz) > route.radius + 0.1) break;
  }
  return [q, ...pts];
}

/** A random number generator with a seed: the same jitter every run of the test. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/**
 * A game, a player in it (`role`, on foot, on a bike or driving), and a page that moves along points at a speed, sending
 * twenty states a second; `net` shapes when each arrives (the server's clock): latency, jitter, hiccups and the burst
 * after them, in order.
 */
function session(by = 'foot', role = 'player', start = LAP[0]) {
  const writes = [];
  const told = [];
  const store = {
    saveRaceTime: async (...a) => (writes.push(['race', ...a]), true), racePlace: async () => 1,
    saveGnome: async () => false, gnomesOf: async () => [], addStats: async () => {}, setMeta: async () => {},
  };
  const game = new Game({ session: () => null, sessions: new Map(), log() {}, addressOf: () => '192.0.2.1', store }, []);
  game.send = (ws, m) => told.push(m);
  game.broadcast = () => {};
  game.stampState = () => {};
  game.bikeHits.strike = () => {};
  const clock = { t: 1_000_000 };
  game.goals.clock = () => clock.t;
  const ground = game.goals.ground;
  const now = Date.now();
  const p = {
    ws: { readyState: 1, OPEN: 1, send() {}, close() {} }, key: 'k', role, alive: true, protectedUntil: 0, drop: null, warp: 0, stamp: 0,
    state: { x: start[0], y: ground(...start), z: start[1], yaw: 0, pitch: 0, armed: false, flying: false, w: 'pistol', c: false },
    weapons: new Set(['pistol']), nades: [0, 0], window: now, msgs: 0, states: 0, others: 0, budget: 0.5, vbudget: 0.5, movedAt: now,
    hp: 100, score: { kills: 0, deaths: 0, points: 0 },
  };
  game.players.set('anna', p);
  game.roles.set('anna', role);
  game.goals.joined('anna', role);
  if (by === 'bike') game.bikes.church1.rider = 'anna';
  if (by === 'car') game.cars.tesla.driver = 'anna';
  const page = { x: start[0], z: start[1], sent: clock.t, arrived: clock.t };
  /** One state, sent at the page's time `page.sent`, arriving `delay` ms later (never before the one before it). */
  const deliver = (x, z, delay, y = 0, extra = {}) => {
    const arrive = Math.max(page.arrived + 0.5, page.sent + delay);
    const gap = arrive - page.arrived;
    page.arrived = arrive;
    clock.t = Math.round(arrive);
    p.movedAt = Date.now() - gap;
    Object.assign(p, { window: Date.now(), msgs: 0, states: 0, others: 0 });
    game.handle('anna', p, JSON.stringify({ t: 'state', x, y: ground(x, z) + y, z, yaw: 0, pitch: 0, armed: false, w: 'pistol', ...extra }));
  };
  const net = { base: 40, jitter: 0, hiccup: 0, rand: Math.random, stall: 0 };
  /** The delay of the next state: base and jitter, and now and then a hiccup that holds this and the next states back. */
  const delay = () => {
    if (net.stall <= page.sent && net.hiccup && net.rand() < net.hiccup) net.stall = page.sent + 100 + net.rand() * 700;
    const held = net.stall > page.sent ? net.stall - page.sent : 0;
    return net.base + net.rand() * net.jitter + held;
  };
  /** Along `points` at `speed` m/s (a number, or a function of the distance done), twenty states a second. */
  const go = (points, speed, { y = 0, extra = {}, hz = 20 } = {}) => {
    let done = 0;
    for (const [x, z] of points) {
      for (;;) {
        const d = Math.hypot(x - page.x, z - page.z);
        const v = typeof speed === 'function' ? speed(done) : speed;
        const s = Math.min(d, v / hz);
        if (d > 1e-9) {
          page.x += ((x - page.x) / d) * s;
          page.z += ((z - page.z) / d) * s;
        }
        done += s;
        page.sent += 1000 / hz;
        deliver(page.x, page.z, delay(), y, extra);
        if (d <= s + 1e-9) break;
      }
    }
  };
  /** Standing still `ms`, a state every 300 ms (src/main.ts: the page's states while nothing changes). */
  const stand = (ms) => {
    for (let t = 0; t < ms; t += 300) {
      page.sent += 300;
      deliver(page.x, page.z, delay());
    }
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const races = () => told.filter((m) => m.t === 'race');
  return { game, p, page, net, go, stand, deliver, flush, races, writes, close: () => game.close() };
}

/** The page's own time along `path` at `speed` (ms): its states, a twentieth of a second each (near enough). */
function pageTime(path, speed) {
  let n = 0;
  for (let i = 1; i < path.length; i++) n += Math.max(1, Math.ceil(Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]) / (speed / 20)));
  return (n * 1000) / 20;
}

const ROUNDS = 20;

for (const [id, by, path, speed, start] of [
  ['foot', 'foot', LAP.slice(1), 3.5, LAP[0]],
  ['bike', 'bike', BIKE_PATH, 6.9, before(BIKE_PATH, 12)],
  ['car', 'car', CAR_PATH, 24, before(CAR_PATH, 40)],
]) {
  test(`${id}: ${ROUNDS} honest laps with jitter, hiccups up to 800 ms, their bursts and standing starts all count`, async () => {
    const s = session(by, 'player', start);
    try {
      const floor = s.game.goals.floor[id];
      const ideal = pageTime(path, speed);
      for (let k = 0; k < ROUNDS; k++) {
        Object.assign(s.net, { rand: rng(k + 1), base: 20 + (k % 5) * 30, jitter: 20 + (k % 4) * 60, hiccup: [0, 0.01, 0.03, 0.06][k % 4] });
        // Back to the start (outside the gate, by the way the run asks), a moment standing there on every other lap.
        s.game.goals.players.get('anna').run = null;
        s.p.state.x = start[0];
        s.p.state.z = start[1];
        Object.assign(s.page, { x: start[0], z: start[1] });
        s.game.goals.players.get('anna').seen = false; // a hop: the next state is no step
        s.deliver(start[0], start[1], s.net.base);
        if (k % 2) s.stand(900);
        const before = s.races().length;
        s.go(path, speed);
        s.stand(600); // and a moment after the finish, as the page sends
        await s.flush();
        const got = s.races().slice(before);
        assert.equal(got.length, 1, `lap ${k}: ${JSON.stringify(got)}`);
        // The server's time: the page's own to within the lag's play (the start's state can arrive late or early).
        assert.ok(got[0].ms >= floor, `lap ${k}: ${got[0].ms} under the floor ${floor}`);
        assert.ok(Math.abs(got[0].ms - ideal) < 1600, `lap ${k}: server ${got[0].ms} ms, page about ${Math.round(ideal)} ms`);
      }
    } finally {
      s.close();
    }
  });
}

test('the review\'s edited pages on foot: at the budget, the tightest line, its walls, twice real time, up in the air, the admin: no time', async () => {
  const cut = cutLine(ROUTES.foot);
  const tries = [
    ['the honest line at the budget (4.53 m/s)', LAP, 4.53, 'player', 0],
    ['the tightest line at a run (3.5 m/s): 3.75 m of it through blocks', cut, 3.5, 'player', 0],
    ['the tightest line at the budget (4.53 m/s)', cut, 4.53, 'player', 0],
    ['the honest line replayed at twice real time (7 m/s)', LAP, 7, 'player', 0],
    ['the tightest line, 2.9 m up without the flag, at 4.53 m/s', cut, 4.53, 'player', 2.9],
    ['the admin on the tightest line at 4.53 m/s', cut, 4.53, 'admin', 0],
  ];
  for (const [what, path, speed, role, y] of tries) {
    const s = session('foot', role, path[0]);
    try {
      s.deliver(path[0][0], path[0][1], 40);
      s.go(path.slice(1), speed, { y });
      s.stand(3000);
      await s.flush();
      assert.deepEqual(s.races(), [], what);
    } finally {
      s.close();
    }
  }
});

test('the review\'s edited pages by bike and by car: the tightest line through the houses, at any speed: no time', async () => {
  for (const [id, speeds] of [['bike', [12.9, 11.25, 10, 6.94]], ['car', [66.4, 60.66, 55.6]]]) {
    const cut = cutLine(ROUTES[id]);
    for (const speed of speeds) {
      const s = session(id, 'player', cut[0]);
      try {
        s.deliver(cut[0][0], cut[0][1], 40);
        s.go(cut.slice(1), speed);
        s.stand(3000);
        await s.flush();
        assert.deepEqual(s.races(), [], `${id} at ${speed} m/s`);
      } finally {
        s.close();
      }
    }
  }
});

test('the review\'s hold and burst at the ring: the run starts, and gains no more than the budget\'s stored half second', async () => {
  const gate = LAP[1];
  const u = [LAP[0][0] - gate[0], LAP[0][1] - gate[1]];
  const ul = Math.hypot(u[0], u[1]);
  const edge = [gate[0] + (u[0] / ul) * 3.15, gate[1] + (u[1] / ul) * 3.15]; // 15 cm outside the ring, on the way in
  const lap = (atEdge) => {
    const s = session('foot', 'player', LAP[0]);
    s.deliver(LAP[0][0], LAP[0][1], 40);
    s.go([edge], 3.5);
    atEdge(s);
    s.go(LAP.slice(1), 3.5);
    s.stand(1500);
    return s;
  };
  const ref = lap(() => {});
  const hiccup = lap((s) => (s.page.sent += 260));
  const stand = lap((s) => s.stand(500));
  const burst = lap((s) => {
    s.page.sent += 1200; // hold 1.2 s, one still state, then three states of 0.9 m in 15 ms
    s.deliver(s.page.x, s.page.z, 40);
    for (let i = 0; i < 3; i++) {
      s.page.x -= (u[0] / ul) * 0.9;
      s.page.z -= (u[1] / ul) * 0.9;
      s.page.sent += 5;
      s.deliver(s.page.x, s.page.z, 40);
    }
  });
  await ref.flush();
  try {
    const [r, h, st, b] = [ref, hiccup, stand, burst].map((s) => s.races()[0]?.ms);
    assert.ok(r && h && st && b, JSON.stringify({ r, h, st, b }));
    assert.ok(Math.abs(h - r) < 300 && Math.abs(st - r) < 300, JSON.stringify({ r, h, st }));
    // The burst covers the stored budget's metres (2.775 m on foot) in no time: at most that much running, 0.8 s.
    assert.ok(r - b <= 800, `${r} against ${b}`);
  } finally {
    for (const s of [ref, hiccup, stand, burst]) s.close();
  }
});

test('the tracker\'s cost per state with a run on, through the game\'s whole state handler and without it', () => {
  const s = session('foot', 'player', LAP[0]);
  try {
    s.deliver(LAP[0][0], LAP[0][1], 40);
    s.go([LAP[1]], 3.5);
    const t = s.game.goals;
    const q = t.players.get('anna');
    assert.ok(q.run, 'a run is on');
    // The tracker alone, a run on: steps along the first leg back and forth (2400 states: under the two minutes' limit).
    const prev = { ...s.p.state }, next = { ...s.p.state };
    const [ax, az] = LAP[1], [bx, bz] = LAP[2];
    const n = 2000;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const tri = (i % 200) / 100;
      const f = 0.1 + 0.6 * (tri <= 1 ? tri : 2 - tri); // out along the leg and back, 9.5 cm a state
      Object.assign(prev, next);
      next.x = ax + (bx - ax) * f;
      next.z = az + (bz - az) * f;
      q.x = prev.x;
      q.z = prev.z;
      t.moved('anna', prev, next, 'foot', { gapMs: 50, seek: true });
      if (!q.run) assert.fail(`stopped at ${i}: ${JSON.stringify({ prev, next, f, ground: t.ground(next.x, next.z), clear: t.clear(prev, next, Math.hypot(next.x - prev.x, next.z - prev.z)) })}`);
    }
    const us = ((performance.now() - t0) * 1000) / n;
    console.log(`     moved() with a run on: ${us.toFixed(2)} µs a state (wall check and the run's step)`);
    assert.ok(q.run, 'still on');
    assert.ok(us < 50, `${us} µs`);
  } finally {
    s.close();
  }
});
