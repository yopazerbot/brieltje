import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { gradedOutput } from './grade';
import { BloomPass } from './bloom';
import { AimAssist } from './controls/aimAssist';
import { NO_INPUT } from './controls/input';
import { onPadLabels } from './controls/padFamily';
import { FAR_PHONE, gpuName, guessFromName, loadMode, ORDER, pickQuality, PRESETS, saveMode, timeFrames, type Mode, type Preset, type Quality } from './graphics';
import { HEIGHT as BODY_HEIGHT, Player, STEP_UP } from './player';
import { Hud } from './ui/hud';
import { Speedometer } from './ui/speedometer';
import { fillScreen, input, me, menu, onAccount, onSession, sessionAdmin, setAccount, startIntent } from './start';
import { TouchControls } from './controls/touch';
import { Games, type ModeView } from './ui/games';
import { CLOWN_DEFAULTS, Clowns, KINDS, type Kind } from './world/clowns';
import { bruteDamage, hurtBy } from '../shared/brutes.mjs';
import { prepareShotRaycasts } from './world/shotRaycast';
import { Zombies } from './world/zombies';
import { Villagers } from './world/villagers';
import { FootballGround } from './world/footballGround';
import { FootballLife } from './world/footballLife';
import { Christmas } from './world/christmas';
import { fakeDay, seasonNow } from './world/season';
import { Sinterklaas } from './world/sinterklaas';
import { SintMaarten } from './world/sintmaarten';
import { TownBoard } from './world/townBoard';
import { BIG as BIG_ZOMBIE, bigOf, Horde, houseAreas, makeNav } from '../shared/zombies.mjs';
import { Loot, LOOT } from '../shared/loot.mjs';
import { Rewards } from './world/rewards';
import WEAPON_SPECS from '../shared/weapons.json';
import { Horses } from './world/horses';
import { Bikes } from './world/bike';
import { AdminPanel } from './ui/admin';
import { Chat } from './ui/chat';
import { Combat } from './ui/combat';
import { Leaderboard } from './ui/leaderboard';
import { Minimap, type Blip } from './ui/minimap';
import { ASK_AFTER, FeedbackCard } from './ui/feedback';
import { HomeCodeCard } from './ui/homeCode';
import { LoadoutCard } from './ui/loadout';
import { gunPicture } from './ui/gunPictures';
import { cleanPick, LOADOUT, startingWeapons } from '../shared/loadout.mjs';
import { HomeLocks } from './world/homeLocks';
import { barrierHeights, findHome, homeAt, inEndGarden } from '../shared/homes.mjs';
import { ControlsCard } from './ui/controlsCard';
import spawns from '../shared/spawns.json';

/** The spawn points round the house (the bungalow's are for its team in the teams game). */
const HOUSE_SPAWNS = spawns.flatMap((s, i) => (s.team === 'house' ? [i] : []));
/** Those out of doors: alone the house is shut, so you come back in the street or the garden. */
const OUTSIDE_SPAWNS = HOUSE_SPAWNS.filter((i) => spawns[i].outside);
import { api, errorText, Net, type Me, type Rules, type ServerMsg } from './net/client';
import { Rooms } from './ui/rooms';
import { PadNav } from './ui/padNav';
import { Avatars } from './net/avatars';
import type { Body } from './net/swat';
import { Parachutes } from './world/parachutes';
import { DropView } from './world/dropView';
import { DROP, dropFrom, dropStart, HOME_DROP } from '../shared/parachute.mjs';
import { netClock } from './net/track';
import { PROTO, readBike, readBrute, readCar, readHorse, readPlayer, readZombie, type Tick } from '../shared/wire.mjs';
import { sound } from './sound';
import { footstep, surfaceOf } from './footsteps';
import { PlayTower, TOWER } from './world/playground';
import { creak, SlideSound } from './world/playgroundSound';
import { towerPrompt } from './world/playgroundHint';
import { SettingsPanel, type Settings } from './settings';
import { SPECS, Weapon, type WeaponId } from './weapon';
import { paintball, setPaintball, weaponName as shownWeapon } from './paintball';
import { Decals } from './world/decals';
import { Effects, type Spot } from './world/effects';
import { GRENADE, Grenades } from './world/grenades';
import { Pickups } from './world/pickups';
import { Cats } from './world/cats';
import { Car, placedSpec, PLACED_MAX, type CarState } from './world/car';
import { carLights } from './world/carLights';
import { skidMarks } from './world/skidMarks';
import { boxesOverlap, boxPoints, clearOfPortals, indoorName, makeIndoors } from '../shared/parking.mjs';
import CARS from '../shared/car.json';
import BIKES_DATA from '../shared/bike.json';
import { buildHedges, buildTile, dipMesh, onTreesLeftOut, setTreeDetail, treeKey, treesLeftOut, waterMesh } from './world/surroundings';
import { neverCards, treesMayPaint, unpaintedOut } from './world/leafCards';
import { setWaterDetail, waterLevel, wetGround } from './world/water';
import { buildHorizon } from './world/horizon';
import { wearLonePatches, weatherYards } from './world/yards';
import { Undergrowth } from './world/undergrowth';
import { GroundShade } from './world/groundShade';
import { SunShadow } from './world/sunShadow';
import { groundPiece, groundPieceCoarse, groundPieces, groundSkirt, pieceOf, PIECE, terrain, type GroundCuts } from './world/terrain';
import { SHADOW_LAYER, splitTiles, Tiles } from './world/tiles';
import { Furnishing, buildFixtures, footprint, type Piece } from './world/furnishing';
import { findThing, thingNames, type Thing } from './spawn';
import { Doors } from './world/doors';
import { Glass } from './world/glass';
import { World } from './world/collision';
import { loadEnvironment } from './world/environment';
import { house, type DipSpec, type Prism, type Ring, type VillageData } from './world/houseData';
import { loadProps } from './world/props';
import { blockMaterial, buildHouseMeshes, claimCovers, grassMaterial, groundFamilies, setAnisotropy, surfaceMaterial, tintedMaterial } from './world/houseMeshes';
import { patchFields } from './world/fields';
import { addDiag, startDiag } from './ui/diag';
import { IndoorLight } from './world/indoorLight';
import { Weather } from './world/weather';
import { Torch } from './world/torch';
import { warmPasses } from './world/warmShaders';
import { snowOnModel } from './world/snowCover';
import { Acoustics, acoustics } from './world/acoustics';
import { MoodAdmin, moodNotice } from './ui/moodAdmin';
import { Portals } from './world/portals';
import { TravelPanel } from './ui/travel';
import { PlacesList } from './ui/places';
import { destination, DESTINATIONS, findPlace, fold, foundLine, placeLines, type Destination } from './places';
import { BigMap, type Mark } from './ui/bigmap';
import { key } from './shortcuts';
import { typing } from './keys';
import { route, streetAt } from './ui/route';
import { HomeLife } from './world/homeLife';
import { Football } from './world/football';
import { Smoke } from './world/smoke';
import { LOOT_LABELS, Tactics } from './ui/tactics';
import { ZombieWaveControl } from './ui/zombieWave';
import { chooseSoloWave, soloRecord } from './ui/soloWave';
import { HomeStreet, withoutModelled } from './world/homeStreet';
import { buildRoadDetail, buildRoadDetailSoon, roadPaint, withRoadDetail } from './world/roadDetail';
import { RoadLife } from './world/roadLife';
import { looseProps, type Mover } from './world/looseProps';
import { Crash } from './world/crash';
import { TyreSpray } from './world/tyreSpray';
import { clearOpenGround, fitStreetModel, loadStreetModel } from './world/streetModel';
import { claimModelGround, claimModelGroundSoon } from './world/modelGround';
import { GroundCutter, releaseGroundClaims } from './world/groundCutter';
import { bakeLight, setBakeDetail } from './world/bakedLight';
import { setWindowDetail, setWindowNight } from './world/windows';
import { wet, WetMirror, wetOnModel } from './world/wetGround';
import { glass as glassLook, GlassProbe, glassOnModel } from './world/glassLook';
import { mood } from './world/mood';
import { loadWalkIn, type WalkIn } from './world/walkIn';
import { Insides, type InsidePack } from './world/insides';
import { CAR_REACH, CAR_SLOW, findPortal, PORTALS, portalNear, REACH, type Portal } from '../shared/portals.mjs';
import { noShoot } from '../shared/zones.mjs';
import { loadBounds, type Bounds } from '../shared/bounds.mjs';
import { arenaEdge, arenaHome, arenaOf, arenaSpots, portalOf, villageGround, type Arena } from '../shared/arenas.mjs';
import BOUNDS from '../shared/bounds.json';
import CHURCH_DATA from '../shared/church.json';
import { churchPrisms, makeChurch } from '../shared/church.mjs';
import CAFE_DATA from '../shared/sparrenhof.json';
import HUTS_DATA from '../shared/tree_huts.json';
import { cafePrisms, makeCafe } from '../shared/sparrenhof.mjs';
import { carName, doorName, lang, onLang, placeName, portalName, serverText, setLang, t, whoName } from './i18n';
import { seat, tellHost } from './seat';

// The world. This module is fetched and run on the first start (src/start.ts, the page's entry,
// with the start screen): before that the page has loaded no texture, model, sky or sound.
const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
// three asks the graphics driver for a shader's error log the first time each one is used, and the driver makes
// the page wait for the answer: 5 to 31 ms a shader on this PC, also for shaders compiled in the background long
// before. A dozen of them fell in the first second of play (the stutter while you drop in). Only while developing,
// and with ?diag in the address (the panel for a phone that draws black): a broken shader then says why.
renderer.debug.checkShaderErrors = import.meta.env.DEV || new URLSearchParams(location.search).has('diag');
// Render at normal resolution even on high-DPI laptop screens: the extra
// pixels cost more frame time than they add on a mid-range GPU.
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
// A device that runs out of graphics memory drops the 3D view and the screen goes black: say so.
canvas.addEventListener('webglcontextlost', () => {
  const note = document.createElement('div');
  note.className = 'context-lost';
  note.textContent = t('ctx.lost');
  document.body.append(note);
});

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.05, 2000);
startDiag(renderer, scene, () => quality); // only with ?diag in the address
scene.environmentIntensity = 0.9;

// The sun: sharp shadows. Its direction is set from the sky photo once that loads.
const center = new THREE.Vector3(4.5, 0, 3);
const sun = new THREE.DirectionalLight('#fff1de', 3.2);
sun.target.position.copy(center);
sun.position.copy(center).add(new THREE.Vector3(30, 40, 40));
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = sc.bottom = -17;
sc.right = sc.top = 17;
sc.near = 5;
sc.far = 140;
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.025;
sun.shadow.camera.layers.enable(SHADOW_LAYER); // the shadow-only stand-ins (world/tiles.ts): the near trees' lighter crowns
scene.add(sun, sun.target);
// Where its shadow map lies: on the house (Low), or following the eye (Medium and up; world/sunShadow.ts).
const sunShadow = new SunShadow(sun, center);
// The photographed sky is empty below the horizon, so add the light that
// bounces off the ground and floors (it is what lights ceilings).
const hemi = new THREE.HemisphereLight('#dfe9f5', '#b9a487', 0.9);
scene.add(hemi);
const indoorLight = new IndoorLight(hemi, scene); // warmer and stronger indoors
const wantedSun = new THREE.Vector3(...((house.sun?.dir as [number, number, number]) ?? [0.55, 0.32, 0.77]));
const environmentReady = loadEnvironment(renderer, scene, sun, wantedSun);
// Loading, shown on the start button that was picked: textures and sky first (to 80%), then the
// graphics test. Once it is done, play begins (menu.ready).
let loadShare = 0;
function loading(share: number, text?: () => string): void {
  loadShare = Math.max(loadShare, share);
  menu.progress(loadShare, text);
}
let worldReady = false;
function loaded(): void {
  if (worldReady) return; // the time limit, and Auto chosen again later in the settings, come here too
  worldReady = true;
  // Where to start, picked on the start screen (src/start.ts): the main house as ever, or another
  // portal place, arrived at as through its portal. The village's places wait for the village.
  const at = startPlace();
  // Zombies picked on the start screen (alone or a room): on the ground at its place, no drop and no start place for
  // the server to drop you at either (Yoshi, 7 Nov 2026: no parachute in Zombies). The game puts you at its start.
  const zombiesStart = startIntent.zombies !== null;
  const begin = () => {
    if (at) {
      arrive(at, null);
      if (!zombiesStart) {
        if (!me && rules.parachute !== false) beginDrop(); // alone: by parachute (together the server says so, see 'spawn')
        // In multiplayer the server is told: now if its welcome came already (it usually does), or when it comes.
        if (welcomed) net.send({ t: 'spawn', to: at.id });
        else spawnPending = at;
      }
    } else if (!zombiesStart && rules.parachute !== false) {
      // The house's start by parachute too (Yoshi), down the lane onto it: alone now, together when the server says so.
      if (!me) beginDrop(HOME_DROP);
      if (welcomed) net.send({ t: 'spawn', to: 'home' });
      else spawnPending = 'home';
    }
    loading(1);
    setTimeout(() => {
      menu.ready(); // the bar full for a moment, then play
      playBegun();
    }, 150);
  };
  if (at?.village) {
    loading(0.92, () => t('travel.village'));
    // Its shaders were compiled for the preset before the test: once more for the one picked (nothing new if the same).
    void loadVillage().then(() => precompile(scene)).then(begin, begin);
  } else begin();
  setTimeout(() => void loadVillage(), 500); // playing: now the village
  setTimeout(() => life.load(precompile), 900); // and the gardens' things, birds and the mower
  setTimeout(() => rules.parachute !== false && void parachutes.load(), 1200); // and the parachute, if the start didn't bring it in
  setTimeout(() => void startCountryside(), 900); // and the countryside's life
}
setTimeout(loaded, 25000); // never keep the player waiting forever
/** The start place picked on the start screen (the church by default), or null for the main house, where the world itself starts. */
let spawnPending: Portal | 'home' | null = null; // sent with the server's welcome: a start place, or the house's start by parachute
let welcomed = false; // the server's welcome has come (a start place can be sent straight away)
function startPlace(): Portal | null {
  let id = (document.getElementById('spawn') as HTMLSelectElement | null)?.value ?? 'church'; // the church square unless picked otherwise (Yoshi)
  try {
    id = localStorage.getItem('briel.spawn') ?? id;
  } catch {
    // storage blocked: the select's value
  }
  if (startIntent.place) id = startIntent.place; // Zombies picked on the start screen: its place (src/start.ts)
  return id === 'house' ? null : PORTALS.find((p) => p.id === id) ?? null;
}
THREE.DefaultLoadingManager.onProgress = (_url, done, total) => loading((done / Math.max(1, total)) * 0.8, () => t('load.progress'));
const texturesReady = new Promise<void>((resolve) => {
  THREE.DefaultLoadingManager.onLoad = () => resolve();
});

// Grass on the relief (world/terrain.ts), textured at real size (UVs in metres): the grid in
// pieces of 400 m (what is behind the camera is left out), the dips cut out of it, and a skirt
// beyond the grid out to 3 km.
const phone = matchMedia('(pointer: coarse)').matches;
if (phone) neverCards(); // a phone never shows the leaf-card trees: none are built (world/leafCards.ts)
const grassMat = grassMaterial(renderer);
// A little behind in depth: a field or yard a few millimetres above it would flicker with it far off.
grassMat.polygonOffset = true;
grassMat.polygonOffsetFactor = 2;
grassMat.polygonOffsetUnits = 2;
const groundCuts: GroundCuts = { cells: [...(house.groundCuts?.cells ?? [])], tris: [...(house.groundCuts?.tris ?? [])] };
const grass = new THREE.Group();
/** Each piece of the ground: drawn in full near the eye, its coarse version (16 m squares) when all of it is further than GROUND_FAR. */
const groundMeshes = new Map<string, { near: THREE.Mesh; far: THREE.Mesh; box: THREE.Box3 }>();
const GROUND_FAR = 250;
/** (Re)make one piece of the ground, with the cuts known now. */
function layGround(pi: number, pj: number, geometry = groundPiece(house.ground, groundCuts, pi, pj)): void {
  const old = groundMeshes.get(`${pi},${pj}`);
  if (old) {
    grass.remove(old.near, old.far);
    old.near.geometry.dispose();
    old.far.geometry.dispose();
  }
  const cx = terrain.x0 + (pi + 0.5) * PIECE * terrain.step;
  const cz = terrain.z0 + (pj + 0.5) * PIECE * terrain.step;
  geometry.translate(-cx, 0, -cz);
  const pieces = [geometry, groundPieceCoarse(house.ground, pi, pj, cx, cz)].map((g) => {
    const mesh = new THREE.Mesh(g, grassMat);
    mesh.position.set(cx, 0, cz);
    mesh.receiveShadow = true;
    mesh.userData.material = 'grass';
    mesh.renderOrder = 1; // after the fields, yards and floors on it: the hidden lawn under them isn't shaded first
    grass.add(mesh);
    return mesh;
  });
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!.clone().translate(new THREE.Vector3(cx, 0, cz));
  pieces[1].visible = false;
  groundMeshes.set(`${pi},${pj}`, { near: pieces[0], far: pieces[1], box });
}
/** The near or the far version of each piece of the ground, by how far the eye is from its nearest point. */
function groundDetail(eye: THREE.Vector3): void {
  for (const g of groundMeshes.values()) {
    const near = g.box.distanceToPoint(eye) < GROUND_FAR;
    g.near.visible = near;
    g.far.visible = !near;
  }
}
{
  const [pnx, pnz] = groundPieces();
  for (let pj = 0; pj < pnz; pj++) for (let pi = 0; pi < pnx; pi++) layGround(pi, pj);
  const skirt = new THREE.Mesh(groundSkirt(house.ground), grassMat);
  skirt.receiveShadow = true;
  skirt.userData.material = 'grass';
  skirt.renderOrder = 1;
  grass.add(skirt);
}
scene.add(grass);
function addDips(dips: DipSpec[]): void {
  for (const d of dips) {
    scene.add(dipMesh(d, house.ground, grassMat));
    const water = waterMesh(d, house.ground);
    if (water) scene.add(water);
  }
}
addDips(house.dips ?? []);

// The house, the bungalow and the garden, in one group that is hidden from far off (the village).
const home = new THREE.Group();
scene.add(home);
// The blocks an inside stands in for (the solid slabs) are meshes of their own, hidden when the inside comes (world/insides.ts).
const built = buildHouseMeshes(house.prisms.filter((p) => p.k === undefined), renderer, true);
home.add(built.group);
const keyedMeshes = new Map<string, THREE.Object3D>(house.prisms.filter((p) => p.k !== undefined).map((p) => {
  const mesh = buildHouseMeshes([p], renderer, true).group;
  home.add(mesh);
  return [p.k!, mesh];
}));
const hedgeLumps = buildHedges(house.prisms);
home.add(hedgeLumps);
// The surroundings (Flemish open data: the neighbours' houses and roofs, roads, fields, hedges,
// trees) in tiles of 200 m (world/tiles.ts), each hidden beyond the draw distance: the ring's now,
// the village's once play has begun (loadVillage). The horizon moves with the eye.
const tiles = new Tiles();
const poles = [...(house.surroundings?.poles ?? [])];
// The weather and time of day (world/weather.ts): alone the settings' pick, together the admin's; lamps on these poles at night.
const weather = new Weather(renderer, scene, sun, indoorLight, environmentReady, poles, house.ground);
// The torch on your gun, on by itself in the dark (world/torch.ts): made now, before any shader is compiled. Not on phones.
const torch = phone ? null : new Torch(scene);
const detailAt: [number, number][] = [[4.45, -3]]; // trees get their full crowns within 160 m of these (and the village's landmarks)
const detail = (x: number, z: number) => detailAt.some(([cx, cz]) => Math.hypot(x - cx, z - cz) < 160);
// The houses round the two portals at home are our own models (world/homeStreet.ts): their open-data blocks aren't drawn.
if (house.surroundings) wearLonePatches(house.surroundings); // light patches away from the buildings: worn ground (world/yards.ts)
const ringData = withoutModelled(house.surroundings ?? { roofs: [], trees: [] });
const ringTiles = (s: typeof ringData.kept) => [...splitTiles(withRoadDetail(s))].map(([key, t]) => ({ key, pieces: buildTile(t, poles, renderer, house.ground, detail) }));
// The streets in detail (world/roadDetail.ts) in place of the plain road surface: the ring's now, the village's with it.
// One surface per spot (world/groundLayers.ts): the house's and the bungalow's own ground claimed first
// (world/modelGround.ts), then the ring's covers, then the streets built (cut under both) and the covers last.
claimModelGround([built.group], house.ground);
claimCovers(withRoadDetail(ringData.kept).prisms ?? [], house.ground);
const ringRoads = buildRoadDetail(false, renderer, house.ground);
tiles.addSet(ringTiles(ringData.kept), true);
tiles.addSet(ringRoads.tiles, true);
const homeStreet = new HomeStreet(tiles, renderer, house.ground, ringData.removed, (s) => tiles.addSet(ringTiles(s), true));
/**
 * The houses at home's baked light and wear (world/bakedLight.ts), part of loading as the sky and the textures: their
 * materials change and compile behind the loading screen, before the graphics test measures a frame. Pages that
 * fail, or don't come within HOME_BAKE_MS, are left out: loading goes on and the houses keep real-time light.
 */
const HOME_BAKE_MS = 8000;
const homeBakeReady: Promise<void> = homeStreet.ready
  .then(() => {
    claimModelGround([homeStreet.group], house.ground); // their own surfaces one over another cut (world/modelGround.ts)
    const until = performance.now() + HOME_BAKE_MS;
    return Promise.race([bakeLight(homeStreet.group, renderer, until), new Promise<void>((r) => setTimeout(r, HOME_BAKE_MS))]);
  })
  .then(() => precompile(homeStreet.group))
  .then(() => undefined, () => undefined);
const horizon = buildHorizon(center, house.ground);
weather.horizon = horizon as THREE.Mesh; // fades into the weather's haze
scene.add(tiles.group, horizon);
// Shadows and soft corners on the ground of the whole neighbourhood, worked out once the sun's
// direction is known (the real-time sun shadow only covers the house).
const groundShade = new GroundShade(center, sunShadow.uniforms);
groundShade.apply(grassMat, 0.35, true);
groundShade.addGrass(house.surroundings?.grass); // the gardens' stripes and the meadows
// The garden's own paths, drive and planted borders too (not the terraces: one is on the roof).
for (const m of [...groundFamilies(renderer), roadPaint, surfaceMaterial('paving', renderer), surfaceMaterial('bed', renderer)]) groundShade.apply(m as THREE.MeshStandardMaterial);
// The yards and gravel round the houses weathered, after the shading (world/yards.ts).
weatherYards(['pave_light', 'gravel'].map((n) => blockMaterial(n, renderer).material as THREE.MeshStandardMaterial));
// Ferns, brambles and shrubs on the woods' floor round the eye (world/undergrowth.ts), in the ground's shade.
const undergrowth = new Undergrowth(groundShade.uniforms);
undergrowth.addWoods(house.surroundings?.prisms, house.surroundings?.trees);
scene.add(undergrowth.group);
// The fields' rows (world/fields.ts) from the start: their large shader is compiled while loading. Added when the
// countryside came, the fields waited for it, and the game stopped for up to two seconds just after it began.
patchFields(blockMaterial('field_soil', renderer).material as THREE.MeshStandardMaterial);
void Promise.all([environmentReady, homeStreet.ready]).then(() => {
  tiles.showAll(); // the ring's tiles beyond the draw distance throw shadows too
  groundShade.bake(renderer, scene, sun, [built.group, hedgeLumps, doors.group, tiles.group], house.ground);
});

// Post-processing: ambient occlusion darkens corners and contact areas the
// way real light does (computed at half resolution, which is hard to tell
// apart and far cheaper); SMAA smooths jagged edges; the output pass applies
// tone mapping and the colour grade (src/grade.ts).
// The scene's depth goes into a texture (each of the composer's two targets its own), for the ambient occlusion.
const depthTarget = () => new THREE.DepthTexture(window.innerWidth, window.innerHeight);
const target = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, { type: THREE.HalfFloatType, depthTexture: depthTarget() });
const composer = new EffectComposer(renderer, target);
composer.renderTarget2.depthTexture = depthTarget();
// Wet ground mirrors the street (world/wetGround.ts): its picture is drawn first, while it is wet, on Medium and up.
// Glass mirrors the street round the eye (world/glassLook.ts): one of its six views drawn a frame, Medium and up.
const glassProbe = new GlassProbe(scene, camera, [camera, weather.rain.mesh, weather.snowfall.mesh]);
composer.addPass(glassProbe);
const wetMirror = new WetMirror(scene, camera, [camera, weather.rain.mesh, weather.snowfall.mesh], house.ground);
composer.addPass(wetMirror);
wetMirror.paused = () => menu.open && !menu.onStartScreen; // behind the pause menu the puddles keep their last picture
glassProbe.sun = sun; // the light it was drawn in, to tell when to draw it again
glassProbe.views = seat?.views ?? 1; // the split screen's views each draw their own: rarely there
composer.addPass(new RenderPass(scene, camera));
const ao = new GTAOPass(scene, camera, window.innerWidth, window.innerHeight);
ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.5, scale: 1.2, samples: 12 });
ao.blendIntensity = 0.9;
// The ambient occlusion reads the depth the scene was just drawn with, and works the surfaces' normals out from it.
// It used to draw the whole scene a second time for its own depth and normals (about 400 draw calls and 1.4 million
// triangles on High, about a quarter of the frame on a weak graphics chip). This depth is also the true one: a wire
// fence's gaps, glass, sprites and the zombies' posed bodies come out as they are drawn, where that second drawing,
// with one plain material for everything, had to leave them out.
ao.setGBuffer(target.depthTexture!);
{
  const own = ao.render.bind(ao);
  ao.render = (r, write, read, dt, mask) => {
    // The scene is drawn into the composer's read buffer, which alternates between its two targets.
    const depth = read.depthTexture;
    ao.gtaoMaterial.uniforms.tDepth.value = depth;
    ao.pdMaterial.uniforms.tDepth.value = depth;
    own(r, write, read, dt, mask);
  };
}
composer.addPass(ao);
const bloom = new BloomPass(); // the glow round bright light, Medium and up (src/bloom.ts)
composer.addPass(bloom);
composer.addPass(gradedOutput(bloom.output));
const smaa = new SMAAPass();
composer.addPass(smaa);
warmPasses(renderer, ao, smaa); // their shaders compile in the background while the world loads (world/warmShaders.ts)

// Graphics quality: a preset sets resolution, soft shadows, sun shadow detail,
// edge smoothing and texture sharpness. On top of that, the resolution can dip
// to 75% for a moment when frames take too long.
const gpu = gpuName(renderer);
let mode: Mode = loadMode();
let quality: Quality = mode === 'auto' ? guessFromName(gpu) : mode;
let preset: Preset = PRESETS[quality];
let dynScale = 1;

/**
 * Resize everything to the window. The canvas keeps the preset's scale: a dip while frames run long changes only
 * what the scene is drawn into (rescale), stretched onto the canvas by the last pass. A new canvas size clears the
 * canvas, and on an iPhone that showed as a dark flicker in the sky whenever the resolution dipped or rose again.
 */
function resize(): void {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(preset.scale);
  renderer.setSize(window.innerWidth, window.innerHeight);
  rescale();
}

/** The scene's drawing resolution: the preset's, dipped while frames run long. */
function rescale(): void {
  const scale = preset.scale * dynScale;
  composer.setPixelRatio(scale);
  composer.setSize(window.innerWidth, window.innerHeight);
  const aoDiv = preset.ao === 'full' ? 1 : 2;
  ao.setSize((window.innerWidth * scale) / aoDiv, (window.innerHeight * scale) / aoDiv);
}

/**
 * Before drawing: the sun's shadow map round the eye, or on the house (world/sunShadow.ts), and the tiles round
 * it drawn into it. The house's map isn't worked out far from the house (the village). Drawn once a frame: left
 * to three (autoUpdate), every draw of the scene in a frame drew it again, the ambient occlusion's too (High, Ultra).
 */
function placeShadow(): void {
  sunShadow.update(camera);
  tiles.shadowAt(sunShadow.middle.x, sunShadow.middle.z, sunShadow.follows);
  renderer.shadowMap.autoUpdate = false;
  if (sunShadow.follows || camera.position.distanceTo(center) < 250) renderer.shadowMap.needsUpdate = true;
}

function applyQuality(q: Quality): void {
  quality = q;
  preset = PRESETS[q];
  ao.enabled = preset.ao !== 'off';
  smaa.enabled = preset.smaa;
  sun.castShadow = preset.shadowMap > 0;
  sun.shadow.radius = preset.shadowSoft; // softer edges on the bigger presets (graphics.ts)
  if (preset.shadowMap && sun.shadow.mapSize.x !== preset.shadowMap) {
    sun.shadow.mapSize.set(preset.shadowMap, preset.shadowMap);
    sun.shadow.map?.dispose();
    sun.shadow.map = null; // rebuilt at the new size on the next frame
    // Also away from the house, where the shadow isn't updated: without a map every surface that takes the
    // shadow drew nothing (Auto dropping a preset in the village emptied the screen).
    renderer.shadowMap.needsUpdate = true;
  }
  sunShadow.setup(preset.shadowReach, preset.shadowMap);
  placeShadow();
  bloom.setDivisor(preset.bloom);
  setAnisotropy(preset.anisotropy);
  setBakeDetail(q !== 'low'); // the baked wear's fine pattern (world/bakedLight.ts)
  weather.setQuality(q, phone); // how many streaks of rain
  setWindowDetail(q !== 'low' && !phone); // rooms behind the village's windows (world/windows.ts)
  setWaterDetail(q !== 'low' && !phone); // rain rings on the ponds (world/water.ts)
  wetMirror.fine = q !== 'low' && !phone; // wet streets mirror the scene, puddles ring (world/wetGround.ts)
  wet.fine.value = wetMirror.fine ? 1 : 0;
  wetMirror.scale = q === 'medium' || seat ? 4 : 2; // the puddles' picture at a quarter on Medium and in the split screen, else half
  glassProbe.fine = wetMirror.fine; // glass mirrors the street, rooms behind the models' windows (world/glassLook.ts)
  glassProbe.perFrame = q === 'ultra' ? 3 : q === 'high' ? 2 : 1; // views of the street's picture each frame: it keeps up
  glassLook.fine.value = wet.fine.value;
  setTreeDetail(q !== 'low' && !phone); // the near trees' crowns and the trunks (world/surroundings.ts)
  tiles.drawDistance = phone ? Math.min(FAR_PHONE, preset.far) : preset.far;
  undergrowth.setQuality(q, phone);
  dynScale = 1;
  resize();
}
applyQuality(quality);

