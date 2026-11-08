import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import data from '../data/roadDetail.json';
import { looseProps, type Place } from './looseProps';

/**
 * The red and white posts at the drives along the outer streets (the second Street View walk, 8 Nov 2026): where a
 * drive crosses a grass verge, a round white post of about a metre each side of its mouth, two red reflectors near
 * its top, so a car backing out at night sees the edge of the ditch. tools/road_detail.py finds them (`posts`: a
 * drive from the aerial photo meeting the road where the verge is grass, away from the church square).
 *
 * Loose things (world/looseProps.ts): plastic posts, so a car bends them flat and they spring back up, and a fast
 * one knocks one out of the ground. One instanced mesh for all of them where they stand; nothing on the wire.
 */

const POSTS = ((data as unknown as { posts?: [number, number, number][] }).posts ?? []);

/** A post: white, 1.0 m, 10 cm round, two red reflectors on opposite sides near the top, a dark cap. */
function post(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const colour = (g: THREE.BufferGeometry, hex: string) => {
    const out = g.index ? g.toNonIndexed() : g;
    out.deleteAttribute('uv');
    const c = new THREE.Color(hex);
    const a = new Float32Array(out.attributes.position.count * 3);
    for (let i = 0; i < a.length; i += 3) a.set([c.r, c.g, c.b], i);
    out.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return out;
  };
  parts.push(colour(new THREE.CylinderGeometry(0.05, 0.055, 0.98, 10, 1).translate(0, 0.49, 0), '#e9e9e4'));
  parts.push(colour(new THREE.CylinderGeometry(0.035, 0.05, 0.04, 10, 1).translate(0, 1.0, 0), '#3a3c3f'));
  for (const side of [1, -1]) {
    parts.push(colour(new THREE.BoxGeometry(0.05, 0.16, 0.012).translate(0, 0.84, side * 0.052), '#c01d1b'));
  }
  return mergeGeometries(parts);
}

/** The posts as loose things, each on the ground at its spot (`groundAt`: the ground or paving there). */
export function placeDelineators(groundAt: (x: number, z: number) => number): void {
  if (!POSTS.length) return;
  // Turned along the road (`yaw`: its direction), so the reflectors face the traffic both ways.
  const places: Place[] = POSTS.map(([x, z, yaw]) => ({ x, y: groundAt(x, z), z, yaw }));
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0 });
  looseProps.add('delineator', {
    geometry: post(),
    material,
    tag: 'plastic',
    mode: 'pole',
    sound: 'plastic',
    mass: 2,
    push: 0.6,
    // Plastic: it springs back where a steel post stays bent, and snaps off only under a fast car.
    pole: { hz: 2.6, damping: 0.18, yield: 0.9, maxBend: 1.45 },
    snap: 14,
    reach: 0.06,
  }, places);
}
