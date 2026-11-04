"""Review renders for tools/parachute/parachute.py, which imports this file (it is not run on its own).

The figure is the game's swat.glb, posed on the parachute's guides the way the browser preview poses it
(web/src/world/parachutePilot.ts): the pelvis follows Pilot, the legs reach Foot_X with Shin_X as the knee's
pole, the arms reach Grip_X with Elbow_X as the elbow's pole, and the fingers curl round the toggles.
Cycles on the GPU (Metal) when there is one; tiles are put together with ffmpeg.
"""
import math
import os
import shutil
import subprocess

import bpy
from mathutils import Matrix, Vector

OLIVE = (0.105, 0.135, 0.075, 1.0)       # linear: the game's olive outfit (#5b6b45)
FINGERS = [f"{f}{k}" for f in ("Index", "Middle", "Ring", "Pinky") for k in (1, 2, 3)] + ["Thumb1", "Thumb2"]
CURL = {"1": 0.95, "2": 1.05, "3": 0.75}


def scene_setup(samples):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "METAL"
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        scene.cycles.device = "GPU"
    except Exception as e:  # no GPU: the CPU renders the same, slower
        print("Cycles on the CPU:", e)
        scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    try:
        scene.view_settings.view_transform = "ACES 1.3"   # the game renders with ACES filmic tone mapping
    except TypeError:
        scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -0.2
    world = bpy.data.worlds.new("Sky")
    world.use_nodes = True
    nt = world.node_tree
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    rng = nt.nodes.new("ShaderNodeMapRange")
    rng.inputs["From Min"].default_value, rng.inputs["From Max"].default_value = -0.05, 0.9
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (0.78, 0.84, 0.88, 1)
    ramp.color_ramp.elements[1].color = (0.25, 0.43, 0.66, 1)
    bg = nt.nodes["Background"]
    bg.inputs["Strength"].default_value = 1.0
    nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    nt.links.new(sep.outputs["Z"], rng.inputs["Value"])
    nt.links.new(rng.outputs["Result"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    scene.world = world
    sun = bpy.data.lights.new("Sun", "SUN")
    sun.energy, sun.angle = 3.2, math.radians(3)
    so = bpy.data.objects.new("Sun", sun)
    scene.collection.objects.link(so)
    so.rotation_euler = Vector((0.55, 0.65, -0.55)).to_track_quat("Z", "Y").to_euler()
    so.rotation_euler = (-Vector((-0.45, 0.55, 0.70))).to_track_quat("-Z", "Y").to_euler()
    scene.render.use_stamp = False
    return scene


def mat(name, rgb, rough=0.9):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*rgb, 1.0)
    p.inputs["Roughness"].default_value = rough
    return m


def ground(z, size=600):
    me = bpy.data.meshes.new("Ground")
    h = size / 2
    me.from_pydata([(-h, -h, 0), (h, -h, 0), (h, h, 0), (-h, h, 0)], [], [(0, 1, 2, 3)])
    me.materials.append(mat("Field", (0.30, 0.27, 0.17)))   # near the game's hemisphere ground colour
    o = bpy.data.objects.new("Ground", me)
    bpy.context.scene.collection.objects.link(o)
    o.location.z = z
    return o


def pole(x, y):
    """A 1.8 m pole in 0.3 m bands: the scale of a player."""
    objs = []
    dark, light = mat("PoleDark", (0.02, 0.02, 0.02), 0.6), mat("PoleLight", (0.8, 0.8, 0.8), 0.6)
    for k in range(6):
        bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.028, depth=0.3, location=(x, y, 0.15 + 0.3 * k))
        o = bpy.context.active_object
        o.data.materials.append(dark if k % 2 == 0 else light)
        objs.append(o)
    return objs


