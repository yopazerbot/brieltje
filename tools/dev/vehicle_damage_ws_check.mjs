// Cars taking damage in a team match (server/vehicleDamage.mjs) against a throwaway game server (a build of this branch):
// the admin, a shooter and a driver on two sockets of their own. Outside a team match a shot at the Tesla changes
// nothing. In the teams game, the shooter and the driver on opposite teams: forged hits (a damage number of the page's,
// more pellets than the gun has, a weapon not in the hands, a flood) count for nothing or once per gun's delay; honest
// rifle hits bring the occupied Tesla through smoke and fire to a wreck; its driver is put out and down, the kill the
// shooter's (and their team's point); nobody gets into the wreck; once the game stops every vehicle is whole again and the
// Tesla back on its parking place.
//
//   ADMIN_PASSWORD=... node tools/dev/vehicle_damage_ws_check.mjs --api http://localhost:8317
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { readCar, readPlayer } from '../../web/shared/wire.mjs';
import CARS from '../../web/shared/car.json' with { type: 'json' };
import WEAPONS from '../../web/shared/weapons.json' with { type: 'json' };
import VEHICLE from '../../web/shared/vehicleDamage.json' with { type: 'json' };
import { localOnly, options } from './cdp.mjs';

const o = options({ api: 'http://localhost:8317' });
localOnly(o.api); // it logs in as the admin and joins players: a throwaway server on this computer only
const password = process.env.ADMIN_PASSWORD;
if (!password) throw new Error('ADMIN_PASSWORD is not set');
const host = new URL(o.api).host;
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
const RUN = 1.4 * 2.5 * 1.3; // m/s on foot (server/game.mjs RUN_SPEED)
const PARK = CARS.cars.tesla.park;

const world = { players: new Map(), car: null };
const connect = async (cookie, watch = false) => {
  const log = [];
  const ws = new WebSocket(`ws://${host}/ws?v=2`, { headers: { Cookie: cookie, Origin: o.api } });
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.t === 'ping') return ws.send(JSON.stringify({ t: 'pong', n: m.n }));
    if (m.t === 's') {
      if (!watch) return;
      for (const e of m.p ?? []) world.players.set(String(e[0]), readPlayer(e));
      for (const e of m.c ?? []) if (e[0] === 'tesla') world.car = readCar(e);
      return;
    }
    log.push(m);
  });
  await new Promise((res, rej) => (ws.on('open', res), ws.on('error', rej)));
  await sleep(600);
  const welcome = log.find((m) => m.t === 'welcome');
  const me = { ws, log, welcome, name: welcome?.you, x: 4.5, y: -0.1, z: 19, yaw: 0, w: 'rifle', send: (m) => ws.readyState === 1 && ws.send(JSON.stringify(m)) };
  me.state = (extra = {}) => me.send({ t: 'state', x: me.x, y: me.y, z: me.z, yaw: me.yaw, pitch: 0, armed: true, w: me.w, ct: Date.now(), ...extra });
  me.go = async (x, z, speed = RUN * 0.9) => {
    for (;;) {
      const d = Math.hypot(x - me.x, z - me.z);
      const step = Math.min(d, speed / 20);
      if (d > 1e-6) {
        me.x += ((x - me.x) / d) * step;
        me.z += ((z - me.z) / d) * step;
      }
      me.state();
      await sleep(50);
      if (d <= step) return;
    }
  };
  /** Where the server has me now (from the watcher's ticks). */
  me.sync = () => {
    const p = world.players.get(me.name);
    if (p) Object.assign(me, { x: p.x, y: p.y, z: p.z });
    return p;
  };
  /** To (x, z) round the main house's east side, on the yard's height, held there until the server agrees. */
  me.walk = async (x, z) => {
    me.sync();
    me.y = -0.1;
    if (Math.min(me.x, x) < 9.5 && Math.min(me.z, z) < 12.5) {
      await me.go(12, me.z);
      await me.go(12, z);
    }
    await me.go(x, z);
    for (let i = 0; i < 10; i++) {
      me.state();
      await sleep(50);
    }
    me.sync();
  };
  return me;
};
const guest = async (name, watch = false) => connect(cookieOf((await call('POST', '/api/join', { name, age: true })).r), watch);

const adminCookie = cookieOf((await call('POST', '/api/login', { username: 'admin', password })).r);
const admin = await connect(adminCookie);
admin.send({ t: 'rules', parachute: false }); // the teams game's gathering by parachute would take long
const run = String(Date.now() % 100000); // guest names stay taken for their session's life: new ones each run
const gun = await guest(`Shooter${run}`, true);
const dr = await guest(`Driver${run}`, true); // both watch: a page's ticks may leave out its own player
const all = [admin, gun, dr];
const keepAlive = setInterval(() => admin.state(), 400);
const vdmg = (c, from = 0) => c.log.slice(from).filter((m) => m.t === 'vdmg');
const vhit = (m = {}) => gun.send({ t: 'vhit', kind: 'car', id: 'tesla', w: 'rifle', n: 1, ...m });
/** The shooter `back` m behind the Tesla, looking along -z at it (it is parked nose to -z). */
const behind = async (back = 12) => {
  const c = world.car ?? PARK;
  await gun.walk(c.x, c.z + back);
  gun.yaw = 0;
  gun.state();
  await sleep(200);
};
/** `k` honest rifle hits, each after the gun's delay. */
const fire = async (k, gap = WEAPONS.rifle.delay * 1000 + 30) => {
  for (let i = 0; i < k; i++) {
    gun.state();
    vhit();
    await sleep(gap);
  }
};

