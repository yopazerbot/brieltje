import * as THREE from 'three';
import { halfSize, loadFile } from './textureFiles';

/**
 * The brook spirit's skin (world/brookSpirit.ts): its maps and its materials.
 *
 * The maps come from tools/brook_spirit.py (the sculpt baked onto the game model) and tools/brook_spirit_mist.py
 * (the mist's flipbook), in public/models/brook-spirit/: ktx2/ (2048; the mist 1024) and ktx2/half/ (1024; the mist
 * 512) for Low and phones, compressed for the graphics chip. As the game's other textures (world/textureFiles.ts): the
 * KTX2 file where the browser can transcode it, the WebP file otherwise; there is one WebP file of each, at 1024 (the
 * fallback is rare, and one size keeps the download small). Laid out as glTF's UVs (not flipped).
 * - <set>_color: RGB colour; A what glows (the tendrils' nodes, the hollow, the heart's membrane), on the leaves
 *   their outline.
 * - <set>_normal: tangent-space normals. <set>_orm: R occlusion, G roughness, B metal, A thinness.
 * Sets: `tendril` (the seven tendrils share one texture space) and `body` (the core, the heart, four leaves).
 *
 * The materials:
 * - The tendrils and the core: three's own lit material (sun, sky, the scene's reflections, shadows of the world, fog)
 *   with the maps, bent in the vertex shader (tangents turned with the normals, so the relief stays right as they
 *   bend), and in the pixel shader: what glows (the nodes in a wave from root to tip, the hollow), a wet rim that
 *   catches the sky with a faint oily sheen, the sun through the thin parts when it is behind them, the heart's light
 *   through the lips, the creature's own mist round it (a soft haze where they go into the cloud), and coming apart.
 * - The heart: a lantern lit from inside: the husk's membrane glows, its veins stay dark, and a brighter kernel
 *   shows through it wherever the eye's line passes close to its middle (worked out per pixel, no second mesh).
 * - The leaves: the body's maps on one curled card, the outline cut by its alpha; each picks its leaf by a number.
 */

export interface SpiritMaps {
  body: { color: THREE.Texture; normal: THREE.Texture; orm: THREE.Texture };
  tendril: { color: THREE.Texture; normal: THREE.Texture; orm: THREE.Texture };
  mist: { a: THREE.Texture; b: THREE.Texture };
  /** When every picture is in (true), or one failed (false). */
  ready: Promise<boolean>;
}

const BASE = '/models/brook-spirit';
const cache = new Map<string, SpiritMaps>();

/** The maps, full size or half (Low and phones), fetched once each. Without a renderer, the WebP files. */
export function spiritMaps(half: boolean, renderer?: THREE.WebGLRenderer): SpiritMaps {
  const key = half ? 'half' : 'full';
  let m = cache.get(key);
  if (m) return m;
  const sub = half ? '/half' : '';
  const waits: Promise<boolean>[] = [];
  const one = (name: string, colour: boolean, anisotropy = 1): THREE.Texture => {
    let t: THREE.Texture;
    // The WebP file (1024, one size) is the fallback where KTX2 can't be transcoded; rare, so one size serves both.
    const webp = `${BASE}/${name}.webp`;
    if (renderer) {
      const got = loadFile(`${BASE}/ktx2${sub}/${name}.ktx2`, webp, colour, renderer, { flipY: false });
      t = got.texture;
      waits.push(got.ready);
    } else {
      t = new THREE.TextureLoader().load(webp);
      t.flipY = false;
      t.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      waits.push(new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = webp;
      }));
    }
    t.anisotropy = anisotropy;
    return t;
  };
  const set = (s: string) => ({ color: one(`${s}_color`, true, 4), normal: one(`${s}_normal`, false, 4), orm: one(`${s}_orm`, false, 4) });
  m = {
    body: set('body'),
    tendril: set('tendril'),
    mist: { a: one('mist_a', false), b: one('mist_b', false) },
    ready: Promise.resolve(true),
  };
  m.ready = Promise.all(waits).then((r) => r.every(Boolean));
  cache.set(key, m);
  return m;
}

