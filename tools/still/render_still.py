"""Render the start screen's still in Blender (Cycles): the game's own scene, lit by the sky photo.

1. Export the scene from the game: on the dev server's start screen, run tools/still/export_scene.js
   in the page. It downloads start_scene.glb (everything visible, the start camera) and
   start_info.json (the sun, the sky's turn). The game's texture files are noted per material
   (glTF extras) instead of embedded.
   For one of the slideshow's views: node tools/still/export_view.mjs <view> <dir> --url <dev server>.
2. Render (Blender 5, no window):
     blender -b -P tools/still/render_still.py -- <dir with the two files> <out.png> [width] [samples] [exposure] [--mood m]
3. tools/.venv/Scripts/python.exe tools/still/encode_still.py <out.png> web/public/start

The sky is the same photo as in the game (Poly Haven, CC0) at 8k when source/ has it; its sun lights
the scene, so there is no separate sun lamp. Far things fade into the haze as in the game (FogExp2).

The weather (world/weather.ts) comes from the export (start_info.json `mood`), or `--mood night|dusk|rain`
anywhere after the `--` overrides it. Sunny renders as it always did. The others take the game's own sky
photo for that mood at 8k (fetched once from Poly Haven into source/textures/hdri/, git-ignored; the 1k
copy in web/public/env otherwise), turned so its brightest spot (the moon, the sun behind the clouds) is
where the game puts it:
- night: the moonlit sky with its stars, the street lamps (start_info.json `lamps`) as real lamps with a
  pool of light, about half the village's rooms lit as in the game (the room's number the export puts in
  a second UV map), a few windows of our own models and the church's glass lit, and the view's own
  floodlights (`render.lights` in views.json, passed on by the export).
- dusk: the same, with the sky about three times brighter: the blue hour.
- rain: the overcast sky darkened as in the game, wet ground and roofs (darker, glossy, with puddles where
  it is flat), rain-darkened walls, and streaks of falling rain in front of the camera.
"""
import json
import math
import os
import sys
import urllib.request
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
MOOD_ARG = None
if "--mood" in argv:
    k = argv.index("--mood")
    MOOD_ARG = argv[k + 1]
    del argv[k:k + 2]
SRC, OUT = Path(argv[0]), Path(argv[1])
WIDTH = int(argv[2]) if len(argv) > 2 else 2560
SAMPLES = int(argv[3]) if len(argv) > 3 else 256
ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "web" / "public"
HDRI = ROOT / "source" / "textures" / "hdri"
SKY_SMALL = PUBLIC / "env" / "sky_2k.hdr"
SKY_BIG = HDRI / "kloofendal_48d_partly_cloudy_puresky_8k.hdr"
FOG = 0.0019  # the game's haze (FogExp2 density)

info = json.loads((SRC / "start_info.json").read_text(encoding="utf-8"))
VIEW = info.get("render") or {}  # the view's own extras (views.json `render`): its mood, floodlights, sky strength
MOOD = MOOD_ARG or VIEW.get("mood") or info.get("mood") or "sunny"
if MOOD == "overcast":
    MOOD = "rain"  # the same sky; the dry overcast has no look of its own here yet

# The moods other than sunny (world/weather.ts LOOKS): the sky photo (Poly Haven, CC0), its strength, the haze.
MOODS = {
    "night": {"sky": "kloppenheim_02_puresky", "small": "night_1k.hdr", "gain": 0.12, "fog": 0.0024, "haze": 1.0, "lit": 1.0},
    "dusk": {"sky": "kloppenheim_02_puresky", "small": "night_1k.hdr", "gain": 0.36, "fog": 0.0016, "haze": 1.0, "lit": 0.8},
    "rain": {"sky": "kloofendal_overcast_puresky", "small": "overcast_1k.hdr", "gain": 0.62, "fog": 0.006, "lit": 0.0},
}
LOOK = MOODS.get(MOOD)
print("mood", MOOD)
LAMP = (1.0, 0.66, 0.34)  # the street lamps' warm white (world/streetLights.ts)


def mood_sky():
    """The mood's sky photo at 8k: fetched from Poly Haven once (CC0, no login) into the git-ignored source/."""
    big = HDRI / f"{LOOK['sky']}_8k.hdr"
    if not big.exists():
        try:
            HDRI.mkdir(parents=True, exist_ok=True)
            url = f"https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/8k/{big.name}"
            print("fetching", url)
            urllib.request.urlretrieve(url, big.with_suffix(".part"))
            big.with_suffix(".part").rename(big)
        except OSError as e:
            print("no 8k sky, the game's 1k one instead:", e)
            return PUBLIC / "env" / LOOK["small"]
    return big


bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(SRC / "start_scene.glb"))
scene = bpy.context.scene

# --- The sky: the sun's pixel and the haze colour, as the game finds them (web/src/world/environment.ts).
if LOOK:
    SKY_SMALL = PUBLIC / "env" / LOOK["small"]
    FOG = LOOK["fog"]
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
if LOOK:
    # The game turns each mood's photo so its brightest spot (the moon, the sun behind the clouds) is at the sun's
    # compass direction (environment.ts loadSky): the same turn about Blender's z here.
    turn = math.atan2(want[1], want[0]) - math.atan2(photo_sun[1], photo_sun[0])
    sky_gain = float(VIEW.get("skyGain", LOOK["gain"]))
    # The haze: the sky just over the horizon, its median all round (the mean takes in the moon's glow).
    haze = np.median(px[int(h * 0.47):int(h * 0.495), :, :3].reshape(-1, 3), axis=0) * sky_gain * float(VIEW.get("haze", LOOK.get("haze", 1.0)))
    print(f"{MOOD}: sky turned {math.degrees(turn):.1f} deg, strength {sky_gain}, haze {haze.round(4)}")

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
if LOOK:
    env.image = bpy.data.images.load(str(mood_sky()))
else:
    env.image = bpy.data.images.load(str(SKY_BIG if SKY_BIG.exists() else SKY_SMALL))
bg = wn.new("ShaderNodeBackground")
if LOOK:
    bg.inputs["Strength"].default_value = sky_gain
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
    if LOOK:
        # In the weather's moods the haze is the sky a little over the horizon behind the thing seen, so the far
        # fields fade into the sky as it is in that direction (the moon's glow, a darker cloud), with no seam.
        inc = nt.nodes.new("ShaderNodeNewGeometry")
        sep = nt.nodes.new("ShaderNodeSeparateXYZ")
        nt.links.new(inc.outputs["Incoming"], sep.inputs[0])
        comb = nt.nodes.new("ShaderNodeCombineXYZ")
        for i in (0, 1):
            nt.links.new(node_math(nt, "MULTIPLY", sep.outputs[i], -1.0), comb.inputs[i])
        nt.links.new(node_math(nt, "MAXIMUM", node_math(nt, "MULTIPLY", sep.outputs[2], -1.0), 0.03), comb.inputs[2])
        look_up = nt.nodes.new("ShaderNodeMapping")
        look_up.vector_type = "POINT"
        look_up.inputs["Rotation"].default_value = (0.0, 0.0, -turn)
        nt.links.new(comb.outputs[0], look_up.inputs["Vector"])
        sky = nt.nodes.new("ShaderNodeTexEnvironment")
        sky.image = small  # the 1k photo: soft, so the light on the horizon doesn't streak up the far fields
        nt.links.new(look_up.outputs["Vector"], sky.inputs["Vector"])
        nt.links.new(sky.outputs["Color"], glow.inputs["Color"])
        glow.inputs["Strength"].default_value = sky_gain * float(VIEW.get("haze", LOOK.get("haze", 1.0)))
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(fac.outputs[0], mix.inputs["Fac"])
    nt.links.new(shader, mix.inputs[1])
    nt.links.new(glow.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])


# Node helpers for the weather's looks (below).
def g2b(p):
    """The game's coordinates (glTF, y up) as Blender's (z up), as the importer turns them."""
    return Vector((p[0], -p[2], p[1]))


def node_math(nt, op, *args):
    n = nt.nodes.new("ShaderNodeMath")
    n.operation = op
    for i, v in enumerate(args):
        if isinstance(v, (int, float)):
            n.inputs[i].default_value = v
        else:
            nt.links.new(v, n.inputs[i])
    return n.outputs[0]


def node_mix(nt, kind, fac, a, b):
    """A Mix node of `kind` (FLOAT, RGBA, VECTOR): a to b by fac; each a socket or a value."""
    n = nt.nodes.new("ShaderNodeMix")
    n.data_type = kind
    socket_type = {"FLOAT": "VALUE", "RGBA": "RGBA", "VECTOR": "VECTOR"}[kind]
    ins = [s for s in n.inputs if s.type == socket_type and s.name in ("A", "B")]
    for v, s in ((fac, n.inputs[0]), (a, ins[0]), (b, ins[1])):
        if isinstance(v, bpy.types.NodeSocket):
            nt.links.new(v, s)
        else:
            s.default_value = v
    return next(s for s in n.outputs if s.type == socket_type)


