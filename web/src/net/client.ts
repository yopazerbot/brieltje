import type { CarState } from '../world/car';
import type { Piece } from '../world/furnishing';
import { serverText, t } from '../i18n';
import { PROTO, type Tick } from '../../shared/wire.mjs';
import { seatHeaders, seatProtocols } from '../seat';
import { watch } from '../watch';

/**
 * Talking to the server: login and admin calls (HTTP), and the shared house
 * (WebSocket). The session lives in an HttpOnly cookie the page can't read.
 */

export interface Me {
  username: string;
  /** guest: joined with a name only; player: logged in to their own account (server/accounts.mjs) */
  role: 'admin' | 'guest' | 'player';
}

/** A guest's run that a new account takes onto the board (server/keepRun.mjs): as the server recorded it. */
export interface KeptRun {
  place: string;
  wave: number;
}

/** A Zombies room in the list (server/rooms.mjs): who opened it, where, how many play, the game in it. */
export interface RoomEntry {
  id: string;
  /** Who opened it: only in the admin's list (server/rooms.mjs entry). */
  owner?: string;
  /** This session opened it. */
  mine?: boolean;
  place: string;
  players: number;
  max: number;
  wave: number;
  playing: boolean;
}

/** A row of the board of best Zombies runs (accounts only): the wave reached, zombies beaten, team size, the day. */
export interface ZombieRun {
  username: string;
  place: string;
  wave: number;
  kills: number;
  team: number;
  at: string;
}

/** The party games on the board of games won (server/store.mjs GAME_KINDS), each a column. */
export interface GameWins {
  wins: number;
  hide: number;
  tag: number;
  treasure: number;
  teams: number;
}

/**
 * The boards of the timed routes, the gnomes and the party games (server/boards.mjs), the best ten of each: accounts and
 * the admin only. `races` by route id (match it to the page's own routes, never show it raw); `at`: the day.
 */
export interface Boards {
  races: Record<string, { username: string; ms: number; at: string }[]>;
  gnomes: { username: string; n: number; at: string }[];
  games: ({ username: string } & GameWins)[];
  gnomeTotal: number;
}

/** Your own lines on those boards (your session's account); empty for a guest. */
export interface BoardsMine {
  races?: Record<string, { ms: number; place: number }>;
  gnomes?: number;
  games?: GameWins;
}

export interface Score {
  name: string;
  color: string;
  kills: number;
  deaths: number;
  points: number;
  alive: boolean;
  armed: boolean;
}

/** House rules the admin sets in the settings (multiplayer) */
export interface Rules {
  flying: boolean;
  /** Players may spawn things with /name (src/spawn.ts); off at first */
  spawn: boolean;
  /** Names above other players (they show through walls) */
  names: boolean;
  /** How many may play at once (the admin chooses, 16 to start with) */
  maxPlayers: number;
  /** Guests (a name, no account) can join; missing from an older server */
  guests?: boolean;
  /** The portals take players from place to place */
  portals: boolean;
  /** Players can travel from the chat (/church); the admin always can */
  travel: boolean;
  /** Child-friendly for everyone: Action plays as Paintball on every page (src/paintball.ts); missing from an older server */
  paintball?: boolean;
  /** Arriving by parachute: respawns on open ground, the start places and /parachute (shared/parachute.mjs); missing from an older server */
  parachute?: boolean;
  /** Players may fly the helicopters (server/helis.mjs); missing from an older server */
  heli?: boolean;
}

import type { ModeView } from '../ui/games';
import type { ClownSpec } from '../world/clowns';
import type { Spot } from '../../shared/brutes.mjs';
import type { SpiritMsg, SpiritWelcome } from '../../shared/brookSpirit.mjs';
import type { HorseState } from '../world/horses';
import type { BikeState } from '../world/bike';

/**
 * A message's text for the page's language: `code` and `args` (src/i18n.ts serverText) next to the
 * English `text`. Unchecked as they arrive: serverText checks both and else shows the text.
 */
type Coded = { code?: unknown; args?: unknown };

