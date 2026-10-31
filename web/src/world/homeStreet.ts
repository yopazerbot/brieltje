import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Prism, Surroundings } from './houseData';
import { tintedMaterial } from './houseMeshes';
import { terrain } from './terrain';
import type { Tiles } from './tiles';
import data from '../data/homestreet.json';

/**
 * The houses round the two portals at home, our own Blender models (tools/homestreet/houses.py,
 * web/public/models/homestreet.glb): the corner house across the lane from the main house with its link
 * and barn, the house over the side road, the two new-builds past the junction, the bungalow's neighbour
 * with its conservatory, fence and gate, and the bungalow's roof trim and front terrace. They take the place
 * of the blocks built from the open data for those buildings, which are no longer drawn (withoutModelled)
 * but stay for walking into; what was added round them (pillars, fences, a garden wall, logs) gets blocks
 * of its own.
 *
 * Each cluster (round the main house, round the bungalow) is one mesh per material: brick, render,
 * timber, roof tiles (our textures, tools/homestreet/textures.py, or the game's plaster), glass, and the
 * trim (frames, sills, gutters, fences, coloured per corner). Every corner also carries ambient
 * occlusion baked in Blender, so reveals, eaves and wall feet are shaded at no cost here. Beyond
 * DETAIL metres the trim is hidden: the walls, roofs and glass stay. Beyond the draw distance a cluster
 * is hidden like the tiles (Tiles.track).
 */

interface Cluster {
  origin: [number, number];
  replace: [number, number][][];
  /** Outlines of open-data paving no longer drawn (a terrace of ours lies there) */
  clear: [number, number][][];
  blocks: Prism[];
}
const CLUSTERS = (data as unknown as { clusters: Record<string, Cluster> }).clusters;
/** m: beyond this from a cluster's middle its trim (frames, gutters, fences) is hidden */
const DETAIL = 150;

const inside = (x: number, z: number, ring: [number, number][]) => {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
};
/** Metres from (x, z) to the outline's edges. */
const edgeDistance = (x: number, z: number, ring: [number, number][]) => {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[j];
    const [bx, bz] = ring[i];
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
};
/**
 * Every point inside one of a cluster's outlines (or within 35 cm of an edge): the outlines can be concave,
 * and one open-data block can cover a house and its annexes, each an outline of its own.
 */
const modelled = (pts: readonly (readonly number[])[]) =>
  Object.values(CLUSTERS).some((c) =>
    pts.every((p) => c.replace.some((r) => inside(p[0], p[p.length - 1], r) || edgeDistance(p[0], p[p.length - 1], r) < 0.35)),
  );
const isBuilding = (p: Prism) => p.m.startsWith('nb_') && p.m !== 'nb_hedge';
const PAVING = new Set(['pave_light', 'pave_warm', 'pave_grey', 'gravel']);
/** A paving block lying wholly inside one of the outlines cleared for a terrace of ours. */
const cleared = (p: Prism) =>
  PAVING.has(p.m) && Object.values(CLUSTERS).some((c) => c.clear.some((r) => p.p[0].every(([x, z]) => inside(x, z, r) || edgeDistance(x, z, r) < 0.35)));

/**
 * Split the surroundings: what stays drawn from the open data, and the buildings our models replace
 * (their walls, roofs, windows and solar panels). Collision keeps using the full data.
 */
export function withoutModelled(s: Surroundings): { kept: Surroundings; removed: Surroundings } {
  if (OFF) return { kept: s, removed: { roofs: [], trees: [] } };
  type Pts = readonly (readonly number[])[];
  const gone = <T,>(list: T[] | undefined, at: (t: T) => Pts) => (list ?? []).filter((t) => modelled(at(t)));
  const stays = <T,>(list: T[] | undefined, at: (t: T) => Pts) => (list ?? []).filter((t) => !modelled(at(t)));
  const far: Pts = [[Infinity, Infinity]];
  const prismAt = (p: Prism) => (isBuilding(p) || p.m === 'concrete' ? p.p[0] : far);
  const keep = (p: Prism) => !modelled(prismAt(p)) && !cleared(p);
  const roofAt = (r: Surroundings['roofs'][number]) => r.p;
  type Opening = NonNullable<Surroundings['openings']>[number];
  // A window sits on the wall: step 30 cm inwards from it to test.
  const openingAt = (o: Opening): Pts => [[(o.a[0] + o.b[0]) / 2 - o.n[0] * 0.3, (o.a[1] + o.b[1]) / 2 - o.n[1] * 0.3]];
  type Solar = NonNullable<Surroundings['solar']>[number];
  const solarAt = (q: Solar): Pts => q.q.map((v) => [v[0], v[2]]);
  return {
    kept: {
      ...s,
      prisms: (s.prisms ?? []).filter(keep),
      roofs: stays(s.roofs, roofAt),
      openings: stays(s.openings, openingAt),
      solar: stays(s.solar, solarAt),
    },
    removed: {
      roofs: gone(s.roofs, roofAt),
      trees: [],
      prisms: (s.prisms ?? []).filter((p) => !keep(p)),
      openings: gone(s.openings, openingAt),
      solar: gone(s.solar, solarAt),
    },
  };
}

/** Development only: ?nohomestreet leaves the open-data houses as they were (for measuring what the models cost). */
const OFF = import.meta.env.DEV && new URLSearchParams(location.search).has('nohomestreet');
const HALF = matchMedia('(pointer: coarse)').matches;
const FOLDER = HALF ? '/textures/half' : '/textures';

