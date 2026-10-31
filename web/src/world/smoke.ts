import * as THREE from 'three';

/**
 * Wood smoke from two chimneys: the house across the street from the main house and the bungalow.
 * Each puff is a small soft disc turned to the camera that rises, grows, drifts off with the
 * wind (from the south-west) and fades; all of it in the vertex shader from one clock, one draw
 * call for both chimneys, no texture (the fragment shader draws the soft, lumpy edge). Puffs are
 * see-through and cost pixels, so Medium and up only.
 */

const PUFFS = 14; // per chimney
const LIFE = 9; // s from the chimney to gone

const vertexShader = /* glsl */ `
  attribute vec3 aSrc;
  attribute float aSeed;
  uniform float uTime;
  uniform vec3 uWind;
  varying vec2 vUv;
  varying float vAlpha;
  varying float vSeed;
  void main() {
    float age = fract(uTime / ${LIFE.toFixed(1)} + aSeed);
    vec3 p = aSrc + vec3(0.0, age * 3.0 + age * age * 1.2, 0.0) + uWind * (age * age * 5.0 + age * 1.2);
    p.x += sin(uTime * 0.7 + aSeed * 20.0) * 0.3 * age;
    p.z += cos(uTime * 0.6 + aSeed * 13.0) * 0.3 * age;
    vec4 mv = viewMatrix * vec4(p, 1.0);
    mv.xy += position.xy * (0.35 + age * 2.1);
    vUv = position.xy + 0.5;
    vAlpha = smoothstep(0.0, 0.08, age) * pow(1.0 - age, 1.4) * 0.5;
    vSeed = aSeed;
    gl_Position = projectionMatrix * mv;
  }`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  varying vec2 vUv;
  varying float vAlpha;
  varying float vSeed;
  void main() {
    vec2 q = vUv - 0.5;
    float r = length(q) * 2.0;
    float a = atan(q.y, q.x);
    float edge = 0.78 + 0.12 * sin(a * 3.0 + vSeed * 30.0) + 0.08 * sin(a * 5.0 - vSeed * 17.0);
    float m = smoothstep(edge, edge * 0.3, r);
    if (m <= 0.002) discard;
    gl_FragColor = vec4(uColor, m * vAlpha);
  }`;

export class Smoke {
  readonly mesh: THREE.Mesh;
  private time = { value: 0 };

  /** `chimneys`: the middle of each chimney's top. */
  constructor(chimneys: THREE.Vector3[]) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const src: number[] = [];
    const seed: number[] = [];
    chimneys.forEach((c, j) => {
      for (let i = 0; i < PUFFS; i++) {
        src.push(c.x, c.y + 0.1, c.z);
        seed.push((i + 0.37 * j + 0.2 * Math.sin(i * 12.9 + j)) / PUFFS);
      }
    });
    g.setAttribute('aSrc', new THREE.InstancedBufferAttribute(new Float32Array(src), 3));
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array(seed), 1));
    g.instanceCount = chimneys.length * PUFFS;
    this.mesh = new THREE.Mesh(
      g,
      new THREE.ShaderMaterial({
        uniforms: { uTime: this.time, uWind: { value: new THREE.Vector3(-0.95, 0.0, 0.3) }, uColor: { value: new THREE.Color(0.6, 0.62, 0.66) } },
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.mesh.frustumCulled = false; // placed by the shader
    this.mesh.renderOrder = 3;
    this.mesh.userData.ignoreRay = true;
  }

  update(dt: number): void {
    this.time.value += dt;
  }
}
