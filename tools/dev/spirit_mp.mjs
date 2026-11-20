// The Brook Spirit's fight on the page together, against a throwaway game server (a build of this branch on this
// computer) through a dev server whose proxy points at it. Five pages:
// - Cleo, in Explore, walks into the wood first: it stays asleep for her, and nothing ever hurts her.
// - Dave, in Action, stays far away (at home): he is told only of its modes changing, not its every move.
// - Alice and Bob, in Action, walk in from the lane and wake it. Alice keeps her distance, steps out of every tell and
//   shoots the heart and the lights; Bob stands his ground and shoots, until it downs him: he comes back on the lane by
//   its wood, and the kill feed and his death screen name it. Both see the same creature in the same place, gliding.
// - The admin's watch page (/admin/watch/, on the server itself) shows it.
// Then it is beaten: Alice and Bob are both named in the line that says so.
//
// From web/ after `npm run build` (a short fight: the server's test-only settings, server/brookSpirit.mjs):
//   ADMIN_PASSWORD=... SPIRIT_TEST_SCALE=0.2 SPIRIT_TEST_BACK_S=60 PORT=8420 node server.mjs
//   API_PORT=8420 npx vite --port 5421 --strictPort
//   ADMIN_PASSWORD=... node tools/dev/spirit_mp.mjs --url http://localhost:5421/ --api http://localhost:8420 [--out <folder>]
//
// One line per check; exit 1 when any fails.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, localOnly, options } from './cdp.mjs';

const o = options({ url: 'http://localhost:5421/', api: 'http://localhost:8420', ports: '9510,9511,9512,9513,9514', out: '', minutes: '8' });
localOnly(o.url, '--url'); // players join and the admin logs in: a throwaway server on this computer only
localOnly(o.api);
const password = process.env.ADMIN_PASSWORD;
if (!password) throw new Error('ADMIN_PASSWORD is not set');
if (o.out) mkdirSync(o.out, { recursive: true });
const ports = o.ports.split(',').map(Number);
let failed = 0;
const ok = (name, pass, extra = '') => {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} ${extra}`);
  if (!pass) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const G = { x: -68, z: 488 };
const WAKE = { x: -42.2, z: 462 };

/** Counts what the page's connection receives and sends, by type (every frame of the page). */
const SOCKET = `(() => {
  window.__ws = { in: {}, out: {}, sys: [], kills: [], welcome: null };
  const W = window.WebSocket;
  window.WebSocket = class extends W {
    constructor(...a) {
      super(...a);
      this.addEventListener('message', (e) => {
        if (typeof e.data !== 'string') return;
        try {
          const m = JSON.parse(e.data);
          __ws.in[m.t] = (__ws.in[m.t] ?? 0) + 1;
          if (m.t === 'system') __ws.sys.push(m);
          if (m.t === 'kill') __ws.kills.push(m);
          if (m.t === 'welcome') __ws.welcome = m.spirit ?? null;
        } catch {}
      });
    }
    send(d) {
      try { const m = JSON.parse(d); __ws.out[m.t] = (__ws.out[m.t] ?? 0) + 1; } catch {}
      return super.send(d);
    }
  };
})()`;

const browsers = [];
/** A page that joins together under `name`, playing `play` (action, explore). */
async function player(port, name, play) {
  const b = await launch({ port, width: 960, height: 540 });
  browsers.push(b);
  console.log(name, 'browser PID:', b.pid);
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('briel.graphics','low');localStorage.setItem('briel.lang','en');localStorage.setItem('briel.playMode','${play}');localStorage.setItem('briel.feedback','later');${SOCKET}` });
  await b.send('Page.navigate', { url: o.url });
  await b.waitFor("!!document.querySelector('#choose-kbm')");
  await b.sleep(6000); // the dev build attaches the start screen's handlers late
  await b.evaluate(`(() => {
    const n = document.querySelector('#nick'); n.value = '${name}'; n.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-mp=multi]').click();
    const age = document.querySelector('#mp-age'); if (!age.checked) age.click();
    document.querySelector('#choose-kbm').click();
  })()`, false);
  await b.waitFor('!!window.briel', 90000);
  await b.waitFor("(() => { const p = document.getElementById('start-panel'); if (!p || p.offsetParent === null) return true; const s = getComputedStyle(p); return s.visibility === 'hidden' || Number(s.opacity) < 0.05; })()", 240000);
  await b.evaluate("document.getElementById('cc-close')?.click()", false);
  await b.waitFor('briel.net().rtt > 0 || !!__ws.in.welcome', 60000);
  return b;
}

