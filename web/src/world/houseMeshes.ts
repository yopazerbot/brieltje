import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Prism } from './houseData';
import { solidNormals } from './normals';
import { terrain } from './terrain';
import { rustle } from './wind';
import sizes from '../../public/textures/sizes.json';

/** Real-world width of each texture tile in metres (from Poly Haven, or our own brick). */
const TILE: Record<string, number> = sizes;

interface MatSpec {
  tex?: string;
  /** Texture has only a colour map (our generated ones) */
  colorOnly?: boolean;
  emissive?: string;
  tint?: string;
  rough?: number;
  metal?: number;
  normalScale?: number;
  rotate?: boolean; // turn the texture 90 degrees (vertical planks)
}

const SPECS: Record<string, MatSpec> = {
  // Light beige blended facing brick; tinted warmer so it reads sandy
  brick: { tex: 'brick', tint: '#fff0dc', normalScale: 1.2 },
  claustra: { tex: 'brick', tint: '#fff0dc', normalScale: 1.2 },
  plaster: { tex: 'plaster', tint: '#f4f1ec', normalScale: 0.35 },
  ceiling: { tex: 'plaster', tint: '#f7f5f1', normalScale: 0.25 },
  floor_tile: { tex: 'floor_tile', tint: '#d6d6d5', normalScale: 0.6 }, // grey stone-look 60 x 120 tiles
  floor_wood: { tex: 'floor_wood', tint: '#cccdd6', normalScale: 0.6 }, // greige, a touch darker than the laminate photo
  floor_bath: { tex: 'floor_bath', tint: '#ededeb', normalScale: 0.6 },
  terrace: { tex: 'floor_tile', tint: '#e4e5e6', normalScale: 0.6 }, // the same tiles outside, a little cooler
  paving: { tex: 'terrace', tint: '#fdfbf7', normalScale: 0.8 }, // light concrete
  road: { tex: 'road', tint: '#e2ded6', normalScale: 0.7 }, // Briel: pale old concrete (orthophoto)
  // What the aerial photo shows around the neighbours' houses (tools/street.py)
  pave_light: { tex: 'pavers', tint: '#cdc9c2', normalScale: 0.8 }, // light grey concrete pavers
  pave_warm: { tex: 'pavers', tint: '#cbbfae', normalScale: 0.8 }, // beige pavers
  pave_grey: { tex: 'clinker', tint: '#9e9c97', normalScale: 0.8 }, // grey concrete clinkers in stretcher bond: Smetlede's church square and main street (Street View), as dark as they look there
  pave_walk: { tex: 'pavers', tint: '#9e9c97', normalScale: 0.8 }, // the streets' pavements (world/roadDetail.ts): grey concrete pavers, tinted per street
  gravel: { tex: 'gravel', tint: '#d6cab5' },
  track: { tex: 'gravel', tint: '#b7a184' }, // the wheel ruts of the field tracks
  pool_water: { tint: '#3e9fbe', rough: 0.04, metal: 0.1 },
  pole: { tex: 'concrete', tint: '#c4c0b8', normalScale: 0.6 }, // the concrete poles along the road
  // The fields round about, as the aerial photo shows them (tools/street.py)
  field_soil: { tex: 'field', tint: '#d9c6a6' }, // light ploughed soil
  field_dark: { tex: 'field', tint: '#9c8064' }, // darker, damp soil
  field_crop: { tex: 'field', tint: '#9aa070' }, // crops and nursery rows: green over soil
  forest: { tex: 'field', tint: '#6e6648' }, // the floor of the woods: leaf litter
  concrete: { tex: 'concrete', tint: '#e8e4dc', normalScale: 0.5 },
  cladding: { tex: 'cladding' }, // vertical slats (generated)
  stair: { tex: 'stair', tint: '#e8d8c4' },
  hedge: { tex: 'hedge', tint: '#7fa06a', normalScale: 1.5 },
  bed: { tint: '#5b4635', rough: 1 }, // bark mulch in the planted borders (tools/garden.py)
  roof: { tint: '#3b3c3e', rough: 0.85 },
  nb_wall: { tex: 'brick', tint: '#c48a72', normalScale: 1.0 }, // neighbours: red-brown brick
  // Neighbours' houses (tools/facades.py): standard bricks in the street's colours
  nb_red: { tex: 'nb_brick', tint: '#b5644c' },
  nb_brown: { tex: 'nb_brick', tint: '#8e5a44' },
  nb_yellow: { tex: 'nb_brick', tint: '#d4b88f' },
  nb_white: { tex: 'nb_brick', tint: '#f2eee6', normalScale: 0.6 },
  nb_grey: { tex: 'nb_brick', tint: '#a39c93' },
  nb_dark: { tex: 'nb_brick', tint: '#4b4a49' }, // anthracite or black brick, blue-stone plinths
  nb_roof: { tint: '#45403c', rough: 0.9 },
  nb_hedge: { tex: 'hedge', tint: '#7fa06a', normalScale: 1.5 }, // between gardens (no leafy lumps: there are kilometres)
  kerb: { tex: 'concrete', tint: '#dcd8d0', normalScale: 0.5 }, // concrete edge strip along the road
  // The streets in detail (world/roadDetail.ts): concrete slabs, asphalt and concrete tiles, tinted per vertex
  rd_concrete: { tex: 'road_concrete', tint: '#c9c6be', normalScale: 0.8 },
  rd_asphalt: { tex: 'asphalt', tint: '#55575a', normalScale: 0.9 },
  rd_tiles: { tex: 'terrace', tint: '#bdbab2', normalScale: 0.7 },
  // The old bungalow down the lane (tools/old_house.py)
  old_brick: { tex: 'brick', tint: '#f6efe2', normalScale: 1.0 },
  old_plinth: { tex: 'brick', tint: '#6e5a50', normalScale: 1.0 },
  old_plaster: { tex: 'plaster', tint: '#f1ece2', normalScale: 0.35 },
  old_ceiling: { tex: 'plaster', tint: '#f4f1ea', normalScale: 0.25 },
  old_floor: { tex: 'floor_tile', tint: '#d9cbb3', normalScale: 0.6 },
  old_wood: { tex: 'floor_wood', tint: '#e8d6bd', normalScale: 0.6 }, // upper floor boards and the stair
  old_stone: { tint: '#e6e1d6', rough: 0.85 },
  old_frame: { tint: '#f3f1ec', rough: 0.5 },
  old_roof_flat: { tint: '#3d3a38', rough: 0.9 },
  rail: { tint: '#1f2124', rough: 0.4, metal: 0.8 },
  // Kitchen and bathrooms (supplier drawings)
  oak: { tex: 'stair', tint: '#f6ead8', normalScale: 0.4 },
  walnut: { tex: 'stair', tint: '#8c5b3e', normalScale: 0.4 },
  veneer: { tex: 'stair', tint: '#d7d6ff', normalScale: 0.4 }, // rosy wood veneer of the window seat: the oak photo made pinker
  terracotta: { tint: '#b4624a', rough: 0.55 },
  terrazzo: { tex: 'terrazzo', colorOnly: true, rough: 0.35 },
  rust_tile: { tex: 'rust_tile', colorOnly: true, rough: 0.3 },
  pink_tile: { tex: 'floor_bath', tint: '#ecd2c6', normalScale: 0.5 },
  pink: { tint: '#d9b6a7', rough: 0.6 },
  stone: { tint: '#ece8e1', rough: 0.35 },
  bluestone: { tex: 'concrete', tint: '#6b7177', rough: 0.7, normalScale: 0.4 }, // window sills in Belgian blue hardstone (plan legend)
  ceramic: { tint: '#f7f6f2', rough: 0.15 },
  black_glass: { tint: '#0c0c0e', rough: 0.15, metal: 0 },
  steel: { tint: '#9ea3a8', rough: 0.3, metal: 1 },
  alu: { tint: '#4d4a46', rough: 0.45, metal: 0.6 },
  alu_out: { tint: '#45322e', rough: 0.5, metal: 0.3 }, // window frames outside: RAL 8017 chocolate brown
  alu_in: { tint: '#f1ece1', rough: 0.5, metal: 0.05 }, // window frames inside: RAL 9010 white
  brass: { tint: '#c9a35c', rough: 0.28, metal: 1 },
  mirror: { tint: '#e9eef2', rough: 0.02, metal: 1 },
  niche: { tint: '#c79a6a', emissive: '#ffcf8f', rough: 0.6 },
};

