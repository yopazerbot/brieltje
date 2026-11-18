import * as THREE from 'three';
import { snowOn } from './snowCover';
import { renderOf, stable } from './houseKeys';

// Which house a block belongs to, and the hash everything here is picked by (world/houseKeys.ts).
export { Houses, isBrick, stable } from './houseKeys';

/**
 * Each open-data house its own look (world/surroundings.ts builds them): the shade of its brick within
 * its kind, some white and buff houses rendered in cream instead of bare brick, its roof covering, and
 * now and then dark green window frames. The open data gives only outlines and heights, so this is made
 * up, fixed by where the house stands: every player sees the same, and nothing is a real house's colour.
 *
 * All of it rides on the vertices of the geometry the tiles already merge (a colour, a byte for render,
 * a byte for glaze), so the walls stay one draw call per tile and the roofs another, as before.
 */

/**
 * Shades of each brick within its kind (sRGB, for the generated brick texture), as Flemish streets have
 * them: red, warmer red, deep red and purple-brown reds; brown and red-brown; yellow and buff; white-painted.
 * Weathered and muted, not fresh: a sunlit red wall about half as bright as the road beside it, as on the
 * street (compared by eye with pictures of the village's streets, nothing taken from them). Every house
 * that picks from this table changes with it: the open-data houses, the ring round the home, their
 * chimneys, plinths, lintels and garden walls. The hand-built streets keep their own colours.
 */
const SHADES: Record<string, string[]> = {
  nb_red: ['#88564c', '#905e4e', '#7a4c42', '#6e4844', '#8c5e52', '#74463c'],
  nb_brown: ['#704e40', '#60443a', '#7c5846', '#58403a', '#6a4a3c'],
  nb_yellow: ['#c2a682', '#b0946c', '#cab593', '#ad9476', '#bb9e74'],
  nb_white: ['#f2eee6', '#ece6da', '#f4f1ea'],
  nb_grey: ['#8f8982', '#7d7873', '#9a948b', '#878279'],
  nb_dark: ['#4b4a49', '#3f3e3e'],
};
/** Cream and off-white render (sRGB). */
const RENDER = ['#efe4cb', '#f2ecdf', '#e9dcc0', '#f4efe4'];

export interface BrickLook {
  tint: THREE.Color;
  /** Rendered (1) or bare brick (0) */
  render: number;
}

/** A house's walls: `m` its brick in the data, `key` the house's key (a stable random 0 to 1). */
export function brickLook(m: string, key: number): BrickLook {
  const pick = (list: string[], h: number) => list[Math.floor(h * list.length) % list.length];
  // About two in five white houses and one in eight yellow ones are rendered rather than bare brick.
  const render = renderOf(m, key);
  const tint = new THREE.Color(render ? pick(RENDER, stable(key, 3)) : pick(SHADES[m] ?? SHADES.nb_red, stable(key, 5)));
  tint.multiplyScalar(0.94 + 0.12 * stable(key, 7)); // and a little lighter or darker, house by house
  // And a little warmer or cooler (up to 4 % more red and less blue, or the other way), as weathering and batches of
  // brick or paint differ from house to house.
  const warm = 0.08 * (stable(key, 9) - 0.5);
  tint.r *= 1 + warm;
  tint.b *= 1 - warm;
  return { tint, render };
}

/**
 * A roof's covering from its colour on the aerial photo (`photo`, sRGB) and its house's key: whether it
 * is light, dark or reddish there decides the kind, the key which one of that kind. Dark roofs: anthracite
 * tiles or black glazed ones; mid grey: grey tiles, a few slate; reddish: terracotta and red-brown; light and
 * a little warm: half of them faded red-brown. `gloss`: 1 for glazed tiles and slate, 0 for matt.
 */
