import * as THREE from 'three';

/**
 * The photographed sky as the background, drawn by a shader of our own instead of the scene's
 * background, for two reasons.
 *
 * The clouds drift: very slowly back and forth round the sky (about 5 degrees each way over five
 * minutes), so they move against the roofs when you stand and look, without ever going anywhere. The
 * sun and the sky round it (within about 8 degrees, easing out to 24) stay where they are, so the
 * sun you see and the shadows keep agreeing; so does the horizon, where clouds are far off and
 * barely move. Higher clouds, nearer overhead, move more, as they would.
 *
 * And it is cheaper. The scene's background is drawn first over the whole screen and turns the photo
 * into a cube of 32-bit floats first (about 100 MB of graphics memory); this one samples the photo
 * directly and is drawn after everything solid, so the graphics chip skips every pixel a house, a
 * tree or the ground already covers.
 *
 * Drawn at the far end of the depth range, without writing depth: it hides nothing, and the ambient
 * occlusion pass leaves it out (main.ts leaves out what writes no depth).
 */

/** Radians: how far the clouds drift each way. */
const DRIFT = 0.09;
/** Seconds for one drift there and back. */
const PERIOD = 300;

const vertexShader = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    // Round the eye whatever its position (only the camera's turn), exactly on the far plane (depth 1, what the
    // depth buffer is cleared to, so it still passes the depth test where nothing was drawn). Not a hair in front of
    // it: with z at 0.9999999 of w, ANGLE on Metal (measured in Chrome on a Mac; Safari uses the same backend) dropped
    // whole triangles of the box for some headings, and the sky showed black in wedges that came and went as the eye turned.
    gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
    gl_Position.z = gl_Position.w;
  }`;

const fragmentShader = /* glsl */ `
  #include <common>
  uniform sampler2D sky;
  uniform float turn;
  uniform float drift;
  uniform vec3 sunDir;
  uniform float gain;
  // The weather's next sky while the two blend (world/weather.ts): a second photo, its turn, sun and gain, and how far.
  uniform sampler2D sky2;
  uniform float turn2;
  uniform vec3 sunDir2;
  uniform float gain2;
  uniform float mix2;
  varying vec3 vDir;
  vec3 photo(sampler2D map, vec3 d, float around, vec3 sun) {
    // The drift: none at the sun or the horizon, the full amount from 24 degrees off the sun and halfway up.
    float still = smoothstep(cos(0.42), cos(0.14), dot(d, sun));
    float a = around + drift * (1.0 - still) * smoothstep(0.0, 0.7, d.y);
    // As three.js reads an equirectangular photo turned by the background rotation (equirectUv).
    vec2 uv = vec2((atan(d.z, d.x) + a) * RECIPROCAL_PI2 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * RECIPROCAL_PI + 0.5);
    return texture2D(map, uv).rgb;
  }
  void main() {
    vec3 d = normalize(vDir);
    vec3 c = photo(sky, d, turn, sunDir) * gain;
    if (mix2 > 0.0) c = mix(c, photo(sky2, d, turn2, sunDir2) * gain2, mix2); // only while two skies blend
    gl_FragColor = vec4(c, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

interface SkyLayer {
  photo: THREE.Texture;
  turn: number;
  sunDir: THREE.Vector3;
  gain: number;
}

export class Sky {
  readonly mesh: THREE.Mesh;
  private drift = { value: 0 };
  private uniforms: Record<'sky' | 'sky2', { value: THREE.Texture }> & Record<'turn' | 'gain' | 'turn2' | 'gain2' | 'mix2', { value: number }> &
    Record<'sunDir' | 'sunDir2', { value: THREE.Vector3 }>;

  /**
   * `photo`: the equirectangular sky; `turn`: how far it is turned round the vertical (the scene's
   * background rotation, radians); `sunDir`: where its sun is in the world.
   */
  constructor(photo: THREE.Texture, turn: number, sunDir: THREE.Vector3) {
    // Turned, the photo's left and right edges meet somewhere in view: they must join (set before its first use).
    photo.wrapS = THREE.RepeatWrapping;
    this.uniforms = {
      sky: { value: photo }, turn: { value: turn }, sunDir: { value: sunDir.clone().normalize() }, gain: { value: 1 },
      sky2: { value: photo }, turn2: { value: turn }, sunDir2: { value: sunDir.clone().normalize() }, gain2: { value: 1 }, mix2: { value: 0 },
    };
    const material = new THREE.ShaderMaterial({
      uniforms: { ...this.uniforms, drift: this.drift },
      vertexShader,
      fragmentShader,
      depthWrite: false,
      side: THREE.BackSide,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material);
    this.mesh.name = 'sky';
    this.mesh.frustumCulled = false; // round the eye, wherever it is
    this.mesh.renderOrder = 100; // after everything solid: only the pixels nothing covers are worked out
    this.mesh.raycast = () => {}; // never in the way of a shot or a door
    // Its own clock: worked out while it is drawn, so nothing else needs to keep it.
    this.mesh.onBeforeRender = () => {
      this.drift.value = DRIFT * Math.sin((performance.now() / 1000 / PERIOD) * Math.PI * 2);
    };
  }

  /**
   * The weather's skies (world/weather.ts): `a`, and `b` blended over it by `k` (0: only `a`, which then costs one
   * texture read a pixel as before; the second is read only while they blend). Only uniforms change.
   */
  show(a: SkyLayer, b: SkyLayer, k: number): void {
    const u = this.uniforms;
    u.sky.value = a.photo;
    u.turn.value = a.turn;
    u.sunDir.value.copy(a.sunDir);
    u.gain.value = a.gain;
    u.sky2.value = b.photo;
    u.turn2.value = b.turn;
    u.sunDir2.value.copy(b.sunDir);
    u.gain2.value = b.gain;
    u.mix2.value = a.photo === b.photo && a.turn === b.turn ? 0 : k;
    if (u.mix2.value === 0 && k > 0) u.gain.value = a.gain + (b.gain - a.gain) * k; // one photo: only its brightness blends
  }
}
