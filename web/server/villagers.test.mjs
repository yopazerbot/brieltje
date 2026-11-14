// The villagers on the shared clock (shared/villagers.mjs) and who the server lets a player hit (server/game.mjs,
// `vil`): the same list everywhere, a place that follows from the time alone, never a child, a dog or someone with
// a child, never on the school grounds, only within reach, not in a Zombies game, one message at a time.
// Run: node --test server/villagers.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildVillagers, villagerHittable, villagerPose, VKIND, HUB_PEOPLE, VILLAGER_DOWN_S, VILLAGER_HIT_MAX, VILLAGER_HIT_MS, VILLAGER_SHOT_MAX } from '../shared/villagers.mjs';
import { noShoot } from '../shared/zones.mjs';
import { Game } from './game.mjs';

const data = JSON.parse(readFileSync(new URL('../src/data/villagers.json', import.meta.url), 'utf8'));
const set = buildVillagers(data);
const pose = () => ({ x: 0, z: 0, yaw: 0, hx: 0, hz: 1, speed: 0, here: true, road: false, sit: false, talk: false });

test('the same villagers on every machine, and a place that follows from the time', () => {
  const again = buildVillagers(JSON.parse(JSON.stringify(data)));
  assert.equal(again.list.length, set.list.length);
  assert.ok(set.list.length > 150, `enough of them: ${set.list.length}`);
  const a = pose(), b = pose();
  for (let i = 0; i < set.list.length; i++) {
    assert.equal(again.list[i].kind, set.list[i].kind);
    assert.equal(again.list[i].seed, set.list[i].seed);
    for (const t of [1.7e9, 1.7e9 + 1234.5]) {
      villagerPose(set, i, t, a);
      villagerPose(again, i, t, b);
      assert.deepEqual(a, b, `villager ${i} at ${t}`);
      assert.ok(Number.isFinite(a.x) && Number.isFinite(a.z) && Number.isFinite(a.yaw), `villager ${i} is somewhere`);
    }
  }
});

test('nobody jumps: a villager moves no faster than it walks (but for the step to the other side of its way)', () => {
  const a = pose(), b = pose();
  for (let i = 0; i < set.list.length; i++) {
    const d = set.list[i];
    if (d.role === 'follow' || d.gone) continue;
    for (let k = 0; k < 400; k++) {
      villagerPose(set, i, 1.7e9 + k * 3.1, a);
      villagerPose(set, i, 1.7e9 + k * 3.1 + 0.1, b);
      if (a.here && b.here) assert.ok(Math.hypot(a.x - b.x, a.z - b.z) < d.pace * 0.1 + 1, `villager ${i} (${d.what})`);
    }
  }
});

test('never a child, a dog or someone walking with a child', () => {
  for (const d of set.list) {
    if (d.kind === VKIND.child || d.kind === VKIND.dog || d.guards) assert.equal(d.shootable, false, `${d.what} ${d.id}`);
    if (d.kind === VKIND.child && d.role === 'follow') assert.equal(set.list[d.leader].shootable, false, 'its parent neither');
  }
  assert.ok(set.list.some((d) => d.shootable), 'and some can be hit');
});

const sent = [];
const someone = (name, x, z) => ({
  key: `k-${name}`, role: 'player', ws: { readyState: 1, OPEN: 1, send: (m) => sent.push([name, JSON.parse(m)]), close() {} },
  state: { x, y: 0, z, yaw: 0, pitch: 0, armed: true, flying: false, w: 'pistol', c: false },
  alive: true, hp: 100, respawnAt: 0, protectedUntil: 0, nades: [0, 0], score: { kills: 0, deaths: 0, points: 0 }, weapons: new Set(['pistol']),
});
const auth = () => ({ logged: [], sessions: new Map(), log() {}, addressOf: () => '192.0.2.1', store: { saveZombieRun: async () => true, addStats: async () => {}, setMeta: async () => {} } });
/** A villager that can be hit now and is well away from the school, and where it is. */
function target(now, skip = []) {
  const p = pose();
  for (const d of set.list) {
    if (!d.shootable || d.gone || d.role === 'hub' || skip.includes(d.id)) continue;
    villagerPose(set, d.id, now / 1000, p);
    if (p.here && Math.hypot(p.x - 470, p.z + 815) > 150) return { id: d.id, x: p.x, z: p.z };
  }
  throw new Error('no villager to hit');
}

