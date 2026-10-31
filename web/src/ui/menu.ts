/**
 * Start screen and in-game menu. The start screen: your name, alone or together, Explore or
 * Action, and a start button per way of playing. It works before the world exists: the first
 * start loads the world, with its progress on the chosen button, and play begins by itself once
 * it is ready. The menu: a rail of tabs for the map, playing, playing together, the settings, the
 * controls and (for the admin) the admin's tools; M opens it on the map. Choices, and the tab you
 * left it on, are remembered in this browser.
 */

import { ORDER, type Mode, type Quality } from '../graphics';
import { num, onLang, t } from '../i18n';
import { layout, moveKeys, onKeys, setLayout, type Layout } from '../keys';
import { controlGroups, key, type Action, type Control } from '../shortcuts';

export type ControlMode = Control;
export type PlayMode = 'explore' | 'action';

const GRAPHICS_CYCLE: Mode[] = ['auto', ...ORDER];

// Action is the default (Yoshi, 30 Oct 2026): a new key, so a choice remembered from before starts over.
const KEYS = { nick: 'briel.nickname', play: 'briel.playMode', speed: 'briel.walkSpeed', tab: 'briel.menuTab' };

function load(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private windows can block storage; the choice then lasts for this visit only.
  }
}

const $ = (id: string) => document.getElementById(id)!;

export class Menu {
  mode: ControlMode | null = null;
  play: PlayMode = load(KEYS.play) === 'explore' ? 'explore' : 'action';
  walkSpeed = Math.min(4, Math.max(0.8, Number(load(KEYS.speed)) || 1.4));
  nickname = 'Guest';
  /** Called when play starts or resumes, from a click or key press (so the mouse can be captured). */
  onPlay: (mode: ControlMode) => void = () => {};
  /** Called on the first start, from the click or key press: the world isn't there yet and starts loading. */
  onFirstStart: (mode: ControlMode) => void = () => {};
  /** The world: not there before the first start, loading after it (the chosen start button shows how far), then ready. */
  world: 'none' | 'loading' | 'ready' = 'none';
  onGraphics: (mode: Mode) => void = () => {};
  onPlayMode: (play: PlayMode) => void = () => {};
  onSpeed: (speed: number) => void = () => {};
  /** What the menu shows changed (opened, closed, another tab): main.ts draws the map only while its tab is up. */
  onPage: () => void = () => {};
  /** When the pause menu opened: the Esc that opened it must not close it again. */
  openedAt = 0;
  private graphicsMode: Mode = 'auto';
  /** The last setGraphics call, to write it again in another language. */
  private graphicsArgs: [Mode, Quality | null, string, number | undefined] = ['auto', null, '', undefined];
  private padText = '';
  private account: string | null = null;
  /** The way of playing picked while the world loads, its button, and what the loading does (a function: drawn again in another language). */
  private chosenMode: ControlMode = 'kbm';
  private chosen: HTMLButtonElement | null = null;
  private loadText: () => string = () => '';
  /** The tab showing (or showing next time the pause menu opens). */
  private current = 'map';

  private overlay = $('overlay');
  private start = $('start-panel');
  private pause = $('pause-panel');
  private nick = $('nick') as HTMLInputElement;

