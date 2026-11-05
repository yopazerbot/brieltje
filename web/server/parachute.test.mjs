import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DROP, dropStart, dropStep, fly, HOME_DROP } from '../shared/parachute.mjs';
import { FLAG, playerFields, readPlayer } from '../shared/wire.mjs';
import { Game } from './game.mjs';
import { ZombieGame } from './zombies.mjs';
import { arenaEdge, arenaOf } from '../shared/arenas.mjs';
import { loadBounds } from '../shared/bounds.mjs';
import { makeTerrain } from '../shared/terrain.mjs';

const BOUNDS = loadBounds(JSON.parse(readFileSync(new URL('../shared/bounds.json', import.meta.url), 'utf8')));
const TERRAIN = makeTerrain(JSON.parse(readFileSync(new URL('../shared/terrain.json', import.meta.url), 'utf8')));

const state = { x: 1, y: 20, z: 2, yaw: 0, pitch: 0, armed: true, w: 'pistol', c: false, flying: false };
const MAX_SPEED = 16; // m/s down: the server's limit (game.mjs)
const RUN_SPEED = 1.4 * 2.5 * 1.3; // m/s across on foot (game.mjs)
const DROP_SPEED = DROP.across * 1.3; // m/s across in a drop (game.mjs)

test('the drop and canopy flags travel in a tick without touching the teleport counter', () => {
  for (const warp of [0, 1, 2, 3]) {
    const f = playerFields({ ...state, chute: true, open: true }, true, true, warp);
    assert.equal(f[5] & FLAG.chute, FLAG.chute);
    const p = readPlayer(['a', 0, ...f]);
    assert.equal(p.chute, true);
    assert.equal(p.open, true);
    assert.equal(p.warp, warp);
    assert.equal(p.safe, true);
    const fall = readPlayer(['a', 0, ...playerFields({ ...state, chute: true }, true, false, warp)]);
    assert.equal(fall.chute, true);
    assert.equal(fall.open, false);
    assert.equal(readPlayer(['a', 0, ...playerFields(state, true, false, warp)]).chute, false);
    assert.equal(readPlayer(['a', 0, ...playerFields({ ...state, open: true }, true, false, warp)]).open, false, 'no canopy without a drop');
  }
});

test('a drop starts DROP.reach behind the place it lands on hands off, whichever way it faces', () => {
  for (const yaw of [0, 1, -2.5, Math.PI]) {
    const s = dropStart(10, -5, yaw);
    // Forward is (-sin yaw, -cos yaw): gliding forward from the start reaches the place.
    assert.ok(Math.abs(s.x + -Math.sin(yaw) * DROP.reach - 10) < 1e-9);
    assert.ok(Math.abs(s.z + -Math.cos(yaw) * DROP.reach + 5) < 1e-9);
  }
});

test('hands off: from high up, a free fall straight down, the canopy opens by itself, about 20 to 30 s', () => {
  assert.ok(DROP.height >= 150 && DROP.height <= 200, 'clearly higher than the old 80 m');
  // Under the highest height a state may say (game.mjs where(): 200 m), over the highest ground there is (16.2 m).
  assert.ok(DROP.height + 16.2 + 1 < 200);
  assert.ok(DROP.time > 18 && DROP.time < 30, `takes ${DROP.time} s`);
  for (const dt of [1 / 20, 1 / 30, 1 / 60, 1 / 144]) {
    const f = fly(dt);
    assert.ok(Math.abs(f.reach - DROP.reach) < 1, `reach ${f.reach} at dt ${dt}`);
    assert.ok(Math.abs(f.side) < 1e-6);
    assert.ok(Math.abs(f.time - DROP.time) < 0.3);
    const open = f.path.find((p) => p.open !== null);
    assert.ok(Math.abs(open.y - DROP.openAt) < 1.2, `opens at ${open.y} m`);
    assert.ok(open.x < 0.01, 'the free fall goes straight down');
  }
});

