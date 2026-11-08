// A view's scene for Blender (tools/still/render_still.py). Run it in the page on the dev server
// (developer console, or a CDP Runtime.evaluate with awaitPromise; tools/still/export_view.mjs does it all
// for a view): it downloads start_scene.glb (everything visible, the camera) and start_info.json (sun, the
// sky's turn, the weather, the street lamps). The camera is the start screen's, or `window.stillView`
// ({ position, target, fov, render }: the slideshow's views in views.json, with the player moved near the
// view first so the area round it is loaded). The game's texture files are
// noted per material (glTF extras) instead of embedded. The portals, anything drawn by a shader of
// its own (smoke, butterflies, soft ground patches) instanced birds and flies, and surfaces drawn from behind only stay out: glTF can't carry them, and Cycles
// shades the ground itself. The leaf-card trees go in as they are, their painted atlas embedded (the game's High
// preset: export_view.mjs), and the villagers as plain meshes in the pose they have.
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
  // The villagers (world/villagers.ts, and the football training and its parents, world/footballLife.ts) are posed in
  // their vertex shader from a picture of bone matrices, which glTF can't carry: each one goes out as a plain mesh in
  // the pose it has now, coloured per vertex from its palette (the same sums as the shader: VERT_SKIN, color_fragment).
  // Their uniforms are read by running the material's onBeforeCompile on an empty shader.
  // three's classes come from objects already in the page: a second copy of three imported here would be another three.
  const Group = briel.portals.group.constructor;
  const people = new Group();
  people.name = 'villagers_posed';
  {
    let anyMesh = null;
    scene.traverse((o) => {
      if (!anyMesh && o.isMesh && !o.isInstancedMesh && !o.isSkinnedMesh) anyMesh = o;
    });
    const Matrix4 = scene.matrixWorld.constructor;
    const Matrix3 = scene.normalMatrix.constructor;
    const Vector3 = scene.position.constructor;
    const Mesh = anyMesh.constructor;
    const half = (h) => {
      // A half float's bits as a number (IEEE 754 binary16).
      const e = (h >> 10) & 31;
      const f = h & 1023;
      const v = e === 0 ? f * 2 ** -24 : e === 31 ? (f ? NaN : Infinity) : (1 + f / 1024) * 2 ** (e - 15);
      return h & 32768 ? -v : v;
    };
    const inst = new Matrix4();
    const whole = new Matrix4();
    const nm = new Matrix3();
    const p = new Vector3();
    const n = new Vector3();
    let posed = 0;
    const kinds = [];
    scene.traverse((o) => {
      if (o.isInstancedMesh && /^villagers-/.test(o.name)) kinds.push(o);
    });
    // The instanced figures themselves (bind pose, white) and the soft patches under them (an alpha map glTF drops:
    // black squares) stay out; Cycles gives the posed figures real shadows.
    for (const k of kinds) for (const o of k.parent.children) if (o.isInstancedMesh && o.visible) {
      o.visible = false;
      unseen.push(o);
    }
    kinds.forEach((o) => {
      if (!o.count) return;
      for (let q = o.parent; q; q = q.parent) if (!q.visible) return;
      const fake = { uniforms: {}, vertexShader: '', fragmentShader: '' };
      o.material.onBeforeCompile(fake, t.renderer);
      const bones = fake.uniforms.uBones?.value?.image;
      const pal = fake.uniforms.uPal?.value?.image;
      if (!bones || !pal) return;
      const g = o.geometry;
      const at = g.attributes;
      const index = g.index ? g.index.array : null;
      const corners = index ? index.length : at.position.count;
      const row = (r, bone, k) => {
        // Row k (0..2) of a bone's 3 x 4 matrix at frame row r.
        const base = (Math.floor(r) * bones.width + Math.floor(bone) * 3 + k) * 4; // texelFetch at int(bone) * 3, int(row)
        return [half(bones.data[base]), half(bones.data[base + 1]), half(bones.data[base + 2]), half(bones.data[base + 3])];
      };
      const skin = (r, v) => {
        const m = new Array(12).fill(0);
        for (let s = 0; s < 4; s++) {
          const w = at.skinWeight.getComponent(v, s);
          if (!w) continue;
          const bone = at.skinIndex.getComponent(v, s);
          for (let k = 0; k < 3; k++) {
            const rr = row(r, bone, k);
            for (let c = 0; c < 4; c++) m[k * 4 + c] += rr[c] * w;
          }
        }
        return m;
      };
      const pos = [];
      const nor = [];
      const col = [];
      for (let i = 0; i < o.count; i++) {
        const [ra, rb, blend, palRow] = [0, 1, 2, 3].map((c) => at.aAnim.getComponent(i, c));
        const [fade, mask] = [at.aLook.getComponent(i, 0), at.aLook.getComponent(i, 1)];
        if (fade < 0.5) continue;
        o.getMatrixAt(i, inst);
        whole.multiplyMatrices(o.matrixWorld, inst);
        nm.getNormalMatrix(whole);
        const cache = new Map();
        const vert = (v) => {
          if (cache.has(v)) return cache.get(v);
          const group = Math.floor(at.uv.getX(v) / 16);
          const hidden = group > 0 && ((Math.round(mask) >> (group - 1)) & 1) === 0;
          let out = null;
          if (!hidden) {
            const a = skin(ra, v);
            const b = skin(rb, v);
            const m = a.map((x, k) => x * (1 - blend) + b[k] * blend);
            const [x, y, z] = [at.position.getX(v), at.position.getY(v), at.position.getZ(v)];
            p.set(m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]).applyMatrix4(whole);
            const [nx, ny, nz] = [at.normal.getX(v), at.normal.getY(v), at.normal.getZ(v)];
            n.set(m[0] * nx + m[1] * ny + m[2] * nz, m[4] * nx + m[5] * ny + m[6] * nz, m[8] * nx + m[9] * ny + m[10] * nz).applyMatrix3(nm).normalize();
            const slot = Math.floor(at.uv.getX(v)) % 16; // mod(floor(uv.x), 16), as the shader
            const shade = at.uv.getY(v);
            const c = (Math.round(palRow) * pal.width + slot) * 4;
            out = [p.x, p.y, p.z, n.x, n.y, n.z, (pal.data[c] / 255) * shade, (pal.data[c + 1] / 255) * shade, (pal.data[c + 2] / 255) * shade];
          }
          cache.set(v, out);
          return out;
        };
        for (let k = 0; k < corners; k += 3) {
          const tri = [0, 1, 2].map((j) => vert(index ? index[k + j] : k + j));
          if (tri.some((x) => !x)) continue;
          for (const x of tri) {
            pos.push(x[0], x[1], x[2]);
            nor.push(x[3], x[4], x[5]);
            col.push(x[6], x[7], x[8]);
          }
        }
        posed++;
      }
      if (!pos.length) return;
      const geo = new g.constructor();
      const Attribute = Object.getPrototypeOf(at.aAnim.constructor); // BufferAttribute, under InstancedBufferAttribute
      geo.setAttribute('position', new Attribute(new Float32Array(pos), 3));
      geo.setAttribute('normal', new Attribute(new Float32Array(nor), 3));
      geo.setAttribute('color', new Attribute(new Float32Array(col), 3));
      const mesh = new Mesh(geo, new o.material.constructor({ vertexColors: true, roughness: 0.82, metalness: 0 }));
      mesh.name = `${o.name}_posed`;
      people.add(mesh);
    });
    if (posed) scene.add(people);
    console.log('villagers posed', posed);
  }
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
    // Leaves (tree crowns, hedges): render_still.py gives them a leafy look of their own. The trunks and branches of
    // the leaf-card trees (world/leafCards.ts barkMaterial) are bark, not leaves.
    if (o.userData.material === 'hedge' || /foliage|hedge/i.test(o.name)) for (const m of mats) if (m && !m.userData.bark) m.userData = { ...m.userData, foliage: true };
    // The leaf cards (world/leafCards.ts, Medium and up): their atlas is painted in code (a DataTexture, no file), so it
    // goes into the file itself, and the cut-out with it (glTF alpha MASK): render_still.py cuts them out the same way.
    for (const m of mats) if (m && m.alphaTest > 0 && m.map?.isDataTexture && m.vertexColors && !m.userData.bark) m.userData = { ...m.userData, foliage: true, cards: true };
    if (o.isInstancedMesh && o.instanceColor) {
      // Colour per instance (hedge clumps): the range, for Blender to pick from per object.
      const c = o.instanceColor.array;
      const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
      // Only the instances drawn: the rest of the buffer is left white (the undergrowth came out white).
      for (let i = 0; i < Math.min(c.length, o.count * 3); i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], c[i + k]); hi[k] = Math.max(hi[k], c[i + k]); }
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
  // `render.clear` (views.json): nothing car-sized within that many metres of the camera. The traffic drives where it
  // likes, and a car passing just in front of a street-level camera filled the bottom of the picture.
  if (view?.render?.clear) {
    const eye = scene.position.clone().fromArray(view.position);
    const ball = new (scene.position.constructor)();
    scene.traverse((o) => {
      if (!o.isMesh || !o.visible || o.isInstancedMesh) return;
      o.geometry.computeBoundingSphere?.();
      const s = o.geometry.boundingSphere;
      if (!s) return;
      ball.copy(s.center).applyMatrix4(o.matrixWorld);
      const r = s.radius * o.matrixWorld.getMaxScaleOnAxis();
      if (r < 3.5 && ball.distanceTo(eye) < view.render.clear) {
        o.visible = false;
        unseen.push(o);
      }
    });
  }
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
  scene.remove(people);
  people.traverse((o) => {
    o.geometry?.dispose();
    o.material?.dispose();
  });
  const save = (data, name, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; document.body.appendChild(a); a.click(); };
  save(glb, 'start_scene.glb', 'model/gltf-binary');
  save(JSON.stringify(info, null, 1), 'start_info.json', 'application/json');
  return JSON.stringify({ objects: objects.length, villagers: people.children.map((m) => m.name), materials: seen.size, strippedTextures: stripped.length, bytes: glb.byteLength, info });
})()
