import * as THREE from 'three';
import { bankAt, bankOf, type Bank, type BankPoint } from './bankShape';
import type { Ground } from './collision';
import type { DipSpec } from './houseData';
import { mood } from './mood';
import { terrain } from './terrain';
import { washWaterOn } from './washShader';
import { wind } from './wind';

/**
 * The ponds' and ditches' water: a dark green mirror of the sky, now ruffled by the wind. Five
 * trains of small waves (40 cm to a metre and a half long, running about downwind at the
 * speed such waves have) tilt the surface's normal in the fragment shader, so the reflected clouds
 * shimmer; nothing is moved. Gusts drift across it as calmer and rougher patches. Each train fades
 * out where its waves get too small on screen to draw (no glitter in the distance), and the water
 * turns a little less glossy there instead. One material for every pond, its clock set as it is drawn.
 * In a ditch the same trains lie along it (in metres along and across it, from its banks: world/bankShape.ts)
 * and are carried downstream at 0.12 to 0.3 m/s; a pond keeps the wind.
 *
 * Its colour follows its depth (each point of it knows how deep it is there): silty and lighter where shallow,
 * its own dark green from about half a metre down, with a thin darker line where it meets the bank. On Medium
 * and up it is clear over the first centimetres, so the mud under it shows, and as good as opaque by half a
 * metre, its reflection whole however clear (no read of the scene's depth, no extra pass: the depth comes with
 * the points). On Low and phones it stays opaque, the mud showing only in its colour.
 *
 * In the rain, on Medium and up, drops dot the water near you with small rings (the same shader: one
 * drop at a time in each half-metre cell, two layers of cells), nothing on Low or on a phone.
 *
 * Also where the water is, for walking into it (player.ts): each pond and ditch with its banks (world/bankShape.ts):
 * its level and the bed under it read off them point by point. A ditch is as deep as it is drawn (about half a
 * metre); a pond deepens on past its drawn bed to 1.8 m in the middle, deep enough to swim in (unseen: the water
 * is dark by then).
 */

// From the south-west, as the wind in the trees (world/wind.ts); in the model's x and z.
const WIND = new THREE.Vector2(-0.998, 0.057);
/** Wave trains: length (m), angle off the wind (radians), height as a slope (a fraction of the length). */
const WAVES: [number, number, number][] = [
  [1.6, 0.0, 0.024],
  [1.05, 0.45, 0.02],
  [0.8, -0.6, 0.018],
  [0.55, 0.25, 0.015],
  [0.42, -0.2, 0.012],
];

const waves = WAVES.map(([length, angle, slope]) => {
  const k = (Math.PI * 2) / length;
  const dir = WIND.clone().rotateAround(new THREE.Vector2(), angle);
  // Deep-water waves: the angular speed is the root of g times the wave number.
  return `ripple(p, vec2(${(dir.x * k).toFixed(4)}, ${(dir.y * k).toFixed(4)}), ${Math.sqrt(9.81 * k).toFixed(4)}, ${(slope / k).toFixed(5)}, ${(length * 1.7).toFixed(2)}, px, grad, fade);`;
}).join('\n          ');

// A ditch's ripples: the same trains, but laid along the ditch (in metres along and across it), lower in its shelter,
// carried down with the flow and hardly moving on their own.
const flowWaves = WAVES.map(([length, angle, slope]) => {
  const k = (Math.PI * 2) / length;
  return `ripple(q, vec2(${(Math.cos(angle) * k).toFixed(4)}, ${(Math.sin(angle) * k).toFixed(4)}), ${(Math.sqrt(9.81 * k) * 0.06).toFixed(4)}, ${((slope * 0.6) / k).toFixed(5)}, ${(length * 1.7).toFixed(2)}, px, grad, fade);`;
}).join('\n            ');

/** The water's colour where it is shallow: silty, a little lighter and browner than its depth (linear RGB). */
const SHALLOW = new THREE.Color('#5a5a3c');
/** On Low, where the water stays opaque: the mud under it, to show where it is shallow. */
const MUD = new THREE.Color('#4a4030');

let material: THREE.MeshStandardMaterial | null = null;
const time = { value: 0 };
/** The wind as the ponds read it: its turn from WIND (cos, sin) and how rough (waterClock) */
const windNow = { value: new THREE.Vector3(1, 0, 1) };
/** How hard it rains on the water now (0 to 1), 0 on Low */
const rain = { value: 0 };
let detail = true;

