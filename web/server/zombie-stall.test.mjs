// The stall in the Zombies game on the server (server/zombies.mjs buy, beat and bonus; shared/stall.mjs):
// a page only says "I buy a claymore" (zbuy, one field). The coins, the price, the break, who buys and
// what it gives are the server's. One test per attack class: the forged, replayed, raced and
// out-of-place messages a page could send, and what the server does with each.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { makeBounds } from '../shared/bounds.mjs';
import { LOOT } from '../shared/loot.mjs';
import { priceOf, STALL } from '../shared/stall.mjs';
import { BIG, makeNav, RUNNER } from '../shared/zombies.mjs';
import { Game } from './game.mjs';
import { ZombieGame } from './zombies.mjs';

const GRENADE = JSON.parse(readFileSync(new URL('../shared/grenade.json', import.meta.url), 'utf8'));
const edge = makeBounds([[-40, -40], [40, -40], [40, 40], [-40, 40]]);
const nav = makeNav({ prisms: [], height: () => 0, edge });
const BAD = ['__proto__', 'constructor', 'toString', '', 'ammo', 'scope', 'stakes', 'lull', 5, null, {}, ['medkit'], 'MEDKIT', undefined];

function player(x) {
  return {
    key: `k-${x}`, role: 'player', alive: true, hp: 100, protectedUntil: 0, ws: [],
    state: { x, y: 0, z: 0, yaw: 0, pitch: 0, armed: true, flying: false, w: 'pistol', c: false },
    weapons: new Set(['pistol']), nades: Array(GRENADE.carry).fill(0), thrown: [], score: { kills: 0, deaths: 0, points: 0 },
  };
}

/** A real game server with a Zombies game on an open field, in the break: players `a` and `b` side by side. */
function fixture() {
  const game = new Game({ session: () => null }, []);
  const all = [];
  game.broadcast = (m) => all.push(m);
  game.send = (ws, m) => ws?.push(m);
  game.stats = () => {};
  game.zombieGround = () => ({ nav, spots: nav.spawnSpots(), home: { x: 0, z: 0 }, edge });
  game.players.set('a', player(0));
  game.players.set('b', player(0.5));
  const z = new ZombieGame(game, game.modes, ['a', 'b'], Date.now());
  game.modes.state = { kind: 'zombies', phase: 'break', until: 0, z };
  z.horde.phase = 'break';
  const a = game.players.get('a');
  const b = game.players.get('b');
  /** What each page was told as the game began; then the pages' logs start empty */
  const started = { a: [...a.ws], b: [...b.ws] };
  a.ws.length = 0;
  b.ws.length = 0;
  /** A message from `name`'s page, as the socket hands it to the server; the stall's and the shot's rate cleared first unless `keep`. */
  const say = (name, m, keep = false) => {
    const p = game.players.get(name);
    if (!keep) p.nextBuy = p.nextZombie = 0;
    game.handle(name, p, JSON.stringify(m));
  };
  const of = (p, t) => p.ws.filter((m) => m.t === t);
  const coins = (name) => z.stall.of(name);
  const lastCoins = (p) => of(p, 'zcoins').at(-1);
  const codes = (p) => of(p, 'system').map((m) => m.code);
  /** A zombie the server has, `hp` left, 5 m in front of the players. */
  const zombie = (id, kind = 0, hp = 1, x = 5) => z.horde.zombies.set(id, { id, kind, x, y: 0, z: 0, yaw: 0, hp, act: 'walk' });
  /** One shot of `w` on zombie `id`: one body hit (a shotgun: one pellet). */
  const shoot = (name, id, w = 'pistol') => say(name, { t: 'zhit', w, hits: [[id, 1, 0]] });
  return { game, z, all, a, b, started, say, of, coins, lastCoins, codes, zombie, shoot };
}

/** The kit's numbers and the coins of `name`, to compare before and after. */
const snap = (f, name) => {
  const p = f.game.players.get(name);
  return JSON.stringify({ c: f.coins(name), n: f.z.stall.view(name).n, kit: f.z.loot.kits.get(name) ?? null, hp: p.hp, w: [...p.weapons] });
};

