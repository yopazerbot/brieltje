import * as THREE from 'three';
import { GUN_PAINT, onPaintball } from '../paintball';
import { splatSheet } from './sprites';

/**
 * Paint on the players' figures (net/swat.ts) in the paint look: a splat where a paintball hit them, on the chest,
 * the back, the helmet or a leg, that moves with the body as it runs, crouches and falls, and stays until they come
 * back in the game (a fresh figure is clean). Several hits build up, up to SPOTS at once (the oldest makes room).
 *
 * How it is done (as big games put blood and wounds on their characters: the hit is kept in the model's rest pose,
 * its "bind pose", so it follows every bone without a mesh of its own): each spot is a point on the body as it stood
 * when it was modelled, a direction (the way the surface there faced) and a size. The figure's own fragment shader
 * lays one of the four splat shapes of the paint sheet (world/sprites.ts splatSheet, the walls' splats) over the
 * body there, projected along that direction and thinning out with depth so it doesn't come through on the other
 * side. No draw call, no texture and no mesh per splat: a few numbers per spot in the figure's uniforms, shared by
 * every figure of that player (the one under the parachute, on the bike or in the car's seat too), and one shader
 * for all of them. A figure without paint skips the loop at once.
 *
 * Where a spot goes: on the shooter's page from the body's own surface where the paintball landed; on the other
 * pages from the shot's direction (main.ts), as a ray against the posed figure, or on the rest pose when the
 * figure isn't drawn (your own, while the camera is in your head).
 */

const SPOTS = 12;
const UP = new THREE.Vector3(0, 1, 0);

interface PaintSet {
  at: { value: THREE.Vector4[] };
  dir: { value: THREE.Vector4[] };
  col: { value: THREE.Color[] };
  n: { value: number };
  next: number;
}

const sets = new Map<string, PaintSet>();
const sheet: { value: THREE.Texture | null } = { value: null };

/** The rest pose of the figures (one model for all): a plain mesh of it to cast rays on, and how it sits in a figure's root. */
let rest: { mesh: THREE.Mesh; fromRoot: THREE.Matrix4; unit: number } | null = null;

function setOf(name: string): PaintSet {
  let s = sets.get(name);
  if (!s) {
    s = {
      at: { value: Array.from({ length: SPOTS }, () => new THREE.Vector4()) },
      dir: { value: Array.from({ length: SPOTS }, () => new THREE.Vector4(0, 0, 1, 0)) },
      col: { value: Array.from({ length: SPOTS }, () => new THREE.Color()) },
      n: { value: 0 },
      next: 0,
    };
    sets.set(name, s);
  }
  return s;
}

/**
 * One spot's splat at a point of the rest pose `p` (its surface facing `pn`; `px` rest units per pixel): `s` its
 * middle and radius, `o` its direction and in `w` the sheet's cell (whole part) and its turn (fraction). Returns how
 * much paint (x) and the sheet's shading there (y). The shape is one cell of the sheet, turned by the spot's own
 * angle, laid in the plane across its direction; it thins out with depth along it and on surfaces facing away, so it
 * doesn't come through on the far side of an arm or the chest. Shared with the zombies' shader (world/zombies.ts).
 */
