import * as THREE from 'three';

/**
 * A helicopter's rotor wash in the shaders (world/rotorWash.ts fills it each frame): one small set of uniforms shared by
 * every material that reads it, and the GLSL to read it with. Its own module, with nothing in it but three.js, so the
 * shaders that read it (the grass, the water, the plants, the rain, the trees: world/wind.ts) import nothing else.
 */

/** Discs in the shaders at once: the machines nearest the eye */
export const DISCS = 2;

const discs = Array.from({ length: DISCS }, () => new THREE.Vector4());
const aux = Array.from({ length: DISCS }, () => new THREE.Vector4());
/**
 * `washDisc[i]` the disc's middle (x, z), its reach (m) and its strength on the ground (0: none); `washAux[i]` the rotor
 * hub's height (y) and the strength in the tree crowns. Changed in place; the same objects in every material.
 */
export const washUniforms = { washDisc: { value: discs }, washAux: { value: aux }, washTime: { value: 0 } };

/**
 * `washAt(p)` at the world's (x, z): xy the push outward (0 to about 1, gusting), z how hard the air comes straight down
 * there (under the hub). `washCrown(p, y)` the same for a tree crown whose point is at height y (none above the hub).
 * An empty disc is one test.
 */
export const WASH_GLSL = /* glsl */ `
uniform vec4 washDisc[ ${DISCS} ];
uniform vec4 washAux[ ${DISCS} ];
uniform float washTime;
vec3 washAt( vec2 p ) {
  vec3 o = vec3( 0.0 );
  for ( int i = 0; i < ${DISCS}; i ++ ) {
    vec4 d = washDisc[ i ];
    if ( d.w <= 0.0 ) continue;
    vec2 v = p - d.xy;
    float r = length( v );
    if ( r >= d.z ) continue;
    float x = r / d.z;
    // Gusts running outward, uneven round the ring.
    float gust = 0.72 + 0.28 * sin( washTime * 11.0 - r * 1.6 + float( i ) * 2.1 ) * sin( washTime * 3.1 + dot( v, vec2( 0.83, 0.56 ) ) * 0.9 );
    o.xy += v / max( r, 0.05 ) * d.w * smoothstep( 0.0, 0.2, x ) * ( 1.0 - smoothstep( 0.4, 1.0, x ) ) * gust;
    o.z += d.w * ( 1.0 - smoothstep( 0.1, 0.5, x ) ) * gust;
  }
  return o;
}
vec2 washRain( vec3 w ) {
  vec2 o = vec2( 0.0 );
  for ( int i = 0; i < ${DISCS}; i ++ ) {
    vec4 d = washDisc[ i ];
    float below = washAux[ i ].x - w.y;
    if ( d.w <= 0.0 || below <= 0.0 ) continue;
    vec2 v = w.xz - d.xy;
    float r = length( v );
    if ( r >= d.z ) continue;
    o += v / max( r, 0.3 ) * d.w * min( below, 8.0 ) * 0.4 * ( 1.0 - smoothstep( 0.3, 1.0, r / d.z ) );
  }
  return o;
}
vec3 washCrown( vec2 p, float y ) {
  vec3 o = vec3( 0.0 );
  for ( int i = 0; i < ${DISCS}; i ++ ) {
    vec4 d = washDisc[ i ];
    vec4 a = washAux[ i ];
    if ( a.y <= 0.0 ) continue;
    vec2 v = p - d.xy;
    float r = length( v );
    float reach = d.z * 0.8;
    if ( r >= reach || y > a.x + 1.0 ) continue;
    float k = a.y * ( 1.0 - smoothstep( 0.3, 1.0, r / reach ) );
    o.xy += v / max( r, 0.5 ) * k;
    o.z += k;
  }
  return o;
}
`;

/**
 * The ponds' and ditches' water (world/water.ts, its `vWater`: the world's x, z of the pixel): under a helicopter, rings
 * running outward and the surface torn rough by the wash, paler with the spray. Only inside a disc; none on Low.
 */
export function washWaterOn(shader: THREE.WebGLProgramParametersWithUniforms): void {
  Object.assign(shader.uniforms, washUniforms);
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${WASH_GLSL}`).replace(
    '#include <emissivemap_fragment>',
    `{
      vec3 wW = washAt( vWater );
      float wK = min( 1.0, length( wW.xy ) + wW.z );
      if ( wK > 0.001 ) {
        vec2 wGrad = vec2( 0.0 );
        for ( int i = 0; i < ${DISCS}; i ++ ) {
          vec4 d = washDisc[ i ];
          if ( d.w <= 0.0 ) continue;
          vec2 v = vWater - d.xy;
          float r = length( v );
          float x = r / d.z;
          if ( x >= 1.0 ) continue;
          wGrad += v / max( r, 0.1 ) * sin( r * 2.6 - washTime * 9.0 ) * 0.09 * d.w * smoothstep( 0.0, 0.15, x ) * ( 1.0 - smoothstep( 0.5, 1.0, x ) );
        }
        // The chop: short steep waves every way, gone where they would be under a few pixels.
        float wKeep = clamp( 1.0 - length( fwidth( vWater ) ) * 6.0, 0.0, 1.0 );
        vec2 wQ = vWater * 5.0;
        wGrad += vec2( sin( wQ.x * 1.3 + washTime * 14.0 + sin( wQ.y * 1.1 ) ), sin( wQ.y * 1.7 - washTime * 12.0 + sin( wQ.x * 0.9 ) ) ) * 0.06 * wK * wKeep;
        normal = normalize( normal + ( viewMatrix * vec4( - wGrad.x, 0.0, - wGrad.y, 0.0 ) ).xyz );
        roughnessFactor = min( 1.0, roughnessFactor + 0.14 * wK );
        diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.36, 0.39, 0.39 ), 0.3 * wK );
      }
    }
    #include <emissivemap_fragment>`,
  );
}

/**
 * The tree crowns and the hedges' leafy lumps (world/wind.ts sway): near a helicopter they lean away from it and shake
 * hard, the more the nearer. Instanced shapes only (a crown's place is its instance's).
 */
export function washOn(shader: THREE.WebGLProgramParametersWithUniforms): void {
  Object.assign(shader.uniforms, washUniforms);
  shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${WASH_GLSL}`).replace(
    '#include <begin_vertex>',
    `#include <begin_vertex>
    #ifdef USE_INSTANCING
    if ( washAux[ 0 ].y + washAux[ 1 ].y > 0.0 ) {
      vec3 washRoot = ( modelMatrix * vec4( instanceMatrix[ 3 ].xyz, 1.0 ) ).xyz;
      vec3 washC = washCrown( washRoot.xz, washRoot.y );
      if ( washC.z > 0.0 ) {
        // Metres in the world into the shape's own units (its instance turns and scales it).
        vec3 washC0 = instanceMatrix[ 0 ].xyz;
        vec3 washC2 = instanceMatrix[ 2 ].xyz;
        float washUp = clamp( transformed.y * 0.5 + 0.55, 0.0, 1.4 );
        float washShake = sin( washTime * 17.0 + dot( transformed, vec3( 6.1, 4.7, 5.3 ) ) ) * 0.5 + sin( washTime * 9.0 + washRoot.x ) * 0.5;
        vec3 washW = vec3( washC.x, 0.0, washC.y ) * ( 0.35 + 0.15 * washShake ) * washUp;
        transformed.x += dot( washW, washC0 ) / dot( washC0, washC0 );
        transformed.z += dot( washW, washC2 ) / dot( washC2, washC2 );
        transformed += objectNormal * washShake * 0.06 * washC.z;
      }
    }
    #endif`,
  );
}
