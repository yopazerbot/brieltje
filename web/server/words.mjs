// Words kept out of the chat, the host's announcements and guests' names at a LAN night (Yoshi, 11 Nov 2026: families
// and children play). A short list of English and Dutch (Flemish) swear words and slurs, plus whatever the host adds for
// the evening (server/host.mjs). Matched on the letters only, so "s.h.i.t" and "SHIT" are caught too; a word is caught
// inside a longer one only when it is long enough not to hit an innocent word ("class", "Scunthorpe").

const BASE = [
  // English
  'fuck', 'fucker', 'fucking', 'shit', 'bitch', 'bastard', 'asshole', 'dick', 'cunt', 'whore', 'slut', 'wanker', 'retard', 'nigger', 'nigga', 'faggot', 'porn', 'penis', 'vagina', 'pussy',
  // Dutch and Flemish
  'kut', 'klootzak', 'lul', 'hoer', 'tering', 'kanker', 'kankerlijer', 'godverdomme', 'tyfus', 'mongool', 'flikker', 'neuken', 'eikel', 'trut', 'sukkel', 'kloten', 'pik', 'slet', 'gvd',
];
/** Words this long or longer are also caught inside longer words, except these ("catering", an oak's "eikels"). */
const INSIDE = 5;
const WHOLE = new Set(['tering', 'eikel', 'kloten', 'retard', 'trut']);
/** Shorter words that are still caught inside longer ones (no innocent word holds them). */
const ALSO_INSIDE = new Set(['fuck', 'shit', 'porn', 'slut']);
const within = (w) => ALSO_INSIDE.has(w) || (w.length >= INSIDE && !WHOLE.has(w));

const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const letters = (s) => fold(s).replace(/[^a-z]/g, '');

export class Words {
  constructor() {
    this.extra = new Set();
  }

  /** The host's own words for the evening: letters only, 2 to 30 of them, at most 100 words. */
  set(list) {
    this.extra = new Set((Array.isArray(list) ? list : []).filter((w) => typeof w === 'string').map(letters).filter((w) => w.length >= 2 && w.length <= 30).slice(0, 100));
  }

  list() {
    return [...this.extra];
  }

  all() {
    return [...BASE, ...this.extra];
  }

  /** Whether a name (letters, digits, - and _) holds a word on the list. */
  rude(name) {
    const l = letters(String(name));
    return this.all().some((w) => (within(w) || this.extra.has(w) ? l.includes(w) : l === w));
  }

  /** A line of text with each word on the list (as a whole word, or inside one if long) starred out. */
  clean(text) {
    return String(text).replace(/[\p{L}\p{N}._*-]+/gu, (token) => {
      const l = letters(token);
      if (!l) return token;
      const hit = this.all().some((w) => (within(w) ? l.includes(w) : l === w));
      return hit ? '*'.repeat(Math.min(8, token.length)) : token;
    });
  }
}

/** The list for guests' names before any host is there (server/auth.mjs). */
export const words = new Words();
