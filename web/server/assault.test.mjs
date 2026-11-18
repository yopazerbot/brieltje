import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';
import { RETURN_MS } from './flags.mjs';
import { tenths, winner } from './assault.mjs';
import { Host } from './host.mjs';
import { ASSAULT, ASSAULT_FIELDS, progressOf } from '../shared/assaultFields.mjs';
import { LOOT } from '../shared/loot.mjs';
import { STAGE } from './vehicleDamage.mjs';

// Attack and defend (server/assault.mjs, server/assaultSupply.mjs, driven from server/modes.mjs as a flag game of its own):
// two rounds, the church then the Sparrenhof, the roles swapped between them. Every event, time, start place and supply is
// the server's, from where it has the players.

function setup() {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const store = { addStats: async () => {}, setMeta: async () => {}, getMeta: async () => null, addCar: async () => 1, deleteCar: async () => {} };
  const game = new Game({ session: () => null, store, log: () => {} }, [], null);
  for (const t of game.timers) clearInterval(t);
  game.auth = { ...game.auth, store, session: () => null, log: () => {}, addressOf: () => '127.0.0.1' };
  const out = [];
  const sent = new Map();
  game.broadcast = (m) => out.push(structuredClone(m));
  game.broadcastThing = (m) => out.push(structuredClone(m));
  game.send = (ws, m) => sent.get(ws?.name)?.push(structuredClone(m));
  game.stampState = () => {};
  const closers = new Map();
  const join = (name, role = 'player') => {
    sent.set(name, []);
    const ws = { name, readyState: 1, OPEN: 1, send() {}, on: (ev, fn) => ev === 'close' && closers.set(name, fn), close: () => {} };
    game.join(ws, { username: name, role, key: `k-${name}` }, { headers: {}, socket: {} });
    return game.players.get(name);
  };
  /** A message from `name`'s page, the flood guards let go (not the supplies' own wait: `fresh` clears that too). */
  const msg = (name, m, fresh = true) => {
    const p = game.players.get(name);
    Object.assign(p, { window: clock, msgs: 0, states: 0, others: 0, nextCar: 0 }, fresh ? { nextSup: 0, nextMine: 0, nextTurret: 0 } : {});
    game.handle(name, p, JSON.stringify(m));
  };
  const tick = (ms = 50) => {
    clock += ms;
    game.modes.tick(clock, ms);
    game.vehicleDamage.tick(clock);
  };
  const put = (name, x, z, y) => Object.assign(game.players.get(name).state, { x, y, z, flying: false, armed: true });
  const lines = (name) => sent.get(name).filter((m) => m.t === 'system').map((m) => m.code);
  const got = (name, t) => sent.get(name).filter((m) => m.t === t);
  return { game, join, msg, tick, put, lines, got, out, sent, leave: (name) => closers.get(name)(), at: (ms) => (clock += ms), now: () => clock };
}

/** Four players in Attack and defend: `def` the team defending the church first. */
function four(defend = 'blue', extra = {}) {
  const s = setup();
  for (const n of ['ann', 'bob', 'cid', 'dee']) s.join(n);
  s.game.modes.start('flag', 'admin', 'assault', { defend, ...extra });
  const teams = s.game.modes.state.teams;
  const blue = Object.keys(teams).filter((n) => teams[n] === 'blue');
  const red = Object.keys(teams).filter((n) => teams[n] === 'red');
  const f = () => s.game.modes.state.f;
  const def = () => (f().defender() === 'blue' ? blue : red);
  const att = () => (f().defender() === 'blue' ? red : blue);
  /** Stand `name` on the defenders' stand, or in the camp. */
  const onStand = (name) => {
    const [x, z, y] = f().baseOf(f().defender()).stand;
    s.put(name, x, z, y);
  };
  const inCamp = (name, dx = 0) => {
    const [x, z, y] = f().camp;
    s.put(name, x + dx, z, y);
  };
  return { ...s, blue, red, f, def, att, onStand, inCamp };
}

