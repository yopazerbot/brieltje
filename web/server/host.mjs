// The host's controls for a LAN night (Yoshi, 11 Nov 2026: "which admin controls I still need to be able to host a
// relatively big LAN party (about 30 people) ... super user friendly but powerful"; then: flexible for the number who
// come, no helpers, the evening's scoreboard per player and per team, hosted on a local server). Only for the open
// world (not the Zombies rooms), and only ever for the admin: every action comes through POST /api/host, behind the
// admin's session and the same-origin JSON check (server.mjs), and each is checked here again (types, ranges, rate).
//
// - The doors: locked, a newcomer waits outside (the page tries again every few seconds) until the host lets them in;
//   whoever already played this evening comes back in on their own.
// - Announcements on every screen, freezing everyone (no moving or fighting; looking and the menu still work), bringing
//   one player or everyone to where the host stands, muting a player, the chat off, a word filter (server/words.mjs),
//   and a kick for the whole evening besides the kick of ten minutes.
// - Teams for the evening: none, or 2 to 4, shuffled as evenly as can be, a player moved by hand (only the host moves
//   anyone, also during a game: at once; a newcomer joins the smallest, level at random). With two (blue and red),
//   House against bungalow and Steal the flag are played by them, in their colours (blue plays at the house, red at the
//   bungalow). A team game started without them deals everyone evenly at random, and that deal becomes the two (adopt).
// - The programme: the evening's games in order, each with its own length (and goal for the teams game) and its look
//   (server/modes.mjs LOOKS: 'paint', child-friendly for everyone while it runs; 'real', the house rule's child-friendly
//   off for it, a player's own Paintball kept; or none, the house rule); Next starts the next one after a countdown of
//   ten seconds, as does starting one straight away.
// - The evening's scoreboard: every game played gives a point to each who took part and three more to its winners; in
//   Zombies everyone also gets a point for every three waves; a won round of free play counts as a game. A team's total
//   is what its players scored while on it. Kept in memory: a restart begins a new evening.

import { words } from './words.mjs';
import { ASSAULT_TITLE, KINDS, LOOKS, shuffled } from './modes.mjs';
import { ARENAS } from '../shared/arenas.mjs';
import { DUEL_KINDS, SIDES as DUEL_SIDES } from './duel.mjs';
import { FIELDS } from '../shared/flagFields.mjs';

// The first two are the evening's blue and red (Yoshi, 16 Nov 2026: "team blue vs team red").
export const EVENING_TEAMS = [
  { id: 'blue', color: '#4fa3e0' },
  { id: 'red', color: '#e5484d' },
  { id: 'green', color: '#5cc28a' },
  { id: 'purple', color: '#c77dff' },
];
const COUNTDOWN_MS = 10_000;
const KNOCK_MS = 30_000; // someone who tried to come in this recently is on the host's list
const EVENING_KICK_MS = 12 * 3600_000;
const PLACES = new Set(ARENAS.map((a) => a.id));
const POINTS = { played: 1, won: 3, wavesPer: 3 };
/** Attack and defend's results with a winning team (server/assault.mjs final). */
const ASSAULT_WON = new Set(['assaultTime', 'assaultOnly', 'assaultFar', 'assaultTags']);
/** The teams that may defend the church first in Attack and defend: tonight's first two (blue, red). */
const DEFENDERS = ['blue', 'red'];
/** Attack and defend's rounds last 1 to this many minutes each (two rounds and a break: an evening's slot). */
export const ASSAULT_MINUTES = 15;

const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');
const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
/** A table keyed by player names without the keys every object has (a player may be called "constructor"). */
const table = () => Object.create(null);

export class Host {
  constructor(game) {
    this.game = game;
    this.locked = false;
    this.admitted = new Set(); // let in by the host while the doors are locked
    this.evening = new Set(); // everyone who played this evening: let back in when the doors are locked
    this.knocking = new Map(); // name -> { at, role }: tried to come in while locked
    this.frozen = null; // { text } while everyone is frozen
    this.muted = new Set();
    this.chatOff = false;
    this.teamCount = 0;
    this.teams = table(); // name -> index into EVENING_TEAMS
    this.programme = []; // { kind, place, minutes, goal, look }
    this.nextIndex = 0;
    this.countdown = null; // { kind, until, timer }
    this.scores = table(); // name -> { points, wins, played }
    this.teamPoints = [0, 0, 0, 0];
    this.history = []; // { kind, at, winners }
    this.actions = []; // when the host's last actions came (a flood guard)
  }

