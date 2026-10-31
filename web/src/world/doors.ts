import * as THREE from 'three';
import type { World } from './collision';
import type { DoorSpec } from './houseData';

const SPEED = 1.3;  // open/close per second (full travel)
const REACH = 2.6;  // m, how far away you can open a door
/** Glass in door leaves breaks like a window; its numbers start here, after the house's own blocks (the server allows up to 4000). */
export const DOOR_GLASS = 3000;

interface Panel {
  mesh: THREE.Group;
  a: THREE.Vector2;
  b: THREE.Vector2;
  normal: THREE.Vector2;
  offset: number;
  thickness: number;
  slide: THREE.Vector2;
  /** Swinging leaf: radians when fully open, hinged at a (0: not swinging) */
  swing: number;
  width: number;
  key: string;
  /** Its glass is shot out: you can step through the empty frame */
  broken: boolean;
}

interface Door {
  spec: DoorSpec;
  panels: Panel[];
  open: number;   // 0 closed .. 1 open
  target: number;
  /** Which way it swings this time (1 or -1; double-action doors) */
  dir: number;
}

const frameMat = new THREE.MeshStandardMaterial({ color: '#4d4a46', roughness: 0.45, metalness: 0.6 }); // grey/brown aluminium
const glassMat = new THREE.MeshPhysicalMaterial({
  color: '#dfeff5', roughness: 0.03, transparent: true, opacity: 0.2, envMapIntensity: 1.4, depthWrite: false, side: THREE.DoubleSide,
});
const leafMat = new THREE.MeshStandardMaterial({ color: '#f1efea', roughness: 0.55 });
// Outside doors: aluminium in RAL 8017 brown outside and RAL 9010 white inside (Toffly quote).
const outMat = new THREE.MeshStandardMaterial({ color: '#45322e', roughness: 0.5, metalness: 0.3 });
const inMat = new THREE.MeshStandardMaterial({ color: '#f1ece1', roughness: 0.5, metalness: 0.05 });
const frostedMat = new THREE.MeshPhysicalMaterial({ color: '#c3d0d6', roughness: 0.45, transparent: true, opacity: 0.86, side: THREE.DoubleSide });
const handleMat = new THREE.MeshStandardMaterial({ color: '#2a2a2a', roughness: 0.35, metalness: 0.8 });

const tinted = new Map<string, THREE.MeshStandardMaterial>();
/** A leaf or frame in its own colour (wood veneer, bronze), one material per colour. */
function tint(color: string, glass: boolean): THREE.MeshStandardMaterial {
  const key = `${color}-${glass}`;
  if (!tinted.has(key)) tinted.set(key, new THREE.MeshStandardMaterial({ color, roughness: glass ? 0.35 : 0.6, metalness: glass ? 0.7 : 0 }));
  return tinted.get(key)!;
}

/** UVs in metres (as the house's own surfaces have them), so a wood leaf matches the joinery beside it. */
function metreUV(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(nor.getY(i)) > 0.5) uv.setXY(i, pos.getX(i), pos.getZ(i));
    else if (Math.abs(nor.getX(i)) > 0.5) uv.setXY(i, pos.getZ(i), pos.getY(i));
    else uv.setXY(i, pos.getX(i), pos.getY(i));
  }
  return geo;
}