let slowTime = 0;
let fastTime = 0;
/** Development only (briel.three.holdQuality): the preset and the resolution stay as they are, for measuring frame times */
let qualityHeld = false;
/** Seconds after play begins or resumes when the resolution is left alone: what comes into view loads then. */
const SETTLE = 4;
/**
 * During play: dip the resolution when frames run long; in Auto, drop a preset if that is not enough.
 * Called before the frame is drawn: a new size clears the canvas, and after drawing the page showed
 * through for a frame (a dark flash, two or three times while joining).
 */
function adaptQuality(dt: number, now: number): void {
  // The first seconds load and compile the world round you: hitches once, not a slow computer. (Held: a measurement's, below.)
  if (now - resumedAt < SETTLE * 1000 || qualityHeld) {
    slowTime = fastTime = 0;
    return;
  }
  if (dt > 1 / 52) slowTime += dt;
  else slowTime = Math.max(0, slowTime - dt);
  if (dt < 1 / 58) fastTime += dt;
  else fastTime = 0;
  if (slowTime > 0.6) {
    slowTime = 0;
    // Weak graphics are limited by pixels, so Low may dip further.
    const lowest = quality === 'low' ? 0.6 : 0.75;
    // First fewer views a frame of the glass's picture of the street (world/glassLook.ts), then the resolution.
    if (glassProbe.ease()) return;
    if (dynScale > lowest) {
      dynScale = Math.max(lowest, dynScale - 0.1);
      rescale();
    } else if (mode === 'auto' && quality !== 'low') {
      applyQuality(ORDER[ORDER.indexOf(quality) - 1]);
      menu.setGraphics(mode, quality, gpu);
    }
  } else if (fastTime > 4 && dynScale < 1) {
    fastTime = 0;
    dynScale = Math.min(1, dynScale + 0.1);
    rescale();
  } else if (fastTime > 4 && glassProbe.unease()) fastTime = 0;
}

const churchAccess = makeChurch(CHURCH_DATA, house.ground + terrain.height(...CHURCH_DATA.origin as [number, number]));
const cafeAccess = makeCafe(CAFE_DATA, house.ground + terrain.height(...CAFE_DATA.origin as [number, number]), HUTS_DATA); // the café's blocks and stairs to its roofs, and the tree huts
// The Sparrenhof's forecourt, terrace and café stand where the open data has wood: no ferns or logs on them, nor under the tree huts.
undergrowth.addBare([...cafeAccess.clear, ...cafeAccess.outlines, ...cafeAccess.huts.map((h) => h.footprint)].map((ring) => [ring as [number, number][]]));
const world = new World(house.prisms, house.ground);
world.addPrisms(house.surroundings?.prisms ?? []);
world.addPrisms(homeStreet.blocks);
world.addPrisms(ringRoads.blocks); // the pavements, a few centimetres up
const playTower = new PlayTower(TOWER, house.ground); // the school's play tower: its platform, ladder and slide (world/playground.ts)
world.addPrisms(playTower.prisms());
const slideSound = new SlideSound();
world.setDips(house.dips ?? []);
// The edge of the game (shared/bounds.json): round the built-up area, or round the two houses while a game in the house runs.
const edges = loadBounds(BOUNDS);
world.bounds = edges.map;
world.ceiling = edges.ceiling;
const player = new Player(world, house.spawn);
player.tower = playTower;
player.onRung = creak;
// Phones and tablets: touch controls (offered on any touch screen: src/start.ts).
const touch = new TouchControls();
document.getElementById('rotate-hint')!.before(touch.root);
input.touch = touch;
const hud = new Hud();
const speedometer = new Speedometer(document.getElementById('hud')!);
const doors = new Doors(house.doors, world, (name) => surfaceMaterial(name, renderer));
home.add(doors.group);
// The ground shading's shaders compile before its bake, in the background where the browser can (world/groundShade.ts warm).
groundShade.warm(renderer, scene, sun, [built.group, hedgeLumps, doors.group, tiles.group], house.ground);
// Party games the admin starts (multiplayer): hide and seek, tag, treasure hunt.
const games = new Games();
scene.add(games.group);
loadProps(house.props ?? [], scene, world);
// Built-in furniture (it comes with a home's inside data): drawn like the other pieces, not movable.
const fixtures = buildFixtures(house.fixtures ?? [], world);
if (fixtures) home.add(fixtures);
scene.add(camera); // the weapon hangs off the camera
const weapon = new Weapon(camera, scene);
const glass = new Glass(built.panes, world, scene);
glass.add(doors.panes, (i, broken) => doors.setBroken(i, broken));
// The main house, the bungalow and the end house open only with their codes (src/world/homeLocks.ts): shut doors and panes, and a
// barrier the shape of each inside for walking. Panes of no home hold alone, as before.
const homeLocks = new HomeLocks({
  barrier: (key, ring, y0, y1) => world.setMoving(`home-${key}`, ring, ...barrierHeights(y0, y1, STEP_UP, BODY_HEIGHT), true), // the server's rule: the feet from y0 up to y1
  changed: () => doors.refresh(),
  relocked: () => (putOutside(), furnishing.redraw()),
}, house.prisms, house.doors);
doors.lockedHome = (id) => homeLocks.lockedOfDoor(id);
doors.refresh();
glass.locked = (i) => {
  const home = homeLocks.homeOfPane(i);
  return home ? !homeLocks.isOpen(home) : !me;
};
const effects = new Effects(scene, new Decals(scene), (x, z, y) => world.groundAt(x, z, y, 0).y);
looseProps.attach(scene, world, effects.particles); // the street's bins, bikes, letterboxes and posts that cars knock over (world/looseProps.ts)
const crash = new Crash(effects.particles);
Car.onCrash = (hit) => crash.hit(hit); // sparks, dust or leaves, and a crunch, by what a car hit (world/crash.ts)
const tyreSpray = new TyreSpray(effects.particles, world); // behind the wheels on a wet road
const grenades = new Grenades(world);
scene.add(grenades.group);
const pickups = new Pickups((x, z, y) => world.groundAt(x, z, y + 0.3, 0).y);
scene.add(pickups.group);
// The Zombies game's rewards lying and the claymores down (shared/loot.mjs: the server's together, this page's alone).
const rewards = new Rewards((x, z, y) => world.groundAt(x, z, y + 0.4, 0).y,
  (id, ring, bottom, top) => world.setMoving(`stakes-${id}`, ring, bottom, top, true));
const tactics = new Tactics(scene, () => {
  if (net.connected && !menu.open && combat.alive) net.send({ t: 'rally' });
});
rewards.onBurst = (points) => {
  for (const p of points) effects.splinters(p);
};
rewards.onSpent = (at) => effects.puff(at);
scene.add(rewards.group);
const cats = new Cats((x, z) => world.groundAt(x, z, 0.5, 0).y);
scene.add(cats.group);
// Clowns (our own model): a few from the start; more spawned with /clown or /strongman.
const clowns = new Clowns(
  (x, z, y) => world.groundAt(x, z, y + 0.5, 0).y,
  (x, z, y) => world.boxFree(x, z, 0, 0.3, 0.3, y + 0.35, y + 1.2),
);
clowns.setAll(CLOWN_DEFAULTS);
scene.add(clowns.group);
let localClown = 1000; // ids for clowns placed alone
// The Zombies game's zombies (our own models, world/zombies.ts): the server's together, this page's alone.
const zombies = new Zombies((x, z, y) => world.groundAt(x, z, y, 0).y, world, () => quality === 'low' || phone);
scene.add(zombies.group, zombies.hits);
// The controller's aim assist against zombies only (src/controls/aimAssist.ts): no snap through a wall.
const aimAssist = new AimAssist(zombies.hits, (a, b) => !world.blocked(a, b, 0.25));
// Their shaders compile in the background (see precompile) once the models and the sky's light are in, and again
// as a Zombies game begins (a moment if nothing changed): hidden until a wave comes, they would compile on first
// draw and stop the game just as the zombies appear. The sky's light changes their shader, so not before it.
// (?zcold in the dev build leaves it out, to measure that stop.)
function prepareZombies(): void {
  if (import.meta.env.DEV && location.search.includes('zcold')) return;
  void Promise.all([zombies.ready, environmentReady]).then(([ok]) => {
    if (!ok) return;
    for (const tx of zombies.textures()) renderer.initTexture(tx); // the bone picture (0.6 MB) up now, not with the first zombie
    return precompile(zombies.group);
  });
}
prepareZombies();
// Villagers walking and cycling round the village, in every mode but Zombies (world/villagers.ts); loaded the first time they are needed.
const villagers = new Villagers(world, () => quality === 'low' || phone, (root) => precompile(root));
const villagerLook = new THREE.Vector3();
scene.add(villagers.group);
// FC Smetlede's football ground (world/footballGround.ts) and its training and watchers (world/footballLife.ts).
// (?nofootball in the dev build leaves it out, to compare.)
const noFootball = import.meta.env.DEV && location.search.includes('nofootball');
const fcGround = new FootballGround(house.ground, phone, () => quality === 'low' || phone);
const fcLife = new FootballLife(villagers, fcGround.y, () => quality === 'low' || phone, (id) => fcGround.goal(id));
if (!noFootball) scene.add(fcGround.group, fcLife.group);
// December (world/season.ts): the Christmas lights and the tree, and Sinterklaas on the church square (only in Explore).
const christmas = new Christmas(world, (x, z) => house.ground + terrain.height(x, z), (root) => precompile(root));
const sinterklaas = new Sinterklaas(world, (x, z) => house.ground + terrain.height(x, z), (root) => precompile(root));
// November: Sint-Maarten on the square in the week up to the 11th, lanterns and carrots on his evenings (world/sintmaarten.ts).
const sintMaarten = new SintMaarten(world, (x, z) => house.ground + terrain.height(x, z), (root) => precompile(root));
scene.add(christmas.group, sinterklaas.group, sintMaarten.group);
// The notice board on the church square with the best Zombies runs behind its glass (world/townBoard.ts); its blocks from the start, its model with the village.
const townBoard = new TownBoard(world, (x, z) => house.ground + terrain.height(x, z));
scene.add(townBoard.group);
// Three horses grazing in the meadow across the road.
const horses = new Horses(world);
scene.add(horses.group);
let horseWanted = -1; // asked the server for this horse
let clockOffset = 0; // the shared clock minus this page's (s), for the herds in the meadows
let countryside: import('./world/countryside').Countryside | null = null;
horses.onDust = (at) => effects.impact(at, new THREE.Vector3(0, 1, 0), 'cat'); // a little dust at a gallop
// The cars (the Tesla on our driveway, the Model 3 at the bungalow, a Model Y and a Model 3 by the
// church, there once the village is); they stop against tree trunks too (the trees have no blocks).
// `car` is the one you are in, or else the nearest.
const trunks = (house.surroundings?.trees ?? []).map((t) => ({ x: t.x, z: t.z, r: 0.35 }));
// Trees left out round the house and the church have no trunk to stop against (kept in place: cars and bikes share it).
const pruneTrunks = () => {
  for (let i = trunks.length - 1; i >= 0; i--) if (treesLeftOut.has(treeKey(trunks[i].x, trunks[i].z))) trunks.splice(i, 1);
};
onTreesLeftOut.add(pruneTrunks);
pruneTrunks();
const cars = Object.entries(CARS.cars).map(([id, spec]) => new Car(world, trunks, id, spec));
for (const c of cars) scene.add(c.group);
scene.add(skidMarks.mesh); // the tyre marks every car leaves when it slides (world/skidMarks.ts)
scene.add(carLights.group); // the cars' headlights and tail lights at night (world/carLights.ts)
let car = cars[0];
const carById = (id: string) => cars.find((c) => c.id === id);
let driving = false;
let riding = false; // in the passenger seat (multiplayer): the car moves you, the camera follows it
let wantCar = false; // asked the server to get in, waiting for its answer
// The bikes (world/bike.ts): against the main house, at the bungalow, in racks by the village's portals.
const bikes = new Bikes(world, trunks, () => avatars.figure(me?.username ?? '', myColour()));
scene.add(bikes.group);
let bikeWanted: string | null = null; // asked the server for this bike
// What knocks the street's loose things about: the cars and bikes being ridden (yours and the others', as drawn), and you on foot.
// One list and one record per mover, kept from frame to frame (no new objects every frame).
const moverList: Mover[] = [];
const moverOf = new Map<string, Mover>();
const mover = (key: string, vehicle: boolean, bump?: (s: number) => void): Mover => {
  let m = moverOf.get(key);
  if (!m) moverOf.set(key, (m = { key, x: 0, z: 0, y: 0, height: 0, yaw: 0, halfL: 0, halfW: 0, r: 0, vehicle, bump }));
  return m;
};
looseProps.movers = () => {
  moverList.length = 0;
  for (const c of cars) {
    if (!c.ready || !((driving && c === car) || !!c.driver)) continue;
    const m = moverOf.get(c.id) ?? mover(c.id, true, (s) => c.bump(s));
    m.x = c.x;
    m.z = c.z;
    m.y = c.y;
    m.height = 1.5;
    m.yaw = c.yaw;
    m.halfL = c.spec.length / 2;
    m.halfW = c.spec.width / 2;
    moverList.push(m);
  }
  for (const k of bikes.riders()) {
    const m = mover(`bike-${k.id}`, true);
    m.x = k.x;
    m.z = k.z;
    m.y = k.y;
    m.height = 1.6;
    m.yaw = k.yaw;
    m.halfL = 0.85;
    m.halfW = 0.2;
    moverList.push(m);
  }
  if (!driving && !riding && !bikes.mounted && horses.mounted < 0 && !player.flying && player.chute === null) {
    const m = mover('me', false);
    m.x = player.x;
    m.z = player.z;
    m.y = player.feet;
    m.height = 1.8;
    m.r = 0.3;
    moverList.push(m);
  }
  return moverList;
};
const minimap = new Minimap([...house.prisms, ...(house.surroundings?.prisms ?? [])], house.levels, house.rooms);
/** The ground out of doors at (x, z): the relief, and paving or a kerb on it. */
const groundY = (x: number, z: number) => world.groundAt(x, z, house.ground + terrain.height(x, z) + 0.6, 0).y;
const portals = new Portals(groundY);
scene.add(portals.group);
// Life round the house and the bungalow: things in the gardens, birds, a robot mower (world/homeLife.ts).
const life = new HomeLife(world, groundY, () => !phone && quality !== 'low');
scene.add(life.group);
// The footballs on the school's playground and the back lawn (world/football.ts); a goal says so near it.
const football = new Football(scene, (x, z) => house.ground + terrain.height(x, z));
football.onGoal = (g) => {
  const pitch = football.views.find((v) => v.id === g.pitch)!.pitch;
  if (g.pitch === 'fc') fcGround.goal(pitch.goals[g.goal]?.id ?? ''); // the net swells
  if (Math.hypot(player.x - pitch.home.x, player.z - pitch.home.z) > 80) return;
  const score = t('ball.score', { a: g.score[0] ?? 0, b: g.score[1] ?? 0 });
  hud.announce(t('ball.goal'), g.by ? t('ball.goalBy', { name: g.by, score }) : score);
};
const roadLife = new RoadLife(world, tiles, groundY); // the traffic, parked cars, street signs and the church bells
scene.add(roadLife.group);
const travelPanel = new TravelPanel();
const bigMap = new BigMap(document.getElementById('map-mount')!, house.prisms, house.surroundings, house.rooms, house.dips ?? []);
// The inside of a home arrives with its right (a code, the admin, or a session the server says has it): world/insides.ts.
const insides = new Insides({
  renderer, home, scene, world, doors, glass, locks: homeLocks, minimap, bigMap, keyed: keyedMeshes,
  roofs: house.surroundings?.roofs ?? [],
  endHouse: () => endHouse,
  installed: (pack) => insideInstalled(pack),
});
homeLocks.onOpen = (id, pack) => void insides.open(id, pack);
bigMap.setEdge(edges.map.ring);
minimap.setGround((g, k) => bigMap.paintGroundGame(g, k), () => bigMap.groundVersion); // the ground under the minimap, everywhere
const mapBtn = document.getElementById('map-btn')!;

// The furniture: shared through the server when logged in, kept in this browser otherwise. New pieces
// come with /name in the chat (src/spawn.ts), and /remove takes one away (see spawnThing).
const furnishing = new Furnishing(world);
home.add(furnishing.group);
// Furniture round the house and the bungalow hides with them from far off; a piece placed elsewhere
// (a chair on the church square) is drawn on its own, or it would vanish with the house as you place it.
const homeArea = new THREE.Box3().setFromObject(built.group).expandByScalar(20);
furnishing.homeArea = (x, z) => x >= homeArea.min.x && x <= homeArea.max.x && z >= homeArea.min.z && z <= homeArea.max.z;
scene.add(furnishing.away);
tiles.track(home, new THREE.Box3().setFromObject(built.group));
const LOCAL_FURNITURE = 'briel.furniture';
let localId = -1;
// Pieces inside a home are neither drawn nor in the way until the home is open to this page (the starting layout is private
// data too: it comes with each home's inside, see seedLocalFurniture).
furnishing.visible = (p) => {
  const h = homeAt(p.x, p.z, p.y);
  return !h || homeLocks.isOpen(h);
};
/** The starting layout of the homes that are open, as pieces with local ids. */
const startLayout = (): Piece[] => {
  let id = -1;
  return insides.layout().flatMap((l) => l.pieces.map(([item, x, y, z, yaw]) => ({ id: id--, item: String(item), x: Number(x), y: Number(y), z: Number(z), yaw: Number(yaw) })));
};
const LOCAL_RESTORE = 'briel.furnitureRestore';
function loadLocalFurniture(): void {
  try {
    const saved = localStorage.getItem(LOCAL_FURNITURE);
    const list = saved === null ? startLayout() : (JSON.parse(saved) as Piece[]);
    furnishing.setAll(list);
    localId = Math.min(-1, ...list.map((p) => p.id)) - 1;
  } catch {
    furnishing.setAll([]);
  }
}
/**
 * Playing alone, a home's starting pieces go in once its inside has come, the first time or when the layout asks for them
 * again (its "restore" number, over any changes inside that home). A browser that kept its furniture from before keeps it.
 */
function seedLocalFurniture(pack: InsidePack): void {
  if (net.connected) return;
  const layout = insides.layout().find((l) => l.id === pack.id);
  if (!layout || !layout.pieces.length) return;
  try {
    const key = `${LOCAL_RESTORE}.${pack.id}`;
    const restore = String(layout.layoutRestore);
    const done = localStorage.getItem(key) ?? localStorage.getItem(LOCAL_RESTORE); // the global key: written before the homes were split
    if (localStorage.getItem(LOCAL_FURNITURE) !== null && done === restore) return;
    const kept = [...furnishing.pieces.values()].filter((p) => homeAt(p.x, p.z, p.y) !== pack.id);
    let id = Math.min(-1, ...kept.map((p) => p.id)) - 1;
    const start = startLayout().filter((p) => homeAt(p.x, p.z, p.y) === pack.id).map((p) => ({ ...p, id: id-- }));
    furnishing.setAll([...kept, ...start]);
    localId = id;
    localStorage.setItem(key, restore);
    saveLocalFurniture();
  } catch {
    // private window: the furniture lasts for this visit
  }
}
function saveLocalFurniture(): void {
  try {
    localStorage.setItem(LOCAL_FURNITURE, JSON.stringify([...furnishing.pieces.values()]));
  } catch {
    // private window: the furniture lasts for this visit
  }
}
loadLocalFurniture();
/** A new piece of furniture (spawned with /name): the server's together, this browser's alone. */
function putFurniture(p: Omit<Piece, 'id'>): void {
  if (net.connected) net.send({ t: 'furn', op: 'put', ...p });
  else {
    furnishing.put({ ...p, id: localId-- });
    saveLocalFurniture();
  }
}
function removeFurniture(id: number): void {
  if (net.connected) net.send({ t: 'furn', op: 'del', id });
  else {
    furnishing.remove(id);
    saveLocalFurniture();
  }
}
/** A clown or a strongman spawned with /clown or /strongman, or taken away. */
function addClown(at: { x: number; y: number; z: number; kind: Kind }): void {
  if (net.connected) net.send({ t: 'clown', op: 'add', ...at });
  else clowns.setAll([...clowns.list, { id: localClown++, ...at }]);
}
function removeClown(id: number): void {
  if (net.connected) net.send({ t: 'clown', op: 'remove', id });
  else clowns.setAll(clowns.list.filter((c) => c.id !== id));
}

// Teslas spawned with /tesla (shared/car.json: placed): real cars like the four above, in `cars` with a
// `kind`. In multiplayer the server keeps them, checks every spot and decides who drives (the admin's
// any, a player's their own when the admin allows spawning). Alone anyone's, kept in this browser.
let indoorsAt = makeIndoors([...house.prisms, ...(house.surroundings?.prisms ?? [])], []);
// The echo of where you are and the walls between you and the sounds of out of doors (world/acoustics.ts).
const roomSound = (acoustics.now = new Acoustics({ ...CHURCH_DATA, ground: churchAccess.point([0, 0, 0]).y }, (x, z, y) => indoorsAt(x, z, y)));
const placedCars = () => cars.filter((c) => c.kind);
/** A placed Tesla taken away: if you sit in it, you get out first. */
function removePlaced(c: Car): void {
  if (c === car && (driving || riding)) getOut(false);
  if (c === car) {
    wantCar = false;
    car = cars[0];
  }
  c.dispose();
  if (cars.includes(c)) cars.splice(cars.indexOf(c), 1);
}
/** A placed Tesla into the game (drawn, solid, drivable); null for an unknown kind or one too many. */
function addPlaced(st: CarState): Car | null {
  const spec = placedSpec(st.kind ?? '', st);
  if (!spec || placedCars().length >= PLACED_MAX) return null;
  const c = new Car(world, trunks, st.id, spec, st.kind);
  cars.push(c);
  scene.add(c.group);
  return c;
}
/**
 * The placed Teslas as `list` has them (the server's, or this browser's alone): new ones in, the
 * others taken away, a parked one put where the list says (the admin moved it). One someone else
 * drives follows its ticks; the one you drive stays yours.
 */
function setPlaced(list: CarState[]): void {
  const want = new Map(list.filter((st) => typeof st.id === 'string' && st.kind).map((st) => [st.id, st]));
  for (const c of placedCars()) if (want.get(c.id)?.kind !== c.kind) removePlaced(c);
  for (const st of want.values()) {
    const c = carById(st.id) ?? addPlaced(st);
    if (!c) continue;
    c.driver = st.driver ?? null;
    c.passenger = st.passenger ?? null;
    c.park = { x: st.x, y: st.y, z: st.z, yaw: st.yaw };
    const turned = Math.abs(Math.atan2(Math.sin(c.yaw - st.yaw), Math.cos(c.yaw - st.yaw))) > 0.002;
    const moved = Math.hypot(c.x - st.x, c.z - st.z) > 0.02 || Math.abs(c.y - st.y) > 0.02;
    if (!st.driver && !(driving && c === car) && (moved || turned)) c.place(st.x, st.y, st.z, st.yaw);
  }
}
/**
 * Whether a Tesla of `kind` may stand at (x, z) facing `yaw`, as the server checks it again
 * (game.mjs parkingProblem), and its height there: on the ground (the drive, the road or the grass,
 * not on a wall or a roof), inside the edge of the game, off the portals, outdoors, clear of walls,
 * hedges, fences, furniture, trees, other cars and people. `id`: the placed one being moved.
 */
function teslaFits(kind: string, x: number, z: number, yaw: number, floorY: number, id?: string): { ok: boolean; y: number } {
  const bare = house.ground + terrain.height(x, z);
  const y = world.groundAt(x, z, bare + 0.3, 0).y; // paving and kerbs, a few centimetres up
  const spec = placedSpec(kind, { x, y, z, yaw });
  if (!spec || floorY > bare + 2) return { ok: false, y };
  const halfL = spec.length / 2;
  const halfW = spec.width / 2;
  const box = { x, z, yaw, halfL, halfW };
  const people = [...avatars.obstacles(), ...(driving || riding ? [] : [{ x: player.x, z: player.z, r: 0.35 }]), ...trunks];
  const ok = y >= bare - 1.5
    && edges.map.boxInside(x, z, yaw, halfL, halfW) && (!world.bounds || world.bounds.boxInside(x, z, yaw, halfL, halfW))
    && clearOfPortals(box, PORTALS, REACH)
    && !boxPoints(x, z, yaw, halfL, halfW, 0.5).some(([px, pz]) => indoorsAt(px, pz))
    && !cars.some((c) => c.ready && c.id !== id && boxesOverlap(box, { x: c.x, z: c.z, yaw: c.yaw, halfL: c.spec.length / 2, halfW: c.spec.width / 2 }, 0.1))
    && !people.some((o) => boxesOverlap(box, { x: o.x, z: o.z, yaw: 0, halfL: o.r, halfW: o.r }))
    && world.boxFree(x, z, yaw, halfL, halfW, y + 0.3, y + spec.height, id ? `car-${id}` : undefined);
  return { ok, y };
}
/** The spawned Tesla a ray hits (/remove), with how far along it and whether someone is in it. */
function pickTesla(ray: THREE.Raycaster): { c: Car; distance: number; busy: boolean } | null {
  const hit = ray.intersectObjects(placedCars().filter((c) => c.group.visible).map((c) => c.group), true).find((h) => !h.object.userData.ignoreRay);
  let o: THREE.Object3D | null = hit?.object ?? null;
  while (o && o.userData.car === undefined) o = o.parent;
  const c = o ? carById(o.userData.car) : undefined;
  if (!hit || !c?.kind) return null;
  const mine = c === car && (driving || riding || wantCar);
  return { c, distance: hit.distance, busy: mine || !!c.driver || !!c.passenger };
}
const LOCAL_CARS = 'briel.cars';
let localCar = 1; // ids for the Teslas placed alone ('l1', 'l2' ...)
/** A new Tesla of `kind` (spawned with /tesla): the server's together, this browser's alone. */
function placeTesla(c: { kind: string; x: number; y: number; z: number; yaw: number }): void {
  if (net.connected) return net.send({ t: 'tesla', op: 'put', ...c });
  addPlaced({ id: `l${localCar++}`, kind: c.kind, x: c.x, y: c.y, z: c.z, yaw: c.yaw, s: 0, driver: null });
  saveLocalCars();
}
function removeTesla(id: string): void {
  if (net.connected) return net.send({ t: 'tesla', op: 'del', id });
  const c = carById(id);
  if (c?.kind) removePlaced(c);
  saveLocalCars();
}
/** Alone: the Teslas placed in this browser, each where it was put (one driven off is back there next time). */
function loadLocalCars(): void {
  let list: CarState[] = [];
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(LOCAL_CARS) ?? '[]');
    const ok = (v: unknown): v is CarState =>
      !!v && typeof v === 'object' && /^l\d{1,6}$/.test(String((v as CarState).id)) && typeof (v as CarState).kind === 'string'
      && [(v as CarState).x, (v as CarState).y, (v as CarState).z, (v as CarState).yaw].every((n) => typeof n === 'number' && Number.isFinite(n));
    if (Array.isArray(saved)) list = saved.filter(ok).slice(0, PLACED_MAX).map(({ id, kind, x, y, z, yaw }) => ({ id, kind, x, y, z, yaw, s: 0, driver: null }));
  } catch {
    // unreadable, or a private window: none
  }
  for (const c of placedCars()) removePlaced(c); // all of them anew, where they were put
  setPlaced(list);
  localCar = Math.max(0, ...list.map((st) => Number(st.id.slice(1)))) + 1;
}
function saveLocalCars(): void {
  try {
    localStorage.setItem(LOCAL_CARS, JSON.stringify(placedCars().map((c) => ({ id: c.id, kind: c.kind, ...c.park }))));
  } catch {
    // private window: they last for this visit
  }
}
loadLocalCars();
// Removing all the furniture, for everyone, asks a second click (a stray Enter or ✕ in the menu took it all once).
{
  const clear = document.getElementById('clearfurn-btn')!;
  const label = clear.querySelector('b')!;
  let armed = 0;
  clear.addEventListener('click', () => {
    if (!armed) {
      label.textContent = t('adm.clearFurnSure');
      armed = window.setTimeout(() => {
        armed = 0;
        label.textContent = t('adm.clearFurn');
      }, 4000);
      return;
    }
    clearTimeout(armed);
    armed = 0;
    label.textContent = t('adm.clearFurn');
    net.send({ t: 'furn', op: 'clear' });
  });
}
document.getElementById('resetfurn-btn')!.addEventListener('click', () => {
  if (net.connected) net.send({ t: 'furn', op: 'reset' });
  else {
    furnishing.setAll(startLayout());
    localId = -1 - startLayout().length;
    clowns.setAll(CLOWN_DEFAULTS); // and the characters spawned go
    for (const c of placedCars()) removePlaced(c); // and the Teslas (the four of the game stay)
    saveLocalFurniture();
    saveLocalCars();
  }
});
let mapTimer = 0;
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyN' && !e.repeat && !typing(e)) settings.toggle('minimap'); // the setting's shortcut (Settings: Minimap)
});
weapon.onImpact = (point, normal, material, on) => {
  effects.shot(point, normal, material, on);
  looseProps.shot(point, normal, on); // a post rings, a bin rocks
};
weapon.onPaintball = (from, to, paint) => effects.paintShot(from, to, paint);
weapon.onEject = (w) => effects.casing(camera, w, weapon.aimAmount);
weapon.onTracer = (from, to) => effects.tracer(from, to);
weapon.onBullet = (from, to, dt) => effects.bullet(from, to, dt);

/** The walking speed together: the real pace for everyone (alone, the menu's own). Running is 2.5 times it. */
const REAL_WALK = 1.4;
player.walkSpeed = menu.walkSpeed;

// Settings (pause menu): look speed, field of view, volume, inverted look, vibration.
const settings = new SettingsPanel();
function applySettings(s: Settings): void {
  player.mouseSens = s.mouse;
  player.stickSens = s.stick;
  player.invertY = s.invert;
  weapon.baseFov = s.fov;
  if (!weapon.enabled) {
    camera.fov = s.fov;
    camera.updateProjectionMatrix();
  }
  sound.setVolume(s.volume);
  touch.haptics = s.vibration; // a tick on the touch buttons where the phone can vibrate
  // The minimap (N) and the FPS counter (F, Create): settings, so touch and controller players have them too.
  document.getElementById('minimap')!.classList.toggle('hidden', !s.minimap);
  mapBtn.classList.toggle('hidden', !s.minimap);
  hud.showFps(s.fps);
  weather.setSolo(s.mood); // alone; together the admin's holds
}
settings.onChange = applySettings;
applySettings(settings.value);
// The admin's weather for everyone (ui/moodAdmin.ts; the server checks the sender and the value). The settings' picker shows it, greyed.
const moodAdmin = new MoodAdmin((msg) => {
  if (net.connected && me?.role === 'admin') net.send(msg);
});
const followMood = () => {
  const admin = net.connected && me?.role === 'admin';
  moodAdmin.update(admin, weather.serverMood, weather.serverSpeed);
  // The admin, together: the settings' own weather picker sets it for everyone too (Yoshi: "ik ben admin maar kan
  // het weer niet aanpassen"), through the same message and the same checks on the server.
  settings.setAdminMood(admin ? (mood) => net.send({ t: 'mood', mood }) : null, admin ? () => net.send({ t: 'moodskip' }) : null);
};
weather.onServer = (m) => {
  settings.lockMood(m);
  followMood();
};
settings.onSkip = () => weather.skip(); // "Next weather" alone
const rumble = (strong: number, weak: number, ms: number) => settings.value.vibration && input.rumble(strong, weak, ms);