  // ------------------------------------------------------------------ the game asks

  /** A newcomer is kept outside: the doors are locked, they aren't the admin, weren't let in and haven't played tonight. */
  shut(session) {
    const name = session.username;
    if (!this.locked || session.role === 'admin' || this.admitted.has(name) || this.evening.has(name)) return false;
    this.knocking.set(name, { at: Date.now(), role: session.role });
    return true;
  }

  /** Someone came in (game.mjs join): one of tonight's, on a team if there are teams, frozen if all are. */
  joined(name, player) {
    this.evening.add(name);
    this.knocking.delete(name);
    if (this.teamCount && !(name in this.teams) && player.role !== 'admin') this.teams[name] = this.smallestTeam();
    if (this.frozen) this.game.send(player.ws, { t: 'freeze', on: true, text: this.frozen.text });
  }

  /** Nobody but the host moves or fights while frozen (the server keeps them where they stood). */
  holds(player) {
    return !!this.frozen && player.role !== 'admin';
  }

  /** A player's chat line refused: muted, or the chat off for all but the host. The reason, or ''. */
  silenced(name, player) {
    if (player.role === 'admin') return '';
    if (this.muted.has(name)) return 'muted';
    if (this.chatOff) return 'chatOff';
    return '';
  }

  /** With two teams tonight: who plays for the house and who for the bungalow in the teams game (else null). */
  sides(names) {
    if (this.teamCount !== 2) return null;
    const out = table();
    for (const n of names) out[n] = (this.teams[n] ?? this.smallestTeam()) === 0 ? 'house' : 'bungalow';
    return out;
  }

  sideOf(name) {
    return this.teamCount === 2 && name in this.teams ? (this.teams[name] === 0 ? 'house' : 'bungalow') : null;
  }

  /** The teams game played by the host's two teams: its sides in their colours (blue at the house, red at the bungalow). */
  sideColors() {
    return { house: EVENING_TEAMS[0].color, bungalow: EVENING_TEAMS[1].color };
  }

  // ------------------------------------------------------------------ the evening's scores

  award(names, winners, extra = 0) {
    const won = new Set(winners);
    for (const n of new Set(names)) {
      const s = (this.scores[n] ??= { points: 0, wins: 0, played: 0 });
      const got = POINTS.played + extra + (won.has(n) ? POINTS.won : 0);
      s.points += got;
      s.played++;
      if (won.has(n)) s.wins++;
      if (n in this.teams) this.teamPoints[this.teams[n]] += got;
    }
  }

  /** The evening's points for reaching `wave` in Zombies: one per POINTS.wavesPer (the Zombies duel too, server/duel.mjs). */
  wavePoints(wave) {
    return Math.floor((wave ?? 0) / POINTS.wavesPer);
  }

  /** A party game ended (server/modes.mjs finish): its players' points, from how it ended. */
  gameOver(state, code, args = {}) {
    const here = [...this.game.players.keys()];
    const present = new Set(this.game.players.keys());
    let winners = [];
    let extra = 0;
    if (code === 'hiddenWin' || code === 'huntWon') winners = args.names ?? [];
    else if (code === 'foundAll') winners = [...(state.seekers ?? [])];
    else if (code === 'seekerLeft') winners = here.filter((n) => !state.seekers?.has(n));
    else if (code === 'tagWon') winners = [args.name];
    else if (code === 'teamWon' || code === 'teamsTime' || code === 'flagWon' || code === 'flagTagsWon' || ASSAULT_WON.has(code)) winners = Object.keys(state.teams ?? {}).filter((n) => state.teams[n] === args.team);
    else if (code === 'zOver' || code === 'zOverBest') extra = this.wavePoints(args.n);
    winners = winners.filter((n) => typeof n === 'string' && present.has(n));
    this.award(here, winners, extra);
    if (['hide', 'tag', 'treasure', 'teams'].includes(state.kind)) this.game.partyWon?.(state.kind, winners); // the all-time board of party games won
    this.history.push({ kind: state.kind, at: Date.now(), winners });
    if (this.history.length > 50) this.history.shift();
  }

  /** A round of free play was won (first to the kill limit): a game too. Those who fought in it took part. */
  roundWon(winner) {
    const fought = [...this.game.players.entries()].filter(([n, p]) => n === winner || p.score.kills + p.score.deaths > 0).map(([n]) => n);
    this.award(fought, [winner]);
    this.history.push({ kind: 'free', at: Date.now(), winners: [winner] });
  }

