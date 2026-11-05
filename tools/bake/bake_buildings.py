"""Bake the light of the building models in Blender (Cycles, on the graphics card when there is one).

1. Give the models their light layout: tools/.venv/Scripts/python.exe tools/bake/lightmap_uv.py
2. Export the world from the game: on the dev server, once the village has loaded, run
   tools/bake/export_scene.js in the page. It downloads bake_scene.glb and bake_info.json.
3. Bake (Blender 5, no window):
     blender -b -P tools/bake/bake_buildings.py -- <dir with the two files> <work dir> [sky samples]
4. tools/.venv/Scripts/python.exe tools/bake/encode_buildings.py <work dir> web/public/baked

The whole world takes part (the relief, the village, the trees and hedges, the main house), so the models
get the shadows and the shade of everything round them, but only the models' surfaces with a light layout
(TEXCOORD_1 and the extras lm, lmModel, lmSize) are baked. Each pass is kept as raw numbers per page in the
work dir (<model>_<page>_<pass>.npy, the top row first, as the game reads the layout):

- sky: the light from the sky photo, as the game uses it (turned, capped and scaled as in
  world/environment.ts), with every bounce: irradiance / pi, without the surface's own colour
- bounce: the game's sun, only what bounces off other surfaces (the game draws the sun's direct light)
- sun: how much of the sun each point sees (soft edges, as the sun's disc and the texel blur it)
- rain: how much of the sky straight above each point sees (sheltered under eaves and sills)
- ao: how open each point is within 0.8 m (corners and joints)
- position, normal: where each texel is and which way it faces (for the wear: tools/bake/encode_buildings.py)
- cover: 1 where a surface was baked, 0 in the gaps between pieces
"""
import json
import math
import os
import sys
import time
from pathlib import Path

import bpy
import numpy as np

argv = sys.argv[sys.argv.index("--") + 1:]
SRC, OUT = Path(argv[0]), Path(argv[1])
SKY_SAMPLES = int(argv[2]) if len(argv) > 2 else 512
ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "web" / "public"
SKY = PUBLIC / "env" / "sky_2k.hdr"
OUT.mkdir(parents=True, exist_ok=True)

info = json.loads((SRC / "bake_info.json").read_text(encoding="utf-8"))
t0 = time.time()
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(SRC / "bake_scene.glb"))
scene = bpy.context.scene
print(f"imported in {time.time() - t0:.0f} s", flush=True)

# --- The graphics card, if Cycles can use one (OptiX first).
prefs = bpy.context.preferences.addons["cycles"].preferences
device = "CPU"
for kind in ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL"):
    try:
        prefs.compute_device_type = kind
        prefs.get_devices()
        gpus = [d for d in prefs.devices if d.type == kind]
        if gpus:
            for d in prefs.devices:
                d.use = d.type == kind
            device = "GPU"
            print("baking on", kind, [d.name for d in gpus], flush=True)
            break
    except TypeError:
        continue
scene.render.engine = "CYCLES"
scene.cycles.device = device
scene.cycles.max_bounces = 6
scene.cycles.diffuse_bounces = 4
scene.cycles.glossy_bounces = 1
scene.cycles.transparent_max_bounces = 8
scene.cycles.caustics_reflective = scene.cycles.caustics_refractive = False
scene.cycles.sample_clamp_indirect = 10.0
scene.render.bake.margin = 2
scene.render.bake.margin_type = "EXTEND"

# --- Materials: each surface's average colour (the bounced light takes its tint), see-through glass,
# crowns and hedges that let a quarter of the light through.
averages = {}


def average(src):
    if src not in averages:
        path = PUBLIC / src.lstrip("/")
        try:
            img = bpy.data.images.load(str(path))
            px = np.empty(img.size[0] * img.size[1] * 4, np.float32)
            img.pixels.foreach_get(px)
            averages[src] = px.reshape(-1, 4)[:, :3].mean(axis=0)  # Blender gives linear values for sRGB images
            bpy.data.images.remove(img)
        except RuntimeError:
            averages[src] = np.array([0.5, 0.5, 0.5])
    return averages[src]


def prop(m, key, default=None):
    v = m.get(key, default)
    return v.to_dict() if hasattr(v, "to_dict") else v


for mat in bpy.data.materials:
    if not mat.node_tree:
        continue
    nt = mat.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"), None)
    if not bsdf or not out:
        continue
    for link in list(bsdf.inputs["Base Color"].links) + list(bsdf.inputs["Alpha"].links):
        nt.links.remove(link)
    for name in ("Normal", "Roughness", "Metallic", "Emission Color"):
        for link in list(bsdf.inputs[name].links):
            nt.links.remove(link)
    base = np.array(bsdf.inputs["Base Color"].default_value[:3])
    tex = prop(mat, "tex", {}) or {}
    if "map" in tex:
        base = base * average(tex["map"]["src"])
    bsdf.inputs["Base Color"].default_value = (*np.clip(base, 0, 1), 1.0)
    bsdf.inputs["Roughness"].default_value = 0.85
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Emission Strength"].default_value = 0.0
    if prop(mat, "vertexColors"):
        vc = nt.nodes.new("ShaderNodeVertexColor")
        mul = nt.nodes.new("ShaderNodeVectorMath")
        mul.operation = "MULTIPLY"
        nt.links.new(vc.outputs["Color"], mul.inputs[0])
        mul.inputs[1].default_value = tuple(np.clip(base, 0, 1))
        nt.links.new(mul.outputs[0], bsdf.inputs["Base Color"])
    see_through = 0.0
    if prop(mat, "transparent") and float(prop(mat, "opacity", 1)) < 0.5:
        see_through = 0.95  # window glass
    elif prop(mat, "foliage"):
        see_through = 0.25
    bsdf.inputs["Alpha"].default_value = 1.0 - see_through
    mat.blend_method = "HASHED" if see_through else "OPAQUE"