// Footsteps: yours from the middle, the others' from where they walk; louder when running.
player.onStep = (speed) => {
  footstep(surfaceOf(player.ground.mat), Math.min(1, 0.25 + speed / 7));
  if (player.water) effects.splashes.step(player.x, player.z, player.water, speed, player.velocity.x, player.velocity.z); // world/splashes.ts
};
player.onLand = (speed) => {
  footstep(surfaceOf(player.ground.mat), Math.min(1, speed / 6));
  const level = waterLevel(player.x, player.z); // a jump into the water (the ground under you is its floor)
  if (level !== null && (player.ground.mat === 'water' || player.ground.mat === 'swim')) effects.splashes.plunge(player.x, player.z, level, speed);
  weapon.land(speed);
};
menu.onSpeed = (v) => (player.walkSpeed = me ? REAL_WALK : v);
// Paintball is Action with paint guns: the same weapon and fight, shown the friendly way (src/paintball.ts).
weapon.setEnabled(menu.playing !== 'explore');
setPaintball(menu.playing === 'paintball');
menu.onPlayMode = (play) => {
  const armed = weapon.enabled;
  weapon.setEnabled(play !== 'explore');
  setPaintball(play === 'paintball');
  if (!armed && weapon.enabled && playBegan) setTimeout(offerGuns, 400); // into Action or Paintball from Explore: choose your guns (once the menu is closed)
  combat.setActive((!!me || !!solo) && play !== 'explore'); // health shows together, and in a Zombies game alone
};

window.addEventListener('keydown', (e) => {
  // By the letter on the key, not its place: on an AZERTY keyboard M is where QWERTY has ; (movement stays by place: ZQSD is WASD).
  // Shift+M is the sound (src/start.ts, with the Sound and Full screen buttons).
  if (e.key.toLowerCase() !== 'm' || e.shiftKey || e.repeat || typing(e)) return;
  toggleMap();
});

// ---- Multiplayer: join on the start screen; the players (16 at once unless the admin allows fewer) share the house.
const net = new Net();
// ?diag: the connection, worked out again every second (ui/diag.ts).
let netSeen = { ...net.counts, at: performance.now() };
addDiag(() => {
  const c = net.counts;
  const now = performance.now();
  const s = Math.max(0.001, (now - netSeen.at) / 1000);
  const rate = (a: number, b: number) => ((a - b) / 1024 / s).toFixed(1);
  const line = net.connected
    ? `net: ping ${net.rtt ?? '?'} ms · ${netClock.rate} ticks/s · others drawn ${Math.round(netClock.delay)} ms behind (late ${Math.round(netClock.late)}, age ${Math.round(netClock.age)})\n` +
      `net: in ${rate(c.bytesIn, netSeen.bytesIn)} KB/s, ${Math.round((c.msgsIn - netSeen.msgsIn) / s)}/s · out ${rate(c.bytesOut, netSeen.bytesOut)} KB/s, ${Math.round((c.msgsOut - netSeen.msgsOut) / s)}/s`
    : '';
  netSeen = { ...c, at: now };
  return line;
});
const avatars = new Avatars();
scene.add(avatars.group);
avatars.onStep = (_name, at, speed) => {
  const ground = world.groundAt(at.x, at.z, at.y + 0.3, 0.6);
  const wet = wetGround(at.x, at.z, ground); // in a pond or ditch: a splash (world/water.ts)
  footstep(surfaceOf(ground.mat), Math.min(1, 0.35 + speed / 5), at);
  if (wet) effects.splashes.step(at.x, at.z, wet, speed);
};
avatars.groundAt = (x, z, y) => world.groundAt(x, z, y + 0.3, 0.6).y;
// Arriving by parachute (shared/parachute.mjs): everyone's on their figures (world/parachutes.ts), yours filmed
// from behind while you jump (world/dropView.ts).
const parachutes = new Parachutes();
parachutes.prepare = precompile; // its shaders built before it shows
const myChute = new THREE.Group();
scene.add(myChute);
const dropView = new DropView((colour) => avatars.figure(me?.username ?? '', colour), myChute, (x, z, y) => world.groundAt(x, z, y, 0).y);
avatars.onFigure = (name, root, body, colour, chute, open, air, dt) => parachutes.fly(name, root, body, colour, chute, open, air, dt, camera.position);
/**
 * Start a drop onto where you stand now (on the ground there, facing your way), or onto `at` facing its
 * yaw: from the drop's height over it, DROP.reach behind it so it lands there without steering
 * (shared/parachute.mjs). A skydive you steer yourself: the free fall, the canopy you open (or that opens by
 * itself), and a landing wherever you steer to. Alone when the rules allow it; together when the server says so,
 * from where it says (`sx`, `sz`). Alone a way in that leaves `edge` (the game's, or a Zombies place's) starts
 * straight over the place instead (shared/parachute.mjs dropFrom), and the edge keeps the drop inside.
 */
function beginDrop(at?: { x: number; z: number; yaw: number; feet?: number; sx?: number; sz?: number }, from?: { sx?: number; sz?: number }, edge = world.bounds): void {
  if (driving || riding || horses.mounted >= 0 || bikes.mounted) return;
  void parachutes.load(); // in case it isn't in yet
  const [x, z, yaw] = at ? [at.x, at.z, at.yaw] : [player.x, player.z, player.yaw];
  const told = from ?? at;
  const given = typeof told?.sx === 'number' && typeof told?.sz === 'number';
  const start = given ? { x: told!.sx!, z: told!.sz! } : edge ? dropFrom(x, z, yaw, (a, b) => edge.inside(a, b)) : dropStart(x, z, yaw);
  player.place(start.x, start.z, (at ? at.feet ?? groundY(x, z) : player.feet) + DROP.height, yaw, player.pitch);
  player.startDrop();
  player.update(0, NO_INPUT, camera);
}
/** Your figure for your parachute (world/dropView.ts), from your first drop on. */
let ownFigure: Body | null = null;
/** Your colour, as the others see it. */
const myColour = () => (me && online.get(me.username)) || '#e0733a';
/** After the player has moved: a drop filmed from behind (or the camera on its way back into your eyes). */
function filmDrop(dt: number): void {
  dropView.update(dt, camera, player, parachutes.has('', ownFigure));
}
/** The hint in a drop, with the keys of the way you play: the free fall's, then the canopy's. */
function dropPrompt(mode: 'kbm' | 'pad' | 'touch'): string {
  const move = mode === 'touch' ? t('prompt.stick') : key('move', mode);
  if (player.canopy !== null) return t('prompt.chute', { move });
  const [dive, open] = mode === 'touch' ? [t('touch.dive'), t('touch.open')] : [key('down', mode), key('jump', mode)];
  return t('prompt.fall', { move, dive, open });
}
avatars.seatOf = (name) => horses.seat(name) ?? bikes.seat(name); // a rider sits in the saddle as their horse (or bike) is drawn
const chat = new Chat();
chat.paused = () => menu.open; // T and Enter belong to the menu while it is open
const combat = new Combat();
const leaderboard = new Leaderboard();
// The controller in the pause menu: the D-pad moves between the open page's controls, ✕ presses (src/ui/padNav.ts).
const padNav = new PadNav(() => document.querySelector<HTMLElement>('#pause-panel [data-page]:not(.hidden)'));
// Zombies rooms in the Together tab (src/ui/rooms.ts, server/rooms.mjs): the list asked for while that tab shows.
const rooms = new Rooms(net, {
  me: () => me,
  watching: () => menu.open && !menu.onStartScreen && menu.tab === 'together',
  say: (text) => chat.system(text),
});
const admin = new AdminPanel();
const netStatus = document.getElementById('net-status')!;
const onlineBox = document.getElementById('online')!;
const online = new Map<string, string>(); // name -> colour
/** Who is online: in the HUD, and in the menu's Together tab with a dot in each player's colour. Names are text, never HTML. */
function showOnline(): void {
  onlineBox.replaceChildren();
  const list = document.getElementById('tog-players')!;
  list.replaceChildren();
  document.getElementById('tog-online')!.classList.toggle('hidden', !me || online.size === 0);
  if (!me || online.size === 0) return;
  const count = t('online.count', { n: online.size, max: rules.maxPlayers ?? 16 });
  const title = document.createElement('div');
  title.textContent = count;
  onlineBox.append(title);
  document.getElementById('tog-count')!.textContent = count;
  for (const [name, color] of online) {
    const label = name === me.username ? t('online.you', { name }) : name;
    const row = document.createElement('div');
    row.textContent = label;
    row.style.color = color;
    onlineBox.append(row);
    const item = document.createElement('li');
    const dot = document.createElement('i');
    dot.style.background = color;
    item.append(dot, label);
    list.append(item);
  }
}

const $ = (id: string) => document.getElementById(id)!;
/** House rules in multiplayer, set by the admin in the settings; alone everything is allowed. */
const ANYTHING_GOES: Rules = { flying: true, spawn: true, names: true, maxPlayers: 16, guests: true, portals: true, travel: true, paintball: false, parachute: true };
let rules = ANYTHING_GOES;
const flyBox = $('set-flying') as HTMLInputElement;
const spawnBox = $('set-spawn') as HTMLInputElement;
const namesBox = $('set-names') as HTMLInputElement;
const maxSlider = $('set-max') as HTMLInputElement;
const guestsBox = $('set-guests') as HTMLInputElement;
const portalsBox = $('set-portals') as HTMLInputElement;
const travelBox = $('set-travel') as HTMLInputElement;
const paintballBox = $('set-paintball') as HTMLInputElement;
const parachuteBox = $('set-parachute') as HTMLInputElement;
// The admin can move extremely fast (Yoshi): their own choice, kept on this device; the server lets an admin that fast.
const turboBox = $('set-turbo') as HTMLInputElement;
try {
  turboBox.checked = localStorage.getItem('briel.turbo') === '1';
} catch {
  // storage blocked: off
}
function applyTurbo(): void {
  // Together the admin; alone the admin's session too (its role from the server), as the speed is this page's own then.
  player.turbo = (me?.role === 'admin' || (!me && sessionAdmin())) && turboBox.checked ? 15 : 1;
}
turboBox.addEventListener('change', () => {
  try {
    localStorage.setItem('briel.turbo', turboBox.checked ? '1' : '0');
  } catch {
    // storage blocked: for this visit
  }
  applyTurbo();
});
function applyRules(next: Rules): void {
  rules = next;
  // No flying in the Zombies game (out of their reach for good; the server holds to it too).
  player.canFly = next.flying && !games.zombies;
  if (!player.canFly) player.flying = false;
  flyBox.checked = next.flying;
  spawnBox.checked = next.spawn ?? false;
  namesBox.checked = next.names;
  guestsBox.checked = next.guests ?? true;
  portalsBox.checked = next.portals ?? true;
  travelBox.checked = next.travel ?? true;
  paintballBox.checked = next.paintball ?? false;
  parachuteBox.checked = next.parachute ?? true;
  menu.setChildSafe(next.paintball ?? false); // child-friendly for everyone: Action plays as Paintball
  maxSlider.value = String(next.maxPlayers ?? 16);
  $('set-max-value').textContent = maxSlider.value;
  avatars.showNames = next.names && !games.hideOthers;
}
/** Spawning with /name: alone always; together the admin always, the others when the admin allows it (off at first). */
function maySpawn(): boolean {
  return !me || rules.spawn || me.role === 'admin';
}
/**
 * A house rule switch: sent to the server, which tells everyone (and this page) the new rules. Flipped
 * while the connection is down (a tab woken from sleep, reconnecting), it springs back and says so:
 * it used to stay on while the server never heard of it.
 */
function ruleSwitch(box: HTMLInputElement, rule: keyof Rules): void {
  box.addEventListener('change', () => {
    if (!net.connected) {
      box.checked = !box.checked;
      chat.system(() => t('adm.notConnected'));
      hud.setPrompt(t('adm.notConnected'));
      return;
    }
    net.send({ t: 'rules', [rule]: box.checked });
  });
}
ruleSwitch(flyBox, 'flying');
ruleSwitch(spawnBox, 'spawn');
ruleSwitch(namesBox, 'names');
ruleSwitch(guestsBox, 'guests');
ruleSwitch(portalsBox, 'portals');
ruleSwitch(travelBox, 'travel');
ruleSwitch(paintballBox, 'paintball');
ruleSwitch(parachuteBox, 'parachute');
maxSlider.addEventListener('input', () => ($('set-max-value').textContent = maxSlider.value));
maxSlider.addEventListener('change', () => net.send({ t: 'rules', maxPlayers: Number(maxSlider.value) }));
let wasTogether = false; // playing with the others until this account change
let homeUser: string | null = null; // the account the homes' locks were last set for
/** Out of a home that is locked for this player (its lock came back while they stood in it): in front of it, at its portal. */
function putOutside(): void {
  if (driving || riding) return;
  let home = homeAt(player.x, player.z, player.feet);
  if (!home && !player.flying && player.chute === null && inEndGarden(player.x, player.z, player.feet) && !homeLocks.isOpen('molenhoek_end')) {
    // The end house's fenced garden, which is only reached through the house: together the server moves the player (its copy
    // walks under the movement budget, so a move of the page's own would be pulled back across the house); alone the page does.
    if (net.connected) return net.send({ t: 'unstuck' });
    home = 'molenhoek_end';
  }
  if (!home || homeLocks.isOpen(home)) return;
  const to = PORTALS.find((p) => p.id === home);
  if (to) arrive(to, null);
}
/**
 * Alone or together: joining with the PIN and the admin's login work on the start screen, before
 * the world exists (src/start.ts). The world follows, once it is there and on every change
 * (onAccount, below the server's messages): the menu's Together and admin parts, the house rules,
 * and the connection to the others.
 */
function followAccount(account: Me | null): void {
  queueMicrotask(applyTurbo); // after `me` is set below: the admin's speed, or back to normal
  // The main house, the bungalow and the end house open only with their codes, alone and together (src/world/homeLocks.ts).
  // The admin needs none; a new session (joining, another account) starts locked, as the server has no grant for it. A Zombies game alone stops.
  if (account) stopSolo();
  // The admin sees every inside, playing together and playing alone (the session is the admin's then: the server
  // gives a home's inside to an admin session, and to no other without the code).
  homeLocks.setAdmin(account?.role === 'admin' || (!account && sessionAdmin()));
  if (account && (!wasTogether || account.username !== homeUser)) homeLocks.lockAll();
  homeUser = account?.username ?? null;
  // Together everyone walks and runs at the real pace; alone, the speed you chose (the server holds
  // running to the real pace too, server/game.mjs).
  player.walkSpeed = account ? REAL_WALK : menu.walkSpeed;
  menu.lockSpeed(account ? REAL_WALK : null);
  if (!account) glass.repair(); // leaving the others: whole panes again
  if (!account) weather.setServer(null); // alone: the settings' own weather again
  wasTogether = !!account;
  $('mp-join-here').classList.toggle('hidden', !!account);
  $('mp-leave').classList.toggle('hidden', !account);
  $('scores-col').classList.remove('hidden'); // the board of best Zombies runs, alone too
  chat.setEnabled(true); // alone too, for commands (/location kerk)
  chat.setAlone(!account);
  admin.show(account?.role === 'admin' ? account.username : null);
  $('newround-btn').classList.toggle('hidden', account?.role !== 'admin');
  $('clearfurn-btn').classList.toggle('hidden', account?.role !== 'admin');
  $('resetfurn-btn').classList.toggle('hidden', !!account && account.role !== 'admin');
  showAdminParts();
  if (!account) applyRules(ANYTHING_GOES);
  weapon.setAdminWeapons(!account || account.role === 'admin');
  leaderboard.show(!!account); // the best Zombies runs for everyone to see; the fights' totals together only
  rooms.follow(account);
  $('game-admin').classList.toggle('hidden', account?.role !== 'admin');
  if (!account) {
    followGame({ kind: 'free' }); // with its clean-up: the server's zombies, rewards and Zombies kit go too
    clowns.setAll(CLOWN_DEFAULTS); // alone: the starting clowns again
  }
  if (account) net.connect();
  else {
    net.disconnect();
    avatars.clear();
    online.clear();
    for (const c of cars) c.driver = c.passenger = null; // alone, the cars are yours
    horses.reset(); // and the horses back on their walks
    bikes.reset(); // and the bikes nobody else rides now
    combat.me = '';
    combat.reset([], 10, null);
    loadLocalFurniture();
    loadLocalCars(); // the Teslas placed alone, instead of the shared ones
  }
  showOnline();
  combat.setActive(!!account && weapon.enabled);
  showSoloButton();
}
// Another language: the texts made here that aren't drawn every frame (the modules redraw their own).
onLang(() => {
  showOnline();
  netStatus.textContent = netText();
  if (menu.open && !menu.onStartScreen && me?.role === 'admin') admin.show(me.username);
});

chat.onSend = (text) => {
  if (text.startsWith('/')) command(text);
  else if (me) net.send({ t: 'chat', text });
  else chat.system(() => t('chat.aloneHint')); // alone nothing is sent anywhere: only commands
};
games.onSend = (msg) => net.send(msg);
// Zombies: a short banner as each wave begins (the big italic line, as on arriving through a portal).
games.onWave = (n, count, bigs) => hud.announce(t('z.banner', { n }), t(bigs > 1 ? 'z.bannerBigs' : bigs ? 'z.bannerBig' : 'z.bannerSub', { count }));
// The admin's games: a game starts at once; stopping one is asked again in the page, since a slip of the
// finger would end it for everyone.
const stopAsk = $('stop-confirm');
const zombieWaveControl = new ZombieWaveControl((wave) => {
  if (net.connected && me?.role === 'admin') net.send({ t: 'zwave', wave });
  else if (!me) soloWave(wave); // alone: the horde in this page (the admin's session only)
});
/** The wave picker works: together for the admin (the server decides), alone in Zombies for the admin's session. */
const waveAllowed = () => (net.connected && me?.role === 'admin') || (!me && !!solo && sessionAdmin());
/**
 * The admin tab's parts: all of them together; for the admin's session playing alone, what works in this page
 * (turbo, the solo Zombies' wave picker) and a line that the rest is for playing together (index.html .adm-together).
 */
function showAdminParts(): void {
  const alone = !me && sessionAdmin();
  $('set-admin').classList.toggle('hidden', me?.role !== 'admin' && !alone);
  $('set-admin').classList.toggle('alone', alone);
  applyTurbo();
  zombieWaveControl.update(games.view, waveAllowed());
}
document.querySelectorAll<HTMLButtonElement>('[data-game]').forEach((b) =>
  b.addEventListener('click', () => {
    stopAsk.classList.toggle('hidden', b.dataset.game !== 'free' || !games.active);
    if (b.dataset.game !== 'free') net.send({ t: 'mode', kind: b.dataset.game, ...(b.dataset.game === 'zombies' ? { place: ($('zombies-place-admin') as HTMLSelectElement).value } : {}) });
  }),
);
$('stop-yes').addEventListener('click', () => {
  stopAsk.classList.add('hidden');
  net.send({ t: 'mode', kind: 'free' });
});
$('stop-no').addEventListener('click', () => stopAsk.classList.add('hidden'));
// Lift every lockout on joining (wrong PINs, kicks), for a meetup where a few typos or one kick keep people out.
$('set-unlock').addEventListener('click', async () => {
  const msg = $('set-unlock-msg');
  try {
    await api.unlock();
    msg.textContent = t('adm.unlocked');
    msg.classList.remove('bad');
  } catch (e) {
    msg.textContent = errorText(e)();
    msg.classList.add('bad');
  }
});
weapon.onGlassHit = (i, point, from, normal, pane) => {
  if (glass.break(i, point, from)) net.send({ t: 'glass', i });
  else if (glass.locked(i)) {
    // A locked home's panes hold: the bullet chips off, and the way in is explained.
    effects.shot(point, normal, 'black_glass', pane);
    lockHint = 4;
    lockKey = homeLocks.homeOfPane(i) ? 'prompt.locked' : 'prompt.multiplayerOnly';
  }
};
weapon.onPlayerHit = (name, body, head, point, spot, w) => {
  if (games.friend(name)) return; // your own team in the teams game
  effects.hit(point, spot);
  avatars.flinch(name);
  if (!avatars.canBeHit(name)) return;
  combat.hitMarker(false, head > 0);
  net.send({ t: 'hit', target: name, w, body, head }); // `w`: the gun that fired it (a sniper's bullet lands a moment later)
};

/** Which way a hit came from, relative to where you look (0 = ahead, positive = left). */
function hitAngle(by: string): number | null {
  // A zombie's swipe: from the nearest one (the server names only the kind).
  const at = by === 'a zombie' || by === 'a big zombie' ? zombies.nearest(player.x, player.z) : avatars.position(by);
  if (!at) return null;
  return Math.atan2(-(at.x - player.x), -(at.z - player.z)) - player.yaw;
}
const weaponName = (w: string) => (w === 'grenade' || w in SPECS ? shownWeapon(w as WeaponId | 'grenade') : w === 'claymore' ? mineName() : w === 'turret' ? t('loot.turret') : '');
/** A claymore's name, or in paintball a paint mine's. */
const mineName = () => t(paintball.on ? 'loot.paintMine' : 'loot.claymore');

/**
 * Zombies' rewards (shared/loot.mjs): what you have (`kit`: the guns with bigger magazines, the scope,
 * claymores and rows of stakes carried), from the server together or this page's own loot alone.
 * `holdT`: how long the grenade key is held (a tap throws a grenade, held it places a claymore you
 * carry); `stakeT` the reload key (a tap reloads, held it plants a row of the stakes you carry);
 * `useT` the Use key with nothing to use (held, it sets up the turret you carry).
 */
type Kit = { ammo: string[]; scope: boolean; claymores: number; stakes?: number; turrets?: number };
const NO_KIT = { ammo: [], scope: false, claymores: 0, stakes: 0, turrets: 0 };
let kit = { ammo: [] as string[], scope: false, claymores: 0, stakes: 0, turrets: 0 };
let holdT = 0;
let stakeT = 0;
let useT = 0;
let rewardWait = 0;
let placementRequest = 0;
let placementSent = 0;
let placementResult: { id: number; ok: boolean; why?: string; a?: number; b?: number } | null = null;
let placementPoint: { x: number; z: number; kind: string; yaw: number } | null = null;
const HOLD_S = 0.8;
function applyKit(k: Kit, fresh?: string): void {
  kit = { ammo: [...k.ammo], scope: k.scope, claymores: k.claymores, stakes: k.stakes ?? 0, turrets: k.turrets ?? 0 };
  weapon.setKit(kit.ammo, kit.scope, fresh);
}
/** What you just took: on your gun or in your pocket, said in a banner and the chat. */
function gift(kind: string, w: string | undefined, k: Kit): void {
  applyKit(k, kind === 'ammo' ? w : undefined);
  if (kind === 'ammo' && w && w in SPECS) {
    const name = weaponName(w);
    const n = weapon.magOf(w as WeaponId);
    hud.announce(t(paintball.on ? 'loot.ammoPaint' : 'loot.ammo'), t('loot.ammoSub', { w: name, n }));
  } else if (kind === 'scope') hud.announce(t('loot.scope'), t('loot.scopeSub'));
  else if (kind === 'claymore') hud.announce(mineName(), t('loot.mineSub', { key: key('grenade', menu.mode ?? 'kbm') }));
  else if (kind === 'stakes') hud.announce(t('loot.stakes'), t('loot.stakesSub', { key: key('reload', menu.mode ?? 'kbm') }));
  else if (kind === 'turret') hud.announce(t('loot.turret'), t('loot.turretSub', { key: key('use', menu.mode ?? 'kbm') }));
}
/** Where something goes on the ground `ahead` m in front of you, or null (a wall between, a drop or a step up). */
function spotAhead(ahead: number): { x: number; y: number; z: number } | null {
  const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
  const x = player.x + fx * ahead, z = player.z + fz * ahead;
  const y = world.groundAt(x, z, player.feet + 0.4, 0).y;
  if (Math.abs(y - player.feet) > 0.6 || world.blocked({ x: player.x, y: player.feet + 0.3, z: player.z }, { x, y: y + 0.3, z })) return null;
  return { x, y, z };
}
/** Place a claymore you carry on the ground a step in front of you, facing where you look. */
function placeClaymore(): void {
  const at = spotAhead(0.9);
  if (!at) {
    chat.system(() => serverText('zMineSpot', {}, ''));
    return;
  }
  if (net.connected) net.send({ t: 'claymore', ...at, yaw: player.yaw });
  else if (solo) {
    const r = solo.loot.place(SOLO_ME, { x: player.x, y: player.feet, z: player.z }, { ...at, yaw: player.yaw }, performance.now());
    if (r.mine) applyKit(solo.loot.kit(SOLO_ME));
    else chat.system(() => serverText(r.why === 'max' ? 'zMineMax' : r.why === 'none' ? 'zMineNone' : 'zMineSpot', {}, ''));
  }
}
/** Set up the turret you carry on the ground a step in front of you; it aims and shoots by itself (the server's, together). */
function setUpTurret(): void {
  const at = spotAhead(1.0);
  if (!at) {
    chat.system(() => serverText('zMineSpot', {}, ''));
    return;
  }
  if (net.connected) net.send({ t: 'turret', ...at, yaw: player.yaw });
  else if (solo) {
    const r = solo.loot.placeTurret(SOLO_ME, { x: player.x, y: player.feet, z: player.z }, { ...at, yaw: player.yaw }, performance.now());
    if (r.turret) applyKit(solo.loot.kit(SOLO_ME));
    else chat.system(() => serverText({ none: 'zTurretNone', max: 'zTurretMax', all: 'zTurretAll', spot: 'zMineSpot' }[r.why ?? 'spot'], {}, ''));
  }
}
/**
 * A turret shot at zombie `zid`: it turns there and flashes, its shot is heard (softly, near ones only),
 * and the zombie gets a puff (or paint).
 */
function turretShot(tid: number, zid: number, rounds: number): void {
  const at = zombies.chest(zid);
  const muzzle = rewards.fire(tid, at, rounds);
  if (!muzzle || camera.position.distanceTo(muzzle) > 45) return;
  weapon.remoteShot(muzzle, 'rifle', 0.35);
  if (at) effects.zombieHit(at);
}
/** Plant a row of the stakes you carry across where you look, a long step in front of you (how wide is the floor's, on the server together). */
function plantStakes(): void {
  const at = spotAhead(1.3);
  if (!at) {
    chat.system(() => serverText('zStakesSpot', {}, ''));
    return;
  }
  if (net.connected) net.send({ t: 'stakes', ...at, yaw: player.yaw });
  else if (solo) {
    const r = solo.loot.placeStakes(SOLO_ME, { x: player.x, y: player.feet, z: player.z }, { ...at, yaw: player.yaw });
    if (r.row) applyKit(solo.loot.kit(SOLO_ME));
    else chat.system(() => serverText(r.why === 'max' ? 'zStakesMax' : r.why === 'none' ? 'zStakesNone' : 'zStakesSpot', {}, ''));
  }
}
const youName = () => me?.username ?? t('char.you');
/** A cat hit by a bullet, or caught in your blast (`w` 'grenade' or 'bazooka'). */
function catHit(i: number, point: THREE.Vector3, w: string): void {
  effects.puff(point); // a cartoon puff (or paint), no blood
  if (!cats.hit(i)) return;
  combat.hitMarker(true);
  combat.kill(youName(), t('char.cat'), false, weaponName(w));
  net.send({ t: 'cat', i, w });
}
weapon.onCatHit = (i, point) => catHit(i, point, weapon.current);
/** A clown hit by your bullet or caught in your blast: it honks and falls over. `spot`: where paintball's paint sticks on him. */
function clownHit(id: number, point: THREE.Vector3, w: string, spot?: Spot): void {
  effects.puff(point, spot); // the same cartoon puff
  const result = clowns.hit(id, w, !net.connected); // a strongman takes many hits
  if (!result) return;
  combat.hitMarker(result === 'down');
  if (result === 'down') combat.kill(youName(), whoName(clowns.name(id)), false, weaponName(w));
  net.send({ t: 'clownhit', id, w });
}
/** Where a strongman's rock lands or he stomps: dust, a shake if you're close, and (alone) your health. */
clowns.onLand = (at, what) => {
  effects.impact(at, new THREE.Vector3(0, 1, 0), 'cat');
  const near = Math.max(0, 1 - camera.position.distanceTo(at) / (what === 'stomp' ? 25 : 14));
  if (near > 0) {
    shake = Math.max(shake, near * (what === 'stomp' ? 0.8 : 0.5));
    rumble(near, near * 0.6, 200);
  }
  // In multiplayer the server decides who is hurt; alone it's decided here.
  if (net.connected || !combat.alive || driving || riding || !weapon.enabled || Math.abs(player.feet - at.y) > 2.5) return;
  const f = KINDS.strongman.fight;
  const hp = what === 'stomp' ? hurtBy(Math.hypot(player.x - at.x, player.z - at.z), f.stompRadius, f.stompDamage) : hurtBy(Math.hypot(player.x - at.x, player.z - at.z), f.rockRadius, f.rockDamage);
  if (hp > 0) {
    combat.hitFrom(Math.atan2(-(at.x - player.x), -(at.z - player.z)) - player.yaw);
    soloHurt(hp);
  }
};
/** Alone, a strongman hurt you: your health goes down here; at nothing you're out for 3 seconds. */
function soloHurt(amount: number): void {
  combat.hurt(Math.max(0, combat.hp - amount));
  rumble(0.8, 0.5, 180);
  if (combat.hp > 0) return;
  combat.died(t('char.strongman'), false);
  combat.kill(t('char.strongman'), t('char.you'), false, '');
  setTimeout(() => {
    // In the Zombies game alone a fall is its end: it puts you back at its start, on the ground (stopSolo).
    if (net.connected || combat.alive || solo) return;
    respawnAt(OUTSIDE_SPAWNS[Math.floor(Math.random() * OUTSIDE_SPAWNS.length)]);
    if (rules.parachute !== false) beginDrop();
  }, 3000);
}
weapon.onClownHit = (id, point, spot) => clownHit(id, point, weapon.current, spot);
$('newround-btn').addEventListener('click', () => net.send({ t: 'newround' }));

