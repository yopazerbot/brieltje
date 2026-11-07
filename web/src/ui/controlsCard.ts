import { onPadLabels } from '../controls/padFamily';
import { onLang, t } from '../i18n';
import { seat } from '../seat';
import { essentials, type Control } from '../shortcuts';

/** Seconds the card stays before it closes by itself: shorter in a seat of the split screen, where the view is small. */
const SHOW_FOR = seat ? 3 : 5;

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
    const refill = () => {
      if (this.open && this.shown) this.fill(this.shown.control, this.shown.action);
    };
    onLang(refill);
    onPadLabels(refill); // another controller: its buttons' names
  }

  show(control: Control, action: boolean, fromMenu = false): void {
    this.fromMenu = fromMenu;
    this.shown = { control, action };
    this.fill(control, action);
    this.root.classList.remove('hidden');
    if (fromMenu) this.root.querySelector<HTMLButtonElement>('#cc-close')!.focus();
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
    const returnFocus = this.fromMenu && this.root.contains(document.activeElement);
    this.root.classList.add('hidden');
    if (returnFocus) document.getElementById('cc-reopen')?.focus({ preventScroll: true });
  }

  private tick(): void {
    this.count.textContent = t('cc.closesIn', { n: this.left });
  }

  /** The rows: what it does, and the key or button for it. Text only (textContent). */
  private fill(control: Control, action: boolean): void {
    let rows = essentials(control, action);
    // A seat of the split screen (src/seat.ts), on starting: only walking, jumping, shooting and the menu.
    if (seat && !this.fromMenu) {
      const keep = new Set([t('ctl.move'), t('cc.jumpFly'), t('cc.shoot'), t('ctl.menu')]);
      rows = rows.filter(([what]) => keep.has(what));
    }
    this.rows.replaceChildren(
      ...rows.flatMap(([what, keys]) => {
        const dt = document.createElement('dt');
        dt.textContent = what;
        const dd = document.createElement('dd');
        dd.textContent = keys;
        return [dt, dd];
      }),
    );
  }
}