test('the canopy opens by hand from DROP.minFall on, not before', () => {
  const s = { t: 0.5, open: null, vx: 0, vz: 0, vy: -5, air: 160 };
  dropStep(s, { open: true }, 0, 1 / 60);
  assert.equal(s.open, null);
  s.t = DROP.minFall;
  dropStep(s, { open: true }, 0, 1 / 60);
  assert.equal(s.open, 0);
  // Opened high up, a drop lasts longer but still ends inside DROP.maxMs, even braking all the way.
  const slow = fly(1 / 60, { openAt: DROP.minFall, input: { moveY: -1 } });
  assert.ok(slow.time * 1000 < DROP.maxMs - 3000, `${slow.time} s against ${DROP.maxMs} ms`);
});

test('whatever the keys do, a drop stays inside what the server allows: across, down, coming down, time', () => {
  const inputs = [];
  for (const moveX of [-1, -0.5, 0, 1]) for (const moveY of [-1, 0, 0.5, 1]) for (const dive of [false, true]) inputs.push({ moveX, moveY, dive });
  for (const dt of [1 / 20, 1 / 60, 1 / 144]) {
    for (const input of inputs) {
      for (const openAt of [DROP.minFall, 6, Infinity]) {
        for (const turn of [0, 1]) {
          const f = fly(dt, { input, openAt, turn });
          const what = JSON.stringify({ dt, input, openAt, turn });
          assert.ok(f.down < MAX_SPEED - 1, `down ${f.down} m/s ${what}`);
          assert.ok(f.across <= DROP.across + 1e-6 && f.across * 1.3 <= DROP_SPEED + 1e-6, `across ${f.across} m/s ${what}`);
          assert.ok(f.slowest > DROP.hoverMin * 1.3, `comes down at least ${f.slowest} m/s ${what}`);
          assert.ok(f.time * 1000 < DROP.maxMs - 3000, `${f.time} s ${what}`);
        }
      }
    }
  }
  // Steering takes you far: tracking reaches well over 100 m, sliding sideways too.
  assert.ok(fly(1 / 60, { input: { moveY: 1 } }).reach > 120);
  assert.ok(Math.abs(fly(1 / 60, { input: { moveX: 1 } }).side) > 60);
});

test('the house drop lands on the house start, in the lane', () => {
  const house = JSON.parse(readFileSync(new URL('../src/data/house.json', import.meta.url), 'utf8'));
  assert.equal(HOME_DROP.x, house.spawn.x);
  assert.equal(HOME_DROP.z, house.spawn.z);
  const spawns = JSON.parse(readFileSync(new URL('../shared/spawns.json', import.meta.url), 'utf8'));
  assert.equal(Math.hypot(spawns[0].x - HOME_DROP.x, spawns[0].z - HOME_DROP.z), 0, 'where the server has everyone who joins');
});

test('in a drop nobody shoots or is hurt, until landing gives the usual short protection', () => {
  const g = Object.create(Game.prototype);
  const p = { state: { ...state, x: 300, z: 300 }, protectedUntil: 0, drop: null };
  const now = Date.now();
  assert.equal(g.calm(p), false); // far from the school grounds
  g.startDrop(p, now);
  assert.equal(g.dropping(p, now), true);
  assert.equal(g.calm(p), true);
  assert.equal(p.protectedUntil, now + DROP.maxMs);
  assert.equal(g.dropping(p, now + DROP.maxMs), false); // a drop that takes too long ends
  g.landed(p, now + 1000);
  assert.equal(p.drop, null);
  assert.equal(g.calm(p), false);
  assert.ok(p.protectedUntil > now + 1000 && p.protectedUntil <= now + 1000 + 5000);
});

