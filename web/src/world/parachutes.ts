import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type { Body } from '../net/swat';
import { DROP, dropSince } from '../../shared/parachute.mjs';
import { PilotPose } from './parachutePilot';

/**
 * Parachutes being flown (shared/parachute.mjs, docs/parachute/README.md): yours, which you don't see
 * yourself except overhead and round you, and the other players', on their figures. The model
 * (web/public/models/parachute.glb, 0.13 MB sent) is fetched the first time someone drops.
 *
 * Each one plays its clips by what the player does: packed in the free fall, Deploy, the three glide clips
 * blended by how fast they turn, Flare near the ground, and Land_Collapse once they are on their feet
 * (then it is taken away). Every change of clip is a cross-fade eased in and out, so nothing snaps. An other
 * player's figure is posed on the parachute's guides while in the air (world/parachutePilot.ts): face down,
 * arms out in the free fall, swung upright as the canopy opens, swinging a little under it (a pendulum
 * round the canopy, out of the turns and with the opening's surge), and handed back to its own animation
 * gently after landing. Only drawn: their hit boxes, and where the server has them, don't change.
 */

type Clip = 'Deploy' | 'Glide_Idle' | 'Glide_Left' | 'Glide_Right' | 'Flare' | 'Land_Collapse';
const CLIPS: Clip[] = ['Deploy', 'Glide_Idle', 'Glide_Left', 'Glide_Right', 'Flare', 'Land_Collapse'];
const ONCE: Clip[] = ['Deploy', 'Flare', 'Land_Collapse'];
const GLIDES: Clip[] = ['Glide_Idle', 'Glide_Left', 'Glide_Right'];
const LAND_RATE = 0.8; // Land_Collapse a little slower than made: the canopy settles softly
const LAND = 2.4 / LAND_RATE; // s, Land_Collapse at that rate
const GLOW = 0.28; // the accent's emissive: the player's colour times this (as the canopy's own)
/** Everything the clips reach (docs/parachute/manifest.json): a skinned mesh is culled by it, not by its rest pose. */
const REACH = new THREE.Box3(new THREE.Vector3(-3.8, 0, -4.1), new THREE.Vector3(3.8, 5.9, 2.4));
const SPHERE = REACH.getBoundingSphere(new THREE.Sphere());
/** The canopy's pivot over the feet (m): the pilot swings round it. */
const CANOPY = 5.5;
/** The pelvis over the feet (m): the free fall's face-down pose turns round it. */
const HIP = 0.9;
/** Face down in the free fall (rad, forward round the hips), swung upright as the canopy pulls. */
const FALL_TILT = -1.3;
/**
 * Your own: only the canopy and its lines overhead, so the view stays free (Yoshi: "keep the view obstruction
 * by the parachute harness as limited as possible"). The harness (Pilot: arms, risers, pack, legs), the grips
 * and the toggles start a hand's width from the eye and filled the screen's sides as broad dark slabs.
 */
const HIDDEN_OWN = ['Pilot', 'Grip_L', 'Grip_R', 'Toggle_L', 'Toggle_R'];

/** 0..1 eased in and out */
const ease = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

interface Spring {
  a: number;
  v: number;
}

