import { LOOT } from '../../shared/loot.mjs';
import { priceOf, STALL, type StallKind, type StallView } from '../../shared/stall.mjs';
import { btn, onPadLabels } from '../controls/padFamily';
import { onLang, serverText, t } from '../i18n';
import { onKeys, typing } from '../keys';
import { onPaintball, paintball } from '../paintball';
import { key, type Control } from '../shortcuts';
import './stall.css';

/**
 * The stall in the Zombies game (shared/stall.mjs): a small chip above your health with your coins, and in
 * the break between waves a card with six things to buy. It builds its own chip and card (no markup in
 * index.html) and writes every text with textContent. The coins and the counts bought come from the server
 * (zcoins; alone from the page's own Stall) and are checked before use; the prices are worked out here from
 * the shared table, for show only: the server charges its own.
 *
 * Keys: K opens and closes (K as in "kraampje"), 1 to 6 buy, Esc or Enter closes. A controller: D-pad right
 * opens (main.ts), the D-pad or stick moves (PadNav), ✕ (A) buys, ○ (B) or Options closes. Touch: a tap on
 * the chip opens it. It closes by itself when the wave starts, when you go down or when the menu opens.
 */

const DIGITS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad5', 'Numpad6'];
/** ms a purchase waits for its answer before the card sends another */
const WAIT_MS = 600;
/** ms between two purchases sent: a little more than the server's 300, which drops anything sooner in silence */
const GAP_MS = 350;

const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const count = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;

export class StallCard {
  open = false;
  /** When it closed (performance.now()): the key that closed it must not do anything else */
  closedAt = -1e9;
  /** Whether it may open now (main.ts: Zombies on, the break, armed, up, on foot, no menu or other card) */
  can: () => boolean = () => false;
  /** Buy one `kind` (main.ts: to the server together, the page's own Stall alone) */
  onBuy: (kind: StallKind) => void = () => {};
  /** It closed; `relock`: back to the game (the game takes the mouse back with a keyboard and mouse) */
  onClose: (relock: boolean) => void = () => {};
  private coins = 0;
  private counts: number[] = STALL.items.map(() => 0);
  /** performance.now() when a purchase was asked, 0 when its answer came */
  private asked = 0;
  /** When the last purchase was sent; the one pressed meanwhile, sent when its time comes (flush) */
  private sentAt = -1e9;
  private pending: StallKind | null = null;
  private timer = 0;
  private pad = false;
  private mode: Control = 'kbm';
  private brk = false;
  private left = 0;
  private chipShown = '';
  private subShown = '';
  private chip = document.createElement('button');
  private root = document.createElement('div');
  private title = document.createElement('h2');
  private sub = document.createElement('p');
  private purse = document.createElement('p');
  private items: { kind: StallKind; el: HTMLButtonElement; name: HTMLElement; what: HTMLElement; price: HTMLElement }[] = [];
  private note = document.createElement('p');
  private hint = document.createElement('p');
  private back = document.createElement('button');