/** A vehicle's damage as the server tells it (server/vehicleDamage.mjs). */
export interface VehicleDamageMsg {
  k: unknown;
  id: unknown;
  hp: unknown;
  st: unknown;
  by?: unknown;
  x?: unknown;
  y?: unknown;
  z?: unknown;
}

export type ServerMsg =
  | {
      /** `proto`: the server's protocol (shared/wire.mjs); a different one means this page is out of date (or the server is) */
      /** `room`: the Zombies room this connection is in (server/rooms.mjs), null or missing in the open world */
      /** `watch`: this connection watches (src/watch.ts, the admin only): no player of its own */
      t: 'welcome'; watch?: boolean; cracked?: [number, number, number, number][]; proto?: number; you: string; role: string; color: string; room?: { id: string; owner: string; place: string; duel?: 'blue' | 'red' } | null; doors: Record<string, boolean>; doorDir?: Record<string, number>; broken: number[]; homes?: string[];
      /** Of `homes`, those this player's account opens for good (server/homes.mjs byAccount) */
      accountHomes?: string[];
      players: { name: string; color: string; role: string }[]; scores: Score[]; limit: number; round: { winner: string; ms: number } | null; items: boolean[];
      time: number; cats: number[]; vils?: [number, number][]; vilPaint?: [number, string, number][]; clowns?: ClownSpec[]; furniture: Piece[]; rules?: Rules; cars?: CarState[]; horses?: HorseState[]; bikes?: BikeState[]; mode?: ModeView;
      /** The helicopters as the server has them (server/helis.mjs view), checked as they arrive (src/heliPilot.ts heliView) */
      helis?: unknown[];
      /**
       * The weather and time of day for everyone (shared/moods.mjs), and the cycle Auto follows with the server's time;
       * missing from an older server. Checked where they are used (world/weather.ts).
       */
      mood?: unknown;
      moodCycle?: { cycle?: unknown; time?: unknown };
      /** The cars and helicopters not whole now in a team match (server/vehicleDamage.mjs view), as `vdmg` tells them */
      vdmg?: VehicleDamageMsg[];
      /** The Brook Spirit and its launcher (shared/brookSpirit.mjs readSpirit checks it); missing in a room */
      spirit?: SpiritWelcome;
    }
  /** The admin changed the weather for everyone (`op`: set, skip or speed; `by`: who, a name for textContent only), with the cycle */
  | { t: 'mood'; mood: unknown; by?: string; op?: unknown; cycle?: unknown; time?: unknown }
  | { t: 'car'; car: CarState }
  /**
   * A helicopter (server/helis.mjs): someone got in or out, your answer, `home` it went back to its pad, `fix` the
   * server put your step back (to its pilot alone). Checked as it arrives (src/heliPilot.ts heliView).
   */
  | { t: 'heli'; heli: unknown; home?: unknown; fix?: unknown }
  /** The spawned Teslas, after one was spawned, moved or taken away (each with its kind) */
  | { t: 'teslas'; list: CarState[] }
  /**
   * A car or a helicopter took damage in a team match (server/vehicleDamage.mjs): `hp` in whole percent, `st` its stage
   * (0 whole, 1 smoke, 2 fire, 3 wreck, 4 gone); on its destruction `by` (a name, for textContent only) and where. Checked as
   * it arrives (world/vehicleWear.ts).
   */
  | ({ t: 'vdmg' } & VehicleDamageMsg)
  | { t: 'rules'; rules: Rules }
  | ({ t: 'travel'; name: string; to: string; ok: boolean; car?: string | null; text?: string } & Coded)
  /** A code-locked home is shut to this player (server/homeGate.mjs): they stood inside it, or tried to walk in, without the right. */
  | { t: 'homelock'; id: string }
  /** This session got the right to home `id` (`account`: through its account, for good, server/homes.mjs) */
  | { t: 'inside'; id: string; doors: Record<string, boolean>; doorDir: Record<string, number>; broken: number[]; furniture: Piece[]; account?: boolean }
  /** The server put this player out of the end house's garden, to (x, z) */
  | { t: 'unstuck'; x: number; z: number }
  /** The start place picked on the start screen was refused (portals off): where the server has you. */
  | { t: 'spawn'; ok: false; x: number; z: number }
  /**
   * Taken: by parachute onto (x, z), coming in facing `yaw` (the start place's, or the house's start: HOME_DROP), starting over (sx, sz);
   * with `sy`, a jump from a helicopter (server/helis.mjs chute) starting at (sx, sy, sz), where the server has the machine
   */
  | { t: 'spawn'; ok: true; drop?: 1; x: number; z: number; yaw?: number; sx?: number; sz?: number; sy?: number }
  /** /parachute refused (server/game.mjs manualDrop): why, as a code the page translates */
  | ({ t: 'chute'; ok: false } & Coded)
  | { t: 'mode'; mode: ModeView }
  | { t: 'clowns'; list: ClownSpec[] }
  /** Twenty times a second: what moved (shared/wire.mjs) */
  | Tick
  | { t: 'rock'; type: 'throw'; id: number; from: Spot; to: Spot; ms: number }
  | { t: 'stomp'; type: 'stomp'; id: number; at: Spot }
  /** The Brook Spirit (server/brookSpirit.mjs): its state `sp`, its effects `spe`, its launcher `sgl` */
  | SpiritMsg
  | { t: 'clownhit'; id: number; by: string; ms: number; w: string }
  /** The Zombies game: zombie `id` beaten by `by` with weapon `w`; fallen ones taken away (server/zombies.mjs) */
  | { t: 'zdown'; id: number; by: string; w: string; double?: boolean }
  | { t: 'zgone'; ids: number[] }
  | { t: 'revive'; op: 'start' | 'stop'; name?: string; by?: string; ms?: number }
  | { t: 'zgift'; kind: 'ammo' | 'scope' | 'claymore' | 'stakes' | 'turret' | 'medkit' | 'armor' | 'nades' | 'lull' | 'gun' | 'rifle' | 'placed' | 'kit'; w?: string; hp?: number; kit: { ammo: string[]; scope: boolean; claymores: number; stakes?: number; turrets?: number; armor?: number; nades?: number } }
  /** Your own coins in the Zombies game and what you bought at the stall (to you alone; ui/stall.ts checks them) */
  | { t: 'zcoins'; c: unknown; n: unknown }
  | { t: 'zboom'; id: number; x: number; y: number; z: number; yaw: number; by: string }
  /** A row of stakes worn through by the zombies: it's gone (the view follows) */
  | { t: 'zbroke'; id: number }
  /** The turrets' shots in one tick: [turret id, zombie id, rounds left] */
  | { t: 'zfire'; s: [number, number, number][] }
  | { t: 'revived'; name: string; by: string; hp: number; x?: number; y?: number; z?: number }
  | { t: 'rocket'; name: string; x: number; y: number; z: number; tx: number; ty: number; tz: number }
  | { t: 'blast'; by: string; x: number; y: number; z: number; w?: string }
  | { t: 'nade'; name: string; x: number; y: number; z: number; vx: number; vy: number; vz: number }
  | { t: 'scores'; list: Score[] }
  /**
   * The server timed a route you finished playing together (server/goals.mjs), to you alone: `ms` its time, `best` a new
   * best on the board, `place` its place then (else null); `tonight`: on tonight's board only (a guest's, or the car's).
   * Before using `race` or `gnome`, check the types and ranges as for any server message (a known route id from the
   * page's own list, finite whole numbers in range, booleans), and put any of it on screen with textContent only.
   */
  | { t: 'race'; id: string; ms: number; best: boolean; place: number | null; tonight: boolean }
  /** The server noted a gnome you walked up to: `n` found on the board (a guest's: tonight) */
  | { t: 'gnome'; n: number; tonight: boolean }
  | { t: 'hurt'; hp: number; by: string; from?: { x: number; z: number } }
  | { t: 'rally'; name: string; x: number; y: number; z: number }
  | { t: 'placement'; id: number; ok: boolean; why?: 'none' | 'max' | 'all' | 'spot'; a?: number; b?: number }
  | { t: 'kill'; killer: string; victim: string; head: boolean; w: string }
  | { t: 'item'; i: number; ready: boolean; by?: string }
  | { t: 'cat'; i: number; by: string; ms: number; w: string }
  | { t: 'vil'; ids: number[]; by: string; ms: number; w: string; paint: boolean }
  | { t: 'furn'; op: 'put'; f: Piece }
  | { t: 'furn'; op: 'del'; id: number }
  | { t: 'furn'; op: 'all'; list: Piece[]; by: string; reset: boolean }
  /** `x, z`: where near the spawn point, when the server spreads everyone out (a party game's start) */
  | { t: 'respawn'; name: string; spawn: number; x?: number; z?: number; y?: number; fx?: number; fz?: number; drop?: 1; sx?: number; sz?: number }
  | { t: 'round'; winner: string; ms: number }
  | ({ t: 'newround'; text: string } & Coded)
  | { t: 'glass'; i: number; by: string }
  | { t: 'crack'; i: number; x: number; y: number; z: number; by: string }
  /** `quiet`: the server put them back itself (the Zombies game began): no line in the chat */
  | { t: 'repair'; by: string; quiet?: boolean }
  | { t: 'join'; name: string; color: string }
  | { t: 'colors'; list: { name: string; color: string; role: string }[] }
  | { t: 'leave'; name: string }
  | { t: 'horse'; horse: HorseState }
  /**
   * A football (server/football.mjs): `p` where it is and how fast [x, y, z, vx, vy, vz], at the server's time `st`;
   * asleep `s`, in the net `n`, the score `sc`, the kicks since the last state `k` ([who, their count]), back in the middle `r`
   */
  | { t: 'ball'; b: string; st: number; p: number[]; s: number; n: number; sc: number[]; k?: [string, number][]; r?: 1 }
  /** A goal: in goal `g` of ball `b`'s pitch, by who touched it last, and the score */
  | { t: 'ballgoal'; b: string; g: number; by: string; sc: number[] }
  /** Someone got on or off a bike (src/world/bike.ts), or the server's answer to yours */
  | { t: 'bike'; bike: BikeState; knock?: { ms: number; v: number }; home?: boolean }
  /** A rider rang the bell of bike `id` (rung where that bike is drawn) */
  | { t: 'bell'; id: string }
  | { t: 'flag'; ev: 'taken' | 'dropped' | 'returned' | 'captured' | 'safe'; team: 'blue' | 'red'; name: string; why?: 'zone' | 'home' }
  // Steal the flag's bazooka (server/flagBazooka.mjs): to its team, who took it from the rack; to its holder, the rockets left
  | { t: 'fbz'; ev: 'taken'; team: 'blue' | 'red'; name: string; n: number }
  | { t: 'fbz'; ev: 'left'; n: number }
  // Attack and defend (server/assaultSupply.mjs): what a crate gave you (its wait in ms; health after a first-aid kit; your kit), and the turrets' shots at players
  | { t: 'asup'; kind: 'ammo' | 'med' | 'bazooka' | 'sniper' | 'claymore' | 'turret'; ms: number; hp?: number; kit?: { ammo: string[]; scope: boolean; claymores: number; stakes?: number; turrets?: number; armor?: number; nades?: number } }
  | { t: 'afire'; s: [number, string, number][] }
  | { t: 'chat'; from: string; color: string; text: string }
  | { t: 'door'; id: string; open: boolean; dir?: number; by: string }
  | { t: 'weapons'; list: string[] }
  | { t: 'shot'; name: string; x: number; y: number; z: number; w: string; tx?: number; ty?: number; tz?: number }
  | ({ t: 'system'; text: string } & Coded)
  | { t: 'kicked' }
  /** The LAN night host (server/host.mjs): an announcement (`code` nextGame: a countdown to the next game), everyone frozen, the evening's teams */
  | ({ t: 'announce'; text: string; ms: number; count?: boolean } & Coded)
  | { t: 'freeze'; on: boolean; text?: string }
  | { t: 'eveningteams'; count: number; teams: Record<string, string> }
  /** The room asked for isn't there (any more): the connection closes, the page goes back to the open world */
  | { t: 'roomgone' }
  /** The host's Zombies duel (server/duel.mjs): the live line, or null when it is over */
  | { t: 'duel'; duel: DuelView | null };

