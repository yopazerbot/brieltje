// Shared by the trailer's recorder (tools/dev/trailer/record.mjs): pages that join a throwaway game server as
// players, the admin's connection that starts Zombies and picks the wave, and a page's picture recorded as frames.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from '../../../web/node_modules/ws/wrapper.mjs';
import { launch } from '../cdp.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The admin on the game server at `api` (http://localhost:<port>): logs in, connects, starts games and picks waves. */
export async function admin(api, password) {
  const call = async (method, path, body, cookie = '') => {
    const r = await fetch(api + path, { method, headers: { 'Content-Type': 'application/json', Origin: api, Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    return { r, data: await r.json().catch(() => null) };
  };
  const login = await call('POST', '/api/login', { username: 'admin', password });
  if (!login.r.ok) throw new Error(`admin login failed: ${login.r.status}`);
  const cookie = login.r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  await call('POST', '/api/lockouts', {}, cookie); // every player here joins from one address
  const ws = new WebSocket(`ws://${new URL(api).host}/ws?v=2`, { headers: { Cookie: cookie, Origin: api } });
  const log = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', n: m.n }));
    else if (m.t !== 'tick' && m.t !== 's') log.push(m);
  });
  await new Promise((res, rej) => (ws.on('open', res), ws.on('error', rej)));
  const send = (m) => ws.send(JSON.stringify(m));
  return {
    cookie,
    log,
    send,
    call: (method, path, body) => call(method, path, body, cookie),
    zombies: (place) => send({ t: 'mode', kind: 'zombies', place }),
    free: () => send({ t: 'mode', kind: 'free' }),
    wave: (wave) => send({ t: 'zwave', wave }),
    close: () => ws.close(),
  };
}

/**
 * A page that joins the game together under `name` through the dev server at `url` (its proxy points at the game
 * server), with window.briel. `graphics`: the preset; `width`, `height`: the picture; `sound`: the page's own sound
 * is also sent to a recorder (see audio below).
 */
export async function player({ url, port, name, width = 1280, height = 720, graphics = 'high', sound = false }) {
  const b = await launch({ port, width, height, extra: ['--autoplay-policy=no-user-gesture-required', '--hide-scrollbars', '--force-device-scale-factor=1'] });
  const setup = `localStorage.setItem('briel.graphics',${JSON.stringify(graphics)});localStorage.setItem('briel.lang','en');localStorage.setItem('briel.spawn','church');`;
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: setup + (sound ? AUDIO_TAP : '') });
  await b.send('Page.navigate', { url });
  await b.waitFor("!!document.querySelector('#choose-kbm')");
  await b.sleep(6000); // the dev build attaches the start screen's handlers late
  await b.evaluate(`(() => {
    const n = document.querySelector('#nick'); n.value = ${JSON.stringify(name)}; n.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-mp=multi]').click();
    const age = document.querySelector('#mp-age'); if (!age.checked) age.click();
    document.querySelector('#choose-kbm').click();
  })()`, false);
  try {
    await b.waitFor('!!window.briel', 90000);
  } catch (e) {
    console.log(name, 'did not start:', JSON.stringify(await b.evaluate("document.getElementById('mp-msg')?.textContent ?? ''")));
    b.close();
    throw e;
  }
  await b.waitFor("(() => { const p = document.getElementById('start-panel'); if (!p || p.offsetParent === null) return true; const s = getComputedStyle(p); return s.visibility === 'hidden' || Number(s.opacity) < 0.05; })()", 240000);
  await b.sleep(300);
  await b.evaluate("document.getElementById('cc-close')?.click(); window.briel?.loadoutCard?.close(false)", false).catch(() => {});
  return Object.assign(b, { name });
}

/**
 * Before the page's own scripts: everything the game sends to its speakers also goes into a recorder, so the
 * trailer has the game's real sound (a headless browser plays none). window.__audio.start() and .stop() -> base64 webm.
 */
export const AUDIO_TAP = `(() => {
  const taps = new Map();
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (to, ...rest) {
    if (to instanceof AudioDestinationNode) {
      let tap = taps.get(to.context);
      if (!tap) taps.set(to.context, (tap = to.context.createMediaStreamDestination()));
      connect.call(this, tap);
    }
    return connect.call(this, to, ...rest);
  };
  let rec = null, chunks = [];
  window.__audio = {
    contexts: () => [...taps.keys()].map((c) => c.state),
    start() {
      const tap = [...taps.values()][0];
      if (!tap) return false;
      chunks = [];
      rec = new MediaRecorder(tap.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 192000 });
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.start(250);
      return performance.timeOrigin + performance.now();
    },
    stop: () => new Promise((res) => {
      if (!rec) return res('');
      rec.onstop = async () => {
        const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
        let s = '';
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        res(btoa(s));
      };
      rec.stop();
    }),
  };
})();`;

