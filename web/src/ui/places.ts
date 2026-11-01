import type { FrameInput } from '../controls/input';
import { dist, lang, onLang, t } from '../i18n';
import { DESTINATIONS, placeName, STREETS, type Destination } from '../places';
import { PORTALS } from '../../shared/portals.mjs';
import { key as keyFor } from '../shortcuts';

/**
 * The menu's list of places (the Play tab), for those without a keyboard for /location: the
 * portals, then the streets, each with how far it is, as the portals' own list draws them
 * (src/ui/travel.ts). A tap or a click goes there; on the controller the D-pad moves the choice
 * and Triangle goes. Greyed out while travelling isn't allowed (the admin's rule, a game in the
 * house, down), with the reason under the heading.
 */
export class PlacesList {
  onPick: (d: Destination) => void = () => {};
  private note = document.getElementById('places-note')!;
  private rows = new Map<Destination, HTMLButtonElement>();
  private choice = 0;
  private key = '';
  private why: (() => string) | null = null;

  constructor() {
    const fill = (list: Destination[], into: HTMLElement) => {
      for (const d of list) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'tv-row';
        row.style.setProperty('--dot', d.color);
        row.append(...['i', 'span', 'small'].map((tag) => document.createElement(tag)));
        row.addEventListener('click', (e) => {
          e.preventDefault();
          if (!row.disabled) this.onPick(d);
        });
        into.append(row);
        this.rows.set(d, row);
      }
    };
    fill(PORTALS, document.getElementById('places-portals')!);
    fill(STREETS, document.getElementById('places-streets')!);
    onLang(() => (this.key = ''));
  }

  /**
   * While the Play tab shows: the names, how far each is from (x, z), the choice, and whether you
   * may go (`why`: the reason you may not). Drawn again only when something in it changes.
   */
  show(x: number, z: number, mode: 'kbm' | 'pad' | 'touch', why: (() => string) | null): void {
    this.why = why;
    // Distances to the nearest 10 m, so walking about doesn't draw it all again every frame.
    const key = `${Math.round(x / 10)},${Math.round(z / 10)}|${mode}|${this.choice}|${why?.() ?? ''}|${lang()}`;
    if (key === this.key) return;
    this.key = key;
    DESTINATIONS.forEach((d, i) => {
      const row = this.rows.get(d)!;
      row.querySelector('span')!.textContent = placeName(d);
      const far = Math.hypot(d.out[0] - x, d.out[1] - z);
      row.querySelector('small')!.textContent = far < 20 ? t('travel.here') : dist(far);
      row.disabled = !!why;
      row.classList.toggle('chosen', mode === 'pad' && i === this.choice);
    });
    this.note.textContent = why ? why() : mode === 'pad' ? `${t('play.placesSub')} ${t('travel.pickPad', { use: keyFor('use', 'pad') })}` : t('play.placesSub');
  }

  /** The controller's D-pad (up and down) and Triangle on the Play tab: true when the list took them. */
  handle(frame: FrameInput): boolean {
    if (frame.weaponCycle) {
      const n = DESTINATIONS.length;
      this.choice = (this.choice - frame.weaponCycle + n) % n; // the D-pad's up (1) goes up the list
      this.rows.get(DESTINATIONS[this.choice])!.scrollIntoView({ block: 'nearest' });
      return true;
    }
    if (frame.usePressed && !this.why) {
      this.onPick(DESTINATIONS[this.choice]);
      return true;
    }
    return false;
  }
}
