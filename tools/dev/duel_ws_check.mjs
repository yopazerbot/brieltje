// The host's Zombies duel (server/duel.mjs) against a throwaway game server (a build of this branch on this computer):
// guests on blue and red, moved into their team's room by the server when the host starts it, a page that asks for the
// other team's room put in its own, the live line on every page, a whole warm-up (its clock shortened by the server's
// own test setting) and a whole final (until the zombies catch both teams), the result for ten seconds, and everyone
// back in the open world where they stood. Also the server's load with two hordes at once (--load).
//
// Start the server with a short warm-up minute (never a setting a page can send; off in production):
//   DUEL_TEST_MINUTE_MS=15000 ADMIN_PASSWORD=... PORT=8231 node server.mjs
//   ADMIN_PASSWORD=... node tools/dev/duel_ws_check.mjs --api http://localhost:8231 [--side 2] [--load 0]
// --side: players a side (2 or more). --load N: instead of the checks, N a side through a warm-up of a few minutes,
// printing the server's own figures (server/monitor.mjs) every five seconds.
import WebSocket from '../../web/node_modules/ws/wrapper.mjs';
import { localOnly, options } from './cdp.mjs';

const o = options({ api: 'http://localhost:8231', side: '2', load: '0', minutes: '1' });
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
const act = async (b) => (await call('POST', '/api/host', b, adminCookie)).data;
const view = async () => (await call('GET', '/api/host', null, adminCookie)).data;

/**
 * A page as the game's own does it (src/net/client.ts): one connection at a time; a close 4004 (moved, or a room gone)
 * connects again at once without a room; its player stands where the server last put it, armed, sending its state.
 */
class Page {
  constructor(name, cookie) {
    Object.assign(this, { name, cookie, log: [], welcomes: [], closes: [], room: '', pos: null, stopped: false });
    this.timer = setInterval(() => this.pos && this.send({ t: 'state', ...this.pos, yaw: 0, pitch: 0, armed: true, w: 'pistol' }), 100);
    this.connect();
  }

  connect() {
    const ws = new WebSocket(`ws://${host}/ws?v=2&sight=1${this.room ? `&room=${encodeURIComponent(this.room)}` : ''}`, { headers: { Cookie: this.cookie, Origin: o.api } });
    this.ws = ws;
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.t === 'ping') return this.send({ t: 'pong', n: m.n });
      if (m.t === 's' || m.t === 'z') return; // the ticks: not kept
      this.log.push(m);
      if (m.t === 'welcome') {
        this.welcomes.push(m.room ?? null);
        this.pos = null;
        this.log.push({ t: 'duel', duel: null }); // a welcome clears the page's line (src/main.ts)
      }
      if (m.t === 'respawn' && m.name === this.name && typeof m.x === 'number') this.pos = { x: m.x, y: m.y ?? 0, z: m.z };
    });
    ws.on('close', (code) => {
      this.closes.push(code);
      this.pos = null;
      if (this.stopped || ws !== this.ws) return;
      if (code === 4004 || code === 4006) { // a room gone, or moved into the duel (src/net/client.ts)
        this.room = '';
        return this.connect();
      }
      setTimeout(() => !this.stopped && this.connect(), 1000);
    });
    ws.on('error', () => {});
  }

  send(m) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  of(t) {
    return this.log.filter((m) => m.t === t);
  }

  get line() {
    return this.of('duel').at(-1)?.duel ?? null;
  }

  get where() {
    return this.welcomes.at(-1)?.duel ?? 'world';
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.ws?.close();
  }
}

const guest = async (name) => {
  const { r, data } = await call('POST', '/api/join', { name, age: true });
  if (!r.ok) throw new Error(`join ${name}: ${data?.code}`);
  return new Page(name, cookieOf(r));
};
const until = async (what, ms, step = 250) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) if (await what()) return true;
  return !!(await what());
};

