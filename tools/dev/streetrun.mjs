// A street walked and driven end to end in the real game, on a running dev server (window.briel), and its stretch of the
// game's edge tried on foot: for a street new on the map (Blekte, 15 Nov 2026), or any other.
// - walk: every run of the street's road detail (web/src/data/roadDetail.json) walked along its middle, there and back,
//   in 0.25 s steps: it must not stick (a block, a hole), fall (the feet more than DROP m under where they were with
//   the ground under them as high) or end short of the run's far end, and the place line must name the street;
// - drive: each run of MIN_DRIVE m or more driven from end to end by a simple autopilot (as tools/dev/goals.mjs --ride):
//   it must arrive, without leaving the road by more than OFF m;
// - edge: every point of the edge (web/shared/bounds.json `map`) within --box: the player put 5 m inside, walking
//   straight out for 10 s, must stay inside (within 0.6 m) and on the ground.
//
//   node tools/dev/streetrun.mjs --url http://localhost:5200/ --port 9380 [--street Blekte] [--quality low]
//        [--only walk,drive,edge] [--box 640,-160,2000,620] [--shots <folder>]
//
// Prints one line per check and a summary; exits 1 when any failed.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5200/', port: '9380', street: 'Blekte', quality: 'low', only: 'walk,drive,edge', box: '640,-160,2000,620', shots: '' });
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DETAIL = JSON.parse(readFileSync(join(ROOT, 'web/src/data/roadDetail.json'), 'utf8'));
const MAP = JSON.parse(readFileSync(join(ROOT, 'web/shared/bounds.json'), 'utf8')).map;
const only = new Set(o.only.split(','));
const DROP = 1.5;
const MIN_DRIVE = 80;
const OFF = 6;
const js = (v) => JSON.stringify(v);

const runs = DETAIL.runs
  .filter((r) => r.name === o.street || r.name.startsWith(`${o.street}~`))
  .map((r) => ({ name: r.name, pf: r.pf, pts: Array.from({ length: r.p.length / 2 }, (_, i) => [r.p[2 * i], r.p[2 * i + 1]]) }));
