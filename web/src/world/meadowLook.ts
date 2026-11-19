import * as THREE from 'three';
import { groundNoise } from './groundNoise';

/**
 * The open grass at the scale of a field: from 30 to 300 m off the meadows and verges were one even green to the
 * horizon, since the grass's own variation (world/groundShade.ts: the slow variation, the rough grass) is a few
 * metres across and averages out with distance. Real pasture in November is patchy at the scale of tens of metres:
 * drier, straw-coloured stretches where the ground is higher or the grass was grazed short, a deeper green in the
 * damper hollows. Two reads of the small noise tile (world/groundNoise.ts), turned against the map and each other so
 * no repeat lines up with the streets: patches of about 30 to 110 m and of 8 to 35 m, mixed. Only on the open grass:
 * the gardens mown in stripes (the ground shading's fourth channel over 0.55) keep their look. The meadows' own
 * difference from field to field and their mown swaths are in the shading's bake (world/groundShade.ts addGrass).
 *
 * Chained after what the grass already has (the ground's shading, the far land), in its colour, so the light, the
 * wet and the snow act on it as before. Two texture reads and a few sums per pixel of grass; no geometry.
 */

/** Strength (0 off, 1 on): for comparing in the dev build (`?nomeadow`). */
export const meadowLook = { value: import.meta.env.DEV && new URLSearchParams(location.search).has('nomeadow') ? 0 : 1 };

export function patchMeadowLook(material: THREE.MeshStandardMaterial): void {
  const noise = { value: groundNoise() };
  const before = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.uniforms.meadowNoise = noise;
    shader.uniforms.meadowLook = meadowLook;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vMeadowXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMeadowXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D meadowNoise;\nuniform float meadowLook;\nvarying vec2 vMeadowXZ;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        if (meadowLook > 0.0) {
          // The tile is 430 m (its cells 107, 54 and 27 m) and 137 m (34, 17 and 9 m), each turned its own way.
          float mlBig = texture2D(meadowNoise, mat2(0.951, 0.309, -0.309, 0.951) * vMeadowXZ / 430.0).r;
          float mlMid = texture2D(meadowNoise, mat2(0.682, -0.731, 0.731, 0.682) * vMeadowXZ / 137.0 + vec2(0.37, 0.61)).r;
          // Two reads mixed gather round the middle (about 0.4 to 0.6): spread out again to about -1 to 1.
          float mlAt = (mlBig * 0.62 + mlMid * 0.38 - 0.5) * 3.6;
          float mlDry = smoothstep(0.05, 0.85, mlAt); // straw-coloured stretches
          float mlDamp = smoothstep(0.1, 0.9, -mlAt); // a deeper green in the hollows
          float mlOpen = (1.0 - smoothstep(0.52, 0.58, gs.a)) * meadowLook; // not the striped gardens
          vec3 mlTint = mix(vec3(1.0), vec3(1.36, 1.17, 0.58), mlDry) * mix(vec3(1.0), vec3(0.7, 0.84, 0.76), mlDamp);
          // A little more of it on the rough grass, which dries out first (the shading's fourth channel under 0.5).
          diffuseColor.rgb *= mix(vec3(1.0), mlTint, mlOpen * (0.85 + 0.3 * clamp(1.0 - gs.a * 2.0, 0.0, 1.0)));
        }`,
      );
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${key()}|meadow`;
  material.needsUpdate = true;
}
