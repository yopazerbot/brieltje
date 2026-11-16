import * as THREE from 'three';

/**
 * Trees lit from below at night (Yoshi, 16 Nov 2026: home 4's two young trees, "Ground spotlights"): a spotlight sunk
 * in the ground before each tree (drawn in the model, tools/kapellenhoek_home.py) shines up its trunk into the
 * underside of its crown; and the wall lantern over the front door glows. The model names them in its extras:
 * `uplights` ({ at: the spot's lens, tree: the trunk's x and z, h: the tree's height, r: its crown's radius }) and
 * `lantern` (its glass's middle), all in the game's heights.
 *
 * No real lights, as the street lamps (world/streetLights.ts): each lens and the lantern a small round glow turned to
 * the eye, added onto what is drawn; each beam an upright quad turned to the eye round the trunk, a little in front of
 * the crown, that brightens what is drawn behind it by a factor (light falling on the leaves' and the bark's own
 * colour, so they stay what they are, only lit), in the shape of a beam widening upwards. Two draw calls for all, a
 * few arithmetic steps a pixel and no texture, on every preset. Hidden by day. Every value far under what half floats hold.
 */

/** Warm white of the spots and the lantern (linear). */
const WARM = new THREE.Color(1.0, 0.74, 0.46);
/** How many times brighter the beam makes what it falls on, at its brightest. */
const BEAM = 5;

const glowVertex = /* glsl */ `
  attribute float glowSize;
  varying vec2 vUv;
  void main() {
    vUv = uv - 0.5;
    vec4 centre = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    centre.z += 0.2; // a little towards the eye: not cut by the wall or the soil it sits in
    centre.xy += position.xy * glowSize; // turned to the eye
    gl_Position = projectionMatrix * centre;
  }`;
const glowFragment = /* glsl */ `
  uniform vec3 color;
  uniform float strength;
  varying vec2 vUv;
  void main() {
    float r = length(vUv) * 2.0;
    float glow = (exp(-r * r * 14.0) * 2.4 + exp(-r * r * 3.0) * 0.3) * (1.0 - smoothstep(0.6, 1.0, r));
    gl_FragColor = vec4(color * glow * strength, 1.0);
  }`;
const beamVertex = /* glsl */ `
  varying vec2 vAt;
  void main() {
    vAt = vec2(position.x, position.y); // across -1 to 1, up 0 to 1
    vec3 foot = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    float r = length(instanceMatrix[0].xyz);
    float h = length(instanceMatrix[1].xyz);
    vec2 toEye = cameraPosition.xz - foot.xz;
    float far = max(length(toEye), 0.001);
    vec2 d = toEye / far;
    vec3 across = vec3(d.y, 0.0, -d.x); // its front to the eye
    // In front of the crown, but never past the eye.
    vec3 front = vec3(d.x, 0.0, d.y) * min(r * 1.3, max(0.0, far - 0.4));
    vec3 p = foot + front + across * position.x * r * 1.5 + vec3(0.0, position.y * h * 1.1, 0.0);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }`;
const beamFragment = /* glsl */ `
  uniform vec3 color;
  uniform float strength;
  varying vec2 vAt;
  void main() {
    float y = vAt.y;
    float width = 0.1 + 0.85 * smoothstep(0.0, 0.6, y); // narrow at the spot, as wide as the crown above
    float x = vAt.x / width;
    float beam = exp(-x * x * 2.2) * smoothstep(0.0, 0.05, y) * (1.0 - smoothstep(0.62, 1.0, y));
    beam *= 0.55 + 0.45 * smoothstep(0.15, 0.45, y); // the trunk a little less than the crown's underside
    gl_FragColor = vec4(color * beam * strength * ${BEAM.toFixed(1)}, 1.0);
  }`;

interface Uplight {
  at: [number, number, number];
  tree: [number, number];
  h: number;
  r: number;
}

export class Uplights {
  readonly group = new THREE.Group();
  private uniforms = { color: { value: WARM.clone() }, strength: { value: 0 } };
  private spots: Uplight[] = [];
  private lanterns: [number, number, number][] = [];
  private glows: THREE.InstancedMesh | null = null;
  private beams: THREE.InstancedMesh | null = null;
  private dirty = false;

  constructor() {
    this.group.name = 'uplights';
    this.group.visible = false;
  }

  /** A model's spotlights and lantern (its extras `uplights` and `lantern`), if it has any. */
  add(model: THREE.Object3D): void {
    const spots = model.userData.uplights as Uplight[] | undefined;
    const lantern = model.userData.lantern as [number, number, number] | undefined;
    const ok = (v: unknown, n: number) => Array.isArray(v) && v.length === n && v.every((x) => Number.isFinite(x));
    for (const s of spots ?? []) if (ok(s.at, 3) && ok(s.tree, 2) && s.h > 0 && s.r > 0) this.spots.push(s);
    if (ok(lantern, 3)) this.lanterns.push(lantern!);
    this.dirty = true;
  }

  /** Each frame: the night, 0 (day) to 1. */
  update(night: number): void {
    this.group.visible = night > 0.01 && (this.spots.length > 0 || this.lanterns.length > 0);
    if (!this.group.visible) return;
    if (this.dirty) this.build();
    this.uniforms.strength.value = night;
  }

  private build(): void {
    this.dirty = false;
    for (const m of [this.glows, this.beams]) {
      if (!m) continue;
      this.group.remove(m);
      m.geometry.dispose();
    }
    const m = new THREE.Matrix4();
    // The glows: each spot's lens, small, and the lantern's glass, larger.
    const n = this.spots.length + this.lanterns.length;
    const plane = new THREE.PlaneGeometry(1, 1);
    const sizes = new Float32Array(n);
    plane.setAttribute('glowSize', new THREE.InstancedBufferAttribute(sizes, 1));
    this.glows = new THREE.InstancedMesh(plane, new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: glowVertex, fragmentShader: glowFragment,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    }), n);
    this.spots.forEach((s, i) => {
      this.glows!.setMatrixAt(i, m.makeTranslation(s.at[0], s.at[1], s.at[2]));
      sizes[i] = 0.22;
    });
    this.lanterns.forEach((l, i) => {
      this.glows!.setMatrixAt(this.spots.length + i, m.makeTranslation(l[0], l[1], l[2]));
      sizes[this.spots.length + i] = 0.5;
    });
    // The beams: from each spot's foot up its tree.
    const quad = new THREE.PlaneGeometry(2, 1).translate(0, 0.5, 0);
    this.beams = new THREE.InstancedMesh(quad, new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: beamVertex, fragmentShader: beamFragment,
      transparent: true, depthWrite: false, fog: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.OneFactor,
    }), this.spots.length);
    this.spots.forEach((s, i) => {
      const foot = new THREE.Vector3((s.at[0] + s.tree[0]) / 2, s.at[1] - 0.03, (s.at[2] + s.tree[1]) / 2);
      this.beams!.setMatrixAt(i, m.compose(foot, new THREE.Quaternion(), new THREE.Vector3(s.r, s.h, s.r)));
    });
    for (const mesh of [this.beams, this.glows]) {
      mesh.frustumCulled = false; // a few quads, placed in the shader
      mesh.raycast = () => {}; // never in the way of a shot
      mesh.userData.noAO = true;
      mesh.userData.ignoreRay = true;
      mesh.renderOrder = 60;
      this.group.add(mesh);
    }
  }
}
