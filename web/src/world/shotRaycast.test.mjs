import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as THREE from 'three';
const source = readFileSync(new URL('./shotRaycast.ts', import.meta.url), 'utf8').replace(/^import .*;\n/m, '').replaceAll('export ', '');
const { prepareShotMesh } = new Function('THREE', stripTypeScriptTypes(source) + '; return { prepareShotMesh };')(THREE);

test('indexed and non-indexed static map searches preserve every hit and surface detail', () => {
  for (const indexed of [true, false]) {
    const base = new THREE.BoxGeometry(20, 12, 30, 24, 16, 24);
    const geometry = indexed ? base : base.toNonIndexed();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.position.set(100, 8, -25);
    mesh.rotation.set(.2, .6, -.1);
    mesh.scale.set(1.5, .7, 2);
    mesh.updateMatrixWorld(true);
    const original = mesh.raycast;
    const rays = [];
    for (let i = 0; i < 50; i++) {
      const origin = new THREE.Vector3(70 + i * 1.3, 3 + i % 12, 50);
      const direction = new THREE.Vector3(100 + i % 15 - 7, 8, -25).sub(origin).normalize();
      const ray = new THREE.Raycaster(origin, direction, i % 3 ? 0 : 5, i % 4 ? 200 : 10);
      rays.push(ray);
    }
    const describe = (ray) => ray.intersectObject(mesh, false).map(h => ({
      distance: h.distance, point: h.point.toArray(), normal: h.normal.toArray(), uv: h.uv.toArray(),
      face: h.face, faceIndex: h.faceIndex, originalObject: h.object === mesh,
    })).sort((a, b) => a.distance - b.distance || a.faceIndex - b.faceIndex);
    const expected = rays.map(describe);
    assert.equal(prepareShotMesh(mesh), true);
    assert.notEqual(mesh.raycast, original);
    assert.deepEqual(rays.map(describe), expected);
    const fast = mesh.raycast;
    for (const [start, count] of [[60, 6000], [0, 0], [900, 12000], [0, Infinity]]) {
      geometry.setDrawRange(start, count);
      const actual = rays.map(describe);
      mesh.raycast = original;
      assert.deepEqual(rays.map(describe), actual);
      mesh.raycast = fast;
    }
    mesh.position.x += 3;
    mesh.updateMatrixWorld(true);
    const accelerated = rays.map(describe);
    mesh.raycast = original;
    assert.deepEqual(rays.map(describe), accelerated);
  }
});

test('animated, instanced and custom geometries keep their own raycasts', () => {
  const geometry = new THREE.BoxGeometry(1, 1, 1, 24, 24, 24);
  for (const mesh of [new THREE.SkinnedMesh(geometry), new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial(), 1)]) {
    const original = mesh.raycast;
    assert.equal(prepareShotMesh(mesh), false);
    assert.equal(mesh.raycast, original);
  }
  const mesh = new THREE.Mesh(geometry);
  mesh.raycast = () => {};
  assert.equal(prepareShotMesh(mesh), false);
});
