import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { NO_INPUT } from './controls/input';
import { FAR_PHONE, gpuName, guessFromName, loadMode, ORDER, pickQuality, PRESETS, saveMode, timeFrames, type Mode, type Preset, type Quality } from './graphics';
import { Player } from './player';
import { Hud } from './ui/hud';
import { fillScreen, input, me, menu, onAccount, setAccount } from './start';
import { TouchControls } from './controls/touch';
import { Games } from './ui/games';
import { CLOWN_DEFAULTS, Clowns, KINDS } from './world/clowns';
import { hurtBy } from '../shared/brutes.mjs';
import { Horses } from './world/horses';
import { AdminPanel } from './ui/admin';
import { Chat } from './ui/chat';
import { Combat } from './ui/combat';
import { Leaderboard } from './ui/leaderboard';
import { Minimap, type Blip } from './ui/minimap';
import spawns from '../shared/spawns.json';

/** The spawn points round the house (the bungalow's are for its team in the teams game). */
const HOUSE_SPAWNS = spawns.flatMap((s, i) => (s.team === 'house' ? [i] : []));
import { api, errorText, Net, type Me, type Rules, type ServerMsg } from './net/client';
import { Avatars } from './net/avatars';
import { netClock } from './net/track';
import { PROTO, readBrute, readCar, readHorse, readPlayer, type Tick } from '../shared/wire.mjs';
import { sound } from './sound';
import { footstep, surfaceOf } from './footsteps';
import { SettingsPanel, type Settings } from './settings';
import { SPECS, Weapon, type WeaponId } from './weapon';
import { paintball, setPaintball, weaponName as shownWeapon } from './paintball';
import { Decals } from './world/decals';
import { Effects, type Spot } from './world/effects';
import { GRENADE, Grenades } from './world/grenades';
import { Pickups } from './world/pickups';
import { Cats } from './world/cats';
import { Car } from './world/car';
import CARS from '../shared/car.json';
import { buildHedges, buildHorizon, buildTile, dipMesh, waterMesh } from './world/surroundings';
import { GroundShade } from './world/groundShade';
import { groundPiece, groundPieces, groundSkirt, pieceOf, terrain, type GroundCuts } from './world/terrain';
import { splitTiles, Tiles } from './world/tiles';
import { Baked } from './world/baked';
import { Furnishing, buildFixtures, footprint, type Piece } from './world/furnishing';
import DEFAULT_FURNITURE from '../shared/default_furniture.json';
import { Planner } from './ui/planner';
import { Doors } from './world/doors';
import { Glass } from './world/glass';
import { World } from './world/collision';
import { loadEnvironment } from './world/environment';
import { house, type DipSpec, type Prism, type Ring, type VillageData } from './world/houseData';
import { loadProps } from './world/props';
import { buildHouseMeshes, grassMaterial, groundFamilies, setAnisotropy, surfaceMaterial, tintedMaterial } from './world/houseMeshes';
import { addDiag, startDiag } from './ui/diag';
import { IndoorLight } from './world/indoorLight';
import { Portals } from './world/portals';
import { TravelPanel } from './ui/travel';
import { BigMap, type Mark } from './ui/bigmap';
import { key } from './shortcuts';
import { typing } from './keys';
import { route, streetAt } from './ui/route';
import { HomeLife } from './world/homeLife';
import { HomeStreet, withoutModelled } from './world/homeStreet';
import { buildRoadDetail, roadPaint, withRoadDetail } from './world/roadDetail';
import { RoadLife } from './world/roadLife';
import { fitStreetModel, loadStreetModel } from './world/streetModel';
import { CAR_REACH, CAR_SLOW, findPortal, PORTALS, portalNear, type Portal } from '../shared/portals.mjs';
import { noShoot } from '../shared/zones.mjs';
import { carName, doorName, lang, onLang, placeName, plural, portalName, serverText, setLang, t, whoName } from './i18n';

// The world. This module is fetched and run on the first start (src/start.ts, the page's entry,
// with the start screen): before that the page has loaded no texture, model, sky or sound.
const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
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
scene.add(sun, sun.target);
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
  const begin = () => {
    if (at) {
      arrive(at, null);
      // In multiplayer the server is told: now if its welcome came already (it usually does), or when it comes.
      if (welcomed) net.send({ t: 'spawn', to: at.id });
      else spawnPending = at;
    }
    loading(1);
    setTimeout(() => menu.ready(), 150); // the bar full for a moment, then play
  };
  if (at?.village) {
    loading(0.92, () => t('travel.village'));
    void loadVillage().then(begin, begin);
  } else begin();
  setTimeout(() => void loadVillage(), 500); // playing: now the village
  setTimeout(() => life.load(), 900); // and the gardens' things, birds and the mower
  setTimeout(() => void startCountryside(), 900); // and the countryside's life
}
setTimeout(loaded, 25000); // never keep the player waiting forever
/** The start place picked on the start screen (the church by default), or null for the main house, where the world itself starts. */
let spawnPending: Portal | null = null;
let welcomed = false; // the server's welcome has come (a start place can be sent straight away)
function startPlace(): Portal | null {
  let id = (document.getElementById('spawn') as HTMLSelectElement | null)?.value ?? 'church'; // the church square unless picked otherwise (Yoshi)
  try {
    id = localStorage.getItem('briel.spawn') ?? id;
  } catch {
    // storage blocked: the select's value
  }
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
const grassMat = grassMaterial(renderer);
// A little behind in depth: a field or yard a few millimetres above it would flicker with it far off.
grassMat.polygonOffset = true;
grassMat.polygonOffsetFactor = 2;
grassMat.polygonOffsetUnits = 2;
const groundCuts: GroundCuts = { cells: [...(house.groundCuts?.cells ?? [])], tris: [...(house.groundCuts?.tris ?? [])] };
const grass = new THREE.Group();
const groundMeshes = new Map<string, THREE.Mesh>();
/** (Re)make one piece of the ground, with the cuts known now. */
function layGround(pi: number, pj: number, geometry = groundPiece(house.ground, groundCuts, pi, pj)): void {
  const old = groundMeshes.get(`${pi},${pj}`);
  if (old) {
    grass.remove(old);
    old.geometry.dispose();
  }
  const mesh = new THREE.Mesh(geometry, grassMat);
  mesh.receiveShadow = true;
  mesh.userData.material = 'grass';
  mesh.renderOrder = 1; // after the fields, yards and floors on it: the hidden lawn under them isn't shaded first
  groundMeshes.set(`${pi},${pj}`, mesh);
  grass.add(mesh);
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
const built = buildHouseMeshes(house.prisms, renderer);
home.add(built.group);
// Baked lighting (a test setting): the house with light baked in Blender, no real-time lighting.
const baked = new Baked(built.group);
home.add(baked.group);
let bakedWanted = false; // the "Baked lighting (test)" setting, known before the settings panel exists
const hedgeLumps = buildHedges(house.prisms);
home.add(hedgeLumps);
// The surroundings (Flemish open data: the neighbours' houses and roofs, roads, fields, hedges,
// trees) in tiles of 200 m (world/tiles.ts), each hidden beyond the draw distance: the ring's now,
// the village's once play has begun (loadVillage). The horizon moves with the eye.
const tiles = new Tiles();
const poles = [...(house.surroundings?.poles ?? [])];
const detailAt: [number, number][] = [[4.45, -3]]; // trees get their full crowns within 160 m of these (and the village's landmarks)
const detail = (x: number, z: number) => detailAt.some(([cx, cz]) => Math.hypot(x - cx, z - cz) < 160);
// The houses round the two portals at home are our own models (world/homeStreet.ts): their open-data blocks aren't drawn.
const ringData = withoutModelled(house.surroundings ?? { roofs: [], trees: [] });
const ringTiles = (s: typeof ringData.kept) => [...splitTiles(withRoadDetail(s))].map(([key, t]) => ({ key, pieces: buildTile(t, poles, renderer, house.ground, detail) }));
tiles.addSet(ringTiles(ringData.kept), true);
// The streets in detail (world/roadDetail.ts) in place of the plain road surface: the ring's now, the village's with it.
const ringRoads = buildRoadDetail(false, renderer, house.ground);
tiles.addSet(ringRoads.tiles, true);
const homeStreet = new HomeStreet(tiles, renderer, house.ground, ringData.removed, (s) => tiles.addSet(ringTiles(s), true));
const horizon = buildHorizon(center, house.ground);
scene.add(tiles.group, horizon);
// Shadows and soft corners on the ground of the whole neighbourhood, worked out once the sun's
// direction is known (the real-time sun shadow only covers the house).
const groundShade = new GroundShade(center);
groundShade.apply(grassMat, 0.35);
for (const m of [...groundFamilies(renderer), roadPaint]) groundShade.apply(m);
void Promise.all([environmentReady, homeStreet.ready]).then(() => {
  tiles.showAll(); // the ring's tiles beyond the draw distance throw shadows too
  groundShade.bake(renderer, scene, sun, [built.group, hedgeLumps, doors.group, tiles.group], house.ground);
});

// Post-processing: ambient occlusion darkens corners and contact areas the
// way real light does (computed at half resolution, which is hard to tell
// apart and far cheaper); SMAA smooths jagged edges; the output pass applies
// tone mapping.
const target = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, { type: THREE.HalfFloatType });
const composer = new EffectComposer(renderer, target);
composer.addPass(new RenderPass(scene, camera));
const ao = new GTAOPass(scene, camera, window.innerWidth, window.innerHeight);
ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.5, scale: 1.2, samples: 12 });
ao.blendIntensity = 0.9;
// The ambient occlusion draws every mesh with one plain material: an alpha-tested wire fence, glass or
// a see-through effect would come out as a solid panel and darken what's round it (a black box by the
// house on High). Those stay out of its pass, as its own points and lines do.
{
  const pass = ao as unknown as { _overrideVisibility: () => void; _visibilityCache: THREE.Object3D[] };
  const own = pass._overrideVisibility.bind(ao);
  const seeThrough = (m: THREE.Material) => m.alphaTest > 0 || m.transparent || !m.depthWrite || !m.colorWrite || !m.visible || !!(m as THREE.MeshStandardMaterial).alphaMap;
  pass._overrideVisibility = () => {
    own();
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !o.visible) return;
      if (([] as THREE.Material[]).concat(mesh.material).some(seeThrough)) {
        o.visible = false;
        pass._visibilityCache.push(o);
      }
    });
  };
}
composer.addPass(ao);
composer.addPass(new OutputPass());
const smaa = new SMAAPass();
composer.addPass(smaa);

