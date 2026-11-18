"""Build the villagers for Explore in Blender: generic, invented people and a dog, rigged and animated.

Run (Blender 5, no window):
  blender -b -P tools/villagers.py -- [out.glb] [preview_dir]

Nobody in particular: generic, invented people, no likeness of anyone, no names, no logos. The people are
sculpted, public domain bodies with sculpted hair (tools/assets/people, made by tools/people_assets.py; see
`sculpt` below), rigged here on this tool's own skeleton, given each kind's proportions and dressed for a
Flemish November. Seven kinds, each one mesh on its own armature:
  man      1.79 m: a padded jacket with a collar, trousers, shoes; hair parted or cropped, a beard or not.
  woman    1.67 m: a fitted jacket, slim trousers, ankle boots; hair to the shoulders or short.
  elder    1.66 m, a little stooped, a rounder belly: a coat, loose trousers, a walking stick; a flat cap or not.
  teen     1.71 m, lanky: a hoodie with its hood on the back, jeans, chunky trainers.
  child    1.18 m, about seven: a child's head and face, short legs; a padded jacket, trousers, trainers.
  cyclist  1.76 m on a city bike: a rain jacket, trousers, a helmet or not.
  dog      0.55 m at the shoulder: a medium dog with floppy or pricked ears and a collar.

Colours: nothing is coloured here for good. Each face carries a slot (skin, hair, top, bottom, shoes, two
accents, legwear, bike frame, and fixed ones such as the eyes' white and dark, metal and tyres) and a shade
in its UV map (u: slot + 16 * group, v: 1 - shade); the game gives every villager its own colour per slot.
Groups are the extras one villager has and another hasn't, hidden in the game unless chosen: 1 an umbrella,
2 a bag (a shoulder bag, a handbag or a backpack), 3 a knitted hat, a flat cap or a helmet, 4 a scarf,
5 glasses, 6 and 7 a choice of hair (or of the dog's ears), 8 a beard. The vertex colours are only for the
previews.

Skinning: the sculpted bodies by Blender's bone heat; the extras as tools/zombies.py does it (each piece
names the bones it may follow, and a point is pulled by each of them by (distance / thickness) ** -5).

The clips are made here, frame by frame, from how people move. Twenty-two bones: a collarbone a side (the
shoulders go with the arms) and a foot in two (heel to ball, the toes). A step: the heel strikes with the
toes up, the foot rolls flat and stays where it is on the ground, the heel lifts and the foot pushes off from
the ball while the toes stay down, the swinging foot comes through low (legs by two-bone IK). The hips rise
over the planted leg and sink with both feet down, shift over the planted foot, tilt down on the swinging
side and turn with the leg; the chest turns against them, the arms swing against the legs, the head stays
level. A planted foot moves back at exactly the walking speed, so the distance a loop covers is known (the
armature's `clips` property, exported as the node's extras: the game plays a walk at the pace the villager
goes, so the feet don't slide). Each kind walks its own way (GAIT). Clips for the people: Walk and Stroll
(a slower pace with shorter steps; the game plays the nearer one), WalkPk and StrollPk (hands in the
pockets) for the man, the woman and the teen, Jog, WalkUmb (an umbrella held up), WalkLead (a dog's lead),
three ways of standing about (Idle, Idle2, Idle3: weight from leg to leg, a look round, a glance at the
watch, rubbing the hands against the cold), Talk (talking for half the loop and listening for the other, so
two friends take turns), Wave and Sit; Ride for the cyclist (one turn of the cranks, two of the wheels);
Walk, Idle and Sit for the dog.

Output: one GLB (Y up, metres). Per kind k a node vil_<k> holding its armature vil_<k>_rig and the skinned
mesh vil_<k>_body, and vil_<k>_far: the same figure in about 1,500 triangles on the same bones, for those
further off; bones named <k>_<Bone> (no dots, so three.js keeps the names); clips <k>_<Clip>,
sampled at 15 keys a second, in place. The figures stand with their feet at the origin and face +z in the
GLB (Blender -Y). The file is repacked afterwards as tools/zombies.py does (identical accessors once,
weights as normalised bytes, channels that never leave a bone's rest translation dropped).
With preview_dir it saves small pictures of a lineup and a few poses there (Eevee).
"""
import json
import math
import os
import struct
import sys

import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Quaternion, Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = argv[0] if argv else os.path.join(ROOT, "web", "public", "models", "villagers.glb")
PREVIEW = argv[1] if len(argv) > 1 else ""

FPS = 30
STEP = 2  # a key every other frame
FALLOFF = 5
FWD = Vector((0.0, -1.0, 0.0))  # the figures face Blender -Y (glTF +Z)
UP = Vector((0.0, 0.0, 1.0))
SIDES = (("L", 1), ("R", -1))  # its left is +x
TAU = 2 * math.pi

# Colour slots (u in the UV map), the game's palette per villager has 16 colours.
SKIN, HAIR, TOP, BOTTOM, SHOES, ACC, ACC2, LEGS, FRAME, WHITE, DARK, METAL, TYRE, LEATHER, LIPS, SOLE = range(16)
# Extras (groups): hidden unless the villager has them.
UMB, BAG, HAT, SCARF, SPECS, HAIR_A, HAIR_B, BEARD = 1, 2, 3, 4, 5, 6, 7, 8
PREVIEW_COL = {
    SKIN: "#d9a383", HAIR: "#4a3426", TOP: "#3f6f9a", BOTTOM: "#3b3f48", SHOES: "#2c2a28", ACC: "#a2482f", ACC2: "#2f7d5b",
    LEGS: "#2e2b2c", FRAME: "#2f5f8a", WHITE: "#f1efe9", DARK: "#1d1b1a", METAL: "#8f9398", TYRE: "#222222", LEATHER: "#5a3a26",
    LIPS: "#b0645c", SOLE: "#e8e6e0",
}


def rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def smooth(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def rot(axis, deg):
    return Quaternion(Vector(axis), math.radians(deg))


def euler(pitch=0.0, roll=0.0, yaw=0.0):
    """A turn in the figure's axes, degrees, applied pitch first and yaw last. Pitch is about x: + tips an upright
    part forward (the figure faces -y) and swings a hanging limb back. Roll is about y: + takes a hanging limb
    out to the figure's right (-x). Yaw is about z."""
    return rot((0, 0, 1), yaw) @ rot((0, 1, 0), roll) @ rot((1, 0, 0), pitch)


# ======== Geometry: simple closed pieces, as numpy-free lists of Vectors.
def perp(a):
    a = Vector(a).normalized()
    ref = Vector((1, 0, 0)) if abs(a.x) < 0.9 else Vector((0, 0, 1))
    u = (ref - a * ref.dot(a)).normalized()
    return u, a.cross(u).normalized()


def ring(c, u, v, ru, rv, seg, e=2.0, phase=0.0):
    out = []
    for i in range(seg):
        t = TAU * i / seg + phase
        cs, sn = math.cos(t), math.sin(t)
        x = math.copysign(abs(cs) ** (2 / e), cs)
        y = math.copysign(abs(sn) ** (2 / e), sn)
        out.append(c + u * (ru * x) + v * (rv * y))
    return out


def loft(rings, cap0=True, cap1=True):
    """Rings of equal length joined by quads, closed at the ends by a face each (rings: lists of points)."""
    seg = len(rings[0])
    verts = [p for r in rings for p in r]
    faces = []
    for k in range(len(rings) - 1):
        for i in range(seg):
            j = (i + 1) % seg
            faces.append((k * seg + i, k * seg + j, (k + 1) * seg + j, (k + 1) * seg + i))
    if cap0:
        faces.append(tuple(range(seg))[::-1])
    if cap1:
        n = len(rings) - 1
        faces.append(tuple(n * seg + i for i in range(seg)))
    return verts, faces


def tube(pts, radii, seg=8, ell=(1.0, 1.0), e=2.0, ref=None):
    """A tube through the points with a radius at each (ell: the ellipse's stretch across (u, v))."""
    pts = [Vector(p) for p in pts]
    rings = []
    axis0 = (pts[-1] - pts[0]).normalized()
    if ref is None:
        u, v = perp(axis0)
    else:
        u = (Vector(ref) - axis0 * Vector(ref).dot(axis0)).normalized()
        v = axis0.cross(u).normalized()
    for k, (p, r) in enumerate(zip(pts, radii)):
        a = (pts[min(k + 1, len(pts) - 1)] - pts[max(k - 1, 0)]).normalized()
        uk = (u - a * u.dot(a)).normalized()
        vk = a.cross(uk).normalized()
        rr = r if isinstance(r, tuple) else (r * ell[0], r * ell[1])
        rings.append(ring(p, uk, vk, rr[0], rr[1], seg, e))
    return loft(rings)


def ellipsoid(c, r, seg=10, rings=6, m=None, shape=None):
    """An ellipsoid round c with radii r (x, y, z), turned by m; `shape(dir) -> factor` moves each point in or out."""
    c = Vector(c)
    m = m or Matrix.Identity(3)
    verts, faces = [], []
    for k in range(1, rings):
        th = math.pi * k / rings
        for i in range(seg):
            ph = TAU * i / seg
            d = Vector((math.sin(th) * math.cos(ph), math.sin(th) * math.sin(ph), math.cos(th)))
            f = shape(d) if shape else 1.0
            verts.append(c + m @ Vector((d.x * r[0] * f, d.y * r[1] * f, d.z * r[2] * f)))
    top = len(verts)
    ft = shape(Vector((0, 0, 1))) if shape else 1.0
    fb = shape(Vector((0, 0, -1))) if shape else 1.0
    verts.append(c + m @ Vector((0, 0, r[2] * ft)))
    verts.append(c + m @ Vector((0, 0, -r[2] * fb)))
    for k in range(rings - 2):
        for i in range(seg):
            j = (i + 1) % seg
            faces.append((k * seg + i, k * seg + j, (k + 1) * seg + j, (k + 1) * seg + i))
    for i in range(seg):
        j = (i + 1) % seg
        faces.append((top, j, i))
        b = (rings - 2) * seg
        faces.append((top + 1, b + i, b + j))
    return verts, faces


def box(c, half, m=None, bevel=0.0):
    """A box round c with half sizes (x, y, z), turned by m (a 3x3); a bevel cuts its four upright edges."""
    c = Vector(c)
    m = m or Matrix.Identity(3)
    hx, hy, hz = half
    if bevel <= 0:
        pts = [Vector((sx * hx, sy * hy, sz * hz)) for sz in (-1, 1) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        verts = [c + m @ p for p in pts]
        faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
        return verts, faces
    b = min(bevel, hx * 0.9, hy * 0.9)
    outline = [(-hx + b, -hy), (hx - b, -hy), (hx, -hy + b), (hx, hy - b), (hx - b, hy), (-hx + b, hy), (-hx, hy - b), (-hx, -hy + b)]
    rings = [[c + m @ Vector((x, y, z)) for x, y in outline] for z in (-hz, hz)]
    return loft(rings)


def torus(c, R, r, seg=12, sides=4, m=None):
    c = Vector(c)
    m = m or Matrix.Identity(3)
    verts, faces = [], []
    for i in range(seg):
        a = TAU * i / seg
        ca, sa = math.cos(a), math.sin(a)
        for k in range(sides):
            b = TAU * k / sides
            rr = R + r * math.cos(b)
            verts.append(c + m @ Vector((rr * ca, rr * sa, r * math.sin(b))))
    for i in range(seg):
        for k in range(sides):
            i2, k2 = (i + 1) % seg, (k + 1) % sides
            faces.append((i * sides + k, i2 * sides + k, i2 * sides + k2, i * sides + k2))
    return verts, faces


class Fig:
    """One figure's mesh as it is built: points, faces, and per face its slot, group and shade; per point the
    bones it may follow."""

    def __init__(self):
        self.co, self.faces, self.slot, self.group, self.shade, self.allow = [], [], [], [], [], []
        self.given = {}  # a point's weights as they come with a sculpted body: {bone: weight}
        self.sculpted = 0  # how many of the first faces are a sculpted body's (they keep their own winding)

    def add_sculpt(self, S, n):
        """A sculpted body (sculpt()): its points with the weights it came with, its faces each with their slot and shade."""
        assert not self.co
        self.co = [Vector(p) for p in S["co"]]
        self.allow = [("@",)] * len(self.co)
        self.given = {i: {n(b): w for b, w in ws.items()} for i, ws in enumerate(S["weights"])}
        for f, (slot, shade), grp in zip(S["faces"], S["look"], S["group"]):
            self.faces.append(tuple(f))
            self.slot.append(slot)
            self.group.append(grp)
            self.shade.append(shade)
        self.sculpted = len(self.faces)

    def add(self, piece, slot, allow, shade=1.0, group=0, xform=None):
        verts, faces = piece
        base = len(self.co)
        for p in verts:
            p = Vector(p)
            self.co.append(xform @ p if xform is not None else p)
        self.allow.extend([tuple(allow)] * len(verts))
        for f in faces:
            self.faces.append(tuple(base + i for i in f))
            self.slot.append(slot)
            self.group.append(group)
            self.shade.append(shade)

    def mirror(self, piece):
        verts, faces = piece
        return [Vector((-p.x, p.y, p.z)) for p in verts], [tuple(f[::-1]) for f in faces]

    def tris(self):
        return sum(len(f) - 2 for f in self.faces)


# ======== The people.
def human_bones(k):
    """Twenty-two bones: the spine, a collarbone and an arm a side (the shoulder moves with the arm's swing), a leg a
    side with the foot in two (the heel lifts and the toes stay on the ground as a step pushes off)."""
    return [(f"{k}_Root", None), (f"{k}_Hips", f"{k}_Root"), (f"{k}_Spine", f"{k}_Hips"), (f"{k}_Chest", f"{k}_Spine"),
            (f"{k}_Neck", f"{k}_Chest"), (f"{k}_Head", f"{k}_Neck")] + [
        b for s, _ in SIDES for b in ((f"{k}_Clavicle{s}", f"{k}_Chest"), (f"{k}_UpperArm{s}", f"{k}_Clavicle{s}"), (f"{k}_LowerArm{s}", f"{k}_UpperArm{s}"),
                                       (f"{k}_Hand{s}", f"{k}_LowerArm{s}"), (f"{k}_UpperLeg{s}", f"{k}_Hips"), (f"{k}_LowerLeg{s}", f"{k}_UpperLeg{s}"),
                                       (f"{k}_Foot{s}", f"{k}_LowerLeg{s}"), (f"{k}_Toe{s}", f"{k}_Foot{s}"))]


# ---- Sculpted bodies. The people are sculpted, public domain bodies (tools/assets/people, made by
# tools/people_assets.py from Blender Studio's Human Base Meshes, with the sculpted hair and eyebrows of Quaternius'
# Universal Base Characters fitted to their heads; see docs/CREDITS.md), not shapes built in code. Here each kind is:
# rigged on this tool's skeleton (the bones placed at the body's own joints, its weights by Blender's bone heat), put
# from the A pose it comes in to stand as ours do, given its own proportions (a slimmer teen; a child of about seven
# with a child's head, face and legs), and dressed: the body under the clothes smoothed (no anatomy shows through)
# and pushed out into a jacket, trousers and shoes as people wear them in a Flemish November. Each part gets a colour
# slot, so the game still dresses every villager itself.
PEOPLE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "people")

# The bodies' joints as they come (the A pose, metres, Blender axes, facing -y; measured on the sculpts), the left side.
JOINTS = {
    "male": dict(Hips=(0, 0.0, 0.92), Spine=(0, 0.0, 1.03), Chest=(0, 0.01, 1.22), Neck=(0, 0.0, 1.415), Head=(0, 0.0, 1.50), HeadTop=(0, 0.0, 1.684),
                 Clavicle=(0.03, 0.0, 1.395), UpperArm=(0.175, 0.01, 1.375), LowerArm=(0.293, -0.006, 1.077), Hand=(0.377, -0.067, 0.877),
                 HandTip=(0.44, -0.14, 0.70), UpperLeg=(0.088, -0.005, 0.875), LowerLeg=(0.129, 0.005, 0.48), Foot=(0.176, 0.045, 0.08),
                 Heel=(0.17, 0.10, 0.0), Toe=(0.236, -0.134, 0.015)),
    "female": dict(Hips=(0, 0.0, 0.895), Spine=(0, 0.0, 1.0), Chest=(0, 0.01, 1.185), Neck=(0, 0.0, 1.38), Head=(0, 0.0, 1.46), HeadTop=(0, 0.0, 1.641),
                   Clavicle=(0.028, 0.0, 1.355), UpperArm=(0.163, 0.012, 1.335), LowerArm=(0.24, 0.02, 1.055), Hand=(0.347, -0.04, 0.84),
                   HandTip=(0.415, -0.10, 0.69), UpperLeg=(0.084, 0.0, 0.853), LowerLeg=(0.103, 0.0, 0.468), Foot=(0.125, 0.035, 0.08),
                   Heel=(0.12, 0.08, 0.0), Toe=(0.165, -0.146, 0.015)),
}
SKELETON = [("Hips", None, "Spine"), ("Spine", "Hips", "Chest"), ("Chest", "Spine", "Neck"), ("Neck", "Chest", "Head"), ("Head", "Neck", "HeadTop")] + [
    b for s in "LR" for b in ((f"Clavicle{s}", "Chest", f"UpperArm{s}"), (f"UpperArm{s}", f"Clavicle{s}", f"LowerArm{s}"),
                              (f"LowerArm{s}", f"UpperArm{s}", f"Hand{s}"), (f"Hand{s}", f"LowerArm{s}", f"HandTip{s}"),
                              (f"UpperLeg{s}", "Hips", f"LowerLeg{s}"), (f"LowerLeg{s}", f"UpperLeg{s}", f"Foot{s}"),
                              (f"Foot{s}", f"LowerLeg{s}", f"Ball{s}"), (f"Toe{s}", f"Foot{s}", f"Toe{s}"))]

# What each kind wears. jacket: how far the jacket stands out from the body (m, at 1.79 m); quilt: a padded jacket's
# baffles; hem: where it ends (share of the height); hood: a hoodie's hood on the back; legs: the trousers; boots: how
# high the shoes come (share of the height, ankle boots); shoe: how far a shoe stands out from the foot.
OUTFIT = {
    "man": dict(jacket=0.02, quilt=0.085, hem=0.5, collar=0.022, legs=0.008, boots=0.0, shoe=0.012),
    "woman": dict(jacket=0.014, quilt=0.0, hem=0.485, collar=0.026, legs=0.005, boots=0.2, shoe=0.01),
    "elder": dict(jacket=0.016, quilt=0.0, hem=0.47, collar=0.02, legs=0.011, boots=0.0, shoe=0.012),
    "teen": dict(jacket=0.012, quilt=0.0, hem=0.52, collar=0.0, hood=True, legs=0.008, boots=0.0, shoe=0.016),
    "child": dict(jacket=0.02, quilt=0.07, hem=0.5, collar=0.02, legs=0.009, boots=0.0, shoe=0.014),
    "cyclist": dict(jacket=0.014, quilt=0.0, hem=0.5, collar=0.024, legs=0.007, boots=0.0, shoe=0.012),
}
# The hairstyles each kind may have (group 6, group 7), and a beard (group 8) for some.
HAIRS = {
    "man": ("Hair_SimpleParted", "Hair_Buzzed", "Hair_Beard"), "woman": ("Hair_Long", "Hair_BuzzedFemale", None),
    "elder": ("Hair_Buzzed", "Hair_SimpleParted", "Hair_Beard"), "teen": ("Hair_SimpleParted", "Hair_Long", None),
    "child": ("Hair_Long", "Hair_SimpleParted", None), "cyclist": ("Hair_SimpleParted", "Hair_Buzzed", "Hair_Beard"),
}
REGION = ("skin", "jacket", "legs", "shoes", "sole", "lips")


def _bone_matrices(rig):
    bpy.context.view_layer.update()
    return {pb.name: rig.matrix_world @ pb.matrix @ pb.bone.matrix_local.inverted() @ rig.matrix_world.inverted() for pb in rig.pose.bones}


def sculpt(k, P):
    """Kind k's body: rigged, standing, in its proportions and its clothes. Its points, faces with (slot, shade) and
    group, each point's weights by our bones' short names, its joints, and the measures the extras are fitted to."""
    base = P["base"]
    H = P["H"]
    s9 = H / 1.79
    fit = OUTFIT[k]
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(PEOPLE, f"body_{base}.glb"))
    new = [o for o in bpy.data.objects if o not in before]
    parts = {o.name.split(".")[0]: o for o in new if o.type == "MESH"}
    body = parts["Body"]
    for o in new:  # the import's own empties stay out of the way
        if o.type != "MESH":
            bpy.data.objects.remove(o, do_unlink=True)
    for o in parts.values():
        o.parent = None
        o.matrix_world = Matrix.Identity(4)
    J0 = {b: Vector(p) for b, p in JOINTS[base].items()}
    for b in list(J0):
        if b not in ("Hips", "Spine", "Chest", "Neck", "Head", "HeadTop"):
            p = J0.pop(b)
            J0[b + "L"] = p
            J0[b + "R"] = Vector((-p.x, p.y, p.z))
    for s in "LR":
        J0["Ball" + s] = J0["Heel" + s].lerp(J0["Toe" + s], 0.72) + Vector((0, 0, 0.02))
    # A skeleton at the sculpt's own joints, and its weights by bone heat.
    arm = bpy.data.armatures.new("fit")
    rig = bpy.data.objects.new("fit", arm)
    bpy.context.scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    for name, par, tail in SKELETON:
        eb = arm.edit_bones.new(name)
        eb.head = J0["Ball" + name[3:]] if name.startswith("Toe") else J0[name]
        eb.tail = J0[tail]
        if (eb.tail - eb.head).length < 1e-3:
            eb.tail = eb.head + Vector((0, 0, 0.05))
        if par:
            eb.parent = arm.edit_bones[par]
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    for name, o in parts.items():
        if o is body:
            continue
        g = o.vertex_groups.new(name="Head")
        g.add(list(range(len(o.data.vertices))), 1.0, "REPLACE")
        o.parent = rig
        o.modifiers.new("arm", "ARMATURE").object = rig
    # Standing as ours do: the arms down a little out from the body, the legs straight down, the feet forward.
    mw = rig.matrix_world

    def at(b):
        bpy.context.view_layer.update()
        return mw @ rig.pose.bones[b].head

    def turn(b, toward, way):
        head = at(b)
        q = (toward() - head).rotation_difference(Vector(way).normalized())
        m = Matrix.Translation(head) @ q.to_matrix().to_4x4() @ Matrix.Translation(-head)
        pb = rig.pose.bones[b]
        pb.matrix = mw.inverted() @ m @ mw @ pb.matrix
        bpy.context.view_layer.update()

    for s, sg in SIDES:
        turn(f"UpperArm{s}", lambda: at(f"LowerArm{s}"), (sg * 0.15, 0.06, -1))
        turn(f"LowerArm{s}", lambda: at(f"Hand{s}"), (sg * 0.06, -0.14, -1))
        turn(f"Hand{s}", lambda: mw @ rig.pose.bones[f"Hand{s}"].tail, (sg * 0.03, -0.16, -1))
        k0, a0 = J0[f"LowerLeg{s}"], J0[f"Foot{s}"]
        h0 = J0[f"UpperLeg{s}"]
        turn(f"UpperLeg{s}", lambda: at(f"LowerLeg{s}"), (sg * 0.035, k0.y - h0.y, k0.z - h0.z))
        turn(f"LowerLeg{s}", lambda: at(f"Foot{s}"), (sg * 0.01, a0.y - k0.y, a0.z - k0.z))
        Mf = _bone_matrices(rig)[f"Foot{s}"]
        heel, toe = Mf @ J0[f"Heel{s}"], Mf @ J0[f"Toe{s}"]
        out = math.degrees(math.atan2(sg * (toe.x - heel.x), heel.y - toe.y))
        foot = rig.pose.bones[f"Foot{s}"]
        a = at(f"Foot{s}")
        m = Matrix.Translation(a) @ rot((0, 0, 1), -sg * (out - 7)).to_matrix().to_4x4() @ Matrix.Translation(-a)
        foot.matrix = mw.inverted() @ m @ mw @ foot.matrix
    M = _bone_matrices(rig)
    J = {}
    for name, par, tail in SKELETON:
        if name.startswith("Toe"):
            continue
        J[name] = M[name] @ J0[name]
    J["HeadTop"] = M["Head"] @ J0["HeadTop"]
    for s in "LR":
        J["HandTip" + s] = M["Hand" + s] @ J0["HandTip" + s]
        for b in ("Heel", "Ball", "Toe"):
            J[b + s] = M["Foot" + s] @ J0[b + s]
    # The posed points and every point's weights.
    dg = bpy.context.evaluated_depsgraph_get()
    names = {g.index: g.name for g in body.vertex_groups}
    ev = body.evaluated_get(dg)
    me = ev.to_mesh()
    co = [v.co.copy() for v in me.vertices]
    wts = [{names[g.group]: g.weight for g in v.groups if g.weight > 1e-3} for v in body.data.vertices]
    faces = [tuple(p.vertices) for p in me.polygons]
    ev.to_mesh_clear()
    others = {}
    for name, o in parts.items():
        if o is body:
            continue
        e = o.evaluated_get(dg)
        m2 = e.to_mesh()
        others[name] = ([v.co.copy() for v in m2.vertices], [tuple(p.vertices) for p in m2.polygons])
        e.to_mesh_clear()
    for o in parts.values():
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.data.objects.remove(rig, do_unlink=True)
    for w in wts:
        tot = sum(w.values()) or 1.0
        for b in w:
            w[b] /= tot

    def wsum(w, *bs):
        return sum(w.get(b, 0.0) for b in bs)

    # ---- Proportions.
    scale = H / J["HeadTop"].z
    eye0 = sum(others["EyeL"][0], Vector()) / len(others["EyeL"][0])
    if k == "child":
        # About seven: a head nearly as big as a grown-up's, short legs, a short neck, no waist or bust, a small
        # jaw and nose under a large forehead, rounder cheeks.
        hj = J["Head"]
        legs_k = 0.86
        hip_z = J["UpperLegL"].z

        def child(p, w):
            head = wsum(w, "Head")
            q = p.copy()
            # the face: below the eyes it shrinks toward the middle, the nose most
            if head > 0.5 and q.z < eye0.z and q.y < hj.y:
                f = 1 - 0.16 * smooth((eye0.z - q.z) / 0.08)
                q.x *= f
                q.y = hj.y + (q.y - hj.y) * (1 - 0.12 * smooth((eye0.z - q.z) / 0.05))
                q.z = eye0.z + (q.z - eye0.z) * 0.84
            nose = Vector((0, eye0.y - 0.035, eye0.z - 0.04))
            dn = (q - nose).length
            if head > 0.5 and dn < 0.03 and q.y < eye0.y:  # a small nose
                q = nose + (q - nose) * (1 - 0.3 * smooth(1 - dn / 0.03)) + Vector((0, 0.006, 0)) * smooth(1 - dn / 0.03)
            ch = Vector((math.copysign(0.035, q.x), eye0.y + 0.0, eye0.z - 0.045))
            dc = (q - ch).length
            if head > 0.5 and dc < 0.035 and q.y < eye0.y + 0.02:  # round cheeks
                q += (q - ch).normalized() * 0.004 * smooth(1 - dc / 0.035)
            if head > 0.5 and q.z > eye0.z:
                q = hj + (q - hj) * Vector((1.03, 1.03, 1.07))
            # the bust and the hips flatter
            chest = wsum(w, "Chest", "Spine")
            if chest > 0.4 and q.y < 0:
                q.y *= 1 - 0.35 * chest * smooth((-q.y - 0.06) / 0.06)
            hips = wsum(w, "Hips", "UpperLegL", "UpperLegR")
            if q.z > hip_z - 0.15 and q.z < J["Spine"].z + 0.05:
                q.x *= 1 - 0.08 * smooth(1 - abs(q.z - hip_z) / 0.15) * min(1.0, hips + chest)
            return q

        co = [child(p, w) for p, w in zip(co, wts)]
        # The head 1.3 times as big against the body; the legs shorter; the neck shorter.
        hbig = 1.3
        neck_z, head_z = J["Neck"].z, J["Head"].z

        def grow(p, w):
            head = min(1.0, wsum(w, "Head") + 0.5 * wsum(w, "Neck") * smooth((p.z - neck_z) / max(1e-3, head_z - neck_z)))
            q = p.copy()
            if head > 0:
                q = q + (q - hj) * (hbig - 1) * head
            if q.z < hip_z:
                q.z = q.z * legs_k
            else:
                q.z = q.z - hip_z * (1 - legs_k)
            if q.z > neck_z * 1.0 - hip_z * (1 - legs_k):
                q.z -= 0.25 * (head_z - neck_z) * min(1.0, (q.z - (neck_z - hip_z * (1 - legs_k))) / (head_z - neck_z))
            return q

        co = [grow(p, w) for p, w in zip(co, wts)]
        def eyes_big(v):  # a child's eyes are nearly a grown-up's: larger against its face
            c = sum(v, Vector()) / len(v)
            return [c + (p - c) * 1.12 for p in v]

        others = {n_: ([grow(child(p, {"Head": 1.0}), {"Head": 1.0}) for p in (eyes_big(v) if n_.startswith("Eye") else v)], f)
                  for n_, (v, f) in others.items()}
        J = {b: grow(p, {"Head": 1.0} if b in ("Head", "HeadTop") else {}) for b, p in J.items()}
        top = max(max(p.z for p in co), max((p.z for v, _ in others.values() for p in v), default=0))
        scale = H / max(J["HeadTop"].z, max(p.z for p in co))
    elif k == "teen":
        # Lanky: narrower in the shoulders and the chest, slimmer limbs.
        def slim(p, w):
            q = p.copy()
            if q.z > J["Spine"].z:
                q.x *= 1 - 0.07 * smooth((q.z - J["Spine"].z) / 0.2) * (1 - wsum(w, "Head"))
            return q
        co = [slim(p, w) for p, w in zip(co, wts)]
        J = {b: (slim(p, {}) if not b.startswith(("Head", "Neck")) else p) for b, p in J.items()}
    elif k == "elder":
        # A rounder belly.
        sp = J["Spine"]

        def belly(p, w):
            q = p.copy()
            if q.y < 0 and abs(q.z - sp.z) < 0.16 and wsum(w, "Spine", "Hips", "Chest") > 0.5:
                q.y -= 0.035 * smooth(1 - abs(q.z - sp.z) / 0.16) * smooth(1 - abs(q.x) / 0.16)
            return q
        co = [belly(p, w) for p, w in zip(co, wts)]
    co = [p * scale for p in co]
    J = {b: p * scale for b, p in J.items()}
    others = {n_: ([p * scale for p in v], f) for n_, (v, f) in others.items()}
    eye_l = sum(others["EyeL"][0], Vector()) / len(others["EyeL"][0])

    # ---- Dressing. Where each garment is follows from a point's place (and, on the arms, its weights): the jacket from
    # its hem to the collar and down the arms to the cuffs, the trousers below it, the shoes (or boots) below them.
    # Under the clothes the body is smoothed (no anatomy shows through), then pushed out by each garment's thickness,
    # which steps down over a centimetre at a hem, so a hem is a ledge and not a painted line.
    shoe_top = J["FootL"].z + 0.035 * s9
    boot_top = max(shoe_top, fit["boots"] * H)
    hem = fit["hem"] * H
    neck_lo = J["Neck"].z
    has_collar = bool(fit.get("collar"))
    collar_back = neck_lo + (0.05 if has_collar else 0.012) * s9
    collar_front = neck_lo + (0.018 if has_collar else -0.004) * s9
    sole = 0.012 * s9
    LEDGE = 0.012 * s9
    cuffs = {}
    for s in "LR":
        el, wr = J["LowerArm" + s], J["Hand" + s]
        cuffs[s] = (el, wr - el)
    mouth_z = eye_l.z - 0.072 * scale * (1.0 if k != "child" else 0.88)

    def collar_z(p):
        return collar_front + (collar_back - collar_front) * smooth((p.y - J["Neck"].y + 0.03 * s9) / (0.06 * s9))

    def arm_t(p):
        el, d = cuffs["L" if p.x > 0 else "R"]
        return (p - el).dot(d) / d.length_squared

    def where(p, armw):
        """The garment at p: skin, jacket, legs, shoes or sole; and for the jacket how far into its collar or cuff (0..1)."""
        if armw > 0.5:
            t = arm_t(p)
            return ("jacket", smooth((t - 0.82) / 0.1)) if t < 0.92 else ("skin", 0.0)
        if p.z >= collar_z(p):
            return "skin", 0.0
        if p.z >= hem:
            return "jacket", (smooth((p.z - neck_lo + 0.012 * s9) / (0.03 * s9)) if has_collar else 0.0)
        if p.z >= boot_top:
            return "legs", 0.0
        return ("shoes" if p.z > sole else "sole"), 0.0

    def thickness(p, armw):
        """How far the clothes stand out at p (m): the garment's own, stepping down over LEDGE below a hem or a cuff."""
        legs = fit["legs"] * s9
        shoe = fit["shoe"] * s9
        if armw > 0.5:
            t = arm_t(p)
            jt = fit["jacket"] * s9 * (0.8 if not fit["quilt"] else 1.0) + 0.004 * s9 * smooth((t - 0.82) / 0.1)
            return jt * (1 - smooth((t - 0.92) / 0.025))
        if p.z >= collar_z(p) + 0.006 * s9:
            return 0.0
        jt = fit["jacket"] * s9
        if fit["quilt"]:
            jt *= 0.72 + 0.56 * abs(math.sin(math.pi * p.z / (fit["quilt"] * s9)))
        if has_collar and p.z > neck_lo - 0.012 * s9:
            jt += fit["collar"] * s9 * 0.5 * smooth((p.z - neck_lo + 0.012 * s9) / (0.03 * s9))
        if p.z >= collar_z(p):
            jt *= 1 - smooth((p.z - collar_z(p)) / (0.006 * s9))
        below = legs + (shoe - legs) * (1 - smooth((p.z - boot_top + LEDGE) / LEDGE))
        if p.z < 0.035 * s9:
            below = shoe
        f = smooth((p.z - hem + LEDGE) / LEDGE)
        return below + (jt - below) * f

    armws = [wsum(w, "UpperArmL", "UpperArmR", "LowerArmL", "LowerArmR", "HandL", "HandR") for w in wts]
    region = [where(p, a)[0] for p, a in zip(co, armws)]
    bm = bmesh.new()
    for p in co:
        bm.verts.new(p)
    bm.verts.ensure_lookup_table()
    for f in faces:
        try:
            bm.faces.new([bm.verts[i] for i in f])
        except ValueError:
            pass
    smooth_n = {"jacket": 6, "legs": 4, "shoes": 4, "sole": 4}
    for rname, n_it in smooth_n.items():
        vs = [bm.verts[i] for i, r in enumerate(region) if r == rname]
        low = [v for v in vs if v.co.z < 0.03 * s9]  # the soles stay on the ground
        keep = [v.co.z for v in low]
        for _ in range(n_it):
            bmesh.ops.smooth_vert(bm, verts=vs, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
        for v, z in zip(low, keep):
            v.co.z = z
    bm.normal_update()
    for i, v in enumerate(bm.verts):
        t = thickness(v.co, armws[i])
        if t > 0:
            v.co += v.normal * t
            v.co.z = max(v.co.z, 0.0)
    co = [v.co.copy() for v in bm.verts]
    bm.free()

    # ---- To Blender once more, to thin it (the face keeps more detail); then the seams are cut straight across
    # (the hem, the boots' or shoes' tops, the soles, the cuffs, the collar) and each face takes its garment's colour.
    me = bpy.data.meshes.new("dressed")
    me.from_pydata([p[:] for p in co], [], faces)
    me.update()
    o = bpy.data.objects.new("dressed", me)
    bpy.context.scene.collection.objects.link(o)
    gw = {b: o.vertex_groups.new(name=b) for b in sorted({b for w in wts for b in w})}
    for i, w in enumerate(wts):
        for b, x in w.items():
            gw[b].add([i], x, "REPLACE")
    coarse = o.vertex_groups.new(name="coarse")
    for i, (p, w) in enumerate(zip(co, wts)):
        face = w.get("Head", 0) > 0.5 and p.y < J["Head"].y - 0.03 * s9 and p.z < eye_l.z + 0.04 * s9
        coarse.add([i], 0.35 if face else 1.0, "REPLACE")
    n0 = len(me.polygons)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    m = o.modifiers.new("thin", "DECIMATE")
    m.ratio = P.get("tris", 3700) / n0
    m.use_collapse_triangulate = True
    m.vertex_group = "coarse"
    m.vertex_group_factor = 1.0
    bpy.ops.object.modifier_apply(modifier=m.name)
    bm = bmesh.new()
    bm.from_mesh(o.data)
    dl = bm.verts.layers.deform.verify()
    gname = {g.index: g.name for g in o.vertex_groups}

    def cut(point, normal, keep=lambda f: True):
        geom = [e for e in bm.edges if keep(e)] + [f for f in bm.faces if keep(f)] + [v for v in bm.verts if keep(v)]
        bmesh.ops.bisect_plane(bm, geom=geom, plane_co=point, plane_no=normal, dist=1e-5)

    def mid(e):
        return sum((v.co for v in (e.verts if hasattr(e, "verts") else [e])), Vector()) / (len(e.verts) if hasattr(e, "verts") else 1)

    def weight_of(v, names):
        return sum(x for gi, x in v[dl].items() if gname[gi] in names)

    ARM = {"UpperArmL", "UpperArmR", "LowerArmL", "LowerArmR", "HandL", "HandR"}
    torso = lambda e: all(weight_of(v, ARM) < 0.5 for v in (e.verts if hasattr(e, "verts") else [e]))
    cut(Vector((0, 0, hem)), Vector((0, 0, 1)), torso)
    cut(Vector((0, 0, hem - LEDGE)), Vector((0, 0, 1)), torso)
    cut(Vector((0, 0, boot_top)), Vector((0, 0, 1)), torso)
    cut(Vector((0, 0, sole)), Vector((0, 0, 1)), torso)
    knee = J["LowerLegL"].z
    if k == "child":
        cut(Vector((0, 0, knee)), Vector((0, 0, 1)), torso)
    def on_arm(sg):
        return lambda e: all(weight_of(v, ARM) > 0.3 for v in (e.verts if hasattr(e, "verts") else [e])) and mid(e).x * sg > 0

    for s, sg in SIDES:
        el, d = cuffs[s]
        cut(el + d * 0.92, d.normalized(), on_arm(sg))
    # The collar line: a plane tilted from the back of the neck down to the front.
    cpt = Vector((0, J["Neck"].y, (collar_back + collar_front) / 2))
    cno = Vector((0, -(collar_back - collar_front) / (0.06 * s9), 1)).normalized()
    cut(cpt, cno, lambda e: abs(mid(e).z - neck_lo) < 0.09 * s9 and torso(e))
    bm.verts.index_update()
    bm.faces.ensure_lookup_table()
    bm.normal_update()
    co = [v.co.copy() for v in bm.verts]
    wts = []
    for v in bm.verts:
        w = {gname[gi]: x for gi, x in v[dl].items() if gname[gi] != "coarse" and x > 1e-3}
        tot = sum(w.values()) or 1.0
        wts.append({b: x / tot for b, x in w.items()})
    SLOT = {"skin": SKIN, "jacket": TOP, "legs": BOTTOM, "shoes": SHOES, "sole": SOLE, "lower": LEGS}
    faces, look, group = [], [], []
    for f in bm.faces:
        vs = [v.index for v in f.verts]
        c = sum((co[i] for i in vs), Vector()) / len(vs)
        aw = sum(wsum(wts[i], *ARM) for i in vs) / len(vs)
        r, edge = where(c, aw)
        shade = 1.0
        if r == "skin" and abs(c.x) < 0.022 * s9 and abs(c.z - mouth_z) < 0.008 * s9 and c.y < J["Head"].y - 0.06 * s9 and wsum(wts[vs[0]], "Head") > 0.8:
            nrm = f.normal
            if nrm.y < -0.5:
                r = "lips"
        if r == "jacket":
            shade = 1.0 - 0.1 * edge
            if aw <= 0.5 and hem - LEDGE <= c.z < hem:
                shade = 0.8  # the underside of the hem
            if fit["quilt"]:
                ph = (c.z / (fit["quilt"] * s9)) % 1.0
                if ph < 0.1 or ph > 0.9:
                    shade *= 0.86  # the stitched seam between two baffles
            if fit.get("hood") and aw <= 0.5 and c.z < hem + 0.06 * s9:
                shade *= 0.9  # the hoodie's ribbed band
        elif r == "legs" and c.z < boot_top + 0.03 * s9 and not fit["boots"]:
            shade = 0.92  # the trousers' turn-up over the shoe
        if r == "legs" and k == "child" and c.z < knee:
            r = "lower"  # a child's trousers below the knee: a colour slot of their own (the football kit's socks)
        faces.append(vs)
        look.append(((SLOT.get(r, LIPS)), shade))
        group.append(0)
    bm.free()
    bpy.data.objects.remove(o, do_unlink=True)
    # ---- The eyes, the eyebrows and the hair: on the head bone; the eyes white with a dark iris looking ahead.
    n_body = len(co)  # the head's measures (for hats) are the skull's, without the hair
    hair_a, hair_b, beard = HAIRS[k]
    pieces = [("EyeL", 0), ("EyeR", 0), ("Brows", 0), (hair_a, HAIR_A), (hair_b, HAIR_B)] + ([(beard, BEARD)] if beard else [])
    for name, grp in pieces:
        if name not in others:
            continue
        v, f = others[name]
        if name.startswith("Hair") or name == "Brows":
            v, f = thin_piece(v, f, P.get("hair_tris", 420) if name.startswith("Hair") and name != "Hair_Beard" else (200 if name == "Hair_Beard" else 80))
        base_i = len(co)
        co.extend(v)
        wts.extend({"Head": 1.0} for _ in v)
        cen = sum(v, Vector()) / len(v)
        for ff in f:
            ids = [base_i + i for i in ff]
            faces.append(ids)
            group.append(grp)
            if name.startswith("Eye"):
                fc = sum((co[i] for i in ids), Vector()) / len(ids)
                ahead = (fc - cen).normalized().dot(Vector((0, -1, 0)))
                look.append((DARK, 1.0) if ahead > 0.84 else (WHITE, 0.92))
            elif name == "Brows":
                look.append((HAIR, 0.8))
            else:
                look.append((HAIR, 1.0 if name != "Hair_Beard" else 0.92))
    # ---- What the rest of this tool needs: the joints, the head's middle and size, the left eye, the chest and the waist.
    hj = J["Head"]
    # The head (without the hair) from the skull's base to the crown; its width and depth from the cranium above the
    # eyes (no nose, no ears), what a hat or a helmet sits on.
    skull = [p for p, w in zip(co[:n_body], wts) if w.get("Head", 0) > 0.9 and p.z > hj.z + 0.02 * H]
    cran = [p for p in skull if p.z > eye_l.z + 0.012 * s9]
    skull = skull + [Vector((max(p.x for p in cran), max(p.y for p in cran), hj.z + 0.03 * H)), Vector((min(p.x for p in cran), min(p.y for p in cran), hj.z + 0.03 * H))]
    skull = [Vector((max(min(p.x, cran_x), -cran_x), max(p.y, cran_y), p.z)) for p in skull
             for cran_x, cran_y in [(max(abs(q.x) for q in cran), min(q.y for q in cran))]]
    lo = Vector((min(p.x for p in skull), min(p.y for p in skull), min(p.z for p in skull)))
    hi = Vector((max(p.x for p in skull), max(p.y for p in skull), max(p.z for p in skull)))
    J["HeadTop"] = Vector((0, hj.y, hi.z))
    ex = others["EyeL"][0]
    eye = (eye_l.x, min(p.y for p in ex), eye_l.z, (max(p.x for p in ex) - min(p.x for p in ex)) / 2)

    def half(z0, z1):
        ring_ = [p for p, w in zip(co, wts) if z0 < p.z < z1 and (w.get("Chest", 0) + w.get("Spine", 0) + w.get("Hips", 0)) > 0.6]
        return (max(abs(p.x) for p in ring_), max(abs(p.y) for p in ring_) * 1.05)

    return {"co": co, "faces": faces, "look": look, "group": group, "weights": wts, "joints": J, "head_c": (lo + hi) / 2, "hr": tuple((hi - lo) / 2),
            "eye": eye, "chest": half(0.68 * H, 0.77 * H), "waist": half(0.56 * H, 0.62 * H),
            "cran": dict(front=min(p.y for p in cran), back=max(p.y for p in cran), half=max(abs(p.x) for p in cran), top=max(p.z for p in cran))}


def thin_piece(v, f, tris):
    """A piece (hair) with fewer triangles."""
    me = bpy.data.meshes.new("piece")
    me.from_pydata([p[:] for p in v], [], f)
    me.update()
    o = bpy.data.objects.new("piece", me)
    bpy.context.scene.collection.objects.link(o)
    n = sum(len(p.vertices) - 2 for p in me.polygons)
    if n > tris:
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.select_all(action="DESELECT")
        o.select_set(True)
        m = o.modifiers.new("thin", "DECIMATE")
        m.ratio = tris / n
        m.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=m.name)
    out = ([vv.co.copy() for vv in o.data.vertices], [tuple(p.vertices) for p in o.data.polygons])
    bpy.data.objects.remove(o, do_unlink=True)
    return out


