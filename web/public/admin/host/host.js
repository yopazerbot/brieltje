// The host's screen for a LAN night (server/host.mjs, server/monitor.mjs). Reads GET /api/host once a second and sends
// one action at a time with POST /api/host (the admin's session from /admin; same-origin JSON only). Everything players
// typed or are called is put in with textContent, never as HTML. Fields being typed in are never overwritten by the
// refresh, and a list is drawn again only when it changed, so a button never moves under a finger.
//
// Made to be driven in a noisy room: how things stand in chips at the top (each jumps to its part), one row for
// what touches everyone, quick announcements (the last ones sent, and a few ready), people found by typing and sorted by
// name, points or ping (or network address, while shown), each person's actions in one menu (⋯), and the server's own
// figures with a plain verdict.
// Keys: / to announce, Esc to close a menu. The choices of sort and the last announcements are remembered in this
// browser (localStorage, keys briel.host.*), a convenience only.
(() => {
  const $ = (id) => document.getElementById(id);
  const KINDS = { hide: 'Hide and seek', tag: 'Tag', treasure: 'Treasure hunt', teams: 'Team against team', zombies: 'Zombies', duel: 'Zombies duel', flag: 'Steal the flag', assault: 'Attack and defend' };
  // Where a team of the teams game can start (server/teamStarts.mjs START_PLACES: the portals' places), besides your own spots.
  const START_NAMES = { house: 'the house', bungalow: 'the bungalow', church: 'the church square', school: 'the school', molenhoek: 'Molenhoek', molenhoek_mid: 'the middle of Molenhoek', molenhoek_end: 'the end of Molenhoek', sparrenhof: 'the Sparrenhof', football: 'the football ground' };
  // Steal the flag's fields (shared/flagFields.mjs): blue always at the church.
  const FIELDS = { compact: 'Compact: church and Molenhoek', village: 'Village: church and Sparrenhof' };
  const PLACES = { house: 'The house', bungalow: 'The bungalow', church: 'The church square', molenhoek: 'Molenhoek', molenhoek_mid: 'Molenhoek, middle', molenhoek_end: 'Molenhoek, end', sparrenhof: 'Sparrenhof' };
  const TEAM_NAMES = { blue: 'Blue', red: 'Red', green: 'Green', purple: 'Purple' };
  // A game's look while it runs (server/modes.mjs LOOKS); none is the house rule.
  const LOOKS = { '': 'House rule', paint: 'Paint', real: 'Real' };
  // Ready announcements, in Dutch: the players' language at a local night. The last ones sent come first.
  const READY = ['Eten is klaar!', 'Pauze: 10 minuten', 'Volgend spel over 5 minuten', 'Laatste spel van de avond!'];
  const store = {
    get(k, d) {
      try {
        return JSON.parse(localStorage.getItem(`briel.host.${k}`)) ?? d;
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(`briel.host.${k}`, JSON.stringify(v));
      } catch {
        // storage blocked
      }
    },
  };
  let v = null; // the last view
  let busy = false;
  let sure = null; // a button that asks for a second click: { el, until }
  let sortBy = store.get('sort', 'name');
  let showAddresses = false; // the players' network addresses: off when the page opens, on for this visit only (never stored)
  let recent = store.get('recent', []);
  let frozenSince = 0;
  const drawn = {};

  const el = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, val] of Object.entries(props)) {
      if (k === 'text') e.textContent = val;
      else if (k === 'on') for (const [ev, f] of Object.entries(val)) e.addEventListener(ev, f);
      else if (val !== undefined && val !== null && val !== false) e.setAttribute(k, val === true ? '' : val);
    }
    e.append(...kids.filter(Boolean));
    return e;
  };
  const svg = (tag, attrs = {}) => {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, val] of Object.entries(attrs)) e.setAttribute(k, val);
    return e;
  };

  /** A short message at the bottom: what just happened, or why not. */
  function toast(text, bad = false) {
    const t = $('toast');
    t.textContent = text;
    t.classList.toggle('bad', bad);
    t.classList.add('on');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove('on'), bad ? 6000 : 3000);
  }

  async function act(body, done) {
    if (busy) return;
    busy = true;
    try {
      const r = await fetch('/api/host', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) toast(data.error || `Refused (${r.status})`, true);
      else if (done) toast(done);
    } catch {
      toast('No answer from the server', true);
    } finally {
      busy = false;
      refresh();
    }
  }

  /** A button that does its thing on the second click within 4 s (for what can't be undone). */
  function twice(btn, label, ask, body, done, after) {
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (sure?.el === btn && Date.now() < sure.until) {
        sure = null;
        btn.textContent = label;
        btn.classList.remove('asking');
        act(typeof body === 'function' ? body() : body, done);
        after?.();
        return;
      }
      sure = { el: btn, until: Date.now() + 4000 };
      btn.textContent = ask;
      btn.classList.add('asking');
      setTimeout(() => {
        if (sure?.el === btn) {
          sure = null;
          btn.textContent = label;
          btn.classList.remove('asking');
        }
      }, 4000);
    });
  }

  /** Whether a list must be drawn again: its data changed, and nothing in it is being used. */
  function stale(id, data) {
    const key = JSON.stringify(data);
    const box = $(id);
    if (drawn[id] === key || (box.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') || (sure && box.contains(sure.el))) return false;
    drawn[id] = key;
    return true;
  }

  async function refresh() {
    let r;
    try {
      r = await fetch(showAddresses ? '/api/host?addresses=1' : '/api/host', { cache: 'no-store' }); // the addresses only while shown
    } catch {
      $('chip-server').textContent = '● No connection';
      $('chip-server').className = 'chip bad';
      return;
    }
    if (r.status === 401 || r.status === 403) {
      $('signin').hidden = false;
      $('app').hidden = true;
      return;
    }
    if (!r.ok) return;
    v = await r.json();
    $('signin').hidden = true;
    $('app').hidden = false;
    render();
    document.dispatchEvent(new CustomEvent('hostview', { detail: v })); // the guards' part (guards.js)
  }

  // ------------------------------------------------------------------ the server's verdict

  // When a figure is fine, busy or too much (a figure without limits is shown, not judged).
  const LIMITS = {
    tickMs: [10, 25], cpu: [60, 85], lagMs: [50, 120], mbitOut: [20, 50], pingHigh: [120, 250], memMB: [700, 1200],
  };
  const level = (key, value) => {
    const l = LIMITS[key];
    if (!l || value === null || value === undefined) return 0;
    return value < l[0] ? 0 : value < l[1] ? 1 : 2;
  };
  const LEVELS = [{ cls: 'good', icon: '✓', word: 'Running smoothly' }, { cls: 'warn', icon: '!', word: 'Busy' }, { cls: 'bad', icon: '✕', word: 'Struggling' }];

  // ------------------------------------------------------------------ drawing

  function render() {
    const s = v.server;
    const last = s?.samples.at(-1);
    const worst = last ? Math.max(...Object.keys(LIMITS).map((k) => level(k, last[k]))) : 0;

    // The chips.
    $('chip-people').textContent = `👥 ${v.players.length} / ${v.max}`;
    $('chip-doors').textContent = v.locked ? `🔒 Doors locked${v.knocking.length ? ` · ${v.knocking.length} waiting` : ''}` : '🔓 Doors open';
    $('chip-doors').className = `chip${v.locked ? ' warn' : ''}${v.knocking.length ? ' pulse' : ''}`;
    const m = v.mode;
    const title = m.flag?.assault ? KINDS.assault : KINDS[m.kind];
    $('chip-game').textContent = v.countdown ? `⏱ ${KINDS[v.countdown.kind]} in ${Math.ceil(v.countdown.ms / 1000)} s` : m.kind === 'free' ? '🎮 Free play' : `🎮 ${title}${m.flag?.assault ? ` · round ${m.flag.assault.round}` : ''}${m.ms ? ` · ${clock(m.ms)}` : ''}`;
    $('chip-server').textContent = last ? `${LEVELS[worst].icon} Server: ${LEVELS[worst].word.toLowerCase()}` : '… Server';
    $('chip-server').className = `chip ${last ? LEVELS[worst].cls : ''}`;

    // The bar.
    const doors = $('doors');
    doors.textContent = v.locked ? '🔒 Doors locked' : '🔓 Doors open';
    doors.classList.toggle('on', v.locked);
    doors.title = v.locked ? 'Newcomers wait until you let them in. Tonight\'s players come back in on their own.' : 'Anyone can come in. Click to lock.';
    if (v.frozen && !frozenSince) frozenSince = Date.now();
    if (!v.frozen) frozenSince = 0;
    const freeze = $('freeze');
    freeze.textContent = v.frozen ? `▶ Let everyone go (${clock(Date.now() - frozenSince)})` : '⏸ Freeze everyone';
    freeze.classList.toggle('on', !!v.frozen);
    showLimit();
    $('chat').textContent = v.chatOff ? '💬 Chat is off' : '💬 Chat is on';
    $('chat').classList.toggle('off', v.chatOff);
    if (document.activeElement !== $('words')) $('words').value = v.words.join('\n');
    if (stale('quick', recent)) {
      const list = [...new Set([...recent, ...READY])].slice(0, 6);
      $('quick').replaceChildren(...list.map((text) => el('button', { class: 'q', type: 'button', title: `Announce: ${text}`, text, on: { click: () => announce(text) } })));
    }

    // People.
    $('people-count').textContent = `${v.players.length} / ${v.max}`;
    $('knocking').hidden = !v.knocking.length;
    if (stale('knock-list', v.knocking)) {
      $('knock-list').replaceChildren(...v.knocking.map((n) => el('li', {},
        el('b', { text: n }),
        el('button', { class: 'btn small', type: 'button', text: 'Let in', on: { click: () => act({ op: 'admit', name: n }, `${n} may come in`) } }),
        el('button', { class: 'btn ghost small', type: 'button', text: 'Not now', on: { click: () => act({ op: 'refuse', name: n }) } }),
      )));
    }
    for (const b of $('team-count').querySelectorAll('button')) b.setAttribute('aria-pressed', String(Number(b.dataset.n) === v.teams.count));
    for (const b of $('sort').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.sort === sortBy));
    $('shuffle').hidden = !v.teams.count;
    drawPeople();

    // The game now.
    const now = $('now-game');
    if (v.countdown) now.replaceChildren(el('b', { text: `${KINDS[v.countdown.kind]} starts in ${Math.ceil(v.countdown.ms / 1000)} s` }));
    else if (m.kind === 'free') now.replaceChildren(el('b', { text: 'Free play' }), el('span', { class: 'muted', text: ` · first to 10 kills wins a round${v.rooms ? ` · players in ${v.rooms} Zombies room${v.rooms === 1 ? '' : 's'} (Stop brings them here)` : ''}` }));
    else {
      const side = (k) => (m.names?.[k] ? TEAM_NAMES[m.names[k]] : k === 'house' ? 'House' : 'Bungalow'); // the evening's names when its teams play it
      const extra = m.flag?.assault ? assaultLine(m.flag.assault) : m.kind === 'teams' && m.score ? ` · ${side('house')} ${m.score.house} – ${m.score.bungalow} ${side('bungalow')} (to ${m.goal})${m.open && m.starts ? ` · ${side('house')} from ${startName(m.starts.house.spot ? `near.${m.starts.house.place}` : m.starts.house.place)}, ${side('bungalow')} from ${startName(m.starts.bungalow.spot ? `near.${m.starts.bungalow.place}` : m.starts.bungalow.place)}` : ''}` : m.kind === 'zombies' && m.zombies ? ` · wave ${m.zombies.wave ?? ''}` : m.kind === 'flag' && m.score ? ` · Blue ${m.score.blue} – ${m.score.red} Red${m.flag?.sudden ? ' · sudden death' : ''}` : '';
      now.replaceChildren(el('b', { text: title ?? m.kind }), el('span', { text: `${m.phase === 'done' ? ' · over' : ''}${m.ms ? ` · ${clock(m.ms)} left` : ''}${extra}${m.look ? ` · ${LOOKS[m.look] ?? m.look}` : ''}` }), m.result ? el('p', { class: 'muted', text: m.result }) : null);
    }
    // The Zombies duel (server/duel.mjs): both rooms' waves; Stop ends both at once.
    if (v.duel && !v.countdown) {
      const d = v.duel;
      const sides = d.sides.map((x) => `${TEAM_NAMES[x.team]} ${x.out ? 'out at ' : ''}wave ${x.wave}${x.best > x.wave ? ` (best ${x.best})` : ''}, ${x.beaten} beaten, ${x.players} in`).join(' · ');
      now.replaceChildren(el('b', { text: `Zombies duel, ${d.kind === 'final' ? 'final' : 'warm-up'}` }), el('span', { text: `${d.phase === 'done' ? ' · over' : ''}${d.ms ? ` · ${clock(d.ms)}${d.phase === 'done' ? '' : ' left'}` : ''}` }), el('p', { class: 'muted', text: d.winner ? `${d.winner === 'draw' ? 'A draw' : `${TEAM_NAMES[d.winner]} wins`} · ${sides}` : sides }));
    }
    // Stop has something to stop: a game here, the Zombies duel, a countdown, or players in a Zombies room (it brings them back).
    $('stop').disabled = m.kind === 'free' && !v.duel && !v.countdown && !v.rooms;
    $('cancel').hidden = !v.countdown;

    // Programme.
    if (stale('programme', [v.programme, v.next])) {
      $('programme').replaceChildren(...(v.programme.length ? v.programme.map((e, i) => el('li', { class: i < v.next ? 'done' : i === v.next ? 'next' : '' },
        el('span', { text: describe(e) }),
        el('select', { class: 'look', 'aria-label': `Look of game ${i + 1}`, title: 'Its look while it runs. Paint: child-friendly for everyone. Real: the house rule’s child-friendly off, a player’s own Paintball kept.', on: { change: (ev) => setProgramme(v.programme.map((x, k) => (k === i ? { ...x, look: ev.target.value || null } : x))) } },
          ...Object.entries(LOOKS).map(([k, n]) => el('option', { value: k, selected: (e.look ?? '') === k, text: n }))),
        el('span', { class: 'acts' },
          el('button', { class: 'btn ghost small', type: 'button', title: 'Earlier', 'aria-label': 'Earlier', text: '↑', disabled: i === 0, on: { click: () => moveEntry(i, -1) } }),
          el('button', { class: 'btn ghost small', type: 'button', title: 'Later', 'aria-label': 'Later', text: '↓', disabled: i === v.programme.length - 1, on: { click: () => moveEntry(i, 1) } }),
          el('button', { class: 'btn ghost small', type: 'button', title: 'Play from here', 'aria-label': 'Play from here', text: '⟲', on: { click: () => act({ op: 'rewind', index: i }) } }),
          el('button', { class: 'btn ghost small danger', type: 'button', title: 'Remove', 'aria-label': 'Remove', text: '×', on: { click: () => setProgramme(v.programme.filter((_, k) => k !== i)) } }),
        ))) : [el('li', { class: 'empty', text: 'Nothing planned yet. Add games below.' })]));
    }
    drawStarts();
    const nxt = v.programme[v.next];
    $('next').textContent = nxt ? `▶ Next: ${describe(nxt)}${nxt.look ? ` · ${LOOKS[nxt.look]}` : ''}` : v.programme.length ? 'Programme done' : 'Plan the evening below';
    $('next').disabled = !nxt || !!v.countdown;

    // Tonight.
    $('games-count').textContent = v.board.games ? `${v.board.games} game${v.board.games === 1 ? '' : 's'}` : '';
    if (stale('team-totals', v.board.teams)) {
      $('team-totals').replaceChildren(...v.board.teams.map((t) => el('span', { class: 'team-total' }, el('i', { style: `background:${t.color}` }), el('b', { text: TEAM_NAMES[t.id] }), el('span', { text: ` ${t.points}` }))));
    }
    if (stale('board', v.board.players)) {
      $('board').replaceChildren(...(v.board.players.length ? v.board.players.map((p, i) => el('tr', { class: p.here ? '' : 'away' },
        el('td', { text: String(i + 1) }), el('td', { text: p.name + (p.team ? ` (${TEAM_NAMES[p.team]})` : '') }), el('td', { text: String(p.points) }), el('td', { text: String(p.wins) }), el('td', { text: String(p.played) })))
        : [el('tr', {}, el('td', { colspan: '5', class: 'muted', text: 'No games played yet tonight.' }))]));
    }

    drawServer(worst);
  }

  /**
   * The teams game's starts in the form: tonight's for blue and red (the server's), every place and your own spots, the
   * metres between the two and a plain warning when they are close or far (it warns, it never refuses).
   */
  function drawStarts() {
    const st = v.starts;
    if (!st) return;
    const options = [...st.places.map((p) => [p.id, startName(p.id)]), ...st.marks.map((mk) => [mk.id, startName(mk.id)])];
    for (const team of ['blue', 'red']) {
      const sel = $(`g-${team}`);
      if (!stale(`g-${team}-box`, [options, st.now[team]])) continue;
      sel.replaceChildren(...options.map(([id, name]) => el('option', { value: id, selected: id === st.now[team], text: name })));
    }
    const [text, warn] = startsHint(st.now.blue, st.now.red);
    $('g-starts-hint').textContent = text;
    $('g-starts-hint').classList.toggle('warn', warn);
  }
  /** A start's name: a place, or your spot (`m3`, or `near.church` for the game's own copy) near one. */
  const startName = (id) => {
    if (typeof id === 'string' && id.startsWith('near.')) return `your spot near ${START_NAMES[id.slice(5)] ?? id.slice(5)}`;
    const mk = v?.starts?.marks.find((x) => x.id === id);
    return mk ? `your spot ${mk.id.slice(1)}, near ${START_NAMES[mk.near] ?? mk.near}` : START_NAMES[id] ?? id;
  };
  const centreOf = (id) => v?.starts?.marks.find((x) => x.id === id) ?? v?.starts?.places.find((p) => p.id === id) ?? null;
  /** The metres between two starts, or null. */
  const apart = (a, b) => {
    const p = centreOf(a);
    const q = centreOf(b);
    return p && q ? Math.round(Math.hypot(p.x - q.x, p.z - q.z)) : null;
  };
  /** The line under the two pickers: [text, a warning]. */
  const startsHint = (a, b) => {
    const d = apart(a, b);
    if (d === null) return ['', false];
    if (d < v.starts.near) return [`⚠ ${d} m apart: close. The teams would shoot each other as they start.`, true];
    if (d > v.starts.far) return [`⚠ ${d} m apart: far. The teams would hardly meet.`, true];
    return [`${d} m apart.`, false];
  };

  /** The people: found by what is typed, sorted as chosen, each with their team and one menu of actions. */
  function drawPeople() {
    const find = $('find').value.trim().toLowerCase();
    const list = [...v.players, ...(v.away ?? [])].filter((p) => !find || p.name.includes(find)); // the rooms' players too, tagged
    const by = { name: (a, b) => a.name.localeCompare(b.name), points: (a, b) => b.points - a.points || b.kills - a.kills, ping: (a, b) => (b.ping ?? -1) - (a.ping ?? -1), address: byAddress }[sortBy === 'address' && !showAddresses ? 'name' : sortBy];
    list.sort((a, b) => (a.role === 'admin') - (b.role === 'admin') || by(a, b));
    const teamIds = v.teams.list.slice(0, v.teams.count);
    if (!stale('people-list', [list.map((p) => ({ ...p, ping: p.ping === null ? null : Math.round(p.ping / 20) * 20 })), teamIds, find, sortBy, showAddresses])) return;
    if (!list.length) {
      $('people-list').replaceChildren(el('li', { class: 'empty', text: find ? `Nobody called “${find}”` : 'Nobody here yet. Players type the address shown when the server started.' }));
      return;
    }
    $('people-list').replaceChildren(...list.map((p) => {
      const me = p.role === 'admin';
      const inDuel = p.where?.startsWith('duel'); // the duel plays them for the team they had at its start: no move during it
      const team = teamIds.length && !me
        ? el('select', { 'aria-label': `Team of ${p.name}`, disabled: inDuel, title: inDuel ? 'In the Zombies duel: move them once it is over' : '', on: { change: (e) => act({ op: 'move', name: p.name, team: Number(e.target.value) }) } },
          ...teamIds.map((t, i) => el('option', { value: String(i), selected: p.team === t.id, text: TEAM_NAMES[t.id] })))
        : null;
      if (team) team.style.borderLeftColor = teamIds.find((t) => t.id === p.team)?.color ?? 'transparent';
      const ping = p.ping === null ? '' : `${p.ping} ms`;
      return el('li', { class: p.alive ? '' : 'down' },
        el('span', { class: 'who' }, el('b', { text: p.name }), me ? el('small', { text: ' (you)' }) : null, p.where ? el('small', { class: 'tag', text: p.where === 'room' ? 'Zombies room' : `duel ${p.where.slice(5)}` }) : null, p.muted ? el('small', { class: 'tag', text: 'muted' }) : null,
          addressOf(p)),
        el('span', { class: `meta${level('pingHigh', p.ping) ? ` lv${level('pingHigh', p.ping)}` : ''}`, text: `${p.points} pts${ping ? ` · ${ping}` : ''}` }),
        team ?? el('span'),
        me ? el('span') : el('button', { class: 'btn ghost small more', type: 'button', 'aria-label': `Actions for ${p.name}`, 'aria-haspopup': 'menu', text: '⋯', on: { click: (e) => openMenu(e.currentTarget, p) } }),
      );
    }));
  }

  // ------------------------------------------------------------------ the players' network addresses
  // Each connection's address as the server read it (server/host.mjs connectionOf), to find a device in the network's
  // own logs. Asked of the server only while shown, and by Copy list; hidden when the page opens (others may see this
  // screen). Shown as text only (textContent), never as HTML.

  /** An IPv4 address as the network's own logs write it: Node gives a dual-stack socket's as ::ffff:a.b.c.d. */
  function plainAddress(ip) {
    return String(ip ?? '').replace(/^::ffff:(?=\d{1,3}(\.\d{1,3}){3}$)/i, '');
  }

  /** Order by address: IPv4 by its numbers, then IPv6, then the unknown; the name when two are the same. */
  function byAddress(a, b) {
    const key = (ip) => {
      const s = plainAddress(ip);
      const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      return m ? `4${m.slice(1).map((n) => n.padStart(3, '0')).join('.')}` : s.includes(':') ? `6${s.toLowerCase()}` : '9';
    };
    return key(a.ip).localeCompare(key(b.ip)) || a.name.localeCompare(b.name);
  }

  /** "2026-11-21 19:02:11" on this computer's clock (as a network log beside it writes it). */
  const stamp = (ms) => new Date(ms).toLocaleString('sv-SE');

  /** The address line in a player's row: only while the switch is on. */
  function addressOf(p) {
    if (!showAddresses || !p.ip) return null;
    return el('small', { class: 'address', text: plainAddress(p.ip), title: p.since ? `Connected since ${stamp(p.since)}` : '' });
  }

  /** Text to the clipboard: the Clipboard API where the page is secure (https, localhost), else the older copy command (plain http on the hall's network). */
  async function toClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const box = el('textarea', { readonly: true, 'aria-hidden': 'true', class: 'copy-box' });
      box.value = text;
      document.body.append(box);
      box.select();
      let done = false;
      try {
        done = document.execCommand('copy');
      } catch {
        // no way to copy here
      }
      box.remove();
      return done;
    }
  }

  /** Copy list: everyone connected (the house and the rooms), one line each: name, team, address, connected since, tab-separated. */
  async function copyList() {
    let data;
    try {
      const r = await fetch('/api/host?addresses=1', { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      data = await r.json();
    } catch {
      return toast('No answer from the server', true);
    }
    const list = [...data.players, ...(data.away ?? [])].sort(sortBy === 'address' ? byAddress : (a, b) => a.name.localeCompare(b.name));
    const lines = list.map((p) => [
      p.name, TEAM_NAMES[p.team] ?? '-', p.ip ? plainAddress(p.ip) : 'unknown', p.since ? stamp(p.since) : '-',
    ].join('\t'));
    const text = [`Players connected at ${stamp(Date.now())} (this computer's clock)`, ['Name', 'Team', 'Address', 'Connected since'].join('\t'), ...lines].join('\n');
    if (await toClipboard(text)) toast(`Copied ${list.length} player${list.length === 1 ? '' : 's'}`);
    else toast('This browser would not copy. Try again in Chrome or Edge.', true);
  }

  /** One player's actions, in a small menu by the button. */
  function openMenu(anchor, p) {
    const pop = $('menu-pop');
    const close = () => {
      pop.hidden = true;
      anchor.focus();
    };
    const item = (text, f, cls = '') => el('button', { type: 'button', role: 'menuitem', class: cls, text, on: { click: () => (f(), close()) } });
    const kick = el('button', { type: 'button', role: 'menuitem', class: 'danger' });
    twice(kick, 'Kick for 10 minutes', 'Click again to kick', { op: 'kick', name: p.name }, `${p.name} is out for 10 minutes`, close);
    const ban = el('button', { type: 'button', role: 'menuitem', class: 'danger' });
    twice(ban, 'Kick for tonight', 'Click again: out tonight', { op: 'kick', name: p.name, evening: true }, `${p.name} is out for tonight`, close);
    pop.replaceChildren(
      el('p', { class: 'pop-name', text: p.name }),
      item('📍 Bring to me', () => act({ op: 'bring', name: p.name }, `${p.name} is on the way`)),
      item(p.muted ? '🔈 Unmute chat' : '🔇 Mute chat', () => act({ op: 'mute', name: p.name, on: !p.muted }, p.muted ? `${p.name} can chat again` : `${p.name} is muted`)),
      kick, ban,
    );
    const r = anchor.getBoundingClientRect();
    pop.hidden = false;
    pop.style.left = `${Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth))}px`;
    pop.style.top = `${Math.min(innerHeight - pop.offsetHeight - 8, r.bottom + 6) + scrollY}px`;
    pop.querySelector('button')?.focus();
  }
  document.addEventListener('click', (e) => {
    const pop = $('menu-pop');
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest?.('.more')) pop.hidden = true;
  });

  /** The server's verdict, its figures each with the last fifteen minutes, and the computer it runs on. */
  function drawServer(worst) {
    const s = v.server;
    const samples = s?.samples ?? [];
    const last = samples.at(-1);
    const health = $('health');
    if (!last) {
      health.className = 'health';
      health.textContent = 'Measuring… the first figures come within five seconds.';
      $('meters').replaceChildren();
      return;
    }
    const busy = Object.keys(LIMITS).filter((k) => level(k, last[k]) === worst && worst > 0);
    const NAMES = { tickMs: 'game tick', cpu: 'processor', lagMs: 'delays', mbitOut: 'network', pingHigh: 'a slow connection', memMB: 'memory' };
    health.className = `health ${LEVELS[worst].cls}`;
    health.replaceChildren(el('b', { text: `${LEVELS[worst].icon} ${LEVELS[worst].word}` }), el('span', { text: worst ? ` · look at: ${busy.map((k) => NAMES[k]).join(', ')}` : ' · plenty of room left' }));
    const meters = [
      { key: 'tickMs', title: 'Game tick', value: last.tickMs, unit: 'ms', note: `of ${s.tickBudgetMs} ms · slowest ${last.tickMaxMs} ms` },
      { key: 'cpu', title: 'Processor', value: last.cpu, unit: '%', note: 'of one core (the game uses one)' },
      { key: 'lagMs', title: 'Delays', value: last.lagMs, unit: 'ms', note: 'how late the server answers, at worst' },
      { key: 'mbitOut', title: 'Network out', value: last.mbitOut, unit: 'Mbit/s', note: `${last.kbOutPerSec} KB/s · ${last.outPerSec} messages/s` },
      { key: 'pingHigh', title: 'Slowest ping', value: last.pingHigh, unit: 'ms', note: last.pingMid === null ? 'nobody playing' : `middle ${last.pingMid} ms · fastest ${last.pingLow} ms` },
      { key: 'memMB', title: 'Memory', value: last.memMB, unit: 'MB', note: `${last.heapMB} MB in use by the game` },
    ];
    if (stale('meters', [samples.length, last.at])) {
      $('meters').replaceChildren(...meters.map((mt) => {
        const lv = level(mt.key, mt.value);
        return el('div', { class: `meter lv${lv}` },
          el('div', { class: 'meter-head' }, el('span', { text: mt.title }), el('i', { class: 'state', text: LEVELS[lv].icon, title: LEVELS[lv].word })),
          el('div', { class: 'meter-value' }, el('b', { text: mt.value === null ? '–' : String(mt.value) }), el('small', { text: ` ${mt.unit}` })),
          spark(samples, mt.key, mt.title, mt.unit, s.every),
          el('div', { class: 'meter-note', text: mt.note }),
        );
      }));
    }
    const up = s.uptimeS;
    $('server-about').textContent = `${last.players} playing · ${last.watchers} watching · ${last.rooms} Zombies room${last.rooms === 1 ? '' : 's'} · up ${up >= 3600 ? `${Math.floor(up / 3600)} h ` : ''}${Math.floor((up % 3600) / 60)} min · ${s.cores} cores, ${Math.round(last.sysFreeMB / 102.4) / 10} of ${Math.round(s.sysTotalMB / 102.4) / 10} GB free · Node ${s.node}${s.inDocker ? ' · in Docker' : ''}`;
  }

  /** The last fifteen minutes of one figure as a thin line; pointing at it says the value and when. */
  function spark(samples, key, title, unit, every) {
    const W = 160, H = 34, P = 2;
    const vals = samples.map((x) => x[key]);
    const nums = vals.filter((x) => typeof x === 'number');
    const max = Math.max(1e-9, ...nums, LIMITS[key]?.[0] ?? 0);
    const x = (i) => P + (samples.length < 2 ? W - 2 * P : (i / (samples.length - 1)) * (W - 2 * P));
    const y = (val) => H - P - (val / max) * (H - 2 * P);
    const box = el('div', { class: 'spark' });
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: String(H), role: 'img', 'aria-label': `${title}, last ${Math.round((samples.length * every) / 60000)} minutes` });
    // The line where a figure becomes busy, when it is in sight.
    const warn = LIMITS[key]?.[0];
    if (warn !== undefined && warn <= max) s.append(svg('line', { x1: P, x2: W - P, y1: y(warn), y2: y(warn), class: 'limit-line' }));
    const pts = vals.map((val, i) => (typeof val === 'number' ? `${x(i).toFixed(1)},${y(val).toFixed(1)}` : null)).filter(Boolean);
    if (pts.length) s.append(svg('polyline', { points: pts.join(' '), class: 'line' }));
    const cross = svg('line', { y1: 0, y2: H, class: 'cross', visibility: 'hidden' });
    const dot = svg('circle', { r: 3.5, class: 'dot', visibility: 'hidden' });
    s.append(cross, dot);
    const tip = el('div', { class: 'tip', hidden: true });
    box.append(s, tip);
    const show = (clientX) => {
      const r = s.getBoundingClientRect();
      const frac = (((clientX - r.left) / r.width) * W - P) / (W - 2 * P);
      const i = Math.max(0, Math.min(samples.length - 1, Math.round(frac * (samples.length - 1))));
      const val = vals[i];
      if (typeof val !== 'number') return;
      for (const [k, a] of [['x1', x(i)], ['x2', x(i)]]) cross.setAttribute(k, a);
      dot.setAttribute('cx', x(i));
      dot.setAttribute('cy', y(val));
      cross.setAttribute('visibility', 'visible');
      dot.setAttribute('visibility', 'visible');
      const ago = Math.round((Date.now() - samples[i].at) / 1000);
      tip.textContent = `${val} ${unit} · ${ago < 60 ? `${ago} s` : `${Math.round(ago / 60)} min`} ago`;
      tip.hidden = false;
      tip.style.left = `${Math.min(r.width - tip.offsetWidth, Math.max(0, (x(i) / W) * r.width - tip.offsetWidth / 2))}px`;
    };
    s.addEventListener('pointermove', (e) => show(e.clientX));
    s.addEventListener('pointerleave', () => {
      cross.setAttribute('visibility', 'hidden');
      dot.setAttribute('visibility', 'hidden');
      tip.hidden = true;
    });
    return box;
  }

  // ------------------------------------------------------------------ helpers and controls

  const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
  /**
   * Attack and defend as it stands (server/assault.mjs view): the round or the break, who defends where, how far the flag
   * got, and each round played (the capture's time, or how far it got).
   */
  const assaultLine = (a) => {
    const where = a.round === 1 ? 'the church' : 'the Sparrenhof';
    const done = a.results.map((r, i) => `round ${i + 1}: ${TEAM_NAMES[r.def === 'blue' ? 'red' : 'blue']} ${r.ms === null ? `got ${r.best}%` : `captured in ${(r.ms / 1000).toFixed(1)} s`}`);
    const now = a.phase === 'break' ? 'break before round 2' : `round ${a.round} of 2, ${TEAM_NAMES[a.def]} defends ${where}, flag ${a.best}% of the way`;
    return ` · ${[now, ...done].join(' · ')}`;
  };
  /** The teams game in the programme: its name, where each team starts and how far apart, a warning when close or far. */
  const teamsPart = (e) => {
    if ((e.blue ?? 'house') === 'house' && (e.red ?? 'bungalow') === 'bungalow') return 'House against bungalow';
    const d = apart(e.blue, e.red);
    const [hint, warn] = startsHint(e.blue, e.red);
    return `Team against team, blue at ${startName(e.blue)}, red at ${startName(e.red)}${d === null ? '' : `, ${warn ? hint.replace(/: .*/, '') : `${d} m apart`}`}`;
  };
  const describe = (e) => `${e.kind === 'teams' ? teamsPart(e) : KINDS[e.kind]}${e.kind === 'assault' ? `, ${TEAM_NAMES[e.defend] ?? 'Blue'} defends the church first` : ''}${e.kind === 'duel' ? (e.duel === 'final' ? ', final' : ', warm-up') : ''}${e.kind === 'zombies' ? ` at ${PLACES[e.place] ?? e.place}` : ''}${e.kind === 'flag' ? `, ${FIELDS[e.place] ?? e.place}` : ''}${e.minutes ? `, ${e.minutes} min` : ''}${e.goal ? `, to ${e.goal}` : ''}`;
  const setProgramme = (list) => act({ op: 'programme', list });
  const moveEntry = (i, d) => {
    const list = [...v.programme];
    [list[i], list[i + d]] = [list[i + d], list[i]];
    setProgramme(list);
  };
  const formEntry = () => {
    const kind = $('g-kind').value;
    const minutes = Number($('g-minutes').value) || undefined;
    const goal = kind === 'teams' ? Number($('g-goal').value) || undefined : undefined;
    const duel = kind === 'duel' ? $('g-duel').value : undefined;
    const defend = kind === 'assault' ? $('g-defend').value : undefined; // Attack and defend: who defends the church in round 1
    const starts = kind === 'teams' ? { blue: $('g-blue').value || undefined, red: $('g-red').value || undefined } : {}; // the teams game: where each team starts
    return { kind, place: kind === 'zombies' ? $('g-place').value : kind === 'flag' ? $('g-field').value : kind === 'assault' ? 'assault' : 'house', minutes: kind === 'zombies' || duel === 'final' ? undefined : minutes, goal, look: $('g-look').value || null, duel, defend, ...starts };
  };
  const showFields = () => {
    const kind = $('g-kind').value;
    $('g-place-label').hidden = kind !== 'zombies';
    $('g-field-label').hidden = kind !== 'flag';
    $('g-defend-label').hidden = kind !== 'assault';
    $('g-minutes').max = kind === 'assault' ? '15' : '30'; // Attack and defend: each round's minutes
    $('g-goal-label').hidden = kind !== 'teams';
    for (const id of ['g-blue-box', 'g-red-box', 'g-starts-hint']) $(id).hidden = kind !== 'teams';
    $('g-minutes').disabled = kind === 'zombies' || (kind === 'duel' && $('g-duel').value === 'final');
    $('g-duel-label').hidden = kind !== 'duel';
  };
  // ---- How many may play at once: any whole number from 2 up, the host's alone (server/game.mjs: no ceiling in the
  // code). Past what was measured as comfortable on the host's computer, a line says so; it never refuses a number.
  // TESTED: tools/dev/crowd.mjs and a page among scripted players, 21 Nov 2026 (see DECISIONS.md).
  const TESTED = 60;
  const limitOf = (text) => (/^\s*\d+\s*$/.test(text) && Number.isSafeInteger(Number(text)) && Number(text) >= 2 ? Number(text) : null);
  /** The field as the server has it (unless the host is typing in it), and its line. */
  function showLimit() {
    const limit = $('limit');
    if (document.activeElement !== limit) limit.value = String(v.max);
    limitNote();
  }
  /** The line under the field: past TESTED, what that means; a number the field can't take, what it takes. */
  function limitNote() {
    const text = $('limit').value;
    const n = limitOf(text);
    const note = $('limit-note');
    note.textContent = n === null ? (text.trim() ? 'A whole number, 2 or more.' : '') : n > TESTED ? `Tested up to ${TESTED} players on this PC. Above that the game may stutter.` : '';
    note.classList.toggle('bad', n === null);
    note.hidden = !note.textContent;
  }
  function setLimit() {
    const n = limitOf($('limit').value);
    if (n === null || n === v?.max) return;
    act({ op: 'limit', max: n }, `${n} players at once`);
  }
  function announce(text) {
    act({ op: 'announce', text, secs: Number($('announce-secs').value) }, `Announced: ${text}`);
    recent = [text, ...recent.filter((x) => x !== text)].slice(0, 4);
    store.set('recent', recent);
  }

  $('g-kind').replaceChildren(...Object.entries(KINDS).map(([k, n]) => el('option', { value: k, text: n })));
  $('g-place').replaceChildren(...Object.entries(PLACES).map(([k, n]) => el('option', { value: k, text: n })));
  $('g-look').replaceChildren(...Object.entries(LOOKS).map(([k, n]) => el('option', { value: k, text: n })));
  $('g-field').replaceChildren(...Object.entries(FIELDS).map(([k, n]) => el('option', { value: k, text: n })));
  $('g-kind').addEventListener('change', showFields);
  // The teams game's starts: a place picked is tonight's start for that team at once; "Where I stand" makes the spot where
  // the server has you in the game that team's start (the page sends only the team: server/host.mjs mark).
  const setStarts = () => act({ op: 'starts', blue: $('g-blue').value, red: $('g-red').value }, `Blue starts at ${startName($('g-blue').value)}, red at ${startName($('g-red').value)}`);
  $('g-blue').addEventListener('change', setStarts);
  $('g-red').addEventListener('change', setStarts);
  $('g-blue-here').addEventListener('click', () => act({ op: 'mark', team: 'blue' }, 'Blue starts where you stand'));
  $('g-red-here').addEventListener('click', () => act({ op: 'mark', team: 'red' }, 'Red starts where you stand'));
  $('g-duel').addEventListener('change', showFields);
  showFields();

  const doorsToggle = () => act({ op: 'lock', on: !v.locked }, v.locked ? 'Doors open' : 'Doors locked: newcomers wait at the door');
  $('doors').addEventListener('click', doorsToggle);
  $('chip-doors').addEventListener('click', doorsToggle);
  $('limit').addEventListener('input', limitNote);
  $('limit').addEventListener('change', setLimit);
  $('freeze').addEventListener('click', () => act({ op: 'freeze', on: !v.frozen, text: $('freeze-text').value }, v.frozen ? 'Everyone can move again' : 'Everyone stands still'));
  $('announce-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('announce').value.trim();
    if (!text) return;
    announce(text);
    $('announce').value = '';
  });
  $('bring-all').addEventListener('click', () => act({ op: 'bring', name: '*' }, 'Everyone is on the way to you'));
  $('chat').addEventListener('click', () => act({ op: 'chat', on: v.chatOff }, v.chatOff ? 'Chat on' : 'Chat off'));
  for (const b of $('team-count').querySelectorAll('button')) b.addEventListener('click', () => act({ op: 'teams', count: Number(b.dataset.n) }, Number(b.dataset.n) ? `${b.dataset.n} teams, shuffled` : 'No teams'));
  for (const b of $('sort').querySelectorAll('button')) {
    b.addEventListener('click', () => {
      sortBy = b.dataset.sort;
      store.set('sort', sortBy);
      render();
    });
  }
  $('show-addresses').checked = false; // never kept on from before (a browser may restore a checkbox on reload)
  $('show-addresses').addEventListener('change', (e) => {
    showAddresses = e.target.checked;
    $('sort-address').hidden = !showAddresses;
    if (v) render(); // hidden at once; shown with the next view, which brings them
    refresh();
  });
  $('copy-list').addEventListener('click', copyList);
  $('find').addEventListener('input', () => v && render());
  $('shuffle').addEventListener('click', () => act({ op: 'shuffle' }, 'Teams shuffled'));
  $('words-save').addEventListener('click', () => act({ op: 'words', list: $('words').value.split(/\s*\n\s*/).filter(Boolean) }, 'Words saved'));
  $('stop').addEventListener('click', () => act({ op: 'stop' }, 'Stopped'));
  $('cancel').addEventListener('click', () => act({ op: 'cancel' }, 'Called off'));
  /** Attack and defend's rounds last 1 to 15 minutes each (server/host.mjs ASSAULT_MINUTES): more is said here, never dropped quietly. */
  const tooLong = (e) => e.kind === 'assault' && e.minutes > 15 && (toast('Attack and defend: each round 1 to 15 minutes', true), true);
  $('game-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const entry = formEntry();
    if (!tooLong(entry)) act({ op: 'start', ...entry }, 'Starting in 10 seconds');
  });
  $('add').addEventListener('click', () => {
    const entry = formEntry();
    if (!tooLong(entry)) setProgramme([...(v?.programme ?? []), entry]);
  });
  $('next').addEventListener('click', () => act({ op: 'next' }, 'Starting in 10 seconds'));
  twice($('reset'), 'Start a new evening', 'Sure? All points go', { op: 'reset' }, 'A new evening');
  // Keys: / to announce, Esc to close a menu.
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('menu-pop').hidden = true;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
    if (e.key === '/' && !typing) {
      e.preventDefault();
      $('announce').focus();
    }
  });

  refresh();
  setInterval(refresh, 1000);
})();
