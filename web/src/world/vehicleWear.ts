import * as THREE from 'three';
import { t } from '../i18n';
import { anyPaint, paintball } from '../paintball';
import { sound } from '../sound';
import type { VehicleDamageMsg } from '../net/client';
import type { Effects } from './effects';
import { splatSound } from './splats';
import '../ui/vehicleHealth.css';

/**
 * Cars and helicopters taking damage in a team match, on the page (the rules and numbers are the server's:
 * server/vehicleDamage.mjs). The server tells each vehicle's health and stage (`vdmg`); this shows them:
 * - the real look: grey smoke from the engine under half, a fire and black smoke under a fifth, and once destroyed a
 *   burnt wreck (its parts swapped for charred copies of their materials) smouldering for a while, then nothing until
 *   it is back whole at its parking place;
 * - the child-friendly look (paintball.on): no fire, no smoke, no wreck. Paint splats on it as it is hit, paint dripping
 *   off when it is nearly out, and once out it is covered in one colour of paint (the burst is the blast's, effects.ts).
 * All of it goes through the shared particles and splats (instanced, no lights, colours far under 65504), fewer on the
 * lower presets (effects.particles.budget) and none far off. A small bar shows the health of the vehicle you sit in.
 * A bullet of yours that meets a vehicle is told the server once per shot (`vhit`, its pellets counted), with the hit
 * marker; the server decides whether it counts.
 */

/**
 * The games that are a team-against-team match, where vehicles take damage: the page's copy of the server's
 * `modes.teamMatch` (server/modes.mjs), the same rule: one of these kinds, while its phase is 'playing'. A new team game
 * adds its kind here (and is not `peaceful` in ui/games.ts, or nobody fires at all).
 */
export const TEAM_MATCH_KINDS: ReadonlySet<string> = new Set(['teams', 'flag']);
export const teamMatch = (view: { kind: string; phase?: string }): boolean => TEAM_MATCH_KINDS.has(view.kind) && view.phase === 'playing';

/** The stages the server tells (server/vehicleDamage.mjs STAGE). */
export const STAGE = { whole: 0, smoke: 1, fire: 2, wreck: 3, gone: 4 } as const;
type Kind = 'car' | 'heli';

/** What main.ts lets this module see of a vehicle: its drawn group, where it is, who sits in it. */
export interface WearTarget {
  group: THREE.Object3D;
  x: number;
  y: number;
  z: number;
  yaw: number;
  riders: (string | null)[];
  /** Taken away (gone) or back: the vehicle's own flag (Car.taken, Heli.taken) */
  setGone: (on: boolean) => void;
}

interface Wear {
  k: Kind;
  id: string;
  hp: number;
  st: number;
  since: number; // s in this stage
  smoke: number; // particles owed (rates below)
  flame: number;
  drip: number;
  crackle: number;
  color: THREE.Color; // its paint in the child-friendly look
}

const SMOKE_RATE = [0, 5, 8, 5, 0]; // puffs a second by stage (the wreck's thin out after WRECK_FIRE_S)
const FLAME_RATE = [0, 0, 18, 10, 0];
const DRIP_RATE = [0, 1.5, 5, 0, 0];
const WRECK_FIRE_S = 9;
const FAR = 160; // m: no smoke or fire drawn further off
/** Where on each kind its engine is, in its own frame (x across, y up, z along: a car's nose is -z, a helicopter's too). */
const ENGINE: Record<Kind, THREE.Vector3> = { car: new THREE.Vector3(0, 0.9, -1.75), heli: new THREE.Vector3(0, 2.5, 0.6) };
/** The size its smoke and flames are drawn at. */
const SIZE: Record<Kind, number> = { car: 1, heli: 1.4 };

const WEAR_MAT = 'vehicleWear';
const burnt = new Map<string, THREE.Material>();
const painted = new Map<string, THREE.Material>();

