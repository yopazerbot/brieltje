import * as THREE from 'three';
import type { TileKind } from './houseStyle';

/**
 * The open-data houses' roof tiles in relief near the eye (world/surroundings.ts puts every pitched roof's slopes and
 * ridge rows in one material per tile). From afar a roof is the tiles' texture in the roof's colour, as before; from
 * about 15 to 40 m in (how far depends on how big a course of tiles comes out on the screen, so it never shimmers),
 * each pixel works out the tile it lies on from its texture coordinates (metres: along the eaves, up the slope) and
 * the tile's shape: the course's lower edge standing proud of the one below with a shadow under it, the pantile's roll,
 * the concrete tile's wide wave, the flat tile's ribs, slates staggered by half a slate with a dark joint, each tile a
 * little lighter or darker than its neighbours. The surface's normal comes from that shape, so the rows catch the sun
 * and the sky as real ones do. No geometry, no texture and no draw call: a few dozen operations per pixel of roof, on
 * Medium and up only (setRoofDetail); Low and phones keep the texture alone.
 *
 * Over the whole roof, near and far, a faint wash of lighter and darker patches a few metres across and streaks down
 * the slope (weather, batches of tiles), so a roof is not one flat colour. Also Medium and up only.
 *
 * The kind rides per vertex (a byte, `tile`) with the roof's colour and gloss: still one draw call per tile.
 */

/** The byte each kind is stored as (0 to 1), and the plain one (ridge rows: the wash only, no courses). */
export const TILE_BYTE: Record<TileKind | 'plain', number> = { pantile: 0, flat: 0.25, slate: 0.5, concrete: 0.75, plain: 1 };

const made: THREE.Material[] = [];
let relief = true;

/** Relief and wash on Medium and up; Low and phones keep the plain texture. */
export function setRoofDetail(on: boolean): void {
  if (on === relief) return;
  relief = on;
  for (const m of made) {
    if (on) m.defines = { ...m.defines, ROOF_RELIEF: '' };
    else delete m.defines?.ROOF_RELIEF;
    m.needsUpdate = true;
  }
}

/** Kept up to date with three.js's chunk: the tangent-space normal map, with the relief mixed in near the eye. */
const NORMAL_MAPS = THREE.ShaderChunk.normal_fragment_maps.replace(
  'mapN.xy *= normalScale;',
  'mapN.xy *= normalScale;\n#ifdef ROOF_RELIEF\nmapN = normalize( mix( mapN, rlN, rlNear ) );\n#endif',
);

const FRAGMENT_PARS = /* glsl */ `
varying float vTile;
varying vec2 vTileUv;
float rlHash( vec2 p ) {
  p = fract( p * vec2( 0.1031, 0.1030 ) );
  p += dot( p, p.yx + 33.33 );
  return fract( ( p.x + p.y ) * p.x );
}
float rlNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = p - i;
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( rlHash( i ), rlHash( i + vec2( 1.0, 0.0 ) ), f.x ), mix( rlHash( i + vec2( 0.0, 1.0 ) ), rlHash( i + 1.0 ), f.x ), f.y );
}
`;

/**
 * Worked out after the colour: rlN (the relief's normal in the texture's frame), rlNear (how much of it shows) and the
 * colour's change. Heights in metres over (u along the eaves, v up the slope), slopes as their derivatives.
 */
