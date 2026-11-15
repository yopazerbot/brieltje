// The helicopter in the real game (src/heliPilot.ts, world/heli.ts, shared/heli.mjs), headless (tools/dev/cdp.mjs) on a
// running dev server, flown by real key events (and a fake controller, and touch with --phone). It prints the numbers
// of set manoeuvres: getting in, the rotor's run-up and the lift-off, a climb to 100 m, a hover held for 20 s, the way
// down, a dash to top speed and the stop, a full turn at cruise, the ceiling, the game's edge, landings on the meadow
// and on a 6 by 10 m deck where the church's platform will be (a test deck through a dev hook until the church has
// one), bumps into a wall and into a tree crown at 5 and 20 m/s and how long until it flies again, getting out on the
// ground and not in the air; and that the timed routes, Zombies, the cars, the bikes and the horses are left as they
// were. It checks the shader programs don't change after the take-off and that no page error came. With --out, the
// pictures (chase in a hover, a dash, a turn, the landing by the church's tower, the cockpit, the instruments in
// English and Dutch). With --sound, the sound by numbers (as tools/dev/music.mjs): the blade slap's rate against the
// rotor's speed, the peak, the RMS, clipped samples, and that nothing plays after getting out.
//
//   node tools/dev/heli.mjs --url http://localhost:5274/ --port 9681 [--out <folder>] [--quality low|high] [--phone] [--pad] [--sound [--soundonly]] [--swiftshader]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5274/', port: '9681', out: '', quality: 'medium', phone: false, pad: false, sound: false, soundonly: false, swiftshader: false, lang: 'en' });
const phone = !!o.phone && o.phone !== 'false';
const b = await launch({ port: Number(o.port), width: 1280, height: 720, swiftshader: !!o.swiftshader && o.swiftshader !== 'false' });
let failed = false;
const check = (ok, text) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${text}`);
  if (!ok) failed = true;
};
const row = (what, got) => console.log(`  ${what.padEnd(34)} ${got}`);
const shot = async (name) => {
  if (!o.out) return;
  mkdirSync(o.out, { recursive: true });
  await b.screenshot(join(o.out, `${name}.png`));
};
const r1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const deg = (v) => r1((v * 180) / Math.PI);
const CODES = { KeyW: ['w', 87], KeyA: ['a', 65], KeyS: ['s', 83], KeyD: ['d', 68], KeyC: ['c', 67], KeyE: ['e', 69], KeyI: ['i', 73], KeyK: ['k', 75], Space: [' ', 32], ArrowRight: ['ArrowRight', 39], ArrowLeft: ['ArrowLeft', 37] };
const key = (type, code) => b.send('Input.dispatchKeyEvent', { type, code, key: CODES[code][0], windowsVirtualKeyCode: CODES[code][1] });
const down = (...codes) => Promise.all(codes.map((c) => key('keyDown', c)));
const up = (...codes) => Promise.all(codes.map((c) => key('keyUp', c)));
const tap = async (code) => {
  await key('keyDown', code);
  await b.sleep(60);
  await key('keyUp', code);
};
const S = (expr) => b.evaluate(`(() => { const s = briel.helis.machines[0].s; return ${expr}; })()`);
const state = () => S('({ x: s.x, y: s.y, z: s.z, vx: s.vx, vy: s.vy, vz: s.vz, h: s.h, pitch: s.pitch, roll: s.roll, yaw: s.yaw, rotor: s.rotor, ground: s.ground, down: s.down, engine: s.engine })');
const speed = (s) => Math.hypot(s.vx, s.vz);
const prompt = () => b.evaluate("document.getElementById('prompt')?.textContent ?? ''");
/** Poll every `ms` until `done(state, t)` (seconds since the start), at most `secs`; returns the samples. */
async function until(done, secs, ms = 100) {
  const t0 = Date.now();
  const got = [];
  for (;;) {
    const s = await state();
    const t = (Date.now() - t0) / 1000;
    got.push({ ...s, t });
    if (done(s, t, got) || t > secs) return got;
    await b.sleep(ms);
  }
}
/** E beside it until aboard (a key event can land in a frame that doesn't look at it), at most three times. */
async function board() {
  for (let i = 0; i < 3 && !(await b.evaluate('briel.helis.aboard')); i++) {
    await tap('KeyE');
    await b.sleep(400);
  }
}
/** In the page: every frame's state of the machine, for touchdowns (window.__hrec). */
const record = () => b.evaluate(`(() => { const r = window.__hrec = []; const go = () => { if (window.__hrec !== r) return; const s = briel.helis.machines[0].s; r.push([performance.now(), s.y, s.vy, s.ground ? 1 : 0, s.ev, s.x, s.z, s.h, s.down]); requestAnimationFrame(go); }; requestAnimationFrame(go); return true; })()`);
const recorded = () => b.evaluate('(() => { const r = window.__hrec; window.__hrec = null; return r; })()');
/** The touchdown in a recording: the sink just before the skids met the floor, a bounce, a bump, the slide after. */
function touchdown(frames) {
  const i = frames.findIndex((f, k) => k > 0 && f[3] === 1 && frames[k - 1][3] === 0);
  if (i < 0) return null;
  const sink = -Math.min(...frames.slice(Math.max(0, i - 3), i).map((f) => f[2]));
  const ev = frames.slice(i - 3, i + 30).reduce((a, f) => a | f[4], 0);
  const last = frames[Math.min(frames.length - 1, i + 120)];
  return { sink, bounce: !!(ev & 2), bump: !!(ev & 4), slide: Math.hypot(last[5] - frames[i][5], last[6] - frames[i][6]), at: frames[i] };
}
/** Put the machine somewhere in the air (or on the floor), still, its engine and rotor running. */
const putAir = (x, z, h, yaw, v = [0, 0]) => b.evaluate(`(() => { const m = briel.helis.machines[0]; const g = briel.world.groundAt(${x}, ${z}, 999, 0).y; m.place(${x}, g, ${z}, ${yaw}, 1); Object.assign(m.s, { y: g + ${h}, holdY: g + ${h}, heightHeld: true, ground: ${h} <= 0, vx: ${v[0]}, vz: ${v[1]}, holding: false, coll: 0.5 }); return g; })()`);

try {
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('briel.graphics','${o.quality}');localStorage.setItem('briel.lang','${o.lang}');localStorage.setItem('briel.spawn','house');localStorage.setItem('briel.playMode','explore');localStorage.setItem('briel.feedback','later');` }); // no feedback card in the middle of a run
  const url = new URL(o.url);
  url.searchParams.set('nobake', '');
  await startGame(b, url.href, { phone });
  await b.evaluate("document.getElementById('cc-close')?.click()", false);
  await b.waitFor('!!briel.helis');
  console.log(`helicopter, ${o.quality}${phone ? ', phone (touch)' : ''}${o.pad ? ', a controller' : ''}`);

  if (o.sound) {
    // The sound by numbers (world/heliSound.ts: the dev build renders its loop offline, the same nodes as live): its
    // default script runs up over 6 s, hovers (7-10 s), climbs (10-13), flies at top speed (13-17), sinks (17-21) and
    // runs down over 8 s (22-30). Before the game's volume, at the panner's reference distance.
    const r = await b.evaluate(`(async () => {
      const sr = 48000;
      const stats = (d) => {
        const rms = (t0, t1) => { let e = 0, n = 0; for (let i = Math.round(t0 * sr); i < Math.min(d.length, t1 * sr); i++) { e += d[i] * d[i]; n++; } return Math.sqrt(e / Math.max(1, n)); };
        const peak = (t0, t1) => { let p = 0; for (let i = Math.round(t0 * sr); i < Math.min(d.length, t1 * sr); i++) p = Math.max(p, Math.abs(d[i])); return p; };
        // The pulse's rate: the low band (two one-pole lowpasses at 300 Hz), its envelope smoothed (60 Hz) every 1 ms,
        // the strongest repeat that is a peak of its own between 15 and 125 ms.
        const rate = (t0, t1) => {
          const a = Math.exp((-2 * Math.PI * 300) / sr), e = Math.exp((-2 * Math.PI * 60) / sr), step = Math.round(sr / 1000);
          let l1 = 0, l2 = 0, en = 0;
          const env = [];
          for (let i = Math.round(t0 * sr); i < t1 * sr; i++) {
            l1 = a * l1 + (1 - a) * d[i];
            l2 = a * l2 + (1 - a) * l1;
            en = e * en + (1 - e) * Math.abs(l2);
            if (i % step === 0) env.push(en);
          }
          const mean = env.reduce((x, y) => x + y, 0) / env.length;
          const cor = []; for (let L = 0; L <= 127; L++) { let c = 0; for (let i = 0; i + L < env.length; i++) c += (env[i] - mean) * (env[i + L] - mean); cor.push(c); }
          let best = 0, lag = 0;
          for (let L = 15; L <= 125; L++) if (cor[L] > cor[L - 1] && cor[L] >= cor[L + 1] && cor[L] > best) { best = cor[L]; lag = L; }
          return lag ? 1000 / lag : 0;
        };
        // The biggest jump from one sample to the next (a click shows as one far over the rest).
        const jump = (t0, t1) => { let j = 0; for (let i = Math.max(1, Math.round(t0 * sr)); i < Math.min(d.length, t1 * sr); i++) j = Math.max(j, Math.abs(d[i] - d[i - 1])); return j; };
        let clipped = 0;
        for (const v of d) if (Math.abs(v) >= 1) clipped++;
        return { rms, peak, rate, jump, clipped };
      };
      const hover = (inside) => () => ({ x: 0, y: 0, z: 0, rotor: 1, coll: 0.55, sink: 0, air: 0, inside });
      const all = stats((await brielHeliSound.render(30, sr)).buffer.getChannelData(0));
      const high = stats((await brielHeliSound.render(30, sr, undefined, 3000)).buffer.getChannelData(0));
      const held = stats((await brielHeliSound.render(8, sr, (t) => ({ x: 0, y: 0, z: 0, rotor: t < 4 ? 0.6 : 0.4, coll: 0.7, sink: 0, air: 0, inside: false }))).buffer.getChannelData(0));
      const out = stats((await brielHeliSound.render(4, sr, hover(false), 1000)).buffer.getChannelData(0));
      const ins = stats((await brielHeliSound.render(4, sr, hover(true), 1000)).buffer.getChannelData(0));
      let music = null;
      try {
        const md = (await brielMusic.render('theme', 10, sr)).buffer.getChannelData(0);
        let p = 0, e = 0;
        for (const v of md) { p = Math.max(p, Math.abs(v)); e += v * v; }
        music = { peak: p, rms: Math.sqrt(e / md.length) };
      } catch {}
      return {
        BLADE: brielHeliSound.BLADE_HZ, LEVELS: brielHeliSound.LEVELS, clipped: all.clipped, music,
        rateFull: all.rate(7, 10), rate60: held.rate(1, 3.8), rate40: held.rate(5, 7.8),
        hover: [all.peak(7, 10), all.rms(7, 10)], climb: [all.peak(10.5, 13), all.rms(10.5, 13)], top: [all.peak(13.5, 17), all.rms(13.5, 17)], descent: [all.peak(17.5, 21), all.rms(17.5, 21)],
        peak: all.peak(0, 30), high: high.rms(7, 21) / all.rms(7, 21), highPeak: high.peak(7, 21),
        end: all.rms(29.6, 30), startJump: all.jump(0, 1), endJump: all.jump(28, 30), flightJump: all.jump(7, 21),
        cockpit: ins.rms(0.5, 4) / out.rms(0.5, 4),
      };
    })()`);
    const db = (v) => (20 * Math.log10(Math.max(v, 1e-9))).toFixed(0);
    row('pulse at full speed', `${r1(r.rateFull)} Hz (blade pass ${r1(r.BLADE)} Hz)`);
    row('pulse, rotor held at 60 % / 40 %', `${r1(r.rate60)} / ${r1(r.rate40)} Hz (expect ${r1(r.BLADE * 0.6)} / ${r1(r.BLADE * 0.4)})`);
    for (const k of ['hover', 'climb', 'top', 'descent']) row(`peak / RMS, ${k}`, `${r[k][0].toFixed(3)} / ${r[k][1].toFixed(4)}`);
    row('above 3 kHz in flight', `${db(r.high)} dB under the whole (peak ${r.highPeak.toFixed(4)})`);
    row('the cockpit against behind, over 1 kHz', `${db(r.cockpit)} dB`);
    row('largest step between samples', `start ${r.startJump.toFixed(4)}, run-down ${r.endJump.toFixed(4)}, in flight ${r.flightJump.toFixed(4)}`);
    if (r.music) row('the music (start theme, 50 %)', `peak ${r.music.peak.toFixed(3)}, RMS ${r.music.rms.toFixed(4)}`);
    row('levels to turn', JSON.stringify(r.LEVELS));
    check(Math.abs(r.rateFull - r.BLADE) < 2.5 && Math.abs(r.rate60 - r.BLADE * 0.6) < 2.5 && Math.abs(r.rate40 - r.BLADE * 0.4) < 2.5, "the pulse follows the rotor's speed");
    check(r.peak <= 0.1 && r.clipped === 0, `peak ${r.peak.toFixed(3)}: about half the first version's 0.18, nothing clipped`);
    check(r.high < 0.05, 'next to nothing above 3 kHz');
    check(r.cockpit < 0.7, "a touch muffled from the pilot's seat");
    check(r.startJump < r.flightJump && r.endJump < r.flightJump, 'no click starting or stopping (no step bigger than in flight)');
    check(r.end < 1e-3, `silent once run down (RMS ${r.end.toExponential(1)})`);
  }

  if (o.soundonly) {
    b.close();
    process.exit(failed ? 1 : 0);
  }
  // Getting in: beside it, the use key.
  const m0 = await state();
  await b.evaluate(`briel.teleport(${m0.x + 2.0}, ${m0.z - 0.6}, ${m0.y}, 1.2)`, false);
  await b.sleep(400);
  const near = await prompt();
  await board();
  check(await b.evaluate('briel.helis.aboard'), `in with E (the line beside it: "${near}")`);
  const programs0 = await b.evaluate('briel.three.renderer.info.programs.length');

  // The run-up and the lift-off, then on up to 100 m.
  if (o.pad) {
    // A controller in the "Like walking" layout: R2 up (as far as pressed), the left stick flies, the right stick turns.
    await b.evaluate(`(() => { const btn = () => ({ pressed: false, touched: false, value: 0 }); const pad = { id: 'Fake (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, btn) }; window.__pad = pad; navigator.getGamepads = () => [pad, null, null, null]; })()`, false);
  }
  /** A touch button held or let go (touch emulation: a touch on its middle). */
  const touchBtn = async (cls, on) => {
    if (on) await b.waitFor("document.body.dataset.touch === 'heli'", 5000); // the helicopter's layout first (Up is where Down was on foot)
    const at = await b.evaluate(`(() => { const r = document.querySelector('#touch .${cls}').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await b.send('Input.dispatchTouchEvent', { type: on ? 'touchStart' : 'touchEnd', touchPoints: on ? [{ x: at[0], y: at[1], id: 7 }] : [] });
  };
  const lift = async (on) => {
    if (phone) await touchBtn('t-jump', on);
    else if (o.pad) await b.evaluate(`(() => { const b = __pad.buttons[7]; b.value = ${on ? 1 : 0}; b.pressed = ${on}; })()`, false);
    else if (on) await down('Space');
    else await up('Space');
  };
  const sink = async (on) => {
    if (phone) await touchBtn('t-down', on);
    else if (o.pad) await b.evaluate(`(() => { const b = __pad.buttons[6]; b.value = ${on ? 1 : 0}; b.pressed = ${on}; })()`, false);
    else if (on) await down('KeyC');
    else await up('KeyC');
  };
  const forward = async (v) => {
    if (o.pad) await b.evaluate(`__pad.axes[1] = ${-v}`, false);
    else if (v) await down('KeyW');
    else await up('KeyW');
  };
  const turnRight = async (on) => {
    if (o.pad) await b.evaluate(`__pad.axes[2] = ${on ? 1 : 0}`, false);
    else if (on) await down('ArrowRight');
    else await up('ArrowRight');
  };
  const restDraws = await b.evaluate('briel.helis.dev.state().draws');
  await lift(true);
  const spin = await until((s) => !s.ground, 15);
  const tOff = spin.at(-1).t;
  const climb = await until((s) => s.h >= 100, 30);
  const c10 = climb.find((s) => s.h >= 10), c90 = climb.find((s) => s.h >= 90);
  row('run-up and lift-off', `airborne ${r1(tOff)} s after the up key; 10 to 90 m at ${r1(80 / (c90.t - c10.t))} m/s`);
  const programs1 = await b.evaluate('briel.three.renderer.info.programs.length');
  check(programs1 === programs0, `no new shader programs after the take-off (${programs0} then ${programs1})`);
  await lift(false);
  await shot('chase-hover');
  // The hover hold: 3 s to settle, then 20 s hands off.
  await b.sleep(3000);
  const h0 = await state();
  const hold = await until(() => false, 20, 250);
  const drift = Math.max(...hold.map((s) => Math.hypot(s.x - h0.x, s.z - h0.z)));
  const dh = Math.max(...hold.map((s) => Math.abs(s.y - h0.y)));
  row('hover 20 s hands off', `drift ${r1(drift)} m across, ${r1(dh)} m in height (the page's own wind blowing)`);
  check(drift < 1 && dh < 0.5, 'the hover holds');
  console.log(`  instruments: "${await b.evaluate("document.getElementById('heli-hud')?.textContent")}"`);
  // A steady hover is not "at rest": E is refused after 2 s of it too (a hover once counted as resting after 0.5 s).
  await b.sleep(2000);
  await tap('KeyE');
  await b.sleep(200);
  const hoverOut = await prompt();
  check(await b.evaluate('briel.helis.aboard') && /land/i.test(hoverOut), `no getting out of a steady hover after 2 s ("${hoverOut}")`);
  // The minimap: your arrow shows the machine's way, and the plan turns with the view, behind it and from the seat.
  for (const view of ['chase', 'cockpit']) {
    if ((await b.evaluate('briel.helis.dev.state().view')) !== view) await tap('KeyI');
    await b.sleep(300);
    const m0 = await b.evaluate('briel.minimapFacing()');
    const y0 = (await state()).yaw;
    await turnRight(true);
    await b.sleep(1200);
    await turnRight(false);
    await b.sleep(1500);
    const m1 = await b.evaluate('briel.minimapFacing()');
    const y1 = (await state()).yaw;
    const turnBy = (a, c) => Math.atan2(Math.sin(a - c), Math.cos(a - c));
    row(`minimap, ${view}`, `machine turned ${deg(turnBy(y1, y0))} deg, the plan ${deg(turnBy(m1.heading, m0.heading))} deg, the arrow ${deg(m1.facing ?? NaN)} deg (machine ${deg(y1)})`);
    check(m1.facing !== null && Math.abs(turnBy(m1.facing, y1)) < 0.01, `${view}: the arrow shows the machine's way`);
    check(Math.abs(turnBy(m1.heading, m0.heading)) > 0.5 * Math.abs(turnBy(y1, y0)), `${view}: the plan turns with the view`);
  }
  if ((await b.evaluate('briel.helis.dev.state().view')) !== 'chase') await tap('KeyI');
  if (o.sound) {
    // A tab in the background: the hum fades and stops; in view again it comes back.
    const on = await b.evaluate('briel.helis.dev.state().sound');
    await b.evaluate("(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); })()", false);
    await b.sleep(2500);
    const hidden = await b.evaluate('briel.helis.dev.state().sound');
    await b.evaluate("(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); })()", false);
    await b.sleep(500);
    const back = await b.evaluate('briel.helis.dev.state().sound');
    check(on && !hidden && back, `the hum stops in a background tab and comes back (playing ${on}, hidden ${hidden}, back ${back})`);
  }
  const flightDraws = await b.evaluate('briel.helis.dev.state().draws');
  row('draws (machine, near)', `${restDraws} at rest, ${flightDraws} in flight (budget 24)`);
  check(restDraws <= 24 && flightDraws <= 24, 'within the draw budget');
  // Sideways alone: the nose stays; sideways with the turn the same way (D with the right arrow): it still slides.
  const yaw0 = (await state()).yaw;
  await down('KeyD');
  await b.sleep(8000);
  const slid = await state();
  await up('KeyD');
  const sideOf = (q) => Math.abs(q.vx * Math.cos(q.yaw) - q.vz * Math.sin(q.yaw)); // speed along the machine's right
  row('D alone 8 s', `nose turned ${deg(Math.atan2(Math.sin(slid.yaw - yaw0), Math.cos(slid.yaw - yaw0)))} deg, ${r1(sideOf(slid))} m/s sideways`);
  check(Math.abs(Math.atan2(Math.sin(slid.yaw - yaw0), Math.cos(slid.yaw - yaw0))) < 0.02, 'sideways alone the nose stays where it was');
  await b.sleep(4000);
  await down('KeyD', 'ArrowRight');
  await b.sleep(3000);
  const both = await state();
  await up('KeyD', 'ArrowRight');
  row('D with the right arrow 3 s', `${r1(speed(both))} m/s over the ground (${r1(sideOf(both))} along its right) while turning on the spot`);
  check(speed(both) > 5, 'D and the right arrow together still slide it (cancelled, it would turn on the spot at 0 m/s)');
  await b.sleep(4000);
  // Down to 30 m.
  await sink(true);
  const desc = await until((s) => s.h <= 30, 30);
  await sink(false);
  row('down 100 to 30 m', `${r1(desc.at(-1).t)} s (${r1(70 / desc.at(-1).t)} m/s)`);
  await b.sleep(2000);

  // The dash, the turn and the stop: from 70 m over the house's meadow (over the church's spire), towards the village.
  const fromHome = await b.evaluate("briel.helis.dev.put('house', 1)");
  // The heading with the most room: of 16, the one whose next 1.5 km stays deepest inside the edge.
  const roomy = await b.evaluate(`(() => { const e = briel.world.bounds; let best = 0, yaw = 0; for (let k = 0; k < 16; k++) { const a = (k / 16) * Math.PI * 2; let least = Infinity; for (let d = 0; d <= 1500; d += 50) least = Math.min(least, e.depth(${fromHome.x} - Math.sin(a) * d, ${fromHome.z} - Math.cos(a) * d)); if (least > best) { best = least; yaw = a; } } return yaw; })()`);
  await putAir(fromHome.x, fromHome.z, 70, roomy);
  await b.sleep(1500);
  await forward(1);
  const dash = await until(() => false, 14, 200);
  await shot('chase-dash');
  const top = Math.max(...dash.map(speed));
  const t90 = dash.find((s) => speed(s) > 0.9 * top)?.t ?? NaN;
  row('dash, full forward', `${r1(top * 3.6)} km/h top, 90 % in ${r1(t90)} s, nose down ${deg(Math.max(...dash.map((s) => s.pitch)))} deg`);
  // The full turn at cruise, then let go.
  await turnRight(true);
  let turned = 0;
  let last = (await state()).yaw;
  const xs = [], zs = [];
  const turn = await until((s) => {
    turned += Math.atan2(Math.sin(s.yaw - last), Math.cos(s.yaw - last));
    last = s.yaw;
    xs.push(s.x);
    zs.push(s.z);
    return Math.abs(turned) >= 2 * Math.PI;
  }, 60, 100);
  await shot('chase-turn');
  await turnRight(false);
  check(await b.evaluate('briel.helis.aboard') && (await S('s.down')) === 0, 'still flying after the dash and the turn (no bump on the way)');
  const inside = await b.evaluate(`briel.world.bounds.depth(${turn.at(-1).x}, ${turn.at(-1).z})`);
  row('full turn at cruise', `${r1(inside)} m inside the edge; ${r1(turn.at(-1).t)} s at ${r1(speed(turn.at(-1)) * 3.6)} km/h, radius ${r1((Math.max(...xs) - Math.min(...xs) + Math.max(...zs) - Math.min(...zs)) / 4)} m, bank ${deg(Math.max(...turn.map((s) => s.roll)))} deg, height ${r1(Math.max(...turn.map((s) => s.y)) - Math.min(...turn.map((s) => s.y)))} m`);
  await forward(0);
  const s0 = await state();
  const stop = await until((s) => speed(s) < 0.5, 30, 100);
  row('stop, let go', `${r1(stop.at(-1).t)} s, ${r1(Math.hypot(stop.at(-1).x - s0.x, stop.at(-1).z - s0.z))} m, nose up ${deg(-Math.min(...stop.map((s) => s.pitch)))} deg, height ${r1(Math.max(...stop.map((s) => s.y)) - s0.y)} m`);
  // The timed routes offer nothing in it (K, the race key).
  await tap('KeyK');
  await b.sleep(300);
  check(await b.evaluate('!briel.goals.race.offer && !briel.goals.race.armed'), 'K offers and arms no timed route in the helicopter');
  // Getting out in the air: refused, the line says to land (after 2.5 s still: a hover is not at rest).
  await b.sleep(2500);
  await tap('KeyE');
  await b.sleep(200);
  const air = await prompt();
  check(await b.evaluate('briel.helis.aboard') && /land/i.test(air), `no getting out in the air ("${air}")`);
  // A respawn from the hover: you are out, the machine set down on the floor below (no bump), or on its pad if that
  // floor is somewhere nobody can walk to.
  {
    const was = await state();
    await b.evaluate('briel.respawn(0)', false);
    await b.sleep(600);
    const after = await state();
    const park = await b.evaluate('briel.helis.machines[0].park');
    const where = Math.hypot(after.x - was.x, after.z - was.z) < 1 ? 'below where it hovered' : Math.hypot(after.x - park.x, after.z - park.z) < 1 ? 'on its pad' : `elsewhere (${r1(after.x)}, ${r1(after.z)})`;
    row('respawn from a hover', `out: ${!(await b.evaluate('briel.helis.aboard'))}; set down ${where}, ground ${after.ground}, down ${after.down}`);
    check(!(await b.evaluate('briel.helis.aboard')) && after.ground && after.down === 0 && !where.startsWith('else'), 'a respawn from a hover sets it down, no bump');
    await putAir(was.x, was.z, was.h, was.yaw);
    await b.evaluate('briel.helis.board(briel.helis.machines[0])');
    await b.sleep(500);
  }

  // The ceiling.
  await lift(true);
  const ceil = await until(() => false, 18, 250);
  await lift(false);
  const ceilPrompt = await prompt();
  row('ceiling', `highest ${r1(Math.max(...ceil.map((s) => s.h)))} m over the floor below (the game's: 120 m over the ground); "${ceilPrompt}"`);
  check(Math.max(...ceil.map((s) => s.y)) <= (await b.evaluate(`briel.world.skyAt(${ceil.at(-1).x}, ${ceil.at(-1).z})`)) + 0.01, 'never over the ceiling');

  // The edge: 120 m inside it at 40 m, flat out towards it.
  const edge = await b.evaluate('(() => { const p = briel.player; const e = briel.world.bounds.nearest(p.x, p.z, Infinity); return e; })()');
  await putAir(edge.x + edge.nx * 120, edge.z + edge.nz * 120, 40, Math.atan2(edge.nx, edge.nz));
  await forward(1);
  const fence = await until(() => false, 25, 200);
  await forward(0);
  const depth = await b.evaluate(`briel.world.bounds.depth(${fence.at(-1).x}, ${fence.at(-1).z})`);
  row('the edge, flat out at it', `stops ${r1(depth)} m inside, ${r1(speed(fence.at(-1)))} m/s at the end, "${await prompt()}"`);
  check(depth > 0, 'stays inside the edge');

  // Landing on the meadow from 30 m, the down key held.
  const home = await b.evaluate("briel.helis.dev.put('house', 1)");
  await putAir(home.x, home.z, 30, 3.142);
  await record();
  await sink(true);
  const landed = await until((s) => s.ground, 30);
  if (!landed.at(-1).ground) console.log('  not down:', JSON.stringify(landed.at(-1)));
  await b.sleep(2500);
  await sink(false);
  let td = touchdown(await recorded());
  row('landing on the meadow', td ? `touched at ${r1(td.sink)} m/s, ${td.bump ? 'BUMP' : td.bounce ? 'one bounce' : 'settled'}, slid ${r1(td.slide)} m` : 'no touchdown seen');
  check(td && !td.bump && !td.bounce && td.sink < 2.5, 'a soft landing by itself');
  // Getting out on the ground, then the rotor runs down and the sound with it.
  await tap('KeyE');
  await b.sleep(300);
  const outAt = await b.evaluate('({ aboard: briel.helis.aboard, x: briel.player.x, z: briel.player.z, feet: briel.player.feet })');
  check(!outAt.aboard, `out on the ground, beside its door (${r1(Math.hypot(outAt.x - home.x, outAt.z - home.z))} m from the hub)`);
  await b.sleep(9000);
  check(!(await b.evaluate('briel.helis.dev.state().sound')) && (await S('s.rotor')) === 0, 'the rotor ran down and nothing plays any more');

  // The church's platform: a test deck (until the church has its own), a landing from 12 m over it after a sidestep.
  if (phone) await b.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }).catch(() => {}); // no button left held from before (none may be)
  await b.evaluate('briel.helis.dev.deck()');
  const pad = await b.evaluate("briel.helis.dev.put('church', 1)");
  await b.evaluate(`briel.teleport(${pad.x}, ${pad.z}, ${pad.y}, 0)`, false);
  await b.evaluate('briel.helis.board(briel.helis.machines[0])');
  await lift(true);
  await until((s) => s.h > 12, 10);
  await lift(false);
  await down('KeyD');
  await b.sleep(400); // a short step aside (the deck is 6 m wide); the pad's pull brings it back over the middle
  await up('KeyD');
  await b.sleep(2500);
  await record();
  await sink(true);
  const frames = [];
  for (let i = 0; i < 40; i++) {
    await b.sleep(250);
    if (o.out && i % 4 === 0) frames.push(i);
    if (o.out && i % 4 === 0) await shot(`deck-${String(i).padStart(2, '0')}`);
    if (await S('s.ground')) break;
  }
  await b.sleep(2000);
  await sink(false);
  td = touchdown(await recorded());
  const onDeck = await state();
  row('landing on the 6 by 10 m deck', td ? `touched at ${r1(td.sink)} m/s, ${td.bump ? 'BUMP' : td.bounce ? 'one bounce' : 'settled'}, slid ${r1(td.slide)} m, ${r1(Math.hypot(onDeck.x - pad.x, onDeck.z - pad.z))} m from its centre, floor ${r1(onDeck.y)} (deck ${r1(pad.y)})` : 'no touchdown seen');
  check(td && !td.bump && Math.abs(onDeck.y - pad.y) < 0.1, 'it rests on the deck');
  await shot('deck-landed');
  // The cockpit view (I), then back.
  await tap('KeyI');
  await b.sleep(400);
  await shot('cockpit');
  check((await b.evaluate('briel.helis.dev.state().view')) === 'cockpit', 'I: the pilot\'s view');
  await tap('KeyI');
  await b.sleep(200);

  // Bumps: into the house's wall and into a tree's crown at 5 and 20 m/s, then how long until it flies again.
  const wall = await b.evaluate(`(() => { const w = briel.world; for (let d = 6; d < 200; d += 0.5) { const x = -32 + d, z = -8; const g = w.groundAt(x, z, 50, 0).y; if (!w.boxFree(x, z, 0, 0.2, 0.2, g + 1.5, g + 2.5)) return { x, z, g }; } return null; })()`);
  for (const v of [5, 20]) {
    if (!wall) break;
    await putAir(wall.x - 3.5, wall.z, 1.5, -Math.PI / 2, [v, 0]);
    await record();
    await b.sleep(1500);
    const f = await recorded();
    const bumped = f.some((x) => x[4] & 4);
    await lift(true);
    const t0 = Date.now();
    const again = await until((q) => !q.ground && q.down === 0, 30);
    if (again.at(-1).ground) console.log('  still down:', JSON.stringify(again.at(-1)), await b.evaluate('briel.helis.aboard'));
    await lift(false);
    check(!again.at(-1).ground && again.at(-1).down === 0, `after the bump into the wall at ${v} m/s it flies again (${r1(again.at(-1).t)} s with up held)`);
    row(`into a wall at ${v} m/s`, `${bumped ? 'a bump (sparks or dust, a clang, set down)' : 'stopped, no bump'}; flying again ${r1((Date.now() - t0) / 1000)} s after (up held)`);
  }
  const crown = await b.evaluate(`(() => { const p = briel.helis.machines[0].s; let best = null, d = Infinity; for (const c of briel.helis.dev.crowns()) { const e = Math.hypot(c.x - p.x, c.z - p.z); if (c.h > 8 && e < d) { d = e; best = c; } } return best; })()`);
  for (const v of [5, 20]) {
    if (!crown) break;
    const hub = crown.y + crown.h * 0.7 - 3.2 - (await b.evaluate(`briel.world.groundAt(${crown.x - 15}, ${crown.z}, 999, 0).y`));
    await putAir(crown.x - 15, crown.z, hub, -Math.PI / 2, [v, 0]);
    await b.sleep(2500);
    const after = await state();
    row(`into a tree crown at ${v} m/s`, `${r1(speed(after))} m/s 2.5 s later, ${after.down > 0 ? 'BUMP' : 'no bump, leaves'}`);
  }

  // A machine left on a roof (nobody can reach it): a respawn sends it back to its pad at once.
  const roof = await b.evaluate(`(() => { const w = briel.world; for (let x = -12; x <= 12; x += 1) for (let z = -12; z <= 12; z += 1) { const g = w.groundAt(x, z, 999, 0).y; if (g - w.groundAt(x, z, -1e4, 0).y > 3) return { x, z, g }; } return null; })()`);
  const parkAt = await b.evaluate('briel.helis.machines[0].park');
  if (roof) {
    await b.evaluate(`briel.helis.dev.put({ x: ${roof.x}, z: ${roof.z}, y: ${roof.g} }, 0)`);
    await b.sleep(1500);
    const before = await state();
    await b.evaluate('briel.respawn(0)', false);
    await b.sleep(300);
    const after = await state();
    row('left on a roof, then a respawn', `${r1(before.y - roof.g)} m over the roof before; ${r1(Math.hypot(after.x - parkAt.x, after.z - parkAt.z))} m from its pad after`);
    check(Math.hypot(after.x - parkAt.x, after.z - parkAt.z) < 1, 'a respawn sends a machine left on a roof back to its pad');
  }
  // Zombies alone, started from the air away from the pad: you are on your feet and the machine back on its pad.
  await b.evaluate("briel.helis.dev.put('house', 0)");
  const hm = await state();
  await b.evaluate(`briel.teleport(${hm.x + 2}, ${hm.z - 0.6}, ${hm.y}, 1.2)`, false);
  await b.sleep(300);
  await board();
  await putAir(hm.x + 60, hm.z + 40, 30, 0);
  await b.sleep(1000);
  await b.evaluate("briel.zombiesSolo.start('house')").catch(() => {});
  await b.sleep(1500);
  const zAt = await state();
  check(!(await b.evaluate('briel.helis.aboard')), 'Zombies puts you on your feet');
  check(Math.hypot(zAt.x - parkAt.x, zAt.z - parkAt.z) < 1 && zAt.ground && zAt.down === 0, `Zombies started in the air sends the machine to its pad (${r1(Math.hypot(zAt.x - parkAt.x, zAt.z - parkAt.z))} m from it, ground ${zAt.ground}, down ${zAt.down})`);
  await b.sleep(3000); // the game's start places you; then back beside the machine
  const hz = await state();
  await b.evaluate(`briel.teleport(${hz.x + 2}, ${hz.z - 0.6}, ${hz.y}, 1.2)`, false);
  await b.sleep(400);
  await tap('KeyE');
  await b.sleep(300);
  check(!(await b.evaluate('briel.helis.aboard')), `no boarding in Zombies ("${await prompt()}", ${r1(await b.evaluate('briel.helis.machines[0].distanceTo(briel.player.x, briel.player.z)'))} m from it)`);
  await b.evaluate('briel.zombiesSolo.stop()').catch(() => {});
  await b.sleep(1500);
  // The other vehicles still work.
  await b.evaluate('briel.getIn()', false);
  await b.sleep(300);
  check(await b.evaluate('briel.driving()'), 'a car: in');
  await b.evaluate('briel.getOut()', false);
  const bike = await b.evaluate("(() => { const k = briel.bikes.nearest(briel.player.x, briel.player.z, briel.player.feet) ?? null; return k?.id ?? [...(briel.bikes.list?.() ?? [])][0]?.id ?? null; })()");
  if (bike) {
    await b.evaluate(`briel.getOnBike('${bike}')`, false);
    await b.sleep(300);
    check(!!(await b.evaluate('briel.bikes.mounted')), 'a bike: on');
    await b.evaluate('briel.getOffBike()', false);
  }
  await b.evaluate('briel.mountHorse(0)', false);
  await b.sleep(300);
  check((await b.evaluate('briel.horses.mounted')) === 0, 'a horse: on');
  await b.evaluate('briel.getOffHorse()', false);

  // The instruments in both languages, and on touch where nothing overlaps them.
  await b.evaluate("briel.helis.dev.put('house', 1)");
  const hh = await state();
  await b.evaluate(`briel.teleport(${hh.x + 2}, ${hh.z - 0.6}, ${hh.y}, 1.2)`, false);
  await b.sleep(300);
  await board();
  await lift(true);
  await until((s) => s.h > 20, 10);
  await lift(false);
  await forward(1);
  await b.sleep(3000);
  await shot(`hud-${o.lang}`);
  await b.evaluate("briel.i18n.setLang('nl')");
  await b.sleep(300);
  await shot('hud-nl');
  console.log(`  instruments (nl): "${await b.evaluate("document.getElementById('heli-hud')?.textContent")}", "${await prompt()}"`);
  await b.evaluate(`briel.i18n.setLang('${o.lang}')`);
  await forward(0);
  const overlaps = await b.evaluate(`(() => {
    const r = (e) => e && e.offsetParent !== null ? e.getBoundingClientRect() : null;
    const hud = r(document.getElementById('heli-hud'));
    const others = [['minimap', document.getElementById('minimap')], ['sound', document.getElementById('sound-btn')], ...[...document.querySelectorAll('#touch .tbtn:not(.hidden)')].map((e) => [e.className, e])];
    const hit = (a, b) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    return { hud: hud && [hud.left, hud.top, hud.right, hud.bottom].map(Math.round), over: others.filter(([, e]) => hit(hud, r(e))).map(([n]) => n) };
  })()`);
  check(overlaps.hud && overlaps.over.length === 0, `the instruments at ${overlaps.hud} overlap nothing${overlaps.over.length ? `: ${overlaps.over}` : ''}`);
  if (phone) {
    for (const [w, h] of [[844, 390], [667, 375]]) {
      await b.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true });
      await b.sleep(600);
      const ov = await b.evaluate(`(() => {
        const r = (e) => e && e.offsetParent !== null ? e.getBoundingClientRect() : null;
        const hud = r(document.getElementById('heli-hud'));
        const all = [['minimap', document.getElementById('minimap')], ['prompt', document.getElementById('prompt')], ['stick', document.querySelector('#touch .stick')], ...[...document.querySelectorAll('#touch .tbtn:not(.hidden)')].map((e) => [e.className, e])];
        const hit = (a, b) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        const btns = [...document.querySelectorAll('#touch .tbtn:not(.hidden)')].map((e) => e.className.replace('tbtn ', '') + ':' + e.textContent);
        return { hud: hud && [hud.left, hud.top, hud.right, hud.bottom].map(Math.round), over: all.filter(([, e]) => hit(hud, r(e))).map(([n]) => n), btns, state: document.body.dataset.touch };
      })()`);
      check(ov.hud && ov.over.length === 0, `${w}x${h}: instruments at ${ov.hud}, buttons ${ov.btns.join(', ')} (touch state ${ov.state})${ov.over.length ? `, overlapping ${ov.over}` : ''}`);
      await shot(`phone-${w}x${h}`);
    }
  }
  // Left where nobody can reach it (on a roof): after 20 s it goes back to its pad by itself.
  if (roof) {
    await b.evaluate('briel.helis.leaveNow()');
    await b.evaluate(`briel.helis.dev.put({ x: ${roof.x}, z: ${roof.z}, y: ${roof.g} }, 0)`);
    await b.evaluate(`briel.teleport(${parkAt.x + 40}, ${parkAt.z}, ${parkAt.y}, 0)`, false);
    const t0 = Date.now();
    let home = false;
    while (!home && Date.now() - t0 < 30000) {
      await b.sleep(500);
      const q = await state();
      home = Math.hypot(q.x - parkAt.x, q.z - parkAt.z) < 1;
    }
    row('left on a roof', home ? `back on its pad after ${r1((Date.now() - t0) / 1000)} s` : 'still there after 30 s');
    check(home, 'a machine left on a roof goes back to its pad by itself');
  }
  const errors = b.logs.filter((l) => /^exception|^error/.test(l) && !/Failed to load resource/.test(l));
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 5).join(' | ')}` : ''}`);
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  b.close();
}
process.exit(failed ? 1 : 0);
