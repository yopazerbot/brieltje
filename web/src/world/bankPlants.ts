import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { World } from './collision';
import type { DipSpec } from './houseData';
import { leafLight } from './leaves';
import { reflectionSkips } from './reflections';
import type { GroundShadeUniforms } from './undergrowth';
import { waterLevel } from './water';
import { wind } from './wind';
import { FIELDS, insideRings, KINDS, layout, settle, VARIANTS, type Layout, type Ring } from './bankPlantsPlan';

/**
 * What grows along the ponds, ditches and creeks (Yoshi: the water's edges were "cartoonishly sharp", lawn running
 * in a clean line into the water). As the big games do it: never a bare edge, plants crossing the waterline in
 * clumps with gaps. Stands of common reed in the shallows and on the wet band, a few clumps of bulrush, soft rush
 * and yellow flag on the wet band, and coarse grass tussocks along most of the rim, their blades hanging over it
 * so the line between the lawn and the bank breaks up. All as they are at the end of November: straw-coloured
 * reed with grey-brown plumes, bulrush going yellow-brown, the rushes still dark green.
 *
 * Where: world/bankPlantsPlan.ts, once per pond or ditch from its rim, then put on the ground as the world has it
 * when you first come near (the bank's height from world/collision.ts, the water's surface from world/water.ts).
 * Our own models (tools/bank_plants.py, public/models/bank-plants.glb), fetched once; nothing is drawn before they
 * are in. Each kind and variant is an instanced mesh, near and far: close by the full plant (a reed clump about a
 * thousand triangles), further off a copy of a few dozen, and on Low and phones only those. Drawn within a reach
 * of the eye that follows the graphics preset, growing in at its edge in the vertex shader so nothing pops; the
 * ground's baked light and shade at the foot (world/groundShade.ts), lit as leaves are (world/leaves.ts), swaying
 * in the wind (world/wind.ts: the reed clearly, the rushes hardly). Not in a shot's way, not in the reflections, no
 * collision: you walk through them.
 */

/** Metres the eye moves before the plants round it are gathered again. */
const MOVE = 3;
/** Places along a shore settled together (some 43 m of it), and the time a frame may spend settling them (ms). */
const PIECE = 48;
const SETTLE_MS = 3;
/** Each kind's copies from this size to that (times the model's) */
const SIZE = [[0.85, 1.12], [0.85, 1.12], [0.8, 1.2], [1.0, 1.45], [0.85, 1.2]];
/** How far each kind's top leans at the wind's strongest (m), and its height (m) for how that grows up the plant. */
const SWAY = [0.16, 0.07, 0.025, 0.05, 0.035];
const HEIGHT = [2.4, 1.8, 0.75, 0.45, 0.85];
/** The sun through a leaf from behind (world/leaves.ts leafLight): thin reed and grass blades glow a little. */
const THROUGH = [0.4, 0.3, 0.15, 0.4, 0.3];
/** A copy's own shade (times its corners' colours), picked by its number. */
const TINTS = [1, 0.9, 1.07, 0.84, 0.96].map((s) => new THREE.Color(s, s, s * 0.97));
/** Ground a plant may grow on (world/collision.ts materials): the bare garden or meadow (none), the fields, the woods. */
const OPEN = new Set([undefined, 'forest', 'field_crop', 'field_soil', 'field_dark', 'fence', 'pole']);

/** A piece of a pond's or ditch's shore: its body's plan, which of its places, the box round them. */
interface Body {
  plan: Layout;
  from: number;
  to: number;
  /** x0, z0, x1, z1 round its places and their plants */
  box: [number, number, number, number];
  /** Settled plants (FIELDS numbers each), worked out the first time you come near */
  plants: Float32Array | null;
}

/** One kind and variant, near or far: its mesh and how many copies it holds. */
interface Slot {
  mesh: THREE.InstancedMesh;
  capacity: number;
}

let job: Promise<Map<string, THREE.BufferGeometry> | null> | null = null;

/** The models, one geometry each by name, fetched once; null if they can't be. */
function loadModels(): Promise<Map<string, THREE.BufferGeometry> | null> {
  return (job ??= new GLTFLoader().loadAsync('/models/bank-plants.glb').then(
    (gltf) => {
      const out = new Map<string, THREE.BufferGeometry>();
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((o) => {
        if (!(o as THREE.Mesh).isMesh) return;
        const g = (o as THREE.Mesh).geometry.clone().applyMatrix4(o.matrixWorld);
        lightAsClump(g);
        out.set(o.name, g);
      });
      return out;
    },
    () => null,
  ));
}

