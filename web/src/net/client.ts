import type { CarState } from '../world/car';
import type { Piece } from '../world/furnishing';
import { serverText, t } from '../i18n';
import { PROTO, type Tick } from '../../shared/wire.mjs';

/**
 * Talking to the server: login and admin calls (HTTP), and the shared house
 * (WebSocket). The session lives in an HttpOnly cookie the page can't read.
 */

export interface Me {
  username: string;
  /** guest: joined with the shared PIN, no account */
  role: 'admin' | 'guest';
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
  furniture: boolean;
  /** Names above other players (they show through walls) */
  names: boolean;
  /** How many may play at once (the admin chooses, 4 to start with) */
  maxPlayers: number;
  /** New players can join with the shared PIN */
  pin: boolean;
  /** The portals take players from place to place */
  portals: boolean;
  /** Players can travel from the chat (/church); the admin always can */
  travel: boolean;
  /** Child-friendly for everyone: Action plays as Paintball on every page (src/paintball.ts); missing from an older server */
  paintball?: boolean;
}

import type { ModeView } from '../ui/games';
import type { ClownSpec } from '../world/clowns';
import type { Spot } from '../../shared/brutes.mjs';
import type { HorseState } from '../world/horses';

/**
 * A message's text for the page's language: `code` and `args` (src/i18n.ts serverText) next to the
 * English `text`. Unchecked as they arrive: serverText checks both and else shows the text.
 */
type Coded = { code?: unknown; args?: unknown };

export type ServerMsg =
  | {
      /** `proto`: the server's protocol (shared/wire.mjs); a different one means this page is out of date (or the server is) */
      t: 'welcome'; proto?: number; you: string; role: string; color: string; doors: Record<string, boolean>; doorDir?: Record<string, number>; broken: number[];
      players: { name: string; color: string; role: string }[]; scores: Score[]; limit: number; round: { winner: string; ms: number } | null; items: boolean[];
      time: number; cats: number[]; clowns?: ClownSpec[]; furniture: Piece[]; rules?: Rules; cars?: CarState[]; horses?: HorseState[]; mode?: ModeView;
    }
  | { t: 'car'; car: CarState }
  | { t: 'rules'; rules: Rules }
  | ({ t: 'travel'; name: string; to: string; ok: boolean; car?: string | null; text?: string } & Coded)
  /** The start place picked on the start screen was refused (portals off): where the server has you. */
  | { t: 'spawn'; ok: false; x: number; z: number }
  | { t: 'mode'; mode: ModeView }
  | { t: 'clowns'; list: ClownSpec[] }
  /** Twenty times a second: what moved (shared/wire.mjs) */
  | Tick
  | { t: 'rock'; type: 'throw'; id: number; from: Spot; to: Spot; ms: number }
  | { t: 'stomp'; type: 'stomp'; id: number; at: Spot }
  | { t: 'clownhit'; id: number; by: string; ms: number; w: string }
  | { t: 'rocket'; name: string; x: number; y: number; z: number; tx: number; ty: number; tz: number }
  | { t: 'blast'; by: string; x: number; y: number; z: number; w?: string }
  | { t: 'nade'; name: string; x: number; y: number; z: number; vx: number; vy: number; vz: number }
  | { t: 'scores'; list: Score[] }
  | { t: 'hurt'; hp: number; by: string }
  | { t: 'kill'; killer: string; victim: string; head: boolean; w: string }
  | { t: 'item'; i: number; ready: boolean; by?: string }
  | { t: 'cat'; i: number; by: string; ms: number; w: string }
  | { t: 'furn'; op: 'put'; f: Piece }
  | { t: 'furn'; op: 'del'; id: number }
  | { t: 'furn'; op: 'all'; list: Piece[]; by: string; reset: boolean }
  | { t: 'respawn'; name: string; spawn: number }
  | { t: 'round'; winner: string; ms: number }
  | ({ t: 'newround'; text: string } & Coded)
  | { t: 'glass'; i: number; by: string }
  | { t: 'repair'; by: string }
  | { t: 'join'; name: string; color: string }
  | { t: 'colors'; list: { name: string; color: string; role: string }[] }
  | { t: 'leave'; name: string }
  | { t: 'horse'; horse: HorseState }
  | { t: 'chat'; from: string; color: string; text: string }
  | { t: 'door'; id: string; open: boolean; dir?: number; by: string }
  | { t: 'shot'; name: string; x: number; y: number; z: number; w: string }
  | ({ t: 'system'; text: string } & Coded)
  | { t: 'kicked' };

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
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: unknown; code?: unknown; args?: unknown };
  if (!res.ok) throw new ApiError(typeof data.error === 'string' ? data.error : '', data.code, data.args, res.status);
  return data as T;
}

export const api = {
  me: () => call<Me & { online: number; max: number }>('GET', '/api/me'),
  login: (username: string, password: string) => call<Me>('POST', '/api/login', { username, password }),
  /** `age`: "I'm 13 or older" ticked (src/start.ts); sent only then. */
  join: (name: string, pin: string, age = false) => call<Me>('POST', '/api/join', age ? { name, pin, age: true } : { name, pin }),
  logout: () => call('POST', '/api/logout', {}),
  players: () => call<{ players: { name: string; color: string; role: string }[]; max: number }>('GET', '/api/players'),
  kick: (name: string) => call('POST', '/api/kick', { name }),
  leaderboard: () => call<{ rows: { username: string; kills: number; deaths: number; headshots: number; wins: number }[] }>('GET', '/api/leaderboard'),
  pin: () => call<{ pin: string }>('GET', '/api/pin'),
  setPin: (pin: string) => call<{ ok: boolean; loggedOut: number }>('POST', '/api/pin', { pin }),
  /** The admin lifts every lockout on joining: wrong PINs and kicks (server/auth.mjs). */
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
  private retry = 1000;
  /** How many may play, from the server's last 'full' message */
  private fullAt = 0;

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    this.stopped = false;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?v=${PROTO}`;
    this.rtt = null;
    const ws = new WebSocket(url);
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
      let m: ServerMsg | { t: 'ping'; n: number; rtt: number | null } | { t: 'full'; max?: unknown };
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
      if (m.t === 'kicked') this.stopped = true;
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
        const why = ({ 4000: 'net.elsewhere', 4001: 'net.removed', 4002: 'net.ended' } as const)[e.code as 4000 | 4001 | 4002];
        this.onStatus(() => (why ? t(why) : ''));
        if (!this.stopped && why) this.onEnded(() => t(why));
        return;
      }
      // Full (4003): said, and tried again a little later like a dropped connection, until there is room.
      const max = this.fullAt;
      this.onStatus(() => (e.code === 4003 ? t('net.full', { n: max }) : t('net.lost')));
      setTimeout(() => !this.stopped && this.connect(), this.retry);
      this.retry = Math.min(15000, this.retry * 2);
    };
  }

  disconnect(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }

  send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const text = JSON.stringify(msg);
    this.counts.bytesOut += text.length;
    this.counts.msgsOut++;
    this.ws.send(text);
  }
}
