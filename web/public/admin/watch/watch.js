// The admin's watch page (src/watch.ts): 1 to 4 views of the game, each following a player. Who plays comes from
// GET /api/host every two seconds (the admin's session). Each view is a frame of the game page; the frame knows it
// is a watch view from its data-tile and data-views (read once as it starts) and takes whom to follow from this page
// with postMessage, our own origin only. Names are put in with textContent. The choices are remembered in this
// browser (localStorage, keys briel.watch.*), a convenience only.
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
  let views = Math.min(4, Math.max(1, Number(store.get('views', 1)) || 1));
  // Per view: the player chosen ('' for automatic) and the way of watching.
  let picks = store.get('picks', []);
  let players = []; // [{ name, kills, points }] as the server has them
  let rotation = 0;
  const frames = [];

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

  /** Whom view i follows now: its own pick while that player is here, else the best players in turn (not twice). */
  function targetOf(i) {
    const p = picks[i] ?? { target: '', mode: 'behind' };
    const here = players.map((x) => x.name);
    if (p.target && here.includes(p.target)) return p.target;
    const taken = new Set(picks.slice(0, views).map((q) => q?.target).filter((n) => n && here.includes(n)));
    const free = [...players].sort((a, b) => b.kills - a.kills || b.points - a.points || a.name.localeCompare(b.name)).map((x) => x.name).filter((n) => !taken.has(n));
    const autos = picks.slice(0, views).map((q, k) => (!q?.target || !here.includes(q.target) ? k : -1)).filter((k) => k >= 0);
    const k = autos.indexOf(i);
    return free.length ? free[(k + rotation) % free.length] : '';
  }

  /** Tell each view whom to follow. */
  function tell() {
    frames.forEach((f, i) => {
      try {
        f.frame.contentWindow?.postMessage({ briel: 'watch', target: targetOf(i), mode: picks[i]?.mode ?? 'behind' }, location.origin);
      } catch {
        // not loaded yet: told when it says it is ready
      }
    });
  }

  /** The views, made again for a new number of them (each frame is a whole copy of the game). */
  function build() {
    $('tiles').className = `tiles n${views}`;
    frames.length = 0;
    const tiles = [];
    for (let i = 0; i < views; i++) {
      picks[i] ??= { target: '', mode: 'behind' };
      const frame = el('iframe', { title: `View ${i + 1}`, 'data-tile': String(i + 1), 'data-views': String(views), tabindex: '-1' });
      frame.src = '/';
      const who = el('select', { 'aria-label': `Player in view ${i + 1}`, on: { change: (e) => choose(i, { target: e.target.value }) } });
      const mode = el('span', { class: 'seg small' },
        el('button', { type: 'button', 'data-mode': 'behind', text: 'Behind', on: { click: () => choose(i, { mode: 'behind' }) } }),
        el('button', { type: 'button', 'data-mode': 'eyes', text: 'Eyes', on: { click: () => choose(i, { mode: 'eyes' }) } }));
      const note = el('div', { class: 'note' });
      const tile = el('section', { class: 'tile' }, frame, note, el('div', { class: 'controls' }, who, mode));
      frames.push({ frame, who, mode, note });
      tiles.push(tile);
    }
    $('tiles').replaceChildren(...tiles);
    for (const b of $('layout').querySelectorAll('button')) b.setAttribute('aria-pressed', String(Number(b.dataset.n) === views));
    controls();
  }

  function choose(i, change) {
    picks[i] = { ...picks[i], ...change };
    store.set('picks', picks);
    controls();
    tell();
  }

  /** Each view's picker and buttons, as they stand. */
  function controls() {
    frames.forEach((f, i) => {
      const p = picks[i];
      const names = players.map((x) => x.name);
      if (document.activeElement !== f.who) {
        f.who.replaceChildren(el('option', { value: '', text: `Automatic${targetOf(i) ? ` (${targetOf(i)})` : ''}` }),
          ...names.map((n) => el('option', { value: n, text: n })),
          ...(p.target && !names.includes(p.target) ? [el('option', { value: p.target, text: `${p.target} (away)` })] : []));
        f.who.value = p.target;
      }
      for (const b of f.mode.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === p.mode));
    });
  }

  async function refresh() {
    const r = await fetch('/api/host', { cache: 'no-store' }).catch(() => null);
    if (!r) return;
    if (r.status === 401 || r.status === 403) {
      $('gate').hidden = false;
      return;
    }
    if (!r.ok) return;
    $('gate').hidden = true;
    const v = await r.json();
    players = v.players.filter((p) => p.role !== 'admin').map((p) => ({ name: p.name, kills: p.kills, points: p.points }));
    controls();
    tell();
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
      f.note.textContent = 'Only the admin can watch. Log in on the admin page.';
    }
  });

  for (const b of $('layout').querySelectorAll('button')) {
    b.addEventListener('click', () => {
      views = Number(b.dataset.n);
      store.set('views', views);
      build();
    });
  }
  $('rotate').checked = !!store.get('rotate', false);
  $('rotate').addEventListener('change', () => store.set('rotate', $('rotate').checked));
  setInterval(() => {
    if (!$('rotate').checked) return;
    rotation++;
    controls();
    tell();
  }, 20_000);

  const full = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
  $('full').addEventListener('click', full);
  addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'f' && !e.repeat && !(e.target instanceof HTMLSelectElement)) full();
  });
  // The controls go when the mouse is still (as on a TV), and come back when it moves.
  let idle = 0;
  const wake = () => {
    document.body.classList.remove('idle');
    clearTimeout(idle);
    idle = setTimeout(() => {
      if (!document.querySelector('select:focus')) document.body.classList.add('idle');
    }, 3000);
  };
  addEventListener('mousemove', wake);
  addEventListener('keydown', wake);
  wake();

  build();
  refresh();
  setInterval(refresh, 2000);
})();
