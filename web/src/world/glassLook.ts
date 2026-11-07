import * as THREE from 'three';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { mood } from './mood';
import { reflectionLayers, withoutDetail } from './reflections';
import { wet, wetState } from './wetGround';

/**
 * Glass that looks like glass: it mirrors the sky and the street round it, more the flatter it is seen (fresnel), over
 * what is behind it. Three kinds:
 *
 * - The windows of our own building models (the school, the church, the café, the houses round the square, Molenhoek,
 *   the houses at home), which have no inside: `glassOnModel` turns their flat dark glass into double glazing over a
 *   room. The room is worked out per pixel of glass from the view ray (interior mapping), in boxes of the world's own
 *   grid along the wall (3.6 m wide, a storey 3 m high, 2.5 to 5 m deep), so no window needs anything of its own: walls,
 *   a floor and a ceiling, a blind half down in some, and at night a warm lamp in about two rooms in five. The church's
 *   stained glass keeps its colours, dim by day and softly lit from inside at night. Low and phones: a flat back wall.
 * - Glass with a real inside behind it (the main house's windows and doors, the bus shelter's and the school's clear
 *   glass): `clearGlass` keeps it see-through, but the reflection is no longer thinned with the glass's opacity: as
 *   real glass, it lets through what it does not reflect.
 * - The open-data houses' windows (world/windows.ts) keep their curtains and rooms and take the street's reflection.
 *
 * What they mirror: on Medium and up, a picture of the scene all round the eye (a cube of six views, 256 pixels each,
 * GlassProbe), one view drawn every second frame, so it is new every twelve frames; a glass reads it as if the street
 * round it were a box about 36 m across (box projection), so a window across the street shows the houses behind you
 * where they stand. Far from the eye, and on Low, the sky's photo (the scene's environment light) as before.
 *
 * In the rain, and as long as it is wet after, drops bead on the glass and run down it in streaks, each bending what
 * the glass mirrors (Medium and up, near the eye, where a drop is bigger than a pixel).
 *
 * Bright things mirrored are kept under what half floats hold (65504): an iPhone stores more as infinity.
 */

/** Shared by every glass: the probe's picture and where it was taken, the night, the rain. */
export const glass = {
  probe: { value: null as THREE.Texture | null },
  probeAt: { value: new THREE.Vector3() },
  probeOn: { value: 0 },
  night: { value: 0 },
  /** 1 on Medium and up: the rooms and the drops (a branch on a uniform, the same for every pixel) */
  fine: { value: 1 },
};

