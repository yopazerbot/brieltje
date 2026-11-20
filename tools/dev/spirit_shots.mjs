// The Brook Spirit's fight on the page, headless (tools/dev/cdp.mjs), on a running dev server (window.briel.spirit).
//
//   node tools/dev/spirit_shots.mjs [--url http://localhost:5200/] [--port 9500] [--out <folder>] [--night]
//        [--quality high] [--phone] [--swiftshader] [--size 1600x900] [--quick] [--minutes 20]
//   node tools/dev/spirit_shots.mjs --together [--out <folder>]     the page against a fake server feed
//   node tools/dev/spirit_shots.mjs --sound                        every sound by numbers (no ears needed)
//   node tools/dev/spirit_shots.mjs --bench [--quality high,low]   what the fight's drawing costs, A/B alternating
//
// The fight: alone, a simple scripted player stands you in the grove with the rifle, keeps out of the sweep's reach,
// walks out of every lane, ring and pool it sees coming, shoots the open heart and the lit lights through the game's
// own weapon code (briel.fire), walks off once to let it mend, and plays on until the spirit comes apart; then it
// walks into the grenade launcher left lying there and fires it. It prints the fight's length (the fight's own clock,
// without the pauses for pictures), how often you went down, and the launcher's grenades before and after.
// --out takes a picture of each state the first time it shows (with --night a second one at night): the fight's clock
// is held for the picture. --quick starts it near its marks (health set by hand) for the short runs (Low, a phone).
// Keep --out outside the repository.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5200/', port: '9500', out: '', night: false, quality: 'high', phone: false, swiftshader: false, size: '1600x900', quick: false, minutes: '20', together: false, sound: false, hits: false, tells: false, moods: '', bench: false, frames: '120', runs: '4' });
const [width, height] = o.size.split('x').map(Number);
if (o.out) mkdirSync(o.out, { recursive: true });
const b = await launch({ port: Number(o.port), width, height, swiftshader: o.swiftshader });
const log = (...a) => console.log(...a);
log('browser pid', b.pid);
const G = { x: -68, z: 488 };

