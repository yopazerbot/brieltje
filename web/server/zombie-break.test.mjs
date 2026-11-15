// The break between Zombies waves grows a second a wave, up to 25 s (shared/zombies.mjs breakAfter), and
// the server keeps to it: its clock, the line it says and what a page joining in the break is told.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBounds } from '../shared/bounds.mjs';
import { breakAfter, makeNav, ZOMBIE } from '../shared/zombies.mjs';
import { Modes } from './modes.mjs';
import { ZombieGame } from './zombies.mjs';

const edge = makeBounds([[-40, -40], [40, -40], [40, 40], [-40, 40]]);
const nav = makeNav({ prisms: [], height: () => 0, edge });

test('the break: 8 s before wave 1, 15 s plus a second for each wave beaten, 25 s at most', () => {
  assert.equal(breakAfter(0), 8000);
  assert.equal(breakAfter(0), ZOMBIE.firstBreak);
  assert.equal(breakAfter(1), 16000);
  assert.equal(breakAfter(3), 18000);
  assert.equal(breakAfter(5), 20000);
  assert.equal(breakAfter(9), 24000);
  for (const n of [10, 11, 30, 9999]) assert.equal(breakAfter(n), 25000, `after wave ${n}`);
  for (let n = 1; n < 40; n++) assert.ok(breakAfter(n + 1) >= breakAfter(n), 'never shorter for a later wave');
});

test('the break for odd inputs stays between 8 and 25 s', () => {
  const odd = [-1, -1e9, NaN, 0.5, 1.5, 9.99, 10.5, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE, 1e308, undefined, null];
  for (const n of odd) {
    const ms = breakAfter(n);
    assert.ok(Number.isFinite(ms) && ms >= 8000 && ms <= 25000, `${n}: ${ms}`);
  }
  assert.equal(breakAfter(-1), 8000);
  assert.equal(breakAfter(NaN), 8000);
  assert.equal(breakAfter(1.5), 16000, 'a float: its whole waves');
  assert.equal(breakAfter(Number.MAX_SAFE_INTEGER), 25000);
});

/** A real ZombieGame and Modes on an open field: two players who fight, nobody in the air. */
function fixture() {
  const messages = [];
  const makePlayer = (name, x) => ({ key: `session-${name}`, ws: {}, state: { x, y: 0, z: 0, armed: true }, alive: true, hp: 100, protectedUntil: 0 });
  const game = {
    players: new Map([['admin', makePlayer('admin', 0)], ['guest', makePlayer('guest', 1)]]), zombieBests: {},
    broadcast: (m) => messages.push(m), send: () => {}, inCar: () => false, calm: () => false, dropping: () => false,
    zombieGround: () => ({ nav, spots: nav.spawnSpots(), home: { x: 0, z: 0 }, edge }), saveZombieBest: () => {}, gather: () => {},
  };
  const modes = new Modes(game);
  const z = new ZombieGame(game, modes, ['admin', 'guest'], 0);
  modes.state = { kind: 'zombies', phase: 'break', until: z.horde.until, z };
  return { game, modes, z, messages };
}

test('on the server the break after wave 3 lasts 18 s, the line says 18, and a page joining in it sees the time left', () => {
  const { modes, z, messages } = fixture();
  const TICK = 50;
  let now = 1000;
  z.selectWave(3, 'admin', now);
  assert.equal(z.horde.wave, 3);
  // Wave 3 beaten: every zombie down as soon as it is out.
  let clearedAt = -1;
  for (; now < 200_000 && clearedAt < 0; now += TICK) {
    for (const q of z.horde.zombies.values()) if (q.act !== 'down') z.horde.hit(q.id, 1e9, 'admin', now);
    z.tick(now, TICK);
    if (messages.some((m) => m.code === 'zCleared')) clearedAt = now;
  }
  assert.ok(clearedAt > 0, 'wave 3 beaten');
  const line = messages.find((m) => m.code === 'zCleared');
  assert.deepEqual(line.args, { n: 3, s: 18 });
  assert.match(line.text, /in 18 seconds/);
  assert.equal(z.horde.phase, 'break');
  assert.equal(z.horde.until - clearedAt, 18000);
  assert.equal(z.view(clearedAt).ms, 18000);
  // A page joining 5 s into the break: the view it gets has 13 s left.
  assert.equal(modes.view(clearedAt + 5000).ms, 13000);
  assert.equal(modes.view(clearedAt + 5000).zombies.ms, 13000);
  // The next wave comes 18 s on, not a tick before (the server's clock, its 50 ms ticks).
  for (now = clearedAt + TICK; z.horde.phase === 'break' && now < clearedAt + 60_000; now += TICK) {
    z.tick(now, TICK);
    if (z.horde.phase === 'break') assert.ok(now < clearedAt + 18000, `still the break at ${now - clearedAt} ms`);
  }
  const startedAt = now - TICK;
  assert.equal(z.horde.wave, 4);
  assert.ok(startedAt - clearedAt >= 18000 && startedAt - clearedAt < 18000 + TICK, `wave 4 ${startedAt - clearedAt} ms after wave 3`);
});

test('after a chosen wave 30 the break is 25 s', () => {
  const { z, messages } = fixture();
  let now = 1000;
  z.selectWave(30, 'admin', now);
  let clearedAt = -1;
  for (; now < 600_000 && clearedAt < 0; now += 50) {
    for (const q of z.horde.zombies.values()) if (q.act !== 'down') z.horde.hit(q.id, 1e9, 'admin', now);
    z.tick(now, 50);
    if (messages.some((m) => m.code === 'zCleared')) clearedAt = now;
  }
  assert.ok(clearedAt > 0, 'wave 30 beaten');
  assert.deepEqual(messages.find((m) => m.code === 'zCleared').args, { n: 30, s: 25 });
  assert.equal(z.horde.until - clearedAt, 25000);
});
