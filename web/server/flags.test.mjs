import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';
import { BACK_MS, CAPTURE, FLAG_MS, RETURN_MS, SAFE_MS, SUDDEN_MS, TOUCH } from './flags.mjs';
import { FIELDS, fieldOf } from '../shared/flagFields.mjs';
import { NO_SHOOT, noShoot } from '../shared/zones.mjs';
import { PORTALS, REACH } from '../shared/portals.mjs';
import { HOMES, homeAt } from '../shared/homes.mjs';

// Steal the flag (server/flags.mjs, driven from server/modes.mjs): blue at the church against red at Molenhoek or the
// Sparrenhof. Every flag event is the server's, from where it has the players: no message takes, drops or scores a flag.

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
  /** A message from `name`'s page, the flood guards let go. */
  const msg = (name, m) => {
    const p = game.players.get(name);
    Object.assign(p, { window: clock, msgs: 0, states: 0, others: 0, nextCar: 0, nextTravelAsk: 0, nextTravel: 0 });
    game.handle(name, p, JSON.stringify(m));
  };
  const tick = (ms = 50) => {
    clock += ms;
    game.modes.tick(clock, ms);
  };
  /** Stand `name` at (x, z) on the ground `y`, on foot. */
  const put = (name, x, z, y) => Object.assign(game.players.get(name).state, { x, y, z, flying: false });
  const lines = (name) => sent.get(name).filter((m) => m.t === 'system' || m.t === 'travel').map((m) => m.code);
  const events = () => out.filter((m) => m.t === 'flag').map((m) => `${m.ev}:${m.team}:${m.name}`);
  return { game, join, msg, tick, put, lines, events, out, sent, leave: (name) => closers.get(name)(), at: (ms) => (clock += ms), now: () => clock };
}

/** Four players, two a side, in Steal the flag on `field`; `teams`: the names on blue and on red. */
function four(field = 'compact', opts = {}) {
  const s = setup();
  for (const n of ['ann', 'bob', 'cid', 'dee']) s.join(n);
  s.game.modes.start('flag', 'admin', field, opts);
  const teams = s.game.modes.state.teams;
  const blue = Object.keys(teams).filter((n) => teams[n] === 'blue');
  const red = Object.keys(teams).filter((n) => teams[n] === 'red');
  const f = fieldOf(field);
  const stand = (team) => f.bases[team].stand;
  /** Stand `name` on `team`'s stand. */
  const onStand = (name, team) => s.put(name, stand(team)[0], stand(team)[1], stand(team)[2]);
  return { ...s, blue, red, f, stand, onStand, flag: () => s.game.modes.state.f };
}

test('the game starts: two even teams, everyone at their own base, a fight between the teams only', () => {
  const s = four();
  assert.equal(s.blue.length, 2);
  assert.equal(s.red.length, 2);
  assert.equal(s.game.modes.teamMatch, true);
  assert.equal(s.game.modes.peaceful, false);
  assert.equal(s.game.fenced(), false, 'not fenced round the houses: its field is the edge');
  assert.equal(s.game.fence(), s.flag().edge);
  for (const team of ['blue', 'red']) {
    const [sx, sz] = s.stand(team);
    for (const n of team === 'blue' ? s.blue : s.red) {
      const st = s.game.players.get(n).state;
      assert.ok(Math.hypot(st.x - sx, st.z - sz) < 15, `${n} starts at the ${team} base`);
    }
  }
  assert.equal(s.game.modes.friends(s.blue[0], s.blue[1]), true);
  assert.equal(s.game.modes.friends(s.blue[0], s.red[0]), false);
  const v = s.game.modes.view();
  assert.equal(v.kind, 'flag');
  assert.deepEqual(v.flag.flags.blue.at, 'home');
  assert.deepEqual(v.colors, { blue: '#4fa3e0', red: '#e5484d' });
});

test('take: walking into the other team\'s flag takes it; your own on its stand stays, out of reach nothing', () => {
  const s = four();
  const [b] = s.blue;
  const [r] = s.red;
  const [bx, bz, by] = s.stand('blue');
  s.put(r, bx + TOUCH + 0.5, bz, by);
  s.tick();
  assert.equal(s.flag().flags.blue.at, 'home', 'too far');
  s.put(r, bx + TOUCH - 0.3, bz, by + HIGHER);
  s.tick();
  assert.equal(s.flag().flags.blue.at, 'home', 'too high (on a roof above it)');
  s.onStand(b, 'blue');
  s.tick();
  assert.equal(s.flag().flags.blue.at, 'home', 'its own team does not take it');
  s.put(r, bx + TOUCH - 0.3, bz, by);
  s.tick();
  assert.equal(s.flag().flags.blue.at, 'carried');
  assert.equal(s.flag().flags.blue.by, r);
  assert.equal(s.game.modes.carrying(r), 'blue');
  assert.deepEqual(s.events(), [`taken:blue:${r}`]);
});
const HIGHER = 3;

