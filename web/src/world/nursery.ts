import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { DipSpec, Prism } from './houseData';
import { NURSERY_CROPS, nurseryReach, nurseryRows, type NurseryRows } from './fields';
import { leafLight } from './leaves';
import { reflectionSkips } from './reflections';
import { terrain } from './terrain';
import type { GroundShadeUniforms } from './undergrowth';
import { WASH_GLSL, washUniforms } from './washShader';
import { wind } from './wind';

/**
 * The declared tree nurseries' young trees and shrubs, standing in the rows the fields' shader draws (world/fields.ts),
 * so the two agree exactly: their rows are worked out from the same rounded numbers the shader gets. Late November:
 * avenue trees as bare whips tied to bamboo canes, or standards on a wooden stake; fruit trees' maidens; the shrub
 * fields in blocks of narrow conifers, clipped box balls and red-barked dogwood; field roses cut back; beech hedge
 * plants in dense rows keeping their dry brown leaves. Each field in blocks of a few rows and a few dozen metres of one
 * kind, as nurseries plant them, the odd plant already lifted and sold.
 *
 * As the big open-world games fill farmland and orchards: each model instanced, in three levels of detail by distance
 * from the eye (the near model, a far one of a tenth of its triangles, a stand-in of a handful that keeps the plant's
 * outline and colour, so a row a hundred metres off keeps its rhythm). Which level a plant shows is decided per plant in
 * the vertex shader, at a distance a little its own, so no ring of plants switches at once. At the edge of the reach
 * they grow out of the ground while the shader's flat rows fade back in (nurseryReach), so nothing pops. How far each
 * level reaches follows the preset and a budget of triangles: the denser a kind stands, the shorter its reach.
 *
 * The plants are our own models (tools/nursery.py, public/models/nursery.glb), lit as leaves are (world/leaves.ts),
 * swaying in the one wind (world/wind.ts), taking the ground's light and the dusk's long shadows at their foot as the
 * undergrowth does (world/groundShade.ts). Thin enough to walk through: no collision, not in the reflections, no shadow
 * of their own. Never on a road, paving, a hedge or in a building (2 m off its walls), a garden's lawn, the water or
 * against a tree. Medium and up, never on phones: there the flat rows stay as they are.
 *
 * Where they stand is worked out per square of 16 m the first time you come near (a few milliseconds a frame, the
 * nearest first), from the data alone: the same for everyone. Each plant is a few numbers in its model's list; the
 * copies drawn are those lists copied together again after every few metres you move.
 */

const CELL = 16;
/** Metres the eye moves before the copies are gathered again. */
const MOVE = 4;
/** Milliseconds a frame may spend working out new squares. */
const WORK_MS = 3;
/** Numbers per plant: x, y, z, turn; size, height, tint, its own (the jitter of its switches and its sway's timing). */
const STRIDE = 8;
/** Metres a level's switch moves at most from plant to plant (by its own number). */
const JITTER = 1.5;

type Model = 'Whip1' | 'Whip2' | 'Standard' | 'Maiden' | 'Conifer' | 'BoxBall' | 'Dogwood' | 'Rose' | 'Hedge';
const MODELS: Model[] = ['Whip1', 'Whip2', 'Standard', 'Maiden', 'Conifer', 'BoxBall', 'Dogwood', 'Rose', 'Hedge'];

/**
 * Per model: metres between plants along a row; its size from and to (times the model's); its height from and to; how
 * far its top leans in the wind per metre of height squared; standing along the row (the hedge's 1.2 m of row, turned
 * one way or the other) rather than turned any way.
 */
const SPEC: Record<Model, { step: number; size: [number, number]; tall: [number, number]; sway: number; row?: boolean }> = {
  Whip1: { step: 0.75, size: [0.9, 1.1], tall: [0.88, 1.12], sway: 0.009 },
  Whip2: { step: 0.75, size: [0.9, 1.1], tall: [0.88, 1.12], sway: 0.01 },
  Standard: { step: 1.2, size: [0.9, 1.1], tall: [0.92, 1.08], sway: 0.006 },
  Maiden: { step: 0.6, size: [0.9, 1.1], tall: [0.85, 1.15], sway: 0.014 },
  Conifer: { step: 0.6, size: [0.85, 1.12], tall: [0.85, 1.15], sway: 0.008 },
  BoxBall: { step: 0.62, size: [0.9, 1.08], tall: [0.95, 1.05], sway: 0 },
  Dogwood: { step: 0.8, size: [0.85, 1.15], tall: [0.85, 1.15], sway: 0.03 },
  Rose: { step: 0.36, size: [0.85, 1.15], tall: [0.85, 1.15], sway: 0.04 },
  Hedge: { step: 1.2, size: [1, 1], tall: [0.85, 1.12], sway: 0.025, row: true },
};

