// Check the garden gnomes and the timed routes (web/src/world/goals.ts) in the real game, on a running dev server, in
// one page load: every gnome, gate and checkpoint dropped onto (on the ground, not in a hedge, a wall or a pond) and
// walked from to a road (a search over 0.5 m cells); a picture of every gnome and gate; finding g01 and g10, kept after a
// reload; the walking route walked; a run stopped by a teleport; the two gnomes on a floor climbed to; solo Zombies
// hiding it all. A route's rings show only once its race is asked for (the race key K, the D-pad's right, a tap on the
// line at the top): `race` checks no ring before, the offer on getting in a car or on a bike, the key starting and
// stopping it, getting out, a passenger, the controller and (--phone) the tap, and the Controls tab's row.
// --ride: also the bike route ridden and the car route driven, by a simple autopilot along the roads
// (it keeps behind the traffic, backs off and finds a way round when stuck; --trace prints where it is every 5 s).
// --together <name>: played together as a guest of that name, against the server behind the dev server's proxy
// (API_PORT=<a throwaway server's port> npx vite --port <n>): the walks go at the real pace, the script waits after its
// jumps for the server to catch up, and each route checks that the server timed it too (server/goals.mjs: its `race`
// message, within a few tenths of the page's own time). Use --only foot,bike,car --ride.
// --target <m/s>: the bike's or the car's autopilot aims at this speed instead of its calm 5.5 or 10 (a fast lap).
//
//   node tools/dev/goals.mjs --url http://localhost:5200/ --port 9920 [--quality high] [--phone] [--shots <folder>]
//                            [--only spots,reach,shots,find,foot,line,race,climb,warm,zombies,bike,car] [--ride] [--trace]
//                            [--size 667x375]
//
// Prints one line per check and a summary; exits 1 when any check failed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeChurch } from '../../web/shared/church.mjs';
import { lengthOf, makeRoads } from '../../web/shared/roadPath.mjs';
import { makeTerrain } from '../../web/shared/terrain.mjs';
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5200/', port: '9920', quality: 'high', phone: false, shots: '', only: '', ride: false, trace: false, size: '', together: '', target: '' });
/** Together: a while for the server's place of you to catch up with a jump of the page's (it moves you at the pace of your way). */
const settle = (ms) => (o.together ? b.sleep(ms) : Promise.resolve());
/** Together: the server's `race` messages for route `id` (recorded in the page), the newest last. */
const serverRaces = async (id) => (o.together ? JSON.parse(await b.evaluate('JSON.stringify(window.__boardMsgs ?? [])', false)).filter((m) => m.t === 'race' && m.id === id) : []);
const ROUTES = JSON.parse(readFileSync(new URL('../../web/shared/routes.json', import.meta.url))).routes;
const ROADS = JSON.parse(readFileSync(new URL('../../web/src/data/roads.json', import.meta.url)));
/** The road register's network, as the game's sat-nav line uses it (web/shared/roadPath.mjs) */
const NET = makeRoads(JSON.parse(readFileSync(new URL('../../web/src/data/streets.json', import.meta.url))).graph);
const all = ['spots', 'reach', 'shots', 'find', 'foot', 'line', 'race', 'gps', 'climb', 'warm', 'zombies', ...(o.ride ? ['bike', 'car'] : [])];
const only = new Set(o.only ? o.only.split(',') : all);
if (o.shots) mkdirSync(o.shots, { recursive: true });

