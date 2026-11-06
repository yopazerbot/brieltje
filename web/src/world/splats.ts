import * as THREE from 'three';
import { anyPaint } from '../paintball';
import { sound } from '../sound';
import { splatSheet } from './sprites';

/**
 * Paintball's paint (paintball.ts): the paintballs themselves, flying from the gun in a low arc,
 * and what they leave. On walls, floors and the ground a splat, stretched where the ball came in
 * at an angle; they stay a while and then fade, all in one instanced draw call (the oldest makes
 * room for the newest, and the fading is worked out on the graphics card, so it costs nothing
 * per frame). On a door or a car the splat is a small mesh of its own on it, so it swings or
 * drives off with it. On players, clowns and strongmen a blob of paint sticks to the body part
 * that was hit, moves with it and shrinks away after a few seconds. No lights, no new shaders:
 * the splats are the standard material with the fade added.
 */

const MAX = 120; // splats on walls and floors at once
const LOOSE = 16; // splats on doors and the cars at once
const STAY = 25; // s a splat stays as it landed
const FADE = 5; // s it takes to fade away after that
const BLOBS = 40; // blobs of paint on figures at once
const BLOB_STAY = 8; // s before a blob shrinks away
const BALLS = 48;
/** How fast the paintballs fly (m/s): about a real one's speed, slow enough to see them go. */
export const BALL_SPEED = 75;

/** What a paintball carries: its colour, and how big its splat is (m). */
export interface Paint {
  color: THREE.Color;
  size: number;
}

interface Ball {
  i: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
  /** Flight time (s), how high the arc rises over the straight line (m), time flown */
  time: number;
  rise: number;
  age: number;
  paint: Paint;
  /** What happens where it lands (the splat, its sound), with the direction it came from */
  then: ((paint: Paint, dir: THREE.Vector3) => void)[];
}

/** The clock the splats fade on, shared with their shader. */
const clock = { value: 0 };

