import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Game, HELI_REFUSED } from './game.mjs';
import { SEAT_REFUSED } from './carSeats.mjs';
import { STAGE, VEHICLE } from './vehicleDamage.mjs';

// Cars and helicopters taking damage in a team match (server/vehicleDamage.mjs): only then; every hit checked as a
// hit on a player is, never a number from the page (hit forgery), one per gun's delay (flooding); no damage to a
// vehicle a teammate sits in; the stages, the burning, the wreck, its riders down and the kill the last attacker's;
// a helicopter in the air falls; the wreck goes and the vehicle is back whole at its parking place.

const WEAPONS = JSON.parse(readFileSync(new URL('../shared/weapons.json', import.meta.url), 'utf8'));
const GRENADE = JSON.parse(readFileSync(new URL('../shared/grenade.json', import.meta.url), 'utf8'));
const CARS = JSON.parse(readFileSync(new URL('../shared/car.json', import.meta.url), 'utf8'));
const HELI = JSON.parse(readFileSync(new URL('../shared/heli.json', import.meta.url), 'utf8'));
const CAR_HP = VEHICLE.health.car;
const HELI_HP = VEHICLE.health.heli;

function setup({ teams = true } = {}) {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const game = new Game({ session: () => null, store: { addStats: async () => {}, setMeta: async () => {} }, log: () => {} }, []);
  for (const t of game.timers) clearInterval(t);
  const told = [];
  const sent = new Map();
  const wire = new Map(); // what each player's socket got straight (Game.broadcastEvent's per-player sends)
  game.broadcast = (m, except) => told.push(structuredClone({ ...m, except }));
  game.send = (ws, m) => sent.get(ws.name)?.push(structuredClone(m));
  game.stampState = () => {};
  const car = game.cars.tesla;
  const player = (name, at, team = 'house') => {
    const p = {
      ws: { name, readyState: 1, OPEN: 1, send: (d) => wire.get(name)?.push(JSON.parse(d)) }, key: `k-${name}`, role: 'player', alive: true, protectedUntil: 0, drop: null, warp: 0, stamp: 0,
      state: { x: at.x, y: at.y, z: at.z, yaw: at.yaw ?? 0, pitch: at.pitch ?? 0, armed: true, flying: false, w: 'rifle', c: false },
      weapons: new Set(['pistol', 'rifle', 'shotgun', 'sniper', 'bazooka']), nades: [0, 0], thrown: [], window: clock, msgs: 0, states: 0, others: 0, budget: 0.5, vbudget: 0.5, movedAt: clock,
      hp: 100, score: { kills: 0, deaths: 0, points: 0 }, proto: 2,
    };
    sent.set(name, []);
    wire.set(name, []);
    game.players.set(name, p);
    if (teams) game.modes.state.teams[name] = team;
    return p;
  };
  if (teams) game.modes.state = { kind: 'teams', phase: 'playing', until: clock + 600_000, teams: Object.create(null), score: { house: 0, bungalow: 0 }, switched: Object.create(null), goal: 25 };
  /** A message from `p`, with the flood guard's window and the vehicles' 300 ms gate let go. */
  const send = (name, p, m) => {
    p.window = clock;
    p.msgs = p.states = p.others = 0;
    p.nextCar = 0;
    game.handle(name, p, JSON.stringify(m));
  };
  const at = (ms) => (clock += ms);
  /** A shooter 15 m behind the Tesla's back, looking along -z at it. */
  const shooter = (name, team = 'bungalow') => player(name, { x: car.x, y: car.y, z: car.z + 15 }, team);
  const vhit = (name, p, m = {}) => send(name, p, { t: 'vhit', kind: 'car', id: 'tesla', w: 'rifle', n: 1, ...m });
  /** `k` rifle hits, each after the gun's delay, the game's tick after each (it tells the health). */
  const volley = (name, p, k, m = {}) => {
    for (let i = 0; i < k; i++) {
      at(110);
      vhit(name, p, m);
      game.vehicleDamage.tick(clock);
    }
  };
  const hp = (kind = 'car', id = 'tesla') => game.vehicleDamage.recs.get(`${kind}:${id}`)?.hp ?? VEHICLE.health[kind];
  const stage = (kind = 'car', id = 'tesla') => game.vehicleDamage.recs.get(`${kind}:${id}`)?.st ?? STAGE.whole;
  const ticks = (ms, step = 100) => {
    for (let t = 0; t < ms; t += step) {
      at(step);
      game.vehicleDamage.tick(clock);
    }
  };
  game.vehicleDamage.tick(clock);
  return { game, told, sent, wire, car, player, shooter, send, vhit, volley, hp, stage, ticks, at, now: () => clock };
}

const vdmg = (told) => told.filter((m) => m.t === 'vdmg');

test('the message is refused from every seat and saddle, as every other hit', () => {
  assert.ok(SEAT_REFUSED.has('vhit'));
  assert.ok(HELI_REFUSED.has('vhit'));
});

