import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ASSAULT, type CrateKind } from '../../shared/assaultFields.mjs';
import { FLAG_COLORS, fieldOf, type FlagTeam } from '../../shared/flagFields.mjs';
import type { World } from './collision';
import { mood } from './mood';
import { rewardSign } from './rewards';
import { campModels, type CampModels, type CampProp } from './campModels';

/**
 * Attack and defend's camps in the world (server/assault.mjs decides; shared/assaultFields.mjs has where): while a round
 * is played, the attackers' camp (two army tents and the supply truck, our Blender models from tools/camp.py, with
 * signal panels, flags and the truck's marks in the attackers' colour; four crates, four flood lamps on tripods) and the
 * six crates at the defenders' base. The camp's flag and its ring are Steal the flag's stand (world/flags.ts). Everything
 * carries its colour on the vertices and is merged per field: the tents and the truck in one mesh near and a simple one
 * far off (a LOD at the camp's flag), the crates and lamps in a second, the lamps' faces and, from dusk on, their pools
 * of light: four draw calls. No real light, no texture; the lamps' faces and pools stay far under the half floats' end.
 * The tents and the truck are walking barriers here (as the Zombies stall, world/stall.ts); shots pass through, the
 * server knows no camp. `near` says which crate or vehicle you may use.
 */

/** The view's own part (server/assault.mjs view `assault`). */
export interface AssaultView {
  round: number;
  phase: 'live' | 'break';
  /** The team defending this round */
  def: FlagTeam;
  /** The furthest the flag got this round, in per cent */
  best: number;
  /** Each round played: who defended, the capture's time (ms) or null, the furthest in per cent */
  results: { def: FlagTeam; ms: number | null; best: number }[];
  /** Heavy weapons out per team */
  heavy: Record<FlagTeam, number>;
  /** The defenders' traps taken this round */
  used: { claymores: number; turrets: number };
  mines: [number, number, number, number, number, string][];
  turrets: [number, number, number, number, number, string][];
  /** The spawn truck: its car id, and whether it is a start place now */
  truck: { id: string; spawn: boolean; still: boolean } | null;
}

/** A supply source you face: its id for the server (`asup`), what it gives. */
export interface SupplyAim {
  id: string;
  kind: CrateKind;
}

const C = {
  wood: '#8a6a45',
  woodDark: '#5c4430',
  pole: '#3a3d40',
  olive: '#5b6b45',
  white: '#f2f2ee',
  dark: '#26282a',
  lamp: '#fff2d0',
};
/** m: the page offers a crate this close (the server allows ASSAULT.reach) */
const NEAR = ASSAULT.reach - 0.4;
/** m from a vehicle's outline: the page offers its ammo this close (the server allows ASSAULT.vehicleReach from its box) */
const NEAR_VEHICLE = ASSAULT.vehicleReach - 0.3;
/** The camp's supply truck's box round its middle, along the camp (as the server's, server/assaultSupply.mjs sources) */
const SUPPLY_BOX = { hx: 1.4, hz: 3.4 };
const SIGNS: Partial<Record<CrateKind, 'ammo' | 'medkit' | 'claymore' | 'turret'>> = { ammo: 'ammo', med: 'medkit', claymore: 'claymore', turret: 'turret' };
/** A tent's half sizes on the ground (tools/camp.py: 5 m across, 6 m along), for its walking barrier */
const TENT = { hx: 2.6, hz: 3.1 };
/** m from the camp's flag where the tents and the truck change to their simple copies (and back a little nearer) */
const FAR_AT = 140;

/**
 * A prop of the camp's models at `m` (its frame in the camp's), its team parts in `team`'s colour; `mirror` turns it
 * left for right (a tent's rolled-up wall, the truck's open side, to the camp's middle). Its parts, indexed.
 */
function place(prop: CampProp, m: THREE.Matrix4, team: THREE.Color, mirror: boolean): THREE.BufferGeometry[] {
  const at = mirror ? m.clone().multiply(new THREE.Matrix4().makeScale(-1, 1, 1)) : m;
  return prop.parts.map(({ geometry, team: tinted }) => {
    const g = geometry.clone();
    if (mirror && g.index) {
      const ix = g.index.array;
      for (let i = 0; i < ix.length; i += 3) [ix[i + 1], ix[i + 2]] = [ix[i + 2], ix[i + 1]]; // the faces still face out
    }
    g.applyMatrix4(at);
    if (tinted) {
      const c = g.attributes.color.array as Float32Array;
      for (let i = 0; i < c.length; i += 3) {
        c[i] *= team.r;
        c[i + 1] *= team.g;
        c[i + 2] *= team.b;
      }
    }
    return g;
  });
}