/** The standard material, with each splat's cell of the sheet and its fade. */
function fading(material: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uClock = clock;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aSplat;\nuniform float uClock;\nvarying float vFade;')
      .replace('#include <uv_vertex>', `#include <uv_vertex>\nvMapUv = vMapUv * 0.5 + aSplat.xy;\nvFade = clamp((aSplat.z + ${STAY + FADE}.0 - uClock) / ${FADE}.0, 0.0, 1.0);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFade;')
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a *= vFade;');
  };
  return material;
}

/** Bottom-left of a cell of the 2 x 2 sheet, in texture coordinates. */
const cellOffset = (cell: number): [number, number] => [(cell % 2) * 0.5, 0.5 - Math.floor(cell / 2) * 0.5];

let lastSound = 0;
/** A wet splat, made in code: a burst of noise falling in pitch and a short plop. Bigger for a balloon or the cannon. */
export function splatSound(at: THREE.Vector3, big = false): void {
  const ctx = sound.context();
  // Eight pellets of one shot land together: one splat is enough.
  if (!ctx || (!big && ctx.currentTime - lastSound < 0.04)) return;
  lastSound = ctx.currentTime;
  const dest = sound.at(at.x, at.y, at.z, big ? 10 : 3);
  if (!dest) return;
  const t = ctx.currentTime;
  const len = big ? 0.7 : 0.2;
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * len), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, big ? 2.5 : 3.5);
  const noise = ctx.createBufferSource();
  noise.buffer = buf;
  const low = ctx.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.setValueAtTime(big ? 1800 : 2600, t);
  low.frequency.exponentialRampToValueAtTime(big ? 140 : 420, t + len);
  const ng = ctx.createGain();
  ng.gain.value = big ? 0.8 : 0.35;
  noise.connect(low).connect(ng).connect(dest);
  noise.start(t);
  const plop = ctx.createOscillator();
  plop.frequency.setValueAtTime(big ? 240 : 460, t);
  plop.frequency.exponentialRampToValueAtTime(big ? 55 : 150, t + (big ? 0.32 : 0.09));
  const pg = ctx.createGain();
  pg.gain.setValueAtTime(big ? 0.5 : 0.22, t);
  pg.gain.exponentialRampToValueAtTime(0.001, t + (big ? 0.4 : 0.12));
  plop.connect(pg).connect(dest);
  plop.start(t);
  plop.stop(t + 0.45);
}

export class Splats {
  readonly group = new THREE.Group();
  private mesh: THREE.InstancedMesh;
  private cells: THREE.InstancedBufferAttribute;
  private born = new Float32Array(MAX).fill(-1e9);
  private next = 0;
  private sweep = 0;
  private loose: { mesh: THREE.Mesh; born: number }[] = [];
  private looseMat: THREE.MeshStandardMaterial;
  private blobGeo = new THREE.IcosahedronGeometry(1, 2);
  private blobMats = new Map<string, THREE.MeshStandardMaterial>();
  private blobs: { mesh: THREE.Mesh; age: number; scale: THREE.Vector3 }[] = [];
  private balls: Ball[] = [];
  private ballMesh: THREE.InstancedMesh;
  private nextBall = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private x = new THREE.Vector3();
  private y = new THREE.Vector3();
  private z = new THREE.Vector3(0, 0, 1);

  constructor(scene: THREE.Scene) {
    const map = splatSheet();
    // Wet paint: smooth, not metal. polygonOffset keeps it on top of the surface it lies on.
    const common = { map, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, roughness: 0.35 };
    const geo = new THREE.PlaneGeometry(1, 1);
    this.cells = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3).fill(-1e9), 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aSplat', this.cells);
    this.mesh = new THREE.InstancedMesh(geo, fading(new THREE.MeshStandardMaterial(common)), MAX);
    this.mesh.setColorAt(0, new THREE.Color()); // a colour per splat from the start
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.userData.ignoreRay = true;
    this.mesh.raycast = () => {};
    this.looseMat = fading(new THREE.MeshStandardMaterial({ ...common, vertexColors: true }));
    // The paintballs: small glossy spheres, one instanced draw call, stretched along their flight.
    this.ballMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshStandardMaterial({ roughness: 0.25 }), BALLS);
    this.ballMesh.setColorAt(0, new THREE.Color());
    this.ballMesh.count = 0;
    this.ballMesh.frustumCulled = false;
    this.ballMesh.userData.ignoreRay = true;
    this.ballMesh.raycast = () => {};
    this.group.add(this.mesh, this.ballMesh);
    scene.add(this.group);
  }

  /** A paintball from `from` to `to` (where the shot hit, or as far as it goes). */
  ball(from: THREE.Vector3, to: THREE.Vector3, paint: Paint): void {
    const time = Math.max(0.02, from.distanceTo(to) / BALL_SPEED);
    // It drops on the way, so it leaves a little upwards: the arc's top over the straight line.
    const rise = (9.81 * time * time) / 8;
    const i = this.nextBall;
    this.nextBall = (this.nextBall + 1) % BALLS;
    const old = this.balls.findIndex((b) => b.i === i);
    if (old >= 0) this.land(this.balls.splice(old, 1)[0]); // all slots flying: the oldest lands now
    this.balls.push({ i, from: from.clone(), to: to.clone(), time, rise, age: 0, paint, then: [] });
    this.ballMesh.setMatrixAt(i, this.m.makeScale(0, 0, 0)); // placed on its first update
    this.ballMesh.count = Math.max(this.ballMesh.count, i + 1);
    this.ballMesh.setColorAt(i, paint.color);
    this.ballMesh.instanceColor!.needsUpdate = true;
  }

  /**
   * Do `fn` where a paintball fired this frame lands at `point`, once it gets there, with its paint
   * and the way it was going. Without one (nothing was fired at that point) at once, in any colour.
   */
  landing(point: THREE.Vector3, fn: (paint: Paint, dir: THREE.Vector3) => void): void {
    const ball = this.balls.find((b) => b.age === 0 && b.to.distanceToSquared(point) < 0.0025);
    if (ball) ball.then.push(fn);
    else fn({ color: new THREE.Color(anyPaint()), size: 0.3 }, new THREE.Vector3(0, -1, 0));
  }

  /**
   * A splat at `point` on a surface facing `normal`, `size` metres across, stretched along `dir`
   * (the paintball's flight) when it came in at an angle. On a door or a car (`on` is one of
   * their meshes) it goes on that mesh instead.
   */
  add(point: THREE.Vector3, normal: THREE.Vector3, color: THREE.Color, size: number, on?: THREE.Object3D, dir?: THREE.Vector3): void {
    // Its long side along the flight as seen on the surface; straight on, any way round.
    const along = dir ? this.x.copy(dir).addScaledVector(normal, -dir.dot(normal)) : this.x.set(0, 0, 0);
    if (along.lengthSq() < 0.01) along.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).cross(normal);
    along.normalize();
    this.y.crossVectors(normal, along);
    this.m.makeBasis(along, this.y, normal);
    this.q.setFromRotationMatrix(this.m);
    const stretch = dir ? Math.min(1.7, 1 / Math.max(0.6, Math.abs(dir.dot(normal)))) : 1;
    const s = size * (0.85 + Math.random() * 0.3);
    this.s.set(s * stretch, s, s);
    this.v.copy(point).addScaledVector(normal, 0.004);
    const cell = Math.floor(Math.random() * 4);
    const [u, w] = cellOffset(cell);
    if (on?.userData.door || on?.userData.vehicle) {
      const geo = new THREE.PlaneGeometry(1, 1);
      geo.setAttribute('aSplat', new THREE.Float32BufferAttribute([u, w, clock.value, u, w, clock.value, u, w, clock.value, u, w, clock.value], 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(Array(4).fill([color.r, color.g, color.b]).flat(), 3));
      const mesh = new THREE.Mesh(geo, this.looseMat);
      mesh.position.copy(this.v);
      mesh.quaternion.copy(this.q);
      mesh.scale.copy(this.s);
      mesh.userData.ignoreRay = true;
      mesh.raycast = () => {};
      on.updateWorldMatrix(true, false);
      on.attach(mesh);
      this.loose.push({ mesh, born: clock.value });
      if (this.loose.length > LOOSE) this.dropLoose(0);
      return;
    }
    const i = this.next;
    this.next = (this.next + 1) % MAX;
    this.mesh.count = Math.max(this.mesh.count, i + 1);
    this.m.compose(this.v, this.q, this.s);
    this.mesh.setMatrixAt(i, this.m);
    this.mesh.setColorAt(i, color);
    this.cells.setXYZ(i, u, w, clock.value);
    this.born[i] = clock.value;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
    this.cells.needsUpdate = true;
  }

  /**
   * A blob of paint stuck on `on` at `point`, the surface there facing `normal`, `size` metres
   * across. `on` is what it moves with: a strongman's arm, or a player's hit box (the head's follows
   * the head; both are hidden while the player is out, and the blob goes with that).
   */
  stick(point: THREE.Vector3, normal: THREE.Vector3, on: THREE.Object3D, color: THREE.Color, size: number): void {
    const key = color.getHexString();
    let mat = this.blobMats.get(key);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({ color, roughness: 0.3 });
      this.blobMats.set(key, mat);
    }
    const mesh = new THREE.Mesh(this.blobGeo, mat);
    // A flattened lump on the surface, a little lopsided, turned any way round.
    mesh.position.copy(point).addScaledVector(normal, size * 0.06);
    mesh.quaternion.setFromUnitVectors(this.z, normal).multiply(this.q.setFromAxisAngle(this.z, Math.random() * Math.PI * 2));
    mesh.scale.set(size * (0.45 + Math.random() * 0.2), size * (0.35 + Math.random() * 0.15), size * 0.14);
    mesh.userData.ignoreRay = true;
    mesh.raycast = () => {};
    on.updateWorldMatrix(true, false);
    on.attach(mesh);
    this.blobs.push({ mesh, age: 0, scale: mesh.scale.clone() });
    if (this.blobs.length > BLOBS) this.blobs.shift()!.mesh.removeFromParent();
  }

  private dropLoose(k: number): void {
    const { mesh } = this.loose.splice(k, 1)[0];
    mesh.removeFromParent();
    mesh.geometry.dispose();
  }

  private land(b: Ball): void {
    const dir = this.v.copy(b.to).sub(b.from).normalize().clone();
    for (const fn of b.then) fn(b.paint, dir);
    this.m.makeScale(0, 0, 0);
    this.ballMesh.setMatrixAt(b.i, this.m);
  }

  update(dt: number): void {
    clock.value += dt;

    // Paintballs: along the straight line with the arc added on top, stretched along their flight.
    for (let k = this.balls.length - 1; k >= 0; k--) {
      const b = this.balls[k];
      b.age += dt;
      const f = Math.min(1, b.age / b.time);
      if (f >= 1) {
        this.balls.splice(k, 1);
        this.land(b);
        continue;
      }
      this.v.copy(b.from).lerp(b.to, f);
      this.v.y += 4 * b.rise * f * (1 - f);
      this.x.copy(b.to).sub(b.from).divideScalar(b.time);
      this.x.y += (4 * b.rise * (1 - 2 * f)) / b.time;
      this.q.setFromUnitVectors(this.z, this.x.normalize());
      // Small just out of the gun (it is right in front of the eye), full size a few metres on:
      // larger than a real one (1.7 cm) and drawn out along its flight, or it couldn't be seen.
      const r = 0.006 + 0.03 * Math.min(1, (f * b.time * BALL_SPEED) / 4);
      this.m.compose(this.v, this.q, this.s.set(r, r, r * 3));
      this.ballMesh.setMatrixAt(b.i, this.m);
    }
    this.ballMesh.instanceMatrix.needsUpdate = true;

    // Blobs: stay, then shrink away; gone at once when what they stick to is hidden (a player who is out).
    for (let k = this.blobs.length - 1; k >= 0; k--) {
      const b = this.blobs[k];
      b.age += dt;
      const left = 1 - Math.max(0, b.age - BLOB_STAY) / 0.8;
      if (left <= 0 || !b.mesh.parent?.visible) {
        b.mesh.removeFromParent();
        this.blobs.splice(k, 1);
      } else if (left < 1) b.mesh.scale.copy(b.scale).multiplyScalar(left);
    }

    // Twice a second: splats that have faded away are taken out (nothing drawn for them any more).
    this.sweep -= dt;
    if (this.sweep > 0) return;
    this.sweep = 0.5;
    let gone = false;
    for (let i = 0; i < this.mesh.count; i++) {
      if (this.born[i] + STAY + FADE >= clock.value || this.born[i] < -1e8) continue;
      this.born[i] = -1e9;
      this.mesh.setMatrixAt(i, this.m.makeScale(0, 0, 0));
      gone = true;
    }
    if (gone) this.mesh.instanceMatrix.needsUpdate = true;
    for (let k = this.loose.length - 1; k >= 0; k--) if (this.loose[k].born + STAY + FADE < clock.value || !this.loose[k].mesh.parent) this.dropLoose(k);
  }
}