/** The scripted player, in the page: one step every 50 ms while `__bot.on`; it never moves while the fight is held. */
const BOT = String.raw`(() => {
  const B = briel, S = B.spirit, P = B.player, W = B.weapon;
  const trunks = S.fight.trunks;
  const ground = (x, z) => B.world.groundAt(x, z, -4, 0).y;
  const bot = { on: true, hp: 100, hurt: {}, hits: [], dodging: false, act: '', tell: '', downs: 0, wasAlive: true, shots: 0, away: 0, mended: false, angle: 0, lastHp: 0, stuck: 0, log: [] };
  const free = (x, z) => trunks.every((t) => Math.hypot(t.x - x, t.z - z) > t.r + 0.55);
  function stepTo(tx, tz, dt) {
    const dx = tx - P.x, dz = tz - P.z, d = Math.hypot(dx, dz);
    if (d < 0.05) return [P.x, P.z];
    const s = Math.min(d, 3.5 * dt);
    let nx = P.x + (dx / d) * s, nz = P.z + (dz / d) * s;
    // Round a trunk: to the side, the other side, or back a step.
    for (const [ax, az] of [[dx, dz], [-dz, dx], [dz, -dx], [-dx + dz, -dz - dx]]) {
      const l = Math.hypot(ax, az) || 1;
      nx = P.x + (ax / l) * s;
      nz = P.z + (az / l) * s;
      if (free(nx, nz)) return [nx, nz];
    }
    return [P.x, P.z];
  }
  function tick() {
    if (!bot.on) return;
    const st = S.state();
    if (st.held) return;
    const sim = st.sim;
    const alive = B.combat.alive;
    if (!alive && bot.wasAlive) { bot.downs++; bot.log.push('down at ' + Math.round(st.clock / 1000) + ' s'); }
    // What hurt it: the act just before each loss of health (sweep, bolt, pool).
    if (sim.act !== bot.act) { if (['sweep', 'bolt', 'pool'].includes(sim.act)) bot.tell = sim.act; bot.act = sim.act; }
    const hp = B.combat.hp;
    if (alive && hp < bot.hp) {
      const k = sim.pools.length && sim.pools.some((p) => Math.hypot(P.x - p.x, P.z - p.z) < 2.6) ? 'pool' : bot.tell;
      bot.hurt[k] = (bot.hurt[k] ?? 0) + (bot.hp - hp);
      if (bot.hits.length < 80) bot.hits.push({ t: Math.round(st.clock / 100) / 10, d: bot.hp - hp, k, act: sim.act, me: [+P.x.toFixed(1), +P.z.toFixed(1)], pools: sim.pools.map((p) => +Math.hypot(P.x - p.x, P.z - p.z).toFixed(1)), bolts: (bot.prevBolts ?? []).map((b) => +Math.hypot(P.x - b.x, P.z - b.z).toFixed(1)), dodging: bot.dodging });
    }
    bot.hp = alive ? hp : 100;
    bot.prevBolts = sim.bolts.length ? sim.bolts.map((b) => ({ ...b })) : bot.prevBolts;
    bot.wasAlive = alive;
    if (!alive) return;
    if (W.current !== 'rifle' && W.owned.has('rifle') && sim.mode !== 'gone') W.select('rifle');
    // Moves at a player's speed on the fight's own clock (the page's timers can run late).
    const dt = Math.min(0.25, Math.max(0, (st.clock - (bot.clock ?? st.clock)) / 1000));
    bot.clock = st.clock;
    bot.ticks = (bot.ticks ?? 0) + 1;
    const me = { x: P.x, z: P.z };
    let tx = me.x, tz = me.z, dodge = false;
    const sx = sim.x, sz = sim.z;
    // Out of a circle round (fx, fz): straight away from its middle, or (standing on the middle: a tell aimed where
    // you stood) to the side, across the line from the spirit, as a player steps aside.
    const out = (fx, fz, r) => {
      let ux = me.x - fx, uz = me.z - fz, d = Math.hypot(ux, uz);
      if (d < 0.5) { const sx0 = me.x - sim.x, sz0 = me.z - sim.z, l = Math.hypot(sx0, sz0) || 1; bot.side ??= Math.random() < 0.5 ? 1 : -1; ux = (-sz0 / l) * bot.side; uz = (sx0 / l) * bot.side; d = 1; }
      tx = fx + (ux / d) * r; tz = fz + (uz / d) * r; dodge = true;
    };
    // Threats first: the sweep's lane, a bolt's ring (tell or flying), a pool.
    if (sim.act === 'sweep' && sim.aim) {
      const a = sim.aim, ex = a.x - a.fx, ez = a.z - a.fz, len = Math.hypot(ex, ez) || 1;
      const u = ((me.x - a.fx) * ex + (me.z - a.fz) * ez) / len;
      const side = ((me.x - a.fx) * ez - (me.z - a.fz) * ex) / len;
      if (u > -1 && u < len + 1 && Math.abs(side) < 2.2) { const k = side >= 0 ? 1 : -1; tx = me.x + (ez / len) * 3 * k; tz = me.z - (ex / len) * 3 * k; dodge = true; }
    }
    if (sim.act === 'bolt' && sim.aim && Math.hypot(me.x - sim.aim.x, me.z - sim.aim.z) < 4) out(sim.aim.x, sim.aim.z, 5);
    for (const bl of sim.bolts) if (Math.hypot(me.x - bl.x, me.z - bl.z) < 4) out(bl.x, bl.z, 5);
    for (const p of sim.pools) if (Math.hypot(me.x - p.x, me.z - p.z) < 3.4) out(p.x, p.z, 4.2);
    if (sim.act === 'pool' && sim.aim && Math.hypot(me.x - sim.aim.x, me.z - sim.aim.z) < 3.4) out(sim.aim.x, sim.aim.z, 4.2);
    // Once, after the first shell: walk off past the leash and wait, so it goes to mend.
    if (bot.away > 0) {
      bot.away -= dt;
      tx = -42.2; tz = 462; dodge = true;
      if (sim.mode === 'mend' && !bot.mended) { bot.mended = true; bot.log.push('it mends at ' + Math.round(st.clock / 1000) + ' s'); }
      if (bot.away <= 0) bot.log.push('back to it');
    } else if (!bot.mended && sim.phase >= 2 && sim.shell === null && sim.act !== 'stun') { bot.away = 22; bot.log.push('walking off at ' + Math.round(st.clock / 1000) + ' s'); }
    if (!dodge) bot.side = undefined;
    if (!dodge && sim.mode !== 'asleep') {
      // Keep 13.5 m from it (outside the sweep's 11), round the grove; a new angle when shots stop counting.
      if (st.heart && sim.hp === bot.lastHp) bot.stuck += dt; else bot.stuck = 0;
      bot.lastHp = sim.hp;
      if (bot.stuck > 1.5) { bot.angle += 0.7; bot.stuck = 0; }
      // Now and then in close (a player often is): within the sweep's reach for a few seconds of every 30.
      const R = Math.floor(st.clock / 1000) % 30 < 6 ? 7.5 : 13.5;
      const a = Math.atan2(me.x - sx, me.z - sz) + bot.angle * 0.05;
      tx = sx + Math.sin(a) * R; tz = sz + Math.cos(a) * R;
      const dg = Math.hypot(tx - (-68), tz - 488);
      if (dg > 24) { tx = -68 + ((tx + 68) / dg) * 24; tz = 488 + ((tz - 488) / dg) * 24; }
      if (bot.angle && st.heart) { const b2 = Math.atan2(tx - sx, tz - sz) + 0.35; tx = sx + Math.sin(b2) * 13.5; tz = sz + Math.cos(b2) * 13.5; bot.angle = Math.max(0, bot.angle - 0.02); }
    }
    if (sim.mode === 'asleep') { tx = -60; tz = 481; }
    bot.dodging = dodge;
    const [nx, nz] = stepTo(tx, tz, dt);
    // Aim: the open heart, else the nearest lit light, else at it.
    let aim = st.heart;
    if (!aim) { let best = null, bd = 1e9; for (const l of st.lights) if (l) { const d = Math.hypot(l[0] - nx, l[2] - nz); if (d < bd) [best, bd] = [l, d]; } aim = best; }
    const feet = ground(nx, nz);
    const eye = feet + 1.6;
    const look = aim ?? [sx, sim.y, sz];
    const dx = look[0] - nx, dy = look[1] - eye, dz = look[2] - nz;
    const yaw = Math.atan2(-dx, -dz), pitch = Math.atan2(dy, Math.hypot(dx, dz));
    B.teleport(nx, nz, feet, yaw, pitch);
    if (aim && bot.away <= 0 && Math.hypot(dx, dz) < 45) { B.fire(); bot.shots++; }
  }
  bot.timer = setInterval(tick, 50);
  window.__bot = bot;
  return true;
})()`;

