import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';
import { SLACK } from './football.mjs';
import { BALL, KICK } from '../shared/ball.mjs';

// The footballs together (server/football.mjs): the server owns each ball, a page only asks to kick it.
function setup() {
  const game = new Game({ session: () => null }, []);
  let clock = 1000;
  game.football.clock = () => clock;
  game.football.last = clock;
  const sent = [];
  const player = (name, x, z, extra = {}) => {
    const p = {
      key: `k-${name}`, role: 'guest', alive: true, weapons: new Set(['pistol']), nades: [], window: Date.now(), msgs: 0, states: 0, others: 0,
      ws: { readyState: 1, OPEN: 1, send: (data) => sent.push({ to: name, m: JSON.parse(data) }) },
      ...extra,
    };
    p.state = { x, y: 0, z, yaw: 0, pitch: 0, armed: false, flying: false, w: 'pistol', c: false };
    game.players.set(name, p);
    return p;
  };
  const school = game.football.get('school');
  const ball = school.ball;
  /** Stand `name` on the ground `d` m from the ball, on the +x side. */
  const beside = (name, d = 0.9) => {
    const p = player(name, ball.x + d, ball.z);
    p.state.y = ball.y - BALL.r;
    return p;
  };
  const send = (name, p, m) => game.handle(name, p, JSON.stringify(m));
  /** One server tick of 50 ms. */
  const tick = (now = Date.now()) => {
    clock += 50;
    game.football.tick(game.players, now, (n) => game.onFoot(n), (p, msg) => game.send(p.ws, msg));
  };
  let accepted = 0;
  const kick = game.football.kick.bind(game.football);
  game.football.kick = (...a) => {
    const ok = kick(...a);
    if (ok) accepted++;
    return ok;
  };
  return { game, sent, player, beside, send, tick, school, ball, accepted: () => accepted };
}

const speed = (b) => Math.hypot(b.vx, b.vy, b.vz);

test('a kick from next to the ball is applied, and the players near it are told who kicked', () => {
  const { sent, beside, player, send, tick, ball, accepted } = setup();
  const kid = beside('kid');
  player('far', 0, 0); // at home, a kilometre away
  send('kid', kid, { t: 'kickball', b: 'school', v: [-8, 1, 0], q: 7 });
  assert.equal(accepted(), 1);
  assert.ok(Math.abs(speed(ball) - Math.hypot(8, 1)) < 1e-9);
  tick();
  const states = sent.filter((s) => s.m.t === 'ball' && s.m.b === 'school');
  assert.ok(states.some((s) => s.to === 'kid' && s.m.k?.[0]?.[0] === 'kid' && s.m.k[0][1] === 7), 'the kicker gets its own kick back');
  assert.ok(!states.some((s) => s.to === 'far'), 'nobody far away is told');
  for (const s of states) {
    assert.equal(s.m.p.length, 6);
    assert.ok(s.m.p.every(Number.isFinite));
  }
});

test('a forged far-away kick is refused (remote kick forgery): the server\'s own position counts, not the page\'s', () => {
  const { send, player, beside, ball, accepted } = setup();
  const far = player('far', ball.x + 20, ball.z);
  far.state.y = ball.y - BALL.r;
  const before = { x: ball.x, z: ball.z, asleep: ball.asleep };
  // Positions in the message are only the page's word: ignored.
  send('far', far, { t: 'kickball', b: 'school', v: [5, 0, 0], q: 1, x: ball.x, y: ball.y, z: ball.z });
  // Just beyond the server's reach (the page's reach and the slack for the delay).
  const edge = player('edge', ball.x + KICK.reach + SLACK + 0.05, ball.z);
  edge.state.y = ball.y - BALL.r;
  send('edge', edge, { t: 'kickball', b: 'school', v: [5, 0, 0], q: 1 });
  // From the play tower above it, or flying over it.
  const up = beside('up', 0.5);
  up.state.y += 3;
  send('up', up, { t: 'kickball', b: 'school', v: [5, 0, 0], q: 1 });
  const flyer = beside('flyer', 0.5);
  flyer.state.flying = true;
  send('flyer', flyer, { t: 'kickball', b: 'school', v: [5, 0, 0], q: 1 });
  assert.equal(accepted(), 0);
  assert.deepEqual({ x: ball.x, z: ball.z, asleep: ball.asleep }, before);
  assert.equal(speed(ball), 0);
});

