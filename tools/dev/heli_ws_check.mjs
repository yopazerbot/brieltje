// The helicopter together (server/helis.mjs), against a throwaway game server (a build of this branch): the admin and
// five guests join. A seat asked for from afar is refused; four guests walk to the machine by honest states and board
// (seats 0 to 3 in that order), the fifth is refused. The pilot flies 200 m and everyone else sees the same pose in the
// ticks; a passenger's forged position is seen by nobody; forged pilot states at each cap are cut to the budgets. The
// pilot flies to each of the code-locked homes and into it from the side and from above: no tick ever shows the cabin
// inside one. Then the pilot vanishes in the air: the machine hangs still, a passenger takes the stick; with nobody at
// it the others are put out after 20 s and the machine goes home. The admin's rule off in flight, and a game starting
// with the machine in the air, empty it and send it home; a guest just hit can't board for 10 s, nor the guest who hit
// them (nor jump by /parachute). Last the jump together: on the pad a plain out; at 60 m a passenger's jump gives a drop
// from the server's pose (a `spawn` with `sy`, to the jumper alone) and the others see its canopy; the pilot's leaves the
// machine hanging where it was; a second jump does nothing.
//
//   ADMIN_PASSWORD=... node tools/dev/heli_ws_check.mjs --api http://localhost:8460
//
// It takes about four minutes (the flights, the 20 s and the 10 s waits).
import { readFileSync } from 'node:fs';
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { HOMES, homeAt } from '../../web/shared/homes.mjs';
import { makeTerrain } from '../../web/shared/terrain.mjs';
import { readHeli, readPlayer } from '../../web/shared/wire.mjs';
import { localOnly, options } from './cdp.mjs';

const o = options({ api: 'http://localhost:8460' });
localOnly(o.api); // it logs in as the admin, changes a rule and starts a game: a throwaway server on this computer only
const password = process.env.ADMIN_PASSWORD;
if (!password) throw new Error('ADMIN_PASSWORD is not set');
const host = new URL(o.api).host;
const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const DATA = json('../../web/shared/heli.json');
const TERRAIN = makeTerrain(json('../../web/shared/terrain.json'));
const GROUND = json('../../web/src/data/house_shell.json').ground;
const floor = (x, z) => GROUND + TERRAIN.height(x, z);
const PARK = DATA.machines[0].park;
const ID = DATA.machines[0].id;
const CAB = DATA.size.cabin;
const V_CAP = 52, CLIMB = 9, SINK = 14; // shared/heli.mjs HELI: what an honest page never goes past
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
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** Whether any of the cabin's five points at three heights is inside a home (server/helis.mjs inHome). */
const inHome = (h) => {
  const c = Math.cos(h.yaw), s = Math.sin(h.yaw);
  for (const [lx, lz] of [[0, 0], [0, CAB.z0], [0, CAB.z1], [CAB.halfX, -0.7], [-CAB.halfX, -0.7]]) {
    for (const dy of [0, 0.3, 1.5]) if (homeAt(h.x + lx * c + lz * s, h.z - lx * s + lz * c, h.y + dy)) return true;
  }
  return false;
};

const connect = async (name, cookie) => {
  const log = [];
  const ws = new WebSocket(`ws://${host}/ws?v=2`, { headers: { Cookie: cookie, Origin: o.api } });
  const me = { name, ws, log, heli: null, poses: [], players: new Map(), flags: new Map(), onFix: null };
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.t === 's') {
      for (const p of m.p ?? []) {
        me.players.set(p[0], { x: p[2], y: p[3], z: p[4] });
        me.flags.set(p[0], readPlayer(p));
      }
      for (const e of m.e ?? []) {
        const h = readHeli(e);
        if (h.id !== ID) continue;
        me.heli = h;
        me.poses.push(h);
      }
      return;
    }
    if (m.t === 'ping') return ws.send(JSON.stringify({ t: 'pong', n: m.n })); // a silent page is let go after 30 s
    if (m.t === 'heli' && m.fix && me.onFix) me.onFix(m.heli);
    log.push(m);
  });
  await new Promise((res, rej) => (ws.on('open', res), ws.on('error', rej)));
  await sleep(600);
  me.send = (m) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
  me.welcome = log.find((m) => m.t === 'welcome');
  me.name = me.welcome?.you ?? name;
  me.ask = async (m) => {
    me.send({ t: 'heli', ...m });
    await sleep(350); // the 300 ms gate shared with the cars
  };
  me.seats = () => [...log].reverse().find((m) => m.t === 'heli' && !m.fix)?.heli?.seats ?? [];
  return me;
};
const guest = async (name) => {
  const j = await call('POST', '/api/join', { name: `${name}${process.pid % 1000}`, age: true });
  if (!j.data?.username) throw new Error(`join ${name}: ${j.r.status} ${j.data?.code ?? ''}`);
  return connect(j.data.username, cookieOf(j.r));
};

