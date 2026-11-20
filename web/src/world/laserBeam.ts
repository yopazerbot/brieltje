import * as THREE from 'three';

/**
 * The laser rifle's beams (weapon.ts, effects.ts laser): a straight line of light from the emitter to where the
 * shot ended, drawn for a few frames and fading. Not a tracer that flies: the whole line is there at once, as a
 * beam is. A thin bright core, nearly white, in a soft glow of the beam's colour; the game's bloom (Medium and up)
 * spreads the core's light round it. Everything stays a few units bright: well under the half-float limit.
 *
 * All beams are one instanced draw: a flat ribbon per beam, turned in the vertex shader to face the eye along its
 * length, and never thinner on screen than a pixel or so for the core and a few for the glow, so a beam 100 m off
 * still reads as a line instead of flickering away. Additive, no depth written; the world in front hides it.
 * Cost: a few thin ribbons of pixels for a fifth of a second per shot.
 */

const MAX = 24;
/** s a beam is drawn: a flash for its first moment, then it fades and widens a little as it dies away */
const LIFE = 0.24;
const FLASH = 0.035;

const vertex = /* glsl */ `
attribute vec3 aStart;
attribute vec3 aEnd;
attribute vec3 aColor;
attribute vec2 aLook;
uniform float uPx;
varying float vAcross;
varying float vCore;
varying vec3 vColor;
varying float vBright;
varying float vAlong;
void main() {
  vec3 a = (viewMatrix * vec4(aStart, 1.0)).xyz;
  vec3 b = (viewMatrix * vec4(aEnd, 1.0)).xyz;
  vec3 dir = b - a;
  float len = max(length(dir), 1e-4);
  // position.x: metres from the emitter (position.z 0), or the far end (position.z 1).
  float s = position.z > 0.5 ? len : min(position.x, len);
  vec3 p = a + dir * (s / len);
  vec3 side = cross(dir, p);
  float sl = length(side);
  side = sl > 1e-6 ? side / sl : vec3(0.0, 1.0, 0.0);
  float dist = max(-p.z, 0.05);
  // Tight as it leaves the lens, its full width a few metres out; and at least a pixel or so for the core and a few
  // for the glow (uPx: metres per pixel at a metre), so it never thins away in the distance.
  float focus = mix(0.1, 1.0, smoothstep(0.0, 2.5, s));
  float glowW = max(0.03 * aLook.y * focus, dist * uPx * 4.0);
  float coreW = max(0.0035 * aLook.y * focus, dist * uPx * 0.9);
  vCore = min(0.9, coreW / glowW);
  p += side * position.y * glowW;
  vAcross = position.y;
  vAlong = s;
  vColor = aColor;
  vBright = aLook.x;
  gl_Position = projectionMatrix * vec4(p, 1.0);
}`;

const fragment = /* glsl */ `
varying float vAcross;
varying float vCore;
varying vec3 vColor;
varying float vBright;
varying float vAlong;
void main() {
  float a = abs(vAcross);
  float core = 1.0 - smoothstep(vCore * 0.4, vCore, a);
  float glow = pow(max(0.0, 1.0 - a), 3.0);
  // The first centimetres out of the emitter come up from nothing: no hard end at the gun.
  float start = smoothstep(0.0, 0.02, vAlong);
  vec3 col = (mix(vColor, vec3(1.0), 0.7) * core * 2.6 + vColor * glow * 0.8) * vBright * start;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

interface Beam {
  age: number;
  life: number;
}

export class LaserBeams {
  readonly mesh: THREE.Mesh;
  private beams: (Beam | null)[] = Array.from({ length: MAX }, () => null);
  private next = 0;
  private start: THREE.InstancedBufferAttribute;
  private end: THREE.InstancedBufferAttribute;
  private color: THREE.InstancedBufferAttribute;
  private look: THREE.InstancedBufferAttribute;
  private size = new THREE.Vector2();

  constructor(scene: THREE.Scene) {
    const geo = new THREE.InstancedBufferGeometry();
    // A ribbon: y across it (-1..1); along it, x metres from the emitter where it narrows (z 0), then its far end (z 1).
    const along = [0, 0.15, 0.5, 1.2, 2.5];
    const pos: number[] = [];
    for (const x of along) pos.push(x, -1, 0, x, 1, 0);
    pos.push(0, -1, 1, 0, 1, 1);
    const index: number[] = [];
    for (let k = 0; k < along.length; k++) index.push(2 * k, 2 * k + 2, 2 * k + 3, 2 * k, 2 * k + 3, 2 * k + 1);
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(index);
    const attr = (n: number) => new THREE.InstancedBufferAttribute(new Float32Array(MAX * n), n).setUsage(THREE.DynamicDrawUsage);
    this.start = attr(3);
    this.end = attr(3);
    this.color = attr(3);
    this.look = attr(2);
    geo.setAttribute('aStart', this.start);
    geo.setAttribute('aEnd', this.end);
    geo.setAttribute('aColor', this.color);
    geo.setAttribute('aLook', this.look);
    geo.instanceCount = 0;
    const uniforms = { uPx: { value: 0.001 } };
    const material = new THREE.ShaderMaterial({
      uniforms, vertexShader: vertex, fragmentShader: fragment,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.userData.ignoreRay = true;
    this.mesh.raycast = () => {};
    this.mesh.visible = false;
    // How many metres one pixel is at a metre from the eye, for the beam's least width on screen.
    this.mesh.onBeforeRender = (renderer, _scene, camera) => {
      const cam = camera as THREE.PerspectiveCamera;
      renderer.getDrawingBufferSize(this.size);
      if (cam.isPerspectiveCamera && this.size.y > 0) uniforms.uPx.value = (2 * Math.tan((cam.fov * Math.PI) / 360)) / (cam.zoom * this.size.y);
    };
    scene.add(this.mesh);
  }

  /** A beam from `from` to `to`, `color` its glow's (linear; the core is nearly white). */
  fire(from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color): void {
    const i = this.next;
    this.next = (this.next + 1) % MAX;
    this.beams[i] = { age: 0, life: LIFE };
    this.start.setXYZ(i, from.x, from.y, from.z);
    this.end.setXYZ(i, to.x, to.y, to.z);
    this.color.setXYZ(i, color.r, color.g, color.b);
    this.look.setXY(i, 1.2, 1);
    this.start.needsUpdate = this.end.needsUpdate = this.color.needsUpdate = this.look.needsUpdate = true;
    const geo = this.mesh.geometry as THREE.InstancedBufferGeometry;
    geo.instanceCount = Math.max(geo.instanceCount, i + 1);
    this.mesh.visible = true;
  }

  update(dt: number): void {
    if (!this.mesh.visible) return;
    let live = false;
    for (let i = 0; i < MAX; i++) {
      const b = this.beams[i];
      if (!b) continue;
      b.age += dt;
      if (b.age >= b.life) {
        this.beams[i] = null;
        this.look.setXY(i, 0, 1);
        continue;
      }
      live = true;
      // A flash, then it fades and spreads a little as it goes.
      const t = Math.max(0, (b.age - FLASH) / (b.life - FLASH));
      this.look.setXY(i, b.age < FLASH ? 1.2 : (1 - t) * (1 - t), 1 + t * 1.5);
    }
    this.look.needsUpdate = true;
    if (!live) {
      this.mesh.visible = false;
      (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = 0;
      this.next = 0;
    }
  }
}
