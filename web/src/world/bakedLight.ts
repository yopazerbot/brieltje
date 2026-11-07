import * as THREE from 'three';
import { halfSize, loadFile } from './textureFiles';

/**
 * Baked light and wear on our own building models (tools/bake/: the light worked out in Blender's Cycles from
 * the sky photo and the sun, with the whole village round each model). A model's surfaces with a light layout
 * (a second UV map; their glTF extras name the model, its page and the layout's id) get from their page:
 *
 * - the sky's light as it really reaches them: dimmer in corners, under eaves, in porches and between houses,
 *   with the light bounced off the ground and the walls round them, in their colours. It takes the place of
 *   the sky photo's even light; the hemisphere light's fill stays only as far as the sky is open there.
 * - the sun's shadow of everything round them (other houses, trees, the model itself): the real-time sun is
 *   dimmed by it, so the whole village has shadows, not only the 17 m round the main house.
 * - the sky's reflections dimmed where little sky is seen, so recesses don't shine.
 * - wear: dirt splashed up at the foot of walls, dust in corners and under sills and eaves, streaks where rain
 *   runs down. Patchy, with a little noise in the world's own coordinates on top, so no two walls look alike.
 *   No green: the wear page's G channel (algae and moss) isn't drawn (Yoshi: it made the houses ugly).
 *
 * Costs per pixel of a baked surface: four texture reads more than before (light, wear, noise twice; the sky's
 * even light is read once, as before); on Low two (no noise): measured on this PC's integrated chip at the
 * church square, Low went from about 8.3 to 9.2 ms a frame with the noise. Only a model whose bake has the same layout id is changed, so a model
 * built again without being baked again just keeps the real-time light.
 */

interface BakeInfo {
  id: string;
  pages: number;
  size: number;
  scale: number;
}

let noise: THREE.DataTexture | null = null;

/** A tiling noise texture (256 px): R patches, G a second pattern for the rain's streaks. Made once, in code. */
function noiseTexture(): THREE.DataTexture {
  if (noise) return noise;
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  const lattice = (seed: number, period: number) => {
    const v = new Float32Array(period * period);
    let s = seed;
    for (let i = 0; i < v.length; i++) {
      s = (s * 16807) % 2147483647;
      v[i] = s / 2147483647;
    }
    return (x: number, y: number) => {
      const fx = (x / N) * period;
      const fy = (y / N) * period;
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      const tx = fx - ix;
      const ty = fy - iy;
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      const at = (i: number, j: number) => v[((j % period) + period) % period * period + (((i % period) + period) % period)];
      const a = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx;
      const b = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx;
      return a + (b - a) * sy;
    };
  };
  const octaves = (seed: number) => [lattice(seed, 8), lattice(seed + 11, 16), lattice(seed + 23, 32), lattice(seed + 37, 64)];
  const r = octaves(1234);
  const g = octaves(98765);
  const fbm = (o: ((x: number, y: number) => number)[], x: number, y: number) => (o[0](x, y) * 8 + o[1](x, y) * 4 + o[2](x, y) * 2 + o[3](x, y)) / 15;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      data[i] = Math.round(fbm(r, x, y) * 255);
      data[i + 1] = Math.round(fbm(g, x, y) * 255);
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  }
  noise = new THREE.DataTexture(data, N, N);
  noise.wrapS = noise.wrapT = THREE.RepeatWrapping;
  noise.magFilter = THREE.LinearFilter;
  noise.minFilter = THREE.LinearMipmapLinearFilter;
  noise.generateMipmaps = true;
  noise.needsUpdate = true;
  return noise;
}

const VERTEX_PARS = /* glsl */ `
varying vec3 vBakeWorld;
varying vec3 vBakeNormal;
`;
const VERTEX = /* glsl */ `
vBakeWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vBakeNormal = normalize( mat3( modelMatrix ) * objectNormal );
`;
const FRAGMENT_PARS = /* glsl */ `
uniform sampler2D bakeWear;
uniform sampler2D bakeNoise;
uniform vec4 bakeMood; // x: scale of the sky's light, y: contrast kept (1 all), z: its pivot, w: wet
varying vec3 vBakeWorld;
varying vec3 vBakeNormal;
`;

/**
 * The weather (world/weather.ts), shared by every baked material: the bake holds the sunny day's light, worked out
 * under that sky with its sun in it. Under another sky its light is scaled to that sky's (x), and its contrast is
 * pressed together round a pivot (y below 1: the side towards the sun and the sun's bounce stand out less under
 * clouds; the corners and eaves keep their share), and the walls darken a little where they are wet (w), most where
 * the rain runs down (the wear page's B). Its sun shadow (the page's A) dims only the real-time sun, which the weather
 * turns off under clouds and makes the moon at night, from the same side. Uniforms only: nothing compiles again.
 */
