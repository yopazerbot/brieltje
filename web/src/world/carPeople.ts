/** The people in the Teslas: the driver and the passenger seated in their car as it is drawn (you among them). */
import * as THREE from 'three';
import type { Car } from './car';
import type { Seat } from '../net/avatars';
import { SEAT_HIP, hasSwat, type Body, type Pose } from '../net/swat';

/**
 * Where the people sit in each model, in the model's own frame (Car.cabin: x to the car's right, y up from the ground,
 * z to the back, m). The seat's point is where the hips go (the figure's root SEAT_HIP under it, as on a horse), leaning
 * back by `recline` about it; the ankles on the floor under the dash, `spread` either side of the seat's middle; the
 * steering wheel's hub and rim. The driver's wrists go `short` behind the rim, `grip` rad below nine and three o'clock.
 * The cabins were built to be looked at (their wheels are further off than an arm): see the fit in DECISIONS.md.
 */
interface Cabin {
  seat: { y: number; z: number; recline: number };
  ankle: { y: number; z: number; spread: number };
  hub: THREE.Vector3;
  rim: number;
  grip: number;
  short: number;
  /** The passenger's wrists over the thighs: from the seat's point, up and forward (m); the figure's arms are short */
  lap: { up: number; ahead: number };
}
const CABINS: Record<string, Cabin> = {
  '/models/model-y.glb': { seat: { y: 0.53, z: 0, recline: 0.15 }, ankle: { y: 0.45, z: -0.76, spread: 0.12 }, hub: new THREE.Vector3(-0.37, 0.905, -0.375), rim: 0.185, grip: 0, short: 0.06, lap: { up: 0.24, ahead: 0.08 } },
  '/models/model-3.glb': { seat: { y: 0.38, z: 0.1, recline: 0.3 }, ankle: { y: 0.39, z: -0.66, spread: 0.12 }, hub: new THREE.Vector3(-0.37, 0.86, -0.26), rim: 0.18, grip: 0, short: 0.06, lap: { up: 0.26, ahead: 0.05 } },
};
/** m from the car's middle to each seat's (the driver on the left) */
const SEAT_X = 0.37;
/** The wheel's plane (both models): its up, and its face towards the driver. */
const WHEEL_UP = new THREE.Vector3(0, 0.914, -0.407);
const WHEEL_BACK = new THREE.Vector3(0, 0.407, 0.914);
/** rad the hands go round the rim at full lock (35 degrees), the heads turn (10 degrees), and how fast the heads follow (1/s) */
const HAND_TURN = 0.6;
const HEAD_TURN = 0.17;
const HEAD_EASE = 6;
/** m from the seat's middle to each knee: the driver's outside the rim, the passenger's closer */
const KNEES = [0.26, 0.14];
/** m from the passenger's seat's middle to each wrist, over the thighs */
const LAP_SIDE = 0.12;
/** Closer than this to your own figure's head (m), the camera (pushed in by a wall) would be inside it: not drawn. */
const TOO_CLOSE = 1;

type SeatCar = NonNullable<Seat['car']>;
type CarSeat = Seat & { root: { x: number; y: number; z: number }; quat: THREE.Quaternion; car: SeatCar };
interface Place {
  seat: CarSeat;
  /** About where the head is, in the world */
  head: THREE.Vector3;
}
interface Occupied {
  car: Car;
  cabin: Cabin;
  /** Its seats worked out this frame (its full model shows) */
  ok: boolean;
  /** The heads' turn, eased */
  look: number;
  places: [Place, Place];
  /** Figures without a player, for the checks */
  dummies: [Body | null, Body | null];
}

const X_AXIS = new THREE.Vector3(1, 0, 0);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _tilt = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

function place(i: number): Place {
  return {
    seat: {
      x: 0, y: 0, z: 0, yaw: 0, pitch: 0, root: { x: 0, y: 0, z: 0 }, quat: new THREE.Quaternion(),
      car: { feet: [new THREE.Vector3(), new THREE.Vector3()], hands: [new THREE.Vector3(), new THREE.Vector3()], head: 0, knees: KNEES[i] },
    },
    head: new THREE.Vector3(),
  };
}

/** Under the model's simple copy for far off. */
function farCopy(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.name === 'Far') return true;
  return false;
}