/** The shapes the dense evergreens are lit by: a corner's position in, the way out of the shape there out (not unit). */
const SHAPE: Partial<Record<Model, (p: THREE.Vector3) => void>> = {
  Conifer: (p) => p.set(p.x, 0.3 * Math.hypot(p.x, p.z) + 0.01, p.z),
  BoxBall: (p) => p.set(p.x, p.y - 0.29, p.z),
};

/** What each declared nursery grows, in blocks: the models and their shares. */
const GROWS: Record<string, [Model, number][]> = {
  avenue: [['Whip1', 0.4], ['Whip2', 0.3], ['Standard', 0.3]],
  fruit: [['Maiden', 1]],
  shrubs: [['Conifer', 0.36], ['BoxBall', 0.36], ['Dogwood', 0.28]],
  roses: [['Rose', 1]],
  hedgeplants: [['Hedge', 1]],
};

/**
 * Per preset: the metres each level reaches at most (near, far, the stand-ins), and the triangles one model's copies may
 * take at each level in a field full of them; the denser a kind stands, the shorter its levels reach.
 */
const PRESETS: Record<string, { reach: [number, number, number]; budget: [number, number, number] }> = {
  medium: { reach: [7, 22, 75], budget: [60_000, 50_000, 50_000] },
  high: { reach: [10, 32, 110], budget: [120_000, 90_000, 90_000] },
  ultra: { reach: [12, 40, 140], budget: [160_000, 130_000, 130_000] },
};

/**
 * How much of each level's ring of distances a nursery fills at most, for its budget: near by you stand in it; the
 * stand-ins' wide ring reaches past any one field (the largest are about 100 m across), so a third.
 */
const FILL = [1, 1, 0.35];

type Ring = [number, number][];

/** A number from 0 to 1 per corner of a grid of 1, the same everywhere for everyone. */
function hash3(a: number, b: number, c: number): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function inside(x: number, z: number, rings: Ring[]): boolean {
  let odd = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i];
      const [xj, zj] = ring[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) odd = !odd;
    }
  }
  return odd;
}

/** Metres from (x, z) to the nearest edge of the rings, at most `most` (beyond that it returns `most`). */
function edgeDistance(x: number, z: number, rings: Ring[], most: number): number {
  let best = most * most;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, az] = ring[j];
      const [bx, bz] = ring[i];
      const ex = bx - ax;
      const ez = bz - az;
      const len2 = ex * ex + ez * ez;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / len2)) : 0;
      const dx = ax + ex * t - x;
      const dz = az + ez * t - z;
      best = Math.min(best, dx * dx + dz * dz);
    }
  }
  return Math.sqrt(best);
}

interface Area {
  rings: Ring[];
  box: [number, number, number, number];
}

/** A piece of a declared nursery: its outline and rows. */
interface Plot extends Area {
  rows: NurseryRows;
  /** Height of its surface over the relief */
  y: number;
}

/** Ground no plant stands on or within `margin` m of. */
interface KeepOut extends Area {
  margin: number;
}

function boxOf(ring: Ring, grow = 0): [number, number, number, number] {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of ring) {
    x0 = Math.min(x0, x);
    z0 = Math.min(z0, z);
    x1 = Math.max(x1, x);
    z1 = Math.max(z1, z);
  }
  return [x0 - grow, z0 - grow, x1 + grow, z1 + grow];
}

/** One model's copies at one level of detail: an instanced mesh whose copies are placed in its vertex shader. */
interface Level {
  mesh: THREE.Mesh;
  geometry: THREE.InstancedBufferGeometry;
  place: THREE.InstancedBufferAttribute;
  make: THREE.InstancedBufferAttribute;
  /** Metres from and to which its copies show (before each plant's own jitter) */
  range: { value: THREE.Vector2 };
  tris: number;
}

interface Planted {
  model: Model;
  levels: Level[];
  /** Metres each level reaches at most in this preset (near, far, stand-in) */
  reach: [number, number, number];
}