/** Drawn: the object and every parent visible (a vehicle's far copy is hidden near, its near one far off). */
function shown(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

/** A charred copy of `m` (the wreck): its colour almost black, matt, no shine. Made once per material. */
function burntOf(m: THREE.Material): THREE.Material {
  let b = burnt.get(m.uuid);
  if (!b) {
    b = m.clone();
    const s = b as THREE.MeshPhysicalMaterial;
    // Soot, whatever colour it was: a black car and a white one burn alike. A map (the plate) shows through darkly.
    if (s.color) s.color.setRGB(0.014, 0.012, 0.011);
    if ('roughness' in s) s.roughness = 1;
    if ('metalness' in s) s.metalness = 0.1;
    if ('clearcoat' in s) s.clearcoat = 0;
    if (s.emissive) s.emissive.setRGB(0, 0, 0);
    if ('envMapIntensity' in s) s.envMapIntensity = 0.15;
    if (s.transparent) s.opacity = Math.max(s.opacity, 0.85); // the windows black with soot
    b.userData[WEAR_MAT] = true;
    burnt.set(m.uuid, b);
  }
  return b;
}

/** A copy of `m` covered in paint of `color` (out in the child-friendly look). Made once per material and colour. */
function paintedOf(m: THREE.Material, color: THREE.Color): THREE.Material {
  const key = `${m.uuid}:${color.getHexString()}`;
  let b = painted.get(key);
  if (!b) {
    b = m.clone();
    const s = b as THREE.MeshStandardMaterial;
    if (s.color) s.color.lerp(color, 0.85);
    if ('roughness' in s) s.roughness = 0.55;
    if ('metalness' in s) s.metalness = 0;
    if (s.emissive) s.emissive.setRGB(0, 0, 0);
    if ('transparent' in s && s.transparent) s.opacity = Math.max(s.opacity, 0.92);
    b.userData[WEAR_MAT] = true;
    painted.set(key, b);
  }
  return b;
}

export class VehicleWear {
  private wear = new Map<string, Wear>();
  private pending = new Map<string, { k: Kind; id: string; w: string; n: number }>();
  private flushing = false;
  private swapTimer = 0;
  private readonly bar = document.createElement('div');
  private readonly label = document.createElement('span');
  private readonly fill = document.createElement('i');
  private readonly v = new THREE.Vector3();
  private readonly ray = new THREE.Raycaster();
  /** Whether a hit of yours on a vehicle can count now (a team match: main.ts asks games). */
  live: () => boolean = () => false;
  /** Whether you may damage it: nobody of your team (nor you) sits in it (main.ts asks games.friend). */
  friendly: (name: string) => boolean = () => false;
  /** Tell the server (net.send). */
  send: (msg: Record<string, unknown>) => void = () => {};
  /** Your shot met it: the hit marker. */
  onHit: () => void = () => {};

  constructor(private effects: Effects, private find: (k: Kind, id: string) => WearTarget | null, hud: HTMLElement) {
    this.bar.id = 'vehicle-health';
    this.bar.hidden = true;
    this.bar.setAttribute('role', 'meter');
    this.bar.setAttribute('aria-valuemin', '0');
    this.bar.setAttribute('aria-valuemax', '100');
    this.label.className = 'vh-label';
    const track = document.createElement('div');
    track.className = 'vh-track';
    track.append(this.fill);
    this.bar.append(this.label, track);
    hud.append(this.bar);
  }

  /** The vehicle a mesh hit by a ray belongs to (its group carries userData.car or userData.heli), or null. */
  static owner(o: THREE.Object3D | null): { k: Kind; id: string } | null {
    for (let p = o; p; p = p.parent) {
      if (typeof p.userData.car === 'string') return { k: 'car', id: p.userData.car };
      if (typeof p.userData.heli === 'string') return { k: 'heli', id: p.userData.heli };
    }
    return null;
  }

  /**
   * A bullet (pellet) of `w` of yours met mesh `on`: when it is a car's or a helicopter's in a team match, not a wreck and
   * nobody of your team in it, it is counted; the shot's pellets go to the server together once the shot is done.
   */
  shot(on: THREE.Object3D, w: string): void {
    if (!this.live()) return;
    const who = VehicleWear.owner(on);
    if (!who) return;
    const key = `${who.k}:${who.id}`;
    if ((this.wear.get(key)?.st ?? 0) >= STAGE.wreck) return;
    const v = this.find(who.k, who.id);
    if (!v || v.riders.some((n) => n !== null && this.friendly(n))) return;
    const e = this.pending.get(key) ?? { ...who, w, n: 0 };
    e.n++;
    this.pending.set(key, e);
    if (this.flushing) return;
    this.flushing = true;
    queueMicrotask(() => {
      this.flushing = false;
      for (const e of this.pending.values()) this.send({ t: 'vhit', kind: e.k, id: e.id, w: e.w, n: e.n });
      if (this.pending.size) this.onHit();
      this.pending.clear();
    });
  }

  /** Everything as the server has it on joining (welcome); vehicles not in the list are whole. */
  reset(list: VehicleDamageMsg[] | undefined): void {
    for (const [key, w] of this.wear) {
      this.dress(w, false);
      this.wear.delete(key);
    }
    for (const m of list ?? []) this.set(m, true);
  }

  /**
   * One vehicle's health and stage from the server (`vdmg`), checked as it arrives. `quiet`: on joining (no sounds).
   * Returns who destroyed it, when this message is its destruction.
   */
  set(m: VehicleDamageMsg, quiet = false): string | null {
    const k = m.k === 'car' || m.k === 'heli' ? m.k : null;
    if (!k || typeof m.id !== 'string' || m.id.length > 32) return null;
    const hp = typeof m.hp === 'number' && Number.isFinite(m.hp) ? Math.max(0, Math.min(100, Math.round(m.hp))) : 100;
    const st = typeof m.st === 'number' && Number.isInteger(m.st) && m.st >= 0 && m.st <= STAGE.gone ? m.st : STAGE.whole;
    const key = `${k}:${m.id}`;
    const old = this.wear.get(key);
    if (st === STAGE.whole && hp >= 100) {
      if (old) {
        this.dress(old, false);
        this.wear.delete(key);
      }
      return null;
    }
    const w: Wear = old ?? { k, id: m.id, hp, st, since: 0, smoke: 0, flame: 0, drip: 0, crackle: 0, color: new THREE.Color(anyPaint()) };
    const changed = !old || old.st !== st;
    w.hp = hp;
    w.st = st;
    if (changed) w.since = 0;
    this.wear.set(key, w);
    if (changed) {
      this.dress(w, st === STAGE.wreck || st === STAGE.gone);
      if (!quiet) this.staged(w);
    }
    return st === STAGE.wreck && changed && typeof m.by === 'string' ? m.by : null;
  }

  /** On a new stage: a sound, and in the child-friendly look paint splats on it (more the worse it is). */
  private staged(w: Wear): void {
    const v = this.find(w.k, w.id);
    if (!v) return;
    const at = this.engine(w, v);
    if (paintball.on) {
      if (w.st === STAGE.smoke || w.st === STAGE.fire) {
        this.splat(v, w.st === STAGE.fire ? 9 : 5);
        splatSound(at, true);
      }
      return;
    }
    if (w.st === STAGE.smoke) hiss(at);
    if (w.st === STAGE.fire) whoomp(at);
  }

  /** `n` splats of paint on its body, where rays from round it meet it. */
  private splat(v: WearTarget, n: number): void {
    v.group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(v.group);
    const mid = box.getCenter(new THREE.Vector3());
    const r = box.getSize(new THREE.Vector3()).length() / 2 + 1;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const from = new THREE.Vector3(mid.x + Math.cos(a) * r, mid.y + (Math.random() * 0.8 + 0.1) * r * 0.6, mid.z + Math.sin(a) * r);
      this.ray.set(from, mid.clone().sub(from).normalize());
      this.ray.far = r * 2;
      const hit = this.ray.intersectObject(v.group, true).find((h) => h.face && !h.object.userData.ignoreRay && shown(h.object));
      if (!hit || !hit.face) continue;
      const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      this.effects.splats.add(hit.point, normal, new THREE.Color(anyPaint()), 0.55 + Math.random() * 0.35, hit.object, this.ray.ray.direction);
    }
  }

  /** Its parts as a wreck (burnt, or covered in paint), or back as they were. */
  private dress(w: Wear, wreck: boolean): void {
    const v = this.find(w.k, w.id);
    if (!v) return;
    v.setGone(wreck && w.st === STAGE.gone); // gone: not drawn, no block to bump into, no way in, not on the maps
    v.group.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return;
      const mat = o.material as THREE.Material;
      const own = mat.userData[WEAR_MAT] ? (o.userData.wearOwn as THREE.Material | undefined) : mat;
      if (!own) return;
      if (wreck) {
        o.userData.wearOwn = own;
        o.material = paintball.on ? paintedOf(own, w.color) : burntOf(own);
      } else if (mat.userData[WEAR_MAT]) {
        o.material = own;
        delete o.userData.wearOwn;
      }
    });
  }

  /** The engine of `v` in the world (its smoke and fire come from there). */
  private engine(w: Wear, v: WearTarget): THREE.Vector3 {
    const e = ENGINE[w.k];
    const c = Math.cos(v.yaw), s = Math.sin(v.yaw);
    return this.v.set(v.x + e.x * c + e.z * s, v.y + e.y, v.z - e.x * s + e.z * c);
  }

  /**
   * Every frame, after the cars and helicopters were drawn where they are: smoke, fire and paint drips from the damaged
   * ones near `eye`, the wrecks kept in their look (a model swapped near or far gets it too), the gone ones hidden, and
   * the bar for the one you sit in (`mine`).
   */
  update(dt: number, eye: THREE.Vector3, mine: { k: Kind; id: string } | null): void {
    const budget = Math.max(0.35, Math.min(1, this.effects.particles.budget));
    this.swapTimer -= dt;
    const reswap = this.swapTimer <= 0;
    if (reswap) this.swapTimer = 0.5;
    for (const w of this.wear.values()) {
      w.since += dt;
      const v = this.find(w.k, w.id);
      if (!v) continue;
      if (w.st === STAGE.gone) continue; // not drawn (Car.taken, Heli.taken)
      if (reswap && w.st === STAGE.wreck) this.dress(w, true);
      if (!v.group.visible || (v.x - eye.x) ** 2 + (v.z - eye.z) ** 2 > FAR * FAR) continue;
      const at = this.engine(w, v);
      const wreckFire = w.st === STAGE.wreck && w.since < WRECK_FIRE_S;
      if (paintball.on) {
        w.drip += DRIP_RATE[w.st] * budget * dt;
        for (; w.drip >= 1; w.drip--) this.effects.paintDrip(this.jitter(at, w.k), w.color);
        continue;
      }
      const smoke = SMOKE_RATE[w.st] * (w.st === STAGE.wreck && !wreckFire ? 0.4 : 1);
      w.smoke += smoke * budget * dt;
      for (; w.smoke >= 1; w.smoke--) this.effects.vehicleSmoke(this.jitter(at, w.k), w.st >= STAGE.fire ? 1 : 0.35, SIZE[w.k]);
      w.flame += (w.st === STAGE.fire || wreckFire ? FLAME_RATE[w.st] : 0) * budget * dt;
      for (; w.flame >= 1; w.flame--) this.effects.vehicleFlame(this.jitter(at, w.k), SIZE[w.k]);
      if (w.st === STAGE.fire || wreckFire) {
        w.crackle -= dt;
        if (w.crackle <= 0 && (v.x - eye.x) ** 2 + (v.z - eye.z) ** 2 < 40 * 40) {
          w.crackle = 0.5 + Math.random() * 0.6;
          crackle(at);
        }
      }
    }
    this.showBar(mine);
  }

  /** A point round the engine, a little off at random. */
  private jitter(at: THREE.Vector3, k: Kind): THREE.Vector3 {
    const r = k === 'heli' ? 0.6 : 0.45;
    return new THREE.Vector3(at.x + (Math.random() - 0.5) * r, at.y + Math.random() * 0.2, at.z + (Math.random() - 0.5) * r);
  }

  private shown = '';
  /** The bar: the health of the vehicle you sit in, while it is not whole. */
  private showBar(mine: { k: Kind; id: string } | null): void {
    const w = mine ? this.wear.get(`${mine.k}:${mine.id}`) : undefined;
    const key = w && w.st < STAGE.wreck ? `${w.k}:${w.hp}:${w.st}:${paintball.on}` : '';
    if (key === this.shown) return;
    this.shown = key;
    this.bar.hidden = !key;
    if (!w || !key) return;
    const name = t(w.k === 'car' ? 'veh.car' : 'veh.heli', { pct: String(w.hp) });
    this.label.textContent = w.st === STAGE.fire ? `${name} · ${t(paintball.on ? 'veh.paint' : 'veh.fire')}` : name;
    this.bar.className = w.st === STAGE.fire ? 'fire' : w.st === STAGE.smoke ? 'smoke' : '';
    this.bar.setAttribute('aria-valuenow', String(w.hp));
    this.fill.style.transform = `scaleX(${w.hp / 100})`;
  }

  /** The stage of a vehicle as this page has it (tests, the dev hook). */
  /** A wreck or gone: no "get in" beside it (main.ts), the server would refuse. */
  out(k: Kind, id: string): boolean {
    return this.stageOf(k, id) >= STAGE.wreck;
  }

  stageOf(k: Kind, id: string): number {
    return this.wear.get(`${k}:${id}`)?.st ?? STAGE.whole;
  }
}

