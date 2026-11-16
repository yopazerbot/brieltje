import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';
import { homeOfDoor } from '../shared/homes.mjs';

// The café at the church on the game server: public doors and panes, apart from the code-locked homes' (shared/keet.mjs).
function setup() {
  const game = new Game({ session: () => null }, []);
  const grants = new Set();
  game.homes = { granted: (key, id) => grants.has(`${key}|${id}`) };
  const player = (name, x, z, role = 'guest') => {
    const p = {
      key: `k-${name}`, role, got: [], ws: { readyState: 1, OPEN: 1, send(d) { p.got.push(JSON.parse(d)); } }, alive: true, state: { x, y: 6.2, z, yaw: 0, pitch: 0, armed: false, flying: false, w: 'pistol', c: false },
      budget: 100, vbudget: 100, movedAt: Date.now(), warp: 0, stamp: 0, weapons: new Set(['pistol']), nades: [], window: Date.now(), msgs: 0, states: 0, others: 0,
    };
    game.players.set(name, p);
    return p;
  };
  const send = (name, p, m) => game.handle(name, p, JSON.stringify(m));
  const door = (name, p, id, open = true) => {
    p.nextDoor = 0;
    send(name, p, { t: 'door', id, open, dir: 1 });
  };
  return { game, player, send, door };
}

test('a guest with no grant opens the café\'s doors, and every other page is told', () => {
  const { game, player, door } = setup();
  const guest = player('guest', 540, -716);
  const other = player('other', 545, -740, 'player');
  const ids = ['keet-front', 'keet-mid', 'keet-gate', 'keet-corridor', 'keet-back', 'keet-toilets', 'keet-toilet1', 'keet-toilet2'];
  for (const id of ids) {
    assert.equal(homeOfDoor(id), null, id);
    door('guest', guest, id);
  }
  assert.deepEqual(other.got.filter((m) => m.t === 'door').map((m) => m.id), ids);
  assert.ok(other.got.every((m) => m.open === true && m.by === 'guest'));
  assert.deepEqual(Object.keys(game.doorsFor(other)).sort(), [...ids].sort(), 'a page that joins later is told their states');
  door('guest', guest, 'keet-front', false);
  assert.equal(game.doors['keet-front'], false);
});

test('the same guest still cannot open a home\'s door: nothing changes, nobody is told', () => {
  const { game, player, door } = setup();
  const guest = player('guest', 540, -716);
  const other = player('other', 545, -740, 'player');
  for (const id of ['kh-home-front', 'mh-end-front', 'house-out-1']) door('guest', guest, id);
  assert.deepEqual(other.got, []);
  assert.deepEqual(Object.keys(game.doors), []);
  door('guest', guest, 'keet-nosuch');
  door('guest', guest, 'keet-front-x');
  assert.deepEqual(other.got, [], 'a café-like id that is no café door is ignored');
  assert.deepEqual(Object.keys(game.doors), []);
});

test('a guest breaks a café window and everyone is told; a home\'s pane and a number past the café\'s are refused', () => {
  const { game, player, send } = setup();
  const guest = player('guest', 540, -716);
  const other = player('other', 545, -740, 'player');
  send('guest', guest, { t: 'glass', i: 8000 });
  assert.ok(game.broken.has(8000));
  assert.deepEqual(other.got.filter((m) => m.t === 'glass').map((m) => m.i), [8000]);
  for (const i of [6000, 7000, 8004, 8500, 8999, 9000]) send('guest', guest, { t: 'glass', i });
  assert.deepEqual([...game.broken], [8000], 'only the café\'s own panes');
  guest.state.armed = true; // a crack comes from a player who can fire
  send('guest', guest, { t: 'crack', i: 8003, x: 545, y: 7, z: -715 });
  assert.ok(game.cracked.has(8003));
});

test('during a Zombies game at the church the café\'s doors work as ever: nothing shuts at the start, everyone is told', () => {
  const { game, player, door } = setup();
  player('root', 548, -760, 'admin');
  const guest = player('guest', 545, -755);
  const other = player('other', 545, -740, 'player');
  door('guest', guest, 'keet-front');
  assert.equal(game.doors['keet-front'], true);
  other.got.length = 0;
  game.modes.start('zombies', 'root', 'church');
  assert.equal(game.modes.state.kind, 'zombies');
  assert.ok(!other.got.some((m) => m.t === 'door'), 'no café door shuts as the game starts');
  assert.equal(game.doors['keet-front'], true);
  door('guest', guest, 'keet-back');
  door('guest', guest, 'keet-front', false);
  assert.equal(game.doors['keet-back'], true);
  assert.equal(game.doors['keet-front'], false);
  assert.deepEqual(other.got.filter((m) => m.t === 'door').map((m) => [m.id, m.open, m.by]), [['keet-back', true, 'guest'], ['keet-front', false, 'guest']]);
  // Five a second at most, as for every door: a page slamming a café door shut to trap the zombies is held to it.
  guest.nextDoor = 0;
  for (let i = 0; i < 50; i++) send(game, guest, i);
  assert.equal(other.got.filter((m) => m.t === 'door').length - 2, 1, 'fifty door messages at once: one taken');
  game.modes.start('free', 'root');
});

/** A page's door message for the café's front door, open or shut by turns (`i`), straight to the server. */
function send(game, p, i) {
  game.handle('guest', p, JSON.stringify({ t: 'door', id: 'keet-front', open: i % 2 === 0, dir: 1 }));
}

test('coming back during Zombies at the church to a spot inside the café: they come back there, inside the place\'s edge', () => {
  const { game, player } = setup();
  game.auth = { session: () => null, log: () => {}, addressOf: () => '127.0.0.1' };
  const ws = () => ({ readyState: 1, OPEN: 1, send() {}, on() {}, close() {} });
  player('root', 548, -760, 'admin').score = { kills: 0, deaths: 0, points: 0 }; // as join gives one (the welcome lists it)
  game.modes.start('zombies', 'root', 'church');
  for (const [name, at] of [['front', { x: 541.3, y: 6.071, z: -720 }], ['toilet', { x: 536.74, y: 6.071, z: -709.25 }]]) {
    game.lastPos.set(name, at);
    game.join(ws(), { username: name, role: 'guest', key: `k-${name}` }, { headers: {}, socket: {} });
    const s = game.players.get(name).state;
    assert.deepEqual([s.x, s.z], [at.x, at.z], name);
  }
  // Past the back street, out of the place: at its start as before.
  game.lastPos.set('far', { x: 537, y: 6.5, z: -690 });
  game.join(ws(), { username: 'far', role: 'guest', key: 'k-far' }, { headers: {}, socket: {} });
  const far = game.players.get('far').state;
  assert.ok(far.z !== -690, 'outside the edge: not where they were');
  game.modes.start('free', 'root');
});
