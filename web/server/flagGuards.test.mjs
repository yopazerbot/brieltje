import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';
import { NAME_RE } from './auth.mjs';
import { BACK_MS, SAFE_MS } from './flags.mjs';
import { GUARD_MAX, NEAR, RING, SEE, SKILLS, guardName } from './flagGuards.mjs';
import { fieldOf } from '../shared/flagFields.mjs';
import { noShoot } from '../shared/zones.mjs';
import { homeAt } from '../shared/homes.mjs';
import { PORTALS } from '../shared/portals.mjs';

// Steal the flag's guards (server/flagGuards.mjs), a test tool the host sets per team: they walk a round near their
// own stand, shoot opponents they see with the rifle through the server's own hit path, are tagged and come back like
// players, and count for nothing: no stats, no score, no tag for the tie, no evening points, no place in the caps.

function setup(field = 'compact') {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const added = [];
  const store = { addStats: async (name, add) => added.push([name, add]), setMeta: async () => {}, getMeta: async () => null, addCar: async () => 1, deleteCar: async () => {} };
  const game = new Game({ session: () => null, store, log: () => {} }, [], null);
  for (const t of game.timers) clearInterval(t);
  game.auth = { ...game.auth, store, session: () => null, log: () => {}, addressOf: () => '127.0.0.1', sessions: new Map(), kick: async () => {} };
  const out = [];
  game.broadcast = (m) => out.push(structuredClone(m));
  game.broadcastThing = (m) => out.push(structuredClone(m));
  game.send = () => {};
  game.stampState = () => {};
  const join = (name, role = 'player') => {
    const ws = { name, readyState: 1, OPEN: 1, send() {}, on() {}, close() {} };
    game.join(ws, { username: name, role, key: `k-${name}` }, { headers: {}, socket: {} });
    game.roles.set(name, role);
    return game.players.get(name);
  };
  const msg = (name, m) => {
    const p = game.players.get(name);
    Object.assign(p, { window: clock, msgs: 0, states: 0, others: 0 });
    game.handle(name, p, JSON.stringify(m));
  };
  const guards = game.flagGuards;
  guards.rand = () => 0.99; // never a miss, never a headshot, the patrol's first choice
  const tick = (ms = 50) => {
    clock += ms;
    for (const [n, p] of game.players) if (!p.alive && !p.guard && clock >= p.respawnAt) game.respawn(n, p, clock); // as Game.tick
    game.modes.tick(clock, ms);
    guards.tick(clock);
  };
  const run = (ms) => {
    for (let t = 0; t < ms; t += 50) tick();
  };
  const set = (team, count, skill = 'normal') => {
    guards.setAt = -Infinity;
    return game.host.act('admin', { op: 'guards', team, count, skill });
  };
  for (const n of ['ann', 'bob']) join(n);
  game.modes.start('flag', 'admin', field);
  const teams = game.modes.state.teams;
  const red = Object.keys(teams).find((n) => teams[n] === 'red');
  const blue = Object.keys(teams).find((n) => teams[n] === 'blue');
  return { game, guards, join, msg, tick, run, set, out, added, red, blue, f: fieldOf(field), now: () => clock, at: (ms) => (clock += ms) };
}

/** Stand player `p` at (x, z) on the guard's ground there, armed with the rifle, unprotected. */
function stand(s, p, x, z) {
  const nav = s.guards.rounds.blue.nav;
  Object.assign(p.state, { x, y: nav.ground(x, z), z, armed: true, w: 'rifle', flying: false });
  p.protectedUntil = 0;
}

/** One blue guard, standing still on its round (a wait it never ends), and a spot `d` m from it it sees, or not. */
function oneGuard(s, seen = true, d = 6, skill = 'normal') {
  s.set('blue', 1, skill);
  s.tick();
  const g = s.game.players.get(guardName('blue', 1));
  s.run(SAFE_MS + 100); // its protection over
  g.walk.wait = Infinity;
  const { nav } = s.guards.rounds.blue;
  const st = g.state;
  for (let a = 0; a < 64; a++) {
    for (const r of seen ? [d] : [8, 12, 16, 20, 25, 30]) {
      const x = st.x + Math.cos(a / 10) * r, z = st.z + Math.sin(a / 10) * r;
      if (!nav.walkable(x, z) || noShoot(x, z) || homeAt(x, z, nav.ground(x, z))) continue;
      if (nav.reach(st.x, st.y + 1.6, st.z, x, nav.ground(x, z) + 1.1, z) === seen) return { g, x, z };
    }
  }
  throw new Error('no spot found');
}

