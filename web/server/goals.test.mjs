// The server's own timing of the routes and noting of the gnomes (server/goals.mjs), on a fake clock and a fake store:
// every rule a page could try to get round. Run: node --test server/goals.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ABOVE_MAX, GoalTracker, loadGoals, readGoals, shortest, START_GAP_MS, TONIGHT_MAX } from './goals.mjs';
import { TIMEOUT_MS } from '../shared/goals.mjs';
import { Game } from './game.mjs';

const RUN_SPEED = 1.4 * 2.5 * 1.3; // server/game.mjs
const PACE = { foot: RUN_SPEED, bike: 13, car: 66.72 };
const TOP = { foot: RUN_SPEED / 1.3, bike: 10, car: 55.6 };
/** A square on foot: the gate at the origin, three corners, 120 m round; radius 2. */
const SQUARE = { id: 'sq', rev: 1, by: 'foot', radius: 2, gate: [0, 0], checkpoints: [[30, 0], [30, 30], [0, 30]] };
const CARRT = { id: 'cr', rev: 2, by: 'car', radius: 8, gate: [500, 0], checkpoints: [[800, 0], [800, 300], [500, 300]] };
const GNOMES = [
  { id: 'g1', x: 15, z: -6, y: null },
  { id: 'roof', x: 15, z: 36, y: 6 },
];
/** A wall across the third leg (from (30, 30) back to (0, 30)), at x 14 to 16, only where `wall.on`. */
const wall = { on: false };
const lineFree = (cx, cz, yaw, halfL) => {
  if (!wall.on) return true;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const ax = cx - fx * halfL, bx = cx + fx * halfL, az = cz - fz * halfL, bz = cz + fz * halfL;
  return !(Math.min(ax, bx) <= 16 && Math.max(ax, bx) >= 14 && Math.max(az, bz) > 25);
};

