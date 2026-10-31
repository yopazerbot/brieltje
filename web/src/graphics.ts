import * as THREE from 'three';

/**
 * Graphics quality presets and automatic selection.
 *
 * "Auto" looks at the graphics chip, then times a few test frames of the
 * real scene while the start screen is up, and picks the best preset that
 * still runs at about 60 frames per second. If play later turns out slower
 * (for example a hot laptop), Auto steps down one preset.
 */

export type Quality = 'low' | 'medium' | 'high' | 'ultra';
export type Mode = Quality | 'auto';

export interface Preset {
  label: string;
  /** Render resolution relative to the window (1 = full) */
  scale: number;
  /** Soft shadows in corners (ambient occlusion) */
  ao: 'off' | 'half' | 'full';
  /** Sun shadow detail; 0 switches sun shadows off */
  shadowMap: 0 | 1024 | 2048 | 4096;
  /** Edge smoothing */
  smaa: boolean;
  /** Sharpness of textures seen at an angle */
  anisotropy: number;
  /** Baked lighting for the house (cheaper, with bounced light) instead of real-time lighting */
  baked: boolean;
  /**
   * Draw distance in metres: a tile of the surroundings further than this is hidden. 725 m is
   * where the haze hides about 85%; Low stops at 550 m (about 66%), a phone at 450 m (FAR_PHONE).
   */
  far: number;
}

export const PRESETS: Record<Quality, Preset> = {
  low: { label: 'Low', scale: 0.55, ao: 'off', shadowMap: 1024, smaa: false, anisotropy: 1, baked: false, far: 550 },
  medium: { label: 'Medium', scale: 0.8, ao: 'off', shadowMap: 2048, smaa: true, anisotropy: 2, baked: false, far: 725 },
  high: { label: 'High', scale: 1, ao: 'half', shadowMap: 2048, smaa: true, anisotropy: 4, baked: false, far: 725 },
  ultra: { label: 'Ultra', scale: 1, ao: 'full', shadowMap: 4096, smaa: true, anisotropy: 8, baked: false, far: 725 },
};
/** A phone or tablet's draw distance, whatever the preset. */
export const FAR_PHONE = 450;
export const ORDER: Quality[] = ['low', 'medium', 'high', 'ultra'];

const BUDGET_MS = 14; // test frames must fit in this to count as "60 fps with room to spare"

/** The graphics chip's name, when the browser shares it. */
export function gpuName(renderer: THREE.WebGLRenderer): string {
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const raw = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  // "ANGLE (AMD, AMD Radeon(TM) Graphics (0x000013C0) Direct3D11 ...)" -> "AMD Radeon(TM) Graphics"
  const m = raw.match(/ANGLE \([^,]*,\s*([^,(]+(?:\([^)]*\))?[^,(]*)/);
  return (m ? m[1] : raw).replace(/\s+Direct3D.*$/, '').trim();
}

/** A first guess from the chip's name, used to choose where testing starts. */
export function guessFromName(name: string): Quality {
  const n = name.toLowerCase();
  if (/swiftshader|llvmpipe|software|basic render/.test(n)) return 'low';
  if (/rtx|radeon rx|rx \d{4}|geforce gtx 1[0-9]{3}|arc a\d|apple m\d (pro|max|ultra)/.test(n)) return 'ultra';
  if (/apple m\d|geforce|quadro|radeon pro/.test(n)) return 'high';
  if (/iris|radeon\(tm\) \d{3}m|780m|760m|680m|660m/.test(n)) return 'medium';
  return 'medium'; // other integrated graphics
}

/** Time one frame of rendering, waiting until the graphics chip is really done. */
export function timeFrames(render: () => void, gl: WebGL2RenderingContext | WebGLRenderingContext, frames: number): number {
  const px = new Uint8Array(4);
  render(); // warm-up: shaders compile on the first frame
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    render();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  }
  return (performance.now() - t0) / frames;
}

/**
 * Pick the best preset by testing. Starts at the guess from the chip's name,
 * then moves up while there is room, or down while it is too slow.
 * `measure` applies a preset and returns milliseconds per frame.
 */
export async function pickQuality(guess: Quality, measure: (q: Quality) => number): Promise<{ quality: Quality; ms: number }> {
  let i = ORDER.indexOf(guess);
  let ms = measure(ORDER[i]);
  if (ms <= BUDGET_MS) {
    while (i < ORDER.length - 1) {
      await new Promise((r) => setTimeout(r, 0)); // keep the page responsive between tests
      const next = measure(ORDER[i + 1]);
      if (next > BUDGET_MS) break;
      i++;
      ms = next;
    }
  } else {
    while (i > 0 && ms > BUDGET_MS) {
      await new Promise((r) => setTimeout(r, 0));
      i--;
      ms = measure(ORDER[i]);
    }
  }
  return { quality: ORDER[i], ms };
}

const KEY = 'briel.graphics';

export function loadMode(): Mode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'auto' || (v && v in PRESETS)) return v as Mode;
  } catch {
    // storage blocked: fall back to Auto
  }
  return 'auto';
}

export function saveMode(mode: Mode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // ignore: the choice then lasts for this visit only
  }
}
