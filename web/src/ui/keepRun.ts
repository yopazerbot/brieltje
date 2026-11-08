/**
 * Keep this run (Yoshi, 8 Nov 2026; server/keepRun.mjs): a guest's good Zombies run waits on the server for an
 * account made from this same session. While it waits, the end screen says so and the menu's Together tab offers
 * "Make an account" (the account card, src/ui/account.ts); signing up takes the run onto the board.
 *
 * No countdown and no nagging: one line on the end screen, one quiet box in the Together tab, gone once the run
 * is kept, the session ends, or its time is up. What is shown comes from the server, as text only.
 */
import { onLang, portalName, t } from '../i18n';
import { api, type KeptRun } from '../net/client';

export class KeepRun {
  private run: KeptRun | null = null;
  private timer = 0;
  private box = document.getElementById('keep-run')!;

  /** `guest`: this browser plays as a guest now (only a guest's session has a run to keep). */
  constructor(private guest: () => boolean) {
    onLang(() => this.draw());
  }

  /** A run waits for this session. */
  get waiting(): boolean {
    return !!this.run;
  }

  /** Ask the server whether a run waits for this session (after a Zombies game ends). */
  async check(): Promise<boolean> {
    if (!this.guest()) {
      this.clear();
      return false;
    }
    try {
      const { run } = await api.keepRun();
      clearTimeout(this.timer);
      this.run = run && this.guest() ? { place: run.place, wave: run.wave } : null;
      if (run) this.timer = window.setTimeout(() => this.clear(), Math.max(0, run.ms));
    } catch {
      // out of reach: nothing offered
    }
    this.draw();
    return this.waiting;
  }

  /** Kept, the session ended, or not a guest any more: nothing waits. */
  clear(): void {
    clearTimeout(this.timer);
    this.run = null;
    this.draw();
  }

  private draw(): void {
    const r = this.run;
    this.box.classList.toggle('hidden', !r);
    if (r) document.getElementById('keep-line')!.textContent = t('keep.line', { n: r.wave, place: portalName({ id: r.place, name: r.place }) });
  }
}