test('1. coin forgery: no message carries coins; only a kill the server decided pays, and only its shooter', () => {
  const f = fixture();
  const { z, a, b, say, coins, zombie, shoot } = f;
  // Fields a page could add to a purchase, and the server's own messages sent up: nothing changes.
  for (const extra of [{ coins: 99999 }, { price: 0 }, { price: -500 }, { n: [0, 0, 0, 0, 0, 0] }, { c: 99999 }]) say('a', { t: 'zbuy', k: 'turret', ...extra });
  say('a', { t: 'zcoins', c: 99999, n: [] });
  say('a', { t: 'zgift', kind: 'turret', kit: { turrets: 1 } });
  say('a', { t: 'system', code: 'zBonus', args: { n: 99999 } });
  assert.equal(coins('a'), 0);
  assert.equal(z.loot.kit('a').turrets, 0);
  assert.deepEqual(f.codes(a), Array(5).fill('zStallShort'), 'each purchase refused for want of coins');
  // Shots at a zombie that is down already, or that the server doesn't have: no coins.
  zombie(1, 0, 1);
  z.horde.zombies.get(1).act = 'down';
  shoot('a', 1);
  shoot('a', 4242);
  assert.equal(coins('a'), 0);
  // Checked kills: a walker 10, a runner 15, a big one 100, to the shooter alone.
  zombie(2, 0, 1);
  shoot('a', 2);
  assert.equal(coins('a'), STALL.kill.walker);
  zombie(3, RUNNER, 1);
  shoot('a', 3);
  assert.equal(coins('a'), STALL.kill.walker + STALL.kill.runner);
  zombie(4, BIG, 1);
  shoot('a', 4);
  assert.equal(coins('a'), STALL.kill.walker + STALL.kill.runner + STALL.kill.big);
  assert.equal(coins('b'), 0, 'nobody else');
  assert.equal(f.of(b, 'zcoins').length, 0, 'and b\'s page hears nothing of it');
  assert.equal(f.lastCoins(a).c, 125, 'a\'s page is told');
  // A shot refused for its own reasons (a gun not held, too many pellets) beats nothing and pays nothing.
  zombie(5, 0, 1);
  say('a', { t: 'zhit', w: 'rifle', hits: [[5, 1, 0]] });
  say('a', { t: 'zhit', w: 'pistol', hits: [[5, 5, 0]] });
  assert.equal(coins('a'), 125);
});

test('2. attribution: the last hit gets the coins; a turret\'s, a claymore\'s and a grenade\'s kill pay their owner', () => {
  const f = fixture();
  const { z, a, b, coins, zombie, shoot } = f;
  zombie(1, 0, 40);
  shoot('a', 1); // 34: hurt
  assert.equal(coins('a'), 0);
  shoot('b', 1); // the last hit
  assert.equal(coins('b'), STALL.kill.walker);
  assert.equal(coins('a'), 0);
  // The turret's shot and the claymore's blast, as the tick hands them out (shared/loot.mjs tick).
  zombie(2, 0, 1);
  zombie(3, RUNNER, 1);
  const now = Date.now();
  z.horde.tick = () => [];
  z.loot.tick = () => ({ gone: [], booms: [{ mine: { id: 70, x: 5, y: 0, z: 0, yaw: 0, owner: 'b' }, ids: [3] }], broke: [], worn: 0, shots: [{ turret: { id: 60, owner: 'a', rounds: 9 }, id: 2 }], spent: [], faded: [] });
  z.tick(now, 50);
  assert.equal(coins('a'), STALL.kill.walker, 'the turret\'s owner');
  assert.equal(coins('b'), STALL.kill.walker + STALL.kill.runner, 'the claymore\'s owner');
  // A blast set off or checked by the server.
  zombie(4, 0, 1, 2);
  z.blast('a', { x: 2, y: 0, z: 0 }, 3, 200, 'nade', now);
  assert.equal(coins('a'), 2 * STALL.kill.walker);
  assert.equal(f.lastCoins(a).c, 20);
  assert.equal(f.lastCoins(b).c, 25);
});

test('3. buying for another player: the buyer is the socket\'s player; a name or for field is never read', () => {
  const f = fixture();
  const { z, a, b, say } = f;
  z.stall.coins.set('a', 500);
  const before = snap(f, 'b');
  say('a', { t: 'zbuy', k: 'claymore', name: 'b', for: 'b', by: 'b', to: 'b' });
  assert.equal(z.stall.of('a'), 500 - priceOf('claymore', 0));
  assert.equal(z.loot.kit('a').claymores, 1);
  assert.equal(snap(f, 'b'), before, 'b untouched');
  assert.equal(f.of(b, 'zgift').length + f.of(b, 'zcoins').length, 0);
  assert.equal(f.of(a, 'zgift').at(-1).kind, 'claymore');
});