/**
 * Normals that light a plant as the clump it is, not as a heap of slivers: up, and outwards from its middle the
 * further out a corner is (both faces of a blade alike, see the material).
 */
function lightAsClump(g: THREE.BufferGeometry): void {
  const pos = g.getAttribute('position');
  const nor = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, z);
    const out = r > 1e-4 ? Math.min(1, r / 0.3) * 0.55 / r : 0;
    v.set(x * out, 0.85, z * out).normalize();
    nor.set([v.x, v.y, v.z], i * 3);
  }
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.computeBoundingSphere();
}

export class BankPlants {
  readonly group = new THREE.Group();
  private bodies: Body[] = [];
  /** The dry dips (the garden's wadi): nothing grows in them */
  private dry: Ring[] = [];
  private world: World | null = null;
  private models: Map<string, THREE.BufferGeometry> | null = null;
  private materials: THREE.MeshStandardMaterial[];
  /** By kind, variant, then near (0) and far (1) */
  private slots: Slot[][][] = [];
  private reach = 110;
  private near = 28;
  private share = 1;
  private last = new THREE.Vector3(Infinity, 0, 0);
  private reachUniform = { value: 110 };
  /** What was drawn at the last gathering (plants, triangles near and far), and the time spent settling (ms) */
  readonly drawn = { plants: 0, near: 0, far: 0, settled: 0, settleMs: 0 };

  private shade?: GroundShadeUniforms;

  constructor(shade?: GroundShadeUniforms) {
    this.shade = shade;
    this.group.name = 'bank plants';
    this.group.userData.drawn = this.drawn; // for the dev tools (tools/dev)
    reflectionSkips.objects.add(this.group); // not in the water's mirror (world/reflections.ts)
    this.materials = KINDS.map((_, k) => this.material(k));
    void loadModels().then((models) => {
      if (!models) return;
      this.models = models;
      this.slots = KINDS.map((kind, k) => Array.from({ length: VARIANTS[k] }, (_, v) => [`${kind}${v + 1}`, `${kind}${v + 1}Far`].map((name) => this.slot(models.get(name), k, name, 64))));
      this.last.set(Infinity, 0, 0);
    });
  }

  private slot(geometry: THREE.BufferGeometry | undefined, kind: number, name: string, capacity: number): Slot {
    const mesh = new THREE.InstancedMesh(geometry ?? new THREE.BufferGeometry(), this.materials[kind], capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, TINTS[0]);
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false; // spread round the eye; the reach keeps them few
    mesh.userData.ignoreRay = true; // not in a shot's way
    mesh.raycast = () => {};
    mesh.name = name;
    this.group.add(mesh);
    return { mesh, capacity };
  }

