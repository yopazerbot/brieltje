import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeTerrain } from './terrain.mjs';
import { BALL, BODY, fairKick, inReach, insidePitch, KICK, kickBall, kickFrom, makePitch, newBall, PITCHES, stepBall, toHome } from './ball.mjs';

// The football (shared/ball.mjs): the same steps on the server and in the page, so these hold for both.
const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const terrain = makeTerrain(read('./terrain.json'));
const house = read('../src/data/house_shell.json');
const height = (x, z) => house.ground + terrain.height(x, z);
const school = makePitch(PITCHES.find((p) => p.id === 'school'), height);
const lawn = makePitch(PITCHES.find((p) => p.id === 'lawn'), height);

/** A repeatable random series (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const finite = (b) => [b.x, b.y, b.z, b.vx, b.vy, b.vz].every(Number.isFinite);

/** A random spot inside the pitch, clear of its walls by a ball's width. */
function spotIn(pitch, rand) {
  for (;;) {
    const x = pitch.box.minX + rand() * (pitch.box.maxX - pitch.box.minX);
    const z = pitch.box.minZ + rand() * (pitch.box.maxZ - pitch.box.minZ);
    if (!insidePitch(pitch, x, z)) continue;
    if (pitch.walls.some((w) => distToSegment(x, z, w) < BALL.r * 2)) continue;
    if (pitch.posts.some((p) => Math.hypot(x - p.x, z - p.z) < p.r + BALL.r * 2)) continue;
    if (pitch.goals.some((g) => inGoalBox(g, x, z))) continue;
    return [x, z];
  }
}

function distToSegment(x, z, w) {
  const ex = w.bx - w.ax, ez = w.bz - w.az;
  const t = Math.max(0, Math.min(1, ((x - w.ax) * ex + (z - w.az) * ez) / (ex * ex + ez * ez)));
  return Math.hypot(x - (w.ax + ex * t), z - (w.az + ez * t));
}

function inGoalBox(g, x, z) {
  const deep = (x - g.mx) * g.nx + (z - g.mz) * g.nz;
  const along = (x - g.mx) * g.ux + (z - g.mz) * g.uz;
  return deep > -0.3 && deep < g.depth + 0.3 && Math.abs(along) < g.half + 0.3;
}

function place(ball, pitch, x, z, y = null) {
  toHome(ball, pitch);
  ball.x = x;
  ball.z = z;
  ball.y = y ?? pitch.ground(x, z) + BALL.r;
  return ball;
}

test('both pitches: the middle is inside the outline, on the ground, clear of everything', () => {
  for (const pitch of [school, lawn]) {
    const b = newBall(pitch);
    assert.ok(insidePitch(pitch, b.x, b.z), pitch.id);
    assert.ok(Math.abs(b.y - (pitch.ground(b.x, b.z) + BALL.r)) < 1e-9);
    assert.ok(b.asleep);
    for (const p of pitch.posts) assert.ok(Math.hypot(b.x - p.x, b.z - p.z) > 1.5, `${pitch.id}: the middle is clear of a post`);
    for (const w of pitch.walls) assert.ok(distToSegment(b.x, b.z, w) > 3, `${pitch.id}: the middle is clear of the walls`);
  }
  assert.equal(school.goals.length, 2);
  for (const g of school.goals) assert.ok(insidePitch(school, g.mx + g.nx * (g.depth + 0.1), g.mz + g.nz * (g.depth + 0.1)), `goal ${g.id} fits inside`);
});

