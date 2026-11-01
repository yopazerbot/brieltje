import * as THREE from 'three';
import { Bells } from './bells';
import type { World } from './collision';
import { house } from './houseData';
import { buildRoadside } from './roadside';
import { terrain } from './terrain';
import type { Tiles } from './tiles';
import { Traffic, type Obstacle, type OtherCar } from './traffic';

/**
 * Life along the roads: the traffic and the parked cars (traffic.ts), the plates, signs, letterboxes
 * and bikes along the streets (roadside.ts), and the church bells (bells.ts). Their data
 * (web/src/data/roads.json, 73 KB, from tools/roads.py) and the cars' models come once the village
 * is in; the bells ring from the start.
 *
 * On Low and on phones (a shorter draw distance) parked cars are drawn within 130 m instead of
 * 200 m, without the soft shadows under them, and every car in full only within 45 m (60 m).
 */
export class RoadLife {
  readonly group = new THREE.Group();
  readonly traffic: Traffic;
  readonly bells: Bells;
  private loading: Promise<void> | null = null;

  /** `groundAt`: the ground or paving at a spot (main.ts's groundY). */
  constructor(world: World, private tiles: Tiles, private groundAt: (x: number, z: number) => number) {
    // The road's top: 2 cm over the relief.
    this.traffic = new Traffic(world, groundAt, (x, z) => house.ground + terrain.height(x, z) + 0.02);
    this.group.add(this.traffic.group);
    // The belfry: the tower's louvred openings (game y 19.2 to 20.8, measured on the church model), on
    // the church's north-east corner.
    this.bells = new Bells(new THREE.Vector3(534.5, 20.0, -734.95));
  }

  /** Line up with the server's clock (ms since 1970): the cars and the bells. */
  setClock(serverMs: number): void {
    this.traffic.setClock(serverMs);
    this.bells.setClock(serverMs);
  }

  /**
   * Once, when the village is in (its pavings carry the parked cars). The traffic and the new roadside
   * pieces stay out of the scene until `prepare` has compiled their shaders (in the background where the
   * browser can: main.ts precompile), so the first car that comes into view doesn't stall a frame.
   */
  load(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera,
    prepare: (o: THREE.Object3D) => Promise<unknown> = (o) => renderer.compileAsync(o, camera, scene)): Promise<void> {
    return (this.loading ??= (async () => {
      const data = (await import('../data/roads.json')).default as unknown as Parameters<typeof buildRoadside>[0] & Parameters<Traffic['load']>[0];
      const home = this.group.parent;
      const aside = new THREE.Group();
      aside.add(this.group);
      const before = new Set(this.tiles.group.children);
      buildRoadside(data, this.tiles, this.groundAt);
      const fresh = this.tiles.group.children.filter((o) => !before.has(o));
      aside.add(...fresh);
      await this.traffic.load(data);
      await prepare(aside).catch(() => undefined);
      this.tiles.group.add(...fresh);
      home?.add(this.group);
    })());
  }

  /** Every frame. `obstacles`: the players (you among them); `cars`: the players' cars. */
  update(dt: number, eye: THREE.Vector3, obstacles: Obstacle[], cars: OtherCar[]): void {
    const low = this.tiles.drawDistance < 700;
    this.traffic.reach = low ? 130 : 200;
    this.traffic.near = low ? 45 : 60;
    this.traffic.shadows = !low;
    this.traffic.update(dt, eye, obstacles, cars, this.tiles.drawDistance);
    this.bells.update(eye);
  }
}