KINDS = {
    "man": dict(H=1.79, sh=0.205, hip=0.096, girth=1.0, chest=(0.165, 0.11), waist=(0.15, 0.10), head=1.0, sleeve="long", clips="adult", lead=True, umb=True,
                walk=1.38, T=1.06, jog=2.8, hair="short", collar=True, base="male"),
    "woman": dict(H=1.67, sh=0.185, hip=0.1, girth=0.94, chest=(0.15, 0.105), waist=(0.13, 0.092), head=0.97, sleeve="long", clips="adult", lead=True, umb=True,
                  walk=1.32, T=1.0, jog=2.6, hair="long", base="female"),
    "elder": dict(H=1.66, sh=0.19, hip=0.098, girth=1.04, chest=(0.165, 0.12), waist=(0.16, 0.115), head=0.98, sleeve="long", clips="elder", walk=0.95, T=1.16,
                  hair="ring", cane=True, base="male"),
    "teen": dict(H=1.71, sh=0.185, hip=0.09, girth=0.9, chest=(0.15, 0.1), waist=(0.13, 0.088), head=0.96, sleeve="hoodie", clips="adult", umb=True, walk=1.42,
                 T=0.98, jog=3.0, hair="fringe", base="male"),
    "child": dict(H=1.18, sh=0.15, hip=0.072, girth=0.86, chest=(0.12, 0.085), waist=(0.115, 0.085), head=1.0, sleeve="short", clips="child", walk=1.25, T=0.78,
                  jog=2.4, hair="short", child=True, base="female"),
    "cyclist": dict(H=1.76, sh=0.2, hip=0.096, girth=0.98, chest=(0.16, 0.11), waist=(0.145, 0.1), head=1.0, sleeve="long", clips="bike", hair="short", bike=True, base="male"),
}
ORDER = ["man", "woman", "elder", "teen", "child", "cyclist", "dog"]


class Body:
    """A person's joints (rest pose, Blender axes) and bone thicknesses, from its height and build."""

    def __init__(self, k, P):
        self.k, self.P = k, P
        H = P["H"]
        c = P.get("child", False)
        z = dict(ankle=0.046, knee=0.283 if not c else 0.27, hipj=0.515 if not c else 0.48, pelvis=0.54 if not c else 0.505, spine=0.615 if not c else 0.585,
                 chest=0.715 if not c else 0.68, neck=0.825 if not c else 0.79, headb=0.872 if not c else 0.835, shoulder=0.81 if not c else 0.775,
                 elbow=0.625 if not c else 0.6, wrist=0.475 if not c else 0.465, tip=0.39 if not c else 0.395)
        self.z = {n: v * H for n, v in z.items()}
        self.H = H
        hs = P["head"] * (1.18 if c else 1.0) * 1.07 * H / 1.79
        self.hs = hs
        self.head_c = Vector((0, 0.005, self.z["headb"] + 0.105 * hs))
        self.hr = (0.083 * hs, 0.098 * hs, 0.112 * hs)
        sh, hip = P["sh"], P["hip"]
        self.j = {}
        J = self.j
        J["Root"] = Vector((0, 0, 0))
        J["Hips"] = Vector((0, 0, self.z["pelvis"]))
        J["Spine"] = Vector((0, 0.0, self.z["spine"]))
        J["Chest"] = Vector((0, 0.0, self.z["chest"]))
        J["Neck"] = Vector((0, 0.01, self.z["neck"]))
        J["Head"] = Vector((0, 0.01, self.z["headb"]))
        J["HeadTop"] = Vector((0, 0.01, H))
        for s, sg in SIDES:
            J[f"UpperArm{s}"] = Vector((sg * sh, 0.01, self.z["shoulder"]))
            J[f"LowerArm{s}"] = Vector((sg * (sh + 0.025 * H / 1.79), 0.035, self.z["elbow"]))
            J[f"Hand{s}"] = Vector((sg * (sh + 0.03 * H / 1.79), 0.0, self.z["wrist"]))
            J[f"HandTip{s}"] = Vector((sg * (sh + 0.032 * H / 1.79), -0.01, self.z["tip"]))
            J[f"UpperLeg{s}"] = Vector((sg * hip, 0.0, self.z["hipj"]))
            J[f"LowerLeg{s}"] = Vector((sg * hip * 0.98, -0.01, self.z["knee"]))
            J[f"Foot{s}"] = Vector((sg * hip * 0.96, 0.01, self.z["ankle"]))
            J[f"Toe{s}"] = Vector((sg * hip * 0.98, -0.16 * H / 1.79, 0.02))
        self.S = S = sculpt(k, P) if P.get("base") else None
        if S:
            J.update(S["joints"])
            self.z = dict(ankle=J["FootL"].z, knee=J["LowerLegL"].z, hipj=J["UpperLegL"].z, pelvis=J["Hips"].z, spine=J["Spine"].z, chest=J["Chest"].z,
                          neck=J["Neck"].z, headb=J["Head"].z, shoulder=J["UpperArmL"].z, elbow=J["LowerArmL"].z, wrist=J["HandL"].z, tip=J["HandTipL"].z)
            self.head_c, self.hr = S["head_c"], S["hr"]
            self.hs = hs = self.hr[2] / 0.112
            self.P = P = dict(P, sh=J["UpperArmL"].x, hip=J["UpperLegL"].x, chest=S["chest"], waist=S["waist"], hair="none")
        s9 = H / 1.79
        for s, sg in SIDES:
            ua, ft, toe = J[f"UpperArm{s}"], J[f"Foot{s}"], J[f"Toe{s}"]
            J.setdefault(f"Clavicle{s}", Vector((sg * 0.025 * s9, ua.y - 0.01, ua.z - 0.012 * s9)))
            # The heel and the ball of the foot, on the ground: a step rolls from the one to the other.
            J.setdefault(f"Heel{s}", Vector((ft.x, ft.y + 0.055 * s9, 0.0)))
            J.setdefault(f"Ball{s}", J[f"Heel{s}"].lerp(toe, 0.72) + Vector((0, 0, 0.02 * s9)))
        self.thigh = (J["UpperLegL"] - J["LowerLegL"]).length
        self.shin = (J["LowerLegL"] - J["FootL"]).length
        self.upper = (J["UpperArmL"] - J["LowerArmL"]).length
        self.fore = (J["LowerArmL"] - J["HandL"]).length
        g = P["girth"] * H / 1.79
        self.g = g
        # Bones: head, tail, thickness (for the weights).
        tail = {"Root": J["Root"] + Vector((0, 0, 0.1)), "Hips": J["Spine"], "Spine": J["Chest"], "Chest": J["Neck"], "Neck": J["Head"], "Head": J["HeadTop"]}
        thick = {"Root": 0.1, "Hips": 0.12 * g, "Spine": 0.12 * g, "Chest": 0.13 * g, "Neck": 0.05 * g, "Head": 0.09 * hs}
        for s, _ in SIDES:
            tail.update({f"Clavicle{s}": J[f"UpperArm{s}"], f"UpperArm{s}": J[f"LowerArm{s}"], f"LowerArm{s}": J[f"Hand{s}"], f"Hand{s}": J[f"HandTip{s}"],
                         f"UpperLeg{s}": J[f"LowerLeg{s}"], f"LowerLeg{s}": J[f"Foot{s}"], f"Foot{s}": J[f"Ball{s}"], f"Toe{s}": J[f"Toe{s}"]})
            thick.update({f"Clavicle{s}": 0.04 * g, f"UpperArm{s}": 0.05 * g, f"LowerArm{s}": 0.04 * g, f"Hand{s}": 0.04 * g, f"UpperLeg{s}": 0.075 * g,
                          f"LowerLeg{s}": 0.055 * g, f"Foot{s}": 0.045 * g, f"Toe{s}": 0.035 * g})
        self.bones = []
        for name, par in human_bones(k):
            short = name[len(k) + 1:]
            head = J["Ball" + short[3:]] if short.startswith("Toe") else J[short]  # the toes' bone starts at the ball; J["Toe"] is their tip
            self.bones.append((name, par, head, tail[short], thick[short]))
        self.head_of = {b[0]: b[2] for b in self.bones}
        self.parent = {b[0]: b[1] for b in self.bones}
        self.names = [b[0] for b in self.bones]
        if P.get("bike"):
            bike_bones(self)

    def n(self, short):
        return f"{self.k}_{short}"