test('the host op: the admin sets 0 to 6 guards a team with a skill; anything forged is refused whole', () => {
  const s = setup();
  assert.deepEqual(s.set('blue', 3, 'easy'), { ok: true });
  assert.deepEqual(s.set('red', 0, 'hard'), { ok: true });
  assert.deepEqual(s.guards.want.blue, { count: 3, skill: 'easy' });
  const bad = [
    { team: '__proto__', count: 1, skill: 'easy' }, { team: 'green', count: 1, skill: 'easy' }, { team: ['blue'], count: 1, skill: 'easy' },
    { team: 'blue', count: 1.5, skill: 'easy' }, { team: 'blue', count: '2', skill: 'easy' }, { team: 'blue', count: -1, skill: 'easy' },
    { team: 'blue', count: 7, skill: 'easy' }, { team: 'blue', count: [2], skill: 'easy' }, { team: 'blue', count: NaN, skill: 'easy' },
    { team: 'blue', count: 2, skill: '__proto__' }, { team: 'blue', count: 2, skill: 'constructor' }, { team: 'blue', count: 2, skill: ['easy'] },
    { team: 'blue', count: 2 }, { count: 2, skill: 'easy' }, {}, null,
  ];
  for (const b of bad) {
    s.guards.setAt = -Infinity;
    s.game.host.actions = []; // the host page's own flood guard (ten a second) aside
    assert.equal(s.game.host.act('admin', { op: 'guards', ...b }).code, 'badValue', JSON.stringify(b));
  }
  assert.deepEqual(s.guards.want.blue, { count: 3, skill: 'easy' }, 'unchanged');
  assert.equal(Object.getPrototypeOf(s.guards.want).blue, undefined);
  // Its own rate: one change in 200 ms.
  s.guards.setAt = -Infinity;
  assert.deepEqual(s.game.host.act('admin', { op: 'guards', team: 'blue', count: 2, skill: 'easy' }), { ok: true });
  assert.equal(s.game.host.act('admin', { op: 'guards', team: 'blue', count: 4, skill: 'easy' }).code, 'tooFast');
  assert.equal(s.guards.want.blue.count, 2);
  // A player's page has no such message: nothing changes.
  s.msg(s.red, { t: 'guards', team: 'blue', count: 6, skill: 'hard' });
  s.msg(s.red, { t: 'host', op: 'guards', team: 'blue', count: 6, skill: 'hard' });
  assert.equal(s.guards.want.blue.count, 2);
  assert.equal(GUARD_MAX, 6);
});

