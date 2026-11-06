import * as THREE from 'three';

/**
 * A gentle wind through the tree crowns and the leafy lumps on the hedges, worked out in their
 * vertex shaders: the crown leans a few centimetres with the wind and back, more at the top than
 * at the bottom, and its leaves flutter a little. Gusts roll across the land, so neighbouring trees
 * move nearly together and a field away they don't. Purely for the look: each player's own clock.
 *
 * The wind blows from the south-west, the usual wind here. The shapes are drawn as instances, so
 * a tree's place (its instance matrix) gives it its own timing; nothing is worked out per tree on
 * the processor. Off on phones (`strength` 0: the shader skips it).
 *
 * It is the end of October: the tree crowns can also be turning, about two in three of them, some
 * to ochre (birch, poplar), some to orange-brown (beech, oak) and some to brown, each by its own
 * share; the rest stay green, each a shade of its own. Also in the shader, from the tree's place.
 */

// From the south-west towards the north-east, in the model (grid north is (-0.666, 0.746)).
const DIR = new THREE.Vector2(-0.998, 0.057);

export const wind = {
  time: { value: 0 },
  strength: { value: 1 },
  /** How far the trees have turned: 1 at the end of October, 0 all green. */
  autumn: { value: 1 },
  /** How hard the wind blows at (x, z) now, 0.1 to 1: the gusts the trees show (for the sound of the wind). */
  gust(x: number, z: number): number {
    const t = wind.time.value;
    return 0.55 + 0.45 * Math.sin(t * 0.23 - (x * DIR.x + z * DIR.y) * 0.012) * (0.75 + 0.25 * Math.sin(t * 0.071 + 1.3));
  },
};

/**
 * Make an instanced material sway. `lean` is how far the top leans (in the shape's own units: a
 * crown is about 1 across, a hedge lump too), `flutter` how far its surface trembles.
 */
export function sway(material: THREE.MeshStandardMaterial, lean: number, flutter: number, turning = false): void {
  const before = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.uniforms.windTime = wind.time;
    shader.uniforms.windStrength = wind.strength;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float windTime;\nuniform float windStrength;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
        if (windStrength > 0.0) {
          vec2 wRoot = instanceMatrix[3].xz;
          vec2 wDir = vec2(${DIR.x.toFixed(3)}, ${DIR.y.toFixed(3)});
          // Gusts travel downwind across the land; each tree sways at its own pace on top.
          float wGust = 0.55 + 0.45 * sin(windTime * 0.23 - dot(wRoot, wDir) * 0.012) * (0.75 + 0.25 * sin(windTime * 0.071 + 1.3));
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
    shader.uniforms.windTime = wind.time;
    shader.uniforms.windStrength = wind.strength;
    const offset = (chunk: string, uv: string) => THREE.ShaderChunk[chunk as keyof typeof THREE.ShaderChunk].split(uv).join(`(${uv} + rustleUv)`);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float windTime;\nuniform float windStrength;\nvarying vec3 vRustleAt;\nvarying float vRustleGust;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vRustleAt = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vRustleGust = windStrength * (0.55 + 0.45 * sin(windTime * 0.23 - dot(vRustleAt.xz, vec2(${DIR.x.toFixed(3)}, ${DIR.y.toFixed(3)})) * 0.012));`,
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
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${key()}|rustle`;
  material.needsUpdate = true;
}