test('nobody kicks while dead, driving, riding along or on a horse', () => {
  const { game, send, beside, ball, accepted } = setup();
  const dead = beside('dead');
  dead.alive = false;
  send('dead', dead, { t: 'kickball', b: 'school', v: [5, 0, 0] });
  const driver = beside('driver');
  const car = Object.values(game.cars)[0];
  car.driver = 'driver';
  send('driver', driver, { t: 'kickball', b: 'school', v: [5, 0, 0] });
  car.driver = null;
  const rider = beside('rider');
  game.horses[0].rider = 'rider';
  send('rider', rider, { t: 'kickball', b: 'school', v: [5, 0, 0] });
  game.horses[0].rider = null;
  assert.equal(accepted(), 0);
  assert.equal(speed(ball), 0);
});

test('an impulse over the cap is cut to it (impulse forgery): soft standing, hard only when the server saw them run', () => {
  const { send, beside, tick, ball, game } = setup();
  const kid = beside('kid');
  send('kid', kid, { t: 'kickball', b: 'school', v: [-1e9, 1e9, 3], sprint: true, hard: true });
  assert.ok(speed(ball) <= KICK.soft + 1e-9, `standing: ${speed(ball)}`);
  assert.ok(ball.vy <= Math.hypot(ball.vx, ball.vz) * Math.tan(KICK.maxLift) + 1e-9, 'not steeper than allowed');
  // Down into the ground is never a kick downwards.
  game.football.get('school').ball.netted = 0;
  kid.kickedAt = -Infinity;
  send('kid', kid, { t: 'kickball', b: 'school', v: [-5, -50, 0] });
  assert.ok(ball.vy >= 0);
  // Running at 3.5 m/s towards it for a few ticks: a hard kick, and still no more than that.
  const runner = beside('runner', 3);
  for (let i = 0; i < 5; i++) {
    runner.state.x -= 3.5 * 0.05;
    tick();
  }
  ball.x = runner.state.x - 0.5;
  ball.z = runner.state.z;
  ball.vx = ball.vy = ball.vz = 0;
  send('runner', runner, { t: 'kickball', b: 'school', v: [-1e6, 0, 0] });
  assert.ok(Math.abs(speed(ball) - KICK.hard) < 1e-6, `running: ${speed(ball)}`);
});

test('flooding: at most one kick per KICK.every ms, whatever comes in', () => {
  const { send, beside, accepted } = setup();
  const kid = beside('kid', 0.4);
  for (let i = 0; i < 200; i++) send('kid', kid, { t: 'kickball', b: 'school', v: [0, 0, -5], q: i });
  // In one second's window at most 40 messages of this kind are read (server/game.mjs), and of those at most one kick.
  assert.equal(accepted(), 1);
  // A moment later (the window and the kick's wait over) the next one counts again.
  kid.window = 0;
  kid.kickedAt -= KICK.every;
  send('kid', kid, { t: 'kickball', b: 'school', v: [0, 0, -5], q: 999 });
  assert.equal(accepted(), 2);
});