interface Flight {
  holder: THREE.Object3D;
  /** Round the canopy (the pendulum), then round the hips (the free fall), then the parachute itself */
  swing: THREE.Group;
  tilt: THREE.Group;
  rig: THREE.Object3D;
  harness: THREE.Object3D | null;
  mixer: THREE.AnimationMixer;
  act: Record<Clip, THREE.AnimationAction>;
  lods: THREE.Object3D[][];
  lod: number;
  pilot: PilotPose | null;
  own: boolean;
  phase: 'pack' | 'open' | 'glide' | 'flare' | 'land';
  /** Seconds since the drop began (in the land phase: since landing) */
  t: number;
  /** Each change of clip's progress, 0..1 (eased when used) */
  p: { glide: number; flare: number; land: number };
  steer: number;
  yaw: number;
  /** The pendulum: pitch (forward and back) and roll (side to side) */
  pitch: Spring;
  roll: Spring;
  surged: boolean;
  /** When `fly` last came for it (ms): a figure skips frames now and then (no fresh state) */
  seen: number;
  /** Stowed after landing: taken away */
  done: boolean;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const _v = new THREE.Vector3();
const PENDULUM = (2 * Math.PI) / 2.4; // rad/s: a pilot 5 m under the canopy swings in about 2.4 s

/** A lightly damped spring towards `target` (the pendulum), steps of at most 1/30 s. */
function spring(s: Spring, target: number, damping: number, dt: number): void {
  const w = PENDULUM;
  for (let left = dt; left > 1e-6; left -= 1 / 30) {
    const h = Math.min(left, 1 / 30);
    s.v += (w * w * (target - s.a) - 2 * damping * w * s.v) * h;
    s.a += s.v * h;
  }
}

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
   * `dropping`: in a drop now; `air`: their feet over the ground; `since`: seconds since the drop
   * began when known (yours), else null. Call `sweep` once after everyone.
   */
  fly(key: string, holder: THREE.Object3D, body: Body | null, colour: string, dropping: boolean, air: number, dt: number, eye: THREE.Vector3, since: number | null = null): void {
    let f = this.flights.get(key);
    if (!f) {
      if (!dropping) return;
      this.load();
      if (!this.gltf) return; // drawn from the frame the model is in
      // Seen first part way down (they were already under way): as far along as their height says.
      f = this.make(holder, body, colour, since ?? (air < DROP.height - 4 ? dropSince(DROP.height - air) : 0));
      this.flights.set(key, f);
    }
    f.seen = performance.now();
    if (dropping && f.phase === 'land') {
      this.restart(f, since ?? 0); // down and up again (a quick respawn)
      f.done = false;
    }
    f.t = dropping && since !== null ? since : f.t + dt;
    // How hard they turn, from how fast their facing changes: the steering the clips show.
    const yaw = holder.rotation.y;
    const rate = dt > 0 ? wrap(yaw - f.yaw) / dt : 0;
    f.yaw = yaw;
    f.steer += (Math.max(-1, Math.min(1, -rate / DROP.turn)) - f.steer) * (1 - Math.exp(-dt * 3.5));
    if (!dropping && f.phase !== 'land') {
      f.phase = 'land';
      f.t = 0;
      f.act.Land_Collapse.reset().setEffectiveTimeScale(LAND_RATE).play();
    }
    const fade = (now: number, over: number) => Math.min(1, now + dt / over);
    switch (f.phase) {
      case 'pack':
        if (f.t >= DROP.fall) {
          f.phase = 'open';
          f.act.Deploy.paused = false;
          f.act.Deploy.time = Math.min(DROP.deploy, f.t - DROP.fall);
        }
        break;
      case 'open':
        // The last part of Deploy is Glide_Idle's first frame: cross over to the glides, eased.
        if (f.t >= DROP.fall + DROP.deploy - 0.45) {
          if (f.p.glide === 0) for (const c of GLIDES) f.act[c].reset().play();
          f.p.glide = fade(f.p.glide, 0.45);
          if (f.p.glide >= 1) f.phase = 'glide';
        }
        break;
      case 'glide':
        if (air < DROP.flareAt) {
          f.phase = 'flare';
          f.act.Flare.reset().play();
        }
        break;
      case 'flare':
        f.p.flare = fade(f.p.flare, 0.35);
        break;
      case 'land':
        f.p.land = fade(f.p.land, 0.3);
        break;
    }
    this.weights(f);
    f.mixer.update(dt);
    this.pose(f, dt, air);
    // Simpler from afar.
    const lod = holder.getWorldPosition(_v).distanceTo(eye) > this.far ? 1 : 0;
    if (lod !== f.lod) this.showLod(f, lod);
    if (f.own) for (const n of HIDDEN_OWN) f.rig.getObjectByName(n)?.scale.setScalar(0.001);
    else if (f.harness && f.phase === 'land') f.harness.scale.setScalar(Math.max(0.001, 1 - ease((f.t - LAND + 0.3) / 0.3))); // the pack and harness go last
    f.holder.updateMatrixWorld(true);
    // Their figure in the harness while in the air, handed back to its own animation after landing.
    if (f.pilot) {
      const w = f.phase === 'land' ? 1 - ease((f.t - 0.45) / 0.7) : 1;
      if (w > 0) f.pilot.apply(false, w);
    }
    if (f.phase === 'land' && f.t >= LAND) f.done = true; // stowed: taken away in sweep
  }