const loader = new THREE.TextureLoader();
const cache = new Map<string, THREE.Texture>();

/**
 * Phones and tablets get every texture at half size: a quarter of the graphics memory and of the
 * download. At full size the textures take about 290 MB, more than many phones give a page, and
 * a phone that runs out drops the 3D view. The half-size files are made beforehand
 * (tools/textures.py), so the phone neither shrinks them nor downloads the full ones.
 */
const HALF = matchMedia('(pointer: coarse)').matches;
const FOLDER = HALF ? '/textures/half' : '/textures';

function texture(name: string, kind: 'color' | 'normal' | 'rough', renderer: THREE.WebGLRenderer, rotate = false): THREE.Texture {
  const key = `${name}_${kind}_${rotate}`;
  let t = cache.get(key);
  if (!t) {
    t = loader.load(`${FOLDER}/${name}_${kind}.webp`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    t.colorSpace = kind === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    // UVs are in metres; one texture tile covers TILE metres.
    const s = 1 / (TILE[name] ?? 2);
    t.repeat.set(s, s);
    if (rotate) {
      t.center.set(0.5, 0.5);
      t.rotation = Math.PI / 2;
    }
    cache.set(key, t);
  }
  return t;
}

/** Texture sharpness at grazing angles; part of the graphics preset. */
export function setAnisotropy(level: number): void {
  for (const t of cache.values()) {
    if (t.anisotropy !== level) {
      t.anisotropy = level;
      if (t.image) t.needsUpdate = true; // still loading: it uploads with this level once it is in
    }
  }
}

/**
 * A welded wire fence panel in dark green (as sold for garden fences here): wires drawn on a
 * canvas, 5 cm apart upright and 20 cm across, used as a cut-out. One tile is 1 m.
 */
function fenceMaterial(): THREE.Material {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  for (let x = 0; x < 256; x += 12.8) g.fillRect(Math.round(x), 0, 2, 256);
  for (let y = 0; y < 256; y += 51.2) g.fillRect(0, Math.round(y), 256, 3);
  const alpha = new THREE.CanvasTexture(c);
  alpha.wrapS = alpha.wrapT = THREE.RepeatWrapping;
  alpha.anisotropy = 4;
  return new THREE.MeshStandardMaterial({ color: '#2f4538', alphaMap: alpha, alphaTest: 0.5, roughness: 0.6, metalness: 0.3 });
}

const materials = new Map<string, THREE.Material>();

/** The material for a surface name, shared by everything that uses that name. */
export function surfaceMaterial(name: string, renderer: THREE.WebGLRenderer): THREE.Material {
  let m = materials.get(name);
  if (!m) {
    m = makeMaterial(name, renderer);
    materials.set(name, m);
  }
  return m;
}

/** A material with one of the textures, tinted (roof tiles per house, for example). */
export function tintedMaterial(tex: string, tint: string, renderer: THREE.WebGLRenderer, side: THREE.Side = THREE.FrontSide): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: tint, roughness: 1, side });
  mat.map = texture(tex, 'color', renderer);
  mat.normalMap = texture(tex, 'normal', renderer);
  mat.roughnessMap = texture(tex, 'rough', renderer);
  return mat;
}

