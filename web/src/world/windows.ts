import * as THREE from 'three';
import { probeOn, usesProbe } from './glassLook';

/**
 * The glass of the village's own windows (the open-data houses; world/surroundings.ts builds the
 * frames): double glazing that mirrors the sky, with what hangs behind it.
 *
 * Two panes reflect about three times what one surface does, so the glass mirrors the sky far more
 * than plain glass would, over a dark room. No two panes in a street stand quite flat or quite in
 * line: each window leans by its own fraction of a degree and bows a little (its normals, set on the
 * processor), so neighbouring windows show different bits of sky, and each has its own gloss.
 *
 * Behind the glass, about two in three windows have something: net curtains (full or the lower half,
 * the Flemish way), curtains drawn to the sides (with or without nets between), venetian blinds or a
 * roller blind halfway down, each in a plausible colour. The windows of one house and floor mostly
 * agree, as one household's would, with the odd window that doesn't. The coverings are eight cells of
 * one small picture painted at load time (no file); per window its cell, colour, gloss and reflectance
 * come with its corners, so all of it stays one draw call.
 *
 * Behind the coverings is a room: a box a few metres deep, wider than the window, its floor a sill below
 * it, worked out per pixel of glass from the view ray (interior mapping: no geometry, so it costs only
 * where glass is drawn). Each room has its own depth, walls, floor, a cabinet or sofa, a picture, a door,
 * and about one in ten its curtains closed, all from one number per window. Low and phones get a flat
 * back wall in the room's colour instead. At night (setWindowNight) about half the rooms light up warm.
 */

/** The atlas: 4 by 2 cells of CELL pixels, each a covering seen from outside. */
const CELL = 128;
/** Cells (see paint()): what hangs behind a window. */
export const COVER = { none: 0, drapes: 1, nets: 2, halfNets: 3, venetian: 4, roller: 5, drapesNets: 6, drawn: 7 } as const;

/**
 * One covering, u across the window (0 left), v up it (0 at the sill). Returns coloured cloth (curtains,
 * blinds: tinted per window), white sheer (nets) and the light on the cloth (folds, slats).
 */
function paint(cell: number, u: number, v: number): [number, number, number] {
  const pleats = (x: number, n: number) => 0.62 + 0.38 * (0.5 + 0.5 * Math.cos(x * Math.PI * 2 * n));
  const drape = (x: number, width: number) => (x < width ? pleats(x / width, 3.2) : -1); // a curtain hanging at the left edge
  const net = (x: number) => 0.78 + 0.22 * Math.cos(x * Math.PI * 2 * 22); // fine gathers
  const hem = (x: number, top: number) => top + 0.02 * Math.abs(Math.sin(x * Math.PI * 7)); // a scalloped edge
  const side = (width: number): number => Math.max(drape(u, width), drape(1 - u, width));
  switch (cell) {
    case COVER.drapes: {
      const f = side(0.2 + 0.03 * Math.sin(v * 5));
      return f >= 0 || v > 0.93 ? [1, 0, f >= 0 ? f : 0.8] : [0, 0, 1];
    }
    case COVER.nets:
      return v > hem(u, 0.05) ? [0, 0.82, net(u)] : [0, 0, 1];
    case COVER.halfNets:
      return v < 0.5 && v > 0.03 ? [0, 0.85, net(u)] : [0, 0, 1];
    case COVER.venetian: {
      const s = (v * 15) % 1; // slats, slightly open: a dark gap between each
      return s > 0.22 ? [1, 0, 0.55 + 0.45 * ((s - 0.22) / 0.78)] : [0, 0, 1];
    }
    case COVER.roller:
      if (v > 0.5) return [1, 0, 0.92 + 0.08 * Math.sin(v * 40)];
      return v > 0.47 ? [1, 0, 0.45] : [0, 0, 1]; // the bar along its bottom
    case COVER.drapesNets: {
      const f = side(0.18);
      return f >= 0 ? [1, 0, f] : v > hem(u, 0.04) ? [0, 0.75, net(u)] : [0, 0, 1];
    }
    case COVER.drawn: {
      // One curtain drawn far across, the other back at its edge; nets between.
      const f = Math.max(drape(u, 0.42), drape(1 - u, 0.14));
      return f >= 0 ? [1, 0, f] : [0, 0.7, net(u)];
    }
    default:
      return [0, 0, 1];
  }
}