/** In the page: walking helpers and the fighter (careful or not), on the page's own clock. */
const DRIVER = String.raw`(() => {
  const B = briel, P = B.player, S = B.spirit;
  const ground = (x, z) => B.world.groundAt(x, z, -4, 0).y;
  const d = window.__drive = { on: false, careful: true, shots: 0, last: performance.now(), goal: null };
  const trunks = S.fight.trunks;
  const free = (x, z) => trunks.every((t) => Math.hypot(t.x - x, t.z - z) > t.r + 0.55);
  d.walkTo = (x, z) => (d.goal = { x, z });
  function step(tx, tz, dt) {
    const dx = tx - P.x, dz = tz - P.z, l = Math.hypot(dx, dz);
    if (l < 0.05) return [P.x, P.z];
    const s = Math.min(l, 3.2 * dt);
    for (const [ax, az] of [[dx, dz], [-dz, dx], [dz, -dx]]) {
      const k = Math.hypot(ax, az) || 1, nx = P.x + (ax / k) * s, nz = P.z + (az / k) * s;
      if (free(nx, nz)) return [nx, nz];
    }
    return [P.x, P.z];
  }
  setInterval(() => {
    const now = performance.now();
    const dt = Math.min(0.2, (now - d.last) / 1000);
    d.last = now;
    if (!B.combat.alive) return;
    const st = S.state();
    const v = st.view;
    const wire = S.fight.wire;
    let tx = d.goal?.x ?? P.x, tz = d.goal?.z ?? P.z;
    let aim = null;
    if (d.on && v && (v.mode === 'fight' || v.mode === 'mend')) {
      // Keep 13 m from it (Bob: 8 m, in the sweep's reach), round the grove.
      const a = Math.atan2(P.x - v.x, P.z - v.z), R = d.careful ? 13 : 8;
      tx = v.x + Math.sin(a) * R; tz = v.z + Math.cos(a) * R;
      const g = Math.hypot(tx - ${G.x}, tz - ${G.z});
      if (g > 24) { tx = ${G.x} + ((tx - ${G.x}) / g) * 24; tz = ${G.z} + ((tz - ${G.z}) / g) * 24; }
      if (d.careful) {
        const out = (fx, fz, r) => {
          let ux = P.x - fx, uz = P.z - fz, l = Math.hypot(ux, uz);
          if (l < 0.5) { const sx = P.x - v.x, sz = P.z - v.z, k = Math.hypot(sx, sz) || 1; ux = -sz / k; uz = sx / k; l = 1; }
          tx = fx + (ux / l) * r; tz = fz + (uz / l) * r;
        };
        if (v.act === 'sweep') {
          const ex = v.tx - v.x, ez = v.tz - v.z, len = Math.hypot(ex, ez) || 1;
          const u = ((P.x - v.x) * ex + (P.z - v.z) * ez) / len, side = ((P.x - v.x) * ez - (P.z - v.z) * ex) / len;
          if (u > -1 && u < len + 1 && Math.abs(side) < 2.4) { const k = side >= 0 ? 1 : -1; tx = P.x + (ez / len) * 3 * k; tz = P.z - (ex / len) * 3 * k; }
        }
        if (v.act === 'bolt' && Math.hypot(P.x - v.tx, P.z - v.tz) < 4.2) out(v.tx, v.tz, 5.5);
        for (const p of wire?.pools ?? []) if (Math.hypot(P.x - p.x, P.z - p.z) < 3.6) out(p.x, p.z, 4.6);
        if (v.act === 'pool' && Math.hypot(P.x - v.tx, P.z - v.tz) < 3.6) out(v.tx, v.tz, 4.6);
      }
      aim = st.heart;
      if (!aim) for (const l of st.lights) if (l && (!aim || Math.hypot(l[0] - P.x, l[2] - P.z) < Math.hypot(aim[0] - P.x, aim[2] - P.z))) aim = l;
    }
    const [nx, nz] = step(tx, tz, dt);
    const look = aim ?? (v ? [v.x, v.y, v.z] : [nx, ground(nx, nz) + 1.6, nz - 1]);
    const f = ground(nx, nz), dx = look[0] - nx, dy = look[1] - (f + 1.6), dz = look[2] - nz;
    B.teleport(nx, nz, f, Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
    if (aim && Math.hypot(dx, dz) < 40 && B.weapon.enabled) { if (B.weapon.current !== 'rifle' && B.weapon.owned.has('rifle')) B.weapon.select('rifle'); B.fire(); d.shots++; }
  }, 50);
  return true;
})()`;

