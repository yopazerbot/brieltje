import * as THREE from 'three';
import ROUTES from '../../shared/routes.json';
import { bestKey, cleanTime, pointsOf, stepRun, type By, type Route, type Run } from '../../shared/goals.mjs';

/**
 * Timed routes (shared/routes.json, the rules in shared/goals.mjs): a start gate for each, an upright ring of light, and
 * while a run is on the next checkpoint as a bright ring and the one after it faint. Through the gate the right way,
 * moving as the route asks, and the clock runs; the gate again is the finish. Plain colours, no light, no texture.
 */

export const ROUTE_LIST: readonly Route[] = ROUTES.routes as Route[];
/** A gate is drawn within this distance of the camera. */
const GATE_SHOW = 300;
/** The line about a gate shows this close to it. */
const GATE_NEAR = 15;
/** The ring as drawn (m): smaller than the pass radius, so it stays clear of the houses by the road. */
const drawnRadius = (route: Route) => Math.min(route.radius, route.by === 'car' ? 4 : 2.5);

export interface RunResult {
  event: 'start' | 'checkpoint' | 'finish' | 'stop';
  route: Route;
  /** On a finish: the time (ms), the best before it (ms, or null) and whether it is a new best */
  time?: number;
  before?: number | null;
  newBest?: boolean;
}

export class Routes {
  readonly group = new THREE.Group();
  run: Run | null = null;
  /** Best times by bestKey(route), in ms */
  best: Record<string, number> = {};
  private gates: THREE.Mesh[] = [];
  private next: THREE.Mesh;
  private after: THREE.Mesh;
  private solid: Map<string, THREE.MeshBasicMaterial>;
  private faint: Map<string, THREE.MeshBasicMaterial>;
  private last: { x: number; z: number } | null = null;
  private villageIn = false;
  /** The rings as last placed: route and next point */
  private ringKey = '';
  /** Every ring shown once for the warm-up frames behind the start screen (warming) */
  private warm = false;

  constructor(private ground: (x: number, z: number) => number) {
    const ring = new THREE.TorusGeometry(1, 0.045, 6, 48);
    this.solid = new Map(ROUTE_LIST.map((r) => [r.id, new THREE.MeshBasicMaterial({ color: r.colour })]));
    this.faint = new Map(ROUTE_LIST.map((r) => [r.id, new THREE.MeshBasicMaterial({ color: r.colour, transparent: true, opacity: 0.4, depthWrite: false })]));
    const mesh = (m: THREE.Material) => {
      const o = new THREE.Mesh(ring, m);
      o.visible = false;
      o.castShadow = o.receiveShadow = false;
      o.userData.ignoreRay = true;
      o.raycast = () => {};
      this.group.add(o);
      return o;
    };
    for (const r of ROUTE_LIST) this.gates.push(mesh(this.solid.get(r.id)!));
    this.next = mesh(this.solid.get(ROUTE_LIST[0].id)!);
    this.after = mesh(this.faint.get(ROUTE_LIST[0].id)!);
    this.settle();
  }

  /** A ring of `route`'s size standing at point (x, z), its face across the way from (fx, fz). */
  private stand(o: THREE.Mesh, route: Route, x: number, z: number, fx: number, fz: number): void {
    const r = drawnRadius(route);
    o.scale.setScalar(r);
    o.position.set(x, this.ground(x, z) + r * 0.92, z);
    o.rotation.set(0, Math.atan2(x - fx, z - fz), 0);
  }

  settle(): void {
    ROUTE_LIST.forEach((r, i) => {
      const [gx, gz] = r.gate;
      const [fx, fz] = r.checkpoints[0];
      this.stand(this.gates[i], r, gx, gz, gx - (fx - gx), gz - (fz - gz));
    });
  }

  villageReady(): void {
    this.villageIn = true;
    this.settle();
  }

  /** The route whose gate is within 15 m of (x, z), when no run is on; null before the village is in. */
  nearGate(x: number, z: number): Route | null {
    if (!this.villageIn) return null;
    let best: Route | null = null, d = GATE_NEAR;
    for (const r of ROUTE_LIST) {
      const e = Math.hypot(r.gate[0] - x, r.gate[1] - z);
      if (e < d) [best, d] = [r, e];
    }
    return best;
  }

  route(): Route | null {
    return this.run ? ROUTE_LIST.find((r) => r.id === this.run!.id) ?? null : null;
  }