test('guards come in a flag game only, in their team, named as no player can be; gone at the end, a stop or 0', () => {
  const s = setup();
  s.set('blue', 3);
  s.set('red', 2);
  s.tick();
  assert.equal(s.guards.size, 5);
  const names = [...s.guards.guards.keys()].sort();
  assert.deepEqual(names, ['Blue guard 1', 'Blue guard 2', 'Blue guard 3', 'Red guard 1', 'Red guard 2']);
  for (const n of names) {
    const p = s.game.players.get(n);
    assert.equal(p.guard.team, n.startsWith('Blue') ? 'blue' : 'red');
    assert.equal(s.game.modes.state.teams[n], p.guard.team);
    assert.equal(s.game.colorOf(n, p), n.startsWith('Blue') ? '#4fa3e0' : '#e5484d');
    assert.ok(s.out.some((m) => m.t === 'join' && m.name === n));
    assert.ok(s.game.roster().some((r) => r.name === n && r.role === 'guard'));
  }
  s.set('blue', 1);
  s.tick();
  assert.deepEqual([...s.guards.guards.keys()].sort(), ['Blue guard 1', 'Red guard 1', 'Red guard 2']);
  assert.ok(s.out.some((m) => m.t === 'leave' && m.name === 'Blue guard 3'));
  assert.equal(s.game.modes.state.teams['Blue guard 3'], undefined);
  // Stopped: gone, and set per game: the counts back to 0, the skills kept.
  s.game.modes.start('free', 'admin');
  assert.equal(s.guards.size, 0);
  assert.deepEqual(s.guards.want, { blue: { count: 0, skill: 'normal' }, red: { count: 0, skill: 'normal' } });
  assert.equal([...s.game.players.keys()].filter((n) => / guard /.test(n)).length, 0);
  s.tick();
  assert.equal(s.guards.size, 0, 'never outside a flag game');
  s.set('blue', 1);
  s.set('red', 2);
  s.game.modes.start('teams', 'admin');
  s.tick();
  assert.equal(s.guards.size, 0, 'not in the teams game either');
  assert.equal(s.guards.want.red.count, 2, 'set outside a flag game: kept for the next one');
  s.game.modes.start('flag', 'admin', 'village');
  s.tick();
  assert.equal(s.guards.size, 3, 'back in the next flag game');
  // The game ends (time up): gone with its result, before the evening's points.
  s.game.modes.state.f.score.blue = 1;
  s.game.modes.state.until = s.now();
  s.tick();
  assert.equal(s.game.modes.state.phase, 'done');
  assert.equal(s.guards.size, 0);
  assert.equal(Object.keys(s.game.host.scores).filter((n) => / guard /.test(n)).length, 0, 'no evening points');
  assert.equal(s.guards.want.blue.count + s.guards.want.red.count, 0, 'ended: the counts back to 0');
  s.run(11_000);
  assert.equal(s.guards.size, 0);
});

test('no name of a guard can be a username, a guest name or the admin\'s', () => {
  for (const t of ['blue', 'red']) {
    for (let i = 1; i <= GUARD_MAX; i++) {
      const n = guardName(t, i);
      assert.equal(NAME_RE.test(n), false, n);
      assert.equal(NAME_RE.test(n.toLowerCase()), false, n); // the logins lower-case what is typed, then test it
      assert.notEqual(n, n.toLowerCase(), 'an admin username from the environment is lower-cased too');
    }
  }
});

for (const field of ['compact', 'village']) {
  test(`${field}: each guard walks its round near its own stand, on open ground, never where it may not be`, () => {
    const s = setup(field);
    s.set('blue', 6);
    s.set('red', 6);
    s.tick();
    assert.equal(s.guards.size, 12);
    const edge = s.game.modes.state.f.edge;
    const moved = new Set();
    const start = new Map([...s.guards.guards].map(([n, g]) => [n, { x: g.state.x, z: g.state.z }]));
    for (let k = 0; k < 1200; k++) {
      s.tick();
      if (k % 4) continue;
      for (const [n, g] of s.guards.guards) {
        const st = g.state;
        const base = s.f.bases[g.guard.team];
        const [sx, sz] = base.stand;
        const d = Math.hypot(st.x - sx, st.z - sz);
        const nav = s.guards.rounds[g.guard.team].nav;
        assert.ok(d <= RING + 0.01 && d >= 2.9, `${n} ${d.toFixed(1)} m from its stand`);
        assert.ok(edge.inside(st.x, st.z), `${n} inside the field`);
        assert.ok(!noShoot(st.x, st.z), `${n} off the school grounds`);
        assert.ok(!homeAt(st.x, st.z, st.y), `${n} out of every home`);
        assert.ok(nav.walkable(st.x, st.z), `${n} on open ground`);
        assert.ok(PORTALS.every((p) => Math.hypot(p.x - st.x, p.z - st.z) > 4), `${n} off the portals' pads`);
        assert.ok(Math.abs(st.y - nav.ground(st.x, st.z)) < 0.05, `${n} on the ground`);
        if (Math.hypot(st.x - start.get(n).x, st.z - start.get(n).z) > 2) moved.add(n);
      }
    }
    assert.equal(moved.size, 12, 'all walk');
    for (const team of ['blue', 'red']) {
      const r = s.guards.rounds[team];
      assert.ok(r.points.length >= 6, `${team}: a round of ${r.points.length} waypoints`);
      for (const p of r.points) {
        const d = Math.hypot(p.x - r.stand[0], p.z - r.stand[1]);
        assert.ok(d >= NEAR && d <= RING);
        assert.ok(s.f.bases[team].spawns.every(([x, z]) => Math.hypot(x - p.x, z - p.z) >= 3), 'off the start places');
      }
    }
  });
}

