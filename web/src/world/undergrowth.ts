import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { terrain } from './terrain';
import { wind } from './wind';
import { leafLight, leafy } from './leaves';

/**
 * The woods' undergrowth round where you are: ferns (most of them turned bracken-brown at the start of
 * November), low mounds of bramble, shrubs (holly, hazel, young beech that keeps its brown leaves) and
 * the odd fallen branch, on the woods' floor of the open data (the `forest` ground cover) and clear of
 * the trunks. Only within a few tens of metres of the eye: further off the floor's own fallen leaves
 * (world/fields.ts) and the crowns are what you see.
 *
 * Cheap on purpose: one instanced mesh per kind (four draw calls), all opaque (no cut-outs, nothing
 * blended), lit as the leaves are (plain diffuse, world/leaves.ts). What stands where is worked out per
 * square of 16 m the first time you come near, from the square's place (the same for everyone), and
 * kept; the copies drawn are gathered again after every few metres you move. They grow out of the ground
 * towards the edge of the reach, in the vertex shader, so nothing pops in. They take the ground's baked
 * light and shade (world/groundShade.ts) at their foot, so under the crowns they are as dark as the floor.
 * On Low and on phones the reach is shorter and they stand sparser.
 */

const CELL = 16;
/** Plants per square metre of the woods' floor, before the sparser presets thin them. */
const DENSITY = 0.3;
/** Metres a plant keeps from a trunk. */
const TRUNK = 0.8;
const enum Kind {
  Fern,
  Bramble,
  Shrub,
  Branch,
}
const KINDS = 4;
/** Copies of each kind at most. */
const CAPACITY = [4000, 1200, 900, 160];

type Ring = [number, number][];
interface Wood {
  rings: Ring[];
  /** Height of its floor over the relief */
  y: number;
  box: [number, number, number, number];
}

