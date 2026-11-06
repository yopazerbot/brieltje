import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBounds } from '../shared/bounds.mjs';
import { makeNav } from '../shared/zombies.mjs';
import { Modes } from './modes.mjs';
import { LANDED_MS, ZombieGame } from './zombies.mjs';

const edge = makeBounds([[-40, -40], [40, -40], [40, 40], [-40, 40]]);
const nav = makeNav({ prisms: [], height: () => 0, edge });

test('a wave waits while anyone is still coming down by parachute, and comes LANDED_MS after the last landing', () => {
  const inAir = new Set(['guest']);
  const makePlayer = (name) => ({ key: `session-${name}`, ws: {}, state: { x: 0, y: 0, z: 0, armed: true }, alive: true, hp: 100, protectedUntil: 0 });
  const game = {
    players: new Map(['admin', 'guest'].map((name) => [name, makePlayer(name)])), zombieBests: {},
    broadcast: () => {}, send: () => {}, inCar: () => false, calm: () => false,
    dropping: (p) => !!p && inAir.has([...game.players].find(([, q]) => q === p)?.[0]),
    zombieGround: () => ({ nav, spots: nav.spawnSpots(), home: { x: 0, z: 0 }, edge }), saveZombieBest: () => {}, gather: () => {},
  };
  const modes = new Modes(game);
  const z = new ZombieGame(game, modes, ['admin', 'guest'], 0);
  modes.state = { kind: 'zombies', phase: 'break', until: z.horde.until, z };
  assert.equal(z.horde.phase, 'break');
  const first = z.horde.until;
  // Long past the first wave's usual start, the guest still in the air: still the break.
  let now = 0;
  for (; now < first + 15_000; now += 50) z.tick(now, 50);
  assert.equal(z.horde.phase, 'break');
  assert.ok(z.horde.until >= now + LANDED_MS - 1100, 'the break keeps a few seconds ahead');
  // Landed: the wave comes once the break's last stretch has run out, not before.
  inAir.clear();
  const landedAt = now;
  for (; z.horde.phase === 'break' && now < landedAt + 10_000; now += 50) z.tick(now, 50);
  assert.equal(z.horde.phase, 'wave');
  assert.ok(now - landedAt >= LANDED_MS - 1100 && now - landedAt <= LANDED_MS + 100, `wave ${now - landedAt} ms after landing`);
});