// Graphics quality: a preset sets resolution, soft shadows, sun shadow detail,
// edge smoothing and texture sharpness. On top of that, the resolution can dip
// to 75% for a moment when frames take too long.
const gpu = gpuName(renderer);
let mode: Mode = loadMode();
let quality: Quality = mode === 'auto' ? guessFromName(gpu) : mode;
let preset: Preset = PRESETS[quality];
let dynScale = 1;

/** Resize everything to the window at the current render scale. */
function resize(): void {
  const scale = preset.scale * dynScale;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(scale);
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setPixelRatio(scale);
  composer.setSize(window.innerWidth, window.innerHeight);
  const aoDiv = preset.ao === 'full' ? 1 : 2;
  ao.setSize((window.innerWidth * scale) / aoDiv, (window.innerHeight * scale) / aoDiv);
}

function applyQuality(q: Quality): void {
  quality = q;
  preset = PRESETS[q];
  ao.enabled = preset.ao !== 'off';
  smaa.enabled = preset.smaa;
  sun.castShadow = preset.shadowMap > 0;
  if (preset.shadowMap && sun.shadow.mapSize.x !== preset.shadowMap) {
    sun.shadow.mapSize.set(preset.shadowMap, preset.shadowMap);
    sun.shadow.map?.dispose();
    sun.shadow.map = null; // rebuilt at the new size on the next frame
    // Also away from the house, where the shadow isn't updated: without a map every surface that takes the
    // shadow drew nothing (Auto dropping a preset in the village emptied the screen).
    renderer.shadowMap.needsUpdate = true;
  }
  setAnisotropy(preset.anisotropy);
  tiles.drawDistance = phone ? Math.min(FAR_PHONE, preset.far) : preset.far;
  baked.setEnabled(preset.baked || bakedWanted);
  dynScale = 1;
  resize();
}
applyQuality(quality);

let slowTime = 0;
let fastTime = 0;
/** During play: dip the resolution when frames run long; in Auto, drop a preset if that is not enough. */
function adaptQuality(dt: number): void {
  if (dt > 1 / 52) slowTime += dt;
  else slowTime = Math.max(0, slowTime - dt);
  if (dt < 1 / 58) fastTime += dt;
  else fastTime = 0;
  if (slowTime > 0.6) {
    slowTime = 0;
    // Weak graphics are limited by pixels, so Low may dip further.
    const lowest = quality === 'low' ? 0.6 : 0.75;
    if (dynScale > lowest) {
      dynScale = Math.max(lowest, dynScale - 0.1);
      resize();
    } else if (mode === 'auto' && quality !== 'low') {
      applyQuality(ORDER[ORDER.indexOf(quality) - 1]);
      menu.setGraphics(mode, quality, gpu);
    }
  } else if (fastTime > 4 && dynScale < 1) {
    fastTime = 0;
    dynScale = Math.min(1, dynScale + 0.1);
    resize();
  }
}

const world = new World(house.prisms, house.ground);
world.addPrisms(house.surroundings?.prisms ?? []);
world.addPrisms(homeStreet.blocks);
world.addPrisms(ringRoads.blocks); // the pavements, a few centimetres up
world.setDips(house.dips ?? []);
const player = new Player(world, house.spawn);
// Phones and tablets: touch controls (offered on any touch screen: src/start.ts).
const touch = new TouchControls();
document.getElementById('rotate-hint')!.before(touch.root);
input.touch = touch;
const hud = new Hud();
const doors = new Doors(house.doors, world, (name) => surfaceMaterial(name, renderer));
home.add(doors.group);
// Party games the admin starts (multiplayer): hide and seek, tag, treasure hunt.
const games = new Games();
scene.add(games.group);
loadProps(house.props ?? [], scene, world);
// Built-in furniture (the bungalow's book wall and jacuzzi): drawn like the planner's, not movable.
const fixtures = buildFixtures(house.fixtures ?? [], world);
if (fixtures) home.add(fixtures);
scene.add(camera); // the weapon hangs off the camera
const weapon = new Weapon(camera, scene);
const glass = new Glass(built.panes, world, scene);
glass.add(doors.panes, (i, broken) => doors.setBroken(i, broken));
const effects = new Effects(scene, new Decals(scene), (x, z, y) => world.groundAt(x, z, y, 0).y);
const grenades = new Grenades(world);
scene.add(grenades.group);
const pickups = new Pickups((x, z, y) => world.groundAt(x, z, y + 0.3, 0).y);
scene.add(pickups.group);
const cats = new Cats((x, z) => world.groundAt(x, z, 0.5, 0).y);
scene.add(cats.group);
// Clowns (our own model): a few from the start; the admin places more with the planner.
const clowns = new Clowns(
  (x, z, y) => world.groundAt(x, z, y + 0.5, 0).y,
  (x, z, y) => world.boxFree(x, z, 0, 0.3, 0.3, y + 0.35, y + 1.2),
);
clowns.setAll(CLOWN_DEFAULTS);
scene.add(clowns.group);
let localClown = 1000; // ids for clowns placed alone
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
const cars = Object.entries(CARS.cars).map(([id, spec]) => new Car(world, trunks, id, spec));
for (const c of cars) scene.add(c.group);
let car = cars[0];
const carById = (id: string) => cars.find((c) => c.id === id);
let driving = false;
let riding = false; // in the passenger seat (multiplayer): the car moves you, the camera follows it
let wantCar = false; // asked the server to get in, waiting for its answer
const minimap = new Minimap([...house.prisms, ...(house.surroundings?.prisms ?? [])], house.levels, house.rooms);
/** The ground out of doors at (x, z): the relief, and paving or a kerb on it. */
const groundY = (x: number, z: number) => world.groundAt(x, z, house.ground + terrain.height(x, z) + 0.6, 0).y;
const portals = new Portals(groundY);
scene.add(portals.group);
// Life round the house and the bungalow: things in the gardens, birds, a robot mower (world/homeLife.ts).
const life = new HomeLife(world, groundY, () => !phone && quality !== 'low');
scene.add(life.group);
const roadLife = new RoadLife(world, tiles, groundY); // the traffic, parked cars, street signs and the church bells
scene.add(roadLife.group);
const travelPanel = new TravelPanel();
const bigMap = new BigMap(document.getElementById('map-mount')!, house.prisms, house.surroundings, house.rooms, house.dips ?? []);
minimap.setGround((g, k) => bigMap.paintGroundGame(g, k), () => bigMap.groundVersion); // the ground under the minimap, everywhere
const mapBtn = document.getElementById('map-btn')!;

