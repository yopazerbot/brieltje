import test from 'node:test';
import assert from 'node:assert/strict';
import { along, buildPath, FLIGHT, flightNow, flightPhase, flightPoints, PARK, pointAt } from './santaFlight.ts';

const path = buildPath();

test('the flight starts and ends on the parking spot, on the ground', () => {
  const a = pointAt(path, 0);
  const b = pointAt(path, path.total);
  for (const p of [a, b]) {
    assert.ok(Math.hypot(p.x - PARK.x, p.z - PARK.z) < 1e-6);
    assert.equal(p.h, 0);
  }
});

test('it leaves and comes back facing the way the sleigh is parked', () => {
  const fx = Math.sin(PARK.yaw);
  const fz = Math.cos(PARK.yaw);
  const out = pointAt(path, 3);
  const back = pointAt(path, path.total - 3);
  assert.ok(((out.x - PARK.x) * fx + (out.z - PARK.z) * fz) / Math.hypot(out.x - PARK.x, out.z - PARK.z) > 0.95);
  assert.ok(((PARK.x - back.x) * fx + (PARK.z - back.z) * fz) / Math.hypot(back.x - PARK.x, back.z - PARK.z) > 0.95);
});

test('high over the village: never below the square, 60 m and up for most of the way, never above 120 m', () => {
  let high = 0;
  const n = 400;
  for (let i = 0; i <= n; i++) {
    const p = pointAt(path, (path.total * i) / n);
    assert.ok(p.h >= 0 && p.h <= 120, `h ${p.h}`);
    if (p.h >= 60) high++;
  }
  assert.ok(high / n > 0.6, `share above 60 m ${high / n}`);
  // Nearly straight up and down at the square: 15 m along the way it is over the roofs, and still within 8 m of its spot.
  for (const s of [15, path.total - 15]) {
    const p = pointAt(path, s);
    assert.ok(p.h > 11, `at ${s}: ${p.h}`);
    assert.ok(Math.hypot(p.x - PARK.x, p.z - PARK.z) < 8, `at ${s}: ${Math.hypot(p.x - PARK.x, p.z - PARK.z)} m out`);
  }
  // Never near the church tower (its belfry at 534.5, -734.95: world/roadLife.ts) below 60 m.
  for (let i = 0; i <= n; i++) {
    const p = pointAt(path, (path.total * i) / n);
    if (p.h < 60) assert.ok(Math.hypot(p.x - 534.5, p.z + 734.95) > 18, `near the tower at ${p.x}, ${p.z}, ${p.h} m`);
  }
});

test('an even pace: speeding up, cruising and slowing down without a jump', () => {
  assert.equal(along(0), 0);
  assert.equal(along(1), 1);
  let prev = 0;
  for (let i = 1; i <= 1000; i++) {
    const v = along(i / 1000);
    assert.ok(v >= prev);
    assert.ok(v - prev < 0.0015);
    prev = v;
  }
  // The cruising speed is believable for the line's length and the time.
  const cruise = (path.total / FLIGHT.seconds) * (along(0.5 + 1e-3) - along(0.5)) / 1e-3;
  assert.ok(cruise > 10 && cruise < 25, `cruise ${cruise} m/s`);
});

test('the windows repeat on the clock, with boarding before and resting after', () => {
  const { period, offset, board, seconds, rest } = FLIGHT;
  const t0 = 1_800_000_000 - (1_800_000_000 % period) + offset;
  assert.deepEqual(flightNow(t0), { t: 0, start: t0 });
  assert.equal(flightNow(t0 - board + 0.5).start, t0);
  assert.equal(flightNow(t0 - board - 0.5).start, t0 - period);
  assert.equal(flightPhase(flightNow(t0 - board - 1).t), 'parked');
  assert.equal(flightPhase(flightNow(t0 - 5).t), 'boarding');
  assert.equal(flightPhase(flightNow(t0 + 30).t), 'flying');
  assert.equal(flightPhase(flightNow(t0 + seconds + 2).t), 'landed');
  assert.equal(flightPhase(flightNow(t0 + seconds + rest + 1).t), 'parked');
  assert.ok(board + seconds + rest < period);
  assert.equal(flightPoints().length > 10, true);
});
