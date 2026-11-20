// The Brook Spirit's fight on the server (server/brookSpirit.mjs) against a throwaway game server (a build of this
// branch on this computer). Three guests take the trip to Moeyweedreef and walk down the lane within the server's
// movement limits; standing on the lane they do not wake it. Two of them step into the wood and fight it through to
// the end with honest hits (the rifle, the heart when it is open, the lights when its shell is shut), moving out of its
// attacks as the `sp` messages show them, and are told it is beaten; it gathers again after the return time. The third
// sends forged hits while the two hold their fire: a gun it does not hold, the bazooka, the launcher, a burst faster
// than its gun fires, hits on the shut heart, hits from past the leash; each is refused without effect on its health.
//
// A whole fight at the real health takes minutes: start the server with the test-only settings (server/brookSpirit.mjs
// testTuning, never read in production) for a short one, from web/ after `npm run build`:
//
//   ADMIN_PASSWORD=... SPIRIT_TEST_SCALE=0.2 SPIRIT_TEST_BACK_S=20 PORT=8410 node server.mjs
//   ADMIN_PASSWORD=... node tools/dev/spirit_ws_check.mjs --api http://localhost:8410 [--back 20]
//
// One line per check; exit 1 when any fails.
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { readFileSync } from 'node:fs';
import { localOnly, options } from './cdp.mjs';
import { readSpirit } from '../../web/shared/brookSpirit.mjs';
import { makeTerrain } from '../../web/shared/terrain.mjs';

const o = options({ api: 'http://localhost:8410', back: '20', limit: '420' });
localOnly(o.api); // it logs in as the admin: a throwaway server on this computer only
const password = process.env.ADMIN_PASSWORD;
if (!password) throw new Error('ADMIN_PASSWORD is not set');
const read = (path) => JSON.parse(readFileSync(new URL(`../../web/${path}`, import.meta.url), 'utf8'));
const D = read('shared/brookSpirit.json');
const G = D.grove;
const house = read('src/data/house_shell.json');
const terrain = makeTerrain(read('shared/terrain.json'));
const ground = (x, z) => house.ground + terrain.height(x, z);
const PLACE = read('shared/places.json').places.find((p) => p.id === 'street:moeyweedreef');
const host = new URL(o.api).host;
const SPEED = 3.4; // m/s: under the server's running pace
const STEP_MS = 100;

