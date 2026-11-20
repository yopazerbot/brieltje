import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Game } from './game.mjs';
import { Rooms } from './rooms.mjs';
import { BY, DATA, MAX_PARTS, readParts, testTuning, TOLD_MS } from './brookSpirit.mjs';
import { clearLine, lightsOf, windowCap } from '../shared/brookSpirit.mjs';
import { makeTerrain } from '../shared/terrain.mjs';

// The Brook Spirit's fight on the server (server/brookSpirit.mjs), with a real Game on a fake clock: who fights it (the
// server's state alone), every refusal of a page's `sphit`, the damage and the window's share, blasts, its hits through
// the game's own path and the way back at the wake spot, a game starting, what goes to whom, floods and garbage.

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const WEAPONS = read('../shared/weapons.json');
const house = read('../src/data/house_shell.json');
const terrain = makeTerrain(read('../shared/terrain.json'));
const ground = (x, z) => house.ground + terrain.height(x, z);
const G = DATA.grove;
const REST = { x: DATA.rest.x, z: DATA.rest.z };

/** Seeded dice (mulberry32). */
function dice(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function setup() {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const store = { addStats: async () => {}, setMeta: async () => {}, getMeta: async () => null, addCar: async () => 1, deleteCar: async () => {} };
  const game = new Game({ session: () => null, store, log: () => {} }, [], null);
  for (const t of game.timers) clearInterval(t);
  game.auth = { ...game.auth, store, session: () => null, log: () => {}, addressOf: () => '127.0.0.1' };
  game.pings = () => {};
  game.spirit.rand = dice(7);
  const out = [];
  const sent = new Map();
  game.broadcast = (m) => out.push(structuredClone(m));
  game.broadcastThing = (m) => out.push(structuredClone(m));
  game.broadcastFrom = (m) => out.push(structuredClone(m));
  game.broadcastEvent = (m) => out.push(structuredClone(m));
  game.send = (ws, m) => sent.get(ws?.name)?.push(structuredClone(m));
  game.stampState = () => {};
  const join = (name, role = 'player') => {
    sent.set(name, []);
    const ws = { name, readyState: 1, OPEN: 1, send() {}, on() {}, close() {}, terminate() {} };
    game.join(ws, { username: name, role, key: `k-${name}` }, { headers: {}, socket: {} });
    return game.players.get(name);
  };
  const watch = () => {
    sent.set('watch', []);
    game.watcher({ name: 'watch', readyState: 1, OPEN: 1, send() {}, on() {}, close() {}, terminate() {} }, { key: 'k-watch', role: 'admin' });
  };
  /** `name` on the ground at (x, z), armed with gun `w`, in no drop. */
  const put = (name, x, z, w = 'rifle') => {
    const p = game.players.get(name);
    Object.assign(p.state, { x, y: ground(x, z), z, flying: false, armed: true, w });
    p.drop = null;
    return p;
  };
  /** A page's message, through Game.handle (its flood guard reset first unless `flood`). */
  const msg = (name, m, flood = false) => {
    const p = game.players.get(name);
    if (!flood) Object.assign(p, { window: clock, msgs: 0, states: 0, others: 0 });
    game.handle(name, p, JSON.stringify(m));
  };
  /** The game's ticks for `ms`; `heal`: these players kept at full health (so no attack downs them). */
  const tick = (ms = 50, heal = []) => {
    for (let t = 0; t < ms; t += 50) {
      clock += 50;
      for (const n of heal) game.players.get(n).hp = 100;
      game.tick();
    }
  };
  /** Ticks until `pred()`, at most `max` ms; true when it came. */
  const until = (pred, max = 60_000, heal = []) => {
    for (let t = 0; t < max; t += 50) {
      if (pred()) return true;
      tick(50, heal);
    }
    return pred();
  };
  const s = () => game.spirit.s;
  return { game, join, watch, put, msg, tick, until, out, sent, s, at: (ms) => (clock += ms), now: () => clock };
}

/** Spots in the grove `r` m from its middle that see the rest past the trunks, more than 10 m from it (a bolt's reach). */
function spots(game) {
  const out = [];
  for (let r = 2; r <= 8; r += 2) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const x = G.x + Math.sin(a) * r;
      const z = G.z + Math.cos(a) * r;
      if (Math.hypot(x - REST.x, z - REST.z) > 11 && clearLine(x, z, REST.x, REST.z, game.spirit.trunks) && game.spirit.trunks.every((t) => Math.hypot(t.x - x, t.z - z) > 1)) out.push([x, z]);
    }
  }
  return out;
}