  /** The evening's scoreboard: everyone who scored tonight, best first; the teams' totals. For the big screen too. */
  board() {
    const players = Object.entries(this.scores).map(([name, s]) => ({ name, ...s, team: this.teamIdOf(name), here: this.game.players.has(name) })).sort((a, b) => b.points - a.points || b.wins - a.wins);
    const teams = EVENING_TEAMS.slice(0, this.teamCount).map((t, i) => ({ ...t, points: this.teamPoints[i], players: Object.keys(this.teams).filter((n) => this.teams[n] === i) }));
    return { players, teams, games: this.history.length, ...this.game.goals?.tonight() }; // tonight's route times and gnomes (server/goals.mjs)
  }

  teamIdOf(name) {
    return name in this.teams && this.teams[name] < this.teamCount ? EVENING_TEAMS[this.teams[name]].id : null;
  }

  /** The team with the fewest players here; level, one of those at random (never the first team always). */
  smallestTeam() {
    const n = Array(this.teamCount).fill(0);
    for (const name of this.game.hub?.games().flatMap((g) => [...g.players.keys()]) ?? this.game.players.keys()) if (name in this.teams && this.teams[name] < this.teamCount) n[this.teams[name]]++; // in the rooms too (the Zombies duel)
    const least = n.map((c, i) => [c, i]).filter(([c]) => c === Math.min(...n));
    return least[Math.floor(Math.random() * least.length)][1];
  }

  /**
   * A team game started without tonight's two teams (server/modes.mjs start; Yoshi, 17 Nov 2026: "team assignment is
   * admin only"): the game's even, random deal (`dealt`: name -> one of `pair`) becomes tonight's two teams, so the host
   * page shows them and moves a player as for teams it made (`move`). The host not counted, as in shuffle. With three
   * or four teams tonight nothing changes here (the game deals its own two).
   */
  adopt(dealt, pair) {
    if (this.teamCount !== 0) return;
    this.teamCount = 2;
    this.teamPoints = [0, 0, 0, 0];
    this.teams = table();
    for (const [n, side] of Object.entries(dealt)) if (this.game.players.get(n)?.role !== 'admin') this.teams[n] = pair.indexOf(side);
    this.tellTeams();
  }

  // ------------------------------------------------------------------ what the host page shows

  view() {
    const now = Date.now();
    for (const [n, k] of this.knocking) if (now - k.at > KNOCK_MS || this.game.players.has(n)) this.knocking.delete(n);
    const players = [...this.game.players.entries()].filter(([, p]) => !p.guard).map(([name, p]) => ({ // the people (the guards: `guards`)
      name, role: p.role, team: this.teamIdOf(name), muted: this.muted.has(name), alive: p.alive, ping: p.rttAvg === null ? null : Math.round(p.rttAvg),
      points: this.scores[name]?.points ?? 0, kills: p.score.kills, deaths: p.score.deaths,
      inside: !!this.game.gate.insideOf(p), // inside a private home: the hall screen shows a card, never the picture
    }));
    return {
      players, max: this.game.rules.maxPlayers, most: this.game.most, locked: this.locked, knocking: [...this.knocking.keys()],
      frozen: this.frozen, chatOff: this.chatOff, words: words.list(),
      teams: { count: this.teamCount, list: EVENING_TEAMS },
      programme: this.programme, next: this.nextIndex, countdown: this.countdown ? { kind: this.countdown.kind, ms: Math.max(0, this.countdown.until - now) } : null,
      mode: this.game.modes.view(now), board: this.board(), kinds: KINDS, places: [...PLACES],
      duel: this.game.hub?.duel?.view(now) ?? null, // the Zombies duel (server/duel.mjs)
      inDuel: this.inDuel(), // who plays in its rooms: the hall screen follows them there (admin/watch)
      guards: this.game.flagGuards?.view() ?? null, // Steal the flag's guards, per team (server/flagGuards.mjs)
    };
  }

  /**
   * Everyone in the Zombies duel's two rooms (server/duel.mjs): their side, standing or down, and their counts (the hall
   * screen's "follow the action" watches them change). For the admin only, as the rest of this view.
   */
  inDuel() {
    const st = this.game.hub?.duel?.state;
    if (!st) return [];
    return DUEL_SIDES.flatMap((side) => {
      const g = st.sides[side].game;
      const z = g.modes.state.kind === 'zombies' ? g.modes.state.z : null;
      return [...g.players.entries()].map(([name, p]) => ({
        name, side, alive: p.alive, kills: p.score.kills, deaths: p.score.deaths, beaten: z?.horde.beaten[name] ?? 0, inside: !!g.gate.insideOf(p),
      }));
    });
  }

