import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { mood } from './world/mood';

/**
 * A soft glow round bright light: the street lamps and the lit windows at night, the sun's glints on cars and
 * water, muzzle flashes, the portals. Medium and up (graphics.ts bloom); Low has none and pays nothing.
 *
 * What is brighter than a threshold is taken from the scene before tone mapping, at a quarter (or half) of the
 * resolution, and blurred by halving it a few times and growing it back (the "dual filter": five texture reads
 * down, eight up, each at a small size), down to a sixty-fourth of the screen. The output pass (src/grade.ts)
 * adds it to the scene before its tone mapping: no full-screen pass of its own, only one texture read more there.
 *
 * - The threshold is on the light as the eye sees it (after the exposure), so it holds indoors too.
 * - Its strength follows the mood (world/mood.ts): clear at night, faint by day, where only the sun's glints and
 *   the sky by the sun pass it.
 * - Each of the first four reads is weighed down by its own brightness, so a single very bright pixel (a glint)
 *   doesn't blink as a square as you move; what passes is capped well under the half floats' end (65504), and a
 *   NaN from the scene is dropped (an iPhone stores an overflow as infinity: AGENTS.md).
 */

/**
 * Light (after the exposure, before tone mapping) that starts to glow, by day and at night. Measured at the house,
 * the church square and Molenhoek: by day a sunlit white wall reaches about 1.5 and glints about 5; at night all
 * but a thousandth of the screen stays under 0.45, and the lamps reach about 6.
 */
const THRESHOLD = { day: 2.6, night: 0.6 };
/** How much of what passes is added, by day and at night. */
const STRENGTH = { day: 0.15, night: 1.0 };
/** The soft start above the threshold, as a share of it. */
const KNEE = 0.5;
/** Each level wider than the one above it adds this share of it: a glow brightest close round the light. */
const SCATTER = 0.7;
/** The smallest level: this share of the screen's width. */
const SMALLEST = 1 / 64;

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const PREFILTER = /* glsl */ `
uniform sampler2D tScene;
uniform vec2 texel; // of the scene
uniform float threshold;
uniform float knee;
uniform float exposure;
varying vec2 vUv;
vec3 tap(vec2 uv, out float w) {
  vec3 c = texture2D(tScene, uv).rgb;
  if (c.r != c.r || c.g != c.g || c.b != c.b) c = vec3(0.0); // NaN (only NaN differs from itself)
  c = min(c, vec3(60000.0));
  w = 1.0 / (1.0 + max(c.r, max(c.g, c.b)) * exposure);
  return c * w;
}
void main() {
  float wa, wb, wc, wd;
  // The source's block under this texel (4 by 4 at a quarter, 2 by 2 at a half: texel holds the step).
  vec3 c = tap(vUv + texel * vec2(-1.0, -1.0), wa) + tap(vUv + texel * vec2(1.0, -1.0), wb)
    + tap(vUv + texel * vec2(-1.0, 1.0), wc) + tap(vUv + texel * vec2(1.0, 1.0), wd);
  c /= wa + wb + wc + wd;
  float l = max(c.r, max(c.g, c.b)) * exposure;
  float k = threshold * knee;
  float soft = clamp(l - threshold + k, 0.0, 2.0 * k);
  soft = soft * soft / (4.0 * k + 1e-4);
  float pass = max(soft, l - threshold) / max(l, 1e-4);
  gl_FragColor = vec4(min(c * pass, vec3(256.0)), 1.0); // before the exposure, as the scene it is added to
}`;

const DOWN = /* glsl */ `
uniform sampler2D tSource;
uniform vec2 texel; // of the source
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSource, vUv).rgb * 4.0;
  c += texture2D(tSource, vUv - texel).rgb;
  c += texture2D(tSource, vUv + texel).rgb;
  c += texture2D(tSource, vUv + vec2(texel.x, -texel.y)).rgb;
  c += texture2D(tSource, vUv - vec2(texel.x, -texel.y)).rgb;
  gl_FragColor = vec4(c / 8.0, 1.0);
}`;

const UP = /* glsl */ `
uniform sampler2D tSource;
uniform vec2 texel; // of the source (the smaller level)
uniform float scatter;
varying vec2 vUv;
void main() {
  vec2 h = texel * 0.5;
  vec3 c = texture2D(tSource, vUv + vec2(-h.x * 2.0, 0.0)).rgb;
  c += texture2D(tSource, vUv + vec2(-h.x, h.y)).rgb * 2.0;
  c += texture2D(tSource, vUv + vec2(0.0, h.y * 2.0)).rgb;
  c += texture2D(tSource, vUv + vec2(h.x, h.y)).rgb * 2.0;
  c += texture2D(tSource, vUv + vec2(h.x * 2.0, 0.0)).rgb;
  c += texture2D(tSource, vUv + vec2(h.x, -h.y)).rgb * 2.0;
  c += texture2D(tSource, vUv + vec2(0.0, -h.y * 2.0)).rgb;
  c += texture2D(tSource, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
  gl_FragColor = vec4(c * (scatter / 12.0), 1.0);
}`;