let atlas: THREE.CanvasTexture | null = null;
/** The eight coverings, painted once. */
function coverings(): THREE.CanvasTexture {
  if (atlas) return atlas;
  const c = document.createElement('canvas');
  c.width = CELL * 4;
  c.height = CELL * 2;
  const g = c.getContext('2d')!;
  const img = g.createImageData(c.width, c.height);
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      // Cell k sits at column k % 4 and row k / 4 counted from the bottom (as the shader reads it).
      const row = 1 - Math.floor(y / CELL);
      const cell = Math.floor(x / CELL) + row * 4;
      const [r, s, b] = paint(cell, ((x % CELL) + 0.5) / CELL, 1 - ((y % CELL) + 0.5) / CELL);
      img.data.set([r * 255, s * 255, b * 255, 255], (y * c.width + x) * 4);
    }
  }
  g.putImageData(img, 0, 0);
  atlas = new THREE.CanvasTexture(c);
  atlas.colorSpace = THREE.NoColorSpace; // amounts, not colours
  return atlas;
}

/** Curtain, blind and roller colours (sRGB), as seen in the village's windows. */
const CLOTH = ['#7a2732', '#9c3b2c', '#44603f', '#2f3e5c', '#b8873a', '#d8c7a6', '#efe6d2', '#8a8580', '#5b6f73', '#6b4a3a', '#c9b38d', '#a45d5d'];
const SLATS = ['#f2f0ea', '#f2f0ea', '#d6d3cc', '#c8b79a', '#8b6a4a', '#4a4c50'];
const ROLLER = ['#ece6d8', '#d9d2c2', '#a9a49b', '#5d5f63', '#c7b08a', '#ece6d8'];

/** A number from 0 to 1 that depends only on the numbers given. */
function hash(...v: number[]): number {
  let h = 2166136261;
  for (const x of v) h = Math.imul(h ^ Math.round(x * 1000), 16777619) ^ (h >>> 13);
  return ((h >>> 0) % 100003) / 100003;
}

export interface PaneLook {
  /** The covering's cell, its colour (linear), gloss, reflectance and whether it is mirrored left to right */
  cell: number;
  tint: THREE.Color;
  roughness: number;
  f0: number;
  mirror: boolean;
  /** How light the room behind is (about 1) */
  room: number;
  /** Metres from the floor of the room behind to the bottom of the glass */
  sill: number;
  /**
   * The room's own number, 0 to 1: its depth, walls, floor and furniture follow from it, and at night
   * whether its light is on (below one half: on).
   */
  seed: number;
  /** The household's number, 0 to 1 (the house's key): its rooms' lights at night agree a little; default from the place */
  home?: number;
  /** Bits: 1 above the ground floor, 2 a wall lamp's glass (no room behind), 4 that lamp lit at night */
  flags?: number;
}

/**
 * What a window has behind it. `x, z`: its middle; `nx, nz`: which way its wall faces; `upper`: above
 * the ground floor; `tall`: a garden door (blinds there looked like shutters outside). The household is
 * guessed from the wall's place (a few metres' grid) and its floor.
 */
