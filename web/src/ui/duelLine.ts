/**
 * The Zombies duel's live line (server/duel.mjs): one small line under the game's bar, "Blue wave 6 · Red wave 5",
 * on every page in both rooms (Yoshi, 16 Nov 2026: no cards over the game while playing). In the warm-up a team's best
 * wave beside its wave after it started again, and the clock; in the final the team that is out with its mark, and the
 * zombies beaten by the other while it tries to pass it; at the end the winner, for the ten seconds the result shows.
 * Everything in it comes from the server; it goes in with textContent only.
 */
import { t, onLang } from '../i18n';
import type { DuelView } from '../net/client';

const TEAM = { blue: 'eteam.blue', red: 'eteam.red' } as const;

export class DuelLine {
  private el = document.getElementById('duel-line')!;
  private view: DuelView | null = null;
  /** When the server's `ms` runs out, on this page's clock */
  private ends = 0;

  constructor() {
    onLang(() => this.draw());
  }

  /** The server's line, or null: no duel (any more), or a page that just connected somewhere new. */
  set(view: DuelView | null | undefined): void {
    this.view = view ?? null;
    this.ends = performance.now() + (this.view?.ms ?? 0);
    this.draw();
  }

  /** Every frame (the clock): drawn again only when its text changes. */
  update(): void {
    if (this.view) this.draw();
  }

  private draw(): void {
    const v = this.view;
    this.el.classList.toggle('hidden', !v);
    this.el.classList.toggle('done', v?.phase === 'done');
    if (!v) return;
    const someoneOut = v.sides.some((s) => s.out);
    const parts = v.sides.map((s) => {
      const team = t(TEAM[s.team]);
      if (s.out) return t('duel.sideOut', { team, n: s.wave, k: s.beaten });
      if (v.kind === 'final' && someoneOut) return t('duel.sideBeaten', { team, n: s.wave, k: s.beaten });
      if (s.best > s.wave) return t('duel.sideBest', { team, n: s.wave, best: s.best });
      return t('duel.side', { team, n: s.wave });
    });
    if (v.phase === 'done') parts.unshift(v.winner === 'draw' || !v.winner ? t('duel.draw') : t('duel.won', { team: t(TEAM[v.winner]) }));
    else if (v.kind === 'warmup') parts.push(t('duel.left', { time: clock(Math.max(0, this.ends - performance.now())) }));
    const text = parts.join(' · ');
    if (this.el.textContent !== text) this.el.textContent = text;
  }
}

function clock(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
