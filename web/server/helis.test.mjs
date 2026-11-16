import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { HELI, heliStart, heliStep } from '../shared/heli.mjs';
import { HOMES, homeAt } from '../shared/homes.mjs';
import { DROP } from '../shared/parachute.mjs';
import { makeTerrain } from '../shared/terrain.mjs';
import { heliFields, readHeli } from '../shared/wire.mjs';
import { Game, HELI_REFUSED } from './game.mjs';
import { HELI_DOWN, HELI_SPEED, HELI_TILT, HELI_TURN, HELI_UP, IDLE_MS, IN_THE_WAY_MS, PILOTLESS_MS } from './helis.mjs';

// The helicopters in the shared house (server/helis.mjs): the server owns the machines and their four seats, holds
// every pose a pilot's page reports to the flight model's caps, keeps every machine out of the code-locked homes,
// pins everyone aboard to the machine, lets anyone out at any time, keeps those aboard out of every fight and game, and
// flies machines home. Each forged message below must change nothing it may not.

const DATA = JSON.parse(readFileSync(new URL('../shared/heli.json', import.meta.url), 'utf8'));
const BOUNDS = JSON.parse(readFileSync(new URL('../shared/bounds.json', import.meta.url), 'utf8'));
const TERRAIN = makeTerrain(JSON.parse(readFileSync(new URL('../shared/terrain.json', import.meta.url), 'utf8')));
const SPAWNS = JSON.parse(readFileSync(new URL('../shared/spawns.json', import.meta.url), 'utf8'));
const GAME_SRC = readFileSync(new URL('./game.mjs', import.meta.url), 'utf8');
const RUN_SPEED = 1.4 * 2.5 * 1.3; // m/s across on foot (game.mjs)
const ID = DATA.machines[0].id;
const PARK = DATA.machines[0].park;
const HOUSE_GROUND = -0.1; // shared house data's ground (HOUSE.ground), checked against the server's floor below
/** Messages the page may send from a seat (as game.mjs HELI_REFUSED's comment lists them): every other type Game.handle reads must be refused aboard. */
const ALLOWED = ['state', 'heli', 'chat', 'pong', 'rally', 'team', 'mode', 'rules', 'mood', 'moodskip', 'moodspeed', 'newround', 'zwave', 'kick', 'repair', 'travel'];

function setup() {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const game = new Game({ session: () => null, store: { addStats: async () => {}, setMeta: async () => {} }, log: () => {} }, []);
  for (const t of game.timers) clearInterval(t);
  const told = [];
  const sent = new Map();
  game.broadcast = (m, except) => told.push(structuredClone({ ...m, except }));
  game.send = (ws, m) => sent.get(ws.name)?.push(structuredClone(m));
  game.stampState = () => {};
  const h = game.helis.machines.get(ID);
  /** A point `lx` to the right of the machine and `lz` back from its hub, at its height plus `dy`. */
  const local = (lx, lz, dy = 0) => ({
    x: h.x + lx * Math.cos(h.yaw) + lz * Math.sin(h.yaw), y: h.y + dy, z: h.z - lx * Math.sin(h.yaw) + lz * Math.cos(h.yaw),
  });
  const player = (name, at = local(1.5, -0.4), role = 'player') => {
    const p = {
      ws: { name }, key: `k-${name}`, role, alive: true, protectedUntil: 0, drop: null, warp: 0, stamp: 0,
      state: { x: at.x, y: at.y, z: at.z, yaw: 0, pitch: 0, armed: true, flying: false, w: 'pistol', c: false },
      weapons: new Set(['pistol']), nades: [0, 0], thrown: [], window: clock, msgs: 0, states: 0, others: 0, budget: 0.5, vbudget: 0.5, movedAt: clock,
      hp: 100, score: { kills: 0, deaths: 0, points: 0 }, proto: 2,
    };
    sent.set(name, []);
    game.players.set(name, p);
    return p;
  };
  /** A message from `p`, with the flood guard's window let go. */
  const send = (name, p, m) => {
    p.window = clock;
    p.msgs = p.states = p.others = 0;
    game.handle(name, p, JSON.stringify(m));
  };
  /** A `heli` message, with the 300 ms gate let go. */
  const ask = (name, p, m) => {
    p.nextCar = 0;
    send(name, p, m);
  };
  /** A state `dt` ms after the last (the clock moves on), at `to` (missing fields: where the server has them). */
  const state = (name, p, to = {}, dt = 50) => {
    clock += dt;
    const s = p.state;
    send(name, p, { t: 'state', x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: 0, armed: s.armed, w: 'pistol', ...to });
  };
  /** The machine put at `pos` by the test (not by a message), everyone aboard with it. */
  const put = (pos) => {
    Object.assign(h, pos);
    for (const n of h.seats) if (n) Object.assign(game.players.get(n).state, { x: h.x, y: h.y, z: h.z, yaw: n === h.seats[0] ? h.yaw : 0 });
  };
  const at = (ms) => (clock += ms);
  return { game, told, sent, h, local, player, send, ask, state, put, at, now: () => clock };
}

/** Four aboard (seats 0 to 3 in this order) next to the machine on its pad. */
function crew(s, names = ['pia', 'bo', 'cas', 'dee']) {
  const ps = names.map((n, i) => s.player(n, s.local(1.5, -0.4 - i * 0.3)));
  names.forEach((n, i) => s.ask(n, ps[i], { t: 'heli', op: 'in', id: ID }));
  return ps;
}

const floor = (x, z) => HOUSE_GROUND + TERRAIN.height(x, z);

test('the data: one machine on its pad, never inside a home; the budgets follow the flight model', () => {
  const { game, h } = setup();
  assert.ok(DATA.machines.length >= 1);
  assert.equal(game.helis.atPad(h), true);
  assert.equal(game.helis.inHome(PARK.x, PARK.y, PARK.z, PARK.yaw), false);
  assert.equal(game.helis.floor(PARK.x, PARK.z), floor(PARK.x, PARK.z), 'the server floor is the relief on the house ground');
  assert.ok(Math.abs(HELI_SPEED - 62.4) < 1e-9 && Math.abs(HELI_UP - 11.7) < 1e-9 && Math.abs(HELI_DOWN - 18.2) < 1e-9);
  assert.ok(Math.abs(HELI_TURN - 2.8) < 1e-9 && HELI_TILT === 0.9);
  assert.deepEqual(h.seats, [null, null, null, null]);
});

test('an honest machine never turns faster than the turn budget refills (heliStep, a hard flight)', () => {
  const s = heliStart({ x: 0, y: 0, z: 0, yaw: 0 });
  const env = { ground: () => 0, ceiling: 120 };
  const dt = 1 / 120;
  let most = 0;
  const legs = [[{ lift: 1 }, 10], [{ fwd: 1, turn: 1 }, 15], [{ fwd: 1, turn: -1, lift: -1 }, 8], [{ turn: 1 }, 6], [{ side: 1, turn: -1 }, 6], [{ fwd: -1, turn: 1, lift: 1 }, 6], [{}, 4], [{ lift: -1 }, 20]];
  for (const [input, secs] of legs) {
    for (let i = 0; i < secs / dt; i++) {
      const y0 = s.yaw;
      heliStep(s, input, env, dt);
      most = Math.max(most, Math.abs(Math.atan2(Math.sin(s.yaw - y0), Math.cos(s.yaw - y0))) / dt);
    }
  }
  assert.ok(most > 1, `it did turn (${most.toFixed(2)} rad/s)`);
  assert.ok(most <= HELI.YAW_SLOW * 1.01, `the fastest honest turn ${most.toFixed(3)} rad/s`);
  assert.ok(most < HELI_TURN / 1.9, 'the server allows twice that');
});