/** Whether this device gets the half-size maps whatever the look (phones and tablets, as the game's textures). */
export const spiritHalf = halfSize;

// ---------------------------------------------------------------------------------------------- shaders

/** A cheap smooth noise for the dissolve (value noise on a hashed lattice). */
export const NOISE = /* glsl */ `
float spiritHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float spiritNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(spiritHash(i), spiritHash(i + vec3(1, 0, 0)), f.x), mix(spiritHash(i + vec3(0, 1, 0)), spiritHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(spiritHash(i + vec3(0, 0, 1)), spiritHash(i + vec3(1, 0, 1)), f.x), mix(spiritHash(i + vec3(0, 1, 1)), spiritHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}`;

/**
 * The creature's own cloud of mist as a haze on its solid parts: how much mist lies on the eye's line to this
 * pixel inside an ellipsoid round the body (thickest through the middle), so the tendrils and the core go softly
 * into the cloud instead of meeting the sprites with a hard edge. Less of it in front of the opening when it is open.
 */
export const MIST_HAZE = /* glsl */ `
uniform vec4 uMist;      // the cloud's middle in the world, how thick
uniform vec3 uMistR;     // its radii
uniform vec4 uMistFront; // the front's way in the world, how open
uniform vec3 uMistTint;
varying vec3 vSpiritWorld;
float spiritHaze() {
  vec3 ro = cameraPosition;
  vec3 rd = vSpiritWorld - ro;
  float len = length(rd);
  rd /= len;
  vec3 oc = (ro - uMist.xyz) / uMistR;
  vec3 dd = rd / uMistR;
  float a = dot(dd, dd);
  float b = dot(oc, dd);
  float c = dot(oc, oc) - 1.0;
  float disc = b * b - a * c;
  if (disc <= 0.0) return 0.0;
  float sq = sqrt(disc);
  float t0 = max((-b - sq) / a, 0.0);
  float t1 = min((-b + sq) / a, len);
  if (t1 <= t0) return 0.0;
  float tm = clamp(-b / a, t0, t1);
  float dmin = length(oc + dd * tm);
  float depth = (t1 - t0) * (1.0 - dmin * dmin);
  float front = smoothstep(0.55, 0.92, dot(normalize(ro - uMist.xyz), uMistFront.xyz));
  return 1.0 - exp(-depth * uMist.w * (1.0 - 0.85 * uMistFront.w * front));
}
vec3 spiritHazeColour() {
  vec3 c = vec3(0.0);
  #if NUM_HEMI_LIGHTS > 0
    c += (hemisphereLights[0].skyColor * 0.65 + hemisphereLights[0].groundColor * 0.35);
  #endif
  #if NUM_DIR_LIGHTS > 0
    c += directionalLights[0].color * 0.18;
  #endif
  c += ambientLightColor;
  return c * uMistTint * RECIPROCAL_PI;
}`;

/**
 * The tendrils' bend. Each arm's direction at s (0 root .. 1 tip) is its straight axis turned by two angles: `al`
 * towards its underside (droop, curl, two overlapping waves running out from the root, a flinch's ripple) and `be`
 * sideways. The spine is summed from the root in ten small steps, so it stays smooth for every t; the cross-section
 * (normal and tangent too) turns with it. brookSpirit.ts tip() works out the same curve.
 */