/** Both seats of a cabin drawn in frame `m` (the model's frame in the world), the wheel turned by `turn`, the heads by `look`. */
function seatPlaces(places: [Place, Place], cabin: Cabin, m: THREE.Matrix4, yaw: number, turn: number, look: number): void {
  m.decompose(_p, _q, _s);
  const { seat: s, ankle: a } = cabin;
  _tilt.setFromAxisAngle(X_AXIS, s.recline); // leaning back: the head goes to the back (+z)
  for (let i = 0; i < 2; i++) {
    const { seat, head } = places[i];
    const x = i ? SEAT_X : -SEAT_X;
    _w.set(x, s.y, s.z);
    _v.copy(_w).applyMatrix4(m);
    seat.x = _v.x;
    seat.y = _v.y;
    seat.z = _v.z;
    _v.set(0, -SEAT_HIP, 0).applyQuaternion(_tilt).add(_w).applyMatrix4(m);
    seat.root.x = _v.x;
    seat.root.y = _v.y;
    seat.root.z = _v.z;
    seat.quat.copy(_q).multiply(_tilt);
    seat.yaw = yaw - Math.PI;
    seat.pitch = -s.recline; // the head nods forward again
    head.set(0, 0.75, 0).applyQuaternion(_tilt).add(_w).applyMatrix4(m);
    const c = seat.car;
    c.feet[0].set(x - a.spread, a.y, a.z).applyMatrix4(m);
    c.feet[1].set(x + a.spread, a.y, a.z).applyMatrix4(m);
    c.head = look;
    if (i === 0) {
      // The driver's wrists just behind the rim at nine and three o'clock, going round it with the wheel.
      for (let h = 0; h < 2; h++) {
        const at = (h ? -cabin.grip : Math.PI + cabin.grip) + HAND_TURN * turn;
        c.hands[h].copy(cabin.hub).addScaledVector(X_AXIS, cabin.rim * Math.cos(at)).addScaledVector(WHEEL_UP, cabin.rim * Math.sin(at)).addScaledVector(WHEEL_BACK, cabin.short).applyMatrix4(m);
      }
    } else {
      // The passenger's on the lap.
      c.hands[0].set(x - LAP_SIDE, s.y + cabin.lap.up, s.z - cabin.lap.ahead).applyMatrix4(m);
      c.hands[1].set(x + LAP_SIDE, s.y + cabin.lap.up, s.z - cabin.lap.ahead).applyMatrix4(m);
    }
  }
}

/** A figure seated by this module (yours, the checks' dummies): no hit boxes, nothing a ray could hit, no shadow (the car casts it). */
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

export class CarPeople {
  /** Your own figure and the checks' dummies (the other players sit as their own figures, net/avatars.ts, through seat()) */
  readonly group = new THREE.Group();
  private occupied = new Map<Car, Occupied>();
  private own: Body | null = null;
  private ownColour = '';
  private ownSwat = false;
  /** The car and seat your figure sits in this frame */
  private ownIn: { car: Car; seat: number } | null = null;
  private warm = false;
  private warmPlaces: [Place, Place] = [place(0), place(1)];
  private pose: Pose = {
    speed: 0, forward: 0, side: 0, armed: false, alive: true, crouch: false, flying: false, pitch: 0, weapon: 'pistol',
    yaw: 0, air: 0, vy: 0, seat: 0, far: 0, car: null,
  };

  /** `figure`: your figure in a colour, as the others see it (net/avatars.ts figure). */
  constructor(private figure: (colour: string) => Body) {}

