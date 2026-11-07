"""Build the villagers for Explore in Blender: generic, invented people and a dog, rigged and animated.

Run (Blender 5, no window):
  blender -b -P tools/villagers.py -- [out.glb] [preview_dir]

Nobody in particular: simple, friendly low-poly figures that read from 30 m, no faces of anyone, no names,
no logos. Seven kinds, each one mesh on its own armature:
  man      1.79 m: a shirt or jacket with long sleeves, trousers, shoes, short hair.
  woman    1.67 m: a top, trousers, flat shoes; a ponytail or a bob.
  elder    1.66 m, a little stooped: a cardigan, trousers, grey hair round the sides, a walking stick.
  teen     1.71 m, lanky: a hoodie, jeans, trainers, a fringe.
  child    1.18 m: a T-shirt, shorts or trousers, a big head for its size.
  cyclist  1.76 m on a city bike: a jacket, trousers, a bike in one colour with black tyres.
  dog      0.55 m at the shoulder: a medium dog with floppy or pricked ears and a collar.

Colours: nothing is coloured here for good. Each face carries a slot (skin, hair, top, bottom, shoes, two
accents, legwear, bike frame, and fixed ones such as the eyes' dark, metal and tyres) and a shade in its
UV map (u: slot + 16 * group, v: 1 - shade); the game gives every villager its own colour per slot. Groups
are the extras one villager has and another hasn't, hidden in the game unless chosen: 1 an umbrella, 2 a
bag (a shoulder bag, a handbag or a backpack), 3 a cap or a helmet, 4 a scarf, 5 glasses, 6 and 7 a choice
of hair (or of the dog's ears). The vertex colours are only for the previews.

Skinning as tools/zombies.py does it: each piece names the bones it may follow, and a point is pulled by
each of them by (distance to the bone / its thickness) ** -5, the four strongest kept.

The clips are made here, frame by frame. Legs by two-bone IK to planted feet: a planted foot moves back
at exactly the walking speed, so the distance a loop covers is known (the armature's `clips` property,
exported as the node's extras, gives it per clip: the game plays a walk at the pace the villager goes,
so the feet don't slide). The hips are lowered just as far as a planted leg needs (smoothed round the
loop). Arms by angles, or by IK to a grip (the cyclist's handlebar). Clips: Walk, Idle, Talk, Wave, Sit
for the people, with Jog for the man, the woman, the teen and the child, WalkUmb (an umbrella held up)
for the man, the woman and the teen, WalkLead (a dog's lead in the right hand) for the man and the woman;
Ride for the cyclist (one turn of the cranks, two of the wheels); Walk, Idle and Sit for the dog.

Output: one GLB (Y up, metres). Per kind k a node vil_<k> holding its armature vil_<k>_rig and the skinned
mesh vil_<k>_body; bones named <k>_<Bone> (no dots, so three.js keeps the names); clips <k>_<Clip>,
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
UMB, BAG, HAT, SCARF, SPECS, HAIR_A, HAIR_B = 1, 2, 3, 4, 5, 6, 7
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
    return [(f"{k}_Root", None), (f"{k}_Hips", f"{k}_Root"), (f"{k}_Spine", f"{k}_Hips"), (f"{k}_Chest", f"{k}_Spine"),
            (f"{k}_Neck", f"{k}_Chest"), (f"{k}_Head", f"{k}_Neck")] + [
        b for s, _ in SIDES for b in ((f"{k}_UpperArm{s}", f"{k}_Chest"), (f"{k}_LowerArm{s}", f"{k}_UpperArm{s}"), (f"{k}_Hand{s}", f"{k}_LowerArm{s}"),
                                       (f"{k}_UpperLeg{s}", f"{k}_Hips"), (f"{k}_LowerLeg{s}", f"{k}_UpperLeg{s}"), (f"{k}_Foot{s}", f"{k}_LowerLeg{s}"))]


KINDS = {
    "man": dict(H=1.79, sh=0.205, hip=0.096, girth=1.0, chest=(0.165, 0.11), waist=(0.15, 0.10), head=1.0, sleeve="long", clips="adult", lead=True, umb=True,
                walk=1.38, T=1.06, jog=2.8, hair="short", collar=True),
    "woman": dict(H=1.67, sh=0.185, hip=0.1, girth=0.94, chest=(0.15, 0.105), waist=(0.13, 0.092), head=0.97, sleeve="long", clips="adult", lead=True, umb=True,
                  walk=1.32, T=1.0, jog=2.6, hair="long"),
    "elder": dict(H=1.66, sh=0.19, hip=0.098, girth=1.04, chest=(0.165, 0.12), waist=(0.16, 0.115), head=0.98, sleeve="long", clips="elder", walk=0.95, T=1.16,
                  hair="ring", cane=True),
    "teen": dict(H=1.71, sh=0.185, hip=0.09, girth=0.9, chest=(0.15, 0.1), waist=(0.13, 0.088), head=0.96, sleeve="hoodie", clips="adult", umb=True, walk=1.42,
                 T=0.98, jog=3.0, hair="fringe"),
    "child": dict(H=1.18, sh=0.15, hip=0.072, girth=0.86, chest=(0.12, 0.085), waist=(0.115, 0.085), head=1.0, sleeve="short", clips="child", walk=1.25, T=0.78,
                  jog=2.4, hair="short", child=True),
    "cyclist": dict(H=1.76, sh=0.2, hip=0.096, girth=0.98, chest=(0.16, 0.11), waist=(0.145, 0.1), head=1.0, sleeve="long", clips="bike", hair="short", bike=True),
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
            tail.update({f"UpperArm{s}": J[f"LowerArm{s}"], f"LowerArm{s}": J[f"Hand{s}"], f"Hand{s}": J[f"HandTip{s}"],
                         f"UpperLeg{s}": J[f"LowerLeg{s}"], f"LowerLeg{s}": J[f"Foot{s}"], f"Foot{s}": J[f"Toe{s}"]})
            thick.update({f"UpperArm{s}": 0.05 * g, f"LowerArm{s}": 0.04 * g, f"Hand{s}": 0.04 * g, f"UpperLeg{s}": 0.075 * g, f"LowerLeg{s}": 0.055 * g,
                          f"Foot{s}": 0.045 * g})
        self.bones = []
        for name, par in human_bones(k):
            short = name[len(k) + 1:]
            self.bones.append((name, par, J[short], tail[short], thick[short]))
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
    for s, sg in SIDES:
        F.add(torus(Vector((sg * 0.03 * hs, front - 0.004, hc.z + 0.016 * hs)), 0.015 * hs, 0.0028, 8, 3, euler(pitch=90).to_matrix()), DARK, (n("Head"),), 1, SPECS)
    F.add(box(Vector((0, front - 0.004, hc.z + 0.018 * hs)), (0.012 * hs, 0.002, 0.002)), DARK, (n("Head"),), 1, SPECS)
    # A scarf round the neck.
    F.add(torus(Vector((0, 0.005, z["neck"] + 0.005)), 0.058 * g, 0.022 * g, 10, 5), ACC2, (n("Chest"), n("Neck")), 1, SCARF)
    F.add(box(Vector((0.03 * g, -0.07 * g, z["neck"] - 0.08 * s9)), (0.025 * g, 0.01, 0.07 * s9), euler(pitch=8).to_matrix()), ACC2, (n("Chest"),), 0.92, SCARF)
    # A cap: a flat cap (the man, the elder), a peaked cap (the teen, the child) or a helmet (the cyclist).
    if P.get("bike"):
        helm = lambda d: 1.0 if d.z > -0.05 else 0.6
        F.add(ellipsoid(hc + Vector((0, 0.008, 0.028 * hs)), (hr[0] * 1.2, hr[1] * 1.22, hr[2] * 0.98), 12, 7, shape=helm), ACC2, (n("Head"),), 1, HAT)
        for x in (-0.03, 0.0, 0.03):
            F.add(box(hc + Vector((x * hs, 0.01, hr[2] * 0.98 + 0.03 * hs)), (0.007, 0.06 * hs, 0.004)), DARK, (n("Head"),), 1, HAT)
    elif k in ("teen", "child"):
        crown = lambda d: 1.04 if d.z > 0.1 else 0.85
        F.add(ellipsoid(hc + Vector((0, 0.006, 0.03 * hs)), (hr[0] * 1.08, hr[1] * 1.06, hr[2] * 0.95), 12, 7, shape=crown), ACC, (n("Head"),), 1, HAT)
        F.add(box(hc + Vector((0, -hr[1] - 0.04 * hs, 0.05 * hs)), (0.06 * hs, 0.05 * hs, 0.005), euler(pitch=-8).to_matrix(), bevel=0.03), ACC, (n("Head"),), 0.9, HAT)
    elif k != "woman":
        flat = lambda d: 1.0 if d.z > 0.25 else 0.8
        F.add(ellipsoid(hc + Vector((0, -0.004, 0.045 * hs)), (hr[0] * 1.14, hr[1] * 1.16, hr[2] * 0.72), 12, 6, euler(pitch=-6).to_matrix(), shape=flat), ACC,
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
    for allow, idx in groups.items():
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
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
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


def gait(B, v, T, beta, lift, lean=4.0, swing=18.0, elbow=14.0, bounce=0.0, umbrella=False, lead=False, stoop=0.0):
    """A walk or a jog at speed v (m/s), a loop of T seconds; `beta` the share of the loop a foot is planted."""
    k = B.k
    n = B.n
    D = v * T
    half = D * beta / 2
    J = B.j
    foot_x = {s: J[f"Foot{s}"].x for s, _ in SIDES}
    ankle_z = J["FootL"].z
    leg = (B.thigh + B.shin) * 0.985
    N = 120

    def feet(ph):
        out = {}
        for s, _ in SIDES:
            p = (ph + (0.0 if s == "L" else 0.5)) % 1.0
            if p < beta:
                f = half - D * p
                up = 0.0
                pitch = 0.0
                planted = True
            else:
                u = (p - beta) / (1 - beta)
                f = -half + 2 * half * smooth(u)
                up = lift * math.sin(math.pi * u) ** 1.2
                pitch = -18 * math.sin(math.pi * u) * (1 - u) + 12 * math.sin(math.pi * u) * u
                planted = False
            out[s] = (Vector((foot_x[s], -f, ankle_z + up)), pitch, planted)
        return out

    # How high the hips may be at each moment: as high as both legs reach.
    raw = []
    for i in range(N):
        ph = i / N
        fs = feet(ph)
        hz = 99.0
        for s, _ in SIDES:
            a = fs[s][0]
            hx = J[f"UpperLeg{s}"]
            dh = math.hypot(a.x - hx.x, a.y - hx.y)
            hz = min(hz, a.z + math.sqrt(max(0.0, leg * leg - dh * dh)) - (hx.z - J["Hips"].z))
        raw.append(hz)
    env = lower_envelope(raw)
    rest_z = J["Hips"].z
    drops = [min(0.0, e - rest_z) for e in env]
    if bounce:
        drops = [d + bounce * (0.5 - 0.5 * math.cos(2 * TAU * i / N)) for i, d in enumerate(drops)]
        drops = [min(d, e - rest_z) for d, e in zip(drops, env)]

    def pose(t):
        ph = (t / T) % 1.0
        i = ph * N
        i0 = int(i) % N
        fr = i - int(i)
        dz = drops[i0] * (1 - fr) + drops[(i0 + 1) % N] * fr
        fs = feet(ph)
        p = Pose()
        sway = 0.012 * math.sin(TAU * ph)
        p.off[n("Hips")] = Vector((sway, 0, dz))
        twist = 5 * math.sin(TAU * ph)
        p.rel[n("Hips")] = euler(yaw=twist, roll=2.0 * math.sin(TAU * ph))
        p.rel[n("Spine")] = euler(pitch=lean * 0.5 + stoop * 0.5, yaw=-twist * 0.8)
        p.rel[n("Chest")] = euler(pitch=lean * 0.5 + stoop * 0.4, yaw=-twist * 0.6)
        p.rel[n("Neck")] = euler(pitch=-lean * 0.5 - stoop * 0.6)
        p.rel[n("Head")] = euler(pitch=-lean * 0.3 - stoop * 0.3, yaw=-twist * 0.2)
        for s, sg in SIDES:
            a, pitch, _ = fs[s]
            p.ik[n(f"UpperLeg{s}")] = (a, FWD + Vector((sg * 0.05, 0, 0)), n(f"LowerLeg{s}"), n(f"Foot{s}"))
            p.abs[n(f"Foot{s}")] = rot((1, 0, 0), pitch)
            # Arms swing against the legs (the left arm forward with the right leg).
            sw = swing * math.cos(TAU * (ph + (0.0 if s == "L" else 0.5)))
            if umbrella and s == "R":
                p.rel[n("UpperArmR")] = euler(pitch=-38, roll=8, yaw=-10)
                p.rel[n("LowerArmR")] = euler(pitch=-95)
                p.rel[n("HandR")] = euler(pitch=40, roll=-10)
            elif lead and s == "R":
                p.rel[n("UpperArmR")] = euler(pitch=-22 + 3 * math.sin(TAU * ph), roll=8)
                p.rel[n("LowerArmR")] = euler(pitch=-30)
            else:
                p.rel[n(f"UpperArm{s}")] = euler(pitch=sw, roll=-sg * 6)
                p.rel[n(f"LowerArm{s}")] = euler(pitch=-elbow - max(0.0, -sw) * 0.6)
        return p

    return pose, D


def standing(B, t, T, extra=None, stoop=0.0):
    """Standing, breathing, the weight shifting from foot to foot."""
    n = B.n
    J = B.j
    p = Pose()
    ph = (t / T) % 1.0
    shift = 0.018 * math.sin(TAU * ph)
    p.off[n("Hips")] = Vector((shift, 0, -0.004 - 0.004 * math.cos(TAU * ph * 2)))
    p.rel[n("Hips")] = euler(roll=-2.5 * math.sin(TAU * ph))
    p.rel[n("Spine")] = euler(pitch=stoop * 0.5, roll=1.5 * math.sin(TAU * ph))
    p.rel[n("Chest")] = euler(pitch=stoop * 0.4 - 1.5 * math.sin(TAU * ph * 2))
    p.rel[n("Neck")] = euler(pitch=-stoop * 0.6)
    p.rel[n("Head")] = euler(pitch=-stoop * 0.3, yaw=6 * math.sin(TAU * ph + 1.0))
    for s, sg in SIDES:
        a = J[f"Foot{s}"].copy()
        a.x += sg * 0.02
        p.ik[n(f"UpperLeg{s}")] = (a, FWD + Vector((sg * 0.08, 0, 0)), n(f"LowerLeg{s}"), n(f"Foot{s}"))
        p.abs[n(f"Foot{s}")] = rot((0, 0, 1), sg * 8)
        p.rel[n(f"UpperArm{s}")] = euler(pitch=-3, roll=-sg * 7)
        p.rel[n(f"LowerArm{s}")] = euler(pitch=-12)
    if extra:
        extra(p, ph)
    return p


def even(T):
    """A loop's length in seconds rounded to an even number of frames (the keys come every other frame)."""
    return 2 * max(1, round(T * FPS / 2)) / FPS


