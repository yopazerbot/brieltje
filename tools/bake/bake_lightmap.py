"""Bake the house's lighting in Blender (Cycles): sun, sky and light bouncing between walls.

Run (Blender 4/5, no window):
  blender -b -P tools/bake/bake_lightmap.py -- <house_static.glb> <sun.json> <out_dir> [size] [samples]

Input: the static house meshes exported from the game (one mesh per material,
named after it) and the game's sun direction (three.js axes, towards the sun).
Output in out_dir:
- house_baked.glb: the same meshes with a second UV map ("Lightmap")
- lightmap.npy: the baked light (float RGBA, size x size), lighting only (no
  surface colour); tools/bake/encode_lightmap.py turns it into a WebP for the web.
"""
import json
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
SRC, SUN_JSON, OUT = argv[0], argv[1], argv[2]
SIZE = int(argv[3]) if len(argv) > 3 else 2048
SAMPLES = int(argv[4]) if len(argv) > 4 else 128

# Rough real colours (linear) so bounced light picks up the right tint.
ALBEDO = {
    "brick": (0.58, 0.50, 0.40), "plaster": (0.75, 0.74, 0.72), "ceiling": (0.8, 0.8, 0.8), "floor_tile": (0.45, 0.44, 0.42),
    "floor_wood": (0.42, 0.30, 0.18), "floor_bath": (0.5, 0.5, 0.48), "terrace": (0.45, 0.44, 0.42), "paving": (0.35, 0.35, 0.34),
    "road": (0.12, 0.12, 0.12), "concrete": (0.4, 0.4, 0.4), "cladding": (0.3, 0.22, 0.15), "stair": (0.45, 0.33, 0.2),
    "hedge": (0.08, 0.14, 0.05), "roof": (0.08, 0.08, 0.08), "rail": (0.3, 0.3, 0.3), "oak": (0.5, 0.38, 0.24),
    "walnut": (0.18, 0.11, 0.07), "terracotta": (0.45, 0.2, 0.12), "terrazzo": (0.62, 0.6, 0.58), "rust_tile": (0.4, 0.18, 0.1),
    "pink_tile": (0.6, 0.42, 0.42), "pink": (0.6, 0.4, 0.4), "stone": (0.4, 0.4, 0.38), "ceramic": (0.8, 0.8, 0.78),
    "black_glass": (0.04, 0.04, 0.04), "steel": (0.5, 0.5, 0.5), "brass": (0.45, 0.35, 0.15), "mirror": (0.5, 0.5, 0.5),
    "niche": (0.6, 0.55, 0.45), "alu": (0.15, 0.14, 0.13), "alu_out": (0.06, 0.032, 0.027), "alu_in": (0.88, 0.84, 0.76), "nb_wall": (0.45, 0.25, 0.18), "nb_roof": (0.08, 0.07, 0.07),
    "claustra": (0.58, 0.5, 0.4),
}

# Outside surfaces stay lit in real time (the sun does them well); baking them would spend
# most of the lightmap on the street. Only the house itself is baked.
OUTSIDE = {"road", "paving", "nb_wall", "nb_roof", "hedge",
           "old_brick", "old_plinth", "old_plaster", "old_floor", "old_ceiling", "old_stone", "old_frame", "old_roof_flat", "old_wood"}

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
for o in [o for o in bpy.context.scene.objects if o.type == "MESH"]:
    key = o.data.materials[0].name if o.data.materials else o.name
    if key in OUTSIDE:
        bpy.data.objects.remove(o, do_unlink=True)
objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
print(f"imported {len(objs)} meshes (outside surfaces left to real-time light)")

