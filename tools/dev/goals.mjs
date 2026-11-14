// Check the garden gnomes and the timed routes (web/src/world/goals.ts) in the real game, on a running dev server, in
// one page load: every gnome, gate and checkpoint dropped onto (on the ground, not in a hedge, a wall or a pond) and
// walked from to a road (a search over 0.5 m cells); a picture of every gnome and gate; finding g01 and g10, kept after a
// reload; the walking route walked; a run stopped by a teleport; the two gnomes on a floor climbed to; solo Zombies
// hiding it all. --ride: also the bike route ridden and the car route driven, by a simple autopilot along the roads
// (it keeps behind the traffic, backs off and finds a way round when stuck; --trace prints where it is every 5 s).
//
//   node tools/dev/goals.mjs --url http://localhost:5200/ --port 9920 [--quality high] [--phone] [--shots <folder>]
//                            [--only spots,reach,shots,find,foot,line,climb,warm,zombies,bike,car] [--ride] [--trace]
//                            [--size 667x375]
//
// Prints one line per check and a summary; exits 1 when any check failed.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeChurch } from '../../web/shared/church.mjs';
import { makeTerrain } from '../../web/shared/terrain.mjs';
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5200/', port: '9920', quality: 'high', phone: false, shots: '', only: '', ride: false, trace: false, size: '' });
const ROUTES = JSON.parse(readFileSync(new URL('../../web/shared/routes.json', import.meta.url))).routes;
const ROADS = JSON.parse(readFileSync(new URL('../../web/src/data/roads.json', import.meta.url)));
const all = ['spots', 'reach', 'shots', 'find', 'foot', 'line', 'climb', 'warm', 'zombies', ...(o.ride ? ['bike', 'car'] : [])];
const only = new Set(o.only ? o.only.split(',') : all);
if (o.shots) mkdirSync(o.shots, { recursive: true });

