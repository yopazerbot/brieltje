"""Render the start screen's still in Blender (Cycles): the game's own scene, lit by the sky photo.

1. Export the scene from the game: on the dev server's start screen, run tools/still/export_scene.js
   in the page. It downloads start_scene.glb (everything visible, the start camera) and
   start_info.json (the sun, the sky's turn). The game's texture files are noted per material
   (glTF extras) instead of embedded.
2. Render (Blender 5, no window):
     blender -b -P tools/still/render_still.py -- <dir with the two files> <out.png> [width] [samples]
3. tools/.venv/Scripts/python.exe tools/still/encode_still.py <out.png> web/public/start

The sky is the same photo as in the game (Poly Haven, CC0) at 8k when source/ has it; its sun lights
the scene, so there is no separate sun lamp. Far things fade into the haze as in the game (FogExp2).
"""
import json
import math
import os
import sys
from pathlib import Path

import bpy
import numpy as np

argv = sys.argv[sys.argv.index("--") + 1:]
SRC, OUT = Path(argv[0]), Path(argv[1])
WIDTH = int(argv[2]) if len(argv) > 2 else 2560
SAMPLES = int(argv[3]) if len(argv) > 3 else 256
ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "web" / "public"
SKY_SMALL = PUBLIC / "env" / "sky_2k.hdr"
SKY_BIG = ROOT / "source" / "textures" / "hdri" / "kloofendal_48d_partly_cloudy_puresky_8k.hdr"
FOG = 0.0019  # the game's haze (FogExp2 density)

info = json.loads((SRC / "start_info.json").read_text(encoding="utf-8"))
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(SRC / "start_scene.glb"))
scene = bpy.context.scene

# --- The sky: the sun's pixel and the haze colour, as the game finds them (web/src/world/environment.ts).
small = bpy.data.images.load(str(SKY_SMALL))
w, h = small.size
px = np.empty(w * h * 4, np.float32)
small.pixels.foreach_get(px)
px = px.reshape(h, w, 4)[::-1]  # Blender keeps the bottom row first; the game reads from the top
lum = px[..., 0] * 0.2126 + px[..., 1] * 0.7152 + px[..., 2] * 0.0722
py, pxx = np.unravel_index(int(np.argmax(lum)), lum.shape)
haze = px[int(h * 0.47):int(h * 0.495), ::4, :3].reshape(-1, 3).mean(axis=0)
lon = ((pxx + 0.5) / w - 0.5) * 2 * math.pi
lat = (0.5 - (py + 0.5) / h) * math.pi
photo_sun = np.array([math.cos(lat) * math.cos(lon), -math.cos(lat) * math.sin(lon), math.sin(lat)])  # glTF axes -> Blender

# The game turns the sky about the vertical by `backgroundTurn` so its sun comes from the wanted side;
# here that is the same turn about Blender's z, applied to the direction the sky is looked up in.
turn = info["backgroundTurn"]
s = info["sun"]
want = np.array([s[0], -s[2], s[1]])
c, si = math.cos(turn), math.sin(turn)
check = np.array([c * photo_sun[0] - si * photo_sun[1], si * photo_sun[0] + c * photo_sun[1], photo_sun[2]])
print(f"haze {haze.round(3)}; sun from the game {want.round(3)}, sky's sun turned {check.round(3)}: {math.degrees(math.acos(min(1.0, float(check @ want)))):.2f} deg apart")

world = bpy.data.worlds.new("Sky")
scene.world = world
world.use_nodes = True
wn = world.node_tree.nodes
wn.clear()
coord = wn.new("ShaderNodeTexCoord")
mapping = wn.new("ShaderNodeMapping")
mapping.vector_type = "POINT"
mapping.inputs["Rotation"].default_value = (0.0, 0.0, -turn)
env = wn.new("ShaderNodeTexEnvironment")
env.image = bpy.data.images.load(str(SKY_BIG if SKY_BIG.exists() else SKY_SMALL))
bg = wn.new("ShaderNodeBackground")
wout = wn.new("ShaderNodeOutputWorld")
wl = world.node_tree.links
wl.new(coord.outputs["Generated"], mapping.inputs["Vector"])
wl.new(mapping.outputs["Vector"], env.inputs["Vector"])
wl.new(env.outputs["Color"], bg.inputs["Color"])
wl.new(bg.outputs["Background"], wout.inputs["Surface"])
world.cycles.sampling_method = "MANUAL"
world.cycles.sample_map_resolution = 4096  # a small, very bright sun: sample it well

# --- Materials: the game's textures back on, with the game's tiling (three.js texture transforms).
images = {}


def image(src, colour):
    if src not in images:
        img = bpy.data.images.load(str(PUBLIC / src.lstrip("/")))
        img.colorspace_settings.name = "sRGB" if colour else "Non-Color"
        images[src] = img
    return images[src]


