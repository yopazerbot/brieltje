import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { World } from './collision';
import type { Doors } from './doors';
import { fixtureGroup } from './furnishing';
import type { Glass } from './glass';
import type { DipSpec, DoorSpec, FixtureSpec, Prism, Ring } from './houseData';
import { prismGeometry, surfaceMaterial } from './houseMeshes';
import type { GroundCuts } from './terrain';

/**
 * A street model's house you can walk into: the end house of the new terrace at Molenhoek
 * (tools/molenhoek_end_inside.py writes its inside, web/src/data/molenhoek_end_inside.json). Its
 * walls, floors, ceilings, stair, kitchen and bathroom are blocks (one mesh per surface, the
 * plain-coloured ones in one with their colour per vertex), its furniture the planner's pieces or
 * simple shapes in that style, its doors the house's door system and its windows breakable panes.
 *
 * It is drawn only within NEAR metres. Further off the street model's own panes and front door
 * stand in its openings (meshes of their own in the model, `shut`), so from afar it costs nothing
 * but its blocks for walking into, which only the spots near it ever look at.
 *
 * The sun's real-time shadow only covers the main house, so here the sun would light floors and
 * walls through the roof: the inside's surfaces take no direct sun (sunless), only the sky's and
 * the room's light, which world/indoorLight.ts makes warmer and stronger indoors.
 *
 * The relief there lies up to 40 cm above the floor (the street model's floor level is the village
 * block's foot): the ground is cut out under the house and its garden, as for a pond, and a dip
 * lowers the ground for walking there, so the floors are what you stand on. The garden's lawn lies
 * at the floor's level too, inside its fences (the street model has them, its terrace and its shed),
 * drawn in the ground's own material, which takes its look from where it lies.
 */
const NEAR = 60;
/** The windows' numbers for breaking them: after the house's own blocks (fewer than 2000), before the doors' glass (3000). */
export const WALK_IN_GLASS = 2000;

interface Block {
  m: string;
  c?: string;
  y0: number;
  y1: number;
  p: Ring[];
  n?: string;
  /** 0: not walked into (drawn only) */
  s?: number;
  /** 0: not drawn (walked into only) */
  v?: number;
}

interface Data {
  frame: { o: [number, number]; a: number; floor: number };
  centre: [number, number];
  outline: [number, number][];
  levels: { id: string; name: string; floor: number }[];
  rooms: string[];
  prisms: Block[];
  parts: (string | number | number[][])[][];
  fixtures: FixtureSpec[];
  props: { model: string; x: number; y: number; z: number; yaw: number }[];
  doors: DoorSpec[];
  panes: { p: Ring[]; y0: number; y1: number; matte?: number }[];
  groundCuts: GroundCuts;
  dip: DipSpec;
  /** The garden inside its fences, at the lawn's height (world x, z) */
  lawn: { p: [number, number][]; y: number };
  /** The house's plot: the village's ground covers, hedges and fences in it give way to the garden */
  plot: [number, number][];
}

/** Patterns of the plain mesh (see patterns()). */
const PATTERN = { none: 0, tiles: 1, screed: 2, bath: 3, oak: 4, paint: 5, planks: 6 };

/**
 * Each surface: the pattern the shader draws it with (no textures: every surface of the inside is in one mesh, one
 * draw), its roughness, its tint where a block gives none, and what it is walked and hit on as (its footsteps).
 */
const SURFACES: Record<string, { pattern: number; rough: number; tint: string; hit: string }> = {
  wall: { pattern: PATTERN.paint, rough: 0.9, tint: '#f4f1ec', hit: 'plaster' },
  ceiling: { pattern: PATTERN.paint, rough: 0.9, tint: '#f7f5f1', hit: 'plaster' },
  wood: { pattern: PATTERN.planks, rough: 0.6, tint: '#c9b79f', hit: 'floor_wood' },
  oak: { pattern: PATTERN.oak, rough: 0.5, tint: '#d9ad78', hit: 'stair' },
  tile: { pattern: PATTERN.tiles, rough: 0.42, tint: '#b3b4b3', hit: 'floor_tile' },
  concrete: { pattern: PATTERN.screed, rough: 0.8, tint: '#9a9b99', hit: 'concrete' },
  bath: { pattern: PATTERN.bath, rough: 0.3, tint: '#ededeb', hit: 'floor_bath' },
  c: { pattern: PATTERN.none, rough: 0.62, tint: '#efede8', hit: 'plaster' },
};

