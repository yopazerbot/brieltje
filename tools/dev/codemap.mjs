// Writes docs/CODEMAP.md: one line per module in web/src, web/server (and web/server.mjs) and tools, taken from
// the first sentence of each file's opening comment or docstring. Run it after adding, moving or removing modules:
//
//   node tools/dev/codemap.mjs
//
// A module without an opening comment shows "(no description)": give it one rather than editing the map.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const CODE = /\.(ts|mjs|js|py)$/;
const SKIP = new Set(['node_modules', '__pycache__', '.venv', 'data', 'dist']);
// Lines written here instead of taken from the file: modules that open straight with code, and modules
// whose opening comment says more about the main house's private source files than the public map should.
const KNOWN = {
  'tools/extract_plan.py': "Builds the main house's starting layout (walls and openings) from the private source files.",
  'tools/compare_plans.py': "Compares the main house's walls with a newer set of private source files, to spot what changed.",
  'tools/furniture.py': "The main house's kitchen and bathroom fittings, built as solid blocks at their real sizes.",
  'web/src/player.ts': 'The player on foot: walking, sprinting, jumping, crouching and flying, with collision against the world.',
  'web/src/ui/feedback.ts': 'The feedback card: after two minutes of play, once per browser, 1 to 5 stars and an optional comment.',
  'web/src/world/collision.ts': 'The solid world for walking and shots: prisms, the relief and what each point stands on.',
  'web/src/world/doors.ts': 'Doors that open and close near the player, their leaves and the glass in them.',
  'web/src/world/shotRaycast.ts': 'A spatial index of the static map triangles, so a shot only tests the triangles near its line.',
};

function files(dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      if (SKIP.has(name)) return [];
      if (statSync(path).isDirectory()) return files(path);
      return CODE.test(name) && !name.endsWith('.d.ts') ? [path] : [];
    });
}

/** The opening comment's text: a docstring, a block comment, or the first run of line comments. */
function opening(text, python) {
  const body = text.replace(/^#!.*\n/, '');
  if (python) {
    const m = body.match(/^\s*(?:#[^\n]*\n\s*)*(?:[rbuRBU]{0,2})("""|''')([\s\S]*?)\1/);
    return m ? m[2] : '';
  }
  // Skip imports, then take the first comment (block or a run of // lines).
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && (/^\s*$/.test(lines[i]) || /^\s*(import|export \* from|export \{)/.test(lines[i]) || /^\s*[\w{},*\s]+from\s+['"]/.test(lines[i]) || /^\s*[}'"].*['"];?\s*$/.test(lines[i]))) i++;
  const rest = lines.slice(i).join('\n');
  const block = rest.match(/^\s*\/\*\*?([\s\S]*?)\*\//);
  if (block) return block[1].replace(/^\s*\* ?/gm, '');
  const run = [];
  for (const line of lines.slice(i)) {
    const m = line.match(/^\s*\/\/ ?(.*)$/);
    if (!m) break;
    run.push(m[1]);
  }
  return run.join('\n');
}

/** A later doc block, for a module whose description sits on its main class or function. */
function laterDoc(text) {
  const blocks = text.split('\n').slice(0, 80).join('\n').match(/\/\*\*[\s\S]*?\*\//g) ?? [];
  const long = blocks.map((c) => c.slice(3, -2).replace(/^\s*\* ?/gm, '')).find((c) => c.replace(/\s+/g, ' ').trim().length >= 40);
  return long ?? '';
}

/** A test file: what it tests, from its name and its first test. */
function testLine(rel, text) {
  const first = text.match(/\btest\(\s*['"`]([^'"`]+)/) ?? text.match(/def (test_\w+)/);
  const subject = rel.split('/').pop().replace(/^test_|\.test\.mjs$|\.py$/g, '');
  return `Tests for ${subject}${first ? `, e.g. "${first[1].replace(/^test_/, '').replace(/_/g, ' ')}"` : ''}.`;
}

function firstSentence(comment) {
  const text = comment
    .split(/\n\s*\n/)[0]
    .replace(/\s+/g, ' ')
    .replace(/`/g, '')
    .trim();
  const m = text.match(/^(.+?[.!?])(\s|$)/);
  let s = (m ? m[1] : text).trim();
  if (s.length > 160) s = `${s.slice(0, 157).replace(/\s+\S*$/, '')}...`;
  return s || '(no description)';
}

const groups = [
  ['web/src', files(join(ROOT, 'web', 'src'))],
  ['web/server', [join(ROOT, 'web', 'server.mjs'), ...files(join(ROOT, 'web', 'server'))]],
  ['tools', files(join(ROOT, 'tools'))],
];
const out = [
  '# Code map',
  '',
  'One line per module: where to look before you search. Made by `node tools/dev/codemap.mjs` from each',
  "file's opening comment; run it again after adding, moving or removing a module.",
  '',
];
for (const [title, list] of groups) {
  out.push(`## ${title}`, '');
  for (const path of list) {
    const rel = relative(ROOT, path).replaceAll('\\', '/');
    const text = readFileSync(path, 'utf8');
    let line = KNOWN[rel] ?? firstSentence(opening(text, path.endsWith('.py')));
    if (line === '(no description)') line = /(\.test\.mjs|\/test_\w+\.py)$/.test(rel) ? testLine(rel, text) : firstSentence(laterDoc(text));
    out.push(`- \`${rel}\`: ${line}`);
  }
  out.push('');
}
writeFileSync(join(ROOT, 'docs', 'CODEMAP.md'), out.join('\n'));
console.log(`docs/CODEMAP.md: ${groups.reduce((n, [, l]) => n + l.length, 0)} modules`);
