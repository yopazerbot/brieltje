// The interest page (web/public/interested/): who would like to play together in person, when
// it would suit them and with how many, and whether they want their own house in the game. For
// that they can upload the 2D plans of their home, after explicit consent. The plans stay
// private: they go to the private Railway bucket (PLANS_* variables) and only the admin can
// fetch them, through links that work for five minutes. Without a bucket (local development)
// they go to web/.data/plans/.
//
// Public: POST /api/interest (a sign-up), PUT /api/interest/:id/plans (one file, raw body),
// GET and DELETE /api/interest/:id with the sign-up's own secret (to see or withdraw it; the secret
// travels in the X-Interest-Token header, never in a URL that could end up in a log),
// GET /api/interest/count, GET /api/address?q= (street suggestions from the Flemish address
// register, fetched by the server so the visitor's typing doesn't go to a third party).
// Admin only: GET /api/admin/interest, GET /api/admin/interest/:id/file/:n, POST and DELETE
// /api/admin/interest/:id (status and note, or remove it with its plans).
//
// Guarded against: cross-site posts (same-origin bodies only), spam and floods (a trap field,
// sign-ups and uploads per address and per day, a cap on storage), file tricks (the type is
// read from the file's first bytes, never from its name; files are stored under random names
// and always downloaded as attachments, so nothing uploaded can run as a page: no stored XSS),
// guessing someone's sign-up (a 144-bit secret link, stored only as a hash, compared in
// constant time) and leaking the bucket's keys (requests are signed here; errors log only S3's
// error code, never its answer).

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const MAX_FILES = 10; // a plan per storey, or several photos of paper plans
const MAX_FILE = 25 * 1024 * 1024; // bytes
const MAX_TOTAL = 4 * 1024 * 1024 * 1024; // all plans together: the bucket is paid by the GB
const UPLOAD_HOURS = 24; // plans can be added this long after signing up
const WHEN = ['weekday', 'saturday', 'sunday'];
const STATUS = ['new', 'contacted', 'modelled', 'declined'];
const TYPES = {
  pdf: { mime: 'application/pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  png: { mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  jpg: { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  heic: { mime: 'image/heic', test: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|mif1|msf1|hevc)$/.test(b.subarray(8, 12).toString('latin1')) },
  webp: { mime: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  tif: { mime: 'image/tiff', test: (b) => (b.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || b.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))) }, // scanned plans
};
const LOCAL = resolve(import.meta.dirname, '..', '.data', 'plans');

const env = (k) => process.env[`PLANS_${k}`] || '';
const BUCKET = env('BUCKET');
const S3 = BUCKET && env('ENDPOINT') && env('ACCESS_KEY_ID') && env('SECRET_ACCESS_KEY') ? {
  host: `${BUCKET}.${new URL(env('ENDPOINT')).host}`, // virtual-hosted style, as Railway's buckets use
  region: env('REGION') || 'auto',
  id: env('ACCESS_KEY_ID'),
  secret: env('SECRET_ACCESS_KEY'),
} : null;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
/** RFC 3986 encoding, as AWS Signature V4 wants it. */
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const keyPath = (key) => `/${key.split('/').map(enc).join('/')}`;

function signingKey(day) {
  return hmac(hmac(hmac(hmac(`AWS4${S3.secret}`, day), S3.region), 's3'), 'aws4_request');
}

