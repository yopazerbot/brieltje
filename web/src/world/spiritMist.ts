import * as THREE from 'three';

/**
 * The brook spirit's mist (world/brookSpirit.ts): soft camera-facing sprites cut from a flipbook of a real volume of
 * mist that tools/brook_spirit_mist.py renders in Blender, lit as games light their smoke ("six-way lighting").
 *
 * The flipbook (public/models/brook-spirit/mist_a and mist_b, 8 x 8 frames of 256 pixels, laid out as glTF's UVs):
 * - rows 0 to 5: 48 frames of a ball of mist turning over and churning (a loop); rows 6 and 7: 8 frames of a long
 *   hanging wisp flowing down, each two cells tall (a loop).
 * - mist_a: R lit from the right, G from above, B from behind, A how much it covers; mist_b: R from the left,
 *   G from below, B from the front, A lit from inside (stored as 0.5 + 0.5 x the value). The lights premultiplied by
 *   the coverage, linear.
 *
 * Each sprite's corners work out, once per corner, how much of each of the six pictures its lights add: the sun (or
 * the moon) of the scene's first directional light, the sky and the ground of its hemisphere light, its ambient
 * light, and the heart's light from inside the creature. The pixel then only weighs the six pictures by those (and
 * the picture lit from inside by the heart's): a few multiplications, four texture reads with the blend between two
 * frames (two without it, on Low). Drawn premultiplied, sorted far to near by the creature, in one instanced draw.
 * Values stay far under the half floats' 65504.
 */

const GRID = 8;
export const BALL_FRAMES = 48;
export const WISP_FRAMES = 8;