test('the numbers: a car survives one full rifle magazine, not two; a helicopter is a little weaker; a rocket takes most of a car', () => {
  const mag = (w) => WEAPONS[w].mag * WEAPONS[w].body * WEAPONS[w].pellets;
  for (const w of ['pistol', 'rifle', 'shotgun', 'sniper']) assert.ok(mag(w) < CAR_HP, `one magazine of the ${w} (${mag(w)}) leaves the car standing`);
  assert.ok(2 * mag('rifle') > CAR_HP, 'two players with rifles bring it down');
  assert.ok(HELI_HP < CAR_HP && HELI_HP >= CAR_HP * 0.8);
  const rocket = WEAPONS.bazooka.rocket.damage * VEHICLE.blast.bazooka;
  assert.ok(rocket >= CAR_HP * 0.6 && rocket < CAR_HP, `a rocket's direct hit takes ${rocket} of ${CAR_HP}`);
  assert.ok(GRENADE.damage * VEHICLE.blast.grenade < CAR_HP / 2);
  assert.ok(VEHICLE.fire < VEHICLE.smoke && VEHICLE.burn > 0 && VEHICLE.burn < 0.05);
});

test('no damage outside a team match: shots and blasts change nothing, nothing is told', () => {
  const s = setup({ teams: false });
  const ann = s.shooter('ann');
  s.volley('ann', ann, 5);
  s.game.blast('ann', { x: s.car.x, y: s.car.y + 0.8, z: s.car.z }, 'bazooka');
  assert.equal(s.hp(), CAR_HP);
  assert.equal(s.game.vehicleDamage.recs.size, 0);
  assert.equal(vdmg(s.told).length, 0);
});

test('an honest hit takes the gun\'s own damage, whatever number the page adds', () => {
  const s = setup();
  const ann = s.shooter('ann');
  s.at(200);
  s.vhit('ann', ann, { damage: 9999, hp: 0, body: 50 });
  assert.equal(s.hp(), CAR_HP - WEAPONS.rifle.body);
  ann.state.w = 'shotgun';
  s.at(1000);
  s.vhit('ann', ann, { w: 'shotgun', n: 8 });
  assert.equal(s.hp(), CAR_HP - WEAPONS.rifle.body - 8 * WEAPONS.shotgun.body);
  s.game.vehicleDamage.tick(s.now()); // told on the tick
  const msg = vdmg(s.told).at(-1);
  assert.deepEqual([msg.k, msg.id, msg.hp, msg.st], ['car', 'tesla', Math.ceil((s.hp() / CAR_HP) * 100), STAGE.whole]);
});

test('the attack: forged and out-of-range hits are refused (hit forgery)', () => {
  const s = setup();
  const ann = s.shooter('ann');
  const tries = [
    { kind: 'bike' }, { kind: 'horse' }, { id: 'nope' }, { id: '__proto__' }, { id: { x: 1 } }, { id: 'x'.repeat(40) },
    { n: 0 }, { n: 2 }, { n: 1.5 }, { n: '1' }, { w: 'shotgun', n: 9 }, { w: 'bazooka' }, { w: 'grenade' }, { w: 'laser' },
    { w: 'shotgun', n: 1 }, // not the gun in their hands
  ];
  for (const m of tries) {
    s.at(1000);
    s.vhit('ann', ann, m);
  }
  assert.equal(s.hp(), CAR_HP, 'nothing forged counted');
  // Too far: 130 m behind the car.
  ann.state.z = s.car.z + 130;
  s.at(1000);
  s.vhit('ann', ann);
  assert.equal(s.hp(), CAR_HP, 'out of a gun\'s reach');
  // Looking away: the car behind them, or far to the side.
  ann.state.z = s.car.z + 15;
  for (const [yaw, pitch] of [[Math.PI, 0], [Math.PI / 2, 0], [-Math.PI / 2, 0], [0, 1.2], [0, -1.2]]) {
    Object.assign(ann.state, { yaw, pitch });
    s.at(1000);
    s.vhit('ann', ann);
  }
  assert.equal(s.hp(), CAR_HP, 'not facing it');
  // Dead, unarmed, on a gun they don't carry, or the round over.
  Object.assign(ann.state, { yaw: 0, pitch: 0 });
  for (const [k, v, back] of [['alive', false, true], ['armed', false, true]]) {
    (k === 'alive' ? ann : ann.state)[k] = v;
    s.at(1000);
    s.vhit('ann', ann);
    (k === 'alive' ? ann : ann.state)[k] = back;
  }
  ann.weapons.delete('rifle');
  s.at(1000);
  s.vhit('ann', ann);
  ann.weapons.add('rifle');
  assert.equal(s.hp(), CAR_HP);
  // Honest from the same place: counted (the checks above refused only the forgery).
  s.at(1000);
  s.vhit('ann', ann);
  assert.equal(s.hp(), CAR_HP - WEAPONS.rifle.body);
});

test('the attack: a flood of hits counts one per gun\'s delay (flooding)', () => {
  const s = setup();
  const ann = s.shooter('ann');
  s.at(200);
  for (let i = 0; i < 50; i++) s.vhit('ann', ann); // 50 at once
  assert.equal(s.hp(), CAR_HP - WEAPONS.rifle.body);
  s.at(WEAPONS.rifle.delay * 700 - 1);
  s.vhit('ann', ann);
  assert.equal(s.hp(), CAR_HP - WEAPONS.rifle.body, 'before 70% of the delay: refused');
  s.at(2);
  s.vhit('ann', ann);
  assert.equal(s.hp(), CAR_HP - 2 * WEAPONS.rifle.body);
  // A full magazine in a second (30 messages, 33 ms apart): about a third count.
  const before = s.hp();
  for (let i = 0; i < 30; i++) {
    s.at(33);
    s.vhit('ann', ann);
  }
  const counted = (before - s.hp()) / WEAPONS.rifle.body;
  assert.ok(counted <= 15, `${counted} of 30 counted`);
});

