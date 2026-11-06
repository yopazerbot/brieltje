// The public repository holds no inside of the three locked homes. The files of the repository (git ls-files) are checked: no
// file of the old full data or of the tools that made it, no data file that holds a home's inside, and, where web/.private/ is
// there to say what the inside is, none of its door ids or room names in any data file. The prose and the code are scanned for the
// room names of the homes and for the words that give the source away (the last test), with a list of the uses that stay.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { endShell, HAVE_PRIVATE, inside, endInside, shell, SKIP } from './testData.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let files = null;
try {
  files = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
} catch {
  files = null;
}
const NO_GIT = files ? false : 'not a git checkout: nothing to list';
const PROSE = /^(README\.md|DECISIONS\.md|PROGRESS\.md|CONTRIBUTING\.md|AGENTS\.md|CLAUDE\.md|GEMINI\.md|docs\/)/;
const text = (f) => {
  try {
    return readFileSync(join(REPO, f), 'utf8');
  } catch {
    return null; // deleted in the working tree, or binary beyond reading
  }
};

test('no file of the old full data, of the inside, or of the tools that made them is tracked', { skip: NO_GIT }, () => {
  const names = new Set([
    'web/src/data/house.json', 'web/src/data/molenhoek_end_inside.json', 'web/shared/default_furniture.json',
    'data/extracted.json', 'data/house.manual.json',
    'tools/build_house.py', 'tools/furniture.py', 'tools/old_house.py', 'tools/molenhoek_end_inside.py', 'tools/house_split.py',
    'tools/private_extras.mjs', 'web/public/baked/house_baked.glb', 'web/public/baked/lightmap.webp', 'docs/screenshots/kitchen.webp',
  ]);
  const found = files.filter((f) => names.has(f));
  assert.deepEqual(found, []);
  assert.deepEqual(files.filter((f) => f.startsWith('web/.private/') || f.startsWith('private-src/') || f.startsWith('source/') || f.startsWith('images/')), []);
});

test('the data files hold no rooms or fixtures of a home', { skip: NO_GIT }, () => {
  for (const f of files.filter((n) => /^(web\/src\/data|web\/shared|data)\/[^/]+\.json$/.test(n))) {
    const s = text(f);
    if (s === null) continue;
    let json;
    try {
      json = JSON.parse(s);
    } catch {
      continue;
    }
    if (Array.isArray(json)) continue;
    for (const key of ['rooms', 'fixtures', 'parts', 'innerFace', 'roofPanels', 'replaces']) assert.equal(key in json, false, `${f} has "${key}"`);
  }
});

test('the sealed files are sealed: nothing under web/private/ but .enc files and the manifest', { skip: NO_GIT }, () => {
  const sealed = files.filter((f) => f.startsWith('web/private/'));
  assert.ok(sealed.length >= 1);
  for (const f of sealed) assert.match(f, /^web\/private\/([a-z0-9_.-]+\.enc|manifest\.json)$/, f);
  const sealedNames = sealed.filter((f) => f.endsWith('.enc')).map((f) => f.slice('web/private/'.length, -4)).sort();
  // The manifest says nothing of the plain data: names and the key id only, and every file is whole 16 KiB blocks plus the header.
  const manifest = JSON.parse(text('web/private/manifest.json'));
  for (const [name, entry] of Object.entries(manifest)) assert.deepEqual(Object.keys(entry), ['key'], name);
  for (const f of sealed.filter((n) => n.endsWith('.enc'))) assert.equal((readFileSync(join(REPO, f)).length - 64) % 16384, 0, `${f} is padded`);
  for (const name of ['extras.json', 'house_inside.json', 'molenhoek_end_inside.json']) {
    assert.ok(sealedNames.includes(name), `${name} is sealed`);
  }
});

