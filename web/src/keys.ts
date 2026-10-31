/**
 * The letters printed on the player's keys. The game reads keys by their place on the keyboard
 * (e.code), so W A S D walk on any keyboard, but on an AZERTY keyboard (most of Belgium) those keys
 * say Z Q S D, and the Q for the last weapon says A. The hints name the key as it is printed.
 *
 * Which keyboard: the browser's own layout map where it has one (Chrome and Edge), else a setting
 * (Automatic, AZERTY or QWERTY, remembered in this browser); Automatic without the map takes AZERTY
 * for French and Belgian Dutch browsers. E, R, G, F, N, P, T, X and C sit in the same place on both.
 * The big map's M is read by its letter (e.key), so its hint is always M.
 */

export type Layout = 'auto' | 'azerty' | 'qwerty';

const STORE = 'briel.keyboard';
/** The keys whose label differs on AZERTY. */
const AZERTY: Record<string, string> = { KeyW: 'Z', KeyA: 'Q', KeyQ: 'A', KeyZ: 'W', KeyM: ',', Semicolon: 'M' };
const listeners = new Set<() => void>();

function load(): Layout {
  try {
    const saved = localStorage.getItem(STORE);
    if (saved === 'azerty' || saved === 'qwerty') return saved;
  } catch {
    // storage blocked: automatic
  }
  return 'auto';
}

let choice: Layout = load();
/** The browser's layout map (code to the key's character), once it has answered. */
let detected: Map<string, string> | null = null;

/** Automatic, AZERTY or QWERTY: the setting. */
export function layout(): Layout {
  return choice;
}

/** The layout the hints follow now: the setting, or for Automatic what the browser says or suggests. */
export function activeLayout(): 'azerty' | 'qwerty' {
  if (choice !== 'auto') return choice;
  if (detected?.get('KeyQ') === 'a' || detected?.get('KeyW') === 'z') return 'azerty';
  if (detected) return 'qwerty';
  return /^fr(-|$)|^nl-BE$/i.test(navigator.language || '') ? 'azerty' : 'qwerty';
}

/** The label on the key at `code` (KeyW, KeyQ ...), as the player's keyboard prints it. */
export function keyName(code: string): string {
  const printed = choice === 'auto' ? detected?.get(code) : undefined;
  if (printed && /^\S$/.test(printed)) return printed.toUpperCase();
  if (activeLayout() === 'azerty' && AZERTY[code]) return AZERTY[code];
  return code.replace(/^Key/, '');
}

/** The four keys for walking, "W A S D" or "Z Q S D". */
export function moveKeys(): string {
  return ['KeyW', 'KeyA', 'KeyS', 'KeyD'].map(keyName).join(' ');
}

/** Call `fn` when the labels change (a new setting, or the browser's layout map arrived). */
export function onKeys(fn: () => void): void {
  listeners.add(fn);
}

export function setLayout(next: Layout): void {
  choice = next;
  try {
    if (next === 'auto') localStorage.removeItem(STORE);
    else localStorage.setItem(STORE, next);
  } catch {
    // private window: for this visit
  }
  for (const fn of listeners) fn();
}

// Ask the browser for its layout once (Chrome and Edge; elsewhere the setting decides).
type LayoutMapNavigator = Navigator & { keyboard?: { getLayoutMap?: () => Promise<Iterable<[string, string]>> } };
void (navigator as LayoutMapNavigator).keyboard?.getLayoutMap?.()
  .then((map) => {
    detected = new Map(map);
    for (const fn of listeners) fn();
  })
  .catch(() => {
    // not allowed here (an iframe, an insecure page): the setting decides
  });
