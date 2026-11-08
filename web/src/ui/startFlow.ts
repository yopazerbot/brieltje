/**
 * The start screen's three steps (Yoshi, 8 Nov 2026: "I first want people to select if they play as guests or if
 * they want to log in. Then they choose solo or multiplayer."):
 *
 * 1. Who are you? Log in right in its card (name, password, the eye), or play as a guest under a name. Making an
 *    account and logging in with the phone open the account card (src/ui/account.ts). With a session already
 *    (its cookie), a welcome back in place of the two cards, with Switch account and Log out.
 * 2. Alone or together? A guest ticks "I'm 13 or older" for Together; an account did at sign-up.
 * 3. The game mode, where to start, and the start buttons (src/ui/menu.ts).
 *
 * Back (or ○ on the controller, src/start.ts) goes one step back. The last visit's choices are remembered in this
 * browser (localStorage briel.start: guest or account, alone or together, the controls; the mode and the place
 * are kept by the menu and src/start.ts), so a returning player goes through with one press per step, or with
 * "Play again as before" in one.
 *
 * What a player or the server typed goes into the page as text only (textContent).
 */
import { onLang, t } from '../i18n';
import { api, errorText, type Me } from '../net/client';
import type { ControlMode } from './menu';

export type Step = 1 | 2 | 3;
type Who = 'guest' | 'account';
type Mp = 'solo' | 'multi';
interface Last {
  who: Who;
  mp: Mp;
  control: ControlMode;
}
const LAST = 'briel.start';
const CONTROLS: ControlMode[] = ['kbm', 'pad', 'touch'];

export interface FlowHooks {
  /** Who the server knows this browser as (the session cookie), alone too; null without one. */
  session: () => Me | null;
  /** A login on its way: the returned function takes its answer, and says whether it still counts (src/start.ts). */
  begin: () => (account: Me) => boolean;
  /** Log out: the session ends (src/start.ts leave). */
  logout: () => void;
  /** "I'm 13 or older" ticked on this device. */
  ageOk: () => boolean;
  /** Press a start button: play with these controls (src/ui/menu.ts begin). */
  start: (mode: ControlMode) => void;
  /** The message under the steps, or none. */
  say: (text: (() => string) | null) => void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
/** On a touch screen a focused field opens the keyboard: the focus goes to buttons only there. */
const coarse = () => matchMedia('(pointer: coarse)').matches;

function loadLast(): Last | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST) ?? 'null') as Partial<Last> | null;
    if (v && (v.who === 'guest' || v.who === 'account') && (v.mp === 'solo' || v.mp === 'multi') && CONTROLS.includes(v.control as ControlMode)) return v as Last;
  } catch {
    // storage blocked or an old value: nothing remembered
  }
  return null;
}

export class StartFlow {
  step: Step = 1;
  private panel = $('start-panel');
  private sections = [...this.panel.querySelectorAll<HTMLElement>('.step')];
  private back = $<HTMLButtonElement>('step-back');
  private nick = $<HTMLInputElement>('nick');
  private loginForm = $<HTMLFormElement>('login-card');
  private loginName = $<HTMLInputElement>('login-name');
  private loginPass = $<HTMLInputElement>('login-pass');
  private loginGo = $<HTMLButtonElement>('login-go');
  private loginMsg = $('login-msg');
  private loginNote: (() => string) | null = null;
  private busy = false;
  private reveal = false;
  private last = loadLast();