test('the fields: each camp 400 m from its defenders (a straight line), alike in both, no private home or school near', async () => {
  const { HOMES, distanceToHome } = await import('../shared/homes.mjs');
  const { noShoot } = await import('../shared/zones.mjs');
  const d = Object.values(ASSAULT_FIELDS).map((f) => {
    const [sx, sz] = f.bases.blue.stand;
    const [cx, cz] = f.assault.camp.flag;
    return Math.hypot(cx - sx, cz - sz);
  });
  for (const m of d) assert.ok(m > 380 && m < 420, `camp ${m.toFixed(0)} m off`);
  assert.ok(Math.abs(d[0] - d[1]) < 10, 'the same in both rounds');
  for (const f of Object.values(ASSAULT_FIELDS)) {
    const c = f.assault.camp;
    for (const [x, z] of [c.flag, ...c.spawns, ...c.tents, ...c.lamps, c.supply, c.heli, c.truck, ...c.cars, ...c.crates.map((k) => k.at)]) {
      assert.ok(Math.min(...HOMES.map((h) => distanceToHome(h.id, x, z))) > 300, `${f.id}: no private home near (${x}, ${z})`);
      assert.equal(noShoot(x, z), null, `${f.id}: not on the school grounds`);
    }
    // The same layout: every thing at the same distance from the flag in both camps.
    const other = Object.values(ASSAULT_FIELDS).find((g) => g !== f).assault.camp;
    const dist = (cc, p) => Math.hypot(p[0] - cc.flag[0], p[1] - cc.flag[1]);
    for (const k of ['heli', 'truck', 'supply']) assert.ok(Math.abs(dist(c, c[k]) - dist(other, other[k])) < 0.05, `${k} alike`);
    assert.equal(f.assault.crates.length, 6, 'six crates at the defenders\' base');
  }
  assert.equal(progressOf(ASSAULT_FIELDS.assaultChurch, ...ASSAULT_FIELDS.assaultChurch.bases.blue.stand.slice(0, 2)), 0);
  assert.equal(progressOf(ASSAULT_FIELDS.assaultChurch, ...ASSAULT_FIELDS.assaultChurch.assault.camp.flag.slice(0, 2)), 1);
});

test('start: the chosen team defends the church, the other starts in its camp; the view says the round and the roles', () => {
  const s = four('red');
  const g = s.game;
  assert.equal(s.f().defender(), 'red');
  assert.equal(g.modes.teamMatch, true);
  const [sx, sz] = s.f().baseOf('red').stand;
  for (const n of s.red) assert.ok(Math.hypot(g.players.get(n).state.x - sx, g.players.get(n).state.z - sz) < 25, `${n} by the church`);
  const [cx, cz] = s.f().camp;
  for (const n of s.blue) assert.ok(Math.hypot(g.players.get(n).state.x - cx, g.players.get(n).state.z - cz) < 10, `${n} in the camp`);
  const v = g.modes.view();
  assert.equal(v.title, 'Attack and defend');
  assert.equal(v.flag.field, 'assaultChurch');
  assert.deepEqual([v.flag.assault.round, v.flag.assault.phase, v.flag.assault.def], [1, 'live', 'red']);
  assert.ok(Math.abs(v.ms - ASSAULT.roundMs) < 100);
  assert.equal(v.flag.racks, undefined, 'no racks: the heavy weapons come from crates');
  // The spawn truck parked in the attackers' colour, the defenders' cars in theirs.
  assert.equal(g.cars.fr1.kind, 'truck-blue');
  assert.equal(g.cars.fb1.kind, 'modelY-red');
  assert.ok(s.out.some((m) => m.t === 'system' && m.code === 'assaultStarted' && m.args.team === 'red'));
});

