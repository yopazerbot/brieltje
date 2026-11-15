import assert from 'node:assert/strict';
import test from 'node:test';
import { startingWeapons } from '../shared/loadout.mjs';
import { Game } from './game.mjs';

// The guns a player starts with (shared/loadout.mjs), by the server's own rule: outside the Zombies game every
// player holds the pistol, the rifle, the shotgun and the sniper rifle (the admin the bazooka too); in the Zombies
// game the pistol only, and the rest is found. No message from a page changes that: an old page's 'loadout' least of all.

const ALL = ['pistol', 'rifle', 'shotgun', 'sniper'];
const sorted = (set) => [...set].sort();

/** Each test's game: its ticks stop when the test ends (a fixture's stand-in pages and Zombies game can't tick). */
const games = [];
test.afterEach(() => {
  for (const g of games.splice(0)) for (const t of g.timers) clearInterval(t);
});

function setup() {
  const game = new Game({ session: () => null, store: { addStats: async () => {} } }, []);
  games.push(game);
  const sent = [];
  game.broadcast = () => {};
  game.send = (ws, m) => sent.push({ to: ws.name, ...m });
  game.stampState = () => {};
  game.stats = () => {};
  const player = (name, role = 'player') => {
    const now = Date.now();
    const p = {
      ws: { name }, key: `k-${name}`, role, alive: true, protectedUntil: 0, drop: null, warp: 0, stamp: 0,
      state: { x: 5, y: 0, z: 5, yaw: 0, pitch: 0, armed: true, flying: false, w: 'pistol', c: false },
      weapons: new Set(startingWeapons(role === 'admin' ? ['bazooka'] : [])), nades: [0, 0], window: now, msgs: 0, states: 0, others: 0, budget: 0.5, vbudget: 0.5, movedAt: now,
      hp: 100, score: { kills: 0, deaths: 0, points: 0 }, thrown: [],
    };
    game.players.set(name, p);
    return p;
  };
  /** An old page's choice of guns, as the socket hands it to the server. */
  const loadout = (name, p, w) => game.handle(name, p, JSON.stringify({ t: 'loadout', w }));
  return { game, sent, player, loadout };
}

test('the rule: all four outside Zombies, the admin\'s on top; the pistol only in Zombies', () => {
  assert.deepEqual(startingWeapons(), ALL);
  assert.deepEqual(startingWeapons(['bazooka']), [...ALL, 'bazooka']);
  assert.deepEqual(startingWeapons([], true), ['pistol'], 'the Zombies game: the pistol only');
  assert.deepEqual(startingWeapons(['bazooka'], true), ['pistol'], 'the admin too');
});

test('every player respawns with all four, the admin with the bazooka too, whatever they picked up or lost', () => {
  const { game, player } = setup();
  const anna = player('anna');
  const boss = player('boss', 'admin');
  anna.weapons = new Set(['pistol']);
  game.respawn('anna', anna, Date.now());
  assert.deepEqual(sorted(anna.weapons), [...ALL].sort());
  game.respawn('boss', boss, Date.now());
  assert.deepEqual(sorted(boss.weapons), [...ALL, 'bazooka'].sort());
});

test('a hit with each of the four counts outside Zombies; the bazooka is still the admin\'s', () => {
  const { game, player } = setup();
  const anna = player('anna');
  const bert = player('bert');
  for (const w of ALL) {
    bert.hp = 100;
    bert.alive = true;
    bert.protectedUntil = 0;
    anna.nextHit = 0;
    anna.state.w = w;
    game.handle('anna', anna, JSON.stringify({ t: 'hit', target: 'bert', w, body: 1, head: 0 }));
    assert.ok(bert.hp < 100, `${w}: the hit counted`);
  }
  assert.equal(anna.weapons.has('bazooka'), false);
});

test('an old page\'s \'loadout\' changes nothing and is not answered, outside Zombies and in it', () => {
  const { game, sent, player, loadout } = setup();
  const anna = player('anna');
  for (const w of [['rifle'], ['bazooka'], ['bazooka', 'rifle', 'shotgun', 'sniper'], 'sniper', { 0: 'bazooka', length: 1 }, [['bazooka']], null, Array(10000).fill('sniper')]) {
    loadout('anna', anna, w);
    anna.window = 0; // a new second: the flood guard is not what keeps it out
    assert.deepEqual(sorted(anna.weapons), [...ALL].sort(), JSON.stringify(w).slice(0, 60));
  }
  assert.equal(sent.length, 0, 'no answer');
  assert.equal('pick' in anna, false, 'nothing kept');
  // In the Zombies game: still the pistol only.
  game.modes.state = { kind: 'zombies', phase: 'playing', z: { stop() {} } };
  game.pistolsOnly();
  loadout('anna', anna, ['rifle', 'sniper']);
  assert.deepEqual(sorted(anna.weapons), ['pistol']);
  assert.equal(sent.length, 0);
});

