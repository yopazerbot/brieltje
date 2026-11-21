import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { blockKind, gapPoint, partRings, pieceKey, SMASH, smashPieces } from '../shared/smash.mjs';
import { Game } from './game.mjs';

// A hedge, a light fence or a young tree a car breaks (`smash`, server/carSmash.mjs, shared/smash.mjs): the driver's page
// reports it, the server checks it against its own record of the car and keeps the list for the game. A fake clock drives
// both the server's own clock and the wall clock; this file runs in a process of its own.

let T = 1_000_000;
const BASE = 1_800_000_000_000;
Date.now = () => BASE + T;
performance.now = () => T;
const wait = (ms) => (T += ms);

const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const HOUSE = json('../src/data/house_shell.json');
const VILLAGE = json('../src/data/village.json');
const PAGE_PIECES = smashPieces([{ prisms: HOUSE.surroundings.prisms, trees: HOUSE.surroundings.trees }, { prisms: VILLAGE.prisms, trees: VILLAGE.trees }]);

function setup() {
  const game = new Game({ session: () => null, store: { addStats: async () => {} } }, []);
  for (const t of game.timers ?? []) clearInterval(t);
  const told = [];
  const sent = [];
  game.broadcast = (m, except) => told.push({ ...JSON.parse(JSON.stringify(m)), except });
  game.send = (ws, m) => sent.push({ to: ws?.name, ...JSON.parse(JSON.stringify(m)) });
  const pieces = game.carSmash.pieces;
  // A long garden hedge out in the village, inside the edge: the car comes at it straight across.
  const id = pieces.findIndex((p) => p.kind === 'hedge' && p.half > 5 && p.cx > 300 && game.fence().inside(p.cx, p.cz));
  const piece = pieces[id];
  const ground = (x, z) => game.bikeHits.env.ground(x, z);
  const car = game.cars.tesla;
  const nx = -piece.uz, nz = piece.ux; // across the hedge
  const yaw = Math.atan2(nx, nz); // facing -n: towards the hedge from its +n side
  const player = (name, at) => {
    const now = Date.now();
    const p = {
      ws: { name }, key: `k-${name}`, role: 'player', alive: true, protectedUntil: 0, drop: null, warp: 0, stamp: 0, ctGap: null, ctAt: 0,
      state: { x: at.x, y: ground(at.x, at.z), z: at.z, yaw: 0, pitch: 0, armed: false, flying: false, w: 'pistol', c: false },
      weapons: new Set(['pistol']), nades: [0, 0], window: now, msgs: 0, states: 0, others: 0, budget: 0.5, vbudget: 0.5, movedAt: now,
      hp: 100, score: { kills: 0, deaths: 0, points: 0 }, joinTime: now,
    };
    game.players.set(name, p);
    return p;
  };
  const send = (name, p, m) => game.handle(name, p, JSON.stringify(m));
  const state = (name, p, x, z, ms = 33) => {
    wait(ms);
    send(name, p, { t: 'state', x, y: ground(x, z), z, yaw, pitch: 0, armed: false, w: 'pistol', ct: T });
  };
  /** `name` at the wheel `from` m off the hedge's middle (across it), sitting a second. */
  const driver = (name, from = 20) => {
    const x = piece.cx + nx * from, z = piece.cz + nz * from;
    Object.assign(car, { x, y: ground(x, z), z, yaw });
    const p = player(name, { x: x + 1.5, z: z + 1.5 });
    p.nextCar = 0;
    send(name, p, { t: 'car', op: 'in', id: 'tesla' });
    assert.equal(car.driver, name, 'at the wheel');
    for (let i = 0; i < 30; i++) state(name, p, car.x, car.z);
    return p;
  };
  /** Drive at `kmh` towards the hedge until the car's nose is `stop` m off it (its middle 2.4 m further). */
  const run = (name, p, kmh, stop = 0.1) => {
    const step = (kmh / 3.6) * 0.033;
    const end = 2.4 + stop;
    let d = (car.x - piece.cx) * nx + (car.z - piece.cz) * nz;
    for (d -= step; d > end; d -= step) state(name, p, piece.cx + nx * d, piece.cz + nz * d);
    state(name, p, piece.cx + nx * end, piece.cz + nz * end);
  };
  const report = (name, p, m = {}) => send(name, p, { t: 'smash', id, s: 0, w: 2.4, ...m });
  const smashes = () => told.filter((m) => m.t === 'smash');
  const refusals = (name) => sent.filter((m) => m.to === name && m.t === 'smash' && m.no);
  return { game, told, sent, pieces, id, piece, car, player, send, state, driver, run, report, smashes, refusals };
}

test('the server\'s pieces are the page\'s: the same list from the same data, in the same order', () => {
  const { pieces } = setup();
  assert.equal(pieces.length, PAGE_PIECES.length);
  assert.deepEqual(pieces.map((p) => `${p.kind}|${p.key}`), PAGE_PIECES.map((p) => `${p.kind}|${p.key}`));
  const kinds = Object.groupBy(pieces, (p) => p.kind ?? 'none');
  assert.ok(kinds.hedge.length > 1000 && kinds.fence.length > 1000 && kinds.sapling.length > 200, `${Object.keys(kinds).map((k) => `${k} ${kinds[k].length}`)}`);
});

