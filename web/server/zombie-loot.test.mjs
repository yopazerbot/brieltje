// The Zombies game's five newer rewards on the server (server/zombies.mjs, shared/loot.mjs): a page only
// says "I walked over item 12" (zitem). What is in it, how much, where and for whom is the server's.
// These are the forged and raced messages a page could send, and what the server does with each.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { makeBounds } from '../shared/bounds.mjs';
import { LOOT } from '../shared/loot.mjs';
import { makeNav } from '../shared/zombies.mjs';
import { Game } from './game.mjs';
import { ZombieGame } from './zombies.mjs';

const GRENADE = JSON.parse(readFileSync(new URL('../shared/grenade.json', import.meta.url), 'utf8'));
const nav = makeNav({ prisms: [], height: () => 0, edge: makeBounds([[-40, -40], [40, -40], [40, 40], [-40, 40]]) });

function player(x) {
  return {
    key: `k-${x}`, role: 'player', alive: true, hp: 100, protectedUntil: 0, ws: [],
    state: { x, y: 0, z: 0, yaw: 0, pitch: 0, armed: true, flying: false, w: 'pistol', c: false },
    weapons: new Set(['pistol']), nades: Array(GRENADE.carry).fill(0), thrown: [], score: { kills: 0, deaths: 0, points: 0 },
  };
}

/** A real game server with a Zombies game on an open field: players `a` and `b` side by side at the start. */
function fixture() {
  const game = new Game({ session: () => null }, []);
  const all = [];
  game.broadcast = (m) => all.push(m);
  game.send = (ws, m) => ws?.push(m);
  game.stats = () => {};
  game.zombieGround = () => ({ nav, spots: nav.spawnSpots(), home: { x: 0, z: 0 }, edge: nav.edge });
  game.players.set('a', player(0));
  game.players.set('b', player(0.5));
  const z = new ZombieGame(game, game.modes, ['a', 'b'], Date.now());
  game.modes.state = { kind: 'zombies', phase: 'break', until: 0, z };
  const a = game.players.get('a');
  const b = game.players.get('b');
  /** A message from `p`'s page, as the socket hands it to the server; the pickup's rate cleared first unless `keep`. */
  const say = (name, m, keep = false) => {
    const p = game.players.get(name);
    if (!keep) p.nextItem = 0;
    game.handle(name, p, JSON.stringify(m));
  };
  const gifts = (p) => p.ws.filter((m) => m.t === 'zgift');
  return { game, z, all, a, b, say, gifts };
}

test('forged, raced and out-of-place pickups find nothing: the item and the health stay', () => {
  const f = fixture();
  const { z, a, say, gifts } = f;
  a.hp = 40;
  const it = z.loot.put('medkit', 0, 0, 0, Date.now());
  const unchanged = (why) => {
    assert.ok(z.loot.items.has(it.id), `${why}: the item lies there still`);
    assert.equal(a.hp, 40, `${why}: health as it was`);
    assert.equal(gifts(a).length, 0, `${why}: nothing given`);
  };
  for (const id of [String(it.id), it.id + 0.5, null, {}, [it.id], -1, 1e9]) {
    say('a', { t: 'zitem', id });
    unchanged(`id ${JSON.stringify(id)}`);
  }
  say('a', { t: 'zitem' });
  unchanged('no id');
  const cases = [
    ['down', () => (a.alive = false), () => (a.alive = true)],
    ['unarmed', () => (a.state.armed = false), () => (a.state.armed = true)],
    ['in a car', () => (f.game.inCar = (n) => n === 'a'), () => delete f.game.inCar],
    ['game over', () => (z.horde.phase = 'over'), () => (z.horde.phase = 'break')],
    ['5 m away', () => (a.state.x = 5), () => (a.state.x = 0)],
    ['a floor up', () => (a.state.y = 3), () => (a.state.y = 0)],
  ];
  for (const [why, set, undo] of cases) {
    set();
    say('a', { t: 'zitem', id: it.id });
    undo();
    unchanged(why);
  }
  say('a', { t: 'zitem', id: it.id });
  assert.equal(a.hp, 90, 'and taken, honestly, once');
  assert.equal(z.loot.items.has(it.id), false);
});