test('a capture: the attackers take the flag from the stand and carry it into the camp; the time is the server\'s', () => {
  const s = four('blue');
  const [a] = s.att();
  const [d] = s.def();
  s.inCamp(d, 30); // out of the way
  s.at(60_000);
  s.onStand(a);
  s.tick();
  assert.equal(s.f().flags.blue.by, a, 'taken');
  // Their own camp's flag is never taken by the defenders.
  s.inCamp(d);
  s.tick();
  assert.equal(s.f().flags.red.at, 'home');
  s.inCamp(d, 30);
  // Halfway: the attempt's distance grows.
  const [sx, sz, sy] = s.f().baseOf('blue').stand;
  const [cx, cz] = s.f().camp;
  s.put(a, (sx + cx) / 2, (sz + cz) / 2, sy);
  s.tick();
  assert.ok(Math.abs(s.f().best - 0.5) < 0.02);
  s.inCamp(a, ASSAULT.campR - 0.5);
  s.tick();
  const r = s.f().results[0];
  assert.ok(r && r.att === 'red' && r.by === a, 'round 1 over');
  assert.ok(r.ms >= 60_000 && r.ms < 61_000, `time ${r.ms}`);
  assert.equal(s.f().phase, 'break');
  assert.ok(s.out.some((m) => m.t === 'flag' && m.ev === 'captured' && m.name === a));
  assert.ok(s.out.some((m) => m.t === 'system' && m.code === 'assaultCaptured' && m.args.s === tenths(r.ms)));
});

test('the break: the Sparrenhof, the roles swapped, everyone at the new places; then round 2 on its own clock', () => {
  const s = four('blue');
  const g = s.game;
  const [a, a2] = s.att();
  // The spawn truck: a start place once it has stood still a while, and every page told when it became one.
  assert.equal(g.modes.view().flag.assault.truck.spawn, false, 'just parked');
  const sends = s.out.filter((m) => m.t === 'mode').length;
  s.tick(ASSAULT.truckStillMs + 100);
  assert.equal(g.modes.view().flag.assault.truck.spawn, true);
  assert.ok(s.out.filter((m) => m.t === 'mode').length > sends, 'every page told');
  // A heavy weapon in round 1: back in its crate at the break (each round's teams with the same kit).
  assert.equal(s.f().arms.give(a2, g.players.get(a2), 'red', 'sniper', s.now()), null);
  s.onStand(a);
  s.tick();
  s.inCamp(a);
  s.tick();
  assert.equal(s.f().phase, 'break');
  s.tick();
  assert.equal(s.f().arms.count('red', s.now()), 0);
  assert.equal(g.players.get(a2).weapons.has('sniper'), false);
  assert.equal(s.f().field.id, 'assaultSparrenhof');
  assert.equal(s.f().defender(), 'red', 'the other team defends');
  const [sx, sz] = s.f().baseOf('red').stand;
  for (const n of s.red) assert.ok(Math.hypot(g.players.get(n).state.x - sx, g.players.get(n).state.z - sz) < 25, `${n} defends the Sparrenhof`);
  // No take during the break.
  s.onStand(s.blue[0]);
  s.tick();
  assert.equal(s.f().flags.red.at, 'home');
  s.tick(ASSAULT.breakMs);
  assert.equal(s.f().phase, 'live');
  assert.equal(s.f().round, 2);
  assert.ok(Math.abs(g.modes.state.until - s.now() - ASSAULT.roundMs) < 100);
  assert.equal(g.cars.fr1.kind, 'truck-blue', 'the truck in the new attackers\' colour');
  // Round 2 runs out: red's capture is the only one.
  s.put(s.blue[0], 0, 0, 0);
  s.tick(ASSAULT.roundMs);
  assert.equal(g.modes.state.phase, 'done');
  assert.equal(g.modes.state.resultCode, 'assaultOnly');
  assert.equal(g.modes.state.resultArgs.team, 'red');
});

test('the winner: the fastest capture; one capture beats none; else the closest attempt; then tags; then a draw', () => {
  const t0 = { blue: 0, red: 0 };
  assert.deepEqual(winner([{ att: 'red', ms: 200_000, best: 1 }, { att: 'blue', ms: 150_000, best: 1 }], t0), { team: 'blue', why: 'time', a: 150, b: 200 });
  assert.deepEqual(winner([{ att: 'red', ms: 200_000, best: 1 }, { att: 'blue', ms: null, best: 0.9 }], t0), { team: 'red', why: 'only', a: 200, b: 90 });
  assert.deepEqual(winner([{ att: 'red', ms: null, best: 0.41 }, { att: 'blue', ms: null, best: 0.42 }], t0), { team: 'blue', why: 'far', a: 42, b: 41 });
  assert.deepEqual(winner([{ att: 'red', ms: null, best: 0.415 }, { att: 'blue', ms: null, best: 0.419 }], { blue: 3, red: 5 }), { team: 'red', why: 'tags', a: 5, b: 3 });
  assert.deepEqual(winner([{ att: 'red', ms: 100_040, best: 1 }, { att: 'blue', ms: 99_960, best: 1 }], { blue: 2, red: 2 }), { team: null, why: 'tags' });
});

