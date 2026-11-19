import * as THREE from 'three';

/**
 * The street lamps' warm light on what stands near them at night: house fronts, cars, hedges, people, your own
 * hands and gun (world/streetLights.ts lights the ground under them with its pools).
 *
 * No real lights: every lamp one would cost every lit pixel of the world. Instead every lit material of three.js
 * (patched once into its light chunk, before anything compiles, as world/airHaze.ts does with the haze) adds the
 * light of the few lamps nearest the eye (SLOTS), as the light that falls on it from a small lamp: the fall with the
 * distance squared, the angle it meets the surface at, none from below the lamp's head, nothing past REACH. The ground
 * and other surfaces facing up are left out: the pools light those, for every lamp, however far (both together lit it
 * twice). A lamp coming into the nearest few or going out of them fades (its weight is how much nearer it is than the
 * first lamp left out), so nothing switches on or off as you walk.
 *
 * The lamps' places and strengths are one array of vectors shared by every material (three.js copies a material's
 * uniforms from its shader's list, an array as a new list of the same vectors): changed in place each frame, they
 * reach every material when it is next drawn. By day, indoors, on Low and on phones the first slot's weight is 0 and
 * the shader skips it all in one test, the same for every pixel of a draw. Medium fills four slots, High and Ultra six.
 * Measured at night on this PC's integrated chip, on and off alternated, at the church square (19 Nov 2026, the chip
 * shared with other work): on Medium within the runs' own spread (about 40 ms a frame either way), on High about 2 ms
 * of 55 more; on the separate chip at High, 0.2 ms of 5, within the spread.
 */

/** How many lamps light things at once, at most: the nearest to the eye. */
export const SLOTS = 6;
/** Metres: past this a lamp's light on things is nothing (it fades out well before). */
const REACH = 32;
/** Metres: a lamp fades out over this much as a nearer one takes its slot. */
const FADE = 10;

/** Each slot: the lamp's head (x, y, z, in the world) and its strength (0: none). Shared by every lit material. */
const spots = Array.from({ length: SLOTS }, () => new THREE.Vector4());

const PARS = /* glsl */ `
uniform vec4 lampSpots[ ${SLOTS} ];
`;

/**
 * Added to the sky's light (`irradiance`) where three.js has worked it out: light from the lamps, in their colour.
 * `lampSpots[i].w` is the lamp's strength: the light on the ground straight under its head, times its height squared.
 */
const LIGHT = (lamp: THREE.Color) => /* glsl */ `
#if defined( RE_IndirectDiffuse )
  if ( lampSpots[ 0 ].w > 0.0 ) {
    // In the world: the view's turn undone (a vector times the matrix is the transposed matrix times it).
    vec3 lampNormal = geometryNormal * mat3( viewMatrix );
    float lampSide = 1.0 - smoothstep( 0.82, 0.97, lampNormal.y ); // facing up: the pools' part
    if ( lampSide > 0.0 ) {
      vec3 lampAt = cameraPosition + geometryPosition * mat3( viewMatrix );
      float lampSum = 0.0;
      for ( int i = 0; i < ${SLOTS}; i ++ ) {
        vec4 lamp = lampSpots[ i ];
        if ( lamp.w <= 0.0 ) break; // the slots are filled from the first
        vec3 toLamp = lamp.xyz - lampAt;
        float d2 = dot( toLamp, toLamp );
        if ( d2 > ${(REACH * REACH).toFixed(1)} ) continue;
        vec3 dir = toLamp * inversesqrt( d2 );
        float r = d2 * ${(1 / (REACH * REACH)).toExponential(4)};
        float fade = 1.0 - r * r;
        lampSum += lamp.w * max( dot( lampNormal, dir ), 0.0 ) * clamp( dir.y * 2.0 + 0.3, 0.0, 1.0 ) * fade * fade / ( d2 + 1.0 );
      }
      irradiance += vec3( ${lamp.r.toFixed(3)}, ${lamp.g.toFixed(3)}, ${lamp.b.toFixed(3)} ) * ( lampSum * lampSide );
    }
  }
#endif
`;

let patched = false;

/** Put the lamps' light into every lit material of three.js; `lamp` their colour (linear). Once, before anything compiles. */
export function patchLampLight(lamp: THREE.Color): void {
  if (patched) return;
  patched = true;
  const end = THREE.ShaderChunk.lights_fragment_begin;
  if (!THREE.ShaderChunk.lights_pars_begin.includes('uniform vec3 ambientLightColor;') || !end.includes('vec3 irradiance =')) {
    console.warn('lampLight: three.js light chunks changed; the lamps light only the ground');
    return;
  }
  THREE.ShaderChunk.lights_pars_begin = THREE.ShaderChunk.lights_pars_begin.replace('uniform vec3 ambientLightColor;', `uniform vec3 ambientLightColor;\n${PARS}`);
  THREE.ShaderChunk.lights_fragment_begin = `${end}\n${LIGHT(lamp)}`;
  for (const id of ['standard', 'physical', 'lambert', 'phong', 'toon'] as const) {
    const lib = THREE.ShaderLib[id];
    if (lib) lib.uniforms.lampSpots = { value: spots };
  }
}

/** A lamp's head and its strength (the light on the ground under it, times the head's height over it squared). */
export interface LampSpot {
  x: number;
  y: number;
  z: number;
  strength: number;
}

const near: { lamp: LampSpot; d: number }[] = [];

/**
 * Each frame: the `count` lamps nearest the eye (at most SLOTS) into the slots, faded in and out as they come and go,
 * all times `on` (0 by day, indoors, on Low and on phones: then the first slot is 0 and no pixel pays more than one test).
 */
export function setLampSpots(lamps: readonly LampSpot[], eye: THREE.Vector3, on: number, count = SLOTS): void {
  const k = Math.max(1, Math.min(SLOTS, count));
  near.length = 0;
  if (on > 0.001) {
    // The k + 1 nearest, kept in order (a few hundred lamps: a plain pass is quicker than any index).
    for (const lamp of lamps) {
      const d = Math.hypot(lamp.x - eye.x, lamp.y - eye.y, lamp.z - eye.z);
      if (d > REACH + FADE) continue;
      if (near.length === k + 1 && d >= near[k].d) continue;
      let i = Math.min(near.length, k);
      if (near.length < k + 1) near.push({ lamp, d });
      while (i > 0 && near[i - 1].d > d) {
        near[i] = near[i - 1];
        i--;
      }
      near[i] = { lamp, d };
    }
  }
  const limit = near.length > k ? near[k].d : REACH + FADE;
  let n = 0;
  for (let i = 0; i < Math.min(near.length, k); i++) {
    const { lamp, d } = near[i];
    const w = Math.min(1, (limit - d) / FADE) * on * lamp.strength;
    if (w > 0) spots[n++].set(lamp.x, lamp.y, lamp.z, w);
  }
  for (; n < SLOTS; n++) spots[n].set(0, 0, 0, 0);
}