/** Players `names` in the grove, out of spawn protection, the spirit awake, its heart open. */
function fighting(names = ['ann'], opts = {}) {
  const t = setup();
  for (const n of [...names, ...(opts.others ?? [])]) t.join(n);
  t.at(5000);
  const at = spots(t.game);
  names.forEach((n, i) => t.put(n, ...at[i % at.length], opts.w ?? 'rifle'));
  t.tick(50, names);
  assert.equal(t.s().mode, 'fight', 'awake');
  if (opts.open !== false) assert.ok(t.until(() => t.s().act === 'open', 60_000, names), 'the heart opens');
  return { ...t, names };
}

const hit = (t, name, m) => t.game.spirit.hit(name, t.game.players.get(name), m, t.now());

test('test-only tuning: never in production or on Railway, only sane values', () => {
  assert.equal(testTuning({}), null);
  assert.deepEqual(testTuning({ SPIRIT_TEST_SCALE: '0.1', SPIRIT_TEST_BACK_S: '20' }), { scale: 0.1, back: 20 });
  assert.equal(testTuning({ SPIRIT_TEST_SCALE: '0.1', NODE_ENV: 'production' }), null);
  assert.equal(testTuning({ SPIRIT_TEST_SCALE: '0.1', RAILWAY_ENVIRONMENT: 'production' }), null);
  assert.equal(testTuning({ SPIRIT_TEST_SCALE: '0.1', RAILWAY_PROJECT_ID: 'x' }), null, 'any Railway variable at all');
  for (const v of ['0', '1', '2', '-1', 'x', '0.001', 'Infinity']) assert.equal(testTuning({ SPIRIT_TEST_SCALE: v }), null, v);
  for (const v of ['0', '600', '1.5', 'x', '-3']) assert.equal(testTuning({ SPIRIT_TEST_BACK_S: v }), null, v);
  assert.equal(testTuning(null), null);
  // The game itself reads the process's environment: here it has none of these, so the fight is the data's.
  const t = setup();
  assert.equal(t.game.spirit.d, DATA);
});

test('in the open world only: a room has none, and its messages do nothing', () => {
  const auth = { log() {}, addressOf: () => '192.0.2.1', sessions: new Map(), store: { addStats: async () => {}, setMeta: async () => {} } };
  const main = new Game(auth);
  const made = [];
  const rooms = new Rooms(main, (room) => {
    const g = new Game(auth, undefined, room);
    made.push(g);
    return g;
  });
  try {
    rooms.create({ username: 'anna', role: 'player' }, 'church');
    assert.ok(main.spirit, 'the open world has it');
    assert.equal(made.length, 1);
    assert.equal(made[0].spirit, null, 'a room has none');
    const p = { role: 'player', window: Date.now(), msgs: 0, states: 0, others: 0, alive: true, weapons: new Set(['rifle']), state: { x: G.x, y: G.y, z: G.z, armed: true, w: 'rifle' }, ws: { close() {}, readyState: 0, OPEN: 1 } };
    made[0].handle('anna', p, JSON.stringify({ t: 'sphit', w: 'rifle', h: [[0, 1]] }));
    assert.equal(made[0].welcome({ role: 'player', key: 'k' }, 'anna', '#fff', Date.now()).spirit, undefined, 'nor in its welcome');
  } finally {
    [main, ...made].forEach((g) => g.close());
  }
});

test('the trunks round the grove are its cover: the trees within reach, as thick as drawn', () => {
  const t = setup();
  const tr = t.game.spirit.trunks;
  assert.ok(tr.length > 20, `${tr.length} trunks`);
  assert.ok(tr.every((q) => Math.hypot(q.x - G.x, q.z - G.z) < DATA.trunks.reach && Math.abs(q.r - DATA.trunks.r) < 1e-9));
});

