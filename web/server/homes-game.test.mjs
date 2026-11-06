import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';
import { homeAt, homeOfDoor } from '../shared/homes.mjs';
import { PORTALS } from '../shared/portals.mjs';
import { house, HAVE_PRIVATE, packs, SKIP } from '../shared/testData.mjs';

// The game server's side of the three code-locked homes (server/homeGate.mjs): doors, panes and standing inside.
function setup() {
  const game = new Game({ session: () => null }, []);
  const sent = [];
  game.send = (_ws, m) => sent.push(m);
  const told = [];
  game.broadcast = (m) => told.push(m);
  const grants = new Set(); // `${key}|${home}`
  game.homes = { granted: (key, id) => grants.has(`${key}|${id}`) };
  const player = (name, x, z, role = 'player') => {
    const p = {
      key: `k-${name}`, role, got: [], ws: { readyState: 1, OPEN: 1, send(d) { p.got.push(JSON.parse(d)); } }, alive: true, state: { x, y: 0, z, yaw: 0, pitch: 0, armed: false, flying: false, w: 'pistol', c: false },
      budget: 100, vbudget: 100, movedAt: Date.now(), warp: 0, stamp: 0, weapons: new Set(['pistol']), nades: [], window: Date.now(), msgs: 0, states: 0, others: 0,
    };
    game.players.set(name, p);
    return p;
  };
  const send = (name, p, m) => game.handle(name, p, JSON.stringify(m));
  const step = (name, p, x, z, y = 0) => {
    p.budget = p.vbudget = 100;
    p.movedAt = Date.now() - 1000;
    p.states = 0;
    send(name, p, { t: 'state', x, y, z, yaw: 0, pitch: 0 });
  };
  return { game, sent, told, grants, player, send, step };
}

test('doors of the three homes: only with the right, and nothing is told to the others without it', () => {
  const { game, told, grants, player, send } = setup();
  const a = player('a', 0, 30);
  const b = player('b', 0, 30);
  const admin = player('root', 0, 30, 'admin');
  const door = (p, name, id) => {
    p.nextDoor = 0;
    send(name, p, { t: 'door', id, open: true, dir: 1 });
  };
  const ids = ['house-out-0', 'bungalow-out-0', 'mh-end-front'];
  for (const id of ids) {
    assert.ok(homeOfDoor(id), id);
    door(a, 'a', id);
  }
  assert.equal(told.length + admin.got.length + b.got.length, 0, 'ignored and not sent');
  assert.deepEqual(Object.keys(game.doors), [], 'not even remembered');
  grants.add('k-a|house');
  door(a, 'a', 'house-out-0');
  door(a, 'a', 'bungalow-out-0');
  assert.deepEqual(admin.got.map((m) => m.id), ['house-out-0'], 'the grant is for that one home; the admin hears it');
  assert.equal(b.got.length, 0, 'another session has no grant: it is not told');
  door(admin, 'root', 'bungalow-out-0');
  assert.deepEqual(a.got.map((m) => m.id), [], 'and the grant of the house does not bring the bungalow\'s door states');
  door(b, 'b', 'some-other-door');
  assert.deepEqual(told.map((m) => m.id), ['some-other-door'], 'a door of no home goes to everyone (broadcast), as before');
  assert.deepEqual(Object.keys(game.doorsFor(b)), ['some-other-door'], 'the welcome of a page without the right lists no home door');
  assert.deepEqual(Object.keys(game.doorsFor(a)).sort(), ['house-out-0', 'some-other-door']);
  assert.equal(Object.keys(game.doorsFor(admin)).length, 3);
});

