import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { Game, ZOMBIE_NAVS } from './game.mjs';
import { arenaOf } from '../shared/arenas.mjs';
import { makeNav } from '../shared/zombies.mjs';

// A game's start holds the server no longer than a moment, with a game night's 30 players. Attack and defend's start
// made both its rounds' zombie grids (shared/zombies.mjs makeNav, for its traps and turrets) whole and held the server
// about 0.2 s: nobody's messages handled meanwhile, a hitch on every screen. Zombies made its own (some 70 ms). Now each
// place's part that never changes is kept (server/navCache.mjs) and a start adds only its cars, as they stand at the
// start: a few ms. The host's countdown makes nothing ahead (a grid made in it missed a car driven in after it, and kept
// one driven out). Every page is told a start with its socket corked.

const PLAYERS = 30;
const COUNTDOWN_MS = 10_000;

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
  // Every zombie grid made, and when.
  const built = [];
  const zombieGround = game.zombieGround.bind(game);
  game.zombieGround = (arena) => {
    built.push({ id: arena.id, at: clock });
    return zombieGround(arena);
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
  return { game, wait, tick, act, built, now: () => clock };
}

/** The host's countdown played through: how long it held the server before the start, and at the start (ms). */
function countdown(s, entry) {
  assert.deepEqual(s.act({ op: 'start', ...entry }), { ok: true });
  const before = s.wait(COUNTDOWN_MS - 1);
  return { countdown: before, start: s.wait(1) };
}

test('Attack and defend from the countdown: nothing made in the countdown; its start makes both grids at once; its break, round 2 and end none', (t) => {
  const s = setup(t);
  assert.deepEqual(s.act({ op: 'start', kind: 'assault', minutes: 1 }), { ok: true });
  const t0 = s.now();
  s.wait(COUNTDOWN_MS - 1);
  assert.deepEqual(s.built, [], 'the countdown makes no grid');
  s.wait(1);
  const f = s.game.modes.state.f;
  assert.equal(f?.assault, true, 'Attack and defend is on');
  assert.deepEqual(s.built.map((b) => b.id).sort(), ['church', 'sparrenhof'], 'its start made both');
  assert.ok(s.built.every((b) => b.at - t0 === COUNTDOWN_MS), 'at the start, with the cars as they stand then');
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
  assert.equal(s.built.length, 2, 'no grid made in the whole game but its start\'s two');
});

test('Zombies from the countdown: a car driven into the place during it is a block in the game\'s grid, one driven out is not', (t) => {
  const s = setup(t);
  const arena = arenaOf('house');
  const cars = Object.values(s.game.cars);
  const [incoming, outgoing] = cars;
  const parked = { x: incoming.x, z: incoming.z, yaw: incoming.yaw }; // where the incoming one stands before (another car's spot)
  // Two open spots of the place, well apart and away from every car: one each.
  const open = s.game.zombieGround(arena).nav.spawnSpots();
  const clear = (p) => cars.every((c) => Math.hypot(c.x - p.x, c.z - p.z) > 10);
  const a = open.find(clear);
  const b = open.find((p) => clear(p) && Math.hypot(p.x - a.x, p.z - a.z) > 12);
  assert.ok(a && b, 'two open spots');
  // Before the countdown the outgoing car stands on spot b: a block there.
  Object.assign(outgoing, { x: b.x, z: b.z });
  assert.equal(s.game.zombieGround(arena).nav.walkable(b.x, b.z), false, 'a car is a block in the grid');
  s.built.length = 0;
  assert.deepEqual(s.act({ op: 'start', kind: 'zombies', place: 'house' }), { ok: true });
  s.wait(5000); // half way: the grids of the making-ahead were made by now (0.8 s in)
  Object.assign(incoming, { x: a.x, z: a.z }); // driven onto spot a
  Object.assign(outgoing, parked); // and the other one driven off spot b, out of the way
  s.wait(COUNTDOWN_MS - 5000);
  assert.equal(s.game.modes.state.kind, 'zombies');
  assert.deepEqual(s.built.map((b) => [b.id, b.at]), [['house', s.now()]], 'one grid, made at the start');
  const nav = s.game.modes.state.z.horde.nav;
  assert.equal(nav.walkable(a.x, a.z), false, 'the car driven in is a block');
  assert.equal(nav.walkable(b.x, b.z), true, 'where the car drove off is open');
});

test('Stop, Cancel or another game in the countdown: no grid made at all', (t) => {
  const s = setup(t);
  for (const [op, b] of [['stop'], ['cancel'], ['start', { kind: 'tag', minutes: 5 }]]) {
    s.act({ op: 'start', kind: 'assault' });
    s.wait(3000);
    s.act({ op, ...b });
    s.wait(20_000);
    assert.deepEqual(s.built, [], `${op}${b ? ` ${b.kind}` : ''}: nothing made`);
    s.act({ op: 'stop' });
  }
  assert.equal(s.game.modes.state.kind, 'free');
});

