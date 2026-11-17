import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';
import { FIRED_MS, LOST_MS, ROCKETS, TAKE } from './flagBazooka.mjs';
import { FIELDS } from '../shared/flagFields.mjs';
import { NO_SHOOT, noShoot } from '../shared/zones.mjs';
import { PORTALS, REACH } from '../shared/portals.mjs';

// Steal the flag's bazookas (server/flagBazooka.mjs): one a team on a rack at its base, taken by walking into it, three
// rockets, back on the rack after a while. The server decides every take and every rocket; no message claims one.

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
  game.broadcastFrom = (m) => out.push(structuredClone(m));
  game.send = (ws, m) => sent.get(ws?.name)?.push(structuredClone(m));
  game.stampState = () => {};
  const closers = new Map();
  const join = (name, role = 'player') => {
    sent.set(name, []);
    const ws = { name, readyState: 1, OPEN: 1, send() {}, on: (ev, fn) => ev === 'close' && closers.set(name, fn), close: () => {} };
    game.join(ws, { username: name, role, key: `k-${name}` }, { headers: {}, socket: {} });
    return game.players.get(name);
  };
  const msg = (name, m) => {
    const p = game.players.get(name);
    Object.assign(p, { window: clock, msgs: 0, states: 0, others: 0, nextCar: 0 });
    game.handle(name, p, JSON.stringify(m));
  };
  const tick = (ms = 50) => {
    clock += ms;
    game.modes.tick(clock, ms);
  };
  const put = (name, x, z, y) => Object.assign(game.players.get(name).state, { x, y, z, flying: false, armed: true });
  return { game, join, msg, tick, put, out, sent, leave: (name) => closers.get(name)(), at: (ms) => (clock += ms), now: () => clock };
}

/** Four players and the admin in Steal the flag on `field`, out of the start's protection. */
function game(field = 'compact', opts = {}) {
  const s = setup();
  for (const n of ['ann', 'bob', 'cid', 'dee']) s.join(n);
  s.game.modes.start('flag', 'boss', field, opts);
  s.join('boss', 'admin'); // late: two a side, the admin on the smaller
  const teams = s.game.modes.state.teams;
  const blue = Object.keys(teams).filter((n) => teams[n] === 'blue' && n !== 'boss');
  const red = Object.keys(teams).filter((n) => teams[n] === 'red' && n !== 'boss');
  const f = FIELDS[field];
  const arms = () => s.game.modes.state.f.arms;
  /** Walk `name` into `team`'s rack. */
  const toRack = (name, team) => {
    const [x, z, y] = f.bases[team].rack;
    s.put(name, x + 0.4, z, y);
  };
  /** `name` takes their team's launcher and holds it, ready to fire. */
  const take = (name, team) => {
    toRack(name, team);
    s.tick();
    s.msg(name, { t: 'state', ...s.game.players.get(name).state, w: 'bazooka', armed: true });
  };
  const fired = () => s.out.filter((m) => m.t === 'rocket').length;
  const fbz = (name) => s.sent.get(name).filter((m) => m.t === 'fbz');
  s.at(5000);
  return { ...s, blue, red, f, arms, toRack, take, fired, fbz };
}

test('the racks: 4 to 8 m from their stand, off the start places, the portals and the school grounds, inside the field', () => {
  for (const field of Object.values(FIELDS)) {
    const s = game(field.id);
    const edge = s.game.modes.state.f.edge;
    for (const team of ['blue', 'red']) {
      const base = field.bases[team];
      const [x, z] = base.rack;
      const d = Math.hypot(x - base.stand[0], z - base.stand[1]);
      assert.ok(d >= 4 && d <= 8, `${field.id} ${team}: ${d} m from the stand`);
      for (const [sx, sz] of base.spawns) assert.ok(Math.hypot(x - sx, z - sz) > TAKE + 0.8, `${field.id} ${team}: not on a start place`);
      assert.ok(PORTALS.every((p) => Math.hypot(p.x - x, p.z - z) > REACH + 1));
      assert.equal(noShoot(x, z), null);
      assert.ok(edge.inside(x, z));
    }
  }
});

