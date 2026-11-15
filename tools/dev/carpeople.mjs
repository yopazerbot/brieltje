// The people in the Teslas (world/carPeople.ts), alone, on a running dev server: getting in the Model Y and the Model 3
// (your figure seated at once, the lighter glass, no new shader program), out again (no figure, the dark glass), how
// the seated figures fit (carPeople.report: nothing through the roof, the glass or a door; head room; the hands and
// feet where they go), and the wheel turned full left and full right (the hands round the rim, the heads with it).
//
//   node tools/dev/carpeople.mjs --url http://localhost:5460/ --port 9721 --out <folder> [--quality high|low] [--phone]
//     [--bench] [--pairs 6]
//
// --bench: the graphics chip's time per frame (its timer queries, as tools/dev/gpubench.mjs) with all four cars on the
// road in view, eight seated figures on and off in turn (A, B, A, B: the chip is shared), on High and on Low.
// Pass your own --port. Exits 1 when a check fails.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5173/', port: '9721', out: '', quality: 'high', phone: false, bench: false, pairs: '6' });
const out = o.out || null;
if (out) mkdirSync(out, { recursive: true });
let failed = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
};

const b = await launch({ port: Number(o.port), width: 1280, height: 720 });
console.log('browser pid', b.pid);
try {
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('briel.lang','en');localStorage.setItem('briel.spawn','house');localStorage.setItem('briel.playMode','explore');" });
  await startGame(b, o.url, { phone: o.phone, village: o.bench });
  await b.evaluate("document.getElementById('cc-close')?.click()", false);
  // Helpers in the page: the dark glass's opacity on a car's full model, your figure shown, frames timed.
  await b.evaluate(`(() => {
    window.__glass = (c) => { let v = null; c.group.traverse((m) => { if (v !== null || !m.isMesh || m.userData.part !== 'GlassDark') return; for (let p = m; p; p = p.parent) if (p.name === 'Far') return; v = m.material.opacity; }); return v; };
    window.__own = () => !!briel.carPeople.own?.root.visible;
    window.__programs = () => briel.three.renderer.info.programs.length;
    window.__frames = [];
    let last = performance.now();
    const f = (t) => { window.__frames.push([t, t - last]); last = t; requestAnimationFrame(f); };
    requestAnimationFrame(f);
  })()`, false);

  // In the first seconds of play: into the Model Y where it is parked at the house. No frame over 50 ms, no new program.
  await b.waitFor('briel.cars[0].wheels.length === 4');
  const first = JSON.parse(await b.evaluate(`(async () => {
    const c = briel.cars[0];
    const at = c.exitSpot(false);
    briel.teleport(at.x, at.z, c.y);
    await new Promise((r) => setTimeout(r, 300));
    const before = __programs();
    const t0 = performance.now();
    briel.getIn();
    await new Promise((r) => setTimeout(r, 3000));
    const frames = __frames.filter(([t]) => t > t0).map(([, d]) => d);
    const res = { inCar: briel.currentCar() === c, own: __own(), before, after: __programs(), worst: Math.max(...frames), over50: frames.filter((d) => d > 50).length, n: frames.length };
    briel.getOut();
    return JSON.stringify(res);
  })()`));
  check(first.inCar && first.own, 'the first get-in: your figure seated at once');
  check(first.after === first.before, 'the first get-in: no new shader program', `${first.before} -> ${first.after}`);
  check(first.over50 === 0, 'the first get-in: no frame over 50 ms in the next 3 s', `worst ${first.worst.toFixed(1)} ms of ${first.n}`);

  await b.evaluate(`briel.three.applyQuality(${JSON.stringify(o.quality)}); briel.three.holdQuality?.(true)`, false);
  // A straight road in the fields (as tools/dev/carshots.mjs); the cars on it 14 m apart, facing along it. The camera can be
  // held where __look puts it (the game's own camera is set again just before each render; __look(null) lets it go).
  const road = { x: 636.6, z: 142.6, dx: 668.9 - 636.6, dz: 355.8 - 142.6 };
  const len = Math.hypot(road.dx, road.dz);
  const [ux, uz] = [road.dx / len, road.dz / len];
  const n = o.bench ? 4 : 2;
  const spots = JSON.parse(await b.evaluate(`(() => {
    const res = [];
    for (let i = 0; i < ${n}; i++) {
      const x = ${road.x} + ${ux} * (20 + i * 14), z = ${road.z} + ${uz} * (20 + i * 14);
      const g = briel.world.groundAt(x, z, 50, 0.3);
      briel.cars[i].place(x, g.y, z, Math.atan2(${-ux}, ${-uz}));
      res.push({ x, y: g.y, z });
    }
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
    window.__look = (cx, cy, cz, tx, ty, tz, fov = 30) => {
      if (cx === null) { window.__view = null; briel.player.flying = false; return; }
      const dx = tx - cx, dz = tz - cz;
      briel.teleport(cx, cz, cy - 1.65, Math.atan2(-dx, -dz), Math.atan2(ty - cy, Math.hypot(dx, dz)));
      briel.player.flying = true;
      window.__view = [cx, cy, cz, tx, ty, tz, fov];
    };
    return JSON.stringify(res);
  })()`, false));
  await b.evaluate("(() => { const st = document.createElement('style'); st.textContent = '#credit, #sound-btn, #map-btn { visibility: hidden !important; }'; document.head.appendChild(st); })()", false);
  await b.sleep(8000); // the tiles round the road load

  if (!o.bench) {
    for (let i = 0; i < 2; i++) {
      const tag = i ? 'm3' : 'my';
      // You at the wheel, then out again.
      const inside = JSON.parse(await b.evaluate(`(async () => {
        const c = briel.cars[${i}];
        const at = c.exitSpot(false);
        briel.teleport(at.x, at.z, c.y);
        await new Promise((r) => setTimeout(r, 500));
        const before = __programs();
        briel.getIn();
        await new Promise((r) => setTimeout(r, 1500));
        return JSON.stringify({ inCar: briel.currentCar() === c, own: __own(), glass: __glass(c), before, after: __programs(), fit: briel.carPeople.report(c) });
      })()`));
      check(inside.inCar && inside.own, `${tag}: at the wheel, your figure shown`);
      check(Math.abs(inside.glass - 0.82) < 1e-6, `${tag}: the lighter dark glass`, String(inside.glass));
      check(inside.after === inside.before, `${tag}: no new shader program`, `${inside.before} -> ${inside.after}`);
      console.log(`  ${tag} your figure: ${JSON.stringify(inside.fit[0])}`);
      if (out) await b.screenshot(join(out, `${tag}_driving_chase.png`));
      const outside = JSON.parse(await b.evaluate(`(async () => {
        const c = briel.cars[${i}];
        briel.getOut();
        await new Promise((r) => setTimeout(r, 800));
        return JSON.stringify({ own: __own(), glass: __glass(c), occupied: briel.carPeople.occupied.has(c) });
      })()`));
      check(!outside.own && Math.abs(outside.glass - 0.96) < 1e-6 && !outside.occupied, `${tag}: out again, no figure, the dark glass`, JSON.stringify(outside));

      // Both seats (dummies), and the wheel full left and full right.
      const fit = JSON.parse(await b.evaluate(`(async () => {
        const c = briel.cars[${i}];
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        briel.carPeople.dummy(c, 0, '#2f6fd8');
        briel.carPeople.dummy(c, 1, '#d8452f');
        await wait(800);
        const straight = briel.carPeople.report(c);
        c.steer = 0.62;
        await wait(1200);
        const left = briel.carPeople.report(c);
        c.steer = -0.62;
        await wait(1200);
        const right = briel.carPeople.report(c);
        c.steer = 0;
        await wait(600);
        return JSON.stringify({ straight, left, right });
      })()`));
      for (const r of fit.straight) {
        const who = r.seat ? 'passenger' : 'driver';
        console.log(`  ${tag} ${who}: ${JSON.stringify(r)}`);
        check(r.pokes === 0, `${tag} ${who}: nothing through the roof, the glass or a door`, `${r.pokes} of ${r.checked}${r.where.length ? ' at ' + JSON.stringify(r.where) : ''}`);
        check(r.headRoom !== null && r.headRoom >= 0.03, `${tag} ${who}: head room at least 3 cm`, String(r.headRoom));
        check(Math.max(...r.ankleGap) < 0.03, `${tag} ${who}: the feet on the floor`, JSON.stringify(r.ankleGap));
        check(Math.max(...r.wristGap) < 0.03, `${tag} ${who}: the hands where they go`, JSON.stringify(r.wristGap));
      }
      const d = (s) => fit[s].find((r) => r.seat === 0);
      // Full left: the left hand goes down the rim and the right one up (the wheel turns anticlockwise), the heads to the left.
      const [l, s0, r] = [d('left'), d('straight'), d('right')];
      check(l.hands[0][1] < s0.hands[0][1] && l.hands[1][1] > s0.hands[1][1] && r.hands[0][1] > s0.hands[0][1] && r.hands[1][1] < s0.hands[1][1], `${tag}: the hands go round the rim with the wheel`, `left hand y ${l.hands[0][1]} / ${s0.hands[0][1]} / ${r.hands[0][1]}`);
      check(l.look > 0.1 && r.look < -0.1, `${tag}: the heads turn with the wheel`, `${l.look} / ${r.look}`);
      await b.evaluate(`(() => { const c = briel.cars[${i}]; briel.carPeople.dummy(c, 0, null); briel.carPeople.dummy(c, 1, null); })()`, false);
    }
    if (out) writeFileSync(join(out, 'done.txt'), 'ok\n');
  } else {
    // Four cars in a row, seen from behind and above as from a chase camera a little further back.
    const last = spots[3];
    await b.evaluate(`__look(${spots[0].x - ux * 9}, ${spots[0].y + 3.2}, ${spots[0].z - uz * 9}, ${last.x}, ${last.y + 0.8}, ${last.z}, 50)`, false);
    const people = (on) => b.evaluate(`(() => { for (const c of briel.cars.slice(0, 4)) { briel.carPeople.dummy(c, 0, ${on ? "'#2f6fd8'" : 'null'}); briel.carPeople.dummy(c, 1, ${on ? "'#d8452f'" : 'null'}); } })()`, false);
    const time = () => b.evaluate(`(async () => {
      const t = briel.three, gl = t.renderer.getContext();
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      if (!ext) return null;
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
      const info = t.renderer.info;
      const auto = info.autoReset;
      info.autoReset = false;
      info.reset();
      t.composer.render(1 / 60);
      const { calls } = info.render;
      info.autoReset = auto;
      return JSON.stringify({ p50: ms[Math.floor(0.5 * (ms.length - 1))], calls, programs: info.programs.length });
    })()`);
    const median = (v) => [...v].sort((a, z) => a - z)[Math.floor((v.length - 1) / 2)];
    for (const q of ['high', 'low']) {
      await b.evaluate(`briel.three.applyQuality('${q}')`, false);
      await b.sleep(1500);
      await people(true);
      await b.sleep(1000);
      await b.evaluate('briel.bench(60)', false); // warm-up, with the figures
      if (out) await b.screenshot(join(out, `bench_${q}_people.png`));
      const rows = { off: [], on: [] };
      for (let p = 0; p < Number(o.pairs); p++) {
        for (const on of p % 2 ? [true, false] : [false, true]) {
          await people(on);
          await b.sleep(700);
          const r = JSON.parse(await time());
          rows[on ? 'on' : 'off'].push(r.p50);
          console.log(`  ${q} pair ${p + 1} ${on ? 'eight figures' : 'empty cars  '}: p50 ${r.p50.toFixed(3)} ms, ${r.calls} calls, ${r.programs} programs`);
        }
      }
      console.log(`${q}: median of the medians, empty ${median(rows.off).toFixed(3)} ms, eight figures ${median(rows.on).toFixed(3)} ms`);
    }
    await people(false);
  }
  const errors = b.logs.filter((l) => /^(error|exception)/.test(l));
  check(errors.length === 0, 'no errors on the page', errors.slice(0, 3).join(' | '));
} finally {
  b.close();
}
process.exit(failed ? 1 : 0);