function quad(fragmentShader: string, uniforms: Record<string, THREE.IUniform>, additive = false): FullScreenQuad {
  return new FullScreenQuad(
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERTEX,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      ...(additive ? { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation } : { blending: THREE.NoBlending }),
    }),
  );
}

/**
 * The glow as a pass after the scene (and its ambient occlusion), before the output pass: it reads the scene and
 * leaves it as it is (no swap); `output` is what the output pass reads.
 */
export class BloomPass extends Pass {
  /** For the output pass (src/grade.ts): the glow, and how much of it to add (0: none, nothing read). */
  readonly output = { tBloom: { value: null as THREE.Texture | null }, bloomStrength: { value: 0 } };
  /** Resolution divisor of the first level: 2, 4, or 0 for none (graphics.ts bloom). */
  private divisor: 0 | 2 | 4 = 0;
  private width = 1;
  private height = 1;
  private levels: THREE.WebGLRenderTarget[] = [];
  private prefilter = quad(PREFILTER, { tScene: { value: null }, texel: { value: new THREE.Vector2() }, threshold: { value: 1 }, knee: { value: KNEE }, exposure: { value: 1 } });
  private down = quad(DOWN, { tSource: { value: null }, texel: { value: new THREE.Vector2() } });
  private up = quad(UP, { tSource: { value: null }, texel: { value: new THREE.Vector2() }, scatter: { value: SCATTER } }, true);

  constructor() {
    super();
    this.needsSwap = false;
    this.enabled = false;
  }

  /** The preset's divisor (graphics.ts bloom): 0 turns it off. */
  setDivisor(divisor: 0 | 2 | 4): void {
    this.divisor = divisor;
    this.enabled = divisor > 0;
    this.output.bloomStrength.value = 0;
    this.build();
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.build();
  }

  /** The levels for this size: from the divisor down to about a sixty-fourth of the width. */
  private build(): void {
    if (!this.divisor) {
      for (const t of this.levels) t.dispose();
      this.levels = [];
      this.output.tBloom.value = null;
      return;
    }
    const sizes: [number, number][] = [];
    let w = Math.max(1, Math.round(this.width / this.divisor));
    let h = Math.max(1, Math.round(this.height / this.divisor));
    sizes.push([w, h]);
    while (w > this.width * SMALLEST * 1.5 && h > 2 && sizes.length < 7) {
      w = Math.max(1, Math.round(w / 2));
      h = Math.max(1, Math.round(h / 2));
      sizes.push([w, h]);
    }
    while (this.levels.length > sizes.length) this.levels.pop()!.dispose();
    sizes.forEach(([sw, sh], i) => {
      const t = this.levels[i];
      if (t) t.setSize(sw, sh);
      else
        this.levels[i] = new THREE.WebGLRenderTarget(sw, sh, {
          type: THREE.HalfFloatType,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          generateMipmaps: false,
          depthBuffer: false,
        });
    });
    this.output.tBloom.value = this.levels[0].texture;
  }

  render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget): void {
    if (!this.levels.length) return;
    const night = mood.night;
    const strength = THREE.MathUtils.lerp(STRENGTH.day, STRENGTH.night, night);
    // Every level holds as much light as the first: the sum of their shares, for the glow to hold `strength` of it.
    this.output.bloomStrength.value = (strength * (1 - SCATTER)) / (1 - Math.pow(SCATTER, this.levels.length));
    if (strength <= 0) return;
    const before = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;

    const pre = this.prefilter.material as THREE.ShaderMaterial;
    pre.uniforms.tScene.value = read.texture;
    pre.uniforms.texel.value.set(this.divisor / 4 / read.width, this.divisor / 4 / read.height);
    pre.uniforms.threshold.value = THREE.MathUtils.lerp(THRESHOLD.day, THRESHOLD.night, night);
    pre.uniforms.exposure.value = renderer.toneMappingExposure;
    renderer.setRenderTarget(this.levels[0]);
    this.prefilter.render(renderer);

    const down = this.down.material as THREE.ShaderMaterial;
    for (let i = 1; i < this.levels.length; i++) {
      const src = this.levels[i - 1];
      down.uniforms.tSource.value = src.texture;
      down.uniforms.texel.value.set(1 / src.width, 1 / src.height);
      renderer.setRenderTarget(this.levels[i]);
      this.down.render(renderer);
    }
    // Back up, each level added onto the one above it.
    const up = this.up.material as THREE.ShaderMaterial;
    for (let i = this.levels.length - 1; i > 0; i--) {
      const src = this.levels[i];
      up.uniforms.tSource.value = src.texture;
      up.uniforms.texel.value.set(1 / src.width, 1 / src.height);
      renderer.setRenderTarget(this.levels[i - 1]);
      this.up.render(renderer);
    }
    renderer.autoClear = autoClear;
    renderer.setRenderTarget(before);
  }

  dispose(): void {
    for (const t of this.levels) t.dispose();
    this.levels = [];
    for (const q of [this.prefilter, this.down, this.up]) {
      q.material.dispose();
      q.dispose();
    }
  }
}