/** The Zombies duel's live line (server/duel.mjs view): each team's wave, the clock, the winner at the end. */
export interface DuelView {
  kind: 'warmup' | 'final';
  phase: 'playing' | 'done';
  /** ms left: the warm-up's clock, or the result's time on screen (0 in the final while it is played) */
  ms: number;
  sides: { team: 'blue' | 'red'; wave: number; beaten: number; best: number; out: boolean; players: number }[];
  winner?: 'blue' | 'red' | 'draw';
}

/** An answer that wasn't ok: the server's English text, and its code and parameters when it sent them. */
export class ApiError extends Error {
  constructor(message: string, readonly code: unknown, readonly args: unknown, readonly status: number) {
    super(message);
  }
}

/** What went wrong, as a function that gives it in the current language (to draw again when it changes). */
export function errorText(e: unknown): () => string {
  if (e instanceof ApiError) return () => (e.message ? serverText(e.code, e.args, e.message) : t('err.status', { n: e.status }));
  const message = e instanceof Error ? e.message : String(e);
  return () => message;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    // In the split screen, the seat this call speaks for (src/seat.ts): the server answers from that seat's session.
    headers: { ...seatHeaders, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: unknown; code?: unknown; args?: unknown };
  if (!res.ok) throw new ApiError(typeof data.error === 'string' ? data.error : '', data.code, data.args, res.status);
  return data as T;
}

