"""A small dog for the homes' insides (web/src/world/pets.ts), posed from a sculpted CC0 model.

Run (Blender 5, no window):
  blender -b -P tools/dog.py -- [out.glb] [preview_dir]

The source is the rigged and animated "Shiba Inu" by Quaternius (CC0, tools/assets/shiba_inu.glb; see
docs/CREDITS.md). This tool makes a generic small terrier-like dog of it, with no name and no coat of its own:
  - the ears folded forward at their middle and the curl of the tail shrunk to a short tail, as a new rest pose;
  - 0.28 m at the shoulder;
  - four clips: Walk and Idle from the source, Sit and Lie posed here (still poses that breathe a little);
  - one mesh, one material, the colours in its vertex colours: a plain tan coat, a dark nose and eyes. The
    alpha says what the page may tint: 1 the coat, 0.5 a patch on the head and ears (soft at its edge, so
    values between blend), 0 fixed (the eyes, the nose). The game gives each dog its coat and its patch.
  - the walk's own pace (m/s at this size, so the page plays it without sliding feet) in the armature's
    extras as `walkSpeed`.
No texture. About 1,950 triangles.
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(HERE, "assets", "shiba_inu.glb")
ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = ARGS[0] if ARGS else os.path.join(ROOT, "web", "public", "models", "dog.glb")
PREVIEW = ARGS[1] if len(ARGS) > 1 else None

SHOULDER = 0.28  # m, the top of the back over the front legs
TAN = (0.72, 0.56, 0.38)  # the model's own coat (sRGB); the page tints it
FIXED = {  # sRGB colours of the parts nobody tints, by the source's material
    "Black": (0.06, 0.05, 0.05), "Eyes_White": (0.85, 0.85, 0.82), "Eyes_Pupil": (0.04, 0.03, 0.03), "Eyes_Black": (0.03, 0.03, 0.03),
}
COAT = {"Main", "Main_Light"}


def srgb_to_linear(c):
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
scene = bpy.context.scene
arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
mesh = next(o for o in bpy.data.objects if o.type == "MESH" and o.vertex_groups)
for o in list(bpy.data.objects):
    if o not in (arm, mesh):
        bpy.data.objects.remove(o, do_unlink=True)
arm.name = "Dog"
mesh.name = mesh.data.name = "DogBody"
arm.animation_data_create()
arm.animation_data.action = None
for t in list(arm.animation_data.nla_tracks):
    arm.animation_data.nla_tracks.remove(t)

bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="POSE")
pose = arm.pose.bones
for pb in pose:
    pb.rotation_mode = "QUATERNION"


def reset_pose():
    for pb in pose:
        pb.location = (0, 0, 0)
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.scale = (1, 1, 1)
    bpy.context.view_layer.update()


def turn(name, axis, degrees, pivot=None):
    """Turn a bone (and so its children) about an axis of the armature's space through its head (or `pivot`)."""
    pb = pose[name]
    m = pb.matrix.copy()
    p = Vector(pivot) if pivot is not None else m.translation.copy()
    r = Matrix.Translation(p) @ Matrix.Rotation(math.radians(degrees), 4, Vector(axis)) @ Matrix.Translation(-p)
    pb.matrix = r @ m
    bpy.context.view_layer.update()


def move(name, offset):
    """Move a bone by an offset in metres of the world (the armature's object is scaled and turned: its y is up)."""
    pb = pose[name]
    m = pb.matrix.copy()
    pb.matrix = Matrix.Translation(arm.matrix_world.to_3x3().inverted() @ Vector(offset)) @ m
    bpy.context.view_layer.update()


# The feet are skinned to the source's IK handles, which hang from nothing: in a pose made here they follow
# their lower leg as if they were its children.
FEET = {"IKFrontLeg.L": "FrontLowerLeg.L", "IKFrontLeg.R": "FrontLowerLeg.R", "IKBackLeg.L": "BackLowerLeg.L", "IKBackLeg.R": "BackLowerLeg.R"}


def feet_follow():
    for foot, leg in FEET.items():
        lb = pose[leg]
        delta = lb.matrix @ lb.bone.matrix_local.inverted()
        pose[foot].matrix = delta @ pose[foot].bone.matrix_local
        bpy.context.view_layer.update()


