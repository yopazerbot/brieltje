// The guns everyone holds, against a throwaway game server (a build of this branch), as the server has them: two
// guests and the admin join and are told their guns (all four; the admin the bazooka too); a hit with each of the four
// counts, before and after a death; an old page's 'loadout' changes nothing and is not answered; in a Zombies game a
// hit with the rifle is dropped (the pistol only) while the pistol's counts; when it ends everyone is told all four again
// and the hits count again.
//
//   ADMIN_PASSWORD=... node tools/dev/guns_ws_check.mjs --api http://localhost:8420 [--rifle]
//
// --rifle also takes a rifle dropped by a zombie (shared/loot.mjs 'rifle'): Alice takes it and her rifle's hits count,
// Bob gets none and his are dropped. It waits for a beaten zombie to leave a rifle, so run it against a server whose
// every reward is a rifle (for example a launcher that sets LOOT.chance = 1 and LOOT.weights = [['rifle', 1]] before it
// imports web/server.mjs); on the game's own odds it can wait a long time.
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { localOnly, options } from './cdp.mjs';

const o = options({ api: 'http://localhost:8420', rifle: false });
localOnly(o.api); // it logs in as the admin and starts a Zombies game: a throwaway server on this computer only
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
const ALL = 'pistol+rifle+shotgun+sniper';
const sorted = (list) => [...(list ?? [])].sort().join('+');

/** Where the server has each player and each zombie, as the ticks say (a page's own player is left out of its ticks). */
const seen = { players: new Map(), zombies: new Map() };
const connect = async (name, cookie) => {
  const log = [];
  const ws = new WebSocket(`ws://${host}/ws?v=2`, { headers: { Cookie: cookie, Origin: o.api } });
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.t === 's') {
      for (const p of m.p ?? []) seen.players.set(p[0], { x: p[2], y: p[3], z: p[4] });
      for (const z of m.z ?? []) seen.zombies.set(z[0], { id: z[0], x: z[1], z: z[2], hp: z[5] });
      return;
    }
    if (m.t === 'ping') return ws.send(JSON.stringify({ t: 'pong', n: m.n })); // as a page does: a silent one is let go after 30 s
    if (m.t === 'zgone') for (const id of m.ids ?? []) seen.zombies.delete(id);
    log.push(m);
  });
  await new Promise((res, rej) => (ws.on('open', res), ws.on('error', rej)));
  await sleep(800);
  const me = { name, ws, log, send: (m) => ws.send(JSON.stringify(m)) };
  /** Armed with `w`, where the server has them. */
  me.hold = (w) => {
    const at = seen.players.get(name) ?? { x: 4.5, y: -0.1, z: 19 };
    me.send({ t: 'state', ...at, yaw: 0, pitch: 0, armed: true, w });
  };
  me.weapons = () => log.filter((m) => m.t === 'weapons');
  return me;
};
/** A guest under `name` and a number of this run (a guest's name stays with its first player for the day), by the name the server gave. */
const guest = async (name) => {
  const j = await call('POST', '/api/join', { name: `${name}${process.pid % 10000}`, age: true });
  if (!j.data?.username) throw new Error(`join ${name}: ${j.r.status} ${j.data?.code ?? ''}`);
  return connect(j.data.username, cookieOf(j.r));
};

const admin = await connect('admin', cookieOf((await call('POST', '/api/login', { username: 'admin', password })).r));
const alice = await guest('Alice');
const bob = await guest('Bob');
ok('a guest joining is told all four', sorted(alice.weapons().at(-1)?.list) === ALL, sorted(alice.weapons().at(-1)?.list));
ok('the admin joining is told all four and the bazooka', sorted(admin.weapons().at(-1)?.list) === `bazooka+${ALL}`, sorted(admin.weapons().at(-1)?.list));
// A respawn by parachute would keep Bob in the air (calm) until his page lands him: this check has no page, so no drops.
const parachute = admin.log.find((m) => m.t === 'welcome')?.rules?.parachute;
admin.send({ t: 'rules', parachute: false });
for (const c of [admin, alice, bob]) c.hold('pistol');
await sleep(2500); // spawn protection (2 s)

/** Alice hits Bob once with each gun: which of them counted ('hurt' to Bob, or his 'kill'). */
const hitsWithEach = async (label) => {
  const counted = [];
  for (const w of ['pistol', 'rifle', 'shotgun', 'sniper']) {
    alice.hold(w);
    bob.hold('pistol');
    await sleep(200);
    const before = bob.log.length;
    alice.send({ t: 'hit', target: bob.name, w, body: 1, head: 0 });
    await sleep(1500); // the sniper's 1.3 s between shots, and Bob's own spawn protection after a kill
    const after = bob.log.slice(before);
    if (after.some((m) => m.t === 'hurt' || (m.t === 'kill' && m.victim === bob.name && m.w === w))) counted.push(w);
    if (after.some((m) => m.t === 'kill' && m.victim === bob.name)) await sleep(5500); // back after RESPAWN_MS, past his protection
  }
  ok(`${label}: a hit with each of the four counts`, counted.join('+') === ALL, counted.join('+'));
};
await hitsWithEach('in Action');
// Bob was beaten by the sniper's hit (100): he came back. Again with each, now that he lives again.
await hitsWithEach('after a death and a respawn');

