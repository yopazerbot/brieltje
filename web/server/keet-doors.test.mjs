import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';
import { homeOfDoor } from '../shared/homes.mjs';
import { arenaOf, portalOf } from '../shared/arenas.mjs';

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

test('during a Zombies game at the church the café\'s doors are shut for everyone, and open again after it', () => {
  const { game, player, door, send } = setup();
  const admin = player('root', 548, -760, 'admin');
  const guest = player('guest', 545, -755);
  door('guest', guest, 'keet-front');
  door('guest', guest, 'keet-back');
  assert.equal(game.doors['keet-front'], true);
  guest.got.length = 0;
  game.modes.start('zombies', 'root', 'church');
  assert.equal(game.modes.state.kind, 'zombies');
  assert.ok(game.keetClosed());
  const shut = guest.got.filter((m) => m.t === 'door' && m.id.startsWith('keet-'));
  assert.equal(shut.length, 8, 'every page is told every café door shuts');
  assert.ok(shut.every((m) => m.open === false));
  assert.equal(game.doors['keet-front'], false);
  door('guest', guest, 'keet-front');
  door('root', admin, 'keet-back');
  assert.equal(game.doors['keet-front'], false, 'ignored while the game runs');
  assert.equal(game.doors['keet-back'], false);
  send('root', admin, { t: 'mode', kind: 'free' }); // the admin stops it
  assert.equal(game.modes.state.kind, 'free');
  door('guest', guest, 'keet-front');
  assert.equal(game.doors['keet-front'], true, 'after the game the café opens again');
});

test('a Zombies game somewhere else leaves the café as it is', () => {
  const { game, player, door } = setup();
  player('root', 0, 30, 'admin');
  const guest = player('guest', 540, -716);
  door('guest', guest, 'keet-front');
  game.modes.start('zombies', 'root', 'house');
  assert.equal(game.keetClosed(), false);
  assert.equal(game.doors['keet-front'], true);
  game.modes.start('free', 'root');
});

test('coming back during Zombies at the church to a spot inside the shut café: they start where the place lets you out', () => {
  const { game, player } = setup();
  game.auth = { session: () => null, log: () => {}, addressOf: () => '127.0.0.1' };
  const ws = () => ({ readyState: 1, OPEN: 1, send() {}, on() {}, close() {} });
  player('root', 548, -760, 'admin').score = { kills: 0, deaths: 0, points: 0 }; // as join gives one (the welcome lists it)
  game.modes.start('zombies', 'root', 'church');
  assert.ok(game.keetClosed());
  const inside = { x: 541.3, y: 6.071, z: -720 }; // the front room
  game.lastPos.set('back', inside);
  game.join(ws(), { username: 'back', role: 'guest', key: 'k-back' }, { headers: {}, socket: {} });
  const [x, z] = portalOf(arenaOf('church')).out;
  const s = game.players.get('back').state;
  assert.deepEqual([s.x, s.z], [x, z], 'not in the café: at the church place\'s start');
  assert.deepEqual([game.keetOut(inside).x, game.keetOut(inside).z], [x, z]);
  assert.equal(game.keetOut({ x: 545, y: 6, z: -740 }).z, -740);
  // Outside the café the last position holds; after the game the café is a place like any other.
  game.lastPos.set('near', { x: 545, y: 6, z: -740 });
  game.join(ws(), { username: 'near', role: 'guest', key: 'k-near' }, { headers: {}, socket: {} });
  assert.deepEqual([game.players.get('near').state.x, game.players.get('near').state.z], [545, -740]);
  game.modes.start('free', 'root');
  game.lastPos.set('later', inside);
  game.join(ws(), { username: 'later', role: 'guest', key: 'k-later' }, { headers: {}, socket: {} });
  assert.deepEqual([game.players.get('later').state.x, game.players.get('later').state.z], [inside.x, inside.z]);
});