export const PAINT_SPLAT_GLSL = `
uniform sampler2D uPaintMap;
vec2 paintSplat(vec3 p, vec3 pn, float px, vec4 s, vec4 o) {
  vec3 d = p - s.xyz;
  float h = dot(d, o.xyz);
  if (abs(h) > s.w * 0.55 || dot(d, d) > s.w * s.w * 1.4) return vec2(0.0);
  float face = dot(pn, o.xyz);
  if (face < -0.15) return vec2(0.0);
  vec3 t = normalize(cross(abs(o.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), o.xyz));
  vec3 b = cross(o.xyz, t);
  float ang = fract(o.w) * 6.2831853;
  float ca = cos(ang), sa = sin(ang);
  vec2 uv = vec2(dot(d, t), dot(d, b)) / s.w;
  uv = vec2(ca * uv.x - sa * uv.y, sa * uv.x + ca * uv.y);
  if (abs(uv.x) > 0.98 || abs(uv.y) > 0.98) return vec2(0.0);
  float cell = floor(o.w);
  vec2 cuv = vec2(mod(cell, 2.0) * 0.5, 0.5 - floor(cell * 0.5) * 0.5) + (uv * 0.5 + 0.5) * 0.5;
  // Which of the sheet's mipmaps (its 256-pixel cells) for the size it is drawn at, so far splats don't shimmer (a
  // little sharper than that: a splat far off stays a splat). Its shading is taken where the paint is: the clear
  // texels round it are black and would darken it in the small mipmaps.
  vec4 tx = textureLod(uPaintMap, cuv, max(0.0, log2(px / (2.0 * s.w) * 256.0) - 0.75));
  return vec2(tx.a * (1.0 - smoothstep(s.w * 0.3, s.w * 0.55, abs(h))) * smoothstep(-0.15, 0.2, face), 0.55 + 0.5 * min(1.0, tx.r / max(tx.a, 0.05)));
}`;

const VERT_PARS = 'varying vec3 vPaintP;\nvarying vec3 vPaintN;';
const FRAG_PARS = `uniform vec4 uPaintAt[${SPOTS}];
uniform vec4 uPaintDir[${SPOTS}];
uniform vec3 uPaintCol[${SPOTS}];
uniform int uPaintN;
varying vec3 vPaintP;
varying vec3 vPaintN;
${PAINT_SPLAT_GLSL}`;
// After the palette's colour: each spot's splat over it.
const FRAG_PAINT = `
float paintA = 0.0;
if (uPaintN > 0) {
  vec3 pn = normalize(vPaintN);
  float px = length(fwidth(vPaintP));
  for (int i = 0; i < ${SPOTS}; i++) {
    if (i >= uPaintN) break;
    vec2 a = paintSplat(vPaintP, pn, px, uPaintAt[i], uPaintDir[i]);
    if (a.x <= 0.0) continue;
    diffuseColor.rgb = mix(diffuseColor.rgb, uPaintCol[i] * a.y, a.x);
    paintA = max(paintA, a.x);
  }
}`;

/** The splat shapes (world/sprites.ts splatSheet), one texture for the figures and the zombies. */
export function paintSheet(): THREE.Texture {
  if (!sheet.value) sheet.value = splatSheet();
  return sheet.value;
}

/** A random cell of the sheet and turn, as a spot's direction carries them in `w`. */
export const splatLook = (): number => Math.floor(Math.random() * 4) + Math.random() * 0.999;

/**
 * Figure `mesh` (the merged skinned mesh of net/swat.ts, in `root` at the origin) wears the paint of player `name`.
 * Called once per figure as it is built; all figures share one shader.
 */