// ---- The Zombies game (shared/zombies.mjs). Together the server runs it: a shot that hits zombies
// is told to it (zhit), which checks it and keeps their health. Alone it runs here (`solo`).
/** A zombie's name in the kill feed and on the death screen. */
const zombieName = (big: boolean) => whoName(big ? 'a big zombie' : 'a zombie');
/** One shot's hits on zombies: a puff (or paint that sticks to them), and the hits for the server, or here alone. */
weapon.onZombieHit = (hits, paint, w) => {
  const spec = WEAPON_SPECS[w];
  for (const h of hits) {
    effects.zombieHit(h.point);
    if (paint) zombies.paint(h.id, h.ray, paint.color, paint.size);
    zombies.struck(h.id, h.point, h.ray.direction, w); // which way it falls, if this beats it
  }
  const headshot = hits.some((h) => h.head > 0);
  if (net.connected) {
    combat.hitMarker(false, headshot);
    net.send({ t: 'zhit', w, hits: hits.map((h) => (h.legs ? [h.id, h.body, h.head, h.legs] : [h.id, h.body, h.head])) }); // a fourth number: the body's hits that landed on the legs
    return;
  }
  if (!solo) return;
  const now = performance.now();
  let downs = 0;
  for (const h of hits) {
    if (h.legs) solo.horde.lame(h.id); // shot in the legs: it limps from now on
    const res = solo.horde.hit(h.id, h.body * spec.body + h.head * spec.head, SOLO_ME, now);
    if (res === 'down') downs++;
    zombieResult(h.id, res, w, h.head > 0);
  }
  if (downs > 1 && (spec as { pierce?: number }).pierce) combat.double(''); // one sniper's bullet, two zombies
};
/** Alone: what a hit did. Beaten: it falls (or vanishes in paint) and the kill feed says so. */
function zombieResult(id: number, res: 'down' | 'hurt' | null, w: string, head = false): void {
  if (!res) return;
  if (res !== 'down') return w === 'turret' ? undefined : combat.hitMarker(false, head); // a turret's hits aren't yours to see
  zombies.beaten(id, { x: player.x, z: player.z, w });
  // Maybe a reward where it fell (the wave's last leaves one when none fell yet).
  const z = solo?.horde.zombies.get(id);
  if (solo && z) solo.loot.drop(z, performance.now(), solo.horde.left === 0, [SOLO_ME]);
  combat.zombie('', zombieName(zombies.isBig(id)), weaponName(w)); // "You beat a zombie · Pistol" (marks the crosshair)
}
zombies.onVanish = (at) => effects.vanish(at);

/** Alone: the Zombies game in this page: the horde (shared/zombies.mjs), its end, the best wave kept in this browser. */
const SOLO_ME = 'me';
/** The best wave alone, per place (home's under its key from before the places), and the place picked last. */
const soloBestKey = (a: Arena) => (a.id === 'house' ? 'briel.zombiesBest' : `briel.zombiesBest.${a.id}`);
const SOLO_PLACE = 'briel.zombiesPlace';
let solo: { horde: Horde; loot: Loot; arena: Arena; endAt: number; best: number; record: boolean; custom: boolean; key: string } | null = null;
let soloStarting = false;
function soloBest(a: Arena): number {
  try {
    return Math.max(0, Math.floor(Number(localStorage.getItem(soloBestKey(a))) || 0));
  } catch {
    return 0; // storage blocked
  }
}
/** The edge of the Zombies game at place `id` (shared/arenas.mjs), worked out once a place. */
const arenaEdges = new Map<string, Bounds>();
function edgeOf(id: string | undefined): Bounds {
  const a = arenaOf(id);
  let e = arenaEdges.get(a.id);
  if (!e) arenaEdges.set(a.id, (e = arenaEdge(a, edges)));
  return e;
}
/**
 * Up at the start of Zombies place `a`: one of the house's outside places, or by its portal, facing it. On
 * the ground, as together: no parachute in Zombies (Yoshi, 7 Nov 2026).
 */
function respawnAtArena(a: Arena): void {
  const p = a.id === 'house' ? undefined : portalOf(a);
  if (!p) respawnAt(OUTSIDE_SPAWNS[Math.floor(Math.random() * OUTSIDE_SPAWNS.length)]);
  else respawnAt(OUTSIDE_SPAWNS[0], { x: p.out[0], z: p.out[1], y: house.ground + terrain.height(p.out[0], p.out[1]), fx: p.x, fz: p.z });
}
/**
 * Start the Zombies game alone (the Play tab's button) at place `id` (shared/arenas.mjs), out of any car
 * or saddle, at its start, with the cars where they stand. At home the grid round the house and the
 * bungalow: alone the houses stay shut (their doors in the grid as walls), but the outside stair and
 * the roof terrace are the zombies' too. In Smetlede the village comes in first (on a first visit it
 * takes a moment); its blocks, hedges and fences round the portal are the zombies' walls.
 */
async function startSolo(id: string): Promise<void> {
  if (me || solo || soloStarting) return;
  const arena = arenaOf(id);
  const edge = edgeOf(arena.id);
  let prisms: Prism[];
  let ground: ReturnType<typeof villageGround> | null = null;
  let data: VillageData | null = null;
  if (arena.center) {
    soloStarting = true;
    try {
      if (village !== 'ready') hud.announce('Smetlede', t('travel.village'));
      await loadVillage();
      data = (await import('./data/village.json')).default as unknown as VillageData;
      ground = villageGround(arena, edge, data, churchAccess, cafeAccess); // the café's stairs and the wood's trunks too
      prisms = ground.prisms;
    } finally {
      soloStarting = false;
    }
    if (me || solo) return; // joined a game together meanwhile
  } else prisms = [...insides.housePrisms(house.prisms), ...(house.surroundings?.prisms ?? []), ...homeStreet.blocks];
  prepareZombies();
  getOut(false);
  getOffHorse(false);
  getOffBike(false);
  const boxes = cars.filter((c) => c.ready && edge.inside(c.x, c.z)).map((c) => ({ x: c.x, z: c.z, yaw: c.yaw, halfL: c.spec.length / 2, halfW: c.spec.width / 2 }));
  const nav = ground
    ? makeNav({ prisms, height: (x, z) => terrain.height(x, z), base: house.ground, edge, boxes, areas: ground.areas, doors: [], shut: true, panes: 0 })
    : makeNav({ prisms, height: (x, z) => terrain.height(x, z), base: house.ground, edge, boxes, areas: houseAreas(insides.housePrisms(house.prisms)), doors: insides.houseDoors(house.doors), shut: true, panes: insides.housePrisms(house.prisms).length });
  const horde = new Horde(nav, data ? arenaSpots(arena, nav.spawnSpots(), data, cafeAccess) : nav.spawnSpots(), { home: arenaHome(arena) });
  horde.start(performance.now());
  solo = { horde, loot: new Loot(nav), arena, endAt: 0, best: soloBest(arena), record: false, custom: false, key: '' };
  applyKit(NO_KIT);
  respawnAtArena(arena);
  combat.setActive(weapon.enabled); // your health on screen while they come
  chat.system(() => t('z.soloStart'));
  if (arena.woods) chat.system(() => t('z.woods'));
  soloView(true);
  showSoloButton();
}
/** Stop it (the button again, the end screen over, or playing together): the zombies go, you're back up. */
/**
 * Alone, the Zombies game darkens as it goes on: dusk from wave 4, night from wave 6 (your torch comes on by
 * itself, world/torch.ts), and your own weather again when it ends. Said once as it turns. Together the
 * weather is the admin's for everyone, so the game leaves it alone there.
 */
function nightWave(wave: number): void {
  const want = wave >= 6 ? 'night' : wave >= 4 ? 'dusk' : null;
  if (want === nightMood) return;
  nightMood = want;
  weather.setGame(want);
  if (want) chat.system(() => t(want === 'night' ? 'z.night' : 'z.dusk'));
}
let nightMood: 'dusk' | 'night' | null = null;

function stopSolo(): void {
  if (!solo) return;
  nightWave(0);
  const wasDown = !combat.alive;
  const arena = solo.arena;
  solo = null;
  zombies.clear();
  rewards.clear();
  applyKit(NO_KIT);
  games.set({ kind: 'free' });
  zombieWaveControl.update(games.view, false);
  combat.setActive(!!me && weapon.enabled);
  if (wasDown && !me) respawnAtArena(arena);
  showSoloButton();
}
/** The game's view for the bar and the end screen, as the server's would be (src/ui/games.ts); set when it changes. */
function soloView(force = false): void {
  if (!solo) return;
  const h = solo.horde;
  const now = performance.now();
  const over = h.phase === 'over';
  const mine = h.beaten[SOLO_ME] ?? 0;
  const name = menu.nickname.trim() || youName(); // alone: the name typed on the start screen
  const fighter = weapon.enabled && !driving && !riding;
  const key = [h.phase, h.wave, h.left, combat.alive, fighter, mine, lang(), solo.custom,
    [...solo.loot.items.keys()].join('-'), solo.loot.mines.size, solo.loot.rows.size, solo.loot.turrets.size].join();
  if (!force && key === solo.key) return;
  solo.key = key;
  const ms = over ? Math.max(0, solo.endAt - now) : h.phase === 'break' ? Math.max(0, h.until - now) : 0;
  games.set({
    kind: 'zombies', phase: h.phase === 'over' ? 'done' : h.phase, ms, title: 'Zombies',
    result: `The zombies caught everyone at wave ${h.wave}.`, resultCode: solo.record ? 'zOverBest' : 'zOver', resultArgs: { n: h.wave },
    zombies: {
      ...solo.loot.view(),
      wave: h.wave, left: h.left, big: h.bigWave, bigs: bigOf(h.wave), fighters: fighter ? 1 : 0, standing: fighter && combat.alive ? 1 : 0, beaten: { [name]: mine }, ms,
      down: [], best: solo.best ? { wave: solo.best, names: [name], at: '' } : null, record: solo.record, custom: solo.custom, place: solo.arena.id,
    },
  });
  zombieWaveControl.update(games.view, waveAllowed());
}
/** Alone, the admin's wave picker: the horde jumps to `wave` at once, and the run never counts for the best (src/ui/soloWave.ts). */
function soloWave(wave: number): void {
  if (!solo || me || !sessionAdmin()) return;
  const events = chooseSoloWave(solo, wave, performance.now());
  if (!events) return;
  const name = menu.nickname.trim() || youName();
  chat.system(() => t('srv.zWaveSelected', { name, n: wave }));
  for (const e of events) {
    if (e.type !== 'wave') continue; // the old zombies go with the next look at the horde (zombies.follow)
    solo.loot.wave();
    chat.system(() => t(e.bigs > 1 ? 'srv.zWaveBigs' : e.big ? 'srv.zWaveBig' : 'srv.zWave', { n: e.wave, count: e.count }));
    nightWave(e.wave);
  }
  soloView(true);
}
/** Alone, every frame: the horde's step and what came of it. */
function soloTick(dt: number): void {
  if (!solo) return;
  const h = solo.horde;
  const now = performance.now();
  if (h.phase === 'over' && now >= solo.endAt) return stopSolo();
  // Not in the air: the break holds while you come down by parachute, and ends 4 s after you land (as together:
  // server/zombies.mjs LANDED_MS).
  if (h.phase === 'break' && player.chute !== null) h.until = Math.max(h.until, now + 4000);
  const fighter = weapon.enabled && !driving && !riding;
  for (const e of h.tick(now, dt, [{ name: SOLO_ME, x: player.x, y: player.feet, z: player.z, alive: combat.alive, fighter, safe: false }])) {
    if (e.type === 'wave') {
      solo.loot.wave();
      chat.system(() => t(e.bigs > 1 ? 'srv.zWaveBigs' : e.big ? 'srv.zWaveBig' : 'srv.zWave', { n: e.wave, count: e.count }));
      nightWave(e.wave);
    }
    else if (e.type === 'cleared') chat.system(() => t('srv.zCleared', { n: e.wave }));
    else if (e.type === 'runners') runnersComing(true);
    else if (e.type === 'perch') chat.system(() => t('srv.zPerch', { n: Math.round(e.ms / 1000) }));
    else if (e.type === 'perchOut' && combat.alive) {
      // Out of the zombies' reach too long: out (alone, the game is over).
      chat.system(() => t('srv.zPerchOut', { name: youName() }));
      soloZombieHurt(combat.hp, false);
    }
    else if (e.type === 'swipe') soloZombieHurt(e.damage, h.zombies.get(e.id)?.kind === BIG_ZOMBIE, h.zombies.get(e.id));
    else if (e.type === 'over') {
      solo.endAt = now + 15000;
      solo.record = soloRecord(solo, e.wave); // never with a chosen wave
      if (solo.record) {
        solo.best = e.wave;
        try {
          localStorage.setItem(soloBestKey(solo.arena), String(e.wave));
        } catch {
          // storage blocked: the best for this visit only
        }
      }
      // As the server words it: its friendly twin in Paintball ("Iedereen was geraakt").
      const [n, code] = [e.wave, solo.record ? 'zOverBest' : 'zOver'];
      chat.system(() => serverText(code, { n }, `The zombies caught everyone at wave ${n}.`));
      soloView(true);
    }
  }
  // Alone the rewards are this page's: items lying too long go, a claymore a zombie walks into goes off,
  // a row of stakes the zombies wore through bursts.
  const { booms, broke, shots } = solo.loot.tick(now, h.zombies.values());
  for (const { mine: m, ids } of booms) {
    explode(new THREE.Vector3(m.x, m.y + 0.25, m.z), false, 'grenade');
    for (const id of ids) zombieResult(id, h.hit(id, LOOT.damage, SOLO_ME, now), 'claymore');
  }
  for (const r of broke) rewards.burst(r.id);
  // A turret's shot: no flinch (its steady fire would hold the zombie still).
  for (const { turret: tu, id } of shots) {
    turretShot(tu.id, id, tu.rounds);
    zombieResult(id, h.hit(id, LOOT.turretDamage, SOLO_ME, now, false), 'turret');
  }
  const lv = solo.loot.view();
  rewards.setItems(lv.items);
  rewards.setMines(lv.mines);
  rewards.setStakes(lv.stakes);
  rewards.setTurrets(lv.turrets);
  zombies.follow(h);
  soloView();
}
/** The game's first runners are out: a heads-up in the banner (`line`: and the chat, alone; together the server's line is there). */
function runnersComing(line: boolean): void {
  hud.announce(t('z.runners'), t('z.runnersSub'));
  if (line) chat.system(() => t('srv.zRunners'));
}
/** Alone, a zombie's swipe (or a big one's pound) landed: your health goes down; at nothing the game is over (you were the only one). */
function soloZombieHurt(amount: number, big: boolean, from?: { x: number; z: number }): void {
  if (!combat.alive) return;
  combat.hurt(Math.max(0, combat.hp - amount));
  rumble(0.8, 0.5, 180);
  if (from) combat.hitFrom(Math.atan2(-(from.x - player.x), -(from.z - player.z)) - player.yaw);
  if (combat.hp > 0) return;
  combat.died(zombieName(big), false);
  combat.caught('', zombieName(big)); // "A zombie caught you"
}
/** The Play tab's button: Zombies alone, or Stop Zombies while it runs; together the admin starts it for everyone. */
function showSoloButton(): void {
  $('zombies-solo').classList.toggle('hidden', !!me);
  const title = $('zombies-btn-title');
  const sub = $('zombies-btn-sub');
  title.dataset.i18n = solo ? 'play.zombiesStop' : 'game.zombies';
  sub.dataset.i18n = solo ? 'game.stopSub' : 'play.zombiesSub';
  title.textContent = t(solo ? 'play.zombiesStop' : 'game.zombies');
  sub.textContent = t(solo ? 'game.stopSub' : 'play.zombiesSub');
  zombiesPlace.disabled = !!solo; // where it is played: picked before it starts
}
/** Where Zombies is played alone (the Play tab), kept from last time; together the admin picks (the admin tab). */
const zombiesPlace = $('zombies-place') as HTMLSelectElement;
try {
  const kept = localStorage.getItem(SOLO_PLACE);
  if (kept && [...zombiesPlace.options].some((o) => o.value === kept)) zombiesPlace.value = kept;
} catch {
  // storage blocked: home
}
zombiesPlace.addEventListener('change', () => {
  try {
    localStorage.setItem(SOLO_PLACE, zombiesPlace.value);
  } catch {
    // storage blocked: for this visit only
  }
});
$('zombies-btn').addEventListener('click', () => {
  if (solo) stopSolo();
  else {
    startSolo(zombiesPlace.value).catch(() => {}); // a village that won't load says so itself (loadVillage)
    menu.resume(menu.mode ?? 'kbm');
  }
});

/**
 * The admin's bazooka. In multiplayer the server sets off the blast when the rocket arrives
 * (and decides who it hurts); alone, the rocket explodes here.
 */
const ROCKET = SPECS.bazooka.rocket!;
function fireRocket(from: THREE.Vector3, to: THREE.Vector3): void {
  if (net.connected) {
    net.send({ t: 'rocket', tx: to.x, ty: to.y, tz: to.z });
    effects.rocket(from, to, ROCKET.speed);
  } else effects.rocket(from, to, ROCKET.speed, () => explode(to, true));
}
/** An explosion everyone sees; the shooter's own also breaks windows and fells cats near it. */
function explode(at: THREE.Vector3, mine: boolean, w: 'bazooka' | 'grenade' = 'bazooka'): void {
  const radius = w === 'grenade' ? GRENADE.radius : ROCKET.radius;
  effects.explosion(at, w === 'grenade' ? 0.7 : 1);
  weapon.boom(at);
  const near = Math.max(0, 1 - camera.getWorldPosition(new THREE.Vector3()).distanceTo(at) / (w === 'grenade' ? 18 : 25));
  if (near > 0) {
    shake = Math.max(shake, near);
    rumble(near, near, 300);
  }
  life.scare(at, 45);
  zombies.blast(at, radius, w); // the fallen near it thrown a little outward (only how they fall: the server decides who)
  looseProps.blast(at, radius); // bins and bikes thrown, posts bent (on this page only)
  if (!mine) return;
  for (const i of glass.near(at, radius * 0.7)) if (glass.break(i, at, at)) net.send({ t: 'glass', i });
  for (const i of cats.near(at, radius)) catHit(i, at, w);
  for (const id of clowns.near(at, radius)) clownHit(id, at, w);
  // Alone, zombies caught in it lose health here (together the server works it out from the blast).
  if (solo) for (const [id, res] of solo.horde.blast(at.x, at.z, radius, bruteDamage(w, WEAPON_SPECS), SOLO_ME, performance.now())) zombieResult(id, res, w);
}

/**
 * Grenades: thrown along the view, a little upwards, with your own running speed on top.
 * Yours go off here; the server is told where, and who stood behind a wall or floor (a blast
 * does not go through them), and works out the damage like a rocket's.
 */
function throwGrenade(): void {
  camera.updateMatrixWorld();
  const eye = camera.getWorldPosition(new THREE.Vector3());
  const q = camera.getWorldQuaternion(new THREE.Quaternion());
  const ahead = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  let from = eye.clone().addScaledVector(ahead, 0.35).addScaledVector(right, 0.15).add(new THREE.Vector3(0, -0.12, 0));
  if (world.blocked(eye, from) || world.collide(eye, from, 0.05)) from = eye; // up against a wall: from the eye
  const run = player.velocity;
  const vel = ahead.multiplyScalar(GRENADE.speed).add(new THREE.Vector3(run.x, 2.2, run.z));
  if (!grenades.throw(from, vel)) return;
  weapon.throwing();
  net.send({ t: 'nade', x: from.x, y: from.y, z: from.z, vx: vel.x, vy: vel.y, vz: vel.z });
}
grenades.onWater = (at, speed) => effects.splashes.plop(at.x, at.y, at.z, speed); // into a pond or a ditch (world/splashes.ts)
grenades.onPane = (i, at, from) => {
  if (!built.panes.has(i) || !glass.break(i, at, from)) return false;
  net.send({ t: 'glass', i });
  return true;
};
grenades.onExplode = (at) => {
  explode(at, true, 'grenade');
  if (!net.connected) return;
  const cover = [...online.keys()].filter((name) => {
    const p = avatars.position(name);
    return !!p && p.distanceTo(at) < GRENADE.radius + 1 && world.blocked(at, { x: p.x, y: p.y + 0.9, z: p.z });
  });
  net.send({ t: 'boom', x: at.x, y: at.y, z: at.z, cover });
};
/** Pull the trigger: recoil, and the shot (or rocket) for the others. */
function fire(): void {
  const shot = weapon.shoot();
  if (!shot) return;
  player.pitch += shot.pitch;
  player.yaw += shot.yaw;
  unfired = false; // your choice of guns is fixed until you come into play again
  if (solo) solo.horde.noise(player.x, player.z, weapon.current, performance.now(), SOLO_ME); // gunfire draws the zombies (together the server does this)
  // Smoke at the muzzle: from every shot of the big guns, now and then from the others (not paint guns).
  if (!paintball.on && !shot.rocket && (weapon.current === 'shotgun' || weapon.current === 'sniper' || Math.random() < 0.3)) effects.muzzleSmoke(weapon.muzzlePoint());
  rumble(weapon.current === 'pistol' ? 0.25 : 0.6, 0.6, weapon.current === 'rifle' ? 50 : 90);
  if (shot.rocket) fireRocket(shot.rocket.from, shot.rocket.to);
  else net.send({ t: 'shot', w: weapon.current, x: player.x, y: player.feet + 1.5, z: player.z, ...(shot.tracer ? { tx: Math.round(shot.tracer.x * 100) / 100, ty: Math.round(shot.tracer.y * 100) / 100, tz: Math.round(shot.tracer.z * 100) / 100 } : {}) }); // `tx`..: where a tracer goes, for the others to see
  life.scare(camera.getWorldPosition(new THREE.Vector3()));
}
/** The bazooka is the admin's, and anyone's playing alone. */
function adminWeapons(): WeaponId[] {
  return !me || me.role === 'admin' ? ['bazooka'] : [];
}

// The guns you chose to start with (shared/loadout.mjs, the picker: ui/loadout.ts), kept on this device.
let myPick: string[] = LOADOUT.first;
try {
  const kept = localStorage.getItem('briel.loadout');
  if (kept !== null) myPick = cleanPick(JSON.parse(kept));
} catch {
  // no storage, or not a list: the first choice
}
/** Not fired since you came into play: a new choice of guns still counts at once (the server has the same rule). */
let unfired = true;
/** The guns you come into play with, besides the pistol: yours and the admin's; none in the Zombies game. */
function startGuns(): WeaponId[] {
  return startingWeapons(myPick, adminWeapons(), games.zombies).filter((w) => w !== 'pistol') as WeaponId[];
}
const loadoutCard = new LoadoutCard();
loadoutCard.picture = (w) => gunPicture(renderer, scene.environment, w);
loadoutCard.onDone = (pick, click) => {
  myPick = pick;
  try {
    localStorage.setItem('briel.loadout', JSON.stringify(pick));
  } catch {
    // no storage: the choice lasts this visit
  }
  // Together the server hands the guns out (and answers with them, 'weapons'); alone it is the same rule here.
  if (net.connected) net.send({ t: 'loadout', w: pick });
  else if (unfired && !games.zombies) weapon.setOwned(startGuns());
  if (click && !menu.open && menu.mode === 'kbm') lockMouse();
};
/** The picker, when you come into Action or Paintball; not in the Zombies game (pistol only, the rest is found). */
function offerGuns(): void {
  if (!weapon.enabled || games.zombies || startIntent.zombies !== null || menu.onStartScreen || menu.open) return;
  loadoutCard.show(myPick, menu.mode === 'pad');
}

/** Get in: alone right away; in multiplayer once the server says the car is yours. Not during the Zombies game (the server refuses too). */
function getIn(): void {
  if (games.zombies) return chat.system(() => t('srv.zNoCar'));
  if (!net.connected) return startDriving();
  net.send({ t: 'car', op: 'in', id: car.id });
  wantCar = true;
}
function startDriving(): void {
  driving = true;
  wantCar = false;
  car.enter();
}
/** In the passenger seat: the car (someone else drives) carries you, the camera behind it. */
function startRiding(): void {
  riding = true;
  wantCar = false;
  car.enter();
}
/** Out by your door (or wherever there is room), facing where the camera looked. `tell`: let the server know. */
function getOut(tell = true): void {
  if (!driving && !riding) return;
  const wasRiding = riding;
  if (driving) car.leave();
  driving = riding = false;
  const at = car.exitSpot(wasRiding);
  const yaw = Math.atan2(camera.position.x - car.x, camera.position.z - car.z);
  player.place(at.x, at.z, world.groundAt(at.x, at.z, car.y + 0.3, 0.5).y, yaw, 0);
  player.update(0, NO_INPUT, camera);
  if (tell) net.send({ t: 'car', op: 'out' });
}

/** Get on horse i: alone right away; in multiplayer once the server says it's yours. */
function mountHorse(i: number): void {
  if (games.zombies) return chat.system(() => t('srv.zNoHorse'));
  if (!net.connected) {
    horses.mount(i, me?.username ?? 'you');
    return;
  }
  net.send({ t: 'horse', op: 'on', i });
  horseWanted = i;
}
/** Off the horse, beside its shoulder, facing where you looked. `tell`: let the server know. */
function getOffHorse(tell = true): void {
  const at = horses.dismount();
  if (!at) return;
  player.place(at.x, at.z, world.groundAt(at.x, at.z, at.y + 0.3, 0.5).y, camera.rotation.y, 0);
  player.update(0, NO_INPUT, camera);
  if (tell) net.send({ t: 'horse', op: 'off' });
}
/** Get on bike `id`: alone right away; in multiplayer once the server says it's yours. Not during the Zombies game (the server refuses too). */
function getOnBike(id: string): void {
  if (games.zombies) return chat.system(() => t('srv.zNoBike'));
  if (!net.connected) return bikes.mount(id, me?.username ?? 'you');
  net.send({ t: 'bike', op: 'on', id });
  bikeWanted = id;
}
/** Off the bike, on its left, facing its way. `tell`: let the server know. */
function getOffBike(tell = true): void {
  const at = bikes.dismount();
  if (!at) return;
  player.place(at.x, at.z, world.groundAt(at.x, at.z, at.y + 0.3, 0.5).y, at.yaw, 0);
  player.update(0, NO_INPUT, camera);
  if (tell) net.send({ t: 'bike', op: 'off' });
}

/**
 * Back in the game at spawn point `i` (chosen by the server, away from the others), or at `x, z` near
 * it when the server spreads everyone out (a party game gathers them at the house). Zombies at another
 * portal gathers them there: `y` the ground's height and `fx, fz` the portal to face.
 */
function respawnAt(i: number, at?: { x?: number; z?: number; y?: number; fx?: number; fz?: number }): void {
  getOut(false);
  getOffHorse(false);
  getOffBike(false);
  const s = spawns[i];
  if (s) {
    const [x, z] = typeof at?.x === 'number' && typeof at?.z === 'number' ? [at.x, at.z] : [s.x, s.z];
    const there = typeof at?.fx === 'number' && typeof at?.fz === 'number';
    const [mx, mz] = there ? [at!.fx!, at!.fz!] : s.team === 'bungalow' ? [83.5, 189.7] : [4.5, 6];
    const yaw = Math.atan2(-(mx - x), -(mz - z)); // facing the middle of the house (or the bungalow, or the portal)
    const y = there && typeof at?.y === 'number' ? at.y : s.y;
    player.place(x, z, world.groundAt(x, z, y + 0.3, 0).y, yaw, 0);
  }
  player.down = 0;
  player.update(0, NO_INPUT, camera);
  combat.respawned();
  weapon.resetLoadout(startGuns());
  unfired = true;
  grenades.refill();
}

/**
 * Travelling through the portals (shared/portals.mjs), from a portal's pad or from the chat
 * (/church): a flash in the portal's colour and you come out at the other one, in the car if you
 * drive it (the passenger comes along). From the chat and the menu's list also to a street
 * (/location kapellenhoek: shared/places.json, src/places.ts). In multiplayer the server checks
 * the trip and moves you there for the others; meanwhile your position isn't sent, so it can't
 * pull you back. A place in the village waits for the village if it is still loading.
 */
let trip: { to: Destination; answer?: (ok: boolean) => void } | null = null;
let cameFrom: string | null = null; // the portal you last came from: "back" in the next list
let justArrived: string | null = null; // the portal you came out of: its pad waits until you have stepped off it
const warp = $('warp');
const portalMarks = PORTALS.map((p) => ({ x: p.x, z: p.z, color: p.color }));
travelPanel.onPick = (p) => void travel(p, 'portal');
async function travel(to: Destination, via: 'portal' | 'chat'): Promise<void> {
  if (trip || !combat.alive || games.blindfolded) return;
  if (games.fenced) {
    chat.system(() => t('srv.travelGame')); // a game in the house: everyone stays near it (the server refuses too)
    return;
  }
  if (via === 'chat') {
    if (riding) getOut(); // the driver keeps the car
    if (horses.mounted >= 0) getOffHorse();
    if (bikes.mounted) getOffBike();
  }
  const from = portalNear(driving ? car.x : player.x, driving ? car.z : player.z, via === 'chat' ? 60 : CAR_REACH);
  if (from === to) return;
  trip = { to };
  warp.style.setProperty('--warp', to.color);
  warp.classList.add('on');
  portals.pulse(player.x, player.feet, player.z, to.color, 'here');
  // Whatever happens on the way (the village failing to load, say), the flash goes and you can travel
  // again: once it stayed on screen for good.
  try {
    if (to.village && village !== 'ready') {
      hud.announce('Smetlede', t('travel.village'));
      await loadVillage();
    }
    // Molenhoek's and Kapellenhoek's baked light, if it is still coming (buildVillage); never more than a few seconds.
    if (to.village) await Promise.race([streetBakes, new Promise((r) => setTimeout(r, 6000))]);
    let ok = true;
    if (net.connected) {
      ok = await new Promise<boolean>((resolve) => {
        trip!.answer = resolve;
        net.send({ t: 'travel', to: to.id, via });
        setTimeout(() => resolve(false), 3000);
      });
    } else {
      await new Promise((r) => setTimeout(r, 180)); // the flash at its brightest
    }
    if (ok && combat.alive) arrive(to, from);
  } catch (e) {
    console.error('travel failed', e);
  } finally {
    trip = null;
    warp.classList.remove('on');
  }
}
/** Out of portal `to`: in front of it looking at the place, or the car on its road. */
function arrive(to: Destination, from: Portal | null): void {
  const [x, z, yaw] = driving ? to.car : to.out;
  const y = groundY(x, z);
  if (driving) car.place(x, y, z, yaw);
  else {
    player.place(x, z, y, yaw, 0);
    player.update(0, NO_INPUT, camera);
  }
  cameFrom = from?.id ?? null;
  justArrived = to.id;
  portals.pulse(x, y, z, to.color, false);
  hud.announce(portalName(to), to.sub);
}
/** Words before the place that change nothing: /go church, /ga naar de kerk, /tp school, /locatie kapellenhoek. */
const TRAVEL_WORDS = new Set(['location', 'locatie', 'go', 'goto', 'to', 'tp', 'travel', 'teleport', 'ga', 'gaan', 'naar', 'reis', 'reizen', 'the', 'de', 'het']);
/** Words that ask for the list of every place, like /location alone. */
const LIST_WORDS = new Set(['places', 'plaatsen', 'list', 'lijst', 'help']);
/**
 * Chat commands: /church, /house, /location school, /location kapellenhoek, /kerk, /ga naar huis ...
 * A name fits one place, several (their list) or none (the closest names: src/places.ts);
 * /location alone lists every place.
 */
