import * as THREE from 'three';
import {
  type Choice, type Cycle, cycleTime, DEFAULT_CHOICE, DEFAULT_MOOD, DRY_MS, isChoice, isCycle, type Mood, MoodCycle, MOODS, newCycle, runOf, sameRun,
  skipCycle, winterAt,
} from '../../shared/moods.mjs';
import { bakeMood } from './bakedLight';
import { environment, loadSky, type SkyLook } from './environment';
import { groundWet } from './groundShade';
import type { IndoorLight } from './indoorLight';
import { moodShown } from './mood';
import { Rain } from './rain';
import { Snow } from './snow';
import { snowCover } from './snowCover';
import { StreetLights } from './streetLights';

/**
 * The weather and the time of day: sunny (as it always was), overcast, rain and night (shared/moods.mjs), or Auto,
 * the default: the moods follow each other by themselves, slowly (20 to 40 minutes each, the night 10 to 20, sunny
 * most often, never sunny straight to night), each change blending over two and a half minutes (Yoshi: "I also want
 * the weather to automatically cycle, but don't rush it too much"). Alone each player picks a mood or Auto in the
 * settings (src/settings.ts) and runs the cycle here; together the admin picks it for everyone, and every page works
 * out the same cycle from the server's seed and clock (setServer). "Next weather" ends the mood shown on Auto: the
 * player's own alone, the admin's for everyone together (the server checks it).
 *
 * A mood is a set of numbers (LOOKS) and a sky photo: the sunny one from the start (world/environment.ts), the
 * overcast and the night ones (Poly Haven, CC0) fetched only when a mood that needs them comes up (on Auto, as soon as
 * the next mood is known, minutes before its blend). Each frame the numbers of the two moods are blended; the sky
 * seen crossfades (world/sky.ts reads the second photo only while two blend); the sky's light (one light map at a
 * time) changes over halfway, its strength kept to the blend so the swap doesn't show. A mood picked by hand blends
 * in a few seconds. Only uniforms, lights' strengths and textures of the same size change: no shader of the world
 * compiles again. The sun stays where it is: under clouds its light fades out (its shadow map is no longer drawn);
 * at night it is the moon, from the same side, so the baked shadows (world/bakedLight.ts, world/groundShade.ts)
 * still agree. The baked sky light follows the sky's (bakeMood).
 *
 * The rain (world/rain.ts) falls round the eye and makes the ground wet (groundWet: darker, the paving and roads
 * shiny), drying slowly after; at night the street lamps glow (world/streetLights.ts). Others read the mood shown
 * from world/mood.ts (lit windows, birdsong), which has no graphics in it.
 *
 * Dusk: golden hour into blue hour (on Auto it darkens through its time, then turns into the night). The sun goes
 * low and warm, from the same compass side as the noon sun the bakes were made with, so the baked shadows still
 * agree in direction; near the main house, where the real-time shadow map draws, its shadows grow long. The dusk sky
 * photo's sun is turned to that side too. The lamps and the lit windows come on as it darkens (`night` ramps).
 * Snow: flakes drifting round the eye (world/snow.ts), and snow lying (world/snowCover.ts: the ground, roofs, hedges
 * and crowns turn white where they face up), building up slowly while it falls and melting slowly after. On Auto
 * snow only comes in winter (shared/moods.mjs).
 */

export { MOODS, type Mood };
export { mood, onMoodChange, type MoodState } from './mood';

/** Which photo a mood's sky is. */
type SkyName = 'sunny' | 'overcast' | 'dusk' | 'night';

/**
 * The photos fetched when first needed (web/public/env/, credited in docs/CREDITS.md): 1024 pixels across, about a
 * megabyte each. `gain`: their light as stored is a well exposed photo; the night is far darker than that.
 */
const SKIES: Record<Exclude<SkyName, 'sunny'>, { url: string; gain: number }> = {
  overcast: { url: '/env/overcast_1k.hdr', gain: 1 },
  dusk: { url: '/env/dusk_1k.hdr', gain: 1 },
  night: { url: '/env/night_1k.hdr', gain: 0.1 },
};

