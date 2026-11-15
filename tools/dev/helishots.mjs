// Photograph the helicopter's model (web/public/models/helicopter.glb) in the game from fixed views, on a running dev
// server, before the flight code exists: the page loads the model itself with the game's own three.js and dresses it
// as world/car.ts dresses the Teslas (clear-coated paint on Medium and up, see-through glass, the baked shade, the
// shut lines as lines, the far copy past 90 m), the rotor turning or as a blur disc. A Tesla stands beside it for scale.
//
//   node tools/dev/helishots.mjs <outFolder> --url http://localhost:5617/ --port 9712
//     [--quality high|medium|low] [--mood sunny|overcast|rain|dusk|night|snow] [--lights] [--phone]
//     [--views all|few|flight|<name,name>] [--livery A|B|C] [--at x,z,heading]
//   node tools/dev/helishots.mjs --bench --url ... --port ... [--pairs 6]
//
// --lights: the navigation lights, the beacon and the landing lamps on (for dusk and night). Pictures are named
// <view>_<quality>_<mood>[_lights][_B|_C][_phone].png. --bench: at the church, two machines in view against none, on
// High and Low, the graphics chip's own time per frame (timer queries, as gpubench.mjs), the two alternated in pairs.
// --url is required: your own dev server (AGENTS.md: Vite in 5200 to 5999, never 5173). Pass your own --port too.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: '', port: '9710', quality: 'high', mood: 'sunny', views: 'all', lights: false, phone: false, livery: 'A', at: '-32,-8,3.142', bench: false, pairs: '6', eval: '' });
const out = o._[0];
if ((!out && !o.bench) || !o.url) {
  console.error('usage: node tools/dev/helishots.mjs <outFolder> --url http://localhost:<your Vite port>/ --port <debugging port> [options]');
  process.exit(2);
}
if (out) mkdirSync(out, { recursive: true });

// The livery's three colours (heli.md, web/src/brand.css): Paint, PaintB, PaintC.
const LIVERIES = { A: ['#141d3a', '#f7b928', '#fbf6ea'], B: ['#f7b928', '#141d3a', '#fbf6ea'], C: ['#fbf6ea', '#141d3a', '#f7b928'] };

