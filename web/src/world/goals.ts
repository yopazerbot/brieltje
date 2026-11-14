import * as THREE from 'three';
import { bestKey, formatTime, readBest, readFound, writeBest, writeFound, type By } from '../../shared/goals.mjs';
import { dist, lang, onLang, plural, t } from '../i18n';
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

  constructor(private o: GoalsOptions) {
    this.gnomes = new Gnomes(o.ground, o.floor, o.particles, o.low);
    this.routes = new Routes(o.ground);
    this.group.add(this.gnomes.group, this.routes.group);
    this.hud = new GoalsHud(document.getElementById('hud')!);
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
    if (!this.group.visible) {
      // A game, the start screen or watching: no run goes on through it.
      this.routes.stop();
      this.hud.set('', '', null);
      return;
    }
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
    this.report(this.routes.update(me, performance.now()));
    this.line(camera, me);
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

  /** The line at the top: the run's clock and the next point, or the gate you stand by. */
  private line(camera: THREE.Camera, me: Me): void {
    const run = this.routes.run;
    const target = this.routes.target();
    if (run && target) {
      const clock = formatTime(performance.now() - run.t0, lang() === 'nl');
      const step = target.finish ? t('route.toFinish') : t('route.next', { n: target.n, total: target.total });
      const d = Math.hypot(target.x - me.x, target.z - me.z);
      camera.getWorldDirection(this.look);
      const view = Math.atan2(-this.look.x, -this.look.z);
      const toward = Math.atan2(-(target.x - me.x), -(target.z - me.z));
      // Turning left is a positive yaw; on screen the arrow turns clockwise for a point to the right.
      this.hud.set(clock, `${step} · ${dist(d)}`, view - toward);
      return;
    }
    const gate = this.routes.nearGate(me.x, me.z);
    if (!gate) {
      this.hud.set('', '', null);
      return;
    }
    const by = this.byName(gate.by);
    // A small screen (touch controls, a split-screen seat): the short way of saying it, between the wordmark and the map.
    const narrow = document.body.classList.contains('touch') || document.body.classList.contains('compact');
    const how = me.by === gate.by ? (narrow ? t('route.startShort') : t('route.start', { by })) : t(narrow ? 'route.needShort' : 'route.need', { by });
    const best = this.routes.best[bestKey(gate)];
    const parts = [this.routeName(gate.id), how];
    if (best !== undefined) parts.push(t('route.best', { time: formatTime(best, lang() === 'nl') }));
    this.hud.set('', parts.join(' · '), null);
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