test('a guard shoots an opponent it sees with the rifle, through the server\'s hit path: at the rifle\'s damage and rate', () => {
  const s = setup();
  const { g, x, z } = oneGuard(s);
  const p = s.game.players.get(s.red);
  stand(s, p, x, z);
  const hurt = [];
  const send = s.game.send;
  s.game.send = (ws, m) => (ws === p.ws && m.t === 'hurt' ? hurt.push([s.now(), m.hp]) : send(ws, m));
  const t0 = s.now();
  s.run(400);
  assert.equal(p.hp, 100, 'not before its reaction time');
  s.run(300);
  assert.ok(Math.abs(g.state.yaw - Math.atan2(-(p.state.x - g.state.x), -(p.state.z - g.state.z))) < 0.3 && g.state.a, 'facing its target, the gun at the eye');
  s.run(1700);
  assert.equal(p.alive, false, 'tagged');
  assert.ok(hurt.length >= 3);
  assert.deepEqual(hurt.slice(0, 3).map((h) => h[1]), [74, 48, 22], 'the rifle\'s body damage, 26 a hit');
  const kill = s.out.find((m) => m.t === 'kill' && m.victim === s.red);
  assert.equal(kill.killer, g.guard && guardName('blue', 1));
  const first = hurt[0][0] - t0;
  assert.ok(first >= SKILLS.normal.react && first < SKILLS.normal.react + LOOKMAX, `first hit after ${first} ms`);
  assert.ok(hurt[1][0] - hurt[0][0] >= 100, 'the rifle\'s fire rate');
  const shots = s.out.filter((m) => m.t === 'shot' && m.name === guardName('blue', 1));
  assert.ok(shots.length >= 4 && shots.every((m) => m.w === 'rifle'), 'everyone hears its shots');
});
const LOOKMAX = 400;

test('a guard misses by its skill: on easy most shots go wide, and no hit is to the head', () => {
  const s = setup();
  const { x, z } = oneGuard(s, true, 6, 'easy');
  const p = s.game.players.get(s.red);
  stand(s, p, x, z);
  p.hp = 10_000; // standing through it all
  let n = 7;
  s.guards.rand = () => ((n = (n * 1103515245 + 12345) % 2147483648) / 2147483648); // a fixed spread
  s.run(4000);
  const shots = s.out.filter((m) => m.t === 'shot' && m.name === 'Blue guard 1').length;
  const hits = (10_000 - p.hp) / 26;
  assert.ok(shots > 0);
  assert.ok(hits < shots * 0.6, `${hits} hits of ${shots} shots`);
  assert.equal(SKILLS.easy.head, 0);
});

test('a guard does not shoot an opponent it cannot see, further than it sees, protected, a teammate, calm or in a home', () => {
  const cases = {
    hidden: (s) => oneGuard(s, false),
    far: (s) => {
      const r = oneGuard(s, true, 6);
      const g = r.g.state;
      return { ...r, x: g.x + (r.x - g.x) * ((SEE + 3) / 6), z: g.z + (r.z - g.z) * ((SEE + 3) / 6) };
    },
    protected: (s) => oneGuard(s),
    teammate: (s) => oneGuard(s),
    calm: (s) => oneGuard(s),
    home: (s) => oneGuard(s),
    frozen: (s) => oneGuard(s),
  };
  for (const [why, find] of Object.entries(cases)) {
    const s = setup();
    const { x, z } = find(s);
    const p = s.game.players.get(why === 'teammate' ? s.blue : s.red);
    stand(s, p, x, z);
    if (why === 'protected') p.protectedUntil = s.now() + 60_000;
    if (why === 'calm') {
      const calm = s.game.calm.bind(s.game);
      s.game.calm = (q) => q === p || calm(q); // the predicate a player's shot asks (the school grounds, a drop)
    }
    if (why === 'home') {
      const inside = s.game.gate.insideOf.bind(s.game.gate);
      s.game.gate.insideOf = (q) => (q === p ? 'house' : inside(q));
    }
    if (why === 'frozen') s.game.host.frozen = { text: '' };
    s.run(3000);
    assert.equal(p.hp, 100, why);
    assert.equal(p.alive, true, why);
    if (why !== 'hidden' && why !== 'far' && why !== 'teammate') continue;
    assert.equal(s.out.filter((m) => m.t === 'shot').length, 0, `${why}: not a shot`);
  }
});