/** One S3 request, signed with AWS Signature Version 4 (no SDK needed for put, get and delete). */
async function s3(method, key, body = Buffer.alloc(0), type) {
  const amz = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amz.slice(0, 8);
  const scope = `${day}/${S3.region}/s3/aws4_request`;
  const payload = sha256(body);
  const headers = { host: S3.host, 'x-amz-content-sha256': payload, 'x-amz-date': amz };
  const signed = Object.keys(headers).sort();
  const canonical = [method, keyPath(key), '', ...signed.map((h) => `${h}:${headers[h]}`), '', signed.join(';'), payload].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha256(canonical)].join('\n');
  const signature = hmac(signingKey(day), toSign).toString('hex');
  const r = await fetch(`https://${S3.host}${keyPath(key)}`, {
    method,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${S3.id}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`,
      ...(type ? { 'content-type': type } : {}),
    },
    body: method === 'PUT' ? body : undefined,
  });
  if (!r.ok && !(method === 'DELETE' && r.status === 404)) {
    const code = /<Code>([^<]{1,64})<\/Code>/.exec(await r.text())?.[1] ?? '';
    throw new Error(`bucket ${method} failed: ${r.status} ${code}`);
  }
}

/** A link to fetch one file for `seconds`, as a download with its original name. */
function presign(key, name, seconds = 300) {
  const amz = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amz.slice(0, 8);
  const scope = `${day}/${S3.region}/s3/aws4_request`;
  const q = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${S3.id}/${scope}`,
    'X-Amz-Date': amz,
    'X-Amz-Expires': String(seconds),
    'X-Amz-SignedHeaders': 'host',
    'response-content-disposition': `attachment; filename="${name.replace(/[^\w.\- ]/g, '_')}"`,
  };
  const query = Object.keys(q).sort().map((k) => `${enc(k)}=${enc(q[k])}`).join('&');
  const canonical = ['GET', keyPath(key), query, `host:${S3.host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha256(canonical)].join('\n');
  return `https://${S3.host}${keyPath(key)}?${query}&X-Amz-Signature=${hmac(signingKey(day), toSign).toString('hex')}`;
}

/** Times per key within a window: sign-ups and uploads per address, lookups per address. */
class Window {
  constructor(ms) {
    this.ms = ms;
    this.map = new Map();
  }
  hit(key, max) {
    const now = Date.now();
    const list = (this.map.get(key) || []).filter((t) => now - t < this.ms);
    if (list.length >= max) return this.map.set(key, list), false;
    list.push(now);
    this.map.set(key, list);
    if (this.map.size > 5000) for (const [k, v] of this.map) if (!v.some((t) => now - t < this.ms)) this.map.delete(k);
    return true;
  }
}

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

export class Interest {
  constructor(store, { json, clientKey }) {
    this.store = store;
    this.json = json;
    this.clientKey = clientKey; // who counts as one sender (an IPv4 address or an IPv6 /64)
    this.signups = new Window(3600_000);
    this.daily = new Window(24 * 3600_000);
    this.uploads = new Window(3600_000);
    this.lookups = new Window(60_000);
    this.busy = 0; // uploads being received now
    this.uploading = new Set(); // sign-ups with an upload in progress: one at a time each
    this.cache = new Map(); // address lookups, a few hundred at most
    this.countCache = { at: 0, n: 0 };
    // Plans whose delete failed (the bucket out of reach): kept in a list in the database and tried
    // again at start and every ten minutes, so a withdrawn plan is never forgotten in the bucket.
    setTimeout(() => void this.retryDeletes(), 5000).unref();
    setInterval(() => void this.retryDeletes(), 600_000).unref();
  }

  async deleteFile(key) {
    if (S3) await s3('DELETE', key);
    else await rm(join(LOCAL, key.slice(6)), { force: true });
  }

  /** Delete these plans; any that fail go on the durable to-delete list. */
  async deleteFiles(keys) {
    const results = await Promise.allSettled(keys.map((k) => this.deleteFile(k)));
    const failed = keys.filter((_, i) => results[i].status === 'rejected');
    if (!failed.length) return;
    console.error(JSON.stringify({ event: 'plan_delete_failed', count: failed.length }));
    const list = JSON.parse((await this.store.getMeta('plans_to_delete')) || '[]');
    await this.store.setMeta('plans_to_delete', JSON.stringify([...new Set([...list, ...failed])]));
  }

  async retryDeletes() {
    try {
      const list = JSON.parse((await this.store.getMeta('plans_to_delete')) || '[]');
      if (!list.length) return;
      const results = await Promise.allSettled(list.map((k) => this.deleteFile(k)));
      const left = list.filter((_, i) => results[i].status === 'rejected');
      await this.store.setMeta('plans_to_delete', JSON.stringify(left));
      console.log(JSON.stringify({ event: 'plan_delete_retry', done: list.length - left.length, left: left.length }));
    } catch (e) {
      console.error('plan delete retry failed', String(e));
    }
  }

  get storage() {
    return S3 ? 'bucket' : 'local';
  }

  /** Answers the paths it knows (true), or leaves them (false). `admin`: the request's session is the admin's. */
  async handle(req, res, url, admin) {
    const p = url.pathname;
    const m = req.method;
    let r;
    if (p === '/api/address' && m === 'GET') return (await this.address(req, res, url), true);
    if (p === '/api/interest/count' && m === 'GET') return (await this.count(res), true);
    if (p === '/api/interest' && m === 'POST') return (await this.signUp(req, res), true);
    if ((r = /^\/api\/interest\/(\d{1,9})\/plans$/.exec(p)) && m === 'PUT') return (await this.upload(req, res, url, +r[1]), true);
    if ((r = /^\/api\/interest\/(\d{1,9})$/.exec(p)) && (m === 'GET' || m === 'DELETE' || m === 'PATCH')) return (await this.own(req, res, url, +r[1]), true);
    if (!p.startsWith('/api/admin/interest')) return false;
    if (!admin) return (await this.json(res, 403, { error: 'Admin only' }), true);
    if (p === '/api/admin/interest' && m === 'GET') return (await this.list(res), true);
    if ((r = /^\/api\/admin\/interest\/(\d{1,9})\/file\/(\d)$/.exec(p)) && m === 'GET') return (await this.file(res, +r[1], +r[2]), true);
    if ((r = /^\/api\/admin\/interest\/(\d{1,9})$/.exec(p)) && m === 'POST') return (await this.mark(req, res, +r[1]), true);
    if ((r = /^\/api\/admin\/interest\/(\d{1,9})$/.exec(p)) && m === 'DELETE') return (await this.remove(res, +r[1]), true);
    return (await this.json(res, 404, { error: 'Not found' }), true);
  }

  /** Street suggestions from the Flemish address register (geo.api.vlaanderen.be), at most 30 lookups a minute per sender. */
  async address(req, res, url) {
    const q = clean(url.searchParams.get('q'), 80);
    if (q.length < 3 || !/^[\p{L}\p{N} ,.'\-/]+$/u.test(q)) return this.json(res, 200, { suggestions: [] });
    if (!this.lookups.hit(this.clientKey(req), 30)) return this.json(res, 429, { error: 'Slow down' });
    const key = q.toLowerCase();
    if (!this.cache.has(key)) {
      try {
        const r = await fetch(`https://geo.api.vlaanderen.be/geolocation/v4/Suggestion?q=${encodeURIComponent(q)}&c=6`, { signal: AbortSignal.timeout(4000) });
        const data = r.ok ? await r.json() : {};
        const list = Array.isArray(data.SuggestionResult) ? data.SuggestionResult.filter((s) => typeof s === 'string').map((s) => s.slice(0, 120)).slice(0, 6) : [];
        if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(key, list);
      } catch {
        return this.json(res, 200, { suggestions: [] });
      }
    }
    this.json(res, 200, { suggestions: this.cache.get(key) });
  }

  async count(res) {
    if (Date.now() - this.countCache.at > 30_000) this.countCache = { at: Date.now(), n: await this.store.countInterest() };
    this.json(res, 200, { count: this.countCache.n });
  }

  async signUp(req, res) {
    const b = await readJson(req, 16_384);
    if (b.website) return this.json(res, 200, { id: 0, token: '' }); // the trap field: a bot, pretend it worked
    const name = clean(b.name, 80);
    const email = clean(b.email, 200).toLowerCase();
    if (!name) return this.json(res, 400, { error: 'name' });
    if (!EMAIL.test(email)) return this.json(res, 400, { error: 'email' });
    if (b.age !== true) return this.json(res, 400, { error: 'age' }); // 13 or older (younger: a parent signs up)
    const house = b.house === true;
    // Lives there or may share, the model public, the plans never published, and the plans read by
    // an AI service (Claude, by Anthropic) to help build the model.
    const consent = { own: b.consent?.own === true, model: b.consent?.model === true, private: b.consent?.private === true, ai: b.consent?.ai === true };
    if (house && !(consent.own && consent.model && consent.private && consent.ai)) return this.json(res, 400, { error: 'consent' });
    const who = this.clientKey(req);
    if (!this.signups.hit(who, 5) || !this.daily.hit('all', 300)) return this.json(res, 429, { error: 'busy' });
    const token = randomBytes(18).toString('base64url');
    const entry = {
      name, email,
      address: clean(b.address, 160),
      when: Array.isArray(b.when) ? WHEN.filter((w) => b.when.includes(w)) : [],
      party: Math.max(1, Math.min(10, Math.round(Number(b.party) || 1))),
      comments: clean(b.comments, 2000).replace(/ {2,}/g, ' '),
      // An email once the meetup is planned, only if ticked (consent, with its time as proof).
      updates: b.updates === true, updatesAt: b.updates === true ? new Date().toISOString() : null,
      house, consent: house ? { ...consent, at: new Date().toISOString() } : null,
      lang: b.lang === 'en' ? 'en' : 'nl',
      files: [], status: 'new', note: '',
      at: new Date().toISOString(),
    };
    const id = await this.store.addInterest(entry, sha256(token));
    this.countCache.at = 0;
    console.log(JSON.stringify({ event: 'interest', id, house }));
    this.changed();
    this.json(res, 200, { id, token });
  }

  /** The sign-up whose secret this request carries (X-Interest-Token), or null. */
  async owned(req, id) {
    const token = String(req.headers['x-interest-token'] || '');
    const row = token.length >= 20 && token.length <= 64 ? await this.store.getInterest(id) : null;
    if (!row) return null;
    const a = Buffer.from(sha256(token), 'hex');
    const b = Buffer.from(row.tokenHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b) ? row : null;
  }

  /** One file of plans, as the raw body (its name in X-File-Name), within a day of signing up. */
  async upload(req, res, url, id) {
    sameOrigin(req);
    const row = await this.owned(req, id);
    if (!row) return this.json(res, 404, { error: 'Not found' });
    const e = row.data;
    if (!e.house) return this.json(res, 400, { error: 'consent' });
    if (Date.now() - Date.parse(e.at) > UPLOAD_HOURS * 3600_000) return this.json(res, 410, { error: 'late' });
    if (e.files.length >= MAX_FILES) return this.json(res, 400, { error: 'files' });
    const size = Number(req.headers['content-length']);
    if (!(size > 0) || size > MAX_FILE) return this.json(res, 413, { error: 'size' });
    if ((await this.store.interestBytes()) + size > MAX_TOTAL) return this.json(res, 507, { error: 'full' });
    if (!this.uploads.hit(this.clientKey(req), 30) || this.busy >= 3 || this.uploading.has(id)) return this.json(res, 429, { error: 'busy' });
    this.busy++;
    this.uploading.add(id);
    try {
      const data = await readRaw(req, MAX_FILE);
      const ext = Object.keys(TYPES).find((k) => TYPES[k].test(data));
      if (!ext) return this.json(res, 415, { error: 'type' });
      const key = `plans/${id}/${randomBytes(9).toString('base64url')}.${ext}`;
      if (S3) await s3('PUT', key, data, TYPES[ext].mime);
      else {
        await mkdir(join(LOCAL, String(id)), { recursive: true });
        await writeFile(join(LOCAL, key.slice(6)), data);
      }
      let name = '';
      try {
        name = decodeURIComponent(String(req.headers['x-file-name'] || ''));
      } catch {
        // a bad name: just the type
      }
      const file = { key, name: clean(name, 120) || `plan.${ext}`, size: data.length, type: ext, at: new Date().toISOString() };
      // Recorded in one step, only while the sign-up still exists and has room. If it was withdrawn
      // meanwhile (or another upload took the last place), the file just stored goes again: no plan
      // may outlive a withdrawal.
      if (!(await this.store.appendInterestFile(id, file, MAX_FILES))) {
        await this.deleteFiles([key]);
        return this.json(res, 409, { error: 'gone' });
      }
      console.log(JSON.stringify({ event: 'interest_plan', id, size: data.length, type: ext }));
      this.changed();
      this.json(res, 200, { ok: true, files: e.files.length + 1 });
    } finally {
      this.busy--;
      this.uploading.delete(id);
    }
  }

  /** The sign-up's own link: see what was sent, switch the email once it's planned, or withdraw it (with the plans). */
  async own(req, res, url, id) {
    const row = await this.owned(req, id);
    if (!row) return this.json(res, 404, { error: 'Not found' });
    if (req.method === 'DELETE') {
      sameOrigin(req);
      await this.erase(id);
      console.log(JSON.stringify({ event: 'interest_withdrawn', id }));
      return this.json(res, 200, { ok: true });
    }
    if (req.method === 'PATCH') {
      sameOrigin(req);
      const b = await readJson(req, 1024);
      if (typeof b.updates !== 'boolean') return this.json(res, 400, { error: 'updates' });
      await this.store.updateInterest(id, { updates: b.updates, updatesAt: b.updates ? new Date().toISOString() : null });
      this.changed();
      return this.json(res, 200, { ok: true });
    }
    const { name, email, address, when, party, comments, updates, house, files, at } = row.data;
    this.json(res, 200, { name, email, address, when, party, comments, updates: !!updates, house, files: files.map((f) => ({ name: f.name, size: f.size })), at });
  }

  async list(res) {
    const rows = await this.store.listInterest();
    this.json(res, 200, {
      storage: this.storage,
      entries: rows.map(({ id, data }) => ({ id, ...data, files: data.files.map((f) => ({ name: f.name, size: f.size, type: f.type })) })),
    });
  }

  /** The admin downloads plan n: sent on to a five-minute link to the bucket (or the local file itself). */
  async file(res, id, n) {
    const row = await this.store.getInterest(id);
    const f = row?.data.files[n];
    if (!f) return this.json(res, 404, { error: 'Not found' });
    if (S3) {
      res.writeHead(302, { Location: presign(f.key, f.name), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      return res.end();
    }
    const data = await readFile(join(LOCAL, f.key.slice(6)));
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${f.name.replace(/[^\w.\- ]/g, '_')}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  }

  async mark(req, res, id) {
    const b = await readJson(req, 4096);
    const row = await this.store.getInterest(id);
    if (!row) return this.json(res, 404, { error: 'Not found' });
    const patch = {};
    if (STATUS.includes(b.status)) patch.status = b.status;
    if (typeof b.note === 'string') patch.note = clean(b.note, 1000);
    await this.store.updateInterest(id, patch);
    this.json(res, 200, { ok: true });
  }

  async remove(res, id) {
    const row = await this.store.getInterest(id);
    if (!row) return this.json(res, 404, { error: 'Not found' });
    await this.erase(id);
    console.log(JSON.stringify({ event: 'interest_removed', id }));
    this.json(res, 200, { ok: true });
  }

  /**
   * A sign-up and its plans, gone. The row goes first, in one statement that hands back the files it
   * held at that moment; those are deleted after (a failed delete is retried, see deleteFiles). An
   * upload finishing later finds no row and deletes its own file (see upload): nothing is left behind.
   */
  async erase(id) {
    const e = await this.store.takeInterest(id);
    this.countCache.at = 0;
    this.changed();
    await this.deleteFiles((e?.files ?? []).map((f) => f.key));
  }

  /** Tells the admin page's live view (server/stats.mjs) that the sign-ups changed. */
  changed() {
    this.onChange?.();
  }
}

/** Only requests from this site's own pages (no cross-site posts or uploads). */
function sameOrigin(req) {
  let host = '';
  try {
    host = new URL(String(req.headers.origin || '')).host;
  } catch {
    // no Origin
  }
  if (host !== req.headers.host) throw Object.assign(new Error('Bad origin'), { status: 403 });
}

async function readRaw(req, max) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) throw Object.assign(new Error('Too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, max) {
  sameOrigin(req);
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('JSON only'), { status: 415 });
  try {
    return JSON.parse((await readRaw(req, max)).toString('utf8') || '{}');
  } catch (e) {
    if (e.status) throw e;
    throw Object.assign(new Error('Bad JSON'), { status: 400 });
  }
}
