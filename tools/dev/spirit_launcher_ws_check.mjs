// The Brook Spirit's grenade launcher on the server (server/spiritLauncher.mjs) against a throwaway game server (a build
// of this branch on this computer). Two guests beat the spirit with honest hits (as tools/dev/spirit_ws_check.mjs does
// it); a third, who never fought it, waits on the lane. The launcher drops; the third stands on it and gets nothing in
// the first 20 s, then takes it. It fires six grenades and the seventh is refused; meanwhile forged messages are
// refused: `gl` from a guest who does not hold it, a second shot within the reload, a `boom` far beyond what its shot
// reaches, a `hit` with the launcher; the holder's connection drops and comes back within 15 s and keeps it, with its
// count and its reload clock.
//
// Start the server with the test-only settings (server/brookSpirit.mjs testTuning, never read in production) for a
// short fight, from web/ after `npm run build`:
//
//   ADMIN_PASSWORD=... SPIRIT_TEST_SCALE=0.2 SPIRIT_TEST_BACK_S=300 PORT=8610 node server.mjs
//   ADMIN_PASSWORD=... node tools/dev/spirit_launcher_ws_check.mjs --api http://localhost:8610
//
// One line per check; exit 1 when any fails.
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { readFileSync } from 'node:fs';
import { localOnly, options } from './cdp.mjs';
import { readSpirit } from '../../web/shared/brookSpirit.mjs';
import { makeTerrain } from '../../web/shared/terrain.mjs';

const o = options({ api: 'http://localhost:8610', limit: '420' });
localOnly(o.api); // it logs in as the admin: a throwaway server on this computer only
const password = process.env.ADMIN_PASSWORD;
if (!password) throw new Error('ADMIN_PASSWORD is not set');
const read = (path) => JSON.parse(readFileSync(new URL(`../../web/${path}`, import.meta.url), 'utf8'));
const D = read('shared/brookSpirit.json');
const LOB = read('shared/weapons.json').launcher.lob;
const G = D.grove;
const L = D.launcher;
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
const until = async (pred, ms, every = 100) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(every);
  }
  return pred();
};