const PARS = /* glsl */ `
uniform samplerCube glassProbe;
uniform vec3 glassProbeAt;
uniform float glassProbeOn;
uniform float glassNight;
uniform float glassFine;
uniform float wetAmount;
uniform float wetRain;
uniform float wetTime;
float glassHash( vec2 p ) {
  vec3 q = fract( vec3( p.xyx ) * 0.1031 );
  q += dot( q, q.yzx + 33.33 );
  return fract( ( q.x + q.y ) * q.z );
}
// The street round the probe as a box: where a ray from p leaves it, as seen from the probe.
vec3 glassBox( vec3 p, vec3 r ) {
  r = vec3( abs( r.x ) < 1e-4 ? 1e-4 : r.x, abs( r.y ) < 1e-4 ? 1e-4 : r.y, abs( r.z ) < 1e-4 ? 1e-4 : r.z );
  vec3 lo = glassProbeAt + vec3( -18.0, -3.0, -18.0 );
  vec3 hi = glassProbeAt + vec3( 18.0, 40.0, 18.0 );
  vec3 out3 = max( ( lo - p ) / r, ( hi - p ) / r );
  return p + r * max( min( min( out3.x, out3.y ), out3.z ), 0.0 ) - glassProbeAt;
}
// Drops on a pane in the rain: beads, and now and then one running down with a trail. s along the pane, y up (m).
// Returns how they tilt the surface (along, up) and how much of the pane they cover.
vec3 glassDrops( float s, float y, float t, float wetness, float rain ) {
  vec2 tilt = vec2( 0.0 );
  float cover = 0.0;
  // Beads in a grid of 2.5 cm: about half the cells have one while it rains, fewer as it dries.
  vec2 g = vec2( s, y ) / 0.025;
  vec2 c = floor( g );
  float h = glassHash( c );
  if ( h < 0.55 * wetness ) {
    vec2 at = c + 0.25 + 0.5 * vec2( glassHash( c + 3.7 ), glassHash( c + 9.1 ) );
    vec2 d = ( g - at ) * 0.025;
    float r = 0.002 + 0.004 * glassHash( c + 5.3 );
    float k = dot( d, d ) / ( r * r );
    if ( k < 1.0 ) {
      tilt += d / r * 0.6;
      cover = max( cover, 1.0 - k );
    }
  }
  // Running drops: one in some of the 5 cm columns, at its own pace, leaving a thin wet trail.
  float col = floor( s / 0.05 );
  float hc = glassHash( vec2( col, 7.0 ) );
  if ( rain > 0.0 && hc < 0.5 * rain ) {
    float x = ( fract( s / 0.05 ) - 0.5 ) * 0.05 + 0.008 * sin( y * 23.0 + hc * 40.0 );
    float speed = 0.06 + 0.12 * glassHash( vec2( col, 1.0 ) );
    float head = 1.6 - mod( t * speed + hc * 1.6, 1.6 ); // metres down its run, repeating
    float v = mod( y, 1.6 ) - head; // above the head: the trail
    float rh = 0.003;
    vec2 d = vec2( x, v );
    float k = dot( d, d ) / ( rh * rh );
    if ( k < 1.0 ) {
      tilt += d / rh * 0.7;
      cover = max( cover, 1.0 - k );
    } else if ( v > 0.0 && v < 0.25 && abs( x ) < 0.0012 ) {
      tilt.x += x / 0.0012 * 0.25;
      cover = max( cover, 0.5 * ( 1.0 - v / 0.25 ) );
    }
  }
  return vec3( tilt, cover );
}
`;

/** After the normal is known: the drops tilt it (Medium and up, while wet, near enough for a drop to be seen). */
const DROPS = /* glsl */ `
if ( glassFine > 0.5 && wetAmount > 0.05 ) {
  vec3 gdP = cameraPosition + ( vec4( - vViewPosition, 0.0 ) * viewMatrix ).xyz;
  vec3 gdN = normalize( ( vec4( nonPerturbedNormal, 0.0 ) * viewMatrix ).xyz );
  if ( abs( gdN.y ) < 0.5 ) {
    vec3 gdAlong = normalize( vec3( gdN.z, 0.0, - gdN.x ) + vec3( 1e-5, 0.0, 0.0 ) );
    float gdS = dot( gdP, gdAlong );
    float gdPx = max( fwidth( gdS ), fwidth( gdP.y ) );
    float gdSeen = 1.0 - smoothstep( 0.002, 0.006, gdPx );
    if ( gdSeen > 0.0 ) {
      vec3 gd = glassDrops( gdS, gdP.y, wetTime, wetAmount, wetRain );
      vec3 gdTilt = ( gdAlong * gd.x + vec3( 0.0, gd.y, 0.0 ) ) * gdSeen;
      normal = normalize( normal + ( viewMatrix * vec4( gdTilt, 0.0 ) ).xyz );
      glassWater = gd.z * gdSeen;
    }
  }
}
`;

/** Where the light is put together: the probe's picture in place of the sky's, near the eye. */
const PROBE = /* glsl */ `
#if defined( RE_IndirectSpecular )
if ( glassProbeOn > 0.5 ) {
  vec3 gpP = cameraPosition + ( vec4( - vViewPosition, 0.0 ) * viewMatrix ).xyz;
  vec3 gpE = abs( gpP - glassProbeAt ) / vec3( 18.0, 40.0, 18.0 );
  float gpIn = 1.0 - smoothstep( 0.75, 1.0, max( max( gpE.x, gpE.z ), gpE.y ) );
  if ( gpIn > 0.0 ) {
    vec3 gpR = normalize( ( vec4( reflect( - geometryViewDir, geometryNormal ), 0.0 ) * viewMatrix ).xyz );
    vec3 gpC = min( textureCube( glassProbe, glassBox( gpP, gpR ) ).rgb, vec3( 20000.0 ) );
    #ifdef USE_ENVMAP
      gpC *= envMapIntensity;
    #endif
    radiance = mix( radiance, gpC, gpIn );
  }
}
#endif
`;

