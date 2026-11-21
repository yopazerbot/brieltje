import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';

// Teams of 30 (a LAN night of 60, the host's limit raised: server/game.mjs DEFAULT_PLAYERS): Steal the flag's and
// Attack and defend's start places (server/flags.mjs places and baseSpot) put everyone at their own base, spread over
// rings round the six places, never two in one spot (more: server/basePlaces.test.mjs).

function setup() {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const store = { addStats: async () => {}, setMeta: async () => {}, getMeta: async () => null, addCar: async () => 1, deleteCar: async () => {} };
  const game = new Game({ session: () => null, store, log: () => {} }, [], null);
  for (const t of game.timers) clearInterval(t);
  game.auth = { ...game.auth, store, session: () => null, log: () => {}, addressOf: () => '127.0.0.1' };
  game.broadcast = () => {};
  game.broadcastThing = () => {};
  game.send = () => {};
  game.stampState = () => {};
  const closers = new Map();
  const join = (name) => {
    const ws = { name, readyState: 1, OPEN: 1, send() {}, on: (ev, fn) => ev === 'close' && closers.set(name, fn), close: () => {} };
    game.join(ws, { username: name, role: 'player', key: `k-${name}` }, { headers: {}, socket: {} });
  };
  return { game, join, at: (ms) => (clock += ms), now: () => clock };
}

/** Everyone on a team where the server has them: the closest two apart (m), and how far each is from their base. */
function spread(s) {
  const teams = s.game.modes.state.teams;
  const f = s.game.modes.state.f;
  const at = [...s.game.players].filter(([n]) => teams[n]).map(([n, p]) => ({ n, team: teams[n], x: p.state.x, z: p.state.z }));
  let closest = Infinity;
  for (let i = 0; i < at.length; i++) for (let j = i + 1; j < at.length; j++) closest = Math.min(closest, Math.hypot(at[i].x - at[j].x, at[i].z - at[j].z));
  // Each on a place of their own base's (server/flags.mjs places: checked ground, facing out), and how much further from
  // the stand than the base's own furthest start place.
  const placed = at.every((p) => f.places(p.team).some((q) => q.x === p.x && q.z === p.z));
  const beyond = Math.max(...at.map((p) => {
    const [sx, sz] = f.baseOf(p.team).stand;
    return Math.hypot(p.x - sx, p.z - sz) - Math.max(...f.baseOf(p.team).spawns.map(([x, z]) => Math.hypot(x - sx, z - sz)));
  }));
  return { at, closest, placed, beyond, inside: at.every((p) => f.edge.inside(p.x, p.z)) };
}

for (const [field, opts] of [['compact', {}], ['village', {}], ['assault', { defend: 'blue' }]]) {
  test(`${field}: teams of 30 start at their own base, spread, nobody on top of anyone`, () => {
    const s = setup();
    s.game.rules.maxPlayers = 60;
    for (let i = 0; i < 60; i++) s.join(`p${String(i).padStart(2, '0')}`);
    s.game.modes.start('flag', 'admin', field, opts);
    const r = spread(s);
    assert.equal(r.at.length, 60, 'everyone on a team');
    assert.ok(r.closest >= 1.2, `the closest two ${r.closest.toFixed(2)} m apart`);
    assert.ok(r.placed, 'everyone on a place of their own base');
    assert.ok(r.beyond <= 12, `the base, not beyond it: at most ${r.beyond.toFixed(1)} m further from the stand than its own furthest start place`);
    assert.ok(r.inside, 'everyone inside the field');
  });
}
