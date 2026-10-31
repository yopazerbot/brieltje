import * as THREE from 'three';
import { PORTALS, REACH, type Portal } from '../../shared/portals.mjs';
import { sound } from '../sound';
import { onLang, portalName } from '../i18n';

/**
 * The portals round the map (shared/portals.mjs): a dark metal ring standing on a glowing pad,
 * a swirl in its colour inside, sparks rising through it and its name floating above. All of it
 * is drawn by small shaders (no textures but the name), about five draw calls a portal, and a
 * portal further than SHOWN is hidden. Shots and the door finder pass through them.
 */

const SHOWN = 330; // m: beyond this a portal isn't drawn (the haze has it by then)
const RING = 1.72; // m: the ring's radius to the middle of its tube
const TUBE = 0.13;
const SINK = 0.26; // the ring's foot stands this far into the ground
const SPARKS = 28;

const swirlShader = {
  vertexShader: /* glsl */ `
    varying vec2 vP;
    varying float vDepth;
    void main() {
      vP = position.xy / ${(RING - 0.05).toFixed(3)};
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vDepth = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    uniform float uTime;
    uniform float uFade;
    uniform float uOn;
    uniform vec3 uColor;
    varying vec2 vP;
    varying float vDepth;
    void main() {
      float r = length(vP);
      if (r > 1.0) discard;
      float a = atan(vP.y, vP.x);
      float s1 = sin(a * 3.0 + r * 9.0 - uTime * 2.2) * 0.5 + 0.5;
      float s2 = sin(a * 5.0 - r * 15.0 + uTime * 1.6) * 0.5 + 0.5;
      float s = mix(s1, s2, 0.35);
      float edge = smoothstep(1.0, 0.86, r);
      float core = smoothstep(0.6, 0.0, r);
      vec3 col = mix(uColor, vec3(1.0), core * 0.45 + s * 0.15);
      float alpha = edge * (0.16 + 0.3 * s + 0.18 * uOn) + core * 0.1;
      // Thin when the camera is in it (standing in the ring, a car's camera passing through).
      gl_FragColor = vec4(col * (0.7 + 0.5 * uOn), alpha * uFade * smoothstep(0.3, 2.5, vDepth));
    }`,
};

const padShader = {
  vertexShader: /* glsl */ `
    varying vec2 vP;
    void main() {
      vP = position.xz / ${REACH.toFixed(3)};
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform float uTime;
    uniform float uFade;
    uniform float uOn;
    uniform vec3 uColor;
    varying vec2 vP;
    void main() {
      float r = length(vP);
      float a = atan(vP.y, vP.x);
      float rim = smoothstep(0.05, 0.0, abs(r - 0.95));
      float dash = step(0.55, fract(a * 3.8197 + uTime * 0.12)) * smoothstep(0.035, 0.0, abs(r - 0.82));
      float wave = smoothstep(0.06, 0.0, abs(r - fract(uTime * 0.45))) * (1.0 - r) * 0.7;
      float fill = (1.0 - smoothstep(0.0, 0.95, r)) * 0.14;
      float alpha = (rim * 0.7 + dash * 0.5 + wave + fill) * (0.6 + 0.6 * uOn);
      gl_FragColor = vec4(uColor, min(alpha, 1.0) * uFade);
    }`,
};

const sparkShader = {
  vertexShader: /* glsl */ `
    attribute vec3 seed;
    uniform float uTime;
    uniform float uScale;
    varying float vA;
    void main() {
      float t = fract(seed.z + uTime * (0.12 + seed.y * 0.1));
      float ang = seed.x * 6.2832 + uTime * (0.4 + seed.y * 0.5);
      float rad = 0.35 + seed.y * 1.15;
      vec3 p = vec3(cos(ang) * rad, t * 3.4, sin(ang) * rad * 0.35);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      vA = sin(t * 3.14159) * smoothstep(0.4, 2.0, -mv.z);
      gl_PointSize = clamp((0.05 + seed.y * 0.06) * uScale / max(0.5, -mv.z), 1.5, 16.0);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 uColor;
    uniform float uFade;
    varying float vA;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      if (d > 0.5) discard;
      gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.5) * 1.3, (1.0 - d * 2.0) * vA * uFade);
    }`,
};

const pulseShader = {
  vertexShader: /* glsl */ `
    varying float vY;
    void main() {
      vY = uv.y;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 uColor;
    uniform float uLife;
    varying float vY;
    void main() {
      float a = (1.0 - vY) * (1.0 - uLife) * smoothstep(0.0, 0.08, uLife + 0.02);
      gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.4) * 1.2, a * 0.7);
    }`,
};