test('the inside of a home is never sent to a session without its right: doors, panes, furniture', { skip: SKIP }, () => {
  const { game, grants, player, send, sent } = setup();
  const a = player('a', 0, 30); // no right
  const c = player('c', 0, 30); // the main house's right
  const admin = player('root', 0, 30, 'admin');
  const insideDoor = packs.find((p) => p.id === 'house').doors[0].id;
  const insidePane = packs.find((p) => p.id === 'house').prisms.find((p) => p.m === 'glass')?.glass
    ?? packs.find((p) => p.id === 'house').doors.flatMap((d) => d.panels).find((p) => p.glassNo)?.glassNo;
  assert.ok(Number.isInteger(insidePane));
  grants.add('k-c|house');
  c.nextDoor = 0;
  send('c', c, { t: 'door', id: insideDoor, open: true, dir: 1 });
  send('c', c, { t: 'glass', i: insidePane });
  assert.ok(game.broken.has(insidePane));
  assert.deepEqual(a.got, [], 'nothing about the inside reaches a session without the right');
  assert.deepEqual(admin.got.map((m) => m.t).sort(), ['door', 'glass']);
  // The welcome and a later furniture list: the pieces inside are held back.
  game.furniture.set(1, { id: 1, item: 'sofa', x: 4.5, y: 3.05, z: 5.5, yaw: 0 }); // on the first floor
  game.furniture.set(2, { id: 2, item: 'sofa', x: 4.5, y: -0.1, z: 19, yaw: 0 }); // in the street
  assert.deepEqual(game.furnitureFor(a).map((f) => f.id), [2]);
  assert.deepEqual(game.furnitureFor(c).map((f) => f.id), [1, 2]);
  assert.deepEqual(game.furnitureFor(admin).map((f) => f.id), [1, 2]);
  assert.deepEqual(game.brokenFor(a), []);
  assert.deepEqual(game.brokenFor(c), [insidePane]);
  assert.deepEqual(Object.keys(game.doorsFor(a)), []);
  // A piece placed inside by a session without the right is refused.
  a.state.x = 4.5;
  a.state.z = 5.5;
  a.state.y = 3.05;
  assert.equal(game.spawnSpot(a, { x: 4.5, y: 3.05, z: 5.5 }), null, 'no spawning into the main house');
  c.state.x = 4.5;
  c.state.z = 5.5;
  c.state.y = 3.05;
  assert.ok(game.spawnSpot(c, { x: 4.5, y: 3.05, z: 5.5 }), 'with the right it is allowed');
  // A right given later: the page is told the state of the inside once.
  const before = game.send.length;
  game.homeGranted('k-a', 'house');
  const msg = sent.at(-1);
  assert.equal(msg.t, 'inside');
  assert.deepEqual(msg.doors, { [insideDoor]: true });
  assert.deepEqual(msg.broken, [insidePane]);
  assert.deepEqual(msg.furniture.map((f) => f.id), [1]);
  assert.ok(before >= 0);
});

test('without the private data a home has a shell only: no inside doors, no inside panes, nothing breaks', () => {
  assert.ok(house.doors.every((d) => /^(house-out|bungalow-out)-\d+$/.test(d.id)) || HAVE_PRIVATE);
});

test('walking into a home: held at the door without the right, free with it', () => {
  const { sent, grants, player, step } = setup();
  const a = player('a', 6, 14); // in front of the main house
  step('a', a, 6, 13);
  assert.equal(a.state.z, 13, 'outside is free');
  step('a', a, 6, 11.5);
  assert.equal(homeAt(6, 11.5, 0), 'house');
  assert.deepEqual([a.state.x, a.state.z], [6, 13], 'held where they were');
  assert.deepEqual(sent.at(-1), { t: 'homelock', id: 'house' }, 'the page is told');
  const n = sent.length;
  step('a', a, 6, 11.4);
  assert.equal(sent.length, n, 'told at most every second and a half');
  grants.add('k-a|house');
  step('a', a, 6, 11.5);
  assert.deepEqual([a.state.x, a.state.z], [6, 11.5], 'with the grant');
  step('a', a, 6, 9);
  assert.equal(a.state.z, 9);
});

