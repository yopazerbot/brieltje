import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { LootKind } from '../../shared/loot.mjs';
import { LOOT } from '../../shared/loot.mjs';
import { paintball } from '../paintball';

/**
 * The Zombies game's rewards on screen (shared/loot.mjs keeps them: the server together, the page
 * alone): each lies where its zombie fell as a glowing ring on the ground with a beam of light and
 * its sign turning above it (a box of ammo, a scope, a claymore), so it shows from across the garden;
 * walk over it to take it. And the claymores placed: a small curved box on two legs on the floor,
 * facing the way it goes off, with a light blinking once it is armed (in paintball a bright paint
 * mine). Shared geometry, the parts of one material merged: three or four draws a reward, three a claymore.
 */

const COLORS: Record<LootKind, string> = { ammo: '#f2c14e', scope: '#5fd3f3', claymore: '#ff7a45' };
const REACH = 1.0; // m: the page asks for one this close (the server allows LOOT.reach)

const ringGeo = new THREE.RingGeometry(0.3, 0.4, 32).rotateX(-Math.PI / 2);
const beamGeo = new THREE.CylinderGeometry(0.05, 0.12, 1.8, 10, 1, true).translate(0, 0.9, 0);
const boxGeo = new THREE.BoxGeometry(0.26, 0.15, 0.17);
const bandGeo = new THREE.BoxGeometry(0.265, 0.035, 0.175);
const tubeGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.3, 16).rotateX(Math.PI / 2);
/** A part placed in its model: moved, turned about y (`ry`) and x (`rx`). */
const placed = (geo: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0, rx = 0) =>
  geo.clone().applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, 0)), new THREE.Vector3(1, 1, 1)));
const lens = new THREE.CylinderGeometry(0.042, 0.042, 0.02, 16).rotateX(Math.PI / 2);
const lensGeo = mergeGeometries([placed(lens, 0, 0, -0.155), placed(lens, 0, 0, 0.155)]);
// A claymore: two slabs at an angle (the curve, bulging to the front), on two legs.
const slab = new THREE.BoxGeometry(0.13, 0.13, 0.045);
const slabGeo = mergeGeometries([-1, 1].map((side) => placed(slab, side * 0.062, 0.12, 0.012, side * 0.32)));
const leg = new THREE.BoxGeometry(0.012, 0.09, 0.012);
const legGeo = mergeGeometries([-1, 1].map((side) => placed(leg, side * 0.09, 0.045, 0.02, 0, 0.25)));
const ledGeo = new THREE.SphereGeometry(0.014, 8, 6);

const glow = (color: string) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, depthWrite: false });
const ringMats = Object.fromEntries(Object.entries(COLORS).map(([k, c]) => [k, glow(c)])) as Record<LootKind, THREE.MeshBasicMaterial>;
const beamMats = Object.fromEntries(Object.entries(COLORS).map(([k, c]) => [k, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending })])) as Record<LootKind, THREE.MeshBasicMaterial>;
const lit = (color: string, glowColor: string, k = 0.6) => new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.2, emissive: glowColor, emissiveIntensity: k });
const mats = {
  box: lit('#5d6b3a', '#2a3313', 0.5),
  band: lit('#f2c14e', '#f2c14e', 0.8),
  tube: lit('#1f2328', '#0d0f12', 0.3),
  lens: lit('#5fd3f3', '#5fd3f3', 1.2),
  mine: lit('#55603a', '#20250f', 0.25),
  minePaint: lit('#ff5fa2', '#7a1f4a', 0.4),
  leg: lit('#2a2a2a', '#000000', 0),
  led: new THREE.MeshBasicMaterial({ color: '#ff2a1a' }),
  ledOff: new THREE.MeshBasicMaterial({ color: '#3a0d0a' }),
};

/** A claymore's own shape: its front is its -z (the way it faces). */
function mineModel(paint: boolean): { g: THREE.Group; led: THREE.Mesh } {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(slabGeo, paint ? mats.minePaint : mats.mine), new THREE.Mesh(legGeo, mats.leg));
  const led = new THREE.Mesh(ledGeo, mats.ledOff);
  led.position.set(0, 0.2, 0.01);
  g.add(led);
  return { g, led };
}