/** A picture: the fight held, you moved to a spot to see `what`, the shot, everything put back. */
async function picture(name, what) {
  if (!o.out) return;
  if (!(await b.evaluate('briel.combat.alive', false))) return false; // not from the ground: the next time it shows
  await b.evaluate('briel.spirit.hold(true)', false);
  const back = await b.evaluate('({ x: briel.player.x, z: briel.player.z, feet: briel.player.feet, yaw: briel.player.yaw, pitch: briel.player.pitch })', false);
  await b.evaluate(`(() => {
    const B = briel, st = B.spirit.state(), s = st.sim, P = B.player;
    const what = ${JSON.stringify(what)};
    const ground = (x, z) => B.world.groundAt(x, z, -4, 0).y;
    let fx = s.x, fy = s.y, fz = s.z;
    let side = false;
    if (what === 'tell' && s.aim) { fx = (s.x + s.aim.x) / 2; fz = (s.z + s.aim.z) / 2; fy = ground(fx, fz) + 1.0; side = true; }
    if (what === 'pool' && s.pools.length) { fx = s.pools[0].x; fz = s.pools[0].z; fy = ground(fx, fz) + 0.6; }
    if (what === 'lights') { const l = st.lights.find(Boolean); if (l) [fx, fy, fz] = l; }
    if (what === 'drop' && st.drop) { fx = st.drop.x; fy = st.drop.y + 0.3; fz = st.drop.z; }
    // From behind and a little beside you, so you, it and the tell are in one picture.
    // From where you stand when you are in the grove, else from its middle's side.
    const inside = Math.hypot(P.x + 68, P.z - 488) < 24;
    let dx = (inside ? P.x : -68) - fx, dz = (inside ? P.z : 488) - fz; let d = Math.hypot(dx, dz);
    if (d < 2) { dx = fx - s.x; dz = fz - s.z; d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d; d = 4; } else { dx /= d; dz /= d; }
    // A light: from inside the grove, its trunk behind it.
    if (what === 'lights') { const gx = -68 - fx, gz = 488 - fz, gl = Math.hypot(gx, gz) || 1; dx = gx / gl; dz = gz / gl; }
    if (side) { const ax = s.aim.x - s.x, az = s.aim.z - s.z, al = Math.hypot(ax, az) || 1; dx = -az / al; dz = ax / al; if (Math.hypot(fx + dx * 12 + 68, fz + dz * 12 - 488) > 26) { dx = -dx; dz = -dz; } }
    const r = what === 'drop' ? 5 : what === 'lights' ? Math.min(12, Math.max(7, d)) : Math.max(11, Math.min(16, d + 3));
    const vx = fx + dx * r - dz * 2, vz = fz + dz * r + dx * 2;
    const feet = ground(vx, vz), eye = feet + 1.6;
    const ex = fx - vx, ey = fy - eye, ez = fz - vz;
    B.teleport(vx, vz, feet, Math.atan2(-ex, -ez), Math.atan2(ey, Math.hypot(ex, ez)));
  })()`, false);
  const moods = o.night ? ['sunny', 'night'] : [null];
  for (const mood of moods) {
    if (mood) {
      await b.evaluate(`briel.three.weather.setSolo(${JSON.stringify(mood)})`, false);
      await b.sleep(9000);
    } else await b.sleep(700);
    const file = join(o.out, `${name}${mood === 'night' ? '-night' : ''}.png`);
    await b.screenshot(file);
    log('  picture', file);
  }
  await b.evaluate(`briel.teleport(${back.x}, ${back.z}, ${back.feet}, ${back.yaw}, ${back.pitch}); briel.spirit.hold(false)`, false);
}

