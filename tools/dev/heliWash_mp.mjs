// The rotor wash together (world/rotorWash.ts): it is the page's own, drawn from the pose each page already gets of a
// machine, so a watcher sees the dust under someone else's helicopter. Two real pages on a throwaway game server (a
// build of this branch, its API on --api) through a dev server whose proxy points at it (API_PORT=<server port> npx
// vite --port <n>): Pilot boards the house's machine and lifts it to about 4 m over its pad, holds a hover, then sets
// it down; Watcher stands 22 m off. Each prints the wash it works out for the machine (its strength, the ground's kind,
// the shaders' disc), and Watcher's pictures show it (--out). No page errors.
//
//   ADMIN_PASSWORD=... node tools/dev/heliWash_mp.mjs --url http://localhost:5680/ --api http://localhost:8680 \
//     --ports 9683,9684 [--out <folder>]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, localOnly, options } from './cdp.mjs';

const o = options({ url: 'http://localhost:5680/', api: 'http://localhost:8680', ports: '9683,9684', out: '' });
localOnly(o.url, '--url');
localOnly(o.api); // it logs in as the admin and changes the rules: a throwaway server on this computer only
const password = process.env.ADMIN_PASSWORD;
if (!password) throw new Error('ADMIN_PASSWORD is not set');
const ports = o.ports.split(',').map(Number);
if (o.out) mkdirSync(o.out, { recursive: true });
let failed = 0;
const ok = (name, pass, extra = '') => {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} ${extra}`);
  if (!pass) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (v) => (Math.round(v * 10) / 10).toFixed(1);

// The admin: helicopters allowed, nobody dropped by parachute at the start.
const login = await fetch(`${o.api}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: o.api }, body: JSON.stringify({ username: 'admin', password }) });
ok('admin login', login.ok);
const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const { default: WebSocket } = await import('../../web/node_modules/ws/wrapper.mjs');
const host = new URL(o.api).host;
const admin = new WebSocket(`ws://${host}/ws?v=2`, { headers: { Cookie: cookie, Origin: o.api } });
admin.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.t === 'ping') admin.send(JSON.stringify({ t: 'pong', n: m.n }));
});
await new Promise((res, rej) => (admin.on('open', res), admin.on('error', rej)));
admin.send(JSON.stringify({ t: 'rules', parachute: false, heli: true, travel: true }));

const pages = [];
async function page(port, name) {
  const b = await launch({ port, width: 1000, height: 562 });
  console.log(`${name}: browser PID ${b.pid}`);
  pages.push(b);
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('briel.graphics','high');localStorage.setItem('briel.lang','en');localStorage.setItem('briel.spawn','house');localStorage.setItem('briel.playMode','explore');localStorage.setItem('briel.feedback','later');" });
  const url = new URL(o.url);
  url.searchParams.set('nobake', ''); // as heli_mp.mjs: no light bake while the pages load
  await b.send('Page.navigate', { url: url.href });
  await b.waitFor("!!document.querySelector('#choose-kbm')");
  await b.sleep(6000); // the dev build attaches the start screen's handlers late
  // The start's three steps (as tools/dev/menuLogoutCheck.mjs): a guest's name, together, explore.
  const step = (n) => b.waitFor(`Number(document.getElementById('start-panel').dataset.step) === ${n}`, 30000);
  await b.evaluate(`(() => { const n = document.getElementById('nick'); n.value = '${name}'; n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true })); document.getElementById('guest-go').click(); return true; })()`);
  await step(2);
  await b.evaluate("(() => { const a = document.getElementById('mp-age'); a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#mp-choice [data-mp=multi]').click(); return true; })()");
  await step(3);
  await b.evaluate("(() => { document.querySelector('#mode-start [data-play=explore]').click(); document.getElementById('choose-kbm').click(); return true; })()");
  await b.waitFor('!!window.briel', 300000).catch((e) => {
    console.log(`     ${name}'s last lines:\n       ${b.logs.slice(-8).join('\n       ')}`);
    throw e;
  });
  await b.waitFor("(() => { const p = document.getElementById('start-panel'); if (!p || p.offsetParent === null) return true; const s = getComputedStyle(p); return s.visibility === 'hidden' || Number(s.opacity) < 0.05; })()", 240000);
  await b.waitFor('briel.helis.together && !!briel.combat.me', 60000);
  await b.evaluate("document.getElementById('cc-close')?.click()", false);
  return b;
}