test('from a seat: no hit at all (the seat gate)', () => {
  const s = setup();
  const model3 = s.game.cars.model3;
  const dan = s.player('dan', { x: model3.x + 1.5, y: model3.y, z: model3.z }, 'bungalow');
  s.send('dan', dan, { t: 'car', op: 'in', id: 'model3' });
  assert.equal(model3.driver, 'dan');
  Object.assign(dan.state, { x: s.car.x, z: s.car.z + 15 }); // whatever their state says
  s.at(1000);
  s.vhit('dan', dan);
  assert.equal(s.hp(), CAR_HP);
});

test('friendly fire: no damage to a car a teammate sits in, by shot or blast; an empty one anyone may damage; a foe always', () => {
  const s = setup();
  const ann = s.shooter('ann', 'house');
  const tim = s.player('tim', { x: s.car.x + 1.5, y: s.car.y, z: s.car.z }, 'house');
  s.send('tim', tim, { t: 'car', op: 'in', id: 'tesla' });
  assert.equal(s.car.driver, 'tim');
  s.volley('ann', ann, 3);
  s.game.blast('ann', { x: s.car.x, y: s.car.y + 0.8, z: s.car.z }, 'bazooka');
  assert.equal(s.hp(), CAR_HP, 'a teammate sits in it');
  // The foe's shots count with tim inside.
  const bob = s.shooter('bob', 'bungalow');
  s.volley('bob', bob, 2);
  assert.equal(s.hp(), CAR_HP - 2 * WEAPONS.rifle.body);
  // Empty: ann may damage her own team's car too.
  s.send('tim', tim, { t: 'car', op: 'out' });
  s.volley('ann', ann, 1);
  assert.equal(s.hp(), CAR_HP - 3 * WEAPONS.rifle.body);
});

test('the stages: smoke under half, fire under a fifth, then it burns down by itself', () => {
  const s = setup();
  const ann = s.shooter('ann');
  const to = (frac) => {
    while (s.hp() >= CAR_HP * frac) s.volley('ann', ann, 1);
  };
  to(VEHICLE.smoke);
  assert.equal(s.stage(), STAGE.smoke);
  to(VEHICLE.fire);
  assert.equal(s.stage(), STAGE.fire);
  s.game.vehicleDamage.tick(s.now()); // the game ticks all along; the test's volley did not
  const burning = s.hp();
  s.ticks(1000);
  assert.ok(Math.abs(burning - s.hp() - CAR_HP * VEHICLE.burn) < 1, `it burns ${(burning - s.hp()).toFixed(1)} a second`);
  s.ticks((burning / (CAR_HP * VEHICLE.burn)) * 1000 + 500);
  assert.equal(s.stage(), STAGE.wreck, 'burnt out: a wreck');
  const stages = vdmg(s.told).map((m) => m.st);
  assert.deepEqual([...new Set(stages)], [STAGE.whole, STAGE.smoke, STAGE.fire, STAGE.wreck]);
});

test('destroyed: everyone in it is put out and down, the kill (and the team\'s point) the last attacker\'s; a blast round it', () => {
  const s = setup();
  const dan = s.player('dan', { x: s.car.x - 1.5, y: s.car.y, z: s.car.z }, 'house');
  const pam = s.player('pam', { x: s.car.x + 1.5, y: s.car.y, z: s.car.z }, 'house');
  s.send('dan', dan, { t: 'car', op: 'in', id: 'tesla' });
  s.send('pam', pam, { t: 'car', op: 'in', id: 'tesla' });
  assert.deepEqual([s.car.driver, s.car.passenger], ['dan', 'pam']);
  const bystander = s.player('kim', { x: s.car.x + 3.2, y: s.car.y, z: s.car.z }, 'house');
  const far = s.player('lou', { x: s.car.x + 30, y: s.car.y, z: s.car.z }, 'house');
  const ann = s.shooter('ann', 'bungalow');
  const bob = s.shooter('bob', 'bungalow');
  bob.state.x += 2;
  s.volley('ann', ann, 20);
  while (s.stage() !== STAGE.wreck) s.volley('bob', bob, 1); // bob's hit brings it down
  assert.equal(s.car.driver, null);
  assert.equal(s.car.passenger, null);
  assert.equal(dan.alive, false);
  assert.equal(pam.alive, false);
  assert.equal(bob.score.kills, 2, 'both kills are the last attacker\'s');
  assert.equal(ann.score.kills, 0);
  assert.equal(s.game.modes.state.score.bungalow, 2, 'the team scores as for any kill');
  const kills = s.told.filter((m) => m.t === 'kill');
  assert.deepEqual(kills.slice(0, 2).map((k) => [k.killer, k.victim, k.w]), [['bob', 'dan', 'wreck'], ['bob', 'pam', 'wreck']]);
  assert.ok(bystander.hp < 100, `kim, 2 m from its side, is hurt (${bystander.hp})`);
  assert.equal(far.hp, 100, 'lou, 30 m off, is not');
  assert.equal(bob.hp, 100, 'the attacker is spared, as by their own grenade');
  const boom = vdmg(s.told).find((m) => m.st === STAGE.wreck);
  assert.equal(boom.by, 'bob');
  assert.ok(Number.isFinite(boom.x) && Number.isFinite(boom.z));
  assert.ok(s.told.some((m) => m.t === 'blast' && m.w === 'wreck' && m.by === 'bob'));
  // A wreck: nobody gets in, and no more damage.
  s.send('kim', bystander, { t: 'car', op: 'in', id: 'tesla' });
  assert.equal(s.car.driver, null);
  s.volley('ann', ann, 2);
  assert.equal(s.stage(), STAGE.wreck);
});