if (!runs.length) throw new Error(`no runs named ${o.street} in the road detail`);
const len = (pts) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
/** Every `step` m along a run (and its last point). */
const every = (pts, step) => {
  const out = [pts[0]];
  let d = 0;
  for (let i = 1; i < pts.length; i++) {
    d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (d >= step) { out.push(pts[i]); d = 0; }
  }
  if (out.at(-1) !== pts.at(-1)) out.push(pts.at(-1));
  return out;
};
const inside = (x, z, poly) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
};
const toEdge = (x, z) => {
  let best = Infinity;
  for (let i = 0, j = MAP.length - 1; i < MAP.length; j = i++) {
    const [ax, az] = MAP[j], [bx, bz] = MAP[i];
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / ((bx - ax) ** 2 + (bz - az) ** 2 || 1)));
    best = Math.min(best, Math.hypot(x - ax - t * (bx - ax), z - az - t * (bz - az)));
  }
  return best;
};

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const b = await launch({ port: Number(o.port), width: 1280, height: 720 });
try {
  await startGame(b, o.url, { village: true });
  await b.evaluate(`(() => { briel.three.applyQuality(${js(o.quality)}); briel.three.holdQuality(true); })()`, false);
  await b.evaluate(`window.__sr = {
    frame: () => new Promise((r) => requestAnimationFrame(() => r())),
    /** Walk along pts in 0.25 s steps; the lowest the feet went under where they stood, stuck spots, where it ended. */
    async along(pts) {
      const p = briel.player;
      const [x0, z0] = pts[0];
      const g0 = briel.world.groundAt(x0, z0, 60, 0.3);
      briel.teleport(x0, z0, g0.y + 0.05, Math.atan2(-(pts[1][0] - x0), -(pts[1][1] - z0)), 0);
      briel.walk(0.3, 0, 0);
      let drop = 0, stuck = null, places = new Set();
      for (let k = 1; k < pts.length && !stuck; k++) {
        const [tx, tz] = pts[k];
        let still = 0;
        for (let n = 0; n < 120; n++) {
          const d = Math.hypot(tx - p.x, tz - p.z);
          if (d < 1.2) break;
          briel.teleport(p.x, p.z, p.feet, Math.atan2(-(tx - p.x), -(tz - p.z)), 0);
          const before = [p.x, p.z, p.feet];
          briel.walk(Math.min(0.25, d / 4), 0, 1);
          await this.frame();
          const g = briel.world.groundAt(p.x, p.z, before[2] + 0.6, 0.3);
          drop = Math.max(drop, g.y - p.feet);
          if (Math.hypot(p.x - before[0], p.z - before[1]) < 0.05) { if (++still > 6) { stuck = [+p.x.toFixed(1), +p.z.toFixed(1)]; break; } } else still = 0;
        }
        if (k % 4 === 0 || k === pts.length - 1) places.add(document.getElementById('place')?.textContent ?? '');
      }
      const [ex, ez] = pts.at(-1);
      return { drop: +drop.toFixed(2), stuck, end: +Math.hypot(ex - p.x, ez - p.z).toFixed(1), places: [...places] };
    },
  }`, false);

  if (only.has('walk')) {
    for (const r of runs) {
      const pts = every(r.pts, 8);
      for (const [dir, way] of [['there', pts], ['back', [...pts].reverse()]]) {
        const res = JSON.parse(await b.evaluate(`__sr.along(${js(way)}).then(JSON.stringify)`));
        const named = res.places.some((t) => t.toLowerCase().includes(o.street.toLowerCase()));
        check(`walk ${r.name} (${r.pf}, ${Math.round(len(r.pts))} m) ${dir}`, !res.stuck && res.end < 3 && res.drop < DROP && named,
          `end ${res.end} m off, deepest ${res.drop} m under the ground, stuck ${js(res.stuck)}, place line ${js(res.places.slice(0, 2))}`);
      }
    }
    if (o.shots) { mkdirSync(o.shots, { recursive: true }); await b.screenshot(join(o.shots, 'walk_end.png')); }
  }

  if (only.has('drive')) {
    await b.evaluate("briel.travel('house')", false);
    await b.sleep(3000);
    await b.evaluate("document.getElementById('cc-close')?.click(); briel.getIn()", false);
    await b.waitFor('briel.driving()', 15000);
    for (const r of runs.filter((x) => len(x.pts) >= MIN_DRIVE && !x.name.includes('~'))) {
      for (const [dir, way] of [['there', r.pts], ['back', [...r.pts].reverse()]]) {
        const path = every(way, 4);
        await b.evaluate(`(() => {
          const path = ${js(path)};
          const car = briel.currentCar();
          const [x, z] = path[0], [nx, nz] = path[2];
          car.place(x, briel.world.groundAt(x, z, 60, 0.3).y, z, Math.atan2(-(nx - x), -(nz - z)));
          const st = window.__drive = { i: 0, done: false, off: 0, t0: performance.now() };
          if (!car.__sr) {
            car.__sr = car.drive;
            car.drive = function (dt, i, o) { return car.__sr.call(this, dt, window.__drive?.input ? window.__drive.input(i) : i, o); };
          }
          st.input = (base) => {
            const c = briel.currentCar();
            if (st.done) return { ...base, throttle: 0, brake: 1, steer: 0 };
            while (st.i < path.length - 1 && Math.hypot(path[st.i][0] - c.x, path[st.i][1] - c.z) < 5) st.i++;
            if (st.i >= path.length - 1 && Math.hypot(path.at(-1)[0] - c.x, path.at(-1)[1] - c.z) < 6) st.done = true;
            let off = Infinity;
            for (let k = Math.max(0, st.i - 3); k < Math.min(path.length, st.i + 3); k++) off = Math.min(off, Math.hypot(path[k][0] - c.x, path[k][1] - c.z));
            st.off = Math.max(st.off, off);
            const [tx, tz] = path[st.i];
            const want = Math.atan2(-(tx - c.x), -(tz - c.z));
            const err = Math.atan2(Math.sin(want - c.yaw), Math.cos(want - c.yaw));
            const v = Math.hypot(c.vx, c.vz);
            const target = Math.abs(err) > 0.5 ? 5 : 11;
            return { ...base, throttle: v < target ? 1 : 0, brake: v > target + 2 ? 0.6 : 0, steer: Math.max(-1, Math.min(1, -err * 2.2)), handbrake: false };
          };
        })()`, false);
        const t0 = Date.now();
        let st = null;
        while (Date.now() - t0 < Math.max(60000, len(r.pts) * 400)) {
          await b.sleep(500);
          st = JSON.parse(await b.evaluate('JSON.stringify({ i: __drive.i, done: __drive.done, off: __drive.off, at: [briel.currentCar().x, briel.currentCar().z].map((v) => +v.toFixed(1)) })', false));
          if (st.done) break;
        }
        const sec = Math.round((Date.now() - t0) / 1000);
        check(`drive ${r.name} (${Math.round(len(r.pts))} m) ${dir}`, st.done && st.off < OFF, `arrived ${st.done} in ${sec} s, at ${js(st.at)}, at most ${st.off.toFixed(1)} m off the middle`);
      }
    }
    await b.evaluate('window.__drive = null; briel.getOut()', false);
    if (o.shots) await b.screenshot(join(o.shots, 'drive_end.png'));
  }

  if (only.has('edge')) {
    const [bx0, bz0, bx1, bz1] = o.box.split(',').map(Number);
    let tried = 0;
    const bad = [];
    for (let i = 0; i < MAP.length; i++) {
      const [x, z] = MAP[i];
      if (x < bx0 || x > bx1 || z < bz0 || z > bz1) continue;
      // The inward side: the normal of the edge here that points inside.
      const [ax, az] = MAP[(i - 1 + MAP.length) % MAP.length], [cx, cz] = MAP[(i + 1) % MAP.length];
      let nx = -(cz - az), nz = cx - ax;
      const n = Math.hypot(nx, nz) || 1;
      nx /= n; nz /= n;
      if (!inside(x + nx * 5, z + nz * 5, MAP)) { nx = -nx; nz = -nz; }
      const sx = x + nx * 5, sz = z + nz * 5;
      if (!inside(sx, sz, MAP)) continue; // a sharp corner: no spot 5 m in along the normal
      tried++;
      const res = JSON.parse(await b.evaluate(`(async () => {
        const g = briel.world.groundAt(${sx}, ${sz}, 60, 0.3);
        briel.teleport(${sx}, ${sz}, g.y + 0.05, ${Math.atan2(nx, nz)}, 0);
        briel.walk(10, 0, 1);
        await __sr.frame();
        const p = briel.player;
        const under = briel.world.groundAt(p.x, p.z, p.feet + 0.6, 0.3).y;
        return JSON.stringify({ x: p.x, z: p.z, feet: p.feet, gap: p.feet - under });
      })()`));
      const outside = !inside(res.x, res.z, MAP) ? toEdge(res.x, res.z) : 0;
      if (outside > 0.6 || Math.abs(res.gap) > 0.6) bad.push({ at: [x, z], end: [+res.x.toFixed(1), +res.z.toFixed(1)], outside: +outside.toFixed(2), gap: +res.gap.toFixed(2) });
    }
    check(`edge within ${o.box}: ${tried} points walked out from 5 m inside`, tried > 0 && !bad.length, bad.length ? js(bad.slice(0, 5)) : 'all stayed inside and on the ground');
  }

  const errors = b.logs.filter((l) => /^(error|exception)/.test(l));
  if (errors.length) console.log(errors.slice(0, 8).join('\n'));
  check('no errors in the page', !errors.length, `${errors.length}`);
} finally {
  b.close();
}
console.log(failures.length ? `${failures.length} failed: ${failures.join(', ')}` : 'all passed');
process.exit(failures.length ? 1 : 0);
