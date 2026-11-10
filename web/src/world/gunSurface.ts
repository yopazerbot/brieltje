/**
 * The guns' surfaces: darker in the seams, worn on the hard edges, a fine grain all over. The models
 * have no pictures on them and no texture coordinates (tools/weapons.py); this adds the look of
 * used metal, moulded plastic and wood in the material itself.
 *
 * Two things feed it. The model carries its own shading per corner (`_shade`, baked in Blender by
 * bake_shade): how closed in a spot is, and where the thin bevels of the hard edges are. And one
 * small picture of noise, drawn here in code once and laid over the gun from three sides by its own
 * position: a fine grain, soft patches that break the edge wear up, and a few scuffs on the flats.
 *
 * It also keeps the camera from cutting a gun open (noNearCut): what comes nearer than the camera's near
 * edge is drawn all the same, so you see the outside of the stock pass by your cheek, never into it.
 *
 * Cost: three lookups in a 128 px picture, on the gun's own pixels only. A gun without the baked
 * shading (the others' guns and the ones on the floor are merged without it) reads it as nothing:
 * it gets the grain and the scuffs and no more.
 */
import * as THREE from 'three';

/** What wears through and how, per material of weapons.glb: the colour under the finish, how metallic and how rough that is, the grain's strength, the wood's streaks. */
interface Look {
  wear: string;
  metal: number;
  rough: number;
  grain: number;
  /** How many times the noise repeats per metre along x, y and z: stretched along the barrel into streaks for wood, fine for cloth (14 each way without) */
  scale?: [number, number, number];
  /** How much of the wear shows on this material, 0..1 (1 without) */
  amount?: number;
  /** Cloth and leather: worn means faded to a paler shade of its own colour, not to `wear` */
  fade?: boolean;
}
const LOOKS: Record<string, Look> = {
  Steel: { wear: '#b4b8be', metal: 1, rough: 0.26, grain: 0.35 }, // bluing worn to bright steel
  Dark: { wear: '#858a90', metal: 0.85, rough: 0.33, grain: 0.4 },
  Polymer: { wear: '#63676c', metal: 0, rough: 0.4, grain: 0.5 }, // plastic rubbed smooth and paler
  Grip: { wear: '#3c3e41', metal: 0, rough: 0.6, grain: 0.6 }, // stippled
  Olive: { wear: '#9a9d98', metal: 0.8, rough: 0.35, grain: 0.3 }, // paint chipped to bare tube
  Warhead: { wear: '#8b8e86', metal: 0.7, rough: 0.4, grain: 0.25 },
  Wood: { wear: '#b98a5e', metal: 0, rough: 0.6, grain: 0.95, scale: [34, 34, 2.6], amount: 0.4 }, // oil finish worn to paler wood, in small patches along the grain
  Brass: { wear: '#d8b866', metal: 1, rough: 0.2, grain: 0.15 },
  // Your hands and arms: the sleeve's cloth (a fine weave, faded where it rubs), the glove's leather and its trim.
  Sleeve: { wear: '#ffffff', metal: 0, rough: 0.95, grain: 0.75, scale: [70, 70, 70], amount: 0.5, fade: true },
  Glove: { wear: '#ffffff', metal: 0, rough: 0.7, grain: 0.55, scale: [46, 46, 46], amount: 0.35, fade: true },
  GloveTrim: { wear: '#ffffff', metal: 0, rough: 0.55, grain: 0.4, scale: [46, 46, 46], amount: 0.3, fade: true },
};

/** How much of the wear shows: 1, or 0 for Paintball's bright toy guns (they are new plastic). */
const amount = { value: 1 };
export function setGunWear(on: boolean): void {
  amount.value = on ? 1 : 0;
}

let noise: THREE.DataTexture | null = null;
/**
 * The noise, 128 px, repeating: red a fine grain, green soft patches about a sixth of the picture
 * across, blue larger ones. From a fixed seed, so every visit looks the same.
 */
function noiseTexture(): THREE.DataTexture {
  if (noise) return noise;
  const N = 128;
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** Smooth noise that repeats: random values on a grid of `cells`, eased between. */
  const soft = (cells: number) => {
    const grid = Array.from({ length: cells * cells }, rnd);
    const ease = (t: number) => t * t * (3 - 2 * t);
    return (x: number, y: number) => {
      const fx = (x / N) * cells;
      const fy = (y / N) * cells;
      const x0 = Math.floor(fx) % cells;
      const y0 = Math.floor(fy) % cells;
      const x1 = (x0 + 1) % cells;
      const y1 = (y0 + 1) % cells;
      const tx = ease(fx - Math.floor(fx));
      const ty = ease(fy - Math.floor(fy));
      const a = grid[y0 * cells + x0] * (1 - tx) + grid[y0 * cells + x1] * tx;
      const b = grid[y1 * cells + x0] * (1 - tx) + grid[y1 * cells + x1] * tx;
      return a * (1 - ty) + b * ty;
    };
  };
  const patches = soft(6);
  const fine = soft(24);
  const large = soft(3);
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      data[i] = Math.round(255 * (0.5 * rnd() + 0.5 * fine(x, y)));
      data[i + 1] = Math.round(255 * (0.65 * patches(x, y) + 0.35 * fine(x, y)));
      data[i + 2] = Math.round(255 * (0.7 * large(x, y) + 0.3 * patches(x, y)));
      data[i + 3] = 255;
    }
  }
  noise = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  noise.wrapS = noise.wrapT = THREE.RepeatWrapping;
  noise.minFilter = THREE.LinearMipmapLinearFilter;
  noise.magFilter = THREE.LinearFilter;
  noise.generateMipmaps = true;
  noise.needsUpdate = true;
  return noise;
}