test('a teammate of the attacker who got into the burning car gets out alive when it goes up', () => {
  const s = setup();
  const ann = s.shooter('ann', 'bungalow');
  while (s.stage() !== STAGE.fire) s.volley('ann', ann, 1);
  const ben = s.player('ben', { x: s.car.x + 1.5, y: s.car.y, z: s.car.z }, 'bungalow');
  s.send('ben', ben, { t: 'car', op: 'in', id: 'tesla' });
  assert.equal(s.car.driver, 'ben');
  s.ticks(30_000, 500);
  assert.equal(s.stage(), STAGE.wreck);
  assert.equal(s.car.driver, null);
  assert.equal(ben.alive, true);
});

test('a rocket\'s direct hit takes most of a car; a grenade at 2 m less; out of reach nothing', () => {
  const s = setup();
  s.shooter('ann');
  s.game.blast('ann', { x: s.car.x, y: s.car.y + 0.8, z: s.car.z + 2.3 }, 'bazooka'); // on its back
  assert.equal(s.hp(), CAR_HP - WEAPONS.bazooka.rocket.damage * VEHICLE.blast.bazooka);
  const model3 = s.game.cars.model3;
  s.game.blast('ann', { x: model3.x, y: model3.y + 0.5, z: model3.z }, 'grenade');
  const hit = CAR_HP - s.hp('car', 'model3');
  assert.ok(hit > 200 && hit <= GRENADE.damage * VEHICLE.blast.grenade, `a grenade under it: ${hit}`);
  s.game.blast('ann', { x: model3.x + 40, y: model3.y, z: model3.z }, 'grenade');
  assert.equal(CAR_HP - s.hp('car', 'model3'), hit);
});

test('the wreck lies about 20 s, then goes to its parking place, and is back whole about 30 s later', () => {
  const s = setup();
  const park = CARS.cars.tesla.park;
  Object.assign(s.car, { x: park.x + 6, z: park.z + 3, yaw: 1 }); // driven off and left
  const ann = s.player('ann', { x: s.car.x, y: s.car.y, z: s.car.z + 15 }, 'bungalow');
  while (s.stage() !== STAGE.wreck) s.volley('ann', ann, 1);
  s.ticks(VEHICLE.wreckMs - 500);
  assert.equal(s.stage(), STAGE.wreck);
  assert.ok(Math.hypot(s.car.x - park.x, s.car.z - park.z) > 5, 'still where it went up');
  s.ticks(1000);
  assert.equal(s.stage(), STAGE.gone);
  assert.deepEqual([s.car.x, s.car.y, s.car.z, s.car.yaw], [park.x, park.y, park.z, park.yaw], 'on its parking place');
  const kim = s.player('kim', { x: park.x + 1.5, y: park.y, z: park.z }, 'house');
  s.send('kim', kim, { t: 'car', op: 'in', id: 'tesla' });
  assert.equal(s.car.driver, null, 'gone: nobody gets in');
  s.ticks(VEHICLE.goneMs);
  assert.equal(s.game.vehicleDamage.recs.size, 0);
  assert.equal(s.hp(), CAR_HP);
  assert.deepEqual(vdmg(s.told).at(-1), { t: 'vdmg', k: 'car', id: 'tesla', hp: 100, st: STAGE.whole, except: undefined });
  s.send('kim', kim, { t: 'car', op: 'in', id: 'tesla' });
  assert.equal(s.car.driver, 'kim', 'whole again: in');
});

test('the match ends: every vehicle whole at once, a wreck back at its parking place', () => {
  const s = setup();
  const ann = s.shooter('ann');
  while (s.stage() !== STAGE.wreck) s.volley('ann', ann, 1);
  const model3 = s.game.cars.model3;
  s.game.blast('ann', { x: model3.x, y: model3.y + 0.5, z: model3.z }, 'grenade');
  assert.equal(s.game.vehicleDamage.recs.size, 2);
  s.game.modes.state = { kind: 'free' };
  s.ticks(100);
  assert.equal(s.game.vehicleDamage.recs.size, 0);
  const park = CARS.cars.tesla.park;
  assert.deepEqual([s.car.x, s.car.z], [park.x, park.z]);
  assert.deepEqual(vdmg(s.told).slice(-2).map((m) => [m.id, m.hp, m.st]).sort(), [['model3', 100, 0], ['tesla', 100, 0]]);
});