// Furniture planner: shared through the server when logged in, kept in this browser otherwise.
const furnishing = new Furnishing(world);
home.add(furnishing.group);
tiles.track(home, new THREE.Box3().setFromObject(built.group));
const planner = new Planner(scene, furnishing, [built.group, baked.group, grass]);
const LOCAL_FURNITURE = 'briel.furniture';
let localId = -1;
/** The starting layout, as pieces with local ids. */
const startLayout = (): Piece[] =>
  DEFAULT_FURNITURE.pieces.map(([item, x, y, z, yaw], i) => ({ id: -1 - i, item: String(item), x: Number(x), y: Number(y), z: Number(z), yaw: Number(yaw) }));
const LOCAL_RESTORE = 'briel.furnitureRestore';
function loadLocalFurniture(): void {
  try {
    // The starting layout put back once when the layout file asks (its "restore" number), over any changes.
    const restore = String((DEFAULT_FURNITURE as { restore?: number }).restore ?? 0);
    if (localStorage.getItem(LOCAL_RESTORE) !== restore) {
      localStorage.removeItem(LOCAL_FURNITURE);
      localStorage.setItem(LOCAL_RESTORE, restore);
    }
    const saved = localStorage.getItem(LOCAL_FURNITURE);
    const list = saved === null ? startLayout() : (JSON.parse(saved) as Piece[]);
    furnishing.setAll(list);
    localId = Math.min(-1, ...list.map((p) => p.id)) - 1;
  } catch {
    furnishing.setAll([]);
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
planner.onPlace = (p) => {
  if (net.connected) net.send({ t: 'furn', op: 'put', ...p });
  else {
    furnishing.put({ ...p, id: p.id ?? localId-- });
    saveLocalFurniture();
  }
};
planner.clownGroup = clowns.group;
planner.onClown = (at) => {
  if (net.connected) net.send({ t: 'clown', op: 'add', ...at });
  else clowns.setAll([...clowns.list, { id: localClown++, ...at }]);
};
planner.onClownRemove = (id) => {
  if (net.connected) net.send({ t: 'clown', op: 'remove', id });
  else clowns.setAll(clowns.list.filter((c) => c.id !== id));
};
planner.onRemove = (id) => {
  if (net.connected) net.send({ t: 'furn', op: 'del', id });
  else {
    furnishing.remove(id);
    saveLocalFurniture();
  }
};
const plannerBtn = document.getElementById('planner-btn')!;
function togglePlanner(): void {
  if (driving || riding) return;
  if (!planner.active && !mayFurnish()) return chat.system(() => t('chat.furnOff'));
  planner.toggle();
}
// The menu's button starts the planner and goes back to the game to use it.
plannerBtn.addEventListener('click', () => {
  togglePlanner();
  if (planner.active) menu.resume(menu.mode ?? 'kbm');
});
touch.onDone = togglePlanner; // the touch controls' Done button
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyP' && !e.repeat && !typing(e) && !menu.open) togglePlanner(); // while playing; the menu has its button
});
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
    clowns.setAll(CLOWN_DEFAULTS); // and the characters placed with the planner go
    saveLocalFurniture();
  }
});
let mapTimer = 0;
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyN' && !e.repeat && !typing(e)) settings.toggle('minimap'); // the setting's shortcut (Settings: Minimap)
});
weapon.onImpact = (point, normal, material, on) => effects.shot(point, normal, material, on);
weapon.onPaintball = (from, to, paint) => effects.paintShot(from, to, paint);
weapon.onEject = (w) => effects.casing(camera, w, weapon.aimAmount);

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
  bakedWanted = s.baked;
  baked.setEnabled(preset.baked || bakedWanted);
  // The minimap (N) and the FPS counter (F, Create): settings, so touch and controller players have them too.
  document.getElementById('minimap')!.classList.toggle('hidden', !s.minimap);
  mapBtn.classList.toggle('hidden', !s.minimap);
  hud.showFps(s.fps);
}
settings.onChange = applySettings;
applySettings(settings.value);
const rumble = (strong: number, weak: number, ms: number) => settings.value.vibration && input.rumble(strong, weak, ms);

// Footsteps: yours from the middle, the others' from where they walk; louder when running.
player.onStep = (speed) => footstep(surfaceOf(player.ground.mat), Math.min(1, 0.25 + speed / 7));
player.onLand = (speed) => {
  footstep(surfaceOf(player.ground.mat), Math.min(1, speed / 6));
  weapon.land(speed);
};
menu.onSpeed = (v) => (player.walkSpeed = v);
// Paintball is Action with paint guns: the same weapon and fight, shown the friendly way (src/paintball.ts).
weapon.setEnabled(menu.playing !== 'explore');
setPaintball(menu.playing === 'paintball');
menu.onPlayMode = (play) => {
  weapon.setEnabled(play !== 'explore');
  setPaintball(play === 'paintball');
  combat.setActive(!!me && play !== 'explore');
};

window.addEventListener('keydown', (e) => {
  // By the letter on the key, not its place: on an AZERTY keyboard M is where QWERTY has ; (movement stays by place: ZQSD is WASD).
  // Shift+M is the sound (src/start.ts, with the Sound and Full screen buttons).
  if (e.key.toLowerCase() !== 'm' || e.shiftKey || e.repeat || typing(e)) return;
  toggleMap();
});

