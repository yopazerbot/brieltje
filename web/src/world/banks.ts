import * as THREE from 'three';
import { bankOf } from './bankShape';
import type { DipSpec } from './houseData';
import { terrain } from './terrain';
import { addWater, waterClock, waterMaterial } from './water';

/**
 * The banks and water of the ponds and ditches, drawn from their shape (world/bankShape.ts).
 *
 * The banks wear the lawn's own material (its texture, the ground's shading, the rain and the snow), with its colour
 * changed down the bank: the lawn at the rim, rougher and yellower grass on the bank, a band of dark, glossy wet mud
 * from about 15 cm over the water down to it, and an olive-brown silt bed under it. The band's edges wander with the
 * ground's soft noise (world/groundNoise.ts, as the lawn's meadow patches read it), and the mud and silt take their
 * grain from the lawn texture's light and dark. Grass blades grow on the bank as on the lawn (world/grassTufts.ts),
 * thinning out on the mud and none under the water.
 *
 * The water lies on the same points as the banks (only where it covers a corner), each with the water's depth there,
 * so its edge is exactly where the bank comes out of it (world/water.ts colours and clears it by that depth).
 */

let bankMat: THREE.MeshStandardMaterial | null = null;

/** The lawn's material with the banks' colours: one for all banks, its program apart from the lawn's. */
function bankMaterial(lawn: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  if (bankMat) return bankMat;
  const m = lawn.clone();
  m.name = 'bank';
  m.onBeforeCompile = (shader, renderer) => {
    lawn.onBeforeCompile(shader, renderer); // the lawn's own patches, as they are when this compiles
    // No texture of its own: the lawn's shader has nearly all the units a chip gives (16). Its patches' soft noise
    // (world/meadowLook.ts, the ground's noise tile) serves the banks too, when it is there.
    const noise = shader.fragmentShader.includes('uniform sampler2D meadowNoise;');
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 bank;\nvarying vec2 vBank;\nvarying vec2 vBankXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBank = bank;\nvBankXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vBank;\nvarying vec2 vBankXZ;')
      .replace(
        '#include <emissivemap_fragment>',
        `{
          // vBank.x: the water's depth here (under 0 above it), vBank.y: how far in from the rim (m).
          float bkPatch = ${noise ? 'texture2D(meadowNoise, vBankXZ * 0.21).r' : '0.5'};
          float bkFine = ${noise ? 'texture2D(meadowNoise, vBankXZ * 1.9 + 0.37).r' : '0.5'};
          float bkAbove = -vBank.x;
          // The lawn texture's light and dark, as the grain of the mud and the silt.
          float bkLum = dot(diffuseColor.rgb, vec3(0.3, 0.55, 0.15));
          float bkGrain = clamp(bkLum * 3.0, 0.4, 1.6);
          // Rougher, yellower grass on the bank, in from the rim, in patches.
          float bkRough = smoothstep(0.04, 0.5, vBank.y) * (0.45 + 0.55 * bkPatch);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(bkLum) * vec3(1.18, 1.05, 0.62), bkRough * 0.75);
          // Wet mud from about 15 cm over the water (its top wavering), darkest at the water.
          float bkMudTop = 0.09 + 0.12 * bkPatch;
          float bkMud = 1.0 - smoothstep(bkMudTop - 0.07, bkMudTop + 0.03, bkAbove);
          vec3 bkMudColor = vec3(0.1, 0.078, 0.052) * bkGrain * (0.75 + 0.5 * bkFine) * mix(1.0, 0.8, smoothstep(0.08, 0.0, bkAbove));
          diffuseColor.rgb = mix(diffuseColor.rgb, bkMudColor, bkMud);
          // The silt bed under the water: dark olive brown.
          float bkSilt = smoothstep(0.0, 0.08, -bkAbove);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.12, 0.1, 0.06) * bkGrain * (0.8 + 0.4 * bkFine), bkSilt);
          // The mud glossier, its grass texture's bumps smoothed away.
          roughnessFactor = mix(roughnessFactor, 0.42 - 0.12 * bkFine, bkMud * (1.0 - bkSilt));
          normal = normalize(mix(normal, nonPerturbedNormal, bkMud * 0.75));
        }
        #include <emissivemap_fragment>`,
      );
  };
  const key = lawn.customProgramCacheKey.bind(lawn);
  m.customProgramCacheKey = () => `${key()}|bank`;
  bankMat = m;
  return m;
}