test('the attack: out of the machine, a hit on someone, back in 0.6 s later: refused, at the stick and beside it', () => {
  // Before, boarding asked only "was I hit" (hurtAt): a player hit someone and was back in the unhittable seat at once
  // (damage avoidance). Now hitting counts too, on the clock of the cars and bikes (game.mjs fightRefused), 10 s.
  const s = setup();
  const { game, h, local, player, ask, send, sent } = s;
  const IN = { t: 'heli', op: 'in', id: ID };
  const pia = player('pia');
  const foe = player('foe', local(8, 6));
  const hit = () => {
    pia.nextHit = 0;
    const hp = foe.hp;
    send('pia', pia, { t: 'hit', target: 'foe', w: 'pistol', body: 1, head: 0 });
    assert.ok(foe.hp < hp, 'the hit counted');
  };
  ask('pia', pia, IN);
  assert.equal(h.seats[0], 'pia');
  ask('pia', pia, { t: 'heli', op: 'out' });
  Object.assign(pia.state, local(1.5, -0.4));
  hit();
  s.at(600);
  ask('pia', pia, IN);
  assert.equal(game.helis.of('pia'), null, 'not back at the stick');
  assert.equal(sent.get('pia').at(-2).code, 'heliFight');
  // Somebody else at the stick: no passenger's seat right after a hit either.
  const bo = player('bo', local(1.5, -0.7));
  ask('bo', bo, IN);
  assert.equal(h.seats[0], 'bo');
  s.at(5_000);
  hit();
  s.at(600);
  ask('pia', pia, IN);
  assert.deepEqual(h.seats, ['bo', null, null, null], 'no seat beside the pilot');
  assert.equal(sent.get('pia').at(-2).code, 'heliFight');
  // The one she hit may not board either; 10 s after her last hit she may.
  Object.assign(foe.state, local(1.5, -1.0));
  ask('foe', foe, IN);
  assert.equal(game.helis.of('foe'), null);
  s.at(9_500);
  ask('pia', pia, IN);
  assert.deepEqual(h.seats, ['bo', 'pia', null, null]);
});

test('boarding: within reach of the cabin on the server\'s positions, alive, on foot, not hit, not frozen, a still machine', () => {
  const s = setup();
  const { game, h, local, player, ask, sent, told } = s;
  const refused = (name, p, why) => {
    ask(name, p, { t: 'heli', op: 'in', id: ID });
    assert.equal(game.helis.of(name), null, why);
    assert.equal(sent.get(name).at(-1)?.t, 'heli', `${why}: the asker is told the machine as it is`);
  };
  refused('past', player('past', local(1.05 + DATA.reach + 1 + 0.5, -0.4)), '0.5 m past the reach');
  refused('far', player('far', local(100, 0)), '100 m away');
  refused('high', player('high', local(1.5, -0.4, 2)), '2 m too high');
  const dead = player('dead');
  dead.alive = false;
  refused('dead', dead, 'dead');
  const car = player('car');
  Object.values(game.cars)[0].driver = 'car';
  refused('car', car, 'in a car');
  const bike = player('bike');
  Object.values(game.bikes)[0].rider = 'bike';
  refused('bike', bike, 'on a bike');
  const horse = player('horse');
  game.horses[0].rider = 'horse';
  refused('horse', horse, 'on a horse');
  const fly = player('fly');
  fly.state.flying = true;
  refused('fly', fly, 'flying');
  const drop = player('drop');
  drop.drop = { until: s.now() + 10_000 };
  refused('drop', drop, 'in a drop');
  const hurt = player('hurt');
  hurt.hurtAt = s.now() - 5000;
  refused('hurt', hurt, 'hit 5 s ago');
  assert.equal(sent.get('hurt').at(-2).code, 'heliFight');
  const held = player('held');
  game.host.holds = (p) => p === held;
  refused('held', held, 'held by the host');
  assert.equal(told.length, 0, 'no refusal is told to the others');
  // Hit 11 s ago: in.
  hurt.hurtAt = s.now() - 11_000;
  ask('hurt', hurt, { t: 'heli', op: 'in', id: ID });
  assert.equal(game.helis.of('hurt'), h);
  // A moving machine: nobody gets in.
  s.put({ x: h.x, y: h.y, z: h.z });
  s.state('hurt', hurt, { x: h.x + 2, z: h.z });
  const late = player('late', local(1.5, -0.4));
  refused('late', late, 'a machine on the move');
  // Right at the reach: in.
  s.at(600);
  assert.equal(game.helis.slow(h, s.now()), true, 'still again after half a second');
  const edge = player('edge', local(1.05 + DATA.reach + 1 - 0.05, -0.4));
  ask('edge', edge, { t: 'heli', op: 'in', id: ID });
  assert.equal(game.helis.of('edge'), h);
});

test('forged ids are refused: unknown, inherited, not a string', () => {
  const { game, told, sent, player, ask } = setup();
  const anna = player('anna');
  for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'nope', 7, null, { id: ID }, [ID], undefined]) ask('anna', anna, { t: 'heli', op: 'in', id });
  assert.equal(game.helis.of('anna'), null);
  assert.equal(told.length, 0);
  assert.equal(sent.get('anna').length, 0, 'nothing to say about a machine that is not there');
  for (const op of ['seat', 'swap', 'pilot', '__proto__', 3, null]) ask('anna', anna, { t: 'heli', op, id: ID, seat: 0 });
  assert.equal(game.helis.of('anna'), null, 'unknown ops do nothing');
  assert.deepEqual([...game.helis.machines.keys()], DATA.machines.map((d) => d.id), 'no message makes a machine');
});

test('seats fill 0, 1, 2, 3 in boarding order; the fifth is refused and only the asker is told', () => {
  const s = setup();
  const { game, h, told, sent, player, ask, local } = s;
  crew(s);
  assert.deepEqual(h.seats, ['pia', 'bo', 'cas', 'dee']);
  assert.deepEqual(told.filter((m) => m.t === 'heli').map((m) => m.heli.seats.filter(Boolean).length), [1, 2, 3, 4], 'every seat change is broadcast');
  const n = told.length;
  const eve = player('eve', local(-1.5, -0.4));
  ask('eve', eve, { t: 'heli', op: 'in', id: ID, seat: 2 });
  assert.equal(game.helis.of('eve'), null);
  assert.equal(told.length, n, 'nobody else hears of it');
  assert.deepEqual(sent.get('eve').at(-1).heli.seats, ['pia', 'bo', 'cas', 'dee']);
  // Aboard: the server's flag hides the walking figure, the state is the machine's.
  assert.equal(game.players.get('cas').state.d, true);
  assert.equal(game.inCar('cas'), true);
  assert.equal(game.onFoot('cas'), false);
});

test('two asks in the same millisecond for one free seat: two different seats; `in` twice: one seat', () => {
  const s = setup();
  const { game, h, player, ask } = s;
  crew(s, ['pia', 'bo']);
  const a = player('a', s.local(1.5, 0));
  const b = player('b', s.local(-1.5, 0));
  ask('a', a, { t: 'heli', op: 'in', id: ID });
  ask('b', b, { t: 'heli', op: 'in', id: ID });
  assert.deepEqual(h.seats, ['pia', 'bo', 'a', 'b']);
  ask('a', a, { t: 'heli', op: 'out' });
  ask('a', a, { t: 'heli', op: 'in', id: ID });
  ask('a', a, { t: 'heli', op: 'in', id: ID });
  assert.equal(h.seats.filter((n) => n === 'a').length, 1);
  assert.equal(game.helis.of('a'), h);
});

