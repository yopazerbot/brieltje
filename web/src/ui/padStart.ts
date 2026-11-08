/**
 * The start screen with only a controller (Yoshi, 8 Nov 2026: "Make it simple for console players to do the setup menu
 * as well"). Once a controller is seen (src/start.ts: connected, or a button pressed) the start panel goes into pad mode
 * for the rest of the visit. Pad mode only adds; the keyboard, mouse and touch flows stay as they are:
 *
 * - Guest: a name ready in the field (src/ui/guestName.ts, "Kerkuil-27"), so ✕ / A goes straight on; "Different name"
 *   rolls another, and typing still works. The menu keeps the name played with (briel.nickname, src/ui/menu.ts).
 * - Log in: "Log in with your phone" first and big in the login card; pressed, the QR code and the 2-digit number show
 *   right in the card (src/ui/phonePair.ts, the same pairing as the account card). Name and password stay under it.
 * - The focus: a thick sun-yellow ring that grows a little (src/startScreen.css), on each step's likely choice
 *   (src/ui/startFlow.ts defaultControl). Zombies is picked on step 3 unless a mode was picked before, and the
 *   Controller button has the focus, so the last press starts Zombies with the controller.
 * - L1 / R1 (LB / RB): the who cards on step 1, the game modes on step 3.
 * - The button hints at the panel's foot, named as the controller prints them (src/controls/padFamily.ts).
 */
import { btn, onPadLabels, type PadButton } from '../controls/padFamily';
import { onLang, t, type PlainKey } from '../i18n';
import type { Me } from '../net/client';
import { guestName } from './guestName';
import type { PadNav } from './padNav';
import { PhonePair } from './phonePair';
import type { StartFlow } from './startFlow';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface PadStartHooks {
  /** Who the server knows this browser as (the session cookie), or null. */
  session: () => Me | null;
  /** A login on its way: the returned function takes its answer, and says whether it still counts (src/start.ts). */
  begin: () => (account: Me) => boolean;
}

export class PadStart {
  private panel = $('start-panel');
  private nick = $<HTMLInputElement>('nick');
  private phoneGo = $<HTMLButtonElement>('login-phone');
  private pairBox = $('login-pair');
  private pairNew = $<HTMLButtonElement>('login-pair-new');
  private hints = $('pad-hints');
  private hintKey = '';
  private on = false;
  private pair: PhonePair;

  constructor(private flow: StartFlow, private nav: PadNav, private hooks: PadStartHooks) {
    this.pair = new PhonePair(
      {
        qr: document.getElementById('login-qr') as unknown as SVGSVGElement,
        url: $('login-pair-url'),
        code: $('login-pair-code'),
        check: $('login-pair-check'),
        state: $('login-pair-state'),
      },
      {
        live: () => this.pairOpen(),
        done: (username) => void this.hooks.begin()({ username, role: 'player' }),
      },
    );
    $('nick-roll').addEventListener('click', () => this.rollName());
    this.phoneGo.addEventListener('click', () => this.openPair());
    this.pairNew.addEventListener('click', () => void this.pair.start());
    onLang(() => this.drawHints(true));
    onPadLabels(() => this.drawHints(true));
  }

  /** Pad mode is on. */
  get active(): boolean {
    return this.on;
  }

  /** A controller came in: pad mode for the rest of this visit. */
  enter(): void {
    if (this.on) return;
    this.on = true;
    this.flow.padMode = true;
    this.panel.classList.add('pad-mode');
    if (!this.hooks.session() && !this.nick.value.trim()) this.nick.value = guestName();
    // A narrow screen shows one who card: the guest's, unless the last visit logged in.
    if (this.flow.lastWho() !== 'account') this.flow.showCard('guest');
    this.flow.recommendZombies();
    this.flow.draw(); // "Play again as before" can show now that a name is there
    this.drawHints(true);
  }

  /** Every frame the controller is read on the start screen: the phone's code goes once it is no longer needed. */
  tick(): void {
    if (!this.on) return;
    if (this.pairOpen() && (this.flow.step !== 1 || this.hooks.session())) this.closePair(false);
    this.drawHints();
  }

  /** ○ / B on the start screen: the phone's code closes first. True when that was what it did. */
  back(): boolean {
    if (!this.on || !this.pairOpen()) return false;
    this.closePair(true);
    return true;
  }

  /** L1 (-1) or R1 (+1): the who cards on step 1, the game modes on step 3. */
  shoulder(dir: number): void {
    if (!this.on) return;
    if (this.flow.step === 1 && !this.hooks.session()) {
      const which = dir < 0 ? 'login' : 'guest';
      this.flow.showCard(which);
      this.nav.focus(which === 'guest' ? $('guest-go') : this.pairOpen() ? this.pairNew : this.phoneGo);
    } else if (this.flow.step === 3) {
      const modes = [...document.querySelectorAll<HTMLButtonElement>('#mode-start .seg-btn')].filter((b) => !b.disabled && !b.closest('.hidden'));
      const z = $('mode-start').classList.contains('z');
      const now = modes.findIndex((b) => (z ? b.dataset.startMode === 'zombies' : !!b.dataset.play && b.classList.contains('selected')));
      const next = modes[(Math.max(0, now) + dir + modes.length) % modes.length];
      next?.click(); // the focus stays where it is: on Controller, the start
    }
  }

  private rollName(): void {
    const old = this.nick.value.trim();
    let name = guestName();
    for (let i = 0; i < 5 && name === old; i++) name = guestName();
    this.nick.value = name;
    this.nick.dispatchEvent(new Event('input', { bubbles: true })); // a complaint about the name goes
    this.flow.draw();
  }

  private pairOpen(): boolean {
    return !this.pairBox.classList.contains('hidden');
  }

  private openPair(): void {
    this.pairBox.classList.remove('hidden');
    this.phoneGo.classList.add('hidden');
    $('login-card').classList.add('pairing');
    void this.pair.start();
    this.nav.focus(this.pairNew);
  }

  private closePair(focus: boolean): void {
    this.pair.stop();
    this.pairBox.classList.add('hidden');
    this.phoneGo.classList.remove('hidden');
    $('login-card').classList.remove('pairing');
    if (focus) this.nav.focus(this.phoneGo);
  }

  /** The hints for the step showing: ✕ / A chooses, ○ / B goes back, L1 / R1 where they do something. */
  private drawHints(force = false): void {
    if (!this.on) return;
    const step = this.flow.step;
    const who = step === 1 && !this.hooks.session();
    const back = step > 1 || this.pairOpen();
    const key = `${step}${who}${back}`;
    if (!force && key === this.hintKey) return;
    this.hintKey = key;
    const rows: [PadButton[], PlainKey][] = [[['south'], 'pad.hintChoose']];
    if (back) rows.push([['east'], 'pad.hintBack']);
    if (who) rows.push([['l1', 'r1'], 'pad.hintWho']);
    if (step === 3) rows.push([['l1', 'r1'], 'pad.hintMode']);
    this.hints.replaceChildren(...rows.map(([buttons, text]) => {
      const item = document.createElement('span');
      item.className = 'pad-hint';
      for (const b of buttons) {
        const cap = document.createElement('kbd');
        cap.className = `pad-key pad-${b}`;
        cap.textContent = btn(b);
        item.append(cap);
      }
      const label = document.createElement('span');
      label.textContent = t(text);
      item.append(label);
      return item;
    }));
  }
}