export function roofLook(photo: string, key: number): { color: THREE.Color; gloss: number } {
  const c = new THREE.Color(photo);
  const s = c.clone().convertLinearToSRGB();
  const light = (s.r + s.g + s.b) / 3;
  const warm = s.r - s.b;
  const k = stable(key, 11);
  const jitter = 0.92 + 0.16 * stable(key, 13);
  const of = (hex: string, gloss = 0) => ({ color: new THREE.Color(hex).multiplyScalar(jitter), gloss });
  if (warm > 0.09) return of(['#a5533a', '#b4613f', '#8c4a3a', '#9a5843'][Math.floor(k * 4)]);
  if (light < 0.25) return k < 0.45 ? of('#1e2024', 1) : of(k < 0.75 ? '#33363b' : '#2b2d31');
  if (light < 0.45) return k < 0.22 ? of('#4a5059', 0.7) : { color: c.multiplyScalar(jitter), gloss: 0 };
  if (warm > 0.03 && k < 0.5) return of(k < 0.25 ? '#9a5a48' : '#a8664e');
  return { color: c.multiplyScalar(jitter), gloss: 0 };
}

/** Window frame colour: the data's, but about one house in fourteen has dark green frames. */
export function frameColour(data: string, key: number): THREE.Color {
  return new THREE.Color(stable(key, 17) < 0.07 ? '#2f4a3a' : data);
}

/** A byte per vertex (0 to 1) under `name`, as the tiles merge them (the same type on every geometry). */
export function byteAttribute(g: THREE.BufferGeometry, name: string, value: number): THREE.BufferGeometry {
  g.setAttribute(name, new THREE.BufferAttribute(new Uint8Array(g.attributes.position.count).fill(Math.round(value * 255)), 1, true));
  return g;
}

const rendered = new WeakSet<THREE.Material>();
const glazed = new WeakSet<THREE.Material>();

/**
 * The neighbours' brick material reads the render byte (`facade`): there the brick's pattern and relief
 * flatten to a smooth coat in the wall's colour. Patched once; the brick stays one material.
 */
export function renderable<T extends THREE.Material>(m: T): T {
  if (rendered.has(m)) return m;
  rendered.add(m);
  const before = m.onBeforeCompile;
  const key = m.customProgramCacheKey.bind(m);
  m.onBeforeCompile = (shader, renderer) => {
    before.call(m, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float facade;\nvarying float vFacade;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFacade = facade;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFacade;')
      .replace(
        '#include <color_fragment>',
        // The brick texture's mean (linear) is about 0.56: render keeps a trace of its mottling, not its joints.
        `#include <color_fragment>
        #if defined( USE_MAP ) && defined( USE_COLOR )
        diffuseColor.rgb = mix(diffuseColor.rgb, vColor.rgb * (0.56 + 0.12 * (dot(sampledDiffuseColor.rgb, vec3(0.3333)) - 0.56)), vFacade);
        #endif`,
      )
      .replace('#include <normal_fragment_maps>', THREE.ShaderChunk.normal_fragment_maps.replace('mapN.xy *= normalScale;', 'mapN.xy *= normalScale * (1.0 - 0.85 * vFacade);'));
    snowOn(shader); // snow on the flat tops of the blocks and garden walls (world/snowCover.ts); the walls face sideways
  };
  m.customProgramCacheKey = () => `${key()}|render`;
  m.needsUpdate = true;
  return m;
}

/** The roof tiles' material reads the glaze byte (`gloss`): glazed tiles and slate shine. Patched once. */
export function glazeable<T extends THREE.Material>(m: T): T {
  if (glazed.has(m)) return m;
  glazed.add(m);
  const before = m.onBeforeCompile;
  const key = m.customProgramCacheKey.bind(m);
  m.onBeforeCompile = (shader, renderer) => {
    before.call(m, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float gloss;\nvarying float vGloss;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGloss = gloss;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGloss;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor *= 1.0 - 0.6 * vGloss;');
    snowOn(shader); // snow on the roofs (world/snowCover.ts)
  };
  m.customProgramCacheKey = () => `${key()}|glaze`;
  m.needsUpdate = true;
  return m;
}