// ---- Multiplayer: join on the start screen; the players (4 at once unless the admin allows more) share the house.
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
avatars.onStep = (_name, at, speed) => footstep(surfaceOf(world.groundAt(at.x, at.z, at.y + 0.3, 0.6).mat), Math.min(1, 0.35 + speed / 5), at);
const chat = new Chat();
chat.paused = () => menu.open; // T and Enter belong to the menu while it is open
const combat = new Combat();
const leaderboard = new Leaderboard();
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
  const count = t('online.count', { n: online.size, max: rules.maxPlayers ?? 4 });
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
const ANYTHING_GOES: Rules = { flying: true, furniture: true, names: true, maxPlayers: 4, pin: true, portals: true, travel: true, paintball: false };
let rules = ANYTHING_GOES;
const flyBox = $('set-flying') as HTMLInputElement;
const furnBox = $('set-furniture') as HTMLInputElement;
const namesBox = $('set-names') as HTMLInputElement;
const maxSlider = $('set-max') as HTMLInputElement;
const pinBox = $('set-pin') as HTMLInputElement;
const portalsBox = $('set-portals') as HTMLInputElement;
const travelBox = $('set-travel') as HTMLInputElement;
const paintballBox = $('set-paintball') as HTMLInputElement;
// The admin can move extremely fast (Yoshi): their own choice, kept on this device; the server lets an admin that fast.
const turboBox = $('set-turbo') as HTMLInputElement;
try {
  turboBox.checked = localStorage.getItem('briel.turbo') === '1';
} catch {
  // storage blocked: off
}
function applyTurbo(): void {
  player.turbo = me?.role === 'admin' && turboBox.checked ? 15 : 1;
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
  player.canFly = next.flying;
  if (!next.flying) player.flying = false;
  flyBox.checked = next.flying;
  furnBox.checked = next.furniture;
  namesBox.checked = next.names;
  pinBox.checked = next.pin ?? true;
  portalsBox.checked = next.portals ?? true;
  travelBox.checked = next.travel ?? true;
  paintballBox.checked = next.paintball ?? false;
  menu.setChildSafe(next.paintball ?? false); // child-friendly for everyone: Action plays as Paintball
  maxSlider.value = String(next.maxPlayers ?? 4);
  $('set-max-value').textContent = maxSlider.value;
  avatars.showNames = next.names && !games.hideOthers;
  if (!mayFurnish()) planner.toggle(false);
  // The planner's button greyed out for those the admin hasn't allowed it (the server refuses them anyway).
  const plannerBtn = document.getElementById('planner-btn') as HTMLButtonElement;
  plannerBtn.disabled = !mayFurnish();
  plannerBtn.title = mayFurnish() ? '' : t('chat.furnOff');
  planner.clowns = !me || me.role === 'admin'; // alone you may place clowns; in multiplayer the admin
}
/** The admin can always arrange the furniture; others when the admin allows it. */
function mayFurnish(): boolean {
  return rules.furniture || me?.role === 'admin';
}
flyBox.addEventListener('change', () => net.send({ t: 'rules', flying: flyBox.checked }));
furnBox.addEventListener('change', () => net.send({ t: 'rules', furniture: furnBox.checked }));
namesBox.addEventListener('change', () => net.send({ t: 'rules', names: namesBox.checked }));
pinBox.addEventListener('change', () => net.send({ t: 'rules', pin: pinBox.checked }));
portalsBox.addEventListener('change', () => net.send({ t: 'rules', portals: portalsBox.checked }));
travelBox.addEventListener('change', () => net.send({ t: 'rules', travel: travelBox.checked }));
paintballBox.addEventListener('change', () => net.send({ t: 'rules', paintball: paintballBox.checked }));
// The admin's PIN field: filled when the admin logs in, saved on the server.
const pinCode = $('set-pin-code') as HTMLInputElement;
const pinMsg = $('set-pin-msg');
$('set-pin-show').addEventListener('click', () => {
  pinCode.type = pinCode.type === 'password' ? 'text' : 'password';
  showPinButton();
});
const showPinButton = () => ($('set-pin-show').textContent = t(pinCode.type === 'password' ? 'adm.show' : 'adm.hide'));
/** The note under the PIN: how to pick one, or what saving did (kept as a function, drawn again in another language). */
let pinNote: (() => string) | null = null;
const showPinNote = () => (pinMsg.textContent = pinNote ? pinNote() : t('adm.pinNote'));
$('set-pin-save').addEventListener('click', async () => {
  try {
    const r = await api.setPin(pinCode.value.trim());
    const n = r.loggedOut;
    pinNote = () => `${t('pin.saved')}${n ? ` ${plural(n, 'pin.loggedOut.one', 'pin.loggedOut.other', { n })}` : ''}`;
    pinMsg.classList.remove('bad');
  } catch (e) {
    pinNote = errorText(e);
    pinMsg.classList.add('bad');
  }
  showPinNote();
});
maxSlider.addEventListener('input', () => ($('set-max-value').textContent = maxSlider.value));
maxSlider.addEventListener('change', () => net.send({ t: 'rules', maxPlayers: Number(maxSlider.value) }));
/**
 * Alone or together: joining with the PIN and the admin's login work on the start screen, before
 * the world exists (src/start.ts). The world follows, once it is there and on every change
 * (onAccount, below the server's messages): the menu's Together and admin parts, the house rules,
 * and the connection to the others.
 */
function followAccount(account: Me | null): void {
  queueMicrotask(applyTurbo); // after `me` is set below: the admin's speed, or back to normal
  $('mp-join-here').classList.toggle('hidden', !!account);
  $('mp-leave').classList.toggle('hidden', !account);
  $('scores-col').classList.toggle('hidden', !account);
  chat.setEnabled(!!account);
  admin.show(account?.role === 'admin' ? account.username : null);
  $('newround-btn').classList.toggle('hidden', account?.role !== 'admin');
  $('clearfurn-btn').classList.toggle('hidden', account?.role !== 'admin');
  $('resetfurn-btn').classList.toggle('hidden', !!account && account.role !== 'admin');
  $('set-admin').classList.toggle('hidden', account?.role !== 'admin');
  if (account?.role === 'admin') void api.pin().then((r) => (pinCode.value = r.pin)).catch(() => {});
  else pinCode.value = '';
  pinNote = null;
  showPinNote();
  if (!account) applyRules(ANYTHING_GOES);
  weapon.setAdminWeapons(!account || account.role === 'admin');
  leaderboard.show(!!account);
  $('game-admin').classList.toggle('hidden', account?.role !== 'admin');
  if (!account) {
    games.set({ kind: 'free' });
    clowns.setAll(CLOWN_DEFAULTS); // alone: the starting clowns again
  }
  if (account) net.connect();
  else {
    net.disconnect();
    avatars.clear();
    online.clear();
    for (const c of cars) c.driver = c.passenger = null; // alone, the cars are yours
    horses.reset(); // and the horses back on their walks
    combat.me = '';
    combat.reset([], 10, null);
    loadLocalFurniture();
  }
  showOnline();
  combat.setActive(!!account && weapon.enabled);
}
// Another language: the texts made here that aren't drawn every frame (the modules redraw their own).
onLang(() => {
  showOnline();
  showPinButton();
  showPinNote();
  netStatus.textContent = netText();
  if (menu.open && !menu.onStartScreen && me?.role === 'admin') admin.show(me.username);
});

chat.onSend = (text) => (text.startsWith('/') ? command(text) : net.send({ t: 'chat', text }));
games.onSend = (msg) => net.send(msg);
document.querySelectorAll<HTMLButtonElement>('[data-game]').forEach((b) =>
  b.addEventListener('click', () => net.send({ t: 'mode', kind: b.dataset.game })),
);
weapon.onGlassHit = (i, point, from) => {
  if (glass.break(i, point, from)) net.send({ t: 'glass', i });
};
weapon.onPlayerHit = (name, body, head, point, spot) => {
  if (games.friend(name)) return; // your own team in the teams game
  effects.hit(point, spot);
  avatars.flinch(name);
  if (!avatars.canBeHit(name)) return;
  combat.hitMarker();
  net.send({ t: 'hit', target: name, w: weapon.current, body, head });
};

/** Which way a hit came from, relative to where you look (0 = ahead, positive = left). */
function hitAngle(by: string): number | null {
  const at = avatars.position(by);
  if (!at) return null;
  return Math.atan2(-(at.x - player.x), -(at.z - player.z)) - player.yaw;
}
const weaponName = (w: string) => (w === 'grenade' || w in SPECS ? shownWeapon(w as WeaponId | 'grenade') : '');
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
  if (hp > 0) soloHurt(hp);
};
/** Alone, a strongman hurt you: your health goes down here; at nothing you're out for 3 seconds. */
function soloHurt(amount: number): void {
  combat.hurt(Math.max(0, combat.hp - amount));
  rumble(0.8, 0.5, 180);
  if (combat.hp > 0) return;
  combat.died(t('char.strongman'), false);
  combat.kill(t('char.strongman'), t('char.you'), false, '');
  setTimeout(() => {
    if (!net.connected && !combat.alive) respawnAt(HOUSE_SPAWNS[Math.floor(Math.random() * HOUSE_SPAWNS.length)]);
  }, 3000);
}
weapon.onClownHit = (id, point, spot) => clownHit(id, point, weapon.current, spot);
$('newround-btn').addEventListener('click', () => net.send({ t: 'newround' }));

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
  if (!mine) return;
  for (const i of glass.near(at, radius * 0.7)) if (glass.break(i, at, at)) net.send({ t: 'glass', i });
  for (const i of cats.near(at, radius)) catHit(i, at, w);
  for (const id of clowns.near(at, radius)) clownHit(id, at, w);
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
  rumble(weapon.current === 'pistol' ? 0.25 : 0.6, 0.6, weapon.current === 'rifle' ? 50 : 90);
  if (shot.rocket) fireRocket(shot.rocket.from, shot.rocket.to);
  else net.send({ t: 'shot', w: weapon.current, x: player.x, y: player.feet + 1.5, z: player.z });
  life.scare(camera.getWorldPosition(new THREE.Vector3()));
}
/** The bazooka is the admin's, and anyone's playing alone. */
function adminWeapons(): WeaponId[] {
  return !me || me.role === 'admin' ? ['bazooka'] : [];
}

