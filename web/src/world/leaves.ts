import * as THREE from 'three';

/**
 * Leaves for the tree crowns and the leafy lumps on the hedges, so they read as foliage instead of
 * smooth green balls. One small tile of clumps of leaves, worked out once when the game starts
 * (nothing to download, a third of a megabyte on the graphics chip): grey for how light each leaf
 * is, the gaps between the clumps dark as deep in a crown, and in its alpha how far into a clump a
 * point is.
 *
 * The material multiplies its colour by the grey, and where a crown turns away from the eye (its
 * outline) only the clumps' middles are drawn: the outline comes out ragged, clump by clump, whatever
 * the shape's few triangles. It is all opaque (cut, not blended), so nothing is drawn twice, and the
 * tile is laid on in metres, so a leaf is as big on a small tree as on a big one.
 *
 * A cut has a price: the graphics chip can no longer skip a crown's hidden pixels before working them
 * out. The leaves pay for it by taking the light as plain diffuse surfaces (leaves this rough hardly
 * gloss), which drops the gloss's sums and look-ups: in the thick of the woods the trees cost less
 * than the smooth balls did (DECISIONS.md, 2026-11-01).
 */

const SIZE = 256;
let tile: THREE.DataTexture | null = null;
/** The tile's average grey, to keep a crown about as light as without its leaves. */
let mean = 1;

/**
 * The leaf tile, made on first use: 256 px, seamless, about seven clumps of leaves across (a twig's
 * spray, what you make out of a crown from a few tens of metres), each of small leaves, lighter in its
 * middle and darker towards its edge, with deep shade between the clumps. The alpha follows the
 * clumps (with the leaves round their edges), so a cut outline is scalloped clump by clump even far
 * off, where the leaves themselves are a blur.
 */
export function leafTexture(): THREE.DataTexture {
  if (tile) return tile;
  let s = 9173;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const grey = new Float32Array(SIZE * SIZE).fill(0.24);
  const depth = new Float32Array(SIZE * SIZE);
  const at = (x: number, y: number) => ((Math.round(y) % SIZE + SIZE) % SIZE) * SIZE + ((Math.round(x) % SIZE + SIZE) % SIZE);
  for (let c = 0; c < 80; c++) {
    const cx = rand() * SIZE;
    const cy = rand() * SIZE;
    const R = 13 + rand() * 9;
    // Each clump turned its own way to the light: some catch it, some don't.
    const lit = 0.62 + 0.38 * rand();
    // The clump's shaded body first (a later clump lies over an earlier one), then its leaves on it.
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const d = Math.hypot(dx, dy) / R;
        if (d >= 1) continue;
        const k = at(cx + dx, cy + dy);
        grey[k] = lit * (0.42 + 0.2 * (1 - d));
        depth[k] = Math.max(depth[k], Math.pow(1 - d, 0.6));
      }
    }
    for (let i = 0; i < 34; i++) {
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand()) * R * 0.95;
      const lx = cx + Math.cos(a) * d;
      const ly = cy + Math.sin(a) * d;
      const half = 3.5 + rand() * 2.5; // half its length, px
      const wide = half * (0.42 + rand() * 0.14);
      // Pointing outwards more or less, as leaves on a spray do.
      const turn = a + (rand() - 0.5) * 1.6;
      const ca = Math.cos(turn);
      const sa = Math.sin(turn);
      const shade = lit * (0.62 + 0.3 * (1 - d / R) + 0.18 * rand());
      const r = Math.ceil(half);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          // Along the leaf (-1 at the stalk, 1 at the tip) and across it; it narrows to a point at both ends.
          const u = (dx * ca + dy * sa) / half;
          const v = (dy * ca - dx * sa) / wide;
          const edge = Math.pow(Math.max(0, 1 - u * u), 0.7);
          if (Math.abs(v) >= edge) continue;
          const inside = 1 - Math.abs(v) / edge;
          const k = at(lx + dx, ly + dy);
          // The leaf on top shows, a little darker towards its edge, so overlapping leaves keep their outlines.
          grey[k] = shade * (0.8 + 0.2 * Math.min(1, inside * 2.5));
          depth[k] = Math.max(depth[k], 0.25 * inside);
        }
      }
    }
  }
  const data = new Uint8Array(SIZE * SIZE * 4);
  let sum = 0;
  for (let k = 0; k < SIZE * SIZE; k++) {
    const g = Math.round(Math.min(1, grey[k]) * 255);
    sum += g / 255;
    data[k * 4] = data[k * 4 + 1] = data[k * 4 + 2] = g;
    data[k * 4 + 3] = Math.round(depth[k] * 255);
  }
  mean = sum / (SIZE * SIZE);
  tile = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  tile.wrapS = tile.wrapT = THREE.RepeatWrapping;
  tile.magFilter = THREE.LinearFilter;
  tile.minFilter = THREE.LinearMipmapLinearFilter;
  tile.generateMipmaps = true;
  tile.colorSpace = THREE.NoColorSpace;
  tile.needsUpdate = true;
  return tile;
}

