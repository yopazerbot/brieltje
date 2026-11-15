/** The people in the helicopter: the pilot and up to three passengers seated in its cabin as it is drawn (you among them). */
import * as THREE from 'three';
import type { Heli } from './heli';
import type { Seat } from '../net/avatars';
import { SEAT_HIP, hasSwat, type Body, type Pose } from '../net/swat';

/**
 * The model's points the people use (docs/helicopter/manifest.json), in its frame: metres, nose to -z, +x right, +y up,
 * the origin on the ground under the hub. The seats' hip points come from the model itself (Heli.seatPoint).
 */
export const POINTS = {
  gripCyclic: [0.37, 1.28, -1.73],
  pivotCyclic: [0.37, 0.72, -1.62],
  gripCollective: [0.11, 1.2, -1.48],
  pivotCollective: [0.11, 0.98, -0.95],
  pedals: [[0.25, 0.86, -2.185], [0.49, 0.86, -2.185]],
  floor: 0.72,
} as const;
/** The seats the game uses: 0 the pilot's (front right), 1 beside it, 2 and 3 behind, all facing the nose */
export const SEATS = 4;

/**
 * How a figure sits in each seat: the hips `drop` m under the seat's point, the body leaning back by `recline` about
 * it (the figure's root SEAT_HIP under the hips, as on a horse), the knees `knees` m either side of the seat's middle,
 * the head turned `out` to its window (rad, to the left). The figure's arms are short (0.41 m) and the grips low, so
 * the pilot also leans its upper body forward over the sticks, as a rider over the bars (net/swat.ts), sits nearly
 * upright and 5.5 cm into the cushion. The pilot's ankles go `heel` from each pedal's point and the wrists `wristCyclic` and
 * `wristCollective` from the grips (towards the shoulders: the fist round the grip); the passengers' ankles on the floor
 * `ahead` of the hips and `spread` either side, the wrists over the thighs (`lap`).
 */
export interface Fit {
  recline: number;
  drop: number;
  knees: number;
  out: number;
}
export const PILOT = { heel: [0, 0.07, 0.1], wristCyclic: [0.03, 0.07, 0.06], wristCollective: [0.02, 0.06, 0.02] } as const;
export const PASSENGER = { ahead: 0.44, spread: 0.12, ankle: 0.09, lap: { up: 0.26, ahead: 0.12, side: 0.12 } } as const;
export const FITS: readonly Fit[] = [
  { recline: 0.07, drop: 0.055, knees: 0.14, out: 0 },
  { recline: 0.14, drop: 0.04, knees: 0.14, out: 0.4 },
  { recline: 0.14, drop: 0.04, knees: 0.14, out: -0.4 },
  { recline: 0.14, drop: 0.04, knees: 0.14, out: 0.4 },
];
/** The pilot's head: how far it turns with the machine's turn (per rad/s) and towards where it flies, the most (rad), how fast it follows (1/s) */
const LOOK_TURN = 0.25;
const LOOK_PATH = 0.5;
const LOOK_MAX = 0.4;
const LOOK_EASE = 4;
/**
 * How far the sticks would go at full deflection (rad about their pivots), once they are drawn moving (sticksMove): the
 * cyclic's grip 2.8 cm each way, all the figure's short arms leave (a real one goes several times further).
 */
const CYCLIC_THROW = 0.05;
const COLLECTIVE_THROW = 0.3;
/** The machine's lean at full cyclic (shared/heli.mjs HELI.TILT) */
const TILT = 0.5;
/**
 * m more between the pilot's knees per unit of the machine's bank (its roll's sine): the figure bends its knees towards
 * the world's up (net/swat.ts), so in a bank both swing to one side, the inner one towards the cyclic.
 */
const KNEE_BANK = 0.16;
/** Closer than this to your own figure's head (m), the camera is in it (the pilot's view): your figure isn't drawn. */
const TOO_CLOSE = 1;

type SeatCar = NonNullable<Seat['car']>;
type HeliSeat = Seat & { root: { x: number; y: number; z: number }; quat: THREE.Quaternion; car: SeatCar };
interface Place {
  seat: HeliSeat;
  /** About where the head is, in the world */
  head: THREE.Vector3;
}
interface Occupied {
  heli: Heli;
  /** Its seats worked out this frame (its near model shows) */
  ok: boolean;
  /** The pilot's head turn, eased; the machine's heading last frame; the time aboard (the passengers' looks) */
  look: number;
  yaw: number;
  clock: number;
  places: Place[];
  /** Figures without a player, for the checks and the pictures */
  dummies: (Body | null)[];
}
/** The sticks' deflection: the cyclic forward and right (-1 to 1), the lever up (0 to 1) */
export interface Sticks {
  fwd: number;
  side: number;
  lift: number;
}

