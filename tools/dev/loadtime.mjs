// Click to play, cold: a fresh Chromium profile per run, the cache off, the time from the click on the start
// button to the start screen going away, measured inside the page; then the frames of the first seconds of play.
// Works on a production build (no window.briel needed). Several URLs are run in turn, round after round
// (A, B, A, B), because other agents share the graphics chip and the processor (AGENTS.md).
//
//   node tools/dev/loadtime.mjs http://localhost:8650/ http://localhost:8651/ [--rounds 3] [--port 9940]
//        [--spawn church] [--gfx high] [--phone] [--throttle 4] [--after 10] [--wait 6]
//        [--prof out.cpuprofile] [--profafter 0] [--top 30] [--swiftshader]
//
// --phone: touch and a phone's screen; --throttle 4: the processor 4x slower (as for a phone).
// --prof: a CPU profile from the click to play, saved (open it in Chrome's DevTools), and its top functions
// printed by their own time and by the time spent in them and what they call. --profafter 2: the profile goes on
// 2 s into play (for the long frames just after it begins).
import { writeFileSync } from 'node:fs';
import { launch, options } from './cdp.mjs';

const o = options({ rounds: '1', port: '9940', spawn: 'church', gfx: '', phone: false, throttle: '1', after: '10', wait: '6', prof: '', profafter: '0', top: '30', swiftshader: false });
const urls = o._;
if (!urls.length) throw new Error('give one or more URLs');

const hidden = "(() => { const p = document.getElementById('start-panel'); if (!p || p.offsetParent === null) return true; const s = getComputedStyle(p); return s.visibility === 'hidden' || Number(s.opacity) < 0.05; })()";

async function once(url, round) {
  const b = await launch({ port: Number(o.port), width: 1600, height: 900, swiftshader: o.swiftshader });
  try {
    if (o.phone) {
      await b.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await b.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
    }
    await b.send('Network.enable');
    await b.send('Network.setCacheDisabled', { cacheDisabled: true });
    await b.send('Page.navigate', { url });
    await b.waitFor("!!document.querySelector('#choose-kbm')", 60000);
    await b.evaluate(`(() => { localStorage.setItem('briel.spawn', ${JSON.stringify(o.spawn)}); ${o.gfx ? `localStorage.setItem('briel.graphics', ${JSON.stringify(o.gfx)});` : ''} })()`, false);
    await b.send('Page.reload');
    await b.sleep(500);
    await b.waitFor("!!document.querySelector('#choose-kbm') && !document.getElementById('overlay').classList.contains('hidden')", 60000);
    await b.sleep(Number(o.wait) * 1000); // what the start screen fetches while a player reads it
    if (Number(o.throttle) > 1) await b.send('Emulation.setCPUThrottlingRate', { rate: Number(o.throttle) });
    if (o.prof) {
      await b.send('Profiler.enable');
      await b.send('Profiler.setSamplingInterval', { interval: 200 });
      await b.send('Profiler.start');
    }
    const button = o.phone ? '#choose-touch' : '#choose-kbm';
    // Inside the page: the click's time, the time the overlay hides (play), and every frame's length from the
    // click on (so the long frames before and after play are both known).
    await b.evaluate(`(() => {
      const ov = document.getElementById('overlay');
      window.__frames = [];
      let last = performance.now();
      const f = (t) => { window.__frames.push([t, t - last]); last = t; requestAnimationFrame(f); };
      requestAnimationFrame(f);
      new MutationObserver(() => { if (!window.__play && ov.classList.contains('hidden')) window.__play = performance.now(); }).observe(ov, { attributes: true });
      const n = document.getElementById('nick');
      if (n && !n.value) { n.value = 'Check'; n.dispatchEvent(new Event('input', { bubbles: true })); }
      document.querySelector('#mode-start [data-play=action]')?.click();
      window.__click = performance.now();
      document.querySelector('${button}').click();
    })()`, false);
    await b.waitFor(`!!window.__play && ${hidden}`, 300000);
    let profile;
    if (o.prof && Number(o.profafter) > 0) await b.sleep(Number(o.profafter) * 1000);
    if (o.prof) profile = (await b.send('Profiler.stop')).profile;
    await b.sleep(Math.max(0, Number(o.after) * 1000 + 300 - (o.prof ? Number(o.profafter) * 1000 : 0)));
    const r = await b.evaluate(`(() => {
      const play = window.__play, end = play + ${Number(o.after) * 1000};
      const after = window.__frames.filter(([t]) => t > play && t <= end).map(([, d]) => d);
      const before = window.__frames.filter(([t]) => t > window.__click && t <= play).map(([, d]) => d);
      const slow = window.__frames.filter(([t, d]) => t > play && t <= end && d > 50).map(([t, d]) => ((t - play) / 1000).toFixed(2) + 's:' + d.toFixed(0));
      const s = [...after].sort((a, z) => a - z);
      return { play: (play - window.__click) / 1000, n: after.length, median: s[Math.floor(s.length / 2)], worst: s.slice(-3).reverse(), over50: after.filter((d) => d > 50).length, slow, beforeWorst: Math.max(0, ...before) };
    })()`, false);
    const errs = b.logs.filter((l) => /^(error|exception)/.test(l)).slice(0, 4);
    console.log(`round ${round} ${url}  PLAY ${r.play.toFixed(2)} s; first ${o.after} s: ${r.n} frames, median ${r.median?.toFixed(1)} ms, worst ${r.worst.map((x) => x.toFixed(0)).join(' ')} ms, over 50 ms: ${r.over50}${r.slow.length ? ' (' + r.slow.slice(0, 8).join(' ') + ')' : ''}${errs.length ? '\n  errors: ' + errs.join(' | ') : ''}`);
    if (profile) summarise(profile, `${o.prof.replace(/\.cpuprofile$/, '')}${urls.length > 1 || Number(o.rounds) > 1 ? `-${round}-${urls.indexOf(url)}` : ''}.cpuprofile`);
    return r;
  } finally {
    b.close();
    await new Promise((res) => setTimeout(res, 2000));
  }
}