function setup({ role = 'player', store: extra = {} } = {}) {
  const writes = [];
  const told = [];
  let changed = 0;
  const clock = { t: 10_000 };
  const store = {
    best: new Map(),
    async saveRaceTime(name, key, ms) {
      writes.push(['race', name, key, ms]);
      const old = this.best.get(`${name}|${key}`);
      if (old !== undefined && old <= ms) return false;
      this.best.set(`${name}|${key}`, ms);
      return true;
    },
    async racePlace() {
      return 1;
    },
    found: new Set(),
    async saveGnome(name, id) {
      writes.push(['gnome', name, id]);
      if (this.found.has(`${name}|${id}`)) return false;
      this.found.add(`${name}|${id}`);
      return true;
    },
    async gnomesOf() {
      return [];
    },
    ...extra,
  };
  const g = new GoalTracker({
    routes: [SQUARE, CARRT], gnomes: GNOMES, reach: 1.5, ground: () => 0, lineFree, pace: PACE, top: TOP, store, clock: () => clock.t,
    tell: (name, m) => told.push({ name, ...m }), changed: () => changed++, onBoard: (r) => r === 'player' || r === 'admin',
  });
  const me = { x: -6, y: 0, z: 0 };
  /** One state `ms` after the last, to (x, z) at height y: what the game passes on. */
  const step = (x, z, { by = 'foot', ms = 50, y = 0, cut = false, seek = true, name = 'anna' } = {}) => {
    const prev = { ...me };
    me.x = x;
    me.z = z;
    me.y = y;
    clock.t += ms;
    g.moved(name, prev, { ...me }, by, { gapMs: ms, cut, seek });
  };
  /** Straight to (x, z) at `speed` m/s, twenty states a second. */
  const go = (x, z, speed = 4, opts = {}) => {
    for (;;) {
      const d = Math.hypot(x - me.x, z - me.z);
      const s = Math.min(d, speed / 20);
      step(me.x + ((x - me.x) / (d || 1)) * s, me.z + ((z - me.z) / (d || 1)) * s, opts);
      if (d <= s + 1e-9) return;
    }
  };
  /** The square round from just before the gate: start, three corners, the gate again. */
  const lap = (speed = 4, opts = {}) => {
    go(-0.5, 0, speed, opts);
    go(30, 0, speed, opts);
    go(30, 30, speed, opts);
    go(0, 30, speed, opts);
    go(0, 0, speed, opts);
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { g, store, writes, told, clock, me, step, go, lap, flush, changes: () => changed, joined: () => g.joined('anna', role) };
}

const races = (writes) => writes.filter((w) => w[0] === 'race');

test('the game data loads whole and checked: routes, gnomes, the shortest times', () => {
  const { routes, gnomes, reach } = readGoals();
  const raw = JSON.parse(readFileSync(new URL('../shared/routes.json', import.meta.url), 'utf8'));
  assert.equal(routes.length, raw.routes.length);
  assert.equal(gnomes.length, 30);
  assert.equal(reach, 1.5);
  // The shortest times as the plan worked them out from today's layouts (on foot 3.5 m/s, a bike 10, a car 55.6).
  const secs = Object.fromEntries(routes.map((r) => [r.id, +(shortest(r) / TOP[r.by]).toFixed(1)]));
  assert.deepEqual(secs, { foot: 21.2, bike: 46.9, car: 21.5 });
  // Bad entries are left out, never trusted.
  const bad = loadGoals(
    { routes: [{ ...SQUARE, id: 'Bad Id' }, { ...SQUARE, by: 'horse' }, { ...SQUARE, radius: NaN }, { ...SQUARE, checkpoints: [] }, SQUARE, SQUARE] },
    { gnomes: [{ id: '__proto__', x: 1, z: 1 }, { id: 'ok', x: 1, z: Infinity }, { id: 'g', x: 1, z: 2, y: '3' }, { id: 'g2', x: 1, z: 2 }], reach: 99 },
  );
  assert.deepEqual(bad.routes.map((r) => r.id), ['sq']);
  assert.deepEqual(bad.gnomes.map((g) => g.id), ['g2']);
  assert.equal(bad.reach, 1.5);
});

test('a clean run is stored with the server\'s time, and told to that player alone', async () => {
  const s = setup();
  await s.joined();
  s.step(-5.9, 0); // the first state after joining is no step
  s.lap(4);
  await s.flush();
  const w = races(s.writes);
  assert.equal(w.length, 1);
  assert.equal(w[0][2], 'sq@1');
  // Into the gate's circle (2 m before it) and round to its circle again (2 m after the last corner): 120 m at 4 m/s,
  // on the server's clock from the one state to the other.
  assert.ok(Math.abs(w[0][3] - 30_000) < 100, String(w[0][3]));
  assert.deepEqual(s.told.map(({ name, t, id, best, place, tonight }) => ({ name, t, id, best, place, tonight })), [{ name: 'anna', t: 'race', id: 'sq', best: true, place: 1, tonight: false }]);
  assert.equal(s.changes(), 1);
  // A slower lap after it is written but no better: nothing changes on the board.
  s.go(-6, 0);
  s.lap(3.9);
  await s.flush();
  assert.equal(races(s.writes).length, 2);
  assert.equal(s.told.at(-1).best, false);
  assert.equal(s.told.at(-1).place, null);
  assert.equal(s.changes(), 1);
});

test('a skipped checkpoint, one out of order, the wrong way through the gate: no time', async () => {
  const ways = {
    // Skipped: straight from the first corner to the last, then the gate.
    skipped: [[-0.5, 0], [30, 0], [0, 30], [0, 0], [-6, 0]],
    // Out of order: the third corner before the second.
    order: [[-0.5, 0], [30, 0], [0, 30], [30, 30], [0, 0], [-6, 0]],
    // The wrong way: into the gate from the far side, round the other way.
    wrong: [[6, 0], [0, 0], [-6, 0], [0, 30], [30, 30], [30, 0], [0, 0], [-6, 0]],
  };
  for (const [why, path] of Object.entries(ways)) {
    const s = setup();
    await s.joined();
    s.step(-5.9, 0);
    for (const [x, z] of path) s.go(x, z);
    await s.flush();
    assert.deepEqual(races(s.writes), [], why);
  }
});

test('a step longer than the budget stops the run; a finish under the shortest time is refused', async () => {
  const s = setup();
  await s.joined();
  s.step(-5.9, 0);
  s.go(-0.5, 0); s.go(20, 0);
  s.step(26, 0); // 6 m in 50 ms: past the foot budget
  s.go(30, 0); s.go(30, 30); s.go(0, 30); s.go(0, 0);
  await s.flush();
  assert.deepEqual(races(s.writes), [], 'the long step stopped it');
  // Steps within the budget each, but sped up: the budget is spent and refilled at the normal pace only.
  s.go(-6, 0);
  s.lap(9);
  await s.flush();
  assert.deepEqual(races(s.writes), [], 'twice the pace: stopped');
  // Within the budget (it has room for jitter over the real pace) but faster than anyone runs the route's shortest line:
  // 4.5 m/s takes 26.7 s, the floor is (120 m - 16 m) / 3.5 m/s = 29.7 s.
  const quick = setup();
  await quick.joined();
  quick.step(-5.9, 0);
  quick.lap(4.5);
  await quick.flush();
  assert.deepEqual(races(quick.writes), [], 'under the floor');
  assert.equal(quick.g.floor.sq, Math.ceil(((120 - 16) / TOP.foot) * 1000));
});

test('the way of moving: started on foot and finished by car, a passenger (no way), a horse: no time', async () => {
  const s = setup();
  await s.joined();
  s.step(-5.9, 0);
  s.go(-0.5, 0); s.go(30, 0); s.go(30, 30);
  s.go(0, 30, 10, { by: 'car' }); s.go(0, 0, 10, { by: 'car' });
  s.go(-6, 0, 4, { by: null }); s.lap(4, { by: null });
  await s.flush();
  assert.deepEqual(races(s.writes), []);
});

test('a hop mid-run stops it; a hop across the gate starts nothing', async () => {
  const s = setup();
  await s.joined();
  s.step(-5.9, 0);
  s.go(-0.5, 0); s.go(30, 0);
  // Something else moved them (a portal, chat travel, a respawn): the next state starts where the server put them.
  s.me.x = 30; s.me.z = 29; // the server's own move: prev is no longer where the tracker saw them
  s.go(30, 30); s.go(0, 30); s.go(0, 0);
  await s.flush();
  assert.deepEqual(races(s.writes), [], 'the hop stopped it');
  // Put down just outside the gate and stepping through: the first step after a hop counts nothing.
  s.go(-6, 0);
  s.me.x = -0.9; // a respawn just before the gate
  s.step(0.5, 0);
  s.go(30, 0); s.go(30, 30); s.go(0, 30); s.go(0, 0);
  await s.flush();
  assert.deepEqual(races(s.writes), []);
});

test('flying (the flag: no way of moving) and 10 m up without it: no time', async () => {
  const s = setup();
  await s.joined();
  s.step(-5.9, 0);
  s.lap(4, { by: null });
  s.go(-6, 0);
  s.lap(4, { y: 10 });
  await s.flush();
  assert.deepEqual(races(s.writes), []);
  assert.ok(ABOVE_MAX < 10);
  // A little up (a kerb, a step, a bridge's deck under 3 m) still runs.
  s.go(-6, 0);
  s.lap(4, { y: ABOVE_MAX - 0.5 });
  await s.flush();
  assert.equal(races(s.writes).length, 1);
});

test('a step through a block stops the run', async () => {
  const s = setup();
  await s.joined();
  wall.on = true;
  try {
    s.step(-5.9, 0);
    s.lap(4);
    await s.flush();
    assert.deepEqual(races(s.writes), []);
  } finally {
    wall.on = false;
  }
});

test('a burst after a 2 s stall starts nothing; a state the game cut starts nothing', async () => {
  const s = setup();
  await s.joined();
  s.step(-5.9, 0);
  s.go(-2.5, 0);
  s.step(-1.2, 0, { ms: 2000 }); // held back two seconds, then through the gate
  s.go(30, 0); s.go(30, 30); s.go(0, 30); s.go(0, 0);
  s.go(-6, 0);
  s.go(-2.5, 0);
  s.step(-1.2, 0, { cut: true });
  s.go(30, 0); s.go(30, 30); s.go(0, 30); s.go(0, 0);
  await s.flush();
  assert.deepEqual(races(s.writes), []);
  assert.ok(START_GAP_MS <= 200);
  // A stall mid-run only adds time.
  s.go(-6, 0);
  s.go(-0.5, 0); s.go(30, 0);
  s.step(30.1, 0, { ms: 3000 });
  s.go(30, 30); s.go(0, 30); s.go(0, 0);
  await s.flush();
  const w = races(s.writes);
  assert.equal(w.length, 1);
  assert.ok(w[0][3] > 32_000, String(w[0][3]));
});

test(`${TIMEOUT_MS / 1000} s without a checkpoint stops the run`, async () => {
  const s = setup();
  await s.joined();
  s.step(-5.9, 0);
  s.go(-0.5, 0); s.go(20, 0);
  for (let i = 0; i < TIMEOUT_MS / 1000 + 2; i++) s.step(20, 0, { ms: 1000 }); // standing still
  s.go(30, 0); s.go(30, 30); s.go(0, 30); s.go(0, 0);
  await s.flush();
  assert.deepEqual(races(s.writes), []);
});

test('gnomes: none from 50 m, one in reach once, the same twice written once, the roof one not from below', async () => {
  const s = setup();
  await s.joined();
  s.step(-5.9, 0);
  s.go(15, -56); // 50 m from g1
  await s.flush();
  assert.deepEqual(s.writes, []);
  s.go(15, -7.5); // within reach
  s.go(15, -20);
  s.go(15, -7);
  await s.flush();
  assert.deepEqual(s.writes, [['gnome', 'anna', 'g1']], 'written once');
  assert.deepEqual(s.told.map(({ t, n, tonight }) => ({ t, n, tonight })), [{ t: 'gnome', n: 1, tonight: false }]);
  // On the ground under the roof gnome: not found; up there (6 m), found.
  s.go(15, 36);
  await s.flush();
  assert.equal(s.writes.length, 1);
  s.go(15, 30);
  s.step(15, 35.5, { y: 6 });
  await s.flush();
  assert.deepEqual(s.writes.at(-1), ['gnome', 'anna', 'roof']);
  // Not while flying, down or in a party game (the game passes seek: false).
  const t = setup();
  await t.joined();
  t.step(-5.9, 0);
  t.go(15, -6, 4, { seek: false });
  await t.flush();
  assert.deepEqual(t.writes, []);
  // The store says it had it already (found before, in another session): no second message.
  const u = setup({ store: { gnomesOf: async () => ['g1'] } });
  await u.joined();
  u.step(-5.9, 0);
  u.go(15, -6);
  await u.flush();
  assert.deepEqual(u.writes, [], 'known from the store: not written again');
});

test('a guest reaches tonight\'s tables and never the store; the admin is stored', async () => {
  const s = setup({ role: 'guest' });
  await s.joined();
  s.step(-5.9, 0);
  s.lap(4);
  s.go(15, -6);
  await s.flush();
  assert.deepEqual(s.writes, []);
  const night = s.g.tonight();
  assert.equal(night.races.sq.length, 1);
  assert.equal(night.races.sq[0].name, 'anna');
  assert.deepEqual(night.races.cr, []);
  assert.deepEqual(night.gnomes, [{ name: 'anna', n: 1 }]);
  assert.deepEqual(s.told.map((m) => [m.t, m.tonight]), [['race', true], ['gnome', true]]);
  assert.equal(s.told[0].place, 1);
  s.g.resetTonight();
  assert.deepEqual(s.g.tonight(), { races: { sq: [], cr: [] }, gnomes: [] });
  const a = setup({ role: 'admin' });
  await a.joined();
  a.step(-5.9, 0);
  a.lap(4);
  await a.flush();
  assert.equal(races(a.writes).length, 1);
});

test(`tonight's tables stop at ${TONIGHT_MAX} names`, () => {
  const s = setup({ role: 'guest' });
  for (let i = 0; i < TONIGHT_MAX + 20; i++) s.g.tonightRace(`g${i}`, 'sq', 30_000 + i);
  for (let i = 0; i < TONIGHT_MAX + 20; i++) s.g.tonightGnome(`h${i}`);
  assert.equal(s.g.night.names.size, TONIGHT_MAX);
  assert.equal(s.g.night.races.sq.size, TONIGHT_MAX);
  assert.equal(s.g.night.gnomes.size, 0, 'the names were taken by the races');
  assert.equal(s.g.tonight().races.sq.length, 5);
});

// ---------------------------------------------------------------- in the game (server/game.mjs), with its real world

/** A game on a fake store, a player in it at (x, z) on the ground, and states sent `ms` after the last one. */
function inGame(role = 'player', at = [0.5, -10]) {
  const writes = [];
  const store = {
    saveRaceTime: async (...a) => (writes.push(['race', ...a]), true), racePlace: async () => 1,
    saveGnome: async (...a) => (writes.push(['gnome', ...a]), true), gnomesOf: async () => [],
    addGameWin: async (...a) => (writes.push(['win', ...a]), true), addStats: async () => {}, setMeta: async () => {},
  };
  const game = new Game({ session: () => null, sessions: new Map(), log() {}, addressOf: () => '192.0.2.1', store }, []);
  const told = [];
  game.send = (ws, m) => told.push(m);
  game.broadcast = () => {};
  game.stampState = () => {};
  const clock = { t: 50_000 };
  game.goals.clock = () => clock.t;
  const ground = game.goals.ground;
  const now = Date.now();
  const p = {
    ws: { name: 'anna', readyState: 1, OPEN: 1, send() {}, close() {} }, key: 'k-anna', role, alive: true, protectedUntil: 0, drop: null, warp: 0, stamp: 0,
    state: { x: at[0], y: ground(at[0], at[1]), z: at[1], yaw: 0, pitch: 0, armed: false, flying: false, w: 'pistol', c: false },
    weapons: new Set(['pistol']), nades: [0, 0], window: now, msgs: 0, states: 0, others: 0, budget: 0.5, vbudget: 0.5, movedAt: now,
    hp: 100, score: { kills: 0, deaths: 0, points: 0 },
  };
  game.players.set('anna', p);
  game.roles.set('anna', role);
  game.goals.joined('anna', role);
  const send = (m, { flood = false } = {}) => {
    if (!flood) Object.assign(p, { window: Date.now(), msgs: 0, states: 0, others: 0 });
    game.handle('anna', p, JSON.stringify(m));
  };
  /** Where the page has itself (the server's place may differ: held, cut, put back). */
  const page = { x: at[0], z: at[1] };
  /** One state `ms` after the last (the game's budget refills with it), to (x, z) on the ground. */
  const state = (x, z, ms = 50, extra = {}, opts) => {
    page.x = x;
    page.z = z;
    p.movedAt = Date.now() - ms;
    clock.t += ms;
    send({ t: 'state', x, y: ground(x, z), z, yaw: 0, pitch: 0, armed: false, w: 'pistol', ...extra }, opts);
  };
  const go = (x, z, speed = 3.5, extra = {}) => {
    for (;;) {
      const d = Math.hypot(x - page.x, z - page.z);
      const s = Math.min(d, speed / 20);
      state(page.x + ((x - page.x) / (d || 1)) * s, page.z + ((z - page.z) / (d || 1)) * s, 50, extra);
      if (d <= s + 1e-9) return;
    }
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { game, p, writes, told, send, state, go, flush, tracked: () => game.goals.players.get('anna') };
}

const ROUTES_REAL = readGoals().routes;
const FOOT = ROUTES_REAL.find((r) => r.id === 'foot');
/** 8 m before the walking route's gate, on its line to the first checkpoint, and 3 m past the gate on it. */
const along = (d) => {
  const [gx, gz] = FOOT.gate, [fx, fz] = FOOT.checkpoints[0];
  const l = Math.hypot(fx - gx, fz - gz);
  return [gx + ((fx - gx) / l) * d, gz + ((fz - gz) / l) * d];
};

test('in the game: through the real gate at running pace starts a run; the admin\'s fast walking never does', async () => {
  for (const [role, speed, starts] of [['player', 3.5, true], ['guest', 3.5, true], ['admin', 3.5, true], ['admin', 20, false]]) {
    const s = inGame(role, along(-8));
    try {
      s.state(...along(-7.9)); // the first state after joining is no step
      s.go(...along(3), speed);
      assert.equal(!!s.tracked().run, starts, `${role} at ${speed} m/s`);
      // The game let the admin move that fast: only the board's own budget says no.
      assert.ok(Math.hypot(s.p.state.x - along(3)[0], s.p.state.z - along(3)[1]) < 0.01, role);
    } finally {
      s.game.close();
    }
  }
});

test('in the game: a page\'s own race and gnome messages are ignored', async () => {
  const s = inGame();
  try {
    s.send({ t: 'race', id: 'foot', ms: 5000, best: true });
    s.send({ t: 'race', route: 'foot@1', time: 25000 });
    s.send({ t: 'gnome', id: 'g01' });
    s.send({ t: 'gnome', n: 30 });
    await s.flush();
    assert.deepEqual(s.writes, []);
    assert.deepEqual(s.game.goals.tonight().gnomes, []);
    assert.deepEqual(s.told, []);
  } finally {
    s.game.close();
  }
});

test('in the game: a gnome walked up to is noted once; a thousand states in a second write at most once', async () => {
  const s = inGame('player', [0.5, -11]);
  try {
    s.state(0.5, -11.05);
    s.go(0.5, -15);
    s.go(0.5, -11);
    s.go(0.5, -15);
    await s.flush();
    assert.deepEqual(s.writes, [['gnome', 'anna', 'g01']]);
    // A flood back and forth over it: the flood guard takes 30 states, and the gnome is written once all the same.
    const t = inGame('player', [0.5, -14]);
    try {
      t.state(0.5, -14.05);
      for (let i = 0; i < 1000; i++) t.state(0.5, i % 2 ? -14 : -16, 1, {}, { flood: true });
      await t.flush();
      assert.ok(t.writes.length <= 1, String(t.writes.length));
    } finally {
      t.game.close();
    }
  } finally {
    s.game.close();
  }
});

test('in the game: the roof gnome is not found from the ground under it', async () => {
  const roof = readGoals().gnomes.find((g) => g.y !== null && g.y > 10);
  const s = inGame('player', [roof.x - 4, roof.z]);
  try {
    s.state(roof.x - 3.95, roof.z);
    s.go(roof.x + 4, roof.z);
    await s.flush();
    assert.deepEqual(s.writes, []);
  } finally {
    s.game.close();
  }
});

test('in the game: a party game on, the host\'s freeze and a Zombies room count nothing', async () => {
  const s = inGame('player', [0.5, -11]);
  try {
    s.state(0.5, -11.05);
    s.game.modes.state = { kind: 'tag', phase: 'playing', until: Date.now() + 60_000 };
    s.go(0.5, -15);
    s.go(0.5, -11); // back out of reach before the game ends
    await s.flush();
    assert.deepEqual(s.writes, [], 'a party game');
    s.game.modes.state = { kind: 'free' };
    s.game.host.frozen = { text: '' };
    s.go(0.5, -15); // held where they stand, and nothing found
    await s.flush();
    assert.deepEqual(s.writes, [], 'frozen');
    s.game.host.frozen = null;
    // Free again: found.
    s.go(0.5, -11);
    s.go(0.5, -15);
    await s.flush();
    assert.deepEqual(s.writes, [['gnome', 'anna', 'g01']]);
  } finally {
    s.game.close();
  }
  const room = new Game({ session: () => null, sessions: new Map(), log() {}, store: {} }, [], { id: 'r1', owner: 'anna', arena: { id: 'church' }, edge: null, max: 4 });
  try {
    assert.equal(room.goals, null);
  } finally {
    room.close();
  }
});

test('in the game: party games won go to the board for accounts and the admin, never a guest', async () => {
  const s = inGame();
  try {
    s.game.roles.set('yoshi', 'admin');
    s.game.roles.set('gast', 'guest');
    s.game.partyWon('tag', ['anna', 'yoshi', 'gast', 'nobody', 'anna']);
    await s.flush();
    assert.deepEqual(s.writes, [['win', 'anna', 'tag'], ['win', 'yoshi', 'tag']]);
  } finally {
    s.game.close();
  }
});

test('the tracker\'s cost per state: no run, near nothing', () => {
  const s = setup();
  s.g.joined('anna', 'guest');
  const prev = { x: 200, y: 0, z: 200 }, next = { x: 200, y: 0, z: 200 };
  const opts = { gapMs: 50, cut: false, seek: true };
  s.g.moved('anna', prev, next, 'foot', opts);
  const n = 200_000;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    prev.x = next.x;
    next.x = prev.x + (i % 2 ? 0.2 : -0.2);
    s.g.moved('anna', prev, next, 'foot', opts);
  }
  const us = ((performance.now() - t0) * 1000) / n;
  console.log(`     moved(): ${us.toFixed(3)} µs a state, walking, no run`);
  assert.ok(us < 20, `${us} µs`);
});