try {
  // Outside a team match: nothing at all.
  await behind();
  const t0 = dr.log.length;
  await fire(5);
  await sleep(300);
  ok('no team match: a shot at the Tesla changes nothing, nobody is told', vdmg(dr, t0).length === 0 && vdmg(gun).length === 0);

  // The teams game, the shooter and the driver on opposite teams.
  admin.send({ t: 'mode', kind: 'teams' });
  await sleep(1500);
  const mode = () => [...admin.log].reverse().find((m) => m.t === 'mode')?.mode;
  let teams = mode()?.teams ?? {};
  if (teams[gun.name] === teams[dr.name]) {
    // The teams are the host's alone: the host moves the driver to the other side (the game's deal is tonight's two teams).
    await call('POST', '/api/host', { op: 'move', name: dr.name, team: teams[gun.name] === 'house' ? 1 : 0 }, adminCookie);
    await sleep(500);
    teams = mode()?.teams ?? {};
  }
  ok('the teams game is on, shooter and driver on opposite teams', mode()?.kind === 'teams' && teams[gun.name] && teams[dr.name] && teams[gun.name] !== teams[dr.name], JSON.stringify(teams));
  await sleep(3500); // the gathering's spawn protection runs out
  const car = world.car ?? PARK;
  await dr.walk(car.x - 1.5, car.z);
  dr.send({ t: 'car', op: 'in', id: 'tesla' });
  await sleep(500);
  ok('the driver is in the Tesla', world.car?.driver === dr.name, JSON.stringify(world.car));
  await behind();

  // Forged: a damage number of the page's, too many pellets, a gun not in the hands, a rocket, an unknown vehicle.
  const t1 = dr.log.length;
  for (const m of [{ n: 2 }, { n: 0 }, { w: 'shotgun', n: 1 }, { w: 'bazooka' }, { id: 'nope' }, { kind: 'bike' }]) {
    vhit(m);
    await sleep(200);
  }
  await sleep(300);
  ok('forged hits count for nothing', vdmg(dr, t1).length === 0, JSON.stringify(vdmg(dr, t1)));
  // One honest hit with a damage number of the page's: the gun's own damage.
  vhit({ damage: 9999, hp: 0 });
  await sleep(400);
  const first = vdmg(dr, t1).at(-1);
  const want = Math.ceil(((VEHICLE.health.car - WEAPONS.rifle.body) / VEHICLE.health.car) * 100);
  ok('an honest hit takes the gun\'s own damage, told to the driver', first?.hp === want && first?.st === 0, JSON.stringify(first));
  // A flood: 40 at once count once.
  await sleep(300);
  const t2 = dr.log.length;
  for (let i = 0; i < 40; i++) vhit();
  await sleep(500);
  const flood = vdmg(dr, t2);
  ok('a flood of 40 at once counts once', flood.length === 1 && flood[0].hp === Math.ceil(((VEHICLE.health.car - 2 * WEAPONS.rifle.body) / VEHICLE.health.car) * 100), JSON.stringify(flood));

  // Honest fire until it goes up.
  const t3 = dr.log.length;
  const kills0 = gun.log.length;
  for (let i = 0; i < 60 && !vdmg(dr, t3).some((m) => m.st === 3); i++) await fire(1);
  await sleep(500);
  const stages = [...new Set(vdmg(dr, t3).map((m) => m.st))];
  ok('it smokes, burns and goes up', stages.includes(1) && stages.includes(2) && stages.includes(3), JSON.stringify(stages));
  const boom = vdmg(dr, t3).find((m) => m.st === 3);
  ok('the destruction names the shooter, with where', boom?.by === gun.name && Number.isFinite(boom?.x), JSON.stringify(boom));
  const kill = gun.log.slice(kills0).find((m) => m.t === 'kill' && m.victim === dr.name);
  ok('the driver is down, the kill the shooter\'s', kill?.killer === gun.name && kill?.w === 'wreck', JSON.stringify(kill));
  ok('the driver is out of the car', world.car?.driver === null, JSON.stringify(world.car));
  const score = mode()?.score ?? {};
  ok('the shooter\'s team has the point', score[teams[gun.name]] >= 1, JSON.stringify(score));
  ok('a blast went off there', gun.log.slice(kills0).some((m) => m.t === 'blast' && m.w === 'wreck'));

  // Nobody gets into the wreck: the admin (near it, in no fight) tries, well inside its 20 s.
  const wreck = world.car;
  await admin.walk(wreck.x - 1.5, wreck.z);
  admin.send({ t: 'car', op: 'in', id: 'tesla' });
  await sleep(500);
  ok('nobody gets into the wreck', world.car?.driver === null, JSON.stringify(world.car));

  // The game stops: whole again at once, back on its parking place.
  const t4 = dr.log.length;
  admin.send({ t: 'mode', kind: 'free' });
  await sleep(1200);
  const whole = vdmg(dr, t4).at(-1);
  ok('the game stops: the Tesla whole again', whole?.hp === 100 && whole?.st === 0, JSON.stringify(whole));
  ok('and back on its parking place', world.car && Math.hypot(world.car.x - PARK.x, world.car.z - PARK.z) < 0.05, JSON.stringify(world.car));
  await admin.walk(PARK.x - 1.5, PARK.z);
  admin.send({ t: 'car', op: 'in', id: 'tesla' });
  await sleep(500);
  ok('and anyone may get in again', world.car?.driver === admin.name);
} finally {
  clearInterval(keepAlive);
  for (const c of all) c.ws.close();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