await call('POST', '/api/lockouts', {}, adminCookie);
await act({ op: 'reset' });
await act({ op: 'lock', on: false });
await act({ op: 'limit', max: 32 });
await act({ op: 'teams', count: 0 });
const side = Math.max(2, Number(o.side) || 2);
const load = Number(o.load) || 0;
const per = load || side;
const tag = Math.random().toString(36).slice(2, 5);
const pages = [];
for (let i = 0; i < per * 2; i++) {
  if (i % 8 === 7) await call('POST', '/api/lockouts', {}, adminCookie); // every guest joins from this one address
  pages.push(await guest(`d${tag}${i}`));
}
await sleep(1500);
await act({ op: 'teams', count: 2 }); // shuffled: half blue, half red
await sleep(500);
const teamOf = new Map(pages.map((p) => [p, p.of('eveningteams').at(-1)?.teams?.[p.name]]));
const blue = pages.filter((p) => teamOf.get(p) === 'blue');
const red = pages.filter((p) => teamOf.get(p) === 'red');
ok(`${pages.length} guests on two teams`, blue.length === per && red.length === per, `${blue.length} blue, ${red.length} red`);
// Before: each stands somewhere of its own in the open world.
// They start at the street's start place: each walks a few metres to a place of its own there.
for (const [i, p] of pages.entries()) p.pos = { x: 1.5 + (i % 6) * 1.5, y: -0.1, z: 21 + Math.floor(i / 6) * 1.5 };
await sleep(4000);
const stood = new Map(pages.map((p) => [p, { ...p.pos }]));

const finish = async () => {
  for (const p of pages) p.stop();
  await sleep(300);
  console.log(failed ? `${failed} FAILED` : 'all ok');
  process.exit(failed ? 1 : 0);
};

