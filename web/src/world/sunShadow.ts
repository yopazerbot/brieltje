import * as THREE from 'three';

/**
 * Where the sun's real-time shadow map lies (graphics.ts shadowReach).
 *
 * On Low it stays on the main house, 17 m round it, and is only drawn near the house (main.ts), as it always
 * was. On Medium and up it follows the eye: its middle lies ahead of you, so more of it is in front than
 * behind, and it moves only by whole texels of the map, along the map's own rows and columns. A map that
 * slides by part of a texel draws every shadow edge a little differently each frame, and edges crawl as you
 * walk (shimmer); moved by whole texels, a still edge stays the same.
 *
 * A second, coarser map round the first (the far map, `far`: Medium and up) carries the sun's shadow further out,
 * 60 to 120 m by the preset: the cars, people, posts and street furniture there throw a shadow, and at dusk the
 * houses' and trees' long ones reach across the streets. Not three's CSM (it puts its own shader on every material
 * and would replace the game's own changes to them): the far map belongs to a light of its own that gives no light,
 * and the sun's shadow lookup (patched once in three's light chunk, patchCascade) reads the sharp map where it
 * reaches and the far one beyond it, blended over a band, so no line shows where the near one ends. Each pixel still
 * reads one map (two only in the band). The far map moves by its own whole texels too, so its edges don't crawl.
 * Further off still, the bakes hold the shadows of everything that stands still: world/groundShade.ts on the
 * ground, world/bakedLight.ts on our own models. The ground hands over from its bake to the maps where they reach
 * (`uniforms`: the outer map's), so the bake's soft, coarse shadow doesn't lie as a halo round the maps' sharp one;
 * the far map's own shadow fades out over the same band, so the hand-over has no edge either.
 */

/** The house's map: its middle, half its width, and its depth along the sun (as before the map could move). */
const HOME_HALF = 17;
const HOME_AWAY = 60;
const HOME_NEAR = 5;
const HOME_FAR = 140;
/** A following map: the light this far up the sun from its middle, seeing this far towards and past it. */
const AWAY = 140;
const NEAR = 10; // 130 m towards the sun: the church tower's shadow at a low sun
const FAR = 260; // 120 m past the middle: the ground down-sun of it, at a low sun
/** The house map's bias, in metres along the sun's ray (three's bias is a share of the depth range). */
const BIAS_M = 0.0003 * (HOME_FAR - HOME_NEAR);
/**
 * The far map: the light this far up the sun from its middle, seeing this far towards and past it. At dusk's low sun
 * the map lies on the ground about four times as long along the sun as it is wide, so it sees far both ways.
 */
const FAR_AWAY = 420;
const FAR_NEAR = 20;
const FAR_FAR = 820;
/** The far map's bias along the sun's ray and off the surface, in its texels (they are 6 to 12 cm). */
const FAR_BIAS = 1.5;
const FAR_NORMAL = 0.8;
const UP = new THREE.Vector3(0, 1, 0);

/**
 * The sun's shadow lookup in three's light chunk, for every lit material (once, at the start, before anything
 * compiles): the sun (light 0) reads its sharp map, and beyond it the far map of light 1 (SunShadow.far), blended
 * over the sharp map's outer band (0.82 to 0.96 of the way to its side, the ground's hand-over band in
 * world/groundShade.ts) and fading out over the same band of the far map's. Light 1 gives no light: its turn of the
 * loop is left out. Each pixel reads one map, two in the band. With the far map off (its shadow's intensity 0: Low,
 * phones) the sharp map fades out over its band. Other patches (world/bakedLight.ts, world/walkIn.ts,
 * world/lampLight.ts) find the lines they look for as before.
 */
