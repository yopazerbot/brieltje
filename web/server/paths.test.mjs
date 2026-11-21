import assert from 'node:assert/strict';
import test from 'node:test';
import { decodePath, namesFile } from './paths.mjs';

test('a request path with a broken %-escape is no file: null (the server answers 400, without a log line)', () => {
  for (const p of ['/%', '/%zz', '/a%2', '/%E0%A4%A', '/%C0', '/assets/%']) assert.equal(decodePath(p), null, p);
  assert.equal(decodePath('/assets/a%20b.js'), '/assets/a b.js');
  assert.equal(decodePath('/interested/'), '/interested/');
  assert.equal(decodePath('/%2e%2e/secret'), '/../secret', 'decoded as before: serveFile still refuses a path out of dist');
});

test('a path that names a file gets 404 when the file is not there, a page of the app gets the app', () => {
  for (const p of ['/assets/townCentre-Cxyq-Vle.js', '/assets/', '/assets/x', '/models/town.glb', '/baked/town_0.ktx2', '/favicon.ico', '/wp-login.php', '/admin/hall.js', '/a/b/c.JSON', '/.env'])
    assert.equal(namesFile(p), true, p);
  for (const p of ['/', '/interested', '/interested/', '/play', '/admin/scores/', '/v1.2/', '/some.folder/page', '/trailing.', '/name.with-a-very-long-ending'])
    assert.equal(namesFile(p), false, p);
});
