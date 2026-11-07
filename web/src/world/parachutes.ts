import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type { Body } from '../net/swat';
import { DROP } from '../../shared/parachute.mjs';
import { daylight } from './daylight';
import { PilotPose, type FallPose } from './parachutePilot';

/**
 * Parachutes being flown (shared/parachute.mjs, docs/parachute/README.md): yours, on your own figure while the
 * camera films you from behind (world/dropView.ts), and the other players', on theirs. The model
 * (web/public/models/parachute.glb, 0.13 MB sent) is fetched once the world is in.
 *
 * Each one plays its clips by what the player does: packed in the free fall, Deploy from the moment the canopy
 * opens, the three glide clips blended by how fast they turn, Flare near the ground, and Land_Collapse once they
 * are on their feet (then it is taken away). Every change of clip is a cross-fade eased in and out, so nothing
 * snaps. The figure is posed on the parachute's guides while in the air (world/parachutePilot.ts): face down,
 * arms out in the free fall, leaning into how they fly (head lower tracking forward, head first in a dive,
 * banked sliding sideways), swung upright as the canopy opens, swinging a little under it (a pendulum round
 * the canopy, out of the turns and with the opening's surge), and handed back to its own animation gently
 * after landing. Only drawn: their hit boxes, and where the server has them, don't change. The cloth's own soft
 * glow (it keeps the canopy bright against the sky by day) dims with the daylight, so it is dark at night.
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
const FALL_TILT = -1.42;
/** Further head down at full track (rad), and head first in a full dive; banked this far at full slide. */
const TRACK_TILT = -0.22;
const DIVE_TILT = -0.85;
const SLIDE_BANK = 0.4;
/**
 * The free fall's limbs (world/parachutePilot.ts FallPose), in the parachute's space with the figure upright (m,
 * forward -z, so +z is the sky once it lies face down): the box (belly to earth: hands out level with the head
 * and up off the back, elbows out, knees bent, feet up), tracking (arms back along the sides, legs nearly
 * straight) and the dive (arms in along the body, legs straight, head first).
 */
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const LIMBS = ['Grip_L', 'Grip_R', 'Elbow_L', 'Elbow_R', 'Foot_L', 'Foot_R', 'Shin_L', 'Shin_R'] as const;
const BOX: FallPose = {
  Grip_L: v3(-0.55, 1.62, 0.14), Grip_R: v3(0.55, 1.62, 0.14), Elbow_L: v3(-0.6, 1.3, 0.3), Elbow_R: v3(0.6, 1.3, 0.3),
  Foot_L: v3(-0.26, 0.34, 0.4), Foot_R: v3(0.26, 0.34, 0.4), Shin_L: v3(-0.2, 0.45, -0.35), Shin_R: v3(0.2, 0.45, -0.35),
};
const TRACK: FallPose = {
  Grip_L: v3(-0.42, 0.95, 0.2), Grip_R: v3(0.42, 0.95, 0.2), Elbow_L: v3(-0.5, 1.2, 0.25), Elbow_R: v3(0.5, 1.2, 0.25),
  Foot_L: v3(-0.2, 0.08, 0.16), Foot_R: v3(0.2, 0.08, 0.16), Shin_L: v3(-0.16, 0.45, -0.3), Shin_R: v3(0.16, 0.45, -0.3),
};
const DIVE: FallPose = {
  Grip_L: v3(-0.22, 0.82, 0.1), Grip_R: v3(0.22, 0.82, 0.1), Elbow_L: v3(-0.35, 1.15, 0.2), Elbow_R: v3(0.35, 1.15, 0.2),
  Foot_L: v3(-0.1, 0.04, 0.06), Foot_R: v3(0.1, 0.04, 0.06), Shin_L: v3(-0.12, 0.45, -0.3), Shin_R: v3(0.12, 0.45, -0.3),
};
const fallPose = Object.fromEntries(LIMBS.map((n) => [n, new THREE.Vector3()])) as FallPose;
/**
 * Your own once the camera is back in your eyes (after landing): only the canopy and its lines, so the view
 * stays free (Yoshi: "keep the view obstruction by the parachute harness as limited as possible"). The harness
 * (Pilot: arms, risers, pack, legs), the grips and the toggles start a hand's width from the eye and filled the
 * screen's sides as broad dark slabs.
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
  /** The figure it poses (yours comes and goes with the camera: world/dropView.ts) */
  body: Body | null;
  phase: 'pack' | 'open' | 'glide' | 'flare' | 'land';
  /** Seconds in the land phase: since landing */
  t: number;
  /** Seconds since the canopy began to open, or null in the free fall */
  openT: number | null;
  /** Where they were drawn and how they move (m/s, world, smoothed): the free fall's posture follows it */
  at: THREE.Vector3;
  vel: THREE.Vector3;
  /** The free fall's lean forward round the hips (rad, on top of FALL_TILT), and its bank */
  lean: number;
  bank: number;
  /** How much the free fall is tracking, and diving (0..1, eased): the limbs follow */
  trk: number;
  dv: number;
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
const _w = new THREE.Vector3();
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
  /** The materials that glow a little by day (the canopy's cloth and every accent) */
  private glowing = new Set<THREE.MeshStandardMaterial>();

  /**
   * Each frame, for each player who may be in a drop. `holder`: the group they are drawn in (at their feet,
   * turned their way); `body`: their figure (null: the parachute alone); `dropping`: in a drop now; `open`: their
   * canopy is out, and `openSince` how long ago it began to open when known (yours), else null (the others: from
   * when it is first seen out); `air`: their feet over the ground; `harness`: false hides the harness, the grips
   * and the toggles (yours seen from your own eyes). Call `sweep` once after everyone.
   */
  fly(key: string, holder: THREE.Object3D, body: Body | null, colour: string, dropping: boolean, open: boolean, air: number, dt: number, eye: THREE.Vector3, openSince: number | null = null, harness = true): void {
    let f = this.flights.get(key);
    if (f && f.body !== body) {
      // Another figure (yours, made for the camera after the parachute was): a fresh parachute for it, posed
      // from its rest (the adapter learns the guides at rest).
      this.remove(key, f);
      f = undefined;
    }
    if (!f) {
      if (!dropping) return;
      this.load();
      if (!this.gltf) return; // drawn from the frame the model is in
      // Seen first with the canopy already out (part way down): under it at once.
      f = this.make(holder, body, colour, open ? openSince ?? 99 : null);
      this.flights.set(key, f);
    }
    f.seen = performance.now();
    if (dropping && f.phase === 'land') {
      this.restart(f, open ? openSince ?? 99 : null); // down and up again (a quick respawn)
      f.done = false;
    }
    if (dropping) f.openT = !open ? null : openSince ?? (f.openT === null ? 0 : f.openT + dt);
    f.t += dt;
    // How they move, from where they are drawn (not where the network had them): the free fall's posture.
    holder.getWorldPosition(_v);
    if (dt > 0 && _w.copy(_v).sub(f.at).length() < 10) f.vel.lerp(_w.divideScalar(dt).clampLength(0, 40), 1 - Math.exp(-dt * 5)); // not a jump (a respawn)
    f.at.copy(_v);
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
        if (f.openT !== null) {
          f.phase = 'open';
          f.act.Deploy.paused = false;
          f.act.Deploy.time = Math.min(DROP.deploy, f.openT);
        }
        break;
      case 'open':
        // The last part of Deploy is Glide_Idle's first frame: cross over to the glides, eased.
        if ((f.openT ?? 99) >= DROP.deploy - 0.45) {
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
    // The figure's limbs in the free fall's posture until the canopy pulls them upright.
    const fall = !f.pilot || f.phase === 'land' ? 0 : 1 - (f.openT === null ? 0 : ease((f.openT - 0.15) / 0.8));
    // The grips and toggles only where the hands are (not in the free fall's), and never in your own eyes' way.
    for (const n of HIDDEN_OWN) if (n !== 'Pilot') f.rig.getObjectByName(n)?.scale.setScalar(harness && fall < 0.5 ? 1 : 0.001);
    // The pack and harness go last (and are never in your own eyes' way).
    f.harness?.scale.setScalar(!harness ? 0.001 : f.phase === 'land' ? Math.max(0.001, 1 - ease((f.t - LAND + 0.3) / 0.3)) : 1);
    f.holder.updateMatrixWorld(true);
    // Their figure in the harness while in the air, handed back to its own animation after landing.
    if (f.pilot) {
      const w = f.phase === 'land' ? 1 - ease((f.t - 0.45) / 0.7) : 1;
      if (fall > 0) {
        const box = Math.max(0, 1 - f.trk - f.dv);
        for (const n of LIMBS) fallPose[n].copy(BOX[n]).multiplyScalar(box).addScaledVector(TRACK[n], f.trk).addScaledVector(DIVE[n], f.dv);
      }
      if (w > 0) f.pilot.apply(false, w, fall, fallPose);
    }
    if (f.phase === 'land' && f.t >= LAND) f.done = true; // stowed: taken away in sweep
  }

  /** After everyone's `fly`: parachutes stowed, or nobody flew for a second (the player left), are taken away. */
  sweep(): void {
    const now = performance.now();
    for (const [key, f] of this.flights) if (f.done || now - f.seen >= 1000) this.remove(key, f);
    if (this.flights.size) {
      const light = daylight();
      for (const m of this.glowing) m.emissiveIntensity = light;
    }
  }

  private remove(key: string, f: Flight): void {
    f.mixer.stopAllAction();
    f.mixer.uncacheRoot(f.rig);
    f.swing.removeFromParent();
    this.flights.delete(key);
  }

  /** Whether `key` is drawn under a parachute (for the figure's blinking, say), posing `body` when given. */
  has(key: string, body?: Body | null): boolean {
    const f = this.flights.get(key);
    return !!f && (body === undefined || f.body === body);
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
   * The body in the air: face down in the free fall, leaning into how they fly (head lower tracking forward,
   * head first diving, banked sliding sideways), swung upright as the canopy pulls (round the hips), and the
   * pendulum round the canopy: out of a turn and back, the opening's surge (the canopy shoots ahead, then the
   * pilot swings through), and a little forward in the flare.
   */
  private pose(f: Flight, dt: number, air: number): void {
    const inAir = f.phase !== 'land';
    const yaw = f.holder.rotation.y;
    const forward = -f.vel.x * Math.sin(yaw) - f.vel.z * Math.cos(yaw);
    const side = f.vel.x * Math.cos(yaw) - f.vel.z * Math.sin(yaw);
    const track = Math.max(0, Math.min(1, forward / DROP.track));
    const dive = Math.max(0, Math.min(1, (-f.vel.y - DROP.trackDown - 0.3) / (DROP.diveDown - DROP.trackDown - 0.3)));
    const k = 1 - Math.exp(-dt * 3);
    f.trk += (track * (1 - dive) - f.trk) * k;
    f.dv += (dive - f.dv) * k;
    f.lean += (TRACK_TILT * track * (1 - dive) + DIVE_TILT * dive - f.lean) * k;
    f.bank += (-SLIDE_BANK * Math.max(-1, Math.min(1, side / DROP.slide)) * (1 - dive) - f.bank) * k;
    const up = f.openT === null ? 0 : ease((f.openT - 0.1) / 0.9);
    f.tilt.rotation.x = inAir ? (FALL_TILT + f.lean) * (1 - up) : 0;
    f.tilt.rotation.z = inAir ? f.bank * (1 - up) : 0;
    if (inAir && !f.surged && f.openT !== null && f.openT >= DROP.open + 0.45) {
      f.surged = true;
      f.pitch.v -= 0.55;
    }
    const open = inAir && f.openT !== null && f.openT > DROP.open;
    spring(f.pitch, f.phase === 'flare' ? 0.1 : 0, 0.28, dt);
    spring(f.roll, open && air > 0.5 ? -f.steer * 0.12 : 0, 0.3, dt);
    f.swing.rotation.set(f.pitch.a, 0, f.roll.a);
  }

  private make(holder: THREE.Object3D, body: Body | null, colour: string, openT: number | null): Flight {
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
      const used = mesh.material as THREE.MeshStandardMaterial;
      if (used.emissive && used.emissive.getHex() !== 0) this.glowing.add(used);
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
    const pilot = this.pilotFor(holder, rig, body);
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
      holder, swing, tilt, rig, harness: rig.getObjectByName('Pilot') ?? null, mixer, act, lods, lod: -1, pilot, body, phase: 'pack', t: 0, openT,
      at: holder.getWorldPosition(new THREE.Vector3()), vel: new THREE.Vector3(), lean: 0, bank: 0, trk: 0, dv: 0,
      p: { glide: 0, flare: 0, land: 0 }, steer: 0, yaw: holder.rotation.y, pitch: { a: 0, v: 0 }, roll: { a: 0, v: 0 }, surged: false,
      seen: performance.now(), done: false,
    };
    this.restart(f, openT);
    return f;
  }

  /** The adapter that poses `body` on the parachute, or null (no figure, or a block figure without bones). */
  private pilotFor(holder: THREE.Object3D, rig: THREE.Object3D, body: Body | null): PilotPose | null {
    if (!body) return null;
    try {
      return new PilotPose(holder, rig, body.root);
    } catch {
      return null; // the block figures (no bones): the parachute without posing them
    }
  }

  /** From the start of a drop: in the free fall (`openT` null), or `openT` seconds after the canopy began to open. */
  private restart(f: Flight, openT: number | null): void {
    f.mixer.stopAllAction();
    f.p = { glide: 0, flare: 0, land: 0 };
    f.t = 0;
    f.openT = openT;
    f.surged = openT !== null && openT > DROP.open + 0.45;
    f.harness?.scale.setScalar(1);
    const open = openT ?? -1;
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
