"""The brook spirit's mist: a looping flipbook of a real volume of mist, rendered in Cycles, lit from six ways.

Run (Blender 5, no window), from the project root:
  blender -b --factory-startup -P tools/brook_spirit_mist.py -- web/public/models/brook-spirit [options]

  --preview <dir>   also write the atlases as PNG there (and each light on its own), to look at
  --samples <n>     samples per pixel (default 96)
  --gpu             render on the graphics card: much faster, but its pictures differ a little on each run (for a
                    quick look; the files in the repository come from the processor, the same every run)
  --frames <n>      only the first n frames of the ball (to time it or try a change); the rest stay empty
  --no-ktx2         skip the KTX2 copies

What it renders: a ball of mist about 2 m across, dense and dark in the middle, torn and thin at its edge, that
turns over on itself and churns (three layers of noise, each turning round its own axis a whole number of times in
the loop, so the last frame runs into the first), 48 frames; and a long hanging wisp, a strand of mist that hangs
from above, thins and frays towards its end and flows slowly down (noise on a circle in four dimensions, so it
loops too), 8 frames. No simulation: a procedural volume bakes the same every time, headless.

How the game lights it ("six-way lighting", as games light their smoke): each frame is rendered lit from the right,
from above, from behind, from the left, from below and from the front. Three coloured lights at once (red, green,
blue) give three of them in one render: the mist is grey, so each colour channel only sees its own light. A third
render, lit by a small light in the middle, is how the heart's light glows through it. The game blends the six by
the sun's direction on each sprite, adds the sky's light and the heart's, and blends between frames.

  <out>/mist_a.webp   R lit from the right, G from above, B from behind, A how much it covers (alpha)
  <out>/mist_b.webp   R lit from the left, G from below, B from the front, A lit from inside (stored as 0.5 + 0.5 x
                      the value: WebP's encoder throws away the colour under fully transparent pixels)
  (the lights premultiplied by the coverage, as the render gives them; linear values)

An 8 x 8 atlas of frames, rendered at 256 pixels a frame and kept at 1024 in all: rows 0 to 5 (from the top) the 48
frames of the ball, rows 6 and 7 the 8 frames of the wisp, each two cells tall. ktx2/ holds it at 1024 and ktx2/half/
at 512 (Low, phones), compressed for the graphics chip (ETC1S), and one WebP file of each at 1024 is the fallback
where KTX2 can't be transcoded. Laid out as glTF's UVs, not flipped, as tools/brook_spirit.py's maps.
"""
import hashlib
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

import bpy
import numpy as np
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = os.path.abspath(argv[0])


def opt(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default


PREVIEW = opt("--preview", "")
SAMPLES = int(opt("--samples", "96"))
USE_CPU = "--gpu" not in argv
ONLY = int(opt("--frames", "0"))
KTX2 = "--no-ktx2" not in argv
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CELL = 256
GRID = 8
BALL_FRAMES = 48
WISP_FRAMES = 8
T0 = time.time()


def log(*a):
    print(f"[{time.time() - T0:6.1f} s]", *a, flush=True)


for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.lights, bpy.data.cameras, bpy.data.worlds):
    for item in list(coll):
        coll.remove(item)

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.seed = 11
scene.cycles.samples = SAMPLES
scene.cycles.use_denoising = True
scene.cycles.denoiser = "OPENIMAGEDENOISE"
scene.cycles.denoising_use_gpu = False  # the same pixels every run
scene.cycles.volume_bounces = 2
scene.cycles.max_bounces = 4
scene.cycles.volume_step_rate = 0.5
scene.cycles.volume_max_steps = 512
scene.render.film_transparent = True
scene.view_settings.view_transform = "Standard"
scene.render.image_settings.file_format = "OPEN_EXR"
scene.render.image_settings.color_depth = "32"
scene.render.image_settings.color_mode = "RGBA"
scene.render.use_compositing = False
scene.render.use_sequencer = False
world = bpy.data.worlds.new("Dark")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.0
scene.world = world
if not USE_CPU:
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for kind in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = kind
            prefs.get_devices()
            if any(d.type == kind for d in prefs.devices):
                for d in prefs.devices:
                    d.use = d.type == kind
                scene.cycles.device = "GPU"
                log("rendering on", kind)
                break
        except Exception as e:
            log("no", kind, e)