  // ------------------------------------------------------------------ what the host does

  /** One action from the host page. `by`: the admin's name. Returns { ok } or { error, code }. */
  act(by, b) {
    const now = Date.now();
    this.actions = this.actions.filter((t) => now - t < 1000);
    if (this.actions.length >= 10) return { error: 'Slow down', code: 'tooFast' };
    this.actions.push(now);
    const op = str(b?.op, 20);
    const name = this.resolve(str(b?.name, 20));
    const known = (n) => this.game.players.has(n) && !this.game.players.get(n).guard; // a guard (server/flagGuards.mjs) is no one to mute, move or kick
    const g = this.game;
    switch (op) {
      case 'lock':
        this.locked = !!b.on;
        if (!this.locked) this.knocking.clear();
        g.broadcast({ t: 'system', text: this.locked ? 'The host closed the doors' : 'The host opened the doors', code: this.locked ? 'hostLocked' : 'hostOpened' });
        return { ok: true };
      case 'admit':
        if (!name) return { error: 'Who?', code: 'pickAnother' };
        this.admitted.add(name);
        this.knocking.delete(name);
        return { ok: true };
      case 'refuse':
        this.knocking.delete(name);
        return { ok: true };
      case 'limit': {
        const max = int(b.max, 2, g.most);
        if (max === null) return { error: 'Out of range', code: 'badValue' };
        g.setRules({ maxPlayers: max }, by).catch((e) => console.error('rules failed', String(e)));
        return { ok: true };
      }
      case 'announce': {
        const text = words.clean(str(b.text, 120));
        const secs = int(b.secs, 3, 60) ?? 8;
        if (!text) return { error: 'Type a message', code: 'empty' };
        g.broadcast({ t: 'announce', text, ms: secs * 1000 });
        return { ok: true };
      }
      case 'freeze': {
        const on = !!b.on;
        const text = words.clean(str(b.text, 120));
        this.frozen = on ? { text } : null;
        g.broadcast({ t: 'freeze', on, text });
        return { ok: true };
      }
      case 'bring':
        return g.bring(by, b.name === '*' ? '*' : name) ? { ok: true } : { error: 'Join the game yourself first: they come to where you stand', code: 'notInGame' };
      case 'mute':
        if (!known(name)) return { error: 'Not here', code: 'notHere' };
        if (b.on) this.muted.add(name);
        else this.muted.delete(name);
        g.send(g.players.get(name).ws, { t: 'system', text: b.on ? 'The host muted your chat' : 'You can chat again', code: b.on ? 'youMuted' : 'youUnmuted' });
        return { ok: true };
      case 'chat':
        this.chatOff = !b.on;
        g.broadcast({ t: 'system', text: this.chatOff ? 'The host turned the chat off' : 'The chat is on again', code: this.chatOff ? 'chatOffAll' : 'chatOnAll' });
        return { ok: true };
      case 'words':
        words.set(b.list);
        return { ok: true };
      case 'kick':
        if (!known(name) || name === by) return { error: 'Pick another player', code: 'pickAnother' };
        this.evening.delete(name);
        this.admitted.delete(name);
        (g.hub ? g.hub.kick(name, by, b.evening ? EVENING_KICK_MS : undefined) : g.kick(name, by, b.evening ? EVENING_KICK_MS : undefined)).catch((e) => console.error('kick failed', String(e)));
        return { ok: true };
      case 'teams': {
        const count = b.count === 0 ? 0 : int(b.count, 2, 4);
        if (count === null) return { error: 'Out of range', code: 'badValue' };
        this.teamCount = count;
        this.teamPoints = [0, 0, 0, 0];
        this.shuffle();
        return { ok: true };
      }
      case 'shuffle':
        if (!this.teamCount) return { error: 'No teams', code: 'noTeams' };
        this.shuffle();
        return { ok: true };
      case 'move': {
        const team = int(b.team, 0, this.teamCount - 1);
        if (!known(name) || team === null) return { error: 'Out of range', code: 'badValue' };
        // A team game being played has two sides: with three or four teams tonight a move would change nothing in it.
        if (this.teamCount !== 2 && g.modes.teamGame && g.modes.state.phase === 'playing') return { error: 'This game plays in two teams: set two teams tonight to move players during it.', code: 'twoTeams' };
        this.teams[name] = team;
        this.teamsMoved([name]);
        return { ok: true };
      }
      case 'programme': {
        const list = Array.isArray(b.list) ? b.list.slice(0, 20).map((e) => this.entry(e)).filter(Boolean) : null;
        if (!list) return { error: 'Out of range', code: 'badValue' };
        this.programme = list;
        this.nextIndex = Math.min(this.nextIndex, list.length);
        return { ok: true };
      }
      case 'next': {
        const e = this.programme[this.nextIndex];
        if (!e) return { error: 'The programme is done', code: 'programmeDone' };
        this.nextIndex++;
        const r = this.startIn(e, by);
        if (r.error) this.nextIndex--; // not started (the Zombies duel without its two teams): still the next one
        return r;
      }
      case 'start': {
        const e = this.entry(b);
        if (!e) return { error: 'Out of range', code: 'badValue' };
        return this.startIn(e, by);
      }
      case 'cancel':
        if (this.countdown) clearTimeout(this.countdown.timer);
        this.countdown = null;
        g.broadcast({ t: 'announce', text: '', ms: 0 });
        return { ok: true };
      case 'stop':
        g.hub?.duel?.stop(by); // the Zombies duel: both rooms at once
        g.modes.start('free', by);
        return { ok: true };
      case 'swap': // Steal the flag's sides, only at the host's request (server/modes.mjs swapSides: its game, its clock)
        return g.modes.swapSides(now);
      case 'rewind':
        this.nextIndex = Math.max(0, Math.min(this.programme.length, int(b.index, 0, 20) ?? 0));
        return { ok: true };
      case 'reset':
        this.scores = table();
        this.teamPoints = [0, 0, 0, 0];
        this.history = [];
        this.game.goals?.resetTonight();
        return { ok: true };
      case 'guards': // Steal the flag's guards, a test tool: { team, count, skill }, each checked there (server/flagGuards.mjs set)
        return g.flagGuards?.set(b, now) ?? { error: 'Out of range', code: 'badValue' };
      default:
        return { error: 'Unknown action', code: 'badOp' };
    }
  }