const admin = await connect('admin', cookieOf((await call('POST', '/api/login', { username: 'admin', password })).r));
const rules = { ...admin.welcome.rules };
admin.send({ t: 'rules', parachute: false }); // no drops on respawn: this check has no page to land them
const g = [];
for (const n of ['Flyer', 'RiderA', 'RiderB', 'RiderC', 'Walker']) g.push(await guest(n));
const [pilot, r1, r2, r3, walker] = g;
ok('welcome carries the machine on its pad', walker.welcome?.helis?.[0]?.id === ID && Math.abs(walker.welcome.helis[0].x - PARK.x) < 0.01, JSON.stringify(walker.welcome?.helis?.[0]));

/** Where the server has a guest (the admin's ticks: a page's own player is left out of its own). */
const at = (c) => admin.players.get(c.name);
/** Walk (or come down) at a run to `to`, twenty honest states a second. */
const walkTo = async (c, to) => {
  const p = { ...(at(c) ?? { x: 4.5, y: -0.1, z: 19 }) };
  for (let i = 0; i < 1200 && dist(p, to) > 0.05; i++) {
    const d = Math.hypot(to.x - p.x, to.z - p.z);
    const step = Math.min(d, 4 / 20);
    if (d > 0) {
      p.x += ((to.x - p.x) / d) * step;
      p.z += ((to.z - p.z) / d) * step;
    }
    p.y += Math.max(-0.7, Math.min(0.7, to.y - p.y));
    c.send({ t: 'state', ...p, yaw: 0, pitch: 0, armed: true, w: 'pistol' });
    await sleep(50);
  }
  await sleep(200);
};
/** Next to the cabin on its pad: on its right side, one place each. */
const beside = (i) => {
  const lx = 1.5, lz = -0.4 - i * 0.5;
  return { x: PARK.x + lx * Math.cos(PARK.yaw) + lz * Math.sin(PARK.yaw), y: PARK.y, z: PARK.z - lx * Math.sin(PARK.yaw) + lz * Math.cos(PARK.yaw) };
};
const allBoard = async (list) => {
  await Promise.all(list.map((c, i) => walkTo(c, beside(i))));
  for (const c of list) await c.ask({ op: 'in', id: ID });
};

// 1. A seat from afar: refused, the asker alone told.
await walker.ask({ op: 'in', id: ID });
ok('a seat asked for from the street is refused', !walker.seats().includes(walker.name) && walker.log.some((m) => m.t === 'heli'), JSON.stringify(walker.seats()));
// 2. Four board in order, the fifth is refused.
await allBoard([pilot, r1, r2, r3]);
const seats = admin.seats();
ok('four board: seats 0 to 3 in boarding order', seats.join() === [pilot, r1, r2, r3].map((c) => c.name).join(), JSON.stringify(seats));
await walkTo(walker, beside(4));
const heard = admin.log.length;
await walker.ask({ op: 'in', id: ID });
ok('the fifth is refused, only the asker hears of it', !admin.seats().includes(walker.name) && admin.log.length === heard && walker.log.at(-1)?.t === 'heli', JSON.stringify(walker.log.at(-1)));

