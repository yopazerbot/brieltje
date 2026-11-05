import * as THREE from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { addDiag } from '../ui/diag';

/**
 * The surface textures in web/public/textures, fetched in the form that costs the graphics chip least.
 *
 * Where the browser can transcode Basis Universal, each texture comes from textures/ktx2/ (tools/ktx2.py):
 * it stays compressed on the chip (BC7 on desktops, ETC2 or ASTC on phones and Apple), four to eight times
 * smaller than the WebP file decoded to plain pixels. Phones and tablets get the half-size copies
 * (textures/ktx2/half/, Yoshi's choice: about 5 MB to download instead of 19, and the sharpness they had).
 * Where it can't (no WebAssembly, no compressed format on the chip, a transcoder that doesn't start), or when
 * a KTX2 file fails to load or transcode, the WebP file is fetched instead: the full size on desktops, the
 * half size on phones and tablets (textures/half/, a quarter of the memory). Only one of the two is fetched
 * per texture, unless the KTX2 one failed. ?webp in the address skips the KTX2 files (to compare the two).
 *
 * The transcoder (web/public/basis/: basis_transcoder.js and .wasm, Basis Universal, Apache-2.0) is three's
 * copy from three/examples/jsm/libs/basis/, served from our origin, its script changed to run without eval
 * (see the top of that file). It runs in a worker made from a blob, which needs 'wasm-unsafe-eval' in the
 * page's script-src (server.mjs). A worker that fails to start never answers, so a tiny texture is
 * transcoded first: until it is back, nothing waits on the transcoder, and without it the WebP files load.
 *
 * Each texture is handed out at once, empty, and filled in when its file is in (as THREE.TextureLoader does),
 * so a material can take it straight away. Its picture in the KTX2 file is stored upside down (tools/ktx2.py
 * flips it), because a compressed texture can't be flipped on upload as a WebP one is: both look the same.
 */

const HALF = matchMedia('(pointer: coarse)').matches;
const WEBP = HALF ? '/textures/half' : '/textures';
const KTX2 = HALF ? '/textures/ktx2/half' : '/textures/ktx2';
const SKIP_KTX2 = new URLSearchParams(location.search).has('webp');
/**
 * How long the transcoder may take to start (fetch 0.27 MB, compile, first texture) before the WebP files are
 * used: a second or two on a phone; a connection too slow for 10 s is better off with the smaller WebP files.
 */
const START_LIMIT = 10000;
/** A 4 x 4 grey ETC1S texture (313 bytes, made with tools/basisu.mjs): the transcoder's first job. */
const PROBE =
  'q0tUWCAyMLsNChoKAAAAAAEAAAAEAAAABAAAAAAAAAAAAAAAAQAAAAEAAAABAAAAaAAAACwAAACUAAAAJAAAALgAAAAAAAAAgAAAAAAAAAA4AQAAAAAAAAEAAAAAAAAAAAAAAAAAAAAsAAAAAAAAAAIAKACjAQEAAwMAAAgAAAAAAAAAAAA/AAAAAAAAAAAA/////x8AAABLVFh3cml0ZXIAQmFzaXMgVW5pdmVyc2FsIDIuMTAAAAEAAQAoAAAABQAAACsAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAABwAQAAAAAAAACBJgIAAAAAABAUgQAEwAAAAAAAAgBYAJAAAAAAAAxVFVVVQUAwUQAAAAAAADyXy0AmAAAAAAAAEAIABMAAgAAAACIAcAEAAAAAAAAAggAAA==';

let ktx2: KTX2Loader | null | undefined; // undefined: not decided yet; null: WebP only
/** Whether the transcoder works: its first texture came back in time. */
let working: Promise<boolean> = Promise.resolve(false);
const stats = { ktx2: 0, webp: 0, fellBack: 0, bytes: 0, formats: new Set<string>(), note: '' };

