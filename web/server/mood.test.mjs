import assert from 'node:assert/strict';
import test from 'node:test';
import { Game } from './game.mjs';
import {
  BLEND_MS, canFollow, CHOICES, cycleTime, DEFAULT_CHOICE, isCycle, MoodCycle, MOODS, newCycle, runOf, SNOW_BUILD_MS, SPEEDS, winterAt,
} from '../shared/moods.mjs';

// The weather and time of day for everyone (shared/moods.mjs): only the admin sets it, only from the fixed list,
// at most once a second, and everyone who joins later is told it, with the cycle that 'auto' follows.
function setup() {
  const game = new Game({ session: () => null }, []);
  const told = [];
  game.broadcast = (m) => told.push(m);
  const player = (name, role = 'player') => {
    const p = {
      key: `k-${name}`, role, alive: true, state: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, armed: false, flying: false, w: 'pistol', c: false },
      weapons: new Set(['pistol']), nades: [], window: Date.now(), msgs: 0, states: 0, others: 0,
    };
    game.players.set(name, p);
    return p;
  };
  const send = (name, p, m) => game.handle(name, p, JSON.stringify(m));
  return { game, told, player, send };
}

test('the choice starts as auto, with a cycle of its own', () => {
  const { game } = setup();
  assert.equal(game.mood, DEFAULT_CHOICE);
  assert.equal(game.mood, 'auto');
  assert.ok(Number.isInteger(game.moodCycle.seed) && game.moodCycle.seed >= 0 && game.moodCycle.seed < 2 ** 32);
  assert.ok(Math.abs(game.moodCycle.at - Date.now()) < 5000);
  assert.equal(game.moodCycle.tau, 0);
  assert.equal(game.moodCycle.speed, 1);
  assert.equal(game.moodCycle.winter, winterAt(Date.now()), "snow on Auto by the server's date");
  assert.equal(game.moodCycle.first, 'sunny');
  assert.ok(isCycle(game.moodCycle));
});

test('a player who is not the admin cannot set the mood (forged admin message)', () => {
  const { game, told, player, send } = setup();
  const guest = player('guest');
  const plain = player('plain', 'guest');
  for (const [name, p] of [['guest', guest], ['plain', plain]]) {
    for (const mood of CHOICES) {
      p.nextMood = 0;
      send(name, p, { t: 'mood', mood });
      // A forged role field in the message counts for nothing: the role is the session's.
      send(name, p, { t: 'mood', mood, role: 'admin' });
    }
  }
  assert.equal(game.mood, DEFAULT_CHOICE);
  assert.equal(told.length, 0, 'nothing is told to anyone');
});

test('the admin sets a mood or auto from the list; everyone is told, with who set it and the cycle', () => {
  const { game, told, player, send } = setup();
  const admin = player('root', 'admin');
  send('root', admin, { t: 'mood', mood: 'rain' });
  assert.equal(game.mood, 'rain');
  assert.equal(told.length, 1);
  assert.equal(told[0].t, 'mood');
  assert.equal(told[0].mood, 'rain');
  assert.equal(told[0].by, 'root');
  assert.deepEqual(told[0].cycle, game.moodCycle);
  assert.ok(MOODS.includes(told[0].cycleNow.mood) && MOODS.includes(told[0].cycleNow.next));
  admin.nextMood = 0;
  send('root', admin, { t: 'mood', mood: 'auto' });
  assert.equal(game.mood, 'auto');
  assert.equal(told.length, 2);
  // Dusk and snow too, snow whatever the date (by hand it is always there).
  for (const mood of ['dusk', 'snow']) {
    admin.nextMood = 0;
    send('root', admin, { t: 'mood', mood });
    assert.equal(game.mood, mood);
    assert.equal(told.at(-1).mood, mood);
  }
  assert.equal(told.length, 4);
});

test('anything not on the list is refused and changes nothing', () => {
  const { game, told, player, send } = setup();
  const admin = player('root', 'admin');
  const bad = ['', 'Sunny', 'RAIN', 'Auto', 'Snow', 'DUSK', 'dusk ', ' snow', 'winter', 'fog', 'night ', 'toString', '__proto__', 'constructor', null, 1, true, {}, [], ['rain'], { toString: 'rain' }, 'x'.repeat(5000)];
  for (const mood of bad) {
    admin.nextMood = 0;
    admin.msgs = admin.others = 0;
    send('root', admin, { t: 'mood', mood });
  }
  admin.nextMood = 0;
  send('root', admin, { t: 'mood' }); // no value at all
  assert.equal(game.mood, DEFAULT_CHOICE);
  assert.equal(told.length, 0);
});

