// Zombies at the church together, in two pages, through a dev server whose proxy points at a throwaway game server
// (API_PORT=<server port> npx vite --port <n>): the admin (a socket of this script, not playing) starts Zombies at the
// church and picks waves 2, 3 and 4 (afresh for each half: anyone down is back up). Alice (keyboard and mouse,
// --preset) and Bob (a phone held sideways, Low) go in and out of the café: each wave one of them inside (toilet 2, the
// bar room, the front room), the other on the square, the lane or the back street with the gun put away (no fighter:
// the zombies go for the one inside), and halfway through they swap. Once reached (a swipe, or a zombie swiping within
// 1.6 m: their health does not come back between halves), the one inside puts the gun away too,
// so the game is never over for want of a fighter. The check proves that all six halves are played and in each a
// zombie reaches the one inside, that a door a zombie shoves open swings on both pages, that neither page ever shows a
// zombie in a wall or a piece of furniture of the café or on a chair, and that nobody is told the zombies can't reach
// them; it takes pictures.
//
//   ADMIN_PASSWORD=... node tools/dev/keet_zombies_mp.mjs --url http://localhost:5437/ --api http://localhost:8437
//        --ports 9862,9863 [--preset high] [--out <folder>] [--secs 240]
//
// --secs: the most each wave may take (half for each one inside); a half ends a few seconds after the one inside is swiped.
//
// The password comes from the environment and is never printed. A fresh server on an empty web/.data, on your own port.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { makeKeet } from '../../web/shared/keet.mjs';
import { readPlayer } from '../../web/shared/wire.mjs';
import { launch, localOnly, options } from './cdp.mjs';

const o = options({ url: 'http://localhost:5437/', api: 'http://localhost:8437', ports: '9862,9863', preset: 'high', out: '', secs: '240' });
localOnly(o.url, '--url');
localOnly(o.api); // the admin starts games: a throwaway server on this computer only
const password = process.env.ADMIN_PASSWORD;
if (!password) throw new Error('ADMIN_PASSWORD is not set');
const read = (f) => JSON.parse(readFileSync(new URL(`../../web/src/data/${f}`, import.meta.url), 'utf8'));
const shell = read('keet_shell.json');
const keet = makeKeet(shell, read('keet_rooms.json'));
const { o: fo, a: fa, floor: F } = shell.frame;
const W = (u, v) => [fo[0] + u * Math.cos(fa) + v * Math.sin(fa), fo[1] - u * Math.sin(fa) + v * Math.cos(fa)];
const [pa, pb] = o.ports.split(',').map(Number);
let failed = 0;
const ok = (name, pass, extra = '') => {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} ${extra}`);
  if (!pass) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The admin's socket.
const login = await fetch(`${o.api}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: o.api }, body: JSON.stringify({ username: 'admin', password }) });
const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const rootLog = [];
const root = new WebSocket(`ws://${new URL(o.api).host}/ws?v=4`, { headers: { Cookie: cookie, Origin: o.api } });
root.on('message', (d) => {
  const m = JSON.parse(String(d));
  if (m.t === 'ping') root.send(JSON.stringify({ t: 'pong', n: m.n }));
  rootLog.push(m);
});
await new Promise((res, rej) => (root.on('open', res), root.on('error', rej)));
const admin = (m) => root.send(JSON.stringify(m));