const X_AXIS = new THREE.Vector3(1, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const STILL: Sticks = { fwd: 0, side: 0, lift: 0 };
/** The pilot's hip point before any machine is in (the warm-up) */
const WARM_SEAT = new THREE.Vector3(0.37, 1.1, -1.28);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _tilt = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const vec = (a: readonly number[]) => new THREE.Vector3(a[0], a[1], a[2]);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const angle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

function place(i: number): Place {
  const car: SeatCar = { feet: [new THREE.Vector3(), new THREE.Vector3()], hands: [new THREE.Vector3(), new THREE.Vector3()], head: 0, knees: FITS[i].knees };
  return {
    seat: {
      x: 0, y: 0, z: 0, yaw: 0, pitch: 0, root: { x: 0, y: 0, z: 0 }, quat: new THREE.Quaternion(), tagUp: i, car,
      // The pilot also as on a bike (the same points): the upper body over the sticks.
      bike: i === 0 ? { pedals: car.feet, grips: car.hands } : undefined,
    },
    head: new THREE.Vector3(),
  };
}

/** Where a grip is with its stick turned about its pivot (the model's frame): the cyclic forward and right, the lever up. */
export function gripAt(which: 'cyclic' | 'collective', sticks: Sticks, out: THREE.Vector3): THREE.Vector3 {
  const pivot = vec(which === 'cyclic' ? POINTS.pivotCyclic : POINTS.pivotCollective);
  out.copy(vec(which === 'cyclic' ? POINTS.gripCyclic : POINTS.gripCollective)).sub(pivot);
  if (which === 'cyclic') {
    out.applyAxisAngle(X_AXIS, -CYCLIC_THROW * clamp(sticks.fwd, -1, 1)); // the top to the nose
    out.applyAxisAngle(Z_AXIS, -CYCLIC_THROW * clamp(sticks.side, -1, 1)); // the top to the right
  } else out.applyAxisAngle(X_AXIS, COLLECTIVE_THROW * clamp(sticks.lift, 0, 1)); // the front end up
  return out.add(pivot);
}

/**
 * The places of every seat in frame `m` (the model's frame in the world): the root and its turn, the head, where the
 * ankles and wrists go. `seatAt(i)` is seat i's hip point in the model's frame; `yaw` the machine's heading. `look`
 * turns the pilot's head; the passengers look out of their windows, a little to and fro with `clock`.
 */
export function seatPlaces(places: Place[], seatAt: (i: number) => THREE.Vector3, m: THREE.Matrix4, yaw: number, look: number, clock: number, sticks: Sticks): void {
  m.decompose(_p, _q, _s);
  const bank = Math.abs(_v.set(1, 0, 0).applyQuaternion(_q).y); // the sine of its roll
  for (let i = 0; i < places.length; i++) {
    const { seat, head } = places[i];
    const fit = FITS[i];
    const hip = seatAt(i);
    const at = _w.copy(hip);
    at.y -= fit.drop;
    _tilt.setFromAxisAngle(X_AXIS, fit.recline); // leaning back: the head goes to the back (+z)
    _v.copy(at).applyMatrix4(m);
    seat.x = _v.x;
    seat.y = _v.y;
    seat.z = _v.z;
    _v.set(0, -SEAT_HIP, 0).applyQuaternion(_tilt).add(at).applyMatrix4(m);
    seat.root.x = _v.x;
    seat.root.y = _v.y;
    seat.root.z = _v.z;
    seat.quat.copy(_q).multiply(_tilt);
    seat.yaw = yaw - Math.PI;
    seat.pitch = -fit.recline; // the head nods forward again
    head.set(0, 0.72, 0).applyQuaternion(_tilt).add(at).applyMatrix4(m);
    const c = seat.car;
    if (i === 0) {
      // The pilot: the feet on the pedals, the left hand on the lever's grip, the right on the cyclic's.
      for (let f = 0; f < 2; f++) c.feet[f].copy(vec(POINTS.pedals[f])).add(vec(PILOT.heel)).applyMatrix4(m);
      gripAt('collective', sticks, c.hands[0]).add(vec(PILOT.wristCollective)).applyMatrix4(m);
      gripAt('cyclic', sticks, c.hands[1]).add(vec(PILOT.wristCyclic)).applyMatrix4(m);
      c.head = look;
      c.knees = fit.knees + KNEE_BANK * bank;
    } else {
      // A passenger: the feet on the floor under the knees, the hands on the thighs, looking out.
      const P = PASSENGER;
      const y = hip.y - fit.drop + P.lap.up;
      c.feet[0].set(hip.x - P.spread, POINTS.floor + P.ankle, hip.z - P.ahead).applyMatrix4(m);
      c.feet[1].set(hip.x + P.spread, POINTS.floor + P.ankle, hip.z - P.ahead).applyMatrix4(m);
      c.hands[0].set(hip.x - P.lap.side, y, hip.z - P.lap.ahead).applyMatrix4(m);
      c.hands[1].set(hip.x + P.lap.side, y, hip.z - P.lap.ahead).applyMatrix4(m);
      c.head = fit.out + 0.15 * Math.sin(clock * 0.23 + i * 2.1);
    }
  }
}

/** A figure seated by this module (yours, the checks' dummies): no hit boxes, nothing a ray could hit, no shadow (the machine casts it). */
function strip(body: Body): Body {
  for (const h of body.hits) h.removeFromParent();
  body.hits.length = 0;
  body.root.traverse((o) => {
    o.userData.ignoreRay = true;
    o.castShadow = false;
  });
  body.root.visible = false;
  return body;
}

function drop(body: Body | null): void {
  if (!body) return;
  body.root.removeFromParent();
  body.dispose?.();
  if (!body.shared) body.root.traverse((o) => o instanceof THREE.Mesh && o.geometry.dispose());
}

/** Under the model's simple copy for far off. */
function farCopy(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.name === 'Far') return true;
  return false;
}