test('take: not from a car, a helicopter seat or while dead', () => {
  const s = four();
  const [r] = s.red;
  const p = s.game.players.get(r);
  s.onStand(r, 'blue');
  p.alive = false;
  s.tick();
  assert.equal(s.flag().flags.blue.at, 'home', 'down');
  p.alive = true;
  s.game.carOf = (n) => (n === r ? {} : null);
  s.tick();
  assert.equal(s.flag().flags.blue.at, 'home', 'in a car');
});

test('score only with your own flag home; a capture counts once and both flags are home after it', () => {
  const s = four();
  const [b] = s.blue;
  const [r] = s.red;
  // Red takes blue's flag, blue takes red's.
  s.onStand(r, 'blue');
  s.onStand(b, 'red');
  s.tick();
  assert.equal(s.flag().flags.blue.by, r);
  assert.equal(s.flag().flags.red.by, b);
  // Red's carrier home: no score while red's own flag is away.
  s.onStand(r, 'red');
  s.put(b, 100, 100, 0); // blue's carrier somewhere else
  s.tick();
  assert.equal(s.flag().score.red, 0);
  assert.equal(s.flag().flags.blue.by, r, 'still carried');
  // Blue's carrier goes down: red's flag drops; a red player touches it: home. Now red scores.
  s.game.players.get(b).alive = false;
  s.tick();
  assert.equal(s.flag().flags.red.at, 'ground');
  const [, r2] = s.red;
  const f = s.flag().flags.red;
  s.put(r2, f.x, f.z, f.y);
  s.tick();
  assert.equal(s.flag().flags.red.at, 'home', 'returned by its own team');
  s.tick();
  assert.equal(s.flag().score.red, 1, 'red scores once its own flag is home');
  assert.equal(s.flag().flags.blue.at, 'home', 'the captured flag is back on its stand');
  s.tick();
  assert.equal(s.flag().score.red, 1, 'once');
  assert.ok(s.events().includes(`captured:blue:${r}`));
  assert.ok(s.events().includes(`returned:red:${r2}`));
});

test('a capture at your stand is within CAPTURE m on foot, and from a car a little further', () => {
  const s = four();
  const [r] = s.red;
  s.onStand(r, 'blue');
  s.tick();
  const [rx, rz, ry] = s.stand('red');
  s.put(r, rx + CAPTURE + 1, rz, ry);
  s.tick();
  assert.equal(s.flag().score.red, 0);
  s.game.carOf = (n) => (n === r ? { driver: r } : null); // driving: the car's middle within CAPTURE_CAR
  s.tick();
  assert.equal(s.flag().score.red, 1);
});

test('drop: the carrier down drops it where they fell; a teammate picks it up by touch and goes on', () => {
  const s = four();
  const [b] = s.blue;
  const [r, r2] = s.red;
  s.onStand(r, 'blue');
  s.tick();
  s.put(r, 600, -740, 6);
  s.tick();
  const victim = s.game.players.get(r);
  s.game.damage(b, s.game.players.get(b), r, victim, 500, false, 'rifle', s.now());
  assert.equal(victim.alive, false);
  s.tick();
  const f = s.flag().flags.blue;
  assert.equal(f.at, 'ground');
  assert.deepEqual([f.x, f.z], [600, -740]);
  assert.ok(s.events().includes(`dropped:blue:${r}`));
  // Back after BACK_MS, at red's base, protected for SAFE_MS.
  assert.equal(victim.respawnAt, s.now() - 50 + BACK_MS);
  s.at(BACK_MS);
  s.game.tick();
  assert.equal(victim.alive, true);
  const [rx, rz] = s.stand('red');
  assert.ok(Math.hypot(victim.state.x - rx, victim.state.z - rz) < 15, 'back at red\'s base');
  assert.ok(victim.protectedUntil - Date.now() === SAFE_MS, 'protected for SAFE_MS');
  // The teammate picks it up.
  s.put(r2, 600.5, -740, 6);
  s.tick();
  assert.equal(s.flag().flags.blue.by, r2);
});