function patchCascade(): void {
  const chunk = THREE.ShaderChunk.lights_fragment_begin;
  const start = chunk.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )');
  const end = chunk.indexOf('#pragma unroll_loop_end', start);
  const pick = 'directionalLight = directionalLights[ i ];';
  const look = 'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;';
  const direct = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
  const part = start < 0 || end < 0 ? '' : chunk.slice(start, end);
  if (!part.includes(pick) || !part.includes(look) || !part.includes(direct)) {
    console.warn('sunShadow: three.js light chunk changed; no far shadow map');
    return;
  }
  const cascade = `#if UNROLLED_LOOP_INDEX == 0 && NUM_DIR_LIGHT_SHADOWS > 1
		if ( directLight.visible && receiveShadow ) {
			vec3 scNear = abs( vDirectionalShadowCoord[ 0 ].xyz - 0.5 ) * 2.0;
			float scOut = smoothstep( 0.82, 0.96, max( max( scNear.x, scNear.y ), scNear.z ) );
			float scLit = 1.0;
			if ( scOut < 1.0 ) scLit = getShadow( directionalShadowMap[ 0 ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ 0 ] );
			if ( scOut > 0.0 ) {
				float scFar = 1.0;
				if ( directionalLightShadows[ 1 ].shadowIntensity > 0.0 ) {
					vec3 scB = abs( vDirectionalShadowCoord[ 1 ].xyz - 0.5 ) * 2.0;
					float scIn = 1.0 - smoothstep( 0.82, 0.96, max( max( scB.x, scB.y ), scB.z ) );
					if ( scIn > 0.0 ) scFar = mix( 1.0, getShadow( directionalShadowMap[ 1 ], directionalLightShadows[ 1 ].shadowMapSize, directionalLightShadows[ 1 ].shadowIntensity, directionalLightShadows[ 1 ].shadowBias, directionalLightShadows[ 1 ].shadowRadius, vDirectionalShadowCoord[ 1 ] ), scIn );
				}
				scLit = mix( scLit, scFar, scOut );
			}
			directLight.color *= scLit;
		}
		#else
		${look}
		#endif`;
  const patched = part
    .replace(pick, `#if UNROLLED_LOOP_INDEX == 0 || NUM_DIR_LIGHT_SHADOWS < 2\n\t\t${pick}`)
    .replace(look, cascade)
    .replace(direct, `${direct}\n\t\t#endif`);
  THREE.ShaderChunk.lights_fragment_begin = chunk.slice(0, start) + patched + chunk.slice(end);
}
patchCascade();

/** Development only: ?noshadowcast leaves out the stand-ins' shadows (castLayers, world/streetModel.ts), to measure their cost. */
export const castsStandIns = !(import.meta.env.DEV && new URLSearchParams(location.search).has('noshadowcast'));

/**
 * Let the sun's shadow pass draw the stand-ins on these layers (world/tiles.ts SHADOW_LAYER, CAST_LAYER: the near
 * trees' lighter crowns, their trunks, the fence posts). three.js draws into a shadow map what the camera being drawn
 * for sees (its layers), not what the shadow camera sees, so a stand-in on a layer of its own never reached the map:
 * the trees had no shadow within its reach. That camera sees these layers for the shadow pass only.
 */
export function castLayers(renderer: THREE.WebGLRenderer, layers: number[]): void {
  if (!castsStandIns) return;
  const map = renderer.shadowMap;
  const render = map.render.bind(map);
  map.render = (lights, scene, camera) => {
    const mask = camera.layers.mask;
    for (const l of layers) camera.layers.enable(l);
    try {
      render(lights, scene, camera);
    } finally {
      camera.layers.mask = mask;
    }
  };
}

/**
 * Left out of the far map: the flat ground's own covers (paving, roads, gravel, kerbs: their shadow is a kerb's, a few
 * centimetres, under a texel that far out) and the parked bikes' spoked wheels. A third of what the map would draw.
 */
const NOT_FAR = /^(pave_|rd_|road|gravel|field_soil|paving|kerb)|^bike-Wheel/;

export class SunShadow {
  /**
   * For the ground's handover (world/groundShade.ts): world to the map's clip space (-1 to 1 inside it), and
   * 1 while the map is drawn.
   */
  readonly uniforms = { liveMatrix: { value: new THREE.Matrix4() }, liveOn: { value: 0 } };
  /** The map's middle now (world/tiles.ts draws the tiles round it into the map). */
  readonly middle = new THREE.Vector3();
  /**
   * The far map's light (main.ts adds it to the scene right after the sun, so it is light 1 in three's list): it
   * gives no light; its shadow's intensity says whether the far map is read (1) or not (0). Always in the scene and
   * casting, so the materials' shaders don't change with the preset.
   */
  readonly far = new THREE.DirectionalLight(0xffffff, 0);
  /** The far map's middle now, and where it lies in the map's space (world to its clip space) */
  readonly farMiddle = new THREE.Vector3();
  private farMatrix = new THREE.Matrix4();
  private reach = 0;
  private texel = 1;
  private farReach = 0;
  private farTexel = 1;
  private farEvery = 1;
  private farWait = 0;
  private dir = new THREE.Vector3();
  private x = new THREE.Vector3();
  private y = new THREE.Vector3();
  private fwd = new THREE.Vector3();

