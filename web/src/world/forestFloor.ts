import { SPRUCE_WOOD } from './cardTrees';

/**
 * The woods' floor at the end of November, in the fields' shader (world/fields.ts, the woods' kind): what lies on it
 * and the sun that reaches it through the crowns.
 *
 * From afar, leaf litter in drifts of a few metres and patches of tens to hundreds (drier and lighter, damper and
 * darker), moss in cushions, lighter and warmer under the broad-leaved trees (beech, oak, birch) than the red-brown
 * needles under the spruces of the Sparrenhof's wood (world/cardTrees.ts SPRUCE_WOOD, where the trees are spruces).
 * Every read of the noise tile (world/groundNoise.ts) is turned its own way and at a scale the others never meet, so
 * nothing repeats on a grid seen from the air.
 *
 * Near by (Medium and up, `woodDetail`), the fallen leaves themselves: three layers of single leaves, each turned and
 * coloured its own way (copper beech, oak brown, ochre, the odd yellow birch or lime leaf, old dark ones), some lobed,
 * each with its midrib and its edges curled up to the light, tilted a little each its own way (the normal), with the
 * older, darker litter showing in the gaps between them; under the spruces needles instead; a twig here and there.
 * All of it fades into the far colour where a leaf gets smaller than a few pixels.
 *
 * Sun flecks: the ground's bake (world/groundShade.ts) holds how much sun comes through the crowns on average (a share
 * under half-bare broad-leaved crowns, little under spruce). Here that share is laid out in flecks: a patch of the
 * floor is in the sun or not, as many patches as the share says, each an ellipse stretched along the sun's way as a
 * low sun draws them, swaying a little with the wind in the crowns (world/wind.ts time). Where a fleck is smaller
 * than a pixel the bake's mean stays. Only the ground's shading (`gs`) changes, so the real-time shadow map's handover
 * and the weather act on it as before.
 *
 * No texture of its own: the fields' noise tile, a few reads more. Low and phones keep the far look (`woodDetail` 0).
 */

/** Leaves, twigs and sun flecks near by: 1 on Medium and up, 0 on Low and phones (main.ts applyQuality). */
export const woodDetail = { value: 1 };

const [SX, SZ, SR] = SPRUCE_WOOD;

/** Before main: the uniforms and the leaves' functions. */
export const FOREST_COMMON = /* glsl */ `
uniform float woodDetail;
uniform float windTime;
vec3 forestHash(vec2 c, float seed) {
  return fract(sin(vec3(dot(c, vec2(127.1, 311.7)), dot(c, vec2(269.5, 183.3)), dot(c, vec2(419.2, 371.9))) + seed) * 43758.5453);
}
// One layer of fallen leaves, one leaf to a cell \`size\` metres across (h: the cell's numbers). px: metres a pixel.
// Gives its cover (0 to 1), where across it a point lies (0 the midrib, 1 the edge), the midrib, and where along it.
vec4 forestLeaf(vec2 p, mat2 turn, float size, float seed, float px, out vec3 h) {
  vec2 c = turn * p / size;
  h = forestHash(floor(c), seed);
  vec2 o = fract(c) - 0.5 - (h.xy - 0.5) * 0.22;
  float a = h.z * 6.2832;
  vec2 r = mat2(cos(a), -sin(a), sin(a), cos(a)) * o;
  float len = 0.29 + 0.08 * h.x;
  float t = clamp(r.x / len, -1.0, 1.0);
  // Half of them lobed (oak), the rest plain ovals (beech, birch, lime).
  float lobes = step(0.5, h.y) * 0.24 * sin(t * 11.0 + h.z * 30.0);
  float wide = (0.1 + 0.09 * fract(h.y * 5.3)) * (1.0 - t * t) * (1.0 + lobes);
  float e = px / size + 0.012;
  float cover = smoothstep(e, -e, abs(r.y) - wide) * smoothstep(e, -e, abs(r.x) - len);
  cover *= step(0.2, fract(h.x * 7.13 + h.y * 3.1)); // some cells bare
  float across = clamp(abs(r.y) / max(wide, 1e-3), 0.0, 1.0);
  float rib = smoothstep(0.14, 0.0, across) * step(abs(t), 0.92);
  return vec4(cover, across, rib, t);
}
// A fallen leaf's colour (linear) by a number of its own.
vec3 forestLeafColour(float k) {
  return k < 0.28 ? vec3(0.19, 0.088, 0.042) // beech, copper
    : k < 0.52 ? vec3(0.13, 0.08, 0.047)     // oak, brown
    : k < 0.68 ? vec3(0.19, 0.135, 0.062)    // ochre
    : k < 0.75 ? vec3(0.27, 0.2, 0.065)      // a fresh yellow one (birch, lime)
    : k < 0.9 ? vec3(0.08, 0.058, 0.042)     // old and dark
    : vec3(0.13, 0.108, 0.088);              // grey-brown, a skeleton
}`;

