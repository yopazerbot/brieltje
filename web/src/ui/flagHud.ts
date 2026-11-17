import { t } from '../i18n';
import { sound } from '../sound';
import { FLAG_COLORS } from '../../shared/flagFields.mjs';

/**
 * Steal the flag on screen (server/flags.mjs decides, src/world/flags.ts draws the flags): the game's bar (the clock, both
 * scores, your team), under it each flag's state (home, carried by whom, on the ground with its seconds to go home), and
 * a short line for each event (taken, dropped, returned, captured) with its sound, made in code. A line in the HUD, never
 * a card over the game (Yoshi dislikes cards while playing). Names go in as text only.
 */

export type FlagTeam = 'blue' | 'red';
export interface FlagState {
  at: 'home' | 'carried' | 'ground';
  /** Who carries it (then no place: the pages draw it on the carrier, where they may see them) */
  by?: string;
  x?: number;
  y?: number;
  z?: number;
  /** On the ground: ms until it goes home by itself */
  ms?: number;
}
/** Steal the flag in a mode's view (server/flags.mjs view). */
export interface FlagGameView {
  field: 'compact' | 'village';
  flags: Record<FlagTeam, FlagState>;
  tags: Record<FlagTeam, number>;
  sudden: boolean;
  /** The sides swapped by the host: blue plays from red's base and red from blue's (shared/flagFields.mjs baseOf) */
  swapped?: boolean;
  /** The field's parked bikes (ids from shared/flagFields.mjs), and the village's own bikes out of play (`off`) */
  vehicles?: { bikes: string[]; off?: string[] };
  /** Each team's bazooka rack (server/flagBazooka.mjs): on it, or out (held, or away with `ms` until it is back) */
  racks?: Record<FlagTeam, { at: 'rack' | 'out'; ms?: number }>;
}
export interface FlagEvent {
  ev: 'taken' | 'dropped' | 'returned' | 'captured' | 'safe' | 'swapped';
  /** 'safe': carried where nobody fights ('zone') or into a private home ('home'), so it went home */
  why?: 'zone' | 'home';
  /** The flag's team */
  team: FlagTeam;
  /** Who did it ('' for a flag home by itself) */
  name: string;
}

const TEAMS: FlagTeam[] = ['blue', 'red'];
const LINE_MS = 4500;
const other = (team: FlagTeam): FlagTeam => (team === 'blue' ? 'red' : 'blue');
const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** A small flag on a pole for the maps (ui/minimap.ts, ui/bigmap.ts), `s` px high, its foot at (x, y). */
export function flagMark(g: CanvasRenderingContext2D, x: number, y: number, s: number, color: string, ring = false): void {
  g.save();
  if (ring) {
    g.beginPath();
    g.arc(x, y - s * 0.45, s * 0.75, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255, 255, 255, 0.85)';
    g.fill();
  }
  g.strokeStyle = 'rgba(20, 20, 30, 0.95)';
  g.lineWidth = Math.max(1.5, s * 0.12);
  g.beginPath();
  g.moveTo(x - s * 0.3, y);
  g.lineTo(x - s * 0.3, y - s);
  g.stroke();
  g.beginPath();
  g.moveTo(x - s * 0.3, y - s);
  g.lineTo(x + s * 0.5, y - s * 0.78);
  g.lineTo(x - s * 0.3, y - s * 0.52);
  g.closePath();
  g.fillStyle = color;
  g.fill();
  g.lineWidth = 1;
  g.stroke();
  g.restore();
}

export class FlagHud {
  private root = document.createElement('div');
  private chips: Record<FlagTeam, HTMLSpanElement>;
  private line = document.createElement('div');
  private lineUntil = 0;
  private key = '';