# ---------------------------------------------------------------------------------------------- the volume
bpy.ops.mesh.primitive_cube_add(size=2.0)
domain = bpy.context.active_object
domain.name = "Mist"
m = bpy.data.materials.new("Mist")
m.use_nodes = True
nt = m.node_tree
for n in list(nt.nodes):
    nt.nodes.remove(n)
N = nt.nodes
L = nt.links.new


def node(kind, **inputs):
    n = N.new(kind)
    for k, v in inputs.items():
        if k in n.inputs:
            n.inputs[k].default_value = v
        else:
            setattr(n, k, v)
    return n


def math_node(op, a, b=None, clamp=False):
    n = N.new("ShaderNodeMath")
    n.operation = op
    n.use_clamp = clamp
    for i, x in enumerate((a, b)):
        if x is None:
            continue
        if isinstance(x, (int, float)):
            n.inputs[i].default_value = x
        else:
            L(x, n.inputs[i])
    return n.outputs[0]


def vmath(op, a, b=None, scale=None):
    n = N.new("ShaderNodeVectorMath")
    n.operation = op
    for i, x in enumerate((a, b)):
        if x is None:
            continue
        if isinstance(x, (tuple, list)):
            n.inputs[i].default_value = x
        else:
            L(x, n.inputs[i])
    if scale is not None:
        n.inputs["Scale"].default_value = scale
    return n.outputs["Value"] if op in ("LENGTH", "DOT_PRODUCT", "DISTANCE") else n.outputs["Vector"]


coord = N.new("ShaderNodeTexCoord").outputs["Object"]
rotors = []


def turning_noise(axis, scale, detail, rough, seed):
    """Noise of the coordinates turned round `axis` (the angle is set per frame)."""
    rot = N.new("ShaderNodeVectorRotate")
    rot.rotation_type = "AXIS_ANGLE"
    rot.inputs["Axis"].default_value = axis
    L(coord, rot.inputs["Vector"])
    rotors.append(rot)
    shift = vmath("ADD", rot.outputs["Vector"], (seed, seed * 0.7, -seed * 1.3))
    tex = node("ShaderNodeTexNoise", noise_dimensions="3D")
    tex.inputs["Scale"].default_value = scale
    tex.inputs["Detail"].default_value = detail
    tex.inputs["Roughness"].default_value = rough
    L(shift, tex.inputs["Vector"])
    return tex


# The ball: a big slow layer (one turn), a smaller one the other way (two turns), and a warp (one turn round a third axis).
warp = turning_noise((0.2, 0.3, 1.0), 1.4, 2.0, 0.5, 3.1)
big = turning_noise((0.35, 1.0, 0.25), 1.15, 5.0, 0.58, 7.7)
small = turning_noise((1.0, -0.3, 0.45), 3.4, 6.0, 0.62, 1.9)
rotors[0].inputs["Angle"].default_value = 0
warped = vmath("ADD", coord, vmath("SCALE", vmath("SUBTRACT", warp.outputs["Color"], (0.5, 0.5, 0.5)), scale=0.5))
r = vmath("LENGTH", vmath("MULTIPLY", warped, (1.0, 1.08, 1.0)))
# Dense in the middle, falling off to nothing by the edge; the noise tears the edge.
core = math_node("SUBTRACT", 1.0, math_node("POWER", math_node("DIVIDE", r, 0.8, True), 1.5), True)
field = math_node("ADD", math_node("MULTIPLY", core, 1.35),
                  math_node("ADD", math_node("MULTIPLY", math_node("SUBTRACT", big.outputs["Fac"], 0.5), 1.25),
                            math_node("MULTIPLY", math_node("SUBTRACT", small.outputs["Fac"], 0.5), math_node("ADD", 0.35, math_node("MULTIPLY", r, 0.9)))))
ball_density = math_node("MULTIPLY", math_node("MAXIMUM", math_node("SUBTRACT", field, 0.5), 0.0), 9.0)

