// The legal pages in English or Dutch: ?lang=nl or ?lang=en, else the game's chosen language,
// else the browser's. The buttons switch without a reload. (A file of its own: the site's
// Content-Security-Policy allows no inline scripts.)
(() => {
  const pick = () => {
    const asked = new URLSearchParams(location.search).get('lang');
    if (asked === 'nl' || asked === 'en') return asked;
    try {
      const saved = localStorage.getItem('briel.lang');
      if (saved === 'nl' || saved === 'en') return saved;
    } catch {
      // storage blocked: the browser's language
    }
    return /^nl\b/i.test(navigator.language || '') ? 'nl' : 'en';
  };
  const set = (lang) => {
    document.documentElement.lang = lang;
    for (const b of document.querySelectorAll('.langs button')) b.setAttribute('aria-pressed', String(b.dataset.set === lang));
    const t = document.querySelector(`title[data-${lang}]`) || document.querySelector('title');
    if (t && t.dataset[lang]) document.title = t.dataset[lang];
    for (const s of document.querySelectorAll('footer [data-en]')) s.textContent = s.dataset[lang];
    for (const a of document.querySelectorAll('nav a')) {
      const u = new URL(a.href);
      u.searchParams.set('lang', lang);
      a.href = u.pathname + u.search;
      const label = a.dataset[lang];
      if (label) a.textContent = label;
    }
  };
  for (const b of document.querySelectorAll('.langs button')) b.addEventListener('click', () => set(b.dataset.set));
  set(pick());
  // The registered office comes from the server (COMPANY_ADDRESS), so it isn't in the public source;
  // without it the pages say the town.
  fetch('/api/company').then((r) => r.json()).then(({ address }) => {
    if (address) for (const s of document.querySelectorAll('[data-company-address]')) s.textContent = address;
  }).catch(() => {});
})();