  /** `after`: the game's bar (#modebar), which this sits under. */
  constructor(after: HTMLElement) {
    this.root.id = 'flaghud';
    this.root.className = 'hidden';
    const row = document.createElement('div');
    row.className = 'flags';
    this.chips = { blue: document.createElement('span'), red: document.createElement('span') };
    for (const team of TEAMS) {
      const chip = this.chips[team];
      chip.className = 'flagchip';
      chip.style.setProperty('--team', FLAG_COLORS[team]);
      row.append(chip);
    }
    this.line.className = 'flagline';
    this.root.append(row, this.line);
    after.after(this.root);
  }

  /** The game's bar (games.ts): its name, the clock, both scores, sudden death, and your team. */
  bar(title: string, left: number, score: Record<string, number> | undefined, v: FlagGameView | undefined, mine: FlagTeam | null): string {
    const s = { blue: score?.blue ?? 0, red: score?.red ?? 0 };
    const parts = [title, clock(left), t('flag.score', { b: s.blue, r: s.red })];
    if (v?.sudden) parts.push(t('flag.sudden'));
    if (mine) parts.push(t('flag.you', { team: t(`eteam.${mine}`) }));
    return parts.join(' · ');
  }

  /**
   * Every frame while Steal the flag is on (`v`, or null to hide): each flag's chip, kept as it is unless something in it
   * changed. `me`: your name (your own carry reads "you").
   */
  update(v: FlagGameView | null, me: string): void {
    const now = performance.now();
    this.root.classList.toggle('hidden', !v);
    this.line.classList.toggle('show', !!v && now < this.lineUntil);
    if (!v) return;
    const key = JSON.stringify([v.flags.blue.at, v.flags.blue.by, Math.ceil((v.flags.blue.ms ?? 0) / 1000), v.flags.red.at, v.flags.red.by, Math.ceil((v.flags.red.ms ?? 0) / 1000), me, t('flag.home', { flag: '' })]);
    if (key === this.key) return;
    this.key = key;
    for (const team of TEAMS) {
      const f = v.flags[team];
      const flag = t(`flag.chip.${team}`);
      this.chips[team].dataset.at = f.at;
      this.chips[team].textContent = f.at === 'home' ? t('flag.home', { flag })
        : f.at === 'carried' ? (f.by === me ? t('flag.carriedYou', { flag }) : t('flag.carried', { flag, name: f.by ?? '' }))
        : t('flag.ground', { flag, n: Math.ceil((f.ms ?? 0) / 1000) });
    }
  }

  /** The ground's countdown, ticking on the page between the server's views (ms since the view came). */
  tickGround(v: FlagGameView | null, dt: number): void {
    if (!v) return;
    for (const team of TEAMS) {
      const f = v.flags[team];
      if (f.at === 'ground' && typeof f.ms === 'number') f.ms = Math.max(0, f.ms - dt * 1000);
    }
  }

  /** An event from the server: its line for a few seconds and its sound. `mine`: your team, for which sound. */
  event(e: FlagEvent, me: string, mine: FlagTeam | null): void {
    if (!TEAMS.includes(e.team)) return;
    if (e.ev === 'swapped') return this.swapped();
    const flag = t(`flag.of.${e.team}`);
    const you = e.name === me;
    const text = e.ev === 'taken' ? (you ? t('flag.takenYou', { flag }) : t('flag.taken', { name: e.name, flag }))
      : e.ev === 'dropped' ? t('flag.dropped', { name: e.name, flag })
      : e.ev === 'returned' ? (e.name ? t('flag.returned', { name: e.name, flag }) : t(`flag.homeAgain.${e.team}`))
      : e.ev === 'safe' ? t(e.why === 'home' ? 'flag.safeHome' : 'flag.safeZone', { name: e.name, flag })
      : t('flag.captured', { name: e.name, flag, team: t(`eteam.${other(e.team)}`) });
    this.line.textContent = text;
    this.line.style.setProperty('--team', FLAG_COLORS[e.ev === 'captured' ? other(e.team) : e.team]);
    this.lineUntil = performance.now() + LINE_MS;
    this.line.classList.add('show');
    // Good news for your team rings bright, bad news low; nobody's team (watching): the bright one.
    const good = !mine || (e.ev === 'taken' || e.ev === 'captured' ? e.team !== mine : e.team === mine);
    this.play(e.ev, good);
  }

