// The laser rifle as a weapon players carry (Yoshi, 21 Nov 2026: "Give laser gun to everyone, except in zombie indeed as
// a drop in later waves or bought from stall for big price"), on the real game server: everyone carries it outside the
// Zombies game; the server decides its hits (34 a body hit, 80 the head, 120 m, its pace: server/laserGate.mjs); the
// others are shown its beam's end, held to its reach and the map; in Zombies it is a late wave's drop or the stall's
// dearest buy. One test per thing a page could try: hit forgery, rate abuse, relay abuse, item forgery.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { makeBounds } from '../shared/bounds.mjs';
import { startingWeapons } from '../shared/loadout.mjs';
import { Loot, LOOT } from '../shared/loot.mjs';
import { priceOf } from '../shared/stall.mjs';
import { BIG, makeNav, ZOMBIE } from '../shared/zombies.mjs';
import { Game } from './game.mjs';
import { ZombieGame } from './zombies.mjs';

const read = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url), 'utf8'));
const LASER = read('../shared/weapons.json').laser;
const GRENADE = read('../shared/grenade.json');
const TERRAIN = read('../shared/terrain.json');
const AREA = { x0: TERRAIN.x0, x1: TERRAIN.x0 + (TERRAIN.nx - 1) * TERRAIN.step, z0: TERRAIN.z0, z1: TERRAIN.z0 + (TERRAIN.nz - 1) * TERRAIN.step };

const realNow = Date.now;
const games = [];
test.afterEach(() => {
  Date.now = realNow;
  for (const g of games.splice(0)) for (const t of g.timers) clearInterval(t);
});

/** A real game server on a clock of its own; players made with `player`, messages with `say` (the flood guard let go). */
function setup() {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const game = new Game({ session: () => null, store: { addStats: async () => {}, setMeta: async () => {} }, log: () => {} }, []);
  games.push(game);
  for (const t of game.timers) clearInterval(t);
  game.gate.insideOf = () => null; // out in the open: this is about the gun, not the homes (server/homeGate.mjs)
  const shown = [];
  game.broadcast = () => {};
  game.broadcastHome = (m) => shown.push(m);
  game.send = (ws, m) => ws.log.push(m);
  game.stampState = () => {};
  game.stats = () => {};
  const player = (name, x = 0, z = 0, guns = startingWeapons()) => {
    const p = {
      ws: { name, log: [] }, key: `k-${name}`, role: 'player', alive: true, protectedUntil: 0, drop: null, warp: 0, stamp: 0,
      state: { x, y: 0, z, yaw: 0, pitch: 0, armed: true, flying: false, w: 'laser', c: false },
      weapons: new Set(guns), nades: Array(GRENADE.carry).fill(0), window: clock, msgs: 0, states: 0, others: 0, budget: 0.5, vbudget: 0.5, movedAt: clock,
      hp: 100, score: { kills: 0, deaths: 0, points: 0 }, thrown: [],
    };
    game.players.set(name, p);
    return p;
  };
  const say = (name, m) => {
    const p = game.players.get(name);
    p.window = clock;
    p.msgs = p.states = p.others = 0;
    game.handle(name, p, JSON.stringify(m));
  };
  const at = (ms) => (clock += ms);
  return { game, shown, player, say, at, now: () => clock };
}

/** `b` whole again, out of spawn protection. */
const heal = (b) => Object.assign(b, { hp: 100, alive: true, protectedUntil: 0 });

test('everyone carries it outside Zombies, alone and together, the admin too; in Zombies nobody starts with it', () => {
  assert.ok(startingWeapons().includes('laser'));
  assert.ok(startingWeapons(['bazooka']).includes('laser'));
  assert.deepEqual(startingWeapons([], true), ['pistol']);
  const { game, player } = setup();
  const anna = player('anna');
  anna.weapons = new Set(['pistol']);
  game.respawn('anna', anna, Date.now());
  assert.ok(anna.weapons.has('laser'), 'a respawn hands it back');
  game.modes.state = { kind: 'zombies', phase: 'playing', z: { stop() {} } };
  game.pistolsOnly();
  assert.equal(anna.weapons.has('laser'), false, 'the Zombies game: the pistol only');
  game.modes.state = { kind: 'free' };
  game.gunsBack();
  assert.ok(anna.weapons.has('laser'), 'and back after it');
  assert.ok(anna.ws.log.some((m) => m.t === 'weapons' && m.list.includes('laser')), 'and its page told');
});