test('a host queueing Attack and defend over and over makes only the last one\'s grids, at its start (denial of service)', (t) => {
  const s = setup(t);
  // Ten a second (the host's flood guard) for five seconds: each queue replaces the last one's countdown.
  for (let i = 0; i < 50; i++) {
    s.game.host.act('admin', { op: 'start', kind: 'assault' });
    s.wait(100);
    if (i % 10 === 9) s.game.host.actions = [];
  }
  assert.equal(s.built.length, 0, 'nothing made while it counts down');
  s.wait(20_000);
  assert.equal(s.built.length, 2, 'the last one\'s two, at its start');
  // The guard itself as before: eleven in one second, the eleventh refused.
  s.game.host.actions = [];
  const r = Array.from({ length: 11 }, () => s.game.host.act('admin', { op: 'start', kind: 'assault' }));
  assert.equal(r.at(-1).code, 'tooFast');
  s.act({ op: 'stop' });
});

test('a start, the round change, round 2, the end, free play after it, a start from the menu and a Stop tell every page with its socket corked: one write each, the same messages', (t) => {
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
  s.wait(COUNTDOWN_MS - 1);
  step('the start', () => s.wait(1));
  assert.equal(s.game.modes.state.f?.assault, true);
  for (const label of ['round 1 over, the break', 'round 2', 'the end']) {
    for (let i = 0; i < 5; i++) s.tick(); // a few plain ticks first: what a tick sends of its own (the weapons in hand) is no part of it
    s.game.modes.state.until = s.now();
    step(label, () => s.tick());
  }
  // Its result shown, free play: everyone back in their own colours, told at once.
  s.game.modes.state.until = s.now();
  step('free play after the result', () => s.tick());
  assert.equal(s.game.modes.state.kind, 'free');
  // A start from the admin's own menu (no countdown), and the host's Stop.
  step('a start from the admin\'s menu', () => s.game.handle('admin', s.game.players.get('admin'), JSON.stringify({ t: 'mode', kind: 'zombies', place: 'sparrenhof' })));
  assert.equal(s.game.modes.state.kind, 'zombies');
  step('Stop', () => s.act({ op: 'stop' }));
  assert.equal(s.game.modes.state.kind, 'free');
  // A message on its own (a tick, a chat line) is written at once, as before.
  const loose = looseNow();
  s.game.broadcast({ t: 'system', text: 'hello' });
  assert.ok(looseNow().every((n, i) => n === loose[i] + 1));
});

test(`with ${PLAYERS} players a start, a round change and the end hold the server far less than making the grids whole`, (t) => {
  // A timing test, the least of three tries (the first warms the code, as a server's first game does). Measured against
  // making the same grids whole here and now (shared/zombies.mjs makeNav, as every start did before the places' parts
  // were kept), so a busy computer (the whole suite runs at once) slows both alike. Before, a start held the server as
  // long as its grids took and more (Attack and defend some 40 ms here, 0.15 to 0.2 s on a server with 30 sockets); now
  // a small part of it, its grids on their places' kept parts (server/navCache.mjs). The times themselves: the
  // diagnostic line, and on a server tools/dev/gamenight_ws_check.mjs --stall.
  const s = setup(t);
  const best = { countdown: Infinity, start: Infinity, break: Infinity, round2: Infinity, end: Infinity, zombies: Infinity, kept: Infinity, both: Infinity, house: Infinity };
  const making = (ids) => {
    const a = performance.now();
    for (const id of ids) makeNav({ ...ZOMBIE_NAVS.optsOf(arenaOf(id)), boxes: [] }); // made whole, as a start made them before
    return performance.now() - a;
  };
  const kept = (ids) => {
    const a = performance.now();
    for (const id of ids) s.game.zombieGround(arenaOf(id)); // as a start makes them
    return performance.now() - a;
  };
  for (let k = 0; k < 3; k++) {
    best.both = Math.min(best.both, making(['church', 'sparrenhof']));
    best.house = Math.min(best.house, making(['house']));
    best.kept = Math.min(best.kept, kept(['church', 'sparrenhof']));
    const a = countdown(s, { kind: 'assault', minutes: 1 });
    assert.equal(s.game.modes.state.f?.assault, true);
    best.countdown = Math.min(best.countdown, a.countdown);
    best.start = Math.min(best.start, a.start);
    for (const part of ['break', 'round2', 'end']) {
      s.game.modes.state.until = s.now();
      best[part] = Math.min(best[part], s.tick());
    }
    s.act({ op: 'stop' });
    const z = countdown(s, { kind: 'zombies', place: 'house' });
    assert.equal(s.game.modes.state.kind, 'zombies');
    best.zombies = Math.min(best.zombies, z.start);
    s.act({ op: 'stop' });
  }
  t.diagnostic(`held (ms, best of 3): ${Object.entries(best).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ')}`);
  assert.ok(best.start < best.both / 2, `Attack and defend's start: ${best.start.toFixed(1)} ms, its grids made whole ${best.both.toFixed(1)}`);
  for (const part of ['break', 'round2', 'end']) assert.ok(best[part] < best.both / 3, `${part}: ${best[part].toFixed(1)} ms, the grids ${best.both.toFixed(1)}`);
  assert.ok(best.zombies < best.house / 2, `Zombies' start: ${best.zombies.toFixed(1)} ms, its grid ${best.house.toFixed(1)}`);
  assert.ok(best.kept < best.both / 2, `both grids on their places' kept parts: ${best.kept.toFixed(1)} ms, made whole ${best.both.toFixed(1)}`);
});