/** Radians: how high the sun stands at dusk (low, for long shadows; not lower, or the shadow map smears). */
const DUSK_SUN = (15 * Math.PI) / 180;

/** The numbers of a mood, all blended between two (`sky` aside). */
interface Look {
  sky: SkyName;
  /** The sky photo's light and look, times this (the rain's darker clouds) */
  skyGain: number;
  /** The sun (or the moon): strength and colour; at 0 its shadow map is not drawn */
  sun: number;
  sunColor: THREE.Color;
  /** The hemisphere light outside: from above, from below, strength as a factor of the sunny day's */
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemi: number;
  /** Indoors' fill light as a factor of the sunny day's (at night the rooms' own lamps) */
  inside: number;
  /** The eyes' brightness as a factor of the sunny day's (main.ts eye adaptation) */
  exposure: number;
  /** The haze: density (FogExp2), and its colour (the sky's horizon) times this */
  fog: number;
  fogTint: THREE.Color;
  /** How far the painted tree line on the horizon fades into the haze's colour (0: as painted) */
  horizonFade: number;
  /** How much of the bake's contrast stays (1 all; world/bakedLight.ts) */
  contrast: number;
  /** 0 to 1: wet ground, rain falling, night (street lamps on, birds asleep), overcast, snow falling */
  wet: number;
  rain: number;
  night: number;
  overcast: number;
  snow: number;
  /** 0 to 1: from the noon sun's height down to dusk's (DUSK_SUN), on the same compass side */
  sunLow: number;
}

const look = (sky: SkyName, n: Omit<Look, 'sky' | 'sunColor' | 'hemiSky' | 'hemiGround' | 'fogTint'>, c: [string, string, string, string]): Look => ({
  sky,
  ...n,
  sunColor: new THREE.Color(c[0]),
  hemiSky: new THREE.Color(c[1]),
  hemiGround: new THREE.Color(c[2]),
  fogTint: new THREE.Color(c[3]),
});

/** The moods' numbers. A new mood is a line here, its name in shared/moods.mjs and src/i18n.ts. */
const LOOKS: Record<Mood, Look> = {
  sunny: look('sunny', { skyGain: 1, sun: 3.2, hemi: 1, inside: 1, exposure: 1, fog: 0.0019, horizonFade: 0, contrast: 1, wet: 0, rain: 0, night: 0, overcast: 0, snow: 0, sunLow: 0 }, ['#fff1de', '#dfe9f5', '#b9a487', '#ffffff']),
  overcast: look('overcast', { skyGain: 1, sun: 0, hemi: 1, inside: 0.85, exposure: 1.15, fog: 0.0032, horizonFade: 0.55, contrast: 0.6, wet: 0, rain: 0, night: 0, overcast: 1, snow: 0, sunLow: 0 }, ['#ffffff', '#d6dce4', '#8c897f', '#ffffff']),
  rain: look('overcast', { skyGain: 0.62, sun: 0, hemi: 0.8, inside: 0.8, exposure: 1.4, fog: 0.007, horizonFade: 0.9, contrast: 0.55, wet: 1, rain: 1, night: 0, overcast: 1, snow: 0, sunLow: 0 }, ['#ffffff', '#b9c0ca', '#6f6c66', '#e4e9ee']),
  // Dusk is worked out each frame between its golden start and its blue end (DUSK below).
  dusk: look('dusk', { skyGain: 1, sun: 0, hemi: 1, inside: 1, exposure: 1, fog: 0, horizonFade: 0, contrast: 1, wet: 0, rain: 0, night: 0, overcast: 0, snow: 0, sunLow: 1 }, ['#fff', '#fff', '#fff', '#fff']),
  night: look('night', { skyGain: 1, sun: 0.42, hemi: 0.45, inside: 0.7, exposure: 2.0, fog: 0.003, horizonFade: 0.85, contrast: 0.8, wet: 0, rain: 0, night: 1, overcast: 0, snow: 0, sunLow: 0 }, ['#a9bdff', '#33415e', '#1d1c22', '#ffffff']),
  snow: look('overcast', { skyGain: 0.82, sun: 0, hemi: 1, inside: 0.85, exposure: 1.05, fog: 0.0065, horizonFade: 0.9, contrast: 0.55, wet: 0, rain: 0, night: 0, overcast: 1, snow: 1, sunLow: 0 }, ['#ffffff', '#dde3ec', '#9a9ca2', '#eef2f8']),
};