function command(text: string): void {
  const words = text.slice(1).trim().toLowerCase().split(/\s+/).filter(Boolean);
  // Spawning (src/spawn.ts): /spawn lists everything, /spawn sofa or just /sofa spawns one, /remove
  // takes away what you look at. A bare name only when every word is a whole word of a thing's name
  // (else it is a place: /church), and never after a travel word (/ga naar ...).
  if (words.length === 1 && REMOVE_WORDS.has(words[0])) return removeThing();
  if (words.length === 1 && CHUTE_WORDS.has(words[0])) return chuteCommand();
  if (words.length && SPAWN_WORDS.has(words[0])) {
    const rest = words.slice(1).join(' ');
    if (!rest) return spawnList();
    const thing = findThing(rest);
    return thing ? spawnThing(thing) : chat.system(() => t('spawn.unknown', { name: rest }));
  }
  const exact = words.length && !TRAVEL_WORDS.has(words[0]) ? findThing(words.join(' '), true) : null;
  if (exact) return spawnThing(exact);
  while (words.length && TRAVEL_WORDS.has(words[0])) words.shift();
  const typed = words.join(' ');
  if (!fold(typed) || (words.length === 1 && LIST_WORDS.has(words[0]))) {
    for (const line of placeLines()) chat.system(line);
    return;
  }
  const found = findPlace(typed);
  if ('to' in found) go(found.to);
  else chat.system(foundLine(typed, found));
}
/** /parachute: a skydive over where you stand. */
const CHUTE_WORDS = new Set(['parachute', 'chute', 'para']);
/**
 * /parachute (Yoshi): a skydive from high up over where you stand, flown freely from there, as at a start. Alone
 * the page starts it (on foot, alive, outdoors, not in the Zombies game); together it asks the server, which
 * checks again and decides it (server/game.mjs manualDrop: also a minute between drops and none just after being hit).
 */
function chuteCommand(): void {
  if (rules.parachute === false) return chat.system(() => t('srv.chuteOff'));
  if (!combat.alive || driving || riding || horses.mounted >= 0 || bikes.mounted || trip || player.chute !== null || solo || soloStarting) return chat.system(() => t('srv.chuteNotNow'));
  const ground = player.ground.name;
  if (indoorName(ground, roomNames)) return chat.system(() => t('srv.chuteIndoors'));
  if (net.connected) net.send({ t: 'chute' });
  else beginDrop({ x: player.x, z: player.z, yaw: player.yaw, feet: player.feet });
}
/** The words that list what can be spawned (/spawn) or spawn the name after them, and those that take a thing away. */
const SPAWN_WORDS = new Set(['spawn', 'zet', 'maak']);
const REMOVE_WORDS = new Set(['remove', 'weg', 'verwijder', 'delete', 'despawn']);
/** /spawn alone: how it works, and every thing's name in this page's language. */
function spawnList(): void {
  chat.system(() => t('spawn.help'));
  chat.system(() => t('spawn.listFurniture', { list: thingNames('furniture').join(', ') }));
  chat.system(() => t('spawn.listCars', { list: thingNames('tesla').join(', ') }));
  chat.system(() => t('spawn.listCharacters', { list: thingNames('character').join(', ') }));
}
/** An angle between -pi and pi. */
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/**
 * Spawn `thing` in front of you: a piece of furniture 2 m ahead, its front to you (a quarter turn at a time), a character a little further
 * on the ground, a Tesla side-on where it fits (as the server checks a parking spot). Alone in this page;
 * together through the server, which checks it again (and refuses it with a word when it may not).
 */
function spawnThing(thing: Thing): void {
  if (!maySpawn()) return chat.system(() => t('srv.spawnOff'));
  if (!combat.alive || driving || riding || bikes.mounted || trip) return chat.system(() => t('spawn.notNow'));
  const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
  const eye = { x: player.x, y: player.feet + 1.2, z: player.z };
  // A spot `d` m ahead on the floor near your level, with no wall between it and you; or null.
  const ahead = (d: number) => {
    const x = player.x + fx * d, z = player.z + fz * d;
    const y = world.groundAt(x, z, player.feet + 0.8, 0).y;
    return Math.abs(y - player.feet) < 1.5 && !world.blocked(eye, { x, y: y + 0.5, z }) ? { x: +x.toFixed(2), y: +y.toFixed(3), z: +z.toFixed(2) } : null;
  };
  if (thing.kind === 'tesla') {
    for (const d of [4.5, 6, 3.5]) {
      for (const yaw of [player.yaw + Math.PI / 2, player.yaw]) {
        const x = player.x + fx * d, z = player.z + fz * d;
        const fit = teslaFits(thing.id, x, z, yaw, player.feet);
        if (!fit.ok || world.blocked(eye, { x, y: fit.y + 0.8, z })) continue;
        placeTesla({ kind: thing.id, x: +x.toFixed(2), y: +fit.y.toFixed(3), z: +z.toFixed(2), yaw: +wrapAngle(yaw).toFixed(4) });
        return chat.system(() => t('spawn.done', { name: thing.label() }));
      }
    }
    return chat.system(() => t('spawn.noRoom'));
  }
  const spot = ahead(thing.kind === 'character' ? (thing.id === 'strongman' ? 5 : 3) : 2) ?? ahead(1.2);
  if (!spot) return chat.system(() => t('spawn.noRoom'));
  if (thing.kind === 'character') addClown({ ...spot, kind: thing.id as Kind });
  else putFurniture({ item: thing.id, ...spot, yaw: +wrapAngle(Math.round(player.yaw / (Math.PI / 2)) * (Math.PI / 2)).toFixed(4) }); // its front to you, square to where you look
  chat.system(() => t('spawn.done', { name: thing.label() }));
}
/**
 * /remove: the thing you look at within 12 m, the nearest of a piece of furniture, a spawned Tesla or a
 * character. Alone anything; together the server takes away your own (the admin's any) and says so if not.
 */
function removeThing(): void {
  const ray = new THREE.Raycaster();
  ray.far = 12;
  camera.updateMatrixWorld();
  ray.setFromCamera(new THREE.Vector2(0, 0), camera);
  const furn = furnishing.pickHit(ray);
  const tesla = pickTesla(ray);
  const character = ray.intersectObject(clowns.group, true).find((h) => h.object.userData.clown !== undefined);
  const options = [
    furn ? { d: furn.distance, go: () => removeFurniture(furn.piece.id) } : null,
    tesla ? { d: tesla.distance, go: () => (tesla.busy ? chat.system(() => t('spawn.teslaBusy')) : removeTesla(tesla.c.id)) } : null,
    character ? { d: character.distance, go: () => removeClown(character.object.userData.clown) } : null,
  ].filter((o) => o !== null);
  if (!options.length) return chat.system(() => t('spawn.lookAt'));
  options.sort((a, b) => a.d - b.d)[0].go();
}
/** Why you can't go somewhere from the chat or the menu's list now (the server refuses too), or null. */
function travelBlock(): (() => string) | null {
  if (games.fenced) return () => t('srv.travelGame');
  if (!rules.travel && me?.role !== 'admin') return () => t('srv.travelChatOff');
  if (!combat.alive) return () => t('chat.notDown');
  return null;
}
/** To a place from the chat or the menu's list. */
function go(to: Destination): void {
  const why = travelBlock();
  if (why) chat.system(why);
  else void travel(to, 'chat');
}
const placesList = new PlacesList();
placesList.onPick = (to) => {
  menu.resume(menu.mode ?? 'kbm');
  go(to);
};
$('repair-btn').addEventListener('click', () => {
  glass.repair();
  net.send({ t: 'repair' });
});
doors.onToggle = (id, open, dir) => net.send({ t: 'door', id, open, dir });
/** The connection's state at the top (drawn again in another language). */
let netText: () => string = () => '';
net.onStatus = (text) => {
  netText = text;
  netStatus.textContent = text();
  games.setOffline(!net.connected && !!me); // the game's bar greys and stops while the connection is down
  zombieWaveControl.update(games.view, waveAllowed());
  followMood();
};
/** The menu opens at the team picker the first time after the teams game starts (see openMenu). */
let teamsMenu = false;
/**
 * A game's state from the server: the bar and the coins, everyone's part on their figure ("it",
 * seekers), the scoreboard's heading in the teams game. When the teams game starts, an explorer is
 * told how to take part, and the next menu opens at the team picker.
 */
function followGame(view: ModeView): void {
  const before = games.view;
  games.set(view);
  // Together too, the hint where they come out of a wood (the Sparrenhof), once as the game starts.
  if (view.kind === 'zombies' && before.kind !== 'zombies' && arenaOf(view.zombies?.place).woods) chat.system(() => t('z.woods'));
  rooms.setPlaying(view.kind === 'zombies' && view.phase !== 'done');
  zombieWaveControl.update(view, net.connected && me?.role === 'admin');
  for (const name of online.keys()) avatars.setRole(name, games.roleOf(name));
  const teams = games.view.kind === 'teams' && games.view.phase === 'playing';
  combat.setTeams(teams ? { goal: games.view.goal ?? 25, score: games.view.score ?? { house: 0, bungalow: 0 } } : null);
  // Zombies: the scoreboard (Tab) shows everyone's zombies beaten and times down, as the end screen does.
  combat.setZombies(games.view.kind === 'zombies' ? games.view.zombies ?? null : null);
  if (teams && !(before.kind === 'teams' && before.phase === 'playing')) {
    teamsMenu = true;
    if (!weapon.enabled) chat.system(() => t('games.teamsExplore'));
  }
  // Zombies: an explorer is told how to join in; its zombies gone after it.
  if (games.zombies && before.kind !== 'zombies') {
    prepareZombies(); // their shaders for the light as it is now, during the break before wave 1
    if (!weapon.enabled) chat.system(() => t('z.explore'));
  }
  if (games.view.kind !== 'zombies') zombies.clear();
  // The rewards lying and the claymores down, as the server has them; your rewards end with the game.
  if (!solo) {
    rewards.setItems(games.view.kind === 'zombies' ? games.view.zombies?.items ?? [] : []);
    rewards.setMines(games.view.kind === 'zombies' ? games.view.zombies?.mines ?? [] : []);
    rewards.setStakes(games.view.kind === 'zombies' ? games.view.zombies?.stakes ?? [] : []);
    rewards.setTurrets(games.view.kind === 'zombies' ? games.view.zombies?.turrets ?? [] : [], games.view.kind !== 'zombies');
    if (games.view.kind !== 'zombies' && (kit.claymores || kit.stakes || kit.turrets || kit.scope || kit.ammo.length)) applyKit(NO_KIT);
  }
}
// Ended for good (another tab took over, the session ended, logged out elsewhere): back to playing alone, as after
// a kick. Else the page stayed as it was: the others frozen in place, a game's bar counting down, and a
// seeker's eyes shut with no way to move.
net.onEnded = (why) => setAccount(null, why);
net.onMessage = (m: ServerMsg) => {
  switch (m.t) {
    case 'welcome':
      // Started somewhere else than the street: the server moves us there before our first update.
      welcomed = true;
      net.send({ t: 'loadout', w: myPick }); // the guns you chose, for when you come into play
      netClock.reset(); // perhaps a restarted server, with a clock of its own
      if (spawnPending === 'home') {
        // The house's start by parachute: only while still near it (not after walking off alone first).
        if (Math.hypot(player.x - HOME_DROP.x, player.z - HOME_DROP.z) < 30) net.send({ t: 'spawn', to: 'home' });
        spawnPending = null;
      } else if (spawnPending) {
        net.send({ t: 'spawn', to: spawnPending.id });
        spawnPending = null;
      }
      avatars.clear();
      zombies.clear(); // the server's, as its first tick has them
      football.reset(); // the server's balls from its first states
      online.clear();
      for (const p of m.players) {
        online.set(p.name, p.color);
        if (p.name !== m.you) avatars.add(p.name, p.color);
      }
      showOnline();
      doors.setAll(m.doors, m.doorDir);
      homeLocks.grant(m.homes ?? [], m.accountHomes ?? []); // what this session typed before (a rejoin, a restart that kept them), or the account did
      doors.refresh(); // the locked homes' outside doors stay shut here whatever the others left open
      glass.repair();
      for (const i of m.broken ?? []) glass.break(i, null, undefined, true);
      combat.me = m.you;
      combat.reset(m.scores ?? [], m.limit ?? 10, m.round ?? null);
      grenades.refill();
      pickups.setAll(m.items ?? []);
      if (m.time) {
        cats.setClock(m.time);
        clowns.setClock(m.time);
        horses.setClock(m.time);
        life.setClock(m.time);
        clockOffset = m.time / 1000 - performance.now() / 1000;
        roadLife.setClock(m.time);
      }
      cats.setDown(m.cats ?? []);
      clowns.setAll(m.clowns ?? CLOWN_DEFAULTS);
      furnishing.setAll(m.furniture ?? []);
      games.me = m.you;
      games.guest = m.role === 'guest';
      rooms.setCurrent(m.room); // the open world, or a Zombies room (src/ui/rooms.ts)
      followGame(m.mode ?? { kind: 'free' });
      applyRules(m.rules ?? ANYTHING_GOES);
      showOnline(); // again, with this place's limit (a room holds fewer than the open world)
      weather.setServer(m.mood, m.moodCycle?.cycle, m.moodCycle?.time); // the admin's weather for everyone (Auto from an older server)
      getOut(false); // alone you may have been driving: the shared cars are where the server has them
      getOffHorse(false); // or riding
      getOffBike(false); // or cycling
      wantCar = false;
      horseWanted = -1;
      bikeWanted = null;
      setPlaced((m.cars ?? []).filter((s) => s.kind)); // the Teslas spawned together, instead of those spawned alone
      for (const s of m.cars ?? []) carById(s.id)?.setPose(s, true);
      horses.setAll(m.horses ?? [], m.you);
      bikes.setAll(m.bikes ?? [], m.you, true);
      {
        const [n, max] = [m.players.length, rules.maxPlayers ?? 16];
        chat.system(() => t('chat.joinedAs', { name: m.you, n, max }));
      }
      if (m.proto !== PROTO) chat.system(() => t('net.reload')); // the game was updated since this page loaded
      break;
    case 'rules':
      applyRules(m.rules);
      break;
    case 'mood': {
      weather.setServer(m.mood, m.cycle, m.time);
      followMood(); // the pace may have changed
      const notice = moodNotice(m, weather.serverMood, weather.serverSpeed);
      if (notice) chat.system(notice);
      break;
    }
    case 'weapons':
      weapon.setOwned(m.list); // the guns the server has for you (after your choice)
      break;
    case 'mode':
      followGame(m.mode);
      applyRules(rules); // names over heads off during hide and seek, back on after
      break;
    case 'rocket': {
      const from = new THREE.Vector3(m.x, m.y, m.z);
      weapon.remoteShot(from, 'bazooka');
      effects.rocket(from, new THREE.Vector3(m.tx, m.ty, m.tz), ROCKET.speed);
      break;
    }
    case 'blast':
      if (m.w === 'grenade') grenades.landed(m.by);
      explode(new THREE.Vector3(m.x, m.y, m.z), m.by === me?.username, m.w === 'grenade' ? 'grenade' : 'bazooka');
      break;
    case 'nade': {
      const from = new THREE.Vector3(m.x, m.y, m.z);
      grenades.thrown(m.name, from, new THREE.Vector3(m.vx, m.vy, m.vz));
      weapon.remoteThrow(from);
      break;
    }
    case 'join':
      avatars.add(m.name, m.color);
      avatars.setRole(m.name, games.roleOf(m.name));
      online.set(m.name, m.color);
      showOnline();
      chat.system(() => t('chat.joined', { name: m.name }));
      break;
    case 'leave':
      avatars.remove(m.name);
      online.delete(m.name);
      showOnline();
      chat.system(() => t('chat.left', { name: m.name }));
      break;
    case 's':
      onTick(m);
      break;
    case 'ball': // a football as the server has it (world/football.ts)
      football.fromServer(m, me?.username ?? null);
      break;
    case 'ballgoal':
      football.goalFromServer(m);
      break;
    case 'horse': {
      const h = m.horse;
      const mine = !!me && h.rider === me.username;
      if (mine && horses.mounted !== h.i) {
        if (horseWanted === h.i) {
          horses.mount(h.i, me!.username);
        } else net.send({ t: 'horse', op: 'off' }); // not asked for (an old connection's): give it back
      } else if (!mine && horses.mounted === h.i) getOffHorse(false); // taken back: you died or respawned
      if (horseWanted === h.i) horseWanted = -1;
      horses.setAll([h], me?.username ?? '');
      break;
    }
    case 'bike': {
      const k = m.bike;
      const mine = !!me && k.rider === me.username;
      if (mine && bikes.mounted !== k.id) {
        if (bikeWanted === k.id) bikes.mount(k.id, me!.username);
        else net.send({ t: 'bike', op: 'off' }); // not asked for (an old connection's): give it back
      } else if (!mine && bikes.mounted === k.id) getOffBike(false); // taken back: you died or respawned
      if (bikeWanted === k.id) bikeWanted = null;
      bikes.setAll([k], me?.username ?? '');
      break;
    }
    case 'bell':
      bikes.ring(m.id);
      break;
    case 'car': {
      const c = carById(m.car.id);
      if (!c) break;
      const mine = !!me && m.car.driver === me.username;
      const seat = !!me && m.car.passenger === me.username;
      if (mine || seat) {
        if ((mine && !driving) || (seat && !riding)) {
          car = c;
          if (wantCar) (mine ? startDriving : startRiding)();
          else net.send({ t: 'car', op: 'out' }); // not asked for (an old connection's): give it back
        }
      } else if (c === car && (driving || riding || wantCar)) {
        wantCar = false;
        getOut(false); // the server took it back (you died or respawned), or someone was quicker
      }
      if (!mine) c.setPose(m.car);
      break;
    }
    case 'teslas': // one was placed, moved or taken away (and whoever sat in a car taken away got out first, in a 'car')
      setPlaced(m.list);
      break;
    case 'chat':
      chat.add(m.from, m.color, m.text);
      break;
    case 'door':
      doors.set(m.id, m.open, m.dir);
      break;
    case 'glass': {
      const at = glass.bounds(m.i)?.getCenter(new THREE.Vector3()) ?? null;
      glass.break(m.i, at, avatars.position(m.by)?.clone().setY((at?.y ?? 1) + 0) ?? undefined, true);
      break;
    }
    case 'repair':
      glass.repair();
      if (!m.quiet) chat.system(() => t('chat.repaired', { name: m.by }));
      break;
    case 'shot': {
      const at = avatars.position(m.name);
      const from = at ? at.clone().setY(at.y + 1.4) : new THREE.Vector3(m.x, m.y, m.z);
      weapon.remoteShot(from, m.w as WeaponId);
      life.scare(from);
      const muzzle = avatars.flash(m.name);
      if (muzzle) effects.muzzleSmoke(muzzle);
      if (m.tx !== undefined && m.ty !== undefined && m.tz !== undefined) {
        const to = new THREE.Vector3(m.tx, m.ty, m.tz);
        effects.tracer(muzzle ?? from, to); // their tracer
        // Passing close by your head (and from more than a few metres off): you hear it and flinch.
        const line = new THREE.Line3(from, to);
        const eye = camera.getWorldPosition(new THREE.Vector3());
        const along = line.closestPointToPointParameter(eye, true);
        const by = line.at(along, new THREE.Vector3()).distanceTo(eye);
        if (by < 1.6 && along * line.distance() > 4 && combat.alive && weapon.enabled) {
          hud.nearMiss(1 - by / 1.6);
          weapon.whizz(1 - by / 1.6);
        }
      }
      break;
    }
    case 'scores':
      combat.setScores(m.list);
      break;
    case 'hurt':
      combat.hurt(m.hp);
      rumble(0.8, 0.5, 180);
      if (m.from) combat.hitFrom(Math.atan2(-(m.from.x - player.x), -(m.from.z - player.z)) - player.yaw);
      else if (hitAngle(m.by) !== null) combat.hitFrom(hitAngle(m.by)!);
      break;
    case 'rally':
      tactics.called(m.name, m.x, m.y, m.z);
      break;
    case 'placement':
      if (m.id === placementRequest) placementResult = m;
      break;
    case 'kill':
      // A zombie's in plain words ("A zombie caught Robin"); a player's as "killer weapon victim".
      if (m.killer === 'a zombie' || m.killer === 'a big zombie') combat.caught(m.victim, whoName(m.killer));
      else combat.kill(whoName(m.killer), m.victim, m.head, weaponName(m.w));
      if (m.victim === me?.username) {
        combat.died(whoName(m.killer), m.head);
        rumble(1, 1, 450);
        if (hitAngle(m.killer) !== null) combat.hitFrom(hitAngle(m.killer)!);
      }
      else avatars.kill(m.victim);
      break;
    case 'cat':
      cats.down(m.i, m.ms / 1000);
      combat.kill(m.by, t('char.cat'), false, weaponName(m.w));
      break;
    case 'clowns':
      clowns.setAll(m.list);
      break;
    case 'rock':
    case 'stomp':
      clowns.event(m);
      break;
    case 'clownhit':
      clowns.down(m.id, m.ms / 1000);
      combat.kill(m.by, whoName(clowns.name(m.id)), false, weaponName(m.w));
      break;
    case 'zdown': { // a zombie beaten (server/zombies.mjs): it falls (away from whoever beat it), or vanishes in paint
      const by = m.by === me?.username ? player : avatars.position(m.by);
      zombies.beaten(m.id, by && { x: by.x, z: by.z, w: m.w });
      // In the kill feed: your own, and the big ones (sixteen players beat over a hundred in a wave: a flood otherwise).
      if (m.by === me?.username || zombies.isBig(m.id)) combat.zombie(m.by, zombieName(zombies.isBig(m.id)), weaponName(m.w));
      if (m.double) combat.double(m.by); // one sniper's bullet, two zombies: everyone's feed
      break;
    }
    case 'revive': // helping a teammate up (you: `name`), or being helped up (`by`): it starts or stops
      if (m.name && helping?.name === m.name) {
        if (m.op === 'start') Object.assign(helping, { start: performance.now(), ms: m.ms ?? 3000 });
        else helping = null;
      }
      if (m.by) helpedBy = m.op === 'start' ? m.by : null;
      break;
    case 'zgift': // a reward you took, or what you have now (placed a claymore, back after a dropped connection)
      if (m.kind === 'placed' || m.kind === 'kit') applyKit(m.kit);
      else gift(m.kind, m.w, m.kit);
      break;
    case 'zboom': // a claymore went off (the server hurt the zombies in front of it)
      explode(new THREE.Vector3(m.x, m.y + 0.25, m.z), false, 'grenade');
      rewards.boom(m.id);
      break;
    case 'zbroke': // a row of stakes the zombies wore through
      rewards.burst(m.id);
      break;
    case 'zfire': // the turrets' shots this tick: [turret, zombie, rounds left] (the server hurts the zombies)
      for (const [tid, zid, rounds] of m.s) turretShot(tid, zid, rounds);
      break;
    case 'revived': // helped up where they lay, with part of their health
      if (m.name === me?.username) {
        helpedBy = null;
        player.down = 0;
        // Up where you went down, as the server has it.
        if (typeof m.x === 'number' && typeof m.z === 'number' && typeof m.y === 'number' && Math.hypot(m.x - player.x, m.z - player.z) > 0.05) {
          player.place(m.x, m.z, m.y, player.yaw, player.pitch);
          player.update(0, NO_INPUT, camera);
        }
        combat.respawned(m.hp);
        weapon.resetLoadout(startGuns()); // as the server has it: what you picked up stayed where you fell
        unfired = true;
      } else avatars.revive(m.name);
      if (helping?.name === m.name) helping = null;
      break;
    case 'zgone': // fallen zombies taken away, or all of them when the game ends
      zombies.gone(m.ids);
      break;
    case 'furn':
      if (m.op === 'put') furnishing.put(m.f);
      else if (m.op === 'del') furnishing.remove(m.id);
      else {
        furnishing.setAll(m.list);
        const [by, reset] = [m.by, m.reset];
        chat.system(() => t(reset ? 'chat.furnReset' : 'chat.furnCleared', { name: by }));
      }
      break;
    case 'item':
      pickups.setReady(m.i, m.ready);
      if (!m.ready && m.by === me?.username) weapon.give(pickups.spots[m.i].w);
      break;
    case 'colors': // the teams game started, changed or ended: everyone in their team's colours
      for (const p of m.list) {
        online.set(p.name, p.color);
        if (p.name !== me?.username) avatars.recolor(p.name, p.color);
      }
      showOnline();
      break;
    case 'respawn':
      if (m.name === me?.username) {
        respawnAt(m.spawn, m);
        if (m.drop) beginDrop(undefined, m); // the server chose open ground, by parachute (and where it starts)
      } else avatars.respawn(m.name);
      break;
    case 'round':
      combat.round(m.winner, m.ms);
      chat.system(() => t('combat.wins', { name: m.winner }));
      break;
    case 'newround':
      combat.endRound();
      chat.system(() => serverText(m.code, m.args, m.text));
      break;
    case 'system':
      chat.system(() => serverText(m.code, m.args, m.text));
      if (m.code === 'zRunners') runnersComing(false); // the game's first runners: the banner too
      break;
    case 'spawn':
      if (m.ok) {
        // The start place (or the house's start), by parachute: up over where the server has us land.
        if (m.drop && player.chute === null) beginDrop({ x: m.x, z: m.z, yaw: m.yaw ?? player.yaw, sx: m.sx, sz: m.sz });
        break;
      }
      // The start place was refused (the admin turned the portals off): back to where the server has us.
      player.place(m.x, m.z, groundY(m.x, m.z), player.yaw, 0);
      player.update(0, NO_INPUT, camera);
      break;
    case 'chute':
      chat.system(() => serverText(m.code, m.args ?? {}, t('srv.chuteNotNow')));
      break;
    case 'travel': {
      const to = destination(m.to); // a portal or a street (src/places.ts)
      if (m.name === me?.username) {
        if (trip && trip.to === to && trip.answer) trip.answer(m.ok);
        else if (m.ok && to) arrive(to, null); // a late answer: the server has you there already
        if (!m.ok && m.text) chat.system(() => serverText(m.code, m.args, m.text ?? ''));
      } else if (m.ok && to) {
        // Someone else went: light where they were and where they come out; their figure jumps there.
        const at = avatars.position(m.name);
        if (at) portals.pulse(at.x, at.y, at.z, to.color, 'there');
        avatars.respawn(m.name);
        const [x, z] = m.car ? to.car : to.out;
        portals.pulse(x, groundY(x, z), z, to.color, 'there');
        if (riding && m.car === car.id) {
          // In their passenger seat: you come along (the car's new place follows in a 'car' message).
          warp.style.setProperty('--warp', to.color);
          warp.classList.add('on');
          setTimeout(() => warp.classList.remove('on'), 200);
          hud.announce(portalName(to), to.sub);
        }
      }
      break;
    }
    case 'unstuck': {
      // The server put this player out of the end house's garden (server/game.mjs unstuck): here too, at the same spot.
      player.place(m.x, m.z, groundY(m.x, m.z), player.yaw, 0);
      player.update(0, NO_INPUT, camera);
      break;
    }
    case 'inside': {
      // The state of a home's inside (doors, broken panes, furniture) now that this session has its right (server/game.mjs homeGranted).
      doors.setAll(m.doors ?? {}, m.doorDir ?? {});
      for (const i of m.broken ?? []) glass.break(i, null, undefined, true);
      for (const f of m.furniture ?? []) furnishing.put(f);
      homeLocks.grant([m.id], m.account ? [m.id] : []); // open here too when the account's code was typed on another device
      break;
    }
    case 'homelock':
      // The server holds this player out of a home (no grant, or it ended): shut it here too, so the page agrees.
      if (homeLocks.isOpen(m.id) && me?.role !== 'admin') {
        homeLocks.lock(m.id);
        chat.system(() => t('home.shut'));
      }
      break;
    case 'kicked':
      // Said at the top too: leaving drops the connection before its close could say it, and the
      // message under the join fields is out of sight while playing.
      net.onStatus(() => t('net.removed'));
      setAccount(null, () => t('net.removed'));
      break;
  }
};
/**
 * A tick (shared/wire.mjs, twenty a second): the other players, the cars, the horses and the
 * strongmen, each state with its time on the server's clock; they are drawn a little behind it
 * (net/track.ts). The car you drive is yours: its states from the server are left out.
 */
function onTick(m: Tick): void {
  const self = me?.username ?? '';
  netClock.tick(m.st, performance.now());
  avatars.receive((m.p ?? []).map(readPlayer), m.st, self);
  for (const e of m.c ?? []) {
    const s = readCar(e);
    const c = carById(s.id);
    if (c && !(driving && c === car)) c.sample(m.st - s.age, s);
  }
  horses.receive((m.h ?? []).map(readHorse), m.st, self);
  bikes.receive((m.k ?? []).map(readBike), m.st, self);
  if (m.b) clowns.receive(m.b.map(readBrute), m.st); // every other tick
  if (m.z) zombies.receive(m.z.map(readZombie), m.st); // the same, during the Zombies game
}
// Alone or together from here on (perhaps joined on the start screen already): after the handlers
// above, so the connection's first status and messages reach them. A Zombies room picked there: straight into it.
if (startIntent.room) net.room = startIntent.room;
onAccount(followAccount);
onSession(showAdminParts); // the admin's session alone too: the admin tab's parts for playing alone
onSession(() => {
  if (!me) homeLocks.setAdmin(sessionAdmin()); // and every home's inside, alone too (logged in or out since)
});

/**
 * The map is the menu's first tab (ui/bigmap.ts in its page). M, a short press on the controller's
 * touchpad or a tap on the minimap opens the menu there; again, with the map showing, goes back to
 * the game, and from another tab shows the map. Opening it this way doesn't change the tab Esc
 * opens the menu on.
 */
function toggleMap(): void {
  if (menu.onStartScreen || chat.typing) return;
  if (!menu.open) openMenu('map');
  else if (menu.tab === 'map') menu.resume(menu.mode ?? 'kbm');
  else menu.showTab('map', false);
}
/** The map draws only while its tab shows in the open menu; the world isn't drawn then (below). */
function syncMap(): void {
  const shown = menu.open && !menu.onStartScreen && menu.tab === 'map';
  if (shown === bigMap.open) return;
  if (shown) bigMap.show(mapYou(), menu.mode ?? 'kbm');
  else bigMap.hide();
}
menu.onPage = syncMap;
/** You on the map: where you are and which way you look (in a car, which way it points). */
function mapYou(): { x: number; z: number; yaw: number } {
  return driving || riding ? { x: car.x, z: car.z, yaw: car.yaw } : { x: player.x, z: player.z, yaw: player.yaw };
}
mapBtn.addEventListener('click', () => toggleMap());
/** The way to the big map's waypoint along the roads, worked out again twice a second as you move. */
let routeTimer = 0;
function updateRoute(): void {
  routeTimer = 0;
  const you = mapYou();
  bigMap.route = bigMap.waypoint ? route([you.x, you.z], [bigMap.waypoint.x, bigMap.waypoint.z]) : null;
}
bigMap.onWaypoint = updateRoute;