/** The ground's shading uniforms (world/groundShade.ts), read at each plant's foot. */
export interface GroundShadeUniforms {
  groundShade: { value: THREE.Texture };
  groundShadeAll: { value: THREE.Texture };
  groundArea: { value: THREE.Vector3 };
  groundAreaAll: { value: THREE.Vector3 };
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

/** A fern: seven fronds arching out from the middle, each a stalk with leaflets alternating along it (1 m). */
function fernGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const nor: number[] = [];
  const fronds = 7;
  const steps = 4;
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + (f % 2) * 0.3;
    const reach = 0.75 + 0.25 * ((f * 37) % 7) / 7;
    const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    // Up steeply from the middle, arching over and down towards the tip, as bracken does.
    const at = (t: number) => dir.clone().multiplyScalar(t * reach * 0.85).setY(reach * (1.7 * t - 1.15 * t * t) + 0.02);
    for (let k = 0; k < steps; k++) {
      const t0 = k / steps;
      const t1 = (k + 1) / steps;
      const p0 = at(t0);
      const p1 = at(t1);
      const mid = at((t0 + t1) / 2);
      // Leaflets: widest a third of the way out, to a point at the tip; drooping a little at their ends.
      const w = 0.2 * Math.sin(Math.PI * Math.min(1, (t0 + t1) / 2 + 0.15)) + 0.02;
      for (const s of [-1, 1]) {
        const tip = mid.clone().addScaledVector(side, s * w).add(new THREE.Vector3(0, -0.05 - 0.05 * t1, 0));
        const tri = s > 0 ? [p0, tip, p1] : [p0, p1, tip];
        for (const v of tri) {
          pos.push(v.x, v.y, v.z);
          // Normals lean up: a fern is lit as the low plant it is, not as a heap of slivers.
          nor.push(dir.x * 0.25, 0.95, dir.z * 0.25);
          const shade = 0.55 + 0.45 * Math.min(1, v.distanceTo(new THREE.Vector3(0, 0, 0)) / reach);
          col.push(shade, shade, shade);
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const n = g.getAttribute('normal');
  for (let i = 0; i < n.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(n, i).normalize();
    n.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeBoundingSphere();
  return g;
}

/**
 * A leafy lump (bramble or shrub): a rough ball of 80 triangles, its foot narrowed (`foot`), darker
 * underneath and deep in its dips. 1 m across, standing on the ground.
 */
function lumpGeometry(seed: number, height: number, foot: number): THREE.BufferGeometry {
  const source = new THREE.IcosahedronGeometry(0.5, 1);
  source.deleteAttribute('uv');
  source.deleteAttribute('normal');
  const g = mergeVertices(source);
  source.dispose();
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const d = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    d.fromBufferAttribute(pos, i).normalize();
    const bump = 1 + 0.22 * Math.sin(d.x * 7 + seed) * Math.sin(d.z * 6 - seed * 2) + 0.12 * Math.sin(d.y * 9 + seed * 3);
    const narrow = d.y < 0 ? 1 - foot * Math.min(1, -d.y * 1.4) : 1;
    pos.setXYZ(i, d.x * 0.5 * bump * narrow, (d.y * 0.5 * bump + 0.5) * height, d.z * 0.5 * bump * narrow);
    const shade = (0.55 + 0.45 * THREE.MathUtils.smoothstep(d.y, -0.7, 0.6)) * (0.85 + 0.15 * bump);
    col.set([shade, shade, shade], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** A fallen branch, 1 m long along x, lying on the ground: a six-sided tube without ends. */
function branchGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.6, 1, 1, 6, 1, true).rotateZ(Math.PI / 2).translate(0, 0.8, 0);
  g.deleteAttribute('uv');
  const n = g.getAttribute('position').count;
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  return g;
}

/** Colours per kind (linear), picked by each plant's own number. */
const COLOURS: Record<Kind, THREE.Color[]> = {
  // Bracken turned rust and straw-brown, and some still green.
  [Kind.Fern]: ['#a85a22', '#b8782e', '#8e6a2a', '#5a7c2a', '#6c8a30'].map((c) => new THREE.Color(c)),
  // Bramble: dark green, some leaves already purple-brown.
  [Kind.Bramble]: ['#3d5a2a', '#4a5a2e', '#5a4632', '#44603a'].map((c) => new THREE.Color(c)),
  // Holly, hazel turning yellow, young beech keeping its brown leaves.
  [Kind.Shrub]: ['#2f4a26', '#8a7c30', '#a0602a', '#557034'].map((c) => new THREE.Color(c)),
  [Kind.Branch]: ['#6a5c50', '#574c42'].map((c) => new THREE.Color(c)),
};

export class Undergrowth {
  readonly group = new THREE.Group();
  private woods: Wood[] = [];
  /** Woods by squares of 64 m that their box touches */
  private woodAt = new Map<string, Wood[]>();
  /** Tree trunks by squares of CELL */
  private trunks = new Map<string, [number, number][]>();
  /** Per square of CELL: x, y, z, kind, size, turn, colour, rank for every plant in it */
  private plants = new Map<string, Float32Array>();
  private meshes: THREE.InstancedMesh[] = [];
  private reach = 55;
  private share = 1;
  private last = new THREE.Vector3(Infinity, 0, 0);
  private reachUniform = { value: 55 };

  constructor(shade?: GroundShadeUniforms) {
    const geometries = [fernGeometry(), lumpGeometry(1.3, 0.75, 0.2), lumpGeometry(4.1, 1.2, 0.5), branchGeometry()];
    const fern = this.material('fern', shade);
    // The lumps with leaves, as the hedges' (world/leaves.ts): clumps of about 12 cm, a ragged outline.
    const lump = this.material('lump', shade);
    leafy(lump, 0.8, 0.55, 0.3);
    const wood = this.material('wood', shade);
    const materials = [fern, lump, lump, wood];
    for (let k = 0; k < KINDS; k++) {
      const mesh = new THREE.InstancedMesh(geometries[k], materials[k], CAPACITY[k]);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, new THREE.Color(1, 1, 1));
      mesh.count = 0;
      mesh.frustumCulled = false; // the copies spread round the eye; the reach keeps them few
      mesh.userData.ignoreRay = true;
      mesh.raycast = () => {};
      mesh.name = ['ferns', 'brambles', 'shrubs', 'fallen branches'][k];
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
  }

  /**
   * The plants' material: the ground's shade at the foot, growing in with the reach, ferns swaying; lit as
   * leaves are (the lumps get that from leafy(), with their leaves).
   */
  private material(kind: 'fern' | 'lump' | 'wood', shade?: GroundShadeUniforms): THREE.MeshStandardMaterial {
    const fern = kind === 'fern';
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: fern ? THREE.DoubleSide : THREE.FrontSide });
    m.onBeforeCompile = (shader) => {
      shader.uniforms.ugReach = this.reachUniform;
      shader.uniforms.windTime = wind.time;
      shader.uniforms.windStrength = wind.strength;
      if (shade) Object.assign(shader.uniforms, { ugShade: shade.groundShade, ugShadeAll: shade.groundShadeAll, ugArea: shade.groundArea, ugAreaAll: shade.groundAreaAll });
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float ugReach;
          uniform float windTime;
          uniform float windStrength;
          varying vec2 vUgLight;
          ${shade ? 'uniform sampler2D ugShade;\nuniform sampler2D ugShadeAll;\nuniform vec3 ugArea;\nuniform vec3 ugAreaAll;' : ''}`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vec3 ugRoot = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          // Grown in towards the edge of the reach: nothing pops in or out.
          transformed *= smoothstep(ugReach, ugReach * 0.72, distance(cameraPosition, ugRoot));
          ${fern ? `transformed.xz += vec2(-0.998, 0.057) * sin(windTime * 1.6 + ugRoot.x * 0.4 + ugRoot.z * 0.3) * 0.06 * transformed.y * windStrength;` : ''}
          vUgLight = vec2(1.0);
          ${shade
            ? `{
            // The ground's light at the foot (sun, sky), as world/groundShade.ts gives the floor round it.
            vec2 uvFine = (ugRoot.xz - ugArea.xy) / ugArea.z * 0.5 + 0.5;
            vec2 uvAll = (ugRoot.xz - ugAreaAll.xy) / ugAreaAll.z * 0.5 + 0.5;
            vec2 edgeFine = abs(uvFine - 0.5);
            float fine = smoothstep(0.5, 0.46, max(edgeFine.x, edgeFine.y));
            vec4 gs = vec4(1.0, 1.0, 0.5, 0.5);
            vec2 edgeAll = abs(uvAll - 0.5);
            if (fine < 1.0 && max(edgeAll.x, edgeAll.y) < 0.5) gs = textureLod(ugShadeAll, uvAll, 0.0);
            if (fine > 0.0) gs = mix(gs, textureLod(ugShade, uvFine, 0.0), fine);
            vUgLight = gs.rg;
          }`
            : ''}`,
        );
      shader.fragmentShader = (kind === 'lump' ? shader.fragmentShader : leafLight(shader.fragmentShader, fern ? 0.5 : 0))
        .replace('#include <common>', '#include <common>\nvarying vec2 vUgLight;')
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
          reflectedLight.directDiffuse *= vUgLight.x;
          reflectedLight.indirectDiffuse *= vUgLight.y;`,
        );
    };
    m.customProgramCacheKey = () => `undergrowth|${kind}|${!!shade}`;
    return m;
  }

  /** The woods' floors (`forest` blocks) of a piece of the data, and its trees (the plants keep off their trunks). */
  addWoods(prisms: { m: string; p: Ring[]; y1: number }[] | undefined, trees: { x: number; z: number }[] | undefined): void {
    for (const p of prisms ?? []) {
      if (p.m !== 'forest') continue;
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const [x, z] of p.p[0]) {
        x0 = Math.min(x0, x);
        z0 = Math.min(z0, z);
        x1 = Math.max(x1, x);
        z1 = Math.max(z1, z);
      }
      const wood: Wood = { rings: p.p, y: p.y1, box: [x0, z0, x1, z1] };
      this.woods.push(wood);
      for (let i = Math.floor(x0 / 64); i <= Math.floor(x1 / 64); i++) {
        for (let j = Math.floor(z0 / 64); j <= Math.floor(z1 / 64); j++) {
          const key = `${i},${j}`;
          const list = this.woodAt.get(key);
          if (list) list.push(wood);
          else this.woodAt.set(key, [wood]);
        }
      }
    }
    for (const t of trees ?? []) {
      const key = `${Math.floor(t.x / CELL)},${Math.floor(t.z / CELL)}`;
      const list = this.trunks.get(key);
      if (list) list.push([t.x, t.z]);
      else this.trunks.set(key, [[t.x, t.z]]);
    }
    // Squares worked out before these woods came may lack their plants: work them out again.
    this.plants.clear();
    this.last.set(Infinity, 0, 0);
  }

  /** The graphics preset: how far the undergrowth reaches and how much of it stands. */
  setQuality(quality: string, phone: boolean): void {
    const low = quality === 'low' || phone;
    this.reach = low ? 32 : quality === 'medium' ? 45 : 55;
    this.share = low ? 0.5 : quality === 'medium' ? 0.75 : 1;
    this.reachUniform.value = this.reach;
    this.last.set(Infinity, 0, 0);
  }

  /** The plants of one square, worked out once. */
  private square(i: number, j: number): Float32Array {
    const key = `${i},${j}`;
    let list = this.plants.get(key);
    if (list) return list;
    const x0 = i * CELL;
    const z0 = j * CELL;
    const woods = (this.woodAt.get(`${Math.floor((x0 + CELL / 2) / 64)},${Math.floor((z0 + CELL / 2) / 64)}`) ?? []).filter(
      (w) => w.box[0] < x0 + CELL && w.box[2] > x0 && w.box[1] < z0 + CELL && w.box[3] > z0,
    );
    const out: number[] = [];
    if (woods.length) {
      let s = ((((i * 73856093) ^ (j * 19349663)) >>> 0) % 2147483646) + 1;
      const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      const near: [number, number][] = [];
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) near.push(...(this.trunks.get(`${i + a},${j + b}`) ?? []));
      const n = Math.round(CELL * CELL * DENSITY);
      for (let k = 0; k < n; k++) {
        const x = x0 + rand() * CELL;
        const z = z0 + rand() * CELL;
        const roll = rand();
        const size = rand();
        const turn = rand() * Math.PI * 2;
        const colour = rand();
        const rank = rand();
        const wood = woods.find((w) => inside(x, z, w.rings));
        if (!wood || near.some(([tx, tz]) => Math.hypot(tx - x, tz - z) < TRUNK)) continue;
        // Ferns in patches, brambles in thickets: a slow wave over the floor says where each grows best.
        const patch = 0.5 + 0.5 * Math.sin(x * 0.19 + z * 0.07) * Math.sin(z * 0.23 - x * 0.05);
        const kind = roll < 0.6 ? (patch > 0.3 ? Kind.Fern : -1) : roll < 0.78 ? (patch < 0.6 ? Kind.Bramble : -1) : roll < 0.93 ? Kind.Shrub : roll < 0.955 ? Kind.Branch : -1;
        if (kind < 0) continue;
        out.push(x, terrain.height(x, z) + wood.y, z, kind, size, turn, colour, rank);
      }
    }
    list = new Float32Array(out);
    this.plants.set(key, list);
    return list;
  }

  /** Gather the plants round the eye again once it has moved a few metres. */
  update(eye: THREE.Vector3): void {
    if (!this.woods.length) return;
    if (Math.hypot(eye.x - this.last.x, eye.z - this.last.z) < 4 && Math.abs(eye.y - this.last.y) < 4) return;
    this.last.copy(eye);
    const counts = new Array(KINDS).fill(0);
    // High up (a jump, a flight) there is nothing to gather: they would all have shrunk away.
    const above = eye.y - terrain.height(eye.x, eye.z);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const at = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const reach2 = this.reach * this.reach;
    if (above < this.reach) {
      const r = Math.ceil(this.reach / CELL);
      const ci = Math.floor(eye.x / CELL);
      const cj = Math.floor(eye.z / CELL);
      for (let i = ci - r; i <= ci + r; i++) {
        for (let j = cj - r; j <= cj + r; j++) {
          const list = this.square(i, j);
          for (let k = 0; k < list.length; k += 8) {
            const kind = list[k + 3];
            if (list[k + 7] > this.share || counts[kind] >= CAPACITY[kind]) continue;
            const dx = list[k] - eye.x;
            const dz = list[k + 2] - eye.z;
            if (dx * dx + dz * dz > reach2) continue;
            const size = list[k + 4];
            q.setFromAxisAngle(up, list[k + 5]);
            if (kind === Kind.Fern) scale.setScalar(0.7 + size * 0.7);
            else if (kind === Kind.Bramble) scale.set(1.1 + size * 1.2, 0.8 + size * 0.5, 1 + size * 1.0);
            else if (kind === Kind.Shrub) scale.set(0.9 + size * 0.9, 0.8 + size * 0.8, 0.9 + size * 0.9);
            else scale.set(1.5 + size * 2.5, 0.08 + size * 0.08, 0.08 + size * 0.08);
            at.set(list[k], list[k + 1], list[k + 2]);
            const mesh = this.meshes[kind];
            mesh.setMatrixAt(counts[kind], m.compose(at, q, scale));
            const colours = COLOURS[kind as Kind];
            mesh.setColorAt(counts[kind], colours[Math.floor(list[k + 6] * colours.length) % colours.length]);
            counts[kind]++;
          }
        }
      }
    }
    this.meshes.forEach((mesh, k) => {
      mesh.count = counts[k];
      mesh.visible = counts[k] > 0;
      if (counts[k]) {
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, counts[k] * 16);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor!.clearUpdateRanges();
        mesh.instanceColor!.addUpdateRange(0, counts[k] * 3);
        mesh.instanceColor!.needsUpdate = true;
      }
    });
  }
}
