import PLACES from '../shared/places.json';
import { PORTALS } from '../shared/portals.mjs';
import { lang, listOf, portalName, portalNames, t } from './i18n';

/**
 * Where /location goes (Yoshi, 1 Nov 2026): the portals (shared/portals.mjs) and a spot on every
 * named street (shared/places.json, tools/places.py). The server knows the same list and moves
 * you only to these spots (server/game.mjs travel).
 *
 * A name is found whatever its capitals, accents, spaces and hyphens ("molen hoek", "oordegem-
 * kouter"), by its start when only one place starts that way ("kerkh"), or by the start of a later
 * word ("glorieux"). A portal's own words win over a street of the same name: /molenhoek is still
 * the portal, which stands on that street. More than one fits: the list of those. None: the
 * closest names.
 */

/** Somewhere to go: a portal, or a spot on a street. */
export interface Destination {
  id: string;
  name: string;
  /** The hamlet under the name on arriving */
  sub: string;
  color: string;
  /** In the village that loads after the start */
  village?: boolean;
  x: number;
  z: number;
  /** On foot and in a car: x, z, yaw */
  out: [number, number, number];
  car: [number, number, number];
  /** A portal's words in the chat */
  words?: string[];
  street?: boolean;
}

/** A street's dot, flash and pulse: the pale grey of a street sign's letters, apart from the portals' own colours. */
const STREET_COLOR = '#cfd8dc';

export const STREETS: Destination[] = PLACES.places.map((p) => ({
  id: p.id, name: p.name, sub: p.sub, color: STREET_COLOR, village: 'village' in p && !!p.village, x: p.x, z: p.z,
  out: [p.x, p.z, p.yaw], car: p.car as [number, number, number], street: true,
}));
export const DESTINATIONS: Destination[] = [...PORTALS, ...STREETS];
const BY_ID = new Map(DESTINATIONS.map((d) => [d.id, d]));

/** The portal or street spot with this id (from the server, say), if there is one. */
export function destination(id: unknown): Destination | undefined {
  return typeof id === 'string' ? BY_ID.get(id) : undefined;
}

/** A name as it is compared: small letters, no accents, only letters and digits. */
export const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** What finds a place whole: a portal's id, words and names in both languages; a street's name. */
function names(d: Destination): string[] {
  return (d.street ? [d.name] : [d.id, ...(d.words ?? []), ...portalNames(d)]).map(fold);
}
/** What finds it by its start: those, and each later word of its names ("glorieux" for Stefaan Glorieuxstraat). */
function starts(d: Destination): string[] {
  const whole = d.street ? [d.name] : [d.name, ...portalNames(d)];
  const later = whole.flatMap((n) => n.split(/[\s-]+/).slice(1).map((_, i, w) => fold(w.slice(i).join(''))));
  return [...names(d), ...later];
}

export type Found = { to: Destination } | { many: Destination[] } | { none: Destination[] };

/** The place a name typed in the chat means, the places it could mean, or the closest ones. */
export function findPlace(typed: string): Found {
  const q = fold(typed);
  const whole = DESTINATIONS.filter((d) => q && names(d).includes(q));
  // A portal's own word over a street of the same name (/molenhoek, /briel).
  const portals = whole.filter((d) => !d.street);
  if (portals.length === 1 || (whole.length === 1)) return { to: portals[0] ?? whole[0] };
  if (whole.length > 1) return { many: whole };
  const begun = q.length >= 2 ? DESTINATIONS.filter((d) => starts(d).some((k) => k.startsWith(q))) : [];
  if (begun.length === 1) return { to: begun[0] };
  if (begun.length > 1) return { many: begun };
  return { none: closest(q, 4) };
}

/** At most `n` places whose names are nearest to `q` (letters to change, add or drop; on their start too), none much further than the nearest. */
function closest(q: string, n: number): Destination[] {
  const score = (d: Destination) => Math.min(...starts(d).map((k) => Math.min(edits(q, k), edits(q, k.slice(0, q.length)) + 0.5)));
  const ranked = DESTINATIONS.map((d) => ({ d, s: score(d) })).sort((a, b) => a.s - b.s || placeName(a.d).localeCompare(placeName(b.d)));
  return ranked.filter((e) => e.s <= ranked[0].s + 2).slice(0, n).map((e) => e.d);
}

/** Levenshtein distance: the letters to change, add or drop to turn a into b. */
function edits(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/** A place's name as shown: a portal's in the current language, a street's own. */
export const placeName = (d: Destination): string => (d.street ? d.name : portalName(d));

/** The short word for a portal in the chat, in the current language, where its name is longer (both languages' words always work). */
const PORTAL_WORDS: Record<'nl' | 'en', Record<string, string>> = {
  nl: { house: 'huis', molenhoek_mid: 'midden', molenhoek_end: 'einde' },
  en: { house: 'house', molenhoek_mid: 'mid', molenhoek_end: 'end' },
};
/** A portal in the list: its name, with its short word where that is quicker to type ("Middle of Molenhoek (/mid)"). */
function portalEntry(p: Destination): string {
  const word = PORTAL_WORDS[lang()][p.id];
  return word ? `${portalName(p)} (/${word})` : portalName(p);
}

/** The chat's lines for /location alone: the portals, then the streets, then how to go. */
export function placeLines(): (() => string)[] {
  return [
    () => t('chat.placesList', { list: PORTALS.map(portalEntry).join(', ') }),
    () => t('chat.streetsList', { list: STREETS.map((s) => s.name).join(', ') }),
    () => t('chat.travelHelp'),
  ];
}

/** The chat's line for a name that fits several places, or none. */
export function foundLine(typed: string, found: { many: Destination[] } | { none: Destination[] }): () => string {
  const q = typed.trim().slice(0, 40);
  return 'many' in found
    ? () => t('chat.placeMany', { q, list: found.many.map(placeName).join(', ') })
    : () => t('chat.placeNone', { q, list: listOf(found.none.map(placeName), 'or') });
}