# ---- A new rest pose: the ears folded forward, the tail's curl shrunk. Turns are about the dog's side axis x
# (the same in the armature's space and the world's); in the world -y is forward (the head) and z up.
reset_pose()
for side in ("L", "R"):
    s = 1 if side == "L" else -1
    turn(f"Ear2.{side}", (1, 0, 0), 95)  # the upper half folds forward and down
    turn(f"Ear1.{side}", (0, 1, 0), s * 12)  # the ears a little out to the side
pose["Tail3"].scale = (0.45, 0.45, 0.45)  # the curl, shrunk to a short tail held up
bpy.context.view_layer.update()
bpy.ops.object.mode_set(mode="OBJECT")
bpy.context.view_layer.objects.active = mesh
mod = next(m for m in mesh.modifiers if m.type == "ARMATURE")
bpy.ops.object.modifier_apply(modifier=mod.name)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="POSE")
bpy.ops.pose.armature_apply(selected=False)
bpy.ops.object.mode_set(mode="OBJECT")
mod = mesh.modifiers.new("Armature", "ARMATURE")
mod.object = arm
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="POSE")
for pb in pose:
    pb.rotation_mode = "QUATERNION"
reset_pose()

# ---- The size: 0.28 m at the shoulder.
mw = mesh.matrix_world
names = {g.index: g.name for g in mesh.vertex_groups}
withers = max(
    (mw @ v.co).z for v in mesh.data.vertices
    if v.groups and names[max(v.groups, key=lambda g: g.weight).group] in ("Torso2", "Torso3", "FrontShoulder.L", "FrontShoulder.R")
)
k = SHOULDER / withers
arm.scale = arm.scale * k
bpy.context.view_layer.update()
print("dog: withers", round(withers, 3), "scale by", round(k, 5))

# ---- Colours: vertex colours from the materials; the patch from the head's shape.
me = mesh.data
mats = [m.name for m in me.materials]
groups = {g.index: g.name for g in mesh.vertex_groups}
head = arm.matrix_world @ arm.data.bones["Head"].head_local
mw = mesh.matrix_world
tip_y = min((mw @ v.co).y for v in me.vertices)  # the nose (forward is -y)


def patch_of(v):
    """How much of the head's patch a point is in: the ears and the skull above and behind the eyes, not the muzzle."""
    dom = max(v.groups, key=lambda g: g.weight) if v.groups else None
    name = groups.get(dom.group, "") if dom else ""
    if name.startswith("Ear"):
        return 1.0
    if name not in ("Head", "Neck3"):
        return 0.0
    p = mw @ v.co
    span = head.y - tip_y  # head joint to nose, > 0
    back = (p.y - tip_y) / span  # 0 at the nose, 1 at the head joint
    up = (p.z - head.z) / span
    t = min(1.0, max(0.0, (back - 0.45) / 0.15)) * min(1.0, max(0.0, (up + 0.05) / 0.15))
    return t


# Colours per point, so the file shares its points between faces (the page shades the faces flat): first the
# points on the border of two parts (coat and nose, say) are split, so each keeps its own colour.
mat_of = lambda poly: mats[poly.material_index] if poly.material_index < len(mats) else "Main"  # noqa: E731
part = lambda name: "coat" if name in COAT else name  # noqa: E731
bm = bmesh.new()
bm.from_mesh(me)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6 / mesh.matrix_world.to_scale().x)  # the source is split at every face
bm.faces.ensure_lookup_table()
part_of = lambda f: part(mats[f.material_index] if f.material_index < len(mats) else "Main")  # noqa: E731
seams = [e for e in bm.edges if len({part_of(f) for f in e.link_faces}) > 1]
bmesh.ops.split_edges(bm, edges=seams)
bm.to_mesh(me)
bm.free()
me.update()
col = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
tan = srgb_to_linear(TAN)
for poly in me.polygons:
    mat = mat_of(poly)
    for vi in poly.vertices:
        v = me.vertices[vi]
        if mat in COAT:
            col.data[vi].color = (*tan, 1.0 - 0.5 * patch_of(v))
        else:
            col.data[vi].color = (*srgb_to_linear(FIXED.get(mat, (0.1, 0.1, 0.1))), 0.0)
