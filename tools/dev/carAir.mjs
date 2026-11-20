// A car leaving the ground and landing (world/car.ts, world/carBody.ts rideHeight) in the real game, on a running
// dev server: over the school's plateau on Smetlededorp at 30, 50 and 90 km/h, off a ditch's bank at 50 km/h, and
// along the straight road out in the fields at 50 to 200 km/h, where it must never leave the ground. The throttle
// holds the speed; nothing is in the car's way (fences, hedges, trees: as tools/dev/drive.mjs --open), the ground
// is the real one. For each run: the greatest height of the car over the ground under its middle, the time with its
// tyres off the ground, how far it flew, and how fast it came down. With --out, a picture from beside the car in
// the air over the ditch, coming down (the car held there while it is taken).
// With --mp, two players on a throwaway game server, through a dev server whose proxy points at it (API_PORT=<server
// port> npx vite --port <n>), as tools/dev/drive_mp.mjs: Alice drives the Tesla over the ditch nearest the house,
// Bob rides along beside her (his page draws the car from the server's states, as anyone watching it does). Checks
// that Bob sees it leave the ground and land, about as high as Alice flew it, and that the server took every state
// (Bob sees it end where Alice has it, and at her height).
// With --streets (all, or names with commas), the village's streets driven end to end along their centre lines
// (web/src/data/streets.json) by an autopilot at each of --speeds km/h where it can hold the road (no faster than
// about 0.6 g round a bend), nothing in the way, on the real ground: per street and speed the frames in the air, and
// each flight's place, speed, height over the ground and landing. On a street a car must not leave the ground at 50
// or 70 km/h.
//   node tools/dev/carAir.mjs --url http://localhost:5320/ --port 9421 [--out <folder>] [--json <file>] [--quality low]
//   node tools/dev/carAir.mjs --streets all [--speeds 50,70,90,120] --url http://localhost:5320/ --port 9421 [--json <file>]
//   node tools/dev/carAir.mjs --mp --url http://localhost:5320/ --ports 9422,9423 [--out <folder>]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, localOnly, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5320/', port: '9421', ports: '9422,9423', mp: false, streets: '', speeds: '50,70,90,120', piece: '', trace: '', out: '', json: '', quality: 'low', width: '960', height: '540' });
if (o.streets === 'all') o.streets = true;
if (o.mp) {
  await together();
  process.exit(process.exitCode ?? 0);
}
const b = await launch({ port: Number(o.port), width: Number(o.width), height: Number(o.height) });
const results = [];
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const keep = (row) => {
  console.log(JSON.stringify(row));
  results.push(row);
};
const shot = async (name) => {
  if (!o.out) return;
  mkdirSync(o.out, { recursive: true });
  await b.screenshot(join(o.out, `${name}.png`));
  console.log('picture:', join(o.out, `${name}.png`));
};

// The school's plateau (tools/road_detail.py, src/data/roadDetail.json): its centre line, ramp to ramp.
const detail = JSON.parse(readFileSync(new URL('../../web/src/data/roadDetail.json', import.meta.url), 'utf8'));
const p = detail.school.p;
const plateau = { x0: p[0], z0: p[1], x1: p[p.length - 2], z1: p[p.length - 1] };
// A ditch in the fields (src/data/village.json dips): the bank from its rim to its bottom.
const village = JSON.parse(readFileSync(new URL('../../web/src/data/village.json', import.meta.url), 'utf8'));
const ditches = village.dips.filter((d) => d.name === 'ditch' && d.depth >= 0.9 && d.rim.length >= 60);