/**
 * After the vertex is placed on the screen: one that lies nearer than the camera's near edge is put on that
 * edge instead of being cut away. The gun in your hands is drawn at a quarter of its size close to the camera,
 * so that edge lies 20 cm (in the gun's size) from your eye, right through the stock and your right arm when
 * you aim; cut there, each showed its hollow inside. Kept, you see their outsides pass by, as with a real gun
 * at your cheek. Only the depth changes, never where a point is drawn. Down to a third of the near edge's
 * distance and no closer: what is right beside the eye (your forearm towards the elbow) is still left out, or
 * it filled a corner of the view as a grey lump.
 */
const NEAR_KEPT = '#include <project_vertex>\nif (gl_Position.z > -4.7 * gl_Position.w) gl_Position.z = max(gl_Position.z, -gl_Position.w * 0.9995);';

/** Keep the camera from cutting this material's shapes open close to the eye (the gloves and sleeves; the guns get it with their surface). */
export function noNearCut(m: THREE.Material): void {
  if (m.userData.nearKept) return;
  m.userData.nearKept = true;
  const before = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    before.call(m, shader, renderer);
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', NEAR_KEPT);
  };
  const key = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${key()}|near-kept`;
  m.needsUpdate = true;
}

/** Give one of a gun's or the hands' materials (by its name in weapons.glb) the worn, grained surface. Others are left alone (false). */
export function gunSurface(m: THREE.MeshStandardMaterial): boolean {
  const look = LOOKS[m.name];
  if (!look) return false;
  const uniforms = {
    uGunNoise: { value: noiseTexture() },
    uGunWear: { value: new THREE.Color(look.wear) },
    uGunLook: { value: new THREE.Vector4(look.metal, look.rough, look.grain, look.amount ?? 1) },
    uGunScale: { value: new THREE.Vector3(...(look.scale ?? [14, 14, 14])) },
    uGunFade: { value: look.fade ? 1 : 0 },
    uGunAmount: amount,
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 _shade;\nvarying vec3 vGunPos;\nvarying vec3 vGunNormal;\nvarying vec2 vGunShade;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGunPos = position;\nvGunNormal = normal;\nvGunShade = _shade;')
      .replace('#include <project_vertex>', NEAR_KEPT);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uGunNoise;
uniform vec3 uGunWear;
uniform vec4 uGunLook;
uniform vec3 uGunScale;
uniform float uGunFade;
uniform float uGunAmount;
varying vec3 vGunPos;
varying vec3 vGunNormal;
varying vec2 vGunShade;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
// The noise from the three sides, most from the side the surface faces. Wood: stretched along the barrel into streaks.
vec3 gunW = pow(abs(normalize(vGunNormal)), vec3(4.0));
gunW /= gunW.x + gunW.y + gunW.z;
vec3 gunQ = vGunPos * uGunScale;
vec3 gunN = texture2D(uGunNoise, gunQ.zy).rgb * gunW.x + texture2D(uGunNoise, gunQ.xz).rgb * gunW.y + texture2D(uGunNoise, gunQ.xy).rgb * gunW.z;
// Worn: the hard edges in patches, and a few scuffs on the flats.
float gunWorn = uGunAmount * uGunLook.w * max(vGunShade.y * smoothstep(0.3, 0.5, gunN.g), 0.5 * smoothstep(0.68, 0.76, gunN.b) * smoothstep(0.5, 0.62, gunN.g));
diffuseColor.rgb *= 1.0 + (gunN.r - 0.5) * uGunLook.z + (gunN.b - 0.5) * 0.5 * uGunLook.z;
diffuseColor.rgb = mix(diffuseColor.rgb, mix(uGunWear, diffuseColor.rgb * 1.7 + 0.015, uGunFade), gunWorn);
diffuseColor.rgb *= 1.0 - 0.62 * vGunShade.x; // the seams and the gaps between the parts`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = clamp(mix(roughnessFactor + (gunN.r - 0.5) * 0.5 * uGunLook.z + 0.25 * vGunShade.x, uGunLook.y, gunWorn), 0.05, 1.0);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor, uGunLook.x, gunWorn);`);
  };
  m.customProgramCacheKey = () => 'gun-surface';
  m.needsUpdate = true;
  return true;
}