let failed = 0;
const ok = (name, pass, extra = '') => {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} ${extra}`);
  if (!pass) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (method, path, body, cookie = '') => {
  const r = await fetch(o.api + path, { method, headers: { 'Content-Type': 'application/json', Origin: o.api, Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  return { r, data: await r.json().catch(() => null) };
};
const cookieOf = (r) => r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const adminCookie = cookieOf((await call('POST', '/api/login', { username: 'admin', password })).r);
const act = async (b) => call('POST', '/api/host', b, adminCookie);
/** Waits until `pred()` or `ms` passed; whether it came. */
const until = async (pred, ms, every = 100) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(every);
  }
  return pred();
};

const connect = async (name, cookie) => {
  const log = [];
  const ws = new WebSocket(`ws://${host}/ws?v=2`, { headers: { Cookie: cookie, Origin: o.api } });
  const c = {
    name, ws, log, at: null, w: 'rifle', view: null, dead: false, downs: 0, backs: [], hold: false, goal: null, dodge: null, tellKey: '', nextShot: 0,
    send: (m) => ws.readyState === 1 && ws.send(JSON.stringify(m)),
    of: (t) => log.filter((m) => m.t === t),
  };
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    log.push(m);
    if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', n: m.n }));
    if (m.t === 'welcome' && m.spirit) c.view = readSpirit(m.spirit, Date.now()) ?? c.view;
    if (m.t === 'sp') c.view = readSpirit(m, Date.now()) ?? c.view;
    if (m.t === 'kill' && m.victim === name) [c.dead, c.downs] = [true, c.downs + 1];
    if (m.t === 'respawn' && m.name === name && typeof m.x === 'number') {
      c.at = { x: m.x, y: typeof m.y === 'number' ? m.y : ground(m.x, m.z), z: m.z };
      c.backs.push({ x: m.x, z: m.z });
      c.dead = false;
      c.dodge = null;
    }
  });
  await new Promise((res) => (ws.on('open', res), ws.on('error', res)));
  await sleep(400);
  return c;
};
const guest = async (name) => {
  await call('POST', '/api/lockouts', {}, adminCookie);
  const { r, data } = await call('POST', '/api/join', { name, age: true });
  if (!r.ok) console.log(`     ${name} could not join: ${r.status} ${data?.code ?? ''}`);
  return connect(name, cookieOf(r));
};
/** Facing the spirit while it is there, as a player who fights it does (a watch view behind them shows it), else ahead. */
const state = (c, p) => {
  const v = c.view;
  const yaw = v && v.mode !== 'gone' && Math.hypot(v.x - p.x, v.z - p.z) > 0.1 ? Math.atan2(-(v.x - p.x), -(v.z - p.z)) : 0;
  c.at = { ...p };
  c.send({ t: 'state', x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), yaw: +yaw.toFixed(3), pitch: 0, armed: true, w: c.w });
};
/** One step of at most SPEED m/s towards (x, z), on the relief. True when there. */
const stepTo = (c, x, z) => {
  const dx = x - c.at.x;
  const dz = z - c.at.z;
  const d = Math.hypot(dx, dz);
  const s = Math.min(d, (SPEED * STEP_MS) / 1000);
  const nx = d > 1e-6 ? c.at.x + (dx / d) * s : c.at.x;
  const nz = d > 1e-6 ? c.at.z + (dz / d) * s : c.at.z;
  state(c, { x: nx, y: ground(nx, nz), z: nz });
  return d - s < 0.05;
};
const walk = async (c, x, z) => {
  while (!stepTo(c, x, z)) await sleep(STEP_MS);
};
/** (x, z) kept within `r` of the grove's middle. */
const inside = (x, z, r = G.leash - 4) => {
  const d = Math.hypot(x - G.x, z - G.z);
  return d <= r ? { x, z } : { x: G.x + ((x - G.x) / d) * r, z: G.z + ((z - G.z) / d) * r };
};
/** Its health now as its pages have it (0 to 1). */
const hpOf = (c) => c.view?.hp ?? NaN;
const heartOpen = (v) => !!v && v.lights === 0 && ((v.mode === 'fight' && (v.act === 'open' || v.act === 'stun')) || (v.mode === 'mend' && !['sink', 'under', 'rise'].includes(v.act)));

/**
 * One fighter's tenth of a second: out of a tell's way when it is in it (the `sp` act, where it lands: tx, tz), out of a
 * pool, else 13 m from the spirit inside the leash; and a hit at the open heart or the first lit light at its gun's pace.
 */
const fightStep = (c, now) => {
  if (c.dead || !c.at) return;
  const v = c.view;
  if (!v) return;
  const a = D.attacks;
  const key = `${v.act}|${Math.round((v.at - (actMs(v) - v.ms)) / 400)}`; // when the tell began, near enough
  if (['sweep', 'bolt', 'pool'].includes(v.act) && key !== c.tellKey) {
    c.tellKey = key;
    const me = c.at;
    if (v.act === 'sweep') {
      const ex = v.tx - v.x;
      const ez = v.tz - v.z;
      const len = Math.hypot(ex, ez) || 1;
      const u = ((me.x - v.x) * ex + (me.z - v.z) * ez) / len;
      const side = ((me.x - v.x) * ez - (me.z - v.z) * ex) / len;
      if (u > -1 && u < len + 1 && Math.abs(side) < a.sweep.half + 1.5) {
        const sg = side >= 0 ? 1 : -1;
        c.dodge = { ...inside(me.x + (ez / len) * 3.2 * sg, me.z - (ex / len) * 3.2 * sg), until: now + 3000 };
      }
    } else {
      const r = v.act === 'bolt' ? a.bolt.radius : a.pools.radius;
      if (Math.hypot(me.x - v.tx, me.z - v.tz) < r + 1.5) {
        const ang = Math.atan2(me.x - v.x, me.z - v.z) + Math.PI / 2;
        c.dodge = { ...inside(me.x + Math.sin(ang) * (r + 2.5), me.z + Math.cos(ang) * (r + 2.5)), until: now + 4000 };
      }
    }
  }
  if (c.dodge && now > c.dodge.until) c.dodge = null;
  let goal = c.dodge;
  if (!goal) {
    const pool = v.pools.find((p) => Math.hypot(c.at.x - p.x, c.at.z - p.z) < a.pools.radius + 1);
    if (pool) {
      const ang = Math.atan2(c.at.x - pool.x, c.at.z - pool.z);
      goal = inside(pool.x + Math.sin(ang) * (a.pools.radius + 2), pool.z + Math.cos(ang) * (a.pools.radius + 2));
    } else if (c.goal) goal = c.goal;
    else if (v.mode === 'fight' || v.mode === 'mend') {
      const ang = Math.atan2(c.at.x - v.x, c.at.z - v.z);
      goal = inside(v.x + Math.sin(ang) * 13, v.z + Math.cos(ang) * 13);
    }
  }
  if (goal && stepTo(c, goal.x, goal.z) && goal === c.dodge) c.dodge = null;
  if (!goal) state(c, c.at);
  if (c.manual || now < c.nextShot) return;
  let part = null;
  if (heartOpen(v)) part = 0;
  else if (v.lights) part = Math.log2(v.lights & -v.lights) + 1;
  if (part === null || (part === 0 && c.hold)) return; // holding fire at the heart; the lights still go out
  c.nextShot = now + 110;
  c.send({ t: 'sphit', w: c.w, h: [[part, 1]] });
};
/** ms the act of `v` lasts in all (as shared/brookSpirit.mjs actLength), for telling one tell from the next. */
const actMs = (v) => {
  const p = Math.min(3, Math.max(1, v.phase)) - 1;
  const a = D.attacks;
  return 1000 * ({ sweep: a.sweep.tell[p], bolt: a.bolt.tell[p], pool: a.pools.tell }[v.act] ?? 0);
};