  constructor() {
    const c = this.chip;
    c.id = 'stall-chip';
    c.type = 'button';
    c.tabIndex = -1;
    c.hidden = true;
    c.addEventListener('click', () => {
      if (!this.open && this.can()) this.show(false);
    });
    const r = this.root;
    r.id = 'stall';
    r.className = 'hidden';
    r.setAttribute('role', 'dialog');
    r.setAttribute('aria-modal', 'true');
    this.sub.className = 'st-sub';
    this.purse.className = 'st-purse';
    const grid = document.createElement('div');
    grid.className = 'st-items';
    STALL.items.forEach(([kind], i) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'st-item';
      el.dataset.kind = kind;
      el.tabIndex = -1;
      const n = document.createElement('span');
      n.className = 'st-key';
      n.textContent = `${i + 1}`;
      const name = document.createElement('b');
      const what = document.createElement('span');
      what.className = 'st-what';
      const price = document.createElement('span');
      price.className = 'st-price';
      el.append(n, name, what, price);
      el.addEventListener('click', () => {
        el.blur(); // Space or Enter after a click must not buy it again
        this.press(kind);
      });
      grid.append(el);
      this.items.push({ kind, el, name, what, price });
    });
    this.note.className = 'st-note';
    this.note.setAttribute('role', 'status');
    this.hint.className = 'st-hint';
    this.back.type = 'button';
    this.back.className = 'st-close';
    this.back.addEventListener('click', () => this.close(true));    r.append(this.title, this.sub, this.purse, grid, this.note, this.hint, this.back);
    document.body.append(c, r);
    this.words();
    onLang(() => this.words());
    onPadLabels(() => this.words());
    onPaintball(() => this.words());
    onKeys(() => this.words());
    document.addEventListener('keydown', (e) => {
      if (!this.open) {
        if (e.code === 'KeyK' && !e.repeat && !typing(e) && this.can()) {
          e.preventDefault();
          e.stopPropagation();
          this.show(false);
        }
        return;
      }
      e.stopPropagation(); // buying is not walking or switching weapons
      const n = DIGITS.indexOf(e.code) % 6;
      if (n >= 0) {
        if (!e.repeat) this.press(this.items[n].kind);
      } else if (e.code === 'KeyK' || e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        this.close(true);
      } else if (e.code === 'Space') e.preventDefault(); // a focused thing is not bought by Space
    }, true);
    document.addEventListener('keyup', (e) => {
      if (this.open && e.code === 'Space') e.preventDefault();
    }, true);
  }

  /** The card's page for the controller (PadNav), while it shows. */
  get page(): HTMLElement | null {
    return this.open ? this.root : null;
  }

  /** Your coins and what you bought ({ c, n }, from zcoins or the page's own Stall): taken only when both are whole numbers of 0 or more. */
  set(v: Partial<StallView> | { c?: unknown; n?: unknown }): void {
    const n: unknown = v.n;
    if (!count(v.c) || !Array.isArray(n) || n.length > STALL.items.length || !n.every(count)) return;
    this.coins = v.c;
    this.counts = STALL.items.map((_, i) => (n[i] as number | undefined) ?? 0);
    this.paint();
  }

  /** Every frame: the chip while Zombies is on (the key with it in the break); the card closes when the break ends. */
  update(s: { on: boolean; brk: boolean; left: number; mode: Control }): void {
    if (s.mode !== this.mode) {
      this.mode = s.mode;
      this.words();
    }
    const can = s.on && s.brk && this.can();
    this.brk = can; // the key on the chip only when it would open the card
    this.left = s.left;
    if (this.open && !can) this.close(true); // the wave began, or you went down: back to the game
    this.chip.hidden = !s.on;
    this.chip.classList.toggle('open', this.brk);
    this.chipText();
    if (this.open) {
      const sub = t('stall.sub', { time: clock(this.left) });
      if (sub !== this.subShown) this.sub.textContent = this.subShown = sub;
    }
  }

  /** Open it. `pad`: with a controller (its hint, no key numbers). */
  show(pad = false): void {
    if (this.open) return;
    this.open = true;
    this.pad = pad;
    this.root.classList.toggle('pad', pad);
    this.note.textContent = '';
    this.subShown = '';
    this.words();
    if (document.pointerLockElement) document.exitPointerLock();
    this.root.classList.remove('hidden');
  }

  /** Close it. `relock`: back to the game (main.ts takes the mouse back); false where something else comes up. */
  close(relock: boolean): void {
    if (!this.open) return;
    this.open = false;
    this.closedAt = performance.now();
    this.pending = null;
    clearTimeout(this.timer);
    this.root.classList.add('hidden');
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.onClose(relock);
  }

  /** The menu or the big map is up: the card shuts and the chip goes until the game is back (update). */
  hide(): void {
    this.close(false);
    this.chip.hidden = true;
  }

  /**
   * Buy `kind`. Sent at once when the last purchase was sent GAP_MS ago and answered (or WAIT_MS passed);
   * else kept, the latest press only, and sent when that time comes: never sooner than the server takes it.
   */
  press(kind: StallKind): void {
    if (!this.open) return;
    this.note.textContent = '';
    this.pending = kind;
    this.flush();
  }

  private flush(): void {
    clearTimeout(this.timer);
    if (!this.pending || !this.open) return;
    const now = performance.now();
    const wait = Math.max(this.sentAt + GAP_MS - now, this.asked ? this.asked + WAIT_MS - now : 0);
    if (wait > 0) {
      this.timer = window.setTimeout(() => this.flush(), wait);
      return;
    }
    const kind = this.pending;
    this.pending = null;
    this.sentAt = this.asked = now;
    this.onBuy(kind);
  }

  /** The answer came; `code`, a refusal (zStallShut, zStallShort, zStallFull), said in the card. A press kept meanwhile goes when its time comes. */
  result(code?: string): void {
    this.asked = 0;
    if (code) this.note.textContent = serverText(code, {}, '');
    this.flush();
  }

  private chipText(): void {
    const coins = t('stall.coins', { n: this.coins });
    const text = !this.brk ? coins : this.mode === 'touch' ? `${coins} · ${t('stall.title')}` : t('stall.chip', { n: this.coins, key: key('stall', this.mode) });
    if (text !== this.chipShown) this.chip.textContent = this.chipShown = text;
  }

  private words(): void {
    const m = this.mode;
    this.title.textContent = t('stall.title');
    this.back.textContent = t('stall.close');
    this.hint.textContent = this.pad ? t('stall.hintPad', { buy: btn('south'), back: btn('east') }) : m === 'touch' ? '' : t('stall.hintKbm', { key: key('stall', 'kbm') });
    const words: Record<StallKind, [string, string]> = {
      medkit: [t('loot.medkit'), t('loot.medkitSub', { n: LOOT.heal })],
      nades: [t(paintball.on ? 'loot.nadesPaint' : 'loot.nades'), t('loot.nadesSub', { n: LOOT.nades, key: key('grenade', m) })],
      claymore: [t(paintball.on ? 'loot.paintMine' : 'loot.claymore'), t('loot.mineSub', { key: key('grenade', m) })],
      armor: [t('loot.armor'), t('loot.armorSub', { n: LOOT.armor })],
      gun: [t('loot.gun'), t('stall.gun')],
      turret: [t('loot.turret'), t('loot.turretSub', { key: key('use', m) })],
    };
    for (const it of this.items) {
      it.name.textContent = words[it.kind][0];
      it.what.textContent = words[it.kind][1];
    }
    this.subShown = '';
    if (this.open) this.sub.textContent = this.subShown = t('stall.sub', { time: clock(this.left) });
    this.chipShown = '';
    this.chipText();
    this.paint();
  }

  /** The coins, each price, and what you can't pay dimmed (aria-disabled, not disabled: PadNav skips those). */
  private paint(): void {
    this.purse.textContent = t('stall.coins', { n: this.coins });
    this.items.forEach((it, i) => {
      const price = priceOf(it.kind, this.counts[i]);
      const short = this.coins < price;
      it.price.textContent = t('stall.coins', { n: price });
      it.el.classList.toggle('short', short);
      it.el.setAttribute('aria-disabled', String(short));
      it.el.title = short ? t('stall.short') : '';
    });
    this.chipText();
  }
}
