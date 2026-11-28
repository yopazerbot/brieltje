"""Build the market stall of the Zombies game (web/src/world/stall.ts) in Blender, its textures baked.

Run (Blender 5, no window):
  blender -b -P tools/market_stall.py -- <out.glb> [preview_dir] [--cpu]

A village market stall as they stand at a kermis or a Saturday market: a frame of steel tubes held with clamps,
a striped cotton canvas tied over it with rope, sagging between the rafters, a scalloped valance along its front
and sides; a trestle table of worn planks, a green cloth clipped along its front, fruit crates under it; an enamel
lamp on its cord from the middle rafter, the cable along the frame to a box on a back post. Shut (in a wave), an
olive tarp over the table, tied down with two ropes.

The sizes are the game's (stall.ts): the table's top 2.4 by 0.8 m at 0.925 m (the goods lie on it), the posts at
its corners, the canvas from about 2.33 m at the back down to 2.0 m at its front edge, the bulb at 1.75 m, 0.3 m
in from the table's front. Everything stays in STALL.box (shared/stall.mjs) but the canvas and its valance.

The textures are CC0 from Poly Haven (rough_linen, wood_table_worn, rough_wood, metal_plate_02), downloaded once
into source/textures/ (git-ignored). Cycles bakes them, with the colours, the stripes, the wear and the ambient
occlusion (a ground under it), onto one atlas per mesh: colour (occlusion multiplied in), a tangent-space normal
map and metal/roughness (green: roughness, blue: metal), these two at half the colour's size. Only the baked maps
go into the GLB.

Output: one GLB with Stall (1024 px colour), Cover (the tarp, 512 px colour) and the goods, one mesh a thing
(Good_medkit and so on, in STALL.items' order, and Good_tray, the grenades' tray; one material, 512 px maps),
all in place on the table.
The GLB's frame is the game's local frame: the origin on the ground under the table's middle, the front along -z.
With preview_dir it also renders the baked model in daylight there: three-quarter front and back, front, a
close-up and the stall shut.
"""
import math
import os
import random
import sys
import urllib.request
import json
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:]
CPU = "--cpu" in argv
argv = [a for a in argv if not a.startswith("--")]
OUT = argv[0]
PREVIEW = argv[1] if len(argv) > 1 else ""
ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "source" / "textures"
random.seed(7)
bpy.ops.wm.read_factory_settings(use_empty=True)

# The game's sizes (web/src/world/stall.ts, stallAim.ts)
TOP_Y = 0.925
TABLE_HX, TABLE_HZ = 1.2, 0.4
ITEM_X = [0.34 * (3 - i) for i in range(7)]
ITEM_Z = -0.05
BULB = (0.0, 1.75, -0.3)
POST_X, POST_Z = 1.24, 0.43
POST_R = 0.019
RAIL_FRONT, RAIL_BACK = 2.051, 2.301  # the rails' centres; the canvas lies on them
CANVAS_X = 1.4
CANVAS_BACK, CANVAS_FRONT = 0.5, -0.85
STRIPE = 2 * CANVAS_X / 11  # eleven stripes, red at both ends


def G(x, y, z):
    """The game's frame (y up, front -z) to Blender's (z up); the GLB export turns it back."""
    return Vector((x, -z, y))


# ------------------------------------------------------------------------------------------------ textures
def fetch(url, dest):
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "briel-walkthrough/0.1"})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        f.write(r.read())
    return dest


def poly_haven(asset):
    """The asset's 1k colour, normal (OpenGL) and roughness maps: {kind: path}, 'arm' when roughness is packed."""
    req = urllib.request.Request(f"https://api.polyhaven.com/files/{asset}", headers={"User-Agent": "briel-walkthrough/0.1"})
    listing = CACHE / asset / "files.json"
    if listing.exists():
        files = json.loads(listing.read_text())
    else:
        with urllib.request.urlopen(req, timeout=60) as r:
            files = json.load(r)
        listing.parent.mkdir(parents=True, exist_ok=True)
        listing.write_text(json.dumps(files))
    out = {}
    for kind, keys in (("color", ["Diffuse"]), ("normal", ["nor_gl"]), ("rough", ["Rough", "arm"])):
        key = next(k for k in keys if k in files)
        url = files[key]["1k"]["jpg"]["url"]
        out[kind] = fetch(url, CACHE / asset / Path(url).name)
        if kind == "rough":
            out["arm"] = key == "arm"
    return out


# ------------------------------------------------------------------------------------------------ materials
def node(nt, kind, **inputs):
    n = nt.nodes.new(kind)
    for k, v in inputs.items():
        n.inputs[k].default_value = v
    return n


def srgb(hex_):
    """'#rrggbb' to linear RGBA."""
    def lin(c):
        c /= 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (lin(int(hex_[1:3], 16)), lin(int(hex_[3:5], 16)), lin(int(hex_[5:7], 16)), 1.0)


def mix(nt, a, b, fac, blend="MIX"):
    m = nt.nodes.new("ShaderNodeMix")
    m.data_type = "RGBA"
    m.blend_type = blend
    for sock, v in (("Factor", fac), ("A", a), ("B", b)):
        if isinstance(v, (int, float, tuple)):
            m.inputs[sock].default_value = v
        else:
            nt.links.new(v, m.inputs[sock])
    return m.outputs["Result"]


def mixf(nt, a, b, fac):
    """a to b by fac, as floats (a roughness)."""
    m = nt.nodes.new("ShaderNodeMix")
    m.data_type = "FLOAT"
    for sock, v in (("Factor", fac), ("A", a), ("B", b)):
        if isinstance(v, (int, float)):
            m.inputs[sock].default_value = v
        else:
            nt.links.new(v, m.inputs[sock])
    return m.outputs["Result"]


def math_(nt, op, a, b=0.0, clamp=False):
    m = nt.nodes.new("ShaderNodeMath")
    m.operation = op
    m.use_clamp = clamp
    for i, v in enumerate((a, b)):
        if isinstance(v, (int, float)):
            m.inputs[i].default_value = v
        else:
            nt.links.new(v, m.inputs[i])
    return m.outputs[0]


MATS = {}


def tex_material(name, asset, size, tint, sat=1.0, bright=1.0, rough=1.0, metal=0.0, nstrength=1.0, shade=None):
    """A material from a Poly Haven texture at `size` metres a tile on the 'tex' UVs, its colour desaturated by
    `sat`, times `bright` and `tint`. `shade(nt, colour, rough)`: more nodes on the colour and roughness (the
    stripes, rust, wear); returns (colour, rough)."""
    t = poly_haven(asset)
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    uv = nt.nodes.new("ShaderNodeUVMap")
    uv.uv_map = "tex"
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (1 / size, 1 / size, 1)
    nt.links.new(uv.outputs["UV"], mp.inputs["Vector"])

    def image(path, colour):
        n = nt.nodes.new("ShaderNodeTexImage")
        n.image = bpy.data.images.load(str(path), check_existing=True)
        n.image.colorspace_settings.name = "sRGB" if colour else "Non-Color"
        nt.links.new(mp.outputs["Vector"], n.inputs["Vector"])
        return n

    hsv = node(nt, "ShaderNodeHueSaturation", Saturation=sat, Value=bright)
    nt.links.new(image(t["color"], True).outputs["Color"], hsv.inputs["Color"])
    colour = mix(nt, hsv.outputs["Color"], tint, 1.0, "MULTIPLY")
    rimg = image(t["rough"], False)
    if t["arm"]:
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(rimg.outputs["Color"], sep.inputs["Color"])
        r = sep.outputs["Green"]
    else:
        r = rimg.outputs["Color"]
    r = math_(nt, "MULTIPLY", r, rough, clamp=True)
    if shade:
        colour, r = shade(nt, colour, r)
    nt.links.new(colour, p.inputs["Base Color"])
    nt.links.new(r, p.inputs["Roughness"])
    p.inputs["Metallic"].default_value = metal
    nm = node(nt, "ShaderNodeNormalMap", Strength=nstrength)
    nm.uv_map = "tex"
    nt.links.new(image(t["normal"], False).outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], p.inputs["Normal"])
    m["metal"] = metal
    MATS[name] = m
    return m