// ---- Three guests, by the trip to Moeyweedreef and down the lane.
await call('POST', '/api/lockouts', {}, adminCookie);
await act({ op: 'lock', on: false });
await act({ op: 'limit', max: 32 });
const run = Math.random().toString(36).slice(2, 6);
const [a, b, f] = await Promise.all(['a', 'b', 'f'].map((k) => guest(`sp${k}${run}`)));
const all = [a, b, f];
ok('three guests are in', all.every((c) => c.of('welcome').length));
ok('the welcome carries the spirit, asleep', all.every((c) => c.view?.mode === 'asleep'), JSON.stringify(a.of('welcome')[0]?.spirit));
for (const c of all) c.send({ t: 'travel', to: PLACE.id, via: 'chat' });
ok('the trip to Moeyweedreef', await until(() => all.every((c) => c.of('travel').some((m) => m.name === c.name && m.ok)), 5000));
for (const c of all) c.at = { x: PLACE.x, y: ground(PLACE.x, PLACE.z), z: PLACE.z };
f.w = 'pistol';
f.manual = true; // the third shoots only the forged hits below
a.hold = b.hold = true; // the two keep their fire from the heart until those are done
await Promise.all(all.map(async (c, i) => {
  await walk(c, D.wake.x - i, D.wake.z);
  await walk(c, -46 - i * 0.8, 480 + i);
}));
await sleep(2000);
ok('on the lane, armed, nobody wakes it', all.every((c) => c.view?.mode === 'asleep') && !all.some((c) => c.of('sp').length), JSON.stringify(a.view));

// ---- Into the wood: it wakes.
let ticking = true;
const loop = (async () => {
  while (ticking) {
    const now = Date.now();
    for (const c of all) fightStep(c, now);
    await sleep(STEP_MS);
  }
})();
for (const c of all) c.goal = inside(G.x + 11 + all.indexOf(c), G.z - 3 + 3 * all.indexOf(c), G.wakeR - 3);
ok('it wakes when they step into the wood', await until(() => all.some((c) => c.view?.mode === 'fight'), 20_000), JSON.stringify(a.view));
for (const c of all) c.goal = null;