test('a dropped flag: the defenders bring it home by touch; left alone it goes home by itself', () => {
  const s = four('blue');
  const g = s.game;
  const [a] = s.att();
  const [d] = s.def();
  s.inCamp(d, 30);
  s.onStand(a);
  s.tick();
  const [sx, sz, sy] = s.f().baseOf('blue').stand;
  s.put(a, sx + 40, sz, sy);
  s.tick();
  g.damage(d, g.players.get(d), a, g.players.get(a), 500, false, 'rifle', s.now());
  s.tick();
  assert.equal(s.f().flags.blue.at, 'ground');
  s.put(d, sx + 40, sz, sy);
  s.tick();
  assert.equal(s.f().flags.blue.at, 'home', 'returned by a defender');
  // Alone: home after RETURN_MS.
  s.inCamp(d, 30);
  s.tick(5000);
  g.respawn(a, g.players.get(a), s.now()); // back (Game.tick does it on its own clock)
  s.onStand(a);
  s.tick();
  s.put(a, sx + 40, sz, sy);
  s.tick();
  g.damage(d, g.players.get(d), a, g.players.get(a), 500, false, 'rifle', s.now());
  s.tick();
  assert.equal(s.f().flags.blue.at, 'ground');
  s.tick(RETURN_MS);
  assert.equal(s.f().flags.blue.at, 'home');
});

test('the spawn truck: only the attackers get in; a start place when still, whole and 120 m from the stand; a wreck back at the camp after 60 s', () => {
  const s = four('blue');
  const g = s.game;
  const [a, a2] = s.att();
  const [d] = s.def();
  const truck = g.cars.fr1;
  // A defender beside it: refused, with a line.
  s.put(d, truck.x + 2.5, truck.z, truck.y);
  s.msg(d, { t: 'car', op: 'in', id: 'fr1' });
  assert.equal(truck.driver, null);
  assert.ok(s.lines(d).includes('assaultTruck'));
  s.put(a, truck.x + 2.5, truck.z, truck.y);
  s.msg(a, { t: 'car', op: 'in', id: 'fr1' });
  assert.equal(truck.driver, a);
  // Driven next to the stand and left there: no start place there (under 120 m).
  const [sx, sz, sy] = s.f().baseOf('blue').stand;
  Object.assign(truck, { x: sx + 60, z: sz, y: sy });
  s.msg(a, { t: 'car', op: 'out' });
  s.tick(ASSAULT.truckStillMs + 100);
  assert.equal(s.f().truckSpawn(s.now()), null, 'too near the flag');
  // 200 m off and still: the attackers come back beside it.
  Object.assign(truck, { x: sx + 200, z: sz });
  s.tick(100);
  assert.equal(s.f().truckSpawn(s.now()), null, 'just moved');
  s.tick(ASSAULT.truckStillMs + 100);
  assert.ok(s.f().truckSpawn(s.now()));
  const spot = s.f().baseSpot(a2);
  assert.ok(Math.hypot(spot.x - truck.x, spot.z - truck.z) < 8, 'beside the truck');
  assert.ok(Math.hypot(s.f().baseSpot(d).x - sx, s.f().baseSpot(d).z - sz) < 25, 'the defenders at their stand');
  // Destroyed by a defender: no start place; back whole at the camp 60 s after.
  const vd = g.vehicleDamage;
  const r = vd.rec('car', 'fr1');
  r.by = d;
  r.hp = 0;
  vd.staged(r, truck, s.now());
  assert.equal(vd.out('car', 'fr1'), true);
  s.put(d, sx, sz, sy); // off its parking place (it waits for a clear one)
  assert.equal(s.f().truckSpawn(s.now()), null);
  for (let i = 0; i < 59; i++) s.tick(1000);
  assert.equal(vd.out('car', 'fr1'), true, 'still gone at 59 s');
  s.tick(1000);
  s.tick(100);
  assert.equal(vd.out('car', 'fr1'), false, 'whole at 60 s');
  const [tx, tz] = s.f().field.assault.camp.truck;
  assert.ok(Math.hypot(truck.x - tx, truck.z - tz) < 0.1, 'at its camp');
  // Its own team does it no damage.
  assert.equal(vd.mayDamage(a, 'car', truck), false);
  assert.equal(vd.mayDamage(d, 'car', truck), true);
});

