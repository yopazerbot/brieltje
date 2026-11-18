// Pictures of Attack and defend (server/assault.mjs, world/assaultCamp.ts, world/truck.ts) in a real page joined to a
// throwaway game server: the host's programme starts it (red defends the church), the page looks at the church's camp
// from the air and from the ground, the spawn truck close by, the defenders' crates at the church; the admin (blue)
// then carries the flag into the camp over its own connection, and after the break the page looks at the Sparrenhof's
// camp the same way. Each picture on the preset asked for, and with --phone on a phone's screen (touch).
//
//   ADMIN_PASSWORD=... node tools/dev/assault_shots.mjs --url http://localhost:5431/ --api http://localhost:8431 --out <folder>
//        [--port 9431] [--preset high|low] [--phone]
import { join } from 'node:path';
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { launch, localOnly, options } from './cdp.mjs';
import { FIELDS } from '../../web/shared/flagFields.mjs';

const o = options({ url: 'http://localhost:5431/', api: 'http://localhost:8431', out: '.', port: '9431', preset: 'high', phone: false });
localOnly(o.api);
const password = process.env.ADMIN_PASSWORD;
if (!password) throw new Error('ADMIN_PASSWORD is not set');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (method, path, body, cookie = '') => {
  const r = await fetch(o.api + path, { method, headers: { 'Content-Type': 'application/json', Origin: o.api, Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  return { r, data: await r.json().catch(() => null) };
};
const cookie = (await call('POST', '/api/login', { username: 'admin', password })).r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const act = (b) => call('POST', '/api/host', b, cookie);
await act({ op: 'reset' });
await act({ op: 'lock', on: false });
await call('POST', '/api/lockouts', {}, cookie);
const admin = new WebSocket(`ws://${new URL(o.api).host}/ws?v=2`, { headers: { Cookie: cookie, Origin: o.api } });
const modes = [];
admin.on('message', (d) => {
  const m = JSON.parse(String(d));
  if (m.t === 'ping') admin.send(JSON.stringify({ t: 'pong', n: m.n }));
  if (m.t === 'mode') modes.push(m.mode);
});
await new Promise((r) => admin.on('open', r));
const state = (p) => admin.send(JSON.stringify({ t: 'state', x: p[0], y: p[2], z: p[1], yaw: 0, pitch: 0, armed: true, w: 'pistol' }));
state([4.5, 14, -0.1]);

const b = await launch({ port: Number(o.port), width: 1280, height: 720 });
console.log('browser PID:', b.pid);
const tag = `${o.preset}${o.phone ? '-phone' : ''}`;
try {
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('briel.graphics','${o.preset}');localStorage.setItem('briel.lang','en');localStorage.setItem('briel.playMode','action');localStorage.setItem('briel.feedback','later');` });
  if (o.phone) {
    await b.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await b.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  }
  await b.send('Page.navigate', { url: o.url });
  const button = o.phone ? '#choose-touch' : '#choose-kbm';
  await b.waitFor(`!!document.querySelector('${button}')`);
  await b.sleep(6000);
  const name = `shot${Math.random().toString(36).slice(2, 6)}`;
  await b.evaluate(`(() => {
    const n = document.querySelector('#nick'); n.value = '${name}'; n.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-mp=multi]').click();
    const age = document.querySelector('#mp-age'); if (!age.checked) age.click();
    document.querySelector('${button}').click();
  })()`, false);
  await b.waitFor('!!window.briel', 120000);
  await b.waitFor("(() => { const p = document.getElementById('start-panel'); if (!p || p.offsetParent === null) return true; const s = getComputedStyle(p); return s.visibility === 'hidden' || Number(s.opacity) < 0.05; })()", 240000);
  await b.waitFor('!!briel.combat.me', 60000);
  await b.waitFor("briel.village() === 'ready'", 240000);
  await b.evaluate("document.getElementById('cc-close')?.click()", false);
  // December on this page (world/season.ts): the Christmas tree on the church square in free play, solid for walking.
  const tree = "({ shown: briel.christmas.lit && briel.christmas.tree.visible, solid: briel.world.walkingBarriers.has('christmas-tree') || briel.world.moving.has('christmas-tree') })";
  if (!o.phone) {
    await b.evaluate("briel.season.fake('2026-12-10')", false);
    await b.waitFor('briel.christmas.lit', 60000);
    await sleep(500);
    const before = await b.evaluate(tree);
    console.log(`${before.shown && before.solid ? 'ok  ' : 'FAIL'} in free play the tree stands, solid: ${JSON.stringify(before)}`);
  }
  await act({ op: 'teams', count: 2 });
  await act({ op: 'move', name: 'admin', team: 0 });
  await act({ op: 'move', name, team: 1 }); // the page on red: it defends the church first
  await act({ op: 'start', kind: 'assault', defend: 'red', minutes: 5 });
  await b.waitFor("briel.games.view.flag?.assault?.round === 1", 30000);
  await sleep(3000);
  if (!o.phone) {
    const during = await b.evaluate(tree);
    console.log(`${!during.shown && !during.solid ? 'ok  ' : 'FAIL'} during the flag game no tree at the church's stand: ${JSON.stringify(during)}`);
    await b.evaluate(`briel.teleport(${FIELDS.assaultChurch.bases.blue.stand[0] - 10}, ${FIELDS.assaultChurch.bases.blue.stand[1] - 6}, ${FIELDS.assaultChurch.bases.blue.stand[2]}, ${Math.atan2(-10, -6)}, 0.05)`, false);
    await sleep(2000);
    await b.screenshot(join(o.out, `church-stand-december-${tag}.png`));
  }
  // What the page sends (the Use checks below read it).
  await b.evaluate(`(() => { window.__sent = []; const send = WebSocket.prototype.send; WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (m.t === 'car' || m.t === 'heli' || m.t === 'asup') window.__sent.push(m); } catch {} return send.call(this, d); }; })()`, false);
  const look = async (file, x, z, feet, yaw, pitch, fly = true) => {
    const put = `briel.teleport(${x}, ${z}, ${feet}, ${yaw}, ${pitch}); briel.player.flying = ${fly}`;
    await b.evaluate(put, false);
    await sleep(2500);
    await b.evaluate(put, false); // flying is off together: in the air the page would have fallen meanwhile
    await sleep(120);
    await b.screenshot(join(o.out, `${file}-${tag}.png`));
    console.log('saved', `${file}-${tag}.png`);
  };
  const at = (cx, cz, tx, tz) => Math.atan2(-(tx - cx), -(tz - cz));
  const camp = async (field, key) => {
    const c = FIELDS[field].assault.camp;
    const [fx, fz, fy] = c.flag;
    // From the air, behind its back corner; from the ground at its front; the spawn truck close by.
    const ax = fx + 40 * Math.sin(c.yaw), az = fz + 40 * Math.cos(c.yaw);
    await look(`${key}-air`, ax, az, fy + 22, at(ax, az, fx, fz), -0.45);
    const gx = fx - 22 * Math.sin(c.yaw), gz = fz - 22 * Math.cos(c.yaw);
    await look(`${key}-ground`, gx, gz, fy, at(gx, gz, fx, fz), -0.05, false);
    const [tx, tz, ty] = c.truck;
    await look(`${key}-truck`, tx + 7, tz + 5, ty + 1.5, at(tx + 7, tz + 5, tx, tz), -0.15);
  };
  // At the defenders' ammo crate (the page is red, defending, and starts a few metres off; the server holds a page to a
  // run, so the step there is short): the prompt says what Use takes; E takes it, and the prompt counts down.
  const crates = FIELDS.assaultChurch.assault.crates;
  if (!o.phone) {
    await b.evaluate(`briel.teleport(${crates[0].at[0] + 0.6}, ${crates[0].at[1] - 0.8}, ${crates[0].at[2]}, Math.PI, 0)`, false);
    await sleep(4000);
    const prompt = await b.evaluate("document.getElementById('prompt').textContent");
    console.log(`${/ammo/i.test(prompt) ? 'ok  ' : 'FAIL'} the prompt at the ammo crate: ${prompt}`);
    for (const type of ['keyDown', 'keyUp']) {
      await b.send('Input.dispatchKeyEvent', { type, code: 'KeyE', key: 'e', windowsVirtualKeyCode: 69 });
      await sleep(120);
    }
    await sleep(1200);
    const after = await b.evaluate("document.getElementById('prompt').textContent");
    console.log(`${/again in/i.test(after) ? 'ok  ' : 'FAIL'} after E the prompt counts down: ${after}`);
    await b.screenshot(join(o.out, `church-ammo-${tag}.png`));
  }
  await camp('assaultChurch', 'church-camp');
  await look('church-crates', crates[2].at[0] - 1, crates[2].at[1] - 6, crates[2].at[2], 0 + Math.PI, -0.2, false);
  // The admin carries the flag from the church's stand into the camp: round 1 over, the break, round 2.
  const s1 = FIELDS.assaultChurch.bases.blue.stand;
  const c1 = FIELDS.assaultChurch.assault.camp.flag;
  // In steps the admin's own pace allows (the server holds every move to it).
  for (let i = 0; i <= 60; i++) {
    state([4.5 + (s1[0] - 4.5) * (i / 60), 14 + (s1[1] - 14) * (i / 60), s1[2]]);
    await sleep(100);
  }
  await sleep(800);
  for (let i = 1; i <= 60; i++) {
    state([s1[0] + (c1[0] - s1[0]) * (i / 60), s1[1] + (c1[1] - s1[1]) * (i / 60), s1[2] + (c1[2] - s1[2]) * (i / 60)]);
    await sleep(100);
  }
  await b.waitFor("briel.games.view.flag?.field === 'assaultSparrenhof'", 30000);
  await sleep(3000);
  await camp('assaultSparrenhof', 'sparrenhof-camp');
  const crates2 = FIELDS.assaultSparrenhof.assault.crates;
  await look('sparrenhof-crates', crates2[2].at[0], crates2[2].at[1] + 6, crates2[2].at[2], 0, -0.2, false);
  console.log('bar:', await b.evaluate("document.getElementById('modebar')?.textContent"));
  // Round 2: the page attacks from the Sparrenhof's camp. By the spawn truck and by the camp's helicopter Use gets you
  // in; a step back the prompt offers ammo and Use takes it (the server's answer counts down).
  if (!o.phone) {
    await b.waitFor("briel.games.view.flag?.assault?.phase === 'live'", 40000);
    await sleep(3000);
    const press = async () => {
      for (const type of ['keyDown', 'keyUp']) {
        await b.send('Input.dispatchKeyEvent', { type, code: 'KeyE', key: 'e', windowsVirtualKeyCode: 69 });
        await sleep(120);
      }
    };
    /** A spot `d` m from the outline of the page's car or helicopter `id`, out from its middle at angle `a`. */
    const spotAt = (kind, id, d, a) => b.evaluate(`(() => {
      const m = '${kind}' === 'heli' ? briel.helis.machines.find((q) => q.spec.id === '${id}') : briel.cars.find((c) => c.id === '${id}');
      const at = '${kind}' === 'heli' ? m.s : m;
      for (let r = 0; r < 12; r += 0.02) {
        const x = at.x + Math.cos(${a}) * r, z = at.z + Math.sin(${a}) * r;
        if (m.distanceTo(x, z) >= ${d}) return { x, z, y: at.y };
      }
      return null;
    })()`);
    const stand = async (q) => {
      // A short walk there for the server too (it holds a page to a run): 25 to 35 m from the camp.
      await b.evaluate(`briel.teleport(${q.x}, ${q.z}, ${q.y}, 0, 0)`, false);
      await sleep(9000);
      await b.evaluate(`briel.teleport(${q.x}, ${q.z}, ${q.y}, 0, 0)`, false);
      await sleep(600);
    };
    const sent = () => b.evaluate('window.__sent.map((m) => m.t + ":" + (m.op ?? m.id))');
    const check = async (label, kind, id) => {
      await stand(await spotAt(kind, id, 0.7, 0.3));
      const promptNear = await b.evaluate("document.getElementById('prompt').textContent");
      await b.evaluate('window.__sent.length = 0', false);
      await press();
      await sleep(800);
      const sentNear = await sent();
      console.log(`${sentNear.includes(kind + ':in') && !sentNear.some((m) => m.startsWith('asup')) ? 'ok  ' : 'FAIL'} by the ${label} Use gets you in (prompt "${promptNear}", sent ${JSON.stringify(sentNear)})`);
      await b.screenshot(join(o.out, `use-${kind}-near-${tag}.png`));
      await press(); // out again
      await sleep(1500);
      await stand(await spotAt(kind, id, 2.2, 0.3));
      const promptBack = await b.evaluate("document.getElementById('prompt').textContent");
      await b.screenshot(join(o.out, `use-${kind}-back-${tag}.png`));
      await b.evaluate('window.__sent.length = 0', false);
      await press();
      await sleep(1000);
      const sentBack = await sent();
      const after = await b.evaluate("document.getElementById('prompt').textContent");
      console.log(`${/ammo/i.test(promptBack) && sentBack.some((m) => m.startsWith('asup')) && /again in/i.test(after) ? 'ok  ' : 'FAIL'} a step back from the ${label} the prompt offers ammo and Use takes it ("${promptBack}", then "${after}", sent ${JSON.stringify(sentBack)})`);
    };
    await check('spawn truck', 'car', FIELDS.assaultSparrenhof.assault.truck);
    await sleep(21000); // the ammo's wait, before the helicopter's
    await check('helicopter', 'heli', FIELDS.assaultSparrenhof.heli.red.id);
  }
  await act({ op: 'stop' });
  if (!o.phone) {
    await sleep(2500);
    const after = await b.evaluate(tree);
    console.log(`${after.shown && after.solid ? 'ok  ' : 'FAIL'} after the game the tree stands again: ${JSON.stringify(after)}`);
  }
  await act({ op: 'teams', count: 0 });
} finally {
  b.close();
  admin.close();
}