/** Walk a page to (x, z) at a walking pace and wait until it is there (or `ms` passed). */
async function walk(b, x, z, ms = 60000) {
  await b.evaluate(`__drive.walkTo(${x}, ${z})`, false);
  for (let t = 0; t < ms; t += 500) {
    const d = await b.evaluate(`Math.hypot(briel.player.x - ${x}, briel.player.z - ${z})`, false);
    if (d < 1) return true;
    await sleep(500);
  }
  return false;
}
const view = (b) => b.evaluate("(() => { const s = briel.spirit.state(); return { mode: s.view?.mode ?? null, act: s.view?.act ?? null, hp: s.view?.hp ?? null, x: s.view?.x, z: s.view?.z, absent: s.absent, dist: s.dist }; })()", false);
const text = (b, sel) => b.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`, false);

try {
  const tag = Math.random().toString(36).slice(2, 6);
  const [cleo, dave, alice, bob] = [
    await player(ports[0], `Cleo${tag}`, 'explore'),
    await player(ports[1], `Dave${tag}`, 'action'),
    await player(ports[2], `Alice${tag}`, 'action'),
    await player(ports[3], `Bob${tag}`, 'action'),
  ];
  for (const b of [cleo, alice, bob]) await b.evaluate(DRIVER, false);
  ok('the welcome carries the spirit', !!(await cleo.evaluate('__ws.welcome', false)));
  // Cleo first: to Moeyweedreef, into the wood, under it.
  // The trip to Moeyweedreef (once each has landed: no trip in a drop), asked again until the server has them there.
  for (const [who, b] of [['Cleo', cleo], ['Alice', alice], ['Bob', bob]]) {
    let there = false;
    for (let i = 0; i < 6 && !there; i++) {
      await b.waitFor('briel.player.chute === null && briel.combat.alive', 60000);
      await b.evaluate("briel.travel('street:moeyweedreef')", false);
      await sleep(4000);
      there = await b.evaluate(`Math.hypot(briel.player.x - ${G.x}, briel.player.z - ${G.z}) < 130`, false);
    }
    ok(`${who} takes the trip to Moeyweedreef`, there);
  }
  await walk(cleo, -46, 470);
  await walk(cleo, -62, 482);
  await walk(cleo, -76, 488);
  await sleep(5000);
  const c0 = await view(cleo);
  ok('in Explore it stays asleep, under it too', c0.mode === 'asleep', JSON.stringify(c0));
  ok('Explore: the line says it only wakes in Action or Paintball', /only wakes/.test(await text(cleo, '#spirit-line')));
  if (o.out) await cleo.screenshot(join(o.out, 'mp-cleo-asleep.png'));
  await walk(cleo, -64, 480);
  // Alice and Bob walk in and wake it.
  await walk(alice, -46, 470);
  await walk(bob, -47, 472);
  await alice.evaluate('__drive.on = true; __drive.careful = true', false);
  await bob.evaluate('__drive.on = true; __drive.careful = false', false);
  await walk(alice, -58, 478, 20000);
  let woke = false;
  for (let t = 0; t < 30 && !woke; t++) {
    woke = (await view(alice)).mode === 'fight';
    await sleep(500);
  }
  ok('two fighters wake it', woke);
  // The same creature in the same place on both pages, gliding: sampled together for 15 s.
  await alice.evaluate("window.__glide = []; (function f() { const p = briel.spirit.fight.look?.group.position; if (p) __glide.push([p.x, p.z]); if (__glide.length < 900) requestAnimationFrame(f); })()", false);
  let worst = 0;
  for (let i = 0; i < 30; i++) {
    const [a, b] = await Promise.all([view(alice), view(bob)]);
    if (a.mode === 'fight' && b.mode === 'fight') worst = Math.max(worst, Math.hypot(a.x - b.x, a.z - b.z));
    await sleep(500);
  }
  ok('Alice and Bob see it in the same place', worst < 1.5, `(worst ${worst.toFixed(2)} m apart)`);
  const glide = await alice.evaluate('(() => { let m = 0; for (let i = 1; i < __glide.length; i++) m = Math.max(m, Math.hypot(__glide[i][0] - __glide[i - 1][0], __glide[i][1] - __glide[i - 1][1])); return { frames: __glide.length, maxStep: m }; })()', false);
  ok('it glides (no jump between two frames but a rise elsewhere)', glide.maxStep < 0.6 || glide.frames < 10, JSON.stringify(glide));
  if (o.out) await alice.screenshot(join(o.out, 'mp-alice-fight.png'));
  // The admin's watch page, on the server itself.
  const w = await launch({ port: ports[4], width: 1280, height: 720 });
  browsers.push(w);
  console.log('watch browser PID:', w.pid);
  await w.send('Page.addScriptToEvaluateOnNewDocument', { source: SOCKET });
  await w.send('Page.navigate', { url: `${o.api}/` });
  await w.sleep(3000);
  const login = await w.evaluate(`fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: ${JSON.stringify(password)} }) }).then((r) => r.status)`, true);
  ok('the admin logs in', login === 200, String(login));
  await w.send('Page.navigate', { url: `${o.api}/admin/watch/` });
  await w.sleep(25000);
  const frames = await w.evaluate('[...document.querySelectorAll("iframe")].map((f) => { try { const s = f.contentWindow.__ws; const v = f.contentWindow.briel?.spirit?.state().view; return s ? { welcome: !!s.welcome, sp: s.in.sp ?? 0, mode: v?.mode ?? null, in: s.in, src: f.src } : null; } catch { return "closed"; } })', false);
  ok('the watch view gets the spirit and its moves during the fight', frames.some((f) => f && f.welcome && f.sp > 5), JSON.stringify(frames));
  if (o.out) await w.screenshot(join(o.out, 'mp-watch.png'));
  // Bob stands his ground until it downs him.
  let downed = false;
  for (let t = 0; t < 240 && !downed; t++) {
    downed = !(await bob.evaluate('briel.combat.alive', false));
    if (!downed) await sleep(500);
  }
  ok('it downs Bob, who stands in its reach', downed);
  if (downed) {
    await sleep(600);
    const death = await text(bob, '#death-title');
    const feed = await text(bob, '#killfeed');
    ok('his death screen names it', /Brook Spirit/.test(death), JSON.stringify(death));
    ok('the kill feed names it, with no raw word', /Brook Spirit/.test(feed) && !/spirit\b|zombie/i.test(feed.replace(/Brook Spirit/g, '')), JSON.stringify(feed));
    if (o.out) await bob.screenshot(join(o.out, 'mp-bob-down.png'));
    // Where he is the moment he is up again (he walks back in at once).
    const at = await bob.evaluate('new Promise((r) => { const t = setInterval(() => { if (briel.combat.alive) { clearInterval(t); r({ x: briel.player.x, z: briel.player.z }); } }, 30); setTimeout(() => { clearInterval(t); r(null); }, 15000); })', true);
    ok('Bob comes back on the lane by its wood', !!at && Math.hypot(at.x - WAKE.x, at.z - WAKE.z) < 4, JSON.stringify(at));
    await bob.evaluate('__drive.careful = true', false); // and fights on with care
  }
  // To the end.
  let end = null;
  for (let t = 0; t < Number(o.minutes) * 120 && !end; t++) {
    const v = await view(alice);
    if (v.mode === 'apart' || v.mode === 'gone') end = v;
    else await sleep(500);
  }
  ok('it is beaten', !!end, JSON.stringify(end ?? (await view(alice))));
  await sleep(1500);
  for (const [who, b] of [['Alice', alice], ['Bob', bob]]) {
    const sys = await b.evaluate("__ws.sys.filter((m) => m.code === 'spBeaten')", false);
    const names = sys[0]?.args?.names ?? [];
    ok(`${who} is told it is beaten, both named`, names.some((n) => /^alice/i.test(n)) && names.some((n) => /^bob/i.test(n)), JSON.stringify(sys[0]?.args ?? null));
    ok(`${who}'s page shows the line translated`, /sent the Brook Spirit back into the mist/.test(await b.evaluate('document.body.innerText', false)));
    ok(`${who} sent hits`, (await b.evaluate('__ws.out.sphit ?? 0', false)) > 0, String(await b.evaluate('__ws.out.sphit ?? 0', false)));
  }
  if (o.out) await alice.screenshot(join(o.out, 'mp-alice-beaten.png'));
  const cleoEnd = await cleo.evaluate('({ hp: briel.combat.hp, alive: briel.combat.alive, hurt: __ws.in.hurt ?? 0, kills: __ws.kills.filter((k) => k.victim.startsWith("Cleo")).length })', false);
  ok('Cleo in Explore was never hurt', cleoEnd.alive && cleoEnd.kills === 0 && cleoEnd.hurt === 0, JSON.stringify(cleoEnd));
  const far = await dave.evaluate('({ sp: __ws.in.sp ?? 0, spe: __ws.in.spe ?? 0, dist: briel.spirit.state().dist })', false);
  const near = await alice.evaluate('({ sp: __ws.in.sp ?? 0, spe: __ws.in.spe ?? 0 })', false);
  ok('Dave, far away, gets only its mode changes', far.sp > 0 && far.sp < 12 && near.sp > 10 * far.sp, `far ${JSON.stringify(far)}, near ${JSON.stringify(near)}`);
} catch (e) {
  ok('the run', false, e.message);
} finally {
  for (const b of browsers) b.close();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
