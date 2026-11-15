import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

/**
 * Pets in a home's inside: a small dog (web/public/models/dog.glb, tools/dog.py, from the "Shiba Inu" by
 * Quaternius, CC0) that lies on its spot most of the time and now and then gets up, walks a short round and
 * lies down again. Where it lies, its round and its coat come from the home's sealed inside (`pets` in the
 * pack), so this module knows no home and no place: everything is in its parent's own frame.
 *
 * The round is on the shared clock, as the cats' (world/cats.ts): every player inside sees the dog in the same
 * place, and the server sends nothing. Cosmetic and on this page only: no hit box, nothing to shoot, push or pick
 * up, and it does not block walking (bullets pass through it: ignoreRay). It makes no sound.
 * When a player comes within 4 m while it lies or sits, it lifts its head and turns it to them, and wags its tail.
 *
 * The model is fetched only when a pack with pets is installed: a page without one never asks for dog.glb.
 *
 * The hook (world/walkIn.ts addInside, once the home's inside has come):
 *   if (pack.pets?.length) pets = addPets(local, pack.pets, sharedClock, () => eye, { look: (m) => sunless(m), prepare });
 * and every frame `pets?.update(dt)`; `pets?.dispose()` when the inside goes.
 */

export interface PetSpec {
  kind: 'dog';
  /** Its size against the model's (0.28 m at the shoulder) */
  scale: number;
  /** Its coat and the patch on its head and ears, as CSS colours ('#f2efe8') */
  coat: string;
  patch: string;
  /** Where it lies: x, y (the top of what it lies on), z, and which way it faces (radians, as a yaw) */
  rest: [number, number, number, number];
  /** Its round on the floor, corner by corner: x, z */
  loop: [number, number][];
  /** The floor's height under its round; the lying spot's height when left out */
  floor?: number;
  /** Its pace on its round, m/s (SPEED when left out) */
  speed?: number;
}

export interface Pets {
  /** Every frame */
  update(dt: number): void;
  /** Out of the scene, the copies of the model freed */
  dispose(): void;
}

export interface PetOptions {
  /** Each material changed before use (a home's inside takes no direct sun: walkIn.ts sunless) */
  look?: (m: THREE.Material) => THREE.Material;
  /** Compiles the dog's shaders before it shows (main.ts precompile, renderer.compileAsync), so its first frame doesn't stall */
  prepare?: (o: THREE.Object3D) => Promise<unknown>;
}

const URL = '/models/dog.glb';
const CYCLE = 120; // s: one round of lying, getting up, walking, lying down
const SPEED = 0.6; // m/s on its round
const NEAR = 4; // m: it notices a player this close
const FADE = 0.35; // s between two clips
const NECK = 1.2; // radians its head turns at most to look at someone (about 70 degrees)

let model: Promise<GLTF> | null = null;
const load = () => (model ??= new GLTFLoader().loadAsync(URL));

type State = 'Lie' | 'Sit' | 'Idle' | 'Walk';

/** A repeatable 0..1 for a pet's place in the cycle (two dogs don't get up at once). */
const phase = (i: number, s: PetSpec) => {
  const v = Math.sin(i * 12.9898 + s.rest[0] * 78.233 + s.rest[2] * 37.719) * 43758.5453;
  return v - Math.floor(v);
};

/** The way round: from its spot, along the corners, back to its spot. */
function route(s: PetSpec): { pts: THREE.Vector3[]; lens: number[]; total: number } {
  const floor = s.floor ?? s.rest[1];
  const pts = [new THREE.Vector3(s.rest[0], s.rest[1], s.rest[2]), ...s.loop.map(([x, z]) => new THREE.Vector3(x, floor, z)), new THREE.Vector3(s.rest[0], s.rest[1], s.rest[2])];
  const lens = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.z - pts[i].z));
  return { pts, lens, total: lens.reduce((a, b) => a + b, 0) };
}

