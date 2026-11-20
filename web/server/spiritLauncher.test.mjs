import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Game } from './game.mjs';
import { BY, DATA } from './brookSpirit.mjs';
import { clampShot, EARLY_MS, inReach, LATE_MS, RELOAD_MS } from './spiritLauncher.mjs';
import { makeTerrain } from '../shared/terrain.mjs';

// The Brook Spirit's grenade launcher when people play together (server/spiritLauncher.mjs), with a real Game on a fake
// clock: the drop, the take from the server's positions alone, the fighters' first claim, the holder bound to a session,
// the counted grenades and the reload kept on the launcher, the `gl` and `boom` checks, the blast clamp, the hits it may
// not make, and every way it is lost.

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const WEAPONS = read('../shared/weapons.json');
const LOB = WEAPONS.launcher.lob;
const L = DATA.launcher;
const house = read('../src/data/house_shell.json');
const terrain = makeTerrain(read('../shared/terrain.json'));
const ground = (x, z) => house.ground + terrain.height(x, z);
const DROP = { x: DATA.hover[0][0], z: DATA.hover[0][1] };
DROP.y = ground(DROP.x, DROP.z);

function setup() {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const store = { addStats: async () => {}, setMeta: async () => {}, getMeta: async () => null, addCar: async () => 1, deleteCar: async () => {} };
  const game = new Game({ session: () => null, store, log: () => {} }, [], null);
  for (const t of game.timers) clearInterval(t);
  game.auth = { ...game.auth, store, session: () => null, log: () => {}, addressOf: () => '127.0.0.1' };
  game.pings = () => {};
  game.spirit.fighters = () => []; // its fight stays asleep: only its launcher is tested here
  const out = [];
  const sent = new Map();
  game.broadcast = (m, except) => out.push(structuredClone({ ...m, except }));
  game.broadcastThing = (m) => out.push(structuredClone(m));
  game.broadcastFrom = (m) => out.push(structuredClone(m));
  game.broadcastEvent = (m) => out.push(structuredClone(m));
  game.send = (ws, m) => sent.get(ws?.name)?.push(structuredClone(m));
  game.stampState = () => {};
  const sockets = new Map();
  /** `name` joins with session key `key` (`k-name` unless given). */
  const join = (name, key = `k-${name}`) => {
    sent.set(name, []);
    const on = {};
    const ws = { name, readyState: 1, OPEN: 1, send() {}, on(e, f) { on[e] = f; }, close() {}, terminate() {} };
    sockets.set(name, on);
    game.join(ws, { username: name, role: 'guest', key }, { headers: {}, socket: {} });
    const p = game.players.get(name);
    p.protectedUntil = 0;
    return p;
  };
  /** `name`'s connection drops. */
  const drop = (name) => sockets.get(name).close();
  /** `name` on the ground at (x, z), armed with gun `w`, in no drop. */
  const put = (name, x, z, w = 'rifle') => {
    const p = game.players.get(name);
    Object.assign(p.state, { x, y: ground(x, z), z, flying: false, armed: true, w });
    p.drop = null;
    return p;
  };
  const msg = (name, m) => {
    const p = game.players.get(name);
    Object.assign(p, { window: clock, msgs: 0, states: 0, others: 0 });
    game.handle(name, p, JSON.stringify(m));
  };
  const tick = (ms = 50) => {
    for (let t = 0; t < ms; t += 50) {
      clock += 50;
      for (const p of game.players.values()) if (p.alive) p.hp = 100; // nothing else downs anyone here
      game.tick();
    }
  };
  /** The spirit beaten by `by` (the simulation's event, through the server's own path). */
  const beat = (by) => game.spirit.beat({ names: by, by, drop: { ...DROP } }, clock);
  const lw = () => game.spirit.launcher;
  return { game, join, drop, put, msg, tick, beat, lw, out, sent, at: (ms) => (clock += ms), now: () => clock };
}

/** A shot as an honest page sends it: from `p`'s hand, along +x, at the gun's speed and lift. */
const shot = (p) => ({ t: 'gl', x: p.state.x, y: p.state.y + 1.5, z: p.state.z, vx: LOB.speed, vy: LOB.lift, vz: 0 });
/** ann beat it with bob, and holds the launcher in her hands. */
function holding() {
  const t = setup();
  t.join('ann');
  t.join('bob');
  t.put('bob', DROP.x + 6, DROP.z);
  t.beat(['ann', 'bob']);
  t.put('ann', DROP.x, DROP.z, 'rifle');
  t.tick(50);
  assert.equal(t.lw().l?.at, 'held');
  t.put('ann', DROP.x, DROP.z, 'launcher');
  return t;
}
const nades = (t) => t.out.filter((m) => m.t === 'nade' && m.l === 1);
const blasts = (t) => t.out.filter((m) => m.t === 'blast');