/** Clear in the shallows (Medium and up): blended over the bank, its reflection added in full. */
function clearWater(m: THREE.MeshStandardMaterial, on: boolean): void {
  m.transparent = on;
  m.blending = on ? THREE.CustomBlending : THREE.NormalBlending;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = THREE.OneFactor;
  m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  m.defines = on ? { WATER_CLEAR: '' } : {};
  m.needsUpdate = true;
}

/** The water's material, shared by every pond. */
export function waterMaterial(): THREE.MeshStandardMaterial {
  if (material) return material;
  const m = new THREE.MeshStandardMaterial({ color: '#3c4a3e', roughness: 0.06, metalness: 0.15 });
  m.name = 'water';
  clearWater(m, detail);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.waterTime = time;
    shader.uniforms.waterRain = rain;
    shader.uniforms.waterWind = windNow;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float waterDepth;\nattribute vec4 waterFlow;\nvarying vec2 vWater;\nvarying float vWaterDepth;\nvarying vec4 vWaterFlow;',
      )
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvWater = (modelMatrix * vec4(transformed, 1.0)).xz;\nvWaterDepth = waterDepth;\nvWaterFlow = waterFlow;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float waterTime;
        uniform float waterRain;
        uniform vec3 waterWind;
        varying vec2 vWater;
        varying float vWaterDepth;
        varying vec4 vWaterFlow;
        float waterAlpha = 1.0;
        // One train of waves: adds its slope at p to grad, and how much of it is drawn to fade.
        void ripple(vec2 p, vec2 k, float w, float a, float phase, float px, inout vec2 grad, inout float fade) {
          float keep = clamp(1.0 - px * length(k) * 0.35, 0.0, 1.0); // gone at two pixels a wave
          grad += k * a * cos(dot(k, p) - w * waterTime + phase) * keep;
          fade += keep;
        }
        vec2 rainHash(vec2 c) {
          return fract(sin(vec2(dot(c, vec2(127.1, 311.7)), dot(c, vec2(269.5, 183.3)))) * 43758.5453);
        }
        // Rain drops on the water: in each half-metre cell one drop at a time, its ring spreading to 15 cm and
        // dying away; a new drop somewhere else in the cell each time. Fewer cells have one in light rain.
        void rainRings(vec2 p, float layer, float keep, inout vec2 grad) {
          vec2 q = p * 2.0 + layer * vec2(0.37, 0.61);
          vec2 cell = floor(q);
          float cycle = waterTime * 0.8 + rainHash(cell + layer * 7.3).x * 9.0;
          float t = fract(cycle);
          vec2 h = rainHash(cell + floor(cycle) * vec2(1.7, 3.1));
          vec2 d = q - (cell + 0.3 + 0.4 * h);
          float r = length(d);
          float x = r - t * 0.3;
          float wave = sin(x * 70.0) * exp(-x * x * 900.0) * (1.0 - t) * (1.0 - t);
          grad += d / max(r, 1e-3) * wave * 1.1 * keep * step(h.y, waterRain * 0.85 + 0.1);
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          // Under the bank: none of it (its edge is where the bank comes out of the water).
          float d = vWaterDepth;
          if (d < 0.0) discard;
          // Silty and lighter where shallow, the body's own colour from about half a metre down.
          float deep = smoothstep(0.0, 0.5, d);
          // A thin darker line where it meets the bank: the wet edge.
          float edge = 1.0 - smoothstep(0.0, 0.035, d);
          #ifdef WATER_CLEAR
            // Clear over the first centimetres, so the mud shows through, and as good as opaque by half a metre.
            diffuseColor.rgb = mix(vec3(${SHALLOW.r.toFixed(4)}, ${SHALLOW.g.toFixed(4)}, ${SHALLOW.b.toFixed(4)}), diffuseColor.rgb, deep);
            waterAlpha = max(mix(0.08, 1.0, smoothstep(0.01, 0.55, d)), 0.45 * edge);
          #else
            diffuseColor.rgb = mix(vec3(${MUD.r.toFixed(4)}, ${MUD.g.toFixed(4)}, ${MUD.b.toFixed(4)}), diffuseColor.rgb, smoothstep(0.0, 0.4, d));
          #endif
          diffuseColor.rgb *= 1.0 - 0.3 * edge;
        }`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          vec2 p = vWater;
          float px = length(fwidth(p));
          vec2 grad = vec2(0.0);
          float fade = 0.0;
          float flow = length(vWaterFlow.zw);
          if (flow > 0.0) {
            // A ditch: ripples along it, carried downstream (in metres along and across it, as p is).
            vec2 down = vWaterFlow.zw / flow;
            vec2 q = vec2(vWaterFlow.x - flow * waterTime, vWaterFlow.y);
            ${flowWaves}
            grad = grad.x * down + grad.y * vec2(-down.y, down.x);
          } else {
            // A pond's trains run with the wind as it blows now (world/wind.ts): turned from the sunny day's.
            vec2 pw = vec2(p.x * waterWind.x + p.y * waterWind.y, p.y * waterWind.x - p.x * waterWind.y);
            {
              vec2 p = pw;
              ${waves}
            }
            grad = vec2(grad.x * waterWind.x - grad.y * waterWind.y, grad.x * waterWind.y + grad.y * waterWind.x);
          }
          grad *= waterWind.z; // glassy in a calm, rougher in a fresh wind
          // Gusts: rougher and calmer patches drifting downwind.
          float gust = 0.55 + 0.45 * sin(dot(p, vec2(${(WIND.x * 0.21).toFixed(3)}, ${(WIND.y * 0.21).toFixed(3)})) - waterTime * 0.5) * sin(p.x * 0.13 - p.y * 0.17 + waterTime * 0.11);
          grad *= gust;
          if (waterRain > 0.0) {
            // Gone where a ring would be under about two pixels across (some 15 m off at full screen).
            float keep = clamp(1.0 - (px - 0.008) * 55.0, 0.0, 1.0) * min(1.0, waterRain * 3.0);
            if (keep > 0.0) {
              rainRings(p, 0.0, keep, grad);
              rainRings(p, 1.0, keep, grad);
            }
          }
          normal = normalize((viewMatrix * vec4(-grad.x, 1.0, -grad.y, 0.0)).xyz);
          roughnessFactor = mix(0.11, roughnessFactor, fade / ${WAVES.length.toFixed(1)}) + 0.06 * waterRain;
        }`,
      )
      .replace(
        '#include <opaque_fragment>',
        `#ifdef WATER_CLEAR
          // What lies under it shows through by its clearness; the sky's and the sun's reflection stays whole.
          gl_FragColor = vec4(totalDiffuse * waterAlpha + totalSpecular + totalEmissiveRadiance, waterAlpha);
        #else
          #include <opaque_fragment>
        #endif`,
      );
    washWaterOn(shader); // a helicopter's rotor wash: rings, chop and spray under it (world/washShader.ts)
  };
  material = m;
  return m;
}