def node_range(nt, x, lo, hi, to_lo=0.0, to_hi=1.0):
    n = nt.nodes.new("ShaderNodeMapRange")
    nt.links.new(x, n.inputs["Value"])
    n.inputs["From Min"].default_value, n.inputs["From Max"].default_value = lo, hi
    n.inputs["To Min"].default_value, n.inputs["To Max"].default_value = to_lo, to_hi
    return n.outputs["Result"]


def source(nt, sock):
    """What feeds an input: the linked socket, or its value."""
    return sock.links[0].from_socket if sock.links else sock.default_value


def principled(mat):
    return next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None) if mat.use_nodes else None


def emit(nt, bsdf, colour, strength):
    for v, s in ((colour, bsdf.inputs["Emission Color"]), (strength, bsdf.inputs["Emission Strength"])):
        if isinstance(v, bpy.types.NodeSocket):
            nt.links.new(v, s)
        else:
            s.default_value = v


glass = rebuilt = 0
glass_mats = []
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
        glass_mats.append(mat)
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
    if bsdf and mat.get("foliage") and bsdf.inputs["Base Color"].links:
        # Leaves (tree crowns and hedge clumps): the game's leaf shader (world/leaves.ts) lightens their dark vertex
        # greens and breaks them into clumps of leaves; here a leaf-sized noise does that, in colour and relief, and
        # some light comes through them. Without it the crowns rendered as smooth near-black balls.
        tex = nt.nodes.new("ShaderNodeTexNoise")
        tex.inputs["Scale"].default_value = 3.5
        tex.inputs["Detail"].default_value = 6.0
        geo = nt.nodes.new("ShaderNodeTexCoord")
        nt.links.new(geo.outputs["Object"], tex.inputs["Vector"])
        ramp = nt.nodes.new("ShaderNodeMapRange")
        nt.links.new(tex.outputs["Fac"], ramp.inputs["Value"])
        ramp.inputs["From Min"].default_value, ramp.inputs["From Max"].default_value = 0.3, 0.7
        ramp.inputs["To Min"].default_value, ramp.inputs["To Max"].default_value = 1.6, 3.4
        lift = nt.nodes.new("ShaderNodeVectorMath")
        lift.operation = "SCALE"
        base = bsdf.inputs["Base Color"]
        nt.links.new(base.links[0].from_socket, lift.inputs[0])
        nt.links.new(ramp.outputs["Result"], lift.inputs["Scale"])
        nt.links.new(lift.outputs[0], base)
        bump = nt.nodes.new("ShaderNodeBump")
        bump.inputs["Strength"].default_value = 0.6
        nt.links.new(tex.outputs["Fac"], bump.inputs["Height"])
        nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
        bsdf.inputs["Roughness"].default_value = 0.85
        bsdf.inputs["Subsurface Weight"].default_value = 0.15
        # Light through the leaves: seen from under a crown against the sky, a solid ball would be black.
        out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output), None)
        if out and out.inputs["Surface"].links and out.inputs["Surface"].links[0].from_node == bsdf:
            through = nt.nodes.new("ShaderNodeBsdfTranslucent")
            nt.links.new(lift.outputs[0], through.inputs["Color"])
            mix = nt.nodes.new("ShaderNodeMixShader")
            mix.inputs["Fac"].default_value = 0.35
            nt.links.new(bsdf.outputs[0], mix.inputs[1])
            nt.links.new(through.outputs[0], mix.inputs[2])
            nt.links.new(mix.outputs[0], out.inputs["Surface"])
    haze_on(mat)
print(f"{len(bpy.data.materials)} materials: {rebuilt} with the game's textures, {glass} glass; {len(images)} texture files")