const CLAMP = 'gl_FragColor.rgb = min( gl_FragColor.rgb, vec3( 60000.0 ) );';

interface Shader {
  uniforms: Record<string, { value: unknown }>;
  fragmentShader: string;
}

/**
 * Let a glass mirror the street round the eye and take the rain's drops (in its onBeforeCompile; again does nothing).
 * Leaves `glassWater` (0 to 1: a drop or a trail here) for the rest of the shader.
 */
export function probeOn(shader: Shader): void {
  const f = shader.fragmentShader;
  if (shader.uniforms.glassProbe || !f.includes('#include <normal_fragment_maps>') || !f.includes('#include <lights_fragment_end>')) return;
  Object.assign(shader.uniforms, {
    glassProbe: glass.probe, glassProbeAt: glass.probeAt, glassProbeOn: glass.probeOn, glassNight: glass.night, glassFine: glass.fine,
    wetAmount: wet.amount, wetRain: wet.rain, wetTime: wet.time,
  });
  shader.fragmentShader = f
    .replace('#include <common>', `#include <common>\n${PARS}\nfloat glassWater = 0.0;`)
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${DROPS}`)
    .replace('#include <lights_fragment_end>', `${PROBE}\n#include <lights_fragment_end>`)
    .replace('#include <dithering_fragment>', f.includes(CLAMP) ? '#include <dithering_fragment>' : `${CLAMP}\n#include <dithering_fragment>`);
}

/**
 * The room behind a window of a model with no inside, in place of its colour; at night a lamp in some rooms. Rooms are
 * boxes of a grid along the wall, so neighbouring windows of one room agree. Stained glass (a colour map) keeps its
 * colours instead.
 */
