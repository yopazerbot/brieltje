// The admin page (brieltje.be/admin): log in with the game's admin account, then four tabs, kept
// current by a live stream (GET /api/admin/live: today's numbers, who is playing, new log lines,
// changed sign-ups); the 60 days behind the charts are fetched again every minute.
// Overview: how much the game is played (server/stats.mjs: daily totals only, nothing per person)
// with the last 30 days as bar charts and how people play. Sign-ups: the interest page's sign-ups
// (server/interest.mjs) with status, notes, plans and delete. Logins: the login log. Online now.
// Everything a visitor typed or a server log holds is shown with textContent, never as HTML.
(() => {
  const $ = (id) => document.getElementById(id);
  const WHEN = { weekday: 'Weekday evening', saturday: 'Saturday', sunday: 'Sunday' };
  const STATUS = ['new', 'contacted', 'modelled', 'declined'];
  const EVENTS = {
    login_ok: ['Admin logged in', 'good', 'in'], join_ok: ['Joined with the PIN', 'good', 'in'], mp_join: ['Entered the game', '', 'in'],
    login_failed: ['Wrong password', 'bad', 'failed'], pin_failed: ['Wrong PIN', 'bad', 'failed'], pin_limited: ['PIN attempts paused', 'bad', 'failed'],
    login_admin_limited: ['Admin login paused', 'bad', 'failed'], login_blocked_kicked: ['Removed player tried again', 'bad', 'failed'],
    kick: ['Player removed', '', 'admin'], pin_changed: ['PIN changed', '', 'admin'], rules: ['House rules changed', '', 'admin'], round_won: ['Round won', '', ''],
  };
  let entries = [];
  let log = [];
  let tab = 'overview';
  let stats = null; // the last /api/admin/stats answer, today's numbers updated live
  let playing = { together: [], alone: [] };
  let live = null;
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const svg = (tag, attrs = {}) => {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    return e;
  };
  const post = (url, data, method = 'POST') =>
    fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
  const fmt = (n) => Math.round(n).toLocaleString('en-GB');
  const dayName = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

  // ---- logging in, and the tabs
  async function start() {
    const r = await fetch('/api/admin/stats').catch(() => null);
    document.body.classList.toggle('signed-out', !r?.ok);
    if (!r || r.status === 401 || r.status === 403) {
      $('login').hidden = false;
      $('app').hidden = true;
      $('logout').hidden = true;
      $('pass').focus();
      return;
    }
    $('login').hidden = true;
    $('app').hidden = false;
    $('logout').hidden = false;
    // Each part on its own, so one that fails doesn't keep the others from loading.
    try {
      stats = await r.json();
      playing = stats.playing ?? playing;
      overview(stats);
    } catch (e) {
      console.error('overview', e);
    }
    loadSignups();
    loadLog();
    connect();
  }

  // ---- live
  function connect() {
    live?.close();
    live = new EventSource('/api/admin/live');
    const dot = $('live');
    live.addEventListener('open', () => {
      dot.classList.add('on');
      dot.title = 'Live';
    });
    live.addEventListener('error', () => {
      dot.classList.remove('on');
      dot.title = 'Reconnecting…';
      if (live.readyState === EventSource.CLOSED) setTimeout(start, 3000); // refused: logged out elsewhere?
    });
    live.addEventListener('today', (e) => {
      const { day, counts } = JSON.parse(e.data);
      if (!stats) return;
      const last = stats.days[stats.days.length - 1];
      if (last.day !== day) return void refreshStats(); // a new day: fetch the 60 days again
      Object.assign(last, counts);
      if (tab === 'overview') overview(stats);
    });
    live.addEventListener('playing', (e) => {
      playing = JSON.parse(e.data);
      drawPlaying();
    });
    live.addEventListener('log', (e) => {
      log = [...JSON.parse(e.data).reverse(), ...log].slice(0, 2000);
      if (tab === 'logins') drawLog();
    });
    live.addEventListener('signups', () => {
      // Not while a note is being typed: it would be drawn over.
      if (document.activeElement?.closest?.('#entries')) return;
      loadSignups();
    });
  }
  for (const b of document.querySelectorAll('.tabs button')) {
    b.addEventListener('click', () => {
      tab = b.dataset.tab;
      for (const x of document.querySelectorAll('.tabs button')) x.setAttribute('aria-selected', String(x === b));
      for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== tab;
      if (tab === 'online' || tab === 'overview') refreshStats();
      if (tab === 'logins') loadLog();
      if (tab === 'signups') loadSignups();
    });
  }
  async function refreshStats() {
    const r = await fetch('/api/admin/stats').catch(() => null);
    if (!r?.ok) return;
    stats = await r.json();
    overview(stats);
  }
  setInterval(() => { if (!$('app').hidden) refreshStats(); }, 60_000);

  // ---- overview
  function overview(data) {
    const days = data.days; // oldest first, 60 days
    const last = (n) => days.slice(-n);
    const sum = (list, k) => list.reduce((a, d) => a + (d[k] || 0), 0);
    const max = (list, k) => list.reduce((a, d) => Math.max(a, d[k] || 0), 0);
    $('since').textContent = data.since ? `Counting since ${dayName(data.since)}.` : 'Counting has just started: the numbers fill up from today.';
    const kpis = [
      ['Playing now', playing.together.length + playing.alone.length],
      ['Visitors today', sum(last(1), 'game_visitors')],
      ['Visitors, 7 days', sum(last(7), 'game_visitors')],
      ['Visitors, 30 days', sum(last(30), 'game_visitors')],
      ['Games started, 30 days', sum(last(30), 'starts')],
      ['Hours played, 30 days', sum(last(30), 'minutes') / 60],
      ['Most players at once, 30 days', max(last(30), 'peak_players')],
      ['Interest sign-ups', data.interest],
    ];
    $('kpis').replaceChildren(...kpis.map(([label, value]) => {
      const s = el('div', 'stat');
      s.append(el('b', '', fmt(value)), el('span', 'muted small', label));
      return s;
    }));
    const month = last(30);
    $('charts').replaceChildren(
      chart('Visitors per day', month, 'game_visitors', 'visitors'),
      chart('Games started per day', month, 'starts', 'games'),
      chart('Minutes played per day', month, 'minutes', 'minutes'),
      chart('Interest page visitors per day', month, 'interest_visitors', 'visitors'),
    );
    const splits = [
      ['Controls', [['Keyboard and mouse', 'starts_kbm'], ['Controller', 'starts_pad'], ['Touch', 'starts_touch']]],
      ['Mode', [['Explore', 'starts_explore'], ['Action', 'starts_action']]],
      ['Alone or together', [['Alone', 'starts_alone'], ['Together', 'starts_together']]],
      ['Language', [['Nederlands', 'starts_nl'], ['English', 'starts_en']]],
    ];
    $('splits').replaceChildren(...splits.map(([title, rows]) => {
      const box = el('div', 'split');
      box.append(el('h3', '', title));
      const total = rows.reduce((a, [, k]) => a + sum(month, k), 0);
      for (const [label, k] of rows) {
        const n = sum(month, k);
        const row = el('div', 'row');
        row.append(el('span', '', label), el('span', 'muted', total ? `${fmt(n)} · ${Math.round((100 * n) / total)}%` : '0'));
        const track = el('div', 'track');
        const fill = el('div', 'fill');
        fill.style.width = total ? `${(100 * n) / total}%` : '0';
        track.append(fill);
        row.append(track);
        box.append(row);
      }
      return box;
    }));
    drawPlaying();
  }

  /** Online now: the players together by name, the ones alone anonymous (what they play, for how long). */
  function drawPlaying() {
    const CONTROL = { kbm: 'keyboard and mouse', pad: 'controller', touch: 'touch' };
    const { together, alone } = playing;
    $('online-count').textContent = together.length || alone.length
      ? `${together.length} playing together, ${alone.length} alone.`
      : 'Nobody is playing right now.';
    const items = together.map((p) => {
      const li = el('li');
      const dot = el('i');
      dot.style.background = /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : '#888';
      li.append(dot, el('span', '', p.name), el('span', 'muted small', p.role === 'admin' ? 'together · admin' : 'together'));
      return li;
    });
    for (const v of alone) {
      const li = el('li', 'alone');
      li.append(el('i'), el('span', '', `Alone · ${v.mode === 'action' ? 'Action' : 'Explore'}`),
        el('span', 'muted small', `${CONTROL[v.control] ?? v.control} · ${v.lang === 'nl' ? 'Nederlands' : 'English'} · ${v.minutes < 1 ? 'just started' : `${v.minutes} min`}`));
      items.push(li);
    }
    $('online').replaceChildren(...items);
    // The "Playing now" number on the overview follows without redrawing the charts.
    const tile = document.querySelector('#kpis .stat b');
    if (tile) tile.textContent = fmt(together.length + alone.length);
  }

  /** Bars, one per day, from one baseline: hover or focus a day for its number; the same numbers as a table below. */
  function chart(title, days, key, unit) {
    const box = el('div', 'chart');
    const total = days.reduce((a, d) => a + (d[key] || 0), 0);
    box.append(el('h3', '', title), el('div', 'total', `${fmt(total)} ${unit} in 30 days`));
    const W = 480, H = 150, L = 26, B = 18, T = 6;
    const top = Math.max(1, ...days.map((d) => d[key] || 0));
    const nice = top <= 5 ? 5 : top <= 10 ? 10 : Math.ceil(top / 10) * 10;
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${title}, last 30 days` });
    for (const f of [0, 0.5, 1]) {
      const y = H - B - (H - B - T) * f;
      s.append(svg('line', { x1: L, x2: W, y1: y, y2: y, class: 'grid' }));
      const t = svg('text', { x: L - 4, y: y + 3, 'text-anchor': 'end', class: 'axis' });
      t.textContent = fmt(nice * f);
      s.append(t);
    }
    const slot = (W - L) / days.length;
    const bw = Math.min(24, slot * 0.7);
    days.forEach((d, i) => {
      const v = d[key] || 0;
      const h = ((H - B - T) * v) / nice;
      const x = L + i * slot + (slot - bw) / 2;
      const y = H - B - h;
      const r = Math.min(4, bw / 2, h);
      const hit = svg('rect', { x: L + i * slot, y: T, width: slot, height: H - B - T, class: 'hit', tabindex: 0 });
      const show = (e) => tip(e, `${fmt(v)} ${unit}`, dayName(d.day));
      hit.addEventListener('pointermove', show);
      hit.addEventListener('focus', (e) => tip(e, `${fmt(v)} ${unit}`, dayName(d.day)));
      hit.addEventListener('pointerleave', () => ($('tip').hidden = true));
      hit.addEventListener('blur', () => ($('tip').hidden = true));
      s.append(hit);
      if (h > 0) s.append(svg('path', { class: 'bar', d: `M${x},${H - B}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${H - B}Z` }));
      else s.append(svg('rect', { class: 'bar', x, y: H - B - 0.01, width: bw, height: 0.01 }));
      if (i % 7 === days.length % 7) {
        const t = svg('text', { x: L + i * slot + slot / 2, y: H - 4, 'text-anchor': 'middle', class: 'axis' });
        t.textContent = new Date(`${d.day}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        s.append(t);
      }
    });
    box.append(s);
    const details = el('details');
    details.append(el('summary', '', 'As a table'));
    const table = el('table');
    for (const d of [...days].reverse()) {
      const tr = el('tr');
      tr.append(el('td', '', dayName(d.day)), el('td', '', fmt(d[key] || 0)));
      table.append(tr);
    }
    details.append(table);
    box.append(details);
    return box;
  }
  function tip(e, value, label) {
    const t = $('tip');
    t.replaceChildren(el('b', '', value), el('span', 'muted', label));
    t.hidden = false;
    const r = e.target.getBoundingClientRect();
    const x = e.clientX ?? r.left + r.width / 2;
    t.style.left = `${Math.min(innerWidth - 160, x + 12)}px`;
    t.style.top = `${(e.clientY ?? r.top) - 48}px`;
  }

  // ---- sign-ups
  async function loadSignups() {
    const r = await fetch('/api/admin/interest').catch(() => null);
    if (!r?.ok) return;
    const data = await r.json();
    entries = data.entries;
    $('storage').textContent = data.storage === 'bucket' ? 'Plans are kept in the private Railway bucket.' : 'Plans are kept on this server (no bucket configured).';
    draw();
  }
  function signupStats() {
    const n = (f) => entries.filter(f).length;
    const items = [
      ['Sign-ups', entries.length],
      ['People in all', entries.reduce((a, e) => a + (e.party || 1), 0)],
      ['Want an email when planned', n((e) => e.updates)],
      ['Want their house in', n((e) => e.house)],
      ['Weekday evening', n((e) => e.when.includes('weekday'))],
      ['Saturday', n((e) => e.when.includes('saturday'))],
      ['Sunday', n((e) => e.when.includes('sunday'))],
    ];
    $('stats').replaceChildren(...items.map(([label, value]) => {
      const s = el('div', 'stat');
      s.append(el('b', '', String(value)), el('span', 'muted small', label));
      return s;
    }));
  }
  function draw() {
    signupStats();
    const q = $('search').value.trim().toLowerCase();
    const f = $('filter').value;
    const shown = entries.filter((e) =>
      (!q || [e.name, e.email, e.address, e.comments, e.note].some((v) => (v || '').toLowerCase().includes(q)))
      && (!f || (f === 'house' ? e.house : f === 'updates' ? e.updates : e.status === f)));
    $('empty').hidden = entries.length > 0;
    $('entries').replaceChildren(...shown.map(card));
  }
  function card(e) {
    const box = el('div', 'entry');
    const main = el('div');
    const meta = el('div', 'meta', `${new Date(e.at).toLocaleString('nl-BE')} · ${e.lang === 'en' ? 'English' : 'Nederlands'}`);
    const mail = el('a', '', e.email);
    mail.href = `mailto:${encodeURIComponent(e.email).replace(/%40/g, '@')}`;
    const lines = el('div');
    lines.append(mail);
    if (e.address) lines.append(el('div', '', e.address));
    const tags = el('div');
    tags.append(el('span', 'badge', `${e.party} ${e.party === 1 ? 'person' : 'people'}`));
    for (const w of e.when) tags.append(el('span', 'badge', WHEN[w] || w));
    if (e.updates) tags.append(el('span', 'badge mail', 'Email when planned'));
    if (e.house) tags.append(el('span', 'badge house', 'House in the game'));
    main.append(el('h3', '', e.name), meta, lines, tags);
    if (e.comments) main.append(el('p', '', e.comments));
    if (e.house) {
      const plans = el('div', 'plans');
      if (e.consent) {
        plans.append(el('div', 'meta', `Consent given ${new Date(e.consent.at).toLocaleString('nl-BE')}: lives there or has permission, model public, plans never published${e.consent.ai ? ', plans may go to Claude (Anthropic).' : '.'}`));
        // Signed up before the AI question was asked: these plans may not go to Claude without asking first.
        if (!e.consent.ai) plans.append(el('div', 'meta warn', 'No consent for AI: ask before giving these plans to Claude.'));
      }
      e.files.forEach((f, i) => {
        const a = el('a', '', `⬇ ${f.name} (${(f.size / 1048576).toFixed(1)} MB)`);
        a.href = `/api/admin/interest/${e.id}/file/${i}`;
        a.rel = 'noopener noreferrer';
        plans.append(a);
      });
      if (!e.files.length) plans.append(el('div', 'meta', 'No plans arrived (the upload may have failed).'));
      main.append(plans);
    }
    const side = el('div', 'side');
    const status = el('select');
    for (const s of STATUS) {
      const o = el('option', '', s[0].toUpperCase() + s.slice(1));
      o.value = s;
      status.append(o);
    }
    status.value = e.status;
    status.addEventListener('change', async () => {
      e.status = status.value;
      await post(`/api/admin/interest/${e.id}`, { status: status.value });
    });
    const del = el('button', 'btn danger', 'Delete');
    del.type = 'button';
    let armed = false;
    del.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        del.textContent = 'Sure? Delete with plans';
        setTimeout(() => { armed = false; del.textContent = 'Delete'; }, 4000);
        return;
      }
      const r = await post(`/api/admin/interest/${e.id}`, null, 'DELETE');
      if (r.ok) {
        entries = entries.filter((x) => x !== e);
        draw();
      }
    });
    side.append(status, del);
    const note = el('textarea');
    note.placeholder = 'Your note (only you see it)';
    note.value = e.note || '';
    note.addEventListener('change', () => {
      e.note = note.value;
      void post(`/api/admin/interest/${e.id}`, { note: note.value });
    });
    box.append(main, side, note);
    return box;
  }
  // Everyone shown who asked for an email, ready for Bcc (never To: they don't see each other).
  $('copy-emails').addEventListener('click', async () => {
    const q = $('search').value.trim().toLowerCase();
    const f = $('filter').value;
    const list = entries.filter((e) => e.updates
      && (!q || [e.name, e.email, e.address, e.comments, e.note].some((v) => (v || '').toLowerCase().includes(q)))
      && (!f || (f === 'house' ? e.house : f === 'updates' ? e.updates : e.status === f))).map((e) => e.email);
    $('copied').hidden = false;
    if (!list.length) return ($('copied').textContent = 'Nobody shown asked for an email.');
    try {
      await navigator.clipboard.writeText(list.join(', '));
      $('copied').textContent = `${list.length} address${list.length === 1 ? '' : 'es'} copied. Paste them in Bcc.`;
    } catch {
      $('copied').textContent = list.join(', ');
    }
  });
  $('search').addEventListener('input', draw);
  $('filter').addEventListener('change', draw);

  // ---- the login log
  async function loadLog() {
    const r = await fetch('/api/admin/audit?limit=1000').catch(() => null);
    if (!r?.ok) return;
    log = (await r.json()).log;
    drawLog();
  }
  function drawLog() {
    const week = Date.now() - 7 * 86400_000;
    const recent = log.filter((e) => Date.parse(String(e.time).replace(' ', 'T')) >= week);
    const kind = (e) => EVENTS[e.event]?.[2] ?? '';
    const kpis = [
      ['Logins and joins, 7 days', recent.filter((e) => kind(e) === 'in').length],
      ['Failed attempts, 7 days', recent.filter((e) => kind(e) === 'failed').length],
      ['Different addresses, 7 days', new Set(recent.map((e) => e.ip).filter(Boolean)).size],
    ];
    $('login-kpis').replaceChildren(...kpis.map(([label, value]) => {
      const s = el('div', 'stat');
      s.append(el('b', '', fmt(value)), el('span', 'muted small', label));
      return s;
    }));
    const f = $('log-filter').value;
    const q = $('log-search').value.trim().toLowerCase();
    const shown = log.filter((e) => (!f || kind(e) === f) && (!q || [e.username, e.ip, e.detail].some((v) => String(v || '').toLowerCase().includes(q))));
    $('log').replaceChildren(...shown.slice(0, 500).map((e) => {
      const [label, tone] = EVENTS[e.event] ?? [e.event, ''];
      const tr = el('tr', tone);
      tr.append(el('td', '', e.time), el('td', '', label), el('td', '', e.username || ''), el('td', '', e.ip || ''), el('td', '', e.detail || ''));
      return tr;
    }));
  }
  $('log-filter').addEventListener('change', drawLog);
  $('log-search').addEventListener('input', drawLog);

  // ---- in and out
  $('login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('login-err').hidden = true;
    const r = await post('/api/login', { username: $('user').value.trim(), password: $('pass').value }).catch(() => null);
    $('pass').value = '';
    if (r?.ok) {
      const me = await r.json();
      if (me.role === 'admin') return start();
      $('login-err').textContent = 'This account is not the admin.';
    } else {
      $('login-err').textContent = (r && (await r.json().catch(() => ({}))).error) || 'Logging in failed.';
    }
    $('login-err').hidden = false;
  });
  $('logout').addEventListener('click', async () => {
    live?.close();
    live = null;
    await post('/api/logout', {});
    entries = [];
    log = [];
    start();
  });
  start();
})();
