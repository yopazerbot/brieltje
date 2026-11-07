import * as THREE from 'three';
import type { Ground } from './collision';
import type { DipSpec } from './houseData';
import { mood } from './mood';

/**
 * The ponds' and ditches' water: a dark green mirror of the sky, now ruffled by the wind. Five
 * trains of small waves (40 cm to a metre and a half long, running about downwind at the
 * speed such waves have) tilt the surface's normal in the fragment shader, so the reflected clouds
 * shimmer; nothing is moved. Gusts drift across it as calmer and rougher patches. Each train fades
 * out where its waves get too small on screen to draw (no glitter in the distance), and the water
 * turns a little less glossy there instead. One material for every pond, its clock set as it is drawn.
 *
 * In the rain, on Medium and up, drops dot the water near you with small rings (the same shader: one
 * drop at a time in each half-metre cell, two layers of cells), nothing on Low or on a phone.
 *
 * Also where the water is, for walking into it (player.ts): every pond and ditch keeps its outline at the
 * water line and its level. A ditch is as deep as it is drawn (about half a metre at most); a pond shelves
 * on under its drawn bottom to 1.8 m in the middle, deep enough to swim in. The water is opaque, so the
 * deeper middle needs no drawing.
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

let material: THREE.MeshStandardMaterial | null = null;
const time = { value: 0 };
/** How hard it rains on the water now (0 to 1), 0 on Low */
const rain = { value: 0 };
let detail = true;

/** The water's material, shared by every pond. */
export function waterMaterial(): THREE.MeshStandardMaterial {
  if (material) return material;
  const m = new THREE.MeshStandardMaterial({ color: '#3c4a3e', roughness: 0.06, metalness: 0.15 });
  m.name = 'water';
  m.onBeforeCompile = (shader) => {
    shader.uniforms.waterTime = time;
    shader.uniforms.waterRain = rain;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWater;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWater = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float waterTime;
        uniform float waterRain;
        varying vec2 vWater;
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
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          vec2 p = vWater;
          float px = length(fwidth(p));
          vec2 grad = vec2(0.0);
          float fade = 0.0;
          ${waves}
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
      );
  };
  material = m;
  return m;
}

/** Keeps the waves moving: call as the water is drawn (a mesh's onBeforeRender). */
export function waterClock(): void {
  time.value = performance.now() / 1000;
  rain.value = detail ? raining() : 0;
}

/** How hard it rains now: the rain mood's share of what is shown (world/mood.ts). */
function raining(): number {
  return (mood.current === 'rain' ? 1 - mood.blend : 0) + (mood.next === 'rain' && mood.next !== mood.current ? mood.blend : 0);
}

/** Rain rings on the water: on for Medium and up, off on Low and on phones (main.ts applyQuality). */
export function setWaterDetail(on: boolean): void {
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

/** A pond's or ditch's outline at the water line (the rim moved in towards the bottom), and its level. */
export function waterLine(d: DipSpec, ground: number): { ring: [number, number][]; level: number } | null {
  if (!d.water) return null;
  const t = d.water / d.depth;
  const ring = d.rim.map(([x, z], i): [number, number] => [x + (d.bottom[i][0] - x) * t, z + (d.bottom[i][1] - z) * t]);
  return { ring, level: ground + (d.low ?? 0) - d.water };
}

/** A pond or ditch to walk into (world/surroundings.ts waterMesh, as its water is made). */
export function addWater(d: DipSpec, ring: [number, number][], level: number): void {
  const xs = ring.map((v) => v[0]);
  const zs = ring.map((v) => v[1]);
  bodies.push({ ring, level, drawn: d.depth - (d.water ?? 0), pond: d.name === 'pond', minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) });
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

function bodyAt(x: number, z: number): Body | null {
  for (const b of bodies) if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && insideRing(x, z, b.ring)) return b;
  return null;
}

/** The water's surface at (x, z), or null on dry land. */
export function waterLevel(x: number, z: number): number | null {
  return bodyAt(x, z)?.level ?? null;
}

/**
 * Standing at (x, z) on `ground` (world/collision.ts groundAt): in the water, or null when it is dry there (no
 * water, or a bank or footbridge above it). In the water `ground` is changed to what you stand on: a pond's
 * deeper floor, or where you float when it is out of your depth; its `mat` 'water' (wading) or 'swim'.
 */
export function wetGround(x: number, z: number, ground: Ground): Wet | null {
  const b = bodyAt(x, z);
  if (!b || ground.y > b.level - 0.02) return null;
  let depth = b.level - ground.y;
  // A pond shelves on past its drawn bottom (the bank slopes 1:1 down to it, so that far in from the edge).
  if (b.pond && depth > b.drawn - 0.05) depth = Math.min(POND_DEPTH, Math.max(depth, b.drawn + (edgeDistance(x, z, b.ring) - b.drawn) * SHELVE));
  const swimming = depth > FLOAT;
  ground.y = b.level - Math.min(depth, FLOAT);
  ground.mat = swimming ? 'swim' : 'water';
  return { level: b.level, depth, swimming };
}