// The pilot's page: it flies the machine (honestly, at most the caps), takes the server's pose on a `fix`.
const pose = { x: PARK.x, y: PARK.y, z: PARK.z, yaw: PARK.yaw };
let fixes = 0;
pilot.onFix = (h) => {
  fixes++;
  Object.assign(pose, { x: h.x, y: h.y, z: h.z, yaw: h.yaw });
};
const sendPose = (who = pilot, extra = {}) => who.send({ t: 'state', ...pose, pitch: 0, armed: false, w: 'pistol', hp: 0.05, hr: 0, hn: 1, hg: 0, ...extra });
/**
 * Fly to `to` ({x, y, z}) at `speed` across, climbing at most CLIMB and sinking at most SINK, nose first (turning at most
 * 1.2 rad/s). Held back by the server (a home's wall or roof) it gives up after 1.5 s without getting nearer, and goes
 * on from where the server has the machine.
 */
const flyTo = async (to, speed = 45, who = pilot, nose = true) => {
  let best = Infinity, stuck = 0;
  for (let i = 0; i < 4000; i++) {
    const d = Math.hypot(to.x - pose.x, to.z - pose.z);
    if (d < 0.05 && Math.abs(to.y - pose.y) < 0.05) break;
    const seen = admin.heli ? dist(admin.heli, to) : Infinity;
    if (seen < best - 0.05) (best = seen), (stuck = 0);
    else if (++stuck > 30) break;
    if (nose && d > 1) {
      const want = Math.atan2(-(to.x - pose.x), -(to.z - pose.z));
      const turn = Math.atan2(Math.sin(want - pose.yaw), Math.cos(want - pose.yaw));
      pose.yaw += Math.max(-0.06, Math.min(0.06, turn));
    }
    const step = Math.min(d, speed / 20);
    if (d > 0) {
      pose.x += ((to.x - pose.x) / d) * step;
      pose.z += ((to.z - pose.z) / d) * step;
    }
    pose.y += Math.max(-SINK / 20, Math.min(CLIMB / 20, to.y - pose.y));
    sendPose(who);
    await sleep(50);
  }
  await sleep(300);
  if (admin.heli && dist(admin.heli, pose) > 0.3) Object.assign(pose, { x: admin.heli.x, y: admin.heli.y, z: admin.heli.z, yaw: admin.heli.yaw });
};
/** The way to each home at 60 m over the ground, inside the game's edge (round the map's bends by the portals). */
const WAYS = { molenhoek_end: [[-1.5, 24], [538, -775], [758, -709.5], [1061, -565.5]], kapellenhoek_home: [[1061, -565.5], [758, -709.5]] };

// 3. Up and 200 m away: everyone sees the same pose.
await flyTo({ x: PARK.x, y: floor(PARK.x, PARK.z) + 30, z: PARK.z }, 0);
await flyTo({ x: PARK.x - 140, y: floor(PARK.x - 140, PARK.z - 140) + 30, z: PARK.z - 140 });
const others = [admin, r1, r2, r3, walker];
const far = others.map((c) => (c.heli ? dist(c.heli, pose) : Infinity));
ok('the pilot flew 200 m and every other socket sees the same pose (within 0.5 m)', far.every((d) => d <= 0.5) && Math.hypot(pose.x - PARK.x, pose.z - PARK.z) > 195, far.map((d) => d.toFixed(2)).join(' '));
ok('an honest flight is never put back', fixes === 0, `${fixes} fixes`);
ok('the passengers are where the machine is', [r1, r2, r3].every((c) => at(c) && dist(at(c), pose) < 0.5));
// 4. A passenger's forged position: nobody sees it.
for (let i = 0; i < 10; i++) {
  r1.send({ t: 'state', x: pose.x + 500, y: pose.y + 40, z: pose.z - 300, yaw: 0, pitch: 0, armed: true, w: 'pistol', hp: 0.9, hn: 0 });
  sendPose();
  await sleep(50);
}
await sleep(300);
ok('a passenger\'s forged position is seen by nobody', [admin, walker, r2].every((c) => dist(c.players.get(r1.name), pose) < 0.5), JSON.stringify(admin.players.get(r1.name)));
ok('nor their tilt or rotor', Math.abs(admin.heli.p - 0.05) < 0.002 && admin.heli.n === 1);
// 5. Forged pilot states at each cap, after a second's rest: each cut to its budget, the pilot told the server's pose.
const caps = [['across', { x: 200 }, 62.4], ['up', { y: 60 }, 11.7], ['down', { y: -25 }, 18.2]];
for (const [what, jump, cap] of caps) {
  await sleep(1000);
  const before = { ...admin.heli };
  const n = fixes;
  pilot.send({ t: 'state', ...pose, x: pose.x + (jump.x ?? 0), y: pose.y + (jump.y ?? 0), yaw: pose.yaw, pitch: 0, armed: false, w: 'pistol' });
  await sleep(400);
  const moved = what === 'across' ? Math.hypot(admin.heli.x - before.x, admin.heli.z - before.z) : Math.abs(admin.heli.y - before.y);
  ok(`a forged jump ${what} is cut to the budget`, moved <= cap * 0.5 + 0.5 + 0.05 && fixes > n, `${moved.toFixed(2)} m (budget ${(cap * 0.5 + 0.5).toFixed(2)})`);
}

