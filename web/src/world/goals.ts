import * as THREE from 'three';
import { bestKey, dropRace, finishRace, formatTime, newRace, readBest, readFound, stepRace, writeBest, writeFound, type By, type Race } from '../../shared/goals.mjs';
import { dist, lang, onLang, plural, t } from '../i18n';
import { typing } from '../keys';
import { seat } from '../seat';
import { key, type Control } from '../shortcuts';
import { GoalsHud } from '../ui/goalsHud';
import { GNOME_IDS, Gnomes, SPOTS } from './gnomes';
import type { Particles } from './particles';
import { ROUTE_LIST, Routes, type RunResult } from './routes';

/**
 * Something to do alone in the open world (Yoshi, 14 Nov 2026): garden gnomes to find (world/gnomes.ts) and timed routes
 * (world/routes.ts), with what was found and the best times kept in this browser only (nothing is sent). The one class
 * main.ts talks to: it owns both, the storage and the line at the top (ui/goalsHud.ts). Shown in Explore, Action and
 * Paintball, never during a game or on the start screen (main.ts hides `group`).
 */

const FOUND_KEY = 'briel.gnomes';
const BEST_KEY = 'briel.routes';
/** The first-time toast, this long after play begins (s) */
const INTRO_AFTER = 8;
const BEST_KEYS = ROUTE_LIST.map(bestKey);
/** The line says the race stopped this long (ms) */
const NOTICE_MS = 3000;
/** The race key on the keyboard, by its place (src/shortcuts.ts `race`: K on AZERTY and QWERTY) */
const RACE_KEY = 'KeyK';

export interface Me {
  x: number;
  z: number;
  feet: number;
  yaw: number;
  /** How you move: null as a passenger, on a horse, flying or down (gnomes yes, routes no) */
  by: By | null;
  /** Playing now: no menu, no trip, not down; false hides the line and finds nothing */
  on: boolean;
}

export interface GoalsOptions {
  ground: (x: number, z: number) => number;
  floor: (x: number, z: number, y: number) => number;
  particles: Particles;
  announce: (big: string, small: string) => void;
  count: (text: string) => void;
  low: () => boolean;
}

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage blocked: play goes on, nothing is kept
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage blocked or full: nothing is kept
  }
}

export class Goals {
  readonly group = new THREE.Group();
  /** False with ?nogoals on the dev server (for the bench): update returns at once */
  enabled = true;
  readonly gnomes: Gnomes;
  readonly routes: Routes;
  private hud: GoalsHud;
  private list: string[] = [];
  private told = false;
  private played = 0;
  private villageIn = false;
  private look = new THREE.Vector3();
  /** The big map's count shown (the group was visible last frame) */
  private counted = true;
  /** Warm-up frames behind the start screen: drawn, but nothing is found, run or shown in the line */
  private warm = false;
  /** The race asked for, and the offer (shared/goals.mjs stepRace): no ring shows before the race key */
  race: Race = newRace();
  /** The race key (K), the controller's button (main.ts press) or a tap on the line, since the last frame */
  private hit = false;
  /** The offer was in the prompt this frame (main.ts prompt): it counts down only then */
  private shown = false;
  /** Until when the line says the race stopped (ms) */
  private notice = 0;
  /** How you play, for the key in the texts (main.ts prompt) */
  private mode: Control = 'kbm';

  constructor(private o: GoalsOptions) {
    this.gnomes = new Gnomes(o.ground, o.floor, o.particles, o.low);
    this.routes = new Routes(o.ground);
    this.group.add(this.gnomes.group, this.routes.group);
    this.hud = new GoalsHud(document.getElementById('hud')!, () => this.press());
    // The race key, as the ping's V (ui/tactics.ts): not while typing, nor in a split-screen seat with its own controller.
    window.addEventListener('keydown', (e) => {
      if (e.code !== RACE_KEY || e.repeat || e.ctrlKey || e.altKey || e.metaKey || typing(e) || (seat && seat.pad >= 0)) return;
      this.hit = true;
    });
    const kept = readFound(load(FOUND_KEY), GNOME_IDS);
    this.list = kept.found;
    this.told = kept.told;
    this.routes.best = readBest(load(BEST_KEY), BEST_KEYS);
    this.gnomes.setFound(this.list);
    this.gnomes.setGolden(this.allFound());
    this.showCount();
    onLang(() => {
      this.showCount();
      this.hud.set('', '', null);
    });
  }

