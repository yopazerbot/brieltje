import * as THREE from 'three';
import { snowOn } from './snowCover';
import { washOn } from './washShader';

/**
 * A gentle wind through the tree crowns and the leafy lumps on the hedges, worked out in their
 * vertex shaders: the crown leans a few centimetres with the wind and back, more at the top than
 * at the bottom, and its leaves flutter a little. Gusts roll across the land, so neighbouring trees
 * move nearly together and a field away they don't.
 *
 * The wind blows from the south-west in the sun, the usual wind here, and follows the weather (`wind` below). The shapes are drawn as instances, so
 * a tree's place (its instance matrix) gives it its own timing; nothing is worked out per tree on
 * the processor. Off on phones (`strength` 0: the shader skips it).
 *
 * It is the end of October: the tree crowns can also be turning, about two in three of them, some
 * to ochre (birch, poplar), some to orange-brown (beech, oak) and some to brown, each by its own
 * share; the rest stay green, each a shade of its own. Also in the shader, from the tree's place.
 */

// From the south-west towards the north-east, in the model (grid north is (-0.666, 0.746)): the sunny day's wind.
const DIR = new THREE.Vector2(-0.998, 0.057);
/** Seconds: the shared clock is taken round this, so the shaders' sums keep their precision (a float has 24 bits). */
const PERIOD = 4096;

/**
 * One wind for everything (Yoshi, 20 Nov 2026: "the wind follows the weather"), as big games keep it: one direction and
 * strength for the whole world, with gusts rolling across the land, that every system reads (the trees, the hedges, the
 * grass, the bank plants, the water, the rain's slant, the snow's drift, the smoke, the flags, a falling leaf, the
 * sniper's bullet). The weather sets it each frame (windStep, from world/weather.ts): how hard as a factor of the sunny
 * day's breeze (`speed`), how gusty (`rough`: faster, sharper gusts on top), and from where (`dir`), each blended
 * through a change of mood as the light is. Calm at dusk and at night, a breeze in the sun, fresh under clouds, gusty
 * in the rain, light with snow. Its clock is the shared one (the server's when playing together), so the wind comes
 * out the same on every page from the mood and the clock: nothing more is sent.
 *
 * In the sun it is exactly the breeze it always was (speed 1, rough 0, from the south-west): the sniper's drift there is
 * a rule of the game.
 */
export const wind = {
  /** Seconds on the shared clock, taken round PERIOD */
  time: { value: 0 },
  /** 0 or 1: the shaders' sway on (off on phones) */
  strength: { value: 1 },
  /** Where it blows to (a unit vector on the plan, x and z) */
  dir: { value: DIR.clone() },
  /** How hard on average, as a factor of the sunny day's breeze (1) */
  speed: { value: 1 },
  /** How much of the faster, sharper gusts are on top (0 in the sun) */
  rough: { value: 0 },
  /** How far the trees have turned: 1 at the end of October, 0 all green. */
  autumn: { value: 1 },
  /** How hard the wind blows at (x, z) now, a factor of the sunny day's breeze (0.1 to 1 in the sun): the gusts the trees show. */
  gust(x: number, z: number): number {
    const t = wind.time.value;
    const d = x * wind.dir.value.x + z * wind.dir.value.y;
    const slow = Math.sin(t * 0.23 - d * 0.012) * (0.75 + 0.25 * Math.sin(t * 0.071 + 1.3));
    const fast = wind.rough.value ? Math.sin(t * 0.83 - d * 0.035 + 0.7) * (0.6 + 0.4 * Math.sin(t * 0.29 + 2.1)) : 0;
    return Math.max(0.05, wind.speed.value * (0.55 + 0.45 * slow + wind.rough.value * fast));
  },
};

/**
 * The wind's uniforms and its gust, for a shader (vertex or fragment): `windGust(p)` is wind.gust at p on the plan;
 * `windDir` where it blows to. Put the text after `#include <common>` and the uniforms in with windUniforms.
 */
