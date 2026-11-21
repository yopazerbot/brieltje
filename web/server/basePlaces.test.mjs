import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';
import { FOE_R, FREE_R } from './flags.mjs';
import { BASE_GAP } from './teamStarts.mjs';
import { FIELDS } from '../shared/flagFields.mjs';
import { HOMES, distanceToHome, homeAt } from '../shared/homes.mjs';

// Every player a start place of their own in Steal the flag and Attack and defend (server/flags.mjs places and baseSpot,
// server/teamStarts.mjs base): each base has places for a whole team and more, spread round its own start places, none
// in a wall, a home or its garden, the water or outside the field, clear of what stands at the base, each facing the way
// out; at the start nobody stands inside another (15 and 30 a side); who comes back takes a free place, away from the
// opponents. The server's choice alone, from the positions it holds.

function setup() {
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  const store = { addStats: async () => {}, setMeta: async () => {}, getMeta: async () => null, addCar: async () => 1, deleteCar: async () => {} };
  const game = new Game({ session: () => null, store, log: () => {} }, [], null);
  for (const t of game.timers) clearInterval(t);
  game.auth = { ...game.auth, store, session: () => null, log: () => {}, addressOf: () => '127.0.0.1' };
  game.rules.maxPlayers = 200; // the host may set any number of players
  const out = [];
  game.broadcast = (m) => out.push(m);
  game.broadcastThing = () => {};
  game.send = () => {};
  game.stampState = () => {};
  const join = (name) => {
    const ws = { name, readyState: 1, OPEN: 1, send() {}, on: () => {}, close: () => {} };
    game.join(ws, { username: name, role: 'player', key: `k-${name}` }, { headers: {}, socket: {} });
    return game.players.get(name);
  };
  return { game, join, out, at: (ms) => (clock += ms) };
}

/** `n` a side in `place` ('compact', 'village' or 'assault'). */
function crowd(n, place) {
  const s = setup();
  for (let i = 0; i < n * 2; i++) s.join(`p${String(i).padStart(2, '0')}`);
  s.game.modes.start('flag', 'admin', place, place === 'assault' ? { defend: 'blue' } : {});
  const f = s.game.modes.state.f;
  const teams = s.game.modes.state.teams;
  const of = (team) => Object.keys(teams).filter((k) => teams[k] === team);
  return { ...s, f, teams, of };
}

/** What stands at a field's bases, written out again here (not read from the code under test): [x, z, m kept clear]. */
function standing(field) {
  const k = [];
  for (const t of ['blue', 'red']) {
    const b = field.bases[t];
    k.push([b.stand[0], b.stand[1], 2.9, 'stand'], [b.rack[0], b.rack[1], 2.7, 'rack']);
    if (field.heli?.[t]) k.push([field.heli[t].x, field.heli[t].z, 7.9, 'heli']);
    for (const c of field.vehicles?.[t].cars ?? []) k.push([c.x, c.z, c.kind.startsWith('truck') ? 4.9 : 3.3, 'car']);
    for (const c of field.vehicles?.[t].bikes ?? []) k.push([c.x, c.z, 1.1, 'bike']);
  }
  const a = field.assault;
  if (a) {
    for (const c of [...a.crates, ...a.camp.crates]) k.push([c.at[0], c.at[1], 1.4, 'crate']);
    for (const [x, z] of a.camp.tents) k.push([x, z, 4.5, 'tent']);
    for (const [x, z] of a.camp.lamps) k.push([x, z, 1.1, 'lamp']);
    k.push([a.camp.supply[0], a.camp.supply[1], 4.1, 'supply truck']);
  }
  return k;
}

/** Fault with place `q` ({ x, y, z }) at a base of `f`, or null. */
function fault(game, f, q) {
  const ts = game.teamStarts;
  if (homeAt(q.x, q.z, q.y) || ts.private(q.x, q.z, q.y)) return 'in a home or its garden';
  if (HOMES.some((h) => distanceToHome(h.id, q.x, q.z, q.y - 1, q.y + 2.5) < 1.4)) return 'by a home\'s wall';
  if (ts.water(q.x, q.z)) return 'in the water';
  if (ts.indoors(q.x, q.z)) return 'indoors';
  if (!f.edge.inside(q.x, q.z)) return 'outside the field';
  const st = game.standAt(q.x, q.z);
  if (!st.ok) return 'in a wall';
  if (Math.abs(st.y - q.y) > 0.05) return 'off the ground';
  const hit = standing(f.field).find(([x, z, r]) => Math.hypot(q.x - x, q.z - z) < r);
  return hit ? `on the ${hit[3]}` : null;
}

const fields = [['compact', 'compact'], ['village', 'village'], ['assault', 'assaultChurch'], ['assault', 'assaultSparrenhof']];