# --- The weather's look (night, dusk, rain): lit windows and lamps, or wet surfaces and falling rain.
def light_rooms(mat, lit):
    """The village's rooms at night as the game lights them (world/windows.ts): on when the room's number (u of the
    second UV map) is below one half, a warm lamp or a few a cooler white, through the curtains' colour; venetian
    blinds (covering 4) let little through."""
    nt, bsdf = mat.node_tree, principled(mat)
    users = [o for o in scene.objects if o.type == "MESH" and any(s.material == mat for s in o.material_slots)]
    layers = [o.data.uv_layers[1].name for o in users if len(o.data.uv_layers) > 1]
    if not bsdf or not layers:
        return 0
    uv = nt.nodes.new("ShaderNodeUVMap")
    uv.uv_map = layers[0]
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(uv.outputs["UV"], sep.inputs[0])
    seed, cell = sep.outputs[0], sep.outputs[1]
    on = node_math(nt, "LESS_THAN", seed, 0.5)
    tone = node_math(nt, "POWER", node_math(nt, "FRACT", node_math(nt, "MULTIPLY_ADD", seed, 57.13, 0.71)), 2.0)
    lamp = node_mix(nt, "RGBA", tone, (1.0, 0.42, 0.13, 1.0), (1.0, 0.7, 0.42, 1.0))
    vary = node_math(nt, "MULTIPLY_ADD", node_math(nt, "FRACT", node_math(nt, "MULTIPLY_ADD", seed, 91.9, 0.37)), 0.9, 0.5)
    venetian = node_math(nt, "COMPARE", cell, 4.0, 0.5)
    through = node_math(nt, "MULTIPLY_ADD", venetian, -0.8, 1.0)
    covered = node_math(nt, "GREATER_THAN", cell, 0.5)
    vc = nt.nodes.new("ShaderNodeVertexColor")
    cloth = nt.nodes.new("ShaderNodeVectorMath")
    cloth.operation = "MULTIPLY_ADD"
    nt.links.new(vc.outputs["Color"], cloth.inputs[0])
    cloth.inputs[1].default_value = (0.75, 0.75, 0.75)
    cloth.inputs[2].default_value = (0.22, 0.22, 0.22)
    behind = node_mix(nt, "RGBA", covered, (1.0, 1.0, 1.0, 1.0), cloth.outputs[0])
    col = nt.nodes.new("ShaderNodeVectorMath")
    col.operation = "MULTIPLY"
    nt.links.new(lamp, col.inputs[0])
    nt.links.new(behind, col.inputs[1])
    strength = node_math(nt, "MULTIPLY", node_math(nt, "MULTIPLY", on, through), node_math(nt, "MULTIPLY", vary, 0.8 * lit))
    emit(nt, bsdf, col.outputs[0], strength)
    return 1


def light_some(mat, share, strength):
    """Some windows of our own models lit (the game lights only the village's): a share of them, picked per window
    by where it is (a cell about a window wide and a storey high)."""
    nt, bsdf = mat.node_tree, principled(mat)
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    snap = nt.nodes.new("ShaderNodeVectorMath")
    snap.operation = "SNAP"
    nt.links.new(geo.outputs["Position"], snap.inputs[0])
    snap.inputs[1].default_value = (1.7, 1.7, 2.9)
    noise = nt.nodes.new("ShaderNodeTexWhiteNoise")
    noise.noise_dimensions = "3D"
    nt.links.new(snap.outputs[0], noise.inputs["Vector"])
    on = node_math(nt, "LESS_THAN", noise.outputs["Value"], share)
    tone = node_math(nt, "FRACT", node_math(nt, "MULTIPLY", noise.outputs["Value"], 13.7))
    lamp = node_mix(nt, "RGBA", tone, (1.0, 0.42, 0.13, 1.0), (1.0, 0.66, 0.38, 1.0))
    emit(nt, bsdf, lamp, node_math(nt, "MULTIPLY", on, node_math(nt, "MULTIPLY_ADD", tone, 0.6, 0.7 * strength)))


