import * as THREE from 'three';
import { house } from './houseData';

/**
 * The haze seen from the air. On the ground the scene's haze (FogExp2, world/weather.ts sets its density by the mood)
 * hides about 85% at the draw distance (725 m in the sun), which is what keeps the end of the drawn tiles out of
 * sight. From a parachute or a helicopter that same haze made everything past a kilometre one flat pale band, and the
 * village under you milky: you look down through the thin air above the land, not along the ground through its
 * thickest layer.
 *
 * So the haze depends on how high the eye is, by one GLSL function that replaces three.js's own fog for every
 * material (patched once into its shader chunks, before anything compiles). Up to about 8 m above the ground it is
 * the plain haze, to the bit: the street looks exactly as before. Higher up:
 * - nearer than the draw distance (`x` below 1, where the plain haze hides 85%) it is clearer close by and catches
 *   up towards that point (the power rises from 2 to 3.5), where it hides 70% from 150 m up: the end of the drawn
 *   tiles stays in the haze, and past it the far land (world/farLand.ts) carries the fields on;
 * - past it, the haze no longer closes at once but thickens slowly (an exponential tail that starts where the plain
 *   haze is, with its slope, stretched as the eye rises): the land runs on, ever paler, into the haze and the sky,
 *   instead of ending in a wall a kilometre out.
 * The ground under the eye is the model's flat ground (the relief adds a few metres at most).
 *
 * A few multiplies per pixel, no texture, no uniform of its own (the eye's height comes from `cameraPosition`).
 */

/** The model's flat ground: the height the eye's height is counted from. */
const GROUND = house.ground;

/**
 * The haze's transmittance (1: clear, 0: all haze) at view depth `depth` for a FogExp2 `density`, as seen from the eye's
 * height. Also used by the horizon's ring (world/horizon.ts), so the haze below its tree lines matches the land.
 */
export const AIR_HAZE_GLSL = /* glsl */ `
  float airHazeWeight() {
    return smoothstep(8.0, 40.0, cameraPosition.y - (${GROUND.toFixed(3)}));
  }
  float airHaze(float depth, float density) {
    float plain = exp(-density * density * depth * depth);
    float w = airHazeWeight();
    if (w <= 0.0) return plain; // on the ground (the same for the whole draw: no cost)
    float h = cameraPosition.y - (${GROUND.toFixed(3)});
    float x = depth * density / 1.378; // 1 where the plain haze hides 85% (1.378 = sqrt(1.9))
    float c = mix(1.9, 1.2, smoothstep(8.0, 150.0, h));
    float p = 2.0 + 1.5 * smoothstep(8.0, 120.0, h);
    float k = 1.0 / (1.0 + max(h - 8.0, 0.0) / 18.0);
    float t = x <= 1.0 ? exp(-c * pow(x, p)) : exp(-c - (x - 1.0) * c * p * k);
    return mix(plain, t, w);
  }
`;

THREE.ShaderChunk.fog_pars_fragment = THREE.ShaderChunk.fog_pars_fragment.replace(
  'uniform float fogDensity;',
  `uniform float fogDensity;\n${AIR_HAZE_GLSL}`,
);
THREE.ShaderChunk.fog_fragment = THREE.ShaderChunk.fog_fragment.replace(
  'float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );',
  'float fogFactor = 1.0 - airHaze( vFogDepth, fogDensity );',
);
if (!THREE.ShaderChunk.fog_fragment.includes('airHaze(')) console.warn('airHaze: three.js fog chunk changed, the plain haze stays');
