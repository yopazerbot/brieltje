/**
 * The guns' surfaces: darker in the seams, worn on the hard edges, a fine grain all over. The models
 * have no pictures on them and no texture coordinates (tools/weapons.py); this adds the look of
 * used metal, moulded plastic and wood in the material itself.
 *
 * Two things feed it. The model carries its own shading per corner (`_shade`, baked in Blender by
 * bake_shade): how closed in a spot is, and where the thin bevels of the hard edges are. And one
 * small picture of noise, drawn here in code once and laid over the gun from three sides by its own
 * position: a fine grain, soft patches that break the edge wear up, and a few scuffs on the flats.
 *
 * Each part gets its finish here too (blued steel, polymer, rubber, paint), and the metal mirrors the world
 * around you: the sky above the horizon, the lit street below it, a dim room indoors (MIRROR).
 *
 * It also keeps the camera from cutting a gun open (noNearCut): what comes nearer than the camera's near
 * edge is drawn all the same, so you see the outside of the stock pass by your cheek, never into it.
 *
 * Cost: three lookups in a 128 px picture and one more in the sky's light map (the street's light), on the
 * gun's own pixels only. A gun without the baked
 * shading (the others' guns and the ones on the floor are merged without it) reads it as nothing:
 * it gets the grain and the scuffs and no more.
 */
import * as THREE from 'three';

/** What wears through and how, per material of weapons.glb (and lasergun.glb): the colour under the finish, how metallic and how rough that is, the grain's strength, the wood's streaks. */
interface Look {
  /** The finish itself, in place of the model's own: colour, metalness, roughness (the model's without) */
  finish?: [string, number, number];
  wear: string;
  metal: number;
  rough: number;
  grain: number;
  /** How many times the noise repeats per metre along x, y and z: stretched along the barrel into streaks for wood, fine for cloth (14 each way without) */
  scale?: [number, number, number];
  /** How much of the wear shows on this material, 0..1 (1 without) */
  amount?: number;
  /** Cloth and leather: worn means faded to a paler shade of its own colour, not to `wear` */
  fade?: boolean;
}
// The finishes: blued steel is a metal with a dark, fairly smooth face, so it shows the sky and the street
// dimmed and tinted; the polymer frame is a rough plastic with a soft sheen; the grip's rubber is matt. The wear
// on the hard edges is a thin line of steel a little brighter than the bluing, not bare silver: the bright
// grey it was read as chalk.
const LOOKS: Record<string, Look> = {
  Steel: { finish: ['#4d5056', 1, 0.3], wear: '#8a8e94', metal: 1, rough: 0.24, grain: 0.3, amount: 0.8 }, // bluing worn to steel
  Dark: { finish: ['#2a2c30', 0.7, 0.42], wear: '#62666c', metal: 0.9, rough: 0.3, grain: 0.35, amount: 0.6 },
  Polymer: { finish: ['#232426', 0, 0.6], wear: '#383a3e', metal: 0, rough: 0.45, grain: 0.45, amount: 0.7 }, // plastic rubbed a little smoother and paler
  Grip: { finish: ['#202123', 0, 0.88], wear: '#2a2b2e', metal: 0, rough: 0.7, grain: 0.6, amount: 0.4 }, // stippled rubber
  Olive: { finish: ['#4c5236', 0, 0.62], wear: '#72756f', metal: 0.8, rough: 0.35, grain: 0.3, amount: 0.6 }, // paint chipped to bare tube
  Warhead: { wear: '#686b63', metal: 0.7, rough: 0.4, grain: 0.25, amount: 0.6 },
  Wood: { wear: '#b98a5e', metal: 0, rough: 0.6, grain: 0.95, scale: [34, 34, 2.6], amount: 0.4 }, // oil finish worn to paler wood, in small patches along the grain
  Brass: { wear: '#d8b866', metal: 1, rough: 0.2, grain: 0.15 },
  // The laser rifle (lasergun.glb): its upper is dark anodised aluminium, glossy, that wears through to bright bare
  // metal on the edges; its lower and stock a paler matt polymer rubbed smoother; its fins bright metal like the
  // steel parts (they also glow with the heat: weapon.ts); the emitter's glass a dark glossy glass with only a faint grain.
  LaserAnodised: { finish: ['#23272e', 0.9, 0.2], wear: '#9aa0a8', metal: 1, rough: 0.22, grain: 0.22, amount: 0.55 },
  LaserPolymer: { finish: ['#35373a', 0, 0.82], wear: '#4b4d51', metal: 0, rough: 0.6, grain: 0.5, amount: 0.6 },
  LaserFin: { finish: ['#4d5056', 1, 0.3], wear: '#8a8e94', metal: 1, rough: 0.24, grain: 0.25, amount: 0.5 },
  LaserGlass: { finish: ['#0a1c26', 0, 0.03], wear: '#0a1c26', metal: 0, rough: 0.03, grain: 0.05, amount: 0 },
  // The pistol's slide (gun-pistol.glb): black nitrided steel with a soft gloss, worn to bright steel on its edges.
  PistolSlide: { finish: ['#2b2e33', 0.85, 0.26], wear: '#8e9298', metal: 1, rough: 0.22, grain: 0.25, amount: 0.65 },
  // The pump shotgun's receiver, barrel and magazine tube (gun-shotgun.glb): glossy blue-black bluing, worn to steel on the edges.
  ShotgunBlued: { finish: ['#272b32', 0.95, 0.28], wear: '#8e949c', metal: 1, rough: 0.22, grain: 0.25, amount: 0.6 },
  // The carbine (tools/guns/rifle.py): anodised aluminium (receivers, handguard, sights), a dyed satin layer that wears
  // through to bright aluminium on the edges; phosphated steel (barrel, gas block), a flat grey-black that wears to grey steel.
  RifleAnodised: { finish: ['#2a2d32', 0.35, 0.42], wear: '#8b9098', metal: 1, rough: 0.28, grain: 0.3, amount: 0.55 },
  RiflePhosphate: { finish: ['#2e2f30', 0.5, 0.62], wear: '#6c6f72', metal: 0.9, rough: 0.35, grain: 0.45, amount: 0.6 },
  // Your hands and arms: the sleeve's cloth (a fine weave, faded where it rubs), the glove's leather and its trim.
  Sleeve: { wear: '#ffffff', metal: 0, rough: 0.95, grain: 0.75, scale: [70, 70, 70], amount: 0.5, fade: true },
  Glove: { wear: '#ffffff', metal: 0, rough: 0.7, grain: 0.25, scale: [46, 46, 46], amount: 0.2, fade: true }, // its pieces are painted (tools/gloves.py): a little grain over them
  GloveTrim: { wear: '#ffffff', metal: 0, rough: 0.55, grain: 0.4, scale: [46, 46, 46], amount: 0.3, fade: true },
};

