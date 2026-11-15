import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CAT_SLACK, catWalk } from '../shared/cats.mjs';
import { VILLAGER_RANGE } from '../shared/villagers.mjs';
import { Game } from './game.mjs';

// A cat shot down (game.mjs catInReach): only within the guns' reach of where the server has the shooter, in three
// dimensions, or within a blast's radius of the blast the server set off for them. Before, a walker anywhere on the map
// felled any cat (hit forgery): the handler asked only alive, armed and the rate.

const CATS = JSON.parse(readFileSync(new URL('../shared/cats.json', import.meta.url), 'utf8'));

function setup() {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const game = new Game({ session: () => null, store: { addStats: async () => {}, setMeta: async () => {} }, log: () => {} }, []);
  for (const t of game.timers) clearInterval(t);
  const told = [];
  game.broadcast = (m) => told.push(structuredClone(m));
  game.send = () => {};
  game.stampState = () => {};
  const player = (name, at) => {
    const p = {
      ws: { name }, key: `k-${name}`, role: 'player', alive: true, protectedUntil: 0, drop: null, warp: 0, stamp: 0,
      state: { x: at.x, y: at.y, z: at.z, yaw: 0, pitch: 0, armed: true, flying: false, w: 'rifle', c: false },
      weapons: new Set(['pistol', 'rifle']), nades: [0, 0], thrown: [], window: clock, msgs: 0, states: 0, others: 0, budget: 0.5, vbudget: 0.5, movedAt: clock,
      hp: 100, score: { kills: 0, deaths: 0, points: 0 }, proto: 2,
    };
    game.players.set(name, p);
    return p;
  };
  /** A cat message from `p` (`ms` later), with the flood guard's window and the 300 ms rate let go. */
  const shoot = (p, i, w = 'rifle', ms = 400) => {
    clock += ms;
    p.window = clock;
    p.msgs = p.states = p.others = 0;
    p.nextCat = 0;
    game.handle(p.ws.name, p, JSON.stringify({ t: 'cat', i, w }));
    return told.filter((m) => m.t === 'cat' && m.i === i).length;
  };
  return { game, told, player, shoot, now: () => clock, at: (ms) => (clock += ms), cat: (i) => catWalk(CATS, i, clock / 1000) };
}

test('a cat is felled from within the guns\' reach, never from across the map or high over it', () => {
  const s = setup();
  for (let i = 0; i < CATS.cats.length; i++) {
    const c = s.cat(i);
    const far = s.player(`far${i}`, { x: c.x + 400, y: -0.1, z: c.z });
    assert.equal(s.shoot(far, i), 0, `cat ${i} from 400 m away`);
    // Straight over it, higher than the reach: the height counts.
    const high = s.player(`high${i}`, { x: c.x, y: VILLAGER_RANGE + CAT_SLACK + 15, z: c.z });
    assert.equal(s.shoot(high, i), 0, `cat ${i} from high over it`);
    const near = s.player(`near${i}`, { x: c.x + 12, y: -0.1, z: c.z });
    assert.equal(s.shoot(near, i), 1, `cat ${i} from 12 m`);
  }
});

test('a sniper at the edge of the reach still fells it; the slack covers a page a moment behind', () => {
  const s = setup();
  const c = s.cat(0);
  const sniper = s.player('sniper', { x: c.x + VILLAGER_RANGE, y: -0.1, z: c.z });
  assert.equal(s.shoot(sniper, 0, 'rifle', 0), 1);
});

test('a blast fells a cat near it only when the server set that blast off for this player, not long ago', () => {
  const s = setup();
  const c = s.cat(1);
  const far = s.player('far', { x: c.x + 300, y: -0.1, z: c.z });
  // No blast of theirs: refused, whatever the page names.
  assert.equal(s.shoot(far, 1, 'grenade'), 0);
  // A grenade the server set off next to the cat (game.mjs blast): believed.
  far.lastBlast = { x: c.x + 2, y: -0.1, z: c.z, at: s.now(), w: 'grenade' };
  assert.equal(s.shoot(far, 1, 'grenade', 100), 1);
  // A blast long ago, or of another weapon, or too far from the cat: refused.
  const d = s.cat(2);
  far.lastBlast = { x: d.x, y: -0.1, z: d.z, at: s.now() - 5000, w: 'grenade' };
  assert.equal(s.shoot(far, 2, 'grenade', 100), 0, 'an old blast');
  far.lastBlast = { x: d.x, y: -0.1, z: d.z, at: s.now(), w: 'bazooka' };
  assert.equal(s.shoot(far, 2, 'grenade', 100), 0, 'another weapon\'s blast');
  far.lastBlast = { x: d.x + 40, y: -0.1, z: d.z, at: s.now(), w: 'grenade' };
  assert.equal(s.shoot(far, 2, 'grenade', 100), 0, 'a blast 40 m from it');
});

test('the page and the server walk the cats the same way (src/world/cats.ts uses shared/cats.mjs)', () => {
  const src = readFileSync(new URL('../src/world/cats.ts', import.meta.url), 'utf8');
  assert.match(src, /catWalk\(CATS, i, now\)/);
  // A cat walks at CATS.speed: in one second it moves no further than that.
  for (let t = 0; t < 120; t += 0.5) {
    const a = catWalk(CATS, 0, 1000 + t), b = catWalk(CATS, 0, 1000 + t + 1);
    assert.ok(Math.hypot(a.x - b.x, a.z - b.z) <= CATS.speed + 1e-9);
  }
});
