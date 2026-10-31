import type * as THREE from 'three';

/**
 * Sound on/off and volume, remembered in this browser. One shared audio
 * context; everything plays through one master volume. Sounds from other
 * players come from where they are (3D, quieter with distance), heard from
 * the camera. No three.js at run time: the start screen's Sound button uses
 * this before the world (and three.js) has loaded (src/start.ts).
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
    }
    return ctx;
  },
  /** Where sounds without a place go (your own gun, your steps): the master volume. */
  out(): AudioNode | null {
    return this.context() ? master : null;
  },
  /** A spot in the world: connect a sound into it to hear it from there. `ref` is the distance at full volume. */
  at(x: number, y: number, z: number, ref = 2): AudioNode | null {
    const c = this.context();
    if (!c || !master) return null;
    const p = c.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.rolloffFactor = 1.1;
    p.maxDistance = 120;
    p.positionX.value = x;
    p.positionY.value = y;
    p.positionZ.value = z;
    p.connect(master);
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