/**
 * Give an instanced material the leaves: its colour times the leaf tile's grey, and a ragged outline.
 * The tile is laid on from three sides in the shape's own space (stretched with the copy, so it sways
 * with it), blended by which way the surface faces: no seams and no pinching anywhere on a ball, for
 * two more reads of the small tile. `metres`: how far one tile reaches; `ragged`: how much of the
 * outline is cut away.
 */
export function leafy(material: THREE.MeshStandardMaterial, metres: number, ragged = 0.7): void {
  const map = { value: leafTexture() };
  const before = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.uniforms.leafMap = map;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vLeafAt;\nvarying vec3 vLeafFacing;').replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vLeafAt = position / ${metres.toFixed(3)};
      #ifdef USE_INSTANCING
      vLeafAt *= vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
      #endif
      vLeafFacing = normal;`,
    );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D leafMap;\nvarying vec3 vLeafAt;\nvarying vec3 vLeafFacing;')
      // Leaves this rough hardly gloss (a few percent), so they take the light as plain diffuse surfaces: the
      // sun, the sky and the surroundings' light all in full, without the gloss's sums and look-ups.
      .replace(
        '#include <lights_physical_pars_fragment>',
        `#include <lights_physical_pars_fragment>
        void RE_Direct_Leaf(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
          reflectedLight.directDiffuse += saturate(dot(geometryNormal, directLight.direction)) * directLight.color * BRDF_Lambert(material.diffuseContribution);
        }
        void RE_IndirectSpecular_Leaf(const in vec3 radiance, const in vec3 irradiance, const in vec3 clearcoatRadiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
          reflectedLight.indirectDiffuse += material.diffuseContribution * irradiance * RECIPROCAL_PI;
        }
        #undef RE_Direct
        #define RE_Direct RE_Direct_Leaf
        #undef RE_IndirectSpecular
        #define RE_IndirectSpecular RE_IndirectSpecular_Leaf`,
      )
      .replace(
        '#include <lights_fragment_maps>',
        `#if defined(USE_ENVMAP) && defined(ENVMAP_TYPE_CUBE_UV)
        iblIrradiance += getIBLIrradiance(geometryNormal);
        #endif`,
      )
      .replace(
        '#include <map_fragment>',
        `vec3 leafSide = vLeafFacing * vLeafFacing;
        leafSide *= leafSide;
        leafSide /= leafSide.x + leafSide.y + leafSide.z;
        vec4 leafTexel = texture2D(leafMap, vLeafAt.zy) * leafSide.x + texture2D(leafMap, vLeafAt.xz) * leafSide.y + texture2D(leafMap, vLeafAt.xy) * leafSide.z;
        // Towards the outline (the surface turning away from the eye) only the clumps' middles stay.
        float leafEdge = 1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition)));
        if (leafTexel.a < smoothstep(0.45, 0.95, leafEdge) * ${ragged.toFixed(3)}) discard;
        diffuseColor.rgb *= leafTexel.r * ${(1 / mean).toFixed(3)};`,
      );
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${key()}|leafy${metres}|${ragged}`;
  material.needsUpdate = true;
}
