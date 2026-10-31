// The interest page (server/interest.mjs answers it): a welcome, then two steps (about you and
// when; your own house in the game, with plans and consent), then a thank-you with a private link
// to look at or withdraw the sign-up later. That link carries its secret after the # so it never
// reaches a server log; the page sends it in a header. Dutch or English, as the game.
(() => {
  const $ = (id) => document.getElementById(id);
  const MAX_FILES = 10;
  const MAX_FILE = 25 * 1024 * 1024;
  const OK = /\.(pdf|jpe?g|png|heic|heif|webp|tiff?)$/i;
  const T = {
    nl: {
      name: 'Vul je naam in.', email: 'Vul een geldig e-mailadres in.', age: 'Vink aan dat je 13 jaar of ouder bent, of laat een ouder je inschrijven.', consent: 'Vink de vier vakjes aan om je plannen te sturen, of kies "Nee, bedankt".',
      noFiles: 'Kies minstens één plan, of kies "Nee, bedankt".', tooMany: 'Hoogstens 10 bestanden.', tooBig: 'is groter dan 25 MB.', badType: 'is geen PDF of afbeelding (JPG, PNG, HEIC, TIFF).',
      busy: 'Even te veel inschrijvingen. Probeer het over een paar minuten opnieuw.', failed: 'Dat lukte niet. Controleer je verbinding en probeer opnieuw.', type: 'Dat bestand herkennen we niet als plan (PDF of afbeelding: JPG, PNG, HEIC, TIFF).',
      sending: 'Bezig…', uploading: 'Plannen uploaden…', copied: 'Gekopieerd', gone: 'Deze inschrijving bestaat niet (meer).', withdrawn: 'Je inschrijving en je plannen zijn verwijderd.',
      sure: 'Zeker? Klik nog eens om in te trekken', name_: 'Naam', email_: 'E-mail', address_: 'Straat', when_: 'Wanneer', party_: 'Met hoeveel', comments_: 'Opmerkingen', house_: 'Huis in het spel', plans_: 'Plannen',
      when: { weekday: "weekdag 's avonds", saturday: 'zaterdag', sunday: 'zondag' }, yes: 'ja', no: 'nee',
      updates_: 'E-mail als het gepland is', updatesOn: 'Ja, we mailen je de datum en de plaats', updatesOff: 'Nee', updatesStop: 'Stop de e-mail', updatesStart: 'Mail me toch',
      houseYes: 'Ja, met de plannen hieronder', houseNo: 'Nee', people: (n) => (n === 1 ? '1 persoon' : `${n} personen`), noPlans: 'Er kwamen geen plannen aan.', sent: 'Gestuurd op',
    },
    en: {
      name: 'Please fill in your name.', email: 'Please fill in a valid email address.', age: "Tick that you're 13 or older, or have a parent sign you up.", consent: 'Tick the four boxes to send your plans, or choose "No, thanks".',
      noFiles: 'Choose at least one plan, or choose "No, thanks".', tooMany: 'At most 10 files.', tooBig: 'is larger than 25 MB.', badType: "isn't a PDF or an image (JPG, PNG, HEIC, TIFF).",
      busy: 'Too many sign-ups right now. Please try again in a few minutes.', failed: "That didn't work. Check your connection and try again.", type: "We don't recognise that file as a plan (a PDF or an image: JPG, PNG, HEIC, TIFF).",
      sending: 'Sending…', uploading: 'Uploading plans…', copied: 'Copied', gone: "This sign-up doesn't exist (any more).", withdrawn: 'Your sign-up and your plans have been removed.',
      sure: 'Sure? Click again to withdraw', name_: 'Name', email_: 'Email', address_: 'Street', when_: 'When', party_: 'How many', comments_: 'Comments', house_: 'House in the game', plans_: 'Plans',
      when: { weekday: 'weekday evening', saturday: 'Saturday', sunday: 'Sunday' }, yes: 'yes', no: 'no',
      updates_: 'Email when planned', updatesOn: 'Yes, we email you the date and the place', updatesOff: 'No', updatesStop: 'Stop the email', updatesStart: 'Email me after all',
      houseYes: 'Yes, with the plans below', houseNo: 'No', people: (n) => (n === 1 ? '1 person' : `${n} people`), noPlans: 'No plans arrived.', sent: 'Sent on',
    },
  };
  let lang = 'nl';
  const t = (k) => T[lang][k];

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
  let ownEntry = null; // your sign-up as shown, drawn again when the language changes
  let ownId = 0;
  let ownHeaders = {};
  const setLang = (l) => {
    lang = l;
    if (ownEntry) drawOwn(ownEntry);
    document.documentElement.lang = l;
    document.title = l === 'nl' ? 'Samen spelen? · Brieltje' : 'Play together? · Brieltje';
    for (const b of document.querySelectorAll('.langs button')) b.setAttribute('aria-pressed', String(b.dataset.set === l));
  };
  for (const b of document.querySelectorAll('.langs button')) b.addEventListener('click', () => setLang(b.dataset.set));
  setLang(pick());

  const show = (el, on = true) => (el.hidden = !on);
  const error = (id, text) => {
    const el = $(id);
    el.textContent = text || '';
    show(el, !!text);
  };

  // ---- how many are interested
  const loadCount = () =>
    fetch('/api/interest/count').then((r) => r.json()).then(({ count }) => {
      if (count > 0) {
        for (const id of ['count', 'count2']) $(id).textContent = String(count);
        show($('counter'));
        show($('counter2'));
      }
    }).catch(() => {});

  /** Your sign-up as labelled rows: chips for the days, a file list for the plans. */
  function drawOwn(e) {
    const el = (tag, cls, text) => {
      const x = document.createElement(tag);
      if (cls) x.className = cls;
      if (text !== undefined) x.textContent = text;
      return x;
    };
    const list = el('div', 'own');
    const row = (k, ...value) => {
      const r = el('div', 'own-row');
      const v = el('div', 'own-v');
      v.append(...value);
      r.append(el('div', 'own-k', k), v);
      list.append(r);
    };
    const chips = (items) => {
      const box = el('div', 'tags');
      for (const s of items) box.append(el('span', 'tag', s));
      return box;
    };
    row(t('name_'), e.name);
    row(t('email_'), e.email);
    if (e.address) row(t('address_'), e.address);
    if (e.when.length) row(t('when_'), chips(e.when.map((w) => t('when')[w] || w)));
    row(t('party_'), t('people')(e.party));
    if (e.comments) row(t('comments_'), el('div', 'own-text', e.comments));
    // The email once the meetup is planned: switched here as easily as it was ticked.
    const toggle = el('button', 'linkbtn', e.updates ? t('updatesStop') : t('updatesStart'));
    toggle.type = 'button';
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      const r = await fetch(`/api/interest/${ownId}`, { method: 'PATCH', headers: { ...ownHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ updates: !e.updates }) }).catch(() => null);
      if (r?.ok) {
        e.updates = !e.updates;
        drawOwn(e);
      } else {
        toggle.disabled = false;
        error('own-err', t('failed'));
      }
    });
    row(t('updates_'), el('span', '', e.updates ? t('updatesOn') : t('updatesOff')), ' ', toggle);
    row(t('house_'), e.house ? t('houseYes') : t('houseNo'));
    if (e.house) {
      const files = el('ul', 'files own-files');
      for (const f of e.files) {
        const li = el('li');
        li.append(el('span', 'fname', f.name), el('span', 'muted', `${(f.size / 1048576).toFixed(1)} MB`));
        files.append(li);
      }
      row(t('plans_'), e.files.length ? files : el('span', 'muted', t('noPlans')));
    }
    if (e.at) row(t('sent'), new Date(e.at).toLocaleString(lang === 'nl' ? 'nl-BE' : 'en-GB', { dateStyle: 'long', timeStyle: 'short' }));
    $('own-body').replaceChildren(list);
  }

  // ---- your own sign-up, from the link (#mine=id.secret)
  const mine = /^#mine=(\d+)\.([\w-]{20,64})$/.exec(location.hash);
  if (mine) {
    show($('s-intro'), false);
    show($('s-own'));
    const [, id, token] = mine;
    const headers = { 'X-Interest-Token': token };
    ownId = +id;
    ownHeaders = headers;
    fetch(`/api/interest/${id}`, { headers }).then(async (r) => {
      if (!r.ok) throw new Error('gone');
      ownEntry = await r.json();
      drawOwn(ownEntry);
    }).catch(() => {
      error('own-err', t('gone'));
      show($('own-withdraw'), false);
    });
    let armed = false;
    $('withdraw').addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        $('withdraw').textContent = t('sure');
        return;
      }
      $('withdraw').disabled = true;
      const r = await fetch(`/api/interest/${id}`, { method: 'DELETE', headers }).catch(() => null);
      if (r?.ok) {
        ownEntry = null;
        error('own-err');
        const p = document.createElement('p');
        p.className = 'note';
        p.textContent = t('withdrawn');
        $('own-body').replaceChildren(p);
        show($('own-withdraw'), false);
        history.replaceState(null, '', location.pathname);
      } else {
        $('withdraw').disabled = false;
        error('own-err', t('failed'));
      }
    });
    return;
  }
  loadCount();

  // ---- the steps
  $('go').addEventListener('click', () => {
    show($('s-intro'), false);
    show($('form'));
    $('name').focus();
  });
  const validEmail = (v) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/.test(v);
  $('next').addEventListener('click', () => {
    const name = $('name').value.trim();
    const email = $('email').value.trim();
    $('name').classList.toggle('bad', !name);
    $('email').classList.toggle('bad', !validEmail(email));
    error('name-err', name ? '' : t('name'));
    error('email-err', validEmail(email) ? '' : t('email'));
    if (!name) return $('name').focus();
    if (!validEmail(email)) return $('email').focus();
    error('age-err', $('age').checked ? '' : t('age'));
    if (!$('age').checked) return $('age').focus();
    show($('s-1'), false);
    show($('s-2'));
    $('step2bar').classList.add('on');
    scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('back').addEventListener('click', () => {
    show($('s-2'), false);
    show($('s-1'));
    $('step2bar').classList.remove('on');
  });
  for (const k of ['name', 'email']) $(k).addEventListener('input', () => { $(k).classList.remove('bad'); error(`${k}-err`); });

  // ---- how many people
  let party = 1;
  const setParty = (n) => ($('party').textContent = String((party = Math.max(1, Math.min(10, n)))));
  $('less').addEventListener('click', () => setParty(party - 1));
  $('more').addEventListener('click', () => setParty(party + 1));

  // ---- the street, with suggestions from the Flemish address register (through our server)
  const input = $('address');
  const list = $('address-list');
  let timer = 0;
  let choice = -1;
  let asked = '';
  const close = () => {
    show(list, false);
    input.setAttribute('aria-expanded', 'false');
    choice = -1;
  };
  const choose = (i) => {
    const items = [...list.children];
    if (!items[i]) return;
    input.value = items[i].textContent;
    close();
  };
  const mark = (i) => {
    choice = i;
    [...list.children].forEach((li, k) => li.setAttribute('aria-selected', String(k === i)));
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
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.id = `addr-${i}`;
        li.textContent = s;
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

  // ---- your house: yes or no, the plans, the consent
  let house = false;
  const setHouse = (on) => {
    house = on;
    $('house-yes').setAttribute('aria-pressed', String(on));
    $('house-no').setAttribute('aria-pressed', String(!on));
    show($('house'), on);
    if (!on) { error('consent-err'); error('file-err'); }
  };
  $('house-yes').addEventListener('click', () => setHouse(true));
  $('house-no').addEventListener('click', () => setHouse(false));

  const files = [];
  const drawFiles = () => {
    $('file-list').replaceChildren(...files.map((f, i) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = f.file.name;
      const size = document.createElement('span');
      size.className = 'muted';
      size.textContent = `${(f.file.size / 1048576).toFixed(1)} MB`;
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '✕';
      x.setAttribute('aria-label', 'remove');
      x.addEventListener('click', () => { files.splice(i, 1); drawFiles(); });
      li.append(name, size, x);
      if (f.bar) li.append(f.bar);
      return li;
    }));
  };
  const add = (picked) => {
    error('file-err');
    for (const file of picked) {
      if (files.length >= MAX_FILES) { error('file-err', t('tooMany')); break; }
      if (!OK.test(file.name) && !/^(image\/|application\/pdf)/.test(file.type)) { error('file-err', `${file.name} ${t('badType')}`); continue; }
      if (file.size > MAX_FILE) { error('file-err', `${file.name} ${t('tooBig')}`); continue; }
      files.push({ file });
    }
    drawFiles();
  };
  const drop = $('drop');
  drop.addEventListener('click', () => $('files').click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('files').click(); } });
  $('files').addEventListener('change', () => { add($('files').files); $('files').value = ''; });
  for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  drop.addEventListener('drop', (e) => add(e.dataTransfer?.files ?? []));

  // ---- sending: the sign-up, then each plan with its progress
  const upload = (id, token, f) =>
    new Promise((resolve, reject) => {
      const bar = document.createElement('progress');
      bar.max = 1;
      bar.value = 0;
      f.bar = bar;
      drawFiles();
      const x = new XMLHttpRequest();
      x.open('PUT', `/api/interest/${id}/plans`);
      x.setRequestHeader('Content-Type', 'application/octet-stream');
      x.setRequestHeader('X-Interest-Token', token);
      x.setRequestHeader('X-File-Name', encodeURIComponent(f.file.name));
      x.upload.onprogress = (e) => { if (e.lengthComputable) bar.value = e.loaded / e.total; };
      x.onload = () => (x.status === 200 ? resolve() : reject(new Error(x.status === 415 ? 'type' : 'failed')));
      x.onerror = () => reject(new Error('failed'));
      x.send(f.file);
    });

  let signed = null; // after the sign-up went through: a retry only sends the plans still missing
  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    error('send-err');
    if (house) {
      const all = ['c-own', 'c-model', 'c-private', 'c-ai'].every((k) => $(k).checked);
      error('consent-err', all ? '' : t('consent'));
      error('file-err', files.length ? '' : t('noFiles'));
      if (!all || !files.length) return;
    }
    const send = $('send');
    send.disabled = true;
    send.textContent = t('sending');
    try {
      const body = {
        name: $('name').value.trim(),
        email: $('email').value.trim(),
        address: input.value.trim(),
        when: [...document.querySelectorAll('input[name=when]:checked')].map((c) => c.value),
        party,
        comments: $('comments').value.trim(),
        updates: $('updates').checked,
        age: $('age').checked,
        house,
        consent: house ? { own: $('c-own').checked, model: $('c-model').checked, private: $('c-private').checked, ai: $('c-ai').checked } : null,
        lang,
        website: $('website').value,
      };
      if (!signed) {
        const r = await fetch('/api/interest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (r.status === 429) throw new Error('busy');
        if (!r.ok) throw new Error('failed');
        signed = await r.json();
      }
      const { id, token } = signed;
      if (house && id) {
        send.textContent = t('uploading');
        for (const f of files) {
          if (f.done) continue;
          await upload(id, token, f);
          f.done = true;
        }
      }
      $('done-name').textContent = body.name;
      show($('done-house'), house);
      if (id) $('mine').value = `${location.origin}/interested/#mine=${id}.${token}`;
      show($('form'), false);
      show($('s-done'));
      scrollTo({ top: 0, behavior: 'smooth' });
      loadCount();
    } catch (err) {
      error('send-err', t(err.message === 'busy' ? 'busy' : err.message === 'type' ? 'type' : 'failed'));
      send.disabled = false;
      send.replaceChildren(...[['nl', 'Verstuur'], ['en', 'Send']].map(([l, s]) => {
        const span = document.createElement('span');
        span.dataset.lang = l;
        span.textContent = s;
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
