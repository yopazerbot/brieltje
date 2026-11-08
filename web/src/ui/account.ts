/**
 * The account card (Yoshi, 7 Nov 2026; server/accounts.mjs): logging in, making an account, and your own
 * account (a new password, deleting it). One native dialog for the start screen and the menu alike: any
 * button with `data-acct="login"`, `"signup"` or `"account"` opens it at that view. It works before the
 * world exists (src/start.ts makes it), since it is all HTTP.
 *
 * Passwords are typed into real password fields of a form, so a browser's password manager can fill and
 * keep them; they go to the server only, never into storage or the page's text. What the server says goes
 * in with textContent only.
 */
import { t, onLang, type PlainKey } from '../i18n';
import { api, errorText, type Me } from '../net/client';
import { PhonePair } from './phonePair';

type View = 'login' | 'signup' | 'account' | 'password' | 'delete' | 'phone';

const TITLES: Record<View, PlainKey> = {
  login: 'acct.titleLogin', signup: 'acct.titleSignup', account: 'acct.titleAccount', password: 'acct.titlePassword', delete: 'acct.titleDelete',
  phone: 'acct.titlePhone',
};
const GO: Partial<Record<View, PlainKey>> = { login: 'acct.goLogin', signup: 'acct.goSignup', password: 'acct.goPassword', delete: 'acct.goDelete' };

export interface AccountHooks {
  /** Who plays now (null: alone). */
  me: () => Me | null;
  /** The name typed on the start screen or in the menu, to start the form with. */
  typedName: () => string;
  /** "I'm 13 or older" ticked on this device (src/start.ts). */
  ageOk: () => boolean;
  /**
   * A login or sign-up (`signup`: a welcome to say) is on its way: the returned function takes its answer,
   * and says whether it still counts (false when the player left meanwhile: src/start.ts logs it out again).
   */
  begin: (signup: boolean) => (account: Me) => boolean;
  /** The account is gone (deleted): playing alone, with this message. */
  ended: (message: () => string) => void;
}

export class AccountCard {
  private dlg = document.getElementById('acct-dlg') as HTMLDialogElement;
  private form = document.getElementById('acct-form') as HTMLFormElement;
  private name = document.getElementById('acct-name') as HTMLInputElement;
  private email = document.getElementById('acct-email-in') as HTMLInputElement;
  private pass = document.getElementById('acct-pass') as HTMLInputElement;
  private old = document.getElementById('acct-old') as HTMLInputElement;
  private pass2 = document.getElementById('acct-pass2') as HTMLInputElement;
  /** The eyes: every password in the card shown as text (true) or hidden; hidden again whenever the view changes. */
  private reveal = false;
  private msg = document.getElementById('acct-msg')!;
  private go = document.getElementById('acct-go') as HTMLButtonElement;
  private view: View = 'login';
  /** The message under the form, as a function: drawn again in another language. */
  private note: (() => string) | null = null;
  private bad = false;
  private busy = false;
  private mine: { username: string; email: string; created: string } | null = null;
  /** Logging in with the phone (server/pairing.mjs, src/ui/phonePair.ts): this screen's pairing while it waits. */
  private pair = new PhonePair(
    {
      qr: document.getElementById('acct-qr') as unknown as SVGSVGElement,
      url: document.getElementById('acct-pair-url')!,
      code: document.getElementById('acct-pair-code')!,
      check: document.getElementById('acct-pair-check')!,
      state: document.getElementById('acct-pair-state')!,
    },
    {
      live: () => this.view === 'phone',
      done: (username, role) => {
        const finish = this.hooks.begin(false);
        if (finish({ username, role })) this.close();
      },
    },
  );