  /**
   * Every frame, after the cars are placed and before the others are posed (net/avatars.ts tick): each car's seats where
   * its full model is drawn, your figure in yours (`mine`: the car you are in, and whether in the passenger seat).
   */
  update(dt: number, cars: readonly Car[], mine: { car: Car; passenger: boolean } | null, colour: string, camera: THREE.Camera): void {
    const eye = camera.position;
    for (const [car, o] of this.occupied) {
      if (cars.includes(car)) continue;
      for (const d of o.dummies) drop(d); // a placed Tesla taken away
      this.occupied.delete(car);
    }
    let ownAt: Place | null = null;
    let ownFar = 0;
    for (const car of cars) {
      const cabin = CABINS[car.spec.model];
      if (!cabin) continue;
      let o = this.occupied.get(car);
      const someone = !!car.driver || !!car.passenger || mine?.car === car || !!o?.dummies.some((d) => d);
      if (!o && !someone) continue;
      const frame = car.cabin(_m);
      if (!frame) {
        if (o) o.ok = false;
        continue;
      }
      o ??= { car, cabin, ok: false, look: 0, places: [place(0), place(1)], dummies: [null, null] };
      this.occupied.set(car, o);
      o.ok = true;
      o.look += (HEAD_TURN * car.wheelTurn - o.look) * (1 - Math.exp(-dt * HEAD_EASE));
      seatPlaces(o.places, cabin, frame, car.yaw, car.wheelTurn, o.look);
      const r = o.places[0].seat.root;
      const far = eye.distanceTo(_v.set(r.x, r.y, r.z));
      for (let i = 0; i < 2; i++) {
        const d = o.dummies[i];
        if (d) this.seatBody(d, o.places[i], car.yaw, far, dt);
      }
      if (mine?.car === car) {
        ownAt = o.places[mine.passenger ? 1 : 0];
        ownFar = far;
        this.ownIn = { car, seat: mine.passenger ? 1 : 0 };
      }
      if (!someone) this.occupied.delete(car); // empty again
    }
    for (const o of this.occupied.values()) {
      if (!o.ok) for (const d of o.dummies) if (d) d.root.visible = false;
    }

    // Your own figure: in your seat; behind the start screen in the air in front of the camera (warming).
    if (!ownAt) this.ownIn = null;
    if (this.warm && !ownAt) {
      camera.getWorldDirection(_w).setY(0).normalize();
      const yaw = Math.atan2(_w.x, _w.z); // facing the camera
      _m.makeRotationY(yaw).setPosition(_v.copy(eye).addScaledVector(_w, 4).add(_s.set(0, -1.2, 0)));
      const cabin = CABINS['/models/model-y.glb'];
      seatPlaces(this.warmPlaces, cabin, _m, yaw, 0, 0);
      ownAt = this.warmPlaces[0];
      ownFar = 4;
    }
    if (ownAt) {
      if (!this.own || colour !== this.ownColour || (!this.ownSwat && hasSwat())) this.build(colour);
      this.seatBody(this.own!, ownAt, ownAt.seat.yaw + Math.PI, ownFar, dt);
      if (eye.distanceTo(ownAt.head) < TOO_CLOSE) this.own!.root.visible = false;
    } else if (this.own) this.own.root.visible = false;
  }

  /** Where a player sits in a car drawn this frame (its `driver` or `passenger`, as the server says); null in none. */
  seat(name: string): Seat | null {
    for (const o of this.occupied.values()) {
      if (!o.ok) continue;
      if (o.car.driver === name) return o.places[0].seat;
      if (o.car.passenger === name) return o.places[1].seat;
    }
    return null;
  }

  /** The warm-up frames behind the start screen (main.ts): your figure seated and drawn once, so it is not new in play. */
  warming(on: boolean): void {
    this.warm = on;
  }

  /** For the checks: a figure without a player in a car's seat (0 the driver's, 1 the passenger's) in `colour`, or none (null). */
  dummy(car: Car, seat: 0 | 1, colour: string | null): void {
    let o = this.occupied.get(car);
    const cabin = CABINS[car.spec.model];
    if (!cabin) return;
    if (!o) {
      if (colour === null) return;
      o = { car, cabin, ok: false, look: 0, places: [place(0), place(1)], dummies: [null, null] };
      this.occupied.set(car, o);
    }
    drop(o.dummies[seat]);
    o.dummies[seat] = colour === null ? null : strip(this.figure(colour));
    if (o.dummies[seat]) this.group.add(o.dummies[seat]!.root);
  }