  /**
   * The name an action of the host means, however it is typed ("Uil" for uil): the name as kept when someone here or
   * knocking has it, else the one name among them that differs from it only in case, else the typed name in lower case
   * (as every login keeps a name: server/auth.mjs NAME_RE; letting someone in before they knock). Two names here that
   * differ only in case (none can, today) would both match: then neither does, never the wrong player. A flag game's
   * guard (server/flagGuards.mjs, names with capitals) is nobody's match.
   */
  resolve(name) {
    const all = new Set([...[...this.game.players.entries()].filter(([, p]) => !p.guard).map(([n]) => n), ...this.knocking.keys()]);
    if (!name || all.has(name)) return name;
    const low = name.toLowerCase();
    const hits = [...all].filter((n) => n.toLowerCase() === low);
    return hits.length === 1 ? hits[0] : hits.length ? '' : low;
  }

  /**
   * A game from the host: a known kind, at a known place, its length in minutes and the teams' goal within reason, and
   * its look: 'paint', 'real' or none (missing, null or ''). Any other look refuses the whole game.
   */
  entry(e) {
    if (!e || typeof e !== 'object' || typeof e.kind !== 'string' || !(Object.hasOwn(KINDS, e.kind) || e.kind === 'duel' || e.kind === 'assault')) return null;
    const none = e.look === undefined || e.look === null || e.look === '';
    if (!none && !LOOKS.includes(e.look)) return null;
    // Attack and defend (server/assault.mjs): who defends the church in round 1 (blue when not said; anything else refuses
    // the game), each round's minutes (1 to ASSAULT_MINUTES, none: ten; more refuses the game).
    if (e.kind === 'assault') {
      const defend = e.defend === undefined || e.defend === null || e.defend === '' ? 'blue' : DEFENDERS.includes(e.defend) ? e.defend : null;
      const given = !(e.minutes === undefined || e.minutes === null || e.minutes === '');
      const minutes = given ? int(e.minutes, 1, ASSAULT_MINUTES) : null; // out of range refuses the game: the host is told, never a quiet 10
      if (!defend || (given && minutes === null)) return null;
      return { kind: 'assault', place: 'assault', defend, minutes, goal: null, look: none ? null : e.look };
    }
    // The Zombies duel (server/duel.mjs): its warm-up (with its minutes) or its final, always at Sparrenhof.
    if (e.kind === 'duel') return DUEL_KINDS.includes(e.duel) ? { kind: 'duel', duel: e.duel, place: 'sparrenhof', minutes: e.duel === 'warmup' ? int(e.minutes, 1, 30) : null, goal: null, look: none ? null : e.look } : null;
    const place = e.kind === 'flag' ? (Object.hasOwn(FIELDS, e.place) && !FIELDS[e.place].assault ? e.place : 'compact') : typeof e.place === 'string' && PLACES.has(e.place) ? e.place : 'house'; // Steal the flag: its field
    return { kind: e.kind, place, minutes: int(e.minutes, 1, 30), goal: e.kind === 'teams' ? int(e.goal, 5, 100) : null, look: none ? null : e.look };
  }