function makeMaterial(name: string, renderer: THREE.WebGLRenderer): THREE.Material {
  if (name === 'fence') return fenceMaterial();
  if (name === 'glass') {
    return new THREE.MeshPhysicalMaterial({
      color: '#dfeff5',
      roughness: 0.03,
      metalness: 0,
      transparent: true,
      opacity: 0.18,
      envMapIntensity: 1.4,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }
  const spec = SPECS[name] ?? SPECS.plaster;
  const mat = new THREE.MeshStandardMaterial({
    color: spec.tint ?? '#ffffff',
    roughness: spec.rough ?? 1,
    metalness: spec.metal ?? 0,
  });
  if (spec.tex) {
    mat.map = texture(name === 'claustra' ? 'claustra' : spec.tex, 'color', renderer, spec.rotate);
    if (!spec.colorOnly) {
      mat.normalMap = texture(spec.tex, 'normal', renderer, spec.rotate);
      mat.roughnessMap = texture(spec.tex, 'rough', renderer, spec.rotate);
      const n = spec.normalScale ?? 1;
      mat.normalScale.set(n, n);
    }
  }
  if (spec.emissive) {
    mat.emissive.set(spec.emissive);
    mat.emissiveIntensity = 1.2;
  }
  if (name === 'claustra') {
    mat.alphaTest = 0.5; // open brickwork: light passes through the gaps
    mat.side = THREE.DoubleSide;
  }
  if (name === 'hedge' || name === 'nb_hedge') rustle(mat); // their leaves tremble in the wind (world/wind.ts)
  return mat;
}

/**
 * UVs in world metres, so textures keep their real size and brick courses
 * line up across separate blocks (for example a wall and the lintel above it).
 */
function worldUV(y0: number): THREE.UVGenerator {
  return {
    generateTopUV(_g, v, a, b, c) {
      return [a, b, c].map((i) => new THREE.Vector2(v[i * 3], v[i * 3 + 1]));
    },
    generateSideWallUV(_g, v, a, b, c, d) {
      const [ax, ay] = [v[a * 3], v[a * 3 + 1]];
      const [bx, by] = [v[b * 3], v[b * 3 + 1]];
      const alongX = Math.abs(ay - by) < Math.abs(ax - bx);
      return [a, b, c, d].map((i) => new THREE.Vector2(alongX ? v[i * 3] : v[i * 3 + 1], y0 + v[i * 3 + 2]));
    },
  };
}

/** Even-odd test across an outline and its holes. */
function insideRings(x: number, z: number, rings: [number, number][][]): boolean {
  let hit = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i];
      const [xj, zj] = ring[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
    }
  }
  return hit;
}