test('4. outside the break: a wave or the end answers shut; the end screen and no game answer nothing', () => {
  const f = fixture();
  const { game, z, a, say, coins } = f;
  z.stall.coins.set('a', 5000);
  for (const phase of ['wave', 'over']) {
    z.horde.phase = phase;
    a.ws.length = 0;
    say('a', { t: 'zbuy', k: 'medkit' });
    assert.deepEqual(f.codes(a), ['zStallShut'], phase);
    assert.equal(f.lastCoins(a).c, 5000);
  }
  z.horde.phase = 'break';
  for (const state of [{ kind: 'zombies', phase: 'done', until: 0, z }, { kind: 'free' }]) {
    game.modes.state = state;
    a.ws.length = 0;
    say('a', { t: 'zbuy', k: 'claymore' });
    assert.equal(a.ws.length, 0, `${state.kind} ${state.phase ?? ''}: nothing`);
  }
  game.modes.state = { kind: 'zombies', phase: 'break', until: 0, z };
  assert.equal(coins('a'), 5000);
  assert.equal(z.loot.kit('a').claymores, 0);
  // The tick that ends the break starts the wave (the horde's own): a purchase after it is refused.
  const now = Date.now();
  z.horde.until = now - 1;
  z.tick(now, 50);
  assert.equal(z.horde.phase, 'wave');
  a.ws.length = 0;
  say('a', { t: 'zbuy', k: 'claymore' });
  assert.deepEqual(f.codes(a), ['zStallShut']);
  assert.equal(coins('a'), 5000);
  assert.equal(z.loot.kit('a').claymores, 0);
});

test('5. who: down, unarmed, in a car or not in the game buys nothing, in silence; a malformed kind changes nothing', () => {
  const f = fixture();
  const { game, z, a, say } = f;
  game.players.set('c', player(1));
  const c = game.players.get('c');
  for (const n of ['a', 'c']) z.stall.coins.set(n, 5000);
  a.hp = 40;
  const before = snap(f, 'a');
  const cases = [
    ['down', () => (a.alive = false), () => (a.alive = true)],
    ['down until the wave is beaten', () => z.down.add('a'), () => z.down.delete('a')],
    ['unarmed', () => (a.state.armed = false), () => (a.state.armed = true)],
    ['no state', () => { a.saved = a.state; a.state = undefined; }, () => (a.state = a.saved)],
    ['in a car', () => (game.inCar = (n) => n === 'a'), () => delete game.inCar],
  ];
  for (const [why, set, undo] of cases) {
    set();
    say('a', { t: 'zbuy', k: 'medkit' });
    undo();
    assert.equal(snap(f, 'a'), before, why);
    assert.equal(a.ws.length, 0, `${why}: silent`);
  }
  say('c', { t: 'zbuy', k: 'claymore' });
  assert.equal(z.stall.of('c'), 5000, 'not in z.players');
  assert.equal(c.ws.length, 0);
  for (const k of BAD) {
    assert.doesNotThrow(() => say('a', { t: 'zbuy', k }));
    assert.equal(snap(f, 'a'), before, `k ${JSON.stringify(k)}`);
  }
  say('a', { t: 'zbuy' });
  game.handle('a', a, '["zbuy","medkit"]');
  game.handle('a', a, 'null');
  assert.equal(snap(f, 'a'), before, 'no kind, an array, null');
  assert.equal(a.ws.length, 0);
  assert.equal(z.loot.kit('a').ammo.length, 0, 'never the bigger ammo pack through the stall');
});