export class HomeStreet {
  readonly group = new THREE.Group();
  /** Resolves once the models are in place (or failed to load: then the open-data blocks are drawn again). */
  readonly ready: Promise<void>;
  /** Blocks for walking and driving into: the pillars, fences and walls added round the models. */
  readonly blocks: Prism[] = OFF ? [] : Object.values(CLUSTERS).flatMap((c) => c.blocks);
  private detail: { mesh: THREE.Object3D; at: THREE.Vector3 }[] = [];
  private wait = 0;
  /** Our own textures, and one of the game's whose sharpness (anisotropy, set by the graphics preset) they follow */
  private own: THREE.Texture[] = [];
  private reference: THREE.Texture | null = null;
  /** Development: the open-data buildings drawn again, to swap with the models when measuring (showModels) */
  private openData: THREE.Object3D[] | null = null;

  /** `restore`: draw these open-data buildings after all (the models didn't load). */
  constructor(private tiles: Tiles, renderer: THREE.WebGLRenderer, ground: number, private removed: Surroundings, private restore: (s: Surroundings) => void) {
    this.group.name = 'homeStreet';
    const loader = new THREE.TextureLoader();
    const tex = (name: string, color: boolean) => {
      const t = loader.load(`${FOLDER}/${name}.webp`);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = this.reference?.anisotropy ?? 1;
      t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      this.own.push(t);
      return t;
    };
    // The game's plaster: its texture follows the graphics preset's sharpness, and ours follow it (update).
    this.reference = tintedMaterial('plaster', '#ffffff', renderer).map;
    const brickNormal = tex('hs_brick_normal', false);
    const own = (color: string, normal: THREE.Texture, rough: number) =>
      new THREE.MeshStandardMaterial({ map: tex(color, true), normalMap: normal, roughness: rough, vertexColors: true });
    const shared = (name: string, normalScale: number) => {
      const m = tintedMaterial(name, '#ffffff', renderer);
      m.vertexColors = true;
      m.normalScale.setScalar(normalScale);
      return m;
    };
    // Made on first use: a cluster without a material doesn't fetch its textures.
    const make: Record<string, () => THREE.Material> = {
      hs_brick_red: () => own('hs_brick_red_color', brickNormal, 0.9),
      hs_brick_buff: () => own('hs_brick_buff_color', brickNormal, 0.88),
      hs_wood: () => own('hs_wood_color', tex('hs_wood_normal', false), 0.85),
      hs_tiles: () => own('hs_tiles_color', tex('hs_tiles_normal', false), 0.92),
      hs_render: () => shared('plaster', 0.35),
      hs_pave: () => shared('pavers', 0.8),
      hs_slab: () => shared('terrace', 0.8),
      // Opaque, dark and glossy, as the open-data houses' windows: from outside, glass mostly mirrors the sky.
      hs_glass: () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.05, metalness: 0.1, envMapIntensity: 1.6 }),
      hs_trim: () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.12 }),
    };
    const mats = new Map<string, THREE.Material>();
    const material = (name: string) => {
      if (!mats.has(name)) mats.set(name, (make[name] ?? make.hs_trim)());
      return mats.get(name)!;
    };
    const tags: Record<string, string> = {
      hs_brick_red: 'nb_red', hs_brick_buff: 'nb_brown', hs_wood: 'cladding', hs_tiles: 'nb_roof', hs_render: 'plaster',
      hs_pave: 'pave_light', hs_slab: 'paving', hs_glass: 'black_glass', hs_trim: 'steel',
    };
    if (OFF) {
      this.ready = Promise.resolve();
      return;
    }
    this.ready = new GLTFLoader()
      .loadAsync('/models/homestreet.glb')
      .then((gltf) => {
        for (const root of [...gltf.scene.children]) {
          const [x, z] = (root.userData.origin as [number, number] | undefined) ?? [0, 0];
          root.position.set(x, ground + terrain.height(x, z), z);
          const at = new THREE.Vector3(x, 0, z);
          root.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            const name = (mesh.material as THREE.Material).name;
            (mesh.material as THREE.Material).dispose();
            mesh.material = material(name);
            mesh.userData.material = tags[name] ?? 'stone';
            mesh.receiveShadow = true;
            mesh.castShadow = name !== 'hs_trim' && name !== 'hs_glass';
            if (mesh.userData.detail || name === 'hs_trim') this.detail.push({ mesh, at });
          });
          this.group.add(root);
          tiles.track(root); // each cluster hidden beyond the draw distance on its own
        }
        tiles.group.add(this.group); // a caster for the ground's shading, a target for shots
      })
      .catch(() => restore(removed)); // missing: the open-data buildings are drawn as before
  }

  /**
   * Development only: show the models (true) or the open-data buildings they replace (false), in the same page,
   * to measure what they cost. The open-data ones come back as a tile set of their own.
   */
  showModels(on: boolean): void {
    if (!import.meta.env.DEV) return;
    if (!this.openData) {
      const before = new Set(this.tiles.group.children);
      this.restore(this.removed);
      this.openData = this.tiles.group.children.filter((c) => !before.has(c) && c !== this.group);
    }
    for (const m of this.openData) {
      if (on) m.removeFromParent();
      else this.tiles.group.add(m);
    }
    this.group.visible = on;
  }

  /** A few times a second: the trim only near a cluster. */
  update(dt: number, eye: THREE.Vector3): void {
    this.wait -= dt;
    if (this.wait > 0) return;
    this.wait = 0.25;
    for (const d of this.detail) d.mesh.visible = Math.hypot(eye.x - d.at.x, eye.z - d.at.z) < DETAIL;
    const level = this.reference?.anisotropy ?? 1;
    for (const t of this.own) {
      if (t.anisotropy === level) continue;
      t.anisotropy = level;
      if (t.image) t.needsUpdate = true; // still loading: it uploads with this level once it is in
    }
  }
}