test('a second pickup within 250 ms is not looked at; two players on one item: one gets it', () => {
  const { z, a, b, say, gifts } = fixture();
  const one = z.loot.put('armor', 0, 0, 0, Date.now());
  const two = z.loot.put('armor', 0.2, 0, 0, Date.now());
  say('a', { t: 'zitem', id: one.id });
  say('b', { t: 'zitem', id: one.id }); // b stands half a metre away: within reach, but it is a's now
  assert.equal(gifts(a).length, 1);
  assert.equal(gifts(b).length, 0);
  say('b', { t: 'zitem', id: two.id });
  assert.equal(gifts(b).length, 1, 'b takes the other one (a moment later)');
  const three = z.loot.put('nades', 0, 0, 0, Date.now());
  say('a', { t: 'zitem', id: three.id }, true); // a just took one: too soon
  assert.ok(z.loot.items.has(three.id));
  assert.equal(z.loot.kit('a').nades, 0);
});

test('a page that names a kind, a gun or its health gets the item\'s own kind only', () => {
  const { z, a, say, gifts } = fixture();
  const it = z.loot.put('armor', 0, 0, 0, Date.now());
  say('a', { t: 'zitem', id: it.id, hp: 1, kind: 'gun', w: 'bazooka', armor: 999, nades: 99 });
  const [g] = gifts(a);
  assert.equal(g.kind, 'armor');
  assert.equal(g.w, undefined);
  assert.equal(g.hp, undefined);
  assert.equal(a.hp, 100);
  assert.deepEqual([...a.weapons], ['pistol']);
  assert.equal(z.loot.kit('a').armor, LOOT.armor);
  assert.equal(z.loot.kit('a').nades, 0);
});

test('a first-aid kit on the server\'s count of your health: 40 to 90, 80 to 100, refused at 95', () => {
  const { z, a, say, gifts } = fixture();
  for (const [hp, after] of [[40, 90], [80, 100], [95, 95]]) {
    a.hp = hp;
    a.ws.length = 0;
    const it = z.loot.put('medkit', 0, 0, 0, Date.now());
    say('a', { t: 'zitem', id: it.id });
    assert.equal(a.hp, after, `from ${hp}`);
    if (hp === 95) {
      assert.ok(z.loot.items.has(it.id), 'left for a hurt teammate');
      assert.equal(gifts(a).length, 0);
    } else assert.equal(gifts(a)[0].hp, after, 'the page is told its health');
  }
});

test('a supply crate puts a gun you lack among the guns the server checks your hits with', () => {
  const { z, a, say, gifts } = fixture();
  a.weapons = new Set(['pistol', 'rifle', 'sniper']);
  const it = z.loot.put('gun', 0, 0, 0, Date.now());
  say('a', { t: 'zitem', id: it.id });
  assert.equal(gifts(a)[0].w, 'shotgun');
  assert.ok(a.weapons.has('shotgun'));
  const full = z.loot.put('gun', 0, 0, 0, Date.now());
  say('a', { t: 'zitem', id: full.id });
  assert.ok(z.loot.items.has(full.id), 'all three carried: it stays');
});