test('what breaks: garden hedges, fences up to 1.4 m, young trees; never walls, tall fences, grown trees or by a home', () => {
  assert.equal(blockKind({ m: 'nb_hedge', y0: 0, y1: 2, p: [[[0, 0], [1, 0], [1, 1]]] }), 'hedge');
  assert.equal(blockKind({ m: 'fence', y0: -0.15, y1: 1.15, p: [[[0, 0], [1, 0], [1, 1]]] }), 'fence');
  assert.equal(blockKind({ m: 'fence', y0: -0.15, y1: 1.7, p: [[[0, 0], [1, 0], [1, 1]]] }), null, 'a 1.85 m fence stands');
  for (const m of ['nb_red', 'concrete', 'pole', 'stone', 'old_wood', 'steel', 'nb_roof']) assert.equal(blockKind({ m, y0: 0, y1: 1, p: [[[0, 0], [1, 0], [1, 1]]] }), null, m);
  const keys = new Set(PAGE_PIECES.map((p) => p.key));
  const walls = VILLAGE.prisms.filter((p) => p.m.startsWith('nb_') && p.m !== 'nb_hedge').slice(0, 500);
  assert.ok(walls.every((p) => !keys.has(pieceKey(p))));
  const grown = VILLAGE.trees.filter((t) => t.h >= 6).slice(0, 200);
  assert.ok(grown.every((t) => !keys.has(`tree:${Math.round(t.x * 100)},${Math.round(t.z * 100)}`)));
  // Nothing by the main house (within 25 m of its box).
  assert.ok(PAGE_PIECES.every((p) => Math.hypot(p.cx, p.cz) > 25));
});

test('a car through a hedge at 30 km/h: reported by its driver, told to everyone, kept for a late joiner', () => {
  const { game, id, driver, run, report, smashes, refusals, player } = setup();
  const anna = driver('anna');
  run('anna', anna, 30);
  report('anna', anna, { s: 0.4, w: 2.6 });
  assert.deepEqual(refusals('anna'), []);
  const got = smashes();
  assert.equal(got.length, 1);
  assert.equal(got[0].except, undefined, 'to every page');
  assert.deepEqual([got[0].id, got[0].s, got[0].w], [id, 0.4, 2.6]);
  assert.ok(Math.abs(got[0].a - game.cars.tesla.yaw) < 0.01, 'the server\'s heading of the car');
  const late = player('late', { x: 0, z: 30 });
  const welcome = game.welcome(late, 'late', '#fff', Date.now());
  assert.deepEqual(welcome.smashed, [[id, 0.4, 2.6, got[0].a]]);
});

test('the spot is held to the piece and the width to the kind\'s', () => {
  const { piece, driver, run, report, smashes } = setup();
  const anna = driver('anna');
  run('anna', anna, 30);
  report('anna', anna, { s: 0.2, w: 99 });
  assert.equal(smashes().at(-1).w, SMASH.hedge.most);
  const { driver: d2, run: r2, report: rep2, smashes: s2 } = setup();
  const bo = d2('bo');
  r2('bo', bo, 30);
  rep2('bo', bo, { s: 0, w: 0.1 });
  assert.equal(s2().at(-1).w, SMASH.hedge.width);
  assert.ok(piece.half > 5);
});

test('only the driver: not the passenger, not someone on foot', () => {
  const { driver, run, report, smashes, player, send, piece } = setup();
  const anna = driver('anna');
  const pam = player('pam', { x: piece.cx + 1, z: piece.cz + 1 });
  pam.nextCar = 0;
  send('pam', pam, { t: 'car', op: 'in', id: 'tesla' });
  run('anna', anna, 30);
  report('pam', pam);
  const eve = player('eve', { x: piece.cx + 0.5, z: piece.cz + 0.5 });
  report('eve', eve);
  assert.equal(smashes().length, 0);
});

test('an unknown piece or a malformed report: dropped without a word', () => {
  const { driver, run, send, smashes, refusals, pieces } = setup();
  const anna = driver('anna');
  run('anna', anna, 30);
  for (const id of [-1, pieces.length, 1e9, 1.5, '3', null, undefined, [], {}]) {
    wait(300);
    send('anna', anna, { t: 'smash', id, s: 0, w: 2.4 });
  }
  for (const s of ['0', null, NaN, Infinity, {}]) {
    wait(300);
    send('anna', anna, { t: 'smash', id: 0, s, w: 2.4 });
  }
  assert.equal(smashes().length, 0);
  assert.equal(refusals('anna').length, 0);
});

test('a piece that does not break (two blocks share its key) is refused', () => {
  const { pieces, driver, send, smashes } = setup();
  const none = pieces.findIndex((p) => p.kind === null);
  assert.ok(none >= 0, 'there is one');
  const anna = driver('anna');
  send('anna', anna, { t: 'smash', id: none, s: 0, w: 2.4 });
  assert.equal(smashes().length, 0);
});

