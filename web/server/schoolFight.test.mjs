import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';
import { NO_SHOOT, noShoot } from '../shared/zones.mjs';
import { VKIND } from '../shared/villagers.mjs';

// The school grounds in a team match (Yoshi, 17 Nov 2026: "School zone ok to shoot in team v team"): while the teams
// game or Steal the flag is played (modes.teamMatch) the grounds no longer stop a fight between players (Game.fightCalm:
// a hit, a shot, a grenade, a rocket, a blast). Outside a team match everything is as before. The villagers, the cats,
// the strongmen and the zombies keep the raw zone (Game.calm): nobody hurts them there, nor is hurt by them, ever.

/** The middle of the school grounds, and a point 30 m north of them (outside). */
const SCHOOL = NO_SHOOT[0].poly.reduce(([ax, az], [px, pz], i, all) => [ax + px / all.length, az + pz / all.length], [0, 0]);
const OUTSIDE = [SCHOOL[0], SCHOOL[1] + 50];

function setup() {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const store = { addStats: async () => {}, setMeta: async () => {}, getMeta: async () => null };
  const game = new Game({ session: () => null, store, log: () => {} }, [], null);
  for (const t of game.timers) clearInterval(t);
  game.auth = { ...game.auth, store, session: () => null, log: () => {}, addressOf: () => '127.0.0.1' };
  const out = [];
  game.broadcast = (m) => out.push(structuredClone(m));
  game.broadcastThing = (m) => out.push(structuredClone(m));
  game.broadcastFrom = (m) => out.push(structuredClone(m));
  game.broadcastEvent = (m) => out.push(structuredClone(m));
  game.send = () => {};
  game.stampState = () => {};
  const join = (name) => {
    const ws = { name, readyState: 1, OPEN: 1, send() {}, on: () => {}, close: () => {} };
    game.join(ws, { username: name, role: 'player', key: `k-${name}` }, { headers: {}, socket: {} });
    return game.players.get(name);
  };
  for (const n of ['ann', 'bob', 'cid', 'dee']) join(n);
  /** Two foes (`a` and `b`), out of protection, armed, on foot at `pa` and `pb`, the rifle in hand. */
  const foes = (pa, pb) => {
    const t = game.modes.state.teams;
    const a = t ? Object.keys(t).find((n) => t[n] === Object.values(t)[0]) : 'ann';
    const b = t ? Object.keys(t).find((n) => t[n] !== t[a]) : 'bob';
    for (const [n, [x, z]] of [[a, pa], [b, pb]]) {
      const p = game.players.get(n);
      Object.assign(p, { alive: true, hp: game.fullHealth, protectedUntil: 0, nextHit: 0, nextShot: 0, nextRocket: 0, drop: null });
      Object.assign(p.state, { x, z, y: 5, armed: true, w: 'rifle', flying: false, chute: false });
      p.weapons.add('rifle');
    }
    return [a, game.players.get(a), b, game.players.get(b)];
  };
  return { game, out, foes, at: (ms) => (clock += ms), now: () => clock };
}

/** Whether a hit of `a`'s on `b` takes health, and whether `a`'s shot reaches every page, and `a`'s grenade is thrown. */
function fight(s, pa, pb) {
  const [a, A, b, B] = s.foes(pa, pb);
  const hp = B.hp;
  s.game.hit(a, A, b, 'rifle', 1, 0, s.now());
  const hit = B.hp < hp;
  s.at(1000);
  const shots = s.out.filter((m) => m.t === 'shot').length;
  A.window = s.now();
  A.msgs = 0;
  s.game.handle(a, A, JSON.stringify({ t: 'shot', w: 'rifle', x: A.state.x, y: A.state.y + 1.5, z: A.state.z }));
  const shot = s.out.filter((m) => m.t === 'shot').length > shots;
  const thrown = A.thrown.length;
  s.game.throwNade(a, A, { x: A.state.x, y: A.state.y + 1.5, z: A.state.z, vx: 2, vy: 2, vz: 0 }, s.now());
  const nade = A.thrown.length > thrown;
  // A blast of a's at b's feet (as a rocket's or grenade's at the end of its flight).
  s.at(1000);
  Object.assign(B, { hp: s.game.fullHealth, protectedUntil: 0 });
  s.game.blast(a, { x: B.state.x, y: B.state.y + 0.9, z: B.state.z }, 'grenade');
  const blast = B.hp < s.game.fullHealth;
  return { hit, shot, nade, blast };
}

