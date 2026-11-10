import * as THREE from 'three';
import { sound } from '../sound';
import type { World } from './collision';

/**
 * Breakable windows: a shot shatters the pane into falling shards, plays a
 * glass sound and opens the gap (no more collision). "Repair windows" in the
 * menu puts them all back.
 *
 * A pistol's or a rifle's first bullet only cracks a pane: a small hole with cracks running out from
 * it, on both faces, where it struck (`crack`). The pane still stands and still stops you; the next
 * bullet brings it down. A shotgun, a sniper rifle, a blast or a zombie breaks it at once.
 */

interface Shard {
  mesh: THREE.Mesh;
  v: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
  floor: number;
  /** s it still hangs in its place before it falls (the pieces far from the bullet let go last) */
  wait: number;
}

/** Shards per square metre of pane, and the fewest and the most from one pane. */
const SHARDS_M2 = 22;
const SHARDS_MIN = 24;
const SHARDS_MAX = 70;
/** A shard's shape, flat: a small triangle, a long sliver, a four-cornered piece, a pointed dagger. */
const shardGeos = [
  [0, 0, 0, 0.06, 0.01, 0, 0.02, 0.07, 0],
  [0, 0, 0, 0.025, 0.004, 0, 0.012, 0.16, 0],
  [0, 0, 0, 0.07, 0.015, 0, 0.085, 0.07, 0, 0, 0, 0, 0.085, 0.07, 0, 0.01, 0.06, 0],
  [0, 0, 0, 0.05, 0, 0, 0.03, 0.12, 0],
].map((corners) => {
  const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(corners, 3));
  g.computeVertexNormals();
  return g;
});
const shardMat = new THREE.MeshStandardMaterial({
  color: '#d6ecf5', roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
});

let crackMap: THREE.CanvasTexture | null = null;
/**
 * A bullet's mark in glass, drawn in code once: a small dark hole with a bright crushed rim, cracks
 * running out from it (each a jagged line that thins), and two broken rings where the cracks join.
 * The same picture for every crack, turned and sized differently; from a fixed seed.
 */
function crackTexture(): THREE.CanvasTexture {
  if (crackMap) return crackMap;
  const N = 256;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d')!;
  let seed = 0x51ed270b;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const mid = N / 2;
  g.lineCap = 'round';
  const rays = 11;
  const ends: number[] = [];
  for (let k = 0; k < rays; k++) {
    const a = ((k + rnd() * 0.7) / rays) * Math.PI * 2;
    const len = (0.45 + rnd() * 0.5) * mid;
    ends.push(a);
    let x = mid;
    let y = mid;
    const steps = 7;
    for (let s = 1; s <= steps; s++) {
      const r = (len * s) / steps;
      const wob = a + (rnd() - 0.5) * 0.22;
      const nx = mid + Math.cos(wob) * r;
      const ny = mid + Math.sin(wob) * r;
      g.strokeStyle = `rgba(240, 249, 252, ${(1 - 0.6 * (s / steps)).toFixed(2)})`;
      g.lineWidth = 3.4 * (1 - s / (steps + 1)) + 0.9;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(nx, ny);
      g.stroke();
      [x, y] = [nx, ny];
    }
  }
  for (const [r, alpha] of [[0.2, 0.75], [0.42, 0.5]] as const) {
    for (let k = 0; k < rays; k++) {
      if (rnd() < 0.3) continue; // a ring is never whole
      const a0 = ends[k];
      const a1 = ends[(k + 1) % rays] + (k + 1 === rays ? Math.PI * 2 : 0);
      const rr = r * mid * (0.9 + rnd() * 0.2);
      g.strokeStyle = `rgba(230, 244, 250, ${alpha})`;
      g.lineWidth = 1.8;
      g.beginPath();
      g.moveTo(mid + Math.cos(a0) * rr, mid + Math.sin(a0) * rr);
      g.lineTo(mid + Math.cos(a1) * rr, mid + Math.sin(a1) * rr);
      g.stroke();
    }
  }
  const rim = g.createRadialGradient(mid, mid, 1, mid, mid, 11);
  rim.addColorStop(0, 'rgba(12, 16, 20, 0.95)');
  rim.addColorStop(0.42, 'rgba(12, 16, 20, 0.9)');
  rim.addColorStop(0.5, 'rgba(245, 252, 255, 0.95)');
  rim.addColorStop(1, 'rgba(240, 250, 255, 0)');
  g.fillStyle = rim;
  g.beginPath();
  g.arc(mid, mid, 11, 0, Math.PI * 2);
  g.fill();
  crackMap = new THREE.CanvasTexture(c);
  crackMap.colorSpace = THREE.SRGBColorSpace;
  return crackMap;
}
const crackGeo = new THREE.PlaneGeometry(1, 1);
let crackMat: THREE.MeshBasicMaterial | null = null;

