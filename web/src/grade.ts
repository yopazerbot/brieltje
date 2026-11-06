import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/**
 * The output pass (tone mapping and the screen's colour space, the last full-screen step before the
 * edge smoothing) with a light colour grade folded in, so the look costs no pass of its own: a touch
 * warmer, as an afternoon picture postcard, a little more colour where there is little (vibrance:
 * the grey streets and the sky gain some, red brick that is rich already hardly any), and a faint
 * vignette that darkens the corners by about a seventh. It works on the tone-mapped colours, so it
 * looks the same on every preset and with the eyes adapting indoors.
 */

/** Warmer white: red up, blue down (on colours already tone mapped, 0 to 1). */
const WARM = [1.03, 1.0, 0.955];
/** How much more colour the least colourful surfaces get (0: none). */
const VIBRANCE = 0.22;
/** How much darker the corners are (the edges' middles about a quarter of that). */
const VIGNETTE = 0.15;

/**
 * Before tone mapping: an iPhone stores a value past the half floats' end (65504) as infinity where this PC
 * clamps it, and infinity turns into NaN in the tone mapping, which the edge smoothing then spreads into black
 * blocks. A NaN that came in anyway is dropped first (min() of a NaN gives the other value on some chips, which
 * showed it white), then the rest is capped (a white so bright it stays white).
 */
const SAFE = /* glsl */ `
		vec3 nanTest = gl_FragColor.rgb; // GLSL ES 1.00 (the pass's own) has no isnan(): only NaN differs from itself
		if (nanTest.r != nanTest.r || nanTest.g != nanTest.g || nanTest.b != nanTest.b) gl_FragColor.rgb = vec3(0.0);
		gl_FragColor.rgb = min(gl_FragColor.rgb, vec3(60000.0));

		// tone mapping`;

const GRADE = /* glsl */ `
		// The grade: warmer, a little more colour where there is little, the corners a little darker.
		{
			vec3 c = gl_FragColor.rgb * vec3(${WARM.map((v) => v.toFixed(3)).join(', ')});
			float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
			float hi = max(c.r, max(c.g, c.b));
			float sat = (hi - min(c.r, min(c.g, c.b))) / max(hi, 1e-4);
			c = mix(vec3(l), c, 1.0 + ${VIBRANCE.toFixed(3)} * (1.0 - sat));
			vec2 q = vUv - 0.5;
			float r2 = dot(q, q) * 2.0; // 1 in the corners, 0.5 at the middle of each edge
			c *= 1.0 - ${VIGNETTE.toFixed(3)} * r2 * r2;
			gl_FragColor.rgb = max(c, 0.0);
		}

		// color space`;

/** The output pass with the grade; the plain one if this version of three.js shapes its shader differently. */
export function gradedOutput(): OutputPass {
  const pass = new OutputPass();
  const stock = pass.material.fragmentShader;
  if (stock.includes('// color space')) pass.material.fragmentShader = stock.replace('// color space', GRADE);
  if (stock.includes('// tone mapping')) pass.material.fragmentShader = pass.material.fragmentShader.replace('// tone mapping', SAFE);
  pass.material.userData.stock = stock; // for the before-and-after checks in the dev build
  return pass;
}
