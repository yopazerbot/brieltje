import * as THREE from 'three';
import { sound } from '../sound';
import type { World } from './collision';

/**
 * Breakable windows: a shot shatters the pane into falling shards, plays a
 * glass sound and opens the gap (no more collision). "Repair windows" in the
 * menu puts them all back.
 */

interface Shard {
  mesh: THREE.Mesh;
  v: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
  floor: number;
}

const SHARDS = 36;
const shardGeo = new THREE.BufferGeometry().setAttribute(
  'position',
  new THREE.Float32BufferAttribute([0, 0, 0, 0.06, 0.01, 0, 0.02, 0.07, 0], 3),
);
shardGeo.computeVertexNormals();
const shardMat = new THREE.MeshStandardMaterial({
  color: '#d6ecf5', roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
});

export class Glass {
  private broken = new Set<number>();
  private shards: Shard[] = [];
  /** Alone, the panes hold (Yoshi): nobody shoots their way into the house or the bungalow. */
  private sealed = false;

  /** Panes that aren't house blocks (glass in door leaves), with what to do when one breaks or is back */
  private others = new Map<number, (broken: boolean) => void>();

  constructor(private panes: Map<number, THREE.Mesh>, private world: World, private scene: THREE.Scene) {}

  /** More breakable panes, such as the glass in doors; `onBreak` frees the way through (and closes it again on repair). */
  add(panes: Map<number, THREE.Mesh>, onBreak: (index: number, broken: boolean) => void): void {
    for (const [i, pane] of panes) {
      this.panes.set(i, pane);
      this.others.set(i, (broken) => onBreak(i, broken));
    }
  }

  /** Where a pane is now, in the world (door glass moves with its leaf). */
  bounds(index: number): THREE.Box3 | null {
    const pane = this.panes.get(index);
    return pane ? new THREE.Box3().setFromObject(pane) : null;
  }

  private setSolid(index: number, on: boolean): void {
    const other = this.others.get(index);
    if (other) other(!on);
    else this.world.setSolid(index, on);
  }

  get brokenList(): number[] {
    return [...this.broken];
  }

  /** Unbroken panes within `radius` of a point (a rocket's blast). */
  near(p: THREE.Vector3, radius: number): number[] {
    const out: number[] = [];
    for (const [i, pane] of this.panes) {
      if (this.broken.has(i) || !pane.visible) continue;
      if (new THREE.Box3().setFromObject(pane).distanceToPoint(p) < radius) out.push(i);
    }
    return out;
  }

  /** Break pane `index`. `hit` is where the bullet struck (shards fly from there); null breaks it quietly (joining a game). */
  break(index: number, hit: THREE.Vector3 | null, from?: THREE.Vector3): boolean {
    const pane = this.panes.get(index);
    if (this.sealed || !pane || this.broken.has(index)) return false;
    this.broken.add(index);
    const box = new THREE.Box3().setFromObject(pane);
    pane.visible = false;
    this.setSolid(index, false);
    if (!hit) return true;

    const dir = from ? hit.clone().sub(from).setY(0).normalize() : new THREE.Vector3();
    for (let i = 0; i < SHARDS; i++) {
      const mesh = new THREE.Mesh(shardGeo, shardMat);
      mesh.position.set(
        THREE.MathUtils.lerp(box.min.x, box.max.x, Math.random()),
        THREE.MathUtils.lerp(box.min.y, box.max.y, Math.random()),
        THREE.MathUtils.lerp(box.min.z, box.max.z, Math.random()),
      );
      mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      mesh.scale.setScalar(0.6 + Math.random() * 1.6);
      mesh.userData.ignoreRay = true;
      this.scene.add(mesh);
      const v = dir.clone().multiplyScalar(1 + Math.random() * 2.5).add(new THREE.Vector3((Math.random() - 0.5) * 1.2, Math.random() * 1.2, (Math.random() - 0.5) * 1.2));
      this.shards.push({ mesh, v, spin: new THREE.Vector3(Math.random() * 10, Math.random() * 10, Math.random() * 10), life: 2.5, floor: box.min.y - 3.2 });
    }
    this.shatterSound(hit);
    return true;
  }

  /** Alone (true): every pane whole again and unbreakable. Together (false): breakable, as the server has them. */
  seal(on: boolean): void {
    this.sealed = on;
    if (on) this.repair();
  }

  /** Whether a shot or a grenade breaks panes now (not alone). */
  get breakable(): boolean {
    return !this.sealed;
  }

  repair(): void {
    for (const index of this.broken) {
      const pane = this.panes.get(index);
      if (pane) pane.visible = true;
      this.setSolid(index, true);
    }
    this.broken.clear();
  }

  update(dt: number): void {
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i];
      s.life -= dt;
      s.v.y -= 9.81 * dt;
      s.mesh.position.addScaledVector(s.v, dt);
      s.mesh.rotation.x += s.spin.x * dt;
      s.mesh.rotation.y += s.spin.y * dt;
      if (s.mesh.position.y < s.floor) s.v.set(0, 0, 0);
      if (s.life <= 0) {
        s.mesh.removeFromParent();
        this.shards.splice(i, 1);
      }
    }
  }

  /** A crash of breaking glass with a few tinkles, made in code. */
  private shatterSound(at: THREE.Vector3): void {
    const ctx = sound.context();
    const dest = sound.at(at.x, at.y, at.z, 3);
    if (!ctx || !dest) return;
    const t = ctx.currentTime;
    const len = 0.9;
    const buf = ctx.createBuffer(1, ctx.sampleRate * len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const env = Math.pow(1 - i / data.length, 3);
      data[i] = (Math.random() * 2 - 1) * env * (Math.random() < 0.02 ? 3 : 1);
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2500;
    const gain = ctx.createGain();
    gain.gain.value = 0.45;
    noise.connect(hp).connect(gain).connect(dest);
    noise.start(t);
    for (let i = 0; i < 6; i++) {
      const o = ctx.createOscillator();
      o.frequency.value = 3000 + Math.random() * 4000;
      const g = ctx.createGain();
      const at = t + 0.05 + Math.random() * 0.5;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.setValueAtTime(0.06, at);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.12);
      o.connect(g).connect(dest);
      o.start(t);
      o.stop(at + 0.15);
    }
  }
}
