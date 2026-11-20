import * as THREE from 'three';
import type { World } from './collision';
import type { LooseProps } from './looseProps';
import { mood } from './mood';
import type { Particles, Spawn } from './particles';
import type { Splashes } from './splashes';
import { PARTICLE } from './sprites';
import { DISCS, washUniforms } from './washShader';
import { waterLevel } from './water';
import { wind } from './wind';

/**
 * The rotor's wash under each flying helicopter (world/heli.ts), on the page: everyone sees it from the machine's pose
 * they already get, nothing on the wire. As big games sell it: the air the rotor throws down spreads out along the
 * ground as a ring (strongest about a rotor's radius out from under the hub, gone at three), so on gravel, earth and
 * dry paving a ring of dust rolls outward and, low and hard, curls back up into the rotor (a brown-out); on grass the
 * blades lie flat outward in a moving disc; on water rings spread and fine spray flies; in autumn fallen leaves are
 * thrown out; in rain the drops are driven outward under it and the wet ground sprays; on snow a white cloud. Tree
 * crowns near it shake, loose bins and chairs rock or roll (world/looseProps.ts).
 *
 * How hard: from the rotor's thrust (shared/heli.mjs: the lever, the rotor's speed) and its height over the ground or
 * the water below: full on the ground at a hover's thrust, about two thirds at 12 m, nothing by 30 m. In fast flight
 * the wash is blown back and spreads thin. Eased in and out, so the dust builds as it comes down and clears as it
 * settles and the rotor runs down.
 *
 * The particles come from the shared pools (world/particles.ts: one draw for all), a few dozen a second: a few big soft
 * puffs rather than many small ones (the pixels they cover are the cost). The shaders read one small set of uniforms
 * (world/washShader.ts, two discs: the two machines nearest the eye): the grass blades, the bank plants,
 * the undergrowth, the water, the rain and the tree crowns, each a few sums per vertex (per pixel for the water, and
 * only inside a disc). Low and phones: the dust ring only (the shaders' discs stay empty, no leaves, no pushes).
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

type Ground = 'snow' | 'water' | 'gravel' | 'earth' | 'grass' | 'paving' | 'bare';
const PAVING = /road|pav|concrete|terrace|stone|tile|cobble|sett|asphalt|street|yard|square/i;
/** The ground's kind under a spot, from its material (no material: the garden or the meadow). */
function groundKind(mat: string | undefined): Ground {
  // The meadows and fields are one with the grass here (the meadow by the house is a field's block under its grass).
  if (!mat || /^field/i.test(mat)) return 'grass';
  if (/gravel|sand|track/i.test(mat)) return 'gravel';
  if (/earth|soil|mud|field|forest|leaves/i.test(mat)) return 'earth';
  if (/grass|lawn|meadow|moss|hedge/i.test(mat)) return 'grass';
  if (PAVING.test(mat)) return 'paving';
  return 'bare'; // a roof, a steel deck: nothing to blow but the rain on it
}

/** The dust by ground (linear colours are set from these once): its colour and how thick it is. */
const DUST: Record<Ground, { color: string; alpha: number }> = {
  snow: { color: '#eef2f6', alpha: 0.34 },
  water: { color: '#e6ecee', alpha: 0.2 },
  gravel: { color: '#bdb5a6', alpha: 0.38 },
  earth: { color: '#a08a6c', alpha: 0.32 },
  grass: { color: '#b3a886', alpha: 0.1 },
  paving: { color: '#bab4a9', alpha: 0.14 },
  bare: { color: '#c8c4bc', alpha: 0 },
};
const SPRAY = new THREE.Color('#d9e0e3');
const DROP = new THREE.Color('#dfe7e8');
const LEAVES = ['#7a5a14', '#6e3412', '#4a2a10', '#8a6a1c'].map((c) => new THREE.Color(c));
const BITS = ['#55662f', '#6b7a3a', '#4a5a28'].map((c) => new THREE.Color(c));
const colors = Object.fromEntries(Object.entries(DUST).map(([k, v]) => [k, new THREE.Color(v.color)])) as Record<Ground, THREE.Color>;

interface Live {
  /** The strength eased (dust builds and clears) */
  w: number;
  dust: number;
  bits: number;
  drops: number;
  ring: number;
  /** The ground under it, looked at a few times a second */
  look: number;
  kind: Ground;
  surface: number;
}