/**
 * Dusk, golden hour (0) into blue hour (1): the sun low and warm, then reddening and fading, the sky darker and bluer,
 * the lamps and windows coming on. On Auto it darkens through its time (the cycle's `progress`) and then blends into
 * the night; picked by hand it holds a little way in.
 */
const DUSK = [
  look('dusk', { skyGain: 0.9, sun: 2.0, hemi: 0.6, inside: 0.9, exposure: 0.95, fog: 0.0022, horizonFade: 0.55, contrast: 0.95, wet: 0, rain: 0, night: 0.1, overcast: 0, snow: 0, sunLow: 1 }, ['#ffa45e', '#a9b5da', '#7d634f', '#f2c4a2']),
  look('dusk', { skyGain: 0.42, sun: 0.55, hemi: 0.6, inside: 0.75, exposure: 2.0, fog: 0.0032, horizonFade: 0.8, contrast: 0.8, wet: 0, rain: 0, night: 0.6, overcast: 0, snow: 0, sunLow: 1 }, ['#ff8a5c', '#6c7cae', '#3b3640', '#d9ddff']),
] as const;
/** How far into dusk a dusk picked by hand holds. */
const DUSK_HELD = 0.25;
const NUMBERS = ['skyGain', 'sun', 'hemi', 'inside', 'exposure', 'fog', 'horizonFade', 'contrast', 'wet', 'rain', 'night', 'overcast', 'snow', 'sunLow'] as const;
const COLOURS = ['sunColor', 'hemiSky', 'hemiGround', 'fogTint'] as const;

/** `out` = a blended k of the way from a to b. */
function blendLook(out: Look, a: Look, b: Look, k: number): Look {
  for (const n of NUMBERS) out[n] = a[n] + (b[n] - a[n]) * k;
  for (const c of COLOURS) out[c].lerpColors(a[c], b[c], k);
  return out;
}

/** The painted tree line's mean colour (world/horizon.ts), linear: what the fade divides by. */
const HORIZON_MEAN = new THREE.Color(0.2, 0.25, 0.21);

/** Streaks of rain per graphics preset; phones take Low's. */
const RAIN_COUNT: Record<string, number> = { low: 2500, medium: 5000, high: 7000, ultra: 9000 };
/** Snowflakes per graphics preset; phones take Low's. */
const SNOW_COUNT: Record<string, number> = { low: 1500, medium: 3000, high: 4500, ultra: 6000 };
/** Milliseconds (a time constant) for snow picked by hand to build up, and for any snow to melt once it stops falling. */
const SNOW_BUILD = 50_000;
const SNOW_MELT = 300_000;
/** The light bounced off snow lying (the hemisphere light's lower half). */
const SNOW_GROUND = new THREE.Color('#c4c8d0');

/** Milliseconds a mood picked by hand (or the admin's for everyone, or joining) takes to blend in. */
const PICK_MS = 8000;

/** Two moods and how far from the first to the second (0 to 1). */
interface Pair {
  a: Mood;
  b: Mood;
  k: number;
}

