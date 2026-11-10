import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanPick, LOADOUT, startingWeapons } from '../shared/loadout.mjs';
import { Game } from './game.mjs';

// The guns a player chooses to start with (shared/loadout.mjs). The server takes only the known guns, each
// once, two at most; hands them out when the player comes into play, or at once while they haven't fired;
// and never in the Zombies game, where everyone has the pistol only. Each forged message must come out harmless.

function setup() {
  const game = new Game({ session: () => null, store: { addStats: async () => {} } }, []);
  const sent = [];
  game.broadcast = () => {};
  game.send = (ws, m) => sent.push({ to: ws.name, ...m });
  game.stampState = () => {};
  const player = (name, role = 'player') => {
    const now = Date.now();
    const p = {
      ws: { name }, key: `k-${name}`, role, alive: true, protectedUntil: 0, drop: null, warp: 0, stamp: 0, unfired: true, cameAt: now,
      state: { x: 5, y: 0, z: 5, yaw: 0, pitch: 0, armed: true, flying: false, w: 'pistol', c: false },
      weapons: new Set(['pistol']), nades: [0, 0], window: now, msgs: 0, states: 0, others: 0, budget: 0.5, vbudget: 0.5, movedAt: now,
      hp: 100, score: { kills: 0, deaths: 0, points: 0 }, thrown: [],
    };
    game.players.set(name, p);
    return p;
  };
  /** A choice from `p`, with the wait for the next one let go; returns the server's answer to them. */
  const choose = (name, p, w) => {
    p.nextLoadout = 0;
    sent.length = 0;
    game.handle(name, p, JSON.stringify({ t: 'loadout', w }));
    return sent.find((m) => m.t === 'weapons');
  };
  return { game, sent, player, choose };
}

test('a choice is cleaned: known guns only, each once, two at most', () => {
  assert.deepEqual(cleanPick(['sniper', 'rifle']), ['sniper', 'rifle']);
  assert.deepEqual(cleanPick(['rifle', 'rifle', 'shotgun', 'sniper']), ['rifle', 'shotgun']);
  assert.deepEqual(cleanPick(['bazooka', 'pistol', 'grenade', 'shotgun']), ['shotgun']);
  assert.deepEqual(cleanPick('rifle'), []);
  assert.deepEqual(cleanPick([{ w: 'rifle' }, 7, null, ['sniper']]), []);
  assert.deepEqual(cleanPick(Array(10000).fill('sniper')), ['sniper']);
  assert.deepEqual(startingWeapons(['sniper'], ['bazooka']), ['pistol', 'bazooka', 'sniper']);
  assert.deepEqual(startingWeapons(['sniper', 'rifle'], ['bazooka'], true), ['pistol'], 'the Zombies game: the pistol only');
  assert.ok(LOADOUT.most <= LOADOUT.choices.length);
});

test('a player who has not fired gets the chosen guns at once, and is told', () => {
  const { player, choose } = setup();
  const anna = player('anna');
  const answer = choose('anna', anna, ['sniper', 'shotgun']);
  assert.deepEqual([...anna.weapons], ['pistol', 'sniper', 'shotgun']);
  assert.deepEqual(answer.list, ['pistol', 'sniper', 'shotgun']);
  assert.equal(answer.to, 'anna');
});

test('a forged choice gives no gun that can\'t be chosen, and never more than two', () => {
  const { player, choose } = setup();
  const anna = player('anna');
  for (const w of [['bazooka'], ['bazooka', 'rifle', 'shotgun', 'sniper'], 'sniper', { 0: 'bazooka', length: 1 }, [['bazooka']], null]) {
    choose('anna', anna, w);
    assert.equal(anna.weapons.has('bazooka'), false, JSON.stringify(w));
    assert.ok(anna.weapons.size <= 1 + LOADOUT.most, JSON.stringify(w));
  }
});

