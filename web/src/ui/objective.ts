import * as THREE from 'three';
import { t } from '../i18n';
import { FLAG_COLORS, baseOf, fieldOf } from '../../shared/flagFields.mjs';
import type { FlagGameView, FlagTeam } from './flagHud';
import './objective.css';

/**
 * What a new player needs in Steal the flag and Attack and defend (Yoshi, 21 Nov 2026: many on the game night never
 * played), without a card over the game:
 *
 * - Before play, on the host's countdown card (ui/hostNotice.ts, server/host.mjs startIn), one more line in your team's
 *   colour: your team and your task ("You are Blue · Bring the red flag to the church"). The team is the host's for the
 *   evening when there are two (server/modes.mjs deals them so); not known yet, the line says the task for both.
 * - In the first seconds of play (and of Attack and defend's second round, and after the host swaps the sides), and for
 *   a few seconds each time you come back, a small marker over each flag that matters: "Their flag · 220 m", and "Your
 *   flag" when it is away from home (in Attack and defend the defenders' always: it is theirs to guard). Over the flag
 *   when it is in view, at the left or right edge with an arrow when it is not; never in the middle of the view (it
 *   moves up out of the crosshair's way and fades) and never over the touch buttons. It fades out by itself.
 *
 * Everything the server sends goes in as text only (textContent).
 */

const START_MS = 15_000;
const BACK_MS = 6000;
const SWAP_MS = 8000;
/** Kept clear round the screen's middle, as a share of its smaller side (and the marker's own height): the crosshair's. */
const MIDDLE = 0.12;

type Which = 'theirs' | 'yours';
type Mark = { el: HTMLDivElement; text: HTMLSpanElement; shown: boolean; key: string };

export class Objective {
  private task = document.createElement('div');
  private marks: Record<Which, Mark>;
  private until = 0;
  private wasOn = false;
  private wasAlive = true;
  private phase = '';
  /** Your evening team when the host has two (server/host.mjs), so your Steal the flag team before it starts */
  private evening: FlagTeam | null = null;
  private touchRects: DOMRect[] = [];
  private hudRects: DOMRect[] = [];
  private touchAt = 0;
  private v = new THREE.Vector3();

  /** `bar`: the host's countdown card (#host-bar), which the task line goes into. */
  constructor(bar: HTMLElement | null, parent: HTMLElement = document.body) {
    this.task.className = 'obj-task';
    this.task.hidden = true;
    bar?.append(this.task);
    const make = (): Mark => {
      const el = document.createElement('div');
      el.className = 'obj-mark';
      const dot = document.createElement('i');
      const text = document.createElement('span');
      el.append(dot, text);
      parent.append(el);
      return { el, text, shown: false, key: '' };
    };
    this.marks = { theirs: make(), yours: make() };
  }

  /** The host's teams for the evening (server/host.mjs eveningteams): `count` of them, `team` yours or null. */
  setEvening(count: unknown, team: string | null): void {
    this.evening = count === 2 && (team === 'blue' || team === 'red') ? team : null;
  }

  /**
   * An announcement on the host's card: the next game's countdown (`kind` and its `args`: Steal the flag's field,
   * Attack and defend's first defenders) gets your task line; anything else none.
   */
  countdown(kind: unknown, args: unknown): void {
    const a = (args && typeof args === 'object' ? args : {}) as { place?: unknown; defend?: unknown };
    const team = this.evening;
    const church = t('obj.place.church');
    let line = '';
    if (kind === 'flag') {
      const red = a.place === 'village' ? 'obj.place.sparrenhof' : a.place === 'compact' ? 'obj.place.molenhoek' : 'obj.place.base';
      line = team ? t('obj.cd.flag', { team: t(`eteam.${team}`), flag: t(`flag.of.${team === 'blue' ? 'red' : 'blue'}`), place: team === 'blue' ? church : t(red) }) : t('obj.cd.any');
    } else if (kind === 'assault') {
      const def = a.defend === 'blue' || a.defend === 'red' ? a.defend : null;
      line = !def ? t('obj.cd.assaultAny')
        : !team ? t('obj.cd.defends', { team: t(`eteam.${def}`), place: church })
        : team === def ? t('obj.cd.defend', { team: t(`eteam.${team}`), place: church })
        : t('obj.cd.attack', { team: t(`eteam.${team}`), flag: t(`flag.of.${def}`), place: church });
    }
    this.task.textContent = line;
    this.task.hidden = !line;
    this.task.style.setProperty('--team', line && team ? FLAG_COLORS[team] : '#fbf6ea');
  }