test('a guard calm itself (Game.calm says so) fires no shot at all', () => {
  const s = setup();
  const { g, x, z } = oneGuard(s);
  const p = s.game.players.get(s.red);
  stand(s, p, x, z);
  const calm = s.game.calm.bind(s.game);
  s.game.calm = (q) => q === g || calm(q);
  s.run(3000);
  assert.equal(p.hp, 100);
  assert.equal(s.out.filter((m) => m.t === 'shot').length, 0);
});

test('a guard is tagged by the other team only, through the hit path, and is back on its round 5 s later, protected', () => {
  const s = setup();
  const { g, x, z } = oneGuard(s, true, 30);
  const name = guardName('blue', 1);
  const mate = s.game.players.get(s.blue);
  stand(s, mate, g.state.x + 2, g.state.z);
  for (let k = 0; k < 6; k++) {
    s.at(200);
    s.msg(s.blue, { t: 'hit', target: name, w: 'rifle', body: 1, head: 0 });
  }
  assert.equal(g.hp, 100, 'not by a teammate');
  const p = s.game.players.get(s.red);
  stand(s, p, x, z);
  g.lookAt = Infinity; // it doesn't see them coming
  for (let k = 0; k < 4; k++) {
    s.at(200);
    s.msg(s.red, { t: 'hit', target: name, w: 'rifle', body: 1, head: 0 });
  }
  assert.equal(g.alive, false);
  assert.ok(s.out.some((m) => m.t === 'kill' && m.killer === s.red && m.victim === name));
  s.run(BACK_MS - 200);
  assert.equal(g.alive, false, 'down for the game\'s time');
  s.run(400);
  assert.equal(g.alive, true);
  assert.equal(g.hp, 100);
  assert.ok(g.protectedUntil > s.now() + SAFE_MS - 500, 'protected as a player is');
  const r = s.guards.rounds.blue;
  assert.ok(r.points.some((q) => Math.hypot(q.x - g.state.x, q.z - g.state.z) < 0.01), 'on its round');
  // A forged hit on it counts no more than on a player: a gun not held, no clock.
  const hp = g.hp;
  g.protectedUntil = 0;
  s.msg(s.red, { t: 'hit', target: name, w: 'sniper', body: 1, head: 0 });
  s.msg(s.red, { t: 'hit', target: name, w: 'rifle', body: 5, head: 0 });
  assert.equal(g.hp, hp);
});

test('nothing a guard does or suffers counts: no stats, no score, no tag for the tie', () => {
  const s = setup();
  const { g, x, z } = oneGuard(s);
  const p = s.game.players.get(s.red);
  stand(s, p, x, z);
  s.run(3000);
  assert.equal(p.alive, false);
  const f = s.game.modes.state.f;
  assert.deepEqual(f.tags, { blue: 0, red: 0 }, 'not for the tie');
  assert.deepEqual(s.added, [], 'no stored stats');
  assert.deepEqual(g.score, { kills: 0, deaths: 0, points: 0 });
  assert.equal(p.score.deaths, 0);
  // And the other way.
  s.run(BACK_MS + 3500);
  stand(s, p, x, z);
  g.lookAt = Infinity;
  g.protectedUntil = 0;
  for (let k = 0; k < 4; k++) {
    s.at(200);
    s.msg(s.red, { t: 'hit', target: guardName('blue', 1), w: 'rifle', body: 1, head: 0 });
  }
  assert.equal(g.alive, false);
  assert.deepEqual(f.tags, { blue: 0, red: 0 });
  assert.deepEqual(s.added, []);
  assert.equal(p.score.kills, 0);
});

