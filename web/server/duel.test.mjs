// The Zombies duel (server/duel.mjs): blue and red each in a host room at Sparrenhof, one seed for both, the warm-up and
// the final with their rules, the host's stop, the ranking, everyone moved in and back, and a page that can never pick
// its duel room. Run: node --test server/duel.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from './game.mjs';
import { MAX_ROOMS, Rooms } from './rooms.mjs';
import { DUEL_PLAYERS, GATHER_MS, RESULT_MS, dice, duelDice, markOf, minuteMs, passes } from './duel.mjs';
import { Horde, waveSize, ZOMBIE } from '../shared/zombies.mjs';
import { Loot } from '../shared/loot.mjs';

const real = Date.now;

function setup() {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const auth = {
    logged: [], sessions: new Map(),
    log(event, _req, extra) { this.logged.push({ event, ...extra }); },
    addressOf: () => '192.0.2.1', session: () => null,
    store: { saveZombieRun: async () => true, addStats: async () => {}, setMeta: async () => {} },
  };
  const quiet = (g) => {
    for (const t of g.timers) clearInterval(t);
    return g;
  };
  const main = quiet(new Game(auth));
  const made = [];
  const rooms = new Rooms(main, (room) => {
    const g = quiet(new Game(auth, undefined, room));
    made.push(g);
    return g;
  });
  clearInterval(rooms.duel.timer);
  const sockets = new Map();
  /** A page of `name` joins `game` (a fresh socket each time): its messages in `ws.got`, its close code in `ws.closed`. */
  const join = (game, name, role = 'player') => {
    const on = {};
    const ws = { name, got: [], closed: null, readyState: 1, OPEN: 1, send: (d) => ws.got.push(JSON.parse(d)), on: (e, f) => (on[e] = f), close: (code) => { ws.closed ??= code; ws.readyState = 3; } };
    game.join(ws, { username: name, role, key: `k-${name}` }, { headers: {}, socket: {}, url: '/ws?v=2' });
    sockets.set(name, () => on.close?.());
    const p = game.players.get(name);
    p.state.armed = true; // fights
    return p;
  };
  /** The page's connection ends (its close comes in). */
  const leave = (name) => sockets.get(name)?.();
  const teams = (blue, red) => {
    main.host.teamCount = 2;
    for (const n of blue) main.host.teams[n] = 0;
    for (const n of red) main.host.teams[n] = 1;
  };
  /** Everyone on a team joins the open world, then the duel starts and they are moved: each into their room. */
  const begin = (blue, red, e = { duel: 'warmup', minutes: 10 }) => {
    teams(blue, red);
    for (const n of [...blue, ...red]) join(main, n);
    assert.deepEqual(rooms.duel.start(e, 'admin'), { ok: true });
    for (const n of [...blue, ...red]) {
      assert.equal(main.players.get(n).ws.closed, 4004, `${n} is moved out of the open world`);
      leave(n);
      join(rooms.duel.route({ username: n, role: 'player', key: `k-${n}` }), n);
    }
    const st = rooms.duel.state;
    return { st, blue: st.sides.blue, red: st.sides.red };
  };
  const tick = (ms = 250) => {
    clock += ms;
    rooms.duel.tick(clock);
  };
  const stop = () => {
    Date.now = real;
    for (const g of [main, ...made]) g.close();
  };
  return { main, rooms, made, join, leave, teams, begin, tick, stop, now: () => clock, set: (t) => (clock = t) };
}

/** Everyone who fights in side `s`'s room down, as zombies would leave them (game.mjs npcDamage). */
const wipe = (env, s) => {
  for (const [n, p] of s.game.players) if (p.alive) s.game.npcDamage(n, p, p.hp, env.now(), 'a zombie');
  s.z.tick(env.now(), 50); // the horde sees nobody up: over
};

/** Side `s`'s run at wave `wave` with `beaten` zombies beaten (by its first player). */
const at = (s, wave, beaten = 0) => {
  s.z.horde.wave = wave;
  s.z.horde.phase = 'wave';
  s.z.horde.toSpawn = 50; // more to come: no wave beaten meanwhile
  s.z.horde.beaten = { [[...s.game.players.keys()][0]]: beaten };
};

