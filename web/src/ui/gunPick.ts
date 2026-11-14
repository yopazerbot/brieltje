import { LOADOUT, cleanPick } from '../../shared/loadout.mjs';
import { onLang, t } from '../i18n';
import { GUN_PAINT } from '../paintball';
import './gunPick.css';

/**
 * The guns you start with in Action and Paintball (shared/loadout.mjs): the pistol always, and up to two of the long
 * guns on top of it. Chosen on the start screen's third step, before play (Yoshi, 14 Nov 2026: "You choose your guns on
 * the start screen before play. Nothing opens during the drop."), and changed in the pause menu's Play tab. Nothing
 * here opens by itself during play.
 *
 * `gunChoice` is the one choice, kept on this device (localStorage briel.loadout, a JSON list), so the start screen's
 * chips and the menu's always agree. `GunPick` is a row of chips for it: a tap picks a gun or puts it back, and a third
 * pick takes the place of the one picked first. Plain buttons, so mouse, touch, keyboard and a controller (the menus'
 * own focus walk) all work alike, with no keys of their own. No three.js here: the start screen loads it.
 */

const KEY = 'briel.loadout';
let pick: string[] = LOADOUT.first;
try {
  const kept = localStorage.getItem(KEY);
  if (kept !== null) pick = cleanPick(JSON.parse(kept));
} catch {
  // no storage, or not a list: the first choice
}
const listeners: ((pick: string[]) => void)[] = [];

export const gunChoice = {
  /** The guns chosen, besides the pistol */
  get pick(): string[] {
    return [...pick];
  },
  /** Pick gun `w`, or put it back; a third takes the place of the one picked first. */
  toggle(w: string): void {
    pick = pick.includes(w) ? pick.filter((p) => p !== w) : [...pick, w].slice(-LOADOUT.most);
    try {
      localStorage.setItem(KEY, JSON.stringify(pick));
    } catch {
      // no storage: the choice lasts this visit
    }
    for (const fn of listeners) fn([...pick]);
  },
  on(fn: (pick: string[]) => void): void {
    listeners.push(fn);
  },
};

/** A side view of each gun, barrel to the right, as lines on a 48 x 20 box (in the style of the modes' icons). */
const ICONS: Record<string, string[]> = {
  rifle: ['M3 7.5 11 8v4l-8 3z', 'M11 7h21v4H11z', 'M32 8.5h13', 'M20 11l1.2 6h3.2L23.6 11', 'M14 11l-1 4h2.6l.9-4', 'M16 7V5.5h5V7'],
  shotgun: ['M3 7.5 12 8v4l-9 3z', 'M12 7h10v5H12z', 'M22 7.5h23', 'M22 10.5h17', 'M27 9h8v4h-8z', 'M14.5 12l-1 3h2.6l.8-3'],
  sniper: ['M2 8 12 8.5v3.5l-10 4z', 'M12 8h18v3.5H12z', 'M30 9.5h16', 'M16 2.5h13v3H16z', 'M19 5.5V8M26 5.5V8', 'M14 11.5l-1 4h2.6l.9-4'],
};
const SVG = 'http://www.w3.org/2000/svg';

function icon(w: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'gun-ico');
  svg.setAttribute('viewBox', '0 0 48 20');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[w] ?? []) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

type Note = 'guns.rule' | 'guns.now' | 'guns.later' | 'guns.zombies';

export class GunPick {
  private chips: { w: string; el: HTMLButtonElement; ico: SVGSVGElement; img: HTMLImageElement; name: HTMLElement }[] = [];
  private row = document.createElement('div');
  private note = document.createElement('p');
  private noteKey: Note = 'guns.rule';
  private paint = false;

  /** `picture`: a picture of gun `w` (a data URL) in place of its icon, or '' while there is none. */
  constructor(private mount: HTMLElement, private opts: { picture?: (w: string) => string } = {}) {
    this.row.className = 'gun-chips';
    this.row.setAttribute('role', 'group');
    for (const w of LOADOUT.choices) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'gun-chip';
      el.dataset.gun = w;
      const ico = icon(w);
      const img = document.createElement('img');
      img.className = 'gun-img hidden';
      img.alt = '';
      img.draggable = false;
      const name = document.createElement('span');
      name.className = 'gun-name';
      const tick = document.createElement('span');
      tick.className = 'gun-tick';
      tick.setAttribute('aria-hidden', 'true');
      tick.textContent = '✓';
      el.append(ico, img, name, tick);
      el.addEventListener('click', () => gunChoice.toggle(w));
      this.row.append(el);
      this.chips.push({ w, el, ico, img, name });
    }
    this.note.className = 'gun-note';
    mount.append(this.row, this.note);
    this.words();
    this.ticks();
    onLang(() => this.words());
    gunChoice.on(() => this.ticks());
  }

  /** Paintball's names for the guns, and their icons in their paint colours. */
  setPaint(on: boolean): void {
    if (on === this.paint) return;
    this.paint = on;
    this.words();
  }

  shown(on: boolean): void {
    this.mount.classList.toggle('hidden', !on);
  }

  /** The line under the chips: the rule, or what became of a change. */
  say(key: Note): void {
    this.noteKey = key;
    this.note.textContent = this.noteKey === 'guns.rule' ? t('guns.rule', { n: LOADOUT.most }) : t(this.noteKey);
  }

  /** The pictures (`opts.picture`), where there are any now. */
  refresh(): void {
    if (!this.opts.picture) return;
    for (const c of this.chips) {
      const src = this.opts.picture(c.w);
      if (src && c.img.src !== src) c.img.src = src;
      c.img.classList.toggle('hidden', !src);
      c.ico.classList.toggle('hidden', !!src);
    }
  }

  private words(): void {
    this.row.setAttribute('aria-label', t('guns.title'));
    for (const c of this.chips) {
      c.name.textContent = t((this.paint ? `paint.${c.w}` : `weapon.${c.w}`) as 'weapon.rifle');
      c.ico.style.stroke = this.paint ? GUN_PAINT[c.w] ?? '' : '';
    }
    this.say(this.noteKey);
  }

  private ticks(): void {
    const now = gunChoice.pick;
    for (const c of this.chips) {
      c.el.classList.toggle('on', now.includes(c.w));
      c.el.setAttribute('aria-pressed', String(now.includes(c.w)));
    }
  }
}