if (load) {
  // Load: two hordes at once, `load` players a side, for about three minutes.
  ok('a warm-up starts', !!(await act({ op: 'start', kind: 'duel', duel: 'warmup', minutes: 30 }))?.ok);
  await sleep(11_000);
  ok('everyone in their room', await until(() => pages.every((p) => p.where === teamOf.get(p)), 15_000), pages.map((p) => p.where).join(','));
  const t0 = Date.now();
  console.log('time  players  tickMs  tickMaxMs  cpu%  loop%  lagMs  kbOut/s  waves');
  const seen = new Set();
  while (Date.now() - t0 < 180_000) {
    await sleep(5000);
    const v = await view();
    const s = v.server.samples.at(-1);
    if (!s || seen.has(s.at)) continue;
    seen.add(s.at);
    console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}  ${String(s.players).padStart(7)}  ${String(s.tickMs).padStart(6)}  ${String(s.tickMaxMs).padStart(9)}  ${String(s.cpu).padStart(4)}  ${String(s.loop).padStart(5)}  ${String(s.lagMs).padStart(5)}  ${String(s.kbOutPerSec).padStart(7)}  ${v.duel?.sides.map((x) => `${x.team} ${x.wave}`).join(' ')}`);
  }
  const dropped = pages.filter((p) => p.closes.some((c) => c !== 4004 && c !== 4006 && c !== 1005));
  ok('no connection dropped', !dropped.length, dropped.map((p) => `${p.name}:${p.closes}`).join(' '));
  await act({ op: 'stop' });
  await sleep(11_000);
  await finish();
}

// The warm-up.
ok('the host starts a warm-up',!!(await act({ op: 'start', kind: 'duel', duel: 'warmup', minutes: Number(o.minutes) || 1, look: 'paint' }))?.ok);
await sleep(10_500); // the countdown
ok('everyone is moved into their team\'s room', await until(() => pages.every((p) => p.where === teamOf.get(p)), 10_000), pages.map((p) => `${p.name}:${p.where}`).join(' '));
ok('moved with the duel\'s own close (4006: no "room closed" line), never told a room is gone', pages.every((p) => p.closes[0] === 4006 && !p.of('roomgone').length), pages.map((p) => p.closes.join('/')).join(' '));
ok('no page joined the other team\'s room', pages.every((p) => p.welcomes.every((w) => !w?.duel || w.duel === teamOf.get(p))));
ok('the live line reaches every page', await until(() => pages.every((p) => p.line?.sides?.length === 2 && p.line.kind === 'warmup'), 5000));
ok('the look holds in both rooms (paint)', pages.every((p) => p.of('rules').at(-1)?.rules?.paintball === true || p.of('welcome').at(-1)?.rules?.paintball === true));
// A page asks for the other team's room by its id (the admin's list names none: from the room it was told of).
const redId = red[0].welcomes.at(-1)?.id;
const sneak = blue[1];
sneak.room = redId;
sneak.ws.close();
await sleep(2500);
ok('a page asking for the other team\'s room is put in its own', sneak.where === 'blue', sneak.where);
// A dropped connection comes back into its room.
red[1].ws.terminate();
ok('a dropped connection comes back into its room', await until(() => red[1].welcomes.length >= 3 && red[1].where === 'red', 8000), red[1].welcomes.map((w) => w?.duel ?? 'world').join(','));
const v1 = await view();
ok('the host sees the duel', v1.duel?.kind === 'warmup' && v1.duel.sides.every((x) => x.players === per), JSON.stringify(v1.duel?.sides));
// To the end of the warm-up's clock, the result for ten seconds, then back.
const warm = await until(() => pages.every((p) => p.line?.phase === 'done'), (Number(o.minutes) || 1) * 70_000 + 30_000, 500);
ok('the warm-up ends on its clock, with a result on every page', warm, JSON.stringify(blue[0].line));
const result = blue[0].line;
ok('a winner or a draw', !!result?.winner, JSON.stringify(result));
ok('the result line in the chat of every page', pages.every((p) => p.of('system').some((m) => m.code === 'duelWon' || m.code === 'duelDraw')));
await sleep(5000);
ok('still in the rooms while the result shows', pages.every((p) => p.where !== 'world'));
ok('then everyone is back in the open world', await until(() => pages.every((p) => p.where === 'world' && p.line === null), 12_000), pages.map((p) => p.where).join(','));
await sleep(800);
const far = pages.filter((p) => !p.pos || Math.hypot(p.pos.x - stood.get(p).x, p.pos.z - stood.get(p).z) > 1);
ok('each page is told it is back where it stood', !far.length, far.map((p) => `${p.name}: ${JSON.stringify(p.pos)} not ${JSON.stringify(stood.get(p))}`).join(' '));
const ev = (await view()).board;
ok('the evening\'s scoreboard counts it', pages.every((p) => ev.players.find((x) => x.name === p.name)?.played === 1), JSON.stringify(ev.players.map((x) => [x.name, x.points])));

// The final: until the zombies catch both teams (nobody here shoots).
for (const p of pages) p.pos = { ...stood.get(p) };
ok('a final starts', !!(await act({ op: 'start', kind: 'duel', duel: 'final', look: 'real' }))?.ok);
await sleep(10_500);
ok('everyone in their room again', await until(() => pages.every((p) => p.where === teamOf.get(p)), 10_000));
ok('the final\'s line', await until(() => pages.every((p) => p.line?.kind === 'final'), 5000));
// Someone new once the first wave began: in their team's room, out (no fresh life under a new name).
ok('the first wave of the final began', await until(() => blue[0].line?.sides.every((x) => x.wave >= 1), 60_000, 500));
await call('POST', '/api/lockouts', {}, adminCookie);
const late = await guest(`d${tag}late`);
pages.push(late);
ok('a newcomer in the final is moved into a team\'s room', await until(() => late.where === 'blue' || late.where === 'red', 8000), late.where);
ok('and comes in out, told it is for good', await until(() => late.of('kill').some((m) => m.victim === late.name) && late.of('system').some((m) => m.code === 'duelDown'), 5000));
const first = await until(() => blue[0].line?.sides.some((x) => x.out), 240_000, 1000);
ok('one team is caught first', first, JSON.stringify(blue[0].line));
const out = blue[0].line?.sides.find((x) => x.out)?.team;
const outPages = out === 'blue' ? blue : red;
ok('its pages are told they are out, the others what to pass', outPages.every((p) => p.of('system').some((m) => m.code === 'duelOutUs')) && (out === 'blue' ? red : blue).every((p) => p.of('system').some((m) => m.code === 'duelOutThem')));
ok('the downed are told it is for good', pages.some((p) => p.of('system').some((m) => m.code === 'duelDown')));
const done = await until(() => pages.every((p) => p.line?.phase === 'done'), 240_000, 1000);
ok('the final ends', done, JSON.stringify(blue[0].line));
const [m1, m2] = blue[0].line?.sides ?? [];
const level = m1 && m2 && m1.wave === m2.wave && m1.beaten === m2.beaten;
ok('caught second without passing the mark: the team out first wins (or a draw: the same mark at the same moment)', blue[0].line?.winner === out || (level && blue[0].line?.winner === 'draw'), JSON.stringify(blue[0].line));
ok('then everyone is back in the open world', await until(() => pages.every((p) => p.where === 'world'), 15_000));
const dropped = pages.filter((p) => p.closes.some((c) => c !== 4004 && c !== 4006 && c !== 1005 && c !== 1006));
ok('no connection dropped by the server', !dropped.length, dropped.map((p) => `${p.name}:${p.closes}`).join(' '));
await finish();