/**
 * The muzzle flash on your own hands and sleeves, 0..1 (weapon.ts sets it for the flash's moment): they
 * light up warm, as cloth and leather next to a real flash do. Only they: the gloves' and sleeves'
 * materials are yours alone, while a gun's are shared with the guns the others hold.
 */
export const handFlash = { value: 0 };

/** How much of the wear shows: 1, or 0 for Paintball's bright toy guns (they are new plastic). */
const amount = { value: 1 };
export function setGunWear(on: boolean): void {
  amount.value = on ? 1 : 0;
}

/** How far you are indoors, 0..1, eased as the lights are (world/indoorLight.ts): indoors the metal mirrors a dim room, not the sky. */
const inside = { value: 0 };
/** Each frame, with the indoor lights (main.ts). */
export function gunIndoors(dt: number, indoors: boolean): void {
  inside.value += ((indoors ? 1 : 0) - inside.value) * (1 - Math.exp(-dt * 1.5));
}

/** How much more of the world a metal part mirrors than a plain metal would (see MIRROR). */
const mirror = { value: 2 };

/**
 * What the guns mirror. Above the horizon the sky's own light map (world/environment.ts, so it follows the
 * weather: grey under clouds, dark at night), a little less blue than the open sky (the haze and the clouds
 * light a gun most), with a soft bright band at the horizon; below it the street, as lit now by the sun, the sky
 * and the hemisphere light (GROUND, worked out once per pixel in the shader's main part). Seen as it really is, a
 * dark blued slide mirrors the sky at a tenth of a sunlit wall and read as navy plastic; games light the gun in
 * your hands brighter than the world for that reason, so the metal parts mirror `mirror` times as much. In the
 * seams less of it (nothing reaches in there), and indoors a dim grey room instead of the sky. Capped well under
 * the half-float limit (the sun's pixels in the map are near it). A few sums, on the gun's pixels only.
 */