test('a code revoked while somebody stands inside: they are put out, not frozen', () => {
  const { game, sent, grants, player, step } = setup();
  grants.add('k-a|bungalow');
  const a = player('a', 85, 188);
  assert.equal(homeAt(85, 188, 0), 'bungalow');
  step('a', a, 85.1, 188);
  assert.equal(homeAt(a.state.x, a.state.z, a.state.y), 'bungalow');
  grants.clear();
  a.nextHomeTell = 0;
  step('a', a, 85.2, 188);
  assert.equal(homeAt(a.state.x, a.state.z, a.state.y), null, 'out');
  const out = PORTALS.find((p) => p.id === 'bungalow').out;
  assert.deepEqual([a.state.x, a.state.z], [out[0], out[1]], 'where the portal brings you out, as the page does');
  assert.deepEqual(sent.at(-1), { t: 'homelock', id: 'bungalow' });
  assert.ok(game.gate.may(a, 'bungalow') === false);
});

test('the admin walks in without a code, and a car or a fast jump gets no way round', () => {
  const { player, step } = setup();
  const root = player('root', 4.5, 14, 'admin');
  step('root', root, 4.5, 11);
  assert.equal(root.state.z, 11);
  const a = player('a', 4.5, 14);
  step('a', a, 4.5, 2); // a jump straight through the house: the speed budget, the footprint and the edge all hold
  assert.equal(homeAt(a.state.x, a.state.z, a.state.y), null);
});

test('the server never respawns or rejoins a player inside a home they have no right to', () => {
  const { game, grants, player } = setup();
  const a = player('a', 4.5, 19);
  for (let k = 0; k < 60; k++) {
    game.respawn('a', a, Date.now());
    assert.equal(homeAt(a.state.x, a.state.z, a.state.y), null, `respawn ${k}`);
  }
  // The teams game: the bungalow's team has only rooms in the bungalow, so it starts outside as well.
  game.modes.teamOf = () => 'bungalow';
  for (let k = 0; k < 30; k++) {
    game.respawn('a', a, Date.now());
    assert.equal(homeAt(a.state.x, a.state.z, a.state.y), null, `team respawn ${k}`);
  }
  grants.add('k-a|bungalow');
  const seen = new Set();
  for (let k = 0; k < 200; k++) {
    game.respawn('a', a, Date.now());
    seen.add(homeAt(a.state.x, a.state.z, a.state.y));
  }
  assert.ok(!seen.has('bungalow'), 'the inside start places are not used: the team starts outside whoever has the right');
  assert.equal(game.gate.mayStand(a, 85, 0, 188), true);
  assert.equal(game.gate.mayStand(player('b', 0, 0), 85, 0, 188), false);
});

test('the roof terrace and the stair are free to walk, the first floor over the carport is not', () => {
  const { sent, player, step } = setup();
  const a = player('a', 1, -2.5);
  for (const [x, z, y] of [[1, -2, 1.2], [1, -1.4, 1.9], [1, -0.8, 2.4], [0.9, -0.2, 2.8], [0.9, 0.2, 2.95], [1, 1, 3.03], [2.5, 2, 3.03], [6, -1.5, 3.03]]) {
    Object.assign(a.state, { x, z, y }); // a step of the stair, then the terrace
    step('a', a, x + 0.1, z, y);
    assert.equal(a.state.x, x + 0.1, `free at ${x},${z},${y}`);
  }
  assert.equal(sent.length, 0, 'never told the home is locked');
  const b = player('b', 2, 11.9);
  b.state.y = 3.05; // up at the first floor's window over the carport: that is the main house
  step('b', b, 2, 11.2, 3.05);
  assert.equal(b.state.z, 11.9, 'held');
});

test('put out: on the ground at the portal, budgets reset, and the others see a jump', () => {
  const { grants, player, step } = setup();
  grants.add('k-a|house');
  const a = player('a', 6, 9);
  step('a', a, 6.1, 9);
  grants.clear();
  const warp = a.warp;
  step('a', a, 6.2, 9);
  const out = PORTALS.find((p) => p.id === 'house').out;
  assert.deepEqual([a.state.x, a.state.z], [out[0], out[1]]);
  assert.ok(Number.isFinite(a.state.y));
  assert.notEqual(a.warp, warp, 'a jump for the others');
  assert.equal(a.budget, 0.5);
});