  constructor(private hooks: FlowHooks) {
    this.back.addEventListener('click', () => this.goBack());
    // Step 1: a guest goes on with a name; a login is checked here; the welcome back goes on, or ends the session.
    $('guest-go').addEventListener('click', () => this.asGuest());
    this.nick.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      this.asGuest();
    });
    this.loginForm.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.login();
    });
    for (const input of [this.loginName, this.loginPass]) {
      input.addEventListener('input', () => {
        input.removeAttribute('aria-invalid');
        if (this.loginNote) {
          this.loginNote = null;
          this.draw();
        }
      });
    }
    $('login-eye').addEventListener('click', () => {
      this.reveal = !this.reveal;
      this.draw();
      this.loginPass.focus();
    });
    $('welcome-go').addEventListener('click', () => this.show(2));
    $('welcome-switch').addEventListener('click', () => {
      this.hooks.logout();
      if (!coarse()) this.loginName.focus();
    });
    // Step 2: a card is the choice and goes on at once.
    document.querySelectorAll<HTMLButtonElement>('#mp-choice [data-mp]').forEach((b) => b.addEventListener('click', () => this.pickMp(b)));
    $<HTMLInputElement>('mp-age').addEventListener('change', () => this.hooks.say(null));
    $('again').addEventListener('click', () => this.again());
    // A narrow screen shows one who card at a time: the remembered one, else logging in.
    document.querySelectorAll<HTMLButtonElement>('.who-switch [data-who]').forEach((b) => b.addEventListener('click', () => this.showCard(b.dataset.who as 'login' | 'guest')));
    this.showCard(this.last?.who === 'guest' ? 'guest' : 'login');
    // Remembered: alone or together, picked before anything is pressed.
    if (this.last) this.selectMp(this.last.mp);
    onLang(() => this.draw());
    this.show(1, false);
  }

  /** The step showing now: what the controller walks (src/ui/padNav.ts). */
  page(): HTMLElement {
    return this.sections[this.step - 1];
  }

  /** Together picked (step 2). */
  together(): boolean {
    return !!document.querySelector('#mp-choice [data-mp=multi].selected');
  }

  /** Show `step`; the focus goes to its likely next press (the remembered choice), unless `focus` is false. */
  show(step: Step, focus = true): void {
    const forward = step > this.step;
    this.step = step;
    for (const s of this.sections) {
      const on = Number(s.dataset.step) === step;
      s.classList.toggle('hidden', !on);
      s.classList.remove('enter-fwd', 'enter-back');
      if (on && focus) {
        void s.offsetWidth; // the animation again from the start
        s.classList.add(forward ? 'enter-fwd' : 'enter-back');
      }
    }
    this.panel.dataset.step = String(step);
    this.back.hidden = step === 1;
    this.panel.querySelectorAll<HTMLElement>('.step-dots [data-dot]').forEach((d) => {
      const n = Number(d.dataset.dot);
      d.classList.toggle('on', n === step);
      d.classList.toggle('done', n < step);
      if (n === step) d.setAttribute('aria-current', 'step');
      else d.removeAttribute('aria-current');
    });
    this.draw();
    if (focus) this.defaultControl()?.focus({ preventScroll: true });
    this.panel.scrollTop = 0;
  }

  goBack(): void {
    if (this.step > 1) {
      this.hooks.say(null);
      this.show((this.step - 1) as Step);
    }
  }

  /**
   * The control a step's next press most likely is: the remembered choice, or the first to fill in. `pad`: asked
   * for the controller, whose start button is then the Controller one.
   */
  defaultControl(pad = false): HTMLElement | null {
    const session = this.hooks.session();
    if (this.step === 1) {
      if (session) return $('welcome-go');
      if (this.last?.who === 'account') return coarse() ? $('login-go') : this.loginName.value ? this.loginPass : this.loginName;
      if (this.nick.value.trim()) return $('guest-go');
      return coarse() ? $('guest-go') : this.nick;
    }
    if (this.step === 2) return document.querySelector<HTMLElement>('#mp-choice [data-mp].selected') ?? document.querySelector<HTMLElement>('#mp-choice [data-mp=solo]');
    if (pad) return $('choose-pad');
    const remembered = this.last && $(`choose-${this.last.control}`);
    if (remembered && !remembered.classList.contains('hidden')) return remembered;
    return document.querySelector<HTMLElement>('.start-choices .choice.play:not(.hidden)');
  }

  /** The session changed (logged in, out, or found on arrival): step 1 and step 2 follow. */
  sessionChanged(fromLogin = false): void {
    const s = this.hooks.session();
    if (!s && this.step > 1) this.show(1, false);
    this.draw();
    if (s && fromLogin) this.show(2);
  }

  /** Remember this visit's choices for the next one (the world began to load with `control`). */
  remember(control: ControlMode): void {
    const s = this.hooks.session();
    this.last = { who: s && s.role !== 'guest' ? 'account' : 'guest', mp: this.together() ? 'multi' : 'solo', control };
    try {
      localStorage.setItem(LAST, JSON.stringify(this.last));
    } catch {
      // private window: for this visit
    }
  }

  /** The guest's name typed: on to step 2, or the field asks for it. */
  private asGuest(): void {
    if (!this.nick.value.trim()) {
      this.hooks.say(() => t('err.nameFirst'));
      this.nick.setAttribute('aria-invalid', 'true');
      this.nick.focus();
      return;
    }
    this.hooks.say(null);
    this.show(2);
  }

  /** Log in from the card: the same call and checks as the account card's (src/ui/account.ts). */
  private async login(): Promise<void> {
    if (this.busy) return;
    const name = this.loginName.value.trim();
    const ask = (text: () => string, field: HTMLInputElement) => {
      this.loginNote = text;
      field.setAttribute('aria-invalid', 'true');
      field.focus();
      this.draw();
    };
    if (!name) return ask(() => t('err.nameFirst'), this.loginName);
    if (!this.loginPass.value) return ask(() => t('err.passFirst'), this.loginPass);
    this.busy = true;
    this.loginNote = null;
    this.draw();
    let wrong = false;
    try {
      const finish = this.hooks.begin();
      const account = await api.accountLogin(name, this.loginPass.value);
      this.loginPass.value = '';
      finish(account);
    } catch (e) {
      this.loginNote = errorText(e);
      wrong = /password|login/i.test(String((e as { code?: unknown }).code ?? ''));
      if (wrong) this.loginPass.setAttribute('aria-invalid', 'true');
    } finally {
      this.busy = false;
      this.loginPass.value = ''; // never left lying in the page
      this.reveal = false;
      this.draw();
      if (wrong) this.loginPass.focus();
    }
  }

  /** Which who card shows on a narrow screen (both show where there is room). */
  showCard(which: 'login' | 'guest'): void {
    $('who-cards').dataset.show = which;
    document.querySelectorAll('.who-switch [data-who]').forEach((b) => b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.who === which)));
  }

  private selectMp(mp: Mp): void {
    document.querySelectorAll('#mp-choice [data-mp]').forEach((o) => o.classList.toggle('selected', (o as HTMLElement).dataset.mp === mp));
  }

  /** Alone or together picked: on to the game. A new guest ticks the age box for Together first. */
  private pickMp(b: HTMLButtonElement): void {
    const multi = b.dataset.mp === 'multi';
    this.selectMp(multi ? 'multi' : 'solo');
    if (multi && !this.hooks.session() && !this.hooks.ageOk()) {
      this.hooks.say(() => t('err.age'));
      $('mp-age').focus();
      return;
    }
    this.hooks.say(null);
    this.show(3);
  }

  /** "Play again as before" can go: the same who as now, and the age tick for a guest together. */
  private againOk(): boolean {
    const l = this.last;
    const s = this.hooks.session();
    if (!l) return false;
    const who: Who | null = s ? (s.role === 'guest' ? 'guest' : 'account') : this.nick.value.trim() ? 'guest' : null;
    // An account can do whatever its guest did (signed up since): the same choices under the account.
    if ((who !== l.who && !(who === 'account' && l.who === 'guest')) || (l.mp === 'multi' && !s && !this.hooks.ageOk())) return false;
    return !$(`choose-${l.control}`).classList.contains('hidden');
  }

  private again(): void {
    if (!this.last || !this.againOk()) return;
    this.selectMp(this.last.mp);
    this.hooks.start(this.last.control);
  }

  /** Every text and which parts show, for the session and the language. */
  draw(): void {
    const s = this.hooks.session();
    $('who-cards').classList.toggle('hidden', !!s);
    $('welcome-card').classList.toggle('hidden', !s);
    if (s) {
      $('welcome-name').textContent = s.username; // a player's name: text, never HTML
      $('welcome-note').textContent = t(s.role === 'guest' ? 'start.welcomeGuest' : s.role === 'admin' ? 'start.welcomeAdmin' : 'start.welcomeAcct');
      $('welcome-go').textContent = t('start.goOn', { name: s.username });
      $('welcome-switch').classList.toggle('hidden', s.role === 'guest');
      $('mp-logout').textContent = t(s.role === 'guest' ? 'start.notYou' : 'start.logout');
    }
    // Step 2: what Together gives an account; the age tick for a new guest only.
    $('together-sub').textContent = t(s && s.role !== 'guest' ? 'start.togetherRoom' : 'start.togetherSub');
    $('mp-age-row').classList.toggle('hidden', !!s);
    // The login card.
    this.loginGo.textContent = this.busy ? t('acct.busy') : t('acct.goLogin');
    this.loginGo.disabled = this.busy;
    this.loginPass.type = this.reveal ? 'text' : 'password';
    const eye = $('login-eye');
    eye.setAttribute('aria-pressed', String(this.reveal));
    eye.setAttribute('aria-label', t(this.reveal ? 'acct.hidePass' : 'acct.showPass'));
    this.loginMsg.textContent = this.loginNote?.() ?? '';
    this.loginMsg.classList.toggle('bad', !!this.loginNote);
    // Play again as before: its line from the labels on the page, in the language showing.
    const ok = this.step === 1 && this.againOk();
    $('again').classList.toggle('hidden', !ok);
    if (ok && this.last) {
      const label = (sel: string) => document.querySelector(sel)?.textContent?.trim() ?? '';
      const spawn = $<HTMLSelectElement>('spawn');
      const parts = [
        t(this.last.mp === 'multi' ? 'start.together' : 'start.alone'),
        label('#mode-start .seg-btn.selected b'),
        spawn.selectedOptions[0]?.textContent?.trim() ?? '',
        label(`#choose-${this.last.control} b`),
      ];
      $('again-sub').textContent = parts.filter(Boolean).join(' · ');
    }
  }
}