test('its hits: 34 a body hit, 80 the head, from the server\'s table; none past 120 m (hit forgery)', () => {
  const { player, say, at } = setup();
  const anna = player('anna');
  const bert = player('bert', 0, 10);
  say('anna', { t: 'hit', target: 'bert', w: 'laser', body: 1, head: 0 });
  assert.equal(bert.hp, 100 - LASER.body);
  assert.equal(LASER.body, 34);
  at(300);
  heal(bert);
  say('anna', { t: 'hit', target: 'bert', w: 'laser', body: 0, head: 1 });
  assert.equal(bert.hp, 100 - LASER.head);
  assert.equal(LASER.head, 80);
  // Two "pellets", a damage of the page's own: refused or the gun's own.
  at(300);
  heal(bert);
  say('anna', { t: 'hit', target: 'bert', w: 'laser', body: 2, head: 0 });
  assert.equal(bert.hp, 100, 'two beams in one hit');
  at(300);
  say('anna', { t: 'hit', target: 'bert', w: 'laser', body: 1, head: 0, damage: 999 });
  assert.equal(bert.hp, 100 - LASER.body, 'one beam, the table\'s damage');
  say('anna', { t: 'hit', target: 'bert', w: 'laser', body: 1, head: 0 });
  assert.equal(bert.hp, 100 - LASER.body, 'a second hit at once: refused (one pull, one hit)');
  // Past its reach.
  at(300);
  heal(bert);
  bert.state.z = 121;
  say('anna', { t: 'hit', target: 'bert', w: 'laser', body: 1, head: 0 });
  assert.equal(bert.hp, 100, '121 m: out of reach');
  bert.state.z = 119;
  at(300);
  say('anna', { t: 'hit', target: 'bert', w: 'laser', body: 1, head: 0 });
  assert.equal(bert.hp, 100 - LASER.body, '119 m: within it');
  // Not the gun in their hands as the server has it.
  at(300);
  heal(bert);
  anna.state.w = 'rifle';
  say('anna', { t: 'hit', target: 'bert', w: 'laser', body: 1, head: 0 });
  assert.equal(bert.hp, 100, 'holding the rifle');
});

test('a page firing faster than the gun, past its heat and its vent, is held to its pace (rate abuse)', () => {
  const { player, say, at } = setup();
  player('anna');
  const bert = player('bert', 0, 10);
  // A hit every 180 ms (above the hit clock of 70% of the delay, 175 ms) for 6 seconds.
  let landed = 0;
  for (let t = 0; t < 6000; t += 180, at(180)) {
    heal(bert);
    say('anna', { t: 'hit', target: 'bert', w: 'laser', body: 1, head: 0 });
    if (bert.hp < 100) landed++;
  }
  // An honest page: eleven from cold (2.5 s), a vent of 1.2 s, nine more (2 s): twenty in 5.7 s, and one for the jitter.
  assert.ok(landed <= 21, `${landed} hits in 6 s`);
  assert.ok(landed >= 18, `${landed}: still its own pace`);
  // During a vent: nothing, a shot neither.
  const { player: p2, say: say2, at: at2, shown } = setup();
  p2('cas');
  const dirk = p2('dirk', 0, 10);
  for (let i = 0; i < 11; i++, at2(250)) say2('cas', { t: 'shot', w: 'laser', x: 0, y: 1.5, z: 0, tx: 0, ty: 1.5, tz: 50 });
  assert.equal(shown.filter((m) => m.t === 'shot').length, 11, 'eleven from cold');
  heal(dirk);
  say2('cas', { t: 'hit', target: 'dirk', w: 'laser', body: 1, head: 0 });
  say2('cas', { t: 'shot', w: 'laser', x: 0, y: 1.5, z: 0 });
  assert.equal(dirk.hp, 100, 'in the vent: no hit');
  assert.equal(shown.filter((m) => m.t === 'shot').length, 11, 'and no shot shown');
  at2(1200);
  say2('cas', { t: 'hit', target: 'dirk', w: 'laser', body: 1, head: 0 });
  assert.equal(dirk.hp, 100 - LASER.body, 'after the vent');
});

