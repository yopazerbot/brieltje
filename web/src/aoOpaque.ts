import * as THREE from 'three';
import type { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';

/**
 * The ambient occlusion (GTAO, High and Ultra) on what is solid only.
 *
 * As a pass after the whole scene it darkened everything in the picture by the corners of the solid scene behind:
 * mist, smoke, glass, rain and the lights' glow too. Through a dark, thin layer of mist the canopy's occlusion
 * behind it showed as grain. Now it is worked out and multiplied into the picture in the middle of the scene's own
 * drawing: after the solid things, before the blended ones. Three draws everything solid first, then everything
 * transparent from far to near; a marker drawn first among the transparent ones (it draws nothing itself) runs the
 * occlusion there, from the depth the solid things have just written, into the target being drawn (the same in-place
 * multiply the pass did, without its copy of the picture). The transparent things then go on top, untouched. No new
 * pass and no new render target: the pass's own two targets, as before.
 *
 * Only for the main view's picture (the composer's targets, its camera): the glass's and the puddles' views of the
 * street draw the same scene into targets of their own and are left as they were. The pass stays in the composer for
 * its size and its on and off (preset), and draws nothing there.
 */
export function aoOnOpaque(scene: THREE.Scene, camera: THREE.Camera, ao: GTAOPass, targets: () => THREE.WebGLRenderTarget[]): { on: boolean } {
  const state = { on: true };
  const own = ao.render.bind(ao);
  const marker = new THREE.Mesh(
    new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3)),
    new THREE.MeshBasicMaterial({ transparent: true, colorWrite: false, depthWrite: false, depthTest: false }),
  );
  marker.name = 'aoOnOpaque';
  marker.renderOrder = -1e9; // the first of the transparent things
  marker.frustumCulled = false;
  marker.userData.ignoreRay = true;
  marker.raycast = () => {};
  marker.onBeforeRender = (renderer, _scene, cam) => {
    const target = renderer.getRenderTarget();
    if (!ao.enabled || !state.on || cam !== camera || !target?.depthTexture || !targets().includes(target)) return;
    const depth = target.depthTexture;
    ao.gtaoMaterial.uniforms.tDepth.value = depth;
    ao.pdMaterial.uniforms.tDepth.value = depth;
    ao.output = GTAO_OFF; // only its occlusion and denoise, into its own targets
    own(renderer, target, target, 0, false);
    // Multiplied into the picture being drawn, in place (as the pass's own blend does).
    ao.blendMaterial.uniforms.intensity.value = ao.blendIntensity;
    ao.blendMaterial.uniforms.tDiffuse.value = ao.pdRenderTarget.texture;
    (ao as unknown as { _renderPass(r: THREE.WebGLRenderer, m: THREE.Material, t: THREE.WebGLRenderTarget | null): void })._renderPass(renderer, ao.blendMaterial, target);
    renderer.setRenderTarget(target);
  };
  scene.add(marker);
  // In the composer the pass now draws nothing and leaves the picture where it is; off, the old pass as it was.
  ao.render = (renderer, write, read, dt, mask) => {
    if (state.on) return;
    ao.gtaoMaterial.uniforms.tDepth.value = read.depthTexture;
    ao.pdMaterial.uniforms.tDepth.value = read.depthTexture;
    ao.output = GTAO_DEFAULT;
    own(renderer, write, read, dt, mask);
  };
  Object.defineProperty(ao, 'needsSwap', { get: () => !state.on });
  return state;
}

/** GTAOPass.OUTPUT.Off and .Default. */
const GTAO_OFF = -1;
const GTAO_DEFAULT = 0;