test('drop: a carrier who leaves the game drops it where the server had them last', () => {
  const s = four();
  const [r] = s.red;
  s.onStand(r, 'blue');
  s.tick();
  s.put(r, 610, -745, 6);
  s.tick();
  s.leave(r);
  const f = s.flag().flags.blue;
  assert.equal(f.at, 'ground');
  assert.deepEqual([f.x, f.z], [610, -745]);
});

test('drop: moved by the server (the host bringing them) drops it where they stood before', () => {
  const s = four();
  const [r] = s.red;
  s.onStand(r, 'blue');
  s.tick();
  s.put(r, 615, -745, 6);
  s.tick();
  s.join('host', 'admin');
  s.put('host', 700, -720, 7);
  s.game.bring('host', r);
  s.tick();
  const f = s.flag().flags.blue;
  assert.equal(f.at, 'ground');
  assert.deepEqual([f.x, f.z], [615, -745]);
});

test('return: the flag\'s own team touching it sends it home at once; left alone it goes home after 30 s', () => {
  const s = four();
  const [b] = s.blue;
  const [r] = s.red;
  s.onStand(r, 'blue');
  s.tick();
  s.put(r, 600, -740, 6);
  s.tick();
  s.game.players.get(r).alive = false;
  s.tick();
  assert.equal(s.flag().flags.blue.at, 'ground');
  s.put(b, 600 + TOUCH - 0.2, -740, 6);
  s.tick();
  assert.equal(s.flag().flags.blue.at, 'home');
  // Again, nobody touches it: home after RETURN_MS, not before.
  const p = s.game.players.get(r);
  p.alive = true;
  s.put(b, 0, 0, 0);
  s.onStand(r, 'blue');
  s.tick();
  s.put(r, 600, -740, 6);
  s.tick();
  p.alive = false;
  s.tick();
  s.put(r, 0, 0, 0);
  s.at(RETURN_MS - 1000);
  s.tick();
  assert.equal(s.flag().flags.blue.at, 'ground');
  s.at(1000);
  s.tick();
  assert.equal(s.flag().flags.blue.at, 'home');
  assert.equal(s.events().at(-1), 'returned:blue:');
});

test('the clock: most captures wins when time is up; the programme\'s minutes set it', () => {
  const s = four('compact', { minutes: 2 });
  assert.equal(s.game.modes.state.until - s.now(), 120_000);
  const [r] = s.red;
  s.onStand(r, 'blue');
  s.tick();
  s.onStand(r, 'red');
  s.tick();
  assert.equal(s.flag().score.red, 1);
  s.at(120_000);
  s.tick();
  assert.equal(s.game.modes.state.phase, 'done');
  assert.equal(s.game.modes.state.resultCode, 'flagWon');
  assert.equal(s.game.modes.state.resultArgs.team, 'red');
  const d = setup();
  d.join('a');
  d.join('b');
  d.game.modes.start('flag', 'admin', 'compact');
  assert.equal(d.game.modes.state.until - d.now(), FLAG_MS, 'twelve minutes by default');
});

test('sudden death: level when time is up, the next capture wins', () => {
  const s = four();
  s.at(FLAG_MS);
  s.tick();
  assert.equal(s.game.modes.state.phase, 'playing');
  assert.equal(s.flag().sudden, true);
  assert.equal(s.game.modes.state.until - s.now(), SUDDEN_MS);
  assert.ok(s.out.some((m) => m.code === 'flagSuddenStart'));
  const [b] = s.blue;
  s.onStand(b, 'red');
  s.tick();
  s.onStand(b, 'blue');
  s.tick();
  assert.equal(s.game.modes.state.phase, 'done');
  assert.equal(s.game.modes.state.resultCode, 'flagWon');
  assert.equal(s.game.modes.state.resultArgs.team, 'blue');
});

test('the tie: still level after sudden death, most tags; still level, a draw', () => {
  const s = four();
  const [b] = s.blue;
  const [r] = s.red;
  s.game.damage(b, s.game.players.get(b), r, s.game.players.get(r), 500, false, 'rifle', s.now());
  assert.deepEqual(s.flag().tags, { blue: 1, red: 0 });
  s.game.damage(b, s.game.players.get(b), s.blue[1], s.game.players.get(s.blue[1]), 500, false, 'rifle', s.now());
  assert.deepEqual(s.flag().tags, { blue: 1, red: 0 }, 'a teammate down is no tag');
  s.at(FLAG_MS);
  s.tick();
  s.at(SUDDEN_MS);
  s.tick();
  assert.equal(s.game.modes.state.resultCode, 'flagTagsWon');
  assert.equal(s.game.modes.state.resultArgs.team, 'blue');
  const d = four();
  d.at(FLAG_MS);
  d.tick();
  d.at(SUDDEN_MS);
  d.tick();
  assert.equal(d.game.modes.state.resultCode, 'flagDraw');
});