/** Save the profile and print its top functions by self time and by total time. */
function summarise(profile, file) {
  writeFileSync(file, JSON.stringify(profile));
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const selfUs = new Map();
  for (let i = 0; i < profile.samples.length; i++) selfUs.set(profile.samples[i], (selfUs.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i + 1] ?? 0));
  const name = (n) => { const f = n.callFrame; return `${f.functionName || '(anon)'} ${f.url.replace(/^.*\//, '').replace(/\?.*$/, '')}:${f.lineNumber + 1}`; };
  const self = new Map();
  const total = new Map();
  for (const [id, us] of selfUs) {
    const k = name(byId.get(id));
    self.set(k, (self.get(k) ?? 0) + us);
    const seen = new Set();
    for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
      const kk = name(byId.get(cur));
      if (seen.has(kk)) continue;
      seen.add(kk);
      total.set(kk, (total.get(kk) ?? 0) + us);
    }
  }
  const sum = [...selfUs.values()].reduce((a, z) => a + z, 0);
  const idle = [...selfUs].filter(([id]) => byId.get(id).callFrame.functionName === '(idle)').reduce((a, [, us]) => a + us, 0);
  console.log(`  profile ${file}: ${(sum / 1000).toFixed(0)} ms sampled, ${(idle / 1000).toFixed(0)} ms idle`);
  const top = Number(o.top);
  console.log('  -- self (ms)');
  for (const [k, v] of [...self].sort((a, z) => z[1] - a[1]).slice(0, top)) console.log(`  ${(v / 1000).toFixed(0).padStart(6)}  ${k}`);
  console.log('  -- total (ms)');
  for (const [k, v] of [...total].sort((a, z) => z[1] - a[1]).slice(0, top)) console.log(`  ${(v / 1000).toFixed(0).padStart(6)}  ${k}`);
}

const all = new Map(urls.map((u) => [u, []]));
for (let i = 1; i <= Number(o.rounds); i++) for (const u of urls) all.get(u).push(await once(u, i));
for (const [u, rs] of all) {
  const p = rs.map((r) => r.play).sort((a, z) => a - z);
  console.log(`${u}: play ${p.map((x) => x.toFixed(2)).join(', ')} s (median ${p[Math.floor(p.length / 2)].toFixed(2)}); frames over 50 ms in the first ${o.after} s: ${rs.map((r) => r.over50).join(', ')}`);
}