/** A convex polygon clipped to a box (Sutherland-Hodgman). */
function clipToBox(poly: [number, number][], x0: number, z0: number, x1: number, z1: number): [number, number][] {
  const sides: [(p: [number, number]) => boolean, (a: [number, number], b: [number, number]) => [number, number]][] = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((x0 - a[0]) / (b[0] - a[0])) * (b[1] - a[1])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((x1 - a[0]) / (b[0] - a[0])) * (b[1] - a[1])]],
    [(p) => p[1] >= z0, (a, b) => [a[0] + ((z0 - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), z0]],
    [(p) => p[1] <= z1, (a, b) => [a[0] + ((z1 - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), z1]],
  ];
  let pts = poly;
  for (const [keep, cut] of sides) {
    const out: [number, number][] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length];
      const b = pts[i];
      if (keep(b)) {
        if (!keep(a)) out.push(cut(a, b));
        out.push(b);
      } else if (keep(a)) out.push(cut(a, b));
    }
    pts = out;
    if (pts.length < 3) return [];
  }
  return pts;
}

/**
 * A block out on the relief (p.d metres): its outline triangulated, every triangle cut along
 * the grid (so no piece is bigger than a square) and each corner lifted onto the ground; a
 * hedge or fence also gets its sides, in pieces of at most a square, lifted the same way.
 */
