// Two states of one page against each other, A, B, A, B, at the spots you name: the graphics chip's own time per frame
// (its timer queries, EXT_disjoint_timer_query_webgl2) and the wall time of each frame (processor and chip, one after
// the other), over frames drawn as the game draws them (briel.bench(1): the sun's shadow maps placed and drawn as in
// play, which tools/dev/gpubench.mjs leaves out) and sent back to back. One page load per spot; for each mood and preset
// a warm-up run, then `--pairs` pairs. Each A and B is JavaScript run in the page (`t` is briel.three, `p` the preset's
// settings) before its run; a promise it returns is waited for. Needs the dev server (window.briel). Only what the
// frame draws is measured: work the game does elsewhere in its loop (the weather's, the villagers') is not.
//
//   node tools/dev/abbench.mjs --url http://localhost:5750/ --spots "church;street:kapellenhoek;wood:-60:455:0"
//        --mood sunny,dusk --quality medium,high,ultra --pairs 8 --frames 96 --port 9750 --size 1920x1080
//        --a "t.sunShadow.setup(p.shadowReach, p.shadowMap, p.shadowFar, p.shadowFarMap, p.shadowFarEvery)"
//        --b "t.sunShadow.setup(p.shadowReach, p.shadowMap, 0)" [--setup "<async js once a spot is reached>"] [--same]
//        [--passes]
//
// A spot is a place id (briel.places) or name:x:z:yaw[:pitch] in the model's metres and radians; the player is dropped
// from 40 m up. --same runs A against A first, to see how far one state's runs wander (on this PC whole frames wander
// 0.2 to 0.5 ms with the chip otherwise idle: the scene moves on between runs). --passes also times the far shadow
// map's pass, the sharp map's pass and the frame without them, each alone: much steadier than whole frames.
// Other agents share the chip: say so when you report the numbers (AGENTS.md).
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5750/', spots: 'church', mood: 'sunny', quality: 'high', pairs: '8', frames: '120', port: '9750', size: '1920x1080', a: '', b: '', setup: '', same: false, passes: false, phone: false, swiftshader: false });
const [width, height] = o.size.split('x').map(Number);
const N = Number(o.frames);

/** One run of N frames in the page: chip ms per frame (mean, median), wall ms per frame, frames that drew the far map. */
const RUN = `(async () => {
  const t = briel.three, gl = t.renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const map = t.renderer.shadowMap;
  if (!map.__abbench) {
    const render = map.render.bind(map);
    map.render = (l, s, c) => {
      if (l.includes(t.sunShadow.far) && t.sunShadow.far.shadow.needsUpdate) window.__farDrew = true;
      const times = window.__abTime; // --passes: the world's shadow passes timed alone (not an overlay's or a probe's)
      if (!times || !l.includes(t.sun)) return render(l, s, c);
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      const info = t.renderer.info.render, calls = info.calls, tris = info.triangles;
      const c0 = performance.now();
      try {
        render(l, s, c);
      } finally {
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        times.push({ q, cpu: performance.now() - c0, calls: info.calls - calls, tris: info.triangles - tris });
      }
    };
    map.__abbench = true;
  }
  // The frames back to back, without waiting for the chip after each (briel.bench reads a pixel back each frame: the
  // chip then idles between frames and its clock wanders more than the far map costs), and one wait at the end. The
  // wall time is then the frames' throughput: the slower of the processor's work and the chip's.
  const qs = [], far = [];
  const readPixels = gl.readPixels;
  const px = new Uint8Array(4);
  readPixels.call(gl, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  gl.readPixels = () => {};
  const t0 = performance.now();
  try {
    for (let i = 0; i < ${N}; i++) {
      window.__farDrew = false;
      const q = ext ? gl.createQuery() : null;
      if (q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      briel.bench(1);
      if (q) gl.endQuery(ext.TIME_ELAPSED_EXT);
      qs.push(q);
      far.push(window.__farDrew);
    }
  } finally {
    gl.readPixels = readPixels;
  }
  readPixels.call(gl, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const wallMs = (performance.now() - t0) / ${N};
  await new Promise((r) => setTimeout(r, 300));
  const ms = [], msFar = [], msNo = [];
  qs.forEach((q, i) => {
    if (!q) return;
    if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(ext.GPU_DISJOINT_EXT)) {
      const v = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
      ms.push(v);
      (far[i] ? msFar : msNo).push(v);
    }
    gl.deleteQuery(q);
  });
  const med = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };
  // A far map drawn every few frames makes the frames' times two groups, so their median says little and their mean
  // takes in the odd stall: each group's median, weighed by its share of the frames.
  const split = (v, flags) => { const a = v.filter((_, i) => flags[i]), b = v.filter((_, i) => !flags[i]); return (a.length ? a.length * med(a) : 0) + (b.length ? b.length * med(b) : 0); };
  const all = [...msFar, ...msNo];
  return { gpu: split(all, [...msFar.map(() => true), ...msNo.map(() => false)]) / all.length, gpuMed: med(ms), gpuFar: med(msFar), gpuNo: med(msNo), wall: wallMs, wallMed: wallMs, farFrames: far.filter(Boolean).length, n: ms.length };
})()`;

