import * as THREE from 'three';
import { FLAG_COLORS, baseOf, fieldOf } from '../../shared/flagFields.mjs';
import type { FlagGameView, FlagTeam } from '../ui/flagHud';

/**
 * Steal the flag in the world (server/flags.mjs decides where each flag is; shared/flagFields.mjs has the bases): a stand
 * at each base (a low round plinth with a band in the team's colour, the ring on the ground where the team scores, and a
 * tall soft column of the team's colour that shows the base from far off), and each flag: a staff with a cloth in the
 * team's colour and a white disc, waving. Home it stands in its plinth, carried it rides on the carrier's back, dropped
 * it leans in the ground with a shorter column over it. Our own shapes; nothing to download. A few draw calls; the
 * columns are unlit and faint (no light, nothing near the half-float limit), on every preset. Each column has a thin
 * white core and each cloth a white edge (Yoshi, 17 Nov 2026: "Make sure the ctf is fair"): the red reads against
 * Molenhoek's brick and its red cycle lane, the blue against the sky. With the sides swapped each stand is at its
 * team's new base (shared/flagFields.mjs baseOf).
 */

const TEAMS: FlagTeam[] = ['blue', 'red'];
const STAFF = 2.3; // m
const CLOTH_W = 1.25;
const CLOTH_H = 0.82;
const PLINTH_H = 0.3;
const RING_IN = 2.0; // m: the capture ring (a little inside server/flags.mjs CAPTURE, 2.2)
const RING_OUT = 2.25;
const COLUMN = 34; // m: the base's column
const COLUMN_DROPPED = 14;

/** A soft upward fade for the columns: opaque at the foot, gone at the top. */
function fadeTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 64, 0, 0);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 64);
  return new THREE.CanvasTexture(c);
}