test('the admin\'s own bazooka is out of their hands while the game is played, a respawn or a new connection neither brings it back; back after', () => {
  const s = game();
  const boss = s.game.players.get('boss');
  s.tick();
  assert.equal(boss.weapons.has('bazooka'), false);
  assert.deepEqual(s.sent.get('boss').filter((m) => m.t === 'weapons').at(-1).list.includes('bazooka'), false, 'their page told');
  // A rocket from it anyway: refused.
  s.msg('boss', { t: 'state', ...boss.state, w: 'bazooka', armed: true });
  const before = s.fired();
  s.msg('boss', { t: 'rocket', tx: boss.state.x + 20, ty: boss.state.y, tz: boss.state.z });
  assert.equal(s.fired(), before);
  // Down and back: loadout() gives it, the next tick takes it again, and no rocket leaves in between.
  s.game.respawn('boss', boss, s.now());
  assert.equal(boss.weapons.has('bazooka'), true, 'the respawn\'s loadout');
  s.msg('boss', { t: 'state', ...boss.state, w: 'bazooka', armed: true });
  s.msg('boss', { t: 'rocket', tx: boss.state.x + 20, ty: boss.state.y, tz: boss.state.z });
  assert.equal(s.fired(), before, 'refused all the same: not the rack\'s');
  s.tick();
  assert.equal(boss.weapons.has('bazooka'), false);
  // Stopped: theirs again, and told.
  s.game.modes.start('free', 'boss');
  assert.equal(boss.weapons.has('bazooka'), true);
  assert.ok(s.sent.get('boss').filter((m) => m.t === 'weapons').at(-1).list.includes('bazooka'));
});

test('the admin\'s bazooka is back when the game ends by its clock too', () => {
  const s = game('compact', { minutes: 1 });
  s.tick();
  assert.equal(s.game.players.get('boss').weapons.has('bazooka'), false);
  s.at(60_000);
  s.tick(); // level: sudden death
  assert.equal(s.game.players.get('boss').weapons.has('bazooka'), false);
  s.at(5 * 60_000);
  s.tick(); // still level, no tags: a draw
  assert.equal(s.game.modes.state.phase, 'done');
  assert.equal(s.game.players.get('boss').weapons.has('bazooka'), true);
  assert.equal(s.game.modes.view().flag.racks, undefined, 'the racks gone with the result');
});

test('take: a player of the rack\'s team walking into it gets it and three rockets; their team hears who, the other team nothing', () => {
  const s = game();
  const [b1, b2] = s.blue;
  const [r1] = s.red;
  assert.deepEqual(s.game.modes.view().flag.racks, { blue: { at: 'rack' }, red: { at: 'rack' } });
  s.toRack(b1, 'blue');
  s.tick();
  const p = s.game.players.get(b1);
  assert.equal(p.weapons.has('bazooka'), true);
  assert.equal(s.arms().racks.blue.by, b1);
  assert.equal(s.arms().racks.blue.left, ROCKETS);
  assert.deepEqual(s.game.modes.view().flag.racks.blue, { at: 'out' });
  assert.deepEqual(s.fbz(b1).map((m) => m.ev), ['taken', 'left']);
  assert.deepEqual(s.fbz(b2), [{ t: 'fbz', ev: 'taken', team: 'blue', name: b1, n: ROCKETS }]);
  assert.deepEqual(s.fbz(r1), [], 'no line for the other team');
  // A teammate walking in now: one holder a team.
  s.toRack(b2, 'blue');
  s.tick();
  assert.equal(s.game.players.get(b2).weapons.has('bazooka'), false);
});

test('take: only the rack\'s own team, alive, armed and on foot, within reach', () => {
  const s = game();
  const [b1] = s.blue;
  const [r1, r2] = s.red;
  s.toRack(r1, 'blue'); // red at blue's rack
  s.tick();
  assert.equal(s.game.players.get(r1).weapons.has('bazooka'), false);
  assert.equal(s.arms().racks.blue.at, 'rack');
  // Holstered (Explore): not taken.
  s.toRack(r2, 'red');
  s.game.players.get(r2).state.armed = false;
  s.tick();
  assert.equal(s.arms().racks.red.at, 'rack');
  // Down: not taken.
  s.game.players.get(r2).state.armed = true;
  s.game.players.get(r2).alive = false;
  s.tick();
  assert.equal(s.arms().racks.red.at, 'rack');
  s.game.players.get(r2).alive = true;
  // Flying over it, or 3 m off: not taken.
  const [x, z, y] = s.f.bases.blue.rack;
  s.put(b1, x, z, y + 3);
  s.tick();
  s.put(b1, x + 3, z, y);
  s.tick();
  assert.equal(s.arms().racks.blue.at, 'rack');
  // In a car beside it: not taken (the field's cars are the village's; a spawned one will do).
  s.game.cars.test = { id: 'test', kind: 'modelY-blue', x, y, z, yaw: 0, s: 0, driver: b1, passenger: null, by: '' };
  s.put(b1, x, z, y);
  s.tick();
  assert.equal(s.arms().racks.blue.at, 'rack');
  delete s.game.cars.test;
  s.tick();
  assert.equal(s.arms().racks.blue.by, b1, 'out of the car, on foot: taken');
});

