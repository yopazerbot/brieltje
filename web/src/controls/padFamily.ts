/**
 * Which kind of controller is connected, and what its buttons are called. The browser's "standard"
 * layout numbers the buttons by their place (button 0 is the lowest face button), so the game reads
 * every controller the same way, but the lowest button says ✕ on a PlayStation controller, A on an
 * Xbox one and B on a Nintendo one. The hints and the Controls tab ask this module for the names.
 *
 * The kind comes from the controller's name in the browser (Gamepad.id) and, where the browser adds
 * it, the maker's number (Chrome: "Vendor: 054c"; Firefox: "054c-0ce6-..."): Sony is PlayStation,
 * Nintendo is Nintendo, the rest (Xbox, XInput, 8BitDo in X-input mode, most other pads) is Xbox.
 * A setting (Automatic, PlayStation, Xbox or Nintendo, remembered in this browser) puts the names
 * right for a pad that passes itself off as another, such as an 8BitDo over Bluetooth in Switch mode.
 *
 * Only a PlayStation controller has the touchpad (button 17): the others open the map with a short
 * press on View or − (button 8, Create on PlayStation) and show the scores while it's held.
 */
import { t } from '../i18n';

export type PadFamily = 'ps' | 'xbox' | 'nintendo';
export type PadLabels = 'auto' | PadFamily;
/** A button by its place in the standard layout. */
export type PadButton = 'south' | 'east' | 'west' | 'north' | 'l1' | 'r1' | 'l2' | 'r2' | 'l3' | 'r3' | 'select' | 'start';

const NAMES: Record<PadFamily, Record<PadButton, string>> = {
  ps: { south: '✕', east: '○', west: '□', north: '△', l1: 'L1', r1: 'R1', l2: 'L2', r2: 'R2', l3: 'L3', r3: 'R3', select: 'Create', start: 'Options' },
  xbox: { south: 'A', east: 'B', west: 'X', north: 'Y', l1: 'LB', r1: 'RB', l2: 'LT', r2: 'RT', l3: 'LS', r3: 'RS', select: 'View', start: 'Menu' },
  nintendo: { south: 'B', east: 'A', west: 'Y', north: 'X', l1: 'L', r1: 'R', l2: 'ZL', r2: 'ZR', l3: 'LS', r3: 'RS', select: '−', start: '+' },
};

const STORE = 'briel.padLabels';
const listeners = new Set<() => void>();

function load(): PadLabels {
  try {
    const saved = localStorage.getItem(STORE);
    if (saved === 'ps' || saved === 'xbox' || saved === 'nintendo') return saved;
  } catch {
    // storage blocked: automatic
  }
  return 'auto';
}

let choice: PadLabels = load();
/** The controller seen last: its id, its kind, and whether it has a touchpad (button 17). */
let seen: { id: string; family: PadFamily; touchpad: boolean; standard: boolean } | null = null;

/** The kind of controller, from its name in the browser. */
export function familyOf(id: string): PadFamily {
  const s = id.toLowerCase();
  const vendor = /vendor:\s*([0-9a-f]{4})/.exec(s)?.[1] ?? /^([0-9a-f]{1,4})-[0-9a-f]{1,4}-/.exec(s)?.[1]?.padStart(4, '0');
  if (vendor === '045e' || /xinput|xbox/.test(s)) return 'xbox';
  if (vendor === '054c' || /dualsense|dualshock|playstation|\bps[345]\b/.test(s)) return 'ps';
  if (vendor === '057e' || /nintendo|pro controller|joy-con|switch/.test(s)) return 'nintendo';
  return 'xbox';
}

/** The controller in use this frame (src/controls/input.ts): a new one tells the listeners. */
export function notePad(pad: Gamepad | null): void {
  if (!pad || pad.id === seen?.id) return;
  const family = familyOf(pad.id);
  seen = { id: pad.id, family, touchpad: family === 'ps' && pad.buttons.length > 17, standard: pad.mapping === 'standard' };
  for (const fn of listeners) fn();
}

/** The kind of the controller seen last (Xbox before any). */
export function padFamily(): PadFamily {
  return seen?.family ?? 'xbox';
}

/** The kind whose button names the hints use: the setting, or the controller's own. */
export function labelFamily(): PadFamily {
  return choice === 'auto' ? padFamily() : choice;
}

/** The setting: Automatic or a kind. */
export function padLabels(): PadLabels {
  return choice;
}

export function setPadLabels(next: PadLabels): void {
  choice = next;
  try {
    if (next === 'auto') localStorage.removeItem(STORE);
    else localStorage.setItem(STORE, next);
  } catch {
    // private window: for this visit
  }
  for (const fn of listeners) fn();
}

/** The controller has a touchpad (a PlayStation one): the map and the scores are on it, the FPS counter on Create. */
export function hasTouchpad(): boolean {
  return seen?.touchpad ?? false;
}

/** The controller doesn't use the standard layout: its buttons may sit elsewhere. */
export function oddLayout(): boolean {
  return seen ? !seen.standard : false;
}

/** The name printed on the button at `b`, for the kind the hints follow. */
export function btn(b: PadButton): string {
  return NAMES[labelFamily()][b];
}

/** The name printed on the button at `b` on a controller of kind `family` (the split screen's cards, one controller each). */
export function btnOf(family: PadFamily, b: PadButton): string {
  return NAMES[family][b];
}

/** "PlayStation controller", "Xbox-style controller" or "Nintendo-style controller", in the player's language. */
export function familyName(family: PadFamily = padFamily()): string {
  return t(family === 'ps' ? 'pad.ps' : family === 'nintendo' ? 'pad.nintendo' : 'pad.xbox');
}

/** The four face buttons, lowest first round to the left, as the setting's choices show them. */
export function faceButtons(family: PadFamily = padFamily()): string {
  const n = NAMES[family];
  return `${n.south} ${n.east} ${n.west} ${n.north}`;
}

/** Call `fn` when the names change (another controller, or the setting). */
export function onPadLabels(fn: () => void): void {
  listeners.add(fn);
}
