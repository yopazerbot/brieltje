// Attack and defend (server/assault.mjs, server/assaultSupply.mjs) against a throwaway game server (a build of this branch
// on this computer): four guests and the admin, two evening teams. The host's programme starts it with red defending the
// church; every page gets the round, the roles and the camp; the attackers start in their camp, the defenders at the
// church. The crates: ammo given and then the wait, the other side's crate refused, out of reach refused, forged ids
// ignored, two heavy weapons for a team and the third refused; the spawn truck refused to a defender and driven by an
// attacker; the host's swap refused. The admin (an attacker) takes the flag from the stand and carries it into the camp:
// a capture, its time; the break; round 2 at the Sparrenhof with the roles swapped. The admin, now a defender, takes
// claymores and a turret and sets them out, takes a bazooka and destroys the spawn truck: no start place while it is a
// wreck, back whole at its camp 60 s later. The second round runs out: the only capture wins, on every page and on the
// host's scoreboard.
//
//   ADMIN_PASSWORD=... node tools/dev/assault_ws_check.mjs --api http://localhost:8431
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { localOnly, options } from './cdp.mjs';
import { FIELDS } from '../../web/shared/flagFields.mjs';
import { ASSAULT } from '../../web/shared/assaultFields.mjs';

const o = options({ api: 'http://localhost:8431' });
localOnly(o.api); // it logs in as the admin and starts games: a throwaway server on this computer only
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
const adminCookie = cookieOf((await call('POST', '/api/login', { username: 'admin', password })).r);
const act = async (b) => call('POST', '/api/host', b, adminCookie);

const connect = async (name, cookie) => {
  const log = [];
  const ws = new WebSocket(`ws://${host}/ws?v=2`, { headers: { Cookie: cookie, Origin: o.api } });
  const c = { name, ws, log, at: null, w: 'pistol', send: (m) => ws.readyState === 1 && ws.send(JSON.stringify(m)), of: (t) => log.filter((m) => m.t === t) };
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    m._at = Date.now(); // when it came (a mode's `ms` counts from then)
    log.push(m);
    if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', n: m.n }));
    if (m.t === 'respawn' && m.name === name && typeof m.x === 'number') c.at = { x: m.x, y: typeof m.y === 'number' ? m.y : c.at?.y ?? 0, z: m.z };
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
const state = (c, p, extra = {}) => {
  c.at = { ...p };
  c.send({ t: 'state', x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), yaw: p.yaw ?? 0, pitch: p.pitch ?? 0, armed: true, w: c.w, ...extra });
};
/** Walk `c` to (x, y, z) at `speed` m/s, ten steps a second. */
const walk = async (c, x, y, z, speed = 3.4) => {
  const from = { ...c.at };
  const n = Math.max(1, Math.ceil(Math.hypot(x - from.x, z - from.z) / (speed / 10)));
  for (let i = 1; i <= n; i++) {
    state(c, { x: from.x + ((x - from.x) * i) / n, y: from.y + ((y - from.y) * i) / n, z: from.z + ((z - from.z) * i) / n });
    await sleep(100);
  }
};
const lastMode = (c) => c.of('mode').at(-1)?.mode;
const lines = (c) => c.of('system').map((m) => m.code);

await call('POST', '/api/lockouts', {}, adminCookie);
await act({ op: 'reset' });
await act({ op: 'lock', on: false });
await act({ op: 'limit', max: 32 });
const admin = await connect('admin', adminCookie);
state(admin, { x: 4.5, y: -0.1, z: 14 });
const run = Math.random().toString(36).slice(2, 6);
const names = ['a', 'b', 'c', 'd'].map((k) => `ad${k}${run}`);
const players = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await guest(n)])));
await act({ op: 'teams', count: 2 });
await act({ op: 'move', name: 'admin', team: 0 }); // the admin on blue: an attacker in round 1
await sleep(500);
ok('four guests and the admin are in', names.every((n) => players[n].of('welcome').length) && !!admin.of('welcome').length);

