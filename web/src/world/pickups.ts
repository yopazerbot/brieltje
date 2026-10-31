import * as THREE from 'three';
import PICKUPS from '../../shared/pickups.json';
import { gunModel, gunsReady, type WeaponId } from '../weapon';

/**
 * Weapons lying in the house (Action mode): a slowly turning gun above a
 * glowing ring. Walk over one to take it; it comes back after 20 seconds.
 * In multiplayer the server decides who gets it; alone it happens here.
 */

const RESPAWN_S = 20;
const REACH = 0.9; // m

export interface Spot {
  w: WeaponId;
  where: string;
  x: number;
  z: number;
  y: number;
}

export class Pickups {
  readonly group = new THREE.Group();
  readonly spots = PICKUPS as Spot[];
  private items: { model: THREE.Group; ready: boolean; back: number }[];
  private clock = 0;

  constructor(floorAt: (x: number, z: number, y: number) => number) {
    const ringMat = new THREE.MeshBasicMaterial({ color: '#f2b33d', transparent: true, opacity: 0.7, depthWrite: false });
    this.items = this.spots.map((s) => {
      const floor = floorAt(s.x, s.z, s.y);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.38, 32), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(s.x, floor + 0.02, s.z);
      ring.userData.ignoreRay = true;
      const model = new THREE.Group();
      model.add(gunModel(s.w));
      model.position.set(s.x, floor + 0.75, s.z);
      model.userData.ring = ring;
      this.group.add(ring, model);
      return { model, ready: true, back: 0 };
    });
    void gunsReady.then((ok) => {
      if (ok) this.items.forEach((it, i) => it.model.clear().add(gunModel(this.spots[i].w)));
    });
  }

  setReady(i: number, ready: boolean): void {
    const it = this.items[i];
    if (!it) return;
    it.ready = ready;
    it.back = ready ? 0 : this.clock + RESPAWN_S;
    it.model.visible = ready;
    (it.model.userData.ring as THREE.Object3D).visible = ready;
  }

  setAll(ready: boolean[]): void {
    ready.forEach((r, i) => this.setReady(i, r));
  }

  /** Weapons lying ready, for the minimap. */
  blips(): { x: number; y: number; z: number }[] {
    return this.items.filter((it) => it.ready).map((it) => ({ x: it.model.position.x, y: it.model.position.y - 0.75, z: it.model.position.z }));
  }

  /** A ready pickup within reach of your feet, or -1. */
  near(x: number, feet: number, z: number): number {
    return this.items.findIndex((it, i) => {
      const s = this.spots[i];
      return it.ready && Math.hypot(x - s.x, z - s.z) < REACH && Math.abs(feet - it.model.position.y + 0.75) < 1;
    });
  }

  /** Turn the guns; alone (no server), bring taken ones back after 20 s. */
  update(dt: number, local: boolean): void {
    this.clock += dt;
    this.items.forEach((it, i) => {
      it.model.rotation.y += dt * 1.2;
      it.model.position.y += Math.sin(this.clock * 2 + i) * 0.0008;
      if (local && !it.ready && this.clock >= it.back) this.setReady(i, true);
    });
  }
}
