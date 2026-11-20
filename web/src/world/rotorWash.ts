import * as THREE from 'three';
import HELIS from '../../shared/heli.json';
import type { World } from './collision';
import type { LooseProps } from './looseProps';
import { mood } from './mood';
import type { Particles, Spawn } from './particles';
import type { Splashes } from './splashes';
import { PARTICLE } from './sprites';
import { WashDust, type WashGround } from './washDust';
import { DISCS, washUniforms } from './washShader';
import { waterLevel } from './water';
import { wind } from './wind';

/**
 * The rotor's wash under each flying helicopter (world/heli.ts), on the page: everyone sees it from the machine's pose
 * they already get, nothing on the wire. As big games sell it, so that from 30 m a machine pressing air down is
 * unmistakable: the air the rotor throws down spreads out along the ground as a ring (strongest about a rotor's radius
 * out from under the hub, gone at three). On gravel, earth (a ploughed field) and dry paving a dense ring of dust,
 * coloured by the ground, rolls outward from under the disc and curls up at its edge, thickest at a low hover (the
 * skids half hidden at 2 m), and lingers, drifting with the wind, after the machine has gone; on grass no brown dust but
 * a low sheet of pale chaff, clippings and leaves racing out, a light haze, and the pressed grass shimmering in a disc;
 * on wet ground and in the rain a ring of white spray; on snow a white cloud; on water rings, chop and spray (all these:
 * world/washDust.ts, and the shared splashes). In the rain the drops are driven outward under it; tree crowns near it
 * shake, loose bins and chairs rock or roll (world/looseProps.ts).
 *
 * How hard: from the rotor's thrust (shared/heli.mjs: the lever, the rotor's speed) and its height over the ground or
 * the water below: full on the ground at a hover's thrust, about two thirds at 12 m, nothing by 30 m. In fast flight
 * the wash is blown back and spreads thin. Eased in and out, so the dust builds as it comes down and clears as it
 * settles and the rotor runs down.
 *
 * The shaders read one small set of uniforms (world/washShader.ts, two discs: the two machines nearest the eye): the
 * grass blades, the bank plants, the undergrowth, the water, the rain and the tree crowns, each a few sums per vertex
 * (per pixel for the water, and only inside a disc). Low and phones: the cloud and the bits, fewer and smaller (a
 * landing must read there too), and the grass's sheen; the shaders' discs stay empty, no pushes on loose things.
 */

/** The main rotor's radius (m), shared/heli.json */
const R = 5.2;
/** m/s: the wash's wall jet along the ground at its strongest (a light twin at a hover: about twice the rotor's own downwash of some 10 m/s) */
const JET = 18;
/** The wash's strength on the ground (0 to about 1.2) for a machine `height` m over the ground or water (its skids), `thrust` in g, `speed` m/s. */
export function washStrength(height: number, thrust: number, speed = 0): number {
  const h = Math.max(0, height);
  const t = Math.min(1, Math.max(0, (h - 2) / 26));
  const fade = 1 - t * t * (3 - 2 * t);
  const fast = Math.min(1, Math.max(0, (speed - 8) / 22));
  return Math.max(0, Math.min(1.3, thrust)) * fade * (1 - 0.6 * fast);
}

/** The strength in the tree crowns: they stand taller, so it reaches them from higher up. */
export function crownStrength(height: number, thrust: number): number {
  const t = Math.min(1, Math.max(0, (height - 6) / 40));
  return Math.max(0, Math.min(1.3, thrust)) * (1 - t * t * (3 - 2 * t));
}

/** The wash's reach on the ground (m from under the hub): about three rotor radii, wider the higher it is. */
export function washRadius(height: number): number {
  return 3 * R + 0.45 * Math.max(0, height);
}

/** The wind along the ground `r` m out from under the hub (m/s), at strength `w` within `radius`. */
export function washWind(r: number, w: number, radius: number): number {
  const x = r / radius;
  if (x >= 1) return 0;
  const rise = Math.min(1, x / 0.2);
  const fall = x < 0.4 ? 1 : 1 - ((x - 0.4) / 0.6) ** 1.5;
  return JET * w * rise * fall;
}

const discs = washUniforms.washDisc.value;
const aux = washUniforms.washAux.value;

/** What the wash needs of a machine (world/heli.ts Heli). */
export interface WashMachine {
  readonly s: { x: number; y: number; z: number; vx: number; vz: number; rotor: number; thrust: number; ground: boolean; floor: number };
  readonly group: THREE.Object3D;
  ready: boolean;
  taken: boolean;
}

