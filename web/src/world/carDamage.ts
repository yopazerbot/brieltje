import * as THREE from 'three';
import { END_GARDEN, HOMES } from '../../shared/homes.mjs';
import { sound } from '../sound';
import type { Brush, World } from './collision';
import { mood } from './mood';
import { waterLevel } from './water';

/**
 * What a Tesla has been through (world/car.ts), for the look only: it still drives.
 *
 * The damage is eight numbers, one for each side and corner of the car (ZONES: the front, the front right corner, the
 * right side, and so on round), 0 untouched to 1 as hard as it gets, and how muddy it is. A hit adds to the zones next
 * to where it struck, more the faster; scraping along something scratches them a little at a time. Everything shown
 * follows from those nine numbers alone, worked out the same on every page, so another player's car is drawn from the
 * same small list its driver's page sends (main.ts, server/game.mjs `dent`):
 *
 * - dents pushed into the body where it was struck, wider and deeper the harder, crumpled a little (a fixed noise on
 *   the model's own points, so every page crumples it the same); the bonnet buckling up after a hard frontal hit, the
 *   boot lid after a hard one from behind; a bumper corner hanging down after a hard corner hit. The model's own
 *   points are moved (its geometry copied for this car on its first dent), its panel gaps' lines and glass with them;
 *   the cabin is never pushed in (as racing games keep the driver's cell whole);
 * - scratched paint (thin streaks and dull scuffs where the primer shows) and a scraped wheel arch, in the paint's own
 *   shader from the zones, on the model's points: no texture, no extra draw;
 * - a cracked windscreen, side glass or rear window: cracks spreading from where it was struck, more of them the
 *   harder (a crack picture made in code once, laid on the glass from the side it faces);
 * - a headlight or tail light that went out (its half of the light bar dark, its glow at night gone: world/carLights.ts);
 * - steam rising from the bonnet for a while after a very hard frontal hit (world/crash.ts steam);
 * - a slight pull to the side of a hard front corner hit (pull, world/car.ts adds it to the steering);
 * - mud: splashed up the lower body and behind each wheel after driving on wet earth and grass, a little dust when
 *   dry; it washes off in the rain and in deep water, and dries lighter.
 *
 * Mended (dents, glass, lamps) when the car goes through a portal or stands still on its own parking spot again
 * (world/car.ts); the mud stays until the rain washes it.
 */

/** The zones round the car, from the front clockwise seen from above (to the right first). */
export const ZONES = 8;
/** The numbers a car's look is sent as: the zones and the mud, each 0 to 15. */
export const LOOK_LENGTH = ZONES + 1;
const STEP = 15;

const FRONT = 0;
const FRONT_RIGHT = 1;
const RIGHT = 2;
const REAR_RIGHT = 3;
const REAR = 4;
const REAR_LEFT = 5;
const LEFT = 6;
const FRONT_LEFT = 7;

/** How deep a zone's dent gets at its worst (m): the crumple zones front and back, less at the corners, the doors least. */
const DEPTH = [0.3, 0.25, 0.16, 0.25, 0.28, 0.25, 0.16, 0.25];
/** m/s of a hit that only scratches, and the speed that does the most a single hit can. */
const HIT_FROM = 2.5;
const HIT_FULL = 20;
/** s within which the knocks of one crash count as one hit. */
const HIT_ONE = 0.4;
/** A scrape alone scratches a zone this far at most (its dents stay shallow). */
const SCRAPE_MOST = 0.22;
/** The most any point of the body is moved (m). */
const MOST = 0.34;
/** s between two rebuilds of the dented shape (the hits of one crash come together). */
const REBUILD = 0.12;
/** The most points of the model moved in one frame (a rebuild spreads over a few frames: no hitch, phones too). */
const CHUNK = 3000;
/** rad: the most a bent front corner pulls the steering. */
const PULL = 0.006;
/** s of steam after a very hard frontal hit. */
const STEAM = 50;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** A fixed noise from -1 to 1 over the model's points (the crumples), the same on every page. */
function hash(x: number, y: number, z: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
function noise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash(ix + dx, iy + dy, iz + dz);
  const v = l(l(l(c(0, 0, 0), c(1, 0, 0), ux), l(c(0, 1, 0), c(1, 1, 0), ux), uy), l(l(c(0, 0, 1), c(1, 0, 1), ux), l(c(0, 1, 1), c(1, 1, 1), ux), uy), uz);
  return v * 2 - 1;
}

let crackMap: THREE.CanvasTexture | null = null;
/**
 * Cracks in safety glass, drawn in code once: a small crushed star where it was struck, long cracks running out from it
 * and forking, and broken rings round the star. Red is the crack, green how soon it shows (near the star first), so one
 * picture shows a few cracks after a lighter hit and the whole web after a hard one. From a fixed seed.
 */
function crackTexture(): THREE.CanvasTexture {
  if (crackMap) return crackMap;
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const o = S / 2;
  const far = S * 0.62;
  const line = (x0: number, y0: number, x1: number, y1: number, w: number) => {
    const order = Math.max(0.08, 1 - Math.hypot(x0 - o, y0 - o) / far);
    g.strokeStyle = `rgb(255, ${Math.round(255 * order)}, 0)`;
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
  };
  g.lineCap = 'round';
  // A crack: a jagged walk out from (x, y) towards `a`, thinning, now and then forking.
  const crack = (x: number, y: number, a: number, len: number, w: number, depth: number) => {
    let left = len;
    while (left > 0 && x > -10 && x < S + 10 && y > -10 && y < S + 10) {
      const step = 6 + rand() * 10;
      a += (rand() - 0.5) * 0.5;
      const nx = x + Math.cos(a) * step;
      const ny = y + Math.sin(a) * step;
      line(x, y, nx, ny, w);
      x = nx;
      y = ny;
      left -= step;
      w = Math.max(0.7, w * 0.985);
      if (depth > 0 && rand() < 0.06) crack(x, y, a + (rand() < 0.5 ? -1 : 1) * (0.4 + rand() * 0.6), left * (0.3 + rand() * 0.4), w * 0.8, depth - 1);
    }
  };
  // The crushed star: short cracks all round, close together.
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + rand() * 0.3;
    crack(o, o, a, 20 + rand() * 30, 1.6, 0);
  }
  // Its broken rings.
  for (const r of [14, 26, 40]) {
    for (let a = 0; a < Math.PI * 2; a += 0.35 + rand() * 0.3) {
      if (rand() < 0.35) continue;
      const b = a + 0.2 + rand() * 0.25;
      line(o + Math.cos(a) * r, o + Math.sin(a) * r, o + Math.cos(b) * (r + (rand() - 0.5) * 4), o + Math.sin(b) * (r + (rand() - 0.5) * 4), 1.1);
    }
  }
  // The long ones, out to the edges.
  for (let i = 0; i < 9; i++) crack(o, o, (i / 9) * Math.PI * 2 + rand() * 0.5, S * (0.3 + rand() * 0.4), 1.5, 2);
  crackMap = new THREE.CanvasTexture(c);
  crackMap.colorSpace = THREE.NoColorSpace;
  crackMap.wrapS = crackMap.wrapT = THREE.ClampToEdgeWrapping;
  crackMap.anisotropy = 4;
  return crackMap;
}

