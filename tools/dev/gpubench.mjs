// The graphics chip's own time per frame, from its timer queries (EXT_disjoint_timer_query_webgl2), on High and on Low:
// 240 frames drawn one after another at one spot, after a warm-up briel.bench(60). The processor's clock swings with
// the other agents' work on this PC (AGENTS.md, "One PC, shared"); the chip's own clock is steadier. Still shared:
// run base and branch in turn (A, B, A, B), several pairs, and compare the medians. Needs the dev server (window.briel).
//
//   node tools/dev/gpubench.mjs http://localhost:5740/ http://localhost:5741/ [--at church] [--pairs 6] [--port 9940]
//
// --at: a place briel.travel knows (church, house, street:schildekensstraat, ...).
import { launch, options, startGame } from './cdp.mjs';

const o = options({ at: 'church', pairs: '1', port: '9940', frames: '240' });
const urls = o._;
if (!urls.length) throw new Error('give one or more URLs');

async function once(url) {
  const b = await launch({ port: Number(o.port) });
  try {
    await startGame(b, url, { village: true });
    await b.evaluate('briel.three.holdQuality(true)', false);
    await b.evaluate(`briel.travel(${JSON.stringify(o.at)})`, false);
    await b.sleep(3500);
    const out = {};
    for (const q of ['high', 'low']) {
      await b.evaluate(`briel.three.applyQuality('${q}')`, false);
      await b.sleep(800);
      await b.evaluate('briel.bench(60)', false); // warm-up
      out[q] = await b.evaluate(`(async () => {
        const t = briel.three, gl = t.renderer.getContext();
        const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
        if (!ext) return null;
        const qs = [];
        for (let i = 0; i < ${Number(o.frames)}; i++) {
          const qy = gl.createQuery();
          gl.beginQuery(ext.TIME_ELAPSED_EXT, qy);
          t.composer.render(1 / 60);
          gl.endQuery(ext.TIME_ELAPSED_EXT);
          qs.push(qy);
          if (i % 8 === 7) await new Promise((res) => setTimeout(res, 0));
        }
        const px = new Uint8Array(4);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // waits for the chip
        await new Promise((res) => setTimeout(res, 300));
        const ms = [];
        for (const qy of qs) {
          if (gl.getQueryParameter(qy, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(ext.GPU_DISJOINT_EXT)) ms.push(gl.getQueryParameter(qy, gl.QUERY_RESULT) / 1e6);
          gl.deleteQuery(qy);
        }
        ms.sort((a, b) => a - b);
        // Draw calls and triangles of one whole frame (all its passes: the counters are kept over the frame).
        const info = t.renderer.info;
        const auto = info.autoReset;
        info.autoReset = false;
        info.reset();
        t.composer.render(1 / 60);
        const { calls, triangles } = info.render;
        info.autoReset = auto;
        return { n: ms.length, p10: ms[Math.floor(0.1 * (ms.length - 1))], p50: ms[Math.floor(0.5 * (ms.length - 1))], p90: ms[Math.floor(0.9 * (ms.length - 1))], calls, triangles };
      })()`, true);
    }
    return out;
  } finally {
    await b.close();
  }
}

const rows = new Map(urls.map((u) => [u, { high: [], low: [] }]));
for (let pair = 0; pair < Number(o.pairs); pair++) {
  for (const url of urls) {
    const r = await once(url);
    for (const q of ['high', 'low']) {
      const x = r[q];
      if (!x) {
        console.log(`${url} ${q}: no timer queries`);
        continue;
      }
      rows.get(url)[q].push(x.p50);
      console.log(`${pair + 1} ${url} ${q}: n ${x.n} p10 ${x.p10.toFixed(3)} p50 ${x.p50.toFixed(3)} p90 ${x.p90.toFixed(3)} ms, ${x.calls} calls, ${x.triangles} triangles`);
    }
  }
}
const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return (s[Math.floor((s.length - 1) / 2)] + s[Math.ceil((s.length - 1) / 2)]) / 2;
};
for (const [url, r] of rows) {
  console.log(`median of the medians, ${o.at}: ${url} high ${r.high.length ? median(r.high).toFixed(3) : '-'} ms, low ${r.low.length ? median(r.low).toFixed(3) : '-'} ms`);
}