# The wisp: a strand hanging along z (Blender up) from the top of a tall box, its axis swaying, thinning and fraying
# towards the bottom, its noise flowing down along a circle in four dimensions (it loops every frame cycle).
sep = N.new("ShaderNodeSeparateXYZ")
L(coord, sep.inputs["Vector"])
z = sep.outputs["Z"]
wisp_phase = N.new("ShaderNodeValue")  # the frame's share of the loop, 0..1
flow = math_node("MULTIPLY", math_node("ADD", math_node("MULTIPLY", z, 0.5), wisp_phase.outputs[0]), 2 * math.pi)
RAD = 1.6
cz = math_node("MULTIPLY", math_node("COSINE", flow), RAD)
sz = math_node("MULTIPLY", math_node("SINE", flow), RAD)
comb = N.new("ShaderNodeCombineXYZ")
L(math_node("MULTIPLY", sep.outputs["X"], 1.8), comb.inputs["X"])
L(math_node("MULTIPLY", sep.outputs["Y"], 1.8), comb.inputs["Y"])
L(cz, comb.inputs["Z"])
wn = node("ShaderNodeTexNoise", noise_dimensions="4D")
wn.inputs["Scale"].default_value = 1.0
wn.inputs["Detail"].default_value = 6.0
wn.inputs["Roughness"].default_value = 0.6
L(comb.outputs["Vector"], wn.inputs["Vector"])
L(sz, wn.inputs["W"])
comb2 = N.new("ShaderNodeCombineXYZ")
L(math_node("MULTIPLY", cz, 0.6), comb2.inputs["X"])
L(math_node("MULTIPLY", sz, 0.6), comb2.inputs["Y"])
L(math_node("MULTIPLY", z, 0.8), comb2.inputs["Z"])
sway = node("ShaderNodeTexNoise", noise_dimensions="3D")
sway.inputs["Scale"].default_value = 0.8
sway.inputs["Detail"].default_value = 1.0
L(comb2.outputs["Vector"], sway.inputs["Vector"])
swc = N.new("ShaderNodeSeparateColor")
L(sway.outputs["Color"], swc.inputs["Color"])
# Along the strand: 1 at the top (z = 1), 0 at its end (z = -1).
along = math_node("MULTIPLY", math_node("ADD", z, 1.0), 0.5, True)
swing = math_node("MULTIPLY", math_node("SUBTRACT", 1.2, along), 0.6)
dx = math_node("SUBTRACT", sep.outputs["X"], math_node("MULTIPLY", math_node("SUBTRACT", swc.outputs["Red"], 0.5), swing))
dy = math_node("SUBTRACT", sep.outputs["Y"], math_node("MULTIPLY", math_node("SUBTRACT", swc.outputs["Green"], 0.5), swing))
dist = math_node("SQRT", math_node("ADD", math_node("MULTIPLY", dx, dx), math_node("MULTIPLY", dy, dy)))
width = math_node("ADD", 0.12, math_node("MULTIPLY", along, 0.22))
strand = math_node("SUBTRACT", 1.0, math_node("DIVIDE", dist, width), True)
ends = math_node("MULTIPLY", math_node("MINIMUM", math_node("MULTIPLY", along, 3.0), 1.0, True),
                 math_node("MINIMUM", math_node("MULTIPLY", math_node("SUBTRACT", 1.0, along), 6.0), 1.0, True))
wfield = math_node("ADD", math_node("MULTIPLY", math_node("MULTIPLY", strand, ends), 1.3), math_node("MULTIPLY", math_node("SUBTRACT", wn.outputs["Fac"], 0.5), 1.1))
wisp_density = math_node("MULTIPLY", math_node("MAXIMUM", math_node("SUBTRACT", wfield, 0.5), 0.0), 14.0)

which = N.new("ShaderNodeValue")  # 0 the ball, 1 the wisp
density = N.new("ShaderNodeMix")
density.data_type = "FLOAT"
L(which.outputs[0], density.inputs["Factor"])
L(ball_density, density.inputs[2])
L(wisp_density, density.inputs[3])
vol = N.new("ShaderNodeVolumePrincipled")
vol.inputs["Color"].default_value = (0.82, 0.82, 0.82, 1)
vol.inputs["Anisotropy"].default_value = 0.35
vol.inputs["Absorption Color"].default_value = (0.0, 0.0, 0.0, 1)
L(density.outputs[0], vol.inputs["Density"])
out = N.new("ShaderNodeOutputMaterial")
L(vol.outputs["Volume"], out.inputs["Volume"])
domain.data.materials.append(m)

