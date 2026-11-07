import type { Home } from '../../shared/homes.mjs';
import { btn, onPadLabels } from '../controls/padFamily';
import { onLang, t } from '../i18n';

/** The characters of a code (server/homes.mjs ALPHABET: no I, O, 0 or 1) */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const COLS = 8;
const ROWS = ALPHABET.length / COLS; // 4 rows of letters and digits, then a row of Delete and Enter
const CODE_LENGTH = 10;
const DELETE = ALPHABET.length;
const ENTER = ALPHABET.length + 1;

/**
 * The card that asks for a locked home's access code (src/world/homeLocks.ts). It builds its own box (no markup in
 * index.html), takes the keys while it shows, and never keeps what was typed: the field is emptied on every close
 * and the page doesn't save it. The wrong-code answers and the limits are the server's (server/homes.mjs).
 *
 * With a controller (`pad`) the field is read-only and a keypad of the code's 32 characters, Delete and Enter shows
 * under it: the stick or D-pad moves (`padMove`), ✕ types the key (`padPress`), ○ deletes, or closes when the code is
 * empty (`padBack`). The code shows with a dash after five characters. Keyboard and touch keep the text field.
 */
export class HomeCodeCard {
  open = false;
  /** When it closed (performance.now()): the Esc that closed it must not open the menu too */
  closedAt = -1e9;
  onClose: (click: boolean) => void = () => {};
  /** Tries the code at this home: the reason it failed, or '' when it worked. */
  try: (home: Home, code: string) => Promise<string> = async () => '';
  private home: Home | null = null;
  private pad = false;
  /** What was typed with the keypad (the field shows it with a dash) */
  private typed = '';
  private cursor = 0;
  private root = document.createElement('div');
  private title = document.createElement('h2');
  private sub = document.createElement('p');
  private input = document.createElement('input');
  private keypad = document.createElement('div');
  private keys: HTMLButtonElement[] = [];
  private hint = document.createElement('p');
  private status = document.createElement('p');
  private cancel = document.createElement('button');
  private go = document.createElement('button');

  constructor() {
    const r = this.root;
    r.id = 'home-code';
    r.className = 'hidden';
    r.setAttribute('role', 'dialog');
    r.setAttribute('aria-modal', 'true');
    this.sub.className = 'hc-sub';
    this.input.type = 'text';
    this.input.maxLength = 16;
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.setAttribute('autocapitalize', 'characters');
    this.keypad.className = 'hc-pad hidden';
    for (let i = 0; i < ALPHABET.length + 2; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.tabIndex = -1;
      b.className = i === DELETE ? 'hc-key hc-wide' : i === ENTER ? 'hc-key hc-wide hc-go' : 'hc-key';
      b.addEventListener('click', () => {
        this.cursor = i;
        this.press(i);
      });
      this.keys.push(b);
      this.keypad.append(b);
    }
    this.hint.className = 'hc-hint hidden';
    this.status.className = 'hc-status';
    this.status.setAttribute('role', 'status');
    const actions = document.createElement('div');
    actions.className = 'hc-actions';
    this.cancel.type = 'button';
    this.go.type = 'button';
    this.go.className = 'hc-go';
    actions.append(this.cancel, this.go);
    r.append(this.title, this.sub, this.input, this.keypad, this.hint, this.status, actions);
    document.body.append(r);
    this.words();
    onLang(() => this.words());
    onPadLabels(() => this.words()); // the buttons' names follow the controller
    this.cancel.addEventListener('click', () => this.close(true));
    this.go.addEventListener('click', () => void this.submit());
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing a code is not walking
      if (e.key === 'Enter') void this.submit();
      else if (e.key === 'Escape') this.close(false);
    });
  }

  private words(): void {
    this.title.textContent = t('home.title');
    this.sub.textContent = t('home.sub');
    this.input.placeholder = t('home.code');
    this.input.setAttribute('aria-label', t('home.code'));
    this.cancel.textContent = t('home.cancel');
    this.go.textContent = t('home.enter');
    this.hint.textContent = t('home.padHint', { type: btn('south'), del: btn('east') });
    ALPHABET.split('').forEach((c, i) => (this.keys[i].textContent = c));
    this.keys[DELETE].textContent = t('home.delete');
    this.keys[ENTER].textContent = t('home.enter');
  }

  /** `pad`: played with a controller, which gets the keypad. */
  show(home: Home, pad = false): void {
    if (this.open) return;
    this.open = true;
    this.home = home;
    this.pad = pad;
    this.typed = '';
    this.cursor = 0;
    this.input.value = '';
    this.input.readOnly = pad;
    this.status.textContent = '';
    this.go.disabled = false;
    this.keypad.classList.toggle('hidden', !pad);
    this.hint.classList.toggle('hidden', !pad);
    this.paint();
    if (document.pointerLockElement) document.exitPointerLock();
    this.root.classList.remove('hidden');
    if (!pad) this.input.focus({ preventScroll: true });
  }

  close(click: boolean): void {
    if (!this.open) return;
    this.open = false;
    this.closedAt = performance.now();
    this.input.value = ''; // never kept
    this.typed = '';
    this.home = null;
    this.root.classList.add('hidden');
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.onClose(click);
  }

  /** The keypad's cursor moves by one key (a controller's stick or D-pad). */
  padMove(dx: number, dy: number): void {
    if (!this.open || !this.pad) return;
    const row = this.cursor >= DELETE ? ROWS : Math.floor(this.cursor / COLS);
    const col = this.cursor >= DELETE ? (this.cursor === DELETE ? 0 : COLS - 1) : this.cursor % COLS;
    const r = Math.max(0, Math.min(ROWS, row + dy));
    const c = Math.max(0, Math.min(COLS - 1, col + dx));
    this.cursor = r === ROWS ? (c < COLS / 2 ? DELETE : ENTER) : r * COLS + c;
    this.paint();
  }

  /** ✕: the key under the cursor. */
  padPress(): void {
    if (this.open && this.pad) this.press(this.cursor);
  }

  /** ○: deletes the last character, or closes the card when there is none. */
  padBack(): void {
    if (!this.open || !this.pad) return;
    if (this.typed) this.press(DELETE);
    else this.close(false);
  }

  private press(i: number): void {
    if (i === ENTER) return void this.submit();
    if (i === DELETE) this.typed = this.typed.slice(0, -1);
    else if (this.typed.length < CODE_LENGTH) this.typed += ALPHABET[i];
    this.status.textContent = '';
    this.paint();
  }

  /** The field and the cursor, after a change. */
  private paint(): void {
    if (this.pad) this.input.value = this.typed.length > 5 ? `${this.typed.slice(0, 5)}-${this.typed.slice(5)}` : this.typed;
    this.keys.forEach((k, i) => k.classList.toggle('hc-on', this.pad && i === this.cursor));
  }

  private async submit(): Promise<void> {
    const home = this.home;
    const code = (this.pad ? this.typed : this.input.value).trim();
    if (!home || !code || this.go.disabled) return;
    this.go.disabled = true;
    this.status.textContent = '';
    const why = await this.try(home, code);
    if (!this.open) return;
    if (!why) return this.close(true);
    this.status.textContent = why;
    if (this.pad) {
      this.typed = '';
      this.paint();
    } else this.input.select();
    this.go.disabled = false;
  }
}