export const api = {
  me: () => call<Me & { online: number; max: number }>('GET', '/api/me'),
  /** `age`: "I'm 13 or older" ticked (src/start.ts); sent only then. */
  join: (name: string, age = false) => call<Me>('POST', '/api/join', age ? { name, age: true } : { name }),
  /** Accounts (server/accounts.mjs, src/ui/account.ts). */
  register: (username: string, email: string, password: string) => call<Me & { kept?: KeptRun }>('POST', '/api/account/register', { username, email, password, age: true }),
  /** Keep this run: the run waiting for this guest session, if any (src/ui/keepRun.ts). */
  keepRun: () => call<{ run: (KeptRun & { kills: number; team: number; ms: number }) | null }>('GET', '/api/account/keep-run'),
  /** Players and the admin alike (the admin with the admin password; the game never asks the two-step code). */
  accountLogin: (username: string, password: string) => call<Me>('POST', '/api/account/login', { username, password }),
  account: () => call<{ username: string; email: string; created: string }>('GET', '/api/account'),
  changePassword: (old: string, password: string) => call<{ ok: boolean }>('POST', '/api/account/password', { old, password }),
  deleteAccount: (password: string) => call<{ ok: boolean }>('POST', '/api/account/delete', { password }),
  /** Logging in with the phone (server/pairing.mjs): a pairing for this screen, and asking how it goes. */
  pairStart: () => call<{ token: string; code: string; check: string; url: string; qr: { size: number; d: string }; ms: number }>('POST', '/api/pair/start', {}),
  /** Every session of this account ends, this one too (Your account: "Log out on every device"). */
  logoutAll: () => call<{ ok: boolean }>('POST', '/api/account/logout-all', {}),
  pairPoll: (token: string) => call<{ state: 'waiting' | 'gone' | 'done'; username?: string; role?: 'player' | 'admin' }>('POST', '/api/pair/poll', { token }),
  /** Zombies rooms (server/rooms.mjs): the list, and opening one (an account or the admin). */
  rooms: () => call<{ rooms: RoomEntry[]; max: number }>('GET', '/api/rooms'),
  openRoom: (place: string) => call<{ room: RoomEntry }>('POST', '/api/rooms', { place }),
  /** The board of best Zombies runs: at one place, or each account's best anywhere (''). */
  scores: (place = '') => call<{ rows: ZombieRun[] }>('GET', `/api/scores${place ? `?place=${encodeURIComponent(place)}` : ''}`),
  /** The boards of the routes, the gnomes and the party games (public); asked only when a board opens. */
  boards: () => call<Boards>('GET', '/api/boards'),
  /** Your own lines on them: playing together with an account or as the admin ({} for a guest). */
  boardsMine: () => call<BoardsMine>('GET', '/api/boards/mine'),
  logout: () => call('POST', '/api/logout', {}),
  players: () => call<{ players: { name: string; color: string; role: string }[]; max: number }>('GET', '/api/players'),
  kick: (name: string) => call('POST', '/api/kick', { name }),
  leaderboard: () => call<{ rows: { username: string; kills: number; deaths: number; headshots: number; wins: number }[] }>('GET', '/api/leaderboard'),
  /** The admin lifts every lockout on joining: kicks, many joins, wrong account passwords (server/auth.mjs). */
  unlock: () => call<{ lifted: number }>('POST', '/api/lockouts', {}),
  audit: () => call<{ log: { time: string; event: string; username?: string; ip?: string; detail?: string }[] }>('GET', '/api/audit'),
  /** Stars (1 to 5) and a comment, either may be left out (src/ui/feedback.ts, server/feedback.mjs). */
  feedback: (b: { stars: number | null; comment: string; name: string; mode: string; lang: string }) => call('POST', '/api/feedback', b),
};