  /** What the far map leaves out (NOT_FAR), found again every few seconds as the tiles and things come and go */
  private notFar: THREE.Object3D[] = [];
  private notFarAt = -Infinity;

  constructor(
    private sun: THREE.DirectionalLight,
    private home: THREE.Vector3,
    renderer?: THREE.WebGLRenderer,
  ) {
    if (renderer) this.drawFarApart(renderer);
    this.middle.copy(home);
    this.farMiddle.copy(home);
    const f = this.far;
    f.name = 'sun far shadow';
    f.castShadow = true;
    f.shadow.autoUpdate = false;
    f.shadow.intensity = 0;
    f.shadow.mapSize.set(256, 256);
    f.target.position.copy(home);
  }

  /** Whether the map follows the eye (Medium and up). */
  get follows(): boolean {
    return this.reach > 0;
  }

  /** Whether the far map is drawn this frame, or has none yet (main.ts then has three draw the shadow maps). */
  get farDue(): boolean {
    return this.far.shadow.needsUpdate;
  }

  /**
   * The preset's reach (0: on the house) and the map's size in texels; the far map's reach (0: none), its size, and
   * every how many frames it is drawn again (the still things in it don't move; what moves, that far off, a frame late).
   */
  setup(reach: number, size: number, farReach = 0, farSize = 1024, farEvery = 1): void {
    this.reach = reach;
    const half = reach > 0 ? reach : HOME_HALF;
    const c = this.sun.shadow.camera;
    c.left = c.bottom = -half;
    c.right = c.top = half;
    c.near = reach > 0 ? NEAR : HOME_NEAR;
    c.far = reach > 0 ? FAR : HOME_FAR;
    c.updateProjectionMatrix();
    this.sun.shadow.bias = -BIAS_M / (c.far - c.near);
    this.texel = (2 * half) / Math.max(1, size);

    // The far map: only round a following map. Off, it keeps a small map that is never read (one must exist).
    this.farReach = reach > 0 ? farReach : 0;
    this.farEvery = Math.max(1, farEvery);
    const f = this.far.shadow;
    const want = this.farReach > 0 ? farSize : 256;
    if (f.mapSize.x !== want) {
      f.mapSize.set(want, want);
      f.map?.dispose();
      f.map = null;
    }
    const fhalf = this.farReach > 0 ? this.farReach : HOME_HALF;
    const fc = f.camera;
    fc.left = fc.bottom = -fhalf;
    fc.right = fc.top = fhalf;
    fc.near = FAR_NEAR;
    fc.far = FAR_FAR;
    fc.updateProjectionMatrix();
    this.farTexel = (2 * fhalf) / want;
    f.bias = -(FAR_BIAS * this.farTexel) / (FAR_FAR - FAR_NEAR);
    f.normalBias = FAR_NORMAL * this.farTexel;
    f.radius = 1;
    this.farWait = 0;
    f.needsUpdate = true;
  }

