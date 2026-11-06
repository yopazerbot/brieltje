import * as THREE from 'three';
import { registerDoors } from '../../shared/homes.mjs';
import { addInsideNames } from '../i18n';
import type { BigMap } from '../ui/bigmap';
import type { Minimap } from '../ui/minimap';
import type { World } from './collision';
import type { Doors } from './doors';
import { buildFixtures } from './furnishing';
import type { Glass } from './glass';
import type { HomeLocks } from './homeLocks';
import type { DoorSpec, FixtureSpec, PropSpec, Prism, Room } from './houseData';
import { buildHouseMeshes } from './houseMeshes';
import { loadProps } from './props';
import type { EndInside, WalkIn } from './walkIn';

/**
 * A home's inside, as the game server hands it out (server/homes.mjs: the answer to the right code, or GET /api/home/:id/inside
 * for a session that has the right): the walls, floors, rooms, doors, built-in furniture and fixed models, and the names of the
 * rooms and doors. The repository holds none of it. Until the pack comes, the page has only the shell (src/data/house_shell.json):
 * from outside the homes look the same, and nothing of their inside is drawn, walked in or hit.
 */
export interface InsidePack {
  id: string;
  prisms: Prism[];
  rooms?: Room[];
  doors: DoorSpec[];
  fixtures: FixtureSpec[];
  props: PropSpec[];
  /** The bungalow's upright roof panels, per roof (the roof's number in the shell's surroundings) */
  panels?: { roof: number; panels: { a: [number, number]; b: [number, number]; y0: number; ya: number; yb: number }[] }[];
  names?: { places?: Record<string, string>; doors?: Record<string, string> };
  /** Keys of shell blocks that this pack's own blocks stand in for (a slab with a stairwell for a solid one) */
  replaces?: string[];
  /** The starting pieces of furniture in this home ([item, x, y, z, yaw]) and the layout's restore number, for playing alone */
  furniture?: [string, number, number, number, number][];
  layoutRestore?: number;
}

export interface InsideDeps {
  renderer: THREE.WebGLRenderer;
  /** The group the house is drawn in (hidden from far off) */
  home: THREE.Group;
  scene: THREE.Scene;
  world: World;
  doors: Doors;
  glass: Glass;
  locks: HomeLocks;
  minimap: Minimap;
  bigMap: BigMap;
  /** The shell's keyed blocks as meshes of their own, hidden once an inside replaces them */
  keyed: Map<string, THREE.Object3D>;
  /** The roofs of the surroundings (for the colour under a roof panel) */
  roofs: { ceiling?: string }[];
  /** The end house, once the village has loaded it */
  endHouse: () => WalkIn | null;
  /** An inside has been installed (main.ts: indoors tests, the room names, the starting furniture alone) */
  installed: (pack: InsidePack) => void;
}

/** Installs insides on the page, once for each home. */
export class Insides {
  private packs = new Map<string, InsidePack | EndInside & { id: string }>();
  private asked = new Set<string>();
  private pendingEnd: (EndInside & { id: string }) | null = null;
  private endDone = false;

  constructor(private deps: InsideDeps) {}

  /** The packs of the main house and the bungalow that are installed. */
  private houses(): InsidePack[] {
    return ['house', 'bungalow'].flatMap((id) => (this.packs.has(id) ? [this.packs.get(id) as InsidePack] : []));
  }

  /** The blocks of the installed insides of the main house and the bungalow. */
  prisms(): Prism[] {
    return this.houses().flatMap((p) => p.prisms);
  }

  /** The shell's blocks, the installed insides' in place of the ones they replace: for the zombies alone. */
  housePrisms(shell: Prism[]): Prism[] {
    const gone = new Set(this.houses().flatMap((p) => p.replaces ?? []));
    return [...shell.filter((p) => !(p.k && gone.has(p.k))), ...this.prisms()];
  }

  houseDoors(shell: DoorSpec[]): DoorSpec[] {
    return [...shell, ...this.houses().flatMap((p) => p.doors)];
  }

  rooms(): Room[] {
    return this.houses().flatMap((p) => p.rooms ?? []);
  }