process.on('exit', (code) => code && console.log('FAILED (stopped)'));
try {
  // A guest's name stays with whoever joined with it for the day: new ones each run.
  const tag = Array.from({ length: 4 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
  const pilot = await page(ports[0], `Pilot${tag}`);
  const watcher = await page(ports[1], `Watch${tag}`);
  const m0 = await pilot.evaluate('(() => { const s = briel.helis.machines[0].s; return { x: s.x, y: s.y, z: s.z }; })()');
  // The pilot's lever from the check (the machine's own flight, with this as its input).
  await pilot.evaluate(`(() => { const m = briel.helis.machines[0]; const fly = m.fly; window.__lift = 0; m.fly = function (dt, input, others) { return fly.call(this, dt, this.flown ? { lift: window.__lift } : input, others); }; return true; })()`);
  // Beside the cabin, facing it, and long enough for the server to have us there before Use.
  await pilot.evaluate(`(() => { const s = briel.helis.machines[0].s; const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw), rx = -fz, rz = fx; const x = s.x + rx * 1.5 + fx * 1.4, z = s.z + rz * 1.5 + fz * 1.4; briel.teleport(x, z, s.y + 0.3, Math.atan2(-(s.x - x), -(s.z - z)), -0.2); return true; })()`, false);
  await sleep(3000);
  for (let i = 0; i < 6 && !(await pilot.evaluate('briel.helis.aboard')); i++) {
    await pilot.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyE', key: 'e', windowsVirtualKeyCode: 69 });
    await sleep(60);
    await pilot.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyE', key: 'e', windowsVirtualKeyCode: 69 });
    await sleep(1200);
  }
  ok('Pilot aboard', await pilot.evaluate('briel.helis.aboard && briel.helis.piloting'), await pilot.evaluate("document.getElementById('prompt')?.textContent ?? ''"));
  // Watcher 22 m off, looking at the pad.
  const feet = await watcher.evaluate(`briel.world.groundAt(${m0.x + 22}, ${m0.z + 4}, 200, 0).y`);
  const yaw = Math.atan2(-(m0.x - (m0.x + 22)), -(m0.z - (m0.z + 4)));
  await watcher.evaluate(`briel.teleport(${m0.x + 22}, ${m0.z + 4}, ${feet}, ${yaw}, 0.05)`, false);
  await watcher.evaluate("(() => { const s = document.createElement('style'); s.textContent = '#capture-hint { display: none !important; }'; document.head.appendChild(s); return true; })()");
  // Up: the run-up, the lift-off, then held at about 4 m.
  await pilot.evaluate('window.__lift = 1', false);
  await pilot.waitFor(`briel.helis.machines[0].s.y > ${m0.y + 4}`, 30000).catch(() => {});
  await pilot.evaluate('window.__lift = 0', false);
  await sleep(4000);
  const seen = async (b) => b.evaluate("(() => { const st = briel.rotorWash.state(); const s = briel.helis.machines[0].s; return { y: s.y, st }; })()");
  const p = await seen(pilot);
  const w = await seen(watcher);
  const line = (r) => `machine ${r1(r.y - m0.y)} m up; wash ${r.st.machines.map((m) => `${r1(m.w)} on ${m.kind}`).join(', ')}; disc ${r1(r.st.discs[0][3])}`;
  console.log(`     Pilot sees: ${line(p)}`);
  console.log(`     Watcher sees: ${line(w)}`);
  ok("Watcher works out the wash under the other's machine", w.y - m0.y > 2 && w.st.machines.some((m) => m.w > 0.4) && w.st.discs[0][3] > 0.4);
  if (o.out) await watcher.screenshot(join(o.out, 'mp-watcher-hover.png'));
  // Down: the dust clears as it settles and the rotor runs down.
  await pilot.evaluate('window.__lift = -1', false);
  await pilot.waitFor('briel.helis.machines[0].s.ground', 30000).catch(() => {});
  await pilot.evaluate('window.__lift = 0', false);
  await sleep(1500);
  if (o.out) await watcher.screenshot(join(o.out, 'mp-watcher-landed.png'));
  const errors = pages.flatMap((b) => b.logs.filter((l) => /^(error|exception)/i.test(l) && !/Failed to load resource/.test(l)));
  ok('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
} finally {
  for (const b of pages) b.close();
  admin.close();
  console.log(failed ? `${failed} FAILED` : 'all ok');
}
