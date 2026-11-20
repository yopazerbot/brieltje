import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { Game } from './game.mjs';
import { READY_AT, READY_MS } from './modes.mjs';
import { arenaOf } from '../shared/arenas.mjs';

// A game's start holds the server no longer than a moment, with a game night's 30 players (server/modes.mjs prepare).
// Attack and defend's start made both its rounds' zombie grids (shared/zombies.mjs makeNav, for its traps and turrets)
// and held the server about 0.2 s: nobody's messages handled meanwhile, a hitch on every screen. Zombies made its own
// (some 70 ms). Now the host's countdown makes them, one per timer, and the start takes them: the same grids, the
// game's rules and every check on a message as they were. Started any other way (the admin's menu) it is as before.

const PLAYERS = 30;

function setup(t) {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const store = { addStats: async () => {}, setMeta: async () => {}, getMeta: async () => null, addCar: async () => 1, deleteCar: async () => {} };
  const game = new Game({ session: () => null, store, log: () => {} }, [], null);
  for (const x of game.timers) clearInterval(x);
  game.auth = { ...game.auth, store, session: () => null, log: () => {}, addressOf: () => '127.0.0.1' };
  game.broadcast = () => {};
  game.send = () => {};
  game.stampState = () => {};
  for (let i = 0; i < PLAYERS; i++) {
    const name = `p${String(i).padStart(2, '0')}`;
    const ws = { name, readyState: 1, OPEN: 1, send() {}, on: () => {}, close: () => {} };
    game.join(ws, { username: name, role: 'player', key: `k-${name}` }, { headers: {}, socket: {} });
  }
  game.join({ name: 'admin', readyState: 1, OPEN: 1, send() {}, on: () => {}, close: () => {} }, { username: 'admin', role: 'admin', key: 'k-admin' }, { headers: {}, socket: {} });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Every zombie grid made (not one handed over from the countdown), and when.
  const built = [];
  const zombieGround = game.zombieGround.bind(game);
  let fromCountdown = 0;
  const readyGround = game.modes.readyGround.bind(game.modes);
  game.modes.readyGround = (arena, now) => {
    const r = readyGround(arena, now);
    if (r) fromCountdown++;
    return r;
  };
  game.zombieGround = (arena) => {
    const before = fromCountdown;
    const g = zombieGround(arena);
    if (fromCountdown === before) built.push({ id: arena.id, at: clock });
    return g;
  };
  /** `ms` later on the game's clock and its timers; how long the server was held doing what came due (ms). */
  const wait = (ms) => {
    clock += ms;
    const a = performance.now();
    t.mock.timers.tick(ms);
    return performance.now() - a;
  };
  /** One tick of the game's modes; how long it held the server (ms). */
  const tick = (ms = 50) => {
    clock += ms;
    const a = performance.now();
    game.modes.tick(clock, ms);
    return performance.now() - a;
  };
  const act = (b) => {
    game.host.actions = [];
    return game.host.act('admin', b);
  };
  return { game, wait, tick, act, built, now: () => clock, taken: () => fromCountdown };
}

/** The host's countdown played through, timer by timer: how long each part held the server (ms). */
function countdown(s, entry) {
  assert.deepEqual(s.act({ op: 'start', ...entry }), { ok: true });
  const held = [];
  let at = 0;
  for (const due of [...READY_AT, 10_000]) {
    held.push(s.wait(due - at));
    at = due;
  }
  return { grids: held.slice(0, -1), start: held.at(-1) };
}