# --- The targets: each object with a light layout bakes into its model's page.
targets = [o for o in scene.objects if o.type == "MESH" and "lmModel" in o.keys()]
pages = {}
for o in targets:
    key = (o["lmModel"], int(o["lm"]))
    if key not in pages:
        size = int(o["lmSize"])
        img = bpy.data.images.new(f"{key[0]}_{key[1]}", size, size, float_buffer=True, alpha=True)
        img.colorspace_settings.name = "Non-Color"
        pages[key] = img
    want = info["targets"][o["lmModel"]]["id"]
    if o["lmId"] != want:
        raise SystemExit(f"{o.name}: layout {o['lmId']} differs from its model's {want}")
    # The light layout is the second UV map; the bake writes through the active one.
    o.data.uv_layers.active_index = 1
    for slot in o.material_slots:
        m = slot.material.copy()
        slot.link = "OBJECT"
        slot.material = m
        node = m.node_tree.nodes.new("ShaderNodeTexImage")
        node.image = pages[key]
        node.interpolation = "Closest"
        for n in m.node_tree.nodes:
            n.select = False
        node.select = True
        m.node_tree.nodes.active = node
print(f"{len(targets)} target objects on {len(pages)} pages; {len(scene.objects)} objects in all", flush=True)

# Everything else in one object: Cycles then syncs one mesh per bake instead of thousands of objects (trees).
t = time.time()
others = [o for o in scene.objects if o.type == "MESH" and "lmModel" not in o.keys()]
bpy.ops.object.select_all(action="DESELECT")
for o in others:
    o.select_set(True)
bpy.context.view_layer.objects.active = others[0]
bpy.ops.object.make_single_user(object=True, obdata=True)
bpy.ops.object.join()
print(f"joined {len(others)} other objects in {time.time() - t:.0f} s", flush=True)
# And the targets into one object per page: Cycles bakes object by object.
groups = {key: [o for o in targets if (o["lmModel"], int(o["lm"])) == key] for key in pages}
joined = []
for key, group in groups.items():
    bpy.ops.object.select_all(action="DESELECT")
    for o in group:
        o.select_set(True)
    bpy.context.view_layer.objects.active = group[0]
    if len(group) > 1:
        bpy.ops.object.join()
    joined.append(bpy.context.view_layer.objects.active)
targets = joined

# --- Lights: the sky photo (world), the game's sun, and a "rain" lamp straight above.
world = bpy.data.worlds.new("Sky")
scene.world = world
world.use_nodes = True
wn = world.node_tree.nodes
wn.clear()
coord = wn.new("ShaderNodeTexCoord")
mapping = wn.new("ShaderNodeMapping")
mapping.vector_type = "POINT"
mapping.inputs["Rotation"].default_value = (0.0, 0.0, -info["environmentTurn"])
env = wn.new("ShaderNodeTexEnvironment")
env.image = bpy.data.images.load(str(SKY))
cap = wn.new("ShaderNodeVectorMath")  # the game caps the sky's brightest pixels (world/environment.ts)
cap.operation = "MINIMUM"
cap.inputs[1].default_value = (60000.0, 60000.0, 60000.0)
bg = wn.new("ShaderNodeBackground")
wout = wn.new("ShaderNodeOutputWorld")
wl = world.node_tree.links
wl.new(coord.outputs["Generated"], mapping.inputs["Vector"])
wl.new(mapping.outputs["Vector"], env.inputs["Vector"])
wl.new(env.outputs["Color"], cap.inputs[0])
wl.new(cap.outputs[0], bg.inputs["Color"])
wl.new(bg.outputs["Background"], wout.inputs["Surface"])
world.cycles.sampling_method = "MANUAL"
world.cycles.sample_map_resolution = 2048
world.light_settings.distance = 0.8  # ambient occlusion's reach


def three_to_blender(v):
    return (v[0], -v[2], v[1])


def lamp(name, direction, strength, colour, angle):
    data = bpy.data.lights.new(name, "SUN")
    data.energy = strength
    data.color = colour
    data.angle = math.radians(angle)
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    d = np.array(direction, float)
    d /= np.linalg.norm(d)
    from mathutils import Vector
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(Vector(tuple(d)))
    return obj


sun = lamp("sun", three_to_blender(info["sun"]), info["sunIntensity"], tuple(info["sunColor"]), 1.0)
rain = lamp("rain", (0, 0, 1), 1.0, (1, 1, 1), 40.0)