test('supplies: the right side, within reach, on foot, not too fast, the waits, and what each gives', () => {
  const s = four('blue');
  const g = s.game;
  const [a] = s.att();
  const [d] = s.def();
  const crate = (side, kind) => {
    const list = side === 'def' ? s.f().field.assault.crates : s.f().field.assault.camp.crates;
    const i = list.findIndex((c) => c.kind === kind);
    return { id: `${side === 'def' ? 'd' : 'c'}${i}`, at: list[i].at };
  };
  const stand = (name, c, dx = 0.5) => s.put(name, c.at[0] + dx, c.at[1], c.at[2]);
  // Ammo: grenades back.
  const ammo = crate('def', 'ammo');
  stand(d, ammo);
  g.players.get(d).nades.fill(s.now() + 99_000);
  s.msg(d, { t: 'asup', id: ammo.id });
  assert.ok(g.players.get(d).nades.every((t) => t === 0));
  assert.equal(s.got(d, 'asup').at(-1).kind, 'ammo');
  // Again at once: the wait (20 s), told in whole seconds.
  s.msg(d, { t: 'asup', id: ammo.id });
  assert.equal(s.lines(d).at(-1), 'asupWait');
  assert.equal(sent(s, d).at(-1).args.n, 20);
  s.at(ASSAULT.wait.ammo);
  s.msg(d, { t: 'asup', id: ammo.id });
  assert.equal(s.got(d, 'asup').length, 2);
  // The other side's crate: refused. Out of reach: refused. In a car: refused.
  stand(a, ammo);
  s.msg(a, { t: 'asup', id: ammo.id });
  assert.equal(s.lines(a).at(-1), 'asupSide');
  const campAmmo = crate('att', 'ammo');
  stand(a, campAmmo, ASSAULT.reach + 0.3);
  s.msg(a, { t: 'asup', id: campAmmo.id });
  assert.equal(s.lines(a).at(-1), 'asupFar');
  stand(a, campAmmo);
  s.msg(a, { t: 'asup', id: campAmmo.id });
  assert.equal(s.got(a, 'asup').at(-1).kind, 'ammo');
  // Too fast: a second message within ASSAULT.rateMs is not even answered.
  const before = sent(s, a).length;
  s.msg(a, { t: 'asup', id: crate('att', 'med').id }, false);
  assert.equal(sent(s, a).length, before);
  // Forged ids and values: nothing given, nothing thrown.
  for (const id of ['__proto__', 'constructor', 'toString', 'x'.repeat(5000), 'D0', '', 12, null, NaN, 1e308, { a: 1 }, ['c0']]) s.msg(a, { t: 'asup', id });
  assert.equal(s.got(a, 'asup').length, 1);
  // A first-aid kit and a vest: refused when not needed; else health back and a vest that takes the next hit.
  const med = crate('att', 'med');
  stand(a, med);
  g.players.get(a).hp = 100;
  s.f().supply.loot.kit(a).armor = LOOT.armor;
  s.msg(a, { t: 'asup', id: med.id });
  assert.equal(s.lines(a).at(-1), 'asupFull');
  s.f().supply.loot.kit(a).armor = 0;
  g.players.get(a).hp = 40;
  s.msg(a, { t: 'asup', id: med.id });
  assert.equal(g.players.get(a).hp, 40 + LOOT.heal);
  assert.equal(s.f().supply.loot.kit(a).armor, LOOT.armor);
  g.damage(d, g.players.get(d), a, g.players.get(a), 30, false, 'rifle', s.now());
  assert.equal(g.players.get(a).hp, 40 + LOOT.heal, 'the vest took it');
  assert.equal(s.f().supply.loot.kit(a).armor, LOOT.armor - 30);
  // In a drop or a car, or the game done: nothing.
  s.at(ASSAULT.wait.med);
  g.players.get(a).hp = 40;
  g.players.get(a).state.flying = true;
  s.msg(a, { t: 'asup', id: med.id });
  assert.equal(s.lines(a).at(-1), 'asupFoot');
});