def wet(mat, puddles, leaves):
    """Rain on a surface: darker and glossier, most where it faces up (the ground, roofs), a little on walls; on paving
    and roads puddles where it is flat, a mirror without the surface's relief."""
    nt, bsdf = mat.node_tree, principled(mat)
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(geo.outputs["Normal"], sep.inputs[0])
    up = node_range(nt, sep.outputs[2], 0.3, 0.92)
    base = source(nt, bsdf.inputs["Base Color"])
    dark = nt.nodes.new("ShaderNodeVectorMath")
    dark.operation = "SCALE"
    if isinstance(base, bpy.types.NodeSocket):
        nt.links.new(base, dark.inputs[0])
    else:
        dark.inputs[0].default_value = base[:3]
    nt.links.new(node_math(nt, "MULTIPLY_ADD", up, -0.12, 0.92) if leaves else node_math(nt, "MULTIPLY_ADD", up, -0.3, 0.8), dark.inputs["Scale"])
    colour = dark.outputs[0]
    rough = source(nt, bsdf.inputs["Roughness"])
    slick = node_math(nt, "MULTIPLY_ADD", rough, 0.3, 0.1) if isinstance(rough, bpy.types.NodeSocket) else rough * 0.3 + 0.1
    how = node_math(nt, "MULTIPLY_ADD", up, 0.35 if leaves else 0.72, 0.12 if leaves else 0.2)
    rough = node_mix(nt, "FLOAT", how, rough, slick)
    if puddles:
        pos = nt.nodes.new("ShaderNodeNewGeometry")
        noise = nt.nodes.new("ShaderNodeTexNoise")
        noise.inputs["Scale"].default_value = 0.11
        noise.inputs["Detail"].default_value = 5.0
        noise.inputs["Roughness"].default_value = 0.62
        nt.links.new(pos.outputs["Position"], noise.inputs["Vector"])
        pool = node_range(nt, noise.outputs["Fac"], 0.54, 0.575)
        flat = node_range(nt, sep.outputs[2], 0.982, 0.997)
        puddle = node_math(nt, "MULTIPLY", pool, flat)
        rough = node_mix(nt, "FLOAT", puddle, rough, 0.012)
        deep = nt.nodes.new("ShaderNodeVectorMath")
        deep.operation = "SCALE"
        nt.links.new(colour, deep.inputs[0])
        deep.inputs["Scale"].default_value = 0.55
        colour = node_mix(nt, "VECTOR", puddle, colour, deep.outputs[0])
        if bsdf.inputs["Normal"].links:
            normal = node_mix(nt, "VECTOR", puddle, bsdf.inputs["Normal"].links[0].from_socket, geo.outputs["Normal"])
            nt.links.new(normal, bsdf.inputs["Normal"])
    nt.links.new(colour, bsdf.inputs["Base Color"])
    nt.links.new(rough, bsdf.inputs["Roughness"])


PAVED = ("asphalt", "concrete", "paving", "pavers", "road", "cobble", "tile", "stone", "gravel", "brick_floor", "kerb")
if LOOK and LOOK["lit"]:
    rooms = sum(light_rooms(m, LOOK["lit"]) for m in bpy.data.materials if m.name.startswith("village_glass"))
    # Our own models' glass: real glass made above, and the dark panes the models carry (named so, or on an object so named).
    named = {}
    for o in scene.objects:
        if o.type == "MESH":
            for s in o.material_slots:
                if s.material:
                    named[s.material] = named.get(s.material, "") + " " + o.name.lower()
    own = [m for m in bpy.data.materials if principled(m) and not m.name.startswith("village_glass")
           and (m in glass_mats or "glass" in (m.name.lower() + named.get(m, "")))]
    for m in own:
        if "church" in m.name.lower() + named.get(m, ""):
            emit(m.node_tree, principled(m), (1.0, 0.62, 0.32, 1.0), 0.5 * LOOK["lit"])  # the church's windows, softly
        else:
            light_some(m, float(VIEW.get("ownWindows", 0.3)), 0.8 * LOOK["lit"])
    print(f"lit windows: {rooms} village glass materials, {len(own)} of our own ({', '.join(m.name for m in own)})")
if LOOK:
    # The painted tree line round the horizon (world/horizon.ts: a ring of a basic material, about two kilometres
    # across): the game fades it nearly all into the haze in these moods (horizonFade), and seen from up high it
    # stood as a wall; left out, the hazed ground runs on to the sky.
    def ring(o):
        size = max(o.dimensions.x, o.dimensions.y)
        return size > 1000 and all(s.material and s.material.get("kind") == "MeshBasicMaterial" for s in o.material_slots)
    painted = [o for o in scene.objects if o.type == "MESH" and o.material_slots and ring(o)]
    for o in painted:
        o.hide_render = True
    print(f"painted horizon left out: {len(painted)} objects")
