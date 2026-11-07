import type * as THREE from 'three';

/**
 * Snow lying on the world (world/weather.ts sets how much): the ground, the roofs, the hedges and the tree crowns turn
 * white where they face up, in patches at first and then all over, and back as it melts. No new geometry and no
 * texture: one uniform shared by every material that takes it (`snowCover`, 0 to 1), and a few lines in their
 * fragment shader, skipped as a whole while there is no snow (a branch on a uniform, the same for every pixel).
 *
 * `snowOn(shader)` goes in a material's onBeforeCompile (world/groundShade.ts for the ground, world/bakedLight.ts for
 * the baked houses, world/wind.ts for the crowns and hedges, world/facadeLook.ts for the village's roof tiles and the
 * tops of its brick blocks). It works on three.js's standard material, after the surface's colour and normal are
 * known: the colour turns to snow's, matt, its relief smoothed. `open`: a GLSL expression, 0 to 1, how open the spot
 * is to the sky (under eaves and in the rooms of a baked house none falls); `amount`: how white it gets at most (roads
 * stay a little darker); `steep`: foliage (conifers, grasses), where snow catches on steep faces too, in clumps.
 *
 * `snowy(material)` does the same for a whole material (the flat roofs: world/houseMeshes.ts), and `snowOnModel(root)`
 * for the parts of our own models that have no bake (their streets, pavements, conifers, garden things and far houses).
 */

/** How much snow lies, 0 to 1. */
export const snowCover = { value: 0 };

const PARS = /* glsl */ `
uniform float snowCover;
float snowHash( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float snowNoise( vec2 p ) {
  vec2 i = mod( floor( p ), 256.0 );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( snowHash( i ), snowHash( mod( i + vec2( 1.0, 0.0 ), 256.0 ) ), f.x ),
    mix( snowHash( mod( i + vec2( 0.0, 1.0 ), 256.0 ) ), snowHash( mod( i + vec2( 1.0, 1.0 ), 256.0 ) ), f.x ), f.y );
}
`;

const snow = (open: string, amount: number, steep: boolean) => /* glsl */ `
if ( snowCover > 0.0 ) {
  // The surface's own normal and place in the world (the view's inverse turn: its transpose).
  vec3 snowN = normalize( ( vec4( nonPerturbedNormal, 0.0 ) * viewMatrix ).xyz );
  float snowUp = ${steep ? 'smoothstep( -0.3, 0.25, snowN.y )' : 'smoothstep( 0.25, 0.7, snowN.y )'};
  if ( snowUp > 0.0 ) { // walls and undersides: nothing more to work out
    vec3 snowAt = cameraPosition + ( vec4( - vViewPosition, 0.0 ) * viewMatrix ).xyz;
    ${steep
      // Foliage: clumps of a hand's width or two on the branches, up the height too; between them it stays green.
      ? `float snowPatch = snowNoise( snowAt.xz * 3.1 + snowAt.y * 2.3 ) * 0.6 + snowNoise( snowAt.xz * 7.3 - snowAt.y * 4.1 ) * 0.4;
    float snowNeed = snowPatch * 0.9 + 0.85 - 0.45 * snowN.y;`
      // Patches of a metre or two and of a hand's width: the first snow lies in them, the last melts there.
      : `float snowPatch = snowNoise( snowAt.xz * 0.7 + snowAt.y * 0.3 ) * 0.65 + snowNoise( snowAt.xz * 4.3 ) * 0.35;
    float snowNeed = snowPatch * 0.75 + ( 1.0 - snowN.y ) * 0.35;`}
    float snowK = snowUp * smoothstep( snowNeed, snowNeed + 0.18, snowCover * 1.25 ) * clamp( ${open}, 0.0, 1.0 ) * ${amount.toFixed(2)};
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.76, 0.79, 0.84 ) * ( 0.93 + 0.07 * snowPatch ), snowK );
    normal = normalize( mix( normal, nonPerturbedNormal, snowK ) );
    #ifdef STANDARD
      roughnessFactor = mix( roughnessFactor, 0.8, snowK );
      metalnessFactor = mix( metalnessFactor, 0.0, snowK );
    #endif
  }
}
`;