image = bpy.data.images.new("lightmap", SIZE, SIZE, float_buffer=True, alpha=False)
for o in objs:
    key = o.data.materials[0].name if o.data.materials else o.name
    o["key"] = key
    # The game's meshes are loose triangles: weld them so walls unwrap as whole islands.
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0005)
    # The game draws both sides of every face, so some face inwards; the bake needs them
    # pointing out of each solid, or it gathers light from inside the wall (black).
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(o.data)
    bm.free()
    if getattr(o.data, "has_custom_normals", False):
        bpy.context.view_layer.objects.active = o
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    for p in o.data.polygons:
        p.use_smooth = False
    o.data.uv_layers.new(name="Lightmap")
    o.data.uv_layers.active_index = 1
    # Material: real-ish colour, plus the shared lightmap image as the bake target.
    mat = o.data.materials[0] if o.data.materials else bpy.data.materials.new(key)
    if not o.data.materials:
        o.data.materials.append(mat)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (*ALBEDO.get(key, (0.6, 0.6, 0.6)), 1)
    bsdf.inputs["Roughness"].default_value = 0.8
    for name in ("Metallic",):
        bsdf.inputs[name].default_value = 0.0
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = image
    uv = nodes.new("ShaderNodeUVMap")
    uv.uv_map = "Lightmap"
    mat.node_tree.links.new(uv.outputs["UV"], tex.inputs["Vector"])
    nodes.active = tex

# One lightmap for the whole house: unwrap all meshes together (islands packed by area).
bpy.ops.object.select_all(action="DESELECT")
for o in objs:
    o.select_set(True)
bpy.context.view_layer.objects.active = objs[0]
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.002, area_weight=0.0, scale_to_bounds=False)
bpy.ops.uv.select_all(action="SELECT")
bpy.ops.uv.average_islands_scale()
try:  # Blender 3.6+: tighter packing that also fills concave gaps
    bpy.ops.uv.pack_islands(rotate=True, margin=0.0015, shape_method="CONCAVE")
except TypeError:
    bpy.ops.uv.pack_islands(rotate=True, margin=0.0015)
bpy.ops.object.mode_set(mode="OBJECT")

# Light: the game's sun, a blue sky, and grass around the house to bounce light.
sun_three = json.load(open(SUN_JSON))["dir"]
sun_dir = Vector((sun_three[0], -sun_three[2], sun_three[1])).normalized()  # three.js (y up) -> Blender (z up)
bpy.ops.object.light_add(type="SUN")
sun = bpy.context.object
sun.data.energy = 3.2
sun.data.angle = math.radians(0.6)
sun.rotation_mode = "QUATERNION"
sun.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(sun_dir)
world = bpy.data.worlds.new("sky")
bpy.context.scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs["Color"].default_value = (0.55, 0.7, 1.0, 1)
bg.inputs["Strength"].default_value = 0.25
bpy.ops.mesh.primitive_plane_add(size=400, location=(4.5, -6, -0.1))
ground = bpy.context.object
gm = bpy.data.materials.new("grass")
gm.use_nodes = True
gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.1, 0.16, 0.05, 1)
ground.data.materials.append(gm)

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = SAMPLES
scene.cycles.max_bounces = 4
scene.render.bake.margin = 4
bpy.ops.object.select_all(action="DESELECT")
for o in objs:
    o.select_set(True)
bpy.context.view_layer.objects.active = objs[0]
print(f"baking {SIZE}x{SIZE}, {SAMPLES} samples ...", flush=True)
bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, margin=4, use_clear=True)
print("baked", flush=True)

os.makedirs(OUT, exist_ok=True)
px = np.empty(SIZE * SIZE * 4, dtype=np.float32)
image.pixels.foreach_get(px)
np.save(os.path.join(OUT, "lightmap.npy"), px.reshape(SIZE, SIZE, 4))

# Export the meshes with both UV maps; plain materials named after the game's materials.
bpy.data.objects.remove(ground, do_unlink=True)
bpy.data.objects.remove(sun, do_unlink=True)
for o in objs:
    mat = o.data.materials[0]
    for n in [n for n in mat.node_tree.nodes if n.type in ("TEX_IMAGE", "UVMAP")]:
        mat.node_tree.nodes.remove(n)
    mat.name = o["key"]
    o.name = o["key"]
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, "house_baked.glb"), export_format="GLB", export_texcoords=True, export_normals=True, export_materials="EXPORT", use_selection=False)
print("exported", flush=True)
