import * as THREE from 'three';

/**
 * The soft shadows of figures (players, villagers and their dogs and bikes, zombies) where the sun's shadow maps
 * don't draw them: beyond the maps' reach, everywhere on Low and phones, and always for the villagers and zombies (they
 * aren't skinned again in the shadow pass: thirty of them cost about 1.7 ms on Low). As capsule shadows in big games:
 * not a dark disc under the feet but the shape the body throws, lying away from the sun along the ground, as long as
 * the sun is low (its height says it; at most four times the figure's height), its edge softer and the shadow
 * fainter towards its end, where a real shadow's penumbra widens. Under it a small soft dark patch where the feet
 * stand (the sky's light hidden there), which is all there is under clouds.
 *
 * One instanced draw of quads per kind, laid on the ground in the vertex shader round the swept shape: each module
 * sets an instance's matrix as it did for its round patch (the place on the ground, the turn, the footprint's width
 * and depth in x and z) and puts the figure's height in its y scale. How dark: the sun's share of the light on open
 * ground (world/weather.ts sets it), so a figure's shadow is as dark as a house's next to it.
 *
 * `casts`: the figures throw a real shadow inside the maps (the players), so their swept shape fades out where the
 * outer map reaches (world/sunShadow.ts uniforms, the band where the map fades out) and only the patch stays.
 */

/** Shared by every kind: where the sun is and how strong its shadow, and where the real-time maps reach. */
export const figureSun = {
  /** x, z: along the ground away from the sun; y: the shadow's length per metre of height */
  figureAway: { value: new THREE.Vector3(0, 0, 0) },
  /** The sun's share of the light on open ground (0 under clouds) */
  figureCast: { value: 0 },
  liveMatrix: { value: new THREE.Matrix4() },
  liveOn: { value: 0 },
};

/** The longest shadow, per metre of height (the sun at about 14 degrees) */
const LONGEST = 4;

/** Each frame from world/weather.ts: `toSun` the unit direction to the sun; `share` the sun's share of the ground's light. */
export function setFigureSun(toSun: THREE.Vector3, share: number): void {
  const across = Math.hypot(toSun.x, toSun.z);
  const up = toSun.y;
  const v = figureSun.figureAway.value;
  if (up < 0.05 || across < 1e-4) v.set(0, 0, 0);
  else v.set(-toSun.x / across, Math.min(LONGEST, across / up), -toSun.z / across);
  figureSun.figureCast.value = up < 0.05 ? 0 : Math.max(0, Math.min(0.85, share));
}

/** The outer real-time shadow map (world/sunShadow.ts uniforms): the same objects, so they follow it. */
export function followLiveShadow(u: { liveMatrix: { value: THREE.Matrix4 }; liveOn: { value: number } }): void {
  figureSun.liveMatrix = u.liveMatrix;
  figureSun.liveOn = u.liveOn;
  for (const m of materials) {
    m.uniforms.liveMatrix = u.liveMatrix;
    m.uniforms.liveOn = u.liveOn;
  }
}

const VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
uniform vec3 figureAway;
uniform float figureCast;
uniform mat4 liveMatrix;
uniform float liveOn;
uniform float casts;
varying vec2 vLocal;
varying vec2 vSeg;
varying float vCast;
void main() {
  vec3 c = instanceMatrix[3].xyz;
  vec2 a = instanceMatrix[0].xz * 0.5; // the footprint's half axes on the ground
  vec2 b = instanceMatrix[2].xz * 0.5;
  float h = length(instanceMatrix[1].xyz);
  float r = max(length(a), length(b));
  if (min(length(a), length(b)) < 0.005) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; } // faded to nothing: outside the view
  vec2 d = figureAway.xz;
  float len = h * figureAway.y;
  // The cast part: none inside the real-time map for those that throw a real shadow there.
  float strength = figureCast;
  if (casts > 0.5 && liveOn > 0.5) {
    vec3 q = abs((liveMatrix * vec4(c, 1.0)).xyz);
    strength *= smoothstep(0.82, 0.96, max(max(q.x, q.y), q.z));
  }
  if (strength < 0.004) len = 0.0;
  vec2 p = vec2(-d.y, d.x);
  if (len == 0.0) { d = vec2(1.0, 0.0); p = vec2(0.0, 1.0); }
  // The quad round the footprint swept along the shadow, a little wider towards its end (the penumbra).
  float u = mix(-r * 1.25, len + r * 1.4, position.x + 0.5);
  float v = position.z * 2.0 * (r * 1.25 + len * 0.1);
  vec2 w = c.xz + d * u + p * v;
  mat2 toLocal = inverse(mat2(a, b));
  vLocal = toLocal * (w - c.xz);
  vSeg = toLocal * (d * len);
  vCast = strength;
  vec4 mvPosition = viewMatrix * vec4(w.x, c.y, w.y, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform float contact;
varying vec2 vLocal;
varying vec2 vSeg;
varying float vCast;
void main() {
  float shade = 0.0;
  // The body's shadow: round the line from the feet to the end, narrower towards the head, softer and fainter there.
  float segLen2 = dot(vSeg, vSeg);
  if (vCast > 0.0 && segLen2 > 1e-4) {
    float t = clamp(dot(vLocal, vSeg) / segLen2, 0.0, 1.0);
    float dist = length(vLocal - vSeg * t);
    float rad = mix(0.62, 0.42, t);
    float soft = 0.18 + 0.55 * t;
    float body = 1.0 - smoothstep(rad - soft, rad + soft, dist);
    // The end rounded off softly (the head), and the foot end not behind the feet.
    float along = dot(vLocal, vSeg) / segLen2;
    body *= 1.0 - smoothstep(0.85, 1.12, along);
    shade = body * vCast * (1.0 - 0.45 * t);
  }
  // Where the feet stand.
  float feet = (1.0 - smoothstep(0.2, 1.0, length(vLocal))) * contact;
  float a = 1.0 - (1.0 - shade) * (1.0 - feet);
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      a *= exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      a *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  #endif
  if (a < 0.003) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}`;

const materials: THREE.ShaderMaterial[] = [];

/**
 * An instanced mesh of `n` soft shadows: one draw for a kind. `contact`: how dark the patch under the feet is at its
 * middle; `casts`: these figures throw a real shadow inside the maps (see above).
 */
export function figureShadowMesh(n: number, contact: number, casts = false): THREE.InstancedMesh {
  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { contact: { value: contact }, casts: { value: casts ? 1 : 0 } }]),
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  // The shared ones by reference (merge copies values).
  Object.assign(material.uniforms, figureSun);
  materials.push(material);
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), material, n);
  mesh.count = 0;
  mesh.frustumCulled = false; // spread over the area: one draw, a few pixels each
  mesh.renderOrder = 1;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.ignoreRay = true;
  mesh.userData.noAO = true;
  mesh.raycast = () => {};
  return mesh;
}
