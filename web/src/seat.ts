/**
 * Split screen (/splitscreen, src/splitscreen/page.ts): up to four copies of the game on one page,
 * each in a frame of its own with a seat (1 to 4) and a controller. This module says whether this
 * page is such a seat, and what follows from that. It imports nothing and is the first thing
 * start.ts reads, so its storage (below) is in place before any other module reads a setting.
 *
 * - Which seat: read from the frame around this page (its data-seat, data-pad and data-views), and
 *   only when that frame sits in our own /splitscreen page. The browser gives a page its frame only
 *   when the page around it is of the same origin (frameElement is null otherwise), so no other
 *   site can make a seat, and nothing about the seat is in the URL. Known at once, before the first
 *   call to the server.
 * - The server: every call says which seat it speaks for (the X-Briel-Seat header, `seatHeaders`)
 *   and the WebSocket in its subprotocol (`seatProtocols`), so each seat is answered from its own
 *   session cookie (server/auth.mjs seatOf). The seat's session is set by the split-screen page's
 *   join; the PIN never reaches this frame.
 * - The controller: the seat's own, by its index (`gamepads`, read from the page around it, which has
 *   the focus as a whole); the keyboard and mouse only for seat 1, when it was given them.
 * - Settings: a copy of this browser's, in memory. What a seat changes (the sound off in seats 2 to
 *   4, the graphics, a tab) never changes the normal game's settings, nor another seat's.
 * - It tells the split-screen page how it is doing (`tellHost`), by postMessage to our own origin.
 */

export interface Seat {
  /** The seat, 1 to 4 */
  n: number;
  /** The controller's index in the Gamepad API (0 to 7), or -1 for keyboard and mouse (seat 1 only) */
  pad: number;
  /** How many seats the page shows (2 to 4): their views share the graphics chip */
  views: number;
}

function detect(): Seat | null {
  let frame: Element | null = null;
  try {
    frame = window.frameElement; // null at the top, and in a frame of another origin
  } catch {
    return null;
  }
  if (!frame || frame.tagName !== 'IFRAME') return null;
  try {
    const host = frame.ownerDocument.defaultView;
    if (!host || host.location.origin !== location.origin || !/^\/splitscreen\/?$/.test(host.location.pathname)) return null;
  } catch {
    return null;
  }
  const d = (frame as HTMLIFrameElement).dataset;
  const n = Number(d.seat);
  const views = Number(d.views);
  const pad = d.pad === 'kbm' ? -1 : Number(d.pad);
  if (!Number.isInteger(n) || !Number.isInteger(views) || views < 2 || views > 4 || n < 1 || n > views) return null;
  if (pad === -1 ? n !== 1 : !Number.isInteger(pad) || pad < 0 || pad > 7) return null;
  return { n, pad, views };
}

export const seat: Seat | null = detect();

/** Headers for every call to our server: the seat it speaks for (none outside the split screen). */
export const seatHeaders: Record<string, string> = seat ? { 'X-Briel-Seat': String(seat.n) } : {};

/** The WebSocket's subprotocol: the seat, the only header a page can give a WebSocket. */
export const seatProtocols: string[] | undefined = seat ? [`briel-seat-${seat.n}`] : undefined;

/**
 * The controllers. A seat reads them from the split-screen page around it: that page has the
 * browser's focus whichever frame was clicked last, and it sees every controller's first press.
 */
export function gamepads(): readonly (Gamepad | null)[] {
  if (seat) {
    try {
      const nav = window.parent.navigator;
      if (nav.getGamepads) return nav.getGamepads();
    } catch {
      // not reachable after all: this frame's own
    }
  }
  return navigator.getGamepads ? navigator.getGamepads() : [];
}

/** Tell the split-screen page how this seat is doing (only our own origin can hear it). */
export function tellHost(state: 'ready' | 'playing' | 'alone' | 'ended'): void {
  if (!seat) return;
  try {
    window.parent.postMessage({ briel: 'seat', n: seat.n, state }, location.origin);
  } catch {
    // the page around it is gone
  }
}

/** A Storage that lives in memory, starting as a copy of `seed`. */
function memoryStorage(seed: [string, string][]): Storage {
  const map = new Map(seed);
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(String(k)) ?? null,
    setItem: (k: string, v: string) => void map.set(String(k), String(v)),
    removeItem: (k: string) => void map.delete(String(k)),
    clear: () => map.clear(),
  };
}

if (seat) {
  const seed: [string, string][] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith('briel.')) seed.push([k, localStorage.getItem(k) ?? '']);
    }
  } catch {
    // storage blocked: the defaults
  }
  const mem = memoryStorage(seed);
  // A logout the normal game still owes is the normal game's to send, not this seat's.
  mem.removeItem('briel.logoutPending');
  // One sound for the room: seat 1's. The graphics: Auto, sharing the chip between the views (graphics.ts).
  mem.setItem('briel.sound', seat.n === 1 && mem.getItem('briel.sound') !== 'off' ? 'on' : 'off');
  mem.setItem('briel.graphics', 'auto');
  try {
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => mem });
  } catch {
    // can't be replaced: the seat shares the normal game's settings
  }
}