test('it wakes for a fighter in the grove, never for one walking the lane; an unarmed player neither wakes it nor is hit', () => {
  const t = setup();
  t.join('ann');
  t.join('kid');
  t.at(5000);
  // Along the lane, from south of the grove to north of it, armed.
  for (let z = 440; z <= 530; z += 0.35) {
    t.put('ann', -46, z);
    t.tick();
  }
  assert.equal(t.s().mode, 'asleep', 'the lane walker passes it');
  assert.equal(t.out.filter((m) => m.t === 'sp').length, 0, 'and nothing is sent');
  // Unarmed (Explore) in the middle of the grove for a minute.
  t.put('kid', G.x, G.z);
  t.game.players.get('kid').state.armed = false;
  t.put('ann', 0, 0);
  t.tick(60_000);
  assert.equal(t.s().mode, 'asleep', 'an unarmed player does not wake it');
  // Awake for an armed one: the unarmed one beside them is never a target.
  const [x, z] = spots(t.game)[0];
  t.put('ann', x, z);
  t.put('kid', x + 0.5, z);
  t.game.players.get('kid').state.armed = false;
  t.tick();
  assert.equal(t.s().mode, 'fight', 'it wakes');
  assert.deepEqual([...t.s().near], ['ann'], 'only the armed player fights');
  const sp = t.out.filter((m) => m.t === 'sp');
  assert.equal(sp.length, 1, 'waking is a change of mode: to everyone');
  t.tick(40_000, ['ann']);
  const kid = t.game.players.get('kid');
  assert.equal(kid.hp, 100, 'the unarmed player beside them is never hurt');
  assert.ok(t.out.some((m) => m.t === 'kill') || t.sent.get('ann').some((m) => m.t === 'hurt' && m.by === BY), 'the fighter is attacked');
});

test('who fights: alive, armed, on foot, not flying, in no drop, past protection, no game, no seat, within the leash', () => {
  const t = fighting(['ann'], { open: false });
  const sp = t.game.spirit;
  const p = t.game.players.get('ann');
  const now = t.now();
  assert.equal(sp.fighter('ann', p, now), true);
  const each = [
    ['dead', () => (p.alive = false), () => (p.alive = true)],
    ['unarmed', () => (p.state.armed = false), () => (p.state.armed = true)],
    ['flying', () => (p.state.flying = true), () => (p.state.flying = false)],
    ['in a drop', () => (p.drop = { until: now + 5000 }), () => (p.drop = null)],
    ['spawn protection', () => (p.protectedUntil = now + 1000), () => (p.protectedUntil = 0)],
    ['in a car', () => (Object.values(t.game.cars)[0].passenger = 'ann'), () => (Object.values(t.game.cars)[0].passenger = null)],
    ['on a bike', () => (Object.values(t.game.bikes)[0].rider = 'ann'), () => (Object.values(t.game.bikes)[0].rider = null)],
    ['on a horse', () => (t.game.horses[0].rider = 'ann'), () => (t.game.horses[0].rider = null)],
    ['a round break', () => (t.game.roundOver = { until: now + 5000 }), () => (t.game.roundOver = null)],
    ['a game on', () => (t.game.modes.state = { kind: 'treasure' }), () => (t.game.modes.state = { kind: 'free' })],
    ['past the leash', () => (p.state.x = G.x + G.leash + 0.5), () => (p.state.x = spots(t.game)[0][0])],
  ];
  for (const [what, on, off] of each) {
    on();
    assert.equal(sp.fighter('ann', p, now), false, what);
    off();
    assert.equal(sp.fighter('ann', p, now), true, `${what}: back`);
  }
  assert.equal(sp.fighter('ann', null, now), false);
  assert.equal(sp.fighter('ann', { state: { x: NaN, z: 0 } }, now), false);
});

