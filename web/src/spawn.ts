import CARS from '../shared/car.json';
import { bothNames, furnitureName, t, teslaLabel } from './i18n';
import { ITEMS } from './world/furnishing';

/**
 * What you can spawn with /name in the chat (src/main.ts command; Yoshi, 2 Nov 2026, in place of the
 * furniture planner): every piece of furniture (shared/furniture.json), the Teslas (shared/car.json:
 * placed) and the two characters, a clown and a strongman. A typed name finds one by the words of its
 * English or Dutch name, or its id: /sofa, /stoel, /tesla red, /bed 160, /krachtpatser. Every word
 * typed must start a word of the name; of those that fit, an id or a whole word typed counts first,
 * then the shortest name (the plainest: /bed is the first double bed, /sofa the two-seater).
 */

export type ThingKind = 'furniture' | 'tesla' | 'character';
export interface Thing {
  kind: ThingKind;
  id: string;
  /** Its name in this page's language */
  label: () => string;
  /** Its words, folded (both languages, the id) */
  words: string[];
  /** The English name, for ranking (shorter is plainer) */
  english: string;
}

/** Lower case, without accents and punctuation, words split. */
export const foldWords = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Extra words people type for a few things, in both languages. */
const ALIASES: Record<string, string[]> = {
  sofa2: ['zetel', 'bank', 'couch'], sofa3: ['zetel', 'bank', 'couch'], chair: ['stoel'], plant: ['plant', 'palm'],
  floorlamp: ['lamp'], tvunit: ['tv', 'televisie'], washer: ['wasmachine'], jacuzzi: ['bubbelbad'],
};

const CHARACTERS = [
  { id: 'clown', english: 'Clown', words: ['clown', 'clowns'], key: 'spawn.clown' as const },
  { id: 'strongman', english: 'Strongman', words: ['strongman', 'krachtpatser', 'reus', 'giant'], key: 'spawn.strongman' as const },
];

export const THINGS: Thing[] = [
  ...ITEMS.map((it): Thing => ({
    kind: 'furniture', id: it.id, english: it.name, label: () => furnitureName(it.id, it.name),
    words: [it.id.toLowerCase(), ...bothNames(it.id, it.name).flatMap(foldWords), ...(ALIASES[it.id] ?? [])],
  })),
  ...Object.entries(CARS.placed.kinds).map(([id, k]): Thing => ({
    kind: 'tesla', id, english: k.label, label: () => teslaLabel(id, k.label),
    words: [id.toLowerCase(), ...bothNames(id, k.label).flatMap(foldWords), 'auto', 'car'],
  })),
  ...CHARACTERS.map((c): Thing => ({ kind: 'character', id: c.id, english: c.english, label: () => t(c.key), words: c.words })),
];

/**
 * The thing a typed name means, or null. `exact`: only when every word typed is a whole word of its
 * name (a bare /word is a place to travel to otherwise: /church is no piece of furniture).
 */
export function findThing(typed: string, exact = false): Thing | null {
  const query = foldWords(typed);
  if (!query.length) return null;
  const byId = THINGS.find((th) => th.id.toLowerCase() === query.join(''));
  if (byId) return byId;
  const fits = THINGS.filter((th) => query.every((q) => th.words.some((w) => (exact ? w === q : w.startsWith(q)))));
  if (!fits.length) return null;
  const whole = (th: Thing) => query.filter((q) => th.words.includes(q)).length;
  return fits.sort((a, b) => whole(b) - whole(a) || a.english.length - b.english.length)[0];
}

/** Every thing's name in this page's language, by kind (the list /spawn shows). */
export function thingNames(kind: ThingKind): string[] {
  return THINGS.filter((th) => th.kind === kind).map((th) => th.label());
}
