// The game night page (web/public/inschrijven/, Yoshi, 2 Nov 2026): signing up for the game night
// with a name, a first name, an email address, a street (the night is first of all for Smetlede; the
// page suggests streets through /api/address, server/interest.mjs), how many come to play (each needs
// a laptop or PC) and how many to watch, and ideas or wishes. The place, the date and the time are the admin's to set on
// the admin page. Until then the page says they are still to be decided. The admin closes the
// registrations when the hall is full; the page says so, and that a registration may be turned down
// or cancelled if more come in than there is room for.
//
// Public: GET /api/gamenight (the place, the date, the time, open or closed), POST /api/gamenight (a sign-up),
// GET and DELETE /api/gamenight/:id with the sign-up's own secret, to see or cancel it. The secret
// travels in the X-Gamenight-Token header, never in a URL that could end up in a log.
// Admin only: GET /api/admin/gamenight (the details and every sign-up), POST /api/admin/gamenight/event
// (the details), DELETE /api/admin/gamenight/:id (one sign-up), DELETE /api/admin/gamenight (all of
// them, after the night).
//
// Guarded against: cross-site posts (same-origin JSON bodies of at most 4 KB, server.mjs; the
// deletes go through the same check), spam and floods (a trap field, 5 sign-ups an hour per address,
// 300 a day in all), stored XSS (what was typed is kept as plain text and both pages draw it with
// textContent only) and guessing someone's sign-up (a 144-bit secret, stored only as a hash and
// compared in constant time).

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Window } from './feedback.mjs';

