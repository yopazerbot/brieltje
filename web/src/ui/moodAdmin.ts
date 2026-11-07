import { type Choice, isChoice, SPEEDS } from '../../shared/moods.mjs';
import { t, type PlainKey } from '../i18n';

const LABEL: Record<Choice, PlainKey> = {
  auto: 'mood.auto', sunny: 'mood.sunny', overcast: 'mood.overcast', rain: 'mood.rain', dusk: 'mood.dusk', night: 'mood.night', snow: 'mood.snow',
};

/** A choice's name in the page's language. */
export function moodLabel(m: Choice): string {
  return t(LABEL[m]);
}

/**
 * The chat's line for a change from the server ('mood', `op` what changed, `by` who: a name, put in as text), in the
 * page's language; null for none. `choice` and `speed`: as the page has them now.
 */
export function moodNotice(m: { op?: unknown; by?: unknown }, choice: Choice | null, speed: number): (() => string) | null {
  const name = typeof m.by === 'string' ? m.by : null;
  if (m.op === 'skip' && name) return () => t('mood.skipped', { name });
  if (m.op === 'speed') return speed === 1 ? () => t('mood.speedNormal') : name ? () => t('mood.speedSet', { name, speed }) : null;
  if (!name || !choice) return null;
  return choice === 'auto' ? () => t('mood.setAuto', { name }) : () => t('mood.set', { name, mood: moodLabel(choice) });
}

/** What the admin's picker sends (server/game.mjs checks each: only the admin, only from the fixed lists, rate limited). */
export type MoodAdminMsg = { t: 'mood'; mood: Choice } | { t: 'moodskip' } | { t: 'moodspeed'; speed: number };

/**
 * The admin's weather picker in the menu's admin tab: the weather and time of day for everyone playing together
 * (world/weather.ts): a mood or Auto, and on Auto "Next weather" (the mood shown ends now, the usual blend into the
 * next begins) and the cycle's pace, 1, 10 or 60 times (Yoshi: "Fast forward should also be possible for the admin in
 * production"). The server checks and applies every change (server/game.mjs). The buttons wait a second after a
 * click too, "Next weather" five.
 */
export class MoodAdmin {
  private buttons = [...document.querySelectorAll<HTMLButtonElement>('#mood-admin [data-mood]')];
  private speeds = [...document.querySelectorAll<HTMLButtonElement>('#mood-speed [data-speed]')];
  private nextBtn = document.getElementById('mood-admin-next') as HTMLButtonElement | null;
  private autoRow = document.getElementById('mood-admin-auto');
  private next = 0;
  private nextSkip = 0;
  private active = false;

  constructor(send: (m: MoodAdminMsg) => void) {
    const ok = (gap: number, last: 'next' | 'nextSkip') => {
      if (!this.active || performance.now() < this[last]) return false;
      this[last] = performance.now() + gap;
      return true;
    };
    for (const b of this.buttons) {
      b.addEventListener('click', () => {
        const m = b.dataset.mood;
        if (isChoice(m) && ok(1000, 'next')) send({ t: 'mood', mood: m });
      });
    }
    for (const b of this.speeds) {
      b.addEventListener('click', () => {
        const speed = Number(b.dataset.speed);
        if (SPEEDS.includes(speed) && ok(1000, 'next')) send({ t: 'moodspeed', speed });
      });
    }
    this.nextBtn?.addEventListener('click', () => {
      if (ok(5000, 'nextSkip')) send({ t: 'moodskip' });
    });
  }

  /** Whether the admin plays together now (the picker works only then); `current`: the choice everyone has; `speed`: the cycle's pace. */
  update(active: boolean, current: Choice | null, speed: number): void {
    this.active = active;
    for (const b of this.buttons) {
      b.disabled = !active;
      b.classList.toggle('selected', b.dataset.mood === current);
      b.setAttribute('aria-pressed', String(b.dataset.mood === current));
    }
    for (const b of this.speeds) {
      b.disabled = !active;
      b.classList.toggle('selected', Number(b.dataset.speed) === speed);
      b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === speed));
    }
    if (this.nextBtn) this.nextBtn.disabled = !active;
    this.autoRow?.classList.toggle('hidden', current !== 'auto');
  }
}