test('each base: places for two teams of 30, each its own, on free ground, clear of the base\'s things, facing out, a short walk from the stand', () => {
  for (const [place, id] of fields) {
    const s = crowd(1, place);
    const f = s.f;
    if (id === 'assaultSparrenhof') f.field = FIELDS.assaultSparrenhof; // round 2's field
    for (const side of ['blue', 'red']) {
      const ps = f.places(side);
      const name = `${id} ${side}`;
      assert.ok(ps.length >= 60, `${name}: ${ps.length} places`);
      for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) assert.ok(Math.hypot(ps[i].x - ps[j].x, ps[i].z - ps[j].z) >= BASE_GAP - 0.01, `${name}: two places together`);
      const [sx, sz] = f.field.bases[side].stand;
      for (const q of ps) {
        assert.equal(fault(s.game, f, q), null, `${name} ${JSON.stringify(q)}`);
        assert.ok(Math.hypot(q.x - sx, q.z - sz) < 36, `${name}: the stand a short walk off`);
        // Facing open ground: free two metres ahead.
        const d = Math.hypot(q.face[0] - q.x, q.face[1] - q.z);
        for (const m of [1, 2]) assert.ok(s.game.free(q.x + ((q.face[0] - q.x) / d) * m, q.z + ((q.face[1] - q.z) / d) * m), `${name}: a wall ahead of ${JSON.stringify(q)}`);
      }
      // The base's own start places come first, as they are.
      for (const [x, z] of f.field.bases[side].spawns) assert.ok(ps.slice(0, 6).some((q) => q.x === x && q.z === z), `${name}: its own start place (${x}, ${z})`);
    }
  }
});

for (const n of [15, 30]) {
  test(`${n} a side at the start: every player a place of their own, none in a wall, a home, the water or outside the field`, () => {
    for (const place of ['compact', 'village', 'assault']) {
      const s = crowd(n, place);
      const { game, f } = s;
      for (const team of ['blue', 'red']) {
        const names = s.of(team);
        assert.equal(names.length, n);
        const at = names.map((k) => game.players.get(k).state);
        const places = f.places(team);
        let closest = Infinity;
        for (let i = 0; i < at.length; i++) for (let j = i + 1; j < at.length; j++) closest = Math.min(closest, Math.hypot(at[i].x - at[j].x, at[i].z - at[j].z));
        assert.ok(closest >= FREE_R, `${place} ${team}: closest pair ${closest.toFixed(2)} m`);
        for (const [i, st] of at.entries()) {
          const q = places.find((p) => p.x === st.x && p.z === st.z);
          assert.ok(q, `${place} ${team}: ${names[i]} on one of its base's places`);
          assert.equal(fault(game, f, st), null, `${place} ${team} ${names[i]}`);
          // Told where to face: the place's way out.
          const msg = s.out.filter((m) => m.t === 'respawn' && m.name === names[i]).at(-1);
          assert.deepEqual([msg.fx, msg.fz], q.face);
        }
        if (n === 15) {
          // Nobody right in front of another's eyes at the first frame (within 3.2 m, 30 degrees of the way they face).
          const ahead = at.filter((st, i) => {
            const q = places.find((p) => p.x === st.x && p.z === st.z);
            const fx = q.face[0] - q.x, fz = q.face[1] - q.z, fl = Math.hypot(fx, fz);
            return at.some((o, j) => j !== i && Math.hypot(o.x - st.x, o.z - st.z) < 3.2 && ((o.x - st.x) * fx + (o.z - st.z) * fz) / (Math.hypot(o.x - st.x, o.z - st.z) * fl) > Math.cos(Math.PI / 6));
          });
          assert.equal(ahead.length, 0, `${place} ${team}: a teammate right ahead`);
        }
      }
    }
  });
}