test('a guard never touches a flag: not the other team\'s on its stand, not its own on the ground', () => {
  const s = setup();
  s.set('blue', 1);
  s.tick();
  const g = s.game.players.get(guardName('blue', 1));
  const f = s.game.modes.state.f;
  const [rx, rz, ry] = s.f.bases.red.stand;
  g.walk.wait = Infinity;
  g.lookAt = Infinity;
  Object.assign(g.state, { x: rx, y: ry, z: rz });
  g.mine = g.warp;
  s.game.modes.tick(s.now(), 50);
  assert.equal(f.flags.red.at, 'home');
  f.flags.blue = { at: 'ground', by: null, x: rx, y: ry, z: rz, since: s.now(), warp: 0 };
  s.game.modes.tick(s.now(), 50);
  assert.equal(f.flags.blue.at, 'ground', 'not sent home by a guard');
  assert.equal(f.canTouch(guardName('blue', 1), g, s.now()), false);
});

test('guards take no place: the caps count people only, and the host can\'t mute, move or kick one', async () => {
  const s = setup();
  s.set('blue', 6);
  s.set('red', 6);
  s.tick();
  s.game.rules.maxPlayers = 3;
  assert.equal(s.game.full('guest'), false, 'two players and twelve guards: room for one more');
  s.join('cid');
  assert.equal(s.game.full('guest'), true);
  const name = guardName('red', 2);
  const view = s.game.host.view();
  assert.equal(view.players.some((p) => p.name === name), false, 'not in the host\'s people');
  assert.equal(view.guards.red.count, 6);
  assert.equal(view.guards.red.here, 6);
  for (const op of ['mute', 'kick']) assert.ok(s.game.host.act('admin', { op, name, on: true }).error, op);
  s.game.host.act('admin', { op: 'teams', count: 2 });
  assert.equal(name in s.game.host.teams, false, 'never dealt into the evening\'s teams');
  assert.ok(s.game.host.act('admin', { op: 'move', name, team: 0 }).error);
  await s.game.kick(name, 'admin');
  assert.ok(s.game.players.has(name), 'a kick does nothing to it');
  assert.equal(s.out.some((m) => m.t === 'system' && m.code === 'kicked' && m.args?.name === name), false);
});

test('a guard shoots an opponent\'s car within reach through the vehicles\' own rules', () => {
  const s = setup('village');
  s.set('blue', 1);
  s.tick();
  s.run(SAFE_MS + 100);
  const g = s.game.players.get(guardName('blue', 1));
  g.walk.wait = Infinity;
  const car = s.game.cars.fb1;
  const p = s.game.players.get(s.red);
  // The guard 8 m from the car, where it sees its middle.
  const nav = s.guards.rounds.blue.nav;
  let spot = null;
  const mid = s.game.vehicleDamage.middle('car', car);
  for (let a = 0; a < 64 && !spot; a++) {
    for (const r of [5, 7, 9, 12]) {
      const x = car.x + Math.cos(a / 10) * r, z = car.z + Math.sin(a / 10) * r;
      if (!spot && nav.walkable(x, z) && nav.reach(x, nav.ground(x, z) + 1.6, z, mid.x, mid.y, mid.z)) spot = { x, z };
    }
  }
  Object.assign(g.state, { x: spot.x, z: spot.z, y: nav.ground(spot.x, spot.z) });
  car.driver = s.red;
  Object.assign(p.state, { x: car.x, y: car.y, z: car.z, armed: true });
  g.state.yaw = Math.atan2(-(car.x - spot.x), -(car.z - spot.z)); // looking its way
  s.run(3000);
  const r = s.game.vehicleDamage.recs.get('car:fb1');
  assert.ok(r && r.hp < r.max, 'the car took damage');
  assert.equal(p.alive, true, 'its driver out of a bullet\'s reach');
  // A teammate's car: never.
  const blueCar = s.game.cars.fb2;
  blueCar.driver = s.blue;
  car.driver = null;
  s.run(2000);
  assert.equal(s.game.vehicleDamage.recs.get('car:fb2'), undefined);
});

