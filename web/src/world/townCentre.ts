import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Prism, Ring } from './houseData';

/**
 * The houses round Smetlede's church square and along the street to the school: our own Blender models
 * (tools/town/town.py, from tools/town/houses.json), in place of the blocks the open data gives them.
 * Those blocks stay for walking and driving into; the model names their outlines (`replaces`), so the
 * village leaves them out of the drawing, and brings blocks of its own for what is new (bollards,
 * planters, a bench).
 *
 * The light is baked: the model's colours per vertex carry each surface's colour times its ambient
 * occlusion and the sun's shadow, worked out in Blender. So it needs no real-time shadow (it neither
 * casts into nor samples the sun's shadow map, which only covers the house anyway) and no normals:
 * every surface is flat and drawn with flat shading.
 *
 * Draw calls: five near (brick, render, roof tiles, trim, glass), three far. Within FAR m of the
 * square (230, from the model) the full copy is drawn; beyond it a simple copy of the same volumes,
 * the windows as dark patches; beyond the village's draw distance nothing (the tiles hide it).
 *
 * Textures: town_brick and town_roof (Poly Haven, CC0; tools/town/textures.py), fetched with the
 * model once the village loads; the render takes the game's plaster texture.
 */

const HALF = matchMedia('(pointer: coarse)').matches; // phones get the half-size textures, as everywhere
const FOLDER = HALF ? '/textures/half' : '/textures';
/** Metres per texture tile (the UVs are in metres). */
const TILE: Record<string, number> = { town_brick: 1.4, town_roof: 3.6, plaster: 3.2 };
/** The model stores its vertex colours divided by this (painted brick is lighter than the brick texture's mean). */
const COLOR_SCALE = 1.6;

const textures = new Map<string, THREE.Texture>();
function texture(name: string, kind: 'color' | 'normal' | 'rough', renderer: THREE.WebGLRenderer): THREE.Texture {
  const key = `${name}_${kind}`;
  let t = textures.get(key);
  if (!t) {
    t = new THREE.TextureLoader().load(`${FOLDER}/${key}.webp`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = kind === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    t.repeat.setScalar(1 / (TILE[name] ?? 2));
    textures.set(key, t);
  }
  return t;
}

function material(name: string, extras: { texture?: string; normalScale?: number; roughness?: number }, renderer: THREE.WebGLRenderer): THREE.Material {
  const glass = name.endsWith('glass');
  const m = new THREE.MeshStandardMaterial({
    color: new THREE.Color(COLOR_SCALE, COLOR_SCALE, COLOR_SCALE),
    vertexColors: true,
    flatShading: true,
    roughness: glass ? 0.06 : (extras.roughness ?? 0.85),
    metalness: glass ? 0.1 : 0,
    envMapIntensity: glass ? 1.6 : 1,
  });
  if (extras.texture) {
    m.map = texture(extras.texture, 'color', renderer);
    m.normalMap = texture(extras.texture, 'normal', renderer);
    m.normalScale.setScalar(extras.normalScale ?? 1);
    m.roughnessMap = texture(extras.texture, 'rough', renderer);
    m.roughness = 1;
  }
  return m;
}

/**
 * The town's houses on their spot. The returned object carries `landmark: 'town'`, the outlines it replaces
 * (`replaces`, Ring[]) and its new blocks for walking into (`solids`, Prism[] in the game's heights).
 */
export async function loadTown(renderer: THREE.WebGLRenderer, ground: (x: number, z: number) => number): Promise<THREE.Object3D> {
  const gltf = await new GLTFLoader().loadAsync('/models/town.glb');
  const scene = gltf.scene;
  const root = scene.children.find((o) => o.userData.origin) ?? scene;
  const [ox, oz] = root.userData.origin as [number, number];
  scene.position.set(ox, ground(ox, oz), oz);
  const near = new THREE.Group();
  const far = new THREE.Group();
  const shared = new Map<string, THREE.Material>();
  for (const mesh of [...root.children] as THREE.Mesh[]) {
    if (!mesh.isMesh) continue;
    const name = mesh.name;
    const key = name.replace(/^(near|far)_/, '');
    const mat = shared.get(name) ?? material(key, (mesh.material as THREE.Material).userData, renderer);
    shared.set(name, mat);
    (mesh.material as THREE.Material).dispose();
    mesh.material = mat;
    mesh.castShadow = mesh.receiveShadow = false;
    (name.startsWith('far_') ? far : near).add(mesh);
  }
  const lod = new THREE.LOD();
  lod.addLevel(near, 0);
  lod.addLevel(far, (root.userData.far as number | undefined) ?? 230);
  root.add(lod);
  scene.userData.landmark = 'town';
  scene.userData.replaces = JSON.parse((root.userData.replaces as string | undefined) ?? '[]') as Ring[];
  const solids = JSON.parse((root.userData.solids as string | undefined) ?? '[]') as [Ring, number][];
  scene.userData.solids = solids.map(([ring, h]): Prism => {
    const g = Math.min(...ring.map(([x, z]) => ground(x, z)));
    return { m: 'concrete', y0: g - 0.2, y1: g + h, p: [ring], n: 'town' };
  });
  return scene;
}
