import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type { Body } from '../net/swat';
import { DROP } from '../../shared/parachute.mjs';
import { PilotPose } from './parachutePilot';

/**
 * Parachutes being flown (shared/parachute.mjs, docs/parachute/README.md): yours, which you don't see
 * yourself except overhead and round you, and the other players', on their figures. The model
 * (web/public/models/parachute.glb, 0.13 MB sent) is fetched the first time someone drops.
 *
 * Each one plays its clips by what the player does: packed for a moment, Deploy, the three glide clips
 * blended by how fast they turn, Flare near the ground, and Land_Collapse once they are on their feet
 * (then it is taken away). An other player's figure is posed on the parachute's guides while in the
 * air (world/parachutePilot.ts). Only drawn: their hit boxes, and where the server has them, don't change.
 */

type Clip = 'Deploy' | 'Glide_Idle' | 'Glide_Left' | 'Glide_Right' | 'Flare' | 'Land_Collapse';
const CLIPS: Clip[] = ['Deploy', 'Glide_Idle', 'Glide_Left', 'Glide_Right', 'Flare', 'Land_Collapse'];
const ONCE: Clip[] = ['Deploy', 'Flare', 'Land_Collapse'];
const LAND = 2.4; // s, the Land_Collapse clip
const GLOW = 0.28; // the accent's emissive: the player's colour times this (as the canopy's own)
/** Everything the clips reach (docs/parachute/manifest.json): a skinned mesh is culled by it, not by its rest pose. */
const REACH = new THREE.Box3(new THREE.Vector3(-3.8, 0, -4.1), new THREE.Vector3(3.8, 5.9, 2.4));
const SPHERE = REACH.getBoundingSphere(new THREE.Sphere());
/**
 * Your own: only the canopy and its lines overhead, so the view stays free (Yoshi: "keep the view obstruction
 * by the parachute harness as limited as possible"). The harness (Pilot: arms, risers, pack, legs), the grips
 * and the toggles start a hand's width from the eye and filled the screen's sides as broad dark slabs.
 */
const HIDDEN_OWN = ['Pilot', 'Grip_L', 'Grip_R', 'Toggle_L', 'Toggle_R'];

interface Flight {
  holder: THREE.Object3D;
  rig: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  act: Record<Clip, THREE.AnimationAction>;
  lods: THREE.Object3D[][];
  lod: number;
  pilot: PilotPose | null;
  own: boolean;
  phase: 'pack' | 'open' | 'glide' | 'flare' | 'land';
  t: number;
  steer: number;
  yaw: number;
  w: { deploy: number; glide: number; flare: number; land: number };
  /** When `fly` last came for it (ms): a figure skips frames now and then (no fresh state) */
  seen: number;
  /** Stowed after landing: taken away */
  done: boolean;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const _v = new THREE.Vector3();

export class Parachutes {
  /** Beyond this (m from the camera) the simpler model: sooner on Low, where thin lines break up. */
  far = 35;
  private gltf: GLTF | null = null;
  private loading = false;
  private flights = new Map<string, Flight>();
  private accents = new Map<string, THREE.Material>();

  /**
   * Each frame, for each player who may be under a parachute. `holder`: the group they are drawn in (at
   * their feet, turned their way); `body`: their figure (null for your own, which isn't drawn);
   * `dropping`: under the canopy now; `air`: their feet over the ground; `since`: seconds since the drop
   * began when known (yours), else null. Call `sweep` once after everyone.
   */
  fly(key: string, holder: THREE.Object3D, body: Body | null, colour: string, dropping: boolean, air: number, dt: number, eye: THREE.Vector3, since: number | null = null): void {
    let f = this.flights.get(key);
    if (!f) {
      if (!dropping) return;
      this.load();
      if (!this.gltf) return; // drawn from the frame the model is in
      // Seen first well below where drops start (they were already under way): the canopy open at once.
      f = this.make(holder, body, colour, since ?? (air < DROP.height - 6 ? DROP.fall + DROP.deploy : 0));
      this.flights.set(key, f);
    }
    f.seen = performance.now();
    f.t += dt;
    if (dropping && f.phase === 'land') {
      this.restart(f, 0); // down and up again (a quick respawn)
      f.done = false;
    }
    // How hard they turn, from how fast their facing changes: the steering the clips show.
    const yaw = holder.rotation.y;
    const rate = dt > 0 ? wrap(yaw - f.yaw) / dt : 0;
    f.yaw = yaw;
    f.steer += (Math.max(-1, Math.min(1, -rate / DROP.turn)) - f.steer) * (1 - Math.exp(-dt * 5));
    if (!dropping && f.phase !== 'land') {
      f.phase = 'land';
      f.t = 0;
      f.act.Land_Collapse.reset().play();
    }
    switch (f.phase) {
      case 'pack':
        if (f.t >= DROP.fall) {
          f.phase = 'open';
          f.act.Deploy.paused = false;
        }
        break;
      case 'open':
        if (f.act.Deploy.time >= DROP.deploy - 0.2) {
          if (f.w.glide === 0) for (const c of ['Glide_Idle', 'Glide_Left', 'Glide_Right'] as Clip[]) f.act[c].reset().play();
          f.w.glide = Math.min(1, f.w.glide + dt / 0.2);
          f.w.deploy = 1 - f.w.glide;
          if (f.w.glide >= 1) f.phase = 'glide';
        }
        break;
      case 'glide':
        if (air < DROP.flareAt) {
          f.phase = 'flare';
          f.act.Flare.reset().play();
        }
        break;
      case 'flare':
        f.w.flare = Math.min(1, f.w.flare + dt / 0.2);
        f.w.glide = 1 - f.w.flare;
        break;
      case 'land': {
        f.w.land = Math.min(1, f.w.land + dt / 0.12);
        const rest = 1 - f.w.land;
        f.w.deploy = Math.min(f.w.deploy, rest);
        f.w.glide = Math.min(f.w.glide, rest);
        f.w.flare = Math.min(f.w.flare, rest);
        break;
      }
    }
    this.weights(f);
    f.mixer.update(dt);
    // Simpler from afar.
    const lod = holder.getWorldPosition(_v).distanceTo(eye) > this.far ? 1 : 0;
    if (lod !== f.lod) this.showLod(f, lod);
    if (f.own) for (const n of HIDDEN_OWN) f.rig.getObjectByName(n)?.scale.setScalar(0.001);
    f.rig.updateMatrixWorld(true);
    // Their figure in the harness while in the air; on the ground it walks as ever.
    if (f.pilot && f.phase !== 'land') f.pilot.apply(false);
    if (f.phase === 'land' && f.t >= LAND) f.done = true; // stowed: taken away in sweep
  }

