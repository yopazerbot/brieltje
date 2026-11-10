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
  /** Stretch the noise along the barrel into streaks (wood) */
  streak?: boolean;
}
const LOOKS: Record<string, Look> = {
  Steel: { wear: '#b4b8be', metal: 1, rough: 0.26, grain: 0.35 }, // bluing worn to bright steel
  Dark: { wear: '#858a90', metal: 0.85, rough: 0.33, grain: 0.4 },
  Polymer: { wear: '#63676c', metal: 0, rough: 0.4, grain: 0.5 }, // plastic rubbed smooth and paler
  Grip: { wear: '#3c3e41', metal: 0, rough: 0.6, grain: 0.6 }, // stippled
  Olive: { wear: '#9a9d98', metal: 0.8, rough: 0.35, grain: 0.3 }, // paint chipped to bare tube
  Warhead: { wear: '#8b8e86', metal: 0.7, rough: 0.4, grain: 0.25 },
  Wood: { wear: '#b98a5e', metal: 0, rough: 0.6, grain: 0.95, streak: true }, // oil finish worn to paler wood
  Brass: { wear: '#d8b866', metal: 1, rough: 0.2, grain: 0.15 },
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

/** Give one of a gun's materials (by its name in weapons.glb) the worn, grained surface. Others are left alone. */
export function gunSurface(m: THREE.MeshStandardMaterial): void {
  const look = LOOKS[m.name];
  if (!look) return;
  const uniforms = {
    uGunNoise: { value: noiseTexture() },
    uGunWear: { value: new THREE.Color(look.wear) },
    uGunLook: { value: new THREE.Vector4(look.metal, look.rough, look.grain, look.streak ? 1 : 0) },
    uGunAmount: amount,
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 _shade;\nvarying vec3 vGunPos;\nvarying vec3 vGunNormal;\nvarying vec2 vGunShade;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGunPos = position;\nvGunNormal = normal;\nvGunShade = _shade;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uGunNoise;
uniform vec3 uGunWear;
uniform vec4 uGunLook;
uniform float uGunAmount;
varying vec3 vGunPos;
varying vec3 vGunNormal;
varying vec2 vGunShade;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
// The noise from the three sides, most from the side the surface faces. Wood: stretched along the barrel into streaks.
vec3 gunW = pow(abs(normalize(vGunNormal)), vec3(4.0));
gunW /= gunW.x + gunW.y + gunW.z;
vec3 gunQ = vGunPos * mix(vec3(14.0), vec3(34.0, 34.0, 2.6), uGunLook.w);
vec3 gunN = texture2D(uGunNoise, gunQ.zy).rgb * gunW.x + texture2D(uGunNoise, gunQ.xz).rgb * gunW.y + texture2D(uGunNoise, gunQ.xy).rgb * gunW.z;
// Worn: the hard edges in patches, and a few scuffs on the flats.
float gunWorn = uGunAmount * max(vGunShade.y * smoothstep(0.3, 0.5, gunN.g), 0.5 * smoothstep(0.68, 0.76, gunN.b) * smoothstep(0.5, 0.62, gunN.g));
diffuseColor.rgb *= 1.0 + (gunN.r - 0.5) * uGunLook.z + (gunN.b - 0.5) * 0.5 * uGunLook.z;
diffuseColor.rgb = mix(diffuseColor.rgb, uGunWear, gunWorn);
diffuseColor.rgb *= 1.0 - 0.62 * vGunShade.x; // the seams and the gaps between the parts`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = clamp(mix(roughnessFactor + (gunN.r - 0.5) * 0.5 * uGunLook.z + 0.25 * vGunShade.x, uGunLook.y, gunWorn), 0.05, 1.0);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor, uGunLook.x, gunWorn);`);
  };
  m.customProgramCacheKey = () => 'gun-surface';
  m.needsUpdate = true;
}