test('beaten, it lies at the drop for 3 minutes; every page hears it; the welcome carries it', () => {
  const t = setup();
  t.join('ann');
  t.beat(['ann']);
  const d = t.out.find((m) => m.t === 'sgl' && m.e === 'drop');
  assert.deepEqual([d.x, d.y, d.z, d.n, d.ms], [DROP.x, DROP.y, DROP.z, L.rounds, L.lie * 1000]);
  const w = t.game.welcome(t.game.players.get('ann'), 'ann', '#fff', t.now());
  assert.deepEqual(w.spirit.gl, { x: DROP.x, y: DROP.y, z: DROP.z, n: L.rounds, ms: L.lie * 1000 });
  t.tick(L.lie * 1000 - 100);
  assert.equal(t.lw().l?.at, 'lying');
  t.tick(150);
  assert.equal(t.lw().l, null, 'gone after its time');
  assert.ok(t.out.some((m) => m.t === 'sgl' && m.e === 'gone'));
  assert.equal(t.game.welcome(t.game.players.get('ann'), 'ann', '#fff', t.now()).spirit.gl, null);
});

test('no take without standing on it, where the server has you; not unarmed, flying, on a horse or in a drop', () => {
  const t = setup();
  const ann = t.join('ann');
  t.beat(['ann']);
  const reach = L.across / 2 + 0.35;
  t.put('ann', DROP.x + reach + 0.2, DROP.z);
  t.tick(500);
  assert.equal(t.lw().l.at, 'lying', 'a step away: nothing');
  t.put('ann', DROP.x, DROP.z);
  ann.state.y = DROP.y + L.high + 0.5;
  t.tick(100);
  assert.equal(t.lw().l.at, 'lying', 'above it: nothing');
  for (const [k, undo] of [
    [() => (ann.state.armed = false), () => (ann.state.armed = true)],
    [() => (ann.state.flying = true), () => (ann.state.flying = false)],
    [() => (ann.drop = { until: t.now() + 60_000 }), () => (ann.drop = null)],
    [() => (t.game.horseOf = () => ({ id: 0 })), () => delete t.game.horseOf],
  ]) {
    t.put('ann', DROP.x, DROP.z);
    k();
    t.tick(100);
    assert.equal(t.lw().l.at, 'lying');
    undo();
  }
  // A page that only says it stands there changes nothing: no message takes it.
  t.put('ann', DROP.x + 20, DROP.z);
  for (const m of [{ t: 'pickup', i: 0 }, { t: 'zitem', id: 1 }, { t: 'sgl', e: 'taken' }, { t: 'state', x: DROP.x, y: DROP.y, z: DROP.z, armed: true, w: 'rifle' }]) t.msg('ann', m);
  t.tick(50);
  assert.equal(t.lw().l.at, 'lying', 'a state 20 m off is held to the movement budget');
  t.put('ann', DROP.x + 0.4, DROP.z);
  t.tick(50);
  const l = t.lw().l;
  assert.deepEqual([l.at, l.key, l.n], ['held', 'k-ann', L.rounds]);
  assert.ok(ann.weapons.has('launcher'));
  const mine = t.sent.get('ann');
  const left = mine.findIndex((m) => m.t === 'sgl' && m.e === 'left' && m.n === L.rounds);
  const guns = mine.findIndex((m) => m.t === 'weapons' && m.list.includes('launcher'));
  assert.ok(left >= 0 && guns > left, 'the count, then the guns');
  assert.ok(t.out.some((m) => m.t === 'sgl' && m.e === 'taken' && m.name === 'ann' && m.except === 'ann'), 'the others hear who has it');
});

