import * as THREE from 'three';
import { groundNoise } from './groundNoise';

/**
 * The yards, drives and gravel round the houses (tools/street.py takes them from the aerial photo: the
 * light paving and gravel round the buildings). One tint per patch over a fine texture made them flat,
 * pale shapes: from the air, with the texture's detail blurred away, they read as holes in the map.
 *
 * Here the pavers' and the gravel's materials get, in their shader, what years outside do to a yard: the
 * paving a little darker overall, lighter and darker in patches of several metres (worn tracks, damp,
 * newer and older stretches), dirt and rust-brown stains, and moss and weeds in green patches. The
 * palest surfaces (the yards and the gravel, by their tint) get it most; the streets' pavements, which
 * share the pavers' material, only the patches. Further off the pale surfaces come down a little more,
 * so they keep to the grass's brightness in the haze instead of glowing.
 *
 * Three reads of one small tile of soft noise (world/groundNoise.ts) and a few sums on those pixels only;
 * no geometry. Chained after what the materials already have (the ground's shading, world/groundShade.ts).
 */

/** Ground covers and low things: anything else over 1.5 m is a building. */
const LOW = new Set(['road', 'field_soil', 'field_dark', 'field_crop', 'forest', 'pave_light', 'pave_warm', 'pave_grey', 'pave_walk', 'gravel', 'track', 'nb_hedge', 'hedge', 'fence', 'pool_water', 'stone', 'pole', 'concrete', 'alu']);
const PALE = new Set(['pave_light', 'pave_warm', 'gravel']);
/** Metres: a pale patch with no building this close is worn ground, not a yard. */
const ALONE = 8;

/**
 * The aerial photo's light patches away from every building (about one in eight of them, a twentieth of
 * their area) are mostly bare earth, worn grass or dry spots in a meadow, not paving: they become worn
 * ground (the field tracks' earth, which the ground's shading also edges with rough grass) instead of pale
 * blots in the middle of a meadow. Changes the data in place, before its tiles are built.
 */
export function wearLonePatches(data: { prisms?: { m: string; p: [number, number][][]; y0: number; y1: number }[]; roofs?: { p: [number, number][] }[] }): void {
  // The buildings' walls, as segments in cells of G metres (each in every cell it comes within ALONE of).
  const G = 10;
  const walls = new Map<string, number[][]>();
  const add = (ring: [number, number][]) => {
    for (let k = 0; k < ring.length; k++) {
      const [ax, az] = ring[k];
      const [bx, bz] = ring[(k + 1) % ring.length];
      for (let i = Math.floor((Math.min(ax, bx) - ALONE) / G); i <= Math.floor((Math.max(ax, bx) + ALONE) / G); i++) {
        for (let j = Math.floor((Math.min(az, bz) - ALONE) / G); j <= Math.floor((Math.max(az, bz) + ALONE) / G); j++) {
          const key = `${i},${j}`;
          let list = walls.get(key);
          if (!list) walls.set(key, (list = []));
          list.push([ax, az, bx, bz]);
        }
      }
    }
  };
  for (const p of data.prisms ?? []) if (!LOW.has(p.m) && p.y1 - p.y0 > 1.5) add(p.p[0]);
  for (const r of data.roofs ?? []) add(r.p);
  const near = (x: number, z: number) => {
    for (const [ax, az, bx, bz] of walls.get(`${Math.floor(x / G)},${Math.floor(z / G)}`) ?? []) {
      const dx = bx - ax;
      const dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
      if (Math.hypot(ax + dx * t - x, az + dz * t - z) < ALONE) return true;
    }
    return false;
  };
  for (const p of data.prisms ?? []) if (PALE.has(p.m) && !p.p[0].some(([x, z]) => near(x, z))) p.m = 'track';
}

/** Weather the yards' and the gravel's materials (each once). */
export function weatherYards(materials: THREE.MeshStandardMaterial[]): void {
  const map = { value: groundNoise() };
  for (const material of materials) {
    if (material.userData.yards) continue;
    material.userData.yards = true;
    const before = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      before.call(material, shader, renderer);
      shader.uniforms.yardNoise = map;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vYardXZ;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvYardXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D yardNoise;\nvarying vec2 vYardXZ;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          {
            // Patches of a few metres, of a dozen and of forty: the noise tile laid on three times.
            float yA = texture2D(yardNoise, vYardXZ / 11.0).r;
            float yB = texture2D(yardNoise, vYardXZ / 3.1 + 0.37).r;
            float yC = texture2D(yardNoise, vYardXZ / 43.0 + 0.71).r;
            #ifdef USE_COLOR
            float yPale = smoothstep(0.3, 0.5, dot(vColor.rgb, vec3(0.3, 0.59, 0.11)));
            #else
            float yPale = 1.0;
            #endif
            vec3 y = diffuseColor.rgb;
            // Lighter and darker stretches everywhere.
            y *= mix(0.82, 1.05, yC) * mix(0.92, 1.03, yA);
            // On the yards and the gravel: darker overall, dirt and rust-brown stains, moss and weeds.
            float yStain = smoothstep(0.55, 0.85, yA * 0.65 + yB * 0.35) * yPale;
            float yMoss = smoothstep(0.62, 0.88, yB * 0.55 + yC * 0.45) * yPale;
            y *= mix(1.0, 0.78, yPale);
            y = mix(y, y * vec3(0.8, 0.72, 0.58), yStain * 0.8);
            y = mix(y, vec3(0.06, 0.075, 0.03) * (0.75 + 0.5 * yA), yMoss * 0.65);
            // Further off the pale surfaces come down to the grass's brightness, so they don't glow in the haze.
            y *= 1.0 - 0.22 * yPale * smoothstep(25.0, 250.0, length(vViewPosition));
            diffuseColor.rgb = y;
          }`,
        );
    };
    const key = material.customProgramCacheKey.bind(material);
    material.customProgramCacheKey = () => `${key()}|yards`;
    material.needsUpdate = true;
  }
}