  constructor(private hooks: AccountHooks) {
    document.querySelectorAll<HTMLButtonElement>('[data-acct]').forEach((b) => b.addEventListener('click', () => this.open(b.dataset.acct as View)));
    this.dlg.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.addEventListener('click', () => this.show(b.dataset.view as View)));
    this.dlg.querySelectorAll<HTMLButtonElement>('[data-go]').forEach((b) => b.addEventListener('click', () => this.show(b.dataset.go as View)));
    document.getElementById('acct-close')!.addEventListener('click', () => this.close());
    document.getElementById('acct-pair-new')!.addEventListener('click', () => void this.pair.start());
    // Every session of this account ends, here too: a screen logged in by mistake is out within a second.
    document.getElementById('acct-out-all')!.addEventListener('click', async () => {
      try {
        await api.logoutAll();
        this.close();
        this.hooks.ended(() => t('acct.outAllDone'));
      } catch (e) {
        this.say(errorText(e));
      }
    });
    this.dlg.addEventListener('close', () => this.pair.stop());
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submit();
    });
    // Keys typed here are the card's: the game's shortcuts (the menu on Escape, walking, chat) never see them.
    for (const type of ['keydown', 'keyup'] as const) this.dlg.addEventListener(type, (e) => e.stopPropagation());
    // A click on the dimmed backdrop closes it, as the ✕ does.
    this.dlg.addEventListener('click', (e) => e.target === this.dlg && this.close());
    for (const input of [this.name, this.email, this.pass, this.pass2, this.old]) input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
    // The eye in a password field shows or hides what is typed, in every password field of the card at once.
    this.dlg.querySelectorAll<HTMLButtonElement>('[data-eye]').forEach((b) => b.addEventListener('click', () => {
      this.reveal = !this.reveal;
      this.draw();
      (b.previousElementSibling as HTMLInputElement | null)?.focus();
    }));
    onLang(() => this.draw());
  }

  /** Open at `view`: logging in or signing up when not logged in to an account, your account when you are. */
  open(view: View): void {
    const me = this.hooks.me();
    if (me?.role === 'player') view = view === 'login' || view === 'signup' || view === 'phone' ? 'account' : view;
    else if (view === 'account' || view === 'password' || view === 'delete') view = 'login';
    if (!this.name.value) this.name.value = this.hooks.typedName();
    this.show(view);
    if (!this.dlg.open) this.dlg.showModal();
    this.firstField()?.focus();
  }

  close(): void {
    this.pass.value = this.pass2.value = this.old.value = ''; // never left lying in the page
    this.reveal = false;
    this.pair.stop();
    if (this.dlg.open) this.dlg.close();
  }

  private show(view: View): void {
    this.view = view;
    this.note = null;
    this.bad = false;
    this.reveal = false;
    this.pass.value = this.pass2.value = this.old.value = '';
    if (view === 'account') void this.loadMine();
    if (view === 'phone') void this.pair.start();
    else this.pair.stop();
    this.draw();
    this.firstField()?.focus();
  }

  private firstField(): HTMLInputElement | null {
    if (this.view === 'login' || this.view === 'signup') return this.name.value ? (this.view === 'signup' ? this.email : this.pass) : this.name;
    if (this.view === 'password' || this.view === 'delete') return this.old;
    return null;
  }

  private async loadMine(): Promise<void> {
    try {
      this.mine = await api.account();
    } catch {
      this.mine = null;
    }
    this.draw();
  }

  /** Every text and which parts show, for the view and the language. */
  private draw(): void {
    const v = this.view;
    this.dlg.querySelectorAll<HTMLElement>('[data-show]').forEach((el) => (el.hidden = !el.dataset.show!.split(' ').includes(v)));
    this.dlg.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.classList.toggle('selected', b.dataset.view === v));
    document.getElementById('acct-title')!.textContent = t(TITLES[v]);
    const go = GO[v];
    if (go) this.go.textContent = this.busy ? t('acct.busy') : t(go);
    this.go.classList.toggle('danger', v === 'delete');
    // The password field: the one you have (logging in), or a new one (signing up, a new password).
    document.getElementById('acct-pass-label')!.textContent = t(v === 'password' ? 'acct.newPass' : 'acct.pass');
    this.pass.autocomplete = v === 'login' ? 'current-password' : 'new-password';
    for (const input of [this.pass, this.pass2, this.old]) input.type = this.reveal ? 'text' : 'password';
    this.dlg.querySelectorAll<HTMLButtonElement>('[data-eye]').forEach((b) => {
      b.setAttribute('aria-pressed', String(this.reveal));
      b.setAttribute('aria-label', t(this.reveal ? 'acct.hidePass' : 'acct.showPass'));
    });
    const me = this.hooks.me();
    document.getElementById('acct-me')!.textContent = t('acct.me', { name: this.mine?.username ?? me?.username ?? '' });
    document.getElementById('acct-email')!.textContent = this.mine ? t('acct.emailIs', { email: this.mine.email }) : '';
    document.getElementById('acct-since')!.textContent = this.mine ? t('acct.since', { date: this.mine.created }) : '';
    this.msg.textContent = this.note?.() ?? '';
    this.msg.classList.toggle('bad', this.bad);
  }

  private say(note: (() => string) | null, bad = true, field?: HTMLInputElement): void {
    this.note = note;
    this.bad = bad;
    if (field) {
      field.setAttribute('aria-invalid', 'true');
      field.focus();
    }
    this.draw();
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    const v = this.view;
    const name = this.name.value.trim();
    // What is missing, said here before anything goes to the server.
    if ((v === 'login' || v === 'signup') && !name) return this.say(() => t('err.nameFirst'), true, this.name);
    if (v === 'signup' && !this.email.value.trim()) return this.say(() => t('err.email'), true, this.email);
    if ((v === 'password' || v === 'delete') && !this.old.value) return this.say(() => t('err.passFirst'), true, this.old);
    if (v !== 'delete' && !this.pass.value) return this.say(() => t('err.passFirst'), true, this.pass);
    // A new password, typed twice: the same both times, or nothing is sent.
    if ((v === 'signup' || v === 'password') && this.pass.value !== this.pass2.value) return this.say(() => t('err.passMatch'), true, this.pass2);
    if (v === 'signup' && !this.hooks.ageOk()) return this.say(() => t('err.age'));
    this.busy = true;
    this.say(null, false);
    try {
      if (v === 'login' || v === 'signup') {
        const finish = this.hooks.begin(v === 'signup');
        const account = v === 'login' ? await api.accountLogin(name, this.pass.value) : await api.register(name, this.email.value.trim(), this.pass.value);
        this.pass.value = this.pass2.value = '';
        if (finish(account)) this.close();
      } else if (v === 'password') {
        await api.changePassword(this.old.value, this.pass.value);
        this.show('account');
        this.say(() => t('acct.saved'), false);
      } else if (v === 'delete') {
        await api.deleteAccount(this.old.value);
        this.close();
        this.hooks.ended(() => t('acct.deleted'));
      }
    } catch (e) {
      const c = String((e as { code?: unknown }).code ?? '');
      const field = v === 'delete' || v === 'password' ? this.old : this.pass;
      this.say(errorText(e), true, /password|login/i.test(c) ? field : undefined);
    } finally {
      this.busy = false;
      this.pass.value = this.pass2.value = this.old.value = '';
      this.draw();
    }
  }
}
