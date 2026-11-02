// The game night page (server/gamenight.mjs answers it): the night's place, date and time as the
// admin set them ("to be decided" until then), the form, then a thank-you with a private link to look
// at or cancel the registration later. That link carries its secret after the # so it never reaches
// a server log; the page sends it in a header. Dutch or English, as the game.
(() => {
  const $ = (id) => document.getElementById(id);
  const MAX = 10; // players, and spectators
  const T = {
    nl: {
      lastName: 'Vul je naam in.', firstName: 'Vul je voornaam in.', email: 'Vul een geldig e-mailadres in.', address: 'Vul je straat en gemeente in.', people: 'Tel minstens één speler of toeschouwer.',
      age: 'Vink aan dat je 13 jaar of ouder bent, of laat een ouder je inschrijven.',
      busy: 'Even te veel inschrijvingen. Probeer het over een paar minuten opnieuw.', failed: 'Dat lukte niet. Controleer je verbinding en probeer opnieuw.',
      sending: 'Bezig…', copied: 'Gekopieerd', gone: 'Deze inschrijving bestaat niet (meer).', cancelled: 'Je bent uitgeschreven. Je gegevens zijn gewist.',
      sure: 'Zeker? Klik nog eens om je uit te schrijven',
      place: 'Locatie', date: 'Datum', time: 'Tijdstip', tbd: 'Nog te bepalen', from: (t) => `vanaf ${t}`, until: (t) => `tot ${t}`,
      name_: 'Naam', email_: 'E-mail', address_: 'Adres', people_: 'Met hoeveel', wishes_: 'Ideeën of wensen', sent: 'Ingeschreven op',
      players: (n) => (n === 1 ? '1 speler' : `${n} spelers`), watchers: (n) => (n === 1 ? '1 toeschouwer' : `${n} toeschouwers`), and: 'en',
    },
    en: {
      lastName: 'Please fill in your last name.', firstName: 'Please fill in your first name.', email: 'Please fill in a valid email address.', address: 'Please fill in your street and town.', people: 'Count at least one player or spectator.',
      age: "Tick that you're 13 or older, or have a parent sign you up.",
      busy: 'Too many sign-ups right now. Please try again in a few minutes.', failed: "That didn't work. Check your connection and try again.",
      sending: 'Sending…', copied: 'Copied', gone: "This registration doesn't exist (any more).", cancelled: "You're no longer signed up. Your details have been removed.",
      sure: 'Sure? Click again to cancel',
      place: 'Place', date: 'Date', time: 'Time', tbd: 'To be decided', from: (t) => `from ${t}`, until: (t) => `until ${t}`,
      name_: 'Name', email_: 'Email', address_: 'Address', people_: 'How many', wishes_: 'Ideas or wishes', sent: 'Signed up on',
      players: (n) => (n === 1 ? '1 player' : `${n} players`), watchers: (n) => (n === 1 ? '1 spectator' : `${n} spectators`), and: 'and',
    },
  };
  let lang = 'nl';
  const t = (k) => T[lang][k];
  const el = (tag, cls, text) => {
    const x = document.createElement(tag);
    if (cls) x.className = cls;
    if (text !== undefined) x.textContent = text;
    return x;
  };
  const show = (e, on = true) => (e.hidden = !on);
  const error = (id, text) => {
    const e = $(id);
    e.textContent = text || '';
    show(e, !!text);
  };
  /** "2 players and 1 spectator", leaving out a count of nought. */
  const party = (p, w) => [p ? t('players')(p) : '', w ? t('watchers')(w) : ''].filter(Boolean).join(` ${t('and')} `);

  // ---- language: ?lang=, else the game's choice, else the browser's
  const pick = () => {
    const asked = new URLSearchParams(location.search).get('lang');
    if (asked === 'nl' || asked === 'en') return asked;
    try {
      const saved = localStorage.getItem('briel.lang');
      if (saved === 'nl' || saved === 'en') return saved;
    } catch {
      // storage blocked
    }
    return /^en\b/i.test(navigator.language || '') ? 'en' : 'nl';
  };
  let night = { place: '', date: '', from: '', until: '', open: true }; // as the admin set them, drawn again when the language changes
  let known = false; // whether the server said yet if the registrations are open
  let ownEntry = null;
  const setLang = (l) => {
    lang = l;
    document.documentElement.lang = l;
    document.title = l === 'nl' ? 'Inschrijven voor de game night · Brieltje' : 'Sign up for the game night · Brieltje';
    for (const b of document.querySelectorAll('.langs button')) b.setAttribute('aria-pressed', String(b.dataset.set === l));
    drawNight();
    if (ownEntry) drawOwn(ownEntry);
    if (done) $('done-people').textContent = party(done.players, done.watchers);
  };
  for (const b of document.querySelectorAll('.langs button')) b.addEventListener('click', () => setLang(b.dataset.set));

  // ---- the night: place, date, time, or "to be decided" for what the admin hasn't set yet
  /** A date of the server's calendar (YYYY-MM-DD), drawn at noon UTC in UTC: no time zone can shift it. */
  const day = (d) => {
    const [y, m, n] = d.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, n, 12)).toLocaleDateString(lang === 'nl' ? 'nl-BE' : 'en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  };
  function drawNight() {
    const { place, date, from, until } = night;
    const time = from && until ? `${from} – ${until}` : from ? t('from')(from) : until ? t('until')(until) : '';
    const rows = [[t('place'), place], [t('date'), date ? day(date) : ''], [t('time'), time]];
    for (const box of document.querySelectorAll('[data-event]')) {
      box.replaceChildren(...rows.map(([k, v]) => {
        const row = el('div');
        row.append(el('dt', '', k), el('dd', v ? '' : 'tbd', v || t('tbd')));
        return row;
      }));
    }
    for (const p of document.querySelectorAll('[data-later]')) show(p, !(place && date && time));
    // Closed (the hall is full): a thank-you instead of the form.
    show($('form'), known && night.open !== false);
    show($('intro'), night.open !== false);
    show($('closed'), known && night.open === false);
  }
  // If the server can't be asked, the form shows: sending tells whether it is still open.
  const loadNight = () =>
    fetch('/api/gamenight').then((r) => (r.ok ? r.json() : null)).catch(() => null).then((d) => {
      if (d) night = d;
      known = true;
      drawNight();
    });

  /** Your registration as labelled rows. */
  function drawOwn(e) {
    const list = el('div', 'own');
    const row = (k, v) => {
      const r = el('div', 'own-row');
      const box = el('div', 'own-v');
      box.append(v);
      r.append(el('div', 'own-k', k), box);
      list.append(r);
    };
    row(t('name_'), `${e.firstName} ${e.lastName}`);
    row(t('email_'), e.email);
    if (e.address) row(t('address_'), e.address);
    row(t('people_'), party(e.players, e.watchers));
    if (e.wishes) row(t('wishes_'), el('div', 'own-text', e.wishes));
    if (e.at) row(t('sent'), new Date(e.at).toLocaleString(lang === 'nl' ? 'nl-BE' : 'en-GB', { dateStyle: 'long', timeStyle: 'short' }));
    $('own-body').replaceChildren(list);
  }

  let done = null; // after signing up: the counts, for the thank-you in either language
  setLang(pick());

  // ---- your own registration, from the link (#mine=id.secret)
  const mine = /^#mine=(\d+)\.([\w-]{20,64})$/.exec(location.hash);
  if (mine) {
    show($('s-form'), false);
    show($('s-own'));
    const [, id, token] = mine;
    const headers = { 'X-Gamenight-Token': token };
    fetch(`/api/gamenight/${id}`, { headers }).then(async (r) => {
      if (!r.ok) throw new Error('gone');
      ownEntry = await r.json();
      night = ownEntry.event;
      drawNight();
      drawOwn(ownEntry);
    }).catch(() => {
      error('own-err', t('gone'));
      show($('own-cancel'), false);
      loadNight();
    });
    let armed = false;
    $('cancel').addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        $('cancel').textContent = t('sure');
        return;
      }
      $('cancel').disabled = true;
      const r = await fetch(`/api/gamenight/${id}`, { method: 'DELETE', headers: { ...headers, 'Content-Type': 'application/json' } }).catch(() => null);
      if (r?.ok) {
        ownEntry = null;
        error('own-err');
        $('own-body').replaceChildren(el('p', 'note', t('cancelled')));
        show($('own-cancel'), false);
        history.replaceState(null, '', location.pathname);
      } else {
        $('cancel').disabled = false;
        error('own-err', t('failed'));
      }
    });
    return;
  }
  loadNight();

  // ---- players and spectators
  const count = { players: 1, watchers: 0 };
  for (const b of document.querySelectorAll('[data-step]')) {
    b.addEventListener('click', () => {
      const k = b.dataset.step;
      count[k] = Math.max(0, Math.min(MAX, count[k] + Number(b.dataset.by)));
      $(k).textContent = String(count[k]);
      error('people-err');
    });
  }

  // ---- the street, with suggestions from the Flemish address register (through our server), as on the interest page
  const input = $('address');
  const list = $('address-list');
  let timer = 0;
  let choice = -1;
  let asked = '';
  const close = () => {
    show(list, false);
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    choice = -1;
  };
  const choose = (i) => {
    const items = [...list.children];
    if (!items[i]) return;
    input.value = items[i].textContent;
    input.classList.remove('bad');
    error('address-err');
    close();
  };
  const mark = (i) => {
    choice = i;
    [...list.children].forEach((li, k) => li.setAttribute('aria-selected', String(k === i)));
    input.setAttribute('aria-activedescendant', `addr-${i}`);
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) return close();
    timer = setTimeout(async () => {
      asked = q;
      const r = await fetch(`/api/address?q=${encodeURIComponent(q)}`).then((x) => x.json()).catch(() => ({ suggestions: [] }));
      if (asked !== q || !r.suggestions?.length) return close();
      list.replaceChildren(...r.suggestions.map((s, i) => {
        const li = el('li', '', s);
        li.setAttribute('role', 'option');
        li.id = `addr-${i}`;
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          choose(i);
        });
        return li;
      }));
      show(list);
      input.setAttribute('aria-expanded', 'true');
      choice = -1;
    }, 220);
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    const n = list.children.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); mark((choice + 1) % n); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); mark((choice - 1 + n) % n); }
    else if (e.key === 'Enter' && choice >= 0) { e.preventDefault(); choose(choice); }
    else if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', () => setTimeout(close, 120));

  // ---- checking and sending
  const validEmail = (v) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/.test(v);
  for (const k of ['last', 'first', 'email', 'address']) $(k).addEventListener('input', () => { $(k).classList.remove('bad'); error(`${k}-err`); });
  $('age').addEventListener('change', () => error('age-err'));
  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    error('send-err');
    const lastName = $('last').value.trim();
    const firstName = $('first').value.trim();
    const email = $('email').value.trim();
    const address = input.value.trim();
    const checks = [
      ['last', !!lastName, 'lastName'],
      ['first', !!firstName, 'firstName'],
      ['email', validEmail(email), 'email'],
      ['address', address.length >= 3, 'address'],
    ];
    for (const [id, ok, msg] of checks) {
      $(id).classList.toggle('bad', !ok);
      error(`${id}-err`, ok ? '' : t(msg));
    }
    const people = count.players + count.watchers > 0;
    error('people-err', people ? '' : t('people'));
    error('age-err', $('age').checked ? '' : t('age'));
    const first = checks.find(([, ok]) => !ok);
    if (first) return $(first[0]).focus();
    if (!people) return document.querySelector('[data-step="players"][data-by="1"]').focus();
    if (!$('age').checked) return $('age').focus();
    const send = $('send');
    send.disabled = true;
    send.textContent = t('sending');
    try {
      const body = { lastName, firstName, email, address, players: count.players, watchers: count.watchers, wishes: $('wishes').value.trim(), age: true, lang, website: $('website').value };
      const r = await fetch('/api/gamenight', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.status === 429) throw new Error('busy');
      if (r.status === 409) {
        // Closed while this page was open: the hall filled up.
        night.open = false;
        drawNight();
        scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      if (!r.ok) throw new Error('failed');
      const { id, token } = await r.json();
      done = { players: count.players, watchers: count.watchers };
      $('done-name').textContent = firstName;
      $('done-people').textContent = party(done.players, done.watchers);
      if (id) $('mine').value = `${location.origin}/inschrijven/#mine=${id}.${token}`;
      show($('s-form'), false);
      show($('s-done'));
      scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      error('send-err', t(err.message === 'busy' ? 'busy' : 'failed'));
      send.disabled = false;
      send.replaceChildren(...[['nl', 'Inschrijven'], ['en', 'Sign up']].map(([l, s]) => {
        const span = el('span', '', s);
        span.dataset.lang = l;
        return span;
      }));
    }
  });
  $('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('mine').value);
    } catch {
      $('mine').select();
    }
    $('copy').textContent = t('copied');
  });
})();
