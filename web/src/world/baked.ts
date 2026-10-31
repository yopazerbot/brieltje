import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Baked lighting (Blender Cycles, tools/bake/): the sun, the sky and the light
 * bouncing between walls, stored in one texture for the whole house. In this
 * mode the house's own surfaces are drawn as their texture times that light,
 * without any real-time lighting: much cheaper on weak graphics, and rooms get
 * a soft bounced light. Outside surfaces (street,
 * paving, hedges, neighbours), glass, doors, furniture and people keep
 * real-time light. Used when "Baked lighting (test)" is switched on in the settings.
 */
export class Baked {
  readonly group = new THREE.Group();
  ready = false;
  private enabled = false;
  private loading: Promise<boolean> | null = null;
  private replaced: THREE.Object3D[] = [];

  constructor(private built: THREE.Group) {
    this.group.visible = false;
  }

  private async load(): Promise<boolean> {
    try {
      const [cfg, gltf, lightMap] = await Promise.all([
        fetch('/baked/bake.json').then((r) => r.json() as Promise<{ scale: number }>),
        new GLTFLoader().loadAsync('/baked/house_baked.glb'),
        new THREE.TextureLoader().loadAsync('/baked/lightmap.webp'),
      ]);
      lightMap.colorSpace = THREE.SRGBColorSpace;
      lightMap.flipY = false; // glTF texture convention
      lightMap.channel = 1; // the second UV map ("Lightmap")
      const live = new Map(this.built.children.filter((c) => c.userData.glassIndex === undefined).map((c) => [c.userData.material as string, c as THREE.Mesh]));
      gltf.scene.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const key = (o.material as THREE.Material).name || o.name;
        const twin = live.get(key);
        const src = twin?.material as THREE.MeshStandardMaterial | undefined;
        o.material = new THREE.MeshBasicMaterial({
          map: src?.map ?? null,
          color: src?.color ?? new THREE.Color('#cccccc'),
          lightMap,
          lightMapIntensity: cfg.scale * Math.PI, // three.js divides a basic material's light map by pi
          side: THREE.DoubleSide, // like the real-time house: never a hole where a face points the other way
        });
        // The texture holds the square root of the light (more steps for dark rooms): square it back.
        (o.material as THREE.Material).onBeforeCompile = (shader) => {
          shader.fragmentShader = shader.fragmentShader.replace(
            'lightMapTexel.rgb * lightMapIntensity',
            'lightMapTexel.rgb * lightMapTexel.rgb * lightMapIntensity',
          );
        };
        o.userData.material = key;
        if (twin) this.replaced.push(twin);
      });
      this.group.add(gltf.scene);
      this.ready = true;
      this.setEnabled(this.enabled);
      return true;
    } catch (e) {
      console.warn('baked lighting not available', e);
      return false;
    }
  }

  /** Show the baked house instead of the real-time one (or back); downloaded (1.7 MB) the first time. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on && !this.loading) this.loading = this.load();
    const use = on && this.ready;
    this.group.visible = use;
    for (const m of this.replaced) m.visible = !use;
  }

  get active(): boolean {
    return this.enabled && this.ready;
  }
}