/** A part with a colour on its vertices, moved by `m`: position, normal and colour only, not indexed (they all merge). */
function part(geo: THREE.BufferGeometry, hex: string | THREE.Color, m?: THREE.Matrix4): THREE.BufferGeometry {
  const src = geo.index ? geo.toNonIndexed() : geo;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', src.attributes.position.clone());
  if (!src.attributes.normal) src.computeVertexNormals();
  g.setAttribute('normal', src.attributes.normal.clone());
  if (m) g.applyMatrix4(m);
  const c = hex instanceof THREE.Color ? hex : new THREE.Color(hex);
  const colors = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/** The world matrix of a thing at (x, y, z) turned by `yaw` (the game's: its front along -z at 0). */
const at = (x: number, y: number, z: number, yaw: number) => new THREE.Matrix4().makeRotationY(yaw).premultiply(new THREE.Matrix4().makeTranslation(x, y, z));
/** A box of w × h × d, its foot at (x, y, z) in a local frame `m`. */
const box = (w: number, h: number, d: number, x: number, y: number, z: number, hex: string, m: THREE.Matrix4, rx = 0) =>
  part(new THREE.BoxGeometry(w, h, d), hex, new THREE.Matrix4().makeRotationX(rx).premultiply(new THREE.Matrix4().makeTranslation(x, y + h / 2, z)).premultiply(m));

/** One of the rewards' signs (world/rewards.ts), its colours baked, `fit` m across, on a crate's lid. */
function sign(kind: 'ammo' | 'medkit' | 'claymore' | 'turret', fit: number, m: THREE.Matrix4): THREE.BufferGeometry | null {
  const g = rewardSign(kind);
  g.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  g.traverseVisible((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const mat = o.material as THREE.MeshStandardMaterial;
    if (mat.blending === THREE.AdditiveBlending) return;
    parts.push(part(o.geometry, mat.color ?? new THREE.Color('#ffffff'), o.matrixWorld));
  });
  const merged = parts.length ? mergeGeometries(parts) : null;
  parts.forEach((p) => p.dispose());
  if (!merged) return null;
  merged.computeBoundingBox();
  const b = merged.boundingBox!;
  const s = fit / Math.max(b.max.x - b.min.x, b.max.z - b.min.z, 1e-3);
  merged.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
  merged.scale(s, s, s);
  merged.applyMatrix4(m);
  return merged;
}

/** A crate of `kind` at (x, y, z) facing `yaw`, `team`'s colour on its band: its parts. */
function crate(kind: CrateKind, x: number, y: number, z: number, yaw: number, team: string): THREE.BufferGeometry[] {
  const m = at(x, y, z, yaw);
  const long = kind === 'bazooka' || kind === 'sniper';
  const w = long ? 1.3 : 0.9, h = long ? 0.42 : 0.6, d = long ? 0.5 : 0.6;
  const body = kind === 'bazooka' || kind === 'sniper' || kind === 'claymore' ? C.olive : kind === 'med' ? C.white : C.wood;
  const out = [box(w, h, d, 0, 0, 0, body, m), box(w + 0.02, 0.07, d + 0.02, 0, h * 0.62, 0, team, m), box(0.06, h + 0.02, d + 0.02, -w / 2 + 0.08, -0.01, 0, C.woodDark, m), box(0.06, h + 0.02, d + 0.02, w / 2 - 0.08, -0.01, 0, C.woodDark, m)];
  if (kind === 'med') out.push(box(0.36, 0.02, 0.1, 0, h, 0, '#2e9e5a', m), box(0.1, 0.02, 0.36, 0, h, 0, '#2e9e5a', m)); // a green first-aid cross
  if (kind === 'bazooka') out.push(part(new THREE.CylinderGeometry(0.08, 0.08, 1.1, 10).rotateZ(Math.PI / 2), '#4a5a3a', new THREE.Matrix4().makeTranslation(0, h + 0.08, 0).premultiply(m)), box(0.12, 0.06, 0.14, 0.45, h + 0.05, 0, '#d0642a', m));
  if (kind === 'sniper') out.push(box(1.05, 0.05, 0.06, 0, h, 0, C.dark, m), box(0.22, 0.08, 0.08, -0.05, h + 0.05, 0, C.dark, m), box(0.3, 0.1, 0.12, -0.42, h, 0, C.woodDark, m));
  const s = SIGNS[kind];
  if (s && kind !== 'med') {
    const g = sign(s, 0.4, new THREE.Matrix4().makeTranslation(0, h, 0).premultiply(m));
    if (g) out.push(g);
  }
  return out;
}

/** A flood lamp on a tripod at (x, y, z), its head turned to `face` (the camp's flag): the lit parts and its face. */
function lamp(x: number, y: number, z: number, face: [number, number]): { lit: THREE.BufferGeometry[]; face: THREE.BufferGeometry } {
  const yaw = Math.atan2(-(face[0] - x), -(face[1] - z));
  const m = at(x, y, z, yaw);
  const lit = [box(0.07, 3.8, 0.07, 0, 0, 0, C.pole, m)];
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    lit.push(part(new THREE.BoxGeometry(0.05, 1.3, 0.05), C.pole, new THREE.Matrix4().makeRotationZ(0.45).premultiply(new THREE.Matrix4().makeRotationY(a)).premultiply(new THREE.Matrix4().makeTranslation(Math.sin(a) * 0.28, 0.55, Math.cos(a) * 0.28)).premultiply(m)));
  }
  const tilt = new THREE.Matrix4().makeRotationX(-0.45).premultiply(new THREE.Matrix4().makeTranslation(0, 3.85, 0)).premultiply(m);
  lit.push(part(new THREE.BoxGeometry(0.7, 0.42, 0.22), C.dark, tilt));
  const faceGeo = part(new THREE.BoxGeometry(0.6, 0.32, 0.02), C.lamp, new THREE.Matrix4().makeTranslation(0, 0, -0.115).premultiply(tilt));
  return { lit, face: faceGeo };
}

