// A view's scene for Blender (tools/still/render_still.py). Run it in the page on the dev server
// (developer console, or a CDP Runtime.evaluate with awaitPromise): it downloads start_scene.glb
// (everything visible, the camera) and start_info.json (sun, the sky's turn). The camera is the start
// screen's, or `window.stillView` ({ position, target, fov }: the slideshow's views in views.json, with
// the player moved near the view first so the area round it is loaded). The game's texture files are
// noted per material (glTF extras) instead of embedded. The portals, anything drawn by a shader of
// its own (smoke, butterflies, soft ground patches) instanced birds and flies, and surfaces drawn from behind only stay out: glTF can't carry them, and Cycles
// shades the ground itself.
(async () => {
  const { GLTFExporter } = await import('/@id/three/examples/jsm/exporters/GLTFExporter.js');
  const t = briel.three;
  const scene = t.scene;
  const view = window.stillView;
  briel.portals.group.visible = false;

  // The textures the game loads from /textures/ are noted on the material (glTF extras) instead of
  // embedded: Blender takes the full-size files from web/public/textures.
  const KEYS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap'];
  const stripped = [];
  const unseen = [];
  const seen = new Set();
  const objects = [];
  scene.traverse((o) => {
    if (!(o.isMesh || o.isInstancedMesh) || !o.visible) return;
    for (let p = o; p; p = p.parent) if (!p.visible) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.every((m) => m && m.visible === false)) { o.visible = false; unseen.push(o); return; } // hit spheres and the like: drawn nowhere
    if (mats.some((m) => m && m.isShaderMaterial)) { o.visible = false; unseen.push(o); return; }
    // Drawn from behind only (the bungalow's attic underside is its roof again, seen from inside): glTF
    // has no such side, so it would cover the roof. The renders are all from outside.
    if (mats.some((m) => m && m.side === 1)) { o.visible = false; unseen.push(o); return; }
    // Birds, flies and sparks drawn as instances with attributes of their own: glTF can't carry those either.
    if (o.geometry?.isInstancedBufferGeometry || Object.values(o.geometry?.attributes ?? {}).some((x) => x.isInstancedBufferAttribute)) { o.visible = false; unseen.push(o); return; }
    if (o.isInstancedMesh && o.instanceColor) {
      // Colour per instance (hedge clumps): the range, for Blender to pick from per object.
      const c = o.instanceColor.array;
      const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
      for (let i = 0; i < c.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], c[i + k]); hi[k] = Math.max(hi[k], c[i + k]); }
      for (const m of mats) if (m) m.userData = { ...m.userData, instanceColors: { lo, hi } };
    }
    for (const m of mats) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      const tex = {};
      for (const k of KEYS) {
        const tx = m[k];
        const src = tx && tx.image && tx.image.src;
        if (src && src.includes('/textures/')) {
          tex[k] = { src: new URL(src).pathname, repeat: tx.repeat.toArray(), offset: tx.offset.toArray(), rotation: tx.rotation, center: tx.center.toArray() };
          stripped.push([m, k, tx]);
          m[k] = null;
        }
      }
      m.userData = { ...m.userData, tex, kind: m.type, transparent: m.transparent, opacity: m.opacity, transmission: m.transmission ?? 0, sideDouble: m.side === 2, vertexColors: !!m.vertexColors, fog: m.fog !== false };
      m.needsUpdate = true;
    }
  });
  for (const o of scene.children) if (o.visible && !o.isLight && !o.isCamera) objects.push(o);
  // The start screen's camera (main.ts startCamera, wide screens), or the view's.
  const fov = view?.fov ?? 72;
  const cam = new t.composer.passes[0].camera.constructor(fov, 16 / 9, 0.05, 2000);
  cam.name = 'StartCamera';
  if (view) {
    cam.position.fromArray(view.position);
    cam.lookAt(...view.target);
  } else {
    cam.position.set(15.3, -0.1 + 6, 18.5);
    cam.lookAt(4.45, -0.1 + 1.2, 0);
    cam.rotateY(0.3);
  }
  cam.updateMatrixWorld();
  objects.push(cam);
  const info = { sun: t.sun.userData.direction.toArray(), backgroundTurn: scene.backgroundRotation.y, environmentIntensity: scene.environmentIntensity, exposure: t.renderer.toneMappingExposure, camera: { position: cam.position.toArray(), quaternion: cam.quaternion.toArray(), fov } };
  const glb = await new GLTFExporter().parseAsync(objects, { binary: true, onlyVisible: true, maxTextureSize: 2048 });
  for (const [m, k, tx] of stripped) { m[k] = tx; m.needsUpdate = true; }
  for (const o of unseen) o.visible = true;
  briel.portals.group.visible = true;
  const save = (data, name, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; document.body.appendChild(a); a.click(); };
  save(glb, 'start_scene.glb', 'model/gltf-binary');
  save(JSON.stringify(info, null, 1), 'start_info.json', 'application/json');
  return JSON.stringify({ objects: objects.length, materials: seen.size, strippedTextures: stripped.length, bytes: glb.byteLength, info });
})()
