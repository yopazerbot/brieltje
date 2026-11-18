"""Prepare the villagers' sculpted parts in tools/assets/people/ from two public domain (CC0) downloads.

Run (Blender 5, no window; only when the parts are to be made again):
  blender -b --disable-autoexec -P tools/people_assets.py -- <human_base_meshes_bundle.blend> <"Universal Base Characters[Standard]" folder>

The downloads (both CC0 1.0, see docs/CREDITS.md):
  Human Base Meshes bundle v1.2.0, Blender Studio:
    https://download.blender.org/demo/asset-bundles/human-base-meshes/human-base-meshes-bundle-v1.2.0.zip
    From it: the realistic male and female bodies, each with its two eyes.
  Universal Base Characters [Standard], Quaternius: https://quaternius.itch.io/universal-base-characters
    From it: the sculpted hairstyles, the beard and the eyebrows. Each is made for that pack's own heads, so it is
    fitted here to the base meshes' heads: scaled from the one skull to the other (between the eyes' height and the
    crown, the width at the temples, the depth from the brow to the back) and pushed out wherever it sinks into the
    scalp.

Out: tools/assets/people/body_male.glb and body_female.glb, each holding the objects Body (the sculpt with its
multires detail applied once, then thinned to about 26,000 triangles), EyeL, EyeR, Brows and the hairstyles that suit
it (Hair_<name>). Y up, metres, facing +z in the GLB (Blender -y), standing in the bundle's A pose. tools/villagers.py
does the rest (the skeleton, the pose, the clothes, the colours).
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(argv) < 2:
    raise SystemExit(__doc__)
HBM, UBC = argv[0], argv[1]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "people")
BODY_TRIS = 26000
# The hairstyles each body gets, and how far each is thinned (triangles).
STYLES = {
    "male": {"Hair_SimpleParted": 900, "Hair_Buzzed": 500, "Hair_Beard": 500, "Hair_Long": 1200},
    "female": {"Hair_Long": 1200, "Hair_Buns": 1200, "Hair_SimpleParted": 900, "Hair_BuzzedFemale": 500},
}
BROWS = {"male": "Eyebrows_Regular", "female": "Eyebrows_Female"}
# Which of the pack's heads a style was made on.
MADE_ON = {"Hair_SimpleParted": "Male", "Hair_Buzzed": "Male", "Hair_Beard": "Male", "Eyebrows_Regular": "Male",
           "Hair_Long": "Female", "Hair_Buns": "Female", "Hair_BuzzedFemale": "Female", "Eyebrows_Female": "Female"}


def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def mesh_object(name, verts, faces):
    me = bpy.data.meshes.new(name)
    me.from_pydata([v[:] for v in verts], [], faces)
    me.update()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def thin(o, tris):
    """Fewer triangles, the shape kept (collapse decimation)."""
    n = sum(len(p.vertices) - 2 for p in o.data.polygons)
    if n <= tris:
        return
    bpy.context.view_layer.objects.active = o
    m = o.modifiers.new("thin", "DECIMATE")
    m.ratio = tris / n
    m.use_collapse_triangulate = True
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.ops.object.modifier_apply(modifier=m.name)


def baked(o, levels=None, origin=Vector()):
    """The object's mesh with its modifiers (the multires at `levels`), in world space less `origin`, as a new object."""
    if levels is not None:
        for m in o.modifiers:
            if m.type == "MULTIRES":
                m.levels = levels
    dg = bpy.context.evaluated_depsgraph_get()
    ev = o.evaluated_get(dg)
    me = ev.to_mesh()
    mw = o.matrix_world
    verts = [mw @ v.co - origin for v in me.vertices]
    faces = [tuple(p.vertices) for p in me.polygons]
    ev.to_mesh_clear()
    return verts, faces


def skull(co, eye_z, front_hint):
    """A head's measures: the eyes' height, the crown, the half width at the temples, the brow's and the back's y."""
    top = max(p.z for p in co)
    band = [p for p in co if eye_z + 0.02 < p.z < eye_z + 0.05 and abs(p.x) < 0.12]
    width = max(abs(p.x) for p in band)
    brow = min(p.y for p in band)
    back = max(p.y for p in co if eye_z - 0.02 < p.z < top and abs(p.x) < 0.12 and p.y > front_hint)
    return dict(eye=eye_z, top=top, width=width, brow=brow, back=back)


def fit(points, a, b):
    """Points made for head a, moved onto head b."""
    sx = b["width"] / a["width"]
    sy = (b["back"] - b["brow"]) / (a["back"] - a["brow"])
    sz = (b["top"] - b["eye"]) / (a["top"] - a["eye"])
    out = []
    for p in points:
        out.append(Vector((p.x * sx, b["brow"] + (p.y - a["brow"]) * sy, b["eye"] + (p.z - a["eye"]) * sz)))
    return out


