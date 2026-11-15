import assert from 'node:assert/strict';
import test from 'node:test';

// A home's rooms may be named in Dutch with their English names in its pack (i18n.ts addInsideNames `en`). Two homes may
// have a room of the same Dutch name: the English name is the home's own, never another's.

globalThis.localStorage ??= { getItem: () => 'en', setItem: () => {}, removeItem: () => {} };
globalThis.document ??= { documentElement: { lang: 'en' }, querySelectorAll: () => [], dispatchEvent: () => true };
globalThis.CustomEvent ??= class extends Event {};
const { addInsideNames, placeName, setLang } = await import('./i18n.ts');

test("a room's English name is its own home's: the same Dutch name in another home stays as it is", () => {
  setLang('en');
  addInsideNames({ places: { 'Kamer Q': 'Kamer Q' } }); // a home whose rooms keep their names in both languages
  addInsideNames({ en: { 'Kamer Q': 'Room Q' } }, 'home_b');
  assert.equal(placeName('Kamer Q', 'home_b'), 'Room Q');
  assert.equal(placeName('Kamer Q', 'home_a'), 'Kamer Q', 'in the other home');
  assert.equal(placeName('Kamer Q'), 'Kamer Q', 'nowhere in particular');
  setLang('nl');
  assert.equal(placeName('Kamer Q', 'home_b'), 'Kamer Q', 'in Dutch: the Dutch name');
});