/** The light's pool round each lamp from dusk on: a soft disc on the ground, added (one shader for all). */
function pools(spots: [number, number, number][]): THREE.BufferGeometry {
  const parts = spots.map(([x, z, y]) => {
    const g = new THREE.CircleGeometry(7, 20).rotateX(-Math.PI / 2).translate(x, y + 0.06, z);
    const n = g.attributes.position.count;
    const strength = new Float32Array(n);
    for (let i = 0; i < n; i++) strength[i] = i === 0 ? 1 : 0; // the middle bright, the rim dark
    g.setAttribute('strength', new THREE.BufferAttribute(strength, 1));
    g.deleteAttribute('uv');
    return g.index ? g.toNonIndexed() : g;
  });
  return mergeGeometries(parts)!;
}

const litMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05 });
/** The tents and the truck: matt canvas and paint, both sides (a canvas is one sheet, seen from inside through the door) */
const campMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
const faceMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
const poolMat = new THREE.ShaderMaterial({
  uniforms: { night: { value: 0 } },
  vertexShader: 'attribute float strength; varying float s; void main() { s = strength; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'uniform float night; varying float s; void main() { gl_FragColor = vec4(vec3(1.0, 0.93, 0.78) * 0.22 * night * s * s, 1.0); }',
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});

export class AssaultCamp {
  readonly group = new THREE.Group();
  private lit = new THREE.Mesh(new THREE.BufferGeometry(), litMat);
  private faces = new THREE.Mesh(new THREE.BufferGeometry(), faceMat);
  private pool = new THREE.Mesh(new THREE.BufferGeometry(), poolMat);
  /** The tents and the supply truck, near and far, at the camp's flag (the renderer picks one by the eye's distance) */
  private lod = new THREE.LOD();
  private nearModels = new THREE.Mesh(new THREE.BufferGeometry(), campMat);
  private farModels = new THREE.Mesh(new THREE.BufferGeometry(), campMat);
  private models: CampModels | null = null;
  private key = '';
  private barriers: string[] = [];
  private view: { field: string; def: FlagTeam; still: boolean } | null = null;