/**
 * The live connection to the shared house. Reconnects after a dropped connection (not after a kick).
 * It asks for the ticks of protocol 2 (shared/wire.mjs), answers the server's pings at once (the
 * server times them and tells the page its last time there and back, `rtt`), and counts what goes
 * through for the diagnostics. No compression on this connection: chat shares it with the game
 * state, and compressing secrets next to text an attacker can choose leaks them (BREACH).
 */
export class Net {
  onMessage: (m: ServerMsg) => void = () => {};
  /** The connection's state, as a function that gives it in the current language ('' when connected). */
  onStatus: (text: () => string) => void = () => {};
  /**
   * The server ended the connection for good (logged in somewhere else, the session ended, removed):
   * no reconnecting. Why, in the current language.
   */
  onEnded: (why: () => string) => void = () => {};
  /** The last time there and back to the server (ms), as the server measured it; null before the first */
  rtt: number | null = null;
  /** Everything received and sent since the page opened: bytes and messages */
  readonly counts = { bytesIn: 0, msgsIn: 0, bytesOut: 0, msgsOut: 0 };
  private ws: WebSocket | null = null;
  private stopped = false;
  /** The server ended this connection for good (4000 to 4002: elsewhere, removed, session ended); cleared by connect() */
  private over = false;
  private retry = 1000;
  /** How many may play, from the server's last 'full' message */
  private fullAt = 0;
  /** A reconnect waiting after a dropped connection (connect and disconnect cancel it) */
  private retryTimer = 0;
  /** The Zombies room to connect to (server/rooms.mjs), or null for the open world */
  room: string | null = null;
  /** The room asked for is gone, or full: the page goes back to the open world (src/ui/rooms.ts). */
  onRoomGone: (why: 'gone' | 'full') => void = () => {};
  /** The last refusal was the host's locked doors (server/host.mjs). */
  private lockedOut = false;

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    this.stopped = false;
    this.over = false;
    // A retry still waiting is replaced by this connection: never two sockets at once (the server would close
    // the first, and the second's welcome would reset the player).
    clearTimeout(this.retryTimer);
    // The room's id is no secret (anyone playing together sees the list) and grants nothing on its own: the session is the cookie.
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?v=${PROTO}&sight=1${this.room ? `&room=${encodeURIComponent(this.room)}` : ''}${watch ? `&watch=1${watch.duel ? `&duel=${watch.duel}` : ''}` : ''}`;
    this.rtt = null;
    // In the split screen, the seat in the subprotocol (src/seat.ts), never in the URL.
    const ws = new WebSocket(url, seatProtocols);
    this.ws = ws;
    this.onStatus(() => t('net.connecting'));
    ws.onopen = () => {
      this.retry = 1000;
      this.onStatus(() => '');
    };
    ws.onmessage = (e) => {
      const text = String(e.data);
      this.counts.bytesIn += text.length;
      this.counts.msgsIn++;
      let m: ServerMsg | { t: 'ping'; n: number; rtt: number | null } | { t: 'full'; max?: unknown } | { t: 'locked' };
      try {
        m = JSON.parse(text);
      } catch {
        return; // ignore malformed messages
      }
      if (m.t === 'ping') {
        this.send({ t: 'pong', n: m.n });
        if (typeof m.rtt === 'number') this.rtt = m.rtt;
        return;
      }
      if (m.t === 'full') {
        // No room in the house: the close that follows says so (see onclose).
        this.fullAt = typeof m.max === 'number' ? m.max : 0;
        return;
      }
      if (m.t === 'locked') {
        // The host locked the doors (server/host.mjs): the close that follows says so, and we try again soon.
        this.lockedOut = true;
        return;
      }
      if (m.t === 'kicked') this.stopped = true;
      if (m.t === 'roomgone') {
        this.room = null; // the close that follows reconnects to the open world (see onclose)
        this.onRoomGone('gone');
        return;
      }
      try {
        this.onMessage(m);
      } catch (err) {
        console.error(err); // one bad message never stops the others
      }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped || e.code === 4000 || e.code === 4001 || e.code === 4002) {
        this.over = true;
        const why = ({ 4000: 'net.elsewhere', 4001: 'net.removed', 4002: 'net.ended' } as const)[e.code as 4000 | 4001 | 4002];
        this.onStatus(() => (why ? t(why) : ''));
        if (!this.stopped && why) this.onEnded(() => t(why));
        return;
      }
      // The room is gone (4004): straight back to the open world.
      if (e.code === 4004) {
        if (watch) watch.duel = ''; // a watch view's duel room closed: the open world (src/watch.ts)
        if (this.room) {
          this.room = null;
          this.onRoomGone('gone');
        }
        this.connect();
        return;
      }
      // Moved by the server into the host's Zombies duel (4006, server/duel.mjs): connect again at once; the server puts this
      // page in its team's room, and the duel's own line says so (not "the room was closed").
      if (e.code === 4006) {
        this.room = null;
        this.connect();
        return;
      }
      // A room full (4003): back to the open world at once, never waiting for a place there.
      if (e.code === 4003 && this.room) {
        this.room = null;
        this.onRoomGone('full');
        this.connect();
        return;
      }
      // The doors locked (4005): said, and tried again every few seconds until the host lets us in.
      if (e.code === 4005 || this.lockedOut) {
        this.lockedOut = false;
        this.onStatus(() => t('net.locked'));
        this.retryTimer = window.setTimeout(() => !this.stopped && this.connect(), 4000);
        return;
      }
      // Full (4003): said, and tried again a little later like a dropped connection, until there is room.
      const max = this.fullAt;
      this.onStatus(() => (e.code === 4003 ? t('net.full', { n: max }) : t('net.lost')));
      this.retryTimer = window.setTimeout(() => !this.stopped && this.connect(), this.retry);
      this.retry = Math.min(15000, this.retry * 2);
    };
  }

  /** Stopped, or ended by the server for good: nothing may connect it again but a new start (a watch view's move, main.ts). */
  get ended(): boolean {
    return this.stopped || this.over;
  }

  disconnect(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
  }

  /** Over to a Zombies room (`id`) or back to the open world (null): this connection ends, a new one starts there. */
  switchTo(id: string | null): void {
    this.room = id;
    const old = this.ws;
    this.ws = null; // its close is then no reason to reconnect (onclose)
    old?.close(1000, 'Moving');
    this.retry = 1000;
    this.connect();
  }

  send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const text = JSON.stringify(msg);
    this.counts.bytesOut += text.length;
    this.counts.msgsOut++;
    this.ws.send(text);
  }
}