/** A panel's mesh, built along +x from 0 to `width`, centred on z = 0, standing from 0 to `height`. */
function panelMesh(width: number, height: number, thickness: number, glass: boolean, swing = false, outside?: 1 | -1, matte = false, color?: string, handle = true, surface?: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const box = (w: number, h: number, d: number, x: number, y: number, mat: THREE.Material, z = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = mat !== glassMat && mat !== frostedMat;
    m.receiveShadow = true;
    g.add(m);
  };
  // Aluminium: on an outside door brown on the outer half of its depth, white on the inner half.
  const alu = (w: number, h: number, x: number, y: number, fallback: THREE.Material) => {
    if (!outside) return box(w, h, thickness, x, y, fallback);
    box(w, h, thickness / 2, x, y, outMat, (outside * thickness) / 4);
    box(w, h, thickness / 2, x, y, inMat, (-outside * thickness) / 4);
  };
  if (glass) {
    const f = color ? 0.03 : 0.06; // frame profile (slim bronze on the inside doors)
    const frame = color ? tint(color, true) : frameMat;
    alu(width, f, width / 2, f / 2, frame);
    alu(width, f, width / 2, height - f / 2, frame);
    alu(f, height, f / 2, height / 2, frame);
    alu(f, height, width - f / 2, height / 2, frame);
    box(width - 2 * f, height - 2 * f, 0.012, width / 2, height / 2, matte ? frostedMat : glassMat);
    g.userData.pane = g.children[g.children.length - 1];
    if (handle && swing && color) box(0.13, 0.025, thickness + 0.07, width - 0.08, 1.05, handleMat); // lever
    else if (handle) box(0.03, 0.5, thickness + 0.04, width - 0.12, 1.05, handleMat);
  } else if (surface) {
    // A leaf in the house's own surface (the hidden kitchen door in oak).
    const m = new THREE.Mesh(metreUV(new THREE.BoxGeometry(width, height, thickness)), surface);
    m.position.set(width / 2, height / 2, 0);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  } else {
    alu(width, height, width / 2, height / 2, color ? tint(color, false) : leafMat);
    // Handle on the far side from the hinge (swinging), or near the edge you pull (sliding).
    if (handle && swing) box(0.13, 0.025, thickness + 0.07, width - 0.09, 1.05, handleMat);
    else if (handle) box(0.03, 0.4, thickness + 0.03, 0.12, 1.05, handleMat);
  }
  return g;
}

/**
 * Doors you can open and close. Each door has one or more panels; a panel
 * with a slide vector moves along it when the door opens (sliding doors),
 * a panel with a swing angle turns about its hinge (inside doors), others
 * stay put (the fixed half of a sliding glass door). Panels are solid for
 * walking wherever they currently are.
 */
export class Doors {
  readonly group = new THREE.Group();
  /** Called when you open or close a door yourself (to tell other players); `dir`: which way it swings. */
  onToggle: (id: string, open: boolean, dir: number) => void = () => {};
  /** The glass in the leaves, by its number (see DOOR_GLASS), for breaking it */
  readonly panes = new Map<number, THREE.Mesh>();
  private glassPanels = new Map<number, { door: Door; panel: Panel }>();
  private doors: Door[] = [];
  private raycaster = new THREE.Raycaster();

  /** `surface`: the house's materials by name, for leaves made of them */
  constructor(specs: DoorSpec[], private world: World, private surface?: (name: string) => THREE.Material) {
    this.raycaster.far = REACH;
    for (const spec of specs) {
      const start = spec.open ? 1 : 0;
      const door: Door = { spec, panels: [], open: start, target: start, dir: 1 };
      spec.panels.forEach((p, i) => {
        const a = new THREE.Vector2(...p.a);
        const b = new THREE.Vector2(...p.b);
        const dir = b.clone().sub(a);
        const width = dir.length();
        dir.normalize();
        const normal = new THREE.Vector2(-dir.y, dir.x);
        const own = p.surface && this.surface ? this.surface(p.surface) : undefined;
        const mesh = panelMesh(width, spec.y1 - spec.y0, p.thickness, p.glass, !!p.swing, p.outside, !!p.matte, p.color, p.handle !== false, own);
        mesh.rotation.y = -Math.atan2(dir.y, dir.x);
        mesh.userData.door = door;
        mesh.traverse((o) => (o.userData.door = door));
        this.group.add(mesh);
        const panel: Panel = { mesh, a, b, normal, offset: p.offset, thickness: p.thickness, slide: new THREE.Vector2(...(p.slide ?? [0, 0])), swing: p.swing ?? 0, width, key: `${spec.id}-${i}`, broken: false };
        door.panels.push(panel);
        const pane = mesh.userData.pane as THREE.Mesh | undefined;
        if (pane) {
          const index = DOOR_GLASS + this.panes.size; // same order on every computer: the house data's
          pane.userData.glassIndex = index;
          this.panes.set(index, pane);
          this.glassPanels.set(index, { door, panel });
        }
      });
      this.doors.push(door);
      this.place(door);
    }
  }

