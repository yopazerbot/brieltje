import type { FrameInput } from '../controls/input';
import { PORTALS, type Portal } from '../../shared/portals.mjs';
import { dist, lang, onLang, portalName, t } from '../i18n';

/**
 * The list of places while you stand on a portal's pad (or stop the car on it): every portal by
 * its number, how far it is, the one you came from marked "back" and chosen first. A number key
 * goes straight there; the mouse wheel or the D-pad moves the choice and E (or Triangle, or Use)
 * goes; on a touch screen a tap. Walking off the pad closes it.
 */
export class TravelPanel {
  onPick: (p: Portal) => void = () => {};
  private box = document.getElementById('travel')!;
  private title = document.getElementById('tv-here')!;
  private list = document.getElementById('tv-list')!;
  private hint = document.getElementById('tv-hint')!;
  private rows: HTMLButtonElement[] = [];
  private here: Portal | null = null;
  private choice = 0;
  private key = '';

  constructor() {
    this.rows = PORTALS.map((p, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tv-row';
      row.style.setProperty('--dot', p.color);
      const parts = ['kbd', 'i', 'span', 'small', 'em'].map((tag) => document.createElement(tag));
      parts[0].textContent = String(i + 1);
      parts[2].textContent = portalName(p);
      row.append(...parts);
      row.addEventListener('click', (e) => {
        e.preventDefault();
        if (this.here && p !== this.here) this.onPick(p);
      });
      this.list.append(row);
      return row;
    });
    onLang(() => this.rows.forEach((row, i) => (row.querySelector('span')!.textContent = portalName(PORTALS[i]))));
  }

  get open(): boolean {
    return !!this.here;
  }

  /** Standing on `here`'s pad: the list (built again only when something in it changes). */
  show(here: Portal, back: string | null, mode: 'kbm' | 'pad' | 'touch', inCar: boolean): void {
    if (this.here !== here) {
      this.here = here;
      const i = PORTALS.findIndex((p) => p.id === back && p !== here);
      this.choice = i >= 0 ? i : PORTALS.findIndex((p) => p !== here);
    }
    const key = `${here.id}|${back}|${mode}|${inCar}|${this.choice}|${lang()}`;
    if (key === this.key) return;
    this.key = key;
    this.title.textContent = portalName(here);
    PORTALS.forEach((p, i) => {
      const row = this.rows[i];
      const d = Math.hypot(p.x - here.x, p.z - here.z);
      row.classList.toggle('here', p === here);
      row.classList.toggle('chosen', i === this.choice);
      row.querySelector('small')!.textContent = p === here ? t('travel.here') : dist(d);
      row.querySelector('em')!.textContent = p.id === back && p !== here ? t('travel.back') : '';
    });
    const pick = mode === 'pad' ? t('travel.pickPad') : mode === 'touch' ? t('travel.pickTouch') : t('travel.pickKbm', { n: PORTALS.length });
    this.hint.textContent = t(inCar ? 'travel.driveOn' : 'travel.walkOff', { pick });
    this.box.classList.remove('hidden');
  }

  hide(): void {
    if (!this.here) return;
    this.here = null;
    this.key = '';
    this.box.classList.add('hidden');
  }

  /** This frame's number key, wheel or D-pad and E: true when the list took them (the weapons and doors don't get them then). */
  handle(frame: FrameInput, mode: 'kbm' | 'pad' | 'touch'): boolean {
    if (!this.here) return false;
    const n = frame.weaponSlot;
    if (n >= 1 && n <= PORTALS.length && PORTALS[n - 1] !== this.here) {
      this.onPick(PORTALS[n - 1]);
    } else if (frame.weaponCycle) {
      // The wheel turned down (1) and Q (2) go down the list; the D-pad's up (1) goes up.
      const step = frame.weaponCycle === 2 ? 1 : mode === 'pad' ? -frame.weaponCycle : frame.weaponCycle;
      for (let i = 1; i < PORTALS.length; i++) {
        const next = (this.choice + step * i + PORTALS.length * i) % PORTALS.length;
        if (PORTALS[next] !== this.here) {
          this.choice = next;
          break;
        }
      }
    } else if (frame.usePressed) {
      this.onPick(PORTALS[this.choice]);
    }
    return !!(n || frame.weaponCycle || frame.usePressed);
  }
}