  private allFound(): boolean {
    return this.list.length >= SPOTS.length;
  }

  private showCount(): void {
    this.o.count(this.counted ? t('map.gnomes', { n: this.list.length, total: SPOTS.length }) : '');
  }

  /** Save what was found, merged with what another tab of this browser saved meanwhile. */
  private saveFound(): void {
    const kept = readFound(load(FOUND_KEY), GNOME_IDS);
    const more = kept.found.filter((id) => !this.list.includes(id));
    if (more.length) {
      this.list.push(...more);
      this.gnomes.setFound(this.list);
      this.gnomes.setGolden(this.allFound());
    }
    this.told ||= kept.told;
    save(FOUND_KEY, writeFound(this.list, this.told));
  }

  /** Save the best times, keeping a better one another tab saved meanwhile. */
  private saveBest(): void {
    const kept = readBest(load(BEST_KEY), BEST_KEYS);
    for (const [key, ms] of Object.entries(kept)) if (!(this.routes.best[key] <= ms)) this.routes.best[key] = ms;
    save(BEST_KEY, writeBest(this.routes.best));
  }

  /**
   * The warm-up frames behind the start screen (main.ts): while on, the rings and the golden gnome are drawn too, each
   * material once, so nothing is drawn for the first time in play; off puts everything back as it was.
   */
  warming(on: boolean): void {
    this.warm = on;
    this.gnomes.warming(on);
    this.routes.warming(on);
  }

  settle(): void {
    this.gnomes.settle();
    this.routes.settle();
  }

  villageReady(): void {
    this.villageIn = true;
    this.gnomes.villageReady();
    this.gnomes.setGolden(this.allFound());
    this.routes.villageReady();
  }

  update(dt: number, camera: THREE.Camera, me: Me): void {
    if (!this.enabled) return;
    this.gnomes.update(dt);
    // The big map's count goes with the rest: not during a game nor for a watcher.
    if (this.group.visible !== this.counted) {
      this.counted = this.group.visible;
      this.showCount();
    }
    const pressed = this.hit && me.on && !this.warm;
    const shownMs = this.shown ? dt * 1000 : 0;
    this.hit = this.shown = false;
    if (!this.group.visible) {
      // A game, the start screen or watching: no run goes on through it, no race is asked for, nothing is offered.
      this.routes.stop();
      this.race = { ...dropRace(this.race), offer: null, offerLeft: 0 };
      this.routes.armed = null;
      this.routes.showGates(this.look);
      this.hud.set('', '', null);
      return;
    }
    const now = performance.now();
    const step = stepRace(this.race, ROUTE_LIST, me, pressed, now, shownMs);
    this.race = step.race;
    if (step.event === 'stopped') {
      // Out of the car, off the bike, down or away through a portal during a run: the toast, as before. The key, or
      // before the gate: the line says so.
      const r = this.routes.stop();
      if (r && step.why === 'left') this.report(r);
      else this.notice = now + NOTICE_MS;
    }
    this.routes.armed = this.race.armed;
    this.routes.canStart = !!this.race.armed && !this.race.done;
    camera.getWorldPosition(this.look);
    this.routes.showGates(this.look);
    if (!me.on || this.warm) {
      // A menu over the game: the run waits (its clock does not), unless you stopped moving as the route asks. With no
      // run on, where you were is forgotten: a trip, a respawn or a parachute drop is no step through a gate.
      const route = this.routes.route();
      if (route && me.by !== route.by) this.report(this.routes.stop());
      this.routes.forget();
      this.hud.set('', '', null);
      return;
    }
    this.played += dt;
    if (!this.told && this.played > INTRO_AFTER) {
      this.told = true;
      this.saveFound();
      if (!this.list.length) this.o.announce(t('goals.intro', { total: SPOTS.length }), t('goals.introSub'));
    }
    const i = this.gnomes.near(me.x, me.z, me.feet);
    if (i >= 0) this.find(i, me);
    const run = this.routes.update(me, now);
    // A finish: the gate stays a while with the result; a run stopped on its own (the wrong way, two minutes without a
    // checkpoint) ends the race too.
    if (run?.event === 'finish') this.race = finishRace(this.race, now);
    else if (run?.event === 'stop') this.race = dropRace(this.race);
    this.routes.armed = this.race.armed;
    this.routes.canStart = !!this.race.armed && !this.race.done;
    this.report(run);
    this.line(camera, me);
  }

