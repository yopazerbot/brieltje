import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BALL, inReach, KICK, kickBall, kickFrom, makePitch, newBall, PITCHES, stepBall, toHome, type Ball, type BallEvent, type Mover, type Pitch } from '../../shared/ball.mjs';
import { netClock } from '../net/track';
import { sound } from '../sound';

/**
 * The footballs (shared/ball.mjs): one on the school's playground between two small goals, one on the main
 * house's back lawn. Alone the page runs them. Together the server owns them (server/football.mjs): the page
 * asks to kick ('kickball') and draws the server's ball in the present, not in the past as the players: it
 * runs the same steps on from each state the server sends (by how old that state is on the server's clock,
 * net/track.ts), so its own kicks and pushes show at once, and the difference to the server's next state is
 * taken out over a tenth of a second instead of in a jump. Until the server has answered one of our kicks, its
 * states from before it are passed over (they would take the kick back for a moment).
 *
 * Drawn: the ball (white with black patches, rolling as it goes), a soft shadow patch under it, and our goal
 * at the gate end of the playground (the one at the far end is part of the school's model, tools/school.py).
 * Bullets and paint go through the ball. Sounds made in code: the kick, a bounce, the goal's frame ringing
 * and a short cheer at a goal.
 */

const DRAW = 160; // m: drawn (and run alone) within this of the eye
const SETTLE = 0.1; // s: a correction from the server fades over about this long
const WAIT_ACK = 600; // ms: how long the server's older states are passed over after our own kick
const JUMP = 3; // m: a correction this big is a jump (back in the middle), not smoothed
const PACE_S = 0.2; // s of our own positions that make our pace (the server measures the same)

/** A ball as this page has it. */
interface View {
  id: string;
  pitch: Pitch;
  ball: Ball;
  mesh: THREE.Mesh;
  shadow: THREE.Mesh;
  /** What is drawn minus where the ball is: a correction from the server, fading */
  corr: THREE.Vector3;
  /** The server has sent this ball since we connected */
  synced: boolean;
  /** Our last kick of it, waiting for the server to take it */
  pendingQ: number;
  pendingUntil: number;
  /** The server's last state of it: back to that when the server didn't take our kick (it says nothing then) */
  last: ServerBall | null;
  spin: THREE.Quaternion;
}

/** A ball's state from the server (server/football.mjs state), unchecked. */
type ServerBall = { b: unknown; st: unknown; p: unknown; s?: unknown; n?: unknown; sc?: unknown; k?: unknown; r?: unknown };

/** A goal scored: which pitch, which goal (its number), who kicked it last ('' alone) and the score after it. */
export type GoalNote = { pitch: string; goal: number; by: string; score: number[] };

export class Football {
  readonly views: View[] = [];
  /** A goal: main.ts shows the note. */
  onGoal: (note: GoalNote) => void = () => {};
  private q = 0;
  private trail: { x: number; z: number; t: number }[] = [];
  private tmp = new THREE.Vector3();