/** Where a pet is at time t on the shared clock: its state, place and heading. */
function at(s: PetSpec, r: ReturnType<typeof route>, t: number, offset: number, out: THREE.Vector3): { state: State; heading: number } {
  const walk = Math.min(r.total / (s.speed ?? SPEED), CYCLE * 0.4);
  const busy = 2 + 1 + walk + 1 + 2; // up (sit, stand), walk, stand, sit
  let u = ((t + offset * CYCLE) % CYCLE + CYCLE) % CYCLE - (CYCLE - busy);
  out.set(s.rest[0], s.rest[1], s.rest[2]);
  if (u < 0) return { state: 'Lie', heading: s.rest[3] };
  if (u < 2) return { state: 'Sit', heading: s.rest[3] };
  u -= 2;
  if (u < 1) return { state: 'Idle', heading: s.rest[3] };
  u -= 1;
  if (u < walk) {
    let d = (u / walk) * r.total;
    for (let i = 0; i < r.lens.length; i++) {
      if (d <= r.lens[i] || i === r.lens.length - 1) {
        const f = r.lens[i] ? Math.min(1, d / r.lens[i]) : 1;
        out.lerpVectors(r.pts[i], r.pts[i + 1], f);
        return { state: 'Walk', heading: Math.atan2(r.pts[i + 1].x - r.pts[i].x, r.pts[i + 1].z - r.pts[i].z) };
      }
      d -= r.lens[i];
    }
  }
  u -= walk;
  return { state: u < 1 ? 'Idle' : 'Sit', heading: s.rest[3] };
}

