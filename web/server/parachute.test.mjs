import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DROP, dropSince, dropStart, fly, HOME_DROP } from '../shared/parachute.mjs';
import { FLAG, playerFields, readPlayer } from '../shared/wire.mjs';
import { Game } from './game.mjs';

const state = { x: 1, y: 20, z: 2, yaw: 0, pitch: 0, armed: true, w: 'pistol', c: false, flying: false };
const MAX_SPEED = 16; // m/s down: the server's limit (game.mjs)
const RUN_SPEED = 1.4 * 2.5 * 1.3; // m/s across on foot (game.mjs)

test('the parachute flag travels in a tick without touching the teleport counter', () => {
  for (const warp of [0, 1, 2, 3]) {
    const f = playerFields({ ...state, chute: true }, true, true, warp);
    assert.equal(f[5] & FLAG.chute, FLAG.chute);
    const p = readPlayer(['a', 0, ...f]);
    assert.equal(p.chute, true);
    assert.equal(p.warp, warp);
    assert.equal(p.safe, true);
    assert.equal(readPlayer(['a', 0, ...playerFields(state, true, false, warp)]).chute, false);
  }
});

test('a drop starts DROP.reach behind the place it lands on, whichever way it faces', () => {
  for (const yaw of [0, 1, -2.5, Math.PI]) {
    const s = dropStart(10, -5, yaw);
    // Forward is (-sin yaw, -cos yaw): gliding forward from the start reaches the place.
    assert.ok(Math.abs(s.x + -Math.sin(yaw) * DROP.reach - 10) < 1e-9);
    assert.ok(Math.abs(s.z + -Math.cos(yaw) * DROP.reach + 5) < 1e-9);
  }
});

test('a drop comes from high up, mostly straight down, in about 11 s, inside what the server allows', () => {
  assert.ok(DROP.height >= 60, 'much higher than the old 18 m');
  assert.ok(DROP.time > 9.5 && DROP.time < 12.5, `takes ${DROP.time} s`);
  assert.ok(DROP.reach < 16, `starts ${DROP.reach} m from where it lands`);
  // Ends by DROP.maxMs with room to spare, and not much later: that is how long it protects at most.
  assert.ok(DROP.maxMs >= DROP.time * 1000 + 3000 && DROP.maxMs <= DROP.time * 1000 + 6000);
  // At any frame rate a page runs (the game's step is at most 0.05 s): under the server's speed limits,
  // and landing where the server expects (within half a metre of DROP.reach, on time).
  for (const dt of [1 / 20, 1 / 30, 1 / 60, 1 / 144]) {
    const f = fly(dt);
    assert.ok(f.down < MAX_SPEED - 1.5, `down ${f.down} m/s at dt ${dt}`);
    assert.ok(f.across * 1.08 < RUN_SPEED, `across ${f.across} m/s at dt ${dt}`); // pushing forward adds 8 %
    assert.ok(Math.abs(f.reach - DROP.reach) < 0.5, `reach ${f.reach} at dt ${dt}`);
    assert.ok(Math.abs(f.time - DROP.time) < 0.2);
  }
  // The free fall really is one: most of the height goes before the canopy is open.
  const open = fly().path.find((p) => p.t >= DROP.fall + DROP.open + DROP.brake);
  assert.ok(open.y < DROP.height * 0.3 && open.x < 3, `canopy open at ${open.y} m, ${open.x} m along`);
  // Someone first seen part way down is drawn as far along as they are.
  assert.equal(dropSince(0), 0);
  assert.ok(Math.abs(dropSince(DROP.height - open.y) - (DROP.fall + DROP.open + DROP.brake)) < 0.1);
});

test('the house drop lands on the house start, in the lane', () => {
  const house = JSON.parse(readFileSync(new URL('../src/data/house.json', import.meta.url), 'utf8'));
  assert.equal(HOME_DROP.x, house.spawn.x);
  assert.equal(HOME_DROP.z, house.spawn.z);
  const spawns = JSON.parse(readFileSync(new URL('../shared/spawns.json', import.meta.url), 'utf8'));
  assert.equal(Math.hypot(spawns[0].x - HOME_DROP.x, spawns[0].z - HOME_DROP.z), 0, 'where the server has everyone who joins');
});

test('under a parachute nobody shoots or is hurt, until landing gives the usual short protection', () => {
  const g = Object.create(Game.prototype);
  const p = { state: { ...state, x: 300, z: 300 }, protectedUntil: 0, drop: null };
  const now = Date.now();
  assert.equal(g.calm(p), false); // far from the school grounds
  g.startDrop(p, now);
  assert.equal(g.dropping(p, now), true);
  assert.equal(g.calm(p), true);
  assert.equal(p.protectedUntil, now + DROP.maxMs);
  assert.equal(g.dropping(p, now + DROP.maxMs), false); // a drop that takes too long ends
  g.landed(p, now + 1000);
  assert.equal(p.drop, null);
  assert.equal(g.calm(p), false);
  assert.ok(p.protectedUntil > now + 1000 && p.protectedUntil <= now + 1000 + 5000);
});