export const bakeMood = { value: new THREE.Vector4(1, 1, 3, 0) };
/** After the surface's colour is known: the light page's texel (used below) and the wear on the colour. */
const WEAR = /* glsl */ `
vec4 bakeTexel = texture2D( lightMap, vLightMapUv );
{
  vec3 wear = texture2D( bakeWear, vLightMapUv ).rgb;
  #ifdef BAKE_FINE
    vec3 wn = normalize( vBakeNormal );
    float patchy = texture2D( bakeNoise, vBakeWorld.xz * 0.37 + vBakeWorld.y * 0.23 ).r;
    vec2 along = normalize( vec2( - wn.z, wn.x ) + 1e-4 );
    float runs = texture2D( bakeNoise, vec2( dot( vBakeWorld.xz, along ) * 1.9, vBakeWorld.y * 0.06 ) ).g;
  #else
    float patchy = 0.5; // Low: the wear map alone, without the fine pattern (two texture reads less)
    float runs = 0.55;
  #endif
  float grime = clamp( wear.r * ( 0.55 + 0.9 * patchy ) + wear.b * smoothstep( 0.5, 0.8, runs ) * 0.6, 0.0, 1.0 );
  diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.6, 0.56, 0.5 ), grime * 0.8 );
  diffuseColor.rgb *= 1.0 - bakeMood.w * ( 0.12 + 0.3 * wear.b ); // wet: darker, most where the rain runs
}
`;
/** The sky's light from the page (stored as its square root), the hemisphere's fill as far as the sky is open. */
const INDIRECT = /* glsl */ `
float bakeOpen = 1.0;
#if defined( RE_IndirectDiffuse )
  vec3 bakeIrradiance = bakeTexel.rgb * bakeTexel.rgb * lightMapIntensity;
  float bakeLum = dot( bakeIrradiance, vec3( 0.2126, 0.7152, 0.0722 ) );
  // The weather's sky (bakeMood above): its contrast round the pivot, then its strength.
  float bakeSunny = max( bakeLum, 1e-5 );
  bakeLum = bakeMood.z * pow( bakeSunny / bakeMood.z, bakeMood.y ) * bakeMood.x;
  bakeIrradiance *= bakeLum / bakeSunny;
  #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
    vec3 bakeSky = getIBLIrradiance( geometryNormal );
    float skyLum = max( dot( bakeSky, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-4 );
    bakeOpen = clamp( bakeLum / skyLum, 0.0, 1.0 );
    // The bake's brightness in the open sky's colour, as on surfaces without a bake: its own colour (the light
    // bounced off lawns and hedges) tinted walls green in blotches (Yoshi). A little of it stays.
    bakeIrradiance = mix( bakeSky * ( bakeLum / skyLum ), bakeIrradiance, 0.15 );
  #else
    bakeIrradiance = mix( vec3( bakeLum ), bakeIrradiance, 0.15 );
  #endif
  irradiance = bakeIrradiance + irradiance * bakeOpen;
#endif
`;

let warned = false;