export class Glass {
  private broken = new Set<number>();
  /** The panes with a crack in them, and the crack's marks (one on each face) */
  private cracks = new Map<number, THREE.Mesh[]>();
  private shards: Shard[] = [];
  /**
   * Whether a shot or a blast may break pane `index` here: false for the panes of a code-locked home that this page has
   * not unlocked (src/world/homeLocks.ts). Set by main.ts. What the server says is broken is shown whatever this says.
   */
  locked: (index: number) => boolean = () => false;

  /** Panes that aren't house blocks (glass in door leaves), with what to do when one breaks or is back */
  private others = new Map<number, (broken: boolean) => void>();
  /** Panes the server says are broken that aren't here yet (a house whose inside comes later) */
  private pending = new Set<number>();

  constructor(private panes: Map<number, THREE.Mesh>, private world: World, private scene: THREE.Scene) {}

  /** More breakable panes, such as the glass in doors; `onBreak` frees the way through (and closes it again on repair). */
  add(panes: Map<number, THREE.Mesh>, onBreak: (index: number, broken: boolean) => void): void {
    for (const [i, pane] of panes) {
      this.panes.set(i, pane);
      this.others.set(i, (broken) => onBreak(i, broken));
      if (this.pending.delete(i)) this.break(i, null, undefined, true);
    }
  }

  /** Where a pane is now, in the world (door glass moves with its leaf). */
  bounds(index: number): THREE.Box3 | null {
    const pane = this.panes.get(index);
    return pane ? new THREE.Box3().setFromObject(pane) : null;
  }

  private setSolid(index: number, on: boolean): void {
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) return;
    const other = this.others.get(index);
    if (typeof other === 'function') other(!on);
    else this.world.setPane(index, on); // a house pane: its number is the block's `glass`
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