// The host's programme: Attack and defend, red defends the church first, two-minute rounds; a forged entry refused.
const bad = await act({ op: 'start', kind: 'assault', defend: 'green' });
ok('a forged "defends first" refuses the whole game', bad.data?.code === 'badValue', JSON.stringify(bad.data));
await act({ op: 'start', kind: 'assault', defend: 'red', minutes: 2 });
await sleep(11_500);
const v = lastMode(players[names[0]]);
ok('the game is on for every page: round 1 at the church, red defends', names.every((n) => lastMode(players[n])?.flag?.assault?.round === 1) && v?.flag?.field === 'assaultChurch' && v.flag.assault.def === 'red', JSON.stringify(v?.flag?.assault));
const team = (n) => lastMode(players[names[0]])?.teams?.[n];
const blue = names.filter((n) => team(n) === 'blue').map((n) => players[n]);
const red = names.filter((n) => team(n) === 'red').map((n) => players[n]);
ok('two guests a side', blue.length === 2 && red.length === 2);
const F1 = FIELDS.assaultChurch;
const camp1 = F1.assault.camp;
const [sx, sz, sy] = F1.bases.blue.stand;
for (const c of red) ok(`${c.name} (defending) starts at the church`, !!c.at && Math.hypot(c.at.x - sx, c.at.z - sz) < 25, JSON.stringify(c.at));
for (const c of blue) ok(`${c.name} (attacking) starts in the camp`, !!c.at && Math.hypot(c.at.x - camp1.flag[0], c.at.z - camp1.flag[1]) < 10, JSON.stringify(c.at));
await sleep(ASSAULT.truckStillMs + 500);
ok('the spawn truck becomes a start place once it has stood still, every page told', v?.flag?.assault?.truck?.spawn === false && lastMode(players[names[0]])?.flag?.assault?.truck?.spawn === true);
const swap = await act({ op: 'swap' });
ok('the host\'s swap of sides is refused in this game', swap.data?.code === 'assaultNoSwap', JSON.stringify(swap.data));