/**
 * --passes: the parts of a frame alone, each drawn 48 times back to back (steadier than whole frames): the far shadow
 * map's pass (if it is on), the sun's sharp map's pass, and the frame without its shadow passes (what reading the
 * maps costs). Chip ms (median) and the processor's ms to send each.
 */
const PASSES = `(async () => {
  const t = briel.three, gl = t.renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const map = t.renderer.shadowMap, sun = t.sun.shadow, far = t.sunShadow.far.shadow;
  if (!ext) return null;
  const px = new Uint8Array(4);
  const med = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };
  const sunAuto = sun.autoUpdate;
  // A shadow pass is timed inside a whole frame (three draws the maps only inside renderer.render), by the RUN's hook.
  const pass = (drawSun, drawFar) => {
    const times = (window.__abTime = []);
    try {
      for (let i = 0; i < 48; i++) {
        sun.autoUpdate = drawSun;
        sun.needsUpdate = drawSun;
        far.needsUpdate = drawFar;
        map.needsUpdate = true;
        t.composer.render(1 / 60);
      }
    } finally {
      window.__abTime = null;
      sun.autoUpdate = sunAuto;
    }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return times;
  };
  // The frame without any shadow pass: what drawing the world and reading the maps costs.
  const frame = () => {
    const times = [];
    for (let i = 0; i < 48; i++) {
      map.needsUpdate = false;
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      t.composer.render(1 / 60);
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      times.push({ q, cpu: 0 });
    }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return times;
  };
  const runs = { far: far.intensity > 0 ? pass(false, true) : null, near: pass(true, false), scene: frame() };
  await new Promise((r) => setTimeout(r, 300));
  const out = {};
  for (const [k, r] of Object.entries(runs)) {
    if (!r) { out[k] = null; continue; }
    const ms = [];
    for (const { q } of r) { if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(ext.GPU_DISJOINT_EXT)) ms.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(q); }
    out[k] = { gpu: med(ms), cpu: med(r.map((x) => x.cpu)), calls: med(r.map((x) => x.calls ?? 0)), tris: med(r.map((x) => x.tris ?? 0)) };
  }
  map.needsUpdate = true; // the maps drawn again as the game has them
  if (runs.far) far.needsUpdate = true;
  return out;
})()`;