me.color_attributes.active_color = col
print("dog: points", len(me.vertices), "after splitting", len(seams), "border edges")
# One material for everything: the colours are the vertices'.
dog_mat = bpy.data.materials.new("DogCoat")
dog_mat.use_nodes = True
nodes = dog_mat.node_tree.nodes
bsdf = nodes.get("Principled BSDF")
attr = nodes.new("ShaderNodeVertexColor")
attr.layer_name = "Col"
dog_mat.node_tree.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
bsdf.inputs["Roughness"].default_value = 0.9
me.materials.clear()
me.materials.append(dog_mat)
for poly in me.polygons:
    poly.material_index = 0

# ---- The clips. Walk and Idle from the source; Sit and Lie posed here.
keep = {"Walk": "Walk", "Idle": "Idle"}
for a in list(bpy.data.actions):
    if a.name not in keep:
        bpy.data.actions.remove(a)
for a in bpy.data.actions:
    a.use_fake_user = True


def key_pose(action, frame):
    for pb in pose:
        pb.keyframe_insert("location", frame=frame, group=pb.name)
        pb.keyframe_insert("rotation_quaternion", frame=frame, group=pb.name)


def still(name, make, frames=48):
    """A pose that breathes: the chest rises a little at the middle of the loop."""
    # Posed with no action on the armature (one there would set the bones again at each update), then keyed.
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    for f, breath in ((0, 0.0), (frames // 2, 1.0), (frames, 0.0)):
        arm.animation_data.action = None
        reset_pose()
        make()
        turn("Torso2", (1, 0, 0), -1.5 * breath)
        feet_follow()
        arm.animation_data.action = action
        key_pose(action, f)
    arm.animation_data.action = None
    return action


def lowest(prefixes=None):
    """The lowest point of the posed mesh (world z), of the parts whose main bone is one of `prefixes` (all when None)."""
    deps = bpy.context.evaluated_depsgraph_get()
    deps.update()
    ev = mesh.evaluated_get(deps)
    em = ev.to_mesh()
    names = {g.index: g.name for g in mesh.vertex_groups}
    low = 1e9
    for v, src in zip(em.vertices, mesh.data.vertices):
        if prefixes:
            dom = max(src.groups, key=lambda g: g.weight) if src.groups else None
            if not dom or names[dom.group] not in prefixes:
                continue
        low = min(low, (ev.matrix_world @ v.co).z)
    ev.to_mesh_clear()
    return low


def ground(prefixes=None, clearance=0.0):
    """Down (or up) until the lowest point of those parts is on the floor."""
    move("Back", (0, 0, clearance - lowest(prefixes)))
    feet_follow()


# Angles about the dog's side axis (x): positive lifts what is behind (+y) and lowers what is in front.
def sit():
    # The rump down to the floor round the shoulders, the front legs upright again, the hind legs folded:
    # the thigh forward, the shank back along the floor, the hind paw flat.
    shoulder = pose["FrontUpperLeg.L"].matrix.translation.copy()
    turn("Back", (1, 0, 0), -36, pivot=shoulder)
    for side in ("L", "R"):
        turn(f"FrontUpperLeg.{side}", (1, 0, 0), 36)
        turn(f"BackUpperLeg.{side}", (1, 0, 0), 58)
        turn(f"BackLowerLeg.{side}", (1, 0, 0), -80)
    turn("Neck1", (1, 0, 0), 22)
    turn("Head", (1, 0, 0), 14)
    feet_follow()
    ground()


def lie():
    # Down on its belly: the front legs stretched forward on the floor, the hind legs folded beside it, the head up.
    for side in ("L", "R"):
        turn(f"FrontLowerLeg.{side}", (1, 0, 0), -80)
        turn(f"BackUpperLeg.{side}", (1, 0, 0), 30)
        turn(f"BackLowerLeg.{side}", (1, 0, 0), -93)
    feet_follow()
    ground(("Torso", "Torso2", "Torso3", "Back"), 0.004)
    print("dog: lying, its belly at", round(lowest(("Torso", "Torso2", "Torso3", "Back")), 4), "its lowest point at", round(lowest(), 4))
    turn("Neck1", (1, 0, 0), -8)


still("Sit", sit)
still("Lie", lie)
reset_pose()

# ---- The walk's pace: how fast a planted front foot goes back, in m/s at this size.
fps = scene.render.fps / scene.render.fps_base
walk = bpy.data.actions["Walk"]
arm.animation_data.action = walk
f0, f1 = (int(x) for x in walk.frame_range)
track = []
for f in range(f0, f1 + 1):
    scene.frame_set(f)
    track.append((arm.matrix_world @ pose["FF.L"].matrix.translation))
low = min(p.z for p in track)
planted = [i for i, p in enumerate(track) if p.z < low + 0.004]
speeds = [abs(track[i + 1].y - track[i].y) * fps for i in planted if i + 1 in planted]
walk_speed = sum(speeds) / len(speeds) if speeds else 0.0
arm["walkSpeed"] = round(walk_speed, 4)
arm.animation_data.action = None
print("dog: walk speed", round(walk_speed, 3), "m/s over", len(speeds), "planted frames")
reset_pose()
bpy.ops.object.mode_set(mode="OBJECT")

tris = sum(len(p.vertices) - 2 for p in me.polygons)
print("dog: triangles", tris, "clips", [a.name for a in bpy.data.actions])


def preview(folder):
    os.makedirs(folder, exist_ok=True)
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 480, 360
    world = bpy.data.worlds.new("w")
    world.color = (0.35, 0.35, 0.38)
    scene.world = world
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3
    sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    scene.collection.objects.link(sun)
    floor = bpy.data.meshes.new("floor")
    floor.from_pydata([(-1, -1, 0), (1, -1, 0), (1, 1, 0), (-1, 1, 0)], [], [(0, 1, 2, 3)])
    scene.collection.objects.link(bpy.data.objects.new("floor", floor))
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scene.collection.objects.link(cam)
    scene.camera = cam
    # Tinted as the page would (a white coat, a brown patch), to judge the patch.
    white, brown = srgb_to_linear((0.93, 0.92, 0.89)), srgb_to_linear((0.45, 0.28, 0.16))
    for c in me.color_attributes["Col"].data:
        r, g, b, a = c.color
        if a > 0.25:
            t = min(1.0, max(0.0, (1.0 - a) / 0.5))
            c.color = (*[w + (br - w) * t for w, br in zip(white, brown)], a)
    views = {"side": ((1.3, 0, 0.25), (0, -0.02, 0.15)), "front": ((-0.55, -0.9, 0.4), (0, -0.05, 0.13)), "head": ((-0.25, -0.55, 0.35), (0, -0.2, 0.26))}
    clips = [("Idle", 0), ("Walk", 6), ("Sit", 0), ("Lie", 0)]
    for clip, frame in clips:
        arm.animation_data.action = bpy.data.actions[clip]
        scene.frame_set(frame)
        for view, (eye, at) in views.items():
            cam.location = eye
            d = Vector(at) - Vector(eye)
            cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
            scene.render.filepath = os.path.join(folder, f"{clip}-{view}.png")
            bpy.ops.render.render(write_still=True)
    arm.animation_data.action = None


# The source's IK pole targets move nothing: left out of the file.
for b in arm.data.bones:
    if b.name.startswith("PoleTarget"):
        b.use_deform = False

bpy.ops.export_scene.gltf(
    filepath=OUT, export_format="GLB", use_selection=False, export_yup=True, export_apply=False,
    export_texcoords=False, export_normals=False, export_tangents=False, export_materials="EXPORT",
    export_vertex_color="ACTIVE", export_all_vertex_colors=False, export_attributes=False,
    export_cameras=False, export_lights=False, export_extras=True,
    export_skins=True, export_influence_nb=4, export_all_influences=False, export_def_bones=True,
    export_morph=False, export_animations=True, export_animation_mode="ACTIONS", export_nla_strips=True,
    export_force_sampling=False, export_optimize_animation_size=True,
    export_optimize_animation_keep_anim_armature=True, export_anim_slide_to_zero=True,
)
print("dog: wrote", OUT, os.path.getsize(OUT), "bytes")

if PREVIEW:
    preview(PREVIEW)  # after the export: the floor, light and camera of the pictures stay out of the file