  /**
   * One kind's material: growing in with the reach, swaying in the wind (the way it blows, turned into each copy's own
   * frame), the ground's light at its foot, lit as leaves with both faces of a blade alike.
   */
  private material(kind: number): THREE.MeshStandardMaterial {
    const shade = this.shade;
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide });
    m.onBeforeCompile = (shader) => {
      shader.uniforms.bpReach = this.reachUniform;
      shader.uniforms.windTime = wind.time;
      shader.uniforms.windStrength = wind.strength;
      Object.assign(shader.uniforms, { windDir: wind.dir, windSpeed: wind.speed });
      if (shade) Object.assign(shader.uniforms, { bpShade: shade.groundShade, bpShadeAll: shade.groundShadeAll, bpArea: shade.groundArea, bpAreaAll: shade.groundAreaAll });
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float bpReach;
          uniform float windTime;
          uniform float windStrength;
          uniform vec2 windDir;
          uniform float windSpeed;
          varying vec2 vBpLight;
          ${shade ? 'uniform sampler2D bpShade;\nuniform sampler2D bpShadeAll;\nuniform vec3 bpArea;\nuniform vec3 bpAreaAll;' : ''}`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vec3 bpRoot = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          {
            // The wind's lean, more towards the top; gusts rolling over the land as in the trees (world/wind.ts).
            vec2 dir = windDir;
            float h = max(0.0, transformed.y) / ${HEIGHT[kind].toFixed(2)};
            float gust = windSpeed * (0.55 + 0.45 * sin(windTime * 0.23 - dot(bpRoot.xz, dir) * 0.012));
            float lean = (0.55 + 0.45 * sin(windTime * 1.7 + bpRoot.x * 0.5 + bpRoot.z * 0.37)) * gust * h * h
              + 0.18 * h * h * h * sin(windTime * 4.3 + bpRoot.x * 1.3 - bpRoot.z * 0.7);
            vec3 w = vec3(dir.x, 0.0, dir.y) * lean * ${SWAY[kind].toFixed(3)} * windStrength;
            vec3 c0 = instanceMatrix[0].xyz;
            vec3 c2 = instanceMatrix[2].xyz;
            transformed.x += dot(w, c0) / dot(c0, c0);
            transformed.z += dot(w, c2) / dot(c2, c2);
            transformed.y -= 0.25 * lean * lean * ${SWAY[kind].toFixed(3)} * windStrength;
          }
          // Grown in towards the edge of the reach: nothing pops in or out.
          transformed *= smoothstep(bpReach, bpReach * 0.72, distance(cameraPosition, bpRoot));
          vBpLight = vec2(1.0);
          ${shade
            ? `{
            // The ground's light at the foot (sun, sky), as world/groundShade.ts gives the bank round it.
            vec2 uvFine = (bpRoot.xz - bpArea.xy) / bpArea.z * 0.5 + 0.5;
            vec2 uvAll = (bpRoot.xz - bpAreaAll.xy) / bpAreaAll.z * 0.5 + 0.5;
            vec2 edgeFine = abs(uvFine - 0.5);
            float fine = smoothstep(0.5, 0.46, max(edgeFine.x, edgeFine.y));
            vec4 gs = vec4(1.0, 1.0, 0.5, 0.5);
            vec2 edgeAll = abs(uvAll - 0.5);
            if (fine < 1.0 && max(edgeAll.x, edgeAll.y) < 0.5) gs = textureLod(bpShadeAll, uvAll, 0.0);
            if (fine > 0.0) gs = mix(gs, textureLod(bpShade, uvFine, 0.0), fine);
            vBpLight = gs.rg;
          }`
            : ''}`,
        );
      shader.fragmentShader = leafLight(shader.fragmentShader, THROUGH[kind])
        // Both faces of a blade lit alike, by the clump's shape.
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n#ifdef DOUBLE_SIDED\nnormal *= faceDirection;\n#endif')
        .replace('#include <common>', '#include <common>\nvarying vec2 vBpLight;')
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
          reflectedLight.directDiffuse *= vBpLight.x;
          reflectedLight.indirectDiffuse *= vBpLight.y;`,
        );
    };
    m.customProgramCacheKey = () => `bankPlants|${kind}|${!!shade}`;
    return m;
  }

  /**
   * The ponds and ditches of a piece of the data (the dry dips: none in them), as they are added to the world
   * (main.ts addDips) and to the water (world/water.ts). `lawns`: the gardens' lawns (fewer plants where one runs
   * down to the water). Plants already settled are settled again: the new piece may have paving by them.
   */
  addBodies(dips: DipSpec[], world: World, lawns?: { p: Ring[] }[]): void {
    this.world = world;
    const garden = (x: number, z: number) => !!lawns?.some((l) => insideRings(x, z, l.p));
    for (const d of dips) {
      if (!d.water) {
        this.dry.push(d.rim);
        continue;
      }
      const plan = layout(d, garden);
      for (let from = 0; from < plan.stations.length; from += PIECE) {
        const to = Math.min(plan.stations.length, from + PIECE);
        const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
        for (let k = from; k < to; k++) {
          const { x, z } = plan.stations[k];
          box[0] = Math.min(box[0], x - 3);
          box[1] = Math.min(box[1], z - 3);
          box[2] = Math.max(box[2], x + 3);
          box[3] = Math.max(box[3], z + 3);
        }
        this.bodies.push({ plan, from, to, box, plants: null });
      }
    }
    for (const b of this.bodies) b.plants = null;
    this.last.set(Infinity, 0, 0);
  }

  /** The graphics preset: how far they reach, where the far copies take over, how many stand. */
  setQuality(quality: string, phone: boolean): void {
    const low = quality === 'low' || phone;
    this.reach = low ? 50 : quality === 'medium' ? 85 : 110;
    this.near = low ? 0 : quality === 'medium' ? 20 : 28; // on Low and phones only the far copies
    this.share = low ? 0.6 : quality === 'medium' ? 0.85 : 1;
    this.reachUniform.value = this.reach;
    this.last.set(Infinity, 0, 0);
  }

  /** A piece of shore's plants on the ground as the world has it now. */
  private settle(b: Body): Float32Array {
    const world = this.world!;
    const dry = this.dry;
    const t0 = performance.now();
    const plants = settle(b.plan, {
      bed: (x, z) => world.groundAt(x, z, -1e4, 0).y,
      level: (x, z) => waterLevel(x, z),
      open: (x, z, bed) => !dry.some((r) => insideRings(x, z, [r])) && OPEN.has(world.groundAt(x, z, bed + 3, 0).mat),
    }, b.from, b.to);
    this.drawn.settled++;
    this.drawn.settleMs += performance.now() - t0;
    return plants;
  }

  /** Gather the plants round the eye again once it has moved a few metres. */
  update(eye: THREE.Vector3): void {
    if (!this.models || !this.world || !this.bodies.length) return;
    if (Math.hypot(eye.x - this.last.x, eye.z - this.last.z) < MOVE && Math.abs(eye.y - this.last.y) < MOVE) return;
    this.last.copy(eye);
    const counts = this.slots.map((vs) => vs.map(() => [0, 0]));
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const at = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const reach2 = this.reach * this.reach;
    const near2 = this.near * this.near;
    const drawn = { plants: 0, near: 0, far: 0 }; // this gathering's
    // Wanted per slot first (the slots grow when a place holds more than they do), then laid in.
    const list: number[] = [];
    const start = performance.now();
    for (let bi = 0; bi < this.bodies.length; bi++) {
      const b = this.bodies[bi];
      const dx = Math.max(b.box[0] - eye.x, 0, eye.x - b.box[2]);
      const dz = Math.max(b.box[1] - eye.z, 0, eye.z - b.box[3]);
      if (dx * dx + dz * dz > reach2) continue;
      if (!b.plants && performance.now() - start > SETTLE_MS) {
        this.last.set(Infinity, 0, 0); // more to settle: on with it next frame
        continue;
      }
      const plants = (b.plants ??= this.settle(b));
      for (let k = 0; k < plants.length; k += FIELDS) {
        if (plants[k + 8] > this.share) continue;
        const px = plants[k] - eye.x;
        const py = plants[k + 1] - eye.y;
        const pz = plants[k + 2] - eye.z;
        const d2 = px * px + pz * pz;
        if (d2 > reach2 || Math.abs(py) > this.reach) continue;
        const kind = plants[k + 3];
        const variant = plants[k + 4];
        const lod = d2 < near2 ? 0 : 1;
        counts[kind][variant][lod]++;
        list.push(k, lod, bi);
      }
    }
    this.slots.forEach((vs, kind) => vs.forEach((pair, variant) => pair.forEach((slot, lod) => {
      const need = counts[kind][variant][lod];
      if (need > slot.capacity) {
        // More here than this slot holds: a bigger one in its place.
        this.group.remove(slot.mesh);
        slot.mesh.dispose();
        const grown = this.slot(slot.mesh.geometry, kind, slot.mesh.name, Math.ceil(need * 1.5));
        pair[lod] = grown;
      }
      counts[kind][variant][lod] = 0;
    })));
    for (let i = 0; i < list.length; i += 3) {
      const plants = this.bodies[list[i + 2]].plants!;
      const k = list[i];
      const lod = list[i + 1];
      const kind = plants[k + 3];
      const variant = plants[k + 4];
      const size = plants[k + 5];
      const slot = this.slots[kind][variant][lod];
      const n = counts[kind][variant][lod]++;
      q.setFromAxisAngle(up, plants[k + 6]);
      const s = SIZE[kind][0] + size * (SIZE[kind][1] - SIZE[kind][0]);
      scale.set(s, s * (0.92 + size * 0.16), s);
      at.set(plants[k], plants[k + 1], plants[k + 2]);
      slot.mesh.setMatrixAt(n, m.compose(at, q, scale));
      slot.mesh.setColorAt(n, TINTS[Math.floor(plants[k + 7] * TINTS.length) % TINTS.length]);
      const tris = (slot.mesh.geometry.index?.count ?? slot.mesh.geometry.getAttribute('position')?.count ?? 0) / 3;
      drawn.plants++;
      if (lod) drawn.far += tris;
      else drawn.near += tris;
    }
    this.slots.forEach((vs, kind) => vs.forEach((pair, variant) => pair.forEach((slot, lod) => {
      const n = counts[kind][variant][lod];
      const mesh = slot.mesh;
      mesh.count = n;
      mesh.visible = n > 0;
      if (n) {
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, n * 16);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor!.clearUpdateRanges();
        mesh.instanceColor!.addUpdateRange(0, n * 3);
        mesh.instanceColor!.needsUpdate = true;
      }
    })));
    Object.assign(this.drawn, drawn);
  }
}
