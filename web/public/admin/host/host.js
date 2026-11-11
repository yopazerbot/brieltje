// The host's screen for a LAN night (server/host.mjs). Reads GET /api/host once a second and sends one action at a time
// with POST /api/host (the admin's session from /admin; same-origin JSON only). Everything players typed or are called
// is put in with textContent, never as HTML. Fields being typed in are never overwritten by the refresh.
(() => {
  const $ = (id) => document.getElementById(id);
  const KINDS = { hide: 'Hide and seek', tag: 'Tag', treasure: 'Treasure hunt', teams: 'House against bungalow', zombies: 'Zombies' };
  const PLACES = { house: 'The house', bungalow: 'The bungalow', church: 'The church square', molenhoek: 'Molenhoek', molenhoek_mid: 'Molenhoek, middle', molenhoek_end: 'Molenhoek, end', sparrenhof: 'Sparrenhof' };
  const TEAM_NAMES = { blue: 'Blue', orange: 'Orange', green: 'Green', purple: 'Purple' };
  let v = null; // the last view
  let busy = false;
  let sure = null; // a button that asks for a second click: { el, until }
  const drawn = {}; // what each list was last drawn from: drawn again only when it changed (buttons stay under the finger)
  /** Whether a list must be drawn again: its data changed, and nothing in it is being used (a select open, a click to confirm). */
  const stale = (id, data) => {
    const key = JSON.stringify(data);
    const box = $(id);
    if (drawn[id] === key || box.contains(document.activeElement) && document.activeElement.tagName === 'SELECT' || (sure && box.contains(sure.el))) return false;
    drawn[id] = key;
    return true;
  };

  const el = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, val] of Object.entries(props)) {
      if (k === 'text') e.textContent = val;
      else if (k === 'on') for (const [ev, f] of Object.entries(val)) e.addEventListener(ev, f);
      else if (k === 'dataset') Object.assign(e.dataset, val);
      else if (val !== undefined && val !== null && val !== false) e.setAttribute(k, val === true ? '' : val);
    }
    e.append(...kids.filter(Boolean));
    return e;
  };
  const say = (text, bad = false) => {
    $('msg').textContent = text;
    $('msg').classList.toggle('bad', bad);
    clearTimeout(say.t);
    say.t = setTimeout(() => ($('msg').textContent = ''), 5000);
  };

  async function act(body, done) {
    if (busy) return;
    busy = true;
    try {
      const r = await fetch('/api/host', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) say(data.error || `Refused (${r.status})`, true);
      else if (done) say(done);
    } catch {
      say('No answer from the server', true);
    } finally {
      busy = false;
      refresh();
    }
  }

  /** A button that does its thing on the second click within 4 s (for what can't be undone). */
  const twice = (btn, label, ask, body, done) => {
    btn.addEventListener('click', () => {
      if (sure?.el === btn && Date.now() < sure.until) {
        sure = null;
        btn.textContent = label;
        act(typeof body === 'function' ? body() : body, done);
        return;
      }
      sure = { el: btn, until: Date.now() + 4000 };
      btn.textContent = ask;
      setTimeout(() => {
        if (sure?.el === btn) {
          sure = null;
          btn.textContent = label;
        }
      }, 4000);
    });
  };

  async function refresh() {
    let r;
    try {
      r = await fetch('/api/host', { cache: 'no-store' });
    } catch {
      $('live').classList.remove('on');
      $('live-text').textContent = 'No connection';
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
    $('live').classList.add('on');
    $('live-text').textContent = 'Live';
    render();
  }

  function render() {
    // The bar.
    const doors = $('doors');
    doors.textContent = v.locked ? '🔒 Doors locked' : '🔓 Doors open';
    doors.classList.toggle('on', v.locked);
    doors.title = v.locked ? 'Newcomers wait until you let them in. Tonight\'s players come back in on their own.' : 'Anyone can come in.';
    const limit = $('limit');
    limit.max = String(v.most);
    if (document.activeElement !== limit) limit.value = String(v.max);
    $('limit-value').textContent = limit.value;
    const freeze = $('freeze');
    freeze.textContent = v.frozen ? '▶ Let everyone go' : '⏸ Freeze everyone';
    freeze.classList.toggle('on', !!v.frozen);
    $('chat').textContent = v.chatOff ? 'Turn the chat on' : 'Turn the chat off';
    if (document.activeElement !== $('words')) $('words').value = v.words.join('\n');

    // People.
    const players = [...v.players].sort((a, b) => (a.role === 'admin') - (b.role === 'admin') || a.name.localeCompare(b.name));
    $('people-count').textContent = `${v.players.length} / ${v.max}`;
    $('knocking').hidden = !v.knocking.length;
    if (stale('knock-list', v.knocking)) $('knock-list').replaceChildren(...v.knocking.map((n) => el('li', {},
      el('b', { text: n }),
      el('button', { class: 'btn small', type: 'button', text: 'Let in', on: { click: () => act({ op: 'admit', name: n }, `${n} may come in`) } }),
      el('button', { class: 'btn ghost small', type: 'button', text: 'Not now', on: { click: () => act({ op: 'refuse', name: n }) } }),
    )));
    for (const b of $('team-count').querySelectorAll('button')) b.setAttribute('aria-pressed', String(Number(b.dataset.n) === v.teams.count));
    $('shuffle').hidden = !v.teams.count;
    const teamIds = v.teams.list.slice(0, v.teams.count);
    if (stale('people', [players.map((p) => ({ ...p, ping: p.ping === null ? null : Math.round(p.ping / 20) * 20 })), teamIds])) $('people').replaceChildren(...players.map((p) => {
      const me = p.role === 'admin';
      const team = teamIds.length && !me
        ? el('select', { 'aria-label': `Team of ${p.name}`, on: { change: (e) => act({ op: 'move', name: p.name, team: Number(e.target.value) }) } },
          ...teamIds.map((t, i) => el('option', { value: String(i), selected: p.team === t.id, text: TEAM_NAMES[t.id] })))
        : null;
      if (team) team.style.borderLeftColor = teamIds.find((t) => t.id === p.team)?.color ?? 'transparent';
      const kick = el('button', { class: 'btn ghost small danger', type: 'button', text: 'Kick' });
      twice(kick, 'Kick', 'Out for 10 min?', { op: 'kick', name: p.name }, `${p.name} is out for 10 minutes`);
      const ban = el('button', { class: 'btn ghost small danger', type: 'button', text: 'Kick for tonight' });
      twice(ban, 'Kick for tonight', 'Sure? Tonight', { op: 'kick', name: p.name, evening: true }, `${p.name} is out for tonight`);
      return el('li', { class: p.alive ? '' : 'down' },
        el('span', { class: 'who' }, el('b', { text: p.name }), me ? el('small', { text: ' you' }) : null, p.muted ? el('small', { class: 'tag', text: 'muted' }) : null),
        el('span', { class: 'meta', text: `${p.points} pts · ${p.kills}/${p.deaths}${p.ping === null ? '' : ` · ${p.ping} ms`}` }),
        me ? null : el('span', { class: 'acts' },
          team,
          el('button', { class: 'btn ghost small', type: 'button', text: 'Bring', on: { click: () => act({ op: 'bring', name: p.name }, `${p.name} is on the way`) } }),
          el('button', { class: 'btn ghost small', type: 'button', text: p.muted ? 'Unmute' : 'Mute', on: { click: () => act({ op: 'mute', name: p.name, on: !p.muted }) } }),
          kick, ban),
      );
    }));

    // The game now.
    const m = v.mode;
    const now = $('now-game');
    if (v.countdown) now.replaceChildren(el('b', { text: `${KINDS[v.countdown.kind]} starts in ${Math.ceil(v.countdown.ms / 1000)} s` }));
    else if (m.kind === 'free') now.replaceChildren(el('b', { text: 'Free play' }), el('span', { class: 'muted', text: ' (first to 10 kills wins a round)' }));
    else {
      const left = m.ms ? `${Math.floor(m.ms / 60000)}:${String(Math.floor((m.ms % 60000) / 1000)).padStart(2, '0')}` : '';
      const extra = m.kind === 'teams' && m.score ? ` · House ${m.score.house} – ${m.score.bungalow} Bungalow (to ${m.goal})` : m.kind === 'zombies' && m.zombies ? ` · wave ${m.zombies.wave ?? ''}` : '';
      now.replaceChildren(el('b', { text: KINDS[m.kind] ?? m.kind }), el('span', { text: `${m.phase === 'done' ? ' · over' : ''}${left ? ` · ${left} left` : ''}${extra}` }), m.result ? el('p', { class: 'muted', text: m.result }) : null);
    }
    $('stop').disabled = m.kind === 'free';
    $('cancel').hidden = !v.countdown;

    // Programme.
    if (stale('programme', [v.programme, v.next])) $('programme').replaceChildren(...v.programme.map((e, i) => el('li', { class: i < v.next ? 'done' : i === v.next ? 'next' : '' },
      el('span', { text: describe(e) }),
      el('span', { class: 'acts' },
        el('button', { class: 'btn ghost small', type: 'button', title: 'Earlier', text: '↑', disabled: i === 0, on: { click: () => moveEntry(i, -1) } }),
        el('button', { class: 'btn ghost small', type: 'button', title: 'Later', text: '↓', disabled: i === v.programme.length - 1, on: { click: () => moveEntry(i, 1) } }),
        el('button', { class: 'btn ghost small', type: 'button', title: 'From here', text: '⟲', on: { click: () => act({ op: 'rewind', index: i }) } }),
        el('button', { class: 'btn ghost small danger', type: 'button', title: 'Remove', text: '×', on: { click: () => setProgramme(v.programme.filter((_, k) => k !== i)) } }),
      ))));
    if (!v.programme.length && drawn.programme !== 'empty' && (drawn.programme = 'empty')) $('programme').replaceChildren(el('li', { class: 'muted', text: 'Add games with “Add to the programme”.' }));
    const nxt = v.programme[v.next];
    $('next').textContent = nxt ? `Next: ${describe(nxt)}` : 'Programme done';
    $('next').disabled = !nxt || !!v.countdown;

    // Tonight's scoreboard.
    $('games-count').textContent = v.board.games ? `${v.board.games} game${v.board.games === 1 ? '' : 's'}` : '';
    $('team-totals').replaceChildren(...v.board.teams.map((t) => el('span', { class: 'team-total' }, el('i', { style: `background:${t.color}` }), el('b', { text: TEAM_NAMES[t.id] }), el('span', { text: ` ${t.points}` }))));
    $('board').replaceChildren(...v.board.players.map((p, i) => el('tr', { class: p.here ? '' : 'away' },
      el('td', { text: String(i + 1) }), el('td', { text: p.name + (p.team ? ` (${TEAM_NAMES[p.team]})` : '') }), el('td', { text: String(p.points) }), el('td', { text: String(p.wins) }), el('td', { text: String(p.played) }))));
    if (!v.board.players.length) $('board').replaceChildren(el('tr', {}, el('td', { colspan: '5', class: 'muted', text: 'No games played yet tonight.' })));
  }

  const describe = (e) => `${KINDS[e.kind]}${e.kind === 'zombies' ? ` at ${PLACES[e.place] ?? e.place}` : ''}${e.minutes ? `, ${e.minutes} min` : ''}${e.goal ? `, to ${e.goal}` : ''}`;
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
    return { kind, place: kind === 'zombies' ? $('g-place').value : 'house', minutes: kind === 'zombies' ? undefined : minutes, goal };
  };
  const showFields = () => {
    const kind = $('g-kind').value;
    $('g-place-label').hidden = kind !== 'zombies';
    $('g-goal-label').hidden = kind !== 'teams';
    $('g-minutes').disabled = kind === 'zombies';
  };

  // The form's lists.
  $('g-kind').replaceChildren(...Object.entries(KINDS).map(([k, n]) => el('option', { value: k, text: n })));
  $('g-place').replaceChildren(...Object.entries(PLACES).map(([k, n]) => el('option', { value: k, text: n })));
  $('g-kind').addEventListener('change', showFields);
  showFields();

  // The controls.
  $('doors').addEventListener('click', () => act({ op: 'lock', on: !v.locked }, v.locked ? 'Doors open' : 'Doors locked: newcomers wait at the door'));
  $('limit').addEventListener('input', () => ($('limit-value').textContent = $('limit').value));
  $('limit').addEventListener('change', () => act({ op: 'limit', max: Number($('limit').value) }));
  $('freeze').addEventListener('click', () => act({ op: 'freeze', on: !v.frozen, text: $('freeze-text').value }));
  $('announce-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('announce').value.trim();
    if (!text) return;
    act({ op: 'announce', text, secs: Number($('announce-secs').value) }, 'Announced');
    $('announce').value = '';
  });
  $('bring-all').addEventListener('click', () => act({ op: 'bring', name: '*' }, 'Everyone is on the way to you'));
  $('chat').addEventListener('click', () => act({ op: 'chat', on: v.chatOff }));
  for (const b of $('team-count').querySelectorAll('button')) b.addEventListener('click', () => act({ op: 'teams', count: Number(b.dataset.n) }, Number(b.dataset.n) ? 'Teams shuffled' : 'No teams'));
  $('shuffle').addEventListener('click', () => act({ op: 'shuffle' }, 'Teams shuffled'));
  $('words-save').addEventListener('click', () => act({ op: 'words', list: $('words').value.split(/\s*\n\s*/).filter(Boolean) }, 'Words saved'));
  $('stop').addEventListener('click', () => act({ op: 'stop' }, 'Stopped'));
  $('cancel').addEventListener('click', () => act({ op: 'cancel' }, 'Called off'));
  $('game-form').addEventListener('submit', (e) => {
    e.preventDefault();
    act({ op: 'start', ...formEntry() }, 'Starting in 10 seconds');
  });
  $('add').addEventListener('click', () => setProgramme([...(v?.programme ?? []), formEntry()]));
  $('next').addEventListener('click', () => act({ op: 'next' }, 'Starting in 10 seconds'));
  twice($('reset'), 'Start a new evening', 'Sure? All points go', { op: 'reset' }, 'A new evening');
  $('reset').textContent = 'Start a new evening';

  refresh();
  setInterval(refresh, 1000);
})();