export const ARMS = 7;
export const TENDRIL_VERTEX = /* glsl */ `
attribute vec2 aArm;
uniform vec4 uFrame[${ARMS * 4}];
uniform vec4 uBendA[${ARMS}];
uniform vec4 uBendB[${ARMS}];
uniform vec4 uArmX[${ARMS}];
uniform float uPhase;
varying vec3 vSpirit;
varying vec3 vLocal;
varying vec3 vSpiritWorld;
vec3 spiritDir(float s, vec4 A, vec4 B, vec4 X, vec3 D, vec3 U, vec3 S, out float al, out float be) {
  al = A.x + A.y * s + A.z * smoothstep(0.55, 1.0, s)
     + A.w * s * (sin(5.0 * s - uPhase + B.w) + 0.45 * sin(2.3 * s - 0.55 * uPhase + 2.1 * B.w))
     + X.w * exp(-pow((s - X.z) / 0.13, 2.0));
  be = B.x + B.y * s + B.z * s * sin(4.0 * s - 0.8 * uPhase + 1.7 * B.w);
  float ca = cos(al);
  return D * (ca * cos(be)) - U * sin(al) + S * (ca * sin(be));
}`;

export const TENDRIL_BEND = /* glsl */ `
int ai = int(aArm.y + 0.5);
vec4 F0 = uFrame[ai * 4];
vec3 aD = uFrame[ai * 4 + 1].xyz;
vec3 aU = uFrame[ai * 4 + 2].xyz;
vec3 aS = uFrame[ai * 4 + 3].xyz;
vec4 A = uBendA[ai];
vec4 B = uBendB[ai];
vec4 X = uArmX[ai];
vec3 rel = position - F0.xyz;
float along = dot(rel, aD);
float t = clamp(along / F0.w, 0.0, 1.0);
float al;
float be;
vec3 P = vec3(0.0);
for (int k = 0; k < 10; k++) P += spiritDir(t * (float(k) + 0.5) / 10.0, A, B, X, aD, aU, aS, al, be);
P *= t * F0.w * X.x / 10.0;
vec3 T = spiritDir(t, A, B, X, aD, aU, aS, al, be);
vec3 Ut = aD * (sin(al) * cos(be)) + aU * cos(al) + aS * (sin(al) * sin(be));
vec3 St = aS * cos(be) - aD * sin(be);
vec3 bent = F0.xyz + P + (St * dot(rel, aS) + Ut * dot(rel, aU)) * X.y + T * (along - t * F0.w);
vec3 objectNormal = normalize(T * dot(normal, aD) + Ut * dot(normal, aU) + St * dot(normal, aS));
#ifdef USE_TANGENT
  vec3 objectTangent = T * dot(tangent.xyz, aD) + Ut * dot(tangent.xyz, aU) + St * dot(tangent.xyz, aS);
#endif
vSpirit = vec3(t, 0.0, aArm.y);
vLocal = position;
vSpiritWorld = (modelMatrix * vec4(bent, 1.0)).xyz;`;

/** The core: the opening's edge slides from LIP_OPEN to uLip, everything behind it squeezed to make room. */
export const LIP_OPEN = 0.78;
export const LIP_SHUT = 0.1;
export const CORE_VERTEX = /* glsl */ `
attribute vec2 aInside;
uniform float uLip;
varying vec3 vSpirit;
varying vec3 vLocal;
varying vec3 vSpiritWorld;`;

export const CORE_BEND = /* glsl */ `
vec3 cq = position / vec3(1.12, 0.92, 1.0);
float cr = length(cq);
vec3 cd = cq / max(cr, 1e-5);
float th = acos(clamp(cd.z, -1.0, 1.0));
float th2 = th >= ${LIP_OPEN.toFixed(3)} ? PI - (PI - th) * (PI - uLip) / (PI - ${LIP_OPEN.toFixed(3)}) : th - ${LIP_OPEN.toFixed(3)} + uLip;
float cl = length(cd.xy);
vec2 ring = cl > 1e-5 ? cd.xy / cl : vec2(1.0, 0.0);
vec3 bent = vec3(ring * sin(th2), cos(th2)) * cr * vec3(1.12, 0.92, 1.0);
float dth = th2 - th;
vec3 ck = vec3(-ring.y, ring.x, 0.0);
vec3 objectNormal = normal * cos(dth) + cross(ck, normal) * sin(dth) + ck * dot(ck, normal) * (1.0 - cos(dth));
#ifdef USE_TANGENT
  vec3 objectTangent = tangent.xyz * cos(dth) + cross(ck, tangent.xyz) * sin(dth) + ck * dot(ck, tangent.xyz) * (1.0 - cos(dth));
#endif
vSpirit = vec3(0.0, aInside.x, 0.0);
vLocal = position;
vSpiritWorld = (modelMatrix * vec4(bent, 1.0)).xyz;`;