const RELIEF = /* glsl */ `
vec3 rlN = vec3( 0.0, 0.0, 1.0 );
float rlNear = 0.0;
#ifdef ROOF_RELIEF
{
  float kind = floor( vTile * 4.0 + 0.5 ); // 0 pantile, 1 flat, 2 slate, 3 concrete, 4 plain
  vec2 uv = vTileUv;
  // A course's width across and its height up the slope (the pantiles' as the texture's, so the two meet).
  vec2 size = kind < 0.5 ? vec2( 0.30, 0.30 ) : kind < 1.5 ? vec2( 0.30, 0.32 ) : kind < 2.5 ? vec2( 0.25, 0.20 ) : vec2( 0.30, 0.34 );
  float course = floor( uv.y / size.y );
  float fv = uv.y / size.y - course; // 0 at the course's lower edge
  float shift = kind > 1.5 && kind < 2.5 ? 0.5 * mod( course, 2.0 ) : 0.0; // slates staggered by half
  float col = floor( uv.x / size.x + shift );
  float fu = uv.x / size.x + shift - col;
  // How many metres a pixel covers: the courses fade out before they are a few pixels high.
  float px = max( length( dFdx( uv ) ), length( dFdy( uv ) ) );
  rlNear = kind > 3.5 ? 0.0 : 1.0 - smoothstep( 0.07, 0.2, px / size.y );
  float own = rlHash( vec2( col, course ) + kind * 17.0 ); // this tile's own number
  float dhu = 0.0; // slope across (height per metre along u)
  float dhv;       // and up the slope
  float shade = 1.0;
  // Every course stands on the one below: its lower edge proud by 'step', thinning towards its top, where the next
  // course's edge lies over it and throws a shadow.
  float step = kind < 0.5 ? 0.035 : kind < 1.5 ? 0.025 : kind < 2.5 ? 0.012 : 0.03;
  dhv = - step / size.y;
  float lip = 0.07; // the lower edge's face, turned down the slope
  if ( fv < lip ) dhv = step / ( lip * size.y );
  shade *= 1.0 - 0.38 * smoothstep( 0.72, 1.0, fv ) * ( kind > 1.5 && kind < 2.5 ? 0.7 : 1.0 );
  if ( kind < 0.5 ) {
    // Pantile: a trough and a roll, as the texture's.
    float a = clamp( ( fu - 0.5 ) / 0.5, 0.0, 1.0 );
    dhu = ( 0.045 * 3.14159 * cos( 3.14159 * a ) * ( fu > 0.5 ? 2.0 : 0.0 ) + 0.012 * 3.14159 * cos( 3.14159 * fu ) ) / size.x;
    shade *= 0.86 + 0.2 * sin( 3.14159 * a );
  } else if ( kind < 1.5 ) {
    // Flat interlocking tile: two low ribs and the joint at its side.
    float rib = sin( 6.28318 * fu * 2.0 );
    dhu = 0.004 * 6.28318 * 2.0 * cos( 6.28318 * fu * 2.0 ) / size.x;
    shade *= 0.97 + 0.03 * rib;
    shade *= 1.0 - 0.35 * ( 1.0 - smoothstep( 0.0, 0.03, min( fu, 1.0 - fu ) ) );
  } else if ( kind < 2.5 ) {
    // Slate: flat, each laid a little askew, a dark joint between them.
    dhu = ( own - 0.5 ) * 0.12;
    dhv += ( rlHash( vec2( course, col ) ) - 0.5 ) * 0.08;
    shade *= 1.0 - 0.55 * ( 1.0 - smoothstep( 0.0, 0.025, min( fu, 1.0 - fu ) ) );
  } else {
    // Concrete tile: one wide low wave.
    dhu = 0.022 * 6.28318 * cos( 6.28318 * fu ) / size.x;
    shade *= 0.95 + 0.05 * sin( 6.28318 * fu );
  }
  rlN = normalize( vec3( - dhu, - dhv, 1.0 ) );
  // Each tile its own tone (slate the most), and the texture's own courses given up for these.
  shade *= 1.0 + ( own - 0.5 ) * ( kind > 1.5 && kind < 2.5 ? 0.2 : kind > 2.5 ? 0.08 : 0.12 );
  vec3 own3 = vColor.rgb * diffuse * 0.6 * shade;
  diffuseColor.rgb = mix( diffuseColor.rgb, own3, rlNear );
  // The wash: patches a few metres across and streaks down the slope, a few per cent either way.
  float wash = 0.65 * rlNoise( uv * vec2( 0.35, 0.25 ) ) + 0.35 * rlNoise( vec2( uv.x * 1.7, uv.y * 0.12 ) );
  diffuseColor.rgb *= 0.9 + 0.2 * wash;
}
#endif
`;

/** Patch the roof tiles' material (once): the relief near the eye and the wash, on Medium and up. */
export function roofRelief<T extends THREE.Material>(m: T): T {
  if (made.includes(m)) return m;
  made.push(m);
  if (relief) m.defines = { ...m.defines, ROOF_RELIEF: '' };
  const before = m.onBeforeCompile;
  const key = m.customProgramCacheKey.bind(m);
  m.onBeforeCompile = (shader, renderer) => {
    before.call(m, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float tile;\nvarying float vTile;\nvarying vec2 vTileUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvTile = tile;\nvTileUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${RELIEF}`)
      .replace('#include <normal_fragment_maps>', NORMAL_MAPS);
  };
  m.customProgramCacheKey = () => `${key()}|relief`;
  m.needsUpdate = true;
  return m;
}