const sunlessCache = new WeakMap<THREE.Material, THREE.Material>();
/** The lights' shader without the directional light's part (the sun: its light and its shadow map's lookups). */
const NO_SUN = (() => {
  const chunk = THREE.ShaderChunk.lights_fragment_begin;
  const start = chunk.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )');
  const end = chunk.indexOf('#endif', chunk.indexOf('#pragma unroll_loop_end', start));
  return start < 0 || end < 0 ? chunk : chunk.slice(0, start) + chunk.slice(end + '#endif'.length);
})();

/**
 * The sky's light without its reflection: the plain mesh's walls, floors and worktops reflect the light the sky
 * gives them (as rough surfaces do), not a picture of the sky, which indoors would be wrong anyway. One lookup in
 * the sky's map a pixel instead of two.
 */
const ROUGH_SKY = `
#if defined( RE_IndirectDiffuse ) && defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
  iblIrradiance += getIBLIrradiance( geometryNormal );
#endif
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
  radiance += iblIrradiance * RECIPROCAL_PI;
#endif
`;

/**
 * The material without the sun's direct light (the sky's and the room's still light it); the same
 * one for every use of a material. Glass and other see-through materials stay as they are.
 */
export function sunless<T extends THREE.Material>(m: T, patterned = false): T {
  const std = m as unknown as THREE.MeshStandardMaterial;
  if (!std.isMeshStandardMaterial || m.transparent) return m;
  if (!patterned && sunlessCache.has(m)) return sunlessCache.get(m) as T;
  const s = m.clone();
  const before = m.onBeforeCompile;
  const key = m.customProgramCacheKey();
  s.onBeforeCompile = (shader, renderer) => {
    before.call(s, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', NO_SUN);
    if (patterned) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_maps>', ROUGH_SKY);
      patterns(shader);
    }
  };
  s.customProgramCacheKey = () => `${key}|sunless${patterned ? '|patterns' : ''}`;
  if (!patterned) sunlessCache.set(m, s);
  return s;
}

const singleCache = new WeakMap<THREE.Material, THREE.Material>();
/**
 * See-through glass in one pass: three.js draws a two-sided see-through mesh twice (its back faces, then its
 * front), which a thin closed pane doesn't need.
 */
function onePass(m: THREE.Material): THREE.Material {
  if (!m.transparent || m.side !== THREE.DoubleSide) return m;
  let s = singleCache.get(m);
  if (!s) {
    s = m.clone();
    s.forceSinglePass = true;
    singleCache.set(m, s);
  }
  return s;
}

/**
 * The plain mesh's patterns, drawn in the shader (no texture): large grey floor tiles of 80 cm with a thin joint,
 * each a shade of its own; the garage's screed; small white tiles in the bathroom; oak planks upstairs; the oak of
 * the stair and the worktops in its grain; faint clouds on the paint; all softly clouded but the plain parts. The
 * pattern and the roughness come per vertex (`look`). The floor's joints line up with the inside faces of the front
 * and the free side wall.
 */