/** Shared by the core and the tendrils. */
const BODY_FRAGMENT = /* glsl */ `
uniform vec3 uLight;
uniform float uGlow;
uniform float uInner;
uniform float uRim;
uniform float uFade;
uniform float uPulse;
uniform float uHurt;
varying vec3 vSpirit;
varying vec3 vLocal;
${NOISE}`;

const BODY_CUT = /* glsl */ `
float spiritCut = -1.0;
if (uFade > 0.0) {
  // Coming apart from the tips inwards (the core in patches, last), its edges glowing; all of it gone by about 0.8,
  // while the mist and the lights linger.
  float n = spiritNoise(vLocal * 5.0) * 0.6 + spiritNoise(vLocal * 13.0) * 0.4;
  #ifdef SPIRIT_CORE
    float keep = 0.35 + 0.65 * n;
  #else
    float keep = (1.0 - vSpirit.x) * 0.8 + 0.3 * n;
  #endif
  spiritCut = uFade * 1.3 - keep;
  if (spiritCut > 0.0) discard;
}
#include <clipping_planes_fragment>`;

/** After three's map reads: what glows (the colour map's alpha) and how thin it is (the packed map's alpha). */
const BODY_MAPS = /* glsl */ `
#include <map_fragment>
// (Both alphas are stored as 0.5 + 0.5 * value: see tools/brook_spirit.py.)
float spiritMask = 0.0;
#ifdef USE_MAP
  spiritMask = clamp(sampledDiffuseColor.a * 2.0 - 1.0, 0.0, 1.0);
  diffuseColor.a = opacity;
#endif
float spiritThin = 0.5;
#ifdef USE_ROUGHNESSMAP
  spiritThin = clamp(texture2D(roughnessMap, vRoughnessMapUv).a * 2.0 - 1.0, 0.0, 1.0);
#endif`;

const BODY_GLOW = /* glsl */ `
#include <emissivemap_fragment>
{
  vec3 spiritV = normalize(vViewPosition);
  float NdV = clamp(dot(normal, spiritV), 0.0, 1.0);
  #ifdef SPIRIT_CORE
    // The hollow and its veins, lit by the heart; the heart's light through the thin lips round the opening.
    totalEmissiveRadiance += uLight * spiritMask * uInner;
    totalEmissiveRadiance += uLight * spiritThin * spiritThin * uInner * 0.3 * smoothstep(0.35, 0.95, normalize(vLocal).z);
  #else
    // The nodes: a pulse running out along the arm from the root, the next close behind it.
    float wave = pow(0.5 + 0.5 * sin(vSpirit.x * 20.0 - uPulse), 5.0);
    totalEmissiveRadiance += uLight * spiritMask * uGlow * (0.45 + 1.8 * wave);
    // Near the body the heart's light shines through the thin skin.
    totalEmissiveRadiance += uLight * spiritThin * uInner * 0.12 * exp(-vSpirit.x * 14.0);
  #endif
  // Wet skin: a thin rim that catches the sky's brightness (not its blue: the skin stays dark and opaque), with a faint
  // oily sheen that shifts with the angle.
  vec3 spiritSky = ambientLightColor;
  #if NUM_HEMI_LIGHTS > 0
    spiritSky += hemisphereLights[0].skyColor;
  #endif
  float fres = pow(1.0 - NdV, 5.0);
  vec3 film = 0.9 + 0.1 * cos(6.2832 * (NdV * 1.2 + vec3(0.55, 0.35, 0.15)));
  totalEmissiveRadiance += vec3(dot(spiritSky, vec3(0.3, 0.59, 0.11))) * film * fres * uRim * (1.0 - roughnessFactor);
  // The sun (or moon) through the thin parts when it is right behind them: a faint warm glow in the frill only (seen
  // from below against the sun it lit the frills as a row of white teeth, a sparkle on Low).
  #if NUM_DIR_LIGHTS > 0
    float back = pow(clamp(dot(-spiritV, directionalLights[0].direction), 0.0, 1.0), 8.0);
    totalEmissiveRadiance += directionalLights[0].color * diffuseColor.rgb * back * spiritThin * spiritThin * 0.12;
  #endif
  totalEmissiveRadiance += uLight * uHurt * (0.15 + 0.5 * spiritThin) * 0.6;
  if (uFade > 0.0) totalEmissiveRadiance += uLight * 3.0 * smoothstep(-0.1, 0.0, spiritCut);
}`;