# ---- Building a person.
def build_person(B):
    k, P, J, H, g, hs = B.k, B.P, B.j, B.H, B.g, B.hs
    n = B.n
    F = Fig()
    if B.S:
        F.add_sculpt(B.S, n)
        extras(F, B)
        return F
    z = B.z
    cw, cd = P["chest"]
    ww, wd = P["waist"]
    child = P.get("child", False)
    s9 = H / 1.79
    # The torso: from below the hips to the shoulders, in the top's colour; the hips' part in the trousers'.
    hipw = (P["hip"] + 0.075 * g)
    torso = []
    for zz, w, d, e in ((z["pelvis"] - 0.03 * s9, hipw * 1.08, wd * 1.1, 2.4), (z["spine"], ww, wd, 2.4), (z["chest"], cw, cd, 2.6),
                        (z["shoulder"] - 0.035 * s9, P["sh"] * 0.93, cd * 0.9, 2.4), (z["neck"] - 0.01 * s9, 0.1 * g, 0.075 * g, 2.2),
                        (z["neck"] + 0.02 * s9, 0.062 * g, 0.056 * g, 2.0)):
        torso.append(ring(Vector((0, 0.005, zz)), Vector((1, 0, 0)), Vector((0, 1, 0)), w, d, 12, e))
    F.add(loft(torso), TOP, (n("Hips"), n("Spine"), n("Chest"), n("Neck")))
    if P["sleeve"] == "hoodie":
        # The hood lying on the shoulders, and the front pocket.
        F.add(torus(Vector((0, 0.035, z["neck"] - 0.005)), 0.085 * g, 0.03 * g, 10, 4), TOP, (n("Chest"), n("Neck")), 0.92)
        F.add(box(Vector((0, -cd * 0.98, z["spine"] + 0.03 * s9)), (cw * 0.55, 0.012, 0.055 * s9)), TOP, (n("Spine"), n("Chest")), 0.88)
    elif P.get("collar"):
        F.add(box(Vector((0, -cd * 0.5, z["neck"] - 0.01)), (0.075 * g, 0.04, 0.02), bevel=0.02), TOP, (n("Chest"),), 1.1)
    # Pelvis in the trousers, from the waist to the crotch: follows the hips and the thighs.
    pelvis = []
    for zz, w, d in ((z["spine"] - 0.01, ww * 0.95, wd * 0.95), (z["pelvis"], hipw * 0.98, wd * 0.99), (z["hipj"] - 0.02 * s9, hipw * 0.98, wd * 0.95),
                     (z["hipj"] - 0.07 * s9, hipw * 0.55, wd * 0.6)):
        pelvis.append(ring(Vector((0, 0.005, zz)), Vector((1, 0, 0)), Vector((0, 1, 0)), w, d, 12, 2.3))
    F.add(loft(pelvis), BOTTOM, (n("Hips"), n("UpperLegL"), n("UpperLegR")))
    for s, sg in SIDES:
        a, kn, an = J[f"UpperLeg{s}"], J[f"LowerLeg{s}"], J[f"Foot{s}"]
        # The leg in the trousers (shorts on a child: skin below them, shorts as the top two rings).
        mid = a.lerp(kn, 0.5)
        calf = kn.lerp(an, 0.35)
        rr = [0.084 * g, 0.074 * g, 0.056 * g, 0.058 * g, 0.046 * g, 0.048 * g]
        pts = [a + Vector((0, 0, 0.03)), mid, kn, calf, an.lerp(kn, 0.12), an + Vector((0, 0, 0.01))]
        if child:
            F.add(tube(pts[:3], [rr[0] * 1.08, rr[1] * 1.1, rr[2] * 1.15], 8), BOTTOM, (n("Hips"), n(f"UpperLeg{s}"), n(f"LowerLeg{s}")))
            F.add(tube(pts[1:], [r * 0.85 for r in rr[1:]], 8), LEGS, (n(f"UpperLeg{s}"), n(f"LowerLeg{s}"), n(f"Foot{s}")))
        else:
            F.add(tube(pts, rr, 8), BOTTOM, (n("Hips"), n(f"UpperLeg{s}"), n(f"LowerLeg{s}")))
        # The shoe: heel to toe, a sole in its own colour.
        L = 0.255 * s9 * (1.05 if child else 1.0)
        heel_y, toe_y = an.y + 0.065 * s9, an.y + 0.065 * s9 - L
        rings_ = []
        for t, w, h, zc in ((0.0, 0.04, 0.04, 0.045), (0.25, 0.046, 0.058, 0.055), (0.6, 0.05, 0.04, 0.04), (0.88, 0.045, 0.028, 0.03), (1.0, 0.03, 0.018, 0.025)):
            y = heel_y + (toe_y - heel_y) * t
            rings_.append(ring(Vector((an.x + sg * 0.004, y, zc * s9)), Vector((1, 0, 0)), Vector((0, 0, 1)), w * s9, h * s9, 8, 2.6))
        F.add(loft(rings_), SHOES, (n(f"Foot{s}"),))
        F.add(box(Vector((an.x + sg * 0.004, (heel_y + toe_y) / 2, 0.009 * s9)), (0.047 * s9, L / 2 + 0.004, 0.009 * s9), bevel=0.02), SOLE, (n(f"Foot{s}"),))
        # The arm: a sleeve to the wrist (to the elbow for a T-shirt), the hand.
        sa, el, wr, tip = J[f"UpperArm{s}"], J[f"LowerArm{s}"], J[f"Hand{s}"], J[f"HandTip{s}"]
        top_ = sa + Vector((-sg * 0.012, 0, 0.022 * s9))
        dome = top_ + Vector((-sg * 0.006, 0, 0.022 * s9))  # a round shoulder, not a flat end
        if P["sleeve"] == "short":
            F.add(tube([dome, top_, sa.lerp(el, 0.55), sa.lerp(el, 0.85)], [0.034 * g, 0.054 * g, 0.048 * g, 0.046 * g], 8), TOP, (n("Chest"), n(f"UpperArm{s}")))
            F.add(tube([sa.lerp(el, 0.5), el, wr], [0.036 * g, 0.033 * g, 0.027 * g], 7), SKIN, (n(f"UpperArm{s}"), n(f"LowerArm{s}"), n(f"Hand{s}")))
        else:
            F.add(tube([dome, top_, sa.lerp(el, 0.5), el, el.lerp(wr, 0.5), wr + (wr - el).normalized() * -0.01],
                       [0.034 * g, 0.055 * g, 0.047 * g, 0.042 * g, 0.038 * g, 0.034 * g], 8),
                  TOP, (n("Chest"), n(f"UpperArm{s}"), n(f"LowerArm{s}"), n(f"Hand{s}")))
        hand_c = wr.lerp(tip, 0.45)
        F.add(ellipsoid(hand_c, (0.022 * g, 0.034 * g, 0.05 * s9), 8, 5), SKIN, (n(f"Hand{s}"),))
    # Neck and head.
    F.add(tube([J["Neck"] + Vector((0, 0, -0.02)), J["Head"] + Vector((0, 0, 0.03 * hs))], [0.056 * g, 0.05 * g], 8), SKIN, (n("Chest"), n("Neck"), n("Head")))
    hc, hr = B.head_c, B.hr
    F.add(ellipsoid(hc, hr, 12, 8, shape=lambda d: 1.0 - 0.1 * max(0.0, -d.z) * max(0.0, abs(d.x))), SKIN, (n("Head"),))
    front = hc.y - hr[1]
    F.add(ellipsoid(Vector((0, front - 0.006 * hs, hc.z - 0.012 * hs)), (0.012 * hs, 0.02 * hs, 0.022 * hs), 6, 4), SKIN, (n("Head"),), 0.97)  # nose
    for s, sg in SIDES:
        F.add(ellipsoid(Vector((sg * 0.03 * hs, front + 0.012 * hs, hc.z + 0.016 * hs)), (0.011 * hs, 0.007 * hs, 0.012 * hs), 6, 4), DARK, (n("Head"),))  # eyes
        F.add(box(Vector((sg * 0.031 * hs, front + 0.01 * hs, hc.z + 0.037 * hs)), (0.016 * hs, 0.004, 0.0035 * hs), euler(roll=-sg * 6).to_matrix()),
              HAIR, (n("Head"),), 0.8)  # brows
        F.add(ellipsoid(Vector((sg * hr[0] * 0.98, hc.y + 0.008, hc.z - 0.002)), (0.012 * hs, 0.022 * hs, 0.03 * hs), 6, 4), SKIN, (n("Head"),), 0.94)  # ears
    F.add(box(Vector((0, front + 0.012 * hs, hc.z - 0.048 * hs)), (0.017 * hs, 0.005, 0.004 * hs), bevel=0.003), LIPS, (n("Head"),))  # mouth
    hair(F, B)
    extras(F, B)
    return F


def hair(F, B):
    """Hair as a shell a little out from the head; where the face is, the shell goes inside the head and is hidden."""
    P, hc, hr, hs, n = B.P, B.head_c, B.hr, B.hs, B.n
    style = P["hair"]

    def scalp(line=0.25, back=-0.2, out=1.08):
        # line: how high on the forehead the hair starts (d.z); back: how far down at the back (d.z).
        def f(d):
            if d.y < -0.35 and d.z < line:  # the face
                return 0.86
            if d.y < 0.1 and d.z < -0.05:  # the cheeks and the jaw (no beard)
                return 0.86
            if d.z < back:
                return 0.86
            return out
        return f

    if style == "short":
        F.add(ellipsoid(hc + Vector((0, 0.004, 0.006)), hr, 12, 8, shape=scalp(0.42, -0.25)), HAIR, (n("Head"),))
    elif style == "fringe":
        F.add(ellipsoid(hc + Vector((0, 0.002, 0.004)), (hr[0] * 1.02, hr[1], hr[2]), 12, 8, shape=scalp(0.15, -0.35, 1.1)), HAIR, (n("Head"),))
    elif style == "ring":
        # Grey round the sides and the back, the top bare.
        F.add(ellipsoid(hc, hr, 12, 8, shape=lambda d: 1.06 if (-0.45 < d.z < 0.35 and d.y > -0.3) else 0.86), HAIR, (n("Head"),))
    elif style == "long":
        # A ponytail (group 6) or a bob to the chin (group 7), over the same cap.
        F.add(ellipsoid(hc + Vector((0, 0.004, 0.006)), hr, 12, 8, shape=scalp(0.38, -0.3)), HAIR, (n("Head"),))
        F.add(ellipsoid(hc + Vector((0, hr[1] * 1.0, -0.01 * hs)), (0.032 * hs, 0.035 * hs, 0.05 * hs), 8, 5), HAIR, (n("Head"),), 0.95, HAIR_A)
        F.add(tube([hc + Vector((0, hr[1] * 1.05, -0.04 * hs)), hc + Vector((0, hr[1] * 1.2, -0.12 * hs)), hc + Vector((0, hr[1] * 1.1, -0.2 * hs))],
                   [0.03 * hs, 0.026 * hs, 0.012 * hs], 7), HAIR, (n("Head"), n("Neck")), 0.95, HAIR_A)
        bob = lambda d: 0.86 if (d.y < -0.3 and d.z < 0.4) or (d.y < -0.12 and d.z < 0.05) else (1.12 if d.z > -0.7 else 0.86)
        F.add(ellipsoid(hc + Vector((0, 0.008, -0.03 * hs)), (hr[0] * 1.05, hr[1] * 1.02, hr[2] * 1.12), 12, 8, shape=bob), HAIR, (n("Head"),), 1.0, HAIR_B)


def extras(F, B):
    """What one has and another hasn't (groups), and what the kind always carries."""
    k, P, J, hc, hr, hs, g, n = B.k, B.P, B.j, B.head_c, B.hr, B.hs, B.g, B.n
    s9 = B.H / 1.79
    z = B.z
    cw, cd = P["chest"]
    # Glasses: two dark rims and a bridge over the eyes.
    front = hc.y - hr[1]
    gx, gy, gz, gr, rim = 0.03 * hs, front - 0.004, hc.z + 0.016 * hs, 0.015 * hs, 0.0028
    if B.S:  # on a sculpted face: round its own eyes
        gx, gy, gz, gr = B.S["eye"]
        gy, gr, rim = gy - 0.007, gr * 1.5, 0.0035
    for s, sg in SIDES:
        F.add(torus(Vector((sg * gx, gy, gz)), gr, rim, 10, 3, euler(pitch=90).to_matrix()), DARK, (n("Head"),), 1, SPECS)
    F.add(box(Vector((0, gy, gz + 0.002)), (max(0.004, gx - gr), 0.002, 0.002)), DARK, (n("Head"),), 1, SPECS)
    # A scarf round the neck, over the jacket's collar, one end hanging down the front.
    ny = J["Neck"].y
    F.add(torus(Vector((0, ny + 0.004 * s9, z["neck"] + 0.028 * s9)), 0.068 * s9, 0.027 * s9, 12, 6, Matrix.Diagonal((1.0, 1.12, 1.0))), ACC2,
          (n("Chest"), n("Neck")), 1, SCARF)
    F.add(box(Vector((0.04 * s9, ny - 0.085 * s9, z["neck"] - 0.07 * s9)), (0.03 * s9, 0.012 * s9, 0.085 * s9), euler(pitch=-14, yaw=8).to_matrix(), bevel=0.02),
          ACC2, (n("Chest"),), 0.9, SCARF)
    # A hoodie's hood, lying on the back of the shoulders.
    if OUTFIT.get(k, {}).get("hood"):
        F.add(torus(Vector((0, cd * 0.55, z["neck"] - 0.02 * s9)), 0.09 * s9, 0.032 * s9, 12, 5, euler(pitch=-25).to_matrix()), TOP, (n("Chest"), n("Neck")), 0.9)
    # A hat: a knitted hat for most, a flat cap for the elder, a helmet for the cyclist.
    if P.get("bike"):
        helm = lambda d: 1.0 if d.z > -0.05 else 0.6
        F.add(ellipsoid(hc + Vector((0, 0.008, 0.028 * hs)), (hr[0] * 1.2, hr[1] * 1.22, hr[2] * 0.98), 12, 7, shape=helm), ACC2, (n("Head"),), 1, HAT)
        for x in (-0.03, 0.0, 0.03):
            F.add(box(hc + Vector((x * hs, 0.01, hr[2] * 0.98 + 0.03 * hs)), (0.007, 0.06 * hs, 0.004)), DARK, (n("Head"),), 1, HAT)
    elif k != "elder":
        # A knitted hat pulled over the hair down to the middle of the forehead and over the ears' tops, with its
        # folded band (November).
        cr = B.S["cran"] if B.S else dict(front=hc.y - hr[1], back=hc.y + hr[1], half=hr[0], top=hc.z + hr[2])
        ez = B.S["eye"][2] if B.S else hc.z
        hz = cr["top"] - ez
        c = Vector((0, (cr["front"] + cr["back"]) / 2 + 0.004 * s9, ez + 0.33 * hz))
        rad = (cr["half"] * 1.2, (cr["back"] - cr["front"]) / 2 * 1.14, (cr["top"] - c.z) * 1.2)
        crown = lambda d: 1.0 if d.z > -0.12 else 0.7
        F.add(ellipsoid(c, rad, 14, 8, shape=crown), ACC, (n("Head"),), 1, HAT)
        F.add(torus(c + Vector((0, 0, 0.01 * s9)), rad[0] * 0.99, 0.017 * s9, 18, 4, Matrix.Diagonal((1.0, rad[1] / rad[0], 1.0))), ACC, (n("Head"),), 0.84, HAT)
    else:
        flat = lambda d: 1.0 if d.z > 0.25 else 0.8
        wide = 1.06 if B.S else 1.0  # over sculpted hair
        F.add(ellipsoid(hc + Vector((0, -0.004, 0.045 * hs)), (hr[0] * 1.14 * wide, hr[1] * 1.16 * wide, hr[2] * 0.72), 12, 6, euler(pitch=-6).to_matrix(), shape=flat), ACC,
              (n("Head"),), 1, HAT)
        F.add(box(hc + Vector((0, -hr[1] - 0.02 * hs, 0.05 * hs)), (0.062 * hs, 0.03 * hs, 0.005), euler(pitch=-12).to_matrix(), bevel=0.02), ACC, (n("Head"),), 0.9, HAT)
    # A bag: the woman's handbag in her left hand, a shoulder bag for the man, a backpack for the teen, the child and the cyclist.
    if k in ("teen", "child", "cyclist"):
        bz = (z["chest"] + z["spine"]) / 2
        F.add(box(Vector((0, cd + 0.07 * g, bz)), (cw * 0.72, 0.065 * g, 0.16 * s9), bevel=0.04), ACC, (n("Chest"), n("Spine")), 1, BAG)
        F.add(box(Vector((0, cd + 0.13 * g, bz - 0.05 * s9)), (cw * 0.5, 0.012, 0.07 * s9), bevel=0.02), ACC, (n("Chest"), n("Spine")), 0.85, BAG)
        for s, sg in SIDES:
            F.add(tube([Vector((sg * cw * 0.45, cd * 0.4, z["shoulder"] + 0.02)), Vector((sg * cw * 0.6, -cd * 0.95, z["chest"])),
                        Vector((sg * cw * 0.55, -cd * 0.8, z["spine"] + 0.02))], [0.012, 0.012, 0.012], 4), ACC, (n("Chest"), n("Spine")), 0.7, BAG)
    elif k == "woman":
        hl = J["HandL"].lerp(J["HandTipL"], 0.6)
        F.add(box(Vector((hl.x + 0.03, hl.y, hl.z - 0.1)), (0.04, 0.12, 0.09), bevel=0.03), ACC, (n("HandL"),), 1, BAG)
        F.add(torus(Vector((hl.x + 0.03, hl.y, hl.z - 0.01)), 0.06, 0.008, 8, 3, euler(roll=90).to_matrix()), ACC, (n("HandL"),), 0.8, BAG)
    elif k == "man":
        F.add(box(Vector((-(P["hip"] + 0.11), 0.0, z["pelvis"] + 0.02)), (0.035, 0.13, 0.11), bevel=0.03), ACC, (n("Hips"),), 1, BAG)
        F.add(tube([Vector((cw * 0.55, -cd * 0.9, z["shoulder"] - 0.01)), Vector((0, -cd * 1.04, z["chest"])), Vector((-cw * 0.95, -cd * 0.6, z["spine"])),
                    Vector((-(P["hip"] + 0.1), -0.02, z["pelvis"] + 0.12))], [0.012] * 4, 4), ACC, (n("Chest"), n("Spine"), n("Hips")), 0.75, BAG)
    # The elder's walking stick in the right hand, down to the ground.
    if P.get("cane"):
        hr_ = J["HandR"].lerp(J["HandTipR"], 0.5)
        F.add(tube([hr_ + Vector((0, -0.01, 0.04)), Vector((hr_.x, hr_.y - 0.015, 0.012))], [0.012, 0.011], 6), LEATHER, (n("HandR"),))
        F.add(tube([hr_ + Vector((0.0, 0.04, 0.035)), hr_ + Vector((0.0, -0.02, 0.05))], [0.013, 0.013], 6), LEATHER, (n("HandR"),), 0.8)
    # The umbrella, held up in the right hand: built where WalkUmb holds it and taken back to the rest pose.
    if P.get("umb"):
        G = umbrella_hold(B)
        inv = G.inverted()
        hand = G @ J["HandR"].lerp(J["HandTipR"], 0.45)
        top = Vector((hand.x, hand.y + 0.02, hand.z + 0.62))
        canopy = []
        for t, r, dz in ((0.0, 0.03, 0.04), (0.3, 0.32, 0.0), (0.65, 0.5, -0.1), (1.0, 0.56, -0.19)):
            canopy.append(ring(top + Vector((0, 0, dz)), Vector((1, 0, 0)), Vector((0, 1, 0)), r, r, 8))
        F.add(loft(canopy), ACC2, (n("HandR"),), 1, UMB, xform=inv)
        F.add(tube([hand + Vector((0, 0, -0.06)), top + Vector((0, 0, 0.08))], [0.008, 0.008], 4), METAL, (n("HandR"),), 1, UMB, xform=inv)