test('one seed: the same dice in both rooms, a wave of its own for each, another seed throws otherwise', () => {
  const a = duelDice(42), b = duelDice(42), c = duelDice(43);
  const take = (r, n = 20) => Array.from({ length: n }, () => r());
  assert.deepEqual(take(a.mix(3)), take(b.mix(3)));
  assert.deepEqual(take(a.drops(3)), take(b.drops(3)));
  assert.deepEqual(take(a.places), take(b.places));
  assert.notDeepEqual(take(a.mix(4)), take(duelDice(42).mix(3)), 'each wave its own');
  assert.notDeepEqual(take(c.mix(3)), take(duelDice(42).mix(3)));
  assert.ok(take(dice(1), 1000).every((v) => v >= 0 && v < 1));
});

test('same seed, the same waves and zombie mix in both rooms whatever else was thrown, and the same drops', () => {
  const env = setup();
  try {
    const { blue, red } = env.begin(['ann', 'bob'], ['cas', 'dee']);
    const spot = blue.z.horde.spots[0];
    const zombiesOf = (s, extra) => {
      const h = s.z.horde;
      h.pick = () => ({ x: spot.x, z: spot.z, node: spot.node }); // where they come out does not matter here
      for (let k = 0; k < extra; k++) h.rand(); // the other room threw more for places
      h.begin(env.now(), 2, []);
      const out = [];
      for (let i = 0; i < 12; i++) {
        h.nextSpawn = 0;
        h.cap = 99;
        h.spawn(env.now(), [], []);
      }
      for (const z of h.zombies.values()) out.push([z.kind, z.top, z.hp]);
      return out;
    };
    for (let w = 0; w < 6; w++) {
      const a = zombiesOf(blue, 0), b = zombiesOf(red, 7);
      assert.deepEqual(a, b, `wave ${blue.z.horde.wave}`);
      blue.z.horde.zombies.clear();
      red.z.horde.zombies.clear();
    }
    assert.ok(blue.z.horde.runners >= 0);
    // The drops: the k-th zombie beaten in a wave leaves the same in both rooms.
    const drops = (s) => {
      const l = s.z.loot;
      l.wave(4);
      return Array.from({ length: 15 }, (_, i) => l.drop({ x: i, y: 0, z: 0, yaw: 0, kind: 0 }, env.now(), false, []).map((it) => it.kind).join(',')).join('|');
    };
    assert.equal(drops(blue), drops(red));
  } finally {
    env.stop();
  }
});

test('the horde scales with the players who fight in the room', () => {
  assert.ok(waveSize(1, 15) > waveSize(1, 8) && waveSize(1, 8) > waveSize(1, 2));
  const env = setup();
  try {
    const { blue, red } = env.begin(['a1', 'a2'], ['b1', 'b2', 'b3', 'b4', 'b5', 'b6']);
    for (const s of [blue, red]) s.z.horde.until = env.now(); // the break is over
    blue.z.tick(env.now(), 50);
    red.z.tick(env.now(), 50);
    assert.equal(blue.z.horde.wave, 1);
    assert.equal(blue.z.horde.toSpawn, waveSize(1, 2));
    assert.equal(red.z.horde.toSpawn, waveSize(1, 6));
  } finally {
    env.stop();
  }
});

test('both first waves come at the same moment, after the gathering and the first break', () => {
  const env = setup();
  try {
    const { blue, red } = env.begin(['ann'], ['bob']);
    assert.equal(blue.z.horde.until, red.z.horde.until);
    assert.ok(blue.z.horde.until >= env.now() + ZOMBIE.firstBreak, 'not before the first break, the moves included');
    assert.ok(blue.z.horde.until <= env.now() + GATHER_MS + ZOMBIE.firstBreak);
  } finally {
    env.stop();
  }
});