/** The cloth's face: the team's colour with a white ring in it, a white edge all round and a wider one at the staff. */
function clothTexture(color: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 84;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fbf6ea';
  g.fillRect(0, 0, 128, 84); // the white edge round it, 4 px of 84 (about 4 cm)
  g.fillStyle = color;
  g.fillRect(8, 4, 120 - 4, 84 - 8);
  g.fillStyle = '#fbf6ea'; // the white disc
  g.beginPath();
  g.arc(68, 42, 22, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = color;
  g.beginPath();
  g.arc(68, 42, 12, 0, Math.PI * 2);
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const fade = fadeTexture();
const staffGeo = new THREE.CylinderGeometry(0.035, 0.04, STAFF, 8).translate(0, STAFF / 2, 0);
const staffMat = new THREE.MeshStandardMaterial({ color: '#d9d9d4', metalness: 0.6, roughness: 0.35 });
const knobGeo = new THREE.SphereGeometry(0.07, 10, 8).translate(0, STAFF + 0.03, 0);
const plinthGeo = new THREE.CylinderGeometry(0.55, 0.68, PLINTH_H, 24).translate(0, PLINTH_H / 2, 0);
const plinthMat = new THREE.MeshStandardMaterial({ color: '#bdb8ad', roughness: 0.85 });
const bandGeo = new THREE.CylinderGeometry(0.635, 0.66, 0.09, 24).translate(0, PLINTH_H - 0.08, 0);
const ringGeo = new THREE.RingGeometry(RING_IN, RING_OUT, 56).rotateX(-Math.PI / 2);
const columnGeo = (h: number, r: number) => new THREE.CylinderGeometry(r, r, h, 16, 1, true).translate(0, h / 2, 0);
const baseColumnGeo = columnGeo(COLUMN, 0.3);
const droppedColumnGeo = columnGeo(COLUMN_DROPPED, 0.22);
// The columns' white core: a thin column inside each, as faint, that edges the colour from far off (sky or brick).
const baseCoreGeo = columnGeo(COLUMN, 0.07);
const droppedCoreGeo = columnGeo(COLUMN_DROPPED, 0.06);
const coreMat = new THREE.MeshBasicMaterial({ color: '#ffffff', alphaMap: fade, transparent: true, opacity: 0.5, depthWrite: false });
/** Each team's stand materials, made once and shared by every field's stands (a field change makes no new ones). */
const teamMats = (color: string) => ({
  band: new THREE.MeshStandardMaterial({ color, roughness: 0.6 }),
  ring: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
  column: new THREE.MeshBasicMaterial({ color, alphaMap: fade, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }),
});
const standMats: Record<FlagTeam, ReturnType<typeof teamMats>> = { blue: teamMats(FLAG_COLORS.blue), red: teamMats(FLAG_COLORS.red) };

/** One flag: its staff and its waving cloth (a geometry of its own: its points move every frame). */
class Flag {
  readonly root = new THREE.Group();
  readonly cloth: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  readonly column: THREE.Mesh;
  private rest: Float32Array;

  constructor(readonly team: FlagTeam) {
    const color = FLAG_COLORS[team];
    const staff = new THREE.Mesh(staffGeo, staffMat);
    const knob = new THREE.Mesh(knobGeo, staffMat);
    const geo = new THREE.PlaneGeometry(CLOTH_W, CLOTH_H, 10, 3).translate(CLOTH_W / 2 + 0.03, STAFF - CLOTH_H / 2 - 0.05, 0);
    this.rest = (geo.attributes.position.array as Float32Array).slice();
    this.cloth = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: clothTexture(color), side: THREE.DoubleSide, roughness: 0.8 }));
    this.cloth.castShadow = true;
    this.column = new THREE.Mesh(droppedColumnGeo, new THREE.MeshBasicMaterial({ color, alphaMap: fade, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }));
    const core = new THREE.Mesh(droppedCoreGeo, coreMat);
    this.column.add(core);
    this.column.visible = false;
    this.root.add(staff, knob, this.cloth);
    for (const m of [staff, knob, this.cloth, this.column, core]) {
      m.userData.ignoreRay = true; // shots go through
      m.raycast = () => {};
    }
  }

  /** The cloth waves from the staff out, more at its free end; `speed` (m/s) makes it stream. */
  wave(time: number, speed: number): void {
    const pos = this.cloth.geometry.attributes.position;
    const a = pos.array as Float32Array;
    const amp = 0.06 + Math.min(0.1, speed * 0.012);
    for (let i = 0; i < a.length; i += 3) {
      const u = (this.rest[i] - 0.03) / CLOTH_W; // 0 at the staff, 1 at the free end
      a[i + 2] = this.rest[i + 2] + Math.sin(time * 5.5 - u * 5 + this.rest[i + 1] * 0.8) * amp * u;
      a[i + 1] = this.rest[i + 1] - u * u * 0.05;
    }
    pos.needsUpdate = true;
    this.cloth.geometry.computeVertexNormals();
  }
}

export class FlagWorld {
  readonly group = new THREE.Group();
  private stands = new Map<FlagTeam, THREE.Group>();
  private flags = new Map<FlagTeam, Flag>();
  private field = '';
  /** The sides swapped as the stands were last put */
  private swapped = false;
  private view: FlagGameView | null = null;
  private time = 0;
  /** Each carrier's last place, for the cloth to stream as they go */
  private last = new Map<FlagTeam, THREE.Vector3>();

  constructor() {
    this.group.name = 'flags';
    this.group.visible = false;
    for (const team of TEAMS) {
      const flag = new Flag(team);
      this.flags.set(team, flag);
      this.group.add(flag.root, flag.column);
    }
  }

  /** The game's view from the server (null: no flag game): the stands of its field, and where each flag is. */
  set(view: FlagGameView | null): void {
    this.view = view;
    this.group.visible = !!view;
    if (!view) return;
    if (view.field !== this.field || !!view.swapped !== this.swapped) this.build(view.field, !!view.swapped);
  }