export class Nursery {
  readonly group = new THREE.Group();
  private plots: Plot[] = [];
  /** By squares of 64 m that their box touches */
  private plotAt = new Map<string, Plot[]>();
  private keepAt = new Map<string, KeepOut[]>();
  private trunks = new Map<string, [number, number][]>();
  /** Per square of CELL, per model: STRIDE numbers per plant */
  private cells = new Map<string, Float32Array[]>();
  private planted: Planted[] | null = null;
  private quality = 'high';
  private on = false;
  private last = new THREE.Vector3(Infinity, 0, 0);
  /** Squares still to work out round the eye */
  private waiting = false;
  /** The near and far models' material, and the stand-ins' (cheaper: no rotor wash, the ground's light from its coarse picture) */
  private materials: THREE.MeshStandardMaterial[];
  private reachOf = new Map<Model, { value: number }>();

  constructor(shade?: GroundShadeUniforms) {
    this.group.name = 'nursery';
    this.group.userData.nursery = this;
    reflectionSkips.objects.add(this.group); // not in the reflections (world/reflections.ts)
    this.materials = [this.makeMaterial(shade, false), this.makeMaterial(shade, true)];
    for (const m of MODELS) this.reachOf.set(m, { value: 0 });
    new GLTFLoader().loadAsync('/models/nursery.glb').then(
      (gltf) => this.useModels(gltf.scene),
      () => {},
    );
  }

  /** The declared nurseries of a piece of the data, and what no plant may stand on: the rest of its blocks, water, lawns, trees. */
  addFields(prisms: Prism[] | undefined, extra: { dips?: DipSpec[]; lawns?: { p: Ring[] }[]; trees?: { x: number; z: number }[] } = {}): void {
    const keep = (rings: Ring[], margin: number) => {
      if (!rings[0]?.length) return;
      const area: KeepOut = { rings, box: boxOf(rings[0], margin), margin };
      this.index(this.keepAt, area);
    };
    for (const p of prisms ?? []) {
      const rows = nurseryRows(p);
      if (rows) {
        const plot: Plot = { rings: p.p, box: boxOf(p.p[0]), rows, y: p.y1 };
        this.plots.push(plot);
        this.index(this.plotAt, plot);
        continue;
      }
      if (p.m === 'field_soil' || p.m === 'field_dark' || p.m === 'field_crop' || p.m === 'forest') continue;
      // Draped ground covers (roads, paving, gravel, hedges, fences) keep plants a little off; a building's walls more.
      keep(p.p, p.d ? (p.m === 'nb_hedge' || p.m === 'hedge' || p.m === 'fence' ? 0.8 : 0.5) : 2);
    }
    for (const d of extra.dips ?? []) keep([d.rim], 1);
    for (const l of extra.lawns ?? []) keep(l.p, 0.5);
    for (const t of extra.trees ?? []) {
      const key = `${Math.floor(t.x / CELL)},${Math.floor(t.z / CELL)}`;
      const list = this.trunks.get(key);
      if (list) list.push([t.x, t.z]);
      else this.trunks.set(key, [[t.x, t.z]]);
    }
    // Squares worked out before these came may be wrong now: work them out again.
    this.cells.clear();
    this.last.set(Infinity, 0, 0);
  }

  private index<T extends Area>(map: Map<string, T[]>, area: T): void {
    const [x0, z0, x1, z1] = area.box;
    for (let i = Math.floor(x0 / 64); i <= Math.floor(x1 / 64); i++) {
      for (let j = Math.floor(z0 / 64); j <= Math.floor(z1 / 64); j++) {
        const key = `${i},${j}`;
        const list = map.get(key);
        if (list) list.push(area);
        else map.set(key, [area]);
      }
    }
  }

  /** The graphics preset: Medium and up, never on phones. */
  setQuality(quality: string, phone: boolean): void {
    this.quality = quality === 'ultra' ? 'ultra' : quality === 'medium' ? 'medium' : 'high';
    this.on = !phone && quality !== 'low';
    this.reaches();
  }

  /** Shown or not (for measuring it against itself): off, the flat rows as they are. */
  setOn(on: boolean): void {
    this.on = on;
    this.reaches();
  }