function patterns(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec2 look;\nvarying vec2 vLook;\nvarying vec2 vTileUv;')
    .replace('#include <uv_vertex>', '#include <uv_vertex>\nvLook = look;\nvTileUv = uv;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec2 vLook;\nvarying vec2 vTileUv;')
    .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vLook.y;')
    .replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      if (vLook.x > 0.5) {
        vec2 p = vTileUv;
        float cloud = 0.5 + 0.25 * sin(p.x * 2.3 + sin(p.y * 1.7)) * sin(p.y * 2.9 + sin(p.x * 1.3)) + 0.12 * sin(p.x * 9.1 + p.y * 7.3) * sin(p.y * 8.7 - p.x * 5.9);
        diffuseColor.rgb *= vLook.x > 4.5 && vLook.x < 5.5 ? 0.985 + 0.03 * cloud : 0.96 + 0.08 * cloud;
        if (vLook.x > 5.5) {
          // planks 19 cm wide and 1.2 m long, their ends staggered row by row, each a shade of its own
          float row = floor(p.y / 0.19);
          float x = p.x / 1.2 + fract(row * 0.37);
          vec2 f = vec2((0.5 - abs(fract(x) - 0.5)) * 1.2, (0.5 - abs(fract(p.y / 0.19) - 0.5)) * 0.19);
          float d = min(f.x, f.y);
          float joint = 1.0 - smoothstep(0.001, 0.001 + max(fwidth(d), 1e-4) * 1.5, d);
          float id = fract(sin(dot(vec2(row, floor(x)), vec2(12.9898, 78.233))) * 43758.5453);
          float grain = 0.5 + 0.5 * sin(p.x * 23.0 + 3.0 * sin(p.y * 31.0 + p.x * 1.3));
          diffuseColor.rgb *= (0.9 + 0.14 * id) * (0.95 + 0.06 * grain) * mix(1.0, 0.7, joint);
        } else if (vLook.x > 4.5) {
          // paint: the clouds alone, faint
        } else if (vLook.x > 3.5) {
          float grain = sin(p.x * 41.0 + 2.6 * sin(p.y * 2.3 + p.x * 0.7)) * 0.5 + 0.5;
          diffuseColor.rgb *= 0.9 + 0.08 * grain + 0.04 * sin(p.y * 13.0 + p.x * 3.0);
        } else if (vLook.x < 1.5 || vLook.x > 2.5) {
          bool bath = vLook.x > 2.5;
          vec2 size = bath ? vec2(0.6, 0.3) : vec2(0.8);
          vec2 q = (p - (bath ? vec2(0.0) : vec2(-0.40, 0.40))) / size;
          vec2 f = (0.5 - abs(fract(q) - 0.5)) * size; // metres to the joints across and along
          float d = min(f.x, f.y);
          float aa = max(fwidth(d), 1e-4);
          float joint = 1.0 - smoothstep(0.0016, 0.0016 + aa * 1.5, d);
          float id = fract(sin(dot(floor(q), vec2(12.9898, 78.233))) * 43758.5453);
          diffuseColor.rgb *= (bath ? 0.99 + 0.02 * id : 0.965 + 0.07 * id) * mix(1.0, bath ? 0.8 : 0.62, joint);
        }
      }`,
    );
}

/**
 * A colour per vertex for a geometry (made non-indexed so parts merge with blocks), and its `look`: the pattern
 * and roughness the plain mesh draws it with.
 */
function painted(g: THREE.BufferGeometry, hex: string, look: [number, number] = [PATTERN.none, 0.62]): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
  if (!geo.attributes.normal) geo.computeVertexNormals();
  for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
  const c = new THREE.Color(hex);
  const colors = new Float32Array(geo.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const looks = new Float32Array(geo.attributes.position.count * 2);
  for (let i = 0; i < looks.length; i += 2) looks.set(look, i);
  geo.setAttribute('look', new THREE.BufferAttribute(looks, 2));
  return geo;
}

const UP = new THREE.Vector3(0, 1, 0);

/** The simple shapes of tools/molenhoek_end_inside.py (box, rod, lathe, oval, beam, curtain), in the house's own frame. */
function part(p: (string | number | number[][])[]): THREE.BufferGeometry {
  const n = (i: number) => p[i] as number;
  switch (p[0]) {
    case 'b': { // box: x y z (bottom), w h d, yaw
      const g = new THREE.BoxGeometry(n(4), n(5), n(6)).translate(0, n(5) / 2, 0).rotateY(n(7)).translate(n(1), n(2), n(3));
      const look = SURFACES[String(p[9])] ?? SURFACES.c; // its surface (oak), else plain
      return painted(g, p[8] as string, [look.pattern, look.rough]);
    }
    case 'r': { // rod from a to b
      const a = new THREE.Vector3(n(1), n(2), n(3));
      const b = new THREE.Vector3(n(4), n(5), n(6));
      const dir = b.clone().sub(a);
      const g = new THREE.CylinderGeometry(n(7), n(7), dir.length(), n(9), 1, true);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize()));
      g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
      return painted(g, p[8] as string);
    }
    case 'l': { // lathe: a profile of (radius, height) round a vertical axis
      const pts = (p[4] as number[][]).map(([r, h]) => new THREE.Vector2(r, h));
      return painted(new THREE.LatheGeometry(pts, n(6)).translate(n(1), n(2), n(3)), p[5] as string);
    }
    case 'e': { // an oval slab: radii across x and z, height
      const g = new THREE.CylinderGeometry(1, 1, n(6), 32).scale(n(4), 1, n(5)).translate(n(1), n(2) + n(6) / 2, n(3));
      return painted(g, p[7] as string);
    }
    case 'k': { // a beam from a to b, w across and h high
      const a = new THREE.Vector3(n(1), n(2), n(3));
      const b = new THREE.Vector3(n(4), n(5), n(6));
      const x = b.clone().sub(a);
      const len = x.length();
      x.normalize();
      const z = x.clone().cross(UP);
      if (z.lengthSq() < 1e-6) z.set(1, 0, 0);
      z.normalize();
      const y = z.clone().cross(x).normalize();
      const g = new THREE.BoxGeometry(len, n(8), n(7));
      g.applyMatrix4(new THREE.Matrix4().makeBasis(x, y, z).setPosition((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2));
      return painted(g, p[9] as string);
    }
    case 's': { // a curtain from (x0, z0) to (x1, z1), folds of depth amp, both sides
      const [x0, z0, x1, z1, y0, y1, amp, folds] = [1, 2, 3, 4, 5, 6, 7, 8].map(n);
      const len = Math.hypot(x1 - x0, z1 - z0);
      const tx = (x1 - x0) / len;
      const tz = (z1 - z0) / len;
      const segs = folds * 6;
      const pos: number[] = [];
      const at = (k: number, y: number) => {
        const u = k / segs;
        const off = amp * Math.sin(u * folds * Math.PI * 2);
        return [x0 + tx * len * u - tz * off, y, z0 + tz * len * u + tx * off];
      };
      for (let k = 0; k < segs; k++) {
        const [a, b, c, d] = [at(k, y0), at(k + 1, y0), at(k + 1, y1), at(k, y1)];
        pos.push(...a, ...b, ...c, ...a, ...c, ...d, ...a, ...c, ...b, ...a, ...d, ...c);
      }
      const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      return painted(g, p[9] as string);
    }
  }
  return new THREE.BufferGeometry();
}

export interface WalkIn {
  /** Its inside near it, nothing from afar (added to the scene) */
  readonly group: THREE.Object3D;
  /** The names of its rooms (indoors there) */
  readonly rooms: string[];
  /** Whether a block of the village data is the one it replaces (its plain block and roof) */
  replaces(p: Prism): boolean;
  /** Where the ground is cut out under it (its terrace too), for the ground's pieces */
  readonly groundCuts: GroundCuts;
  /** Its blocks for walking into, its doors in the house's door system, its panes with the others */
  install(world: World, doors: Doors, glass: Glass): void;
  /** Whether (x, z) lies inside it */
  contains(x: number, z: number): boolean;
  /** Whether (x, z) lies in it or in its garden, inside the garden's fences */
  encloses(x: number, z: number): boolean;
  /** The garden's lawn at the floor's level, in the ground's material (`material`: the ground's own) */
  lawn(material: THREE.Material): THREE.Mesh;
  /** Its ground floor's height when (x, z) lies inside it */
  floorAt(x: number, z: number): number | null;
  /** The floor's name for feet at that height inside it, else null */
  level(x: number, z: number, feet: number): string | null;
}

/** How far (x, z) lies from the outline's edges. */
function edgeDistance(x: number, z: number, ring: [number, number][]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[j];
    const dx = ring[i][0] - ax;
    const dz = ring[i][1] - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
  }
  return best;
}

function inside(x: number, z: number, ring: [number, number][]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/** The end house's inside, once its data has come; `model` is the street model it stands in (molenhoek_end3). */
export async function loadWalkIn(renderer: THREE.WebGLRenderer, model: THREE.Object3D): Promise<WalkIn> {
  const data = (await import('../data/molenhoek_end_inside.json')).default as unknown as Data;
  const { o, a, floor } = data.frame;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const toWorld = ([x, z]: [number, number]): [number, number] => [o[0] + x * c + z * s, o[1] - x * s + z * c];
  const turn = ([x, z]: [number, number]): [number, number] => [x * c + z * s, -x * s + z * c];
  const [cx, cz] = data.centre;

  // Near: the inside in the house's own frame, and the doors (placed in the world by the door system).
  const lod = new THREE.LOD();
  lod.position.set(cx, floor, cz);
  const near = new THREE.Group();
  near.position.set(-cx, -floor, -cz);
  const local = new THREE.Group();
  local.position.set(o[0], floor, o[1]);
  local.rotation.y = a;
  const outDoors = new THREE.Group(); // the front door and the sliding door to the terrace
  const inDoors = new THREE.Group(); // the inside doors: drawn only from inside or close to the house
  near.add(local, outDoors, inDoors);
  lod.addLevel(near, 0);
  lod.addLevel(new THREE.Object3D(), NEAR);
  lod.name = 'walk-in';

  // Blocks and shapes: one mesh, coloured per vertex, its patterns drawn in the shader.
  const solid: THREE.BufferGeometry[] = [];
  const fixed: THREE.BufferGeometry[] = [];
  for (const b of data.prisms) {
    if (b.v === 0) continue;
    const g = prismGeometry({ m: b.m, y0: b.y0, y1: b.y1, p: b.p });
    if (b.m === 'glassfix') {
      fixed.push(g);
      continue;
    }
    const spec = SURFACES[b.m] ?? SURFACES.c;
    solid.push(painted(g, b.c ?? spec.tint, [spec.pattern, spec.rough]));
  }
  for (const p of data.parts) solid.push(part(p));
  const plain = new THREE.Mesh(mergeGeometries(solid), sunless(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }), true));
  plain.name = 'walk-in';
  plain.userData.material = 'plaster';
  // Its depth first, without colour: then each pixel of it is shaded once, by the surface in front, and not also
  // by the walls, rooms and floor behind it that one draw would otherwise shade in whatever order they come.
  const early = new THREE.Mesh(plain.geometry, new THREE.MeshBasicMaterial({ colorWrite: false }));
  early.name = 'walk-in:depth';
  early.renderOrder = -1;
  early.userData.ignoreRay = true;
  local.add(early, plain);

  // Furniture: the planner's pieces, in the house's own frame.
  // No shadows from them: the sun's would fall only inside, where it is not drawn (see sunless).
  const pieces = fixtureGroup(data.fixtures, (m) => sunless(m), false);
  if (pieces) local.add(pieces);

  // The toilets (our own model, tools/toilet.py), glossy, into the plain mesh once they come.
  if (data.props.length) {
    void new GLTFLoader().loadAsync('/models/toilet.glb').then((gltf) => {
      gltf.scene.updateMatrixWorld(true);
      const parts = [...solid];
      gltf.scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const color = '#' + (mesh.material as THREE.MeshStandardMaterial).color.getHexString(THREE.SRGBColorSpace);
        for (const p of data.props) {
          const at = new THREE.Matrix4().makeRotationY(p.yaw).setPosition(p.x, p.y, p.z).multiply(mesh.matrixWorld);
          parts.push(painted(mesh.geometry.clone().applyMatrix4(at), color, [PATTERN.none, 0.2]));
        }
      });
      plain.geometry.dispose();
      plain.geometry = early.geometry = mergeGeometries(parts);
    }, () => {}); // no model: no toilets
  }

  // The windows: all the glass in one mesh (a mesh a pane would be some twenty draws), made again when a pane
  // breaks or is mended. Each pane has a stand-in that isn't drawn, for shots
  // and blasts to find and for breaking (world/glass.ts hides it).
  const panes = new Map<number, THREE.Mesh>();
  const paneGeos = data.panes.map((p) => prismGeometry({ m: 'glass', y0: p.y0, y1: p.y1, p: p.p }));
  const broken = new Set<number>();
  // The glass's own see-through and colour per vertex: clear as the house's windows, the side light frosted.
  const tinted = (g: THREE.BufferGeometry, matte: boolean) => {
    const rgba = matte ? [0.87, 0.87, 0.88, 0.86] : [1, 1, 1, 0.18];
    const c = new Float32Array(g.attributes.position.count * 4);
    for (let i = 0; i < c.length; i += 4) c.set(rgba, i);
    g.setAttribute('color', new THREE.BufferAttribute(c, 4));
    return g;
  };
  fixed.forEach((g) => tinted(g, false));
  paneGeos.forEach((g, i) => tinted(g, !!data.panes[i].matte));
  const glassMat = surfaceMaterial('glass', renderer).clone() as THREE.MeshPhysicalMaterial;
  glassMat.vertexColors = true;
  glassMat.opacity = 1;
  glassMat.forceSinglePass = true; // a thin closed pane needs no second pass (see onePass)
  const glassAll = new THREE.Mesh(new THREE.BufferGeometry(), glassMat);
  const drawGlass = () => {
    const live = [...fixed, ...paneGeos.filter((_, i) => !broken.has(i))];
    glassAll.geometry.dispose();
    glassAll.geometry = live.length ? mergeGeometries(live) : new THREE.BufferGeometry();
  };
  drawGlass();
  glassAll.renderOrder = 1;
  glassAll.userData.ignoreRay = true; // shots find the stand-ins (and pass the shower's screen)
  local.add(glassAll);
  const unseen = new THREE.MeshBasicMaterial({ visible: false });
  paneGeos.forEach((geo, i) => {
    const pane = new THREE.Mesh(geo, unseen);
    pane.userData.glassIndex = WALK_IN_GLASS + i;
    panes.set(WALK_IN_GLASS + i, pane);
    local.add(pane);
  });

  // Far off, the model's own panes and front door in the openings; near, none.
  model.updateMatrixWorld(true);
  const centre = new THREE.Vector3(cx, floor, cz);
  const shut: THREE.Mesh[] = [];
  model.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh && (mesh.material as THREE.Material).userData.shut) shut.push(mesh);
  });
  for (const mesh of shut) {
    const parent = mesh.parent!;
    const swap = new THREE.LOD();
    swap.position.copy(parent.worldToLocal(centre.clone()));
    mesh.position.sub(swap.position);
    parent.add(swap);
    swap.addLevel(new THREE.Object3D(), 0);
    swap.addLevel(mesh, NEAR);
  }

  // For walking into: the blocks in the world, the panes apart (they break).
  const world = (b: { p: Ring[]; y0: number; y1: number }, m: string, n?: string): Prism => ({
    m, y0: b.y0 + floor, y1: b.y1 + floor, p: b.p.map((r) => r.map((q) => toWorld(q))), ...(n ? { n } : {}),
  });
  const blocks = data.prisms.filter((b) => b.s !== 0 && b.m !== 'glassfix').map((b) => world(b, SURFACES[b.m]?.hit ?? 'plaster', b.n));
  blocks.push(...data.prisms.filter((b) => b.m === 'glassfix').map((b) => world(b, 'glass')));
  const paneBlocks = data.panes.map((p) => world(p, 'glass'));
  const doorSpecs: DoorSpec[] = data.doors.map((d) => ({
    ...d,
    y0: d.y0 + floor,
    y1: d.y1 + floor,
    panels: d.panels.map((p) => ({ ...p, a: toWorld(p.a), b: toWorld(p.b), ...(p.slide ? { slide: turn(p.slide) } : {}) })),
  }));

  const outline = data.outline;
  // What is drawn first: from outside the street model's walls, so their depth turns away the inside behind them
  // before it is shaded; from inside the inside, so its walls turn away the world beyond them. three.js sorts by
  // each mesh's origin, which for the merged inside is a corner of the house, so it is set here per frame.
  let fromInside: boolean | null = null;
  const eye = new THREE.Vector3();
  const lodUpdate = lod.update.bind(lod);
  lod.update = (camera: THREE.Camera) => {
    lodUpdate(camera);
    camera.getWorldPosition(eye);
    const now = inside(eye.x, eye.z, outline) && eye.y < floor + 6.2;
    if (now !== fromInside) {
      fromInside = now;
      local.renderOrder = outDoors.renderOrder = inDoors.renderOrder = now ? -1 : 2; // a group's order comes first in the sort
    }
    inDoors.visible = now || edgeDistance(eye.x, eye.z, outline) < 3;
  };
  const mine = (p: Prism) => {
    const r = p.p[0];
    const mx = r.reduce((t, q) => t + q[0], 0) / r.length;
    const mz = r.reduce((t, q) => t + q[1], 0) / r.length;
    return inside(mx, mz, outline);
  };
  const contains = (x: number, z: number) => inside(x, z, outline);
  // The village's ground covers, hedges and fences in the plot (world/streetModel.ts marks them): neither drawn nor
  // walked on, as the garden lies lower than the relief they follow.
  const inPlot = (p: Prism) => {
    const r = p.p[0];
    const mx = r.reduce((t, q) => t + q[0], 0) / r.length;
    const mz = r.reduce((t, q) => t + q[1], 0) / r.length;
    return inside(mx, mz, data.plot) || edgeDistance(mx, mz, data.plot) < 0.3;
  };
  return {
    group: lod,
    rooms: data.rooms,
    groundCuts: data.groundCuts,
    replaces: (p) => p.lm === 'molenhoek_end3' && (p.d === undefined ? mine(p) : inPlot(p)),
    install(w, doors, glass) {
      w.addDips([data.dip]);
      w.addPrisms(blocks);
      const first = w.addPrisms(paneBlocks);
      glass.add(panes, (i, gone) => {
        w.setSolid(first + i - WALK_IN_GLASS, !gone);
        if (gone) broken.add(i - WALK_IN_GLASS);
        else broken.delete(i - WALK_IN_GLASS);
        drawGlass();
      });
      const look = (m: THREE.Material) => (m.transparent ? onePass(m) : sunless(m));
      const outside = (d: DoorSpec) => d.panels.some((p) => p.outside);
      for (const [specs, group] of [[doorSpecs.filter(outside), outDoors], [doorSpecs.filter((d) => !outside(d)), inDoors]] as const) {
        glass.add(doors.add(specs, group, look), (i, gone) => doors.setBroken(i, gone));
      }
      inDoors.traverse((o) => (o.castShadow = false)); // inside, nothing takes the sun's shadow
    },
    contains,
    encloses: (x, z) => contains(x, z) || inside(x, z, data.lawn.p),
    lawn(material) {
      const shape = new THREE.Shape(data.lawn.p.map(([x, z]) => new THREE.Vector2(x, -z)));
      // As the ground's pieces: positions in the world, texture coordinates (x, -z) in metres.
      const g = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(0, data.lawn.y, 0);
      const mesh = new THREE.Mesh(g, material);
      mesh.name = 'end house lawn';
      mesh.receiveShadow = true;
      mesh.renderOrder = 1; // as the ground
      mesh.userData.material = 'grass';
      return mesh;
    },
    floorAt: (x, z) => (contains(x, z) ? floor : null),
    level(x, z, feet) {
      if (!contains(x, z)) return null;
      let name = data.levels[0].name;
      for (const lv of data.levels) if (feet - floor >= lv.floor - 0.3) name = lv.name;
      return name;
    },
  };
}
