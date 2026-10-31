import * as THREE from 'three';
import { sound } from '../sound';
import { Decals } from './decals';
import { Particles, type Spawn } from './particles';
import { flashSheet, HOLE, PARTICLE } from './sprites';

/**
 * Impact bursts that depend on what was hit: dust and chips from plaster and
 * brick, sparks from metal, splinters from wood, chips from tiles, earth from
 * grass. Also the rocket's smoke trail and its explosion (a flash, a fireball,
 * rolling smoke, debris, embers, a ring of dust and a scorch mark), muzzle
 * flashes, shell casings and the puff where a player is hit. All particles
 * come from the shared pools in particles.ts. (Bullet tracers were removed at
 * Yoshi's request: with several players shooting they filled the screen.)
 */

type Kind = 'dust' | 'sparks' | 'wood' | 'earth' | 'chips' | 'fur';

const KIND: Record<string, Kind> = {
  steel: 'sparks', rail: 'sparks', alu: 'sparks', alu_out: 'sparks', alu_in: 'sparks', brass: 'sparks', mirror: 'sparks', black_glass: 'sparks',
  oak: 'wood', walnut: 'wood', floor_wood: 'wood', stair: 'wood', cladding: 'wood', old_wood: 'wood',
  grass: 'earth', hedge: 'earth', nb_hedge: 'earth', cat: 'fur', nb_roof: 'chips', fence: 'sparks',
  floor_tile: 'chips', terrazzo: 'chips', ceramic: 'chips', rust_tile: 'chips', pink_tile: 'chips', floor_bath: 'chips', stone: 'chips', old_floor: 'chips',
};

/** Dust colour per surface (brick and plaster dust differ); others fall back to pale plaster. */
const DUST: Record<string, string> = {
  brick: '#d9cbb0', claustra: '#d9cbb0', nb_wall: '#b88468', old_brick: '#e6dccb', concrete: '#c9c4ba', road: '#cfcac0', terrace: '#c9c4ba', paving: '#c9c4ba',
  bluestone: '#5d6369', pave_light: '#d6d2ca', pave_warm: '#d2c6b4', gravel: '#cdbfa6', track: '#a8916f', pool_water: '#3e9fbe', pole: '#bdb9b1',
  field_soil: '#b39a78', field_dark: '#7d644c', field_crop: '#7f8458', forest: '#5d5640',
  nb_red: '#b06a52', nb_brown: '#8e6450', nb_yellow: '#cdb48e', nb_white: '#e6e0d4', nb_grey: '#a39c93', nb_dark: '#4b4a49', kerb: '#d0ccc4',
};

const color = (c: string) => new THREE.Color(c);

interface Rocket {
  mesh: THREE.Group;
  from: THREE.Vector3;
  dir: THREE.Vector3;
  length: number;
  travelled: number;
  speed: number;
  onArrive?: () => void;
}

interface Casing {
  i: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Euler;
  spin: THREE.Vector3;
  life: number;
  bounces: number;
  len: number;
  r: number;
  shell: boolean;
}

/** Casing sizes in metres (length, radius) and whether it is a plastic shotgun shell. */
const CASING: Record<string, { len: number; r: number; shell?: boolean }> = {
  pistol: { len: 0.019, r: 0.0048 },
  rifle: { len: 0.045, r: 0.0055 },
  shotgun: { len: 0.065, r: 0.0105, shell: true },
  sniper: { len: 0.07, r: 0.0065 },
};

let flashTexture: THREE.CanvasTexture | null = null;
const flashMats: THREE.MeshBasicMaterial[] = [];

/**
 * A muzzle flash: a star facing down the barrel and two crossed flames along it,
 * `size` metres long. Hidden until `fire()`, which gives each shot its own turn and size.
 * The barrel points along -z.
 */