test('the bungalow\'s team starts on open ground by the bungalow when it has no right inside', () => {
  const { game, player } = setup();
  const a = player('a', 4.5, 19);
  game.modes.teamOf = () => 'bungalow';
  const seen = new Set();
  for (let k = 0; k < 200; k++) {
    game.respawn('a', a, Date.now());
    seen.add(`${a.state.x},${a.state.z}`);
  }
  assert.deepEqual([...seen].sort(), ['80,177', '84,176', '88,177'], 'the three places by the driveway, never the house\'s');
});

test('the end house\'s garden: the server puts a player without the code outside, on the ground only', () => {
  const { game, sent, grants, player, send } = setup();
  const out = PORTALS.find((p) => p.id === 'molenhoek_end').out;
  const ask = (name, p) => { p.nextUnstuck = 0; send(name, p, { t: 'unstuck' }); };
  // The places the reviewer named: the back of the garden, which the portal's straight line from would cross the house.
  for (const [x, z] of [[1512, -350], [1505.2, -346.5], [1500, -344]]) {
    const a = player(`a${x}`, x, z);
    a.state.y = 9.43;
    ask(`a${x}`, a);
    assert.deepEqual([a.state.x, a.state.z], [out[0], out[1]], `put out from ${x},${z}`);
    assert.deepEqual(sent.at(-1), { t: 'unstuck', x: out[0], z: out[1] });
  }
  const n = sent.length;
  const air = player('air', 1512, -350);
  Object.assign(air.state, { y: 9.43, flying: true });
  ask('air', air);
  const roof = player('roof', 1505, -354); // a parachute landing on the end house's roof
  roof.state.y = 15.4;
  ask('roof', roof);
  const house = player('house', 1505, -354); // inside the house itself (not the garden)
  house.state.y = 9.5;
  ask('house', house);
  const far = player('far', 1480, -330);
  far.state.y = 9.43;
  ask('far', far);
  assert.equal(sent.length, n, 'in the air, on the roof, in the house or outside the garden: nothing');
  assert.deepEqual([air.state.x, roof.state.x, house.state.x], [1512, 1505, 1505]);
  grants.add('k-ok|molenhoek_end');
  const ok = player('ok', 1512, -350);
  ok.state.y = 9.43;
  ask('ok', ok);
  assert.equal(ok.state.x, 1512, 'with the code the garden is theirs');
  const rate = player('rate', 1512, -350);
  rate.state.y = 9.43;
  send('rate', rate, { t: 'unstuck' });
  Object.assign(rate.state, { x: 1512, z: -350 });
  send('rate', rate, { t: 'unstuck' });
  assert.equal(rate.state.x, 1512, 'a second ask within a second is ignored');
  assert.ok(game);
});

test('door ids like toString and hasOwnProperty are only ids: no prototype to hit, and the welcome still serialises', () => {
  const { game, told, player, send } = setup();
  const a = player('a', 0, 30, 'admin');
  for (const id of ['toString', 'hasOwnProperty', 'constructor', 'valueOf', 'house-out-3']) {
    a.nextDoor = 0;
    send('a', a, { t: 'door', id, open: true, dir: 1 });
  }
  assert.deepEqual(told.map((m) => m.id), ['toString', 'hasOwnProperty', 'constructor', 'valueOf'], 'the admin\'s house door goes to nobody else (there is nobody else)');
  assert.equal(Object.getPrototypeOf(game.doors), null);
  assert.equal(Object.getPrototypeOf(game.doorDir), null);
  assert.deepEqual(JSON.parse(JSON.stringify(game.doors)), { toString: true, hasOwnProperty: true, constructor: true, valueOf: true, 'house-out-3': true });
  assert.equal(Object.keys(game.doors).length, 5);
  // A fresh game has none of them before they are sent.
  const fresh = setup().game;
  assert.equal('toString' in fresh.doors, false);
  assert.equal(fresh.doors.__proto__, undefined);
  for (const id of ['__proto__', 'a_b']) {
    a.nextDoor = 0;
    send('a', a, { t: 'door', id, open: true });
  }
  assert.equal(told.length, 4, '__proto__ is not an id');
});