export function paneLook(x: number, z: number, nx: number, nz: number, upper: boolean, i: number, tall = false): PaneLook {
  const house = hash(Math.round(x / 7), Math.round(z / 7), Math.round(nx * 2), Math.round(nz * 2), upper ? 1 : 0);
  const id = hash(i, x, z); // this window's own numbers
  const pick = id < 0.18 ? hash(id, 7) : house; // about one in six windows differs from the rest of its floor
  // Ground floors go for nets (privacy from the street), upper floors more for blinds and curtains.
  const kinds = upper
    ? [[COVER.none, 0.3], [COVER.drapes, 0.14], [COVER.nets, 0.1], [COVER.venetian, 0.14], [COVER.roller, 0.14], [COVER.drapesNets, 0.1], [COVER.drawn, 0.08]] as const
    : [[COVER.none, 0.26], [COVER.drapes, 0.1], [COVER.nets, 0.18], [COVER.halfNets, 0.14], [COVER.venetian, 0.08], [COVER.roller, 0.06], [COVER.drapesNets, 0.12], [COVER.drawn, 0.06]] as const;
  let cell: number = COVER.none;
  let sum = 0;
  for (const [k, w] of kinds) {
    sum += w;
    if (pick < sum) {
      cell = k;
      break;
    }
  }
  if (tall && (cell === COVER.venetian || cell === COVER.roller)) cell = id < 0.6 ? COVER.drapesNets : COVER.none;
  const choose = (list: readonly string[], h: number) => list[Math.floor(h * list.length) % list.length];
  const colour = hash(Math.round(x / 7), Math.round(z / 7), 3);
  const tint = new THREE.Color(cell === COVER.venetian ? choose(SLATS, colour) : cell === COVER.roller ? choose(ROLLER, colour) : choose(CLOTH, colour));
  return {
    cell,
    tint,
    roughness: 0.03 + 0.07 * hash(id, 11) ** 2,
    f0: 0.14 + 0.12 * hash(id, 13),
    mirror: hash(id, 17) < 0.5,
    room: 0.6 + 0.8 * hash(id, 19),
    sill: tall ? 0.02 : 0.9,
    seed: hash(id, 37),
    home: house,
    flags: upper ? 1 : 0,
  };
}

/**
 * A window's glass: a quad `w` by `h` centred on `at`, facing `n` (`d` along the wall), with texture
 * coordinates across it, its look per corner and its normals leaning and bowed a little. Only its
 * face is ever seen (the frame is round it, the wall behind), so four corners do.
 */
export function paneGeometry(at: THREE.Vector3, d: THREE.Vector3, n: THREE.Vector3, w: number, h: number, look: PaneLook, seed: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  const up = new THREE.Vector3(0, 1, 0);
  // Lean (radians, each way) and bow (how far the normals turn from the middle to the edge).
  const lean = [(hash(seed, 23) - 0.5) * 0.05, (hash(seed, 29) - 0.5) * 0.05];
  const bow = (hash(seed, 31) - 0.5) * 0.08;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nor = g.attributes.normal as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let k = 0; k < pos.count; k++) {
    const s = (2 * pos.getX(k)) / w;
    const t = (2 * pos.getY(k)) / h;
    v.set(lean[0] + bow * s, lean[1] + bow * t, 1).normalize();
    nor.setXYZ(k, v.x, v.y, v.z);
  }
  g.applyMatrix4(new THREE.Matrix4().makeBasis(d, up, n).setPosition(at));
  const colors = new Float32Array(pos.count * 3);
  const looks = new Float32Array(pos.count * 4);
  const rooms = new Float32Array(pos.count * 4);
  const homes = new Float32Array(pos.count * 2);
  const home = look.home ?? hash(Math.round(at.x / 7), Math.round(at.z / 7));
  for (let k = 0; k < pos.count; k++) {
    colors.set([look.tint.r, look.tint.g, look.tint.b], k * 3);
    looks.set([look.cell, look.roughness, look.f0, (look.mirror ? -1 : 1) * look.room], k * 4);
    rooms.set([w, h, look.sill, look.seed], k * 4);
    homes.set([home, look.flags ?? 0], k * 2);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setAttribute('look', new THREE.BufferAttribute(looks, 4));
  g.setAttribute('room', new THREE.BufferAttribute(rooms, 4));
  g.setAttribute('home', new THREE.BufferAttribute(homes, 2));
  return g;
}