export function muzzleFlash(size: number): THREE.Group & { fire(): void } {
  flashTexture ??= flashSheet();
  if (!flashMats.length) {
    // Brighter than white: the flash lights up past the tone curve, like a real one.
    for (const u0 of [0, 0.5]) {
      const map = flashTexture.clone();
      map.repeat.set(0.5, 1);
      map.offset.set(u0, 0);
      flashMats.push(new THREE.MeshBasicMaterial({ map, color: new THREE.Color(3.2, 2.6, 1.9), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    }
  }
  const group = new THREE.Group() as THREE.Group & { fire(): void };
  const star = new THREE.Mesh(new THREE.PlaneGeometry(size * 0.75, size * 0.75), flashMats[0]);
  const side = new THREE.PlaneGeometry(size, size * 0.5).translate(size / 2, 0, 0).rotateY(Math.PI / 2); // from the muzzle forwards
  const flames = [0, Math.PI / 2].map((roll) => {
    const m = new THREE.Mesh(side, flashMats[1]);
    m.rotation.z = roll;
    return m;
  });
  const turn = new THREE.Group();
  turn.add(star, ...flames);
  group.add(turn);
  group.traverse((o) => {
    o.userData.ignoreRay = true;
    o.castShadow = false;
  });
  group.visible = false;
  group.fire = () => {
    turn.rotation.z = Math.random() * Math.PI * 2;
    const s = 0.75 + Math.random() * 0.5;
    turn.scale.set(s, s, 0.8 + Math.random() * 0.5);
    star.rotation.z = Math.random() * Math.PI * 2;
  };
  return group;
}

export class Effects {
  readonly particles = new Particles();
  private group = new THREE.Group();
  private rockets: Rocket[] = [];
  private rocketBody = new THREE.CylinderGeometry(0.045, 0.045, 0.55, 8).rotateX(Math.PI / 2);
  private rocketMat = new THREE.MeshStandardMaterial({ color: '#4a4d3a', roughness: 0.7 });
  private casings: Casing[] = [];
  private casingMesh: THREE.InstancedMesh;
  private nextCasing = 0;
  private s: Spawn = {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size0: 0.1, size1: 0.1,
    c0: new THREE.Color(), c1: new THREE.Color(), alpha: 1, cell: 0, drag: 0, gravity: 0, spin: 0, stretch: 0,
  };
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    private decals: Decals,
    /** Height of the ground or floor under (x, z), looking down from y */
    private groundAt: (x: number, z: number, y: number) => number,
  ) {
    scene.add(this.group, this.particles.group);
    // Casings: one instanced cylinder (brass, or red for shotgun shells), lying along x.
    const geo = new THREE.CylinderGeometry(1, 1, 1, 8).rotateZ(Math.PI / 2);
    this.casingMesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: '#ffffff', metalness: 0.9, roughness: 0.3 }), 40);
    this.casingMesh.setColorAt(0, new THREE.Color('#c9a35c')); // colours per casing from the start
    this.casingMesh.count = 0;
    this.casingMesh.frustumCulled = false;
    this.casingMesh.userData.ignoreRay = true;
    this.casingMesh.raycast = () => {};
    this.group.add(this.casingMesh);
  }

  /** Set the shared spawn record for the next particles. */
  private at(p: THREE.Vector3): Spawn {
    const s = this.s;
    s.x = p.x;
    s.y = p.y;
    s.z = p.z;
    s.spin = 0;
    s.stretch = 0;
    s.drag = 0;
    s.gravity = 0;
    return s;
  }

  /** `n` particles thrown out around `normal`: speed and how wide the cone is (0 straight out, 1 any way). */
  private throw(p: THREE.Vector3, normal: THREE.Vector3, n: number, speed: number, cone: number, set: (s: Spawn, k: number) => void, add = false): void {
    for (let k = 0; k < n; k++) {
      const s = this.at(p);
      const v = speed * (0.4 + Math.random() * 0.8);
      s.vx = (normal.x + (Math.random() - 0.5) * 2 * cone) * v;
      s.vy = (normal.y + (Math.random() - 0.5) * 2 * cone) * v;
      s.vz = (normal.z + (Math.random() - 0.5) * 2 * cone) * v;
      set(s, k);
      this.particles.spawn(s, add);
    }
  }

  /** A bullet hit a surface: a hole with the surface's look, and a burst of what it is made of. */
  impact(point: THREE.Vector3, normal: THREE.Vector3, material: string, on?: THREE.Object3D): void {
    if (material !== 'cat') this.decals.add(point, normal, Decals.look(material), Decals.look(material) === HOLE.earth ? 0.1 : 0.08, on);
    const kind = KIND[material] ?? 'dust';
    const dust = color(DUST[material] ?? '#ddd6ca');
    const p = point.clone().addScaledVector(normal, 0.02);
    const puffs = (n: number, c: THREE.Color, size: number, alpha = 0.55) =>
      this.throw(p, normal, n, 0.8, 0.5, (s) => {
        Object.assign(s, { life: 0.7 + Math.random() * 0.6, size0: size * 0.3, size1: size, alpha, cell: PARTICLE.puff, drag: 3, gravity: -0.1, spin: (Math.random() - 0.5) * 2 });
        s.c0.copy(c);
        s.c1.copy(c).multiplyScalar(0.85);
      });
    const debris = (n: number, c: THREE.Color, size: number, speed: number) =>
      this.throw(p, normal, n, speed, 0.7, (s) => {
        Object.assign(s, { life: 0.5 + Math.random() * 0.4, size0: size, size1: size * 0.8, alpha: 1, cell: PARTICLE.chip, drag: 0.5, gravity: 9.8, spin: (Math.random() - 0.5) * 30 });
        s.c0.copy(c);
        s.c1.copy(c);
      });
    switch (kind) {
      case 'sparks':
        this.throw(p, normal, 12, 5, 0.8, (s) => {
          Object.assign(s, { life: 0.15 + Math.random() * 0.25, size0: 0.012, size1: 0.006, alpha: 1, cell: PARTICLE.glow, gravity: 9.8, stretch: 0.06 });
          s.c0.setRGB(4, 2.6, 1);
          s.c1.setRGB(2.5, 0.6, 0.1);
        }, true);
        this.throw(p, normal, 1, 0, 0, (s) => {
          Object.assign(s, { life: 0.06, size0: 0.15, size1: 0.1, alpha: 1, cell: PARTICLE.glow });
          s.c0.setRGB(3, 2.4, 1.6);
          s.c1.copy(s.c0);
        }, true);
        puffs(2, color('#b8b8b8'), 0.25, 0.35);
        break;
      case 'wood':
        debris(9, color('#a87a4c'), 0.02, 2.2);
        puffs(3, color('#c8a982'), 0.25, 0.4);
        break;
      case 'earth':
        debris(9, color('#4a3d28'), 0.03, 2);
        puffs(4, color('#8a7b5c'), 0.35, 0.5);
        break;
      case 'chips':
        debris(10, color('#f2efe9'), 0.016, 2.6);
        puffs(3, color('#e6e2da'), 0.22, 0.4);
        break;
      case 'fur':
        // A cartoon puff of fur, no blood.
        puffs(8, color('#e8b070'), 0.3, 0.7);
        this.throw(p, normal, 6, 1, 1, (s) => {
          Object.assign(s, { life: 1 + Math.random() * 0.5, size0: 0.05, size1: 0.04, alpha: 0.9, cell: PARTICLE.wisp, drag: 2.5, gravity: 0.6, spin: 3 });
          s.c0.set('#f0c080');
          s.c1.set('#d89850');
        });
        break;
      default:
        debris(7, dust.clone().multiplyScalar(0.8), 0.016, 2.4);
        puffs(6, dust, 0.32);
    }
  }

  /** Where a bullet hit a player: a short dark red mist. */
  hit(point: THREE.Vector3): void {
    const up = new THREE.Vector3(0, 0.3, 0);
    this.throw(point, up, 5, 1.2, 1, (s) => {
      Object.assign(s, { life: 0.35 + Math.random() * 0.2, size0: 0.05, size1: 0.28, alpha: 0.75, cell: PARTICLE.puff, drag: 4, gravity: 1 });
      s.c0.set('#7a0e0e');
      s.c1.set('#3d0707');
    });
    this.throw(point, up, 8, 2, 1, (s) => {
      Object.assign(s, { life: 0.4, size0: 0.012, size1: 0.01, alpha: 1, cell: PARTICLE.chip, gravity: 9.8 });
      s.c0.set('#5a0a0a');
      s.c1.copy(s.c0);
    });
  }

  /** A little smoke where a gun went off. */
  muzzleSmoke(at: THREE.Vector3): void {
    this.throw(at, new THREE.Vector3(0, 0.3, 0), 2, 0.4, 0.6, (s) => {
      Object.assign(s, { life: 0.8 + Math.random() * 0.4, size0: 0.06, size1: 0.35, alpha: 0.22, cell: PARTICLE.wisp, drag: 2, gravity: -0.3, spin: 1 });
      s.c0.set('#d8d4cc');
      s.c1.set('#c4c0b8');
    });
  }

  /** A bazooka rocket from `from` to `to` with a smoke trail; `onArrive` when it gets there. */
  rocket(from: THREE.Vector3, to: THREE.Vector3, speed: number, onArrive?: () => void): void {
    const mesh = new THREE.Group();
    mesh.add(new THREE.Mesh(this.rocketBody, this.rocketMat));
    mesh.traverse((o) => (o.userData.ignoreRay = true));
    mesh.position.copy(from);
    mesh.lookAt(to);
    this.group.add(mesh);
    this.rockets.push({ mesh, from: from.clone(), dir: to.clone().sub(from).normalize(), length: from.distanceTo(to), travelled: 0, speed, onArrive });
  }

  /** A rocket's explosion: flash, fireball, smoke, debris, embers, dust along the ground and a scorch mark. */
  explosion(point: THREE.Vector3, scale = 1): void {
    const b = this.particles.budget * scale;
    const up = new THREE.Vector3(0, 1, 0);
    const n = (k: number) => Math.max(1, Math.round(k * b));
    const k = scale; // a grenade's blast is smaller than a rocket's
    // Flash: a big short glow.
    this.throw(point, up, 1, 0, 0, (s) => {
      Object.assign(s, { life: 0.14, size0: 7 * k, size1: 9 * k, alpha: 1, cell: PARTICLE.glow });
      s.c0.setRGB(5, 4, 2.6);
      s.c1.setRGB(3, 1.6, 0.6);
    }, true);
    // Fireball: hot white-yellow turning orange and dark red as it rises and grows.
    this.throw(point, up, n(28), 3.4 * k, 0.9, (s) => {
      Object.assign(s, { life: 0.55 + Math.random() * 0.6, size0: 1.1 * k, size1: 3.8 * k, alpha: 1, cell: PARTICLE.puff, drag: 3.5, gravity: -2, spin: (Math.random() - 0.5) * 3 });
      const hot = 0.8 + Math.random() * 0.4;
      s.c0.setRGB(3.6 * hot, 1.9 * hot, 0.6 * hot);
      s.c1.setRGB(0.8, 0.14, 0.03);
    }, true);
    // Smoke: dark at first, rolling up and spreading, staying a few seconds.
    this.throw(point, up, n(24), 2.6 * k, 0.9, (s) => {
      Object.assign(s, { life: 3 + Math.random() * 2.5, size0: 1.6 * k, size1: 7 * k, alpha: 0.75, cell: PARTICLE.puff, drag: 1.4, gravity: -0.9, spin: (Math.random() - 0.5) * 0.8 });
      s.c0.set('#2e2a26');
      s.c1.set('#7d776f');
    });
    // Debris: dark chunks thrown up and falling back.
    this.throw(point, up, n(30), 9, 1, (s) => {
      Object.assign(s, { life: 1 + Math.random() * 0.8, size0: 0.05 + Math.random() * 0.06, size1: 0.05, alpha: 1, cell: PARTICLE.chip, drag: 0.3, gravity: 9.8, spin: (Math.random() - 0.5) * 20 });
      s.c0.set('#2c2824');
      s.c1.copy(s.c0);
    });
    // Embers: bright streaks.
    this.throw(point, up, n(36), 12, 1, (s) => {
      Object.assign(s, { life: 0.5 + Math.random() * 0.7, size0: 0.04, size1: 0.02, alpha: 1, cell: PARTICLE.glow, drag: 0.8, gravity: 9.8, stretch: 0.04 });
      s.c0.setRGB(5, 2.8, 0.9);
      s.c1.setRGB(2, 0.4, 0.05);
    }, true);
    // On the ground: a ring of dust rolling outwards, and a scorch mark.
    const ground = this.groundAt(point.x, point.z, point.y + 0.2);
    if (point.y - ground < 1.5) {
      const low = new THREE.Vector3(point.x, ground + 0.3, point.z);
      for (let k = 0, m = n(14); k < m; k++) {
        const a = (k / m) * Math.PI * 2 + Math.random() * 0.3;
        this.throw(low, new THREE.Vector3(Math.cos(a), 0.05, Math.sin(a)), 1, 7 * k, 0.1, (s) => {
          Object.assign(s, { life: 1.6 + Math.random(), size0: 0.6 * k, size1: 2.6 * k, alpha: 0.55, cell: PARTICLE.puff, drag: 2.2, gravity: -0.2, spin: 0.5 });
          s.c0.set('#a69a84');
          s.c1.set('#bdb3a2');
        });
      }
      this.decals.add(new THREE.Vector3(point.x, ground + 0.01, point.z), up, HOLE.scorch, 3 * k);
    }
  }

  /**
   * A spent casing flies out of the gun to the right of `camera`, bounces with a tinkle
   * and lies a few seconds. `aim` 0..1: aimed guns sit in the middle of the view.
   */
  casing(camera: THREE.Camera, w: string, aim: number): void {
    const spec = CASING[w];
    if (!spec) return;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const upv = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const pos = camera.getWorldPosition(new THREE.Vector3()).addScaledVector(right, 0.13 - 0.1 * aim).addScaledVector(upv, -0.1 + 0.05 * aim).addScaledVector(fwd, 0.4);
    const vel = right.multiplyScalar(1.6 + Math.random() * 0.8).addScaledVector(upv, 1.4 + Math.random() * 0.6).addScaledVector(fwd, -0.3 + Math.random() * 0.4);
    const i = this.nextCasing;
    this.nextCasing = (this.nextCasing + 1) % 40;
    this.casings = this.casings.filter((c) => c.i !== i);
    this.casings.push({
      i, pos, vel, rot: new THREE.Euler(Math.random() * 3, Math.random() * 3, Math.random() * 3),
      spin: new THREE.Vector3((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30), life: 4, bounces: 0, len: spec.len, r: spec.r, shell: !!spec.shell,
    });
    this.casingMesh.count = Math.max(this.casingMesh.count, i + 1);
    this.casingMesh.setColorAt(i, color(spec.shell ? '#a3302a' : '#c9a35c'));
    this.casingMesh.instanceColor!.needsUpdate = true;
  }

  /** The sound of a casing landing: a small high ring (brass) or a dull tap (a plastic shell). */
  private tink(at: THREE.Vector3, shell: boolean, loud: number): void {
    const ctx = sound.context();
    const dest = ctx && sound.at(at.x, at.y, at.z, 1);
    if (!ctx || !dest) return;
    const t = ctx.currentTime;
    for (const f of shell ? [700, 1150] : [3900 + Math.random() * 500, 6100 + Math.random() * 700]) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.05 * loud, t);
      g.gain.exponentialRampToValueAtTime(0.0005, t + (shell ? 0.05 : 0.12));
      o.connect(g).connect(dest);
      o.start(t);
      o.stop(t + 0.15);
    }
  }

  update(dt: number): void {
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      r.travelled = Math.min(r.length, r.travelled + r.speed * dt);
      r.mesh.position.copy(r.from).addScaledVector(r.dir, r.travelled);
      const tail = this.v.copy(r.mesh.position).addScaledVector(r.dir, -0.35);
      this.throw(tail, r.dir, 1, 0, 0, (s) => {
        Object.assign(s, { life: 0.07, size0: 0.45, size1: 0.3, alpha: 1, cell: PARTICLE.glow });
        s.c0.setRGB(5, 3, 1.2);
        s.c1.copy(s.c0);
      }, true);
      const back = r.dir.clone().negate();
      this.throw(tail, back, Math.random() < this.particles.budget ? 2 : 1, 0.6, 0.6, (s) => {
        Object.assign(s, { life: 1.2 + Math.random() * 0.8, size0: 0.15, size1: 0.9, alpha: 0.45, cell: PARTICLE.puff, drag: 2, gravity: -0.3, spin: (Math.random() - 0.5) * 2 });
        s.c0.set('#d0ccc4');
        s.c1.set('#a8a49c');
      });
      if (r.travelled >= r.length) {
        r.mesh.removeFromParent();
        this.rockets.splice(i, 1);
        r.onArrive?.();
      }
    }
    this.particles.update(dt);

    // Casings: fly, bounce off the floor a couple of times, lie still, then go.
    for (let k = this.casings.length - 1; k >= 0; k--) {
      const c = this.casings[k];
      c.life -= dt;
      if (c.life <= 0) {
        this.m.makeScale(0, 0, 0);
        this.casingMesh.setMatrixAt(c.i, this.m);
        this.casings.splice(k, 1);
        continue;
      }
      if (c.bounces < 3) {
        c.vel.y -= 9.81 * dt;
        c.pos.addScaledVector(c.vel, dt);
        c.rot.x += c.spin.x * dt;
        c.rot.y += c.spin.y * dt;
        c.rot.z += c.spin.z * dt;
        const floor = this.groundAt(c.pos.x, c.pos.z, c.pos.y + 0.1) + c.r;
        if (c.pos.y < floor) {
          c.pos.y = floor;
          if (c.vel.y < -0.6) this.tink(c.pos, c.shell, Math.min(1, -c.vel.y / 3));
          c.vel.y = -c.vel.y * 0.35;
          c.vel.x *= 0.55;
          c.vel.z *= 0.55;
          c.spin.multiplyScalar(0.5);
          if (++c.bounces >= 3 || c.vel.y < 0.3) {
            // Settled: lying on its side.
            c.bounces = 3;
            c.rot.set(0, c.rot.y, 0);
          }
        }
      }
      this.q.setFromEuler(c.rot);
      this.m.compose(c.pos, this.q, this.v.set(c.len, c.r, c.r));
      this.casingMesh.setMatrixAt(c.i, this.m);
    }
    this.casingMesh.instanceMatrix.needsUpdate = true;
  }
}