test('the vest takes a swipe: health kept, still a hit (a help up stops), not while protected, gone when down', () => {
  const { game, z, a, b } = fixture();
  const now = Date.now();
  z.loot.kit('a').armor = LOOT.armor;
  // b goes down; a starts to help them up.
  game.npcDamage('b', b, 500, now, 'a zombie');
  assert.ok(z.down.has('b'));
  z.help('a', a, { on: true, name: 'b' }, now);
  assert.equal(z.helping.get('a')?.target, 'b');
  // A swipe of 20 from a zombie the server has (the horde's own event).
  z.horde.zombies.set(99, { id: 99, kind: 0, x: 1, y: 0, z: 0, act: 'attack' });
  z.horde.tick = () => [{ type: 'swipe', name: 'a', id: 99, damage: 20 }];
  z.tick(now + 10, 50);
  assert.equal(a.hp, 100, 'the vest took it all');
  assert.equal(z.loot.kit('a').armor, LOOT.armor - 20);
  assert.equal(a.hurtAt, now + 10);
  const hurt = a.ws.filter((m) => m.t === 'hurt').at(-1);
  assert.deepEqual([hurt.hp, hurt.from], [100, { x: 1, z: 0 }], 'the page still shows where from');
  assert.equal(a.ws.filter((m) => m.t === 'zgift').at(-1).kit.armor, LOOT.armor - 20, 'and is told its vest');
  z.horde.tick = () => [];
  z.tick(now + 20, 50);
  assert.equal(z.helping.has('a'), false, 'hit while helping: let go');
  // Protected (just back): the swipe takes nothing, vest included.
  a.protectedUntil = now + 10_000;
  z.horde.tick = () => [{ type: 'swipe', name: 'a', id: 99, damage: 20 }];
  z.tick(now + 30, 50);
  assert.equal(z.loot.kit('a').armor, LOOT.armor - 20);
  a.protectedUntil = 0;
  // More than the vest has: the rest takes health.
  z.horde.tick = () => [{ type: 'swipe', name: 'a', id: 99, damage: 50 }];
  z.tick(now + 40, 50);
  assert.equal(z.loot.kit('a').armor, 0);
  assert.equal(a.hp, 80);
  // Out of reach too long: down past the vest (penalty evasion), and the vest is gone.
  z.loot.kit('a').armor = LOOT.armor;
  z.horde.tick = () => [{ type: 'perchOut', name: 'a' }];
  z.tick(now + 50, 50);
  assert.equal(a.alive, false);
  assert.ok(z.down.has('a'));
  assert.equal(z.loot.kit('a').armor, 0);
  assert.equal(a.ws.filter((m) => m.t === 'zgift').at(-1).kit.armor, 0);
});

test('spare grenades: counted on the server, one throw and one blast each, never outside Zombies', () => {
  const { game, z, a } = fixture();
  const blasts = [];
  game.blast = (name, at) => blasts.push(at);
  const t0 = Date.now();
  const thrown = () => a.thrown.length;
  const nade = (now) => game.throwNade('a', a, { t: 'nade', x: 0, y: 1.5, z: 0, vx: 5, vy: 2, vz: 0 }, now);
  a.nades.fill(t0 + 60_000); // both regular ones out
  nade(t0);
  assert.equal(thrown(), 0, 'no regular one back and no spare: refused');
  z.loot.kit('a').nades = 1;
  nade(t0 + 1000);
  assert.equal(thrown(), 1, 'a spare');
  assert.equal(z.loot.kit('a').nades, 0);
  assert.equal(a.ws.filter((m) => m.t === 'zgift').at(-1).kit.nades, 0, 'the page is told what is left');
  nade(t0 + 3000);
  assert.equal(thrown(), 1, 'that spare was used once');
  z.loot.kit('a').nades = 2;
  nade(t0 + 5000);
  nade(t0 + 5000 + LOOT.nadeGap - 1);
  assert.equal(thrown(), 2, `within ${LOOT.nadeGap} ms of the last throw: refused`);
  assert.equal(z.loot.kit('a').nades, 1);
  // Three spares: three throws, three blasts, not one more.
  a.thrown.length = 0;
  z.loot.kit('a').nades = 3;
  const t1 = t0 + 10_000;
  for (const dt of [0, 500, 1000]) nade(t1 + dt);
  assert.equal(a.thrown.length, 3);
  assert.equal(z.loot.kit('a').nades, 0);
  for (const dt of [0, 500, 1000, 1100]) game.boom('a', a, { t: 'boom', x: 3, y: 0, z: 0 }, t1 + GRENADE.fuse * 1000 + dt);
  assert.equal(blasts.length, 3);
  // Outside Zombies a spare counts for nothing.
  z.loot.kit('a').nades = 3;
  game.modes.state = { kind: 'free' };
  nade(t1 + 20_000);
  assert.equal(a.thrown.length, 0);
  assert.equal(z.loot.kit('a').nades, 3);
});