test('at most one change a second per admin (message flood), and the same choice again tells nobody', () => {
  const { game, told, player, send } = setup();
  const admin = player('root', 'admin');
  send('root', admin, { t: 'mood', mood: 'night' });
  for (let i = 0; i < 20; i++) send('root', admin, { t: 'mood', mood: CHOICES[i % CHOICES.length] });
  assert.equal(game.mood, 'night', 'the flood within the second changed nothing');
  assert.equal(told.length, 1);
  admin.nextMood = 0; // a second later
  send('root', admin, { t: 'mood', mood: 'night' });
  assert.equal(told.length, 1, 'the same mood again is not told');
  admin.nextMood = 0;
  send('root', admin, { t: 'mood', mood: 'overcast' });
  assert.equal(game.mood, 'overcast');
  assert.equal(told.length, 2);
});

test('a player who joins later is told the choice and the cycle in the welcome', () => {
  const { game, player, send } = setup();
  const admin = player('root', 'admin');
  send('root', admin, { t: 'mood', mood: 'night' });
  game.players.delete('root'); // the fixture's admin has no scores; the welcome lists everyone's
  const sent = [];
  game.send = (_ws, m) => sent.push(m);
  game.auth = { session: () => null, log: () => {}, addressOf: () => '127.0.0.1' };
  const ws = { readyState: 1, OPEN: 1, send() {}, on() {}, close() {} };
  game.join(ws, { username: 'late', role: 'guest', key: 'k-late' }, { headers: {}, socket: {} });
  const welcome = sent.find((m) => m.t === 'welcome');
  assert.ok(welcome);
  assert.equal(welcome.mood, 'night');
  assert.deepEqual(welcome.moodCycle.cycle, game.moodCycle);
  assert.ok(Number.isFinite(welcome.moodCycle.time));
});

test('"Next weather" and the pace: refused from anyone but the admin (forged admin message)', () => {
  const { game, told, player, send } = setup();
  const guest = player('guest', 'guest');
  const before = { ...game.moodCycle };
  for (let i = 0; i < 5; i++) {
    guest.nextMood = guest.nextMoodSkip = 0;
    send('guest', guest, { t: 'moodskip' });
    send('guest', guest, { t: 'moodspeed', speed: 60 });
    send('guest', guest, { t: 'moodskip', role: 'admin' });
  }
  assert.deepEqual(game.moodCycle, before);
  assert.equal(told.length, 0);
});

test('"Next weather": the mood ends now and the usual blend begins; once every five seconds, only on Auto, not mid-change', () => {
  const { game, told, player, send } = setup();
  const admin = player('root', 'admin');
  send('root', admin, { t: 'moodskip' });
  assert.equal(told.length, 1);
  assert.equal(told[0].op, 'skip');
  const s = told[0].cycleNow;
  assert.equal(s.blend, 0);
  const tau = cycleTime(game.moodCycle, told[0].time);
  assert.ok(Math.abs(s.until - BLEND_MS - tau) < 50, 'the blend starts now');
  send('root', admin, { t: 'moodskip' }); // within five seconds
  assert.equal(told.length, 1);
  // A little later the blend is under way: nothing to skip.
  game.moodCycle = { ...game.moodCycle, tau: game.moodCycle.tau + 10_000 };
  admin.nextMoodSkip = 0;
  send('root', admin, { t: 'moodskip' });
  assert.equal(told.length, 1);
  // A fixed mood: no skipping.
  admin.nextMood = 0;
  send('root', admin, { t: 'mood', mood: 'rain' });
  admin.nextMoodSkip = 0;
  const fixed = { ...game.moodCycle };
  send('root', admin, { t: 'moodskip' });
  assert.deepEqual(game.moodCycle, fixed);
});

test('the pace: only 1, 10 or 60, only on Auto, back to 1 on a fixed mood and when the last admin leaves', () => {
  const { game, told, player, send } = setup();
  const admin = player('root', 'admin');
  for (const speed of ['10', 5, 0, -1, 2, 1e9, NaN, null, [60], { speed: 60 }]) {
    admin.nextMood = 0;
    send('root', admin, { t: 'moodspeed', speed });
  }
  assert.equal(game.moodCycle.speed, 1);
  assert.equal(told.length, 0);
  assert.ok(SPEEDS.includes(60));
  admin.nextMood = 0;
  send('root', admin, { t: 'moodspeed', speed: 60 });
  assert.equal(game.moodCycle.speed, 60);
  assert.equal(told.at(-1).op, 'speed');
  send('root', admin, { t: 'moodspeed', speed: 10 }); // within the second
  assert.equal(game.moodCycle.speed, 60);
  admin.nextMood = 0;
  send('root', admin, { t: 'mood', mood: 'night' });
  assert.equal(game.moodCycle.speed, 1, 'a fixed mood sets the pace back');
  admin.nextMood = 0;
  send('root', admin, { t: 'moodspeed', speed: 60 });
  assert.equal(game.moodCycle.speed, 1, 'no pace for a fixed mood');
  admin.nextMood = 0;
  send('root', admin, { t: 'mood', mood: 'auto' });
  admin.nextMood = 0;
  send('root', admin, { t: 'moodspeed', speed: 10 });
  assert.equal(game.moodCycle.speed, 10);
  game.players.delete('root');
  game.moodAdminLeft(Date.now());
  assert.equal(game.moodCycle.speed, 1, 'the last admin left');
});

