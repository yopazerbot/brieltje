// Back up in a Zombies room (server/rooms.mjs): whoever is down when a game ends, or after any fall there, comes back
// at the room's place, on the ground, never by parachute at the main house (Yoshi, 7 Nov 2026: no parachute in Zombies).
// Run: node --test server/room-respawn.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { arenaOf, portalOf } from '../shared/arenas.mjs';
import { Game } from './game.mjs';
import { Rooms } from './rooms.mjs';

function fakeAuth() {
  return {
    logged: [], sessions: new Map(),
    log() {},
    addressOf: () => '192.0.2.1',
    store: { saveZombieRun: async () => true, addStats: async () => {}, setMeta: async () => {} },
  };
}

const sent = [];
const down = (name) => ({
  key: `k-${name}`, role: 'player', ws: { readyState: 1, OPEN: 1, send: (m) => sent.push([name, JSON.parse(m)]), close() {} },
  state: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, armed: true, flying: false, w: 'pistol', c: false },
  alive: false, hp: 0, respawnAt: 0, protectedUntil: 0, nades: [0, 0], score: { kills: 0, deaths: 0, points: 0 },
});

test('in a room, the fallen come back at its place on the ground, the parachute rule on or not', () => {
  const auth = fakeAuth();
  const main = new Game(auth);
  const made = [];
  const rooms = new Rooms(main, (room) => {
    const g = new Game(auth, undefined, room);
    made.push(g);
    return g;
  });
  try {
    main.rules.parachute = true;
    const { id } = rooms.create({ username: 'anna', role: 'player' }, 'church').room;
    const g = rooms.rooms.get(id).game;
    assert.equal(g.rules.parachute, true, "the open world's rule reaches the room");
    const p = down('anna');
    g.players.set('anna', p);
    sent.length = 0;
    g.tick();
    assert.equal(p.alive, true, 'up again');
    assert.equal(p.drop ?? null, null, 'no drop');
    const out = portalOf(arenaOf('church')).out;
    assert.ok(Math.hypot(p.state.x - out[0], p.state.z - out[1]) < 12, `at the church, not ${p.state.x}, ${p.state.z}`);
    const msg = sent.find(([, m]) => m.t === 'respawn')?.[1];
    assert.ok(msg, 'the page is told');
    assert.equal(msg.drop, undefined, 'and not told to drop');
    // The open world is unchanged: a fall there still comes back by parachute when the rule is on.
    const q = down('bert');
    main.players.set('bert', q);
    sent.length = 0;
    main.tick();
    assert.equal(q.alive, true);
    assert.equal(sent.find(([, m]) => m.t === 'respawn')?.[1].drop, 1, 'free play keeps its drop');
  } finally {
    for (const g of [main, ...made]) g.close();
  }
});