/** A game with just enough for a start: no cars or horses, the edge everywhere (or `inside`), messages kept. */
function startGame(rules = {}, inside = () => true) {
  const g = Object.create(Game.prototype);
  const sent = [];
  const told = [];
  Object.assign(g, {
    rules: { parachute: true, portals: true, flying: true, ...rules },
    carOf: () => null,
    horseOf: () => null,
    fence: () => ({ inside, putBack: (x, z) => ({ x, z, moved: false }) }),
    send: (_ws, m) => sent.push(m),
    broadcast: (m) => told.push(m),
    stampState: () => {},
    releaseCar: () => {},
    releaseHorse: () => {},
    modes: { active: false, noShooting: false, zombies: null, teamOf: () => null },
    players: new Map(),
    cars: {},
    free: () => true,
  });
  return { g, sent, told };
}
const joined = (now, at = { x: 4.5, y: -0.1, z: 19 }) => ({
  ws: {}, alive: true, spawned: false, joinTime: now, joinedAt: { x: at.x, z: at.z }, protectedUntil: now + 2000, drop: null, warp: 0, stamp: 0,
  role: 'player', weapons: new Set(['pistol']), nades: [0, 0], window: now, msgs: 0, states: 0, others: 0, budget: 0.5, vbudget: 0.5, movedAt: now,
  state: { x: at.x, y: at.y, z: at.z, yaw: 0, pitch: 0, armed: false, flying: false, w: 'pistol', c: false },
});

test('a fresh arrival at the house drops when the server says so, once, and only onto where it is', () => {
  const now = Date.now();
  const { g, sent } = startGame();
  const p = joined(now);
  g.spawn('a', p, 'home', now + 2000);
  assert.equal(sent.length, 1);
  const from = dropStart(HOME_DROP.x, HOME_DROP.z, HOME_DROP.yaw);
  assert.deepEqual(sent[0], { t: 'spawn', ok: true, drop: 1, x: HOME_DROP.x, z: HOME_DROP.z, yaw: HOME_DROP.yaw, sx: from.x, sz: from.z });
  assert.equal(g.dropping(p, now + 2000), true);
  assert.equal(p.protectedUntil, now + 2000 + DROP.maxMs);
  assert.ok(Math.abs(p.state.x - from.x) < 1e-9 && Math.abs(p.state.z - from.z) < 1e-9);
  assert.ok(p.state.y > DROP.height - 5);
  // Once: a second ask, or a start place after it, does nothing.
  g.spawn('a', p, 'home', now + 3000);
  g.spawn('a', p, 'church', now + 3000);
  assert.equal(sent.length, 1);
});

test('no house drop with the rule off, late, far from the start, dead, or for an unknown place', () => {
  const now = Date.now();
  const cases = [
    [{ parachute: false }, joined(now), now + 1000],
    [{}, joined(now), now + 91_000],
    [{}, joined(now, { x: 40, y: 0, z: 19 }), now + 1000], // a reconnect elsewhere: no free trip to the house
    [{}, { ...joined(now), alive: false }, now + 1000],
  ];
  for (const [rules, p, at] of cases) {
    const { g, sent } = startGame(rules);
    const before = { ...p.state };
    g.spawn('a', p, 'home', at);
    assert.equal(sent.length, 0);
    assert.equal(p.drop, null);
    assert.deepEqual(p.state, before);
  }
  const { g, sent } = startGame();
  const p = joined(now);
  g.spawn('a', p, 'nowhere', now + 1000);
  assert.equal(sent.length, 0);
  assert.equal(p.spawned, false);
});

test('a start place by parachute tells the page where it lands, facing which way, and where it starts', () => {
  const now = Date.now();
  const { g, sent } = startGame();
  const p = joined(now);
  g.spawn('a', p, 'church', now + 1000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].drop, 1);
  assert.equal(typeof sent[0].yaw, 'number');
  const from = dropStart(sent[0].x, sent[0].z, sent[0].yaw);
  assert.ok(Math.abs(p.state.x - from.x) < 1e-9 && Math.abs(p.state.z - from.z) < 1e-9);
  assert.deepEqual([sent[0].sx, sent[0].sz], [p.state.x, p.state.z]);
});

