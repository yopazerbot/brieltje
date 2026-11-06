import * as THREE from 'three';

/**
 * The ponds' and ditches' water: a dark green mirror of the sky, now ruffled by the wind. Five
 * trains of small waves (40 cm to a metre and a half long, running about downwind at the
 * speed such waves have) tilt the surface's normal in the fragment shader, so the reflected clouds
 * shimmer; nothing is moved. Gusts drift across it as calmer and rougher patches. Each train fades
 * out where its waves get too small on screen to draw (no glitter in the distance), and the water
 * turns a little less glossy there instead. One material for every pond, its clock set as it is drawn.
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

/** The water's material, shared by every pond. */
export function waterMaterial(): THREE.MeshStandardMaterial {
  if (material) return material;
  const m = new THREE.MeshStandardMaterial({ color: '#3c4a3e', roughness: 0.06, metalness: 0.15 });
  m.name = 'water';
  m.onBeforeCompile = (shader) => {
    shader.uniforms.waterTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWater;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWater = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float waterTime;
        varying vec2 vWater;
        // One train of waves: adds its slope at p to grad, and how much of it is drawn to fade.
        void ripple(vec2 p, vec2 k, float w, float a, float phase, float px, inout vec2 grad, inout float fade) {
          float keep = clamp(1.0 - px * length(k) * 0.35, 0.0, 1.0); // gone at two pixels a wave
          grad += k * a * cos(dot(k, p) - w * waterTime + phase) * keep;
          fade += keep;
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
          normal = normalize((viewMatrix * vec4(-grad.x, 1.0, -grad.y, 0.0)).xyz);
          roughnessFactor = mix(0.11, roughnessFactor, fade / ${WAVES.length.toFixed(1)});
        }`,
      );
  };
  material = m;
  return m;
}

/** Keeps the waves moving: call as the water is drawn (a mesh's onBeforeRender). */
export function waterClock(): void {
  time.value = performance.now() / 1000;
}