/** A page that joins together under `name` (as tools/dev/drive_mp.mjs does). */
async function player(port, name, phone, preset) {
  const b = await launch({ port, width: 960, height: 540 });
  console.log(name, 'browser PID:', b.pid);
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('briel.graphics','${preset}');localStorage.setItem('briel.lang','en');localStorage.setItem('briel.playMode','action');localStorage.setItem('briel.feedback','later');` });
  if (phone) {
    await b.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await b.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  }
  await b.send('Page.navigate', { url: o.url });
  await b.waitFor("!!document.querySelector('#choose-kbm')");
  await b.sleep(6000);
  await b.evaluate(`(() => {
    const n = document.querySelector('#nick'); n.value = '${name}'; n.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-mp=multi]').click();
    const age = document.querySelector('#mp-age'); if (!age.checked) age.click();
    document.querySelector('${phone ? '#choose-touch' : '#choose-kbm'}').click();
  })()`, false);
  await b.waitFor('!!window.briel', 90000);
  await b.waitFor("(() => { const p = document.getElementById('start-panel'); if (!p || p.offsetParent === null) return true; const s = getComputedStyle(p); return s.visibility === 'hidden' || Number(s.opacity) < 0.05; })()", 240000);
  await b.waitFor("briel.village() === 'ready'", 240000);
  await b.waitFor("briel.doors.doors.some((d) => d.spec.id === 'keet-gate')", 120000);
  return b;
}
const tag = Math.random().toString(36).slice(2, 6);
const alice = await player(pa, `Alice${tag}`, false, o.preset);
const bob = await player(pb, `Bob${tag}`, true, 'low');
const pages = { alice, bob };
const names = { alice: `Alice${tag}`, bob: `Bob${tag}` };
/** The waves played: quicker zombies than the first ones, and few enough for two players who never shoot back. */
const WAVES = [2, 3, 4];
const solids = keet.prisms.filter((p) => p.y1 > F + 0.3 && p.y0 < F + 1.75);
const inRing = (x, z, ring) => {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
};
const face = (x, z, ax, az) => Math.atan2(-(ax - x), -(az - z));
/** Where each one goes, by wave: inside first for one, outside for the other; they swap halfway. */
const inside = [[1.0, 16.0, 1.0, 13.0], [4.1, 13.0, 4.7, 9.0], [2.0, 2.2, 4.7, -1.0]]; // [u, v] to stand, [u, v] to look at
const outside = [[3.0, -6.0, 4.7, 0.0], [7.8, 9.0, 5.8, 9.0], [2.9, 19.6, 2.9, 17.0]];
/** Where the server has player `name` now (the admin's ticks). */
const serverAt = (name) => {
  for (let i = rootLog.length - 1; i >= 0; i--) {
    const e = rootLog[i].t === 's' && (rootLog[i].p ?? []).find((q) => q[0].toLowerCase() === name.toLowerCase());
    if (e) return readPlayer(e);
  }
  return null;
};
/**
 * Page `b` (player `name`) teleports there. The server moves them no faster than a run, in a straight line through the
 * café's walls, where the zombies can't get at them for a few seconds: once the server has them there and 3 s more, the
 * chat is cleared, so a warning that they are out of reach counts only from where they stand.
 */
const put = async (b, name, [u, v, lu, lv]) => {
  const [x, z] = W(u, v);
  const [lx, lz] = W(lu, lv);
  const y = await b.evaluate(`briel.world.groundAt(${x}, ${z}, ${F} + 0.6, 0).y`);
  await b.evaluate(`briel.teleport(${x}, ${z}, ${y}, ${face(x, z, lx, lz)}, -0.05)`, false);
  for (let i = 0; i < 60; i++) {
    const p = serverAt(name);
    if (p && Math.hypot(p.x - x, p.z - z) < 0.5) break;
    await sleep(250);
  }
  await sleep(3000);
  await b.evaluate("document.getElementById('chat-log').textContent = ''", false);
};
const seen = { alice: { inside: 0, inSolid: 0, worst: -Infinity }, bob: { inside: 0, inSolid: 0, worst: -Infinity } };
const look = async (who) => {
  const zs = await pages[who].evaluate('briel.zombies.states().filter((z) => !z.down).map((z) => [z.x, z.y, z.z])');
  for (const [x, y, z] of zs) {
    if (!keet.contains(x, z)) continue;
    seen[who].inside++;
    seen[who].worst = Math.max(seen[who].worst, y - F);
    if (solids.some((p) => inRing(x, z, p.p[0]) && y + 0.02 < p.y1 && y + 1.6 > p.y0)) seen[who].inSolid++;
  }
};
const perch = async (who) => pages[who].evaluate("document.getElementById('chat-log').textContent.includes(\"can't reach you there\")");

try {
  admin({ t: 'mode', kind: 'zombies', place: 'church' });
  await sleep(4000);
  ok('Zombies at the church started', rootLog.some((m) => m.t === 'mode' && m.mode?.kind === 'zombies'));
  const swung = [];
  const hurtInside = { alice: 0, bob: 0 };
  let halves = 0;
  let ended = '';
  const running = () => rootLog.filter((m) => m.t === 'mode').at(-1)?.mode?.kind === 'zombies';
  for (let w = 0; w < 3; w++) {
    for (const [inner, outer] of [['alice', 'bob'], ['bob', 'alice']]) {
      // Every half must be played: the game must still run (see below how it is kept alive).
      if (!running()) {
        ended ||= `the game ended before wave ${WAVES[w]}, ${inner} inside`;
        continue;
      }
      halves++;
      // The one outside has the gun put away: no fighter, so the zombies go for the one inside (they take the nearest).
      await pages[inner].evaluate('briel.weapon.setEnabled(true)', false);
      await pages[outer].evaluate('briel.weapon.setEnabled(false)', false);
      await Promise.all([put(pages[inner], names[inner], inside[w]), put(pages[outer], names[outer], outside[w])]);
      admin({ t: 'zwave', wave: WAVES[w] }); // this wave afresh for each half (anyone down is back up)
      const t0 = Date.now();
      const hp0 = await pages[inner].evaluate('briel.combat.hp');
      let hurt = false;
      let pictured = false;
      let read = rootLog.length;
      let after = Infinity; // a few seconds more once swiped (the pages see the zombies inside), then the swap
      let tick = 0;
      while (Date.now() - t0 < (Number(o.secs) * 1000) / 2 && Date.now() < after && running()) {
        await sleep(150);
        if (++tick % 3 === 0) {
          await look('alice');
          await look('bob');
        }
        // Reached: health lost, or a zombie swiping within 1.6 m (as soon as its swipe starts: the health of the one inside
        // does not come back between halves, so it should take as few swipes as can be).
        const reach = await pages[inner].evaluate(`(() => {
          const p = briel.player;
          const near = briel.zombies.states().some((z) => !z.down && z.act === 'attack' && Math.hypot(z.x - p.x, z.z - p.z) < 1.6);
          return { hp: briel.combat.hp, near };
        })()`);
        if (!hurt && (reach.hp < hp0 || reach.near)) {
          hurt = true;
          after = Date.now() + 2500;
          // Neither shoots back, so the one inside would go down in the end, and with every fighter down the game is
          // over. Once reached, the gun is put away: with no fighter nobody is swiped and the game goes on (the next
          // half's wave brings anyone down back up).
          await pages[inner].evaluate('briel.weapon.setEnabled(false)', false);
          hurtInside[inner]++;
          if (o.out && !pictured) {
            await pages[inner].screenshot(join(o.out, `mp-wave${w + 1}-${inner}-inside.png`));
            pictured = true;
          }
        }
        // A door a zombie shoved (the server's door message with no player's name): open on both pages?
        for (; read < rootLog.length; read++) {
          const m = rootLog[read];
          if (m.t === 'door' && m.by === '' && m.open && m.id.startsWith('keet-')) {
            await sleep(300);
            swung.push([m.id, await alice.evaluate(`briel.doors.isOpen('${m.id}')`), await bob.evaluate(`briel.doors.isOpen('${m.id}')`)]);
          }
        }
      }
      if (!running()) ended ||= `the game ended during wave ${WAVES[w]}, ${inner} inside`;
      const mode = rootLog.filter((m) => m.t === 'mode').at(-1)?.mode;
      // Where the server has the two now, and whether it counts them armed and up.
      const last = new Map();
      for (const m of rootLog) if (m.t === 's') for (const e of m.p ?? []) last.set(e[0], readPlayer(e));
      for (const [n, p] of last) if (n.endsWith(tag)) console.log(`  the server has ${n} at ${p.x.toFixed(1)}, ${p.y.toFixed(2)}, ${p.z.toFixed(1)}${keet.contains(p.x, p.z) ? ' (in the café)' : ''}, armed ${p.armed}, up ${p.alive}`);
      console.log(`wave ${w + 1}, ${inner} inside: ${hurt ? 'reached (a swipe, or one swiping within 1.6 m)' : 'not reached'} in ${((Date.now() - t0) / 1000).toFixed(0)} s (the game: ${mode?.kind} ${mode?.phase ?? ''}, wave ${mode?.zombies?.wave}, ${mode?.zombies?.left} left, ${mode?.zombies?.standing} of ${mode?.zombies?.fighters} fighters standing)`);
      if (o.out) await pages[outer].screenshot(join(o.out, `mp-wave${w + 1}-${outer}-outside.png`));
    }
  }
  ok('all six halves played (the game ran to the end)', halves === 6 && !ended, ended || `${halves} halves`);
  ok('the one inside was reached in every half', hurtInside.alice + hurtInside.bob === 6, `${JSON.stringify(hurtInside)} of 6`);
  ok('a door a zombie shoved swings on both pages', swung.length > 0 && swung.every(([, a, b]) => a && b), `${swung.length} shoves: ${[...new Set(swung.map((s) => s[0]))].join(' ')}`);
  for (const who of ['alice', 'bob']) {
    ok(`${who}'s page: zombies seen in the café`, seen[who].inside > 0, `${seen[who].inside} positions`);
    ok(`${who}'s page: none in a wall or furniture`, seen[who].inSolid === 0, `${seen[who].inSolid}`);
    ok(`${who}'s page: none on a chair or higher`, seen[who].worst < 0.4, `${seen[who].worst.toFixed(2)} m`);
    ok(`${who}: never told the zombies can't reach them`, !(await perch(who)));
    const errors = pages[who].logs.filter((l) => /^(error|exception):/.test(l));
    ok(`${who}'s page: no errors`, !errors.length, errors.slice(0, 3).join(' | '));
  }
  admin({ t: 'mode', kind: 'free' });
  await sleep(500);
} finally {
  alice.close();
  bob.close();
  root.close();
}
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);