/** A phone: the touch fire button, tapped while aiming at the open heart, hurts it (the fight held meanwhile). */
async function tapHeart() {
  // Stand 11 m from it, inside the grove, and let the fight see you there for a moment.
  await b.evaluate(`(() => { __bot.on = false; const s = briel.spirit.state().sim, gx = -68 - s.x, gz = 488 - s.z, l = Math.hypot(gx, gz) || 1;
    const x = s.x + (gx / l) * 11, z = s.z + (gz / l) * 11; briel.teleport(x, z, briel.world.groundAt(x, z, -4, 0).y); })()`, false);
  await b.sleep(300);
  await b.evaluate('briel.spirit.hold(true)', false);
  const aim = await b.evaluate(`(() => { const st = briel.spirit.state(), h = st.heart, P = briel.player; if (!h) return null;
    const dx = h[0] - P.x, dy = h[1] - (P.feet + 1.6), dz = h[2] - P.z; briel.teleport(P.x, P.z, P.feet, Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
    const r = document.querySelector('.tbtn.t-fire').getBoundingClientRect(); return { hp: st.sim.hp, x: r.x + r.width / 2, y: r.y + r.height / 2, dist: Math.hypot(dx, dz) }; })()`, false);
  if (!aim) return log('tap: the heart was not open');
  let hp = aim.hp;
  for (let i = 0; i < 6; i++) {
    await b.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: aim.x, y: aim.y, id: 1 }] });
    await b.sleep(60);
    await b.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await b.sleep(250);
    hp = await b.evaluate('briel.spirit.state().sim.hp', false);
  }
  log(`tap: the touch fire button at (${Math.round(aim.x)}, ${Math.round(aim.y)}), ${aim.dist.toFixed(1)} m from the heart: its health ${aim.hp} -> ${hp}`);
  await b.evaluate('__bot.on = true; briel.spirit.hold(false)', false);
}

