// The game's world for baking the light of the building models (tools/bake/bake_buildings.py). Run it in
// the page on the dev server once the village has loaded (developer console, or a CDP Runtime.evaluate with
// awaitPromise); it downloads bake_scene.glb and bake_info.json.
//
// Everything stays in that the light of the models depends on: the relief, the village's blocks and roofs,
// trees and hedges, the main house and the bungalow, and the models themselves, which carry their light
// layout (TEXCOORD_1, made by tools/bake/lightmap_uv.py) and its notes (extras lm, lmModel, lmSize, lmId).
// Every tile is shown and every model at its full detail. Out stay what moves or comes and goes (people,
// animals, cars on the road, birds, the portals, smoke and sparks) and what glTF can't carry (shaders of their
// own); the sky comes from the sky photo in Blender. The game's texture files are noted per material (glTF
// extras) instead of embedded, as for the start screen's still (tools/still/export_scene.js).
//
// The leaf-card trees, hedge sprigs and undergrowth (Medium and up: world/cardTrees.ts) are cut out of a picture
// drawn in code, which glTF can't carry: each card would go in as a solid square, a crown as a dark shell. Their
// plain stand-ins go in instead, the trees as Low draws them (smooth crowns, the cone conifers), as for the
// ground's bake (world/groundShade.ts bakeStandIns); the bake lets some light through them as through leaves.
(async () => {
  const { GLTFExporter } = await import('/@id/three/examples/jsm/exporters/GLTFExporter.js');
  const { terrain } = await import('/src/world/terrain.ts');
  const { house } = await import('/src/world/houseData.ts');
  const { cardsShown, switchTrees } = await import('/src/world/leafCards.ts');
  const t = briel.three;
  const scene = t.scene;
  const tiles = briel.tiles;
  const cards = cardsShown();
  switchTrees(false);

  // Every tile, and nothing hidden again until the export is done.
  const update = tiles.update;
  tiles.update = () => {};
  tiles.showAll();
  const restore = [];
  const show = (o, v) => {
    if (o.visible !== v) {
      restore.push([o, o.visible]);
      o.visible = v;
    }
  };
  // What is hidden by distance (Molenhoek's far stretch, the houses at home) shown too.
  for (const tr of tiles.tracked ?? []) show(tr.object, true);
  // Every model at its full detail (LODs at their first level).
  scene.traverse((o) => {
    if (!o.isLOD) return;
    restore.push([o, o.autoUpdate, 'autoUpdate']);
    o.autoUpdate = false;
    o.levels.forEach((l, i) => show(l.object, i === 0));
  });
  briel.portals.group.visible = false;

  const KEYS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap'];
  const stripped = [];
  const seen = new Set();
  // Only the attributes the bake reads go along. The game's own (a house's brick shade and roof gloss as bytes,
  // world/facadeLook.ts; the windows' rooms) would go in as custom attributes, and Blender's importer fails on bytes.
  const ATTRIBUTES = new Set(['position', 'normal', 'uv', 'uv1', 'color']);
  const unread = [];
  const seenGeometry = new Set();
  const targets = {};
  const left = { moving: 0, shader: 0, instanced: 0, back: 0 };
  scene.traverse((o) => {
    if (!(o.isMesh || o.isInstancedMesh) || !o.visible) return;
    for (let p = o; p; p = p.parent) if (!p.visible) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const drop = (why) => {
      show(o, false);
      left[why]++;
    };
    if (mats.every((m) => m && m.visible === false)) return show(o, false);
    if (o.isSkinnedMesh) return drop('moving'); // people and animals
    if (mats.some((m) => m && m.isShaderMaterial)) return drop('shader');
    if (mats.some((m) => m && m.side === 1)) return drop('back');
    if (o.geometry?.isInstancedBufferGeometry || Object.values(o.geometry?.attributes ?? {}).some((x) => x.isInstancedBufferAttribute)) return drop('instanced');
    // Leaves (tree crowns, hedges): let some light through in the bake, as real crowns do.
    if (o.userData.material === 'hedge' || /foliage|hedge/i.test(o.name)) for (const m of mats) if (m) m.userData.foliage = true;
    if (!seenGeometry.has(o.geometry)) {
      seenGeometry.add(o.geometry);
      for (const name of Object.keys(o.geometry.attributes)) {
        if (ATTRIBUTES.has(name)) continue;
        unread.push([o.geometry, name, o.geometry.attributes[name]]);
        o.geometry.deleteAttribute(name);
      }
    }
    if (o.userData.lmModel) {
      const k = o.userData.lmModel;
      targets[k] = targets[k] ?? { id: o.userData.lmId, size: o.userData.lmSize, meshes: 0, pages: 0 };
      targets[k].meshes++;
      targets[k].pages = Math.max(targets[k].pages, o.userData.lm + 1);
    }
    for (const m of mats) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      const tex = {};
      for (const k of KEYS) {
        const tx = m[k];
        const src = tx && (tx.userData?.src ?? tx.image?.src);
        if (src && src.includes('/textures/')) {
          tex[k] = { src: new URL(src, location.href).pathname, repeat: tx.repeat.toArray(), offset: tx.offset.toArray(), rotation: tx.rotation, center: tx.center.toArray() };
          stripped.push([m, k, tx]);
          m[k] = null;
        } else if (tx && !tx.image?.src && !tx.isCompressedTexture && !(tx.image instanceof HTMLImageElement) && !(tx.image instanceof ImageBitmap)) {
          // A texture drawn in code (canvas, data): glTF can't keep it; the material's colour stands in.
          stripped.push([m, k, tx]);
          m[k] = null;
        }
      }
      m.userData = { ...m.userData, tex, kind: m.type, transparent: m.transparent, opacity: m.opacity, transmission: m.transmission ?? 0, alphaTest: m.alphaTest, sideDouble: m.side === 2, vertexColors: !!m.vertexColors };
      m.needsUpdate = true;
    }
  });
  const objects = scene.children.filter((o) => o.visible && !o.isLight && !o.isCamera);

  // The relief's heights round the models, every 2 m (for the dirt at the foot of walls).
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  scene.traverse((o) => {
    if (!o.userData.lmModel || !o.visible) return;
    o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
    x0 = Math.min(x0, b.min.x);
    z0 = Math.min(z0, b.min.z);
    x1 = Math.max(x1, b.max.x);
    z1 = Math.max(z1, b.max.z);
  });
  const STEP = 2;
  x0 = Math.floor(x0 / STEP) * STEP - 4;
  z0 = Math.floor(z0 / STEP) * STEP - 4;
  const nx = Math.ceil((x1 - x0) / STEP) + 8;
  const nz = Math.ceil((z1 - z0) / STEP) + 8;
  const heights = [];
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) heights.push(Math.round((house.ground + terrain.height(x0 + i * STEP, z0 + j * STEP)) * 100));
  const info = {
    sun: t.sun.userData.direction.toArray(),
    sunColor: t.sun.color.toArray(),
    sunIntensity: t.sun.intensity,
    environmentTurn: scene.environmentRotation.y,
    environmentIntensity: 0.9, // outdoors (world/indoorLight.ts)
    exposure: t.renderer.toneMappingExposure,
    targets,
    left,
    terrain: { x0, z0, step: STEP, nx, nz, heights }, // world heights in cm, row by row along x
  };
  const glb = await new GLTFExporter().parseAsync(objects, { binary: true, onlyVisible: true, maxTextureSize: 1024 });
  for (const [g, name, a] of unread) g.setAttribute(name, a);
  for (const [m, k, tx] of stripped) {
    m[k] = tx;
    m.needsUpdate = true;
  }
  for (const [o, v, key] of restore.reverse()) o[key ?? 'visible'] = v;
  switchTrees(cards);
  briel.portals.group.visible = true;
  tiles.update = update;
  const save = (data, name, type) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
  };
  save(glb, 'bake_scene.glb', 'model/gltf-binary');
  save(JSON.stringify(info), 'bake_info.json', 'application/json');
  return { bytes: glb.byteLength, targets, left };
})();