  /** The controller's race button (main.ts: the D-pad's right), as the K key and a tap on the line. */
  press(): void {
    this.hit = true;
  }

  /**
   * The game's one-line prompt (main.ts): `text` as it is, or when it says nothing the race on offer with its key
   * ("K  Start the timed route: Round Briel by car"). The offer counts down only while it shows here.
   */
  prompt(text: string, mode: Control): string {
    this.mode = mode;
    const route = this.race.offer ? ROUTE_LIST.find((r) => r.id === this.race.offer) : undefined;
    if (text || !route || !this.enabled || !this.group.visible) return text;
    this.shown = true;
    const name = this.routeName(route.id);
    return mode === 'touch' ? t('route.offerTouch', { route: name }) : t('route.offer', { key: key('race', mode), route: name });
  }

  private find(i: number, me: Me): void {
    const id = SPOTS[i].id;
    if (this.list.includes(id)) return;
    this.list.push(id);
    this.told = true;
    this.saveFound();
    this.gnomes.mark(i);
    this.gnomes.pop(i);
    this.showCount();
    const n = this.list.length, total = SPOTS.length, left = total - n;
    if (left > 0) {
      this.o.announce(t('gnome.found', { n, total }), plural(left, 'gnome.left.one', 'gnome.left.other', { n: left }));
      return;
    }
    this.o.announce(t('gnome.all', { total }), t('gnome.allSub'));
    this.gnomes.fireworks(me.x, me.feet, me.z);
    this.gnomes.setGolden(true);
  }

  private report(r: RunResult | null): void {
    if (!r) return;
    const comma = lang() === 'nl';
    if (r.event === 'stop') this.o.announce(t('route.stopped'), t('route.stoppedSub'));
    else if (r.event === 'finish') {
      const time = formatTime(r.time ?? 0, comma);
      if (r.newBest) this.saveBest();
      const best = this.routes.best[bestKey(r.route)];
      this.o.announce(time, r.newBest ? t('route.newBest') : t('route.best', { time: formatTime(best ?? r.time ?? 0, comma) }));
    }
  }

  private routeName(id: string): string {
    return id === 'bike' ? t('route.bike') : id === 'car' ? t('route.car') : t('route.foot');
  }

  private byName(by: By): string {
    return by === 'bike' ? t('route.by.bike') : by === 'car' ? t('route.by.car') : t('route.by.foot');
  }

  /** The arrow's turn towards (x, z): turning left is a positive yaw; on screen it turns clockwise for a point to the right. */
  private turn(camera: THREE.Camera, me: Me, x: number, z: number): number {
    camera.getWorldDirection(this.look);
    return Math.atan2(-this.look.x, -this.look.z) - Math.atan2(-(x - me.x), -(z - me.z));
  }