test('the server decides: in reach it falls and the others hear, out of reach or a child it does not', () => {
  const g = new Game(auth());
  try {
    const now = Date.now();
    const v = target(now);
    const anna = someone('anna', v.x + 20, v.z);
    const bert = someone('bert', v.x + 30, v.z);
    g.players.set('anna', anna);
    g.players.set('bert', bert);
    const child = set.list.find((d) => d.kind === VKIND.child).id;
    const farOff = set.list.find((d) => d.shootable && !d.gone && Math.hypot(d.cx - anna.state.x, d.cz - anna.state.z) > 600).id;
    sent.length = 0;
    // A shot names at most VILLAGER_SHOT_MAX: first three that are no target, then the real one among rubbish.
    g.villagersHit('anna', anna, { ids: [child, farOff, -1] }, now - 1000);
    assert.equal(sent.filter(([, m]) => m.t === 'vil').length, 0, 'a child, one out of reach and no number at all');
    g.villagersHit('anna', anna, { ids: ['x', v.id, v.id] }, now);
    const told = sent.filter(([, m]) => m.t === 'vil');
    assert.equal(told.length, 1, 'one message');
    assert.equal(told[0][0], 'bert', 'to the others, not back to the shooter');
    assert.deepEqual(told[0][1].ids, [v.id], 'only the one in reach, once');
    assert.equal(told[0][1].paint, false);
    assert.equal(told[0][1].ms, VILLAGER_DOWN_S * 1000);
    // Down already: not again, also after the wait between two messages.
    sent.length = 0;
    g.villagersHit('anna', anna, { ids: [v.id] }, now + VILLAGER_HIT_MS + 1);
    assert.equal(sent.filter(([, m]) => m.t === 'vil').length, 0, 'it is down');
    assert.deepEqual(g.villagersView(now + 1000).vils, [[v.id, VILLAGER_DOWN_S * 1000 - 1000]], 'a page that joins hears who is down');
    assert.deepEqual(g.villagersView(now + VILLAGER_DOWN_S * 1000 + 1).vils, [], 'and it is back after its time');
  } finally {
    g.close();
  }
});

test('not too fast, not too many, not unarmed, not down, not from the school grounds, not in a Zombies game', () => {
  const g = new Game(auth());
  try {
    const now = Date.now();
    const v = target(now);
    const w = target(now, [v.id]);
    const anna = someone('anna', v.x + 15, v.z);
    g.players.set('anna', anna);
    g.players.set('bert', someone('bert', v.x + 30, v.z));
    const tries = () => sent.filter(([, m]) => m.t === 'vil').length;
    const shoot = (ids, at, extra = {}) => {
      sent.length = 0;
      g.villagersHit('anna', anna, { ids, ...extra }, at);
      return tries();
    };
    anna.state.armed = false;
    assert.equal(shoot([v.id], now), 0, 'unarmed (Explore)');
    anna.state.armed = true;
    anna.alive = false;
    assert.equal(shoot([v.id], now + 1000), 0, 'down');
    anna.alive = true;
    const was = { x: anna.state.x, z: anna.state.z };
    Object.assign(anna.state, { x: 470, z: -815 }); // the school grounds
    assert.ok(noShoot(anna.state.x, anna.state.z));
    assert.equal(shoot([v.id], now + 2000), 0, 'on the school grounds');
    Object.assign(anna.state, was);
    const free = g.modes.state;
    g.modes.state = { kind: 'zombies', phase: 'play', z: {} };
    assert.equal(shoot([v.id], now + 3000), 0, 'a Zombies game');
    g.modes.state = free;
    assert.equal(shoot([v.id], now + 4000), 1, 'and now it counts');
    Object.assign(anna.state, { x: w.x + 15, z: w.z });
    assert.equal(shoot([w.id], now + 4000 + VILLAGER_HIT_MS - 50), 0, 'too soon after the last message');
    const many = set.list.filter((d) => d.shootable).map((d) => d.id);
    sent.length = 0;
    g.villagersHit('anna', anna, { ids: many }, now + 6000);
    const got = sent.find(([, m]) => m.t === 'vil')?.[1].ids ?? [];
    assert.ok(got.length <= VILLAGER_HIT_MAX, `at most ${VILLAGER_HIT_MAX} a message: ${got.length}`);
  } finally {
    g.close();
  }
});

