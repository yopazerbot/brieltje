import * as THREE from 'three';
import type { World } from './collision';
import type { Doors } from './doors';
import type { Glass } from './glass';
import type { DoorSpec, FixtureSpec, Prism } from './houseData';
import { loadWalkIn, type EndInside, type WalkIn } from './walkIn';
import { KEET_DOOR, makeKeet } from '../../shared/keet.mjs';

/**
 * The café at the church (In de Oude Keet, the name on its sign board): a house everyone walks into, without a code. It is
 * a walk-in as the private homes are (world/walkIn.ts), but public: its shell comes with the village, its rooms
 * (src/data/keet_rooms.json, tools/keet.py) are a chunk of their own, fetched and built in idle time once the game is
 * playing, never before its first frame (the church square, in sight of it, is where most players start). No lock, no
 * lining, no home: shared/keet.mjs keeps its door ids and pane numbers apart from every home's.
 *
 * Until the zombies follow players inside (package Z), its doors stay shut during a Zombies game at the church: the
 * server ignores them then (server/game.mjs keetClosed), and this page neither sends nor swings them.
 */

/** The ids of the café's doors (the shell's, then the rooms'), as they come. */
const ids = new Set<string>();

/** The café's walk-in, once the village's town model (world/townCentre.ts) is in: its `shut` meshes stand in from afar. */
export async function loadKeet(renderer: THREE.WebGLRenderer, town: THREE.Object3D | undefined, clock: () => number, prepare: (o: THREE.Object3D) => Promise<unknown>, viewer: () => THREE.Vector3): Promise<WalkIn | null> {
  if (!town) return null;
  const shell = (await import('../data/keet_shell.json')).default as { doors: { id: string }[] };
  for (const d of shell.doors) ids.add(d.id);
  return loadWalkIn(renderer, { id: 'keet', model: town, village: 'outline', open: () => true, clock, prepare, viewer }).catch(() => null);
}

interface RoomsFile {
  roomNames: string[];
  prisms: EndInside['prisms'];
  shapes: EndInside['parts'];
  pieces: FixtureSpec[];
  props: EndInside['props'];
  doors: DoorSpec[];
}

/**
 * The café's rooms, after `after` (the game playing) and in the browser's idle time: their walls, floors and doors go in,
 * their new meshes hidden until their shaders are compiled (`prepare`), so walking in never waits for a compile.
 * `done`: the rooms' names and their floors in the world (for what counts as indoors).
 */
export function keetRooms(keet: WalkIn, deps: { world: World; doors: Doors; glass: Glass; prepare: (o: THREE.Object3D) => Promise<unknown>; after: Promise<unknown>; done: (rooms: string[], floors: Prism[]) => void }): void {
  const idle = () => new Promise<void>((r) => ('requestIdleCallback' in window ? requestIdleCallback(() => r(), { timeout: 3000 }) : setTimeout(r, 300)));
  void deps.after.then(async () => {
    const [rooms, shell] = await Promise.all([import('../data/keet_rooms.json'), import('../data/keet_shell.json')]);
    const data = rooms.default as unknown as RoomsFile;
    await idle();
    const pack: EndInside = { rooms: data.roomNames, prisms: data.prisms, parts: data.shapes, fixtures: data.pieces, props: data.props, doors: data.doors };
    const before = new Set<THREE.Object3D>();
    const empty = new Set<THREE.Object3D>();
    keet.group.traverse((o) => {
      before.add(o);
      if ((o as THREE.Mesh).isMesh && !(o as THREE.Mesh).geometry.getAttribute('position')) empty.add(o);
    });
    keet.addInside(pack, deps.world, deps.doors, deps.glass);
    for (const d of data.doors) ids.add(d.id);
    // What is new to draw (the rooms' mesh, the inner doors): out of sight while its shaders compile on a stand-in.
    const fresh: THREE.Mesh[] = [];
    keet.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.visible && (empty.has(m) || !before.has(m))) fresh.push(m);
    });
    keet.group.updateMatrixWorld(true);
    const aside = new THREE.Group();
    for (const m of fresh) {
      m.visible = false;
      const proxy = new THREE.Mesh(m.geometry, m.material);
      proxy.matrixAutoUpdate = false;
      proxy.matrix.copy(m.matrixWorld);
      aside.add(proxy);
    }
    await deps.prepare(aside).catch(() => undefined);
    for (const m of fresh) m.visible = true;
    const keetData = makeKeet(shell.default, data);
    deps.done(data.roomNames, keetData.prisms.filter((p) => p.n) as unknown as Prism[]);
  }).catch(() => undefined); // no rooms: the café stays a lump with its doors and windows
}

/** Whether a door is the café's. */
export const isKeetDoor = (id: string): boolean => KEET_DOOR.test(id);

let held = false;
/**
 * Until package Z: during a Zombies game at the church (`shut`), the café's doors stay shut. As the game starts they shut
 * on this page too (alone there is no server to say so); the door prompt says why and sends nothing (main.ts).
 */
export function holdKeetShut(shut: boolean, doors: Doors): void {
  if (shut && !held) for (const id of ids) doors.set(id, false);
  held = shut;
}
