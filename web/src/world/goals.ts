import * as THREE from 'three';
import { readFound, writeFound, type By } from '../../shared/goals.mjs';
import { onLang, plural, t } from '../i18n';
import { GNOME_IDS, Gnomes, SPOTS } from './gnomes';
import type { Particles } from './particles';

/**
 * Something to do alone in the open world (Yoshi, 14 Nov 2026): garden gnomes to find (world/gnomes.ts), with what was
 * found kept in this browser only (nothing is sent). The one class main.ts talks to: it owns the gnomes and the
 * storage. Shown in Explore, Action and Paintball, never during a game or on the start screen (main.ts hides `group`).
 */

const FOUND_KEY = 'briel.gnomes';
/** The first-time toast, this long after play begins (s) */
const INTRO_AFTER = 8;

export interface Me {
  x: number;
  z: number;
  feet: number;
  yaw: number;
  /** How you move: null as a passenger, on a horse, flying or down */
  by: By | null;
  /** Playing now: no menu, no trip, not down; false finds nothing */
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
  private list: string[] = [];
  private told = false;
  private played = 0;

  constructor(private o: GoalsOptions) {
    this.gnomes = new Gnomes(o.ground, o.floor, o.particles, o.low);
    this.group.add(this.gnomes.group);
    const kept = readFound(load(FOUND_KEY), GNOME_IDS);
    this.list = kept.found;
    this.told = kept.told;
    this.gnomes.setFound(this.list);
    this.gnomes.setGolden(this.allFound());
    this.showCount();
    onLang(() => this.showCount());
  }

  private allFound(): boolean {
    return this.list.length >= SPOTS.length;
  }

  private showCount(): void {
    this.o.count(t('map.gnomes', { n: this.list.length, total: SPOTS.length }));
  }

  settle(): void {
    this.gnomes.settle();
  }

  villageReady(): void {
    this.gnomes.villageReady();
    this.gnomes.setGolden(this.allFound());
  }

  update(dt: number, _camera: THREE.Camera, me: Me): void {
    if (!this.enabled) return;
    this.gnomes.update(dt);
    if (!this.group.visible || !me.on) return;
    this.played += dt;
    if (!this.told && this.played > INTRO_AFTER) {
      this.told = true;
      save(FOUND_KEY, writeFound(this.list, true));
      if (!this.list.length) this.o.announce(t('goals.intro', { total: SPOTS.length }), t('goals.introSub'));
    }
    const i = this.gnomes.near(me.x, me.z, me.feet);
    if (i >= 0) this.find(i, me);
  }

  private find(i: number, me: Me): void {
    const id = SPOTS[i].id;
    if (this.list.includes(id)) return;
    this.list.push(id);
    this.told = true;
    save(FOUND_KEY, writeFound(this.list, true));
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

  /** For the big map: the gnomes found. Empty while hidden. */
  marks(): { x: number; z: number; color: string; name?: string; kind: 'coin' }[] {
    if (!this.enabled || !this.group.visible) return [];
    return SPOTS.filter((s) => this.list.includes(s.id)).map((s) => ({ x: s.x, z: s.z, color: '#d6453d', kind: 'coin' as const }));
  }

  // Development helpers for the checks (tools/dev/goals.mjs).
  /** The ids found */
  found(): string[] {
    return [...this.list];
  }

  /** Forget what was found (this browser too). */
  reset(): void {
    this.list = [];
    this.told = false;
    save(FOUND_KEY, writeFound([], false));
    this.gnomes.setFound([]);
    this.gnomes.setGolden(false);
    this.showCount();
  }

  /** Every gnome with its height as settled and whether it is drawn now. */
  spots(): { id: string; x: number; z: number; y: number; floor: boolean; village: boolean; shown: boolean }[] {
    return SPOTS.map((s, i) => ({ id: s.id, x: s.x, z: s.z, y: this.gnomes.heights[i], floor: s.y !== undefined, village: s.village, shown: this.gnomes.isShown(i) }));
  }
}