test('none of the inside\'s door ids or names is in a tracked data or code file', { skip: NO_GIT || SKIP }, () => {
  const ids = new Set();
  const names = new Set();
  for (const home of [inside.house, inside.bungalow]) {
    home.doors.forEach((d) => ids.add(d.id));
    (home.rooms ?? []).forEach((r) => names.add(r.name));
    home.prisms.forEach((p) => p.n && !p.k && names.add(p.n));
  }
  endInside.doors.forEach((d) => ids.add(d.id));
  endInside.rooms.forEach((r) => names.add(r));
  for (const home of [inside.house, inside.bungalow]) for (const name of [...Object.keys(home.names?.places ?? {}), ...Object.keys(home.names?.doors ?? {})]) names.add(name);
  assert.ok(ids.size > 30 && names.size > 15, `${ids.size} ids, ${names.size} names`);
  // Names that are plain words the outside needs as well (a floor is a floor) are not an inside's.
  for (const common of ['ground floor', '1st floor', '2nd floor', 'Garden']) names.delete(common);
  for (const d of [...shell.doors, ...endShell.doors]) names.delete(d.name); // the names of outside doors are the shell's own
  const hits = [];
  for (const f of files) {
    if (f.startsWith('web/private/') || PROSE.test(f) || /\.(png|jpe?g|webp|ktx2|glb|gltf|hdr|woff2?|wasm|br|ico|svg|lock)$/.test(f) || f.endsWith('package-lock.json')) continue;
    const s = text(f);
    if (s === null) continue;
    for (const id of ids) if (s.includes(`"${id}"`) || s.includes(`'${id}'`)) hits.push(`${f}: door id ${id}`);
    if (/\.(json)$/.test(f)) {
      for (const n of names) if (s.includes(JSON.stringify(n))) hits.push(`${f}: name ${n}`);
    }
  }
  // Models (.glb): the names of their nodes, meshes and materials are not the inside's names or ids, and no model is the whole inside.
  for (const f of files.filter((n) => n.endsWith('.glb'))) {
    let buf;
    try {
      buf = readFileSync(join(REPO, f));
    } catch {
      continue;
    }
    if (buf.readUInt32LE(0) !== 0x46546c67) continue;
    const gltf = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8'));
    const used = [...(gltf.nodes ?? []), ...(gltf.meshes ?? []), ...(gltf.materials ?? [])].map((x) => x.name).filter(Boolean);
    for (const n of used) if (names.has(n) || ids.has(n)) hits.push(`${f}: model name ${n}`);
    const materials = new Set((gltf.materials ?? []).map((m) => m.name));
    for (const m of ['floor_wood', 'floor_bath', 'floor_tile', 'terrazzo', 'rust_tile', 'pink_tile']) if (materials.has(m)) hits.push(`${f}: inside-only material ${m}`);
  }
  assert.deepEqual(hits.slice(0, 10), []);
  assert.ok(HAVE_PRIVATE);
});

