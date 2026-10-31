import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Birds } from './birds';
import { Birdsong } from './birdsong';
import { Butterflies } from './butterflies';
import type { World } from './collision';
import { Mower } from './mower';
import { Smoke } from './smoke';
import { painted, Yard } from './yard';

/**
 * Life round the main house and the bungalow: the things in their gardens (world/yard.ts), the
 * robot mower on the back lawn (world/mower.ts, on the shared clock), birds (world/birds.ts) and
 * their songs (world/birdsong.ts), butterflies over the borders and smoke from two chimneys
 * (Medium and up). The models (tools/garden_life.py, about 0.2 MB sent) are fetched once the
 * start screen is up. Far from both gardens all of it is hidden and nothing is worked out.
 */

const HOUSE = new THREE.Vector3(4.45, 0, -3);
const BUNGALOW = new THREE.Vector3(85, 0, 192);
const SHOWN = 300; // m: the gardens' things are hidden beyond this
const NEAR = 90; // m: butterflies are drawn within this of a garden

export class HomeLife {
  readonly group = new THREE.Group();
  /** Seconds on the shared clock minus seconds on this page's clock; alone, the computer's own clock (everyone's is close). */
  private offset = Date.now() / 1000 - performance.now() / 1000;
  private loading = false;
  private yard: Yard | null = null;
  private mower: Mower | null = null;
  private birds: Birds | null = null;
  private song: Birdsong | null = null;
  private butterflies: Butterflies | null = null;
  private smoke: Smoke | null = null;
  private check = 0;
  private flat = new THREE.Vector3();

  /** `detail`: Medium and up and not a phone (butterflies and smoke). */
  constructor(private world: World, private groundY: (x: number, z: number) => number, private detail: () => boolean) {
    this.group.name = 'homeLife';
    this.group.userData.life = this; // for the automated checks
  }

  /** Fetch the models and set everything up (once). */
  load(): void {
    if (this.loading) return;
    this.loading = true;
    void new GLTFLoader().loadAsync('/models/garden.glb').then((gltf) => {
      const models = new Map(gltf.scene.children.map((o) => [o.name, o]));
      this.yard = new Yard(models, this.world, this.groundY);
      this.group.add(this.yard.group);
      if (models.has('Mower')) {
        this.mower = new Mower(painted(models.get('Mower')!), this.groundY);
        this.group.add(this.mower.mesh);
      }
      if (models.has('Bird')) {
        this.birds = new Birds(models.get('Bird')!, this.groundY);
        this.group.add(this.birds.group);
        const birds = this.birds;
        this.song = new Birdsong((at, radius) => birds.sitting(at, radius), [HOUSE, BUNGALOW]);
      }
      this.butterflies = new Butterflies(this.groundY);
      this.smoke = new Smoke([new THREE.Vector3(17.38, 11.23, 23.76), new THREE.Vector3(85.85, 6.92, 186.91)]);
      this.group.add(this.butterflies.mesh, this.smoke.mesh);
    }, () => {}); // missing: the gardens stay as they were
  }

  /** Line up with the server's clock (ms since 1970), so every player sees the mower in the same place. */
  setClock(serverMs: number): void {
    this.offset = serverMs / 1000 - performance.now() / 1000;
  }

  /** A shot or a blast at `at`: the birds near it take off. */
  scare(at: THREE.Vector3, radius = 30): void {
    this.birds?.scare(at, radius);
  }

  update(dt: number, eye: THREE.Vector3): void {
    if (!this.yard) return;
    this.flat.set(eye.x, 0, eye.z);
    const toHouse = this.flat.distanceTo(HOUSE);
    const toBungalow = this.flat.distanceTo(BUNGALOW);
    this.check -= dt;
    if (this.check <= 0) {
      // Four times a second: what is near enough to show.
      this.check = 0.25;
      this.yard.house.visible = toHouse < SHOWN;
      this.yard.bungalow.visible = toBungalow < SHOWN;
      const fine = this.detail();
      if (this.butterflies) this.butterflies.mesh.visible = fine && Math.min(toHouse, toBungalow) < NEAR;
      if (this.smoke) this.smoke.mesh.visible = fine && Math.min(toHouse, toBungalow) < SHOWN;
      if (this.mower) this.mower.mesh.visible = toHouse < 160;
    }
    this.mower?.update(performance.now() / 1000 + this.offset, eye); // hidden, it still stops its whine
    this.birds?.update(dt, eye);
    this.song?.update(dt, eye, toHouse < 170 || toBungalow < 130);
    if (this.butterflies?.mesh.visible) this.butterflies.update(dt);
    if (this.smoke?.mesh.visible) this.smoke.update(dt);
  }
}