/** A short noise burst through a filter, made in code, at `at`. */
function burst(at: THREE.Vector3, len: number, from: number, to: number, gain: number, type: BiquadFilterType = 'lowpass', ref = 6): void {
  const ctx = sound.context();
  const dest = ctx ? sound.at(at.x, at.y, at.z, ref) : null;
  if (!ctx || !dest) return;
  const tt = ctx.currentTime;
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * len), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 1.6);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(from, tt);
  f.frequency.exponentialRampToValueAtTime(to, tt + len);
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(dest);
  src.start(tt);
}

/** Steam and smoke escaping a hurt engine: a hiss. */
function hiss(at: THREE.Vector3): void {
  burst(at, 1.2, 5200, 2400, 0.25, 'highpass');
}

/** Catching fire: a low whoomp. */
function whoomp(at: THREE.Vector3): void {
  burst(at, 0.9, 180, 1400, 0.9, 'lowpass', 8);
}

/** A fire's crackle: one sharp click and a pop. */
function crackle(at: THREE.Vector3): void {
  burst(at, 0.06, 3800, 900, 0.35, 'bandpass', 3);
  if (Math.random() < 0.5) setTimeout(() => burst(at, 0.04, 2600, 700, 0.25, 'bandpass', 3), 60 + Math.random() * 120);
}