type Uniforms = { uTime: { value: number }; uFade: { value: number }; uOn: { value: number }; uColor: { value: THREE.Color } };

interface Item {
  p: Portal;
  root: THREE.Group;
  pad: THREE.Mesh;
  label: THREE.Sprite;
  uniforms: Uniforms;
  y: number;
}

/** No shots, no door finder: rays pass through. */
const noRay = (o: THREE.Object3D) => {
  o.raycast = () => {};
  o.userData.ignoreRay = true;
};

function labelTexture(p: Portal): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(12, 14, 18, 0.8)';
  g.beginPath();
  g.roundRect(8, 16, 496, 96, 48);
  g.fill();
  g.fillStyle = p.color;
  g.beginPath();
  g.arc(64, 64, 20, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#f4efe6';
  g.font = '700 54px Bahnschrift, "Arial Narrow", "Segoe UI", sans-serif';
  g.textBaseline = 'middle';
  g.fillText(portalName(p), 104, 66, 380);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class Portals {
  readonly group = new THREE.Group();
  /** The portal you stand on (its pad and swirl brighten), or null */
  active: string | null = null;
  private items: Item[] = [];
  private time = { value: 0 };
  private scale = { value: 600 };
  private pulses: { mesh: THREE.Mesh; life: { value: number } }[] = [];

  /** `ground(x, z)`: the height of the ground there (the relief, paving on it). */
  constructor(private ground: (x: number, z: number) => number) {
    const frame = new THREE.MeshStandardMaterial({ color: '#2b2e35', roughness: 0.32, metalness: 0.85 });
    const stone = new THREE.MeshStandardMaterial({ color: '#4a4c52', roughness: 0.8 });
    const ringGeo = new THREE.TorusGeometry(RING, TUBE, 10, 72);
    const glowGeo = new THREE.TorusGeometry(RING - TUBE - 0.02, 0.035, 6, 72);
    const discGeo = new THREE.CircleGeometry(RING - 0.05, 64);
    const footGeo = new THREE.BoxGeometry(0.42, 0.42, 0.62);
    const seeds = new Float32Array(SPARKS * 3);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    const sparkGeo = new THREE.BufferGeometry();
    sparkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPARKS * 3), 3));
    sparkGeo.setAttribute('seed', new THREE.BufferAttribute(seeds, 3));
    sparkGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.7, 0), 2.5);
    const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };

    for (const p of PORTALS) {
      const uniforms: Uniforms = { uTime: this.time, uFade: { value: 1 }, uOn: { value: 0 }, uColor: { value: new THREE.Color(p.color) } };
      const root = new THREE.Group();
      root.rotation.y = p.yaw;
      const ring = new THREE.Group();
      ring.position.y = RING + TUBE - SINK;
      ring.add(new THREE.Mesh(ringGeo, frame));
      const glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(p.color).multiplyScalar(1.8) });
      ring.add(new THREE.Mesh(glowGeo, glowMat));
      const disc = new THREE.Mesh(discGeo, new THREE.ShaderMaterial({ ...swirlShader, uniforms, side: THREE.DoubleSide, ...additive }));
      disc.renderOrder = 2;
      ring.add(disc);
      root.add(ring);
      for (const side of [-1, 1]) {
        const foot = new THREE.Mesh(footGeo, stone);
        foot.position.set(side * (RING * 0.72), 0.1, 0);
        root.add(foot);
      }
      const sparks = new THREE.Points(sparkGeo, new THREE.ShaderMaterial({ ...sparkShader, uniforms: { ...uniforms, uScale: this.scale }, ...additive }));
      sparks.renderOrder = 3;
      root.add(sparks);
      const pad = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({ ...padShader, uniforms, ...additive, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      pad.renderOrder = 1;
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(p), transparent: true, depthWrite: false }));
      label.center.set(0.5, 0);
      label.renderOrder = 4;
      root.traverse(noRay);
      noRay(pad);
      noRay(label);
      for (const o of [root, pad, label]) this.group.add(o);
      this.items.push({ p, root, pad, label, uniforms, y: 0 });
    }
    this.settle();
    // Another language: the names above the portals drawn again.
    onLang(() => {
      for (const it of this.items) {
        const old = it.label.material.map;
        it.label.material.map = labelTexture(it.p);
        it.label.material.needsUpdate = true;
        old?.dispose();
      }
    });
  }

  /** Stand each portal on the ground, its pad following the ground's slope (again once the village is in). */
  settle(): void {
    for (const it of this.items) {
      const { x, z } = it.p;
      it.y = this.ground(x, z);
      it.root.position.set(x, it.y, z);
      it.label.position.set(x, it.y + 2 * RING + 0.6, z);
      const disc = new THREE.CircleGeometry(REACH, 48);
      disc.rotateX(-Math.PI / 2);
      const pos = disc.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) pos.setY(i, this.ground(x + pos.getX(i), z + pos.getZ(i)) - it.y + 0.04);
      disc.computeBoundingSphere();
      it.pad.geometry.dispose();
      it.pad.geometry = disc;
      it.pad.position.set(x, it.y, z);
    }
  }

  /** The height a portal stands at. */
  groundOf(p: Portal): number {
    return this.items.find((it) => it.p === p)?.y ?? this.ground(p.x, p.z);
  }

  update(dt: number, camera: THREE.PerspectiveCamera, viewHeight: number): void {
    this.time.value += dt;
    this.scale.value = viewHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
    for (const it of this.items) {
      const d = Math.hypot(camera.position.x - it.p.x, camera.position.z - it.p.z);
      const shown = d < SHOWN;
      it.root.visible = it.pad.visible = it.label.visible = shown;
      if (!shown) continue;
      it.uniforms.uFade.value = 1 - THREE.MathUtils.smoothstep(d, SHOWN * 0.55, SHOWN);
      const on = this.active === it.p.id ? 1 : 0;
      it.uniforms.uOn.value += (on - it.uniforms.uOn.value) * (1 - Math.exp(-dt * 6));
      // The name stays readable from afar: it grows with the distance beyond 25 m.
      const k = Math.min(6, Math.max(1, d / 25));
      it.label.scale.set(2.9 * k, 0.725 * k, 1);
      (it.label.material as THREE.SpriteMaterial).opacity = it.uniforms.uFade.value;
    }
    for (const p of this.pulses) {
      if (!p.mesh.visible) continue;
      p.life.value += dt / 0.9;
      p.mesh.scale.setScalar(1 + p.life.value * 0.8);
      p.mesh.scale.y = 1;
      if (p.life.value >= 1) p.mesh.visible = false;
    }
  }

  /** A column of light where someone leaves or arrives. Its sound: `here` your own trip, `there` from that spot, false none. */
  pulse(x: number, y: number, z: number, color: string, hear: 'here' | 'there' | false): void {
    let p = this.pulses.find((q) => !q.mesh.visible);
    if (!p) {
      const life = { value: 1 };
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.8, 0.8, 4.5, 24, 1, true).translate(0, 2.25, 0),
        new THREE.ShaderMaterial({ ...pulseShader, uniforms: { uColor: { value: new THREE.Color() }, uLife: life }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
      );
      noRay(mesh);
      this.group.add(mesh);
      p = { mesh, life };
      this.pulses.push(p);
    }
    p.life.value = 0;
    p.mesh.position.set(x, y, z);
    p.mesh.visible = true;
    ((p.mesh.material as THREE.ShaderMaterial).uniforms.uColor.value as THREE.Color).set(color);
    if (hear) whoosh(hear === 'here' ? sound.out() : sound.at(x, y + 1.2, z, 4));
  }
}

