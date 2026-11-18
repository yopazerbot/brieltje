import * as THREE from 'three';

/**
 * Mirrors on a wall (the pill mirrors of the fittings, world/props.ts): a room worked out per pixel from the reflected view
 * ray, as world/glassLook.ts works out the rooms behind the windows of models with no inside, instead of drawing the
 * scene a second time (a planar reflection would draw the whole scene again for every mirror in view).
 *
 * The room is a box in front of the mirror: 2.8 m wide, centred on the mirror, 2.8 m deep, its floor where the eye
 * stands and its ceiling 2.7 m above that. Light walls and ceiling, a warmer floor, soft darker corners. The mirror is lit
 * as any surface of its wall is, so what it shows follows the day, the night and the room's light. What is really in
 * the room (the player, what stands opposite) is not in it: it reads as a mirror of a pale room, not of this one.
 *
 * Cost: a few dozen operations per pixel of mirror, the same on every preset; no extra drawing.
 */
const ROOM = /* glsl */ `
{
  vec3 mrP = cameraPosition + ( vec4( - vViewPosition, 0.0 ) * viewMatrix ).xyz;
  vec3 mrN = normalize( ( vec4( vNormal, 0.0 ) * viewMatrix ).xyz );
  vec3 mrV = normalize( mrP - cameraPosition );
  if ( dot( mrN, mrV ) > 0.0 ) mrN = - mrN;
  vec3 mrIn = normalize( vec3( mrN.x, 0.0, mrN.z ) + vec3( 1e-5, 0.0, 0.0 ) );
  vec3 mrAlong = vec3( mrIn.z, 0.0, - mrIn.x );
  vec3 mrR = reflect( mrV, mrN );
  // The reflected ray and the spot in the room's frame: x along the wall from the mirror's middle, y up, z out into the room.
  vec3 mrD = vec3( dot( mrR, mrAlong ), mrR.y, max( dot( mrR, mrIn ), 0.02 ) );
  mrD = vec3( abs( mrD.x ) < 1e-4 ? 1e-4 : mrD.x, abs( mrD.y ) < 1e-4 ? 1e-4 : mrD.y, mrD.z );
  vec3 mrO = vec3( dot( mrP - vMirrorAt, mrAlong ), mrP.y, 0.0 );
  float mrFloor = cameraPosition.y - 1.65;
  vec3 mrLo = vec3( -1.4, mrFloor, 0.0 );
  vec3 mrHi = vec3( 1.4, mrFloor + 2.7, 2.8 );
  vec3 mrT3 = ( mix( mrLo, mrHi, step( 0.0, mrD ) ) - mrO ) / mrD;
  float mrT = min( min( mrT3.x, mrT3.y ), mrT3.z );
  vec3 mrQ = mrO + mrD * mrT;
  vec3 mrE = min( mrQ - mrLo, mrHi - mrQ );
  vec3 mrAlbedo;
  float mrCorner;
  if ( mrT == mrT3.z ) {
    mrAlbedo = vec3( 0.84, 0.81, 0.77 ); // the wall behind the eye
    mrCorner = min( mrE.x, mrE.y );
  } else if ( mrT == mrT3.x ) {
    mrAlbedo = vec3( 0.78, 0.75, 0.71 ); // the side walls
    mrCorner = min( mrE.y, mrE.z );
  } else if ( mrD.y < 0.0 ) {
    mrAlbedo = vec3( 0.66, 0.61, 0.55 ); // the floor
    mrCorner = min( mrE.x, mrE.z );
  } else {
    mrAlbedo = vec3( 0.88, 0.87, 0.85 ); // the ceiling
    mrCorner = min( mrE.x, mrE.z );
  }
  diffuseColor.rgb = mrAlbedo * ( 0.6 + 0.4 * smoothstep( 0.0, 0.45, mrCorner ) );
}
`;

const patched = new WeakSet<THREE.Material>();

/** Give a mirror's material the room in it (see above); again does nothing. */
export function mirrorRoom(m: THREE.MeshStandardMaterial): void {
  if (patched.has(m)) return;
  patched.add(m);
  const before = m.onBeforeCompile;
  const key = m.customProgramCacheKey();
  m.onBeforeCompile = (shader, renderer) => {
    before.call(m, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMirrorAt;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMirrorAt = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMirrorAt;')
      .replace('#include <color_fragment>', `#include <color_fragment>\n${ROOM}`);
  };
  m.customProgramCacheKey = () => `${key}|mirrorRoom`;
  m.needsUpdate = true;
}