  constructor(private world: World) {
    this.group.name = 'assault-camp';
    this.group.visible = false;
    this.lit.castShadow = this.lit.receiveShadow = true;
    this.nearModels.castShadow = this.nearModels.receiveShadow = true;
    this.farModels.castShadow = true;
    for (const m of [this.lit, this.faces, this.pool]) {
      m.frustumCulled = false; // spread over the field and the base: one bound for both would be wide anyway
    }
    for (const m of [this.lit, this.faces, this.pool, this.nearModels, this.farModels]) {
      m.userData.ignoreRay = true;
      m.raycast = () => {};
    }
    this.pool.renderOrder = 2;
    this.lod.addLevel(this.nearModels, 0, 0.08);
    this.lod.addLevel(this.farModels, FAR_AT, 0.08);
    this.group.add(this.lit, this.faces, this.pool, this.lod);
    // The models come in once; a camp built before them gets them then.
    void campModels().then((m) => {
      this.models = m;
      if (this.view && this.key) this.build(this.view.field, this.view.def);
    }, () => {});
  }

  /** The game's view (`field`, the round's `assault` part), or null: no Attack and defend on. */
  set(field: string | null, a: AssaultView | null): void {
    const on = !!field && !!a && !!fieldOf(field).assault;
    this.group.visible = on;
    if (!on) {
      this.view = null;
      if (this.key) this.clear();
      return;
    }
    this.view = { field: field!, def: a!.def, still: !!a!.truck?.still };
    const key = `${field}:${a!.def}`;
    if (key !== this.key) this.build(field!, a!.def);
  }

  private clear(): void {
    this.key = '';
    for (const k of this.barriers) this.world.setMoving(k, null);
    this.barriers = [];
  }