def camera(name, loc, target=None, lens=35.0, ortho=0.0, rot=None):
    c = bpy.data.cameras.new(name)
    o = bpy.data.objects.new(name, c)
    bpy.context.scene.collection.objects.link(o)
    o.location = loc
    if rot is not None:
        o.rotation_euler = rot
    else:
        o.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    if ortho:
        c.type, c.ortho_scale = "ORTHO", ortho
    else:
        c.lens = lens
    c.clip_start, c.clip_end = 0.05, 2000
    return o


def shoot(path, cam, res, samples, note=""):
    scene = bpy.context.scene
    scene.camera = cam
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.cycles.samples = samples
    scene.render.image_settings.file_format = "PNG"
    r = scene.render
    r.use_stamp = bool(note)
    if note:
        for a in dir(r):
            if a.startswith("use_stamp_") and isinstance(getattr(r, a), bool):
                try:
                    setattr(r, a, False)
                except Exception:
                    pass
        r.use_stamp_note = True
        r.stamp_note_text = note
        r.stamp_font_size = max(14, res[1] // 26)
        r.stamp_background = (0.0, 0.0, 0.0, 0.55)
    r.filepath = path
    bpy.ops.render.render(write_still=True)
    return path


def tile(frames, cols, rows, out, width=None):
    """frames: PNG paths in reading order -> one JPEG."""
    tmp = os.path.join(os.path.dirname(out), "_tile")
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    for k, f in enumerate(frames):
        shutil.copy(f, os.path.join(tmp, "%03d.png" % k))
    vf = f"tile={cols}x{rows}:padding=4:color=white"
    if width:
        vf += f",scale={width}:-2"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", os.path.join(tmp, "%03d.png"), "-vf", vf,
                    "-frames:v", "1", "-q:v", "4", out], check=True)
    shutil.rmtree(tmp, ignore_errors=True)
    return out


class Pilot:
    """The game's figure on the parachute's pose guides."""

    def __init__(self, P):
        self.P = P
        av, arm, meshes, objs = P.import_avatar(P.ARGS.avatar)
        self.arm, self.meshes = arm, meshes
        for o in meshes:
            for m in o.data.materials:
                if m and m.name.split(".")[0] == "Swat":
                    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = OLIVE
        bpy.context.view_layer.update()
        self.rest = {b.name: arm.matrix_world @ b.matrix_local for b in arm.data.bones}
        self.curl = {}
        for s, sx in P.SIDES:
            axis = Vector((0, sx, 0))       # fingers along +-X, palms down: curl towards the palm
            for f in FINGERS:
                n = f"{f}.{s}"
                if n not in arm.data.bones:
                    continue
                k = CURL.get(f[-1], 0.6) * (0.45 if f.startswith("Thumb") else 1.0)
                local_axis = self.rest[n].to_quaternion().inverted() @ axis
                self.curl[n] = (local_axis, k)

    def head(self, n):
        return self.arm.matrix_world @ self.arm.pose.bones[n].head

    def set_world(self, n, M):
        self.arm.pose.bones[n].matrix = self.arm.matrix_world.inverted() @ M
        bpy.context.view_layer.update()

    def turn(self, n, frm, to):
        pb = self.arm.pose.bones[n]
        M = self.arm.matrix_world @ pb.matrix
        h = M.translation.copy()
        R = frm.normalized().rotation_difference(to.normalized()).to_matrix().to_4x4()
        self.set_world(n, Matrix.Translation(h) @ R @ Matrix.Translation(-h) @ M)

    def two_bone(self, upper, lower, effector, target, pole):
        a, b, c = self.head(upper), self.head(lower), effector()
        l1, l2 = (b - a).length, (c - b).length
        d = min((target - a).length, (l1 + l2) * 0.999)
        dr = (target - a).normalized()
        pv = pole - a
        pv -= dr * pv.dot(dr)
        pv = pv.normalized() if pv.length > 1e-6 else Vector((0, 0, -1))
        ca = max(-1.0, min(1.0, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)))
        elbow = a + dr * ca * l1 + pv * math.sqrt(1 - ca * ca) * l1
        self.turn(upper, b - a, elbow - a)
        b2, c2 = self.head(lower), effector()
        self.turn(lower, c2 - b2, a + dr * d - b2)

    def pose(self, W, hide=False):
        P, arm = self.P, self.arm
        for o in self.meshes:
            o.hide_render = hide
        for pb in arm.pose.bones:
            pb.matrix_basis = Matrix.Identity(4)
        bpy.context.view_layer.update()

        def D(g):
            return W[g] @ Matrix.Translation(-P.HEAD[g])
        self.set_world("Body", D("Pilot") @ self.rest["Body"])
        for s, sx in P.SIDES:
            # The lower leg's end (the foot bone's head at rest), carried by the lower leg as it turns.
            lower = f"LowerLeg.{s}"
            end_rest = self.rest[lower].inverted() @ self.rest[f"Foot.{s}"].translation

            def end(lower=lower, end_rest=end_rest):
                return (arm.matrix_world @ arm.pose.bones[lower].matrix) @ end_rest
            self.two_bone(f"UpperLeg.{s}", lower, end, D(f"Foot_{s}") @ P.J[f"ankle_{s}"], D(f"Shin_{s}") @ P.J[f"knee_{s}"])
            self.set_world(f"Foot.{s}", D(f"Foot_{s}") @ self.rest[f"Foot.{s}"])
            grip = W[f"Grip_{s}"].translation.copy()
            sh = self.head(f"UpperArm.{s}")
            target = grip - (grip - sh).normalized() * 0.05
            self.two_bone(f"UpperArm.{s}", f"LowerArm.{s}", lambda s=s: self.head(f"Wrist.{s}"), target,
                          W[f"Elbow_{s}"].translation.copy())
        for n, (ax, k) in self.curl.items():
            pb = arm.pose.bones[n]
            pb.rotation_mode = "QUATERNION"
            from mathutils import Quaternion
            pb.rotation_quaternion = Quaternion(ax, k)
        bpy.context.view_layer.update()