/** A game with just enough for a start: no cars or horses, the edge everywhere, messages kept. */
function startGame(rules = {}) {
  const g = Object.create(Game.prototype);
  const sent = [];
  Object.assign(g, {
    rules: { parachute: true, portals: true, ...rules },
    carOf: () => null,
    horseOf: () => null,
    fence: () => ({ inside: () => true }),
    send: (_ws, m) => sent.push(m),
  });
  return { g, sent };
}
const joined = (now, at = { x: 4.5, y: -0.1, z: 19 }) => ({
  ws: {}, alive: true, spawned: false, joinTime: now, joinedAt: { x: at.x, z: at.z }, protectedUntil: now + 2000, drop: null, warp: 0, stamp: 0,
  state: { x: at.x, y: at.y, z: at.z, yaw: 0, pitch: 0, armed: false, flying: false, w: 'pistol', c: false },
});

test('a fresh arrival at the house drops when the server says so, once, and only onto where it is', () => {
  const now = Date.now();
  const { g, sent } = startGame();
  const p = joined(now);
  g.spawn('a', p, 'home', now + 2000);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { t: 'spawn', ok: true, drop: 1, x: HOME_DROP.x, z: HOME_DROP.z, yaw: HOME_DROP.yaw });
  assert.equal(g.dropping(p, now + 2000), true);
  assert.equal(p.protectedUntil, now + 2000 + DROP.maxMs);
  const from = dropStart(HOME_DROP.x, HOME_DROP.z, HOME_DROP.yaw);
  assert.ok(Math.abs(p.state.x - from.x) < 1e-9 && Math.abs(p.state.z - from.z) < 1e-9);
  assert.ok(p.state.y > DROP.height - 5);
  // Once: a second ask, or a start place after it, does nothing.
  g.spawn('a', p, 'home', now + 3000);
  g.spawn('a', p, 'church', now + 3000);
  assert.equal(sent.length, 1);
});

test('no house drop with the rule off, late, far from the start, dead, or for an unknown place', () => {
  const now = Date.now();
  const cases = [
    [{ parachute: false }, joined(now), now + 1000],
    [{}, joined(now), now + 91_000],
    [{}, joined(now, { x: 40, y: 0, z: 19 }), now + 1000], // a reconnect elsewhere: no free trip to the house
    [{}, { ...joined(now), alive: false }, now + 1000],
  ];
  for (const [rules, p, at] of cases) {
    const { g, sent } = startGame(rules);
    const before = { ...p.state };
    g.spawn('a', p, 'home', at);
    assert.equal(sent.length, 0);
    assert.equal(p.drop, null);
    assert.deepEqual(p.state, before);
  }
  const { g, sent } = startGame();
  const p = joined(now);
  g.spawn('a', p, 'nowhere', now + 1000);
  assert.equal(sent.length, 0);
  assert.equal(p.spawned, false);
});

test('a start place by parachute tells the page where it lands and facing which way', () => {
  const now = Date.now();
  const { g, sent } = startGame();
  const p = joined(now);
  g.spawn('a', p, 'church', now + 1000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].drop, 1);
  assert.equal(typeof sent[0].yaw, 'number');
  const from = dropStart(sent[0].x, sent[0].z, sent[0].yaw);
  assert.ok(Math.abs(p.state.x - from.x) < 1e-9 && Math.abs(p.state.z - from.z) < 1e-9);
});

test('/parachute drops onto where the player stands, then not again for a minute', () => {
  const now = Date.now();
  const { g, sent } = startGame();
  g.modes = { active: false };
  const p = joined(now - 120_000, { x: 4.5, y: -0.1, z: 19 }); // in the lane, long after joining
  p.state.yaw = 0.4;
  g.manualDrop('a', p, now);
  assert.deepEqual(sent[0], { t: 'spawn', ok: true, drop: 1, x: 4.5, z: 19, yaw: 0.4 });
  assert.equal(g.dropping(p, now), true);
  const from = dropStart(4.5, 19, 0.4);
  assert.ok(Math.abs(p.state.x - from.x) < 1e-9 && Math.abs(p.state.z - from.z) < 1e-9);
  assert.ok(p.state.y > DROP.height - 5);
  // Landed (the drop is over): still a minute between two.
  g.landed(p, now + 12_000);
  p.state = { ...p.state, x: 4.5, y: -0.1, z: 19 };
  g.manualDrop('a', p, now + 30_000);
  assert.deepEqual(sent[1], { t: 'chute', ok: false, code: 'chuteWait', args: { s: 30 } });
  g.manualDrop('a', p, now + 61_000);
  assert.equal(sent[2].t, 'spawn');
});

test('no /parachute with the rule off, dead, in a game, just after a hit, indoors, or under a parachute already', () => {
  const now = Date.now();
  const cases = [
    ['chuteOff', { parachute: false }, (p) => p, false],
    ['chuteNotNow', {}, (p) => ({ ...p, alive: false }), false],
    ['chuteNotNow', {}, (p) => p, true], // a game of the menu (Zombies, a party game)
    ['chuteFight', {}, (p) => ({ ...p, hurtAt: now - 5000 }), false],
    ['chuteIndoors', {}, (p) => ({ ...p, state: { ...p.state, x: 2.5, y: -0.1, z: 5 } }), false], // a bedroom of the house
    ['chuteNotNow', {}, (p) => ({ ...p, drop: { from: now - 1000, until: now + 9000 } }), false],
  ];
  for (const [code, rules, change, active] of cases) {
    const { g, sent } = startGame(rules);
    g.modes = { active };
    const p = change(joined(now - 120_000));
    const before = { ...p.state };
    g.manualDrop('a', p, now);
    assert.deepEqual(sent, [{ t: 'chute', ok: false, code, args: {} }], code);
    assert.deepEqual(p.state, before);
  }
});