/** Everything `name`'s page was sent. */
function sent(s, name) {
  return s.sent.get(name);
}

test('heavy weapons: two a team at once, one a player; the sniper and the bazooka only from the crates; rockets counted', () => {
  const s = setup();
  for (const n of ['ann', 'bob', 'cid', 'dee', 'eve', 'fay']) s.join(n);
  s.game.modes.start('flag', 'admin', 'assault', { defend: 'blue' });
  const g = s.game;
  const f = g.modes.state.f;
  const teams = g.modes.state.teams;
  const att = Object.keys(teams).filter((n) => teams[n] === 'red');
  s.tick();
  for (const n of att) assert.equal(g.players.get(n).weapons.has('sniper'), false, 'no sniper from the start');
  const crates = f.field.assault.camp.crates;
  const bz = crates.findIndex((c) => c.kind === 'bazooka');
  const sn = crates.findIndex((c) => c.kind === 'sniper');
  const at = (n, i) => s.put(n, crates[i].at[0] + 0.3, crates[i].at[1], crates[i].at[2]);
  at(att[0], bz);
  s.msg(att[0], { t: 'asup', id: `c${bz}` });
  assert.equal(g.players.get(att[0]).weapons.has('bazooka'), true);
  at(att[1], sn);
  s.msg(att[1], { t: 'asup', id: `c${sn}` });
  assert.equal(g.players.get(att[1]).weapons.has('sniper'), true);
  at(att[2], sn);
  s.msg(att[2], { t: 'asup', id: `c${sn}` });
  assert.equal(s.lines(att[2]).at(-1), 'asupHeavyFull');
  // A second for the same player: refused.
  s.at(ASSAULT.wait.heavy);
  at(att[0], sn);
  s.msg(att[0], { t: 'asup', id: `c${sn}` });
  assert.equal(s.lines(att[0]).at(-1), 'asupHave');
  // The rockets: three, at the bazooka's pace; then it is gone and its place free after heavyBackMs.
  const p = g.players.get(att[0]);
  p.state.w = 'bazooka';
  let fired = 0;
  for (let i = 0; i < 6; i++) {
    if (f.arms.fire(att[0], p, s.now())) fired++;
    s.at(3000);
  }
  assert.equal(fired, ASSAULT.rockets);
  s.tick();
  assert.equal(p.weapons.has('bazooka'), false);
  assert.equal(f.arms.count('red', s.now()), 2, 'its place comes back later');
  s.tick(ASSAULT.heavyBackMs);
  assert.equal(f.arms.count('red', s.now()), 1);
  // The holder goes down: the sniper gone, back to the crate later.
  g.damage('x', g.players.get(att[0]), att[1], g.players.get(att[1]), 500, false, 'rifle', s.now());
  s.tick();
  assert.equal(g.players.get(att[1]).weapons.has('sniper'), false);
  // The game over: the sniper back in everyone's hands.
  g.modes.start('free', 'admin');
  for (const n of att) assert.equal(g.players.get(n).weapons.has('sniper'), true);
});