const ROOM = /* glsl */ `
vec3 glassRoomLight = vec3( 0.0 );
{
  vec3 grP = cameraPosition + ( vec4( - vViewPosition, 0.0 ) * viewMatrix ).xyz;
  vec3 grV = normalize( grP - cameraPosition );
  vec3 grN = normalize( ( vec4( vNormal, 0.0 ) * viewMatrix ).xyz );
  if ( dot( grN, grV ) > 0.0 ) grN = - grN;
  vec3 grIn = normalize( vec3( - grN.x, 0.0, - grN.z ) + vec3( 1e-5, 0.0, 0.0 ) );
  vec3 grAlong = vec3( grIn.z, 0.0, - grIn.x );
  // The view ray and the spot in the room's frame: x along the wall, y up, z into the room.
  vec3 grD = vec3( dot( grV, grAlong ), grV.y, max( dot( grV, grIn ), 0.02 ) );
  vec3 grO = vec3( dot( grP, grAlong ), grP.y, 0.0 );
  vec2 grCell = floor( vec2( grO.x / 3.6, grO.y / 3.0 ) );
  float grWall = floor( grIn.x * 4.0 + 0.5 ) * 7.0 + floor( grIn.z * 4.0 + 0.5 ) * 13.0; // the wall's side
  vec4 grH = vec4( glassHash( grCell + grWall * 1.31 ), glassHash( grCell * 1.7 + grWall + 4.1 ), glassHash( grCell + grWall + 8.3 ), glassHash( grCell * 0.7 + grWall + 2.9 ) );
  bool grLit = grH.y < 0.4;
  vec3 grLamp = mix( vec3( 1.0, 0.55, 0.24 ), vec3( 1.0, 0.82, 0.6 ), grH.z );
  #ifdef GLASS_STAINED
    // Stained glass: its own colours, dim by day (the nave behind is dark), softly lit from inside at night.
    vec3 grSeen = diffuseColor.rgb;
    diffuseColor.rgb = grSeen * 0.35;
    glassRoomLight = grSeen * vec3( 1.0, 0.8, 0.55 ) * 0.3;
    grLit = true; // the whole nave, softly
  #else
    vec3 grWallC = mix( vec3( 0.72, 0.68, 0.6 ), vec3( 0.5, 0.52, 0.55 ), grH.x );
    vec3 grAlbedo;
    float grFar = 1.0;
    float grGlow = 0.5;
    if ( glassFine > 0.5 ) {
      float depth = mix( 2.5, 5.0, grH.x );
      vec3 lo = vec3( grCell.x * 3.6, grCell.y * 3.0, 0.0 );
      vec3 hi = vec3( lo.x + 3.6, lo.y + 3.0, depth );
      vec3 d = vec3( abs( grD.x ) < 1e-4 ? 1e-4 : grD.x, abs( grD.y ) < 1e-4 ? 1e-4 : grD.y, grD.z );
      vec3 t3 = ( mix( lo, hi, step( 0.0, d ) ) - grO ) / d;
      float t = min( min( t3.x, t3.y ), t3.z );
      vec3 q = grO + d * t;
      vec3 e = min( q - lo, hi - q );
      float corner;
      if ( t == t3.z ) {
        grAlbedo = grWallC;
        corner = min( e.x, e.y );
        // A cupboard or a desk against the back wall in some rooms.
        if ( grH.w > 0.4 && q.y - lo.y < 0.85 && abs( q.x - lo.x - 1.8 + ( grH.w - 0.7 ) * 2.0 ) < 0.9 ) grAlbedo = mix( vec3( 0.25, 0.17, 0.1 ), vec3( 0.55, 0.53, 0.5 ), fract( grH.w * 7.0 ) );
      } else if ( t == t3.x ) {
        grAlbedo = grWallC * 0.85;
        corner = min( e.y, e.z );
      } else if ( d.y < 0.0 ) {
        grAlbedo = mix( vec3( 0.35, 0.24, 0.14 ), vec3( 0.3, 0.3, 0.29 ), step( 0.5, grH.z ) );
        corner = min( e.x, e.z );
      } else {
        grAlbedo = vec3( 0.8, 0.79, 0.77 );
        corner = min( e.x, e.z );
      }
      float ao = 0.5 + 0.5 * smoothstep( 0.0, 0.4, corner );
      grFar = ( 1.0 - 0.55 * q.z / depth ) * ao;
      vec3 toLamp = vec3( 0.5 * ( lo.x + hi.x ), hi.y - 0.3, depth * 0.5 ) - q;
      grGlow = ao / ( 1.0 + 0.4 * dot( toLamp, toLamp ) );
    } else {
      grAlbedo = grWallC * 0.8;
    }
    // A blind half down in some rooms, right behind the glass.
    float grBlind = glassBlind( grO.y, grCell.y, grH.w );
    vec3 grBlindC = mix( vec3( 0.85, 0.83, 0.78 ), vec3( 0.42, 0.42, 0.44 ), step( 0.6, grH.x ) );
    // By day the room is lit through the windows and seen through two panes: dim.
    diffuseColor.rgb = mix( grAlbedo * grFar * 0.2, grBlindC * 0.35, grBlind );
    glassRoomLight = mix( grAlbedo * grGlow * 2.2, grBlindC * 0.5, grBlind );
  #endif
  glassRoomLight *= grLamp * glassNight * ( grLit ? 1.0 : 0.0 );
}
`;
const ROOM_PARS = /* glsl */ `
// How far a blind is down at this height of its storey (0 or 1): in about one room in four, down to a third to two thirds.
float glassBlind( float y, float storey, float h ) {
  if ( h > 0.25 ) return 0.0;
  float bottom = storey * 3.0 + 3.0 - ( 0.9 + 1.4 * fract( h * 13.0 ) );
  return step( bottom, y );
}
`;

const patched = new WeakSet<THREE.Material>();
/** The materials whose glass reads the probe (GlassProbe draws it only with one of them near). */
const probeUsers = new WeakSet<THREE.Material>();

/** This material's glass reads the probe (world/windows.ts: the open-data houses' panes; roomGlass and clearGlass say so themselves). */
export function usesProbe(m: THREE.Material): void {
  probeUsers.add(m);
}