test('warm-up: down comes back when the wave is beaten; caught whole, back to wave 1 with the best wave kept', () => {
  const env = setup();
  try {
    const { blue, red } = env.begin(['ann', 'bob'], ['cas']);
    at(blue, 3);
    const ann = blue.game.players.get('ann');
    blue.game.npcDamage('ann', ann, ann.hp, env.now(), 'a zombie');
    assert.equal(ann.alive, false);
    blue.z.horde.toSpawn = 0;
    blue.z.horde.zombies.clear();
    blue.z.tick(env.now(), 50); // the wave is beaten
    assert.equal(ann.alive, true, 'back at the start of the next wave');
    at(blue, 6, 40);
    const first = blue.z;
    wipe(env, blue);
    assert.notEqual(blue.z, first, 'a new run');
    assert.equal(blue.z.horde.wave, 0);
    assert.deepEqual(blue.best, { wave: 6, beaten: 40 });
    assert.ok([...blue.game.players.values()].every((p) => p.alive), 'everyone back at the start');
    assert.ok(blue.game.players.get('bob').ws.got.some((m) => m.t === 'system' && m.code === 'duelAgain' && m.args.best === 6));
    assert.equal(red.z.horde.phase, 'break', 'the other room plays on');
    assert.equal(env.rooms.duel.view().sides[0].best, 6, 'the line shows the best');
  } finally {
    env.stop();
  }
});

test('warm-up: time up, ranked by wave, then zombies beaten; each side its best run', () => {
  const env = setup();
  try {
    const { st, blue, red } = env.begin(['ann'], ['bob'], { duel: 'warmup', minutes: 1 });
    at(blue, 5, 20);
    wipe(env, blue); // best 5 / 20, now at wave 0
    at(blue, 2, 4);
    at(red, 5, 21);
    env.set(st.until - 100);
    env.tick(50);
    assert.equal(st.phase, 'playing');
    env.tick(200);
    assert.equal(st.phase, 'done');
    assert.equal(st.winner, 'red', 'the same wave, more zombies beaten');
    assert.ok(passes({ wave: 6, beaten: 0 }, { wave: 5, beaten: 99 }), 'the wave first');
    assert.ok(!passes({ wave: 5, beaten: 3 }, { wave: 5, beaten: 3 }), 'the same mark passes nothing');
  } finally {
    env.stop();
  }
});

test('the test clock is the server\'s own and never in production', () => {
  assert.equal(minuteMs({ DUEL_TEST_MINUTE_MS: '3000' }), 3000);
  assert.equal(minuteMs({ DUEL_TEST_MINUTE_MS: '3000', NODE_ENV: 'production' }), 60_000);
  assert.equal(minuteMs({ DUEL_TEST_MINUTE_MS: '3000', RAILWAY_ENVIRONMENT: 'production' }), 60_000);
  assert.equal(minuteMs({ DUEL_TEST_MINUTE_MS: '5' }), 60_000, 'nothing silly');
  assert.equal(minuteMs({}), 60_000);
});

test('final: nobody comes back, not at the wave\'s end, not helped up, not by reconnecting', () => {
  const env = setup();
  try {
    const { blue } = env.begin(['ann', 'bob'], ['cas'], { duel: 'final' });
    at(blue, 2);
    const ann = blue.game.players.get('ann');
    blue.game.npcDamage('ann', ann, ann.hp, env.now(), 'a zombie');
    assert.ok(ann.ws.got.some((m) => m.code === 'duelDown'));
    const bob = blue.game.players.get('bob');
    Object.assign(bob.state, { x: ann.state.x, y: ann.state.y, z: ann.state.z });
    bob.protectedUntil = 0;
    blue.z.help('bob', bob, { on: true, name: 'ann' }, env.now());
    assert.equal(blue.z.helping.size, 0, 'no help up');
    blue.z.horde.toSpawn = 0;
    blue.z.horde.zombies.clear();
    blue.z.tick(env.now(), 50); // wave beaten
    assert.equal(blue.z.horde.phase, 'break');
    assert.equal(blue.game.players.get('ann').alive, false, 'still down after the wave');
    env.leave('ann');
    const back = env.join(blue.game, 'ann');
    assert.equal(back.alive, false, 'down after reconnecting in the break too');
  } finally {
    env.stop();
  }
});

