/**
 * The controller in the pause menu (Yoshi, 7 Nov 2026: "de menu settings moeten allemaal bereikbaar zijn met een
 * controller"): the D-pad or the left stick moves the focus to the nearest control that way on the open page,
 * ✕ (A) presses it, and left and right change a slider or a drop-down list in place. Every control of the menu is
 * a button, a tick box, a slider, a list or a link already, so the menu needs nothing of its own for it.
 *
 * The focus shows as the lamplight ring (`.pad-focus`, src/style.css), and the page scrolls to keep it in view.
 */

const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';

/** Shown, enabled and not inside anything hidden. */
function usable(el: HTMLElement): boolean {
  if ((el as HTMLButtonElement).disabled || el.closest('[hidden], .hidden')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}

export class PadNav {
  private current: HTMLElement | null = null;

  /** `page`: the menu's page showing now (null when there is none, as on the start screen). */
  constructor(private page: () => HTMLElement | null) {}

  /** The control with the focus, if it is still on the page showing. */
  focused(): HTMLElement | null {
    const page = this.page();
    if (!this.current || !page || !page.contains(this.current) || !usable(this.current)) return null;
    return this.current;
  }

  /** Forget the focus (the menu closed, or another tab). */
  reset(): void {
    this.current?.classList.remove('pad-focus');
    this.current = null;
  }

  private set(el: HTMLElement): void {
    this.current?.classList.remove('pad-focus');
    this.current = el;
    el.classList.add('pad-focus');
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /**
   * One step (dx, dy: -1, 0 or 1). Down and up go to the next and the previous control in the page's order, so
   * every control is reached, a column at a time on a page in columns. Left and right go to the nearest control
   * on the same row (the weather's buttons, the modes). Without a focus yet, the first control of the page.
   */
  step(dx: number, dy: number): void {
    const page = this.page();
    if (!page) return;
    const all = [...page.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(usable);
    if (!all.length) return;
    const from = this.focused();
    if (!from) return this.set(all[0]);
    if (dy) {
      const i = all.indexOf(from) + dy;
      if (i >= 0 && i < all.length) this.set(all[i]);
      return;
    }
    const a = from.getBoundingClientRect();
    const ay = a.top + a.height / 2;
    let best: HTMLElement | null = null;
    let bestGap = Infinity;
    for (const el of all) {
      if (el === from) continue;
      const b = el.getBoundingClientRect();
      if (b.bottom <= ay || b.top >= ay) continue; // not on this row
      const gap = dx > 0 ? b.left - a.right : a.left - b.right;
      if (gap > -2 && gap < bestGap) [best, bestGap] = [el, gap];
    }
    if (best) this.set(best);
  }

  /** Left or right on a slider or a list: its value one step that way. True when the focused control took it. */
  adjust(dx: number): boolean {
    const el = this.focused();
    if (el instanceof HTMLInputElement && el.type === 'range') {
      if (dx > 0) el.stepUp();
      else el.stepDown();
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (el instanceof HTMLSelectElement) {
      const i = Math.min(el.options.length - 1, Math.max(0, el.selectedIndex + dx));
      if (i !== el.selectedIndex) {
        el.selectedIndex = i;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    }
    return false;
  }

  /** ✕ (A): press the focused control. True when there was one. */
  press(): boolean {
    const el = this.focused();
    if (!el) return false;
    if (el instanceof HTMLInputElement && (el.type === 'range' || el.type === 'text' || el.type === 'password')) {
      el.focus(); // a field: typing (the console's keyboard opens on focus); a slider: left and right
      return true;
    }
    if (el instanceof HTMLSelectElement) return this.adjust(1);
    el.click(); // buttons, tick boxes, links
    return true;
  }
}
