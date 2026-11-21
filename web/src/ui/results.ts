import { plural, serverText, t } from '../i18n';
import type { ModeView } from './games';
import './results.css';

/**
 * A team game's results moment on a player's page (Yoshi, 21 Nov 2026: "Also think about what can improve in the team
 * versus team, capture the flag"; on a results moment with awards: "Do what u think is best"). Nothing goes over the
 * game while it is played (Yoshi's rule); this shows only once the game is over, for the 20 s the server shows its
 * result (server/awards.mjs RESULTS_MS), then free play: one compact panel at the top, the world visible round it, never
 * taking a click or a touch (it never blocks the menu, leaving or the touch buttons). In it: the winner and how it was
 * decided (the server's end line), your team's score and whether it won, YOUR line (the best thing you did, from the
 * server's counts, also on the losing side and with no award), and the awards' names. In the Zombies rooms, alone, in a
 * watch view or with no team in the game: nothing. Everything the server sends goes in as text only (textContent).
 */

export interface Award {
  id: string;
  name: string;
  team: string | null;
  n: number;
  color: string | null;
}
export interface ResultsView {
  awards: Award[];
  /** Each player's own line: [name, act, n] (server/awards.mjs lineOf) */
  lines: [string, string, number][];
}

/** The mode as the server sends it, with what this panel reads beyond ui/games.ts ModeView: the teams' colours, the results. */
type Shown = ModeView & { colors?: Record<string, string>; results?: ResultsView };

const AWARDS = ['flagsIn', 'furthest', 'saver', 'wall', 'helper', 'tagger', 'streak', 'teamPlayer', 'neverGaveUp'] as const;
type AwardId = (typeof AWARDS)[number];
const LINES = ['captures', 'far', 'returns', 'stops', 'assists', 'guards', 'tags', 'tagged', 'played'] as const;
type LineAct = (typeof LINES)[number];
const COLORS: Record<string, string> = { blue: '#4fa3e0', red: '#e5484d', house: '#4fa3e0', bungalow: '#ff9f43' };
const hex = (c: unknown, d: string) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : d);

/** An award's title and its number, in the page's language (an id the page does not know: null). */
export function awardText(id: string, n: number): { title: string; line: string } | null {
  if (!(AWARDS as readonly string[]).includes(id)) return null;
  const a = id as AwardId;
  return { title: t(`award.${a}` as const), line: plural(n, `award.n.${a}.one` as const, `award.n.${a}.other` as const, { n }) };
}

/** Your own line: the best thing you did (server/awards.mjs lineOf), `team` the name your side plays under. */
export function lineText(act: string, n: number, team: string): string {
  const a: LineAct = (LINES as readonly string[]).includes(act) ? (act as LineAct) : 'played';
  if (a === 'played') return t('res.line.played', { team });
  if (a === 'far') return t('res.line.far', { n });
  return plural(n, `res.line.${a}.one` as const, `res.line.${a}.other` as const, { n });
}

export class ResultsPanel {
  private box = document.createElement('section');
  private head = document.createElement('div');
  private score = document.createElement('div');
  private mine = document.createElement('div');
  private list = document.createElement('ol');
  private foot = document.createElement('div');
  private key = '';
  private ends = 0;
  private view: Shown | null = null;
  private me = '';

  constructor(parent: HTMLElement = document.body) {
    this.box.className = 'res-panel';
    this.box.hidden = true;
    this.box.setAttribute('aria-live', 'polite');
    this.head.className = 'res-head';
    this.score.className = 'res-score';
    this.mine.className = 'res-mine';
    this.list.className = 'res-list';
    this.foot.className = 'res-foot';
    this.box.append(this.head, this.score, this.mine, this.list, this.foot);
    parent.append(this.box);
  }

