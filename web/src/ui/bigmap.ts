import { PORTALS, type Portal } from '../../shared/portals.mjs';
import HORSES from '../../shared/horses.json';
import STREETS from '../data/streets.json';
import type { FrameInput } from '../controls/input';
import type { DipSpec, Prism, Ring, Room, Surroundings } from '../world/houseData';
import { dist, onLang, t, type PlainKey } from '../i18n';
import { moveKeys, typing } from '../keys';
import { key, type Control } from '../shortcuts';

/**
 * The big map: the whole area at once, north up, drawn from the same data as the world (roads,
 * paving, fields, woods, water, hedges, buildings, trees), with the street names from the road
 * register (tools/streets.py), the portals, the main places called out, and you, the other
 * players, the cars and the horses as they move. It is the menu's first tab (mounted in its page):
 * M opens the menu on it (a short press on the controller's touchpad, a tap on the minimap), and M
 * again goes back to the game. Drag, W A S D or the left stick moves it, the wheel, a pinch or
 * R2/L2 zooms. A click on a place shows it and gives directions there; a click anywhere else sets a
 * waypoint, and ✕ on the controller sets one at the cross in the middle. The way there along the
 * roads (ui/route.ts) is drawn on this map and on the minimap. No travelling from the map: the
 * portals are for that (Yoshi). It draws only while its tab shows, and the world isn't drawn then.
 *
 * Each layer is one Path2D in map metres, made once; moving or zooming only redraws those with
 * another transform, so a redraw is a few dozen canvas calls, whatever the number of buildings.
 */

/** Model (x, z) to the map in metres, north up: u to the east, v to the south (the model is Lambert 72 turned and mirrored). */
const toU = (x: number, z: number) => -0.746292959 * x - 0.665617623 * z;
const toV = (x: number, z: number) => 0.665617623 * x - 0.746292959 * z;
/** And back. */
const toX = (u: number, v: number) => -0.746292959 * u + 0.665617623 * v;
const toZ = (u: number, v: number) => -0.665617623 * u - 0.746292959 * v;

type Layer = 'forest' | 'soil' | 'crop' | 'darkField' | 'track' | 'paving' | 'water' | 'road' | 'hedge' | 'building' | 'home' | 'bungalow' | 'church' | 'school';
/** Drawn in this order. Strokes are in screen pixels. */
const STYLE: [Layer, string, string?, number?][] = [
  ['forest', '#b0c995'],
  ['soil', '#e7d9b6'],
  ['crop', '#d6e3ad'],
  ['darkField', '#d3c39c'],
  ['track', '#ddd1b4'],
  ['paving', '#efebe3'],
  ['water', '#a7d2f0', '#82b6da', 1],
  ['road', '#ffffff', '#bfb6a6', 2.5],
  ['hedge', '#8cab70'],
  ['building', '#c6bcb0', '#998e80', 1],
  ['home', '#a9dbf4', '#2f7fae', 2],
  ['bungalow', '#ffdba6', '#c3832a', 2],
  ['church', '#d8c6f4', '#8462cc', 2],
  ['school', '#c6ecd6', '#3f9e6d', 2],
];
const FIELDS: Record<string, Layer> = { forest: 'forest', field_soil: 'soil', field_crop: 'crop', field_dark: 'darkField', track: 'track', pool_water: 'water' };
const PAVING = new Set(['pave_light', 'pave_warm', 'pave_grey', 'concrete', 'gravel', 'stone', 'paving', 'terrace']);

/** The places called out, each with its portal if it has one. `name` (and `sub` when it isn't a village's name) are i18n keys. */
interface Place {
  name: PlainKey;
  sub: string | PlainKey;
  x: number;
  z: number;
  color: string;
  portal?: Portal;
  small?: boolean;
}

export interface Mark {
  x: number;
  z: number;
  color: string;
  name?: string;
  yaw?: number;
  kind: 'player' | 'car' | 'horse';
}