  /** Each frame, before drawing: the map round the eye (or on the house), the far map round it, and the ground's matrix. */
  update(camera: THREE.Camera): void {
    const sun = this.sun;
    // The sun's direction as the light has it now (world/environment.ts sets it from the sky photo).
    this.dir.subVectors(sun.position, sun.target.position);
    if (this.dir.lengthSq() < 1e-8) return;
    this.dir.normalize();
    // The maps' rows and columns, as three's shadow camera looks along the sun (Matrix4.lookAt).
    this.x.crossVectors(UP, this.dir);
    if (this.x.lengthSq() < 1e-8) this.x.set(1, 0, 0);
    this.x.normalize();
    this.y.crossVectors(this.dir, this.x);
    camera.getWorldDirection(this.fwd);
    this.fwd.y = 0;
    if (this.fwd.lengthSq() < 1e-6) this.fwd.set(0, 0, -1);
    this.fwd.normalize();
    // Ahead of the eye on the ground, so that the eye is half the reach from the middle in the map.
    if (this.reach > 0) this.place(this.middle, camera.position, 0.5, this.reach, this.texel);
    else this.middle.copy(this.home);
    sun.target.position.copy(this.middle);
    sun.position.copy(this.middle).addScaledVector(this.dir, this.reach > 0 ? AWAY : HOME_AWAY);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();
    sun.shadow.updateMatrices(sun);
    const c = sun.shadow.camera;
    this.uniforms.liveMatrix.value.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
    this.uniforms.liveOn.value = sun.castShadow ? 1 : 0;

    // The far map: moved and drawn every farEvery frames while the sun's map is drawn (not under clouds), and once
    // whenever it has none. Moved only when drawn, so the map and its matrix always agree.
    const f = this.far;
    const drawn = this.farReach > 0 && sun.castShadow && sun.shadow.autoUpdate;
    if (drawn && --this.farWait <= 0) {
      this.farWait = this.farEvery;
      this.place(this.farMiddle, camera.position, 0.3, this.farReach, this.farTexel);
      f.target.position.copy(this.farMiddle);
      f.position.copy(this.farMiddle).addScaledVector(this.dir, FAR_AWAY);
      f.target.updateMatrixWorld();
      f.updateMatrixWorld();
      f.shadow.updateMatrices(f);
      this.farMatrix.multiplyMatrices(f.shadow.camera.projectionMatrix, f.shadow.camera.matrixWorldInverse);
      f.shadow.needsUpdate = true;
    } else if (!f.shadow.map) f.shadow.needsUpdate = true;
    f.shadow.intensity = drawn ? 1 : 0; // under clouds not read either
    // The ground lets the maps decide out to the outer one's edge.
    if (this.farReach > 0) this.uniforms.liveMatrix.value.copy(this.farMatrix);
  }

  /** `p`: a map's middle `ahead` of its reach before the eye (in the map), by whole texels along its rows and columns. */
  private place(p: THREE.Vector3, eye: THREE.Vector3, ahead: number, reach: number, texel: number): void {
    const across = Math.hypot(this.fwd.dot(this.x), this.fwd.dot(this.y));
    const by = Math.min((ahead * reach) / Math.max(across, 1e-3), 4 * ahead * reach);
    p.copy(eye).addScaledVector(this.fwd, by);
    p.y -= 1.5;
    // Whole texels along the map's rows and columns; along the sun it doesn't matter.
    const px = Math.round(p.dot(this.x) / texel) * texel;
    const py = Math.round(p.dot(this.y) / texel) * texel;
    const pz = p.dot(this.dir);
    p.copy(this.x).multiplyScalar(px).addScaledVector(this.y, py).addScaledVector(this.dir, pz);
  }

  /**
   * The far map drawn in a pass of its own, without what NOT_FAR names: three draws every light's map in one call
   * with the same things in each, so the sun's maps go first and the far one after, those things hidden meanwhile.
   */
  private drawFarApart(renderer: THREE.WebGLRenderer): void {
    const map = renderer.shadowMap;
    const render = map.render.bind(map);
    const others: THREE.Light[] = [];
    const farOnly: THREE.Light[] = [this.far];
    map.render = (lights, scene, camera) => {
      if (!this.far.shadow.needsUpdate || !lights.includes(this.far)) {
        render(lights, scene, camera);
        return;
      }
      others.length = 0;
      for (const l of lights) if (l !== this.far) others.push(l);
      if (others.length) render(others, scene, camera);
      const now = performance.now();
      if (now - this.notFarAt > 3000) {
        this.notFarAt = now;
        this.notFar.length = 0;
        scene.traverse((o) => {
          if ((o as THREE.Mesh).isMesh && o.castShadow && NOT_FAR.test(o.name)) this.notFar.push(o);
        });
      }
      const shown = this.notFar.map((o) => o.visible);
      for (const o of this.notFar) o.visible = false;
      map.needsUpdate = true; // the first call has cleared it
      try {
        render(farOnly, scene, camera);
      } finally {
        this.notFar.forEach((o, i) => (o.visible = shown[i]));
      }
    };
  }
}