def plain_material(name, hex_, rough, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = srgb(hex_)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    m["metal"] = metal
    MATS[name] = m
    return m


def position(nt):
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(nt.nodes.new("ShaderNodeNewGeometry").outputs["Position"], sep.inputs[0])
    return sep


def noise(nt, scale, detail=4.0, stretch=(1, 1, 1)):
    n = node(nt, "ShaderNodeTexNoise", Scale=scale, Detail=detail)
    if stretch != (1, 1, 1):
        mp = nt.nodes.new("ShaderNodeMapping")
        mp.inputs["Scale"].default_value = stretch
        nt.links.new(nt.nodes.new("ShaderNodeNewGeometry").outputs["Position"], mp.inputs["Vector"])
        nt.links.new(mp.outputs["Vector"], n.inputs["Vector"])
    else:
        nt.links.new(nt.nodes.new("ShaderNodeNewGeometry").outputs["Position"], n.inputs["Vector"])
    return n.outputs["Fac"]


def smooth(nt, v, lo, hi):
    """smoothstep(lo, hi, v) via a Map Range node."""
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.interpolation_type = "SMOOTHSTEP"
    mr.inputs["From Min"].default_value = lo
    mr.inputs["From Max"].default_value = hi
    nt.links.new(v, mr.inputs["Value"])
    return mr.outputs["Result"]


def canvas_shade(nt, colour, rough):
    """Red and cream stripes across x; bleached where the sun falls (facing up), grubby along the front edge and
    where rain runs off, a cloudy dirt over it all."""
    pos = position(nt)
    s = math_(nt, "ADD", pos.outputs["X"], CANVAS_X)
    s = math_(nt, "FLOOR", math_(nt, "DIVIDE", s, STRIPE))
    stripe = math_(nt, "MODULO", s, 2.0)
    tint = mix(nt, srgb("#9a2a22"), srgb("#e6dcc4"), stripe)
    c = mix(nt, colour, tint, 1.0, "MULTIPLY")
    up = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(nt.nodes.new("ShaderNodeNewGeometry").outputs["Normal"], up.inputs[0])
    bleach = math_(nt, "MULTIPLY", smooth(nt, up.outputs["Z"], 0.3, 0.9), 0.22)
    c = mix(nt, c, srgb("#d8cdb4"), bleach)
    # Rain runs off the front: streaks down the slope (along y in Blender), stronger near the edge.
    streak = smooth(nt, noise(nt, 6.0, 3.0, (9.0, 0.6, 9.0)), 0.5, 0.72)
    edge = smooth(nt, math_(nt, "MULTIPLY", pos.outputs["Y"], 1.0), 0.45, 0.9)  # Blender y = -game z: the front
    grime = math_(nt, "MULTIPLY", math_(nt, "ADD", math_(nt, "MULTIPLY", streak, 0.6), 0.25), edge)
    c = mix(nt, c, srgb("#4a4034"), math_(nt, "MULTIPLY", grime, 0.45))
    cloud = smooth(nt, noise(nt, 2.2, 5.0), 0.45, 0.75)
    c = mix(nt, c, srgb("#6d6250"), math_(nt, "MULTIPLY", cloud, 0.18))
    return c, rough


def steel_shade(nt, colour, rough):
    """Galvanised tube: dull, mottled; rust and dirt low down, where it stands in the wet."""
    pos = position(nt)
    low = math_(nt, "SUBTRACT", 1.0, smooth(nt, pos.outputs["Z"], 0.0, 0.45))
    rust = math_(nt, "MULTIPLY", low, smooth(nt, noise(nt, 18.0, 6.0), 0.42, 0.62))
    c = mix(nt, colour, srgb("#6b4a33"), math_(nt, "MULTIPLY", rust, 0.85))
    r = mixf(nt, rough, 0.9, rust)
    mottle = smooth(nt, noise(nt, 30.0, 3.0), 0.3, 0.7)
    c = mix(nt, c, srgb("#8d9294"), math_(nt, "MULTIPLY", mottle, 0.25))
    return c, r


def cloth_shade(nt, colour, rough):
    """Dirt splashed up the hem."""
    pos = position(nt)
    low = math_(nt, "SUBTRACT", 1.0, smooth(nt, pos.outputs["Z"], 0.1, 0.4))
    c = mix(nt, colour, srgb("#3b3328"), math_(nt, "MULTIPLY", low, 0.5))
    return c, rough


def wood_shade(nt, colour, rough):
    """Greyed by the weather in patches, darker in the grain's dirt."""
    grey = smooth(nt, noise(nt, 3.0, 4.0), 0.4, 0.7)
    c = mix(nt, colour, srgb("#8a8378"), math_(nt, "MULTIPLY", grey, 0.3))
    return c, rough


canvas = tex_material("canvas", "rough_linen", 0.27, (1, 1, 1, 1), sat=0.0, bright=1.25, rough=1.0, nstrength=0.8, shade=canvas_shade)
valance = canvas  # one cloth
skirt = tex_material("skirt", "rough_linen", 0.27, srgb("#3a5a3c"), sat=0.0, bright=1.1, nstrength=0.8, shade=cloth_shade)
tarp = tex_material("tarp", "rough_linen", 0.35, srgb("#5f6340"), sat=0.0, bright=1.0, rough=0.95, nstrength=1.0, shade=cloth_shade)
woods = [tex_material(f"plank{i}", "wood_table_worn", 0.55, srgb(h), sat=0.5, bright=b, rough=1.6, shade=wood_shade)
         for i, (h, b) in enumerate((("#d9c3a4", 1.0), ("#cdb293", 0.92), ("#e0ccb0", 1.05)))]
trestle = tex_material("trestle", "wood_table_worn", 0.55, srgb("#b59a7c"), sat=0.5, bright=0.8, rough=1.6, shade=wood_shade)
crate = tex_material("crate", "rough_wood", 0.5, srgb("#e8d2b0"), sat=0.6, bright=1.15, rough=1.4, shade=wood_shade)
steel = tex_material("steel", "metal_plate_02", 0.8, srgb("#c4c9cb"), sat=0.0, bright=1.8, rough=1.1, metal=0.3, nstrength=0.4, shade=steel_shade)
rope = tex_material("rope", "rough_linen", 0.06, srgb("#b49a72"), sat=0.0, bright=1.0, nstrength=1.6)
enamel_out = plain_material("enamel_out", "#2f4a3a", 0.28)
enamel_in = plain_material("enamel_in", "#e8e2d2", 0.3)
glass = plain_material("glass", "#d8d2c4", 0.35)
rubber = plain_material("rubber", "#1c1c1c", 0.6)
boxgrey = plain_material("boxgrey", "#7d8078", 0.55)

# ------------------------------------------------------------------------------------------------ geometry
STALL, COVER = [], []


def finish(obj, mat, group, tex_scale=1.0):
    """Give `obj` its material and a 'tex' UV map (cube projection in metres, unless it has one) and file it."""
    obj.data.materials.clear()
    if isinstance(mat, (list, tuple)):
        for m in mat:
            obj.data.materials.append(m)
    else:
        obj.data.materials.append(mat)
    if not obj.data.uv_layers:
        bpy.ops.object.select_all(action="DESELECT")
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.cube_project(cube_size=tex_scale, correct_aspect=False, scale_to_bounds=False)
        bpy.ops.object.mode_set(mode="OBJECT")
    obj.data.uv_layers[0].name = "tex"
    group.append(obj)
    return obj


def apply_mods(obj):
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    for m in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def bevel(obj, width, segs=1):
    m = obj.modifiers.new("bevel", "BEVEL")
    m.width, m.segments, m.limit_method = width, segs, "ANGLE"
    apply_mods(obj)


def cuboid(name, cx, cy, cz, w, h, d, mat, group=STALL, bev=0.003, rot=(0, 0, 0)):
    """A box w (x) by h (y) by d (z) centred on (cx, cy, cz), game frame; `rot` in the game's axes (radians)."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector((w, d, h)), verts=bm.verts)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    rx, ry, rz = rot
    obj.matrix_world = Matrix.Translation(G(cx, cy, cz)) @ Matrix.Rotation(ry, 4, "Z") @ Matrix.Rotation(-rz, 4, "Y") @ Matrix.Rotation(-rx, 4, "X")
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if bev:
        bevel(obj, bev)
    return finish(obj, mat, group)


def beam(name, a, b, w, mat, group=STALL, bev=0.003):
    """A square beam w by w from a to b (game frame)."""
    pa, pb = G(*a), G(*b)
    d = pb - pa
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector((w, w, d.length)), verts=bm.verts)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    obj.matrix_world = Matrix.Translation((pa + pb) / 2) @ d.to_track_quat("Z", "Y").to_matrix().to_4x4()
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if bev:
        bevel(obj, bev)
    return finish(obj, mat, group)


def tube(name, a, b, r, mat, group=STALL, seg=12, caps=True):
    """A round tube from a to b (game frame)."""
    pa, pb = G(*a), G(*b)
    d = pb - pa
    bpy.ops.mesh.primitive_cylinder_add(vertices=seg, radius=r, depth=d.length, location=(pa + pb) / 2,
                                        end_fill_type="NGON" if caps else "NOTHING")
    obj = bpy.context.active_object
    obj.name = name
    obj.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return finish(obj, mat, group)


def path_tube(name, pts, r, mat, group=STALL, seg=8):
    """A tube along a polyline of game points (a cable, a rope), as a curve with a round bevel."""
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = r
    cu.bevel_resolution = max(1, seg // 4)
    cu.use_fill_caps = True
    sp = cu.splines.new("POLY")
    sp.points.add(len(pts) - 1)
    for p, q in zip(sp.points, pts):
        p.co = (*G(*q), 1)
    ob = bpy.data.objects.new(name, cu)
    bpy.context.scene.collection.objects.link(ob)
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.convert(target="MESH")
    obj = bpy.context.active_object
    return finish(obj, mat, group, tex_scale=0.3)


def torus(name, at, axis, R, r, mat, group=STALL):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, major_segments=16, minor_segments=6, location=G(*at))
    obj = bpy.context.active_object
    obj.name = name
    obj.rotation_euler = G(*axis).to_track_quat("Z", "Y").to_euler()
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return finish(obj, mat, group, tex_scale=0.2)


def sheet(name, nu, nv, at, mat, group, thick, uv_size):
    """A cloth: a grid of nu by nv cells at `at(u, v)` (game points, u and v from 0 to 1), its 'tex' UVs
    uv_size(u, v) in metres, made `thick` with a solidify."""
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new("tex")
    vs = [[bm.verts.new(G(*at(i / nu, j / nv))) for i in range(nu + 1)] for j in range(nv + 1)]
    for j in range(nv):
        for i in range(nu):
            f = bm.faces.new((vs[j][i], vs[j][i + 1], vs[j + 1][i + 1], vs[j + 1][i]))
            for lp, (a, b) in zip(f.loops, ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1))):
                lp[uvl].uv = uv_size(a / nu, b / nv)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    if thick:
        s = obj.modifiers.new("solid", "SOLIDIFY")
        s.thickness, s.offset = thick, 0.0
        apply_mods(obj)
    return finish(obj, mat, group)


# ---- the canvas
def frac(v):
    return v - math.floor(v)


def canvas_y(x, z):
    """The canvas's height at (x, z): on the rails, sagging between the rafters and the rails, drooping where it
    hangs over the frame."""
    if z >= POST_Z:  # over the back rail and down a little
        t = (z - POST_Z) / (CANVAS_BACK - POST_Z)
        base = RAIL_BACK + 0.024 - 0.035 * t * t
    elif z >= -POST_Z:
        base = RAIL_FRONT + 0.024 + (z + POST_Z) / (2 * POST_Z) * (RAIL_BACK - RAIL_FRONT)
    else:
        t = (-POST_Z - z) / (-CANVAS_FRONT - POST_Z)  # 0 at the rail, 1 at the edge
        base = RAIL_FRONT + 0.024 - 0.03 * t
    ax = abs(x)
    if ax <= POST_X:
        sx = math.sin(math.pi * frac((x + POST_X) / POST_X))  # spans from -1.24 to 0 and 0 to 1.24
        over = 0.0
    else:
        sx = 0.0
        over = 0.03 * ((ax - POST_X) / (CANVAS_X - POST_X)) ** 1.5
    if -POST_Z < z < POST_Z:
        sz = math.sin(math.pi * (z + POST_Z) / (2 * POST_Z))
        sag = 0.026 * sx * sz + 0.006 * sz
    elif z <= -POST_Z:
        t = (-POST_Z - z) / (-CANVAS_FRONT - POST_Z)
        sag = (0.012 + 0.018 * sx) * t ** 1.4
    else:
        sag = 0.0
    wrinkle = 0.0025 * sx * math.sin(x * 37 + z * 11) * math.sin(z * 23 - x * 5)
    return base - sag - over + wrinkle


def canvas_at(u, v):
    x = -CANVAS_X + 2 * CANVAS_X * u
    z = CANVAS_BACK + (CANVAS_FRONT - CANVAS_BACK) * v
    return (x, canvas_y(x, z), z)


sheet("Canvas", 70, 30, canvas_at, canvas, STALL, 0.004, lambda u, v: (u * 2 * CANVAS_X, v * 1.4))


def valance_front(u, v):
    x = -CANVAS_X + 2 * CANVAS_X * u
    top = canvas_y(x, CANVAS_FRONT) + 0.001  # into the canvas's edge: no gap to see the sky through
    drop = 0.125 + 0.035 * math.sin(math.pi * frac((x + CANVAS_X) / STRIPE * 2))  # two scallops a stripe
    fold = 0.005 * math.sin(2 * math.pi * x / 0.09) * v
    return (x, top - drop * v, CANVAS_FRONT - 0.0005 + fold)


sheet("ValanceFront", 176, 4, valance_front, valance, STALL, 0.003, lambda u, v: (u * 2 * CANVAS_X, v * 0.16))


def valance_side(sgn):
    def at(u, v):
        z = CANVAS_BACK - 0.03 + (CANVAS_FRONT - CANVAS_BACK + 0.03) * u
        x = sgn * (CANVAS_X + 0.0005)
        top = canvas_y(x * 0.999, z) + 0.001
        drop = 0.09 + 0.025 * math.sin(math.pi * frac(z / STRIPE * 2))
        return (x + sgn * 0.004 * math.sin(2 * math.pi * z / 0.09) * v, top - drop * v, z)
    return at


for s in (-1, 1):
    sheet(f"ValanceSide{s}", 72, 3, valance_side(s), valance, STALL, 0.003, lambda u, v: (u * 1.35, v * 0.12))

# ---- the frame: posts into the ground, rails and rafters, clamps at the joints, the canvas tied on with rope
for sx in (-1, 1):
    for z, top in ((-POST_Z, RAIL_FRONT), (POST_Z, RAIL_BACK)):
        tube(f"Post{sx}{z}", (sx * POST_X, -0.3, z), (sx * POST_X, top + 0.03, z), POST_R, steel)
        tube(f"Clamp{sx}{z}", (sx * POST_X, top - 0.05, z), (sx * POST_X, top + 0.035, z), 0.026, steel, seg=14)
        tube(f"Bolt{sx}{z}", (sx * POST_X, top - 0.02, z - 0.035), (sx * POST_X, top - 0.02, z + 0.035), 0.006, steel, seg=6)
        tube(f"Cap{sx}{z}", (sx * POST_X, top + 0.035, z), (sx * POST_X, top + 0.045, z), 0.021, rubber, seg=12)
for z, y in ((-POST_Z, RAIL_FRONT), (POST_Z, RAIL_BACK)):
    tube(f"Rail{z}", (-POST_X - 0.02, y, z), (POST_X + 0.02, y, z), POST_R, steel)
for x in (-POST_X, 0.0, POST_X):
    tube(f"Rafter{x}", (x, RAIL_FRONT, -POST_Z - 0.02), (x, RAIL_BACK, POST_Z + 0.02), POST_R * 0.9, steel)
    tube(f"RafterClampF{x}", (x - 0.035, RAIL_FRONT, -POST_Z), (x + 0.035, RAIL_FRONT, -POST_Z), 0.025, steel, seg=12)
    tube(f"RafterClampB{x}", (x - 0.035, RAIL_BACK, POST_Z), (x + 0.035, RAIL_BACK, POST_Z), 0.025, steel, seg=12)
# A brace along each side, low, that holds the posts square.
for sx in (-1, 1):
    tube(f"Brace{sx}", (sx * POST_X, 0.32, -POST_Z), (sx * POST_X, 0.32, POST_Z), 0.014, steel)
    for z in (-POST_Z, POST_Z):
        tube(f"BraceClamp{sx}{z}", (sx * POST_X, 0.29, z), (sx * POST_X, 0.35, z), 0.022, steel, seg=12)
# Rope ties: the canvas lashed to the front and back rails, three turns each.
for z, y in ((-POST_Z, RAIL_FRONT), (POST_Z, RAIL_BACK)):
    for x in (-1.0, -0.45, 0.45, 1.0):
        for k in range(3):
            torus(f"Tie{z}{x}{k}", (x + (k - 1) * 0.011, y + 0.006, z), (1, 0, 0), 0.027, 0.0045, rope)

# ---- the table: five planks on three battens on two trestles
PLANK_W, GAP, PLANK_T = 0.152, 0.008, 0.028
for i in range(5):
    z = -TABLE_HZ + PLANK_W / 2 + i * (PLANK_W + GAP)
    cuboid(f"Plank{i}", random.uniform(-0.01, 0.01), TOP_Y - PLANK_T / 2 - random.uniform(0, 0.0012), z,
           2.4 - random.uniform(0, 0.02), PLANK_T, PLANK_W, woods[i % 3], bev=0.004, rot=(0, random.uniform(-0.004, 0.004), 0))
for x in (-1.0, 0.0, 1.0):
    cuboid(f"Batten{x}", x, TOP_Y - PLANK_T - 0.011, 0, 0.045, 0.022, 0.78, trestle, bev=0.003)
for sx in (-1, 1):
    tx = sx * 0.82
    cuboid(f"TrestleTop{sx}", tx, TOP_Y - PLANK_T - 0.022 - 0.025, 0, 0.07, 0.05, 0.74, trestle, bev=0.004)
    for z in (-0.3, 0.3):
        for lx in (-1, 1):
            # A leg from under the beam out to the ground, an A seen from the front.
            top = Vector((tx + lx * 0.02, TOP_Y - 0.1, z))
            foot = Vector((tx + lx * 0.15, -0.05, z * 1.1))
            beam(f"Leg{sx}{z}{lx}", top, foot, 0.042, trestle)
    cuboid(f"TrestleBrace{sx}", tx, 0.36, 0, 0.03, 0.06, 0.66, trestle, bev=0.003)

# ---- the cloth clipped along the front and down the sides, its back open
def skirt_front(u, v):
    x = -TABLE_HX - 0.012 + (2 * TABLE_HX + 0.024) * u
    amp = 0.35 + 0.65 * (0.5 + 0.5 * math.sin(x * 1.7 + 0.3)) * (0.6 + 0.4 * math.sin(x * 4.9))
    fold = (0.002 + 0.012 * v) * amp * (0.6 * math.sin(2 * math.pi * x / 0.31 + 2.2 * math.sin(x * 2.3))
                                         + 0.3 * math.sin(2 * math.pi * x / 0.13 + 0.5) + 0.1 * math.sin(2 * math.pi * x / 0.07))
    y = TOP_Y - 0.006 - (0.78 + 0.02 * math.sin(x * 9)) * v
    return (x, y, -TABLE_HZ - 0.012 - 0.006 * v + fold)


sheet("SkirtFront", 160, 10, skirt_front, skirt, STALL, 0.003, lambda u, v: (u * 2.42, v * 0.78))


def skirt_side(sgn):
    def at(u, v):
        z = -TABLE_HZ - 0.012 + 0.62 * u
        fold = (0.003 + 0.01 * v) * (0.65 * math.sin(2 * math.pi * z / 0.24 + 1.3) + 0.35 * math.sin(2 * math.pi * z / 0.1))
        return (sgn * (TABLE_HX + 0.012 + 0.006 * v + fold), TOP_Y - 0.006 - 0.78 * v, z)
    return at


for s in (-1, 1):
    sheet(f"SkirtSide{s}", 40, 10, skirt_side(s), skirt, STALL, 0.003, lambda u, v: (u * 0.62, v * 0.78))
for x in (-1.0, -0.5, 0.0, 0.5, 1.0):
    cuboid(f"Clip{x}", x, TOP_Y - 0.012, -TABLE_HZ - 0.004, 0.035, 0.04, 0.03, steel, bev=0.002)

# ---- fruit crates under the table, at the back
def fruit_crate(name, cx, cy, cz, yaw):
    W, H, D = 0.5, 0.28, 0.3
    parts = []
    m = Matrix.Translation(G(cx, cy, cz)) @ Matrix.Rotation(yaw, 4, "Z")
    for i in range(3):  # the bottom
        parts.append((0, 0.008, -D / 2 + 0.05 + i * 0.1, W - 0.02, 0.012, 0.085))
    for side in (-1, 1):
        for k in range(3):  # the long sides, three slats with gaps
            parts.append((0, 0.04 + k * 0.095, side * (D / 2 - 0.006), W - 0.03, 0.06, 0.01))
        parts.append((side * (W / 2 - 0.009), H / 2, 0, 0.018, H, D))  # the end boards
    for k, (px, py, pz, w, h, d) in enumerate(parts):
        o = cuboid(f"{name}{k}", 0, 0, 0, w, h, d, crate, bev=0.0015)
        o.data.transform(m @ Matrix.Translation(G(px, py, pz)))


fruit_crate("CrateA", -0.33, -0.02, 0.1, 0.04)
fruit_crate("CrateB", -0.32, 0.265, 0.09, -0.05)
fruit_crate("CrateC", 0.3, -0.02, 0.12, -0.08)

# ---- the lamp: an enamel shade on its cord from the middle rafter, the cable along the frame to a box
bx, by, bz = BULB
bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=0.105, radius2=0.024, depth=0.075, location=G(bx, by + 0.052, bz), end_fill_type="NOTHING")
shade = bpy.context.active_object
shade.name = "Shade"
sol = shade.modifiers.new("solid", "SOLIDIFY")
sol.thickness, sol.material_offset = 0.003, 1
shade.data.materials.append(enamel_out)
shade.data.materials.append(enamel_in)
apply_mods(shade)
bpy.ops.object.select_all(action="DESELECT")
bpy.context.view_layer.objects.active = shade
shade.select_set(True)
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.cube_project(cube_size=1.0)
bpy.ops.object.mode_set(mode="OBJECT")
shade.data.uv_layers[0].name = "tex"
STALL.append(shade)
tube("Socket", (bx, by + 0.085, bz), (bx, by + 0.125, bz), 0.016, rubber, seg=12)
bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=10, radius=0.040, location=G(bx, by, bz))
finish(bpy.context.active_object, glass, STALL)
rafter_y = RAIL_FRONT + (bz + POST_Z) / (2 * POST_Z) * (RAIL_BACK - RAIL_FRONT)
path_tube("Cord", [(bx, by + 0.125, bz), (bx, rafter_y - 0.02, bz), (bx + 0.004, rafter_y - 0.024, bz + 0.04)], 0.0035, rubber)
torus("CordLoop", (bx, rafter_y, bz + 0.02), (0, 0, 1), 0.024, 0.0035, rubber)
# The cable along the rafter's underside to the back rail, along it to the right post, down to a box.
cab = []
for k in range(9):
    z = bz + 0.04 + (POST_Z - 0.03 - bz - 0.04) * k / 8
    y = RAIL_FRONT + (z + POST_Z) / (2 * POST_Z) * (RAIL_BACK - RAIL_FRONT) - 0.024 - 0.006 * math.sin(math.pi * frac(k / 4))
    cab.append((0.0, y, z))
for k in range(1, 9):
    x = (POST_X - 0.03) * k / 8
    cab.append((x, RAIL_BACK - 0.026 - 0.01 * math.sin(math.pi * frac(k / 4)), POST_Z - 0.026))
cab += [(POST_X - 0.025, RAIL_BACK - 0.07, POST_Z - 0.02), (POST_X - 0.023, 1.45, POST_Z - 0.022)]
path_tube("Cable", cab, 0.0035, rubber)
cuboid("JunctionBox", POST_X - 0.025, 1.37, POST_Z - 0.03, 0.07, 0.1, 0.045, boxgrey, bev=0.006)
for y in (1.6, 1.9):
    torus(f"CableTie{y}", (POST_X, y, POST_Z), (0, 1, 0), 0.024, 0.003, rubber)

# ---- the tarp over the table when shut, tied down with two ropes
EDGE = 0.025
TARP_H = [0.13, 0.17, 0.1, 0.15, 0.12, 0.16, 0.11]


def tarp_y(x, z):
    d = min(TABLE_HX + EDGE - abs(x), TABLE_HZ + EDGE - abs(z))
    env = 0.0  # the goods under it, some taller: the cloth over the highest, sagging between
    for xi, hi in zip(ITEM_X, TARP_H):
        env = max(env, hi * math.exp(-((x - xi) / 0.24) ** 2 - ((z - ITEM_Z) / 0.26) ** 2))
    t = min(1.0, max(0.0, d / 0.12))
    t = t * t * (3 - 2 * t)
    wrinkle = 0.004 * math.sin(x * 23 + z * 7) * math.sin(z * 17 - x * 3)
    return TOP_Y + 0.012 + (env + 0.02) * t + wrinkle * t


def tarp_at(u, v):
    x = -(TABLE_HX + EDGE) + 2 * (TABLE_HX + EDGE) * u
    z = -(TABLE_HZ + EDGE) + 2 * (TABLE_HZ + EDGE) * v
    return (x, tarp_y(x, z), z)


sheet("TarpTop", 64, 22, tarp_at, tarp, COVER, 0.003, lambda u, v: (u * 2.45, v * 0.85))
# The tarp's sides: a band round the table's edge, hanging down with folds.
PER = 2 * (2 * (TABLE_HX + EDGE) + 2 * (TABLE_HZ + EDGE))


def ring_at(s):
    """The point at length s round the edge (from the front left corner, anticlockwise seen from above) and its outward direction."""
    a, b = TABLE_HX + EDGE, TABLE_HZ + EDGE
    s %= PER
    for (x0, z0, dx, dz, n), L in (((-a, -b, 1, 0, (0, -1)), 2 * a), ((a, -b, 0, 1, (1, 0)), 2 * b),
                                   ((a, b, -1, 0, (0, 1)), 2 * a), ((-a, b, 0, -1, (-1, 0)), 2 * b)):
        if s <= L:
            return x0 + dx * s, z0 + dz * s, n
        s -= L
    return -a, -b, (0, -1)


def band_at(u, v):
    x, z, (nx, nz) = ring_at(u * PER)
    fold = (0.003 + 0.02 * v) * (0.5 + 0.5 * math.sin(u * PER * 2 * math.pi / 0.23))
    return (x + nx * fold, TOP_Y + 0.013 - 0.16 * v - 0.015 * v * math.sin(u * 41), z + nz * fold)


sheet("TarpBand", 200, 3, band_at, tarp, COVER, 0.003, lambda u, v: (u * PER, v * 0.16))
for x in (-0.51, 0.51):
    pts = [(x, TOP_Y - 0.12, -TABLE_HZ - EDGE - 0.02)]
    for k in range(25):
        z = -(TABLE_HZ + EDGE) + 2 * (TABLE_HZ + EDGE) * k / 24
        pts.append((x, tarp_y(x, z) + 0.009, z - 0.006 * (1 if k == 0 else 0)))
    pts.append((x, TOP_Y - 0.12, TABLE_HZ + EDGE + 0.02))
    path_tube(f"TarpRope{x}", pts, 0.006, rope, COVER)

# ------------------------------------------------------------------------------------------------ the goods
# The seven things sold, each at its place on the table (stallAim ITEM_X, ITEM_Z), facing the front (-z): what a
# pickup of that kind gives (world/rewards.ts draws their signs), as real things. In STALL.items' order. The laser
# rifle is the game's own model (lasergun.glb), laid on the cradle here by stall.ts.
GOOD_KINDS = ["medkit", "nades", "claymore", "armor", "gun", "turret", "laser", "tray"]  # the grenades' tray apart: paintball paints them, not it
GOODS = {k: [] for k in GOOD_KINDS}
bag_red = tex_material("bag_red", "rough_linen", 0.12, srgb("#b02a2c"), sat=0.0, bright=1.15, nstrength=1.2)
patch_white = tex_material("patch_white", "rough_linen", 0.1, srgb("#ece8de"), sat=0.0, bright=1.2, nstrength=0.8)
webbing = tex_material("webbing", "rough_linen", 0.05, srgb("#2a2a2a"), sat=0.0, bright=1.0, nstrength=1.5)
navy = tex_material("navy", "rough_linen", 0.1, srgb("#28385a"), sat=0.0, bright=1.1, nstrength=1.4)
navy_dark = tex_material("navy_dark", "rough_linen", 0.05, srgb("#1b2740"), sat=0.0, bright=1.0, nstrength=1.6)
olive = tex_material("olive", "metal_plate_02", 0.35, srgb("#6f7744"), sat=0.0, bright=2.8, rough=1.2, metal=0.05, nstrength=0.5)
olive_steel = tex_material("olive_steel", "metal_plate_02", 0.35, srgb("#626a3c"), sat=0.0, bright=2.6, rough=0.9, metal=0.15, nstrength=0.5)
crate_olive = tex_material("crate_olive", "rough_wood", 0.4, srgb("#7a8452"), sat=0.25, bright=1.0, rough=1.3)
band_white = tex_material("band_white", "rough_wood", 0.4, srgb("#f0ece2"), sat=0.0, bright=1.8, rough=1.3)
tray_wood = tex_material("tray_wood", "rough_wood", 0.35, srgb("#d8c09a"), sat=0.6, bright=1.1, rough=1.4, shade=wood_shade)
felt = tex_material("felt", "rough_linen", 0.08, srgb("#3c2a24"), sat=0.0, bright=0.9, nstrength=0.6)
lens = plain_material("lens", "#151a1c", 0.12)


def good_cuboid(kind, name, x, y, z, w, h, d, mat, bev=0.003, segs=1, rot=(0, 0, 0)):
    o = cuboid(name, x, y, z, w, h, d, mat, GOODS[kind], bev=0 if segs > 1 else bev, rot=rot)
    if segs > 1:
        bevel(o, bev, segs)
    return o


T = TOP_Y
ZC = ITEM_Z

# 1. A red first-aid bag: padded, rounded, a zip round its lid, a white cross on its front and top, a webbing handle.
cx = ITEM_X[0]
good_cuboid("medkit", "Bag", cx, T + 0.068, ZC, 0.25, 0.136, 0.16, bag_red, bev=0.035, segs=4)
for nm_, (w, h) in (("CrossV", (0.024, 0.07)), ("CrossH", (0.07, 0.024))):
    good_cuboid("medkit", f"Front{nm_}", cx, T + 0.068, ZC - 0.0805, w, h, 0.003, patch_white, bev=0.001)
    good_cuboid("medkit", f"Top{nm_}", cx, T + 0.1365, ZC + 0.01, w, 0.003, h, patch_white, bev=0.001)
zip_pts = []
for k in range(41):  # the zip: round the bag's sides, 3 cm under its top, a rounded rectangle
    a = 2 * math.pi * k / 40
    zip_pts.append((cx + 0.126 * math.copysign(abs(math.cos(a)) ** 0.25, math.cos(a)),
                    T + 0.106, ZC + 0.081 * math.copysign(abs(math.sin(a)) ** 0.25, math.sin(a))))
path_tube("Zip", zip_pts, 0.0035, webbing, GOODS["medkit"])
path_tube("Handle", [(cx - 0.065, T + 0.13, ZC + 0.03), (cx - 0.05, T + 0.16, ZC + 0.03), (cx, T + 0.168, ZC + 0.03),
                     (cx + 0.05, T + 0.16, ZC + 0.03), (cx + 0.065, T + 0.13, ZC + 0.03)], 0.006, webbing, GOODS["medkit"])
good_cuboid("medkit", "ZipPull", cx + 0.1, T + 0.1, ZC - 0.083, 0.012, 0.025, 0.004, steel, bev=0.001)


# 2. Three frag grenades standing in a shallow wooden tray: an egg of olive steel, the fuze on top, its lever down
#    the side and the ring with its pin.
cx = ITEM_X[1]
good_cuboid("tray", "TrayBase", cx, T + 0.006, ZC, 0.27, 0.012, 0.13, tray_wood, bev=0.002)
for s in (-1, 1):
    good_cuboid("tray", f"TraySide{s}", cx, T + 0.024, ZC + s * 0.061, 0.27, 0.04, 0.008, tray_wood, bev=0.002)
    good_cuboid("tray", f"TrayEnd{s}", cx + s * 0.131, T + 0.024, ZC, 0.008, 0.04, 0.114, tray_wood, bev=0.002)


def grenade(gx, gz, yaw):
    base = T + 0.012
    bpy.ops.mesh.primitive_uv_sphere_add(segments=20, ring_count=12, radius=0.031, location=G(gx, base + 0.037, gz))
    body = bpy.context.active_object
    body.scale = (1, 1, 1.18)
    bpy.ops.object.transform_apply(scale=True)
    finish(body, olive_steel, GOODS["nades"])
    tube("Neck", (gx, base + 0.07, gz), (gx, base + 0.08, gz), 0.011, steel, GOODS["nades"], seg=12)
    tube("Fuze", (gx, base + 0.08, gz), (gx, base + 0.097, gz), 0.0135, steel, GOODS["nades"], seg=12)
    c, s = math.cos(yaw), math.sin(yaw)
    # The lever: from the fuze's top, out and down the body's side.
    lever = [(0.0, 0.098), (0.016, 0.097), (0.026, 0.085), (0.031, 0.06), (0.03, 0.035)]
    path_tube("Lever", [(gx + c * r, base + y, gz + s * r) for r, y in lever], 0.003, steel, GOODS["nades"], seg=4)
    torus("Ring", (gx - s * 0.02, base + 0.088, gz + c * 0.02), (c, 0, s), 0.011, 0.0016, steel, GOODS["nades"])


for i, (dx, yaw) in enumerate(((-0.08, 0.3), (0.0, -0.9), (0.08, 2.2))):
    grenade(cx + dx, ZC + (0.008 if i == 1 else -0.006), yaw)


# 3. A claymore: the curved olive case, convex face to the front, on two pairs of scissor legs, the fuze wells on top.
cx = ITEM_X[2]
CY0, CH, CW = T + 0.05, 0.085, 0.22


def claymore_face(u, v):
    x = -CW / 2 + CW * u
    return (cx + x, CY0 + CH * v, ZC - 0.012 - 0.016 * (1 - (2 * x / CW) ** 2))


case = sheet("ClaymoreCase", 20, 2, claymore_face, olive, GOODS["claymore"], 0.0, lambda u, v: (u * CW, v * CH))
sol = case.modifiers.new("solid", "SOLIDIFY")
sol.thickness, sol.offset, sol.use_even_offset = 0.034, -1.0, True
apply_mods(case)
bevel(case, 0.003)
for x in (-0.075, 0.075):
    for s in (-1, 1):  # each pair crossed, seen from the side
        tube("Leg", (cx + x, CY0 + 0.004, ZC + 0.006 + s * 0.012), (cx + x + 0.004, T, ZC + 0.006 - s * 0.03), 0.0025, steel, GOODS["claymore"], seg=6)
    tube("LegPivot", (cx + x - 0.006, CY0 + 0.002, ZC + 0.006), (cx + x + 0.006, CY0 + 0.002, ZC + 0.006), 0.004, olive, GOODS["claymore"], seg=8)
for x in (-0.045, 0.045):
    tube("Well", (cx + x, CY0 + CH - 0.004, ZC + 0.004), (cx + x, CY0 + CH + 0.01, ZC + 0.004), 0.008, olive, GOODS["claymore"], seg=10)
    tube("WellCap", (cx + x, CY0 + CH + 0.01, ZC + 0.004), (cx + x, CY0 + CH + 0.014, ZC + 0.004), 0.0095, webbing, GOODS["claymore"], seg=10)
tube("Sight", (cx, CY0 + CH - 0.002, ZC + 0.004), (cx, CY0 + CH + 0.012, ZC + 0.004), 0.004, olive, GOODS["claymore"], seg=6)


# 4. A plate carrier laid flat: the padded front panel, rows of webbing across it, the loop panel for patches, the
#    shoulder straps folded over its top, buckles.
cx = ITEM_X[3]
good_cuboid("armor", "Panel", cx, T + 0.02, ZC, 0.26, 0.04, 0.3, navy, bev=0.014, segs=3)
for k in range(4):
    z = ZC - 0.125 + k * 0.03
    good_cuboid("armor", f"Molle{k}", cx, T + 0.041, z, 0.236, 0.004, 0.019, navy_dark, bev=0.0012)
    for x in (-0.06, 0.0, 0.06):  # the stitched tacks between the loops
        good_cuboid("armor", f"Tack{k}{x}", cx + x, T + 0.0435, z, 0.004, 0.002, 0.02, webbing, bev=0.0)
good_cuboid("armor", "LoopPanel", cx, T + 0.0415, ZC + 0.03, 0.13, 0.004, 0.06, navy_dark, bev=0.0015)
for s in (-1, 1):
    good_cuboid("armor", f"Strap{s}", cx + s * 0.075, T + 0.046, ZC + 0.105, 0.055, 0.014, 0.1, navy, bev=0.005, segs=2)
    good_cuboid("armor", f"Buckle{s}", cx + s * 0.075, T + 0.055, ZC + 0.07, 0.04, 0.006, 0.022, webbing, bev=0.002)
    good_cuboid("armor", f"Cummerbund{s}", cx + s * 0.135, T + 0.015, ZC - 0.03, 0.03, 0.026, 0.2, navy, bev=0.008, segs=2)


# 5. A weapons crate: olive-painted planks, two white bands, steel corners, two latches, rope handles at its ends.
cx = ITEM_X[4]
CW5, CH5, CD5 = 0.28, 0.15, 0.17
good_cuboid("gun", "CrateBody", cx, T + 0.058, ZC, CW5, 0.116, CD5, crate_olive, bev=0.004)
good_cuboid("gun", "CrateLid", cx, T + 0.1345, ZC, CW5 + 0.004, 0.031, CD5 + 0.004, crate_olive, bev=0.004)
for k in range(1, 3):  # the plank seams on the front
    good_cuboid("gun", f"Seam{k}", cx, T + k * 0.039, ZC - CD5 / 2 - 0.0005, CW5 - 0.01, 0.002, 0.002, webbing, bev=0.0)
for x in (-0.07, 0.07):
    good_cuboid("gun", f"Band{x}", cx + x, T + 0.075, ZC, 0.034, 0.152, CD5 + 0.008, band_white, bev=0.002)
for sx in (-1, 1):
    for sy in (0.012, 0.138):
        for sz in (-1, 1):
            good_cuboid("gun", f"Corner{sx}{sy}{sz}", cx + sx * (CW5 / 2 - 0.006), T + sy, ZC + sz * (CD5 / 2 - 0.006), 0.018, 0.024, 0.018, steel, bev=0.002)
    good_cuboid("gun", f"Latch{sx}", cx + sx * 0.105, T + 0.118, ZC - CD5 / 2 - 0.004, 0.022, 0.03, 0.008, steel, bev=0.0015)
    path_tube(f"RopeHandle{sx}", [(cx + sx * (CW5 / 2 + 0.002), T + 0.1, ZC - 0.04), (cx + sx * (CW5 / 2 + 0.014), T + 0.085, ZC - 0.03),
                                  (cx + sx * (CW5 / 2 + 0.018), T + 0.078, ZC), (cx + sx * (CW5 / 2 + 0.014), T + 0.085, ZC + 0.03),
                                  (cx + sx * (CW5 / 2 + 0.002), T + 0.1, ZC + 0.04)], 0.005, rope, GOODS["gun"])


# 6. A small sentry turret on its tripod: the head (a box with an ammo can at its side), the barrel and its muzzle
#    brake to the front, a dark sensor, a carry handle.
cx = ITEM_X[5]
HUB = T + 0.165
for k in range(3):
    a = math.pi / 2 + k * 2 * math.pi / 3  # one leg to the back
    tube("TripodLeg", (cx, HUB, ZC), (cx + 0.115 * math.cos(a), T + 0.004, ZC + 0.115 * math.sin(a)), 0.006, olive_steel, GOODS["turret"], seg=8)
    tube("Foot", (cx + 0.115 * math.cos(a), T, ZC + 0.115 * math.sin(a)), (cx + 0.115 * math.cos(a), T + 0.008, ZC + 0.115 * math.sin(a)), 0.011, webbing, GOODS["turret"], seg=10)
tube("Hub", (cx, HUB - 0.03, ZC), (cx, HUB + 0.02, ZC), 0.02, olive_steel, GOODS["turret"], seg=14)
good_cuboid("turret", "Head", cx, HUB + 0.058, ZC + 0.01, 0.09, 0.07, 0.15, olive, bev=0.008, segs=2)
good_cuboid("turret", "AmmoCan", cx + 0.07, HUB + 0.05, ZC + 0.025, 0.045, 0.055, 0.085, olive_steel, bev=0.004, segs=2)
tube("Shroud", (cx, HUB + 0.058, ZC - 0.065), (cx, HUB + 0.058, ZC - 0.13), 0.016, olive_steel, GOODS["turret"], seg=12)
tube("Barrel", (cx, HUB + 0.058, ZC - 0.13), (cx, HUB + 0.058, ZC - 0.2), 0.0085, steel, GOODS["turret"], seg=12)
tube("Brake", (cx, HUB + 0.058, ZC - 0.195), (cx, HUB + 0.058, ZC - 0.222), 0.0135, steel, GOODS["turret"], seg=12)
bpy.ops.mesh.primitive_uv_sphere_add(segments=14, ring_count=8, radius=0.014, location=G(cx - 0.025, HUB + 0.075, ZC - 0.065))
finish(bpy.context.active_object, lens, GOODS["turret"])
path_tube("CarryHandle", [(cx, HUB + 0.093, ZC - 0.03), (cx, HUB + 0.115, ZC - 0.015), (cx, HUB + 0.115, ZC + 0.035),
                          (cx, HUB + 0.093, ZC + 0.05)], 0.005, webbing, GOODS["turret"])


# 7. The cradle the laser rifle lies on: two notched wooden blocks with felt on their tops.
cx = ITEM_X[6]
for x in (-0.085, 0.085):
    good_cuboid("laser", f"Cradle{x}", cx + x, T + 0.017, ZC, 0.035, 0.034, 0.11, tray_wood, bev=0.003)
    good_cuboid("laser", f"Felt{x}", cx + x, T + 0.0355, ZC, 0.033, 0.003, 0.1, felt, bev=0.001)


# ------------------------------------------------------------------------------------------------ join
def join(objs, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.active_object
    o.name = o.data.name = name
    o.data.set_sharp_from_angle(angle=math.radians(40))
    return o


stall = join(STALL, "Stall")
cover = join(COVER, "Cover")
for i, k in enumerate(GOOD_KINDS):  # which thing each face belongs to: split again after the bake
    for o in GOODS[k]:
        a = o.data.attributes.new("good", "INT", "FACE")
        a.data.foreach_set("value", [i] * len(o.data.polygons))
goods = join([o for k in GOOD_KINDS for o in GOODS[k]], "Goods")
for o in (stall, cover, goods):
    o.data.calc_loop_triangles()
    print(f"market_stall: {o.name} {len(o.data.loop_triangles)} triangles, {len(o.data.materials)} materials")


def atlas_uvs(obj, margin):
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    a = obj.data.uv_layers.new(name="atlas")
    obj.data.uv_layers.active = a
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=margin, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(rotate=True, margin=margin)
    bpy.ops.object.mode_set(mode="OBJECT")


atlas_uvs(stall, 0.004)
atlas_uvs(cover, 0.006)
atlas_uvs(goods, 0.006)

# ------------------------------------------------------------------------------------------------ bake
scene = bpy.context.scene
scene.render.engine = "CYCLES"
if not CPU:
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for kind in ("OPTIX", "CUDA"):
            try:
                prefs.compute_device_type = kind
                prefs.get_devices()
                if any(d.type == kind for d in prefs.devices):
                    for d in prefs.devices:
                        d.use = d.type == kind
                    scene.cycles.device = "GPU"
                    print("market_stall: baking on", kind)
                    break
            except TypeError:
                continue
    except Exception as e:  # no graphics card: the processor
        print("market_stall: baking on the processor", e)
scene.render.bake.margin = 6
scene.render.bake.use_clear = True
world = bpy.data.worlds.new("Bake")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (1, 1, 1, 1)
world.light_settings.distance = 0.7  # how far the ambient occlusion looks
scene.world = world
bpy.ops.mesh.primitive_plane_add(size=12, location=(0, 0, 0))
ground = bpy.context.active_object
ground.name = "BakeGround"
ground.data.materials.append(plain_material("ground", "#808080", 0.8))


def bake_images(prefix, size):
    imgs = {}
    for kind in ("albedo", "ao", "normal", "rough", "metal"):
        im = bpy.data.images.new(f"{prefix}_{kind}", size, size, alpha=False, float_buffer=kind == "normal")
        im.colorspace_settings.name = "sRGB" if kind == "albedo" else "Non-Color"
        imgs[kind] = im
    return imgs


def target(obj, img):
    for m in obj.data.materials:
        nt = m.node_tree
        n = nt.nodes.get("bake_target") or nt.nodes.new("ShaderNodeTexImage")
        n.name = "bake_target"
        n.image = img
        nt.nodes.active = n


def emit_metal(obj, on):
    for m in obj.data.materials:
        p = m.node_tree.nodes["Principled BSDF"]
        v = float(m.get("metal", 0.0)) if on else 0.0
        p.inputs["Emission Color"].default_value = (v, v, v, 1)
        p.inputs["Emission Strength"].default_value = 1.0 if on else 0.0


def bake(obj, hidden, size):
    imgs = bake_images(obj.name.lower(), size)
    for o in hidden:
        o.hide_render = True
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    for kind, typ, samples, extra in (("albedo", "DIFFUSE", 16, {"pass_filter": {"COLOR"}}),
                                       ("ao", "AO", 256, {}),
                                       ("normal", "NORMAL", 16, {"normal_space": "TANGENT"}),
                                       ("rough", "ROUGHNESS", 16, {}),
                                       ("metal", "EMIT", 4, {})):
        scene.cycles.samples = samples
        target(obj, imgs[kind])
        if kind == "metal":
            emit_metal(obj, True)
        bpy.ops.object.bake(type=typ, margin=6, use_clear=True, **extra)
        if kind == "metal":
            emit_metal(obj, False)
        print(f"market_stall: baked {obj.name} {kind}")
    for o in hidden:
        o.hide_render = False
    return imgs


def px(img):
    a = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(img.size[1], img.size[0], 4)


def final_material(obj, imgs, tmp, half=True):
    """The baked maps into one material: colour with the occlusion in, the normals, metal/roughness."""
    alb, ao = px(imgs["albedo"]), px(imgs["ao"])
    occ = 0.12 + 0.88 * ao[..., :1] ** 1.15
    base = alb.copy()
    base[..., :3] = alb[..., :3] * occ
    w, h = imgs["albedo"].size
    out = {}
    for kind, data, cs in (("color", base, "sRGB"), ("normal", px(imgs["normal"]), "Non-Color")):
        im = bpy.data.images.new(f"{obj.name.lower()}_{kind}", w, h, alpha=False)
        im.colorspace_settings.name = cs
        im.pixels.foreach_set(np.ascontiguousarray(data).ravel())
        if kind == "normal" and half:
            im.scale(w // 2, h // 2)  # half the colour's size: a phone's memory (the weave is finer than it shows)
        im.filepath_raw = os.path.join(tmp, f"{obj.name.lower()}_{kind}.png")
        im.file_format = "PNG"
        im.save()
        out[kind] = im
    mr = np.ones((h, w, 4), dtype=np.float32)
    mr[..., 1] = px(imgs["rough"])[..., 0]
    mr[..., 2] = px(imgs["metal"])[..., 0]
    im = bpy.data.images.new(f"{obj.name.lower()}_mr", w, h, alpha=False)
    im.colorspace_settings.name = "Non-Color"
    im.pixels.foreach_set(mr.ravel())
    if half:
        im.scale(w // 2, h // 2)
    im.filepath_raw = os.path.join(tmp, f"{obj.name.lower()}_mr.png")
    im.file_format = "PNG"
    im.save()
    out["mr"] = im

    m = bpy.data.materials.new(obj.name)
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    uv = nt.nodes.new("ShaderNodeUVMap")
    uv.uv_map = "atlas"

    def image(im):
        n = nt.nodes.new("ShaderNodeTexImage")
        n.image = im
        nt.links.new(uv.outputs["UV"], n.inputs["Vector"])
        return n

    nt.links.new(image(out["color"]).outputs["Color"], p.inputs["Base Color"])
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(image(out["mr"]).outputs["Color"], sep.inputs["Color"])
    nt.links.new(sep.outputs["Green"], p.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], p.inputs["Metallic"])
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nm.uv_map = "atlas"
    nt.links.new(image(out["normal"]).outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], p.inputs["Normal"])
    m.use_backface_culling = True
    obj.data.materials.clear()
    obj.data.materials.append(m)
    obj.data.uv_layers.remove(obj.data.uv_layers["tex"])
    return m


tmp = os.path.join(os.path.dirname(os.path.abspath(OUT)), ".market_stall_bake")
if PREVIEW:
    tmp = os.path.join(PREVIEW, "bake")
os.makedirs(tmp, exist_ok=True)
stall_imgs = bake(stall, [cover], 1024)  # the goods on the table shade it
cover_imgs = bake(cover, [goods], 512)  # the tarp's own occlusion: the table under it, the ground
goods_imgs = bake(goods, [cover], 512)  # in the stall's shade
final_material(stall, stall_imgs, tmp)
final_material(cover, cover_imgs, tmp)
final_material(goods, goods_imgs, tmp, half=False)
bpy.data.objects.remove(ground)

# The goods apart again, one mesh each (Good_<kind>), so the game can tint the ones paintball paints.
good_objs = []
for i, k in enumerate(GOOD_KINDS):
    o = goods.copy()
    o.data = goods.data.copy()
    bpy.context.scene.collection.objects.link(o)
    bm = bmesh.new()
    bm.from_mesh(o.data)
    layer = bm.faces.layers.int.get("good")
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f[layer] != i], context="FACES")
    bm.to_mesh(o.data)
    bm.free()
    o.data.attributes.remove(o.data.attributes["good"])
    o.name = o.data.name = f"Good_{k}"
    good_objs.append(o)
bpy.data.objects.remove(goods)

lo = Vector((min(v.co[i] for o in (stall, cover) for v in o.data.vertices) for i in range(3)))
hi = Vector((max(v.co[i] for o in (stall, cover) for v in o.data.vertices) for i in range(3)))
for o in good_objs:
    print(f"market_stall: {o.name} {len(o.data.polygons)} faces")
print("market_stall: bounds (Blender)", tuple(round(c, 3) for c in lo), tuple(round(c, 3) for c in hi))

bpy.ops.object.select_all(action="DESELECT")
stall.select_set(True)
cover.select_set(True)
for o in good_objs:
    o.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
opts = dict(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
            export_texcoords=True, export_normals=True, export_tangents=False, export_cameras=False, export_lights=False,
            export_image_format="JPEG")
try:
    bpy.ops.export_scene.gltf(**opts, export_image_quality=86)
except TypeError:
    bpy.ops.export_scene.gltf(**opts, export_jpeg_quality=86)
print("market_stall: written", OUT, os.path.getsize(OUT), "bytes")

# ------------------------------------------------------------------------------------------------ previews
if PREVIEW:
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = 64
    try:
        scene.eevee.use_raytracing = True
        scene.view_settings.view_transform = "AgX"
        scene.view_settings.look = "AgX - Medium High Contrast"
    except (TypeError, AttributeError):
        pass
    scene.render.resolution_x, scene.render.resolution_y = 1280, 960
    sky = bpy.data.worlds.new("Sky")
    sky.use_nodes = True
    env = sky.node_tree.nodes.new("ShaderNodeTexEnvironment")
    env.image = bpy.data.images.load(str(ROOT / "web" / "public" / "env" / "sky_2k.hdr"))
    sky.node_tree.links.new(env.outputs["Color"], sky.node_tree.nodes["Background"].inputs["Color"])
    sky.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.8
    scene.world = sky
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(50), 0, math.radians(-140)))
    bpy.context.active_object.data.energy = 3.0
    bpy.context.active_object.data.angle = math.radians(1.5)
    bpy.ops.mesh.primitive_plane_add(size=30)
    floor = bpy.context.active_object
    fm = bpy.data.materials.new("Pavers")
    fm.use_nodes = True
    fnt = fm.node_tree
    tc = fnt.nodes.new("ShaderNodeTexCoord")
    mp = fnt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (1 / 1.8, 1 / 1.8, 1)
    fnt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    ft = fnt.nodes.new("ShaderNodeTexImage")
    ft.image = bpy.data.images.load(str(ROOT / "web" / "public" / "textures" / "pavers_color.webp"))
    fnt.links.new(mp.outputs["Vector"], ft.inputs["Vector"])
    fnt.links.new(ft.outputs["Color"], fnt.nodes["Principled BSDF"].inputs["Base Color"])
    fnt.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.85
    floor.data.materials.append(fm)
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    os.makedirs(PREVIEW, exist_ok=True)
    # Blender +y is the game's -z: the stall's front.
    shots = (("stall_front34", (3.2, 3.6, 1.75), (0, 0, 1.05), 32, False),
             ("stall_front", (0, 4.6, 1.55), (0, 0, 1.15), 32, False),
             ("stall_back34", (-3.0, -3.2, 1.9), (0, 0, 1.0), 32, False),
             ("stall_close", (0.7, 1.7, 1.6), (0.0, 0.1, 1.2), 30, False),
             ("stall_shut", (2.8, 3.2, 1.6), (0, 0, 1.0), 32, True),
             ("goods_close", (0.0, 1.35, 1.45), (0.0, 0.0, 0.98), 30, False),
             ("goods_left", (0.75, 0.75, 1.2), (0.68, 0.0, 0.96), 32, False),
             ("goods_right", (-0.5, 0.8, 1.2), (-0.5, 0.0, 0.96), 32, False))
    for label, at, look, lens, shut in shots:
        cover.hide_render = not shut
        for o in good_objs:
            o.hide_render = shut
        cam.location = at
        cam.data.lens = lens
        cam.rotation_euler = (Vector(look) - Vector(at)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(PREVIEW, f"{label}.png")
        bpy.ops.render.render(write_still=True)
