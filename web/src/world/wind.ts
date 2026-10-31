import * as THREE from 'three';

/**
 * A gentle wind through the tree crowns and the leafy lumps on the hedges, worked out in their
 * vertex shaders: the crown leans a few centimetres with the wind and back, more at the top than
 * at the bottom, and its leaves flutter a little. Gusts roll across the land, so neighbouring trees
 * move nearly together and a field away they don't. Purely for the look: each player's own clock.
 *
 * The wind blows from the south-west, the usual wind here. The shapes are drawn as instances, so
 * a tree's place (its instance matrix) gives it its own timing; nothing is worked out per tree on
 * the processor. Off on Low and on phones (`strength` 0: the shader skips it).
 *
 * It is the end of October: the tree crowns can also be turning, about two in three of them, some
 * to ochre (birch, poplar), some to orange-brown (beech, oak) and some to brown, each by its own
 * share; the rest stay green. Also in the shader, from the tree's place.
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