export class HeliPeople {
  /** Your own figure and the checks' dummies (the other players sit as their own figures, net/avatars.ts, through seat()) */
  readonly group = new THREE.Group();
  /** The hands follow the sticks' deflection (from the machine's lean and lever). Off while the model's sticks are drawn still (world/heli.ts STATIC). */
  sticksMove = false;
  private occupied = new Map<Heli, Occupied>();
  private own: Body | null = null;
  private ownColour = '';
  private ownSwat = false;
  /** The machine and seat your figure sits in this frame */
  private ownIn: { heli: Heli; seat: number } | null = null;
  private warm = false;
  private warmPlaces: Place[] = [0, 1, 2, 3].map(place);
  private pose: Pose = {
    speed: 0, forward: 0, side: 0, armed: false, alive: true, crouch: false, flying: false, pitch: 0, weapon: 'pistol',
    yaw: 0, air: 0, vy: 0, seat: 0, far: 0, car: null, bike: null,
  };

  private figure: (colour: string) => Body;

  /** `figure`: your figure in a colour, as the others see it (net/avatars.ts figure). */
  constructor(figure: (colour: string) => Body) {
    this.figure = figure;
  }

  /**
   * Every frame, after the machines are placed and before the others are posed (net/avatars.ts tick): each machine's
   * seats where its near model is drawn (its `seats`, the checks' dummies), your figure in yours (`mine`: the machine
   * you are in and your seat). Its far copy carries nobody.
   */
  update(dt: number, machines: readonly Heli[], mine: { heli: Heli; seat: number } | null, colour: string, camera: THREE.Camera): void {
    const eye = camera.position;
    for (const [heli, o] of this.occupied) {
      if (machines.includes(heli)) continue;
      for (const d of o.dummies) drop(d); // a machine taken away
      this.occupied.delete(heli);
    }
    let ownAt: Place | null = null;
    let ownFar = 0;
    let ownYaw = 0;
    for (const heli of machines) {
      let o = this.occupied.get(heli);
      const someone = heli.seats.some((n) => n !== null) || mine?.heli === heli || !!o?.dummies.some((d) => d);
      if (!someone) {
        if (o) this.occupied.delete(heli); // empty again
        continue;
      }
      const frame = heli.cabin(_m);
      if (!frame) {
        if (o) o.ok = false;
        continue;
      }
      const s = heli.s;
      o ??= { heli, ok: false, look: 0, yaw: s.yaw, clock: 0, places: [0, 1, 2, 3].map(place), dummies: [null, null, null, null] };
      this.occupied.set(heli, o);
      if (!o.ok) o.yaw = s.yaw;
      o.ok = true;
      // The pilot looks into the turn and where it flies (sideways, backwards a little).
      const turn = angle(s.yaw - o.yaw) / Math.max(dt, 1e-3);
      o.yaw = s.yaw;
      const speed = Math.hypot(s.vx, s.vz);
      const path = speed > 3 ? angle(Math.atan2(-s.vx, -s.vz) - s.yaw) : 0;
      const want = clamp(LOOK_TURN * turn + LOOK_PATH * Math.min(1, (speed - 3) / 7) * clamp(path, -1, 1), -LOOK_MAX, LOOK_MAX);
      o.look += (want - o.look) * (1 - Math.exp(-dt * LOOK_EASE));
      o.clock += dt;
      const sticks = this.sticksMove ? { fwd: s.pitch / TILT, side: s.roll / TILT, lift: s.coll } : STILL;
      seatPlaces(o.places, (i) => heli.seatPoint(i), frame, s.yaw, o.look, o.clock, sticks);
      const r = o.places[0].seat.root;
      const far = eye.distanceTo(_v.set(r.x, r.y, r.z));
      for (let i = 0; i < SEATS; i++) {
        const d = o.dummies[i];
        if (d) this.seatBody(d, o.places[i], s.yaw, far, dt);
      }
      if (mine?.heli === heli) {
        const i = clamp(Math.round(mine.seat), 0, SEATS - 1);
        ownAt = o.places[i];
        ownFar = far;
        ownYaw = s.yaw;
        this.ownIn = { heli, seat: i };
      }
    }
    for (const o of this.occupied.values()) {
      if (!o.ok) for (const d of o.dummies) if (d) d.root.visible = false;
    }

    // Your own figure: in your seat; behind the start screen in the pilot's pose in front of the camera (warming), so
    // it is made before the first boarding.
    if (!ownAt) this.ownIn = null;
    if (this.warm && !ownAt) {
      camera.getWorldDirection(_w).setY(0).normalize();
      const yaw = Math.atan2(_w.x, _w.z); // the nose (-z) towards the camera
      _m.makeRotationY(yaw).setPosition(_v.copy(eye).addScaledVector(_w, 4.5).add(_s.set(0, -1.7, 0)));
      const at = machines[0];
      seatPlaces(this.warmPlaces, (i) => at?.seatPoint(i) ?? WARM_SEAT, _m, yaw, 0, 0, STILL);
      ownAt = this.warmPlaces[0];
      ownFar = 4.5;
      ownYaw = yaw;
    }
    if (ownAt) {
      if (!this.own || colour !== this.ownColour || (!this.ownSwat && hasSwat())) this.build(colour);
      this.seatBody(this.own!, ownAt, ownYaw, ownFar, dt);
      // From the pilot's seat your figure isn't drawn: leant over the sticks, its shoulders would be in front of the eye.
      if (eye.distanceTo(ownAt.head) < TOO_CLOSE) this.own!.root.visible = false;
    } else if (this.own) this.own.root.visible = false;
  }