test('final: the team still in wins the moment it passes the other\'s mark', () => {
  const env = setup();
  try {
    const { st, blue, red } = env.begin(['ann'], ['bob'], { duel: 'final' });
    at(red, 5, 10);
    at(blue, 5, 9);
    wipe(env, red);
    assert.deepEqual(red.out, { wave: 5, beaten: 10 });
    assert.equal(red.game.modes.state.kind, 'free', 'no zombies in its room');
    assert.equal(red.game.modes.friends('bob', 'x'), true, 'nobody hurts anyone in a duel room');
    assert.ok(blue.game.players.get('ann').ws.got.some((m) => m.code === 'duelOutThem' && m.args.n === 5));
    env.tick();
    assert.equal(st.phase, 'playing', 'not passed yet');
    blue.z.horde.beaten.ann = 10;
    env.tick();
    assert.equal(st.phase, 'playing', 'level is not past');
    blue.z.horde.beaten.ann = 11;
    env.tick();
    assert.equal(st.phase, 'done');
    assert.equal(st.winner, 'blue');
    const line = red.game.players.get('bob').ws.got.filter((m) => m.t === 'duel').at(-1).duel;
    assert.equal(line.winner, 'blue');
    assert.deepEqual(line.sides.map((s) => [s.team, s.wave, s.out]), [['blue', 5, false], ['red', 5, true]]);
  } finally {
    env.stop();
  }
});

test('final: caught before passing the mark, the team out first wins', () => {
  const env = setup();
  try {
    const { st, blue, red } = env.begin(['ann'], ['bob'], { duel: 'final' });
    at(blue, 4, 30);
    wipe(env, blue);
    at(red, 3, 50);
    wipe(env, red);
    assert.equal(st.phase, 'done');
    assert.equal(st.winner, 'blue');
  } finally {
    env.stop();
  }
});

test("the host's stop ends both rooms at once, ranked; after the result everyone is back where they stood, with their guns", async () => {
  const env = setup();
  try {
    env.teams(['ann'], ['bob']);
    const ann0 = env.join(env.main, 'ann');
    env.join(env.main, 'bob');
    Object.assign(ann0.state, { x: 30, y: ann0.state.y, z: 40 });
    ann0.weapons = new Set(['pistol', 'rifle', 'bazooka']);
    env.main.host.act('admin', { op: 'start', kind: 'duel', duel: 'final' }); // the countdown: ten seconds
    assert.equal(env.rooms.duel.on, false);
    env.main.host.countdown && clearTimeout(env.main.host.countdown.timer);
    env.rooms.duel.start({ duel: 'final' }, 'admin');
    for (const n of ['ann', 'bob']) {
      env.leave(n); // the 4004 close comes in: the open world keeps where they stood
      env.join(env.rooms.duel.route({ username: n }), n);
    }
    const { st, blue, red } = { st: env.rooms.duel.state, ...env.rooms.duel.state.sides };
    at(blue, 3, 5);
    at(red, 3, 6);
    const page = blue.game.players.get('ann').ws;
    assert.equal(env.main.host.act('admin', { op: 'stop' }).ok, true);
    assert.equal(st.phase, 'done');
    assert.equal(st.winner, 'red');
    assert.ok([blue, red].every((s) => s.game.modes.state.kind === 'free'), 'no zombies in either');
    const score = env.main.host.scores;
    assert.equal(score.bob.points, 1 + 3 + 1, 'played, won, a point per three waves');
    assert.equal(score.ann.points, 1 + 1);
    env.tick(RESULT_MS - 500);
    assert.equal(env.rooms.duel.on, true, 'the result shows ten seconds');
    env.tick(600);
    assert.equal(env.rooms.duel.on, false);
    assert.equal(page.closed, 4004, 'their pages go back');
    assert.equal(env.rooms.duel.route({ username: 'ann' }), null, 'to the open world');
    const ann = env.join(env.main, 'ann');
    await new Promise(setImmediate);
    assert.ok(Math.hypot(ann.state.x - 30, ann.state.z - 40) < 0.01, `where she stood, not ${ann.state.x}, ${ann.state.z}`);
    const told = ann.ws.got.find((m) => m.t === 'respawn' && m.name === 'ann');
    assert.ok(told && Math.hypot(told.x - 30, told.z - 40) < 0.01, 'her page is told where (it was at Sparrenhof)');
    assert.deepEqual([...ann.weapons].sort(), ['bazooka', 'pistol', 'rifle']);
    assert.deepEqual(ann.ws.got.filter((m) => m.t === 'weapons').at(-1).list.sort(), ['bazooka', 'pistol', 'rifle']);
  } finally {
    env.stop();
  }
});