export const WIND_GLSL = /* glsl */ `
  uniform float windTime;
  uniform float windStrength;
  uniform vec2 windDir;
  uniform float windSpeed;
  uniform float windRough;
  float windGust(vec2 p) {
    float d = dot(p, windDir);
    float slow = sin(windTime * 0.23 - d * 0.012) * (0.75 + 0.25 * sin(windTime * 0.071 + 1.3));
    float fast = sin(windTime * 0.83 - d * 0.035 + 0.7) * (0.6 + 0.4 * sin(windTime * 0.29 + 2.1));
    return max(0.05, windSpeed * (0.55 + 0.45 * slow + windRough * fast));
  }`;

/** The uniforms WIND_GLSL reads, into a shader's (onBeforeCompile). */
export function windUniforms(uniforms: Record<string, THREE.IUniform>): void {
  Object.assign(uniforms, { windTime: wind.time, windStrength: wind.strength, windDir: wind.dir, windSpeed: wind.speed, windRough: wind.rough });
}

/**
 * The weather's wind now (world/weather.ts, each frame): `clock` the shared clock in ms (the server's when together),
 * `speed` and `rough` as the mood blend has them, `veer` radians it has turned from the sunny day's south-west. It
 * wanders a little round that by itself, `wander` radians at most, slowly (minutes), from the same clock: the same on
 * every page.
 */
export function windStep(clock: number, speed: number, rough: number, veer: number, wander: number): void {
  const s = clock / 1000;
  wind.time.value = ((s % PERIOD) + PERIOD) % PERIOD;
  wind.speed.value = speed;
  wind.rough.value = rough;
  const a = veer + wander * (0.7 * Math.sin(s * 0.0041 + 0.4) + 0.3 * Math.sin(s * 0.0113 + 2.2));
  const c = Math.cos(a), n = Math.sin(a);
  wind.dir.value.set(DIR.x * c - DIR.y * n, DIR.x * n + DIR.y * c);
}

/** m/s: the sunny breeze at its strongest gust. */
const WIND_MAX = 4.5;
/** How hard the wind pushes the sniper rifle's bullet, m/s² for each m/s of wind (weapon.ts). */
export const WIND_PUSH = 0.7;

/**
 * The wind as it pushes things at (x, z) now, m/s along x and z: the way the trees lean and with their
 * gusts, so what you see in the crowns is what carries a muzzle's smoke off (world/effects.ts) and pushes
 * a long sniper shot a little sideways (weapon.ts, where the scope shows it). Gentle on purpose: in the sun at
 * its strongest a 190 m shot across it lands some 40 cm off, one at 100 m about 10 cm; in a gusty rain about twice
 * that at the peaks, at dusk and at night hardly anything.
 */
export function windAt(x: number, z: number): { x: number; z: number; speed: number } {
  const speed = wind.gust(x, z) * WIND_MAX;
  return { x: wind.dir.value.x * speed, z: wind.dir.value.y * speed, speed };
}

/**
 * Make an instanced material sway. `lean` is how far the top leans (in the shape's own units: a
 * crown is about 1 across, a hedge lump too), `flutter` how far its surface trembles.
 */