  /** The starting furniture of the installed homes. */
  layout(): { id: string; layoutRestore: number; pieces: [string, number, number, number, number][] }[] {
    return this.houses().map((p) => ({ id: p.id, layoutRestore: p.layoutRestore ?? 0, pieces: p.furniture ?? [] }));
  }

  /** Home `id` is open to this page: install the pack it came with, or fetch it (the session has the right, or is the admin's). */
  async open(id: string, pack: unknown): Promise<void> {
    if (this.packs.has(id)) return;
    let got = pack as InsidePack | null;
    if (!got) {
      if (this.asked.has(id)) return;
      this.asked.add(id);
      try {
        const r = await fetch(`/api/home/${id}/inside`, { credentials: 'same-origin' });
        if (!r.ok) {
          this.asked.delete(id); // not yet (the right may still be on its way): the next welcome asks again
          return;
        }
        got = (await r.json()) as InsidePack;
      } catch {
        this.asked.delete(id);
        return;
      }
    }
    if (!got || got.id !== id || !Array.isArray(got.doors)) return;
    this.install(got);
  }

  /** The village has loaded the end house: its inside goes in if it came before. */
  endReady(): void {
    this.endDone = true;
    if (this.pendingEnd) this.installEnd(this.pendingEnd);
    this.pendingEnd = null;
  }

  private install(pack: InsidePack): void {
    if (pack.id === 'molenhoek_end') {
      this.packs.set(pack.id, pack as unknown as EndInside & { id: string });
      if (this.endDone) this.installEnd(pack as unknown as EndInside & { id: string });
      else this.pendingEnd = pack as unknown as EndInside & { id: string };
      this.deps.installed(pack);
      return;
    }
    const d = this.deps;
    this.packs.set(pack.id, pack);
    registerDoors(pack.id, pack.doors.map((door) => door.id));
    const built = buildHouseMeshes(pack.prisms, d.renderer);
    d.home.add(built.group);
    d.world.addPrisms(pack.prisms);
    d.world.replaceKeyed(pack.replaces ?? []);
    for (const k of pack.replaces ?? []) {
      const mesh = d.keyed.get(k);
      if (mesh) mesh.visible = false;
    }
    d.glass.add(built.panes, (i, gone) => d.world.setPane(i, !gone));
    d.glass.add(d.doors.add(pack.doors, d.doors.group), (i, gone) => d.doors.setBroken(i, gone));
    d.locks.addData(pack.prisms, pack.doors);
    const fixtures = buildFixtures(pack.fixtures, d.world, `${pack.id}-`);
    if (fixtures) d.home.add(fixtures);
    loadProps(pack.props, d.scene, d.world, `${pack.id}-`);
    const panels = roofPanels(pack.panels ?? [], d.roofs);
    if (panels) d.home.add(panels);
    addInsideNames(pack.names);
    d.minimap.addInside(pack.prisms, pack.rooms ?? []);
    d.bigMap.addInside(pack.rooms ?? []);
    d.installed(pack);
  }

  private installEnd(pack: EndInside & { id: string }): void {
    const end = this.deps.endHouse();
    if (!end) return;
    end.addInside(pack, this.deps.world, this.deps.doors, this.deps.glass);
  }
}

/** The bungalow's upright roof panels under the roof, in the colour of the roof's underside. */
function roofPanels(list: NonNullable<InsidePack['panels']>, roofs: { ceiling?: string }[]): THREE.Object3D | null {
  const group = new THREE.Group();
  for (const { roof, panels } of list) {
    const pos: number[] = [];
    for (const q of panels) {
      const v = [new THREE.Vector3(q.a[0], q.y0, q.a[1]), new THREE.Vector3(q.b[0], q.y0, q.b[1]), new THREE.Vector3(q.b[0], q.yb, q.b[1]), new THREE.Vector3(q.a[0], q.ya, q.a[1])];
      pos.push(...v[0].toArray(), ...v[1].toArray(), ...v[2].toArray(), ...v[0].toArray(), ...v[2].toArray(), ...v[3].toArray());
    }
    if (!pos.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: roofs[roof]?.ceiling ?? '#e8e4dc', roughness: 0.9, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group.children.length ? group : null;
}