# ---------------------------------------------------------------------------------------------- lights and camera
cam_data = bpy.data.cameras.new("Cam")
cam_data.type = "ORTHO"
cam = bpy.data.objects.new("Cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
cam.location = (0, -6, 0)
cam.rotation_euler = (math.pi / 2, 0, 0)  # looking along +y; right +x, up +z


def sun(name, toward, colour):
    ld = bpy.data.lights.new(name, "SUN")
    ld.energy = 3.0
    ld.color = colour
    ld.angle = math.radians(4)
    o = bpy.data.objects.new(name, ld)
    scene.collection.objects.link(o)
    o.rotation_euler = Vector(toward).to_track_quat("-Z", "Y").to_euler()
    return o


# Directions the light travels: from the right (+x) towards -x, from above, from behind (+y) towards the camera.
POS = [sun("Right", (-1, 0, 0), (1, 0, 0)), sun("Top", (0, 0, -1), (0, 1, 0)), sun("Back", (0, -1, 0), (0, 0, 1))]
NEG = [sun("Left", (1, 0, 0), (1, 0, 0)), sun("Bottom", (0, 0, 1), (0, 1, 0)), sun("Front", (0, 1, 0), (0, 0, 1))]
inner_data = bpy.data.lights.new("Inner", "POINT")
inner_data.energy = 60.0
inner_data.shadow_soft_size = 0.25
inner = bpy.data.objects.new("Inner", inner_data)
scene.collection.objects.link(inner)


def show(lights):
    for o in POS + NEG + [inner]:
        o.hide_render = o not in lights


def render(path):
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path)
    w, h = img.size
    a = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    return np.flipud(a.reshape(h, w, 4)).astype(np.float64)


def frame(kind, f, tmp):
    """One frame: (pos RGBA, neg RGB, inside) arrays, top row first."""
    if kind == "ball":
        which.outputs[0].default_value = 0.0
        domain.scale = (1.15, 1.15, 1.15)
        domain.location = (0, 0, 0)
        cam_data.ortho_scale = 1.85
        scene.render.resolution_x = scene.render.resolution_y = CELL
        th = 2 * math.pi * f / BALL_FRAMES
        for rot, turns in zip(rotors, (1, 1, -2)):
            rot.inputs["Angle"].default_value = th * turns
        inner.location = (0, 0, 0)
    else:
        which.outputs[0].default_value = 1.0
        domain.scale = (0.5, 0.5, 1.0)
        domain.location = (0, 0, 0)
        cam_data.ortho_scale = 2.0
        scene.render.resolution_x, scene.render.resolution_y = CELL, CELL * 2
        wisp_phase.outputs[0].default_value = f / WISP_FRAMES
        inner.location = (0, 0, 0.75)
    show(POS)
    p = render(os.path.join(tmp, "p.exr"))
    show(NEG)
    n = render(os.path.join(tmp, "n.exr"))
    show([inner])
    i = render(os.path.join(tmp, "i.exr"))
    return p, n, i


# ---------------------------------------------------------------------------------------------- render
S = CELL * GRID
A = np.zeros((S, S, 4))
B = np.zeros((S, S, 4))
with tempfile.TemporaryDirectory(prefix="spirit-mist-") as tmp:
    for f in range(ONLY or BALL_FRAMES):
        p, n, i = frame("ball", f, tmp)
        r0, c0 = (f // GRID) * CELL, (f % GRID) * CELL
        A[r0:r0 + CELL, c0:c0 + CELL] = np.dstack([p[..., 0], p[..., 1], p[..., 2], p[..., 3]])
        B[r0:r0 + CELL, c0:c0 + CELL] = np.dstack([n[..., 0], n[..., 1], n[..., 2], i[..., 0]])
        if f % 8 == 0:
            log(f"ball frame {f}")
    for f in range(0 if ONLY else WISP_FRAMES):
        p, n, i = frame("wisp", f, tmp)
        r0, c0 = 6 * CELL, f * CELL
        A[r0:r0 + 2 * CELL, c0:c0 + CELL] = np.dstack([p[..., 0], p[..., 1], p[..., 2], p[..., 3]])
        B[r0:r0 + 2 * CELL, c0:c0 + CELL] = np.dstack([n[..., 0], n[..., 1], n[..., 2], i[..., 0]])
    log("wisp frames")

# One scale for the six lights (so they keep their balance), one for the light from inside: their brightest
# pixels (but a few) to 1.
lit = np.concatenate([A[..., :3].ravel(), B[..., :3].ravel()])
k_lit = 1.0 / max(1e-6, np.percentile(lit[lit > 1e-4], 99.8))
k_in = 1.0 / max(1e-6, np.percentile(B[..., 3][B[..., 3] > 1e-4], 99.8))
A[..., :3] *= k_lit
B[..., :3] *= k_lit
B[..., 3] *= k_in
log(f"scales: lit {k_lit:.4f}, inside {k_in:.4f}; coverage max {A[..., 3].max():.3f}")
A = np.clip(A, 0, 1)
B = np.clip(B, 0, 1)
# The light from inside is stored as 0.5 + 0.5 x its value (the game reads (a - 0.5) x 2): WebP's encoder throws away
# the colour under fully transparent pixels, and the lights from the left, below and the front must survive.
B[..., 3] = 0.5 + 0.5 * B[..., 3]


def write(path, rgba, fmt):
    h, w, _ = rgba.shape
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=True)
    img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(np.flipud(rgba).astype(np.float32).reshape(-1))
    img.file_format = fmt
    img.filepath_raw = path
    if fmt == "WEBP":
        img.save(quality=92)
    else:
        img.save()
    bpy.data.images.remove(img)