/** A guest's socket (again, with `c` given: the same session back on a new connection). */
const connect = async (name, cookie, c = null) => {
  const ws = new WebSocket(`ws://${host}/ws?v=2`, { headers: { Cookie: cookie, Origin: o.api } });
  c ??= { name, cookie, log: [], at: null, w: 'rifle', view: null, dead: false, goal: null, dodge: null, tellKey: '', nextShot: 0, manual: false };
  Object.assign(c, {
    ws,
    send: (m) => ws.readyState === 1 && ws.send(JSON.stringify(m)),
    of: (t, e) => c.log.filter((m) => m.t === t && (e === undefined || m.e === e)),
  });
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    c.log.push({ ...m, got: Date.now() });
    if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', n: m.n }));
    if (m.t === 'welcome' && m.spirit) c.view = readSpirit(m.spirit, Date.now()) ?? c.view;
    if (m.t === 'sp') c.view = readSpirit(m, Date.now()) ?? c.view;
    if (m.t === 'kill' && m.victim === name) c.dead = true;
    if (m.t === 'respawn' && m.name === name && typeof m.x === 'number') {
      c.at = { x: m.x, y: typeof m.y === 'number' ? m.y : ground(m.x, m.z), z: m.z };
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
const state = (c, p) => {
  const v = c.view;
  const yaw = v && v.mode !== 'gone' && Math.hypot(v.x - p.x, v.z - p.z) > 0.1 ? Math.atan2(-(v.x - p.x), -(v.z - p.z)) : 0;
  c.at = { ...p };
  c.send({ t: 'state', x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), yaw: +yaw.toFixed(3), pitch: 0, armed: true, w: c.w });
};
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
const inside = (x, z, r = G.leash - 4) => {
  const d = Math.hypot(x - G.x, z - G.z);
  return d <= r ? { x, z } : { x: G.x + ((x - G.x) / d) * r, z: G.z + ((z - G.z) / d) * r };
};
const heartOpen = (v) => !!v && v.lights === 0 && ((v.mode === 'fight' && (v.act === 'open' || v.act === 'stun')) || (v.mode === 'mend' && !['sink', 'under', 'rise'].includes(v.act)));
const actMs = (v) => {
  const p = Math.min(3, Math.max(1, v.phase)) - 1;
  const a = D.attacks;
  return 1000 * ({ sweep: a.sweep.tell[p], bolt: a.bolt.tell[p], pool: a.pools.tell }[v.act] ?? 0);
};
/** One tenth of a second of a guest: out of the tells' way, to its goal or 13 m from the spirit, and (fighters) a hit. */
const fightStep = (c, now) => {
  if (c.dead || !c.at || c.ws.readyState !== 1) return;
  const v = c.view;
  if (!v) return state(c, c.at);
  const a = D.attacks;
  const key = `${v.act}|${Math.round((v.at - (actMs(v) - v.ms)) / 400)}`;
  if (!c.goal && ['sweep', 'bolt', 'pool'].includes(v.act) && key !== c.tellKey) {
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
  let goal = c.goal ?? c.dodge;
  if (!goal && (v.mode === 'fight' || v.mode === 'mend')) {
    const pool = v.pools.find((p) => Math.hypot(c.at.x - p.x, c.at.z - p.z) < a.pools.radius + 1);
    if (pool) {
      const ang = Math.atan2(c.at.x - pool.x, c.at.z - pool.z);
      goal = inside(pool.x + Math.sin(ang) * (a.pools.radius + 2), pool.z + Math.cos(ang) * (a.pools.radius + 2));
    } else {
      const ang = Math.atan2(c.at.x - v.x, c.at.z - v.z);
      goal = inside(v.x + Math.sin(ang) * 13, v.z + Math.cos(ang) * 13);
    }
  }
  if (goal) {
    if (stepTo(c, goal.x, goal.z) && goal === c.dodge) c.dodge = null;
  } else state(c, c.at);
  if (c.manual || now < c.nextShot) return;
  let part = null;
  if (heartOpen(v)) part = 0;
  else if (v.lights) part = Math.log2(v.lights & -v.lights) + 1;
  if (part === null) return;
  c.nextShot = now + 110;
  c.send({ t: 'sphit', w: c.w, h: [[part, 1]] });
};

// ---- Three guests by the trip to Moeyweedreef; two fight, the third waits on the lane past the leash.
await call('POST', '/api/lockouts', {}, adminCookie);
await act({ op: 'lock', on: false });
await act({ op: 'limit', max: 32 });
const run = Math.random().toString(36).slice(2, 6);
const [a, b, f] = await Promise.all(['a', 'b', 'f'].map((k) => guest(`gl${k}${run}`)));
const all = [a, b, f];
ok('three guests are in', all.every((c) => c.of('welcome').length));
ok('the welcome carries no launcher yet', all.every((c) => c.of('welcome')[0]?.spirit?.gl === null), JSON.stringify(a.of('welcome')[0]?.spirit?.gl));
for (const c of all) c.send({ t: 'travel', to: PLACE.id, via: 'chat' });
ok('the trip to Moeyweedreef', await until(() => all.every((c) => c.of('travel').some((m) => m.name === c.name && m.ok)), 5000));
for (const c of all) c.at = { x: PLACE.x, y: ground(PLACE.x, PLACE.z), z: PLACE.z };
f.manual = true;
f.w = 'pistol';
await Promise.all(all.map((c) => walk(c, D.wake.x - all.indexOf(c), D.wake.z)));
f.goal = { x: D.wake.x - 2, z: D.wake.z };
ok('the third waits past the leash', Math.hypot(f.at.x - G.x, f.at.z - G.z) > G.leash + 2, `${Math.hypot(f.at.x - G.x, f.at.z - G.z).toFixed(1)} m`);
let ticking = true;
const loop = (async () => {
  while (ticking) {
    const now = Date.now();
    for (const c of all) fightStep(c, now);
    await sleep(STEP_MS);
  }
})();
for (const c of [a, b]) c.goal = inside(G.x + 11 + all.indexOf(c), G.z - 3 + 3 * all.indexOf(c), G.wakeR - 3);
ok('it wakes when the two step into the wood', await until(() => a.view?.mode === 'fight', 30_000), JSON.stringify(a.view));
a.goal = b.goal = null;

// ---- The two beat it; it drops the launcher for everyone to see.
const t0 = Date.now();
ok('they beat it', await until(() => a.of('system').some((m) => m.code === 'spBeaten'), Number(o.limit) * 1000, 200), `${((Date.now() - t0) / 1000).toFixed(0)} s`);
a.manual = b.manual = true;
ok('every page hears it drop', await until(() => all.every((c) => c.of('sgl', 'drop').length), 8000));
const drop = f.of('sgl', 'drop')[0];
const droppedAt = drop?.got ?? Date.now();
const hover = D.hover.some(([x, z]) => Math.abs(x - drop?.x) < 1e-6 && Math.abs(z - drop?.z) < 1e-6);
ok('at a hover point, six grenades, 3 minutes', hover && drop.n === L.rounds && drop.ms === L.lie * 1000, JSON.stringify(drop));
ok('not taken at once by a fighter standing near', !all.some((c) => c.of('sgl', 'left').length));
a.goal = { x: drop.x, z: drop.z + 8 };
b.goal = { x: drop.x, z: drop.z - 8 };

// ---- The third, who did not fight it, stands on it: nothing in the first 20 s, then it is theirs.
f.goal = { x: drop.x, z: drop.z };
ok('the third reaches it within the first 20 s', await until(() => Math.hypot(f.at.x - drop.x, f.at.z - drop.z) < 0.1, 18_000), `${((Date.now() - droppedAt) / 1000).toFixed(1)} s after the drop`);
await until(() => Date.now() - droppedAt > L.first * 1000 - 700, 20_000);
ok('standing on it, nothing in the first 20 s', !f.of('sgl', 'left').length && !f.of('weapons').some((m) => m.list.includes('launcher')) && !a.of('sgl', 'taken').length, `${((Date.now() - droppedAt) / 1000).toFixed(1)} s`);
ok('after 20 s it is theirs', await until(() => f.of('sgl', 'left').some((m) => m.n === L.rounds), 4000), `${((Date.now() - droppedAt) / 1000).toFixed(1)} s`);
ok('with the launcher among their guns', await until(() => f.of('weapons').some((m) => m.list.includes('launcher')), 1000));
ok('the others hear who has it (as data)', await until(() => [a, b].every((c) => c.of('sgl', 'taken').some((m) => m.name === f.name && m.n === L.rounds)), 1000));
ok('the taker is not sent its own `taken`', !f.of('sgl', 'taken').length);
f.goal = null;
f.w = 'launcher';
state(f, f.at);
await sleep(300);

const nadesOf = (c, from) => c.of('nade').filter((m) => m.l === 1 && m.name === from.name);
const gl = (c) => c.send({ t: 'gl', x: c.at.x, y: c.at.y + 1.5, z: c.at.z, vx: LOB.speed, vy: LOB.lift, vz: 0 });
let shots = 0;
// ---- Shot 1, a forged `boom` far beyond its reach, then its honest one.
gl(f);
shots++;
ok('shot 1: the others see it fly', await until(() => nadesOf(a, f).length === 1, 1500));
await sleep(600);
const blastsBy = (c, from) => c.of('blast').filter((m) => m.by === from.name);
f.send({ t: 'boom', x: f.at.x + 150, y: f.at.y, z: f.at.z, l: 1, cover: [] });
f.send({ t: 'boom', x: f.at.x - 40, y: f.at.y, z: f.at.z, l: 1, cover: [] });
await sleep(400);
ok('a `boom` far beyond what the shot reaches: refused', blastsBy(a, f).length === 0);
const land = { x: f.at.x + 16, z: f.at.z };
f.send({ t: 'boom', x: land.x, y: ground(land.x, land.z), z: land.z, l: 1, cover: [] });
ok('its honest `boom`: the server\'s blast, a grenade\'s', await until(() => blastsBy(a, f).length === 1, 1500) && blastsBy(a, f)[0].w === 'grenade', JSON.stringify(blastsBy(a, f)[0]));
f.send({ t: 'boom', x: land.x, y: ground(land.x, land.z), z: land.z, l: 1, cover: [] });
await sleep(400);
ok('the same shot does not go off twice', blastsBy(a, f).length === 1);

// ---- Forged: `gl` from a guest without it, a `hit` with the launcher.
b.w = 'launcher';
state(b, b.at);
await sleep(200);
gl(b);
await sleep(500);
ok('`gl` from a guest who does not hold it: refused', nadesOf(a, b).length === 0);
b.w = 'rifle';
const hurtA = a.of('hurt').length;
f.send({ t: 'hit', target: a.name, w: 'launcher', body: 1, head: 0 });
await sleep(500);
ok('a `hit` with the launcher: refused', a.of('hurt').length === hurtA && !a.of('kill').some((m) => m.victim === a.name));

// ---- Shot 2, then one at once (the reload).
await sleep(1800);
gl(f);
shots++;
await sleep(150);
gl(f);
await sleep(600);
ok('shot 2 flies; one more at once is refused (the reload)', nadesOf(a, f).length === 2, `${nadesOf(a, f).length} seen`);
ok('the holder is told the count', f.of('sgl', 'left').map((m) => m.n).join() === '6,5,4', f.of('sgl', 'left').map((m) => m.n).join());

// ---- The holder's connection drops and comes back within 15 s: theirs still, with the count and the reload.
await sleep(800);
gl(f);
shots++;
await sleep(100);
const shotAt = Date.now();
f.ws.close();
await sleep(300);
const lefts = f.of('sgl', 'left').length;
const weapons = f.of('weapons').length;
await connect(f.name, f.cookie, f);
ok('back on a new connection', f.of('welcome').length === 2);
ok('the welcome says who holds it', f.of('welcome')[1]?.spirit?.gl?.name === f.name, JSON.stringify(f.of('welcome')[1]?.spirit?.gl));
state(f, f.at);
ok('its launcher is back in its hands, with its count', await until(() => f.of('sgl', 'left').length > lefts && f.of('weapons').slice(weapons).some((m) => m.list.includes('launcher')), 2000) && f.of('sgl', 'left').at(-1).n === L.rounds - shots, JSON.stringify(f.of('sgl', 'left').at(-1)));
await sleep(150);
gl(f); // within its reload still, on the new connection
await sleep(500);
ok('a new connection does not reset the reload', nadesOf(a, f).length === shots && Date.now() - shotAt < 1600 + 600, `${nadesOf(a, f).length} seen, ${Date.now() - shotAt} ms after the last`);

// ---- The rest, and a seventh.
while (shots < L.rounds) {
  await sleep(2100);
  gl(f);
  shots++;
}
await sleep(600);
ok('six grenades in all', nadesOf(a, f).length === L.rounds, `${nadesOf(a, f).length}`);
ok('then empty: gone for everyone, out of the holder\'s guns', f.of('sgl', 'left').at(-1)?.n === 0 && all.every((c) => c.of('sgl', 'gone').length === 1) && !f.of('weapons').at(-1).list.includes('launcher'));
await sleep(2100);
gl(f);
await sleep(600);
ok('a seventh: refused', nadesOf(a, f).length === L.rounds);

ticking = false;
await loop;
for (const c of all) c.ws.close();
await sleep(300);
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