  constructor(scene: THREE.Scene, height: (x: number, z: number) => number) {
    const ballGeo = ballGeometry();
    const ballMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0 });
    const shadowMat = shadowMaterial();
    const shadowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    for (const spec of PITCHES) {
      const pitch = makePitch(spec, height);
      const mesh = new THREE.Mesh(ballGeo, ballMat);
      mesh.castShadow = true;
      mesh.name = `football_${spec.id}`;
      noRay(mesh);
      const shadow = new THREE.Mesh(shadowGeo, shadowMat);
      shadow.renderOrder = 1;
      noRay(shadow);
      scene.add(mesh, shadow);
      this.views.push({ id: spec.id, pitch, ball: newBall(pitch), mesh, shadow, corr: new THREE.Vector3(), synced: false, pendingQ: 0, pendingUntil: 0, last: null, spin: new THREE.Quaternion() });
    }
    // Our goal at the gate end of the playground (the other is in the school's model).
    const school = this.views.find((v) => v.id === 'school');
    if (school) {
      const goal = goalMesh(school.pitch.goals[0]);
      noRay(goal);
      scene.add(goal);
    }
    for (const v of this.views) this.place(v);
  }

  /** The ball within kicking reach of a player standing at (x, z), feet at `feet`, or null. */
  near(x: number, feet: number, z: number): View | null {
    for (const v of this.views) if (v.mesh.visible && inReach(v.ball, x, feet, z)) return v;
    return null;
  }

  /** How fast we went over the last moment (m/s across): a hard kick needs a run. */
  pace(): number {
    const t = this.trail;
    if (t.length < 2) return 0;
    const a = t[0], b = t[t.length - 1];
    return b.t > a.t ? Math.hypot(b.x - a.x, b.z - a.z) / (b.t - a.t) : 0;
  }

  /**
   * Kick `v` looking at `yaw`, `pitch`: at once here, and together the server is asked (`send`). False when it
   * can't be kicked now (in the net after a goal).
   */
  kick(v: View, yaw: number, pitch: number, me: string, send: ((m: Record<string, unknown>) => void) | null): boolean {
    const vel = kickFrom(yaw, pitch, this.pace() >= KICK.run ? KICK.hard : KICK.soft);
    if (!kickBall(v.ball, vel, me)) return false;
    thump(v.ball, Math.hypot(...vel) / KICK.hard);
    if (send) {
      v.pendingQ = ++this.q;
      v.pendingUntil = performance.now() + WAIT_ACK;
      const r = (n: number) => Math.round(n * 100) / 100;
      send({ t: 'kickball', b: v.id, v: vel.map(r), q: v.pendingQ });
    }
    return true;
  }

  /**
   * Every frame. `me`: our player on foot (null when driving, riding, dead or flying); `connected`: together
   * (the server's states then lead, and goals come from it).
   */
  update(dt: number, eye: THREE.Vector3, me: { x: number; z: number; feet: number; name: string } | null, connected: boolean): void {
    const now = performance.now() / 1000;
    const last = this.trail[this.trail.length - 1];
    if (me) {
      if (last && Math.hypot(me.x - last.x, me.z - last.z) > 2) this.trail = []; // a portal: not a run
      this.trail.push({ x: me.x, z: me.z, t: now });
      while (this.trail.length > 2 && this.trail[0].t < now - PACE_S) this.trail.shift();
    } else this.trail = [];
    const prev = this.trail.length > 1 ? this.trail[this.trail.length - 2] : null;
    for (const v of this.views) {
      const far = Math.hypot(eye.x - v.ball.x, eye.z - v.ball.z) > DRAW;
      v.mesh.visible = v.shadow.visible = !far;
      if (!connected) v.synced = false;
      // Our kick not taken (too far by the server's reckoning, too soon): back to the server's ball.
      if (connected && v.synced && v.pendingQ && performance.now() > v.pendingUntil && v.last) {
        v.pendingQ = 0;
        this.fromServer(v.last, null, true);
      }
      if (far || (connected && !v.synced)) continue;
      const movers: Mover[] = me && prev ? [{ x0: prev.x, z0: prev.z, x1: me.x, z1: me.z, feet: me.feet, name: me.name }] : [];
      const before = this.tmp.set(v.ball.x, v.ball.y, v.ball.z);
      const events = stepBall(v.ball, v.pitch, dt, movers);
      this.hear(v, events, !connected);
      this.roll(v, before);
      v.corr.multiplyScalar(Math.exp(-dt / SETTLE));
      this.place(v);
    }
  }

  /** The server's state of a ball: taken, run on to now, the step to it smoothed. `again`: its last one, once more (no sounds). */
  fromServer(m: ServerBall, me: string | null, again = false): void {
    const v = this.views.find((x) => x.id === m.b);
    if (!v || !Array.isArray(m.p) || m.p.length !== 6 || !m.p.every((n) => typeof n === 'number' && Number.isFinite(n))) return;
    v.last = m;
    if (Array.isArray(m.sc) && m.sc.length === v.ball.score.length && m.sc.every((n) => Number.isInteger(n) && n >= 0)) v.ball.score = [...m.sc];
    // Our own kick not yet in it: older than it, so passed over (for a moment, in case the server refused it).
    if (v.synced && v.pendingQ && performance.now() < v.pendingUntil) {
      const taken = Array.isArray(m.k) && m.k.some((e) => Array.isArray(e) && e[0] === me && typeof e[1] === 'number' && e[1] >= v.pendingQ);
      if (!taken && m.r !== 1) return;
    }
    v.pendingQ = 0;
    const shown = new THREE.Vector3(v.ball.x, v.ball.y, v.ball.z).add(v.corr);
    const [x, y, z, vx, vy, vz] = m.p as number[];
    Object.assign(v.ball, { x, y, z, vx, vy, vz, asleep: m.s === 1, still: 0, netted: m.n === 1 ? 10 : 0 });
    // Someone else's kick: heard here.
    if (!again && Array.isArray(m.k) && m.k.some((e) => Array.isArray(e) && e[0] !== me)) thump(v.ball, Math.hypot(vx, vy, vz) / KICK.hard);
    // On to now: the state is as old as the server's clock says (the drawing clock runs `delay` behind it).
    const st = typeof m.st === 'number' ? m.st : NaN;
    const age = Number.isNaN(netClock.time) ? 0 : Math.min(0.3, Math.max(0, (netClock.time + netClock.delay - st) / 1000));
    for (let left = age; left > 1e-4 && !v.ball.asleep; left -= 1 / 60) stepBall(v.ball, v.pitch, Math.min(left, 1 / 60));
    v.corr.set(shown.x - v.ball.x, shown.y - v.ball.y, shown.z - v.ball.z);
    if (!v.synced || m.r === 1 || v.corr.length() > JUMP) v.corr.set(0, 0, 0);
    v.synced = true;
    this.place(v);
  }

  /** A goal the server saw. */
  goalFromServer(m: { b: unknown; g: unknown; by?: unknown; sc?: unknown }): void {
    const v = this.views.find((x) => x.id === m.b);
    if (!v || typeof m.g !== 'number' || !Number.isInteger(m.g) || m.g < 0 || m.g >= v.pitch.goals.length) return;
    const score = Array.isArray(m.sc) && m.sc.every((n) => Number.isInteger(n) && n >= 0) ? (m.sc as number[]) : v.ball.score;
    cheer(v.pitch.goals[m.g]);
    this.onGoal({ pitch: v.id, goal: m.g, by: typeof m.by === 'string' ? m.by : '', score });
  }

  /** Alone again (or together again): the balls go on from where they are. */
  reset(): void {
    for (const v of this.views) {
      v.synced = false;
      v.pendingQ = 0;
      v.last = null;
      v.corr.set(0, 0, 0);
    }
  }

  /** Dev build: every ball back in the middle. */
  home(): void {
    for (const v of this.views) {
      toHome(v.ball, v.pitch);
      v.corr.set(0, 0, 0);
      this.place(v);
    }
  }

  private hear(v: View, events: BallEvent[], alone: boolean): void {
    for (const e of events) {
      if (e.kind === 'bounce') bounce(v.ball, e.speed, !!e.post);
      else if (e.kind === 'goal' && alone) {
        cheer(v.pitch.goals[e.goal]);
        this.onGoal({ pitch: v.id, goal: e.goal, by: '', score: [...v.ball.score] });
      }
    }
  }

  /** Turn the ball as it rolls: about the axis across its way, by the distance over its radius. */
  private roll(v: View, before: THREE.Vector3): void {
    const dx = v.ball.x - before.x, dz = v.ball.z - before.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-5 || d > 2) return;
    const axis = new THREE.Vector3(dz / d, 0, -dx / d);
    v.spin.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, d / BALL.r)).normalize();
  }

  private place(v: View): void {
    const b = v.ball;
    v.mesh.position.set(b.x + v.corr.x, b.y + v.corr.y, b.z + v.corr.z);
    v.mesh.quaternion.copy(v.spin);
    const ground = v.pitch.ground(v.mesh.position.x, v.mesh.position.z);
    const up = Math.max(0, v.mesh.position.y - BALL.r - ground);
    const size = BALL.r * 2.6 * (1 + up * 0.5);
    v.shadow.position.set(v.mesh.position.x, ground + 0.02, v.mesh.position.z);
    v.shadow.scale.setScalar(size);
    (v.shadow.material as THREE.MeshBasicMaterial).opacity = 0.4 / (1 + up * 1.5);
  }
}

