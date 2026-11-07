// The forms' senders (server/auth.mjs formBucketOf) and the admin's delete of a comment.
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { bucketOf, formBucketOf } from './auth.mjs';
import { Feedback } from './feedback.mjs';

const HOST = 'brieltje.test';

test('a form counts one sender per IPv6 /56; logins keep the /64', () => {
  const home = ['2001:db8:aa:bb00::1', '2001:db8:aa:bb01:1:2:3:4', '2001:db8:aa:bbff::ffff']; // three /64s of one /56
  assert.equal(new Set(home.map(formBucketOf)).size, 1);
  assert.equal(formBucketOf(home[0]), '2001:db8:aa:bb00::/56');
  assert.equal(new Set(home.map(bucketOf)).size, 3, 'bucketOf (logins) is unchanged: one /64 each');
  assert.notEqual(formBucketOf('2001:db8:aa:bc00::1'), formBucketOf(home[0]), 'the next /56 is another sender');
  assert.equal(formBucketOf('2001:db8::1'), '2001:db8:0:0::/56', 'a short form');
  assert.equal(formBucketOf('192.0.2.7'), '192.0.2.7');
  assert.equal(formBucketOf('::ffff:192.0.2.7'), '192.0.2.7', 'IPv4 mapped into IPv6');
});

function setup() {
  const rows = [];
  const store = {
    addFeedback: async (e) => (rows.push(e), rows.length),
    deleteFeedback: async (id) => void rows.splice(id - 1, 1),
    listFeedback: async () => rows,
    pruneFeedbackIps: async () => {},
  };
  const feedback = new Feedback(store, {
    json: (res, status, data) => void Object.assign(res, { status, data }),
    // As server.mjs body(): only a same-origin JSON body.
    readJson: async (req) => {
      let host = '';
      try {
        host = new URL(String(req.headers.origin || '')).host;
      } catch {
        // no Origin
      }
      if (host !== req.headers.host) throw Object.assign(new Error('Bad origin'), { status: 403 });
      const chunks = [];
      for await (const c of req) chunks.push(c);
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    },
    clientKey: (req) => formBucketOf(req.ip),
    clientIp: (req) => req.ip,
    session: () => null,
    time: () => 'now',
  });
  const call = async (method, path, body, { ip = '192.0.2.1', origin = `http://${HOST}`, admin = false } = {}) => {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
      method, ip, headers: { host: HOST, ...(origin ? { origin } : {}), 'content-type': 'application/json' },
    });
    const res = {};
    try {
      await feedback.handle(req, res, new URL(path, `http://${HOST}`), admin);
    } catch (e) {
      res.status = e.status ?? 500;
    }
    return res;
  };
  return { rows, call };
}

test('one household on many /64s is one sender of comments', async () => {
  const { rows, call } = setup();
  const sent = [];
  for (let i = 0; i < 5; i++) sent.push((await call('POST', '/api/feedback', { stars: 4 }, { ip: `2001:db8:aa:bb${i.toString(16).padStart(2, '0')}::1` })).status);
  assert.deepEqual(sent, [200, 200, 200, 429, 429], 'three an hour per sender, whichever /64 of the /56 it comes from');
  assert.equal((await call('POST', '/api/feedback', { stars: 4 }, { ip: '2001:db8:aa:bc00::1' })).status, 200, 'the next /56 is someone else');
  assert.equal(rows.length, 4);
});

test('the admin deletes a comment only from the site itself: no cross-site delete', async () => {
  const { rows, call } = setup();
  await call('POST', '/api/feedback', { stars: 5 });
  assert.equal((await call('DELETE', '/api/admin/feedback/1', undefined, { admin: true, origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('DELETE', '/api/admin/feedback/1', undefined, { admin: true, origin: '' })).status, 403, 'no Origin at all');
  assert.equal(rows.length, 1, 'still there');
  assert.equal((await call('DELETE', '/api/admin/feedback/1', undefined, { admin: true })).status, 200);
  assert.equal(rows.length, 0);
});