test('three rockets, the reload between them, then the launcher is gone and a fourth refused; back on the rack 45 s later', () => {
  const s = game();
  const [b1, b2] = s.blue;
  s.take(b1, 'blue');
  const p = s.game.players.get(b1);
  s.put(b1, p.state.x + 10, p.state.z, p.state.y); // off the rack
  const shoot = () => s.msg(b1, { t: 'rocket', tx: p.state.x + 30, ty: p.state.y, tz: p.state.z });
  shoot();
  assert.equal(s.fired(), 1);
  shoot(); // straight after: the reload
  assert.equal(s.fired(), 1);
  assert.equal(s.arms().racks.blue.left, ROCKETS - 1);
  s.at(3000);
  shoot();
  s.at(3000);
  shoot();
  assert.equal(s.fired(), 3);
  assert.deepEqual(s.fbz(b1).filter((m) => m.ev === 'left').map((m) => m.n), [3, 2, 1, 0]);
  assert.equal(p.weapons.has('bazooka'), false, 'empty: out of their hands');
  assert.equal(s.arms().racks.blue.at, 'away');
  s.at(3000);
  s.msg(b1, { t: 'state', ...p.state, w: 'bazooka' });
  shoot();
  assert.equal(s.fired(), 3, 'a fourth: refused');
  // Back on the rack FIRED_MS after the last; nobody takes it before.
  s.toRack(b2, 'blue');
  s.tick();
  assert.equal(s.game.players.get(b2).weapons.has('bazooka'), false);
  assert.ok(s.game.modes.view().flag.racks.blue.ms > FIRED_MS - 4000);
  s.at(FIRED_MS - 3000);
  s.tick();
  assert.equal(s.arms().racks.blue.by, b2, 'a fresh one, taken');
});

test('a page that claims the bazooka without holding it, or fires the other team\'s, is refused', () => {
  const s = game();
  const [b1] = s.blue;
  const [r1] = s.red;
  s.take(b1, 'blue');
  // Red says it holds the bazooka: the server keeps it at the pistol, and no rocket leaves.
  const q = s.game.players.get(r1);
  s.msg(r1, { t: 'state', ...q.state, w: 'bazooka', armed: true });
  assert.equal(q.state.w, 'pistol');
  s.msg(r1, { t: 'rocket', tx: q.state.x + 20, ty: q.state.y, tz: q.state.z });
  assert.equal(s.fired(), 0);
  // Even with a bazooka in their set (as a respawned admin's), blue's launcher is not theirs to fire.
  q.weapons.add('bazooka');
  q.state.w = 'bazooka';
  s.msg(r1, { t: 'rocket', tx: q.state.x + 20, ty: q.state.y, tz: q.state.z });
  assert.equal(s.fired(), 0);
  assert.equal(s.arms().racks.blue.left, ROCKETS, 'blue\'s count untouched');
  s.tick();
  assert.equal(q.weapons.has('bazooka'), false, 'taken out of their set again');
});

test('down, gone or on the other team: the holder loses it, back on the rack 20 s later; no rocket while down', () => {
  const s = game();
  const [b1, b2] = s.blue;
  const [r1] = s.red;
  s.take(b1, 'blue');
  const p = s.game.players.get(b1);
  p.alive = false;
  s.msg(b1, { t: 'rocket', tx: p.state.x + 20, ty: p.state.y, tz: p.state.z });
  assert.equal(s.fired(), 0, 'down: refused');
  s.tick();
  assert.equal(p.weapons.has('bazooka'), false);
  assert.equal(s.arms().racks.blue.at, 'away');
  s.at(LOST_MS - 1000);
  s.tick();
  assert.equal(s.arms().racks.blue.at, 'away');
  s.at(1000);
  s.tick();
  assert.equal(s.arms().racks.blue.at, 'rack');
  // Leaving the game.
  s.take(r1, 'red');
  assert.equal(s.arms().racks.red.by, r1);
  s.leave(r1);
  s.tick();
  assert.equal(s.arms().racks.red.at, 'away');
  // Switching team.
  s.take(b2, 'blue');
  assert.equal(s.arms().racks.blue.by, b2);
  s.game.modes.state.teams[b2] = 'red';
  s.tick();
  assert.equal(s.arms().racks.blue.at, 'away');
  assert.equal(s.game.players.get(b2).weapons.has('bazooka'), false);
});

