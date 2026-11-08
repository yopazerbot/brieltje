// What a shot's ray may stop on (world/rayShown.ts drawn): the hit boxes are invisible on purpose and must still be
// hit. In f1b7261 every invisible material was skipped, and every shot went through the zombies, players, clowns
// and cats.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as THREE from 'three';

const load = (file, names) => {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replaceAll('export ', '');
  return new Function('THREE', `${stripTypeScriptTypes(source)}; return { ${names} };`)(THREE);
};
const { drawn, swappedMaterials } = load('./rayShown.ts', 'drawn, swappedMaterials');
const { hitBoxMaterial } = load('./hitBox.ts', 'hitBoxMaterial');
const box = new THREE.BoxGeometry(1, 1, 1);

test('a hit box is drawn for a shot, though it is never shown', () => {
  assert.equal(hitBoxMaterial.visible, false);
  assert.equal(hitBoxMaterial.userData.hitBox, true);
  assert.equal(drawn(new THREE.Mesh(box, hitBoxMaterial)), true);
  assert.equal(drawn(new THREE.Mesh(box, new THREE.MeshBasicMaterial({ visible: false }))), true);
});

test('a hidden object is not drawn', () => {
  const mesh = new THREE.Mesh(box, hitBoxMaterial);
  mesh.visible = false;
  assert.equal(drawn(mesh), false);
  assert.equal(drawn(new THREE.Object3D()), true); // no material: only its own visible counts
});

test('a tree version not shown is not drawn, the one shown is', () => {
  const cards = new THREE.MeshStandardMaterial();
  const crowns = new THREE.MeshStandardMaterial();
  swappedMaterials.add(cards);
  swappedMaterials.add(crowns);
  cards.visible = false;
  assert.equal(drawn(new THREE.Mesh(box, cards)), false);
  assert.equal(drawn(new THREE.Mesh(box, crowns)), true);
});

test('a mesh with several materials is not drawn only when all of them are a hidden tree version', () => {
  const a = new THREE.MeshStandardMaterial({ visible: false });
  const b = new THREE.MeshStandardMaterial({ visible: false });
  swappedMaterials.add(a);
  swappedMaterials.add(b);
  assert.equal(drawn(new THREE.Mesh(box, [a, b])), false);
  b.visible = true;
  assert.equal(drawn(new THREE.Mesh(box, [a, b])), true);
  b.visible = false;
  assert.equal(drawn(new THREE.Mesh(box, [a, hitBoxMaterial])), true); // a hit box among them still counts
});