# ======== The bike (the cyclist's): its bones and its mesh.
WHEEL_R = 0.34
BIKE = dict(bb=Vector((0, 0, 0.29)), rear=Vector((0, 0.43, WHEEL_R)), front=Vector((0, -0.63, WHEEL_R)), crank=0.17)


def bike_bones(B):
    k = B.k
    bb, rear, front = BIKE["bb"], BIKE["rear"], BIKE["front"]
    extra = [(f"{k}_Bike", f"{k}_Root", Vector((0, 0.1, 0.3)), Vector((0, -0.2, 0.3)), 0.05),
             (f"{k}_WheelR", f"{k}_Bike", rear, rear + Vector((0.08, 0, 0)), 0.05),
             (f"{k}_WheelF", f"{k}_Bike", front, front + Vector((0.08, 0, 0)), 0.05),
             (f"{k}_Crank", f"{k}_Bike", bb, bb + Vector((0.08, 0, 0)), 0.05)]
    B.bones += extra
    B.head_of.update({b[0]: b[2] for b in extra})
    B.parent.update({b[0]: b[1] for b in extra})
    B.names += [b[0] for b in extra]
    # Where the rider sits and holds on, for the Ride clip: the saddle so that the leg is nearly straight
    # at the bottom of the stroke, the bars ahead of it.
    leg = B.thigh + B.shin
    bottom = bb + Vector((0, 0.03, -BIKE["crank"] + 0.075))  # the ankle over the pedal at the bottom
    ang = math.radians(73)
    s = 0.3
    for _ in range(60):
        seat = bb + Vector((0, math.cos(ang) * s, math.sin(ang) * s))
        hip = seat + Vector((0, 0.0, 0.07))
        s += (0.93 * leg - (hip - bottom).length) * 0.5
    B.saddle = bb + Vector((0, math.cos(ang) * s, math.sin(ang) * s))
    B.bar = Vector((0, front.y + 0.2, B.saddle.z + 0.1))


def build_bike(F, B):
    k = B.k
    n = B.n
    bb, rear, front = BIKE["bb"], BIKE["rear"], BIKE["front"]
    seat, bar = B.saddle, B.bar
    head_top = Vector((0, front.y + 0.1, seat.z - 0.08))
    head_low = Vector((0, front.y + 0.06, WHEEL_R + 0.16))
    fr = (n("Bike"),)
    r = 0.017
    for a, b_ in ((bb, seat + Vector((0, -0.03, -0.08))), (bb, head_low), (seat + Vector((0, -0.04, -0.12)), head_top), (bb, rear), (seat + Vector((0, -0.03, -0.1)), rear),
                  (head_low, head_top)):
        F.add(tube([a, b_], [r, r], 6), FRAME, fr)
    for sg in (1, -1):  # the fork either side of the front wheel
        F.add(tube([head_low + Vector((sg * 0.02, 0, 0)), front + Vector((sg * 0.035, 0, 0))], [0.012, 0.011], 5), FRAME, fr)
    F.add(tube([head_top, bar + Vector((0, 0.02, -0.02))], [0.014, 0.014], 5), METAL, fr)
    F.add(tube([bar + Vector((0.28, 0.06, 0)), bar, bar + Vector((-0.28, 0.06, 0))], [0.012, 0.012, 0.012], 5), METAL, fr)
    for sg in (1, -1):
        F.add(tube([bar + Vector((sg * 0.2, 0.05, 0)), bar + Vector((sg * 0.28, 0.07, 0))], [0.017, 0.017], 6), TYRE, fr)
    F.add(box(seat + Vector((0, 0.03, 0.02)), (0.075, 0.13, 0.03), bevel=0.05), LEATHER, fr)
    F.add(tube([seat + Vector((0, -0.01, -0.06)), seat + Vector((0, 0.01, 0.0))], [0.012, 0.012], 5), METAL, fr)
    # A rack over the rear wheel and mudguards, in the frame's colour.
    F.add(box(rear + Vector((0, 0.0, 0.33)), (0.08, 0.17, 0.008)), METAL, fr, 0.8)
    for wc, bone in ((rear, n("WheelR")), (front, n("WheelF"))):
        m = euler(roll=90).to_matrix()
        F.add(torus(wc, WHEEL_R - 0.018, 0.02, 16, 4, m), TYRE, (bone,))
        F.add(torus(wc, WHEEL_R - 0.045, 0.008, 16, 3, m), METAL, (bone,), 0.9)
        for i in range(3):  # three spokes, so a turn shows
            a = TAU * i / 3
            d = Vector((0, math.cos(a), math.sin(a))) * (WHEEL_R - 0.05)
            F.add(tube([wc - d, wc + d], [0.004, 0.004], 3), METAL, (bone,), 0.8)
        F.add(tube([wc + Vector((0.035, 0, 0)), wc + Vector((-0.035, 0, 0))], [0.02, 0.02], 6), METAL, (bone,))
    # The mudguards follow the frame.
    for wc in (rear, front):
        pts = [wc + Vector((0, math.cos(a) * (WHEEL_R + 0.02), math.sin(a) * (WHEEL_R + 0.02))) for a in np.linspace(math.radians(20), math.radians(160), 6)]
        if wc is front:
            pts = [Vector((p.x, 2 * wc.y - p.y, p.z)) for p in pts]
        F.add(tube(pts, [(0.03, 0.006)] * 6, 4, ref=(1, 0, 0)), FRAME, fr, 0.9)
    # The cranks and pedals turn with the crank bone.
    cr = BIKE["crank"]
    for sg, ph in ((1, 0.0), (-1, math.pi)):
        p = bb + Vector((sg * 0.07, -math.sin(ph) * cr, -math.cos(ph) * cr))
        F.add(tube([bb + Vector((sg * 0.06, 0, 0)), p], [0.011, 0.011], 4), METAL, (n("Crank"),))
        F.add(box(p + Vector((sg * 0.05, 0, 0)), (0.045, 0.03, 0.01)), DARK, (n("Crank"),))
    F.add(torus(bb + Vector((0.05, 0, 0)), 0.09, 0.008, 12, 3, euler(roll=90).to_matrix()), METAL, (n("Crank"),))


# ======== The dog.
DOG_BONES = [("dog_Root", None), ("dog_Hips", "dog_Root"), ("dog_Spine", "dog_Hips"), ("dog_Neck", "dog_Spine"), ("dog_Head", "dog_Neck"), ("dog_Tail", "dog_Hips")] + [
    b for s, _ in SIDES for b in ((f"dog_FrontUpper{s}", "dog_Spine"), (f"dog_FrontLower{s}", f"dog_FrontUpper{s}"),
                                  (f"dog_BackUpper{s}", "dog_Hips"), (f"dog_BackLower{s}", f"dog_BackUpper{s}"))]


class DogBody:
    def __init__(self):
        self.k = "dog"
        self.P = {}
        J = {}
        J["Root"] = Vector((0, 0, 0))
        J["Hips"] = Vector((0, 0.24, 0.47))
        J["Spine"] = Vector((0, -0.12, 0.49))
        J["Neck"] = Vector((0, -0.3, 0.53))
        J["Head"] = Vector((0, -0.41, 0.66))
        J["HeadTip"] = Vector((0, -0.62, 0.62))
        J["Tail"] = Vector((0, 0.35, 0.52))
        J["TailTip"] = Vector((0, 0.56, 0.62))
        for s, sg in SIDES:
            J[f"FrontUpper{s}"] = Vector((sg * 0.075, -0.22, 0.42))
            J[f"FrontLower{s}"] = Vector((sg * 0.075, -0.21, 0.22))
            J[f"FrontPaw{s}"] = Vector((sg * 0.075, -0.23, 0.03))
            J[f"BackUpper{s}"] = Vector((sg * 0.08, 0.25, 0.43))
            J[f"BackLower{s}"] = Vector((sg * 0.08, 0.31, 0.22))
            J[f"BackPaw{s}"] = Vector((sg * 0.08, 0.27, 0.03))
        self.j = J
        tail = {"Root": J["Root"] + Vector((0, 0, 0.1)), "Hips": J["Spine"], "Spine": J["Neck"], "Neck": J["Head"], "Head": J["HeadTip"], "Tail": J["TailTip"]}
        thick = {"Root": 0.1, "Hips": 0.14, "Spine": 0.14, "Neck": 0.07, "Head": 0.08, "Tail": 0.03}
        for s, _ in SIDES:
            tail.update({f"FrontUpper{s}": J[f"FrontLower{s}"], f"FrontLower{s}": J[f"FrontPaw{s}"], f"BackUpper{s}": J[f"BackLower{s}"], f"BackLower{s}": J[f"BackPaw{s}"]})
            thick.update({f"FrontUpper{s}": 0.05, f"FrontLower{s}": 0.035, f"BackUpper{s}": 0.06, f"BackLower{s}": 0.035})
        self.bones = [(name, par, J[name[4:]], tail[name[4:]], thick[name[4:]]) for name, par in DOG_BONES]
        self.head_of = {b[0]: b[2] for b in self.bones}
        self.parent = {b[0]: b[1] for b in self.bones}
        self.names = [b[0] for b in self.bones]
        self.H = 0.75

    def n(self, short):
        return f"dog_{short}"


def build_dog(B):
    J, n = B.j, B.n
    F = Fig()
    F.add(ellipsoid(Vector((0, 0.06, 0.48)), (0.12, 0.3, 0.13), 12, 7), TOP, (n("Hips"), n("Spine")))
    F.add(ellipsoid(Vector((0, -0.18, 0.47)), (0.125, 0.15, 0.15), 10, 6), TOP, (n("Spine"), n("Neck")))
    F.add(ellipsoid(Vector((0, -0.2, 0.4)), (0.09, 0.11, 0.09), 8, 5), BOTTOM, (n("Spine"),), 1.0)  # the chest's lighter patch
    F.add(tube([J["Neck"] + Vector((0, 0.04, -0.02)), J["Head"] + Vector((0, 0.0, -0.02))], [0.075, 0.06], 8), TOP, (n("Spine"), n("Neck"), n("Head")))
    hc = J["Head"] + Vector((0, -0.04, 0.02))
    F.add(ellipsoid(hc, (0.075, 0.09, 0.075), 10, 6), TOP, (n("Head"),))
    F.add(ellipsoid(hc + Vector((0, -0.1, -0.03)), (0.045, 0.07, 0.04), 8, 5), BOTTOM, (n("Head"),))  # muzzle
    F.add(ellipsoid(hc + Vector((0, -0.165, -0.015)), (0.018, 0.014, 0.014), 6, 4), DARK, (n("Head"),))  # nose
    for s, sg in SIDES:
        F.add(ellipsoid(hc + Vector((sg * 0.035, -0.07, 0.028)), (0.01, 0.006, 0.01), 6, 4), DARK, (n("Head"),))
        # Floppy ears (group 6) or pricked ears (group 7).
        F.add(ellipsoid(hc + Vector((sg * 0.07, 0.01, -0.02)), (0.018, 0.04, 0.06), 6, 4, euler(roll=sg * 15).to_matrix()), BOTTOM, (n("Head"),), 0.85, HAIR_A)
        F.add(tube([hc + Vector((sg * 0.045, 0.02, 0.05)), hc + Vector((sg * 0.055, 0.03, 0.12))], [(0.03, 0.012), (0.004, 0.003)], 5), TOP, (n("Head"),), 0.9, HAIR_B)
    F.add(torus(J["Neck"] + Vector((0, -0.01, 0.0)), 0.07, 0.013, 10, 4, euler(pitch=55).to_matrix()), ACC, (n("Neck"), n("Spine")))
    F.add(tube([J["Tail"], J["Tail"].lerp(J["TailTip"], 0.5) + Vector((0, 0, 0.02)), J["TailTip"]], [0.03, 0.022, 0.01], 6), TOP, (n("Tail"),))
    for s, sg in SIDES:
        for part in ("Front", "Back"):
            u, l, p = J[f"{part}Upper{s}"], J[f"{part}Lower{s}"], J[f"{part}Paw{s}"]
            top = u + Vector((0, 0, 0.06))
            F.add(tube([top, u.lerp(l, 0.5), l, p + Vector((0, 0, 0.02))], [0.06 if part == "Back" else 0.05, 0.04, 0.03, 0.026], 7), TOP,
                  (n("Hips") if part == "Back" else n("Spine"), n(f"{part}Upper{s}"), n(f"{part}Lower{s}")))
            F.add(ellipsoid(p + Vector((0, -0.02, 0.0)), (0.03, 0.045, 0.025), 6, 4), BOTTOM, (n(f"{part}Lower{s}"),), 0.95)
    return F


# ======== Weights, Blender objects.
def seg_dist(p, a, b):
    ab = b - a
    L2 = float(ab @ ab)
    if L2 < 1e-12:
        return np.linalg.norm(p - a, axis=1)
    t = np.clip(((p - a) @ ab) / L2, 0.0, 1.0)
    return np.linalg.norm(p - (a + t[:, None] * ab), axis=1)


def weights(B, F):
    co = np.array([c[:] for c in F.co])
    index = {b: i for i, b in enumerate(B.names)}
    field = {b[0]: (np.array(b[2][:]), np.array(b[3][:]), b[4]) for b in B.bones}
    W = np.zeros((len(co), len(B.names)))
    groups = {}
    for i, a in enumerate(F.allow):
        groups.setdefault(a, []).append(i)
    for i, ws in F.given.items():
        top = sorted(ws.items(), key=lambda kv: -kv[1])[:4]
        total = sum(w for _, w in top)
        for b, w in top:
            W[i, index[b]] = w / total
    for allow, idx in groups.items():
        if allow == ("@",):
            continue
        idx = np.array(idx)
        if len(allow) == 1:
            W[idx, index[allow[0]]] = 1.0
            continue
        pull = np.zeros((len(idx), len(allow)))
        for kk, b in enumerate(allow):
            a, c, r = field[b]
            pull[:, kk] = np.maximum(seg_dist(co[idx], a, c) / r, 0.05) ** -FALLOFF
        order = np.argsort(-pull, axis=1)
        keep = np.zeros_like(pull, dtype=bool)
        keep[np.arange(len(idx))[:, None], order[:, :4]] = True
        pull = np.where(keep, pull, 0.0)
        pull /= pull.sum(axis=1, keepdims=True)
        pull = np.where(pull < 0.01, 0.0, pull)
        pull /= pull.sum(axis=1, keepdims=True)
        for kk, b in enumerate(allow):
            W[idx, index[b]] = pull[:, kk]
    return W


def preview_material():
    m = bpy.data.materials.new("villager")
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    p.inputs["Roughness"].default_value = 0.8
    vc = nt.nodes.new("ShaderNodeVertexColor")
    vc.layer_name = "Col"
    nt.links.new(vc.outputs["Color"], p.inputs["Base Color"])
    m.use_backface_culling = True
    return m


def make_mesh(name, B, F, W, mat, rig):
    me = bpy.data.meshes.new(name)
    me.from_pydata([c[:] for c in F.co], [], F.faces)
    me.update()
    # Every piece's faces outward (each piece is closed).
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    bmesh.ops.recalc_face_normals(bm, faces=[f for f in bm.faces if f.index >= F.sculpted])
    bm.to_mesh(me)
    bm.free()
    me.update()
    uv = me.uv_layers.new(name="UVMap")
    ca = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    for p in me.polygons:
        f = p.index
        u = F.slot[f] + 16 * F.group[f] + 0.5
        v = 1.0 - F.shade[f]
        col = rgb(PREVIEW_COL[F.slot[f]])
        for li in p.loop_indices:
            uv.data[li].uv = (u, v)
            ca.data[li].color_srgb = (col[0] * F.shade[f], col[1] * F.shade[f], col[2] * F.shade[f], 1.0)
    me.color_attributes.active_color = ca
    me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    me.set_sharp_from_angle(angle=math.radians(60))
    me.materials.append(mat)
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    for i, b in enumerate(B.names):
        g = obj.vertex_groups.new(name=b)
        for v in np.nonzero(W[:, i])[0]:
            g.add([int(v)], float(W[v, i]), "REPLACE")
    obj.parent = rig
    mod = obj.modifiers.new("Armature", "ARMATURE")
    mod.object = rig
    return obj


FAR_TRIS = 1500


def far_mesh(near, F, tris):
    """The same figure with far fewer triangles, for villagers further off (world/villagers.ts draws it beyond a few tens
    of metres): on the same bones. Each face's colour slot, group and shade ride on a material of its own while it is
    thinned (a face keeps its material; a corner's UV would be blended), and go back into the UVs afterwards."""
    o = near.copy()
    o.data = near.data.copy()
    o.name = o.data.name = near.name.replace("_body", "_far")
    bpy.context.scene.collection.objects.link(o)
    me = o.data
    me.materials.clear()
    looks = {}
    for f in range(len(F.faces)):
        key = (F.slot[f], F.group[f], round(F.shade[f], 3))
        if key not in looks:
            looks[key] = len(looks)
            me.materials.append(bpy.data.materials.new(f"look{len(looks)}"))
        me.polygons[f].material_index = looks[key]
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    m = o.modifiers.new("thin", "DECIMATE")
    m.ratio = tris / F.tris()
    m.use_collapse_triangulate = True
    o.modifiers.move(len(o.modifiers) - 1, 0)
    bpy.ops.object.modifier_apply(modifier=m.name)
    back = {i: key for key, i in looks.items()}
    uv = me.uv_layers["UVMap"]
    for p in me.polygons:
        slot, group, shade = back[p.material_index]
        for li in p.loop_indices:
            uv.data[li].uv = (slot + 16 * group + 0.5, 1.0 - shade)
    me.materials.clear()
    me.materials.append(MAT)
    return o


