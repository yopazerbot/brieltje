// The host's announcement during the Zombies duel (server/host.mjs announce, server/duel.mjs): "on every screen", so
// also on the pages in the duel's two rooms, not only in the open world. Run: node --test server/hostRooms.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from './game.mjs';
import { Rooms } from './rooms.mjs';

const real = Date.now;

test('an announcement reaches the open world and both rooms of the Zombies duel', () => {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const auth = {
    log() {}, addressOf: () => '192.0.2.1', session: () => null,
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
  const closers = new Map();
  const join = (game, name, role = 'player') => {
    const on = {};
    const ws = { name, got: [], readyState: 1, OPEN: 1, send: (d) => ws.got.push(JSON.parse(d)), on: (e, f) => (on[e] = f), close: () => { ws.readyState = 3; } };
    game.join(ws, { username: name, role, key: `k-${name}` }, { headers: {}, socket: {}, url: '/ws?v=2' });
    closers.set(name, () => on.close?.());
    return ws;
  };
  try {
    const blue = ['bea', 'bob'];
    const red = ['rik', 'roos'];
    main.host.teamCount = 2;
    for (const n of blue) main.host.teams[n] = 0;
    for (const n of red) main.host.teams[n] = 1;
    for (const n of [...blue, ...red]) join(main, n);
    const admin = join(main, 'admin', 'admin');
    assert.deepEqual(rooms.duel.start({ duel: 'warmup', minutes: 10 }, 'admin'), { ok: true });
    const pages = {};
    for (const n of [...blue, ...red]) {
      closers.get(n)();
      pages[n] = join(rooms.duel.route({ username: n, role: 'player', key: `k-${n}` }), n);
    }
    clock += 1000;
    assert.deepEqual(main.host.act('admin', { op: 'announce', text: 'Pizza is here', secs: 8 }), { ok: true });
    const told = (ws) => ws.got.some((m) => m.t === 'announce' && m.text === 'Pizza is here' && m.ms === 8000);
    assert.ok(told(admin), 'the open world');
    for (const n of [...blue, ...red]) assert.ok(told(pages[n]), `${n}, in the duel's room`);
  } finally {
    Date.now = real;
    for (const g of [main, ...made]) g.close();
  }
});