if LOOK and MOOD == "rain":
    n = 0
    for m in bpy.data.materials:
        bsdf = principled(m)
        if not bsdf or m in glass_mats or m.name.startswith("village_glass") or bsdf.inputs["Transmission Weight"].default_value > 0.5:
            continue
        tex = m.get("tex")
        tex = tex.to_dict() if hasattr(tex, "to_dict") else (tex or {})
        names = (m.name + " " + " ".join(v["src"] for v in tex.values())).lower()
        wet(m, any(k in names for k in PAVED), bool(m.get("foliage")))
        n += 1
    print(f"wet: {n} materials")

# --- Camera and render.
cam = next(o for o in scene.objects if o.type == "CAMERA")
scene.camera = cam
cam.data.clip_end = 3000
zoom = os.environ.get("STILL_ZOOM")  # for checking a part close up: "factor,shift_x,shift_y"
if zoom:
    f, sx, sy = (float(v) for v in zoom.split(","))
    cam.data.lens *= f
    cam.data.shift_x, cam.data.shift_y = sx, sy


def emission_material(name, colour, strength):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    e = nt.nodes.new("ShaderNodeEmission")
    e.inputs["Color"].default_value = (*colour, 1.0)
    e.inputs["Strength"].default_value = strength
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(e.outputs[0], out.inputs["Surface"])
    return mat


def only_seen(obj, glossy=True):
    """Seen by the camera (and in reflections), lighting nothing itself: no noise, no double light."""
    obj.visible_diffuse = obj.visible_transmission = obj.visible_volume_scatter = obj.visible_shadow = False
    obj.visible_glossy = glossy


def aim(obj, at):
    obj.rotation_euler = (Vector(at) - obj.location).to_track_quat("-Z", "Y").to_euler()


if LOOK and LOOK["lit"]:
    # The street lamps (world/streetLights.ts): a spot shining down from just under each head, and a bright bulb.
    reach = float(VIEW.get("lampRange", 450))
    bulb_mesh = bpy.data.meshes.new("bulb")
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=8, radius=0.13)
    bm.to_mesh(bulb_mesh)
    bm.free()
    bulb_mesh.materials.append(emission_material("lamp_bulb", LAMP, 60.0))
    lamps = 0
    for p in info.get("lamps", []):
        head = g2b(p)
        if (head - cam.location).length > reach:
            continue
        light = bpy.data.lights.new(f"lamp{lamps}", "SPOT")
        light.energy = float(VIEW.get("lampPower", 450)) * LOOK["lit"]
        light.color = LAMP
        light.spot_size = math.radians(150)
        light.spot_blend = 0.6
        light.shadow_soft_size = 0.2
        lo = bpy.data.objects.new(f"lamp{lamps}", light)
        lo.location = head - Vector((0, 0, 0.32))
        scene.collection.objects.link(lo)
        bulb = bpy.data.objects.new(f"bulb{lamps}", bulb_mesh)
        bulb.location = head - Vector((0, 0, 0.2))
        only_seen(bulb)
        scene.collection.objects.link(bulb)
        lamps += 1
    # The view's floodlights (views.json `render.lights`): the church's front lit softly.
    for i, f in enumerate(VIEW.get("lights", [])):
        light = bpy.data.lights.new(f"flood{i}", "SPOT")
        light.energy = float(f.get("power", 3000)) * LOOK["lit"]
        light.color = f.get("color", (1.0, 0.78, 0.55))
        light.spot_size = math.radians(f.get("spread", 40))
        light.spot_blend = 0.8
        light.shadow_soft_size = float(f.get("size", 0.4))
        fo = bpy.data.objects.new(f"flood{i}", light)
        fo.location = g2b(f["at"])
        aim(fo, g2b(f["aim"]))
        scene.collection.objects.link(fo)
    print(f"{lamps} street lamps within {reach:.0f} m, {len(VIEW.get('lights', []))} floodlights")