test('Attack and defend from the countdown: both grids made in it, one per timer; its start, break, round 2 and end make none', (t) => {
  const s = setup(t);
  assert.deepEqual(s.act({ op: 'start', kind: 'assault', minutes: 1 }), { ok: true });
  const t0 = s.now();
  s.wait(READY_AT[0]);
  assert.deepEqual(s.built.map((b) => b.id), ['church'], 'the church\'s grid at the first timer, alone');
  s.wait(READY_AT[1] - READY_AT[0]);
  assert.deepEqual(s.built.map((b) => b.id), ['church', 'sparrenhof'], 'the Sparrenhof\'s at the next');
  assert.ok(s.built.every((b, i) => b.at - t0 === READY_AT[i]), 'never two in one go');
  s.wait(10_000 - READY_AT[1]);
  const f = s.game.modes.state.f;
  assert.equal(f?.assault, true, 'Attack and defend is on');
  assert.equal(s.built.length, 2, 'its start made no grid');
  assert.equal(s.taken(), 2, 'it took both of the countdown\'s');
  assert.ok(f.supply.loot, 'its traps have their grid');
  // Played through: the clock ends round 1, the break, round 2, the end. None makes a grid.
  s.game.modes.state.until = s.now();
  s.tick();
  assert.equal(f.phase, 'break');
  s.game.modes.state.until = s.now();
  s.tick();
  assert.equal(f.round, 2);
  assert.ok(f.supply.loot, 'round 2\'s traps on the Sparrenhof\'s grid');
  s.game.modes.state.until = s.now();
  s.tick();
  assert.equal(f.over, true);
  assert.equal(s.built.length, 2, 'no grid made in the whole game but the countdown\'s two');
});

test('the countdown\'s grid is the grid the start made before: the same ground, the same places to stand and to come out', (t) => {
  const s = setup(t);
  for (const id of ['church', 'sparrenhof']) {
    const arena = arenaOf(id);
    s.game.modes.prepare('assault', 'assault');
    s.wait(READY_AT[1]); // both made
    const ready = s.game.modes.readyGround(arena);
    assert.ok(ready, `${id}: made in the countdown`);
    const fresh = s.game.zombieGround(arena); // nothing ready now: made as the start made it
    assert.notEqual(ready.nav, fresh.nav);
    assert.equal(ready.nav.nodes, fresh.nav.nodes);
    assert.deepEqual(ready.nav.spawnSpots(), fresh.nav.spawnSpots());
    assert.deepEqual(ready.spots, fresh.spots);
    const { x0, z0, nx, nz } = fresh.nav;
    for (let i = 0; i < 4000; i++) {
      const x = x0 + ((i * 7919) % nx) * 0.5, z = z0 + ((i * 104729) % nz) * 0.5;
      assert.equal(ready.nav.walkable(x, z), fresh.nav.walkable(x, z), `${id}: walkable at ${x}, ${z}`);
      assert.equal(ready.nav.locate(x, ready.nav.ground(x, z) + 0.3, z, 0.1), fresh.nav.locate(x, fresh.nav.ground(x, z) + 0.3, z, 0.1));
    }
    s.game.modes.unprepare();
  }
});

test('Zombies from the countdown: its grid made in it, the start takes it with the panes mended as the start mends them', (t) => {
  const s = setup(t);
  assert.deepEqual(s.act({ op: 'start', kind: 'zombies', place: 'house' }), { ok: true });
  s.wait(READY_AT[0]);
  assert.deepEqual(s.built.map((b) => b.id), ['house']);
  s.game.broken.add(0); // a pane broken during the countdown: the start mends every pane
  const panes = [];
  const ready = s.game.modes.ready.grounds.get('house').ground;
  const setPanes = ready.nav.setPanes;
  ready.nav.setPanes = (list) => (panes.push([...list]), setPanes(list));
  s.wait(10_000 - READY_AT[0]);
  assert.equal(s.game.modes.state.kind, 'zombies');
  assert.equal(s.built.length, 1, 'the start made no grid');
  assert.equal(s.game.modes.state.z.horde.nav, ready.nav, 'the horde walks the countdown\'s grid');
  assert.deepEqual(panes.at(-1), [], 'with every pane whole, as the start made them');
});