  /**
   * For the checks: how each figure seated here by this module (yours, the dummies) fits car `car`. `pokes`: of every fifth
   * vertex of the figure, those a ray up or a ray out to its nearer side doesn't find the car's model from (through the
   * roof, the glass or a door). `headRoom`: from the figure's top to what is over it. `wristGap`, `ankleGap`: how far each
   * hand and foot is from where it should be. The figure's own arm and leg lengths; the hips and the targets in the car's frame.
   */
  report(car: Car): Record<string, unknown>[] {
    const o = this.occupied.get(car);
    const frame = car.cabin(new THREE.Matrix4());
    if (!o || !o.ok || !frame) return [];
    const inv = frame.clone().invert();
    const up = new THREE.Vector3().setFromMatrixColumn(frame, 1).normalize();
    const out = new THREE.Vector3().setFromMatrixColumn(frame, 0).normalize();
    // The car's full model, both faces of every triangle, for the rays.
    car.group.updateWorldMatrix(true, true);
    const solid = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const shell: THREE.Mesh[] = [];
    car.group.traverse((m) => {
      if (!(m instanceof THREE.Mesh) || !m.userData.part || farCopy(m)) return;
      const copy = new THREE.Mesh(m.geometry, solid);
      copy.matrixAutoUpdate = false;
      copy.matrixWorld.copy(m.matrixWorld);
      shell.push(copy);
    });
    const ray = new THREE.Raycaster();
    ray.far = 3;
    const first = (from: THREE.Vector3, dir: THREE.Vector3) => {
      ray.set(from, dir);
      return ray.intersectObjects(shell, false)[0]?.distance ?? null;
    };
    const local = (v: THREE.Vector3) => v.clone().applyMatrix4(inv);
    const r3 = (v: THREE.Vector3) => [v.x, v.y, v.z].map((n) => Math.round(n * 1000) / 1000);
    const figures: [Body, number][] = [];
    if (this.own?.root.visible && this.ownIn?.car === car) figures.push([this.own, this.ownIn.seat]);
    o.dummies.forEach((d, i) => d && figures.push([d, i]));
    const res: Record<string, unknown>[] = [];
    for (const [body, i] of figures) {
      body.root.updateMatrixWorld(true);
      const bone = (n: string) => body.root.getObjectByName(n)!.getWorldPosition(new THREE.Vector3());
      let pokes = 0;
      let checked = 0;
      const where: number[][] = [];
      let top = -Infinity;
      let headRoom: number | null = null;
      const v = new THREE.Vector3();
      body.root.traverse((m) => {
        if (!(m instanceof THREE.SkinnedMesh)) return;
        m.skeleton.update();
        const n = m.geometry.attributes.position.count;
        for (let k = 0; k < n; k += 5) {
          m.getVertexPosition(k, v).applyMatrix4(m.matrixWorld);
          const l = local(v);
          const above = first(v, up);
          const aside = first(v, out.clone().multiplyScalar(l.x < 0 ? -1 : 1));
          checked++;
          if (above === null || aside === null) {
            pokes++;
            if (where.length < 8) where.push(r3(l));
          }
          if (l.y > top) {
            top = l.y;
            headRoom = above;
          }
        }
      });
      const c = o.places[i].seat.car;
      const arm = (s: string) => bone(`UpperArm${s}`).distanceTo(bone(`LowerArm${s}`)) + bone(`LowerArm${s}`).distanceTo(bone(`Wrist${s}`));
      const leg = (s: string) => bone(`UpperLeg${s}`).distanceTo(bone(`LowerLeg${s}`)) + bone(`LowerLeg${s}`).distanceTo(bone(`LowerLeg${s}_end`));
      res.push({
        seat: i, checked, pokes, where, top: Math.round(top * 1000) / 1000, headRoom: headRoom === null ? null : Math.round(headRoom * 1000) / 1000,
        wristGap: [bone('WristL').distanceTo(c.hands[0]), bone('WristR').distanceTo(c.hands[1])].map((n) => Math.round(n * 1000) / 1000),
        ankleGap: [bone('LowerLegL_end').distanceTo(c.feet[0]), bone('LowerLegR_end').distanceTo(c.feet[1])].map((n) => Math.round(n * 1000) / 1000),
        arm: Math.round(arm('L') * 1000) / 1000, leg: Math.round(leg('L') * 1000) / 1000,
        hips: r3(local(bone('Body'))), head: r3(local(bone('Head'))), shoulder: r3(local(bone('UpperArmL'))),
        wrists: [r3(local(bone('WristL'))), r3(local(bone('WristR')))], hands: [r3(local(c.hands[0].clone())), r3(local(c.hands[1].clone()))],
        look: Math.round(c.head * 1000) / 1000,
      });
    }
    solid.dispose();
    return res;
  }

  /** Pose a figure in its seat. */
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