  /**
   * Your team's bazooka was taken from its rack (server/flagBazooka.mjs, sent to its team only): a line in the team's
   * colour and a short metallic clack, made in code. `paint`: the child-friendly look's paint cannon. Names as text only.
   */
  bazooka(name: string, me: string, team: FlagTeam, paint: boolean, rockets: number): void {
    const you = name === me;
    this.line.textContent = you ? t(paint ? 'fbz.takenYouPaint' : 'fbz.takenYou', { n: rockets }) : t(paint ? 'fbz.takenPaint' : 'fbz.taken', { name });
    this.line.style.setProperty('--team', FLAG_COLORS[team]);
    this.lineUntil = performance.now() + LINE_MS;
    this.line.classList.add('show');
    const ctx = sound.context();
    const out = sound.out();
    if (!ctx || !out) return;
    // Two dry clicks and a low thump: a launcher lifted off its rack and shouldered.
    const t0 = ctx.currentTime;
    for (const [f, at, len, type] of [[1400, 0, 0.04, 'square'], [900, 0.07, 0.04, 'square'], [130, 0.12, 0.22, 'triangle']] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f, t0 + at);
      o.frequency.exponentialRampToValueAtTime(f * 0.6, t0 + at + len);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0 + at);
      g.gain.exponentialRampToValueAtTime(type === 'square' ? 0.08 : 0.25, t0 + at + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
      o.connect(g).connect(out);
      o.start(t0 + at);
      o.stop(t0 + at + len + 0.03);
    }
  }

  /**
   * The host swapped the sides (server/flags.mjs swap): one short line on every screen and a sound made in code, two
   * sweeps crossing (one up, one down), as the bases trade.
   */
  private swapped(): void {
    this.line.textContent = t('flag.swapped');
    this.line.style.setProperty('--team', '#ffffff');
    this.lineUntil = performance.now() + LINE_MS;
    this.line.classList.add('show');
    const ctx = sound.context();
    const out = sound.out();
    if (!ctx || !out) return;
    const t0 = ctx.currentTime;
    for (const [from, to] of [[392, 784], [784, 392]] as const) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(from, t0);
      o.frequency.exponentialRampToValueAtTime(to, t0 + 0.45);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.14, t0 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
      o.connect(g).connect(out);
      o.start(t0);
      o.stop(t0 + 0.55);
    }
  }

  /** The event's sound, in code: a rising call when taken, a falling one when dropped, a chime home, a fanfare for a capture. */
  private play(ev: FlagEvent['ev'], good: boolean): void {
    const ctx = sound.context();
    const out = sound.out();
    if (!ctx || !out) return;
    const t0 = ctx.currentTime;
    const base = good ? 523.25 : 392; // C5 or G4
    const notes: [number, number, number][] = ev === 'taken' ? [[base, 0, 0.12], [base * 1.5, 0.12, 0.2]]
      : ev === 'dropped' ? [[base * 1.2, 0, 0.12], [base * 0.8, 0.12, 0.22]]
      : ev === 'returned' || ev === 'safe' ? [[base, 0, 0.1], [base * 1.25, 0.09, 0.1], [base * 1.5, 0.18, 0.25]]
      : [[base, 0, 0.12], [base * 1.25, 0.12, 0.12], [base * 1.5, 0.24, 0.12], [base * 2, 0.36, 0.45]];
    for (const [f, at, len] of notes) {
      const o = ctx.createOscillator();
      o.type = ev === 'captured' ? 'square' : 'triangle';
      o.frequency.setValueAtTime(f, t0 + at);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0 + at);
      g.gain.exponentialRampToValueAtTime(ev === 'captured' ? 0.12 : 0.2, t0 + at + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
      o.connect(g).connect(out);
      o.start(t0 + at);
      o.stop(t0 + at + len + 0.03);
    }
  }
}
