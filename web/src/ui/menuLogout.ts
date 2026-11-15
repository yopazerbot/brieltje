/**
 * Log out from the game (Yoshi, 15 Nov 2026: "Geef mensen mogelijkheid zich af te melden in het menu, wat hen
 * opnieuw naar het startscherm brengt."): a button at the foot of the menu's Together tab, for anyone with a session
 * (an account, or a guest's name). It sits on a page of the menu, not in its header, so the controller reaches it
 * too (src/ui/padNav.ts walks the open page only).
 *
 * Never by accident mid-game: the first press turns it into "Log out? Press again" for four seconds, in place (no
 * card over the game); only a second press in that time logs out. A double click or double tap is one press: the
 * second has to come a moment after the first. What logging out does is src/start.ts's (logOutToStart).
 */
import { onLang, t } from '../i18n';

/** How long the button waits for the second press. */
const SURE_MS = 4000;
/** A second press sooner than this is the same press (a double click, a double tap, a bounce). */
const SAME_PRESS_MS = 400;

export class MenuLogout {
  private sureFrom = 0; // when the first press came (0: not asked)
  private timer = 0;
  private going = false;

  constructor(
    private button: HTMLButtonElement,
    private logOut: () => void,
  ) {
    button.addEventListener('click', () => this.press());
    onLang(() => this.draw());
    this.draw();
  }

  /** Shown only with a session: playing alone without one, there is nothing to log out of. */
  show(on: boolean): void {
    this.button.classList.toggle('hidden', !on);
    if (!on) this.calm();
  }

  private press(): void {
    if (this.going) return;
    const now = performance.now();
    if (!this.sureFrom) {
      this.sureFrom = now;
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.calm(), SURE_MS);
      this.draw();
      return;
    }
    if (now - this.sureFrom < SAME_PRESS_MS) return;
    clearTimeout(this.timer);
    this.going = true;
    this.draw();
    this.logOut();
  }

  /** Back to "Log out": the time ran out, or the session went. */
  private calm(): void {
    clearTimeout(this.timer);
    this.sureFrom = 0;
    this.draw();
  }

  private draw(): void {
    const sure = !!this.sureFrom || this.going;
    this.button.textContent = t(this.going ? 'tog.loggingOut' : sure ? 'tog.logoutSure' : 'start.logout');
    this.button.classList.toggle('sure', sure);
    this.button.disabled = this.going;
  }
}