test('the goals stand clear of the benches, the play tower and the balance posts', () => {
  const spec = PITCHES.find((p) => p.id === 'school');
  const corners = [...spec.posts.map(([x, z, r]) => [x, z, r]), ...spec.panels.flatMap((p) => [[p[0], p[1], 0], [p[3], p[4], 0], [p[6], p[7], 0]])];
  for (const g of school.goals) {
    for (const [x, z, r] of corners) {
      const deep = (x - g.mx) * g.nx + (z - g.mz) * g.nz;
      const along = (x - g.mx) * g.ux + (z - g.mz) * g.uz;
      const clear = deep < -1 - r || deep > g.depth + 0.3 + r || Math.abs(along) > g.half + 0.3 + r;
      assert.ok(clear, `goal ${g.id} is clear of the thing at ${x.toFixed(2)}, ${z.toFixed(2)}`);
    }
  }
});

test('finite and inside under any step length: dt spikes, zero, negative, NaN, tiny', () => {
  const rand = rng(7);
  const steps = [0, -1, NaN, Infinity, 1e-9, 1 / 240, 1 / 60, 1 / 30, 0.1, 0.25, 1, 5, 60];
  for (const pitch of [school, lawn]) {
    const b = newBall(pitch);
    for (let k = 0; k < 300; k++) {
      if (k % 10 === 0) {
        const [x, z] = spotIn(pitch, rand);
        place(b, pitch, x, z);
        const yaw = rand() * Math.PI * 2;
        kickBall(b, kickFrom(yaw, rand() * 1.2 - 0.6, BALL.maxSpeed), 't');
      }
      const dt = steps[Math.floor(rand() * steps.length)];
      stepBall(b, pitch, dt);
      assert.ok(finite(b), `finite after dt ${dt}`);
      assert.ok(insidePitch(pitch, b.x, b.z), `inside after dt ${dt}`);
      assert.ok(b.y >= pitch.ground(b.x, b.z) + BALL.r - 1e-6, 'never under the ground');
      assert.ok(Math.hypot(b.vx, b.vy, b.vz) <= BALL.maxSpeed + 1e-9);
    }
  }
});

test('a broken state (NaN from anywhere) goes back to the middle instead of spreading', () => {
  const b = newBall(school);
  b.asleep = false;
  b.vx = NaN;
  const ev = stepBall(b, school, 1 / 60);
  assert.ok(finite(b));
  assert.equal(b.x, school.home.x);
  assert.ok(ev.some((e) => e.kind === 'home'));
});

test('a hard kick comes to rest and the ball goes to sleep', () => {
  const rand = rng(11);
  for (const pitch of [school, lawn]) {
    const b = newBall(pitch);
    for (let k = 0; k < 40; k++) {
      const [x, z] = spotIn(pitch, rand);
      place(b, pitch, x, z);
      kickBall(b, kickFrom(rand() * Math.PI * 2, rand() * 0.8 - 0.4, KICK.hard), 't');
      let t = 0;
      while (!b.asleep && t < 60) {
        stepBall(b, pitch, 1 / 30);
        t += 1 / 30;
      }
      assert.ok(b.asleep, `asleep within a minute (${pitch.id}, kick ${k})`);
      assert.equal(Math.hypot(b.vx, b.vy, b.vz), 0);
      if (b.netted <= 0) assert.ok(Math.abs(b.y - pitch.ground(b.x, b.z) - BALL.r) < 0.01, 'lying on the ground');
    }
  }
});

test('a sleeping ball with nobody near stays put and costs nothing', () => {
  const b = newBall(school);
  const before = JSON.stringify(b);
  for (let i = 0; i < 100; i++) stepBall(b, school, 0.05, [{ x0: b.x + 5, z0: b.z, x1: b.x + 5, z1: b.z + 0.1, feet: b.y - BALL.r, name: 'far' }]);
  assert.equal(JSON.stringify(b), before);
});

