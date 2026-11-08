import * as THREE from 'three';

/**
 * Shaders compiled in the background before their first use. A shader program is compiled when something is first
 * drawn with it, and that first draw waits for it: on this PC the ambient occlusion's, the sky's light maps' and the
 * ground shading's bakes held the page up for about 1.6 s of the loading, one after another. Asked for early with
 * `renderer.compile` (no drawing), they compile alongside the rest of the loading where the browser can
 * (KHR_parallel_shader_compile), and the first draw finds them ready. three keeps each program by its source and
 * settings, so a program made here is the one the draw takes, as long as the settings match: the same material, the
 * same kind of object, the same lights, and drawn into a texture (`toScreen` false) or onto the screen.
 */

/** A small texture to compile into: a program only knows whether it draws into one, not which. */
let into: THREE.WebGLRenderTarget | null = null;

function withTarget(renderer: THREE.WebGLRenderer, toScreen: boolean, compile: () => void): void {
  const was = renderer.getRenderTarget();
  const face = renderer.getActiveCubeFace();
  const level = renderer.getActiveMipmapLevel();
  renderer.setRenderTarget(toScreen ? null : (into ??= new THREE.WebGLRenderTarget(1, 1)));
  try {
    compile();
  } finally {
    renderer.setRenderTarget(was, face, level);
  }
}

/** The camera of the full-screen passes (as three's FullScreenQuad). */
const flat = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

/**
 * A geometry with corners, as a full-screen pass's quad and the light maps' planes have: whether a geometry has
 * positions is part of a program's settings (an empty one, as three's own PMREM compile uses, makes another program).
 */
const corners = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));

/** A full-screen pass's material, as its quad draws it (no lights, a geometry with corners). */
export function compileQuad(renderer: THREE.WebGLRenderer, material: THREE.Material, toScreen = false): void {
  withTarget(renderer, toScreen, () => renderer.compile(new THREE.Mesh(corners, material), flat));
}

/**
 * What `renderer.render(scene, camera)` would compile, without drawing: only what it would draw (shown, with its
 * parents, on the camera's layers, its material visible), with the scene's override material in place of each
 * material that allows it (renderer.compile alone leaves the override out, and compiles hidden things too).
 */
export function compileDrawn(renderer: THREE.WebGLRenderer, scene: THREE.Object3D, camera: THREE.Camera, toScreen = false): void {
  const over = (scene as THREE.Scene).isScene ? (scene as THREE.Scene).overrideMaterial : null;
  const shown = new Set<THREE.Object3D>();
  // As the drawing finds them, but every level of a level of detail (LOD): the camera of each drawing picks one.
  const walk = (o: THREE.Object3D, level = false) => {
    if (!o.visible && !level) return;
    shown.add(o);
    const lod = (o as THREE.LOD).isLOD && (o as THREE.LOD).autoUpdate;
    for (const c of o.children) walk(c, lod);
  };
  walk(scene);
  const kept: [{ material?: THREE.Material | THREE.Material[] | null }, THREE.Material | THREE.Material[]][] = [];
  const pick = (m: THREE.Material) => (over && m.allowOverride ? over : m);
  scene.traverse((o) => {
    const d = o as THREE.Object3D & { material?: THREE.Material | THREE.Material[] | null; isMesh?: boolean; isPoints?: boolean; isLine?: boolean; isSprite?: boolean };
    if (!d.material || !(d.isMesh || d.isPoints || d.isLine || d.isSprite)) return;
    const own = d.material;
    kept.push([d, own]);
    if (!shown.has(o) || !o.layers.test(camera.layers)) d.material = null;
    else if (Array.isArray(own)) d.material = own.map(pick);
    else d.material = own.visible ? pick(own) : null;
  });
  try {
    withTarget(renderer, toScreen, () => renderer.compile(scene, camera));
  } finally {
    for (const [d, m] of kept) d.material = m;
  }
}

/**
 * The ambient occlusion's and the edge smoothing's shaders (the occlusion's alone held the graphics test up for half
 * a second): the occlusion draws into textures, the smoothing's last step onto the screen (it is the last pass).
 */
export function warmPasses(renderer: THREE.WebGLRenderer, ao: { gtaoMaterial: THREE.Material; pdMaterial: THREE.Material; copyMaterial: THREE.Material; blendMaterial: THREE.Material }, smaa: object): void {
  for (const m of [ao.gtaoMaterial, ao.pdMaterial, ao.copyMaterial, ao.blendMaterial]) compileQuad(renderer, m);
  const s = smaa as { _materialEdges?: THREE.Material; _materialWeights?: THREE.Material; _materialBlend?: THREE.Material };
  for (const m of [s._materialEdges, s._materialWeights]) if (m) compileQuad(renderer, m);
  if (s._materialBlend) compileQuad(renderer, s._materialBlend, true);
}

interface PmremInside {
  _setSize?: (cubeSize: number) => void;
  _allocateTargets?: () => THREE.WebGLRenderTarget;
  _ggxMaterial?: THREE.Material | null;
  _equirectMaterial?: THREE.Material | null;
  _compileMaterial?: (m: THREE.Material) => void;
}

/**
 * The sky's light maps' shaders (three's PMREMGenerator) for a photo `width` pixels across, compiled while the photo
 * still downloads: a generator of the same size makes the same shaders. Call the returned function once the light
 * maps are made: until then the generator is kept, as disposing it would let three delete the programs.
 */
export function warmSkyLight(renderer: THREE.WebGLRenderer, width: number): () => void {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const inside = pmrem as unknown as PmremInside;
  let target: THREE.WebGLRenderTarget | null = null;
  try {
    // The photo onto the maps' texture: three makes its material in compileEquirectangularShader, whose own compile
    // is left out (an empty geometry: not the program the maps take).
    if (typeof inside._compileMaterial === 'function') inside._compileMaterial = () => undefined;
    pmrem.compileEquirectangularShader();
    if (inside._equirectMaterial) compileQuad(renderer, inside._equirectMaterial);
    // The blur's shader holds the maps' size: only three's own steps make it (a later three without them: skipped).
    if (typeof inside._setSize === 'function' && typeof inside._allocateTargets === 'function') {
      inside._setSize(width / 4);
      target = inside._allocateTargets();
      if (inside._ggxMaterial) compileQuad(renderer, inside._ggxMaterial);
    }
  } catch {
    // only a head start: the light maps compile it themselves if this didn't
  }
  return () => {
    target?.dispose();
    pmrem.dispose();
  };
}
