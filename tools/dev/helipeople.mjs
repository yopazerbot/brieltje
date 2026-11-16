// The people in the helicopter (world/heliPeople.ts), alone, on a running dev server: getting in (your figure in the
// pilot's seat at once, no new shader program, no long frame), the pilot's view (your figure not drawn, nothing of you
// in the way), out again (no figure); how the seated figures fit in all four seats (heliPeople.report: nothing through
// the roof, the glass or a door, nor into a seat, the panel or a neighbour; head room; the hands on the grips and the
// feet where they go), on the pad and in a banked turn (roll 0.6, pitch 0.4); the pilot's hands at the sticks' full
// deflections (as they would be once the sticks are drawn moving); and pictures of it all.
//
//   node tools/dev/helipeople.mjs --url http://localhost:5437/ --port 9733 --out <folder> [--quality high|low]
//     [--mood sunny|night] [--phone] [--swiftshader] [--quick] [--bench [--pairs 6]]
//
// --quick: the hands and feet only, not the rays against the shell, the seats and the others (those take about half a
// minute a figure): for the pictures in other settings.
// --bench: the draw calls with 0, 1 and 4 seated and the graphics chip's time per frame (its timer queries, as
// tools/dev/gpubench.mjs) 15 m from the machine, four seated figures on and off in turn (A, B, A, B: the chip is shared),
// then a second machine beside it (a dev copy, never in heli.json) with eight; on High, Medium and Low.
// Pass your own --port. Exits 1 when a check fails.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5173/', port: '9733', out: '', quality: 'high', mood: 'sunny', phone: false, swiftshader: false, bench: false, pairs: '6', quick: false });
const quick = !!o.quick && o.quick !== 'false';
const out = o.out || null;
if (out) mkdirSync(out, { recursive: true });
const phone = !!o.phone && o.phone !== 'false';
let failed = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};
const tag = `${o.quality}_${o.mood}${phone ? '_phone' : ''}${o.swiftshader ? '_swiftshader' : ''}`;
const COLOURS = ['#2f6fd8', '#d8452f', '#3fae4a', '#e8c23a'];