  /**
   * The mode as the server sent it, `me` your name, `shown`: this page may show it (connected in the open world, not a
   * watch view). Shown when a team game's result shows with its results and you played in it.
   */
  set(view: Shown, me: string, shown: boolean): void {
    const r = view.results;
    const team = view.teams?.[me];
    const on = shown && (view.kind === 'flag' || view.kind === 'teams') && view.phase === 'done' && !!r && Array.isArray(r.awards) && !!team;
    this.view = on ? view : null;
    this.me = me;
    document.body.classList.toggle('results-on', on); // the page's other parts make room (results.css)
    if (!on) {
      this.box.hidden = true;
      this.key = '';
      return;
    }
    this.ends = performance.now() + (view.ms ?? 0);
    this.draw();
  }

  /** Every frame: the seconds to free play; the words again after a change of language (draw by its key). */
  update(): void {
    if (!this.view) return;
    const left = Math.max(0, Math.ceil((this.ends - performance.now()) / 1000));
    const foot = t('res.free', { n: left });
    if (this.foot.textContent !== foot) this.foot.textContent = foot;
    this.draw();
  }

  private draw(): void {
    const v = this.view;
    if (!v) return;
    const r = v.results!;
    const key = JSON.stringify([v.resultCode, v.resultArgs, v.score, r, this.me, t('res.awards')]);
    if (key === this.key) return;
    this.key = key;
    const team = String(v.teams?.[this.me] ?? '');
    const sides = v.kind === 'teams' ? (['house', 'bungalow'] as const) : (['blue', 'red'] as const);
    const shownOf = (s: string) => (v.kind === 'teams' ? v.names?.[s as 'house' | 'bungalow'] ?? s : s);
    const label = (s: string) => {
      const n = shownOf(s);
      return t(n === 'blue' ? 'eteam.blue' : n === 'red' ? 'eteam.red' : n === 'house' ? 'team.house' : 'team.bungalow');
    };
    const colourOf = (s: string) => hex(v.colors?.[s], COLORS[shownOf(s)] ?? '#fbf6ea');
    // The winner: the side named in the server's result (the name it played under), else a draw.
    const args = (v.resultArgs && typeof v.resultArgs === 'object' ? v.resultArgs : {}) as { team?: unknown; side?: unknown };
    const winSide = v.kind === 'teams' ? (typeof args.side === 'string' ? args.side : null) : typeof args.team === 'string' ? args.team : null;
    this.box.style.setProperty('--win', winSide ? colourOf(winSide) : '#f7b928');
    this.box.style.setProperty('--team', colourOf(team));
    this.head.textContent = serverText(v.resultCode, v.resultArgs, v.result ?? '');
    const [a, b] = sides;
    this.score.textContent = `${t('res.score', { ta: label(a), a: v.score?.[a] ?? 0, b: v.score?.[b] ?? 0, tb: label(b) })} · ${t(!winSide ? 'res.draw' : winSide === team ? 'res.won' : 'res.lost')}`;
    // Your own line, the best thing you did (the server's), else thanks for playing.
    const line = r.lines.find((l) => Array.isArray(l) && l[0] === this.me);
    this.mine.textContent = lineText(String(line?.[1] ?? 'played'), Number(line?.[2]) || 0, label(team));
    // The awards' names: a title, the name in its team's colour, the number; yours marked.
    const rows = r.awards.slice(0, 4).flatMap((x) => {
      const w = awardText(String(x.id), Number(x.n) || 0);
      if (!w || typeof x.name !== 'string') return [];
      const li = document.createElement('li');
      if (x.name === this.me) li.className = 'you';
      li.style.setProperty('--c', hex(x.color, COLORS[String(x.team)] ?? '#fbf6ea'));
      const title = document.createElement('span');
      title.className = 'res-title';
      title.textContent = w.title;
      const name = document.createElement('b');
      name.textContent = x.name === this.me ? `${x.name} (${t('res.you')})` : x.name; // a player's name: text, never HTML
      name.dir = 'auto';
      const n = document.createElement('small');
      n.textContent = w.line;
      li.append(title, name, n);
      return [li];
    });
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'none';
      li.textContent = t('res.none');
      rows.push(li);
    }
    this.list.replaceChildren(...rows);
    this.box.hidden = false;
  }
}