test('the carrier is refused a portal, a trip from the chat and a helicopter seat, each with a line saying why', () => {
  const s = four('village', { look: 'real' });
  const [r] = s.red;
  s.game.rules.portals = s.game.rules.travel = true;
  s.onStand(r, 'blue');
  s.tick();
  const church = PORTALS.find((p) => p.id === 'church');
  s.put(r, church.x, church.z, 4.7);
  s.msg(r, { t: 'travel', to: 'sparrenhof' });
  s.msg(r, { t: 'travel', to: 'sparrenhof', via: 'chat' });
  s.msg(r, { t: 'heli', op: 'in', id: 'church' });
  assert.deepEqual(s.lines(r), ['flagNoTravel', 'flagNoTravel', 'flagHeli']);
  assert.equal(s.flag().flags.blue.by, r, 'still carried, nowhere else');
});

test('nobody travels while it is played: a portal, the chat and a start place refused for a non-carrier in both fields; the teams game as before', () => {
  for (const field of ['compact', 'village']) {
    const s = four(field);
    const [b] = s.blue;
    s.game.rules.portals = s.game.rules.travel = true;
    const church = PORTALS.find((p) => p.id === 'church');
    s.put(b, church.x, church.z, 4.7);
    s.msg(b, { t: 'travel', to: field === 'village' ? 'sparrenhof' : 'molenhoek' });
    s.msg(b, { t: 'travel', to: 'molenhoek', via: 'chat' });
    const p = s.game.players.get(b);
    Object.assign(p, { spawned: false, joinedAt: { x: p.state.x, z: p.state.z }, joinTime: s.now() });
    s.msg(b, { t: 'spawn', to: 'church' });
    assert.deepEqual(s.lines(b), ['flagNoTravel', 'flagNoTravel', 'flagNoTravel'], field);
    assert.ok(!s.out.some((m) => m.t === 'travel' && m.ok), `${field}: nobody went anywhere`);
    assert.equal(s.sent.get(b).filter((m) => m.t === 'spawn' && m.ok === false).length, 1, 'the start place refused');
  }
  const t = setup();
  t.join('ann');
  t.join('bob');
  t.game.modes.start('teams', 'admin');
  t.msg('ann', { t: 'travel', to: 'church', via: 'chat' });
  assert.deepEqual(t.lines('ann'), ['travelGame'], 'the teams game: its own refusal, as before');
});

test('everyone in their team\'s colour: figures, scoreboard, kill feed and name tags (the roster\'s colours)', () => {
  const s = four();
  const colors = s.out.filter((m) => m.t === 'colors').at(-1).list;
  for (const n of [...s.blue, ...s.red]) {
    const team = s.blue.includes(n) ? 'blue' : 'red';
    assert.equal(colors.find((c) => c.name === n)?.color, { blue: '#4fa3e0', red: '#e5484d' }[team], n);
    assert.equal(s.game.colorOf(n, s.game.players.get(n)), { blue: '#4fa3e0', red: '#e5484d' }[team]);
  }
  const scores = s.game.scoreList();
  assert.ok(scores.every((r) => r.color === (s.blue.includes(r.name) ? '#4fa3e0' : '#e5484d')), 'the scoreboard too');
  s.game.modes.start('free', 'admin');
  const after = s.out.filter((m) => m.t === 'colors').at(-1).list;
  assert.ok(after.every((c) => c.color !== '#4fa3e0' || !s.blue.includes(c.name) || c.color === s.game.players.get(c.name).color), 'own colours back after it');
});

test('logging in again drops the flag where the old connection was, no fresh start with it', () => {
  const s = four();
  const [r] = s.red;
  s.onStand(r, 'blue');
  s.tick();
  s.put(r, 600, -740, 6);
  s.tick();
  s.join(r); // the same name from another tab: the old socket closes, its close skips leave
  assert.equal(s.flag().flags.blue.at, 'ground');
  assert.deepEqual([s.flag().flags.blue.x, s.flag().flags.blue.z], [600, -740]);
  assert.ok(s.events().includes(`dropped:blue:${r}`));
  s.tick();
  assert.notEqual(s.flag().flags.blue.by, r, 'not straight back: they would carry it with a reconnect\'s fresh protection');
  assert.ok(s.game.players.get(r).protectedUntil <= s.now() + 5000);
  s.at(5000);
  s.tick();
  assert.equal(s.flag().flags.blue.by, r, 'after REGRAB_MS (past any protection) it is theirs again by touch');
});

