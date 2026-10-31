// The slideshow of renders behind the start screen and the site's other pages: the town with its
// church and school, the house, the bungalow (tools/still/, Blender). Any element with
// data-slides becomes one; class "bg" fills the window behind the page, class "hero" is a band at
// the top. Back, pause and next buttons and a dot per slide go into the element, or into
// [data-slides-controls] when the page has one (a footer, so they never cover the page on a phone).
// A slide shows for 7 seconds and fades into the next. It doesn't change by itself while the page is
// hidden, while the slideshow isn't shown (the game has started), or for people who asked their
// system for less motion; the buttons always work. Captions follow the page's language
// (<html lang>, also when it changes).
(() => {
  const SLIDES = [
    { src: '/start/town', focus: '72% 50%', nl: 'Smetlede: de kerk en de school', en: 'Smetlede: the church and the school' },
    { src: '/start/house', focus: '58% 45%', nl: 'Het nieuwe huis', en: 'The new house' },
    { src: '/start/bungalow', focus: '66% 50%', nl: 'De bungalow', en: 'The bungalow' },
  ];
  const WORDS = {
    nl: { prev: 'Vorige', next: 'Volgende', pause: 'Pauzeren', play: 'Afspelen', go: 'Naar beeld {n}: {c}', label: 'Beelden uit het spel' },
    en: { prev: 'Previous', next: 'Next', pause: 'Pause', play: 'Play', go: 'Go to picture {n}: {c}', label: 'Pictures from the game' },
  };
  const SHOW_MS = 7000;
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  const lang = () => (document.documentElement.lang === 'en' ? 'en' : 'nl');
  const el = (tag, cls) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  };

  for (const root of document.querySelectorAll('[data-slides]')) {
    const figures = SLIDES.map((s, i) => {
      const fig = el('figure', 'slide');
      const img = el('img');
      img.alt = '';
      img.decoding = 'async';
      img.sizes = '100vw';
      img.style.objectPosition = s.focus;
      // The first picture straight away, the others once it's there (they fade in later anyway).
      const set = `${s.src}-1280.webp 1280w, ${s.src}-2560.webp 2560w`;
      if (i === 0) {
        img.srcset = set;
        img.src = `${s.src}-1280.webp`;
      } else {
        img.dataset.srcset = set;
      }
      fig.append(img);
      root.append(fig);
      return fig;
    });
    const bar = el('div', 'slides-bar');
    const caption = el('span', 'slides-caption');
    caption.setAttribute('aria-live', 'polite');
    const prev = el('button', 'slides-btn');
    const pause = el('button', 'slides-btn');
    const next = el('button', 'slides-btn');
    for (const b of [prev, pause, next]) b.type = 'button';
    prev.textContent = '‹';
    next.textContent = '›';
    const dots = SLIDES.map((_, i) => {
      const d = el('button', 'slides-dot');
      d.type = 'button';
      d.addEventListener('click', () => show(i, true));
      return d;
    });
    const dotBox = el('span', 'slides-dots');
    dotBox.append(...dots);
    bar.append(prev, pause, next, dotBox, caption);
    (document.querySelector('[data-slides-controls]') || root).append(bar);
    root.setAttribute('role', 'region');
    root.setAttribute('aria-roledescription', 'carousel');

    let at = 0;
    let paused = still.matches;
    let timer = 0;
    const words = () => WORDS[lang()];
    function label() {
      const w = words();
      root.setAttribute('aria-label', w.label);
      prev.setAttribute('aria-label', w.prev);
      prev.title = w.prev;
      next.setAttribute('aria-label', w.next);
      next.title = w.next;
      pause.setAttribute('aria-label', paused ? w.play : w.pause);
      pause.title = paused ? w.play : w.pause;
      pause.textContent = paused ? '▶' : '❚❚';
      pause.setAttribute('aria-pressed', String(paused));
      dots.forEach((d, i) => d.setAttribute('aria-label', w.go.replace('{n}', i + 1).replace('{c}', SLIDES[i][lang()])));
      caption.textContent = SLIDES[at][lang()];
    }
    /** Load a picture before it's needed, so it never fades in half drawn. */
    function load(i) {
      const img = figures[i].firstChild;
      if (img.dataset.srcset) {
        img.srcset = img.dataset.srcset;
        delete img.dataset.srcset;
      }
    }
    function show(i, byHand = false) {
      at = (i + SLIDES.length) % SLIDES.length;
      load(at);
      if (figures[at].firstChild.complete) load((at + 1) % SLIDES.length); // else once it has (below)
      figures.forEach((f, k) => f.classList.toggle('on', k === at));
      dots.forEach((d, k) => d.setAttribute('aria-current', String(k === at)));
      label();
      if (byHand) schedule();
    }
    function schedule() {
      clearTimeout(timer);
      if (paused) return;
      timer = setTimeout(() => {
        // Only on screen and in view: the game behind the start screen needs the computer more.
        if (!document.hidden && root.getClientRects().length) show(at + 1); // getClientRects: also right for a fixed background
        schedule();
      }, SHOW_MS);
    }
    prev.addEventListener('click', () => show(at - 1, true));
    next.addEventListener('click', () => show(at + 1, true));
    pause.addEventListener('click', () => {
      paused = !paused;
      root.classList.toggle('paused', paused);
      label();
      schedule();
    });
    root.classList.toggle('paused', paused);
    new MutationObserver(label).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    figures[0].firstChild.addEventListener('load', () => load(1), { once: true });
    show(0);
    schedule();
  }
})();
