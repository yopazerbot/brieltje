import { isMood, type Mood } from '../../shared/moods.mjs';
import { t, type PlainKey } from '../i18n';

const LABEL: Record<Mood, PlainKey> = { sunny: 'mood.sunny', overcast: 'mood.overcast', rain: 'mood.rain', night: 'mood.night' };

/** A mood's name in the page's language. */
export function moodLabel(m: Mood): string {
  return t(LABEL[m]);
}

/**
 * The admin's weather picker in the menu's admin tab: the weather and time of day for everyone playing together
 * (world/weather.ts). The server checks and applies every change (server/game.mjs setMood): only the admin, only a
 * mood from the list, at most one change a second. The buttons wait a second after a click too.
 */
export class MoodAdmin {
  private buttons = [...document.querySelectorAll<HTMLButtonElement>('#mood-admin [data-mood]')];
  private next = 0;
  private active = false;

  constructor(send: (mood: Mood) => void) {
    for (const b of this.buttons) {
      b.addEventListener('click', () => {
        const m = b.dataset.mood;
        if (!this.active || !isMood(m) || performance.now() < this.next) return;
        this.next = performance.now() + 1000;
        send(m);
      });
    }
  }

  /** Whether the admin plays together now (the picker works only then); `current`: the mood everyone has. */
  update(active: boolean, current: Mood | null): void {
    this.active = active;
    for (const b of this.buttons) {
      b.disabled = !active;
      b.classList.toggle('selected', b.dataset.mood === current);
      b.setAttribute('aria-pressed', String(b.dataset.mood === current));
    }
  }
}
