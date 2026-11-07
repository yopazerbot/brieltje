import * as THREE from 'three';
import type { World } from './collision';
import type { Particles, Spawn } from './particles';
import { knock, type Knock } from './propSound';
import { compose, leanQuat, Pole, RigidBody, rotate, type PoleSpec, type Q, type RigidSpec, type RigidWorld, type V3 } from './rigid';
import { PARTICLE } from './sprites';

/**
 * The loose things along the streets and in the gardens (Yoshi, 7 Nov 2026: "make the game feel even
 * more polished"): letterboxes and sign posts that bend and wobble when a car hits them (and snap off
 * when it is fast), wheelie bins, parked bikes and garden chairs that tumble, bounce and slide to a
 * stop (world/rigid.ts). A car or a bike knocks them about; you push them on foot; a blast throws
 * them; a shot makes a post ring. They never stop or move a player or a car, so nothing here can push
 * anyone through a wall or change what the server decides: each page has its own (nothing on the
 * wire), and after half a minute at rest, when nobody looks at the spot, each goes back to its place.
 *
 * Each kind is two instanced meshes: the ones where they stand (one draw call, no shadow, as they
 * were in the tiles) and the few that are moving or lie knocked over (their own shadow, from Medium).
 * The signs' faces are one more, each face its part of the picture (world/roadside.ts).
 */

export interface KindSpec {
  /** Its shape, its foot's middle at the origin, its front +z */
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** What a bullet hit on it looks and sounds like (a surface name, world/effects.ts) */
  tag: string;
  /** 'pole': on a post in the ground, it leans, wobbles and bends; 'rigid': it tumbles */
  mode: 'pole' | 'rigid';
  sound: Knock;
  /** kg */
  mass: number;
  /** How much a person walking into it moves it: 1 a chair or a bin, less for a bike, a post */
  push: number;
  bounce?: number;
  friction?: number;
  /** Where it touches the ground, in the model's frame; the corners of its box if not given */
  points?: V3[];
  /** Far points that walls stop too, in the model's frame */
  edges?: V3[];
  /** The box its turning follows (min, max) in the model's frame; the geometry's if not given */
  box?: [V3, V3];
  /** How far from its middle a car or a person touches it (m); half its box's width if not given */
  reach?: number;
  pole?: PoleSpec;
  /** A pole: a car faster than this (m/s) snaps it off at its foot, and it tumbles */
  snap?: number;
  /** Faces drawn on it (the signs): their material, each place's faces a part of its picture */
  faces?: THREE.Material;
  /** Each one in its own colour (Place.color) */
  tinted?: boolean;
}

/** A face on a sign: w x h, its bottom `y` up the post and `z` in front of it, facing +z (or -z: `back`), showing `rect` (u, v, width, height) of the picture. */
export interface Face {
  w: number;
  h: number;
  y: number;
  z: number;
  back: boolean;
  rect: [number, number, number, number];
}

/** Where one stands: its foot, its turn (front +z turned by yaw), a lean about its own left-right axis (+ forwards), its height (a post's), its colour, its faces. */
export interface Place {
  x: number;
  y: number;
  z: number;
  yaw: number;
  lean?: number;
  sy?: number;
  color?: string;
  faces?: Face[];
}

/** Something that knocks them: a car or a bike (its box on the plan) or a person (`r`, a circle). */
export interface Mover {
  key: string;
  x: number;
  z: number;
  /** Its bottom */
  y: number;
  height: number;
  yaw: number;
  halfL: number;
  halfW: number;
  r: number;
  /** A car or a bike (hard, heavy) rather than a person */
  vehicle: boolean;
  /** Told when it hit a post hard enough to feel it (m/s) */
  bump?: (strength: number) => void;
}

interface Kind {
  spec: KindSpec;
  com: V3;
  half: V3;
  points: V3[];
  edges: V3[];
  reach: number;
  props: Prop[];
  still: THREE.InstancedMesh;
  live: THREE.InstancedMesh;
  slots: (Prop | null)[];
  face: THREE.InstancedMesh | null;
  faceLocal: THREE.Matrix4[];
  stillDirty: boolean;
  liveDirty: boolean;
}