/** At night: 0 by day, 1 at full night (setWindowNight). */
const night = { value: 0 };
/** Seconds, for the televisions' flicker. */
const clock = { value: 0 };

/**
 * How dark it is, from 0 (day) to 1 (night): about half the rooms behind the village's windows light up
 * warm (which ones is fixed per window, so every player sees the same), the rest stay dark, and the sky
 * in the glass fades. For the weather and the time of day.
 */
export function setWindowNight(amount: number): void {
  night.value = Math.min(1, Math.max(0, Number.isFinite(amount) ? amount : 0));
  clock.value = (performance.now() / 1000) % 3600;
  poolMat.visible = rooms && night.value > 0.02; // the porch lights' pools: Medium and up, from dusk
  poolMat.color.setScalar(night.value);
}

/** The glass materials made so far, to switch the rooms behind them with the graphics preset. */
const made: THREE.Material[] = [];
let rooms = true;

/**
 * The light of the porch lamps by the front doors on what is round them: a soft pool on the ground and the step, and a
 * wash up and down the wall round the lamp. Light added to what is drawn there (additive, drawn after the rest, no
 * depth written), its strength per corner falling to nothing at the edge: one draw call for the whole village, drawn
 * only from dusk on Medium and up (setWindowNight, setWindowDetail). No real light, no shadow.
 */
const poolMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
poolMat.visible = false;
poolMat.name = 'porch_pools';
poolMat.userData.noRay = true; // world/tiles.ts: its meshes are never hit by a shot
poolMat.userData.noGroundShade = true; // and throw no shade on the ground's bake (world/groundShade.ts)

/** The pools' material (one for every tile). */
export function porchPoolMaterial(): THREE.Material {
  return poolMat;
}

/** The pool's warm light at its middle (linear, times the night): its brightest point well under 1, far under 65504. */
const POOL = new THREE.Color(1.0, 0.6, 0.3).multiplyScalar(0.32);

/**
 * A porch lamp's light round it: `lamp` the lamp's place on the wall (facing `n`, the wall along `d`), `foot` the door's
 * foot on the wall's line, `ground` the ground's height there. A disc on the ground in front of the door, a smaller one
 * at the door's foot (on a step, where there is one), and an oval on the wall round the lamp; position and colour only.
 */