/** A reward's sign above its ring: an ammo box, a scope, a claymore. */
function sign(kind: LootKind): THREE.Group {
  const g = new THREE.Group();
  if (kind === 'ammo') {
    g.add(new THREE.Mesh(boxGeo, mats.box), new THREE.Mesh(bandGeo, mats.band));
  } else if (kind === 'scope') {
    g.add(new THREE.Mesh(tubeGeo, mats.tube), new THREE.Mesh(lensGeo, mats.lens));
  } else {
    const m = mineModel(paintball.on).g;
    m.position.y = -0.12;
    m.scale.setScalar(1.4);
    g.add(m);
  }
  g.traverse((o) => (o.userData.ignoreRay = true));
  return g;
}

interface Shown {
  kind: LootKind;
  g: THREE.Group;
  icon: THREE.Group;
  beam: THREE.Mesh;
  x: number;
  y: number;
  z: number;
  born: number;
}

export class Rewards {
  readonly group = new THREE.Group();
  private items = new Map<number, Shown>();
  private mines = new Map<number, { g: THREE.Group; led: THREE.Mesh; at: number; paint: boolean }>();
  private clock = 0;

  constructor() {
    this.group.name = 'rewards';
  }

  /** The items lying now ([id, kind, x, y, z]): new ones come, taken or gone ones go. */
  setItems(list: [number, LootKind, number, number, number][]): void {
    const ids = new Set(list.map((i) => i[0]));
    for (const [id, s] of this.items) {
      if (ids.has(id)) continue;
      s.g.removeFromParent();
      this.items.delete(id);
    }
    for (const [id, kind, x, y, z] of list) {
      if (this.items.has(id) || !COLORS[kind]) continue;
      const g = new THREE.Group();
      g.position.set(x, y, z);
      const ring = new THREE.Mesh(ringGeo, ringMats[kind]);
      ring.position.y = 0.03;
      const beam = new THREE.Mesh(beamGeo, beamMats[kind]);
      const icon = sign(kind);
      icon.position.y = 0.75;
      for (const o of [ring, beam]) o.userData.ignoreRay = true;
      g.add(ring, beam, icon);
      this.group.add(g);
      this.items.set(id, { kind, g, icon, beam, x, y, z, born: this.clock });
    }
  }

  /** The claymores down now ([id, x, y, z, yaw, owner]). */
  setMines(list: [number, number, number, number, number, string][]): void {
    const ids = new Set(list.map((m) => m[0]));
    for (const [id, m] of this.mines) {
      if (ids.has(id) && m.paint === paintball.on) continue;
      m.g.removeFromParent();
      this.mines.delete(id);
    }
    for (const [id, x, y, z, yaw] of list) {
      if (this.mines.has(id)) continue;
      const { g, led } = mineModel(paintball.on);
      g.position.set(x, y, z);
      g.rotation.y = yaw; // its front (-z) the way the player looked (the game's yaw)
      g.traverse((o) => (o.userData.ignoreRay = true));
      this.group.add(g);
      this.mines.set(id, { g, led, at: this.clock, paint: paintball.on });
    }
  }

  /** Mine `id` went off: it's gone (the blast is drawn by the caller). */
  boom(id: number): void {
    const m = this.mines.get(id);
    if (!m) return;
    m.g.removeFromParent();
    this.mines.delete(id);
  }

  clear(): void {
    this.setItems([]);
    this.setMines([]);
  }

  /** The item within reach of your feet (the nearest), or -1. */
  near(x: number, feet: number, z: number): number {
    let best = -1;
    let bd = REACH;
    for (const [id, s] of this.items) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (d <= bd && Math.abs(feet - s.y) < LOOT.rise - 0.2) [best, bd] = [id, d];
    }
    return best;
  }

  /** The items lying, for the minimap. */
  blips(): { x: number; y: number; z: number; color: string }[] {
    return [...this.items.values()].map((s) => ({ x: s.x, y: s.y, z: s.z, color: COLORS[s.kind] }));
  }

  /** Every frame: the signs turn and bob, the beams breathe, an armed claymore blinks. */
  update(dt: number): void {
    this.clock += dt;
    let k = 0;
    for (const s of this.items.values()) {
      s.icon.rotation.y += dt * 1.6;
      s.icon.position.y = 0.75 + Math.sin(this.clock * 2.2 + k++) * 0.06;
      (s.beam.material as THREE.MeshBasicMaterial).opacity = 0.16 + 0.08 * Math.sin(this.clock * 3);
      const pop = Math.min(1, (this.clock - s.born) * 4); // grows in as it drops
      s.g.scale.setScalar(pop);
    }
    for (const m of this.mines.values()) {
      const armed = this.clock - m.at > LOOT.armMs / 1000;
      m.led.material = armed && Math.floor(this.clock * 2.5) % 2 === 0 ? mats.led : mats.ledOff;
    }
  }
}