/**
 * Records a page's picture as JPEG frames in `dir` (frame-000001.jpg ...) with frames.txt for ffmpeg's concat
 * (each frame's own time, so a slow moment stays in step). Returns stop().
 */
export async function record(b, dir, { quality = 92, everyNth = 1 } = {}) {
  mkdirSync(dir, { recursive: true });
  const frames = [];
  let n = 0;
  const onFrame = (m) => {
    if (m.method !== 'Page.screencastFrame') return;
    b.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {});
    const file = `frame-${String(++n).padStart(6, '0')}.jpg`;
    writeFileSync(join(dir, file), Buffer.from(m.params.data, 'base64'));
    frames.push({ file, t: m.params.metadata.timestamp });
  };
  b.listeners.push(onFrame);
  await b.send('Page.startScreencast', { format: 'jpeg', quality, everyNthFrame: everyNth });
  return async () => {
    await b.send('Page.stopScreencast');
    b.listeners.splice(b.listeners.indexOf(onFrame), 1);
    const lines = ['ffconcat version 1.0'];
    for (let i = 0; i < frames.length; i++) {
      lines.push(`file ${frames[i].file}`);
      const d = i + 1 < frames.length ? frames[i + 1].t - frames[i].t : 1 / 30;
      lines.push(`duration ${Math.max(0.001, d).toFixed(4)}`);
    }
    if (frames.length) lines.push(`file ${frames.at(-1).file}`);
    writeFileSync(join(dir, 'frames.txt'), lines.join('\n') + '\n');
    const secs = frames.length ? frames.at(-1).t - frames[0].t : 0;
    return { frames: frames.length, seconds: secs, fps: secs ? frames.length / secs : 0, t0: frames[0]?.t ?? 0 };
  };
}

/**
 * A player that plays by itself, run in its page: turns to the nearest zombie, fires when it is in its sights, backs
 * off when one comes close and walks back to its post. window.__bot = { on, home: [x, z] | null, range, cadence, look }.
 * `look`: [x, z] to face when no zombie is near.
 */
export const BOT = `(() => {
  const B = (window.__bot = { on: false, home: null, range: 15, cadence: 260, next: 0, look: null, shots: 0, turn: 0.16, retreat: 4.2, fwd: 1, sway: 0.4, phase: Math.random() * 6 });
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  // Looking through the scope is holding the aim button: the bot holds it (B.aim) where a player would.
  const hold = () => {
    if (!window.briel?.weapon || B.held) return;
    B.held = true;
    const update = briel.weapon.update.bind(briel.weapon);
    briel.weapon.update = (dt, move, aim, ...rest) => update(dt, move, aim || !!B.aim, ...rest);
  };
  const loop = () => {
    requestAnimationFrame(loop);
    hold();
    if (!B.on || !window.briel || !briel.combat.alive) return;
    const p = briel.player;
    let best = null, bd = 1e9;
    for (const z of briel.zombies.zs.values()) {
      if (!(z.hp > 0) || z.downAt) continue;
      const d = Math.hypot(z.x - p.x, z.z - p.z);
      if (d < bd) { bd = d; best = z; }
    }
    const now = performance.now();
    let tx = null, tz = null, ty = 0;
    if (best && bd < 60) { tx = best.x; tz = best.z; ty = best.y + (best.kind === 4 ? 1.5 : 1.15) - (p.feet + 1.6); }
    else if (B.look) { tx = B.look[0]; tz = B.look[1]; }
    if (tx !== null) {
      const d = Math.hypot(tx - p.x, tz - p.z) || 1;
      const dy = wrap(Math.atan2(-(tx - p.x), -(tz - p.z)) - p.yaw);
      p.yaw += dy * B.turn;
      p.pitch += (Math.atan2(ty, d) - p.pitch) * B.turn;
      if (best && bd < B.range && Math.abs(dy) < 0.05 && now > B.next) { briel.fire(); B.shots++; B.next = now + B.cadence * (0.8 + Math.random() * 0.5); }
    }
    let mx = 0, my = 0;
    if (best && bd < B.retreat) { my = -1; mx = Math.sin(now / 900 + B.phase) * 0.5; }
    else if (best && bd < B.range) mx = Math.sin(now / 1100 + B.phase) * B.sway; // a step left, a step right while firing
    else if (B.home) {
      const hx = B.home[0] - p.x, hz = B.home[1] - p.z, hd = Math.hypot(hx, hz);
      if (hd > 1.2) { const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw); my = (hx * fx + hz * fz) / hd; mx = (hx * Math.cos(p.yaw) - hz * Math.sin(p.yaw)) / hd; }
    }
    if (mx || my) briel.press({ moveX: mx, moveY: my * B.fwd }, 1 / 60);
  };
  loop();
})()`;

