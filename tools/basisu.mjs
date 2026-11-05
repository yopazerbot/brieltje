// Runs the Basis Universal command-line encoder (basisu, built for WASI: tools/.bin/basisu/basisu_st.wasm)
// in Node's own WebAssembly runtime, so no native binary is needed. Used by tools/ktx2.py.
//
//   node tools/basisu.mjs <wasm> <folder> <basisu arguments...>
//
// The encoder sees only <folder> (as its working folder): its file arguments are relative to it.
import { readFileSync } from 'node:fs';
import { WASI } from 'node:wasi';

const [wasm, folder, ...args] = process.argv.slice(2);
if (!wasm || !folder) {
  console.error('usage: node tools/basisu.mjs <basisu_st.wasm> <folder> <basisu arguments...>');
  process.exit(2);
}
const wasi = new WASI({ version: 'preview1', args: ['basisu', ...args], env: {}, preopens: { '.': folder }, returnOnExit: true });
const instance = await WebAssembly.instantiate(await WebAssembly.compile(readFileSync(wasm)), wasi.getImportObject());
process.exitCode = wasi.start(instance);