test('the hits on zombies, the Brook Spirit, a vehicle and a strongman are held to the same pace (rate abuse)', () => {
  const { game, player, say, at } = setup();
  const anna = player('anna');
  let calls = 0;
  game.spirit = { hit: () => calls++ };
  game._vehicleDamage = { hit: () => calls++ };
  for (let i = 0; i < 11; i++, at(250)) say('anna', { t: 'shot', w: 'laser', x: 0, y: 1.5, z: 0 });
  // Venting now: each kind of hit goes no further.
  say('anna', { t: 'sphit', w: 'laser', h: [[0, 1]] });
  say('anna', { t: 'vhit', kind: 'car', id: 'tesla', w: 'laser', n: 1 });
  assert.equal(calls, 0, 'not passed on');
  for (const t of ['zhit', 'clownhit']) assert.equal(game.laserPace('anna', anna, { t, w: 'laser', id: 1 }, Date.now()), false, t);
  at(1200);
  say('anna', { t: 'sphit', w: 'laser', h: [[0, 1]] });
  assert.equal(calls, 1, 'after the vent it goes on (to its own checks)');
  // Another gun is none of this.
  assert.equal(game.laserPace('anna', anna, { t: 'vhit', w: 'rifle' }, Date.now()), true);
});

test('the others are shown the beam\'s end held to 120 m from the shooter\'s eyes and to the map; nothing that is not a number (relay abuse)', () => {
  const { player, say, at, shown } = setup();
  const anna = player('anna', 100, 100);
  const last = () => shown.filter((m) => m.t === 'shot').at(-1);
  const fire = (m) => {
    at(600);
    say('anna', { t: 'shot', w: 'laser', x: 100, y: 1.5, z: 100, ...m });
    return last();
  };
  const eye = { x: anna.state.x, y: anna.state.y + 1.5, z: anna.state.z };
  const far = (m) => Math.hypot(m.tx - eye.x, m.ty - eye.y, m.tz - eye.z);
  const near = fire({ tx: 100, ty: 1.5, tz: 150 });
  assert.deepEqual([near.tx, near.ty, near.tz, near.w], [100, 1.5, 150, 'laser'], 'within reach: as sent');
  const long = fire({ tx: 100, ty: 1.5, tz: 100 + 5000 });
  assert.ok(far(long) <= LASER.beam.range + 0.02, `brought back to its reach: ${far(long)}`);
  assert.ok(Math.abs(long.tx - 100) < 0.01 && long.tz > 100, 'along its own line');
  const up = fire({ tx: 100, ty: 1e9, tz: 100 });
  assert.ok(up.ty <= 200 && far(up) <= LASER.beam.range + 0.02, 'held to the sky\'s limit and its reach');
  for (const bad of [{ tx: 'x', ty: 1, tz: 1 }, { tx: null, ty: 1, tz: 1 }, { tx: 1, ty: 1 }, { tx: [1], ty: 1, tz: 1 }]) {
    const m = fire(bad);
    assert.equal('tx' in m, false, `no end: ${JSON.stringify(bad)}`);
  }
  // At the map's edge, aimed out of it: held to the map.
  anna.state.x = AREA.x1 - 5;
  at(600);
  say('anna', { t: 'shot', w: 'laser', x: anna.state.x, y: 1.5, z: 100, tx: AREA.x1 + 900, ty: 1.5, tz: 100 });
  assert.ok(last().tx <= AREA.x1, 'inside the map');
  // The shot's start is the server's (more than 3 m off: where the server has them).
  at(600);
  say('anna', { t: 'shot', w: 'laser', x: 0, y: 0, z: 0, tx: 1, ty: 1, tz: 1 });
  assert.ok(Math.abs(last().x - anna.state.x) < 0.01, 'from where the server has the shooter');
});