  /**
   * The two stands, made once with shared geometries and materials, put where `fieldId` has them (shared/flagFields.mjs),
   * each at its team's base (`swapped`: the other one's): a change of field or of sides moves them, nothing is made or
   * left behind.
   */
  private build(fieldId: string, swapped: boolean): void {
    this.field = fieldId;
    this.swapped = swapped;
    const field = fieldOf(fieldId);
    for (const team of TEAMS) {
      let stand = this.stands.get(team);
      if (!stand) {
        stand = new THREE.Group();
        const mats = standMats[team];
        const plinth = new THREE.Mesh(plinthGeo, plinthMat);
        plinth.castShadow = plinth.receiveShadow = true;
        const band = new THREE.Mesh(bandGeo, mats.band);
        const ring = new THREE.Mesh(ringGeo, mats.ring);
        ring.position.y = 0.04;
        const column = new THREE.Mesh(baseColumnGeo, mats.column);
        column.position.y = PLINTH_H;
        column.add(new THREE.Mesh(baseCoreGeo, coreMat));
        stand.add(plinth, band, ring, column);
        stand.traverse((o) => {
          o.userData.ignoreRay = true;
          (o as THREE.Mesh).raycast = () => {};
        });
        this.stands.set(team, stand);
        this.group.add(stand);
      }
      const [x, z, y] = baseOf(field, team, swapped).stand;
      stand.position.set(x, y, z);
    }
  }

  /**
   * Every frame: each flag where the server has it, carried ones on their carrier as drawn now (`where`: a player's feet
   * and heading, null when not drawn: then the flag isn't either), the cloths waving.
   */
  update(dt: number, where: (name: string) => { x: number; y: number; z: number; yaw: number } | null): void {
    const v = this.view;
    if (!v) return;
    this.time += dt;
    const field = fieldOf(v.field);
    for (const team of TEAMS) {
      const f = v.flags[team];
      const flag = this.flags.get(team)!;
      const root = flag.root;
      let speed = 0;
      flag.column.visible = f.at === 'ground';
      if (f.at === 'home') {
        const [x, z, y] = baseOf(field, team, !!v.swapped).stand;
        root.visible = true;
        root.position.set(x, y + PLINTH_H - 0.05, z);
        root.rotation.set(0, this.time * 0.15, 0); // turning slowly in the wind
        this.last.delete(team);
      } else if (f.at === 'ground') {
        root.visible = true;
        root.position.set(f.x ?? 0, f.y ?? 0, f.z ?? 0);
        root.rotation.set(0.35, 0.8, 0, 'YXZ'); // leaning where it fell
        flag.column.position.copy(root.position);
        this.last.delete(team);
      } else {
        const at = f.by ? where(f.by) : null;
        root.visible = !!at;
        if (!at) continue;
        // On the back: a little behind and leaning back, its foot at the hips.
        const bx = Math.sin(at.yaw) * 0.22, bz = Math.cos(at.yaw) * 0.22;
        root.position.set(at.x + bx, at.y + 0.75, at.z + bz);
        root.rotation.set(-0.22, at.yaw, 0, 'YXZ');
        const prev = this.last.get(team);
        if (prev && dt > 0) speed = Math.hypot(at.x - prev.x, at.z - prev.z) / dt;
        if (prev) prev.set(at.x, at.y, at.z);
        else this.last.set(team, new THREE.Vector3(at.x, at.y, at.z));
      }
      flag.wave(this.time + (team === 'red' ? 1.7 : 0), speed);
    }
  }

  /** The flags on the maps: each where it is (a carrier's as drawn now), in its team's colour; `carried` for a ring. */
  marks(where: (name: string) => { x: number; y: number; z: number } | null): { x: number; y: number; z: number; color: string; carried: boolean; name?: string }[] {
    const v = this.view;
    if (!v) return [];
    const field = fieldOf(v.field);
    const out: { x: number; y: number; z: number; color: string; carried: boolean; name?: string }[] = [];
    for (const team of TEAMS) {
      const f = v.flags[team];
      if (f.at === 'carried') {
        const at = f.by ? where(f.by) : null;
        if (at) out.push({ x: at.x, y: at.y, z: at.z, color: FLAG_COLORS[team], carried: true, name: f.by });
      } else if (f.at === 'ground') out.push({ x: f.x ?? 0, y: f.y ?? 0, z: f.z ?? 0, color: FLAG_COLORS[team], carried: false });
      else {
        const [x, z, y] = baseOf(field, team, !!v.swapped).stand;
        out.push({ x, y, z, color: FLAG_COLORS[team], carried: false });
      }
    }
    return out;
  }
}