test('no flying while it is played, whatever the house rule says', () => {
  const s = four();
  s.game.rules.flying = true;
  const [b] = s.blue;
  const st = s.game.players.get(b).state;
  s.msg(b, { t: 'state', x: st.x, y: st.y, z: st.z, yaw: 0, pitch: 0, armed: true, w: 'pistol', flying: true });
  assert.equal(s.game.players.get(b).state.flying, false);
  s.game.modes.start('free', 'admin');
  s.msg(b, { t: 'state', x: st.x, y: st.y, z: st.z, yaw: 0, pitch: 0, armed: true, w: 'pistol', flying: true });
  assert.equal(s.game.players.get(b).state.flying, true, 'free play: the house rule');
});

/** A point inside the first private home's first band, at that band's height (shared/homes.mjs). */
function insideHome() {
  const band = HOMES[0].bands[0];
  const x = band.ring.reduce((a, p) => a + p[0], 0) / band.ring.length;
  const z = band.ring.reduce((a, p) => a + p[1], 0) / band.ring.length;
  const y = band.y0 + 0.5;
  assert.ok(homeAt(x, z, y), 'a point inside a home');
  return [x, y, z];
}

test('safe places (village field): carried onto the school grounds or into a private home, the flag goes home at once with a line', () => {
  const s = four('village');
  const [r, r2] = s.red;
  s.onStand(r, 'blue');
  s.tick();
  s.put(r, 470, -815, 4.4); // the school's playground (shared/zones.mjs)
  assert.ok(noShoot(470, -815));
  s.tick();
  assert.equal(s.flag().flags.blue.at, 'home');
  assert.ok(s.out.some((m) => m.t === 'flag' && m.ev === 'safe' && m.why === 'zone' && m.name === r), 'every page told why');
  s.onStand(r2, 'blue');
  s.tick();
  assert.equal(s.flag().flags.blue.by, r2);
  const [hx, hy, hz] = insideHome();
  s.put(r2, hx, hz, hy);
  s.tick();
  assert.equal(s.flag().flags.blue.at, 'home');
  assert.ok(s.out.some((m) => m.t === 'flag' && m.ev === 'safe' && m.why === 'home' && m.name === r2));
});

test('a flag\'s place inside a private home is never sent: a carrier\'s place never, and one falling inside goes home', () => {
  const s = four('village');
  const [r] = s.red;
  s.onStand(r, 'blue');
  s.tick();
  const carried = s.game.modes.view().flag.flags.blue;
  assert.deepEqual(Object.keys(carried).sort(), ['at', 'by'], 'carried: who, never where');
  // Down on the very step into a home (the place it would fall): home instead of lying there.
  const [hx, hy, hz] = insideHome();
  s.put(r, hx, hz, hy);
  s.game.players.get(r).alive = false;
  s.tick();
  const f = s.game.modes.view().flag.flags.blue;
  assert.equal(f.at, 'home');
  assert.ok(!s.out.filter((m) => m.t === 'mode' && m.mode.flag).some((m) => Object.values(m.mode.flag.flags).some((g) => g.at === 'ground' && homeAt(g.x, g.z, g.y))), 'no mode ever carried a place in a home');
});

test('moved by the server, the carrier is told why the flag dropped', () => {
  const s = four();
  const [r] = s.red;
  s.onStand(r, 'blue');
  s.tick();
  s.put(r, 615, -745, 6);
  s.tick();
  s.game.respawn(r, s.game.players.get(r), s.now());
  s.tick();
  assert.ok(s.lines(r).includes('flagMoved'));
});

test('a field car that is a wreck when the game ends: every page told it is whole before it goes', () => {
  const s = four('village');
  const id = Object.values(s.game.cars).find((c) => c.flag).id;
  s.game.vehicleDamage.recs.set(`car:${id}`, { kind: 'car', id, hp: 0, max: 100, st: 3, pct: 0 });
  s.game.modes.start('free', 'admin');
  assert.ok(s.out.some((m) => m.t === 'vdmg' && m.id === id && m.st === 0 && m.hp === 100));
  assert.ok(!s.game.vehicleDamage.recs.has(`car:${id}`));
});

test('someone in the house\'s helicopter as the game starts: red still gets it at the Sparrenhof', () => {
  const s = setup();
  for (const n of ['ann', 'bob', 'cid', 'dee']) s.join(n);
  const h = s.game.helis.machines.get('house');
  h.seats[0] = 'ann';
  s.game.modes.start('flag', 'admin', 'village', { look: 'real' });
  assert.ok(!h.seats.includes('ann'), 'out of it first');
  const spot = FIELDS.village.heli.red;
  assert.deepEqual([h.x, h.z], [spot.x, spot.z]);
});