test('/parachute starts high over where the player stands (behind them, or straight over near the edge), then not again for a minute', () => {
  const now = Date.now();
  const { g, sent } = startGame();
  const p = joined(now - 120_000, { x: 4.5, y: -0.1, z: 19 }); // in the lane, long after joining
  p.state.yaw = 0.4;
  g.manualDrop('a', p, now);
  const from = dropStart(4.5, 19, 0.4);
  assert.deepEqual(sent[0], { t: 'spawn', ok: true, drop: 1, x: 4.5, z: 19, yaw: 0.4, sx: from.x, sz: from.z });
  assert.equal(g.dropping(p, now), true);
  assert.ok(Math.abs(p.state.x - from.x) < 1e-9 && Math.abs(p.state.z - from.z) < 1e-9);
  assert.ok(p.state.y > DROP.height - 5);
  // Landed (the drop is over): still a minute between two.
  g.landed(p, now + 12_000);
  p.state = { ...p.state, x: 4.5, y: -0.1, z: 19 };
  g.manualDrop('a', p, now + 30_000);
  assert.deepEqual(sent[1], { t: 'chute', ok: false, code: 'chuteWait', args: { s: 30 } });
  g.manualDrop('a', p, now + 61_000);
  assert.equal(sent[2].t, 'spawn');
  // Near the edge (the start behind would be over it): straight over where they stand.
  const edge = startGame({}, (x) => x < 10);
  const q = joined(now - 120_000, { x: 4.5, y: -0.1, z: 19 });
  q.state.yaw = Math.PI / 2; // facing west: the start is behind them, east, and east of x = 10 is over the edge
  edge.g.manualDrop('a', q, now);
  assert.equal(edge.sent[0].sx, 4.5);
  assert.equal(edge.sent[0].sz, 19);
  assert.deepEqual([q.state.x, q.state.z], [4.5, 19]);
});

test('no /parachute with the rule off, dead, in a game, just after a hit, indoors, or in a drop already', () => {
  const now = Date.now();
  const cases = [
    ['chuteOff', { parachute: false }, (p) => p, false],
    ['chuteNotNow', {}, (p) => ({ ...p, alive: false }), false],
    ['chuteNotNow', {}, (p) => p, true], // a game of the menu (Zombies, a party game)
    ['chuteFight', {}, (p) => ({ ...p, hurtAt: now - 5000 }), false],
    ['chuteIndoors', {}, (p) => ({ ...p, state: { ...p.state, x: 2.5, y: -0.1, z: 5 } }), false], // a bedroom of the house
    ['chuteNotNow', {}, (p) => ({ ...p, drop: { from: now - 1000, until: now + 9000 } }), false],
  ];
  for (const [code, rules, change, active] of cases) {
    const { g, sent } = startGame(rules);
    g.modes.active = active;
    const p = change(joined(now - 120_000));
    const before = { ...p.state };
    g.manualDrop('a', p, now);
    assert.deepEqual(sent, [{ t: 'chute', ok: false, code, args: {} }], code);
    assert.deepEqual(p.state, before);
  }
});

/**
 * Drive the server's state handler on a clock of our own: `steps` updates `every` ms apart from `p`'s state,
 * each moving by `move(i)` ({ dx, dy, dz }) with the flags `flags(i)`. Returns where the server has them after each.
 */
function drive(g, p, start, steps, every, move, flags = () => ({})) {
  const real = Date.now;
  const seen = [];
  try {
    for (let i = 0; i < steps; i++) {
      const t = start + (i + 1) * every;
      Date.now = () => t;
      p.window = 0; // a fresh flood window each time: not what is tested here
      const { dx = 0, dy = 0, dz = 0 } = move(i);
      const want = { x: p.page.x + dx, y: p.page.y + dy, z: p.page.z + dz };
      p.page = want;
      g.handle('a', p, JSON.stringify({ t: 'state', ...want, yaw: 0, pitch: 0, armed: false, w: 'pistol', ...flags(i) }));
      seen.push({ ...p.state, t });
    }
  } finally {
    Date.now = real;
  }
  return seen;
}

/** A player whose drop the server started at `now`, 170 m over open ground far from the house. */
function dropper(g, now) {
  const p = joined(now, { x: 300, y: 0, z: 300 });
  p.state.y = DROP.height;
  p.page = { ...p.state };
  g.startDrop(p, now);
  return p;
}