// The crates. An attacker walks to the camp's ammo crate: given; again at once: the wait.
const [b1, b2] = blue;
const [r1] = red;
const crate = (list, kind) => list.findIndex((k) => k.kind === kind);
const ammo = crate(camp1.crates, 'ammo');
await walk(b1, camp1.crates[ammo].at[0] + 0.6, camp1.crates[ammo].at[2], camp1.crates[ammo].at[1]);
b1.send({ t: 'asup', id: `c${ammo}` });
await sleep(500);
ok('ammo and grenades from the camp\'s crate', b1.of('asup').some((m) => m.kind === 'ammo' && m.ms === ASSAULT.wait.ammo));
b1.send({ t: 'asup', id: `c${ammo}` });
await sleep(500);
ok('again at once: the wait, in seconds', b1.of('system').some((m) => m.code === 'asupWait' && m.args?.n > 15));
for (const id of ['__proto__', 'constructor', 'x'.repeat(4000), 99, null, { id: 'c0' }, NaN, 1e308]) {
  b1.send({ t: 'asup', id });
  await sleep(350); // past the server's own pace for these (300 ms), so each is looked at
}
b1.send({ t: 'asup', id: 'd0' });
await sleep(500);
ok('forged ids give nothing; a defenders\' crate refuses an attacker', b1.of('asup').length === 1 && lines(b1).includes('asupSide'));
// A defender at the church's ammo crate: given. Out of reach: refused.
const dAmmo = crate(F1.assault.crates, 'ammo');
const dc = F1.assault.crates[dAmmo].at;
await walk(r1, dc[0] + ASSAULT.reach + 1, dc[2], dc[1]);
r1.send({ t: 'asup', id: `d${dAmmo}` });
await sleep(500);
ok('out of reach: refused, with a line', lines(r1).includes('asupFar') && !r1.of('asup').length);
await walk(r1, dc[0] + 0.5, dc[2], dc[1]);
r1.send({ t: 'asup', id: `d${dAmmo}` });
await sleep(500);
ok('the defenders\' own crate serves them', r1.of('asup').some((m) => m.kind === 'ammo'));
// Heavy weapons: two for the attackers, the third refused.
const bz = crate(camp1.crates, 'bazooka');
const sn = crate(camp1.crates, 'sniper');
await walk(b1, camp1.crates[bz].at[0] + 0.5, camp1.crates[bz].at[2], camp1.crates[bz].at[1]);
b1.send({ t: 'asup', id: `c${bz}` });
await walk(b2, camp1.crates[sn].at[0] + 0.5, camp1.crates[sn].at[2], camp1.crates[sn].at[1]);
b2.send({ t: 'asup', id: `c${sn}` });
await sleep(600);
ok('a bazooka and a sniper rifle from the camp\'s crates', b1.of('fbz').some((m) => m.ev === 'taken' && m.name === b1.name) && b2.of('weapons').at(-1)?.list.includes('sniper'));
ok('nobody else has the sniper rifle in this game', !b1.of('weapons').at(-1)?.list.includes('sniper'));
for (let i = 1; i <= 10; i++) {
  state(admin, { x: admin.at.x + (camp1.crates[sn].at[0] + 0.5 - admin.at.x) * (i / 10), y: camp1.crates[sn].at[2], z: admin.at.z + (camp1.crates[sn].at[1] - admin.at.z) * (i / 10) });
  await sleep(100);
}
admin.send({ t: 'asup', id: `c${sn}` });
await sleep(500);
ok('the third heavy weapon for the team is refused', lines(admin).includes('asupHeavyFull'));

// The spawn truck: refused to a defender, driven by an attacker.
const truck = lastMode(admin)?.flag?.assault?.truck?.id;
const [tx, tz, ty] = camp1.truck;
// The admin (fast) beside the truck brings a defender, then an attacker (as a respawn there: the host's bring).
for (let i = 1; i <= 5; i++) {
  state(admin, { x: admin.at.x + (tx + 3.5 - admin.at.x) * (i / 5), y: ty, z: admin.at.z + (tz - admin.at.z) * (i / 5) });
  await sleep(100);
}
await act({ op: 'bring', name: r1.name });
await sleep(600);
r1.send({ t: 'car', op: 'in', id: truck });
await sleep(500);
ok('a defender may not get into the spawn truck', lines(r1).includes('assaultTruck'));
await act({ op: 'bring', name: b2.name });
await sleep(600);
b2.send({ t: 'car', op: 'in', id: truck });
await sleep(500);
ok('an attacker may', b2.of('car').some((m) => m.car?.id === truck && m.car.driver === b2.name));
b2.send({ t: 'car', op: 'out' });
await sleep(300);

