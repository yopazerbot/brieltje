import * as THREE from 'three';
import type { World } from './collision';
import type { Doors } from './doors';
import type { Glass } from './glass';
import { groundLayers, RANK } from './groundLayers';
import type { Prism } from './houseData';
import { loadWalkIn, type EndInside, type WalkIn } from './walkIn';
import { KEET_DOOR, makeKeet, PUBLIC_WALK_INS, type KeetDoor } from '../../shared/keet.mjs';

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
/** The café's window panes' numbers (shared/keet.mjs), once its shell is in. */
const panes = new Set<number>();
/** Whether pane `i` is one of the café's: public, it breaks alone as together (main.ts glass.locked). */
export const isKeetPane = (i: number): boolean => panes.has(i);

/** The café's walk-in, once the village's town model (world/townCentre.ts) is in: its `shut` meshes stand in from afar. */
export async function loadKeet(renderer: THREE.WebGLRenderer, town: THREE.Object3D | undefined, clock: () => number, prepare: (o: THREE.Object3D) => Promise<unknown>, viewer: () => THREE.Vector3): Promise<WalkIn | null> {
  if (!town) return null;
  const shell = (await import('../data/keet_shell.json')).default as unknown as { doors: { id: string }[]; outline: [number, number][]; panes: unknown[] };
  for (const d of shell.doors) ids.add(d.id);
  openings = makeKeet(shell, { rooms: [], prisms: [], parts: [], fixtures: [], props: [], doors: [] }).doors;
  shell.panes.forEach((_, i) => panes.add(PUBLIC_WALK_INS.keet.glass + i));
  // Its outline claimed as a model's ground (world/groundLayers.ts), before the village's covers and the streets in detail
  // are cut: the lane's and the back street's surfaces that reached under the house (on the relief, which rises above the
  // floor at the back) give way to its floors, as under the homes' plots. Called before main.ts claims the models' ground.
  const [a, b, c, d] = shell.outline;
  const group = groundLayers.group();
  groundLayers.claim([a, b, c], RANK.model, group);
  groundLayers.claim([a, c, d], RANK.model, group);
  return loadWalkIn(renderer, { id: 'keet', model: town, village: 'outline', open: () => true, clock, prepare, viewer }).catch(() => null);
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
    const pack = rooms.default as unknown as EndInside; // as a home's pack, public (tools/keet.py)
    await idle();
    const before = new Set<THREE.Object3D>();
    const empty = new Set<THREE.Object3D>();
    keet.group.traverse((o) => {
      before.add(o);
      if ((o as THREE.Mesh).isMesh && !(o as THREE.Mesh).geometry.getAttribute('position')) empty.add(o);
    });
    keet.addInside(pack, deps.world, deps.doors, deps.glass);
    for (const d of pack.doors) ids.add(d.id);
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
    const keetData = makeKeet(shell.default, pack);
    openings = keetData.doors;
    deps.done(pack.rooms, keetData.prisms.filter((p) => p.n) as unknown as Prism[]);
  }).catch(() => undefined); // no rooms: the café stays a lump with its doors and windows
}

/** Whether a door is the café's. */
export const isKeetDoor = (id: string): boolean => KEET_DOOR.test(id);

/** The café's doors in the world, where their leaves stand shut (shared/keet.mjs): their openings. */
let openings: KeetDoor[] = [];
const REACH = 2.6; // as world/doors.ts
const eye = new THREE.Vector3();
const ahead = new THREE.Vector3();
/**
 * An open café door you look through, within reach: its leaf has swung aside, edge-on or out of view (the front door's
 * against its reveal), so the doorway itself stands for it and Use shuts it, as world/doors.ts's own toggle would. Then
 * the door's prompt, not the timed route's offer, has the prompt line in the doorway (main.ts). Null otherwise.
 */
export function keetDoorway(camera: THREE.Camera, doors: Doors): { id: string; name: string; open: boolean; locked: boolean; home: string | null; toggle: () => void } | null {
  camera.getWorldPosition(eye);
  camera.getWorldDirection(ahead);
  let best: { d: KeetDoor; t: number } | null = null;
  for (const d of openings) {
    const [a, b] = [d.panels[0].a, d.panels[0].b];
    if (!doors.isOpen(d.id) || Math.hypot(eye.x - (a[0] + b[0]) / 2, eye.z - (a[1] + b[1]) / 2) > REACH + 1) continue;
    // The ray against the doorway's upright rectangle: a to b, from the door's foot to its head.
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const den = ahead.x * ez - ahead.z * ex;
    if (Math.abs(den) < 1e-6) continue;
    const t = ((a[0] - eye.x) * ez - (a[1] - eye.z) * ex) / den;
    const s = ((a[0] - eye.x) * ahead.z - (a[1] - eye.z) * ahead.x) / den;
    const y = eye.y + ahead.y * t;
    if (t > 0 && t < REACH && s > 0.05 && s < 0.95 && y > d.y0 && y < d.y1 && (!best || t < best.t)) best = { d, t };
  }
  if (!best) return null;
  const { id, name } = best.d;
  return { id, name, open: true, locked: false, home: null, toggle: () => { doors.set(id, false); doors.onToggle(id, false, 1); } };
}

let held = false;
/**
 * Until package Z: during a Zombies game at the church (`shut`), the café's doors stay shut. As the game starts they shut
 * on this page too (alone there is no server to say so); the door prompt says why and sends nothing (main.ts).
 */
export function holdKeetShut(shut: boolean, doors: Doors): void {
  if (shut && !held) for (const id of ids) doors.set(id, false);
  held = shut;
}
