// Two pages against a throwaway game server, for every code-locked home: Bob types the home's code and walks in, Alice
// has no right and stands at the door. Every WebSocket message Alice gets is logged, and the check proves that while
// Bob is inside she is sent nothing of him: no tick entry, no shot, no place; that she is told once he is out of sight;
// that chat still reaches her without a place; and that he is back in her ticks the moment he steps out.
// (server/homeGate.mjs, Game.homeOf; the server's tests: server/homeSight.test.mjs.)
//
//   ADMIN_PASSWORD=... node tools/dev/homes_sight_check.mjs --api http://localhost:8457 [--out <folder>]
//
// --out: what Alice was sent while Bob was inside, per home (the message types and their counts), as JSON.
// The password comes from the environment and is never printed; nor are the codes. Needs a fresh server on your own port.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { HOMES, homeAt } from '../../web/shared/homes.mjs';
import { PORTALS } from '../../web/shared/portals.mjs';
import { makeTerrain } from '../../web/shared/terrain.mjs';
import { localOnly, options } from './cdp.mjs';

const PLACES = JSON.parse(readFileSync(new URL('../../web/shared/places.json', import.meta.url), 'utf8')).places;
const o = options({ api: 'http://localhost:8457', out: '' });
localOnly(o.api); // it makes and revokes the homes' codes: a throwaway server on this computer only
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
const connect = async (cookie) => {
  const log = [];
  const ws = new WebSocket(`ws://${host}/ws?v=4&sight=1`, { headers: { Cookie: cookie, Origin: o.api } });
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', n: m.n })); // as a page does: a silent one is let go
    log.push(m);
  });
  await new Promise((res, rej) => (ws.on('open', res), ws.on('error', rej)));
  await sleep(800);
  return { ws, log, send: (m) => ws.send(JSON.stringify(m)) };
};
const guest = async (asked) => {
  const cookie = cookieOf((await call('POST', '/api/join', { name: asked, age: true })).r);
  const c = await connect(cookie);
  return { name: c.log.find((m) => m.t === 'welcome')?.you ?? asked, cookie, ...c };
};

/** The ground floor's height of a home: its first band starts 3 m under it (the main house and the bungalow: at 0). */
const floorOf = (h) => (h.bands[0].y0 < -1 ? 0 : h.bands[0].y0 + 3);
/** A spot well inside a home's ground floor (0.5 m from every side still inside). */
function insideSpot(h) {
  const y = floorOf(h) + 0.05;
  const [x0, z0, x1, z1] = h.bands[0].box;
  for (let x = x0; x <= x1; x += 0.25) {
    for (let z = z0; z <= z1; z += 0.25) {
      if ([[0, 0], [0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]].every(([dx, dz]) => homeAt(x + dx, z + dz, y) === h.id)) return { x, y, z };
    }
  }
  throw new Error(`no spot inside ${h.id}`);
}
const pos = {};
const at = (p, x, z, y) => {
  pos[p.name] = { x, z, y };
  p.send({ t: 'state', x, y, z, yaw: 0, pitch: 0, armed: true, w: 'pistol' });
};
/** Walk in steps a runner makes (the server's budget), at most `secs`. */
const walk = async (p, x, z, y) => {
  const from = pos[p.name];
  const d = Math.hypot(x - from.x, z - from.z, y - from.y);
  const n = Math.max(1, Math.ceil(d / 0.4));
  for (let k = 1; k <= n; k++) {
    at(p, from.x + ((x - from.x) * k) / n, from.z + ((z - from.z) * k) / n, from.y + ((y - from.y) * k) / n);
    await sleep(100);
  }
};
/** Where `who` is in `p`'s ticks, last seen. */
const seen = (p, who) => {
  for (let i = p.log.length - 1; i >= 0; i--) {
    const e = p.log[i].t === 's' ? p.log[i].p?.find((q) => q[0] === who) : null;
    if (e) return { x: e[2], y: e[3], z: e[4] };
  }
  return null;
};

