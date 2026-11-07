// A view's scene for Blender (tools/still/render_still.py). Run it in the page on the dev server
// (developer console, or a CDP Runtime.evaluate with awaitPromise; tools/still/export_view.mjs does it all
// for a view): it downloads start_scene.glb (everything visible, the camera) and start_info.json (sun, the
// sky's turn, the weather, the street lamps). The camera is the start screen's, or `window.stillView`
// ({ position, target, fov, render }: the slideshow's views in views.json, with the player moved near the
// view first so the area round it is loaded). The game's texture files are
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
  // The village's window glass (world/windows.ts) carries each room's number and covering in attributes of its
  // own, which glTF can't name: they go out as a second UV map (u the room's number, v its covering), so a night
  // render lights the same rooms the game lights (number below one half: on). Taken off again after.
  const roomUv = [];
  scene.traverse((o) => {
    const g = o.isMesh && o.material?.name === 'village_glass' ? o.geometry : null;
    if (!g?.attributes.room || !g.attributes.look || g.attributes.uv1) return;
    const uv = new Float32Array(g.attributes.room.count * 2);
    for (let i = 0; i < g.attributes.room.count; i++) uv.set([g.attributes.room.getW(i), g.attributes.look.getX(i)], i * 2);
    g.setAttribute('uv1', new g.attributes.room.constructor(uv, 2));
    roomUv.push(g);
  });
  // Attributes of the game's own shaders (facade looks, gloss, rows, the rooms' numbers) go out as glTF custom
  // attributes, and Blender's importer stops at the normalized byte ones: left out, put back after.
  const STANDARD = new Set(['position', 'normal', 'tangent', 'uv', 'uv1', 'uv2', 'uv3', 'color', 'skinIndex', 'skinWeight']);
  const custom = [];
  scene.traverse((o) => {
    const g = o.isMesh ? o.geometry : null;
    if (!g?.attributes) return;
    for (const name of Object.keys(g.attributes)) {
      if (STANDARD.has(name)) continue;
      custom.push([g, name, g.attributes[name]]);
      g.deleteAttribute(name);
    }
  });
  scene.traverse((o) => {
    if (!(o.isMesh || o.isInstancedMesh) || !o.visible) return;
    for (let p = o; p; p = p.parent) if (!p.visible) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.every((m) => m && m.visible === false)) { o.visible = false; unseen.push(o); return; } // hit spheres and the like: drawn nowhere
    if (mats.some((m) => m && m.isShaderMaterial)) { o.visible = false; unseen.push(o); return; }
    // Drawn from behind only (a roof's underside, seen from inside): glTF
    // has no such side, so it would cover the roof. The renders are all from outside.
    if (mats.some((m) => m && m.side === 1)) { o.visible = false; unseen.push(o); return; }
    // Birds, flies and sparks drawn as instances with attributes of their own: glTF can't carry those either.
    if (o.geometry?.isInstancedBufferGeometry || Object.values(o.geometry?.attributes ?? {}).some((x) => x.isInstancedBufferAttribute)) { o.visible = false; unseen.push(o); return; }
    // Leaves (tree crowns, hedges): render_still.py gives them a leafy look of their own.
    if (o.userData.material === 'hedge' || /foliage|hedge/i.test(o.name)) for (const m of mats) if (m) m.userData = { ...m.userData, foliage: true };
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
        // The game's textures note their full-size WebP file (world/textureFiles.ts): a KTX2 one has no image.src.
        const src = tx && ((tx.userData && tx.userData.src) || (tx.image && tx.image.src));
        if (src && src.includes('/textures/')) {
          tex[k] = { src: new URL(src, location.href).pathname, repeat: tx.repeat.toArray(), offset: tx.offset.toArray(), rotation: tx.rotation, center: tx.center.toArray() };
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
  // The weather shown (world/weather.ts: sunny, overcast, rain, night), and the street lamps' heads (world/streetLights.ts,
  // drawn by a shader of their own, so not in the scene file): a night render lights them as real lamps.
  info.mood = t.weather?.state().chosen ?? 'sunny';
  if (view?.render) info.render = view.render; // the view's own extras for render_still.py (views.json)
  const glows = t.weather?.lamps?.glows;
  if (glows) {
    const m = new cam.matrix.constructor();
    const p = cam.position.clone();
    info.lamps = [];
    for (let i = 0; i < glows.count; i++) {
      glows.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      info.lamps.push([+p.x.toFixed(2), +(p.y + 0.14).toFixed(2), +p.z.toFixed(2)]);
    }
  }
  const glb = await new GLTFExporter().parseAsync(objects, { binary: true, onlyVisible: true, maxTextureSize: 2048 });
  for (const g of roomUv) g.deleteAttribute('uv1');
  for (const [g, name, a] of custom) g.setAttribute(name, a);
  for (const [m, k, tx] of stripped) { m[k] = tx; m.needsUpdate = true; }
  for (const o of unseen) o.visible = true;
  briel.portals.group.visible = true;
  const save = (data, name, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; document.body.appendChild(a); a.click(); };
  save(glb, 'start_scene.glb', 'model/gltf-binary');
  save(JSON.stringify(info, null, 1), 'start_info.json', 'application/json');
  return JSON.stringify({ objects: objects.length, materials: seen.size, strippedTextures: stripped.length, bytes: glb.byteLength, info });
})()