test('a helicopter: damaged on its pad by a foe, in the air it falls when destroyed, its crew down, then home', () => {
  const s = setup();
  const h = s.game.helis.machines.get(HELI.machines[0].id);
  const park = HELI.machines[0].park;
  // The test puts it 40 m up with two foes of ann's aboard (as a pilot's states would; the teams game sends every
  // machine home on its tick today: the flag game will let them fly).
  const pia = s.player('pia', { x: h.x, y: h.y, z: h.z }, 'house');
  const bo = s.player('bo', { x: h.x, y: h.y, z: h.z }, 'house');
  h.seats[0] = 'pia';
  h.seats[1] = 'bo';
  const floor = s.game.helis.floor(h.x + 20, h.z);
  Object.assign(h, { x: h.x + 20, y: floor + 40, g: 0, n: 1 });
  for (const p of [pia, bo]) Object.assign(p.state, { x: h.x, y: h.y, z: h.z });
  // ann below, 30 m off along +z, looking up at it.
  const ann = s.player('ann', { x: h.x, y: floor, z: h.z + 30 }, 'bungalow');
  const mid = s.game.vehicleDamage.middle('heli', h);
  ann.state.yaw = 0;
  ann.state.pitch = Math.atan2(mid.y - (floor + 1.6), Math.hypot(mid.x - ann.state.x, mid.z - ann.state.z));
  ann.state.w = 'rifle';
  const id = h.id;
  s.at(200);
  s.send('ann', ann, { t: 'vhit', kind: 'heli', id, w: 'rifle', n: 1 });
  assert.equal(s.hp('heli', id), HELI_HP - WEAPONS.rifle.body, 'looking up at it: counted');
  ann.state.pitch = 0;
  s.at(200);
  s.send('ann', ann, { t: 'vhit', kind: 'heli', id, w: 'rifle', n: 1 });
  assert.equal(s.hp('heli', id), HELI_HP - WEAPONS.rifle.body, 'looking level, under it: refused');
  ann.state.pitch = Math.atan2(mid.y - (floor + 1.6), Math.hypot(mid.x - ann.state.x, mid.z - ann.state.z));
  while (s.stage('heli', id) !== STAGE.wreck) {
    s.at(110);
    s.send('ann', ann, { t: 'vhit', kind: 'heli', id, w: 'rifle', n: 1 });
  }
  assert.deepEqual(h.seats, [null, null, null, null]);
  assert.equal(pia.alive, false);
  assert.equal(bo.alive, false);
  assert.equal(ann.score.kills, 2);
  assert.equal(h.n, 0, 'the rotor stops');
  assert.ok(h.y > floor + 30, 'still up there');
  s.ticks(4000, 50);
  assert.ok(Math.abs(h.y - floor) < 1e-6, `fallen to the floor (${(h.y - floor).toFixed(2)} m)`);
  assert.equal(h.g, 1);
  s.ticks(VEHICLE.wreckMs);
  assert.equal(s.stage('heli', id), STAGE.gone);
  assert.deepEqual([h.x, h.y, h.z], [park.x, park.y, park.z], 'back on its pad');
  const kim = s.player('kim', { x: park.x + 1.5, y: park.y, z: park.z - 0.4 }, 'house');
  s.send('kim', kim, { t: 'heli', op: 'in', id });
  assert.deepEqual(h.seats, [null, null, null, null], 'gone: nobody boards');
  s.ticks(VEHICLE.goneMs);
  assert.equal(s.game.vehicleDamage.recs.size, 0);
});

test('a page that joins is told every vehicle not whole', () => {
  const s = setup();
  const ann = s.shooter('ann');
  s.volley('ann', ann, 18);
  const w = s.game.welcome(ann, 'ann', '#fff', s.now());
  assert.deepEqual(w.vdmg, [{ k: 'car', id: 'tesla', hp: Math.ceil((s.hp() / CAR_HP) * 100), st: STAGE.smoke }]);
});

/** A stand-in for the homes' gate: `inside` stands in a home nobody else may see into (homeGate.mjs's rules on it). */
function gateWith(game, inside) {
  const hides = (a, b) => a === inside && b !== inside;
  game._gate = {
    insideOf: (p) => (p === inside ? 'home4' : null), may: (p) => p === inside, hides, mayHurt: (a, b) => !hides(a, b) && !hides(b, a),
    mayStand: () => true, granted: () => false,
  };
}

test('the attack: one shot claimed twice, on a player and on a vehicle, counts once (the one clock of all hits)', () => {
  const s = setup();
  const ann = s.shooter('ann', 'bungalow');
  const kim = s.player('kim', { x: s.car.x + 4, y: s.car.y, z: s.car.z + 5 }, 'house');
  s.at(500);
  s.send('ann', ann, { t: 'hit', target: 'kim', w: 'rifle', body: 1, head: 0 });
  assert.equal(kim.hp, 100 - WEAPONS.rifle.body, 'the hit on kim counted');
  s.vhit('ann', ann);
  assert.equal(s.hp(), CAR_HP, 'the same shot on the car: refused');
  s.at(500);
  s.vhit('ann', ann);
  assert.equal(s.hp(), CAR_HP - WEAPONS.rifle.body, 'the next shot on the car counted');
  s.send('ann', ann, { t: 'hit', target: 'kim', w: 'rifle', body: 1, head: 0 });
  assert.equal(kim.hp, 100 - WEAPONS.rifle.body, 'that shot on kim too: refused');
});

