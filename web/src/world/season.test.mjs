import test from 'node:test';
import assert from 'node:assert/strict';
import { brusselsDay, fakeDay, firstAdvent, parseDay, seasonNow, seasonOn, sinterklaasArrives } from './season.ts';

const on = (text) => seasonOn(parseDay(text));

test('Sinterklaas arrives on the first Saturday after 11 November', () => {
  assert.equal(sinterklaasArrives(2026), 14); // 11 November 2026 is a Wednesday
  assert.equal(sinterklaasArrives(2028), 18); // a Saturday itself: the next one
  assert.equal(sinterklaasArrives(2025), 15);
  for (let y = 2024; y < 2060; y++) {
    const d = sinterklaasArrives(y);
    assert.ok(d >= 12 && d <= 18);
    assert.equal(new Date(Date.UTC(y, 10, d)).getUTCDay(), 6);
  }
});

test('the first Sunday of Advent lies between 27 November and 3 December, four Sundays before Christmas', () => {
  assert.deepEqual(firstAdvent(2026), [11, 29]);
  assert.deepEqual(firstAdvent(2027), [11, 28]);
  assert.deepEqual(firstAdvent(2024), [12, 1]);
  assert.deepEqual(firstAdvent(2025), [11, 30]);
  for (let y = 2024; y < 2060; y++) {
    const [m, d] = firstAdvent(y);
    const date = new Date(Date.UTC(y, m - 1, d));
    assert.equal(date.getUTCDay(), 0);
    assert.ok((m === 11 && d >= 27) || (m === 12 && d <= 3));
    assert.equal((Date.UTC(y, 11, 25) - date) / 86400000 >= 22 && (Date.UTC(y, 11, 25) - date) / 86400000 <= 28, true);
  }
});

test('Sinterklaas from his arrival up to and with 6 December', () => {
  assert.equal(on('2026-11-13').sinterklaas, false);
  assert.equal(on('2026-11-14').sinterklaas, true);
  assert.equal(on('2026-11-30').sinterklaas, true);
  assert.equal(on('2026-12-06').sinterklaas, true);
  assert.equal(on('2026-12-07').sinterklaas, false);
  assert.equal(on('2026-10-20').sinterklaas, false);
  assert.equal(on('2027-01-02').sinterklaas, false);
});

test('Christmas from the first Sunday of Advent up to and with 6 January', () => {
  assert.equal(on('2026-11-28').christmas, false);
  assert.equal(on('2026-11-29').christmas, true);
  assert.equal(on('2026-12-25').christmas, true);
  assert.equal(on('2026-12-31').christmas, true);
  assert.equal(on('2027-01-06').christmas, true);
  assert.equal(on('2027-01-07').christmas, false);
  assert.equal(on('2024-11-30').christmas, false); // Advent began on 1 December that year
  assert.equal(on('2024-12-01').christmas, true);
  assert.equal(on('2026-07-01').christmas, false);
  // Both at once in the days between
  assert.deepEqual(on('2026-12-02'), { sinterklaas: true, christmas: true });
});

test('the day is the one in Brussels', () => {
  // 23:30 UTC on 6 December is already the 7th in Brussels (UTC+1 in winter)
  assert.deepEqual(brusselsDay(new Date(Date.UTC(2026, 11, 6, 23, 30))), { y: 2026, m: 12, d: 7 });
  assert.deepEqual(brusselsDay(new Date(Date.UTC(2026, 11, 6, 22, 30))), { y: 2026, m: 12, d: 6 });
});

test('a pretended day, and back to today', () => {
  assert.deepEqual(fakeDay('2026-12-01'), { sinterklaas: true, christmas: true });
  assert.deepEqual(fakeDay('2026-08-01'), { sinterklaas: false, christmas: false });
  assert.deepEqual(fakeDay('2027-01-05T10:00'), { sinterklaas: false, christmas: true });
  fakeDay(null);
  assert.deepEqual(seasonNow(), seasonOn(brusselsDay(new Date())));
  assert.equal(parseDay('nonsense'), null);
  assert.equal(parseDay('2026-13-01'), null);
});
