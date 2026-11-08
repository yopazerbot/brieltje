/**
 * A ready-made guest name for a player with only a controller (Yoshi, 8 Nov 2026: "Make it simple for console players to
 * do the setup menu as well"): typing a name with a console's on-screen keyboard is slow, so the start screen offers one,
 * such as "Kerkuil-27", and "Different name" rolls another (src/ui/padStart.ts).
 *
 * Village words only: animals, trades and things you find in a Flemish village, never anyone's name, all fit for
 * children. Each word with a dash and two digits keeps to the server's name rules (server/auth.mjs NAME_RE: a-z, 0-9,
 * - and _, 2 to 20 characters, lowercased there), which src/ui/guestName.test.mjs checks for every word.
 */
export const GUEST_WORDS = [
  'Kerkuil', 'Egel', 'Merel', 'Konijn', 'Kikker', 'Mus', 'Reiger', 'Eekhoorn', 'Koe', 'Paard', 'Schaap', 'Geit', 'Kip',
  'Eend', 'Zwaan', 'Hommel', 'Libel', 'Vlinder', 'Slak', 'Ree', 'Specht', 'Ekster', 'Spreeuw', 'Kievit', 'Ooievaar',
  'Fazant', 'Pony', 'Molenaar', 'Tuinier', 'Postbode', 'Imker', 'Fietser', 'Molen', 'Kerktoren', 'Knotwilg', 'Klaproos',
  'Hooiberg', 'Kruiwagen', 'Bakfiets', 'Tractor', 'Wafel', 'Pannenkoek', 'Molenwiek', 'Zonnebloem',
] as const;

/** A word and a number from 10 to 99, "Kerkuil-27". `rand`: 0 <= x < 1, Math.random unless a test gives its own. */
export function guestName(rand: () => number = Math.random): string {
  const word = GUEST_WORDS[Math.floor(rand() * GUEST_WORDS.length) % GUEST_WORDS.length];
  return `${word}-${10 + (Math.floor(rand() * 90) % 90)}`;
}