  /** Where a player sits in a machine drawn this frame (its `seats`, as the server says); null in none. */
  seat(name: string): Seat | null {
    if (!name) return null;
    for (const o of this.occupied.values()) {
      if (!o.ok) continue;
      const i = o.heli.seats.indexOf(name);
      if (i >= 0 && i < SEATS) return o.places[i].seat;
    }
    return null;
  }

  /** The warm-up frames behind the start screen (main.ts): your figure made and drawn seated once, so it is not new in play. */
  warming(on: boolean): void {
    this.warm = on;
  }

  /** For the checks and pictures: a figure without a player in seat `seat` (0 the pilot's to 3) of `heli` in `colour`, or none (null). */
  dummy(heli: Heli, seat: number, colour: string | null): void {
    if (!(seat >= 0 && seat < SEATS)) return;
    let o = this.occupied.get(heli);
    if (!o) {
      if (colour === null) return;
      o = { heli, ok: false, look: 0, yaw: heli.s.yaw, clock: 0, places: [0, 1, 2, 3].map(place), dummies: [null, null, null, null] };
      this.occupied.set(heli, o);
    }
    drop(o.dummies[seat]);
    o.dummies[seat] = colour === null ? null : strip(this.figure(colour));
    if (o.dummies[seat]) this.group.add(o.dummies[seat]!.root);
  }