/** A rising whoosh: noise swept up through a band filter, and a tone gliding up an octave and a half. */
function whoosh(out: AudioNode | null): void {
  const c = sound.context();
  if (!c || !out) return;
  const t = c.currentTime;
  const len = 0.9;
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * len), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const noise = c.createBufferSource();
  noise.buffer = buf;
  const band = c.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = 3;
  band.frequency.setValueAtTime(260, t);
  band.frequency.exponentialRampToValueAtTime(2600, t + 0.45);
  band.frequency.exponentialRampToValueAtTime(900, t + len);
  const ng = c.createGain();
  ng.gain.setValueAtTime(0.0001, t);
  ng.gain.exponentialRampToValueAtTime(0.5, t + 0.2);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + len);
  noise.connect(band).connect(ng).connect(out);
  const tone = c.createOscillator();
  tone.type = 'sine';
  tone.frequency.setValueAtTime(220, t);
  tone.frequency.exponentialRampToValueAtTime(660, t + 0.5);
  const tg = c.createGain();
  tg.gain.setValueAtTime(0.0001, t);
  tg.gain.exponentialRampToValueAtTime(0.12, t + 0.15);
  tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
  tone.connect(tg).connect(out);
  noise.start(t);
  noise.stop(t + len);
  tone.start(t);
  tone.stop(t + 0.75);
}
