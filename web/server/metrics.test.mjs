// The server's own numbers for Prometheus (server/metrics.mjs): the text is well formed in the exposition format, every
// sample a finite number, every label value from its fixed list, and nothing of a player's in it even when their names
// are hostile; the listener is off without METRICS_PORT, bound where told, answers GET /metrics only, and a flood of
// scrapes costs one build of the text. Run: node --test server/metrics.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Agent, request } from 'node:http';
import { createServer } from 'node:net';
import { Game } from './game.mjs';
import { Rooms } from './rooms.mjs';
import { CLOSES, CONTENT_TYPE, GC_KINDS, KINDS, MESSAGE_TYPES, Metrics, metricsServer, PHASES, PLACES, startMetrics, STATUS, VEHICLES } from './metrics.mjs';

const BUCKETS = ['0.001', '0.002', '0.005', '0.01', '0.02', '0.03', '0.04', '0.05', '0.075', '0.1', '0.25', '+Inf'];
/** Every label a sample may carry, and the values it may take. */
const ALLOWED = {
  type: [...MESSAGE_TYPES, 'other'], place: PLACES, kind: [...KINDS, ...VEHICLES, ...GC_KINDS], phase: PHASES, why: CLOSES,
  code: STATUS, stat: ['mean', 'p99', 'max', 'median', 'p95'], over: ['30ms', '50ms'], le: BUCKETS,
};
const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