  /** After everyone's `fly`: parachutes stowed, or nobody flew for a second (the player left), are taken away. */
  sweep(): void {
    const now = performance.now();
    for (const [key, f] of this.flights) {
      if (!f.done && now - f.seen < 1000) continue;
      f.mixer.stopAllAction();
      f.mixer.uncacheRoot(f.rig);
      f.swing.removeFromParent();
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

  /**
   * The others' body under the canopy: face down in the free fall, swung upright as the canopy pulls
   * (round the hips), and the pendulum round the canopy: out of a turn and back, the opening's surge
   * (the canopy shoots ahead, then the pilot swings through), and a little forward in the flare.
   * Your own isn't moved: your camera swings instead (player.ts).
   */
  private pose(f: Flight, dt: number, air: number): void {
    if (f.own) return;
    const inAir = f.phase !== 'land';
    const up = ease((f.t - DROP.fall - 0.1) / 0.9);
    f.tilt.rotation.x = inAir ? FALL_TILT * (1 - up) : 0;
    const surgeAt = DROP.fall + DROP.open + 0.45;
    if (inAir && !f.surged && f.t >= surgeAt) {
      f.surged = true;
      f.pitch.v -= 0.55;
    }
    const open = inAir && f.t > DROP.fall + DROP.open;
    spring(f.pitch, f.phase === 'flare' ? 0.1 : 0, 0.28, dt);
    spring(f.roll, open && air > 0.5 ? -f.steer * 0.12 : 0, 0.3, dt);
    f.swing.rotation.set(f.pitch.a, 0, f.roll.a);
  }

  private make(holder: THREE.Object3D, body: Body | null, colour: string, since: number): Flight {
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
    // The pendulum's pivot at the canopy, the free fall's at the hips, the parachute at the feet as before.
    const swing = new THREE.Group();
    swing.position.y = CANOPY;
    const tilt = new THREE.Group();
    tilt.position.y = HIP - CANOPY;
    rig.position.y = -HIP;
    swing.add(tilt);
    tilt.add(rig);
    holder.add(swing);
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
      holder, swing, tilt, rig, harness: rig.getObjectByName('Pilot') ?? null, mixer, act, lods, lod: -1, pilot, own: !body, phase: 'pack', t: 0,
      p: { glide: 0, flare: 0, land: 0 }, steer: 0, yaw: holder.rotation.y, pitch: { a: 0, v: 0 }, roll: { a: 0, v: 0 }, surged: false,
      seen: performance.now(), done: false,
    };
    this.restart(f, since);
    return f;
  }

  /** From the start of a drop, `since` seconds in. */
  private restart(f: Flight, since: number): void {
    f.mixer.stopAllAction();
    f.p = { glide: 0, flare: 0, land: 0 };
    f.t = since;
    f.surged = since > DROP.fall + DROP.open + 0.45;
    f.harness?.scale.setScalar(1);
    const open = since - DROP.fall;
    if (open >= DROP.deploy) {
      // Already gliding (first seen low down, or your own model came in late): straight to it.
      f.phase = 'glide';
      f.p.glide = 1;
      for (const c of GLIDES) f.act[c].reset().play();
    } else {
      f.phase = open >= 0 ? 'open' : 'pack';
      const d = f.act.Deploy.reset().play();
      d.time = Math.max(0, open);
      d.paused = open < 0; // its first frame is everything in the pack
    }
    this.weights(f);
  }

  /** Each clip's weight from the eased cross-fades: Deploy into the glides, into Flare, into Land_Collapse. */
  private weights(f: Flight): void {
    const s = f.steer;
    const land = ease(f.p.land);
    const flare = ease(f.p.flare) * (1 - land);
    const glide = ease(f.p.glide) * (1 - flare - land);
    const deploy = Math.max(0, 1 - glide - flare - land);
    f.act.Deploy.setEffectiveWeight(deploy);
    f.act.Glide_Idle.setEffectiveWeight(glide * (1 - Math.abs(s)));
    f.act.Glide_Left.setEffectiveWeight(glide * Math.max(0, -s));
    f.act.Glide_Right.setEffectiveWeight(glide * Math.max(0, s));
    f.act.Flare.setEffectiveWeight(flare);
    f.act.Land_Collapse.setEffectiveWeight(land);
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