/**
 * The pause menu, on the tab it was left on, or on `tab`. It opens before the mouse is let go, so
 * the pointer-lock change that follows finds it open and doesn't open it again on another tab. The
 * first time after the teams game starts, on the team picker (Together): on a phone the menu's tabs
 * show only their icons, and "switch teams in the menu" should lead straight there.
 */
function openMenu(tab?: string): void {
  if (!tab && teamsMenu && games.view.kind === 'teams' && games.view.phase === 'playing') {
    tab = 'together';
    teamsMenu = false;
  }
  menu.showPause(tab);
  document.exitPointerLock?.();
  if (me?.role === 'admin') admin.show(me.username);
  leaderboard.refresh();
}
/** Your last state sent: when, what, and whether it had changed (see the end of the frame). */
let sent = { at: -1e9, key: '', moved: true };
let pickupWait = 0;
menu.setGraphics(mode, quality, gpu);
menu.onGraphics = (next) => {
  mode = next;
  saveMode(mode);
  if (mode === 'auto') void autoDetect();
  else applyQuality(mode);
  menu.setGraphics(mode, quality, gpu);
};

function levelName(feet: number): string {
  const own = endHouse?.level(player.x, player.z, feet); // the end house at Molenhoek: its own floors, at its own height
  if (own) return own;
  let name = house.levels[0].name;
  for (const lv of house.levels) if (feet >= lv.floor - 0.3) name = lv.name;
  return name;
}

// Always-visible hint for the menu key, matching how you play.
const menuHint = document.querySelector('#menu-hint kbd')!;
/**
 * How much the game is played, without cookies or anything per person (server/stats.mjs): one start
 * per visit, then a minute at a time while you play with the page in view, and an end on leaving.
 */
