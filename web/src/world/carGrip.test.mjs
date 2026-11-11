import test from 'node:test';
import assert from 'node:assert/strict';
import { ABS_CAP, G, MASS, PEAK_SLIP, surfaceGrip, tyreForces } from './carGrip.ts';

const rolling = { u: 20, s: 0, r: 0, delta: 0, drive: 0, brake: 0, locked: false, muF: 1, muR: 1, ax: 0 };

test('grip by surface: asphalt best, then cobbles, gravel, grass; less when wet or under snow', () => {
  const dry = surfaceGrip('road', 0, 0);
  assert.equal(dry, 1);
  assert.ok(surfaceGrip('road', 1, 0) < 0.9 && surfaceGrip('road', 1, 0) > 0.8, 'wet asphalt about 0.86: a little less than dry, not ice');
  assert.ok(surfaceGrip('old_stone', 0, 0) < dry);
  assert.ok(surfaceGrip('gravel', 0, 0) < surfaceGrip('old_stone', 0, 0));
  assert.ok(surfaceGrip(undefined, 0, 0) < surfaceGrip('gravel', 0, 0), 'the bare ground is grass');
  assert.ok(surfaceGrip('field_soil', 0, 0) < 0.6);
  assert.ok(surfaceGrip('road', 0, 1) < 0.6, 'snow');
  for (const x of [NaN, Infinity, -1, 5]) assert.ok(Number.isFinite(surfaceGrip('road', x, x)) && surfaceGrip('road', x, x) > 0);
});

test('ABS: full braking holds each axle under its grip, and a turned wheel still pulls the car round', () => {
  const t = tyreForces({ ...rolling, brake: 2 * MASS * G });
  assert.ok(-t.fx / MASS <= ABS_CAP * G + 1e-6 && -t.fx / MASS > 0.85 * G, `about 0.9 g at most (${-t.fx / MASS})`);
  const steered = tyreForces({ ...rolling, brake: 2 * MASS * G, delta: 0.15 });
  assert.ok(steered.fy > 0.2 * MASS * G, `the front still grips sideways under full braking (${steered.fy / MASS / G} g)`);
  assert.ok(steered.mz > 0, 'and turns the car to the right');
  const wet = tyreForces({ ...rolling, brake: 2 * MASS * G, muF: 0.7, muR: 0.7 });
  assert.ok(wet.fx > t.fx * 0.75, 'less on a wet road');
});

test('the handbrake locks the rear: it slides whichever way the rear goes, and pulls the back out of line', () => {
  const t = tyreForces({ ...rolling, locked: true });
  assert.ok(t.fx < -0.25 * MASS * G, 'it brakes');
  assert.equal(t.slideR, 20, 'the rear slides at the car\'s speed');
  assert.equal(t.slideF, 0);
  // The rear moving out to the left (the car turning right): a locked rear holds it far less than a rolling one.
  const turning = { ...rolling, r: 0.5, s: 0, delta: 0.1 };
  const held = tyreForces(turning);
  const free = tyreForces({ ...turning, locked: true });
  assert.ok(free.mz > held.mz, `with the rear locked it turns harder (${free.mz} > ${held.mz})`);
});

test('the tyres let go past their peak: understeer at the limit, and finite at any input', () => {
  const at = (a) => tyreForces({ ...rolling, delta: a }).fy;
  assert.ok(at(PEAK_SLIP) > at(PEAK_SLIP * 3), 'past the peak it grips less');
  assert.ok(at(PEAK_SLIP * 3) > 0.7 * at(PEAK_SLIP), 'but not much less: it slides, it doesn\'t let go at once');
  assert.ok(tyreForces({ ...rolling, delta: PEAK_SLIP * 2 }).slideF > 0, 'sliding past it');
  assert.equal(tyreForces({ ...rolling, delta: PEAK_SLIP * 0.3 }).slideF, 0, 'gripping under it');
  for (const v of [NaN, Infinity, -Infinity, 0, -30, 1e9]) {
    const t = tyreForces({ u: v, s: v, r: v, delta: v, drive: v, brake: v, locked: v > 0, muF: v, muR: v, ax: v });
    assert.ok([t.fx, t.fy, t.mz, t.slideF, t.slideR, t.roll].every(Number.isFinite), `finite for ${v}`);
  }
});

test('the weight moves forward under braking: the front grips more, the rear less', () => {
  const braking = { ...rolling, delta: 0.08, r: 0, ax: -8 };
  const level = tyreForces({ ...rolling, delta: 0.08 });
  const dived = tyreForces(braking);
  assert.ok(dived.mz > level.mz, 'a braked car turns in harder (lift-off and trail-braking oversteer)');
});