test('the pilot moves the machine and everyone aboard; a passenger\'s own position, tilt and rotor are never taken', () => {
  const s = setup();
  const { game, h, state } = s;
  const [pia, bo] = crew(s, ['pia', 'bo']);
  const out = s.player('out', s.local(5, 0));
  state('pia', pia, { x: h.x - 2, y: h.y + 1, z: h.z, yaw: h.yaw, hp: 0.2, hr: -0.1, hn: 0.95, hg: 0 });
  assert.ok(Math.abs(h.x - (PARK.x - 2)) < 1e-9 && Math.abs(h.y - (PARK.y + 1)) < 1e-9);
  assert.deepEqual([h.p, h.r, h.n, h.g], [0.2, -0.1, 0.95, 0]);
  assert.deepEqual([bo.state.x, bo.state.y, bo.state.z], [h.x, h.y, h.z], 'the passenger goes along');
  // The passenger claims to be 500 m off, with a tilt and a rotor of their own.
  state('bo', bo, { x: h.x + 500, y: h.y + 50, z: h.z - 300, hp: 0.9, hn: 0, hg: 1, yaw: 1.2 });
  assert.deepEqual([bo.state.x, bo.state.y, bo.state.z], [h.x, h.y, h.z], 'pinned to the machine');
  assert.equal(bo.state.yaw, 1.2, 'looking round stays theirs');
  assert.deepEqual([h.p, h.n, h.g], [0.2, 0.95, 0], 'a passenger\'s flight fields are not read');
  const before = { ...h, seats: [...h.seats] };
  state('out', out, { x: out.state.x, hp: -0.9, hr: 0.9, hn: 0, hg: 1 });
  assert.deepEqual({ ...h, seats: [...h.seats] }, before, 'nor an outsider\'s');
  assert.equal(game.helis.of('out'), null);
});

test('budgets: forged jumps over 5 s never beat the flight\'s caps, the admin\'s neither', () => {
  for (const role of ['player', 'admin']) {
    const s = setup();
    const { h, state, put } = s;
    const pia = s.player('pia', s.local(1.5, -0.4), role);
    s.ask('pia', pia, { t: 'heli', op: 'in', id: ID });
    // Across: a page claiming 100 m every 50 ms.
    put({ x: -60, y: 40, z: -60 });
    const a0 = { x: h.x, z: h.z };
    for (let i = 0; i < 100; i++) state('pia', pia, { x: h.x + 100, y: h.y, z: h.z });
    const across = Math.hypot(h.x - a0.x, h.z - a0.z);
    assert.ok(across <= HELI_SPEED * 5 + HELI_SPEED * 0.5 + 0.5 + 1e-6, `${role}: ${across.toFixed(1)} m across in 5 s`);
    assert.ok(across > HELI_SPEED * 5 * 0.95, `${role}: the budget is spent, not refused`);
    // Up.
    put({ x: -60, y: 10, z: -60 });
    s.at(1000);
    for (let i = 0; i < 100; i++) state('pia', pia, { x: h.x, y: h.y + 100, z: h.z });
    assert.ok(h.y - 10 <= HELI_UP * 5 + HELI_UP * 0.5 + 0.5 + 1e-6, `${role}: ${(h.y - 10).toFixed(1)} m up in 5 s`);
    // Down.
    put({ x: -60, y: 115, z: -60 });
    s.at(1000);
    for (let i = 0; i < 100; i++) state('pia', pia, { x: h.x, y: h.y - 100, z: h.z });
    assert.ok(115 - h.y <= HELI_DOWN * 5 + HELI_DOWN * 0.5 + 0.5 + 1e-6, `${role}: ${(115 - h.y).toFixed(1)} m down in 5 s`);
  }
});

test('an honest flight at the caps, with 400 ms of lag in bursts, is never shortened', () => {
  const s = setup();
  const { h, put, send } = s;
  const pia = s.player('pia');
  s.ask('pia', pia, { t: 'heli', op: 'in', id: ID });
  put({ x: 300, y: 20, z: -100, yaw: Math.PI / 2 }); // 520 m west from here stays inside the map
  pia.heliUp = HELI_UP * 0.5 + 0.5;
  pia.budget = HELI_SPEED * 0.5 + 0.5;
  pia.vbudget = HELI_DOWN * 0.5 + 0.5;
  // Across at V_CAP and up at CLIMB_MAX for 6 s, then down at SINK_CAP for 4 s, each state 50 ms after the last on the
  // page, but arriving in bursts of eight every 400 ms.
  let x = h.x, y = h.y;
  let shortened = 0;
  for (let k = 0; k < 200; k++) {
    const up = k < 120;
    x -= HELI.V_CAP * 0.05;
    y += (up ? HELI.CLIMB_MAX : -HELI.SINK_CAP) * 0.05;
    if (k % 8 === 0) s.at(400);
    pia.window = s.now();
    send('pia', pia, { t: 'state', x, y, z: -100, yaw: Math.PI / 2, pitch: 0, armed: false, w: 'pistol' });
    if (Math.abs(h.x - x) > 1e-6 || Math.abs(h.y - y) > 1e-6) shortened++;
    x = h.x;
    y = h.y;
  }
  assert.equal(shortened, 0);
});

test('the turn: 50 rad/s asked gives at most 2.8 rad/s; the tilt, the rotor and the rest are held to their ranges', () => {
  const s = setup();
  const { h, put, state } = s;
  const pia = s.player('pia');
  s.ask('pia', pia, { t: 'heli', op: 'in', id: ID });
  put({ x: -60, y: 30, z: -60, yaw: 0 });
  let turned = 0;
  for (let i = 0; i < 40; i++) {
    const y0 = h.yaw;
    state('pia', pia, { x: h.x, y: h.y, z: h.z, yaw: h.yaw + 2.5 });
    turned += Math.abs(Math.atan2(Math.sin(h.yaw - y0), Math.cos(h.yaw - y0)));
  }
  assert.ok(turned <= HELI_TURN * 2 + 0.5 + 1e-6, `${turned.toFixed(2)} rad in 2 s`);
  assert.ok(turned > HELI_TURN * 2 * 0.9);
  state('pia', pia, { hp: 3, hr: -3, hn: 5, hg: 'yes' });
  assert.deepEqual([h.p, h.r, h.n, h.g], [0.9, -0.9, 1, 1]);
  state('pia', pia, { hp: 'x', hr: null, hn: -1, hg: 0 });
  assert.deepEqual([h.p, h.r, h.n, h.g], [0, 0, 0, 0]);
});

test('the ceiling, the edge and the ground hold a machine as they hold everyone', () => {
  const s = setup();
  const { game, h, put, state } = s;
  const pia = s.player('pia');
  s.ask('pia', pia, { t: 'heli', op: 'in', id: ID });
  // The ceiling.
  put({ x: -60, y: 110, z: -60 });
  for (let i = 0; i < 60; i++) state('pia', pia, { x: h.x, y: 200, z: h.z });
  assert.ok(h.y <= TERRAIN.height(h.x, h.z) + BOUNDS.ceiling + 2 + 1e-9, `${h.y} under the ceiling`);
  // The edge: a step far outside the map is put back inside.
  for (let i = 0; i < 60; i++) state('pia', pia, { x: h.x - 60, y: h.y, z: h.z });
  assert.equal(game.fence().inside(h.x, h.z), true);
  // Under the ground: never more than a metre under the server's floor.
  put({ x: -60, y: floor(-60, -60) + 1, z: -60 });
  for (let i = 0; i < 20; i++) state('pia', pia, { x: h.x, y: -20, z: h.z });
  assert.ok(h.y >= floor(h.x, h.z) - 1 - 1e-9, `${h.y} over ${floor(h.x, h.z) - 1}`);
});