const portal = (id: string) => PORTALS.find((p) => p.id === id);
const herd = HORSES.herd.flatMap((h) => h.loop);
const PLACES: Place[] = [
  { name: 'place.house', sub: 'Briel', x: 4.45, z: -3, color: '#4fc3f7', portal: portal('house') },
  { name: 'place.bungalow', sub: 'Briel', x: 83.5, z: 189.7, color: '#ffb74d', portal: portal('bungalow') },
  { name: 'place.church', sub: 'Smetlede', x: 521.5, z: -744.15, color: '#b388ff', portal: portal('church') },
  { name: 'place.school', sub: 'Smetlede', x: 476, z: -818, color: '#69f0ae', portal: portal('school') },
  { name: 'place.molenhoek', sub: 'Smetlede', x: 758, z: -709.5, color: '#ff8a80', portal: portal('molenhoek') },
  { name: 'place.square', sub: 'Smetlede', x: 533, z: -768, color: '#9aa0a8', small: true },
  { name: 'place.horses', sub: 'place.horsesSub', x: herd.reduce((a, p) => a + p[0], 0) / herd.length, z: herd.reduce((a, p) => a + p[1], 0) / herd.length, color: '#8a5a3a', small: true },
];
/** A place's line under its name: the village (a name in both languages) or a text to translate. */
const subOf = (p: Place) => (p.sub.startsWith('place.') ? t(p.sub as PlainKey) : p.sub);

const fmt = dist;

export class BigMap {
  open = false;
  /** How you play: the help line, and the cross in the middle for the controller. */
  control: Control = 'kbm';
  /** Where you asked to go (the minimap points to it), or null */
  waypoint: { x: number; z: number } | null = null;
  /** The way to the waypoint along the roads, and how long it is (main.ts works it out as you move) */
  route: { line: [number, number][]; length: number } | null = null;
  /** A new waypoint: work out the way at once */
  onWaypoint: () => void = () => {};

  private root = document.createElement('div');
  private base = document.createElement('canvas');
  private top = document.createElement('canvas');
  private card = document.createElement('div');
  private help = document.createElement('div');
  private paths = new Map<Layer, Path2D>();
  private trees = new Path2D();
  private hull = new Path2D();
  /** The area the world is built in (map metres), from the village data */
  private area: [number, number][] | null = null;
  private ponds: { u: number; v: number }[] = [];
  private points: [number, number][] = [];
  // The view: the map point in the middle of the screen (m) and the scale (CSS px a metre).
  private cu = 0;
  private cv = 0;
  private s = 0.5;
  private fit = 0.5;
  private dirty = true;
  /** Goes up when the ground changes (the village arrives), so the minimap draws its piece again. */
  groundVersion = 0;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private you = { x: 0, z: 0, yaw: 0 };
  private selected: Place | 'waypoint' | null = null;
  private drag: { x: number; y: number; moved: boolean } | null = null;
  private touches = new Map<number, { x: number; y: number }>();
  private pinch = 0;