async function fight() {
  await startGame(b, o.url, { phone: o.phone, noAsk: true });
  await b.evaluate(`briel.three.applyQuality(${JSON.stringify(o.quality.split(',')[0])}); briel.three.holdQuality(true)`, false);
  if (o.night) await b.evaluate("briel.three.weather.setSolo('sunny')", false);
  await b.evaluate('briel.teleport(-52, 476, -8.7, Math.atan2(-(-80.2 + 52), -(488 - 476)), 0.05)', false);
  await b.waitFor('briel.spirit.state().look', 60000);
  await b.sleep(o.night ? 9000 : 2500);
  await picture('01-asleep', 'it');
  const seen = new Set();
  await b.evaluate(BOT, false);
  if (o.quick) await b.evaluate('briel.spirit.set({ hp: Math.round(briel.spirit.fight.sim.max * 0.7) })', false);
  const t0 = Date.now();
  let prevLights = 0;
  let beatenAt = null;
  let mendFrom = null;
  const states = [
    ['02-waking', (s) => s.mode === 'fight' && s.clock - s.woke < 900, 'it'],
    ['03-sweep', (s) => s.act === 'sweep' && s.p > 0.65, 'tell'],
    ['04-bolt', (s) => s.act === 'bolt' && s.p > 0.6, 'tell'],
    ['05-bolt-flying', (s) => s.bolts > 0 && s.act !== 'bolt', 'it'],
    ['06-heart-open', (s) => s.act === 'open' && s.p > 0.25 && s.p < 0.6, 'it'],
    ['07-shell-lights', (s) => s.lights >= 3 && s.act !== 'idle', 'lights'],
    ['08-light-out', (s) => s.lightOut, 'lights'],
    ['09-burst', (s) => s.act === 'stun' && s.p < 0.06, 'it'],
    ['10-sinking', (s) => s.act === 'sink' && s.p > 0.5, 'it'],
    ['11-rising', (s) => s.act === 'rise' && s.p > 0.55, 'it'],
    ['12-pool', (s) => s.pools > 0, 'pool'],
    ['13-mending', (s) => s.mode === 'mend' && (s.act === 'idle' || s.act === 'drift') && s.clock - s.mendFrom > 2500, 'it'],
    ['14-apart', (s) => s.mode === 'apart' && s.p > 0.25, 'it'],
    ['15-launcher', (s) => s.mode === 'gone' && s.drop, 'drop'],
  ];
  while (Date.now() - t0 < Number(o.minutes) * 60000) {
    await b.sleep(60);
    const s = await b.evaluate(`(() => { const st = briel.spirit.state(), s = st.sim, f = briel.spirit.fight; const len = { sweep: 1.7, bolt: 1.9, open: 5, stun: 6, sink: 1, rise: 1.3 }[s.act] ?? 1;
      const lights = st.lights.filter(Boolean).length;
      return { mode: s.mode, act: s.act, phase: s.phase, hp: s.hp, max: s.max, clock: st.clock, woke: f.sim.woke, p: Math.min(1, (st.clock - s.since) / 1000 / len), bolts: s.bolts.length, pools: s.pools.length, lights, drop: !!st.drop }; })()`, false);
    s.lightOut = s.lights < prevLights && s.lights > 0;
    if (s.mode === 'mend' && mendFrom === null) mendFrom = s.clock;
    if (s.mode !== 'mend') mendFrom = null;
    s.mendFrom = mendFrom ?? s.clock;
    prevLights = s.lights;
    for (const [name, test, what] of states) {
      if (seen.has(name) || !test(s)) continue;
      if ((await picture(name, what)) === false) continue;
      if (name === '06-heart-open' && o.phone) await tapHeart();
      seen.add(name);
      log(`  ${Math.round(s.clock / 1000)} s: ${name} (phase ${s.phase}, ${Math.round((s.hp / s.max) * 100)} %)`);
    }
    if (s.mode === 'apart' && beatenAt === null) beatenAt = s.clock;
    if (s.mode === 'gone' && s.drop && seen.has('15-launcher')) break;
  }
  const bot = await b.evaluate('({ downs: __bot.downs, shots: __bot.shots, log: __bot.log, hurt: __bot.hurt, hits: __bot.hits })', false);
  await b.evaluate('__bot.on = false; clearInterval(__bot.timer)', false);
  log(`fight: ${beatenAt === null ? 'NOT beaten' : `beaten after ${(beatenAt / 60000).toFixed(2)} min on the fight's clock`}; went down ${bot.downs} times; ${bot.shots} shots fired`);
  for (const l of bot.log) log('   ', l);
  log('health lost to:', JSON.stringify(bot.hurt));
  if (o.hits) for (const h of bot.hits) log('   hit', JSON.stringify(h));
  log('pictures taken:', [...seen].join(', '), '| not seen:', states.map((x) => x[0]).filter((n) => !seen.has(n)).join(', ') || 'none');
  // The launcher: walk into it, then fire it.
  const took = await b.evaluate(`(async () => {
    const B = briel, st = B.spirit.state();
    if (!st.drop) return { drop: false };
    const before = B.weapon.owned.has('launcher');
    B.teleport(st.drop.x + 3, st.drop.z, st.drop.y, Math.PI / 2, 0);
    await new Promise((r) => setTimeout(r, 300));
    for (let i = 0; i <= 10; i++) { B.teleport(st.drop.x + 3 - i * 0.3, st.drop.z, st.drop.y, Math.PI / 2, 0); await new Promise((r) => setTimeout(r, 60)); }
    await new Promise((r) => setTimeout(r, 300));
    const owned = B.weapon.owned.has('launcher');
    const line = document.getElementById('spirit-line').textContent;
    if (owned) B.weapon.select('launcher');
    await new Promise((r) => setTimeout(r, 1200));
    const left0 = B.weapon.lobLeft;
    B.teleport(B.player.x, B.player.z, B.player.feet, Math.PI / 2, 0.35);
    B.fire();
    await new Promise((r) => setTimeout(r, 2500));
    return { drop: true, before, owned, line, left0, left1: B.weapon.lobLeft, current: B.weapon.current, gone: !B.spirit.state().drop };
  })()`, true);
  log('launcher:', JSON.stringify(took));
  if (o.out) {
    await b.sleep(400);
    await b.screenshot(join(o.out, '16-launcher-taken.png'));
  }
}

/** Together, against a fake feed in the shapes of the wire: it glides, its hits are sent, garbage breaks nothing. */
async function together() {
  await startGame(b, o.url, { noAsk: true });
  await b.evaluate("briel.three.applyQuality('high')", false);
  await b.evaluate('briel.spirit.fake(true)', false);
  await b.evaluate('briel.teleport(-56, 478, -8.7, Math.atan2(-(-68 + 56), -(486 - 478)), 0.1)', false);
  await b.waitFor('briel.spirit.state().look', 60000);
  // The server's state: fight, phase 1, 80 %, at hover 0, drifting to hover 1, then open; five times a second.
  const res = await b.evaluate(`(async () => {
    const S = briel.spirit, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ACT = { idle: 0, drift: 1, sweep: 2, bolt: 3, pool: 4, open: 5, pause: 6, sink: 7, under: 8, rise: 9, stun: 10 };
    S.feed({ welcome: { s: [1, 1, 800, -68, -6.63, 486, ACT.idle, 400, -56, 478, 0] } });
    const jumps = [];
    let last = null;
    const watch = setInterval(() => {
      const p = S.fight.look?.group.position;
      if (!p) return;
      if (last) jumps.push(Math.hypot(p.x - last.x, p.z - last.z));
      last = { x: p.x, z: p.z };
    }, 16);
    // Drift from hover 0 (-68, 486) to hover 1 (-55, 488) at 2.5 m/s, sent at 5 Hz.
    for (let i = 0; i <= 26; i++) {
      const f = Math.min(1, (i * 0.2 * 2.5) / 13.15);
      S.feed({ t: 'sp', s: [1, 1, 800, -68 + 13 * f, -6.63, 486 + 2 * f, f < 1 ? ACT.drift : ACT.idle, f < 1 ? 0 : 400, -55, 488, 0] });
      await sleep(200);
    }
    clearInterval(watch);
    const steady = jumps.slice(5); // the first frames: from where it was made to where the server says
    const maxStep = Math.max(...steady), mean = steady.reduce((a, b) => a + b, 0) / steady.length;
    // The heart opens: shoot it with the rifle and the shotgun (real shots through weapon.ts).
    S.feed({ t: 'sp', s: [1, 1, 800, -55, -6.6, 488, ACT.open, 5000, -56, 478, 0] });
    await sleep(600);
    const st = S.state();
    const h = st.heart;
    const P = briel.player;
    const aim = () => { const dx = h[0] - P.x, dy = h[1] - (P.feet + 1.6), dz = h[2] - P.z; briel.teleport(P.x, P.z, P.feet, Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz))); };
    briel.teleport(-59, 484, -8.7);
    aim();
    briel.weapon.select('rifle');
    await sleep(900);
    for (let i = 0; i < 5; i++) { aim(); briel.fire(); await sleep(150); }
    briel.weapon.select('shotgun');
    await sleep(1200);
    aim(); briel.fire();
    await sleep(300);
    const sent = S.sent().slice();
    // The server answers: health down while open (a hit's tick and flinch), a light shell (mask), a bolt effect.
    S.feed({ t: 'sp', s: [1, 1, 760, -55, -6.6, 488, ACT.open, 4000, -56, 478, 0] });
    S.feed({ t: 'sp', s: [1, 2, 660, -55, -6.6, 488, ACT.idle, 400, -56, 478, 0b10100100] });
    S.feed({ t: 'spe', e: 'bolt', from: { x: -55, y: -6.6, z: 488 }, to: { x: -59, y: -8.7, z: 484 }, ms: 900 });
    await sleep(400);
    const lit = S.state().lights.filter(Boolean).length;
    // Garbage: none of it may throw or change what is drawn.
    const before = JSON.stringify(S.fight.wire);
    const junk = [null, 5, 'sp', { t: 'sp' }, { t: 'sp', s: 'x' }, { t: 'sp', s: [1, 1, 1] }, { t: 'sp', s: [9, 1, 800, 0, 0, 0, 0, 0, 0, 0, 0] },
      { t: 'sp', s: [1, 1, 800, NaN, 0, 0, 0, 0, 0, 0, 0] }, { t: 'sp', s: [1, 1, 800, 1e9, 0, 0, 0, 0, 0, 0, 0] }, { t: 'sp', s: [1, 1, 800, 0, 0, 0, 0, 0, 0, 0, 999] },
      { t: 'sp', s: [1, 1, 800, 0, 0, 0, 0, 0, 0, 0, 0], p: 'x' }, { t: 'sp', s: [1, 1, 800, 0, 0, 0, 0, 0, 0, 0, 0], p: [[1, 2]] },
      { t: 'spe' }, { t: 'spe', e: 'bolt' }, { t: 'spe', e: 'bolt', from: { x: 'a' }, to: {}, ms: 1 }, { t: 'spe', e: 'bolt', from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 0 }, ms: -5 },
      { t: 'spe', e: 'light', i: 99 }, { t: 'spe', e: 'beaten', names: [{}, '<b>x</b>'] }, { t: 'spe', e: { toString: 1 } }, { t: 'sgl', e: 'drop', x: 'no' },
      { t: 'sp', s: [1, 1, 800, 0, 0, 0, 0, 0, 0, 0, 0].map(String) }];
    let threw = 0;
    for (const m of junk) { try { S.feed(m); } catch (e) { threw++; } }
    await sleep(300);
    const after = JSON.stringify(S.fight.wire);
    // A room: no spirit in the welcome (a welcome with a spirit that is no object counts the same: nothing drawn).
    S.feed({ welcome: 7 });
    await sleep(100);
    const badWelcome = S.state().absent;
    S.feed({ welcome: undefined });
    await sleep(200);
    const room = S.state();
    const roomLine = document.getElementById('spirit-line').className;
    const roomBoxes = !!S.state().heart || S.state().lights.some(Boolean);
    S.feed({ welcome: { s: [0, 1, 1000, -80.2, -6.6, 488, 0, 0, -68, 488, 0] } });
    await sleep(200);
    return { maxStep, mean, frames: jumps.length, sent, lit, threw, unchanged: before === after, badWelcome, roomAbsent: room.absent, roomLine, roomBoxes, asleepAgain: S.state().view?.mode };
  })()`, true);
  log('together:', JSON.stringify(res, null, 1));
  if (o.out) await b.screenshot(join(o.out, 'together.png'));
}

async function sounds() {
  await startGame(b, o.url, { noAsk: true });
  const kinds = ['presence', 'sweep', 'bolt', 'pool', 'rise', 'open', 'hit', 'cap', 'shell', 'chime', 'ping', 'out', 'burst', 'mend', 'land', 'end'];
  for (const k of kinds) {
    const r = await b.evaluate(`briel.spirit.sound(${JSON.stringify(k)})`, true);
    log(`  ${k.padEnd(9)} peak ${r.peak.toFixed(3)}  rms ${r.rms.toFixed(4)}  audible ${r.audible.toFixed(2)} s  nodes ${r.nodes}`);
  }
}

/** What the fight's drawing costs: a shell up with its lights, three tells showing; with and without, alternating. */
/**
 * The three tells together, held still: a sweep's lane, a bolt's ring with its bolt on the way, two pools, the shell's
 * lights; pictures of them from two spots in each weather of --moods (a mood takes 9 s to blend in).
 */
async function tells() {
  await startGame(b, o.url, { noAsk: true });
  await b.evaluate(`briel.three.applyQuality(${JSON.stringify(o.quality.split(',')[0])}); briel.three.holdQuality(true)`, false);
  await b.evaluate('briel.teleport(-60, 466, -8.6, 0, 0)', false);
  await b.waitFor('briel.spirit.state().look', 60000);
  await b.evaluate(`(() => { const f = briel.spirit.fight, s = f.sim, now = f.clock, up = s.d.up;
    const g = (x, z) => briel.world.groundAt(x, z, -4, 0).y;
    briel.spirit.hold(true);
    for (const i of [1, 3, 6]) Object.assign(s.lights[i], { lit: true, used: true, hp: 300 });
    Object.assign(s, { mode: 'fight', phase: 2, shell: 0, act: 'sweep', node: 0, x: -68, z: 486, y: g(-68, 486) + up, since: now - 1000, until: now + 700,
      aim: { fx: -68, fz: 486, y: g(-68, 486), x: -57, z: 486 }, tx: -57, tz: 486,
      pools: [{ x: -73, y: g(-73, 476), z: 476, from: now - 2000, until: now + 4000 }, { x: -76, y: g(-76, 481), z: 481, from: now - 2000, until: now + 4000 }] });
    f.fx.flight(f.heart, { x: -62, y: g(-62, 476), z: 476 }, 5000, now / 1000 - 3); })()`, false);
  const views = [['wide', -61, 469, -67, -7.6, 482], ['close', -67, 470, -68, -8.3, 478], ['side', -63, 471.5, -63, -6.8, 486]];
  for (const mood of (o.moods || 'sunny,dusk,night,rain').split(',')) {
    await b.evaluate(`briel.three.weather.setSolo(${JSON.stringify(mood)})`, false);
    await b.sleep(9500);
    for (const [name, x, z, lx, ly, lz] of views) {
      await b.evaluate(`(() => { const f = briel.world.groundAt(${x}, ${z}, -4, 0).y, dx = ${lx} - ${x}, dy = ${ly} - (f + 1.6), dz = ${lz} - ${z};
        briel.teleport(${x}, ${z}, f, Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz))); })()`, false);
      await b.sleep(900);
      const file = join(o.out, `tells-${mood}-${name}.png`);
      await b.screenshot(file);
      log('  picture', file);
    }
  }
}

async function bench() {
  await startGame(b, o.url, { noAsk: true });
  await b.evaluate('briel.three.holdQuality(true)', false);
  for (const q of o.quality.split(',')) {
    await b.evaluate(`briel.three.applyQuality(${JSON.stringify(q)})`, false);
    await b.evaluate('briel.teleport(-56, 476, -8.7, Math.atan2(-(-68 + 56), -(488 - 476)), 0.12)', false);
    await b.waitFor('briel.spirit.state().look', 60000);
    // Pose: awake in phase 2 with its shell and three lights, a bolt's ring, a sweep's lane, two pools.
    await b.evaluate(`(() => { const f = briel.spirit.fight, s = f.sim, now = f.clock;
      briel.spirit.hold(true);
      for (const i of [1, 3, 6]) Object.assign(s.lights[i], { lit: true, used: true, hp: 300 });
      Object.assign(s, { mode: 'fight', phase: 2, shell: 0, act: 'sweep', since: now - 800, until: now + 900, aim: { fx: s.x, fz: s.z, y: -8.8, x: s.x + 11, z: s.z }, tx: s.x + 11, tz: s.z,
        pools: [{ x: -60, y: -8.7, z: 482, from: now - 2000, until: now + 4000 }, { x: -64, y: -8.8, z: 474, from: now - 2000, until: now + 4000 }] });
      f.fx.flight(f.heart, { x: -58, y: -8.7, z: 480 }, 5000, now / 1000); })()`, false);
    await b.sleep(1500);
    if (o.out) await b.screenshot(join(o.out, `bench-${q}.png`));
    const posed = await b.evaluate('({ motes: briel.spirit.fight.fx.motes.count, view: briel.spirit.state().view })', false);
    log(`${q} pose: ${posed.motes} motes, ${JSON.stringify(posed.view && { act: posed.view.act, lights: posed.view.lights, pools: posed.view.pools })}`);
    const sets = [];
    await b.evaluate(`briel.bench(${Number(o.frames)})`, false); // warm-up
    for (let r = 0; r < Number(o.runs) * 2; r++) {
      const on = r % 2 === 0;
      // Shown or not, and timed in the same breath: the game's own frame would show it again in between.
      const ms = await b.evaluate(`(() => { briel.spirit.fight.fx.group.visible = ${on}; return briel.bench(${Number(o.frames)}).msPerFrame; })()`, false);
      sets.push({ on, ms });
    }
    const pick = (on) => sets.filter((x) => x.on === on).map((x) => x.ms);
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    log(`${q}: with ${pick(true).join(', ')} ms (mean ${avg(pick(true)).toFixed(2)}) | without ${pick(false).join(', ')} ms (mean ${avg(pick(false)).toFixed(2)}) | motes ${await b.evaluate('briel.spirit.fight.fx.motes.count', false)}`);
    await b.evaluate('briel.spirit.fight.fx.group.visible = true; briel.spirit.hold(false); briel.spirit.reset()', false);
  }
}

try {
  if (o.together) await together();
  else if (o.sound) await sounds();
  else if (o.bench) await bench();
  else if (o.tells) await tells();
  else await fight();
  const errors = b.logs.filter((l) => /^(error|exception)/.test(l));
  if (errors.length) log('page errors:\n' + errors.slice(0, 12).join('\n'));
} finally {
  b.close();
}