  constructor() {
    this.nick.value = load(KEYS.nick);
    $('choose-kbm').addEventListener('click', () => this.resume('kbm'));
    $('choose-pad').addEventListener('click', () => this.resume('pad'));
    $('choose-touch').addEventListener('click', () => this.resume('touch'));
    $('resume').addEventListener('click', () => this.resume(this.mode ?? 'kbm'));
    $('switch').addEventListener('click', () => this.resume(this.mode === 'pad' ? 'kbm' : 'pad'));
    this.nick.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.resume('kbm');
    });
    document.querySelectorAll('.gfx').forEach((b) => b.addEventListener('click', () => this.cycleGraphics()));
    document.querySelectorAll<HTMLButtonElement>('[data-play]').forEach((b) =>
      b.addEventListener('click', () => this.setPlay(b.dataset.play as PlayMode)),
    );
    document.querySelectorAll<HTMLInputElement>('input.speed').forEach((s) =>
      s.addEventListener('input', () => this.setSpeed(Number(s.value))),
    );
    document.querySelectorAll<HTMLButtonElement>('#menu-tabs [data-tab]').forEach((b) => b.addEventListener('click', () => this.showTab(b.dataset.tab!)));
    // The rail is a tablist: the arrow keys (and Home and End) move between the tabs, each shown at once.
    $('menu-tabs').addEventListener('keydown', (e) => {
      const tabs = this.tabs();
      const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
      const moves: Record<string, number> = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 };
      if (i < 0 || !(e.key in moves)) return;
      e.preventDefault();
      e.stopPropagation(); // not on to the game's keys as well: on the map the arrows would move it
      const tab = tabs[(moves[e.key] + tabs.length) % tabs.length];
      this.showTab(tab.dataset.tab!);
      tab.focus();
    });
    this.setPlay(this.play, false);
    this.setSpeed(this.walkSpeed, false);
    this.showTab(load(KEYS.tab) || 'map');
    document.body.classList.add('on-start');
    // Another language: the controls, the speed, the graphics line, the name and the controller's state again.
    onLang(() => {
      this.fillControls();
      this.setSpeed(this.walkSpeed, false);
      this.setGraphics(...this.graphicsArgs);
      $('who').textContent = this.shownName;
      this.padText = '';
      this.showKeyboard();
      this.showProgress();
    });
    // The keyboard's layout (Settings): the key names in the controls and on the start screen.
    document.querySelectorAll<HTMLButtonElement>('[data-kbd]').forEach((b) => b.addEventListener('click', () => setLayout(b.dataset.kbd as Layout)));
    onKeys(() => {
      this.fillControls();
      this.showKeyboard();
    });
    this.showKeyboard();
  }

  /** The keyboard choice in Settings (each with its walking keys) and the start button's line. */
  private showKeyboard(): void {
    const choice = layout();
    document.querySelectorAll<HTMLButtonElement>('[data-kbd]').forEach((b) => {
      const kind = b.dataset.kbd as Layout;
      b.classList.toggle('selected', kind === choice);
      b.querySelector('span')!.textContent = kind === 'auto' ? moveKeys() : kind === 'azerty' ? 'Z Q S D' : 'W A S D';
    });
    $('kbm-sub').textContent = t('choose.kbmSub', { wasd: moveKeys() });
  }

  /** Your name as it shows: "Guest" in the current language when you typed none. */
  private get shownName(): string {
    return this.nickname === 'Guest' ? t('guest') : this.nickname;
  }

  /** The tab showing in the pause menu: map, play, together, settings, controls or admin. */
  get tab(): string {
    return this.current;
  }

  /**
   * One page of the menu. `remember`: the menu opens on it next time too; M shows the map
   * without that, so Esc still brings back the tab you were on.
   */
  showTab(name: string, remember = true): void {
    if (!this.tabs().some((b) => b.dataset.tab === name)) name = 'map';
    this.current = name;
    // A tablist with one tab in the Tab order, the chosen one (the arrow keys reach the others).
    const onRail = !!document.activeElement?.closest('#menu-tabs'); // the keyboard follows the tab (M, L1 and R1 change it too)
    document.querySelectorAll<HTMLButtonElement>('#menu-tabs [data-tab]').forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && onRail) b.focus({ preventScroll: true });
    });
    document.querySelectorAll<HTMLElement>('#pause-panel [data-page]').forEach((p) => p.classList.toggle('hidden', p.dataset.page !== name));
    if (remember) save(KEYS.tab, name);
    this.onPage();
  }

  /** The next (1) or previous (-1) tab, round past the ends: L1 and R1 on the controller. */
  stepTab(step: number): void {
    const tabs = this.tabs();
    const i = tabs.findIndex((b) => b.dataset.tab === this.current);
    this.showTab(tabs[(i + step + tabs.length) % tabs.length].dataset.tab!);
  }

  /** The tabs on the rail (the admin's only for the admin). */
  private tabs(): HTMLButtonElement[] {
    return [...document.querySelectorAll<HTMLButtonElement>('#menu-tabs [data-tab]')].filter((b) => !b.classList.contains('hidden'));
  }

  /** The admin's tab is there for the admin only. */
  setAdmin(admin: boolean): void {
    $('tab-admin').classList.toggle('hidden', !admin);
    if (!admin && this.current === 'admin') this.showTab('map');
  }

  get open(): boolean {
    return !this.overlay.classList.contains('hidden');
  }

  get onStartScreen(): boolean {
    return this.open && !this.start.classList.contains('hidden');
  }

  setPlay(play: PlayMode, notify = true): void {
    this.play = play;
    save(KEYS.play, play);
    document.querySelectorAll<HTMLButtonElement>('[data-play]').forEach((b) => b.classList.toggle('selected', b.dataset.play === play));
    if (!this.start.classList.contains('hidden') || !this.pause.classList.contains('hidden')) this.fillControls();
    if (notify) this.onPlayMode(play);
  }

  setSpeed(speed: number, notify = true): void {
    this.walkSpeed = Math.round(Math.min(4, Math.max(0.8, speed)) * 10) / 10;
    save(KEYS.speed, String(this.walkSpeed));
    document.querySelectorAll<HTMLInputElement>('input.speed').forEach((s) => (s.value = String(this.walkSpeed)));
    document.querySelectorAll('.walk-value').forEach((e) => (e.textContent = `${num(this.walkSpeed, 1)} m/s`));
    if (notify) this.onSpeed(this.walkSpeed);
  }

  /** Next graphics setting: Auto, Low, Medium, High, Ultra, then Auto again. */
  cycleGraphics(): void {
    const i = GRAPHICS_CYCLE.indexOf(this.graphicsMode);
    this.onGraphics(GRAPHICS_CYCLE[(i + 1) % GRAPHICS_CYCLE.length]);
  }

  /** Show the setting; in Auto also the preset it picked (null while testing, or before the world has loaded). */
  setGraphics(mode: Mode, active: Quality | null, gpu: string, testMs?: number): void {
    this.graphicsMode = mode;
    this.graphicsArgs = [mode, active, gpu, testMs];
    const testing = this.world === 'none' ? t('gfx.autoPlain') : t('gfx.testing');
    const value = mode === 'auto' ? (active ? t('gfx.auto', { preset: t(`gfx.${active}`) }) : testing) : t(`gfx.${mode}`);
    let detail = gpu ? t('gfx.chip', { gpu }) : '';
    if (mode === 'auto' && testMs !== undefined) detail += t('gfx.testFrame', { ms: testMs });
    if (mode !== 'auto') detail += t('gfx.fixed');
    document.querySelectorAll('.gfx-value').forEach((e) => (e.textContent = value));
    document.querySelectorAll('.gfx-detail').forEach((e) => (e.textContent = detail));
  }

  /** Logged in for multiplayer: your username is your name in the game. */
  setAccount(name: string | null): void {
    this.account = name;
    $('who-box').classList.toggle('hidden', !!name);
    if (name) {
      this.nickname = name;
      $('who').textContent = name;
    }
  }

  resume(mode: ControlMode): void {
    if (this.world !== 'ready') {
      // The first start: the world loads first, and play begins by itself once it is ready (ready()).
      if (this.world === 'none') this.startLoading(mode);
      return;
    }
    if (this.onStartScreen && !this.account) {
      this.nickname = this.nick.value.trim().slice(0, 20) || 'Guest';
      save(KEYS.nick, this.nickname === 'Guest' ? '' : this.nickname);
      $('who').textContent = this.shownName;
    }
    this.mode = mode;
    this.overlay.classList.add('hidden');
    document.body.classList.remove('on-start');
    // A slider or button keeps the keyboard focus otherwise, and arrow keys would move it instead of you.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    this.onPage();
    this.onPlay(mode);
  }

  /**
   * The chosen start button becomes the progress bar: it fills up, the percentage replaces its
   * arrow and its second line says what is loading. The other start buttons are off meanwhile;
   * the name, the mode, the language and joining still work (the name is taken once play begins).
   */
  private startLoading(mode: ControlMode): void {
    this.world = 'loading';
    this.chosenMode = mode;
    this.chosen = $(`choose-${mode}`) as HTMLButtonElement;
    this.chosen.classList.add('loading');
    this.chosen.setAttribute('aria-busy', 'true');
    const line = document.createElement('span');
    line.className = 'load-line';
    this.chosen.append(line);
    document.querySelectorAll<HTMLButtonElement>('.start-choices .choice.play').forEach((b) => (b.disabled = b !== this.chosen));
    this.progress(0.02, () => t('load.house'));
    this.onFirstStart(mode);
  }

  /** How far the world has loaded (0 to 1), and what it does now; only while it loads after the first start. */
  progress(share: number, text?: () => string): void {
    if (this.world !== 'loading' || !this.chosen) return;
    if (text) this.loadText = text;
    this.chosen.style.setProperty('--load', String(share));
    this.chosen.dataset.pct = `${Math.round(share * 100)}%`;
    this.showProgress();
  }

  private showProgress(): void {
    const line = this.chosen?.querySelector('.load-line');
    if (line) line.textContent = this.loadText();
  }

  /** The world's code didn't arrive (offline, or a new version replaced it): say so on the button. */
  loadFailed(): void {
    this.progress(0, () => t('load.failed'));
    this.chosen?.classList.add('failed');
  }

  /** The world has loaded: play begins, the way chosen on the start screen. */
  ready(): void {
    const b = this.chosen;
    if (this.world !== 'loading' || !b) return;
    this.world = 'ready';
    b.classList.remove('loading');
    b.removeAttribute('aria-busy');
    b.style.removeProperty('--load');
    delete b.dataset.pct;
    b.querySelector('.load-line')?.remove();
    document.querySelectorAll<HTMLButtonElement>('.start-choices .choice.play').forEach((o) => (o.disabled = false));
    this.resume(this.chosenMode);
  }

  private fillControls(): void {
    const control = this.mode ?? 'kbm';
    $('controls').replaceChildren(
      ...controlGroups(control, this.play === 'action').map(({ title, rows }) => {
        const group = document.createElement('div');
        group.className = 'ctl-group';
        const h = document.createElement('h3');
        h.textContent = title;
        const table = document.createElement('table');
        for (const [what, how] of rows) {
          const tr = document.createElement('tr');
          const a = document.createElement('td');
          const k = document.createElement('td');
          a.textContent = what;
          k.textContent = how;
          tr.append(a, k);
          table.append(tr);
        }
        group.append(h, table);
        return group;
      }),
    );
    $('pause-who').textContent = t('menu.who', { name: this.shownName, control: t(({ pad: 'choose.pad', kbm: 'choose.kbm', touch: 'choose.touch' } as const)[control]) });
    // The key that resumes, on the Resume button; with touch the button is the way (☰ is under the menu).
    $('resume-hint').textContent = control === 'touch' ? '' : key('menu', control);
    // The keys beside the menu's own items (the planner, the minimap, the FPS counter), for keyboard players.
    document.querySelectorAll<HTMLElement>('#pause-panel [data-key]').forEach((el) => (el.textContent = control === 'kbm' ? key(el.dataset.key as Action, control) : ''));
    // Together: how to chat and see the scores, the way you play (no chat without a keyboard, no scores key on touch).
    $('tog-keys').textContent = [
      control === 'kbm' ? t('tog.chatHow', { key: key('chat', control) }) : '',
      control === 'touch' ? '' : t('tog.scoresHow', { key: key('scores', control) }),
    ].filter(Boolean).join('  ·  ');
    $('switch-label').textContent = t(control === 'pad' ? 'menu.switchToKbm' : 'menu.switchToPad');
    $('switch').classList.toggle('hidden', control === 'touch');
  }

  /** The pause menu, on the tab it was left on, or on `tab` (the map, for M) without remembering that. */
  showPause(tab?: string): void {
    if (!this.open) this.openedAt = performance.now();
    const nick2 = $('mp-nick2') as HTMLInputElement; // the name for joining from the Together tab
    if (!nick2.value && this.nickname !== 'Guest') nick2.value = this.nickname;
    this.start.classList.add('hidden');
    this.pause.classList.remove('hidden');
    this.overlay.classList.remove('hidden');
    this.fillControls();
    this.showTab(tab ?? (load(KEYS.tab) || 'map'), !tab);
    // The keyboard starts on the rail: the arrow keys change tabs, Tab goes on into the page.
    this.tabs().find((b) => b.dataset.tab === this.current)?.focus({ preventScroll: true });
  }

  setPadState(name: string | null): void {
    // Called every frame: the text only when the controller (or the language) changed.
    const key = `${name}`;
    if (key === this.padText) return;
    this.padText = key;
    $('pad-state').textContent = name ? t('pad.connected', { name: name.replace(/\s*\(.*\)\s*$/, '') }) : t('pad.connect');
    $('choose-pad').classList.toggle('selected', !!name);
  }
}