// 6. The homes: from the side and from above, nose first, no tick shows the cabin inside.
for (const home of HOMES) {
  const band = home.bands[0];
  let target = null;
  for (let x = band.box[0]; x <= band.box[2] && !target; x += 0.5) for (let z = band.box[1]; z <= band.box[3] && !target; z += 0.5) if (homeAt(x, z, band.y0 + 0.5) === home.id && homeAt(x + 1.2, z, band.y0 + 0.5) === home.id) target = { x, z };
  const low = Math.max(band.y0, floor(target.x, target.z)) + 0.05;
  const top = Math.max(...home.bands.map((b) => b.y1));
  const sideX = home.box[2] + 15;
  for (const [x, z] of WAYS[home.id] ?? []) await flyTo({ x, y: floor(x, z) + 60, z }, 50);
  await flyTo({ x: sideX, y: floor(sideX, target.z) + 60, z: target.z }, 50);
  await flyTo({ x: sideX, y: low, z: target.z }, 0);
  const from = admin.poses.length;
  await flyTo({ x: target.x, y: low, z: target.z }, 10, pilot, false);
  const sideSeen = admin.poses.slice(from);
  pose.y = Math.max(pose.y, low);
  await flyTo({ x: pose.x, y: top + 12, z: pose.z }, 0);
  await flyTo({ x: target.x, y: top + 12, z: target.z }, 10, pilot, false);
  const above = admin.poses.length;
  await flyTo({ x: target.x, y: low, z: target.z }, 0);
  const aboveSeen = admin.poses.slice(above);
  const stopped = admin.heli.y;
  ok(`${home.id}: from the side the cabin never goes in`, sideSeen.length > 20 && !sideSeen.some(inHome) && Math.hypot(admin.heli.x - sideX, 0) > 3, `${sideSeen.length} poses`);
  ok(`${home.id}: from above it stops on its roof`, aboveSeen.length > 10 && !aboveSeen.some(inHome) && stopped > low + 0.5, `${aboveSeen.length} poses, stopped at ${stopped.toFixed(2)}`);
  ok(`${home.id}: nobody aboard is ever seen inside`, [r1, r2, r3].every((c) => !homeAt(at(c).x, at(c).z, at(c).y)));
  await flyTo({ x: pose.x, y: floor(pose.x, pose.z) + 60, z: pose.z }, 0);
}

// 7. The pilot vanishes in the air: the machine hangs still; a passenger takes the stick.
const hang = { ...pose };
pilot.ws.close();
await sleep(2000);
ok('a pilot gone: the machine hangs still', dist(admin.heli, hang) < 0.05 && admin.heli.seats[0] === null && admin.heli.seats[1] === r1.name, JSON.stringify(admin.heli.seats));
await r1.ask({ op: 'fly' });
await r2.ask({ op: 'fly' });
ok('a passenger takes the stick (one of two asking)', admin.seats()[0] === r1.name && admin.seats()[2] === r2.name, JSON.stringify(admin.seats()));
await flyTo({ x: pose.x + 20, y: pose.y, z: pose.z }, 20, r1);
ok('the new pilot flies it', dist(admin.heli, pose) < 0.5);
// 8. Nobody at the stick for 20 s up there: everyone out, the machine home.
await r1.ask({ op: 'out' });
const left = Date.now();
await sleep(18_500);
ok('19 s without a pilot: the passengers are still aboard', admin.heli.seats[2] === r2.name && admin.heli.seats[3] === r3.name);
for (let i = 0; i < 40 && admin.heli.seats.some(Boolean); i++) await sleep(100);
ok('20 s without a pilot: everyone is put out', admin.heli.seats.every((n) => !n), `after ${((Date.now() - left) / 1000).toFixed(1)} s`);
await sleep(1500);
ok('it waits to go home while somebody stands on its spot', !admin.log.some((m) => m.t === 'heli' && m.home) && Math.hypot(admin.heli.x - PARK.x, admin.heli.z - PARK.z) > 5);
await walkTo(walker, { x: PARK.x + 12, y: PARK.y, z: PARK.z });
let homed = null;
for (let i = 0; i < 30 && !homed; i++) {
  await sleep(100);
  homed = admin.log.find((m) => m.t === 'heli' && m.home);
}
ok('the spot free: the machine is home', !!homed && homed.heli.seats.every((n) => !n) && Math.abs(homed.heli.x - PARK.x) < 0.01);