export class RotorWash {
  /** Medium and up, not a phone: the shaders' discs, the leaves, the spray's drops, the pushes on loose things */
  private fine = true;
  private live = new Map<WashMachine, Live>();
  private s: Spawn = {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size0: 0.1, size1: 0.1,
    c0: new THREE.Color(), c1: new THREE.Color(), alpha: 1, cell: 0, drag: 0, gravity: 0, spin: 0, stretch: 0,
  };
  private pick: { m: WashMachine; d: number; w: number; tree: number; radius: number; x: number; z: number; hub: number }[] = [];

  constructor(private world: World, private particles: Particles, private splashes: Splashes, private props: LooseProps | null = null) {}

  /** Dev build: each machine's eased strength, its ground and the discs as the shaders have them. */
  state(): { machines: { w: number; kind: string; surface: number }[]; discs: number[][] } {
    return { machines: [...this.live.values()].map((l) => ({ w: l.w, kind: l.kind, surface: l.surface })), discs: discs.map((d, i) => [d.x, d.y, d.z, d.w, aux[i].x, aux[i].y]) };
  }

  /** Every frame, after the machines have moved (main.ts, after helis.update); `fine` false on Low and phones (the dust ring only). */
  update(dt: number, machines: Iterable<WashMachine>, eye: THREE.Vector3, fine = true): void {
    this.fine = fine;
    washUniforms.washTime.value = (washUniforms.washTime.value + Math.max(0, dt)) % 1000;
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
        l = { w: 0, dust: 0, bits: 0, drops: 0, ring: 0, look: 0, kind: 'grass', surface: s.floor };
        this.live.set(m, l);
      }
      // The ground or the water under the hub, and what it is (a few times a second: it is the same from frame to frame).
      l.look -= dt;
      if (l.look <= 0) {
        l.look = 0.2;
        const g = this.world.groundAt(s.x, s.z, s.y + 0.5, 0);
        const level = waterLevel(s.x, s.z);
        l.surface = level !== null && level > g.y ? level : g.y;
        l.kind = level !== null && level > g.y ? 'water' : groundKind(g.mat);
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
      pick.push({ m, d, w: l.w, tree: crownStrength(height, thrust * s.rotor * s.rotor), radius, x: cx, z: cz, hub: s.y + 3.2 });
    }
    for (const m of this.live.keys()) if (!seen.has(m)) this.live.delete(m);
    // The shaders' discs: the two nearest the eye with any wash, within 150 m.
    pick.sort((a, b) => a.d - b.d);
    let n = 0;
    if (this.fine) {
      for (const p of pick) {
        if (n >= DISCS) break;
        if (p.d > 150 || (p.w < 0.02 && p.tree < 0.02)) continue;
        discs[n].set(p.x, p.z, p.radius, p.w > 0.02 ? p.w : 0);
        aux[n].set(p.hub, p.tree, 0, 0);
        n++;
      }
    }
    for (; n < DISCS; n++) {
      discs[n].set(0, 0, 1, 0);
      aux[n].set(0, 0, 0, 0);
    }
  }

  /** The particles: dust, spray, snow, leaves, drops and rings, by the ground under it. */
  private throwUp(m: WashMachine, l: Live, cx: number, cz: number, radius: number, height: number, d: number, dt: number): void {
    const budget = this.particles.budget;
    // Fewer far off (they are small there), none past 320 m.
    const far = Math.max(0, Math.min(1, 1.6 - d / 200));
    if (far <= 0) return;
    const w = l.w;
    const snowy = mood.snow > 0.25;
    const wet = mood.wet > 0.35;
    const s = m.s;
    // The ring of dust: a few big soft puffs a second, at full strength about 26.
    l.dust += dt * 26 * Math.min(1, w) * far * budget;
    while (l.dust >= 1) {
      l.dust -= 1;
      const a = Math.random() * Math.PI * 2;
      const r = R * (0.55 + Math.random() * 0.6) + height * 0.08;
      const px = cx + Math.cos(a) * r;
      const pz = cz + Math.sin(a) * r;
      const g = this.world.groundAt(px, pz, s.y + 0.5, 0);
      const level = waterLevel(px, pz);
      let kind: Ground = level !== null && level > g.y ? 'water' : groundKind(g.mat);
      const y = kind === 'water' ? level! : g.y;
      if (snowy && kind !== 'water' && kind !== 'bare') kind = 'snow';
      // Dry dust, or spray off the wet: in the rain the ground sprays instead of dusting.
      let alpha = DUST[kind].alpha;
      let color = colors[kind];
      if (wet && kind !== 'snow' && kind !== 'water') {
        alpha = kind === 'bare' || kind === 'paving' ? 0.16 : 0.12 + DUST[kind].alpha * 0.25;
        color = SPRAY;
      }
      // On Low and phones only the dust that shows plainly (gravel, earth, snow, water): a faint haze is pixels for nothing.
      if (alpha <= 0 || (!this.fine && alpha < 0.2)) continue;
      const wv = washWind(r, Math.min(1, w), radius) * (0.55 + Math.random() * 0.5);
      const brown = (kind === 'snow' || kind === 'gravel' || kind === 'earth') && w > 0.45 && height < 9 && Math.random() < 0.3;
      const sp = this.s;
      sp.x = px;
      sp.y = y + 0.3;
      sp.z = pz;
      if (brown) {
        // Curling back up into the rotor, further out: the start of a brown-out.
        const rr = R * (1.4 + Math.random() * 0.7);
        sp.x = cx + Math.cos(a) * rr;
        sp.z = cz + Math.sin(a) * rr;
        sp.vx = -Math.cos(a) * 0.8;
        sp.vz = -Math.sin(a) * 0.8;
        sp.vy = 1.6 + Math.random() * 1.6;
        sp.life = 2.6 + Math.random() * 1.2;
        sp.size0 = 2;
        sp.size1 = 6.5;
        sp.alpha = alpha * 0.55 * Math.min(1, w);
        sp.drag = 0.5;
        sp.gravity = -0.1;
      } else {
        // Hugging the ground as it rolls out, lifting a little as it slows and spreads; a third as ragged wisps.
        sp.vx = Math.cos(a) * wv + s.vx * 0.3;
        sp.vz = Math.sin(a) * wv + s.vz * 0.3;
        sp.vy = 0.15 + Math.random() * 0.45 + (kind === 'snow' ? 0.8 : 0);
        sp.life = 1.6 + Math.random() * 1.4;
        sp.size0 = kind === 'water' ? 1 : 1.6;
        sp.size1 = (kind === 'snow' ? 7 : 5.5) * (0.7 + Math.random() * 0.6);
        sp.alpha = alpha * Math.min(1, 0.35 + w);
        sp.drag = 0.8;
        sp.gravity = -0.12;
      }
      if (!this.fine) sp.size1 *= 0.7;
      // High enough that the square it is drawn on stays clear of the ground as it grows (no straight cut along its foot).
      sp.y = Math.max(sp.y, y + 0.2 + sp.size1 * 0.26);
      sp.cell = !brown && Math.random() < 0.35 ? PARTICLE.wisp : PARTICLE.puff;
      sp.spin = (Math.random() - 0.5) * 1.2;
      sp.stretch = 0;
      sp.c0.copy(color);
      sp.c1.copy(color);
      this.particles.spawn(sp);
    }
    if (!this.fine) return;
    // Leaves in autumn, bits of grass otherwise, thrown out and fluttering down; drops off the water.
    const kind = snowy && l.kind !== 'water' ? 'snow' : l.kind;
    const leafy = kind === 'grass' || kind === 'earth';
    if (leafy && !wet && d < 120) {
      l.bits += dt * 16 * Math.min(1, w) * budget;
      const autumn = wind.autumn.value > 0.3;
      while (l.bits >= 1) {
        l.bits -= 1;
        const a = Math.random() * Math.PI * 2;
        const r = R * (0.5 + Math.random() * 0.8);
        const px = cx + Math.cos(a) * r;
        const pz = cz + Math.sin(a) * r;
        const wv = washWind(r, Math.min(1, w), radius) * (0.25 + Math.random() * 0.3);
        const sp = this.s;
        Object.assign(sp, {
          x: px, y: this.world.groundAt(px, pz, s.y + 0.5, 0).y + 0.05, z: pz,
          vx: Math.cos(a) * wv, vy: 2 + Math.random() * 3.5 * Math.min(1, w), vz: Math.sin(a) * wv,
          life: 1.8 + Math.random() * 1.4, size0: autumn ? 0.13 : 0.06, size1: autumn ? 0.12 : 0.05, alpha: 0.95, cell: PARTICLE.chip,
          drag: 1.4, gravity: 2.6, spin: (Math.random() - 0.5) * 14, stretch: 0,
        });
        const list = autumn && Math.random() < 0.8 ? LEAVES : BITS;
        sp.c0.copy(list[Math.floor(Math.random() * list.length)]);
        sp.c1.copy(sp.c0);
        this.particles.spawn(sp);
      }
    }
    if (kind === 'water' && d < 160) {
      // Spray: fine drops torn off the water and thrown out, and rings spreading from under it.
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