test('a hundred returns with opponents at the base: never onto a taken place, never beside an opponent while a place away from them is free', () => {
  for (const place of ['compact', 'assault']) {
    const s = crowd(15, place);
    const { game, f } = s;
    const team = place === 'assault' ? f.defender() : 'blue';
    const mates = s.of(team);
    const foes = s.of(team === 'blue' ? 'red' : 'blue');
    const places = f.places(team);
    const back = mates[0];
    const put = (k, q) => Object.assign(game.players.get(k).state, { x: q.x, y: q.y, z: q.z });
    const st = (k) => game.players.get(k).state;
    for (let run = 0; run < 100; run++) {
      // The one coming back is away (down); teammates on places at random; 1 to 6 opponents in among them.
      put(back, { x: f.field.bases[team === 'blue' ? 'red' : 'blue'].stand[0], y: 0, z: f.field.bases[team === 'blue' ? 'red' : 'blue'].stand[1] });
      const shuffled = [...places].sort(() => Math.random() - 0.5);
      mates.slice(1).forEach((k, i) => put(k, shuffled[i]));
      const camping = foes.slice(0, 1 + (run % 6));
      camping.forEach((k, i) => put(k, { ...shuffled[14 + i], x: shuffled[14 + i].x + 0.4 }));
      foes.slice(camping.length).forEach((k) => put(k, { x: f.field.bases[team === 'blue' ? 'red' : 'blue'].stand[0], y: 0, z: f.field.bases[team === 'blue' ? 'red' : 'blue'].stand[1] }));
      const others = [...mates.slice(1), ...foes].map(st);
      const foeAt = (q) => Math.min(FOE_R, ...camping.map((k) => Math.hypot(st(k).x - q.x, st(k).z - q.z)));
      const free = places.filter((q) => others.every((o) => Math.hypot(o.x - q.x, o.z - q.z) >= FREE_R));
      const best = Math.max(...free.map(foeAt));
      const p = f.baseSpot(back);
      assert.ok(others.every((o) => Math.hypot(o.x - p.x, o.z - p.z) >= FREE_R), `${place} run ${run}: onto a taken place`);
      assert.ok(places.some((q) => q.x === p.x && q.z === p.z), `${place} run ${run}: one of the base's places`);
      const got = foeAt(p);
      // Beside one (within 4 m) never while a free place 12 m from them is there; and never much nearer than the best
      // free place (the ranking's slack: one of the best three within 3 m, a teammate in line 4 m, the inner rings first).
      if (best >= 12) assert.ok(got >= 4, `${place} run ${run}: ${got.toFixed(1)} m from an opponent while ${best.toFixed(1)} m was free`);
      assert.ok(got >= best - 7 - 0.09 * best, `${place} run ${run}: ${got.toFixed(1)} m from an opponent, ${best.toFixed(1)} m free`);
    }
  }
});

test('Attack and defend\'s spawn truck: an attacker comes back on a free spot by it; every spot by it taken, a free place in the camp', () => {
  const s = crowd(8, 'assault');
  const { game, f } = s;
  const att = s.of(f.attacker());
  const truck = f.truckCar();
  f.truckSince = -Infinity; // standing still at its camp, far from the defenders' stand
  assert.ok(f.truckSpawn(Date.now()), 'the truck a start place');
  const st = (k) => game.players.get(k).state;
  for (const k of att) Object.assign(st(k), { x: 0, z: 0 }); // all away
  const taken = [];
  for (const k of att.slice(1, 7)) {
    const p = f.baseSpot(att[0]);
    assert.ok(Math.hypot(p.x - truck.x, p.z - truck.z) < 9, 'by the truck');
    assert.ok(taken.every((q) => Math.hypot(q.x - p.x, q.z - p.z) >= 1.2), 'a spot nobody stands on');
    Object.assign(st(k), { x: p.x, y: p.y, z: p.z });
    taken.push(p);
  }
  const p = f.baseSpot(att[0]);
  assert.ok(taken.every((q) => Math.hypot(q.x - p.x, q.z - p.z) >= 1.2), 'every spot by the truck taken: elsewhere');
  const [cx, cz] = f.camp;
  assert.ok(Math.hypot(p.x - cx, p.z - cz) < 20, 'in the camp');
});

test('a car somebody parked on a base\'s places: nobody starts in it', () => {
  const s = crowd(2, 'compact');
  const { game, f } = s;
  const [b0] = s.of('blue');
  const [q] = f.places('blue');
  game.cars.parked = { id: 'parked', kind: 'modelY', x: q.x, y: q.y, z: q.z, yaw: 0, s: 0, driver: null, passenger: null };
  for (let i = 0; i < 200; i++) {
    const p = f.baseSpot(b0);
    assert.ok(Math.hypot(p.x - q.x, p.z - q.z) >= 3.3, 'not in the parked car');
  }
});

test('more players at a base than it has places: the place with the most room, never a stack while one is free', () => {
  const s = crowd(4, 'compact');
  const { game, f } = s;
  const [b0, ...rest] = s.of('blue');
  const key = `${f.field.id}:blue`;
  const three = f.places('blue').slice(0, 3);
  f.placeSets.set(key, three); // a base with three places only, all of them taken
  rest.forEach((k, i) => Object.assign(game.players.get(k).state, { x: three[i].x + 0.2 * i, z: three[i].z }));
  const p = f.baseSpot(b0);
  const room = (q) => Math.min(...rest.map((k) => Math.hypot(game.players.get(k).state.x - q.x, game.players.get(k).state.z - q.z)));
  assert.equal(room(p), Math.max(...three.map(room)), 'the most room');
});
