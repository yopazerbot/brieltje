// The Zombies duel (server/duel.mjs): blue and red each in a host room at Sparrenhof, one seed for both, the warm-up and
// the final with their rules, the host's stop, the ranking, everyone moved in and back, and a page that can never pick
// its duel room. Run: node --test server/duel.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from './game.mjs';
import { MAX_ROOMS, Rooms } from './rooms.mjs';
import { duelPlayers, GATHER_MS, RESULT_MS, dice, duelDice, markOf, minuteMs, passes } from './duel.mjs';
import { Horde, waveSize, ZOMBIE } from '../shared/zombies.mjs';
import { Loot } from '../shared/loot.mjs';
import { homeAt } from '../shared/homes.mjs';

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
  const runs = []; // the runs a duel room put on the board (game.zombieRun)
  const rooms = new Rooms(main, (room) => {
    const g = quiet(new Game(auth, undefined, room));
    g.zombieRun = (place, names, wave) => runs.push({ team: room.duel, place, wave });
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
      assert.equal(main.players.get(n).ws.closed, 4006, `${n} is moved out of the open world (the duel's own close)`);
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
  return { main, rooms, made, runs, join, leave, teams, begin, tick, stop, now: () => clock, set: (t) => (clock = t) };
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

test('same seed, the same waves and zombie mix in both rooms whatever else was thrown, and the same drop dice', () => {
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
    assert.equal(p.ws.closed, 4006);
    assert.equal(d.route({ username: 'cas' }), red.game);
    // The host moving someone later moves nobody between rooms.
    env.main.host.teams.ann = 1;
    assert.equal(d.route({ username: 'ann' }), blue.game);
    // The WebSocket: whatever the address asks, the team's room; a duel room's id from anyone else: gone.
    const calls = [];
    for (const g of [env.main, blue.game, red.game]) g.upgrade = (_q, _s, _h, gone) => calls.push([g === env.main ? 'main' : g.room.duel, !!gone]);
    const ask = (who, q) => {
      env.main.auth.session = () => ({ username: who, role: 'player', key: `k-${who}` });
      env.rooms.upgrade({ url: `/ws?v=2${q}`, headers: { origin: 'http://brieltje.test', host: 'brieltje.test' } }, {}, null);
    };
    ask('ann', `&room=${red.id}`);
    ask('ann', '');
    ask('nina', `&room=${blue.id}`);
    ask('nina', '');
    ask('ann', '&watch=1');
    // Another site's socket (cross-site WebSocket hijacking): never routed, refused by the open world's own checks.
    env.main.auth.session = () => ({ username: 'ann', role: 'player', key: 'k-ann' });
    env.rooms.upgrade({ url: '/ws?v=2', headers: { origin: 'https://evil.test', host: 'brieltje.test' } }, {}, null);
    env.rooms.upgrade({ url: '/ws?v=2', headers: { host: 'brieltje.test' } }, {}, null);
    assert.deepEqual(calls, [['blue', false], ['blue', false], ['main', true], ['main', false], ['main', false], ['main', false], ['main', false]]);
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
    const most = duelPlayers(env.main);
    assert.equal(most, 32, "the host's limit, 32 on a fresh server");
    assert.equal(blue.game.room.max, most);
    for (let i = 0; i < most - 1; i++) red.game.players.set(`x${i}`, {});
    assert.equal(red.game.full('admin'), true, 'the limit at most, the admin included');
    for (let i = 0; i < most - 1; i++) red.game.players.delete(`x${i}`);
    assert.ok(env.rooms.roster().some((p) => p.name === 'ann' && p.room === 'duel blue · sparrenhof'));
  } finally {
    env.stop();
  }
});

test("a duel room takes as many as the host's limit: 30 a team with a limit of 60, more than the limit refused", () => {
  const env = setup();
  try {
    env.main.rules.maxPlayers = 60;
    const names = (k) => Array.from({ length: 30 }, (_, i) => `${k}${i}`);
    const { blue, red } = env.begin(names('b'), names('r'));
    assert.equal(blue.game.room.max, 60);
    assert.equal(blue.game.players.size, 30);
    assert.equal(red.game.players.size, 30);
    assert.equal(blue.game.rules.maxPlayers, 60, "the room's own limit as its pages are told it");
  } finally {
    env.stop();
  }
  const env2 = setup();
  try {
    env2.main.rules.maxPlayers = 2;
    env2.teams(['a1', 'a2', 'a3'], ['z1']);
    for (const n of ['a1', 'a2', 'a3', 'z1']) env2.join(env2.main, n, n === 'a1' ? 'admin' : 'player');
    assert.equal(env2.rooms.duel.start({ duel: 'warmup', minutes: 10 }, 'admin').code, 'duelTooMany', 'a team bigger than the limit: no duel');
  } finally {
    env2.stop();
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

test('final: both out, the team out second wins when its mark passed the first\'s; else the first', () => {
  for (const [second, won] of [[{ wave: 5, beaten: 11 }, 'red'], [{ wave: 5, beaten: 10 }, 'blue'], [{ wave: 4, beaten: 99 }, 'blue']]) {
    const env = setup();
    try {
      const { st, blue, red } = env.begin(['ann'], ['bob'], { duel: 'final' });
      at(blue, 5, 10);
      wipe(env, blue);
      env.set(env.now() + 100); // within the same quarter second: no tick in between
      at(red, second.wave, second.beaten);
      wipe(env, red);
      assert.equal(st.winner, won, JSON.stringify(second));
    } finally {
      env.stop();
    }
  }
});

test('final: out at the same moment, the higher mark wins; the same mark is a draw, a point for playing to all', () => {
  for (const [b, r, won] of [[[6, 1], [5, 40], 'blue'], [[5, 3], [5, 4], 'red'], [[5, 7], [5, 7], 'draw']]) {
    const env = setup();
    try {
      const { st, blue, red } = env.begin(['ann'], ['bob'], { duel: 'final' });
      at(blue, ...b);
      at(red, ...r);
      blue.out = { wave: b[0], beaten: b[1] };
      red.out = { wave: r[0], beaten: r[1] };
      blue.outAt = red.outAt = env.now();
      env.rooms.duel.check(env.now());
      assert.equal(st.winner, won);
      if (won === 'draw') {
        const sc = env.main.host.scores;
        assert.equal(sc.ann.points, 1 + 1, 'played, and a point for five waves');
        assert.equal(sc.bob.points, 1 + 1);
        assert.ok(blue.game.players.get('ann').ws.got.some((m) => m.code === 'duelDraw'));
      }
    } finally {
      env.stop();
    }
  }
});

test('final: someone new once the first wave began comes in out; in the warm-up they play', () => {
  for (const kind of ['final', 'warmup']) {
    const env = setup();
    try {
      const { blue } = env.begin(['ann'], ['bob'], { duel: kind });
      at(blue, 2);
      env.main.host.teams.cas = 0;
      const cas = env.join(blue.game, 'cas');
      if (kind === 'final') {
        assert.equal(cas.alive, false, 'no fresh life under a new name');
        assert.equal(cas.respawnAt, Infinity);
        assert.ok(cas.ws.got.some((m) => m.code === 'duelDown'));
        blue.z.horde.toSpawn = 0;
        blue.z.horde.zombies.clear();
        blue.z.tick(env.now(), 50); // the wave beaten: still out
        assert.equal(cas.alive, false);
      } else assert.equal(cas.alive, true, 'the warm-up: in at once');
    } finally {
      env.stop();
    }
  }
  const env = setup();
  try {
    const { blue } = env.begin(['ann'], ['bob'], { duel: 'final' });
    env.main.host.teams.dee = 0;
    assert.equal(env.join(blue.game, 'dee').alive, true, 'before the first wave: in, as everyone');
  } finally {
    env.stop();
  }
});

test('a crate\'s gun comes from the wave\'s drop dice, whatever was thrown for places', () => {
  const pick = (extra) => {
    const places = dice(5);
    for (let i = 0; i < extra; i++) places();
    const l = new Loot(null, places, (w) => dice(100 + w));
    l.wave(3);
    return Array.from({ length: 6 }, () => l.give('ann', { x: 0, y: 0, z: 0, w: 'pistol', hp: 100, guns: ['pistol'] }, 'gun', 0)?.w).join(',');
  };
  assert.equal(pick(0), pick(13));
});

test('the look holds while a team is out and through the result, until everyone is back', () => {
  const env = setup();
  try {
    env.main.rules.paintball = true; // the house rule: child-friendly; the final's look: real
    const { st, blue, red } = env.begin(['ann'], ['bob'], { duel: 'final', look: 'real' });
    at(red, 3);
    wipe(env, red);
    assert.equal(red.game.modes.state.kind, 'free');
    assert.equal(red.game.shownRules().paintball, false, 'out: still the duel\'s look');
    assert.equal(red.game.players.get('bob').ws.got.filter((m) => m.t === 'rules').at(-1).rules.paintball, false);
    at(blue, 4);
    env.tick();
    assert.equal(st.phase, 'done');
    for (const s of [blue, red]) assert.equal(s.game.shownRules().paintball, false, 'in the result too');
    assert.equal(env.main.shownRules().paintball, true, 'the open world keeps the house rule');
  } finally {
    env.stop();
  }
});

test('a duel run reaches the boards however it ends: caught, the clock, the host\'s stop, the final won', () => {
  const env = setup();
  try {
    const { blue, red } = env.begin(['ann'], ['bob'], { duel: 'warmup', minutes: 10 });
    at(blue, 3);
    wipe(env, blue); // caught: kept, and a new run
    at(blue, 2);
    at(red, 4);
    env.rooms.duel.stop('admin');
    assert.deepEqual(env.runs.map((r) => [r.team, r.place, r.wave]).sort(), [['blue', 'sparrenhof', 2], ['blue', 'sparrenhof', 3], ['red', 'sparrenhof', 4]]);
  } finally {
    env.stop();
  }
  const fin = setup();
  try {
    const { blue, red } = fin.begin(['ann'], ['bob'], { duel: 'final' });
    at(red, 2, 3);
    wipe(fin, red);
    at(blue, 3);
    fin.tick(); // blue passed: won
    assert.deepEqual(fin.runs.map((r) => [r.team, r.wave]).sort(), [['blue', 3], ['red', 2]]);
  } finally {
    fin.stop();
  }
});

// Back in the open world from a place that was no place to come back to (a load test found players hanging in the air):
// `how` puts ann somewhere in the open world before the duel takes her; the duel is stopped, the result shown, and she
// connects to the open world again. Returns her player there and the respawn her page was told.
async function tripFrom(how) {
  const env = setup();
  const { main, rooms } = env;
  env.teams(['ann'], ['bob']);
  const ann = env.join(main, 'ann');
  env.join(main, 'bob');
  how(env, ann);
  rooms.duel.start({ duel: 'warmup', minutes: 10 }, 'admin');
  assert.equal(ann.ws.closed, 4006);
  for (const n of ['ann', 'bob']) {
    env.leave(n);
    env.join(rooms.duel.route({ username: n }), n);
  }
  rooms.duel.stop('admin');
  env.tick(RESULT_MS + 300);
  assert.equal(rooms.duel.on, false);
  const back = env.join(main, 'ann');
  await new Promise(setImmediate);
  const told = back.ws.got.filter((m) => m.t === 'respawn' && m.name === 'ann').at(-1);
  return { env, back, told };
}

/** On the ground, alive, out of every wall, never inside a home without its right, and her page told so. */
function onGround(env, p, told) {
  const { x, y, z } = p.state;
  assert.equal(p.alive, true);
  assert.ok(Math.abs(y - env.main.helis.floor(x, z)) < 0.01, `on the ground, not at ${y.toFixed(2)} over ${env.main.helis.floor(x, z).toFixed(2)}`);
  assert.ok(env.main.free(x, z), 'no wall within a metre');
  assert.ok(env.main.gate.mayStand(p, x, y, z), 'not inside a home she may not enter');
  assert.equal(homeAt(x, z, y), null);
  assert.ok(told && Math.abs(told.x - x) < 0.01 && Math.abs(told.z - z) < 0.01 && Math.abs(told.y - y) < 0.01, `her page told: ${JSON.stringify(told)}`);
}

const OPEN = { x: 4.5, z: 19 }; // the street's start place in front of the house: open public ground
const HOUSE_IN = { x: 3.7, z: 4.1 }; // inside the main house

test('back from a parachute drop high up: on the ground under where she was', async () => {
  const { env, back, told } = await tripFrom((env, p) => {
    assert.ok(env.main.free(OPEN.x, OPEN.z));
    Object.assign(p.state, { x: OPEN.x, y: env.main.helis.floor(OPEN.x, OPEN.z) + 120, z: OPEN.z, chute: true });
    env.main.startDrop(p, env.now());
  });
  try {
    onGround(env, back, told);
    assert.ok(Math.hypot(back.state.x - OPEN.x, back.state.z - OPEN.z) < 0.01, 'right under it');
    assert.equal(back.drop ?? null, null, 'no drop carried over');
  } finally {
    env.stop();
  }
});

test('back from flying over a home she may not enter: on open ground beside it, never on or in it', async () => {
  const { env, back, told } = await tripFrom((env, p) => {
    assert.equal(homeAt(HOUSE_IN.x, HOUSE_IN.z, env.main.helis.floor(HOUSE_IN.x, HOUSE_IN.z) + 0.1), 'house');
    Object.assign(p.state, { x: HOUSE_IN.x, y: env.main.helis.floor(HOUSE_IN.x, HOUSE_IN.z) + 40, z: HOUSE_IN.z, flying: true });
  });
  try {
    onGround(env, back, told);
    assert.ok(Math.hypot(back.state.x - HOUSE_IN.x, back.state.z - HOUSE_IN.z) < 20, 'the nearest open ground');
  } finally {
    env.stop();
  }
});

test('back from up in the air without a flag (falling, off a roof): on the ground', async () => {
  const { env, back, told } = await tripFrom((env, p) => Object.assign(p.state, { x: OPEN.x, y: env.main.helis.floor(OPEN.x, OPEN.z) + 30, z: OPEN.z }));
  try {
    onGround(env, back, told);
  } finally {
    env.stop();
  }
});

test('back from a car seat: on the ground clear of the cars', async () => {
  const { env, back, told } = await tripFrom((env, p) => {
    const c = Object.values(env.main.cars)[0];
    c.driver = 'ann';
    Object.assign(p.state, { x: c.x, y: env.main.helis.floor(c.x, c.z) + 0.5, z: c.z });
  });
  try {
    onGround(env, back, told);
    assert.equal(env.main.carOf('ann'), null);
    assert.ok(Object.values(env.main.cars).every((c) => Math.hypot(back.state.x - c.x, back.state.z - c.z) > 3));
  } finally {
    env.stop();
  }
});

test('back from a helicopter in the air: on the ground, out of it', async () => {
  const { env, back, told } = await tripFrom((env, p) => {
    const h = [...env.main.helis.machines.values()][0];
    h.seats[0] = 'ann';
    h.y = env.main.helis.floor(h.x, h.z) + 60;
    Object.assign(p.state, { x: h.x, y: h.y, z: h.z });
  });
  try {
    onGround(env, back, told);
    assert.equal(env.main.helis.of('ann'), null);
  } finally {
    env.stop();
  }
});

test('back after being down when the duel took her: up, on the ground', async () => {
  const { env, back, told } = await tripFrom((env, p) => {
    Object.assign(p.state, { x: OPEN.x, y: env.main.helis.floor(OPEN.x, OPEN.z) + 8, z: OPEN.z });
    Object.assign(p, { alive: false, hp: 0, respawnAt: Infinity });
  });
  try {
    onGround(env, back, told);
  } finally {
    env.stop();
  }
});

test('back inside a home she may enter, on its floor: right where she stood', async () => {
  let y0 = 0;
  const { env, back, told } = await tripFrom((env, p) => {
    env.main.homes = { granted: (key, id) => key === 'k-ann' && id === 'house' };
    y0 = env.main.helis.floor(HOUSE_IN.x, HOUSE_IN.z) + 0.05;
    Object.assign(p.state, { x: HOUSE_IN.x, y: y0, z: HOUSE_IN.z });
  });
  try {
    assert.equal(back.alive, true);
    assert.ok(Math.hypot(back.state.x - HOUSE_IN.x, back.state.z - HOUSE_IN.z) < 0.01 && Math.abs(back.state.y - y0) < 0.01, JSON.stringify(back.state));
    assert.equal(homeAt(back.state.x, back.state.z, back.state.y), 'house');
    assert.ok(told && Math.abs(told.x - HOUSE_IN.x) < 0.01);
  } finally {
    env.stop();
  }
});

test('back from the air with no open ground near: her usual spawn', async () => {
  const { env, back, told } = await tripFrom((env, p) => {
    Object.assign(p.state, { x: OPEN.x, y: env.main.helis.floor(OPEN.x, OPEN.z) + 50, z: OPEN.z, flying: true });
    env.main.free = () => false; // nowhere free round there
  });
  try {
    assert.equal(back.alive, true);
    assert.ok(told && told.x === undefined && Number.isInteger(told.spawn), `a spawn point: ${JSON.stringify(told)}`);
    assert.ok(env.main.gate.mayStand(back, back.state.x, back.state.y, back.state.z));
  } finally {
    env.stop();
  }
});