test('thirty old \'loadout\' messages in a second cost the others\' budget only, as any message would', () => {
  const { sent, player, loadout } = setup();
  const anna = player('anna');
  for (let i = 0; i < 30; i++) loadout('anna', anna, ['rifle']);
  assert.equal(sent.length, 0);
  assert.equal(anna.others, 30);
  assert.deepEqual(sorted(anna.weapons), [...ALL].sort());
});

test('the Zombies game: everyone down to the pistol, the admin too; a hit with a gun not found does not count; after it all four again, and told', () => {
  const { game, sent, player } = setup();
  const anna = player('anna');
  const bert = player('bert');
  const boss = player('boss', 'admin');
  boss.state.w = 'bazooka';
  game.modes.state = { kind: 'zombies', phase: 'playing', z: { stop() {} } };
  game.pistolsOnly();
  assert.deepEqual([...anna.weapons], ['pistol']);
  assert.deepEqual([...boss.weapons], ['pistol']);
  assert.equal(boss.state.w, 'pistol');
  // A respawn in the Zombies game: still the pistol only.
  game.respawn('anna', anna, Date.now());
  assert.deepEqual([...anna.weapons], ['pistol']);
  // The game ends: until the server hands the guns back, a hit claimed with the rifle is dropped (the gun not held).
  game.modes.state = { kind: 'free' };
  const rifleHit = () => {
    anna.state.w = 'rifle';
    anna.nextHit = 0;
    bert.protectedUntil = 0;
    game.handle('anna', anna, JSON.stringify({ t: 'hit', target: 'bert', w: 'rifle', body: 1, head: 0 }));
  };
  rifleHit();
  assert.equal(bert.hp, 100, 'no rifle held: no hit');
  sent.length = 0;
  game.gunsBack();
  assert.deepEqual(sorted(anna.weapons), [...ALL].sort());
  assert.deepEqual(sorted(boss.weapons), [...ALL, 'bazooka'].sort());
  const told = sent.find((m) => m.t === 'weapons' && m.to === 'anna');
  assert.deepEqual([...told.list].sort(), [...ALL].sort());
  assert.equal('pick' in told, false);
  rifleHit();
  assert.ok(bert.hp < 100, 'all four held again: the hit counts');
});

test('a page joining is told its guns by the server: all four (in a Zombies game the pistol only: zombie-loot.test.mjs)', () => {
  const { game, sent } = setup();
  game.send = (ws, m) => sent.push(m);
  game.auth = { session: () => null, log: () => {}, addressOf: () => '127.0.0.1' };
  const join = (name) => {
    const ws = { readyState: 1, OPEN: 1, send() {}, on() {}, close() {} };
    game.join(ws, { username: name, role: 'player', key: `k-${name}` }, { headers: {}, socket: {} });
    return sent.filter((m) => m.t === 'weapons').at(-1);
  };
  assert.deepEqual([...join('anna').list].sort(), [...ALL].sort());
  assert.deepEqual([...game.players.get('anna').weapons].sort(), [...ALL].sort(), 'what it is told is what the server holds');
});

test('a rocket from anyone but the admin is dropped, with all four guns in hand or in Zombies; the admin\'s flies', () => {
  const { game, player } = setup();
  const rockets = [];
  game.broadcast = (m) => m.t === 'rocket' && rockets.push(m.name);
  const anna = player('anna');
  const boss = player('boss', 'admin');
  const fire = (name, p) => {
    p.state.w = 'bazooka'; // a page claiming it holds one
    p.nextRocket = 0;
    game.handle(name, p, JSON.stringify({ t: 'rocket', tx: 20, ty: 1, tz: 20 }));
  };
  fire('anna', anna);
  assert.deepEqual(rockets, [], 'all four guns, no bazooka: dropped');
  fire('boss', boss);
  assert.deepEqual(rockets, ['boss'], 'the admin\'s bazooka: it flies (the check is real)');
  game.modes.state = { kind: 'zombies', phase: 'playing', z: { stop() {}, blast() {} } };
  game.pistolsOnly();
  fire('anna', anna);
  fire('boss', boss);
  assert.deepEqual(rockets, ['boss'], 'in Zombies nobody holds one, the admin neither');
});