export class Weather {
  readonly rain = new Rain();
  readonly snowfall = new Snow();
  readonly lamps: StreetLights;
  /** The player's own choice (the settings) and its cycle (snow in it only in winter, by this page's date), the server's (together, the admin's) and its */
  private solo: Choice = DEFAULT_CHOICE;
  private soloCycle: Cycle = newCycle(Math.floor(Math.random() * 2 ** 32), Date.now(), winterAt(Date.now()));
  private soloRun = runOf(this.soloCycle);
  private server: Choice | null = null;
  private serverCycle: Cycle | null = null;
  private serverRun: MoodCycle | null = null;
  /** The server's clock minus this page's (ms), from its last message */
  private serverOffset = 0;
  /** The dev build's fast-forward (ms added to the cycle's clock) */
  private ahead = 0;
  private skies = new Map<SkyName, Promise<SkyLook>>();
  private loaded = new Map<SkyName, SkyLook>();
  /** The pair shown last frame, and a hand-picked change blending in from it (`t0` null: waiting for its sky) */
  private shown: Pair = { a: DEFAULT_MOOD, b: DEFAULT_MOOD, k: 0 };
  private fade: { from: Pair; t0: number | null } | null = null;
  private wet = 0;
  /** The snow lying, 0 to 1, and the dev build's fast-forward still to be taken by it (ms) */
  private lying = 0;
  private skipLying = 0;
  /** Where the sun stands: the noon sun's direction (from the sky photo, as the bakes have it) and dusk's, low, on the same side */
  private noonDir = new THREE.Vector3();
  private duskDir = new THREE.Vector3();
  private sunDir = new THREE.Vector3();
  private now: Look = blendLook(look('sunny', { ...LOOKS.sunny }, ['#fff', '#fff', '#fff', '#fff']), LOOKS.sunny, LOOKS.sunny, 0);
  private tmp: Look = blendLook(look('sunny', { ...LOOKS.sunny }, ['#fff', '#fff', '#fff', '#fff']), LOOKS.sunny, LOOKS.sunny, 0);
  private haze = new THREE.Color();
  private hazeB = new THREE.Color();
  private shadowOn = true;
  /** The painted tree line on the horizon (world/horizon.ts), tinted towards the haze */
  horizon: THREE.Mesh | null = null;
  /** Called when the server's choice changes (null: playing alone) */
  onServer: (m: Choice | null) => void = () => {};

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private sun: THREE.DirectionalLight,
    private indoorLight: IndoorLight,
    private ready: Promise<void>,
    poles: ConstructorParameters<typeof StreetLights>[0],
    ground: number,
  ) {
    this.lamps = new StreetLights(poles, ground);
    scene.add(this.rain.mesh, this.snowfall.mesh, this.lamps.group);
    // The sunny sky is the one loaded at the start.
    this.skies.set('sunny', ready.then(() => environment.sunny!));
    void ready.then(() => {
      this.loaded.set('sunny', environment.sunny!);
      const d = environment.sunDir!;
      this.noonDir.copy(d).normalize();
      const across = Math.hypot(d.x, d.z) || 1;
      this.duskDir.set((d.x / across) * Math.cos(DUSK_SUN), Math.sin(DUSK_SUN), (d.z / across) * Math.cos(DUSK_SUN));
    });
  }

  /** The eyes' brightness for the mood shown, as a factor (main.ts multiplies its eye adaptation by it). */
  get exposure(): number {
    return this.now.exposure;
  }

  /** The choice that holds: the server's when playing together, else the player's own. */
  get chosen(): Choice {
    return this.server ?? this.solo;
  }

  /** The mood that shows most now. */
  get shownMood(): Mood {
    return this.shown.k < 0.5 ? this.shown.a : this.shown.b;
  }

  /** The admin's choice for everyone, or null when playing alone. */
  get serverMood(): Choice | null {
    return this.server;
  }

  /** The cycle's pace together (1, 10 or 60), for the admin's picker. */
  get serverSpeed(): number {
    return this.serverCycle?.speed ?? 1;
  }

  /** The player's own choice (the settings). */
  setSolo(c: unknown): void {
    const next = isChoice(c) ? c : DEFAULT_CHOICE;
    if (next === this.solo) return; // another setting changed
    this.solo = next;
    if (this.server === null) this.picked();
  }

  /**
   * The server's choice and cycle (the welcome, or the admin changed something), or null when playing alone again.
   * Anything that is not a choice from the list (an older server sends none) counts as the default; a cycle that is
   * not one keeps the last.
   */
  setServer(c: unknown, cycle?: unknown, time?: unknown): void {
    const next = c === null ? null : isChoice(c) ? c : DEFAULT_CHOICE;
    if (isCycle(cycle) && typeof time === 'number' && Number.isFinite(time)) {
      if (!sameRun(cycle, this.serverCycle)) this.serverRun = runOf(cycle);
      this.serverCycle = { ...cycle };
      this.serverOffset = time - Date.now();
    }
    if (next === null) this.serverCycle = this.serverRun = null;
    const changed = next !== this.server;
    this.server = next;
    if (changed) {
      this.onServer(next);
      this.picked();
    }
  }

  /**
   * "Next weather" alone: on Auto, the mood shown ends now and the usual blend into the next begins. Together it
   * is the admin's (a message to the server, main.ts). False when there is nothing to skip.
   */
  skip(): boolean {
    if (this.server !== null || this.solo !== 'auto') return false;
    const next = skipCycle(this.soloCycle, this.soloRun, Date.now() + this.ahead);
    if (!next) return false;
    this.soloCycle = next;
    return true;
  }

  /** Dev build: move the cycle's clock on by `seconds` (only this page; window.briel.weatherAhead). */
  forward(seconds: number): void {
    this.ahead += seconds * 1000;
    this.skipLying += seconds * 1000; // snow picked by hand builds up (or melts) as far on
  }

  /** Dev build: where the cycle is (window.briel.weatherState). */
  state(): Record<string, unknown> {
    const run = this.cycleNow();
    const together = this.server !== null && this.serverCycle;
    const tau = together ? cycleTime(this.serverCycle!, Date.now() + this.ahead + this.serverOffset) : cycleTime(this.soloCycle, Date.now() + this.ahead);
    const winter = together ? !!this.serverCycle!.winter : !!this.soloCycle.winter;
    return {
      chosen: this.chosen, shown: this.shown, fade: this.fade, wet: this.wet, snow: this.lying, cycle: run, tau, winter,
      speed: this.server === null ? this.soloCycle.speed : this.serverSpeed,
    };
  }

  /** The graphics preset: how many streaks of rain and flakes of snow. */
  setQuality(quality: string, phone: boolean): void {
    this.rain.setCount(RAIN_COUNT[phone ? 'low' : quality] ?? RAIN_COUNT.medium);
    this.snowfall.setCount(SNOW_COUNT[phone ? 'low' : quality] ?? SNOW_COUNT.medium);
  }

  /** The cycle at this moment: alone the page's, together the server's on the server's clock. */
  private cycleNow(): ReturnType<MoodCycle['at']> {
    const together = this.server !== null && this.serverCycle && this.serverRun;
    const now = Date.now() + this.ahead + (together ? this.serverOffset : 0);
    return together ? this.serverRun!.at(cycleTime(this.serverCycle!, now)) : this.soloRun.at(cycleTime(this.soloCycle, now));
  }

  /** The choice changed by hand (or the server's came): blend in from what shows now, once the new sky is in. */
  private picked(): void {
    this.fade = { from: { ...this.shown }, t0: null };
  }

  /** A sky photo, fetched the first time; null until it is in. A failed fetch is forgotten, to be tried again. */
  private sky(name: SkyName): SkyLook | null {
    const have = this.loaded.get(name);
    if (have) return have;
    if (!this.skies.has(name) && name !== 'sunny') {
      const { url, gain } = SKIES[name];
      const p = this.ready.then(() => loadSky(this.renderer, url, environment.sunDir!, gain, environment.sunny!.photo.image.width));
      this.skies.set(name, p);
      p.then(
        (s) => this.loaded.set(name, s),
        (e) => {
          console.warn(`weather: the ${name} sky did not load`, e);
          this.skies.delete(name);
        },
      );
    }
    return null;
  }

  /** Each frame: the pair of moods shown and how far, blended into every light, the rain round the eye and the lamps. */
  update(dt: number, eye: THREE.Vector3, indoors: boolean): void {
    if (!environment.sunny) return; // the sky is still loading
    const auto = this.chosen === 'auto';
    const c = auto ? this.cycleNow() : null;
    const target: Pair = c ? { a: c.mood, b: c.next, k: c.blend } : { a: this.chosen as Mood, b: this.chosen as Mood, k: 0 };
    // On Auto the next mood's sky is fetched as soon as it is known, long before its blend.
    this.sky(LOOKS[target.b].sky);
    let pair = target;
    if (this.fade) {
      const dominant = target.k < 0.5 ? target.a : target.b;
      if (this.fade.t0 === null && this.sky(LOOKS[dominant].sky) && this.sky(LOOKS[target.a].sky)) this.fade.t0 = performance.now();
      const s = this.fade.t0 === null ? 0 : Math.min(1, (performance.now() - this.fade.t0) / PICK_MS);
      const from = this.fade.from;
      const fromMood = from.k < 0.5 ? from.a : from.b;
      if (s >= 1) this.fade = null;
      else pair = { a: fromMood, b: dominant, k: s * s * (3 - 2 * s) };
    }
    // A sky that isn't in yet: the change waits at the mood that is.
    if (!this.sky(LOOKS[pair.b].sky)) pair = { a: pair.a, b: pair.a, k: 0 };
    if (!this.sky(LOOKS[pair.a].sky)) pair = { a: this.shown.a, b: this.shown.a, k: 0 };
    this.shown = pair;
    // Dusk darkens through its time on Auto (blending in, it starts golden); picked by hand it holds.
    const depth = c && !this.fade ? (c.mood === 'dusk' ? c.progress : 0) : DUSK_HELD;
    blendLook(LOOKS.dusk, DUSK[0], DUSK[1], depth * depth * (3 - 2 * depth));
    this.apply(pair);

    // Wet: on Auto as the cycle has it (the same on every page); else towards the mood's, quickly up, slowly dry.
    const want = blendLook(this.tmp, LOOKS[pair.a], LOOKS[pair.b], pair.k).wet;
    if (c && !this.fade) this.wet = c.wet;
    else this.wet += (want - this.wet) * (1 - Math.exp(-(dt * 1000) / (want > this.wet ? 3000 : DRY_MS)));
    bakeMood.value.w = this.wet;
    groundWet.value = this.wet;

    // Snow lying: on Auto as the cycle has it (turning to Auto, towards it within the pick's blend); else building
    // up slowly while it falls, melting slowly after.
    const falling = this.now.snow;
    const ms = dt * 1000 + this.skipLying;
    if (c && !this.fade) this.lying = c.snow;
    else if (c) this.lying += (c.snow - this.lying) * (1 - Math.exp(-ms / (PICK_MS / 3)));
    else {
      const up = falling > this.lying;
      this.lying += (falling - this.lying) * (1 - Math.exp(-ms / (up ? SNOW_BUILD : SNOW_MELT)));
      if (this.lying < 0.002 && !falling) this.lying = 0;
    }
    this.skipLying = 0;
    snowCover.value = this.lying;

    this.rain.set(this.now.rain);
    this.rain.update(dt, eye, indoors, this.now.skyGain * 1.1);
    this.snowfall.set(falling);
    this.snowfall.update(dt, eye, indoors, this.now.skyGain * 1.4, this.renderer);
    this.lamps.set(this.now.night);
    this.lamps.update();
    // Its shadow map is not drawn under clouds, but one must exist: a new graphics preset throws the old one away
    // (main.ts applyQuality), and without one every surface that takes the shadow draws nothing. Drawn once then.
    if (!this.sun.shadow.autoUpdate && !this.sun.shadow.map) this.sun.shadow.needsUpdate = this.renderer.shadowMap.needsUpdate = true;
    moodShown({
      current: this.shownMood, next: pair.b, blend: pair.k, night: this.now.night, wet: this.wet, overcast: this.now.overcast,
      snowing: falling, snow: this.lying, auto, byAdmin: this.server !== null,
    });
  }

  /** The pair of moods into the lights, the sky, the haze and the bakes. */
  private apply(p: Pair): void {
    const la = LOOKS[p.a];
    const lb = LOOKS[p.b];
    const l = blendLook(this.now, la, lb, p.k);
    const sa = this.sky(la.sky)!;
    const sb = this.sky(lb.sky)!;
    const sunny = environment.sunny!;
    // The sky seen: the two photos crossfading. Its light: one at a time, the second's from halfway, its strength
    // that of the blend (so the swap is a change of colour and direction at most, not of brightness).
    environment.sky?.show(
      { photo: sa.photo, turn: sa.turn, sunDir: sa.bright, gain: la.skyGain },
      { photo: sb.photo, turn: sb.turn, sunDir: sb.bright, gain: lb.skyGain },
      p.k,
    );
    const lit = p.k < 0.5 ? sa : sb;
    const light = sa.irradiance * la.skyGain + (sb.irradiance * lb.skyGain - sa.irradiance * la.skyGain) * p.k;
    if (this.scene.environment !== lit.env) {
      this.scene.environment = lit.env;
      this.scene.environmentRotation.set(0, lit.turn, 0);
    }
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.haze.copy(sa.haze).multiplyScalar(la.skyGain);
      this.hazeB.copy(sb.haze).multiplyScalar(lb.skyGain);
      this.scene.fog.color.lerpColors(this.haze, this.hazeB, p.k).multiply(l.fogTint);
      this.scene.fog.density = l.fog;
      // The painted tree line far off has no haze of its own: its colour is pulled towards the haze's (a factor on
      // its picture, which may be above one under bright clouds).
      const tint = this.horizon?.material as THREE.MeshBasicMaterial | undefined;
      if (tint?.color) {
        const f = this.scene.fog.color;
        tint.color.setRGB(1 + (f.r / HORIZON_MEAN.r - 1) * l.horizonFade, 1 + (f.g / HORIZON_MEAN.g - 1) * l.horizonFade, 1 + (f.b / HORIZON_MEAN.b - 1) * l.horizonFade);
      }
    }
    // The sun, or the moon from the same side; off under clouds (and its shadow map not drawn: nothing to cast).
    this.sun.intensity = l.sun;
    this.sun.color.copy(l.sunColor);
    // At dusk low on the noon sun's side (DUSK_SUN): its shadows near the house grow long, the baked ones agree in direction.
    if (this.noonDir.lengthSq() > 0) {
      this.sunDir.copy(this.noonDir).lerp(this.duskDir, l.sunLow).normalize();
      this.sun.position.copy(this.sun.target.position).addScaledVector(this.sunDir, 60);
    }
    // Snow lying throws light back up: the hemisphere's lower half paler.
    if (this.lying > 0) l.hemiGround.lerp(SNOW_GROUND, this.lying * 0.7);
    const on = l.sun > 0.001;
    if (on !== this.shadowOn) {
      this.shadowOn = on;
      this.sun.shadow.autoUpdate = on;
      if (on) this.sun.shadow.needsUpdate = true;
    }
    this.indoorLight.setOutside(l.hemiSky, l.hemiGround, l.hemi, light / lit.irradiance, l.inside);
    // The bakes under this sky: its light against the sunny sky's, the contrast round a typical wall's light.
    bakeMood.value.x = light / sunny.irradiance;
    bakeMood.value.y = l.contrast;
    bakeMood.value.z = Math.PI * sunny.irradiance * 0.7;
  }
}