test('it stays inside the playground: thousands of kicks from everywhere, as hard and as steep as allowed', () => {
  const rand = rng(23);
  for (const pitch of [school, lawn]) {
    const b = newBall(pitch);
    for (let k = 0; k < 1500; k++) {
      const [x, z] = spotIn(pitch, rand);
      place(b, pitch, x, z, pitch.ground(x, z) + BALL.r + rand() * 1.5);
      const speed = rand() < 0.5 ? KICK.hard : BALL.maxSpeed;
      kickBall(b, kickFrom(rand() * Math.PI * 2, rand() * 1.6 - 0.8, speed), 't');
      for (let s = 0; s < 40; s++) {
        stepBall(b, pitch, rand() < 0.2 ? 0.1 : 1 / 60);
        assert.ok(insidePitch(pitch, b.x, b.z), `${pitch.id}: inside after kick ${k}`);
        if (b.asleep) break;
      }
    }
  }
});

test('never through a goal post, the crossbar or a net at the hardest kick, whatever the step', () => {
  const g = school.goals[1]; // the south goal
  for (const dt of [1 / 240, 1 / 60, 1 / 20, 0.1]) {
    for (const speed of [KICK.hard, BALL.maxSpeed]) {
      // Straight at a post from in front of it, at the height of the ball's middle on the ground and at 1 m.
      for (const [along, up] of [[g.half, 0], [-g.half, 0], [g.half, 1], [0, g.height]]) {
        const b = newBall(school);
        const tx = g.mx + g.ux * along, tz = g.mz + g.uz * along;
        // From close by, so the ball hasn't dropped under the bar by the time it gets there (it would go in off its underside).
        const sx = tx - g.nx * 0.8, sz = tz - g.nz * 0.8;
        const sy = up === 0 ? school.ground(sx, sz) + BALL.r : g.y + up;
        place(b, school, sx, sz, sy);
        kickBall(b, [g.nx * speed, 0, g.nz * speed], 't');
        let closest = Infinity;
        let wentIn = false;
        for (let t = 0; t < 1; t += dt) {
          const ev = stepBall(b, school, dt);
          if (ev.some((e) => e.kind === 'goal')) wentIn = true;
          const deep = (b.x - g.mx) * g.nx + (b.z - g.mz) * g.nz;
          closest = Math.min(closest, Math.hypot(b.x - tx, b.z - tz));
          assert.ok(deep < BALL.r + 0.05, `never past the post's line (along ${along}, up ${up}, dt ${dt}, ${speed} m/s): ${deep}`);
          if (up !== g.height) assert.ok(closest > 0.045 + BALL.r - 0.02, `never inside the post: ${closest}`);
        }
        assert.ok(!wentIn, 'no goal off the post or the bar');
      }
      // From the side into the side net (behind either goal there is no room for a ball to come from).
      {
        const b = newBall(school);
        const tx = g.mx + g.nx * 0.3 + g.ux * g.half, tz = g.mz + g.nz * 0.3 + g.uz * g.half;
        const sx = tx + g.ux * 3, sz = tz + g.uz * 3;
        place(b, school, sx, sz);
        kickBall(b, [-g.ux * speed, 0, -g.uz * speed], 't');
        let wentIn = false;
        for (let t = 0; t < 1; t += dt) {
          const ev = stepBall(b, school, dt);
          if (ev.some((e) => e.kind === 'goal')) wentIn = true;
          const along = (b.x - g.mx) * g.ux + (b.z - g.mz) * g.uz;
          assert.ok(along > g.half - 0.01 || (b.x - g.mx) * g.nx + (b.z - g.mz) * g.nz < 0, `never through the side net (dt ${dt}, ${speed} m/s)`);
        }
        assert.ok(!wentIn, 'no goal through the side net');
      }
    }
  }
});

