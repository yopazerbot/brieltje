// Every Zombies place (shared/arenas.mjs) is in each of the page's place menus, and every portal under "Start at":
// the menus in index.html are written out by hand, so a new place must not be missed in one of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ARENAS } from './arenas.mjs';
import { PORTALS } from './portals.mjs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const options = (id) => {
  const from = html.indexOf(`<select id="${id}"`);
  assert.ok(from >= 0, `no menu #${id}`);
  const block = html.slice(from, html.indexOf('</select>', from));
  return new Set([...block.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]));
};

test('every Zombies place is in the solo, room and admin menus', () => {
  for (const menu of ['zombies-place', 'room-place', 'zombies-place-admin']) {
    const have = options(menu);
    for (const a of ARENAS) assert.ok(have.has(a.id), `${a.id} missing from #${menu}`);
  }
});

test('every portal is a choice under "Start at"', () => {
  const have = options('spawn');
  for (const p of PORTALS) assert.ok(have.has(p.id), `${p.id} missing from #spawn`);
});
