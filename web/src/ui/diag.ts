import * as THREE from 'three';

/**
 * A diagnostics panel for phones, which have no developer console: open the site with ?diag and
 * it lists the graphics chip, the preset, what the graphics memory holds, WebGL errors, a lost
 * context, files that failed to load and script errors, refreshed every second. With ?diag&plain
 * the materials also drop their textures (flat colours), to tell a texture fault from a lighting one.
 */
export function startDiag(renderer: THREE.WebGLRenderer, scene: THREE.Scene, quality: () => string): void {
  const params = new URLSearchParams(location.search);
  if (!params.has('diag')) return;
  const box = document.createElement('pre');
  box.style.cssText =
    'position:fixed;left:8px;top:8px;z-index:100000;max-width:62vw;max-height:84vh;overflow:hidden;margin:0;padding:8px;' +
    'background:rgba(0,0,0,.78);color:#9f9;font:10px/1.3 monospace;white-space:pre-wrap;pointer-events:none';
  document.body.appendChild(box);

  const notes: string[] = [];
  const note = (s: string) => {
    notes.push(s.slice(0, 180));
    if (notes.length > 14) notes.shift();
  };
  window.addEventListener('error', (e) => note(`error: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => note(`promise: ${String(e.reason)}`));
  renderer.domElement.addEventListener('webglcontextlost', () => note('WEBGL CONTEXT LOST'));
  renderer.domElement.addEventListener('webglcontextrestored', () => note('webgl context restored'));
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      note(`${level}: ${args.map(String).join(' ')}`);
      original(...args);
    };
  }
  const before = THREE.DefaultLoadingManager.onError;
  THREE.DefaultLoadingManager.onError = (url) => {
    note(`failed to load: ${url}`);
    before?.(url);
  };

  const gl = renderer.getContext() as WebGL2RenderingContext;
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const ext = (name: string) => (gl.getExtension(name) ? 'yes' : 'NO');
  const fixed = [
    `${navigator.userAgent.replace(/^Mozilla\/5.0 /, '').slice(0, 120)}`,
    `gpu ${info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)} · webgl${renderer.capabilities.isWebGL2 ? 2 : 1}`,
    `max texture ${gl.getParameter(gl.MAX_TEXTURE_SIZE)} · float linear ${ext('OES_texture_float_linear')} · float targets ${ext('EXT_color_buffer_float')} · half targets ${ext('EXT_color_buffer_half_float')}`,
  ];
  const errors = new Map<number, number>();
  let plainDone = false;

  setInterval(() => {
    for (let e = gl.getError(), i = 0; e !== gl.NO_ERROR && i < 20; e = gl.getError(), i++) errors.set(e, (errors.get(e) ?? 0) + 1);
    // Textures the materials use: how many have their picture yet, how many are still empty.
    const seen = new Set<THREE.Texture>();
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
        for (const v of Object.values(mat)) if (v instanceof THREE.Texture) seen.add(v);
        if (params.has('plain') && mat instanceof THREE.MeshStandardMaterial && (mat.map || mat.normalMap || mat.roughnessMap)) {
          mat.map = mat.normalMap = mat.roughnessMap = null;
          mat.needsUpdate = true;
          plainDone = true;
        }
      }
    });
    const empty = [...seen].filter((t) => !t.image || (t.image as { width?: number }).width === 0).length;
    const c = renderer.domElement;
    const r = renderer.info;
    box.textContent = [
      ...fixed,
      `preset ${quality()} · screen ${innerWidth}x${innerHeight} @${devicePixelRatio} · canvas ${c.width}x${c.height}`,
      `in memory: ${r.memory.geometries} geometries, ${r.memory.textures} textures · ${r.programs?.length ?? 0} shaders`,
      `textures on materials: ${seen.size}, ${empty} without a picture${plainDone ? ' · PLAIN (textures off)' : ''}`,
      `webgl errors: ${errors.size ? [...errors].map(([e, n]) => `0x${e.toString(16)}×${n}`).join(' ') : 'none'}`,
      ...notes,
    ].join('\n');
  }, 1000);
}