test('the first 20 s are for the sessions that hurt it; then anyone; a new session under a fighter\'s name has no claim', () => {
  const t = setup();
  t.join('ann');
  t.join('kid');
  t.beat(['ann']);
  t.put('kid', DROP.x, DROP.z);
  t.tick(L.first * 1000 - 100);
  assert.equal(t.lw().l.at, 'lying', 'kid did not fight it: not in the first 20 s');
  // ann's connection drops; someone else takes the name.
  t.drop('ann');
  t.join('ann', 'k-squat');
  t.put('ann', DROP.x + 0.3, DROP.z);
  t.put('kid', DROP.x + 10, DROP.z);
  t.tick(50);
  assert.equal(t.lw().l.at, 'lying', 'the name alone claims nothing');
  t.put('kid', DROP.x, DROP.z);
  t.put('ann', DROP.x + 10, DROP.z);
  t.tick(200);
  assert.equal(t.lw().l.at, 'held');
  assert.equal(t.lw().l.key, 'k-kid', 'after 20 s: anyone');
  // And a fighter does take it at once.
  const u = setup();
  u.join('ann');
  u.beat(['ann']);
  u.put('ann', DROP.x, DROP.z);
  u.tick(50);
  assert.equal(u.lw().l.key, 'k-ann');
});

test('six grenades and the seventh refused; the reload on the launcher; the speed and start held to an honest shot', () => {
  const t = holding();
  const ann = t.game.players.get('ann');
  const fire = () => t.lw().fire('ann', ann, shot(ann), t.now());
  assert.equal(fire(), 'ok');
  assert.equal(fire(), 'fast', 'at once again: the reload');
  t.at(RELOAD_MS - 10);
  assert.equal(fire(), 'fast');
  for (let k = 0; k < 5; k++) {
    t.at(RELOAD_MS);
    assert.equal(fire(), 'ok', `shot ${k + 2}`);
  }
  t.at(RELOAD_MS);
  assert.equal(fire(), 'holder', 'the seventh: it is empty and gone');
  assert.equal(nades(t).length, 6);
  assert.equal(t.lw().l, null);
  assert.deepEqual(t.sent.get('ann').filter((m) => m.t === 'sgl' && m.e === 'left').map((m) => m.n), [6, 5, 4, 3, 2, 1, 0]);
  assert.equal(ann.weapons.has('launcher'), false);
  assert.equal(ann.state.w, 'pistol');
  assert.ok(t.out.some((m) => m.t === 'sgl' && m.e === 'gone'));
  // The speed and the start.
  const u = holding();
  const bo = u.game.players.get('ann');
  assert.equal(u.lw().fire('ann', bo, { ...shot(bo), x: bo.state.x + 50, vx: 900, vy: 400, vz: -300 }, u.now()), 'ok');
  const n = nades(u)[0];
  assert.ok(Math.hypot(n.vx, n.vy - LOB.lift, n.vz) <= LOB.speed + 1e-9, 'speed clamped');
  assert.deepEqual([n.x, n.y, n.z], [bo.state.x, bo.state.y + 1.5, bo.state.z], 'a start 50 m off: the server\'s');
  assert.deepEqual(clampShot(3, 4, 5), { vx: 3, vy: 4, vz: 5 });
  for (const bad of [[NaN, 0, 0], ['1', 0, 0], [Infinity, 0, 0]]) assert.equal(clampShot(...bad), null);
});

test('`gl` only from the holder\'s session, holding it, alive, armed, on foot, not flying, with no game on', () => {
  const t = holding();
  const ann = t.game.players.get('ann');
  const bob = t.game.players.get('bob');
  bob.weapons.add('launcher'); // even a forged weapon set: the session decides (and the tick puts it right)
  bob.state.w = 'launcher';
  assert.equal(t.lw().fire('bob', bob, shot(bob), t.now()), 'holder');
  t.tick(50);
  assert.equal(bob.weapons.has('launcher'), false, 'put right each tick');
  const try_ = (set, undo, why) => {
    set();
    assert.equal(t.lw().fire('ann', ann, shot(ann), t.now()), why);
    undo();
  };
  try_(() => (ann.state.w = 'rifle'), () => (ann.state.w = 'launcher'), 'who');
  try_(() => (ann.state.flying = true), () => (ann.state.flying = false), 'who');
  try_(() => (ann.state.armed = false), () => (ann.state.armed = true), 'who');
  try_(() => (ann.alive = false), () => (ann.alive = true), 'who');
  try_(() => (t.game.inCar = () => true), () => delete t.game.inCar, 'who');
  try_(() => (t.game.roundOver = { until: t.now() + 1 }), () => (t.game.roundOver = null), 'who');
  for (const bad of [null, 1, {}, { x: 1, y: 2, z: 3, vx: 'a', vy: 0, vz: 0 }, { x: NaN, y: 0, z: 0, vx: 1, vy: 1, vz: 1 }]) assert.equal(t.lw().fire('ann', ann, bad, t.now()), 'bad');
  assert.equal(nades(t).length, 0);
  assert.equal(t.lw().l.n, L.rounds, 'nothing counted');
  // Through Game.handle: from a seat, a helicopter, or during a party game it never arrives; an honest one does.
  t.game.carSeats.seated = () => true;
  t.msg('ann', shot(ann));
  delete t.game.carSeats.seated;
  t.game.helis.of = () => ({ id: 'h' });
  t.msg('ann', shot(ann));
  delete t.game.helis.of;
  assert.equal(nades(t).length, 0);
  t.msg('ann', shot(ann));
  assert.equal(nades(t).length, 1);
});