def make_rig(B, parent):
    arm = bpy.data.armatures.new(f"vil_{B.k}_rig")
    obj = bpy.data.objects.new(f"vil_{B.k}_rig", arm)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = parent
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    for name, par, h, t, _ in B.bones:
        eb = arm.edit_bones.new(name)
        eb.head, eb.tail = h, t
        d = (t - h).normalized()
        eb.align_roll(Vector((0, -1, 0)) if abs(d.z) > 0.7 else Vector((0, 0, 1)))
        eb.use_deform = True
        if par:
            eb.parent = arm.edit_bones[par]
            eb.use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    for pb in obj.pose.bones:
        pb.rotation_mode = "QUATERNION"
    return obj


# ======== Posing.
class Pose:
    """One frame: per bone a rotation relative to its parent (in the figure's axes) or an absolute one, the
    hips' offset, and IK targets for limbs (ankle or wrist positions, with the way the knee or elbow points)."""

    def __init__(self):
        self.rel = {}
        self.abs = {}
        self.off = {}
        self.ik = {}


def basis(d, pole):
    e1 = d.normalized()
    e2 = (pole - e1 * pole.dot(e1)).normalized()
    e3 = e1.cross(e2)
    return Matrix((e1, e2, e3)).transposed()


def solve(B, p):
    """Each bone's rotation relative to its parent (Q) and its rest-to-pose transform (G)."""
    R, G, Q = {}, {}, {}
    for name in B.names:
        par = B.parent[name]
        Rp = R[par] if par else Quaternion()
        Gp = G[par] if par else Matrix.Identity(4)
        h = B.head_of[name]
        if name in p.ik:
            # Two bones to a target: this bone (the upper), the next (the lower) solved with it.
            target, pole, lower, end = p.ik[name]
            S = Gp @ (h + p.off.get(name, Vector()))
            a = (B.head_of[lower] - h).length
            b = (B.head_of[end] - B.head_of[lower]).length
            dvec = target - S
            d = min(max(dvec.length, 1e-4), (a + b) * 0.9995)
            dn = dvec.normalized()
            cos_a = max(-1.0, min(1.0, (a * a + d * d - b * b) / (2 * a * d)))
            alpha = math.acos(cos_a)
            pn = (pole - dn * pole.dot(dn)).normalized()
            up_dir = (dn * math.cos(alpha) + pn * math.sin(alpha)).normalized()
            K = S + up_dir * a
            lo_dir = (S + dn * d - K).normalized()
            rest_u = (B.head_of[lower] - h).normalized()
            rest_l = (B.head_of[end] - B.head_of[lower]).normalized()
            rest_pole = B.rest_pole[name]
            Ru = (basis(up_dir, pole) @ basis(rest_u, rest_pole).transposed()).to_quaternion()
            Rl = (basis(lo_dir, pole) @ basis(rest_l, rest_pole).transposed()).to_quaternion()
            p.abs[name] = Ru
            p.abs[lower] = Rl
        if name in p.abs:
            Rb = p.abs[name]
            q = Rp.inverted() @ Rb
        else:
            q = p.rel.get(name, Quaternion())
            Rb = Rp @ q
        off = p.off.get(name, Vector())
        G[name] = Gp @ Matrix.Translation(h + off) @ q.to_matrix().to_4x4() @ Matrix.Translation(-h)
        R[name] = Rb
        Q[name] = q
    return Q, G


def cyclic_smooth(vals, width):
    n = len(vals)
    out = []
    for i in range(n):
        acc = wsum = 0.0
        for k in range(-width, width + 1):
            w = math.exp(-(k / max(1, width / 2)) ** 2)
            acc += vals[(i + k) % n] * w
            wsum += w
        out.append(acc / wsum)
    return out


def lower_envelope(raw, passes=30):
    """Smoothed, never above the raw values (the hips never higher than a leg reaches)."""
    v = list(raw)
    n = len(v)
    for _ in range(passes):
        v = [min(raw[i], (v[i - 1] + 2 * v[i] + v[(i + 1) % n]) / 4) for i in range(n)]
    return v


def herm(p0, p1, m0, m1, u):
    """Cubic Hermite: from p0 to p1 with slopes m0 and m1 (per unit of u)."""
    u2, u3 = u * u, u * u * u
    return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * m1


def kf(t, L, keys):
    """A keyed value on a loop of L seconds: keys [(time, value), ...] in order, eased from one to the next (and from
    the last round to the first)."""
    t %= L
    n = len(keys)
    for i in range(n):
        t0, v0 = keys[i]
        t1, v1 = keys[(i + 1) % n]
        if i == n - 1:
            t1 += L
        tt = t if t >= t0 else t + L
        if t0 <= tt < t1:
            return v0 + (v1 - v0) * smooth((tt - t0) / (t1 - t0))
    return keys[0][1]


def even(T):
    """A loop's length in seconds rounded to an even number of frames (the keys come every other frame)."""
    return 2 * max(1, round(T * FPS / 2)) / FPS


# How each kind walks (the shared parts of a step; tools/villagers.py gait). beta: the share of a loop a foot is on the
# ground; heel: the toes up as the heel strikes (deg); push: the heel up as the toes push off (deg); lift: how high the
# ankle comes in the swing (share of the leg); bob, shift: the hips up and down, side to side (m, at 1.79 m); tilt and
# turn: the pelvis dropping on the swinging side and turning with the leg (deg); thor: the chest turning against it;
# swing, elbow: the arms; lean: forward from the ankles; hunch: shoulders up against the cold; knee: how straight a
# leg gets (share of its length).
GAIT = {
    "man": dict(beta=0.61, heel=15, push=40, lift=0.07, bob=0.022, shift=0.024, tilt=4.5, turn=6, thor=5, swing=15, elbow=14, lean=3, width=0.9, knee=0.975),
    "woman": dict(beta=0.61, heel=13, push=38, lift=0.065, bob=0.02, shift=0.03, tilt=5.5, turn=7, thor=4, swing=13, elbow=18, lean=2, width=0.62, knee=0.975),
    "elder": dict(beta=0.65, heel=7, push=24, lift=0.045, bob=0.012, shift=0.03, tilt=3, turn=4, thor=3, swing=9, elbow=22, lean=4, width=1.05, knee=0.955),
    "teen": dict(beta=0.6, heel=15, push=40, lift=0.07, bob=0.026, shift=0.022, tilt=4.5, turn=7, thor=6, swing=14, elbow=12, lean=1, width=0.85, knee=0.975,
                 slouch=6),
    "child": dict(beta=0.58, heel=16, push=40, lift=0.085, bob=0.032, shift=0.026, tilt=4, turn=6, thor=6, swing=20, elbow=18, lean=3, width=0.95, knee=0.97),
}


def foot_geom(B, s):
    """A foot at rest: its ankle, and the heel and the ball (on the ground) from the ankle."""
    J = B.j
    a = J[f"Foot{s}"]
    return a, J[f"Heel{s}"] - a, J[f"Ball{s}"] - a


def settle(B, p, f):
    """The hips as high as the legs reach (each at most f of its length) with the feet where `p` puts them."""
    n = B.n
    J = B.j
    hip = J["Hips"]
    R = p.rel.get(n("Hips"), Quaternion()).to_matrix()
    off = p.off.get(n("Hips"), Vector())
    leg = (B.thigh + B.shin) * f
    best = 99.0
    for s, _ in SIDES:
        a = p.ik[n(f"UpperLeg{s}")][0]
        h = hip + off + R @ (J[f"UpperLeg{s}"] - hip)
        dh = math.hypot(a.x - h.x, a.y - h.y)
        best = min(best, a.z + math.sqrt(max(0.0, leg * leg - dh * dh)) - h.z)
    return best


def arms_swing(B, p, ph, st, sw_scale=1.0):
    """Arms swinging against the legs (the left arm forward with the right leg), the shoulders going with them."""
    n = B.n
    A = st["swing"] * sw_scale
    for s, sg in SIDES:
        c = math.cos(TAU * (ph - 0.04 + (0.0 if s == "L" else 0.5)))  # +1: back, -1: forward; a little behind the legs
        pitch = A * c - A * 0.25
        p.rel[n(f"Clavicle{s}")] = euler(yaw=sg * 3.5 * c, roll=-sg * st.get("hunch", 0))
        p.rel[n(f"UpperArm{s}")] = euler(pitch=pitch, roll=-sg * (5 + st.get("hunch", 0) * 0.6))
        p.rel[n(f"LowerArm{s}")] = euler(pitch=-st["elbow"] - 0.8 * max(0.0, -pitch), yaw=-sg * 4)
        p.rel[n(f"Hand{s}")] = euler(pitch=-6, yaw=-sg * 4)


def arms_pockets(B, p, ph, sway=3.0):
    """Hands in the jacket's pockets: the arms close to the body, bent, moving only a little with the step."""
    n = B.n
    for s, sg in SIDES:
        c = math.cos(TAU * (ph + (0.0 if s == "L" else 0.5)))
        p.rel[n(f"Clavicle{s}")] = euler(yaw=sg * 1.5 * c, roll=-sg * 4)
        p.rel[n(f"UpperArm{s}")] = euler(pitch=12 + sway * c, roll=-sg * 6)
        p.rel[n(f"LowerArm{s}")] = euler(pitch=-38, yaw=-sg * 12)
        p.rel[n(f"Hand{s}")] = euler(pitch=-10, roll=-sg * 6)


def gait(B, v, T, st, arms="swing", stoop=0.0):
    """A walk at speed v (m/s), a loop of T seconds, as people walk: the heel strikes with the toes up, the foot rolls
    flat and stays where it is on the ground, the heel lifts and the foot pushes off from the ball while the toes stay
    down; the swinging foot comes through low. The hips rise over the planted leg and sink as both feet are down, shift
    over the planted foot, tilt down on the swinging side and turn with the leg; the chest turns the other way, the arms
    swing against the legs, the head stays level and looks ahead. `arms`: swing, pockets, umbrella, lead, cane."""
    n = B.n
    J = B.j
    D = v * T
    beta = st["beta"]
    s9 = B.H / 1.79
    Dst = D * beta  # the ground a foot is on goes back this far while it is down
    uA, uB = 0.11, 0.52  # heel rocker to here, foot flat to here, then the heel rises
    feet = {s: foot_geom(B, s) for s, _ in SIDES}
    yaws = {s: rot((0, 0, 1), sg * 7) for s, sg in SIDES}  # toes a little out

    def rf(s, th):
        return yaws[s] @ rot((1, 0, 0), th)

    def stance(s, sg, u):
        """Ankle, foot pitch (deg: + heel up) and whether the toes lie flat, a share u into the stance."""
        a, hO, bO = feet[s]
        fx = a.x * st["width"] + sg * 0.012 * s9 * (1 - st["width"])
        g = a.y - Dst / 2 + Dst * u - 0.015 * s9  # the ankle over the flat foot: the middle of the stance a little ahead of the hip
        flat = Vector((fx, g, a.z))
        if u < uA:
            th = -st["heel"] * (1 - smooth(u / uA))
            heel = flat + yaws[s] @ hO
            return heel - rf(s, th) @ hO, th, False
        if u < uB:
            return flat, 0.0, False
        w = (u - uB) / (1 - uB)
        th = st["push"] * w ** 1.6
        ball = flat + yaws[s] @ bO
        return ball - rf(s, th) @ bO, th, True

    def foot(s, sg, ph):
        p = (ph + (0.0 if s == "L" else 0.5)) % 1.0
        if p < beta:
            return stance(s, sg, p / beta) + (0.0,)
        u = (p - beta) / (1 - beta)
        e = 1e-3
        a0, th0, _ = stance(s, sg, 1.0)
        a1, th1, _ = stance(s, sg, 0.0)
        m0 = (a0 - stance(s, sg, 1.0 - e)[0]) / e * (1 - beta) / beta
        m1 = (stance(s, sg, e)[0] - a1) / e * (1 - beta) / beta
        pos = Vector([herm(a0[i], a1[i], m0[i], m1[i], u) for i in range(3)])
        # Up and over: highest early in the swing (the knee bends most there), low as it comes through.
        lift = st["lift"] * (B.thigh + B.shin) * (u ** 0.45 * (1 - u) ** 1.5) / (0.231 ** 0.45 * 0.769 ** 1.5)
        pos.z += lift
        th = kf(u, 1.0, [(0.0, th0), (0.32, 12.0), (0.72, -3.0), (0.999, th1)])
        bend = -th0 * (1 - smooth(u / 0.28))  # the toes still bent up as they leave the ground, then straight
        return pos, th, False, bend

    N = 120
    # The hips: as high as the legs allow (knees never locked), shaped to rise over each planted foot.
    raw = []
    for i in range(N):
        ph = i / N
        p = Pose()
        for s, sg in SIDES:
            p.ik[n(f"UpperLeg{s}")] = (foot(s, sg, ph)[0], None, None, None)
        p.rel[n("Hips")] = euler(roll=-st["tilt"] * math.sin(TAU * ph + 0.6), yaw=-st["turn"] * math.cos(TAU * ph))
        p.off[n("Hips")] = Vector((st["shift"] * s9 * math.sin(TAU * ph + 0.3), 0, 0))
        raw.append(settle(B, p, st["knee"]))
    env = lower_envelope(raw)
    bob = st["bob"] * s9
    mid = beta / 2  # the middle of the left foot's stance
    shaped = [min(e, max(env) - bob * (0.5 - 0.5 * math.cos(2 * TAU * (i / N - mid)))) for i, e in enumerate(env)]
    drops = lower_envelope(shaped, 8)
    slouch = st.get("slouch", 0.0)

    def pose(t):
        ph = (t / T) % 1.0
        i = ph * N
        i0 = int(i) % N
        fr = i - int(i)
        dz = drops[i0] * (1 - fr) + drops[(i0 + 1) % N] * fr
        p = Pose()
        tilt = -st["tilt"] * math.sin(TAU * ph + 0.6)
        turn = -st["turn"] * math.cos(TAU * ph)
        thor = st["thor"] * math.cos(TAU * ph)
        p.off[n("Hips")] = Vector((st["shift"] * s9 * math.sin(TAU * ph + 0.3), 0, dz))
        p.rel[n("Hips")] = euler(pitch=st["lean"] * 0.4, roll=tilt, yaw=turn)
        # The spine takes the pelvis' tilt and turn out again and turns the chest the other way.
        p.rel[n("Spine")] = euler(pitch=st["lean"] * 0.3 + stoop * 0.5 + slouch * 0.3, roll=-tilt * 0.6, yaw=(thor - turn) * 0.45)
        p.rel[n("Chest")] = euler(pitch=st["lean"] * 0.2 + stoop * 0.4 + slouch * 0.5 - 0.8 * math.sin(2 * TAU * ph), roll=-tilt * 0.35,
                                  yaw=(thor - turn) * 0.55)
        # The head steady and looking ahead: it takes the chest's turn out, and nods a little with each step.
        p.rel[n("Neck")] = euler(pitch=-st["lean"] * 0.5 - stoop * 0.6 + slouch * 0.4, yaw=-thor * 0.5)
        p.rel[n("Head")] = euler(pitch=-st["lean"] * 0.4 - stoop * 0.3 - slouch * 0.6 + 1.2 * math.cos(2 * TAU * (ph - mid)), yaw=-thor * 0.5, roll=-tilt * 0.2)
        for s, sg in SIDES:
            a, th, toes_flat, bend = foot(s, sg, ph)
            p.ik[n(f"UpperLeg{s}")] = (a, FWD + Vector((sg * 0.12, 0, 0)), n(f"LowerLeg{s}"), n(f"Foot{s}"))
            q = rf(s, th)
            p.abs[n(f"Foot{s}")] = q
            if toes_flat:
                p.abs[n(f"Toe{s}")] = yaws[s]
            else:
                p.rel[n(f"Toe{s}")] = rot((1, 0, 0), bend)
        if arms == "pockets":
            arms_pockets(B, p, ph)
        else:
            arms_swing(B, p, ph, st, 0.5 if arms == "cane" else 1.0)
        if arms == "umbrella":
            p.rel[n("ClavicleR")] = euler(roll=3)
            p.rel[n("UpperArmR")] = euler(pitch=-38, roll=8, yaw=-10)
            p.rel[n("LowerArmR")] = euler(pitch=-95)
            p.rel[n("HandR")] = euler(pitch=40, roll=-10)
        elif arms == "lead":
            p.rel[n("UpperArmR")] = euler(pitch=-20 + 3 * math.sin(TAU * ph), roll=8)
            p.rel[n("LowerArmR")] = euler(pitch=-34)
        elif arms == "cane":
            # The stick goes forward with the left foot (the right hand swings with it) and comes down as that foot does.
            c = math.cos(TAU * (ph + 0.5))
            p.rel[n("UpperArmR")] = euler(pitch=-6 + 10 * c, roll=6)
            p.rel[n("LowerArmR")] = euler(pitch=-24 - 6 * max(0.0, -c))
            p.rel[n("HandR")] = euler(pitch=8 - 10 * c)
        return p

    return pose, D


def jog(B, v, T, lean=8.0):
    """A jog: a short stance, a flight between the steps, the knees and elbows well bent, more bounce."""
    st = dict(beta=0.38, heel=8, push=30, lift=0.13, bob=0.04, shift=0.012, tilt=3, turn=8, thor=8, swing=30, elbow=80, lean=lean, width=0.55, knee=0.965)
    pose, D = gait(B, v, T, st)

    def p2(t):
        p = pose(t)
        ph = (t / T) % 1.0
        # In the air between the steps: the hips up (the stance in place is too short to lift them by itself).
        p.off[B.n("Hips")].z += 0.022 * B.H / 1.79 * (0.5 - 0.5 * math.cos(2 * TAU * (ph - 0.19)))
        return p

    return p2, D