/** The program's lighting with the bake in it; false if three.js's chunks changed so the patch no longer fits. */
function patchLights(shader: THREE.WebGLProgramParametersWithUniforms): boolean {
  const begin = THREE.ShaderChunk.lights_fragment_begin;
  const maps = THREE.ShaderChunk.lights_fragment_maps;
  const dirInfo = 'getDirectionalLightInfo( directionalLight, directLight );';
  const specular = '#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )';
  const add = 'radiance += iblRadiance;';
  const f = shader.fragmentShader;
  if (!begin.includes(dirInfo) || !maps.includes(specular) || !maps.includes(add) || !f.includes('#include <lights_fragment_begin>') || !f.includes('#include <lights_fragment_maps>') || !f.includes('#include <map_fragment>')) {
    if (!warned) console.warn('baked light: three.js shader chunks changed; the bake is not used');
    warned = true;
    return false;
  }
  const spec = maps.slice(maps.indexOf(specular)).replace(add, 'radiance += iblRadiance * bakeOpen;');
  shader.fragmentShader = f
    .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`)
    .replace('#include <map_fragment>', `#include <map_fragment>\n${WEAR}`)
    .replace('#include <lights_fragment_begin>', begin.replace(dirInfo, `${dirInfo}\n\t\tdirectLight.color *= bakeTexel.a;`))
    .replace('#include <lights_fragment_maps>', `${INDIRECT}\n${spec}`);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
    .replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX}`);
  return true;
}

/** Every material with baked light, for switching the fine wear pattern with the graphics preset. */
const all: THREE.Material[] = [];
let fine = true;

/** The fine wear pattern (two noise reads a pixel) on Medium and up; Low keeps the light and the wear map. */
export function setBakeDetail(on: boolean): void {
  if (on === fine) return;
  fine = on;
  for (const m of all) {
    if (on) m.defines = { ...m.defines, BAKE_FINE: '' };
    else delete m.defines?.BAKE_FINE;
    m.needsUpdate = true;
  }
}

/** The material with a page's light and wear: one per original material and page. */
function baked(original: THREE.MeshStandardMaterial, light: THREE.Texture, wear: THREE.Texture, scale: number, cache: Map<string, THREE.Material>): THREE.Material {
  const key = `${original.uuid}|${light.uuid}`;
  const known = cache.get(key);
  if (known) return known;
  const m = original.clone();
  const before = original.onBeforeCompile;
  const programKey = original.customProgramCacheKey();
  m.lightMap = light;
  m.lightMapIntensity = scale * Math.PI; // the page holds irradiance / pi
  m.onBeforeCompile = (shader, renderer) => {
    before.call(m, shader, renderer);
    if (!patchLights(shader)) return;
    shader.uniforms.bakeWear = { value: wear };
    shader.uniforms.bakeNoise = { value: noiseTexture() };
    shader.uniforms.bakeMood = bakeMood;
  };
  m.customProgramCacheKey = () => `${programKey}|baked`;
  if (fine) m.defines = { ...m.defines, BAKE_FINE: '' };
  all.push(m);
  cache.set(key, m);
  return m;
}

/**
 * A page's texture: KTX2 where the browser can transcode it (world/textureFiles.ts), WebP otherwise; half size
 * on phones and tablets, as the surface textures. Not flipped: the layout's v runs down the image, as glTF's.
 */
async function page(file: string, colour: boolean, renderer: THREE.WebGLRenderer): Promise<THREE.Texture> {
  const dir = halfSize ? '/baked/half' : '/baked';
  const { texture, ready } = loadFile(`${dir}/${file}.ktx2`, `${dir}/${file}.webp`, colour, renderer, { flipY: false });
  texture.channel = 1; // the second UV map
  if (!(await ready)) throw new Error(`${file} did not load`);
  return texture;
}

/**
 * Put the baked light on a loaded model's surfaces that have a light layout. Resolves once done (or when there
 * is no bake for it, or it doesn't match: those surfaces keep the real-time light). `until` (performance.now()
 * ms): pages that come in later are not used, so a slow download can't switch materials (and compile their
 * shaders) after loading has gone on without it.
 */
export async function bakeLight(root: THREE.Object3D, renderer: THREE.WebGLRenderer, until = Infinity): Promise<void> {
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('nobake')) return; // for comparing
  const byModel = new Map<string, THREE.Mesh[]>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const u = mesh.userData as { lmModel?: string };
    if (!mesh.isMesh || !u.lmModel || !mesh.geometry.attributes.uv1) return;
    if (!(mesh.material as THREE.MeshStandardMaterial).isMeshStandardMaterial) return;
    byModel.set(u.lmModel, [...(byModel.get(u.lmModel) ?? []), mesh]);
  });
  await Promise.all(
    [...byModel].map(async ([model, meshes]) => {
      try {
        const res = await fetch(`/baked/${model}.json`);
        if (!res.ok) return;
        const info = (await res.json()) as BakeInfo;
        const fits = meshes.filter((m) => m.userData.lmId === info.id && (m.userData.lm as number) < info.pages);
        if (fits.length < meshes.length && import.meta.env.DEV) console.info(`baked light: ${model} was built again since its bake (${meshes.length - fits.length} surfaces keep real-time light)`);
        if (!fits.length) return;
        const pages = await Promise.all(
          Array.from({ length: info.pages }, (_, p) => Promise.all([page(`${model}_${p}`, true, renderer), page(`${model}_${p}_wear`, false, renderer)])),
        );
        if (performance.now() > until) return; // too late: loading went on without it
        const cache = new Map<string, THREE.Material>();
        for (const mesh of fits) {
          const [light, wear] = pages[mesh.userData.lm as number];
          mesh.material = baked(mesh.material as THREE.MeshStandardMaterial, light, wear, info.scale, cache);
        }
      } catch (e) {
        console.warn(`baked light: ${model} not available`, e);
      }
    }),
  );
}
