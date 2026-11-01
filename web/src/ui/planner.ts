import * as THREE from 'three';
import CARS from '../../shared/car.json';
import type { FrameInput } from '../controls/input';
import type { Kind } from '../world/clowns';
import { carShape, PLACED_MAX } from '../world/car';
import { Furnishing, ITEMS, itemGeometry, type Piece } from '../world/furnishing';
import { furnitureName, onLang, t, teslaLabel, type PlainKey } from '../i18n';
import { key, type Control } from '../shortcuts';

/**
 * Furniture planner (P, or the button in the menu). A see-through copy of the
 * chosen piece follows where you look on the floor (5 cm steps); click places
 * it, the mouse wheel (or L1/R1) changes the piece, R (or Square) turns it
 * 45 degrees, right click picks up a placed piece to move it, X removes the
 * piece you look at. In multiplayer everyone sees the same furniture.
 *
 * At the end of the list: Teslas (shared/car.json: placed), real cars to drive, outdoors only. The
 * admin places, moves and removes them in multiplayer (the server checks), anyone alone; the others
 * see them greyed out with the reason. A car someone is in stays where it is.
 */

const REACH = 9; // m
const SNAP = 0.05; // m
/** Not furniture: characters that walk round where you put them (the admin's, or yours alone). */
const CHARACTERS = [
  { id: 'clown', name: 'Clown (walks around, can be shot)', size: [0.67, 0.48, 1.26] as [number, number, number] },
  { id: 'strongman', name: 'Strongman, a giant (walks around, can be shot)', size: [2.2, 1.0, 4.6] as [number, number, number] },
];
const CHARACTER_NAMES: Record<string, PlainKey> = { clown: 'plan.clown', strongman: 'plan.strongman' };
type Size = [number, number, number];
/** The Teslas, each a kind of placed car: its size across, along and up, and its model for the see-through copy. */
const TESLAS = Object.entries(CARS.placed.kinds).map(([id, k]) => {
  const base = CARS.cars[k.base as keyof typeof CARS.cars];
  return { id, name: k.label, size: [base.width, base.length, base.height] as Size, car: base, locked: false };
});
/** For the others in multiplayer: one greyed-out line per model. */
const LOCKED = [...new Map(TESLAS.map((c) => [c.car.model, { ...c, name: c.name.replace(/ \(.*\)$/, ''), locked: true }])).values()];
type Entry = { id: string; name: string; size: Size; car?: (typeof TESLAS)[number]['car']; locked?: boolean };
/** A piece's, a character's or a Tesla's name in the current language. */
const nameOf = (it: Entry) =>
  CHARACTER_NAMES[it.id] ? t(CHARACTER_NAMES[it.id]) : it.car ? (it.locked ? it.name : teslaLabel(it.id, it.name)) : furnitureName(it.id, it.name);
const ghosts: Record<string, THREE.BufferGeometry> = {
  clown: new THREE.CylinderGeometry(0.3, 0.3, 1.26, 12).translate(0, 0.63, 0),
  strongman: new THREE.CylinderGeometry(0.8, 0.8, 4.6, 12).translate(0, 2.3, 0),
};

/** A placed Tesla the planner looks at. */
export interface CarLook {
  id: string;
  kind: string;
  yaw: number;
  /** How far along the ray (m) */
  distance: number;
  /** Someone is in it: it stays where it is */
  busy: boolean;
}

