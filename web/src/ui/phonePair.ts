/**
 * Logging in with the phone (server/pairing.mjs), on this screen: a QR code and a short code, the 2-digit number the
 * phone asks for, then asking every two seconds how it goes. The account card (src/ui/account.ts) shows one, and so
 * does the start screen's login card for a player with a controller (src/ui/padStart.ts), each in its own elements.
 *
 * The pairing's secret (`token`) stays in this page's memory only and goes to the server only to ask how it goes. The
 * check number is shown here only, never in the link or the QR code. What the server sends goes in as text or as the
 * QR code's path data, never as HTML.
 */
import { onLang, t } from '../i18n';
import { api, errorText } from '../net/client';

const POLL_MS = 2000;

export interface PairElements {
  /** The QR code: an svg with one path; its parent is hidden when the code is no use any more. */
  qr: SVGSVGElement;
  /** "Or go to … and type", and the code after it. */
  url: HTMLElement;
  code: HTMLElement;
  /** The 2-digit number the phone asks for. */
  check: HTMLElement;
  /** How it goes: waiting, expired, or what went wrong. */
  state: HTMLElement;
}

export interface PairHooks {
  /** The phone said yes: this screen's session cookie is set, as `username`. */
  done: (username: string) => void;
  /** Still wanted once the server answers the start (the card or the step still showing). */
  live: () => boolean;
}

export class PhonePair {
  private pair: { token: string; until: number; timer: number } | null = null;
  private polling = false;
  private note: (() => string) | null = null;
  private where = '';

  constructor(private el: PairElements, private hooks: PairHooks) {
    onLang(() => this.draw());
  }

  /** Waiting for the phone now. */
  get active(): boolean {
    return !!this.pair;
  }

  /** A new pairing for this screen: its QR code and short code, then asking every two seconds how it goes. */
  async start(): Promise<void> {
    this.stop();
    this.note = () => t('acct.busy');
    this.draw();
    try {
      const p = await api.pairStart();
      if (!this.hooks.live()) return;
      this.el.qr.setAttribute('viewBox', `0 0 ${p.qr.size} ${p.qr.size}`);
      this.el.qr.querySelector('path')!.setAttribute('d', p.qr.d);
      this.el.qr.parentElement!.hidden = false;
      this.where = p.url.replace(/^https?:\/\//, '').replace(/#.*$/, '');
      this.el.code.textContent = p.code;
      this.el.check.textContent = p.check; // shown here only, never in the link
      this.stop(); // a second start while this one was on its way: only the newest is kept
      this.pair = { token: p.token, until: Date.now() + p.ms, timer: window.setInterval(() => void this.poll(), POLL_MS) };
      this.note = () => t('acct.phoneWait');
    } catch (e) {
      this.note = errorText(e);
    }
    this.draw();
  }

  stop(): void {
    if (this.pair) clearInterval(this.pair.timer);
    this.pair = null;
  }

  private async poll(): Promise<void> {
    const pair = this.pair;
    if (!pair || this.polling) return;
    this.polling = true;
    try {
      const r = await api.pairPoll(pair.token);
      // Done: the cookie is set, so this screen is logged in, even when the card closed meanwhile.
      if (r.state === 'done' && r.username) {
        if (this.pair === pair) this.stop();
        this.hooks.done(r.username);
        return;
      }
      if (this.pair !== pair) return;
      if (r.state === 'gone' || Date.now() > pair.until) {
        this.stop();
        this.el.qr.parentElement!.hidden = true; // an old code is no use
        this.where = '';
        this.el.code.textContent = '';
        this.el.check.textContent = '';
        this.note = () => t('acct.phoneGone');
        this.draw();
      }
    } catch {
      // out of reach for a moment: asked again in two seconds
    } finally {
      this.polling = false;
    }
  }

  private draw(): void {
    this.el.url.textContent = this.where ? t('acct.phoneOr', { url: this.where }) : '';
    this.el.state.textContent = this.note?.() ?? '';
  }
}