/** A parser of the text format 0.0.4 of our own: families, their types and samples; throws on anything malformed. */
function parse(text) {
  assert.ok(text.endsWith('\n'), 'the last line ends with a line feed');
  const families = new Map(); // name -> { type, help, samples: [{ name, labels, value }] }
  const seen = new Set();
  let current = null;
  const familyOf = (sample) => {
    for (const suffix of ['_bucket', '_sum', '_count']) {
      const base = sample.slice(0, -suffix.length);
      if (sample.endsWith(suffix) && families.get(base)?.type === 'histogram') return base;
    }
    return sample;
  };
  for (const line of text.slice(0, -1).split('\n')) {
    let m;
    if ((m = /^# HELP (\S+) (.*)$/.exec(line))) {
      assert.match(m[1], NAME);
      assert.ok(!families.has(m[1]), `one HELP for ${m[1]}`);
      families.set(m[1], { help: m[2], type: null, samples: [] });
      current = m[1];
      continue;
    }
    if ((m = /^# TYPE (\S+) (counter|gauge|histogram|summary|untyped)$/.exec(line))) {
      assert.equal(m[1], current, `TYPE right after its HELP: ${line}`);
      assert.equal(families.get(m[1]).type, null, `one TYPE for ${m[1]}`);
      assert.equal(families.get(m[1]).samples.length, 0, 'TYPE before the samples');
      families.get(m[1]).type = m[2];
      continue;
    }
    m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$/.exec(line);
    assert.ok(m, `a sample line: ${JSON.stringify(line)}`);
    const [, name, body = '', raw] = m;
    const fam = familyOf(name);
    assert.equal(fam, current, `${name}: its family's lines together`);
    const labels = {};
    if (body) {
      const re = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\\n]|\\[\\"n])*)"(,|$)/y;
      let at = 0;
      while (at < body.length) {
        re.lastIndex = at;
        const l = re.exec(body);
        assert.ok(l, `labels: ${body}`);
        labels[l[1]] = l[2];
        at = re.lastIndex;
      }
    }
    const value = Number(raw);
    assert.ok(Number.isFinite(value), `${line}: a finite number`);
    const key = `${name}${JSON.stringify(Object.entries(labels).sort())}`;
    assert.ok(!seen.has(key), `one sample per series: ${key}`);
    seen.add(key);
    families.get(fam).samples.push({ name, labels, value });
  }
  for (const [name, f] of families) {
    assert.ok(f.type, `${name} has a TYPE`);
    if (f.type === 'counter') for (const s of f.samples) assert.ok(s.value >= 0, `${name}: a counter is never below 0`);
    if (f.type === 'histogram') {
      const b = f.samples.filter((s) => s.name.endsWith('_bucket'));
      assert.deepEqual(b.map((s) => s.labels.le), BUCKETS, `${name}: buckets in order, +Inf last`);
      for (let i = 1; i < b.length; i++) assert.ok(b[i].value >= b[i - 1].value, 'cumulative');
      assert.equal(b.at(-1).value, f.samples.find((s) => s.name.endsWith('_count')).value, '+Inf equals the count');
    }
  }
  return families;
}

function assertLabels(families) {
  for (const f of families.values()) {
    for (const s of f.samples) {
      for (const [k, v] of Object.entries(s.labels)) {
        assert.ok(ALLOWED[k], `${s.name}: label ${k} is one of the fixed ones`);
        assert.ok(ALLOWED[k].includes(v), `${s.name}: ${k}="${v}" is from its fixed list`);
      }
    }
  }
}

function fakeAuth() {
  return {
    logged: [], sessions: new Map(), log() {}, addressOf: () => '192.0.2.1',
    store: { saveZombieRun: async () => true, addStats: async () => {}, setMeta: async () => {} },
  };
}

const HOSTILE = ['x"}\nevil_metric{a="1', 'back\\slash', 'alice@example.org', '198.51.100.23', 'zoë'];

test('the type list is the server\'s own: every message type game.mjs handles, and no other', () => {
  const source = readFileSync(new URL('./game.mjs', import.meta.url), 'utf8');
  const handled = new Set([...source.matchAll(/m\.t === '([a-z0-9_]+)'/g)].map((m) => m[1]));
  assert.deepEqual([...MESSAGE_TYPES].sort(), [...handled].sort());
});

test('the text is well formed, every sample finite, every label from its list, no player\'s name or address in it', () => {
  const auth = fakeAuth();
  const main = new Game(auth);
  const made = [];
  const rooms = new Rooms(main, (room) => {
    const g = new Game(auth, undefined, room);
    made.push(g);
    return g;
  });
  try {
    // Hostile names playing, one of them driving a car, one in a room; hostile message types sent.
    for (const name of HOSTILE) main.players.set(name, { ws: { readyState: 0, OPEN: 1, close() {} }, role: 'guest', address: '198.51.100.23' });
    Object.values(main.cars)[0].driver = HOSTILE[0];
    const r = rooms.create({ username: 'anna', role: 'player' }, 'church').room;
    made[0].players.set(HOSTILE[1], { ws: { readyState: 0, OPEN: 1, close() {} }, role: 'guest' });
    const m = new Metrics();
    m.attach({ rooms });
    m.start();
    for (const t of ['state', 'state', 'chat', ...HOSTILE, '__proto__', 'constructor', 'toString', 42, null]) m.message(t);
    m.drop();
    for (const ms of [3, 8, 12, 35, 60]) m.tick(ms);
    m.wsOpened();
    m.wsClosed(1006);
    m.wsClosed(4000);
    m.wsClosed(1001);
    m.in(120);
    m.out(800, 3);
    const text = m.text();
    m.stop();
    for (const bad of [...HOSTILE, r.id, 'anna', '192.0.2.1', 'evil_metric']) assert.ok(!text.includes(bad), `not in the text: ${bad}`);
    const families = parse(text);
    assertLabels(families);
    const value = (name, labels = {}) => [...families.values()].flatMap((f) => f.samples)
      .find((s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v))?.value;
    assert.equal(value('brieltje_players', { place: 'house' }), HOSTILE.length);
    assert.equal(value('brieltje_players', { place: 'room' }), 1);
    assert.equal(value('brieltje_games', { place: 'room' }), 1);
    assert.equal(value('brieltje_vehicles_in_use', { kind: 'car' }), 1);
    assert.equal(value('brieltje_messages_in_total', { type: 'state' }), 2);
    assert.equal(value('brieltje_messages_in_total', { type: 'chat' }), 1);
    assert.equal(value('brieltje_messages_in_total', { type: 'other' }), HOSTILE.length + 5, 'made-up types count as other');
    assert.equal(value('brieltje_messages_dropped_total'), 1);
    assert.equal(value('brieltje_ticks_slow_total', { over: '30ms' }), 2);
    assert.equal(value('brieltje_ticks_slow_total', { over: '50ms' }), 1);
    assert.equal(value('brieltje_tick_seconds', { stat: 'max' }), 0.06);
    assert.equal(value('brieltje_tick_seconds', { stat: 'p99' }), 0.06);
    assert.equal(value('brieltje_tick_duration_seconds_count'), 5);
    assert.equal(value('brieltje_ws_closed_total', { why: 'lost' }), 1);
    assert.equal(value('brieltje_ws_closed_total', { why: 'server' }), 1);
    assert.equal(value('brieltje_ws_closed_total', { why: 'normal' }), 1);
    assert.equal(value('brieltje_bytes_out_total'), 2400);
    assert.equal(value('brieltje_messages_out_total'), 3);
    assert.equal(families.get('brieltje_game_on').samples.length, 0, 'free play: no game on');
    assert.ok(value('process_resident_memory_bytes') > 0);
    // The window starts again after a scrape; the counters don't.
    m.cachedAt = -1e9;
    const again = parse(m.text());
    assert.equal(again.get('brieltje_tick_seconds').samples.find((s) => s.labels.stat === 'max').value, 0);
    assert.equal(again.get('brieltje_tick_duration_seconds').samples.find((s) => s.name.endsWith('_count')).value, 5);
  } finally {
    [main, ...made].forEach((g) => g.close());
  }
});

test('the games on: place, kind and phase from the lists; zombies standing; one sample per label set', () => {
  const zombies = new Map([[1, { act: 'walk' }], [2, { act: 'down' }], [3, { act: 'chase' }]]);
  const game = (room, state) => ({ room, players: new Map([['a', {}]]), watchers: new Set(), modes: { state }, cars: {}, bikes: {}, horses: [], helis: { machines: new Map() } });
  const games = [
    game(null, { kind: 'flag', phase: 'playing', f: { assault: true } }),
    game({ id: 'r1' }, { kind: 'zombies', phase: 'wave', z: { horde: { zombies } } }),
    game({ id: 'r2' }, { kind: 'zombies', phase: 'wave', z: { horde: { zombies } } }),
    game({ id: 'd1', duel: 'blue' }, { kind: 'invented"}', phase: 'whatever\n' }),
  ];
  const m = new Metrics();
  m.attach({ rooms: { games: () => games } });
  const families = parse(m.text());
  assertLabels(families);
  const on = families.get('brieltje_game_on').samples.map((s) => [s.labels.place, s.labels.kind, s.labels.phase, s.value]);
  assert.deepEqual(on, [['house', 'assault', 'playing', 1], ['room', 'zombies', 'wave', 2], ['duel', 'other', 'other', 1]]);
  assert.equal(families.get('brieltje_zombies_up').samples.find((s) => s.labels.place === 'room').value, 4);
});

test('the text is built at most once per 250 ms', () => {
  let t = 0;
  const m = new Metrics({ now: () => t });
  for (let i = 0; i < 100; i++) (t = i * 2), m.text(); // a hundred within 200 ms
  assert.equal(m.builds, 1);
  for (let i = 0; i < 100; i++) (t = 1000 + i * 10), m.text(); // a hundred over a second
  assert.equal(m.builds, 5, 'one at 1000, 1250, 1500, 1750 ms');
});

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

/** One HTTP request with a Host header of our choosing (fetch doesn't let one set it). */
const ask = (port, { method = 'GET', path = '/metrics', host = `127.0.0.1:${port}`, agent } = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, method, path, agent, headers: { Host: host, Origin: 'https://evil.example' } }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => (body += c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', reject);
  req.end(method === 'POST' ? '{}' : undefined);
});

test('the listener is off without METRICS_PORT, and with a value that is no port', () => {
  for (const env of [{}, { METRICS_PORT: '' }, { METRICS_PORT: '0' }, { METRICS_PORT: 'abc' }, { METRICS_PORT: '70000' }, { METRICS_PORT: '9464.5' }]) {
    assert.equal(startMetrics(env, new Metrics()), null, JSON.stringify(env));
  }
});

test('the listener binds 127.0.0.1 by default, or where METRICS_HOST says', async () => {
  for (const env of [{}, { METRICS_HOST: '127.0.0.1' }]) {
    const port = await freePort();
    const m = new Metrics();
    const server = startMetrics({ ...env, METRICS_PORT: String(port) }, m);
    try {
      await new Promise((r) => server.once('listening', r));
      assert.deepEqual([server.address().address, server.address().port], ['127.0.0.1', port]);
    } finally {
      m.stop();
      await new Promise((r) => server.close(r));
    }
  }
});

test('the listener answers GET /metrics only: another path is 404, a POST is refused, a Host with a dot is refused, no CORS', async () => {
  const m = new Metrics();
  const server = metricsServer(m);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const ok = await ask(port);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['content-type'], CONTENT_TYPE);
    assert.equal(ok.headers['access-control-allow-origin'], undefined, 'no CORS');
    parse(ok.body);
    assert.equal((await ask(port, { host: `game:${port}` })).status, 200, 'the compose service name');
    for (const path of ['/', '/metrics/', '/metrics?x=1', '/api/host', '/healthz', '/../metrics', '/METRICS']) {
      assert.equal((await ask(port, { path })).status, 404, path);
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) assert.equal((await ask(port, { method })).status, 405, method);
    for (const host of ['evil.example', `rebind.evil.example:${port}`, 'localhost.']) assert.equal((await ask(port, { host })).status, 403, host);
    // A hundred scrapes at once, over eight kept-alive sockets (the listener takes 16 at most): one build of the text.
    const agent = new Agent({ keepAlive: true, maxSockets: 8 });
    const before = m.builds;
    const t0 = performance.now();
    const all = await Promise.all(Array.from({ length: 100 }, () => ask(port, { agent })));
    agent.destroy();
    const ms = performance.now() - t0;
    assert.ok(all.every((a) => a.status === 200 && a.body === all[0].body));
    assert.ok(m.builds - before <= 1, `builds: ${m.builds - before} in ${ms.toFixed(0)} ms`);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