def show(P, clip, t, pilot=None, lod=0):
    if P.RIG.animation_data:
        P.RIG.animation_data.use_nla = False   # the baked clips would override the pose set here
    B, W = P.pose_at(clip, t)
    P.apply_pose(P.RIG, B)
    P.LOD0.hide_render, P.LOD1.hide_render = lod != 0, lod != 1
    if pilot:
        pilot.pose(W)
    return W


def review(out, P):
    os.makedirs(out, exist_ok=True)
    tiles = os.path.join(out, "frames")
    os.makedirs(tiles, exist_ok=True)
    scene_setup(P.ARGS.samples)
    pilot = Pilot(P)
    # 1. The beauty shot: a turn, seen from below and in front.
    g = ground(-60)
    show(P, "Glide_Left", 0.75, pilot)
    cam = camera("Beauty", (5.6, 6.4, 0.2), (0.35, 0.5, 2.9), lens=30)
    shoot(os.path.join(out, "beauty.png"), cam, (1600, 1000), max(P.ARGS.samples, 96))
    # 2. Front, side, rear and underside, with a 1.8 m pole.
    show(P, "Glide_Idle", 0.0, pilot)
    pl = pole(0.95, 0.75)
    span = 2 * P.ARC_R * math.sin(P.HALF / P.ARC_R)
    views = [
        ("front", camera("Front", (0, 30, 2.9), (0, 0, 2.9), ortho=7.4), f"Front. Span {span:.2f} m, pole 1.8 m"),
        ("side", camera("Side", (30, 0, 2.9), (0, 0, 2.9), ortho=7.4), "Side (forward to the right). Pole 1.8 m"),
        ("rear", camera("Rear", (0, -30, 2.9), (0, 0, 2.9), ortho=7.4), "Rear. Pole 1.8 m"),
        ("under", camera("Under", (0, 0.2, -20), ortho=7.4, rot=(math.pi, 0, math.pi)), f"Underside (forward up). Chord {P.CHORD:.2f} m"),
    ]
    frames = []
    for name, c, note in views:
        frames.append(shoot(os.path.join(tiles, f"view_{name}.png"), c, (900, 900), 32, note))
    tile(frames, 2, 2, os.path.join(out, "views.jpg"), 1400)
    for o in pl:
        bpy.data.objects.remove(o)
    # 3. Deployment to landing, in place.
    g.location.z = 0
    cam = camera("Sheet", (-8.2, 8.8, 2.4), (0.0, 0.5, 2.3), lens=26)
    seq = [("Deploy", 0.0), ("Deploy", 0.25), ("Deploy", 0.45), ("Deploy", 0.75), ("Deploy", 1.05), ("Deploy", 1.8),
           ("Glide_Left", 0.0), ("Glide_Right", 0.0), ("Flare", 0.8), ("Land_Collapse", 0.35), ("Land_Collapse", 1.2),
           ("Land_Collapse", 2.4)]
    frames = []
    for k, (clip, t) in enumerate(seq):
        show(P, clip, t, pilot)
        frames.append(shoot(os.path.join(tiles, f"seq_{k:02d}.png"), cam, (560, 420), 24, f"{clip} {t:.2f} s"))
    tile(frames, 4, 3, os.path.join(out, "contact_sheet.jpg"), 1680)
    # 4. LOD0 and LOD1 from 25 m.
    g.location.z = -60
    cam = camera("Far", (14, 20, -2.0), (0, 0, 2.8), lens=50)
    frames = []
    for lod in (0, 1):
        show(P, "Glide_Idle", 0.0, pilot, lod)
        frames.append(shoot(os.path.join(tiles, f"lod{lod}.png"), cam, (640, 480), 24, f"LOD{lod} at 25 m"))
    tile(frames, 2, 1, os.path.join(out, "lods.jpg"), 1280)
    # 5. A turntable of the idle loop.
    if P.ARGS.turntable and shutil.which("ffmpeg"):
        tt = os.path.join(out, "turntable")
        os.makedirs(tt, exist_ok=True)
        cam = camera("Turn", (0, 11, 2.6), (0, 0, 2.7), lens=30)
        n = 72
        for f in range(n):
            a = 2 * math.pi * f / n
            cam.location = (11 * math.sin(a), 11 * math.cos(a), 1.2)
            cam.rotation_euler = (Vector((0, 0, 2.7)) - cam.location).to_track_quat("-Z", "Y").to_euler()
            show(P, "Glide_Idle", P.LOOP * f / n, pilot)
            shoot(os.path.join(tt, "%03d.png" % f), cam, (640, 480), 16)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "24", "-i", os.path.join(tt, "%03d.png"),
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "30", "-movflags", "+faststart",
                        os.path.join(out, "turntable.mp4")], check=True)
    print("renders in", out)


def variants(out, P):
    """The same canopy in three colourings, from below and from behind and above."""
    os.makedirs(out, exist_ok=True)
    shots = {}
    for v in ("A", "B", "C"):
        root, rig, lod0, lod1, g0, g1 = P.build_scene(v)
        P.RIG, P.LOD0, P.LOD1 = rig, lod0, lod1
        scene_setup(24)
        pilot = Pilot(P)
        ground(-60)
        show(P, "Glide_Idle", 0.0, pilot)
        below = camera("Below", (3.5, 9.0, -6.5), (0, 0, 3.2), lens=32)
        above = camera("Above", (-5.0, -7.5, 9.0), (0, 0, 3.6), lens=32)
        shots[v] = (shoot(os.path.join(out, f"variant_{v}_below.png"), below, (600, 420), 24, f"Variant {v}"),
                    shoot(os.path.join(out, f"variant_{v}_above.png"), above, (600, 420), 24, f"Variant {v}"))
    frames = [shots[v][0] for v in "ABC"] + [shots[v][1] for v in "ABC"]
    tile(frames, 3, 2, os.path.join(out, "variants.jpg"), 1500)
    print("variants in", out)