test('the school grounds stay free of shooting: no damage to a vehicle on them, nor from a shooter on them, and no burning there', () => {
  const s = setup();
  const model3 = s.game.cars.model3;
  Object.assign(model3, { x: 470, z: -815, yaw: 0 }); // in the middle of the school grounds
  const ann = s.player('ann', { x: 470, y: model3.y, z: -770 }, 'bungalow'); // outside them, looking along -z at it
  for (let i = 0; i < 3; i++) {
    s.at(500);
    s.send('ann', ann, { t: 'vhit', kind: 'car', id: 'model3', w: 'rifle', n: 1 });
  }
  s.game.blast('ann', { x: model3.x, y: model3.y + 0.5, z: model3.z }, 'bazooka');
  assert.equal(s.hp('car', 'model3'), CAR_HP, 'a vehicle on the school grounds');
  // A shooter on them, the Tesla outside: nothing either, by shot or blast.
  const bob = s.player('bob', { x: 470, y: s.car.y, z: -815 }, 'bungalow');
  Object.assign(s.car, { x: 470, z: -760 });
  bob.state.yaw = Math.PI; // facing +z, at the car
  s.at(500);
  s.vhit('bob', bob);
  s.game.blast('bob', { x: s.car.x, y: s.car.y + 0.8, z: s.car.z }, 'bazooka');
  assert.equal(s.hp(), CAR_HP, 'a shooter on the school grounds');
  // A burning car driven onto them stops burning there.
  Object.assign(ann.state, { x: 470, z: -740, yaw: 0 });
  while (s.stage() !== STAGE.fire) s.volley('ann', ann, 1);
  Object.assign(s.car, { x: 470, z: -815 });
  s.game.vehicleDamage.tick(s.now());
  const left = s.hp();
  s.ticks(5000);
  assert.equal(s.hp(), left, 'no burning on the school grounds');
});

test('a destroyed car\'s rider goes down only when a hit on them could have counted: else out alive', () => {
  const s = setup();
  const ann = s.shooter('ann', 'bungalow');
  while (s.stage() !== STAGE.fire) s.volley('ann', ann, 1);
  // Kim (a foe of ann's) in spawn protection gets into the burning car; it burns out.
  const kim = s.player('kim', { x: s.car.x + 1.5, y: s.car.y, z: s.car.z }, 'house');
  s.send('kim', kim, { t: 'car', op: 'in', id: 'tesla' });
  assert.equal(s.car.driver, 'kim');
  kim.protectedUntil = s.now() + 60_000;
  s.ticks(30_000, 500);
  assert.equal(s.stage(), STAGE.wreck);
  assert.equal(s.car.driver, null, 'put out');
  assert.equal(kim.alive, true, 'in spawn protection: alive');
  assert.equal(ann.score.kills, 0);
  // Unarmed (Explore): alive too.
  const s2 = setup();
  const ann2 = s2.shooter('ann', 'bungalow');
  while (s2.stage() !== STAGE.fire) s2.volley('ann', ann2, 1);
  const lou = s2.player('lou', { x: s2.car.x + 1.5, y: s2.car.y, z: s2.car.z }, 'house');
  s2.send('lou', lou, { t: 'car', op: 'in', id: 'tesla' });
  lou.state.armed = false;
  s2.ticks(30_000, 500);
  assert.equal(s2.stage(), STAGE.wreck);
  assert.equal(lou.alive, true, 'unarmed: alive');
});

test('the homes: no damage to a vehicle with someone in it the shooter could not hurt; its riders out alive; who did it hidden', () => {
  const s = setup();
  const ann = s.shooter('ann', 'bungalow');
  const kim = s.player('kim', { x: s.car.x + 1.5, y: s.car.y, z: s.car.z }, 'house');
  s.send('kim', kim, { t: 'car', op: 'in', id: 'tesla' });
  assert.equal(s.car.driver, 'kim');
  gateWith(s.game, ann); // ann stands inside a home kim may not see into
  s.volley('ann', ann, 3);
  s.game.blast('ann', { x: s.car.x, y: s.car.y + 0.8, z: s.car.z }, 'bazooka');
  assert.equal(s.hp(), CAR_HP, 'kim is out of ann\'s reach: nor is the car she sits in');
  // Empty, the car may be damaged from there (nobody is hurt by it); kim gets in once it burns: she gets out alive.
  delete s.game._gate;
  s.send('kim', kim, { t: 'car', op: 'out' });
  while (s.stage() !== STAGE.fire) s.volley('ann', ann, 1);
  s.send('kim', kim, { t: 'car', op: 'in', id: 'tesla' });
  assert.equal(s.car.driver, 'kim');
  gateWith(s.game, ann);
  s.player('tom', { x: s.car.x + 60, y: s.car.y, z: s.car.z }, 'house');
  s.ticks(30_000, 500);
  assert.equal(s.stage(), STAGE.wreck);
  assert.equal(kim.alive, true, 'out of ann\'s sight: alive');
  assert.equal(s.car.driver, null);
  // Its destruction told to tom and kim without ann's name (she is inside a home they may not see into).
  for (const n of ['tom', 'kim']) {
    const m = s.wire.get(n).find((q) => q.t === 'vdmg' && q.st === STAGE.wreck);
    assert.ok(m, `${n} is told it went up`);
    assert.equal(m.by, '', `${n} is not told who`);
  }
  assert.equal(s.wire.get('ann').find((q) => q.t === 'vdmg' && q.st === STAGE.wreck)?.by, 'ann');
  assert.equal(s.told.filter((m) => m.t === 'vdmg' && m.st === STAGE.wreck).length, 0, 'not broadcast with the name to all');
});