const BODY_HAZE = /* glsl */ `
gl_FragColor.rgb = mix(gl_FragColor.rgb, spiritHazeColour(), spiritHaze());
#include <fog_fragment>`;

/** The uniforms every part's material reads (one object, so one update a frame serves them all). */
export function spiritUniforms() {
  return {
    uLight: { value: new THREE.Color() },
    uGlow: { value: 1 },
    uInner: { value: 0 },
    uRim: { value: 0.3 },
    uFade: { value: 0 },
    uPulse: { value: 0 },
    uHurt: { value: 0 },
    uPhase: { value: 0 },
    uLip: { value: LIP_SHUT },
    uFrame: { value: Array.from({ length: ARMS * 4 }, () => new THREE.Vector4()) },
    uBendA: { value: Array.from({ length: ARMS }, () => new THREE.Vector4()) },
    uBendB: { value: Array.from({ length: ARMS }, () => new THREE.Vector4()) },
    uArmX: { value: Array.from({ length: ARMS }, () => new THREE.Vector4(1, 1, 0, 0)) },
    uMist: { value: new THREE.Vector4(0, 0, 0, 0.6) },
    uMistR: { value: new THREE.Vector3(2.3, 1.6, 2.3) },
    uMistFront: { value: new THREE.Vector4(0, 0, 1, 0) },
    uMistTint: { value: new THREE.Color(0.3, 0.32, 0.34) },
    uHeartK: { value: 1 },
    uHeartView: { value: new THREE.Vector3() },
  };
}
export type SpiritUniforms = ReturnType<typeof spiritUniforms>;

/** The lit material of the core or the tendrils, with their bend, glow and haze put into three.js's own shader. */
export function bodyMaterial(part: 'core' | 'tendrils', u: SpiritUniforms, maps: SpiritMaps['body']): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map: maps.color,
    normalMap: maps.normal,
    aoMap: maps.orm,
    roughnessMap: maps.orm,
    roughness: 1,
    metalness: 0,
    // Wet highlights from the sun that move over the forms, not a mirror of the sky.
    envMapIntensity: 0.55,
  });
  m.normalScale.set(1, 1); // glTF's convention, with the model's own tangents
  const core = part === 'core';
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, u);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>\n${core ? CORE_VERTEX : TENDRIL_VERTEX}`)
      .replace('#include <beginnormal_vertex>', core ? CORE_BEND : TENDRIL_BEND)
      .replace('#include <begin_vertex>', 'vec3 transformed = bent;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\n${BODY_FRAGMENT}`)
      .replace('#include <lights_pars_begin>', `#include <lights_pars_begin>\n${MIST_HAZE}`)
      .replace('#include <clipping_planes_fragment>', BODY_CUT)
      .replace('#include <map_fragment>', BODY_MAPS)
      .replace('#include <emissivemap_fragment>', BODY_GLOW)
      .replace('#include <fog_fragment>', BODY_HAZE);
  };
  if (core) m.defines = { SPIRIT_CORE: '' };
  m.customProgramCacheKey = () => (core ? 'brook-core-2' : 'brook-tendrils-2');
  return m;
}

