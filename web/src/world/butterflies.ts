import * as THREE from 'three';

/**
 * Butterflies over the borders of the main house and round the bungalow's veranda: small whites,
 * red admirals, peacocks and a brimstone, each wandering its own loops over a bed and beating
 * its wings. Everything happens in the vertex shader from one clock (the CPU does nothing per
 * butterfly), one draw call for all of them; no textures, the wings' markings are drawn by the
 * fragment shader. Medium and up only.
 */

/** Over a bed: its middle on the plan, how far it roams (m) and its kind. */
const ROUNDS: { x: number; z: number; r: number; kind: number }[] = [
  { x: -0.8, z: -14.8, r: 1.3, kind: 0 },
  { x: 3.0, z: -7.4, r: 1.2, kind: 1 },
  { x: 3.6, z: -6.0, r: 1.0, kind: 0 },
  { x: 11.0, z: -1.6, r: 0.9, kind: 3 },
  { x: 11.1, z: 8.0, r: 0.8, kind: 0 },
  { x: 6.2, z: 14.6, r: 1.6, kind: 2 },
  { x: 89.2, z: 196.0, r: 1.4, kind: 0 },
  { x: 92.5, z: 200.5, r: 2.0, kind: 3 },
  { x: 85.0, z: 201.5, r: 1.8, kind: 1 },
];
/** Each kind's ground colour and the colour of its band. */
const KINDS: [string, string][] = [
  ['#f1efe2', '#e9e6d6'], // small white
  ['#1e1917', '#cf4a22'], // red admiral
  ['#8a3320', '#26252f'], // peacock
  ['#e4d96a', '#d6cb58'], // brimstone
];

const vertexShader = /* glsl */ `
  attribute float aWing;
  attribute vec3 aHome;
  attribute vec4 aParam; // seed, how far it roams, speed, height above the ground
  attribute vec3 aCol;
  attribute vec3 aCol2;
  uniform float uTime;
  varying vec2 vUv;
  varying vec3 vCol;
  varying vec3 vCol2;
  varying float vShade;

  vec3 path(float t, vec4 p) {
    float s = p.x;
    return vec3(
      sin(t * 0.61 + s) * p.y + sin(t * 1.73 + s * 2.1) * p.y * 0.35,
      p.w + sin(t * 1.9 + s * 3.0) * 0.16 + sin(t * 0.37 + s) * 0.12,
      cos(t * 0.47 + s * 1.3) * p.y + cos(t * 1.31 + s * 0.7) * p.y * 0.35);
  }

  void main() {
    float t = uTime * aParam.z + aParam.x * 37.0;
    vec3 at = aHome + path(t, aParam);
    vec3 d = aHome + path(t + 0.08, aParam) - at;
    float yaw = atan(d.x, d.z);
    // Quick beats with the wings held up between them now and then.
    float beat = sin(uTime * (8.0 + fract(aParam.x * 7.3) * 4.0) * 6.2832 + aParam.x * 10.0);
    float rest = smoothstep(0.6, 0.9, sin(uTime * 0.9 + aParam.x * 5.0));
    float a = mix(0.25 + 1.05 * beat, 1.35, rest);
    vec3 p = position;
    if (aWing != 0.0) {
      float span = abs(p.x);
      p = vec3(aWing * span * cos(a), span * sin(a), p.z);
    }
    float cy = cos(yaw);
    float sy = sin(yaw);
    p = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);
    vUv = uv;
    vCol = aCol;
    vCol2 = aCol2;
    vShade = 0.8 + 0.35 * cos(a);
    gl_Position = projectionMatrix * viewMatrix * vec4(at + p, 1.0);
  }`;

const fragmentShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vCol;
  varying vec3 vCol2;
  varying float vShade;
  void main() {
    if (vUv.x < 0.0) {
      gl_FragColor = vec4(vec3(0.03), 1.0); // the body
      return;
    }
    // A rounded wing: wide at the front, narrower behind; a band across it, a dark rim.
    vec2 q = vec2(vUv.x, (vUv.y - 0.45) * (1.25 + vUv.y * 0.6));
    float edge = length(q * vec2(1.0, 1.9));
    if (edge > 1.0) discard;
    vec3 col = mix(vCol, vCol2, smoothstep(0.42, 0.5, vUv.x) * (1.0 - smoothstep(0.66, 0.74, vUv.x)) * step(vUv.y, 0.7));
    col = mix(col, vec3(0.04), smoothstep(0.82, 0.97, edge) * 0.8);
    gl_FragColor = vec4(col * vShade * 1.25, 1.0);
  }`;

/** Two wings (span along x, chord along z, 3.2 cm out) and a thin body, as one small shape. */
function shape(): THREE.InstancedBufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const wing: number[] = [];
  const quad = (pts: number[][], uvs: number[][], w: number) => {
    for (const k of [0, 1, 2, 0, 2, 3]) {
      pos.push(...pts[k]);
      uv.push(...uvs[k]);
      wing.push(w);
    }
  };
  for (const s of [-1, 1]) {
    // Both faces, so the wing shows from below too.
    const pts = [[0, 0, 0.023], [s * 0.032, 0, 0.023], [s * 0.032, 0, -0.025], [0, 0, -0.025]];
    const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
    quad(pts, uvs, s);
    quad([pts[3], pts[2], pts[1], pts[0]], [uvs[3], uvs[2], uvs[1], uvs[0]], s);
  }
  const body = [[-0.002, 0.001, 0.016], [0.002, 0.001, 0.016], [0.002, 0.001, -0.018], [-0.002, 0.001, -0.018]];
  const buv = [[-1, 0], [-1, 0], [-1, 0], [-1, 0]];
  quad(body, buv, 0);
  quad([body[3], body[2], body[1], body[0]], buv, 0);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(wing, 1));
  return g;
}

export class Butterflies {
  readonly mesh: THREE.Mesh;
  private time = { value: 0 };

  constructor(groundY: (x: number, z: number) => number) {
    const g = shape();
    const home: number[] = [];
    const param: number[] = [];
    const col: number[] = [];
    const col2: number[] = [];
    ROUNDS.forEach((r, i) => {
      home.push(r.x, groundY(r.x, r.z), r.z);
      param.push(i * 1.7 + 0.3, r.r, 0.55 + (i % 3) * 0.12, 0.55 + (i % 4) * 0.12);
      const [a, b] = KINDS[r.kind].map((h) => new THREE.Color(h));
      col.push(a.r, a.g, a.b);
      col2.push(b.r, b.g, b.b);
    });
    g.setAttribute('aHome', new THREE.InstancedBufferAttribute(new Float32Array(home), 3));
    g.setAttribute('aParam', new THREE.InstancedBufferAttribute(new Float32Array(param), 4));
    g.setAttribute('aCol', new THREE.InstancedBufferAttribute(new Float32Array(col), 3));
    g.setAttribute('aCol2', new THREE.InstancedBufferAttribute(new Float32Array(col2), 3));
    g.instanceCount = ROUNDS.length;
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: { uTime: this.time }, vertexShader, fragmentShader }));
    this.mesh.frustumCulled = false; // placed by the shader
    this.mesh.userData.ignoreRay = true;
  }

  update(dt: number): void {
    this.time.value += dt;
  }
}
