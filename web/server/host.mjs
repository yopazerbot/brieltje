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
//   anyone; a newcomer joins the smallest). With two, House against bungalow is played by them.
// - The programme: the evening's games in order, each with its own length (and goal for the teams game); Next starts
//   the next one after a countdown of ten seconds, as does starting one straight away.
// - The evening's scoreboard: every game played gives a point to each who took part and three more to its winners; in
//   Zombies everyone also gets a point for every three waves; a won round of free play counts as a game. A team's total
//   is what its players scored while on it. Kept in memory: a restart begins a new evening.

import { words } from './words.mjs';
import { KINDS } from './modes.mjs';
import { ARENAS } from '../shared/arenas.mjs';

export const EVENING_TEAMS = [
  { id: 'blue', color: '#4fa3e0' },
  { id: 'orange', color: '#ff9f43' },
  { id: 'green', color: '#5cc28a' },
  { id: 'purple', color: '#c77dff' },
];
const COUNTDOWN_MS = 10_000;
const KNOCK_MS = 30_000; // someone who tried to come in this recently is on the host's list
const EVENING_KICK_MS = 12 * 3600_000;
const PLACES = new Set(ARENAS.map((a) => a.id));
const POINTS = { played: 1, won: 3, wavesPer: 3 };

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
    this.programme = []; // { kind, place, minutes, goal }
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
    else if (code === 'teamWon' || code === 'teamsTime') winners = Object.keys(state.teams ?? {}).filter((n) => state.teams[n] === args.team);
    else if (code === 'zOver' || code === 'zOverBest') extra = Math.floor((args.n ?? 0) / POINTS.wavesPer);
    winners = winners.filter((n) => typeof n === 'string' && present.has(n));
    this.award(here, winners, extra);
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
    return { players, teams, games: this.history.length };
  }

  teamIdOf(name) {
    return name in this.teams && this.teams[name] < this.teamCount ? EVENING_TEAMS[this.teams[name]].id : null;
  }

  smallestTeam() {
    const n = Array(this.teamCount).fill(0);
    for (const name of this.game.players.keys()) if (name in this.teams && this.teams[name] < this.teamCount) n[this.teams[name]]++;
    return n.indexOf(Math.min(...n));
  }

  // ------------------------------------------------------------------ what the host page shows

  view() {
    const now = Date.now();
    for (const [n, k] of this.knocking) if (now - k.at > KNOCK_MS || this.game.players.has(n)) this.knocking.delete(n);
    const players = [...this.game.players.entries()].map(([name, p]) => ({
      name, role: p.role, team: this.teamIdOf(name), muted: this.muted.has(name), alive: p.alive, ping: p.rttAvg === null ? null : Math.round(p.rttAvg),
      points: this.scores[name]?.points ?? 0, kills: p.score.kills, deaths: p.score.deaths,
    }));
    return {
      players, max: this.game.rules.maxPlayers, most: this.game.most, locked: this.locked, knocking: [...this.knocking.keys()],
      frozen: this.frozen, chatOff: this.chatOff, words: words.list(),
      teams: { count: this.teamCount, list: EVENING_TEAMS },
      programme: this.programme, next: this.nextIndex, countdown: this.countdown ? { kind: this.countdown.kind, ms: Math.max(0, this.countdown.until - now) } : null,
      mode: this.game.modes.view(now), board: this.board(), kinds: KINDS, places: [...PLACES],
    };
  }

  // ------------------------------------------------------------------ what the host does

  /** One action from the host page. `by`: the admin's name. Returns { ok } or { error, code }. */
  act(by, b) {
    const now = Date.now();
    this.actions = this.actions.filter((t) => now - t < 1000);
    if (this.actions.length >= 10) return { error: 'Slow down', code: 'tooFast' };
    this.actions.push(now);
    const op = str(b?.op, 20);
    const name = str(b?.name, 20);
    const known = (n) => this.game.players.has(n);
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
        return this.startIn(e, by);
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
        g.modes.start('free', by);
        return { ok: true };
      case 'rewind':
        this.nextIndex = Math.max(0, Math.min(this.programme.length, int(b.index, 0, 20) ?? 0));
        return { ok: true };
      case 'reset':
        this.scores = table();
        this.teamPoints = [0, 0, 0, 0];
        this.history = [];
        return { ok: true };
      default:
        return { error: 'Unknown action', code: 'badOp' };
    }
  }

  /** A game from the host: a known kind, at a known place, its length in minutes and the teams' goal within reason. */
  entry(e) {
    if (!e || typeof e !== 'object' || typeof e.kind !== 'string' || !Object.hasOwn(KINDS, e.kind)) return null;
    const place = typeof e.place === 'string' && PLACES.has(e.place) ? e.place : 'house';
    return { kind: e.kind, place, minutes: int(e.minutes, 1, 30), goal: e.kind === 'teams' ? int(e.goal, 5, 100) : null };
  }

  /** The game starts in ten seconds: everyone sees the countdown. */
  startIn(e, by) {
    if (this.countdown) clearTimeout(this.countdown.timer);
    const until = Date.now() + COUNTDOWN_MS;
    const timer = setTimeout(() => {
      this.countdown = null;
      this.game.modes.start(e.kind, by, e.place, { minutes: e.minutes, goal: e.goal });
    }, COUNTDOWN_MS);
    timer.unref?.();
    this.countdown = { kind: e.kind, until, timer };
    this.game.broadcast({ t: 'announce', code: 'nextGame', args: { kind: e.kind }, text: `Next: ${KINDS[e.kind]}`, ms: COUNTDOWN_MS, count: true });
    return { ok: true };
  }

  /** Everyone here on a team, as evenly as can be, in random order (the host not counted). */
  shuffle() {
    this.teams = table();
    if (!this.teamCount) return this.teamsMoved([]);
    const names = [...this.game.players.entries()].filter(([, p]) => p.role !== 'admin').map(([n]) => n).sort(() => Math.random() - 0.5);
    names.forEach((n, i) => (this.teams[n] = i % this.teamCount));
    this.teamsMoved(names);
  }

  /** Teams changed: everyone is told, and a teams game being played takes the new sides. */
  teamsMoved(names) {
    const s = this.game.modes.state;
    if (s.kind === 'teams' && s.phase === 'playing' && this.teamCount === 2) {
      for (const n of names) if (n in this.teams) s.teams[n] = this.teams[n] === 0 ? 'house' : 'bungalow';
      this.game.teamsChanged(names);
      this.game.modes.send();
    }
    this.game.broadcast({ t: 'eveningteams', count: this.teamCount, teams: Object.fromEntries(Object.entries(this.teams).map(([n, i]) => [n, EVENING_TEAMS[i].id])) });
  }
}