// The admin (an attacker) takes the flag from the stand and carries it into the camp.
for (let i = 1; i <= 20; i++) {
  state(admin, { x: admin.at.x + (sx - admin.at.x) * (i / 20), y: admin.at.y + (sy - admin.at.y) * (i / 20), z: admin.at.z + (sz - admin.at.z) * (i / 20) });
  await sleep(100);
}
await sleep(800);
ok('the attacker on the stand takes the flag', lastMode(admin)?.flag?.flags?.red?.by === 'admin', JSON.stringify(lastMode(admin)?.flag?.flags?.red));
const t0 = Date.now();
for (let i = 1; i <= 30; i++) {
  state(admin, { x: sx + (camp1.flag[0] - sx) * (i / 30), y: sy + (camp1.flag[2] - sy) * (i / 30), z: sz + (camp1.flag[1] - sz) * (i / 30) });
  await sleep(100);
}
await sleep(800);
const after = lastMode(admin);
const r = after?.flag?.assault?.results?.[0];
// The time counts from the round's start (its first view came then) to the capture (the first view after it).
const began = admin.of('mode').find((m) => m.mode?.flag?.assault?.round === 1)?._at ?? 0;
const capturedAt = admin.of('mode').find((m) => m.mode?.flag?.assault?.results?.length)?._at ?? 0;
ok('into the camp: captured, round 1 over, its time on the server\'s clock from the round\'s start', !!r && r.ms !== null && r.def === 'red' && Math.abs(r.ms - (capturedAt - began)) < 3000, JSON.stringify({ ms: r?.ms, seen: capturedAt - began, carried: Date.now() - t0 }));
ok('every page told: the capture line and the flag event', names.every((n) => players[n].of('flag').some((m) => m.ev === 'captured' && m.name === 'admin')) && names.every((n) => players[n].of('system').some((m) => m.code === 'assaultCaptured')));
ok('the break: the Sparrenhof, blue defends now', after?.flag?.assault?.phase === 'break' && after?.flag?.field === 'assaultSparrenhof' && after?.flag?.assault?.def === 'blue');
const F2 = FIELDS.assaultSparrenhof;
const [s2x, s2z, s2y] = F2.bases.blue.stand;
await sleep(500);
for (const c of red) ok(`${c.name} (attacking now) starts in the Sparrenhof's camp`, !!c.at && Math.hypot(c.at.x - F2.assault.camp.flag[0], c.at.z - F2.assault.camp.flag[1]) < 10, JSON.stringify(c.at));
for (const c of blue) ok(`${c.name} (defending now) starts at the Sparrenhof`, !!c.at && Math.hypot(c.at.x - s2x, c.at.z - s2z) < 25, JSON.stringify(c.at));
ok('the heavy weapons back in their crates at the break (each round\'s teams with the same kit)', !b2.of('weapons').at(-1)?.list.includes('sniper') && lastMode(admin)?.flag?.assault?.heavy?.blue === 0);
await sleep(ASSAULT.breakMs);
ok('round 2 is on', lastMode(admin)?.flag?.assault?.round === 2 && lastMode(admin)?.flag?.assault?.phase === 'live');

