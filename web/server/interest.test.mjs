// The interest page's choice about the inside of a home: private by default, public only on an explicit
// confirmation, changed only through the owner's own link, with the same-origin check of the other calls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { Interest } from './interest.mjs';

const HOST = 'brieltje.test';
const OK_CONSENT = { own: true, model: true, private: true, ai: true };

function setup() {
  const rows = [];
  const meta = new Map();
  const store = {
    getMeta: async (k) => meta.get(k) ?? null,
    setMeta: async (k, v) => void meta.set(k, v),
    addInterest: async (data, tokenHash) => (rows.push({ id: rows.length + 1, data, tokenHash }), rows.length),
    getInterest: async (id) => rows.find((r) => r.id === id) ?? null,
    listInterest: async () => [...rows].reverse().map(({ id, data }) => ({ id, data })),
    updateInterest: async (id, patch) => void Object.assign(rows.find((r) => r.id === id).data, patch),
    takeInterest: async (id) => {
      const i = rows.findIndex((r) => r.id === id);
      return i < 0 ? null : rows.splice(i, 1)[0].data;
    },
    countInterest: async () => rows.length,
  };
  const interest = new Interest(store, {
    json: (res, status, data) => void Object.assign(res, { status, data }),
    clientKey: (req) => req.who ?? 'a',
  });
  const call = async (method, path, body, { token, origin = `http://${HOST}`, who, admin = false } = {}) => {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
      method,
      who,
      headers: { host: HOST, ...(origin ? { origin } : {}), 'content-type': 'application/json', ...(token ? { 'x-interest-token': token } : {}) },
    });
    const res = {};
    try {
      await interest.handle(req, res, new URL(path, `http://${HOST}`), admin);
    } catch (e) {
      res.status = e.status ?? 500; // the server turns a thrown status into the answer
    }
    return res;
  };
  const base = { name: 'Test', email: 'test@example.com', age: true, house: true, consent: OK_CONSENT };
  const signUp = async (extra = {}, opts) => {
    const r = await call('POST', '/api/interest', { ...base, ...extra }, opts);
    return r;
  };
  return { rows, call, signUp };
}

test('a sign-up with a house is private by default, also when the field is missing', async () => {
  const { rows, signUp } = setup();
  const r = await signUp();
  assert.equal(r.status, 200);
  assert.equal(rows[0].data.inside, 'private');
  assert.equal(rows[0].data.insideAt, null);
});

test('only the two values are accepted', async () => {
  const { rows, signUp } = setup();
  for (const inside of ['PUBLIC', 'open', '', null, 1, true, {}, ['public']]) assert.equal((await signUp({ inside })).status, 400, JSON.stringify(inside));
  assert.equal(rows.length, 0);
  assert.equal((await signUp({ inside: 'private' })).status, 200);
});

test('public needs a house and its own explicit confirmation', async () => {
  const { rows, signUp } = setup();
  assert.equal((await signUp({ inside: 'public' })).status, 400); // no confirmation
  assert.equal((await signUp({ inside: 'public', consent: { ...OK_CONSENT, inside: 'yes' } })).status, 400); // not literally true
  assert.equal((await signUp({ inside: 'public', house: false, consent: { ...OK_CONSENT, inside: true } })).status, 400); // no house
  assert.equal(rows.length, 0);
  assert.equal((await signUp({ inside: 'public', consent: { ...OK_CONSENT, inside: true } })).status, 200);
  assert.equal(rows[0].data.inside, 'public');
  assert.ok(Date.parse(rows[0].data.insideAt) > 0);
});