test('a player who steps into a home between two looks gets no further shot, tracer or aim from the guard', () => {
  const s = setup();
  const { g, x, z } = oneGuard(s);
  const p = s.game.players.get(s.red);
  stand(s, p, x, z);
  p.hp = 10_000; // standing through it all
  s.run(1500);
  const shots = () => s.out.filter((m) => m.t === 'shot' && m.name === guardName('blue', 1));
  assert.ok(shots().length >= 3, 'shooting while they stand outside');
  assert.ok(g.target && g.state.a);
  // Into a home, before the guard's next look: from now on the guard may not see them (homeGate).
  g.lookAt = Infinity;
  const inside = s.game.gate.insideOf.bind(s.game.gate);
  s.game.gate.insideOf = (q) => (q === p ? 'house' : inside(q));
  const before = shots().length;
  s.tick();
  const yaw = g.state.yaw;
  const pitch = g.state.pitch;
  assert.equal(g.target, null, 'dropped at once');
  assert.equal(g.state.a, false);
  assert.equal(pitch, 0);
  for (let k = 0; k < 40; k++) {
    p.state.x += k % 2 ? 3 : -2; // walking about inside
    p.state.z += 1;
    s.tick();
    assert.equal(g.state.yaw, yaw, 'its aim does not follow them');
    assert.equal(g.state.pitch, pitch);
  }
  assert.equal(shots().length, before, 'not one more shot');
  assert.ok(shots().every((m) => m.tx === undefined || !(Math.abs(m.tx - p.state.x) < 2 && Math.abs(m.tz - p.state.z) < 2)), 'no tracer ends where they stand now');
});

test('a base without a round gets no guards, says so once, and the pages are not told anything every tick', (t) => {
  const s = setup();
  // A place whose grid has no open spot near the stand.
  const ground = s.game.zombieGround.bind(s.game);
  s.game.zombieGround = (arena) => {
    const g = ground(arena);
    return { ...g, nav: Object.assign(Object.create(Object.getPrototypeOf(g.nav)), g.nav, { spawnSpots: () => [] }) };
  };
  const logged = [];
  t.mock.method(console, 'log', (line) => logged.push(String(line)));
  s.set('blue', 3);
  s.out.length = 0;
  s.run(2000);
  assert.equal(s.guards.size, 0);
  assert.equal(logged.filter((l) => l.includes('flag_guards_no_round')).length, 1, 'one line');
  assert.equal(s.out.filter((m) => m.t === 'colors' || m.t === 'mode').length, 0, 'no colours or game sent over and over');
});

test('the admin pages: guards marked on the live board, never on the evening\'s, and the host\'s bring leaves them on their round', () => {
  const s = setup();
  const admin = s.join('admin', 'admin');
  Object.assign(admin.state, { x: 600, y: 0, z: -740 });
  s.set('blue', 2);
  s.tick();
  const board = s.game.board();
  const rows = board.players.filter((p) => / guard /.test(p.name));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((p) => p.guard === true), 'marked as guards');
  assert.ok(board.players.filter((p) => !/ guard /.test(p.name)).every((p) => p.guard === undefined));
  assert.equal(board.evening.players.some((p) => / guard /.test(p.name)), false, 'not on the evening\'s board');
  const g = s.game.players.get(guardName('blue', 1));
  const at = { x: g.state.x, z: g.state.z, warp: g.warp };
  assert.deepEqual(s.game.host.act('admin', { op: 'bring', name: '*' }), { ok: true });
  assert.equal(g.warp, at.warp, 'not brought');
  assert.ok(Math.hypot(g.state.x - 600, g.state.z + 740) > 10);
  assert.ok(Math.hypot(s.game.players.get(s.red).state.x - 600, s.game.players.get(s.red).state.z + 740) < 5, 'the players are');
  s.game.host.act('admin', { op: 'bring', name: guardName('blue', 1) });
  assert.equal(g.warp, at.warp, 'nor on its own');
});