/** A point deep inside a band: the five cabin points round it at heading `yaw` inside the same ring, else any point inside. */
function insidePoint(home, band) {
  const [x0, z0, x1, z1] = band.box;
  let any = null;
  for (let x = x0; x <= x1; x += 0.25) {
    for (let z = z0; z <= z1; z += 0.25) {
      const y = band.y0 + 0.5;
      if (homeAt(x, z, y) !== home.id) continue;
      any ??= { x, z };
      if ([[1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5]].every(([dx, dz]) => homeAt(x + dx, z + dz, y) === home.id)) return { x, z };
    }
  }
  return any;
}

test('a machine is never inside a code-locked home, whoever flies it (every home in the data, from the side and from above)', () => {
  assert.ok(HOMES.length >= 4, 'the four homes');
  for (const home of HOMES) {
    for (const [bi, band] of home.bands.entries()) {
      const target = insidePoint(home, band);
      assert.ok(target, `${home.id} band ${bi} has an inside`);
      for (const who of ['plain', 'admin', 'coded']) {
        const s = setup();
        const { game, h, put, state } = s;
        game.homes = { granted: (key, id) => key === 'k-pia' && who === 'coded' && id === home.id };
        const pia = s.player('pia', s.local(1.5, -0.4), who === 'admin' ? 'admin' : 'player');
        const bo = s.player('bo', s.local(1.5, -0.8));
        s.ask('pia', pia, { t: 'heli', op: 'in', id: ID });
        s.ask('bo', bo, { t: 'heli', op: 'in', id: ID });
        assert.deepEqual(h.seats.slice(0, 2), ['pia', 'bo']);
        const groundAt = floor(target.x, target.z);
        const y = Math.max(band.y0, groundAt) + 0.05;
        const check = (where) => {
          assert.equal(game.helis.inHome(h.x, h.y, h.z, h.yaw), false, `${home.id}/${bi} ${who} ${where}: the cabin stays out`);
          for (const p of [pia, bo]) assert.equal(homeAt(p.state.x, p.state.z, p.state.y), null, `${home.id}/${bi} ${who} ${where}: nobody aboard inside`);
        };
        // From the side, along x, the nose first, at the band's height: 2 m a state (40 m/s).
        const start = { x: home.box[2] + 9, z: target.z };
        put({ x: start.x, y, z: start.z, yaw: Math.PI / 2 });
        for (let i = 0; i < 40; i++) {
          state('pia', pia, { x: h.x - 2, y, z: start.z, yaw: Math.PI / 2 });
          check('from the side');
        }
        assert.ok(start.x - h.x > 3, `${home.id}/${bi} ${who}: it flew up to the wall (${(start.x - h.x).toFixed(1)} m)`);
        assert.ok(h.x > target.x, `${home.id}/${bi} ${who}: and stopped outside`);
        // From above: 12 m over the top band, straight down at 10 m/s.
        const top = Math.max(...home.bands.map((b) => b.y1));
        put({ x: target.x, y: top + 12, z: target.z, yaw: 0 });
        for (let i = 0; i < 80; i++) {
          state('pia', pia, { x: target.x, y: h.y - 0.5, z: target.z, yaw: 0 });
          check('from above');
        }
        assert.ok(h.y > groundAt + 0.5, `${home.id}/${bi} ${who}: it never came down inside (${h.y.toFixed(2)})`);
      }
    }
  }
});

test('a passenger without the code who gets out next to a home and walks in is stopped at its wall', () => {
  for (const home of HOMES) {
    const band = home.bands[0];
    const target = insidePoint(home, band);
    const s = setup();
    const { game, h, put, state } = s;
    game.homes = { granted: (key, id) => key === 'k-pia' && id === home.id };
    const pia = s.player('pia');
    const bo = s.player('bo', s.local(1.5, -0.8));
    s.ask('pia', pia, { t: 'heli', op: 'in', id: ID });
    s.ask('bo', bo, { t: 'heli', op: 'in', id: ID });
    const y = Math.max(band.y0, floor(target.x, target.z)) + 0.05;
    put({ x: home.box[2] + 9, y, z: target.z, yaw: Math.PI / 2 });
    for (let i = 0; i < 40; i++) state('pia', pia, { x: h.x - 2, y, z: target.z, yaw: Math.PI / 2 });
    s.ask('bo', bo, { t: 'heli', op: 'out' });
    assert.equal(game.helis.of('bo'), null);
    for (let i = 0; i < 300; i++) {
      state('bo', bo, { x: bo.state.x - 0.2, y: bo.state.y, z: target.z });
      assert.notEqual(homeAt(bo.state.x, bo.state.z, bo.state.y), home.id, `${home.id}: kept out on foot`);
    }
  }
});

test('out is always granted: on the ground and at 80 m, from any seat; afterwards the budgets are walking\'s again', () => {
  const s = setup();
  const { game, h, put, state, ask } = s;
  const [pia, bo, cas] = crew(s, ['pia', 'bo', 'cas']);
  ask('cas', cas, { t: 'heli', op: 'out' });
  assert.equal(game.helis.of('cas'), null, 'out on the pad');
  put({ x: -60, y: floor(-60, -60) + 80, z: -60 });
  ask('bo', bo, { t: 'heli', op: 'out' });
  assert.equal(game.helis.of('bo'), null, 'out at 80 m, as a passenger');
  assert.ok(Math.abs(bo.state.y - h.y) < 1e-9, 'where the machine is');
  ask('pia', pia, { t: 'heli', op: 'out' });
  assert.equal(game.helis.of('pia'), null, 'and as the pilot');
  assert.equal(pia.drop, null, 'an out is no jump: no parachute');
  // A forged 60 m step half a second later: running pace.
  const x0 = pia.state.x;
  state('pia', pia, { x: x0 + 60 }, 500);
  assert.ok(pia.state.x - x0 < 3, `${(pia.state.x - x0).toFixed(2)} m on foot`);
  // A repeated out: nothing.
  const n = s.told.length;
  ask('pia', pia, { t: 'heli', op: 'out' });
  assert.equal(s.told.length, n);
});

test('fly: from a passenger seat, only with nobody at the stick and alive; two at once: one gets it', () => {
  const s = setup();
  const { game, h, ask, player } = s;
  const [pia, bo, cas] = crew(s, ['pia', 'bo', 'cas']);
  ask('bo', bo, { t: 'heli', op: 'fly' });
  assert.deepEqual(h.seats, ['pia', 'bo', 'cas', null], 'refused with a pilot aboard');
  const out = player('out', s.local(1.5, 0));
  ask('out', out, { t: 'heli', op: 'fly' });
  assert.equal(game.helis.of('out'), null, 'refused from outside');
  ask('pia', pia, { t: 'heli', op: 'out' });
  bo.alive = false;
  ask('bo', bo, { t: 'heli', op: 'fly' });
  assert.equal(h.seats[0], null, 'refused when dead');
  bo.alive = true;
  ask('bo', bo, { t: 'heli', op: 'fly' });
  ask('cas', cas, { t: 'heli', op: 'fly' });
  assert.deepEqual(h.seats, ['bo', null, 'cas', null], 'the first ask flies, the second finds the stick taken');
});