test('sphit: every refusal one by one; nothing counts, nothing throws', () => {
  const t = fighting(['ann', 'bob'], { others: ['far'] });
  const sp = t.game.spirit;
  const ann = t.game.players.get('ann');
  const hp = () => t.s().hp;
  const h0 = hp();
  const fresh = () => {
    sp.clocks.clear();
  };
  const refused = (why, m, name = 'ann') => {
    fresh();
    const before = hp();
    assert.equal(hit(t, name, m), why, JSON.stringify(m));
    assert.equal(hp(), before, `${JSON.stringify(m)}: health unchanged`);
  };
  // The shape and the types.
  for (const m of [
    null, 5, 'x', [], {}, { w: 'rifle' }, { h: [[0, 1]] }, { w: 5, h: [[0, 1]] }, { w: 'nope', h: [[0, 1]] }, { w: 'toString', h: [[0, 1]] },
    { w: 'rifle', h: 'x' }, { w: 'rifle', h: [] }, { w: 'rifle', h: [[0]] }, { w: 'rifle', h: [[0, 1, 2]] }, { w: 'rifle', h: [0, 1] },
    { w: 'rifle', h: [[0, '1']] }, { w: 'rifle', h: [['0', 1]] }, { w: 'rifle', h: [[0.5, 1]] }, { w: 'rifle', h: [[-1, 1]] }, { w: 'rifle', h: [[9, 1]] },
    { w: 'rifle', h: [[0, 0]] }, { w: 'rifle', h: [[0, -1]] }, { w: 'rifle', h: [[0, 1.5]] }, { w: 'rifle', h: [[0, Infinity]] }, { w: 'rifle', h: [[0, 1e9]] },
  ]) refused('bad', m);
  refused('bad', { w: 'shotgun', h: [[0, 1], [1, 1], [2, 1], [3, 1]] }, 'ann'); // too many parts
  assert.equal(readParts([[0, 1], [1, 1], [2, 1], [3, 1]], 8, 8), null, `more than ${MAX_PARTS} parts`);
  refused('bad', { w: 'shotgun', h: [[0, 1], [0, 1]] }); // a part twice
  refused('bad', { w: 'rifle', h: [[0, 2]] }); // over the rifle's one pellet
  refused('bad', { w: 'shotgun', h: [[0, 5], [1, 4]] }); // over the shotgun's eight
  // The gun: carried and held, no rocket, no launcher.
  refused('weapon', { w: 'shotgun', h: [[0, 1]] }); // carried, not held
  ann.weapons.delete('sniper');
  ann.state.w = 'sniper';
  refused('weapon', { w: 'sniper', h: [[0, 1]] }); // held (as a forged page says), not carried
  for (const w of ['bazooka', 'launcher']) {
    ann.weapons.add(w);
    ann.state.w = w;
    refused('weapon', { w, h: [[0, 1]] });
    ann.weapons.delete(w);
  }
  ann.weapons.add('sniper');
  ann.state.w = 'rifle';
  // Not a fighter: from a seat, flying, dead, during a game, past the leash.
  const car = Object.values(t.game.cars)[0];
  car.passenger = 'ann';
  refused('who', { w: 'rifle', h: [[0, 1]] });
  car.passenger = null;
  ann.state.flying = true;
  refused('who', { w: 'rifle', h: [[0, 1]] });
  ann.state.flying = false;
  ann.alive = false;
  refused('who', { w: 'rifle', h: [[0, 1]] });
  ann.alive = true;
  t.put('far', G.x + G.leash + 2, G.z);
  refused('who', { w: 'rifle', h: [[0, 1]] }, 'far');
  // Too fast: one clock per player at 70 % of the gun's delay; a refused message spends it too.
  fresh();
  assert.equal(hit(t, 'ann', { w: 'rifle', h: [[0, 1]] }), 'ok');
  t.at(WEAPONS.rifle.delay * 700 - 1);
  const b = hp();
  assert.equal(hit(t, 'ann', { w: 'rifle', h: [[0, 1]] }), 'fast');
  assert.equal(hp(), b);
  t.at(2);
  assert.equal(hit(t, 'ann', { w: 'rifle', h: [[0, 1]] }), 'ok', 'after the delay');
  t.at(WEAPONS.rifle.delay * 700 + 1);
  assert.equal(hit(t, 'ann', { w: 'shotgun', h: [[0, 1]] }), 'weapon');
  t.at(10);
  assert.equal(hit(t, 'ann', { w: 'rifle', h: [[0, 1]] }), 'fast', 'the refused one spent the tick');
  t.at(WEAPONS.rifle.delay * 700);
  assert.equal(hit(t, 'ann', { w: 'rifle', h: [{}] }), 'bad');
  t.at(10);
  assert.equal(hit(t, 'ann', { w: 'rifle', h: [[0, 1]] }), 'fast', 'a malformed one too');
  // The clock goes at the held gun's pace, never the one a message names (a slow or a quick one).
  t.at(WEAPONS.rifle.delay * 700);
  assert.equal(hit(t, 'ann', { w: 'sniper', h: [[0, 1]] }), 'weapon');
  t.at(WEAPONS.rifle.delay * 700 + 1);
  assert.equal(hit(t, 'ann', { w: 'rifle', h: [[0, 1]] }), 'ok', 'a refused sniper claim holds the rifle\'s clock no longer');
  ann.state.w = 'sniper';
  t.at(WEAPONS.sniper.delay * 700 + 1);
  assert.equal(hit(t, 'ann', { w: 'pistol', h: [[0, 1]] }), 'weapon');
  t.at(WEAPONS.pistol.delay * 700 + 1);
  assert.equal(hit(t, 'ann', { w: 'sniper', h: [[0, 1]] }), 'fast', 'a refused pistol claim spends the sniper\'s clock');
  ann.state.w = 'rifle';
  // Too far from the part, by the server's positions (beyond any spot in the leash: the spirit moved for the test).
  fresh();
  const x0 = t.s().x;
  t.s().x = ann.state.x + DATA.heart.range + 1;
  refused('far', { w: 'rifle', h: [[0, 1]] });
  t.s().x = x0;
  // A light not lit (no shell up).
  refused('shut', { w: 'rifle', h: [[3, 1]] });
  // A name in the message is ignored: the session's own counts.
  fresh();
  const bobHurt = t.s().hurt.get('bob') ?? 0;
  assert.equal(hit(t, 'ann', { w: 'rifle', h: [[0, 1]], who: 'bob', name: 'bob', by: 'bob' }), 'ok');
  assert.equal(t.s().hurt.get('bob') ?? 0, bobHurt, 'nothing credited to the name in the message');
  assert.ok(t.s().hurt.get('ann') > 0);
  // The heart shut: after the window (and its 150 ms grace) every hit is refused.
  assert.ok(t.until(() => t.s().act === 'pause' && t.now() > t.s().graceUntil, 30_000, t.names));
  refused('shut', { w: 'rifle', h: [[0, 1]] });
  assert.ok(hp() < h0, 'the honest hits counted');
});