test('too far: the car 40 m off the spot is refused, and told so', () => {
  const { driver, report, smashes, refusals } = setup();
  const anna = driver('anna', 40);
  report('anna', anna);
  assert.equal(smashes().length, 0);
  assert.equal(refusals('anna').length, 1);
});

test('too slow: creeping into it at 8 km/h is refused (it is a soft wall then)', () => {
  const { driver, run, report, smashes, refusals } = setup();
  const anna = driver('anna', 8);
  run('anna', anna, 8);
  report('anna', anna);
  assert.equal(smashes().length, 0);
  assert.equal(refusals('anna').length, 1);
});

test('too often: a second report within the rate, or past the burst, is refused', () => {
  const { driver, run, report, smashes, refusals } = setup();
  const anna = driver('anna');
  run('anna', anna, 40);
  report('anna', anna, { s: -3 });
  wait(SMASH.rate / 2);
  report('anna', anna, { s: 3 });
  assert.equal(smashes().length, 1);
  assert.equal(refusals('anna').length, 1);
  anna.smashes = new Array(SMASH.burst).fill(Date.now());
  wait(SMASH.rate);
  report('anna', anna, { s: 3 });
  assert.equal(smashes().length, 1);
  assert.equal(refusals('anna').length, 2);
});

test('the same spot again is no new gap; a full list and a piece gone too often are refused', () => {
  const { game, id, driver, run, report, smashes, refusals } = setup();
  const anna = driver('anna');
  run('anna', anna, 40);
  report('anna', anna, { s: 0 });
  wait(SMASH.rate);
  report('anna', anna, { s: 0.5 });
  assert.equal(smashes().length, 1);
  assert.equal(game.carSmash.gaps.length, 1);
  for (let i = game.carSmash.gaps.length; i < SMASH.cap; i++) game.carSmash.gaps.push({ id: id + 1 + i, s: 0, w: 2.4, a: 0, at: Date.now() });
  wait(SMASH.rate);
  report('anna', anna, { s: 4 });
  assert.equal(smashes().length, 1);
  assert.equal(game.carSmash.gaps.length, SMASH.cap);
  assert.equal(refusals('anna').length, 2);
});

test('mending: after five minutes with nobody near; with someone near only after fifteen; all at once when a game starts', () => {
  const { game, id, piece, driver, run, report, told, player, send } = setup();
  const anna = driver('anna');
  run('anna', anna, 30);
  report('anna', anna, { s: 0 });
  const mends = () => told.filter((m) => m.t === 'mend');
  // Anna stays by it.
  wait(SMASH.mend + 1000);
  game.carSmash.tick(Date.now());
  assert.equal(mends().length, 0, 'someone is near');
  // She drives off (the car's state far away).
  game.players.get('anna').state.x = piece.cx + 500;
  wait(3000);
  game.carSmash.tick(Date.now());
  assert.deepEqual(mends().at(-1), { t: 'mend', list: [[id, 0]], except: undefined });
  assert.equal(game.carSmash.gaps.length, 0);
  // Someone stays by a new one: it mends at SMASH.late.
  game.carSmash.gaps.push({ id, s: 0, w: 2.4, a: 0, at: Date.now() });
  game.players.get('anna').state.x = piece.cx;
  game.players.get('anna').state.z = piece.cz;
  wait(SMASH.late - 5000);
  game.carSmash.tick(Date.now());
  assert.equal(game.carSmash.gaps.length, 1);
  wait(10_000);
  game.carSmash.tick(Date.now());
  assert.equal(game.carSmash.gaps.length, 0);
  // A game starting mends everything at once.
  game.carSmash.gaps.push({ id, s: 0, w: 2.4, a: 0, at: Date.now() });
  game.carSmash.tick(Date.now());
  Object.defineProperty(game.modes, 'active', { get: () => true, configurable: true });
  game.carSmash.tick(Date.now());
  assert.deepEqual(mends().at(-1), { t: 'mend', all: true, except: undefined });
  assert.equal(game.carSmash.gaps.length, 0);
  void player; void send;
});

test('the parts that stand of a piece with a gap: cut straight across it, the gap clear', () => {
  const piece = PAGE_PIECES.find((p) => p.kind === 'hedge' && p.half > 5);
  const ring = [...HOUSE.surroundings.prisms, ...VILLAGE.prisms].find((p) => pieceKey(p) === piece.key).p[0];
  const parts = partRings(ring, piece, [{ s: 0, w: 2.4 }]);
  assert.equal(parts.length, 2);
  const along = (x, z) => (x - piece.cx) * piece.ux + (z - piece.cz) * piece.uz;
  for (const r of parts) {
    const a = r.map(([x, z]) => along(x, z));
    assert.ok(Math.min(...a) >= 1.2 - 1e-6 || Math.max(...a) <= -1.2 + 1e-6, 'nothing in the gap');
  }
  assert.deepEqual(partRings(ring, piece, [{ s: 0, w: piece.half * 4 }]), []);
  const [gx, gz] = gapPoint(piece, 1);
  assert.ok(Math.abs(along(gx, gz) - 1) < 1e-9);
});
