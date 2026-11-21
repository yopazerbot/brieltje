// Each connection's quality (server/linkQuality.mjs): the round trip from WebSocket pings, a page that never answers
// (missed, nothing grows), a pong that isn't the ping's own, a reconnect counted (and a move or a reload not), the entry
// gone with its connection, the group's numbers for the metrics, and a real socket answering by itself.
// Run: node --test server/linkQuality.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { LinkQuality, MAX_NAMES } from './linkQuality.mjs';

/** A page's socket: pings are recorded, a pong is ours to send (or not). */
class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.pings = [];
  }
  ping(data) {
    this.pings.push(data);
  }
  answer(data = this.pings.at(-1)) {
    this.emit('pong', data);
  }
  close(code) {
    this.readyState = 3;
    this.emit('close', code);
  }
}

function clock() {
  let t = 0;
  let n = 0;
  return {
    links: new LinkQuality({ now: () => t, timer: false, payload: () => Buffer.from([0, 0, 0, ++n]) }),
    at: (ms) => (t = ms),
  };
}

test('the round trip: last, smoothed mean and jitter from the pongs', () => {
  const { links, at } = clock();
  const ws = new FakeWs();
  links.add(ws, 'anna');
  assert.deepEqual(links.link('anna'), { connected: true, rtt: null, mean: null, jitter: null, missed: 0, waiting: false, reconnects: 0, lost: 0 });
  for (const [sent, rtt] of [[0, 20], [2000, 40], [4000, 20]]) {
    at(sent);
    links.ping();
    at(sent + rtt);
    ws.answer();
  }
  const l = links.link('anna');
  assert.equal(l.rtt, 20);
  assert.equal(l.mean, Math.round((20 + (40 - 20) / 8 + (20 - (20 + 20 / 8)) / 8) * 10) / 10);
  assert.equal(l.jitter, Math.round(((20 / 16) + (20 - 20 / 16) / 16) * 10) / 10);
  assert.equal(l.missed, 0);
});

test('a page that never answers: each ping missed, nothing grows, and its entry goes with the connection', () => {
  const { links, at } = clock();
  const ws = new FakeWs();
  links.add(ws, 'mute');
  const keys = Object.keys(links.conns.get('mute')).length;
  for (let i = 0; i < 1000; i++) {
    at(i * 2000);
    links.ping();
  }
  assert.equal(links.link('mute').missed, 999, 'every ping but the last one out');
  assert.equal(links.group().missed, 999);
  assert.equal(links.link('mute').rtt, null);
  assert.equal(Object.keys(links.conns.get('mute')).length, keys, 'the entry is the same few numbers');
  assert.equal(ws.listenerCount('pong'), 1);
  assert.equal(links.group().measured, 0, 'not in the group\'s round trips');
  ws.close(1006);
  assert.equal(links.conns.size, 0, 'gone with its connection');
  assert.deepEqual(links.link('mute'), { connected: false, rtt: null, mean: null, jitter: null, missed: 0, waiting: false, reconnects: 0, lost: 1 });
});

test('only the ping\'s own pong counts, and once: an unasked or forged pong is ignored', () => {
  const { links, at } = clock();
  const ws = new FakeWs();
  links.add(ws, 'anna');
  ws.answer(Buffer.from([0, 0, 0, 9])); // unasked
  assert.equal(links.link('anna').rtt, null);
  at(0);
  links.ping();
  at(5);
  ws.answer(Buffer.from([9, 9, 9, 9])); // not this ping's payload
  ws.answer('text');
  assert.equal(links.link('anna').rtt, null);
  at(30);
  ws.answer();
  at(31);
  ws.answer(); // the same again
  assert.equal(links.link('anna').rtt, 30);
  assert.equal(links.conns.get('anna').pongs, 1);
});

test('a reconnect: back after a lost connection, or while the old one had stopped answering; a move or a reload is none', () => {
  const { links, at } = clock();
  // Lost (1006), then back.
  const a1 = new FakeWs();
  links.add(a1, 'anna');
  a1.close(1006);
  links.add(new FakeWs(), 'anna');
  assert.equal(links.link('anna').reconnects, 1);
  assert.equal(links.link('anna').lost, 1);
  // The page noticed first: its old connection still open but silent for a ping.
  const b1 = new FakeWs();
  links.add(b1, 'bram');
  at(10_000);
  links.ping();
  at(12_000);
  links.ping(); // missed one
  const b2 = new FakeWs();
  links.add(b2, 'bram');
  b1.close(4000); // the server ends the old one (Logged in somewhere else)
  assert.equal(links.link('bram').reconnects, 1);
  assert.equal(links.link('bram').lost, 0, 'the old one\'s close is no loss of the new');
  assert.equal(links.conns.get('bram').ws, b2, 'the old close leaves the new entry');
  // A move to a room: the healthy old connection closed by the server after the new one joined.
  const c1 = new FakeWs();
  links.add(c1, 'cato');
  at(20_000);
  links.ping();
  at(20_010);
  c1.answer();
  links.add(new FakeWs(), 'cato');
  c1.close(4000);
  // A reload: the page closes (1001), then connects.
  const c3 = links.conns.get('cato').ws;
  c3.close(1001);
  links.add(new FakeWs(), 'cato');
  assert.equal(links.link('cato').reconnects, 0);
  assert.equal(links.group().reconnects, 2);
});

test('the group: median, p95, max of the latest round trips and how many are over 150 ms', () => {
  const { links, at } = clock();
  const rtts = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 400];
  const socks = rtts.map((_, i) => {
    const ws = new FakeWs();
    links.add(ws, `p${i}`);
    return ws;
  });
  links.add(new FakeWs(), 'quiet'); // never answers: not in the round trips
  at(0);
  links.ping();
  rtts.forEach((r, i) => (at(r), socks[i].answer()));
  const g = links.group();
  assert.deepEqual({ ...g, missed: 0 }, { measured: 20, median: 100, p95: 190, max: 400, slow: 5, missed: 0, reconnects: 0 });
});

test('the names of the evening are capped', () => {
  const { links } = clock();
  for (let i = 0; i < MAX_NAMES + 50; i++) {
    const ws = new FakeWs();
    links.add(ws, `n${i}`);
    ws.close(1000);
  }
  assert.equal(links.names.size, MAX_NAMES);
  assert.equal(links.conns.size, 0);
});

test('a real WebSocket answers the ping by itself; the timer stops with the last connection', async () => {
  const links = new LinkQuality({ every: 50 });
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  const joined = new Promise((r) => wss.once('connection', (ws) => (links.add(ws, 'anna'), r(ws))));
  const page = new WebSocket(`ws://127.0.0.1:${wss.address().port}`);
  try {
    await joined;
    const from = Date.now();
    while (links.link('anna')?.rtt === null && Date.now() - from < 3000) await new Promise((r) => setTimeout(r, 20));
    const l = links.link('anna');
    assert.ok(l.rtt >= 0 && l.rtt < 1000, `round trip ${l.rtt} ms`);
    assert.ok(links.timer);
  } finally {
    page.close();
    await new Promise((r) => setTimeout(r, 100));
    wss.close();
  }
  assert.equal(links.conns.size, 0);
  assert.equal(links.timer, null);
});
