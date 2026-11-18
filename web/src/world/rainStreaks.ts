import * as THREE from 'three';

/**
 * The faint streaks where rain runs off the windows' sills and down the walls of our own house models (the town
 * round the church square, tools/town/town.py `streaks`; the hand-made village houses, tools/village_houses_kit.py
 * `streaks`). Each model brings them as one mesh of thin faces just off its walls, whose colour per corner says how
 * much they darken the wall behind (1 at their edges: not at all). Drawn as a multiply over what is already there,
 * so they take the wall's own brick or paint, its light and its baked shade, and fade out at their edges with no seam.
 * Not dirt at the foot of the walls, nor green (Yoshi, 18 Nov 2026: "Do it all but not this: dirty band at the bottom
 * of the wall, a bit of moss").
 *
 * Every preset draws the scene into a half-float target and tone maps it at the end (main.ts, the composer), so the
 * multiply works on the light as it is. The tone curve then flattens it on a sunlit white wall, which lies well over
 * the screen's white: the tools make a streak darker on a light wall for that.
 *
 * Cost: one draw call per model, about 2,400 triangles for the whole town, and the pixels they cover read nothing:
 * no texture, no light, the vertex colour written out. No fog: the haze within their reach (230 m at most) would
 * change them by a per cent or two.
 */

const shared = new Map<number, THREE.MeshBasicMaterial>();

/** `scale`: what the model's vertex colours are multiplied by (the town stores them divided by its COLOR_SCALE). */
export function streakMaterial(scale = 1): THREE.MeshBasicMaterial {
  let m = shared.get(scale);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color: new THREE.Color(scale, scale, scale),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      toneMapped: false,
      fog: false,
      // They lie 12 mm off the wall; this keeps them in front of it at a glance along the street too.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    shared.set(scale, m);
  }
  return m;
}

/** Give a loaded mesh of streaks its material: drawn over the walls, never shadowed, never hit by a shot. */
export function useStreaks(mesh: THREE.Mesh, scale = 1): void {
  mesh.material = streakMaterial(scale);
  mesh.castShadow = mesh.receiveShadow = false;
  mesh.userData.ignoreRay = true;
}