test('the damage is the gun\'s: hits times its body damage, never a number from the page', () => {
  const t = fighting(['ann']);
  const ann = t.game.players.get('ann');
  let h = t.s().hp;
  assert.equal(hit(t, 'ann', { w: 'rifle', h: [[0, 1]], d: 9999, damage: 9999 }), 'ok');
  assert.equal(h - t.s().hp, WEAPONS.rifle.body);
  t.at(1000);
  ann.state.w = 'shotgun';
  h = t.s().hp;
  assert.equal(hit(t, 'ann', { w: 'shotgun', h: [[0, 8]] }), 'ok');
  assert.equal(h - t.s().hp, 8 * WEAPONS.shotgun.body);
  t.at(1000);
  ann.state.w = 'pistol';
  h = t.s().hp;
  assert.equal(hit(t, 'ann', { w: 'pistol', h: [[0, 1]] }), 'ok');
  assert.equal(h - t.s().hp, WEAPONS.pistol.body);
});

test('the window\'s share holds against two fast shooters; the heart folds and the pages near are told', () => {
  const t = fighting(['ann', 'bob']);
  const cap = windowCap(t.s());
  const h0 = t.s().hp;
  let tries = 0;
  while (t.s().act === 'open' && tries++ < 200) {
    for (const n of t.names) t.msg(n, { t: 'sphit', w: 'rifle', h: [[0, 1]] });
    t.tick(50, t.names);
  }
  const taken = h0 - t.s().hp;
  assert.equal(taken, cap, `taken ${taken}, the share ${cap}`);
  assert.ok(tries < 60, 'they reach the share well within the window');
  assert.ok(t.sent.get('ann').some((m) => m.t === 'spe' && m.e === 'cap'), 'the cap is told');
  // Into the next window as fast as ever: health never goes under the 66 % mark while the shell is shut.
  for (let k = 0; k < 4000 && t.s().shell === null; k++) {
    for (const n of t.names) t.msg(n, { t: 'sphit', w: 'rifle', h: [[0, 1]] });
    t.tick(50, t.names);
  }
  assert.equal(t.s().hp, Math.round(DATA.phases.marks[0] * t.s().max), 'it stops at the mark');
  assert.ok(t.out.some((m) => m.t === 'sp' && m.s[10] !== 0) || t.sent.get('ann').some((m) => m.t === 'sp' && m.s[10] !== 0), 'the lit lights go out in `sp`');
  assert.ok(t.sent.get('ann').some((m) => m.t === 'spe' && m.e === 'light'), 'and as `spe` light');
  // A lit light takes the gun's damage; one not lit refuses.
  const lit = t.s().lights.findIndex((l) => l.lit);
  const unlit = t.s().lights.findIndex((l) => !l.lit);
  t.at(1000);
  const lhp = t.s().lights[lit].hp;
  assert.equal(hit(t, 'ann', { w: 'rifle', h: [[lit + 1, 1]] }), 'ok');
  assert.equal(lhp - t.s().lights[lit].hp, WEAPONS.rifle.body);
  t.at(1000);
  assert.equal(hit(t, 'ann', { w: 'rifle', h: [[unlit + 1, 1]] }), 'shut');
});