const b = await launch({ port: Number(o.port), width, height, swiftshader: o.swiftshader });
console.log('chromium pid', b.pid);
const f = (v) => (Number.isFinite(v) ? v.toFixed(3) : '-');
try {
  await startGame(b, o.url, { village: true, noAsk: true, phone: o.phone });
  await b.evaluate('briel.three.holdQuality(true)', false);
  console.log('gpu:', await b.evaluate("(() => { const gl = document.createElement('canvas').getContext('webgl2'); const e = gl.getExtension('WEBGL_debug_renderer_info'); return gl.getParameter(e.UNMASKED_RENDERER_WEBGL); })()", false));
  const summary = [];
  for (const spot of o.spots.split(';')) {
    const parts = spot.split(':');
    let name = spot, x, z, yaw = 0, pitch = -0.1;
    if (parts.length >= 4 && !Number.isNaN(Number(parts[1]))) {
      [name] = parts;
      [x, z, yaw, pitch = -0.1] = parts.slice(1).map(Number);
    } else {
      const at = await b.evaluate(`(() => { const d = briel.places.find((p) => p.id === ${JSON.stringify(spot)}); return d ? JSON.stringify(d.out || [d.x, d.z, 0]) : ''; })()`, false);
      if (!at) { console.log('no such place:', spot); continue; }
      [x, z, yaw = 0] = JSON.parse(at);
    }
    await b.evaluate(`briel.player.flying = false; briel.teleport(${x}, ${z}, 40, ${yaw}, 0); briel.walk(4, 0, 0)`, false);
    await b.sleep(2500);
    await b.evaluate(`briel.teleport(briel.player.x, briel.player.z, briel.player.feet, ${yaw}, ${pitch})`, false);
    if (o.setup) await b.evaluate(`(async () => { const t = briel.three; ${o.setup}; })()`, true);
    await b.sleep(2000);
    for (const mood of o.mood.split(',')) {
      await b.evaluate(`briel.three.weather.setSolo(${JSON.stringify(mood)})`, false);
      await b.sleep(9000); // a mood picked by hand blends in over 8 s
      for (const q of o.quality.split(',')) {
        await b.evaluate(`briel.three.applyQuality(${JSON.stringify(q)})`, false);
        const set = (js) => b.evaluate(`(() => { const t = briel.three, p = t.presets[t.quality()]; ${js}; })()`, true);
        await set(o.a);
        await b.sleep(1000);
        await b.evaluate('briel.bench(60)', false); // warm-up: shader compiles, uploads
        await set(o.b);
        await b.evaluate('briel.bench(60)', false);
        const runs = { A: [], B: [] };
        if (o.same) {
          for (let i = 0; i < 4; i++) {
            await set(o.a);
            await b.evaluate('briel.bench(8)', false); // the new state settled
            const r = await b.evaluate(RUN, true);
            console.log(`  same ${name} ${mood} ${q} A${i}: gpu ${f(r.gpu)} wall ${f(r.wall)}`);
          }
        }
        for (let i = 0; i < Number(o.pairs); i++) {
          for (const k of ['A', 'B']) {
            await set(k === 'A' ? o.a : o.b);
            await b.evaluate('briel.bench(8)', false); // the new state settled
            const r = await b.evaluate(RUN, true);
            if (o.passes) r.passes = await b.evaluate(PASSES, true);
            runs[k].push(r);
            const ps = r.passes ? ` | alone: far ${f(r.passes.far?.gpu)} (cpu ${f(r.passes.far?.cpu)}, ${r.passes.far?.calls ?? '-'} calls, ${r.passes.far?.tris ?? '-'} tris) sharp ${f(r.passes.near?.gpu)} (cpu ${f(r.passes.near?.cpu)}, ${r.passes.near?.calls} calls, ${r.passes.near?.tris} tris) frame ${f(r.passes.scene?.gpu)}` : '';
            console.log(`  ${name} ${mood} ${q} ${k}${i}: gpu ${f(r.gpu)} (far frames ${f(r.gpuFar)}, others ${f(r.gpuNo)}, ${r.farFrames}/${N}) wall ${f(r.wall)}${ps}`);
          }
        }
        await set(o.a);
        const median = (v) => { const s = [...v].sort((a, b) => a - b); return (s[Math.floor((s.length - 1) / 2)] + s[Math.ceil((s.length - 1) / 2)]) / 2; };
        const diffs = (key) => runs.A.map((r, i) => r[key] - runs.B[i][key]);
        const row = {
          spot: name, mood, q,
          gpuA: median(runs.A.map((r) => r.gpu)), gpuB: median(runs.B.map((r) => r.gpu)), gpuD: median(diffs('gpu')),
          gpuDmin: Math.min(...diffs('gpu')), gpuDmax: Math.max(...diffs('gpu')),
          wallA: median(runs.A.map((r) => r.wall)), wallB: median(runs.B.map((r) => r.wall)), wallD: median(diffs('wall')),
        };
        if (o.passes) {
          const pm = (part, key) => median(runs.A.map((r) => r.passes?.[part]?.[key] ?? NaN).filter(Number.isFinite));
          Object.assign(row, { farPass: pm('far', 'gpu'), farCpu: pm('far', 'cpu'), nearPass: pm('near', 'gpu'), sceneD: median(runs.A.map((r, i) => (r.passes?.scene?.gpu ?? NaN) - (runs.B[i].passes?.scene?.gpu ?? NaN))) });
          console.log(`  alone: far pass ${f(row.farPass)} ms chip, ${f(row.farCpu)} ms processor; sharp pass ${f(row.nearPass)}; frame without shadow passes A-B ${f(row.sceneD)}`);
        }
        summary.push(row);
        console.log(`= ${name} ${mood} ${q}: gpu A ${f(row.gpuA)} B ${f(row.gpuB)} A-B ${f(row.gpuD)} [${f(row.gpuDmin)}..${f(row.gpuDmax)}]  wall A ${f(row.wallA)} B ${f(row.wallB)} A-B ${f(row.wallD)}`);
      }
    }
  }
  console.log('\nspot | mood | preset | chip A | chip B | chip A-B (pair range) | wall A | wall B | wall A-B' + (o.passes ? ' | far pass alone (chip, processor) | sharp pass | reading A-B' : ''));
  for (const r of summary) console.log(`${r.spot} | ${r.mood} | ${r.q} | ${f(r.gpuA)} | ${f(r.gpuB)} | ${f(r.gpuD)} (${f(r.gpuDmin)}..${f(r.gpuDmax)}) | ${f(r.wallA)} | ${f(r.wallB)} | ${f(r.wallD)}${o.passes ? ` | ${f(r.farPass)}, ${f(r.farCpu)} | ${f(r.nearPass)} | ${f(r.sceneD)}` : ''}`);
  const errors = b.logs.filter((l) => /^(error|exception)/.test(l));
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
} finally {
  await b.close();
}