test('called off, replaced or another game started: the countdown\'s grids go, none is made after, a stale one is never used', (t) => {
  const s = setup(t);
  // Stop before the first timer: none made at all.
  s.act({ op: 'start', kind: 'assault' });
  s.wait(100);
  s.act({ op: 'stop' });
  s.wait(20_000);
  assert.equal(s.built.length, 0, 'Stop: no grid made after it');
  assert.equal(s.game.modes.ready, null);
  // Cancel between the two: the one made goes, the other never comes.
  s.act({ op: 'start', kind: 'assault' });
  s.wait(READY_AT[0] + 10);
  s.act({ op: 'cancel' });
  s.wait(20_000);
  assert.equal(s.built.length, 1);
  assert.equal(s.game.modes.ready, null);
  // Replaced by another game in the countdown: the first one's timers never make theirs.
  s.built.length = 0;
  s.act({ op: 'start', kind: 'assault' });
  s.wait(500);
  s.act({ op: 'start', kind: 'tag', minutes: 5 });
  s.wait(20_000);
  assert.equal(s.built.length, 0, 'the replaced game\'s grids never made');
  assert.equal(s.game.modes.state.kind, 'tag');
  s.act({ op: 'stop' });
  // The admin starts Zombies by hand during an Attack and defend countdown: it makes its own grid, as before; the
  // countdown's go with the countdown.
  s.built.length = 0;
  s.act({ op: 'start', kind: 'assault' });
  s.wait(READY_AT[1] + 10);
  s.game.handle('admin', s.game.players.get('admin'), JSON.stringify({ t: 'mode', kind: 'zombies', place: 'house' }));
  assert.deepEqual(s.built.map((b) => b.id), ['church', 'sparrenhof', 'house']);
  assert.equal(s.game.modes.ready, null);
  s.wait(20_000);
  assert.equal(s.game.modes.state.kind, 'zombies', 'no Attack and defend over it');
  s.game.modes.start('free', 'admin');
  // A grid older than READY_MS is never handed over: made again.
  s.game.modes.prepare('zombies', 'house');
  s.wait(READY_AT[0]);
  s.wait(READY_MS + 1);
  s.built.length = 0;
  s.game.modes.start('zombies', 'admin', 'house');
  assert.deepEqual(s.built.map((b) => b.id), ['house'], 'stale: made as before');
});

test('a host queueing Attack and defend over and over makes at most one countdown\'s grids (denial of service)', (t) => {
  const s = setup(t);
  // Ten a second (the host's flood guard) for five seconds: each queue calls the last one's timers off.
  for (let i = 0; i < 50; i++) {
    s.game.host.act('admin', { op: 'start', kind: 'assault' });
    s.wait(100);
    if (i % 10 === 9) s.game.host.actions = [];
  }
  assert.equal(s.built.length, 0, 'no countdown lived long enough to make one');
  s.wait(20_000);
  assert.equal(s.built.length, 2, 'the last one\'s two');
  // The guard itself as before: eleven in one second, the eleventh refused.
  s.game.host.actions = [];
  const r = Array.from({ length: 11 }, () => s.game.host.act('admin', { op: 'start', kind: 'assault' }));
  assert.equal(r.at(-1).code, 'tooFast');
  s.act({ op: 'stop' });
});