def stand_feet(B, p, w, free_fwd=0.06, free_out=0.03, free_heel=6.0, spread=0.0):
    """Standing with the weight on the left foot (w=1), the right (w=-1) or both (0): the hips over the loaded foot,
    the pelvis dropping on the free side, the free leg's knee bent and its foot a little forward, out and on its toes."""
    n = B.n
    J = B.j
    s9 = B.H / 1.79
    for s, sg in SIDES:
        a, hO, bO = foot_geom(B, s)
        free = max(0.0, -sg * w)  # how free this leg is
        pos = Vector((a.x + sg * (0.02 + spread) * s9 + sg * free_out * free * s9, a.y - free_fwd * free * s9, a.z))
        yaw = rot((0, 0, 1), sg * (8 + 9 * free))
        th = free_heel * free
        if th > 0:  # on the ball of the foot
            ball = pos + yaw @ bO
            pos = ball - yaw @ rot((1, 0, 0), th) @ bO
            p.abs[n(f"Toe{s}")] = yaw
        p.ik[n(f"UpperLeg{s}")] = (pos, FWD + Vector((sg * 0.12, 0, 0)), n(f"LowerLeg{s}"), n(f"Foot{s}"))
        p.abs[n(f"Foot{s}")] = yaw @ rot((1, 0, 0), th)
    hx = J["UpperLegL"].x * 0.85 * w
    p.off[n("Hips")] = Vector((hx, 0.0, 0.0))
    p.rel[n("Hips")] = euler(roll=-4.5 * w, yaw=-3 * w)


def finish_stand(B, p, knee=0.985):
    n = B.n
    p.off[n("Hips")].z = min(0.0, settle(B, p, knee))


def breathe(p, B, t, depth=1.0):
    n = B.n
    b = math.sin(TAU * t / 4.0)
    for s, sg in SIDES:
        q = p.rel.get(n(f"Clavicle{s}"), Quaternion())
        p.rel[n(f"Clavicle{s}")] = q @ euler(roll=-sg * 1.2 * depth * b)
    q = p.rel.get(n("Chest"), Quaternion())
    p.rel[n("Chest")] = q @ euler(pitch=-1.0 * depth * b)


def arms_hang(B, p, t, out=7.0):
    n = B.n
    for s, sg in SIDES:
        sway = 1.5 * math.sin(TAU * t / 8.0 + sg)
        p.rel.setdefault(n(f"UpperArm{s}"), euler(pitch=-2 + sway, roll=-sg * out))
        p.rel.setdefault(n(f"LowerArm{s}"), euler(pitch=-14, yaw=-sg * 6))
        p.rel.setdefault(n(f"Hand{s}"), euler(pitch=-8, yaw=-sg * 6))


def look(p, B, yaw, pitch=0.0, chest=0.25):
    """Looking round: the head and the neck share a turn, the chest follows a little."""
    n = B.n
    for b, share in (("Neck", 0.4), ("Head", 0.6 - chest * 0.6)):
        q = p.rel.get(n(b), Quaternion())
        p.rel[n(b)] = q @ euler(pitch=pitch * share, yaw=yaw * share)
    q = p.rel.get(n("Chest"), Quaternion())
    p.rel[n("Chest")] = q @ euler(yaw=yaw * chest)


IDLE_S = 8.0  # the standing loops are 8 s: long enough that a look round or a gesture doesn't come back like clockwork


def idles(B, stoop=0.0):
    """Three ways of standing about, each different in where the weight is, where it looks and what the hands do,
    with breathing under them all. A villager standing plays them in turn (world/villagers.ts)."""
    n = B.n
    k = B.k
    L = IDLE_S
    child = k == "child"
    elder = k == "elder"
    lean = stoop

    def base(p, t):
        p.rel[n("Spine")] = euler(pitch=lean * 0.5)
        p.rel[n("Chest")] = euler(pitch=lean * 0.4)
        p.rel[n("Neck")] = euler(pitch=-lean * 0.6)
        p.rel[n("Head")] = euler(pitch=-lean * 0.3)

    # 1: the weight on one leg and then the other, looking round now and then; the hands in the pockets (a teen, a
    # grown-up) or hanging (the elder, who has the stick; a child, who fidgets).
    def idle1(t):
        p = Pose()
        base(p, t)
        w = kf(t, L, [(0.0, 1.0), (3.0, 1.0), (3.8, -1.0), (7.0, -1.0), (7.8, 1.0)])
        stand_feet(B, p, w * (0.6 if elder else 1.0))
        yaw = kf(t, L, [(0.0, 0.0), (1.2, 0.0), (1.8, 38.0), (3.0, 38.0), (3.6, 0.0), (5.6, 0.0), (6.1, -22.0), (6.9, -22.0), (7.4, 0.0)])
        look(p, B, yaw * (1.2 if child else 1.0), -2.0)
        if child or elder:
            arms_hang(B, p, t)
        else:
            arms_pockets(B, p, 0.0, 0.0)
        breathe(p, B, t)
        finish_stand(B, p)
        return p

    # 2: the weight on the right, a glance at the watch on the left wrist, then looking down the street.
    def idle2(t):
        p = Pose()
        base(p, t)
        stand_feet(B, p, kf(t, L, [(0.0, -0.8), (4.5, -0.8), (5.3, 0.3), (7.2, 0.3), (7.9, -0.8)]))
        g = kf(t, L, [(0.0, 0.0), (1.0, 0.0), (1.6, 1.0), (3.2, 1.0), (3.8, 0.0)])  # the watch
        if not child:
            p.rel[n("UpperArmL")] = euler(pitch=-2 - 16 * g, roll=-7 - 10 * g, yaw=-10 * g)
            p.rel[n("LowerArmL")] = euler(pitch=-14 - 78 * g, yaw=-6 - 30 * g)
            p.rel[n("HandL")] = euler(pitch=-8 + 10 * g, roll=-45 * g)
        if child:
            # A child hops from foot to foot and swings its arms instead.
            sw = math.sin(TAU * t / 2.0)
            p.rel[n("UpperArmL")] = euler(pitch=-15 * sw, roll=-10)
            p.rel[n("UpperArmR")] = euler(pitch=15 * sw, roll=10)
        look(p, B, kf(t, L, [(0.0, 0.0), (1.4, -14.0), (3.4, -14.0), (4.2, 30.0), (6.2, 30.0), (7.0, 0.0)]),
             kf(t, L, [(0.0, 0.0), (1.4, 26.0 if not child else 0.0), (3.4, 26.0 if not child else 0.0), (4.0, -3.0), (7.0, 0.0)]))
        arms_hang(B, p, t)
        breathe(p, B, t)
        finish_stand(B, p)
        return p

    # 3: both feet down, rubbing the hands against the cold, then hands clasped in front; a shrug of the shoulders.
    def idle3(t):
        p = Pose()
        base(p, t)
        stand_feet(B, p, kf(t, L, [(0.0, 0.25), (3.5, 0.25), (4.5, -0.3), (7.5, -0.3)]), spread=0.015)
        rub = kf(t, L, [(0.0, 0.0), (0.6, 1.0), (3.4, 1.0), (4.0, 0.6), (7.4, 0.6)])
        r = math.sin(TAU * t * 1.6) * kf(t, L, [(0.0, 0.0), (0.6, 1.0), (3.2, 1.0), (3.8, 0.0)])
        for s, sg in SIDES:
            p.rel[n(f"UpperArm{s}")] = euler(pitch=-14 * rub, roll=-sg * (7 - 3 * rub), yaw=-sg * 14 * rub)
            p.rel[n(f"LowerArm{s}")] = euler(pitch=-14 - 62 * rub + 6 * r * sg, yaw=-sg * (6 + 34 * rub))
            p.rel[n(f"Hand{s}")] = euler(pitch=-8, roll=-sg * 30 * rub, yaw=-sg * (6 + 10 * rub))
        shrug = kf(t, L, [(0.0, 0.0), (4.6, 0.0), (5.0, 1.0), (5.5, 0.0)])
        for s, sg in SIDES:
            p.rel[n(f"Clavicle{s}")] = euler(roll=-sg * 7 * shrug)
        look(p, B, kf(t, L, [(0.0, 8.0), (2.5, -8.0), (4.0, -8.0), (5.0, 24.0), (6.5, 24.0), (7.4, 8.0)]),
             kf(t, L, [(0.0, 10.0), (3.5, 10.0), (4.2, 0.0)]))
        breathe(p, B, t, 1.3)
        finish_stand(B, p)
        return p

    if elder:
        # The elder keeps its right hand on the stick, down at its side.
        def keep_stick(f):
            def g(t):
                p = f(t)
                p.rel[n("ClavicleR")] = Quaternion()
                p.rel[n("UpperArmR")] = euler(pitch=-6, roll=6)
                p.rel[n("LowerArmR")] = euler(pitch=-22)
                p.rel[n("HandR")] = euler(pitch=8)
                return p
            return g
        return [keep_stick(idle1), keep_stick(idle2), keep_stick(idle3)]
    return [idle1, idle2, idle3]


def talk_clip(B, stoop=0.0):
    """Standing with a friend: talking for half the loop (the hands going with the words, the head nodding and
    tilting), listening for the other half (still, a nod now and then). The friend plays it half a loop later, so
    they take turns."""
    n = B.n
    L = IDLE_S
    elder = B.k == "elder"

    def pose(t):
        p = Pose()
        tt = t % L
        speaking = tt < L / 2
        p.rel[n("Spine")] = euler(pitch=stoop * 0.5)
        p.rel[n("Chest")] = euler(pitch=stoop * 0.4)
        p.rel[n("Neck")] = euler(pitch=-stoop * 0.6)
        stand_feet(B, p, kf(t, L, [(0.0, 0.6), (3.6, 0.6), (4.4, -0.7), (7.6, -0.7)]))
        on = kf(t, L, [(0.0, 0.0), (0.4, 1.0), (3.6, 1.0), (4.0, 0.0)])
        g1 = max(0.0, math.sin(TAU * tt / 1.3)) ** 1.5 * on
        g2 = max(0.0, math.sin(TAU * tt / 1.7 + 2.0)) ** 2 * on
        if not elder:
            p.rel[n("UpperArmR")] = euler(pitch=-6 - 22 * g1, roll=7 + 6 * g1, yaw=8 * g1)
            p.rel[n("LowerArmR")] = euler(pitch=-16 - 70 * g1, yaw=6 + 20 * g1)
            p.rel[n("HandR")] = euler(pitch=-8, roll=25 * g1 * math.sin(TAU * tt * 1.5))
        else:
            p.rel[n("UpperArmR")] = euler(pitch=-6, roll=6)
            p.rel[n("LowerArmR")] = euler(pitch=-22)
        p.rel[n("UpperArmL")] = euler(pitch=-4 - 16 * g2, roll=-7 - 4 * g2, yaw=-6 * g2)
        p.rel[n("LowerArmL")] = euler(pitch=-14 - 58 * g2, yaw=-6 - 16 * g2)
        p.rel[n("HandL")] = euler(pitch=-8, roll=-20 * g2)
        if speaking:
            nod = 3.0 * math.sin(TAU * tt * 1.1) + 2.0 * math.sin(TAU * tt * 0.37)
            tilt = 4.0 * math.sin(TAU * tt * 0.25)
        else:
            nod = 5.0 * max(0.0, math.sin(TAU * (tt - 4.0) / 1.6)) ** 3
            tilt = -3.0
        q = euler(pitch=-stoop * 0.3 + nod, roll=tilt, yaw=6 * math.sin(TAU * t / L))
        p.rel[n("Head")] = q
        arms_hang(B, p, t)
        breathe(p, B, t, 1.2 if speaking else 0.8)
        finish_stand(B, p)
        return p

    return pose


def wave_clip(B, stoop=0.0):
    """A wave with the right hand (the elder's left: the stick is in the right): the arm up at the side, the hand going
    from the elbow, the head up and a little to one side."""
    n = B.n
    s, sg = ("L", 1) if B.k == "elder" else ("R", -1)
    T = 1.2

    def pose(t):
        ph = (t / T) % 1.0
        p = Pose()
        p.rel[n("Spine")] = euler(pitch=stoop * 0.5, roll=sg * 2)
        p.rel[n("Chest")] = euler(pitch=stoop * 0.4)
        stand_feet(B, p, sg * 0.5)
        # The upper arm out and up at the side, the forearm up from the elbow and going to and fro, the hand open.
        p.rel[n(f"Clavicle{s}")] = euler(roll=-sg * 12)
        p.rel[n(f"UpperArm{s}")] = euler(pitch=-18, roll=-sg * (98 if B.k != "elder" else 88))
        p.rel[n(f"LowerArm{s}")] = euler(pitch=-12, roll=-sg * (62 + 24 * math.sin(TAU * ph * 2)))
        p.rel[n(f"Hand{s}")] = euler(roll=-sg * (8 + 12 * math.sin(TAU * ph * 2 + 0.6)), pitch=-6)
        if B.k == "elder":
            p.rel[n("UpperArmR")] = euler(pitch=-6, roll=6)
            p.rel[n("LowerArmR")] = euler(pitch=-22)
        p.rel[n("Neck")] = euler(pitch=-stoop * 0.6 - 2)
        p.rel[n("Head")] = euler(pitch=-6 - stoop * 0.3, roll=sg * 5)
        arms_hang(B, p, t)
        breathe(p, B, t)
        finish_stand(B, p)
        return p

    return pose


def clips_for(B):
    """name -> (frames, pose(t), loop distance or 0)."""
    P = B.P
    out = {}
    stoop = 14.0 if B.k == "elder" else 0.0
    if P.get("bike"):
        out["Ride"] = (FPS, ride(B), 2 * TAU * WHEEL_R)
        return out
    st = GAIT[B.k]
    elder = B.k == "elder"
    # Two paces each: a normal walk and a stroll (shorter, slower steps), so a villager's feet keep to the ground at its
    # own pace without long slow strides; the game plays the nearer one (world/villagers.ts).
    paces = [("Walk", P["walk"], P["T"]), ("Stroll", P["walk"] * 0.78, P["T"] * 1.14)]
    for name, v, T0 in paces:
        T = even(T0)
        arms = "cane" if elder else "swing"
        w, D = gait(B, v, T, st, arms, stoop)
        out[name] = (round(T * FPS), w, D)
        if not elder and B.k != "child":
            # Hands in the pockets: the cold of November.
            wp, Dp = gait(B, v, T, dict(st, swing=st["swing"] * 0.3, lean=st["lean"] + 1, hunch=4), "pockets", stoop)
            out[name + "Pk"] = (round(T * FPS), wp, Dp)
    T = even(P["T"])
    if P.get("jog"):
        Tj = even(T * 0.66)
        jg, Dj = jog(B, P["jog"], Tj)
        out["Jog"] = (round(Tj * FPS), jg, Dj)
    if P.get("umb"):
        wu, Du = gait(B, P["walk"] * 0.9, T, dict(st, swing=st["swing"] * 0.8), "umbrella")
        out["WalkUmb"] = (round(T * FPS), wu, Du)
    if P.get("lead"):
        Tl = even(P["T"] * 1.14)
        wl, Dl = gait(B, P["walk"] * 0.78, Tl, st, "lead")
        out["WalkLead"] = (round(Tl * FPS), wl, Dl)
    L = round(IDLE_S * FPS)
    for i, f in enumerate(idles(B, stoop)):
        out["Idle" if i == 0 else f"Idle{i + 1}"] = (L, f, 0)
    if B.k != "child":
        out["Talk"] = (L, talk_clip(B, stoop), 0)
    out["Wave"] = (round(1.2 * FPS), wave_clip(B, stoop), 0)
    out["Sit"] = (L, sitting(B), 0)
    return out


SEAT_H = 0.45


def sitting(B):
    """Sitting on a bench 45 cm high: the hip joints over the seat at the origin, the feet on the ground ahead; leaning
    back a little, the hands on the thighs, looking round, a foot moving now and then."""
    n = B.n
    J = B.j
    L = IDLE_S

    def pose(t):
        p = Pose()
        hj = J["UpperLegL"]
        # Thighs along the seat: the hip joints at the seat's height, the knees forward.
        target_z = SEAT_H + 0.07 * B.H / 1.79
        p.off[n("Hips")] = Vector((0, 0.06, target_z - hj.z))
        p.rel[n("Hips")] = euler(pitch=-10)
        p.rel[n("Spine")] = euler(pitch=3)
        p.rel[n("Chest")] = euler(pitch=6)
        p.rel[n("Head")] = euler(pitch=2)
        look(p, B, kf(t, L, [(0.0, 0.0), (2.0, 0.0), (2.7, 32.0), (4.2, 32.0), (4.9, -6.0), (6.6, -6.0), (7.3, 0.0)]),
             kf(t, L, [(0.0, 4.0), (2.0, 4.0), (2.7, -2.0), (6.6, 6.0), (7.4, 4.0)]))
        tap = kf(t, L, [(0.0, 0.0), (5.0, 0.0), (5.3, 1.0), (6.6, 1.0), (7.0, 0.0)])
        for s, sg in SIDES:
            a, hO, bO = foot_geom(B, s)
            knee_ahead = B.thigh * 0.98
            pos = Vector((a.x + sg * 0.035, 0.06 - knee_ahead - 0.04 - (0.06 if s == "R" else 0.0) * tap, a.z))
            th = 0.0
            if s == "R" and tap > 0:  # a foot tapping on its heel
                th = -14 * tap * max(0.0, math.sin(TAU * t * 1.8))
                heel = pos + hO
                pos = heel - rot((1, 0, 0), th) @ hO
            p.ik[n(f"UpperLeg{s}")] = (pos, FWD + Vector((0, 0, 1.2)), n(f"LowerLeg{s}"), n(f"Foot{s}"))
            p.abs[n(f"Foot{s}")] = rot((0, 0, 1), sg * 6) @ rot((1, 0, 0), th)
            p.rel[n(f"Clavicle{s}")] = euler(yaw=-sg * 3)
            p.rel[n(f"UpperArm{s}")] = euler(pitch=-30, roll=-sg * 12, yaw=-sg * 8)
            p.rel[n(f"LowerArm{s}")] = euler(pitch=-52, yaw=-sg * 14)
            p.rel[n(f"Hand{s}")] = euler(pitch=18)
        breathe(p, B, t, 1.2)
        return p

    return pose