test('the homes: a shooter inside a locked home destroys a car outside: no name to those without its code, nobody hurt through the gate', () => {
  for (const leaves of [false, true]) {
    const s = setup();
    const ann = s.shooter('ann', 'bungalow');
    const kim = s.player('kim', { x: s.car.x + 3, y: s.car.y, z: s.car.z }, 'house'); // beside the car, no code
    gateWith(s.game, ann); // ann inside a home kim may not see into
    while (s.stage() !== STAGE.fire) s.volley('ann', ann, 1); // the empty car may be damaged from there
    // `leaves`: ann walks out of the home before it burns out; what she did from inside stays hidden.
    if (leaves) s.game._gate = { ...s.game._gate, insideOf: () => null, hides: () => false, mayHurt: () => true, may: (p) => p === ann };
    const told = s.told.length;
    s.ticks(30_000, 500);
    assert.equal(s.stage(), STAGE.wreck);
    const toKim = [...s.wire.get('kim'), ...s.told.slice(told)];
    assert.ok(toKim.some((m) => m.t === 'vdmg' && m.st === STAGE.wreck), 'kim is told it went up');
    assert.ok(!toKim.some((m) => JSON.stringify(m).includes('"ann"')), `no message to kim names ann (${leaves ? 'left the home' : 'inside'})`);
    assert.equal(kim.hp, 100, 'kim, 2 m from it, not hurt through the gate');
    assert.equal(s.wire.get('ann').find((m) => m.t === 'vdmg' && m.st === STAGE.wreck)?.by, 'ann', 'ann herself is told');
  }
});

test('gone: the car goes to its parking place only once it is clear; back whole only from there', () => {
  const s = setup();
  const park = CARS.cars.tesla.park;
  Object.assign(s.car, { x: park.x + 8, z: park.z + 4, yaw: 1 }); // driven off and left
  const ann = s.player('ann', { x: s.car.x, y: s.car.y, z: s.car.z + 15 }, 'bungalow');
  while (s.stage() !== STAGE.wreck) s.volley('ann', ann, 1);
  const lies = { x: s.car.x, z: s.car.z };
  const kim = s.player('kim', { x: park.x + 0.4, y: park.y, z: park.z - 1 }, 'house'); // standing on its parking place
  s.ticks(VEHICLE.wreckMs + 500);
  assert.equal(s.stage(), STAGE.gone);
  assert.deepEqual([s.car.x, s.car.z], [lies.x, lies.z], 'kim on its spot: it waits where it lay (not drawn, nothing to bump into)');
  s.ticks(VEHICLE.goneMs + 2000);
  assert.equal(s.stage(), STAGE.gone, 'not back whole while it is not home');
  kim.state.x = park.x + 6; // she steps off
  s.ticks(200);
  assert.deepEqual([s.car.x, s.car.z], [park.x, park.z], 'home once clear');
  assert.equal(s.game.vehicleDamage.recs.size, 0, 'and whole, its time being up');
  // Another car on its spot holds it too.
  const s2 = setup();
  Object.assign(s2.car, { x: park.x + 8, z: park.z + 4 });
  const bob = s2.player('bob', { x: s2.car.x, y: s2.car.y, z: s2.car.z + 15 }, 'bungalow');
  while (s2.stage() !== STAGE.wreck) s2.volley('bob', bob, 1);
  Object.assign(s2.game.cars.model3, { x: park.x, y: park.y, z: park.z + 1, yaw: 0 });
  s2.ticks(VEHICLE.wreckMs + 1000);
  assert.ok(Math.hypot(s2.car.x - park.x, s2.car.z - park.z) > 5, 'the Model 3 on its spot: it waits');
});

test('the match ends with a wreck waiting for its spot: whole where it lies', () => {
  const s = setup();
  const park = CARS.cars.tesla.park;
  Object.assign(s.car, { x: park.x + 8, z: park.z + 4 });
  const ann = s.player('ann', { x: s.car.x, y: s.car.y, z: s.car.z + 15 }, 'bungalow');
  while (s.stage() !== STAGE.wreck) s.volley('ann', ann, 1);
  s.player('kim', { x: park.x, y: park.y, z: park.z }, 'house');
  s.ticks(VEHICLE.wreckMs + 500);
  s.game.modes.state = { kind: 'free' };
  s.ticks(100);
  assert.equal(s.game.vehicleDamage.recs.size, 0);
  assert.ok(Math.hypot(s.car.x - park.x, s.car.z - park.z) > 5, 'not onto kim');
  assert.deepEqual(vdmg(s.told).at(-1), { t: 'vdmg', k: 'car', id: 'tesla', hp: 100, st: STAGE.whole, except: undefined });
});

