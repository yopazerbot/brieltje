import * as THREE from 'three';

/**
 * Falling snow (world/weather.ts turns it on), round the eye like the rain (world/rain.ts): flakes drifting down
 * slowly, swaying, each its own way. One draw call of points: each flake has a fixed spot in a box of BOX metres
 * that moves with the eye, the vertex shader lets it fall and sway and wraps it round the box, so the flakes keep
 * their place in the world as you walk through them. A flake is a soft round dot, larger the nearer it is, a few
 * pixels across at most a few metres off: the graphics chip only shades those. Fewer on Low and on phones. None
 * indoors. Snow makes no sound of its own: the world goes quieter (world/ambience.ts, world/birdsong.ts).
 */

/** Metres across (x, z) and high (y) of the box of flakes round the eye. */
const BOX = new THREE.Vector3(32, 16, 32);
/** Metres a second the flakes fall. */
const SPEED = 1.1;
/** The fall wraps round after this many metres: a whole number of boxes down and sideways, at each of the speeds. */
const WRAP = 1280;
/** A flake's size (m), drawn a little larger than a real one so it reads at a distance. */
const FLAKE = 0.03;

const vertexShader = /* glsl */ `
  attribute vec4 seed;
  uniform vec3 box;
  uniform vec3 eye;
  uniform float fall;
  uniform float time;
  uniform float scale;
  varying float vAlpha;
  void main() {
    // The flake's place, falling and swaying (each its own pace), wrapped into the box round the eye.
    float k = seed.w * 6.2832;
    vec3 p = seed.xyz * box;
    p.y -= fall * (0.75 + 0.125 * floor(fract(seed.w * 13.7) * 4.0)); // four speeds
    p.x += sin(time * (0.5 + 0.3 * fract(seed.w * 7.1)) + k) * 0.7 + fall * 0.125;
    p.z += cos(time * (0.4 + 0.3 * fract(seed.w * 5.3)) + k * 1.7) * 0.6 + fall * 0.05;
    vec3 corner = eye - box * 0.5;
    vec3 world = corner + mod(p - corner, box);
    // Fade out towards the box's sides and top, so flakes don't pop in and out at its edges.
    vec2 off = abs(world.xz - eye.xz) / (box.xz * 0.5);
    float edge = 1.0 - smoothstep(0.6, 1.0, max(off.x, off.y));
    edge *= 1.0 - smoothstep(0.6, 1.0, abs(world.y - eye.y) / (box.y * 0.5));
    vec4 view = viewMatrix * vec4(world, 1.0);
    float size = ${FLAKE} * (0.6 + 0.8 * fract(seed.w * 3.1)) * scale / max(0.3, -view.z);
    // Under two pixels it stays two, fainter (a smaller dot would flicker).
    vAlpha = edge * clamp(size / 2.0, 0.15, 1.0);
    gl_PointSize = clamp(size, 2.0, 24.0);
    gl_Position = projectionMatrix * view;
  }`;

const fragmentShader = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  varying float vAlpha;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float a = (1.0 - smoothstep(0.35, 1.0, r)) * vAlpha * opacity;
    if (a < 0.01) discard;
    gl_FragColor = vec4(color, a);
  }`;

export class Snow {
  readonly mesh: THREE.Points;
  private uniforms = {
    box: { value: BOX.clone() },
    eye: { value: new THREE.Vector3() },
    fall: { value: 0 },
    time: { value: 0 },
    scale: { value: 800 },
    color: { value: new THREE.Color(1, 1, 1) },
    opacity: { value: 0 },
  };
  private geometry = new THREE.BufferGeometry();
  private count = 0;
  /** 0 to 1: how hard it snows (the weather's), and how much of it is seen (out of doors) */
  private amount = 0;
  private seen = 0;
  private size = new THREE.Vector2();

  constructor() {
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Points(this.geometry, material);
    this.mesh.name = 'snow';
    this.mesh.frustumCulled = false; // round the eye, wherever it is
    this.mesh.visible = false;
    this.mesh.renderOrder = 50;
    this.mesh.raycast = () => {}; // never in the way of a shot
    this.mesh.userData.noAO = true;
  }

  /** How many flakes: from the graphics preset (fewer on Low and on phones). */
  setCount(n: number): void {
    if (n === this.count) return;
    this.count = n;
    const seed = new Float32Array(n * 4);
    for (let i = 0; i < seed.length; i++) seed[i] = Math.random();
    this.geometry.dispose();
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3)); // not read: the draw count
    this.geometry.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
    this.mesh.geometry = this.geometry;
  }

  /** How hard it snows, 0 (none) to 1. */
  set(amount: number): void {
    this.amount = amount;
  }

  /**
   * Each frame: the eye, whether it is indoors (no flakes there), the light on them, and the renderer (its height in
   * pixels sets how large a flake is drawn).
   */
  update(dt: number, eye: THREE.Vector3, indoors: boolean, brightness: number, renderer: THREE.WebGLRenderer): void {
    this.seen += ((indoors ? 0 : this.amount) - this.seen) * (1 - Math.exp(-dt * 3));
    if (this.seen < 0.01 && !this.amount) this.seen = 0;
    this.mesh.visible = this.seen > 0.01;
    if (!this.mesh.visible) return;
    const u = this.uniforms;
    u.eye.value.copy(eye);
    u.fall.value = (u.fall.value + dt * SPEED) % WRAP;
    u.time.value = (u.time.value + dt) % 10000;
    // Pixels per metre at a metre off, for the usual field of view (72 degrees high).
    u.scale.value = renderer.getDrawingBufferSize(this.size).y / (2 * Math.tan((36 * Math.PI) / 180));
    u.opacity.value = 0.85 * this.seen;
    u.color.value.setRGB(1, 1, 1).multiplyScalar(brightness);
  }
}
