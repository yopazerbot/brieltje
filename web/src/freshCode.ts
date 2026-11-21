// A lazy part of the game that did not arrive: the page loads again, once.
//
// The game's code comes in parts (the houses round the church square, the countryside, the villagers, the music...),
// each fetched when it is first needed, each with its content's hash in its name. After a new version went live, a
// page that was already open, or one that was loading at that moment, asks for parts the server no longer has. Each
// part that fails is caught where it is asked for and the game goes on without it: no café at the church, plain
// blocks for the houses there, no villagers. Nobody is told. Vite reports each such failure as `vite:preloadError`:
// on the first one this page checks that the server answers, then loads again, so it gets one version's files.
//
// Not when the server cannot be reached (offline: playing on without the part is better than no page), and not
// twice within two minutes (a part that keeps failing must not make the page load for ever).

/** The fewest milliseconds between two reloads of this kind. */
export const AGAIN_MS = 120_000;

/**
 * Whether to load the page again after a part failed: only when the server answered, and not when this tab did so
 * less than AGAIN_MS ago (`last`: when, 0 or NaN for never; null when the tab's storage cannot be read, where a
 * reload could not be counted).
 */
export function shouldReload(serverAnswers: boolean, last: number | null, now: number): boolean {
  if (!serverAnswers || last === null) return false;
  return !(last > 0) || now - last >= AGAIN_MS;
}

const KEY = 'briel.freshCode';

/** Watch for parts that fail from now on (called once, by the page's first script). */
export function watchForStaleCode(): void {
  let busy = false;
  window.addEventListener('vite:preloadError', () => {
    if (busy) return;
    busy = true;
    void fetch('/', { cache: 'no-store' })
      .then((r) => r.ok, () => false)
      .then((answers) => {
        let go = false;
        try {
          go = shouldReload(answers, Number(sessionStorage.getItem(KEY) ?? 0), Date.now());
          if (go) sessionStorage.setItem(KEY, String(Date.now())); // counted before it happens
        } catch {
          go = false; // a tab whose storage cannot be read or written: a reload could not be counted
        }
        if (go) location.reload();
        else busy = false;
      });
  });
}