test('a page that does not carry it: its shot is shown as a pistol\'s with no beam, its hit counts for nothing (hit forgery)', () => {
  const { player, say, shown } = setup();
  player('anna', 0, 0, ['pistol']);
  const bert = player('bert', 0, 10);
  say('anna', { t: 'shot', w: 'laser', x: 0, y: 1.5, z: 0, tx: 0, ty: 1.5, tz: 50 });
  const m = shown.filter((s) => s.t === 'shot').at(-1);
  assert.equal(m.w, 'pistol');
  assert.equal('tx' in m, false, 'a pistol has no tracer');
  say('anna', { t: 'hit', target: 'bert', w: 'laser', body: 1, head: 0 });
  assert.equal(bert.hp, 100);
});

/** A Zombies game in the break on an open field, its stall at the players' feet (as zombie-stall.test.mjs). */
function zombies() {
  const s = setup();
  const edge = makeBounds([[-40, -40], [40, -40], [40, 40], [-40, 40]]);
  const nav = makeNav({ prisms: [], height: () => 0, edge });
  s.game.zombieGround = () => ({ nav, spots: nav.spawnSpots(), home: { x: 0, z: 0 }, edge, stall: { x: 0, y: 0, z: 0 } });
  const a = s.player('a', 0, 0, ['pistol']);
  s.player('b', 0.5, 0, ['pistol']);
  const z = new ZombieGame(s.game, s.game.modes, ['a', 'b'], Date.now());
  s.game.modes.state = { kind: 'zombies', phase: 'break', until: 0, z };
  z.horde.phase = 'break';
  const zombie = (id, hp = 1000) => z.horde.zombies.set(id, { id, kind: 0, x: 5, y: 0, z: 0, yaw: 0, hp, act: 'walk' });
  return { ...s, z, a, zombie };
}

test('Zombies: no laser before buying it; the stall refuses without the coins and sells it once (item forgery, hit forgery)', () => {
  const { z, a, say, at, zombie } = zombies();
  zombie(1);
  const zap = () => {
    at(400);
    a.nextZombie = 0;
    say('a', { t: 'zhit', w: 'laser', hits: [[1, 1, 0]] });
  };
  zap(); // the page even claims it in its hands (the state's own check holds it to the guns carried)
  assert.equal(z.horde.zombies.get(1).hp, 1000, 'not carried: no harm');
  const price = priceOf('laser', 0);
  assert.equal(price, 600, 'twice the dearest gun\'s');
  z.stall.add('a', price - 1);
  a.nextBuy = 0;
  say('a', { t: 'zbuy', k: 'laser' });
  assert.equal(a.weapons.has('laser'), false, 'a coin short');
  assert.ok(a.ws.log.some((m) => m.code === 'zStallShort'));
  zap();
  assert.equal(z.horde.zombies.get(1).hp, 1000, 'still not carried');
  z.stall.add('a', 1);
  at(400);
  a.nextBuy = 0;
  say('a', { t: 'zbuy', k: 'laser', price: 0, coins: 99999 }); // nothing but the kind is read
  assert.ok(a.weapons.has('laser'), 'bought');
  assert.equal(z.stall.of('a'), 0, 'for its price');
  assert.ok(a.ws.log.some((m) => m.t === 'zgift' && m.kind === 'laser' && m.w === 'laser'), 'and told');
  a.state.w = 'pistol';
  zap(); // the state says the pistol in hand: not yet
  assert.equal(z.horde.zombies.get(1).hp, 1000, 'not in their hands');
  a.state.w = 'laser';
  zap();
  assert.equal(z.horde.zombies.get(1).hp, 1000 - LASER.body, 'now it hurts');
  // Sold once: a second is refused while carried, and costs nothing.
  z.stall.add('a', 5000);
  at(400);
  a.nextBuy = 0;
  say('a', { t: 'zbuy', k: 'laser' });
  assert.equal(z.stall.of('a'), 5000, 'nothing charged');
  assert.ok(a.ws.log.some((m) => m.code === 'zStallFull'));
});