test('helicopters in both fields and every look: anyone but the carrier boards', () => {
  for (const field of ['compact', 'village']) {
    for (const look of [undefined, 'paint', 'real']) {
      const s = four(field, { look });
      s.game.rules.heli = true;
      const [b] = s.blue;
      assert.equal(s.game.flagNoHeli(b, s.game.players.get(b), 'church'), false, `${field}, ${look}: not refused`);
      const h = s.game.helis.machines.get('church');
      s.at(20_000); // out of the start's fight clocks
      s.put(b, h.x + 1.4, h.z, h.y);
      s.msg(b, { t: 'heli', op: 'in', id: 'church' });
      assert.equal(s.game.helis.of(b), h, `${field}, ${look}: blue boards the church's machine`);
      assert.deepEqual(s.lines(b), []);
    }
  }
});

test('each team\'s helicopter at its spot in both fields and every look, whole; back on its own pad afterwards', () => {
  for (const field of ['compact', 'village']) {
    for (const look of [undefined, 'paint', 'real']) {
      const pre = setup();
      for (const n of ['ann', 'bob', 'cid', 'dee']) pre.join(n);
      // Before the game: both machines flown off, and red's a wreck.
      const church = pre.game.helis.machines.get('church');
      const house = pre.game.helis.machines.get('house');
      const pads = { church: { ...pre.game.helis.inner.get('church').park }, house: { ...pre.game.helis.inner.get('house').park } };
      Object.assign(church, { x: 600, z: -700, y: 40 });
      Object.assign(house, { x: 100, z: 50, y: 3 });
      pre.game.vehicleDamage.recs.set('heli:house', { kind: 'heli', id: 'house', hp: 0, max: 700, st: 3, pct: 0 });
      pre.game.modes.start('flag', 'admin', field, { look });
      const spot = FIELDS[field].heli.red;
      assert.deepEqual([church.x, church.y, church.z], [pads.church.x, pads.church.y, pads.church.z], `${field}, ${look}: blue's on the church's deck`);
      assert.deepEqual([house.x, house.y, house.z, house.yaw], [spot.x, spot.y, spot.z, spot.yaw], `${field}, ${look}: red's at its spot`);
      assert.ok(!pre.game.vehicleDamage.out('heli', 'house'), 'whole');
      assert.ok(pre.out.some((m) => m.t === 'vdmg' && m.id === 'house' && m.st === 0 && m.hp === 100), 'every page told it is whole');
      pre.game.modes.start('free', 'admin');
      assert.deepEqual([house.x, house.y, house.z], [pads.house.x, pads.house.y, pads.house.z], 'back on its own pad');
      assert.deepEqual(pre.game.helis.inner.get('house').park, pads.house);
    }
  }
});

test('the compact field\'s red helicopter: inside the edge, more than 14 m from either stand, off the start places', () => {
  const spot = FIELDS.compact.heli.red;
  const s = four('compact');
  assert.ok(s.flag().edge.inside(spot.x, spot.z));
  for (const team of ['blue', 'red']) {
    const [x, z] = FIELDS.compact.bases[team].stand;
    assert.ok(Math.hypot(spot.x - x, spot.z - z) > 14 + 5.2, `${team}: the rotor clear of the 14 m round the stand`);
    for (const [sx, sz] of FIELDS.compact.bases[team].spawns) assert.ok(Math.hypot(spot.x - sx, spot.z - sz) > 8, 'clear of the start places');
  }
  assert.equal(noShoot(spot.x, spot.z), null);
});

test('the field\'s edge holds a helicopter as it holds a walker: its pilot\'s step past it is put back inside', () => {
  const s = four('compact');
  s.game.rules.heli = true;
  const [r] = s.red;
  const h = s.game.helis.machines.get('house');
  s.at(20_000);
  s.put(r, h.x + 1.4, h.z, h.y);
  s.msg(r, { t: 'heli', op: 'in', id: 'house' });
  assert.equal(s.game.helis.of(r), h);
  const edge = s.flag().edge;
  const z0 = h.z;
  // Up and away to the north, over the gardens and out of the band, a step at a time within the flight's budgets.
  for (let i = 0; i < 80; i++) {
    s.at(100);
    const st = s.game.players.get(r).state;
    s.msg(r, { t: 'state', x: st.x, y: st.y + (i < 10 ? 1 : 0), z: st.z - 3, yaw: h.yaw, pitch: 0, armed: true, w: 'pistol', hp: 0, hr: 0, hn: 1, hg: 0 });
  }
  assert.ok(z0 - h.z > 15, `it flew: ${z0 - h.z} m`);
  assert.ok(edge.inside(h.x, h.z), `the machine stays inside: ${h.x}, ${h.z}`);
  assert.ok(!edge.inside(h.x, h.z - 3), 'held at the edge itself');
  assert.ok(s.game.helis.of(r) === h, 'still flying it');
});

