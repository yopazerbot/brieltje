/**
 * Watching (Yoshi, 11 Nov 2026: "continue building the spectator views. Allow me as admin to also project the spectator
 * view, and allow me to show a specific player or multiple players in split screen style"): the admin's watch page
 * (/admin/watch/, web/public/admin/watch/) shows up to four copies of the game, each in a frame of its own, each
 * following one player. This module says whether this page is such a frame. It imports nothing and start.ts reads it
 * first, as src/seat.ts, so its storage is in place before any other module reads a setting.
 *
 * - Which frame: read from the frame around this page (its data-tile and data-views), and only when that frame sits in
 *   our own /admin/watch/ page (the browser gives a page its frame element only when the page around it is of the same
 *   origin). Nothing about it is in the URL.
 * - The server: the connection asks to watch (/ws?watch=1). The server lets only the admin's session watch; a watcher
 *   is no player (not counted, not seen, nothing it sends is taken but its answer to the ping).
 * - Whom to follow, and how (behind them or through their eyes): told by the watch page with postMessage from our own
 *   origin, from the page around this frame only (`onWatch`).
 * - Settings: a copy of this browser's, in memory: no sound, and the graphics shared out between the views.
 */

export interface Watch {
  /** The frame, 1 to 4 */
  tile: number;
  /** How many frames the page shows (1 to 4): their views share the graphics chip */
  views: number;
}

export type WatchMode = 'behind' | 'eyes';
export interface WatchOrder {
  /** The player to follow, or '' for none yet */
  target: string;
  mode: WatchMode;
}

function detect(): Watch | null {
  let frame: Element | null = null;
  try {
    frame = window.frameElement;
  } catch {
    return null;
  }
  if (!frame || frame.tagName !== 'IFRAME') return null;
  try {
    const host = frame.ownerDocument.defaultView;
    if (!host || host.location.origin !== location.origin || !/^\/admin\/watch\/?$/.test(host.location.pathname)) return null;
  } catch {
    return null;
  }
  const d = (frame as HTMLIFrameElement).dataset;
  const tile = Number(d.tile);
  const views = Number(d.views);
  if (!Number.isInteger(views) || views < 1 || views > 4 || !Number.isInteger(tile) || tile < 1 || tile > views) return null;
  return { tile, views };
}

export const watch: Watch | null = detect();

/** Tell the watch page how this frame is doing (only our own origin can hear it). */
export function tellWatchPage(state: 'ready' | 'notAdmin' | 'ended'): void {
  if (!watch) return;
  try {
    window.parent.postMessage({ briel: 'watched', tile: watch.tile, state }, location.origin);
  } catch {
    // the page around it is gone
  }
}

/** Whom to follow: from the watch page around this frame, and only from it. */
export function onWatch(f: (order: WatchOrder) => void): void {
  if (!watch) return;
  addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.source !== window.parent) return;
    const m = e.data as { briel?: unknown; target?: unknown; mode?: unknown } | null;
    if (!m || m.briel !== 'watch') return;
    f({ target: typeof m.target === 'string' ? m.target.slice(0, 20) : '', mode: m.mode === 'eyes' ? 'eyes' : 'behind' });
  });
}

if (watch) {
  // A copy of this browser's settings, in memory: what a view changes stays in it. No sound (the room hears the game
  // from the players' own speakers); the graphics shared out between the views.
  const map = new Map<string, string>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith('briel.')) map.set(k, localStorage.getItem(k) ?? '');
    }
  } catch {
    // storage blocked: the defaults
  }
  map.delete('briel.logoutPending');
  map.delete('briel.startMode');
  map.set('briel.sound', 'off');
  map.set('briel.playMode', 'explore'); // no gun of its own, no weapon picker
  if (watch.views > 1) map.set('briel.graphics', 'auto');
  const mem: Storage = {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(String(k)) ?? null,
    setItem: (k: string, v: string) => void map.set(String(k), String(v)),
    removeItem: (k: string) => void map.delete(String(k)),
    clear: () => map.clear(),
  };
  try {
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => mem });
  } catch {
    // can't be replaced: the normal game's settings
  }
}
