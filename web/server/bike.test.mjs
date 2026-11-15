import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { FLAG, playerFields, readBike, readPlayer } from '../shared/wire.mjs';
import { Game } from './game.mjs';

// The bikes (shared/bike.json, src/world/bike.ts): the server decides who rides which bike, lets only
// that rider move at a bike's speed, keeps riders out of the fighting as a car does, and rings a bell
// only for a rider. Each forged message below must change nothing.

const BIKES = JSON.parse(readFileSync(new URL('../shared/bike.json', import.meta.url), 'utf8'));
const RUN_SPEED = 1.4 * 2.5 * 1.3; // m/s across on foot (game.mjs)
const BIKE_SPEED = BIKES.maxSpeed * 1.3; // m/s on a bike (game.mjs)
const HOUSE = BIKES.bikes.house.park;

function setup() {
  const game = new Game({ session: () => null, store: { addStats: async () => {} } }, []);
  const told = [];
  const sent = new Map();
  game.broadcast = (m, except) => told.push({ ...m, except });
  game.send = (ws, m) => sent.get(ws.name)?.push(m);
  game.stampState = () => {};
  const player = (name, at = { x: HOUSE.x - 1.0, y: HOUSE.y, z: HOUSE.z }) => {
    const now = Date.now();
    const p = {
      ws: { name }, key: `k-${name}`, role: 'player', alive: true, protectedUntil: 0, drop: null, warp: 0, stamp: 0,
      state: { x: at.x, y: at.y, z: at.z, yaw: 0, pitch: 0, armed: true, flying: false, w: 'pistol', c: false },
      weapons: new Set(['pistol']), nades: [0, 0], window: now, msgs: 0, states: 0, others: 0, budget: 0.5, vbudget: 0.5, movedAt: now,
      hp: 100, score: { kills: 0, deaths: 0, points: 0 },
    };
    sent.set(name, []);
    game.players.set(name, p);
    return p;
  };
  const send = (name, p, m) => game.handle(name, p, JSON.stringify(m));
  /** On a bike: the message, with the wait for the next one (three a second) let go. */
  const ask = (name, p, m) => {
    p.nextCar = 0;
    send(name, p, m);
  };
  return { game, told, sent, player, send, ask };
}

/**
 * Move `p` by `dz` along z (down the side passage, towards the street) in a state `ms` after its last
 * one (the budget refills with the time). Returns where the server has them along z.
 */
function move(send, name, p, dz, ms, extra = {}) {
  p.movedAt = Date.now() - ms;
  p.window = Date.now();
  p.states = 0;
  p.msgs = 0;
  const s = p.state;
  send(name, p, { t: 'state', x: s.x, y: s.y, z: s.z + dz, yaw: s.yaw, pitch: 0, armed: s.armed, w: 'pistol', ...extra });
  return p.state.z;
}