function noRay(o: THREE.Object3D): void {
  o.userData.ignoreRay = true;
  o.raycast = () => {};
}

/**
 * The ball: a sphere with twelve round black patches where an icosahedron's corners point, the rest
 * white, coloured per vertex (no texture, no logo). About 1,300 triangles.
 */
function ballGeometry(): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(BALL.r, 4).toNonIndexed();
  const corners = new THREE.IcosahedronGeometry(1, 0).toNonIndexed().getAttribute('position');
  const dirs: THREE.Vector3[] = [];
  for (let i = 0; i < corners.count; i++) {
    const d = new THREE.Vector3().fromBufferAttribute(corners, i).normalize();
    if (!dirs.some((e) => e.distanceTo(d) < 1e-3)) dirs.push(d);
  }
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let f = 0; f < pos.count; f += 3) {
    c.set(0, 0, 0);
    for (let k = 0; k < 3; k++) c.add(p.fromBufferAttribute(pos, f + k));
    c.normalize();
    const nearest = Math.max(...dirs.map((d) => d.dot(c)));
    const black = nearest > 0.93; // a patch about a fifth of the way to the next corner
    const v = black ? 0.06 : 0.92;
    for (let k = 0; k < 3; k++) colors.set([v, v, v], (f + k) * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

function shadowMaterial(): THREE.MeshBasicMaterial {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.MeshBasicMaterial({ color: '#000000', alphaMap: new THREE.CanvasTexture(c), transparent: true, opacity: 0.4, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
}

/**
 * A small goal as the school's model has it (tools/school.py): dark green square tubes, the crossbar, side
 * frames sloping back to a bar on the ground, and a net of thin pale cords. One mesh, coloured per vertex.
 */
function goalMesh(g: { mx: number; mz: number; nx: number; nz: number; ux: number; uz: number; half: number; height: number; depth: number; y: number }): THREE.Mesh {
  const parts: THREE.BufferGeometry[] = [];
  const at = (along: number, deep: number, y: number) => new THREE.Vector3(g.mx + g.ux * along + g.nx * deep, g.y + y, g.mz + g.uz * along + g.nz * deep);
  const green = new THREE.Color('#2d4b37');
  const cord = new THREE.Color('#d9dcd8');
  const beam = (a: THREE.Vector3, b: THREE.Vector3, w: number, colour: THREE.Color) => {
    const len = a.distanceTo(b);
    const box = new THREE.BoxGeometry(w, w, len);
    box.lookAt(b.clone().sub(a)); // the box's length along a-b
    box.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    const n = box.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([colour.r, colour.g, colour.b], i * 3);
    box.setAttribute('color', new THREE.BufferAttribute(col, 3));
    box.deleteAttribute('uv');
    parts.push(box);
  };
  const H = g.height, D = g.depth, W = g.half;
  for (const s of [-1, 1]) {
    beam(at(s * W, 0, -0.02), at(s * W, 0, H), 0.08, green);
    beam(at(s * W, 0, H), at(s * W, D, 0), 0.05, green);
    beam(at(s * W, 0, 0.02), at(s * W, D, 0.02), 0.05, green);
  }
  beam(at(-W - 0.04, 0, H), at(W + 0.04, 0, H), 0.08, green);
  beam(at(-W, D, 0.02), at(W, D, 0.02), 0.05, green);
  for (let k = 1; k < 10; k++) {
    const a = -W + (2 * W * k) / 10;
    beam(at(a, 0.02, H - 0.02), at(a, D, 0.03), 0.015, cord);
  }
  for (const y of [0.4, 0.8, 1.2]) {
    const d = D * (1 - y / H);
    beam(at(-W, d, y), at(W, d, y), 0.015, cord);
    for (const s of [-1, 1]) beam(at(s * W, 0, y), at(s * W, d, y), 0.015, cord); // the side nets
  }
  const mesh = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }));
  mesh.name = 'football_goal';
  return mesh;
}

// ---------------------------------------------------------------- sounds, made in code
/** A short burst of noise (s long), for the slap of leather. */
function noise(c: AudioContext, s: number): AudioBuffer {
  const buf = c.createBuffer(1, Math.max(1, Math.round(c.sampleRate * s)), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  return buf;
}

/** The kick: a low thump and the slap of the ball, louder for a harder kick (0 to 1). */
function thump(b: Ball, hard: number): void {
  const c = sound.context();
  const out = sound.at(b.x, b.y, b.z, 3);
  if (!c || !out) return;
  const t = c.currentTime;
  const loud = 0.25 + 0.5 * Math.min(1, hard);
  const osc = c.createOscillator();
  osc.frequency.setValueAtTime(150, t);
  osc.frequency.exponentialRampToValueAtTime(55, t + 0.12);
  const g = c.createGain();
  g.gain.setValueAtTime(loud, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + 0.18);
  const src = c.createBufferSource();
  src.buffer = noise(c, 0.04);
  const f = c.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = 1400;
  f.Q.value = 0.8;
  const g2 = c.createGain();
  g2.gain.value = loud * 0.8;
  src.connect(f).connect(g2).connect(out);
  src.start(t);
}

/** A bounce off the ground or a wall; off a post or the bar, the metal rings too. */
function bounce(b: Ball, speed: number, post: boolean): void {
  const c = sound.context();
  const out = sound.at(b.x, b.y, b.z, 3);
  if (!c || !out) return;
  const t = c.currentTime;
  const loud = Math.min(0.5, speed / 20);
  const osc = c.createOscillator();
  osc.frequency.setValueAtTime(120, t);
  osc.frequency.exponentialRampToValueAtTime(60, t + 0.08);
  const g = c.createGain();
  g.gain.setValueAtTime(loud, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + 0.12);
  if (!post) return;
  for (const [hz, k] of [[740, 1], [1910, 0.5], [3120, 0.25]]) {
    const ring = c.createOscillator();
    ring.frequency.value = hz;
    const rg = c.createGain();
    rg.gain.setValueAtTime(loud * 0.35 * k, t);
    rg.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    ring.connect(rg).connect(out);
    ring.start(t);
    ring.stop(t + 1);
  }
}

/**
 * A short cheer at the goal: a swell of voices (sawtooth tones through two vowel filters, each sliding up
 * and down at its own pitch, as children's "yaaay") over a hiss of claps, about a second and a half.
 */
function cheer(g: { mx: number; mz: number; y: number }): void {
  const c = sound.context();
  const out = sound.at(g.mx, g.y + 1.2, g.mz, 8);
  if (!c || !out) return;
  const t = c.currentTime;
  const bus = c.createGain();
  bus.gain.value = 0.5;
  bus.connect(out);
  for (let i = 0; i < 7; i++) {
    const start = t + Math.random() * 0.15;
    const f0 = 330 + Math.random() * 260;
    const osc = c.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f0, start);
    osc.frequency.linearRampToValueAtTime(f0 * 1.35, start + 0.25);
    osc.frequency.linearRampToValueAtTime(f0 * 1.1, start + 1.3);
    const vib = c.createOscillator();
    vib.frequency.value = 5 + Math.random() * 2;
    const vg = c.createGain();
    vg.gain.value = f0 * 0.02;
    vib.connect(vg).connect(osc.frequency);
    const g = c.createGain();
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(0.06, start + 0.12);
    g.gain.setValueAtTime(0.06, start + 0.8);
    g.gain.exponentialRampToValueAtTime(0.001, start + 1.5);
    for (const [hz, q] of [[800, 4], [1250, 5]]) {
      const f = c.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = hz * (0.9 + Math.random() * 0.2);
      f.Q.value = q;
      osc.connect(f).connect(g);
    }
    g.connect(bus);
    osc.start(start);
    vib.start(start);
    osc.stop(start + 1.6);
    vib.stop(start + 1.6);
  }
  // Claps: crackling noise, swelling and dying away.
  const src = c.createBufferSource();
  const buf = c.createBuffer(1, Math.round(c.sampleRate * 1.6), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() < 0.04 ? Math.random() * 2 - 1 : (Math.random() * 2 - 1) * 0.15;
  src.buffer = buf;
  const hp = c.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 900;
  const cg = c.createGain();
  cg.gain.setValueAtTime(0, t);
  cg.gain.linearRampToValueAtTime(0.35, t + 0.2);
  cg.gain.exponentialRampToValueAtTime(0.001, t + 1.6);
  src.connect(hp).connect(cg).connect(bus);
  src.start(t);
}