/** m: round a pad on the ground (shared/heli.json) its own mown meadow, whatever block lies under it */
const PAD_MEADOW = 22;
const PADS = HELIS.pads.map((p) => [p.x, p.z] as const);
const PAVING = /road|pav|concrete|terrace|stone|tile|cobble|sett|asphalt|street|yard|square/i;
/**
 * The ground's kind at (x, z) from its material: no material is the gardens' and meadows' grass; a field's block is
 * ploughed earth in November (field_soil, field_dark) or a green crop (field_crop), except round a pad, where the
 * meadow by the house is a field's block under its mown grass.
 */
export function groundKind(mat: string | undefined, x = Infinity, z = Infinity): WashGround {
  if (!mat) return 'grass';
  if (/^field/i.test(mat)) {
    if (/crop/i.test(mat) || PADS.some(([px, pz]) => Math.hypot(x - px, z - pz) < PAD_MEADOW)) return 'grass';
    return 'earth';
  }
  if (/gravel|sand|track/i.test(mat)) return 'gravel';
  if (/earth|soil|mud|forest|leaves/i.test(mat)) return 'earth';
  if (/grass|lawn|meadow|moss|hedge/i.test(mat)) return 'grass';
  if (PAVING.test(mat)) return 'paving';
  return 'bare'; // a roof, a steel deck: nothing to blow but the rain on it
}

const DROP = new THREE.Color('#dfe7e8');

interface Live {
  /** The strength eased (dust builds and clears) */
  w: number;
  acc: { cloud: number; bits: number };
  drops: number;
  ring: number;
  /** The ground under it, looked at a few times a second */
  look: number;
  kind: WashGround;
  surface: number;
}

export class RotorWash {
  /** Medium and up, not a phone: the shaders' discs, the spray's drops, the pushes on loose things */
  private fine = true;
  private live = new Map<WashMachine, Live>();
  private s: Spawn = {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size0: 0.1, size1: 0.1,
    c0: new THREE.Color(), c1: new THREE.Color(), alpha: 1, cell: 0, drag: 0, gravity: 0, spin: 0, stretch: 0,
  };
  private pick: { m: WashMachine; d: number; w: number; tree: number; radius: number; x: number; z: number; hub: number; kind: WashGround; surface: number }[] = [];
  private time = 0;
  /** The dust, the bits and the grass's sheen (world/washDust.ts) */
  readonly dust = new WashDust();
  private ground = { y: 0, kind: 'grass' as WashGround };
  private sample = (x: number, z: number) => {
    const g = this.world.groundAt(x, z, this.top, 0);
    const level = waterLevel(x, z);
    this.ground.y = level !== null && level > g.y ? level : g.y;
    this.ground.kind = level !== null && level > g.y ? 'water' : groundKind(g.mat, x, z);
    if (mood.snow > 0.25 && this.ground.kind !== 'water' && this.ground.kind !== 'bare') this.ground.kind = 'snow';
    return this.ground;
  };
  private top = 0;

  constructor(scene: THREE.Object3D, private world: World, private particles: Particles, private splashes: Splashes, private props: LooseProps | null = null) {
    scene.add(this.dust.group);
  }

  /** Dev build: each machine's eased strength, its ground, the discs as the shaders have them, and what is in the air. */
  state(): { machines: { w: number; kind: string; surface: number }[]; discs: number[][]; dust: { sprites: number; bits: number } } {
    return {
      machines: [...this.live.values()].map((l) => ({ w: l.w, kind: l.kind, surface: l.surface })),
      discs: discs.map((d, i) => [d.x, d.y, d.z, d.w, aux[i].x, aux[i].y]),
      dust: this.dust.counts,
    };
  }

