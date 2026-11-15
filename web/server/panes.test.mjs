import assert from 'node:assert/strict';
import test from 'node:test';
import { Game, WALK_IN_PANES } from './game.mjs';
import { WALK_INS } from '../shared/homes.mjs';
import { PROTO } from '../shared/wire.mjs';

// A walked-into house's pane numbers (shared/homes.mjs WALK_INS) are a pane only as far as its real panes go: its shell's
// windows, its shell's and its inside's door glass. A number past them, sent by someone with the home's right, breaks
// nothing and is never stored (it would fill the broken list up to its cap with panes that don't exist).

function setup() {
  const game = new Game({ session: () => null, store: { addStats: async () => {} } }, []);
  game.homes = { granted: () => true }; // the right to every home: the numbers are all that is checked here
  game.stats = () => {};
  const now = Date.now();
  const p = {
    key: 'k-owner', role: 'player', got: [], proto: PROTO, full: true, slot: 0, sentKey: '', fresh: true, warp: 0, stamp: 0,
    ws: { readyState: 1, OPEN: 1, send(d) { p.got.push(JSON.parse(d)); } },
    alive: true, protectedUntil: 0, drop: null, hp: 100, score: { kills: 0, deaths: 0, points: 0 }, color: '#888',
    state: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, armed: true, flying: false, w: 'rifle', c: false },
    weapons: new Set(['pistol']), nades: [0, 0], thrown: [], window: now, msgs: 0, states: 0, others: 0, budget: 100, vbudget: 100, movedAt: now,
  };
  game.players.set('owner', p);
  const glass = (i) => {
    p.nextGlass = 0;
    p.window = Date.now();
    p.msgs = p.others = 0;
    game.handle('owner', p, JSON.stringify({ t: 'glass', i }));
    return game.broken.has(i);
  };
  return { game, glass };
}

for (const [id, r] of Object.entries(WALK_INS)) {
  test(`${id}: only its real windows and door glass break, no number past them`, () => {
    const { glass } = setup();
    const n = WALK_IN_PANES[id];
    assert.ok(n.windows > 0 && n.doorGlass > 0, JSON.stringify(n));
    assert.equal(glass(r.glass), true, 'its first window');
    assert.equal(glass(r.glass + n.windows - 1), true, 'its last window');
    assert.equal(glass(r.glass + n.windows), false, 'one past its windows');
    assert.equal(glass(r.glass + r.size - 1), false, 'the end of its range');
    assert.equal(glass(r.doorGlass + n.doorGlass - 1), true, 'its last door glass');
    assert.equal(glass(r.doorGlass + n.doorGlass), false, 'one past its door glass');
  });
}