// The admin, now a defender: claymores and a turret from the Sparrenhof's crates, set out by the stand.
const aBase = admin.of('respawn').filter((m) => m.name === 'admin').at(-1);
state(admin, { x: aBase?.x ?? s2x, y: s2y, z: aBase?.z ?? s2z });
const take = async (kind) => {
  const i = crate(F2.assault.crates, kind);
  const at = F2.assault.crates[i].at;
  for (let k = 1; k <= 5; k++) {
    state(admin, { x: admin.at.x + (at[0] + 0.5 - admin.at.x) * (k / 5), y: at[2], z: admin.at.z + (at[1] - admin.at.z) * (k / 5) });
    await sleep(100);
  }
  admin.send({ t: 'asup', id: `d${i}` });
  await sleep(500);
  return admin.of('asup').at(-1);
};
ok('claymores from the defenders\' crate', (await take('claymore'))?.kit?.claymores === ASSAULT.claymoresTake);
await sleep(ASSAULT.wait.trap);
ok('then a turret', (await take('turret'))?.kit?.turrets === 1);
const place = { x: s2x + 4, y: s2y, z: s2z + 4 };
for (let k = 1; k <= 5; k++) {
  state(admin, { x: admin.at.x + (place.x - admin.at.x) * (k / 5), y: place.y, z: admin.at.z + (place.z - admin.at.z) * (k / 5) });
  await sleep(100);
}
admin.send({ t: 'claymore', x: place.x + 0.9, y: place.y, z: place.z, yaw: -Math.PI / 2 });
await sleep(500);
admin.send({ t: 'turret', x: place.x, y: place.y, z: place.z - 1, yaw: 0 });
await sleep(600);
const traps = lastMode(admin)?.flag?.assault;
ok('a claymore and a turret set out, every page sees them', traps?.mines?.length === 1 && traps?.turrets?.length === 1, JSON.stringify({ mines: traps?.mines, turrets: traps?.turrets }));
// A bazooka for the defenders too, then two rockets at the attackers' spawn truck in its camp.
const got = await take('bazooka');
ok('a bazooka for the defending admin', got?.kind === 'bazooka');
const camp2 = F2.assault.camp;
const [t2x, t2z, t2y] = camp2.truck;
for (let k = 1; k <= 10; k++) {
  state(admin, { x: admin.at.x + (t2x + 40 - admin.at.x) * (k / 10), y: t2y, z: admin.at.z + (t2z - admin.at.z) * (k / 10) });
  await sleep(100);
}
admin.w = 'bazooka';
state(admin, { x: t2x + 40, y: t2y, z: t2z });
await sleep(300);
for (let k = 0; k < 3; k++) {
  admin.send({ t: 'rocket', tx: t2x, ty: t2y + 1.5, tz: t2z });
  await sleep(3000);
}
await sleep(1500);
const wreck = admin.of('vdmg').filter((m) => m.k === 'car' && m.id === truck).at(-1);
ok('the spawn truck destroyed by the defenders\' rockets', !!wreck && wreck.st >= 3, JSON.stringify(wreck));
ok('a wreck is no start place', lastMode(admin)?.flag?.assault?.truck?.spawn === false);
const wreckedAt = admin.of('vdmg').find((m) => m.k === 'car' && m.id === truck && m.st === 3)?._at ?? Date.now();
await sleep(58_000 - (Date.now() - wreckedAt));
ok('still gone at 58 s', (admin.of('vdmg').filter((m) => m.k === 'car' && m.id === truck).at(-1)?.st ?? 0) >= 3);
await sleep(4000);
const backAt = admin.of('vdmg').filter((m) => m.k === 'car' && m.id === truck && m.st === 0).at(-1)?._at;
console.log(`     whole again ${backAt ? ((backAt - wreckedAt) / 1000).toFixed(1) : '?'} s after the wreck`);
const back = admin.of('vdmg').filter((m) => m.k === 'car' && m.id === truck).at(-1);
const placed = admin.of('car').filter((m) => m.car?.id === truck).at(-1)?.car;
ok('back whole at its camp about 60 s after', back?.st === 0 && !!placed && Math.hypot(placed.x - t2x, placed.z - t2z) < 0.5, JSON.stringify({ back, at: placed && [placed.x, placed.z] }));

// The second round runs out with no capture: blue's was the only one.
const lastSeen = admin.of('mode').at(-1);
await sleep(Math.max(0, (lastSeen?.mode?.ms ?? 0) - (Date.now() - lastSeen._at)) + 1500);
const end = lastMode(players[names[0]]);
ok('the end: blue wins with the only capture, on every page', end?.phase === 'done' && end?.resultCode === 'assaultOnly' && end?.resultArgs?.team === 'blue', JSON.stringify({ code: end?.resultCode, args: end?.resultArgs }));
const board = (await call('GET', '/api/host', null, adminCookie)).data?.board;
const winners = board?.players?.filter((p) => names.includes(p.name) && p.points >= 4).map((p) => p.name).sort();
ok('the host\'s scoreboard: three points more for blue\'s players', JSON.stringify(winners) === JSON.stringify(blue.map((c) => c.name).sort()), JSON.stringify(board?.players));
await sleep(11_000);
ok('after the result the game is gone and the sniper back in everyone\'s hands', lastMode(b1)?.kind === 'free' && !!b1.of('weapons').at(-1)?.list.includes('sniper'));

for (const c of [admin, ...Object.values(players)]) c.ws.close();
await act({ op: 'teams', count: 0 });
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