def uv_affine(t):
    """three.js Matrix3.setUvTransform: u' = a u + b v + c, v' = d u + e v + f."""
    (ox, oy), (sx, sy), r, (cx, cy) = t["offset"], t["repeat"], t["rotation"], t["center"]
    co, sn = math.cos(r), math.sin(r)
    return (sx * co, sx * sn, -sx * (co * cx + sn * cy) + cx + ox, -sy * sn, sy * co, -sy * (-sn * cx + co * cy) + cy + oy)


def mul_add(nt, x, k, add):
    n = nt.nodes.new("ShaderNodeMath")
    n.operation = "MULTIPLY_ADD"
    nt.links.new(x, n.inputs[0])
    n.inputs[1].default_value = k
    if isinstance(add, (int, float)):
        n.inputs[2].default_value = add
    else:
        nt.links.new(add, n.inputs[2])
    return n.outputs[0]


def textured(nt, t, colour, src_uv):
    """An image texture looked up as the game does. glTF import flips v (v_blender = 1 - v_three),
    so v_three = 1 - v_b goes into the transform: u' = a u - b v_b + (b + c), likewise v'."""
    a, b, c, d, e, f = uv_affine(t)
    u, vb = src_uv
    uu = mul_add(nt, vb, -b, mul_add(nt, u, a, b + c))
    vv = mul_add(nt, vb, -e, mul_add(nt, u, d, e + f))
    comb = nt.nodes.new("ShaderNodeCombineXYZ")
    nt.links.new(uu, comb.inputs[0])
    nt.links.new(vv, comb.inputs[1])
    node = nt.nodes.new("ShaderNodeTexImage")
    node.image = image(t["src"], colour)
    node.interpolation = "Cubic" if colour else "Linear"
    nt.links.new(comb.outputs[0], node.inputs["Vector"])
    return node


def haze_on(mat):
    """Far things fade into the haze colour, as the game's FogExp2: 1 - exp(-(density d)^2)."""
    nt = mat.node_tree
    out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output), None)
    if not out or not out.inputs["Surface"].links or mat.get("fog") is False:  # the far tree line has none
        return
    shader = out.inputs["Surface"].links[0].from_socket
    cam = nt.nodes.new("ShaderNodeCameraData")
    sq = nt.nodes.new("ShaderNodeMath")
    sq.operation = "MULTIPLY"
    nt.links.new(cam.outputs["View Distance"], sq.inputs[0])
    sq.inputs[1].default_value = FOG
    p2 = nt.nodes.new("ShaderNodeMath")
    p2.operation = "POWER"
    nt.links.new(sq.outputs[0], p2.inputs[0])
    p2.inputs[1].default_value = 2.0
    ex = nt.nodes.new("ShaderNodeMath")
    ex.operation = "EXPONENT"
    neg = nt.nodes.new("ShaderNodeMath")
    neg.operation = "MULTIPLY"
    nt.links.new(p2.outputs[0], neg.inputs[0])
    neg.inputs[1].default_value = -1.0
    nt.links.new(neg.outputs[0], ex.inputs[0])
    fac = nt.nodes.new("ShaderNodeMath")
    fac.operation = "SUBTRACT"
    fac.inputs[0].default_value = 1.0
    nt.links.new(ex.outputs[0], fac.inputs[1])
    glow = nt.nodes.new("ShaderNodeEmission")
    glow.inputs["Color"].default_value = (*haze.tolist(), 1.0)
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(fac.outputs[0], mix.inputs["Fac"])
    nt.links.new(shader, mix.inputs[1])
    nt.links.new(glow.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])


