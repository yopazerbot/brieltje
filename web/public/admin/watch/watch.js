// The admin's watch page (src/watch.ts), the hall screen of a LAN night (Yoshi, 16 Nov 2026: "The hall screen should
// show: the scores, the clock, but also split-screen spectator mode where I as admin can chose what is shown (I can
// navigate the spectator)."): a bar across the top for the back of the hall (the game, its clock, blue's and red's
// score, each flag or each duel team's wave, between games the evening's totals) over 1 to 4 views of the game, each
// following a player.
//
// - What is played and who plays where come from GET /api/host each second (the admin's session; server/host.mjs view:
//   the game, the evening's board, the Zombies duel and who plays in its rooms). The clocks count down here between two
//   reads, from the time left the server gave.
// - Each view is a frame of the game page; the frame knows it is a watch view from its data-tile and data-views (read
//   once as it starts) and takes whom to follow, how, and where that player plays (the open world or a duel team's
//   room) from this page with postMessage, to our own origin only; it hears only this page (src/watch.ts onWatch).
// - Steered from the keyboard without the controls on the screen (KEYS below); the controls are hidden once started.
// - After a team game, its results moment over everything for 20 s, and short stings through the hall's speakers once
//   someone touched the page (hall.js, shared with the scoreboard).
// - Names are what players typed: everything is put in with textContent. The choices are remembered in this browser
//   (localStorage, keys briel.watch.*), a convenience only.
(() => {
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) {
      try {
        return JSON.parse(localStorage.getItem(`briel.watch.${k}`)) ?? d;
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(`briel.watch.${k}`, JSON.stringify(v));
      } catch {
        // storage blocked
      }
    },
  };

  // ------------------------------------------------------------------ words (the hall reads them: Dutch first)

  const T = {
    nl: {
      free: 'Vrij spel', hide: 'Verstoppertje', tag: 'Tikkertje', treasure: 'Schattenjacht', teams: 'Huis tegen bungalow', teamvteam: 'Team tegen team', zombies: 'Zombies',
      flag: 'Pak de vlag', duel: 'Zombies-duel', warmup: 'opwarmer', final: 'finale', tonight: 'Vanavond',
      blue: 'Blauw', red: 'Rood', green: 'Groen', purple: 'Paars', house: 'Huis', bungalow: 'Bungalow',
      flagHome: 'Vlag thuis', flagBy: 'Vlag bij {name}', flagGround: 'Vlag op de grond · {n} s', sudden: 'Sudden death: de volgende vlag wint',
      compact: 'Kerk tegen Molenhoek', village: 'Kerk tegen Sparrenhof', goal: 'Eerste tot {n}', over: 'Afgelopen', won: '{team} wint!', draw: 'Gelijkspel',
      wave: 'golf', best: 'beste golf {n}', out: 'uit in golf {n}', beaten: '{n} zombies', players: '{n} spelers', players1: '1 speler',
      untilOut: 'Tot één team uit is', zleft: 'golf {n} · nog {k} zombies', zbreak: 'golf {n} · pauze', next: 'Straks: {game}', starts: 'Begint zo',
      games: '{n} spellen gespeeld', games1: '1 spel gespeeld', noGames: 'Nog geen spellen gespeeld', points: 'punten', nobodyYet: 'Nog niemand speelt',
      // The controls (only the host sees them).
      automatic: 'Automatisch', action: 'Actie', away: 'weg', behind: 'Achter', eyes: 'Ogen', views: 'Beelden', rotate: 'Elke 20 s wisselen',
      fullScreen: 'Volledig scherm (F)', host: 'Host', gate: 'Log eerst in op de', gateLink: 'beheerpagina', gateTail: ', en kom dan terug.',
      notAdmin: 'Alleen de beheerder kan meekijken. Log in op de beheerpagina.', hint: 'H: bediening', noTeam: 'Zonder team',
      keys: '{d14} beeld · ← → speler · ↑ ↓ team · E achter/ogen · A actie volgen · {d0} automatisch · Z één beeld groot · N aantal beelden · H bediening · F volledig scherm · L taal',
      inside: 'Binnen in een huis', wonScore: '{team} wint! {a}–{b}', wonTags: '{team} wint op tikken, {a}–{b}', drawScore: 'Gelijkspel, {a}–{b}',
      // Attack and defend (server/assault.mjs).
      assault: 'Aanvallen en verdedigen', aRound: 'Ronde {n} van 2 · {team} verdedigt {place}', aBreak: 'Pauze · ronde 2 aan de Sparrenhof', church: 'de kerk', sparrenhof: 'de Sparrenhof',
      defends: 'verdedigt', attacks: 'valt aan · vlag op {n}%', inTime: 'in {s} s', got: '{n}% ver', aTime: '{team} wint! Snelste verovering: {a} s', aOnly: '{team} wint! Enige verovering: {a} s',
      aFar: '{team} wint! Vlag het verst: {a}%', aTags: '{team} wint op tikken, {a}–{b}', aDraw: 'Gelijkspel',
    },
    en: {
      free: 'Free play', hide: 'Hide and seek', tag: 'Tag', treasure: 'Treasure hunt', teams: 'House against bungalow', teamvteam: 'Team against team', zombies: 'Zombies',
      flag: 'Steal the flag', duel: 'Zombies duel', warmup: 'warm-up', final: 'final', tonight: 'Tonight',
      blue: 'Blue', red: 'Red', green: 'Green', purple: 'Purple', house: 'House', bungalow: 'Bungalow',
      flagHome: 'Flag home', flagBy: 'Flag: {name} has it', flagGround: 'Flag on the ground · {n} s', sudden: 'Sudden death: the next flag wins',
      compact: 'Church against Molenhoek', village: 'Church against Sparrenhof', goal: 'First to {n}', over: 'Over', won: '{team} wins!', draw: 'A draw',
      wave: 'wave', best: 'best wave {n}', out: 'out at wave {n}', beaten: '{n} zombies', players: '{n} players', players1: '1 player',
      untilOut: 'Until one team is out', zleft: 'wave {n} · {k} zombies left', zbreak: 'wave {n} · break', next: 'Next: {game}', starts: 'Starting soon',
      games: '{n} games played', games1: '1 game played', noGames: 'No games played yet', points: 'points', nobodyYet: 'Nobody plays yet',
      automatic: 'Automatic', action: 'Action', away: 'away', behind: 'Behind', eyes: 'Eyes', views: 'Views', rotate: 'Switch players every 20 s',
      fullScreen: 'Full screen (F)', host: 'Host', gate: 'Log in on the', gateLink: 'admin page', gateTail: ' first, then come back here.',
      notAdmin: 'Only the admin can watch. Log in on the admin page.', hint: 'H: controls', noTeam: 'No team',
      keys: '{d14} view · ← → player · ↑ ↓ team · E behind/eyes · A follow the action · {d0} automatic · Z one view big · N number of views · H controls · F full screen · L language',
      inside: 'Inside a home', wonScore: '{team} wins! {a}–{b}', wonTags: '{team} wins on tags, {a}–{b}', drawScore: 'A draw, {a}–{b}',
      assault: 'Attack and defend', aRound: 'Round {n} of 2 · {team} defends {place}', aBreak: 'Break · round 2 at the Sparrenhof', church: 'the church', sparrenhof: 'the Sparrenhof',
      defends: 'defends', attacks: 'attacks · flag {n}% of the way', inTime: 'in {s} s', got: '{n}% of the way', aTime: '{team} wins! Fastest capture: {a} s', aOnly: '{team} wins! The only capture: {a} s',
      aFar: '{team} wins! The flag got furthest: {a}%', aTags: '{team} wins on tags, {a}–{b}', aDraw: 'A draw',
    },
  };
  let lang = store.get('lang', null);
  if (lang !== 'en' && lang !== 'nl') {
    try {
      lang = localStorage.getItem('briel.lang') === 'en' ? 'en' : 'nl';
    } catch {
      lang = 'nl';
    }
  }
  const t = (k, args = {}) => (T[lang][k] ?? T.en[k] ?? k).replace(/\{(\w+)\}/g, (_, a) => String(args[a] ?? ''));

  // ------------------------------------------------------------------ state

  // The evening's teams' colours (server/host.mjs EVENING_TEAMS) and the games' own (server/modes.mjs, flagFields.mjs).
  const COLOURS = { blue: '#4fa3e0', red: '#e5484d', green: '#5cc28a', purple: '#c77dff', house: '#4fa3e0', bungalow: '#ff9f43' };
  const TEAM_ORDER = ['blue', 'house', 'red', 'bungalow', 'green', 'purple'];
  const HOLD_MS = 6000; // "follow the action": a view keeps whom it shows at least this long
  const AUTO_MS = 15_000; // automatic: a view keeps its player at least this long, longer unless the players rotate
  const colour = (c, d = '#8a93b8') => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : d);
  const num = (n) => (Number.isFinite(n) ? n : 0);

  let views = Math.min(4, Math.max(1, Number(store.get('views', 1)) || 1));
  // Per view: the player chosen ('' for automatic), the way of watching, and "follow the action".
  let picks = store.get('picks', []);
  if (!Array.isArray(picks)) picks = [];
  let selected = 0; // the view the keys steer
  let solo = false; // the selected view alone, full screen (Z)
  let players = []; // [{ name, team, colour, duel, kills, deaths, beaten }] as the server has them, grouped by team
  let host = null; // the last GET /api/host
  let hostAt = 0; // when it came (performance.now())
  let rotation = 0;
  const frames = [];
  const shown = []; // whom each view shows now
  const held = []; // per view following the action: { who, since }
  const kept = []; // per view on automatic: { who, since, rotation }
  const acted = new Map(); // name -> when they last fought, scored or went down (performance.now())
  const counts = new Map(); // name -> their counts at the last read

  const el = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'text') e.textContent = v;
      else if (k === 'on') for (const [ev, f] of Object.entries(v)) e.addEventListener(ev, f);
      else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
    }
    e.append(...kids.filter(Boolean));
    return e;
  };
  const pick = (i) => (picks[i] ??= { target: '', mode: 'behind', follow: false });
  const here = (n) => players.some((p) => p.name === n);
  const playerOf = (n) => players.find((p) => p.name === n);
  // Inside a private home (the host's view says so; the server shows a watch view nobody there): never the picture,
  // a card instead, and never picked by automatic or "follow the action".
  const inside = (n) => playerOf(n)?.inside === true;
  const visible = (n) => here(n) && !inside(n);

  // ------------------------------------------------------------------ whom each view shows

  /** Who did something last: the flag carriers first (Steal the flag), then whoever fought, scored or went down last. */
  function actionList() {
    const flags = host?.mode?.kind === 'flag' ? host.mode.flag?.flags ?? {} : {};
    const carriers = Object.values(flags).filter((f) => f?.at === 'carried' && typeof f.by === 'string').map((f) => f.by);
    const recent = [...acted.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    return [...new Set([...carriers, ...recent])].filter(visible);
  }

  /**
   * In the Zombies duel, the room the k-th view on automatic watches: half on blue, half on red (1, 3: blue first); a
   * room that is out or has nobody to show, the other. '' when no duel is on.
   */
  function sideFor(k) {
    const d = host?.duel;
    if (!d || !Array.isArray(d.sides)) return '';
    const open = (team) => d.sides.some((x) => x.team === team && !x.out) && players.some((p) => p.duel === team && !p.inside);
    const want = k % 2 === 0 ? 'blue' : 'red';
    const other = want === 'blue' ? 'red' : 'blue';
    return open(want) || !open(other) ? want : other;
  }

  /** The best players in turn, for the views on automatic. */
  function bestList() {
    return [...players].sort((a, b) => b.kills + b.beaten - (a.kills + a.beaten) || a.name.localeCompare(b.name)).map((p) => p.name);
  }

  /**
   * Whom every view shows: its own pick while that player is here (inside a home: the card); else, following the action,
   * whoever did something last (not one another view shows, and held at least HOLD_MS); else, automatic, the best
   * players in turn (not twice), each kept at least AUTO_MS and until the players rotate, and in the Zombies duel on its
   * own room (sideFor), so a view does not jump between the rooms (each jump is a new connection, a blank).
   */
  function decide() {
    const now = performance.now();
    const taken = new Set();
    for (let i = 0; i < views; i++) {
      const p = pick(i);
      shown[i] = !p.follow && p.target && here(p.target) ? p.target : '';
      if (shown[i]) taken.add(shown[i]);
    }
    const list = actionList();
    for (let i = 0; i < views; i++) {
      const p = pick(i);
      if (!p.follow) continue;
      const h = held[i];
      let who = h && visible(h.who) && !taken.has(h.who) && now - h.since < HOLD_MS ? h.who : list.find((n) => !taken.has(n)) ?? '';
      if (!who && h && visible(h.who) && !taken.has(h.who)) who = h.who; // nobody new: stay
      if (who && who !== h?.who) held[i] = { who, since: now };
      shown[i] = who;
      if (who) taken.add(who);
    }
    const best = bestList();
    let k = 0;
    for (let i = 0; i < views; i++) {
      if (shown[i]) continue;
      const side = sideFor(k++);
      const fits = (n) => visible(n) && !taken.has(n) && (!side || playerOf(n)?.duel === side);
      const c = kept[i];
      let who = c && fits(c.who) && (now - c.since < AUTO_MS || c.rotation === rotation) ? c.who : '';
      if (!who) {
        let free = best.filter(fits);
        if (!free.length) free = best.filter((n) => visible(n) && !taken.has(n)); // nobody there: anyone
        who = free.length ? free[(i + rotation) % free.length] : '';
      }
      if (who !== c?.who) kept[i] = { who, since: now, rotation };
      shown[i] = who;
      if (who) taken.add(who);
    }
  }

  /** Tell each view whom to follow, how, and where that player plays. */
  function tell() {
    decide();
    frames.forEach((f, i) => {
      const who = shown[i] ?? '';
      const duel = players.find((p) => p.name === who)?.duel ?? '';
      // Inside a private home: a calm card over the view, with their name (the view itself shows nobody inside).
      f.card.hidden = !(who && inside(who));
      f.cardName.textContent = f.card.hidden ? '' : who;
      try {
        f.frame.contentWindow?.postMessage({ briel: 'watch', target: who, mode: pick(i).mode, duel }, location.origin);
      } catch {
        // not loaded yet: told when it says it is ready
      }
    });
    controls();
  }

  // ------------------------------------------------------------------ the views

  /** The views, made again for a new number of them (each frame is a whole copy of the game). */
  function build() {
    $('tiles').className = 'tiles';
    frames.length = 0;
    held.length = 0;
    kept.length = 0;
    selected = Math.min(selected, views - 1);
    const tiles = [];
    for (let i = 0; i < views; i++) {
      pick(i);
      const frame = el('iframe', { title: `View ${i + 1}`, 'data-tile': String(i + 1), 'data-views': String(views), tabindex: '-1' });
      frame.src = '/';
      const who = el('select', { 'aria-label': `Player in view ${i + 1}`, on: { change: (e) => choose(i, { target: e.target.value, follow: e.target.value === '*' }) } });
      const mode = el('span', { class: 'seg small' },
        el('button', { type: 'button', 'data-mode': 'behind', on: { click: () => choose(i, { mode: 'behind' }) } }),
        el('button', { type: 'button', 'data-mode': 'eyes', on: { click: () => choose(i, { mode: 'eyes' }) } }));
      const note = el('div', { class: 'note' });
      const cardName = el('span');
      const cardWord = el('b', { text: t('inside') });
      const card = el('div', { class: 'card', hidden: true }, cardWord, cardName);
      const badge = el('span', { class: 'num', text: String(i + 1) });
      const tile = el('section', { class: 'tile', on: { click: () => select(i) } }, frame, card, note, el('div', { class: 'controls' }, badge, who, mode));
      frames.push({ frame, who, mode, note, tile, card, cardName, cardWord });
      tiles.push(tile);
    }
    $('tiles').replaceChildren(...tiles);
    layout();
    tell();
  }

  /** The grid for the number of views, or the selected view alone. */
  function layout() {
    $('tiles').className = `tiles n${solo ? 1 : views}${solo ? ' solo' : ''}`;
    frames.forEach((f, i) => {
      f.tile.classList.toggle('sel', i === selected);
      f.tile.classList.toggle('parked', solo && i !== selected); // out of sight and a few pixels big: next to nothing to draw
    });
    for (const b of $('layout').querySelectorAll('button')) b.setAttribute('aria-pressed', String(Number(b.dataset.n) === views));
  }

  function choose(i, change) {
    const p = pick(i);
    if (change.follow) change.target = '';
    picks[i] = { ...p, ...change };
    if ('target' in change && !change.follow) picks[i].follow = false;
    store.set('picks', picks);
    held[i] = null;
    tell();
  }

  /** The view the keys steer; a short flash of its edge says which. */
  function select(i) {
    if (i < 0 || i >= views) return;
    selected = i;
    layout();
    flash(i);
  }

  let flashTimer = 0;
  function flash(i) {
    const tile = frames[i]?.tile;
    if (!tile) return;
    for (const f of frames) f.tile.classList.remove('flash');
    void tile.offsetWidth;
    tile.classList.add('flash');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => tile.classList.remove('flash'), 1400);
  }

  /** Each view's picker and buttons, as they stand (the players grouped by team). */
  function controls() {
    frames.forEach((f, i) => {
      const p = pick(i);
      if (document.activeElement !== f.who) {
        const groups = new Map();
        for (const x of players) {
          const k = x.team ?? '';
          if (!groups.has(k)) groups.set(k, el('optgroup', { label: x.team ? t(x.team) : t('noTeam') }));
          groups.get(k).append(el('option', { value: x.name, text: x.name }));
        }
        const auto = shown[i] && !p.target && !p.follow ? ` (${shown[i]})` : '';
        const act = p.follow && shown[i] ? ` (${shown[i]})` : '';
        f.who.replaceChildren(el('option', { value: '', text: `${t('automatic')}${auto}` }), el('option', { value: '*', text: `${t('action')}${act}` }),
          ...groups.values(),
          ...(p.target && !here(p.target) ? [el('option', { value: p.target, text: `${p.target} (${t('away')})` })] : []));
        f.who.value = p.follow ? '*' : p.target;
      }
      for (const b of f.mode.querySelectorAll('button')) {
        b.textContent = t(b.dataset.mode);
        b.setAttribute('aria-pressed', String(b.dataset.mode === p.mode));
      }
    });
  }

  // ------------------------------------------------------------------ the server's state

  async function refresh() {
    const r = await fetch('/api/host', { cache: 'no-store' }).catch(() => null);
    if (!r) return;
    if (r.status === 401 || r.status === 403) {
      $('gate').hidden = false;
      return;
    }
    if (!r.ok) return;
    $('gate').hidden = true;
    const v = await r.json().catch(() => null);
    if (!v || !Array.isArray(v.players)) return;
    host = v;
    hostAt = performance.now();
    players = roster(v);
    // Who fought, scored or went down since the last read: the action.
    for (const p of players) {
      const c = `${p.kills}|${p.deaths}|${p.beaten}`;
      if (counts.has(p.name) && counts.get(p.name) !== c) acted.set(p.name, hostAt);
      counts.set(p.name, c);
    }
    for (const n of [...counts.keys()]) if (!here(n)) (counts.delete(n), acted.delete(n));
    tell();
    hall();
  }

  /** Everyone playing (the open world and the duel's rooms), with their team and its colour, grouped by team. */
  function roster(v) {
    const mode = v.mode ?? {};
    const gameTeams = (mode.kind === 'teams' || mode.kind === 'flag') && mode.phase !== 'done' && mode.teams && typeof mode.teams === 'object' ? mode.teams : null;
    const evening = new Map((v.teams?.list ?? []).map((x) => [x.id, x.color]));
    const list = [];
    for (const p of v.players) {
      if (p.role === 'admin' || typeof p.name !== 'string') continue;
      const g = gameTeams && typeof gameTeams[p.name] === 'string' ? gameTeams[p.name] : null;
      const team = g ?? (typeof p.team === 'string' ? p.team : null);
      const c = g ? colour(mode.colors?.[g], COLOURS[g]) : colour(evening.get(team), COLOURS[team]);
      list.push({ name: p.name, team: sideName(team, mode), colour: c, duel: '', kills: num(p.kills), deaths: num(p.deaths), beaten: 0, inside: p.inside === true });
    }
    for (const p of Array.isArray(v.inDuel) ? v.inDuel : []) {
      if (typeof p.name !== 'string' || (p.side !== 'blue' && p.side !== 'red')) continue;
      list.push({ name: p.name, team: p.side, colour: COLOURS[p.side], duel: p.side, kills: num(p.kills), deaths: num(p.deaths), beaten: num(p.beaten), inside: p.inside === true });
    }
    const rank = (team) => (team ? (TEAM_ORDER.indexOf(team) + 1 || 99) : 100);
    return list.sort((a, b) => rank(a.team) - rank(b.team) || a.name.localeCompare(b.name));
  }

  /** House against bungalow played by the evening's blue and red (server/host.mjs sideColors): called blue and red. */
  function sideName(team, mode) {
    if (team !== 'house' && team !== 'bungalow') return team;
    const c = mode?.colors ?? {};
    return c.house === COLOURS.blue && c.bungalow === COLOURS.red ? (team === 'house' ? 'blue' : 'red') : team;
  }

  // ------------------------------------------------------------------ the bar across the top

  const clock = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const timeOfDay = () => new Date().toLocaleTimeString(lang === 'en' ? 'en-GB' : 'nl-BE', { hour: '2-digit', minute: '2-digit' });

  /** What the bar shows now: { title, sub, clock, dim (the time of day, no game clock), teams: [{ id, score, unit, line }] }. */
  function state() {
    const v = host;
    if (!v) return { title: '', sub: '', clock: '', teams: [] };
    const gone = performance.now() - hostAt; // the time left counts down here between two reads
    const left = (ms) => Math.max(0, num(ms) - gone);
    const d = v.duel;
    if (d && Array.isArray(d.sides)) {
      const done = d.phase === 'done';
      const winner = d.winner === 'blue' || d.winner === 'red' ? t('won', { team: t(d.winner) }) : d.winner === 'draw' ? t('draw') : '';
      return {
        title: `${t('duel')} · ${t(d.kind === 'final' ? 'final' : 'warmup')}`,
        sub: done ? winner || t('over') : d.kind === 'final' ? t('untilOut') : '',
        clock: !done && d.kind !== 'final' ? clock(left(d.ms)) : '',
        teams: d.sides.filter((s) => s.team === 'blue' || s.team === 'red').map((s) => ({
          id: s.team, score: num(s.wave), unit: t('wave'),
          line: s.out ? t('out', { n: num(s.wave) }) : [num(s.best) > num(s.wave) ? t('best', { n: num(s.best) }) : '', t('beaten', { n: num(s.beaten) })].filter(Boolean).join(' · '),
          sub: num(s.players) === 1 ? t('players1') : t('players', { n: num(s.players) }), out: !!s.out,
        })),
      };
    }
    const m = v.mode ?? { kind: 'free' };
    const evening = () => (v.board?.teams ?? []).map((x) => ({ id: x.id, score: num(x.points), unit: t('points'), line: x.players?.length === 1 ? t('players1') : t('players', { n: x.players?.length ?? 0 }) }));
    if (v.countdown) {
      return { title: t('next', { game: t(v.countdown.open ? 'teamvteam' : v.countdown.kind) }), sub: t('starts'), clock: clock(left(v.countdown.ms)), teams: evening() };
    }
    const playing = m.phase !== 'done';
    /** The game's end: who won (or the draw) with the final score, from the server's result (modes.mjs finish). */
    const result = (left, right) => {
      const a = m.resultArgs && typeof m.resultArgs === 'object' ? m.resultArgs : {};
      const team = typeof a.team === 'string' ? t(sideName(a.team, m)) : '';
      const score = { a: num(a[left] ?? m.score?.[left]), b: num(a[right] ?? m.score?.[right]) };
      if (m.resultCode === 'flagTagsWon' && team) return t('wonTags', { team, a: num(a.a), b: num(a.b) });
      if ((m.resultCode === 'flagFarBlue' || m.resultCode === 'flagFarRed') && team) return t('aFar', { team, a: num(a.a) }); // level: the flag got furthest (server/modes.mjs flagOver)
      if ((m.resultCode === 'flagWon' || m.resultCode === 'teamWon' || m.resultCode === 'teamsTime') && team) return t('wonScore', { team, ...score });
      if (m.resultCode === 'flagDraw' || m.resultCode === 'teamsDraw') return t('drawScore', score);
      return t('over');
    };
    if (m.kind === 'flag' && m.flag?.assault) {
      // Attack and defend: the round and who defends where, each team's part (its best round so far: a capture's time or
      // how far it got), the clock; at the end who won and how.
      const a = m.flag.assault;
      const args = m.resultArgs && typeof m.resultArgs === 'object' ? m.resultArgs : {};
      const winner = typeof args.team === 'string' ? t(sideName(args.team, m)) : '';
      const end = { assaultTime: 'aTime', assaultOnly: 'aOnly', assaultFar: 'aFar', assaultTags: 'aTags' }[m.resultCode];
      const sub = !playing ? (end && winner ? t(end, { team: winner, a: num(args.a), b: num(args.b) }) : m.resultCode === 'assaultDraw' ? t('aDraw') : t('over'))
        : a.phase === 'break' ? t('aBreak') : t('aRound', { n: num(a.round), team: t(a.def), place: t(m.flag.field === 'assaultSparrenhof' ? 'sparrenhof' : 'church') });
      const mine = (team) => (a.results ?? []).find((r) => r.def !== team);
      const block = (team) => {
        const r = mine(team);
        const now = playing && a.phase !== 'break' ? (team === a.def ? t('defends') : t('attacks', { n: num(a.best) })) : '';
        const done = r ? (r.ms === null ? t('got', { n: num(r.best) }) : t('inTime', { s: Math.round(num(r.ms) / 100) / 10 })) : '';
        const carrier = team !== a.def && m.flag.flags?.[a.def]?.at === 'carried' ? t('flagBy', { name: String(m.flag.flags[a.def].by ?? '') }) : '';
        // Its round's result as the score: a capture's time (s) or how far the flag got (%); none before its round is over
        // (it showed an "S" over a dash).
        const score = !r ? '' : r.ms !== null ? (Math.round(num(r.ms) / 100) / 10).toFixed(1) : String(num(r.best));
        return { id: team, score, unit: !r ? '' : r.ms !== null ? 's' : '%', line: [carrier || now, done].filter(Boolean).join(' · '), carried: !!carrier };
      };
      return { title: t('assault'), sub, clock: playing ? clock(left(m.ms)) : '', teams: ['blue', 'red'].map(block) };
    }
    if (m.kind === 'flag' && m.flag) {
      const f = m.flag;
      const line = (team) => {
        const g = f.flags?.[team];
        if (g?.at === 'carried') return t('flagBy', { name: String(g.by ?? '') });
        if (g?.at === 'ground') return t('flagGround', { n: Math.ceil(left(g.ms) / 1000) });
        return t('flagHome');
      };
      return {
        title: t('flag'), sub: !playing ? result('blue', 'red') : f.sudden ? t('sudden') : t(f.field === 'village' ? 'village' : 'compact'),
        clock: playing ? clock(left(m.ms)) : '',
        teams: ['blue', 'red'].map((team) => ({ id: team, score: num(m.score?.[team]), line: line(team), carried: f.flags?.[team]?.at === 'carried' })),
      };
    }
    if (m.kind === 'teams') {
      return {
        title: t(m.open ? 'teamvteam' : 'teams'), sub: playing ? t('goal', { n: num(m.goal) }) : result('house', 'bungalow'), clock: playing ? clock(left(m.ms)) : '',
        teams: ['house', 'bungalow'].map((team) => ({ id: sideName(team, m), colour: colour(m.colors?.[team], COLOURS[team]), score: num(m.score?.[team]) })),
      };
    }
    if (m.kind === 'zombies' && m.zombies) {
      const z = m.zombies;
      return {
        title: t('zombies'), sub: !playing ? t('over') : m.phase === 'break' ? t('zbreak', { n: num(z.wave) }) : t('zleft', { n: num(z.wave), k: num(z.left) }),
        clock: playing && m.phase === 'break' ? clock(left(m.ms)) : '', teams: [],
      };
    }
    if (m.kind && m.kind !== 'free') {
      return { title: t(m.kind), sub: playing ? '' : t('over'), clock: playing ? clock(left(m.ms)) : '', teams: [] };
    }
    // Between games: the evening's totals (with teams), else free play.
    const teams = evening();
    if (teams.length) {
      const games = num(v.board?.games);
      return { title: t('tonight'), sub: games ? t(games === 1 ? 'games1' : 'games', { n: games }) : t('noGames'), clock: timeOfDay(), dim: true, teams };
    }
    const n = players.length;
    return { title: t('free'), sub: n ? (n === 1 ? t('players1') : t('players', { n })) : t('nobodyYet'), clock: timeOfDay(), dim: true, teams: [] };
  }

  /** A team's block on the bar: its name, its score, and a line (its flag, its wave). */
  function teamBlock(x, right) {
    const b = el('div', { class: `team${right ? ' right' : ''}${x.out ? ' out' : ''}${x.carried ? ' alarm' : ''}` });
    b.style.setProperty('--c', colour(x.colour, COLOURS[x.id]));
    const words = el('div', { class: 'words' }, el('div', { class: 't-name', text: t(x.id) }), x.line ? el('div', { class: 't-line', text: x.line }) : null, x.sub ? el('div', { class: 't-sub', text: x.sub }) : null);
    const score = x.score === '' ? el('div', { class: 't-score' }) : el('div', { class: 't-score' }, x.unit ? el('small', { text: x.unit }) : null, el('b', { text: String(x.score) }));
    b.append(...(right ? [score, words] : [words, score]));
    return b;
  }

  /**
   * A team game's results moment over the views, and the hall's stings (hall.js), from the last read: its time left
   * counted down here between two reads.
   */
  function results() {
    const H = window.BrielHall;
    if (!H) return;
    const m = host?.mode;
    const left = m && Number.isFinite(m.ms) ? Math.max(0, m.ms - (performance.now() - hostAt)) : 0;
    H.moment(document.body, m, left, host?.board, lang);
    H.hear(m ? { ...m, ms: left } : null);
  }

  let drawn = '';
  /** The bar, made again only when what it shows changed (four times a second: the clock). */
  function hall() {
    results();
    const s = state();
    const key = JSON.stringify(s) + lang;
    if (key === drawn) return;
    drawn = key;
    $('h-title').textContent = s.title;
    $('h-sub').textContent = s.sub;
    $('h-clock').textContent = s.clock;
    $('h-clock').classList.toggle('dim', !!s.dim);
    const half = Math.ceil(s.teams.length / 2);
    $('h-left').replaceChildren(...s.teams.slice(0, half).map((x) => teamBlock(x, false)));
    $('h-right').replaceChildren(...s.teams.slice(half).map((x) => teamBlock(x, true)));
    $('hall').classList.toggle('many', s.teams.length > 2);
  }

  // ------------------------------------------------------------------ the page's own words

  // The number keys go by where they sit (KeyboardEvent.code), so they work on AZERTY too, Shift or not; the help shows
  // them as this keyboard has them (its layout, where the browser gives it), else both ways.
  let digitLabels = { d14: '1–4 (AZERTY & é " \')', d0: '0 (AZERTY à)' };
  try {
    navigator.keyboard?.getLayoutMap?.().then((map) => {
      const k = (code) => map.get(code) ?? '';
      const top = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].map(k);
      digitLabels = top.join('') === '1234' ? { d14: '1–4', d0: '0' } : { d14: `${top.join(' ')} (1–4)`, d0: `${k('Digit0')} (0)` };
      words();
    }).catch(() => {});
  } catch {
    // no layout from this browser: both ways
  }

  function words() {
    document.documentElement.lang = lang;
    $('full').textContent = t('fullScreen');
    $('host-link').textContent = t('host');
    $('rotate-label').textContent = t('rotate');
    $('views-label').textContent = t('views');
    $('keys').textContent = t('keys', digitLabels);
    $('hint').textContent = t('hint');
    $('gate-text').replaceChildren(document.createTextNode(`${t('gate')} `), el('a', { href: '/admin/', text: t('gateLink') }), document.createTextNode(t('gateTail')));
    for (const f of frames) if (f.note.textContent) f.note.textContent = t('notAdmin');
    for (const f of frames) f.cardWord.textContent = t('inside');
    window.BrielHall?.sound.mount(lang); // the sound chip, in this language (hall.js)
    drawn = '';
    controls();
    hall();
  }

  // The views say when they are ready (then they are told whom to follow), or that they are not the admin's.
  addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.data?.briel !== 'watched') return;
    const f = frames.find((x) => x.frame.contentWindow === e.source);
    if (!f) return;
    if (e.data.state === 'ready') {
      f.note.textContent = '';
      tell();
    } else if (e.data.state === 'notAdmin') {
      f.note.textContent = t('notAdmin');
    }
  });

  // ------------------------------------------------------------------ the controls and the keys

  const setViews = (n) => {
    views = n;
    solo = false;
    store.set('views', views);
    build();
  };
  for (const b of $('layout').querySelectorAll('button')) b.addEventListener('click', () => setViews(Number(b.dataset.n)));
  $('rotate').checked = !!store.get('rotate', false);
  $('rotate').addEventListener('change', () => store.set('rotate', $('rotate').checked));
  setInterval(() => {
    if (!$('rotate').checked) return;
    rotation++;
    tell();
  }, 20_000);

  const full = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
  $('full').addEventListener('click', full);

  // The controls: hidden once started (the hall sees only the game), H shows them; a small hint for a few seconds.
  let shownControls = false;
  let hintTimer = 0;
  const hint = () => {
    if (shownControls) return;
    $('hint').classList.add('on');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => $('hint').classList.remove('on'), 4000);
  };
  const showControls = (on) => {
    shownControls = on;
    document.body.classList.toggle('steer', on);
    if (!on) hint();
    else $('hint').classList.remove('on');
  };
  let moved = 0;
  addEventListener('mousemove', () => {
    // The mouse while the controls are hidden: only the hint (and the pointer), never the controls on the screen.
    document.body.classList.remove('still');
    clearTimeout(moved);
    moved = setTimeout(() => document.body.classList.add('still'), 2500);
    hint();
  });

  /** One step through the players (grouped by team) in the selected view; `team`: to the next or previous team's first. */
  function step(dir, team = false) {
    if (!players.length) return;
    const now = shown[selected] || '';
    let i = players.findIndex((p) => p.name === now);
    if (team) {
      const teams = [...new Set(players.map((p) => p.team ?? ''))];
      const at = teams.indexOf(players[i]?.team ?? '');
      const next = teams[(at + dir + teams.length) % teams.length];
      i = players.findIndex((p) => (p.team ?? '') === next);
    } else i = i < 0 ? (dir > 0 ? 0 : players.length - 1) : (i + dir + players.length) % players.length;
    choose(selected, { target: players[i].name });
  }

  // KEYS (the list for the host is in T.keys).
  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const once = !e.repeat;
    let used = true;
    const digit = /^(Digit|Numpad)([0-4])$/.exec(e.code)?.[2]; // by place: AZERTY's & é " ' à too
    if (digit && digit !== '0') select(Number(digit) - 1);
    else if (k === 'ArrowRight') step(1);
    else if (k === 'ArrowLeft') step(-1);
    else if (k === 'ArrowDown') step(1, true);
    else if (k === 'ArrowUp') step(-1, true);
    else if (k === 'e' && once) choose(selected, { mode: pick(selected).mode === 'eyes' ? 'behind' : 'eyes' });
    else if (k === 'a' && once) choose(selected, { follow: !pick(selected).follow, target: '' });
    else if (digit === '0' && once) choose(selected, { target: '', follow: false });
    else if (k === 'z' && once) {
      solo = !solo && views > 1;
      layout();
    } else if (k === 'n' && once) setViews((views % 4) + 1);
    else if (k === 'h' && once) showControls(!shownControls);
    else if (k === 'f' && once) full();
    else if (k === 'l' && once) {
      lang = lang === 'nl' ? 'en' : 'nl';
      store.set('lang', lang);
      words();
    } else used = false;
    if (used) e.preventDefault();
  });

  build();
  words();
  showControls(false);
  refresh();
  setInterval(refresh, 1000);
  setInterval(hall, 250);
})();