  /** Each model's levels' reach for this preset and its density, and each crop's reach for the fields' shader. */
  private reaches(): void {
    this.last.set(Infinity, 0, 0);
    const reach = [0, 0, 0, 0, 0];
    this.group.visible = this.on && !!this.planted;
    if (this.planted && this.on) {
      const preset = PRESETS[this.quality];
      for (const crop of NURSERY_CROPS) {
        // The narrowest rows of the crop: its plants stand that densely.
        const spacing = 0.55 + 1.45 * ({ hedgeplants: 6, roses: 22, shrubs: 38, fruit: 76, avenue: 108 } as Record<string, number>)[crop] / 127;
        let cropReach = preset.reach[2];
        const levels: [Planted, [number, number, number]][] = [];
        for (const [model] of GROWS[crop]) {
          const p = this.planted.find((q) => q.model === model)!;
          const density = 1 / (spacing * SPEC[model].step);
          // Each level in the ring between the one before and its own reach, its triangles within its budget.
          const r: [number, number, number] = [0, 0, 0];
          let inner = 0;
          for (let l = 0; l < 3; l++) {
            const fits = Math.sqrt(preset.budget[l] / (density * p.levels[l].tris * Math.PI * FILL[l]) + inner * inner);
            r[l] = Math.max(inner + 2, Math.min(preset.reach[l], fits));
            inner = r[l];
          }
          cropReach = Math.min(cropReach, r[2]);
          levels.push([p, r]);
        }
        // All of a crop's plants grow in at the same distance, where its flat rows come back.
        for (const [p, r] of levels) {
          r[2] = cropReach;
          r[1] = Math.min(r[1], cropReach - 4);
          r[0] = Math.min(r[0], r[1] - 2);
          p.reach = r;
          p.levels.forEach((level, l) => level.range.value.set(l ? r[l - 1] : -1, r[l]));
          this.reachOf.get(p.model)!.value = cropReach;
        }
        reach[NURSERY_CROPS.indexOf(crop)] = cropReach;
      }
    }
    nurseryReach.value = reach;
  }

  /** The models once fetched: an instanced mesh per model and level. */
  private useModels(root: THREE.Object3D): void {
    root.updateMatrixWorld(true);
    const geometry = (name: string): THREE.BufferGeometry | null => {
      const o = root.getObjectByName(name);
      if (!(o instanceof THREE.Mesh)) return null;
      const source = o.geometry as THREE.BufferGeometry;
      const g = new THREE.BufferGeometry();
      g.setIndex(source.index);
      g.setAttribute('position', source.getAttribute('position'));
      // The corners' colours as three numbers, their alpha (0: a stem widened far off) as a number of its own.
      const c = source.getAttribute('color');
      const rgb = new Float32Array(c.count * 3);
      const thin = new Float32Array(c.count);
      for (let i = 0; i < c.count; i++) {
        rgb.set([c.getX(i), c.getY(i), c.getZ(i)], i * 3);
        thin[i] = c.itemSize > 3 && c.getW(i) < 0.5 ? 1 : 0;
      }
      g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
      g.setAttribute('npThin', new THREE.BufferAttribute(thin, 1));
      g.applyMatrix4(o.matrixWorld);
      g.computeVertexNormals();
      // The dense evergreens lit by their shape (a column, a ball), as foliage is in games, not by each spray's facet.
      const shape = SHAPE[name.replace(/Far$|Stub$/, '') as Model];
      if (shape) {
        const p = g.getAttribute('position');
        const n = g.getAttribute('normal');
        const v = new THREE.Vector3();
        const s = new THREE.Vector3();
        for (let i = 0; i < p.count; i++) {
          shape(s.fromBufferAttribute(p, i));
          v.fromBufferAttribute(n, i).multiplyScalar(0.3).addScaledVector(s.normalize(), 0.7).normalize();
          n.setXYZ(i, v.x, v.y, v.z);
        }
      }
      return g;
    };
    const planted: Planted[] = [];
    for (const model of MODELS) {
      const levels: Level[] = [];
      for (const suffix of ['', 'Far', 'Stub']) {
        const one = geometry(model + suffix);
        if (!one) return; // not the file we know: the flat rows stay
        const g = new THREE.InstancedBufferGeometry();
        for (const name of ['position', 'normal', 'color', 'npThin']) g.setAttribute(name, one.getAttribute(name));
        g.setIndex(one.getIndex());
        const place = new THREE.InstancedBufferAttribute(new Float32Array(256 * 4), 4).setUsage(THREE.DynamicDrawUsage);
        const make = new THREE.InstancedBufferAttribute(new Float32Array(256 * 4), 4).setUsage(THREE.DynamicDrawUsage);
        g.setAttribute('npPlace', place);
        g.setAttribute('npMake', make);
        g.instanceCount = 0;
        const range = { value: new THREE.Vector2(0, 0) };
        const base = this.materials[suffix === 'Stub' ? 1 : 0];
        const material = base.clone();
        material.onBeforeCompile = base.onBeforeCompile;
        material.customProgramCacheKey = base.customProgramCacheKey;
        material.userData.range = range;
        material.userData.reach = this.reachOf.get(model);
        material.userData.sway = { value: SPEC[model].sway };
        // The far ball and column: their leaves' fine mottle painted on, where the near model has them as geometry.
        material.userData.speckle = { value: suffix && (model === 'BoxBall' || model === 'Conifer') ? 1 : 0 };
        const mesh = new THREE.Mesh(g, material);
        mesh.frustumCulled = false; // placed round the eye in the vertex shader
        mesh.userData.ignoreRay = true;
        mesh.raycast = () => {};
        mesh.visible = false;
        mesh.name = `nursery ${model} ${suffix || 'Near'}`;
        this.group.add(mesh);
        levels.push({ mesh, geometry: g, place, make, range, tris: (one.getIndex()?.count ?? 0) / 3 });
      }
      planted.push({ model, levels, reach: [0, 0, 0] });
    }
    this.planted = planted;
    this.reaches();
  }