test('the health is told at most once a tick for each vehicle, however many hits came in between', () => {
  const s = setup();
  const ann = s.shooter('ann', 'bungalow');
  const bob = s.player('bob', { x: s.car.x + 2, y: s.car.y, z: s.car.z + 15 }, 'bungalow');
  const before = vdmg(s.told).length;
  for (let i = 0; i < 3; i++) {
    s.at(110);
    s.vhit('ann', ann);
    s.vhit('bob', bob);
  }
  assert.equal(vdmg(s.told).length, before, 'nothing before the tick');
  s.game.vehicleDamage.tick(s.now());
  const told = vdmg(s.told).slice(before);
  assert.equal(told.length, 1, 'one message for six hits');
  assert.equal(told[0].hp, Math.ceil(((CAR_HP - 6 * WEAPONS.rifle.body) / CAR_HP) * 100));
  s.game.vehicleDamage.tick(s.now() + 50);
  assert.equal(vdmg(s.told).length, before + 1, 'nothing new: nothing told');
});

test('a rider\'s kill: the attacker inside a locked home at the hit, outside at the end: no name to those without its code', () => {
  const s = setup();
  const ann = s.shooter('ann', 'bungalow');
  const kim = s.player('kim', { x: s.car.x + 1.5, y: s.car.y, z: s.car.z }, 'house'); // has the home's code
  const lou = s.player('lou', { x: s.car.x + 40, y: s.car.y, z: s.car.z }, 'house'); // has not
  // ann inside the home: kim may see in, lou not.
  const gate = (inside) => {
    const may = (p) => p === ann || p === kim;
    const hides = (a, b) => a === inside && !may(b);
    s.game._gate = { insideOf: (p) => (p === inside ? 'home4' : null), may, hides, mayHurt: (a, b) => !hides(a, b) && !hides(b, a), mayStand: () => true, granted: () => false };
  };
  gate(ann);
  s.send('kim', kim, { t: 'car', op: 'in', id: 'tesla' });
  assert.equal(s.car.driver, 'kim');
  while (s.stage() !== STAGE.fire) s.volley('ann', ann, 1); // from inside the home, kim in the car
  gate(null); // ann walks out
  const from = { lou: s.wire.get('lou').length, told: s.told.length };
  s.ticks(30_000, 500);
  assert.equal(s.stage(), STAGE.wreck);
  assert.equal(kim.alive, false, 'kim could see ann at the hit: down');
  assert.equal(ann.score.kills, 1);
  const toLou = [...s.wire.get('lou').slice(from.lou), ...s.told.slice(from.told)];
  const kill = toLou.find((m) => m.t === 'kill');
  assert.ok(kill && kill.victim === 'kim', 'lou is told kim is down');
  assert.ok(!toLou.some((m) => (m.t === 'kill' || m.t === 'vdmg' || m.t === 'blast') && JSON.stringify(m).includes('"ann"')), 'but not by whom');
  assert.equal(s.wire.get('kim').find((m) => m.t === 'kill')?.killer, 'ann', 'kim herself, who could see in, is told');
  assert.ok(lou);
});

test('a helicopter wreck: left alone by the machines\' own returns until its time; boarding it is refused out loud', () => {
  const s = setup();
  const h = s.game.helis.machines.get(HELI.machines[0].id);
  const park = HELI.machines[0].park;
  const floor = s.game.helis.floor(h.x + 20, h.z);
  Object.assign(h, { x: h.x + 20, y: floor + 30, g: 0, n: 1 });
  const ann = s.player('ann', { x: h.x, y: floor, z: h.z + 30 }, 'bungalow');
  const mid = s.game.vehicleDamage.middle('heli', h);
  ann.state.pitch = Math.atan2(mid.y - (floor + 1.6), Math.hypot(mid.x - ann.state.x, mid.z - ann.state.z));
  while (s.stage('heli', h.id) !== STAGE.wreck) {
    s.at(110);
    s.send('ann', ann, { t: 'vhit', kind: 'heli', id: h.id, w: 'rifle', n: 1 });
  }
  // The teams game sends every machine home on its tick (Helis.clear); the wreck stays where it falls and lies.
  for (let t = 0; t < VEHICLE.wreckMs - 1000; t += 100) {
    s.at(100);
    s.game.vehicleDamage.tick(s.now());
    s.game.helis.tick(s.now());
  }
  assert.ok(Math.hypot(h.x - park.x, h.z - park.z) > 10, 'not taken to its pad before its 20 s');
  assert.ok(Math.abs(h.y - floor) < 1e-6, 'it fell');
  const kim = s.player('kim', { x: h.x + 1.5, y: h.y, z: h.z }, 'house');
  s.sent.get('kim').length = 0;
  s.send('kim', kim, { t: 'heli', op: 'in', id: h.id });
  assert.deepEqual(h.seats, [null, null, null, null]);
  const told = s.sent.get('kim').find((m) => m.t === 'heli');
  assert.equal(told?.heli?.id, h.id, 'kim\'s page is told the machine as it is');
});
