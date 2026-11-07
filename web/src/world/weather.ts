import * as THREE from 'three';
import { DEFAULT_MOOD, isMood, MOODS, type Mood } from '../../shared/moods.mjs';
import { bakeMood } from './bakedLight';
import { environment, loadSky, type SkyLook } from './environment';
import { groundWet } from './groundShade';
import type { IndoorLight } from './indoorLight';
import { moodChanged } from './mood';
import { Rain } from './rain';
import { StreetLights } from './streetLights';

/**
 * The weather and the time of day: sunny (as it always was), overcast, rain and night (shared/moods.mjs). Alone each
 * player picks one in their settings (src/settings.ts); together the admin picks it for everyone, and the server's
 * choice holds (setServer).
 *
 * A mood is a set of numbers (LOOKS) and a sky photo: the sunny one from the start (world/environment.ts), the
 * overcast and the night ones (Poly Haven, CC0) fetched only when a mood that needs them is first chosen. Changing
 * mood changes only uniforms, lights' strengths and textures of the same size: no shader of the world compiles again,
 * so it costs no stall. The sun stays where it is: under clouds its light is off (its shadow map is no longer drawn),
 * at night it is the moon, from the same side, so the baked shadows (world/bakedLight.ts, world/groundShade.ts) still
 * agree with it. The baked sky light is scaled to the new sky and its contrast pressed together (bakeMood).
 *
 * The rain (world/rain.ts) falls round the eye and makes the ground wet (groundWet: darker, the paving and roads
 * shiny); at night the street lamps glow (world/streetLights.ts). Others read the mood shown from world/mood.ts
 * (lit windows, birdsong), which has no graphics in it.
 */

export { MOODS, type Mood };
export { mood, onMoodChange, type MoodState } from './mood';

/** Which photo a mood's sky is. */
type SkyName = 'sunny' | 'overcast' | 'night';

/**
 * The photos fetched when first needed (web/public/env/, credited in docs/CREDITS.md): 1024 pixels across, about a
 * megabyte each. `gain`: their light as stored is a well exposed photo; the night is far darker than that.
 */
const SKIES: Record<Exclude<SkyName, 'sunny'>, { url: string; gain: number }> = {
  overcast: { url: '/env/overcast_1k.hdr', gain: 1 },
  night: { url: '/env/night_1k.hdr', gain: 0.1 },
};

interface Look {
  sky: SkyName;
  /** The sky photo's light and look, times this (the rain's darker clouds) */
  skyGain: number;
  /** The sun (or the moon): strength and colour; 0 turns its shadow map off too */
  sun: number;
  sunColor: string;
  /** The hemisphere light outside: from above, from below, strength as a factor of the sunny day's */
  hemiSky: string;
  hemiGround: string;
  hemi: number;
  /** Indoors' fill light as a factor of the sunny day's (at night the rooms' own lamps) */
  inside: number;
  /** The eyes' brightness as a factor of the sunny day's (main.ts eye adaptation) */
  exposure: number;
  /** The haze: density (FogExp2), and its colour (the sky's horizon) times this */
  fog: number;
  fogTint: string;
  /** How far the painted tree line on the horizon fades into the haze's colour (0: as painted) */
  horizonFade: number;
  /** How much of the bake's contrast stays (1 all; world/bakedLight.ts) */
  contrast: number;
  /** 0 to 1: wet ground, rain falling, night (street lamps on, birds asleep), overcast */
  wet: number;
  rain: number;
  night: number;
  overcast: number;
}