const admin = cookieOf((await call('POST', '/api/login', { username: 'admin', password })).r);
const root = await connect(admin); // spawns a strongman inside each home
const TERRAIN = makeTerrain(JSON.parse(readFileSync(new URL('../../web/shared/terrain.json', import.meta.url), 'utf8')));
const a = await guest('Alice'); // no right
const b = await guest('Bob'); // types each home's code
await sleep(600);
for (const p of [a, b]) {
  pos[p.name] = seen(p === a ? b : a, p.name);
  ok(`${p.name} is in the other's ticks`, !!pos[p.name]);
}
if (failed) process.exit(1);
const captures = {};
for (const h of HOMES) {
  const made = await call('POST', `/api/admin/homes/${h.id}/code`, {}, admin);
  const unlock = await call('POST', '/api/home/unlock', { id: h.id, code: made.data?.code }, b.cookie);
  ok(`${h.id}: Bob has the right`, made.r.status === 200 && unlock.r.status === 200);
  const out = PORTALS.find((q) => q.id === h.id)?.out ?? h.out;
  const floor = floorOf(h);
  const inside = insideSpot(h);
  // Both to the door (Alice 2 m further out): a home far off by chat travel to the nearest street first, then on foot.
  if (Math.hypot(pos[b.name].x - out[0], pos[b.name].z - out[1]) > 250) {
    const street = PLACES.reduce((best, q) => (Math.hypot(q.x - out[0], q.z - out[1]) < Math.hypot(best.x - out[0], best.z - out[1]) ? q : best));
    for (const p of [a, b]) {
      p.send({ t: 'travel', to: street.id, via: 'chat' });
      await sleep(700);
      ok(`${h.id}: ${p.name} travelled to the nearest street`, p.log.some((m) => m.t === 'travel' && m.name === p.name && m.to === street.id && m.ok));
      pos[p.name] = { x: street.x, z: street.z, y: floor - 0.4 };
      at(p, street.x, street.z, floor - 0.4);
      await sleep(200);
    }
  }
  await Promise.all([walk(a, out[0] + 1.5, out[1] + 1.5, floor), walk(b, out[0], out[1], floor)]);
  await sleep(600);
  ok(`${h.id}: Alice sees Bob at the door`, !!seen(a, b.name));
  // A strongman inside the home (the admin's), Bob unarmed for now: he goes for nobody who may not see in, his rocks
  // and stomps hurt nobody outside, and Alice is sent none of them.
  b.send({ t: 'state', ...pos[b.name], yaw: 0, pitch: 0, armed: false });
  a.log.length = 0;
  root.send({ t: 'clown', op: 'add', kind: 'strongman', x: inside.x, y: inside.y - TERRAIN.height(inside.x, inside.z), z: inside.z });
  for (let i = 0; i < 40; i++) {
    at(a, pos[a.name].x + (i % 2 ? 0.05 : -0.05), pos[a.name].z, pos[a.name].y); // Alice keeps moving: fresh, armed
    await sleep(150);
  }
  const brute = root.log.filter((m) => m.t === 'clowns').pop()?.list?.find((c) => c.kind === 'strongman' && Math.hypot(c.x - inside.x, c.z - inside.z) < 0.5);
  ok(`${h.id}: a strongman inside: Alice is not hurt and is sent none of his rocks or stomps`, !!brute && !a.log.some((m) => m.t === 'hurt' || m.t === 'kill' || m.t === 'rock' || m.t === 'stomp'), brute ? '' : 'not spawned');
  ok(`${h.id}: nor is he in her ticks`, !!brute && !a.log.some((m) => m.t === 's' && (m.b ?? []).some((e) => e[0] === brute.id)));
  if (brute) root.send({ t: 'clown', op: 'remove', id: brute.id });
  await sleep(500);
  // At the door, outside, his shot reaches her (so its absence inside means something).
  b.send({ t: 'shot', w: 'pistol', x: out[0], y: floor + 1.6, z: out[1] });
  await sleep(500);
  ok(`${h.id}: his shot outside reaches her`, a.log.some((m) => m.t === 'shot' && m.name === b.name));
  await sleep(700); // the pistol's rate
  // Bob walks in, moves about, shoots, chats; Alice's messages from then on are the capture.
  a.log.length = 0;
  await walk(b, inside.x, inside.z, inside.y);
  for (let i = 0; i < 10; i++) {
    at(b, inside.x + (i % 2) * 0.3, inside.z, inside.y);
    await sleep(150);
  }
  b.send({ t: 'shot', w: 'pistol', x: inside.x, y: inside.y + 1.6, z: inside.z });
  b.send({ t: 'chat', text: 'hello' });
  await sleep(1200);
  const inB = seen(b, a.name) && true; // Bob still sees Alice outside
  const capture = a.log.slice();
  captures[h.id] = Object.entries(capture.reduce((n, m) => ((n[m.t] = (n[m.t] ?? 0) + 1), n), {})).sort();
  const told = capture.some((m) => m.t === 's' && (m.o ?? []).includes(b.name));
  const entry = capture.some((m) => m.t === 's' && (m.p ?? []).some((e) => e[0] === b.name));
  ok(`${h.id}: Alice is told once that Bob is out of sight`, told && capture.filter((m) => m.t === 's' && (m.o ?? []).includes(b.name)).length === 1);
  // The walk in itself may show its first steps up to the wall: after the "out of sight", none at all.
  const after = capture.slice(capture.findIndex((m) => m.t === 's' && (m.o ?? []).includes(b.name)) + 1);
  ok(`${h.id}: then no tick entry of Bob`, !after.some((m) => m.t === 's' && (m.p ?? []).some((e) => e[0] === b.name)), entry ? '(only before)' : '');
  ok(`${h.id}: no shot of Bob`, !capture.some((m) => m.t === 'shot' && m.name === b.name));
  const spot = (r) => Math.abs(r - inside.x) < 0.5;
  ok(`${h.id}: no message carries Bob's place inside`, !after.some((m) => JSON.stringify(m).includes(b.name) && Object.values(m).some((v) => typeof v === 'number' && spot(v))));
  const chat = capture.find((m) => m.t === 'chat' && m.from === b.name);
  ok(`${h.id}: his chat line comes, without a place`, !!chat && Object.keys(chat).every((k) => ['t', 'from', 'color', 'text'].includes(k)));
  ok(`${h.id}: Bob still sees Alice`, !!inB);
  // A grenade thrown from inside, Bob out of the door before it goes off at Alice's feet: she is not hurt, and told of the
  // blast without his name (homeGate: nobody hurts someone who could not see them at the moment of the act).
  const al = pos[a.name];
  // Bob to the last spot inside on his way out, so he steps out within the grenade's fuse.
  const steps = 60;
  let last = inside;
  for (let k = 1; k <= steps; k++) {
    const q = { x: inside.x + ((out[0] - inside.x) * k) / steps, z: inside.z + ((out[1] - inside.z) * k) / steps, y: floor + 0.05 };
    if (homeAt(q.x, q.z, q.y) !== h.id) break;
    last = q;
  }
  await walk(b, last.x, last.z, last.y);
  a.log.length = 0;
  const thrown = Date.now();
  // A real throw towards her (the server keeps the bang within what the throw's speed reaches in its fuse).
  const dx = al.x - last.x, dz = al.z - last.z, dd = Math.hypot(dx, dz) || 1;
  b.send({ t: 'nade', x: last.x, y: last.y + 1.5, z: last.z, vx: (dx / dd) * 12, vy: 4, vz: (dz / dd) * 12 });
  // Out again: in Alice's very next ticks.
  await walk(b, out[0], out[1], floor);
  await sleep(400);
  ok(`${h.id}: Bob is back in Alice's ticks once out`, a.log.some((m) => m.t === 's' && (m.p ?? []).some((e) => e[0] === b.name)));
  ok(`${h.id}: out before it goes off (the server takes a bang 2 to 6 s after the throw)`, Date.now() - thrown < 5400, `${Date.now() - thrown} ms`);
  await sleep(Math.max(0, thrown + 2600 - Date.now()));
  b.send({ t: 'boom', x: al.x, y: al.y + 0.9, z: al.z });
  await sleep(600);
  const bl = a.log.find((m) => m.t === 'blast');
  ok(`${h.id}: his grenade from inside goes off by Alice: she is told of the blast, without his name`, !!bl && bl.by === '', JSON.stringify(bl ?? null));
  ok(`${h.id}: the bang is at her feet (within the blast's reach of her)`, !!bl && Math.hypot(bl.x - al.x, bl.z - al.z) < 2, bl ? `${Math.hypot(bl.x - al.x, bl.z - al.z).toFixed(2)} m` : '');
  ok(`${h.id}: and it spares her`, !a.log.some((m) => m.t === 'hurt' || m.t === 'kill'));
  await call('DELETE', `/api/admin/homes/${h.id}/code`, undefined, admin);
}
if (o.out) {
  mkdirSync(o.out, { recursive: true });
  writeFileSync(`${o.out}/sight-capture.json`, JSON.stringify(captures, null, 1));
}
a.ws.close();
b.ws.close();
root.ws.close();
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);