const b = await launch({ port: Number(o.port), width: 1280, height: 720 });
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const shot = async (name) => o.shots && b.screenshot(join(o.shots, `${name}.png`));
const js = (v) => JSON.stringify(v);
const toast = () => b.evaluate("document.getElementById('toast')?.textContent ?? ''", false);
const line = () => b.evaluate("(() => { const l = document.getElementById('goal-line'); return l && !l.hidden ? l.textContent : ''; })()", false);

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
        for (let n = 0; n < maxSteps; n++) {
          const p = briel.player;
          const d = Math.hypot(tx - p.x, tz - p.z);
          if (d < r) return { ok: true, n };
          const yaw = Math.atan2(-(tx - p.x), -(tz - p.z));
          briel.teleport(p.x, p.z, p.feet, yaw, 0);
          const before = [p.x, p.z];
          briel.walk(Math.min(0.25, d / 4), 0, 1);
          await frame();
          if (Math.hypot(p.x - before[0], p.z - before[1]) < 0.05) { if (++stuck > 6) return { ok: false, n, stuck: [+p.x.toFixed(1), +p.z.toFixed(1)] }; } else stuck = 0;
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
  await startGame(b, o.url, { phone: o.phone, village: true });
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
    await b.evaluate(`briel.teleport(${sx}, ${sz}, ${sg}, ${Math.atan2(-(gx - sx), -(gz - sz))}, 0)`, false);
    await b.sleep(1500);
    await shot('foot_gate_line');
    const near = await line();
    check('the line by the gate', near.includes('Church square on foot'), near);
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
    // A run stopped by a teleport 100 m away.
    await b.evaluate(`briel.teleport(${sx}, ${sz}, ${sg}, ${Math.atan2(-(gx - sx), -(gz - sz))}, 0)`, false);
    await b.evaluate(`__g.walkTo(${fx}, ${fz}, 2)`);
    const running = await b.evaluate('!!briel.goals.run()', false);
    await b.evaluate(`briel.teleport(${gx + 100}, ${gz}, briel.world.groundAt(${gx + 100}, ${gz}, 60, 0).y)`, false);
    await b.evaluate('__g.frame()');
    await b.sleep(200);
    const stopped = await toast();
    check('a teleport stops the run', running && stopped.includes('Route stopped') && !(await b.evaluate('!!briel.goals.run()', false)), `running before ${running}, toast "${stopped}"`);
    // A hop across the gate (a teleport 6 m before it to 6 m past it) starts no clock.
    await b.evaluate(`briel.teleport(${sx}, ${sz}, ${sg}, 0, 0)`, false);
    await b.evaluate('__g.frame()');
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
    const before = await b.evaluate('briel.goals.group.visible', false);
    await b.evaluate('briel.zombiesSolo.start()', false);
    await b.sleep(2500);
    const during = await b.evaluate("briel.goals.group.visible || !document.getElementById('goal-line').hidden || briel.goals.marks().length > 0", false);
    await shot('zombies_hidden');
    await b.evaluate('briel.zombiesSolo.stop()', false);
    await b.sleep(3000);
    const after = await b.evaluate('briel.goals.group.visible', false);
    check('hidden during solo Zombies', before && !during && after, `before ${before}, during ${during}, after ${after}`);
  }

  for (const kind of ['bike', 'car']) {
    if (!only.has(kind)) continue;
    const r = ROUTES.find((x) => x.id === kind);
    let path;
    if (kind === 'bike') {
      await b.evaluate("briel.travel('church')", false);
      await b.sleep(3000);
      await b.evaluate("briel.teleport(533, -769, briel.world.groundAt(533, -769, 60, 0).y); briel.getOnBike('church1')", false);
      await b.sleep(500);
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
      await b.evaluate('briel.getIn()', false);
      await b.waitFor('briel.driving()', 15000);
      await b.evaluate(`(() => { const car = briel.currentCar(); const [x, z] = ${js(path[0])}, [nx, nz] = ${js(path[3])}; const g = briel.world.groundAt(x, z, 50, 0.3); car.place(x, g.y, z, Math.atan2(-(nx - x), -(nz - z))); })()`, false);
    }
    // The autopilot: every frame the vehicle's own input, steering at a point 5 m ahead on the path.
    await b.evaluate(`(() => {
      const kind = ${js(kind)};
      const path = ${js(path)};
      const target = kind === 'bike' ? 5.5 : 10;
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
            const j = Math.min(path.length - 1, st.i + 12);
            const round = __g.way(path[j][0], path[j][1], 1.5, [p.x, p.z], 0.8);
            if (round) path.splice(st.i, j - st.i, ...round.slice(1));
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
        return goalsUpdate.call(this, dt, cam, me);
      };
      const routes = briel.goals.routes, update = routes.update;
      let tPrev = performance.now();
      routes.update = function (cam, me, now) {
        const from = this.last, run = this.run;
        const r = update.call(this, cam, me, now);
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
      if (o.trace && Math.floor((Date.now() - t0) / 5000) !== Math.floor((Date.now() - t0 - 400) / 5000)) console.log('     trace', JSON.stringify({ i: st.a.i, at: st.a.at, run: st.run && st.run.next }));
      if (st.a.done) break;
      if (Date.now() - t0 > 20000 && st.a.i < 3) break;
    }
    const finish = await toast();
    const best = await b.evaluate("localStorage.getItem('briel.routes') ?? ''", false);
    const at = await b.evaluate('JSON.stringify(window.__auto)', false);
    console.log(`     ${kind}: ${seen.join(' > ')}; autopilot ${at.slice(0, 120)} of ${path.length} points`);
    check(`${kind} route`, best.includes(`${kind}@1`), `toast "${finish}", stored ${best}`);
    await shot(`${kind}_finish`);
    if (kind === 'bike') await b.evaluate('briel.getOffBike()', false);
    else await b.evaluate('briel.getOut()', false);
  }

  const errors = b.logs.filter((l) => /^(error|exception)/.test(l));
  if (errors.length) console.log(errors.slice(0, 8).join('\n'));
  check('no errors in the page', !errors.length, `${errors.length}`);
} finally {
  b.close();
}
console.log(failures.length ? `${failures.length} failed: ${failures.join(', ')}` : 'all passed');
process.exit(failures.length ? 1 : 0);
