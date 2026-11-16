import type { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';

/**
 * How far the ambient occlusion (GTAO, High and Ultra) reaches: in full up to `fadeFrom` metres from the eye, gone
 * at `fadeTo`, and not worked out at all past it.
 *
 * Far off it went wrong. Its corners are 0.6 m across and it works the surfaces out from the scene's depth, whose
 * steps grow with the square of the distance: about 5 cm at 200 m, 0.4 m at 600 m, more than a metre at 1 km
 * (near plane 0.05 m, a 24-bit depth). Out there every half-resolution pixel found its own made-up slope, and from
 * the air the far land was a carpet of grey speckle that moved with the eye. Past about 150 m the corners it darkens
 * are smaller than a pixel anyway, so nothing real is lost, and the far pixels (most of the screen from the air)
 * cost nothing now.
 */
export function aoReach(ao: GTAOPass, fadeFrom: number, fadeTo: number): void {
  const m = ao.gtaoMaterial;
  const source = m.fragmentShader;
  const anchors = ['uniform float scale;', 'vec3 viewPos = getViewPosition(vUv, depth);', 'ao = pow(ao, scale);'];
  if (!anchors.every((a) => source.split(a).length === 2)) {
    console.warn('aoReach: the GTAO shader changed; the ambient occlusion reaches to the horizon');
    return;
  }
  m.uniforms.aoReach = { value: [fadeFrom, fadeTo] };
  m.fragmentShader = source
    .replace(anchors[0], `${anchors[0]}\nuniform vec2 aoReach;`)
    // Past the fade: no occlusion. The target is cleared to white (none), as for the sky.
    .replace(anchors[1], `${anchors[1]}\nif (-viewPos.z >= aoReach.y) { discard; return; }`)
    .replace(anchors[2], `${anchors[2]}\nao = mix(ao, 1., smoothstep(aoReach.x, aoReach.y, -viewPos.z));`);
  m.needsUpdate = true;
}
