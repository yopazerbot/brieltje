// The helicopter in the real game (src/heliPilot.ts, world/heli.ts, shared/heli.mjs), headless (tools/dev/cdp.mjs) on a
// running dev server, flown by real key events (and a fake controller, and touch with --phone). It prints the numbers
// of set manoeuvres with the keys of the helicopters in open-world driving games (W and S fly, A and D turn, the arrows sideways,
// the mouse only looks; L1 and R1 turn on a controller, the right stick looks; the touch stick turns pushed sideways and
// a drag looks): looking round and the view's way back, the pilot's head, the turn rates, a curve, getting in, the
// rotor's run-up and the lift-off, a climb to 100 m, a hover held for 20 s, the way
// down, a dash to top speed and the stop, a full turn at cruise, the ceiling, the game's edge, landings on the meadow
// and on the church's 6 by 10 m landing deck (its own machine set aside for it), bumps into a wall and into a tree crown at 5 and 20 m/s and how long until it flies again, getting out on the
// ground and not too low in the air, and the jump (E higher up: the parachute opens by itself) from 20, 40, 80 and
// 118 m at a hover and at speed, with what happens to the machine after it, the camera's handover, the frame times and
// what a respawn, /parachute, /spawn, chat travel, a portal and Zombies do during one; and that the timed routes,
// Zombies, the cars, the bikes and the horses are left as they were. With --join <port> (a throwaway server on this
// computer, its API on that port; the dev server started with API_PORT set to it, and fresh: after an edit to the
// page's code, Vite hands the check another copy of src/start.ts and the join goes nowhere): joining others in the middle
// of a jump, and the first states the page sends. It checks the shader programs don't change after the take-off and that no page error came. With --out, the
// pictures (chase in a hover, a dash, a turn, the landing by the church's tower, the cockpit, the instruments in
// English and Dutch). With --sound, the sound by numbers (as tools/dev/music.mjs): the blade slap's rate against the
// rotor's speed, the peak, the RMS, clipped samples, and that nothing plays after getting out.
//
//   node tools/dev/heli.mjs --url http://localhost:5274/ --port 9681 [--out <folder>] [--quality low|high] [--phone] [--pad] [--sound [--soundonly]] [--swiftshader] [--join 8231] [--jumponly]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5274/', port: '9681', out: '', quality: 'medium', phone: false, pad: false, sound: false, soundonly: false, swiftshader: false, lang: 'en', join: '', jumponly: false });
const jumpOnly = !!o.jumponly && o.jumponly !== 'false';
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
const CODES = { KeyB: ['b', 66], ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], KeyW: ['w', 87], KeyA: ['a', 65], KeyS: ['s', 83], KeyD: ['d', 68], KeyC: ['c', 67], KeyE: ['e', 69], KeyI: ['i', 73], KeyK: ['k', 75], Space: [' ', 32], ArrowRight: ['ArrowRight', 39], ArrowLeft: ['ArrowLeft', 37] };
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
  /** Turn right: D (A and D turn it), R1 on a controller. */
  const turnRight = async (on) => {
    if (o.pad) await b.evaluate(`(() => { const x = __pad.buttons[5]; x.value = ${on ? 1 : 0}; x.pressed = ${on}; })()`, false);
    else if (on) await down('KeyD');
    else await up('KeyD');
  };
  const turnBy = (a, c) => Math.atan2(Math.sin(a - c), Math.cos(a - c));
  /** The camera's heading (as a yaw: 0 looks along -z) and the look round the machine keeps. */
  const view = () => b.evaluate(`(() => { const c = window.__cam ??= briel.three.scene.children.find((x) => x.isPerspectiveCamera); c.updateMatrixWorld(); const e = c.matrixWorld.elements; const m = briel.helis.machines[0]; return { cam: Math.atan2(e[8], e[10]), yaw: m.s.yaw, look: m.look, view: m.view }; })()`);
  /** Looking round: the mouse moved (`dx`, `dy` pixels, in steps), the right stick held, or a drag on the right on touch. */
  const lookBy = async (dx, dy = 0, how = phone ? 'touch' : o.pad ? 'pad' : 'mouse') => {
    if (how === 'mouse') {
      const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 40));
      for (let i = 0; i < n; i++) {
        await b.evaluate(`(() => { const c = briel.three.renderer.domElement; Object.defineProperty(document, 'pointerLockElement', { get: () => c, configurable: true }); document.dispatchEvent(new MouseEvent('mousemove', { movementX: ${dx / n}, movementY: ${dy / n} })); })()`, false);
        await b.sleep(20);
      }
      await b.evaluate('delete document.pointerLockElement', false);
    } else if (how === 'pad') {
      // The right stick, held as long as the turn takes at its speed (curved: full at the edge).
      await b.evaluate(`(() => { __pad.axes[2] = ${Math.sign(dx)}; __pad.axes[3] = ${Math.sign(dy)}; })()`, false);
      await b.sleep(Math.round((Math.abs(dx || dy) * 0.0022 / 2.6) * 1000));
      await b.evaluate('(() => { __pad.axes[2] = 0; __pad.axes[3] = 0; })()', false);
    } else {
      // A drag on the right side of the screen (controls/touch.ts: a dragged pixel looks as 1.6 of the mouse's).
      const at = await b.evaluate('[innerWidth * 0.8, innerHeight * 0.4]');
      await b.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at[0], y: at[1], id: 9 }] });
      const n = 12;
      for (let i = 1; i <= n; i++) {
        await b.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: at[0] + (dx * i) / n / 1.6, y: at[1] + (dy * i) / n / 1.6, id: 9 }] });
        await b.sleep(20);
      }
      await b.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
  };
  /** The touch stick pushed (`x` right, `y` forward, -1 to 1) for `ms`. */
  const touchStick = async (x, y, ms) => {
    const at = await b.evaluate('[innerWidth * 0.16, innerHeight * 0.72]');
    await b.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at[0], y: at[1], id: 8 }] });
    await b.sleep(50);
    await b.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: at[0] + x * 70, y: at[1] - y * 70, id: 8 }] });
    await b.sleep(ms);
    await b.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };

  /**
   * The keys of the helicopters in open-world driving games, from a hover: looking round (the machine's heading stays), the way back
   * behind it, the pilot's head, the turn keys' rate, W with A a curve, the arrows sideways, the controller's and the
   * touch stick's turn.
   */
  const controls = async () => {
    await b.sleep(2500);
    // Looking 90 degrees left at a hover: the machine keeps its heading; the view swings round it.
    const v0 = await view();
    const map0 = await b.evaluate('briel.minimapFacing()');
    // Every frame's look from here (rad from behind it, seconds since the last look), for the way back below.
    await b.evaluate(`(() => { const r = window.__look = []; const go = () => { if (window.__look !== r) return; const l = briel.helis.machines[0].look; r.push([performance.now(), l.yaw, l.idle]); requestAnimationFrame(go); }; requestAnimationFrame(go); })()`, false);
    await lookBy(-714);
    await b.sleep(300);
    const v1 = await view();
    const map1 = await b.evaluate('briel.minimapFacing()');
    row('look 90 deg left at a hover', `the view turned ${deg(turnBy(v1.cam, v0.cam))} deg, the machine ${deg(turnBy(v1.yaw, v0.yaw))} deg; the map turned ${deg(turnBy(map1.heading, map0.heading))} deg, its arrow ${deg(map1.facing)} (machine ${deg(v1.yaw)})`);
    check(Math.abs(turnBy(v1.yaw, v0.yaw)) < 0.0175, 'looking round leaves the machine\'s heading within 1 degree');
    check(Math.abs(turnBy(v1.cam, v0.cam)) > 1.2, 'the view looks round');
    check(map1.facing !== null && Math.abs(turnBy(map1.facing, v1.yaw)) < 0.01 && Math.abs(turnBy(map1.heading, map0.heading)) > 1.2, 'the map turns with the view, its arrow shows the machine');
    await shot(`look-chase${phone ? '-phone' : ''}`);
    // The way back: nothing for about 2 s after the last look, then eased back behind it, no jerk (its speed changes
    // no faster than an eased start allows: rad/s per s, on the game's own clock, the seconds since the last look).
    await b.sleep(6500);
    const all = await b.evaluate('(() => { const r = window.__look; window.__look = null; return r; })()');
    const back = all.slice(all.findLastIndex((f) => f[2] === 0) + 1);
    const at2 = back.find((f) => f[2] >= 1.9);
    const end = back.at(-1);
    let accel = 0;
    const steps = back.filter((f, i) => i === 0 || f[2] > back[i - 1][2] + 1e-4); // one per game frame
    for (let i = 2; i < steps.length; i++) {
      const v1 = (steps[i - 1][1] - steps[i - 2][1]) / (steps[i - 1][2] - steps[i - 2][2]);
      const v2 = (steps[i][1] - steps[i - 1][1]) / (steps[i][2] - steps[i - 1][2]);
      accel = Math.max(accel, Math.abs(v2 - v1) / ((steps[i][2] - steps[i - 2][2]) / 2));
    }
    row('the view back behind it', `${deg(back[0][1])} deg after the last look, ${deg(at2[1])} at 1.9 s, ${deg(end[1])} at ${r1(end[2])} s; its turn picks up at most ${r1(accel * 57.3)} deg/s each second`);
    check(Math.abs(at2[1] - back[0][1]) < 0.02 && Math.abs(end[1]) < 0.09 && accel < 8, 'it waits about 2 s, then eases back behind it without a jerk');
    // The pilot's head: 110 degrees to each side at most, 40 up and down.
    await tap(o.pad ? 'KeyI' : 'KeyB');
    await b.sleep(300);
    await lookBy(-650, 0, 'mouse');
    await b.sleep(200);
    await shot(`look-cockpit${phone ? '-phone' : ''}`); // out of the left window, level
    await lookBy(2700, 0, 'mouse');
    await lookBy(0, -900, 'mouse');
    const hd = await view();
    await lookBy(-4000, 1800, 'mouse');
    const hd2 = await view();
    row("the pilot's head", `right ${deg(-hd.look.yaw)} deg and up ${deg(hd.look.pitch)}; left ${deg(hd2.look.yaw)} deg and down ${deg(-hd2.look.pitch)} (view ${hd.view})`);
    check(hd.view === 'cockpit' && Math.abs(Math.abs(hd.look.yaw) - 1.92) < 0.01 && Math.abs(hd.look.pitch - 0.7) < 0.01 && Math.abs(Math.abs(hd2.look.yaw) - 1.92) < 0.01 && Math.abs(hd2.look.pitch + 1.05) < 0.01, "the pilot's head turns 110 degrees each way, 40 up and 60 down at most");
    // Looking down stays (a landing from the seat with the mouse still); turned to the side it comes back ahead.
    await b.sleep(5000);
    const hd3 = await view();
    row("the pilot's look after 5 s still", `down ${deg(-hd3.look.pitch)} deg, to the side ${deg(Math.abs(hd3.look.yaw))} deg`);
    check(Math.abs(hd3.look.pitch + 1.05) < 0.01 && Math.abs(hd3.look.yaw) < 0.2, "the look down stays; the look to the side eases back ahead");
    // The pad from the seat: 18 m up, 25 m short of it, facing it, looking down.
    {
      const was = await state();
      const park = await b.evaluate('briel.helis.machines[0].park');
      await putAir(park.x + Math.sin(park.yaw) * 25, park.z + Math.cos(park.yaw) * 25, 18, park.yaw);
      await lookBy(0, -190, 'mouse'); // from 60 down to about 36: the pad 25 m ahead and 18 m below
      await b.sleep(600);
      await shot(`cockpit-pad${phone ? '-phone' : ''}`);
      await putAir(was.x, was.z, was.h, was.yaw);
      await lookBy(0, -2000, 'mouse');
    }
    await tap('KeyI');
    await b.sleep(3500);
    // The turn keys at a hover: D (R1 on a controller) for 2 s.
    let t0 = await state();
    await turnRight(true);
    await b.sleep(2000);
    let t1 = await state();
    await turnRight(false);
    await b.sleep(1500);
    row(`turn at a hover, ${o.pad ? 'R1' : 'D'} 2 s`, `${deg(-turnBy(t1.yaw, t0.yaw))} deg (${r1(-turnBy(t1.yaw, t0.yaw) / 2)} rad/s; a hover's full turn ${1.4})`);
    check(-turnBy(t1.yaw, t0.yaw) > 1.8, 'the turn key turns it at a hover');
    if (o.pad) {
      // The right stick only looks: the machine keeps its heading.
      t0 = await state();
      await lookBy(700, 0, 'pad');
      await b.sleep(300);
      t1 = await state();
      check(Math.abs(turnBy(t1.yaw, t0.yaw)) < 0.0175, `the right stick only looks (the machine turned ${deg(turnBy(t1.yaw, t0.yaw))} deg)`);
    }
    if (phone) {
      // The touch stick pushed sideways turns it; a drag looks.
      t0 = await state();
      await touchStick(1, 0, 2000);
      await b.sleep(400);
      t1 = await state();
      await b.sleep(1200); // the stick's touch gone and the turn stopped before the drag
      row('touch stick right 2 s', `${deg(-turnBy(t1.yaw, t0.yaw))} deg, ${r1(speed(t1))} m/s`);
      check(-turnBy(t1.yaw, t0.yaw) > 1.2 && speed(t1) < 2, 'the touch stick pushed sideways turns it (no sideways flight)');
      t0 = await state();
      const c0 = await view();
      await lookBy(-300, 0, 'touch');
      await b.sleep(300);
      t1 = await state();
      const c1 = await view();
      row('a drag on the right', `the view ${deg(turnBy(c1.cam, c0.cam))} deg, the machine ${deg(turnBy(t1.yaw, t0.yaw))} deg`);
      check(Math.abs(turnBy(t1.yaw, t0.yaw)) < 0.0175 && Math.abs(turnBy(c1.cam, c0.cam)) > 0.2, 'a drag only looks');
      await b.sleep(3500);
    }
    // W with A: a curve to the left (6 s), the turn and the way counted as it goes.
    t0 = await state();
    await forward(1);
    if (o.pad) await b.evaluate('(() => { const x = __pad.buttons[4]; x.value = 1; x.pressed = true; })()', false);
    else await down('KeyA');
    let turned = 0, way = 0, prev = t0;
    await until((q) => {
      turned += turnBy(q.yaw, prev.yaw);
      way += Math.hypot(q.x - prev.x, q.z - prev.z);
      prev = q;
      return false;
    }, 6, 100);
    t1 = prev;
    if (o.pad) await b.evaluate('(() => { const x = __pad.buttons[4]; x.value = 0; x.pressed = false; })()', false);
    else await up('KeyA');
    await forward(0);
    row(`${o.pad ? 'the left stick forward with L1' : 'W with A'} 6 s`, `turned ${deg(turned)} deg left along ${r1(way)} m (a widening curve from the hover), ${r1(speed(t1) * 3.6)} km/h at the end, bank ${deg(-t1.roll)} deg`);
    check(turned > 0.8 && way > 15, 'forward with a turn flies a curve');
    await b.sleep(8000);
  };
  /** The use key, button or touch button: in, out, or the jump. */
  const use = async () => {
    if (phone) {
      await touchBtn('t-use', true);
      await b.sleep(80);
      await touchBtn('t-use', false);
    } else if (o.pad) {
      await b.evaluate('(() => { const x = __pad.buttons[3]; x.value = 1; x.pressed = true; })()', false);
      await b.sleep(80);
      await b.evaluate('(() => { const x = __pad.buttons[3]; x.value = 0; x.pressed = false; })()', false);
    } else await tap('KeyE');
  };
  const homes = (expr) => b.evaluate(`import('/shared/homes.mjs').then((h) => { const p = briel.player; return ${expr}; })`);

  /**
   * The jump: aboard over the house's meadow (the heading with the most room), at `h` m over the floor (Infinity: up
   * against the ceiling) and at `kmh` (full forward until then), then the use key. Every frame in the page from the
   * key on: you, the camera, the machine, the frame's time. With `wait`, until you are down; `during` runs 2 s in.
   */
  const jumpFrom = async (h, kmh, { wait = true, during = null } = {}) => {
    await b.evaluate('briel.helis.leaveNow()');
    const pad = await b.evaluate("briel.helis.dev.put('house', 1)");
    const yaw = await b.evaluate(`(() => { const e = briel.world.bounds; let best = 0, yaw = 0; for (let k = 0; k < 16; k++) { const a = (k / 16) * Math.PI * 2; let least = Infinity; for (let d = 0; d <= 1500; d += 50) least = Math.min(least, e.depth(${pad.x} - Math.sin(a) * d, ${pad.z} - Math.cos(a) * d)); if (least > best) { best = least; yaw = a; } } return yaw; })()`);
    await b.evaluate(`briel.teleport(${pad.x + 2}, ${pad.z - 0.6}, ${pad.y}, 1.2)`, false);
    await b.sleep(300);
    await board();
    await putAir(pad.x, pad.z, Number.isFinite(h) ? h : 100, yaw);
    if (!Number.isFinite(h)) {
      await lift(true);
      await until((q) => q.h > 110 && Math.abs(q.vy) < 0.3, 20, 200);
      await lift(false);
    }
    await b.sleep(1500);
    if (kmh > 0) {
      await forward(1);
      await until((q) => speed(q) * 3.6 >= kmh - 3, 40, 50);
    }
    const before = await state();
    const programs0 = await b.evaluate('(window.__progs = new Set(briel.three.renderer.info.programs.map((p) => p.id))).size');
    await b.evaluate(`(() => {
      const r = window.__jrec = { frames: [], at: performance.now() };
      const c = window.__cam ??= briel.three.scene.children.find((x) => x.isPerspectiveCamera);
      let last = performance.now();
      const go = () => {
        if (window.__jrec !== r) return;
        const now = performance.now(), p = briel.player, m = briel.helis.machines[0];
        r.frames.push([now - r.at, now - last, p.x, p.feet, p.z, p.chute, p.canopy, c.position.x, c.position.y, c.position.z, m.s.x, m.s.y, m.s.z, m.away, briel.helis.aboard ? 1 : 0, briel.world.groundAt(p.x, p.z, p.feet, 0).y, m.s.yaw, m.s.roll, m.s.pitch]);
        last = now;
        requestAnimationFrame(go);
      };
      requestAnimationFrame(go);
    })()`, false);
    if (!kmh) await b.sleep(1600); // the frames before it, flying as before: the same window without a jump
    await use();
    if (kmh > 0) await forward(0);
    const tag = `${Number.isFinite(h) ? h : 'ceiling'}-${kmh}`;
    await b.sleep(120);
    await shot(`jump-${tag}`);
    if (during) {
      await b.sleep(1900);
      await during();
    }
    if (wait) {
      const t0 = Date.now();
      let shotOpen = false;
      while (Date.now() - t0 < 45000) {
        await b.sleep(250);
        const p = await b.evaluate('({ chute: briel.player.chute, canopy: briel.player.canopy })');
        if (!shotOpen && p.canopy !== null && p.canopy > 2.5) {
          shotOpen = true;
          await shot(`jump-${tag}-canopy`);
        }
        if (p.chute === null) break;
      }
      await b.sleep(700);
      await shot(`jump-${tag}-landed`);
      // Wait for the machine to be home (at the latest AWAY.latest after the jump).
      for (let i = 0; i < 40 && (await b.evaluate('briel.helis.machines[0].away')) !== null; i++) await b.sleep(250);
    }
    const rec = await b.evaluate('(() => { const r = window.__jrec; window.__jrec = null; return r.frames; })()');
    const fresh = await b.evaluate('briel.three.renderer.info.programs.filter((p) => !__progs.has(p.id)).map((p) => p.name + " " + p.cacheKey.slice(0, 120))');
    const programs = fresh.length;
    if (programs) console.log(`  new programs: ${fresh.join(' | ')}`);
    // The closest the player came to the machine in its first 4 s away (shared/heli.mjs heliGap, in the page).
    const closest = await b.evaluate(`Promise.all([import('/shared/heli.mjs'), import('/shared/heli.json')]).then(([m, d]) => { let g = Infinity; for (const f of ${JSON.stringify(rec.filter((f) => f[13] !== null && f[13] < 4))}) g = Math.min(g, m.heliGap({ x: f[10], y: f[11], z: f[12], yaw: f[16], roll: f[17], pitch: f[18] }, (d.default ?? d).size, f[2], f[3], f[4])); return g; })`);
    const k = rec.findIndex((f) => f[5] !== null);
    const start = rec[k] ?? rec[0];
    const open = rec.find((f) => f[6] !== null) ?? null;
    const land = rec.findIndex((f, i) => i > k && f[5] === null);
    // The touchdown's speed: the average descent over the last 0.4 s before it (frames and the game's steps needn't line up).
    const lastAir = land > 1 ? rec[land - 1] : null;
    const before04 = lastAir ? rec.slice(0, land).findLast((f) => lastAir[0] - f[0] >= 400) : null;
    const landSpeed = before04 ? (before04[3] - lastAir[3]) / ((lastAir[0] - before04[0]) / 1000) : NaN;
    // The camera's handover: its largest move in one frame over the first 0.6 s, less what you moved that frame.
    let snap = 0;
    for (let i = Math.max(1, k); i < rec.length && rec[i][0] - start[0] < 600; i++) {
      const a = rec[i - 1], c = rec[i];
      snap = Math.max(snap, Math.hypot(c[7] - a[7], c[8] - a[8], c[9] - a[9]) - Math.hypot(c[2] - a[2], c[3] - a[3], c[4] - a[4]) - Math.hypot(c[10] - a[10], c[11] - a[11], c[12] - a[12]) * (i === k ? 1 : 0));
    }
    const longest = Math.max(...rec.filter((f) => f[0] - start[0] < 1500 && f[0] >= start[0] - 50).map((f) => f[1]));
    const calm = Math.max(0, ...rec.filter((f, i) => i > 1 && f[0] < start[0] - 100).map((f) => f[1]));
    const home = rec.find((f, i) => i > k && f[13] === null) ?? null;
    const firstStep = rec[k + 1]?.[5] ?? Infinity; // the drop's clock after its first step
    const beforeOpen = open ? rec[rec.indexOf(open) - 1]?.[5] ?? 0 : 0; // and on the frame before it opened
    return { h, kmh, before, start, firstStep, beforeOpen, open, land: land > 0 ? rec[land] : null, landSpeed, snap, longest, calm, home, closest, k, programs };
  };

  /** The jumps: heights and speeds, what follows, over the private homes, and what interrupts one. */
  const jumps = async () => {
    const jumpMin = await b.evaluate("import('/shared/parachute.mjs').then((m) => m.DROP.jumpMin)");
    const clearMin = await b.evaluate("import('/shared/parachute.mjs').then((m) => m.DROP.jumpClearMin)");
    row('lowest jump', `${jumpMin} m over the floor below`);
    const parkAt = await b.evaluate('briel.helis.machines[0].park');
    const longest = [];
    for (const [h, kmh] of [[20, 0], [40, 0], [80, 0], [Infinity, 0], [80, 169], [40, 80]]) {
      const j = await jumpFrom(h, kmh);
      const fall = j.open ? (j.open[0] - j.start[0]) / 1000 : NaN;
      const clock = j.open ? j.open[5] : NaN; // the drop's own clock when it opened
      const air0 = j.start[3] - j.start[15];
      const openAir = j.open ? j.open[3] - j.open[15] : NaN;
      const down = j.land ? (j.land[0] - j.start[0]) / 1000 : NaN;
      row(`jump ${Number.isFinite(h) ? `${h} m` : 'at the ceiling'}, ${Math.round(speed(j.before) * 3.6)} km/h`, `from ${r1(air0)} m: free fall ${r1(fall)} s (the drop's clock ${r1(clock)} s, ${r1(air0 - openAir)} m), open at ${r1(openAir)} m; down after ${r1(down)} s at ${r1(j.landSpeed)} m/s, ${r1(j.land ? Math.hypot(j.land[2] - j.start[2], j.land[4] - j.start[4]) : NaN)} m on; machine home ${j.home ? r1((j.home[0] - j.start[0]) / 1000) + ' s' : '-'} after; closest ${r1(j.closest)} m off it; camera step ${r1(j.snap)} m; longest frame ${r1(j.longest)} ms`);
      longest.push(`${r1(j.longest)}${j.calm ? ` (${r1(j.calm)} before)` : ''}`);
      check(j.k >= 0 && !(await b.evaluate('briel.helis.aboard')), `jump ${Number.isFinite(h) ? h : 'ceiling'} m ${kmh} km/h: out, in the drop`);
      check(!!j.open && (air0 <= 45.5 ? (air0 >= clearMin ? j.beforeOpen < 0.4 && clock >= 0.4 - 1e-6 && clock < 0.4 + 0.5 : clock <= j.firstStep + 1e-6) : j.beforeOpen < 1.2 && clock >= 1.2 - 1e-6 && clock < 1.5 + 0.5 && air0 - openAir <= 15), `the canopy opened by itself (${r1(clock)} s in by the drop's clock${air0 <= 45.5 ? (air0 >= clearMin ? ', at the first step past 0.4 s, clear of the machine' : ', at its first step') : ''}, ${r1(fall)} s on the wall)`);
      check(!!j.land && j.landSpeed < 3, `landed under the canopy (${r1(j.landSpeed)} m/s)`);
      check(j.closest > 0.1, `clear of the machine (${r1(j.closest)} m at the closest)`);
      check(j.snap < 3, `no camera snap at the jump (${r1(j.snap)} m in a frame beyond your own move)`);
      check(j.programs <= 0, `no new shader programs from the jump on (${j.programs})`);
      const after = await state();
      check(!!j.home || Math.hypot(after.x - parkAt.x, after.z - parkAt.z) < 1, `the machine is back on its pad (${j.home ? r1((j.home[0] - j.start[0]) / 1000) + ' s after' : 'after the recording'})`);
      const inside = await homes('h.homeAt(p.x, p.z, p.feet)');
      check(inside === null, `landed outside every private home (${inside})`);
    }
    row('longest frame 1.5 s from each jump', `${longest.join(', ')} ms (in brackets: the longest in the 1.5 s flying before it; the graphics chip shared with other work)`);
    // Over each private home and the end house's garden, low: hands off, and steering at its middle.
    for (const [name, x, z] of [['the main house', 4.5, 6], ['the bungalow', 84, 190], ['the end house', 1505.5, -354], ['its garden', 1512, -353]]) {
      for (const steer of [false, true]) {
        await b.evaluate('briel.helis.leaveNow()');
        await b.evaluate(`briel.helis.dev.put({ x: ${x}, z: ${z}, y: 40 }, 1)`);
        await putAir(x, z, 22, 0);
        await b.evaluate('briel.helis.board(briel.helis.machines[0])');
        await b.sleep(800);
        for (let i = 0; i < 3 && (await b.evaluate('briel.helis.aboard')); i++) {
          await use();
          await b.sleep(400);
        }
        const t0 = Date.now();
        let worst = null;
        while (Date.now() - t0 < 30000) {
          if (steer) await b.evaluate(`(() => { const p = briel.player; if (p.chute !== null) p.yaw = Math.atan2(-(${x} - p.x), -(${z} - p.z)); })()`, false);
          if (steer && !phone && !o.pad) await down('KeyW');
          await b.sleep(100);
          const q = await homes('({ chute: p.chute, home: h.homeAt(p.x, p.z, p.feet), x: p.x, z: p.z, feet: p.feet })');
          if (q.home) worst = q;
          if (q.chute === null) break;
        }
        if (steer && !phone && !o.pad) await up('KeyW');
        await b.sleep(300);
        const end = await homes('({ home: h.homeAt(p.x, p.z, p.feet), garden: h.inEndGarden(p.x, p.z, p.feet), x: p.x, z: p.z, feet: p.feet })');
        row(`jump over ${name}${steer ? ', steered at it' : ''}`, `down at ${r1(end.x)}, ${r1(end.z)}, ${r1(end.feet)}; in a home ${end.home ?? 'no'}, in the garden ${end.garden}`);
        check(!end.home && !end.garden && !worst, `a jump over ${name} ends outside it${worst ? ` (inside at ${r1(worst.x)}, ${r1(worst.z)}, ${r1(worst.feet)})` : ''}`);
      }
    }
    // Interrupted: each leaves you in one state (not seated, not dropping twice) and the machine on its pad.
    const consistent = async (what) => {
      await b.sleep(800);
      const q = await b.evaluate('({ aboard: briel.helis.aboard, chute: briel.player.chute, jumped: briel.player.jumped, away: briel.helis.machines[0].away })');
      const m = await state();
      const onPad = Math.hypot(m.x - parkAt.x, m.z - parkAt.z) < 1;
      row(`during a jump: ${what}`, `aboard ${q.aboard}, in a drop ${q.chute !== null}${q.jumped ? ' (the jump)' : ''}, machine ${onPad ? 'on its pad' : q.away !== null ? 'flying home' : 'elsewhere'}`);
      return { ...q, onPad };
    };
    let q;
    await jumpFrom(80, 0, { wait: false, during: () => b.evaluate('briel.respawn(0)', false) });
    q = await consistent('a respawn');
    check(!q.aboard && !q.jumped && q.onPad, 'a respawn: on your feet, the machine home');
    await jumpFrom(80, 0, { wait: false, during: () => b.evaluate("briel.command('/parachute')", false) });
    q = await consistent('/parachute');
    check(!q.aboard && q.jumped && q.chute !== null, '/parachute: refused, the same jump goes on');
    await jumpFrom(80, 0, { wait: false, during: () => b.evaluate("briel.command('/spawn chair')", false) });
    q = await consistent('/spawn chair');
    check(!q.aboard && q.jumped, '/spawn: the jump goes on');
    await jumpFrom(80, 0, { wait: false, during: () => b.evaluate("briel.travel('kerk', 'chat')", false) });
    await b.sleep(4000);
    q = await consistent('chat travel to the church');
    check(!q.aboard && !q.jumped && q.onPad, 'chat travel: on your feet there, the machine home');
    await jumpFrom(80, 0, { wait: false, during: () => b.evaluate("briel.travel('kerk', 'portal')", false) });
    await b.sleep(4000);
    q = await consistent('a portal to the church');
    check(!q.aboard && !q.jumped && (q.onPad || q.away !== null), 'a portal: on your feet there, the machine home or on its way');
    await jumpFrom(80, 0, { wait: false, during: () => b.evaluate("briel.zombiesSolo.start('house')", false).catch(() => {}) });
    await b.sleep(2500);
    q = await consistent('Zombies alone starts');
    check(!q.aboard && !q.jumped && q.onPad, 'Zombies: in the game, the machine home');
    await b.evaluate('briel.zombiesSolo.stop()').catch(() => {});
    await b.sleep(1500);
    if (o.join) {
      // Joining others in the middle of a jump: the jump ends on the floor below, and the page's first states say so.
      await jumpFrom(80, 0, { wait: false });
      await b.sleep(2500);
      const res = await b.evaluate(`(async () => {
        const sent = window.__sent = [];
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (m.t === 'state' && sent.length < 12) sent.push(m); } catch {} return send.call(this, d); };
        const p = briel.player;
        const was = { feet: p.feet, ground: briel.world.groundAt(p.x, p.z, p.feet, 0).y, chute: p.chute, jumped: p.jumped };
        const { api } = await import('/src/net/client.ts');
        const { setAccount } = await import('/src/start.ts');
        const me = await api.join('jumpcheck' + Math.floor(Math.random() * 1000), true);
        setAccount(me);
        return { was, name: me.username };
      })()`);
      await b.sleep(5000);
      const after = await b.evaluate('({ aboard: briel.helis.aboard, chute: briel.player.chute, jumped: briel.player.jumped, x: briel.player.x, z: briel.player.z, feet: briel.player.feet, ground: briel.world.groundAt(briel.player.x, briel.player.z, briel.player.feet + 0.1, 0).y, sent: window.__sent })');
      const ys = after.sent.map((m) => m.y);
      row('joining in the middle of a jump', `as ${res.name}, from ${r1(res.was.feet - res.was.ground)} m up (jump ${res.was.jumped}): aboard ${after.aboard}, in a drop ${after.chute !== null}, feet ${r1(after.feet - after.ground)} m over the floor; first states' y ${ys.map((v) => r1(v)).join(', ')} (floor ${r1(after.ground)}), with the parachute flag ${after.sent.filter((m) => m.pc).length}`);
      check(res.was.jumped && !after.aboard && !after.jumped && after.sent.length > 0 && after.sent.every((m) => !m.pc && Math.abs(m.y - after.ground) < 2), 'a session never begins in a jump: the first states are on the floor, no parachute flag');
      await b.evaluate("import('/src/start.ts').then((m) => m.setAccount(null))").catch(() => {});
    }
    const errors = b.logs.filter((l) => /^exception|^error/.test(l) && !/Failed to load resource/.test(l));
    check(errors.length === 0, `no page errors in the jumps${errors.length ? `: ${errors.slice(0, 5).join(' | ')}` : ''}`);
  };
  if (jumpOnly) {
    await jumps();
    throw 'done';
  }

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
  await controls();
  // Sideways alone (the right arrow): the nose stays; sideways and the turn together (the right arrow with D): it slides
  // sideways while it turns (the two keys are two things now: no cancelling).
  const yaw0 = (await state()).yaw;
  await down('ArrowRight');
  await b.sleep(8000);
  const slid = await state();
  await up('ArrowRight');
  const sideOf = (q) => Math.abs(q.vx * Math.cos(q.yaw) - q.vz * Math.sin(q.yaw)); // speed along the machine's right
  row('the right arrow alone 8 s', `nose turned ${deg(Math.atan2(Math.sin(slid.yaw - yaw0), Math.cos(slid.yaw - yaw0)))} deg, ${r1(sideOf(slid))} m/s sideways`);
  check(Math.abs(Math.atan2(Math.sin(slid.yaw - yaw0), Math.cos(slid.yaw - yaw0))) < 0.02, 'sideways alone the nose stays where it was');
  await b.sleep(4000);
  let prevYaw = (await state()).yaw, turnedRight = 0, fastest = 0;
  await down('KeyD', 'ArrowRight');
  const both = (await until((q) => {
    turnedRight -= turnBy(q.yaw, prevYaw);
    prevYaw = q.yaw;
    fastest = Math.max(fastest, speed(q));
    return false;
  }, 3, 100)).at(-1);
  await up('KeyD', 'ArrowRight');
  row('the right arrow with D 3 s', `up to ${r1(fastest)} m/s over the ground (${r1(sideOf(both))} along its right at the end) while turning ${deg(turnedRight)} deg right`);
  check(fastest > 3 && turnedRight > 0.5, 'the right arrow with D slides it sideways while it turns');
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
  // Getting out low in the air: refused, the line says to fly higher (to jump) or to land (after 2.5 s still: a hover
  // is not at rest). Higher up the same key jumps (below).
  {
    const at = await state();
    await putAir(at.x, at.z, 6, at.yaw);
    await b.sleep(2500);
    await tap('KeyE');
    await b.sleep(200);
    const air = await prompt();
    check(await b.evaluate('briel.helis.aboard') && /land/i.test(air), `no getting out or jumping 6 m up ("${air}")`);
    await putAir(at.x, at.z, at.h, at.yaw);
  }
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

  // The church's landing deck (the church's own, with the village), a landing from 12 m over it after a sidestep; the
  // church's own machine waits on the square below meanwhile (tools/dev/heliPad.mjs flies that one from its deck).
  if (phone) await b.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }).catch(() => {}); // no button left held from before (none may be)
  await b.waitFor("briel.village() === 'ready'", 240000);
  await b.evaluate("briel.helis.dev.put({ x: 536, z: -764.5, yaw: 0 }, 0, 1)");
  const pad = await b.evaluate("briel.helis.dev.put('church', 1)");
  await b.evaluate(`briel.teleport(${pad.x}, ${pad.z}, ${pad.y}, 0)`, false);
  await b.evaluate('briel.helis.board(briel.helis.machines[0])');
  await lift(true);
  await until((s) => s.h > 12, 10);
  await lift(false);
  await down('ArrowRight');
  await b.sleep(400); // a short step aside (the deck is 6 m wide); the pad's pull brings it back over the middle
  await up('ArrowRight');
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
  // The game's fence keeps you off the pad (it lies outside it); within reach the line says why not.
  const zDist = await b.evaluate('briel.helis.machines[0].distanceTo(briel.player.x, briel.player.z)');
  const zLine = await prompt();
  check(!(await b.evaluate('briel.helis.aboard')) && (zDist > 1.5 || /game/i.test(zLine)), `no boarding in Zombies (${zDist > 1.5 ? `out of reach behind the game's fence, ${r1(zDist)} m from it` : `"${zLine}"`})`);
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
  await jumps();
  const errors = b.logs.filter((l) => /^exception|^error/.test(l) && !/Failed to load resource/.test(l));
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 5).join(' | ')}` : ''}`);
} catch (e) {
  if (e !== 'done') {
    console.error(e);
    failed = true;
  }
} finally {
  b.close();
}
process.exit(failed ? 1 : 0);