test('a pilot whose connection closes high up: the machine hangs still; after 20 s everyone is out and it is home', () => {
  const s = setup();
  const { game, h, put, now, at } = s;
  const handlers = {};
  const [pia, bo] = crew(s, ['pia', 'bo']);
  pia.ws = { name: 'pia', on: (ev, fn) => (handlers[ev] = fn) };
  game.joined(pia.ws, 'pia', pia);
  const high = { x: -60, y: floor(-60, -60) + 60, z: -60 };
  put(high);
  handlers.close();
  assert.equal(game.players.has('pia'), false);
  assert.deepEqual(h.seats, [null, 'bo', null, null]);
  assert.ok(Math.abs(game.lastPos.get('pia').y - floor(h.x, h.z)) < 1e-9, 'its last place is on the ground under the machine');
  game.helis.tick(now());
  at(PILOTLESS_MS - 1000);
  game.helis.tick(now());
  assert.deepEqual([h.x, h.y, h.z, h.seats[1]], [high.x, high.y, high.z, 'bo'], 'no motion without a pilot, nobody put out yet');
  at(1000);
  game.helis.tick(now());
  assert.equal(game.helis.of('bo'), null, 'the passenger is out');
  assert.ok(Math.abs(bo.state.y - high.y) < 1e-9, 'where the machine was');
  assert.ok(game.dropping(bo, now()), 'by parachute');
  assert.deepEqual([h.x, h.y, h.z], [PARK.x, PARK.y, PARK.z], 'home');
  assert.equal(s.told.at(-1).home, 1);
});

test('a pilot whose connection closes on the ground: the machine stays, the passengers stay', () => {
  const s = setup();
  const { game, h, put, now, at } = s;
  const handlers = {};
  const [pia] = crew(s, ['pia', 'bo']);
  pia.ws = { name: 'pia', on: (ev, fn) => (handlers[ev] = fn) };
  game.joined(pia.ws, 'pia', pia);
  put({ x: -60, y: floor(-60, -60), z: -60 });
  handlers.close();
  at(PILOTLESS_MS + 5000);
  game.helis.tick(now());
  assert.deepEqual([h.x, h.seats[1]], [-60, 'bo']);
});

test('flights home: empty on a start place after 20 s, in a field after 5 minutes, never from its pad, not onto someone', () => {
  const s = setup();
  const { game, h, put, now, at, told } = s;
  const homes = () => told.filter((m) => m.home).length;
  // On a start place.
  put({ x: SPAWNS[0].x, y: SPAWNS[0].y, z: SPAWNS[0].z });
  game.helis.inner.get(ID).emptyAt = now();
  at(IN_THE_WAY_MS - 1000);
  game.helis.tick(now());
  assert.equal(homes(), 0);
  at(1000);
  game.helis.tick(now());
  assert.equal(homes(), 1);
  assert.deepEqual([h.x, h.z], [PARK.x, PARK.z]);
  // On its pad: never.
  at(IDLE_MS * 3);
  game.helis.tick(now());
  assert.equal(homes(), 1);
  // In a field.
  put({ x: -60, y: floor(-60, -60), z: -60 });
  game.helis.inner.get(ID).emptyAt = now();
  at(IN_THE_WAY_MS + 1000);
  game.helis.tick(now());
  assert.equal(homes(), 1, 'a field is in nobody\'s way');
  at(IDLE_MS - IN_THE_WAY_MS);
  // Somebody on its park spot: it waits.
  const anna = s.player('anna', { x: PARK.x + 2, y: PARK.y, z: PARK.z });
  game.helis.tick(now());
  assert.equal(homes(), 1, 'it waits for the spot');
  anna.state.x = PARK.x + 20;
  game.helis.tick(now());
  assert.equal(homes(), 2);
});

test('Zombies, the party games and the teams: no boarding, and a game starting empties every machine and sends it home', () => {
  for (const kind of ['hide', 'tag', 'treasure', 'teams', 'zombies']) {
    const s = setup();
    const { game, h, put, now, ask, sent } = s;
    const [pia, bo] = crew(s, ['pia', 'bo']);
    put({ x: -60, y: floor(-60, -60) + 30, z: -60 });
    if (kind === 'zombies') game.modes.state = { kind: 'zombies', phase: 'wave', z: { stop: () => {} } };
    else game.modes.start(kind, 'pia');
    assert.equal(game.fenced(), true, kind);
    game.helis.tick(now());
    assert.deepEqual(h.seats, [null, null, null, null], `${kind}: everyone out`);
    assert.deepEqual([h.x, h.z], [PARK.x, PARK.z], `${kind}: home`);
    const eve = s.player('eve', s.local(1.5, -0.4));
    ask('eve', eve, { t: 'heli', op: 'in', id: ID });
    assert.equal(game.helis.of('eve'), null);
    assert.equal(sent.get('eve').at(-2).code, kind === 'zombies' ? 'zNoHeli' : 'gameNoHeli', kind);
    void pia;
    void bo;
  }
});

test('the admin\'s rule off: nobody boards, everyone aboard is put out, the machines go home', () => {
  const s = setup();
  const { game, h, put, now, ask, sent } = s;
  crew(s, ['pia', 'bo']);
  put({ x: -60, y: floor(-60, -60) + 30, z: -60 });
  const admin = s.player('admin', { x: 0, y: 0, z: 0 }, 'admin');
  const rook = s.player('rook', { x: 0, y: 0, z: 0 });
  s.send('rook', rook, { t: 'rules', heli: false });
  assert.equal(game.rules.heli, true, 'only the admin sets the rules');
  s.send('admin', admin, { t: 'rules', heli: 'off' });
  assert.equal(game.rules.heli, true, 'only a boolean');
  s.send('admin', admin, { t: 'rules', heli: false });
  assert.equal(game.rules.heli, false);
  game.helis.tick(now());
  assert.deepEqual(h.seats, [null, null, null, null]);
  assert.deepEqual([h.x, h.z], [PARK.x, PARK.z]);
  const eve = s.player('eve', s.local(1.5, -0.4));
  ask('eve', eve, { t: 'heli', op: 'in', id: ID });
  assert.equal(sent.get('eve').at(-2).code, 'heliOff');
  s.send('admin', admin, { t: 'rules', heli: true });
  ask('eve', eve, { t: 'heli', op: 'in', id: ID });
  assert.equal(game.helis.of('eve'), h);
});

test('aboard is out of every fight: no hit lands on or comes from a seat, a blast skips them, every refused type changes nothing', () => {
  const s = setup();
  const { game, h, told, send } = s;
  const [pia, bo] = crew(s, ['pia', 'bo']);
  const foe = s.player('foe', s.local(6, 0));
  for (const p of [pia, bo, foe]) p.weapons.add('rifle');
  send('foe', foe, { t: 'hit', target: 'bo', w: 'pistol', body: 1, head: 0 });
  send('bo', bo, { t: 'hit', target: 'foe', w: 'pistol', body: 1, head: 0 });
  assert.deepEqual([bo.hp, foe.hp], [100, 100]);
  game.blast('foe', { x: h.x, y: h.y + 1, z: h.z }, 'grenade');
  assert.deepEqual([pia.hp, bo.hp], [100, 100], 'a blast skips those aboard');
  // Every refused type, from the pilot and from a passenger, with whatever it could carry: nothing is told.
  for (const t of HELI_REFUSED) {
    for (const [name, p] of [['pia', pia], ['bo', bo]]) {
      const n = told.length;
      p.nextCar = 0;
      send(name, p, { t, op: 'in', id: Object.keys(game.cars)[0], target: 'foe', w: 'pistol', body: 1, head: 0, i: 0, x: h.x, y: h.y, z: h.z, to: 'church', kind: 'claymore', ids: [0] });
      assert.equal(told.length, n, `${t} from ${name}`);
    }
  }
  assert.equal(game.carOf('pia'), null);
  assert.equal(game.helis.of('pia'), h, 'still aboard');
  assert.equal(foe.hp, 100);
  // Landing on somebody, or flying through them: the server links no machine to any harm.
  for (let i = 0; i < 10; i++) s.state('pia', pia, { x: foe.state.x, y: foe.state.y + 0.5 - i * 0.05, z: foe.state.z });
  assert.deepEqual([foe.hp, foe.alive], [100, true]);
});