  /**
   * For the checks: how each figure seated here by this module (yours, the dummies) fits machine `heli`, in the model's
   * frame. Of every fifth vertex of the figure: `pokes`, those a ray up or a ray out to its nearer side doesn't find the
   * model from (through the roof, the glass or a door); `inside`, those inside the cabin's fittings (the seats, the
   * panel: their faces seen from within in all six directions) and how deep the deepest is. `headRoom`: from the
   * figure's top to what is over it. `wristGap`, `ankleGap`: how far each hand and foot is from where it should be.
   * `neighbour`: the nearest vertex of another figure aboard; `stick`: of the cyclic's shaft below its grip (the legs'
   * part of it), the nearest vertex. The figure's own arm and leg lengths. `seat`: that seat's figure only;
   * `rays: false`: the hands, feet and bones only (quick).
   */
  report(heli: Heli, { seat, rays = true }: { seat?: number; rays?: boolean } = {}): Record<string, unknown>[] {
    const o = this.occupied.get(heli);
    const frame = heli.cabin(new THREE.Matrix4());
    if (!o || !o.ok || !frame) return [];
    const inv = frame.clone().invert();
    const axis = (n: number) => new THREE.Vector3().setFromMatrixColumn(frame, n).normalize();
    const [right, up, back] = [axis(0), axis(1), axis(2)];
    heli.group.updateWorldMatrix(true, true);
    const solid = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const shell: THREE.Mesh[] = [];
    const fittings: THREE.Mesh[] = [];
    heli.group.traverse((m) => {
      if (!(m instanceof THREE.Mesh) || m instanceof THREE.InstancedMesh || !m.userData.part || !m.visible || farCopy(m)) return;
      if (m.userData.part === 'RotorBlur' || !m.geometry.getAttribute('position')) return;
      const copy = new THREE.Mesh(m.geometry, solid);
      copy.matrixAutoUpdate = false;
      copy.matrixWorld.copy(m.matrixWorld);
      shell.push(copy);
      if (m.userData.part === 'Interior' || m.userData.part === 'Screen') fittings.push(copy);
    });
    const ray = new THREE.Raycaster();
    ray.far = 4;
    const first = (from: THREE.Vector3, dir: THREE.Vector3, list: THREE.Mesh[]) => {
      ray.set(from, dir);
      return ray.intersectObjects(list, false)[0] ?? null;
    };
    const six = [right, up, back].flatMap((a) => [a, a.clone().negate()]);
    const nm = new THREE.Matrix3();
    const n = new THREE.Vector3();
    /** How deep inside the fittings a point is (null: not inside): every one of six rays meets a face from behind first */
    const depth = (v: THREE.Vector3): number | null => {
      let d = Infinity;
      for (const dir of six) {
        const hit = first(v, dir, fittings);
        if (!hit?.face) return null;
        n.copy(hit.face.normal).applyMatrix3(nm.getNormalMatrix(hit.object.matrixWorld)).normalize();
        if (n.dot(dir) <= 0) return null;
        d = Math.min(d, hit.distance);
      }
      return d;
    };
    const local = (v: THREE.Vector3) => v.clone().applyMatrix4(inv);
    const mm = (k: number) => Math.round(k * 1000) / 1000;
    const r3 = (v: THREE.Vector3) => [v.x, v.y, v.z].map(mm);
    const figures: [Body, number][] = [];
    if (this.own?.root.visible && this.ownIn?.heli === heli) figures.push([this.own, this.ownIn.seat]);
    o.dummies.forEach((d, i) => d && figures.push([d, i]));
    // Every fifth vertex of each figure, in the world.
    const points = new Map<Body, THREE.Vector3[]>();
    for (const [body] of figures) {
      body.root.updateMatrixWorld(true);
      const list: THREE.Vector3[] = [];
      body.root.traverse((m) => {
        if (!(m instanceof THREE.SkinnedMesh) || !m.visible) return;
        m.skeleton.update();
        const count = m.geometry.attributes.position.count;
        for (let k = 0; k < count; k += 5) list.push(m.getVertexPosition(k, new THREE.Vector3()).applyMatrix4(m.matrixWorld));
      });
      points.set(body, list);
    }
    const pivot = vec(POINTS.pivotCyclic);
    const grip = vec(POINTS.gripCyclic);
    const shaft = new THREE.Line3(pivot.clone().applyMatrix4(frame), pivot.lerp(grip, 0.75).applyMatrix4(frame)); // its lower three quarters: the fist is round the top
    const res: Record<string, unknown>[] = [];
    for (const [body, i] of figures) {
      if (seat !== undefined && i !== seat) continue;
      const bone = (name: string) => body.root.getObjectByName(name)!.getWorldPosition(new THREE.Vector3());
      const c = o.places[i].seat.car;
      let pokes = 0;
      let inside = 0;
      let deepest = 0;
      const where: number[][] = [];
      const within: number[][] = [];
      let top = -Infinity;
      let headRoom: number | null = null;
      let neighbour = Infinity;
      let stick = Infinity;
      let stickAt: number[] | null = null;
      const list = points.get(body)!;
      const others = figures.filter(([b]) => b !== body).flatMap(([b]) => points.get(b)!);
      const near = new THREE.Vector3();
      for (const v of rays ? list : []) {
        const l = local(v);
        const above = first(v, up, shell);
        const aside = first(v, l.x < 0 ? right.clone().negate() : right, shell);
        if (!above || !aside) {
          pokes++;
          if (where.length < 8) where.push(r3(l));
        }
        const d = depth(v);
        if (d !== null) {
          inside++;
          deepest = Math.max(deepest, d);
          if (within.length < 8) within.push(r3(l));
        }
        if (l.y > top) {
          top = l.y;
          headRoom = above?.distance ?? null;
        }
        for (const w of others) neighbour = Math.min(neighbour, v.distanceToSquared(w));
        const gap = i === 0 ? shaft.closestPointToPoint(v, true, near).distanceTo(v) : Infinity;
        if (gap < stick) {
          stick = gap;
          stickAt = r3(l);
        }
      }
      const arm = (s: string) => bone(`UpperArm${s}`).distanceTo(bone(`LowerArm${s}`)) + bone(`LowerArm${s}`).distanceTo(bone(`Wrist${s}`));
      const leg = (s: string) => bone(`UpperLeg${s}`).distanceTo(bone(`LowerLeg${s}`)) + bone(`LowerLeg${s}`).distanceTo(bone(`LowerLeg${s}_end`));
      res.push({
        seat: i, checked: rays ? list.length : 0, pokes, where, inside, deepest: mm(deepest), within, top: rays ? mm(top) : null, headRoom: headRoom === null ? null : mm(headRoom),
        neighbour: rays && others.length ? mm(Math.sqrt(neighbour)) : null, stick: rays && i === 0 ? mm(stick) : null, stickAt,
        wristGap: [bone('WristL').distanceTo(c.hands[0]), bone('WristR').distanceTo(c.hands[1])].map(mm),
        ankleGap: [bone('LowerLegL_end').distanceTo(c.feet[0]), bone('LowerLegR_end').distanceTo(c.feet[1])].map(mm),
        arm: mm(arm('L')), leg: mm(leg('L')),
        hips: r3(local(bone('Body'))), head: r3(local(bone('Head'))), shoulders: [r3(local(bone('UpperArmL'))), r3(local(bone('UpperArmR')))], hipJoints: [r3(local(bone('UpperLegL'))), r3(local(bone('UpperLegR')))],
        wrists: [r3(local(bone('WristL'))), r3(local(bone('WristR')))], hands: [r3(local(c.hands[0].clone())), r3(local(c.hands[1].clone()))],
        feet: [r3(local(c.feet[0].clone())), r3(local(c.feet[1].clone()))], look: mm(c.head),
      });
    }
    solid.dispose();
    return res;
  }

  /** Pose a figure in its seat (`yaw`: the machine's heading). */
  private seatBody(body: Body, at: Place, yaw: number, far: number, dt: number): void {
    const s = at.seat;
    body.root.position.set(s.root.x, s.root.y, s.root.z);
    body.root.quaternion.copy(s.quat);
    body.root.visible = true;
    const p = this.pose;
    p.yaw = p.seat = yaw;
    p.pitch = s.pitch ?? 0;
    p.far = far;
    p.car = s.car;
    p.bike = s.bike ?? null;
    body.animate(dt, p);
  }

  /** Your figure in your colour (made again when it changes, or the figure's model came in after it was made). */
  private build(colour: string): void {
    drop(this.own);
    this.own = strip(this.figure(colour));
    this.ownColour = colour;
    this.ownSwat = hasSwat();
    this.group.add(this.own.root);
  }
}