/** Get in: alone right away; in multiplayer once the server says the car is yours. */
function getIn(): void {
  if (!net.connected) return startDriving();
  net.send({ t: 'car', op: 'in', id: car.id });
  wantCar = true;
}
function startDriving(): void {
  driving = true;
  wantCar = false;
  car.enter();
  planner.toggle(false);
}
/** In the passenger seat: the car (someone else drives) carries you, the camera behind it. */
function startRiding(): void {
  riding = true;
  wantCar = false;
  car.enter();
  planner.toggle(false);
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
  if (!net.connected) {
    horses.mount(i, me?.username ?? 'you');
    planner.toggle(false);
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

/** Back in the game at spawn point `i` (chosen by the server, away from the others). */
function respawnAt(i: number): void {
  getOut(false);
  getOffHorse(false);
  const s = spawns[i];
  if (s) {
    const [mx, mz] = s.team === 'bungalow' ? [83.5, 189.7] : [4.5, 6];
    const yaw = Math.atan2(-(mx - s.x), -(mz - s.z)); // facing the middle of the house (or the bungalow)
    player.place(s.x, s.z, world.groundAt(s.x, s.z, s.y + 0.3, 0).y, yaw, 0);
  }
  player.down = 0;
  player.update(0, NO_INPUT, camera);
  combat.respawned();
  weapon.resetLoadout(adminWeapons());
  grenades.refill();
}

/**
 * Travelling through the portals (shared/portals.mjs), from a portal's pad or from the chat
 * (/church): a flash in the portal's colour and you come out at the other one, in the car if you
 * drive it (the passenger comes along). In multiplayer the server checks the trip and moves you
 * there for the others; meanwhile your position isn't sent, so it can't pull you back. A place in
 * the village waits for the village if it is still loading.
 */
let trip: { to: Portal; answer?: (ok: boolean) => void } | null = null;
let cameFrom: string | null = null; // the portal you last came from: "back" in the next list
let justArrived: string | null = null; // the portal you came out of: its pad waits until you have stepped off it
const warp = $('warp');
const portalMarks = PORTALS.map((p) => ({ x: p.x, z: p.z, color: p.color }));
travelPanel.onPick = (p) => void travel(p, 'portal');
async function travel(to: Portal, via: 'portal' | 'chat'): Promise<void> {
  if (trip || !combat.alive || planner.active || games.blindfolded) return;
  if (via === 'chat') {
    if (riding) getOut(); // the driver keeps the car
    if (horses.mounted >= 0) getOffHorse();
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
function arrive(to: Portal, from: Portal | null): void {
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
/** The word for a portal in the chat, in the current language (both languages' words always work: shared/portals.mjs). */
const portalWord = (p: Portal) => (lang() === 'nl' ? ({ house: 'huis', church: 'kerk' } as Record<string, string>)[p.id] ?? p.id : p.id);
/** Words before the place that change nothing: /go church, /ga naar kerk, /tp school. */
const TRAVEL_WORDS = new Set(['location', 'go', 'goto', 'to', 'tp', 'travel', 'teleport', 'ga', 'gaan', 'naar', 'reis', 'reizen']);
/** Chat commands: /church, /house, /location school, /kerk, /ga naar huis ... and /places for the list. */
function command(text: string): void {
  const words = text.slice(1).trim().toLowerCase().split(/\s+/);
  while (words.length > 1 && TRAVEL_WORDS.has(words[0])) words.shift();
  const word = TRAVEL_WORDS.has(words[0]) ? '' : words[0];
  const to = findPortal(word);
  if (!to) return chat.system(() => t('chat.travelHelp', { list: PORTALS.map((p) => `/${portalWord(p)}`).join(' ') }));
  if (!rules.travel && me?.role !== 'admin') return chat.system(() => t('srv.travelChatOff'));
  if (!combat.alive) return chat.system(() => t('chat.notDown'));
  void travel(to, 'chat');
}
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
};
net.onMessage = (m: ServerMsg) => {
  switch (m.t) {
    case 'welcome':
      // Started somewhere else than the street: the server moves us there before our first update.
      welcomed = true;
      netClock.reset(); // perhaps a restarted server, with a clock of its own
      if (spawnPending) {
        net.send({ t: 'spawn', to: spawnPending.id });
        spawnPending = null;
      }
      avatars.clear();
      online.clear();
      for (const p of m.players) {
        online.set(p.name, p.color);
        if (p.name !== m.you) avatars.add(p.name, p.color);
      }
      showOnline();
      doors.setAll(m.doors, m.doorDir);
      glass.repair();
      for (const i of m.broken ?? []) glass.break(i, null);
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
      games.set(m.mode ?? { kind: 'free' });
      applyRules(m.rules ?? ANYTHING_GOES);
      getOut(false); // alone you may have been driving: the shared cars are where the server has them
      getOffHorse(false); // or riding
      wantCar = false;
      horseWanted = -1;
      for (const s of m.cars ?? []) carById(s.id)?.setPose(s, true);
      horses.setAll(m.horses ?? [], m.you);
      {
        const [n, max] = [m.players.length, rules.maxPlayers ?? 4];
        chat.system(() => t('chat.joinedAs', { name: m.you, n, max }));
      }
      if (m.proto !== PROTO) chat.system(() => t('net.reload')); // the game was updated since this page loaded
      break;
    case 'rules':
      applyRules(m.rules);
      break;
    case 'mode':
      games.set(m.mode);
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
    case 'horse': {
      const h = m.horse;
      const mine = !!me && h.rider === me.username;
      if (mine && horses.mounted !== h.i) {
        if (horseWanted === h.i) {
          horses.mount(h.i, me!.username);
          planner.toggle(false);
        } else net.send({ t: 'horse', op: 'off' }); // not asked for (an old connection's): give it back
      } else if (!mine && horses.mounted === h.i) getOffHorse(false); // taken back: you died or respawned
      if (horseWanted === h.i) horseWanted = -1;
      horses.setAll([h], me?.username ?? '');
      break;
    }
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
    case 'chat':
      chat.add(m.from, m.color, m.text);
      break;
    case 'door':
      doors.set(m.id, m.open, m.dir);
      break;
    case 'glass': {
      const at = glass.bounds(m.i)?.getCenter(new THREE.Vector3()) ?? null;
      glass.break(m.i, at, avatars.position(m.by)?.clone().setY((at?.y ?? 1) + 0) ?? undefined);
      break;
    }
    case 'repair':
      glass.repair();
      chat.system(() => t('chat.repaired', { name: m.by }));
      break;
    case 'shot': {
      const at = avatars.position(m.name);
      const from = at ? at.clone().setY(at.y + 1.4) : new THREE.Vector3(m.x, m.y, m.z);
      weapon.remoteShot(from, m.w as WeaponId);
      life.scare(from);
      const muzzle = avatars.flash(m.name);
      if (muzzle) effects.muzzleSmoke(muzzle);
      break;
    }
    case 'scores':
      combat.setScores(m.list);
      break;
    case 'hurt':
      combat.hurt(m.hp);
      rumble(0.8, 0.5, 180);
      if (hitAngle(m.by) !== null) combat.hitFrom(hitAngle(m.by)!);
      break;
    case 'kill':
      combat.kill(whoName(m.killer), m.victim, m.head, weaponName(m.w));
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
      if (m.name === me?.username) respawnAt(m.spawn);
      else avatars.respawn(m.name);
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
      break;
    case 'spawn':
      // The start place was refused (the admin turned the portals off): back to where the server has us.
      player.place(m.x, m.z, groundY(m.x, m.z), player.yaw, 0);
      player.update(0, NO_INPUT, camera);
      break;
    case 'travel': {
      const to = PORTALS.find((p) => p.id === m.to);
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
    case 'kicked':
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
  if (m.b) clowns.receive(m.b.map(readBrute), m.st); // every other tick
}
// Alone or together from here on (perhaps joined on the start screen already): after the handlers
// above, so the connection's first status and messages reach them.
onAccount(followAccount);

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
 * the pointer-lock change that follows finds it open and doesn't open it again on another tab.
 */
function openMenu(tab?: string): void {
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
  }
  menuHint.textContent = key('menu', mode);
  planner.control = mode;
  touch.show(mode === 'touch');
  if (mode === 'touch') fillScreen(); // the first start asked for it in its tap already (src/start.ts)
  // Keyboard + mouse: capture the mouse so moving it turns the view.
  resumedAt = performance.now();
  if (mode === 'kbm') lockMouse();
  else document.exitPointerLock?.();
};
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
let resumedAt = -1e9; // when play last resumed (the menu closed)
document.addEventListener('pointerlockchange', () => {
  // Esc releases the mouse in the browser: treat that as pausing. When the game let it go itself (M,
  // the menu opening), the menu is open already and stays on its tab. Not just after the menu closed:
  // the Esc that closed it can still take back the capture asked for on closing, and the menu (on
  // the map) came straight back, as if Esc didn't close the map (Yoshi). The click hint shows then.
  if (!document.pointerLockElement && menu.mode === 'kbm' && !menu.open && !chat.typing && performance.now() - resumedAt > 800) openMenu();
});

window.addEventListener('resize', resize);

// Eye adaptation: indoors the view brightens, outdoors it settles back,
// like your eyes (and the camera in GTA) adjusting when you walk through a door.
const roomNames = new Set(house.rooms.map((r) => r.name));
let exposure = renderer.toneMappingExposure;
let shake = 0;
let flyHint = 0; // seconds the flying controls still show after taking off
let calmHint = 0; // seconds "no shooting here" still shows on the school grounds
let horseHint = 0; // seconds the riding keys still show after getting on a horse
let wasOnHorse = false;
let carHint = 0; // the same for the car's speed and keys after getting in
let wasInCar = false;
let wasCalm = false;
let wasFlying = false;
let inside = false; // in the house's rooms or on its stairs: the minimap names the floor only then

let last = performance.now();
renderer.setAnimationLoop((now: number) => {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  const frame = input.poll();
  if (frame.mapPressed) toggleMap(); // a short press on the touchpad, as M
  menu.setPadState(input.padName);
  hud.setPad(input.padName, menu.mode === 'pad');
  if (frame.fpsPressed) settings.toggle('fps'); // F, or Create on the controller (Settings: FPS counter)
  captureHint.classList.toggle('show', !menu.open && menu.mode === 'kbm' && document.pointerLockElement !== canvas && !chat.typing);

  // The weapons lying around: only in Action mode (Yoshi), and never from the start view, where their
  // rings look like odd logos.
  pickups.group.visible = !menu.onStartScreen && weapon.enabled;
  portals.group.visible = !menu.onStartScreen;
  if (menu.onStartScreen) weapon.hidden = true; // nor the pistol in your hand: from the start view its barrel is a ring mid-screen
  if (menu.open) {
    travelPanel.hide();
    if (menu.onStartScreen) startCamera();
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
    if (back || (frame.confirmPressed && !bigMap.open)) {
      menu.resume(menu.onStartScreen ? 'pad' : (menu.mode ?? 'pad'));
    } else if (pause && frame.tabStep) {
      menu.stepTab(frame.tabStep);
    } else if (frame.squarePressed) {
      menu.cycleGraphics(); // the square button on the controller changes the graphics setting
    } else if (frame.speedStep) {
      menu.setSpeed(menu.walkSpeed + frame.speedStep * 0.2);
    }
  } else {
    if (frame.menuPressed && !chat.typing) openMenu();
    if (document.visibilityState === 'visible' && (playClock += dt) >= 60) {
      playClock -= 60;
      beacon('minute');
    }
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
    } else {
      // Dead: only looking around. The seeker in hide and seek: eyes shut, not even that.
      const still = games.blindfolded ? NO_INPUT : { ...NO_INPUT, mouseX: frame.mouseX, mouseY: frame.mouseY, lookX: frame.lookX, lookY: frame.lookY };
      player.update(dt, dead || games.blindfolded ? still : frame, camera);
    }
    // A blast nearby shakes the view for a moment (on top of where you look, so aim comes back).
    if (shake > 0.002) {
      const t = now / 1000;
      camera.rotation.x += (Math.sin(t * 53) + Math.sin(t * 31)) * 0.012 * shake;
      camera.rotation.y += (Math.sin(t * 47) + Math.sin(t * 23)) * 0.012 * shake;
      camera.rotation.z += Math.sin(t * 41) * 0.015 * shake;
      shake *= Math.exp(-dt * 4);
    }
    combat.showBoard(frame.scoreHeld && !!me);
    const inCar = driving || riding;
    const onHorse = horses.mounted >= 0; // you may shoot from the saddle
    weapon.hidden = dead || planner.active || inCar || games.peaceful;
    planner.update(frame, camera);

    // The portals: on a pad (or stopped on one in the car) the list of places opens, and takes the
    // number keys, the wheel or D-pad and E. Not on horseback, nor from the passenger seat.
    const mode = menu.mode ?? 'kbm';
    let pad = !rules.portals || trip || dead || planner.active || riding || onHorse || games.blindfolded ? null
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
    const target = inCar || onHorse || tagWho ? null : doors.lookedAt(camera, scene);
    if (target && (frame.usePressed || (!action && !planner.active && frame.clickPressed))) target.toggle();
    games.update(dt, player.x, player.feet, player.z);
    // The cars: E or Triangle next to one gets you in (unless two are in it already), and out again.
    if (!inCar && !wantCar) car = cars.reduce((a, b) => (b.distanceTo(player.x, player.z) < a.distanceTo(player.x, player.z) ? b : a));
    const nearCar = !inCar && !onHorse && !dead && !planner.active && car.distanceTo(player.x, player.z) < CARS.reach && Math.abs(player.feet - car.y) < 1;
    // The horses: E next to one gets you on it, and off again.
    const nearHorse = !inCar && !onHorse && !dead && !planner.active && !nearCar && horseWanted < 0 ? horses.nearest(player.x, player.z) : -1;
    const carTaken = !!car.driver && car.driver !== me?.username;
    const seatFree = carTaken && !car.passenger;
    if ((driving || riding) && frame.usePressed) getOut();
    else if (onHorse && frame.usePressed) getOffHorse();
    else if (nearCar && !target && (!carTaken || seatFree) && !wantCar && frame.usePressed) getIn();
    else if (nearHorse >= 0 && !target && frame.usePressed) mountHorse(nearHorse);
    if (action && !dead && !planner.active && !inCar) {
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
      weapon.spreadMul = player.crouching ? 0.6 : player.flying || player.feet > player.ground.y + 0.05 ? 2 : frame.sprint && moving ? 1.8 : moving ? 1.25 : 1;
    }
    // The school grounds: no shooting or throwing (shared/zones.mjs; the server refuses too). Said on
    // the way in and whenever you try.
    const calm = action && !!noShoot(player.x, player.z);
    if (calm && !wasCalm) calmHint = 4;
    if (calm && (frame.clickPressed || frame.throwPressed)) calmHint = 2;
    wasCalm = calm;
    if (action && (frame.clickPressed || (weapon.isAuto && frame.fireHeld)) && !dead && !planner.active && !inCar && !calm) fire();
    if (action && frame.reloadPressed && !dead && !inCar) weapon.reload();
    if (action && frame.throwPressed && !dead && !planner.active && !inCar && !calm) throwGrenade();
    weapon.update(dt, inCar ? 0 : Math.min(1, Math.hypot(frame.moveX, frame.moveY)), frame.aimHeld && !inCar, {
      yaw: player.yaw, pitch: player.pitch, side: dead ? 0 : frame.moveX, sprint: frame.sprint && !player.crouching,
      air: player.flying || player.feet > player.ground.y + 0.05,
    });
    // The keys in the prompts come from the one table (src/shortcuts.ts). In Explore a click opens doors too.
    const doorKey = key(action ? 'use' : 'click', mode);
    const use = key('use', mode);
    touch.setState(action, inCar, planner.active);
    const speed = (v: number) => Math.round(Math.abs(v) * 3.6);
    const carLabel = carName(car.id, car.spec.name);
    let prompt = target ? t(target.open ? 'prompt.close' : 'prompt.open', { key: doorKey, door: doorName(target.name) }) : '';
    // The car's speed and keys for the first few seconds in it only (Yoshi, as on a horse).
    if (driving) prompt = carHint > 0 ? t('prompt.driving', { speed: speed(car.speed), use }) : '';
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
    if (pad) prompt = ''; // the list says it all
    else if (!inCar && portalNear(player.x, player.z) && (onHorse || !rules.portals)) prompt = t(onHorse ? 'prompt.horsePortal' : 'prompt.portalsOff');
    hud.setPrompt(prompt);
    const armed = action && !dead && !inCar;
    hud.setWeapon(armed, dead || inCar ? '' : weapon.status);
    hud.setSlots(armed ? weapon.slots : null);
    hud.setGrenades(armed && !planner.active ? grenades.count : null, GRENADE.carry, grenades.nextIn, key('grenade', mode));
    hud.setScope(weapon.scoped, inCar);
    // The flying controls for the first few seconds after taking off only (Yoshi: annoying when it stays).
    if (player.flying && !wasFlying) flyHint = 4;
    const onHorseNow = horses.mounted >= 0;
    if (onHorseNow && !wasOnHorse) horseHint = 5;
    wasOnHorse = onHorseNow;
    horseHint = onHorseNow ? horseHint - dt : 0;
    const inCarNow = driving || riding;
    if (inCarNow && !wasInCar) carHint = 5;
    wasInCar = inCarNow;
    carHint = inCarNow ? carHint - dt : 0;
    wasFlying = player.flying;
    flyHint = player.flying ? flyHint - dt : 0;
    if (flyHint > 0) hud.setPrompt(t('prompt.fly', { up: key('jump', mode), down: key('down', mode) }));
    calmHint = wasCalm ? calmHint - dt : 0;
    if (calmHint > 0) hud.setPrompt(t('prompt.noShoot'));

    // Tell the others where you are: 20 times a second while anything changes, and once more when
    // it stops (so they see you stand where you stopped), then about three times a second. Each
    // carries this page's time for it (`ct`), so the others draw it at an even pace (shared/wire.mjs).
    if (net.connected && !trip?.answer) {
      const r = horses.ridden;
      const cm = (v: number) => Math.round(v * 100) / 100;
      const mrad = (v: number) => Math.round(v * 1000) / 1000;
      const where = driving || riding
        ? { x: cm(car.x), y: cm(car.y), z: cm(car.z), yaw: mrad(car.yaw), pitch: 0, flying: false, c: false, d: true, s: cm(car.steer) }
        : r
          ? { x: cm(r.x), y: cm(r.y + r.jump + 1.64), z: cm(r.z), yaw: mrad(player.yaw), pitch: mrad(player.pitch), flying: false, c: true, hy: mrad(r.yaw), hs: cm(r.speed), hj: cm(r.jump) } // seated in the saddle
          : { x: cm(player.x), y: cm(player.feet), z: cm(player.z), yaw: mrad(player.yaw), pitch: mrad(player.pitch), flying: player.flying, c: player.crouching };
      const state = { t: 'state', ...where, armed: weapon.enabled, w: weapon.current };
      const key = JSON.stringify(state);
      const changed = key !== sent.key;
      const every = changed || sent.moved ? 50 : 300;
      if (now - sent.at >= every - 4) {
        sent = { at: Math.max(sent.at + every, now - 25), key, moved: changed }; // 20 a second on average at any frame rate
        net.send({ ...state, ct: Math.round(now) });
      }
    }

    const surface = player.ground.name;
    const indoors = !!surface && (roomNames.has(surface) || /floor|stairs/i.test(surface));
    inside = indoors;
    // Outside, on the village's ground: the street you are in (its real name), not just "street".
    const at = driving || riding ? car : player;
    const street = !indoors && (driving || riding || !surface || surface === 'street') ? streetAt(at.x, at.z) : undefined;
    hud.setPlace(indoors ? placeName(levelName(player.feet)) : t('place.outside'), street ?? (surface && surface !== 'street' ? placeName(surface) : undefined));
    // Baked lighting has real indoor light levels (a fraction of the sunlit outside), so the
    // eyes adapt much more indoors; real-time fill light on people and furniture is turned
    // down to match. Real-time lighting brightens rooms itself, so it needs only a little.
    const wanted = indoors ? (baked.active ? 0.9 * 6 : 1.05) : 0.9; // white walls since 30 Oct: less brightening
    exposure += (wanted - exposure) * (1 - Math.exp(-dt * 1.5));
    renderer.toneMappingExposure = exposure;
    const fill = baked.active ? Math.min(1, 0.9 / exposure) : 1;
    indoorLight.update(dt, indoors && !baked.active, fill);
  }
  netClock.frame(now); // the time the others are drawn at (net/track.ts)
  avatars.tick(dt);
  for (const c of cars) c.update(dt, driving && c === car, camera.position);
  combat.tick(dt);
  sound.listen(camera);
  player.lookScale = camera.fov / settings.value.fov; // slower turning while zoomed in
  glass.update(dt);
  furnishing.update(dt, camera.position);
  effects.particles.budget = quality === 'low' ? 0.5 : 1; // big smoke puffs are many pixels each
  effects.update(dt);
  grenades.update(dt);
  pickups.update(dt, !net.connected);
  cats.update(dt);
  life.update(dt, camera.position);
  // Alone, the strongmen fight here, going for you when you fight (in multiplayer the server runs them).
  if (!net.connected) clowns.stepAlone(dt, combat.alive && weapon.enabled && !driving && !riding && !games.peaceful ? { x: player.x, y: player.feet, z: player.z } : null);
  clowns.update(camera.position);
  horses.update(dt, camera.position);
  countryside?.update(dt, camera);
  portals.update(dt, camera, renderer.domElement.height);
  // The traffic stops for people and for cars someone drives, never for a parked car (Yoshi: a Tesla on the drive held it up).
  roadLife.update(dt, camera.position, [...avatars.obstacles(), { x: player.x, z: player.z, r: 0.35 }], cars.filter((c) => (driving && c === car) || !!c.driver));
  mapTimer += dt;
  if (mapTimer > 0.05) {
    mapTimer = 0;
    const blips: Blip[] = [
      ...(weapon.enabled ? pickups.blips() : []).map((b) => ({ ...b, color: '', kind: 'item' as const })),
      ...cats.blips().map((b) => ({ ...b, color: '#e0a050', kind: 'cat' as const })),
      ...clowns.blips().map((b) => ({ ...b, color: b.kind === 'strongman' ? '#d0782e' : '#12a3a0', kind: 'cat' as const })),
      ...horses.blips().map((b) => ({ ...b, color: '#8a5a3a', kind: 'cat' as const })),
      ...(games.hideOthers ? [] : avatars.blips().map((b) => ({ ...b, kind: 'player' as const }))),
    ];
    const shapes = [...furnishing.pieces.values()].filter((p) => !p.item.startsWith('rug')).map((p) => ({ ring: footprint(p), y: p.y }));
    for (const c of cars) if (c.ready) shapes.push({ ring: c.footprint(), y: c.y });
    // The floor by the height above the ground there (the village stands 5 m higher than the plot).
    // A waypoint from the big map is done when you reach it.
    if (bigMap.waypoint && Math.hypot(bigMap.waypoint.x - player.x, bigMap.waypoint.z - player.z) < 6) bigMap.waypoint = bigMap.route = null;
    if (bigMap.waypoint && (routeTimer += 0.05) > 0.5) updateRoute();
    minimap.draw(player.x, player.z, player.feet - terrain.height(player.x, player.z), player.yaw, weapon.enabled ? blips : blips.filter((b) => b.kind !== 'item'), shapes, rules.portals ? portalMarks : [], bigMap.waypoint, bigMap.route, inside);
  }
  horizon.position.x = camera.position.x;
  horizon.position.z = camera.position.z;
  tiles.update(dt, camera.position);
  homeStreet.update(dt, camera.position);
  groundShade.follow(camera.position);
  // The sun's real-time shadow only covers the house: far from it (the village) it isn't worked out.
  renderer.shadowMap.autoUpdate = camera.position.distanceTo(center) < 250;
  if (bigMap.open) {
    const marks: Mark[] = [
      ...cars.filter((c) => c.ready).map((c) => ({ x: c.x, z: c.z, yaw: c.yaw, color: c.spec.paint, kind: 'car' as const })),
      ...horses.blips().map((h) => ({ ...h, color: '#8a5a3a', kind: 'horse' as const })),
      ...(games.hideOthers ? [] : avatars.marks().map((a) => ({ ...a, kind: 'player' as const }))),
    ];
    bigMap.tick(mapYou(), marks);
  } else composer.render(dt); // the menu's Map tab covers most of the screen: the world isn't drawn behind it
  if (!menu.open) adaptQuality(dt);
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
/** The village, once: later calls wait for the same load (a trip through a portal to it). */
function loadVillage(): Promise<void> {
  return (villageJob ??= buildVillage());
}
async function buildVillage(): Promise<void> {
  village = 'loading';
  const data = (await import('./data/village.json')).default as unknown as VillageData;
  const first = poles.length;
  poles.push(...(data.poles ?? []));
  const landmarks = (data.landmarks ?? []).map((l) => {
    const box = new THREE.Box2().setFromPoints(l.p.map(([x, z]) => new THREE.Vector2(x, z)));
    return box.getCenter(new THREE.Vector2());
  });
  for (const c of landmarks) detailAt.push([c.x, c.y]);
  const streetJobs = ['molenhoek', 'kapellenhoek'].map((name) => loadStreetModel(renderer, house.ground, name).catch(() => null)); // world/streetModel.ts
  // The church and the school (with the square's fittings): our Blender models in place of the blocks
  // built from the open data, which stay for walking into. A model that didn't load leaves its blocks drawn.
  // The houses round the square (world/townCentre.ts) replace the blocks inside the outlines they name.
  // (?notown in the dev build leaves them out, to compare.)
  const town = import.meta.env.DEV && location.search.includes('notown')
    ? Promise.reject(new Error('left out'))
    : import('./world/townCentre').then(({ loadTown }) => loadTown(renderer, (x, z) => house.ground + terrain.height(x, z)));
  const models = (await Promise.all([loadChurch().catch(() => null), loadModel('/models/school.glb').catch(() => null), town.catch(() => null)])).filter(
    (m): m is THREE.Object3D => m !== null,
  );
  // The houses of Molenhoek (and its street) and of Kapellenhoek, the same way: fitted into the village data before its tiles are built.
  for (const job of streetJobs) {
    const street = await job;
    if (street) {
      fitStreetModel(data, street, first);
      models.push(street);
    }
  }
  const drawn = withRoadDetail(withoutLandmarks(data, models.map((m) => m.userData.landmark as string), models.flatMap((m) => (m.userData.replaces as Ring[] | undefined) ?? [])));
  const made: { key: string; pieces: ReturnType<typeof buildTile> }[] = [];
  for (const [key, t] of splitTiles(drawn, first)) {
    made.push({ key, pieces: buildTile(t, poles, renderer, house.ground, detail) });
    await new Promise((r) => setTimeout(r, 0)); // one tile at a time, between frames
  }
  tiles.addSet(made, false); // a set of its own, apart from the ring's (no shadow pass: the sun's shadow is round the house)
  const roads = buildRoadDetail(true, renderer, house.ground);
  tiles.addSet(roads.tiles, false);
  world.addPrisms(roads.blocks);
  for (const m of models) {
    tiles.group.add(m); // a caster for the village's ground shading, a target for shots
    tiles.track(m);
  }
  world.addPrisms(data.prisms ?? []);
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
  portals.settle(); // the village's paving under its portals
  bigMap.addVillage(data);
  await environmentReady;
  const c = landmarks[0] ?? new THREE.Vector2(521.5, -744.2); // the church
  const centre = new THREE.Vector3(c.x, house.ground + terrain.height(c.x, c.y), c.y);
  tiles.showAll(); // every tile throws its shadow, however far the camera is now
  for (const m of models) m.visible = true;
  groundShade.bakeVillage(renderer, scene, sun, [tiles.group], house.ground, centre, 345, phone ? 1024 : 2048);
  village = 'ready';
  for (const c of cars) c.ready = true; // the cars parked in the village (shared/car.json) with it
  void roadLife.load(renderer, scene, camera);
}

/** The countryside's life (world/countryside.ts): herds, birds, bales, field rows, wind and sounds; a chunk of its own. */
let countryJob: Promise<void> | null = null;
function startCountryside(): Promise<void> {
  return (countryJob ??= import('./world/countryside').then(({ Countryside }) => {
    const indoors = () => !!player.ground.name && (roomNames.has(player.ground.name) || /floor|stairs/i.test(player.ground.name));
    countryside = new Countryside({ scene, renderer, world, now: () => performance.now() / 1000 + clockOffset, quality: () => quality, phone, far: () => tiles.drawDistance, indoors });
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
  const x = 521.51;
  const z = -744.15;
  root.position.set(x, house.ground + terrain.height(x, z), z);
  root.rotation.y = 2.525;
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
      m.normalScale.setScalar(u.normalScale ?? 1);
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
  const within = (rings: Ring[], x: number, z: number, margin: number) =>
    rings.some((ring) => {
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
  const inner = (ring: Ring): [number, number] => {
    for (let i = 0; i < ring.length; i++) {
      for (const k of [2, 3]) {
        const a = ring[i];
        const b = ring[(i + k) % ring.length];
        const m: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (within([ring], m[0], m[1], 0)) return m;
      }
    }
    return middle(ring);
  };
  const housePart = (ring: Ring) => houses.length > 0 && ring.every(([x, z]) => within(houses, x, z, 0.4)) && within(houses, ...inner(ring), 0);
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
  const on = (list: Carrier[], x: number, z: number, y: number) =>
    list.some((c) => x > c.box[0] && x < c.box[1] && z > c.box[2] && z < c.box[3] && y > c.y0 - 0.3 && y < c.y1 + 0.3 && within([c.ring], x, z, 0.3));
  return {
    ...data,
    prisms,
    roofs,
    openings: (data.openings ?? []).filter((o) => {
      const x = (o.a[0] + o.b[0]) / 2;
      const z = (o.a[1] + o.b[1]) / 2;
      const y = (o.y[0] + o.y[1]) / 2;
      return !inside(x - o.n[0] * 0.3, z - o.n[1] * 0.3) && !(on(hidden, x, z, y) && !on(drawn, x, z, y));
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
 * Auto: test-render the real scene from two spots (street and kitchen) at
 * different presets as the last part of loading, and keep the best one that
 * holds 60 fps. Takes one to three seconds.
 */
async function autoDetect(): Promise<void> {
  menu.setGraphics('auto', null, gpu);
  await environmentReady;
  await texturesReady;
  const keep = { x: player.x, z: player.z, feet: player.feet, yaw: player.yaw, pitch: player.pitch };
  const still = NO_INPUT;
  const views: [number, number, number, number, number][] = [
    [house.spawn.x, house.spawn.z, -0.02, house.spawn.yaw, 0.1],
    [7.6, 3.6, 3.05, 1.2, -0.05],
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
      total += timeFrames(() => composer.render(1 / 60), gl, 5);
    }
    return total / views.length;
  });
  player.place(keep.x, keep.z, keep.feet, keep.yaw, keep.pitch);
  player.update(0, still, camera);
  if (mode === 'auto') applyQuality(result.quality);
  menu.setGraphics(mode, quality, gpu, Math.round(result.ms));
  composer.render(0); // the front of the house, then play
  loaded();
}
if (mode === 'auto') void autoDetect().catch(loaded);
else void Promise.all([environmentReady, texturesReady]).then(loaded, loaded);

// Development only: lets automated checks move the player without a controller.
if (import.meta.env.DEV) {
  const idle = NO_INPUT;
  Object.assign(window, {
    briel: {
      player,
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
      getIn,
      getOut,
      horses,
      clowns,
      mountHorse,
      getOffHorse,
      driving: () => driving,
      furnishing,
      planner,
      avatars,
      /** The drawing clock for the others (net/track.ts) and the connection, for the network checks. */
      net: () => ({ delay: netClock.delay, late: netClock.late, age: netClock.age, rate: netClock.rate, rtt: net.rtt, ...net.counts }),
      combat,
      world,
      spawns,
      respawnAt,
      fire,
      /** One frame of input, e.g. { jumpPressed: true } or { usePressed: true }. */
      press(partial: Partial<typeof NO_INPUT>, seconds = 1 / 60) {
        for (let i = 0; i < Math.max(1, Math.round(seconds * 60)); i++) player.update(1 / 60, { ...idle, ...partial }, camera);
        return { x: +player.x.toFixed(3), z: +player.z.toFixed(3), feet: +player.feet.toFixed(3), flying: player.flying };
      },
      three: { renderer, scene, sun, ao, composer, environmentReady, applyQuality, autoDetect, quality: () => quality, groundShade },
      tiles,
      home,
      homeStreet,
      grass,
      horizon,
      village: () => village,
      loadVillage,
      countryside: () => countryside,
      portals,
      roadLife,
      travel: (word: string, via: 'portal' | 'chat' = 'chat') => travel(findPortal(word)!, via),
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
          composer.render(1 / 60);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // wait for the GPU to finish
        }
        const ms = (performance.now() - t0) / n;
        return { msPerFrame: +ms.toFixed(2), fpsPossible: Math.round(1000 / ms), pixels: [renderer.domElement.width, renderer.domElement.height] };
      },
    },
  });
}