  /** The game starts in ten seconds: everyone sees the countdown. */
  startIn(e, by) {
    const duel = e.kind === 'duel' ? this.game.hub?.duel : null;
    if (e.kind === 'duel') {
      const why = duel ? duel.cannot() : { error: 'No rooms here', code: 'duelTeams' };
      if (why) return why;
    }
    if (this.countdown) clearTimeout(this.countdown.timer);
    const until = Date.now() + COUNTDOWN_MS;
    const timer = setTimeout(() => {
      this.countdown = null;
      if (!duel) return this.game.modes.start(e.kind === 'assault' ? 'flag' : e.kind, by, e.place, { minutes: e.minutes, goal: e.goal, look: e.look, defend: e.defend }); // Attack and defend: a flag game of its own
      const r = duel.start(e, by);
      if (r.error) this.game.broadcast({ t: 'system', text: `The Zombies duel could not start: ${r.error}`, code: r.code, args: r.args }); // its reason, in the page's language
    }, COUNTDOWN_MS);
    timer.unref?.();
    this.countdown = { kind: e.kind, until, timer };
    this.game.broadcast({ t: 'announce', code: 'nextGame', args: { kind: e.kind }, text: `Next: ${KINDS[e.kind] ?? (e.kind === 'assault' ? ASSAULT_TITLE : 'Zombies duel')}`, ms: COUNTDOWN_MS, count: true });
    return { ok: true };
  }

  /** Everyone here on a team, as evenly as can be, in random order, the extra ones on any team (the host not counted). */
  shuffle() {
    this.teams = table();
    if (!this.teamCount) return this.teamsMoved([]);
    // Every order as likely (Fisher-Yates), the first card to a random team: the extra players land on any team, not
    // always the first (Yoshi, 17 Nov 2026: "Make sure the ctf is fair").
    const names = shuffled([...this.game.players.entries()].filter(([, p]) => p.role !== 'admin' && !p.guard).map(([n]) => n));
    const off = Math.floor(Math.random() * this.teamCount);
    names.forEach((n, i) => (this.teams[n] = (i + off) % this.teamCount));
    this.teamsMoved(names);
  }

  /** Teams changed: everyone is told, and a teams game being played takes the new sides. */
  teamsMoved(names) {
    const s = this.game.modes.state;
    if (s.kind === 'teams' && s.phase === 'playing' && this.teamCount === 2) {
      for (const n of names) if (n in this.teams) s.teams[n] = this.teams[n] === 0 ? 'house' : 'bungalow';
      s.colors = this.sideColors(); // played by the host's teams from now on: blue and red
      this.game.teamsChanged(names);
      this.game.modes.send();
    }
    // Steal the flag being played: the host's move counts there too (blue for the first team, red for the second), a flag
    // in the hand of one moved dropping where they stood.
    if (s.kind === 'flag' && s.phase === 'playing' && this.teamCount === 2) {
      const moved = names.filter((n) => n in this.teams && s.teams[n] !== (this.teams[n] === 0 ? 'blue' : 'red'));
      for (const n of moved) {
        const ev = s.f.release(n, Date.now());
        if (ev) this.game.modes.flagEvents([ev]);
        s.f.arms.rack(n); // a launcher in their hands back on its rack at once
        s.teams[n] = this.teams[n] === 0 ? 'blue' : 'red';
      }
      this.game.teamsChanged(moved);
      this.game.modes.send();
    }
    this.tellTeams();
  }

  /** Every page told tonight's teams. */
  tellTeams() {
    this.game.broadcast({ t: 'eveningteams', count: this.teamCount, teams: Object.fromEntries(Object.entries(this.teams).map(([n, i]) => [n, EVENING_TEAMS[i].id])) });
  }
}