/** The moods' numbers. A new mood (dusk, snow) is a line here, its name in shared/moods.mjs and src/i18n.ts. */
const LOOKS: Record<Mood, Look> = {
  sunny: { sky: 'sunny', skyGain: 1, sun: 3.2, sunColor: '#fff1de', hemiSky: '#dfe9f5', hemiGround: '#b9a487', hemi: 1, inside: 1, exposure: 1, fog: 0.0019, fogTint: '#ffffff', horizonFade: 0, contrast: 1, wet: 0, rain: 0, night: 0, overcast: 0 },
  overcast: { sky: 'overcast', skyGain: 1, sun: 0, sunColor: '#ffffff', hemiSky: '#d6dce4', hemiGround: '#8c897f', hemi: 1, inside: 0.85, exposure: 1.15, fog: 0.0032, fogTint: '#ffffff', horizonFade: 0.55, contrast: 0.6, wet: 0, rain: 0, night: 0, overcast: 1 },
  rain: { sky: 'overcast', skyGain: 0.62, sun: 0, sunColor: '#ffffff', hemiSky: '#b9c0ca', hemiGround: '#6f6c66', hemi: 0.8, inside: 0.8, exposure: 1.4, fog: 0.007, fogTint: '#e4e9ee', horizonFade: 0.9, contrast: 0.55, wet: 1, rain: 1, night: 0, overcast: 1 },
  night: { sky: 'night', skyGain: 1, sun: 0.42, sunColor: '#a9bdff', hemiSky: '#33415e', hemiGround: '#1d1c22', hemi: 0.45, inside: 0.7, exposure: 2.0, fog: 0.003, fogTint: '#ffffff', horizonFade: 0.85, contrast: 0.8, wet: 0, rain: 0, night: 1, overcast: 0 },
};

/** The painted tree line's mean colour (world/surroundings.ts buildHorizon), linear: what the fade divides by. */
const HORIZON_MEAN = new THREE.Color(0.2, 0.25, 0.21);

/** Streaks of rain per graphics preset; phones take Low's. */
const RAIN_COUNT: Record<string, number> = { low: 2500, medium: 5000, high: 7000, ultra: 9000 };

