import * as THREE from 'three';
import type { Prism } from './houseData';

/**
 * Rows in the fields, as they are at the end of October here: ploughed land in furrows, maize
 * stubble in rows 75 cm apart, winter wheat coming up in fine green lines, and the tree nurseries
 * round Lede in their rows of young trees, some still green and some turning. Drawn in the fields'
 * shader (no extra geometry or textures): stripes across the field's long side, with a slope in
 * the shading so furrows and rows catch the light. Where the rows get narrower than a couple of
 * pixels they fade into their average colour, so far fields don't shimmer.
 *
 * Which rows a field has follows from its surface in the data (tools/street.py: bare soil, or crops
 * and nursery rows) and from its place, so it is the same for everyone and in every tile.
 */

const FIELDS = new Set(['field_soil', 'field_dark', 'field_crop', 'forest']);
/** The kinds of row, as the shader numbers them. */
const NONE = 0;
const PLOUGHED = 1;
const STUBBLE = 2;
const SOWN = 3;
const NURSERY = 4;

/**
 * Give a field's geometry its rows: their direction (along the field's longest side), the kind,
 * and a number of its own (row spacing and colour within a kind), on every vertex. Every block
 * with the fields' material gets it (the woods' floor with no rows), so their meshes merge.
 */
export function fieldRows(g: THREE.BufferGeometry, p: Prism): void {
  if (!FIELDS.has(p.m)) return;
  const ring = p.p[0];
  let best = 0;
  let dx = 1;
  let dz = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, z0] = ring[i];
    const [x1, z1] = ring[(i + 1) % ring.length];
    const len = Math.hypot(x1 - x0, z1 - z0);
    cx += x0 / ring.length;
    cz += z0 / ring.length;
    if (len > best) [best, dx, dz] = [len, (x1 - x0) / len, (z1 - z0) / len];
  }
  // A number from the field's middle (rounded to 10 m, so tiny shifts in the data don't change it).
  const h = Math.abs(Math.sin(Math.round(cx / 10) * 12.9898 + Math.round(cz / 10) * 78.233) * 43758.5453) % 1;
  const own = Math.abs(Math.sin(h * 91.7) * 1000) % 1;
  let kind = NONE;
  if (p.m === 'field_crop') kind = h < 0.78 ? NURSERY : SOWN;
  else if (p.m !== 'forest') kind = h < 0.45 ? PLOUGHED : h < 0.75 ? STUBBLE : SOWN;
  const n = g.attributes.position.count;
  const a = new Int8Array(n * 4);
  const v = [Math.round(dx * 127), Math.round(dz * 127), Math.round((kind / 8) * 127), Math.round(own * 127)];
  for (let i = 0; i < n * 4; i += 4) a.set(v, i);
  g.setAttribute('row', new THREE.BufferAttribute(a, 4, true));
}

/** Rows on (1) or off (0) at once, for the graphics settings. */
export const rowDetail = { value: 1 };

/** Draw the rows with the fields' material (chained after what it already has: the ground's shading). */
export function patchFields(material: THREE.MeshStandardMaterial): void {
  const before = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.uniforms.rowDetail = rowDetail;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 row;\nvarying vec4 vRow;\nvarying vec2 vFieldXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRow = row;\nvFieldXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float rowDetail;\nvarying vec4 vRow;\nvarying vec2 vFieldXZ;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float fieldSlope = 0.0;
        vec3 fieldAcross = vec3(0.0);
        float fieldKind = floor(vRow.z * 8.0 + 0.5);
        if (fieldKind > 0.5 && rowDetail > 0.0) {
          vec2 dir = normalize(vRow.xy + vec2(1e-4, 0.0));
          vec2 perp = vec2(-dir.y, dir.x);
          float across = dot(vFieldXZ, perp);
          float along = dot(vFieldXZ, dir);
          float own = vRow.w;
          // The texture without the field's tint, to colour soil and plants from.
          vec3 texel = diffuseColor.rgb / max(vColor.rgb, vec3(0.05));
          // Soil fields keep their own soil; on crop fields (tinted green) it is a middling brown.
          vec3 soil = vColor.g > vColor.r ? texel * vec3(0.42, 0.32, 0.21) : diffuseColor.rgb;
          float spacing = fieldKind < 1.5 ? 0.34 : fieldKind < 2.5 ? 0.75 : fieldKind < 3.5 ? 0.14 : 1.0 + own * 0.7;
          float s = across / spacing;
          float f = fract(s);
          // Rows narrower than about three pixels fade into their average (px: rows per pixel).
          float px = fwidth(s);
          float fade = clamp((0.38 - px) * 4.5, 0.0, 1.0);
          float tri = abs(f - 0.5) * 2.0; // 0 on a row's middle, 1 between rows
          if (fieldKind < 1.5) {
            // Ploughed: ridges and furrows, a little uneven along their length.
            float ridge = 1.0 - tri;
            float lumps = 0.5 + 0.5 * sin(along * 3.1 + across * 0.7) * sin(along * 1.7 - own * 9.0);
            diffuseColor.rgb *= mix(1.0, mix(0.72, 1.12, ridge) * mix(0.92, 1.05, lumps), fade);
            fieldSlope = (f < 0.5 ? -1.0 : 1.0) * 0.45 * fade;
          } else if (fieldKind < 2.5) {
            // Maize stubble: a row of cut stalks every 75 cm, straw between.
            vec3 straw = texel * vec3(1.05, 0.92, 0.66);
            float stalks = along / 0.17;
            float stalk = smoothstep(0.12, 0.04, tri) * step(fract(stalks), 0.35) * clamp((0.3 - fwidth(stalks)) * 5.0, 0.0, 1.0);
            float litter = 0.35 + 0.25 * sin(along * 5.3 + across * 2.1);
            vec3 c = mix(soil, straw, litter);
            c = mix(c, straw * 0.8, stalk);
            diffuseColor.rgb = mix(mix(soil, straw, 0.45), c, fade);
            fieldSlope = (f < 0.5 ? -1.0 : 1.0) * 0.25 * smoothstep(0.5, 0.1, tri) * fade;
          } else if (fieldKind < 3.5) {
            // Winter wheat just up: fine green lines over the soil.
            vec3 shoot = vec3(0.07, 0.12, 0.03);
            float line = smoothstep(0.4, 0.15, tri);
            diffuseColor.rgb = mix(mix(soil, shoot, 0.2), mix(soil, shoot, line * 0.6), fade);
          } else {
            // A tree nursery: rows of young trees, green or turning, bare soil between.
            // Some nurseries are turning: every row a little different, by its number.
            float row = floor(s);
            vec3 leaf = mix(vec3(0.13, 0.19, 0.07), vec3(0.34, 0.19, 0.06), step(0.62, own) * (0.45 + 0.35 * fract(sin(row * 12.9898) * 43758.5453)));
            float band = smoothstep(0.62, 0.42, tri);
            float gaps = 0.75 + 0.25 * sin(along * 2.6 + own * 20.0);
            diffuseColor.rgb = mix(mix(soil, leaf, 0.5), mix(soil, leaf * gaps, band), fade);
            fieldSlope = (f < 0.5 ? -1.0 : 1.0) * 0.9 * smoothstep(0.62, 0.3, tri) * smoothstep(0.0, 0.3, tri) * fade;
          }
          fieldAcross = normalize((viewMatrix * vec4(perp.x, 0.0, perp.y, 0.0)).xyz);
        }`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        if (fieldSlope != 0.0) normal = normalize(normal + fieldAcross * fieldSlope);`,
      );
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${key()}|rows`;
  material.needsUpdate = true;
}