test('Zombies: it falls only from wave LOOT.laserFrom, never when every fighter carries one, and a carrier can\'t take another (item forgery)', () => {
  const nav = makeNav({ prisms: [], height: () => 0, edge: makeBounds([[-40, -40], [40, -40], [40, 40], [-40, 40]]) });
  const walker = { id: 1, kind: 0, x: 0, y: 0, z: 0, yaw: 0 };
  const big = { ...walker, kind: BIG };
  // A dice that always says yes: something falls, and the laser if it may.
  const kinds = (wave, z = walker, lasered = false) => {
    const loot = new Loot(nav, () => 0);
    return loot.drop(z, 0, false, ['a'], false, wave, lasered).map((it) => it.kind);
  };
  for (let wave = 0; wave < LOOT.laserFrom; wave++) {
    assert.equal(kinds(wave).includes('laser'), false, `wave ${wave}`);
    assert.equal(kinds(wave, big).includes('laser'), false, `wave ${wave}, a big one`);
  }
  assert.ok(kinds(LOOT.laserFrom).includes('laser'), `wave ${LOOT.laserFrom}`);
  assert.ok(kinds(LOOT.laserFrom + 4, big).includes('laser'), 'a big one later');
  assert.equal(kinds(LOOT.laserFrom + 4, walker, true).includes('laser'), false, 'every fighter carries one');
  for (const w of [NaN, '9', null, 1e9 + 0.5]) assert.equal(kinds(w).includes('laser'), false, `wave ${w}`);
  // Rare, a big one's likelier: over many beaten zombies at wave 8 with the real dice.
  const share = (z) => {
    let n = 0, all = 0;
    for (let i = 0; i < 4000; i++) {
      const loot = new Loot(nav);
      const got = loot.drop(z, 0, false, ['a'], false, 8, false);
      all++;
      if (got.some((it) => it.kind === 'laser')) n++;
    }
    return n / all;
  };
  const walkers = share(walker), bigs = share(big);
  assert.ok(walkers > 0.002 && walkers < 0.02, `a walker: ${walkers}`);
  assert.ok(bigs > 0.2 && bigs < 0.4, `a big one: ${bigs}`);
  // Taking: a carrier leaves it lying for a teammate.
  const loot = new Loot(nav, () => 0);
  const [item] = loot.drop(walker, 0, false, ['a'], false, LOOT.laserFrom, false);
  assert.equal(loot.take('a', { x: 0, y: 0, z: 0, w: 'pistol', guns: ['pistol', 'laser'] }, item.id, 1), null, 'carried: it stays');
  assert.equal(loot.take('b', { x: 0, y: 0, z: 0, w: 'pistol', guns: ['pistol'] }, item.id, 1)?.w, 'laser', 'a teammate takes it');
  assert.equal(loot.take('c', { x: 0, y: 0, z: 0, w: 'pistol', guns: ['pistol'] }, item.id, 1), null, 'once');
});

test('Zombies: the server\'s drop knows the wave and who carries it; the laser rifle is quiet', () => {
  const { z, a, game } = zombies();
  const drops = [];
  z.loot.drop = (...args) => drops.push(args);
  z.horde.wave = 7;
  z.horde.zombies.set(9, { id: 9, kind: 0, x: 5, y: 0, z: 0, yaw: 0, hp: 0, act: 'walk' });
  z.beat(9, 'a', 'pistol');
  assert.equal(drops.at(-1)[5], 7, 'the wave');
  assert.equal(drops.at(-1)[6], false, 'nobody carries one');
  for (const p of game.players.values()) p.weapons.add('laser');
  z.horde.zombies.set(10, { id: 10, kind: 0, x: 5, y: 0, z: 0, yaw: 0, hp: 0, act: 'walk' });
  z.beat(10, 'a', 'laser');
  assert.equal(drops.at(-1)[6], true, 'everyone carries one: none falls');
  assert.ok(ZOMBIE.hear.laser > 0 && ZOMBIE.hear.laser < ZOMBIE.hear.pistol, 'heard less far than the pistol');
  assert.ok(a);
});