test('a blast counts for a thrower who fights it, never for one who does not', () => {
  const t = fighting(['ann'], { others: ['far'] });
  t.put('far', 0, 0);
  const s = t.s();
  const at = { x: s.x, y: s.y, z: s.z };
  let h = s.hp;
  t.game.blast('far', at, 'grenade');
  assert.equal(s.hp, h, 'a thrower far away: nothing');
  t.put('far', G.x + G.leash + 1, G.z);
  t.game.blast('far', at, 'grenade');
  assert.equal(s.hp, h, 'past the leash: nothing');
  const ann = t.game.players.get('ann');
  ann.state.flying = true;
  t.game.blast('ann', at, 'grenade');
  assert.equal(s.hp, h, 'flying: nothing');
  ann.state.flying = false;
  t.game.blast('ann', at, 'wreck');
  assert.equal(s.hp, h, 'a wreck\'s blast: nothing');
  t.game.blast('ann', at, 'grenade');
  assert.ok(s.hp < h, 'a fighter\'s grenade at the open heart counts');
  assert.ok(h - s.hp <= DATA.heart.most);
  h = s.hp;
  t.game.blast('ann', { x: at.x + DATA.heart.blast + 1, y: at.y, z: at.z }, 'bazooka');
  assert.equal(s.hp, h, 'out of reach: nothing');
});

test('its hit downs a player through the game\'s own path; they come back at the wake spot, others as ever', () => {
  const t = fighting(['ann'], { open: false, others: ['bob'] });
  const ann = t.game.players.get('ann');
  ann.hp = 1;
  assert.ok(t.until(() => !ann.alive, 120_000), 'downed');
  const kill = t.out.find((m) => m.t === 'kill');
  assert.deepEqual([kill.killer, kill.victim, kill.w], [BY, 'ann', 'spirit'], 'in the kill feed');
  assert.equal(ann.score.deaths, 1);
  t.out.length = 0;
  t.tick(3100);
  assert.ok(ann.alive, 'back after the usual wait');
  const back = t.out.find((m) => m.t === 'respawn' && m.name === 'ann');
  assert.deepEqual([back.x, back.z, back.drop], [DATA.wake.x, DATA.wake.z, undefined], 'at the wake spot, on the ground');
  assert.ok(Math.abs(ann.state.y - ground(DATA.wake.x, DATA.wake.z)) < 0.05, 'on the relief');
  // Downed by something else: the usual respawn.
  const bob = t.game.players.get('bob');
  t.put('bob', 0, 0);
  t.game.npcDamage('bob', bob, 200, t.now(), 'a strongman');
  t.out.length = 0;
  t.tick(3100);
  const other = t.out.find((m) => m.t === 'respawn' && m.name === 'bob');
  assert.ok(other && other.x !== DATA.wake.x, 'not at the wake spot');
  // Downed by it but back later than the memory (a round break held them): the usual respawn too.
  const sp = t.game.spirit;
  sp.downed.set(ann, { at: t.now() - DATA.down.memory * 1000 - 1, respawnAt: ann.respawnAt });
  assert.equal(sp.wakes(ann, t.now()), false);
  assert.equal(sp.wakes(ann, t.now()), false, 'asked once');
  // Downed by it, brought back some other way (a new round), then downed by a strongman within the memory: not its doing.
  t.put('ann', ...spots(t.game)[0]);
  ann.protectedUntil = 0;
  ann.hp = 1;
  assert.ok(t.until(() => !ann.alive, 120_000), 'downed again');
  t.game.newRound('test', 'newRound', {});
  assert.ok(ann.alive, 'back by the new round');
  t.at(1000);
  t.game.npcDamage('ann', ann, 200, t.now(), 'a strongman');
  t.out.length = 0;
  t.tick(3100);
  const third = t.out.find((m) => m.t === 'respawn' && m.name === 'ann');
  assert.ok(third && third.x !== DATA.wake.x, 'the strongman\'s: the usual respawn');
  // Downed by it as a game starts: the game's own respawn.
  t.game.modes.state = { kind: 'treasure' };
  sp.downed.set(ann, { at: t.now(), respawnAt: ann.respawnAt });
  assert.equal(sp.wakes(ann, t.now()), false, 'no wake spot during a game');
  t.game.modes.state = { kind: 'free' };
});

