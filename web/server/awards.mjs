// The results moment after a team game (Yoshi, 21 Nov 2026: "Also think about what can improve in the team versus team,
// capture the flag"; on the merger's recommendation of a results moment with awards: "Do what u think is best"): for
// RESULTS_MS after Steal the flag, Attack and defend or the team deathmatch ends, the hall's screen and every player's
// page show who won and how, the awards and each player's own best line. The server alone chooses them, from its own
// counts (server/flags.mjs statsList, server/assault.mjs `far`, server/modes.mjs the team deathmatch's `acts`); no page
// sends anything for them. Families play: every award is friendly, none is given for a count of zero, and "tagged a lot"
// is only ever "Never gave up" (came back every time), for a player still in the game.
//
// The choice (results):
// - Each game kind has its awards in order (AWARDS). In that order, each goes to the player with the highest count
//   among those without an award yet: at most one award a player, so a different player for each where it can. A
//   count of zero gives nothing. Level counts: a player of the losing side first, then the more points (or tags), then
//   the name's order (always the same answer).
// - At most MAX awards. The first MAX - 1 from the kind's list; the last place goes to a side with none yet, the losing
//   side first ("Never gave up", else its best in an award not yet given; a winning side without one: its best in an
//   award not yet given, else "Never gave up"). When both sides have one, the list goes on, then "Never gave up".
// - Every player's own line (lineOf): the best thing they did, by what each act is worth, even with no award and on
//   the losing side; nothing done, "played" (thanks for playing).

/** How long the results moment shows (server/modes.mjs finish: a team game's `done` phase), then free play. */
export const RESULTS_MS = 20_000;
/** Awards shown at most. */
export const MAX = 4;
/** m: a tag "with a teammate close by" in the team deathmatch (Team player). */
export const NEAR_M = 10;

/** Each award: the count it is given for (a row's field or a sum). */
const COUNT = {
  flagsIn: (r) => r.captures ?? 0,
  furthest: (r) => r.far ?? 0,
  saver: (r) => r.returns ?? 0,
  wall: (r) => (r.guards ?? 0) + (r.stops ?? 0),
  helper: (r) => r.assists ?? 0,
  tagger: (r) => r.tags ?? 0,
  streak: (r) => r.best ?? 0,
  teamPlayer: (r) => r.near ?? 0,
  neverGaveUp: (r) => r.tagged ?? 0,
};

/** The awards of each game kind, in the order they are given. */
export const AWARDS = {
  flag: ['flagsIn', 'saver', 'wall', 'helper', 'tagger'],
  assault: ['flagsIn', 'furthest', 'wall', 'saver', 'helper', 'tagger'],
  teams: ['tagger', 'streak', 'teamPlayer'],
};

/** What each act is worth for a player's own line (the flag games' points, server/flags.mjs WORTH; a tag less). */
const LINE_WORTH = { captures: 500, far: 3, returns: 100, stops: 100, assists: 100, guards: 50, tags: 30, best: 0, tagged: 1 };
const LINE_ACTS = { flag: ['captures', 'returns', 'stops', 'assists', 'guards', 'tags', 'tagged'], assault: ['captures', 'far', 'returns', 'stops', 'assists', 'guards', 'tags', 'tagged'], teams: ['tags', 'tagged'] };

/**
 * A player's own line: [act, n], the best thing they did (the most worth; level: the earlier act), else ['played', 0].
 * `far` (Attack and defend: the flag carried furthest, whole per cent) counts only without a capture.
 */
export function lineOf(row, kind) {
  let best = ['played', 0];
  let worth = 0;
  for (const act of LINE_ACTS[kind] ?? LINE_ACTS.flag) {
    const n = Number.isFinite(row[act]) ? row[act] : 0;
    if (n <= 0 || (act === 'far' && (row.captures ?? 0) > 0)) continue;
    const w = n * LINE_WORTH[act];
    if (w > worth) [best, worth] = [[act, n], w];
  }
  return best;
}

/**
 * The results moment of a team game. `kind` 'flag', 'assault' or 'teams'; `rows` each player's counts ({ name, team,
 * ... }: captures, returns, stops, guards, assists, tags, tagged, points, far; or tags, tagged, best, near); `winner`
 * the winning team (a row's `team`), or null for a draw; `here`: the names still in the game. Returns { awards: [{ id,
 * name, team, n }], lines: [[name, act, n]] }.
 */
export function results(kind, rows, winner, here = null) {
  const list = AWARDS[kind] ?? AWARDS.flag;
  const present = (r) => !here || here.has(r.name);
  const losing = winner ? rows.find((r) => r.team && r.team !== winner)?.team ?? null : null;
  const given = new Set();
  const awards = [];
  const done = new Set();
  /** The award `id` to the best of `pool` without one yet (level: the losing side, more points or tags, the name). */
  const give = (id, pool) => {
    const count = COUNT[id];
    let best = null;
    for (const r of pool) {
      const n = count(r);
      if (n <= 0 || given.has(r.name)) continue;
      if (!best || n > best.n || (n === best.n && better(r, best.r))) best = { r, n };
    }
    if (!best) return false;
    given.add(best.r.name);
    done.add(id);
    awards.push({ id, name: best.r.name, team: best.r.team ?? null, n: best.n });
    return true;
  };
  const better = (a, b) => {
    const la = !!losing && a.team === losing;
    const lb = !!losing && b.team === losing;
    if (la !== lb) return la;
    const pa = (a.points ?? 0) + (a.tags ?? 0);
    const pb = (b.points ?? 0) + (b.tags ?? 0);
    if (pa !== pb) return pa > pb;
    return a.name < b.name;
  };
  for (const id of list) {
    if (awards.length >= MAX - 1) break;
    give(id, rows);
  }
  // The last place: to a side with no award yet, the losing side first ("Never gave up", else its best in an award not
  // given yet); a winning side without one gets its best in an award not given yet, else "Never gave up".
  const kind1 = (pool) => give('neverGaveUp', pool.filter(present));
  const sides = [...new Set(rows.map((r) => r.team).filter(Boolean))].sort((a, b) => (b === losing) - (a === losing));
  for (const side of sides) {
    if (awards.length >= MAX || awards.some((a) => a.team === side)) continue;
    const theirs = rows.filter((r) => r.team === side);
    const best = () => list.some((id) => !done.has(id) && give(id, theirs));
    if (side === losing ? kind1(theirs) || best() : best() || kind1(theirs)) break;
  }
  if (awards.length < MAX) {
    for (const id of list) if (awards.length < MAX && !done.has(id)) give(id, rows);
    if (awards.length < MAX && !done.has('neverGaveUp')) kind1(rows);
  }
  return { awards, lines: rows.map((r) => [r.name, ...lineOf(r, kind)]) };
}
