/**
 * The start screen's three steps (Yoshi, 8 Nov 2026: "I first want people to select if they play as guests or if
 * they want to log in. Then they choose solo or multiplayer."):
 *
 * 1. Who are you? Log in right in its card (name, password, the eye), or play as a guest under a name. Making an
 *    account and logging in with the phone open the account card (src/ui/account.ts). With a session already
 *    (its cookie), a welcome back in place of the two cards, with Switch account and Log out.
 * 2. Alone or together? A guest ticks "I'm 13 or older" for Together; an account did at sign-up.
 * 3. The game: Zombies first (Yoshi: "they should be encouraged to pick a specific game mode, for example,
 *    zombie"), then Paintball, Action and Explore; for Zombies where alone, or a room together (to join, or for an
 *    account to open); then the start buttons (src/ui/menu.ts). Zombies is no weapon mode of its own: it plays with
 *    Action's pistol (Paintball's paint guns when that was the mode) and starts its game once play begins
 *    (src/main.ts startIntent). Only rooms' places and sizes show here, never who opened them.
 *
 * Back (or ○ on the controller, src/start.ts) goes one step back. The last visit's choices are remembered in this
 * browser (localStorage briel.start: guest or account, alone or together, the controls; the mode and the place
 * are kept by the menu and src/start.ts), so a returning player goes through with one press per step, or with
 * "Play again as before" in one.
 *
 * What a player or the server typed goes into the page as text only (textContent).
 */
import { onLang, portalName, t } from '../i18n';
import { api, errorText, type Me, type RoomEntry } from '../net/client';
import type { ControlMode, PlayMode } from './menu';