  private place(door: Door): void {
    const t = door.open * door.open * (3 - 2 * door.open); // ease in and out
    for (const p of door.panels) {
      // Swinging: the leaf's direction and normal turn about the hinge at a.
      const angle = p.swing * door.dir * t;
      const dir = p.b.clone().sub(p.a).normalize().rotateAround(new THREE.Vector2(), angle);
      const normal = p.normal.clone().rotateAround(new THREE.Vector2(), angle);
      const shift = p.slide.clone().multiplyScalar(t);
      const n = normal.clone().multiplyScalar(p.offset);
      const a = p.a.clone().add(n).add(shift);
      const b = a.clone().addScaledVector(dir, p.width);
      p.mesh.position.set(a.x, door.spec.y0, a.y);
      p.mesh.rotation.y = -Math.atan2(dir.y, dir.x);
      // Collision outline of the panel where it is now (none once its glass is gone).
      if (p.broken) {
        this.world.setMoving(p.key, null);
        continue;
      }
      const h = normal.clone().multiplyScalar(p.thickness / 2);
      this.world.setMoving(p.key, [
        [a.x - h.x, a.y - h.y], [b.x - h.x, b.y - h.y], [b.x + h.x, b.y + h.y], [a.x + h.x, a.y + h.y],
      ], door.spec.y0, door.spec.y1);
    }
  }

  update(dt: number): void {
    for (const door of this.doors) {
      if (door.open === door.target) continue;
      const step = dt * SPEED;
      door.open = door.target > door.open ? Math.min(door.target, door.open + step) : Math.max(door.target, door.open - step);
      this.place(door);
    }
  }

  /** The door you are looking at within reach, if any. */
  lookedAt(camera: THREE.Camera, scene: THREE.Object3D): { name: string; open: boolean; toggle: () => void } | null {
    camera.updateMatrixWorld();
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const hits = this.raycaster.intersectObjects([scene], true);
    const first = hits.find((h) => h.object.visible && !(h.object as THREE.Mesh).userData.ignoreRay);
    const door = first?.object.userData.door as Door | undefined;
    if (!door) return null;
    return {
      name: door.spec.name,
      open: door.target === 1,
      toggle: () => {
        door.target = door.target === 1 ? 0 : 1;
        const p = door.panels[0];
        if (door.spec.both && door.target === 1 && door.open === 0 && p) {
          // Double-action: away from you. A positive swing turns the leaf towards its normal's side.
          const s = p.normal.x * (camera.position.x - p.a.x) + p.normal.y * (camera.position.z - p.a.y);
          door.dir = s > 0 === p.swing > 0 ? -1 : 1;
        }
        this.onToggle(door.spec.id, door.target === 1, door.dir);
      },
    };
  }

  /** A leaf's glass broke (or, with false, is back): the frame alone no longer blocks the way. */
  setBroken(index: number, broken: boolean): void {
    const entry = this.glassPanels.get(index);
    if (!entry) return;
    entry.panel.broken = broken;
    this.place(entry.door);
  }

  /** Open or close a door because another player did (`dir`: the way a double-action door swings). */
  set(id: string, open: boolean, dir?: number): void {
    const door = this.doors.find((d) => d.spec.id === id);
    if (!door) return;
    door.target = open ? 1 : 0;
    if (door.spec.both && (dir === 1 || dir === -1) && (open || door.open === 0)) door.dir = dir;
  }

  setAll(states: Record<string, boolean>, dirs: Record<string, number> = {}): void {
    for (const [id, open] of Object.entries(states)) this.set(id, open, dirs[id]);
  }
}