/** Point a part's material at another set of maps (full or half size): the same kind of texture, no recompile. */
export function useMaps(m: THREE.MeshStandardMaterial, maps: SpiritMaps['body']): void {
  m.map = maps.color;
  m.normalMap = maps.normal;
  m.aoMap = maps.orm;
  m.roughnessMap = maps.orm;
}

const HEART_VERTEX = /* glsl */ `
uniform vec3 uHeartView;
varying vec2 vUv;
varying vec3 vView;
varying vec3 vN;
varying vec3 vSpiritWorld;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vView = mvPosition.xyz;
  vN = normalize(normalMatrix * normal);
  vUv = uv;
  vSpiritWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const HEART_FRAGMENT = /* glsl */ `
#include <common>
#include <lights_pars_begin>
uniform sampler2D map;
uniform vec3 uLight;
uniform float uHeart;
uniform float uHeartK;
uniform vec3 uHeartView;
varying vec2 vUv;
varying vec3 vView;
varying vec3 vN;
${MIST_HAZE}
#include <fog_pars_fragment>
void main() {
  vec4 husk = texture2D(map, vUv);
  vec3 rd = normalize(vView);
  // How close the eye's line passes to the heart's middle: the kernel glowing through the husk.
  float d = length(cross(rd, uHeartView)) / max(uHeartK, 0.05);
  float kernel = exp(-pow(d / 0.075, 2.0)) * 1.6 + exp(-pow(d / 0.17, 2.0)) * 0.55;
  float facing = abs(dot(normalize(vN), -rd));
  // The membrane between the veins glows; the veins and ribs stay dark against it.
  float membrane = pow(clamp(husk.a * 2.0 - 1.0, 0.0, 1.0), 1.4);
  vec3 light = mix(uLight, vec3(1.0), clamp(kernel * 0.45, 0.0, 0.8));
  vec3 c = light * uHeart * membrane * (0.18 + 0.35 * facing + kernel);
  // By day the husk's own colours show a little (lit by the sky).
  vec3 sky = ambientLightColor;
  #if NUM_HEMI_LIGHTS > 0
    sky += hemisphereLights[0].skyColor;
  #endif
  c += husk.rgb * sky * 0.12;
  gl_FragColor = vec4(c, 1.0);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, spiritHazeColour(), spiritHaze() * 0.6);
  #include <fog_fragment>
}`;

/** The heart's lantern: light of its own (no lighting but the sky on its husk by day). */
export function heartMaterial(u: SpiritUniforms, heartU: { uHeart: { value: number } }, maps: SpiritMaps['body']): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.lights),
      map: { value: maps.color },
      uLight: u.uLight,
      uHeart: heartU.uHeart,
      uHeartK: u.uHeartK,
      uHeartView: u.uHeartView,
      uMist: u.uMist,
      uMistR: u.uMistR,
      uMistFront: u.uMistFront,
      uMistTint: u.uMistTint,
    },
    vertexShader: HEART_VERTEX,
    fragmentShader: HEART_FRAGMENT,
    fog: true,
    lights: true,
  });
}

/** The leaves of the ring: the body's maps, outline cut by alpha, each its own leaf by `aLeaf` (0 oak .. 3 alder). */
export function leafMaterial(maps: SpiritMaps['body']): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ map: maps.color, normalMap: maps.normal, roughness: 0.75, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.5 });
  m.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aLeaf;')
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
#ifdef USE_MAP
  vMapUv.x += aLeaf * 0.125;
#endif
#ifdef USE_NORMALMAP
  vNormalMapUv.x += aLeaf * 0.125;
#endif`,
      );
    // Leaves let the light through: lit a little from behind too.
    s.fragmentShader = s.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
#if NUM_DIR_LIGHTS > 0
  totalEmissiveRadiance += directionalLights[0].color * diffuseColor.rgb * 0.12 * pow(clamp(dot(normalize(-vViewPosition), directionalLights[0].direction), 0.0, 1.0), 2.0);
#endif`,
    );
  };
  m.customProgramCacheKey = () => 'brook-leaf';
  return m;
}
