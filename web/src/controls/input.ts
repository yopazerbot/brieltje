/**
 * Combines the controller (browser Gamepad API), keyboard/mouse and the touch
 * controls into one set of values per frame. Sticks: x to the right, y up
 * (forward) positive. Which controller it is and what its buttons are called:
 * src/controls/padFamily.ts.
 */
import { typing } from '../keys';
import { gamepads, seat } from '../seat';
import { hasTouchpad, notePad } from './padFamily';
import type { TouchControls } from './touch';

const DEAD_ZONE = 0.15;

// Button numbers in the browser's "standard" layout, by their place: Chrome and Edge use it for the
// DualSense, Xbox pads (XInput) and Nintendo's Pro Controller alike. Named here as on the DualSense
// (cross is the lowest face button: A on Xbox, B on Nintendo); create is View or − on the others.
const BTN = { cross: 0, circle: 1, square: 2, triangle: 3, l1: 4, r1: 5, l2: 6, r2: 7, create: 8, options: 9, l3: 10, up: 12, down: 13, left: 14, right: 15, touchpad: 17 };

export interface FrameInput {
  moveX: number;
  moveY: number;
  /** Look speed from the right stick, -1..1 */
  lookX: number;
  lookY: number;
  /** Mouse movement since last frame, in pixels */
  mouseX: number;
  mouseY: number;
  sprint: boolean;
  /** Jump was pressed this frame (Space, or Cross on the controller) */
  jumpPressed: boolean;
  /** Jump button is held down (hold to fly up) */
  jumpHeld: boolean;
  /** Fly down is held (C, or Circle on the controller) */
  downHeld: boolean;
  /** Left click (mouse captured) or R2: opens doors in Explore, shoots in Action */
  clickPressed: boolean;
  /** E or Triangle: opens doors in both modes */
  usePressed: boolean;
  /** E, Triangle or the touch Use button held down (helping a teammate up in Zombies) */
  useHeld: boolean;
  /** Right mouse button or L2 held: aim down the sights */
  aimHeld: boolean;
  /** R key or Square while playing: reload */
  reloadPressed: boolean;
  /** R, Square or the touch reload button held down (Zombies: held, it plants a row of stakes) */
  reloadHeld: boolean;
  menuPressed: boolean;
  fpsPressed: boolean;
  /** Cross on the controller: confirm in menus */
  confirmPressed: boolean;
  /** Square on the controller: change the graphics setting in menus */
  squarePressed: boolean;
  /** D-pad left/right in menus: walking speed down/up */
  speedStep: number;
  /** L1 (-1) or R1 (+1) in the menu: the previous or next tab */
  tabStep: number;
  /** Tab, or the touchpad (View or − without one) held: show the scoreboard */
  scoreHeld: boolean;
  /** A short press on the controller's touchpad, or View or − without one: the big map (M on the keyboard is handled in main.ts) */
  mapPressed: boolean;
  /** Left mouse button or R2 held (automatic fire) */
  fireHeld: boolean;
  /** Weapon key 1 to 4 pressed this frame (0: none) */
  weaponSlot: number;
  /** X or Delete (Circle on the controller): back out of the menu with a controller, close the feedback card */
  deletePressed: boolean;
  /** Next (+1) or previous (-1) weapon: mouse wheel, D-pad up/down, L1; 2 = Q, back to the last one */
  weaponCycle: number;
  /** G or R1: throw a grenade */
  throwPressed: boolean;
  /** G, R1 or the touch grenade button held down (Zombies: held, it places a claymore) */
  throwHeld: boolean;
  /** Driving: accelerate (W or Up, or R2 as far as it is pressed), 0..1 */
  throttle: number;
  /** Driving: brake, then reverse (S or Down, or L2), 0..1 */
  brake: number;
  anyPadButton: boolean;
}