const MIRROR = THREE.ShaderChunk.envmap_physical_pars_fragment.replace(
  'return envMapColor.rgb * envMapIntensity;',
  `float gunSoft = 0.03 + 0.5 * roughness * roughness;
			float gunAbove = smoothstep( - gunSoft, gunSoft, reflectVec.y );
			vec3 gunSky = envMapColor.rgb * envMapIntensity;
			gunSky = mix( vec3( dot( gunSky, vec3( 0.2126, 0.7152, 0.0722 ) ) ), gunSky, 0.45 );
			gunSky *= 1.0 + 0.6 * exp( - pow( reflectVec.y / ( 0.06 + gunSoft ), 2.0 ) );
			vec3 gunSeen = mix( gunGround, gunSky, gunAbove );
			gunSeen = mix( gunSeen, vec3( dot( gunSeen, vec3( 0.2126, 0.7152, 0.0722 ) ) * 0.35 ), uGunInside );
			return min( gunSeen * gunSpecK, vec3( 30000.0 ) );`,
);

/**
 * The street's light as a gun mirrors it (into `gunGround`): grey paving (a fifth of the light comes back) lit by
 * the sun from above, the sky's light map and the hemisphere light. In the shader's main part, where the lights
 * are known; outdoors only (indoors MIRROR fades it all to a dim room).
 */
const GROUND = `{
	vec3 gunUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
	vec3 gunIrr = vec3( 0.0 );
	#if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
		gunIrr += getIBLIrradiance( gunUp );
	#endif
	#if NUM_DIR_LIGHTS > 0
		gunIrr += directionalLights[ 0 ].color * max( dot( gunUp, directionalLights[ 0 ].direction ), 0.0 );
	#endif
	#if NUM_HEMI_LIGHTS > 0
		gunIrr += getHemisphereLightIrradiance( hemisphereLights[ 0 ], gunUp );
	#endif
	gunGround = vec3( 0.21, 0.2, 0.19 ) * RECIPROCAL_PI * gunIrr;
}`;

let noise: THREE.DataTexture | null = null;
/**
 * The noise, 128 px, repeating: red a fine grain, green soft patches about a sixth of the picture
 * across, blue larger ones. From a fixed seed, so every visit looks the same.
 */
function noiseTexture(): THREE.DataTexture {
  if (noise) return noise;
  const N = 128;
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** Smooth noise that repeats: random values on a grid of `cells`, eased between. */
  const soft = (cells: number) => {
    const grid = Array.from({ length: cells * cells }, rnd);
    const ease = (t: number) => t * t * (3 - 2 * t);
    return (x: number, y: number) => {
      const fx = (x / N) * cells;
      const fy = (y / N) * cells;
      const x0 = Math.floor(fx) % cells;
      const y0 = Math.floor(fy) % cells;
      const x1 = (x0 + 1) % cells;
      const y1 = (y0 + 1) % cells;
      const tx = ease(fx - Math.floor(fx));
      const ty = ease(fy - Math.floor(fy));
      const a = grid[y0 * cells + x0] * (1 - tx) + grid[y0 * cells + x1] * tx;
      const b = grid[y1 * cells + x0] * (1 - tx) + grid[y1 * cells + x1] * tx;
      return a * (1 - ty) + b * ty;
    };
  };
  const patches = soft(6);
  const fine = soft(24);
  const large = soft(3);
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      data[i] = Math.round(255 * (0.5 * rnd() + 0.5 * fine(x, y)));
      data[i + 1] = Math.round(255 * (0.65 * patches(x, y) + 0.35 * fine(x, y)));
      data[i + 2] = Math.round(255 * (0.7 * large(x, y) + 0.3 * patches(x, y)));
      data[i + 3] = 255;
    }
  }
  noise = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  noise.wrapS = noise.wrapT = THREE.RepeatWrapping;
  noise.minFilter = THREE.LinearMipmapLinearFilter;
  noise.magFilter = THREE.LinearFilter;
  noise.generateMipmaps = true;
  noise.needsUpdate = true;
  return noise;
}

/**
 * After the vertex is placed on the screen: one that lies nearer than the camera's near edge is put on that
 * edge instead of being cut away. The gun in your hands is drawn at a quarter of its size close to the camera,
 * so that edge lies 20 cm (in the gun's size) from your eye, right through the stock and your right arm when
 * you aim; cut there, each showed its hollow inside. Kept, you see their outsides pass by, as with a real gun
 * at your cheek. Only the depth changes, never where a point is drawn. Down to a third of the near edge's
 * distance and no closer: what is right beside the eye (your forearm towards the elbow) is still left out, or
 * it filled a corner of the view as a grey lump.
 */
const NEAR_KEPT = '#include <project_vertex>\nif (gl_Position.z > -4.7 * gl_Position.w) gl_Position.z = max(gl_Position.z, -gl_Position.w * 0.9995);';

