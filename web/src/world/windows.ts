import * as THREE from 'three';

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
  for (let k = 0; k < pos.count; k++) {
    colors.set([look.tint.r, look.tint.g, look.tint.b], k * 3);
    looks.set([look.cell, look.roughness, look.f0, (look.mirror ? -1 : 1) * look.room], k * 4);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setAttribute('look', new THREE.BufferAttribute(looks, 4));
  return g;
}

/** The glass's material: a standard one whose colour, gloss and reflectance come per window. */
export function paneMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.05, metalness: 0, envMapIntensity: 1.6 });
  m.name = 'village_glass';
  m.onBeforeCompile = (shader) => {
    shader.uniforms.coverings = { value: coverings() };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 look;\nvarying vec4 vLook;\nvarying vec2 vPane;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvLook = look;\nvPane = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D coverings;\nvarying vec4 vLook;\nvarying vec2 vPane;')
      .replace(
        '#include <color_fragment>',
        `{
          // What is behind the glass: the covering's cell (kept off its edges, where the next cell starts).
          vec2 p = clamp(vec2(vLook.w < 0.0 ? 1.0 - vPane.x : vPane.x, vPane.y), 0.03, 0.97);
          vec3 cover = texture2D(coverings, (vec2(mod(vLook.x, 4.0), floor(vLook.x * 0.25)) + p) * vec2(0.25, 0.5)).rgb;
          // The room: dark, a little lighter towards the top, where the ceiling catches the daylight.
          vec3 room = vec3(0.022, 0.02, 0.018) * abs(vLook.w) * (0.7 + 0.6 * vPane.y);
          vec3 sheer = vec3(0.38, 0.37, 0.35) * cover.b;
          vec3 cloth = vColor.rgb * 0.5 * cover.b; // seen through two panes
          // In the shade of the reveal along the top and the sides, as the glass sits back in the wall.
          float reveal = 0.6 + 0.4 * smoothstep(0.0, 0.09, min(min(vPane.x, 1.0 - vPane.x), 1.0 - vPane.y));
          diffuseColor.rgb = mix(mix(room, sheer, cover.g), cloth, cover.r) * reveal;
        }`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vLook.y;')
      .replace(
        '#include <lights_physical_fragment>',
        '#include <lights_physical_fragment>\nmaterial.specularColor = vec3(vLook.z);\nmaterial.specularColorBlended = material.specularColor;',
      )
      // The sun's glint on glass seen at a slant can pass what half floats hold (65504): an iPhone stores infinity.
      .replace('#include <dithering_fragment>', 'gl_FragColor.rgb = min(gl_FragColor.rgb, vec3(60000.0));\n#include <dithering_fragment>');
  };
  return m;
}