test('every bike in the data stands on the map with its paint, and the bike speed is a bike speed', () => {
  const ids = Object.keys(BIKES.bikes);
  assert.ok(ids.length >= 10);
  for (const id of ids) {
    const k = BIKES.bikes[id];
    assert.match(k.paint, /^#[0-9a-f]{6}$/);
    for (const v of [k.park.x, k.park.y, k.park.z, k.park.yaw]) assert.ok(Number.isFinite(v), id);
  }
  // 25 km/h pedalling, at most 36 km/h downhill: much more than running, far less than a car.
  assert.ok(Math.abs(BIKES.pedalSpeed * 3.6 - 25) < 0.1);
  assert.ok(BIKES.maxSpeed > BIKES.pedalSpeed && BIKES.maxSpeed * 3.6 <= 40);
  assert.ok(BIKE_SPEED > RUN_SPEED * 2 && BIKE_SPEED < 20);
});

test('getting on: next to a free bike, alive and on foot; not from afar, not dead, not a ridden one, not twice', () => {
  const { game, told, sent, player, ask } = setup();
  const anna = player('anna');
  const bert = player('bert', { x: HOUSE.x - 1.0, y: HOUSE.y, z: HOUSE.z + 1.5 });
  const far = player('far', { x: HOUSE.x - 1.0, y: HOUSE.y, z: HOUSE.z + 8 });
  const dead = player('dead');
  dead.alive = false;
  ask('far', far, { t: 'bike', op: 'on', id: 'house' });
  ask('dead', dead, { t: 'bike', op: 'on', id: 'house' });
  assert.equal(game.bikes.house.rider, null);
  assert.equal(told.length, 0);
  assert.equal(sent.get('far')[0].t, 'bike', 'a refusal tells the page the bike as it is');
  ask('anna', anna, { t: 'bike', op: 'on', id: 'house' });
  assert.equal(game.bikes.house.rider, 'anna');
  assert.deepEqual(told.map((m) => [m.t, m.bike?.id, m.bike?.rider]), [['bike', 'house', 'anna']]);
  // Stealing a ridden bike: refused, and so is a second bike for the same rider.
  ask('bert', bert, { t: 'bike', op: 'on', id: 'house' });
  assert.equal(game.bikes.house.rider, 'anna');
  anna.state.x = BIKES.bikes.bungalow.park.x;
  anna.state.z = BIKES.bikes.bungalow.park.z;
  ask('anna', anna, { t: 'bike', op: 'on', id: 'bungalow' });
  assert.equal(game.bikes.bungalow.rider, null);
  // Someone else's "off" frees only their own (none): Anna keeps hers.
  ask('bert', bert, { t: 'bike', op: 'off', id: 'house' });
  assert.equal(game.bikes.house.rider, 'anna');
  ask('anna', anna, { t: 'bike', op: 'off' });
  assert.equal(game.bikes.house.rider, null);
});

test('forged ids and kinds of message are refused: unknown, inherited and non-string ids, and the rate', () => {
  const { game, told, player, send, ask } = setup();
  const anna = player('anna');
  for (const id of ['__proto__', 'toString', 'constructor', 'nope', 7, null, { id: 'house' }, ['house']]) ask('anna', anna, { t: 'bike', op: 'on', id });
  assert.equal(told.length, 0);
  assert.equal(game.bikeOf('anna'), null);
  // At most three a second: a second "on" right after an "off" waits.
  ask('anna', anna, { t: 'bike', op: 'on', id: 'house' });
  send('anna', anna, { t: 'bike', op: 'off' });
  assert.equal(game.bikes.house.rider, 'anna');
});

test('no bikes during Zombies, as no cars and no horses', () => {
  const { game, sent, player, ask } = setup();
  const anna = player('anna');
  Object.defineProperty(game.modes, 'zombies', { get: () => ({}) });
  ask('anna', anna, { t: 'bike', op: 'on', id: 'house' });
  assert.equal(game.bikes.house.rider, null);
  assert.equal(sent.get('anna').at(-1).code, 'zNoBike');
});

test('only a rider moves at a bike speed: on foot the run budget holds, whatever flags the page sends', () => {
  const { game, player, send, ask } = setup();
  const anna = player('anna');
  // On foot, a forged ride state (the bike flag, the car flag, a steer) buys nothing: still running pace.
  const x0 = anna.state.z;
  const x1 = move(send, 'anna', anna, 5, 500, { bk: 1, bike: 'house', d: true, s: 0.5 });
  assert.ok(x1 - x0 <= RUN_SPEED * 0.5 + 0.5 + 1e-9, `on foot ${x1 - x0} m in 0.5 s`);
  assert.equal(anna.state.bk, false, 'the bike flag is the server\'s');
  assert.equal(game.bikeOf('anna'), null);
  // Riding: a bike's pace, and the bike goes along.
  anna.state.z = HOUSE.z;
  ask('anna', anna, { t: 'bike', op: 'on', id: 'house' });
  assert.equal(game.bikes.house.rider, 'anna');
  const r0 = anna.state.z;
  const r1 = move(send, 'anna', anna, 5, 500);
  assert.ok(Math.abs(r1 - r0 - 5) < 1e-6, 'five metres in half a second is a bike (36 km/h)');
  assert.equal(anna.state.bk, true);
  assert.equal(game.bikes.house.z, anna.state.z);
  // Faster than the bike's top speed (with the jitter allowed) is cut back.
  const r2 = move(send, 'anna', anna, 30, 500);
  assert.ok(r2 - r1 <= BIKE_SPEED * 0.5 + 0.5 + 1e-9, `${r2 - r1} m in 0.5 s on a bike`);
  // Off again: back to running pace at once.
  ask('anna', anna, { t: 'bike', op: 'off' });
  const f0 = anna.state.z;
  const f1 = move(send, 'anna', anna, 5, 500);
  assert.ok(f1 - f0 <= RUN_SPEED * 0.5 + 0.5 + 1e-9, `after getting off ${f1 - f0} m in 0.5 s`);
  assert.ok(Math.abs(game.bikes.house.z - r2) < 1e-9, 'the bike stays where it was left');
});

test('a rider can\'t shoot or be shot, as in a car; the others see the bike flag', () => {
  const { game, told, player, send, ask } = setup();
  const anna = player('anna');
  const bert = player('bert', { x: HOUSE.x - 1.0, y: HOUSE.y, z: HOUSE.z + 2 });
  ask('anna', anna, { t: 'bike', op: 'on', id: 'house' });
  assert.equal(game.inCar('anna'), true);
  assert.equal(game.inCar('bert'), false);
  told.length = 0;
  send('anna', anna, { t: 'shot', w: 'pistol', x: 0, y: 1, z: 0 });
  assert.equal(told.length, 0, 'no shot from a bike');
  const hp = anna.hp;
  send('bert', bert, { t: 'hit', target: 'anna', w: 'pistol', body: 1, head: 0 });
  assert.equal(anna.hp, hp, 'no hit on a rider');
  // Riders are no flying, crouching figures.
  move(send, 'anna', anna, 1, 500, { flying: true, c: true });
  assert.equal(anna.state.flying, false);
  assert.equal(anna.state.c, false);
  const seen = readPlayer(['anna', 0, ...playerFields(anna.state, true, false, 0)]);
  assert.equal(seen.bike, true);
  assert.equal(seen.d, false, 'not in a car: their figure shows');
  assert.equal(playerFields({ ...anna.state, bk: false }, true, false, 3)[5] & FLAG.bike, 0);
});

test('getting off by dying, leaving or respawning leaves the bike where it is', () => {
  const { game, player, ask } = setup();
  const anna = player('anna');
  ask('anna', anna, { t: 'bike', op: 'on', id: 'house' });
  game.npcDamage('anna', anna, 1000, Date.now(), 'a strongman');
  assert.equal(game.bikes.house.rider, null);
  anna.alive = true;
  ask('anna', anna, { t: 'bike', op: 'on', id: 'house' });
  assert.equal(game.bikes.house.rider, 'anna');
  game.releaseBike('anna');
  assert.equal(game.bikes.house.rider, null);
});

test('the bell: only from a rider, at most every 400 ms, and only the bike\'s id goes out', () => {
  const { told, player, send, ask } = setup();
  const anna = player('anna');
  send('anna', anna, { t: 'bell' });
  assert.equal(told.length, 0, 'no bell on foot');
  ask('anna', anna, { t: 'bike', op: 'on', id: 'house' });
  told.length = 0;
  send('anna', anna, { t: 'bell', id: 'church1', x: 500, z: -700 });
  send('anna', anna, { t: 'bell' });
  assert.deepEqual(told, [{ t: 'bell', id: 'house', except: 'anna' }], 'rung once, at her own bike');
  anna.nextBell = 0;
  send('anna', anna, { t: 'bell' });
  assert.equal(told.length, 2);
});

test('the ticks carry the bikes, and a page reads them back', () => {
  const { game, player, ask } = setup();
  const anna = player('anna');
  ask('anna', anna, { t: 'bike', op: 'on', id: 'house' });
  let out = '';
  anna.ws = { name: 'anna', OPEN: 1, readyState: 1, send: (s) => (out = s) };
  anna.proto = 2;
  anna.full = true;
  game.snapshot(Date.now());
  const tick = JSON.parse(out);
  const house = tick.k.map(readBike).find((k) => k.id === 'house');
  assert.equal(house.rider, 'anna');
  assert.ok(Math.abs(house.x - HOUSE.x) < 0.01 && Math.abs(house.z - HOUSE.z) < 0.01);
  assert.equal(tick.k.length, Object.keys(BIKES.bikes).length);
});
