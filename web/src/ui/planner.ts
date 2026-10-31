import * as THREE from 'three';
import type { FrameInput } from '../controls/input';
import type { Kind } from '../world/clowns';
import { Furnishing, ITEMS, itemGeometry, type Piece } from '../world/furnishing';
import { furnitureName, onLang, t, type PlainKey } from '../i18n';
import { key, type Control } from '../shortcuts';

/**
 * Furniture planner (P, or the button in the menu). A see-through copy of the
 * chosen piece follows where you look on the floor (5 cm steps); click places
 * it, the mouse wheel (or L1/R1) changes the piece, R (or Square) turns it
 * 45 degrees, right click picks up a placed piece to move it, X removes the
 * piece you look at. In multiplayer everyone sees the same furniture.
 */

const REACH = 9; // m
const SNAP = 0.05; // m
/** Not furniture: characters that walk round where you put them (the admin's, or yours alone). */
const CHARACTERS = [
  { id: 'clown', name: 'Clown (walks around, can be shot)', size: [0.67, 0.48, 1.26] as [number, number, number] },
  { id: 'strongman', name: 'Strongman, a giant (walks around, can be shot)', size: [2.2, 1.0, 4.6] as [number, number, number] },
];
const CHARACTER_NAMES: Record<string, PlainKey> = { clown: 'plan.clown', strongman: 'plan.strongman' };
/** A piece's or a character's name in the current language. */
const nameOf = (it: { id: string; name: string }) => (CHARACTER_NAMES[it.id] ? t(CHARACTER_NAMES[it.id]) : furnitureName(it.id, it.name));
const ghosts: Record<string, THREE.BufferGeometry> = {
  clown: new THREE.CylinderGeometry(0.3, 0.3, 1.26, 12).translate(0, 0.63, 0),
  strongman: new THREE.CylinderGeometry(0.8, 0.8, 4.6, 12).translate(0, 2.3, 0),
};

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
  /** How you play: the keys on its line. */
  control: Control = 'kbm';
  private index = 0;
  private yaw = 0;
  private carrying: Piece | null = null;
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
    this.bar.classList.toggle('hidden', !on);
    this.show();
  }

  private get list() {
    return this.clowns ? [...ITEMS, ...CHARACTERS] : ITEMS;
  }

  private get item() {
    return this.carrying ? ITEMS.find((i) => i.id === this.carrying!.item)! : this.list[this.index % this.list.length];
  }

  private show(): void {
    const it = this.item;
    const [w, d, h] = it.size;
    const cm = (v: number) => Math.round(v * 100);
    this.bar.replaceChildren();
    const name = document.createElement('b');
    name.textContent = this.carrying ? t('plan.moving', { name: nameOf(it) }) : nameOf(it);
    const size = document.createElement('span');
    size.textContent = t('plan.size', { w: cm(w), d: cm(d), h: cm(h), i: (this.index % this.list.length) + 1, n: this.list.length });
    const keys = document.createElement('small');
    keys.textContent = key('plannerKeys', this.control); // its keys, from the one table (src/shortcuts.ts)
    this.bar.append(name, size, keys);
    this.ghost.geometry = ghosts[it.id] ?? itemGeometry(it.id);
  }

  update(frame: FrameInput, camera: THREE.Camera): void {
    if (!this.active) return;
    const cycle = frame.weaponCycle || (frame.throwPressed ? 1 : 0); // R1 (also G): the next piece
    if (cycle && !this.carrying) {
      const step = cycle === 2 ? 1 : cycle;
      this.index = (this.index + step + this.list.length) % this.list.length;
      this.show();
    }
    if (frame.reloadPressed) this.yaw = (this.yaw + Math.PI / 4) % (Math.PI * 2);

    camera.updateMatrixWorld();
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const looked = this.furnishing.pick(this.raycaster);
    const aimEdge = frame.aimHeld && !this.wasAiming;
    this.wasAiming = frame.aimHeld;
    if (aimEdge && looked && !this.carrying) {
      this.carrying = looked;
      this.yaw = looked.yaw;
      this.show();
    }
    // X at a clown takes it away (before any furniture behind it).
    const clown = this.clowns && this.clownGroup && !this.carrying
      ? this.raycaster.intersectObject(this.clownGroup, true).find((h) => h.object.userData.clown !== undefined)
      : undefined;
    if (frame.deletePressed && clown) {
      this.onClownRemove(clown.object.userData.clown);
    } else if (frame.deletePressed) {
      if (this.carrying) {
        this.carrying = null;
        this.show();
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
    if (frame.clickPressed && onFloor && ghosts[this.item.id]) {
      this.onClown({ x, y: +hit.point.y.toFixed(3), z, kind: this.item.id as Kind });
    } else if (frame.clickPressed && onFloor) {
      this.onPlace({ id: this.carrying?.id, item: this.item.id, x, y: +hit.point.y.toFixed(3), z, yaw: +this.yaw.toFixed(4) });
      this.carrying = null;
      this.show();
    }
  }
}
