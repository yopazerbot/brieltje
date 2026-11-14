// Shooting a villager, as a player does it (world/villagers.ts, shared/villagers.mjs): stand on the church square,
// aim at the nearest villager that may be hit, fire, and see it fall (Action) or take the paint (Paintball).
//
//   node tools/dev/villagers_hit.mjs --url http://localhost:5200/ [--mode action|paintball] [--out <folder>] [--port 9371]
//   node tools/dev/villagers_hit.mjs --url http://localhost:5391/ --together [--ports 9371,9372] [--out <folder>]
//
// --together: two players on a throwaway game server, through a dev server whose proxy points at it
// (API_PORT=<server port> npx vite --port <n>). Alice shoots; Bob, beside her, must see the same villager fall;
// then Carl joins and must find it down too (the server's welcome names who is down).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, localOnly, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5200/', mode: 'action', out: '', port: '9371', ports: '9371,9372', together: false });
if (o.out) mkdirSync(o.out, { recursive: true });
let failed = 0;
const ok = (name, pass, extra = '') => {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} ${extra}`);
  if (!pass) failed++;
};
const shot = (b, name) => (o.out ? b.screenshot(join(o.out, `${name}.png`)) : Promise.resolve());

/** The nearest villager that may be hit now, within 45 m and in the open view: its number, kind and place. */
const NEAREST = `(() => {
  const p = briel.player;
  const all = briel.villagers.states().filter((v) => v.canHit && v.fade > 0.9 && v.mode !== 'sit');
  all.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
  const v = all.find((s) => { const d = Math.hypot(s.x - p.x, s.z - p.z); return d > 4 && d < 45; });
  return v ? JSON.stringify(v) : '';
})()`;

/** Turn the view to villager `id` (its chest) and fire once; resolves to what the page says of it afterwards. */
async function shoot(b, id) {
  // Which way a yaw turns the view is read off the camera itself, not assumed.
  return b.evaluate(`(async () => {
    const cam = briel.three.composer.passes.map((q) => q.camera).find(Boolean);
    const p = briel.player;
    const dirOf = (yaw, pitch) => { briel.teleport(p.x, p.z, p.feet, yaw, pitch); cam.updateMatrixWorld(true); const e = cam.matrixWorld.elements; return [-e[8], -e[9], -e[10]]; };
    for (let n = 0; n < 12; n++) {
      const v = briel.villagers.states().find((s) => s.id === ${id});
      if (!v || !v.canHit) return JSON.stringify({ gone: true, v });
      const eye = [cam.matrixWorld.elements[12], cam.matrixWorld.elements[13], cam.matrixWorld.elements[14]];
      const to = [v.x - eye[0], v.y + 1.1 - eye[1], v.z - eye[2]];
      const L = Math.hypot(...to);
      const want = to.map((c) => c / L);
      let best = null;
      for (const yaw of [Math.atan2(-want[0], -want[2]), Math.atan2(want[0], want[2])]) {
        for (const pitch of [Math.asin(want[1]), -Math.asin(want[1])]) {
          const d = dirOf(yaw, pitch);
          const dot = d[0] * want[0] + d[1] * want[1] + d[2] * want[2];
          if (!best || dot > best.dot) best = { yaw, pitch, dot };
        }
      }
      dirOf(best.yaw, best.pitch);
      briel.fire();
      await new Promise((r) => setTimeout(r, 350));
      const after = briel.villagers.states().find((s) => s.id === ${id});
      if (!after || !after.canHit) return JSON.stringify({ shots: n + 1, aim: +best.dot.toFixed(4), dist: +L.toFixed(1), after: after ? { mode: after.mode, clip: after.clip, canHit: after.canHit } : null });
    }
    return JSON.stringify({ missed: true });
  })()`);
}

/** To the church square, and wait for villagers round it. */
async function toSquare(b, travel) {
  if (travel) await b.evaluate("briel.travel('church')", false);
  else await b.evaluate('briel.player.flying = false; briel.teleport(536.3, -771.6, 40, 0, 0); briel.walk(4, 0, 0)', false);
  for (let t = 0; t < 60000; t += 500) {
    if (await b.evaluate(NEAREST, false).catch(() => '')) return;
    await b.sleep(500);
  }
  throw new Error('no villager near the church square that may be hit');
}

if (!o.together) {
  const b = await launch({ port: Number(o.port) });
  try {
    await b.send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('briel.lang','en');" });
    await b.send('Page.navigate', { url: o.url });
    await b.waitFor("!!document.querySelector('#choose-kbm')");
    await b.sleep(6000);
    await b.evaluate(`document.querySelector('#mode-start [data-play=${o.mode === 'paintball' ? 'paintball' : 'action'}]')?.click()`, false);
    await startGame(b, o.url, { village: true });
    await b.evaluate('briel.weapon.setEnabled(true)', false);
    await toSquare(b, false);
    const v = JSON.parse(await b.evaluate(NEAREST, false));
    console.log('target:', v.id, v.kind, v.what, v.mode);
    await shot(b, `${o.mode}_before`);
    const r = JSON.parse(await shoot(b, v.id));
    console.log('shot:', JSON.stringify(r));
    await b.sleep(250);
    await shot(b, `${o.mode}_after`);
    if (o.mode === 'paintball') {
      // The paint list is the page's own (world/villagers.ts paints): read here for the check only.
      const painted = await b.evaluate(`briel.villagers.paints.has(${v.id})`, false);
      ok('paintball: nobody falls', !!r.missed, JSON.stringify(r));
      ok('paintball: the paint is on its clothes', painted === true);
    } else {
      ok('action: the villager fell', !r.missed && !r.gone, JSON.stringify(r));
    }
    const errors = b.logs.filter((l) => /^(error|exception)/.test(l));
    ok('no errors in the page', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await b.close();
  }
} else {
  localOnly(o.url, '--url'); // players join: a throwaway server on this computer only
  const [pa, pb] = o.ports.split(',').map(Number);
  const tag = Math.random().toString(36).slice(2, 6);
  /** A page that joins the game together under `name`, in Action. */
  const player = async (port, name) => {
    const b = await launch({ port, width: 1000, height: 560 });
    console.log(name, 'browser PID:', b.pid);
    await b.send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('briel.graphics','low');localStorage.setItem('briel.lang','en');localStorage.setItem('briel.spawn','house');" });
    await b.send('Page.navigate', { url: o.url });
    await b.waitFor("!!document.querySelector('#choose-kbm')");
    await b.sleep(6000);
    await b.evaluate(`(() => {
      const n = document.querySelector('#nick'); n.value = '${name}'; n.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-mp=multi]').click();
      const age = document.querySelector('#mp-age'); if (!age.checked) age.click();
      document.querySelector('#choose-kbm').click();
    })()`, false);
    await b.waitFor('!!window.briel', 90000);
    await b.waitFor("(() => { const p = document.getElementById('start-panel'); if (!p || p.offsetParent === null) return true; const s = getComputedStyle(p); return s.visibility === 'hidden' || Number(s.opacity) < 0.05; })()", 180000);
    await b.evaluate("document.getElementById('cc-close')?.click(); window.briel?.loadoutCard?.close(false)", false).catch(() => {});
    await b.evaluate('briel.weapon.setEnabled(true)', false);
    return b;
  };
  const pages = [];
  try {
    const alice = await player(pa, `Alice${tag}`);
    pages.push(alice);
    const bob = await player(pb, `Bob${tag}`);
    pages.push(bob);
    await toSquare(alice, true);
    await toSquare(bob, true);
    // One that both pages show and may hit, a walker if there is one (those standing about on a busy place stand on
    // spots each page picks itself), nearest Alice.
    let v = null;
    for (let t = 0; t < 40000 && !v; t += 1000) {
      const theirs = new Set(JSON.parse(await bob.evaluate('JSON.stringify(briel.villagers.states().filter((s) => s.canHit).map((s) => s.id))', false)));
      const mine = JSON.parse(await alice.evaluate("(() => { const p = briel.player; return JSON.stringify(briel.villagers.states().filter((s) => s.canHit && s.fade > 0.9 && s.mode !== 'sit').map((s) => ({ ...s, d: Math.hypot(s.x - p.x, s.z - p.z) })).filter((s) => s.d > 4 && s.d < 45).sort((a, b) => (a.what === 'hub') - (b.what === 'hub') || a.d - b.d)); })()", false));
      v = mine.find((m) => theirs.has(m.id)) ?? null;
      if (!v) await alice.sleep(1000);
    }
    if (!v) throw new Error('no villager that both pages show');
    console.log('target:', v.id, v.kind, v.what);
    const bobBefore = await bob.evaluate(`JSON.stringify(briel.villagers.states().find((s) => s.id === ${v.id}) ?? null)`, false);
    ok('Bob sees the same villager, in the same place', !!JSON.parse(bobBefore) && Math.hypot(JSON.parse(bobBefore).x - v.x, JSON.parse(bobBefore).z - v.z) < 6, bobBefore.slice(0, 160));
    const r = JSON.parse(await shoot(alice, v.id));
    ok('Alice: the villager fell', !r.missed && !r.gone, JSON.stringify(r));
    // The page's own list of who is down (world/villagers.ts downs): read here for the check only.
    let heard = false;
    for (let t = 0; t < 4000 && !heard; t += 200) {
      heard = await bob.evaluate(`briel.villagers.downs.has(${v.id})`, false);
      if (!heard) await bob.sleep(200);
    }
    const seen = JSON.parse(await bob.evaluate(`JSON.stringify(briel.villagers.states().find((s) => s.id === ${v.id}) ?? null)`, false));
    ok('Bob: the server told him, and the same villager fell', heard && (!seen || !seen.canHit), JSON.stringify(seen).slice(0, 160));
    await shot(bob, 'together_bob');
    // Carl joins now: the welcome names who is down, before his villagers are loaded.
    const carl = await player(pb + 1, `Carl${tag}`);
    pages.push(carl);
    await carl.evaluate("briel.travel('church')", false);
    await carl.sleep(9000);
    const late = JSON.parse(await carl.evaluate(`JSON.stringify({ n: briel.villagers.states().length, down: briel.villagers.downs.has(${v.id}), v: briel.villagers.states().find((s) => s.id === ${v.id}) ?? null })`, false));
    ok('Carl, who joined after: the villager is down for him too', late.n > 0 && late.down && (!late.v || !late.v.canHit), JSON.stringify(late).slice(0, 200));
    for (const b of pages) {
      const errors = b.logs.filter((l) => /^(error|exception)/.test(l));
      ok('no errors in a page', errors.length === 0, errors.slice(0, 2).join(' | '));
    }
  } finally {
    for (const b of pages) await b.close();
  }
}
console.log(failed ? `${failed} failed` : 'all ok');
process.exitCode = failed ? 1 : 0;
