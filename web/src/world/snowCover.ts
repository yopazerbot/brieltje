/**
 * Snow lying on the world (world/weather.ts sets how much): the ground, the roofs, the hedges and the tree crowns turn
 * white where they face up, in patches at first and then all over, and back as it melts. No new geometry and no
 * texture: one uniform shared by every material that takes it (`snowCover`, 0 to 1), and a few lines in their
 * fragment shader, skipped as a whole while there is no snow (a branch on a uniform, the same for every pixel).
 *
 * `snowOn(shader)` goes in a material's onBeforeCompile (world/groundShade.ts for the ground, world/bakedLight.ts for
 * the baked houses, world/wind.ts for the crowns and hedges, world/facadeLook.ts for the village's roof tiles). It
 * works on three.js's standard material, after the surface's colour and normal are known: the colour turns to snow's,
 * matt, its relief smoothed. `open`: a GLSL expression, 0 to 1, how open the spot is to the sky (under eaves and in
 * the rooms of a baked house none falls); `amount`: how white it gets at most (roads stay a little darker).
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

const snow = (open: string, amount: number) => /* glsl */ `
if ( snowCover > 0.0 ) {
  // The surface's own normal and place in the world (the view's inverse turn: its transpose).
  vec3 snowN = normalize( ( vec4( nonPerturbedNormal, 0.0 ) * viewMatrix ).xyz );
  vec3 snowAt = cameraPosition + ( vec4( - vViewPosition, 0.0 ) * viewMatrix ).xyz;
  float snowUp = smoothstep( 0.25, 0.7, snowN.y );
  // Patches of a metre or two and of a hand's width: the first snow lies in them, the last melts there.
  float snowPatch = snowNoise( snowAt.xz * 0.7 + snowAt.y * 0.3 ) * 0.65 + snowNoise( snowAt.xz * 4.3 ) * 0.35;
  float snowNeed = snowPatch * 0.75 + ( 1.0 - snowN.y ) * 0.35;
  float snowK = snowUp * smoothstep( snowNeed, snowNeed + 0.18, snowCover * 1.25 ) * clamp( ${open}, 0.0, 1.0 ) * ${amount.toFixed(2)};
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.76, 0.79, 0.84 ) * ( 0.93 + 0.07 * snowPatch ), snowK );
  normal = normalize( mix( normal, nonPerturbedNormal, snowK ) );
  #ifdef STANDARD
    roughnessFactor = mix( roughnessFactor, 0.8, snowK );
    metalnessFactor = mix( metalnessFactor, 0.0, snowK );
  #endif
}
`;

interface Shader {
  uniforms: Record<string, { value: unknown }>;
  fragmentShader: string;
}

/** Let this material's surfaces take the snow (in its onBeforeCompile; once is enough, again does nothing). */
export function snowOn(shader: Shader, open = '1.0', amount = 1): void {
  const f = shader.fragmentShader;
  if (shader.uniforms.snowCover || !f.includes('#include <emissivemap_fragment>') || !f.includes('#include <normal_fragment_begin>')) return;
  shader.uniforms.snowCover = snowCover;
  shader.fragmentShader = f
    .replace('#include <common>', `#include <common>\n${PARS}`)
    .replace('#include <emissivemap_fragment>', `${snow(open, amount)}\n#include <emissivemap_fragment>`);
}