test('the reload and the count survive a reconnect; 15 s away loses it unless the same session is back', () => {
  const t = holding();
  let ann = t.game.players.get('ann');
  assert.equal(t.lw().fire('ann', ann, shot(ann), t.now()), 'ok');
  t.drop('ann');
  t.tick(100);
  ann = t.join('ann');
  t.put('ann', DROP.x + 20, DROP.z, 'rifle');
  t.tick(50);
  assert.ok(ann.weapons.has('launcher'), 'back in their hands');
  assert.ok(t.sent.get('ann').some((m) => m.t === 'sgl' && m.e === 'left' && m.n === L.rounds - 1), 'with the count left');
  ann.state.w = 'launcher';
  assert.equal(t.lw().fire('ann', ann, shot(ann), t.now()), 'fast', 'a new connection does not reset the reload');
  // Away just under 15 s: kept.
  t.drop('ann');
  t.tick(L.lost * 1000 - 100);
  assert.equal(t.lw().l?.at, 'held');
  ann = t.join('ann');
  t.tick(50);
  assert.ok(ann.weapons.has('launcher'));
  // Another session under the same name gets nothing, and 15 s later it is gone.
  t.drop('ann');
  const sq = t.join('ann', 'k-squat');
  t.put('ann', DROP.x + 20, DROP.z, 'launcher');
  t.tick(50);
  assert.equal(sq.weapons.has('launcher'), false);
  sq.weapons.add('launcher');
  assert.equal(t.lw().fire('ann', sq, shot(sq), t.now()), 'holder');
  t.tick(L.lost * 1000 + 100);
  assert.equal(t.lw().l, null, 'gone');
});

test('a game starting takes it away, lying or held', () => {
  const t = holding();
  const ann = t.game.players.get('ann');
  t.game.modes.start('treasure', 'boss');
  t.tick(50);
  assert.equal(t.lw().l, null);
  assert.equal(ann.weapons.has('launcher'), false);
  assert.equal(t.lw().fire('ann', ann, shot(ann), t.now()), 'holder');
  const u = setup();
  u.join('ann');
  u.beat(['ann']);
  u.game.modes.start('treasure', 'boss');
  u.tick(50);
  assert.equal(u.lw().l, null);
  // Nor does it drop while a game is on.
  u.beat(['ann']);
  assert.equal(u.lw().l, null);
});

test('its holder goes down: it falls there with its grenades left, 60 s, for anyone', () => {
  const t = holding();
  const ann = t.game.players.get('ann');
  t.lw().fire('ann', ann, shot(ann), t.now());
  t.put('ann', DROP.x + 8, DROP.z + 2, 'launcher');
  const at = { ...ann.state };
  t.out.length = 0;
  t.game.npcDamage('ann', ann, 500, t.now(), BY, { x: DROP.x, z: DROP.z });
  t.tick(50);
  const d = t.out.find((m) => m.t === 'sgl' && m.e === 'drop');
  assert.deepEqual([d.x, d.z, d.n, d.ms], [at.x, at.z, L.rounds - 1, L.dropLie * 1000]);
  assert.equal(ann.weapons.has('launcher'), false);
  const kid = t.join('kid');
  t.put('kid', at.x, at.z);
  t.tick(50);
  assert.equal(t.lw().l.key, 'k-kid', 'anyone may take it');
  assert.equal(t.lw().l.n, L.rounds - 1);
  assert.ok(kid.weapons.has('launcher'));
  // Left lying: gone after 60 s.
  t.game.npcDamage('kid', kid, 500, t.now(), BY, { x: DROP.x, z: DROP.z });
  t.tick(L.dropLie * 1000 + 100);
  assert.equal(t.lw().l, null);
});