/** Keeps the waves moving: call as the water is drawn (a mesh's onBeforeRender). */
export function waterClock(): void {
  time.value = performance.now() / 1000;
  rain.value = detail ? raining() : 0;
  // The wind now (world/wind.ts): its turn from the sunny day's (cos, sin) and how hard, the sun's breeze 1.
  const d = wind.dir.value;
  windNow.value.set(WIND.x * d.x + WIND.y * d.y, WIND.x * d.y - WIND.y * d.x, Math.min(1.5, 0.3 + 0.7 * wind.speed.value));
}

/** How hard it rains now: the rain mood's share of what is shown (world/mood.ts). */
function raining(): number {
  return (mood.current === 'rain' ? 1 - mood.blend : 0) + (mood.next === 'rain' && mood.next !== mood.current ? mood.blend : 0);
}

/**
 * Rain rings on the water, and water clear in the shallows: on for Medium and up, off on Low and on phones (main.ts
 * applyQuality). Without, the water is opaque and the mud under it shows only as its colour.
 */
export function setWaterDetail(on: boolean): void {
  if (material && on !== detail) clearWater(material, on);
  detail = on;
}

// ---- Where the water is, and how deep ----

/** In a pond: how deep the middle gets (m), and how much deeper per metre further in than its drawn bottom. */
const POND_DEPTH = 1.8;
const SHELVE = 0.45;
/** Deeper than this you float (m): eyes 0.3 m over the water, the head above it. */
export const FLOAT = 1.35;

interface Body {
  ring: [number, number][];
  level: number;
  /** The drawn depth at the flat bottom (m): the bank's 1:1 slope reaches it this far in from the water's edge */
  drawn: number;
  pond: boolean;
  /** Its banks (world/bankShape.ts): the level and the bed read off them point by point */
  bank?: Bank;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}