def clips_for(B):
    """name -> (frames, pose(t), loop distance or 0)."""
    P = B.P
    n = B.n
    out = {}
    stoop = 14.0 if B.k == "elder" else 0.0
    if P.get("bike"):
        out["Ride"] = (FPS, ride(B), 2 * TAU * WHEEL_R)
        return out
    T = even(P["T"])
    walk, D = gait(B, P["walk"], T, 0.6, 0.075 * B.H / 1.79, lean=3 + stoop * 0.3, swing=14 if B.k == "elder" else 18, stoop=stoop)
    out["Walk"] = (round(T * FPS), walk, D)
    if P.get("jog"):
        Tj = even(T * 0.68)
        jog, Dj = gait(B, P["jog"], Tj, 0.4, 0.13 * B.H / 1.79, lean=8, swing=30, elbow=75, bounce=0.035)
        out["Jog"] = (round(Tj * FPS), jog, Dj)
    if P.get("umb"):
        wu, Du = gait(B, P["walk"], T, 0.6, 0.07 * B.H / 1.79, lean=3, swing=16, umbrella=True)
        out["WalkUmb"] = (round(T * FPS), wu, Du)
    if P.get("lead"):
        wl, Dl = gait(B, P["walk"], T, 0.6, 0.075 * B.H / 1.79, lean=3, swing=16, lead=True)
        out["WalkLead"] = (round(T * FPS), wl, Dl)
    out["Idle"] = (4 * FPS, lambda t: standing(B, t, 4.0, stoop=stoop), 0)

    def talk(p, ph):
        # One hand up now and then as the villager talks, the head nodding a little.
        g = max(0.0, math.sin(TAU * ph)) ** 1.5
        p.rel[n("UpperArmR")] = euler(pitch=-12 - 18 * g, roll=6 + 8 * g)
        p.rel[n("LowerArmR")] = euler(pitch=-30 - 60 * g, yaw=10 * g)
        p.rel[n("HandR")] = euler(roll=20 * g * math.sin(TAU * ph * 3))
        g2 = max(0.0, math.sin(TAU * ph + math.pi)) ** 2
        p.rel[n("UpperArmL")] = euler(pitch=-5 - 10 * g2, roll=-7)
        p.rel[n("LowerArmL")] = euler(pitch=-15 - 50 * g2)
        p.rel[n("Head")] = euler(pitch=-stoop * 0.3 + 2.5 * math.sin(TAU * ph * 4), yaw=8 * math.sin(TAU * ph))

    if B.k != "child":
        out["Talk"] = (4 * FPS, lambda t: standing(B, t, 4.0, talk, stoop=stoop), 0)

    def wave(p, ph):
        # The right hand (the elder's left: the stick is in the right).
        s, sg = ("L", 1) if B.k == "elder" else ("R", -1)
        p.rel[n(f"UpperArm{s}")] = euler(pitch=-20, roll=-sg * (150 if B.k != "elder" else 125))
        p.rel[n(f"LowerArm{s}")] = euler(pitch=-10, roll=25 * math.sin(TAU * ph * 2))
        p.rel[n(f"Hand{s}")] = euler(roll=15 * math.sin(TAU * ph * 2 + 0.6))
        p.rel[n("Head")] = euler(pitch=-4 - stoop * 0.3, yaw=0)

    out["Wave"] = (round(1.2 * FPS), lambda t: standing(B, t, 1.2, wave, stoop=stoop), 0)
    out["Sit"] = (4 * FPS, sitting(B), 0)
    return out


