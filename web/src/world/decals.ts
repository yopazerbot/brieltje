import * as THREE from 'three';
import { HOLE, holeSheet } from './sprites';

/**
 * Bullet holes and scorch marks: small squares laid on a surface, cut from
 * one sheet with a look per surface (chipped plaster, splintered wood, a
 * dented ring on metal, cracked tiles, earth). All marks on the house are one
 * instanced draw call; the oldest makes room for the newest. Marks on a door
 * or the car are separate meshes on it, so they swing or drive off with it.
 */

const MAX = 96;
const COLS = 3;
const ROWS = 2;

/** Which look a surface's bullet hole gets (material name -> sheet cell). */
const LOOK: Record<string, number> = {
  steel: HOLE.metal, rail: HOLE.metal, alu: HOLE.metal, alu_out: HOLE.metal, alu_in: HOLE.metal, brass: HOLE.metal, mirror: HOLE.metal, black_glass: HOLE.metal,
  oak: HOLE.wood, walnut: HOLE.wood, floor_wood: HOLE.wood, stair: HOLE.wood, cladding: HOLE.wood, old_wood: HOLE.wood,
  grass: HOLE.earth, hedge: HOLE.earth, nb_hedge: HOLE.earth, fence: HOLE.metal,
  floor_tile: HOLE.tile, terrazzo: HOLE.tile, ceramic: HOLE.tile, rust_tile: HOLE.tile, pink_tile: HOLE.tile, floor_bath: HOLE.tile, stone: HOLE.tile, old_floor: HOLE.tile, nb_roof: HOLE.tile,
};

/** Offset of a cell in the sheet (texture coordinates, bottom-left of the cell). */
function cellOffset(cell: number): [number, number] {
  return [(cell % COLS) / COLS, 1 - (Math.floor(cell / COLS) + 1) / ROWS];
}

export class Decals {
  readonly mesh: THREE.InstancedMesh;
  private next = 0;
  private cells: THREE.InstancedBufferAttribute;
  private loose: THREE.Mesh[] = [];
  private looseMat: THREE.MeshStandardMaterial;
  private looseGeo = new Map<number, THREE.PlaneGeometry>();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private z = new THREE.Vector3(0, 0, 1);
  private v = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    const map = holeSheet();
    const common = { map, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, roughness: 0.95 };
    const material = new THREE.MeshStandardMaterial(common);
    // Each mark picks its cell of the sheet through a per-instance offset.
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aCell;')
        .replace('#include <uv_vertex>', `#include <uv_vertex>\nvMapUv = vMapUv * vec2(${(1 / COLS).toFixed(6)}, ${(1 / ROWS).toFixed(6)}) + aCell;`);
    };
    const geo = new THREE.PlaneGeometry(1, 1);
    this.cells = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 2), 2).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aCell', this.cells);
    this.mesh = new THREE.InstancedMesh(geo, material, MAX);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.userData.ignoreRay = true;
    this.mesh.raycast = () => {};
    scene.add(this.mesh);
    this.looseMat = new THREE.MeshStandardMaterial(common);
  }

  /** The look for a surface material. */
  static look(material: string): number {
    return LOOK[material] ?? HOLE.plaster;
  }

  /**
   * A mark at `point` on a surface facing `normal`, `size` metres across. On a door or
   * the car (`on` is one of their meshes) it becomes a child of that mesh instead.
   */
  add(point: THREE.Vector3, normal: THREE.Vector3, cell: number, size: number, on?: THREE.Object3D): void {
    this.q.setFromUnitVectors(this.z, normal);
    this.q.multiply(new THREE.Quaternion().setFromAxisAngle(this.z, Math.random() * Math.PI * 2));
    this.v.copy(point).addScaledVector(normal, 0.003);
    if (on?.userData.door || on?.userData.vehicle) {
      const mesh = new THREE.Mesh(this.geometry(cell), this.looseMat);
      mesh.position.copy(this.v);
      mesh.quaternion.copy(this.q);
      mesh.scale.setScalar(size);
      mesh.userData.ignoreRay = true;
      on.attach(mesh);
      this.loose.push(mesh);
      if (this.loose.length > 20) this.loose.shift()?.removeFromParent();
      return;
    }
    const i = this.next;
    this.next = (this.next + 1) % MAX;
    this.mesh.count = Math.max(this.mesh.count, i + 1);
    this.m.compose(this.v, this.q, new THREE.Vector3(size, size, size));
    this.mesh.setMatrixAt(i, this.m);
    this.cells.setXY(i, ...cellOffset(cell));
    this.mesh.instanceMatrix.needsUpdate = true;
    this.cells.needsUpdate = true;
  }

  /** A square with its texture coordinates on one cell (for marks on doors). */
  private geometry(cell: number): THREE.PlaneGeometry {
    let g = this.looseGeo.get(cell);
    if (!g) {
      g = new THREE.PlaneGeometry(1, 1);
      const uv = g.attributes.uv;
      const [u0, v0] = cellOffset(cell);
      for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) / COLS, v0 + uv.getY(i) / ROWS);
      this.looseGeo.set(cell, g);
    }
    return g;
  }
}