  /** Every frame, after the machines have moved (main.ts, after helis.update); `fine` false on Low and phones. */
  update(dt: number, machines: Iterable<WashMachine>, eye: THREE.Vector3, fine = true): void {
    this.fine = fine;
    this.dust.low = !fine;
    this.time = (this.time + Math.max(0, dt)) % 1000;
    washUniforms.washTime.value = this.time;
    const pick = this.pick;
    pick.length = 0;
    const seen = new Set<WashMachine>();
    for (const m of machines) {
      const s = m.s;
      const shown = m.ready && !m.taken && m.group.visible;
      let l = this.live.get(m);
      if (!shown || s.rotor < 0.2) {
        if (l) this.live.delete(m);
        continue;
      }
      seen.add(m);
      if (!l) {
        l = { w: 0, acc: { cloud: 0, bits: 0 }, drops: 0, ring: 0, look: 0, kind: 'grass', surface: s.floor };
        this.live.set(m, l);
      }
      // The ground or the water under the hub, and what it is (a few times a second: it is the same from frame to frame).
      this.top = s.y + 0.5;
      l.look -= dt;
      if (l.look <= 0) {
        l.look = 0.2;
        const g = this.sample(s.x, s.z);
        l.surface = g.y;
        l.kind = g.kind;
      }
      const height = s.y - l.surface;
      const speed = Math.hypot(s.vx, s.vz);
      const thrust = s.thrust > 0.02 ? s.thrust : s.ground ? 0.3 * s.rotor * s.rotor : 1;
      const want = washStrength(height, thrust * s.rotor * s.rotor, speed);
      l.w += (want - l.w) * (1 - Math.exp(-Math.max(0, dt) * 2.5));
      const d = Math.hypot(s.x - eye.x, s.z - eye.z, s.y - eye.y);
      const radius = washRadius(height);
      // Blown back a little in forward flight, low down.
      const back = Math.min(radius * 0.4, 0.06 * Math.max(0, height) * speed * 0.2);
      const cx = s.x - (speed > 0.1 ? (s.vx / speed) * back : 0);
      const cz = s.z - (speed > 0.1 ? (s.vz / speed) * back : 0);
      if (l.w > 0.01) this.throwUp(m, l, cx, cz, radius, height, d, dt);
      if (this.fine && this.props && l.w > 0.05 && d < 120) this.props.wash(cx, cz, l.surface, radius, l.w, JET, dt);
      pick.push({ m, d, w: l.w, tree: crownStrength(height, thrust * s.rotor * s.rotor), radius, x: cx, z: cz, hub: s.y + 3.2, kind: l.kind, surface: l.surface });
    }
    for (const m of this.live.keys()) if (!seen.has(m)) this.live.delete(m);
    // The shaders' discs and the grass's sheen: the two nearest the eye with any wash, within 150 m.
    pick.sort((a, b) => a.d - b.d);
    let n = 0;
    let sheens = 0;
    for (const p of pick) {
      if (p.d > 150 || (p.w < 0.02 && p.tree < 0.02)) continue;
      if (sheens < 2 && p.kind === 'grass' && mood.wet < 0.35) this.dust.sheen(sheens++, p.x, p.surface, p.z, p.radius, p.w);
      if (!this.fine || n >= DISCS) continue;
      discs[n].set(p.x, p.z, p.radius, p.w > 0.02 ? p.w : 0);
      aux[n].set(p.hub, p.tree, 0, 0);
      n++;
    }
    for (; sheens < 2; sheens++) this.dust.sheen(sheens, 0, 0, 0, 1, 0);
    for (; n < DISCS; n++) {
      discs[n].set(0, 0, 1, 0);
      aux[n].set(0, 0, 0, 0);
    }
    this.dust.update(dt, eye, this.time);
  }

  /** What it throws up: the cloud and the bits (world/washDust.ts), and on water the drops and rings. */
  private throwUp(m: WashMachine, l: Live, cx: number, cz: number, radius: number, height: number, d: number, dt: number): void {
    // Fewer far off (they are small there), none past 320 m.
    const far = Math.max(0, Math.min(1, 1.6 - d / 200));
    if (far <= 0) return;
    const w = l.w;
    const s = m.s;
    this.top = s.y + 0.5;
    this.dust.emit(
      { x: cx, z: cz, ground: l.surface, kind: l.kind, w, reach: radius, rotor: R, height, wet: mood.wet > 0.35, autumn: wind.autumn.value > 0.3, vx: s.vx, vz: s.vz },
      dt, far, l.acc, this.sample,
    );
    if (l.kind === 'water' && d < 160) {
      // Fine drops torn off the water and thrown out, and rings spreading from under it.
      const budget = this.particles.budget;
      l.drops += dt * 30 * Math.min(1, w) * budget;
      while (l.drops >= 1) {
        l.drops -= 1;
        const a = Math.random() * Math.PI * 2;
        const r = R * (0.6 + Math.random() * 0.6);
        const wv = washWind(r, Math.min(1, w), radius) * (0.4 + Math.random() * 0.4);
        const sp = this.s;
        Object.assign(sp, {
          x: cx + Math.cos(a) * r, y: l.surface + 0.05, z: cz + Math.sin(a) * r,
          vx: Math.cos(a) * wv, vy: 1 + Math.random() * 2.2, vz: Math.sin(a) * wv,
          life: 0.5 + Math.random() * 0.5, size0: 0.06, size1: 0.03, alpha: 0.8, cell: PARTICLE.glow, drag: 0.8, gravity: 9.8, spin: 0, stretch: 0.05,
        });
        sp.c0.copy(DROP);
        sp.c1.copy(DROP);
        this.particles.spawn(sp);
      }
      l.ring -= dt;
      if (l.ring <= 0 && w > 0.08) {
        l.ring = 0.45 / Math.min(1, w + 0.2);
        this.splashes.ring(cx + (Math.random() - 0.5) * 1.5, l.surface, cz + (Math.random() - 0.5) * 1.5, R * (1.6 + Math.random() * 0.8), 1.8, 0.3 * Math.min(1, w + 0.2));
      }
    }
  }
}