test('the owner sees the choice and changes it with the link; the old updates call still works', async () => {
  const { rows, call, signUp } = setup();
  const { data } = await signUp();
  const token = data.token;
  assert.equal((await call('GET', `/api/interest/${data.id}`, undefined, { token })).data.inside, 'private');
  // to public: needs confirm: true
  assert.equal((await call('PATCH', `/api/interest/${data.id}`, { inside: 'public' }, { token })).status, 400);
  assert.equal((await call('PATCH', `/api/interest/${data.id}`, { inside: 'public', confirm: 'yes' }, { token })).status, 400);
  assert.equal(rows[0].data.inside, 'private');
  assert.equal((await call('PATCH', `/api/interest/${data.id}`, { inside: 'public', confirm: true }, { token })).status, 200);
  assert.equal((await call('GET', `/api/interest/${data.id}`, undefined, { token })).data.inside, 'public');
  // back to private: no confirmation needed
  assert.equal((await call('PATCH', `/api/interest/${data.id}`, { inside: 'private' }, { token })).status, 200);
  assert.equal(rows[0].data.inside, 'private');
  assert.equal(rows[0].data.insideAt, null);
  // other values and an empty body are refused
  assert.equal((await call('PATCH', `/api/interest/${data.id}`, { inside: 'open' }, { token })).status, 400);
  assert.equal((await call('PATCH', `/api/interest/${data.id}`, {}, { token })).status, 400);
  assert.equal((await call('PATCH', `/api/interest/${data.id}`, { updates: false }, { token })).status, 200);
  assert.equal(rows[0].data.updates, false);
});

test('a sign-up without a house can not be made public', async () => {
  const { rows, call, signUp } = setup();
  const { data } = await signUp({ house: false, consent: null });
  assert.equal(rows[0].data.inside, 'private');
  assert.equal((await call('PATCH', `/api/interest/${data.id}`, { inside: 'public', confirm: true }, { token: data.token })).status, 400);
  assert.equal(rows[0].data.inside, 'private');
});

test('only the owner\'s link changes it: no token, a wrong token or another sign-up\'s token get a 404', async () => {
  const { rows, call, signUp } = setup();
  const a = (await signUp()).data;
  const b = (await signUp({ email: 'other@example.com' })).data;
  const body = { inside: 'public', confirm: true };
  assert.equal((await call('PATCH', `/api/interest/${a.id}`, body)).status, 404);
  assert.equal((await call('PATCH', `/api/interest/${a.id}`, body, { token: 'x'.repeat(24) })).status, 404);
  assert.equal((await call('PATCH', `/api/interest/${a.id}`, body, { token: b.token })).status, 404); // IDOR
  assert.equal(rows[0].data.inside, 'private');
});

test('a change from another site is refused (same-origin, as the other calls)', async () => {
  const { rows, call, signUp } = setup();
  const { data } = await signUp();
  const body = { inside: 'public', confirm: true };
  assert.equal((await call('PATCH', `/api/interest/${data.id}`, body, { token: data.token, origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('PATCH', `/api/interest/${data.id}`, body, { token: data.token, origin: '' })).status, 403);
  assert.equal(rows[0].data.inside, 'private');
});

test('changes are rate limited per sender', async () => {
  const { call, signUp } = setup();
  const { data } = await signUp();
  let last = 0;
  for (let i = 0; i < 31; i++) last = (await call('PATCH', `/api/interest/${data.id}`, { inside: 'private' }, { token: data.token })).status;
  assert.equal(last, 429);
});

test('the admin list shows the choice; a row from before the field counts as private', async () => {
  const { rows, call, signUp } = setup();
  await signUp({ inside: 'public', consent: { ...OK_CONSENT, inside: true } });
  rows.push({ id: 99, data: { name: 'Old', email: 'old@example.com', house: true, files: [] }, tokenHash: createHash('sha256').update('t').digest('hex') });
  assert.equal((await call('GET', '/api/admin/interest', undefined, { admin: false })).status, 403);
  const list = (await call('GET', '/api/admin/interest', undefined, { admin: true })).data.entries;
  assert.equal(list.find((e) => e.id === 1).inside, 'public');
  assert.equal(list.find((e) => e.id === 99).inside, 'private');
});

test('the admin deletes a sign-up only from the site itself: no cross-site delete', async () => {
  const { rows, call, signUp } = setup();
  await signUp();
  assert.equal((await call('DELETE', '/api/admin/interest/1', undefined, { admin: true, origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('DELETE', '/api/admin/interest/1', undefined, { admin: true, origin: '' })).status, 403, 'no Origin at all');
  assert.equal(rows.length, 1, 'still there');
  assert.equal((await call('DELETE', '/api/admin/interest/1', undefined, { admin: true })).status, 200);
  assert.equal(rows.length, 0);
});