test('once fired the choice waits for the next time they come into play', () => {
  const { game, player, choose } = setup();
  const anna = player('anna');
  choose('anna', anna, ['rifle']);
  anna.nextShot = 0;
  game.handle('anna', anna, JSON.stringify({ t: 'shot', w: 'rifle', x: 5, y: 1.5, z: 5 }));
  assert.equal(anna.unfired, false);
  const answer = choose('anna', anna, ['sniper', 'shotgun']);
  assert.deepEqual([...anna.weapons], ['pistol', 'rifle'], 'no swap in the middle of a fight');
  assert.deepEqual(answer.list, ['pistol', 'rifle']);
  assert.deepEqual(anna.pick, ['sniper', 'shotgun']);
  game.respawn('anna', anna, Date.now());
  assert.deepEqual([...anna.weapons], ['pistol', 'sniper', 'shotgun']);
  assert.equal(anna.unfired, true);
});

test('a hit, a throw or half a minute end the swap as a shot does: a page that leaves its shots unsaid gains nothing', () => {
  const { game, player, choose } = setup();
  const anna = player('anna');
  const bert = player('bert');
  choose('anna', anna, ['rifle']);
  anna.state.w = 'rifle';
  // A hit claimed without any 'shot' before it.
  game.handle('anna', anna, JSON.stringify({ t: 'hit', target: 'bert', w: 'rifle', body: 1, head: 0 }));
  assert.ok(bert.hp < 100, 'the hit counted');
  assert.equal(anna.unfired, false);
  choose('anna', anna, ['sniper', 'shotgun']);
  assert.deepEqual([...anna.weapons], ['pistol', 'rifle']);
  // A throw.
  const cara = player('cara');
  game.handle('cara', cara, JSON.stringify({ t: 'nade', x: 5, y: 1.5, z: 5, vx: 1, vy: 1, vz: 1 }));
  assert.equal(cara.unfired, false);
  // Standing about for more than half a minute.
  const dirk = player('dirk');
  dirk.cameAt = Date.now() - 31000;
  choose('dirk', dirk, ['sniper']);
  assert.deepEqual([...dirk.weapons], ['pistol']);
  assert.deepEqual(dirk.pick, ['sniper'], 'kept for the next time they come into play');
});

test('when the Zombies game is over everyone has their chosen guns again, and is told', () => {
  const { game, sent, player, choose } = setup();
  const anna = player('anna');
  choose('anna', anna, ['sniper', 'shotgun']);
  game.pistolsOnly();
  assert.deepEqual([...anna.weapons], ['pistol']);
  anna.unfired = false;
  sent.length = 0;
  game.gunsBack();
  assert.deepEqual([...anna.weapons], ['pistol', 'sniper', 'shotgun']);
  assert.equal(anna.unfired, true);
  assert.deepEqual(sent.find((m) => m.t === 'weapons' && m.to === 'anna').list, ['pistol', 'sniper', 'shotgun']);
});

test('twice a second at most', () => {
  const { game, sent, player } = setup();
  const anna = player('anna');
  for (let i = 0; i < 30; i++) game.handle('anna', anna, JSON.stringify({ t: 'loadout', w: ['rifle'] }));
  assert.equal(sent.filter((m) => m.t === 'weapons').length, 1);
});

test('the Zombies game: everyone down to the pistol, the admin too, and a choice changes nothing', () => {
  const { game, player, choose } = setup();
  const anna = player('anna');
  const boss = player('boss', 'admin');
  choose('anna', anna, ['rifle', 'sniper']);
  boss.weapons = new Set(['pistol', 'bazooka', 'rifle']);
  boss.state.w = 'bazooka';
  game.modes.state = { kind: 'zombies', phase: 'playing', z: { stop() {} } };
  game.pistolsOnly();
  assert.deepEqual([...anna.weapons], ['pistol']);
  assert.deepEqual([...boss.weapons], ['pistol']);
  assert.equal(boss.state.w, 'pistol');
  const answer = choose('anna', anna, ['shotgun']);
  assert.deepEqual([...anna.weapons], ['pistol']);
  assert.deepEqual(answer.list, ['pistol']);
});