test('a game starting resets it, asleep and absent until the game ends', () => {
  const t = fighting(['ann']);
  hit(t, 'ann', { w: 'rifle', h: [[0, 1]] });
  assert.ok(t.s().hp < t.s().max);
  t.out.length = 0;
  t.game.modes.start('treasure', 'boss');
  assert.ok(t.game.modes.active);
  t.tick(100, ['ann']);
  assert.equal(t.s().mode, 'asleep');
  assert.equal(t.s().hp, t.s().max);
  const sp = t.out.filter((m) => m.t === 'sp');
  assert.equal(sp.length, 1, 'the change of mode: to everyone, once');
  assert.equal(sp[0].s[0], 0, 'asleep');
  // The game took everyone to the house; even someone standing in the grove (only a forged page) wakes nothing.
  const [x, z] = spots(t.game)[0];
  const ann = t.put('ann', x, z);
  ann.protectedUntil = 0;
  t.at(1000);
  assert.equal(hit(t, 'ann', { w: 'rifle', h: [[0, 1]] }), 'who', 'nobody fights it during a game');
  for (let k = 0; k < 400; k++) {
    t.at(50);
    t.game.spirit.tick(t.now());
  }
  assert.equal(t.s().mode, 'asleep', 'it stays asleep during the game');
  assert.equal(t.sent.get('ann').filter((m) => m.t === 'hurt').length, 0);
  t.game.modes.start('free', 'boss');
  t.put('ann', x, z).protectedUntil = 0;
  t.tick(100, ['ann']);
  assert.equal(t.s().mode, 'fight', 'after it, it wakes again');
});

test('`sp` goes to the pages near and the watch views, 5 a second while awake; nothing while asleep; `welcome.spirit`', () => {
  const t = setup();
  for (const n of ['ann', 'near', 'far']) t.join(n);
  t.watch();
  t.at(5000);
  const w = t.sent.get('watch').find((m) => m.t === 'welcome');
  assert.deepEqual(w.spirit.s.slice(0, 2), [0, 1], 'the watch view\'s welcome carries it, asleep');
  const wel = t.game.welcome(t.game.players.get('ann'), 'ann', '#fff', t.now());
  assert.equal(wel.spirit.s.length, 11, 'so does a page\'s');
  t.put('near', G.x + 250, G.z);
  t.put('far', G.x + 320, G.z);
  t.tick(2000);
  assert.equal([...t.sent.values()].flat().filter((m) => m.t === 'sp').length, 0, 'nothing while asleep');
  const [x, z] = spots(t.game)[0];
  t.put('ann', x, z);
  t.tick(50, ['ann']);
  assert.equal(t.out.filter((m) => m.t === 'sp').length, 1, 'waking: to everyone');
  for (const v of t.sent.values()) v.length = 0;
  t.tick(10_000, ['ann']);
  const n = (name) => t.sent.get(name).filter((m) => m.t === 'sp').length;
  assert.ok(n('ann') >= 50 && n('ann') <= 80, `the fighter: ${n('ann')} in 10 s`);
  assert.equal(n('near'), n('ann'), 'a page within 300 m: the same');
  assert.equal(n('watch'), n('ann'), 'a watch view: the same');
  assert.equal(n('far'), 0, 'a page farther away: none');
  const last = t.sent.get('ann').filter((m) => m.t === 'sp').at(-1);
  assert.equal(last.s.length, 11);
  assert.ok(last.s.every((v) => typeof v === 'number' && Number.isFinite(v)));
  assert.equal(t.sent.get('far').filter((m) => m.t === 'spe').length, 0, 'nor its one-shot effects');
});

test('a flier or a shooter past the leash is told why, at most once every 5 s; others are not', () => {
  const t = fighting(['ann'], { others: ['fly', 'far', 'dead'] });
  t.put('fly', G.x + 3, G.z);
  t.game.players.get('fly').state.flying = true;
  t.put('far', G.x + G.leash + 5, G.z);
  t.put('dead', G.x + 4, G.z);
  t.game.players.get('dead').alive = false;
  for (let k = 0; k < 20; k++) {
    for (const n of ['fly', 'far', 'dead']) t.msg(n, { t: 'sphit', w: 'rifle', h: [[0, 1]] });
    t.at(200);
  }
  const lines = (n) => t.sent.get(n).filter((m) => m.t === 'system');
  assert.deepEqual(lines('fly').map((m) => m.code), ['spFly'], 'the flier: once in 4 s');
  assert.deepEqual(lines('far').map((m) => m.code), ['spFar']);
  assert.deepEqual(lines('dead'), []);
  t.at(TOLD_MS);
  t.msg('fly', { t: 'sphit', w: 'rifle', h: [[0, 1]] });
  assert.equal(lines('fly').length, 2, 'again after 5 s');
});