test('6. replay, flood and race: one purchase per 300 ms; a replay pays the next price; never below 0; the cap holds', () => {
  const f = fixture();
  const { z, a, say, coins } = f;
  z.stall.coins.set('a', 1000);
  for (let i = 0; i < 10; i++) say('a', { t: 'zbuy', k: 'nades' }, true);
  assert.equal(z.loot.kit('a').nades, LOOT.nades, 'ten in one go: one purchase');
  assert.equal(coins('a'), 1000 - 120);
  a.nextBuy = 0; // 300 ms on
  say('a', { t: 'zbuy', k: 'nades' }, true);
  assert.equal(z.loot.kit('a').nades, LOOT.nadesCarry);
  assert.equal(coins('a'), 1000 - 120 - 160, 'the replay pays the higher price');
  // A refused purchase counts for the rate too.
  a.ws.length = 0;
  say('a', { t: 'zbuy', k: 'nades' });
  say('a', { t: 'zbuy', k: 'medkit' }, true);
  assert.deepEqual(f.codes(a), ['zStallFull'], 'the second, at once after a refused one: not looked at');
  // Coins for one: two purchases back to back give one, and a balance of 0 or more.
  z.stall.coins.set('a', priceOf('claymore', 0));
  say('a', { t: 'zbuy', k: 'claymore' });
  say('a', { t: 'zbuy', k: 'claymore' });
  assert.equal(z.loot.kit('a').claymores, 1);
  assert.equal(coins('a'), 0);
  assert.ok(coins('a') >= 0);
  // At the cap a kill pays nothing more.
  z.stall.coins.set('a', STALL.max);
  f.zombie(9, BIG, 1);
  f.shoot('a', 9);
  assert.equal(coins('a'), STALL.max);
});

test('7. the server\'s own effect: health on its count, a crate\'s gun that counts, a vest that soaks; told to the buyer alone', () => {
  const f = fixture();
  const { game, z, a, b, all, say, zombie, shoot } = f;
  z.stall.coins.set('a', 5000);
  a.hp = 40;
  say('a', { t: 'zbuy', k: 'medkit', hp: 1 });
  assert.equal(a.hp, 90);
  assert.equal(f.of(a, 'zgift').at(-1).hp, 90);
  a.weapons = new Set(['pistol', 'rifle', 'sniper']);
  say('a', { t: 'zbuy', k: 'gun', w: 'bazooka' });
  assert.ok(a.weapons.has('shotgun'));
  assert.ok(!a.weapons.has('bazooka'));
  a.state.w = 'shotgun';
  zombie(1, 0, 1);
  shoot('a', 1, 'shotgun');
  assert.equal(z.horde.zombies.get(1).act, 'down', 'a later shot with it counts');
  say('a', { t: 'zbuy', k: 'armor' });
  assert.equal(z.loot.kit('a').armor, LOOT.armor);
  zombie(2, 0, 100, 1);
  z.horde.tick = () => [{ type: 'swipe', name: 'a', id: 2, damage: 20 }];
  z.tick(Date.now(), 50);
  assert.equal(a.hp, 90, 'the vest took the swipe');
  assert.equal(z.loot.kit('a').armor, LOOT.armor - 20);
  // Nothing of it to b, and nothing about coins in any broadcast or in the public view.
  assert.equal(f.of(b, 'zgift').length + f.of(b, 'zcoins').length, 0);
  const keys = new Set();
  const walk = (v) => {
    if (v && typeof v === 'object') for (const [k, w] of Object.entries(v)) if (w !== undefined) keys.add(k), walk(w);
  };
  walk(all);
  walk(z.view(Date.now()));
  walk(game.modes.view?.(Date.now()));
  for (const k of ['c', 'coins', 'stall', 'bought']) assert.ok(!keys.has(k), `no ${k} in a broadcast`);
  assert.ok(!all.some((m) => m.t === 'zcoins' || m.code === 'zBonus'));
});

/** A wave begins and is beaten on the horde's own events (wave `n`), with whoever fights at each moment. */
const wave = (z, n, between = () => {}) => {
  z.horde.wave = n;
  z.horde.tick = () => [{ type: 'wave', wave: n, count: 5, big: false, bigs: 0, runners: 0 }];
  z.tick(Date.now(), 50);
  between();
  z.horde.tick = () => [{ type: 'cleared', wave: n }];
  z.tick(Date.now(), 50);
  z.horde.tick = () => [];
};