test('only the admin\'s host actions start a duel; it needs two teams with someone in each', () => {
  const env = setup();
  try {
    assert.equal(env.rooms.duel.start({ duel: 'warmup' }, 'admin').code, 'duelTeams');
    assert.equal(env.main.host.act('admin', { op: 'start', kind: 'duel', duel: 'warmup' }).code, 'duelTeams');
    env.teams(['ann'], ['bob']);
    env.join(env.main, 'ann');
    assert.equal(env.rooms.duel.start({ duel: 'warmup' }, 'admin').code, 'duelEmpty');
    assert.equal(env.main.host.entry({ kind: 'duel', duel: 'semi' }), null, 'only a warm-up or a final');
    assert.deepEqual(env.main.host.entry({ kind: 'duel', duel: 'final', minutes: 9, look: 'real' }), { kind: 'duel', duel: 'final', place: 'sparrenhof', minutes: null, goal: null, look: 'real' });
    // A page: neither 'mode' nor 'zwave' reaches a duel room's game.
    env.join(env.main, 'bob');
    env.rooms.duel.start({ duel: 'warmup' }, 'admin');
    const blue = env.rooms.duel.state.sides.blue;
    env.leave('ann');
    const p = env.join(blue.game, 'ann', 'admin');
    const z = blue.z;
    p.window = env.now();
    blue.game.handle('ann', p, JSON.stringify({ t: 'mode', kind: 'free' }));
    blue.game.handle('ann', p, JSON.stringify({ t: 'zwave', wave: 30 }));
    assert.equal(blue.game.modes.state.z, z);
    assert.equal(z.horde.wave, 0);
  } finally {
    env.stop();
  }
});

test('a late joiner and a reconnect land in their room; a page never picks its duel room', () => {
  const env = setup();
  try {
    const { blue, red } = env.begin(['ann'], ['bob']);
    const d = env.rooms.duel;
    assert.equal(d.route({ username: 'ann' }), blue.game, 'a reconnect: her room');
    assert.equal(d.route({ username: 'nina' }), null, 'not on a team yet: the open world');
    // The newcomer joins the open world; the host puts her on the smaller team; she is moved at once.
    env.join(env.main, 'cas');
    env.main.host.teams.cas = 1;
    const p = env.main.players.get('cas');
    env.tick();
    assert.equal(p.ws.closed, 4004);
    assert.equal(d.route({ username: 'cas' }), red.game);
    // The host moving someone later moves nobody between rooms.
    env.main.host.teams.ann = 1;
    assert.equal(d.route({ username: 'ann' }), blue.game);
    // The WebSocket: whatever the address asks, the team's room; a duel room's id from anyone else: gone.
    const calls = [];
    for (const g of [env.main, blue.game, red.game]) g.upgrade = (_q, _s, _h, gone) => calls.push([g === env.main ? 'main' : g.room.duel, !!gone]);
    const ask = (who, q) => {
      env.main.auth.session = () => ({ username: who, role: 'player', key: `k-${who}` });
      env.rooms.upgrade({ url: `/ws?v=2${q}`, headers: {} }, {}, null);
    };
    ask('ann', `&room=${red.id}`);
    ask('ann', '');
    ask('nina', `&room=${blue.id}`);
    ask('nina', '');
    ask('ann', '&watch=1');
    assert.deepEqual(calls, [['blue', false], ['blue', false], ['main', true], ['main', false], ['main', false]]);
  } finally {
    env.stop();
  }
});

