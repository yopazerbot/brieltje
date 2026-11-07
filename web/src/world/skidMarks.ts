import * as THREE from 'three';

/**
 * Dark tyre marks on the road where a car slid hard (world/car.ts: the handbrake, a sharp turn at
 * speed, a hard stop). Each mark is a short strip from where the tyre was to where it is, laid on the
 * ground: all of them one instanced draw call of a few pixels, from a pool where the oldest makes room
 * for the newest. A mark stays dark for half a minute, then fades out in the vertex shader (no work on
 * the CPU while it fades). Every page lays its own marks from the cars it sees, so nothing goes over
 * the network.
 */

const MAX = 1024;
/** Seconds a mark stays at full strength, then how long it takes to fade. */
const HOLD = 30;
const FADE = 15;
/** The tyre's width (m) and how far above the ground the mark lies (with a polygon offset). */
const WIDTH = 0.24;
const LIFT = 0.012;
/** The darkest a mark gets (its alpha at full strength). */
const DARK = 0.6;

/** The tyre's tread across the strip: streaks of rubber, soft at the edges. */
function treadTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 4;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 32; i++) {
    const u = (i + 0.5) / 32;
    const edge = Math.min(1, Math.min(u, 1 - u) / 0.18);
    const streak = 0.65 + 0.35 * Math.abs(Math.sin(i * 2.7) * Math.cos(i * 1.3));
    g.fillStyle = `rgba(12,12,12,${(edge * streak).toFixed(3)})`;
    g.fillRect(i, 0, 1, 4);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

class SkidMarks {
  private pool: THREE.InstancedMesh | null = null;
  /** Per mark: when it was laid (s, on this page's clock) and how dark. */
  private marks: THREE.InstancedBufferAttribute | null = null;
  private time = { value: 0 };
  private next = 0;
  private m = new THREE.Matrix4();

  /** The pool's mesh, made once (main.ts adds it to the scene). */
  get mesh(): THREE.InstancedMesh {
    if (this.pool) return this.pool;
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2); // x across, z along the strip, facing up
    this.marks = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 2), 2).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aMark', this.marks);
    const material = new THREE.MeshBasicMaterial({
      map: treadTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.time;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aMark;\nuniform float uTime;\nvarying float vMark;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>\nvMark = aMark.y * clamp(1.0 - (uTime - aMark.x - ${HOLD.toFixed(1)}) / ${FADE.toFixed(1)}, 0.0, 1.0);`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vMark;')
        .replace('#include <alphatest_fragment>', '#include <alphatest_fragment>\ndiffuseColor.a *= vMark;');
    };
    const mesh = (this.pool = new THREE.InstancedMesh(geo, material, MAX));
    mesh.count = 0;
    mesh.frustumCulled = false; // marks lie all over; one small draw call
    mesh.renderOrder = 1;
    mesh.userData.ignoreRay = true;
    mesh.raycast = () => {};
    mesh.onBeforeRender = () => {
      this.time.value = performance.now() / 1000;
    };
    return mesh;
  }

  /** A strip from (x0, y0, z0) to (x1, y1, z1) on the ground, `strength` 0 to 1. */
  lay(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, strength: number): void {
    const mesh = this.mesh;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dy, dz);
    if (!(len > 0.05) || !(strength > 0)) return;
    // Its own axes: across (x), up (y), along (z), so it lies on a slope too.
    const ax = dx / len;
    const ay = dy / len;
    const az = dz / len;
    let sx = az;
    let sz = -ax;
    const s = Math.hypot(sx, sz) || 1;
    sx /= s;
    sz /= s;
    // Up: along times across, written out for across = (sx, 0, sz).
    const ux = ay * sz;
    const uy = az * sx - ax * sz;
    const uz = -ay * sx;
    // End to end: an overlap would show as a darker joint.
    const l = len;
    this.m.set(
      sx * WIDTH, ux, ax * l, (x0 + x1) / 2,
      0, uy, ay * l, (y0 + y1) / 2 + LIFT,
      sz * WIDTH, uz, az * l, (z0 + z1) / 2,
      0, 0, 0, 1,
    );
    const i = this.next;
    this.next = (this.next + 1) % MAX;
    mesh.count = Math.max(mesh.count, i + 1);
    mesh.setMatrixAt(i, this.m);
    this.marks!.setXY(i, performance.now() / 1000, DARK * Math.min(1, strength));
    mesh.instanceMatrix.needsUpdate = true;
    this.marks!.needsUpdate = true;
  }
}

/** The one pool for all cars. */
export const skidMarks = new SkidMarks();
