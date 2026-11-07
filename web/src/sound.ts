import type * as THREE from 'three';

/**
 * Sound on/off and volume, remembered in this browser. One shared audio
 * context; everything plays through one master volume. Sounds from other
 * players come from where they are (3D, quieter with distance), heard from
 * the camera. No three.js at run time: the start screen's Sound button uses
 * this before the world (and three.js) has loaded (src/start.ts).
 *
 * The room's echo (world/acoustics.ts) hangs on the master volume: a send into a
 * convolver, so every sound gets it without knowing. Sounds from out of doors go
 * through `outside()` (or are placed outdoors with `at`), which muffles them while
 * you are inside.
 */

const KEY = 'briel.sound';
let enabled = true;
try {
  enabled = localStorage.getItem(KEY) !== 'off';
} catch {
  // storage blocked: sound stays on
}
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let outdoors: GainNode | null = null; // out-of-doors sounds, into `walls`
let walls: BiquadFilterNode | null = null; // the walls and windows between them and you: a lowpass, open outside
/** The echoes now playing: the newest fades in, the ones before it fade out and are let go. */
let echoes: { send: GainNode; conv: ConvolverNode; level: number }[] = [];
/** world/acoustics.ts: whether a spot is inside a building (a sound from there is not muffled). */
let indoorSpot: ((x: number, y: number, z: number) => boolean) | null = null;
let volume = 0.8;
const pos = { x: 0, y: 0, z: 0 };
const fwd = { x: 0, y: 0, z: 0 };
const up = { x: 0, y: 0, z: 0 };
/** `v` set to (x, y, z) made one long. */
function unit(v: { x: number; y: number; z: number }, x: number, y: number, z: number): void {
  const n = Math.hypot(x, y, z) || 1;
  v.x = x / n;
  v.y = y / n;
  v.z = z / n;
}

export const sound = {
  get enabled(): boolean {
    return enabled;
  },
  set(on: boolean): void {
    enabled = on;
    try {
      localStorage.setItem(KEY, on ? 'on' : 'off');
    } catch {
      // ignore
    }
    if (ctx) void (on ? ctx.resume() : ctx.suspend());
  },
  /** The audio context, or null when sound is off. */
  context(): AudioContext | null {
    if (!enabled) return null;
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
      walls = ctx.createBiquadFilter();
      walls.type = 'lowpass';
      walls.frequency.value = 20000;
      walls.Q.value = 0.5;
      outdoors = ctx.createGain();
      outdoors.connect(walls).connect(master);
    }
    return ctx;
  },
  /** Where sounds without a place go (your own gun, your steps): the master volume. */
  out(): AudioNode | null {
    return this.context() ? master : null;
  },
  /** Where sounds of out of doors without a place go (the wind, the rain): muffled while you are inside. */
  outside(): AudioNode | null {
    return this.context() ? outdoors : null;
  },
  /** world/acoustics.ts: the test `at` uses to tell a sound inside a building from one out of doors. */
  setIndoorSpot(test: ((x: number, y: number, z: number) => boolean) | null): void {
    indoorSpot = test;
  },
  /**
   * world/acoustics.ts: how much the walls take off the out-of-doors sounds, 0 (outside) to 1 (deep inside),
   * over about half a second.
   */
  muffle(amount: number): void {
    if (!ctx || !walls || !outdoors) return;
    const t = ctx.currentTime;
    walls.frequency.setTargetAtTime(20000 * Math.pow(600 / 20000, amount), t, 0.15);
    outdoors.gain.setTargetAtTime(1 - 0.5 * amount, t, 0.15);
  },
  /**
   * world/acoustics.ts: the room's echo, `ir` its impulse response (null: none) at `level`, crossfaded from the one
   * before over `fade` seconds. The send is mono (one convolution per channel of `ir`, cheap on phones).
   */
  echo(ir: AudioBuffer | null, level: number, fade = 0.5): void {
    if (!ctx || !master) return;
    const c = ctx;
    const t = c.currentTime;
    for (const e of echoes) {
      e.send.gain.cancelScheduledValues(t);
      e.send.gain.setValueAtTime(e.send.gain.value, t);
      e.send.gain.linearRampToValueAtTime(0, t + fade);
      // Let it go once its tail has rung out.
      const tail = e.conv.buffer?.duration ?? 0;
      const gone = e;
      setTimeout(() => {
        gone.send.disconnect();
        gone.conv.disconnect();
      }, (fade + tail + 0.2) * 1000);
    }
    echoes = [];
    if (!ir || level <= 0) return;
    const send = c.createGain();
    send.channelCount = 1;
    send.channelCountMode = 'explicit';
    send.channelInterpretation = 'speakers';
    send.gain.setValueAtTime(0, t);
    send.gain.linearRampToValueAtTime(level, t + fade);
    const conv = c.createConvolver();
    conv.normalize = true;
    conv.buffer = ir;
    master.connect(send).connect(conv).connect(c.destination);
    echoes.push({ send, conv, level });
  },
  /** Dev build: the echo's send now (0 when none) and its impulse response, for checking the graph headless. */
  echoState(): { wet: number; channels: number; seconds: number } {
    const ir = echoes[0]?.conv.buffer;
    return { wet: echoes.reduce((s, e) => s + e.send.gain.value, 0), channels: ir?.numberOfChannels ?? 0, seconds: ir?.duration ?? 0 };
  },
  /** Dev build: the cutoff of the walls' lowpass now (Hz). */
  wallsCutoff(): number {
    return walls?.frequency.value ?? 20000;
  },
  /**
   * A spot in the world: connect a sound into it to hear it from there. `ref` is the distance at full volume. A spot
   * out of doors (world/acoustics.ts tells) is heard through the walls while you are inside.
   */
  at(x: number, y: number, z: number, ref = 2): AudioNode | null {
    const c = this.context();
    if (!c || !master || !outdoors) return null;
    const p = c.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.rolloffFactor = 1.1;
    p.maxDistance = 120;
    p.positionX.value = x;
    p.positionY.value = y;
    p.positionZ.value = z;
    p.connect(indoorSpot && !indoorSpot(x, y, z) ? outdoors : master);
    return p;
  },
  setVolume(v: number): void {
    volume = v;
    if (master) master.gain.value = v;
  },
  /** The ears follow the camera; call once per frame. */
  listen(camera: THREE.Camera): void {
    if (!ctx) return;
    const l = ctx.listener;
    // Where the camera is, which way it looks (its -z) and its up (+y), from its world matrix.
    camera.updateWorldMatrix(true, false);
    const e = camera.matrixWorld.elements;
    pos.x = e[12];
    pos.y = e[13];
    pos.z = e[14];
    unit(fwd, -e[8], -e[9], -e[10]);
    unit(up, e[4], e[5], e[6]);
    if (l.positionX) {
      l.positionX.value = pos.x;
      l.positionY.value = pos.y;
      l.positionZ.value = pos.z;
      l.forwardX.value = fwd.x;
      l.forwardY.value = fwd.y;
      l.forwardZ.value = fwd.z;
      l.upX.value = up.x;
      l.upY.value = up.y;
      l.upZ.value = up.z;
    } else {
      // Firefox
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  },
};