test('a launcher\'s `boom`: one of its own shots, 80 ms to flight + 3 s old, within that shot\'s reach; a hand grenade\'s never', () => {
  const t = holding();
  const ann = t.game.players.get('ann');
  const s = ann.state;
  const hand = { x: s.x, y: s.y + 1.5, z: s.z };
  const boom = (dx, dy = -1.5, extra = {}) => t.msg('ann', { t: 'boom', x: hand.x + dx, y: hand.y + dy, z: hand.z, l: 1, cover: [], ...extra });
  t.msg('ann', shot(ann));
  assert.equal(nades(t).length, 1);
  t.at(EARLY_MS - 30);
  boom(1);
  assert.equal(blasts(t).length, 0, 'too soon');
  t.at(600);
  boom(120);
  boom(40);
  assert.equal(blasts(t).length, 0, 'far beyond what 0.65 s of flight reaches');
  t.msg('ann', { t: 'boom', x: hand.x + 15, y: hand.y - 1.5, z: hand.z, cover: [] });
  assert.equal(blasts(t).length, 0, 'without `l`: a hand grenade\'s, and none was thrown');
  boom(15);
  assert.equal(blasts(t).length, 1, 'an honest one');
  assert.equal(blasts(t)[0].w, 'grenade');
  boom(15);
  assert.equal(blasts(t).length, 1, 'once');
  // Too late: past its flight plus 3 s.
  t.at(RELOAD_MS);
  t.msg('ann', shot(ann));
  t.at(LOB.flight * 1000 + LATE_MS + 50);
  boom(20);
  assert.equal(blasts(t).length, 1);
  // A hand grenade's boom never spends a launcher's shot.
  t.at(RELOAD_MS);
  t.msg('ann', shot(ann));
  t.at(2500);
  const lobs = ann.thrown.filter((g) => g.lob).length;
  t.msg('ann', { t: 'boom', x: hand.x + 5, y: hand.y, z: hand.z, cover: [] });
  assert.equal(ann.thrown.filter((g) => g.lob).length, lobs);
  assert.equal(blasts(t).length, 1);
  // The reach itself.
  const g = { x: 0, y: 0, z: 0, vx: 26, vy: 3, vz: 0 };
  assert.equal(inReach(g, { x: 26 * 1 + 7, y: -5, z: 0 }, 1000), true);
  assert.equal(inReach(g, { x: 26 * 1.3 + 3, y: 0, z: 0 }, 1000), false);
  assert.equal(inReach(g, { x: 0, y: 3, z: 0 }, 1000), false, 'no higher than it climbs');
  assert.equal(inReach(g, { x: 0, y: -30, z: 0 }, 1000), true, 'falling is not limited');
  assert.equal(inReach(g, { x: 61, y: -30, z: 0 }, 5000), false, 'never past its range');
  for (const bad of [null, { x: NaN, y: 0, z: 0 }, { x: '1', y: 0, z: 0 }]) assert.equal(inReach(g, bad, 1000), false);
});

test('the launcher has no bullets: a `hit` with it is refused; the zombies\' and the vehicles\' hits refuse it too', () => {
  const t = holding();
  const bob = t.game.players.get('bob');
  t.put('bob', DROP.x + 4, DROP.z);
  t.at(5000);
  const ann = t.game.players.get('ann');
  const clock = ann.nextHit;
  t.msg('ann', { t: 'hit', target: 'bob', w: 'launcher', body: 1, head: 0 });
  assert.equal(ann.nextHit, clock, 'not even counted as a shot');
  assert.equal(bob.hp, 100);
  assert.equal(t.sent.get('bob').filter((m) => m.t === 'hurt').length, 0);
  const src = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
  assert.match(src('./zombies.mjs'), /spec\.rocket \|\| spec\.lob \|\| !Array\.isArray\(m\.hits\)/);
  assert.match(src('./vehicleDamage.mjs'), /spec\.rocket \|\| spec\.lob \|\| !Number\.isInteger\(m\.n\)/);
  assert.match(src('./game.mjs'), /if \(spec\.rocket \|\| spec\.lob\) return;/);
});

test('garbage never throws', () => {
  const t = holding();
  const ann = t.game.players.get('ann');
  for (const m of [null, 5, 'x', [], { x: {}, y: [], z: null }, { vx: 1e308, vy: -1e308, vz: 1e308, x: 1e308, y: 0, z: 0 }]) {
    t.lw().fire('ann', ann, m, t.now());
    t.lw().boom('ann', ann, m, t.now());
    t.msg('ann', { ...(m && typeof m === 'object' ? m : {}), t: 'gl' });
    t.msg('ann', { ...(m && typeof m === 'object' ? m : {}), t: 'boom', l: 1 });
  }
  t.lw().drop(null);
  t.lw().drop({});
  t.tick(100);
});
