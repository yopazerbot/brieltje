/**
 * Player settings in the pause menu, remembered in this browser: mouse and
 * controller look speed, field of view, volume, inverted look, controller
 * vibration, the controller's aim assist against zombies (src/controls/aimAssist.ts),
 * the minimap and FPS counter (each with a key as its shortcut), and the weather (world/weather.ts) when playing alone: together the admin's choice
 * holds, and the buttons show it, greyed (lockMood).
 */

import { num, onLang, t } from './i18n';
import { type Choice, DEFAULT_CHOICE, isChoice } from '../shared/moods.mjs';

export interface Settings {
  /** Mouse sensitivity multiplier */
  mouse: number;
  /** Controller look speed multiplier */
  stick: number;
  /** Field of view in degrees (vertical) */
  fov: number;
  /** Master volume 0..1 */
  volume: number;
  invert: boolean;
  vibration: boolean;
  /** The controller's aim assist against zombies (src/controls/aimAssist.ts) */
  aimAssist: boolean;
  /** Baked lighting for the house (test): light bounced between walls, cheaper on weak graphics */
  /** The minimap top right (N) */
  minimap: boolean;
  /** The FPS counter (F, or Create on the controller) */
  fps: boolean;
  /** The weather and time of day when playing alone (shared/moods.mjs): a mood, or 'auto' */
  mood: Choice;
}

const KEY = 'briel.settings';
const DEFAULTS: Settings = { mouse: 1, stick: 1, fov: 72, volume: 0.8, invert: false, vibration: true, aimAssist: true, minimap: true, fps: false, mood: DEFAULT_CHOICE };
const BOXES = [['set-invert', 'invert'], ['set-vibration', 'vibration'], ['set-aimassist', 'aimAssist'], ['set-minimap', 'minimap'], ['set-fps', 'fps']] as const;

function load(): Settings {
  try {
    const s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') } as Settings;
    if (!isChoice(s.mood)) s.mood = DEFAULT_CHOICE; // stored by a later version with a mood this one lacks
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;

export class SettingsPanel {
  readonly value: Settings = load();
  onChange: (s: Settings) => void = () => {};
  /** "Next weather" pressed (alone, on Auto) */
  onSkip: () => void = () => {};
  private moodButtons = [...document.querySelectorAll<HTMLButtonElement>('#mood-solo [data-mood]')];
  /**
   * Playing together as the admin: the settings' picker sets the weather for everyone (src/main.ts sends it; the
   * server checks the sender). Null for everyone else, who see the admin's pick greyed.
   */
  onAdminMood: ((mood: Choice) => void) | null = null;
  onAdminSkip: (() => void) | null = null;
  /** The admin's mood while playing together (lockMood) */
  private locked: Choice | null = null;

  constructor() {
    const sliders: [string, keyof Settings, (v: number) => string][] = [
      ['set-mouse', 'mouse', (v) => `${num(v, 2)}×`],
      ['set-stick', 'stick', (v) => `${num(v, 2)}×`],
      ['set-fov', 'fov', (v) => `${v}°`],
      ['set-volume', 'volume', (v) => `${Math.round(v * 100)}%`],
    ];
    for (const [id, key, label] of sliders) {
      const input = $(id);
      const show = () => (document.querySelector(`[data-for="${id}"]`)!.textContent = label(this.value[key] as number));
      input.value = String(this.value[key]);
      show();
      onLang(show); // a decimal comma in Dutch
      input.addEventListener('input', () => {
        (this.value[key] as number) = Number(input.value);
        show();
        this.changed();
      });
    }
    for (const [id, key] of BOXES) {
      const box = $(id);
      box.checked = this.value[key];
      box.addEventListener('change', () => {
        this.value[key] = box.checked;
        this.changed();
      });
    }
    for (const b of this.moodButtons) {
      b.addEventListener('click', () => {
        if (!isChoice(b.dataset.mood)) return;
        if (this.locked) return this.onAdminMood?.(b.dataset.mood); // the admin, together: for everyone
        this.value.mood = b.dataset.mood;
        this.showMood();
        this.changed();
      });
    }
    // "Next weather" alone, on Auto: the mood shown ends now (world/weather.ts skip).
    document.getElementById('mood-next')?.addEventListener('click', () => {
      if (this.locked) {
        if (this.locked === 'auto') this.onAdminSkip?.();
      } else if (this.value.mood === 'auto') this.onSkip();
    });
    this.showMood();
    onLang(() => this.showMood()); // the note under the weather, in the new language
    $('set-reset').addEventListener('click', () => {
      Object.assign(this.value, DEFAULTS);
      this.showMood();
      for (const [id, key] of [['set-mouse', 'mouse'], ['set-stick', 'stick'], ['set-fov', 'fov'], ['set-volume', 'volume']] as const) {
        $(id).value = String(this.value[key]);
        $(id).dispatchEvent(new Event('input'));
      }
      for (const [id, key] of BOXES) $(id).checked = DEFAULTS[key];
      this.changed();
    });
  }

  /**
   * Together: the admin's mood for everyone, shown on the buttons, which are greyed (the own pick stays stored for
   * playing alone). Null: alone again, the own pick.
   */
  lockMood(admin: Choice | null): void {
    this.locked = admin;
    this.showMood();
  }

  /** Playing together as the admin (both set) or not (both null): see onAdminMood. */
  setAdminMood(pick: ((mood: Choice) => void) | null, skip: (() => void) | null): void {
    this.onAdminMood = pick;
    this.onAdminSkip = skip;
    this.showMood();
  }

  private showMood(): void {
    const shown = this.locked ?? this.value.mood;
    for (const b of this.moodButtons) {
      b.classList.toggle('selected', b.dataset.mood === shown);
      b.setAttribute('aria-pressed', String(b.dataset.mood === shown));
      b.disabled = !!this.locked && !this.onAdminMood;
    }
    const note = document.getElementById('mood-note');
    if (note) {
      note.classList.toggle('hidden', !this.locked);
      note.textContent = t(this.onAdminMood ? 'mood.forAll' : 'mood.byAdmin');
    }
    const next = document.getElementById('mood-next') as HTMLButtonElement | null;
    const mood = this.locked ?? this.value.mood;
    if (next) next.classList.toggle('hidden', mood !== 'auto' || (!!this.locked && !this.onAdminSkip));
  }

  /** A setting's shortcut (N for the minimap, F for the FPS counter): on or off, as its tick box. */
  toggle(key: 'minimap' | 'fps'): void {
    this.value[key] = !this.value[key];
    $(`set-${key}`).checked = this.value[key];
    this.changed();
  }

  private changed(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.value));
    } catch {
      // private window: the settings last for this visit
    }
    this.onChange(this.value);
  }
}
