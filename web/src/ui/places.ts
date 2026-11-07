import { dist, lang, onLang, t } from '../i18n';
import { DESTINATIONS, placeName, STREETS, type Destination } from '../places';
import { PORTALS } from '../../shared/portals.mjs';
import { key as keyFor } from '../shortcuts';

/**
 * The menu's list of places (the Play tab), for those without a keyboard for /location: the
 * portals, then the streets, each with how far it is, as the portals' own list draws them
 * (src/ui/travel.ts). A tap or a click goes there; on the controller the menu's D-pad reaches each row and ✕
 * goes (src/ui/padNav.ts). Greyed out while travelling isn't allowed (the admin's rule, a game in the
 * house, down), with the reason under the heading.
 */
export class PlacesList {
  onPick: (d: Destination) => void = () => {};
  private note = document.getElementById('places-note')!;
  private rows = new Map<Destination, HTMLButtonElement>();
  private key = '';

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
    // Distances to the nearest 10 m, so walking about doesn't draw it all again every frame.
    const key = `${Math.round(x / 10)},${Math.round(z / 10)}|${mode}|${why?.() ?? ''}|${lang()}`;
    if (key === this.key) return;
    this.key = key;
    DESTINATIONS.forEach((d) => {
      const row = this.rows.get(d)!;
      row.querySelector('span')!.textContent = placeName(d);
      const far = Math.hypot(d.out[0] - x, d.out[1] - z);
      row.querySelector('small')!.textContent = far < 20 ? t('travel.here') : dist(far);
      row.disabled = !!why;
    });
    this.note.textContent = why ? why() : mode === 'pad' ? `${t('play.placesSub')} ${t('menu.padNav', { ok: keyFor('jump', 'pad') })}` : t('play.placesSub');
  }
}