/** The coat's colours: the model's alpha says coat (1), patch (0.5, soft at its edge) or fixed (0: eyes, nose). */
function paint(geo: THREE.BufferGeometry, coat: THREE.Color, patch: THREE.Color): THREE.BufferGeometry {
  const g = geo.clone();
  const src = g.getAttribute('color');
  const rgb = new Float32Array(src.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < src.count; i++) {
    const a = src.itemSize > 3 ? src.getW(i) : 1;
    if (a < 0.25) c.setRGB(src.getX(i), src.getY(i), src.getZ(i));
    else c.copy(coat).lerp(patch, Math.min(1, Math.max(0, (1 - a) / 0.5)));
    rgb.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
  return g;
}

const UP = new THREE.Vector3(0, 1, 0);
const qa = new THREE.Quaternion();
const qp = new THREE.Quaternion();
/** Turn a bone about an axis of the world by `angle`, on top of what its clip set. */
function turnBone(bone: THREE.Object3D, axis: THREE.Vector3, angle: number): void {
  if (!bone.parent || !angle) return;
  bone.parent.getWorldQuaternion(qp);
  qa.setFromAxisAngle(axis, angle);
  bone.quaternion.premultiply(qp.clone().invert().multiply(qa).multiply(qp));
}

interface Pet {
  spec: PetSpec;
  group: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  current: string;
  route: ReturnType<typeof route>;
  offset: number;
  head?: THREE.Object3D;
  tail?: THREE.Object3D;
  geometry: THREE.BufferGeometry[];
  /** The head's turn towards a player now (eased), yaw and pitch */
  look: { yaw: number; pitch: number; wag: number };
}

/**
 * Puts `pets` into `parent` (positions in its own frame) and returns their per-frame update.
 * `clock`: seconds on the shared clock (the same for every player); `eye`: where this page's camera is, in the world.
 */
export function addPets(parent: THREE.Object3D, pets: PetSpec[], clock: () => number, eye: () => THREE.Vector3, options: PetOptions = {}): Pets {
  const list: Pet[] = [];
  const holder = new THREE.Group();
  holder.name = 'pets';
  let gone = false;
  const dogs = pets.filter((s) => s.kind === 'dog' && s.loop.every((p) => p.length === 2) && s.rest.length === 4);
  if (dogs.length) {
    void load().then(async (gltf) => {
      if (gone) return;
      const clips = new Map(gltf.animations.map((c) => [c.name.split('|').pop()!, c]));
      const pace = (gltf.scene.getObjectByName('Dog')?.userData.walkSpeed as number | undefined) ?? 0.22; // m/s of the walk clip at the model's size
      for (const [i, spec] of dogs.entries()) {
        const body = SkeletonUtils.clone(gltf.scene) as THREE.Group;
        const geometry: THREE.BufferGeometry[] = [];
        body.traverse((o) => {
          o.userData.ignoreRay = true;
          const mesh = o as THREE.SkinnedMesh;
          if (!mesh.isMesh) return;
          mesh.geometry = paint(mesh.geometry, new THREE.Color(spec.coat), new THREE.Color(spec.patch));
          geometry.push(mesh.geometry);
          if (options.look) mesh.material = options.look(mesh.material as THREE.Material);
          mesh.castShadow = mesh.receiveShadow = true;
          mesh.frustumCulled = false;
        });
        const group = new THREE.Group();
        group.name = 'dog';
        group.scale.setScalar(spec.scale);
        group.add(body);
        holder.add(group);
        const mixer = new THREE.AnimationMixer(body);
        const actions = new Map([...clips].map(([n, c]) => [n, mixer.clipAction(c)]));
        actions.get('Walk')?.setEffectiveTimeScale((spec.speed ?? SPEED) / (pace * spec.scale)); // the feet keep pace with the ground
        list.push({
          spec, group, mixer, actions, current: '', route: route(spec), offset: phase(i, spec), geometry,
          head: body.getObjectByName('Head'), tail: body.getObjectByName('Tail1'), look: { yaw: 0, pitch: 0, wag: 0 },
        });
      }
      update(0);
      if (options.prepare) await options.prepare(holder).catch(() => undefined);
      if (!gone) parent.add(holder);
    }, () => {}); // no model: no dog
  }

  const p = new THREE.Vector3();
  const local = new THREE.Vector3();
  const side = new THREE.Vector3();
  const update = (dt: number) => {
    const t = clock();
    for (const pet of list) {
      const { state, heading } = at(pet.spec, pet.route, t, pet.offset, p);
      pet.group.position.copy(p);
      pet.group.rotation.y = heading;
      if (pet.current !== state) {
        const next = pet.actions.get(state);
        const prev = pet.actions.get(pet.current);
        if (next) {
          next.reset().play();
          if (prev) next.crossFadeFrom(prev, FADE, true);
          pet.current = state;
        }
      }
      pet.mixer.update(dt);
      // On this page only: a player close by, while it lies, sits or stands, gets a look and a wag.
      const still = state !== 'Walk';
      local.copy(eye());
      holder.parent?.worldToLocal(local);
      const dx = local.x - p.x;
      const dz = local.z - p.z;
      const near = still && Math.hypot(dx, dz) < NEAR;
      let yaw = 0;
      let pitch = 0;
      if (near) {
        yaw = Math.atan2(dx, dz) - heading;
        yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
        // As far as a neck turns; a player further round, behind it, gets no look (it faces ahead): the head never
        // swings from one shoulder to the other as someone walks behind it.
        yaw = Math.abs(yaw) > NECK + 0.35 ? 0 : Math.max(-NECK, Math.min(NECK, yaw));
        pitch = Math.max(-0.2, Math.min(0.3, Math.atan2(local.y - p.y - 0.3 * pet.spec.scale, Math.hypot(dx, dz))));
      }
      const ease = 1 - Math.exp(-4 * dt);
      pet.look.yaw += (yaw - pet.look.yaw) * ease;
      pet.look.pitch += (pitch - pet.look.pitch) * ease;
      pet.look.wag += ((near ? 1 : 0) - pet.look.wag) * ease;
      if (pet.head && (Math.abs(pet.look.yaw) > 1e-3 || Math.abs(pet.look.pitch) > 1e-3)) {
        pet.group.updateMatrixWorld(true);
        turnBone(pet.head, UP, pet.look.yaw);
        side.set(Math.cos(heading + pet.look.yaw), 0, -Math.sin(heading + pet.look.yaw)).transformDirection(holder.matrixWorld);
        turnBone(pet.head, side, -pet.look.pitch);
      }
      if (pet.tail && pet.look.wag > 0.01) {
        pet.group.updateMatrixWorld(true);
        turnBone(pet.tail, UP.clone().transformDirection(holder.matrixWorld), 0.45 * pet.look.wag * Math.sin(t * 14));
      }
    }
  };

  return {
    update,
    dispose() {
      gone = true;
      holder.removeFromParent();
      for (const pet of list) {
        pet.mixer.stopAllAction();
        pet.geometry.forEach((g) => g.dispose());
      }
      list.length = 0;
    },
  };
}