test('in a drop the server allows the skydive\'s speeds, and only then: across, down, never up', () => {
  const { g } = startGame();
  const now = Date.now();
  const p = dropper(g, now);
  // Tracking at 12 m/s across and 12 m/s down for 2 s (after the start's grace): all of it taken.
  let s = drive(g, p, now + 1500, 40, 50, () => ({ dx: 0.6, dy: -0.6 }), () => ({ pc: 1 }));
  assert.ok(Math.abs(s.at(-1).x - p.page.x) < 0.01 && Math.abs(s.at(-1).y - p.page.y) < 0.01, 'a legal drop is held to nothing');
  // Faster than any drop (40 m/s across): held to DROP_SPEED (with half a second's worth stored, as ever).
  const x0 = p.state.x;
  s = drive(g, p, now + 3500, 20, 50, () => ({ dx: 2 }), () => ({ pc: 1 }));
  const went = s.at(-1).x - x0;
  assert.ok(went <= DROP_SPEED * 1.5 + 0.6 && went > DROP_SPEED, `went ${went} m in 1 s`);
  // Up: next to nothing (at most the small allowance), whatever the page says.
  p.page = { ...p.state };
  const y0 = p.state.y;
  s = drive(g, p, now + 4500, 20, 50, () => ({ dy: 1 }), () => ({ pc: 1 }));
  assert.ok(s.at(-1).y - y0 < 1.2, `rose ${s.at(-1).y - y0} m`);
  // After the drop (landed): running's budget again.
  g.landed(p, now + 6000);
  p.page = { ...p.state };
  const x1 = p.state.x;
  s = drive(g, p, now + 6000, 20, 50, () => ({ dx: 0.6 }));
  assert.ok(s.at(-1).x - x1 <= RUN_SPEED * 1.5 + 0.6, `ran ${s.at(-1).x - x1} m in 1 s`);
});

test('outside a drop a parachute flag counts for nothing: no flag for the others, no skydive speeds', () => {
  const { g } = startGame();
  const now = Date.now();
  const p = joined(now, { x: 300, y: 50, z: 300 });
  p.page = { ...p.state };
  const s = drive(g, p, now, 20, 50, () => ({ dx: 0.6 }), () => ({ pc: 1, po: 1 }));
  assert.equal(p.state.chute, false);
  assert.equal(p.state.open, false);
  assert.equal(p.drop, null);
  assert.ok(s.at(-1).x - 300 < RUN_SPEED + 1);
  assert.equal(g.calm(p), false);
});

test('a drop that stops coming down ends: hovering in the air, or keeping the flag on the ground', () => {
  const now = Date.now();
  {
    const { g } = startGame();
    const p = dropper(g, now);
    // Coming down 1 m a second (under DROP.hoverMin), the flag on: over after one stretch of DROP.hoverMs.
    drive(g, p, now, 120, 50, () => ({ dy: -0.05 }), () => ({ pc: 1, po: 1 }));
    assert.equal(p.drop, null, 'hovering ended the drop');
    assert.equal(p.state.chute, false);
    assert.ok(p.protectedUntil <= now + 6000 + 5000);
  }
  {
    const { g } = startGame();
    const p = dropper(g, now);
    // Down to the bare ground quickly (allowed), then standing there with the flag on: over within a second or two.
    const ground = p.state.y - DROP.height;
    p.state.y = p.page.y = ground + 3;
    drive(g, p, now + 1300, 60, 50, () => ({ dy: -0.2 }), () => ({ pc: 1, po: 1 }));
    assert.equal(p.drop, null, 'the flag on the ground ended the drop');
  }
  {
    // A page gone quiet: the tick ends it too (nothing comes down).
    const { g } = startGame();
    const p = dropper(g, now);
    g.dropCheck(p, now + DROP.hoverMs + 100);
    assert.equal(p.drop, null);
  }
  {
    // A real drop isn't cut short: hands off from the top, as the page flies it, at 20 states a second.
    const { g } = startGame();
    const p = dropper(g, now);
    const path = fly(1 / 20).path;
    drive(g, p, now, path.length - 1, 50, (i) => ({ dx: 0, dy: path[i + 1].y - path[i].y, dz: -(path[i + 1].x - path[i].x) }), () => ({ pc: 1 }));
    assert.ok(p.drop, 'still dropping on its way down');
  }
});