def half(img):
    return (img[0::2, 0::2] + img[1::2, 0::2] + img[0::2, 1::2] + img[1::2, 1::2]) / 4


def encoder():
    path = os.path.join(ROOT, "tools", ".bin", "basisu", "basisu_st.wasm")
    sha = "7b8837e020e48239ab3085697a16334649c07ef121f5a6556d8b17919938a143"
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        url = "https://raw.githubusercontent.com/BinomialLLC/basis_universal/v2_1_0r/bin/basisu_st.wasm"
        log("fetching", url)
        with urllib.request.urlopen(url) as resp:
            data = resp.read()
        if hashlib.sha256(data).hexdigest() != sha:
            sys.exit("basisu_st.wasm: unexpected SHA-256, not using it")
        with open(path, "wb") as fh:
            fh.write(data)
    with open(path, "rb") as fh:
        if hashlib.sha256(fh.read()).hexdigest() != sha:
            sys.exit(f"{path}: unexpected SHA-256; delete it to fetch it again")
    return path


log("writing")
wasm = encoder() if KTX2 else None
written = []
with tempfile.TemporaryDirectory(prefix="spirit-mist-") as tmp:
    # What this tool wrote before (older layouts too) goes first, so only what it writes now is left.
    for folder in (OUT, os.path.join(OUT, "half"), os.path.join(OUT, "ktx2"), os.path.join(OUT, "ktx2", "half")):
        for f in os.listdir(folder) if os.path.isdir(folder) else []:
            if f.startswith("mist_"):
                os.unlink(os.path.join(folder, f))
    for name, img in (("mist_a", A), ("mist_b", B)):
        # Rendered at 2048 for its smoothness, kept at 1024 (512 for Low and phones): soft mist loses nothing by it.
        full = half(img)
        for sub, pic in (("", full), ("half", half(full))):
            if not sub:  # WebP only at 1024: the fallback where KTX2 can't be transcoded
                webp = os.path.join(OUT, name + ".webp")
                os.makedirs(os.path.dirname(webp), exist_ok=True)
                write(webp, pic, "WEBP")
                written.append(webp)
            if KTX2:
                png = os.path.join(tmp, name + ".png")
                write(png, pic, "PNG")
                args = ["-etc1s", "-quality", "128", "-linear", "-ktx2", "-mipmap",
                        "-file", os.path.basename(png), "-output_file", "out.ktx2"]
                run = subprocess.run(["node", "--no-warnings", os.path.join(ROOT, "tools", "basisu.mjs"), wasm, tmp, *args], capture_output=True, text=True)
                res = os.path.join(tmp, "out.ktx2")
                if run.returncode != 0 or not os.path.exists(res):
                    sys.exit(f"{name}: basisu failed\n{run.stdout[-2000:]}\n{run.stderr[-2000:]}")
                dst = os.path.join(OUT, "ktx2", sub, name + ".ktx2")
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.move(res, dst)
                os.unlink(png)
                written.append(dst)
            if PREVIEW and not sub:
                os.makedirs(PREVIEW, exist_ok=True)
                write(os.path.join(PREVIEW, name + ".png"), img, "PNG")
if PREVIEW:
    # Each light on its own, as grey, over a dark grey (to judge the shapes).
    for k, (src, ch) in enumerate(((A, 0), (A, 1), (A, 2), (B, 0), (B, 1), (B, 2), (B, 3), (A, 3))):
        g = src[..., ch]
        rgba = np.dstack([g, g, g, np.ones_like(g)])
        write(os.path.join(PREVIEW, f"mist_light{k}.png"), rgba, "PNG")
for p in written:
    print(f"  {os.path.relpath(p, ROOT)}: {os.path.getsize(p) / 1024:.0f} KB")
log("done")