test('every type Game.handle reads is sorted: refused from a seat or let through', () => {
  const start = GAME_SRC.indexOf('  handle(name, player, raw) {');
  const end = GAME_SRC.indexOf('\n  }\n', start);
  const types = new Set([...GAME_SRC.slice(start, end).matchAll(/m\.t === '([a-z]+)'/g)].map((x) => x[1]));
  assert.ok(types.size > 40, `${types.size} types`);
  for (const t of types) assert.ok(HELI_REFUSED.has(t) !== ALLOWED.includes(t), `${t}: in exactly one list`);
  for (const t of HELI_REFUSED) assert.equal(ALLOWED.includes(t), false, t);
});

test('travel from a seat: refused with its own code', () => {
  const s = setup();
  const { game, sent, send } = s;
  const [pia] = crew(s, ['pia']);
  send('pia', pia, { t: 'travel', to: 'church', via: 'chat' });
  const no = sent.get('pia').at(-1);
  assert.deepEqual([no.t, no.ok, no.code], ['travel', false, 'travelHeli']);
  assert.equal(game.helis.of('pia')?.id, ID);
});

test('a late joiner sees the machines in welcome; the tick carries them, and a page reads them back', () => {
  const s = setup();
  const { game, h, put, state } = s;
  const [pia] = crew(s, ['pia', 'bo']);
  put({ x: -50, y: 12, z: -20, yaw: 1 });
  state('pia', pia, { x: -51, y: 12.5, z: -20, yaw: 1, hp: 0.1, hr: 0.2, hn: 1, hg: 0 });
  const w = game.welcome(pia, 'pia', '#fff', s.now());
  // Every machine of heli.json, in its order; the one flown as it flies, the others on their pads.
  assert.deepEqual(w.helis.map((q) => q.id), DATA.machines.map((d) => d.id));
  assert.deepEqual(w.helis.find((q) => q.id === ID), { id: ID, x: h.x, y: h.y, z: h.z, yaw: h.yaw, p: 0.1, r: 0.2, n: 1, g: 0, seats: ['pia', 'bo', null, null] });
  for (const d of DATA.machines.filter((q) => q.id !== ID)) {
    assert.deepEqual(w.helis.find((q) => q.id === d.id), { id: d.id, x: d.park.x, y: d.park.y, z: d.park.z, yaw: d.park.yaw, p: 0, r: 0, n: 0, g: 1, seats: [null, null, null, null] });
  }
  for (const q of w.helis) assert.equal(Object.hasOwn(q, 'trail'), false, 'nothing the server keeps for itself');
  let out = '';
  const late = s.player('late', { x: 0, y: 0, z: 0 });
  late.ws = { name: 'late', OPEN: 1, readyState: 1, send: (t) => (out = t) };
  late.full = true;
  for (const p of game.players.values()) if (p !== late) p.ws = { ...p.ws, OPEN: 1, readyState: 0 };
  game.snapshot(s.now());
  const tick = JSON.parse(out);
  assert.deepEqual(tick.e.map((q) => q[0]), DATA.machines.map((d) => d.id), 'a page that just connected gets every machine');
  const e = readHeli(tick.e.find((q) => q[0] === ID));
  assert.deepEqual({ ...e, age: 0 }, { ...readHeli([ID, 0, ...heliFields(h)]), age: 0 });
  assert.deepEqual(e.seats, ['pia', 'bo', null, null]);
  assert.equal(e.x, -51);
});

test('the gate: two heli messages 100 ms apart count once; a room refuses heli messages and has no machines', () => {
  const s = setup();
  const { game, player, send } = s;
  const anna = player('anna');
  anna.nextCar = 0;
  send('anna', anna, { t: 'heli', op: 'in', id: ID });
  s.at(100);
  send('anna', anna, { t: 'heli', op: 'out' });
  assert.equal(game.helis.of('anna')?.id, ID, 'the second waited for the gate');
  const room = new Game({ session: () => null, store: { addStats: async () => {} } }, [], { id: 'r1', owner: 'anna', arena: { id: 'house' }, max: 4, edge: game.fence() });
  for (const t of room.timers) clearInterval(t);
  assert.equal(room.helis.machines.size, 0);
  assert.deepEqual(room.helis.view(), []);
});

test('the fix: a step the server shortened by more than 3 m tells the pilot once a second, nobody else', () => {
  const s = setup();
  const { h, put, state, sent, told } = s;
  const [pia] = crew(s, ['pia', 'bo']);
  put({ x: -60, y: 30, z: -60 });
  const n = told.length;
  state('pia', pia, { x: h.x + 2, y: h.y, z: h.z });
  assert.equal(sent.get('pia').filter((m) => m.fix).length, 0, 'an honest step: no fix');
  state('pia', pia, { x: h.x + 80, y: h.y, z: h.z });
  const taken = h.x;
  state('pia', pia, { x: h.x + 80, y: h.y, z: h.z });
  const fixes = sent.get('pia').filter((m) => m.fix);
  assert.equal(fixes.length, 1, 'once a second');
  assert.deepEqual([fixes[0].heli.x, fixes[0].heli.seats[0]], [taken, 'pia'], 'the server\'s pose');
  assert.equal(sent.get('bo').filter((m) => m.fix).length, 0, 'not the passenger');
  assert.equal(told.length, n, 'not the others');
});

test('dying, respawning or being gathered empties the seat; the leaderboard can ask who is aboard', () => {
  const s = setup();
  const { game, h } = s;
  const [pia, bo, cas] = crew(s, ['pia', 'bo', 'cas']);
  assert.equal(game.helis.of('pia'), h);
  assert.equal(game.helis.of('nobody'), null);
  assert.equal(game.helis.of(undefined), null);
  game.respawn('pia', pia, s.now());
  assert.equal(game.helis.of('pia'), null);
  game.gather(['bo']);
  assert.equal(game.helis.of('bo'), null);
  game.zombieHurt('cas', cas, 1000, true, s.now());
  game.bruteHits({ x: cas.state.x, y: cas.state.y, z: cas.state.z }, 5, 1000, s.now());
  assert.deepEqual([cas.alive, cas.hp], [true, 100], 'zombies and strongmen can\'t hurt someone aboard (they ask inCar first)');
  game.damage('foe', { score: { kills: 0, points: 0 } }, 'cas', cas, 1000, false, 'pistol', s.now());
  assert.equal(game.helis.of('cas'), null, 'a death empties the seat');
  void bo;
});