// An old page's choice of guns: no answer, nothing changes, the four still hit.
const answers = alice.weapons().length;
// (300 entries: a message over the socket's 4 KB limit closes the connection, as any would.)
for (const w of [['sniper'], ['bazooka'], 'rifle', null, Array(300).fill('shotgun')]) alice.send({ t: 'loadout', w });
await sleep(800);
ok('an old page\'s \'loadout\' is not answered, and the connection stays', alice.weapons().length === answers && alice.ws.readyState === WebSocket.OPEN);
await hitsWithEach('after an old \'loadout\'');

// The Zombies game: down to the pistol. A rifle's hit on a zombie is dropped, a pistol's counts.
admin.send({ t: 'mode', kind: 'zombies', place: 'house' });
const zdowns = (by, w) => [...admin.log, ...alice.log].filter((m) => m.t === 'zdown' && m.by === by && (!w || m.w === w)).length;
const nearest = (name, within) => {
  const at = seen.players.get(name);
  if (!at) return null;
  let best = null;
  for (const z of seen.zombies.values()) {
    const d = Math.hypot(z.x - at.x, z.z - at.z);
    if (z.hp > 0 && d < within && (!best || d < best.d)) best = { ...z, d };
  }
  return best;
};
/** `c` fires `w` at the nearest zombie within 60 m, `n` times, as fast as the gun allows. */
const shoot = async (c, w, n) => {
  let tries = 0;
  for (let i = 0; i < n * 20 && tries < n; i++) {
    c.hold(w);
    const z = nearest(c.name, 60);
    if (z) {
      c.send({ t: 'zhit', w, hits: [[z.id, 1, 0]] });
      tries++;
    }
    await sleep(400);
  }
  return tries;
};
let waited = 0;
while (!nearest(alice.name, 60) && waited < 90000) {
  for (const c of [admin, alice, bob]) c.hold('pistol');
  await sleep(1000);
  waited += 1000;
}
ok('the first wave comes near', !!nearest(alice.name, 60), `after ${waited / 1000} s (${seen.zombies.size} zombies seen, ${alice.name} at ${JSON.stringify(seen.players.get(alice.name))}; the server said: ${admin.log.filter((m) => m.t === 'system').slice(-2).map((m) => m.text ?? m.code).join(' / ')})`);
const rifleTries = await shoot(alice, 'rifle', 12);
ok('Zombies: a hit with the rifle (not held) beats nothing', rifleTries > 0 && zdowns(alice.name, 'rifle') === 0, `${rifleTries} shots`);
const pistolTries = await shoot(alice, 'pistol', 12);
ok('Zombies: the pistol\'s hits count', zdowns(alice.name, 'pistol') > 0, `${zdowns(alice.name, 'pistol')} beaten in ${pistolTries} shots`);

if (o.rifle) {
  // A beaten zombie's rifle: Alice walks over it and asks for it ('zitem'); the server decides.
  const items = () => [...alice.log].reverse().find((m) => m.t === 'mode')?.mode?.zombies?.items ?? [];
  let rifle = null;
  for (let i = 0; i < 60 && !rifle; i++) {
    rifle = items().find((it) => it[1] === 'rifle');
    if (!rifle) await shoot(alice, 'pistol', 2);
  }
  ok('a beaten zombie left a rifle', !!rifle);
  if (rifle) {
    const [id, , ix, iy, iz] = rifle;
    // Walk there at a run, twenty states a second, from where the server has her.
    const at = { ...(seen.players.get(alice.name) ?? { x: ix, y: iy, z: iz }) };
    for (let i = 0; i < 400 && Math.hypot(ix - at.x, iz - at.z) > 0.3; i++) {
      const d = Math.hypot(ix - at.x, iz - at.z);
      const step = Math.min(d, 4 / 20);
      at.x += ((ix - at.x) / d) * step;
      at.z += ((iz - at.z) / d) * step;
      at.y = iy;
      alice.send({ t: 'state', ...at, yaw: 0, pitch: 0, armed: true, w: 'pistol' });
      await sleep(50);
    }
    await sleep(300);
    bob.send({ t: 'zitem', id }); // Bob, far off: not his
    alice.send({ t: 'zitem', id });
    await sleep(600);
    const gift = alice.log.find((m) => m.t === 'zgift' && m.kind === 'rifle');
    ok('Alice takes the rifle', gift?.w === 'rifle');
    ok('Bob gets none', !bob.log.some((m) => m.t === 'zgift' && m.kind === 'rifle'));
    seen.players.set(alice.name, { ...at });
    await shoot(alice, 'rifle', 10);
    ok('Alice\'s rifle hits count', zdowns(alice.name, 'rifle') > 0, `${zdowns(alice.name, 'rifle')} beaten`);
    const bobTries = await shoot(bob, 'rifle', 10);
    ok('Bob\'s rifle hits are dropped (he holds none)', bobTries > 0 && zdowns(bob.name, 'rifle') === 0, `${bobTries} shots`);
  }
}

// Over: everyone told all four again (the admin the bazooka too), and the hits count again.
const told = alice.weapons().length;
admin.send({ t: 'mode', kind: 'free' });
await sleep(1500);
ok('after Zombies Alice is told all four', alice.weapons().length > told && sorted(alice.weapons().at(-1).list) === ALL, sorted(alice.weapons().at(-1)?.list));
ok('after Zombies Bob is told all four', sorted(bob.weapons().at(-1)?.list) === ALL);
ok('after Zombies the admin is told all four and the bazooka', sorted(admin.weapons().at(-1)?.list) === `bazooka+${ALL}`);
await sleep(1000);
await hitsWithEach('after Zombies');

if (parachute !== false) admin.send({ t: 'rules', parachute: true }); // the server's rule as it was
await sleep(300);
for (const c of [admin, alice, bob]) c.ws.close();
await sleep(300);
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
