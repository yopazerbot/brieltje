import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';
import { defineConfig, type Plugin } from 'vite';

/**
 * Files worth compressing; images are compressed already. So are the KTX2 textures (brotli takes
 * 0.1 % off them); the texture transcoder's .wasm goes from 527 to 204 KB.
 */
const PACK = /\.(js|css|html|json|svg|txt|hdr|glb|wasm)$/;

/**
 * After the build, a brotli copy (.br) next to every file it shrinks by at least a tenth.
 * server.mjs sends that copy to browsers that accept it: the sky photo goes from 5.5 to
 * 2.9 MB, the character model from 1.6 to 0.25 MB.
 */
function brotli(): Plugin {
  let out = 'dist';
  return {
    name: 'brotli',
    apply: 'build',
    configResolved(config) {
      out = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
      for (const file of walk(out)) {
        if (!PACK.test(file)) continue;
        const raw = readFileSync(file);
        const packed = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
        if (packed.length < raw.length * 0.9) writeFileSync(`${file}.br`, packed);
      }
    },
  };
}

export default defineConfig({
  plugins: [brotli()],
  server: {
    port: 5173,
    // Multiplayer and login go to the Node server (npm start) on port 8080.
    proxy: {
      // Keep the browser's Host header: the server checks it against Origin.
      '/api': { target: `http://localhost:${process.env.API_PORT || 8080}`, changeOrigin: false },
      '/ws': { target: `ws://localhost:${process.env.API_PORT || 8080}`, ws: true, changeOrigin: false },
    },
  },
});
