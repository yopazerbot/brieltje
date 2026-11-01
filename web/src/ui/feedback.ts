import { onLang, plural, t } from '../i18n';

const STORE = 'briel.feedback';
/** Seconds of play (menu closed, page in view) before the game asks. */
export const ASK_AFTER = 120;
const STAR = 'M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.5L12 17.3l-5.9 3.2 1.3-6.5L2.5 9.4l6.6-.8z';

/**
 * The feedback card (Yoshi, 1 Nov 2026): after two minutes of play, once in this browser, 1 to 5
 * stars and a comment, both optional. Closing it (×, "No thanks", Esc, or ○ and Options on a
 * controller) means it won't ask again; nor will it after sending. It goes to server/feedback.mjs,
 * which keeps it with the name, the address and the time for the admin page (the privacy policy
 * says so; the card links to it).
 */
export class FeedbackCard {
  open = false;
  /** When it closed (performance.now()): the Esc that closed it must not open the menu too */
  closedAt = -1e9;
  /** Closed or sent; `click`: by a click or tap (the mouse can be captured again then) */
  onClose: (click: boolean) => void = () => {};
  /** Sends the report; rejects when it didn't arrive */
  send: (stars: number | null, comment: string) => Promise<unknown> = async () => {};
  private root = document.getElementById('feedback')!;
  private starBox = this.root.querySelector<HTMLElement>('.fb-stars')!;
  private comment = this.root.querySelector<HTMLTextAreaElement>('#fb-comment')!;
  private sendBtn = this.root.querySelector<HTMLButtonElement>('#fb-send')!;
  private status = this.root.querySelector<HTMLElement>('.fb-status')!;
  private stars: HTMLButtonElement[] = [];
  private chosen = 0;
  private asked = false; // asked before in this browser, or on this page (storage blocked)

  constructor() {
    try {
      this.asked = !!localStorage.getItem(STORE);
    } catch {
      // storage blocked: once per page
    }
    for (let n = 1; n <= 5; n++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fb-star';
      b.setAttribute('role', 'radio');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', STAR);
      svg.append(path);
      b.append(svg);
      b.addEventListener('click', () => this.pick(n));
      b.addEventListener('mouseenter', () => this.paint(n));
      b.addEventListener('mouseleave', () => this.paint(this.chosen));
      this.stars.push(b);
      this.starBox.append(b);
    }
    this.label();
    onLang(() => this.label());
    // Arrow keys move along the stars, as in any group of radio buttons.
    this.starBox.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      this.step(d);
    });
    this.comment.addEventListener('input', () => this.ready());
    this.root.querySelector('#fb-close')!.addEventListener('click', () => this.close(true));
    this.root.querySelector('#fb-later')!.addEventListener('click', () => this.close(true));
    this.sendBtn.addEventListener('click', () => void this.submit(true));
    // Esc closes it, before the game's own Esc (the menu) hears it.
    window.addEventListener('keydown', (e) => {
      if (!this.open || e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      this.close(false);
    }, true);
  }

  /** Not asked before in this browser. */
  get due(): boolean {
    return !this.asked;
  }

  show(): void {
    if (this.open) return;
    this.open = true;
    this.asked = true;
    this.remember('asked'); // a reload doesn't ask again either
    this.chosen = 0;
    this.paint(0);
    this.comment.value = '';
    this.status.textContent = '';
    this.root.classList.remove('sent');
    this.ready();
    if (document.pointerLockElement) document.exitPointerLock();
    this.root.classList.remove('hidden');
    this.stars[0].focus({ preventScroll: true });
  }

  close(click: boolean): void {
    if (!this.open) return;
    this.open = false;
    this.closedAt = performance.now();
    this.root.classList.add('hidden');
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.onClose(click);
  }

  /** A controller's stick or the arrow keys: one star more or less. */
  step(d: number): void {
    this.pick(Math.max(1, Math.min(5, (this.chosen || (d > 0 ? 0 : 6)) + d)));
    this.stars[this.chosen - 1].focus({ preventScroll: true });
  }

  /** Send, if there is something to send (a controller's ✕ comes here too). */
  async submit(click: boolean): Promise<void> {
    if (this.sendBtn.disabled) return;
    this.sendBtn.disabled = true;
    this.status.textContent = '';
    try {
      await this.send(this.chosen || null, this.comment.value.trim());
      this.remember('sent');
      this.root.classList.add('sent');
      this.status.textContent = t('fb.thanks');
      setTimeout(() => this.close(click), 1400);
    } catch {
      this.status.textContent = t('fb.error');
      this.ready();
    }
  }

  private pick(n: number): void {
    this.chosen = n;
    this.paint(n);
    this.ready();
  }

  private paint(n: number): void {
    this.stars.forEach((b, i) => {
      b.classList.toggle('on', i < n);
      b.setAttribute('aria-checked', String(i + 1 === this.chosen));
      b.tabIndex = i + 1 === (this.chosen || 1) ? 0 : -1;
    });
  }

  private label(): void {
    this.stars.forEach((b, i) => b.setAttribute('aria-label', plural(i + 1, 'fb.star.one', 'fb.star.other', { n: i + 1 })));
  }

  private ready(): void {
    this.sendBtn.disabled = !this.chosen && !this.comment.value.trim();
  }

  private remember(v: string): void {
    try {
      localStorage.setItem(STORE, v);
    } catch {
      // storage blocked: `asked` keeps it to once per page
    }
  }
}
