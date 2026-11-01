import { onLang, t } from '../i18n';
import { essentials, type Control } from '../shortcuts';

/** Seconds the card stays before it closes by itself. */
const SHOW_FOR = 5;

/**
 * The most important controls, shown when you start playing (Yoshi, 1 Nov 2026): a small card with
 * the keys for the way you play, and a button "Close now" that counts down from 5 and closes it by
 * itself. The menu's Controls tab opens it again whenever you like. It never stops you playing: you
 * can walk while it shows, and a click or ✕ that closes it does nothing else.
 */
export class ControlsCard {
  open = false;
  /** Opened from the menu: it stays over the menu, and opening the menu doesn't close it. */
  fromMenu = false;
  private root = document.getElementById('controls-card')!;
  private rows = this.root.querySelector<HTMLElement>('#cc-rows')!;
  private count = this.root.querySelector<HTMLElement>('#cc-count')!;
  private left = 0;
  private timer = 0;
  private shown: { control: Control; action: boolean } | null = null;

  constructor() {
    this.root.querySelector('#cc-close')!.addEventListener('click', () => this.close());
    onLang(() => {
      if (this.open && this.shown) this.fill(this.shown.control, this.shown.action);
    });
  }

  show(control: Control, action: boolean, fromMenu = false): void {
    this.fromMenu = fromMenu;
    this.shown = { control, action };
    this.fill(control, action);
    this.root.classList.remove('hidden');
    this.open = true;
    this.left = SHOW_FOR;
    this.tick();
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => {
      this.left -= 1;
      if (this.left <= 0) this.close();
      else this.tick();
    }, 1000);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    window.clearInterval(this.timer);
    this.root.classList.add('hidden');
  }

  private tick(): void {
    this.count.textContent = t('cc.closesIn', { n: this.left });
  }

  /** The rows: what it does, and the key or button for it. Text only (textContent). */
  private fill(control: Control, action: boolean): void {
    this.rows.replaceChildren(
      ...essentials(control, action).flatMap(([what, keys]) => {
        const dt = document.createElement('dt');
        dt.textContent = what;
        const dd = document.createElement('dd');
        dd.textContent = keys;
        return [dt, dd];
      }),
    );
  }
}