/** Whether this page may compile WebAssembly: a tiny empty module, compiled on the spot. */
function wasmAllowed(): boolean {
  try {
    new WebAssembly.Module(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
    return true;
  } catch {
    return false; // no WebAssembly, or a content security policy without 'wasm-unsafe-eval'
  }
}

/** Transcode PROBE; true once it is back, false on an error or after START_LIMIT. */
function probe(l: KTX2Loader): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (ok: boolean, note = '') => {
      clearTimeout(timer);
      if (!ok) stats.note = note;
      resolve(ok);
    };
    const timer = setTimeout(() => done(false, 'transcoder did not start'), START_LIMIT);
    const bytes = Uint8Array.from(atob(PROBE), (c) => c.charCodeAt(0));
    l.parse(
      bytes.buffer,
      (t) => {
        t.dispose();
        done(true);
      },
      (e) => done(false, `transcoder failed: ${String(e)}`),
    );
  });
}

function loader(renderer: THREE.WebGLRenderer): KTX2Loader | null {
  if (ktx2 !== undefined) return ktx2;
  ktx2 = null;
  addDiag(() =>
    `textures: ${stats.ktx2} KTX2 (${[...stats.formats].join(', ') || '-'}), ${stats.webp} WebP${HALF ? ' half' : ''}` +
    `${stats.fellBack ? ` (${stats.fellBack} after a failed KTX2)` : ''} · ~${Math.round(stats.bytes / 1e6)} MB on the chip${stats.note ? ` · ${stats.note}` : ''}`,
  );
  if (SKIP_KTX2) return ktx2;
  if (typeof WebAssembly !== 'object' || !wasmAllowed()) {
    stats.note = 'no WebAssembly here';
    return ktx2;
  }
  const l = new KTX2Loader().setTranscoderPath('/basis/').detectSupport(renderer);
  const c = l.workerConfig;
  // Formats three can't upload as sRGB, which the colour maps need: ETC1 (three uploads it through the ETC2
  // extension), and BC1/BC3 without their sRGB extension.
  c.etc1Supported = false;
  c.dxtSupported &&= renderer.extensions.has('WEBGL_compressed_texture_s3tc_srgb');
  // Without a compressed format the transcoder would hand back plain pixels: the WebP file is smaller to fetch.
  if (!(c.astcSupported || c.bptcSupported || c.dxtSupported || c.etc2Supported)) {
    stats.note = 'no compressed texture format';
    l.dispose();
    return ktx2;
  }
  ktx2 = l;
  working = probe(l);
  return ktx2;
}

const FORMATS: Record<number, string> = {
  [THREE.RGBA_BPTC_Format]: 'BC7',
  [THREE.RGB_S3TC_DXT1_Format]: 'BC1',
  [THREE.RGBA_S3TC_DXT1_Format]: 'BC1',
  [THREE.RGBA_S3TC_DXT5_Format]: 'BC3',
  [THREE.RGB_ETC1_Format]: 'ETC1',
  [THREE.RGB_ETC2_Format]: 'ETC2',
  [THREE.RGBA_ETC2_EAC_Format]: 'ETC2+EAC',
  [THREE.RGBA_ASTC_4x4_Format]: 'ASTC 4x4',
  [THREE.RGB_PVRTC_4BPPV1_Format]: 'PVRTC',
  [THREE.RGBA_PVRTC_4BPPV1_Format]: 'PVRTC',
  [THREE.RGBAFormat]: 'RGBA8',
};

/** Make `t` the transcoded texture `c`: what a CompressedTexture is, on the object the materials already hold. */
function adopt(t: THREE.Texture, c: THREE.CompressedTexture): void {
  (t as THREE.Texture & { isCompressedTexture: boolean }).isCompressedTexture = true;
  t.image = c.image;
  t.mipmaps = c.mipmaps;
  t.format = c.format;
  t.type = c.type;
  t.minFilter = c.minFilter;
  t.magFilter = c.magFilter;
  t.generateMipmaps = false;
  t.flipY = false; // the file is stored flipped already
  t.premultiplyAlpha = c.premultiplyAlpha;
  // The colour space stays as set (sRGB for colour maps, none for the others); the file says the same.
  if (import.meta.env.DEV && (c.colorSpace === THREE.SRGBColorSpace) !== (t.colorSpace === THREE.SRGBColorSpace)) {
    console.warn(`textures: ${t.userData.src} has colour space ${c.colorSpace} in its KTX2 file, ${t.colorSpace} expected`);
  }
  t.needsUpdate = true;
  stats.ktx2++;
  stats.formats.add(FORMATS[c.format as number] ?? String(c.format));
  for (const m of c.mipmaps as { data: ArrayBufferView }[]) stats.bytes += m.data.byteLength;
}