# --- Bake helpers.
bpy.ops.object.select_all(action="DESELECT")
for o in targets:
    o.select_set(True)
bpy.context.view_layer.objects.active = targets[0]


def setting(sky=0.0, sun_on=False, rain_on=False):
    bg.inputs["Strength"].default_value = sky
    sun.hide_render = not sun_on
    rain.hide_render = not rain_on


def bake(kind, samples, **kw):
    scene.cycles.samples = samples
    t = time.time()
    bpy.ops.object.bake(type=kind, margin=2, use_clear=True, **kw)
    print(f"  {kind} {kw.get('pass_filter', '')} {samples} samples: {time.time() - t:.0f} s", flush=True)


def keep(name, channels, dtype=np.float16):
    for (model, page), img in pages.items():
        s = img.size[0]
        px = np.empty(s * s * 4, np.float32)
        img.pixels.foreach_get(px)
        px = px.reshape(s, s, 4)[::-1]  # Blender keeps the bottom row first
        np.save(OUT / f"{model}_{page}_{name}.npy", px[:, :, :channels].astype(dtype))


def emit(make):
    """Point every target material's surface at an emission shader (for the position, normal and
    cover passes); returns a function that puts the old surfaces back."""
    undo = []
    for o in targets:
        for slot in o.material_slots:
            nt = slot.material.node_tree
            out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output)
            old = out.inputs["Surface"].links[0].from_socket if out.inputs["Surface"].links else None
            em = nt.nodes.new("ShaderNodeEmission")
            make(nt, em)
            nt.links.new(em.outputs[0], out.inputs["Surface"])
            undo.append((nt, out, old, em))

    def back():
        for nt, out, old, em in undo:
            nt.nodes.remove(em)
            if old is not None:
                nt.links.new(old, out.inputs["Surface"])
    return back


t1 = time.time()
print("sky ...", flush=True)
setting(sky=info["environmentIntensity"])
bake("DIFFUSE", SKY_SAMPLES, pass_filter={"DIRECT", "INDIRECT"})
keep("sky", 3)
print("sun's bounce ...", flush=True)
setting(sun_on=True)
bake("DIFFUSE", max(64, SKY_SAMPLES // 2), pass_filter={"INDIRECT"})
keep("bounce", 3)
print("sun ...", flush=True)
bake("SHADOW", 64)
keep("sun", 1)
print("rain ...", flush=True)
setting(rain_on=True)
bake("SHADOW", 64)
keep("rain", 1)
print("ao ...", flush=True)
setting(sky=1.0)
bake("AO", 128)
keep("ao", 1)

# Position (world, three.js axes, metres) and normal, through emission (no transforms to worry about).
setting()
lo = np.min([np.array(o.matrix_world) @ np.array([*c, 1.0]) for o in targets for c in o.bound_box], axis=0)[:3]


def position(nt, em):
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    sub = nt.nodes.new("ShaderNodeVectorMath")
    sub.operation = "SUBTRACT"
    nt.links.new(geo.outputs["Position"], sub.inputs[0])
    sub.inputs[1].default_value = tuple(lo)
    nt.links.new(sub.outputs[0], em.inputs["Color"])


back = emit(position)
bake("EMIT", 1)
back()
for (model, page), img in pages.items():
    s = img.size[0]
    px = np.empty(s * s * 4, np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(s, s, 4)[::-1, :, :3] + lo
    np.save(OUT / f"{model}_{page}_position.npy", np.stack([px[..., 0], px[..., 2], -px[..., 1]], axis=-1).astype(np.float32))


def normal(nt, em):
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    mad = nt.nodes.new("ShaderNodeVectorMath")
    mad.operation = "MULTIPLY_ADD"
    nt.links.new(geo.outputs["Normal"], mad.inputs[0])
    mad.inputs[1].default_value = (0.5, 0.5, 0.5)
    mad.inputs[2].default_value = (0.5, 0.5, 0.5)
    nt.links.new(mad.outputs[0], em.inputs["Color"])


back = emit(normal)
bake("EMIT", 1)
back()
for (model, page), img in pages.items():
    s = img.size[0]
    px = np.empty(s * s * 4, np.float32)
    img.pixels.foreach_get(px)
    n = px.reshape(s, s, 4)[::-1, :, :3] * 2 - 1
    np.save(OUT / f"{model}_{page}_normal.npy", np.stack([n[..., 0], n[..., 2], -n[..., 1]], axis=-1).astype(np.float16))


def cover(nt, em):
    em.inputs["Color"].default_value = (1, 1, 1, 1)


back = emit(cover)
scene.render.bake.margin = 0
scene.cycles.samples = 1
bpy.ops.object.bake(type="EMIT", margin=0, use_clear=True)
back()
keep("cover", 1, np.uint8)

(OUT / "bake_info.json").write_text(json.dumps({k: v for k, v in info.items() if k != "terrain"} | {"terrain": info["terrain"], "pages": [f"{m}_{p}" for m, p in pages]}), encoding="utf-8")
print(f"baked {len(pages)} pages in {time.time() - t1:.0f} s", flush=True)
