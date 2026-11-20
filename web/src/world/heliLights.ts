import * as THREE from 'three';

/**
 * The helicopter's lights as seen from outside (world/heli.ts): the lamps on the model are a few centimetres across, so
 * from the ground they were lost. Each lamp gets a glow, one draw of points for the whole machine, never smaller on
 * screen than two or three pixels, so a machine 250 m off still shows them: the red light on the left and the green on
 * the right of the stabiliser, the white at the tail, steady; the red beacon on the fin flashing once a second and the
 * white strobe under the boom twice every second and a half, by day too (fainter); the landing lights under the chin
 * and the belly at dusk and night while the rotor runs. The landing light also lights the ground where it points
 * (forward and down): a soft pool laid on the floor under it, one flat square drawn adding light, bigger and fainter
 * the higher it flies; no real light (that would cost every lit pixel). Everything here stays far under 65504.
 */

/** The lamps on the model, by material (tools/helicopter.py): which are steady, which flash, which light the way. */
type Kind = 'steady' | 'beacon' | 'strobe' | 'landing';
const COLOUR: Record<string, string> = { LightRed: '#ff2a1a', LightGreen: '#30ff70', LightWhite: '#ffffff', LightBeacon: '#ff2010', LightLanding: '#fff1d6' };
const KIND_ID: Record<Kind, number> = { steady: 0, beacon: 1, strobe: 2, landing: 3 };

const VERT = /* glsl */ `
attribute vec3 color;
attribute vec2 lamp; // its kind (KIND_ID), its own phase
uniform float lampTime;
uniform float lampNight;
uniform float lampLand;
uniform float lampScale;
varying vec3 vColor;
varying float vOn;
void main() {
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  float k = lamp.x;
  float on = 1.0;
  if ( k > 0.5 && k < 1.5 ) {
    // The beacon: a flash a second, rising and fading in a tenth.
    float t = fract( lampTime * 1.0 + lamp.y );
    on = smoothstep( 0.0, 0.02, t ) * ( 1.0 - smoothstep( 0.05, 0.13, t ) );
  } else if ( k > 1.5 && k < 2.5 ) {
    // The strobe: two short flashes every second and a half.
    float t = fract( lampTime / 1.5 + lamp.y );
    on = step( t, 0.03 ) + step( abs( t - 0.1 ), 0.015 );
  } else if ( k > 2.5 ) {
    on = lampLand;
  }
  // Brighter and wider at night; the flashing ones show by day too.
  float flash = step( 0.5, k ) * step( k, 2.5 );
  float size = mix( 0.28, 0.85, lampNight ) * mix( 1.0, 1.7, flash ) * ( k > 2.5 ? 1.6 : 1.0 );
  float px = size * lampScale / max( -mv.z, 0.1 );
  float least = mix( 2.0, 3.2, flash );
  vOn = on * mix( mix( 0.12, 0.6, flash ), 1.0, lampNight );
  vColor = color;
  gl_PointSize = on > 0.001 ? max( px, least ) : 0.0;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
varying vec3 vColor;
varying float vOn;
void main() {
  float r = length( gl_PointCoord - 0.5 ) * 2.0;
  if ( r > 1.0 ) discard;
  float glow = exp( - r * r * 5.0 ) * ( 1.0 - r );
  float core = 1.0 - smoothstep( 0.1, 0.35, r );
  gl_FragColor = vec4( vColor * ( glow * 1.4 + core * 1.8 ) * vOn, 1.0 );
}`;

const POOL_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xz * 2.0; // a flat square, -1 to 1 across
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;
const POOL_FRAG = /* glsl */ `
uniform vec3 color;
uniform float strength;
varying vec2 vUv;
void main() {
  float r = length( vUv );
  if ( r > 1.0 ) discard;
  float a = ( 1.0 - smoothstep( 0.0, 1.0, r ) ) * ( 0.55 + 0.45 * ( 1.0 - smoothstep( 0.0, 0.45, r ) ) );
  gl_FragColor = vec4( color * a * strength, 1.0 );
}`;

/** The way the landing lights point, in the model's frame: forward (-z) and 50 degrees down. */
const BEAM = new THREE.Vector3(0, -Math.sin((50 * Math.PI) / 180), -Math.cos((50 * Math.PI) / 180));
/** The beam's half angle (rad): how wide the pool is for how far it reaches */
const SPREAD = 0.2;

/**
 * Where the model's lamps are: each lamp's vertices gathered by material and by place (lamps of one material lie
 * metres apart: the two landing lamps under the chin, the tail light and the strobe), in the model's frame.
 */
export function findLamps(scene: THREE.Object3D): { at: THREE.Vector3; material: string }[] {
  const found: { at: THREE.Vector3; n: number; material: string }[] = [];
  const v = new THREE.Vector3();
  scene.updateMatrixWorld(true);
  const inv = scene.matrixWorld.clone().invert();
  const m = new THREE.Matrix4();
  scene.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const name = (o.material as THREE.Material)?.name;
    if (!COLOUR[name]) return;
    const pos = o.geometry.getAttribute('position');
    if (!pos) return;
    m.multiplyMatrices(inv, o.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      let c = found.find((f) => f.material === name && f.at.distanceTo(v) < 0.4);
      if (!c) found.push((c = { at: new THREE.Vector3(), n: 0, material: name }));
      // A running mean: the lamp's middle.
      c.n++;
      c.at.lerp(v, 1 / c.n);
    }
  });
  return found.map(({ at, material }) => ({ at, material }));
}