/**
 * After the light, before the ground's shading (world/groundShade.ts): the crowns lit by the sun above send some of it
 * down again, a soft green-gold, where they hold the sun back. The ground's sky light (gs.g) then dims it as the rest.
 */
export const FOREST_BOUNCE = /* glsl */ `
        #if NUM_DIR_LIGHTS > 0
          reflectedLight.indirectDiffuse += directionalLights[0].color * fieldUnder * vec3(0.2, 0.185, 0.11) * BRDF_Lambert(material.diffuseColor);
        #endif`;

/** In the fields' colour, for the woods' kind: sets the colour, the plants' share and the leaves' tilt, and the sun flecks in gs.r. */
export const FOREST_FLOOR = /* glsl */ `
          vec2 fP = vFieldXZ;
          float fPx = max(fwidth(fP.x), fwidth(fP.y)); // metres a pixel
          float fA = texture2D(fieldNoise, mat2(0.951, -0.309, 0.309, 0.951) * fP / 7.3).r;
          float fB = texture2D(fieldNoise, mat2(0.682, 0.731, -0.731, 0.682) * fP / 1.9 + 0.31).r;
          float fC = texture2D(fieldNoise, mat2(0.276, -0.961, 0.961, 0.276) * fP / 26.0 + 0.57).r;
          float fM = texture2D(fieldNoise, mat2(0.848, 0.53, -0.53, 0.848) * fP / 173.0 + 0.19).r;
          // Under the spruces (most of the trees there are, world/cardTrees.ts treeKind).
          float conifer = 0.86 * smoothstep(${(SR + 10).toFixed(1)}, ${(SR - 40).toFixed(1)}, distance(fP, vec2(${SX.toFixed(1)}, ${SZ.toFixed(1)})));
          vec3 litter = mix(mix(vec3(0.105, 0.068, 0.042), vec3(0.15, 0.1, 0.062), fB), mix(vec3(0.078, 0.05, 0.034), vec3(0.11, 0.07, 0.045), fB), conifer);
          // Damp old drifts, and over tens to hundreds of metres drier and damper ground.
          float fTone = mix(1.0, 0.55, smoothstep(0.58, 0.9, fA) * 0.75) * (0.8 + 0.4 * fM);
          litter *= fTone;
          float mossy = smoothstep(0.6, 0.85, fC * 0.55 + fA * 0.3 + fM * 0.15 + conifer * 0.08);
          vec3 c = mix(litter, vec3(0.04, 0.075, 0.018) * (0.75 + 0.5 * fB), mossy * 0.85);
          float fNear = clamp((0.05 - fPx) / 0.025, 0.0, 1.0) * woodDetail;
          if (fNear > 0.0) {
            // The leaves: the older, darker litter in the gaps, three layers over it, the finest on top.
            vec3 top = c * 0.6;
            float fCover = 0.0;
            vec2 fTiltW = vec2(0.0);
            vec3 h;
            float fFew = (1.0 - conifer * 0.85) * (1.0 - mossy * 0.75);
            vec4 L = forestLeaf(fP, mat2(1.0, 0.0, 0.0, 1.0), 0.17, 1.0, fPx, h);
            float k = L.x * fFew;
            top = mix(top, forestLeafColour(fract(h.z * 3.7)) * fTone * (0.78 + 0.4 * L.y) * (1.0 - 0.3 * L.z), k);
            fCover = max(fCover, k);
            fTiltW = mix(fTiltW, (h.xy - 0.5) * 0.8, k);
            L = forestLeaf(fP, mat2(0.799, 0.602, -0.602, 0.799), 0.135, 2.0, fPx, h);
            k = L.x * fFew;
            top = mix(top, forestLeafColour(fract(h.z * 3.7)) * fTone * (0.78 + 0.4 * L.y) * (1.0 - 0.3 * L.z), k);
            fCover = max(fCover, k);
            fTiltW = mix(fTiltW, (h.xy - 0.5) * 0.8, k);
            L = forestLeaf(fP, mat2(0.326, -0.946, 0.946, 0.326), 0.11, 3.0, fPx, h);
            k = L.x * fFew * 0.8;
            top = mix(top, forestLeafColour(fract(h.z * 3.7)) * fTone * (0.78 + 0.4 * L.y) * (1.0 - 0.3 * L.z), k);
            fCover = max(fCover, k);
            fTiltW = mix(fTiltW, (h.xy - 0.5) * 0.8, k);
            // Needles under the spruces: fine streaks lying every way.
            float fN1 = texture2D(fieldNoise, mat2(0.6, 0.8, -0.8, 0.6) * fP * vec2(16.0, 1.3) + 0.21).r;
            float fN2 = texture2D(fieldNoise, mat2(0.97, -0.24, 0.24, 0.97) * fP * vec2(1.3, 16.0) + 0.67).r;
            float fNeedle = smoothstep(0.55, 0.78, max(fN1, fN2));
            top = mix(top, mix(c * 0.7, c * 1.35, fNeedle), conifer * (1.0 - fCover));
            // A twig here and there, one to a cell of 80 cm in most of them.
            vec2 tc = mat2(0.809, -0.588, 0.588, 0.809) * fP / 0.8;
            vec3 th = forestHash(floor(tc), 7.0);
            vec2 tq = (fract(tc) - 0.5 - (th.xy - 0.5) * 0.3) * 0.8;
            float ta = th.z * 3.1416;
            vec2 td = vec2(cos(ta), sin(ta));
            float tl = 0.1 + 0.18 * th.x;
            float tw = 0.005 + 0.006 * th.y;
            float twig = smoothstep(tw + fPx, tw - fPx * 0.5, length(tq - td * clamp(dot(tq, td), -tl, tl)));
            twig *= step(0.4, fract(th.y * 4.1 + th.x)) * clamp(1.0 - fPx / 0.012, 0.0, 1.0);
            top = mix(top, vec3(0.05, 0.038, 0.03), twig * 0.9);
            c = mix(c, top, fNear);
            fieldTilt = (viewMatrix * vec4(fTiltW.x, 0.0, fTiltW.y, 0.0)).xyz * fNear * fCover;
          }
          diffuseColor.rgb = c * (0.85 + 0.3 * clamp(texelLum / 0.13, 0.0, 1.5));
          fieldPlant = 1.0;
          // The sun through the crowns, in flecks (see world/forestFloor.ts). The sky photo's sun in the sky's light keeps
          // the crowns' mean, and their bounce goes with what they hold back.
          gsSkySunFloor = min(1.0, gs.r * 1.5 + 0.15); // the crowns scatter some of what they hold back
          fieldUnder = 1.0 - gs.r;
          if (woodDetail > 0.0) {
            vec2 fSun = vec2(0.6, 0.8);
            float fLong = 2.0;
            #if NUM_DIR_LIGHTS > 0
              vec3 fSunW = (vec4(directionalLights[0].direction, 0.0) * viewMatrix).xyz;
              fSun = normalize(fSunW.xz + vec2(1e-4, 0.0));
              fLong = clamp(1.0 / max(fSunW.y, 0.05), 1.0, 3.5);
            #endif
            vec2 fq = vec2(dot(fP, fSun) / fLong, dot(fP, vec2(-fSun.y, fSun.x)));
            float fSway = sin(windTime * 1.3 + dot(fP, vec2(0.11, 0.07))) * 0.05 + sin(windTime * 2.9 + fP.x * 0.21) * 0.025;
            float fn = texture2D(fieldNoise, fq / 1.7 + vec2(fSway, 0.0) + 0.17).r * 0.62
              + texture2D(fieldNoise, mat2(0.809, 0.588, -0.588, 0.809) * fq / 0.63 - vec2(0.0, fSway * 1.7) + 0.53).r * 0.38;
            float fu = smoothstep(0.26, 0.74, fn);
            float fEdge = 0.1 + fwidth(fu); // the sun's disc blurs a fleck's edge over a hand's width
            float fleck = smoothstep(1.0 - gs.r - fEdge, 1.0 - gs.r + fEdge, fu);
            float fIn = smoothstep(0.01, 0.06, gs.r) * smoothstep(0.99, 0.9, gs.r);
            float fSmall = clamp((0.3 - fwidth(fq.y / 0.63)) * 4.0, 0.0, 1.0); // the flecks bigger than a few pixels
            gs.r = mix(gs.r, fleck, fIn * fSmall * woodDetail);
          }`;