test('with paintball on, paint sticks and nobody falls', () => {
  const g = new Game(auth());
  try {
    const now = Date.now();
    const v = target(now);
    const anna = someone('anna', v.x + 15, v.z);
    g.players.set('anna', anna);
    g.players.set('bert', someone('bert', v.x + 30, v.z));
    g.rules.paintball = true;
    sent.length = 0;
    g.villagersHit('anna', anna, { ids: [v.id] }, now);
    const m = sent.find(([, x]) => x.t === 'vil')?.[1];
    assert.equal(m?.paint, true);
    assert.equal(m?.w, 'pistol', "the gun the server has in the player's hands, whatever the page says");
    assert.deepEqual(g.villagersView(now).vils, []);
    assert.equal(g.villagersView(now).vilPaint.length, 1);
  } finally {
    g.close();
  }
});

test('a villager on the school grounds is no target', () => {
  // Any villager that ever stands in the zone: not hittable at that moment, from right beside it.
  const p = pose();
  let seen = 0;
  for (const d of set.list) {
    if (!d.shootable || d.gone || d.role === 'hub') continue;
    for (let k = 0; k < 200 && seen < 5; k++) {
      const t = 1.7e9 + k * 7;
      villagerPose(set, d.id, t, p);
      if (!p.here || !noShoot(p.x, p.z)) continue;
      seen++;
      assert.equal(villagerHittable(set, d.id, t, p.x + 5, p.z, 100), false);
    }
  }
});

test('the grown-ups waiting among the children at the school are no target', () => {
  let schools = 0;
  set.hubs.forEach(([, , , kind], h) => {
    if (kind !== 1) return;
    schools++;
    for (let k = 0; k < HUB_PEOPLE; k++) {
      const d = set.list[set.hubBase + h * HUB_PEOPLE + k];
      assert.equal(d.shootable, false, `${d.what} ${d.id} at the school`);
      assert.equal(villagerHittable(set, d.id, 1.7e9, d.cx + 3, d.cz, 100), false);
    }
  });
  assert.ok(schools > 0, 'the school is a busy place');
});

test('a blast is believed only when the server set one off itself, and only round where it was', () => {
  const g = new Game(auth());
  try {
    const now = Date.now();
    const v = target(now);
    const anna = someone('anna', v.x + 20, v.z);
    const bert = someone('bert', v.x + 30, v.z);
    g.players.set('anna', anna);
    g.players.set('bert', bert);
    const told = () => sent.filter(([, m]) => m.t === 'vil');
    // No blast of hers: a page that says "bazooka" is heard as the pistol the server has in her hands.
    sent.length = 0;
    g.villagersHit('anna', anna, { ids: [v.id], w: 'bazooka' }, now);
    assert.equal(told().length, 1);
    assert.equal(told()[0][1].w, 'pistol', 'the weapon is what the server has, not what the page says');
    // Her grenade went off far from the next villager: it is a shot again, and a shot names few.
    const more = [];
    for (let k = 0; k < VILLAGER_HIT_MAX; k++) more.push(target(now, [v.id, ...more.map((o) => o.id)]));
    anna.lastBlast = { x: more[0].x + 400, z: more[0].z, at: now + 400, w: 'grenade' };
    sent.length = 0;
    g.villagersHit('anna', anna, { ids: [more[0].id], w: 'grenade' }, now + 500);
    assert.equal(told().length, 0, 'not within the blast');
    // It went off beside that villager: believed, as a grenade.
    anna.lastBlast = { x: more[0].x + 2, z: more[0].z, at: now + 900, w: 'grenade' };
    sent.length = 0;
    g.villagersHit('anna', anna, { ids: [more[0].id], w: 'grenade' }, now + 1000);
    assert.equal(told().length, 1);
    assert.deepEqual([told()[0][1].ids, told()[0][1].w], [[more[0].id], 'grenade']);
    // An old blast is none: long after it the same words are a pistol shot.
    sent.length = 0;
    anna.state.x = more[1].x + 15;
    anna.state.z = more[1].z;
    g.villagersHit('anna', anna, { ids: [more[1].id], w: 'grenade' }, now + 60000);
    assert.equal(told().length, 1);
    assert.equal(told()[0][1].w, 'pistol');
    // A shot names at most VILLAGER_SHOT_MAX, whatever the page lists.
    assert.ok(VILLAGER_SHOT_MAX < VILLAGER_HIT_MAX);
  } finally {
    g.close();
  }
});