function drapedGeometry(p: Prism): THREE.BufferGeometry {
  const cell = p.d!;
  const pos: number[] = [];
  const uv: number[] = [];
  const up = (x: number, z: number, y: number) => [x, y + terrain.height(x, z), z];
  const contour = p.p[0].map(([x, z]) => new THREE.Vector2(x, z));
  const holes = p.p.slice(1).map((r) => r.map(([x, z]) => new THREE.Vector2(x, z)));
  const all = [...contour, ...holes.flat()];
  for (const face of THREE.ShapeUtils.triangulateShape(contour, holes)) {
    const t = face.map((k): [number, number] => [all[k].x, all[k].y]);
    const xs = t.map((v) => v[0]);
    const zs = t.map((v) => v[1]);
    // On the terrain's grid lines, so the pieces' corners lie on the ground's own corners where they can.
    const gx0 = terrain.x0 + Math.floor((Math.min(...xs) - terrain.x0) / cell) * cell;
    const gz0 = terrain.z0 + Math.floor((Math.min(...zs) - terrain.z0) / cell) * cell;
    for (let gx = gx0; gx < Math.max(...xs); gx += cell) {
      for (let gz = gz0; gz < Math.max(...zs); gz += cell) {
        const piece = clipToBox(t, gx, gz, gx + cell, gz + cell);
        for (let k = 1; k + 1 < piece.length; k++) {
          let [a, b, c] = [piece[0], piece[k], piece[k + 1]];
          if ((b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]) < 0) [b, c] = [c, b]; // facing up
          for (const v of [a, b, c]) {
            pos.push(...up(v[0], v[1], p.y1));
            uv.push(v[0], -v[1]);
          }
        }
      }
    }
  }
  if (p.y1 - p.y0 > 0.15) {
    for (const ring of p.p) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 1e-4) continue;
        // Facing out: away from the inside of the outline.
        const nx = (b[1] - a[1]) / len;
        const nz = -(b[0] - a[0]) / len;
        const mx = (a[0] + b[0]) / 2;
        const mz = (a[1] + b[1]) / 2;
        const flip = insideRings(mx + nx * 0.005, mz + nz * 0.005, p.p);
        const steps = Math.max(1, Math.ceil(len / cell));
        const alongX = Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]);
        for (let s = 0; s < steps; s++) {
          const f0 = s / steps;
          const f1 = (s + 1) / steps;
          let q0: [number, number] = [a[0] + (b[0] - a[0]) * f0, a[1] + (b[1] - a[1]) * f0];
          let q1: [number, number] = [a[0] + (b[0] - a[0]) * f1, a[1] + (b[1] - a[1]) * f1];
          if (flip) [q0, q1] = [q1, q0];
          const quad = [up(q0[0], q0[1], p.y0), up(q1[0], q1[1], p.y0), up(q1[0], q1[1], p.y1), up(q0[0], q0[1], p.y1)];
          for (const k of [0, 2, 1, 0, 3, 2]) {
            pos.push(...quad[k]);
            uv.push(alongX ? quad[k][0] : quad[k][2], quad[k][1]);
          }
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return solidNormals(g); // cutting along the grid leaves slivers with no area
}

/** A block's geometry: extruded, or draped over the relief (p.d). UVs in metres. */
export function prismGeometry(p: Prism): THREE.BufferGeometry {
  if (p.d) return drapedGeometry(p);
  // The plan's z axis becomes the shape's -y so that, after tilting the
  // extrusion upright, x and z land where they are on the plan.
  const toShapePts = (ring: [number, number][]) => ring.map(([x, z]) => new THREE.Vector2(x, -z));
  const shape = new THREE.Shape(toShapePts(p.p[0]));
  for (const hole of p.p.slice(1)) shape.holes.push(new THREE.Path(toShapePts(hole)));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: p.y1 - p.y0,
    bevelEnabled: false,
    curveSegments: 1,
    UVGenerator: worldUV(p.y0),
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, p.y0, 0);
  geo.clearGroups();
  return solidNormals(geo); // an outline with a repeated or an in-line corner gives triangles with no area
}

/**
 * Build one merged mesh per material: a handful of draw calls for the whole
 * house. Window panes stay separate meshes so they can break one by one;
 * each remembers its block number in `userData.glassIndex`.
 */