def push_out(points, bvh, gap):
    """Every point at least `gap` outside the head's surface."""
    out = []
    for p in points:
        hit = bvh.find_nearest(p)
        if hit[0] is None or hit[3] > 0.05:
            out.append(p)
            continue
        loc, nrm = hit[0], hit[1]
        d = (p - loc).dot(nrm)
        out.append(loc + nrm * gap + (p - loc - nrm * d) if d < gap else p)
    return out


def ubc_head(sex):
    """The pack's own head (its body's points above the shoulders) and its eyes' height, in Blender axes."""
    clear()
    bpy.ops.import_scene.gltf(filepath=os.path.join(UBC, "Base Characters", "Godot - UE", f"Superhero_{sex}_FullBody.gltf"))
    bpy.context.view_layer.update()
    body = next(o for o in bpy.data.objects if o.type == "MESH" and "superhero" in o.name.lower())
    eyes = next(o for o in bpy.data.objects if o.type == "MESH" and o.name.startswith("Eyes"))
    ez = sum((eyes.matrix_world @ v.co).z for v in eyes.data.vertices) / len(eyes.data.vertices)
    co = [body.matrix_world @ v.co for v in body.data.vertices]
    co = [p for p in co if p.z > ez - 0.14]
    return co, ez


def ubc_piece(name):
    clear()
    bpy.ops.import_scene.gltf(filepath=os.path.join(UBC, "Hairstyles", "Origin at 0", "glTF (Godot)", f"{name}.gltf"))
    bpy.context.view_layer.update()
    o = next(o for o in bpy.data.objects if o.type == "MESH")
    return [o.matrix_world @ v.co for v in o.data.vertices], [tuple(p.vertices) for p in o.data.polygons]


heads = {sex: ubc_head(sex) for sex in ("Male", "Female")}
pieces = {name: ubc_piece(name) for name in MADE_ON}
os.makedirs(OUT, exist_ok=True)
for sex in ("male", "female"):
    clear()
    with bpy.data.libraries.load(HBM) as (src, dst):
        dst.objects = [n for n in src.objects if n.startswith(f"GEO-body_{sex}_realistic")]
    for o in dst.objects:
        bpy.context.scene.collection.objects.link(o)
    bpy.context.view_layer.update()
    src_body = bpy.data.objects[f"GEO-body_{sex}_realistic"]
    origin = src_body.matrix_world.translation.copy()
    bv, bf = baked(src_body, 2, origin)
    eyes = {}
    for side in ("L", "R"):
        eyes[side] = baked(bpy.data.objects[f"GEO-body_{sex}_realistic.eye.{side}"], None, origin)
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    body = mesh_object("Body", bv, bf)
    thin(body, BODY_TRIS)
    for side, (v, f) in eyes.items():
        thin(mesh_object(f"Eye{side}", v, f), 90)
    bpy.context.view_layer.update()
    co = [v.co.copy() for v in body.data.vertices]
    eye_z = sum(v.z for v in eyes["L"][0]) / len(eyes["L"][0])
    ours = skull([p for p in co if p.z > eye_z - 0.14], eye_z, -0.05)
    bm = bmesh.new()
    bm.from_mesh(body.data)
    bvh = BVHTree.FromBMesh(bm)
    for name, tris in list(STYLES[sex].items()) + [(BROWS[sex], 160)]:
        made = heads[MADE_ON[name]]
        theirs = skull(made[0], made[1], -0.05)
        pv, pf = pieces[name]
        pts = push_out(fit(pv, theirs, ours), bvh, 0.0025 if "Eyebrows" not in name else 0.0008)
        o = mesh_object("Brows" if name.startswith("Eyebrows") else name, pts, pf)
        thin(o, tris)
        print(f"{sex} {name}: {len(o.data.polygons)} faces; skull theirs {theirs} ours {ours}")
    bm.free()
    for o in bpy.data.objects:
        o.data.polygons.foreach_set("use_smooth", [True] * len(o.data.polygons))
    path = os.path.join(OUT, f"body_{sex}.glb")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=False, export_yup=True, export_apply=False,
                              export_texcoords=False, export_normals=True, export_materials="NONE", export_vertex_color="NONE",
                              export_attributes=False, export_animations=False, export_skins=False, export_morph=False,
                              export_cameras=False, export_lights=False)
    print(f"{path}: {os.path.getsize(path)} bytes, body {len(body.data.polygons)} faces")