export class HeliLights {
  readonly points: THREE.Points;
  readonly pool: THREE.Mesh;
  private uniforms = { lampTime: { value: 0 }, lampNight: { value: 0 }, lampLand: { value: 0 }, lampScale: { value: 800 } };
  private poolU = { color: { value: new THREE.Color('#fff1d6') }, strength: { value: 0 } };
  /** The landing lamps' middle in the model's frame (the pool starts from there) */
  private landing = new THREE.Vector3(0, 0.4, -2.6);
  private hasLanding = false;
  private size = new THREE.Vector2();
  private v = new THREE.Vector3();
  private d = new THREE.Vector3();

  constructor(lamps: { at: THREE.Vector3; material: string }[], phase = Math.random()) {
    const n = lamps.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const kind = new Float32Array(n * 2);
    const c = new THREE.Color();
    const land: THREE.Vector3[] = [];
    lamps.forEach((l, i) => {
      const k: Kind = l.material === 'LightBeacon' ? 'beacon' : l.material === 'LightLanding' ? 'landing' : l.material === 'LightWhite' && l.at.z < 6.5 ? 'strobe' : 'steady'; // the strobe under the boom; the tail light at its end
      if (k === 'landing') land.push(l.at);
      // A touch out from its lens, so the body round it doesn't cut the glow.
      pos.set([l.at.x, l.at.y + (k === 'landing' ? -0.06 : 0.02), l.at.z], i * 3);
      c.set(COLOUR[l.material]);
      col.set([c.r, c.g, c.b], i * 3);
      kind.set([KIND_ID[k], phase], i * 2);
    });
    if (land.length) {
      this.landing.set(0, 0, 0);
      for (const p of land) this.landing.add(p);
      this.landing.divideScalar(land.length);
      this.hasLanding = true;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('lamp', new THREE.BufferAttribute(kind, 2));
    this.points = new THREE.Points(
      g,
      new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.points.name = 'HeliLamps';
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.points.raycast = () => {};
    this.points.userData.ignoreRay = true;
    this.points.userData.noAO = true;
    // The glow's size in pixels follows the view: its height in pixels over the view's height in metres at 1 m.
    this.points.onBeforeRender = (renderer, _scene, camera) => {
      renderer.getDrawingBufferSize(this.size);
      const fov = (camera as THREE.PerspectiveCamera).fov ?? 60;
      this.uniforms.lampScale.value = this.size.y / (2 * Math.tan((fov * Math.PI) / 360));
    };
    this.pool = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({
        uniforms: this.poolU, vertexShader: POOL_VERT, fragmentShader: POOL_FRAG,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      }),
    );
    this.pool.name = 'HeliLandingPool';
    this.pool.frustumCulled = false;
    this.pool.renderOrder = 1;
    this.pool.raycast = () => {};
    this.pool.userData.ignoreRay = true;
    this.pool.userData.noAO = true;
    this.pool.visible = false;
  }

  /**
   * Every frame: `night` 0 to 1 (dusk on), the rotor's speed, whether it rests, `body` the machine's frame in the
   * world, `floor` the ground's height under it; `pool` false on Low and phones. `warm` draws everything once.
   */
  update(dt: number, night: number, rotor: number, ground: boolean, body: THREE.Object3D, floor: number, pool: boolean, warm = false): void {
    const u = this.uniforms;
    u.lampTime.value = (u.lampTime.value + Math.max(0, dt)) % 600;
    const lit = rotor > 0.3 || !ground;
    // The lamps on while it runs (the beacon and the strobe too), off when it stands with the engine off.
    this.points.visible = lit || warm;
    u.lampNight.value = Math.min(1, night * 1.4);
    const land = this.hasLanding && night > 0.15 && rotor > 0.5 ? Math.min(1, (night - 0.15) * 3) : 0;
    u.lampLand.value = warm ? 1 : land;
    // The pool where the beam meets the floor: forward and down from the lamps, bigger and fainter the further.
    this.pool.visible = warm || (pool && land > 0.01);
    if (!this.pool.visible) return;
    body.updateMatrixWorld();
    const from = this.v.copy(this.landing).applyMatrix4(body.matrixWorld);
    const dir = this.d.copy(BEAM).transformDirection(body.matrixWorld);
    const drop = from.y - floor;
    if (dir.y > -0.15 || drop < 0.2 || drop > 70) {
      this.pool.visible = warm;
      return;
    }
    const t = drop / -dir.y;
    const across = Math.max(0.8, t * Math.tan(SPREAD) * 1.6);
    const along = across / Math.max(0.35, -dir.y);
    this.pool.position.set(from.x + dir.x * t, floor + 0.04, from.z + dir.z * t);
    this.pool.rotation.set(0, Math.atan2(dir.x, dir.z), 0);
    this.pool.scale.set(across * 2, 1, along * 2);
    // Strongest close: the light on the ground falls with the square of the way, held between 0.12 and 0.9.
    this.poolU.strength.value = land * Math.min(0.9, Math.max(0.12, 14 / (t * t + 4)));
  }
}