export function buildHouseMeshes(prisms: Prism[], renderer: THREE.WebGLRenderer): { group: THREE.Group; panes: Map<number, THREE.Mesh> } {
  const byMat = new Map<string, THREE.BufferGeometry[]>();
  const group = new THREE.Group();
  const panes = new Map<number, THREE.Mesh>();
  const glass = makeMaterial('glass', renderer);
  const frosted = new THREE.MeshPhysicalMaterial({ color: '#c3d0d6', roughness: 0.45, transparent: true, opacity: 0.86, side: THREE.DoubleSide });
  prisms.forEach((p, i) => {
    if (p.m === 'glass') {
      const pane = new THREE.Mesh(prismGeometry(p), p.matte ? frosted : glass);
      pane.userData.glassIndex = i;
      pane.renderOrder = 1;
      panes.set(i, pane);
      group.add(pane);
      return;
    }
    const list = byMat.get(p.m) ?? [];
    list.push(prismGeometry(p));
    byMat.set(p.m, list);
  });
  for (const [m, geos] of byMat) {
    const merged = mergeGeometries(geos);
    geos.forEach((g) => g.dispose());
    const mesh = new THREE.Mesh(merged, surfaceMaterial(m, renderer));
    mesh.userData.material = m;
    mesh.name = m;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return { group, panes };
}

/**
 * Surfaces of the surroundings that share a texture and differ only in tint (the neighbours'
 * bricks, the fields, the pavers, gravel and ruts, concrete): one material each, with the tint
 * per vertex, so a tile of the surroundings is a handful of draw calls instead of one per colour.
 * The first name of each family stands for it where a bullet hits (its dust and sound).
 */
const FAMILIES: Record<string, string[]> = {
  nb_brick: ['nb_red', 'nb_brown', 'nb_yellow', 'nb_white', 'nb_grey', 'nb_dark'],
  field: ['field_soil', 'field_dark', 'field_crop', 'forest'],
  pavers: ['pave_light', 'pave_warm', 'pave_walk'],
  clinker: ['pave_grey'],
  gravel: ['gravel', 'track'],
  concrete: ['pole', 'concrete'],
  rdconcrete: ['rd_concrete'],
  rdasphalt: ['rd_asphalt'],
  rdtiles: ['rd_tiles'],
};
const FAMILY_OF = new Map(Object.entries(FAMILIES).flatMap(([family, names]) => names.map((n) => [n, family] as const)));
const families = new Map<string, THREE.MeshStandardMaterial>();
/**
 * The surroundings' own materials, apart from the house's (the tiles are drawn in batches, and a
 * material shared with an ordinary mesh would switch shader programs back and forth every frame).
 */
const outside = new Map<string, THREE.Material>();

/**
 * The material a surroundings block is drawn with, the colour its vertices carry (white when the
 * material has its own tint) and the name that stands for it. Shared by every tile.
 */
export function blockMaterial(name: string, renderer: THREE.WebGLRenderer): { material: THREE.Material; tint: THREE.Color; tag: string } {
  const family = FAMILY_OF.get(name);
  if (!family) {
    let own = outside.get(name);
    if (!own) outside.set(name, (own = makeMaterial(name, renderer)));
    return { material: own, tint: new THREE.Color(1, 1, 1), tag: name };
  }
  let mat = families.get(family);
  if (!mat) {
    const first = SPECS[FAMILIES[family][0]];
    mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: first.rough ?? 1, metalness: first.metal ?? 0, vertexColors: true });
    mat.map = texture(first.tex!, 'color', renderer);
    mat.normalMap = texture(first.tex!, 'normal', renderer);
    mat.roughnessMap = texture(first.tex!, 'rough', renderer);
    const n = first.normalScale ?? 1;
    mat.normalScale.set(n, n);
    families.set(family, mat);
  }
  return { material: mat, tint: new THREE.Color(SPECS[name].tint ?? '#ffffff'), tag: FAMILIES[family][0] };
}

/** The surroundings' ground covers (the road, fields, pavers, gravel, the streets' surfaces), for the ground's shading. */
export function groundFamilies(renderer: THREE.WebGLRenderer): THREE.MeshStandardMaterial[] {
  return ['road', 'field_soil', 'pave_light', 'gravel', 'rd_concrete', 'rd_asphalt', 'rd_tiles'].map((n) => blockMaterial(n, renderer).material as THREE.MeshStandardMaterial);
}

/** A colour on every vertex of a geometry (for the family materials), a byte per channel. */
export function paint(g: THREE.BufferGeometry, c: THREE.Color): THREE.BufferGeometry {
  const colors = new Uint8Array(g.attributes.position.count * 3);
  const rgb = [c.r, c.g, c.b].map((v) => Math.round(Math.min(1, v) * 255));
  for (let i = 0; i < colors.length; i += 3) colors.set(rgb, i);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
  return g;
}

/**
 * Grass for the whole surroundings, with the real-size lawn texture, a little less green than the photo
 * (in the low sun the texture's own green turns to a golf course).
 */
export function grassMaterial(renderer: THREE.WebGLRenderer): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: '#d4cfc8', roughness: 1 });
  mat.map = texture('grass', 'color', renderer);
  mat.normalMap = texture('grass', 'normal', renderer);
  mat.roughnessMap = texture('grass', 'rough', renderer);
  return mat;
}