export const NO_INPUT: FrameInput = {
  moveX: 0, moveY: 0, lookX: 0, lookY: 0, mouseX: 0, mouseY: 0, sprint: false,
  jumpPressed: false, jumpHeld: false, downHeld: false, clickPressed: false, usePressed: false, useHeld: false, aimHeld: false, reloadPressed: false, reloadHeld: false,
  menuPressed: false, fpsPressed: false, confirmPressed: false, squarePressed: false, speedStep: 0, tabStep: 0, scoreHeld: false, mapPressed: false, fireHeld: false, weaponSlot: 0, weaponCycle: 0, throwPressed: false, throwHeld: false, deletePressed: false, anyPadButton: false,
  throttle: 0, brake: 0,
};

/** Radial dead zone, rescaled so movement starts smoothly just outside it. */
function stick(x: number, y: number): [number, number] {
  const mag = Math.hypot(x, y);
  if (mag < DEAD_ZONE) return [0, 0];
  const scaled = Math.min(1, (mag - DEAD_ZONE) / (1 - DEAD_ZONE));
  return [(x / mag) * scaled, (y / mag) * scaled];
}

/** Keys the browser acts on (help, find, reload, caret browsing, the menu bar, quick find, back), kept from it while playing. */
const BROWSER_KEYS = new Set(['F1', 'F3', 'F5', 'F6', 'F7', 'F10', 'Slash', 'Quote', 'Backspace', 'ContextMenu']);