// Back to the pad on foot (a trip to the house's portal first).
const back = async (list) => {
  for (const c of list) c.send({ t: 'travel', to: 'house', via: 'chat' });
  await sleep(500);
};
await back([r1, r2, r3, walker]);
// 9. The admin's rule off in flight.
pose.x = PARK.x;
pose.y = PARK.y;
pose.z = PARK.z;
pose.yaw = PARK.yaw;
await allBoard([r2, r3]);
await flyTo({ x: PARK.x, y: floor(PARK.x, PARK.z) + 15, z: PARK.z }, 0, r2);
let mark = admin.log.length;
admin.send({ t: 'rules', heli: false });
await sleep(1500);
let home = admin.log.slice(mark).find((m) => m.t === 'heli' && m.home);
ok('the rule off in flight: everyone out, the machine home', !!home && admin.heli.seats.every((n) => !n) && Math.abs(admin.heli.y - PARK.y) < 0.01);
await r3.ask({ op: 'in', id: ID });
ok('the rule off: boarding refused with its code', r3.log.some((m) => m.t === 'system' && m.code === 'heliOff'));
admin.send({ t: 'rules', heli: true });
await sleep(500);
// 10. A game starting with the machine in the air.
Object.assign(pose, { x: PARK.x, y: PARK.y, z: PARK.z, yaw: PARK.yaw });
await allBoard([r2, r3]);
await flyTo({ x: PARK.x, y: floor(PARK.x, PARK.z) + 15, z: PARK.z }, 0, r2);
mark = admin.log.length;
admin.send({ t: 'mode', kind: 'treasure' });
await sleep(1500);
home = admin.log.slice(mark).find((m) => m.t === 'heli' && m.home);
ok('a game starting: everyone out, the machine home', !!home && admin.heli.seats.every((n) => !n));
await walker.ask({ op: 'in', id: ID }); // refused before its place is even looked at (the pad is outside the game's edge)
ok('in a game: boarding refused with its code', walker.log.some((m) => m.t === 'system' && m.code === 'gameNoHeli'));
admin.send({ t: 'mode', kind: 'free' });
await sleep(1500);
// 11. Hit, then boarding: refused for 10 s.
await Promise.all([walkTo(r3, beside(0)), walkTo(walker, beside(2))]);
await sleep(2200); // past the spawn protection of the game's gathering
walker.send({ t: 'state', ...at(walker), yaw: 0, pitch: 0, armed: true, w: 'pistol' });
r3.send({ t: 'state', ...at(r3), yaw: 0, pitch: 0, armed: true, w: 'pistol' });
await sleep(200);
walker.send({ t: 'hit', target: r3.name, w: 'pistol', body: 1, head: 0 });
await sleep(300);
ok('the hit landed', r3.log.some((m) => m.t === 'hurt'));
await r3.ask({ op: 'in', id: ID });
ok('just hit: boarding refused with its code', r3.log.some((m) => m.t === 'system' && m.code === 'heliFight') && !admin.seats().includes(r3.name));
// The one who hit: before, only being hit counted, and a hitter was back in the unhittable seat 0.6 s later.
await walker.ask({ op: 'in', id: ID });
ok('just hit someone: boarding refused with its code', walker.log.some((m) => m.t === 'system' && m.code === 'heliFight') && !admin.seats().includes(walker.name), JSON.stringify(admin.seats()));
admin.send({ t: 'rules', parachute: true });
await sleep(300);
walker.send({ t: 'chute' });
await sleep(300);
ok('just hit someone: no /parachute either', walker.log.some((m) => m.t === 'chute' && m.ok === false && m.code === 'chuteFight') && !walker.log.some((m) => m.t === 'spawn' && m.drop), JSON.stringify(walker.log.filter((m) => m.t === 'chute').at(-1)));
admin.send({ t: 'rules', parachute: false });
await sleep(9_400);
await r3.ask({ op: 'in', id: ID });
ok('10 s later: in', admin.seats()[0] === r3.name, JSON.stringify(admin.seats()));
await r3.ask({ op: 'out' });
// 12. The jump together: a passenger at 60 m gets a drop from the machine's pose, the others see the canopy; then the
// pilot jumps and the machine hangs where it was. On its pad a jump is a plain out.
admin.send({ t: 'rules', parachute: true });
await sleep(300);
Object.assign(pose, { x: PARK.x, y: PARK.y, z: PARK.z, yaw: PARK.yaw });
await allBoard([r3, r2]);
let marks = [admin, r2, r3, walker].map((c) => c.log.length);
await r2.ask({ op: 'jump' });
ok('a jump on the pad: a plain out, no drop', !admin.seats().includes(r2.name) && !r2.log.slice(marks[1]).some((m) => m.t === 'spawn'));
await walkTo(r2, beside(1));
await r2.ask({ op: 'in', id: ID });
await flyTo({ x: PARK.x, y: floor(PARK.x, PARK.z) + 60, z: PARK.z }, 0, r3);
marks = [admin, r2, r3, walker].map((c) => c.log.length);
const machine = { ...admin.heli };
await r2.ask({ op: 'jump' });
const sp = r2.log.slice(marks[1]).find((m) => m.t === 'spawn' && m.drop);
ok('a passenger\'s jump at 60 m: a spawn with sy, where the server has the machine', !!sp && typeof sp.sy === 'number' && Math.abs(sp.sy - machine.y) < 0.05 && Math.hypot(sp.sx - machine.x, sp.sz - machine.z) < 0.05, JSON.stringify(sp));
ok('only the jumper is told', [admin, r3, walker].every((c, i) => !c.log.slice(marks[[0, 2, 3][i]]).some((m) => m.t === 'spawn')));
const fall = sp ? { x: sp.sx, y: sp.sy, z: sp.sz } : { ...machine };
for (let i = 0; i < 40; i++) {
  fall.y -= 0.3;
  fall.x += 0.2;
  r2.send({ t: 'state', ...fall, yaw: 0, pitch: 0, armed: false, w: 'pistol', pc: 1, ...(i > 24 ? { po: 1 } : {}) });
  await sleep(50);
}
await sleep(300);
const seenJumper = [admin, r3, walker].map((c) => c.flags.get(r2.name));
ok('the others see the jumper with the chute and its canopy, where it falls', seenJumper.every((f) => f && f.chute && f.open && dist(f, fall) < 0.5), JSON.stringify(seenJumper.map((f) => f && [f.chute, f.open, dist(f, fall).toFixed(2)])));
const hangs = { ...admin.heli };
marks = [admin, r2, r3, walker].map((c) => c.log.length);
await r3.ask({ op: 'jump' });
await sleep(500);
const sp3 = r3.log.slice(marks[2]).find((m) => m.t === 'spawn' && m.drop);
ok('the pilot\'s jump: a spawn with sy, the machine empty where it hung', !!sp3 && Math.abs(sp3.sy - hangs.y) < 0.05 && dist(admin.heli, hangs) < 0.05 && admin.heli.seats.every((n) => !n), JSON.stringify(sp3));
await r3.ask({ op: 'jump' });
ok('a second jump: nothing', r3.log.slice(marks[2]).filter((m) => m.t === 'spawn').length === 1);

admin.send({ t: 'rules', parachute: rules.parachute, heli: rules.heli ?? true }); // the server's rules as they were
await sleep(300);
for (const c of [admin, ...g]) c.ws.close();
await sleep(300);
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