test('two machines, each with its own pad: the church\'s on its deck; one on another\'s pad goes home after 20 s; one sent home first sends the one on its pad to its own, or waits', () => {
  const s = setup();
  const { game, h, put, now, at, told, state } = s;
  assert.equal(DATA.machines.length, 2, 'the house\'s machine and the church\'s');
  const ch = game.helis.machines.get('church');
  const CH = DATA.machines.find((d) => d.id === 'church').park;
  assert.deepEqual([ch.x, ch.y, ch.z, ch.yaw], [CH.x, CH.y, CH.z, CH.yaw]);
  assert.equal(game.helis.atPad(ch), true);
  // The house's machine left on the church's deck: away, it goes home once it has stood empty there 20 s.
  put({ x: CH.x, y: CH.y, z: CH.z, yaw: CH.yaw });
  assert.equal(game.helis.atPad(h), false, 'another machine\'s pad is not its own');
  ch.x += 30; // the church's machine is elsewhere meanwhile
  game.helis.inner.get(ID).emptyAt = now();
  at(IN_THE_WAY_MS - 1000);
  game.helis.tick(now());
  assert.deepEqual([h.x, h.z], [CH.x, CH.z]);
  at(1000);
  game.helis.tick(now());
  assert.deepEqual([h.x, h.z], [PARK.x, PARK.z], 'home after 20 s');
  // The house's machine back on the church's deck, the church's sent home: the house's goes to its own pad first.
  put({ x: CH.x, y: CH.y, z: CH.z, yaw: CH.yaw });
  const before = told.length;
  assert.equal(game.helis.home(ch, now(), true), true);
  assert.deepEqual([h.x, h.z, ch.x, ch.z], [PARK.x, PARK.z, CH.x, CH.z]);
  assert.deepEqual(told.slice(before).map((m) => m.heli.id), [ID, 'church'], 'everyone is told both');
  // Each on the other's pad: they swap.
  Object.assign(h, { x: CH.x, y: CH.y, z: CH.z });
  Object.assign(ch, { x: PARK.x, y: PARK.y, z: PARK.z });
  assert.equal(game.helis.home(ch, now(), true), true);
  assert.deepEqual([h.x, h.z, ch.x, ch.z], [PARK.x, PARK.z, CH.x, CH.z]);
  // Somebody aboard the one on its pad: it waits.
  const [pia] = crew(s, ['pia']);
  put({ x: CH.x, y: CH.y, z: CH.z, yaw: CH.yaw });
  state('pia', pia, { x: CH.x, y: CH.y, z: CH.z, yaw: CH.yaw });
  ch.x += 30;
  assert.equal(game.helis.home(ch, now(), true), false, 'it waits while the other is flown');
  assert.equal(ch.x, CH.x + 30);
});

test('nobody lands on a parked machine: a step onto the other\'s cabin is put back; beside it the flight goes on', () => {
  const s = setup();
  const { game, h, state, put } = s;
  const [pia] = crew(s, ['pia']);
  const ch = game.helis.machines.get('church');
  put({ x: ch.x, y: ch.y + 6, z: ch.z, yaw: ch.yaw });
  state('pia', pia, { x: ch.x, y: ch.y + 6, z: ch.z, yaw: ch.yaw }, 200);
  state('pia', pia, { x: ch.x, y: ch.y + 3, z: ch.z, yaw: ch.yaw }, 400);
  assert.ok(h.y >= ch.y + 6 - 1e-9, `held off at ${h.y - ch.y} m over it`);
  state('pia', pia, { x: ch.x + 4, y: ch.y + 5, z: ch.z, yaw: ch.yaw }, 1000);
  assert.ok(Math.abs(h.x - (ch.x + 4)) < 1e-9, 'beside it the step is taken');
});

// The jump together (package D): the use key in the air, pilot or passenger, asks `jump`; the seat is emptied as on
// `out`, and a drop starts only from the machine's own pose, DROP.jumpMin or more over the server's floor, off the pad,
// with the parachute rule on and the jumper alive. The message carries no position.

const DROP_SPEED = DROP.across * 1.3; // m/s across in a drop (game.mjs)
const JUMP = { t: 'heli', op: 'jump' };
const spawns = (s, name) => s.sent.get(name).filter((m) => m.t === 'spawn');

/** `names` aboard (seat 0 first), the machine `up` m over the server's floor at (-60, -60). */
function aloft(s, names, up) {
  const ps = crew(s, names);
  s.put({ x: -60, y: floor(-60, -60) + up, z: -60, yaw: 0.4 });
  return ps;
}

test('a jump on the ground or on its pad: a plain out, no drop, no spawn', () => {
  const s = setup();
  const { game, h, ask } = s;
  const [pia] = crew(s, ['pia']);
  ask('pia', pia, JUMP);
  assert.equal(game.helis.of('pia'), null, 'out');
  assert.equal(pia.drop, null);
  assert.equal(spawns(s, 'pia').length, 0);
  assert.equal(h.seats[0], null);
  // At 80 m, but where its pad is (a test pad at that height): a plain out too.
  const t = setup();
  const [bo] = crew(t, ['bo']);
  const y = floor(PARK.x, PARK.z) + 80;
  t.game.helis.inner.get(ID).park = { ...PARK, y };
  t.put({ x: PARK.x, y, z: PARK.z });
  assert.equal(t.game.helis.atPad(t.h), true);
  t.ask('bo', bo, JUMP);
  assert.deepEqual([t.game.helis.of('bo'), bo.drop, spawns(t, 'bo').length], [null, null, 0], 'no drop at a pad');
});

test('the lowest jump is the solo jump\'s DROP.jumpMin over the server\'s floor: under it an out, over it a drop from the machine', () => {
  const low = setup();
  const [pia] = aloft(low, ['pia', 'bo'], DROP.jumpMin - 1);
  low.ask('pia', pia, JUMP);
  assert.deepEqual([low.game.helis.of('pia'), pia.drop, spawns(low, 'pia').length], [null, null, 0], 'a metre too low: out');
  const s = setup();
  const { game, h, ask, told } = s;
  const order = [];
  const [b, d] = [game.broadcast, game.send];
  game.broadcast = (m, e) => (order.push(`all:${m.t}`), b(m, e));
  game.send = (ws, m) => (order.push(`${ws.name}:${m.t}`), d(ws, m));
  const [, cas] = aloft(s, ['bo', 'cas'], DROP.jumpMin + 1);
  order.length = 0;
  ask('cas', cas, JUMP);
  assert.equal(game.helis.of('cas'), null, 'out of the seat');
  assert.ok(cas.drop && game.dropping(cas, s.now()), 'a drop');
  assert.ok(Math.abs(cas.drop.top - (h.y + 0.5)) < 1e-9, 'its ceiling 0.5 m over the machine');
  const sp = spawns(s, 'cas');
  assert.equal(sp.length, 1);
  const r = (v) => Math.round(v * 100) / 100;
  assert.deepEqual([sp[0].ok, sp[0].drop, sp[0].sx, sp[0].sy, sp[0].sz, sp[0].x, sp[0].z], [true, 1, r(h.x), r(h.y), r(h.z), r(h.x), r(h.z)]);
  assert.deepEqual([cas.state.x, cas.state.y, cas.state.z], [h.x, h.y, h.z], 'the drop starts where the machine is');
  assert.equal(spawns(s, 'bo').length, 0, 'to the jumper only');
  assert.ok(!told.some((m) => m.t === 'spawn'), 'nobody else is told');
  assert.deepEqual(order, ['all:heli', 'cas:spawn'], 'the seat first, then the drop');
  assert.deepEqual(h.seats, ['bo', null, null, null]);
});

test('no drop with the parachute rule off, nor for a dead player: a plain out at any height', () => {
  const s = setup();
  const [pia, bo] = aloft(s, ['pia', 'bo'], 90);
  s.game.rules.parachute = false;
  s.ask('bo', bo, JUMP);
  assert.deepEqual([s.game.helis.of('bo'), bo.drop, spawns(s, 'bo').length], [null, null, 0], 'rule off');
  s.game.rules.parachute = true;
  pia.alive = false;
  s.ask('pia', pia, JUMP);
  assert.deepEqual([s.game.helis.of('pia'), pia.drop, spawns(s, 'pia').length], [null, null, 0], 'dead');
});