// ---- Forged hits, at its first open heart, while the two hold their fire.
const opened = await until(() => heartOpen(f.view), 60_000, 20);
ok('its heart opens', opened);
await sleep(250);
const h0 = hpOf(f);
for (const w of ['sniper', 'bazooka', 'launcher', 'rifle']) f.send({ t: 'sphit', w, h: [[0, 1]] }); // carried but not held, never carried (twice), not held
await sleep(700);
ok('a gun it does not hold, the bazooka, the launcher: refused', hpOf(f) === h0, `${h0} -> ${hpOf(f)}`);
f.send({ t: 'sphit', w: 'pistol', h: [[0, 1]] });
await sleep(450);
const h1 = hpOf(f);
const one = h0 - h1;
for (let k = 0; k < 10; k++) f.send({ t: 'sphit', w: 'pistol', h: [[0, 1]] });
await sleep(450);
const ten = h1 - hpOf(f);
ok('one honest pistol hit counts', one > 0, `${(one * 1000).toFixed(0)} of 1000`);
ok('ten at once count as one (the gun\'s pace)', one > 0 && Math.abs(ten - one) <= 0.0015, `${(ten * 1000).toFixed(0)} against ${(one * 1000).toFixed(0)}`);
ok('the window was open all along', heartOpen(f.view), `${f.view?.mode} ${f.view?.act}`);
await until(() => f.view && !heartOpen(f.view) && f.view.mode === 'fight', 15_000, 20);
await sleep(400);
const h2 = hpOf(f);
for (let k = 0; k < 3; k++) {
  if (!heartOpen(f.view)) f.send({ t: 'sphit', w: 'pistol', h: [[0, 1]] });
  await sleep(250);
}
await sleep(300);
ok('hits on the shut heart: refused', hpOf(f) === h2, `${h2} -> ${hpOf(f)}, ${f.view?.act}`);
// Past the leash: out of the wood (the two fight on meanwhile, so it does not go mending), then at the next open heart
// in the fight, the two holding their fire again from before it opens.
a.hold = b.hold = false;
f.goal = inside(G.x + 40, G.z, 40);
await until(() => Math.hypot(f.at.x - G.x, f.at.z - G.z) > G.leash + 3, 30_000);
await until(() => f.view && !heartOpen(f.view) && f.view.mode === 'fight', 30_000, 20);
a.hold = b.hold = true;
await until(() => heartOpen(f.view) && f.view.mode === 'fight', 60_000, 20);
await sleep(250);
const h3 = hpOf(f);
for (let k = 0; k < 3; k++) {
  f.send({ t: 'sphit', w: 'pistol', h: [[0, 1]] });
  await sleep(250);
}
await sleep(300);
ok('hits from past the leash: refused', hpOf(f) === h3 && heartOpen(f.view), `${h3} -> ${hpOf(f)}`);
ok('and the shooter is told why', f.of('system').some((m) => m.code === 'spFar'), JSON.stringify(f.of('system').map((m) => m.code)));

// ---- The two fight it through to the end.
a.hold = b.hold = false;
const t0 = Date.now();
const beaten = await until(() => [a, b].every((c) => c.of('system').some((m) => m.code === 'spBeaten')), Number(o.limit) * 1000, 200);
ok('they beat it, and both are told', beaten, `${((Date.now() - t0) / 1000).toFixed(0)} s, downed ${a.downs} and ${b.downs} times`);
const line = a.of('system').find((m) => m.code === 'spBeaten');
ok('the line names the fighters, as data, at most 8', !!line && Array.isArray(line.args?.names) && line.args.names.length >= 1 && line.args.names.length <= 8 && line.args.names.every((n) => n === a.name || n === b.name || n === f.name), JSON.stringify(line?.args));
ok('`spe` beaten to the pages near', [a, b].every((c) => c.of('spe').some((m) => m.e === 'beaten')));
const spe = (e) => a.of('spe').filter((m) => m.e === e).length;
ok('both shells: lights lit, shot out, two bursts', spe('light') === D.shell.lights.reduce((x, y) => x + y, 0) && spe('burst') === 2, `lights ${spe('light')}, bursts ${spe('burst')}, caps ${spe('cap')}, bolts ${spe('bolt')}, sweeps ${spe('sweep')}`);
ok('the one past the leash is told too (to all)', f.of('system').some((m) => m.code === 'spBeaten'));
const backs = [a, b].flatMap((c) => c.backs);
ok('a fighter it downed comes back at the wake spot', backs.every((p) => Math.hypot(p.x - D.wake.x, p.z - D.wake.z) < 0.01), backs.length ? JSON.stringify(backs) : 'nobody was downed');
ok('gone after coming apart', await until(() => a.view?.mode === 'gone', 6000), a.view?.mode);
const back = Number(o.back);
ok(`back after its return time (${back} s)`, await until(() => a.view?.mode === 'asleep' || a.view?.mode === 'fight', (back + 8) * 1000), a.view?.mode);

ticking = false;
await loop;
for (const c of all) c.ws.close();
await sleep(300);
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
