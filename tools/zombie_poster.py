"""Poster renders of the zombies (docs/poster): built by tools/zombies.py (exported to a throwaway file, no
previews), then each figure in a characteristic pose and the lineup, on a transparent background at print size.
blender -b -P tools/zombie_poster.py -- <repo> <out_dir> [singles | lineup]"""
import math
import os
import sys

import bpy
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1:]
REPO, OUTDIR = args[0], args[1]
os.makedirs(OUTDIR, exist_ok=True)
tmp_glb = os.path.join(OUTDIR, "_throwaway.glb")

# Build the figures with the game's own script (it reads its own argv after "--").
sys.argv = [sys.argv[0], "--", tmp_glb]
src = os.path.join(REPO, "tools", "zombies.py")
g = {"__name__": "__main__", "__file__": src}
exec(compile(open(src, encoding="utf-8").read(), src, "exec"), g)
os.remove(tmp_glb)
FIG, ORDER, REPORT, FPS = g["FIG"], g["ORDER"], g["REPORT"], g["FPS"]
scene = bpy.context.scene

scene.render.engine = "BLENDER_EEVEE"
scene.eevee.taa_render_samples = 128
scene.view_settings.view_transform = "ACES 1.3"
scene.view_settings.exposure = -0.5
scene.render.film_transparent = True
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
world = bpy.data.worlds.new("Studio")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.42, 0.45, 0.5, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.9
scene.world = world


def light(kind, loc, energy, size, target=(0, 0, 1.0)):
    bpy.ops.object.light_add(type=kind, location=loc)
    o = bpy.context.active_object
    o.data.energy = energy
    if kind == "AREA":
        o.data.size = size
    else:
        o.data.angle = math.radians(size)
    o.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()


light("AREA", (-2.5, -3.5, 3.6), 650, 3.5)
light("AREA", (3.0, -2.0, 2.0), 200, 3.0)
light("AREA", (0.5, 3.5, 3.0), 300, 2.5)
light("SUN", (0, 0, 10), 1.2, 6, (0.4, 0.6, 0))
bpy.ops.object.camera_add()
cam = bpy.context.active_object
scene.camera = cam
for v in ORDER:
    for tr in FIG[v][1].animation_data.nla_tracks:
        tr.mute = True


def show(only, x=None):
    for v in ORDER:
        top, rig, meshes, B = FIG[v]
        vis = v in only
        meshes[0].hide_render = not vis
        meshes[1].hide_render = True
        top.location = (x[v] if x and v in x else 0.0, 0.0, 0.0)


def pose(v, clip, t):
    rig = FIG[v][1]
    rig.animation_data.action = bpy.data.actions[f"{v}_{clip}"]
    return int(round(t * FPS))


def shot(path, loc, target, lens, res, frame):
    scene.frame_set(frame)
    scene.render.resolution_x, scene.render.resolution_y = res
    cam.location = loc
    cam.data.lens = lens
    cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


# Each figure three-quarter, mid-stride: the runner sprinting, the big one stomping, the rest shambling.
for v in ([] if "lineup" in args[2:] else ORDER):
    H = REPORT[v]["height"]
    k = H / 1.8
    show([v])
    clip = "Stomp" if v == "big" else "Run" if v == "hoodie" else "Walk"
    f = pose(v, clip, REPORT[v]["clips"][clip]["seconds"] * 0.22)
    shot(os.path.join(OUTDIR, f"zombie_{v}.png"), (2.9 * k, -3.6 * k, 1.35 * k), (0, 0, 0.9 * k), 50, (4000, 5000), f)

# The lineup, all five shambling side by side.
xs = {"shirt": -2.4, "hoodie": -1.2, "overall": 0.0, "farmer": 1.2, "big": 2.7}
show(ORDER, xs)
for v in ORDER:
    clip = "Stomp" if v == "big" else "Walk"
    pose(v, clip, REPORT[v]["clips"][clip]["seconds"] * (0.1 + 0.15 * ORDER.index(v)))
scene.frame_set(int(0.3 * FPS))
if "singles" not in args[2:]: shot(os.path.join(OUTDIR, "zombies_lineup.png"), (0.3, -11.8, 1.5), (0.3, 0, 1.15), 50, (5000, 2600), int(0.3 * FPS))
print("poster renders done")
