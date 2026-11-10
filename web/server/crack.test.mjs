import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';

// A first bullet cracks a pane (world/glass.ts) and the page says so with `crack`, so the others see the mark.
// The server passes it on only for a number that is a pane, whole and not cracked yet, in a home the player may
// shoot at, from a player who can fire, five a second at most; the place is held to the map. A crack opens
// nothing: only `glass` breaks a pane. Each forged message below must change nothing.

function setup() {
  const game = new Game({ session: () => null, store: { addStats: async () => {} } }, []);
  const told = [];
  game.broadcast = (m) => told.push(m);
  game.broadcastHome = (m) => told.push(m);
  game.send = () => {};
  game.stampState = () => {};
  const player = (name, role = 'admin') => {
    const now = Date.now();
    const p = {
      ws: { name }, key: `k-${name}`, role, alive: true, protectedUntil: 0, drop: null, warp: 0, stamp: 0, unfired: true, cameAt: now,
      state: { x: 5, y: 0, z: 5, yaw: 0, pitch: 0, armed: true, flying: false, w: 'pistol', c: false },
      weapons: new Set(['pistol']), nades: [0, 0], window: now, msgs: 0, states: 0, others: 0, budget: 0.5, vbudget: 0.5, movedAt: now,
      hp: 100, score: { kills: 0, deaths: 0, points: 0 }, thrown: [],
    };
    game.players.set(name, p);
    return p;
  };
  /** A message from `p`, with its waits let go and its count of messages this second cleared. */
  const send = (name, p, m) => {
    p.nextCrack = 0;
    p.msgs = 0;
    p.window = Date.now();
    game.handle(name, p, JSON.stringify(m));
  };
  /** A number that is a pane: the first one the server takes a crack for. */
  const aPane = (name, p, from = 0) => {
    for (let i = from; i < 4000; i++) {
      const before = game.cracked.size;
      send(name, p, { t: 'crack', i, x: 5, y: 1, z: 5 });
      if (game.cracked.size > before) return i;
    }
    throw new Error('no pane found');
  };
  return { game, told, player, send, aPane };
}

test('a crack is kept and told once; a second one in the same pane is not', () => {
  const { game, told, player, send, aPane } = setup();
  const anna = player('anna');
  const i = aPane('anna', anna);
  assert.deepEqual(game.cracked.get(i), { x: 5, y: 1, z: 5 });
  assert.equal(told.filter((m) => m.t === 'crack' && m.i === i).length, 1);
  send('anna', anna, { t: 'crack', i, x: 6, y: 1, z: 6 });
  assert.deepEqual(game.cracked.get(i), { x: 5, y: 1, z: 5 }, 'the first mark stays');
  assert.equal(told.filter((m) => m.t === 'crack' && m.i === i).length, 1);
  assert.equal(game.broken.has(i), false, 'a crack breaks nothing');
  assert.deepEqual(game.crackedFor(anna).find(([p]) => p === i), [i, 5, 1, 5], 'a player who joins is told');
});

test('breaking the pane takes its crack away, and so does mending the windows', () => {
  const { game, player, send, aPane } = setup();
  const anna = player('anna');
  const i = aPane('anna', anna);
  send('anna', anna, { t: 'glass', i });
  assert.equal(game.broken.has(i), true);
  assert.equal(game.cracked.has(i), false);
  send('anna', anna, { t: 'crack', i, x: 5, y: 1, z: 5 });
  assert.equal(game.cracked.has(i), false, 'no crack in a pane that is gone');
  game.lastRepair = 0;
  const j = aPane('anna', anna, i + 1);
  send('anna', anna, { t: 'repair' });
  assert.equal(game.cracked.has(j), false);
});

test('no crack from numbers that are no pane, a place that is none, or a player who can\'t fire', () => {
  const { game, player, send, aPane } = setup();
  const anna = player('anna');
  const i = aPane('anna', anna);
  game.cracked.clear();
  for (const m of [
    { t: 'crack', i: -1, x: 5, y: 1, z: 5 }, { t: 'crack', i: 1.5, x: 5, y: 1, z: 5 }, { t: 'crack', i: '3', x: 5, y: 1, z: 5 },
    { t: 'crack', i: 99999999, x: 5, y: 1, z: 5 },
    { t: 'crack', i, x: 'NaN', y: 1, z: 5 }, { t: 'crack', i, x: Infinity, y: 1, z: 5 }, { t: 'crack', i, y: 1, z: 5 }, { t: 'crack', i, x: [5], y: 1, z: 5 },
  ]) {
    send('anna', anna, m);
    assert.equal(game.cracked.size, 0, JSON.stringify(m));
  }
  for (const change of [{ alive: false }, { state: { ...anna.state, armed: false } }]) {
    const was = { alive: anna.alive, state: anna.state };
    Object.assign(anna, change);
    send('anna', anna, { t: 'crack', i, x: 5, y: 1, z: 5 });
    assert.equal(game.cracked.size, 0, JSON.stringify(change));
    Object.assign(anna, was);
  }
  // Far outside the map: kept, but held to it.
  send('anna', anna, { t: 'crack', i, x: 1e9, y: -1e9, z: 5 });
  const at = game.cracked.get(i);
  assert.ok(at && Math.abs(at.x) < 1e5 && at.y >= -20);
});

test('five a second at most from one player', () => {
  const { game, player, aPane } = setup();
  const anna = player('anna');
  const i = aPane('anna', anna);
  game.cracked.clear();
  anna.msgs = 0;
  anna.nextCrack = Date.now() + 200; // as just after a crack
  game.handle('anna', anna, JSON.stringify({ t: 'crack', i, x: 5, y: 1, z: 5 }));
  assert.equal(game.cracked.size, 0);
});