  /** The round's camp and the defenders' crates, in the colours of the teams on them now. */
  private build(fieldId: string, def: FlagTeam): void {
    this.clear();
    this.key = `${fieldId}:${def}`;
    const f = fieldOf(fieldId);
    const a = f.assault!;
    const c = a.camp;
    const att: FlagTeam = def === 'blue' ? 'red' : 'blue';
    const attC = FLAG_COLORS[att], defC = FLAG_COLORS[def];
    const lit: THREE.BufferGeometry[] = [];
    const faces: THREE.BufferGeometry[] = [];
    this.placeModels(c, new THREE.Color(attC));
    for (const k of c.crates) lit.push(...crate(k.kind, k.at[0], k.at[2], k.at[1], c.yaw, attC));
    for (const [x, z, y] of c.lamps) {
      const l = lamp(x, y, z, [c.flag[0], c.flag[1]]);
      lit.push(...l.lit);
      faces.push(l.face);
    }
    // The defenders' crates face their start places' middle.
    const sp = f.bases.blue.spawns;
    const mid: [number, number] = [sp.reduce((s, p) => s + p[0], 0) / sp.length, sp.reduce((s, p) => s + p[1], 0) / sp.length];
    for (const k of a.crates) lit.push(...crate(k.kind, k.at[0], k.at[2], k.at[1], Math.atan2(-(mid[0] - k.at[0]), -(mid[1] - k.at[1])), defC));
    this.swap(this.lit, lit);
    this.swap(this.faces, faces);
    this.pool.geometry.dispose();
    this.pool.geometry = pools(c.lamps);
    // Walking barriers: each tent's floor and the supply truck's outline (as the Zombies stall).
    const ring = (x: number, z: number, yaw: number, hx: number, hz: number): [number, number][] => {
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw), sx = -fz, sz = fx;
      return [[hz, hx], [hz, -hx], [-hz, -hx], [-hz, hx]].map(([u, v]) => [x + fx * u + sx * v, z + fz * u + sz * v] as [number, number]);
    };
    c.tents.forEach(([x, z, y], i) => this.barrier(`acamp-tent${i}`, ring(x, z, c.yaw, TENT.hx, TENT.hz), y));
    this.barrier('acamp-supply', ring(c.supply[0], c.supply[1], c.side, 1.3, 3.6), c.supply[2]);
  }

  /**
   * The tents and the supply truck in the camp `c`, near and far, their team parts in `team`; empty until the models are
   * in. Each tent's rolled-up wall and the truck's open side face the camp's flag (a tent on the other side mirrored).
   */
  private placeModels(c: NonNullable<ReturnType<typeof fieldOf>['assault']>['camp'], team: THREE.Color): void {
    const near: THREE.BufferGeometry[] = [];
    const far: THREE.BufferGeometry[] = [];
    const [fx, fz, fy] = c.flag;
    this.lod.position.set(fx, fy, fz);
    if (this.models) {
      const { tent, tentFar, supply, supplyFar } = this.models;
      // `open`: the side the model has open, its own +x (1) or -x (-1); mirrored when the flag is on its other side.
      const put = (near1: CampProp, far1: CampProp, [x, z, y]: number[], yaw: number, open: number) => {
        const m = new THREE.Matrix4().makeRotationY(yaw).premultiply(new THREE.Matrix4().makeTranslation(x - fx, y - fy, z - fz));
        const towards = (fx - x) * Math.cos(yaw) - (fz - z) * Math.sin(yaw); // the flag along the model's own +x
        const mirror = towards * open < 0;
        near.push(...place(near1, m, team, mirror));
        far.push(...place(far1, m, team, mirror));
      };
      for (const t of c.tents) put(tent, tentFar, t, c.yaw, -1);
      put(supply, supplyFar, c.supply, c.side, 1);
    }
    this.swap(this.nearModels, near);
    this.swap(this.farModels, far);
  }

  private barrier(key: string, ring: [number, number][], y: number): void {
    this.world.setMoving(key, ring, y - 0.3, y + 3.2, true);
    this.barriers.push(key);
  }

  private swap(mesh: THREE.Mesh, parts: THREE.BufferGeometry[]): void {
    mesh.geometry.dispose();
    mesh.geometry = parts.length ? mergeGeometries(parts) ?? new THREE.BufferGeometry() : new THREE.BufferGeometry();
    parts.forEach((p) => p.dispose());
  }

  /** Every frame: the lamps' pools from dusk on (as the street lamps), their faces brighter at night. */
  update(): void {
    if (!this.group.visible) return;
    poolMat.uniforms.night.value = mood.night;
    this.pool.visible = mood.night > 0.02;
    const v = 0.75 + 0.6 * mood.night;
    faceMat.color.setRGB(v, v, v);
  }

  /**
   * The supply you may use standing at (x, feet, z), as the server will take it: a crate of your side within reach (the
   * defenders' base for `side` 'def', the camp for 'att'), else, unless a seat is offered there (`seat`: by a car or a
   * helicopter Use gets you in), your side's vehicle a step back from its outline: your helicopter on the ground, the
   * camp's supply truck, the spawn truck standing still. `vehicle(kind, id)`: how far you are from that vehicle's outline
   * and its height, or null (gone, flown off, not drawn). Null for none.
   */
  near(x: number, feet: number, z: number, side: 'def' | 'att', seat: boolean, vehicle: (kind: 'heli' | 'car', id: string) => { d: number; y: number } | null): SupplyAim | null {
    const v = this.view;
    if (!v) return null;
    const f = fieldOf(v.field);
    const a = f.assault!;
    const list = side === 'def' ? a.crates : a.camp.crates;
    let best: SupplyAim | null = null;
    let bestD = NEAR;
    list.forEach((k, i) => {
      const d = Math.hypot(k.at[0] - x, k.at[1] - z);
      if (d < bestD && Math.abs(k.at[2] - feet) < ASSAULT.rise - 0.2) [best, bestD] = [{ id: `${side === 'def' ? 'd' : 'c'}${i}`, kind: k.kind }, d];
    });
    if (best || seat) return best;
    const h = vehicle('heli', f.heli[side === 'def' ? 'blue' : 'red'].id);
    if (h && h.d <= NEAR_VEHICLE && Math.abs(h.y - feet) < 1.5) return { id: side === 'def' ? 'hb' : 'hr', kind: 'ammo' };
    if (side === 'def') return null;
    const [sx, sz, sy] = a.camp.supply;
    const c = Math.cos(a.camp.side), n = Math.sin(a.camp.side);
    const lx = (x - sx) * c - (z - sz) * n, lz = (x - sx) * n + (z - sz) * c;
    if (Math.hypot(Math.max(0, Math.abs(lx) - SUPPLY_BOX.hx), Math.max(0, Math.abs(lz) - SUPPLY_BOX.hz)) <= NEAR_VEHICLE && Math.abs(sy - feet) < 1.5) return { id: 'cs', kind: 'ammo' };
    const t = v.still ? vehicle('car', a.truck) : null;
    if (t && t.d <= NEAR_VEHICLE && Math.abs(t.y - feet) < 1.5) return { id: 'tk', kind: 'ammo' };
    return null;
  }
}
