// The scoreboard for a big screen at the meetup (brieltje.be/admin/scores): the multiplayer game's
// scores, the round and the game being played, live from the admin stream (server/stats.mjs, event
// "board"), in Dutch or English. Admin only: the stream needs the admin's session. Names are what
// players typed, so everything is put on the page as text, never as HTML.
(() => {
  const $ = (id) => document.getElementById(id);
  const T = {
    nl: {
      free: 'Vrij spel', hide: 'Verstoppertje', tag: 'Tikkertje', treasure: 'Schattenjacht', teams: 'Huis tegen bungalow',
      firstTo: 'Eerste tot {n} kills wint de ronde', hiding: 'Verstoppen', seeking: 'Zoeken', playing: 'Bezig', done: 'Afgelopen',
      left: 'nog {t}', kills: 'Kills', deaths: 'Dood', points: 'Punten', timeIt: 'Tijd als tikker', coins: 'Munten',
      coinsLeft: '{n} munten liggen nog verstopt', fewest: 'Wie het minst lang tikker was, wint', seeks: 'zoekt', hidden: 'verstopt', it: 'tikker',
      house: 'Huis', bungalow: 'Bungalow', goal: 'eerste tot {n}', wins: '{name} wint de ronde!', next: 'Volgende ronde over {n} s', over: 'Afgelopen!',
      emptyBig: 'Nog niemand speelt samen', emptySub: 'Open brieltje.be, kies Samen en vul de pincode in.',
      join: 'Speel mee op ', count: '{a} samen · {b} alleen', live: 'Live', retry: 'Opnieuw verbinden…', full: 'Volledig scherm (F)',
      gate: 'Log eerst in op de beheerpagina.', gateLink: 'Naar de beheerpagina', out: 'uit',
    },
    en: {
      free: 'Free play', hide: 'Hide and seek', tag: 'Tag', treasure: 'Treasure hunt', teams: 'House against bungalow',
      firstTo: 'First to {n} kills wins the round', hiding: 'Hiding', seeking: 'Seeking', playing: 'Playing', done: 'Over',
      left: '{t} left', kills: 'Kills', deaths: 'Deaths', points: 'Points', timeIt: 'Time as it', coins: 'Coins',
      coinsLeft: '{n} coins still hidden', fewest: 'Least time as it wins', seeks: 'seeks', hidden: 'hidden', it: 'it',
      house: 'House', bungalow: 'Bungalow', goal: 'first to {n}', wins: '{name} wins the round!', next: 'Next round in {n} s', over: 'Game over!',
      emptyBig: "Nobody's playing together yet", emptySub: 'Open brieltje.be, choose Together and enter the PIN.',
      join: 'Play along at ', count: '{a} together · {b} alone', live: 'Live', retry: 'Reconnecting…', full: 'Full screen (F)',
      gate: 'Log in on the admin page first.', gateLink: 'To the admin page', out: 'out',
    },
  };
  let lang = 'nl';
  try {
    lang = localStorage.getItem('briel.scoresLang') || (localStorage.getItem('briel.lang') === 'en' ? 'en' : 'nl');
  } catch {
    // storage blocked: Dutch
  }
  const t = (k, args = {}) => (T[lang][k] ?? k).replace(/\{(\w+)\}/g, (_, a) => String(args[a] ?? ''));
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const colour = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#888888');
  const clock = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  let board = null;
  let boardAt = 0;
  let playing = { together: [], alone: [] };

  /** One row of the ranking: rank, colour, name (and a note), then up to three numbers. */
  function row(rank, p, nums, opts = {}) {
    const r = el('div', `row${rank === 1 && opts.lead ? ' first' : ''}${opts.it ? ' it' : ''}${opts.out ? ' out' : ''}`);
    const dot = el('i', 'dot');
    dot.style.background = colour(p.color);
    const name = el('div', 'name', p.name);
    if (opts.note) name.append(el('small', '', opts.note));
    r.append(el('div', 'rank', rank ? String(rank) : ''), dot, name);
    for (let i = 0; i < 3; i++) r.append(el('div', `num${i > 0 ? ' dim' : ''}`, nums[i] === undefined ? '' : String(nums[i])));
    if (opts.bar !== undefined) {
      const bar = el('div', 'bar');
      const fill = el('i');
      fill.style.width = `${Math.min(100, opts.bar * 100)}%`;
      bar.append(fill);
      r.append(bar);
    }
    return r;
  }
  function head(cols) {
    const h = el('div', 'row head');
    h.append(el('div'), el('div'), el('div'));
    for (let i = 0; i < 3; i++) h.append(el('div', 'num', cols[i] ?? ''));
    return h;
  }

  function draw() {
    for (const b of document.querySelectorAll('.tools [data-set]')) b.setAttribute('aria-pressed', String(b.dataset.set === lang));
    document.documentElement.lang = lang;
    $('full').textContent = t('full');
    $('join').replaceChildren(document.createTextNode(t('join')), el('b', '', 'brieltje.be'));
    $('count').textContent = t('count', { a: playing.together.length, b: playing.alone.length });
    if (!board) return;
    const mode = board.mode;
    const kind = mode.kind || 'free';
    const left = mode.ms !== undefined ? mode.ms - (Date.now() - boardAt) : 0;
    $('mode-title').textContent = t(kind);
    $('mode-sub').textContent = kind === 'free' ? t('firstTo', { n: board.limit })
      : [t(mode.phase) ?? '', mode.phase !== 'done' ? t('left', { t: clock(left) }) : ''].filter(Boolean).join(' · ');
    const players = board.players;
    const main = $('board');
    if (!players.length) {
      const box = el('div', 'empty');
      box.append(el('div', 'big', t('emptyBig')), el('p', '', t('emptySub')));
      main.replaceChildren(box);
    } else if (kind === 'teams') {
      main.replaceChildren(teams(mode, players));
    } else {
      main.replaceChildren(ranking(kind, mode, players));
    }
    banner(kind, mode);
  }

  /** The ranking for free play, tag, the treasure hunt and hide and seek. */
  function ranking(kind, mode, players) {
    const box = el('div', 'rows');
    if (kind === 'tag') {
      const times = mode.times || {};
      const list = [...players].sort((a, b) => (times[a.name] ?? 0) - (times[b.name] ?? 0));
      box.append(head([t('timeIt'), t('kills')]));
      list.forEach((p, i) => box.append(row(i + 1, p, [`${Math.round(times[p.name] ?? 0)} s`, p.kills], { lead: true, it: p.name === mode.it, note: p.name === mode.it ? t('it') : '' })));
      const wrap = el('div');
      wrap.append(box, el('div', 'note', t('fewest')));
      return wrap;
    }
    if (kind === 'treasure') {
      const counts = mode.counts || {};
      const list = [...players].sort((a, b) => (counts[b.name] ?? 0) - (counts[a.name] ?? 0));
      box.append(head([t('coins')]));
      list.forEach((p, i) => box.append(row(i + 1, p, [counts[p.name] ?? 0], { lead: true })));
      const wrap = el('div');
      const n = Array.isArray(mode.coins) ? mode.coins.length : Number(mode.coins) || 0;
      wrap.append(box, el('div', 'note', t('coinsLeft', { n })));
      return wrap;
    }
    if (kind === 'hide') {
      const seekers = new Set(mode.seekers || []);
      const list = [...players].sort((a, b) => Number(seekers.has(b.name)) - Number(seekers.has(a.name)));
      list.forEach((p) => box.append(row(0, p, [], { it: seekers.has(p.name), note: seekers.has(p.name) ? t('seeks') : t('hidden') })));
      return box;
    }
    // Free play: by kills, then fewest deaths, then points; a bar towards the round's limit.
    const list = [...players].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || b.points - a.points);
    box.append(head([t('kills'), t('deaths'), t('points')]));
    list.forEach((p, i) => box.append(row(i + 1, p, [p.kills, p.deaths, p.points], { lead: p.kills > 0, out: !p.alive, note: p.alive ? '' : t('out'), bar: p.kills / board.limit })));
    return box;
  }

  /** House against bungalow: two sides, their score towards the goal, and who plays where. */
  function teams(mode, players) {
    const box = el('div', 'teams');
    const side = (key) => {
      const s = el('div', `team ${key}`);
      s.append(el('h2', '', t(key)), el('div', 'score', String(mode.score?.[key] ?? 0)));
      const ul = el('ul');
      for (const p of players.filter((x) => mode.teams?.[x.name] === key).sort((a, b) => b.kills - a.kills)) {
        const li = el('li');
        li.append(el('span', '', p.name), el('b', '', String(p.kills)));
        ul.append(li);
      }
      s.append(ul);
      return s;
    };
    const vs = el('div', 'versus', t('goal', { n: mode.goal }));
    const bar = el('div', 'goalbar');
    for (const key of ['house', 'bungalow']) {
      const i = el('i');
      const b = el('b');
      b.style.width = `${Math.min(100, ((mode.score?.[key] ?? 0) / (mode.goal || 1)) * 100)}%`;
      i.append(b);
      bar.append(i);
    }
    box.append(side('house'), vs, side('bungalow'), bar);
    return box;
  }

  /** A round won, or a game over: big in the middle for a few seconds. */
  function banner(kind, mode) {
    const b = $('banner');
    if (board.round) {
      const s = Math.ceil((board.round.ms - (Date.now() - boardAt)) / 1000);
      b.replaceChildren(el('div', 'big', t('wins', { name: board.round.winner })), el('p', '', t('next', { n: Math.max(0, s) })));
      b.hidden = false;
    } else if (kind !== 'free' && mode.phase === 'done') {
      b.replaceChildren(el('div', 'big', t('over')), el('p', '', mode.result || ''));
      b.hidden = false;
    } else {
      b.hidden = true;
    }
  }

  // ---- live from the admin stream
  function connect() {
    const es = new EventSource('/api/admin/live');
    es.addEventListener('open', () => {
      $('live').classList.add('on');
      $('live-text').textContent = t('live');
    });
    es.addEventListener('error', () => {
      $('live').classList.remove('on');
      $('live-text').textContent = t('retry');
      if (es.readyState === EventSource.CLOSED) setTimeout(check, 3000); // refused: the session may be gone
    });
    es.addEventListener('board', (e) => {
      board = JSON.parse(e.data);
      boardAt = Date.now();
      draw();
    });
    es.addEventListener('playing', (e) => {
      playing = JSON.parse(e.data);
      draw();
    });
  }
  async function check() {
    const r = await fetch('/api/admin/audit?limit=1').catch(() => null);
    if (!r || !r.ok) {
      $('gate-text').textContent = t('gate');
      $('gate-link').textContent = t('gateLink');
      $('gate').hidden = false;
      return;
    }
    $('gate').hidden = true;
    connect();
  }

  // The clock and the countdowns tick here; the stream corrects them.
  setInterval(() => {
    $('clock').textContent = new Date().toLocaleTimeString(lang === 'nl' ? 'nl-BE' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
    if (board && (board.round || board.mode.ms !== undefined)) draw();
  }, 1000);

  for (const b of document.querySelectorAll('.tools [data-set]')) {
    b.addEventListener('click', () => {
      lang = b.dataset.set;
      try {
        localStorage.setItem('briel.scoresLang', lang);
      } catch {
        // storage blocked
      }
      draw();
    });
  }
  const full = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
  $('full').addEventListener('click', full);
  addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'f' && !e.repeat) full();
  });
  // The mouse pointer disappears after a few still seconds, as on a TV.
  let idle = 0;
  addEventListener('mousemove', () => {
    document.body.classList.remove('idle');
    clearTimeout(idle);
    idle = setTimeout(() => document.body.classList.add('idle'), 3000);
  });
  $('clock').textContent = new Date().toLocaleTimeString(lang === 'nl' ? 'nl-BE' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
  draw();
  check();
})();