let countedStart = false;
let playClock = 0;
// A random number for this visit only (never stored), so the admin can see who plays alone right now.
const visit = Array.from(crypto.getRandomValues(new Uint8Array(12)), (v) => (v % 36).toString(36)).join('');
function beacon(e: 'start' | 'minute' | 'end'): void {
  // Only what you chose in the game, and on starting alone the name you typed (for the admin's log,
  // as the privacy policy says): nothing read from the device.
  const body = { e, id: visit, mode: weapon.enabled ? (paintball.on ? 'paintball' : 'action') : 'explore', control: menu.mode ?? 'kbm', together: !!me, lang: document.documentElement.lang === 'nl' ? 'nl' : 'en', ...(e === 'start' && !me ? { name: menu.nickname } : {}) };
  void fetch('/api/stats/beacon', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
}
// Leaving the page: off the admin's list of who is playing at once, instead of after a quiet minute.
addEventListener('pagehide', () => {
  if (countedStart) beacon('end');
});
menu.onPlay = (mode) => {
  if (!countedStart) {
    countedStart = true;
    beacon('start');
    // The most important controls for the way you play, once, when you start (ui/controlsCard.ts).
    controlsCard.show(mode, weapon.enabled);
    tellHost('playing'); // the split screen starts the next seat (src/seat.ts)
  }
  menuHint.textContent = key('menu', mode);
  touch.show(mode === 'touch');
  if (mode === 'touch') fillScreen(); // the first start asked for it in its tap already (src/start.ts)
  // Keyboard + mouse: capture the mouse so moving it turns the view.
  resumedAt = performance.now();
  if (mode === 'kbm') lockMouse();
  else document.exitPointerLock?.();
};
// Another controller (or the button names in Settings): the menu's button in the HUD by its name.
onPadLabels(() => {
  if (menu.mode) menuHint.textContent = key('menu', menu.mode);
});
/** Capture the mouse. After closing the menu with Esc the browser wants a click first (Esc
 * doesn't count as one), so then the "Click to look around" hint shows until you click. */
function lockMouse(): void {
  try {
    (canvas.requestPointerLock?.() as Promise<void> | undefined)?.catch?.(() => {});
  } catch {
    // Older browsers throw instead of returning a promise; the hint covers it.
  }
}
canvas.addEventListener('click', () => {
  if (!menu.open && menu.mode === 'kbm' && document.pointerLockElement !== canvas) lockMouse();
});
const captureHint = $('capture-hint');
// The most important controls when you start playing; the menu's Controls tab shows them again.
const controlsCard = new ControlsCard();
$('cc-reopen').addEventListener('click', () => controlsCard.show(menu.mode ?? 'kbm', weapon.enabled, true));
// After two minutes of play, once in this browser: stars and a comment for Yoshi (ui/feedback.ts).
const feedback = new FeedbackCard();
let askClock = 0; // seconds played with the menu closed and the page in view
let padStick = 0; // the controller's stick on the card: -1, 0 or 1 (a star per push)
feedback.send = (stars, comment) => api.feedback({
  stars, comment, name: me ? '' : menu.nickname, lang: document.documentElement.lang === 'nl' ? 'nl' : 'en',
  mode: weapon.enabled ? (paintball.on ? 'paintball' : 'action') : 'explore',
});
// The menu's Feedback button: the same card, above the menu, whenever a player wants.
$('menu-feedback').addEventListener('click', () => feedback.show());
// Closed with a click or a tap: back to looking around at once (a click may capture the mouse).
feedback.onClose = (click) => {
  if (click && !menu.open && menu.mode === 'kbm') lockMouse();
};
// The three homes with an access code (src/world/homeLocks.ts): Use at a locked door asks for the home's code.
const homeCard = new HomeCodeCard();
homeCard.try = (home, code) => homeLocks.unlock(home.id, code);
homeCard.onClose = (click) => {
  if (click && !menu.open && menu.mode === 'kbm') lockMouse();
};
let resumedAt = -1e9; // when play last resumed (the menu closed)
document.addEventListener('pointerlockchange', () => {
  // Esc releases the mouse in the browser: treat that as pausing. When the game let it go itself (M,
  // the menu opening), the menu is open already and stays on its tab. Not just after the menu closed:
  // the Esc that closed it can still take back the capture asked for on closing, and the menu (on
  // the map) came straight back, as if Esc didn't close the map (Yoshi). The click hint shows then.
  if (!document.pointerLockElement && menu.mode === 'kbm' && !menu.open && !chat.typing && !feedback.open && !homeCard.open && !loadoutCard.open && performance.now() - loadoutCard.closedAt > 800 && performance.now() - resumedAt > 800) openMenu();
});

window.addEventListener('resize', resize);

// Eye adaptation: indoors the view brightens, outdoors it settles back,
// like your eyes (and the camera in GTA) adjusting when you walk through a door.
const roomNames = new Set<string>(); // the rooms of the insides that are installed (the pack's rooms)
/** A home's inside has been installed (world/insides.ts): its rooms count as indoors, its starting furniture goes in alone. */
function insideInstalled(pack: InsidePack): void {
  for (const r of (pack.rooms ?? []) as unknown as (string | { name: string })[]) roomNames.add(typeof r === 'string' ? r : r.name);
  indoorsAt = makeIndoors([...house.prisms, ...insides.prisms(), ...(house.surroundings?.prisms ?? [])], [...roomNames]);
  furnishing.redraw();
  seedLocalFurniture(pack);
}
let exposure = renderer.toneMappingExposure;
let shake = 0;
let flyHint = 0; // seconds the flying controls still show after taking off
let edgeHint = 0; // seconds "you can't go further" still shows after pushing against the edge of the game
let calmHint = 0; // seconds "no shooting here" still shows on the school grounds
let resting = false; // the gun rested on something in front of you (steadier), and when that was last looked up (ms)
let restAt = 0;
let loadPadX = 0; // the controller's stick on the weapon picker
let loadPadY = 0;
let wasZombies = false;
let homePadX = 0; // the controller's stick on the home card, as padStick is on the feedback card
let homePadY = 0;
let lockKey: 'prompt.locked' | 'prompt.multiplayerOnly' = 'prompt.locked'; // what the hint says: a home is locked, or only in multiplayer (a pane of no home alone)
let gardenCheck = 0; // seconds to the next look at the end house's garden (it is only reached through the house)
let lockHint = 0; // seconds "only in multiplayer" still shows after trying a door or a pane alone
/**
 * Zombies together: helping a downed teammate up. You hold Use next to them; the server keeps the
 * time (server/zombies.mjs help) and says when it starts (`start`, then the ring fills), stops or is
 * done. `helpedBy`: who is helping you up while you're down.
 */
const REVIVE_REACH = 1.5; // m
let helping: { name: string; asked: number; start: number; ms: number } | null = null;
let helpedBy: string | null = null;
/** The nearest downed teammate within reach of you, or null. */
function downedNear(): string | null {
  let best: string | null = null;
  let bd = REVIVE_REACH;
  for (const name of games.view.zombies?.down ?? []) {
    const at = avatars.position(name);
    if (!at || Math.abs(at.y - player.feet) > 1.5) continue;
    const d = Math.hypot(at.x - player.x, at.z - player.z);
    if (d <= bd) [best, bd] = [name, d];
  }
  return best;
}
let horseHint = 0; // seconds the riding keys still show after getting on a horse
let wasOnHorse = false;
let carHint = 0; // the same for the car's speed and keys after getting in
let wasInCar = false;
let bikeHint = 0; // the same on a bike
let wasOnBike = false;
let wasCalm = false;
let wasFlying = false;
let inside = false; // in the house's rooms or on its stairs: the minimap names the floor only then

let last = performance.now();
renderer.setAnimationLoop((now: number) => {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  const polled = input.poll();
  // The feedback card takes the keys while it shows, and for a moment after (its Esc isn't the menu's).
  const card = feedback.open || homeCard.open || loadoutCard.open || now - Math.max(feedback.closedAt, homeCard.closedAt, loadoutCard.closedAt) < 250;
  const frame = card ? { ...NO_INPUT } : polled;
  if (feedback.open && menu.mode === 'pad') {
    // A controller: the stick picks the stars, ✕ sends, ○ or Options closes.
    const stick = Math.abs(polled.moveX) > 0.6 ? Math.sign(polled.moveX) : 0;
    if (stick && stick !== padStick) feedback.step(stick);
    padStick = stick;
    if (polled.confirmPressed) void feedback.submit(false);
    else if (polled.deletePressed || polled.menuPressed) feedback.close(false);
  }
  // A controller types the code on the card's keypad: the stick or D-pad moves, ✕ types, ○ deletes (or closes when empty), Options closes.
  if (homeCard.open && menu.mode === 'pad') {
    const sx = Math.abs(polled.moveX) > 0.6 ? Math.sign(polled.moveX) : 0;
    const sy = Math.abs(polled.moveY) > 0.6 ? -Math.sign(polled.moveY) : 0; // stick up: the row above
    const dx = sx !== homePadX ? sx : 0;
    const dy = sy !== homePadY ? sy : 0;
    homePadX = sx;
    homePadY = sy;
    homeCard.padMove(dx + Math.sign(polled.speedStep), dy - Math.sign(polled.weaponCycle)); // D-pad: left and right, up and down
    if (polled.confirmPressed) homeCard.padPress();
    else if (polled.deletePressed) homeCard.padBack();
    else if (polled.menuPressed) homeCard.close(false);
  }
  // The weapon picker with a controller: the stick or D-pad moves, the south button picks (or plays), east or Options plays.
  if (loadoutCard.open && menu.mode === 'pad') {
    const sx = Math.abs(polled.moveX) > 0.6 ? Math.sign(polled.moveX) : 0;
    const sy = Math.abs(polled.moveY) > 0.6 ? -Math.sign(polled.moveY) : 0;
    loadoutCard.padMove((sx !== loadPadX ? sx : 0) + Math.sign(polled.speedStep), (sy !== loadPadY ? sy : 0) - Math.sign(polled.weaponCycle));
    loadPadX = sx;
    loadPadY = sy;
    if (polled.confirmPressed) loadoutCard.padPress();
    else if (polled.deletePressed || polled.menuPressed) loadoutCard.close(false);
  }
  // The Zombies game begins (alone or together): down to the pistol, the picker away. The rest is found on the map.
  if (games.zombies && !wasZombies) {
    loadoutCard.close(false);
    weapon.resetLoadout([]);
  }
  wasZombies = games.zombies;
  // The controls card shown at the start: a click or ✕ closes it and does nothing else (no shot,
  // no jump); opening the menu closes it too, unless the menu opened it.
  if (controlsCard.open && !controlsCard.fromMenu) {
    if (frame.clickPressed || (menu.mode === 'pad' && frame.jumpPressed)) {
      controlsCard.close();
      frame.clickPressed = frame.jumpPressed = false;
    } else if (menu.open) controlsCard.close();
  }
  if (frame.mapPressed) toggleMap(); // a short press on the touchpad, as M
  // The edge of the game: round the two houses while a game in the house runs (the map shows it at
  // once). Caught outside it (the game began while you were away), you get out of the car or off the
  // horse, and walking puts you in.
  const fence = games.fenced ? (games.view.kind === 'zombies' ? edgeOf(games.view.zombies?.place) : edges.party) : edges.map;
  if (world.bounds !== fence) {
    world.bounds = fence;
    bigMap.setEdge(fence.ring);
    if (!fence.inside(player.x, player.z)) {
      getOut();
      getOffHorse();
      getOffBike();
    }
  }
  menu.setPadState(input.padName);
  hud.setPad(input.padName, menu.mode === 'pad');
  if (frame.fpsPressed) settings.toggle('fps'); // F, or Create on the controller (Settings: FPS counter)
  captureHint.classList.toggle('show', !menu.open && menu.mode === 'kbm' && document.pointerLockElement !== canvas && !chat.typing && !card);

  // The weapons lying around: only in Action mode (Yoshi), and never from the start view, where their
  // rings look like odd logos.
  pickups.group.visible = !menu.onStartScreen && weapon.enabled;
  portals.group.visible = !menu.onStartScreen;
  if (menu.onStartScreen) weapon.hidden = true; // nor the pistol in your hand: from the start view its barrel is a ring mid-screen
  games.setExploring(!weapon.enabled); // the teams game's and Zombies' hints follow a change of mode
  // The villagers in every mode, Action and Paintball too (Yoshi, 7 Nov 2026), but never during Zombies, its end
  // screen included. Shots pass through them: they are never a target (world/villagers.ts).
  // Not in the first seconds of play: building them (unpacking the model, their paths) took 30 ms and more of one
  // frame just as you dropped in, on top of everything else that starts then. One after the other, a little later.
  const played = playBegan ? performance.now() - playBegan : 0;
  const villagersOut = !menu.onStartScreen && games.view.kind !== 'zombies';
  villagers.setActive(villagersOut && played > 2500);
  sinterklaas.setActive(villagersOut && played > 4000 && seasonNow().sinterklaas); // the same rule
  sintMaarten.setActive(villagersOut && seasonNow().sintMaarten, seasonNow().sintMaartenEve);
  christmas.setSolid(games.zombies ? 'off' : weapon.enabled ? 'walk' : 'full'); // the tree, as the server knows the world
  // The Zombies game: the clowns and strongmen stand aside, nobody flies, and whoever is down waits for the wave.
  clowns.paused = games.standAside || !!solo; // alone too (Yoshi: "Strongmen should stay out of zombie")
  player.canFly = rules.flying && !games.zombies;
  if (!player.canFly) player.flying = false;
  combat.waiting = games.view.kind !== 'zombies' ? null : games.zombies && !solo ? () => (helpedBy ? t('z.helping', { name: helpedBy }) : t('z.downWait')) : () => '';
  if (menu.open) {
    travelPanel.hide();
    if (menu.onStartScreen) startCamera();
    else if (menu.tab === 'play') placesList.show(driving ? car.x : player.x, driving ? car.z : player.z, menu.mode ?? 'kbm', travelBlock());
    // Controller in a menu: ✕ picks the controller on the start screen. In the pause menu Options
    // or ○ resumes, and ✕ too except on the map, where it sets a waypoint at the cross; L1 and R1
    // change tabs. Esc resumes (not the Esc that just opened it).
    const pause = !menu.onStartScreen;
    const back = pause && now - menu.openedAt > 300 && (frame.menuPressed || (menu.mode === 'pad' && frame.deletePressed));
    if (bigMap.open) {
      // The Map tab: the left stick (or W A S D) moves it, R2 and L2 zoom.
      bigMap.steer(dt, frame, menu.mode === 'pad');
      if (frame.confirmPressed) bigMap.pickCentre();
    }
    // In the pause menu (not the map) the D-pad moves between the page's controls and ✕ presses the one with
    // the focus; ✕ with nothing focused resumes, as before. Left and right change a slider or a list in place.
    const nav = pause && !bigMap.open;
    if (back) {
      padNav.reset();
      menu.resume(menu.mode ?? 'pad');
    } else if (frame.confirmPressed && !bigMap.open && !(nav && padNav.press())) {
      padNav.reset();
      menu.resume(menu.onStartScreen ? 'pad' : (menu.mode ?? 'pad'));
    } else if (pause && frame.tabStep) {
      padNav.reset();
      menu.stepTab(frame.tabStep);
    } else if (nav && (frame.navX || frame.navY)) {
      if (!(frame.navX && padNav.adjust(frame.navX))) padNav.step(frame.navX, frame.navY);
    } else if (frame.squarePressed) {
      menu.cycleGraphics(); // the square button on the controller changes the graphics setting
    } else if (!pause && frame.speedStep) {
      menu.setSpeed(menu.walkSpeed + frame.speedStep * 0.2); // the start screen: left and right, the walking speed
    }
    // A drop goes on behind the menu, hands off (the server holds it to the clock and to coming down).
    if (pause && player.chute !== null) {
      player.update(dt, NO_INPUT, camera);
      filmDrop(dt);
    }
  } else {
    if (frame.menuPressed && !chat.typing) openMenu();
    if (document.visibilityState === 'visible' && (playClock += dt) >= 60) {
      playClock -= 60;
      beacon('minute');
    }
    // The feedback card at a quiet moment after two minutes: not while down, driving, riding along,
    // furnishing, typing in the chat or travelling.
    if (!seat && feedback.due && !feedback.open && document.visibilityState === 'visible' && (askClock += dt) >= ASK_AFTER
      && combat.alive && !driving && !riding && !chat.typing && !trip) feedback.show();
    // Dead: the view sinks to the floor; you can look around but not move or shoot.
    const dead = !combat.alive;
    player.down += ((dead ? 1 : 0) - player.down) * (1 - Math.exp(-dt * 5));
    if (driving) {
      // At the wheel: W/S or R2/L2, steer with A/D or the left stick, Space or Cross for the handbrake.
      const [turn, tilt] = player.look(dt, frame);
      const hit = car.drive(dt, { throttle: frame.throttle, brake: frame.brake, steer: frame.moveX, handbrake: frame.jumpHeld }, avatars.obstacles());
      if (hit > 2.5) {
        car.bump(hit);
        rumble(Math.min(1, hit / 10), 0.6, 140);
        shake = Math.max(shake, Math.min(0.5, hit / 20));
      }
      car.chase(camera, dt, turn, tilt);
      // You are where the car is: for the map, the place name, and what the others see.
      player.place(car.x, car.z, car.y, player.yaw, player.pitch);
      player.ground = world.groundAt(car.x, car.z, car.y + 0.1, 0.3);
    } else if (riding) {
      // Riding along: look around with the mouse or the right stick, the car takes you.
      const [turn, tilt] = player.look(dt, frame);
      car.chase(camera, dt, turn, tilt);
      player.place(car.x, car.z, car.y, player.yaw, player.pitch);
      player.ground = world.groundAt(car.x, car.z, car.y + 0.1, 0.3);
    } else if (horses.mounted >= 0) {
      // On horseback: W/S (or R2/L2) faster and slower, Shift to gallop, A/D to steer; look round from the saddle.
      const [turn, tilt] = player.look(dt, frame);
      horses.ride(dt, { throttle: frame.throttle, brake: frame.brake, steer: frame.moveX, gallop: frame.sprint, jump: frame.jumpPressed });
      horses.saddleView(camera, turn, tilt);
      const r = horses.ridden!;
      player.place(r.x, r.z, r.y, camera.rotation.y, camera.rotation.x);
      player.ground = world.groundAt(r.x, r.z, r.y + 0.1, 0.3);
    } else if (bikes.mounted) {
      // On a bike: W/S (or R2/L2, or the stick) pedal and brake, A/D steer, the jump key rings the bell; the camera close behind.
      const [turn, tilt] = player.look(dt, frame);
      const hit = bikes.ride(dt, { throttle: Math.max(frame.throttle, frame.moveY), brake: Math.max(frame.brake, -frame.moveY), steer: frame.moveX }, avatars.obstacles());
      if (hit > 2) {
        rumble(Math.min(1, hit / 8), 0.4, 100);
        shake = Math.max(shake, Math.min(0.3, hit / 25));
      }
      if (frame.jumpPressed) {
        bikes.bell();
        net.send({ t: 'bell' });
      }
      bikes.chase(camera, dt, turn, tilt);
      const k = bikes.ridden!;
      player.place(k.x, k.z, k.y, player.yaw, player.pitch);
      player.ground = world.groundAt(k.x, k.z, k.y + 0.1, 0.3);
    } else {
      // Dead: only looking around. The seeker in hide and seek: eyes shut, not even that.
      aimAssist.shape(frame, dt, player, camera.position, settings.value.aimAssist && menu.mode === 'pad' && games.zombies && weapon.enabled && !dead, weapon.current === 'sniper');
      const still = games.blindfolded ? NO_INPUT : { ...NO_INPUT, mouseX: frame.mouseX, mouseY: frame.mouseY, lookX: frame.lookX, lookY: frame.lookY };
      player.update(dt, dead || games.blindfolded ? still : frame, camera);
    }
    filmDrop(dt); // in a drop: filmed from behind
    // A blast nearby shakes the view for a moment (on top of where you look, so aim comes back).
    if (shake > 0.002) {
      const t = now / 1000;
      camera.rotation.x += (Math.sin(t * 53) + Math.sin(t * 31)) * 0.012 * shake;
      camera.rotation.y += (Math.sin(t * 47) + Math.sin(t * 23)) * 0.012 * shake;
      camera.rotation.z += Math.sin(t * 41) * 0.015 * shake;
      shake *= Math.exp(-dt * 4);
    }
    combat.showBoard(frame.scoreHeld && !!me);
    const onBike = bikes.mounted !== null;
    const inCar = driving || riding || onBike; // on a bike as in a car: no weapons, no doors
    const onHorse = horses.mounted >= 0; // you may shoot from the saddle
    weapon.hidden = dead || inCar || games.peaceful || player.chute !== null || dropView.outside; // in a drop, and until the camera is back in your eyes

    // The portals: on a pad (or stopped on one in the car) the list of places opens, and takes the
    // number keys, the wheel or D-pad and E. Not on horseback, nor from the passenger seat.
    const mode = menu.mode ?? 'kbm';
    let pad = !rules.portals || trip || dead || riding || onHorse || onBike || games.fenced ? null
      : driving ? (Math.abs(car.speed) < CAR_SLOW ? portalNear(car.x, car.z, CAR_REACH) : null)
      : portalNear(player.x, player.z);
    if (pad && !driving && Math.abs(player.feet - portals.groundOf(pad)) > 1.5) pad = null; // flying over it
    if (pad && pad.id === justArrived) pad = null;
    else justArrived = null;
    portals.active = pad?.id ?? null;
    if (pad) {
      travelPanel.show(pad, cameFrom, mode, driving);
      if (travelPanel.handle(frame, mode)) {
        frame.weaponSlot = 0;
        frame.weaponCycle = 0;
        frame.usePressed = false;
      }
    } else travelPanel.hide();

    // Doors and the weapon. In Action mode a click (or R2) shoots and E (or Triangle) opens doors.
    doors.update(dt);
    const action = weapon.enabled && !games.peaceful; // no fighting during a party game (the teams game is one)
    // Party games: a seeker or "it" next to someone tags them with E (or a click).
    const tagWho = inCar || dead ? null : games.target([...online.keys()], (n) => avatars.position(n), player.x, player.feet, player.z);
    if (tagWho && (frame.usePressed || frame.clickPressed)) games.tag(tagWho);
    // Zombies together: next to a downed teammate, holding Use helps them up (not a door then).
    const downed = games.zombies && !!me && !dead && !inCar && !onHorse ? downedNear() : null;
    if (downed && frame.useHeld) {
      if (helping?.name !== downed || (!helping.start && now - helping.asked > 1000)) {
        helping = { name: downed, asked: now, start: 0, ms: helping?.name === downed ? helping.ms : 3000 };
        net.send({ t: 'revive', name: downed, on: true });
      }
    } else if (helping) {
      net.send({ t: 'revive', name: helping.name, on: false });
      helping = null;
    }
    const target = inCar || onHorse || tagWho || downed ? null : doors.lookedAt(camera);
    // A football within reach (world/football.ts): Use kicks it where you look, harder on the run; a click too where it
    // doesn't shoot (Explore, the school grounds). Before the cars and horses; a door you look at goes first.
    const ball = inCar || onHorse || tagWho || downed || target || dead || player.flying || player.chute !== null ? null : football.near(player.x, player.feet, player.z);
    if (ball && (frame.usePressed || ((!action || !!noShoot(player.x, player.z)) && frame.clickPressed))) {
      football.kick(ball, player.yaw, player.pitch, me?.username ?? '', net.connected ? (msg) => net.send(msg) : null);
      frame.usePressed = frame.clickPressed = false;
    }
    if (target && (frame.usePressed || (!action && frame.clickPressed))) {
      if (target.home) {
        // A locked home (src/world/homeLocks.ts): the door asks for its code.
        frame.usePressed = false;
        const home = findHome(target.home);
        if (home) homeCard.show(home, menu.mode === 'pad');
      } else {
        target.toggle();
        if (target.locked) {
          lockHint = 4;
          lockKey = 'prompt.multiplayerOnly';
        }
      }
    }
    games.update(dt, player.x, player.feet, player.z, key('use', mode));
    // The cars: E or Triangle next to one gets you in (unless two are in it already), and out again.
    if (!inCar && !wantCar) car = cars.reduce((a, b) => (b.distanceTo(player.x, player.z) < a.distanceTo(player.x, player.z) ? b : a));
    // Not during the Zombies game (getIn and mountHorse say why if tried anyway).
    const nearCar = !inCar && !onHorse && !dead && !games.zombies && car.distanceTo(player.x, player.z) < CARS.reach && Math.abs(player.feet - car.y) < 1;
    // The horses: E next to one gets you on it, and off again.
    const nearHorse = !inCar && !onHorse && !dead && !nearCar && !games.zombies && horseWanted < 0 ? horses.nearest(player.x, player.z) : -1;
    // The bikes: E next to one gets you on it, and off again.
    const nearBike = !inCar && !onHorse && !dead && !nearCar && nearHorse < 0 && !games.zombies && bikeWanted === null ? bikes.nearest(player.x, player.z, player.feet) : null;
    const bikeTaken = !!nearBike?.rider && nearBike.rider !== me?.username;
    // Sinterklaas or Sint-Maarten on the church square in their days (world/sinterklaas.ts): E next to him, and he hands out a treat.
    const nearSint = !inCar && !onHorse && !dead && !nearCar && nearHorse < 0 && !nearBike && !target ? [sinterklaas, sintMaarten.rider].find((s) => s.near(player.x, player.z, player.feet)) : undefined;
    // In front of the notice board on the square (world/townBoard.ts): E opens the menu's whole leaderboard.
    const nearBoard = !inCar && !onHorse && !dead && !nearCar && nearHorse < 0 && !nearBike && !target && !nearSint && !games.zombies && townBoard.near(player.x, player.z, player.feet);
    const carTaken = !!car.driver && car.driver !== me?.username;
    const seatFree = carTaken && !car.passenger;
    if ((driving || riding) && frame.usePressed) getOut();
    else if (onHorse && frame.usePressed) getOffHorse();
    else if (onBike && frame.usePressed) getOffBike();
    else if (nearCar && !target && (!carTaken || seatFree) && !wantCar && frame.usePressed) getIn();
    else if (nearHorse >= 0 && !target && frame.usePressed) mountHorse(nearHorse);
    else if (nearBike && !bikeTaken && !target && frame.usePressed) getOnBike(nearBike.id);
    else if (nearSint && frame.usePressed) nearSint.treat(player.x, player.z);
    else if (nearBoard && frame.usePressed) {
      openMenu('together');
      leaderboard.reveal();
    }
    if (action && !dead && !inCar) {
      if (frame.weaponSlot) weapon.selectSlot(frame.weaponSlot);
      if (frame.weaponCycle) weapon.cycle(frame.weaponCycle === 2 ? 0 : frame.weaponCycle);
      // Walk over a weapon to take it (the server decides in multiplayer).
      const item = pickups.near(player.x, player.feet, player.z);
      if (item >= 0 && performance.now() > pickupWait) {
        if (net.connected) {
          net.send({ t: 'pickup', i: item });
          pickupWait = performance.now() + 600;
        } else {
          pickups.setReady(item, false);
          weapon.give(pickups.spots[item].w);
        }
      }
      // Accuracy: steady when crouching, worse when running or in the air.
      const moving = Math.hypot(frame.moveX, frame.moveY);
      // The gun rested on something: standing still with a ledge, a sill, a low wall or a car's roof in front at
      // chest height and nothing at eye height. Looked up four times a second.
      if (now - restAt > 250) {
        restAt = now;
        const fx = -Math.sin(player.yaw) * 0.8;
        const fz = -Math.cos(player.yaw) * 0.8;
        const chest = player.eyeY - 0.42;
        resting = moving < 0.1 && !player.flying
          && world.blocked({ x: player.x, y: chest, z: player.z }, { x: player.x + fx, y: chest, z: player.z + fz })
          && !world.blocked({ x: player.x, y: player.eyeY, z: player.z }, { x: player.x + fx, y: player.eyeY, z: player.z + fz });
      }
      weapon.rest = resting ? 0.6 : 1;
      weapon.spreadMul = player.crouching ? 0.6 : player.flying || player.feet > player.ground.y + 0.05 ? 2 : frame.sprint && moving ? 1.8 : moving ? (weapon.current === 'rifle' ? 1.1 : weapon.current === 'sniper' ? 1.8 : 1.25) : 1;
    }
    // The school grounds: no shooting or throwing (shared/zones.mjs; the server refuses too). Said on
    // the way in and whenever you try.
    const school = action && !!noShoot(player.x, player.z);
    if (school && !wasCalm) calmHint = 4;
    if (school && (frame.clickPressed || frame.throwPressed)) calmHint = 2;
    wasCalm = school;
    const calm = school || player.chute !== null; // nobody shoots from under a parachute (the server holds to it too)
    weapon.advanceFire(dt, action && frame.fireHeld && !dead && !inCar && !calm);
    if (action && (frame.clickPressed || (weapon.isAuto && frame.fireHeld)) && !dead && !inCar && !calm) fire();
    if (action && frame.reloadPressed && !dead && !inCar) weapon.reload();
    // The reload key held, with stakes in your pocket (Zombies): it plants a row (the tap reloads as ever).
    if (action && !dead && !inCar && !calm && kit.stakes > 0 && games.zombies) {
      if (frame.reloadPressed) stakeT = 1e-4;
      if (stakeT > 0 && frame.reloadHeld) {
        stakeT += dt;
        if (stakeT >= HOLD_S) {
          stakeT = 0;
          plantStakes();
        }
      } else stakeT = 0;
    } else stakeT = 0;
    // The Use key held with a turret in your pocket (Zombies), with nothing else to use (no door, nobody to help up): it sets it up.
    if (action && !dead && !inCar && !calm && kit.turrets > 0 && games.zombies && !downed && !target && !tagWho) {
      if (frame.usePressed) useT = 1e-4;
      if (useT > 0 && frame.useHeld) {
        useT += dt;
        if (useT >= HOLD_S) {
          useT = 0;
          setUpTurret();
        }
      } else useT = 0;
    } else useT = 0;
    // The grenade key: a tap throws a grenade; with a claymore in your pocket (Zombies), held it places it.
    if (action && !dead && !inCar && !calm) {
      if (kit.claymores > 0 && games.zombies) {
        if (frame.throwPressed) holdT = 1e-4;
        if (holdT > 0 && frame.throwHeld) {
          holdT += dt;
          if (holdT >= HOLD_S) {
            holdT = 0;
            placeClaymore();
          }
        } else if (holdT > 0) {
          holdT = 0;
          throwGrenade();
        }
      } else if (frame.throwPressed) throwGrenade();
    } else holdT = 0;
    // Walk over a reward to take it (the server decides together).
    if (action && !dead && !inCar && games.zombies) {
      const it = rewards.near(player.x, player.feet, player.z);
      if (it >= 0 && now > rewardWait) {
        rewardWait = now + 400;
        if (net.connected) net.send({ t: 'zitem', id: it });
        else if (solo) {
          const got = solo.loot.take(SOLO_ME, { x: player.x, y: player.feet, z: player.z, w: weapon.current }, it, performance.now());
          if (got) gift(got.kind, got.w, got.kit);
        }
      }
    }
    // In a car the view widens a little at speed (world/car.ts: fovScale), from the player's own field of view.
    weapon.baseFov = settings.value.fov * (driving || riding ? car.fovScale : 1);
    if (!weapon.enabled && Math.abs(camera.fov - weapon.baseFov) > 0.01) {
      camera.fov = weapon.baseFov;
      camera.updateProjectionMatrix();
    }
    weapon.setSleeve(avatars.suit(me?.username ?? '', myColour())); // your sleeves as your figure's suit
    weapon.update(dt, inCar ? 0 : Math.min(1, Math.hypot(frame.moveX, frame.moveY)), frame.aimHeld && !inCar, {
      yaw: player.yaw, pitch: player.pitch, side: dead ? 0 : frame.moveX, sprint: frame.sprint && !player.crouching,
      air: player.flying || player.feet > player.ground.y + 0.05, steady: frame.steadyHeld,
    });
    player.pitch -= weapon.takeRecover(); // the recoil's climb comes back down after the burst
    player.carry = weapon.carrySpeed; // a heavy gun slows your walk, aiming more
    // The torch: from dusk on, with a gun in your hands and on your feet.
    torch?.update(camera, weapon.enabled && !dead && !inCar ? Math.max(0, Math.min(1, (mood.night - 0.35) / 0.35)) : 0, dt);
    // The keys in the prompts come from the one table (src/shortcuts.ts). In Explore a click opens doors too.
    const doorKey = key(action ? 'use' : 'click', mode);
    const use = key('use', mode);
    touch.setState(action, inCar, player.chute === null ? null : player.canopy === null ? 'fall' : 'canopy', onBike);
    const speed = (v: number) => Math.round(Math.abs(v) * 3.6);
    const carLabel = carName(car.kind ?? car.id, car.spec.name);
    let prompt = target ? t(target.home ? 'home.door' : target.locked ? 'prompt.locked' : target.open ? 'prompt.close' : 'prompt.open', { key: doorKey, door: doorName(target.name) }) : '';
    if (target && homeLocks.accountDoor(target.id)) prompt += `  ·  ${t('home.byAccount')}`; // a home the account opens for good
    // The car's speed and keys for the first few seconds in it only (Yoshi, as on a horse).
    if (driving) prompt = carHint > 0 ? t('prompt.driving', { speed: speed(car.speed), hb: key('handbrake', mode), use }) : '';
    else if (tagWho) prompt = t('prompt.tag', { use, name: tagWho });
    else if (riding) prompt = carHint > 0 ? t('prompt.riding', { name: car.driver ?? t('prompt.nobody'), speed: speed(car.speed), use }) : '';
    else if (nearCar && !target) {
      prompt = !carTaken ? t('prompt.drive', { use, car: carLabel })
        : seatFree ? t('prompt.rideAlong', { use, name: car.driver ?? '' })
        : t('prompt.carFull', { a: car.driver ?? '', b: car.passenger ?? '', car: carLabel });
    }
    else if (onHorse) {
      // The riding keys for the first few seconds on horseback only (Yoshi, as the flying keys).
      if (horseHint > 0) prompt = t('prompt.horse', { speed: speed(horses.ridden!.speed), gallop: key('sprint', mode), breath: Math.round(horses.stamina * 100), jump: key('jump', mode), use });
    }
    else if (nearHorse >= 0 && !target) prompt = t('prompt.mount', { use });
    else if (onBike) {
      // The bike's speed and keys for the first few seconds on it only, as in the car.
      if (bikeHint > 0) prompt = t('prompt.cycling', { speed: speed(bikes.ridden?.speed ?? 0), bell: key('bell', mode), use });
    }
    else if (nearBike && !target) prompt = bikeTaken ? t('prompt.bikeTaken', { name: nearBike.rider ?? '' }) : t('prompt.bike', { use });
    else if (nearSint) prompt = t(nearSint.spec.prompt, { use });
    else if (nearBoard) prompt = t('prompt.board', { use });
    else if (player.towerHint && !inCar && !onHorse) prompt = towerPrompt(player.towerHint, mode); // the play tower's ladder
    if (ball && !tagWho && !driving && !riding) prompt = t('prompt.kick', { key: key(action && !noShoot(player.x, player.z) ? 'use' : 'click', mode), run: key('sprint', mode) });
    if (downed) prompt = helping?.start ? t('prompt.reviving', { name: downed }) : t('prompt.revive', { use, name: downed });
    hud.setRing(helping ? (helping.start ? (now - helping.start) / helping.ms : 0) : null);
    if (pad) prompt = ''; // the list says it all
    else if ((!inCar || onBike) && portalNear(player.x, player.z) && (onHorse || onBike || !rules.portals || games.fenced)) prompt = t(onHorse ? 'prompt.horsePortal' : onBike ? 'prompt.bikePortal' : games.fenced ? 'prompt.portalGame' : 'prompt.portalsOff');
    hud.setPrompt(prompt);
    const armed = action && !dead && !inCar;
    hud.setWeapon(armed, dead || inCar ? '' : weapon.status);
    hud.setSlots(armed ? weapon.slots : null);
    const pocket = games.zombies ? [
      kit.claymores ? t('loot.mines', { name: mineName(), n: kit.claymores, key: key('grenade', mode) }) : '',
      kit.stakes ? t('loot.stakesCount', { n: kit.stakes, key: key('reload', mode) }) : '',
      kit.turrets ? t('loot.turretCount', { key: key('use', mode) }) : '',
    ].filter(Boolean).join('   ·   ') : '';
    hud.setGrenades(armed ? grenades.count : null, GRENADE.carry, grenades.nextIn, key('grenade', mode), pocket);
    hud.setScope(weapon.scoped, inCar || dropView.outside, weapon.scopeView);
    touch.setScoped(weapon.scoped);
    if (armed) hud.setSpread(weapon.spread, weapon.current === 'bazooka' ? 0 : weapon.aimAmount); // the bazooka aims with the crosshair
    document.body.classList.toggle('drop', dropView.outside); // filmed from behind: the hints go low, clear of your figure (style.css)
    // The flying controls for the first few seconds after taking off only (Yoshi: annoying when it stays).
    if (player.flying && !wasFlying) flyHint = 4;
    const onHorseNow = horses.mounted >= 0;
    if (onHorseNow && !wasOnHorse) horseHint = 5;
    wasOnHorse = onHorseNow;
    horseHint = onHorseNow ? horseHint - dt : 0;
    if (onBike && !wasOnBike) bikeHint = 5;
    wasOnBike = onBike;
    bikeHint = onBike ? bikeHint - dt : 0;
    const inCarNow = driving || riding;
    if (inCarNow && !wasInCar) carHint = 5;
    wasInCar = inCarNow;
    carHint = inCarNow ? carHint - dt : 0;
    wasFlying = player.flying;
    flyHint = player.flying ? flyHint - dt : 0;
    if (flyHint > 0) hud.setPrompt(t('prompt.fly', { up: key('jump', mode), down: key('down', mode) }));
    // Against the edge of the game or its ceiling: a short line saying so (and why, during a game in the house).
    if (driving ? car.atEdge : onHorse ? horses.atEdge : onBike ? bikes.atEdge : !riding && player.atEdge) edgeHint = 2.5;
    edgeHint -= dt;
    // Zombies away from home: the edge is round its place, not the house.
    const away = games.view.kind === 'zombies' && arenaOf(games.view.zombies?.place).id !== 'house';
    if (edgeHint > 0) hud.setPrompt(t(games.fenced ? (away ? 'prompt.edgeHere' : 'prompt.edgeGame') : 'prompt.edge'));
    calmHint = wasCalm ? calmHint - dt : 0;
    if (player.chute !== null) hud.setPrompt(dropPrompt(mode));
    else if (calmHint > 0) hud.setPrompt(t('prompt.noShoot'));
    lockHint -= dt;
    if (lockHint > 0 || (target?.locked && !target.home)) hud.setPrompt(t(target?.locked && !target.home ? 'prompt.multiplayerOnly' : lockKey), true);
    // Somebody dropped into the end house's fenced garden without the code has no way out: put outside, in front of it.
    gardenCheck -= dt;
    if (gardenCheck <= 0) {
      gardenCheck = net.connected ? 2 : 0.5; // together it asks the server, which answers at most once a second
      if (!homeLocks.isOpen('molenhoek_end') && inEndGarden(player.x, player.z, player.feet)) putOutside();
    }

    // Tell the others where you are: 20 times a second while anything changes, and once more when
    // it stops (so they see you stand where you stopped), then about three times a second. Each
    // carries this page's time for it (`ct`), so the others draw it at an even pace (shared/wire.mjs).
    if (net.connected && !trip?.answer) {
      const r = horses.ridden;
      const k = bikes.ridden;
      const cm = (v: number) => Math.round(v * 100) / 100;
      const mrad = (v: number) => Math.round(v * 1000) / 1000;
      const where = driving || riding
        ? { x: cm(car.x), y: cm(car.y), z: cm(car.z), yaw: mrad(car.yaw), pitch: 0, flying: false, c: false, d: true, s: cm(car.steer) }
        : r
          ? { x: cm(r.x), y: cm(r.y + r.jump + 1.64), z: cm(r.z), yaw: mrad(player.yaw), pitch: mrad(player.pitch), flying: false, c: true, hy: mrad(r.yaw), hs: cm(r.speed), hj: cm(r.jump) } // seated in the saddle
          : k
            ? { x: cm(k.x), y: cm(k.y), z: cm(k.z), yaw: mrad(k.yaw), pitch: mrad(player.pitch), flying: false, c: false } // on the bike: its place and its way
          : { x: cm(player.x), y: cm(player.feet), z: cm(player.z), yaw: mrad(player.yaw), pitch: mrad(player.pitch), flying: player.flying, c: player.crouching, ...(player.chute !== null ? { pc: 1, ...(player.canopy !== null ? { po: 1 } : {}) } : {}) };
      const state = { t: 'state', ...where, armed: weapon.enabled, w: weapon.current, ...(weapon.enabled && weapon.aimAmount > 0.6 ? { a: 1 } : {}) }; // `a`: the gun at your eye, for how the others see you
      const key = JSON.stringify(state);
      const changed = key !== sent.key;
      const every = changed || sent.moved ? 50 : 300;
      if (now - sent.at >= every - 4) {
        sent = { at: Math.max(sent.at + every, now - 25), key, moved: changed }; // 20 a second on average at any frame rate
        net.send({ ...state, ct: Math.round(now) });
      }
    }

    const surface = player.ground.name;
    // Not in a drop: the floor you jumped from keeps its name until you land (it lit the parachute as a room).
    const indoors = player.chute === null && indoorName(surface, roomNames); // shared/parking.mjs: rooms, floors, stairs; never roofs, terraces, the outside stair
    inside = indoors;
    // Outside, on the village's ground: the street you are in (its real name), not just "street".
    const at = driving || riding ? car : player;
    const street = !indoors && (driving || riding || !surface || surface === 'street') ? streetAt(at.x, at.z) : undefined;
    // The hamlet under the floor's name: the nearest portal's (Briel by the house and the bungalow, Smetlede in the village).
    const area = PORTALS.reduce((a, b) => (Math.hypot(b.x - at.x, b.z - at.z) < Math.hypot(a.x - at.x, a.z - at.z) ? b : a)).sub;
    hud.setPlace(indoors ? placeName(levelName(player.feet)) : t('place.outside'), street ?? (surface && surface !== 'street' ? placeName(surface) : undefined), area);
    // Real-time lighting brightens rooms itself, so the eyes need to adapt only a little.
    const wanted = (indoors ? 1.05 : 0.9) * weather.exposure; // white walls since 30 Oct: less brightening; the weather's eyes (world/weather.ts)
    exposure += (wanted - exposure) * (1 - Math.exp(-dt * 1.5));
    renderer.toneMappingExposure = exposure;
    indoorLight.update(dt, indoors, 1);
  }
  netClock.frame(now); // the time the others are drawn at (net/track.ts)
  for (const c of cars) c.update(dt, driving && c === car, camera.position);
  const cycling = driving || riding ? null : bikes.ridden;
  speedometer.update(!menu.open && combat.alive ? (driving || riding ? car.speed : cycling?.speed ?? null) : null, cycling ? BIKES_DATA.maxSpeed : car.spec.maxSpeed);
  combat.tick(dt);
  sound.listen(camera);
  roomSound.update(dt, inside, player.ground.name, camera.position);
  weather.update(dt, camera.position, inside); // the rain round the eye (none indoors), the street lamps
  setWindowNight(mood.night); // lights in about half of the village's rooms at night (world/windows.ts)
  player.lookScale = camera.fov / weapon.baseFov; // slower turning while zoomed in (not faster for the car's wider view)
  glass.update(dt);
  furnishing.update(dt, camera.position);
  effects.particles.budget = quality === 'low' ? 0.5 : 1; // big smoke puffs are many pixels each
  // Splashes: rings round you afloat, spray from the wheels of a car through a ford (world/splashes.ts).
  effects.splashes.swim(player.x, player.z, player.water, dt);
  for (const c of cars) {
    if (!c.ready || Math.hypot(c.x - camera.position.x, c.z - camera.position.z) >= 80) continue;
    effects.splashes.wheels(c.id, c.x, c.z, c.y, c.yaw, c.spec.length / 2, c.spec.width / 2, dt);
    tyreSpray.wheels(c.id, c.x, c.z, c.y, c.yaw, c.spec.length / 2, c.spec.width / 2, dt); // and spray in the rain (world/tyreSpray.ts)
  }
  for (const k of bikes.riders()) {
    effects.splashes.wheels(`bike-${k.id}`, k.x, k.z, k.y, k.yaw, 0.55, 0.12, dt); // yours and the others' bikes through a ditch
    tyreSpray.wheels(`bike-${k.id}`, k.x, k.z, k.y, k.yaw, 0.85, 0.1, dt, true);
  }
  effects.update(dt);
  grenades.update(dt);
  pickups.update(dt, !net.connected);
  rewards.update(dt);
  const placing = !menu.open && combat.alive && games.zombies
    ? holdT > 0 ? 'claymore' : stakeT > 0 ? 'stakes' : useT > 0 ? 'turret' : null
    : null;
  const placeAt = placing ? spotAhead(placing === 'stakes' ? 1.3 : placing === 'turret' ? 1 : .9) : null;
  let placeOK = !!placeAt;
  if (placing && placeAt) {
    if (solo) {
      placementResult = { id: 0, ...solo.loot.preview(placing, SOLO_ME, { x: player.x, y: player.feet, z: player.z }, { ...placeAt, yaw: player.yaw }, performance.now()) };
    } else if (net.connected) {
      const changed = !placementPoint || placementPoint.kind !== placing || Math.hypot(placeAt.x - placementPoint.x, placeAt.z - placementPoint.z) > .08 || Math.abs(player.yaw - placementPoint.yaw) > .08;
      if (changed) placementResult = null;
      if (performance.now() - placementSent > 180) {
        placementPoint = { ...placeAt, kind: placing, yaw: player.yaw };
        placementSent = performance.now();
        net.send({ t: 'placement', id: ++placementRequest, kind: placing, ...placeAt, yaw: player.yaw });
      }
    }
    placeOK = placeOK && !!placementResult?.ok;
  } else {
    placementResult = null;
    placementPoint = null;
  }
  tactics.placement(placing, placeAt, player.yaw, placeOK, placementResult?.why,
    placementResult?.a !== undefined && placementResult?.b !== undefined ? [placementResult.a, placementResult.b] : undefined);
  const cooperative = games.zombies || games.view.kind === 'teams';
  const teammates = cooperative && !games.hideOthers ? avatars.marks().filter((p) => games.zombies || games.friend(p.name))
    .map((p) => ({ ...p, y: avatars.position(p.name)?.y ?? player.feet })) : [];
  if (games.zombies && games.view.phase === 'break') {
    for (const [, kind, x, y, z] of games.view.zombies?.items ?? []) {
      if (Math.hypot(x - player.x, z - player.z) < 45) teammates.push({ name: kind === 'claymore' ? mineName() : t(LOOT_LABELS[kind]), x, y: y - 1.2, z, color: '' });
    }
  }
  tactics.update(camera, !menu.open && combat.alive && cooperative, teammates, net.connected);
  cats.update(dt);
  life.update(dt, camera.position);
  villageSmoke?.follow(dt, camera.position, !phone && quality !== 'low');
  // Alone, the strongmen fight here, going for you when you fight (in multiplayer the server runs them).
  if (!net.connected) clowns.stepAlone(dt, combat.alive && weapon.enabled && !driving && !riding && !games.peaceful ? { x: player.x, y: player.feet, z: player.z } : null);
  clowns.update(camera.position);
  // The Zombies game: alone its horde steps here; together the server's ticks move them. Then they're drawn.
  if (!net.connected) soloTick(dt);
  zombies.update(dt, camera.position);
  if (!noFootball) {
    fcGround.update(dt, camera.position);
    fcLife.update(dt, camera.position); // its figures are drawn with the villagers
  }
  villagers.update(dt, camera.position, camera.getWorldDirection(villagerLook), driving || riding || horses.mounted >= 0 ? null : { x: player.x, z: player.z, feet: player.feet }, [
    ...roadLife.traffic.cars,
    ...cars.filter((c) => (driving && c === car) || !!c.driver).map((c) => ({ x: c.x, z: c.z, yaw: c.yaw, length: c.spec.length, width: c.spec.width })),
  ]);
  horses.update(dt, camera.position);
  bikes.update(dt, camera.position);
  christmas.update(dt, seasonNow().christmas, camera, renderer.domElement.height);
  sinterklaas.update(dt, camera, driving || riding || horses.mounted >= 0 || bikes.mounted ? null : { x: player.x, z: player.z }, !menu.open, { w: window.innerWidth, h: window.innerHeight });
  sintMaarten.update(dt, camera, driving || riding || horses.mounted >= 0 || bikes.mounted ? null : { x: player.x, z: player.z }, !menu.open, { w: window.innerWidth, h: window.innerHeight }, villagers);
  townBoard.update(camera.position);
  // The footballs: walked into on foot (alone here; together the server does it too, and leads).
  const onFoot = combat.alive && !driving && !riding && !bikes.mounted && horses.mounted < 0 && !player.flying && player.chute === null;
  football.update(dt, camera.position, onFoot ? { x: player.x, z: player.z, feet: player.feet, name: me?.username ?? '' } : null, net.connected);
  // The others, after the horses and bikes: a rider sits in the saddle where it is drawn this frame.
  avatars.tick(dt, camera.position, driving || riding || horses.mounted >= 0 || bikes.mounted ? null : { x: player.x, z: player.z });
  slideSound.update(player.slideSpeed); // the whoosh down the play tower's slide
  myChute.position.set(player.x, player.feet, player.z);
  myChute.rotation.y = player.yaw;
  parachutes.far = quality === 'low' ? 15 : 35;
  // Your own figure while filmed from behind: its own animation first (as the others'), then the parachute poses it.
  ownFigure = dropView.own(myColour(), player.chute !== null);
  if (ownFigure?.root.visible) {
    ownFigure.animate(dt, {
      speed: 0, forward: 0, side: 0, armed: false, alive: true, crouch: false, flying: false, pitch: 0, weapon: weapon.current,
      yaw: player.yaw, air: player.air, vy: 0, seat: null, far: camera.position.distanceTo(myChute.position),
    });
  }
  parachutes.fly('', myChute, ownFigure, myColour(), player.chute !== null, player.canopy !== null, player.air, dt, camera.position, player.canopy, dropView.outside);
  parachutes.sweep();
  countryside?.update(dt, camera);
  portals.update(dt, camera, renderer.domElement.height);
  // The traffic stops for people and for cars someone drives, never for a parked car (Yoshi: a Tesla on the drive held it up).
  roadLife.update(dt, camera.position, [...avatars.obstacles(), { x: player.x, z: player.z, r: 0.35 }, ...villagers.obstacles()], cars.filter((c) => (driving && c === car) || !!c.driver));
  looseProps.low = phone || quality === 'low';
  looseProps.update(dt, camera);
  mapTimer += dt;
  if (mapTimer > 0.05) {
    mapTimer = 0;
    const blips: Blip[] = [
      ...(weapon.enabled ? pickups.blips() : []).map((b) => ({ ...b, color: '', kind: 'item' as const })),
      ...(weapon.enabled ? rewards.blips() : []).map((b) => ({ ...b, kind: 'coin' as const })), // the Zombies game's rewards
      ...cats.blips().map((b) => ({ ...b, color: '#e0a050', kind: 'cat' as const })),
      ...clowns.blips().map((b) => ({ ...b, color: b.kind === 'strongman' ? '#d0782e' : '#12a3a0', kind: 'cat' as const })),
      ...horses.blips().map((b) => ({ ...b, color: '#8a5a3a', kind: 'cat' as const })),
      ...(games.hideOthers ? [] : avatars.blips().map((b) => ({ ...b, kind: 'player' as const }))),
      ...games.coinSpots().map((c) => ({ ...c, color: '#f2c14e', kind: 'coin' as const })), // the hunt's coins left
      ...zombies.blips().map((z) => ({ ...z, color: z.big ? '#4f7a3a' : '#8fb070', kind: 'zombie' as const })), // the Zombies game's, small dots
    ];
    const shapes = [...furnishing.pieces.values()].filter((p) => !p.item.startsWith('rug')).map((p) => ({ ring: footprint(p), y: p.y }));
    for (const c of cars) if (c.ready) shapes.push({ ring: c.footprint(), y: c.y });
    // The floor by the height above the ground there (the village stands 5 m higher than the plot).
    // A waypoint from the big map is done when you reach it.
    if (bigMap.waypoint && Math.hypot(bigMap.waypoint.x - player.x, bigMap.waypoint.z - player.z) < 6) bigMap.waypoint = bigMap.route = null;
    if (bigMap.waypoint && (routeTimer += 0.05) > 0.5) updateRoute();
    minimap.draw(player.x, player.z, player.feet - (endHouse?.floorAt(player.x, player.z) ?? terrain.height(player.x, player.z)), player.yaw, weapon.enabled ? blips : blips.filter((b) => b.kind !== 'item'), shapes, rules.portals ? portalMarks : [], bigMap.waypoint, bigMap.route, inside);
  }
  horizon.position.x = camera.position.x;
  horizon.position.z = camera.position.z;
  tiles.update(dt, camera.position);
  undergrowth.update(camera.position);
  groundDetail(camera.position);
  homeStreet.update(dt, camera.position);
  groundShade.follow(camera.position);
  placeShadow();
  if (!menu.open) adaptQuality(dt, now); // before drawing (see there)
  if (bigMap.open) {
    const marks: Mark[] = [
      ...cars.filter((c) => c.ready).map((c) => ({ x: c.x, z: c.z, yaw: c.yaw, color: c.spec.paint, kind: 'car' as const })),
      ...horses.blips().map((h) => ({ ...h, color: '#8a5a3a', kind: 'horse' as const })),
      ...(games.hideOthers ? [] : avatars.marks().map((a) => ({ ...a, kind: 'player' as const }))),
      ...games.coinSpots().map((c) => ({ x: c.x, z: c.z, color: '#f2c14e', kind: 'coin' as const })),
    ];
    bigMap.tick(mapYou(), marks);
  } else if (!menu.onStartScreen) composer.render(dt); // the menu's Map tab covers most of the screen: the world isn't drawn behind it
  // Nor behind the start screen: its slideshow covers the canvas, and drawing there compiled the shaders one by one
  // on the page's thread while the world loaded (5.8 s of it). They compile in the background instead (compileWorld).
  hud.tick(dt, renderer.info.render.calls, preset.scale * dynScale, t(`gfx.${quality}`), net.connected ? net.rtt : null);
});

// The scene in place behind the start screen while the rest loads.
player.update(0, input.poll(), camera);

/**
 * The band to the village and the village of Smetlede (web/src/data/village.json, 1.3 MB, about
 * a fifth of that sent compressed): fetched once play has begun, so starting is no slower, and
 * built a tile at a time between frames. Then its blocks for walking and driving, its ponds (the
 * ground pieces they cut are made again), its trees for the cars, and its own ground shading once
 * the sun is known.
 */
let village: 'waiting' | 'loading' | 'ready' = 'waiting';
let villageJob: Promise<void> | null = null;
/** The end house of the new terrace at Molenhoek, to walk into (world/walkIn.ts), once its street model is in. */
let endHouse: WalkIn | null = null;
/** Resolved once play has begun (loaded). */
let playBegun = () => {};
const playing = new Promise<void>((r) => (playBegun = r));
// Zombies picked on the start screen (src/ui/startFlow.ts): alone, the game at its place at once, on the ground (as
// the Play tab's button starts it; never from the air, should a drop have begun); a room just opened, how to start
// it once the friends are in.
void playing.then(() => {
  if (startIntent.zombies === 'open') chat.system(() => t('zs.roomHint'));
  if (startIntent.zombies !== 'solo') return;
  const place = startIntent.place ?? 'house';
  const landed = setInterval(() => {
    if (player.chute !== null) return;
    clearInterval(landed);
    if (!me) startSolo(place).catch(() => {}); // a village that won't load says so itself (loadVillage)
  }, 250);
});
/** When play began (ms, the page's clock); 0 before. Work that can wait is kept out of its first seconds. */
let playBegan = 0;
void playing.then(() => {
  playBegan = performance.now();
  // Your guns from the start, and the picker to change them (Action and Paintball, alone or together).
  if (!net.connected && !games.zombies) weapon.setOwned(startGuns());
  offerGuns();
});
// The leaf cards' pictures are painted once play has begun, when the preset asks for them (world/leafCards.ts).
void playing.then(() => treesMayPaint((textures) => {
  for (const t of textures) renderer.initTexture(t);
  return precompile(scene);
}));
/**
 * The baked light of the streets away from where you start (Molenhoek's and Kapellenhoek's pages, about 4 MB): fetched
 * once play has begun, not before. They keep real-time light until it is in; a trip into the village waits for it.
 */
let streetBakes: Promise<unknown> = Promise.resolve();
/** Wood smoke from two chimneys by the church square (world/smoke.ts), once the town's model is in. */
let villageSmoke: Smoke | null = null;
/** The village, once: later calls wait for the same load (a trip through a portal to it). */
function loadVillage(): Promise<void> {
  // A load that failed (a deploy took the old files away, the network dropped) isn't kept: the next trip tries
  // again, and the player is told instead of the trip failing in silence.
  return (villageJob ??= buildVillage().catch((e: unknown) => {
    villageJob = null;
    village = 'waiting';
    chat.system(() => t('err.villageLoad'));
    throw e;
  }));
}
/**
 * Compiles `root`'s shaders in the background (where the browser can), for the composer's target as the game draws
 * them (no tone mapping there, another colour space: other shaders). Kept out of the scene meanwhile, what comes in
 * later (the village, the countryside, the gardens' life) is drawn without the game stopping for the compiling.
 */
function precompile(root: THREE.Object3D): Promise<unknown> {
  const was = renderer.getRenderTarget();
  renderer.setRenderTarget(composer.readBuffer);
  const back = unpaintedOut(root); // not the leaf cards before their pictures are painted
  const done = renderer.compileAsync(root, camera, scene);
  back();
  renderer.setRenderTarget(was);
  return done.catch(() => undefined);
}
async function buildVillage(): Promise<void> {
  village = 'loading';
  // A frame between the big steps: built all at once, it stopped the game for a second just after it began.
  const between = () => new Promise((r) => setTimeout(r, 0));
  const data = (await import('./data/village.json')).default as unknown as VillageData;
  if (!noFootball) fcGround.addToVillage(data); // the football ground's car park, lane and trees
  wearLonePatches(data); // light patches away from the buildings: worn ground (world/yards.ts)
  undergrowth.addWoods(data.prisms, data.trees);
  const first = poles.length;
  poles.push(...(data.poles ?? []));
  const landmarks = (data.landmarks ?? []).map((l) => {
    const box = new THREE.Box2().setFromPoints(l.p.map(([x, z]) => new THREE.Vector2(x, z)));
    return box.getCenter(new THREE.Vector2());
  });
  for (const c of landmarks) detailAt.push([c.x, c.y]);
  // Molenhoek past the old edge of the map comes in three parts along the street (molenhoek_end1..3), each drawn within 350 m as the band's tiles.
  const streetJobs = ['molenhoek', 'kapellenhoek', 'molenhoek_end1', 'molenhoek_end2', 'molenhoek_end3'].map((name) => loadStreetModel(renderer, house.ground, name).catch(() => null)); // world/streetModel.ts
  // The church and the school (with the square's fittings): our Blender models in place of the blocks
  // built from the open data, which stay for walking into. A model that didn't load leaves its blocks drawn.
  // The houses round the square (world/townCentre.ts) replace the blocks inside the outlines they name.
  // (?notown in the dev build leaves them out, to compare.)
  const town = import.meta.env.DEV && location.search.includes('notown')
    ? Promise.reject(new Error('left out'))
    : import('./world/townCentre').then(({ loadTown }) => loadTown(renderer, (x, z) => house.ground + terrain.height(x, z)));
  const models = (await Promise.all([loadChurch().catch(() => null), loadModel('/models/school.glb').catch(() => null), loadModel('/models/dormer_house.glb').catch(() => null), loadModel('/models/sparrenhof.glb').catch(() => null), loadModel('/models/tree_huts.glb').catch(() => null), loadModel('/models/kouter_house.glb').catch(() => null), (noFootball ? Promise.resolve(null) : loadModel('/models/football.glb').catch(() => null)), town.catch(() => null)])).filter(
    (m): m is THREE.Object3D => m !== null,
  );
  const fcModel = models.find((m) => m.userData.landmark === 'football');
  if (fcModel) fcGround.dress(fcModel);
  // The houses of Molenhoek (and its street) and of Kapellenhoek, the same way: fitted into the village data before its tiles are built.
  for (const job of streetJobs) {
    const street = await job;
    if (street) {
      fitStreetModel(data, street, first);
      models.push(street);
      if (street.userData.landmark === 'molenhoek_end3') endHouse = await loadWalkIn(renderer, street).catch(() => null);
    }
    await between();
  }
  // Their ground over the village's covers and streets, and each one's own surfaces one over another cut (world/modelGround.ts).
  // The cuts are worked out in a worker while the page goes on building (world/groundCutter.ts).
  const cutter = new GroundCutter();
  const modelsCut = await claimModelGroundSoon(models, house.ground, between, cutter);
  for (const m of models) snowOnModel(m); // their unbaked outdoor parts take the snow (world/snowCover.ts)
  for (const m of models) wetOnModel(m); // and their streets and yards the rain (world/wetGround.ts)
  for (const m of models) glassOnModel(m); // their windows mirror the street over a room (world/glassLook.ts)
  // The village's ground shading's shaders compile ahead of its bakes (world/groundShade.ts warm): the models' while
  // its tiles are built, then the tiles' and the ponds' once they are in.
  const loose = models.filter((m) => !m.parent);
  if (loose.length) {
    const warming = new THREE.Group().add(...loose);
    scene.add(warming);
    groundShade.warm(renderer, scene, sun, [warming], house.ground);
    scene.remove(warming);
    warming.remove(...loose);
  }
  // The models' baked light and wear (world/bakedLight.ts), fetched while the village's tiles are built.
  const start = startPlace()?.id ?? '';
  const later = (m: THREE.Object3D) => {
    const name = String(m.userData.landmark);
    return name === 'kapellenhoek' || (name.startsWith('molenhoek') && !start.startsWith('molenhoek'));
  };
  const bakes = Promise.all(models.filter((m) => !later(m)).map((m) => bakeLight(m, renderer)));
  // Their shaders, with the baked light on, compile while the tiles are built (the compile of what the village adds,
  // below, then finds them ready: it waited a quarter of a second for them).
  const modelsCompiled = bakes.then(() => Promise.all(models.map((m) => precompile(m))));
  streetBakes = playing.then(() => Promise.all(models.filter(later).map((m) => bakeLight(m, renderer, Infinity, precompile))));
  for (const m of models) clearOpenGround(data, m.userData.clear as [number, number][][] | undefined); // their forecourts free of trees
  const drawn = withRoadDetail(withoutLandmarks(data, models.map((m) => m.userData.landmark as string), models.flatMap((m) => (m.userData.replaces as Ring[] | undefined) ?? [])));
  // One surface per spot (world/groundLayers.ts): the covers claimed, then the streets in detail built (cut under the
  // models' ground), then the covers' tiles (cut under both).
  claimCovers(drawn.prisms ?? [], house.ground);
  // The streets are claimed first: then every claim is in, and the tiles' covers are cut (in the worker) while the streets
  // and the tiles are built here, the streets between the tiles.
  const villageTiles = [...splitTiles(drawn, first)];
  let tileCuts: Promise<void>[] | null = null;
  const askTiles = () => (tileCuts ??= villageTiles.map(([, t]) => cutter.coversOf(t.prisms ?? [])));
  let claimed!: () => void;
  const roadsJob = buildRoadDetailSoon(true, renderer, house.ground, between, cutter, () => (askTiles(), claimed()));
  await Promise.race([new Promise<void>((r) => (claimed = r)), roadsJob]);
  await between();
  // The centre's clinkers (the church square and the main street) have a texture of their own, fetched with the village: shaded as the other ground covers.
  groundShade.apply(blockMaterial('pave_grey', renderer).material as THREE.MeshStandardMaterial);
  const made: { key: string; pieces: ReturnType<typeof buildTile> }[] = [];
  const cuts = askTiles();
  for (let i = 0; i < villageTiles.length; i++) {
    const [key, t] = villageTiles[i];
    await cuts[i];
    made.push({ key, pieces: buildTile(t, poles, renderer, house.ground, detail) });
    await new Promise((r) => setTimeout(r, 0)); // one tile at a time, between frames
  }
  const roads = await roadsJob;
  // A set of its own, apart from the ring's (no shadow pass: the sun's shadow is round the house); Molenhoek's far
  // stretch (tile columns from x 904 on) too, as each set draws one run of tiles along the line from the house to the church.
  // Seen from the portal the stretch is a long row of houses down the road: its tiles are drawn within 350 m (the haze
  // hides a third at that distance) and their small details (frames, glass, posts, lamps) within 100 m, which keeps
  // its cost within the 1 ms allowed. The road detail (world/roadDetail.ts) the same way.
  const far = (m: { key: string }) => Number(m.key.split(',')[0]) >= 5;
  // The way to the Sparrenhof and the wood round it (tiles from x 304 and z 297 on, north of the ring) the same way: a set
  // of its own, as it lies across the line from the house to the church, and mostly trees, drawn within 350 m.
  const northwest = (m: { key: string }) => {
    const [i, j] = m.key.split(',').map(Number);
    return i >= 2 && j >= 2;
  };
  // What the village adds to the scene from here on is drawn once its shaders are compiled (below).
  const before = new Set([...scene.children, ...tiles.group.children]);
  for (const set of [made, roads.tiles]) {
    tiles.addSet(set.filter((m) => !far(m) && !northwest(m)), false);
    if (set.some(far)) tiles.addSet(set.filter(far), false, 100, 350);
    if (set.some(northwest)) tiles.addSet(set.filter(northwest), false, 100, 350);
  }
  world.addPrisms(roads.blocks);
  await modelsCut;
  cutter.close();
  await bakes;
  for (const m of models) {
    tiles.group.add(m); // a caster for the village's ground shading, a target for shots
    tiles.track(m, undefined, String(m.userData.landmark).startsWith('molenhoek_end') || m.userData.landmark === 'kouter_house' ? 350 : Infinity);
  }
  // The end house's own walls, floors and doors take the place of its plain block once its inside has come (until then
  // the plain block stands, and its doors, windows and lawn are the shell's).
  const villageBlocks = cafePrisms(churchPrisms(data.prisms ?? [], churchAccess), cafeAccess).filter((p) => !endHouse?.replaces(p) || endHouse.standIn(p));
  const firstBlock = world.addPrisms(villageBlocks);
  if (endHouse) {
    endHouse.holdStandIns(villageBlocks.flatMap((p, i) => (endHouse!.standIn(p) ? [firstBlock + i] : [])));
    endHouse.install(world, doors, glass);
    scene.add(endHouse.group, endHouse.lawn(grassMat)); // its garden's lawn lies at its floor's level
    insides.endReady(); // its inside, if it came before the village

    data.groundCuts.cells.push(...endHouse.groundCuts.cells); // the ground cut out under it, with the ponds' below
    data.groundCuts.tris.push(...endHouse.groundCuts.tris);
  }
  // The smoke: the long house on the square's west side (the chimney by its gable on the square) and a house on
  // the lane to the north-east, both in sight on arriving at the church; their tops measured on the town's model.
  // Thicker than at home: against the pale sky over the square the thin puffs were hard to see.
  if (models.some((m) => m.userData.landmark === 'town')) {
    villageSmoke = new Smoke([new THREE.Vector3(511.39, 13.95, -764.01), new THREE.Vector3(551.64, 16.79, -723.79)], 0.75);
    scene.add(villageSmoke.mesh);
  }
  // Their shaders compile first, out of the scene (in the background where the browser can): drawn at once, they
  // stopped the game for half a second while they compiled. Then they go back where they belong.
  const fresh = [...scene.children, ...tiles.group.children].filter((o) => !before.has(o));
  const homes = fresh.map((o) => o.parent!);
  const aside = new THREE.Group();
  aside.add(...fresh);
  await Promise.all([modelsCompiled, precompile(aside)]);
  fresh.forEach((o, i) => homes[i].add(o));
  // Each model's blocks for walking into (the town's; the streets' went into the village data above).
  for (const m of models) world.addPrisms((m.userData.blocks as Prism[] | undefined) ?? []);
  world.addDips(data.dips);
  addDips(data.dips);
  groundCuts.cells.push(...data.groundCuts.cells);
  groundCuts.tris.push(...data.groundCuts.tris);
  for (const key of new Set(data.groundCuts.cells.map((c) => pieceOf(c).join(',')))) {
    const [pi, pj] = key.split(',').map(Number);
    layGround(pi, pj);
  }
  for (const t of data.trees) trunks.push({ x: t.x, z: t.z, r: 0.35 });
  pruneTrunks();
  portals.settle(); // the village's paving under its portals
  pickups.settle(); // the weapons up on the village's roofs (the church's roof walk, the Sparrenhof)
  await between();
  tiles.showAll(); // as for the bakes: every tile, the models in it and the ponds' water
  for (const m of models) m.visible = true;
  groundShade.warm(renderer, scene, sun, [tiles.group], house.ground);
  void playing.then(() => setTimeout(() => bigMap.addVillage(data), 1500)); // once play has begun and its first second is over, in slices between frames (ui/bigmap.ts)
  await environmentReady;
  await between();
  const c = landmarks[0] ?? new THREE.Vector2(521.5, -744.2); // the church
  const centre = new THREE.Vector3(c.x, house.ground + terrain.height(c.x, c.y), c.y);
  tiles.showAll(); // every tile throws its shadow, however far the camera is now
  for (const m of models) m.visible = true;
  groundShade.addGrass(data.grass);
  groundShade.bakeVillage(renderer, scene, sun, [tiles.group], house.ground, centre, 345, phone ? 1024 : 2048);
  await between();
  tiles.showAll(); // the frame between may have hidden the far tiles again
  for (const m of models) m.visible = true;
  // Molenhoek's far stretch (the area east of the village, x 880 on) has a shaded area of its own.
  const farPts = (data.area ?? []).filter(([x]) => x > 880);
  if (farPts.length > 2) {
    const [x0, x1] = [Math.min(...farPts.map((p) => p[0])), Math.max(...farPts.map((p) => p[0]))];
    const [z0, z1] = [Math.min(...farPts.map((p) => p[1])), Math.max(...farPts.map((p) => p[1]))];
    const fx = (x0 + x1) / 2;
    const fz = (z0 + z1) / 2;
    const at = new THREE.Vector3(fx, house.ground + terrain.height(fx, fz), fz);
    groundShade.bakeVillage(renderer, scene, sun, [tiles.group], house.ground, at, Math.max(x1 - x0, z1 - z0) / 2 + 10, phone ? 1024 : 2048, 'molenhoek');
  }
  // So has the Sparrenhof with its forecourt and the wood round it (its portal in shared/portals.mjs), 180 m round.
  const cafe = PORTALS.find((p) => p.id === 'sparrenhof');
  if (cafe) {
    await between();
    tiles.showAll();
    for (const m of models) m.visible = true;
    const at = new THREE.Vector3(cafe.x, house.ground + terrain.height(cafe.x, cafe.z), cafe.z);
    groundShade.bakeVillage(renderer, scene, sun, [tiles.group], house.ground, at, 180, phone ? 1024 : 2048, 'sparrenhof');
  }
  await between();
  tiles.showAll();
  for (const m of models) m.visible = true;
  // And the whole map, coarse, for the ground beyond those areas.
  groundShade.bakeAll(renderer, scene, sun, [built.group, hedgeLumps, tiles.group], house.ground, phone ? 1024 : 2048);
  village = 'ready';
  void homeBakeReady.then(releaseGroundClaims); // every surface is cut: the ground's claims go, but round the homes
  void prepareShotRaycasts(scene); // the shot index in idle slices, once play has begun (until then three's raycast)
  christmas.villageReady();
  for (const c of cars) c.ready = true; // the cars parked in the village (shared/car.json) with it
  bikes.villageReady(); // and the bikes in its racks (shared/bike.json)
  void roadLife.load(renderer, scene, camera, precompile);
  townBoard.load(renderer, precompile).catch(() => undefined);
}

/** The countryside's life (world/countryside.ts): herds, birds, bales, field rows, wind and sounds; a chunk of its own. */
let countryJob: Promise<void> | null = null;
function startCountryside(): Promise<void> {
  return (countryJob ??= import('./world/countryside').then(async ({ Countryside }) => {
    const indoors = () => indoorName(player.ground.name, roomNames);
    countryside = new Countryside({ scene, renderer, world, now: () => performance.now() / 1000 + clockOffset, quality: () => quality, phone, far: () => tiles.drawDistance, indoors });
    // Its herds, birds, ducks and bales: out of the scene until their shaders are in.
    scene.remove(countryside.group);
    await precompile(countryside.group);
    scene.add(countryside.group);
  }));
}

/**
 * The Sint-Pharaïldiskerk, our own Blender model (tools/church.py, about 9,000 triangles), on its
 * spot on the church square. Its brick, stone and trim take the game's textures (the model names
 * them and their tint), so they add no graphics memory; slate, glass and fittings bring their own.
 */
async function loadChurch(): Promise<THREE.Object3D> {
  const root = (await new GLTFLoader().loadAsync('/models/church.glb')).scene;
  gameTextures(root);
  // The slates are dark blue-grey in every photo; in the game's bright sun the model's own texture came out pale.
  const slates = new Set<THREE.MeshStandardMaterial>();
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (m?.name === 'church_slate') slates.add(m);
  });
  for (const m of slates) {
    m.color.multiplyScalar(0.5);
    m.roughness = 0.92; // weathered slate: less of the bright sky in it
  }
  root.userData.landmark = 'church';
  // Its origin on the church's axis at ground level (Lambert 72 119018.72, 184084.24), turned so
  // its length runs 6.4 degrees north of grid east; walls and plinth reach 1.2 m down for the slope.
  const [x, z] = CHURCH_DATA.origin;
  root.position.set(x, house.ground + terrain.height(x, z), z);
  root.rotation.y = CHURCH_DATA.yaw;
  return root;
}