  /** The plants' material: placed, turned and sized per copy, shown at its level's distances, in the ground's light. */
  private makeMaterial(shade: GroundShadeUniforms | undefined, stub: boolean): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide });
    m.onBeforeCompile = function (this: THREE.MeshStandardMaterial, shader) {
      Object.assign(shader.uniforms, {
        npRange: this.userData.range, npReach: this.userData.reach, npSway: this.userData.sway, npSpeckle: this.userData.speckle,
        windTime: wind.time, windStrength: wind.strength, windDir: wind.dir, windSpeed: wind.speed,
      });
      if (!stub) Object.assign(shader.uniforms, washUniforms);
      if (shade) Object.assign(shader.uniforms, { ugShade: shade.groundShade, ugShadeAll: shade.groundShadeAll, ugArea: shade.groundArea, ugAreaAll: shade.groundAreaAll,
        ugDusk: shade.groundContact, ugDuskAll: shade.groundContactAll, ugDuskK: shade.groundDuskK, ugDuskKAll: shade.groundDuskKAll });
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          ${stub ? '' : WASH_GLSL}
          attribute vec4 npPlace;
          attribute vec4 npMake;
          attribute float npThin;
          uniform vec2 npRange;
          uniform float npReach;
          uniform float npSway;
          uniform float windTime;
          uniform float windStrength;
          uniform vec2 windDir;
          uniform float windSpeed;
          varying vec2 vUgLight;
          varying vec3 vNpTint;
          varying vec3 vNpLocal;
          ${shade ? 'uniform sampler2D ugShade;\nuniform sampler2D ugShadeAll;\nuniform vec3 ugArea;\nuniform vec3 ugAreaAll;\nuniform sampler2D ugDusk;\nuniform sampler2D ugDuskAll;\nuniform float ugDuskK;\nuniform float ugDuskKAll;' : ''}
          vec2 npTurn(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(v.x * c - v.y * s, v.x * s + v.y * c); }`,
        )
        .replace(
          '#include <beginnormal_vertex>',
          `vec3 objectNormal = normal;
          objectNormal.xz = npTurn(objectNormal.xz, npPlace.w);`,
        )
        .replace(
          '#include <begin_vertex>',
          `vec3 npRoot = npPlace.xyz;
          float npFar = distance(cameraPosition, npRoot);
          // This level shows from and to its distances, each plant's a little its own. Towards the edge of the reach
          // the plant thins away to nothing (and a little lower) while the flat rows come back (world/fields.ts
          // nurseryReach): no tree grows out of the ground in front of you.
          float npOwn = npMake.w * ${JITTER.toFixed(1)};
          float npShow = step(npRange.x + npOwn, npFar) * step(npFar, npRange.y + npOwn) * step(npFar, npReach);
          float npGrow = smoothstep(npReach, npReach * 0.72, npFar);
          vec3 transformed = position * vec3(npMake.x * npGrow, npMake.y * mix(0.6, 1.0, npGrow), npMake.x * npGrow);
          // Stems far off widened to about a pixel, so they don't shimmer in and out.
          transformed.xz *= mix(1.0, clamp(npFar / 40.0, 1.0, 2.0), npThin);
          transformed.xz = npTurn(transformed.xz, npPlace.w);
          // The wind: the top leans with it, more the higher, each plant in its own time.
          float npGust = sin(windTime * 1.4 + npRoot.x * 0.35 + npRoot.z * 0.27) * 0.7 + sin(windTime * 2.9 + npMake.w * 6.0) * 0.3;
          transformed.xz += windDir * npGust * npSway * transformed.y * transformed.y * windStrength * windSpeed;
          ${stub ? '' : 'transformed.xz += washAt(npRoot.xz).xy * 0.15 * transformed.y; // a rotor wash (world/rotorWash.ts)'}
          transformed *= npShow;
          transformed += npRoot;
          vUgLight = vec2(1.0);
          ${shade
            ? `{
            // The ground's light at the foot (sun, sky), as world/groundShade.ts gives the soil round it.
            vec2 uvFine = (npRoot.xz - ugArea.xy) / ugArea.z * 0.5 + 0.5;
            vec2 uvAll = (npRoot.xz - ugAreaAll.xy) / ugAreaAll.z * 0.5 + 0.5;
            vec2 edgeFine = abs(uvFine - 0.5);
            float fine = smoothstep(0.5, 0.46, max(edgeFine.x, edgeFine.y));
            vec4 gs = vec4(1.0, 1.0, 0.5, 0.5);
            vec2 edgeAll = abs(uvAll - 0.5);
            // At dusk the low sun's long shadows, as the ground has them (world/duskShade.ts). The stand-ins, far
            // off, only the whole area's picture.
            ${stub ? 'fine = 0.0;' : ''}
            if (fine < 1.0 && max(edgeAll.x, edgeAll.y) < 0.5) {
              gs = textureLod(ugShadeAll, uvAll, 0.0);
              if (ugDuskKAll > 0.0) gs.r = mix(gs.r, textureLod(ugDuskAll, uvAll, 0.0).g, ugDuskKAll);
            }
            if (fine > 0.0) {
              vec4 gsHere = textureLod(ugShade, uvFine, 0.0);
              if (ugDuskK > 0.0) gsHere.r = mix(gsHere.r, textureLod(ugDusk, uvFine, 0.0).g, ugDuskK);
              gs = mix(gs, gsHere, fine);
            }
            vUgLight = gs.rg;
          }`
            : ''}
          // Each copy a little lighter or darker, warmer or greyer (the models carry their own colours).
          vNpLocal = position + npMake.w * 17.0;
          vNpTint = (0.88 + 0.24 * npMake.z) * mix(vec3(1.0, 0.97, 0.92), vec3(0.95, 0.96, 1.0), fract(npMake.z * 7.31));`,
        );
      shader.fragmentShader = leafLight(shader.fragmentShader, 0.35)
        .replace('#include <common>', '#include <common>\nvarying vec2 vUgLight;\nvarying vec3 vNpTint;\nvarying vec3 vNpLocal;\nuniform float npSpeckle;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          diffuseColor.rgb *= vNpTint;
          if (npSpeckle > 0.0) {
            // Leaves of 3 to 4 cm, lighter and darker, fading out where they get smaller than a pixel.
            vec3 npCell = vNpLocal * 30.0;
            float npLeaf = fract(sin(dot(floor(npCell), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
            float npSharp = clamp(1.5 - 2.0 * length(fwidth(npCell)), 0.0, 1.0);
            diffuseColor.rgb *= mix(1.0, 0.72 + 0.5 * npLeaf, npSharp);
          }`,
        )
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
          reflectedLight.directDiffuse *= vUgLight.x;
          reflectedLight.indirectDiffuse *= vUgLight.y;`,
        );
    };
    m.customProgramCacheKey = () => `nursery|${!!shade}|${stub}`;
    return m;
  }

  /** The plants of one square, per model, worked out once. */
  private square(i: number, j: number): Float32Array[] {
    const key = `${i},${j}`;
    const done = this.cells.get(key);
    if (done) return done;
    const x0 = i * CELL;
    const z0 = j * CELL;
    const bucket = `${Math.floor((x0 + CELL / 2) / 64)},${Math.floor((z0 + CELL / 2) / 64)}`;
    const overlaps = (a: Area) => a.box[0] < x0 + CELL && a.box[2] > x0 && a.box[1] < z0 + CELL && a.box[3] > z0;
    const plots = (this.plotAt.get(bucket) ?? []).filter(overlaps);
    const out: number[][] = MODELS.map(() => []);
    if (plots.length) {
      const keepOuts = (this.keepAt.get(bucket) ?? []).filter(overlaps);
      const near: [number, number][] = [];
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) near.push(...(this.trunks.get(`${i + a},${j + b}`) ?? []));
      const corners: [number, number][] = [[x0, z0], [x0 + CELL, z0], [x0, z0 + CELL], [x0 + CELL, z0 + CELL]];
      for (const plot of plots) {
        const { dir, perp, spacing, own, crop } = plot.rows;
        const grows = GROWS[crop];
        const field = Math.round(own) + 101 * NURSERY_CROPS.indexOf(crop);
        // The rows that cross this square, and how far along them it reaches.
        let a0 = Infinity, a1 = -Infinity, c0 = Infinity, c1 = -Infinity;
        for (const [x, z] of corners) {
          const across = x * perp[0] + z * perp[1];
          const along = x * dir[0] + z * dir[1];
          c0 = Math.min(c0, across);
          c1 = Math.max(c1, across);
          a0 = Math.min(a0, along);
          a1 = Math.max(a1, along);
        }
        for (let row = Math.floor(c0 / spacing - 0.5); row <= Math.ceil(c1 / spacing); row++) {
          const across = (row + 0.5) * spacing;
          // Blocks of a few rows and a few dozen metres, each of one kind.
          const rowsPer = 3 + Math.floor(hash3(field, 7, 0) * 6);
          const block = Math.floor(row / rowsPer);
          const blockLen = 14 + hash3(field, 11, 0) * 26;
          for (let b = Math.floor(a0 / blockLen); b <= Math.floor(a1 / blockLen); b++) {
            let pick = hash3(field, block, b);
            let m = 0;
            while (m < grows.length - 1 && pick >= grows[m][1]) pick -= grows[m++][1];
            const model = grows[m][0];
            const spec = SPEC[model];
            const mi = MODELS.indexOf(model);
            const from = Math.max(a0, b * blockLen);
            const to = Math.min(a1, (b + 1) * blockLen);
            for (let k = Math.floor(from / spec.step); k <= Math.ceil(to / spec.step); k++) {
              const r = (n: number) => hash3(row * 31 + n, k, field);
              const at = (k + 0.5) * spec.step;
              if (at < b * blockLen || at >= (b + 1) * blockLen) continue; // its block's own
              const along = at + (spec.row ? 0 : (r(1) - 0.5) * spec.step * 0.25);
              const off = spec.row ? 0 : (r(2) - 0.5) * 0.06;
              const x = dir[0] * along + perp[0] * (across + off);
              const z = dir[1] * along + perp[1] * (across + off);
              if (x < x0 || x >= x0 + CELL || z < z0 || z >= z0 + CELL) continue;
              if (r(3) < 0.04) continue; // lifted and sold already
              if (!inside(x, z, plot.rings) || edgeDistance(x, z, plot.rings, 0.45) < 0.45) continue;
              if (keepOuts.some((o) => x > o.box[0] && x < o.box[2] && z > o.box[1] && z < o.box[3] && (inside(x, z, o.rings) || edgeDistance(x, z, o.rings, o.margin) < o.margin))) continue;
              if (near.some(([tx, tz]) => Math.hypot(tx - x, tz - z) < 1.2)) continue;
              const turn = spec.row ? Math.atan2(dir[1], dir[0]) + (r(4) < 0.5 ? Math.PI : 0) : r(4) * Math.PI * 2;
              const size = spec.size[0] + (spec.size[1] - spec.size[0]) * r(5);
              const tall = size * (spec.tall[0] + (spec.tall[1] - spec.tall[0]) * r(6));
              out[mi].push(x, terrain.height(x, z) + plot.y, z, turn, size, tall, r(7), r(8));
            }
          }
        }
      }
    }
    const lists = out.map((l) => new Float32Array(l));
    this.cells.set(key, lists);
    return lists;
  }

  /** Each frame: new squares worked out (a few milliseconds' worth), the copies gathered again once the eye moved on. */
  update(eye: THREE.Vector3): void {
    if (!this.on || !this.planted || !this.plots.length) return;
    const moved = Math.hypot(eye.x - this.last.x, eye.z - this.last.z) >= MOVE || Math.abs(eye.y - this.last.y) >= MOVE;
    if (!moved && !this.waiting) return;
    const most = Math.max(...this.planted.map((p) => p.reach[2])) + MOVE + JITTER;
    // Squares round the eye not worked out yet: the nearest first, as many as the time allows.
    const r = Math.ceil(most / CELL);
    const ci = Math.floor(eye.x / CELL);
    const cj = Math.floor(eye.z / CELL);
    const todo: [number, number, number][] = [];
    for (let i = ci - r; i <= ci + r; i++) {
      for (let j = cj - r; j <= cj + r; j++) {
        const dx = Math.max(i * CELL - eye.x, 0, eye.x - (i + 1) * CELL);
        const dz = Math.max(j * CELL - eye.z, 0, eye.z - (j + 1) * CELL);
        const d = Math.hypot(dx, dz);
        if (d < most && !this.cells.has(`${i},${j}`)) todo.push([d, i, j]);
      }
    }
    todo.sort((a, b) => a[0] - b[0]);
    const start = performance.now();
    let worked = 0;
    for (const [, i, j] of todo) {
      if (worked && performance.now() - start > WORK_MS) break;
      this.square(i, j);
      worked++;
    }
    this.waiting = worked < todo.length;
    if (!worked && !moved) return;
    this.last.copy(eye);
    this.gather(eye, ci, cj, r, most);
  }

  /** Copy the plants round the eye into each model's levels: each level gets those near its ring of distances. */
  private gather(eye: THREE.Vector3, ci: number, cj: number, r: number, most: number): void {
    const counts = this.planted!.map((p) => p.levels.map(() => 0));
    const margin = MOVE + JITTER + 0.5;
    for (let i = ci - r; i <= ci + r; i++) {
      for (let j = cj - r; j <= cj + r; j++) {
        const dx = Math.max(i * CELL - eye.x, 0, eye.x - (i + 1) * CELL);
        const dz = Math.max(j * CELL - eye.z, 0, eye.z - (j + 1) * CELL);
        if (Math.hypot(dx, dz) > most) continue;
        const lists = this.cells.get(`${i},${j}`);
        if (!lists) continue;
        lists.forEach((list, mi) => {
          if (!list.length) return;
          const p = this.planted![mi];
          for (let k = 0; k < list.length; k += STRIDE) {
            const d = Math.hypot(list[k] - eye.x, list[k + 1] - eye.y, list[k + 2] - eye.z);
            if (d > p.reach[2] + margin) continue;
            for (let l = 0; l < 3; l++) {
              const lo = l ? p.reach[l - 1] - margin : -1;
              if (d < lo || d > p.reach[l] + margin) continue;
              this.push(p.levels[l], counts[mi][l]++, list, k);
            }
          }
        });
      }
    }
    this.planted!.forEach((p, mi) =>
      p.levels.forEach((level, l) => {
        const n = counts[mi][l];
        level.geometry.instanceCount = n;
        level.mesh.visible = n > 0;
        if (n) {
          for (const a of [level.place, level.make]) {
            a.clearUpdateRanges();
            a.addUpdateRange(0, n * 4);
            a.needsUpdate = true;
          }
        }
      }),
    );
  }

  /** One plant into a level's copies (its arrays grown when full). */
  private push(level: Level, n: number, list: Float32Array, k: number): void {
    if ((n + 1) * 4 > level.place.array.length) {
      const grow = (a: THREE.InstancedBufferAttribute) => {
        const bigger = new Float32Array(Math.max(1024, a.array.length * 2));
        bigger.set(a.array as Float32Array);
        return new THREE.InstancedBufferAttribute(bigger, 4).setUsage(THREE.DynamicDrawUsage);
      };
      level.geometry.dispose(); // its old buffers off the chip; made again at the next draw
      level.place = grow(level.place);
      level.make = grow(level.make);
      level.geometry.setAttribute('npPlace', level.place);
      level.geometry.setAttribute('npMake', level.make);
    }
    const place = level.place.array as Float32Array;
    const make = level.make.array as Float32Array;
    place[n * 4] = list[k];
    place[n * 4 + 1] = list[k + 1];
    place[n * 4 + 2] = list[k + 2];
    place[n * 4 + 3] = list[k + 3];
    make[n * 4] = list[k + 4];
    make[n * 4 + 1] = list[k + 5];
    make[n * 4 + 2] = list[k + 6];
    make[n * 4 + 3] = list[k + 7];
  }

  /** How many copies each level draws now (for the dev tools). */
  stats(): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const p of this.planted ?? []) out[p.model] = [...p.levels.map((l) => l.geometry.instanceCount), ...p.reach.map((r) => Math.round(r))];
    return out;
  }
}