/** What the trailer leaves out of a player's picture: the chat, the lists, the buttons, the hints. */
export const CLEAN_CSS = `#travel, #map-btn, #sound-btn, #full-btn, #full-hint, #controls-card, #zexplore, #feedback, #host-bar, #overlay,
  #who, #place, #menu-hint, #minimap, #fps, #capture-hint, #modebar, #online, #credit, #chat-log, #chat-input, #toast, #prompt, #net-status,
  #hud-top, #scoreboard { display: none !important; }`;

export const css = (b, text) => b.evaluate(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(text)}; document.head.append(s); })()`, false);

/** The picture's size, whatever the window's. */
export const size = (b, width, height) => b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

/**
 * The director, run inside the watch page's view (the game's own page, where every player is an avatar): it moves
 * that page's camera just before each frame is drawn, so the picture always holds the players and the zombies
 * nearest to them. window.__cine.mode: 'zombie' (from among the zombies, towards the players), 'over' (behind the players' shoulders, towards the zombies), 'side' (the
 * players on one side, the zombies on the other), 'front' (the players' faces, the zombies coming past), 'high'
 * (from above and behind), 'orbit' (circling the fight), or null: the view's own camera. Returns what it found.
 */
export const CINE = `(() => {
  const cam = briel.weapon.camera;
  const composer = briel.three.composer;
  if (!cam || !cam.isCamera) return 'no camera';
  const C = (window.__cine = { mode: null, pos: null, look: null, dir: [0, -1], t0: performance.now() });
  const lerp = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
  const render = composer.render.bind(composer);
  composer.render = (dt) => {
    if (C.mode) {
      const ps = [...briel.avatars.avatars.values()].map((v) => v.latest).filter((s) => s && Number.isFinite(s.x));
      if (ps.length) {
        const g = [ps.reduce((s, p) => s + p.x, 0) / ps.length, ps.reduce((s, p) => s + p.y, 0) / ps.length, ps.reduce((s, p) => s + p.z, 0) / ps.length];
        const zs = [...briel.zombies.zs.values()].filter((z) => z.hp > 0 && !z.downAt).map((z) => [z.x, z.z, Math.hypot(z.x - g[0], z.z - g[2])]).filter((z) => z[2] < 32).sort((a, b) => a[2] - b[2]).slice(0, 5);
        if (zs.length) {
          const zx = zs.reduce((s, z) => s + z[0], 0) / zs.length - g[0], zz = zs.reduce((s, z) => s + z[1], 0) / zs.length - g[2];
          const d = Math.hypot(zx, zz) || 1;
          C.dir = lerp(C.dir, [zx / d, zz / d], 0.02); // the zombies' side turns slowly: no swinging about
        }
        const n = Math.hypot(C.dir[0], C.dir[1]) || 1;
        const dx = C.dir[0] / n, dz = C.dir[1] / n;
        const t = (performance.now() - C.t0) / 1000;
        let pos, look;
        if (C.mode === 'over') { pos = [g[0] - dx * 6.5, g[1] + 2.7, g[2] - dz * 6.5]; look = [g[0] + dx * 6, g[1] + 1.1, g[2] + dz * 6]; }
        else if (C.mode === 'side') { pos = [g[0] + dx * 3 - dz * 9, g[1] + 1.7, g[2] + dz * 3 + dx * 9]; look = [g[0] + dx * 3.5, g[1] + 1.2, g[2] + dz * 3.5]; }
        else if (C.mode === 'front') { pos = [g[0] + dx * 5.5 + dz * 1.5, g[1] + 1.25, g[2] + dz * 5.5 - dx * 1.5]; look = [g[0], g[1] + 1.35, g[2]]; }
        else if (C.mode === 'zombie' && zs.length) { const zd = Math.min(14, zs[0][2] + 3.5); pos = [g[0] + dx * zd - dz * 1.2, g[1] + 2.0, g[2] + dz * zd + dx * 1.2]; look = [g[0], g[1] + 1.2, g[2]]; }
        else if (C.mode === 'high') { pos = [g[0] - dx * 9, g[1] + 9.5, g[2] - dz * 9]; look = [g[0] + dx * 5, g[1] + 0.5, g[2] + dz * 5]; }
        else { const a = t * 0.3; pos = [g[0] + dx * 3 + Math.cos(a) * 10, g[1] + 3.4, g[2] + dz * 3 + Math.sin(a) * 10]; look = [g[0] + dx * 3, g[1] + 1.1, g[2] + dz * 3]; }
        const fresh = C.last !== C.mode;
        C.last = C.mode;
        C.pos = fresh || !C.pos ? pos : lerp(C.pos, pos, 0.06);
        C.look = fresh || !C.look ? look : lerp(C.look, look, 0.06);
        cam.position.set(C.pos[0], C.pos[1], C.pos[2]);
        cam.lookAt(C.look[0], C.look[1], C.look[2]);
        cam.updateMatrixWorld(true);
      }
    } else C.last = null;
    return render(dt);
  };
  return 'ready';
})()`;