test('the holder may carry the flag, and may not fire from a car or a helicopter', () => {
  const s = game();
  s.game.rules.heli = true;
  const [b1] = s.blue;
  s.take(b1, 'blue');
  const p = s.game.players.get(b1);
  const [rx, rz, ry] = s.f.bases.red.stand;
  s.put(b1, rx, rz, ry);
  s.tick();
  assert.equal(s.game.modes.state.f.flags.red.by, b1, 'carries the red flag');
  assert.equal(s.arms().racks.blue.by, b1, 'and the bazooka');
  s.game.cars.test = { id: 'test', kind: 'modelY-blue', x: rx, y: ry, z: rz, yaw: 0, s: 0, driver: b1, passenger: null, by: '' };
  s.msg(b1, { t: 'rocket', tx: p.state.x + 20, ty: p.state.y, tz: p.state.z });
  assert.equal(s.fired(), 0, 'not from a car');
  delete s.game.cars.test;
  const h = s.game.helis.machines.get('church');
  h.seats[1] = b1;
  s.msg(b1, { t: 'rocket', tx: p.state.x + 20, ty: p.state.y, tz: p.state.z });
  assert.equal(s.fired(), 0, 'not from a helicopter seat');
  h.seats[1] = null;
  assert.equal(s.arms().racks.blue.left, ROCKETS, 'none counted');
});

test('no rocket from the school grounds, none counted (village field)', () => {
  const s = game('village');
  const [b1] = s.blue;
  s.take(b1, 'blue');
  const [x, z] = NO_SHOOT[0].poly.reduce(([ax, az], [px, pz], i, all) => [ax + px / all.length, az + pz / all.length], [0, 0]);
  assert.ok(noShoot(x, z));
  s.put(b1, x, z, s.game.players.get(b1).state.y);
  s.msg(b1, { t: 'rocket', tx: x + 20, ty: 5, tz: z });
  assert.equal(s.fired(), 0);
  assert.equal(s.arms().racks.blue.left, ROCKETS);
});

test('a rocket brings down a flying helicopter: health off the first, the second destroys it, its riders out and down, the kill the shooter\'s', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = game();
  s.game.rules.heli = true;
  const [b1] = s.blue;
  const [r1, r2] = s.red;
  // Red flies its machine, 30 m up over the street, with a passenger.
  const h = s.game.helis.machines.get('house');
  s.at(20_000);
  for (const n of [r1, r2]) {
    s.put(n, h.x + 1.4, h.z, h.y);
    s.msg(n, { t: 'heli', op: 'in', id: 'house' });
  }
  assert.deepEqual(h.seats.slice(0, 2), [r1, r2]);
  Object.assign(h, { y: h.y + 30, g: 0, n: 1 });
  for (const n of [r1, r2]) Object.assign(s.game.players.get(n).state, { x: h.x, y: h.y, z: h.z, armed: true });
  // Blue takes the bazooka and fires at the machine from 60 m off along the street.
  s.take(b1, 'blue');
  const p = s.game.players.get(b1);
  s.put(b1, h.x - 60, h.z, p.state.y);
  const middle = s.game.vehicleDamage.middle('heli', h);
  const aim = () => s.msg(b1, { t: 'rocket', tx: middle.x, ty: middle.y, tz: middle.z });
  aim();
  assert.equal(s.fired(), 1);
  t.mock.timers.tick(5000); // the flight (about 2 s at the rocket's speed)
  const rec = s.game.vehicleDamage.recs.get('heli:house');
  assert.ok(rec && rec.hp < rec.max, 'health off');
  assert.ok(rec.hp > 0, `still flying after one: ${rec.hp} of ${rec.max}`);
  s.at(3000);
  aim();
  t.mock.timers.tick(5000);
  assert.equal(s.game.vehicleDamage.out('heli', 'house'), true, 'destroyed by the second');
  for (const n of [r1, r2]) {
    assert.equal(s.game.helis.of(n), null, `${n} out`);
    assert.equal(s.game.players.get(n).alive, false, `${n} down`);
  }
  assert.equal(p.score.kills, 2, 'the kills the shooter\'s');
  // It falls, and comes back whole at red's spot as any wreck does (server/vehicleDamage.mjs).
  for (let i = 0; i < 100; i++) {
    s.tick(100);
    s.game.vehicleDamage.tick(s.now());
  }
  assert.ok(h.y - s.game.helis.floor(h.x, h.z) < 0.5, 'on the ground');
});

test('no damage to your own team\'s machine with a teammate in it, rocket or not', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = game();
  s.game.rules.heli = true;
  const [b1, b2] = s.blue;
  const h = s.game.helis.machines.get('church');
  s.at(20_000);
  s.put(b2, h.x + 1.4, h.z, h.y);
  s.msg(b2, { t: 'heli', op: 'in', id: 'church' });
  assert.equal(s.game.helis.of(b2), h);
  s.take(b1, 'blue');
  const p = s.game.players.get(b1);
  s.put(b1, h.x - 20, h.z, p.state.y);
  const middle = s.game.vehicleDamage.middle('heli', h);
  s.msg(b1, { t: 'rocket', tx: middle.x, ty: middle.y, tz: middle.z });
  assert.equal(s.fired(), 1);
  t.mock.timers.tick(5000);
  assert.equal(s.game.vehicleDamage.recs.has('heli:church'), false, 'untouched');
});