  constructor(parent: HTMLElement, prisms: Prism[], surroundings: Surroundings | undefined, rooms: Room[], dips: DipSpec[]) {
    this.root.id = 'bigmap';
    this.root.className = 'hidden';
    this.base.className = 'bm-base';
    this.top.className = 'bm-top';
    this.card.className = 'bm-card hidden';
    this.help.className = 'bm-help';
    // The buttons and the legend: elements with their text (never HTML), named again in another language.
    const named: [HTMLElement | Text, PlainKey, 'text' | 'title' | 'aria'][] = [];
    const tools = document.createElement('div');
    tools.className = 'bm-tools';
    const button = (label: string, title: PlainKey, act: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      named.push([b, title, 'title'], [b, title, 'aria']);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        act();
      });
      return b;
    };
    tools.append(
      button('+', 'map.zoomIn', () => this.zoom(1.6, this.w / 2, this.h / 2)),
      button('−', 'map.zoomOut', () => this.zoom(1 / 1.6, this.w / 2, this.h / 2)),
      button('◎', 'map.where', () => this.centre(this.you.x, this.you.z, Math.max(this.s, 2))),
      button('⤢', 'map.whole', () => this.whole()),
    );
    const legend = document.createElement('div');
    legend.className = 'bm-legend';
    for (const [icon, key] of [['lg-you', 'map.you'], ['lg-portal', 'map.portal'], ['lg-player', 'map.players'], ['lg-pin', 'map.waypoint']] as const) {
      const item = document.createElement('span');
      const i = document.createElement('i');
      i.className = icon;
      const text = document.createTextNode('');
      item.append(i, text);
      legend.append(item);
      named.push([text, key, 'text']);
    }
    const name = () => {
      for (const [el, key, what] of named) {
        if (what === 'text') el.textContent = t(key);
        else if (!(el instanceof HTMLElement)) continue;
        else if (what === 'title') el.title = t(key);
        else el.setAttribute('aria-label', t(key));
      }
    };
    name();
    onLang(() => {
      name();
      this.showHelp();
      this.dirty = true; // the places' names on the map
      this.cardKey = '';
      this.showCard();
    });
    this.root.append(this.base, this.top, tools, legend, this.help, this.card);
    parent.append(this.root);

    for (const p of prisms) this.addPrism(p);
    for (const r of rooms) if (r.level === 'gf') this.add('home', r.p);
    // The bungalow: the outline round its walls (the house data has its walls, not its rooms).
    const old = prisms.filter((p) => p.m.startsWith('old_') && p.y0 < 0.5).flatMap((p) => p.p[0]);
    if (old.length > 2) this.add('bungalow', [hullOf(old.map(([x, z]) => [toU(x, z), toV(x, z)])).map(([u, v]) => [toX(u, v), toZ(u, v)])]);
    this.addSurroundings(surroundings, dips);
    this.addPointerHandlers();
    // Its size follows the menu's page (a window resized, the menu's header wrapping), not only the window.
    new ResizeObserver(() => this.open && this.resize()).observe(this.root);
    window.addEventListener('keydown', (e) => {
      if (!this.open || typing(e)) return;
      if (e.key === '+' || e.key === '=') this.zoom(1.4, this.w / 2, this.h / 2);
      else if (e.key === '-') this.zoom(1 / 1.4, this.w / 2, this.h / 2);
    });
  }

  /** The village and the band to it (once loaded): their roads, buildings, fields, trees and ponds. */
  addVillage(data: Surroundings & { dips?: DipSpec[]; area?: [number, number][] }): void {
    if (data.area && data.area.length > 2) this.area = data.area.map(([x, z]) => [toU(x, z), toV(x, z)]);
    this.addSurroundings(data, data.dips ?? []);
    this.dirty = true;
    this.groundVersion++;
  }

  show(you: { x: number; z: number; yaw: number }, control: Control): void {
    this.open = true;
    this.control = control;
    this.you = { ...you };
    this.root.classList.remove('hidden');
    this.resize();
    // Always round where you are (Yoshi), close enough to see the streets; the fit button shows it all.
    this.centre(you.x, you.z, Math.max(this.fit * 2.5, 1.2));
    this.showHelp();
  }

  /** The line at the bottom: how to move it and set a waypoint, the way you play (keys from src/shortcuts.ts). */
  private showHelp(): void {
    const c = this.control;
    this.help.textContent = c === 'touch' ? t('map.helpTouch')
      : c === 'pad' ? t('map.helpPad', { tabs: key('tabs', c), menu: key('menu', c) })
      : t('map.helpKbm', { move: moveKeys(), map: key('map', c), menu: key('menu', c) });
  }

  hide(): void {
    this.open = false;
    this.root.classList.add('hidden');
    this.drag = null;
    this.touches.clear();
  }

  /** The controller while the map is open: the left stick moves it, R2 and L2 zoom. */
  steer(dt: number, frame: FrameInput, pad: boolean): void {
    if (Math.hypot(frame.moveX, frame.moveY) > 0.1) {
      this.cu += (frame.moveX * 600 * dt) / this.s;
      this.cv -= (frame.moveY * 600 * dt) / this.s;
      this.dirty = true;
    }
    if (pad && Math.abs(frame.throttle - frame.brake) > 0.05) this.zoom(Math.exp((frame.throttle - frame.brake) * 2 * dt), this.w / 2, this.h / 2);
  }

  /** Every frame while open: you and what moves. */
  tick(you: { x: number; z: number; yaw: number }, marks: Mark[]): void {
    this.you = { ...you };
    if (this.dirty) this.drawBase();
    const g = this.top.getContext('2d')!;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    const t = performance.now() / 1000;
    for (const m of marks) {
      const [x, y] = this.screen(m.x, m.z);
      if (x < -40 || y < -40 || x > this.w + 40 || y > this.h + 40) continue;
      if (m.kind === 'car') {
        g.save();
        g.translate(x, y);
        g.rotate(this.screenAngle(m.yaw ?? 0));
        const l = Math.max(9, 4.8 * this.s);
        const w = Math.max(5, 2 * this.s);
        g.fillStyle = m.color;
        g.strokeStyle = 'rgba(0, 0, 0, 0.6)';
        g.lineWidth = 1;
        g.beginPath();
        g.roundRect(-w / 2, -l / 2, w, l, 2);
        g.fill();
        g.stroke();
        g.restore();
      } else {
        g.beginPath();
        g.arc(x, y, m.kind === 'horse' ? 3.5 : 5.5, 0, Math.PI * 2);
        g.fillStyle = m.color;
        g.fill();
        g.strokeStyle = 'rgba(255, 255, 255, 0.95)';
        g.lineWidth = 1.5;
        g.stroke();
      }
      if (m.name) this.label(g, m.name, x + 9, y + 4, '600 12px', m.color, 'left');
    }
    if (this.waypoint && this.route) {
      // The way there: a blue line with a light edge, as in a car's navigation.
      g.beginPath();
      this.route.line.forEach(([rx, rz], i) => {
        const [px, py] = this.screen(rx, rz);
        (i ? g.lineTo : g.moveTo).call(g, px, py);
      });
      g.lineJoin = g.lineCap = 'round';
      g.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      g.lineWidth = 8;
      g.stroke();
      g.strokeStyle = '#2f80ed';
      g.lineWidth = 4.5;
      g.stroke();
    }
    if (this.waypoint) {
      const [x, y] = this.screen(this.waypoint.x, this.waypoint.z);
      pin(g, x, y);
    }
    // You: an arrow where you look, with a slow pulse round it.
    const [x, y] = this.screen(you.x, you.z);
    g.beginPath();
    g.arc(x, y, 10 + 6 * ((t * 0.8) % 1), 0, Math.PI * 2);
    g.strokeStyle = `rgba(255, 255, 255, ${0.7 * (1 - ((t * 0.8) % 1))})`;
    g.lineWidth = 2;
    g.stroke();
    g.save();
    g.translate(x, y);
    g.rotate(this.screenAngle(you.yaw));
    g.beginPath();
    g.moveTo(0, -11);
    g.lineTo(7.5, 8);
    g.lineTo(0, 4);
    g.lineTo(-7.5, 8);
    g.closePath();
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#11151b';
    g.lineWidth = 2;
    g.stroke();
    g.fill();
    g.restore();
    // The controller sets a waypoint at the cross in the middle (✕): the map moves under it.
    if (this.control === 'pad') {
      const cx = this.w / 2;
      const cy = this.h / 2;
      g.beginPath();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        g.moveTo(cx + dx * 5, cy + dy * 5);
        g.lineTo(cx + dx * 14, cy + dy * 14);
      }
      g.lineCap = 'round';
      g.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      g.lineWidth = 5;
      g.stroke();
      g.strokeStyle = '#11151b';
      g.lineWidth = 2;
      g.stroke();
    }
    if (this.selected) this.showCard();
  }

  // ---- the data

  private add(layer: Layer, rings: Ring[]): void {
    let path = this.paths.get(layer);
    if (!path) this.paths.set(layer, (path = new Path2D()));
    for (const ring of rings) {
      if (ring.length < 3) continue;
      ring.forEach(([x, z], i) => {
        const u = toU(x, z);
        const v = toV(x, z);
        (i ? path!.lineTo : path!.moveTo).call(path, u, v);
        if (layer === 'road' || layer === 'building') this.points.push([u, v]);
      });
      path.closePath();
    }
  }

  private addPrism(p: Prism): void {
    if (p.lm === 'church' || p.lm === 'school') return this.add(p.lm, p.p);
    if (p.n === 'street' || p.m === 'road') return this.add('road', p.p);
    if (FIELDS[p.m]) return this.add(FIELDS[p.m], p.p);
    if (PAVING.has(p.m) && p.y1 < 0.6) return this.add('paving', p.p);
    if (p.m === 'hedge' || p.m === 'nb_hedge') return this.add('hedge', p.p);
    if (p.m.startsWith('nb_')) this.add('building', p.p);
  }

  private addSurroundings(s: Surroundings | undefined, dips: DipSpec[]): void {
    for (const p of s?.prisms ?? []) this.addPrism(p);
    for (const r of s?.roofs ?? []) this.add(r.lm === 'church' || r.lm === 'school' ? r.lm : 'building', [r.p]);
    for (const t of s?.trees ?? []) {
      const u = toU(t.x, t.z);
      const v = toV(t.x, t.z);
      const r = Math.max(1.2, t.r * 0.85);
      this.trees.moveTo(u + r, v);
      this.trees.arc(u, v, r, 0, Math.PI * 2);
    }
    for (const d of dips) {
      this.add('water', [d.rim]);
      if (d.name === 'pond') {
        const n = d.rim.length;
        const x = d.rim.reduce((a, p) => a + p[0], 0) / n;
        const z = d.rim.reduce((a, p) => a + p[1], 0) / n;
        this.ponds.push({ u: toU(x, z), v: toV(x, z) });
      }
    }
    // The area the world is built in (its outline, once the village is in; until then the hull of what is drawn):
    // everything outside it is drawn muted.
    const hull = this.area ?? hullOf(this.points);
    this.hull = new Path2D();
    hull.forEach(([u, v], i) => (i ? this.hull.lineTo(u, v) : this.hull.moveTo(u, v)));
    this.hull.closePath();
    this.dirty = true;
  }

  // ---- the view

  private resize(): void {
    this.dpr = Math.min(2, devicePixelRatio || 1);
    this.w = Math.max(1, this.root.clientWidth);
    this.h = Math.max(1, this.root.clientHeight);
    for (const c of [this.base, this.top]) {
      c.width = Math.round(this.w * this.dpr);
      c.height = Math.round(this.h * this.dpr);
    }
    // The whole built area fits with a margin.
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [u, v] of this.points) {
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    if (isFinite(u0)) {
      this.fit = Math.min(this.w / (u1 - u0 + 60), (this.h - 70) / (v1 - v0 + 60));
      this.wholeAt = [(u0 + u1) / 2, (v0 + v1) / 2];
    }
    this.dirty = true;
  }

  private wholeAt: [number, number] = [0, 0];

  private whole(): void {
    [this.cu, this.cv] = this.wholeAt;
    this.s = this.fit;
    this.dirty = true;
  }

  private centre(x: number, z: number, s = this.s): void {
    this.cu = toU(x, z);
    this.cv = toV(x, z);
    this.s = Math.min(8, s);
    this.dirty = true;
  }

  private zoom(k: number, sx: number, sy: number): void {
    const s = Math.max(this.fit * 0.7, Math.min(8, this.s * k));
    // Keep the map point under (sx, sy) where it is.
    const u = this.cu + (sx - this.w / 2) / this.s;
    const v = this.cv + (sy - this.h / 2) / this.s;
    this.s = s;
    this.cu = u - (sx - this.w / 2) / s;
    this.cv = v - (sy - this.h / 2) / s;
    this.dirty = true;
  }

  private screen(x: number, z: number): [number, number] {
    return [(toU(x, z) - this.cu) * this.s + this.w / 2, (toV(x, z) - this.cv) * this.s + this.h / 2];
  }

  /** The map point under a screen point, in the model. */
  private model(sx: number, sy: number): { x: number; z: number } {
    const u = this.cu + (sx - this.w / 2) / this.s;
    const v = this.cv + (sy - this.h / 2) / this.s;
    return { x: toX(u, v), z: toZ(u, v) };
  }

  /** A heading in the game (yaw) as an angle on the map, clockwise from up. */
  private screenAngle(yaw: number): number {
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    return Math.atan2(toU(fx, fz), -toV(fx, fz));
  }

  // ---- drawing

  /** The ground (fields, roads, buildings, trees) into `g`, whose transform takes map metres; `pxPerM` sets the line widths. */
  private paintGround(g: CanvasRenderingContext2D, pxPerM: number): void {
    g.fillStyle = '#e2e8d4';
    g.fill(this.hull);
    for (const [layer, fill, stroke, width] of STYLE) {
      const path = this.paths.get(layer);
      if (!path) continue;
      if (stroke && layer === 'road') {
        g.strokeStyle = stroke;
        g.lineWidth = (width ?? 1) / pxPerM;
        g.lineJoin = 'round';
        g.stroke(path);
      }
      g.fillStyle = fill;
      g.fill(path, 'nonzero');
      if (stroke && layer !== 'road' && (pxPerM > 0.7 || layer !== 'building')) {
        g.strokeStyle = stroke;
        g.lineWidth = (width ?? 1) / pxPerM;
        g.stroke(path);
      }
      if (layer === 'hedge') {
        g.fillStyle = 'rgba(112, 156, 88, 0.55)';
        g.fill(this.trees);
      }
    }
  }

  /**
   * The same ground for the minimap (src/ui/minimap.ts), into `g` whose transform takes the game's
   * metres (x right, z down): the map's metres are the game's turned and mirrored (see toX, toZ).
   */
  paintGroundGame(g: CanvasRenderingContext2D, pxPerM: number): void {
    g.save();
    g.transform(-0.746292959, -0.665617623, 0.665617623, -0.746292959, 0, 0);
    this.paintGround(g, pxPerM);
    g.restore();
  }

  private drawBase(): void {
    this.dirty = false;
    const g = this.base.getContext('2d')!;
    const k = this.dpr;
    g.setTransform(k, 0, 0, k, 0, 0);
    g.fillStyle = '#c3c9b6';
    g.fillRect(0, 0, this.w, this.h);
    // Map metres to the screen.
    g.setTransform(k * this.s, 0, 0, k * this.s, k * (this.w / 2 - this.cu * this.s), k * (this.h / 2 - this.cv * this.s));
    this.paintGround(g, this.s);
    g.setTransform(k, 0, 0, k, 0, 0);
    // Street names, along their streets.
    if (this.s > 0.32) {
      for (const st of STREETS.streets) {
        for (const [x, z, a] of st.labels) {
          const [sx, sy] = this.screen(x, z);
          if (sx < -80 || sy < -20 || sx > this.w + 80 || sy > this.h + 20) continue;
          g.save();
          g.translate(sx, sy);
          g.rotate(a);
          this.label(g, st.name, 0, 4, `italic 500 ${this.s > 1.5 ? 13 : 11}px`, '#6b675f', 'center');
          g.restore();
        }
      }
    }
    if (this.s > 0.9) for (const p of this.ponds) {
      const [sx, sy] = [(p.u - this.cu) * this.s + this.w / 2, (p.v - this.cv) * this.s + this.h / 2];
      this.label(g, t('map.pond'), sx, sy + 4, 'italic 500 11px', '#3f7fae', 'center');
    }
    // The portals, then the places' names (with their portal's colour).
    for (const p of PORTALS) {
      const [sx, sy] = this.screen(p.x, p.z);
      g.beginPath();
      g.arc(sx, sy, 7, 0, Math.PI * 2);
      g.fillStyle = '#11151b';
      g.fill();
      g.lineWidth = 3;
      g.strokeStyle = p.color;
      g.stroke();
      g.beginPath();
      g.arc(sx, sy, 2.5, 0, Math.PI * 2);
      g.fillStyle = p.color;
      g.fill();
    }
    // The places' names, the main ones first, each on the first side of its portal (or the place)
    // where it doesn't run into another name or a portal; a small one that fits nowhere is left out.
    const boxes: [number, number, number, number][] = PORTALS.map((p) => {
      const [sx, sy] = this.screen(p.x, p.z);
      return [sx - 9, sy - 9, sx + 9, sy + 9];
    });
    const free = (b: [number, number, number, number]) => b[0] > 4 && b[2] < this.w - 4 && !boxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
    for (const p of PLACES) {
      if (p.small && this.s < 0.6) continue;
      const [px, py] = this.screen(p.x, p.z);
      const at = p.portal ? this.screen(p.portal.x, p.portal.z) : null;
      const [ax, ay] = at && Math.hypot(at[0] - px, at[1] - py) < 40 ? at : [px, py];
      const font = p.small ? '600 12px' : '700 15px';
      g.font = `${font} Bahnschrift, "Arial Narrow", "Segoe UI", sans-serif`;
      const name = t(p.name);
      const w = g.measureText(name).width + (p.small ? 0 : 14);
      const h = p.small ? 13 : 16;
      const sides: [number, number][] = [[ax + 12, ay - h / 2], [ax - 12 - w, ay - h / 2], [ax - w / 2, ay - 14 - h], [ax - w / 2, ay + 12], [ax + 12, ay + 10], [ax - 12 - w, ay - h - 6]];
      const spot = sides.find(([x, y]) => free([x - 2, y - 2, x + w + 2, y + h + 2]));
      if (!spot) continue;
      const [x, y] = spot;
      boxes.push([x - 2, y - 2, x + w + 2, y + h + 2]);
      if (p.small) this.label(g, name, x, y + h - 2, font, '#3d3a35', 'left');
      else this.label(g, name, x, y + h - 3, font, '#1d2025', 'left', p.color);
    }
    // North and a scale bar.
    g.fillStyle = 'rgba(17, 21, 27, 0.8)';
    g.font = '700 13px Bahnschrift, "Arial Narrow", sans-serif';
    g.textAlign = 'center';
    g.fillText(t('map.north'), this.w - 28, 46);
    g.beginPath();
    g.moveTo(this.w - 28, 16);
    g.lineTo(this.w - 22, 32);
    g.lineTo(this.w - 34, 32);
    g.closePath();
    g.fill();
    const metres = [10, 20, 50, 100, 200, 500].find((m) => m * this.s > 70) ?? 1000;
    const bar = metres * this.s;
    g.fillRect(24, this.h - 56, bar, 4);
    g.font = '600 12px Bahnschrift, "Arial Narrow", sans-serif';
    g.textAlign = 'left';
    g.fillText(fmt(metres), 24, this.h - 62);
  }

  /** Text with a light halo; `dot` puts a coloured dot before it. */
  private label(g: CanvasRenderingContext2D, text: string, x: number, y: number, font: string, color: string, align: CanvasTextAlign, dot?: string): void {
    g.font = `${font} Bahnschrift, "Arial Narrow", "Segoe UI", sans-serif`;
    g.textAlign = align;
    g.lineJoin = 'round';
    g.lineWidth = 3.5;
    g.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    let tx = x;
    if (dot) {
      const w = g.measureText(text).width;
      const left = align === 'center' ? x - w / 2 - 9 : x;
      g.beginPath();
      g.arc(left + 4, y - 5, 4.5, 0, Math.PI * 2);
      g.fillStyle = dot;
      g.fill();
      g.strokeStyle = 'rgba(17, 21, 27, 0.8)';
      g.lineWidth = 1.5;
      g.stroke();
      g.lineWidth = 3.5;
      g.strokeStyle = 'rgba(255, 255, 255, 0.92)';
      tx = align === 'center' ? x + 6 : x + 12;
    }
    g.strokeText(text, tx, y);
    g.fillStyle = color;
    g.fillText(text, tx, y);
  }

  // ---- clicking, dragging, zooming

  private addPointerHandlers(): void {
    const el = this.top;
    /** A pointer in the map's own pixels (it sits in the menu's page, not at the window's corner). */
    const at = (e: { clientX: number; clientY: number }): [number, number] => {
      const r = el.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture?.(e.pointerId);
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 2) {
        const [a, b] = [...this.touches.values()];
        this.pinch = Math.hypot(a.x - b.x, a.y - b.y);
        this.drag = null;
      } else this.drag = { x: e.clientX, y: e.clientY, moved: false };
    });
    el.addEventListener('pointermove', (e) => {
      const t = this.touches.get(e.pointerId);
      if (!t) return;
      if (this.touches.size === 2) {
        t.x = e.clientX;
        t.y = e.clientY;
        const [a, b] = [...this.touches.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinch > 0) this.zoom(d / this.pinch, ...at({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 }));
        this.pinch = d;
        return;
      }
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      if (!this.drag.moved && Math.hypot(dx, dy) < 5) return;
      this.drag.moved = true;
      this.cu -= dx / this.s;
      this.cv -= dy / this.s;
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      this.dirty = true;
    });
    const up = (e: PointerEvent) => {
      const was = this.drag;
      this.touches.delete(e.pointerId);
      if (this.touches.size < 2) this.pinch = 0;
      if (was && !was.moved && this.touches.size === 0) this.click(...at(e));
      if (this.touches.size === 0) this.drag = null;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', (e) => {
      this.touches.delete(e.pointerId);
      this.drag = null;
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom(Math.exp(-e.deltaY * 0.0015), ...at(e));
    }, { passive: false });
  }

  /** (x, z) within `r` pixels of the screen point (sx, sy). */
  private near(x: number, z: number, sx: number, sy: number, r: number): boolean {
    const [px, py] = this.screen(x, z);
    return Math.hypot(px - sx, py - sy) < r;
  }

  /** The place (or its portal) at a screen point. */
  private placeAt(sx: number, sy: number): Place | undefined {
    return PLACES.find((p) => (p.portal && this.near(p.portal.x, p.portal.z, sx, sy, 16)) || this.near(p.x, p.z, sx, sy, 18));
  }

  /** A place (or its portal), the waypoint, or else a new waypoint there. */
  private click(sx: number, sy: number): void {
    const place = this.placeAt(sx, sy);
    if (place) this.selected = place;
    else if (this.waypoint && this.near(this.waypoint.x, this.waypoint.z, sx, sy, 16)) this.selected = 'waypoint';
    else this.setWaypoint(this.model(sx, sy));
    this.cardKey = '';
    this.showCard();
  }

  /**
   * ✕ on the controller, at the cross in the middle: directions to the place there, the waypoint
   * there taken away again, or else a new waypoint there.
   */
  pickCentre(): void {
    const [sx, sy] = [this.w / 2, this.h / 2];
    const place = this.placeAt(sx, sy);
    if (place) this.setWaypoint({ x: place.x, z: place.z });
    else if (this.waypoint && this.near(this.waypoint.x, this.waypoint.z, sx, sy, 16)) this.removeWaypoint();
    else this.setWaypoint(this.model(sx, sy));
    this.cardKey = '';
    this.showCard();
  }

  /** Go there: the way is worked out at once (main.ts), and the minimap shows it once you play on. */
  private setWaypoint(at: { x: number; z: number }): void {
    this.waypoint = at;
    this.route = null;
    this.selected = 'waypoint';
    this.onWaypoint();
  }

  private removeWaypoint(): void {
    this.waypoint = null;
    this.route = null;
    this.selected = null;
  }

  private cardKey = '';

  private showCard(): void {
    const sel = this.selected;
    if (!sel || (sel === 'waypoint' && !this.waypoint)) {
      this.card.classList.add('hidden');
      return;
    }
    const at = sel === 'waypoint' ? this.waypoint! : sel;
    const d = sel === 'waypoint' && this.route ? this.route.length : Math.hypot(at.x - this.you.x, at.z - this.you.z);
    const key = `${sel === 'waypoint' ? 'w' : sel.name}|${Math.round(d / 10)}`;
    if (key === this.cardKey) return;
    this.cardKey = key;
    const b = document.createElement('b');
    const small = document.createElement('small');
    const row = document.createElement('div');
    row.className = 'bm-row';
    const act = (label: string, fn: () => void, main = false) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      if (main) btn.className = 'main';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      row.append(btn);
    };
    if (sel === 'waypoint') {
      b.textContent = t('map.waypoint');
      small.textContent = t(this.route && this.route.line.length > 2 ? 'map.byRoad' : 'map.fromYouWay', { d: fmt(d) });
      act(t('map.remove'), () => {
        this.removeWaypoint();
        this.showCard();
      });
    } else {
      b.textContent = t(sel.name);
      small.textContent = t('map.placeSub', { sub: subOf(sel), d: fmt(d) });
      act(t('map.directions'), () => {
        this.setWaypoint({ x: sel.x, z: sel.z });
        this.cardKey = '';
        this.showCard();
      }, true);
      if (sel.portal) {
        const note = document.createElement('p');
        note.textContent = t('map.portalNote');
        row.append(note);
      }
    }
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'bm-x';
    x.textContent = '✕';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      this.selected = null;
      this.showCard();
    });
    this.card.replaceChildren(x, b, small, row);
    this.card.classList.remove('hidden');
  }
}

/** A map pin at (x, y), its point there. */
function pin(g: CanvasRenderingContext2D, x: number, y: number): void {
  g.save();
  g.translate(x, y);
  g.beginPath();
  g.moveTo(0, 0);
  g.bezierCurveTo(-3, -8, -9, -11, -9, -18);
  g.arc(0, -18, 9, Math.PI, 0);
  g.bezierCurveTo(9, -11, 3, -8, 0, 0);
  g.fillStyle = '#f2b33d';
  g.strokeStyle = '#11151b';
  g.lineWidth = 2;
  g.fill();
  g.stroke();
  g.beginPath();
  g.arc(0, -18, 3.5, 0, Math.PI * 2);
  g.fillStyle = '#11151b';
  g.fill();
  g.restore();
}

/** The convex hull of points (monotone chain). */
function hullOf(points: [number, number][]): [number, number][] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p[i]) <= 0) upper.pop();
    upper.push(p[i]);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
