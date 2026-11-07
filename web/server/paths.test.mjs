import assert from 'node:assert/strict';
import test from 'node:test';
import { decodePath } from './paths.mjs';

test('a request path with a broken %-escape is no file: null (the server answers 400, without a log line)', () => {
  for (const p of ['/%', '/%zz', '/a%2', '/%E0%A4%A', '/%C0', '/assets/%']) assert.equal(decodePath(p), null, p);
  assert.equal(decodePath('/assets/a%20b.js'), '/assets/a b.js');
  assert.equal(decodePath('/interested/'), '/interested/');
  assert.equal(decodePath('/%2e%2e/secret'), '/../secret', 'decoded as before: serveFile still refuses a path out of dist');
});