interface Prop {
  kind: Kind;
  i: number;
  place: Place;
  sy: number;
  homeQ: Q;
  pole: Pole | null;
  body: RigidBody | null;
  /** Its slot among the moving ones, or -1 */
  slot: number;
  /** Not as it was put */
  away: boolean;
  /** Seconds it has lain still away from its place */
  idle: number;
  /** When it last made a sound (s) */
  heard: number;
  /** Its faces in the kind's face mesh */
  faces: number[];
}

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const CELL = 12;
const cellKey = (x: number, z: number) => (Math.floor(x / CELL) + 32768) * 65536 + (Math.floor(z / CELL) + 32768);
/** Seconds at rest before a knocked thing may go back to its place (when nobody looks) */
const RETURN = 30;
/** The most that move (or lie knocked over) at once per kind: High and up, Low */
const LIVE = 20;
const LIVE_LOW = 8;
const UP_Q = (yaw: number): Q => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];

export class LooseProps {
  readonly group = new THREE.Group();
  /** Low or a phone: fewer move at once, and those throw no shadow */
  low = false;
  private kinds = new Map<string, Kind>();
  private grid = new Map<number, Prop[]>();
  private away = new Set<Prop>();
  private world: World | null = null;
  private particles: Particles | null = null;
  private time = 0;
  private last = new Map<string, { x: number; z: number; vx: number; vz: number }>();
  /** Pairs touching last frame: a person's push on a post is felt once, as it starts */
  private touched = new Set<string>();
  private touchedNow = new Set<string>();
  private frustum = new THREE.Frustum();
  private m = new THREE.Matrix4();
  private m2 = new THREE.Matrix4();
  private m3 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private sphere = new THREE.Sphere();
  private env: RigidWorld = {
    ground: (x, z, y) => this.world?.groundAt(x, z, y, 0).y ?? 0,
    wall: (a, b, r) => {
      const w = this.world;
      if (!w) return null;
      // Above the ground under it and the kerbs: those are the points' to touch, not walls.
      const lift = w.groundAt(b[0], b[2], b[1] + 0.5, 0).y + r + 0.06;
      const hit = w.collide({ x: a[0], y: Math.max(a[1], lift), z: a[2] }, { x: b[0], y: Math.max(b[1], lift), z: b[2] }, r, true);
      return hit && Math.abs(hit.ny) < 0.5 ? [hit.nx, hit.nz] : null;
    },
  };
  private spawn: Spawn = {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size0: 0.1, size1: 0.1,
    c0: new THREE.Color(), c1: new THREE.Color(), alpha: 1, cell: 0, drag: 0, gravity: 0, spin: 0, stretch: 0,
  };
  /** Movers this frame (main.ts sets it once): the cars and bikes being ridden, and you on foot */
  movers: () => Mover[] = () => [];

  /** Into the game: the collision world they fall in, and the particle pools for their dust. */
  attach(scene: THREE.Scene, world: World, particles: Particles): void {
    this.world = world;
    this.particles = particles;
    scene.add(this.group);
  }

  /** Whether a box w x d (its front turned by yaw) is clear of blocks between y0 and y1 at (x, z): for placing them. */
  free(x: number, z: number, yaw: number, w: number, d: number, y0: number, y1: number): boolean {
    return !this.world || this.world.boxFree(x, z, yaw, d / 2, w / 2, y0, y1);
  }