glass = rebuilt = 0
for mat in bpy.data.materials:
    if not mat.use_nodes:
        continue
    nt = mat.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    extras = mat.get("tex")
    tex = extras.to_dict() if hasattr(extras, "to_dict") else (extras or {})
    if bsdf and mat.get("kind") == "MeshPhysicalMaterial" and mat.get("transparent") and float(mat.get("opacity", 1)) < 0.5:
        # Window glass: real glass here (the game fakes it with see-through panes).
        for sock in list(bsdf.inputs["Alpha"].links):
            nt.links.remove(sock)
        bsdf.inputs["Alpha"].default_value = 1.0
        bsdf.inputs["Transmission Weight"].default_value = 1.0
        bsdf.inputs["Roughness"].default_value = 0.02
        bsdf.inputs["IOR"].default_value = 1.5
        bsdf.inputs["Base Color"].default_value = (0.92, 0.96, 0.97, 1.0)
        glass += 1
    elif bsdf and tex:
        uvn = nt.nodes.new("ShaderNodeUVMap")
        sep = nt.nodes.new("ShaderNodeSeparateXYZ")
        nt.links.new(uvn.outputs["UV"], sep.inputs[0])
        uv = (sep.outputs[0], sep.outputs[1])
        if "map" in tex:
            col = textured(nt, tex["map"], True, uv)
            tint = bsdf.inputs["Base Color"].default_value[:]
            mul = nt.nodes.new("ShaderNodeVectorMath")
            mul.operation = "MULTIPLY"
            nt.links.new(col.outputs["Color"], mul.inputs[0])
            mul.inputs[1].default_value = tint[:3]
            nt.links.new(mul.outputs[0], bsdf.inputs["Base Color"])
        if "roughnessMap" in tex:
            r = textured(nt, tex["roughnessMap"], False, uv)
            spl = nt.nodes.new("ShaderNodeSeparateColor")
            nt.links.new(r.outputs["Color"], spl.inputs[0])
            k = nt.nodes.new("ShaderNodeMath")
            k.operation = "MULTIPLY"
            nt.links.new(spl.outputs[1], k.inputs[0])  # three.js reads roughness from green
            k.inputs[1].default_value = bsdf.inputs["Roughness"].default_value
            nt.links.new(k.outputs[0], bsdf.inputs["Roughness"])
        if "normalMap" in tex:
            n = textured(nt, tex["normalMap"], False, uv)
            spl = nt.nodes.new("ShaderNodeSeparateColor")
            nt.links.new(n.outputs["Color"], spl.inputs[0])
            inv = nt.nodes.new("ShaderNodeMath")
            inv.operation = "SUBTRACT"
            inv.inputs[0].default_value = 1.0
            nt.links.new(spl.outputs[1], inv.inputs[1])  # v runs the other way here: green flips
            comb = nt.nodes.new("ShaderNodeCombineColor")
            nt.links.new(spl.outputs[0], comb.inputs[0])
            nt.links.new(inv.outputs[0], comb.inputs[1])
            nt.links.new(spl.outputs[2], comb.inputs[2])
            nmap = nt.nodes.new("ShaderNodeNormalMap")
            nt.links.new(comb.outputs[0], nmap.inputs["Color"])
            nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
        rebuilt += 1
    if bsdf and mat.get("vertexColors"):
        # Colour per vertex (leaves, window frames and panes, lamps): times the material's colour.
        vc = nt.nodes.new("ShaderNodeVertexColor")
        mul = nt.nodes.new("ShaderNodeVectorMath")
        mul.operation = "MULTIPLY"
        nt.links.new(vc.outputs["Color"], mul.inputs[0])
        base = bsdf.inputs["Base Color"]
        if base.links:
            nt.links.new(base.links[0].from_socket, mul.inputs[1])
        else:
            mul.inputs[1].default_value = base.default_value[:3]
        nt.links.new(mul.outputs[0], base)
    spread = mat.get("instanceColors")
    if bsdf and spread:
        # A colour per instance in the game (hedge clumps); each imported instance is an object
        # here, so each picks its own from the same range.
        spread = spread.to_dict() if hasattr(spread, "to_dict") else spread
        obj = nt.nodes.new("ShaderNodeObjectInfo")
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        nt.links.new(obj.outputs["Random"], mix.inputs[0])
        a_in = next(s for s in mix.inputs if s.name == "A" and s.type == "RGBA")
        b_in = next(s for s in mix.inputs if s.name == "B" and s.type == "RGBA")
        a_in.default_value = (*spread["lo"], 1.0)
        b_in.default_value = (*spread["hi"], 1.0)
        out = next(s for s in mix.outputs if s.type == "RGBA")
        mul = nt.nodes.new("ShaderNodeVectorMath")
        mul.operation = "MULTIPLY"
        nt.links.new(out, mul.inputs[0])
        base = bsdf.inputs["Base Color"]
        if base.links:
            nt.links.new(base.links[0].from_socket, mul.inputs[1])
        else:
            mul.inputs[1].default_value = base.default_value[:3]
        nt.links.new(mul.outputs[0], base)
    haze_on(mat)
print(f"{len(bpy.data.materials)} materials: {rebuilt} with the game's textures, {glass} glass; {len(images)} texture files")

# --- Camera and render.
cam = next(o for o in scene.objects if o.type == "CAMERA")
scene.camera = cam
cam.data.clip_end = 3000
zoom = os.environ.get("STILL_ZOOM")  # for checking a part close up: "factor,shift_x,shift_y"
if zoom:
    f, sx, sy = (float(v) for v in zoom.split(","))
    cam.data.lens *= f
    cam.data.shift_x, cam.data.shift_y = sx, sy
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
if os.environ.get("STILL_THREADS"):  # leave cores free for other work
    scene.render.threads_mode = "FIXED"
    scene.render.threads = int(os.environ["STILL_THREADS"])
scene.cycles.samples = SAMPLES
scene.cycles.use_adaptive_sampling = True
scene.cycles.adaptive_threshold = 0.008
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 8
scene.cycles.caustics_reflective = scene.cycles.caustics_refractive = False
scene.cycles.sample_clamp_indirect = 10.0
scene.render.resolution_x = WIDTH
scene.render.resolution_y = round(WIDTH * 9 / 16)
scene.render.resolution_percentage = 100
scene.view_settings.view_transform = "AgX"
scene.view_settings.look = "AgX - Medium High Contrast"
scene.view_settings.exposure = float(argv[4]) if len(argv) > 4 else 0.0
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_depth = "16"
scene.render.filepath = str(OUT)
print(f"rendering {scene.render.resolution_x}x{scene.render.resolution_y}, {SAMPLES} samples, {len(scene.objects)} objects")
bpy.ops.render.render(write_still=True)
print("wrote", OUT)
