import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';
import { fieldOf } from '../shared/flagFields.mjs';
import { homeAt } from '../shared/homes.mjs';

// A team game's start and end, as the server puts everyone (server/game.mjs respawn, newRound, gather): a player still in
// a drop when the game puts them at their base is out of it at once (no flag-proof, hit-proof skydiver), and after a game
// everyone goes back to the house spread out, each on a spot of their own, never in a wall or in a home they may not enter.

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
  const join = (name, role = 'player') => {
    sent.set(name, []);
    const ws = { name, readyState: 1, OPEN: 1, send() {}, on() {}, close: () => {} };
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
  return { game, join, msg, tick, out, sent, at: (ms) => (clock += ms), now: () => clock };
}

/** `name` arrives by parachute at the house's start (the page's first ask, as a fresh guest): in a drop on the server. */
function arriveByParachute(s, name) {
  s.msg(name, { t: 'spawn', to: 'home' });
  const p = s.game.players.get(name);
  assert.equal(s.game.dropping(p, s.now()), true, `${name} is in a drop`);
  // A few seconds into it, its page says so (the drop flag, the canopy out), high up.
  s.at(3000);
  s.msg(name, { t: 'state', x: p.state.x, y: p.state.y - 30, z: p.state.z, yaw: 0, pitch: 0, armed: true, w: 'pistol', pc: 1, po: 1 });
  assert.equal(p.state.chute, true, 'the server has the canopy out');
  return p;
}

for (const kind of ['flag', 'teams']) {
  test(`${kind}: a player still in a drop when the game starts is out of it at once, on the ground and in the fight`, () => {
    const s = setup();
    for (const n of ['ann', 'bob', 'cid', 'dee']) s.join(n);
    const p = arriveByParachute(s, 'ann');
    s.game.modes.start(kind, 'admin', 'compact');
    const now = s.now();
    assert.equal(s.game.dropping(p, now), false, 'no longer dropping');
    assert.equal(p.drop, null);
    assert.equal(p.state.chute, false);
    assert.equal(p.state.open, false);
    assert.ok(p.state.y < 25, `on the ground (y ${p.state.y})`);
    // Its page, a moment behind, still says it hangs under its canopy where the server put it: nothing comes of it.
    s.at(100);
    s.msg('ann', { t: 'state', x: p.state.x, y: p.state.y, z: p.state.z, yaw: 0, pitch: 0, armed: true, w: 'pistol', pc: 1, po: 1 });
    assert.equal(p.state.chute, false, 'a page cannot claim a drop');
    assert.equal(p.state.open, false);
    assert.equal(s.game.dropping(p, s.now()), false);
    // Once the start's short protection is over, the fight reaches them (a drop would keep them out of it).
    s.at(10_000);
    assert.equal(s.game.fightCalm(p), false, 'not protected as a skydiver');
  });
}

test('flag: the one who was dropping can take the other flag once the game has put them at their base', () => {
  const s = setup();
  for (const n of ['ann', 'bob', 'cid', 'dee']) s.join(n);
  const p = arriveByParachute(s, 'ann');
  s.game.modes.start('flag', 'admin', 'compact');
  const f = s.game.modes.state.f;
  const team = s.game.modes.state.teams.ann;
  const theirs = team === 'blue' ? 'red' : 'blue';
  assert.equal(f.canTouch('ann', p, s.now()), true, 'may touch a flag');
  const [x, z, y] = fieldOf('compact').bases[theirs].stand;
  Object.assign(p.state, { x, y, z, flying: false });
  for (let i = 0; i < 4; i++) s.tick(50);
  assert.ok(s.out.some((m) => m.t === 'flag' && m.ev === 'taken' && m.name === 'ann'), 'ann took the flag');
});

/** Every pair of `spots` at least `gap` m apart across: the closest pair, for the message. */
function closest(spots) {
  let best = { d: Infinity, a: '', b: '' };
  for (let i = 0; i < spots.length; i++) {
    for (let j = i + 1; j < spots.length; j++) {
      const d = Math.hypot(spots[i].x - spots[j].x, spots[i].z - spots[j].z);
      if (d < best.d) best = { d, a: spots[i].name, b: spots[j].name };
    }
  }
  return best;
}

for (const [how, end] of [
  ['the host stops it', (s) => s.game.modes.start('free', 'admin')],
  ['its clock runs out', (s) => {
    s.game.modes.state.until = s.now();
    s.tick(50); // level: sudden death
    s.game.modes.state.until = s.now();
    s.tick(50); // the result shows
    s.game.modes.state.until = s.now();
    s.tick(50); // and free play
  }],
]) {
  test(`after a team game (${how}): thirty players back at the house, each on a spot of their own, none in a wall or a home`, () => {
    const s = setup();
    const names = Array.from({ length: 30 }, (_, i) => `p${i}`);
    for (const n of names) s.join(n);
    // Everyone armed (their pages said so), as in a fight.
    for (const n of names) Object.assign(s.game.players.get(n).state, { armed: true });
    s.game.modes.start('flag', 'admin', 'compact');
    for (const n of names) Object.assign(s.game.players.get(n).state, { armed: true });
    s.out.length = 0;
    end(s);
    assert.equal(s.game.modes.state.kind, 'free');
    const back = s.out.filter((m) => m.t === 'respawn');
    assert.equal(new Set(back.map((m) => m.name)).size, 30, 'everyone moved back');
    const spots = names.map((name) => ({ name, ...s.game.players.get(name).state }));
    const c = closest(spots);
    assert.ok(c.d >= 0.8, `${c.a} and ${c.b} are ${c.d.toFixed(2)} m apart`);
    for (const p of spots) {
      const q = s.game.players.get(p.name);
      assert.ok(Math.hypot(p.x - 4.5, p.z - 6) < 40, `${p.name} at the house (${p.x}, ${p.z})`);
      assert.ok(s.game.free(p.x, p.z), `${p.name} not in a wall, hedge or fence (${p.x}, ${p.z})`);
      assert.equal(homeAt(p.x, p.z, p.y), null, `${p.name} not inside a home`);
      assert.ok(s.game.gate.mayStand(q, p.x, p.y, p.z), `${p.name} may stand there`);
      assert.ok(s.game.fence().inside(p.x, p.z), `${p.name} inside the game's edge`);
      assert.equal(q.alive, true);
    }
  });
}
