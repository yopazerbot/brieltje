// The admin page (brieltje.be/admin): log in with the game's admin account, then five tabs, kept
// current by a live stream (GET /api/admin/live: today's numbers, who is playing, new log lines,
// changed sign-ups and feedback); the 60 days behind the overview are fetched again every minute.
// The address's hash picks the tab (#overview, #signups, #feedback, #logins, #online), so a tab can be
// linked and back and forward work. The last tab, the period and the hour chart's measure are
// remembered in this browser (localStorage, keys starting with briel.admin.), a convenience only.
// Overview: how much the game is played (server/stats.mjs: totals per day and per hour, nothing per
// person) for a period (today since 00:00 Belgian time, yesterday, 7 or 30 days) against the period
// before, by the hour, per day for 30 days, and how people play. Every date comes from the server's
// Belgian calendar: the page never takes a day from the browser's time zone.
// Sign-ups: the interest page's sign-ups (server/interest.mjs) with status, notes, plans and delete.
// Feedback: players' stars and comments (server/feedback.mjs) with their name, address and time.
// Logins: the login log. Online now.
// Everything a visitor typed or a server log holds is shown with textContent, never as HTML.
(() => {
  const $ = (id) => document.getElementById(id);
  const WHEN = { weekday: 'Weekday evening', saturday: 'Saturday', sunday: 'Sunday' };
  const STATUS = ['new', 'contacted', 'modelled', 'declined'];
  const EVENTS = {
    login_ok: ['Admin logged in', 'good', 'in'], join_ok: ['Joined with the PIN', 'good', 'in'], mp_join: ['Entered the game', '', 'in'],
    login_failed: ['Wrong password', 'bad', 'failed'], pin_failed: ['Wrong PIN', 'bad', 'failed'], pin_limited: ['PIN attempts paused', 'bad', 'failed'],
    login_admin_limited: ['Admin login paused', 'bad', 'failed'], login_blocked_kicked: ['Removed player tried again', 'bad', 'failed'],
    solo_start: ['Started alone (name as typed)', '', 'solo'], kick: ['Player removed', '', 'admin'], pin_changed: ['PIN changed', '', 'admin'], rules: ['House rules changed', '', 'admin'], round_won: ['Round won', '', ''],
  };
  const TABS = ['overview', 'signups', 'feedback', 'logins', 'online'];
  const PERIODS = { today: 'Today', yesterday: 'Yesterday', d7: 'Last 7 days', d30: 'Last 30 days' };
  // The hour chart's measures: the button, and a number of them in a tooltip.
  const METRICS = {
    players: ['Players', (n) => count(n, 'player')],
    visitors: ['Visitors', (n) => count(n, 'visitor')],
    starts: ['Games started', (n) => count(n, 'game')],
    minutes: ['Minutes played', (n) => `${fmt(n)} min played`],
  };
  // Remembered in this browser, a convenience only: a private window or blocked storage starts at the defaults.
  const saved = {
    get(k) {
      try {
        return localStorage.getItem(`briel.admin.${k}`);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(`briel.admin.${k}`, v);
      } catch {
        // not kept
      }
    },
  };
  let entries = [];
  let log = [];
  let feedback = [];
  let tab = 'overview';
  let period = Object.hasOwn(PERIODS, saved.get('period') ?? '') ? saved.get('period') : 'today';
  let metric = Object.hasOwn(METRICS, saved.get('hours') ?? '') ? saved.get('hours') : 'players';
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
  const count = (n, one) => `${fmt(n || 0)} ${Math.round(n || 0) === 1 ? one : `${one}s`}`;
  const hh = (i) => String(i).padStart(2, '0');
  // Dates as the server's Belgian calendar gives them (YYYY-MM-DD), drawn at noon UTC in UTC: no time zone can shift them.
  const cal = (d) => {
    const [y, m, n] = d.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, n, 12));
  };
  const dayFmt = (d, o) => cal(d).toLocaleDateString('en-GB', { timeZone: 'UTC', ...o });
  const dayName = (d) => dayFmt(d, { weekday: 'short', day: 'numeric', month: 'short' });
  const dayShort = (d) => dayFmt(d, { day: 'numeric', month: 'short' });
  const dayLong = (d) => dayFmt(d, { weekday: 'long', day: 'numeric', month: 'long' });
  const nextDay = (d) => new Date(cal(d).getTime() + 86400_000).toISOString().slice(0, 10);
  const dur = (min) => {
    const m = Math.round(min);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${hh(m % 60)} min`;
  };
  const avgDur = (min) => (min < 10 ? `${(Math.round(min * 10) / 10).toFixed(1)} min` : dur(min));
  const debounce = (fn, ms) => {
    let t = 0;
    return () => {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  };

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
    selectTab(tabFromHash() ?? (TABS.includes(saved.get('tab')) ? saved.get('tab') : 'overview'), 'replace');
    // Each part on its own, so one that fails doesn't keep the others from loading.
    try {
      stats = await r.json();
      playing = stats.playing ?? playing;
      overview();
    } catch (e) {
      console.error('overview', e);
    }
    loadSignups();
    loadFeedback();
    loadLog();
    connect();
  }

  // ---- live
  const soon = debounce(() => refreshStats(), 1500);
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
      const msg = JSON.parse(e.data);
      if (!stats) return;
      const last = stats.days[stats.days.length - 1];
      if (last.day !== msg.day) return void refreshStats(); // a new Belgian day: fetch the 60 days again
      Object.assign(last, msg.counts);
      // (A server from before this page, during a redeploy's overlap, sends neither.)
      if (msg.now) stats.now = msg.now;
      if (msg.names && stats.periods?.today) stats.periods.today.names.cur = msg.names;
      if (tab === 'overview') overview();
    });
    live.addEventListener('playing', (e) => {
      playing = JSON.parse(e.data);
      drawPlaying();
    });
    live.addEventListener('log', (e) => {
      log = [...JSON.parse(e.data).reverse(), ...log].slice(0, 2000);
      if (tab === 'logins') drawLog();
    });
    live.addEventListener('feedback', () => {
      loadFeedback();
      soon();
    });
    live.addEventListener('signups', () => {
      soon();
      // Not while a note is being typed: it would be drawn over.
      if (document.activeElement?.closest?.('#entries')) return;
      loadSignups();
    });
  }

  const nav = $('tabs');
  const bar = $('topbar');
  const tabButtons = [...nav.querySelectorAll('[role="tab"]')];
  function tabFromHash() {
    const h = location.hash.slice(1);
    return TABS.includes(h) ? h : null;
  }
  /** Shows a tab. `how`: 'push' (a click: a new history entry), 'replace' (the start) or 'none' (back, forward, a link). */
  function selectTab(name, how) {
    const was = tab;
    tab = name;
    for (const b of tabButtons) {
      const on = b.dataset.tab === name;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== name;
    $('period').hidden = name !== 'overview';
    if (location.hash !== `#${name}`) {
      if (how === 'push') history.pushState(null, '', `#${name}`);
      else if (how === 'replace') history.replaceState(null, '', `#${name}`);
    }
    saved.set('tab', name);
    // The chosen tab in view in the bar, and the new tab from its top when the page was scrolled down a long one.
    const b = tabButtons.find((x) => x.dataset.tab === name);
    nav.scrollTo({ left: Math.max(0, b.offsetLeft - (nav.clientWidth - b.offsetWidth) / 2), behavior: how === 'replace' ? 'auto' : 'smooth' });
    const top = $('app').getBoundingClientRect().top + scrollY - 4;
    if (was !== name && scrollY > top) scrollTo({ top });
    fades();
    hideTip();
  }
  function openTab(name, how) {
    selectTab(name, how);
    if (name === 'online' || name === 'overview') refreshStats();
    if (name === 'logins') loadLog();
    if (name === 'signups') loadSignups();
    if (name === 'feedback') loadFeedback();
  }
  for (const b of tabButtons) b.addEventListener('click', () => openTab(b.dataset.tab, 'push'));
  nav.addEventListener('keydown', (e) => {
    const i = tabButtons.findIndex((b) => b.dataset.tab === tab);
    const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabButtons.length - 1 }[e.key];
    if (j === undefined) return;
    e.preventDefault();
    const b = tabButtons[(j + tabButtons.length) % tabButtons.length];
    b.focus();
    openTab(b.dataset.tab, 'push');
  });
  const fromHistory = () => {
    const t = tabFromHash() ?? 'overview';
    if (t !== tab && !$('app').hidden) openTab(t, 'none');
  };
  addEventListener('popstate', fromHistory);
  addEventListener('hashchange', fromHistory);
  /** The fade on a side of the tab bar that has more tabs. */
  function fades() {
    const more = nav.scrollWidth - nav.clientWidth;
    nav.classList.toggle('fade-l', nav.scrollLeft > 2);
    nav.classList.toggle('fade-r', nav.scrollLeft < more - 2);
  }
  nav.addEventListener('scroll', fades, { passive: true });
  addEventListener('scroll', () => {
    bar.classList.toggle('stuck', scrollY > 0 && bar.getBoundingClientRect().top <= 0.5);
    hideTip();
  }, { passive: true });
  addEventListener('resize', debounce(() => {
    fades();
    if (tab === 'overview') overview();
  }, 150));
  for (const b of document.querySelectorAll('#period button')) {
    b.addEventListener('click', () => {
      period = b.dataset.period;
      saved.set('period', period);
      overview();
    });
  }
  for (const b of document.querySelectorAll('#hours-metric button')) {
    b.addEventListener('click', () => {
      metric = b.dataset.metric;
      saved.set('hours', metric);
      overview();
    });
  }
  async function refreshStats() {
    const r = await fetch('/api/admin/stats').catch(() => null);
    if (r?.status === 401 || r?.status === 403) return void start(); // the session is gone: the login form, not old numbers
    if (!r?.ok) return;
    stats = await r.json();
    overview();
  }
  setInterval(() => { if (!$('app').hidden) refreshStats(); }, 60_000);

  // ---- overview
  /** The period's days and the days before, with the days from which each number was counted whole. */
  function windowOf(p) {
    const P = stats.periods[p];
    const range = (a, b) => stats.days.filter((d) => d.day >= a && d.day <= b);
    const detail = stats.detailSince ? { day: stats.detailSince.slice(0, 10), time: stats.detailSince.slice(11, 16) } : null;
    return {
      p, P, cur: range(P.from, P.to), prev: range(P.prevFrom, P.prevTo), detail,
      // Players, hours and visitors that a restart doesn't count again: whole from this day.
      full: detail ? (detail.time === '00:00' ? detail.day : nextDay(detail.day)) : '9999-12-31',
      // Games and minutes: whole from the first day with any number.
      base: stats.since ?? '9999-12-31',
    };
  }
  const sinceText = (s) => `${dayName(s.day)}, ${s.time}`;
  const sum = (list, k) => list.reduce((a, d) => a + (d[k] || 0), 0);
  const most = (list, k) => list.reduce((a, d) => Math.max(a, d[k] || 0), 0);
  /** Yesterday until now's time: its hours before this one, and the part of this hour that has passed. */
  function untilNow(row, m) {
    const { hour, time } = stats.now;
    const h = row?.hours?.[m] ?? [];
    let n = 0;
    for (let i = 0; i < hour; i++) n += h[i] || 0;
    return n + (h[hour] || 0) * (Number(time.slice(3, 5)) / 60);
  }
  /** What the period is compared with, in words. */
  const against = (p) => ({ today: `yesterday until ${stats.now.time}`, yesterday: 'the day before', d7: 'the 7 days before', d30: 'the 30 days before' })[p];

  function values(w) {
    const { p, P, cur, prev, full, base } = w;
    const today = p === 'today';
    // The period before, only when it was counted whole: for today, yesterday until now from its hours.
    const before = (k, hours, from) => (today ? (P.prevFrom >= full ? untilNow(prev[0], hours) : null) : (P.prevFrom >= from ? sum(prev, k) : null));
    return {
      players: sum(cur, 'game_players'), visitors: sum(cur, 'game_visitors'), starts: sum(cur, 'starts'), minutes: sum(cur, 'minutes'),
      peak: most(cur, 'peak_players'), alone: sum(cur, 'starts_alone'), together: sum(cur, 'starts_together'), names: P.names.cur,
      signups: sum(cur, 'signups'), rated: sum(cur, 'fb_rated'), stars: sum(cur, 'fb_stars'), comments: sum(cur, 'fb_comments'),
      prev: {
        players: before('game_players', 'players', full),
        visitors: before('game_visitors', 'visitors', full),
        starts: before('starts', 'starts', base),
        minutes: before('minutes', 'minutes', base),
        peak: today || P.prevFrom < base ? null : most(prev, 'peak_players'),
        names: P.prevFrom >= base ? P.names.prev.all : null,
        signups: today ? P.signupsPrev : sum(prev, 'signups'),
      },
    };
  }

  function overview() {
    if (!stats?.periods) return;
    for (const b of document.querySelectorAll('#period button')) b.setAttribute('aria-pressed', String(b.dataset.period === period));
    for (const b of document.querySelectorAll('#hours-metric button')) b.setAttribute('aria-pressed', String(b.dataset.metric === metric));
    const w = windowOf(period);
    $('period-title').textContent = PERIODS[period];
    $('period-range').textContent = period === 'today' ? 'Since 00:00, Belgian time.' : period === 'yesterday' ? `${dayLong(w.P.from)}.` : `${dayShort(w.P.from)} – today.`;
    $('period-compare').textContent = `Compared with ${against(period)}.`;
    kpis(w);
    hoursChart(w);
    dayCharts(w);
    splits(w);
    if (w.detail) {
      $('how-since').hidden = false;
      $('how-since').textContent = `Players and hours are counted since ${sinceText(w.detail)}.`;
      $('how-before').hidden = !(stats.since && stats.since < w.full);
      $('how-before').textContent = `Visitors before ${dayLong(w.full)} can be counted more than once. Each restart of the server counted them again.`;
    }
    $('how-secret').hidden = stats.restartProof !== false;
    $('since').textContent = stats.since ? `Counting since ${dayName(stats.since)}.` : 'Counting has just started. The numbers fill up from today.';
    drawPlaying();
  }

  /** A change against the period before: an arrow, how much, and in words for the tooltip. */
  function change(a, b, f = fmt, eps = 0.5) {
    if (b === null || b === undefined || !Number.isFinite(b)) return null;
    const d = a - b;
    if (Math.abs(d) < eps) return { cls: 'same', text: '±0', title: `The same as ${against(period)}` };
    return { cls: d > 0 ? 'up' : 'down', text: `${d > 0 ? '▲' : '▼'} ${f(Math.abs(d))}`, title: `${f(Math.abs(d))} ${d > 0 ? 'more' : 'less'} than ${against(period)}` };
  }

  function kpis(w) {
    const v = values(w);
    const { cur, detail, full } = w;
    const n = cur.length;
    const multi = n > 1;
    const perDay = (x, days) => (days ? `${(x / days).toFixed(x / days < 10 ? 1 : 0)} a day on average.` : '');
    const playerDays = detail ? cur.filter((d) => d.day >= detail.day).length : 0;
    const partial = cur[0].day < full; // the period starts before players were counted whole
    const inflated = cur.some((d) => d.day < full && d.game_visitors); // days whose restarts counted visitors again
    const noSecret = stats.restartProof === false ? 'No STATS_SECRET yet: restarts can count some twice.' : '';
    const games = v.alone + v.together;
    const avgNow = v.starts ? v.minutes / v.starts : null;
    const avgBefore = v.prev.starts && v.prev.minutes !== null ? v.prev.minutes / v.prev.starts : null;
    const tiles = [
      {
        lead: true, value: playerDays ? fmt(v.players) : '–', label: multi ? 'Players (once a day each)' : 'Players',
        delta: change(v.players, v.prev.players), note: [!playerDays ? 'Not counted on these days.' : partial ? `Counted since ${sinceText(detail)}.` : '', multi && playerDays ? perDay(v.players, playerDays) : '', playerDays ? noSecret : ''],
      },
      {
        value: fmt(v.visitors), label: multi ? 'Visitors (once a day each)' : 'Visitors', delta: change(v.visitors, v.prev.visitors),
        note: [multi ? perDay(v.visitors, n) : '', inflated ? `Before ${dayShort(full)}, restarts counted some twice.` : '', noSecret],
      },
      { value: fmt(v.names.all), label: 'Different players (by name)', delta: change(v.names.all, v.prev.names), note: `${fmt(v.names.together)} together · ${fmt(v.names.alone)} alone` },
      { value: fmt(v.peak), label: 'Most players at once', delta: change(v.peak, v.prev.peak) },
      { value: fmt(v.starts), label: 'Games started', delta: change(v.starts, v.prev.starts), note: multi ? perDay(v.starts, n) : '' },
      { value: dur(v.minutes), label: 'Time played', delta: change(v.minutes, v.prev.minutes, dur) },
      { value: avgNow === null ? '–' : avgDur(avgNow), label: 'Average per game', delta: avgNow === null ? null : change(avgNow, avgBefore, avgDur, 0.05) },
      { value: games ? `${Math.round((100 * v.alone) / games)}%` : '–', label: 'Games alone', note: games ? `${fmt(v.alone)} alone · ${fmt(v.together)} together` : '' },
      { wide: true, value: fmt(v.signups), label: 'Interest sign-ups', delta: change(v.signups, v.prev.signups), note: `${fmt(stats.interest)} in all.` },
      {
        wide: true, value: v.rated ? `${(v.stars / v.rated).toFixed(1)} ★` : '–', label: 'Feedback rating',
        note: `${count(v.rated, 'rating')} · ${count(v.comments, 'comment')}`,
      },
    ];
    $('kpis').replaceChildren(...tiles.map((t) => {
      const s = el('div', `stat${t.lead ? ' lead' : ''}${t.wide ? ' wide' : ''}`);
      const top = el('div', 'top');
      top.append(el('b', '', t.value));
      if (t.delta) {
        const d = el('span', `delta ${t.delta.cls}`, t.delta.text);
        d.title = t.delta.title;
        top.append(d);
      }
      s.append(top, el('span', 'label', t.label));
      for (const line of [].concat(t.note ?? [])) if (line) s.append(el('span', 'kpi-note', line));
      return s;
    }));
  }

  /** When people play: 24 bars, the hours of the period's days added up (only days that have hours). */
  function hoursChart(w) {
    const { p, cur, detail, full } = w;
    const box = $('hours');
    const counted = detail ? cur.filter((d) => d.day >= detail.day) : [];
    if (!counted.length) {
      $('hours-sub').replaceChildren();
      const msg = el('p', 'empty-chart');
      msg.append(el('span', '', 'No hours for this period.'), el('span', '', detail ? `Hours are counted since ${sinceText(detail)}.` : 'Hours are counted from the next start of the server.'));
      box.replaceChildren(msg);
      return;
    }
    const keys = Object.keys(METRICS);
    const sums = Object.fromEntries(keys.map((m) => [m, Array(24).fill(0)]));
    for (const d of counted) for (const m of keys) (d.hours?.[m] ?? []).forEach((n, i) => (sums[m][i] += n));
    const today = p === 'today';
    const nowHour = today ? stats.now.hour : 23;
    const lines = ['Belgian time.'];
    if (today) lines.push(`Until ${stats.now.time}.`);
    else if (counted.length > 1) lines.push(`${counted.length} days added up.`);
    if (cur[0].day < full) lines.push(`Hours are counted since ${sinceText(detail)}.`);
    $('hours-sub').replaceChildren(...lines.map((t) => el('span', '', t)));
    const range = (i) => `${hh(i)}:00–${hh((i + 1) % 24)}:00`;
    box.replaceChildren();
    bars(box, {
      n: 24,
      series: [{ values: sums[metric].map((x, i) => (i > nowHour ? null : x)) }],
      label: (i) => (i % 3 === 0 ? hh(i) : null),
      tip: (i) => [`${range(i)}${today && i === nowHour ? ', so far' : ''}`, keys.map((m) => [METRICS[m][1](sums[m][i]), m === metric])],
      aria: `${METRICS[metric][0]} per hour, Belgian time`,
    });
    box.append(table(['Hour', ...keys.map((m) => METRICS[m][0])], sums.players.map((_, i) => [range(i), ...keys.map((m) => fmt(sums[m][i]))]).filter((_, i) => i <= nowHour)));
  }

  /** The last 30 days as bars, the period's days lit: players with visitors behind them, games, minutes, the interest page. */
  function dayCharts(w) {
    const month = stats.days.slice(-30);
    const { P, detail } = w;
    const off = (i) => month[i].day < P.from || month[i].day > P.to;
    const counted = (d) => !!detail && d.day >= detail.day;
    const dayTip = (i) => {
      const d = month[i];
      return [dayName(d.day), [
        [counted(d) ? count(d.game_players, 'player') : 'Players not counted yet', false],
        [count(d.game_visitors, 'visitor'), false],
        [count(d.starts, 'game'), false],
        [`${dur(d.minutes || 0)} played`, false],
      ]];
    };
    const charts = [
      {
        title: 'Players and visitors', legend: [['Visitors', 'back'], ['Players', '']],
        series: [{ key: 'game_visitors', cls: 'back' }, { key: 'game_players', cls: 'front', width: 0.5, only: counted }],
        columns: ['Visitors', 'Players'],
      },
      { title: 'Games started', series: [{ key: 'starts' }], total: (t) => `${count(t, 'game')} in 30 days.`, columns: ['Games'] },
      { title: 'Minutes played', series: [{ key: 'minutes' }], total: (t) => `${dur(t)} in 30 days.`, columns: ['Minutes'] },
      {
        title: 'Interest page visitors', series: [{ key: 'interest_visitors' }], total: (t) => `${count(t, 'visitor')} in 30 days.`, columns: ['Visitors'],
        tip: (i) => [dayName(month[i].day), [[count(month[i].interest_visitors, 'visitor'), true]]],
      },
    ];
    const boxes = charts.map((c) => {
      const box = el('div', 'chart');
      box.append(el('h3', '', c.title));
      if (c.legend) {
        const legend = el('div', 'legend');
        for (const [label, cls] of c.legend) {
          const item = el('span');
          item.append(el('i', cls), document.createTextNode(label));
          legend.append(item);
        }
        box.append(legend);
      } else {
        box.append(el('div', 'total', c.total(sum(month, c.series[0].key))));
      }
      return box;
    });
    $('charts').replaceChildren(...boxes);
    charts.forEach((c, k) => {
      const series = c.series.map((s) => ({ ...s, values: month.map((d) => (s.only && !s.only(d) ? null : d[s.key] || 0)) }));
      bars(boxes[k], {
        n: month.length, series, dim: off, tip: c.tip ?? dayTip, aria: `${c.title} per day, last 30 days`,
        // The last day (today), and every seventh day back from it.
        label: (i) => ((month.length - 1 - i) % 7 === 0 ? dayShort(month[i].day) : null),
      });
      boxes[k].append(table(['Day', ...c.columns], [...month].reverse().map((d) => [dayName(d.day), ...c.series.map((s) => (s.only && !s.only(d) ? '–' : fmt(d[s.key] || 0)))])));
    });
  }

  /** The numbers behind a chart, folded away. */
  function table(head, rows) {
    const details = el('details');
    details.append(el('summary', '', 'As a table'));
    const t = el('table');
    const tr = el('tr');
    for (const h of head) tr.append(el('th', '', h));
    t.append(tr);
    for (const row of rows) {
      const r = el('tr');
      for (const c of row) r.append(el('td', '', c));
      t.append(r);
    }
    details.append(t);
    return details;
  }

  /** Steps for the top of a chart's scale that halve to whole numbers: 2, 4, 6, 8, 10, 20, 40 ... */
  function niceTop(top) {
    for (let e = 1; ; e *= 10) for (const f of [2, 4, 6, 8, 10]) if (f * e >= top) return f * e;
  }

  /**
   * Bars from one baseline, in an SVG as wide as its box so the labels keep their size on a phone.
   * `series` are drawn back to front (null: no bar), each `width` a share of the bar; `dim(i)` fades a
   * bar outside the period; `tip(i)` gives [title, [[line, strong]...]] for hover, focus or a tap.
   */
  function bars(box, { n, series, label, dim, tip: tipOf, aria }) {
    const inner = box.clientWidth - (parseFloat(getComputedStyle(box).paddingLeft) || 0) * 2;
    const W = inner > 0 ? Math.max(240, Math.round(inner)) : 480; // 480 while the tab is hidden: drawn again when it shows
    const H = 160;
    const L = 34;
    const B = 20;
    const T = 8;
    const top = niceTop(Math.max(1, ...series.flatMap((s) => s.values.map((v) => v || 0))));
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': aria });
    for (const f of [0, 0.5, 1]) {
      const y = H - B - (H - B - T) * f;
      s.append(svg('line', { x1: L, x2: W, y1: y, y2: y, class: 'grid' }));
      const t = svg('text', { x: L - 6, y: y + 4, 'text-anchor': 'end', class: 'axis' });
      t.textContent = fmt(top * f);
      s.append(t);
    }
    const slot = (W - L) / n;
    for (let i = 0; i < n; i++) {
      const hit = svg('rect', { x: L + i * slot, y: T, width: slot, height: H - B - T, class: 'hit', tabindex: 0 });
      const [title, lines] = tipOf(i);
      hit.setAttribute('aria-label', [title, ...lines.map((l) => l[0])].join(', '));
      hover(hit, () => tipOf(i));
      s.append(hit);
      for (const se of series) {
        const v = se.values[i];
        if (v === null || v === undefined) continue;
        const bw = Math.min(26, slot * 0.72) * (se.width ?? 1);
        const x = L + i * slot + (slot - bw) / 2;
        const h = ((H - B - T) * v) / top;
        if (h <= 0) continue;
        const y = H - B - h;
        const r = Math.min(4, bw / 2, h);
        s.append(svg('path', {
          class: `bar${se.cls ? ` ${se.cls}` : ''}${dim?.(i) ? ' off' : ''}`,
          d: `M${x},${H - B}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${H - B}Z`,
        }));
      }
      const text = label?.(i);
      if (text) {
        const t = svg('text', { x: Math.min(W - 14, Math.max(L + 14, L + i * slot + slot / 2)), y: H - 4, 'text-anchor': 'middle', class: 'axis' });
        t.textContent = text;
        s.append(t);
      }
    }
    box.append(s);
  }

  /** How people play: the period's games by controls, mode, alone or together and language. */
  function splits(w) {
    const { cur } = w;
    $('splits-period').textContent = `(${PERIODS[period].toLowerCase()})`;
    const groups = [
      ['Controls', [['Keyboard and mouse', 'starts_kbm'], ['Controller', 'starts_pad'], ['Touch', 'starts_touch']]],
      ['Mode', [['Explore', 'starts_explore'], ['Paintball', 'starts_paintball'], ['Action', 'starts_action']]],
      ['Alone or together', [['Alone', 'starts_alone'], ['Together', 'starts_together']]],
      ['Language', [['Nederlands', 'starts_nl'], ['English', 'starts_en']]],
    ];
    $('splits').replaceChildren(...groups.map(([title, rows]) => {
      const box = el('div', 'split');
      box.append(el('h3', '', title));
      const total = rows.reduce((a, [, k]) => a + sum(cur, k), 0);
      for (const [label, k] of rows) {
        const n = sum(cur, k);
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
  }

  /** Online now: the players together by name, the ones alone by the name they typed (what they play, for how long). */
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
      const ping = Number.isFinite(p.ping) ? ` · ping ${p.ping} ms` : '';
      li.append(dot, el('span', '', p.name), el('span', 'muted small', `${p.role === 'admin' ? 'together · admin' : 'together'}${ping}`));
      return li;
    });
    for (const v of alone) {
      const li = el('li', 'alone');
      li.append(el('i'), el('span', '', v.name || 'No name'),
        el('span', 'muted small', `alone · ${v.mode === 'action' ? 'Action' : v.mode === 'paintball' ? 'Paintball' : 'Explore'} · ${CONTROL[v.control] ?? v.control} · ${v.lang === 'nl' ? 'Nederlands' : 'English'} · ${v.minutes < 1 ? 'just started' : `${v.minutes} min`}`));
      items.push(li);
    }
    $('online-list').replaceChildren(...items);
    // The overview's strip and the tab's badge follow without redrawing the charts.
    const n = together.length + alone.length;
    $('now-n').textContent = fmt(n);
    $('now-split').textContent = n ? `${together.length} together · ${alone.length} alone` : '';
    document.querySelector('.now').classList.toggle('on', n > 0);
    $('online-badge').hidden = !n;
    $('online-badge').textContent = String(n);
  }

  // ---- the tooltip: hover with a mouse, a tap on a phone (until the next tap elsewhere), or keyboard focus
  function hover(target, content) {
    const show = (e) => tip(e, ...content());
    target.addEventListener('pointerenter', (e) => e.pointerType !== 'touch' && show(e));
    target.addEventListener('pointermove', (e) => e.pointerType !== 'touch' && show(e));
    target.addEventListener('pointerleave', (e) => e.pointerType !== 'touch' && hideTip());
    target.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      for (const x of document.querySelectorAll('.hit.picked')) x.classList.remove('picked');
      target.classList.add('picked');
      show(e);
    });
    target.addEventListener('focus', show);
    target.addEventListener('blur', hideTip);
  }
  function hideTip() {
    $('tip').hidden = true;
    for (const x of document.querySelectorAll('.hit.picked')) x.classList.remove('picked');
  }
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest?.('.hit')) hideTip();
  });
  function tip(e, title, lines = []) {
    const t = $('tip');
    t.replaceChildren(el('b', '', title), ...lines.map(([text, strong]) => el('span', strong ? 'on' : '', text)));
    t.hidden = false;
    const r = e.target.getBoundingClientRect();
    const x = e.clientX || r.left + r.width / 2;
    const y = e.clientY || r.top + 24;
    t.style.left = `${Math.max(8, Math.min(innerWidth - t.offsetWidth - 8, x + 12))}px`;
    t.style.top = `${Math.max(8, y - t.offsetHeight - 14)}px`;
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
  // ---- feedback
  async function loadFeedback() {
    const r = await fetch('/api/admin/feedback').catch(() => null);
    if (!r?.ok) return;
    feedback = (await r.json()).rows;
    drawFeedback();
  }
  const starText = (n) => (n ? '\u2605'.repeat(n) + '\u2606'.repeat(5 - n) : '\u2013');
  function drawFeedback() {
    const rated = feedback.filter((f) => f.stars);
    const week = Date.now() - 7 * 86400_000;
    const avg = rated.length ? rated.reduce((a, f) => a + f.stars, 0) / rated.length : 0;
    const kpis = [
      ['Average rating', rated.length ? `${avg.toFixed(1)} \u2605` : '\u2013'],
      ['Ratings', fmt(rated.length)],
      ['Comments', fmt(feedback.filter((f) => f.comment).length)],
      ['Last 7 days', fmt(feedback.filter((f) => Date.parse(String(f.time).replace(' ', 'T')) >= week).length)],
    ];
    $('fb-kpis').replaceChildren(...kpis.map(([label, value]) => {
      const s = el('div', 'stat');
      s.append(el('b', '', value), el('span', 'muted small', label));
      return s;
    }));
    const most = Math.max(1, ...[1, 2, 3, 4, 5].map((n) => rated.filter((f) => f.stars === n).length));
    $('fb-spread').replaceChildren(...[5, 4, 3, 2, 1].map((n) => {
      const count = rated.filter((f) => f.stars === n).length;
      const row = el('div');
      const bar = el('i');
      bar.style.width = `${(count / most) * 100}%`;
      const track = el('span');
      track.append(bar);
      row.append(el('span', '', `${n} \u2605`), track, el('span', '', String(count)));
      return row;
    }));
    const f = $('fb-filter').value;
    const q = $('fb-search').value.trim().toLowerCase();
    const shown = feedback.filter((x) => (!f || (f === 'comment' ? !!x.comment : x.stars === Number(f)))
      && (!q || [x.name, x.ip, x.comment].some((v) => String(v || '').toLowerCase().includes(q))));
    $('fb-empty').hidden = feedback.length > 0;
    $('fb-rows').replaceChildren(...shown.slice(0, 500).map((x) => {
      const tr = el('tr');
      const name = el('td', '', x.name || 'No name');
      name.append(el('span', 'tag', x.typed ? 'alone, as typed' : 'together'));
      const del = el('button', 'btn ghost', 'Delete');
      del.type = 'button';
      let armed = false;
      del.addEventListener('click', async () => {
        if (!armed) {
          armed = true;
          del.textContent = 'Sure?';
          setTimeout(() => { armed = false; del.textContent = 'Delete'; }, 4000);
          return;
        }
        const r = await post(`/api/admin/feedback/${x.id}`, null, 'DELETE');
        if (r.ok) {
          feedback = feedback.filter((y) => y !== x);
          drawFeedback();
        }
      });
      const actions = el('td');
      actions.append(del);
      const mode = { explore: 'Explore', action: 'Action', paintball: 'Paintball' }[x.mode] ?? '';
      tr.append(el('td', '', x.time), el('td', 'stars', starText(x.stars)), el('td', 'comment', x.comment || ''), name,
        el('td', '', x.ip || ''), el('td', '', [mode, x.lang?.toUpperCase()].filter(Boolean).join(' \u00b7 ')), actions);
      return tr;
    }));
  }
  $('fb-filter').addEventListener('change', drawFeedback);
  $('fb-search').addEventListener('input', drawFeedback);

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
      const tr = el('tr', tone && `ev-${tone}`); // not .bad: the form's .bad (red border) would apply
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
    feedback = [];
    start();
  });
  start();
})();