test("players' rooms are unaffected: not counted, still capped, and duel rooms are in no list", () => {
  const env = setup();
  try {
    const { blue, red } = env.begin(['ann'], ['bob']);
    for (const [u, place] of [['u1', 'church'], ['u2', 'house'], ['u3', 'molenhoek'], ['u4', 'bungalow']]) assert.ok(env.rooms.create({ username: u, role: 'player' }, place).room);
    assert.equal(env.rooms.create({ username: 'u5', role: 'player' }, 'church').code, 'roomsFull');
    assert.equal(env.rooms.list().rooms.length, MAX_ROOMS);
    assert.ok(!JSON.stringify(env.rooms.list({ role: 'admin' })).includes(blue.id));
    assert.equal(blue.game.room.max, DUEL_PLAYERS);
    for (let i = 0; i < DUEL_PLAYERS - 1; i++) red.game.players.set(`x${i}`, {});
    assert.equal(red.game.full('admin'), true, 'twenty at most');
    for (let i = 0; i < DUEL_PLAYERS - 1; i++) red.game.players.delete(`x${i}`);
    assert.ok(env.rooms.roster().some((p) => p.name === 'ann' && p.room === 'duel blue · sparrenhof'));
  } finally {
    env.stop();
  }
});

test('the look holds in both rooms, a house rule changed mid-duel too', () => {
  const env = setup();
  try {
    env.main.rules.paintball = false;
    const { blue, red } = env.begin(['ann'], ['bob'], { duel: 'warmup', look: 'paint' });
    for (const s of [blue, red]) assert.equal(s.game.shownRules().paintball, true);
    const ann = blue.game.players.get('ann');
    ann.ws.got.length = 0;
    env.rooms.rulesChanged({ ...env.main.rules, flying: false }, { t: 'system', text: 'x' });
    assert.equal(ann.ws.got.find((m) => m.t === 'rules').rules.paintball, true);
    assert.equal(red.game.players.get('bob').ws.got.filter((m) => m.t === 'rules').at(-1).rules.paintball, true);
    assert.equal(blue.game.rules.flying, false, 'the rule itself reaches the room');
    // A restart in the warm-up keeps it.
    at(blue, 2);
    wipe(env, blue);
    assert.equal(blue.game.shownRules().paintball, true);
  } finally {
    env.stop();
  }
});

test('the live line: each team\'s wave, the clock, from the server alone', () => {
  const env = setup();
  try {
    const { blue, red } = env.begin(['ann'], ['bob'], { duel: 'warmup', minutes: 10 });
    at(blue, 6, 12);
    at(red, 5, 3);
    env.tick();
    const line = blue.game.players.get('ann').ws.got.filter((m) => m.t === 'duel').at(-1).duel;
    assert.deepEqual(line.sides.map((s) => [s.team, s.wave]), [['blue', 6], ['red', 5]]);
    assert.equal(line.kind, 'warmup');
    assert.ok(line.ms > 9 * 60_000);
    assert.deepEqual(markOf(red.z), { wave: 5, beaten: 3 });
    // A page's own 'duel' message is nothing the server reads.
    const p = blue.game.players.get('ann');
    p.window = env.now();
    blue.game.handle('ann', p, JSON.stringify({ t: 'duel', duel: { sides: [{ team: 'blue', wave: 99 }] } }));
    assert.equal(env.rooms.duel.view().sides[0].wave, 6);
  } finally {
    env.stop();
  }
});

test('a Horde and Loot without the duel\'s dice throw as before', () => {
  const r = dice(9);
  const seq = Array.from({ length: 5 }, r);
  let i = 0;
  const h = new Horde({ locate: () => 0, ground: () => 0 }, [], { rand: () => seq[i++ % 5] });
  assert.equal(h.mix, h.rand);
  const l = new Loot(null, Math.random);
  assert.equal(l.drops, l.rand);
});