test('the defenders\' traps: limited a round; a claymore goes off when an attacker walks into it; a turret shoots them', () => {
  const s = four('blue');
  const g = s.game;
  const [a] = s.att();
  const [d, d2] = s.def();
  const f = s.f();
  const crates = f.field.assault.crates;
  const ci = crates.findIndex((c) => c.kind === 'claymore');
  const ti = crates.findIndex((c) => c.kind === 'turret');
  const at = (n, i) => s.put(n, crates[i].at[0] + 0.3, crates[i].at[1], crates[i].at[2]);
  // The attackers may not take traps, even standing there.
  at(a, ci);
  s.msg(a, { t: 'asup', id: `d${ci}` });
  assert.equal(s.lines(a).at(-1), 'asupSide');
  at(d, ci);
  s.msg(d, { t: 'asup', id: `d${ci}` });
  assert.equal(f.supply.loot.kit(d).claymores, ASSAULT.claymoresTake);
  at(d, ti);
  s.at(ASSAULT.wait.trap);
  s.msg(d, { t: 'asup', id: `d${ti}` });
  assert.equal(f.supply.loot.kit(d).turrets, 1);
  // The round's limit for the team.
  f.supply.used.claymores = ASSAULT.claymoresRound;
  at(d2, ci);
  s.msg(d2, { t: 'asup', id: `d${ci}` });
  assert.equal(s.lines(d2).at(-1), 'asupTrapsOut');
  // Placed on the square, facing east; an attacker walks into its arc and is hurt.
  const [sx, sz, sy] = f.baseOf('blue').stand;
  s.put(d, sx + 6, sz - 6, sy);
  const yaw = -Math.PI / 2; // facing +x
  const st = g.players.get(d).state;
  s.msg(d, { t: 'claymore', x: st.x + 0.9, y: sy, z: st.z, yaw });
  assert.equal(f.supply.loot.mines.size, 1, 'placed');
  s.tick(LOOT.armMs + 50);
  s.put(d, sx + 6, sz - 12, sy);
  const mine = [...f.supply.loot.mines.values()][0];
  const hp = g.players.get(a).hp;
  g.players.get(a).protectedUntil = 0;
  s.put(a, mine.x + 1.5, mine.z, mine.y);
  s.tick();
  assert.equal(f.supply.loot.mines.size, 0, 'gone off');
  assert.ok(g.players.get(a).hp < hp || !g.players.get(a).alive, 'the attacker hurt');
  assert.ok(s.out.some((m) => m.t === 'zboom'));
  // A forged claymore from an attacker: nothing.
  s.msg(a, { t: 'claymore', x: mine.x, y: mine.y, z: mine.z, yaw: 0 });
  assert.equal(f.supply.loot.mines.size, 0);
  // The turret: set up on the square; an attacker in sight 6 m off is shot (through Game.damage, as the defender's).
  g.respawn(a, g.players.get(a), s.now());
  s.put(d, sx + 6, sz - 6, sy);
  s.msg(d, { t: 'turret', x: sx + 6.9, y: sy, z: sz - 6, yaw });
  assert.equal(f.supply.loot.turrets.size, 1, 'set up');
  const pa = g.players.get(a);
  s.put(a, sx + 12, sz - 6, sy);
  s.tick(LOOT.turretArm + 50);
  pa.protectedUntil = 0;
  pa.hp = 100;
  for (let i = 0; i < 60; i++) s.tick(50);
  assert.ok(pa.hp < 100 || !pa.alive, `shot (${pa.hp})`);
  assert.ok(s.out.some((m) => m.t === 'afire' && m.s[0][1] === a));
  // A teammate in front of it is never shot.
  const pd2 = g.players.get(d2);
  pd2.hp = 100;
  pd2.protectedUntil = 0;
  s.put(a, sx + 60, sz + 60, sy);
  s.put(d2, sx + 12, sz - 6, sy);
  for (let i = 0; i < 40; i++) s.tick(50);
  assert.equal(pd2.hp, 100);
});

test('the host: Attack and defend in the programme, who defends first checked; the swap refused in it', () => {
  const s = setup();
  for (const n of ['ann', 'bob']) s.join(n);
  const host = s.game.host ?? new Host(s.game);
  assert.deepEqual(host.entry({ kind: 'assault', defend: 'red', minutes: 8 }), { kind: 'assault', place: 'assault', defend: 'red', minutes: 8, goal: null, look: null });
  assert.equal(host.entry({ kind: 'assault' }).defend, 'blue');
  for (const defend of ['green', '__proto__', 1, {}, ['red']]) assert.equal(host.entry({ kind: 'assault', defend }), null);
  assert.equal(host.entry({ kind: 'assault', minutes: 99 }).minutes, null);
  s.game.modes.start('flag', 'admin', 'assault', { defend: 'blue' });
  assert.equal(s.game.modes.swapSides(s.now()).code, 'assaultNoSwap');
  // A player asking to switch team: refused as in every team game.
  s.msg('ann', { t: 'team', team: 'red' });
  assert.ok(s.lines('ann').includes('hostOnlyTeams'));
});