const b = await launch({ port: Number(o.port), width: 1280, height: 720, swiftshader: !!o.swiftshader && o.swiftshader !== 'false' });
console.log('browser pid', b.pid);
const shot = async (name) => {
  if (out) await b.screenshot(join(out, `${name}_${tag}.png`));
};
const CODES = { KeyE: ['e', 69], KeyI: ['i', 73] };
const tap = async (code) => {
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: CODES[code][0], windowsVirtualKeyCode: CODES[code][1] });
  await b.sleep(80);
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: CODES[code][0], windowsVirtualKeyCode: CODES[code][1] });
};
try {
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('briel.graphics','${o.quality}');localStorage.setItem('briel.lang','en');localStorage.setItem('briel.spawn','house');localStorage.setItem('briel.playMode','explore');localStorage.setItem('briel.feedback','later');` }); // the preset from the start (its warm-up), no feedback card in the middle of a run
  await startGame(b, o.url, { phone });
  await b.evaluate("document.getElementById('cc-close')?.click()", false);
  await b.evaluate(`(() => {
    window.__mi = 0; // the machine looked at: 0 the house's, 1 the church's
    window.__m = () => briel.helis.machines[__mi];
    window.__own = () => !!briel.heliPeople.own?.root.visible;
    window.__programs = () => briel.three.renderer.info.programs.length;
    window.__frames = [];
    let last = performance.now();
    const f = (t) => { window.__frames.push([t, t - last]); last = t; requestAnimationFrame(f); };
    requestAnimationFrame(f);
    // The camera held where __look puts it (the game's own is set again just before each render; __look(null) lets it go).
    const comp = briel.three.composer;
    const cam = comp.passes.find((p) => p.camera && p.camera.isPerspectiveCamera)?.camera;
    window.__view = null;
    const render = comp.render.bind(comp);
    comp.render = (dt) => {
      const v = window.__view;
      if (v && cam) {
        cam.position.set(v[0], v[1], v[2]);
        cam.fov = v[6];
        cam.updateProjectionMatrix();
        cam.lookAt(v[3], v[4], v[5]);
        cam.updateMatrixWorld(true);
      }
      return render(dt);
    };
    // A view of the machine from its own frame: the camera at (x, y, z) and looking at (tx, ty, tz), metres in the model's frame.
    window.__look = (at, to, fov = 35) => {
      if (!at) { window.__view = null; return; }
      const m = __m().cabin(new (briel.three.scene.matrix.constructor)()) ?? null;
      const w = (p) => { const v = new (briel.three.scene.position.constructor)(...p); if (m) v.applyMatrix4(m); return [v.x, v.y, v.z]; };
      window.__view = [...w(at), ...w(to), fov];
    };
    // The machine leant (pitch, roll) and raised by dy, as in a banked turn; still (nobody flies it).
    window.__lean = (pitch, roll, dy = 0) => { const m = __m(); m.s.pitch = pitch; m.s.roll = roll; window.__baseY ??= m.s.y; m.s.y = window.__baseY + dy; m.pose(); };
  })()`, false);
  await b.waitFor('briel.helis.machines[0].ready', 60000);
  await b.evaluate(`briel.three.applyQuality(${JSON.stringify(o.quality === 'medium' ? 'medium' : o.quality)}); briel.three.holdQuality?.(true)`, false);
  if (o.mood !== 'sunny') {
    await b.evaluate(`briel.three.weather.setSolo(${JSON.stringify(o.mood)})`, false);
    await b.sleep(20000); // the mood blends in
  }
  await b.evaluate("(() => { const st = document.createElement('style'); st.textContent = '#credit, #sound-btn, #map-btn, #capture-hint { visibility: hidden !important; }'; document.head.appendChild(st); })()", false);

  // Getting in: beside the cabin, the use key (or the touch button). Your figure at once; no new program, no long frame.
  const s0 = JSON.parse(await b.evaluate('JSON.stringify(__m().s)'));
  await b.evaluate(`briel.teleport(${s0.x + 2.0}, ${s0.z - 0.6}, ${s0.y}, 1.2)`, false);
  // Until the page has settled (no program made for 4 s: the tiles and the village come in meanwhile), at most a minute.
  for (let last = -1, still = 0, t = 0; still < 8 && t < 120; t++) {
    await b.sleep(500);
    const n = await b.evaluate('__programs()');
    still = n === last ? still + 1 : 0;
    last = n;
  }
  const before = await b.evaluate('__programs()');
  await b.evaluate('window.__names = new Set(briel.three.renderer.info.programs.map((p) => p.cacheKey))', false);
  const t0 = await b.evaluate('performance.now()');
  if (phone) await b.evaluate("briel.helis.board(__m())", false);
  else await tap('KeyE');
  await b.sleep(3000);
  const first = JSON.parse(await b.evaluate(`(() => {
    const frames = __frames.filter(([t]) => t > ${t0}).map(([, d]) => d);
    const made = briel.three.renderer.info.programs.filter((p) => !__names.has(p.cacheKey)).map((p) => p.name + ' ' + p.cacheKey.slice(0, 60));
    return JSON.stringify({ aboard: briel.helis.aboard, seats: __m().seats, own: __own(), after: __programs(), made, worst: Math.max(...frames), over50: frames.filter((d) => d > 50).length, n: frames.length });
  })()`));
  check(first.aboard && first.own, 'getting in: your figure in the pilot\'s seat at once', JSON.stringify(first.seats));
  check(first.after === before, 'getting in: no new shader program', `${before} -> ${first.after} ${JSON.stringify(first.made)}`);
  // In software (SwiftShader) every frame is long: the number only.
  if (o.swiftshader) console.log(`  getting in: worst frame ${first.worst.toFixed(1)} ms of ${first.n} (SwiftShader)`);
  else check(first.over50 === 0, 'getting in: no frame over 50 ms in the next 3 s', `worst ${first.worst.toFixed(1)} ms of ${first.n}`);
  await shot('pilot_chase');
  const alone = JSON.parse(await b.evaluate('JSON.stringify(briel.heliPeople.report(__m(), { rays: false }))'));
  for (const r of alone) console.log(`  you, flying: ${JSON.stringify(r)}`);

  // The pilot's view: your figure not drawn (leant over the sticks, its shoulders would be in front of the eye).
  if (phone) await b.evaluate("__m().view = 'cockpit'", false);
  else await tap('KeyI');
  await b.sleep(1200);
  const cockpit = JSON.parse(await b.evaluate("JSON.stringify({ view: __m().view, own: __own() })"));
  check(cockpit.view === 'cockpit' && !cockpit.own, "the pilot's view: your own figure not drawn", JSON.stringify(cockpit));
  await shot('pilot_view');
  await b.evaluate("(() => { const c = briel.helis.machines[0]; c.lookPitch = -0.6; })()", false);
  await b.sleep(600);
  await shot('pilot_view_down');
  await b.evaluate("(() => { const c = briel.helis.machines[0]; c.lookPitch = 0; c.view = 'chase'; })()", false);
  await b.sleep(800);
  check(await b.evaluate('__own()'), 'back in the chase view: your figure drawn again');

  // Out again: no figure in the seat in the frame you stand.
  // Each frame (after it is drawn): aboard, and your seated figure shown.
  await b.evaluate(`(() => {
    window.__seen = [];
    const watch = () => { __seen.push([briel.helis.aboard, !!briel.heliPeople.own?.root.visible]); if (__seen.length < 90) requestAnimationFrame(watch); };
    requestAnimationFrame(watch);
  })()`, false);
  if (phone) await b.evaluate('briel.helis.leave(briel.three.scene.position.clone())', false);
  else await tap('KeyE');
  await b.sleep(1600);
  const outNow = JSON.parse(await b.evaluate("JSON.stringify({ aboard: briel.helis.aboard, seats: __m().seats, own: __own(), both: __seen.filter(([a, v]) => !a && v).length, frames: __seen.length })"));
  check(!outNow.aboard && !outNow.own && outNow.seats[0] === null, 'out again: no figure in the seat, the seat empty', JSON.stringify(outNow));
  check(outNow.both === 0, 'out again: no frame with you on your feet and your figure still seated', `${outNow.both} of ${outNow.frames}`);

  // Everyone aboard (dummies in all four seats): the fit on the pad, in a banked turn, at the sticks' full deflections.
  await b.evaluate(`(() => { briel.teleport(__m().s.x + 16, __m().s.z + 6, __m().s.y, 1.2); ${JSON.stringify(COLOURS)}.forEach((c, i) => briel.heliPeople.dummy(__m(), i, c)); })()`, false);
  await b.sleep(1500);
  const judge = (rows, where) => {
    for (const r of rows) {
      const who = r.seat ? `passenger ${r.seat}` : 'pilot';
      console.log(`  ${where} ${who}: ${JSON.stringify(r)}`);
      if (!quick) check(r.pokes === 0, `${where} ${who}: nothing through the roof, the glass or a door`, `${r.pokes} of ${r.checked}${r.where.length ? ' at ' + JSON.stringify(r.where) : ''}`);
      if (!quick) check(r.deepest < 0.03, `${where} ${who}: nothing deeper than 3 cm in a seat or the panel`, `${r.inside} in, deepest ${r.deepest}${r.within.length ? ' at ' + JSON.stringify(r.within) : ''}`);
      if (!quick) check(r.headRoom !== null && r.headRoom >= 0.03, `${where} ${who}: head room at least 3 cm`, String(r.headRoom));
      if (!quick) check(r.neighbour === null || r.neighbour >= 0.04, `${where} ${who}: clear of the others aboard`, String(r.neighbour));
      check(Math.max(...r.ankleGap) < 0.03, `${where} ${who}: the feet where they go`, JSON.stringify(r.ankleGap));
      check(Math.max(...r.wristGap) < 0.03, `${where} ${who}: the hands where they go`, JSON.stringify(r.wristGap));
      if (r.stick !== null) check(r.stick >= 0.03, `${where} ${who}: the cyclic's shaft clear of the legs`, String(r.stick));
    }
  };
  // The rays take about half a minute a figure; --quick: the hands and feet only.
  const report = (opts = { rays: !quick }) => b.evaluate(`JSON.stringify(briel.heliPeople.report(__m(), ${JSON.stringify(opts)}))`).then(JSON.parse);
  judge(await report(), 'pad');
  // The views round it: the camera held in the model's frame (front, both sides, behind, above).
  const VIEWS = {
    front: [[0.4, 1.9, -8.5], [0, 1.45, -0.6], 32],
    left: [[-6.5, 1.8, -0.6], [0, 1.4, -0.6], 38],
    right: [[6.5, 1.8, -0.6], [0, 1.4, -0.6], 38],
    behind_left: [[-4.5, 2.6, 3.5], [0, 1.5, -0.8], 40],
    above: [[2.2, 5.8, -3.5], [0, 1.2, -0.6], 40],
    chase: [[1.2, 4.5, 11.5], [0, 2.2, 0], 55],
  };
  for (const [name, [at, to, fov]] of Object.entries(VIEWS)) {
    await b.evaluate(`__look(${JSON.stringify(at)}, ${JSON.stringify(to)}, ${fov})`, false);
    await b.sleep(500);
    await shot(`four_${name}`);
  }
  // A banked turn: leant right and nose down, 4 m up.
  await b.evaluate('__lean(0.4, 0.6, 4)', false);
  await b.sleep(600);
  judge(await report(), 'banked');
  for (const name of ['front', 'left', 'chase']) {
    const [at, to, fov] = VIEWS[name];
    await b.evaluate(`__look(${JSON.stringify(at)}, ${JSON.stringify(to)}, ${fov})`, false);
    await b.sleep(400);
    await shot(`banked_${name}`);
  }
  // Banked the other way (the pilot alone: the knees swing towards the stick the other way round).
  await b.evaluate('__lean(0.4, -0.6, 4)', false);
  await b.sleep(600);
  judge(await report({ seat: 0, rays: !quick }), 'banked left');
  await b.evaluate('__lean(0, 0, 0)', false);
  // The sticks at full deflection: the pilot's hands with them (once the sticks are drawn moving).
  await b.evaluate('briel.heliPeople.sticksMove = true', false);
  const corners = [[0.5, 0, 0], [-0.5, 0, 0], [0, 0.5, 0], [0, -0.5, 0], [0, 0, 1]];
  for (const [pitch, roll, coll] of corners) {
    await b.evaluate(`(() => { const m = __m(); m.s.pitch = ${pitch}; m.s.roll = ${roll}; m.s.coll = ${coll}; m.pose(); })()`, false);
    await b.sleep(500);
    const r = (await report({ seat: 0, rays: false }))[0];
    const where = `sticks ${pitch > 0 ? 'forward' : pitch < 0 ? 'back' : roll > 0 ? 'right' : roll < 0 ? 'left' : 'lever up'}`;
    console.log(`  ${where} pilot: ${JSON.stringify({ wristGap: r.wristGap, wrists: r.wrists, hands: r.hands })}`);
    check(Math.max(...r.wristGap) < 0.03, `${where}: the pilot's hands on the grips`, JSON.stringify(r.wristGap));
  }
  await b.evaluate('(() => { const m = __m(); m.s.pitch = m.s.roll = m.s.coll = 0; m.pose(); briel.heliPeople.sticksMove = false; })()', false);
  // The pilot alone in the dummies' place (your figure's colour), looking from outside.
  for (let i = 1; i < 4; i++) await b.evaluate(`briel.heliPeople.dummy(__m(), ${i}, null)`, false);
  await b.evaluate(`__look(${JSON.stringify(VIEWS.right[0])}, ${JSON.stringify(VIEWS.right[1])}, 38)`, false);
  await b.sleep(500);
  await shot('pilot_right');
  await b.evaluate(`(() => { briel.heliPeople.dummy(__m(), 0, null); __look(null); })()`, false);
  await b.sleep(800);
  check(await b.evaluate('!briel.heliPeople.occupied.has(__m())'), 'all out: the machine empty again');

  // Every way out of the pilot's seat empties it, in both machines (the house's and the church's): getting out, the
  // jump (pictured: the empty seat once the machine is home), a respawn (as after a death), a game gathering everyone
  // (the machine home). The pilot from outside and from the chase view in each.
  const seatState = (what) => b.evaluate(`(async () => { await new Promise((r) => setTimeout(r, 400)); return JSON.stringify({ what: ${JSON.stringify(what)}, aboard: briel.helis.aboard, seat: __m().seats[0], own: !!briel.heliPeople.own?.root.visible, seated: briel.heliPeople.occupied.has(__m()) }); })()`).then(JSON.parse);
  const empty = (r) => check(!r.aboard && r.seat === null && !r.own && !r.seated, `machine ${mi}: ${r.what}: the pilot's seat empty, no figure in it`, JSON.stringify(r));
  const boardIt = async () => {
    await b.evaluate(`(() => { const m = __m(); briel.teleport(m.s.x + Math.cos(m.s.yaw) * 2.2, m.s.z - Math.sin(m.s.yaw) * 2.2, m.s.y, m.s.yaw); })()`, false);
    await b.sleep(1200);
    await b.evaluate('briel.helis.board(__m())', false);
    await b.sleep(800);
    return b.evaluate("__m().seats[0] === '' && !!briel.heliPeople.own?.root.visible");
  };
  let mi = 0;
  for (mi of [0, 1]) {
    await b.evaluate(`window.__mi = ${mi}`, false);
    if (mi === 1) await b.sleep(8000); // the church's square comes in
    check(await boardIt(), `machine ${mi}: in, your figure in the pilot's seat`);
    await b.evaluate(`__look(${JSON.stringify(VIEWS.right[0])}, ${JSON.stringify(VIEWS.right[1])}, 38)`, false);
    await b.sleep(600);
    await shot(`m${mi}_pilot_outside`);
    await b.evaluate('__look(null)', false);
    await b.sleep(1200);
    await shot(`m${mi}_pilot_chase`);
    await b.evaluate('briel.helis.leave(briel.three.scene.position.clone())', false);
    empty(await seatState('getting out'));
    // The jump: lifted 40 m in one step (as if flown there), then the use key's way out in the air.
    check(await boardIt(), `machine ${mi}: in again`);
    await b.evaluate('(() => { const m = __m(); m.s.y += 40; m.s.h = 40; m.s.ground = false; m.s.engine = true; m.s.rotor = 1; briel.helis.leave(briel.three.scene.position.clone()); })()', false);
    empty(await seatState('the jump'));
    await b.sleep(1500);
    await b.evaluate('briel.helis.leaveNow()', false); // the drop ended: the machine back on its pad
    await b.sleep(1500);
    await b.evaluate(`__look(${JSON.stringify(VIEWS.right[0])}, ${JSON.stringify(VIEWS.right[1])}, 38)`, false);
    await b.sleep(600);
    await shot(`m${mi}_empty_after_jump`);
    await b.evaluate('__look(null)', false);
    check(await boardIt(), `machine ${mi}: in again after the jump`);
    await b.evaluate('briel.respawn(0)', false);
    empty(await seatState('a respawn'));
    await b.evaluate(`window.__mi = ${mi}`, false);
    check(await boardIt(), `machine ${mi}: in again after the respawn`);
    await b.evaluate('briel.helis.leaveNow(true)', false);
    empty(await seatState('a game gathering everyone (the machine home)'));
  }
  await b.evaluate('window.__mi = 0', false);

  if (o.bench) {
    // 15 m from the machine, from its front-right, a little above, the whole machine in view.
    const time = () => b.evaluate(`(async () => {
      const t = briel.three, gl = t.renderer.getContext();
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      const info = t.renderer.info;
      const auto = info.autoReset;
      info.autoReset = false;
      info.reset();
      t.composer.render(1 / 60);
      const { calls } = info.render;
      info.autoReset = auto;
      if (!ext) return JSON.stringify({ p50: NaN, calls, programs: info.programs.length });
      const qs = [];
      for (let i = 0; i < 240; i++) {
        const qy = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, qy);
        t.composer.render(1 / 60);
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        qs.push(qy);
        if (i % 8 === 7) await new Promise((res) => setTimeout(res, 0));
      }
      const px = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      await new Promise((res) => setTimeout(res, 300));
      const ms = [];
      for (const qy of qs) {
        if (gl.getQueryParameter(qy, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(ext.GPU_DISJOINT_EXT)) ms.push(gl.getQueryParameter(qy, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(qy);
      }
      ms.sort((a, b) => a - b);
      return JSON.stringify({ p50: ms[Math.floor(0.5 * (ms.length - 1))], calls, programs: info.programs.length });
    })()`).then(JSON.parse);
    const people = (n, machines = 1) => b.evaluate(`(() => { const ms = briel.helis.machines.slice(0, ${machines}); for (const m of briel.helis.machines) for (let i = 0; i < 4; i++) briel.heliPeople.dummy(m, i, ms.includes(m) && i < ${n} ? ${JSON.stringify(COLOURS)}[i] : null); })()`, false);
    const median = (v) => [...v].sort((a, z) => a - z)[Math.floor((v.length - 1) / 2)];
    await b.evaluate(`__look([9.5, 4, -11.5], [0, 1.4, -0.5], 50)`, false);
    for (const q of ['high', 'medium', 'low']) {
      await b.evaluate(`briel.three.applyQuality('${q}')`, false);
      await b.sleep(1500);
      await people(4);
      await b.sleep(1000);
      await b.evaluate('briel.bench(60)', false); // warm-up, with the figures
      const calls = [];
      for (const n of [0, 1, 4]) {
        await people(n);
        await b.sleep(600);
        calls.push(`${n}: ${(await time()).calls}`);
      }
      console.log(`  ${q} draw calls by figures seated: ${calls.join(', ')}`);
      const rows = { off: [], on: [] };
      for (let p = 0; p < Number(o.pairs); p++) {
        for (const on of p % 2 ? [true, false] : [false, true]) {
          await people(on ? 4 : 0);
          await b.sleep(700);
          const r = await time();
          rows[on ? 'on' : 'off'].push(r.p50);
          console.log(`  ${q} pair ${p + 1} ${on ? 'four aboard' : 'empty     '}: p50 ${r.p50.toFixed(3)} ms, ${r.calls} calls, ${r.programs} programs`);
        }
      }
      console.log(`${q}: median of the medians, empty ${median(rows.off).toFixed(3)} ms, four aboard ${median(rows.on).toFixed(3)} ms`);
    }
    // The church's machine put down 14 m to the right of the house's (a dev hook), eight aboard against none.
    await b.evaluate(`(() => {
      const a = __m();
      briel.helis.dev.put({ x: a.s.x + Math.cos(a.s.yaw) * 14, z: a.s.z - Math.sin(a.s.yaw) * 14, y: a.s.y, yaw: a.s.yaw }, 0, 1);
    })()`, false);
    await b.waitFor('briel.helis.machines[1].ready', 30000);
    await b.evaluate(`__look([16, 5, -15], [7, 1.4, -0.5], 55)`, false);
    for (const q of ['high', 'low']) {
      await b.evaluate(`briel.three.applyQuality('${q}')`, false);
      await b.sleep(1500);
      await people(4, 2);
      await b.sleep(1000);
      await b.evaluate('briel.bench(60)', false);
      await shot(`bench2_${q}`);
      const rows = { off: [], on: [] };
      for (let p = 0; p < Number(o.pairs); p++) {
        for (const on of p % 2 ? [true, false] : [false, true]) {
          await people(on ? 4 : 0, 2);
          await b.sleep(700);
          const r = await time();
          rows[on ? 'on' : 'off'].push(r.p50);
          console.log(`  ${q} pair ${p + 1} ${on ? 'eight aboard' : 'empty      '}: p50 ${r.p50.toFixed(3)} ms, ${r.calls} calls, ${r.programs} programs`);
        }
      }
      console.log(`${q}, two machines: median of the medians, empty ${median(rows.off).toFixed(3)} ms, eight aboard ${median(rows.on).toFixed(3)} ms`);
    }
    await people(0, 2);
  }
  if (out) writeFileSync(join(out, `done_${tag}.txt`), failed ? `${failed} failed\n` : 'ok\n');
  const errors = b.logs.filter((l) => /^(error|exception)/.test(l));
  check(errors.length === 0, 'no errors on the page', errors.slice(0, 3).join(' | '));
} finally {
  b.close();
}
process.exit(failed ? 1 : 0);
