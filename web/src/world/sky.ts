import * as THREE from 'three';
import { wind } from './wind';

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
 * Under a grey sky (overcast, rain, snow) two decks of cloud are laid over the photo (setClouds), so it is no flat
 * white: high slow billows and, in the rain, low dark scud racing under them, both drifting with the wind
 * (world/wind.ts). They only darken or lighten the photo a little (a factor of 0.4 to 1.16), so nothing nears the
 * half-float limit.
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
  // The cloud layers under a grey sky (world/weather.ts): how much (x) and how dark their bases (y, the rain's), and
  // where each layer has drifted to with the wind (the high billows xy, the low scud zw).
  uniform sampler2D cloudNoise;
  uniform vec2 clouds;
  uniform vec4 cloudMove;
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
    if (clouds.x > 0.0 && d.y > 0.0) {
      // Two decks of cloud over the grey photo, seen in perspective (on a plane overhead: far off they crowd to the
      // horizon, where the photo's own haze takes over): high slow billows and low scud racing under them. Thick parts
      // darker below, thin ones and the gaps lighter: depth instead of a flat white. Three texture reads.
      vec2 q = d.xz / (d.y + 0.12);
      float high = texture2D(cloudNoise, q * 0.16 + cloudMove.xy).r;
      float low = texture2D(cloudNoise, q * 0.37 + cloudMove.zw).g;
      float fine = texture2D(cloudNoise, q * 1.05 + cloudMove.zw * 1.6).b;
      float thick = smoothstep(0.28, 0.78, high * 0.55 + low * 0.33 + fine * 0.12);
      float scud = smoothstep(0.5, 0.85, low) * clouds.y; // the rain's ragged low cloud, darkest
      float light = mix(mix(1.16, 1.06, clouds.y), mix(0.8, 0.5, clouds.y), thick) * (1.0 - 0.2 * scud);
      vec3 tint = mix(vec3(1.0), vec3(0.94, 0.97, 1.04), thick * clouds.y);
      c *= mix(vec3(1.0), light * tint, clouds.x * smoothstep(0.0, 0.3, d.y));
    }
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
  /** The cloud decks (setClouds); the noise is a blank placeholder until a grey sky first needs it */
  private cloud = {
    cloudNoise: { value: new THREE.DataTexture(new Uint8Array(4), 1, 1) as THREE.Texture },
    clouds: { value: new THREE.Vector2() },
    cloudMove: { value: new THREE.Vector4() },
  };
  private noiseMade = false;
  /** What it shows (read by the horizon's ring, world/horizon.ts, to melt its haze into the sky just above it) */
  readonly uniforms: Record<'sky' | 'sky2', { value: THREE.Texture }> & Record<'turn' | 'gain' | 'turn2' | 'gain2' | 'mix2', { value: number }> &
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
      uniforms: { ...this.uniforms, drift: this.drift, ...this.cloud },
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

  /**
   * The cloud decks under a grey sky (world/weather.ts, each frame): `amount` 0 (none: not a texture read more) to 1,
   * `dark` how dark and ragged their bases are (the rain's). They drift with the wind (world/wind.ts), the low scud
   * about three times as fast as the high billows.
   */
  setClouds(amount: number, dark: number, dt: number): void {
    const c = this.cloud;
    c.clouds.value.set(amount, dark);
    if (amount <= 0) return;
    if (!this.noiseMade) {
      this.noiseMade = true;
      c.cloudNoise.value = cloudNoise();
    }
    // The texture's repeats per second at the sunny day's breeze, in the plane's own units (an eighth of a repeat a minute up high).
    const d = wind.dir.value, v = wind.speed.value * dt;
    const m = c.cloudMove.value;
    m.set((m.x - d.x * v * 0.0021) % 1, (m.y - d.y * v * 0.0021) % 1, (m.z - d.x * v * 0.0065) % 1, (m.w - d.y * v * 0.0065) % 1);
  }
}

/**
 * The clouds' noise, made once the first time a grey sky needs it (a few milliseconds): 128 pixels square, tiling,
 * three kinds of softly rolling noise in red, green and blue (broad, middling, fine), 8 bits each, mipmapped.
 */
function cloudNoise(): THREE.DataTexture {
  const S = 128;
  const out = new Uint8Array(S * S * 4);
  const rnd = (() => {
    let a = 0x2f6b9e1d;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), a | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  })();
  // Value noise on lattices of 4 to 64 cells across the tile, wrapping at its edges, summed as octaves.
  const lattice = (n: number) => Float32Array.from({ length: n * n }, rnd);
  const octaves = [4, 8, 16, 32, 64].map((n) => ({ n, v: lattice(n) }));
  const at = (o: { n: number; v: Float32Array }, x: number, y: number) => {
    const fx = (x / S) * o.n, fy = (y / S) * o.n;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    let tx = fx - ix, ty = fy - iy;
    tx = tx * tx * (3 - 2 * tx);
    ty = ty * ty * (3 - 2 * ty);
    const g = (i: number, j: number) => o.v[((j + o.n) % o.n) * o.n + ((i + o.n) % o.n)];
    return (g(ix, iy) * (1 - tx) + g(ix + 1, iy) * tx) * (1 - ty) + (g(ix, iy + 1) * (1 - tx) + g(ix + 1, iy + 1) * tx) * ty;
  };
  // Each channel its octaves and weights: broad billows, middling scud, fine shreds.
  const kinds = [[0, 0.5, 1, 0.3, 2, 0.15, 3, 0.05], [1, 0.45, 2, 0.3, 3, 0.15, 4, 0.1], [2, 0.3, 3, 0.35, 4, 0.35]];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      kinds.forEach((k, c) => {
        let v = 0;
        for (let i = 0; i < k.length; i += 2) v += at(octaves[k[i]], x, y) * k[i + 1];
        out[(y * S + x) * 4 + c] = Math.round(Math.min(1, Math.max(0, (v - 0.5) * 1.6 + 0.5)) * 255);
      });
      out[(y * S + x) * 4 + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(out, S, S, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}