/** The minutes each mood holds (shared/moods.mjs MINUTES). */
const HOLDS = { sunny: [10, 10], overcast: [10, 10], rain: [10, 10], dusk: [10, 10], night: [10, 10], snow: [10, 10] }; // every 10 minutes (Yoshi, 8 Nov 2026)

/** Walk a cycle for `days` in steps of `step` ms: check the rules on the way, count the moods that came. */
function walk(seed, winter, days = 3, step = 30_000) {
  const a = new MoodCycle(seed, 1000, { winter });
  const b = new MoodCycle(seed, 1000, { winter });
  const seen = Object.fromEntries(MOODS.map((m) => [m, 0]));
  let last = a.at(1000);
  assert.equal(last.mood, 'sunny', 'it starts sunny');
  let from = 1000;
  for (let t = 1000; t < 1000 + days * 24 * 3600_000; t += step) {
    const s = a.at(t);
    assert.deepEqual(s, b.at(t), 'the same seed gives the same weather');
    assert.ok(s.blend >= 0 && s.blend <= 1 && s.wet >= 0 && s.wet <= 1 && s.snow >= 0 && s.snow <= 1 && s.progress >= 0 && s.progress <= 1);
    assert.notEqual(s.mood, s.next);
    assert.ok(canFollow(s.mood, winter).includes(s.next), `${s.mood} to ${s.next}`);
    if (!winter) assert.ok(s.mood !== 'snow' && s.next !== 'snow' && s.snow === 0, 'no snow out of winter');
    if (s.blend > 0) assert.ok(s.until - t <= BLEND_MS, 'the blend is the last part of a mood');
    // The snow lying changes slowly: never more than a step's worth of building up.
    assert.ok(Math.abs(s.snow - last.snow) <= (step / SNOW_BUILD_MS) * 1.01 + 1e-9, `snow ${last.snow} to ${s.snow}`);
    if (s.mood !== last.mood) {
      const minutes = (t - from) / 60_000;
      const [lo, hi] = HOLDS[last.mood];
      assert.ok(minutes >= lo - 1 && minutes <= hi + 1, `${last.mood} held ${minutes} minutes`);
      assert.equal(s.mood, last.next);
      seen[s.mood]++;
      from = t;
    }
    last = s;
  }
  return seen;
}

test('the cycle: slow, the same from the same seed, never the same mood twice, dusk always before the night', () => {
  // The rules themselves: never noon straight to night, the night only after dusk and dusk only into the night,
  // the morning after the night never sunny or dusk, snow never straight out of the sun and only in winter.
  for (const winter of [false, true]) {
    for (const m of MOODS) {
      const next = canFollow(m, winter);
      assert.ok(next.length > 0 && !next.includes(m));
      if (m !== 'dusk') assert.ok(!next.includes('night'), `${m} straight to night`);
    }
    assert.deepEqual(canFollow('dusk', winter), ['night']);
    assert.ok(!canFollow('night', winter).includes('sunny') && !canFollow('night', winter).includes('dusk'));
    assert.ok(!canFollow('sunny', winter).includes('snow'));
    assert.equal(MOODS.some((m) => canFollow(m, winter).includes('snow')), winter);
  }
  const seen = Object.fromEntries(MOODS.map((m) => [m, 0]));
  for (let seed = 1; seed < 40; seed++) for (const [m, n] of Object.entries(walk(seed, false))) seen[m] += n;
  assert.ok(seen.sunny > seen.overcast && seen.overcast > seen.rain && seen.rain > seen.dusk, JSON.stringify(seen));
  assert.ok(Math.abs(seen.dusk - seen.night) <= 39, `every night after a dusk: ${JSON.stringify(seen)}`);
  assert.equal(seen.snow, 0);
  // Read back: it starts again and agrees.
  const c = new MoodCycle(7, 0);
  const later = c.at(10 * 3600_000);
  assert.deepEqual(c.at(5 * 3600_000), new MoodCycle(7, 0).at(5 * 3600_000));
  assert.deepEqual(c.at(10 * 3600_000), later);
});