async function setUp() {
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('briel.graphics','${o.quality}');localStorage.setItem('briel.lang','en');localStorage.setItem('briel.spawn','house');localStorage.setItem('briel.playMode','explore');` });
  const url = new URL(o.url);
  url.searchParams.set('nobake', '');
  await startGame(b, url.href, { noAsk: true, village: true });
  await b.waitFor('briel.cars.slice(0,2).every(c=>c.wheels.length===4)');
  await b.evaluate("document.getElementById('cc-close')?.click(); briel.getIn()", false);
  await b.waitFor('briel.driving()');
  await b.evaluate("briel.three.weather.setSolo('sunny'); briel.weatherAhead(3600)", false);
  await b.evaluate(`(() => {
    const car = briel.currentCar();
    const real = car.world, trees = car.trees;
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const kmh = () => Math.hypot(car.vx, car.vz) * 3.6;
    const floor = () => real.groundAt(car.x, car.z, car.y, 0.3).y;
    let input = null, hold = false, side = 0;
    const landings = [];
    const drive = car.drive, chase = car.chase, landed = car.landed;
    car.drive = function (dt, i, others) { return hold ? 0 : drive.call(this, dt, input ? { ...i, ...input } : i, others); };
    car.landed = function (speed, ...rest) { landings.push(speed); return landed.call(this, speed, ...rest); };
    // From beside the car (side m to its right), level with it, instead of from behind.
    car.chase = function (camera, dt, ...rest) {
      chase.call(this, camera, dt, ...rest);
      if (!side) return;
      const fx = -Math.sin(car.yaw), fz = -Math.cos(car.yaw);
      camera.position.set(car.x - fz * side + fx * 2, car.y + 1.1, car.z + fx * side + fz * 2);
      camera.lookAt(car.x, car.y + 0.7, car.z);
    };
    window.__air = {
      paused: false,
      /** Nothing in the car's way, or the real world again. */
      open(on) {
        const put = { boxFree: on && (() => true), boxInBounds: on && (() => true), touching: on && (() => null) };
        car.world = on ? new Proxy(real, { get: (t, k) => put[k] || (typeof t[k] === 'function' ? t[k].bind(t) : t[k]) }) : real;
        car.trees = on ? [] : trees;
      },
      /** Standing at (x, z) facing (dx, dz). */
      put(x, z, dx, dz) {
        const g = real.groundAt(x, z, 50, 0.3);
        car.place(x, g.y, z, Math.atan2(-dx, -dz));
        return { y: g.y, mat: g.mat ?? null };
      },
      /** The ground's height along (x, z) + t (dx, dz) for t from a to b, every step m, as a car finds it (nothing over a kerb). */
      profile(x, z, dx, dz, a, b, step) {
        const out = [];
        let y = real.groundAt(x + dx * a, z + dz * a, 50, 0.3).y;
        for (let t = a; t <= b + 1e-9; t += step) {
          y = real.groundAt(x + dx * t, z + dz * t, y, 0.3).y;
          out.push(Math.round(y * 1000) / 1000);
        }
        return out;
      },
      /**
       * Rolling straight on at kmh for s seconds, the throttle holding the speed. picture: once it has flown higher
       * than that (m over the ground), it is held there, seen from beside it, until paused is put back to false.
       */
      async run({ kmh: want, s, picture = 0 }) {
        const v = want / 3.6, fx = -Math.sin(car.yaw), fz = -Math.cos(car.yaw);
        Object.assign(car, { vx: fx * v, vz: fz * v, speed: v, lastSpeed: v });
        landings.length = 0;
        let t = 0, last = performance.now(), most = 0, airTime = 0, airFrames = 0, took = null, down = null, vyLeast = 0, vyMost = 0, wasAir = false, shotTaken = false;
        const x0 = car.x, z0 = car.z, yaw0 = car.yaw;
        let kmhOff = null, kmhOn = null;
        while (t < s) {
          input = { throttle: kmh() < want ? 1 : 0, brake: 0, steer: 0, handbrake: false };
          await frame();
          const now = performance.now();
          const dt = (now - last) / 1000;
          last = now;
          if (hold) continue;
          t += dt;
          const h = car.y - floor();
          most = Math.max(most, h);
          vyLeast = Math.min(vyLeast, car.vy);
          vyMost = Math.max(vyMost, car.vy);
          if (car.air) { airTime += dt; airFrames++; }
          if (car.air && !wasAir) { took = { x: car.x, z: car.z }; kmhOff = kmh(); }
          if (!car.air && wasAir) { down = { x: car.x, z: car.z }; kmhOn = kmh(); }
          wasAir = car.air;
          if (picture && !shotTaken && car.air && h > picture && car.vy < 0.5) {
            shotTaken = true;
            hold = true;
            side = 7;
            this.paused = true;
            while (this.paused) await frame();
            side = 0;
            hold = false;
            last = performance.now();
          }
        }
        input = { throttle: 0, brake: 1, steer: 0, handbrake: true };
        return {
          most, airTime, airFrames, landings: [...landings], vyLeast, vyMost, kmhOff, kmhOn, picture: shotTaken,
          flewM: took && down ? Math.hypot(down.x - took.x, down.z - took.z) : 0,
          wentM: Math.hypot(car.x - x0, car.z - z0), turnedDeg: Math.atan2(Math.sin(car.yaw - yaw0), Math.cos(car.yaw - yaw0)) * 57.3,
        };
      },
      /**
       * Along a street's centre line (path: [x, z] every few metres) at up to kmh, by an autopilot: it steers for a
       * point ahead on the line (further the faster), and takes each bend no faster than about 0.6 g allows, braking
       * for it in time. Every flight: where it took off, how fast, how high over the ground and for how many frames.
       */
      async street(path, want, trace = null) {
        const rows = [];
        const R = path.map((p, i) => {
          const a = path[Math.max(0, i - 2)], c = path[Math.min(path.length - 1, i + 2)];
          const ab = Math.hypot(p[0] - a[0], p[1] - a[1]), bc = Math.hypot(c[0] - p[0], c[1] - p[1]), ac = Math.hypot(c[0] - a[0], c[1] - a[1]);
          const cross = Math.abs((p[0] - a[0]) * (c[1] - a[1]) - (p[1] - a[1]) * (c[0] - a[0]));
          return cross < 1e-6 ? Infinity : (ab * bc * ac) / (2 * cross);
        });
        const along = [0];
        for (let i = 1; i < path.length; i++) along.push(along[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
        const [x0, z0] = path[0], [x1, z1] = path[Math.min(2, path.length - 1)];
        car.place(x0, real.groundAt(x0, z0, 60, 0.3).y, z0, Math.atan2(-(x1 - x0), -(z1 - z0)));
        for (let i = 0; i < 30; i++) await frame();
        const top = want / 3.6;
        let i = 0, frames = 0, air = 0, fast = 0, off = 0, most = 0, wasAir = false, flight = null;
        const flights = [];
        const t0 = performance.now();
        while (performance.now() - t0 < 600000) {
          // Where it is along the line: the nearest of the next few points.
          for (let j = i + 1, best = Math.hypot(path[i][0] - car.x, path[i][1] - car.z); j < Math.min(path.length, i + 15); j++) {
            const dj = Math.hypot(path[j][0] - car.x, path[j][1] - car.z);
            if (dj < best) [i, best] = [j, dj];
          }
          if (i >= path.length - 1 || Math.hypot(path.at(-1)[0] - car.x, path.at(-1)[1] - car.z) < 4) break;
          off = Math.max(off, Math.hypot(path[i][0] - car.x, path[i][1] - car.z));
          const v = Math.hypot(car.vx, car.vz);
          // The point it steers for, and the speed each bend ahead allows (braking at 7 m/s2 to it).
          const look = Math.max(6, v * 0.7);
          let k = i;
          while (k < path.length - 1 && along[k] - along[i] < look) k++;
          let target = top;
          for (let j = i; j < path.length && along[j] - along[i] < (v * v) / 14 + 20; j++) target = Math.min(target, Math.sqrt(6 * R[j] + 14 * (along[j] - along[i])));
          const aim = Math.atan2(-(path[k][0] - car.x), -(path[k][1] - car.z));
          const err = Math.atan2(Math.sin(aim - car.yaw), Math.cos(aim - car.yaw));
          input = { throttle: v < target ? 1 : 0, brake: v > target + 1 ? Math.min(1, (v - target) / 3) : 0, steer: Math.max(-1, Math.min(1, -err * 2.2)), handbrake: false };
          const [px, pz] = [car.x, car.z];
          await frame();
          frames++;
          if (v > 0.9 * top) fast += Math.hypot(car.x - px, car.z - pz);
          most = Math.max(most, v);
          const h = car.y - floor();
          if (trace && along[i] >= trace[0] && along[i] <= trace[1]) {
            const g = real.groundAt(car.x, car.z, car.y, 0.3);
            rows.push([Math.round(along[i]), +car.x.toFixed(2), +car.z.toFixed(2), +car.y.toFixed(3), +g.y.toFixed(3), +car.vy.toFixed(2), car.air ? 1 : 0, Math.round(v * 3.6), g.name ?? '', g.mat ?? '']);
          }
          if (car.air) {
            air++;
            if (!wasAir) flight = { x: Math.round(car.x * 10) / 10, z: Math.round(car.z * 10) / 10, kmh: Math.round(v * 3.6), m: Math.round(along[i]), frames: 0, most: 0 };
            flight.frames++;
            flight.most = Math.max(flight.most, h);
          } else if (wasAir) flights.push({ ...flight, most: Math.round(flight.most * 100) / 100, landed: Math.round((landings.at(-1) ?? 0) * 100) / 100 });
          wasAir = car.air;
        }
        input = { throttle: 0, brake: 1, steer: 0, handbrake: true };
        return { frames, air, flights, done: i >= path.length - 1 || Math.hypot(path.at(-1)[0] - car.x, path.at(-1)[1] - car.z) < 4, lengthM: Math.round(along.at(-1)), fastM: Math.round(fast), topKmh: Math.round(most * 3.6), offM: Math.round(off * 10) / 10, rows };
      },
    };
  })()`, false);
}

/**
 * A street's centre lines (web/src/data/streets.json, the road register's network): the longest way through its
 * pieces, then the longest through what is left, and so on while the rest is 80 m or more.
 */
function streetPaths(name) {
  const g = JSON.parse(readFileSync(new URL('../../web/src/data/streets.json', import.meta.url), 'utf8')).graph;
  const id = g.names.indexOf(name);
  let edges = g.edges.filter((e, k) => g.street[k] === id);
  const P = g.points;
  const d = (a, c) => Math.hypot(P[a][0] - P[c][0], P[a][1] - P[c][1]);
  const out = [];
  while (edges.length) {
    const next = new Map();
    for (const [a, c] of edges) {
      next.set(a, [...(next.get(a) ?? []), c]);
      next.set(c, [...(next.get(c) ?? []), a]);
    }
    // The furthest point from a start along the pieces, and the way there.
    const far = (from) => {
      const dist = new Map([[from, 0]]);
      const prev = new Map();
      const todo = [from];
      while (todo.length) {
        const a = todo.shift();
        for (const c of next.get(a)) if (!dist.has(c)) {
          dist.set(c, dist.get(a) + d(a, c));
          prev.set(c, a);
          todo.push(c);
        }
      }
      let end = from;
      for (const [k, v] of dist) if (v > dist.get(end)) end = k;
      const way = [end];
      while (prev.has(way.at(-1))) way.push(prev.get(way.at(-1)));
      return { end, way: way.reverse(), len: dist.get(end) };
    };
    const a = far(edges[0][0]).end;
    const best = far(a);
    if (best.len < 80) break;
    out.push(best.way.map((k) => P[k]));
    const used = new Set(best.way.slice(1).map((k, j) => `${Math.min(k, best.way[j])},${Math.max(k, best.way[j])}`));
    edges = edges.filter(([x, y]) => !used.has(`${Math.min(x, y)},${Math.max(x, y)}`));
  }
  // Every 3 m along each.
  return out.map((pts) => {
    const fine = [pts[0]];
    for (let j = 1; j < pts.length; j++) {
      const [ax, az] = pts[j - 1], [bx, bz] = pts[j];
      const n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / 3));
      for (let s = 1; s <= n; s++) fine.push([ax + ((bx - ax) * s) / n, az + ((bz - az) * s) / n]);
    }
    return fine;
  });
}

/** The village's streets end to end at 50, 70, 90 and 120 km/h, nothing in the way: where the car leaves the ground. */
async function streets() {
  const names = (o.streets === true ? 'Kapellenhoek,Briel,Smetlededorp,Molenhoek,Schildekensstraat,Kerkhofstraat,Oordegemkouter' : o.streets).split(',');
  const speeds = o.speeds.split(',').map(Number);
  for (const name of names) {
    const paths = streetPaths(name);
    for (const kmh of speeds) {
      for (const [n, path] of paths.entries()) {
        if (o.piece !== '' && Number(o.piece) !== n) continue;
        const r = await b.evaluate(`__air.street(${JSON.stringify(path)}, ${kmh}, ${o.trace ? JSON.stringify(o.trace.split(',').map(Number)) : 'null'})`);
        keep({ street: name, piece: n, kmh, lengthM: r.lengthM, atSpeedM: r.fastM, topKmh: r.topKmh, arrived: r.done, offM: r.offM, frames: r.frames, airFrames: r.air, flights: r.flights });
        // --trace m0,m1: every frame from m0 to m1 m along the line (m, x, z, the car's height, the ground's, its speed up, in the air, km/h, the block).
        for (const row of r.rows) console.log('  ', JSON.stringify(row));
      }
    }
  }
}

/** From `before` m ahead of (x, z) along (dx, dz), rolling at kmh for s seconds. */
async function pass(name, at, kmh, s, picture = 0) {
  const n = Math.hypot(at.dx, at.dz);
  const [dx, dz] = [at.dx / n, at.dz / n];
  const where = await b.evaluate(`__air.put(${at.x - dx * at.before}, ${at.z - dz * at.before}, ${dx}, ${dz})`);
  await b.sleep(800);
  const job = b.evaluate(`__air.run(${JSON.stringify({ kmh, s, picture })})`);
  if (picture) {
    // Held at the top of its flight: the picture from beside it, then on.
    for (let i = 0; i < 200 && !(await b.evaluate('__air.paused')); i++) await b.sleep(50);
    if (await b.evaluate('__air.paused')) {
      await b.sleep(400);
      await shot(`${name}-midair-side`);
      await b.evaluate('__air.paused = false');
    }
  }
  const r = await job;
  keep({
    run: name, kmh, startY: r2(where.y), mat: where.mat, mostOverGroundM: r2(r.most), airS: r2(r.airTime), airFrames: r.airFrames, flewM: r2(r.flewM),
    landingMs: r.landings.map(r2), vyDown: r2(-r.vyLeast), vyUp: r2(r.vyMost), kmhTakeOff: r2(r.kmhOff), kmhLanded: r2(r.kmhOn), wentM: r2(r.wentM), turnedDeg: r2(r.turnedDeg), picture: r.picture,
  });
  return r;
}

try {
  console.log('Browser PID:', b.pid);
  await setUp();
  await b.evaluate('__air.open(true)', false);
  if (o.streets) await streets();
  else await places();
  await b.evaluate('__air.open(false)', false);
  if (o.json) writeFileSync(o.json, JSON.stringify(results, null, 1));
  console.log('Browser errors:', JSON.stringify(b.logs.filter((l) => /^(error|exception)/.test(l)).slice(-10)));
} finally {
  b.close();
}

/** The plateau, the ditch and the straight road in the fields. */
async function places() {
  // Over the plateau, along its centre line from 40 m before it.
  const pl = { x: plateau.x0, z: plateau.z0, dx: plateau.x1 - plateau.x0, dz: plateau.z1 - plateau.z0, before: 40 };
  const len = Math.hypot(pl.dx, pl.dz);
  console.log('plateau', JSON.stringify({ from: [plateau.x0, plateau.z0], lengthM: r2(len), profileEvery2m: await b.evaluate(`__air.profile(${pl.x}, ${pl.z}, ${pl.dx / len}, ${pl.dz / len}, -4, ${len + 4}, 2)`) }));
  for (const kmh of [30, 50, 90]) await pass(`plateau-${kmh}`, pl, kmh, (40 + len + 20) / (kmh / 3.6));
  // Off a ditch's bank: across the ditch whose bank drops furthest, square to its rim, from 40 m out.
  let best = null;
  for (const d of ditches) {
    for (let i = 0; i < d.rim.length; i += Math.ceil(d.rim.length / 12)) {
      const [rx, rz] = d.rim[i];
      const [bx, bz] = d.bottom[i];
      const n = Math.hypot(bx - rx, bz - rz) || 1;
      const [dx, dz] = [(bx - rx) / n, (bz - rz) / n];
      const prof = await b.evaluate(`__air.profile(${rx}, ${rz}, ${dx}, ${dz}, -12, 4, 0.5)`);
      const run = prof.slice(0, 22); // 12 m to 1.5 m before the rim
      const flat = Math.max(...run) - Math.min(...run); // the run-up must be even
      const drop = prof[22] - Math.min(...prof.slice(22, 30)); // down the bank, within 4 m
      if (flat < 0.3 && (!best || drop > best.drop)) best = { x: rx, z: rz, dx, dz, drop, flat, prof };
    }
  }
  if (best) {
    console.log('ditch', JSON.stringify({ rim: [r2(best.x), r2(best.z)], dropM: r2(best.drop), runUpRangeM: r2(best.flat), profileEveryHalfM: best.prof }));
    await pass('ditch-50', { ...best, before: 40 }, 50, 4.5, 0.25);
    await pass('ditch-50-again', { ...best, before: 40 }, 50, 4.5);
  } else keep({ run: 'ditch-50', found: false });
  // The straight road out in the fields (tools/dev/drive.mjs), the real ground: it must stay on it.
  const road = { x: 636.6, z: 142.6, dx: 668.9 - 636.6, dz: 355.8 - 142.6, before: 0 };
  for (const kmh of [50, 100, 150, 200]) await pass(`road-${kmh}`, road, kmh, Math.min(6, 190 / (kmh / 3.6)));
}

/** Two players: Alice drives over a ditch's bank, Bob rides along and sees it from the server's states. */
async function together() {
  localOnly(o.url, '--url'); // two players join and drive: a throwaway server on this computer only
  const [pa, pb] = o.ports.split(',').map(Number);
  let failed = 0;
  const ok = (name, pass, extra = '') => {
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} ${extra}`);
    if (!pass) failed++;
  };
  const player = async (port, name) => {
    const p = await launch({ port, width: 800, height: 450 });
    console.log(name, 'browser PID:', p.pid);
    await p.send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('briel.graphics','low');localStorage.setItem('briel.lang','en');localStorage.setItem('briel.spawn','house');localStorage.setItem('briel.playMode','explore');localStorage.setItem('briel.feedback','later');" });
    const url = new URL(o.url);
    url.searchParams.set('nobake', '');
    await p.send('Page.navigate', { url: url.href });
    await p.waitFor("!!document.querySelector('#choose-kbm')");
    await p.sleep(6000); // the dev build attaches the start screen's handlers late
    await p.evaluate(`(() => {
      const n = document.querySelector('#nick'); n.value = '${name}'; n.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-mp=multi]').click();
      const age = document.querySelector('#mp-age'); if (!age.checked) age.click();
      document.querySelector('#choose-kbm').click();
    })()`, false);
    await p.waitFor('!!window.briel', 60000);
    await p.waitFor("(() => { const s = document.getElementById('start-panel'); if (!s || s.offsetParent === null) return true; const c = getComputedStyle(s); return c.visibility === 'hidden' || Number(c.opacity) < 0.05; })()", 240000);
    await p.waitFor('briel.cars.slice(0,2).every(c=>c.wheels.length===4)');
    await p.evaluate("document.getElementById('cc-close')?.click()", false);
    return p;
  };
  const tag = Math.random().toString(36).slice(2, 6); // names stay with whoever joined with them for the day
  const alice = await player(pa, `Alice${tag}`);
  const bob = await player(pb, `Bob${tag}`);
  try {
    // Alice at the wheel (the server moves her no faster than a run: ask until it lets her in), Bob beside her.
    await alice.evaluate(`(() => { const car = briel.cars.find((c) => c.id === 'tesla'); const at = car.exitSpot(); briel.player.place(at.x, at.z, car.y, 0, 0); })()`, false);
    for (let i = 0; i < 40 && !(await alice.evaluate('briel.driving()')); i++) {
      await alice.evaluate('briel.getIn()', false);
      await alice.sleep(1500);
    }
    ok('Alice drives the Tesla', await alice.evaluate('briel.driving()'));
    await alice.evaluate(`(() => {
      const car = briel.currentCar(), real = car.world, drive = car.drive;
      window.__drive = { throttle: 0, brake: 0, steer: 0, handbrake: true };
      car.drive = function (dt, input, others) { return drive.call(this, dt, { ...input, ...window.__drive }, others); };
      // Nothing in its way (fences, hedges, trees): the server checks none of them; the ground is the real one.
      const put = { boxFree: () => true, boxInBounds: () => true, touching: () => null };
      car.world = new Proxy(real, { get: (t, k) => put[k] || (typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
      car.trees = [];
    })()`, false);
    for (let i = 0; i < 40 && !(await bob.evaluate('briel.askState().riding')); i++) {
      await bob.evaluate(`(() => { const car = briel.cars.find((c) => c.id === 'tesla'); const at = car.exitSpot(true); briel.player.place(at.x, at.z, car.y, 0, 0); briel.getIn(); })()`, false);
      await bob.sleep(1500);
    }
    ok('Bob rides along', await bob.evaluate('briel.askState().riding'));
    // The ditch or pond nearest the house with a bank that drops at least half a metre after an even run-up.
    const dips = [...JSON.parse(readFileSync(new URL('../../web/src/data/village.json', import.meta.url), 'utf8')).dips, ...JSON.parse(readFileSync(new URL('../../web/src/data/house_shell.json', import.meta.url), 'utf8')).dips];
    const car0 = await alice.evaluate('({ x: briel.currentCar().x, z: briel.currentCar().z })');
    const near = dips.filter((d) => d.depth >= 0.6).map((d) => ({ d, far: Math.hypot(d.rim[0][0] - car0.x, d.rim[0][1] - car0.z) })).filter((n) => n.far < 300).sort((a, b) => a.far - b.far);
    const jump = await alice.evaluate(`(() => {
      const real = briel.world;
      const profile = (x, z, dx, dz) => { const out = []; let y = real.groundAt(x - dx * 12, z - dz * 12, 50, 0.3).y; for (let t = -12; t <= 4; t += 0.5) { y = real.groundAt(x + dx * t, z + dz * t, y, 0.3).y; out.push(y); } return out; };
      for (const { d } of ${JSON.stringify(near)}) {
        for (let i = 0; i < d.rim.length; i += Math.ceil(d.rim.length / 12)) {
          const [rx, rz] = d.rim[i], [bx, bz] = d.bottom[i];
          const n = Math.hypot(bx - rx, bz - rz) || 1, dx = (bx - rx) / n, dz = (bz - rz) / n;
          const p = profile(rx, rz, dx, dz), run = p.slice(0, 22);
          if (Math.max(...run) - Math.min(...run) < 0.3 && p[22] - Math.min(...p.slice(22, 30)) > 0.5) return { x: rx, z: rz, dx, dz, drop: p[22] - Math.min(...p.slice(22, 30)) };
        }
      }
      return null;
    })()`);
    ok('a ditch near the house', !!jump, JSON.stringify(jump));
    if (!jump) return;
    // To 40 m before its rim in hops the server allows (each within what a car covers in half a second).
    const start = { x: jump.x - jump.dx * 40, z: jump.z - jump.dz * 40 };
    const yaw = Math.atan2(-jump.dx, -jump.dz);
    for (let i = 0; i < 40; i++) {
      const p = await alice.evaluate('({ x: briel.currentCar().x, z: briel.currentCar().z })');
      const d = Math.hypot(start.x - p.x, start.z - p.z);
      const k = Math.min(1, 15 / Math.max(d, 1e-6));
      await alice.evaluate(`(() => { const car = briel.currentCar(), x = ${p.x + (start.x - p.x) * k}, z = ${p.z + (start.z - p.z) * k}; car.place(x, briel.world.groundAt(x, z, car.y + 1, 0.3).y, z, ${yaw}); })()`, false);
      await alice.sleep(1200);
      if (k === 1) break;
    }
    await alice.sleep(2500);
    // Both pages' view of the car every frame: Alice's own, Bob's from the server's states.
    const watch = `(() => {
      const car = briel.cars.find((c) => c.id === 'tesla');
      window.__seen = []; window.__landed = [];
      const landed = car.landed;
      car.landed = function (speed, ...rest) { window.__landed.push(speed); return landed.call(this, speed, ...rest); };
      const look = () => { if (window.__seen) { const g = briel.world.groundAt(car.x, car.z, car.y, 0.3).y; window.__seen.push({ t: performance.now(), x: car.x, y: car.y, z: car.z, over: car.y - g, air: car.air, flying: car.flying }); } requestAnimationFrame(look); };
      requestAnimationFrame(look);
    })()`;
    await alice.evaluate(watch, false);
    await bob.evaluate(watch, false);
    // At 50 km/h over the bank, the throttle holding the speed, for 4 s; then the handbrake.
    await alice.evaluate(`(async () => {
      const car = briel.currentCar();
      const v = 50 / 3.6, fx = -Math.sin(car.yaw), fz = -Math.cos(car.yaw);
      Object.assign(car, { vx: fx * v, vz: fz * v, speed: v, lastSpeed: v });
      const t0 = performance.now();
      while (performance.now() - t0 < 4000) {
        window.__drive = { throttle: Math.hypot(car.vx, car.vz) < v ? 1 : 0, brake: 0, steer: 0, handbrake: false };
        await new Promise((r) => requestAnimationFrame(r));
      }
      window.__drive = { throttle: 0, brake: 0, steer: 0, handbrake: true };
    })()`);
    await alice.sleep(2500); // it stands; the last states arrive and are drawn a little behind
    const mine = await alice.evaluate('window.__seen.splice(0)');
    const seen = await bob.evaluate('window.__seen.splice(0)');
    const landedA = await alice.evaluate('window.__landed');
    const landedB = await bob.evaluate('window.__landed');
    if (o.out) {
      mkdirSync(o.out, { recursive: true });
      await bob.screenshot(join(o.out, 'mp-bob-after.png'));
    }
    const sum = (f, key) => ({ most: Math.max(...f.map((s) => s.over)), frames: f.filter((s) => s[key]).length, seconds: f.filter((s) => s[key]).length && (f.findLast((s) => s[key]).t - f.find((s) => s[key]).t) / 1000 });
    const a = sum(mine, 'air');
    const bb = sum(seen, 'flying');
    const [endA, endB] = [mine[mine.length - 1], seen[seen.length - 1]];
    console.log(JSON.stringify({ ditch: jump, alice: { ...a, landings: landedA }, bob: { ...bb, landings: landedB }, endA, endB }));
    ok('Alice flies off the bank', a.frames > 5 && a.most > 0.3, `${a.most.toFixed(2)} m over the ground, ${a.frames} frames`);
    ok('Bob sees the car leave the ground', bb.frames > 3 && bb.most > 0.3, `${bb.most.toFixed(2)} m over the ground at most, drawn flying ${bb.frames} frames`);
    ok('about as high as Alice flew it', Math.abs(bb.most - a.most) < 0.25, `${bb.most.toFixed(2)} against ${a.most.toFixed(2)} m`);
    ok('Bob sees it land', landedB.length >= 1, `at ${landedB.map((s) => s.toFixed(2)).join(', ')} m/s (Alice ${landedA.map((s) => s.toFixed(2)).join(', ')})`);
    ok('the server took every state: Bob sees it end where Alice has it', Math.hypot(endA.x - endB.x, endA.z - endB.z) < 0.3 && Math.abs(endA.y - endB.y) < 0.05, `${Math.hypot(endA.x - endB.x, endA.z - endB.z).toFixed(3)} m apart, heights ${endA.y.toFixed(2)} and ${endB.y.toFixed(2)}`);
    for (const [who, p] of [['Alice', alice], ['Bob', bob]]) ok(`${who}: no errors on the page`, !p.logs.some((l) => /^(error|exception)/.test(l)), JSON.stringify(p.logs.filter((l) => /^(error|exception)/.test(l)).slice(-3)));
  } finally {
    alice.close();
    bob.close();
    process.exitCode = failed ? 1 : 0;
  }
}
