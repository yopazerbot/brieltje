import * as THREE from 'three';
import type { Prism } from './houseData';
import { groundNoise } from './groundNoise';
import { wind } from './wind';
import { FOREST_BOUNCE, FOREST_COMMON, FOREST_FLOOR, woodDetail } from './forestFloor';

/**
 * Rows in the fields, as they are at the end of October here, by the crop the farmers declared on
 * each this year (tools/crops.py, the Flemish agricultural parcels): maize harvested to stubble in
 * rows 75 cm apart, winter cereal coming up in fine green lines where the summer's wheat and barley
 * stood, fodder beet and chicory still in, broad leaves in rows 45 cm apart, leeks in blue-green rows
 * on their ridges, the nurseries' tagetes as a dense low cover with the last orange flowers, green
 * cover crops, and the tree and shrub nurseries round Lede in their rows, avenue trees 2 m apart and
 * hedge plants 60 cm, green, turning or brown. A field without a declaration gets ploughed land in
 * furrows, stubble or sown rows by its surface on the photo (tools/street.py) and its place.
 *
 * Drawn in the fields' shader (no extra geometry or textures): stripes across the field's long side,
 * with a slope in the shading so furrows and rows catch the light. Where the rows get narrower than
 * a couple of pixels they fade into their average colour, so far fields don't shimmer. What stays from further
 * off, from a roof or the air, is drawn at the scale of metres: the sprayer's tramlines in winter cereal and beet,
 * the combine's swaths on stubble, the plough's lands and dead furrows, patches of damper and drier soil, and each
 * field a shade of its own, so neighbouring fields of one crop don't merge into one patch. Along every
 * field's edge weeds and grass creep in, as the ground's shading says (world/groundShade.ts).
 *
 * It is the same for everyone and in every tile: it follows from the data and the field's place.
 */

const FIELDS = new Set(['field_soil', 'field_dark', 'field_crop', 'forest']);
/** The kinds of row, as the shader numbers them. */
const NONE = 0;
const PLOUGHED = 1;
const STUBBLE = 2;
const SOWN = 3;
const NURSERY = 4;
const BEET = 5;
const LEEK = 6;
const TAGETES = 7;
const COVER = 8;
/** The woods' floor: no rows, fallen leaves. */
const FOREST = 9;

/**
 * Each declared crop's kind of row, and where it has them its own number (a nursery's row spacing,
 * 0 for 55 cm to 1 for 2 m; a cover crop's roughness) and the colour of its leaves (0 evergreen dark,
 * 0.35 green, 0.6 turning yellow, 1 the brown that beech hedge plants keep all winter).
 */
const CROPS: Record<string, [number, number?, number?]> = {
  maize: [STUBBLE],
  cereal: [SOWN],
  beet: [BEET],
  leek: [LEEK],
  tagetes: [TAGETES],
  cover: [COVER, 0.2],
  fauna: [COVER, 0.85],
  avenue: [NURSERY, 0.85, 0.55],
  fruit: [NURSERY, 0.6, 0.62],
  shrubs: [NURSERY, 0.3, 0.08],
  roses: [NURSERY, 0.17, 0.3],
  hedgeplants: [NURSERY, 0.05, 0.85],
};