/** The shared GLSL: the zones' value at a point of the model, and a little noise. */
const COMMON = `
uniform float uDmgZone[8];
uniform vec4 uDmgSize; // half width, half length, the front axle's z, the rear axle's z
varying vec3 vDmgP;
varying vec3 vDmgN;
float dmgHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float dmgNoise( vec2 p ) {
  vec2 i = floor( p ); vec2 f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( dmgHash( i ), dmgHash( i + vec2( 1.0, 0.0 ) ), f.x ), mix( dmgHash( i + vec2( 0.0, 1.0 ) ), dmgHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
// A zone's damage at p: its level, fading with the distance from its middle on the car's outline (wider the worse).
float dmgNear( vec3 p, float k ) {
  int i = int( mod( k + 8.0, 8.0 ) );
  float L = uDmgZone[ i ];
  float a = k * 0.7853982;
  vec2 dir = vec2( sin( a ), - cos( a ) );
  float t = ( mod( k, 2.0 ) > 0.5 ? 0.88 : 1.0 ) * min( uDmgSize.x / max( abs( dir.x ), 1e-4 ), uDmgSize.y / max( abs( dir.y ), 1e-4 ) );
  vec2 d = p.xz - dir * t;
  float R = 0.45 + 0.75 * L;
  return L * exp( - dot( d, d ) / ( R * R ) );
}
float dmgZoneAt( vec3 p ) {
  float k0 = floor( atan( p.x / uDmgSize.x, - p.z / uDmgSize.y ) / 0.7853982 );
  return max( max( dmgNear( p, k0 ), dmgNear( p, k0 + 1.0 ) ), max( dmgNear( p, k0 - 1.0 ), dmgNear( p, k0 + 2.0 ) ) );
}
`;
const VERTEX_COMMON = `#include <common>
varying vec3 vDmgP;
varying vec3 vDmgN;`;
const VERTEX_POS = `#include <begin_vertex>
vDmgP = transformed;
vDmgN = objectNormal;`;

/** The car's damage and mud, its dented shape and what its materials show of it. */
export class CarDamage {
  /** 0 to 1 for each zone (ZONES) */
  readonly level = new Array<number>(ZONES).fill(0);
  /** 0 to 1: how muddy */
  mud = 0;
  /** rad to the right the steering is pulled by a bent front corner (world/car.ts step) */
  pull = 0;
  /** Each lamp lit (1) or out (0): headlights left and right, tail lights left and right (world/carLights.ts) */
  readonly lamps = [1, 1, 1, 1];
  /** s of steam left, and how strong */
  steam = 0;
  private uZone = { value: new Array<number>(ZONES).fill(0) };
  private uSize = { value: new THREE.Vector4() };
  private uMud = { value: new THREE.Vector3() }; // amount, wet, any damage at all
  private uCrack = { value: new THREE.Vector4() }; // front, left, right, rear
  private uFront = { value: new THREE.Vector3(0, 1, -1) }; // the windscreen's middle (where its cracks start: x set per hit)
  private uSide = { value: new THREE.Vector4(-0.3, 1.1, -0.3, 1.1) }; // the left side glass's (z, y), the right's
  private uRear = { value: new THREE.Vector3(0, 1.1, 2) };
  private uHeadOut = { value: new THREE.Vector2(1, 1) };
  private uTailOut = { value: new THREE.Vector2(1, 1) };
  /** The model's parts that dent: each with its shared geometry, this car's own copy once dented, and the normals as made. */
  private parts: { obj: THREE.Mesh | THREE.LineSegments; src: THREE.BufferGeometry; own: THREE.BufferGeometry | null }[] = [];
  /** Where the bonnet ends (the windscreen's foot, z) and the boot lid starts, from the glass. */
  private bonnetEnd = -1;
  private bootFrom = 1.6;
  private dirty = false;
  private since = 0;
  private cracked = [false, false, false, false];
  private lastHit = { at: -Infinity, d: 0 };
  /** The rebuild's pieces still to do, one a frame (update) */
  private todo: (() => void)[] = [];

  /** `halfL`, `halfW`: the car's half length and width (m); `axles`: the front and rear axles' z on the model. */
  constructor(private halfL: number, private halfW: number, axles: [number, number] = [-1.5, 1.4]) {
    this.uSize.value.set(halfW, halfL, axles[0], axles[1]);
  }

  /** Damaged or muddy at all (else the shaders skip their part). */
  get any(): boolean {
    return this.mud > 0.01 || this.level.some((l) => l > 0.01);
  }

  // --- materials ---------------------------------------------------------------------------------------------------