if MOOD == "rain":
    # Falling rain: thin streaks in front of the camera, each as long as a drop falls while the shutter is open (about
    # a fifteenth of a second), leaning a little with the wind, fading at their ends and sides; seen by the camera only.
    rng = np.random.default_rng(int(VIEW.get("rainSeed", 7)))
    count = int(VIEW.get("rain", 9000))
    near, far = 0.7, 38.0
    tan_h = math.tan(cam.data.angle / 2)
    tan_v = tan_h * 9 / 16
    d = (near ** 3 + rng.random(count) * (far ** 3 - near ** 3)) ** (1 / 3)
    local = np.stack([(rng.random(count) * 2 - 1) * tan_h * d * 1.1, (rng.random(count) * 2 - 1.1) * tan_v * d * 1.3, -d], axis=1)
    m = np.array(cam.matrix_world)
    world_pts = local @ m[:3, :3].T + m[:3, 3]
    fall = np.array([0.1, 0.05, -1.0])
    fall /= np.linalg.norm(fall)
    to_cam = np.array(cam.location)[None, :] - world_pts
    to_cam /= np.linalg.norm(to_cam, axis=1, keepdims=True)
    side = np.cross(fall[None, :], to_cam)
    side /= np.linalg.norm(side, axis=1, keepdims=True)
    half = (0.0011 + 0.0005 * d)[:, None]
    length = rng.uniform(0.4, 0.8, count)[:, None]
    top = world_pts - fall * length / 2
    bottom = world_pts + fall * length / 2
    verts = np.concatenate([top - side * half, top + side * half, bottom + side * half, bottom - side * half], axis=1).reshape(-1, 3)
    faces = (np.arange(count)[:, None] * 4 + np.arange(4)[None, :]).tolist()
    mesh = bpy.data.meshes.new("rain")
    mesh.from_pydata(verts.tolist(), [], faces)
    uv = mesh.uv_layers.new(name="UVMap")
    uv.data.foreach_set("uv", np.tile(np.array([0, 1, 1, 1, 1, 0, 0, 0], np.float32), count))
    alpha = (0.38 * np.clip((d - near) / 2.5, 0.15, 1.0) * rng.uniform(0.6, 1.0, count)).astype(np.float32)
    attr = mesh.attributes.new("rain_alpha", "FLOAT", "POINT")
    attr.data.foreach_set("value", np.repeat(alpha, 4))
    mat = bpy.data.materials.new("rain")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    uvn = nt.nodes.new("ShaderNodeUVMap")
    sp = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(uvn.outputs["UV"], sp.inputs[0])
    across = node_math(nt, "POWER", node_math(nt, "SUBTRACT", 1.0, node_math(nt, "ABSOLUTE", node_math(nt, "MULTIPLY_ADD", sp.outputs[0], 2.0, -1.0))), 1.5)
    along = node_math(nt, "POWER", node_math(nt, "SINE", node_math(nt, "MULTIPLY", sp.outputs[1], math.pi)), 0.7)
    at = nt.nodes.new("ShaderNodeAttribute")
    at.attribute_name = "rain_alpha"
    a = node_math(nt, "MULTIPLY", node_math(nt, "MULTIPLY", across, along), at.outputs["Fac"])
    clear = nt.nodes.new("ShaderNodeBsdfTransparent")
    glow = nt.nodes.new("ShaderNodeEmission")
    glow.inputs["Color"].default_value = (*np.clip(haze * 1.7 + 0.01, 0, 10).tolist(), 1.0)
    glow.inputs["Strength"].default_value = float(VIEW.get("rainGlow", 1.0))
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(a, mix.inputs["Fac"])
    nt.links.new(clear.outputs[0], mix.inputs[1])
    nt.links.new(glow.outputs[0], mix.inputs[2])
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    mesh.materials.append(mat)
    rain = bpy.data.objects.new("rain", mesh)
    only_seen(rain, glossy=False)
    scene.collection.objects.link(rain)
    print(f"rain: {count} streaks")

scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
# The graphics card when Cycles can use one (OptiX first, as tools/bake/bake_buildings.py): much faster.
prefs = bpy.context.preferences.addons["cycles"].preferences
for kind in ("OPTIX", "CUDA", "HIP", "METAL"):
    try:
        prefs.compute_device_type = kind
        prefs.get_devices()
    except TypeError:
        continue
    gpus = [d for d in prefs.devices if d.type == kind]
    if gpus:
        for d in prefs.devices:
            d.use = d.type == kind
        scene.cycles.device = "GPU"
        print("rendering on", kind, [d.name for d in gpus])
        break
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
scene.view_settings.exposure = float(argv[4]) if len(argv) > 4 else float(VIEW.get("exposure", 0.0))
if MOOD == "rain":
    scene.cycles.transparent_max_bounces = 64  # the rain's streaks lie behind each other
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_depth = "16"
scene.render.filepath = str(OUT)
print(f"rendering {scene.render.resolution_x}x{scene.render.resolution_y}, {SAMPLES} samples, {len(scene.objects)} objects")
bpy.ops.render.render(write_still=True)
print("wrote", OUT)