interface Shader {
  uniforms: Record<string, { value: unknown }>;
  fragmentShader: string;
}

/** Let this material's surfaces take the snow (in its onBeforeCompile; once is enough, again does nothing). */
export function snowOn(shader: Shader, open = '1.0', amount = 1, steep = false): void {
  const f = shader.fragmentShader;
  if (shader.uniforms.snowCover || !f.includes('#include <emissivemap_fragment>') || !f.includes('#include <normal_fragment_begin>')) return;
  shader.uniforms.snowCover = snowCover;
  shader.fragmentShader = f
    .replace('#include <common>', `#include <common>\n${PARS}`)
    .replace('#include <emissivemap_fragment>', `${snow(open, amount, steep)}\n#include <emissivemap_fragment>`);
}

/** How a surface takes the snow: see snowOn. */
export interface SnowLook {
  amount?: number;
  steep?: boolean;
}

const patched = new WeakSet<THREE.Material>();

/**
 * Let a whole material take the snow, open to the sky everywhere: only for surfaces that are all outdoors (a roof's
 * top, a street). Once per material; its program is told apart from the same material without snow.
 */
export function snowy<T extends THREE.Material>(m: T, look: SnowLook = {}): T {
  if (patched.has(m)) return m;
  patched.add(m);
  const { amount = 1, steep = false } = look;
  const before = m.onBeforeCompile;
  const key = m.customProgramCacheKey.bind(m);
  m.onBeforeCompile = (shader, renderer) => {
    before.call(m, shader, renderer);
    snowOn(shader, '1.0', amount, steep);
  };
  m.customProgramCacheKey = () => `${key()}|snow${amount}${steep ? 's' : ''}`;
  m.needsUpdate = true;
  return m;
}

/**
 * Our own models' parts without a bake (a baked part takes its snow from the bake, which knows where the sky is open:
 * world/bakedLight.ts), by their name in the model. Only what is all outdoors: the streets and pavements, the paving
 * of yards and terraces, the conifers, box balls and grasses, the gardens' things, the far houses round the square.
 * Not the church's fittings and trims: the tower's vestibule and the porch chapel's insides are among them.
 */
const MODEL_PARTS: [RegExp, SnowLook][] = [
  [/^mh_(asphalt|pavers)$/, { amount: 0.85 }], // Molenhoek's street and pavements: as the village's roads
  [/^mh_foliage(_g)?$/, { amount: 0.9, steep: true }], // the conifers, clipped hedges and box balls
  [/^mh_detail(_[ewmg])?$|^mh_(stone|render)_g$|^mh_tiles$/, {}], // walls, posts, cabinets, sills; a garden's walls and tiles
  [/^school_yard$/, { amount: 0.85 }], // the playground
  [/^school_fittings$/, {}], // the square's beds and their grasses, benches, signs, the playground's things
  [/^far_(roof|brick|render)$/, {}], // the far houses round the square
  [/^near_trim$/, {}], // the near ones' sills, copings and beds of grasses
  [/^caf_slabs$/, { amount: 0.85 }], // the café's path of slabs
  [/^caf_fittings$/, {}], // its metal roofs, the terrace's tables, the posts
  [/^kouter_(roof|gravel|paving|stone)$/, {}], // the house on the Kouter, which has no bake
  [/^kouter_leaves$/, { amount: 0.9, steep: true }],
  [/_hs_slab$/, { amount: 0.85 }], // the terraces of the houses at home
  [/_hs_trim$/, {}], // their flat roofs' decks, copings and sills
];

/** Give a loaded model's unbaked outdoor parts the snow (see MODEL_PARTS). Before or after its bake. */
export function snowOnModel(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || mesh.geometry.attributes.uv1) return;
    const look = MODEL_PARTS.find(([name]) => name.test(mesh.name))?.[1];
    if (!look) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) snowy(m, look);
  });
}