test('in a team match the school grounds are open: a hit, a shot, a grenade and a blast count, on them and from them', () => {
  for (const kind of ['flag', 'teams']) {
    for (const [pa, pb, what] of [[OUTSIDE, SCHOOL, 'at a player on them'], [SCHOOL, OUTSIDE, 'from a player on them'], [SCHOOL, [SCHOOL[0] + 3, SCHOOL[1]], 'both on them']]) {
      const s = setup();
      s.game.modes.start(kind, 'admin', 'compact');
      assert.equal(s.game.modes.teamMatch, true);
      assert.ok(noShoot(...SCHOOL));
      assert.deepEqual(fight(s, pa, pb), { hit: true, shot: true, nade: true, blast: true }, `${kind}, ${what}`);
    }
  }
});

test('outside a team match the school grounds stay free of shooting, as before', () => {
  for (const kind of [null, 'tag', 'zombies']) {
    for (const [pa, pb, what] of [[OUTSIDE, SCHOOL, 'at a player on them'], [SCHOOL, OUTSIDE, 'from a player on them']]) {
      const s = setup();
      if (kind) s.game.modes.start(kind, 'admin', 'house');
      assert.equal(s.game.modes.teamMatch, false);
      const r = fight(s, pa, pb);
      assert.equal(r.hit, false, `${kind ?? 'free play'}, ${what}: no hit`);
      if (pb === SCHOOL) assert.equal(r.blast, false, `${kind ?? 'free play'}, ${what}: no blast`);
      if (pa === SCHOOL) assert.deepEqual([r.shot, r.nade], [false, false], `${kind ?? 'free play'}: no shot, no grenade from them`);
    }
  }
  // Once the team match is over (its result showing), as before again.
  const s = setup();
  s.game.modes.start('flag', 'admin', 'compact');
  s.game.modes.finish('over', 'flagDraw', { blue: 0, red: 0, a: 0, b: 0 });
  assert.equal(s.game.modes.teamMatch, false);
  assert.equal(fight(s, OUTSIDE, SCHOOL).hit, false);
});

test('the villagers, the cats, the strongmen and the zombies keep the school grounds, in a team match too', () => {
  const s = setup();
  s.game.modes.start('flag', 'admin', 'compact');
  const [a, A] = s.foes(SCHOOL, OUTSIDE);
  // No villager felled from the grounds (any kind, any number), whatever the page says.
  s.game.villagersHit(a, A, { ids: [0, 1, 2, 3, 4, 5] }, s.now());
  assert.equal(s.game.vilDown.size + s.game.vilPaint.size, 0, 'no villager from the school grounds');
  assert.ok(VKIND.child >= 0);
  // No cat from them.
  s.at(1000);
  Object.assign(A, { window: s.now(), msgs: 0, nextCat: 0 });
  s.game.handle(a, A, JSON.stringify({ t: 'cat', i: 0, w: 'rifle' }));
  assert.equal(s.out.filter((m) => m.t === 'cat').length, 0, 'no cat from the school grounds');
  // A strongman's rock or a zombie's swipe does nobody on them any harm (Game.npcDamage keeps the raw zone).
  const hp = A.hp;
  s.game.npcDamage(a, A, 30, s.now(), 'a strongman');
  s.game.npcDamage(a, A, 30, s.now(), 'a zombie');
  assert.equal(A.hp, hp, 'the strongmen and the zombies: as before');
  assert.equal(s.game.calm(A), true, 'the raw zone still says so');
  assert.equal(s.game.fightCalm(A), false, 'only the fight between players is open');
});

test('a drop still protects on the school grounds in a team match', () => {
  const s = setup();
  s.game.modes.start('flag', 'admin', 'compact');
  const [a, A, b, B] = s.foes(OUTSIDE, SCHOOL);
  s.game.startDrop(B, s.now());
  const hp = B.hp;
  B.protectedUntil = 0;
  s.game.hit(a, A, b, 'rifle', 1, 0, s.now());
  assert.equal(B.hp, hp);
});
