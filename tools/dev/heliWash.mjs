// The helicopter's rotor wash, lights and sound from the ground (world/rotorWash.ts, world/heliLights.ts,
// world/heliSound.ts), headless (tools/dev/cdp.mjs) on a running dev server. A machine is held in a hover (its pose set
// every frame, the rest of the game running round it) over spots the check finds itself: the meadow by the house
// (grass), a gravel patch, a ploughed field, a pond, a street (in the rain) and the church square (at dusk); pictures
// at 2 and 5 m from where people stand, 15 and 30 m off, with how many sprites and bits are in the air; a landing in
// four frames; the machine at 30 m seen from the ground 20, 80 and 250 m
// away (day and dusk). With --bench, the frame time with and without the wash, alternated (A, B, A, B after a warm-up)
// at a 3 m hover over gravel in view. With --sound, the sound by numbers (offline renders, no ears): its peak and loudest tenth
// of a second against a rifle's shot (yours, and another's at 8 m), how loud it is at 20, 80 and 250 m, and the blade
// rate before and after a pass-by (the Doppler).
//
//   node tools/dev/heliWash.mjs --url http://localhost:5680/ --port 9680 --out <folder> [--quality high|low] [--phone]
//                               [--only grass,gravel,pond,street,church,landing,far] [--bench] [--sound] [--soundonly]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5680/', port: '9680', out: '', quality: 'high', phone: false, only: '', bench: false, sound: false, soundonly: false, fov: '' });
const phone = !!o.phone && o.phone !== 'false';
const only = o.only ? new Set(o.only.split(',')) : null;
const want = (k) => !only || only.has(k);
const b = await launch({ port: Number(o.port), width: 1280, height: 720 });
const r1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const shot = async (name) => {
  if (!o.out) return;
  mkdirSync(o.out, { recursive: true });
  await b.screenshot(join(o.out, `${name}.png`));
  console.log(`  picture ${name}.png`);
};

/** In the page: a machine held where `__pin` says, every frame (after the game's own frame: drawn one step of flight on). */
const PIN = `(() => {
  if (window.__pinLoop) return true;
  window.__pinLoop = true;
  const go = () => {
    const p = window.__pin;
    if (p) {
      const m = briel.helis.machines[p.i ?? 0];
      const s = m.s;
      const y = p.y + (p.vy ?? 0) * (performance.now() - p.t0) / 1000;
      Object.assign(s, { x: p.x, y: Math.max(p.floor ?? -1e9, y), z: p.z, yaw: p.yaw ?? 0, vx: 0, vy: p.vy ?? 0, vz: 0, pitch: 0, roll: 0, pitchRate: 0, rollRate: 0, yawRate: 0,
        rotor: p.rotor ?? 1, coll: p.coll ?? 0.6, thrust: p.thrust ?? 1, engine: true, ground: !!p.ground, holdY: y, holdX: p.x, holdZ: p.z, holding: true, down: 0 });
    }
    requestAnimationFrame(go);
  };
  requestAnimationFrame(go);
  return true;
})()`;
const pin = (p) => b.evaluate(`(() => { window.__pin = ${p ? `Object.assign(${JSON.stringify(p)}, { t0: performance.now() })` : 'null'}; return true; })()`);
/** Stand `dist` m from (x, z) on its `side` (rad), looking at the point `look` m up over the ground there. */
async function standOff(x, z, dist, side, look) {
  const px = x + Math.sin(side) * dist;
  const pz = z + Math.cos(side) * dist;
  const feet = await b.evaluate(`briel.world.groundAt(${px}, ${pz}, 200, 0).y`);
  const ground = await b.evaluate(`briel.world.groundAt(${x}, ${z}, 200, 0).y`);
  const yaw = Math.atan2(-(x - px), -(z - pz));
  const pitch = Math.atan2(ground + look - (feet + 1.6), dist);
  // Again until standing there (a start's parachute or a fall can still be under way).
  for (let i = 0; i < 4; i++) {
    await b.evaluate(`briel.teleport(${px}, ${pz}, ${feet}, ${yaw}, ${pitch})`, false);
    await b.sleep(400);
    if (await b.evaluate(`briel.player.chute === null && Math.abs(briel.player.feet - ${feet}) < 1`)) break;
  }
}
const ground = (x, z) => b.evaluate(`briel.world.groundAt(${x}, ${z}, 200, 0).y`);

