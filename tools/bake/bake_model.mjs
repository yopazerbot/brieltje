// Bake the light of one building model again, in one command, from a running dev server (the steps of
// docs/DETAILS.md "Baked light and wear" for a single model):
//
//   node tools/bake/bake_model.mjs church [--url http://localhost:5200/] [--port 9800] [--work <folder>] [--samples 512]
//        [--into <folder>: instead of web/public/baked, for a trial]
//        [--blender "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe"] [--python tools/.venv/Scripts/python.exe]
//
// 1. The page (headless, tools/dev/cdp.mjs) loads the village; the helicopters are hidden (they come and go: their
//    shadow must not be baked onto a roof), and every other model's light layout notes are taken off in that page, so
//    the other models are only shade and bounce and only this model's pages are baked; then tools/bake/export_scene.js
//    runs there and its two files land in <work>/in.
// 2. tools/bake/bake_buildings.py in Blender, at a low priority (the PC is shared), into <work>/passes.
// 3. tools/bake/encode_buildings.py into <work>/out, and this model's files (its .json, its pages and their wear, full
//    size and half/) are copied into web/public/baked. The other models' files are not touched.
// Run tools/bake/lightmap_uv.py <model> first if the model was built again. <work> is a temp folder by default.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { setPriority, constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, options, startGame } from '../dev/cdp.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const o = options({ url: 'http://localhost:5200/', port: '9800', work: '', samples: '512', into: '', blender: 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe', python: join(ROOT, 'tools/.venv/Scripts/python.exe') });
const model = o._[0];
if (!model || !/^[a-z0-9_]+$/.test(model)) throw new Error('usage: node tools/bake/bake_model.mjs <model> [options]');
const work = o.work || mkdtempSync(join(tmpdir(), `bake-${model}-`));
const dirs = { in: join(work, 'in'), passes: join(work, 'passes'), out: join(work, 'out') };
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
console.log(`baking ${model} in ${work}`);

// 1. The export.
const b = await launch({ port: Number(o.port), width: 1280, height: 720, downloads: dirs.in });
try {
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('briel.graphics','high');localStorage.setItem('briel.feedback','later');" });
  await startGame(b, o.url, { village: true });
  await b.sleep(3000);
  const kept = await b.evaluate(`(() => {
    briel.helis.group.visible = false;
    let off = 0, kept = 0;
    briel.three.scene.traverse((o) => { if (o.userData.lmModel === ${JSON.stringify(model)}) kept++; else if (o.userData.lmModel) { delete o.userData.lmModel; off++; } });
    return { kept, off };
  })()`);
  if (!kept.kept) throw new Error(`no mesh of ${model} with a light layout in the page (run tools/bake/lightmap_uv.py ${model})`);
  console.log(`export: ${kept.kept} meshes of ${model}, ${kept.off} of other models as shade only`);
  console.log(JSON.stringify(await b.evaluate(readFileSync(join(ROOT, 'tools/bake/export_scene.js'), 'utf8'))));
  for (let i = 0; i < 180 && !['bake_scene.glb', 'bake_info.json'].every((f) => existsSync(join(dirs.in, f))); i++) await b.sleep(1000);
  await b.sleep(3000); // the download finishes writing
} finally {
  b.close();
}

/** A program run to its end, its output passed through; at a low priority for `low`. */
function run(cmd, args, low = false) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit' });
    if (low) try { setPriority(p.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
  });
}

// 2. The bake, 3. the textures, and this model's files into the game.
await run(o.blender, ['-b', '-P', join(ROOT, 'tools/bake/bake_buildings.py'), '--', dirs.in, dirs.passes, o.samples], true);
await run(o.python, [join(ROOT, 'tools/bake/encode_buildings.py'), dirs.passes, dirs.out]);
const dst = o.into || join(ROOT, 'web/public/baked');
const mine = new RegExp(`^${model}(\\.json|_\\d+(_wear)?\\.(webp|ktx2))$`);
let n = 0;
for (const sub of ['', 'half']) {
  mkdirSync(join(dst, sub), { recursive: true });
  for (const f of readdirSync(join(dirs.out, sub))) {
    if (!mine.test(f)) continue;
    copyFileSync(join(dirs.out, sub, f), join(dst, sub, f));
    n++;
  }
}
console.log(`${n} files of ${model} copied into ${dst}`);
