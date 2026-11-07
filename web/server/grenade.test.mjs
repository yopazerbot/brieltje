import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Game } from './game.mjs';
import { blastPoint, NADE_SLACK } from './grenade.mjs';

const GRENADE = JSON.parse(readFileSync(new URL('../shared/grenade.json', import.meta.url), 'utf8'));
const REACH = GRENADE.speed * (GRENADE.fuse + NADE_SLACK);

test('a blast point within an honest throw stays where the browser says', () => {
  const from = { x: 10, y: 1.5, z: 20, vh: 15 };
  assert.deepEqual(blastPoint(from, { x: 40, y: 0, z: 20 }, GRENADE), { x: 40, y: 0, z: 20 });
  assert.deepEqual(blastPoint(from, { x: 10, y: -12, z: 20 }, GRENADE), { x: 10, y: -12, z: 20 }, 'dropped from a roof: falling is not limited');
});

test('a forged blast far away is pulled back to the edge of the reach, towards the throw', () => {
  const at = blastPoint({ x: 0, y: 1.5, z: 0 }, { x: 0, y: 0, z: 59 }, GRENADE);
  assert.ok(Math.abs(at.z - REACH) < 1e-9 && at.x === 0, JSON.stringify(at));
  assert.ok(REACH < 50, 'about 49 m: the throw speed times the fuse and a little slack');
  const slow = blastPoint({ x: 0, y: 1.5, z: 0, vh: 2 }, { x: 30, y: 0, z: 0 }, GRENADE);
  assert.ok(slow.x <= 2 * (GRENADE.fuse + NADE_SLACK) + 1 + 1e-9, `a throw that carried 2 m/s lands near (${slow.x})`);
  const high = blastPoint({ x: 0, y: 1.5, z: 0 }, { x: 0, y: 150, z: 0 }, GRENADE);
  assert.ok(high.y < 20, `no blast high above the thrower (${high.y})`);
});

test('the game server: a far blast hurts only where the throw could reach, from where the server has the thrower', () => {
  const game = new Game({ session: () => null }, []);
  game.broadcast = () => {};
  const blasts = [];
  game.blast = (name, at) => blasts.push(at);
  const p = {
    key: 'k-t', role: 'player', alive: true, state: { x: 0, y: 0, z: 30, yaw: 0, pitch: 0, armed: true, flying: false, w: 'pistol', c: false },
    nades: Array(GRENADE.carry).fill(0), thrown: [], weapons: new Set(['pistol']),
  };
  game.players.set('t', p);
  const t0 = Date.now();
  // The throw says it starts 2 m from where the server has the thrower (within the 3 m it allows).
  game.throwNade('t', p, { t: 'nade', x: 2, y: 1.5, z: 30, vx: 14, vy: 2.2, vz: 0 }, t0);
  game.boom('t', p, { t: 'boom', x: 59, y: 0, z: 30 }, t0 + GRENADE.fuse * 1000);
  assert.equal(blasts.length, 1);
  assert.ok(Math.abs(blasts[0].x - REACH) < 1e-6, `pulled back to ${REACH} m from the server's position (${blasts[0].x})`);
  game.throwNade('t', p, { t: 'nade', x: 0, y: 1.5, z: 30, vx: 14, vy: 2.2, vz: 0 }, t0);
  game.boom('t', p, { t: 'boom', x: 30, y: 0, z: 30 }, t0 + GRENADE.fuse * 1000);
  assert.equal(blasts[1].x, 30, 'an honest throw is not touched');
});