  /** The gates within 300 m of the camera: each frame the group is shown, playing or not (a menu, the warm-up). */
  showGates(camera: THREE.Vector3): void {
    for (let i = 0; i < ROUTE_LIST.length; i++) {
      const [gx, gz] = ROUTE_LIST[i].gate;
      this.gates[i].visible = this.warm || (this.villageIn && Math.hypot(gx - camera.x, gz - camera.z) < GATE_SHOW);
    }
  }

  /** Not playing and no run on: the next step starts afresh (no hop from where you were before a trip or a respawn). */
  forget(): void {
    if (!this.run) this.last = null;
  }

  /**
   * The warm-up frames behind the start screen (main.ts): while on, every ring is drawn, each material once (the gates,
   * the next ring and the faint one after it, standing at the first gate), so none is drawn for the first time in play.
   */
  warming(on: boolean): void {
    if (on === this.warm) return;
    this.warm = on;
    if (on) {
      const r = ROUTE_LIST[0];
      const [gx, gz] = r.gate;
      for (const [o, m] of [[this.next, this.solid.get(r.id)!], [this.after, this.faint.get(r.id)!]] as const) {
        o.material = m;
        this.stand(o, r, gx, gz, gx - 1, gz);
        o.visible = true;
      }
      for (const g of this.gates) g.visible = true;
    } else {
      this.ringKey = '-';
      this.showRings(this.route());
    }
  }

  /** Stop a run where it is (a game began, the page went to the start screen): 'stop', or null when none was on. */
  stop(): RunResult | null {
    const route = this.route();
    this.run = null;
    this.last = null;
    this.showRings(null);
    return route ? { event: 'stop', route } : null;
  }

  /**
   * Each frame while you play: the step from last frame's place to this one's for the run, and its rings. `by`: how you
   * move (null: as a passenger or on a horse: no route). Returns what happened, or null.
   */
  update(me: { x: number; z: number; by: By | null }, nowMs: number): RunResult | null {
    const from = this.last;
    this.last = { x: me.x, z: me.z };
    if (!this.villageIn || !from) return null;
    let out: RunResult | null = null;
    if (this.run) {
      const route = this.route()!;
      const r = stepRun(this.run, route, from, me, me.by, nowMs);
      this.run = r.run;
      if (r.event === 'finish') {
        const key = bestKey(route);
        const before = this.best[key] ?? null;
        const time = r.time ?? 0;
        const kept = cleanTime(time);
        const newBest = kept !== null && (before === null || kept < before);
        if (newBest) this.best[key] = kept;
        out = { event: 'finish', route, time, before, newBest };
      } else if (r.event) out = { event: r.event, route };
    } else {
      for (const route of ROUTE_LIST) {
        const r = stepRun(null, route, from, me, me.by, nowMs);
        if (r.event === 'start') {
          this.run = r.run;
          out = { event: 'start', route };
          break;
        }
      }
    }
    this.showRings(this.route());
    return out;
  }

  /** The next point of the run (x, z), its number (1 = the first checkpoint) and how many there are. */
  target(): { x: number; z: number; n: number; total: number; finish: boolean } | null {
    const route = this.route();
    if (!route || !this.run) return null;
    const pts = pointsOf(route);
    const [x, z] = pts[this.run.next];
    return { x, z, n: this.run.next + 1, total: route.checkpoints.length, finish: this.run.next >= pts.length - 1 };
  }

  private showRings(route: Route | null): void {
    if (this.warm) return;
    const key = route && this.run ? `${route.id}:${this.run.next}` : '';
    if (key === this.ringKey) return;
    this.ringKey = key;
    if (!route || !this.run) {
      this.next.visible = this.after.visible = false;
      return;
    }
    const pts = [route.gate, ...pointsOf(route)];
    const k = this.run.next + 1; // pts[k] is the next point, pts[k - 1] the one before
    const place = (o: THREE.Mesh, j: number, faint: boolean) => {
      if (j >= pts.length) {
        o.visible = false;
        return;
      }
      o.material = (faint ? this.faint : this.solid).get(route.id)!;
      const [x, z] = pts[j];
      const [fx, fz] = pts[j - 1];
      // The finish is the gate itself: no second ring in it.
      o.visible = j < pts.length - 1;
      this.stand(o, route, x, z, fx, fz);
    };
    place(this.next, k, false);
    place(this.after, k + 1, true);
  }
}