// Prose and code: no word of a home's inside (the rooms, the fittings) and no word that gives the source of the main house away.
// Every match on every line is checked. A match passes only when an entry of ALLOWED names its file, a short phrase of its line
// and the word, with the reason: an allowed word never hides another word on the same line. Singular "plan" and "drawing" are
// everyday words of the map and drawing code, so only "plans", "drawings" and "floor plan" are looked for.
const WORDS = [
  /keuken|kitchen|badkamer|bathroom|slaapkamer|bedroom|zithoek|living ?room|eetplaats|dining|speelruimte|playroom|nachthal|wasplaats|\binkom\b|\bberging\b|bergruimte|sanitair|zolder\w*|\battic\b|\boffice\b|\bbureau\b|jacuzzi|book ?wall|storeroom|laundry|cloakroom/gi,
  /architect|offerte|onedrive|kadast|perceel|extract_plan|compare_plans|house\.manual|extracted\.json|supplier|window maker|lighting plan|plan pdf|vector pdf|floor ?plans?\b|\bplans\b|\bdrawings\b|swing arc|reference sheet|site survey|walkthrough video|\brenders? of the house|\bquotes?\b/gi,
  /\bWC\b/g, // case-sensitive: `wc` is a variable name in the tools
];
const OPEN_DATA = /GRB|open data|village\.json|the survey, and the plans? |and the plans tools\/molenhoek\.py|the houses' plans|on those plans|village's plans|the plans: the/;
const SIGN_UP = /plans?\b|floor ?plans?|PDF/i;
const ALLOWED = [
  { file: /^web\/shared\/publicClean\.test\.mjs$/, why: 'this test names the words it looks for' },
  { file: /^web\/shared\/terrain\.json$/, words: /^WC$/, why: 'a base64 height grid: two letters by chance, not a word' },
  // the game's furniture catalogue: generic pieces
  { file: /^web\/shared\/furniture\.json$/, line: /"id": "(dining200|dining160|oval220|chair|officechair|bookwall|jacuzzi)"/, words: /dining|office|book ?wall|jacuzzi/i, why: 'catalogue entries: generic pieces' },
  { file: /^web\/src\/i18n\.ts$/, line: /dining200: 'Eettafel|desk: 'Bureau 140|officechair: 'Bureaustoel|desksetup: 'Bureau 180|bookwall: 'Boekenwand|kidsdesk: 'Laag bureau/, words: /dining|bureau|book ?wall|jacuzzi/i, why: 'Dutch names of catalogue pieces' },
  { file: /^web\/src\/spawn\.ts$/, line: /jacuzzi: \['bubbelbad'\]/, words: /^jacuzzi$/, why: 'a /name alias of a catalogue piece' },
  { file: /^web\/src\/world\/furnishing\.ts$/, line: /case 'bookwall'|case 'jacuzzi'|case 'dining200'|The dining chair:|\(the dining chair\)|office chair/, words: /dining|office|book ?wall|jacuzzi/i, why: 'drawing code of catalogue pieces' },
  { file: /^tools\/interior\.py$/, line: /dining chair/, words: /^dining$/i, why: 'the model of a catalogue chair' },
  { file: /^(docs\/(CODEMAP|CREDITS|DETAILS)\.md|tools\/aeron\.py|web\/src\/world\/screens\.ts)$/, line: /office chair|office screens/, words: /^office$/, why: 'the office chair model and the screens of the catalogue pieces' },
  { file: /^(DECISIONS|PROGRESS)\.md$/, line: /office chair|dining chairs?\b|dining chair's/, words: /^(office|dining)$/, why: 'catalogue pieces and their models' },
  { file: /^web\/server\.mjs$|^web\/public\/legal\/(legal\.js|privacy\.html|terms\.html)$/, line: /registered office|office/, words: /^office$/, why: 'the company\'s registered office on the legal pages' },
  { file: /^DECISIONS\.md$/, line: /the office on the east side|the office's name/, words: /^office$/, why: 'a neighbouring building on the church square' },
  { file: /^tools\/toilet\.py$/, line: /wall-hung WC/, words: /^WC$/, why: 'a model of a wall-hung toilet, built from catalogue sizes' },
  { file: /^tools\/homestreet\/houses\.py$/, line: /living room's three tall windows/, words: /living ?room/i, why: 'another house, the one in the street, not one of the three homes' },
  { file: /^tools\/town\/town\.py$/, line: /small attic or toilet window/, words: /^attic$/, why: 'a window kind of the village houses' },
  { file: /^DECISIONS\.md$/, line: /No washing line: Yoshi doesn't want laundry|with the laundry and the shadows/, words: /^laundry$/, why: 'washing in the garden, not a room' },
  // plans of open data (outlines of the land registry, church drawings of 1896)
  { file: /^(data\/[\w.]+\.json|tools\/[\w/]+\.py|tools\/town\/houses\.json|docs\/(CODEMAP|CREDITS)\.md|DECISIONS\.md|PROGRESS\.md)$/, line: OPEN_DATA, words: /^plans$/i, why: 'the outlines of the open data, called plans in the survey tools' },
  { file: /^(tools\/church\.py|DECISIONS\.md|PROGRESS\.md)$/, line: /drawings (for|of) |design drawings|1896 drawings|enlargement drawings/, words: /^drawings$/, why: 'the 1896 design drawings of the church (heritage archive)' },
  // the floor plan as the map view of a floor
  { file: /^(docs\/CODEMAP\.md|web\/src\/ui\/minimap\.ts|web\/src\/world\/houseData\.ts)$/, line: /floor plan/, words: /^floor plan$/i, why: '"floor plan" as the map view of a floor, about any building' },
  { file: /^web\/src\/ui\/minimap\.ts$/, line: /this\.plans|private plans = |join the plans/, words: /^plans$/, why: 'the minimap\'s level images' },
  { file: /^web\/src\/world\/sprites\.ts$/, line: /so the drawings look the same/, words: /^drawings$/, why: 'pictures drawn on a canvas' },
  { file: /^web\/src\/controls\/input\.ts$/, line: /'Quote'/, words: /^quote$/i, why: 'a key name' },
  // the sign-up page: neighbours may upload plans of their own home, with their consent
  { file: /^(web\/server\/(interest|store)\.mjs|web\/public\/(interested\/[\w.]+|admin\/admin\.js|legal\/(privacy|terms)\.html))$/, line: SIGN_UP, words: /^(plans|floor ?plans?)$/i, why: 'the sign-up page: neighbours\' own plans, with consent' },
  { file: /^(DECISIONS|PROGRESS)\.md$/, line: /sign-up|sign up|their home|their house|neighbours' own plans|Plans in a private|house plans 18|of a house needs|plans stay private|plans never|plans go to|deletes the plans|plans as five-minute|aren't plans|their plan|plan whose delete|its plans after|the plans (and|stay)/, words: /^plans$/i, why: 'the sign-up page: neighbours\' own plans, with consent' },
  { file: /^web\/public\/legal\/credits\.html$/, line: /Landbouwgebruikspercelen/, words: /^perceel$/i, why: 'the open data of farm land' },
];
test('no word of a home\'s inside or of the source of the main house is left in tracked prose or code', { skip: NO_GIT }, () => {
  const hits = [];
  const skip = /\.(png|jpe?g|webp|ktx2|glb|gltf|hdr|woff2?|wasm|br|ico|enc|lock|bin|mp3|ogg|wav|mp4|svg)$/;
  for (const f of files) {
    if (skip.test(f) || f.endsWith('package-lock.json')) continue;
    const s = text(f);
    if (s === null) continue;
    s.split('\n').forEach((line, i) => {
      for (const re of WORDS) {
        for (const m of line.matchAll(re)) {
          const ok = ALLOWED.some((a) => a.file.test(f) && (!a.line || a.line.test(line)) && (!a.words || a.words.test(m[0])));
          if (!ok) hits.push(`${f}:${i + 1}: ${m[0]}`);
        }
      }
    });
  }
  assert.deepEqual(hits.slice(0, 40), []);
});