export class Planner {
  active = false;
  /** Asks to place a new piece, or (with an id) move an existing one. */
  onPlace: (p: Omit<Piece, 'id'> & { id?: number }) => void = () => {};
  onRemove: (id: number) => void = () => {};
  /** The clowns' group, to find the one you look at. */
  clownGroup: THREE.Object3D | null = null;
  /** Clowns: place one, take one away (only when `clowns` is on: the admin, or playing alone). */
  onClown: (at: { x: number; y: number; z: number; kind: Kind }) => void = () => {};
  onClownRemove: (id: number) => void = () => {};
  clowns = false;
  /** Teslas: placed, moved and removed only when `cars` is on (the admin, or playing alone). */
  cars = false;
  /** Asks to place a Tesla of `kind`, or (with an id) move a placed one. */
  onCar: (c: { id?: string; kind: string; x: number; y: number; z: number; yaw: number }) => void = () => {};
  onCarRemove: (id: string) => void = () => {};
  /** Someone is in the Tesla you tried to pick up or remove. */
  onCarBusy: () => void = () => {};
  /** The placed Tesla a ray hits, if any. */
  pickCar: (raycaster: THREE.Raycaster) => CarLook | null = () => null;
  /** Whether a Tesla of `kind` may stand at (x, z) facing `yaw` (the floor you look at is at `floorY`), and its height there. `id`: the one being moved. */
  carFits: (kind: string, x: number, z: number, yaw: number, floorY: number, id?: string) => { ok: boolean; y: number } = (_k, _x, _z, _yaw, y) => ({ ok: false, y });
  /** How many Teslas are placed now. */
  carCount: () => number = () => 0;
  /** How you play: the keys on its line. */
  control: Control = 'kbm';
  private index = 0;
  private yaw = 0;
  private carrying: Piece | null = null;
  private carryingCar: { id: string; kind: string } | null = null;
  private ghost: THREE.Mesh;
  private ok = new THREE.MeshBasicMaterial({ color: '#7fd18b', transparent: true, opacity: 0.45, depthWrite: false });
  private bad = new THREE.MeshBasicMaterial({ color: '#ff6b5e', transparent: true, opacity: 0.35, depthWrite: false });
  private raycaster = new THREE.Raycaster();
  private wasAiming = false;
  private bar = document.getElementById('planner')!;

  constructor(scene: THREE.Scene, private furnishing: Furnishing, private floors: THREE.Object3D[]) {
    this.ghost = new THREE.Mesh(itemGeometry(ITEMS[0].id), this.ok);
    this.ghost.visible = false;
    this.ghost.userData.ignoreRay = true;
    this.ghost.renderOrder = 5;
    scene.add(this.ghost);
    this.raycaster.far = REACH;
    onLang(() => this.active && this.show());
  }

  toggle(on = !this.active): void {
    this.active = on;
    this.ghost.visible = false;
    this.carrying = null;
    this.carryingCar = null;
    this.bar.classList.toggle('hidden', !on);
    this.show();
  }

  /** Drawn again (the number of Teslas changed, or who may place them). */
  refresh(): void {
    if (this.active) this.show();
  }

  private get list(): Entry[] {
    return [...ITEMS, ...(this.clowns ? CHARACTERS : []), ...(this.cars ? TESLAS : LOCKED)];
  }

  private get item(): Entry {
    if (this.carrying) return ITEMS.find((i) => i.id === this.carrying!.item)!;
    if (this.carryingCar) return TESLAS.find((c) => c.id === this.carryingCar!.kind)!;
    return this.list[this.index % this.list.length];
  }

  private show(): void {
    const it = this.item;
    const [w, d, h] = it.size;
    const cm = (v: number) => Math.round(v * 100);
    this.bar.replaceChildren();
    const name = document.createElement('b');
    name.textContent = this.carrying || this.carryingCar ? t('plan.moving', { name: nameOf(it) }) : nameOf(it);
    const size = document.createElement('span');
    size.textContent = t('plan.size', { w: cm(w), d: cm(d), h: cm(h), i: (this.index % this.list.length) + 1, n: this.list.length });
    this.bar.append(name, size);
    // A Tesla: how many there are, or (for the others in multiplayer) why it is greyed out.
    this.bar.classList.toggle('locked', !!it.locked);
    if (it.car) {
      const note = document.createElement('em');
      note.textContent = it.locked ? t('plan.teslaLocked') : t('plan.teslaCount', { n: this.carCount(), max: PLACED_MAX });
      this.bar.append(note);
    }
    const keys = document.createElement('small');
    keys.textContent = key('plannerKeys', this.control); // its keys, from the one table (src/shortcuts.ts)
    this.bar.append(keys);
    this.ghost.geometry = it.car ? carShape(it.car, () => this.refresh()) : (ghosts[it.id] ?? itemGeometry(it.id));
  }