export function sway(material: THREE.MeshStandardMaterial, lean: number, flutter: number, turning = false): void {
  const before = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    windUniforms(shader.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WIND_GLSL}`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
        if (windStrength > 0.0) {
          vec2 wRoot = instanceMatrix[3].xz;
          vec2 wDir = windDir;
          // Gusts travel downwind across the land; each tree sways at its own pace on top.
          float wGust = windGust(wRoot);
          float wPhase = wRoot.x * 0.37 + wRoot.y * 0.29;
          float wUp = clamp(transformed.y * 0.5 + 0.55, 0.0, 1.4);
          float wLean = (0.6 + 0.4 * sin(windTime * 1.15 + wPhase)) * wGust * wUp * ${lean.toFixed(4)};
          float wShake = sin(windTime * 4.3 + dot(transformed, vec3(6.1, 4.7, 5.3)) + wPhase) * wGust * ${flutter.toFixed(4)};
          transformed.xz += wDir * wLean * windStrength + objectNormal.xz * wShake * windStrength;
        }
        #endif`,
      );
    if (turning) {
      shader.uniforms.autumn = wind.autumn;
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform float autumn;').replace(
        '#include <color_vertex>',
        `#include <color_vertex>
        #if defined(USE_INSTANCING) && defined(USE_COLOR)
        {
          // How far this tree has turned, and to which colour, from its place; light and dark within the crown kept.
          vec2 aRoot = floor(instanceMatrix[3].xz * 2.0);
          float aHash = fract(sin(dot(aRoot, vec2(12.9898, 78.233))) * 43758.5453);
          // Each tree its own green: a little lighter or darker, yellower or bluer.
          vColor.rgb *= (0.86 + 0.28 * fract(aHash * 91.37)) * mix(vec3(1.06, 1.03, 0.8), vec3(0.95, 1.0, 1.12), fract(aHash * 53.71));
          float aKind = fract(aHash * 17.31);
          float aTurn = smoothstep(0.3, 1.0, aHash) * 0.7 * autumn;
          vec3 aCol = aKind < 0.4 ? vec3(0.2, 0.15, 0.025) : aKind < 0.75 ? vec3(0.21, 0.09, 0.02) : vec3(0.13, 0.08, 0.03);
          float aShade = dot(vColor.rgb, vec3(0.3, 0.59, 0.11)) / 0.16;
          vColor.rgb = mix(vColor.rgb, aCol * aShade, aTurn);
        }
        #endif`,
      );
    }
    snowOn(shader); // snow on the crowns and the hedges' tops (world/snowCover.ts)
    washOn(shader); // a helicopter's rotor wash shakes them (world/washShader.ts)
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${key()}|sway${lean}${turning ? '|autumn' : ''}`;
  material.needsUpdate = true;
}

/**
 * The leaves of the clipped hedges tremble: the plain hedge blocks (no leafy lumps, there are kilometres
 * of them) read their textures a few millimetres off, the offset rippling over the surface at about a
 * leaf's size and following the gusts. Nothing moves, so no gap can open along a hedge's edges; a few
 * sums per pixel. Off where the wind is off.
 */
export function rustle(material: THREE.MeshStandardMaterial): void {
  const before = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    windUniforms(shader.uniforms);
    const offset = (chunk: string, uv: string) => THREE.ShaderChunk[chunk as keyof typeof THREE.ShaderChunk].split(uv).join(`(${uv} + rustleUv)`);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WIND_GLSL}\nvarying vec3 vRustleAt;\nvarying float vRustleGust;`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vRustleAt = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vRustleGust = windStrength * min(windGust(vRustleAt.xz), 1.6);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float windTime;\nvarying vec3 vRustleAt;\nvarying float vRustleGust;')
      .replace(
        '#include <map_fragment>',
        `vec2 rustleUv = vRustleGust * 0.002 * vec2(sin(dot(vRustleAt, vec3(31.0, 23.0, 27.0)) + windTime * 6.3), sin(dot(vRustleAt, vec3(-19.0, 29.0, 35.0)) + windTime * 4.9));
        ${offset('map_fragment', 'vMapUv')}`,
      )
      .replace('#include <roughnessmap_fragment>', offset('roughnessmap_fragment', 'vRoughnessMapUv'))
      .replace('#include <normal_fragment_maps>', offset('normal_fragment_maps', 'vNormalMapUv'));
    snowOn(shader); // snow on the hedges' tops (world/snowCover.ts)
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${key()}|rustle`;
  material.needsUpdate = true;
}
