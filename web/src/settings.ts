/**
 * Player settings in the pause menu, remembered in this browser: mouse and
 * controller look speed, field of view, volume, inverted look and controller
 * vibration.
 */

import { num, onLang } from './i18n';

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
  /** Baked lighting for the house (test): light bounced between walls, cheaper on weak graphics */
  baked: boolean;
}

const KEY = 'briel.settings';
const DEFAULTS: Settings = { mouse: 1, stick: 1, fov: 72, volume: 0.8, invert: false, vibration: true, baked: false };

function load(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;

export class SettingsPanel {
  readonly value: Settings = load();
  onChange: (s: Settings) => void = () => {};

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
    for (const [id, key] of [['set-invert', 'invert'], ['set-vibration', 'vibration'], ['set-baked', 'baked']] as const) {
      const box = $(id);
      box.checked = this.value[key];
      box.addEventListener('change', () => {
        this.value[key] = box.checked;
        this.changed();
      });
    }
    $('set-reset').addEventListener('click', () => {
      Object.assign(this.value, DEFAULTS);
      for (const [id, key] of [['set-mouse', 'mouse'], ['set-stick', 'stick'], ['set-fov', 'fov'], ['set-volume', 'volume']] as const) {
        $(id).value = String(this.value[key]);
        $(id).dispatchEvent(new Event('input'));
      }
      $('set-invert').checked = DEFAULTS.invert;
      $('set-vibration').checked = DEFAULTS.vibration;
      $('set-baked').checked = DEFAULTS.baked;
      this.changed();
    });
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