  update(frame: FrameInput, camera: THREE.Camera): void {
    if (!this.active) return;
    const cycle = frame.weaponCycle || (frame.throwPressed ? 1 : 0); // R1 (also G): the next piece
    if (cycle && !this.carrying && !this.carryingCar) {
      const step = cycle === 2 ? 1 : cycle;
      this.index = (this.index + step + this.list.length) % this.list.length;
      this.show();
    }
    if (frame.reloadPressed) this.yaw = (this.yaw + Math.PI / 4) % (Math.PI * 2);

    camera.updateMatrixWorld();
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    // What you look at: a piece of furniture, or a placed Tesla (when you may move them), whichever is nearer.
    const furn = this.furnishing.pickHit(this.raycaster);
    const seen = this.cars ? this.pickCar(this.raycaster) : null;
    const lookedCar = seen && (!furn || seen.distance < furn.distance) ? seen : null;
    const looked = lookedCar ? null : (furn?.piece ?? null);
    const aimEdge = frame.aimHeld && !this.wasAiming;
    this.wasAiming = frame.aimHeld;
    if (aimEdge && !this.carrying && !this.carryingCar) {
      if (lookedCar?.busy) this.onCarBusy();
      else if (lookedCar) {
        this.carryingCar = { id: lookedCar.id, kind: lookedCar.kind };
        this.yaw = lookedCar.yaw;
        this.show();
      } else if (looked) {
        this.carrying = looked;
        this.yaw = looked.yaw;
        this.show();
      }
    }
    // X at a clown takes it away (before any furniture behind it).
    const clown = this.clowns && this.clownGroup && !this.carrying && !this.carryingCar
      ? this.raycaster.intersectObject(this.clownGroup, true).find((h) => h.object.userData.clown !== undefined)
      : undefined;
    if (frame.deletePressed && clown) {
      this.onClownRemove(clown.object.userData.clown);
    } else if (frame.deletePressed) {
      if (this.carrying || this.carryingCar) {
        this.carrying = null;
        this.carryingCar = null;
        this.show();
      } else if (lookedCar) {
        if (lookedCar.busy) this.onCarBusy();
        else this.onCarRemove(lookedCar.id);
      } else if (looked) {
        this.onRemove(looked.id);
      }
    }

    // Where the piece would stand: the first floor (an upward surface) straight ahead.
    const hit = this.raycaster.intersectObjects(this.floors, true).find((h) => h.face && h.object.visible);
    const normal = hit?.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
    const onFloor = !!hit && !!normal && normal.y > 0.7;
    this.ghost.visible = !!hit;
    if (!hit) return;
    const x = Math.round(hit.point.x / SNAP) * SNAP;
    const z = Math.round(hit.point.z / SNAP) * SNAP;
    this.ghost.position.set(x, hit.point.y + 0.005, z);
    this.ghost.rotation.y = this.yaw;
    this.ghost.material = onFloor ? this.ok : this.bad;
    const it = this.item;
    if (it.car) {
      // A Tesla: on the ground outdoors, clear of walls, other cars and people; green only when it may go there.
      const fit = this.carFits(it.id, x, z, this.yaw, hit.point.y, this.carryingCar?.id);
      const can = onFloor && fit.ok && this.cars && !it.locked && (!!this.carryingCar || this.carCount() < PLACED_MAX);
      this.ghost.position.y = fit.y + 0.005;
      this.ghost.material = can ? this.ok : this.bad;
      if (frame.clickPressed && can) {
        this.onCar({ id: this.carryingCar?.id, kind: it.id, x, y: +fit.y.toFixed(3), z, yaw: +this.yaw.toFixed(4) });
        this.carryingCar = null;
        this.show();
      }
    } else if (frame.clickPressed && onFloor && ghosts[it.id]) {
      this.onClown({ x, y: +hit.point.y.toFixed(3), z, kind: it.id as Kind });
    } else if (frame.clickPressed && onFloor) {
      this.onPlace({ id: this.carrying?.id, item: it.id, x, y: +hit.point.y.toFixed(3), z, yaw: +this.yaw.toFixed(4) });
      this.carrying = null;
      this.show();
    }
  }
}