// The page's side: load the model and dress it. Kept as a string, run once in the page.
const PAGE = `(async () => {
  const urls = performance.getEntriesByType('resource').map((e) => e.name);
  const find = (re) => urls.find((u) => re.test(u));
  const threeUrl = find(/\\/deps\\/three\\.js/), loaderUrl = find(/\\/deps\\/three_addons_loaders_GLTFLoader/);
  if (!threeUrl || !loaderUrl) throw new Error('the game\\'s three.js modules were not found among ' + urls.length + ' loaded files');
  const THREE = await import(threeUrl);
  const { GLTFLoader } = await import(loaderUrl);
  const gltf = await new GLTFLoader().loadAsync('/models/helicopter.glb?' + Date.now());
  const [pa, pb, pc] = ${JSON.stringify(LIVERIES[o.livery] ?? LIVERIES.A)};
  const shaded = { vertexColors: true };
  // As world/car.ts: the paint mirrors the ground below the horizon darker than the sky above it.
  const horizon = (m) => {
    m.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <envmap_physical_pars_fragment>',
        THREE.ShaderChunk.envmap_physical_pars_fragment.replace(
          /vec4 envMapColor = textureCubeUV\\( envMap, envMapRotation \\* reflectVec, roughness \\);\\s*return envMapColor\\.rgb \\* envMapIntensity;/,
          \`vec4 envMapColor = textureCubeUV( envMap, envMapRotation * reflectVec, roughness );
          vec3 skyVec = normalize( vec3( reflectVec.x, max( reflectVec.y, 0.15 ), reflectVec.z ) );
          vec3 sky = textureCubeUV( envMap, envMapRotation * skyVec, roughness ).rgb;
          float soft = 0.02 + 0.6 * roughness * roughness;
          float above = smoothstep( - soft, soft, reflectVec.y );
          vec3 seen = mix( envMapColor.rgb * 0.3, mix( sky, envMapColor.rgb, smoothstep( 0.15, 0.4, reflectVec.y ) ), above );
          seen *= 1.0 + 1.4 * exp( - pow( reflectVec.y / ( 0.04 + soft ), 2.0 ) ) * above;
          return seen * envMapIntensity;\`));
    };
    m.customProgramCacheKey = () => 'heli-paint-horizon';
    return m;
  };
  const fine = ${JSON.stringify(o.quality)} !== 'low';
  const paint = (c) => horizon(fine
    ? new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 2, ...shaded })
    : new THREE.MeshStandardMaterial({ color: c, roughness: 0.18, envMapIntensity: 1.6, ...shaded }));
  const lamp = (c) => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: ${o.lights ? 3 : 0.6}, roughness: 0.2 });
  // The blur discs: an even see-through grey, lit (as the cars' wheel blur), seen from both sides. The flight code
  // gives the discs its own material (heli.md: they fade in above 45 % rotor speed); this only stands in for it.
  const blur = new THREE.MeshStandardMaterial({ color: '#121316', roughness: 0.7, metalness: 0, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide });
  const lineMat = new THREE.LineBasicMaterial({ color: '#000000', transparent: true, opacity: 0.55, depthWrite: false });
  lineMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', \`#include <project_vertex>
      float gapD = length( mvPosition.xyz );
      mvPosition.xyz *= 1.0 - min( 0.5, ( 0.02 + 0.0004 * gapD * gapD ) / max( gapD, 0.1 ) );
      gl_Position = projectionMatrix * mvPosition;\`);
  };
  const M = {
    Paint: paint(pa), PaintB: paint(pb), PaintC: paint(pc),
    Glass: new THREE.MeshStandardMaterial({ color: '#16201c', roughness: 0.04, metalness: 0.25, transparent: true, opacity: 0.38, depthWrite: false, envMapIntensity: 1.4 }),
    Trim: new THREE.MeshStandardMaterial({ color: '#16171a', roughness: 0.6, ...shaded }),
    Metal: new THREE.MeshStandardMaterial({ color: '#8d9097', roughness: 0.38, metalness: 0.85, ...shaded }),
    Rubber: new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.9, ...shaded }),
    Interior: new THREE.MeshStandardMaterial({ color: '#45484d', roughness: 0.8, ...shaded }),
    Screen: new THREE.MeshBasicMaterial({ vertexColors: true }),
    Gap: new THREE.MeshStandardMaterial({ color: '#000000', roughness: 0.9 }),
    LightRed: lamp('#ff2a1a'), LightGreen: lamp('#20ff60'), LightWhite: lamp('#ffffff'), LightBeacon: lamp('#ff2010'), LightLanding: lamp('#fff2dc'),
  };
  const SHADOW = new Set(['Paint', 'PaintB', 'PaintC', 'Glass', 'Trim', 'Interior']);
  const dress = (scene) => {
    scene.traverse((m) => {
      if (m.isMesh) {
        const name = m.material.name;
        m.material = name === 'RotorBlur' ? blur : M[name] ?? M.Trim;
        m.castShadow = SHADOW.has(name);
        m.receiveShadow = true;
        if (name === 'Glass') m.renderOrder = 1;
      } else if (m.isLineSegments) m.material = lineMat;
    });
  };
  const machines = [];
  const make = () => {
    const root = new THREE.Group();
    root.rotation.order = 'YXZ';
    const s = gltf.scene.clone();
    dress(s);
    root.add(s);
    const get = (n) => s.getObjectByName(n);
    const h = { root, s, get, far: get('Far'), rotor: get('Rotor'), tail: get('TailRotor'), disc: get('RotorDisc'), tdisc: get('TailDisc'),
      blades: [1, 2, 3, 4].map((i) => get('Blade_' + i)), detail: get('Detail') };
    for (const b of h.blades) b.rotation.z = -3 * Math.PI / 180; // the blades droop at rest
    briel.three.scene.add(root);
    machines.push(h);
    return h;
  };
  const camPass = briel.three.composer.passes.find((p) => p.camera && p.camera.isPerspectiveCamera);
  const cam = camPass?.camera;
  window.__heli = { THREE, machines, make, cam,
    /** Flying (blades hidden, discs on) or standing (blades, drooping, discs off); far: the simple copy. */
    pose(h, { x, y, z, yaw, pitch = 0, roll = 0, flying = false, spin = 0, far = false }) {
      h.root.position.set(x, y, z);
      h.root.rotation.set(pitch, yaw, roll);
      for (const c of h.s.children) c.visible = far ? c === h.far : c !== h.far && c !== h.disc && c !== h.tdisc;
      for (const b of h.blades) { b.visible = !flying; b.rotation.z = (flying ? 2.5 : -3) * Math.PI / 180; }
      h.disc.visible = flying && !far;
      h.tdisc.visible = flying && !far;
      h.tail.visible = !flying && !far;
      h.rotor.rotation.y = spin;
    },
  };
  // The camera is held where __look puts it: the game's own camera is set again just before each render.
  window.__view = null;
  const comp = briel.three.composer;
  const render = comp.render.bind(comp);
  comp.render = (dt) => {
    const v = window.__view;
    if (v && cam) {
      cam.position.set(v[0], v[1], v[2]);
      cam.fov = v[6];
      cam.updateProjectionMatrix();
      cam.lookAt(v[3], v[4], v[5]);
      cam.updateMatrixWorld(true);
    }
    return render(dt);
  };
  // feet: where the player stands (the camera's own height less 1.65 m unless given: in the air the player would
  // open a parachute in front of the camera, so the flight views leave the player on the ground below).
  window.__look = (cx, cy, cz, tx, ty, tz, fov = 40, feet = cy - 1.65) => {
    const dx = tx - cx, dz = tz - cz;
    briel.teleport(cx, cz, feet, Math.atan2(-dx, -dz), Math.atan2(ty - cy, Math.hypot(dx, dz)));
    briel.player.flying = true;
    window.__view = [cx, cy, cz, tx, ty, tz, fov];
  };
  // The model's anchors in the world (for the cockpit view).
  window.__anchor = (h, name) => { h.root.updateMatrixWorld(true); const p = new THREE.Vector3(); h.get(name).getWorldPosition(p); return [p.x, p.y, p.z]; };
  return gltf.scene.children.map((c) => c.name).join(',');
})()`;

