// Feedback from players (Yoshi, 1 Nov 2026): after two minutes of play the game asks once for
// 1 to 5 stars and a comment (src/ui/feedback.ts). Both are optional; a report needs one of them.
// Each is kept with a name, the address and the time, for the admin page's Feedback tab: players
// together by their name in the game (the session's), players alone by the name they typed (never
// checked, so the admin page says "as typed"). The address goes after 90 days, as the login log's
// does; the stars, the comment and the name stay until the admin deletes them. The privacy policy
// says so.
//
// Public: POST /api/feedback. Admin only: GET /api/admin/feedback, DELETE /api/admin/feedback/:id.
//
// Guarded against: cross-site posts (same-origin JSON bodies of at most 4 KB, server.mjs), floods
// (3 an hour per address, 300 a day in all), and stored XSS (a comment is kept as plain text and the
// admin page only ever draws it with textContent). Server logs get the stars only, never the text.

const COMMENT = 600; // characters (the text box's maxlength too)
const IP_DAYS = 90;
const MODES = ['explore', 'action', 'paintball'];

/** Times per key within a window. */
class Window {
  constructor(ms) {
    this.ms = ms;
    this.map = new Map();
  }
  hit(key, max) {
    const now = Date.now();
    const list = (this.map.get(key) || []).filter((t) => now - t < this.ms);
    const ok = list.length < max;
    if (ok) list.push(now);
    this.map.set(key, list);
    if (this.map.size > 5000) for (const [k, v] of this.map) if (!v.some((t) => now - t < this.ms)) this.map.delete(k);
    return ok;
  }
}

/** A comment as typed: line breaks kept (at most one empty line in a row), other control characters out. */
const comment = (v) => (typeof v === 'string' ? v : '')
  .normalize('NFC')
  .replace(/\r\n?/g, '\n')
  .replace(/[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim()
  .slice(0, COMMENT);
/** A solo player's name as typed, as the login log keeps it (server/stats.mjs): letters, digits and a few signs. */
const typedName = (v) => {
  const s = typeof v === 'string' ? v.normalize('NFC').replace(/[^\p{L}\p{N} _.'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 20) : '';
  return s && s !== 'Guest' && s !== 'Gast' ? s : '';
};

export class Feedback {
  /**
   * `readJson`: a same-origin JSON body; `clientKey`: who counts as one sender; `clientIp`: the address
   * kept; `session`: the request's session or null; `time`: the Belgian time as the log writes it.
   */
  constructor(store, { json, readJson, clientKey, clientIp, session, time }) {
    Object.assign(this, { store, json, readJson, clientKey, clientIp, session, time });
    this.perSender = new Window(3600_000);
    this.daily = new Window(24 * 3600_000);
    this.onChange = () => {}; // the admin page's live view (server/stats.mjs)
    const prune = () => this.store.pruneFeedbackIps(IP_DAYS).catch((e) => console.error('feedback prune failed', String(e)));
    setTimeout(prune, 10_000).unref();
    setInterval(prune, 6 * 3600_000).unref();
  }

  /** Answers the paths it knows (true), or leaves them (false). `admin`: the request's session is the admin's. */
  async handle(req, res, url, admin) {
    const p = url.pathname;
    const m = req.method;
    if (p === '/api/feedback' && m === 'POST') return (await this.submit(req, res), true);
    if (!p.startsWith('/api/admin/feedback')) return false;
    if (!admin) return (await this.json(res, 403, { error: 'Admin only' }), true);
    if (p === '/api/admin/feedback' && m === 'GET') return (await this.json(res, 200, { rows: await this.store.listFeedback(1000) }), true);
    const r = /^\/api\/admin\/feedback\/(\d{1,9})$/.exec(p);
    if (r && m === 'DELETE') {
      await this.store.deleteFeedback(+r[1]);
      this.onChange();
      return (await this.json(res, 200, { ok: true }), true);
    }
    return (await this.json(res, 404, { error: 'Not found' }), true);
  }

  async submit(req, res) {
    const b = await this.readJson(req);
    const stars = Number.isInteger(b.stars) && b.stars >= 1 && b.stars <= 5 ? b.stars : null;
    const text = comment(b.comment);
    if (!stars && !text) return this.json(res, 400, { error: 'Empty' });
    if (!this.perSender.hit(this.clientKey(req), 3) || !this.daily.hit('all', 300)) return this.json(res, 429, { error: 'Thanks, that is enough for now' });
    const s = this.session(req);
    const entry = {
      time: this.time(),
      stars,
      comment: text,
      name: s ? s.username : typedName(b.name),
      typed: !s, // alone: the name as typed, never checked
      together: !!s,
      ip: this.clientIp(req),
      mode: MODES.includes(b.mode) ? b.mode : '',
      lang: b.lang === 'en' ? 'en' : 'nl',
    };
    const id = await this.store.addFeedback(entry);
    console.log(JSON.stringify({ event: 'feedback', id, stars }));
    this.onChange();
    this.json(res, 200, { ok: true });
  }
}