const b = await launch({ port: Number(o.port), width: 1280, height: 720 });
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const shot = async (name) => o.shots && b.screenshot(join(o.shots, `${name}.png`));
/** A picture of the minimap alone, at twice its size. */
async function mapShot(name) {
  if (!o.shots) return;
  const r = JSON.parse(await b.evaluate("JSON.stringify((() => { const r = document.getElementById('minimap').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })())", false));
  const png = await b.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 2 } });
  writeFileSync(join(o.shots, `${name}.png`), Buffer.from(png.data, 'base64'));
}
/** The race's line drawn on the minimap: how many of its pixels are the line's magenta. */
const magenta = () => b.evaluate("(() => { const c = document.getElementById('minimap'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 230) < 25 && d[i + 1] < 70 && Math.abs(d[i + 2] - 140) < 35) n++; return n; })()", false);
/** The race's way for the maps (world/goals.ts nav), where you are, and how many ways were worked out. */
const navNow = () => b.evaluate("JSON.stringify({ nav: briel.goals.nav(), p: [briel.player.x, briel.player.z], ways: briel.goals.ways })", false).then(JSON.parse);
/** Points along `line` every `step` m. */
function sample(line, step = 2) {
  const out = [];
  for (let i = 1; i < line.length; i++) {
    const [ax, az] = line[i - 1], [bx, bz] = line[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  return out;
}
const js = (v) => JSON.stringify(v);
/** Together: the server timed route `id` as the page did (its race message; the page's best time from its storage). */
async function serverTimed(id, stored) {
  await b.sleep(1500);
  const got = (await serverRaces(id)).at(-1);
  const page = Object.entries(JSON.parse(stored || '{}').best ?? {}).find(([k]) => k.startsWith(`${id}@`))?.[1];
  const timed = !!got && typeof page === 'number' && Math.abs(got.ms - page) < 500;
  check(`${id}: the server timed it too`, timed, `server ${js(got ?? null)}, page ${page} ms`);
  // The states this page sent (time, x, y, z, flying), to replay against the server's rules.
  if (o.shots) writeFileSync(join(o.shots, `${id}_states_${timed ? 'timed' : 'not'}_${Date.now()}.json`), await b.evaluate('JSON.stringify(window.__sent ?? [])', false));
}
const toast = () => b.evaluate("document.getElementById('toast')?.textContent ?? ''", false);
const line = () => b.evaluate("(() => { const l = document.getElementById('goal-line'); return l && !l.hidden ? l.textContent : ''; })()", false);
const prompt = () => b.evaluate("document.getElementById('prompt')?.textContent ?? ''", false);
/** What of the routes is drawn: each gate, the next ring, the one after it; and the race asked for. */
const rings = () => b.evaluate("JSON.stringify((() => { const r = briel.goals.routes; return { gates: r.gates.map((o) => o.visible), next: r.next.visible, after: r.after.visible, armed: briel.goals.race.armed, offer: briel.goals.race.offer }; })())", false).then(JSON.parse);
const noRing = (r) => !r.gates.some(Boolean) && !r.next && !r.after;
/** A real key press (Input.dispatchKeyEvent: the dev hooks do not reach every listener), then two frames. */
async function tapKey(code) {
  for (const type of ['keyDown', 'keyUp']) await b.send('Input.dispatchKeyEvent', { type, code, key: code.slice(3).toLowerCase(), windowsVirtualKeyCode: code.charCodeAt(3) });
  await b.evaluate('__g.frame()');
}
const raceKey = () => tapKey('KeyK');
/** The offer in the prompt as you play: the key first, or with touch controls the tap on the line at the top. */
const wanted = (lang, route) => o.phone
  ? (lang === 'nl' ? `Tik op de balk bovenaan om de race te starten: ${route}` : `Tap the line at the top to start the timed route: ${route}`)
  : (lang === 'nl' ? `K: de race starten · ${route}` : `K  Start the timed route: ${route}`);

/** The helpers in the page (window.__g), again after a reload. */
async function helpers() {
  await b.evaluate(`(() => {
    const W = briel.world;
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const free = (x, z, g, r = 0.3) => W.touching(x, z, g + 0.5, g + 1.7, r) === null;
    window.__g = {
      frame,
      /** Dropped onto (x, z): from 40 m up, or onto a floor from just above it. */
      async drop(x, z, y, floor) {
        briel.player.flying = false;
        if (floor) { briel.teleport(x, z, y + 0.1); briel.walk(0.5, 0, 0); }
        else { briel.teleport(x, z, 40); briel.walk(4, 0, 0); }
        await frame();
        const p = briel.player;
        return { d: Math.hypot(p.x - x, p.z - z), feet: p.feet, mat: p.ground.mat ?? null, name: p.ground.name ?? null, wet: !!p.wetHere };
      },
      /** From the spot (x, z) at height g over 0.5 m cells to a road or a place, within 250 m of walking. */
      reach(x, z, g) {
        const S = 0.5, MAXSTEP = 500, CAP = 400000;
        const seen = new Map();
        const q = [];
        const key = (i, j) => (i + 4000) * 8192 + (j + 4000);
        for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
          if (Math.hypot(i * S, j * S) > 1.25) continue;
          const cx = x + i * S, cz = z + j * S;
          const gg = W.groundAt(cx, cz, g + 0.5, 0.5).y;
          if (Math.abs(gg - g) < 0.5 && free(cx, cz, gg)) { seen.set(key(i, j), 0); q.push([i, j, gg, 0]); }
        }
        if (!q.length) return { ok: false, why: 'no free cell next to it' };
        const places = briel.places;
        for (let h = 0; h < q.length && seen.size < CAP; h++) {
          const [i, j, g0, s] = q[h];
          const cx = x + i * S, cz = z + j * S;
          const m = W.groundAt(cx, cz, g0 + 0.5, 0.5).mat;
          if (m === 'road' || places.some((p) => Math.hypot(p.x - cx, p.z - cz) < 3)) return { ok: true, metres: +(s * S).toFixed(1), at: [+cx.toFixed(1), +cz.toFixed(1)], mat: m ?? null, cells: seen.size };
          if (s >= MAXSTEP) continue;
          for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
            const k = key(i + di, j + dj);
            if (seen.has(k)) continue;
            const nx = x + (i + di) * S, nz = z + (j + dj) * S;
            const gg = W.groundAt(nx, nz, g0 + 0.5, 0.5).y;
            if (Math.abs(gg - g0) > 0.5 || !free(nx, nz, gg)) { seen.set(k, -1); continue; }
            seen.set(k, s + 1);
            q.push([i + di, j + dj, gg, s + 1]);
          }
        }
        return { ok: false, why: seen.size >= CAP ? 'too many cells' : 'no road within 250 m', cells: seen.size };
      },
      /** A free spot d m from (x, z) at height g, facing it: [x, z, feet, yaw], or null. */
      viewpoint(x, z, g, d) {
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2 + 0.3;
          const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
          const gg = W.groundAt(px, pz, g + 1, 0.6).y;
          if (Math.abs(gg - g) > 1 || !free(px, pz, gg)) continue;
          if (W.clearance({ x: px, y: gg + 1.6, z: pz }, { x, y: g + 0.3, z }) < 0.97) continue;
          return [px, pz, gg, Math.atan2(-(x - px), -(z - pz))];
        }
        return null;
      },
      /** A way on foot from where you stand to within r of (tx, tz) over 0.5 m cells, as points, or null. */
      way(tx, tz, r, start = null, rad = 0.3) {
        const S = 0.5, p = briel.player;
        const x0 = start ? start[0] : p.x, z0 = start ? start[1] : p.z;
        const key = (i, j) => (i + 4000) * 8192 + (j + 4000);
        const g00 = start ? W.groundAt(x0, z0, W.groundAt(x0, z0, 60, 0).y + 0.6, 0.6).y : p.feet;
        const from = new Map([[key(0, 0), null]]);
        const q = [[0, 0, g00]];
        // Wider than a walker (a bike): start from the free cells round the start, the start itself may be too near a wall.
        if (rad > 0.3) for (let i = -5; i <= 5; i++) for (let j = -5; j <= 5; j++) {
          const cx = x0 + i * S, cz = z0 + j * S;
          if ((i || j) && Math.hypot(i, j) * S <= 2.5 && free(cx, cz, g00, rad)) { from.set(key(i, j), null); q.push([i, j, g00]); }
        }
        for (let h = 0; h < q.length && from.size < 400000; h++) {
          const [i, j, g0] = q[h];
          if (Math.hypot(x0 + i * S - tx, z0 + j * S - tz) < r) {
            const out = [];
            for (let k = key(i, j), c = [i, j]; c; k = c && key(c[0], c[1])) {
              out.push([x0 + c[0] * S, z0 + c[1] * S]);
              c = from.get(k);
            }
            return out.reverse().filter((_, n, a) => rad > 0.3 || n % 3 === 0 || n === a.length - 1);
          }
          for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
            const k = key(i + di, j + dj);
            if (from.has(k)) continue;
            const nx = x0 + (i + di) * S, nz = z0 + (j + dj) * S;
            const gg = W.groundAt(nx, nz, g0 + 0.5, 0.5).y;
            from.set(k, Math.abs(gg - g0) > (rad > 0.3 ? 0.15 : 0.5) || !free(nx, nz, gg, rad) ? false : [i, j]);
            if (from.get(k)) q.push([i + di, j + dj, gg]);
          }
        }
        return null;
      },
      /** Walk to (tx, tz): straight, and round what is in the way when stuck. */
      async walkTo(tx, tz, r, maxSteps = 200) {
        const w = await this.straight(tx, tz, r, maxSteps);
        if (w.ok || !w.stuck) return w;
        const way = this.way(tx, tz, r);
        if (!way) return { ...w, why: 'no way round' };
        for (const [x, z] of way.slice(1, -1)) {
          const s = await this.straight(x, z, 0.4, 40);
          if (!s.ok) return { ...s, round: true };
        }
        return { ...(await this.straight(tx, tz, r, maxSteps)), round: true };
      },
      /** Walk towards (tx, tz) in steps of 0.25 s with a frame between, until within r. */
      async straight(tx, tz, r, maxSteps = 200) {
        let stuck = 0;
        for (let n = 0; n < maxSteps * (window.__together ? 5 : 1); n++) {
          const p = briel.player;
          const d = Math.hypot(tx - p.x, tz - p.z);
          if (d < r) return { ok: true, n };
          const yaw = Math.atan2(-(tx - p.x), -(tz - p.z));
          briel.teleport(p.x, p.z, p.feet, yaw, 0);
          const before = [p.x, p.z];
          // Together: at the real pace, a twentieth of a second at a time (the page then sends a state each step).
          const dt = window.__together ? Math.min(0.05, d / 4) : Math.min(0.25, d / 4);
          briel.walk(dt, 0, 1);
          if (window.__together) await new Promise((r) => setTimeout(r, dt * 1000));
          else await frame();
          if (Math.hypot(p.x - before[0], p.z - before[1]) < (window.__together ? 0.01 : 0.05)) { if (++stuck > (window.__together ? 30 : 6)) return { ok: false, n, stuck: [+p.x.toFixed(1), +p.z.toFixed(1)] }; } else stuck = 0;
        }
        return { ok: false, n: maxSteps };
      },
    };
  })()`, false);
}

async function start() {
  await b.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('briel.graphics','${o.quality}');localStorage.setItem('briel.lang','en');localStorage.setItem('briel.spawn','house');localStorage.setItem('briel.playMode','explore');localStorage.setItem('briel.feedback','later');`,
  });
  if (o.together) {
    // The server's race and gnome messages to this page, kept for the checks (server/goals.mjs).
    await b.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "window.__together = true; window.__boardMsgs = []; { const W = window.WebSocket; window.WebSocket = class extends W { constructor(...a) { super(...a); this.addEventListener('message', (e) => { try { const m = JSON.parse(e.data); if (m.t === 'race' || m.t === 'gnome') window.__boardMsgs.push(m); } catch {} }); } send(d) { try { const m = JSON.parse(d); if (m.t === 'state') { window.__sent.push([Math.round(performance.now()), m.x, m.y, m.z, m.flying ? 1 : 0]); if (window.__sent.length > 20000) window.__sent.splice(0, 5000); } } catch {} return super.send(d); } }; window.__sent = []; }",
    });
    await b.send('Page.navigate', { url: o.url });
    await b.waitFor("!!document.querySelector('#choose-kbm')");
    await b.sleep(6000); // the dev build attaches the start screen's handlers late
    await b.evaluate(`(() => {
      const n = document.querySelector('#nick'); n.value = ${js(o.together)}; n.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-mp=multi]').click();
      const age = document.querySelector('#mp-age'); if (!age.checked) age.click();
      document.querySelector('#choose-kbm').click();
    })()`, false);
    await b.waitFor('!!window.briel', 180000);
    await b.waitFor("(() => { const p = document.getElementById('start-panel'); if (!p || p.offsetParent === null) return true; const s = getComputedStyle(p); return s.visibility === 'hidden' || Number(s.opacity) < 0.05; })()", 240000);
    await b.waitFor("briel.village() === 'ready'", 240000);
  } else await startGame(b, o.url, { phone: o.phone, village: true });
  if (o.size) {
    // Another phone's screen (--size 667x375), after the start (startGame sets 844x390 for --phone).
    const [width, height] = o.size.split('x').map(Number);
    await b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: o.phone });
    await b.sleep(1000);
  }
  await b.evaluate(`briel.three.applyQuality(${js(o.quality)}); briel.three.holdQuality(true); briel.three.weather.setSolo('sunny'); briel.weatherAhead(3600); document.getElementById('cc-close')?.click()`, false);
  // Pictures without the hint to click (headless has no pointer lock).
  await b.evaluate("document.head.append(Object.assign(document.createElement('style'), { textContent: '#capture-hint { display: none !important; }' }))", false);
  await helpers();
}

/** The player at a spot d m from (x, z, g), looking at it from above. */
async function lookAt(x, z, g, d, pitch = -0.5) {
  const v = await b.evaluate(`JSON.stringify(__g.viewpoint(${x}, ${z}, ${g}, ${d}))`, false).then(JSON.parse);
  const [px, pz, pg, yaw] = v ?? [x + d, z, g, Math.atan2(-(x - (x + d)), 0)];
  await b.evaluate(`briel.player.flying = false; briel.teleport(${px}, ${pz}, ${pg}, ${yaw}, ${pitch})`, false);
  return !!v;
}

try {
  await start();
  const spots = JSON.parse(await b.evaluate('JSON.stringify(briel.goals.spots())', false));
  check('30 gnomes, all shown with the village in', spots.length === 30 && spots.every((s) => s.shown), `${spots.filter((s) => s.shown).length} shown`);
  const points = ROUTES.flatMap((r) => [r.gate, ...r.checkpoints].map(([x, z], i) => ({ id: `${r.id}${i ? `#${i}` : ' gate'}`, x, z, floor: false })));
  for (const p of points) p.y = await b.evaluate(`briel.world.groundAt(${p.x}, ${p.z}, briel.world.groundAt(${p.x}, ${p.z}, 60, 0).y + 0.6, 0).y`, false);

  if (only.has('spots')) {
    for (const s of [...spots, ...points]) {
      const r = await b.evaluate(`__g.drop(${s.x}, ${s.z}, ${s.y}, ${s.floor})`);
      const ok = r.d < 0.5 && Math.abs(r.feet - s.y) < 0.3 && !r.wet && r.mat !== 'water' && r.mat !== 'swim';
      check(`drop ${s.id}`, ok, `${r.d.toFixed(2)} m off, feet ${r.feet.toFixed(2)} vs ${s.y.toFixed(2)}, on ${r.name ?? '-'}/${r.mat ?? '-'}${r.wet ? ', wet' : ''}`);
    }
  }
  if (only.has('reach')) {
    for (const s of [...spots, ...points]) {
      if (s.floor) {
        console.log(`--   reach ${s.id}: on a floor, climbed by hand`);
        continue;
      }
      const r = await b.evaluate(`__g.reach(${s.x}, ${s.z}, ${s.y})`);
      check(`reach ${s.id}`, r.ok, r.ok ? `${r.metres} m to ${r.mat ?? 'a place'} at ${r.at}` : `${r.why} (${r.cells ?? 0} cells)`);
    }
  }
  await b.evaluate('briel.goals.reset()', false);

  if (only.has('shots') && o.shots) {
    for (const s of spots) {
      const seen = await lookAt(s.x, s.z, s.y, 2.1, -0.5);
      await b.sleep(2200);
      await shot(`gnome_${s.id}`);
      console.log(`shot gnome_${s.id}${seen ? '' : ' (no clear viewpoint: from the east)'}`);
    }
    // The gates show only with a race asked for: here the warm-up's way of drawing them all (it stops nothing).
    await b.evaluate('briel.goals.warming(true)', false);
    for (const r of ROUTES) {
      const [gx, gz] = r.gate, [fx, fz] = r.checkpoints[0];
      const len = Math.hypot(fx - gx, fz - gz), d = r.radius * 2.2 + 4;
      const px = gx - ((fx - gx) / len) * d, pz = gz - ((fz - gz) / len) * d;
      const pg = await b.evaluate(`briel.world.groundAt(${px}, ${pz}, briel.world.groundAt(${px}, ${pz}, 60, 0).y + 0.6, 0).y`, false);
      await b.evaluate(`briel.teleport(${px}, ${pz}, ${pg}, ${Math.atan2(-(gx - px), -(gz - pz))}, 0.05)`, false);
      await b.sleep(2500);
      await shot(`gate_${r.id}`);
      console.log(`shot gate_${r.id}`);
    }
    await b.evaluate('briel.goals.warming(false)', false);
    await b.evaluate('briel.goals.reset()', false);
  }

  if (only.has('find')) {
    for (const [id, travel] of [['g01', ''], ['g10', 'church']]) {
      if (travel) {
        await b.evaluate(`briel.travel(${js(travel)})`, false);
        await b.sleep(4000);
      }
      const s = spots.find((g) => g.id === id);
      await lookAt(s.x, s.z, s.y, 3, -0.4);
      await b.sleep(2000);
      await shot(`find_${id}_before`);
      let found = false;
      for (let n = 0; n < 40 && !found; n++) {
        await b.evaluate(`(async () => { const p = briel.player; briel.teleport(p.x, p.z, p.feet, Math.atan2(-(${s.x} - p.x), -(${s.z} - p.z)), -0.4); briel.walk(0.1, 0, 0.6); await __g.frame(); })()`);
        found = await b.evaluate(`briel.goals.found().includes(${js(id)})`, false);
        const d = await b.evaluate(`Math.hypot(briel.player.x - ${s.x}, briel.player.z - ${s.z})`, false);
        if (d < 1) break;
      }
      const text = await toast();
      const stored = await b.evaluate("localStorage.getItem('briel.gnomes') ?? ''", false);
      check(`find ${id}`, found && stored.includes(id), `toast "${text}", stored ${stored}`);
      await b.sleep(400);
      await shot(`find_${id}_after`);
    }
    check('toast for the second gnome', (await toast()).includes('Gnome 2 of 30'), await toast());
    // After a reload: still found, and drawn pale.
    await start();
    const kept = await b.evaluate('JSON.stringify(briel.goals.found())', false);
    const pale = await b.evaluate('briel.goals.gnomes.mesh.instanceColor.getX(0)', false);
    const legend = await b.evaluate("document.querySelector('#bigmap .lg-gnome')?.parentElement?.textContent ?? ''", false);
    check('kept after a reload', kept.includes('g01') && kept.includes('g10'), kept);
    check('g01 drawn pale', pale < 0.5, `instance colour ${pale}`);
    check('the big map counts them', legend.includes('2 of 30'), legend);
    const s = spots[0];
    await lookAt(s.x, s.z, s.y, 3, -0.4);
    await b.sleep(2000);
    await shot('find_g01_reloaded');
    // A found gnome next to one not found: g02 drawn for a moment 0.8 m beside g01.
    const [ax, az] = [s.x + 0.55, s.z + 0.55];
    await b.evaluate(`(() => { const m = briel.goals.gnomes.mesh, M = new briel.three.scene.matrix.constructor(); m.getMatrixAt(1, M); M.setPosition(${ax}, ${s.y}, ${az}); m.setMatrixAt(1, M); m.instanceMatrix.needsUpdate = true; })()`, false);
    await lookAt(s.x + 0.3, s.z + 0.3, s.y, 2.2, -0.45);
    await b.sleep(1500);
    await shot('pale_compare');
    await b.evaluate('briel.goals.gnomes.setFound(briel.goals.found())', false);
  }

  if (only.has('foot')) {
    await b.evaluate('briel.goals.reset()', false);
    await b.evaluate("briel.travel('church')", false);
    await b.sleep(4000);
    const r = ROUTES.find((x) => x.id === 'foot');
    const [gx, gz] = r.gate, [fx, fz] = r.checkpoints[0];
    const len = Math.hypot(fx - gx, fz - gz);
    const sx = gx - ((fx - gx) / len) * 6, sz = gz - ((fz - gz) / len) * 6;
    const sg = await b.evaluate(`briel.world.groundAt(${sx}, ${sz}, briel.world.groundAt(${sx}, ${sz}, 60, 0).y + 0.6, 0).y`, false);
    // From 6 m before the gate, 4 m up and back, so the square shows in the picture.
    await b.evaluate(`briel.teleport(${sx}, ${sz}, ${sg}, ${Math.atan2(-(gx - sx), -(gz - sz))}, 0)`, false);
    await b.sleep(1500);
    await settle(6000); // together: the server catches up with the jump (the offer's 8 s run out meanwhile: not checked then)
    await shot('foot_gate_line');
    const near = await line();
    const offered = await prompt();
    const before = await rings();
    check('no ring on the church square before the race', noRing(before), js(before));
    if (!o.together) check('the walking race offered by its start', near.includes('Church square on foot') && offered.includes(wanted('en', 'Church square on foot')) && before.offer === 'foot', `line "${near}", prompt "${offered}"`);
    await raceKey();
    await b.sleep(800);
    const after = await rings();
    const toGate = await line();
    await shot('foot_gate_armed');
    check('the key: the gate and the first checkpoint show, the line points to the gate', after.armed === 'foot' && after.gates[ROUTES.indexOf(r)] && after.after && !after.next && /Go through the gate|To the start/.test(toGate) && !(await prompt()).includes('Start the timed route'), `${js(after)} line "${toGate}"`);
    const lines = [];
    let ok = true;
    const pts = [r.gate, ...r.checkpoints, r.gate];
    for (let i = 0; i < pts.length; i++) {
      const [tx, tz] = pts[i];
      const w = await b.evaluate(`__g.walkTo(${tx}, ${tz}, ${i === 0 || i === pts.length - 1 ? 0.8 : 1.5})`);
      if (!w.ok) {
        ok = false;
        check(`walk to point ${i}`, false, js(w));
        break;
      }
      await b.evaluate('__g.frame()');
      lines.push(await line());
      if (i === 2) await shot('foot_run');
    }
    const finish = await toast();
    const best = await b.evaluate("localStorage.getItem('briel.routes') ?? ''", false);
    console.log('     lines:', lines.join(' | '));
    check('foot route walked', ok && /\d:\d\d\.\d/.test(finish) && best.includes('foot@1'), `toast "${finish}", stored ${best}`);
    check('checkpoints counted', lines.some((l) => l.includes('Checkpoint 6 of 6')) && lines.some((l) => l.includes('To the finish')), '');
    await shot('foot_finish');
    // After the result has shown a few seconds the rings go.
    const fin = await rings();
    await b.sleep(4600);
    const gone = await rings();
    check('after a finish the gate stays a while, then goes', fin.armed === 'foot' && fin.gates.some(Boolean) && noRing(gone) && gone.armed === null, `${js(fin)} then ${js(gone)}`);
    if (o.together) await serverTimed('foot', best);
    // A run stopped by a teleport 100 m away (the race asked for again first).
    await b.evaluate(`briel.teleport(${sx}, ${sz}, ${sg}, ${Math.atan2(-(gx - sx), -(gz - sz))}, 0)`, false);
    await b.evaluate('__g.frame()');
    await raceKey();
    await b.evaluate(`__g.walkTo(${fx}, ${fz}, 2)`);
    const running = await b.evaluate('!!briel.goals.run()', false);
    await b.evaluate(`briel.teleport(${gx + 100}, ${gz}, briel.world.groundAt(${gx + 100}, ${gz}, 60, 0).y)`, false);
    await b.evaluate('__g.frame()');
    await b.sleep(200);
    const stopped = await toast();
    const off = await rings();
    check('a teleport stops the run', running && stopped.includes('Route stopped') && !(await b.evaluate('!!briel.goals.run()', false)) && noRing(off) && off.armed === null, `running before ${running}, toast "${stopped}", ${js(off)}`);
    // A hop across the gate (a teleport 6 m before it to 6 m past it) starts no clock.
    await b.evaluate(`briel.teleport(${sx}, ${sz}, ${sg}, 0, 0)`, false);
    await b.evaluate('__g.frame()');
    await raceKey();
    const px = gx + ((fx - gx) / len) * 6, pz = gz + ((fz - gz) / len) * 6;
    await b.evaluate(`briel.teleport(${px}, ${pz}, briel.world.groundAt(${px}, ${pz}, 60, 0).y, 0, 0)`, false);
    await b.evaluate('__g.frame()');
    check('a hop across the gate starts nothing', !(await b.evaluate('!!briel.goals.run()', false)));
  }

  if (only.has('line')) {
    // The line at the top by the walking gate and during a run, in English and Dutch, with a best time: clear of the
    // wordmark (and its Beta tag) and of the minimap.
    const r = ROUTES.find((x) => x.id === 'foot');
    const [gx, gz] = r.gate, [fx, fz] = r.checkpoints[0];
    const len = Math.hypot(fx - gx, fz - gz);
    const sx = gx - ((fx - gx) / len) * 6, sz = gz - ((fz - gz) / len) * 6;
    await b.evaluate("briel.travel('church')", false);
    await b.sleep(3000);
    const clear = () => b.evaluate(`(() => { const r = (id) => document.getElementById(id)?.getBoundingClientRect(); const l = r('goal-line'), m = r('minimap'), w = document.querySelector('#brand')?.getBoundingClientRect(); const hit = (a, c) => a && c && c.width && a.left < c.right && c.left < a.right && a.top < c.bottom && c.top < a.bottom; return JSON.stringify({ map: hit(l, m), brand: hit(l, w), right: Math.round(l.right), mapLeft: Math.round(m.left), lines: Math.round(l.height) }); })()`, false).then(JSON.parse);
    for (const lang of ['en', 'nl']) {
      await b.evaluate(`briel.i18n.setLang(${js(lang)}); briel.goals.routes.best['foot@1'] = 75432`, false);
      const sg = await b.evaluate(`briel.world.groundAt(${sx}, ${sz}, briel.world.groundAt(${sx}, ${sz}, 60, 0).y + 0.6, 0).y`, false);
      await b.evaluate(`briel.teleport(${sx}, ${sz}, ${sg}, ${Math.atan2(-(gx - sx), -(gz - sz))}, 0)`, false);
      await b.sleep(1200);
      const g = await clear();
      await shot(`line_gate_${lang}`);
      check(`line by the gate clear (${lang})`, !g.map && !g.brand, `${await line()} ${js(g)}`);
      await raceKey();
      await b.sleep(300);
      const armed = await clear();
      await shot(`line_armed_${lang}`);
      check(`line to the gate clear (${lang})`, !armed.map && !armed.brand, `${await line()} ${js(armed)}`);
      await b.evaluate(`__g.walkTo(${gx}, ${gz}, 0.8)`);
      await b.evaluate(`__g.walkTo(${(gx + fx) / 2}, ${(gz + fz) / 2}, 1)`);
      await b.sleep(400);
      const run = await clear();
      await shot(`line_run_${lang}`);
      check(`line during a run clear (${lang})`, !run.map && !run.brand && !!(await b.evaluate('!!briel.goals.run()', false)), `${await line()} ${js(run)}`);
      await b.evaluate(`briel.teleport(${gx + 100}, ${gz}, briel.world.groundAt(${gx + 100}, ${gz}, 60, 0).y)`, false);
      await b.evaluate('__g.frame()');
    }
    await b.evaluate("briel.i18n.setLang('en')", false);
  }

  if (only.has('race')) {
    // A race starts only when asked for, and its rings show only then (Yoshi, 15 Nov 2026).
    await b.evaluate('briel.goals.reset()', false);
    const clear = () => b.evaluate(`(() => { const r = (id) => document.getElementById(id)?.getBoundingClientRect(); const l = r('goal-line'), m = r('minimap'); const hit = (a, c) => a && c && c.width && a.left < c.right && c.left < a.right && a.top < c.bottom && c.top < a.bottom; return JSON.stringify({ map: hit(l, m), right: Math.round(l.right), mapLeft: Math.round(m.left), lines: Math.round(l.height) }); })()`, false).then(JSON.parse);
    const seenAt = [];
    for (const r of ROUTES) {
      const [gx, gz] = r.gate, [fx, fz] = r.checkpoints[0];
      const len = Math.hypot(fx - gx, fz - gz);
      const px = gx - ((fx - gx) / len) * 12, pz = gz - ((fz - gz) / len) * 12;
      await b.evaluate(`briel.player.flying = false; briel.teleport(${px}, ${pz}, briel.world.groundAt(${px}, ${pz}, 60, 0).y, ${Math.atan2(-(gx - px), -(gz - pz))}, 0)`, false);
      await b.sleep(800);
      const seen = await rings();
      if (!noRing(seen)) seenAt.push(`${r.id}: ${js(seen)}`);
    }
    check('no ring at any gate before a race', !seenAt.length, seenAt.join('; '));
    const inCar = async () => {
      await b.evaluate("briel.travel('house')", false);
      await b.sleep(2500);
      await b.evaluate('briel.getIn()', false);
      await b.waitFor('briel.driving()', 15000);
    };
    const out = async () => {
      await b.evaluate('briel.getOut()', false);
      await b.sleep(400);
    };
    // The offer in a car, after its keys (5 s): in English and Dutch.
    for (const [lang, want] of [['en', wanted('en', 'Round Briel by car')], ['nl', wanted('nl', 'Toertje Briel met de auto')]]) {
      await b.evaluate(`briel.i18n.setLang(${js(lang)})`, false);
      await inCar();
      await b.sleep(800);
      const first = await prompt();
      await b.sleep(5600);
      const offer = await prompt();
      await shot(`offer_car_${lang}`);
      check(`the offer in a car (${lang})`, offer.includes(want) && !first.includes(want) && (await rings()).offer === 'car', `first "${first}", then "${offer}", line "${await line()}"`);
      await out();
    }
    await b.evaluate("briel.i18n.setLang('en')", false);
    await inCar();
    await raceKey();
    await b.sleep(500);
    const armed = await rings();
    const toGate = await line();
    const arrow = await b.evaluate("!document.querySelector('#goal-line i').hidden", false);
    await shot('race_car_armed');
    check('the key arms the car race: its gate and first ring, the line to the gate', armed.armed === 'car' && armed.gates[ROUTES.findIndex((x) => x.id === 'car')] && armed.after && !armed.next && toGate.includes('Round Briel by car') && toGate.includes('To the start') && arrow, `${js(armed)} line "${toGate}" arrow ${arrow}`);
    await raceKey();
    const stopped = await rings();
    check('the key again stops it: the rings go, the line says so', stopped.armed === null && noRing(stopped) && (await line()).includes('Route stopped'), `${js(stopped)} line "${await line()}"`);
    await raceKey();
    const again = (await rings()).armed;
    await out();
    const left = await rings();
    check('getting out stops it', again === 'car' && left.armed === null && noRing(left), `${again} then ${js(left)}`);
    // A passenger: main.ts gives goals.update no way of moving (by null) then; faked here in a car of your own.
    await b.evaluate("(() => { if (window.__asP) return; window.__asP = { on: false }; const u = briel.goals.update; briel.goals.update = function (dt, c, me) { return u.call(this, dt, c, window.__asP.on ? { ...me, by: null } : me); }; })()", false);
    await b.evaluate('window.__asP.on = true', false);
    await inCar();
    await b.sleep(6500);
    const pOffer = await prompt();
    await raceKey();
    const p = await rings();
    check('no offer to a passenger, and the key does nothing', !pOffer.includes('Start the timed route') && p.offer === null && p.armed === null && noRing(p), `prompt "${pOffer}", ${js(p)}`);
    await b.evaluate('window.__asP.on = false', false);
    await out();
    // The controller: the D-pad's right, on a fake pad.
    await b.evaluate(`(() => { const btn = () => ({ pressed: false, touched: false, value: 0 }); const pad = { id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0, connected: true, mapping: 'standard', timestamp: 1, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, btn), vibrationActuator: null }; window.__pad = pad; navigator.getGamepads = () => [pad, null, null, null]; })()`, false);
    const padPress = async (i) => {
      await b.evaluate(`(() => { const k = window.__pad.buttons[${i}]; k.pressed = true; k.value = 1; window.__pad.timestamp++; })()`, false);
      await b.sleep(140);
      await b.evaluate(`(() => { const k = window.__pad.buttons[${i}]; k.pressed = false; k.value = 0; window.__pad.timestamp++; })()`, false);
      await b.sleep(160);
    };
    await inCar();
    await padPress(15);
    const padOn = (await rings()).armed;
    await b.sleep(6500);
    await padPress(15);
    const padOff = (await rings()).armed;
    check('the D-pad right starts and stops it', padOn === 'car' && padOff === null, `${padOn} then ${padOff}`);
    await out();
    await b.evaluate('navigator.getGamepads = () => [null, null, null, null]', false);
    // On a bike: the offer in both languages, the key, the key again.
    for (const [lang, want] of [['en', wanted('en', 'Village loop by bike')], ['nl', wanted('nl', 'Dorpsronde met de fiets')]]) {
      await b.evaluate(`briel.i18n.setLang(${js(lang)})`, false);
      await b.evaluate("briel.travel('church')", false);
      await b.sleep(2500);
      await b.evaluate("briel.teleport(533, -769, briel.world.groundAt(533, -769, 60, 0).y, Math.PI / 2, 0); briel.getOnBike('church1')", false);
      await b.sleep(6400);
      const offer = await prompt();
      await shot(`offer_bike_${lang}`);
      check(`the offer on a bike (${lang})`, offer.includes(want), `prompt "${offer}", line "${await line()}"`);
      if (lang === 'en') {
        await raceKey();
        const on = await rings();
        await raceKey();
        const off = await rings();
        check('on a bike the key starts and stops it', on.armed === 'bike' && on.gates[ROUTES.findIndex((x) => x.id === 'bike')] && off.armed === null && noRing(off), `${js(on)} then ${js(off)}`);
      }
      await b.evaluate('briel.getOffBike()', false);
      await b.sleep(400);
    }
    await b.evaluate("briel.i18n.setLang('en')", false);
    // The Controls tab: a row in English and Dutch, the key as you play.
    const rows = JSON.parse(await b.evaluate(`(async () => { const s = await import('/src/shortcuts.ts'); const out = {}; for (const l of ['en', 'nl']) { briel.i18n.setLang(l); for (const c of ['kbm', 'pad', 'touch']) out[l + ' ' + c] = s.controlGroups(c, false).flatMap((g) => g.rows).find(([a]) => a.includes(l === 'en' ? 'timed route' : 'race tegen de klok')) ?? null; } briel.i18n.setLang('en'); return JSON.stringify(out); })()`));
    const want = { 'en kbm': 'K', 'en pad': 'D-pad right', 'en touch': 'Tap the line at the top', 'nl kbm': 'K', 'nl pad': 'D-pad rechts', 'nl touch': 'Tik op de balk bovenaan' };
    check('the Controls tab has the row', Object.entries(want).every(([k, v]) => rows[k]?.[1] === v), js(rows));
    if (o.phone) {
      // Touch controls: a tap on the line at the top, while it offers the race; it stays clear of the minimap.
      await inCar();
      await b.sleep(300);
      const tapLine = async () => {
        const at = JSON.parse(await b.evaluate("JSON.stringify((() => { const r = document.getElementById('goal-line').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })())", false));
        await b.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at[0], y: at[1] }] });
        await b.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await b.evaluate('__g.frame()');
      };
      const offerLine = await line();
      const g0 = await clear();
      await shot('race_touch_offer');
      await tapLine();
      const on = await rings();
      const g1 = await clear();
      await shot('race_touch_armed');
      await tapLine();
      const off = await rings();
      check('touch: a tap on the line starts and stops it, clear of the minimap', offerLine.includes('Tap here to start') && on.armed === 'car' && off.armed === null && !g0.map && !g1.map, `line "${offerLine}" ${js(g0)} ${js(on)} ${js(g1)} ${js(off)}`);
      await out();
    }
  }

  if (only.has('gps')) {
    // The race's way on the minimap and the big map, like a sat-nav (Yoshi: "Bij een route, toon gps in de minimap").
    await b.evaluate('briel.goals.reset()', false);
    const car = ROUTES.find((x) => x.id === 'car');
    await b.evaluate("briel.travel('house')", false);
    await b.sleep(2500);
    await b.evaluate('briel.getIn()', false);
    await b.waitFor('briel.driving()', 15000);
    await b.sleep(400);
    const none = await navNow();
    const before = await magenta();
    await raceKey();
    await b.sleep(600);
    const s = await navNow();
    const line = s.nav?.line ?? [];
    // From where it joins the roads (line[2]: line[0] is you, line[1] where you are along the way) to where it leaves them.
    const off = sample(line.slice(2, -1)).filter(([x, z]) => NET.nearest(x, z).d > 3);
    const starts = line.length > 1 && Math.hypot(line[0][0] - s.p[0], line[0][1] - s.p[1]) < 1;
    const ends = line.length > 1 && Math.hypot(line.at(-1)[0] - car.gate[0], line.at(-1)[1] - car.gate[1]) < 0.5;
    check('no line without a race', none.nav === null && before === 0, `${js(none.nav)}, ${before} magenta pixels`);
    check('a race asked for in a car at the main house: the line from you to the gate, on the roads', starts && ends && !off.length && s.nav.next[0] === car.gate[0], `${line.length} points, ${Math.round(lengthOf(line))} m, starts at you ${starts}, ends at the gate ${ends}, ${off.length} samples off the roads${off.length ? ` (first ${js(off[0])})` : ''}`);
    const shown = await magenta();
    await mapShot('gps_minimap_start');
    await shot('gps_start');
    // The minimap switched off in the settings (N): nothing drawn.
    await tapKey('KeyN');
    await b.sleep(400);
    const hidden = await magenta();
    const isHidden = await b.evaluate("document.getElementById('minimap').classList.contains('hidden')", false);
    await tapKey('KeyN');
    await b.sleep(300);
    check('the minimap draws the line, and nothing with the minimap off', shown > 50 && isHidden && hidden === 0, `${shown} magenta pixels on, ${hidden} off (hidden ${isHidden})`);
    // The big map shows it too.
    await tapKey('KeyM');
    await b.sleep(1500);
    const big = await b.evaluate("JSON.stringify({ open: !!document.getElementById('bigmap')?.offsetParent, nav: !!briel.goals.nav() })", false);
    await shot('gps_bigmap');
    await tapKey('KeyM');
    await b.sleep(800);
    check('the big map open with the line (see gps_bigmap.png)', big.includes('"nav":true'), big);
    // Well off the line (30 m across it, 10 m a frame: no hop): the way from you is worked out again, once.
    const w0 = (await navNow()).ways;
    const [a0, a1] = [line[1], line[2] ?? line[1]];
    const len = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]) || 1;
    const [nx, nz] = [-(a1[1] - a0[1]) / len, (a1[0] - a0[0]) / len];
    for (let k = 1; k <= 3; k++) {
      await b.evaluate(`(() => { const c = briel.currentCar(); const x = c.x + ${nx * 10}, z = c.z + ${nz * 10}; c.place(x, briel.world.groundAt(x, z, 50, 0.3).y, z, c.yaw); })()`, false);
      await b.evaluate('__g.frame()');
    }
    await b.sleep(1000);
    const moved = await navNow();
    check('30 m off the line: worked out again once, from where you are', moved.nav && moved.ways === w0 + 1 && Math.hypot(moved.nav.line[0][0] - moved.p[0], moved.nav.line[0][1] - moved.p[1]) < 1 && (await rings()).armed === 'car', `ways ${w0} then ${moved.ways}, armed ${(await rings()).armed}`);
    const w1 = moved.ways;
    await b.sleep(1500);
    check('standing still: not worked out again', (await navNow()).ways === w1, `${w1} then ${(await navNow()).ways}`);
    await raceKey();
    await b.evaluate('briel.getOut()', false);
    await b.sleep(400);
    const gone = await navNow();
    check('the key stops it and the line goes', gone.nav === null && (await magenta()) === 0, js(gone.nav));
  }

  if (only.has('climb')) {
    // The two gnomes on a floor, climbed to as a player does: the church's stair to its roof walk (g12, by the sniper),
    // the tree hut's stair (g30).
    const house = JSON.parse(readFileSync(new URL('../../web/src/data/house_shell.json', import.meta.url)));
    const terrain = makeTerrain(JSON.parse(readFileSync(new URL('../../web/shared/terrain.json', import.meta.url))));
    const cd = JSON.parse(readFileSync(new URL('../../web/shared/church.json', import.meta.url)));
    const church = makeChurch(cd, house.ground + terrain.height(...cd.origin));
    const huts = JSON.parse(readFileSync(new URL('../../web/shared/tree_huts.json', import.meta.url)));
    const climbs = [
      ['g12', 'church', [church.anchors.entry, ...church.anchors.stairs, church.anchors.roof].map((p) => [p.x, p.z])],
      ['g30', 'sparrenhof', huts.huts.find((h) => h.id === 'pair').stairs[0].path.map(([x, z]) => [x, z])],
    ];
    for (const [id, travel, way] of climbs) {
      await b.evaluate(`briel.travel(${js(travel)})`, false);
      await b.sleep(3000);
      const s = spots.find((g) => g.id === id);
      const [x0, z0] = way[0];
      await b.evaluate(`briel.teleport(${x0}, ${z0}, briel.world.groundAt(${x0}, ${z0}, 60, 0).y + 0.05)`, false);
        let ok = true, at = 0;
      for (const [x, z] of [...way.slice(1), [s.x, s.z]]) {
        at++;
        const w = await b.evaluate(`__g.walkTo(${x}, ${z}, ${at === way.length ? 1.2 : 0.35}, 80)`);
        if (!w.ok) {
          ok = false;
          break;
        }
      }
      const p = JSON.parse(await b.evaluate('JSON.stringify({ x: briel.player.x, z: briel.player.z, feet: briel.player.feet, found: briel.goals.found() })', false));
      check(`climb to ${id}`, ok && Math.abs(p.feet - s.y) < 0.4, `${ok ? 'reached' : `stuck before point ${at} of ${way.length}`}, at ${p.x.toFixed(1)}, ${p.z.toFixed(1)}, feet ${p.feet.toFixed(2)} (gnome ${s.y.toFixed(2)}), found ${p.found.includes(id)}`);
      await b.evaluate(`briel.teleport(briel.player.x, briel.player.z, briel.player.feet, Math.atan2(-(${s.x} - briel.player.x), -(${s.z} - briel.player.z)), -0.5)`, false);
      await b.sleep(1500);
      await shot(`climb_${id}`);
    }
  }

  if (only.has('warm')) {
    // The warm-up frames behind the start screen (main.ts calls goals.warming): every ring and the golden gnome drawn,
    // and all back as it was after.
    const seen = `JSON.stringify((() => { const r = briel.goals.routes, g = briel.goals.gnomes; return { next: r.next.visible, after: r.after.visible, gates: r.gates.map((o) => o.visible), golden: g.golden.visible }; })())`;
    await b.evaluate("briel.travel('house')", false);
    await b.sleep(2000);
    const before = await b.evaluate(seen, false);
    await b.evaluate('briel.goals.warming(true)', false);
    await b.evaluate('__g.frame()');
    const on = JSON.parse(await b.evaluate(seen, false));
    await b.evaluate('briel.goals.warming(false)', false);
    await b.evaluate('__g.frame()');
    const off = await b.evaluate(seen, false);
    check('warming shows every ring and the golden gnome, then puts them back', on.next && on.after && on.gates.every(Boolean) && on.golden && off === before, `${before} then ${js(on)} then ${off}`);
  }

  if (only.has('zombies')) {
    await b.evaluate("briel.travel('church')", false);
    await b.sleep(3000);
    // By the walking start with its race asked for: the game ends it, and offers nothing while it goes on.
    const fr = ROUTES.find((x) => x.id === 'foot');
    await b.evaluate(`briel.teleport(${fr.gate[0] + 8}, ${fr.gate[1]}, briel.world.groundAt(${fr.gate[0] + 8}, ${fr.gate[1]}, 60, 0).y)`, false);
    await b.sleep(600);
    await raceKey();
    const armedBefore = (await rings()).armed;
    const before = await b.evaluate('briel.goals.group.visible', false);
    await b.evaluate('briel.zombiesSolo.start()', false);
    await b.sleep(2500);
    const during = await b.evaluate("briel.goals.group.visible || !document.getElementById('goal-line').hidden || briel.goals.marks().length > 0", false);
    await raceKey();
    const zr = await rings();
    const zp = await prompt();
    await shot('zombies_hidden');
    await b.evaluate('briel.zombiesSolo.stop()', false);
    await b.sleep(3000);
    const after = await b.evaluate('briel.goals.group.visible', false);
    const ar = await rings();
    check('hidden during solo Zombies', before && !during && after, `before ${before}, during ${during}, after ${after}`);
    check('solo Zombies ends the race and offers none', armedBefore === 'foot' && zr.armed === null && zr.offer === null && !zp.includes('Start the timed route') && ar.armed === null && noRing(ar), `before ${armedBefore}, during ${js(zr)} prompt "${zp}", after ${js(ar)}`);
  }

  for (const kind of ['bike', 'car']) {
    if (!only.has(kind)) continue;
    const r = ROUTES.find((x) => x.id === kind);
    let path;
    if (kind === 'bike') {
      await b.evaluate("briel.travel('church')", false);
      await b.sleep(3000);
      // Together the bikes stay where the last rider left them: the free one standing nearest the church's rack.
      const bikeId = o.together
        ? await b.evaluate("(() => { let best = 'church1', d = Infinity; for (const [id, k] of briel.bikes.byId) { if (k.rider || k.lie) continue; const e = Math.hypot(k.x - 533, k.z + 770); if (e < d) [best, d] = [id, e]; } return best; })()", false)
        : 'church1';
      await b.evaluate(o.together
        ? `(() => { const k = briel.bikes.byId.get(${js(bikeId)}); briel.teleport(k.x + 1.2, k.z, briel.world.groundAt(k.x + 1.2, k.z, 60, 0).y); })()`
        : 'briel.teleport(533, -769, briel.world.groundAt(533, -769, 60, 0).y)', false);
      await settle(5000);
      await b.evaluate(`briel.getOnBike(${js(bikeId)})`, false);
      await b.sleep(o.together ? 1500 : 500);
      // Along the road register's centre lines from point to point (src/ui/route.ts: the streets, the field tracks too);
      // where it has no line (a straight leg) and something stands in the way, round it over cells a bike fits through.
      path = JSON.parse(await b.evaluate(`(async () => {
        const { route } = await import('/src/ui/route.ts');
        const k = briel.bikes.ridden; // it first rides 4 m straight on, out of the rack (west)
        // Back to the gate north of the bike rack (533, -771), which stands on the register's line, as a rider goes round it.
        const pts = [[k.x - 4, k.z], ...${js([r.gate, ...r.checkpoints, [540, -767], [527, -768], r.gate])}, [${r.checkpoints[0][0]}, ${r.checkpoints[0][1]}]];
        const out = [];
        for (let i = 1; i < pts.length; i++) {
          const [a, b] = [pts[i - 1], pts[i]];
          const line = route(a, b).line;
          const at = (p) => ({ x: p[0], y: briel.world.groundAt(p[0], p[1], 60, 0).y + 1, z: p[1] });
          const blocked = line.length <= 2 && briel.world.clearance(at(a), at(b)) < 0.99;
          out.push(...(blocked ? (__g.way(b[0], b[1], 1.5, a, 0.8) ?? line) : line));
        }
        return JSON.stringify(out);
      })()`));
    } else {
      // The traffic's loop (src/data/roads.json routes[0]) from 60 m before the gate round to 30 m past it.
      const p = ROADS.routes[0].legs[0].p;
      const loop = [];
      for (let i = 0; i < p.length; i += 2) loop.push([p[i], p[i + 1]]);
      // The traffic keeps to the right edge, where a house stands right by the road; this car keeps 1.5 m more to the left.
      const mid = loop.map(([x, z], i) => {
        const [nx, nz] = loop[(i + 1) % loop.length], [px, pz] = loop[(i - 1 + loop.length) % loop.length];
        const dx = nx - px, dz = nz - pz, l = Math.hypot(dx, dz) || 1;
        return [x + (dz / l) * 1.5, z - (dx / l) * 1.5];
      });
      // The loop passes the gate twice (out and back along the same street): the pass on the traffic's own line.
      let g = 0;
      loop.forEach(([x, z], i) => Math.hypot(x - r.gate[0], z - r.gate[1]) < Math.hypot(loop[g][0] - r.gate[0], loop[g][1] - r.gate[1]) && (g = i));
      loop.splice(0, loop.length, ...mid);
      const back = (i, m) => { let d = 0; while (d < m) { const j = (i - 1 + loop.length) % loop.length; d += Math.hypot(loop[i][0] - loop[j][0], loop[i][1] - loop[j][1]); i = j; } return i; };
      const s0 = back(g, 60);
      path = [];
      for (let k = 0, i = s0; k < loop.length + 40; k++, i = (i + 1) % loop.length) path.push(loop[i]);
      await b.evaluate('briel.travel(\'house\')', false);
      await b.sleep(3000);
      // Together: by the Tesla's door, and a while for the server to see you there.
      if (o.together) {
        await b.evaluate("(() => { const car = briel.cars.find((c) => c.id === 'tesla'); const at = car.exitSpot(); briel.player.place(at.x, at.z, car.y, 0, 0); })()", false);
        await settle(6000);
      }
      await b.evaluate('briel.getIn()', false);
      // Together: the server lets you in only once its place of you is by the car; ask again until it does (as drive_mp.mjs).
      for (let i = 0; o.together && i < 30 && !(await b.evaluate('briel.driving()', false)); i++) {
        await b.sleep(1500);
        await b.evaluate('briel.getIn()', false);
      }
      await b.waitFor('briel.driving()', 15000);
      await b.evaluate(`(() => { const car = briel.currentCar(); const [x, z] = ${js(path[0])}, [nx, nz] = ${js(path[3])}; const g = briel.world.groundAt(x, z, 50, 0.3); car.place(x, g.y, z, Math.atan2(-(nx - x), -(nz - z))); })()`, false);
      await settle(5000);
    }
    // The race asked for (after the car's move to the start of the path: a hop ends a race).
    await b.evaluate('__g.frame()');
    await raceKey();
    check(`${kind} race asked for`, (await rings()).armed === kind, js(await rings()));
    const ways0 = (await navNow()).ways;
    const gps = { shots: new Set(), behind: null };
    // The autopilot: every frame the vehicle's own input, steering at a point 5 m ahead on the path.
    await b.evaluate(`(() => {
      const kind = ${js(kind)};
      const path = ${js(path)};
      const target = ${o.target ? Number(o.target) : 'kind === \'bike\' ? 5.5 : 10'}; // --target: the autopilot's speed (m/s)
      const st = window.__auto = { i: 0, done: false, t0: performance.now(), at: null };
      const pose = () => { if (kind === 'bike') { const k = briel.bikes.ridden; return k && { x: k.x, z: k.z, yaw: k.yaw, v: k.speed }; } const c = briel.currentCar(); return { x: c.x, z: c.z, yaw: c.yaw, v: Math.hypot(c.vx, c.vz) }; };
      const input = (base) => {
        const p = pose();
        if (!p || st.done) return { ...base, throttle: 0, brake: 1, steer: 0 };
        st.at = [+p.x.toFixed(1), +p.z.toFixed(1)];
        // A bike first rides straight out of its rack, clear of the others in it.
        if (kind === 'bike' && performance.now() - st.t0 < 1500) return { ...base, throttle: 1, brake: 0, steer: 0 };
        // Stuck (a parked car on the line, a corner): back off a little, then find a way round to a point further on.
        const now = performance.now();
        if (Math.abs(p.v) > 0.6 || now - st.t0 < 3000) st.moved = now;
        if (st.back > now) return { ...base, throttle: 0, brake: 1, steer: 0, handbrake: false };
        if (now - st.moved > 2000) {
          st.moved = now + 1500;
          if (st.backed) {
            // Round it to the run's next checkpoint when that is near (a way round must not miss it), else further on.
            const tg = briel.goals.run()?.target;
            const near = tg && Math.hypot(tg.x - p.x, tg.z - p.z) < 30 ? __g.way(tg.x, tg.z, 2, [p.x, p.z], 0.8) : null;
            const j = Math.min(path.length - 1, st.i + 12);
            const round = near ? null : __g.way(path[j][0], path[j][1], 1.5, [p.x, p.z], 0.8);
            if (near) path.splice(st.i, 0, ...near.slice(1));
            else if (round) path.splice(st.i, j - st.i, ...round.slice(1));
            st.reroutes = (st.reroutes ?? 0) + 1;
            st.backed = false;
          } else {
            st.back = now + 1200;
            st.backed = true;
            return { ...base, throttle: 0, brake: 1, steer: 0, handbrake: false };
          }
        }
        while (st.i < path.length - 1 && Math.hypot(path[st.i][0] - p.x, path[st.i][1] - p.z) < (kind === 'bike' ? 2.5 : 5)) st.i++;
        if (st.i >= path.length - 1) st.done = true;
        const [tx, tz] = path[st.i];
        const want = Math.atan2(-(tx - p.x), -(tz - p.z));
        const err = Math.atan2(Math.sin(want - p.yaw), Math.cos(want - p.yaw));
        const steer = Math.max(-1, Math.min(1, -err * 2.2)); // a positive steer turns right (the yaw goes down)
        let slow = Math.abs(err) > 0.5 ? 0.55 : 1;
        // Behind the traffic, at a distance (it waits for a car someone drives in front of it, not behind).
        const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
        for (const c of briel.roadLife.traffic.cars) {
          const ax = c.x - p.x, az = c.z - p.z, ahead = ax * fx + az * fz;
          if (ahead > 0 && ahead < 16 && Math.abs(ax * fz - az * fx) < 3) slow = Math.min(slow, ahead < 9 ? 0 : 0.4);
        }
        return { ...base, throttle: p.v < target * slow ? 1 : 0, brake: slow === 0 ? (p.v > 0.5 ? 1 : 0) : p.v > target * slow + 1.5 ? 0.6 : 0, steer, handbrake: false };
      };
      // Why a run stopped: the step, how you moved, the time since the last frame.
      const goalsUpdate = briel.goals.update;
      st.off = 0;
      briel.goals.update = function (dt, cam, me) {
        if (!me.on || !this.group.visible) st.off++;
        const armed = this.race.armed;
        const out = goalsUpdate.call(this, dt, cam, me);
        if (armed && !this.race.armed && !st.ended) st.ended = { by: me.by, on: me.on, at: [+me.x.toFixed(1), +me.z.toFixed(1)], dt: +dt.toFixed(3) };
        return out;
      };
      const routes = briel.goals.routes, update = routes.update;
      let tPrev = performance.now();
      routes.update = function (me, now) {
        const from = this.last, run = this.run;
        const r = update.call(this, me, now);
        if (r && r.event === 'stop') st.stopped = { by: me.by, step: from ? +Math.hypot(me.x - from.x, me.z - from.z).toFixed(2) : null, frameMs: Math.round(now - tPrev), sinceLast: run ? Math.round(now - run.last) : null, at: [+me.x.toFixed(1), +me.z.toFixed(1)] };
        tPrev = now;
        return r;
      };
      if (kind === 'bike') { const ride = briel.bikes.ride; briel.bikes.ride = function (dt, i, o) { return ride.call(this, dt, input(i), o); }; }
      else { const car = briel.currentCar(); const drive = car.drive; car.drive = function (dt, i, o) { return drive.call(this, dt, input(i), o); }; }
    })()`, false);
    const t0 = Date.now();
    const seen = [];
    let last = '';
    while (Date.now() - t0 < (kind === 'bike' ? 240000 : 400000)) {
      await b.sleep(400);
      const st = JSON.parse(await b.evaluate('JSON.stringify({ a: __auto, run: briel.goals.run(), toast: document.getElementById(\'toast\').textContent })', false));
      const l = await line();
      if (l && l !== last) {
        last = l;
        const m = l.match(/Checkpoint \d+ of \d+|To the finish/);
        if (m && seen.at(-1) !== m[0]) {
          seen.push(m[0]);
          if (seen.length === 2) await shot(`${kind}_run`);
        }
      }
      // The race's line: before the start, a little after the first checkpoint (the part driven left out), near the finish.
      const n = await navNow();
      const pic = !st.run ? 'start' : st.run.next === 1 && n.nav ? 'mid' : st.run.target?.finish ? 'finish' : '';
      if (pic && !gps.shots.has(pic)) {
        gps.shots.add(pic);
        await mapShot(`gps_${kind}_${pic}`);
        if (pic === 'mid') {
          const r = ROUTES.find((x) => x.id === kind);
          const along = NET.route(n.p, r.checkpoints[1]).length;
          gps.behind = { next: n.nav.next, later: n.nav.later.length, toNext: Math.round(n.nav.toNext), roads: Math.round(along), starts: +Math.hypot(n.nav.line[0][0] - n.p[0], n.nav.line[0][1] - n.p[1]).toFixed(2) };
          // The whole way on to the finish: on the roads (the car's; the bike's may cross a square or a track straight).
          const all = sample(n.nav.line.slice(2, -1));
          gps.behind.offRoad = all.filter(([x, z]) => NET.nearest(x, z).d > 6).length;
          gps.behind.metres = Math.round(lengthOf(n.nav.line));
          gps.behind.ok = n.nav.next[0] === r.checkpoints[1][0] && gps.behind.later === 2 && gps.behind.starts < 1 && n.nav.toNext <= along * 1.5 + 30 && (kind !== 'car' || gps.behind.offRoad === 0);
        }
      }
      if (o.trace && Math.floor((Date.now() - t0) / 5000) !== Math.floor((Date.now() - t0 - 400) / 5000)) console.log('     trace', JSON.stringify({ i: st.a.i, at: st.a.at, run: st.run && st.run.next }));
      if (st.a.done) break;
      if (Date.now() - t0 > 20000 && st.a.i < 3) break;
    }
    const finish = await toast();
    const best = await b.evaluate("localStorage.getItem('briel.routes') ?? ''", false);
    const at = await b.evaluate('JSON.stringify(window.__auto)', false);
    console.log(`     ${kind}: ${seen.join(' > ')}; autopilot ${at.slice(0, 120)} of ${path.length} points`);
    const why = JSON.parse(at);
    if (why.stopped || why.ended) console.log(`     ${kind} run stopped: ${js(why.stopped ?? null)}, race ended: ${js(why.ended ?? null)}`);
    check(`${kind} route`, best.includes(`${kind}@1`), `toast "${finish}", stored ${best}`);
    if (o.together) await serverTimed(kind, best);
    const ways = (await navNow()).ways - ways0;
    const most = 3 * (ROUTES.find((x) => x.id === kind).checkpoints.length + 1);
    check(`${kind}: after the first checkpoint the line starts at you, the part behind left out`, !!gps.behind?.ok, js(gps.behind));
    check(`${kind}: the way worked out a bounded number of times over the run`, ways > 0 && ways <= most, `${ways} times (at most ${most}); pictures ${[...gps.shots].join(', ')}`);
    await shot(`${kind}_finish`);
    if (kind === 'bike') await b.evaluate('briel.getOffBike()', false);
    else await b.evaluate('briel.getOut()', false);
    await settle(2000); // together: the server has you off the bike before the next trip (it refuses a trip on one)
  }

  const errors = b.logs.filter((l) => /^(error|exception)/.test(l));
  if (errors.length) console.log(errors.slice(0, 8).join('\n'));
  check('no errors in the page', !errors.length, `${errors.length}`);
} finally {
  b.close();
}
console.log(failures.length ? `${failures.length} failed: ${failures.join(', ')}` : 'all passed');
process.exit(failures.length ? 1 : 0);