const VERTEX = /* glsl */ `
#include <common>
#include <lights_pars_begin>
attribute vec3 iPos;
attribute vec4 iSize;   // width, height, turn, kind (0 the ball, 1 the wisp)
attribute vec4 iColor;  // tint (how dark the mist is), alpha
attribute vec4 iMisc;   // frame, the heart's light on it, -, -
uniform vec4 uCore;     // the core's middle (in the group) and how far round it no sprite is drawn
uniform vec3 uHeart;    // the heart's middle (in the group)
uniform vec3 uInner;    // the heart's light: colour times strength
uniform float uSun;
uniform float uSky;
uniform vec2 uHole;     // how far the heart is open (0..1), the hole's radius round it (m)
varying vec4 vUv;
varying vec2 vQ;
varying float vMix;
varying float vAlpha;
varying float vThick;
varying vec3 vHole;
varying vec3 vC0;
varying vec3 vC1;
varying vec3 vC2;
varying vec3 vC3;
varying vec3 vC4;
varying vec3 vC5;
varying vec3 vCi;
#include <fog_pars_vertex>

vec3 spiritRight;
vec3 spiritUp;
void spiritLight(vec3 L, vec3 c) {
  float x = dot(L, spiritRight);
  float y = dot(L, spiritUp);
  float z = L.z;
  vC0 += c * pow2(max(x, 0.0));
  vC3 += c * pow2(max(-x, 0.0));
  vC1 += c * pow2(max(y, 0.0));
  vC4 += c * pow2(max(-y, 0.0));
  vC2 += c * pow2(max(-z, 0.0)) * 1.4; // light from behind the sprite: its torn edge glows (mist scatters forward)
  vC5 += c * pow2(max(z, 0.0));  // from the camera's side: lit from the front
}

vec2 spiritCell(float frame, float kind, vec2 p) {
  if (kind < 0.5) {
    float f = mod(frame, ${BALL_FRAMES.toFixed(1)});
    vec2 cell = vec2(mod(f, ${GRID.toFixed(1)}), floor(f / ${GRID.toFixed(1)}));
    return (cell + vec2(p.x + 0.5, 0.5 - p.y)) / ${GRID.toFixed(1)};
  }
  float f = mod(frame, ${WISP_FRAMES.toFixed(1)});
  return vec2(f + p.x + 0.5, 6.0 + (0.5 - p.y) * 2.0) / ${GRID.toFixed(1)};
}

void main() {
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  vec4 cc = modelViewMatrix * vec4(uCore.xyz, 1.0);
  float d = -mv.z;
  float dc = -cc.z;
  float k = 1.0;
  // Never through the core: slid along the line of sight to just in front of or behind it, keeping its size on screen.
  if (abs(d - dc) < uCore.w && d > 0.05) {
    float nd = d < dc ? max(dc - uCore.w, 0.06) : dc + uCore.w;
    k = nd / d;
    mv.xyz *= k;
  }
  float cs = cos(iSize.z);
  float sn = sin(iSize.z);
  vec2 c = position.xy * iSize.xy * k;
  vec3 centre = mv.xyz;
  mv.xy += vec2(cs * c.x - sn * c.y, sn * c.x + cs * c.y);
  gl_Position = projectionMatrix * mv;

  vQ = position.xy;
  float f0 = floor(iMisc.x);
  vMix = iMisc.x - f0;
  vUv = vec4(spiritCell(f0, iSize.w, position.xy), spiritCell(f0 + 1.0, iSize.w, position.xy));
  // Close to the eye a sprite thins away, so its flat shape never shows.
  vAlpha = iColor.a * smoothstep(0.6, 2.6, -mv.z);
  vThick = iMisc.z;

  spiritRight = vec3(cs, sn, 0.0);
  spiritUp = vec3(-sn, cs, 0.0);
  vC0 = vec3(0.0); vC1 = vec3(0.0); vC2 = vec3(0.0); vC3 = vec3(0.0); vC4 = vec3(0.0); vC5 = vec3(0.0);
  #if NUM_DIR_LIGHTS > 0
    spiritLight(directionalLights[0].direction, directionalLights[0].color * uSun);
  #endif
  #if NUM_HEMI_LIGHTS > 0
    spiritLight(hemisphereLights[0].direction, hemisphereLights[0].skyColor * uSky);
    spiritLight(-hemisphereLights[0].direction, hemisphereLights[0].groundColor * uSky);
  #endif
  vec3 amb = ambientLightColor * uSky * 0.33;
  vC0 += amb; vC1 += amb; vC2 += amb; vC3 += amb; vC4 += amb; vC5 += amb;
  // The heart's light: from where it lies, falling off with distance; and glowing through the mist round it.
  vec3 hv = (modelViewMatrix * vec4(uHeart, 1.0)).xyz - centre;
  float hd = length(hv);
  vec3 hl = uInner * iMisc.y / (1.0 + hd * hd * 2.0);
  // The hole over the heart: where the eye's line to the heart crosses this sprite's plane, and how far this corner
  // lies from it (in the hole's radii there); only for sprites in front of the heart. Linear across the sprite.
  vec3 hView = (modelViewMatrix * vec4(uHeart, 1.0)).xyz;
  vec2 across = mv.xy - hView.xy * (mv.z / min(hView.z, -0.05));
  float hr = uHole.y * (mv.z / min(hView.z, -0.05));
  vHole = vec3(across / max(hr, 1e-3), mv.z > hView.z + 0.3 ? uHole.x : 0.0);
  spiritLight(hv / max(hd, 1e-3), hl * 0.6);
  vCi = hl;
  vec3 tint = iColor.rgb;
  vC0 *= tint; vC1 *= tint; vC2 *= tint; vC3 *= tint; vC4 *= tint; vC5 *= tint;
  vec4 mvPosition = mv;
  #include <fog_vertex>
}`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uA;
uniform sampler2D uB;
varying vec4 vUv;
varying vec2 vQ;
varying float vMix;
varying float vAlpha;
varying float vThick;
varying vec3 vHole;
varying vec3 vC0;
varying vec3 vC1;
varying vec3 vC2;
varying vec3 vC3;
varying vec3 vC4;
varying vec3 vC5;
varying vec3 vCi;
#include <fog_pars_fragment>
void main() {
  // Open, the heart shows through a soft hole in the mist in front of it.
  float hole = vHole.z * (1.0 - smoothstep(0.55, 1.25, length(vHole.xy)));
  vec4 a = texture2D(uA, vUv.xy);
  vec4 b = texture2D(uB, vUv.xy);
  #ifdef SPIRIT_BLEND
    a = mix(a, texture2D(uA, vUv.zw), vMix);
    b = mix(b, texture2D(uB, vUv.zw), vMix);
  #endif
  // A frame's edge never shows, even where the mist reaches it.
  float edge = smoothstep(0.5, 0.4, max(abs(vQ.x), abs(vQ.y)));
  float inner = max(b.a * 2.0 - 1.0, 0.0); // stored as 0.5 + 0.5 * value (tools/brook_spirit_mist.py)
  vec3 col = a.r * vC0 + a.g * vC1 + a.b * vC2 + b.r * vC3 + b.g * vC4 + b.b * vC5 + inner * vCi;
  // Thicker mist (the cloud's middle): as if several frames lay one behind the other.
  float cover = 1.0 - pow(1.0 - min(a.a, 0.999), vThick);
  col *= cover / max(a.a, 1e-3);
  float keep = vAlpha * edge * (1.0 - 0.95 * hole);
  float alpha = cover * keep;
  col *= keep;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogF = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    col = mix(col, fogColor * alpha, fogF);
  #endif
  gl_FragColor = vec4(col, alpha);
}`;

/** One instanced draw of mist sprites; the creature fills it each frame (begin, put, end). */
export class MistPool {
  readonly mesh: THREE.Mesh;
  private geo = new THREE.InstancedBufferGeometry();
  private iPos: THREE.InstancedBufferAttribute;
  private iSize: THREE.InstancedBufferAttribute;
  private iColor: THREE.InstancedBufferAttribute;
  private iMisc: THREE.InstancedBufferAttribute;
  readonly material: THREE.ShaderMaterial;
  count = 0;

  constructor(
    capacity: number,
    maps: { a: THREE.Texture; b: THREE.Texture },
    shared: { uCore: { value: THREE.Vector4 }; uHeart: { value: THREE.Vector3 }; uInner: { value: THREE.Color }; uHole: { value: THREE.Vector2 } },
  ) {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    const attr = (n: number) => new THREE.InstancedBufferAttribute(new Float32Array(capacity * n), n).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('iPos', (this.iPos = attr(3)));
    this.geo.setAttribute('iSize', (this.iSize = attr(4)));
    this.geo.setAttribute('iColor', (this.iColor = attr(4)));
    this.geo.setAttribute('iMisc', (this.iMisc = attr(4)));
    this.geo.instanceCount = 0;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.lights),
        uA: { value: maps.a },
        uB: { value: maps.b },
        uCore: shared.uCore,
        uHeart: shared.uHeart,
        uInner: shared.uInner,
        uHole: shared.uHole,
        // The sun far over the sky: a lit side and a dark side, as a storm cloud has.
        uSun: { value: 0.5 },
        uSky: { value: 0.22 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      defines: { SPIRIT_BLEND: '' },
      transparent: true,
      depthWrite: false,
      fog: true,
      lights: true,
      // Premultiplied, as the flipbook is.
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.raycast = () => {};
    this.mesh.userData.ignoreRay = true;
  }

  /** The flipbook's pictures (full or half size), and whether to blend between frames (not on Low). */
  setMaps(maps: { a: THREE.Texture; b: THREE.Texture }, blend: boolean): void {
    this.material.uniforms.uA.value = maps.a;
    this.material.uniforms.uB.value = maps.b;
    const had = 'SPIRIT_BLEND' in this.material.defines;
    if (had !== blend) {
      if (blend) this.material.defines.SPIRIT_BLEND = '';
      else delete this.material.defines.SPIRIT_BLEND;
      this.material.needsUpdate = true;
    }
  }

  /** How strongly the sun (or moon) and the sky light it. */
  setGain(sun: number, sky: number): void {
    this.material.uniforms.uSun.value = sun;
    this.material.uniforms.uSky.value = sky;
  }

  begin(): void {
    this.count = 0;
  }

  /** One sprite: where (in the group), its size, turn, the ball (0) or the wisp (1), its frame, tint and alpha, and how much the heart lights it. */
  put(p: THREE.Vector3, sx: number, sy: number, rot: number, kind: number, frame: number, tint: THREE.Color, alpha: number, inner: number, thick = 1): void {
    const i = this.count++;
    this.iPos.setXYZ(i, p.x, p.y, p.z);
    this.iSize.setXYZW(i, sx, sy, rot, kind);
    this.iColor.setXYZW(i, tint.r, tint.g, tint.b, alpha);
    this.iMisc.setXYZW(i, frame, inner, Math.max(1, thick), 0);
  }

  end(): void {
    for (const a of [this.iPos, this.iSize, this.iColor, this.iMisc]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.count * a.itemSize);
      a.needsUpdate = true;
    }
    this.geo.instanceCount = this.count;
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
  }
}