test('a late joiner gets a team (the smaller one) and starts at its base', () => {
  const s = four();
  s.join('eve');
  const team = s.game.modes.state.teams.eve;
  assert.ok(team === 'blue' || team === 'red');
  const st = s.game.players.get('eve').state;
  const [x, z] = s.stand(team);
  assert.ok(Math.hypot(st.x - x, st.z - z) < 15);
  s.join('fay');
  assert.notEqual(s.game.modes.state.teams.fay, team, 'the other, now smaller, team');
});

test('switching teams: refused while carrying, refused under the host\'s teams, else a fresh start at the new base', () => {
  const s = four();
  const [r, r2] = s.red;
  s.onStand(r, 'blue');
  s.tick();
  s.msg(r, { t: 'team', team: 'blue' });
  assert.equal(s.game.modes.state.teams[r], 'red');
  assert.ok(s.lines(r).includes('flagSwitch'));
  s.at(20_000);
  s.msg(r2, { t: 'team', team: 'blue' });
  assert.equal(s.game.modes.state.teams[r2], 'blue');
  const st = s.game.players.get(r2).state;
  const [bx, bz] = s.stand('blue');
  assert.ok(Math.hypot(st.x - bx, st.z - bz) < 15, 'moved to the blue base');
  // The host's teams: nobody switches.
  const h = setup();
  for (const n of ['ann', 'bob', 'cid', 'dee']) h.join(n);
  h.game.host.act('host', { op: 'teams', count: 2 });
  h.game.modes.start('flag', 'admin', 'compact');
  const t = h.game.modes.state.teams;
  for (const n of ['ann', 'bob', 'cid', 'dee']) assert.equal(t[n], h.game.host.teams[n] === 0 ? 'blue' : 'red', 'the host\'s first team is blue');
  const who = 'ann';
  h.at(20_000);
  h.msg(who, { t: 'team', team: t[who] === 'blue' ? 'red' : 'blue' });
  assert.ok(h.lines(who).includes('hostTeams'));
});

test('no message from a page takes, drops or scores a flag', () => {
  const s = four();
  const [r] = s.red;
  for (const m of [{ t: 'flag', ev: 'taken', team: 'blue' }, { t: 'flag', op: 'capture' }, { t: 'pickup', id: 'flag' }, { t: 'coin', i: 0 }, { t: 'tag', target: s.blue[0] }]) s.msg(r, m);
  s.tick();
  assert.equal(s.flag().flags.blue.at, 'home');
  assert.equal(s.flag().score.red, 0);
});

test('the village field parks cars and bikes at each base for the game only, enough seats for a team of 15', () => {
  const s = four('village');
  const v = FIELDS.village.vehicles;
  for (const team of ['blue', 'red']) assert.ok(v[team].cars.length * 2 + v[team].bikes.length >= 15, `${team}: 15 seats`);
  const cars = Object.values(s.game.cars).filter((c) => c.flag);
  assert.equal(cars.length, v.blue.cars.length + v.red.cars.length);
  assert.ok(s.out.some((m) => m.t === 'teslas' && m.list.some((c) => c.flag)), 'every page told');
  for (const k of [...v.blue.bikes, ...v.red.bikes]) assert.ok(s.game.bikes[k.id], `bike ${k.id} parked`);
  // Nobody takes one away or moves it with /tesla, the admin neither.
  s.join('boss', 'admin');
  return s.game.placeCar('boss', s.game.players.get('boss'), { t: 'tesla', op: 'del', id: cars[0].id }, s.now()).then(() => {
    assert.ok(s.game.cars[cars[0].id], 'still there');
    s.game.modes.start('free', 'admin');
    assert.equal(Object.values(s.game.cars).filter((c) => c.flag).length, 0, 'gone when the game is');
    for (const k of v.blue.bikes) assert.equal(s.game.bikes[k.id], undefined);
  });
});

