/**
 * The time of year as Belgium keeps it, for the December decorations (Yoshi): Sinterklaas on the church square
 * from his arrival until his feast day, the Christmas lights and the tree from Advent until Epiphany.
 *
 * - Sinterklaas (world/sinterklaas.ts): from the first Saturday after 11 November (Sint-Maarten), the usual day of
 *   his arrival, up to and with 6 December; on the 7th he is gone.
 * - Christmas (world/christmas.ts): from the first Sunday of Advent (the fourth Sunday before Christmas, between
 *   27 November and 3 December) up to and with 6 January (Epiphany, Driekoningen).
 *
 * The day is the one in Brussels (Europe/Brussels), wherever the player is, so everyone sees the same thing on the
 * same day. Local and for show: nothing is sent or stored. The dev build can pretend another day
 * (briel.season.fake('2026-12-01'), main.ts); the game itself has no way to change it.
 * No graphics in here, so tests run it as is (season.test.mjs).
 */

export interface Season {
  sinterklaas: boolean;
  christmas: boolean;
}

/** A calendar day: month 1 to 12. */
export interface Day {
  y: number;
  m: number;
  d: number;
}

/** Day of the week of a calendar day: 0 Sunday to 6 Saturday. */
function weekday(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The day in November Sinterklaas arrives: the first Saturday after 11 November. */
export function sinterklaasArrives(y: number): number {
  return 11 + ((6 - weekday(y, 11, 11) + 7) % 7 || 7);
}

/** The first Sunday of Advent, as [month, day]: four Sundays before Christmas. */
export function firstAdvent(y: number): [number, number] {
  const sunday = 24 - weekday(y, 12, 24); // the last Sunday before Christmas (24 December when it is one)
  const d = sunday - 21;
  return d >= 1 ? [12, d] : [11, d + 30];
}

/** What is on for a calendar day. */
export function seasonOn({ y, m, d }: Day): Season {
  const [am, ad] = firstAdvent(y);
  return {
    sinterklaas: (m === 11 && d >= sinterklaasArrives(y)) || (m === 12 && d <= 6),
    christmas: (m === 1 && d <= 6) || (m === 12 && (am === 11 || d >= ad)) || (m === 11 && am === 11 && d >= ad),
  };
}

/** The calendar day in Brussels at this moment (the browser's own day if it doesn't know the time zone). */
export function brusselsDay(now: Date): Day {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Brussels', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const day = { y: get('year'), m: get('month'), d: get('day') };
    if (Number.isInteger(day.y) && Number.isInteger(day.m) && Number.isInteger(day.d)) return day;
  } catch {
    // no time zone data: the browser's own day below
  }
  return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
}

/** Read 'YYYY-MM-DD' (or a longer ISO date, the rest ignored); null when it isn't one. */
export function parseDay(text: string): Day | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text.trim());
  if (!m) return null;
  const day = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  return day.m >= 1 && day.m <= 12 && day.d >= 1 && day.d <= 31 ? day : null;
}

let fake: Day | null = null;
let cached: { at: number; season: Season } | null = null;

/** Development only (main.ts briel.season): pretend it is this day ('2026-12-01'), or null for today again. */
export function fakeDay(text: string | null): Season {
  fake = text === null ? null : parseDay(text);
  cached = null;
  return seasonNow();
}

/** What is on now; worked out again once a minute (the day can turn while playing). */
export function seasonNow(): Season {
  const t = Date.now();
  if (!cached || t - cached.at > 60_000 || t < cached.at) cached = { at: t, season: seasonOn(fake ?? brusselsDay(new Date(t))) };
  return cached.season;
}