export function porchPool(lamp: THREE.Vector3, n: THREE.Vector3, d: THREE.Vector3, foot: THREE.Vector3, ground: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const SIDES = 14;
  /**
   * A fan round `c` in the plane of `u` and `v` (radii ru, rv), its middle at `k` of the full light: a ring at 45 % of
   * the radius at a third of it, then nothing at the rim, so it fades out softly with no edge.
   */
  const disc = (c: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3, ru: number, rv: number, k: number) => {
    const at = (i: number, f: number) => c.clone().addScaledVector(u, f * ru * Math.cos((i / SIDES) * Math.PI * 2)).addScaledVector(v, f * rv * Math.sin((i / SIDES) * Math.PI * 2));
    const put = (p: THREE.Vector3, w: number) => {
      pos.push(p.x, p.y, p.z);
      col.push(POOL.r * k * w, POOL.g * k * w, POOL.b * k * w);
    };
    for (let i = 0; i < SIDES; i++) {
      // Wound to face the normal u x v (up for the ground, out of the wall for the wall's).
      put(c, 1);
      put(at(i, 0.45), 0.33);
      put(at(i + 1, 0.45), 0.33);
      for (const [p, w] of [[at(i, 0.45), 0.33], [at(i, 1), 0], [at(i + 1, 1), 0], [at(i, 0.45), 0.33], [at(i + 1, 1), 0], [at(i + 1, 0.45), 0.33]] as const) put(p, w);
    }
  };
  const flatU = d.clone();
  const flatV = n.clone();
  if (flatU.clone().cross(flatV).y < 0) flatU.negate(); // u x v points up
  const wallU = d.clone();
  const wallV = new THREE.Vector3(0, 1, 0);
  if (wallU.clone().cross(wallV).dot(n) < 0) wallU.negate(); // u x v points out of the wall
  const under = lamp.clone().setY(0);
  disc(under.clone().addScaledVector(n, 0.55).setY(ground + 0.03), flatU, flatV, 1.5, 1.1, 0.8);
  disc(foot.clone().addScaledVector(n, 0.25).setY(foot.y + 0.012), flatU, flatV, 0.75, 0.3, 0.8);
  disc(lamp.clone().addScaledVector(n, 0.02).setY(lamp.y - 0.2), wallU, wallV, 0.9, 1.5, 0.9);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/** A porch lamp's glass (world/surroundings.ts): no room behind, frosted by day, lit at night if `lit`. */
export function lampGlassLook(lit: boolean): PaneLook {
  return { cell: COVER.none, tint: new THREE.Color('#ffffff'), roughness: 0.3, f0: 0.06, mirror: false, room: 1, sill: 0, seed: 0.5, home: 0.5, flags: lit ? 6 : 2 };
}

/**
 * Rooms behind the glass (a box seen through the window, worked out per pixel of glass) on Medium and up;
 * Low and phones get a flat back wall in the room's colour instead (the same curtains, the same lights at night).
 */
export function setWindowDetail(on: boolean): void {
  if (on === rooms) return;
  rooms = on;
  poolMat.visible = on && night.value > 0.02;
  for (const m of made) {
    if (on) m.defines = { ...m.defines, ROOMS: '' };
    else delete m.defines?.ROOMS;
    m.needsUpdate = true;
  }
}

/**
 * Beyond the probe's reach (world/glassLook.ts: about 14 m from the eye) and on Low, the glass mirrors the sky's photo,
 * whose band just over the horizon is its brightest: a window across the street, seen from the pavement, came out as a
 * light grey panel on the wall. What a real one mirrors there is the street's other side (houses, hedges, trees), far
 * darker than that sky. So the photo's light is dimmed where the mirrored ray runs level or down (fading out by about
 * 17 degrees up, so the sky still shows in windows seen from below); near the eye the probe's own picture is left alone.
 * A few operations per pixel of glass only.
 */
const OPPOSITE = /* glsl */ `
#if defined( RE_IndirectSpecular )
{
  vec3 opP = cameraPosition + ( vec4( - vViewPosition, 0.0 ) * viewMatrix ).xyz;
  vec3 opE = abs( opP - glassProbeAt ) / vec3( 18.0, 40.0, 18.0 );
  float opFar = glassProbeOn > 0.5 ? smoothstep( 0.75, 1.0, max( max( opE.x, opE.z ), opE.y ) ) : 1.0;
  vec3 opR = normalize( ( vec4( reflect( - geometryViewDir, geometryNormal ), 0.0 ) * viewMatrix ).xyz );
  radiance *= 1.0 - 0.6 * opFar * ( 1.0 - smoothstep( 0.0, 0.3, opR.y ) );
}
#endif
`;

/** The glass's material: a standard one whose colour, gloss and reflectance come per window. */
export function paneMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.05, metalness: 0, envMapIntensity: 1.6 });
  m.name = 'village_glass';
  usesProbe(m); // it reads the glass probe (world/glassLook.ts)
  if (rooms) m.defines = { ROOMS: '' };
  made.push(m);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.coverings = { value: coverings() };
    shader.uniforms.windowNight = night;
    shader.uniforms.windowTime = clock;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 look;\nattribute vec4 room;\nattribute vec2 home;\nvarying vec4 vLook;\nvarying vec4 vRoom;\nvarying vec2 vHome;\nvarying vec2 vPane;\n#ifdef ROOMS\nvarying vec3 vRay;\n#endif')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvLook = look;\nvRoom = room;\nvHome = home;\nvPane = uv;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        #ifdef ROOMS
        {
          // The view ray in the pane's own frame: along the wall (as u runs), up, and into the room.
          vec3 n = mat3(modelMatrix) * objectNormal;
          n = normalize(vec3(n.x, 0.0, n.z) + vec3(1e-6, 0.0, 0.0));
          vec3 ray = (modelMatrix * vec4(transformed, 1.0)).xyz - cameraPosition;
          vRay = vec3(dot(ray, vec3(n.z, 0.0, -n.x)), ray.y, -dot(ray, n));
        }
        #endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D coverings;
        uniform float windowNight;
        uniform float windowTime;
        varying vec4 vLook;
        varying vec4 vRoom;
        varying vec2 vHome;
        varying vec2 vPane;
        #ifdef ROOMS
        varying vec3 vRay;
        #endif
        // Walls (linear): warm and cool whites, beige, light grey, sage, pale blue, a terracotta and a dark accent wall.
        const vec3 WALLS[8] = vec3[8](vec3(0.80, 0.76, 0.68), vec3(0.74, 0.74, 0.72), vec3(0.66, 0.56, 0.42), vec3(0.50, 0.51, 0.52),
          vec3(0.45, 0.52, 0.42), vec3(0.46, 0.55, 0.64), vec3(0.60, 0.36, 0.26), vec3(0.16, 0.18, 0.21));
        // Floors: oak, dark wood, grey tiles, dark tiles.
        const vec3 FLOORS[4] = vec3[4](vec3(0.50, 0.34, 0.19), vec3(0.24, 0.14, 0.08), vec3(0.42, 0.42, 0.40), vec3(0.14, 0.13, 0.13));`)
      .replace(
        '#include <color_fragment>',
        `{
          // What is behind the glass: the covering's cell (kept off its edges, where the next cell starts).
          vec2 p = clamp(vec2(vLook.w < 0.0 ? 1.0 - vPane.x : vPane.x, vPane.y), 0.03, 0.97);
          vec3 cover = texture2D(coverings, (vec2(mod(vLook.x, 4.0), floor(vLook.x * 0.25)) + p) * vec2(0.25, 0.5)).rgb;
          // The room's own numbers (from its seed): walls, floor, depth, furniture, lamp; about one in ten has its curtains closed.
          float seed = vRoom.w;
          vec4 r = fract(seed * vec4(17.31, 31.7, 57.13, 91.9) + vec4(0.0, 0.13, 0.71, 0.37));
          vec3 wall = WALLS[int(r.x * 7.999)];
          float through = abs(vLook.x - float(${COVER.venetian})) < 0.5 ? 0.2 : 1.0; // light through the covering at night
          // The evening, house by house and room by room: about one house in seven has nobody in (all dark); downstairs
          // more rooms light up as it gets dark, upstairs few at dusk and some more by full night.
          float home = vHome.x;
          float upper = mod(vHome.y, 2.0);
          float share = upper > 0.5 ? mix(0.06, 0.3, windowNight * windowNight) : mix(0.3, 0.66, windowNight);
          float on = windowNight * step(0.14, home) * step(fract(seed * 7.31 + home * 3.7), share);
          // Its light: warm (most), a neutral white, a cool white; a few dim (a lamp in the next room); in about one
          // lit room in twenty downstairs a television's blue flicker.
          float tint = fract(seed * 13.7 + home * 1.3);
          vec3 lamp = tint < 0.55 ? vec3(1.0, 0.55, 0.24) : tint < 0.85 ? vec3(1.0, 0.74, 0.47) : vec3(0.8, 0.86, 1.0);
          lamp *= fract(seed * 23.1) < 0.2 ? 0.3 : 0.7 + 0.6 * fract(seed * 41.3);
          float tv = (1.0 - upper) * step(fract(seed * 53.7 + home * 9.1), 0.05);
          float flick = 0.55 + 0.45 * fract(sin(floor(windowTime * 6.0 + seed * 91.0) * 12.9898) * 43758.5453);
          lamp = mix(lamp, vec3(0.3, 0.45, 1.0) * flick, tv * 0.8);
          // Curtains: about one room in ten by day; at night most lit rooms upstairs and a third downstairs, glowing.
          float drawn = step(fract(seed * 61.3 + home * 5.1), upper > 0.5 ? 0.7 : 0.3) * step(0.5, on);
          if (r.w < 0.1 || drawn > 0.5) {
            cover = vec3(1.0, 0.0, 0.62 + 0.38 * (0.5 + 0.5 * cos(p.x * 50.0 + r.y * 6.0)));
            through = 1.0;
          }
          float spot = 0.0; // a lamp seen in the room, brighter than the rest
          vec3 albedo;
          float day;  // how much of the daylight through the window reaches that spot
          float glow; // and of the lamp at night
          #ifdef ROOMS
          {
            // A box behind the glass (metres; x along the wall, y up from the bottom of the glass, z into the room),
            // wider than the window, its floor a sill below it: where the view ray meets it, and on which face.
            float w = vRoom.x, h = vRoom.y, sill = vRoom.z;
            float depth = mix(2.6, 5.0, r.y);
            vec3 lo = vec3(-0.5 * w - mix(0.3, 1.6, r.z), -sill, 0.0);
            vec3 hi = vec3(0.5 * w + mix(0.3, 1.6, fract(r.z * 7.7)), max(h + 0.25, 2.6 - sill), depth);
            vec3 d = vRay;
            d.x = abs(d.x) < 1e-4 ? 1e-4 : d.x;
            d.y = abs(d.y) < 1e-4 ? 1e-4 : d.y;
            d.z = max(d.z, 1e-3);
            vec3 at = vec3((vPane.x - 0.5) * w, vPane.y * h, 0.0);
            vec3 t3 = (mix(lo, hi, step(0.0, d)) - at) / d;
            float t = min(min(t3.x, t3.y), t3.z);
            vec3 q = at + d * t;
            vec3 e = min(q - lo, hi - q); // how far from each pair of walls
            float corner;
            float mid = 0.5 * (lo.x + hi.x);
            if (t == t3.z) {
              // The back wall, with a cabinet or a sofa against it in most rooms, and a picture above.
              albedo = wall;
              corner = min(e.x, e.y);
              float y = q.y + sill;
              float px = mid + (r.y - 0.5) * 1.2;
              vec2 s = vec2(abs(q.x - px), abs(y - 1.6)); // from the picture's middle
              if (r.w > 0.25 && y < 0.8 && s.x < 0.95) albedo = mix(vec3(0.09, 0.08, 0.07), vec3(0.42, 0.38, 0.33), fract(r.w * 13.0));
              else if (r.x > 0.3 && s.x < 0.38 && s.y < 0.28) albedo = s.x < 0.34 && s.y < 0.24 ? vec3(0.55, 0.42, 0.28) * fract(r.w * 29.0) + 0.1 : vec3(0.06);
              // A standing or table lamp against it: its shade.
              vec2 shade = vec2(q.x - mix(lo.x + 0.4, hi.x - 0.4, fract(r.x * 5.3)), y - mix(1.0, 1.5, fract(r.y * 3.7))) / vec2(0.17, 0.12);
              if (dot(shade, shade) < 1.0) {
                albedo = vec3(0.85, 0.8, 0.7);
                spot = 1.0;
              }
            } else if (t == t3.x) {
              // A side wall, with a door in some rooms.
              albedo = wall * 0.9;
              corner = min(e.y, e.z);
              if (r.z > 0.55 && q.y + sill < 2.05 && abs(q.z - depth * 0.6) < 0.42) albedo = mix(vec3(0.85, 0.83, 0.80), vec3(0.03), step(0.7, r.z));
            } else if (d.y < 0.0) {
              albedo = FLOORS[int(r.y * 3.999)];
              corner = min(e.x, e.z);
            } else {
              albedo = vec3(0.78, 0.77, 0.75);
              corner = min(e.x, e.z);
              // The lamp's shade, in the middle of the ceiling.
              if (length(vec2(q.x - mid, q.z - depth * 0.5)) < 0.18) albedo = mix(vec3(0.9), vec3(3.0), on);
            }
            float ao = 0.45 + 0.55 * smoothstep(0.0, 0.45, corner);
            day = (1.0 - 0.6 * q.z / depth) * ao;
            vec3 toLamp = vec3(mid, hi.y - 0.35, depth * 0.5) - q;
            glow = ao / (1.0 + 0.35 * dot(toLamp, toLamp));
          }
          #else
          // Low and phones: a flat back wall in the room's colour, lighter towards the top, and the lamp's light in a patch.
          albedo = wall;
          day = 0.45 + 0.4 * vPane.y;
          glow = 0.35 + 0.25 * vPane.y;
          vec2 spotAt = (vPane - vec2(mix(0.25, 0.75, fract(r.x * 5.3)), 0.45)) * vRoom.xy;
          spot = 0.22 * exp(-4.0 * dot(spotAt, spotAt)); // soft: a lamp somewhere in the room, no shape
          #endif
          // By day the room is lit through the window and seen through two panes: dim. It is shaded here as if it lay on
          // the glass, in the sun that falls on the wall: at 0.3 a window in the sun came out a light grey panel, far
          // lighter than a real room seen from the street, which is a few times darker than the wall outside.
          vec3 room = albedo * day * 0.12 * abs(vLook.w);
          vec3 sheer = vec3(0.38, 0.37, 0.35) * cover.b;
          vec3 cloth = vColor.rgb * 0.5 * cover.b; // seen through two panes
          // In the shade of the reveal along the top and the sides, as the glass sits back in the wall.
          float reveal = 0.6 + 0.4 * smoothstep(0.0, 0.09, min(min(vPane.x, 1.0 - vPane.x), 1.0 - vPane.y));
          diffuseColor.rgb = mix(mix(room, sheer, cover.g), cloth, cover.r) * reveal;
          // At night the lamp lights the room, and shines through nets, curtains and roller blinds; venetian
          // blinds show only their dim outer side. Well under what half floats hold (65504).
          // Drawn curtains glow most where the lamp stands behind them.
          vec2 fromLamp = (p - vec2(mix(0.25, 0.75, fract(r.x * 5.3)), mix(0.3, 0.55, fract(r.y * 3.7)))) * vRoom.xy;
          float behind = 0.25 + 1.1 * exp(-2.5 * dot(fromLamp, fromLamp));
          vec3 lit = mix(mix(albedo * glow + spot * 2.5, vec3(0.5) * cover.b, cover.g), (vColor.rgb * 0.45 + 0.05) * cover.b * through * behind, cover.r);
          totalEmissiveRadiance += lamp * lit * on * reveal * 1.8;
          // A wall lamp's glass by a front door: frosted by day, lit warm at night where its house has it on.
          if (vHome.y > 1.5) {
            diffuseColor.rgb = vec3(0.7, 0.69, 0.66);
            totalEmissiveRadiance = vec3(1.0, 0.62, 0.3) * 6.0 * windowNight * step(3.5, vHome.y);
          }
        }`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vLook.y;')
      .replace(
        '#include <lights_physical_fragment>',
        // At night the glass mirrors less of the (dark) sky, so the rooms behind show.
        '#include <lights_physical_fragment>\nmaterial.specularColor = vec3(vLook.z) * (1.0 - 0.7 * windowNight);\nmaterial.specularColorBlended = material.specularColor;',
      )
      // The sun's glint on glass seen at a slant can pass what half floats hold (65504): an iPhone stores infinity.
      .replace('#include <dithering_fragment>', 'gl_FragColor.rgb = min(gl_FragColor.rgb, vec3(60000.0));\n#include <dithering_fragment>');
    probeOn(shader); // the street round the eye in the glass, and the rain's drops (world/glassLook.ts)
    // After the probe's part (probeOn puts it just before the same include, so this comes after it).
    if (shader.uniforms.glassProbe) shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>', `${OPPOSITE}\n#include <lights_fragment_end>`);
  };
  return m;
}