export class Input {
  padName: string | null = null;
  /** On-screen controls on a phone or tablet (when playing with touch) */
  touch: TouchControls | null = null;
  /** A menu is open (src/start.ts): Tab, Space and the arrow keys then work the page as usual. */
  menuOpen: () => boolean = () => false;
  /**
   * Split screen (src/seat.ts): a seat plays with its own controller only, by its index, and with the
   * keyboard and mouse only when it was given them (seat 1, instead of a controller).
   */
  private padIndex: number | null = seat ? seat.pad : null;
  private keyboard = !seat || seat.pad < 0;
  private keys = new Set<string>();
  private mouseX = 0;
  private mouseY = 0;
  private prevButtons: boolean[] = [];
  private padSprint = false;
  private touchpadAt = 0; // when the map button went down: a short press is the map, holding it the scores
  private keyMenu = false;
  private keyFps = false;
  private keyJump = false;
  private keyUse = false;
  private keyReload = false;
  private click = false;
  private leftHeld = false;
  private rightHeld = false;
  private slot = 0;
  private keyDelete = false;
  private keyThrow = false;
  private cycle = 0;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keyup', (e) => {
      if (!this.keyboard) return;
      // Alt on its own opens the browser's menu bar when it's let go.
      if (!this.menuOpen() && !typing(e) && (e.code === 'AltLeft' || e.code === 'AltRight')) e.preventDefault();
    });
    window.addEventListener('keydown', (e) => {
      if (!this.keyboard) return;
      if (e.code === 'Escape' && !e.repeat) this.keyMenu = true; // also from a field in the menu (the chat keeps its own Esc)
      if (typing(e)) return; // typing a name is not walking
      if (e.code === 'KeyF' && !e.repeat) this.keyFps = true;
      if (e.code === 'Space' && !e.repeat) this.keyJump = true;
      if (e.code === 'KeyE' && !e.repeat) this.keyUse = true;
      if (e.code === 'KeyR' && !e.repeat) this.keyReload = true;
      const digit = /^(?:Digit|Numpad)([1-8])$/.exec(e.code);
      if (digit && !e.repeat) this.slot = Number(digit[1]);
      if (e.code === 'KeyQ' && !e.repeat) this.cycle = 2;
      if (e.code === 'KeyG' && !e.repeat) this.keyThrow = true;
      if ((e.code === 'KeyX' || e.code === 'Delete') && !e.repeat) this.keyDelete = true;
      // While playing: no page scrolling or focus jumps. In a menu they move the keyboard's focus and the sliders.
      if (!this.menuOpen() && (e.code === 'Space' || e.code === 'Tab' || e.code.startsWith('Arrow'))) e.preventDefault();
      // And everything else stays in the game too (Yoshi): the browser's own keys (find, save, bookmark,
      // help, reload, the menu bar) do nothing while playing. Ctrl+W and Ctrl+T are the browser's alone.
      if (!this.menuOpen() && (e.ctrlKey || e.metaKey || e.altKey || BROWSER_KEYS.has(e.code))) e.preventDefault();
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('mousemove', (e) => {
      if (!this.keyboard || document.pointerLockElement !== this.canvas) return;
      this.mouseX += e.movementX;
      this.mouseY += e.movementY;
    });
    // Clicks count only while playing with the mouse captured.
    document.addEventListener('mousedown', (e) => {
      if (!this.keyboard || document.pointerLockElement !== this.canvas) return;
      if (e.button === 0) this.click = this.leftHeld = true;
      if (e.button === 2) this.rightHeld = true;
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.rightHeld = false;
      if (e.button === 0) this.leftHeld = false;
    });
    document.addEventListener('wheel', (e) => {
      if (document.pointerLockElement === this.canvas && e.deltaY) this.cycle = e.deltaY > 0 ? 1 : -1;
    }, { passive: true });
    document.addEventListener('contextmenu', (e) => {
      if (document.pointerLockElement === this.canvas) e.preventDefault();
    });
  }

  /** Shake the controller (if it can): strong and weak motor 0..1, for `ms` milliseconds. */
  rumble(strong: number, weak: number, ms: number): void {
    const act = this.pad()?.vibrationActuator as { playEffect?: (t: string, p: object) => Promise<unknown> } | undefined;
    act?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
  }

  private pad(): Gamepad | null {
    const pads = gamepads();
    if (this.padIndex !== null) {
      // A seat: its own controller, whatever kind it is; none when it plays with the keyboard (-1).
      const own = this.padIndex >= 0 ? pads[this.padIndex] : null;
      return own?.connected ? own : null;
    }
    let found: Gamepad | null = null;
    for (const p of pads) {
      if (!p || !p.connected) continue;
      if (!found || (p.mapping === 'standard' && found.mapping !== 'standard')) found = p;
    }
    return found;
  }

  poll(): FrameInput {
    const out: FrameInput = {
      ...NO_INPUT,
      mouseX: this.mouseX, mouseY: this.mouseY,
      menuPressed: this.keyMenu, fpsPressed: this.keyFps, jumpPressed: this.keyJump,
      clickPressed: this.click, usePressed: this.keyUse, reloadPressed: this.keyReload, aimHeld: this.rightHeld,
      fireHeld: this.leftHeld && document.pointerLockElement === this.canvas, weaponSlot: this.slot, weaponCycle: this.cycle,
      deletePressed: this.keyDelete, throwPressed: this.keyThrow,
    };
    this.keyDelete = this.keyThrow = false;
    this.slot = this.cycle = 0;
    this.mouseX = this.mouseY = 0;
    this.keyMenu = this.keyFps = this.keyJump = this.keyUse = this.keyReload = this.click = false;

    // Keyboard
    const k = (c: string) => this.keys.has(c);
    out.moveY += (k('KeyW') || k('ArrowUp') ? 1 : 0) - (k('KeyS') || k('ArrowDown') ? 1 : 0);
    out.moveX += (k('KeyD') || k('ArrowRight') ? 1 : 0) - (k('KeyA') || k('ArrowLeft') ? 1 : 0);
    out.sprint = k('ShiftLeft') || k('ShiftRight');
    out.jumpHeld = k('Space');
    out.downHeld = k('ControlLeft') || k('ControlRight') || k('KeyC');
    out.useHeld = k('KeyE');
    out.reloadHeld = k('KeyR');
    out.throwHeld = k('KeyG');
    out.scoreHeld = k('Tab');
    out.throttle = k('KeyW') || k('ArrowUp') ? 1 : 0;
    out.brake = k('KeyS') || k('ArrowDown') ? 1 : 0;

    // Controller
    const p = this.pad();
    this.padName = p ? p.id : null;
    notePad(p);
    if (p) {
      const pressed = p.buttons.map((b) => b.pressed);
      const edge = (i: number) => pressed[i] && !this.prevButtons[i];
      out.anyPadButton = pressed.some((v, i) => v && !this.prevButtons[i]);
      // Without the standard layout, the right stick's vertical axis is axis 5 (DirectInput).
      const ry = p.mapping === 'standard' || p.axes.length < 6 ? p.axes[3] : p.axes[5];
      const [lx, ly] = stick(p.axes[0] ?? 0, p.axes[1] ?? 0);
      const [rx, rys] = stick(p.axes[2] ?? 0, ry ?? 0);
      out.moveX += lx;
      out.moveY -= ly; // stick up is negative
      out.lookX = rx;
      out.lookY = -rys;
      // L3 switches sprint on; it stays on until the left stick is released, like in most games.
      if (edge(BTN.l3)) this.padSprint = true;
      if (lx === 0 && ly === 0) this.padSprint = false;
      out.sprint ||= this.padSprint;
      if (edge(BTN.options)) out.menuPressed = true;
      // The touchpad (PlayStation) is the map and the scores, Create the FPS counter. Without a
      // touchpad, View or − (Create's place) is the map and the scores; the FPS counter is in Settings.
      const touchpad = hasTouchpad();
      const mapBtn = touchpad ? BTN.touchpad : BTN.create;
      if (touchpad && edge(BTN.create)) out.fpsPressed = true;
      if (edge(BTN.cross)) {
        out.confirmPressed = true;
        out.jumpPressed = true;
      }
      out.jumpHeld ||= !!pressed[BTN.cross];
      out.downHeld ||= !!pressed[BTN.circle];
      if (edge(BTN.r2)) out.clickPressed = true;
      if (edge(BTN.triangle)) out.usePressed = true;
      out.useHeld ||= !!pressed[BTN.triangle];
      out.aimHeld ||= (p.buttons[BTN.l2]?.value ?? 0) > 0.3;
      out.throttle = Math.max(out.throttle, p.buttons[BTN.r2]?.value ?? 0);
      out.brake = Math.max(out.brake, p.buttons[BTN.l2]?.value ?? 0);
      if (edge(BTN.square)) {
        out.squarePressed = true;
        out.reloadPressed = true;
      }
      out.reloadHeld ||= !!pressed[BTN.square];
      const now = performance.now();
      if (edge(mapBtn)) this.touchpadAt = now;
      out.scoreHeld ||= !!pressed[mapBtn] && now - this.touchpadAt > 250;
      if (!pressed[mapBtn] && this.prevButtons[mapBtn] && now - this.touchpadAt <= 250) out.mapPressed = true;
      out.fireHeld ||= !!pressed[BTN.r2];
      if (edge(BTN.circle)) out.deletePressed = true;
      if (edge(BTN.up)) out.weaponCycle = 1;
      if (edge(BTN.r1)) out.throwPressed = true;
      out.throwHeld ||= !!pressed[BTN.r1];
      if (edge(BTN.down) || edge(BTN.l1)) out.weaponCycle = -1;
      if (edge(BTN.l1)) out.tabStep -= 1;
      if (edge(BTN.r1)) out.tabStep += 1;
      if (edge(BTN.left)) out.speedStep -= 1;
      if (edge(BTN.right)) out.speedStep += 1;
      this.prevButtons = pressed;
    }

    this.touch?.into(out);
    const mag = Math.hypot(out.moveX, out.moveY);
    if (mag > 1) {
      out.moveX /= mag;
      out.moveY /= mag;
    }
    return out;
  }
}