test('8. the wave bonus: full when standing, half when down, counted before revive, said after the wave line', () => {
  const f = fixture();
  const { game, z, a, b } = f;
  game.broadcast = (m) => {
    f.all.push(m);
    for (const p of game.players.values()) p.ws.push(m); // here everyone hears the wave's own lines, in order
  };
  game.players.set('c', player(1));
  const c = game.players.get('c');
  c.state.armed = false; // an onlooker
  wave(z, 3, () => {
    b.alive = false;
    z.down.add('b');
  });
  assert.equal(z.stall.of('a'), 35, 'standing: the full bonus');
  assert.equal(z.stall.of('b'), 17, 'down: half, rounded down');
  assert.equal(z.stall.of('c'), 0, 'an unarmed onlooker: nothing');
  assert.equal(z.down.size, 0, 'and then revived');
  const line = (p) => f.of(p, 'system').find((m) => m.code === 'zBonus');
  assert.deepEqual(line(a).args, { n: 35 });
  assert.deepEqual(line(b).args, { n: 17 });
  assert.equal(line(c), undefined);
  assert.equal(f.lastCoins(b).c, 17);
  const codes = f.of(a, 'system').map((m) => m.code);
  assert.ok(codes.indexOf('zCleared') >= 0 && codes.indexOf('zCleared') < codes.indexOf('zBonus'), `the bonus after "wave beaten": ${codes}`);
});

test('9. the wave bonus only for who fought in the wave: not from a car, not for arming at the last moment', () => {
  const f = fixture();
  const { game, z, a, b } = f;
  // b sits armed in a car all wave: the horde never counts them.
  game.inCar = (n) => n === 'b';
  wave(z, 2);
  assert.equal(z.stall.of('a'), 30);
  assert.equal(z.stall.of('b'), 0, 'armed in a car: no bonus');
  // b gets out, but stays unarmed as the wave begins and arms just before its last zombie falls.
  delete game.inCar;
  b.state.armed = false;
  wave(z, 3, () => (b.state.armed = true));
  assert.equal(z.stall.of('b'), 0, 'armed at the last moment: no bonus');
  assert.equal(z.stall.of('a'), 30 + 35);
  // A fighter as the wave began who sits in a car at its end: nothing either.
  wave(z, 4, () => (game.inCar = (n) => n === 'a'));
  delete game.inCar;
  assert.equal(z.stall.of('a'), 30 + 35);
  assert.equal(z.stall.of('b'), 40, 'b fought all of wave 4');
});

test('10. coins belong to a session: another one under the name starts at 0; the same one coming back keeps them', () => {
  const f = fixture();
  const { game, z, a } = f;
  // Every page is told 0 as the game begins (never the last game's coins).
  assert.deepEqual(f.started.a.filter((m) => m.t === 'zcoins'), [{ t: 'zcoins', c: 0, n: [0, 0, 0, 0, 0, 0] }]);
  assert.deepEqual(f.started.b.filter((m) => m.t === 'zcoins'), [{ t: 'zcoins', c: 0, n: [0, 0, 0, 0, 0, 0] }]);
  // A dropped connection and back within the game, the same session: coins and purchases told again.
  z.stall.coins.set('a', 400);
  f.say('a', { t: 'zbuy', k: 'claymore' });
  z.leave('a', a, Date.now());
  game.players.delete('a');
  const back = player(0); // the same key: the same session
  game.players.set('a', back);
  z.join('a', back);
  assert.deepEqual(f.of(back, 'zcoins').at(-1), { t: 'zcoins', c: 250, n: [0, 0, 1, 0, 0, 0] });
  // The name taken by another session once that one is gone: it starts at 0, and its prices at the first.
  z.leave('a', back, Date.now());
  game.players.delete('a');
  const other = player(0);
  other.key = 'someone-else';
  game.players.set('a', other);
  z.join('a', other);
  assert.deepEqual(f.of(other, 'zcoins').at(-1), { t: 'zcoins', c: 0, n: [0, 0, 0, 0, 0, 0] });
  assert.equal(z.stall.of('a'), 0);
  // A kill credited to the name while nobody holds it pays the name; a new session still starts clean.
  z.stall.coins.set('a', 0);
  game.players.delete('a');
  f.zombie(1, BIG, 1);
  z.damage(1, 12, 'a', 'turret', Date.now());
  assert.equal(z.stall.of('a'), 100);
  const third = player(0);
  third.key = 'a-third';
  game.players.set('a', third);
  z.join('a', third);
  assert.equal(z.stall.of('a'), 0);
  assert.deepEqual(f.of(third, 'zcoins').at(-1), { t: 'zcoins', c: 0, n: [0, 0, 0, 0, 0, 0] });
  // Someone new hears 0 on joining.
  const d = player(2);
  game.players.set('d', d);
  z.join('d', d);
  assert.deepEqual(f.of(d, 'zcoins'), [{ t: 'zcoins', c: 0, n: [0, 0, 0, 0, 0, 0] }]);
});
