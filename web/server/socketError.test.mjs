import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocket } from 'ws';
import { Game } from './game.mjs';

// A message over the socket's size limit (game.mjs: maxPayload) makes the library emit 'error' on that socket. With
// nobody listening, that 'error' ended the whole process: one oversize message from any guest stopped the server for
// everyone (denial of service). Every socket the game takes on now has a listener; the library closes the socket
// (1009) and the player leaves as on any close. Real sockets, on a port of the machine's choosing.

test('a message over the size limit closes that socket only; the server and the others go on', async () => {
  const sessions = new Map([['k-ann', { username: 'ann', role: 'guest', key: 'k-ann' }], ['k-bob', { username: 'bob', role: 'guest', key: 'k-bob' }]]);
  const auth = {
    sessions,
    session: (req) => sessions.get(String(req.headers.cookie || '').replace('s=', '')) ?? null,
    store: { addStats: async () => {}, setMeta: async () => {} },
    log: () => {},
    addressOf: () => '127.0.0.1',
  };
  const game = new Game(auth, []);
  const failed = [];
  const onFail = (e) => failed.push(e);
  process.on('uncaughtException', onFail);
  const http = createServer();
  http.on('upgrade', (req, socket, head) => game.upgrade(req, socket, head));
  await new Promise((res) => http.listen(0, '127.0.0.1', res));
  const host = `127.0.0.1:${http.address().port}`;
  const open = async (key) => {
    const ws = new WebSocket(`ws://${host}/ws?v=2`, { headers: { Cookie: `s=${key}`, Origin: `http://${host}` } });
    const got = [];
    ws.on('message', (d) => got.push(JSON.parse(String(d))));
    ws.on('error', () => {});
    await new Promise((res, rej) => (ws.once('open', res), ws.once('error', rej)));
    return { ws, got };
  };
  try {
    const ann = await open('k-ann');
    const bob = await open('k-bob');
    await new Promise((res) => setTimeout(res, 200));
    assert.ok(game.players.has('ann') && game.players.has('bob'), 'both are in');
    const closed = new Promise((res) => ann.ws.once('close', (code) => res(code)));
    ann.ws.send(JSON.stringify({ t: 'chat', text: 'x'.repeat(5000) }));
    assert.equal(await closed, 1009, 'the oversize sender is closed as "message too big"');
    await new Promise((res) => setTimeout(res, 200));
    assert.deepEqual(failed, [], 'nothing reached the process as an uncaught error');
    assert.ok(!game.players.has('ann'), 'the sender has left');
    assert.ok(game.players.has('bob'), 'the other player is still in');
    const before = bob.got.length;
    bob.ws.send(JSON.stringify({ t: 'pong', n: 0 }));
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(bob.ws.readyState, WebSocket.OPEN, "the other player's socket is open");
    assert.ok(bob.got.length >= before, 'and still served');
    bob.ws.close();
  } finally {
    process.off('uncaughtException', onFail);
    for (const t of game.timers) clearInterval(t);
    for (const p of game.players.values()) p.ws.terminate();
    await new Promise((res) => http.close(res));
  }
});
