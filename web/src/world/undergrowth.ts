import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { terrain } from './terrain';
import { wind } from './wind';
import { leafLight, leafy } from './leaves';
import { bushCards } from './cardTrees';
import { CUT, leafAtlas, watchCards } from './leafCards';
import { reflectionSkips } from './reflections';
import { WASH_GLSL, washUniforms } from './washShader';

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
 *
 * The plants themselves are our own models (tools/undergrowth.py, public/models/undergrowth.glb), fetched once:
 * bracken in three looks (the last green fronds upright, dead brown ones arching over or collapsed flat), two
 * bramble mounds, holly, hazel and a young beech, and a fallen branch, a log or a stump; every leaflet real,
 * opaque geometry. Each in two levels of detail: the near model within a dozen metres of the eye (five on Low and
 * phones), the far one, a tenth of its triangles, beyond. Which model a plant is follows from its place, as the
 * rest. Until the file is there (or if it can't be fetched), the simple shapes below stand in.
 */

const CELL = 16;
/**
 * What stands where, as the big open-world games lay out a forest's floor: a map of density per kind, each candidate
 * point kept or dropped by it, the kinds in layers that answer to each other. On average per square metre as before
 * (about 0.13 bracken, 0.03 bramble, 0.045 shrub, 0.0075 fallen wood), but clumped: bracken in stands of a few to a
 * few tens of metres (a third of the floor) with leaf litter between them, brambles where the light comes in, shrubs
 * in twos and threes.
 */
const BRACKEN_TRIES = 115;
/** The chance a bracken candidate between the stands is kept anyway */
const STRAY = 0.03;
const BRAMBLE_TRIES = 65;
/** Groups of shrubs per square, on average (two or three shrubs each) */
const SHRUB_GROUPS = 4.6;
const WOOD_TRIES = 2;
/** Numbers per plant in a square's list: x, y, z, kind, size, turn, colour, rank, look (how deep in its stand) */
const STRIDE = 9;

/** A number from 0 to 1 per corner of a grid of 1, the same everywhere for everyone. */
function hash2(ix: number, iz: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/** Smooth value noise from 0 to 1, features about 1 apart. */
function noise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

function smooth(e0: number, e1: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** How much a spot lies in a bracken stand, 0 to 1: stands of about 26 m with ragged edges, a third of the floor. */
function standAt(x: number, z: number): number {
  return smooth(0.55, 0.65, 0.65 * noise(x / 26, z / 26) + 0.35 * noise(x / 9 + 17.3, z / 9 - 4.1));
}
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

/** Whether a plant at (x, z) would stand on or hang over the area: its foot or a spot 0.6 m round it inside. */
function overArea(x: number, z: number, rings: Ring[]): boolean {
  return inside(x, z, rings) || inside(x + 0.6, z, rings) || inside(x - 0.6, z, rings) || inside(x, z + 0.6, rings) || inside(x, z - 0.6, rings);
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

/** The models of each kind in public/models/undergrowth.glb (each also as `<name>Far`), and how often each stands. */
const MODELS: Record<Kind, [string, number][]> = {
  // Most bracken dead by late November: brown, arching over or collapsed; a fifth still green.
  [Kind.Fern]: [['BrackenGreen', 0.2], ['BrackenArch', 0.45], ['BrackenFlat', 0.35]],
  [Kind.Bramble]: [['Bramble1', 0.5], ['Bramble2', 0.5]],
  [Kind.Shrub]: [['Holly', 0.35], ['Hazel', 0.35], ['Beech', 0.3]],
  [Kind.Branch]: [['Branch', 0.55], ['Log', 0.25], ['Stump', 0.2]],
};
/** Each model copy's tint (the models carry their own colours): a little lighter, darker, warmer or greyer. */
const TINTS = ['#ffffff', '#f2ebe2', '#fff8ee', '#e6e2dc', '#f8f0dc'].map((c) => new THREE.Color(c));
/** Near copies of each kind at most (within NEAR of the eye). */
const NEAR_CAPACITY = [500, 160, 220, 40];
/** Triangles of all near copies together, per preset (High and Ultra, Medium, Low and phones). */
const NEAR_TRIS = { high: 160_000, medium: 85_000, low: 25_000 };

/** One instanced mesh of the models: a kind's variant, near or far. */
interface Planted {
  mesh: THREE.InstancedMesh;
  count: number;
  /** Triangles of one copy */
  tris: number;
}

/** A plant gathered round the eye: its square's list and place in it, its model, its distance squared, near or far. */
interface Gathered {
  list: Float32Array;
  k: number;
  v: number;
  d2: number;
  near: boolean;
}

/**
 * Which model a plant is, from its own number: for bracken also by how deep in its stand it stands (`look`): more
 * collapsed fronds at a stand's ragged edge and between stands, more standing and arching ones in its middle.
 */
function variant(kind: Kind, colour: number, look: number): number {
  const shares = kind !== Kind.Fern ? MODELS[kind].map(([, share]) => share) : look > 0.6 ? [0.25, 0.55, 0.2] : look > 0.15 ? [0.15, 0.35, 0.5] : [0.1, 0.3, 0.6];
  let v = 0;
  for (let pick = colour; v < shares.length - 1 && pick >= shares[v]; v++) pick -= shares[v];
  return v;
}

export class Undergrowth {
  readonly group = new THREE.Group();
  private woods: Wood[] = [];
  /** Woods by squares of 64 m that their box touches */
  private woodAt = new Map<string, Wood[]>();
  /** Tree trunks by squares of CELL */
  private trunks = new Map<string, [number, number][]>();
  /**
   * Ground where nothing grows though the open data's wood covers it, by square of 64 m: a road, a path, paving,
   * gravel, concrete, a terrace, a building, a hedge, water (every ground cover but the wood's own floor), and the
   * open ground a place keeps clear (the Sparrenhof's forecourt and terrace: `addBare`).
   */
  private bare = new Map<string, { rings: Ring[]; box: [number, number, number, number] }[]>();
  /** Per square of CELL: x, y, z, kind, size, turn, colour, rank for every plant in it */
  private plants = new Map<string, Float32Array>();
  private meshes: THREE.InstancedMesh[] = [];
  /** The brambles' and shrubs' two looks: smooth leafy lumps (Low, phones) or leaf cards (Medium and up) */
  private looks: { lumps: THREE.BufferGeometry[]; cards: THREE.BufferGeometry[]; lump: THREE.Material; card: THREE.MeshStandardMaterial };
  private reach = 55;
  private share = 1;
  private last = new THREE.Vector3(Infinity, 0, 0);
  private reachUniform = { value: 55 };
  /** The models' meshes once fetched: per kind, per model, [near, far] */
  private planted: Planted[][][] | null = null;
  /** Metres from the eye within which the near models stand */
  private near = 12;
  /** Triangles the near models may take in all: the nearest plants get them first */
  private nearBudget = NEAR_TRIS.high;
  private gathered: Gathered[] = [];

  constructor(shade?: GroundShadeUniforms) {
    const geometries = [fernGeometry(), lumpGeometry(1.3, 0.75, 0.2), lumpGeometry(4.1, 1.2, 0.5), branchGeometry()];
    const fern = this.material('fern', shade);
    // The lumps with leaves, as the hedges' (world/leaves.ts): clumps of about 12 cm, a ragged outline.
    const lump = this.material('lump', shade);
    leafy(lump, 0.8, 0.55, 0.3);
    const wood = this.material('wood', shade);
    const materials = [fern, lump, lump, wood];
    // Medium and up, brambles and shrubs of leaf cards instead (world/cardTrees.ts bushCards), with the same light.
    const card = this.material('cards', shade);
    this.looks = { lumps: [geometries[Kind.Bramble], geometries[Kind.Shrub]], cards: [bushCards(0.75, 26, 31), bushCards(1.2, 40, 47)], lump, card };
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
    reflectionSkips.objects.add(this.group); // not in the reflections (world/reflections.ts)
    // The brambles and shrubs: leaf cards while the trees are (world/leafCards.ts: Medium and up, once painted).
    watchCards((full) => {
      if (this.planted) return; // the models stand instead
      if (full && !card.map) {
        card.map = leafAtlas();
        card.needsUpdate = true;
      }
      [Kind.Bramble, Kind.Shrub].forEach((k, i) => {
        this.meshes[k].geometry = full ? this.looks.cards[i] : this.looks.lumps[i];
        this.meshes[k].material = full ? card : lump;
      });
    });
    // The plants as our own models, once fetched (the shapes above stand in until then, or if they can't be).
    const plant = this.material('plant', shade);
    new GLTFLoader().loadAsync('/models/undergrowth.glb').then(
      (gltf) => this.useModels(gltf.scene, [fern, plant, plant, wood]),
      () => {},
    );
  }

  /** Put the models in the shapes' place: an instanced mesh per model, near and far. */
  private useModels(root: THREE.Object3D, materials: THREE.Material[]): void {
    root.updateMatrixWorld(true);
    const geometry = (name: string): THREE.BufferGeometry | null => {
      const o = root.getObjectByName(name);
      if (!(o instanceof THREE.Mesh)) return null;
      const source = o.geometry as THREE.BufferGeometry;
      const g = new THREE.BufferGeometry();
      g.setIndex(source.index);
      g.setAttribute('position', source.getAttribute('position'));
      // The corners' colours as three numbers each (the file has four bytes): the same shader as the shapes'.
      const c = source.getAttribute('color');
      const rgb = new Float32Array(c.count * 3);
      for (let i = 0; i < c.count; i++) rgb.set([c.getX(i), c.getY(i), c.getZ(i)], i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
      g.applyMatrix4(o.matrixWorld);
      g.computeVertexNormals();
      g.computeBoundingSphere();
      return g;
    };
    const sets: [THREE.BufferGeometry, THREE.BufferGeometry][][] = [];
    for (let k = 0; k < KINDS; k++) {
      const list: [THREE.BufferGeometry, THREE.BufferGeometry][] = [];
      for (const [name] of MODELS[k as Kind]) {
        const near = geometry(name);
        const far = geometry(`${name}Far`);
        if (!near || !far) return; // not the file we know: the shapes stay
        list.push([near, far]);
      }
      sets.push(list);
    }
    this.planted = sets.map((list, k) =>
      list.map((pair, v) =>
        pair.map((g, lod) => {
          const mesh = new THREE.InstancedMesh(g, materials[k], lod ? CAPACITY[k] : NEAR_CAPACITY[k]);
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          mesh.setColorAt(0, new THREE.Color(1, 1, 1));
          mesh.count = 0;
          mesh.visible = false;
          mesh.frustumCulled = false; // the copies spread round the eye; the reach keeps them few
          mesh.userData.ignoreRay = true;
          mesh.raycast = () => {};
          mesh.name = `undergrowth ${MODELS[k as Kind][v][0]} ${lod ? 'far' : 'near'}`;
          this.group.add(mesh);
          return { mesh, count: 0, tris: g.index ? g.index.count / 3 : g.getAttribute('position').count / 3 };
        }),
      ),
    );
    for (const mesh of this.meshes) {
      this.group.remove(mesh);
      mesh.dispose();
    }
    for (const g of new Set([...this.meshes.map((m) => m.geometry), ...this.looks.lumps, ...this.looks.cards])) g.dispose();
    this.meshes = [];
    this.last.set(Infinity, 0, 0);
  }

  /**
   * The plants' material: the ground's shade at the foot, growing in with the reach, ferns swaying (the models of
   * bramble and shrubs, `plant`, a little); lit as leaves are (the lumps get that from leafy(), with their leaves).
   */
  private material(kind: 'fern' | 'lump' | 'wood' | 'cards' | 'plant', shade?: GroundShadeUniforms): THREE.MeshStandardMaterial {
    const fern = kind === 'fern';
    const cards = kind === 'cards';
    const plant = kind === 'plant';
    const sway = fern ? 0.06 : plant ? 0.025 : 0;
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: fern || cards || plant ? THREE.DoubleSide : THREE.FrontSide, alphaTest: cards ? CUT : 0 });
    m.onBeforeCompile = (shader) => {
      shader.uniforms.ugReach = this.reachUniform;
      shader.uniforms.windTime = wind.time;
      shader.uniforms.windStrength = wind.strength;
      Object.assign(shader.uniforms, { windDir: wind.dir, windSpeed: wind.speed });
      if (shade) Object.assign(shader.uniforms, { ugShade: shade.groundShade, ugShadeAll: shade.groundShadeAll, ugArea: shade.groundArea, ugAreaAll: shade.groundAreaAll });
      if (sway) Object.assign(shader.uniforms, washUniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          ${sway ? WASH_GLSL : ''}
          uniform float ugReach;
          uniform float windTime;
          uniform float windStrength;
          uniform vec2 windDir;
          uniform float windSpeed;
          varying vec2 vUgLight;
          ${shade ? 'uniform sampler2D ugShade;\nuniform sampler2D ugShadeAll;\nuniform vec3 ugArea;\nuniform vec3 ugAreaAll;' : ''}`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vec3 ugRoot = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          // Grown in towards the edge of the reach: nothing pops in or out.
          transformed *= smoothstep(ugReach, ugReach * 0.72, distance(cameraPosition, ugRoot));
          ${sway ? `transformed.xz += windDir * sin(windTime * 1.6 + ugRoot.x * 0.4 + ugRoot.z * 0.3) * ${sway.toFixed(3)} * transformed.y * windStrength * windSpeed;` : ''}
          ${sway ? `transformed.xz += washAt(ugRoot.xz).xy * ${(sway * 8).toFixed(3)} * transformed.y; // a helicopter's rotor wash (world/rotorWash.ts)` : ''}
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
      shader.fragmentShader = (kind === 'lump' ? shader.fragmentShader : leafLight(shader.fragmentShader, fern ? 0.5 : cards || plant ? 0.35 : 0))
        // Leaf cards: both sides of a card lit alike, by the bush's shape (world/leafCards.ts).
        .replace('#include <normal_fragment_begin>', cards ? '#include <normal_fragment_begin>\n#ifdef DOUBLE_SIDED\nnormal *= faceDirection;\n#endif' : '#include <normal_fragment_begin>')
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
    for (const p of prisms ?? []) if (p.m !== 'forest') this.addBare([p.p]);
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

  /** Ground where no plant may stand (each a polygon: its outline, then any holes), on top of any wood. */
  addBare(polygons: Ring[][]): void {
    for (const rings of polygons) {
      if (!rings[0]?.length) continue;
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const [x, z] of rings[0]) {
        x0 = Math.min(x0, x);
        z0 = Math.min(z0, z);
        x1 = Math.max(x1, x);
        z1 = Math.max(z1, z);
      }
      const area = { rings, box: [x0, z0, x1, z1] as [number, number, number, number] };
      for (let i = Math.floor(x0 / 64); i <= Math.floor(x1 / 64); i++) {
        for (let j = Math.floor(z0 / 64); j <= Math.floor(z1 / 64); j++) {
          const key = `${i},${j}`;
          const list = this.bare.get(key);
          if (list) list.push(area);
          else this.bare.set(key, [area]);
        }
      }
    }
    this.plants.clear();
    this.last.set(Infinity, 0, 0);
  }

  /** The graphics preset: how far the undergrowth reaches and how much of it stands. */
  setQuality(quality: string, phone: boolean): void {
    const low = quality === 'low' || phone;
    this.reach = low ? 32 : quality === 'medium' ? 45 : 55;
    this.share = low ? 0.5 : quality === 'medium' ? 0.75 : 1;
    // The near models within a dozen metres (Medium ten); on Low and phones only those at your feet.
    this.near = low ? 5 : quality === 'medium' ? 10 : 12;
    this.nearBudget = low ? NEAR_TRIS.low : quality === 'medium' ? NEAR_TRIS.medium : NEAR_TRIS.high;
    this.reachUniform.value = this.reach;
    this.last.set(Infinity, 0, 0);
    // The brambles and shrubs follow the trees: leaf cards or lumps (the constructor's watchCards).
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
    const bare = (this.bare.get(`${Math.floor((x0 + CELL / 2) / 64)},${Math.floor((z0 + CELL / 2) / 64)}`) ?? []).filter(
      (b) => b.box[0] < x0 + CELL && b.box[2] > x0 && b.box[1] < z0 + CELL && b.box[3] > z0,
    );
    if (woods.length) {
      let s = ((((i * 73856093) ^ (j * 19349663)) >>> 0) % 2147483646) + 1;
      const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      const near: [number, number][] = [];
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) near.push(...(this.trunks.get(`${i + a},${j + b}`) ?? []));
      // Open ground near: the wood's edge, a path, a clearing (any spot 6 m off that is no wood floor), on a grid of 4 m.
      const open = new Array<boolean>(25);
      const floorAt = (x: number, z: number) =>
        (this.woodAt.get(`${Math.floor(x / 64)},${Math.floor(z / 64)}`) ?? []).some((w) => inside(x, z, w.rings)) &&
        !(this.bare.get(`${Math.floor(x / 64)},${Math.floor(z / 64)}`) ?? []).some((b) => x > b.box[0] && x < b.box[2] && z > b.box[1] && z < b.box[3] && inside(x, z, b.rings));
      const openNear = (x: number, z: number) => {
        const g = Math.min(4, Math.round((x - x0) / 4)) * 5 + Math.min(4, Math.round((z - z0) / 4));
        if (open[g] === undefined) {
          const gx = x0 + Math.floor(g / 5) * 4;
          const gz = z0 + (g % 5) * 4;
          open[g] = !floorAt(gx + 6, gz) || !floorAt(gx - 6, gz) || !floorAt(gx, gz + 6) || !floorAt(gx, gz - 6);
        }
        return open[g];
      };
      // One candidate: on the wood's floor, off the trunks, not on paving, gravel, a terrace, a path or in a building.
      const plant = (kind: Kind, x: number, z: number, size: number, turn: number, colour: number, rank: number, look: number) => {
        if (x < x0 || x >= x0 + CELL || z < z0 || z >= z0 + CELL) return;
        const wood = woods.find((w) => inside(x, z, w.rings));
        if (!wood || near.some(([tx, tz]) => Math.hypot(tx - x, tz - z) < TRUNK)) return;
        if (bare.some((b) => x > b.box[0] - 0.6 && x < b.box[2] + 0.6 && z > b.box[1] - 0.6 && z < b.box[3] + 0.6 && overArea(x, z, b.rings))) return;
        out.push(x, terrain.height(x, z) + wood.y, z, kind, size, turn, colour, rank, look);
      };
      // Bracken in stands: the stand map (standAt) says how likely each candidate is kept, several times today's
      // average inside a stand, a stray frond between them.
      for (let k = 0; k < BRACKEN_TRIES; k++) {
        const x = x0 + rand() * CELL;
        const z = z0 + rand() * CELL;
        const keep = rand();
        const size = rand();
        const turn = rand() * Math.PI * 2;
        const colour = rand();
        const rank = rand();
        const stand = standAt(x, z);
        if (keep < Math.max(stand, STRAY)) plant(Kind.Fern, x, z, size, turn, colour, rank, stand);
      }
      // Brambles where there is light: along the wood's edges, its paths and clearings, and where no trunk stands
      // within 5 m; in thickets (a second, finer map), and seldom inside a bracken stand.
      for (let k = 0; k < BRAMBLE_TRIES; k++) {
        const x = x0 + rand() * CELL;
        const z = z0 + rand() * CELL;
        const keep = rand();
        const size = rand();
        const turn = rand() * Math.PI * 2;
        const colour = rand();
        const rank = rand();
        if (keep > 0.6) continue; // most candidates go before the tests below, which cost more
        const light = openNear(x, z) ? 1 : near.some(([tx, tz]) => Math.hypot(tx - x, tz - z) < 5) ? 0.06 : 0.45;
        const thicket = 0.35 + 0.65 * smooth(0.35, 0.65, noise(x / 7 - 31.7, z / 7 + 12.9));
        if (keep < 0.6 * light * thicket * (1 - 0.8 * standAt(x, z))) plant(Kind.Bramble, x, z, size, turn, colour, rank, 0);
      }
      // Shrubs in twos and threes, one kind to a group (the group's own number picks it).
      const groups = Math.floor(SHRUB_GROUPS + rand());
      for (let g = 0; g < groups; g++) {
        const cx = x0 + rand() * CELL;
        const cz = z0 + rand() * CELL;
        const colour = rand();
        const members = 2 + (rand() < 0.5 ? 1 : 0);
        for (let k = 0; k < members; k++) {
          const a = rand() * Math.PI * 2;
          const r = k ? 0.8 + rand() * 0.9 : 0;
          plant(Kind.Shrub, cx + Math.cos(a) * r, cz + Math.sin(a) * r, rand(), rand() * Math.PI * 2, colour, rand(), rand());
        }
      }
      // The odd fallen branch, log or stump, anywhere.
      for (let k = 0; k < WOOD_TRIES; k++) {
        const x = x0 + rand() * CELL;
        const z = z0 + rand() * CELL;
        const keep = rand();
        const size = rand();
        const turn = rand() * Math.PI * 2;
        const colour = rand();
        const rank = rand();
        if (keep < 0.95) plant(Kind.Branch, x, z, size, turn, colour, rank, 0);
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
    const near2 = this.near * this.near;
    const gathered = this.gathered;
    gathered.length = 0;
    if (above < this.reach) {
      const r = Math.ceil(this.reach / CELL);
      const ci = Math.floor(eye.x / CELL);
      const cj = Math.floor(eye.z / CELL);
      for (let i = ci - r; i <= ci + r; i++) {
        for (let j = cj - r; j <= cj + r; j++) {
          const list = this.square(i, j);
          for (let k = 0; k < list.length; k += STRIDE) {
            const kind = list[k + 3];
            if (list[k + 7] > this.share || counts[kind] >= CAPACITY[kind]) continue;
            const dx = list[k] - eye.x;
            const dz = list[k + 2] - eye.z;
            const d2 = dx * dx + dz * dz;
            if (d2 > reach2) continue;
            const size = list[k + 4];
            q.setFromAxisAngle(up, list[k + 5]);
            at.set(list[k], list[k + 1], list[k + 2]);
            const colour = list[k + 6];
            if (this.planted) {
              // The models: gathered first, then the nearest made near models while the near budget lasts.
              gathered.push({ list, k, v: variant(kind, colour, list[k + 8]), d2, near: false });
              counts[kind]++;
              continue;
            }
            if (kind === Kind.Fern) scale.setScalar(0.7 + size * 0.7);
            else if (kind === Kind.Bramble) scale.set(1.1 + size * 1.2, 0.8 + size * 0.5, 1 + size * 1.0);
            else if (kind === Kind.Shrub) scale.set(0.9 + size * 0.9, 0.8 + size * 0.8, 0.9 + size * 0.9);
            else scale.set(1.5 + size * 2.5, 0.08 + size * 0.08, 0.08 + size * 0.08);
            const mesh = this.meshes[kind];
            mesh.setMatrixAt(counts[kind], m.compose(at, q, scale));
            const colours = COLOURS[kind as Kind];
            mesh.setColorAt(counts[kind], colours[Math.floor(colour * colours.length) % colours.length]);
            counts[kind]++;
          }
        }
      }
    }
    if (this.planted) {
      // The near models for the nearest plants, until the preset's budget of triangles is spent: in a dense stand
      // at your feet the near ring is a little shorter, never thinner.
      const nearest = gathered.filter((p) => p.d2 < near2).sort((a, b) => a.d2 - b.d2);
      let budget = this.nearBudget;
      for (const p of nearest) {
        const slot = this.planted[p.list[p.k + 3]][p.v][0];
        if (slot.tris > budget) break;
        if (slot.count >= NEAR_CAPACITY[p.list[p.k + 3]]) continue;
        budget -= slot.tris;
        slot.count++;
        p.near = true;
      }
      for (const kind of this.planted) for (const pair of kind) pair[0].count = 0;
      const lean = new THREE.Quaternion();
      const side = new THREE.Vector3(1, 0, 0);
      for (const { list, k, v, near } of gathered) {
        const kind = list[k + 3] as Kind;
        const slot = this.planted[kind][v][near ? 0 : 1];
        const size = list[k + 4];
        const colour = list[k + 6];
        // Sizes vary more than before, and each leans a little its own way: a stand reads as one mass, not copies.
        if (kind === Kind.Fern) scale.setScalar(0.85 + size * 0.65);
        else if (kind === Kind.Bramble) scale.set(0.85 + size * 0.4, 0.8 + size * 0.35, 0.85 + size * 0.4);
        else if (kind === Kind.Shrub) scale.setScalar(0.8 + size * 0.45);
        else scale.setScalar(0.75 + size * 0.5);
        q.setFromAxisAngle(up, list[k + 5]);
        if (kind !== Kind.Branch) q.multiply(lean.setFromAxisAngle(side, (((colour * 313) % 1) - 0.5) * 0.3));
        at.set(list[k], list[k + 1], list[k + 2]);
        slot.mesh.setMatrixAt(slot.count, m.compose(at, q, scale));
        slot.mesh.setColorAt(slot.count, TINTS[Math.floor(((colour * 977 + size * 31) % 1) * TINTS.length)]);
        slot.count++;
      }
    }
    const show = (mesh: THREE.InstancedMesh, count: number) => {
      mesh.count = count;
      mesh.visible = count > 0;
      if (count) {
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, count * 16);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor!.clearUpdateRanges();
        mesh.instanceColor!.addUpdateRange(0, count * 3);
        mesh.instanceColor!.needsUpdate = true;
      }
    };
    this.meshes.forEach((mesh, k) => show(mesh, counts[k]));
    for (const kind of this.planted ?? []) {
      for (const pair of kind) {
        for (const slot of pair) {
          show(slot.mesh, slot.count);
          slot.count = 0;
        }
      }
    }
  }
}
