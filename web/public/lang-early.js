// The tab's title and the page's language in the game's language while the start screen's script
// still loads (on a slow phone that takes a moment; the start screen itself stays hidden until
// then). The same choice as src/i18n.ts: this browser's saved choice ('briel.lang'), else the
// browser's language. The Dutch title sits in the page as data-nl; src/i18n.ts takes over once the
// script runs. A file of its own: the site's Content-Security-Policy allows no inline scripts.
(() => {
  let lang = '';
  try {
    lang = localStorage.getItem('briel.lang') || '';
  } catch {
    // storage blocked: the browser's language
  }
  if (lang !== 'en' && lang !== 'nl') lang = /^nl(-|$)/i.test(navigator.language || '') ? 'nl' : 'en';
  document.documentElement.lang = lang;
  if (lang !== 'nl') return;
  for (const el of document.querySelectorAll('title[data-nl]')) el.textContent = el.getAttribute('data-nl');
})();