  /** After everyone's `fly`: parachutes stowed, or nobody flew for a second (the player left), are taken away. */
  sweep(): void {
    const now = performance.now();
    for (const [key, f] of this.flights) {
      if (!f.done && now - f.seen < 1000) continue;
      f.mixer.stopAllAction();
      f.mixer.uncacheRoot(f.rig);
      f.rig.removeFromParent();
      this.flights.delete(key);
    }
  }

  /** Whether `key` is drawn under a parachute (for the figure's blinking, say). */
  has(key: string): boolean {
    return this.flights.has(key);
  }

  /** Fetch the model now, before anyone drops (after the world is in: it is small). */
  load(): void {
    if (this.loading) return;
    this.loading = true;
    new GLTFLoader().loadAsync('/models/parachute.glb').then(
      (g) => (this.gltf = g),
      () => {
        // No model: the drop plays the same, without a parachute to see.
      },
    );
  }

  private make(holder: THREE.Object3D, body: Body | null, colour: string, since: number | null): Flight {
    const gltf = this.gltf!;
    // Each its own bones (SkeletonUtils.clone, as the figures); the geometry and materials are shared,
    // one accent material per colour.
    const rig = SkeletonUtils.clone(gltf.scene);
    const lods: THREE.Object3D[][] = [[], []];
    rig.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh) return;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (mat.name === 'Parachute_Accent') mesh.material = this.accent(mat, colour);
      mesh.boundingSphere = SPHERE.clone();
      mesh.boundingBox = REACH.clone();
      const lod = /LOD1/.test(mesh.name) || /LOD1/.test(mesh.parent?.name ?? '') ? 1 : 0;
      mesh.castShadow = lod === 0;
      lods[lod].push(mesh);
    });
    holder.add(rig);
    let pilot: PilotPose | null = null;
    if (body) {
      try {
        pilot = new PilotPose(holder, rig, body.root);
      } catch {
        pilot = null; // the block figures (no bones): the parachute without posing them
      }
    }
    const mixer = new THREE.AnimationMixer(rig);
    const act = {} as Record<Clip, THREE.AnimationAction>;
    for (const c of CLIPS) {
      const a = mixer.clipAction(gltf.animations.find((x) => x.name === c) ?? new THREE.AnimationClip(c, 0, []));
      if (ONCE.includes(c)) {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      }
      act[c] = a;
    }
    const f: Flight = {
      holder, rig, mixer, act, lods, lod: -1, pilot, own: !body, phase: 'pack', t: 0, steer: 0, yaw: holder.rotation.y,
      w: { deploy: 1, glide: 0, flare: 0, land: 0 }, seen: performance.now(), done: false,
    };
    this.restart(f, since ?? 0);
    return f;
  }

  /** From the start of a drop, `since` seconds in. */
  private restart(f: Flight, since: number): void {
    f.mixer.stopAllAction();
    f.w = { deploy: 1, glide: 0, flare: 0, land: 0 };
    f.t = since;
    const open = since - DROP.fall;
    if (open >= DROP.deploy) {
      // Already gliding (your own model came in late): straight to it.
      f.phase = 'glide';
      f.w = { deploy: 0, glide: 1, flare: 0, land: 0 };
      for (const c of ['Glide_Idle', 'Glide_Left', 'Glide_Right'] as Clip[]) f.act[c].reset().play();
    } else {
      f.phase = open >= 0 ? 'open' : 'pack';
      const d = f.act.Deploy.reset().play();
      d.time = Math.max(0, open);
      d.paused = open < 0; // its first frame is everything in the pack
    }
    this.weights(f);
  }

  private weights(f: Flight): void {
    const s = f.steer;
    const g = f.w.glide;
    f.act.Deploy.setEffectiveWeight(f.w.deploy);
    f.act.Glide_Idle.setEffectiveWeight(g * (1 - Math.abs(s)));
    f.act.Glide_Left.setEffectiveWeight(g * Math.max(0, -s));
    f.act.Glide_Right.setEffectiveWeight(g * Math.max(0, s));
    f.act.Flare.setEffectiveWeight(f.w.flare);
    f.act.Land_Collapse.setEffectiveWeight(f.w.land);
  }

  private showLod(f: Flight, lod: number): void {
    f.lod = lod;
    for (const m of f.lods[0]) m.visible = lod === 0;
    for (const m of f.lods[1]) m.visible = lod === 1;
  }

  /** The player's colour on the canopy's coloured cells, the toggles and the pack's flap. */
  private accent(src: THREE.MeshStandardMaterial, colour: string): THREE.Material {
    let m = this.accents.get(colour);
    if (!m) {
      const c = src.clone();
      c.color.set(colour);
      c.emissive.set(colour).multiplyScalar(GLOW);
      this.accents.set(colour, (m = c));
    }
    return m;
  }
}