test('a jump twice, a replay, and a jump from someone not aboard change nothing', () => {
  const s = setup();
  const { game, h, ask, told } = s;
  const [pia, bo] = aloft(s, ['pia', 'bo'], 60);
  ask('bo', bo, JUMP);
  const drop = bo.drop;
  const n = told.length;
  ask('bo', bo, JUMP);
  assert.equal(told.length, n, 'nothing told');
  assert.equal(bo.drop, drop, 'the same drop');
  assert.equal(spawns(s, 'bo').length, 1, 'one spawn');
  const eve = s.player('eve', s.local(1.5, -0.4));
  ask('eve', eve, JUMP);
  assert.deepEqual([eve.drop, spawns(s, 'eve').length, told.length], [null, 0, n], 'not aboard: nothing');
  // Within the 300 ms gate a jump is never read (the gate shared with the cars).
  s.send('pia', pia, JUMP); // pia's boarding was read just now
  assert.equal(game.helis.of('pia'), h, 'the pilot still flies');
});

test('after a jump the drop\'s own budgets from its first state: never up past its allowance, across at the skydive\'s pace, no hover, no hit', () => {
  const s = setup();
  const { game, state, ask } = s;
  const [pia] = aloft(s, ['pia'], 60);
  ask('pia', pia, JUMP);
  const y0 = pia.state.y, x0 = pia.state.x;
  // A burst of forged climbs at once: at most the drop's 0.6 m in all.
  for (let i = 0; i < 10; i++) state('pia', pia, { y: pia.state.y + 5, pc: 1 }, 0);
  assert.ok(pia.state.y - y0 <= 0.6 + 1e-9, `${(pia.state.y - y0).toFixed(2)} m up at once`);
  // A second of them: the 0.6 m and its refill of 0.5 m/s, never the flight's climb (in the drop's first moments neither).
  for (let i = 0; i < 20; i++) state('pia', pia, { y: pia.state.y + 5, pc: 1 }, 50);
  assert.ok(pia.state.y - y0 <= 0.6 + 0.5 + 1e-9, `${(pia.state.y - y0).toFixed(2)} m up in 1 s`);
  // Across: 60 m a state asked, for 2 s: at most DROP_SPEED a second and its 8.3 m stored.
  const t0 = s.now() - 1000;
  for (let i = 0; i < 40; i++) {
    state('pia', pia, { x: pia.state.x + 60, y: pia.state.y - 0.5, pc: 1 }, 50);
    const t = (s.now() - t0) / 1000;
    assert.ok(pia.state.x - x0 <= DROP_SPEED * t + 8.3 + 1e-9, `${(pia.state.x - x0).toFixed(1)} m across at ${t.toFixed(2)} s`);
  }
  // A hit on the jumper does not land (calm); the same shot at someone beside them on foot does.
  const foe = s.player('foe', { x: pia.state.x + 4, y: pia.state.y, z: pia.state.z });
  const eve = s.player('eve', { x: pia.state.x + 8, y: pia.state.y, z: pia.state.z });
  s.send('foe', foe, { t: 'hit', target: 'pia', w: 'pistol', body: 1, head: 0 });
  assert.equal(pia.hp, 100, 'no hit in a drop');
  foe.nextHit = 0;
  s.send('foe', foe, { t: 'hit', target: 'eve', w: 'pistol', body: 1, head: 0 });
  assert.ok(eve.hp < 100, 'the control: the same shot lands outside a drop');
  // A forged hover: the drop ends by the end of the next stretch dropCheck measures (DROP.hoverMs each).
  for (let i = 0; i < (2 * DROP.hoverMs) / 50 && pia.drop; i++) state('pia', pia, { pc: 1 }, 50);
  assert.equal(pia.drop, null, 'nobody hovers');
  assert.equal(game.dropping(pia, s.now()), false);
});

test('a jumper steered into each code-locked home from above is stopped at its bands', () => {
  for (const home of HOMES) {
    for (const [bi, band] of home.bands.entries()) {
      const target = insidePoint(home, band);
      const s = setup();
      const { game, state, ask, put } = s;
      game.homes = { granted: () => false };
      const [pia] = crew(s, ['pia']);
      const top = Math.max(...home.bands.map((q) => q.y1));
      const y = Math.max(top, floor(target.x, target.z)) + DROP.jumpMin + 8;
      put({ x: target.x, y, z: target.z, yaw: 0 });
      ask('pia', pia, JUMP);
      assert.ok(pia.drop, `${home.id}/${bi}: a drop`);
      for (let i = 0; i < 200; i++) {
        state('pia', pia, { x: target.x, y: pia.state.y - 0.5, z: target.z, pc: 1 }, 50);
        assert.equal(homeAt(pia.state.x, pia.state.z, pia.state.y), null, `${home.id}/${bi}: never inside (${pia.state.y.toFixed(2)})`);
      }
    }
  }
});

test('the pilot jumps at 60 m with two aboard: the machine stays, a passenger may fly it; nobody does and after 20 s both float down', () => {
  for (const takes of [true, false]) {
    const s = setup();
    const { game, h, ask, state, at, now, sent } = s;
    const [pia, bo, cas] = aloft(s, ['pia', 'bo', 'cas'], 60);
    const pose = [h.x, h.y, h.z, h.yaw];
    ask('pia', pia, JUMP);
    assert.ok(pia.drop, 'the pilot has a drop');
    assert.deepEqual(h.seats, [null, 'bo', 'cas', null], 'the passengers keep their seats');
    state('bo', bo, { x: h.x + 20, y: h.y + 5 }, 200);
    assert.deepEqual([h.x, h.y, h.z, h.yaw], pose, 'no pilot, no motion');
    if (takes) {
      ask('bo', bo, { t: 'heli', op: 'fly' });
      assert.equal(h.seats[0], 'bo', 'bo takes the stick');
      state('bo', bo, { x: h.x + 2, y: h.y, z: h.z, yaw: h.yaw }, 200);
      assert.ok(Math.abs(h.x - (pose[0] + 2)) < 1e-9, 'and flies it');
      at(PILOTLESS_MS + 1000);
      game.helis.tick(now());
      assert.deepEqual(h.seats, ['bo', null, 'cas', null], 'with a pilot nobody is put out');
      continue;
    }
    at(PILOTLESS_MS - 700);
    game.helis.tick(now());
    assert.deepEqual(h.seats, [null, 'bo', 'cas', null], 'not yet');
    at(500);
    game.helis.tick(now());
    for (const p of [bo, cas]) {
      assert.ok(game.dropping(p, now()), 'by parachute');
      assert.ok(Math.abs(p.state.y - pose[1]) < 1e-9, 'from where it hung');
    }
    for (const n of ['bo', 'cas']) {
      assert.equal(spawns(s, n).at(-1).sy, Math.round(pose[1] * 100) / 100);
      assert.equal(sent.get(n).filter((m) => m.t === 'system' && m.code === 'heliOut').length, 1, 'one line in the chat');
    }
    assert.equal(sent.get('pia').filter((m) => m.code === 'heliOut').length, 0, 'not for the one who jumped');
    assert.deepEqual([h.x, h.y, h.z, h.seats.every((n) => !n)], [PARK.x, PARK.y, PARK.z, true], 'home, empty');
  }
});

test('the helicopter rule switched off at 60 m: everyone aboard floats down', () => {
  const s = setup();
  const { game, h, now } = s;
  const ps = aloft(s, ['pia', 'bo', 'cas'], 60);
  const y = h.y;
  game.rules.heli = false;
  game.helis.tick(now());
  for (const p of ps) {
    assert.ok(game.dropping(p, now()), 'a drop');
    assert.ok(Math.abs(p.state.y - y) < 1e-9);
  }
  assert.deepEqual([h.x, h.z], [PARK.x, PARK.z], 'and it is home');
});
