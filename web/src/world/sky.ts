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
    // Round the eye whatever its position (only the camera's turn), at the very back of the depth range.
    gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
    gl_Position.z = gl_Position.w * 0.9999999;
  }`;

const fragmentShader = /* glsl */ `
  #include <common>
  uniform sampler2D sky;
  uniform float turn;
  uniform float drift;
  uniform vec3 sunDir;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    // The drift: none at the sun or the horizon, the full amount from 24 degrees off the sun and halfway up.
    float still = smoothstep(cos(0.42), cos(0.14), dot(d, sunDir));
    float a = turn + drift * (1.0 - still) * smoothstep(0.0, 0.7, d.y);
    // As three.js reads an equirectangular photo turned by the background rotation (equirectUv).
    vec2 uv = vec2((atan(d.z, d.x) + a) * RECIPROCAL_PI2 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * RECIPROCAL_PI + 0.5);
    gl_FragColor = vec4(texture2D(sky, uv).rgb, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

export class Sky {
  readonly mesh: THREE.Mesh;
  private drift = { value: 0 };

  /**
   * `photo`: the equirectangular sky; `turn`: how far it is turned round the vertical (the scene's
   * background rotation, radians); `sunDir`: where its sun is in the world.
   */
  constructor(photo: THREE.Texture, turn: number, sunDir: THREE.Vector3) {
    // Turned, the photo's left and right edges meet somewhere in view: they must join (set before its first use).
    photo.wrapS = THREE.RepeatWrapping;
    const material = new THREE.ShaderMaterial({
      uniforms: { sky: { value: photo }, turn: { value: turn }, drift: this.drift, sunDir: { value: sunDir.clone().normalize() } },
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
}