try {
  // A narrower view (the game's own setting, as a player may set it).
  if (o.fov) await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('briel.settings', JSON.stringify({ fov: ${Number(o.fov)} })); } catch {}` });
  if (!o.soundonly) {
    await startGame(b, o.url, { phone, village: true, noAsk: true });
    await b.evaluate(`briel.three.applyQuality(${JSON.stringify(o.quality)})`, false);
    await b.evaluate('briel.three.holdQuality(true)', false);
    await b.evaluate(PIN);
    // No hint over the middle of the picture.
    await b.evaluate("(() => { const s = document.createElement('style'); s.textContent = '#capture-hint { display: none !important; }'; document.head.appendChild(s); return true; })()");
    await b.evaluate("briel.three.weather.setSolo('sunny')", false);
    await b.sleep(9000);
    // The spots, found in the page: the house's pad (grass), and round it gravel, a street and a pond.
    const spots = await b.evaluate(`(async () => {
      const water = await import('/src/world/water.ts');
      const w = briel.world;
      const pad = briel.helis.machines[0].park;
      const out = { grass: { x: pad.x, z: pad.z } };
      const clear = (x, z, test, radii = [3, 6]) => { for (let a = 0; a < 8; a++) for (const r of radii) if (!test(x + Math.cos(a * 0.785) * r, z + Math.sin(a * 0.785) * r)) return false; return test(x, z); };
      const mat = (m) => (x, z) => (w.groundAt(x, z, 200, 0).mat ?? '') .match(m) && water.waterLevel(x, z) === null;
      const wet = (x, z) => water.waterLevel(x, z) !== null;
      for (let r = 10; r < 700 && !(out.gravel && out.street && out.pond && out.field); r += 4) {
        for (let a = 0; a < 6.283; a += 4 / r) {
          const x = pad.x + Math.cos(a) * r, z = pad.z + Math.sin(a) * r;
          if (!out.gravel && clear(x, z, mat(/gravel|track/), [2])) out.gravel = { x, z };
          if (!out.field && r > 40 && clear(x, z, mat(/^field_(soil|dark)/), [5, 10])) out.field = { x, z }; // a ploughed field
          if (!out.street && clear(x, z, mat(/road|street|asphalt/))) out.street = { x, z };
          if (!out.pond && clear(x, z, wet, [4, 8])) out.pond = { x, z };
        }
      }
      out.church = { x: 528.1, z: -765.4 };
      return out;
    })()`);
    console.log('spots:', JSON.stringify(spots));
    // From where people stand: 15 and 30 m off, the machine hovering at 2 and 5 m.
    const heights = [2, 5];
    const scene = async (name, at, mood, side = 0.6) => {
      if (!at || !want(name)) return;
      await b.evaluate(`briel.three.weather.setSolo(${JSON.stringify(mood)})`, false);
      const g = await ground(at.x, at.z);
      await standOff(at.x, at.z, 15, side, 2.5);
      await pin(null);
      await b.sleep(mood === 'sunny' ? 5000 : 9000);
      await shot(`${name}-0m-before-15m`);
      for (const h of heights) {
        await pin({ x: at.x, y: g + h, z: at.z, yaw: 0.4 });
        for (const d of [15, 30]) {
          await standOff(at.x, at.z, d, side, h * 0.5 + 1.5);
          await b.sleep(d === 15 ? 4500 : 1500); // the dust built up
          const st = await b.evaluate('briel.rotorWash.state()');
          console.log(`  ${name} ${h} m from ${d} m: strength ${st.machines.map((m) => `${r1(m.w)} on ${m.kind}`).join(', ')}; discs ${st.discs.map((q) => r1(q[3])).join(', ')}; ${st.dust.sprites} sprites, ${st.dust.bits} bits`);
          await shot(`${name}-${h}m-from-${d}m`);
        }
      }
      await pin(null);
      await b.evaluate(`briel.helis.dev.put('house', 0)`);
    };
    await scene('grass', spots.grass, 'sunny');
    await scene('gravel', spots.gravel, 'sunny');
    await scene('field', spots.field, 'sunny');
    await scene('pond', spots.pond, 'sunny');
    await scene('street', spots.street, 'rain');
    await scene('church', spots.church, 'dusk');
    await scene('night', spots.grass, 'night', -2.1); // the lamps and the landing light's pool
    if (want('landing')) {
      // A landing on the meadow, four frames: coming down from 14 m at 1.5 m/s, the touchdown, settled.
      await b.evaluate("briel.three.weather.setSolo('sunny')", false);
      const at = spots.grass;
      const g = await ground(at.x, at.z);
      await standOff(at.x, at.z, 22, 1.2, 3);
      await pin({ x: at.x, y: g + 14, z: at.z, yaw: 0.4, coll: 0.5 });
      await b.sleep(9000);
      await pin({ x: at.x, y: g + 14, z: at.z, yaw: 0.4, coll: 0.5, vy: -1.5, floor: g });
      await b.sleep(3300);
      await shot('landing-1-9m');
      await b.sleep(2700);
      await shot('landing-2-5m');
      await b.sleep(2700);
      await shot('landing-3-1m');
      await pin({ x: at.x, y: g, z: at.z, yaw: 0.4, coll: 0, thrust: 0.29, ground: true });
      await b.sleep(4000);
      await shot('landing-4-settled');
      await pin(null);
      await b.evaluate(`briel.helis.dev.put('house', 0)`);
    }
    if (want('far')) {
      // From the ground at 20, 80 and 250 m: the machine 30 m up over the meadow, by day and at dusk.
      const at = spots.grass;
      const g = await ground(at.x, at.z);
      for (const mood of ['sunny', 'dusk', 'night']) {
        await b.evaluate(`briel.three.weather.setSolo(${JSON.stringify(mood)})`, false);
        await pin({ x: at.x, y: g + 30, z: at.z, yaw: 1.2, coll: 0.6 });
        for (const d of [20, 80, 250]) {
          // Out over the fields where they reach that far inside the game's edge.
          // Out over the fields where they reach that far inside the game's edge: the first side where you stand there
          // (not falling: past the edge a teleport drops you from the sky).
          for (const side of [-2.1, -1.6, -2.6, -1.1, 2.6, 1.6, 0.6, 0]) {
            await standOff(at.x, at.z, d, side, 30 - d * 0.04); // the machine a little over the crosshair, not under it
            await b.sleep(800);
            if (await b.evaluate('briel.player.chute === null && briel.player.velocity.y > -3')) break;
          }
          await b.sleep(d === 20 ? 9000 : 2500);
          await shot(`far-${mood}-${d}m`);
        }
      }
      await pin(null);
      await b.evaluate(`briel.helis.dev.put('house', 0)`);
    }
    if (want('join')) {
      // The wash beside the weather's wind and the rain's cover: both move the same things at once. Two renders 0.4 s
      // apart, the mean change of the middle of the view (0 to 255): with the machine far off (the wind alone) and
      // hovering 3 m up near by (the wind and the wash).
      const motion = () => b.evaluate(`(async () => {
        const grab = () => { briel.bench(1); const r = briel.three.renderer.domElement; const c = document.createElement('canvas'); c.width = 240; c.height = 160;
          const g = c.getContext('2d'); g.drawImage(r, r.width / 2 - r.width * 0.15, r.height / 2 - r.height * 0.05, r.width * 0.3, r.height * 0.3, 0, 0, 240, 160); return g.getImageData(0, 0, 240, 160).data; };
        const a = grab(); await new Promise((f) => setTimeout(f, 400)); const q = grab();
        let s = 0; for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - q[i]) + Math.abs(a[i + 1] - q[i + 1]) + Math.abs(a[i + 2] - q[i + 2]);
        return s / (a.length / 4) / 3;
      })()`);
      const crown = await b.evaluate(`(() => { const p = briel.helis.machines[0].park; const list = briel.helis.dev.crowns(); let best = null;
        for (const c of list) { const d = Math.hypot(c.x - p.x, c.z - p.z); if (d > 30 && d < 300 && c.h > 8 && (!best || d < best.d)) best = { x: c.x, z: c.z, y: c.y, h: c.h, d }; } return best; })()`);
      const checks = [
        ['grass', spots.grass, 0.6, 1.0],
        ['pond', spots.pond, 0.6, 0.3],
        ['trees', crown && { x: crown.x, z: crown.z + 9 }, Math.PI / 2, crown ? crown.h * 0.6 : 5], // beside the crown as seen, not in front
      ];
      await b.evaluate("briel.three.weather.setSolo('overcast')", false);
      await b.sleep(9000);
      for (const [name, at, side, look] of checks) {
        if (!at) continue;
        const g = await ground(at.x, at.z);
        // Looking at the place from 16 m: the trees' crown itself, the reeds and the grass at the pond's edge.
        const lookAt = name === 'trees' ? { x: crown.x, z: crown.z } : at;
        await standOff(lookAt.x, lookAt.z, 16, side, look);
        await pin({ x: at.x + 400, y: g + 3, z: at.z, yaw: 0.4 });
        await b.sleep(3000);
        const alone = await motion();
        await shot(`join-${name}-wind`);
        await pin({ x: at.x, y: g + 3, z: at.z, yaw: 0.4 });
        await b.sleep(3500);
        const both = await motion();
        await shot(`join-${name}-wind-and-wash`);
        console.log(`  ${name}: change in 0.4 s, the wind alone ${alone.toFixed(2)}, the wind and the wash ${both.toFixed(2)}`);
      }
      // The rain by the bus shelter: the drops stop at its roof, slant with the gusts, and are driven outward under
      // the machine hovering 3 m up beside it.
      const shelter = { x: -31.88, z: -1118.44, yaw: -0.485 };
      await b.evaluate("briel.three.weather.setSolo('rain')", false);
      const fx = Math.sin(shelter.yaw), fz = Math.cos(shelter.yaw); // its open side, +z turned by its yaw
      const hx = shelter.x + fx * 8, hz = shelter.z + fz * 8;
      const g = await ground(hx, hz);
      await pin({ x: hx, y: g + 3, z: hz, yaw: shelter.yaw });
      await standOff(shelter.x, shelter.z, 7, shelter.yaw + Math.PI * 0.8, 1.8);
      await b.sleep(9000);
      await shot('join-rain-shelter');
      await standOff(hx, hz, 12, shelter.yaw + Math.PI * 0.5, 2);
      await b.sleep(2500);
      await shot('join-rain-under-machine');
      await pin(null);
      await b.evaluate(`briel.helis.dev.put('house', 0)`);
    }
    if (o.bench) {
      // The cost: a 3 m hover over the gravel (the thickest dust; the meadow without one) in view from 14 m (as from
      // the chase camera), wash on and off.
      await b.evaluate("briel.three.weather.setSolo('sunny')", false);
      const at = spots.gravel ?? spots.grass;
      const g = await ground(at.x, at.z);
      await standOff(at.x, at.z, 14, 0.3, 2);
      await pin({ x: at.x, y: g + 3, z: at.z, yaw: 0.4 });
      await b.evaluate(`(() => { const w = briel.rotorWash; if (w.__u) return; w.__u = w.update.bind(w); w.update = (dt, m, e, f) => w.__u(dt, window.__washOff ? [] : m, e, f); })()`);
      await b.sleep(5000);
      await b.evaluate('briel.bench(120)', false); // warm-up
      const on = [];
      const off = [];
      for (let i = 0; i < 4; i++) {
        await b.evaluate('window.__washOff = false', false);
        await b.sleep(4000);
        on.push((await b.evaluate('briel.bench(120)', false)).msPerFrame);
        if (i === 0) await shot('bench-wash-on');
        await b.evaluate('window.__washOff = true', false);
        await b.sleep(4000);
        off.push((await b.evaluate('briel.bench(120)', false)).msPerFrame);
        if (i === 0) await shot('bench-wash-off');
      }
      const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
      console.log(`  bench ${o.quality}${phone ? ' phone' : ''}: wash on ${on.join(', ')} ms; off ${off.join(', ')} ms; mean difference ${(mean(on) - mean(off)).toFixed(2)} ms (the chip shared with other agents)`);
      await b.evaluate('window.__washOff = false', false);
      await pin(null);
    }
  } else {
    await startGame(b, o.url, { noAsk: true });
  }
  if (o.sound || o.soundonly) {
    // The sound by numbers: offline renders (no ears), as tools/dev/heli.mjs --sound.
    const got = await b.evaluate(`(async () => {
      const H = window.brielHeliSound;
      const sr = 48000;
      const stats = (d) => {
        let peak = 0, sum = 0, loud = 0;
        const win = Math.round(sr * 0.1);
        for (let i = 0; i < d.length; i++) { peak = Math.max(peak, Math.abs(d[i])); sum += d[i] * d[i]; }
        for (let i = 0; i + win <= d.length; i += win / 2) { let s = 0; for (let k = i; k < i + win; k++) s += d[k] * d[k]; loud = Math.max(loud, Math.sqrt(s / win)); }
        return { peak, rms: Math.sqrt(sum / d.length), loud };
      };
      // A rifle's shot as weapon.ts makes it (not paintball): noise through a falling lowpass, a thump, the crack, the echo.
      const rifle = async (volume, gainAt) => {
        const c = new OfflineAudioContext(1, sr, sr);
        const noise = (len, shape) => { const bf = c.createBuffer(1, Math.ceil(sr * len), sr); const d = bf.getChannelData(0); let seed = 7; for (let i = 0; i < d.length; i++) { seed = (seed * 1103515245 + 12345) >>> 0; d[i] = ((seed / 4294967296) * 2 - 1) * shape(i / d.length); } return bf; };
        const master = c.createGain(); master.gain.value = volume * gainAt; master.connect(c.destination);
        const out = c.createGain(); out.gain.value = 0.45; out.connect(master);
        const n = c.createBufferSource(); n.buffer = noise(0.2, (s) => Math.pow(1 - s, 4));
        const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(5500, 0); f.frequency.exponentialRampToValueAtTime(400, 0.2);
        n.connect(f).connect(out); n.start(0);
        const th = c.createOscillator(); th.frequency.setValueAtTime(120, 0); th.frequency.exponentialRampToValueAtTime(35, 0.14);
        const tg = c.createGain(); tg.gain.setValueAtTime(0.8, 0); tg.gain.exponentialRampToValueAtTime(0.001, 0.18); th.connect(tg).connect(out); th.start(0); th.stop(0.2);
        const cr = c.createBufferSource(); cr.buffer = noise(0.02, (s) => Math.pow(1 - s, 2));
        const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2200; const cg = c.createGain(); cg.gain.value = 0.55;
        cr.connect(hp).connect(cg).connect(out); cr.start(0);
        const tl = 0.5 + 0.2 * 1.4; const tail = c.createBufferSource(); tail.buffer = noise(tl, (s) => Math.min(1, s * 12) * Math.pow(1 - s, 2.5));
        const lo = c.createBiquadFilter(); lo.type = 'lowpass'; lo.frequency.setValueAtTime(900, 0); lo.frequency.exponentialRampToValueAtTime(180, tl);
        const tgn = c.createGain(); tgn.gain.value = 0.16; tail.connect(lo).connect(tgn).connect(out); tail.start(0);
        return stats((await c.startRendering()).getChannelData(0));
      };
      const own = await rifle(1, 1);
      // Another's shot at 8 m: volume 0.35 (main.ts remoteShot), the panner's inverse law from 4 m (sound.ts at).
      const other = await rifle(0.35, 4 / (4 + 1.1 * 4));
      const hover = (coll) => () => ({ x: 0, y: 0, z: 0, rotor: 1, coll, sink: 0, air: 0, inside: false });
      const at = (d) => ({ x: 0, y: 2, z: d });
      const all = stats((await H.render(30, sr)).buffer.getChannelData(0));
      const climbClose = stats((await H.render(4, sr, hover(1), 0, at(5))).buffer.getChannelData(0));
      const descent = stats((await H.render(4, sr, () => ({ x: 0, y: 0, z: 0, rotor: 1, coll: 0.3, sink: 6, air: 0, inside: false }), 0, at(5))).buffer.getChannelData(0));
      const dist = {};
      for (const d of [8, 20, 80, 250]) dist[d] = stats((await H.render(4, sr, hover(0.6), 0, at(d))).buffer.getChannelData(0)).rms;
      const above3k = stats((await H.render(4, sr, hover(0.6), 3000, at(8))).buffer.getChannelData(0)).rms;
      // The pass-by: the blade rate from the envelope's autocorrelation 3 s before and 3 s after it is nearest.
      const secs = 20;
      const pb = (await H.render(secs, sr, H.passBy(secs, 40, 30, 20), 0, { x: 0, y: 0, z: 0 })).buffer.getChannelData(0);
      const rate = (t0) => {
        const blk = 48, n = Math.floor(sr * 2 / blk), env = new Float32Array(n);
        const s0 = Math.floor(t0 * sr);
        for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < blk; k++) s += Math.abs(pb[s0 + i * blk + k]); env[i] = s; }
        const mean = env.reduce((a, v) => a + v, 0) / n;
        for (let i = 0; i < n; i++) env[i] -= mean;
        let best = 0, lag = 0;
        for (let L = Math.floor(sr / 40 / blk); L <= Math.ceil(sr / 18 / blk); L++) { let s = 0; for (let i = 0; i + L < n; i++) s += env[i] * env[i + L]; if (s > best) { best = s; lag = L; } }
        // A finer lag: the parabola through the peak and its neighbours.
        const ac = (L) => { let s = 0; for (let i = 0; i + L < n; i++) s += env[i] * env[i + L]; return s; };
        const a = ac(lag - 1), c0 = ac(lag), c1 = ac(lag + 1);
        const fine = lag + (a - c1) / (2 * (a - 2 * c0 + c1));
        return sr / (fine * blk);
      };
      const old = { 20: 8 / (8 + 1.1 * 12), 80: 8 / (8 + 1.1 * 72), 250: 8 / (8 + 1.1 * 112) };
      return { own, other, all, climbClose, descent, dist, above3k, coming: rate(secs / 2 - 4), going: rate(secs / 2 + 2), blade: H.BLADE_HZ, old, levels: H.LEVELS };
    })()`);
    const db = (v) => (20 * Math.log10(v)).toFixed(1);
    console.log(`  rifle, yours: peak ${got.own.peak.toFixed(3)}, loudest 0.1 s ${got.own.loud.toFixed(3)} RMS; another's at 8 m: peak ${got.other.peak.toFixed(3)}, loudest ${got.other.loud.toFixed(3)}`);
    console.log(`  helicopter at 8 m (the default run): peak ${got.all.peak.toFixed(3)}, loudest 0.1 s ${got.all.loud.toFixed(3)}, RMS ${got.all.rms.toFixed(3)}`);
    console.log(`  helicopter at 5 m, full climb: peak ${got.climbClose.peak.toFixed(3)}, loudest ${got.climbClose.loud.toFixed(3)}; descending: peak ${got.descent.peak.toFixed(3)}, loudest ${got.descent.loud.toFixed(3)}`);
    console.log(`  its loudest against your rifle's: ${db(Math.max(got.all.loud, got.climbClose.loud, got.descent.loud) / got.own.loud)} dB (loudest 0.1 s), peak ${db(Math.max(got.all.peak, got.climbClose.peak, got.descent.peak) / got.own.peak)} dB`);
    console.log(`  hover RMS by distance: 8 m ${got.dist[8].toFixed(4)}, 20 m ${got.dist[20].toFixed(4)} (${db(got.dist[20] / got.dist[8])} dB), 80 m ${got.dist[80].toFixed(4)} (${db(got.dist[80] / got.dist[8])} dB), 250 m ${got.dist[250].toFixed(4)} (${db(got.dist[250] / got.dist[8])} dB); the old law: ${db(got.old[20])}, ${db(got.old[80])}, ${db(got.old[250])} dB`);
    console.log(`  above 3 kHz at 8 m: RMS ${got.above3k.toFixed(5)} (${db(got.above3k / got.dist[8])} dB under the whole)`);
    console.log(`  pass-by at 40 m/s, 30 m off: blade rate ${got.coming.toFixed(2)} Hz coming, ${got.going.toFixed(2)} Hz going (${got.blade.toFixed(2)} Hz at rest; ratio ${(got.coming / got.going).toFixed(3)})`);
  }
  const errors = (b.logs ?? []).filter((l) => /^(error|exception)/i.test(l) && !/Failed to load resource/.test(l));
  console.log(errors.length ? `  page errors:\n    ${errors.slice(0, 8).join('\n    ')}` : '  no page errors');
} finally {
  await pin(null).catch(() => {});
  b.close();
}