/**
 * A model of ours built in the game's own axes round a spot on the ground (tools/school.py: the primary
 * school and the church square's fittings, about 10,000 triangles). Its root node names that spot and the
 * landmark whose open-data blocks it replaces.
 */
async function loadModel(url: string): Promise<THREE.Object3D> {
  const scene = (await new GLTFLoader().loadAsync(url)).scene;
  gameTextures(scene);
  const root = scene.children.find((o) => o.userData.origin) ?? scene;
  const [x, z] = (root.userData.origin as [number, number] | undefined) ?? [0, 0];
  scene.position.set(x, house.ground + terrain.height(x, z), z);
  scene.userData.landmark = root.userData.landmark;
  scene.userData.replaces = root.userData.replaces;
  scene.userData.clear = root.userData.clear; // open ground the village's trees give way on (clearOpenGround)
  // Blocks measured from the origin's ground (`blocksOnGround`: tools/sparrenhof.py) go up with it.
  const lift = root.userData.blocksOnGround ? scene.position.y : 0;
  scene.userData.blocks = ((root.userData.blocks as Prism[] | undefined) ?? []).map((p) => ({ ...p, y0: p.y0 + lift, y1: p.y1 + lift }));
  return scene;
}

/** Materials whose glTF extras name a game texture and its tint take the shared texture (no graphics memory of their own). */
function gameTextures(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const u = (mesh.material as THREE.Material).userData as { texture?: string; tint?: string; normalScale?: number };
    if (u.texture) {
      const m = tintedMaterial(u.texture, u.tint ?? '#ffffff', renderer);
      if (u.normalScale !== undefined) m.normalScale.setScalar(u.normalScale);
      mesh.material = m;
    }
    mesh.receiveShadow = true;
  });
}

/**
 * The village without the blocks, roofs and windows of the landmarks named (a model stands there instead),
 * nor those of the houses inside the outlines `houses` (the town's model): a wall, plinth or chimney block
 * whose every corner lies in or within 0.4 m of such an outline, as does its middle; a roof whose middle does;
 * a window inside an outline, or on a hidden block or roof with no drawn one under it.
 */
function withoutLandmarks(data: VillageData, names: string[], houses: Ring[] = []): VillageData {
  const outlines = [...(data.landmarks ?? []).filter((l) => names.includes(l.name)).map((l) => l.p), ...houses];
  // The outlines' boxes: a point outside one (with the margin) is neither in nor near that outline.
  const boxes = new Map(outlines.map((ring) => [ring, new THREE.Box2().setFromPoints(ring.map(([x, z]) => new THREE.Vector2(x, z)))]));
  const within = (rings: Ring[], x: number, z: number, margin: number) =>
    rings.some((ring) => {
      const b = boxes.get(ring);
      if (b && (x < b.min.x - margin || x > b.max.x + margin || z < b.min.y - margin || z > b.max.y + margin)) return false;
      let hit = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, zi] = ring[i];
        const [xj, zj] = ring[j];
        if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
        const dx = xj - xi;
        const dz = zj - zi;
        const t = Math.max(0, Math.min(1, ((x - xi) * dx + (z - zi) * dz) / (dx * dx + dz * dz || 1)));
        if (margin > 0 && Math.hypot(xi + dx * t - x, zi + dz * t - z) < margin) return true;
      }
      return hit;
    });
  const inside = (x: number, z: number) => within(outlines, x, z, 0);
  const middle = (ring: Ring | [number, number][]): [number, number] => [ring.reduce((s, q) => s + q[0], 0) / ring.length, ring.reduce((s, q) => s + q[1], 0) / ring.length];
  // A point inside a block's own outline (the middle of a diagonal that lies inside it): an L-shaped house's
  // average corner can lie outside it. Strictly inside the house, so a neighbour's chimney by a shared wall stays.
  // A ring a little larger than the outline (a roof cap with its eaves) has its first such point just outside the
  // outline, so every such point is tried.
  const inners = (ring: Ring): [number, number][] => {
    const found: [number, number][] = [];
    for (let i = 0; i < ring.length; i++) {
      for (const k of [2, 3]) {
        const a = ring[i];
        const b = ring[(i + k) % ring.length];
        const m: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (within([ring], m[0], m[1], 0)) found.push(m);
      }
    }
    return found.length ? found : [middle(ring)];
  };
  const housePart = (ring: Ring) => houses.length > 0 && ring.every(([x, z]) => within(houses, x, z, 0.4)) && inners(ring).some(([x, z]) => within(houses, x, z, 0));
  const prisms = (data.prisms ?? []).filter((p) => (!p.lm || !names.includes(p.lm)) && (p.d !== undefined || !housePart(p.p[0])));
  const roofs = data.roofs.filter((r) => (!r.lm || !names.includes(r.lm)) && !(houses.length > 0 && within(houses, ...middle(r.p), 0)));
  // A window stands on a wall or a gable. The village's blocks can be a little larger than the model's outline,
  // so a window on a hidden block or roof can lie just outside the outline; with no drawn wall or gable under
  // it, it would float in the air.
  type Carrier = { ring: Ring; y0: number; y1: number; box: [number, number, number, number] };
  const carrier = (ring: Ring, y0: number, y1: number): Carrier => {
    const xs = ring.map((q) => q[0]);
    const zs = ring.map((q) => q[1]);
    return { ring, y0, y1, box: [Math.min(...xs) - 0.3, Math.max(...xs) + 0.3, Math.min(...zs) - 0.3, Math.max(...zs) + 0.3] };
  };
  const keptPrisms = new Set(prisms);
  const keptRoofs = new Set(roofs);
  const hidden: Carrier[] = [];
  const drawn: Carrier[] = [];
  for (const p of data.prisms ?? []) if (p.d === undefined) (keptPrisms.has(p) ? drawn : hidden).push(carrier(p.p[0], p.y0, p.y1));
  for (const r of data.roofs) (keptRoofs.has(r) ? drawn : hidden).push(carrier(r.p, r.base ?? r.y, r.ridge));
  // Found by 16 m squares (each carrier in every square its box touches): tried one by one, every window against every
  // block took a tenth of a second of the loading, half a second on a phone's processor. The same test.
  const bySquare = (list: Carrier[]) => {
    const cells = new Map<string, Carrier[]>();
    for (const c of list) {
      for (let i = Math.floor(c.box[0] / 16); i <= Math.floor(c.box[1] / 16); i++) {
        for (let j = Math.floor(c.box[2] / 16); j <= Math.floor(c.box[3] / 16); j++) {
          const k = `${i},${j}`;
          const cell = cells.get(k);
          if (cell) cell.push(c);
          else cells.set(k, [c]);
        }
      }
    }
    return cells;
  };
  const hiddenCells = bySquare(hidden);
  const drawnCells = bySquare(drawn);
  const on = (cells: Map<string, Carrier[]>, x: number, z: number, y: number) =>
    (cells.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`) ?? []).some((c) => x > c.box[0] && x < c.box[1] && z > c.box[2] && z < c.box[3] && y > c.y0 - 0.3 && y < c.y1 + 0.3 && within([c.ring], x, z, 0.3));
  return {
    ...data,
    prisms,
    roofs,
    openings: (data.openings ?? []).filter((o) => {
      const x = (o.a[0] + o.b[0]) / 2;
      const z = (o.a[1] + o.b[1]) / 2;
      const y = (o.y[0] + o.y[1]) / 2;
      return !inside(x - o.n[0] * 0.3, z - o.n[1] * 0.3) && !(on(hiddenCells, x, z, y) && !on(drawnCells, x, z, y));
    }),
  };
}

/**
 * Behind the start screen while the world loads: the house from 6 m up over the road in front of
 * the plot (clear of the houses across it), standing still (Yoshi: no moving start screen).
 */
function startCamera(): void {
  camera.position.set(15.3, house.ground + 6, 18.5);
  camera.lookAt(4.45, house.ground + 1.2, 0);
  if (innerWidth >= 1100) camera.rotateY(0.3); // the start panel is on the left: the house to the right of it
}

/**
 * Auto: test-render the real scene from two spots (the street and the garden) at
 * different presets as the last part of loading, and keep the best one that
 * holds 60 fps. Takes one to three seconds.
 */
async function autoDetect(): Promise<void> {
  menu.setGraphics('auto', null, gpu);
  await compileWorld();
  const keep = { x: player.x, z: player.z, feet: player.feet, yaw: player.yaw, pitch: player.pitch };
  const still = NO_INPUT;
  const views: [number, number, number, number, number][] = [
    [house.spawn.x, house.spawn.z, -0.02, house.spawn.yaw, 0.1],
    [4.5, -8, -0.1, Math.PI, 0.1], // the garden side, out of doors (the inside is not in the game until a code opens it)
  ];
  const gl = renderer.getContext();
  loading(0.85, () => t('load.gfx'));
  const result = await pickQuality(guessFromName(gpu), (q) => {
    applyQuality(q);
    loading(Math.min(0.97, loadShare + 0.05));
    let total = 0;
    for (const v of views) {
      player.place(...v);
      player.update(0, still, camera);
      total += timeFrames(() => {
        placeShadow(); // the sun's shadow drawn in each test frame, as in play
        composer.render(1 / 60);
      }, gl, 5);
    }
    return total / views.length;
  }, seat?.views ?? 1); // the split screen's views share the chip (src/seat.ts)
  player.place(keep.x, keep.z, keep.feet, keep.yaw, keep.pitch);
  player.update(0, still, camera);
  if (mode === 'auto') applyQuality(result.quality);
  menu.setGraphics(mode, quality, gpu, Math.round(result.ms));
  composer.render(0); // the front of the house, then play
  loaded();
}
/**
 * The world's shaders, compiled before it is shown, in the background where the browser can (KHR_parallel_shader_compile):
 * once the sky is in (it is part of every lit shader) while the textures still come, and again once they and the houses'
 * baked light are in, for what came or changed since. The graphics test, or one frame behind the start screen, then
 * draws the rest (the shadow's and the passes' own shaders), so play begins with nothing left to compile.
 */
const firstCompile = environmentReady.then(() => precompile(scene));
/**
 * A start in the village: the village loads from the click, alongside the sky, the textures and the shaders (it took
 * 2 s after them), and is in before the graphics test, so the test never meets it half built.
 */
const earlyVillage = startPlace()?.village ? loadVillage().catch(() => undefined) : null;
async function compileWorld(): Promise<void> {
  await Promise.all([environmentReady, texturesReady, homeBakeReady, firstCompile, earlyVillage]);
  // With a figure like yours under the parachute at the first drop (skinned: shaders of its own), kept out of the
  // scene and never disposed, so its shaders stay compiled for yours and the others'.
  const figure = new THREE.Group();
  figure.add(avatars.figure('', myColour()).root);
  // The parachute too, when the start is a drop: fetched and unpacked here, behind the start screen, instead
  // of in the first second of the fall (at most 1.5 s for it; a slow line starts without).
  const chute = rules.parachute !== false && startIntent.zombies === null ? Promise.race([parachutes.load(), new Promise((r) => setTimeout(r, 1500))]) : null;
  await Promise.all([precompile(scene), precompile(figure), chute]);
}
if (mode === 'auto') void autoDetect().catch(loaded);
else {
  void compileWorld()
    .then(() => {
      placeShadow();
      composer.render(0);
    })
    .then(loaded, loaded);
}

// Development only: lets automated checks move the player without a controller.
if (import.meta.env.DEV) {
  const idle = NO_INPUT;
  Object.assign(window, {
    briel: {
      padNav, // the controller's menu navigation (src/ui/padNav.ts), for checks without a controller
      player,
      beginDrop,
      parachutes,
      dropView,
      doors,
      weapon,
      glass,
      effects,
      grenades,
      throwGrenade,
      pickups,
      cats,
      car,
      cars,
      currentCar: () => car,
      teslas: { fits: teslaFits, placed: placedCars },
      getIn,
      getOut,
      horses,
      clowns,
      zombies,
      aimAssist,
      villagers,
      christmas,
      sinterklaas,
      sintMaarten,
      townBoard,
      /** November and December on this page only: briel.season.fake('2026-12-01') pretends that day, fake(null) is today again (world/season.ts). */
      season: { fake: (day: string | null) => fakeDay(day), now: () => seasonNow() },
      zombiesSolo: { start: startSolo, stop: stopSolo, state: () => solo },
      /** Zombies' rewards: those lying and the claymores down, and what you have. */
      rewards,
      kit: () => kit,
      mountHorse,
      getOffHorse,
      bikes,
      getOnBike,
      getOffBike,
      driving: () => driving,
      furnishing,
      feedback,
      /** Seconds played towards the feedback card, and what holds it back. */
      askState: () => ({ askClock, menuOpen: menu.open, trip: !!trip, typing: chat.typing, driving, riding, alive: combat.alive }),
      avatars,
      football,
      /** The drawing clock for the others (net/track.ts) and the connection, for the network checks. */
      net: () => ({ delay: netClock.delay, late: netClock.late, age: netClock.age, rate: netClock.rate, rtt: net.rtt, ...net.counts }),
      combat,
      world,
      edges,
      spawns,
      respawnAt,
      homeLocks,
      insides,
      homeCard,
      loadoutCard,
      fire,
      /** One frame of input, e.g. { jumpPressed: true } or { usePressed: true }. */
      press(partial: Partial<typeof NO_INPUT>, seconds = 1 / 60) {
        for (let i = 0; i < Math.max(1, Math.round(seconds * 60)); i++) player.update(1 / 60, { ...idle, ...partial }, camera);
        return { x: +player.x.toFixed(3), z: +player.z.toFixed(3), feet: +player.feet.toFixed(3), flying: player.flying };
      },
      three: { renderer, scene, sun, ao, composer, environmentReady, applyQuality, autoDetect, quality: () => quality, groundShade, weather, sunShadow, bloom, presets: PRESETS, holdQuality: (on: boolean) => (qualityHeld = on), glassProbe },
      /** The weather's cycle moved on by this many seconds, on this page only (world/weather.ts forward), and where it is. */
      weatherAhead: (seconds: number) => weather.forward(seconds),
      weatherState: () => weather.state(),
      /** Where the ears are for the echo, the echo's send and the walls' cutoff now (world/acoustics.ts). */
      acoustics: () => ({ room: roomSound.room, ...sound.echoState(), walls: sound.wallsCutoff(), ctx: sound.context()?.state ?? null }),
      bells: roadLife.bells,
      tiles,
      home,
      homeStreet,
      grass,
      horizon,
      village: () => village,
      loadVillage,
      endHouse: () => endHouse,
      countryside: () => countryside,
      portals,
      roadLife,
      props: looseProps,
      travel: (word: string, via: 'portal' | 'chat' = 'chat') => travel(findPortal(word) ?? destination(word)!, via),
      /** Every portal and street spot (src/places.ts), and a chat command as if typed: command('/location kerk'). */
      places: DESTINATIONS,
      command,
      i18n: { t, setLang, lang, serverText },
      chat,
      bigMap,
      games,
      teleport(x: number, z: number, feet: number, yaw = player.yaw, pitch = 0) {
        player.place(x, z, feet, yaw, pitch);
        player.update(0, idle, camera);
      },
      /** Run the movement code for a number of 60 fps frames with fixed stick input. */
      walk(seconds: number, moveX: number, moveY: number, sprint = false) {
        for (let i = 0; i < seconds * 60; i++) player.update(1 / 60, { ...idle, moveX, moveY, sprint }, camera);
        return { x: +player.x.toFixed(3), z: +player.z.toFixed(3), feet: +player.feet.toFixed(3), on: player.ground.name };
      },
      /** Render n frames back to back and report the average GPU+CPU time per frame. */
      bench(n = 120) {
        const gl = renderer.getContext();
        const px = new Uint8Array(4);
        const t0 = performance.now();
        for (let i = 0; i < n; i++) {
          placeShadow();
          composer.render(1 / 60);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // wait for the GPU to finish
        }
        const ms = (performance.now() - t0) / n;
        return { msPerFrame: +ms.toFixed(2), fpsPossible: Math.round(1000 / ms), pixels: [renderer.domElement.width, renderer.domElement.height] };
      },
    },
  });
}
