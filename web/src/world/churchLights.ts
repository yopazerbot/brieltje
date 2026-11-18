import * as THREE from 'three';

/**
 * The church floodlit at night (18 Nov 2026, Yoshi: the church was a dark block in the village's centre; churches in
 * Flanders are lit from below at night). Twelve fittings sunk in the paving round it, a few metres out, throw warm
 * white light up its tower, its nave, its transept gables and its choir. They come on with the street lamps
 * (world/mood.ts night, which ramps up through dusk) and are seen from the air too.
 *
 * No real lights: twelve would cost every lit pixel of the world. The church's own surfaces are drawn a second time
 * (the same shapes, no copy) with a small shader that works out each fitting's light where it falls: the beam's cone,
 * the fall with the distance, the angle it meets the wall at, times the surface's own colour (its texture or its
 * painted colour), added onto what is drawn. A wall turned away from a fitting gets none of it. Four draw calls, one
 * per part of the model (the brick, the stone, the plaster trim, the slate; not the glass, which stays dark as it does
 * on a lit church), only at night, and only the church's pixels pay: one texture read and a short loop. The fittings
 * themselves are not drawn (Yoshi, 18 Nov 2026, of their lenses glowing in the paving: "I don't want them, they look
 * weird"): the light falls on the church from where they would stand, with no lens or glow on the ground.
 * Every value is far under what half floats hold. The same on every preset: the bloom (Medium and up) only softens it.
 */

/** Warm white of the floodlights (linear), a little whiter than the street lamps. */
const FLOOD = new THREE.Color(1.0, 0.8, 0.6);

/**
 * The fittings in the church model's own frame (tools/church.py's GLB: x along the axis towards the choir, y up, z to
 * the south), each with the point on the church it is aimed at, its beam's half angle (degrees: the edge, and where it
 * is at full strength) and its strength.
 */
const FITTINGS: { at: [number, number]; aim: [number, number, number]; cone: [number, number]; power: number }[] = [
  // The tower's west front and its door: two from the forecourt.
  { at: [-24.2, -2.2], aim: [-18.2, 11, 0], cone: [42, 16], power: 800 },
  { at: [-24.2, 2.2], aim: [-18.2, 11, 0], cone: [42, 16], power: 800 },
  // The tower's sides over the roofs, and the west end of the nave.
  { at: [-17.2, 10], aim: [-16, 12, 2.25], cone: [32, 12], power: 300 },
  { at: [-17.2, -10], aim: [-16, 12, -2.25], cone: [32, 12], power: 300 },
  // The nave, both sides.
  { at: [-11.5, 10.2], aim: [-11.5, 5, 5.42], cone: [48, 20], power: 150 },
  { at: [-4.2, 10.2], aim: [-4.2, 5, 5.42], cone: [48, 20], power: 150 },
  { at: [-11.5, -10.2], aim: [-11.5, 5, -5.42], cone: [48, 20], power: 150 },
  { at: [-4.2, -10.2], aim: [-4.2, 5, -5.42], cone: [48, 20], power: 150 },
  // The transept's gables.
  { at: [4.43, 13.6], aim: [4.43, 7.5, 8.49], cone: [44, 18], power: 200 },
  { at: [4.43, -13.6], aim: [4.43, 7.5, -8.49], cone: [44, 18], power: 200 },
  // The choir's flat east end and the sacristies beside it.
  { at: [19.8, 3.2], aim: [14.6, 6, 0], cone: [46, 18], power: 170 },
  { at: [19.8, -3.2], aim: [14.6, 6, 0], cone: [46, 18], power: 170 },
];
const N = FITTINGS.length;

const floodVertex = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vFar;
  #ifdef HAS_MAP
    uniform mat3 mapTransform;
    varying vec2 vUv;
  #endif
  #ifdef USE_COLOR
    varying vec3 vColor;
  #endif
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vNormal = mat3(modelMatrix) * normal;
    #ifdef HAS_MAP
      vUv = (mapTransform * vec3(uv, 1.0)).xy;
    #endif
    #ifdef USE_COLOR
      vColor = color.rgb;
    #endif
    vec4 mv = viewMatrix * world;
    vFar = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;