  /** Scratches, scuffed arches and mud in a paint (the fine one and the plain one: both get it). */
  paint(m: THREE.MeshStandardMaterial): void {
    const before = m.onBeforeCompile;
    const key = m.customProgramCacheKey();
    m.onBeforeCompile = (shader, renderer) => {
      before.call(m, shader, renderer);
      Object.assign(shader.uniforms, { uDmgZone: this.uZone, uDmgSize: this.uSize, uDmgMud: this.uMud });
      shader.vertexShader = shader.vertexShader.replace('#include <common>', VERTEX_COMMON).replace('#include <begin_vertex>', VERTEX_POS);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${COMMON}\nuniform vec3 uDmgMud;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
        float dmgScr = 0.0;
        float dmgScuff = 0.0;
        float dmgMud = 0.0;
        if ( uDmgMud.z > 0.5 ) {
          vec3 p = vDmgP;
          vec3 n = normalize( vDmgN );
          float L = dmgZoneAt( p );
          float sideOn = step( abs( n.z ), abs( n.x ) );
          float s = mix( p.x, p.z, sideOn );
          // Where a hit or a scrape reaches: the bumpers', sills' and doors' height, not the roof or the bonnet's top.
          float band = smoothstep( 0.12, 0.32, p.y ) * ( 1.0 - smoothstep( 0.95, 1.2, p.y ) ) * ( 1.0 - smoothstep( 0.55, 0.85, n.y ) );
          if ( L > 0.01 ) {
            // Patches that spread with the damage; in them thin streaks the way it scraped (along the side, across the
            // ends) and duller scuffs, also streaked.
            float cover = smoothstep( 1.0 - L * 1.6, 1.1 - L * 1.6, dmgNoise( vec2( s * 2.1 + 3.1, p.y * 3.7 ) ) );
            float wob = dmgNoise( vec2( s * 1.3, p.y * 2.7 ) );
            float lines = dmgNoise( vec2( s * 0.8 + wob * 0.7, p.y * 62.0 + wob * 3.0 ) );
            dmgScr = smoothstep( 0.84, 0.92, lines ) * cover * band;
            float rub = dmgNoise( vec2( s * 2.5 + wob, p.y * 22.0 ) );
            dmgScuff = cover * band * smoothstep( 0.45, 0.8, rub ) * min( 1.0, L * 2.0 );
            // A wheel arch scraped: a ragged band round the arch over each wheel, on the side.
            float wz = abs( p.z - uDmgSize.z ) < abs( p.z - uDmgSize.w ) ? uDmgSize.z : uDmgSize.w;
            float r = length( vec2( p.z - wz, p.y - 0.36 ) );
            float arch = smoothstep( 0.36, 0.4, r ) * ( 1.0 - smoothstep( 0.46, 0.56, r ) ) * step( 0.3, p.y ) * smoothstep( 0.6, 0.9, abs( n.x ) );
            dmgScuff = max( dmgScuff, arch * smoothstep( 0.06, 0.3, L ) * smoothstep( 0.25, 0.6, dmgNoise( vec2( p.z * 13.0, p.y * 13.0 ) ) ) );
            // The primer and the bare metal show light on a dark paint, dark grey on a light one.
            float lum = dot( diffuseColor.rgb, vec3( 0.3, 0.59, 0.11 ) );
            vec3 under = lum > 0.25 ? vec3( 0.16, 0.16, 0.155 ) : vec3( 0.5, 0.5, 0.48 );
            diffuseColor.rgb = mix( diffuseColor.rgb, under, dmgScuff * 0.3 );
            diffuseColor.rgb = mix( diffuseColor.rgb, under, dmgScr * 0.7 );
          }
          if ( uDmgMud.x > 0.005 ) {
            // Mud: thick along the sills and behind each wheel, its line rising the muddier it gets, ragged, with
            // specks thrown above it; on the tail too.
            float m = uDmgMud.x;
            float edge = p.y + 0.22 * ( dmgNoise( vec2( s * 3.0, p.y * 2.0 ) ) - 0.5 ) + 0.08 * ( dmgNoise( vec2( s * 14.0, p.y * 9.0 ) ) - 0.5 );
            float top = 0.3 + 0.6 * m;
            float low = 1.0 - smoothstep( top - 0.2, top + 0.04, edge );
            float wz = abs( p.z - uDmgSize.z ) < abs( p.z - uDmgSize.w ) ? uDmgSize.z : uDmgSize.w;
            float behind = exp( - pow( ( p.z - wz - 0.55 ) * 2.0, 2.0 ) ) * ( 1.0 - smoothstep( 0.3, 0.6 + 0.5 * m, p.y ) );
            float tail = smoothstep( uDmgSize.y - 0.5, uDmgSize.y, p.z ) * ( 1.0 - smoothstep( 0.35, 0.5 + 0.7 * m, p.y ) );
            // The wheels throw it back: the nose gets less.
            low *= 1.0 - 0.55 * smoothstep( 0.2 - uDmgSize.z, 0.8 - uDmgSize.z, - p.z );
            float specks = smoothstep( 0.8, 0.86, dmgNoise( vec2( s, p.y ) * 70.0 ) ) * ( 1.0 - smoothstep( top - 0.1, top + 0.35, p.y ) ) * smoothstep( 0.1, 0.5, m );
            float film = max( max( low, behind * smoothstep( 0.0, 0.4, m ) ), tail * m );
            float splat = 0.75 + 0.25 * dmgNoise( vec2( s + 7.3, p.y ) * 11.0 );
            dmgMud = clamp( film * splat * min( 1.0, m * 3.0 ) + specks * 0.8, 0.0, 1.0 ) * ( 1.0 - 0.8 * smoothstep( 0.6, 0.9, n.y ) );
            vec3 mudC = mix( vec3( 0.15, 0.125, 0.095 ), vec3( 0.055, 0.042, 0.03 ), uDmgMud.y );
            #ifdef USE_COLOR
            mudC *= vColor.rgb;
            #endif
            diffuseColor.rgb = mix( diffuseColor.rgb, mudC, dmgMud * 0.94 );
          }
        }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix( roughnessFactor, 0.6, max( dmgScr, dmgScuff ) );
        roughnessFactor = mix( roughnessFactor, mix( 0.95, 0.55, uDmgMud.y ), dmgMud );`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor *= 1.0 - max( dmgMud, dmgScr * 0.5 );`)
        .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        #ifdef USE_CLEARCOAT
        material.clearcoat *= 1.0 - max( dmgMud, max( dmgScr, dmgScuff * 0.7 ) );
        #endif`);
    };
    m.customProgramCacheKey = () => `${key}-dmg`;
    m.needsUpdate = true;
  }

  /** Cracks in this car's glass (its own copies of the windscreen's and the dark glass's materials). */
  glass(m: THREE.MeshStandardMaterial): void {
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, { uDmgZone: this.uZone, uDmgSize: this.uSize, uCrack: this.uCrack, uCrackMap: { value: crackTexture() }, uFront: this.uFront, uSide: this.uSide, uRear: this.uRear });
      shader.vertexShader = shader.vertexShader.replace('#include <common>', VERTEX_COMMON).replace('#include <begin_vertex>', VERTEX_POS);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${COMMON}\nuniform vec4 uCrack; uniform sampler2D uCrackMap; uniform vec3 uFront; uniform vec4 uSide; uniform vec3 uRear;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
        float dmgCrack = 0.0;
        if ( uCrack.x + uCrack.y + uCrack.z + uCrack.w > 0.0 ) {
          vec3 p = vDmgP;
          vec3 n = normalize( vDmgN );
          vec2 uv = vec2( 9.0 );
          float amt = 0.0;
          if ( n.y > 0.9 ) amt = 0.0; // the glass roof
          else if ( n.z < -0.35 ) { uv = vec2( p.x - uFront.x, dot( p.yz - uFront.yz, vec2( 0.55, -0.83 ) ) ); amt = uCrack.x; }
          else if ( n.z > 0.35 ) { uv = vec2( uRear.x - p.x, dot( p.yz - uRear.yz, vec2( 0.55, 0.83 ) ) + 0.1 ); amt = uCrack.w; }
          else if ( p.x < 0.0 ) { uv = vec2( p.z - uSide.x, p.y - uSide.y ); amt = uCrack.y; }
          else { uv = vec2( uSide.z - p.z, p.y - uSide.w ); amt = uCrack.z; }
          if ( amt > 0.0 ) {
            vec4 c = texture2D( uCrackMap, uv / 1.4 + 0.5 );
            dmgCrack = c.r * smoothstep( 1.02 - amt, 1.06 - amt, c.g );
            diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.78, 0.8, 0.82 ), dmgCrack * 0.75 );
            diffuseColor.a = max( diffuseColor.a, dmgCrack * 0.9 );
          }
        }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix( roughnessFactor, 0.5, dmgCrack );`);
    };
    m.customProgramCacheKey = () => 'car-glass-dmg';
  }

  /** A lamp's glow out on the side it broke: `tail` the tail lights' material, else the light bar's (the headlights). */
  lamp(m: THREE.MeshStandardMaterial, tail: boolean): void {
    const out = tail ? this.uTailOut : this.uHeadOut;
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uLampOut = out;
      shader.vertexShader = shader.vertexShader.replace('#include <common>', VERTEX_COMMON).replace('#include <begin_vertex>', VERTEX_POS);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vDmgP;\nuniform vec2 uLampOut;`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float lampOn = vDmgP.x < 0.0 ? uLampOut.x : uLampOut.y;
        totalEmissiveRadiance *= lampOn;
        diffuseColor.rgb *= 0.4 + 0.6 * lampOn;`);
    };
    m.customProgramCacheKey = () => 'car-lamp-dmg';
  }

  // --- the model -----------------------------------------------------------------------------------------------------

  /**
   * The model's body (its scene, without the far copy and the wheels): the parts that dent, and where the bonnet ends
   * and the glass is (for the cracks). The cabin's inside and its screen stay as they are.
   */
  attach(scene: THREE.Object3D): void {
    this.parts = [];
    const glass: THREE.Vector3[] = [];
    const glassN: THREE.Vector3[] = [];
    scene.updateMatrixWorld(true);
    scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh || o instanceof THREE.LineSegments)) return;
      const part = o.userData.part as string | undefined;
      if (part === 'Interior' || part === 'Screen') return;
      this.parts.push({ obj: o, src: o.geometry, own: null });
      if ((part === 'Glass' || part === 'GlassDark') && o.geometry.attributes.normal) {
        const p = o.geometry.attributes.position;
        const n = o.geometry.attributes.normal;
        for (let i = 0; i < p.count; i++) {
          glass.push(new THREE.Vector3().fromBufferAttribute(p, i));
          glassN.push(new THREE.Vector3().fromBufferAttribute(n, i));
        }
      }
    });
    const mean = (pick: (n: THREE.Vector3, p: THREE.Vector3) => boolean) => {
      const m = new THREE.Vector3();
      let k = 0;
      glass.forEach((p, i) => {
        if (pick(glassN[i], p)) {
          m.add(p);
          k++;
        }
      });
      return k ? m.divideScalar(k) : null;
    };
    const front = mean((n) => n.z < -0.35 && n.y < 0.9);
    const rear = mean((n) => n.z > 0.35 && n.y < 0.9);
    const left = mean((n, p) => Math.abs(n.z) <= 0.35 && n.y < 0.9 && p.x < 0);
    const right = mean((n, p) => Math.abs(n.z) <= 0.35 && n.y < 0.9 && p.x > 0);
    if (front) {
      this.uFront.value.copy(front);
      this.bonnetEnd = Math.min(...glass.filter((_, i) => glassN[i].z < -0.35 && glassN[i].y < 0.9).map((p) => p.z)) - 0.05;
    }
    if (rear) {
      this.uRear.value.copy(rear);
      this.bootFrom = Math.max(...glass.filter((_, i) => glassN[i].z > 0.35 && glassN[i].y < 0.9).map((p) => p.z)) - 0.1;
    }
    if (left) this.uSide.value.setX(left.z).setY(left.y);
    if (right) this.uSide.value.setZ(right.z).setW(right.y);
    this.dirty = this.level.some((l) => l > 0);
  }

  // --- what happens to it ---------------------------------------------------------------------------------------------

  /** The zone at a point of the car's outline (x right, z back on the model) and its share of the next one. */
  private zoneAt(x: number, z: number): [number, number, number] {
    let k = Math.atan2(x / this.halfW, -z / this.halfL) / (Math.PI / 4);
    if (k < 0) k += ZONES;
    const k0 = Math.floor(k) % ZONES;
    return [k0, (k0 + 1) % ZONES, k - Math.floor(k)];
  }

  /**
   * A hit at (x, z) on the car (the model's frame: x right, z back) at `speed` m/s, times `scale` (what it hit: a
   * hedge only scratches). Returns how much it added.
   */
  hit(x: number, z: number, speed: number, scale = 1, most = 1): number {
    let d = Math.min(1, Math.max(0, (speed - HIT_FROM) / (HIT_FULL - HIT_FROM))) * scale;
    // The frames of one crash (and the knocks of a car held against a wall) are one hit: within HIT_ONE s only what
    // goes beyond the hardest so far counts.
    const now = performance.now() / 1000;
    if (now - this.lastHit.at < HIT_ONE) {
      const more = d - this.lastHit.d;
      if (more <= 0) return 0;
      this.lastHit.d = d;
      d = more;
    } else this.lastHit = { at: now, d };
    if (!(d > 0.002)) return 0;
    const [a, b, f] = this.zoneAt(x, z);
    for (const [k, w] of [[a, 1 - f], [b, f]] as const) {
      const before = this.level[k];
      if (before >= most) continue;
      this.level[k] = Math.min(most, 1 - (1 - before) * (1 - d * w));
    }
    // A very hard frontal hit: steam from under the bonnet.
    if (speed > 14 * Math.max(1, 1 / scale) && this.frontLevel() > 0.7) this.steam = STEAM;
    this.changed();
    return d;
  }

  /** Scraping along something at (x, z) for `dt` s at `speed` m/s (the paint, not the shape). */
  scrape(x: number, z: number, speed: number, dt: number, scale = 1): void {
    if (speed < 1) return;
    const [a, b, f] = this.zoneAt(x, z);
    const add = 0.03 * scale * Math.min(2, speed / 8) * dt;
    let grew = false;
    for (const [k, w] of [[a, 1 - f], [b, f]] as const) {
      if (this.level[k] >= SCRAPE_MOST) continue;
      this.level[k] = Math.min(SCRAPE_MOST, this.level[k] + add * w);
      grew = true;
    }
    if (grew) this.changed(false);
  }

  /** Mud on (`k` > 0) or washed off (`k` < 0), 0 to 1. */
  muddy(k: number): void {
    const was = this.mud;
    this.mud = Math.min(1, Math.max(0, this.mud + k));
    if (this.mud !== was) this.uMud.value.x = this.mud;
    this.uMud.value.z = this.any ? 1 : 0;
  }

  /** How wet the world is now (world/mood.ts wet): wet mud is darker and glossier, dry mud pale and matt. */
  wet(w: number): void {
    this.uMud.value.y = w;
  }

  /** The axles' z on the model, once its wheels are found (the arches and the mud behind the wheels). */
  axles(front: number, rear: number): void {
    this.uSize.value.z = front;
    this.uSize.value.w = rear;
  }

  /** Mended: dents, scratches, glass and lamps as new (the mud stays). */
  repair(): void {
    if (!this.level.some((l) => l > 0) && !this.steam) return;
    this.level.fill(0);
    this.steam = 0;
    this.changed();
  }

  /** The look in nine whole numbers 0 to 15 (the zones, the mud), as the server takes and passes it on. */
  pack(): number[] {
    return [...this.level.map((l) => Math.round(l * STEP)), Math.round(this.mud * STEP)];
  }

  /** The look as another page sent it (pack): drawn the same. `fresh`: just joined (no crack sound, steam only if bad). */
  unpack(a: unknown, fresh = false): void {
    if (!Array.isArray(a) || a.length !== LOOK_LENGTH || !a.every((v) => Number.isInteger(v) && v >= 0 && v <= STEP)) return;
    const front = this.frontLevel();
    let moved = false;
    for (let k = 0; k < ZONES; k++) {
      const l = a[k] / STEP;
      if (Math.abs(l - this.level[k]) > 0.5 / STEP) {
        this.level[k] = l;
        moved = true;
      }
    }
    this.muddy(a[ZONES] / STEP - this.mud);
    if (!moved) return;
    const now = this.frontLevel();
    if (now > 0.7 && front <= 0.7) this.steam = fresh ? STEAM * 0.3 : STEAM;
    if (now < 0.7) this.steam = 0;
    this.changed(true, fresh);
  }

  /** How bad the front is: its own zone, or a corner a little less. */
  private frontLevel(): number {
    return Math.max(this.level[FRONT], 0.8 * Math.max(this.level[FRONT_LEFT], this.level[FRONT_RIGHT]));
  }

  /** The zones changed: the shaders' numbers, the glass, the lamps, the pull; the shape (`shape`) rebuilt soon. */
  private changed(shape = true, quiet = false): void {
    const l = this.level;
    for (let k = 0; k < ZONES; k++) this.uZone.value[k] = l[k];
    this.uMud.value.z = this.any ? 1 : 0;
    const crack = [
      smooth(0.42, 0.95, this.frontLevel()),
      smooth(0.5, 1, Math.max(l[LEFT], 0.7 * Math.max(l[FRONT_LEFT], l[REAR_LEFT]))),
      smooth(0.5, 1, Math.max(l[RIGHT], 0.7 * Math.max(l[FRONT_RIGHT], l[REAR_RIGHT]))),
      smooth(0.45, 0.95, Math.max(l[REAR], 0.8 * Math.max(l[REAR_LEFT], l[REAR_RIGHT]))),
    ];
    // The windscreen's cracks start towards the corner that was struck.
    this.uFront.value.x = 0.35 * (smooth(0.1, 0.6, l[FRONT_RIGHT]) - smooth(0.1, 0.6, l[FRONT_LEFT])) * this.halfW;
    this.uCrack.value.set(crack[0], crack[1], crack[2], crack[3]);
    for (let i = 0; i < 4; i++) {
      const now = crack[i] > 0;
      if (now && !this.cracked[i] && !quiet) this.crackSound = true;
      this.cracked[i] = now;
    }
    this.lamps[0] = l[FRONT_LEFT] > 0.5 || l[FRONT] > 0.8 ? 0 : 1;
    this.lamps[1] = l[FRONT_RIGHT] > 0.5 || l[FRONT] > 0.8 ? 0 : 1;
    this.lamps[2] = l[REAR_LEFT] > 0.5 || l[REAR] > 0.8 ? 0 : 1;
    this.lamps[3] = l[REAR_RIGHT] > 0.5 || l[REAR] > 0.8 ? 0 : 1;
    this.uHeadOut.value.set(this.lamps[0], this.lamps[1]);
    this.uTailOut.value.set(this.lamps[2], this.lamps[3]);
    this.pull = PULL * (smooth(0.4, 1, l[FRONT_RIGHT]) - smooth(0.4, 1, l[FRONT_LEFT]));
    if (shape) this.dirty = true;
  }

  /** A pane cracked since the last frame (world/car.ts plays the sound). */
  crackSound = false;

  /**
   * Every frame the car is drawn: the dented shape rebuilt when it changed (at most every REBUILD s), and how much
   * steam to show (0 none to 1): it thins out over its time.
   */
  update(dt: number): number {
    this.since += dt;
    if (this.dirty && this.since >= REBUILD && this.parts.length) {
      this.dirty = false;
      this.since = 0;
      this.reshape();
    }
    // A piece of the work a frame (at most CHUNK points): a crash's dents come in over a few frames, no hitch.
    this.todo.shift()?.();
    if (this.steam > 0) this.steam = Math.max(0, this.steam - dt);
    return this.steam > 0 ? Math.min(1, this.steam / (STEAM * 0.5)) : 0;
  }

  // --- the dented shape ----------------------------------------------------------------------------------------------

  /** Every part's points moved by the zones (from the model's own points each time), or put back as made. */
  private reshape(): void {
    const l = this.level;
    const clean = !l.some((v) => v > 0.005);
    this.todo = [];
    if (clean) {
      for (const p of this.parts) {
        if (!p.own) continue;
        p.obj.geometry = p.src;
        p.own.dispose();
        p.own = null;
      }
      return;
    }
    // The zones' middles on the outline (a little in from the box's edge) and the way they push.
    const hw = this.halfW * 0.97;
    const hl = this.halfL * 0.98;
    const centres = l.map((level, k) => {
      const a = (k * Math.PI) / 4;
      const sx = Math.sin(a);
      const sz = -Math.cos(a);
      // (A corner's middle a little in from the box's corner: the body is rounded there.)
      const t = (k % 2 ? 0.88 : 1) * Math.min(Math.abs(sx) > 1e-6 ? hw / Math.abs(sx) : Infinity, Math.abs(sz) > 1e-6 ? hl / Math.abs(sz) : Infinity);
      const len = Math.hypot(sx, sz);
      return { level, x: sx * t, z: sz * t, y: k % 4 === 2 ? 0.68 : 0.55, nx: -sx / len, nz: -sz / len, depth: DEPTH[k], r: 0.55 + 0.5 * level };
    }).filter((c) => c.level > 0.005);
    const fr = smooth(0.45, 1, this.frontLevel());
    const rr = smooth(0.45, 1, Math.max(l[REAR], 0.8 * Math.max(l[REAR_LEFT], l[REAR_RIGHT])));
    const hang = [
      { s: smooth(0.55, 0.95, l[FRONT_LEFT]), side: -1, front: true },
      { s: smooth(0.55, 0.95, l[FRONT_RIGHT]), side: 1, front: true },
      { s: smooth(0.55, 0.95, l[REAR_LEFT]), side: -1, front: false },
      { s: smooth(0.55, 0.95, l[REAR_RIGHT]), side: 1, front: false },
    ].filter((h) => h.s > 0);
    const nose = -this.halfL;
    const bonnet = this.bonnetEnd;
    const boot = this.bootFrom;
    const move = (x: number, y: number, z: number, out: Float32Array, o: number) => {
      let dx = 0, dy = 0, dz = 0;
      // Folds about 30 cm apart, as sheet metal crumples (finer reads as ripples in the paint's mirror); worked out only
      // for a point something moves.
      let fold = NaN;
      const crumpled = () => (Number.isNaN(fold) ? (fold = 0.7 * noise3(x * 3.4, y * 3.9, z * 3.4) + 0.3 * noise3(x * 7.1 + 5, y * 7.1, z * 7.1)) : fold);
      for (const c of centres) {
        // Below the shoulder line the full dent, fading fast above it: the glass and the roof stay nearly as they were.
        const ex = x - c.x, ey = (y - c.y) * (y > c.y ? 2.1 : 1.3), ez = z - c.z;
        const d2 = (ex * ex + ey * ey + ez * ez) / (c.r * c.r);
        if (d2 > 4) continue;
        const depth = c.depth * c.level * Math.exp(-1.6 * d2) * (1 + 0.45 * crumpled() * Math.min(1, c.level * 1.6));
        dx += c.nx * depth;
        dz += c.nz * depth;
        dy -= 0.08 * depth * Math.tanh((y - c.y) * 6); // the metal folds towards the hit's height
      }
      // The bonnet buckling up in a ridge across it, the boot lid as well.
      if (fr > 0 && y > 0.7 && z < bonnet) {
        const t = Math.min(1, Math.max(0, (z - nose) / (bonnet - nose)));
        dy += 0.09 * fr * Math.sin(Math.PI * Math.pow(t, 0.8)) * (1 - 0.45 * Math.abs(x) / this.halfW) * (0.75 + 0.35 * crumpled());
      }
      if (rr > 0 && y > 0.7 && z > boot) {
        const t = Math.min(1, Math.max(0, (this.halfL - z) / (this.halfL - boot)));
        dy += 0.06 * rr * Math.sin(Math.PI * t) * (1 - 0.45 * Math.abs(x) / this.halfW) * (0.75 + 0.35 * crumpled());
      }
      // A bumper's corner hanging down, more towards its end, and a little out.
      for (const h of hang) {
        const inBumper = h.front ? z < -this.halfL + 0.5 : z > this.halfL - 0.5;
        if (!inBumper || y > 0.62) continue;
        const u = Math.pow(Math.max(0, (h.side * x) / this.halfW), 1.5);
        dy -= 0.11 * h.s * u * (1 - Math.max(0, y - 0.3) * 1.2);
        dz += (h.front ? -1 : 1) * 0.04 * h.s * u;
      }
      const m = Math.hypot(dx, dy, dz);
      const k = m > MOST ? MOST / m : 1;
      out[o] = x + dx * k;
      out[o + 1] = y + dy * k;
      out[o + 2] = z + dz * k;
    };
    // A part nothing reaches (its box clear of every dent's reach and of the bonnet, the boot lid and the bumpers'
    // ends where they move) keeps the model's own shape: no copy, no work.
    const reaches = (b: THREE.Box3) =>
      centres.some((c) => b.distanceToPoint(new THREE.Vector3(c.x, c.y, c.z)) < 2 * c.r) ||
      (fr > 0 && b.max.y > 0.7 && b.min.z < bonnet) || (rr > 0 && b.max.y > 0.7 && b.max.z > boot) ||
      hang.some((h) => b.min.y < 0.62 && (h.front ? b.min.z < -this.halfL + 0.5 : b.max.z > this.halfL - 0.5));
    for (const p of this.parts) {
      const src = p.src.attributes.position as THREE.BufferAttribute;
      if (!p.src.boundingBox) p.src.computeBoundingBox();
      if (!reaches(p.src.boundingBox!)) {
        this.todo.push(() => {
          if (!p.own) return;
          p.obj.geometry = p.src;
          p.own.dispose();
          p.own = null;
        });
        continue;
      }
      // Its points in pieces of CHUNK, its normals with the last; drawn once it is whole (a copy until then).
      const a = src.array as Float32Array;
      const next = p.own?.clone() ?? p.src.clone();
      const out = next.attributes.position.array as Float32Array;
      for (let from = 0; from < src.count; from += CHUNK) {
        const to = Math.min(src.count, from + CHUNK);
        this.todo.push(() => {
          for (let i = from; i < to; i++) move(a[i * 3], a[i * 3 + 1], a[i * 3 + 2], out, i * 3);
          if (to < src.count) return;
          if (p.obj instanceof THREE.Mesh && p.src.attributes.normal) this.renormal(p.src, next);
          p.own?.dispose();
          p.own = next;
          p.obj.geometry = next;
        });
      }
    }
  }

  /**
   * The normals of a dented part: the model's own, turned as much as the dents turn the surface (the normals worked
   * out from the dented points, less those worked out from the points as made), so the smooth and the sharp edges the
   * model has stay as they were where nothing moved.
   */
  private renormal(src: THREE.BufferGeometry, own: THREE.BufferGeometry): void {
    const made = madeNormals(src);
    const tmp = new THREE.BufferGeometry();
    tmp.setAttribute('position', own.attributes.position);
    if (src.index) tmp.setIndex(src.index);
    tmp.computeVertexNormals();
    const now = tmp.attributes.normal.array as Float32Array;
    const orig = src.attributes.normal.array as Float32Array;
    const n = own.attributes.normal as THREE.BufferAttribute;
    const out = n.array as Float32Array;
    for (let i = 0; i < out.length; i += 3) {
      const x = orig[i] + now[i] - made[i];
      const y = orig[i + 1] + now[i + 1] - made[i + 1];
      const z = orig[i + 2] + now[i + 2] - made[i + 2];
      const len = Math.hypot(x, y, z) || 1;
      out[i] = x / len;
      out[i + 1] = y / len;
      out[i + 2] = z / len;
    }
    n.needsUpdate = true;
    tmp.deleteAttribute('normal');
  }

  /** This car's dented copies let go (it is taken away). */
  dispose(): void {
    this.todo = [];
    for (const p of this.parts) {
      if (p.own) {
        p.obj.geometry = p.src;
        p.own.dispose();
      }
    }
    this.parts = [];
  }
}

/** The normals worked out from a shared geometry's points as made, once per geometry. */
const made = new WeakMap<THREE.BufferGeometry, Float32Array>();
function madeNormals(src: THREE.BufferGeometry): Float32Array {
  let n = made.get(src);
  if (n) return n;
  const tmp = new THREE.BufferGeometry();
  tmp.setAttribute('position', src.attributes.position);
  if (src.index) tmp.setIndex(src.index);
  tmp.computeVertexNormals();
  n = tmp.attributes.normal.array as Float32Array;
  made.set(src, n);
  return n;
}

/** A pane of a car's glass cracking (world/car.ts, on a hit): a sharp tick and a short high ring, made in code. */
export function crackSound(x: number, y: number, z: number): void {
  const c = sound.context();
  const at = sound.at(x, y, z, 3);
  if (!c || !at) return;
  const t = c.currentTime;
  const o = c.createOscillator();
  o.type = 'triangle';
  o.frequency.setValueAtTime(5200 + Math.random() * 1500, t);
  o.frequency.exponentialRampToValueAtTime(3600, t + 0.12);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.12, t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  o.connect(g).connect(at);
  o.start(t);
  o.stop(t + 0.2);
  // The crackle as it spreads: a few clicks.
  for (let i = 0; i < 5; i++) {
    const k = c.createOscillator();
    k.type = 'square';
    k.frequency.value = 2500 + Math.random() * 3000;
    const kg = c.createGain();
    const at2 = t + 0.02 + Math.random() * 0.12;
    kg.gain.setValueAtTime(0.0001, at2);
    kg.gain.exponentialRampToValueAtTime(0.04, at2 + 0.002);
    kg.gain.exponentialRampToValueAtTime(0.0001, at2 + 0.012);
    k.connect(kg).connect(at);
    k.start(at2);
    k.stop(at2 + 0.02);
  }
}

// --- Hedges, water and mud: how the world gives way to the car, and what it leaves on it --------------------------------

/** m: a hedge thinner than this the car pushes through; a thicker one holds it once it is THICK_IN in. */
const THICK = 1.1;
const THICK_IN = 0.45;
/** m/s2 a hedge holds the car back: BRUSH_A, and BRUSH_B more for each m/s it goes, times how much of the car is in it. */
const BRUSH_A = 3.5;
const BRUSH_B = 1.4;
/** m round a code-locked home and the end house's garden where the hedges stay walls: no way into a home's garden. */
const HOME_MARGIN = 25;
/** Water: m deep at the car's middle where it starts to hold it, where it holds it fully, and where it drowns the motor. */
const WADE_FROM = 0.03;
const WADE_FULL = 0.35;
const DROWN = 0.55;
/** The water's hold: per m/s and per (m/s)2 of speed, and the most (m/s2). */
const WADE_A = 2;
const WADE_B = 0.15;
const WADE_MOST = 25;
/** s the motor runs on once the water reaches it, s it is dead, and the share of power it limps on after. */
const DROWN_RUN = 0.5;
const DROWN_DEAD = 3;
const LIMP = 0.3;
/** ms between two looks sent (server/game.mjs `dent` takes one a little more often). */
const LOOK_EVERY = 1200;
/** s standing still on its own parking spot before it is mended. */
const PARK_MEND = 2;

const ringBox = (ring: [number, number][]) => [Math.min(...ring.map((p) => p[0])), Math.min(...ring.map((p) => p[1])), Math.max(...ring.map((p) => p[0])), Math.max(...ring.map((p) => p[1]))];
const homeBoxes = [...HOMES.map((h) => h.box), ringBox(END_GARDEN.ring as [number, number][])].map((b) => [b[0] - HOME_MARGIN, b[1] - HOME_MARGIN, b[2] + HOME_MARGIN, b[3] + HOME_MARGIN]);
/** Within HOME_MARGIN of a code-locked home (shared/homes.mjs) or the end house's garden. */
export function nearHome(x: number, z: number): boolean {
  return homeBoxes.some((b) => x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]);
}
const isHedge = (b: Brush) => !!b.mat && /hedge/.test(b.mat);
/** How hard it rains now (0 to 1), as world/water.ts reads it. */
const raining = () => (mood.current === 'rain' ? 1 - mood.blend : 0) + (mood.next === 'rain' && mood.next !== mood.current ? mood.blend : 0);

/**
 * A Tesla's wear (world/car.ts): its damage (CarDamage), and how the world gives way to it.
 *
 * - A hedge is no wall: the car pushes into it (World.boxFree `give`), held back hard the more of it is in and the
 *   faster it goes, leaves and twigs flying and a rustle; a thin hedge it pushes through at a crawl, a thick one holds
 *   it THICK_IN in. Only scratches, no dents. The hedges round a code-locked home and the end house's garden stay
 *   walls (nearHome), so no car ends up in a home's garden or where the server would put it back. Walls, houses,
 *   fences, posts, trunks and other cars stop it as before (a fence and a young tree give a little: no bounce back).
 * - Water (world/water.ts): in a pond or a ditch it is held back hard, more the deeper (a bow wave and spray), and its
 *   tyres grip half as well; where it reaches the motor (DROWN) the motor dies for a few seconds and then limps on at a
 *   fifth of its power, so a car is never stuck for good in a pond: it crawls out up the bank.
 * - Mud from wet earth and grass, dust when dry; washed off by the rain and in deep water.
 */
export class CarWear {
  readonly damage: CarDamage;
  /** m of water at the car's middle (0 on dry ground), and the water's surface there */
  wade = 0;
  level = 0;
  /** The share of its motor's power it has: 1, then less and none as water drowns it, then a limp */
  motor = 1;
  /** How much of the car is in a hedge (0 none, 0.3 a corner, 1 all of it) */
  brush = 0;
  /** A thick hedge gave in the last test (World.boxFree with `give`): held asks the shorter box */
  sawThick = false;
  /** m/s it slid along something hard this frame (the scrape's sound) */
  scrape = 0;
  private drown = 0;
  private met: Brush[] = [];
  private leafT = 0;
  private waveT = 0;
  private wasWet = false;
  private parkT = 0;
  private sent = new Array(LOOK_LENGTH).fill(0).join();
  private sentAt = -Infinity;

  constructor(halfL: number, halfW: number) {
    this.damage = new CarDamage(halfL, halfW);
  }

  /** A block the car may push into (World.boxFree `give`): a hedge, not by a code-locked home. */
  readonly give = (b: Brush): boolean => {
    if (!isHedge(b) || nearHome(b.cx, b.cz)) return false;
    if (b.thick >= THICK) this.sawThick = true;
    return true;
  };
  /** Everything but a thick hedge, for the shorter box (held). */
  private readonly notThick = (b: Brush): boolean => !(isHedge(b) && b.thick >= THICK);

  /** After a free test with `give`: whether a thick hedge holds the car at (x, z, yaw), its box THICK_IN shorter. */
  held(world: World, x: number, z: number, yaw: number, halfL: number, halfW: number, y0: number, y1: number, skip: string): boolean {
    if (!this.sawThick) return false;
    this.sawThick = false;
    return !world.boxFree(x, z, yaw, halfL - THICK_IN, halfW - THICK_IN * 0.6, y0, y1, skip, this.notThick);
  }

  /** Where it stands (x, z, yaw): how much of it is in a hedge, from nine points over its box. */
  brushAt(world: World, x: number, z: number, yaw: number, halfL: number, halfW: number, y0: number, y1: number, skip: string): number {
    this.met.length = 0;
    world.boxFree(x, z, yaw, halfL, halfW, y0, y1, skip, this.give, this.met);
    this.sawThick = false;
    if (!this.met.length) return (this.brush = 0);
    // Along its middle and both sides, every 40 cm: each line the hedge crosses counts a third (a corner, only grazed).
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    let n = 0;
    for (const b of [-0.85, 0, 0.85]) {
      for (let a = -halfL; a <= halfL; a += 0.4) {
        const px = x + fx * a - fz * halfW * b;
        const pz = z + fz * a + fx * halfW * b;
        if (this.met.some((m) => m.has(px, pz))) {
          n++;
          break;
        }
      }
    }
    return (this.brush = 0.3 + (0.7 * n) / 3);
  }

  /** The speed (m/s) it keeps after `dt` s held back by the hedge it is in and by the water it is in. */
  holdBack(v: number, dt: number): number {
    if (this.brush > 0) v = Math.max(0, v - (BRUSH_A + BRUSH_B * v) * this.brush * dt);
    if (this.wade > WADE_FROM) v = Math.max(0, v - Math.min(WADE_MOST, (WADE_A * v + WADE_B * v * v) * Math.min(1, this.wade / WADE_FULL)) * dt);
    return v;
  }

  /**
   * The water under its four wheels (each [x, z]; `ground` the ground's height there, asked only over water), `dt` s
   * on: how deep it is under them on average (a narrow ditch under one axle counts half), and (`drives`) what it leaves
   * the motor.
   */
  water(wheels: [number, number][], ground: (x: number, z: number) => number, dt: number, drives = true): void {
    let depth = 0;
    let level: number | null = null;
    for (const [x, z] of wheels) {
      const l = waterLevel(x, z);
      if (l === null) continue;
      depth += Math.max(0, l - ground(x, z)) / wheels.length;
      level = Math.max(level ?? -Infinity, l);
    }
    this.level = level ?? 0;
    this.wade = depth;
    if (!drives) return;
    if (this.wade > DROWN) this.drown += dt;
    else if (this.wade < DROWN - 0.15) this.drown = 0;
    const d = this.drown;
    this.motor = d <= 0 ? 1 : d < DROWN_RUN ? 1 - d / DROWN_RUN : d < DROWN_RUN + DROWN_DEAD ? 0 : LIMP;
  }

  /** The share of their grip the tyres keep in the water. */
  get gripKept(): number {
    return this.wade > WADE_FROM ? 1 - 0.5 * Math.min(1, this.wade / WADE_FULL) : 1;
  }

  /** The motor dead in the water (its whine stops). */
  get dead(): boolean {
    return this.motor < 0.05;
  }

  /** `dt` s with `rough` of its wheels (0 to 4) off the paving at `speed` m/s: mud on, or washed off. */
  soil(dt: number, rough: number, speed: number): void {
    let k = 0;
    if (rough > 0 && speed > 1.5) k += (rough / 4) * Math.min(1.5, speed / 8) * (0.004 + 0.03 * mood.wet);
    if (this.wade > 0.05 && this.wade < 0.4 && speed > 1) k += 0.012 * Math.min(1.5, speed / 5); // a ditch's muddy water
    if (this.wade >= 0.4) k -= 0.06;
    k -= 0.005 * raining() * (1 + speed / 12);
    if (k) this.damage.muddy(k * dt);
  }

  /** `dt` s at the wheel, `home`: standing still on its own parking spot. There for PARK_MEND s, it is mended. */
  parked(dt: number, home: boolean): void {
    this.parkT = home ? this.parkT + dt : 0;
    if (this.parkT > PARK_MEND) this.damage.repair();
  }

  /** Leaves to throw from the hedge it is in this frame (`dt` s at `speed` m/s): a burst now and then, more the faster. */
  leaves(dt: number, speed: number): boolean {
    if (!this.brush || speed < 0.4) return false;
    this.leafT += dt * (2 + 10 * Math.min(1, speed / 8)) * this.brush;
    if (this.leafT < 1) return false;
    this.leafT = 0;
    return true;
  }

  /** The water this frame: 'in' as it goes in at speed, 'wave' for a bow wave now and then while it moves, else null. */
  splash(dt: number, speed: number): 'in' | 'wave' | null {
    const wet = this.wade > 0.08;
    const was = this.wasWet;
    this.wasWet = wet;
    if (!wet) return null;
    if (!was && speed > 2) return 'in';
    if (speed < 1) return null;
    this.waveT += dt * (3 + 9 * Math.min(1, speed / 8));
    if (this.waveT < 1) return null;
    this.waveT = 0;
    return 'wave';
  }

  /** Its look to send when it changed and LOOK_EVERY ms have passed since the last (main.ts), else null. */
  toSend(now: number): number[] | null {
    if (now - this.sentAt < LOOK_EVERY) return null;
    const look = this.damage.pack();
    const text = look.join();
    if (text === this.sent) return null;
    this.sent = text;
    this.sentAt = now;
    return look;
  }

  /** The server holds `look` for this car: sent again only when it changes. */
  heard(look: unknown): void {
    if (Array.isArray(look) && look.length === LOOK_LENGTH) this.sent = look.join();
  }
}
