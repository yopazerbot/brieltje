import type { FrameInput } from './input';
import { onLang, t, type PlainKey } from '../i18n';

/**
 * Touch controls for phones and tablets: a stick that appears under the left thumb,
 * drag anywhere on the right to look (also while holding Fire), and buttons for the
 * rest. They fill in the same frame input as the keyboard and the controller.
 */

const STICK_R = 56; // px: how far the stick's knob goes from where the thumb landed
const LOOK = 1.6;   // look speed: a drag in px counts as this many mouse px

type Button = 'fire' | 'aim' | 'jump' | 'use' | 'reload' | 'nade' | 'weapon' | 'down' | 'run' | 'menu';

/**
 * Which buttons show depends on what you are doing: walking (Explore, or on a horse), fighting
 * (Action on foot), in a car (at the wheel or riding along), on a bike (laid out as in a car, the
 * Bell where the car's Brake is), or in a drop (shared/parachute.mjs): the
 * free fall (Open the canopy, Dive) and under the canopy (the stick steers). Each state
 * has its own arrangement in style.css (`body[data-touch=...]`), so no button is left where it
 * makes no sense, and the HUD keeps clear of the ones that show.
 */
export type TouchState = 'walk' | 'fight' | 'car' | 'bike' | 'fall' | 'canopy';

// Each button's label (src/i18n.ts) in the states it shows in; '⇄' and '☰' are signs, the same in every language.
const BUTTONS: [Button, Partial<Record<TouchState, PlainKey | '⇄' | '☰'>>][] = [
  ['fire', { fight: 'touch.fire' }],
  ['aim', { fight: 'touch.aim' }],
  ['reload', { fight: 'touch.reload' }],
  ['nade', { fight: 'touch.nade' }],
  ['weapon', { fight: '⇄' }],
  ['jump', { walk: 'touch.jump', fight: 'touch.jump', car: 'touch.brake', bike: 'touch.bell', fall: 'touch.open' }], // the handbrake in a car, the bell on a bike, the canopy in a free fall
  ['use', { walk: 'touch.use', fight: 'touch.use', car: 'touch.use', bike: 'touch.use' }],
  ['down', { walk: 'touch.down', fight: 'touch.down', fall: 'touch.dive' }],
  ['run', { walk: 'touch.run', fight: 'touch.run' }],
  ['menu', { walk: '☰', fight: '☰', car: '☰', bike: '☰', fall: '☰', canopy: '☰' }],
];
const label = (k: PlainKey | '⇄' | '☰') => (k === '⇄' || k === '☰' ? k : t(k));

export class TouchControls {
  readonly root = document.createElement('div');
  /** A short tick on each button press where the browser can vibrate (Android; Safari can't). */
  haptics = true;
  private stickBase = document.createElement('div');
  private stickKnob = document.createElement('div');
  private stick: { id: number; x: number; y: number } | null = null;
  private moveX = 0;
  private moveY = 0;
  private lookers = new Map<number, { x: number; y: number }>();
  private lookX = 0;
  private lookY = 0;
  private held = new Map<Button, number>(); // button -> pointer holding it
  private pressed = new Set<Button>();
  private aimOn = false;
  private runOn = false;
  private state: TouchState | '' = '';
  private els = new Map<Button, HTMLElement>();