/** The relief's normal at (x, z): the lawn's beside the rim. */
function reliefNormal(x: number, z: number): [number, number, number] {
  const e = 0.02;
  const dx = (terrain.height(x + e, z) - terrain.height(x - e, z)) / (2 * e);
  const dz = (terrain.height(x, z + e) - terrain.height(x, z - e)) / (2 * e);
  const l = Math.hypot(dx, 1, dz);
  return [-dx / l, 1 / l, -dz / l];
}

/** A pond's or ditch's banks (null for a dip without water: the garden's wadi). */
export function bankMesh(d: DipSpec, ground: number, lawn: THREE.Material): THREE.Mesh | null {
  const b = bankOf(d, ground, terrain.height);
  if (!b) return null;
  const n = b.x.length;
  const pos = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const wet = new Float32Array(n * 2);
  for (let v = 0; v < n; v++) {
    pos.set([b.x[v], b.y[v], b.z[v]], v * 3);
    uv.set([b.x[v], -b.z[v]], v * 2);
    wet.set([b.level[v] - b.y[v], b.inset[v]], v * 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('bank', new THREE.BufferAttribute(wet, 2));
  g.setIndex(new THREE.BufferAttribute(b.tris, 1));
  g.computeVertexNormals();
  // On the rim the relief's own normal, so the light doesn't change where the lawn rolls over.
  const normal = g.attributes.normal as THREE.BufferAttribute;
  for (let j = 0; j < b.stations; j++) {
    for (const k of [0, b.across - 1]) {
      const v = j * b.across + k;
      normal.setXYZ(v, ...reliefNormal(b.x[v], b.z[v]));
    }
  }
  const mesh = new THREE.Mesh(g, bankMaterial(lawn as THREE.MeshStandardMaterial));
  mesh.receiveShadow = true;
  mesh.userData.material = 'grass';
  mesh.userData.lawn = true; // blades on the bank as on the lawn, none under the water (world/grassTufts.ts)
  mesh.name = d.name;
  return mesh;
}

/**
 * A pond's or ditch's water (null for a dip without water), and where it is, to wade and swim in (world/water.ts).
 * Its points are the banks' (water.ts reads the depth and the flow off them).
 */
export function bankWater(d: DipSpec, ground: number): THREE.Mesh | null {
  const b = bankOf(d, ground, terrain.height);
  if (!b) return null;
  addWater(d, b.line, b.lowLevel, b);
  const n = b.x.length;
  const pos = new Float32Array(n * 3);
  const up = new Float32Array(n * 3);
  const depth = new Float32Array(n);
  const flow = new Float32Array(n * 4);
  for (let v = 0; v < n; v++) {
    pos.set([b.x[v], b.level[v], b.z[v]], v * 3);
    up[v * 3 + 1] = 1;
    depth[v] = b.level[v] - b.y[v];
    // Along the ditch and across it (m), and downstream as fast as it flows (m/s): its ripples follow it (0 in a pond).
    flow.set([b.along[v], b.side[v], b.dirX[v] * b.flow, b.dirZ[v] * b.flow], v * 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(up, 3));
  g.setAttribute('waterDepth', new THREE.BufferAttribute(depth, 1));
  g.setAttribute('waterFlow', new THREE.BufferAttribute(flow, 4));
  g.setIndex(new THREE.BufferAttribute(b.wet, 1));
  const mesh = new THREE.Mesh(g, waterMaterial()); // rippling in the wind or with the flow (world/water.ts)
  mesh.onBeforeRender = waterClock;
  mesh.receiveShadow = true;
  mesh.userData.material = 'water'; // a shot splashes (world/effects.ts)
  mesh.name = `${d.name} water`;
  return mesh;
}
