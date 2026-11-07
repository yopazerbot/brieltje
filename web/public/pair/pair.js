// The pair page (brieltje.be/pair, server/pairing.mjs): a phone logs in a console. The code comes from the QR
// code's link (#ABCD-EFGH) or is typed; the phone logs in to its account if it isn't yet, then says yes or no.
// The code leaves the address bar at once (it isn't kept in the history). Every text goes in as text.
(() => {
  const $ = (id) => document.getElementById(id);
  let lang = 'nl';
  let code = '';
  let me = null;
  const ERRORS = {
    wrongLogin: { nl: 'Verkeerde naam of verkeerd wachtwoord.', en: 'Wrong name or password.' },
    tooMany: { nl: 'Te veel pogingen. Probeer het over 15 minuten opnieuw.', en: 'Too many tries. Try again in 15 minutes.' },
    tooManyName: { nl: 'Te veel verkeerde wachtwoorden voor deze naam. Probeer het over 15 minuten opnieuw.', en: 'Too many wrong passwords for this name. Try again in 15 minutes.' },
    pairCode: { nl: 'Die code is niet (meer) geldig. Maak een nieuwe op het andere scherm.', en: "That code isn't valid (any more). Make a new one on the other screen." },
    pairAccount: { nl: 'Log eerst in met je account.', en: 'Log in with your account first.' },
    accountOff: { nl: 'De beheerder heeft dit account uitgezet.', en: 'The admin has turned this account off.' },
    removed: { nl: 'Je bent verwijderd door de beheerder. Probeer het later opnieuw.', en: 'You were removed by the admin. Try again later.' },
    busy: { nl: 'De server is druk bezig. Probeer het zo meteen opnieuw.', en: 'The server is busy. Try again in a moment.' },
    other: { nl: 'Dat lukte niet. Probeer het opnieuw.', en: "That didn't work. Try again." },
  };
  const err = (key) => {
    const e = $('err');
    e.textContent = key ? (ERRORS[key] ?? ERRORS.other)[lang] : '';
    e.hidden = !key;
    e.dataset.key = key || '';
  };
  const show = (id) => {
    for (const s of ['s-code', 's-login', 's-ask', 's-done', 's-no']) $(s).hidden = s !== id;
  };
  const post = async (url, data) => {
    const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    return { ok: !!r?.ok, d };
  };
  const shown = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;
  const clean = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

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
  const setLang = (l) => {
    lang = l;
    document.documentElement.lang = l;
    document.title = l === 'nl' ? 'Inloggen op een ander scherm · Brieltje' : 'Log in on another screen · Brieltje';
    for (const b of document.querySelectorAll('.langs button')) b.setAttribute('aria-pressed', String(b.dataset.set === l));
    if ($('err').dataset.key) err($('err').dataset.key);
  };
  for (const b of document.querySelectorAll('.langs button')) b.addEventListener('click', () => setLang(b.dataset.set));
  setLang(pick());

  /** Where to go next: the code first, then an account, then the question. */
  async function next() {
    if (code.length !== 8) {
      show('s-code');
      $('code').focus();
      return;
    }
    if (me?.role !== 'player') {
      show('s-login');
      $('user').focus();
      return;
    }
    $('who').textContent = me.username;
    $('shown-code').textContent = shown(code);
    show('s-ask');
  }

  $('code-form').addEventListener('submit', (e) => {
    e.preventDefault();
    code = clean($('code').value);
    err(code.length === 8 ? '' : 'pairCode');
    if (code.length === 8) void next();
  });
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { ok, d } = await post('/api/account/login', { username: $('user').value.trim(), password: $('pass').value });
    $('pass').value = '';
    if (!ok) return err(d.code || 'other');
    err('');
    me = { username: d.username, role: d.role };
    void next();
  });
  $('yes').addEventListener('click', async () => {
    $('yes').disabled = true;
    const { ok, d } = await post('/api/pair/approve', { code });
    $('yes').disabled = false;
    if (!ok) {
      err(d.code || 'other');
      if (d.code === 'pairCode') {
        code = '';
        $('code').value = '';
        show('s-code');
      }
      return;
    }
    err('');
    $('done-who').textContent = d.username;
    code = '';
    show('s-done');
  });
  $('no').addEventListener('click', () => {
    code = '';
    err('');
    show('s-no');
  });
  $('other').addEventListener('click', () => {
    me = null;
    err('');
    show('s-login');
    $('user').value = '';
    $('user').focus();
  });

  // The code from the link, out of the address bar (and the history) at once.
  code = clean(decodeURIComponent(location.hash.slice(1)));
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  fetch('/api/me', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((d) => {
      me = d && d.role ? d : null;
      void next();
    });
})();