test('snow on Auto: only in winter, and seldom; it builds up slowly while it falls and melts slowly after', () => {
  const seen = Object.fromEntries(MOODS.map((m) => [m, 0]));
  for (let seed = 1; seed < 40; seed++) for (const [m, n] of Object.entries(walk(seed, true))) seen[m] += n;
  assert.ok(seen.snow > 0, 'it snows now and then in winter');
  assert.ok(seen.snow < seen.rain && seen.snow < seen.dusk, `not too often: ${JSON.stringify(seen)}`);
  // Find a snowfall and follow the snow lying through it.
  let found = false;
  for (let seed = 1; seed < 200 && !found; seed++) {
    const c = new MoodCycle(seed, 0, { winter: true });
    for (let t = 0; t < 3 * 24 * 3600_000; t += 60_000) {
      const s = c.at(t);
      if (s.mood !== 'snow' || s.progress > 0.01) continue;
      found = true;
      const start = s.snow;
      assert.ok(start > 0 && start < 0.6, `it began with the blend, a little: ${start}`);
      const mid = c.at(s.until - BLEND_MS);
      assert.ok(mid.snow > 0.95, `white before it stops: ${mid.snow}`);
      const after = c.at(s.until + 5 * 60_000);
      assert.ok(after.mood !== 'snow' && after.snow > 0.4 && after.snow < mid.snow, `melting slowly: ${after.snow}`);
      // Gone an hour later, unless it snowed again in that hour (with a change every 10 minutes it may).
      let again = false;
      for (let u = s.until; u <= s.until + 60 * 60_000; u += 60_000) {
        const w = new MoodCycle(seed, 0, { winter: true }).at(u);
        if (w.mood === 'snow' || w.next === 'snow') again = true;
      }
      const gone = c.at(s.until + 60 * 60_000);
      assert.ok(again || gone.snow < 0.01, `gone an hour later: ${gone.snow}`);
      break;
    }
  }
  assert.ok(found);
});

test('winter by the Belgian date: December to February, from midnight in Brussels', () => {
  assert.equal(winterAt(Date.UTC(2026, 10, 30, 22, 59)), false, '30 November, 23:59 in Brussels');
  assert.equal(winterAt(Date.UTC(2026, 10, 30, 23, 1)), true, '1 December, 00:01 in Brussels');
  assert.equal(winterAt(Date.UTC(2027, 0, 15, 12)), true);
  assert.equal(winterAt(Date.UTC(2027, 1, 28, 22, 59)), true, '28 February, 23:59 in Brussels');
  assert.equal(winterAt(Date.UTC(2027, 1, 28, 23, 1)), false, '1 March, 00:01 in Brussels');
  assert.equal(winterAt(Date.UTC(2026, 6, 1)), false);
});

test("the server's cycle follows its date: the season turns into a new cycle from the mood shown, told to everyone", () => {
  const { game, told } = setup();
  const november = Date.UTC(2026, 10, 7, 12);
  const december = Date.UTC(2026, 11, 2, 12);
  game.moodCycle = newCycle(12345, november - 60_000, false);
  game.moodRun = runOf(game.moodCycle);
  // Still November: nothing changes.
  game.moodSeason(november);
  assert.equal(told.length, 0);
  // December: snow may come now. A new cycle, going on in the mood shown.
  game.moodCycle = { ...game.moodCycle, at: december - 60_000 };
  const shown = game.moodRun.at(cycleTime(game.moodCycle, december));
  assert.equal(shown.blend, 0);
  game.moodSeason(december);
  assert.equal(told.length, 1);
  assert.equal(told[0].op, 'season');
  assert.equal(told[0].by, undefined, 'the server, not a player');
  assert.equal(game.moodCycle.winter, true);
  assert.equal(game.moodCycle.first, shown.mood, 'it goes on in the mood shown');
  assert.equal(told[0].cycleNow.mood, shown.mood);
  assert.ok(isCycle(told[0].cycle));
  // Again: the season is the same now.
  game.moodSeason(december + 60_000);
  assert.equal(told.length, 1);
  // While a change is under way it waits.
  const s = runOf(game.moodCycle).at(0);
  game.moodCycle = { ...game.moodCycle, winter: false, tau: s.until - BLEND_MS / 2, at: december };
  game.moodRun = runOf(game.moodCycle);
  game.moodSeason(december);
  assert.equal(told.length, 1, 'not in the middle of a blend');
});