/**
 * Give a field's geometry its rows: their direction (along the field's longest side), the kind and a
 * leaf colour, and a number of its own (row spacing or colour within a kind), on every vertex. Every
 * block with the fields' material gets it (the woods' floor with no rows), so their meshes merge.
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
  // A number from the field's middle (rounded to 10 m, so tiny shifts in the data don't change it). Where the data
  // has them, the whole field's direction and number (tools/street.py), so its pieces in other tiles draw the same rows.
  let h = Math.abs(Math.sin(Math.round(cx / 10) * 12.9898 + Math.round(cz / 10) * 78.233) * 43758.5453) % 1;
  if (p.r) {
    const a = (p.r[0] * Math.PI) / 180;
    [dx, dz] = [Math.cos(a), Math.sin(a)];
    h = p.r[1] / 100;
  }
  let own = Math.abs(Math.sin(h * 91.7) * 1000) % 1;
  let hue = Math.abs(Math.sin(h * 37.3) * 1000) % 1;
  let kind = NONE;
  const crop = p.c ? CROPS[p.c] : undefined;
  if (p.m === 'forest') kind = FOREST;
  else if (crop) {
    kind = crop[0];
    own = crop[1] ?? own;
    // Leaves of the declared nursery's kind, a little different from field to field.
    if (crop[2] !== undefined) hue = Math.min(1, Math.max(0, crop[2] + (hue - 0.5) * 0.2));
  } else if (p.m === 'field_crop') {
    // Half green on the photo and no crop declared: a paddock, a big garden gone rough, a plot beside the houses. Rough
    // grass going to seed in clumps, now and then a winter cereal. Never a nursery: those are declared (above), and
    // their rows of leaves, drawn flat, lay bright stripes across gardens and up to the houses' walls.
    kind = h < 0.78 ? COVER : SOWN;
    if (kind === COVER) own = 0.9 + 0.1 * own; // the shader's rough grass (over 0.88)
  } else kind = h < 0.45 ? PLOUGHED : h < 0.75 ? STUBBLE : SOWN;
  const n = g.attributes.position.count;
  const a = new Int8Array(n * 4);
  const v = [Math.round(dx * 127), Math.round(dz * 127), kind * 8 + Math.round(hue * 7), Math.round(own * 127)];
  for (let i = 0; i < n * 4; i += 4) a.set(v, i);
  g.setAttribute('row', new THREE.BufferAttribute(a, 4, true));
}

/** Rows on (1) or off (0) at once, for the graphics settings. */
export const rowDetail = { value: 1 };