  /** A kind of thing, and where each of them stands. */
  add(name: string, spec: KindSpec, places: Place[]): void {
    if (!places.length || this.kinds.has(name)) return;
    const g = spec.geometry;
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    const [lo, hi] = spec.box ?? [bb.min.toArray() as V3, bb.max.toArray() as V3];
    const com: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    const half: V3 = [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2];
    const corners: V3[] = [];
    for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) corners.push([x, y, z]);
    const n = places.length;
    const mesh = (count: number, live: boolean) => {
      const m = new THREE.InstancedMesh(g, spec.material, count);
      m.name = `loose-${name}`;
      m.userData.material = spec.tag;
      m.receiveShadow = true;
      m.castShadow = live;
      if (live) m.frustumCulled = false; // a few, anywhere: their bounds change every frame
      for (let i = 0; i < count; i++) m.setMatrixAt(i, ZERO);
      if (spec.tinted) for (let i = 0; i < count; i++) m.setColorAt(i, new THREE.Color(places[Math.min(i, n - 1)].color ?? '#ffffff'));
      this.group.add(m);
      return m;
    };
    const kind: Kind = {
      spec, com, half,
      points: spec.points ?? corners,
      edges: spec.edges ?? [],
      reach: spec.reach ?? Math.max(half[0], half[2]),
      props: [], still: mesh(n, false), live: mesh(LIVE, true), slots: Array(LIVE).fill(null),
      face: null, faceLocal: [], stillDirty: true, liveDirty: true,
    };
    const faces = places.reduce((s, p) => s + (p.faces?.length ?? 0), 0);
    if (spec.faces && faces) {
      // One plane per face, each showing its part of the picture (uvRect: u, v, width, height).
      const plane = new THREE.PlaneGeometry(1, 1);
      const rects = new THREE.InstancedBufferAttribute(new Float32Array(faces * 4), 4);
      plane.setAttribute('uvRect', rects);
      const face = new THREE.InstancedMesh(plane, spec.faces, faces);
      face.name = `loose-${name}-faces`;
      face.userData.material = spec.tag;
      face.receiveShadow = true;
      kind.face = face;
      this.group.add(face);
      let k = 0;
      for (const p of places) {
        for (const f of p.faces ?? []) {
          rects.setXYZW(k, ...f.rect);
          const local = new THREE.Matrix4().makeTranslation(0, f.y + f.h / 2, f.z + (f.back ? -0.006 : 0.006));
          if (f.back) local.multiply(new THREE.Matrix4().makeRotationY(Math.PI));
          kind.faceLocal.push(local.multiply(new THREE.Matrix4().makeScale(f.w, f.h, 1)));
          k++;
        }
      }
    }
    let k = 0;
    places.forEach((place, i) => {
      const lean = place.lean ? [Math.sin(place.lean / 2), 0, 0, Math.cos(place.lean / 2)] as Q : null;
      const homeQ = lean ? compose(UP_Q(place.yaw), lean) : UP_Q(place.yaw);
      const prop: Prop = { kind, i, place, sy: place.sy ?? 1, homeQ, pole: null, body: null, slot: -1, away: false, idle: 0, heard: 0, faces: [] };
      for (let f = 0; f < (place.faces?.length ?? 0); f++) prop.faces.push(k++);
      kind.props.push(prop);
      const key = cellKey(place.x, place.z);
      let cell = this.grid.get(key);
      if (!cell) this.grid.set(key, (cell = []));
      cell.push(prop);
      this.draw(prop, kind.still, i);
    });
    this.kinds.set(name, kind);
  }

  /** Its frame now (without a post's height): where it stands, its turn, its lean or tumble. */
  private frame(p: Prop, out: THREE.Matrix4): THREE.Matrix4 {
    const { place, body, pole, kind } = p;
    if (body) {
      const c = kind.com;
      this.q.set(body.q[0], body.q[1], body.q[2], body.q[3]);
      out.compose(this.v.set(body.p[0], body.p[1], body.p[2]), this.q, this.s.set(1, 1, 1));
      return out.multiply(this.m2.makeTranslation(-c[0], -c[1] * p.sy, -c[2]));
    }
    const q = pole ? compose(leanQuat(pole.lean[0], pole.lean[1]), p.homeQ) : p.homeQ;
    this.q.set(q[0], q[1], q[2], q[3]);
    return out.compose(this.v.set(place.x, place.y, place.z), this.q, this.s.set(1, 1, 1));
  }

  /** Draw it into `mesh` at instance `i`, its faces with it. */
  private draw(p: Prop, mesh: THREE.InstancedMesh, i: number): void {
    const f = this.frame(p, this.m);
    if (p.sy !== 1) mesh.setMatrixAt(i, this.m2.copy(f).multiply(this.m3.makeScale(1, p.sy, 1)));
    else mesh.setMatrixAt(i, f);
    const face = p.kind.face;
    if (!face) return;
    for (const k of p.faces) face.setMatrixAt(k, this.m2.copy(f).multiply(p.kind.faceLocal[k]));
    face.instanceMatrix.needsUpdate = true;
  }

  /** Where it is now on the plan, its bottom and its top. */
  private where(p: Prop): [number, number, number, number] {
    const b = p.body;
    if (b) {
      const r = Math.max(p.kind.half[0], p.kind.half[1] * p.sy, p.kind.half[2]);
      return [b.p[0], b.p[2], b.p[1] - r, b.p[1] + r];
    }
    const { place, kind } = p;
    return [place.x, place.z, place.y, place.y + (kind.com[1] + kind.half[1]) * p.sy];
  }

  /** Make it move: a slot among the moving ones (letting go of one lying still if all are taken). False when none is free. */
  private wake(p: Prop): boolean {
    const kind = p.kind;
    if (p.slot < 0) {
      const cap = this.low ? LIVE_LOW : LIVE;
      let slot = kind.slots.findIndex((s, i) => i < cap && s === null);
      if (slot < 0) {
        // The one lying still longest goes back to the still mesh as it lies.
        let best = -1;
        for (let i = 0; i < cap; i++) {
          const o = kind.slots[i]!;
          const resting = (o.body?.asleep ?? true) && (o.pole?.asleep ?? true);
          if (resting && (best < 0 || o.idle > kind.slots[best]!.idle)) best = i;
        }
        if (best < 0) return false;
        const o = kind.slots[best]!;
        this.draw(o, kind.still, o.i);
        kind.stillDirty = true;
        kind.live.setMatrixAt(best, ZERO);
        o.slot = -1;
        slot = best;
      }
      kind.slots[slot] = p;
      p.slot = slot;
      kind.still.setMatrixAt(p.i, ZERO);
      kind.stillDirty = true;
      if (kind.spec.tinted) kind.live.setColorAt(slot, new THREE.Color(p.place.color ?? '#ffffff'));
    }
    if (kind.spec.mode === 'rigid' && !p.body) p.body = this.makeBody(p, p.homeQ);
    if (kind.spec.mode === 'pole' && !p.body) p.pole ??= new Pole(kind.spec.pole ?? { hz: 2, damping: 0.12, yield: 0.12, maxBend: 1.3 });
    p.body?.wake();
    p.away = true;
    p.idle = 0;
    this.away.add(p);
    kind.liveDirty = true;
    return true;
  }

  /** A body for it, turned by q, where its frame puts it. */
  private makeBody(p: Prop, q: Q): RigidBody {
    const { kind, place, sy } = p;
    const spec = kind.spec;
    const c = kind.com;
    const scale = (v: V3): V3 => [v[0] - c[0], (v[1] - c[1]) * sy, v[2] - c[2]];
    const wide = Math.max(kind.half[0], ...(place.faces ?? []).map((f) => f.w / 2));
    const rigid: RigidSpec = {
      mass: spec.mass,
      half: [wide, kind.half[1] * sy, kind.half[2]],
      points: kind.points.map(scale),
      edges: kind.edges.map(scale),
      bounce: spec.bounce ?? 0.2,
      friction: spec.friction ?? 0.6,
      radius: Math.min(0.3, Math.max(0.08, Math.min(kind.half[0], kind.half[2]))),
    };
    const off = rotate(q, [c[0], c[1] * sy, c[2]]);
    return new RigidBody(rigid, [place.x + off[0], place.y + off[1], place.z + off[2]], q);
  }

  /** A pole snapped off at its foot: from here on it tumbles. */
  private snap(p: Prop): void {
    const pole = p.pole!;
    const q = compose(leanQuat(pole.lean[0], pole.lean[1]), p.homeQ);
    p.body = this.makeBody(p, q);
    // It goes on turning as it was, round its foot.
    const h = p.kind.com[1] * p.sy;
    const [wx, wz] = pole.spin;
    p.body.w[0] = wz;
    p.body.w[2] = -wx;
    p.body.v[0] = wx * h;
    p.body.v[2] = wz * h;
    p.pole = null;
  }

  /** Back where it was put, as it was. */
  private home(p: Prop): void {
    const kind = p.kind;
    p.body = null;
    p.pole?.reset();
    p.away = false;
    p.idle = 0;
    this.away.delete(p);
    if (p.slot >= 0) {
      kind.live.setMatrixAt(p.slot, ZERO);
      kind.slots[p.slot] = null;
      p.slot = -1;
      kind.liveDirty = true;
    }
    this.draw(p, kind.still, p.i);
    kind.stillDirty = true;
  }

  /** The things near (x, z) within `reach` m: those where they were put, and every one that is away. */
  private near(x: number, z: number, reach: number, out: Prop[]): Prop[] {
    out.length = 0;
    for (let i = Math.floor((x - reach) / CELL); i <= Math.floor((x + reach) / CELL); i++) {
      for (let j = Math.floor((z - reach) / CELL); j <= Math.floor((z + reach) / CELL); j++) {
        const cell = this.grid.get((i + 32768) * 65536 + (j + 32768));
        if (cell) for (const p of cell) if (!p.away) out.push(p);
      }
    }
    for (const p of this.away) out.push(p);
    return out;
  }

  private sound(p: Prop, at: V3 | [number, number, number], strength: number): void {
    if (this.time - p.heard < 0.12) return;
    p.heard = this.time;
    knock(p.kind.spec.mode === 'pole' && !p.body ? 'post' : p.kind.spec.sound, at[0], at[1], at[2], strength);
  }

  private dust(x: number, y: number, z: number, strength: number): void {
    const parts = this.particles;
    if (!parts) return;
    const s = this.spawn;
    const n = Math.round(Math.min(6, strength) * (this.low ? 0.5 : 1));
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const v = 0.3 + Math.random() * 0.6;
      Object.assign(s, {
        x: x + Math.cos(a) * 0.15, y: y + 0.05, z: z + Math.sin(a) * 0.15, vx: Math.cos(a) * v, vy: 0.2 + Math.random() * 0.3, vz: Math.sin(a) * v,
        life: 0.8 + Math.random() * 0.6, size0: 0.12, size1: 0.55, alpha: 0.35, cell: PARTICLE.puff, drag: 2.5, gravity: -0.1, spin: (Math.random() - 0.5) * 2, stretch: 0,
      });
      s.c0.set('#b6aa94');
      s.c1.set('#c4baa8');
      parts.spawn(s);
    }
  }

  private pending: Prop[] = [];

  /**
   * One mover against one thing: if it touches, the thing is knocked (a post leans or snaps, a body
   * gets a push where it was struck), never the mover. `vx`, `vz`: the mover's speed on the plan.
   */
  private contact(m: Mover, vx: number, vz: number, p: Prop): void {
    const [px, pz, y0, y1] = this.where(p);
    if (y1 < m.y + 0.05 || y0 > m.y + m.height) return;
    const fx = -Math.sin(m.yaw);
    const fz = -Math.cos(m.yaw);
    const dx = px - m.x;
    const dz = pz - m.z;
    const u = dx * fx + dz * fz;
    const w = -dx * fz + dz * fx;
    const cu = Math.max(-m.halfL, Math.min(m.halfL, u));
    const cw = Math.max(-m.halfW, Math.min(m.halfW, w));
    let nu = u - cu;
    let nw = w - cw;
    let d = Math.hypot(nu, nw);
    if (d < 1e-4) {
      // Its middle inside the box: out the nearest side.
      if (m.halfL - Math.abs(u) < m.halfW - Math.abs(w)) [nu, nw] = [Math.sign(u) || 1, 0];
      else [nu, nw] = [0, Math.sign(w) || 1];
      d = 0;
    } else {
      nu /= d;
      nw /= d;
    }
    const reach = p.kind.reach;
    const pen = reach + m.r - d;
    if (pen <= 0) return;
    const nx = nu * fx - nw * fz;
    const nz = nu * fz + nw * fx;
    const pair = `${m.key}|${p.kind.still.name}|${p.i}`;
    this.touchedNow.add(pair);
    const fresh = !this.touched.has(pair);
    const body = p.body;
    const rel = (vx - (body?.v[0] ?? 0)) * nx + (vz - (body?.v[2] ?? 0)) * nz;
    const spec = p.kind.spec;
    if (spec.mode === 'pole' && !body) {
      if (rel < 0.15) return;
      if (!m.vehicle) {
        // Walked into: a little wobble as you meet it, never a bend.
        if (!fresh) return;
        if (!this.wake(p)) return;
        const pole = p.pole!;
        pole.push(nx, nz, Math.min(rel * 0.6 * spec.push, 2 * Math.PI * pole.spec.hz * pole.spec.yield * 0.7));
        this.sound(p, [px, m.y + 1, pz], rel * 0.5);
        return;
      }
      if (!this.wake(p)) return;
      const pole = p.pole!;
      // A bumper at about half a metre up: it turns the post at the car's speed over that height.
      const out = pole.spin[0] * nx + pole.spin[1] * nz;
      const want = rel * 1.6;
      if (out < want) pole.push(nx, nz, Math.min(want - out, 14));
      if (fresh) {
        this.sound(p, [px, p.place.y + 0.6, pz], rel);
        if (rel > 2) m.bump?.(Math.min(4, rel * 0.35));
        if (spec.snap !== undefined && rel > spec.snap) this.snap(p);
      }
      return;
    }
    if (rel < 0.12) return; // a rigid thing, or a post snapped off and tumbling
    if (!this.wake(p)) return;
    const b = p.body!;
    const k = m.vehicle ? 1 : spec.push;
    // A bumper bounces it on ahead (faster than the car) and lifts it a little; a person shoves it at their pace.
    const tx = vx - nx * (vx * nx + vz * nz);
    const tz = vz - nz * (vx * nx + vz * nz);
    const dv = rel * (m.vehicle ? 1.25 : 1.05) * k;
    const lift = m.vehicle ? rel * (0.05 + Math.random() * 0.08) : 0;
    const j: V3 = [(nx * dv + tx * 0.25 * k) * spec.mass, lift * spec.mass, (nz * dv + tz * 0.25 * k) * spec.mass];
    // Struck low on its near side: it tips away from the bumper as it goes.
    const hy = Math.min(y1 - 0.05, Math.max(y0 + 0.05, m.y + (m.vehicle ? 0.5 : 0.45)));
    b.impulse(j, [px - nx * reach * 0.8, hy, pz - nz * reach * 0.8]);
    if (m.vehicle && rel > 3) for (let a = 0; a < 3; a++) b.w[a] += (Math.random() - 0.5) * rel * 0.4;
    // Out of the mover's way at once, unless a wall is there.
    const step = Math.min(pen, 0.5);
    if (!this.env.wall(b.p, [b.p[0] + nx * step, b.p[1], b.p[2] + nz * step], b.spec.radius)) {
      b.p[0] += nx * step;
      b.p[2] += nz * step;
    }
    if (fresh || rel > 1.5) this.sound(p, b.p, rel * (m.vehicle ? 1 : 0.6));
  }

  /** A blast at `at` (grenade or rocket) of `radius` m: what is near flies, posts bend, behind walls nothing. */
  blast(at: THREE.Vector3, radius: number): void {
    const list = this.near(at.x, at.z, radius * 1.3, this.pending);
    for (const p of list) {
      const [px, pz, y0, y1] = this.where(p);
      const py = (y0 + y1) / 2;
      const d = Math.hypot(px - at.x, py - at.y, pz - at.z);
      if (d > radius * 1.3 || !this.world) continue;
      if (this.world.blocked({ x: at.x, y: at.y + 0.3, z: at.z }, { x: px, y: py, z: pz })) continue;
      const k = (1 - d / (radius * 1.3)) ** 1.5;
      const h = Math.max(0.3, Math.hypot(px - at.x, pz - at.z));
      const nx = (px - at.x) / h;
      const nz = (pz - at.z) / h;
      if (!this.wake(p)) continue;
      if (p.pole) {
        p.pole.push(nx, nz, 16 * k);
        if (k > 0.55 && p.kind.spec.snap !== undefined) this.snap(p);
      }
      const b = p.body;
      if (b) {
        const v = 14 * k;
        b.impulse([nx * v * b.spec.mass, (3 + 6 * k) * b.spec.mass, nz * v * b.spec.mass], [px - nx * 0.2, y0 + 0.1, pz - nz * 0.2]);
        for (let a = 0; a < 3; a++) b.w[a] += (Math.random() - 0.5) * 12 * k;
      }
    }
  }

  /** A shot hit `on` at `point` coming along `-normal`: a post rings and sways a little, a bin rocks. */
  shot(point: THREE.Vector3, normal: THREE.Vector3, on: THREE.Object3D): void {
    if (!on.name.startsWith('loose-')) return;
    // Only a prop of the kind that was hit (a shot letterbox never rocks the bin beside it).
    const kind = this.kinds.get(on.name.slice('loose-'.length).replace(/-faces$/, ''));
    if (!kind) return;
    let best: Prop | null = null;
    let bd = 2;
    for (const p of this.near(point.x, point.z, 2, this.pending)) {
      if (p.kind !== kind) continue;
      const [px, pz] = this.where(p);
      const d = Math.hypot(px - point.x, pz - point.z);
      if (d < bd) [best, bd] = [p, d];
    }
    if (!best || !this.wake(best)) return;
    const h = Math.hypot(normal.x, normal.z) || 1;
    if (best.pole) best.pole.push(-normal.x / h, -normal.z / h, 0.5);
    best.body?.impulse([-normal.x * 2, -normal.y * 2, -normal.z * 2], [point.x, point.y, point.z]);
    this.sound(best, [point.x, point.y, point.z], 3);
  }

  /** Every frame: the movers knock them, the moving ones move, the ones at rest unseen go back. */
  update(dt: number, camera: THREE.Camera): void {
    if (!(dt > 0) || !this.kinds.size) return;
    const d = Math.min(dt, 0.05);
    this.time += dt;
    // The movers' speeds from where they were last frame (a jump: a portal, a respawn, isn't a speed).
    const seen = new Set<string>();
    for (const m of this.movers()) {
      seen.add(m.key);
      const last = this.last.get(m.key);
      let vx = 0;
      let vz = 0;
      if (last) {
        const jx = (m.x - last.x) / dt;
        const jz = (m.z - last.z) / dt;
        if (Math.hypot(jx, jz) < 60) {
          vx = last.vx + (jx - last.vx) * 0.6;
          vz = last.vz + (jz - last.vz) * 0.6;
        }
      }
      this.last.set(m.key, { x: m.x, z: m.z, vx, vz });
      if (Math.hypot(vx, vz) < 0.1) continue;
      const reach = Math.max(m.halfL, m.halfW) + m.r + 1;
      for (const p of this.near(m.x, m.z, reach, this.pending)) this.contact(m, vx, vz, p);
    }
    for (const key of this.last.keys()) if (!seen.has(key)) this.last.delete(key);
    [this.touched, this.touchedNow] = [this.touchedNow, this.touched];
    this.touchedNow.clear();

    // The moving ones.
    let looked = false;
    for (const kind of this.kinds.values()) {
      for (const p of kind.slots) {
        if (!p) continue;
        p.pole?.step(d);
        const b = p.body;
        if (b) {
          b.step(d, this.env);
          if (b.knock > 1) {
            this.sound(p, b.p, b.knock);
            if (b.knock > 3) this.dust(b.p[0], b.p[1] - kind.half[1] * 0.8, b.p[2], b.knock);
          }
          b.knock = 0;
          // Lost (through the ground, or worse): straight back.
          if (!b.p.every(Number.isFinite) || b.p[1] < p.place.y - 6) {
            this.home(p);
            continue;
          }
        }
        this.draw(p, kind.live, p.slot);
        kind.liveDirty = true;
      }
    }
    // The ones at rest away from their place go back after a while, once neither spot is in view.
    for (const p of this.away) {
      const resting = (p.body?.asleep ?? true) && (p.pole?.asleep ?? true);
      p.idle = resting ? p.idle + dt : 0;
      if (p.idle < RETURN) continue;
      if (!looked) {
        camera.updateMatrixWorld();
        this.frustum.setFromProjectionMatrix(this.m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
        looked = true;
      }
      const [x, z, y0, y1] = this.where(p);
      const eye = camera.position;
      const inView = (px: number, py: number, pz: number) =>
        Math.hypot(px - eye.x, pz - eye.z) < 250 && this.frustum.intersectsSphere(this.sphere.set(this.v.set(px, py, pz), 2));
      if (!inView(x, (y0 + y1) / 2, z) && !inView(p.place.x, p.place.y + 0.6, p.place.z)) this.home(p);
    }
    for (const kind of this.kinds.values()) {
      const cap = this.low ? LIVE_LOW : LIVE;
      kind.live.castShadow = !this.low;
      // Fewer may move on Low: those over the number go back to their place.
      for (let i = cap; i < LIVE; i++) {
        const p = kind.slots[i];
        if (p) this.home(p);
      }
      if (kind.liveDirty) {
        kind.live.instanceMatrix.needsUpdate = true;
        if (kind.live.instanceColor) kind.live.instanceColor.needsUpdate = true;
        kind.live.computeBoundingSphere(); // for shots
        kind.liveDirty = false;
      }
      if (kind.face && (kind.stillDirty || kind.slots.some(Boolean))) kind.face.computeBoundingSphere(); // for shots
      if (kind.stillDirty) {
        kind.still.instanceMatrix.needsUpdate = true;
        kind.still.computeBoundingSphere();
        kind.stillDirty = false;
      }
    }
  }

  /** Dev build: how many are away from their place and how many move, per kind. */
  state(): Record<string, { count: number; away: number; moving: number }> {
    const out: Record<string, { count: number; away: number; moving: number }> = {};
    for (const [name, kind] of this.kinds) {
      out[name] = {
        count: kind.props.length,
        away: kind.props.filter((p) => p.away).length,
        moving: kind.props.filter((p) => (p.body && !p.body.asleep) || (p.pole && !p.pole.asleep)).length,
      };
    }
    return out;
  }

  /** Dev build: where each of a kind was put and is now (its middle on the plan, bottom, top), and whether it is away. */
  spots(name: string): { x: number; y: number; z: number; yaw: number; now: number[]; away: boolean }[] {
    return (this.kinds.get(name)?.props ?? []).map((p) => ({ x: p.place.x, y: p.place.y, z: p.place.z, yaw: p.place.yaw, now: this.where(p), away: p.away }));
  }

  /** Dev build: everything back in its place now. */
  tidy(): void {
    for (const p of [...this.away]) this.home(p);
  }
}

/** The street's and the gardens' loose things: one set for the page (world/roadside.ts and world/yard.ts add to it). */
export const looseProps = new LooseProps();

/**
 * A material that shows a part of its picture per instance (the uvRect attribute: u, v, width, height),
 * for the signs' faces: one draw call for all of them.
 */
export function facesMaterial(material: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 uvRect;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n  vMapUv = uvRect.xy + uv * uvRect.zw;\n#endif');
  };
  material.customProgramCacheKey = () => 'loose-faces';
  return material;
}