def ride(B):
    """Pedalling: the cranks turn once a loop, the wheels twice; hips on the saddle, hands on the bars."""
    n = B.n
    J = B.j
    bb = BIKE["bb"]
    cr = BIKE["crank"]
    seat, bar = B.saddle, B.bar
    hj = J["UpperLegL"]

    def pose(t):
        ph = t % 1.0
        p = Pose()
        p.off[n("Hips")] = Vector((0, seat.y + 0.03 - J["Hips"].y, seat.z + 0.075 - hj.z + (J["Hips"].z - hj.z) * 0.0))
        p.rel[n("Hips")] = euler(pitch=14, roll=1.5 * math.sin(TAU * ph))
        p.rel[n("Spine")] = euler(pitch=10)
        p.rel[n("Chest")] = euler(pitch=6)
        p.rel[n("Neck")] = euler(pitch=-14)
        p.rel[n("Head")] = euler(pitch=-8)
        p.rel[n("WheelR")] = rot((1, 0, 0), 720 * ph)
        p.rel[n("WheelF")] = rot((1, 0, 0), 720 * ph)
        p.rel[n("Crank")] = rot((1, 0, 0), 360 * ph)
        for s, sg in SIDES:
            a = TAU * ph + (0 if s == "L" else math.pi)
            # The pedal goes round (forward at the top); the ankle above it, a little behind.
            ped = bb + Vector((sg * 0.12, math.sin(a) * cr, -math.cos(a) * cr))
            ankle = ped + Vector((0, 0.035, 0.075))
            p.ik[n(f"UpperLeg{s}")] = (ankle, FWD + Vector((sg * 0.06, 0, 0.3)), n(f"LowerLeg{s}"), n(f"Foot{s}"))
            p.abs[n(f"Foot{s}")] = rot((1, 0, 0), -6 + 10 * math.sin(a))
            grip = bar + Vector((sg * 0.24, 0.05, 0.0))
            p.ik[n(f"UpperArm{s}")] = (grip - (J[f"HandTip{s}"] - J[f"Hand{s}"]) * 0.0, Vector((sg * 0.3, 0.6, -0.4)), n(f"LowerArm{s}"), n(f"Hand{s}"))
            p.abs[n(f"Hand{s}")] = rot((1, 0, 0), -70)
        return p

    return pose


def dog_clips(B):
    n = B.n
    out = {}
    T, v = even(0.62), 1.35
    D = v * T

    def leg_swing(p, part, s, ph, amp, knee):
        a = math.sin(TAU * ph)
        p.rel[n(f"{part}Upper{s}")] = rot((1, 0, 0), amp * a)
        bend = max(0.0, math.cos(TAU * ph)) * knee
        p.rel[n(f"{part}Lower{s}")] = rot((1, 0, 0), bend if part == "Front" else -bend)

    def walk(t):
        ph = (t / T) % 1.0
        p = Pose()
        p.off[n("Hips")] = Vector((0, 0, 0.012 * math.cos(2 * TAU * ph)))
        p.rel[n("Hips")] = euler(yaw=4 * math.sin(TAU * ph))
        p.rel[n("Spine")] = euler(yaw=-4 * math.sin(TAU * ph))
        p.rel[n("Neck")] = euler(pitch=3 * math.sin(2 * TAU * ph))
        p.rel[n("Tail")] = euler(yaw=25 * math.sin(2 * TAU * ph), pitch=-10)
        for s, sg in SIDES:
            leg_swing(p, "Front", s, ph + (0.0 if s == "L" else 0.5), 26, 40)
            leg_swing(p, "Back", s, ph + (0.5 if s == "L" else 0.0) + 0.1, 24, 35)
        return p

    out["Walk"] = (round(T * FPS), walk, D)

    def idle(t):
        ph = (t / 4.0) % 1.0
        p = Pose()
        p.rel[n("Tail")] = euler(yaw=35 * math.sin(TAU * ph * 6), pitch=-15)
        p.rel[n("Neck")] = euler(yaw=12 * math.sin(TAU * ph), pitch=4 * math.sin(TAU * ph * 2))
        p.rel[n("Head")] = euler(roll=6 * math.sin(TAU * ph * 0.5 + 1))
        p.off[n("Hips")] = Vector((0, 0, -0.004 * math.sin(TAU * ph * 4)))
        return p

    out["Idle"] = (4 * FPS, idle, 0)

    def sit(t):
        ph = (t / 4.0) % 1.0
        p = Pose()
        p.off[n("Hips")] = Vector((0, -0.04, -0.2))
        p.rel[n("Hips")] = euler(pitch=-38)
        p.rel[n("Spine")] = euler(pitch=8)
        p.rel[n("Neck")] = euler(pitch=20, yaw=10 * math.sin(TAU * ph))
        p.rel[n("Head")] = euler(pitch=-6)
        p.rel[n("Tail")] = euler(yaw=20 * math.sin(TAU * ph * 4), pitch=30)
        for s, sg in SIDES:
            p.rel[n(f"BackUpper{s}")] = rot((1, 0, 0), -22)
            p.rel[n(f"BackLower{s}")] = rot((1, 0, 0), 97)
            p.rel[n(f"FrontUpper{s}")] = rot((1, 0, 0), 30)
            p.rel[n(f"FrontLower{s}")] = rot((1, 0, 0), 0)
        return p

    out["Sit"] = (4 * FPS, sit, 0)
    return out


def umbrella_hold(B):
    """The right hand's rest-to-pose transform in the middle of WalkUmb (where the umbrella is held)."""
    T = even(B.P["T"])
    pose, _ = gait(B, B.P["walk"] * 0.9, T, dict(GAIT[B.k], swing=GAIT[B.k]["swing"] * 0.8), "umbrella")
    _, G = solve(B, pose(0.25 * T))
    return G[B.n("HandR")]


def set_rest_poles(B):
    """The way each limb's knee or elbow points in the rest pose (knees forward, elbows back)."""
    B.rest_pole = {}
    for s, sg in SIDES:
        B.rest_pole[B.n(f"UpperLeg{s}")] = FWD.copy()
        B.rest_pole[B.n(f"LowerLeg{s}")] = FWD.copy()
        B.rest_pole[B.n(f"UpperArm{s}")] = Vector((0, 1, 0))
        B.rest_pole[B.n(f"LowerArm{s}")] = Vector((0, 1, 0))


def skin_pos(G, co, W, names):
    out = np.zeros_like(co)
    homo = np.hstack([co, np.ones((len(co), 1))])
    for i, b in enumerate(names):
        w = W[:, i]
        idx = np.nonzero(w)[0]
        if not len(idx):
            continue
        M = np.array(G[b])
        out[idx] += (homo[idx] @ M.T)[:, :3] * w[idx, None]
    return out


# ======== Build everything.
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)
scene = bpy.context.scene
scene.render.fps = FPS
bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
MAT = preview_material()
FIGS = {}
REPORT = {}
for k in ORDER:
    if k == "dog":
        B = DogBody()
        B.rest_pole = {}
        F = build_dog(B)
        clips = dog_clips(B)
    else:
        B = Body(k, KINDS[k])
        set_rest_poles(B)
        F = build_person(B)
        if B.P.get("bike"):
            build_bike(F, B)
        clips = clips_for(B)
    W = weights(B, F)
    top = bpy.data.objects.new(f"vil_{k}", None)
    scene.collection.objects.link(top)
    rig = make_rig(B, top)
    mesh = make_mesh(f"vil_{k}_body", B, F, W, MAT, rig)
    if k != "dog":
        far_mesh(mesh, F, FAR_TRIS)
    rest_q = {b: rig.data.bones[b].matrix_local.to_quaternion() for b in B.names}
    co = np.array([c[:] for c in F.co])
    rig.animation_data_create()
    info = {"tris": F.tris(), "verts": len(F.co), "height": float(co[:, 2].max()), "clips": {}}
    dist = {}
    for clip, (frames, posef, D) in clips.items():
        name = f"{k}_{clip}"
        act = bpy.data.actions.new(name)
        rig.animation_data.action = act
        prev = {}
        low = []
        for f in range(0, frames + 1, STEP):
            t = f / FPS
            p = posef(t)
            Q, G = solve(B, p)
            if f % 6 == 0:
                low.append(float(skin_pos(G, co, W, B.names)[:, 2].min()))
            for b in B.names:
                pb = rig.pose.bones[b]
                q = rest_q[b].inverted() @ Q[b] @ rest_q[b]
                if b in prev and prev[b].dot(q) < 0:
                    q.negate()
                prev[b] = q.copy()
                pb.rotation_quaternion = q
                pb.keyframe_insert("rotation_quaternion", frame=f, group=b)
                if b.endswith("_Hips"):
                    pb.location = rest_q[b].inverted() @ p.off.get(b, Vector())
                    pb.keyframe_insert("location", frame=f, group=b)
        track = rig.animation_data.nla_tracks.new()
        track.name = name
        track.strips.new(name, 0, act)
        rig.animation_data.action = None
        dist[clip] = round(D, 4)
        info["clips"][clip] = {"seconds": frames / FPS, "loop_m": round(D, 3), "lowest": round(min(low), 3)}
    rig["clips"] = json.dumps(dist)
    REPORT[k] = info
    FIGS[k] = (top, rig, mesh, B)
    print(f"villager {k}: {info['height']:.2f} m, {info['tris']} triangles, {info['verts']} points; clips {json.dumps(info['clips'])}")

# ======== Export.
bpy.ops.object.select_all(action="DESELECT")
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format="GLB", use_selection=False, export_yup=True, export_apply=False,
    export_texcoords=True, export_normals=True, export_tangents=False, export_materials="NONE",
    export_vertex_color="NONE", export_attributes=False,
    export_cameras=False, export_lights=False, export_extras=True,
    export_skins=True, export_influence_nb=4, export_all_influences=False, export_def_bones=False,
    export_morph=False, export_animations=True, export_animation_mode="ACTIONS", export_nla_strips=True,
    export_force_sampling=True, export_frame_step=STEP, export_optimize_animation_size=True,
    export_optimize_animation_keep_anim_armature=True, export_anim_slide_to_zero=True,
    export_reset_pose_bones=True, export_rest_position_armature=True, export_anim_single_armature=False,
    export_merge_animation="ACTION", export_bake_animation=False, export_leaf_bone=False,
    export_armature_object_remove=False, export_hierarchy_flatten_bones=False)


# ======== Repack (as tools/zombies.py): identical accessors once, weights as normalised bytes, still channels dropped.
def read_glb(path):
    data = open(path, "rb").read()
    jl = struct.unpack("<I", data[12:16])[0]
    return json.loads(data[20:20 + jl]), data[20 + jl + 8:]


def write_glb(path, j, bin_):
    js = json.dumps(j, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    bin_ += b"\0" * (-len(bin_) % 4)
    with open(path, "wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(bin_)))
        fh.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        fh.write(struct.pack("<II", len(bin_), 0x004E4942) + bin_)


COMP = {5126: np.float32, 5123: np.uint16, 5121: np.uint8, 5125: np.uint32}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def raw(j, bin_, i):
    a = j["accessors"][i]
    bv = j["bufferViews"][a["bufferView"]]
    comp, nn = COMP[a["componentType"]], NCOMP[a["type"]]
    item = np.dtype(comp).itemsize * nn
    stride = bv.get("byteStride", item)
    base = np.frombuffer(bin_, np.uint8, (a["count"] - 1) * stride + item, bv.get("byteOffset", 0) + a.get("byteOffset", 0))
    rows = np.lib.stride_tricks.as_strided(base, (a["count"], item), (stride, 1))
    return np.frombuffer(rows.tobytes(), comp).reshape(a["count"], nn)


def accessor(j, bin_, i):
    a = j["accessors"][i]
    arr = raw(j, bin_, i)
    return arr / np.iinfo(arr.dtype).max if a.get("normalized") else arr


def repack(j, bin_):
    nodes = j["nodes"]
    for a in j.get("animations", []):
        keep = []
        for ch in a["channels"]:
            path = ch["target"]["path"]
            if path in ("translation", "scale"):
                out = accessor(j, bin_, a["samplers"][ch["sampler"]]["output"])
                rest = nodes[ch["target"]["node"]].get(path, [0.0] * 3 if path == "translation" else [1.0] * 3)
                if np.abs(out - np.array(rest)).max() < 1e-5:
                    continue
            keep.append(ch)
        used = sorted({ch["sampler"] for ch in keep})
        remap = {o: kk for kk, o in enumerate(used)}
        a["samplers"] = [a["samplers"][o] for o in used]
        for ch in keep:
            ch["sampler"] = remap[ch["sampler"]]
        a["channels"] = keep
    accs, views, blob, seen = [], [], bytearray(), {}

    def store(i, arr=None, comp=None, normalized=None, target=None):
        meta = {kk: v for kk, v in j["accessors"][i].items() if kk not in ("bufferView", "byteOffset")}
        if arr is None:
            arr = raw(j, bin_, i)
        if comp is not None:
            meta["componentType"] = comp
        if normalized is not None:
            meta["normalized"] = normalized
        data = np.ascontiguousarray(arr).tobytes()
        key = (meta["componentType"], meta["type"], meta["count"], meta.get("normalized", False), target, data)
        if key not in seen:
            blob.extend(b"\0" * (-len(blob) % 4))
            view = {"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)}
            if target:
                view["target"] = target
            blob.extend(data)
            meta["bufferView"] = len(views)
            views.append(view)
            accs.append(meta)
            seen[key] = len(accs) - 1
        return seen[key]

    for m in j["meshes"]:
        for pr in m["primitives"]:
            at = pr["attributes"]
            for name in list(at):
                i = at[name]
                if name == "WEIGHTS_0":
                    w = accessor(j, bin_, i)
                    q = np.floor(w * 255 + 0.5)
                    q[np.arange(len(q)), np.argmax(w, axis=1)] += 255 - q.sum(axis=1)
                    at[name] = store(i, q.astype(np.uint8), 5121, True, 34962)
                else:
                    at[name] = store(i, target=34962)
            pr["indices"] = store(pr["indices"], target=34963)
    for sk in j.get("skins", []):
        sk["inverseBindMatrices"] = store(sk["inverseBindMatrices"])
    for a in j.get("animations", []):
        for sm in a["samplers"]:
            sm["input"] = store(sm["input"])
            sm["output"] = store(sm["output"])
    j["accessors"], j["bufferViews"] = accs, views
    j["buffers"] = [{"byteLength": len(blob)}]
    return j, bytes(blob)


size_raw = os.path.getsize(OUT)
j, bin_ = read_glb(OUT)
j, bin_ = repack(j, bin_)
write_glb(OUT, j, bin_)
j, bin_ = read_glb(OUT)
print(f"GLB {OUT}: {size_raw} bytes from Blender, {os.path.getsize(OUT)} repacked; {len(j['animations'])} clips, {len(j['meshes'])} meshes")
for m in j["meshes"]:
    for pr in m["primitives"]:
        print(f"  mesh {m['name']}: {j['accessors'][pr['indices']]['count'] // 3} triangles, {j['accessors'][pr['attributes']['POSITION']]['count']} points,"
              f" attributes {sorted(pr['attributes'])}")
print("extras:", [(nd["name"], nd["extras"]) for nd in j["nodes"] if nd.get("extras")])


# ======== Previews.
def render(path, cam_loc, look_at, lens=50, size=(900, 420)):
    sc = bpy.context.scene
    cam = bpy.data.objects.get("pcam")
    if cam is None:
        cam = bpy.data.objects.new("pcam", bpy.data.cameras.new("pcam"))
        sc.collection.objects.link(cam)
        sun = bpy.data.objects.new("psun", bpy.data.lights.new("psun", "SUN"))
        sun.data.energy = 3.0
        sun.rotation_euler = (math.radians(50), 0, math.radians(30))
        sc.collection.objects.link(sun)
        sc.world = sc.world or bpy.data.worlds.new("w")
        sc.world.color = (0.55, 0.6, 0.65)
    cam.location = cam_loc
    d = Vector(look_at) - Vector(cam_loc)
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    cam.data.lens = lens
    sc.camera = cam
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x, sc.render.resolution_y = size
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)


if PREVIEW:
    os.makedirs(PREVIEW, exist_ok=True)
    for o in bpy.data.objects:
        if o.name.endswith("_far"):
            o.hide_render = True
    groups_shown = {"man": (BAG, HAIR_A), "woman": (HAIR_A, BAG, SCARF), "elder": (HAT, SPECS, SCARF, HAIR_A, BEARD), "teen": (BAG, HAIR_B),
                    "child": (HAIR_A,), "cyclist": (HAT, BAG, HAIR_A), "dog": (HAIR_A,)}
    poses = {"man": "Walk", "woman": "Walk", "elder": "Walk", "teen": "Idle", "child": "Walk", "cyclist": "Ride", "dog": "Walk"}
    for i, k in enumerate(ORDER):
        top, rig, mesh, B = FIGS[k]
        top.location = (i * 1.1 - 3.3, 0, 0)
        # Hide the groups not shown (faces whose group is neither 0 nor chosen): move them out of sight.
        me = mesh.data
        uvl = me.uv_layers[0]
        hide = []
        for p in me.polygons:
            u = uvl.data[p.loop_indices[0]].uv[0]
            gidx = int(u // 16)
            if gidx and gidx not in groups_shown[k]:
                hide.append(p.index)
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[bm.faces[f] for f in hide], context="FACES")
        bm.to_mesh(me)
        bm.free()
        rig.animation_data.action = bpy.data.actions.get(f"{k}_{poses[k]}")
    scene.frame_set(8)
    render(os.path.join(PREVIEW, "lineup.png"), (0.0, -9.5, 1.3), (0.0, 0, 0.85), 35, (1200, 420))
    render(os.path.join(PREVIEW, "lineup_side.png"), (-8.0, -3.0, 1.4), (0.0, 0, 0.8), 45)
    for k in ("man", "woman"):
        FIGS[k][1].animation_data.action = bpy.data.actions.get(f"{k}_WalkUmb" if k == "man" else f"{k}_Sit")
    FIGS["elder"][1].animation_data.action = bpy.data.actions.get("elder_Wave")
    FIGS["teen"][1].animation_data.action = bpy.data.actions.get("teen_Jog")
    FIGS["child"][1].animation_data.action = bpy.data.actions.get("child_Wave")
    FIGS["dog"][1].animation_data.action = bpy.data.actions.get("dog_Sit")
    scene.frame_set(10)
    render(os.path.join(PREVIEW, "poses.png"), (0.0, -9.5, 1.3), (0.0, 0, 0.85), 35, (1200, 420))
    render(os.path.join(PREVIEW, "face.png"), (-3.3 + 0.0, -1.2, 1.62), (-3.3, 0, 1.58), 50, (500, 400))
    for i, k in enumerate(ORDER[:6]):
        hz = FIGS[k][3].head_c.z + (0.35 if k == "cyclist" else 0.0)
        render(os.path.join(PREVIEW, f"head_{k}.png"), (i * 1.1 - 3.3 - 0.35, -1.0, hz + 0.05), (i * 1.1 - 3.3, -0.05, hz - 0.12), 50, (420, 420))