SEAT_H = 0.45


def sitting(B):
    """Sitting on a bench 45 cm high: the hip joints over the seat at the origin, the feet on the ground ahead."""
    n = B.n
    J = B.j

    def pose(t):
        ph = (t / 4.0) % 1.0
        p = Pose()
        hj = J["UpperLegL"]
        # Thighs along the seat: the hip joints at the seat's height, the knees forward.
        target_z = SEAT_H + 0.07 * B.H / 1.79
        p.off[n("Hips")] = Vector((0, 0.06, target_z - hj.z))
        p.rel[n("Hips")] = euler(pitch=-8)
        p.rel[n("Spine")] = euler(pitch=4 + 1.5 * math.sin(TAU * ph))
        p.rel[n("Chest")] = euler(pitch=4)
        p.rel[n("Head")] = euler(pitch=2, yaw=10 * math.sin(TAU * ph))
        for s, sg in SIDES:
            knee_ahead = B.thigh * 0.98
            a = Vector((J[f"Foot{s}"].x + sg * 0.03, 0.06 - knee_ahead - 0.04, J["FootL"].z))
            p.ik[n(f"UpperLeg{s}")] = (a, FWD + Vector((0, 0, 1.2)), n(f"LowerLeg{s}"), n(f"Foot{s}"))
            p.abs[n(f"Foot{s}")] = Quaternion()
            p.rel[n(f"UpperArm{s}")] = euler(pitch=-28, roll=-sg * 10)
            p.rel[n(f"LowerArm{s}")] = euler(pitch=-48)
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
    pose, _ = gait(B, B.P["walk"], even(B.P["T"]), 0.6, 0.07, umbrella=True)
    _, G = solve(B, pose(0.25 * even(B.P["T"])))
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
    groups_shown = {"man": (HAT, BAG), "woman": (HAIR_A, BAG, SCARF), "elder": (HAT, SPECS), "teen": (BAG,), "child": (HAT,), "cyclist": (HAT, BAG), "dog": (HAIR_A,)}
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