test('the village field\'s parked cars stand where a car may stand, and its bikes clear of walls', () => {
  const s = setup();
  const v = FIELDS.village.vehicles;
  for (const team of ['blue', 'red']) {
    for (const c of v[team].cars) assert.equal(s.game.parkingProblem(c.kind, c, null), null, `${team} car at ${c.x}, ${c.z}`);
    for (const k of v[team].bikes) assert.equal(s.game.bikeHits.spotOk(k.x, k.z, k.yaw, null), true, `${team} bike ${k.id}`);
  }
});

test('helicopters in the village field played for real: anyone but the carrier flies, they take damage, the game keeps them flying', () => {
  const s = four('village', { look: 'real' });
  s.game.rules.heli = true;
  const [b] = s.blue;
  const h = s.game.helis.machines.get('church');
  s.at(20_000); // out of the start's fight clocks
  s.put(b, h.x + 1.4, h.z, h.y);
  s.msg(b, { t: 'heli', op: 'in', id: 'church' });
  assert.equal(s.game.helis.of(b), h, 'blue boards the church\'s machine');
  s.game.tick();
  assert.equal(s.game.helis.of(b), h, 'not emptied by the game (as a game in the house would)');
  assert.equal(s.game.modes.teamMatch, true);
  assert.equal(s.game.vehicleDamage.live, true, 'vehicles take damage (server/vehicleDamage.mjs)');
  // The red machine at the Sparrenhof is where the field put it, the carrier still refused (see above).
  const red = s.game.helis.machines.get('house');
  assert.deepEqual([red.x, red.z], [FIELDS.village.heli.red.x, FIELDS.village.heli.red.z]);
});

test('no helicopter at a base: one low near a stand goes back to its spot, whoever is aboard put out and told', () => {
  const s = four('village', { look: 'real' });
  s.game.rules.heli = true;
  const [b] = s.blue;
  const h = s.game.helis.machines.get('church');
  s.at(20_000);
  s.put(b, h.x + 1.4, h.z, h.y);
  s.msg(b, { t: 'heli', op: 'in', id: 'church' });
  assert.equal(s.game.helis.of(b), h);
  const [rx, rz, ry] = s.stand('red');
  Object.assign(h, { x: rx + 5, z: rz, y: ry + 0.5, g: 1 }); // flown there and set down by the stand
  s.tick();
  assert.equal(s.game.helis.of(b), null, 'put out');
  assert.ok(s.lines(b).includes('flagHeliBase'));
  const pad = FIELDS.village.heli.red; // not the church's own spot moved: its pad
  assert.ok(Math.hypot(h.x - rx, h.z - rz) > 14, 'back on its own spot');
  assert.notDeepEqual([h.x, h.z], [pad.x, pad.z]);
  // High over a base is flying, not landing: left alone.
  const [bx, bz, by] = s.stand('blue');
  Object.assign(h, { x: bx, z: bz, y: by + 30, g: 0 });
  s.tick();
  assert.deepEqual([h.x, h.z], [bx, bz]);
});

test('the fields: red\'s compact base 150 to 250 m from the church, the school\'s grounds outside the field, no start on a portal', () => {
  const s = four();
  const edge = s.flag().edge;
  const [bx, bz] = FIELDS.compact.bases.blue.stand;
  const [rx, rz] = FIELDS.compact.bases.red.stand;
  const d = Math.hypot(rx - bx, rz - bz);
  assert.ok(d >= 150 && d <= 250, `${d} m`);
  for (const zone of NO_SHOOT) for (const [x, z] of zone.poly) assert.equal(edge.inside(x, z), false, 'the school stays out of the field');
  for (const field of Object.values(FIELDS)) {
    for (const team of ['blue', 'red']) {
      const base = field.bases[team];
      for (const [x, z] of [base.stand, ...base.spawns]) {
        assert.equal(noShoot(x, z), null);
        assert.ok(PORTALS.every((p) => Math.hypot(p.x - x, p.z - z) > REACH + 0.5), `${x}, ${z} off the portals' pads`);
        if (field.id === 'compact') assert.ok(edge.inside(x, z));
      }
    }
  }
});

test('the evening\'s scoreboard: a point for playing, three more for the winners', () => {
  const s = four('compact', { minutes: 1 });
  const [r] = s.red;
  s.onStand(r, 'blue');
  s.tick();
  s.onStand(r, 'red');
  s.tick();
  s.at(60_000);
  s.tick();
  const board = Object.fromEntries(s.game.host.board().players.map((p) => [p.name, p.points]));
  for (const n of s.red) assert.equal(board[n], 4);
  for (const n of s.blue) assert.equal(board[n], 1);
  // Its result shown, back to free play: the teams' colours go and the vehicles with them.
  s.at(11_000);
  s.tick();
  assert.equal(s.game.modes.state.kind, 'free');
});