const bodies: Body[] = [];

/** You (or someone) in the water: its level, how deep it is there, and whether that is out of your depth. */
export interface Wet {
  level: number;
  depth: number;
  swimming: boolean;
}

/**
 * A pond's or ditch's outline at the water line, and its level (the lowest, where a ditch falls along its length).
 * From its banks (world/bankShape.ts) when it has them.
 */
export function waterLine(d: DipSpec, ground: number): { ring: [number, number][]; level: number } | null {
  if (!d.water) return null;
  const bank = bankOf(d, ground, terrain.height);
  if (bank) return { ring: bank.line, level: bank.lowLevel };
  const t = d.water / d.depth;
  const ring = d.rim.map(([x, z], i): [number, number] => [x + (d.bottom[i][0] - x) * t, z + (d.bottom[i][1] - z) * t]);
  return { ring, level: ground + (d.low ?? 0) - d.water };
}

/** A pond or ditch to walk into (world/banks.ts bankWater, as its water is made), with its banks when it has them. */
export function addWater(d: DipSpec, ring: [number, number][], level: number, bank?: Bank): void {
  const xs = bank ? [bank.minX, bank.maxX] : ring.map((v) => v[0]);
  const zs = bank ? [bank.minZ, bank.maxZ] : ring.map((v) => v[1]);
  bodies.push({ ring, level, drawn: d.depth - (d.water ?? 0), pond: d.name === 'pond', bank, minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) });
}

function insideRing(x: number, z: number, r: [number, number][]): boolean {
  let hit = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if (r[i][1] > z !== r[j][1] > z && x < ((r[j][0] - r[i][0]) * (z - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) hit = !hit;
  }
  return hit;
}

/** How far (x, z) is from the ring's edge (m). */
function edgeDistance(x: number, z: number, r: [number, number][]): number {
  let best = Infinity;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [ax, az] = r[j];
    const dx = r[i][0] - ax;
    const dz = r[i][1] - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
}

/** The water at a point: its body, its level there, and for one with banks, the bank under it. */
const here = { level: 0, point: { y: 0, level: 0, inset: 0 } as BankPoint };

function bodyAt(x: number, z: number): Body | null {
  for (const b of bodies) {
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
    if (b.bank) {
      // In the water where its level is over the bank (the edge of the water is where the bank comes out of it).
      const p = bankAt(b.bank, x, z, here.point);
      if (!p || p.level <= p.y) continue;
      here.level = p.level;
      return b;
    }
    if (insideRing(x, z, b.ring)) {
      here.level = b.level;
      return b;
    }
  }
  return null;
}

/** The water's surface at (x, z), or null on dry land. */
export function waterLevel(x: number, z: number): number | null {
  return bodyAt(x, z) ? here.level : null;
}

/**
 * Standing at (x, z) on `ground` (world/collision.ts groundAt): in the water, or null when it is dry there (no
 * water, or a bank or footbridge above it). In the water `ground` is changed to what you stand on: a pond's
 * deeper floor, or where you float when it is out of your depth; its `mat` 'water' (wading) or 'swim'.
 */
export function wetGround(x: number, z: number, ground: Ground): Wet | null {
  const b = bodyAt(x, z);
  const level = here.level;
  if (!b || ground.y > level - 0.02) return null;
  let depth = level - ground.y;
  if (b.bank) {
    // A pond deepens on past where its drawn bed reaches its full depth (unseen: the water is dark by then).
    const shelf = here.point.inset - b.bank.shelf;
    if (b.pond && shelf > 0 && ground.y > here.point.y - 0.05) depth = Math.min(POND_DEPTH, Math.max(depth, b.bank.bedDepth + shelf * SHELVE));
  } else if (b.pond && depth > b.drawn - 0.05) {
    // A pond shelves on past its drawn bottom (the bank slopes 1:1 down to it, so that far in from the edge).
    depth = Math.min(POND_DEPTH, Math.max(depth, b.drawn + (edgeDistance(x, z, b.ring) - b.drawn) * SHELVE));
  }
  const swimming = depth > FLOAT;
  ground.y = level - Math.min(depth, FLOAT);
  ground.mat = swimming ? 'swim' : 'water';
  return { level, depth, swimming };
}
