/**
 * A smooth start (Yoshi, 14 Nov 2026: "take a bit longer to load but have a smooth start instead"). What used to come
 * in during the first seconds of play (the village from the house, the villagers, the leaf cards' pictures, the shot
 * index, the map's village, the gardens' and the countryside's life) is in before the start screen goes, and then a few
 * frames are drawn behind it from where play begins: the shader programs' first use and the textures' uploads are paid
 * there, unseen. main.ts says what to wait for and which views to draw; this module waits, paces and counts.
 */
import type * as THREE from 'three';

/** Before play a job works this long between pauses (the bar and the start screen go on in the pauses). */
const FLAT_MS = 50;
/** After play: this much a frame, and nothing in a frame that follows one longer than LONG_MS (see `long`). */
const SLICE_MS = 2;
const LONG_MS = 18;
/** A warm-up view is done once nothing new comes and two frames in a row take under QUICK_MS; at most MAX_FRAMES. */
const QUICK_MS = 20;
const MAX_FRAMES = 12;

let begun = false;
/** The last frame's length (ms) and the usual one, from the page's own frames; kept once play has begun and a job asks */
let gap = 0;
let usual = 1000 / 60;
let lastFrame = 0;
let ticking = false;
function tick(t: number): void {
  gap = lastFrame ? t - lastFrame : 0;
  lastFrame = t;
  if (gap > 0 && gap < 250) usual += (gap - usual) * 0.05;
  requestAnimationFrame(tick);
}
/** A long frame: over LONG_MS, or where every frame is longer (a slow phone), well over the usual one. */
const long = () => gap <= 0 || gap > (usual < LONG_MS ? LONG_MS : usual * 1.3);

/** Play has begun: from now on the jobs that are left work a little a frame (pace). */
export function playBegins(): void {
  begun = true;
}

/**
 * Waits for the next slice of a job and says how long it may work (ms). Before play: at once, FLAT_MS. After play:
 * after a frame is drawn, SLICE_MS, and never just after a long frame. The jobs that take it: the shot index
 * (world/shotRaycast.ts), the leaf cards' pictures (world/leafCards.ts), the map's village (ui/bigmap.ts).
 */
export async function pace(): Promise<number> {
  if (!begun) {
    await new Promise((r) => setTimeout(r, 0));
    return FLAT_MS;
  }
  if (!ticking) {
    ticking = true;
    requestAnimationFrame(tick);
  }
  for (;;) {
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    if (!long()) return SLICE_MS;
  }
}

/**
 * Waits for every job (a job that fails counts as done; its own code says so), or until `until` (the page's clock, ms):
 * then play begins and the jobs left go on. `show` gets the share done (0 to 1), which creeps on between jobs so the
 * bar never stands still.
 */
export async function gather(jobs: (Promise<unknown> | null | undefined)[], until: number, show: (share: number) => void): Promise<void> {
  const all = jobs.filter((j): j is Promise<unknown> => !!j);
  let done = 0;
  let shown = 0;
  const step = () => {
    // Towards the next job's share, never past it.
    const next = Math.min(1, (done + 0.9) / Math.max(1, all.length));
    shown = Math.max(shown, done / Math.max(1, all.length));
    shown += (next - shown) * 0.06;
    show(shown);
  };
  const creep = setInterval(step, 100);
  try {
    await Promise.race([
      Promise.all(all.map((j) => j.catch(() => undefined).then(() => {
        done++;
        step();
      }))),
      new Promise((r) => setTimeout(r, Math.max(0, until - performance.now()))),
    ]);
  } finally {
    clearInterval(creep);
  }
}

/**
 * The warm-up frames behind the start screen. The frame loop (main.ts) asks `place` for the camera each frame on the
 * start screen and, while a view is being warmed, has `draw` draw it; `frames` goes through the views.
 */
export class StartWarm {
  /** Puts the player and the camera where the view being warmed looks from; null when none */
  private view: (() => void) | null = null;
  private began = 0;
  private drawn: ((ms: number) => void) | null = null;
  private px = new Uint8Array(4);

  /** Being drawn now, or held until play (hold): the villagers and the like come out for it (main.ts). */
  get on(): boolean {
    return this.view !== null;
  }

  /**
   * After the warm-up, until play begins: the camera where play begins (`view`), not drawn. Back at the start screen's
   * view for those last frames, everything placed round the eye (the tiles, the grass, what is shown near) went back
   * to the house and was placed again in the first frame of play, and things near the house went into its shadow.
   */
  hold(view: (() => void) | null): void {
    this.view = view;
    this.drawn = null;
  }

  /** The frame loop on the start screen: the camera for this frame, the view being warmed or else `still` (the start screen's). */
  place(still: () => void): void {
    this.began = performance.now();
    (this.view ?? still)();
  }

  /** The frame loop on the start screen, after everything is placed: draws the view being warmed, and waits for the chip. */
  draw(render: () => void, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (!this.view || !this.drawn) return;
    render();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.px);
    this.drawn(performance.now() - this.began);
  }

  /**
   * Draws each view until no new shader program or texture comes, two frames in a row take under QUICK_MS and `busy`
   * (the glass's probe in the middle of its views) is over; MAX_FRAMES at most. Stops at `until` (the page's clock).
   * `step` is told how many views are done.
   */
  async frames(views: (() => void)[], info: THREE.WebGLInfo, busy: () => boolean, until: number, step: (done: number) => void): Promise<{ frames: number; ms: number }> {
    const t0 = performance.now();
    let count = 0;
    // No frame drawn by then (a hidden page draws none): play begins all the same.
    let timer = 0;
    const late = new Promise<null>((r) => (timer = window.setTimeout(() => r(null), Math.max(0, until - t0))));
    try {
      for (let i = 0; i < views.length && performance.now() < until; i++) {
        this.view = views[i];
        let programs = -1;
        let textures = -1;
        let quick = 0;
        for (let n = 0; n < MAX_FRAMES; n++) {
          const ms = await Promise.race([new Promise<number>((r) => (this.drawn = r)), late]);
          if (ms === null) return { frames: count, ms: performance.now() - t0 };
          count++;
          const p = info.programs?.length ?? 0;
          const grew = p !== programs || info.memory.textures !== textures;
          programs = p;
          textures = info.memory.textures;
          quick = ms < QUICK_MS ? quick + 1 : 0;
          if (!grew && quick >= 2 && !busy()) break;
          if (performance.now() >= until) break;
        }
        step(i + 1);
      }
    } finally {
      clearTimeout(timer);
      this.view = null;
      this.drawn = null;
    }
    return { frames: count, ms: performance.now() - t0 };
  }
}