const b = await launch({ port: Number(o.port), width: 1280, height: 720 });
console.log('browser pid', b.pid);
try {
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('briel.lang','en');localStorage.setItem('briel.spawn','house');localStorage.setItem('briel.playMode','explore');" });
  await startGame(b, o.url, { phone: o.phone, village: o.bench });
  await b.evaluate("document.getElementById('cc-close')?.click()", false);
  console.log('nodes', await b.evaluate(PAGE, true));
  await b.evaluate("(() => { const st = document.createElement('style'); st.textContent = '#hud, #credit, #sound-btn, #map-btn, #touch { visibility: hidden !important; }'; document.head.appendChild(st); })()", false);

  if (o.bench) {
    // At the church: two machines in front of the camera (15 and 24 m off), shown and hidden in turn.
    await b.evaluate('briel.three.holdQuality(true)', false);
    await b.evaluate("briel.travel('church')", false);
    await b.sleep(3500);
    await b.evaluate(`(() => {
      const H = window.__heli, p = briel.player, fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
      for (const [d, side] of [[15, -3], [24, 4]]) {
        const h = H.make(), x = p.x + fx * d - fz * side, z = p.z + fz * d + fx * side;
        const g = briel.world.groundAt(x, z, p.feet + 5, 0.3);
        H.pose(h, { x, y: g.y, z, yaw: p.yaw + 0.8 });
      }
    })()`, false);
    const timeFrames = `(async () => {
      const t = briel.three, gl = t.renderer.getContext();
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      if (!ext) return null;
      const qs = [];
      for (let i = 0; i < 240; i++) {
        const qy = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, qy);
        t.composer.render(1 / 60);
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        qs.push(qy);
        if (i % 8 === 7) await new Promise((res) => setTimeout(res, 0));
      }
      const px = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      await new Promise((res) => setTimeout(res, 300));
      const ms = [];
      for (const qy of qs) {
        if (gl.getQueryParameter(qy, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(ext.GPU_DISJOINT_EXT)) ms.push(gl.getQueryParameter(qy, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(qy);
      }
      ms.sort((a, b) => a - b);
      const info = t.renderer.info, auto = info.autoReset;
      info.autoReset = false;
      info.reset();
      t.composer.render(1 / 60);
      const { calls, triangles } = info.render;
      info.autoReset = auto;
      return { n: ms.length, p50: ms[Math.floor(0.5 * (ms.length - 1))], calls, triangles };
    })()`;
    const res = { high: { off: [], on: [] }, low: { off: [], on: [] } };
    for (const q of ['high', 'low']) {
      await b.evaluate(`briel.three.applyQuality('${q}')`, false);
      await b.sleep(800);
      await b.evaluate('briel.bench(60)', false); // warm-up: shader compiles
      for (let i = 0; i < Number(o.pairs); i++) {
        for (const on of [false, true]) {
          await b.evaluate(`for (const h of window.__heli.machines) h.root.visible = ${on}`, false);
          const r = await b.evaluate(timeFrames, true);
          if (!r) { console.log('no timer queries'); break; }
          res[q][on ? 'on' : 'off'].push(r.p50);
          console.log(`${q} pair ${i + 1} ${on ? 'two machines' : 'none'}: p50 ${r.p50.toFixed(3)} ms, ${r.calls} calls, ${r.triangles} triangles`);
        }
      }
    }
    const med = (v) => { const s = [...v].sort((a, b) => a - b); return (s[Math.floor((s.length - 1) / 2)] + s[Math.ceil((s.length - 1) / 2)]) / 2; };
    for (const q of ['high', 'low']) {
      const off = med(res[q].off), on = med(res[q].on);
      console.log(`${q}: none ${off.toFixed(3)} ms, two machines ${on.toFixed(3)} ms, +${(on - off).toFixed(3)} ms (${((100 * (on - off)) / off).toFixed(1)} %)`);
    }
  } else {
    await b.waitFor('briel.cars.slice(0,1).every(c=>c.wheels.length===4)');
    await b.evaluate(`briel.three.applyQuality(${JSON.stringify(o.quality)}); briel.three.holdQuality?.(true)`, false);
    await b.evaluate(`briel.three.weather.setSolo(${JSON.stringify(o.mood)})`, false);
    const [ax, az, ah] = o.at.split(',').map(Number);
    const spot = JSON.parse(await b.evaluate(`(() => {
      const g = briel.world.groundAt(${ax}, ${az}, 50, 0.3);
      const h = window.__heli.make();
      window.__heli.pose(h, { x: ${ax}, y: g.y, z: ${az}, yaw: ${ah} });
      // A Tesla beside it, 6 m to its right, facing the same way: for scale.
      const fx = -Math.sin(${ah}), fz = -Math.cos(${ah});
      const tx = ${ax} - fz * 6, tz = ${az} + fx * 6, tg = briel.world.groundAt(tx, tz, 50, 0.3);
      briel.cars[0].place(tx, tg.y, tz, ${ah});
      return JSON.stringify({ y: g.y });
    })()`, false));
    await b.sleep(20000); // the mood blends in, the tiles round the spot load
    // Views: [name, angle from the nose (deg, 90 = its right), distance (m) from the machine's middle, eye height, fov]
    // or special ones. The middle is 1.9 m behind the hub, 1.4 m up.
    const ring = [['front', 0], ['front34_r', 45], ['side_r', 90], ['rear34_r', 135], ['rear', 180], ['rear34_l', 225], ['side_l', 270], ['front34_l', 315]];
    const ALL = [...ring.map(([n, a]) => [n, 'ring', a]), ['above', 'above'], ['head', 'head'], ['cockpit', 'cockpit'], ['cabin', 'cabin'],
      ['tesla', 'tesla'], ['chase', 'chase'], ['below', 'below'], ['near90', 'near90'], ['far90', 'far'], ['far250', 'far250']];
    const SETS = { all: ALL.map((v) => v[0]), few: ['front34_l', 'rear34_r', 'cabin', 'chase', 'cockpit'], flight: ['chase', 'below'] };
    const pick = SETS[o.views] ?? o.views.split(',');
    const tag = `${o.quality}_${o.mood}${o.lights ? '_lights' : ''}${o.livery !== 'A' ? '_' + o.livery : ''}${o.phone ? '_phone' : ''}`;
    for (const [name, kind, ang] of ALL.filter((v) => pick.includes(v[0]))) {
      const js = `(() => {
        const H = window.__heli, h = H.machines[0], X = ${ax}, Z = ${az}, Y = ${spot.y}, yaw = ${ah};
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw);       // the nose's way
        const rx = -fz, rz = fx;                              // its right
        const at = (along, right, up) => [X + fx * along + rx * right, Y + up, Z + fz * along + rz * right];
        const mid = at(-1.9, 0, 1.4);
        let c, t, fov = 40, feet;
        H.pose(h, { x: X, y: Y, z: Z, yaw });
        switch (${JSON.stringify(kind)}) {
          case 'ring': { const a = ${ang ?? 0} * Math.PI / 180; c = at(-1.9 + Math.cos(a) * 8, Math.sin(a) * 8, 1.65); t = mid; fov = 50; break; }
          case 'above': c = at(-1.9 + 5, 7, 12); t = mid; fov = 45; break;
          case 'head': c = at(0.6, 1.9, 3.55); t = at(0, 0, 3.15); fov = 40; break;
          case 'cabin': c = at(-0.7, 3.4, 1.85); t = at(-0.9, 0, 1.25); fov = 45; break;
          case 'tesla': c = at(9, 3, 1.65); t = at(-1, 3, 1.1); fov = 55; break;
          case 'cockpit': { const e = window.__anchor(h, 'Eye_Pilot'); c = e; t = [e[0] + fx * 5, e[1] - 0.9, e[2] + fz * 5]; fov = 75; break; }
          case 'chase': case 'below': {
            const up = 30;
            H.pose(h, { x: X, y: Y + up, z: Z, yaw, pitch: -8 * Math.PI / 180, roll: 12 * Math.PI / 180, flying: true, spin: 0.7 });
            const look = [X, Y + up + 2, Z];
            c = ${JSON.stringify(kind)} === 'chase' ? [X - fx * 14 * Math.cos(0.3), Y + up + 2 + 14 * Math.sin(0.3), Z - fz * 14 * Math.cos(0.3)] : at(-4, -6, up - 18);
            if (${JSON.stringify(kind)} === 'below') c = [X + fx * 6 + rx * 5, Y + 1.7, Z + fz * 6 + rz * 5];
            t = look; fov = ${JSON.stringify(kind)} === 'chase' ? 60 : 40;
            feet = Y; // the player stays on the ground (no parachute in front of the camera)
            break;
          }
          case 'far': H.pose(h, { x: X, y: Y, z: Z, yaw, far: true }); c = at(-64, -62, 4); t = mid; fov = 9; break;
          case 'near90': c = at(-64, -62, 4); t = mid; fov = 9; break; // the full model from the same place: the switch
          case 'far250': H.pose(h, { x: X, y: Y, z: Z, yaw, far: true }); c = at(-180, -170, 6); t = mid; fov = 3.4; break;
        }
        window.__look(c[0], c[1], c[2], t[0], t[1], t[2], fov, feet);
      })()`;
      await b.evaluate(js, false);
      if (o.eval) console.log(name, await b.evaluate(o.eval, true)); // a check or a change to try out, run after each view is set
      await b.sleep(name.startsWith('far') ? 3000 : 1500);
      await b.screenshot(join(out, `${name}_${tag}.png`));
    }
  }
  const errors = b.logs.filter((l) => /^(error|exception)/.test(l));
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
} finally {
  b.close();
}