  /**
   * Break pane `index`. `hit` is where the bullet struck (shards fly from there); null breaks it quietly (joining a game).
   * `told`: the server says so (another player broke it, or it is broken in the game we join): a lock does not stop that.
   */
  break(index: number, hit: THREE.Vector3 | null, from?: THREE.Vector3, told = false): boolean {
    if (!told && this.locked(index)) return false;
    const pane = this.panes.get(index);
    if (!pane) this.pending.add(index); // broken before its house came: broken once it does
    if (!pane || this.broken.has(index)) return false;
    this.broken.add(index);
    this.uncrack(index);
    const box = new THREE.Box3().setFromObject(pane);
    pane.visible = false;
    this.setSolid(index, false);
    if (!hit) return true;

    const dir = from ? hit.clone().sub(from).setY(0).normalize() : new THREE.Vector3();
    // More shards from a large pane, of four shapes and many sizes. Those from near where it was struck fly off
    // with the bullet; those from further out drop almost straight down, and the lowest ones a moment later.
    const size = box.getSize(new THREE.Vector3());
    const area = size.y * Math.max(size.x, size.z);
    const reach = Math.max(0.5, Math.hypot(size.y, Math.max(size.x, size.z)) / 2);
    const count = Math.round(Math.max(SHARDS_MIN, Math.min(SHARDS_MAX, area * SHARDS_M2)));
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(shardGeos[i % shardGeos.length], shardMat);
      mesh.position.set(
        THREE.MathUtils.lerp(box.min.x, box.max.x, Math.random()),
        THREE.MathUtils.lerp(box.min.y, box.max.y, Math.random()),
        THREE.MathUtils.lerp(box.min.z, box.max.z, Math.random()),
      );
      mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      mesh.scale.setScalar(0.5 + Math.random() * Math.random() * 2.6);
      mesh.userData.ignoreRay = true;
      this.scene.add(mesh);
      const near = Math.max(0, 1 - mesh.position.distanceTo(hit) / reach); // 1 at the bullet, 0 at the far corner
      const v = dir.clone().multiplyScalar((0.3 + 3.2 * near) * (0.6 + Math.random() * 0.8))
        .add(new THREE.Vector3((Math.random() - 0.5) * (0.4 + near), Math.random() * 1.4 * near, (Math.random() - 0.5) * (0.4 + near)));
      this.shards.push({ mesh, v, spin: new THREE.Vector3(Math.random() * 10, Math.random() * 10, Math.random() * 10), life: 2.5 + (1 - near) * 0.6, floor: box.min.y - 3.2, wait: (1 - near) * 0.18 * Math.random() });
    }
    this.shatterSound(hit);
    return true;
  }

  /** Whether pane `index` has a crack in it (the next bullet breaks it). */
  cracked(index: number): boolean {
    return this.cracks.has(index);
  }

  /**
   * A bullet's first hit on pane `index`, at `hit` (in the world): a crack there, on both faces, and the tick of
   * glass giving. True when that is new: false for a pane that is cracked already (break it), broken, locked or
   * not here. `told`: the server says so (another player's bullet): a lock does not stop that. `quiet`: no sound
   * (the cracks there were when we joined).
   */
  crack(index: number, hit: THREE.Vector3, told = false, quiet = false): boolean {
    if (!told && this.locked(index)) return false;
    const pane = this.panes.get(index);
    if (!pane || this.broken.has(index) || this.cracks.has(index)) return false;
    const geo = pane.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const box = geo.boundingBox!;
    const size = box.getSize(new THREE.Vector3());
    // The pane's thin way is through the glass; the mark lies in the other two, on each face.
    const thin = size.x <= size.y && size.x <= size.z ? 'x' : size.z <= size.y ? 'z' : 'y';
    const at = pane.worldToLocal(hit.clone());
    crackMat ??= new THREE.MeshBasicMaterial({ map: crackTexture(), transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const across = 0.7 + ((index * 37) % 10) * 0.04; // m: each pane its own size and turn, the same for everyone
    const turn = ((index * 53) % 17) * 0.37;
    const marks: THREE.Mesh[] = [];
    for (const face of [box.min[thin] - 0.003, box.max[thin] + 0.003]) {
      const mark = new THREE.Mesh(crackGeo, crackMat);
      mark.position.copy(at);
      mark.position[thin] = face;
      if (thin === 'x') mark.rotation.set(turn, Math.PI / 2, 0, 'YXZ');
      else if (thin === 'y') mark.rotation.set(Math.PI / 2, 0, turn);
      else mark.rotation.set(0, 0, turn);
      // Its size in the world, whatever the pane's own scale.
      mark.scale.set(across / pane.scale.x, across / pane.scale.y, across / pane.scale.z);
      mark.renderOrder = pane.renderOrder + 1;
      mark.userData.ignoreRay = true;
      mark.raycast = () => {};
      pane.add(mark);
      marks.push(mark);
    }
    this.cracks.set(index, marks);
    if (!quiet) this.crackSound(hit);
    return true;
  }

  private uncrack(index: number): void {
    for (const m of this.cracks.get(index) ?? []) m.removeFromParent();
    this.cracks.delete(index);
  }

  /** The crack of glass giving without falling: a sharp tick and one small ring, made in code. */
  private crackSound(at: THREE.Vector3): void {
    const ctx = sound.context();
    const dest = sound.at(at.x, at.y, at.z, 3);
    if (!ctx || !dest) return;
    const t = ctx.currentTime;
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.05), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 6);
    const tick = ctx.createBufferSource();
    tick.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3500;
    const gain = ctx.createGain();
    gain.gain.value = 0.5;
    tick.connect(hp).connect(gain).connect(dest);
    tick.start(t);
    const o = ctx.createOscillator();
    o.frequency.value = 5200 + Math.random() * 1800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.05, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + 0.18);
  }

  repair(): void {
    this.pending.clear();
    for (const index of [...this.cracks.keys()]) this.uncrack(index);
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
      if (s.wait > 0) {
        s.wait -= dt;
        continue;
      }
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