test('a goal: through the mouth it counts once, rests in the net, then the ball is back in the middle', () => {
  for (const [gi, g] of school.goals.entries()) {
    const b = newBall(school);
    const sx = g.mx - g.nx * 6, sz = g.mz - g.nz * 6;
    place(b, school, sx, sz);
    kickBall(b, [g.nx * KICK.soft, 1.2, g.nz * KICK.soft], 'kid');
    const events = [];
    for (let t = 0; t < 5; t += 1 / 60) events.push(...stepBall(b, school, 1 / 60));
    const goals = events.filter((e) => e.kind === 'goal');
    assert.equal(goals.length, 1, `one goal in ${g.id}`);
    assert.equal(goals[0].goal, gi);
    assert.equal(b.score[gi], 1);
    assert.ok(events.some((e) => e.kind === 'home'), 'back in the middle');
    assert.equal(b.x, school.home.x);
    assert.equal(b.z, school.home.z);
    assert.ok(b.asleep);
  }
});

test('in the net it cannot be kicked out again; after it, it can', () => {
  const g = school.goals[0];
  const b = newBall(school);
  place(b, school, g.mx + g.nx * 0.5, g.mz + g.nz * 0.5);
  b.netted = 1;
  assert.equal(kickBall(b, [5, 0, 0], 'x'), false);
  b.netted = 0;
  assert.equal(kickBall(b, [5, 0, 0], 'x'), true);
});

test('walking into it pushes it ahead, a little faster than walking; a sprint pushes it further', () => {
  const rolled = (speed) => {
    const b = newBall(school);
    const feet = b.y - BALL.r;
    // Walk at `speed` along +x from 1 m behind the ball for a second.
    let x = b.x - 1;
    const z = b.z;
    let first = null;
    for (let t = 0; t < 1; t += 1 / 60) {
      const x1 = x + speed / 60;
      const ev = stepBall(b, school, 1 / 60, [{ x0: x, z0: z, x1, z1: z, feet, name: 'walker' }]);
      if (!first && ev.some((e) => e.kind === 'touch' && e.name === 'walker')) first = Math.hypot(b.vx, b.vz);
      x = x1;
      assert.ok(Math.hypot(b.x - x, b.z - z) >= BODY.r + BALL.r - 1e-6, 'never inside the player');
    }
    assert.ok(first !== null, 'touched');
    assert.equal(b.last, 'walker');
    return first;
  };
  const walk = rolled(1.4);
  const run = rolled(3.5);
  assert.ok(walk > 1.4 && walk < 2.2, `walking: ${walk}`);
  assert.ok(run > walk * 2, `running: ${run}`);
});

test('a player far above (on the play tower) or flying over it does not push it', () => {
  const b = newBall(school);
  const feet = b.y - BALL.r + 2.2;
  stepBall(b, school, 0.05, [{ x0: b.x - 0.3, z0: b.z, x1: b.x, z1: b.z, feet, name: 'up' }]);
  assert.ok(b.asleep);
});

test('reach: the kicker must be next to the ball, not far away, below or above it', () => {
  const b = newBall(school);
  const feet = b.y - BALL.r;
  assert.ok(inReach(b, b.x + 1, feet, b.z));
  assert.ok(!inReach(b, b.x + KICK.reach + 0.1, feet, b.z));
  assert.ok(inReach(b, b.x + KICK.reach + 0.1, feet, b.z, 0.5), 'the server allows for the delay');
  assert.ok(!inReach(b, b.x + 30, feet, b.z, 0.7));
  assert.ok(!inReach(b, b.x, feet + 3, b.z), 'from the tower');
  assert.ok(!inReach(b, b.x, feet - 3, b.z));
  assert.ok(!inReach(b, NaN, feet, b.z));
  assert.ok(!inReach(b, b.x, undefined, b.z));
});

test('a kick where you look: along the view, a little above it, never down; looking at the ball keeps it low', () => {
  const [vx, vy, vz] = kickFrom(0, 0, 10); // yaw 0 looks along -z
  assert.ok(vz < -9 && Math.abs(vx) < 1e-9 && vy > 0);
  assert.ok(Math.abs(Math.hypot(vx, vy, vz) - 10) < 1e-9);
  assert.equal(kickFrom(0, -1, 10)[1], 0, 'looking down at the ball: along the ground');
  const [, up] = kickFrom(Math.PI / 2, 1.4, 10);
  assert.ok(Math.abs(up - 10 * Math.sin(KICK.maxLift)) < 1e-9, 'never steeper than allowed');
});