for (const field of ['compact', 'village']) {
  test(`${field}: the rounds come from the stands as the game has them, off the racks and the parked helicopters`, () => {
    const s = setup(field);
    s.set('blue', 3);
    s.set('red', 3);
    s.tick();
    const g = s.game;
    const low = [...g.helis.machines.values()].filter((h) => g.helis.atPad(h));
    assert.ok(low.length >= 2, 'both teams\' machines parked');
    for (const team of ['blue', 'red']) {
      const r = s.guards.rounds[team];
      assert.deepEqual(r.stand, s.f.bases[team].stand.slice(0, 2), 'its stand in shared/flagFields.mjs');
      for (const p of r.points) {
        for (const t of ['blue', 'red']) assert.ok(Math.hypot(p.x - s.f.bases[t].rack[0], p.z - s.f.bases[t].rack[1]) >= 2.5, 'off the rack');
        for (const h of low) assert.ok(Math.hypot(p.x - h.x, p.z - h.z) >= 7.5, `off the parked helicopter ${h.id}`);
      }
    }
    // The bases swapped mid-game (the game's own baseOf): the rounds made again round the new stands, the guards there.
    const f = g.modes.state.f;
    const swapped = { blue: s.f.bases.red, red: s.f.bases.blue };
    f.baseOf = (t) => swapped[t];
    s.tick();
    for (const [n, q] of s.guards.guards) {
      const [sx, sz] = swapped[q.guard.team].stand;
      assert.ok(Math.hypot(q.state.x - sx, q.state.z - sz) <= RING, `${n} on its new round`);
    }
    // Stands moved (as a later change of shared/flagFields.mjs will): rounds round them, on open ground, by moved().
    const moved = { compact: { blue: [528.1, -765.4], red: [755.95, -722.2] }, village: { blue: [528.1, -765.4], red: [641.5, 946.5] } }[field];
    f.baseOf = (t) => ({ ...s.f.bases[t], stand: [...moved[t], s.f.bases[t].stand[2]] });
    s.guards.moved(s.now());
    for (const team of ['blue', 'red']) {
      const r = s.guards.rounds[team];
      assert.ok(r.points.length >= 4 && r.links.every((l) => l.length), `${team}: ${r.points.length} waypoints round the moved stand, each joined`);
      for (const p of r.points) assert.ok(Math.hypot(p.x - moved[team][0], p.z - moved[team][1]) <= RING);
    }
    for (const [n, q] of s.guards.guards) assert.ok(Math.hypot(q.state.x - moved[q.guard.team][0], q.state.z - moved[q.guard.team][1]) <= RING, n);
  });
}

test('the strongmen leave the guards alone: no target, no stomp or rock on one, no death on the board if one goes down', () => {
  const s = setup();
  const { g } = oneGuard(s);
  const p = s.game.players.get(s.red);
  stand(s, p, g.state.x + 1, g.state.z);
  g.lookAt = Infinity;
  const at = { x: g.state.x, y: g.state.y, z: g.state.z };
  s.game.bruteHits(at, 3, 20, s.now());
  assert.equal(g.hp, 100, 'a stomp or a rock passes a guard by');
  assert.ok(p.hp < 100, 'and still hurts a player beside it');
  // A strongman right by the guard picks no target (only the guard is armed and near).
  p.state.armed = false;
  s.game.clowns.clear();
  s.game.clowns.set(99, s.game.character(99, g.state.x + 2, g.state.y, g.state.z, 'strongman'));
  for (let k = 0; k < 200; k++) {
    s.at(50);
    s.game.stepBrutes(s.now());
  }
  assert.equal(g.hp, 100, 'never a strongman\'s target');
  // Downed by one anyway (Game.npcDamage): nothing counts.
  s.game.npcDamage(guardName('blue', 1), g, 500, s.now());
  assert.equal(g.alive, false);
  assert.equal(g.score.deaths, 0);
  assert.deepEqual(s.added, []);
});