const MAX_PEOPLE = 10; // players, and watchers, per sign-up
const WISHES = 1000; // characters (the text box's maxlength too): the whole body stays under 4 KB
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A day of the calendar as 'YYYY-MM-DD', and only one that exists (no 31 February). */
const isDate = (v) => {
  const t = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T12:00:00Z`) : NaN;
  return Number.isFinite(t) && new Date(t).toISOString().startsWith(v);
};
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
/** Text direction marks and overrides: they would make a name or an address on the admin page read backwards. */
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const clean = (v, max) => String(v ?? '').normalize('NFC').replace(BIDI, '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
/** Ideas as typed: line breaks kept (at most one empty line in a row), other control characters out. */
const text = (v) => (typeof v === 'string' ? v : '')
  .normalize('NFC')
  .replace(BIDI, '')
  .replace(/\r\n?/g, '\n')
  .replace(/[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim()
  .slice(0, WISHES);
const people = (v) => (Number.isInteger(v) && v >= 0 && v <= MAX_PEOPLE ? v : null);

export class GameNight {
  /** `readJson`: a same-origin JSON body; `clientKey`: who counts as one sender. */
  constructor(store, { json, readJson, clientKey }) {
    Object.assign(this, { store, json, readJson, clientKey });
    this.signups = new Window(3600_000);
    this.daily = new Window(24 * 3600_000);
    this.details = null; // the place, the date and the time, read from the store once
    this.onChange = () => {}; // the admin page's live view (server/stats.mjs)
  }

  /** Answers the paths it knows (true), or leaves them (false). `admin`: the request's session is the admin's. */
  async handle(req, res, url, admin) {
    const p = url.pathname;
    const m = req.method;
    let r;
    if (p === '/api/gamenight' && m === 'GET') return (await this.json(res, 200, await this.event()), true);
    if (p === '/api/gamenight' && m === 'POST') return (await this.signUp(req, res), true);
    if ((r = /^\/api\/gamenight\/(\d{1,9})$/.exec(p)) && (m === 'GET' || m === 'DELETE')) return (await this.own(req, res, +r[1]), true);
    if (!p.startsWith('/api/admin/gamenight')) return false;
    if (!admin) return (await this.json(res, 403, { error: 'Admin only' }), true);
    if (p === '/api/admin/gamenight' && m === 'GET') return (await this.list(res), true);
    if (p === '/api/admin/gamenight/event' && m === 'POST') return (await this.setEvent(req, res), true);
    if (p === '/api/admin/gamenight' && m === 'DELETE') {
      await this.readJson(req);
      const n = await this.store.clearGamenight();
      console.log(JSON.stringify({ event: 'gamenight_cleared', n }));
      this.onChange();
      return (await this.json(res, 200, { ok: true, deleted: n }), true);
    }
    if ((r = /^\/api\/admin\/gamenight\/(\d{1,9})$/.exec(p)) && m === 'DELETE') {
      await this.readJson(req);
      await this.store.deleteGamenight(+r[1]);
      this.onChange();
      return (await this.json(res, 200, { ok: true }), true);
    }
    return (await this.json(res, 404, { error: 'Not found' }), true);
  }

  /**
   * The place, the date ('YYYY-MM-DD') and the times ('HH:MM'): empty while still to be decided. `open`:
   * whether the night takes registrations. The admin closes it when the hall is full (Yoshi, 2 Nov 2026).
   */
  async event() {
    if (!this.details) {
      let saved = {};
      try {
        saved = JSON.parse((await this.store.getMeta('gamenight_event')) || '{}');
      } catch {
        // unreadable: still to be decided
      }
      this.details = {
        place: clean(saved.place, 200),
        date: isDate(saved.date) ? saved.date : '',
        from: TIME.test(saved.from ?? '') ? saved.from : '',
        until: TIME.test(saved.until ?? '') ? saved.until : '',
        open: saved.open !== false,
      };
    }
    return this.details;
  }

  async setEvent(req, res) {
    const b = await this.readJson(req);
    const d = {
      place: clean(b.place, 200),
      date: isDate(b.date) ? b.date : '',
      from: typeof b.from === 'string' && TIME.test(b.from) ? b.from : '',
      until: typeof b.until === 'string' && TIME.test(b.until) ? b.until : '',
      open: b.open !== false,
    };
    const was = (await this.event()).open;
    await this.store.setMeta('gamenight_event', JSON.stringify(d));
    if (d.open !== was) console.log(JSON.stringify({ event: d.open ? 'gamenight_opened' : 'gamenight_closed' }));
    this.details = d;
    this.onChange();
    this.json(res, 200, d);
  }

  async signUp(req, res) {
    const b = await this.readJson(req);
    if (b.website) return this.json(res, 200, { id: 0, token: '' }); // the trap field: a bot, pretend it worked
    if (!(await this.event()).open) return this.json(res, 409, { error: 'closed' }); // the hall is full
    const lastName = clean(b.lastName, 80);
    const firstName = clean(b.firstName, 80);
    const email = clean(b.email, 200).toLowerCase();
    // The street (a house number is up to them): the night is first of all for Smetlede (Yoshi, 2 Nov 2026).
    const address = clean(b.address, 160);
    const players = people(b.players);
    const watchers = people(b.watchers);
    if (!lastName) return this.json(res, 400, { error: 'lastName' });
    if (!firstName) return this.json(res, 400, { error: 'firstName' });
    if (!EMAIL.test(email)) return this.json(res, 400, { error: 'email' });
    if (address.length < 3) return this.json(res, 400, { error: 'address' });
    if (players === null || watchers === null || players + watchers < 1) return this.json(res, 400, { error: 'people' });
    if (b.age !== true) return this.json(res, 400, { error: 'age' }); // 13 or older (younger: a parent signs up)
    if (!this.signups.hit(this.clientKey(req), 5) || !this.daily.hit('all', 300)) return this.json(res, 429, { error: 'busy' });
    const token = randomBytes(18).toString('base64url');
    const entry = { lastName, firstName, email, address, players, watchers, wishes: text(b.wishes), lang: b.lang === 'en' ? 'en' : 'nl', at: new Date().toISOString() };
    const id = await this.store.addGamenight(entry, sha256(token));
    console.log(JSON.stringify({ event: 'gamenight_signup', id, players, watchers }));
    this.onChange();
    this.json(res, 200, { id, token });
  }

  /** The sign-up's own link: see what was sent (with the night's details), or cancel it. */
  async own(req, res, id) {
    const token = String(req.headers['x-gamenight-token'] || '');
    const row = token.length >= 20 && token.length <= 64 ? await this.store.getGamenight(id) : null;
    const a = Buffer.from(sha256(token), 'hex');
    const b = Buffer.from(row?.tokenHash ?? '', 'hex');
    if (!row || a.length !== b.length || !timingSafeEqual(a, b)) return this.json(res, 404, { error: 'Not found' });
    if (req.method === 'DELETE') {
      await this.readJson(req);
      await this.store.deleteGamenight(id);
      console.log(JSON.stringify({ event: 'gamenight_cancelled', id }));
      this.onChange();
      return this.json(res, 200, { ok: true });
    }
    const { lastName, firstName, email, address, players, watchers, wishes, at } = row.data;
    this.json(res, 200, { lastName, firstName, email, address: address ?? '', players, watchers, wishes, at, event: await this.event() });
  }

  async list(res) {
    const rows = await this.store.listGamenight();
    this.json(res, 200, { event: await this.event(), entries: rows.map(({ id, data }) => ({ id, ...data })) });
  }
}