test('a fair kick: numbers only, capped, never down into the ground or steeper than allowed', () => {
  assert.equal(fairKick(null, 9), null);
  assert.equal(fairKick('fast', 9), null);
  assert.equal(fairKick([1, 2], 9), null);
  assert.equal(fairKick([NaN, 0, 1], 9), null);
  assert.equal(fairKick([Infinity, 0, 1], 9), null);
  assert.equal(fairKick(['5', 0, 0], 9), null, 'text is no number');
  assert.equal(fairKick([null, 0, 1], 9), null, 'nor is null (what NaN becomes in JSON)');
  assert.equal(fairKick([0, 50, 0], 9), null, 'straight up is no kick');
  const big = fairKick([1e9, 1e9, 1e9], KICK.hard);
  assert.ok(Math.hypot(...big) <= KICK.hard + 1e-9);
  assert.ok(big[1] <= Math.hypot(big[0], big[2]) * Math.tan(KICK.maxLift) + 1e-9);
  const down = fairKick([5, -50, 0], 9);
  assert.equal(down[1], 0);
  const ok = fairKick([3, 1, 4], 9);
  assert.deepEqual(ok, [3, 1, 4]);
});

// FC Smetlede's pitch (shared/football.json): full-size goals, the ball kept inside the spectators' rail.
const fc = makePitch(PITCHES.find((p) => p.id === 'fc'), height);

test('the football ground: the ball waits on the penalty spot, inside the rail, on the levelled ground, both goals full size', () => {
  const b = newBall(fc);
  assert.ok(insidePitch(fc, b.x, b.z));
  assert.ok(Math.abs(b.y - (fc.ground(b.x, b.z) + BALL.r)) < 1e-9);
  assert.equal(fc.goals.length, 2);
  for (const g of fc.goals) {
    assert.ok(Math.abs(g.half * 2 - 7.32) < 1e-9);
    assert.equal(g.height, 2.44);
    assert.ok(insidePitch(fc, g.mx + g.nx * (g.depth + 0.1), g.mz + g.nz * (g.depth + 0.1)), `goal ${g.id}'s net fits inside the rail`);
    // The ground is level there (tools/terrain.py): the goal stands on the same ground as the penalty spot.
    assert.ok(Math.abs(g.y - fc.ground(fc.home.x, fc.home.z)) < 0.02, `goal ${g.id} on the level ground`);
  }
});

test('the football ground: a penalty goes in and counts once; hundreds of kicks stay inside the rail', () => {
  for (const [gi, g] of fc.goals.entries()) {
    const b = newBall(fc);
    place(b, fc, g.mx - g.nx * 11, g.mz - g.nz * 11);
    kickBall(b, [g.nx * KICK.hard, 2, g.nz * KICK.hard], 'kid');
    const events = [];
    for (let t = 0; t < 6; t += 1 / 60) events.push(...stepBall(b, fc, 1 / 60));
    const goals = events.filter((e) => e.kind === 'goal');
    assert.equal(goals.length, 1, `one goal in ${g.id}`);
    assert.equal(goals[0].goal, gi);
  }
  const rand = rng(7);
  const b = newBall(fc);
  for (let k = 0; k < 800; k++) {
    const [x, z] = spotIn(fc, rand);
    place(b, fc, x, z);
    kickBall(b, kickFrom(rand() * Math.PI * 2, rand() * 1.6 - 0.8, BALL.maxSpeed), 't');
    for (let s = 0; s < 60; s++) {
      stepBall(b, fc, 1 / 30);
      assert.ok(insidePitch(fc, b.x, b.z), `inside after kick ${k}`);
      if (b.asleep) break;
    }
  }
});