const floodFragment = /* glsl */ `
  uniform vec3 tint;
  uniform vec3 flood;
  uniform float strength;
  uniform vec3 lampAt[${N}];
  uniform vec3 lampDir[${N}];
  uniform vec3 lampBeam[${N}]; // cos of the edge, cos of the full beam, strength
  #ifdef HAS_MAP
    uniform sampler2D map;
    varying vec2 vUv;
  #endif
  #ifdef USE_COLOR
    varying vec3 vColor;
  #endif
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #endif
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vFar;
  void main() {
    vec3 n = normalize(vNormal);
    float light = 0.0;
    for (int i = 0; i < ${N}; i++) {
      vec3 toLamp = lampAt[i] - vWorld;
      float d2 = dot(toLamp, toLamp);
      vec3 l = toLamp * inversesqrt(d2);
      float facing = max(dot(n, l), 0.0);
      float beam = smoothstep(lampBeam[i].x, lampBeam[i].y, dot(-l, lampDir[i]));
      light += lampBeam[i].z * facing * beam / (d2 + 4.0);
    }
    vec3 albedo = tint;
    #ifdef HAS_MAP
      albedo *= texture2D(map, vUv).rgb;
    #endif
    #ifdef USE_COLOR
      albedo *= vColor;
    #endif
    float seen = 1.0;
    #ifdef FOG_EXP2
      seen = exp(-fogDensity * fogDensity * vFar * vFar);
    #endif
    gl_FragColor = vec4(albedo * flood * (light * strength * seen * ${(1 / Math.PI).toFixed(5)}), 1.0);
  }`;

export class ChurchLights {
  readonly group = new THREE.Group();
  private uniforms = {
    flood: { value: FLOOD.clone() },
    strength: { value: 0 },
    lampAt: { value: FITTINGS.map(() => new THREE.Vector3()) },
    lampDir: { value: FITTINGS.map(() => new THREE.Vector3()) },
    lampBeam: { value: FITTINGS.map(() => new THREE.Vector3()) },
  };
  private attached = false;

  constructor() {
    this.group.name = 'church floodlights';
    this.group.visible = false;
  }

  /**
   * The church's model, in its place in the world (main.ts loadChurch): its surfaces to light from the fittings' places
   * round it on the ground (`groundAt`: the ground's height at a point). `prepare` (main.ts precompile): the shaders are built
   * now, in the background, so the first dusk doesn't wait for them.
   */
  attach(church: THREE.Object3D, groundAt: (x: number, z: number) => number, prepare?: (o: THREE.Object3D) => unknown): void {
    if (this.attached) return;
    this.attached = true;
    church.updateWorldMatrix(true, true);
    const frame = church.matrixWorld;
    const at = new THREE.Vector3();
    const aim = new THREE.Vector3();
    FITTINGS.forEach((f, i) => {
      at.set(f.at[0], 0, f.at[1]).applyMatrix4(frame);
      at.y = groundAt(at.x, at.z) + 0.04; // the lens 2 cm proud of the paving, which lies a little over the ground for walking
      this.uniforms.lampAt.value[i].copy(at);
      aim.set(...f.aim).applyMatrix4(frame);
      this.uniforms.lampDir.value[i].copy(aim).sub(at).normalize();
      const rad = Math.PI / 180;
      this.uniforms.lampBeam.value[i].set(Math.cos(f.cone[0] * rad), Math.cos(f.cone[1] * rad), f.power);
    });
    // The church's surfaces, drawn again with the floodlights' light on them.
    const materials = new Map<THREE.Material, THREE.ShaderMaterial>();
    church.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const source = mesh.material as THREE.MeshStandardMaterial;
      if (!source.isMeshStandardMaterial || /glass|glow/.test(source.name) || mesh.name.includes('glass')) return;
      let mat = materials.get(source);
      if (!mat) {
        const map = source.map;
        map?.updateMatrix();
        mat = new THREE.ShaderMaterial({
          uniforms: {
            ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
            ...this.uniforms,
            tint: { value: source.color.clone() },
            map: { value: map },
            mapTransform: { value: map ? map.matrix.clone() : new THREE.Matrix3() },
          },
          defines: map ? { HAS_MAP: '' } : {},
          vertexShader: floodVertex,
          fragmentShader: floodFragment,
          vertexColors: source.vertexColors,
          transparent: true,
          depthWrite: false,
          fog: true,
          blending: THREE.AdditiveBlending,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -2,
        });
        materials.set(source, mat);
      }
      const lit = new THREE.Mesh(mesh.geometry, mat);
      lit.matrixAutoUpdate = false;
      lit.matrix.copy(mesh.matrixWorld);
      lit.matrixWorld.copy(mesh.matrixWorld);
      this.group.add(lit);
    });
    for (const o of this.group.children) {
      o.raycast = () => {}; // never in the way of a shot
      o.userData.noAO = true;
      o.userData.ignoreRay = true;
      o.renderOrder = 60;
    }
    if (prepare) {
      this.group.visible = true;
      void Promise.resolve(prepare(this.group)).finally(() => (this.group.visible = this.on > 0.01));
    }
  }

  private on = 0;

  /** Each frame: the night, 0 (day) to 1, as the street lamps follow it. */
  update(night: number): void {
    this.on = night;
    this.group.visible = this.attached && night > 0.01;
    this.uniforms.strength.value = night;
  }
}

