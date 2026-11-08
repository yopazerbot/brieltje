import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBounds } from '../../shared/bounds.mjs';
import { Horde, makeNav, MAX_ADMIN_WAVE } from '../../shared/zombies.mjs';
import { chooseSoloWave, soloRecord } from './soloWave.ts';

const nav = makeNav({ prisms: [], height: () => 0, edge: makeBounds([[-40, -40], [40, -40], [40, 40], [-40, 40]]) });
const soloRun = (best = 0) => {
  const horde = new Horde(nav, nav.spawnSpots(), { home: { x: 0, z: 0 } });
  horde.start(0);
  return { horde, custom: false, best };
};

test('alone, a chosen wave starts at once and makes the run custom', () => {
  const run = soloRun(3);
  const events = chooseSoloWave(run, 10, 1_000);
  assert.ok(events?.some((e) => e.type === 'wave' && e.wave === 10));
  assert.equal(run.horde.wave, 10);
  assert.equal(run.horde.phase, 'wave');
  assert.equal(run.custom, true);
});

test('alone, a run with a chosen wave never becomes the best, with or without a best before', () => {
  for (const best of [0, 5, 40]) {
    const run = soloRun(best);
    chooseSoloWave(run, 25, 1_000);
    assert.equal(soloRecord(run, 30), false);
  }
});

test('alone, a normal run still sets a new best above the old one only', () => {
  assert.equal(soloRecord(soloRun(0), 1), true);
  assert.equal(soloRecord(soloRun(5), 6), true);
  assert.equal(soloRecord(soloRun(5), 5), false);
});

test('alone, a refused wave leaves the run as it was', () => {
  for (const wave of [0, -1, 2.5, MAX_ADMIN_WAVE + 1, NaN]) {
    const run = soloRun(4);
    assert.equal(chooseSoloWave(run, wave, 1_000), null);
    assert.equal(run.custom, false);
    assert.equal(run.horde.wave, 0);
  }
});