test('a start, the round change, round 2, the end and a Stop tell every page with its socket corked: one write each, the same messages', (t) => {
  const s = setup(t);
  // Every page's socket: corked how deep now, and what it was sent while corked or not.
  const socks = [];
  for (const p of [...s.game.players.values()]) {
    const sock = { depth: 0, destroyed: false, cork() { this.depth++; }, uncork() { this.depth--; } };
    const sent = { corked: [], loose: [] };
    p.ws._socket = sock;
    p.ws.send = (d) => (sock.depth > 0 ? sent.corked : sent.loose).push(d);
    socks.push({ sock, sent });
  }
  delete s.game.send; // the game's own send and broadcast, through each page's socket
  delete s.game.broadcast;
  const sentNow = () => socks.map((x) => x.sent.corked.length + x.sent.loose.length);
  const looseNow = () => socks.map((x) => x.sent.loose.length);
  const step = (label, fn) => {
    const [all, loose] = [sentNow(), looseNow()];
    fn();
    assert.ok(socks.every((x) => x.sock.depth === 0), `${label}: every socket uncorked again`);
    assert.ok(sentNow().every((n, i) => n > all[i]), `${label}: every page told`);
    assert.deepEqual(looseNow(), loose, `${label}: nothing written outside the cork`);
  };
  s.act({ op: 'start', kind: 'assault', minutes: 1 });
  s.wait(READY_AT[1]);
  step('the start', () => s.wait(10_000 - READY_AT[1]));
  assert.equal(s.game.modes.state.f?.assault, true);
  for (const label of ['round 1 over, the break', 'round 2', 'the end']) {
    for (let i = 0; i < 5; i++) s.tick(); // a few plain ticks first: what a tick sends of its own (the weapons in hand) is no part of it
    s.game.modes.state.until = s.now();
    step(label, () => s.tick());
  }
  step('Stop', () => s.act({ op: 'stop' }));
  assert.equal(s.game.modes.state.kind, 'free');
  // A message on its own (a tick, a chat line) is written at once, as before.
  const loose = looseNow();
  s.game.broadcast({ t: 'system', text: 'hello' });
  assert.ok(looseNow().every((n, i) => n === loose[i] + 1));
});

test(`with ${PLAYERS} players a start, a round change and the end hold the server far less than making the grids`, (t) => {
  // A timing test, the least of three tries (the first warms the code, as a server's first game does). Measured against
  // making the same grids here and now, so a busy computer (the whole suite runs at once) slows both alike. Before, a
  // start held the server as long as its grids took and more (Attack and defend some 40 ms here, 0.15 to 0.2 s on a
  // server with 30 sockets); now a small part of it. The times themselves: the diagnostic line, and on a server
  // tools/dev/gamenight_ws_check.mjs --stall.
  const s = setup(t);
  const best = { start: Infinity, grid: Infinity, break: Infinity, round2: Infinity, end: Infinity, zombies: Infinity, zgrid: Infinity, both: Infinity, house: Infinity };
  const making = (ids) => {
    const a = performance.now();
    for (const id of ids) s.game.zombieGround(arenaOf(id)); // nothing made in a countdown now: made as a start made them
    return performance.now() - a;
  };
  for (let k = 0; k < 3; k++) {
    best.both = Math.min(best.both, making(['church', 'sparrenhof']));
    best.house = Math.min(best.house, making(['house']));
    const a = countdown(s, { kind: 'assault', minutes: 1 });
    assert.equal(s.game.modes.state.f?.assault, true);
    best.start = Math.min(best.start, a.start);
    best.grid = Math.min(best.grid, Math.max(...a.grids));
    for (const part of ['break', 'round2', 'end']) {
      s.game.modes.state.until = s.now();
      best[part] = Math.min(best[part], s.tick());
    }
    s.act({ op: 'stop' });
    const z = countdown(s, { kind: 'zombies', place: 'house' });
    assert.equal(s.game.modes.state.kind, 'zombies');
    best.zombies = Math.min(best.zombies, z.start);
    best.zgrid = Math.min(best.zgrid, Math.max(...z.grids));
    s.act({ op: 'stop' });
  }
  t.diagnostic(`held (ms, best of 3): ${Object.entries(best).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ')}`);
  for (const part of ['start', 'break', 'round2', 'end']) assert.ok(best[part] < best.both / 3, `${part}: ${best[part].toFixed(1)} ms, the grids ${best.both.toFixed(1)}`);
  assert.ok(best.zombies < best.house / 2, `Zombies' start: ${best.zombies.toFixed(1)} ms, its grid ${best.house.toFixed(1)}`);
  assert.ok(best.grid < best.both, 'the countdown makes one grid at a time, never both at once');
});