export type Step = 1 | 2 | 3;
type Who = 'guest' | 'account';
type Mp = 'solo' | 'multi';
interface Last {
  who: Who;
  mp: Mp;
  control: ControlMode;
}
const LAST = 'briel.start';
const START_MODE = 'briel.startMode'; // 'zombies', or the weapon mode last picked here
const SOLO_PLACE = 'briel.zombiesPlace'; // shared with the menu's Play tab (src/main.ts)
const ROOM_PLACE = 'briel.roomPlace';
/** What Zombies picked on the start screen starts: alone at a place, a room to join, one to open, or nothing picked yet. */
export type ZombieStart = { kind: 'solo'; place: string } | { kind: 'room'; id: string; place: string } | { kind: 'open'; place: string } | { kind: 'none' };
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null; // storage blocked
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // private window: for this visit
    }
  },
};
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
  /** A new guest joins together (step 2), so step 3 can list the rooms: true once joined (src/start.ts join). */
  join: () => Promise<boolean>;
  /** The weapon mode (src/ui/menu.ts). */
  play: () => PlayMode;
  setPlay: (play: PlayMode) => void;
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
  /** Zombies picked (step 3). */
  private zombiesOn = store.get(START_MODE) === 'zombies';
  /** The Zombies rooms open now (together), and the one picked: an id, 'new' (open one) or none. */
  private rooms: RoomEntry[] = [];
  private roomPick: string | null = null;
  private roomsKey = '';
  private zPlace = $<HTMLSelectElement>('z-place');
  private zOpenPlace = $<HTMLSelectElement>('z-open-place');

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
    // Step 3: Zombies, or a weapon mode (the menu keeps that one); where Zombies is played, remembered.
    for (const [select, key] of [[this.zPlace, SOLO_PLACE], [this.zOpenPlace, ROOM_PLACE]] as const) {
      const kept = store.get(key);
      if (kept && [...select.options].some((o) => o.value === kept)) select.value = kept;
      select.addEventListener('change', () => store.set(key, select.value));
    }
    this.zOpenPlace.addEventListener('change', () => this.pickRoom('new'));
    document.querySelector('#mode-start [data-start-mode=zombies]')!.addEventListener('click', () => this.pickZombies(true));
    document.querySelectorAll<HTMLButtonElement>('#mode-start [data-play]').forEach((b) => b.addEventListener('click', () => {
      store.set(START_MODE, b.dataset.play!);
      this.pickZombies(false);
    }));
    this.armZombies(); // Zombies remembered: never with Explore's weapon off
    $('z-together').addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLButtonElement>('button[data-room]');
      if (b && !b.disabled) this.pickRoom(b.dataset.room!);
    });
    $('z-go-solo').addEventListener('click', () => {
      this.selectMp('solo');
      this.hooks.say(null);
      this.draw();
      this.zPlace.focus();
    });
    $('z-go-world').addEventListener('click', () => {
      store.set(START_MODE, this.hooks.play());
      this.pickZombies(false);
      this.defaultControl()?.focus();
    });
    // While the rooms show: the list every few seconds (who joined, which wave).
    setInterval(() => {
      if (this.step === 3 && this.zombiesOn && this.together() && !this.panel.closest('.hidden')) void this.loadRooms();
    }, 5000);
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
    if (step === 3 && this.zombiesOn && this.together()) void this.loadRooms();
    if (focus) this.defaultControl()?.focus({ preventScroll: true });
    this.panel.scrollTop = 0;
  }

  /** What Zombies starts once play begins, or null when another mode is picked. */
  zombieStart(): ZombieStart | null {
    if (!this.zombiesOn) return null;
    if (!this.together()) return { kind: 'solo', place: this.zPlace.value };
    return this.roomStart();
  }

  /**
   * The same, with the rooms asked for first when none is picked yet: "Play again as before" starts from step 1,
   * where the list never loaded (src/start.ts togetherNow).
   */
  async zombieStartNow(): Promise<ZombieStart | null> {
    const z = this.zombieStart();
    if (z?.kind !== 'none') return z;
    await this.loadRooms();
    return this.zombieStart();
  }

  /** Together: the room picked, the account's own to open, or none yet. */
  private roomStart(): ZombieStart {
    if (this.roomPick === 'new' && this.canOpen()) return { kind: 'open', place: this.zOpenPlace.value };
    const r = this.rooms.find((x) => x.id === this.roomPick && x.players < x.max);
    return r ? { kind: 'room', id: r.id, place: r.place } : { kind: 'none' };
  }

  /** An account or the admin opens rooms (server/rooms.mjs create); a guest joins them. */
  private canOpen(): boolean {
    const s = this.hooks.session();
    return s?.role === 'player' || s?.role === 'admin';
  }

  /**
   * Zombies with a weapon: Action's pistol, or Paintball's paint guns when that was the mode, or while the admin has
   * made the game child-friendly (the menu refuses Action then). Explore, kept from the game's menu, never plays it.
   */
  armZombies(): void {
    if (!this.zombiesOn || this.hooks.play() !== 'explore') return;
    this.hooks.setPlay('action');
    if (this.hooks.play() === 'explore') this.hooks.setPlay('paintball');
  }

  private pickZombies(on: boolean): void {
    this.zombiesOn = on;
    if (on) {
      store.set(START_MODE, 'zombies');
      this.armZombies();
      if (this.together()) void this.loadRooms();
    }
    this.hooks.say(null);
    this.draw();
  }

  private pickRoom(id: string): void {
    this.roomPick = id;
    this.hooks.say(null);
    this.draw();
  }

  /** The rooms open now (it needs a session: an account, or a guest who joined on step 2). */
  private async loadRooms(): Promise<void> {
    try {
      this.rooms = (await api.rooms()).rooms;
    } catch {
      this.rooms = [];
    }
    const open = this.rooms.filter((r) => r.players < r.max);
    if (this.roomPick !== 'new' && !open.some((r) => r.id === this.roomPick)) this.roomPick = this.canOpen() ? 'new' : open[0]?.id ?? null;
    this.draw();
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
    if (multi && !this.hooks.session()) {
      if (!this.hooks.ageOk()) {
        this.hooks.say(() => t('err.age'));
        $('mp-age').focus();
        return;
      }
      // A new guest joins now, so the next step knows the rooms; a refusal says why where it can be fixed.
      this.hooks.say(null);
      void this.hooks.join().then((ok) => ok && this.step === 2 && this.show(3));
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
    // Step 3: Zombies picked or not; where alone; the rooms together.
    const together = this.together();
    $('mode-start').classList.toggle('z', this.zombiesOn);
    document.querySelector('#mode-start [data-start-mode=zombies]')!.classList.toggle('selected', this.zombiesOn);
    $('z-start').classList.toggle('hidden', !this.zombiesOn);
    $('z-solo').classList.toggle('hidden', together);
    $('z-together').classList.toggle('hidden', !together);
    $('spawn').parentElement!.classList.toggle('hidden', this.zombiesOn); // Zombies starts at its own place
    if (this.zombiesOn && together) this.drawRooms();
    // Play again as before: its line from the labels on the page, in the language showing.
    const ok = this.step === 1 && this.againOk();
    $('again').classList.toggle('hidden', !ok);
    if (ok && this.last) {
      const label = (sel: string) => document.querySelector(sel)?.textContent?.trim() ?? '';
      const option = (s: HTMLSelectElement) => s.selectedOptions[0]?.textContent?.trim() ?? '';
      // Zombies together plays at its room's place, never at "Start at": that one once a room is known, else none.
      const room = this.zombiesOn && this.last.mp === 'multi' ? this.roomStart() : null;
      const parts = [
        t(this.last.mp === 'multi' ? 'start.together' : 'start.alone'),
        this.zombiesOn ? t('game.zombies') : label('#mode-start [data-play].selected b'),
        room ? (room.kind === 'none' ? '' : portalName({ id: room.place, name: room.place })) : option(this.zombiesOn ? this.zPlace : $<HTMLSelectElement>('spawn')),
        label(`#choose-${this.last.control} b`),
      ];
      $('again-sub').textContent = parts.filter(Boolean).join(' · ');
    }
  }

  /** The rooms to join (their place and size, never who opened them), opening one for an account, or what else to do. */
  private drawRooms(): void {
    const canOpen = this.canOpen();
    $('z-open').classList.toggle('hidden', !canOpen);
    $('z-open').querySelector('[data-room=new]')!.setAttribute('aria-pressed', String(this.roomPick === 'new'));
    $('z-none').classList.toggle('hidden', canOpen || this.rooms.some((r) => r.players < r.max));
    const key = JSON.stringify([this.rooms, this.roomPick, document.documentElement.lang]);
    if (key === this.roomsKey) return; // the same: the focus stays where it is
    this.roomsKey = key;
    const list = $('z-room-list');
    const hadFocus = list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.room : null;
    list.replaceChildren(...this.rooms.map((r) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'z-room';
      b.dataset.room = r.id;
      const full = r.players >= r.max;
      b.disabled = full;
      b.setAttribute('aria-pressed', String(this.roomPick === r.id));
      const title = document.createElement('b');
      title.textContent = t('zs.roomAt', { place: portalName({ id: r.place, name: r.place }) });
      const sub = document.createElement('span');
      sub.textContent = full ? t('room.full') : `${t('room.players', { n: r.players, max: r.max })} · ${r.playing ? t('room.wave', { n: r.wave }) : t('room.waiting')}`;
      b.append(title, sub);
      return b;
    }));
    if (hadFocus) list.querySelector<HTMLElement>(`[data-room="${CSS.escape(hadFocus)}"]`)?.focus();
  }
}