export class Weather {
  readonly rain = new Rain();
  readonly lamps: StreetLights;
  /** The player's own pick (the settings) and the server's (together, the admin's), which wins */
  private solo: Mood = DEFAULT_MOOD;
  private server: Mood | null = null;
  private shown: Mood = DEFAULT_MOOD;
  private skies = new Map<SkyName, Promise<SkyLook>>();
  private exposureNow = 1;
  /** The painted tree line on the horizon (world/surroundings.ts buildHorizon), tinted towards the haze */
  horizon: THREE.Mesh | null = null;
  /** Called when the server's choice changes (null: playing alone) */
  onServer: (m: Mood | null) => void = () => {};

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
    scene.add(this.rain.mesh, this.lamps.group);
    // The sunny sky is the one loaded at the start.
    this.skies.set('sunny', ready.then(() => environment.sunny!));
  }

  /** The eyes' brightness for the mood shown, as a factor (main.ts multiplies its eye adaptation by it). */
  get exposure(): number {
    return this.exposureNow;
  }

  /** The mood chosen: the server's when playing together, else the player's own. */
  get chosen(): Mood {
    return this.server ?? this.solo;
  }

  /** The mood shown now (its sky in): the one chosen, or the one before while the chosen one's sky loads. */
  get shownMood(): Mood {
    return this.shown;
  }

  /** The admin's choice for everyone, or null when playing alone. */
  get serverMood(): Mood | null {
    return this.server;
  }

  /** The player's own pick (the settings). */
  setSolo(m: unknown): void {
    const next = isMood(m) ? m : DEFAULT_MOOD;
    if (next === this.solo) return; // another setting changed
    this.solo = next;
    void this.apply();
  }

  /**
   * The server's mood (the welcome, or the admin changed it), or null when playing alone again. Anything that is
   * not a mood from the list (an older server sends none) counts as the default.
   */
  setServer(m: unknown): void {
    const next = m === null ? null : isMood(m) ? m : DEFAULT_MOOD;
    if (next === this.server) return;
    this.server = next;
    this.onServer(next);
    void this.apply();
  }

  /** The graphics preset: how many streaks of rain. */
  setQuality(quality: string, phone: boolean): void {
    this.rain.setCount(RAIN_COUNT[phone ? 'low' : quality] ?? RAIN_COUNT.medium);
  }

  /** Each frame: the rain round the eye (none indoors) and the street lamps. */
  update(dt: number, eye: THREE.Vector3, indoors: boolean): void {
    const look = LOOKS[this.shown];
    this.rain.update(dt, eye, indoors, look.skyGain * 1.1);
    this.lamps.update();
    // Its shadow map is not drawn under clouds, but one must exist: a new graphics preset throws the old one away
    // (main.ts applyQuality), and without one every surface that takes the shadow draws nothing. Drawn once then.
    if (!this.sun.shadow.autoUpdate && !this.sun.shadow.map) this.sun.shadow.needsUpdate = this.renderer.shadowMap.needsUpdate = true;
  }

  /** The sky photo of a mood, fetched the first time. A failed fetch is forgotten, to be tried again next time. */
  private sky(name: SkyName): Promise<SkyLook> {
    let p = this.skies.get(name);
    if (!p) {
      const { url, gain } = SKIES[name as Exclude<SkyName, 'sunny'>];
      p = this.ready.then(() => loadSky(this.renderer, url, environment.sunDir!, gain, environment.sunny!.photo.image.width));
      this.skies.set(name, p);
      p.catch(() => this.skies.delete(name));
    }
    return p;
  }

  private async apply(): Promise<void> {
    const want = this.chosen;
    let look: SkyLook;
    try {
      look = await this.sky(LOOKS[want].sky);
    } catch (e) {
      console.warn(`weather: the ${want} sky did not load`, e);
      return;
    }
    if (this.chosen !== want) return; // chosen again meanwhile: that one is on its way
    this.show(want, look);
  }

  private show(name: Mood, sky: SkyLook): void {
    const was = this.shown;
    const l = LOOKS[name];
    const sunny = environment.sunny!;
    // The sky seen and its light; its haze.
    environment.sky?.show(sky.photo, sky.turn, sky.bright, l.skyGain);
    this.scene.environment = sky.env;
    this.scene.environmentRotation.set(0, sky.turn, 0);
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.copy(sky.haze).multiplyScalar(l.skyGain).multiply(new THREE.Color(l.fogTint));
      this.scene.fog.density = l.fog;
      // The painted tree line far off has no haze of its own: its colour is pulled towards the haze's (a factor on
      // its picture, which may be above one under bright clouds).
      const tint = this.horizon?.material as THREE.MeshBasicMaterial | undefined;
      if (tint?.color) {
        const f = this.scene.fog.color;
        const toward = new THREE.Color(f.r / HORIZON_MEAN.r, f.g / HORIZON_MEAN.g, f.b / HORIZON_MEAN.b);
        tint.color.setRGB(1, 1, 1).lerp(toward, l.horizonFade);
      }
    }
    // The sun, or the moon from the same side; off under clouds (and its shadow map not drawn: nothing to cast).
    this.sun.intensity = l.sun;
    this.sun.color.set(l.sunColor);
    this.sun.shadow.autoUpdate = l.sun > 0;
    if (l.sun > 0) this.sun.shadow.needsUpdate = true;
    this.indoorLight.setOutside(new THREE.Color(l.hemiSky), new THREE.Color(l.hemiGround), l.hemi, l.skyGain, l.inside);
    this.exposureNow = l.exposure;
    // The bakes under this sky: its light against the sunny sky's, the contrast round a typical wall's light.
    bakeMood.value.set((sky.irradiance * l.skyGain) / sunny.irradiance, l.contrast, Math.PI * sunny.irradiance * 0.7, l.wet);
    groundWet.value = l.wet;
    this.rain.set(l.rain);
    this.lamps.set(l.night);
    this.shown = name;
    // A sky no mood shows now is let go (the sunny one stays): fetched again if chosen again.
    const old = LOOKS[was].sky;
    if (old !== 'sunny' && old !== l.sky) {
      const p = this.skies.get(old);
      this.skies.delete(old);
      void p?.then((s) => {
        s.photo.dispose();
        s.env.dispose();
      });
    }
    moodChanged({ current: name, night: l.night, wet: l.wet, overcast: l.overcast, byAdmin: this.server !== null });
  }
}