/** Draw the rows with the fields' material (chained after what it already has: the ground's shading). Once: again, nothing changes. */
export function patchFields(material: THREE.MeshStandardMaterial): void {
  if (material.userData.rows) return;
  material.userData.rows = true;
  const noise = { value: groundNoise() }; // the woods' floor (world/groundNoise.ts)
  const before = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.uniforms.rowDetail = rowDetail;
    shader.uniforms.fieldNoise = noise;
    shader.uniforms.woodDetail = woodDetail;
    shader.uniforms.windTime = wind.time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 row;\nvarying vec4 vRow;\nvarying vec2 vFieldXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRow = row;\nvFieldXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float rowDetail;\nuniform sampler2D fieldNoise;\nvarying vec4 vRow;\nvarying vec2 vFieldXZ;\n${FOREST_COMMON}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float fieldSlope = 0.0;
        vec3 fieldAcross = vec3(0.0);
        vec3 fieldTilt = vec3(0.0); // the fallen leaves' own tilt, near by (view space)
        float fieldUnder = 0.0; // how much of the sun the crowns hold back here (the woods' floor), for their light's bounce
        float fieldPlant = 0.0; // how much of it plants cover: matte, and the soil's clods don't show through
        float fieldCode = floor(vRow.z * 127.0 + 0.5);
        float fieldKind = floor(fieldCode / 8.0);
        float fieldHue = mod(fieldCode, 8.0) / 7.0;
        // The texture without the field's tint, to colour soil and plants from.
        vec3 texel = diffuseColor.rgb / max(vColor.rgb, vec3(0.05));
        float texelLum = dot(texel, vec3(0.3, 0.55, 0.15));
        if (fieldKind > 8.5) {
          ${FOREST_FLOOR}
        } else if (fieldKind > 0.5 && rowDetail > 0.0) {
          vec2 dir = normalize(vRow.xy + vec2(1e-4, 0.0));
          vec2 perp = vec2(-dir.y, dir.x);
          float across = dot(vFieldXZ, perp);
          float along = dot(vFieldXZ, dir);
          float own = vRow.w;
          // Soil fields keep their own soil; on crop fields (tinted green) it is a middling brown.
          vec3 soil = vColor.g > vColor.r ? texel * vec3(0.42, 0.32, 0.21) : diffuseColor.rgb;
          float spacing = fieldKind < 1.5 ? 0.34 : fieldKind < 2.5 ? 0.75 : fieldKind < 3.5 ? 0.14 : fieldKind < 4.5 ? mix(0.55, 2.0, own)
            : fieldKind < 5.5 ? 0.48 : fieldKind < 6.5 ? 0.75 : fieldKind < 7.5 ? 0.25 : 0.125;
          float s = across / spacing;
          float f = fract(s);
          // Rows narrower than about three pixels fade into their average (px: rows per pixel).
          float px = fwidth(s);
          float fade = clamp((0.38 - px) * 4.5, 0.0, 1.0);
          float tri = abs(f - 0.5) * 2.0; // 0 on a row's middle, 1 between rows
          float side = f < 0.5 ? -1.0 : 1.0;
          if (fieldKind < 1.5) {
            // Ploughed: ridges and furrows, a little uneven along their length.
            float ridge = 1.0 - tri;
            float lumps = 0.5 + 0.5 * sin(along * 3.1 + across * 0.7) * sin(along * 1.7 - own * 9.0);
            diffuseColor.rgb *= mix(1.0, mix(0.72, 1.12, ridge) * mix(0.92, 1.05, lumps), fade);
            fieldSlope = side * 0.45 * fade;
          } else if (fieldKind < 2.5) {
            // Maize stubble: a row of cut stalks every 75 cm, straw between.
            vec3 straw = texel * vec3(1.05, 0.92, 0.66);
            float stalks = along / 0.17;
            float stalk = smoothstep(0.12, 0.04, tri) * step(fract(stalks), 0.35) * clamp((0.3 - fwidth(stalks)) * 5.0, 0.0, 1.0);
            float litter = 0.35 + 0.25 * sin(along * 5.3 + across * 2.1);
            vec3 c = mix(soil, straw, litter);
            c = mix(c, straw * 0.8, stalk);
            diffuseColor.rgb = mix(mix(soil, straw, 0.45), c, fade);
            fieldSlope = side * 0.25 * smoothstep(0.5, 0.1, tri) * fade;
          } else if (fieldKind < 3.5) {
            // Winter wheat just up: fine green lines over the soil.
            vec3 shoot = vec3(0.07, 0.12, 0.03);
            float line = smoothstep(0.4, 0.15, tri);
            diffuseColor.rgb = mix(mix(soil, shoot, 0.2), mix(soil, shoot, line * 0.6), fade);
            fieldPlant = 0.2;
          } else if (fieldKind < 4.5) {
            // A nursery: rows of young trees or shrubs, bare soil between. Their leaves by the kind (fieldHue),
            // every row a little different by its number.
            float row = floor(s);
            float leafHue = clamp(fieldHue + (fract(sin(row * 12.9898 + own * 7.0) * 43758.5453) - 0.5) * 0.18, 0.0, 1.0);
            vec3 leaf = leafHue < 0.35 ? mix(vec3(0.05, 0.1, 0.045), vec3(0.13, 0.19, 0.07), leafHue / 0.35)
              : leafHue < 0.6 ? mix(vec3(0.13, 0.19, 0.07), vec3(0.3, 0.26, 0.06), (leafHue - 0.35) / 0.25)
              : mix(vec3(0.3, 0.26, 0.06), vec3(0.3, 0.13, 0.045), (leafHue - 0.6) / 0.4);
            float band = smoothstep(0.62, 0.42, tri);
            float gaps = 0.75 + 0.25 * sin(along * 2.6 / spacing + own * 20.0);
            diffuseColor.rgb = mix(mix(soil, leaf, 0.5), mix(soil, leaf * gaps, band), fade);
            fieldSlope = side * 0.9 * smoothstep(0.62, 0.3, tri) * smoothstep(0.0, 0.3, tri) * fade;
            fieldPlant = mix(0.5, band, fade);
          } else if (fieldKind < 5.5) {
            // Beet (and chicory): broad leaves in rows 48 cm apart, nearly closing over the soil.
            vec3 leaf = mix(vec3(0.045, 0.1, 0.03), vec3(0.1, 0.17, 0.05), fieldHue);
            float clumps = 0.65 + 0.35 * sin(along * 12.0 + own * 9.0) * sin(along * 4.7 + across);
            float band = smoothstep(0.92, 0.55, tri) * (0.8 + 0.2 * clumps);
            vec3 c = mix(soil, leaf * mix(0.75, 1.25, clumps * (1.0 - tri)), band);
            diffuseColor.rgb = mix(mix(soil, leaf, 0.72), c, fade);
            fieldSlope = side * 0.55 * band * smoothstep(0.0, 0.35, tri) * fade;
            fieldPlant = mix(0.72, band, fade);
          } else if (fieldKind < 6.5) {
            // Leeks: earthed-up ridges 75 cm apart, a narrow blue-green row of leaves along their tops.
            vec3 leek = vec3(0.07, 0.1, 0.075) * (0.8 + 0.2 * texelLum / 0.13);
            float band = smoothstep(0.5, 0.22, tri) * (0.8 + 0.2 * sin(along * 31.0 + own * 5.0));
            vec3 c = mix(soil * mix(0.8, 1.05, 1.0 - tri), leek, band);
            diffuseColor.rgb = mix(mix(soil, leek, 0.4), c, fade);
            fieldSlope = side * 0.25 * fade;
            fieldPlant = mix(0.55, max(band, 0.4), fade);
          } else if (fieldKind < 7.5) {
            // Tagetes: a dense low cover, dark green, in drill rows 25 cm apart, with the last orange and yellow
            // flowers, a few in every 9 cm square, and some plants already brown. Far off only their share remains.
            vec3 leaf = vec3(0.05, 0.09, 0.03) * (0.7 + 0.3 * texelLum / 0.13);
            vec2 cell = vec2(along, across) / 0.09;
            float near = clamp((0.4 - max(fwidth(cell.x), fwidth(cell.y))) * 4.0, 0.0, 1.0);
            vec3 p3 = fract(floor(cell).xyx * 0.1031);
            p3 += dot(p3, p3.yzx + 33.33);
            float pick = fract((p3.x + p3.y) * p3.z);
            float dot9 = step(0.7, pick) * smoothstep(0.34, 0.26, length(fract(cell) - 0.5));
            float bloom = mix(0.1, dot9, near);
            float dead = mix(0.12, smoothstep(0.08, 0.065, texelLum), near);
            vec3 c = mix(leaf * mix(0.85, 1.1, 1.0 - tri), vec3(0.17, 0.1, 0.045), dead * 0.6);
            vec3 flower = mix(vec3(0.5, 0.15, 0.02), vec3(0.55, 0.32, 0.03), step(0.88, pick));
            diffuseColor.rgb = mix(c, flower, bloom * 0.85);
            fieldPlant = 1.0;
          } else {
            // A cover crop sown in rows 12.5 cm apart (oats, mustard): dense and green. A game cover (own high)
            // is rougher: taller patches going to seed, brown among the green, in clumps of a few metres. Two reads
            // of the noise tile, turned against each other, not a product of waves: that laid the clumps on a
            // lattice, a field of diamonds from the air.
            vec3 leaf = vec3(0.08, 0.14, 0.04) * (0.7 + 0.3 * texelLum / 0.13);
            float seedAt = texture2D(fieldNoise, vec2(along, across) / 9.3 + own * 5.0).r * 0.6
              + texture2D(fieldNoise, mat2(0.809, 0.588, -0.588, 0.809) * vFieldXZ / 23.0 + 0.4).r * 0.4;
            float seed = own * smoothstep(0.45, 0.65, 0.5 + (seedAt - 0.5) * 1.6 + (texelLum - 0.13) * 2.0);
            vec3 c = mix(leaf * mix(0.9, 1.06, smoothstep(0.5, 0.0, tri) * fade), vec3(0.2, 0.14, 0.07), seed);
            if (own > 0.88) {
              // Rough grass on a plot no farmer declared (own over 0.88): never sown, so no drill rows; olive tussocks
              // and dead straw between them, mottled at a stride's scale rather than in flat blotches.
              float tussock = texture2D(fieldNoise, vFieldXZ / 1.7 + 0.13).r;
              vec3 grass = vec3(0.07, 0.105, 0.035) * (0.75 + 0.5 * tussock) * (0.8 + 0.2 * texelLum / 0.13);
              vec3 straw = vec3(0.16, 0.14, 0.075) * (0.8 + 0.4 * texelLum / 0.13);
              c = mix(grass, straw, 0.6 * smoothstep(0.35, 0.75, 0.5 + (seedAt - 0.5) * 1.2 + (tussock - 0.5) * 0.6));
            }
            diffuseColor.rgb = mix(c, soil, 0.08 * (1.0 - own));
            fieldPlant = 1.0;
          }
          // Seen from further off, from a roof or from the air, where the rows themselves have faded: what the tractor
          // and the combine leave behind, metres apart, and patches of a few dozen metres (damper and drier soil, thicker
          // and thinner growth). Lines narrower than a pixel keep only their share of it, so nothing shimmers.
          float fieldLane = fract(sin(own * 311.7 + fieldHue * 17.0) * 4375.85); // one more number of the field's own
          float fieldPx = max(fwidth(across), 1e-3); // metres a pixel, across the rows
          // Two reads at scales that never meet (61 and 157 m), each turned its own way: one alone repeated every 70 m
          // along the map's axes, a grid of soft blotches across a big field from the air.
          float fieldPatch = texture2D(fieldNoise, vec2(along, across) / 61.0 + own * 3.1).r * 0.6
            + texture2D(fieldNoise, mat2(0.914, -0.407, 0.407, 0.914) * vFieldXZ / 157.0 + 0.23).r * 0.4;
          diffuseColor.rgb *= mix(0.9, 1.07, 0.5 + (fieldPatch - 0.5) * 1.4);
          if (fieldKind > 2.5 && fieldKind < 3.5 || fieldKind > 4.5 && fieldKind < 5.5) {
            // Winter cereal and beet: tramlines, the pair of wheel tracks the sprayer follows, 1.8 m apart, every 18 to
            // 27 m by the width of the farmer's boom; bare soil in them.
            float tramStep = 18.0 + floor(fieldLane * 4.0) * 3.0;
            float tramAt = abs(abs((fract(across / tramStep + own) - 0.5) * tramStep) - 0.9);
            float track = min(clamp((0.25 + 0.5 * fieldPx - tramAt) / fieldPx, 0.0, 1.0), 0.5 / fieldPx);
            diffuseColor.rgb = mix(diffuseColor.rgb, soil * 0.92, track * 0.85);
            fieldPlant *= 1.0 - track * 0.8;
          } else if (fieldKind > 1.5 && fieldKind < 2.5) {
            // Stubble: the combine's swaths, a header's width apart (6 to 9 m), lighter and darker by turns.
            float swath = 6.0 + fieldLane * 3.0;
            float swathFade = clamp(1.0 - fieldPx * 3.0 / swath, 0.0, 1.0);
            diffuseColor.rgb *= 1.0 + 0.07 * swathFade * sin((across / swath + own) * 6.2832);
          } else if (fieldKind < 1.5) {
            // Ploughed: the plough's lands, 20 to 30 m, each thrown its own way (lighter and darker by turns), a dead
            // furrow between them.
            float land = 20.0 + fieldLane * 10.0;
            float landAt = across / land + own;
            float furrow = abs(fract(landAt) - 0.5) * land;
            float dead = min(clamp((0.35 + 0.5 * fieldPx - (land * 0.5 - furrow)) / fieldPx, 0.0, 1.0), 0.7 / fieldPx);
            diffuseColor.rgb *= (mod(floor(landAt), 2.0) < 0.5 ? 0.95 : 1.04) * (1.0 - dead * 0.35);
          }
          fieldAcross = normalize((viewMatrix * vec4(perp.x, 0.0, perp.y, 0.0)).xyz);
        }
        if (fieldKind > 0.5 && fieldKind < 8.5) {
          // Each field a little lighter or darker, warmer or greener than its neighbours of the same crop, as fields are
          // from the air (also with the rows off, on a phone).
          float fieldTone = fract(sin(vRow.w * 127.0 * 41.3 + fieldCode * 7.1) * 2531.7);
          diffuseColor.rgb *= mix(vec3(0.9, 0.92, 0.94), vec3(1.09, 1.06, 1.0), fieldTone);
        }
        // Weeds and grass along the edge, ragged (the ground's shading: world/groundShade.ts).
        float weeds = clamp(1.0 - gs.a * 2.0, 0.0, 1.0);
        vec3 weed = mix(vec3(0.1, 0.13, 0.035), vec3(0.2, 0.19, 0.07), smoothstep(0.07, 0.19, texelLum));
        diffuseColor.rgb = mix(diffuseColor.rgb, weed, weeds);
        fieldSlope *= 1.0 - weeds;
        fieldPlant = mix(fieldPlant, 1.0, weeds);`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 1.0, fieldPlant);')
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        normal = normalize(mix(normal, nonPerturbedNormal, fieldPlant * 0.7));
        if (fieldSlope != 0.0) normal = normalize(normal + fieldAcross * fieldSlope);
        normal = normalize(normal + fieldTilt);`,
      )
      // Leaves don't mirror the sky as bare soil does (before the ground's shading, which comes after this).
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        reflectedLight.directSpecular *= 1.0 - 0.75 * fieldPlant;
        reflectedLight.indirectSpecular *= 1.0 - 0.75 * fieldPlant;
        ${FOREST_BOUNCE}`,
      );
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${key()}|rows`;
  material.needsUpdate = true;
}