test('a flood of sphit is held by the flood guard; garbage never throws', () => {
  const t = fighting(['ann']);
  const sp = t.game.spirit;
  let reached = 0;
  const real = sp.hit.bind(sp);
  sp.hit = (...a) => (reached++, real(...a));
  const h = t.s().hp;
  Object.assign(t.game.players.get('ann'), { window: t.now(), msgs: 0, states: 0, others: 0 }); // the second begins
  for (let k = 0; k < 500; k++) t.msg('ann', { t: 'sphit', w: 'rifle', h: [[0, 1]] }, true);
  assert.ok(reached <= 40, `${reached} of 500 reached the spirit in one second`);
  assert.equal(h - t.s().hp, WEAPONS.rifle.body, 'of which one counted (the clock)');
  sp.hit = real;
  // Garbage, through Game.handle and straight in.
  const rand = dice(3);
  const any = (d = 0) => {
    const k = Math.floor(rand() * 9);
    if (d > 2) return k;
    return [null, true, -1, 1e308, 'rifle', [any(d + 1), any(d + 1)], { w: any(d + 1), h: any(d + 1) }, [[0, 1]], NaN][k];
  };
  for (let k = 0; k < 3000; k++) {
    const m = { t: 'sphit', w: any(), h: any() };
    t.msg('ann', m);
    assert.doesNotThrow(() => sp.hit('ann', t.game.players.get('ann'), any(), t.now()));
    t.at(7);
  }
  for (const p of [null, undefined, {}, { state: null }, { state: { x: 'a' } }, { key: 5, state: { x: G.x, z: G.z } }]) assert.doesNotThrow(() => sp.hit('x', p, { w: 'rifle', h: [[0, 1]] }, t.now()));
  for (const bad of [[null, 0], ['ann', NaN], [5, t.now()]]) assert.doesNotThrow(() => sp.hit(bad[0], t.game.players.get('ann'), { w: 'rifle', h: [[0, 1]] }, bad[1]));
  assert.doesNotThrow(() => sp.blast('ann', t.game.players.get('ann'), null, 'grenade', 5, 100, t.now()));
  assert.doesNotThrow(() => sp.blast('ann', t.game.players.get('ann'), { x: NaN, y: 0, z: 0 }, 'grenade', 5, 100, t.now()));
  assert.ok(t.s().hp > 0 && Number.isFinite(t.s().hp));
});

test('beaten: harmless, told to everyone with at most 8 names, gone, back after its time; `by` and `drop` kept', () => {
  const t = fighting(['ann', 'bob']);
  const sp = t.game.spirit;
  let told = null;
  sp.onBeaten = (b) => (told = b);
  // Down to a sliver, past both shells, as the simulation would leave it: the next counted hit ends it.
  Object.assign(t.s(), { shells: DATA.phases.marks.length, phase: 3, hp: 10 });
  t.at(1000);
  assert.equal(hit(t, 'ann', { w: 'rifle', h: [[0, 1]] }), 'ok');
  assert.equal(t.s().mode, 'apart');
  const line = t.out.find((m) => m.t === 'system' && m.code === 'spBeaten');
  assert.ok(line && line.args.names.includes('ann') && line.args.names.length <= 8, JSON.stringify(line));
  assert.ok(t.sent.get('bob').some((m) => m.t === 'spe' && m.e === 'beaten' && Array.isArray(m.names)));
  assert.ok(told && told.by.includes('ann') && Number.isFinite(told.drop.x), 'the launcher\'s seam: by and drop');
  assert.deepEqual(sp.beaten, told);
  t.tick(DATA.beaten.apart * 1000 + 100, t.names);
  assert.equal(t.s().mode, 'gone');
  assert.equal(t.out.filter((m) => m.t === 'sp').at(-1).s[0], 4, 'gone: to everyone');
  const hurt = t.names.map((n) => t.game.players.get(n).hp);
  t.at(60_000);
  t.tick(100, []);
  assert.deepEqual(t.names.map((n) => t.game.players.get(n).hp), hurt, 'gone, it hurts nobody');
  t.at(DATA.beaten.back * 1000);
  t.tick(100, t.names);
  assert.ok(['asleep', 'fight'].includes(t.s().mode), 'back after its time');
  assert.ok(t.sent.get('ann').some((m) => m.t === 'spe' && m.e === 'back'));
});

test('a seat, a horse or a flight never reaches the spirit through Game.handle, and the lights are the data\'s', () => {
  const t = fighting(['ann']);
  const h = t.s().hp;
  Object.values(t.game.cars)[0].driver = 'ann';
  t.msg('ann', { t: 'sphit', w: 'rifle', h: [[0, 1]] });
  Object.values(t.game.cars)[0].driver = null;
  t.game.horses[0].rider = 'ann';
  t.at(500);
  t.msg('ann', { t: 'sphit', w: 'rifle', h: [[0, 1]] });
  t.game.horses[0].rider = null;
  assert.equal(t.s().hp, h);
  assert.deepEqual(t.s().lights.map(({ x, y, z }) => [x, y, z]), lightsOf(DATA).map(({ x, y, z }) => [x, y, z]));
});