  constructor() {
    this.root.id = 'touch';
    this.root.className = 'hidden';
    this.stickBase.className = 'stick';
    this.stickKnob.className = 'knob';
    this.stickBase.append(this.stickKnob);
    this.root.append(this.stickBase);
    for (const [name] of BUTTONS) {
      const b = document.createElement('div');
      b.className = `tbtn t-${name} hidden`;
      b.addEventListener('pointerdown', (e) => this.press(e, name));
      this.root.append(b);
      this.els.set(name, b);
    }
    // The open area: the left part starts the stick, the rest looks around.
    this.root.addEventListener('pointerdown', (e) => {
      if (e.target !== this.root) return;
      e.preventDefault();
      try {
        this.root.setPointerCapture(e.pointerId);
      } catch {
        // not a live pointer
      }
      if (!this.stick && e.clientX < window.innerWidth * 0.42) {
        this.stick = { id: e.pointerId, x: e.clientX, y: e.clientY };
        this.stickBase.style.left = `${e.clientX}px`;
        this.stickBase.style.top = `${e.clientY}px`;
        this.stickBase.classList.add('active');
      } else this.lookers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    const move = (e: PointerEvent) => {
      if (this.stick?.id === e.pointerId) {
        const dx = e.clientX - this.stick.x;
        const dy = e.clientY - this.stick.y;
        const len = Math.hypot(dx, dy);
        const k = len > STICK_R ? STICK_R / len : 1;
        this.stickKnob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
        const mag = Math.min(1, len / STICK_R);
        const live = mag < 0.12 ? 0 : (mag - 0.12) / 0.88; // a small dead zone
        this.moveX = len ? (dx / len) * live : 0;
        this.moveY = len ? (-dy / len) * live : 0;
      }
      const look = this.lookers.get(e.pointerId);
      if (look) {
        this.lookX += e.clientX - look.x;
        this.lookY += e.clientY - look.y;
        look.x = e.clientX;
        look.y = e.clientY;
      }
    };
    const end = (e: PointerEvent) => {
      if (this.stick?.id === e.pointerId) {
        this.stick = null;
        this.moveX = this.moveY = 0;
        this.stickKnob.style.transform = '';
        this.stickBase.classList.remove('active');
        this.stickBase.style.left = this.stickBase.style.top = '';
      }
      this.lookers.delete(e.pointerId);
      for (const [b, id] of this.held) {
        if (id !== e.pointerId) continue;
        this.held.delete(b);
        this.els.get(b)?.classList.remove('down');
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    onLang(() => {
      for (const [name, labels] of BUTTONS) {
        const k = this.state && labels[this.state];
        if (k) this.els.get(name)!.textContent = label(k);
      }
    });
  }

  private press(e: PointerEvent, b: Button): void {
    e.preventDefault();
    e.stopPropagation();
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // not a live pointer (a scripted tap): nothing to capture
    }
    if (this.haptics) navigator.vibrate?.(8);
    this.pressed.add(b);
    this.held.set(b, e.pointerId);
    if (b === 'aim') this.aimOn = !this.aimOn;
    if (b === 'run' && !this.scoped) this.runOn = !this.runOn; // through a scope the button holds your breath instead
    this.els.get('aim')?.classList.toggle('on', this.aimOn);
    this.els.get('run')?.classList.toggle('on', this.runOn);
    this.els.get(b)?.classList.add('down');
    if (b === 'fire') this.lookers.set(e.pointerId, { x: e.clientX, y: e.clientY }); // aim while firing
  }

  show(on: boolean): void {
    this.root.classList.toggle('hidden', !on);
    document.body.classList.toggle('touch', on);
  }

  private scoped = false;
  /** Looking through a scope: the Run button becomes Breath, held to hold your breath (weapon.ts). */
  setScoped(on: boolean): void {
    if (on === this.scoped) return;
    this.scoped = on;
    const el = this.els.get('run');
    if (el && !el.classList.contains('hidden')) el.textContent = label(on ? 'touch.breath' : 'touch.run');
  }

  /** Which buttons show: in a drop (its free fall or under the canopy), fighting on foot, walking, in a car, or on a bike. */
  setState(action: boolean, inCar: boolean, drop: 'fall' | 'canopy' | null = null, bike = false): void {
    const state: TouchState = drop ?? (bike ? 'bike' : inCar ? 'car' : action ? 'fight' : 'walk');
    if (state === this.state) return;
    this.state = state;
    document.body.dataset.touch = state === 'bike' ? 'car' : state; // the layout for this state (style.css); a bike's is the car's
    for (const [name, labels] of BUTTONS) {
      const el = this.els.get(name)!;
      const k = labels[state];
      el.classList.toggle('hidden', !k);
      if (k) el.textContent = label(k);
    }
    if (state !== 'fight') this.aimOn = false;
    this.els.get('aim')!.classList.toggle('on', this.aimOn);
  }

  /** Add this frame's touches to the frame input (and forget the taps). */
  into(out: FrameInput): void {
    if (this.root.classList.contains('hidden')) return;
    const has = (b: Button) => this.pressed.has(b);
    const holds = (b: Button) => this.held.has(b);
    out.moveX += this.moveX;
    out.moveY += this.moveY;
    out.mouseX += this.lookX * LOOK;
    out.mouseY += this.lookY * LOOK;
    this.lookX = this.lookY = 0;
    out.throttle = Math.max(out.throttle, this.moveY);
    out.brake = Math.max(out.brake, -this.moveY);
    out.sprint ||= this.runOn; // Run stays on until it is tapped again
    out.steadyHeld ||= this.scoped && holds('run');
    out.jumpPressed ||= has('jump');
    out.jumpHeld ||= holds('jump');
    out.downHeld ||= holds('down');
    out.usePressed ||= has('use');
    out.useHeld ||= holds('use');
    out.clickPressed ||= has('fire');
    out.fireHeld ||= holds('fire');
    out.aimHeld ||= this.aimOn;
    out.reloadPressed ||= has('reload');
    out.reloadHeld ||= holds('reload');
    out.throwPressed ||= has('nade');
    out.throwHeld ||= holds('nade');
    if (has('weapon')) out.weaponCycle = 1;
    out.menuPressed ||= has('menu');
    this.pressed.clear();
  }
}