  /**
   * The line at the top: the run's clock and the next point; with a race asked for, the way to its gate; else the race
   * on offer (a tap on it starts it with touch controls), or for a moment that the race stopped. Tappable only while it
   * offers or shows a race.
   */
  private line(camera: THREE.Camera, me: Me): void {
    const run = this.routes.run;
    const target = this.routes.target();
    if (run && target) {
      const clock = formatTime(performance.now() - run.t0, lang() === 'nl');
      const step = target.finish ? t('route.toFinish') : t('route.next', { n: target.n, total: target.total });
      const d = Math.hypot(target.x - me.x, target.z - me.z);
      this.hud.set(clock, `${step} · ${dist(d)}`, this.turn(camera, me, target.x, target.z), true);
      return;
    }
    const armed = ROUTE_LIST.find((r) => r.id === this.race.armed);
    // A small screen (touch controls, a split-screen seat): the short way of saying it, between the wordmark and the map.
    const narrow = document.body.classList.contains('touch') || document.body.classList.contains('compact');
    if (armed && !this.race.done) {
      const [gx, gz] = armed.gate;
      const d = Math.hypot(gx - me.x, gz - me.z);
      const how = d < 15 ? (narrow ? t('route.startShort') : t('route.start', { by: this.byName(armed.by) })) : t('route.toStart');
      this.hud.set('', `${this.routeName(armed.id)} · ${how} · ${dist(d)}`, this.turn(camera, me, gx, gz), true);
      return;
    }
    if (performance.now() < this.notice) {
      this.hud.set('', t('route.stopped'), null);
      return;
    }
    // On offer, or a finish's result showing: the route, how to start it with touch controls, and your best.
    const offered = ROUTE_LIST.find((r) => r.id === this.race.offer) ?? armed;
    if (!offered) {
      this.hud.set('', '', null);
      return;
    }
    const parts = [this.routeName(offered.id)];
    if (this.mode === 'touch') parts.push(t('route.offerTap'));
    const best = this.routes.best[bestKey(offered)];
    if (best !== undefined) parts.push(t('route.best', { time: formatTime(best, lang() === 'nl') }));
    this.hud.set('', parts.join(' · '), null, true);
  }

  /** For the big map: found gnomes and, once the village is in, the routes' start gates. Empty while hidden. */
  marks(): { x: number; z: number; color: string; name?: string; kind: 'coin' }[] {
    if (!this.enabled || !this.group.visible) return [];
    const out: { x: number; z: number; color: string; name?: string; kind: 'coin' }[] = SPOTS.filter((s) => this.list.includes(s.id)).map((s) => ({ x: s.x, z: s.z, color: '#d6453d', kind: 'coin' }));
    if (this.villageIn) for (const r of ROUTE_LIST) out.push({ x: r.gate[0], z: r.gate[1], color: r.colour, name: this.routeName(r.id), kind: 'coin' });
    return out;
  }

  // Development helpers for the checks (tools/dev/goals.mjs).
  /** The ids found */
  found(): string[] {
    return [...this.list];
  }

  /** Forget what was found and the best times (this browser too). */
  reset(): void {
    this.list = [];
    this.told = false;
    this.routes.best = {};
    this.routes.stop();
    this.race = newRace();
    this.routes.armed = null;
    save(FOUND_KEY, writeFound([], false));
    save(BEST_KEY, writeBest({}));
    this.gnomes.setFound([]);
    this.gnomes.setGolden(false);
    this.showCount();
  }

  /** Every gnome with its height as settled and whether it is drawn now. */
  spots(): { id: string; x: number; z: number; y: number; floor: boolean; village: boolean; shown: boolean }[] {
    return SPOTS.map((s, i) => ({ id: s.id, x: s.x, z: s.z, y: this.gnomes.heights[i], floor: s.y !== undefined, village: s.village, shown: this.gnomes.isShown(i) }));
  }

  /** The run on now, and the next point. */
  run(): { id: string; next: number; ms: number; target: ReturnType<Routes['target']> } | null {
    const run = this.routes.run;
    return run ? { id: run.id, next: run.next, ms: performance.now() - run.t0, target: this.routes.target() } : null;
  }
}