test('a respawn after a death drops onto open ground, told where it starts; never into a room', () => {
  const now = Date.now();
  const spawns = JSON.parse(readFileSync(new URL('../shared/spawns.json', import.meta.url), 'utf8'));
  const outside = spawns.findIndex((s) => s.outside);
  const { g, told } = startGame();
  const p = joined(now);
  g.players.set('a', p);
  g.respawn('a', p, now, { spawn: outside, ...spawns[outside] }, true);
  assert.ok(p.drop && g.dropping(p, now));
  const m = told.at(-1);
  assert.equal(m.t, 'respawn');
  assert.equal(m.drop, 1);
  assert.deepEqual([m.sx, m.sz], [p.state.x, p.state.z]);
  assert.ok(Math.abs(p.state.y - (spawns[outside].y + DROP.height)) < 1e-9);
  assert.equal(p.drop.top, p.state.y + 0.5);
});

test('the Zombies game drops everyone in: its start, the return between waves and a late join, inside the place', () => {
  const now = Date.now();
  for (const arena of [arenaOf('church'), arenaOf('molenhoek_end'), arenaOf('house')]) {
    const edge = arenaEdge(arena, BOUNDS);
    const { g, told } = startGame();
    for (const n of ['a', 'b', 'c']) g.players.set(n, { ...joined(now), alive: false });
    g.gather(['a', 'b', 'c'], arena, true);
    assert.equal(told.length, 3);
    for (const m of told) {
      const p = g.players.get(m.name);
      assert.ok(m.t === 'respawn' && m.drop === 1 && g.dropping(p, now), `${arena.id}: ${m.name} drops`);
      assert.deepEqual([m.sx, m.sz], [p.state.x, p.state.z]);
      // Its whole way in, hands off, over the place's own ground: from the start to the spot, inside the edge.
      const spot = { x: m.x ?? p.state.x, z: m.z ?? p.state.z };
      for (let k = 0; k <= 20; k++) {
        const x = m.sx + ((spot.x - m.sx) * k) / 20, z = m.sz + ((spot.z - m.sz) * k) / 20;
        assert.ok(edge.inside(x, z), `${arena.id}: the way in leaves the edge at ${x}, ${z}`);
      }
      assert.ok(p.state.y > DROP.height - 30);
    }
  }
  // The game's own calls ask for a drop: the return between waves (and a late join, the same call).
  const asked = [];
  const zg = Object.create(ZombieGame.prototype);
  Object.assign(zg, {
    helping: new Map(), fell: new Map(), perchedOut: new Set(), down: new Set(['a']), arena: { id: 'house' },
    game: { players: new Map([['a', { alive: false }]]), gather: (...args) => asked.push(args) },
  });
  zg.revive();
  assert.deepEqual(asked, [[['a'], { id: 'house' }, true]]);
});

test('steered freely, a drop in a Zombies place stays inside its edge', () => {
  const now = Date.now();
  const arena = arenaOf('church');
  const edge = arenaEdge(arena, BOUNDS);
  const { g } = startGame();
  g.fence = () => edge; // the game's fence while it runs (game.mjs fence)
  const [cx, cz] = arena.center;
  const p = joined(now, { x: cx, y: 0, z: cz });
  p.state.y = TERRAIN.height(cx, cz) + DROP.height;
  p.page = { ...p.state };
  g.startDrop(p, now);
  // Tracking straight out of the circle at 12 m/s for 12 s (and sliding), as fast as a drop may.
  const seen = drive(g, p, now, 240, 50, () => ({ dx: 0.45, dy: -0.6, dz: 0.3 }), () => ({ pc: 1 }));
  for (const s of seen) assert.ok(edge.inside(s.x, s.z), `out of the edge at ${s.x}, ${s.z}`);
  assert.ok(Math.hypot(seen.at(-1).x - cx, seen.at(-1).z - cz) > arena.radius - 6, 'it did reach the edge');
});