export function wearPaint(mesh: THREE.SkinnedMesh, name: string, root: THREE.Object3D): void {
  const set = setOf(name);
  mesh.userData.paintName = name;
  root.userData.paintMesh = mesh;
  if (!rest) {
    root.updateMatrixWorld(true);
    const inRoot = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(mesh.matrixWorld);
    const plain = new THREE.Mesh(mesh.geometry);
    plain.matrixAutoUpdate = false;
    plain.updateMatrixWorld(true);
    rest = { mesh: plain, fromRoot: inRoot.clone().invert(), unit: inRoot.getMaxScaleOnAxis() };
  }
  paintSheet();
  const m = mesh.material as THREE.MeshStandardMaterial;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uPaintAt = set.at;
    shader.uniforms.uPaintDir = set.dir;
    shader.uniforms.uPaintCol = set.col;
    shader.uniforms.uPaintN = set.n;
    shader.uniforms.uPaintMap = sheet;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPaintP = position;\nvPaintN = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_PAINT}`)
      // Wet paint: smooth and no metal, whatever the suit under it is.
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.32, paintA);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.0, paintA);');
  };
  m.customProgramCacheKey = () => 'swat-paint';
}

const _ray = new THREE.Raycaster();
const _hits: THREE.Intersection[] = [];
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/** Spot from a ray's hit on the figure's geometry (posed or at rest): the point and the way it faced, at rest. */
function spotFrom(set: PaintSet, geo: THREE.BufferGeometry, hit: THREE.Intersection, color: THREE.Color, radius: number): void {
  if (!hit.face || !hit.barycoord) return;
  const { a, b, c } = hit.face;
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const w = hit.barycoord;
  _v.fromBufferAttribute(pos, a).multiplyScalar(w.x)
    .addScaledVector(_a.fromBufferAttribute(pos, b), w.y)
    .addScaledVector(_a.fromBufferAttribute(pos, c), w.z);
  if (nor) {
    _n.fromBufferAttribute(nor, a).multiplyScalar(w.x)
      .addScaledVector(_a.fromBufferAttribute(nor, b), w.y)
      .addScaledVector(_a.fromBufferAttribute(nor, c), w.z);
  } else {
    _a.fromBufferAttribute(pos, a);
    _b.fromBufferAttribute(pos, b).sub(_a);
    _c.fromBufferAttribute(pos, c).sub(_a);
    _n.crossVectors(_b, _c);
  }
  if (_n.lengthSq() < 1e-12) return;
  _n.normalize();
  const i = set.next;
  set.next = (set.next + 1) % SPOTS;
  set.n.value = Math.min(SPOTS, set.n.value + 1);
  const r = radius / (rest?.unit ?? 1);
  set.at.value[i].set(_v.x, _v.y, _v.z, r * (0.85 + Math.random() * 0.3));
  set.dir.value[i].set(_n.x, _n.y, _n.z, splatLook());
  set.col.value[i].copy(color);
}

/** A ray on the posed figure `mesh`: the first hit on its body, or null. */
function onFigure(mesh: THREE.SkinnedMesh, origin: THREE.Vector3, dir: THREE.Vector3, far: number): THREE.Intersection | null {
  _ray.set(origin, dir);
  _ray.far = far;
  _hits.length = 0;
  mesh.raycast(_ray, _hits);
  _hits.sort((p, q) => p.distance - q.distance);
  return _hits[0] ?? null;
}

/** A ray on the rest pose, given in a figure root's frame (feet at 0, facing -z): the first hit, or null. */
function onRest(origin: THREE.Vector3, dir: THREE.Vector3): THREE.Intersection | null {
  if (!rest) return null;
  _ray.set(origin.clone().applyMatrix4(rest.fromRoot), dir.clone().transformDirection(rest.fromRoot));
  _ray.far = 10 / rest.unit;
  _hits.length = 0;
  rest.mesh.raycast(_ray, _hits);
  _hits.sort((p, q) => p.distance - q.distance);
  return _hits[0] ?? null;
}

/**
 * The colour of the paint on a figure: the shooter's team colour in a team match (main.ts sets `team`; null is you),
 * else the paint the shot carried (the gun's).
 */
export const figurePaint: { team: (shooter: string | null) => string | null } = { team: () => null };
export function paintColour(shooter: string | null, gun: THREE.Color): THREE.Color {
  const team = figurePaint.team(shooter);
  return team ? new THREE.Color(team) : gun;
}

/** The paint's size on a figure (radius, m) for a paintball whose splat on a wall is `size` across. */
export const figureSplat = (size: number): number => Math.min(0.42, Math.max(0.2, size * 0.85));

/**
 * A paintball landed on a player's figure at `point` (world), the surface there facing `normal`: `on` is the hit box
 * it met (net/swat.ts), whose figure takes the spot. False when there is no such figure (block figures: the caller
 * puts a blob on instead).
 */
export function paintHitBox(on: THREE.Object3D, point: THREE.Vector3, normal: THREE.Vector3, color: THREE.Color, radius: number): boolean {
  let mesh: THREE.SkinnedMesh | undefined;
  for (let p: THREE.Object3D | null = on; p && !mesh; p = p.parent) mesh = p.userData.paintMesh as THREE.SkinnedMesh | undefined;
  const name = mesh?.userData.paintName as string | undefined;
  if (!mesh || name === undefined) return false;
  mesh.updateMatrixWorld(true);
  // Back out a little along the surface and in again: the first point of the body there.
  const back = normal.clone().normalize();
  const hit = onFigure(mesh, point.clone().addScaledVector(back, 0.3), back.clone().negate(), 0.7);
  if (hit) spotFrom(setOf(name), mesh.geometry, hit, color, radius);
  return !!hit;
}

/**
 * Another page's paint shot on player `name` (main.ts derives it from the shot's direction): the ray `from` along `dir`
 * (world) on their figure `mesh`, if it meets the body: where it did, or null.
 */
export function paintRay(mesh: THREE.SkinnedMesh, from: THREE.Vector3, dir: THREE.Vector3, far: number, color: THREE.Color, radius: number): THREE.Intersection | null {
  const name = mesh.userData.paintName as string | undefined;
  if (name === undefined) return null;
  const hit = onFigure(mesh, from, dir, far);
  if (hit) spotFrom(setOf(name), mesh.geometry, hit, color, radius);
  return hit;
}

/**
 * Paint on player `name` from a shot that came in along `dir` (in their figure's own frame: x right, y up, -z ahead),
 * somewhere on the body at random: for your own figures, when the server says you were hit and the camera was in
 * your head. Lands on the rest pose, so it shows on every figure of yours, now or later.
 */
export function paintFrom(name: string, dir: THREE.Vector3, color: THREE.Color, radius: number): void {
  // Mostly the chest and the back, sometimes the head or a leg.
  const r = Math.random();
  const y = r < 0.15 ? 1.6 + Math.random() * 0.15 : r < 0.75 ? 1.05 + Math.random() * 0.35 : 0.35 + Math.random() * 0.5;
  const d = dir.clone().setY(dir.y * 0.3).normalize();
  const side = new THREE.Vector3(-d.z, 0, d.x).normalize().multiplyScalar((Math.random() - 0.5) * (y > 0.9 ? 0.25 : 0.18));
  const target = new THREE.Vector3(0, y, 0).add(side);
  const hit = onRest(target.clone().addScaledVector(d, -2), d);
  if (hit && rest) spotFrom(setOf(name), rest.mesh.geometry, hit, color, radius);
}

/**
 * Player `name` (their figure turned `yaw`, at `at`) was hit by paint from a shooter at `from` (world): a spot on
 * their rest pose, on the side that faces the shooter.
 */
export function paintFromAt(name: string, from: THREE.Vector3, at: THREE.Vector3, yaw: number, color: THREE.Color, radius: number): void {
  const d = at.clone().sub(from).setY(0);
  if (d.lengthSq() < 1e-6) d.set(0, 0, -1);
  paintFrom(name, d.normalize().applyAxisAngle(UP, -yaw), color, radius);
}

/** What a page needs to see another player's paint shot land (main.ts). */
export interface ShotScene {
  /** The other players' figures (net/avatars.ts group) and the zombies' hit boxes */
  figures: THREE.Object3D;
  zombies: THREE.Object3D;
  /** Whether a wall stands between two points (world/collision.ts blocked) */
  blocked: (a: THREE.Vector3, b: THREE.Vector3) => boolean;
  /** Whether player `name` can be hit by `by` now (alive, in the fight, not on their team) */
  target: (name: string, by: string) => boolean;
  /** A paint hit on a zombie (world/zombies.ts paint), and the burst and sound where it landed */
  zombie: (id: number, ray: THREE.Ray, color: THREE.Color, size: number) => void;
  burst: (point: THREE.Vector3, normal: THREE.Vector3, color: THREE.Color) => void;
}

/** Each gun's splat on a wall (m across): weapon.ts SPLAT's numbers, for the shots of others. */
const SPLAT: Record<string, number> = { pistol: 0.5, rifle: 0.45, shotgun: 0.32, sniper: 0.65 };
/** The paint's radius on a figure (m) from gun `w`, as a shot of yours puts it there (splats.ts stick). */
export const gunSplat = (w: string): number => figureSplat(Math.min(0.32, (SPLAT[w] ?? SPLAT.pistol) * 0.62));

const _boxes: THREE.Object3D[] = [];
const _list: THREE.Intersection[] = [];
const lastGun = new Map<string, string>();

/** The gun player `name` last fired (a paint shot of theirs this page saw), for the colour of their paint. */
export const gunOf = (name: string): string | null => lastGun.get(name) ?? null;

/**
 * Another player fired in the paint look (a `shot` the server passed on): where their aim (`yaw`, `pitch`, as their
 * figure is drawn) from `eye` meets a player's or a zombie's hit box first, with no wall between, that figure takes
 * the paint, with a burst. The server decides the hit; this is only what the page shows, from what it already knows.
 * Only the figures' hit boxes and the wall blocks are tested, never the whole scene: a few hundredths of a millisecond.
 */
export function paintFromShot(s: ShotScene, shooter: string, gun: string, eye: THREE.Vector3, yaw: number, pitch: number): void {
  lastGun.set(shooter, gun);
  const color = new THREE.Color(GUN_PAINT[gun] ?? GUN_PAINT.pistol);
  const size = SPLAT[gun] ?? SPLAT.pistol;
  const radius = gunSplat(gun);
  _boxes.length = 0;
  s.figures.traverseVisible((o) => {
    if (o.userData.player !== undefined && o.userData.player !== shooter) _boxes.push(o);
  });
  for (const o of s.zombies.children) if (o.visible) _boxes.push(o);
  if (!_boxes.length) return;
  const rays = gun === 'shotgun' ? 4 : 1;
  const done = new Set<unknown>();
  for (let k = 0; k < rays; k++) {
    const spread = gun === 'shotgun' ? 0.045 : 0.008;
    const y = yaw + (Math.random() - 0.5) * 2 * spread;
    const p = pitch + (Math.random() - 0.5) * 2 * spread;
    const dir = new THREE.Vector3(-Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p));
    _ray.set(eye, dir);
    _ray.far = 150;
    _list.length = 0;
    _ray.intersectObjects(_boxes, false, _list);
    _list.sort((a, b) => a.distance - b.distance);
    const first = _list[0];
    if (!first || s.blocked(eye, first.point)) continue;
    const who = first.object.userData.player as string | undefined;
    const zid = first.object.userData.zombie as number | undefined;
    if (who !== undefined) {
      if (done.has(who) || !s.target(who, shooter)) continue;
      let mesh: THREE.SkinnedMesh | undefined;
      for (let o: THREE.Object3D | null = first.object; o && !mesh; o = o.parent) mesh = o.userData.paintMesh as THREE.SkinnedMesh | undefined;
      if (!mesh) continue;
      mesh.updateMatrixWorld(true);
      const hit = paintRay(mesh, eye, dir, 150, paintColour(shooter, color), radius);
      if (!hit) continue;
      done.add(who);
      s.burst(hit.point, dir.clone().negate(), paintColour(shooter, color));
    } else if (zid !== undefined && !done.has(zid)) {
      done.add(zid);
      s.zombie(zid, _ray.ray.clone(), color, size);
      s.burst(first.point, dir.clone().negate(), color);
    }
  }
}

/** Player `name` is back in the game: their figures clean. */
export function clearPaint(name: string): void {
  const s = sets.get(name);
  if (s) {
    s.n.value = 0;
    s.next = 0;
  }
}

/** Out of the paint look: every figure clean. */
export function clearAllPaint(): void {
  for (const name of sets.keys()) clearPaint(name);
}
onPaintball((on) => {
  if (!on) clearAllPaint();
});

/** How many spots player `name` wears (tests, the dev hook). */
export const paintCount = (name: string): number => sets.get(name)?.n.value ?? 0;
