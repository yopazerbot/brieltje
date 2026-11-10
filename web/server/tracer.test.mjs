import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';

// A shot may carry where its tracer goes (`tx, ty, tz`), for the others' picture only, and a state may
// say the gun is at the eye (`a`). The server passes on only what a real shot or aim could be: three
// finite numbers on the map within the gun's reach, from the two guns that have tracers; aiming only
// from an armed player. Each forged message below must come out harmless.

function setup() {
  const game = new Game({ session: () => null, store: { addStats: async () => {} } }, []);
  const told = [];
  game.broadcast = (m, except) => told.push({ ...m, except });
  game.send = () => {};
  game.stampState = () => {};
  const player = (name, w = 'rifle') => {
    const now = Date.now();
    const p = {
      ws: { name }, key: `k-${name}`, role: 'player', alive: true, protectedUntil: 0, drop: null, warp: 0, stamp: 0,
      state: { x: 5, y: 0, z: 5, yaw: 0, pitch: 0, armed: true, flying: false, w, c: false },
      weapons: new Set(['pistol', 'rifle', 'sniper']), nades: [0, 0], window: now, msgs: 0, states: 0, others: 0, budget: 0.5, vbudget: 0.5, movedAt: now,
      hp: 100, score: { kills: 0, deaths: 0, points: 0 },
    };
    game.players.set(name, p);
    return p;
  };
  /** A shot from `p`, with the wait for the next one let go; returns what the others were told. */
  const shot = (name, p, m) => {
    p.nextShot = 0;
    told.length = 0;
    game.handle(name, p, JSON.stringify({ t: 'shot', x: 5, y: 1.5, z: 5, ...m }));
    return told.find((t) => t.t === 'shot');
  };
  return { game, told, player, shot };
}

test('a rifle\'s tracer within reach is passed on', () => {
  const { player, shot } = setup();
  const anna = player('anna');
  const out = shot('anna', anna, { w: 'rifle', tx: 45, ty: 2, tz: 30 });
  assert.equal(out.name, 'anna');
  assert.deepEqual([out.tx, out.ty, out.tz], [45, 2, 30]);
});

test('no tracer from a gun without one, past its reach, or from numbers that are none', () => {
  const { player, shot } = setup();
  const anna = player('anna');
  for (const m of [
    { w: 'pistol', tx: 45, ty: 2, tz: 30 }, // the pistol has no tracers
    { w: 'rifle', tx: 5 + 400, ty: 2, tz: 5 }, // across the village
    { w: 'rifle', tx: 'NaN', ty: 2, tz: 30 },
    { w: 'rifle', tx: Infinity, ty: 2, tz: 30 },
    { w: 'rifle', tx: 45, tz: 30 }, // one missing
    { w: 'rifle', tx: { x: 1 }, ty: [2], tz: null },
  ]) {
    const out = shot('anna', anna, m);
    assert.ok(out, 'the shot itself is still heard');
    assert.equal('tx' in out || 'ty' in out || 'tz' in out, false, JSON.stringify(m));
  }
});

test('a shot said to come from far off comes from where the server has the shooter', () => {
  const { player, shot } = setup();
  const anna = player('anna'); // the server has her at (5, 0, 5)
  const near = shot('anna', anna, { w: 'rifle', x: 5.5, y: 1.6, z: 5.2 });
  assert.deepEqual([near.x, near.y, near.z], [5.5, 1.6, 5.2], 'her own point, close by');
  const far = shot('anna', anna, { w: 'rifle', x: 150, y: 1.5, z: -200, tx: 160, ty: 2, tz: -190 });
  assert.deepEqual([far.x, far.y, far.z], [5, 1.5, 5], 'not from across the village');
  assert.equal('tx' in far, false, 'and no tracer round a place she is not at');
});

test('a shot is still held to the gun\'s rate, with or without a tracer', () => {
  const { game, told, player } = setup();
  const anna = player('anna');
  told.length = 0;
  for (let i = 0; i < 20; i++) game.handle('anna', anna, JSON.stringify({ t: 'shot', w: 'rifle', x: 5, y: 1.5, z: 5, tx: 45, ty: 2, tz: 30 }));
  assert.equal(told.filter((t) => t.t === 'shot').length, 1);
});

test('aiming is kept only for an armed player', () => {
  const { game, player } = setup();
  const anna = player('anna', 'sniper');
  const state = (extra) => {
    anna.movedAt = Date.now() - 500;
    anna.window = Date.now();
    anna.states = 0;
    anna.msgs = 0;
    game.handle('anna', anna, JSON.stringify({ t: 'state', x: 5, y: 0, z: 5, yaw: 0, pitch: 0, w: 'sniper', ...extra }));
    return anna.state.a;
  };
  assert.equal(state({ armed: true, a: 1 }), true);
  assert.equal(state({ armed: true }), false);
  assert.equal(state({ armed: false, a: 1 }), false, 'no aiming without a gun in hand');
  assert.equal(state({ armed: true, a: 'yes' }), true, 'read as yes or no, whatever was sent');
  assert.equal(typeof anna.state.a, 'boolean');
});
