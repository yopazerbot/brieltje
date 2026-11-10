import { LOADOUT, cleanPick } from '../../shared/loadout.mjs';
import { btn, onPadLabels } from '../controls/padFamily';
import { onLang, t } from '../i18n';
import { onPaintball, weaponName } from '../paintball';
import { SPECS, type WeaponId } from '../weapon';

/**
 * The card where a player chooses the guns to start with in Action and Paintball (shared/loadout.mjs): the
 * pistol is always carried, and up to two of the long guns on top of it. Each gun shows as a picture of its own
 * model (`picture`, drawn once by the game), its name and three bars: how hard a shot hits, how fast it fires
 * and how far it reaches. It builds its own box (no markup in index.html) and takes the keys while it shows.
 *
 * Mouse and touch: tap a gun to pick it or put it back, then Play. Keys: 1, 2 and 3 pick, Enter or Esc plays.
 * With a controller (`pad`): the stick or D-pad moves, ✕ picks (or plays, on the button), ○ or Options plays.
 * A third gun picked takes the place of the one picked first.
 */

/** How far each gun reaches, 0..1 (the bars' third: the others come from the guns' numbers). */
const REACH: Record<string, number> = { rifle: 0.7, shotgun: 0.3, sniper: 1 };

export class LoadoutCard {
  open = false;
  /** When it closed (performance.now()): the key that closed it must not do anything else */
  closedAt = -1e9;
  /** The choice made, as the card closes; `click`: closed with the mouse (the game takes the mouse back). */
  onDone: (pick: string[], click: boolean) => void = () => {};
  /** A picture of gun `w` (a data URL), or '' while its model isn't in */
  picture: (w: WeaponId) => string = () => '';
  private pick: string[] = [];
  private pad = false;
  private cursor = 0;
  private root = document.createElement('div');
  private title = document.createElement('h2');
  private sub = document.createElement('p');
  private guns: { w: WeaponId; el: HTMLButtonElement; img: HTMLImageElement; name: HTMLElement; labels: HTMLElement[]; key: HTMLElement }[] = [];
  private hint = document.createElement('p');
  private note = document.createElement('p');
  private go = document.createElement('button');

  constructor() {
    const r = this.root;
    r.id = 'loadout';
    r.className = 'hidden';
    r.setAttribute('role', 'dialog');
    r.setAttribute('aria-modal', 'true');
    this.sub.className = 'lo-sub';
    const row = document.createElement('div');
    row.className = 'lo-guns';
    (LOADOUT.choices as WeaponId[]).forEach((w, i) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'lo-gun';
      el.tabIndex = -1;
      const key = document.createElement('span');
      key.className = 'lo-key';
      key.textContent = `${i + 1}`;
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      const name = document.createElement('b');
      const bars = document.createElement('div');
      bars.className = 'lo-bars';
      const spec = SPECS[w];
      const labels: HTMLElement[] = [];
      for (const value of [Math.min(1, Math.sqrt((spec.body * spec.pellets) / 120)), Math.min(1, Math.sqrt(0.1 / spec.delay)), REACH[w] ?? 0.5]) {
        const label = document.createElement('span');
        const meter = document.createElement('i');
        const fill = document.createElement('i');
        fill.style.width = `${Math.round(Math.max(0.08, value) * 100)}%`;
        meter.append(fill);
        bars.append(label, meter);
        labels.push(label);
      }
      const tick = document.createElement('span');
      tick.className = 'lo-tick';
      tick.textContent = '✓';
      el.append(key, tick, img, name, bars);
      el.addEventListener('click', () => {
        this.cursor = i;
        this.toggle(w);
      });
      row.append(el);
      this.guns.push({ w, el, img, name, labels, key });
    });
    this.hint.className = 'lo-hint hidden';
    this.note.className = 'lo-note';
    this.go.type = 'button';
    this.go.className = 'lo-go';
    this.go.addEventListener('click', () => this.close(true));
    r.append(this.title, this.sub, row, this.note, this.hint, this.go);
    document.body.append(r);
    this.words();
    onLang(() => this.words());
    onPadLabels(() => this.words());
    onPaintball(() => {
      this.words(); // the paint guns' names, and their pictures in their own colours
      if (this.open) this.pictures();
    });
    document.addEventListener('keydown', (e) => {
      if (!this.open) return;
      e.stopPropagation(); // choosing a gun is not walking or switching weapons
      const n = ['Digit1', 'Digit2', 'Digit3', 'Numpad1', 'Numpad2', 'Numpad3'].indexOf(e.code) % 3;
      if (n >= 0 && e.code.length > 5) {
        this.cursor = n;
        this.toggle(this.guns[n].w);
      } else if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        this.close(false);
      }
    }, true);
  }

  private words(): void {
    this.title.textContent = t('lo.title');
    this.sub.textContent = t('lo.sub', { n: LOADOUT.most });
    this.note.textContent = t('lo.note');
    this.go.textContent = t('lo.go');
    this.hint.textContent = t('lo.padHint', { pick: btn('south'), go: btn('east') });
    for (const g of this.guns) {
      g.name.textContent = weaponName(g.w);
      g.labels[0].textContent = t('lo.power');
      g.labels[1].textContent = t('lo.rate');
      g.labels[2].textContent = t('lo.reach');
    }
  }

  private pictures(): void {
    for (const g of this.guns) {
      const src = this.picture(g.w);
      if (src && g.img.src !== src) g.img.src = src;
      g.img.classList.toggle('hidden', !src);
    }
  }

  /** `pick`: the guns chosen last time. `pad`: played with a controller. */
  show(pick: string[], pad = false): void {
    if (this.open) return;
    this.open = true;
    this.pick = cleanPick(pick);
    this.pad = pad;
    this.cursor = this.guns.length; // on Play: one press and you are in, with last time's guns
    this.hint.classList.toggle('hidden', !pad);
    this.root.classList.toggle('pad', pad);
    this.pictures();
    this.paint();
    if (document.pointerLockElement) document.exitPointerLock();
    this.root.classList.remove('hidden');
  }

  close(click: boolean): void {
    if (!this.open) return;
    this.open = false;
    this.closedAt = performance.now();
    this.root.classList.add('hidden');
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.onDone([...this.pick], click);
  }

  /** Pick a gun, or put it back; a third takes the place of the one picked first. */
  private toggle(w: string): void {
    if (this.pick.includes(w)) this.pick = this.pick.filter((p) => p !== w);
    else this.pick = [...this.pick, w].slice(-LOADOUT.most);
    this.paint();
  }

  private paint(): void {
    this.guns.forEach((g, i) => {
      g.el.classList.toggle('on', this.pick.includes(g.w));
      g.el.classList.toggle('at', this.pad && this.cursor === i);
      g.el.setAttribute('aria-pressed', String(this.pick.includes(g.w)));
    });
    this.go.classList.toggle('at', this.pad && this.cursor === this.guns.length);
  }

  /** The cursor moves by one (a controller's stick or D-pad): along the guns, and down to Play. */
  padMove(dx: number, dy: number): void {
    if (!this.open || !this.pad || (!dx && !dy)) return;
    const last = this.guns.length;
    if (dy > 0) this.cursor = last;
    else if (dy < 0 && this.cursor === last) this.cursor = 1;
    else if (dx && this.cursor < last) this.cursor = Math.max(0, Math.min(last - 1, this.cursor + dx));
    this.paint();
  }

  /** ✕: the gun under the cursor, or Play. */
  padPress(): void {
    if (!this.open) return;
    if (this.cursor >= this.guns.length) this.close(false);
    else this.toggle(this.guns[this.cursor].w);
  }
}