/** Keep the camera from cutting this material's shapes open close to the eye (the gloves and sleeves; the guns get it with their surface). */
export function noNearCut(m: THREE.Material): void {
  if (m.userData.nearKept) return;
  m.userData.nearKept = true;
  const before = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    before.call(m, shader, renderer);
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', NEAR_KEPT);
  };
  const key = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${key()}|near-kept`;
  m.needsUpdate = true;
}

/** Give one of a gun's or the hands' materials (by its name in weapons.glb) the worn, grained surface. Others are left alone (false). */
export function gunSurface(m: THREE.MeshStandardMaterial): boolean {
  const look = LOOKS[m.name];
  if (!look) return false;
  if (look.finish) {
    m.color.set(look.finish[0]);
    m.metalness = look.finish[1];
    m.roughness = look.finish[2];
  }
  const uniforms = {
    uGunInside: inside,
    uGunMirror: mirror,
    uGunNoise: { value: noiseTexture() },
    uGunWear: { value: new THREE.Color(look.wear) },
    uGunLook: { value: new THREE.Vector4(look.metal, look.rough, look.grain, look.amount ?? 1) },
    uGunScale: { value: new THREE.Vector3(...(look.scale ?? [14, 14, 14])) },
    uGunFade: { value: look.fade ? 1 : 0 },
    uHandFlash: look.fade ? handFlash : { value: 0 },
    uGunAmount: amount,
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 _shade;\nvarying vec3 vGunPos;\nvarying vec3 vGunNormal;\nvarying vec2 vGunShade;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGunPos = position;\nvGunNormal = normal;\nvGunShade = _shade;')
      .replace('#include <project_vertex>', NEAR_KEPT);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uGunNoise;
uniform vec3 uGunWear;
uniform vec4 uGunLook;
uniform vec3 uGunScale;
uniform float uGunFade;
uniform float uHandFlash;
uniform float uGunAmount;
uniform float uGunInside;
uniform float uGunMirror;
varying vec3 vGunPos;
varying vec3 vGunNormal;
varying vec2 vGunShade;
float gunSpecK = 1.0; // how much of the mirrored world reaches this pixel: less in the seams, more on metal
vec3 gunGround = vec3(0.0); // the street's light as mirrored (GROUND)`)
      .replace('#include <envmap_physical_pars_fragment>', MIRROR)
      .replace('#include <color_fragment>', `#include <color_fragment>
// The noise from the three sides, most from the side the surface faces. Wood: stretched along the barrel into streaks.
vec3 gunW = pow(abs(normalize(vGunNormal)), vec3(4.0));
gunW /= gunW.x + gunW.y + gunW.z;
vec3 gunQ = vGunPos * uGunScale;
vec3 gunN = texture2D(uGunNoise, gunQ.zy).rgb * gunW.x + texture2D(uGunNoise, gunQ.xz).rgb * gunW.y + texture2D(uGunNoise, gunQ.xy).rgb * gunW.z;
// Worn: the hard edges in patches, and a few scuffs on the flats.
float gunWorn = uGunAmount * uGunLook.w * max(vGunShade.y * smoothstep(0.3, 0.5, gunN.g), 0.5 * smoothstep(0.68, 0.76, gunN.b) * smoothstep(0.5, 0.62, gunN.g));
diffuseColor.rgb *= 1.0 + (gunN.r - 0.5) * uGunLook.z + (gunN.b - 0.5) * 0.5 * uGunLook.z;
diffuseColor.rgb = mix(diffuseColor.rgb, mix(uGunWear, diffuseColor.rgb * 1.7 + 0.015, uGunFade), gunWorn);
diffuseColor.rgb *= 1.0 - 0.62 * vGunShade.x; // the seams and the gaps between the parts
gunSpecK = 1.0 - 0.75 * vGunShade.x; // and they mirror little of the world`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = clamp(mix(roughnessFactor + (gunN.r - 0.5) * 0.5 * uGunLook.z + 0.25 * vGunShade.x, uGunLook.y, gunWorn), 0.05, 1.0);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += uHandFlash * vec3(1.0, 0.6, 0.28) * 0.55 * (0.6 + 0.8 * gunN.r);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor, uGunLook.x, gunWorn);
gunSpecK *= mix(1.0, uGunMirror, metalnessFactor);
${GROUND}`);
  };
  m.userData.gunUniforms = uniforms;
  m.customProgramCacheKey = () => 'gun-surface';
  m.needsUpdate = true;
  return true;
}