/** A model's glass with no inside behind it: double glazing over a room (see ROOM), mirroring the street. */
export function roomGlass<T extends THREE.MeshStandardMaterial>(m: T): T {
  if (patched.has(m)) return m;
  patched.add(m);
  probeUsers.add(m);
  const stained = !!m.map;
  m.roughness = 0.03;
  m.metalness = 0;
  m.envMapIntensity = 1.5;
  const before = m.onBeforeCompile;
  const key = m.customProgramCacheKey(); // as it is now: its own onBeforeCompile's, before this one wraps it
  m.onBeforeCompile = (shader, renderer) => {
    before.call(m, shader, renderer);
    probeOn(shader);
    if (stained) shader.fragmentShader = `#define GLASS_STAINED\n${shader.fragmentShader}`;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${ROOM_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${ROOM}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = 0.03;')
      // Two panes and their coating: about three times one surface's reflection; less at night, so the lit rooms show.
      .replace(
        '#include <lights_physical_fragment>',
        '#include <lights_physical_fragment>\nmaterial.specularColor = vec3( 0.12 * ( 1.0 - 0.5 * glassNight ) );\nmaterial.specularColorBlended = material.specularColor;',
      )
      .replace(
        '#include <lights_fragment_end>',
        // The room is lit by the sky through the window, not by the sun on the glass; the lamp's light is its own.
        '#include <lights_fragment_end>\nreflectedLight.directDiffuse *= 0.0;\nreflectedLight.indirectDiffuse *= 1.0 - 0.5 * glassWater;\ntotalEmissiveRadiance += glassRoomLight;',
      );
  };
  m.customProgramCacheKey = () => `${key}|roomGlass${stained ? 's' : ''}`;
  m.needsUpdate = true;
  return m;
}

/**
 * Glass with a real inside behind it (see-through): it mirrors the street, and lets through what it does not reflect,
 * instead of thinning its reflection with its opacity as three.js's blending would.
 */
export function clearGlass<T extends THREE.MeshStandardMaterial>(m: T): T {
  if (patched.has(m)) return m;
  patched.add(m);
  probeUsers.add(m);
  const before = m.onBeforeCompile;
  const key = m.customProgramCacheKey(); // as it is now: its own onBeforeCompile's, before this one wraps it
  m.onBeforeCompile = (shader, renderer) => {
    before.call(m, shader, renderer);
    probeOn(shader);
    shader.fragmentShader = shader.fragmentShader
      // Double glazing: about twice one surface's reflection.
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\nmaterial.specularColor = vec3( 0.08 );\nmaterial.specularColorBlended = material.specularColor;')
      .replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>
        {
          // As much is covered as is reflected (fresnel, with the glass's own tint on top); the rest shows through.
          float gcNV = saturate( dot( geometryNormal, geometryViewDir ) );
          float gcF = 0.08 + 0.92 * pow( 1.0 - gcNV, 5.0 );
          float gcA = clamp( diffuseColor.a + ( 1.0 - diffuseColor.a ) * gcF + 0.25 * glassWater, 0.0, 1.0 );
          gl_FragColor = vec4( ( totalDiffuse * diffuseColor.a + totalSpecular + totalEmissiveRadiance ) / max( gcA, 0.01 ), gcA );
        }`,
      );
  };
  m.customProgramCacheKey = () => `${key}|clearGlass`;
  m.needsUpdate = true;
  return m;
}

/** Give a loaded model's glass its look: `_glass` over a room, `_clear` see-through (see the module's comment). */
export function glassOnModel(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!(m as THREE.MeshStandardMaterial).isMeshStandardMaterial) continue;
      const name = `${mesh.name} ${m.name}`;
      if (/(^|_)glass(\s|$)/.test(name)) roomGlass(m as THREE.MeshStandardMaterial);
      else if (/(^|_)clear(\s|$)/.test(name)) clearGlass(m as THREE.MeshStandardMaterial);
    }
  });
}

/** The probe's views, pixels a side. */
const SIZE = 256;
/** Metres: the probe is drawn only with glass that reads it this near the eye (a glass reads it within 18 m of where it was taken). */
const NEAR = 20;
/** Metres the eye moves before the probe is drawn again (when nothing else changed). */
const MOVED = 1;
/** Seconds after which it is drawn again all the same (the village coming in, the cars, the doors). */
const STALE = 6;
/** Metres of the world's grid that the glass near the eye is looked up in. */
const CELL = 10;

/**
 * The scene all round the eye for the glass to mirror, one of its six views drawn every second frame before the scene
 * (the composer's first pass), out to 500 m (beyond, the haze has the houses; the sky stays: nearer, the far ground and
 * woods gave way to the bright sky in the glass, for hardly any time saved), on Medium and up and while
 * the eye is outdoors (indoors the last one stays). Two cubes: one is read while the other is drawn, and they swap once
 * all six views are new, each set taken from one spot. The eye's own things (the weapon in the hands), the rain and the
 * snow round it, and the small or near things the reflections leave out (world/reflections.ts) are not in it.
 *
 * It is drawn only where it shows and while it changes: with glass that reads it within NEAR metres of the eye, and
 * again once the eye has moved a metre, the light has changed (the mood's blend, the sun) or STALE seconds have gone.
 * On Low it lets go of its cubes (`fine` false); in the split screen (`views` over 1) it is drawn a view every eighth
 * frame. Each set's spot and light are checked at its first view.
 */
export class GlassProbe extends Pass {
  private cubes: THREE.WebGLCubeRenderTarget[] = [];
  private cams = new THREE.CubeCamera(0.3, 500, new THREE.WebGLCubeRenderTarget(1));
  private tick = 0;
  private face = 0;
  private back = 0;
  private at = new THREE.Vector3();
  /** Where and in what light the last whole set was begun, and when (s); NaN for never */
  private drawnAt = new THREE.Vector3(Number.NaN, 0, 0);
  private drawnLight: number[] = [];
  private drawnTime = -Infinity;
  private light: number[] = [];
  private sunDir = new THREE.Vector3();
  private on = true;
  /** The glass that reads the probe, found in the scene now and then, and where each lies on the world's grid */
  private glassFound = -Infinity;
  private glass: THREE.Mesh[] = [];
  private cells = new WeakMap<THREE.Mesh, { shape: THREE.BufferGeometry; cells: Set<number> }>();
  private v = new THREE.Vector3();
  private renderer: THREE.WebGLRenderer | null = null;
  private drawFace = () => this.renderer!.render(this.scene, this.cams.children[this.face] as THREE.Camera);
  /** The sun, whose turn through the day changes what the glass mirrors (main.ts) */
  sun: THREE.Object3D | null = null;
  /** The split screen's views on this chip (src/seat.ts): with more than one, a view every eighth frame */
  views = 1;

  constructor(private scene: THREE.Scene, private camera: THREE.Camera, private hide: THREE.Object3D[]) {
    super();
    this.needsSwap = false;
    this.clear = false;
    this.cams.renderTarget.dispose(); // the cube camera's own: never drawn into, the probe's two cubes are
    for (const c of this.cams.children) reflectionLayers(c.layers, c.layers);
  }

  /** Medium and up, not a phone. Off, the cubes are let go (their memory freed) and made again when it is back on. */
  get fine(): boolean {
    return this.on;
  }

  set fine(on: boolean) {
    if (on === this.on) return;
    this.on = on;
    if (on) return;
    for (const c of this.cubes) c.dispose();
    this.cubes = [];
    glass.probe.value = null;
    glass.probeOn.value = 0;
    this.face = 0;
    this.drawnAt.x = Number.NaN;
  }

  render(renderer: THREE.WebGLRenderer): void {
    glass.night.value = mood.night;
    if (!this.on) {
      glass.probeOn.value = 0;
      return;
    }
    // A view every second frame (every eighth in the split screen).
    if (wetState.indoors || this.tick++ % (this.views > 1 ? 8 : 2)) return;
    if (this.face === 0) {
      this.camera.getWorldPosition(this.at);
      if (!this.due()) return;
    }
    if (!this.cubes.length) this.cubes = [0, 1].map(() => new THREE.WebGLCubeRenderTarget(SIZE, { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter }));
    const cams = this.cams;
    if (cams.coordinateSystem !== renderer.coordinateSystem) {
      cams.coordinateSystem = renderer.coordinateSystem;
      cams.updateCoordinateSystem();
    }
    if (this.face === 0) {
      cams.position.copy(this.at);
      cams.updateMatrixWorld(true);
    }
    const was = renderer.getRenderTarget();
    const wasFace = renderer.getActiveCubeFace();
    const wasLevel = renderer.getActiveMipmapLevel();
    const shadows = renderer.shadowMap.needsUpdate;
    renderer.shadowMap.needsUpdate = false;
    const mirror = wet.mirrorOn.value;
    wet.mirrorOn.value = 0; // the puddles' picture is the eye's, not this view's
    renderer.setRenderTarget(this.cubes[this.back], this.face);
    renderer.clear();
    this.renderer = renderer;
    withoutDetail(this.hide, this.drawFace);
    renderer.setRenderTarget(was, wasFace, wasLevel);
    renderer.shadowMap.needsUpdate = shadows;
    wet.mirrorOn.value = mirror;
    if (++this.face === 6) {
      this.face = 0;
      glass.probe.value = this.cubes[this.back].texture;
      glass.probeAt.value.copy(this.at);
      glass.probeOn.value = 1;
      this.back = 1 - this.back;
    }
  }

  /** At a set's first view: whether one is needed (glass near that reads it, and the eye moved, the light changed or it is old). */
  private due(): boolean {
    const now = performance.now() / 1000;
    const light = this.light;
    light.length = 0;
    light.push(mood.night, mood.wet, mood.overcast, mood.snow, mood.blend);
    if (this.sun) {
      this.sunDir.copy(this.sun.position).normalize();
      light.push(this.sunDir.x, this.sunDir.y, this.sunDir.z);
    }
    const same = glass.probeOn.value === 1 && this.drawnAt.distanceTo(this.at) < MOVED && now - this.drawnTime < STALE
      && light.length === this.drawnLight.length && light.every((v, i) => Math.abs(v - this.drawnLight[i]) < 0.01);
    if (same || !this.glassNear(now)) return false;
    this.drawnAt.copy(this.at);
    this.drawnLight.length = 0;
    this.drawnLight.push(...light);
    this.drawnTime = now;
    return true;
  }

  /** Whether glass that reads the probe lies within NEAR metres of the eye (its corners on a grid of CELL metres). */
  private glassNear(now: number): boolean {
    if (now - this.glassFound > 2) {
      // The scene's glass again every two seconds: tiles, models and the village come and go.
      this.glassFound = now;
      this.glass.length = 0;
      this.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const m = mesh.material;
        if (Array.isArray(m) ? m.some((x) => probeUsers.has(x)) : probeUsers.has(m)) this.glass.push(mesh);
      });
    }
    const ci = Math.floor(this.at.x / CELL);
    const cj = Math.floor(this.at.z / CELL);
    const reach = Math.ceil(NEAR / CELL);
    for (const mesh of this.glass) {
      if (!mesh.visible) continue;
      const cells = this.cellsOf(mesh);
      for (let i = ci - reach; i <= ci + reach; i++) {
        for (let j = cj - reach; j <= cj + reach; j++) {
          if (!cells.has(i * 65536 + j)) continue;
          // The cell's nearest point within NEAR (in plan).
          const dx = Math.max(i * CELL - this.at.x, 0, this.at.x - (i + 1) * CELL);
          const dz = Math.max(j * CELL - this.at.z, 0, this.at.z - (j + 1) * CELL);
          if (dx * dx + dz * dz < NEAR * NEAR) return true;
        }
      }
    }
    return false;
  }

  /** The cells of the grid that a glass mesh's corners lie in, worked out once per mesh and shape (the glass doesn't move). */
  private cellsOf(mesh: THREE.Mesh): Set<number> {
    const known = this.cells.get(mesh);
    if (known?.shape === mesh.geometry) return known.cells;
    const cells = new Set<number>();
    mesh.updateWorldMatrix(true, false);
    const pos = mesh.geometry.getAttribute('position');
    if (pos) {
      for (let k = 0; k < pos.count; k++) {
        this.v.fromBufferAttribute(pos, k).applyMatrix4(mesh.matrixWorld);
        cells.add(Math.floor(this.v.x / CELL) * 65536 + Math.floor(this.v.z / CELL));
      }
    }
    this.cells.set(mesh, { shape: mesh.geometry, cells });
    return cells;
  }

  dispose(): void {
    for (const c of this.cubes) c.dispose();
  }
}
