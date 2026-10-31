import type { CarState } from '../world/car';
import type { Piece } from '../world/furnishing';
import { serverText, t } from '../i18n';

/**
 * Talking to the server: login and admin calls (HTTP), and the shared house
 * (WebSocket). The session lives in an HttpOnly cookie the page can't read.
 */

export interface Me {
  username: string;
  /** guest: joined with the shared PIN, no account */
  role: 'admin' | 'guest';
}

export interface RemoteState {
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  armed: boolean;
  flying: boolean;
  alive: boolean;
  /** Just respawned: can't be hurt for a moment */
  safe: boolean;
  /** Weapon in hand */
  w?: string;
  /** Crouching */
  c?: boolean;
  /** Driving the Tesla (then x, z and yaw are the car's) */
  d?: boolean;
  /** Driving: the front wheels' angle */
  s?: number;
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
}

import type { ModeView } from '../ui/games';
import type { BruteView, ClownSpec } from '../world/clowns';
import type { Spot } from '../../shared/brutes.mjs';
import type { HorseState } from '../world/horses';

/**
 * A message's text for the page's language: `code` and `args` (src/i18n.ts serverText) next to the
 * English `text`. Unchecked as they arrive: serverText checks both and else shows the text.
 */
type Coded = { code?: unknown; args?: unknown };

export type ServerMsg =
  | {
      t: 'welcome'; you: string; role: string; color: string; doors: Record<string, boolean>; doorDir?: Record<string, number>; broken: number[];
      players: { name: string; color: string; role: string }[]; scores: Score[]; limit: number; round: { winner: string; ms: number } | null; items: boolean[];
      time: number; cats: number[]; clowns?: ClownSpec[]; furniture: Piece[]; rules?: Rules; cars?: CarState[]; horses?: HorseState[]; mode?: ModeView;
    }
  | { t: 'car'; car: CarState }
  | { t: 'rules'; rules: Rules }
  | ({ t: 'travel'; name: string; to: string; ok: boolean; car?: string | null; text?: string } & Coded)
  | { t: 'mode'; mode: ModeView }
  | { t: 'clowns'; list: ClownSpec[] }
  | { t: 'brutes'; list: BruteView[] }
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
  | { t: 'states'; players: RemoteState[]; cars?: CarState[]; horses?: HorseState[] }
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
  audit: () => call<{ log: { time: string; event: string; username?: string; ip?: string; detail?: string }[] }>('GET', '/api/audit'),
};

/** The live connection to the shared house. Reconnects after a dropped connection (not after a kick). */
export class Net {
  onMessage: (m: ServerMsg) => void = () => {};
  /** The connection's state, as a function that gives it in the current language ('' when connected). */
  onStatus: (text: () => string) => void = () => {};
  private ws: WebSocket | null = null;
  private stopped = false;
  private retry = 1000;

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    this.stopped = false;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    this.onStatus(() => t('net.connecting'));
    ws.onopen = () => {
      this.retry = 1000;
      this.onStatus(() => '');
    };
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(String(e.data)) as ServerMsg;
        if (m.t === 'kicked') this.stopped = true;
        this.onMessage(m);
      } catch {
        // ignore malformed messages
      }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped || e.code === 4000 || e.code === 4001 || e.code === 4002) {
        const why = ({ 4000: 'net.elsewhere', 4001: 'net.removed', 4002: 'net.ended' } as const)[e.code as 4000 | 4001 | 4002];
        this.onStatus(() => (why ? t(why) : ''));
        return;
      }
      this.onStatus(() => t('net.lost'));
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
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