/**
 * The texture web/public/textures/<name>.webp (`name` without the extension), or its KTX2 copy, as above.
 * `color`: a colour map (sRGB); otherwise a normal or roughness map (no colour space). Counts as one item of
 * THREE.DefaultLoadingManager until its picture is in, so the game's "textures ready" waits for transcoding.
 */
export function loadTexture(name: string, color: boolean, renderer: THREE.WebGLRenderer): THREE.Texture {
  const { texture } = loadFile(`${KTX2}/${name}.ktx2`, `${WEBP}/${name}.webp`, color, renderer, { flipY: true, counted: true });
  // The full-size WebP file, whichever form is fetched: tools/still/export_scene.js hands it to Blender.
  texture.userData.src = `/textures/${name}.webp`;
  return texture;
}

/** Whether this is a phone or tablet, which gets the half-size files (here and in world/bakedLight.ts). */
export const halfSize = HALF;

/**
 * Any texture with a KTX2 file and a WebP file of the same picture (the baked light's pages, world/bakedLight.ts):
 * the KTX2 one where it can be transcoded, the WebP one otherwise. `flipY`: how the WebP file is uploaded (true,
 * as THREE.TextureLoader does, for files whose KTX2 copy is stored flipped; false for files laid out as glTF's
 * UVs, whose KTX2 copy isn't). `counted`: an item of THREE.DefaultLoadingManager until its picture is in.
 * `ready` resolves once the picture is in (true) or both files failed (false).
 */
export function loadFile(
  ktx2Url: string,
  webpUrl: string,
  color: boolean,
  renderer: THREE.WebGLRenderer,
  { flipY, counted = false }: { flipY: boolean; counted?: boolean },
): { texture: THREE.Texture; ready: Promise<boolean> } {
  const t = new THREE.Texture();
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  const manager = THREE.DefaultLoadingManager;
  const item = `texture:${webpUrl}`;
  if (counted) manager.itemStart(item);
  let settle: (ok: boolean) => void = () => {};
  const ready = new Promise<boolean>((r) => (settle = r));
  const finish = (ok: boolean) => {
    if (counted) {
      if (!ok) manager.itemError(item);
      manager.itemEnd(item);
    }
    settle(ok);
  };
  const webp = () => {
    new THREE.ImageLoader().load(
      webpUrl,
      (image) => {
        t.image = image;
        t.flipY = flipY;
        t.needsUpdate = true;
        stats.webp++;
        stats.bytes += (image.width * image.height * 4 * 4) / 3;
        finish(true);
      },
      undefined,
      () => finish(false),
    );
  };
  const fellBack = (why: unknown) => {
    console.warn(`textures: ${ktx2Url} failed, fetching the WebP file instead`, why);
    stats.fellBack++;
    webp();
  };
  const l = loader(renderer);
  if (!l) {
    webp();
    return { texture: t, ready };
  }
  // The file is fetched while the transcoder starts; it is transcoded once the transcoder has shown it works.
  new THREE.FileLoader().setResponseType('arraybuffer').load(
    ktx2Url,
    (buffer) => {
      void working.then((ok) => {
        if (!ok) {
          webp(); // the transcoder doesn't work here (counted once, in stats.note)
          return;
        }
        l.parse(
          buffer as ArrayBuffer,
          (c) => {
            adopt(t, c);
            finish(true);
          },
          fellBack,
        );
      });
    },
    undefined,
    fellBack,
  );
  return { texture: t, ready };
}