test('anything that is not a kick is refused without harm', () => {
  const { send, beside, ball, accepted, game } = setup();
  const kid = beside('kid', 0.4);
  const bad = [
    { b: '__proto__', v: [1, 0, 0] }, { b: 'constructor', v: [1, 0, 0] }, { b: 'toString', v: [1, 0, 0] }, { b: 'nowhere', v: [1, 0, 0] },
    { b: ['school'], v: [1, 0, 0] }, { b: { toString: 'school' }, v: [1, 0, 0] }, { b: 'school' }, { b: 'school', v: 'fast' },
    { b: 'school', v: [1, 0] }, { b: 'school', v: [NaN, 0, 1] }, { b: 'school', v: [Infinity, 0, 0] }, { b: 'school', v: [0, 9, 0] },
    { b: 'school', v: { 0: 1, 1: 0, 2: 0, length: 3 } }, { b: 'school', v: [null, null, null] },
  ];
  for (const m of bad) {
    kid.msgs = kid.others = 0;
    kid.kickedAt = -Infinity;
    assert.doesNotThrow(() => send('kid', kid, { t: 'kickball', ...m }));
  }
  assert.equal(accepted(), 0);
  assert.equal(speed(ball), 0);
  assert.ok(ball.asleep);
  // A sequence number that isn't a small whole number comes back as 0.
  kid.msgs = kid.others = 0;
  send('kid', kid, { t: 'kickball', b: 'school', v: [-3, 0, 0], q: '<img>' });
  assert.deepEqual(game.football.get('school').kicks, [['kid', 0]]);
});

test('walking into it on the server pushes it; two players near it get the same states', () => {
  const { sent, beside, tick, ball } = setup();
  const a = beside('a', 1.2);
  beside('b', 6);
  const x0 = ball.x;
  for (let i = 0; i < 25; i++) {
    a.state.x -= 1.4 * 0.05; // walking at 1.4 m/s towards it (along -x)
    tick();
  }
  assert.ok(ball.x < x0 - 0.1, `pushed along: ${ball.x - x0}`);
  assert.equal(ball.last, 'a');
  const forA = sent.filter((s) => s.to === 'a' && s.m.t === 'ball').map((s) => JSON.stringify(s.m));
  const forB = sent.filter((s) => s.to === 'b' && s.m.t === 'ball').map((s) => JSON.stringify(s.m));
  assert.ok(forA.length >= 3);
  assert.deepEqual(forA, forB);
});

test('a goal: everyone near hears it once with the score, and the ball is back in the middle after a moment', () => {
  const { sent, beside, send, tick, ball, school } = setup();
  const g = school.pitch.goals[1];
  const kid = beside('kid');
  ball.x = g.mx - g.nx * 4;
  ball.z = g.mz - g.nz * 4;
  ball.y = school.pitch.ground(ball.x, ball.z) + BALL.r;
  kid.state.x = ball.x - g.nx * 0.8;
  kid.state.z = ball.z - g.nz * 0.8;
  send('kid', kid, { t: 'kickball', b: 'school', v: [g.nx * 8, 1, g.nz * 8], q: 1 });
  for (let i = 0; i < 80; i++) tick();
  const goals = sent.filter((s) => s.m.t === 'ballgoal');
  assert.equal(goals.length, 1);
  assert.deepEqual(goals[0].m, { t: 'ballgoal', b: 'school', g: 1, by: 'kid', sc: [0, 1] });
  assert.ok(sent.some((s) => s.m.t === 'ball' && s.m.r === 1), 'back in the middle, said as such');
  assert.equal(ball.x, school.pitch.home.x);
  assert.ok(ball.asleep);
});

test('a player coming near gets the ball once even when it lies still; one going away gets nothing more', () => {
  const { sent, player, tick, ball } = setup();
  const p = player('walker', 0, 0);
  tick();
  assert.equal(sent.filter((s) => s.to === 'walker' && s.m.b === 'school').length, 0);
  p.state.x = ball.x + 40;
  p.state.z = ball.z;
  tick();
  tick();
  const got = sent.filter((s) => s.to === 'walker' && s.m.b === 'school');
  assert.equal(got.length, 1);
  assert.equal(got[0].m.s, 1, 'asleep');
});