  /** The markers again for `ms` (the host swapped the sides: your base is the other one now). */
  remind(ms = SWAP_MS): void {
    this.until = Math.max(this.until, performance.now() + ms);
  }

  /**
   * Every frame. `v`: Steal the flag's view while it is played, else null; `mine`: your team; `alive`: not down;
   * `me`: your feet; `where`: where a player is drawn now (null: not drawn, so neither is a flag they carry).
   */
  update(v: FlagGameView | null, mine: FlagTeam | null, alive: boolean, camera: THREE.PerspectiveCamera, me: { x: number; y: number; z: number }, where: (name: string) => { x: number; y: number; z: number } | null, myName: string): void {
    const now = performance.now();
    const on = !!v && !!mine;
    if (on && !this.wasOn) this.until = now + START_MS; // the game starts, or you join it while it is played
    const phase = v?.assault ? `${v.assault.round}:${v.assault.phase}` : '';
    if (on && phase !== this.phase && v?.assault?.phase === 'live' && this.phase) this.until = now + START_MS; // round 2
    this.phase = phase;
    if (on && alive && !this.wasAlive) this.until = Math.max(this.until, now + BACK_MS); // back at your base
    this.wasOn = on;
    this.wasAlive = alive;
    const show = on && alive && now < this.until && v?.assault?.phase !== 'break';
    if (!show || !v || !mine) {
      this.hide('theirs');
      this.hide('yours');
      return;
    }
    const theirs: FlagTeam = mine === 'blue' ? 'red' : 'blue';
    const a = v.assault;
    // Attack and defend: only the defenders' flag moves; the camp's is nobody's to take.
    const want: Record<Which, boolean> = a
      ? { theirs: a.def === theirs, yours: a.def === mine }
      : { theirs: true, yours: v.flags[mine].at !== 'home' };
    const w = window.innerWidth;
    const h = window.innerHeight;
    const touch = document.body.classList.contains('touch');
    if (now - this.touchAt > 500) { // the touch buttons and the HUD's boxes, kept clear (looked up twice a second)
      this.touchAt = now;
      const rects = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)]
        .map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0 && r.width < w * 0.45 && r.height < h * 0.45);
      this.touchRects = rects('#touch > *');
      this.hudRects = [...this.touchRects, ...rects('#hud > *, #hud-top > *')];
    }
    const placed: DOMRect[] = [];
    for (const which of ['theirs', 'yours'] as const) {
      const team = which === 'theirs' ? theirs : mine;
      const at = want[which] ? this.flagAt(v, team, where, myName) : null;
      if (!at) {
        this.hide(which);
        continue;
      }
      placed.push(this.place(which, team, at, me, camera, w, h, touch, placed));
    }
  }

  /** Where `team`'s flag is now, or null (carried by someone not drawn, or by you). */
  private flagAt(v: FlagGameView, team: FlagTeam, where: (name: string) => { x: number; y: number; z: number } | null, myName: string): { x: number; y: number; z: number } | null {
    const f = v.flags[team];
    if (f.at === 'carried') return f.by && f.by !== myName ? where(f.by) : null;
    if (f.at === 'ground') return { x: f.x ?? 0, y: f.y ?? 0, z: f.z ?? 0 };
    const [x, z, y] = baseOf(fieldOf(v.field), team, !!v.swapped).stand;
    return { x, y, z };
  }

  private hide(which: Which): void {
    const m = this.marks[which];
    if (!m.shown) return;
    m.shown = false;
    m.el.style.opacity = '0';
  }

  /** One marker put on screen: over the flag in view, else at the edge it is towards. Returns where it went. */
  private place(which: Which, team: FlagTeam, at: { x: number; y: number; z: number }, me: { x: number; y: number; z: number }, camera: THREE.PerspectiveCamera, w: number, h: number, touch: boolean, taken: DOMRect[]): DOMRect {
    const m = this.marks[which];
    const d = Math.hypot(at.x - me.x, at.z - me.z);
    const metres = d < 100 ? Math.round(d) : Math.round(d / 10) * 10;
    const key = `${which}:${team}:${metres}:${t('obj.theirs', { m: 0 })}`;
    if (key !== m.key) {
      m.key = key;
      m.text.textContent = t(which === 'theirs' ? 'obj.theirs' : 'obj.yours', { m: metres });
      m.el.style.setProperty('--team', FLAG_COLORS[team]);
    }
    const mw = m.el.offsetWidth || 120;
    const mh = m.el.offsetHeight || 24;
    // The view's band: under the game's bar and the flag chips, over the touch buttons (or the weapon list).
    const top = Math.max(h * 0.2, touch ? 96 : 120) + mh / 2;
    const bottom = Math.max(top + mh, h * (touch ? 0.52 : 0.66) - mh / 2);
    const edge = 16 + mw / 2;
    // In the camera's own space: x to the right, y up, -z ahead (the staff's top, so the marker sits over the flag).
    const v = this.v.set(at.x, at.y + 2.6, at.z).applyMatrix4(camera.matrixWorldInverse);
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const tanH = tanV * camera.aspect;
    let side: 'view' | 'left' | 'right' = 'view';
    let x: number, y: number;
    const nx = v.z < -0.3 ? v.x / -v.z / tanH : Infinity;
    const ny = v.z < -0.3 ? v.y / -v.z / tanV : 0;
    if (Math.abs(nx) <= 0.9) {
      x = (nx + 1) / 2 * w;
      y = (1 - ny) / 2 * h - mh / 2 - 8; // its pointer at the flag
    } else {
      side = v.x >= 0 ? 'right' : 'left';
      x = side === 'right' ? w - edge : edge;
      y = v.z < -0.3 ? (1 - ny) / 2 * h : h * 0.42; // behind you: half way down the band
    }
    x = Math.min(w - edge, Math.max(edge, x));
    y = Math.min(bottom, Math.max(top, y));
    // Never in the middle of the view: up out of the crosshair's way, and fainter there.
    const clear = Math.min(w, h) * MIDDLE + mh / 2;
    let faint = false;
    if (Math.abs(x - w / 2) < clear + mw / 2 && Math.abs(y - h / 2) < clear) {
      y = h / 2 - clear;
      faint = true;
    }
    // Never over a touch button, nor at an edge over the HUD (the player list, the weapons, the chat), nor on the other
    // marker: at an edge it moves in towards the middle, in view it moves up; never into the crosshair's room.
    const box = () => new DOMRect(x - mw / 2, y - mh / 2, mw, mh);
    const hits = (r: DOMRect, b: DOMRect) => b.left < r.right + 4 && b.right > r.left - 4 && b.top < r.bottom + 4 && b.bottom > r.top - 4;
    for (let pass = 0; pass < 4; pass++) {
      const r = (side === 'view' ? this.touchRects : this.hudRects).find((q) => hits(q, box()));
      if (!r) break;
      if (side === 'right') x = Math.max(w / 2 + clear + mw / 2, r.left - mw / 2 - 8);
      else if (side === 'left') x = Math.min(w / 2 - clear - mw / 2, r.right + mw / 2 + 8);
      else y = Math.max(mh / 2, r.top - mh / 2 - 8);
    }
    for (const r of taken) if (hits(r, box())) y = r.bottom + mh / 2 + 4;
    m.el.dataset.side = side;
    m.el.style.transform = `translate(${Math.round(x - mw / 2)}px, ${Math.round(y - mh / 2)}px)`;
    m.el.style.opacity = faint ? '0.55' : '1';
    m.shown = true;
    return box();
  }
}
