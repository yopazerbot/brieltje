"""Build the Zombies wave mode's figures in Blender: four regular zombies and a big one, rigged and animated.

Run (Blender 5, no window):
  blender -b -P tools/zombies.py -- <out.glb> [preview_dir]

Our own cartoon designs for a family game: comic and a bit sorry for themselves, never scary up close.
No gore, no wounds, no blood, no logos. Skin in muted greens and greys, big mismatched eyes under droopy
lids, a goofy open mouth with one tooth, worried brows, chunky shapes that still read at 20 m.
  shirt    1.77 m, thin: a torn cream shirt (ragged hem, the left sleeve torn short, the right one torn
           at the forearm), brown trousers with a patch on one knee, old shoes, messy hair. Sage skin.
  hoodie   1.83 m, a lanky hunched teen: a faded red hoodie with the hood down, a pocket and drawstrings,
           dark jeans, trainers, a fringe. Grey-green skin.
  overall  1.62 m, a stocky mechanic: a blue one-piece work overall with rolled sleeves, a pocket and a
           blank name patch, work boots; bald on top with grey tufts and a moustache. Olive-grey skin.
  farmer   1.66 m, a round belly: green dungarees over a checked shirt, black wellies, a flat cap.
           Blue-grey skin.
  big      2.6 m, for every 5th wave: broad shoulders, long heavy arms with fists, a small head with an
           underbite, a torn sleeveless vest, a rope belt, heavy boots. Deep grey-green skin.

How it is built: each figure is simple closed pieces (tubes along the straight limbs, a torso of stacked
superellipses, a head with stuck-on eyes, nose, ears, mouth and hair, clothes a little proud of the body)
joined into one mesh, one colour per face (a vertex colour, no textures, one shared material). It is
skinned to its own armature with weights computed here rather than by Blender's heat weighting, which
fails on separate pieces: a point is pulled by each bone it may follow (its piece decides which: an arm
never follows a leg) by (distance to the bone's segment / the bone's thickness) ** -5, the four strongest
kept. That is a smooth function of position only, so pieces that overlap (a sleeve over an arm, a hem
over trousers) bend as one skin, and the blend at a joint is about one limb thickness wide. The shoes'
soles follow only the foot, so a planted sole stays flat. LOD1 is the same figure built again from fewer
segments without the small details, weighted the same way.

The clips are made here too, frame by frame: the legs by two-bone IK to planted feet (a planted foot moves
back at exactly the walking speed, so a loop's distance is known: the script measures it again with
Blender's own evaluation), the hips lowered just enough that no planted leg is stretched (smoothed), the
rest from a few angles per bone; arms aim at an elevation in the world and turn with the chest. Clips
that touch the ground (Fall, Pound) are checked against the skinned mesh itself, computed here as Blender
would. It prints each clip's length, the distance a loop covers and the moment of impact.

Output: one GLB (Y up, metres). Per variant v a node zombie_<v> holding its armature (zombie_<v>_armature)
and two skinned meshes, zombie_<v> (LOD0) and zombie_<v>_lod1, both on that armature. Every armature has
the same 20 bones: Root (at the feet) > Hips > Spine > Chest > Neck > Head; Chest > Shoulder.L >
UpperArm.L > LowerArm.L > Hand.L (and .R); Hips > UpperLeg.L > LowerLeg.L > Foot.L (and .R). L/R are the
figure's own sides (its left is +x); it stands with its feet at the origin and faces +z in the GLB
(Blender -Y). Animations are named <v>_<Clip> and hold only that variant's bones, sampled at 15 keys a
second, in place (Root never moves; the hips bob and sway): Walk, Lurch, Idle, Attack, Flinch and Fall
for the regular four, Stomp, Pound, Idle, Flinch and Fall for the big one. Every clip turns every bone
and moves the hips. After Blender's export the file is repacked (identical accessors stored once, weights
and colours as normalised bytes, channels that never leave a bone's rest translation or scale dropped).
three.js's GLTFLoader makes repeated names unique: the LOD0 mesh loads as zombie_<v>_1, and the bones of
every variant after the first in the file get _1, _2... (and lose the dot: ShoulderL); its clips are
renamed to match, so <v>_<Clip> played on zombie_<v> works.
With preview_dir it renders each figure front, three-quarter and face, a lineup with a 1.8 m pole,
contact sheets of the walks, lurches, the stomp and the pound, Attack and Fall frames, the LOD1 lineup
and the lineup from 20 m there.
"""
import json
import math
import os
import random
import struct
import sys

import bpy
import numpy as np
from mathutils import Euler, Matrix, Quaternion, Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[0] if argv else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "public", "models", "zombies.glb")
PREVIEW = argv[1] if len(argv) > 1 else ""

FPS = 30
STEP = 2              # a key every other frame: 15 a second is plenty for a shamble and halves the clips
FALLOFF = 5           # how fast a bone's pull on the skin fades, in its own thicknesses
FWD = Vector((0.0, -1.0, 0.0))  # the figures face Blender -Y (glTF +Z)
UP = Vector((0.0, 0.0, 1.0))
SIDES = (("L", 1), ("R", -1))   # its left is +x

BONES = [("Root", None), ("Hips", "Root"), ("Spine", "Hips"), ("Chest", "Spine"), ("Neck", "Chest"), ("Head", "Neck"),
         ("Shoulder.L", "Chest"), ("UpperArm.L", "Shoulder.L"), ("LowerArm.L", "UpperArm.L"), ("Hand.L", "LowerArm.L"),
         ("Shoulder.R", "Chest"), ("UpperArm.R", "Shoulder.R"), ("LowerArm.R", "UpperArm.R"), ("Hand.R", "LowerArm.R"),
         ("UpperLeg.L", "Hips"), ("LowerLeg.L", "UpperLeg.L"), ("Foot.L", "LowerLeg.L"),
         ("UpperLeg.R", "Hips"), ("LowerLeg.R", "UpperLeg.R"), ("Foot.R", "LowerLeg.R")]
NAMES = [b for b, _ in BONES]
PARENT = dict(BONES)
INDEX = {b: i for i, b in enumerate(NAMES)}

# Which bones a piece may follow.
HEAD = ("Head",)
NECK = ("Chest", "Neck", "Head")
TORSO = ("Hips", "Spine", "Chest", "Neck", "Shoulder.L", "Shoulder.R", "UpperArm.L", "UpperArm.R", "UpperLeg.L", "UpperLeg.R")
UPPER = ("Spine", "Chest", "Neck", "Shoulder.L", "Shoulder.R", "UpperArm.L", "UpperArm.R")


def ARM(s):
    return ("Chest", f"Shoulder.{s}", f"UpperArm.{s}", f"LowerArm.{s}", f"Hand.{s}")


def HAND(s):
    return (f"LowerArm.{s}", f"Hand.{s}")


def LEG(s):
    return ("Hips", f"UpperLeg.{s}", f"LowerLeg.{s}", f"Foot.{s}")


def FOOT(s):
    return (f"LowerLeg.{s}", f"Foot.{s}")


# ======== Small helpers.
def rgb(h):
    """A colour from an sRGB hex string, as three 0..1 values (still sRGB)."""
    return tuple(int(h[i:i + 2], 16) / 255 for i in (1, 3, 5))


def tone(c, k):
    """The colour c darker (k < 1) or lighter (k > 1)."""
    return tuple(min(1.0, v * k) for v in c)


def rot(pitch=0.0, roll=0.0, yaw=0.0):
    """A turn in the figure's own axes, in degrees: pitch about x (a spine bends forward with +, a hanging
    limb swings back), roll about y (the top of a spine tips to its left with +), yaw about z (it turns to
    its left with +). Roll first, then pitch, then yaw."""
    return Euler((math.radians(pitch), math.radians(roll), math.radians(yaw)), "YXZ").to_quaternion()


def smooth(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def spline(keys, t):
    """A value at time t from keyframes [(time, value), ...] (numbers or Vectors), a Catmull-Rom curve
    through them, flat at the first and last key and at any key given a third item ("hold")."""
    if t <= keys[0][0]:
        return keys[0][1]
    if t >= keys[-1][0]:
        return keys[-1][1]
    i = max(k for k in range(len(keys) - 1) if keys[k][0] <= t)
    (t0, v0), (t1, v1) = keys[i][:2], keys[i + 1][:2]

    def slope(k):
        if k == 0 or k == len(keys) - 1 or len(keys[k]) > 2:
            return v0 * 0.0
        return (keys[k + 1][1] - keys[k - 1][1]) / (keys[k + 1][0] - keys[k - 1][0])

    m0, m1 = slope(i) * (t1 - t0), slope(i + 1) * (t1 - t0)
    u = (t - t0) / (t1 - t0)
    return (v0 * (2 * u ** 3 - 3 * u ** 2 + 1) + m0 * (u ** 3 - 2 * u ** 2 + u)
            + v1 * (-2 * u ** 3 + 3 * u ** 2) + m1 * (u ** 3 - u ** 2))


def bump(x, w):
    """A soft bump, 1 at x = 0, about w wide."""
    return math.exp(-(x / w) ** 2)


def wrap(x):
    """x round a loop, to -0.5..0.5."""
    return (x + 0.5) % 1.0 - 0.5


def even(x):
    return max(4, int(round(x / 2)) * 2)


# ======== Geometry: every piece is rings of points round an axis, closed at both ends.
def grid(fn, ss, seg, wrap_s=False):
    """Points fn(s, theta) on a ring for each s in ss (theta round it in seg steps), the rings joined by
    faces. A ring whose points all coincide becomes one point (a pole). Returns (points, faces, tags);
    a tag (ring, step) says where each face is, for colouring."""
    co, faces, tags, rings = [], [], [], []
    for s in ss:
        pts = [Vector(fn(s, 2.0 * math.pi * j / seg)) for j in range(seg)]
        if max((p - pts[0]).length for p in pts) < 1e-9:
            rings.append([len(co)] * seg)
            co.append(pts[0])
        else:
            rings.append(list(range(len(co), len(co) + seg)))
            co.extend(pts)
    pairs = list(zip(rings, rings[1:])) + ([(rings[-1], rings[0])] if wrap_s else [])
    for i, (a, b) in enumerate(pairs):
        for j in range(seg):
            k = (j + 1) % seg
            f = []
            for v in (a[j], a[k], b[k], b[j]):
                if v not in f:
                    f.append(v)
            if len(f) >= 3:
                faces.append(tuple(f))
                tags.append((i, j))
    return co, faces, tags


def orient(piece, out=None):
    """Turn a piece's faces outwards: for a closed piece by its signed volume, else towards out."""
    co, faces, tags = piece
    s = 0.0
    for f in faces:
        if out is None:
            for i in range(1, len(f) - 1):
                s += co[f[0]].dot(co[f[i]].cross(co[f[i + 1]]))
        else:
            s += (co[f[1]] - co[f[0]]).cross(co[f[2]] - co[f[0]]).dot(out)
    if s < 0:
        faces = [tuple(reversed(f)) for f in faces]
    return co, faces, tags


def frame_of(w, side=None):
    """Two axes square to w (the first towards side if given)."""
    w = Vector(w).normalized()
    u = Vector(side) if side is not None else (Vector((1, 0, 0)) if abs(w.x) < 0.9 else Vector((0, 0, 1)))
    u = (u - w * u.dot(w)).normalized()
    return u, w.cross(u)


def start_cap(t, r, n=2):
    """Profile points rounding off the start of a tube: a quarter circle from a pole at t - r to (t, r),
    which the caller gives."""
    return [(t - r * math.cos(a), r * math.sin(a)) for a in np.linspace(0, math.pi / 2, n + 1)[:-1]]


def end_cap(t, r, n=2):
    return [(t + r * math.cos(a), r * math.sin(a)) for a in np.linspace(math.pi / 2, 0, n + 1)[1:]]


class Limb:
    """A round piece along a straight axis p0 -> p1: radius r(t) at distance t along it."""

    def __init__(self, p0, p1, prof, side=None, ell=(1.0, 1.0)):
        self.p0, self.p1 = Vector(p0), Vector(p1)
        self.w = (self.p1 - self.p0).normalized()
        self.u, self.v = frame_of(self.w, side)
        self.ts, self.rs = [t for t, _ in prof], [r for _, r in prof]
        self.ell = ell

    def r(self, t):
        return float(np.interp(t, self.ts, self.rs))

    def point(self, t, th, off=0.0, r=None):
        r = (self.r(t) if r is None else r) + off
        return self.p0 + self.w * t + (self.u * (math.cos(th) * self.ell[0]) + self.v * (math.sin(th) * self.ell[1])) * r

    def mesh(self, prof, seg, zig=None):
        """Rings at the profile's (t, r) (r is added to nothing: these are absolute radii); zig(t, theta)
        moves a ring's points along the axis (a ragged edge)."""
        def fn(i, th):
            t, r = prof[i]
            if zig is not None and r > 0:
                t += zig(i, th)
            return self.point(t, th, 0.0, r)
        return orient(grid(fn, range(len(prof)), seg))


def tube(p0, p1, prof, seg, side=None, ell=(1.0, 1.0)):
    return Limb(p0, p1, prof, side, ell).mesh(prof, seg)


def blob(c, radii, rot_=None, seg=12, rings=8, e=1.0):
    """An ellipsoid round c with semi-axes radii (x, y, z), turned by rot_ (3x3); e < 1 squares it off."""
    c = Vector(c)
    R = rot_ if rot_ is not None else Matrix.Identity(3)

    def sp(x):
        return math.copysign(abs(x) ** e, x)

    def fn(i, th):
        ph = math.pi * i / rings
        s = sp(math.sin(ph))
        return c + R @ Vector((s * sp(math.cos(th)) * radii[0], s * sp(math.sin(th)) * radii[1], -sp(math.cos(ph)) * radii[2]))
    return orient(grid(fn, range(rings + 1), seg))


def sweep(path, radii, seg, ups=None, ell=(1.0, 1.0)):
    """A tube along the points path, radius radii[i] at each (0 closes it there)."""
    n = len(path)
    fr = []
    for i in range(n):
        t = (path[min(i + 1, n - 1)] - path[max(i - 1, 0)]).normalized()
        up = ups[i] if ups is not None else UP
        u = (up - t * up.dot(t)).normalized()
        fr.append((u, t.cross(u)))

    def fn(i, th):
        u, v = fr[i]
        return path[i] + (u * (math.cos(th) * ell[0]) + v * (math.sin(th) * ell[1])) * radii[i]
    return orient(grid(fn, range(n), seg))


def slab(surf, s0, s1, a0, a1, off, thick, ns, na, bevel=0.45):
    """A patch lying on a surface (surf(s, a, off): a point standing off it by off), over s0..s1 by
    a0..a1, from off - thick/2 to off + thick/2, its top edges rounded down: pockets, patches, a bib."""
    seg = 2 * na

    def fn(i, th):
        if i == 0 or i == ns + 2:
            return surf(s0 if i == 0 else s1, (a0 + a1) / 2, off - thick * 0.25)
        s = s0 + (s1 - s0) * (i - 1) / ns
        j = int(round(th * seg / (2 * math.pi))) % seg
        if j < na:
            a = a0 + (a1 - a0) * j / (na - 1)
            edge = min(j, na - 1 - j, i - 1, ns + 1 - i)
            return surf(s, a, off + thick / 2 * (bevel if edge == 0 else 1.0))
        a = a1 - (a1 - a0) * (j - na) / (na - 1)
        return surf(s, a, off - thick / 2)
    return orient(grid(fn, range(ns + 3), seg))


def torus(centres, normals, radials, r, seg):
    """A closed ring of tube round the loop of points centres (a lip), its cross-section in the plane of
    the radial (outwards along the face) and normal (out of the face) at each, radius r(i, beta)."""
    def fn(i, th):
        rr = r(i, th) if callable(r) else r
        return centres[i] + (radials[i] * math.cos(th) + normals[i] * math.sin(th)) * rr
    return orient(grid(fn, range(len(centres)), seg, wrap_s=True))


def prism(outline, z0, z1):
    """A flat-topped slab from z0 to z1 over a closed outline [(x, y), ...] (a sole)."""
    n = len(outline)
    co = [Vector((x, y, z0)) for x, y in outline] + [Vector((x, y, z1)) for x, y in outline]
    faces = [tuple(range(n)), tuple(range(n, 2 * n))] + [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    tags = [(0, 0), (1, 0)] + [(2, i) for i in range(n)]
    return orient((co, faces, tags))


class Torso:
    """The torso as stacked superellipses: rows of (z, half width, depth in front, depth behind, centre
    y, squareness), interpolated between."""

    def __init__(self, rows):
        self.rows = np.array(rows, float)

    def section(self, z):
        return [float(np.interp(z, self.rows[:, 0], self.rows[:, k])) for k in range(1, 6)]

    def point(self, z, th, off=0.0):
        a, bf, bb, cy, n = self.section(z)
        c, s = math.cos(th), math.sin(th)
        e = 2.0 / n
        b = (bb if s > 0 else bf) + off
        return Vector((math.copysign(abs(c) ** e, c) * (a + off), cy + math.copysign(abs(s) ** e, s) * b, z))

    def mesh(self, rings, seg, zig=None):
        """rings: [(z, off)] from the bottom up; off None makes a pole on the axis there. zig(i, theta)
        moves ring i's points up or down (a ragged hem, a scooped neckline)."""
        def fn(i, th):
            z, off = rings[i]
            if off is None:
                return Vector((0.0, self.section(z)[3], z))
            if zig is not None:
                z += zig(i, th)
            return self.point(z, th, off)
        return orient(grid(fn, range(len(rings)), seg))


class Head:
    """The head as a surface: a squashed ball, its cranium (top) wider or narrower than its jaw, the chin
    and a brow ridge pushed forward. at(h, v) is the point h radians round from the front (towards its
    left) and v up from the middle."""

    def __init__(self, c, r, top=1.0, jaw=1.0, chin=0.0, back=1.0, brow=0.0):
        self.c = Vector(c)
        self.rx, self.ry, self.rz = r
        self.top, self.jaw, self.chin, self.back, self.brow = top, jaw, chin, back, brow

    def raw(self, ph, th):
        sp, cp = math.sin(ph), -math.cos(ph)
        cx, cy = math.cos(th), math.sin(th)
        k = float(np.interp(cp, (-1.0, -0.35, 0.25, 1.0), (self.jaw, self.jaw, 1.0, self.top)))
        x = sp * cx * self.rx * k
        y = sp * cy * self.ry * (self.back if cy > 0 else 1.0) * (0.5 + 0.5 * k)
        if cy < 0:
            y -= self.chin * max(0.0, -cp) ** 1.5 * cy * cy * sp
            y -= self.brow * math.exp(-((cp - 0.36) / 0.13) ** 2) * cy ** 4
        return self.c + Vector((x, y, cp * self.rz))

    def normal(self, ph, th):
        if math.sin(ph) < 1e-4:
            return Vector((0.0, 0.0, 1.0 if ph > 1 else -1.0))
        e = 1e-3
        t1 = self.raw(ph, th + e) - self.raw(ph, th - e)
        t2 = self.raw(ph + e, th) - self.raw(ph - e, th)
        n = t1.cross(t2).normalized()
        return n if n.dot(self.raw(ph, th) - self.c) > 0 else -n

    def at(self, h, v, off=0.0):
        ph, th = math.pi / 2 + v, h - math.pi / 2
        return self.raw(ph, th) + self.normal(ph, th) * off

    def n_at(self, h, v):
        return self.normal(math.pi / 2 + v, h - math.pi / 2)

    def surf(self, v, h, off):
        """For slab(): s is up, a is round."""
        return self.at(h, v, off)

    def mesh(self, seg, rings):
        return orient(grid(lambda i, th: self.raw(math.pi * i / rings, th), range(rings + 1), seg))


def face_frame(n):
    """A turn whose y points into the surface (along -n) and whose z stays as near up as it can: for
    features stuck on a face (x across, y into it, z up)."""
    y = -Vector(n).normalized()
    x = y.cross(UP)
    if x.length < 1e-6:
        x = Vector((1, 0, 0))
    x.normalize()
    return Matrix((x, y, x.cross(y))).transposed()


class Figure:
    """The pieces of one figure: points, faces, a colour per face and, per point, the bones it may follow."""

    def __init__(self):
        self.co, self.faces, self.col, self.allow = [], [], [], []

    def add(self, piece, col, allow):
        co, faces, tags = piece
        base = len(self.co)
        self.co += [Vector(c) for c in co]
        self.faces += [tuple(base + i for i in f) for f in faces]
        self.col += [col(t) if callable(col) else col for t in tags]
        self.allow += [allow] * len(co)

    def tris(self):
        return sum(len(f) - 2 for f in self.faces)


# ======== The five figures: proportions, faces, clothes' colours and how they move.
# Torso rows: (z, half width, depth in front, depth behind, centre y, squareness). Lengths in metres.
VARIANTS = {
    "shirt": dict(
        col=dict(skin="#a3b58c", hair="#3b3128", cloth="#d6cfb6", trousers="#6b5642", patch="#7a8ba0", shoe="#43392f",
                 sole="#2b2522", button="#9d9580"),
        hip_z=0.84, hip_x=0.088, knee_t=0.485, ankle_z=0.085,
        torso=[(0.735, 0, 0, 0, 0.0, 2.2), (0.75, 0.07, 0.06, 0.065, 0.0, 2.2), (0.775, 0.115, 0.085, 0.092, 0.005, 2.2),
               (0.82, 0.136, 0.094, 0.104, 0.008, 2.3), (0.9, 0.136, 0.09, 0.098, 0.006, 2.3), (1.0, 0.123, 0.085, 0.085, 0.0, 2.2),
               (1.12, 0.137, 0.094, 0.084, -0.004, 2.3), (1.24, 0.152, 0.103, 0.09, -0.004, 2.4), (1.33, 0.162, 0.095, 0.09, 0.0, 2.6),
               (1.385, 0.162, 0.082, 0.084, 0.006, 2.6), (1.42, 0.118, 0.062, 0.066, 0.008, 2.2), (1.445, 0.06, 0.042, 0.046, 0.01, 2.0),
               (1.457, 0, 0, 0, 0.01, 2.0)],
        waist_z=1.0, chest_z=1.22, neck_z=1.43, sh=(0.185, 0.0, 1.38), neck_r=0.041,
        head=dict(c=(0.0, -0.014, 1.6), r=(0.104, 0.112, 0.128), top=1.05, jaw=0.84, chin=0.014, brow=0.006),
        arm=(0.28, 0.255, 0.15), arm_r=(0.046, 0.037, 0.04, 0.03), arm_fwd=26, arm_out=13, hand=1.0,
        leg_r=(0.078, 0.059, 0.061, 0.043), foot=dict(kind="shoe", len=0.27, w=0.118, out=7, sole=0.025), hem=(0.098, True),
        face=dict(eye_h=0.4, eye_v=0.13, eyes=((0.036, 0.22, (-8, 6), 12), (0.031, 0.5, (12, -6), 4)),
                  brow=(0.0078, 0.03, -0.02, (16, -6)), nose=(-0.13, (0.021, 0.026, 0.022), 12),
                  mouth=(0.06, -0.48, 0.3, 0.17, -7, 0.005), tooth=(-0.35, 1.0), ears=(0.03, (0.024, 0.034, 0.01), (1.0, 0.9))),
        hair="messy",
        style=dict(hips=(4, -3, 0), spine=(4, -2, 0), chest=(5, -3, 3), neck=(6, 0, 0), head=(-4, 12, 6),
                   arms=dict(L=(4, 9, 12, 34), R=(-3, 13, 16, 40)),  # elevation (world), outward, elbow, droop
                   walk=dict(T=1.6, D=0.72, duty=(0.64, 0.6), lift=(0.05, 0.016), toe=(14, 26), sway=0.032, roll=4.5,
                             yaw=5, width=(0.012, 0.03), k=0.985),
                   lurch=dict(T=1.0, D=1.0, duty=(0.55, 0.53), lift=(0.1, 0.05), toe=(18, 24), sway=0.055, roll=8,
                              yaw=9, width=(0.02, 0.035), k=0.955)),
    ),
    "hoodie": dict(
        col=dict(skin="#93a491", hair="#2c2824", cloth="#a5524a", band="#8a433d", jeans="#4b5262", shoe="#d6d3c9",
                 sole="#8a8a85", tab="#a5524a", string="#d2cfc6"),
        hip_z=0.93, hip_x=0.085, knee_t=0.49, ankle_z=0.082,
        torso=[(0.82, 0, 0, 0, 0.0, 2.2), (0.835, 0.065, 0.055, 0.06, 0.0, 2.2), (0.86, 0.108, 0.08, 0.088, 0.004, 2.2),
               (0.91, 0.128, 0.087, 0.097, 0.006, 2.3), (0.98, 0.127, 0.084, 0.09, 0.004, 2.3), (1.08, 0.12, 0.08, 0.08, 0.0, 2.2),
               (1.2, 0.133, 0.088, 0.08, -0.004, 2.3), (1.32, 0.146, 0.093, 0.084, -0.004, 2.4), (1.41, 0.152, 0.086, 0.084, 0.0, 2.6),
               (1.45, 0.15, 0.075, 0.079, 0.004, 2.6), (1.483, 0.108, 0.057, 0.061, 0.006, 2.2), (1.505, 0.054, 0.04, 0.044, 0.008, 2.0),
               (1.516, 0, 0, 0, 0.008, 2.0)],
        waist_z=1.08, chest_z=1.3, neck_z=1.49, sh=(0.172, 0.0, 1.44), neck_r=0.038,
        head=dict(c=(0.0, -0.018, 1.67), r=(0.098, 0.11, 0.126), top=1.08, jaw=0.8, chin=0.02, brow=0.004),
        arm=(0.31, 0.28, 0.155), arm_r=(0.043, 0.034, 0.037, 0.028), arm_fwd=22, arm_out=12, hand=1.02,
        leg_r=(0.068, 0.05, 0.053, 0.04), foot=dict(kind="trainer", len=0.29, w=0.124, out=6, sole=0.035), hem=(0.112, True),
        face=dict(eye_h=0.41, eye_v=0.12, eyes=((0.033, 0.02, (6, -2), 6), (0.037, 0.14, (-10, 8), 14)),
                  brow=(0.007, 0.0, 0.0, (-6, 14)), nose=(-0.14, (0.016, 0.022, 0.02), 6),
                  mouth=(-0.04, -0.52, 0.25, 0.2, 5, 0.0048), tooth=(0.3, 0.9), ears=(0.04, (0.03, 0.04, 0.011), (1.1, 1.0)),
                  tongue=True),
        hair="fringe",
        style=dict(hips=(6, 0, 0), spine=(9, 0, 0), chest=(12, 2, 0), neck=(14, 0, 0), head=(-14, -8, -4),
                   shoulders=(8, -2),  # forward, up: rounded teenage shoulders
                   arms=dict(L=(-22, 8, 16, 42), R=(-16, 11, 14, 36)),
                   walk=dict(T=1.7, D=0.86, duty=(0.62, 0.62), lift=(0.04, 0.04), toe=(16, 16), sway=0.028, roll=3.5,
                             yaw=6, width=(0.006, 0.006), k=0.98),
                   lurch=dict(T=1.05, D=1.15, duty=(0.54, 0.54), lift=(0.1, 0.09), toe=(20, 20), sway=0.05, roll=7,
                              yaw=10, width=(0.012, 0.012), k=0.95)),
    ),
    "overall": dict(
        col=dict(skin="#a3a383", hair="#8c8a84", cloth="#56708f", roll="#6c86a6", pocket="#475e7a", zip="#3a3f47",
                 tag="#e0ddd2", boot="#5a4431", sole="#2a2420", band="#4b6380"),
        hip_z=0.72, hip_x=0.1, knee_t=0.47, ankle_z=0.09,
        torso=[(0.615, 0, 0, 0, 0.0, 2.4), (0.63, 0.08, 0.07, 0.075, 0.0, 2.4), (0.66, 0.135, 0.108, 0.114, 0.004, 2.5),
               (0.72, 0.164, 0.124, 0.128, 0.006, 2.6), (0.82, 0.168, 0.13, 0.124, 0.004, 2.6), (0.92, 0.17, 0.142, 0.12, 0.0, 2.6),
               (1.02, 0.175, 0.138, 0.118, 0.0, 2.6), (1.12, 0.184, 0.128, 0.118, 0.0, 2.7), (1.2, 0.19, 0.116, 0.114, 0.002, 2.8),
               (1.25, 0.19, 0.1, 0.104, 0.004, 2.8), (1.285, 0.14, 0.076, 0.08, 0.006, 2.4), (1.31, 0.072, 0.056, 0.06, 0.008, 2.0),
               (1.321, 0, 0, 0, 0.008, 2.0)],
        waist_z=0.92, chest_z=1.1, neck_z=1.3, sh=(0.214, 0.0, 1.24), neck_r=0.062,
        head=dict(c=(0.0, -0.012, 1.455), r=(0.114, 0.118, 0.122), top=1.0, jaw=1.05, chin=0.008, brow=0.008),
        arm=(0.25, 0.23, 0.15), arm_r=(0.062, 0.05, 0.054, 0.04), arm_fwd=30, arm_out=16, hand=1.06,
        leg_r=(0.094, 0.077, 0.08, 0.055), foot=dict(kind="boot", len=0.28, w=0.132, out=9, sole=0.032, shaft=0.15), hem=(0.125, True),
        face=dict(eye_h=0.4, eye_v=0.11, eyes=((0.034, 0.36, (4, 14), 8), (0.034, 0.08, (-6, -4), 10)),
                  brow=(0.011, 0.12, -0.03, (20, 18)), nose=(-0.11, (0.026, 0.026, 0.026), 0),
                  mouth=(0.0, -0.53, 0.33, 0.17, 3, 0.0052), tooth=(-0.45, 1.05), ears=(0.02, (0.03, 0.038, 0.012), (1.0, 1.08)),
                  moustache=True, underbite=True),
        hair="bald",
        style=dict(hips=(0, 2, 0), spine=(-2, 1, 0), chest=(-2, 2, 0), neck=(-2, 0, 0), head=(-6, 6, -4),
                   shoulders=(0, 4),
                   arms=dict(L=(2, 6, 6, 26), R=(8, 6, 4, 22)),
                   walk=dict(T=1.4, D=0.56, duty=(0.62, 0.62), lift=(0.045, 0.045), toe=(10, 10), sway=0.045, roll=7,
                             yaw=4, width=(0.02, 0.02), k=0.99),
                   lurch=dict(T=0.9, D=0.8, duty=(0.54, 0.54), lift=(0.09, 0.09), toe=(14, 14), sway=0.065, roll=10,
                              yaw=7, width=(0.03, 0.03), k=0.96)),
    ),
    "farmer": dict(
        col=dict(skin="#97a8a7", hair="#9a9890", check1="#a65e50", check2="#7a4740", check3="#4c3532", cloth="#677149",
                 pocket="#566039", button="#c9c4b4", boot="#2c302d", rim="#3b403c", cap="#6e604d", capband="#5c5040"),
        hip_z=0.77, hip_x=0.098, knee_t=0.47, ankle_z=0.085,
        torso=[(0.665, 0, 0, 0, 0.0, 2.3), (0.68, 0.08, 0.07, 0.07, 0.0, 2.3), (0.71, 0.13, 0.108, 0.108, 0.004, 2.4),
               (0.77, 0.157, 0.128, 0.124, 0.006, 2.4), (0.86, 0.165, 0.158, 0.118, 0.004, 2.4), (0.96, 0.172, 0.188, 0.118, 0.0, 2.4),
               (1.06, 0.172, 0.198, 0.116, 0.0, 2.4), (1.15, 0.168, 0.178, 0.114, 0.0, 2.4), (1.24, 0.17, 0.14, 0.11, 0.0, 2.5),
               (1.3, 0.177, 0.114, 0.104, 0.002, 2.6), (1.335, 0.177, 0.095, 0.094, 0.004, 2.6), (1.365, 0.13, 0.07, 0.072, 0.006, 2.2),
               (1.388, 0.065, 0.05, 0.052, 0.008, 2.0), (1.398, 0, 0, 0, 0.008, 2.0)],
        waist_z=1.0, chest_z=1.2, neck_z=1.375, sh=(0.197, 0.0, 1.33), neck_r=0.056,
        head=dict(c=(0.0, -0.02, 1.535), r=(0.112, 0.116, 0.12), top=0.97, jaw=1.08, chin=0.01, brow=0.006),
        arm=(0.26, 0.24, 0.15), arm_r=(0.054, 0.044, 0.047, 0.035), arm_fwd=26, arm_out=17, hand=1.04,
        leg_r=(0.088, 0.069, 0.071, 0.05), foot=dict(kind="welly", len=0.28, w=0.128, out=8, sole=0.03, shaft=0.36), hem=(0.26, False),
        face=dict(eye_h=0.39, eye_v=0.1, eyes=((0.033, 0.42, (10, 2), 4), (0.036, 0.04, (2, 12), 16)),
                  brow=(0.0105, 0.14, -0.02, (10, -16)), nose=(-0.12, (0.028, 0.026, 0.024), 4),
                  mouth=(-0.05, -0.5, 0.28, 0.18, -9, 0.0052), tooth=(0.45, 1.15), ears=(0.0, (0.028, 0.036, 0.011), (1.0, 1.0))),
        hair="cap",
        style=dict(hips=(-3, -2, 0), spine=(-5, -2, 0), chest=(-2, -3, 0), neck=(8, 0, 0), head=(-4, -10, 6),
                   arms=dict(L=(-2, 14, 12, 30), R=(6, 10, 8, 34)),
                   walk=dict(T=1.5, D=0.62, duty=(0.6, 0.65), lift=(0.012, 0.045), toe=(26, 12), sway=0.05, roll=7.5,
                             yaw=4, width=(0.035, 0.025), k=0.985),
                   lurch=dict(T=0.95, D=0.86, duty=(0.53, 0.56), lift=(0.035, 0.095), toe=(24, 16), sway=0.07, roll=11,
                              yaw=7, width=(0.04, 0.03), k=0.955)),
    ),
    "big": dict(
        col=dict(skin="#86997b", hair="#2f2b26", cloth="#b5ae9b", trousers="#5a4636", belt="#a08a5e", boot="#2c2a28",
                 sole="#3f3b37"),
        hip_z=1.12, hip_x=0.17, knee_t=0.47, ankle_z=0.13,
        torso=[(0.975, 0, 0, 0, 0.0, 2.4), (0.995, 0.13, 0.12, 0.12, 0.0, 2.4), (1.03, 0.225, 0.2, 0.2, 0.0, 2.4),
               (1.1, 0.275, 0.25, 0.25, 0.005, 2.5), (1.22, 0.295, 0.28, 0.245, 0.0, 2.5), (1.36, 0.305, 0.3, 0.245, -0.01, 2.5),
               (1.52, 0.335, 0.29, 0.255, -0.015, 2.5), (1.7, 0.39, 0.29, 0.275, -0.02, 2.6), (1.86, 0.43, 0.29, 0.29, -0.02, 2.7),
               (1.97, 0.44, 0.27, 0.3, -0.015, 2.8), (2.05, 0.42, 0.235, 0.29, -0.01, 2.8), (2.12, 0.36, 0.19, 0.26, -0.01, 2.5),
               (2.18, 0.26, 0.15, 0.22, -0.015, 2.2), (2.22, 0.14, 0.11, 0.15, -0.02, 2.0), (2.235, 0, 0, 0, -0.02, 2.0)],
        waist_z=1.36, chest_z=1.72, neck_z=2.19, sh=(0.42, 0.0, 1.99), neck_r=0.12,
        head=dict(c=(0.0, -0.1, 2.39), r=(0.14, 0.145, 0.155), top=0.9, jaw=1.2, chin=0.035, brow=0.02),
        arm=(0.6, 0.56, 0.3), arm_r=(0.15, 0.095, 0.13, 0.08), arm_fwd=22, arm_out=20, hand=2.4,
        arm_shape=[(0.0, 0.15), (0.2, 0.142), (0.55, 0.126), (0.92, 0.1), (1.0, 0.095), (1.12, 0.118), (1.38, 0.13), (1.75, 0.105), (2.0, 0.08)],
        leg_r=(0.17, 0.13, 0.142, 0.1), foot=dict(kind="boot", len=0.46, w=0.25, out=10, sole=0.05, shaft=0.32), hem=(0.24, False),
        face=dict(eye_h=0.4, eye_v=0.12, eyes=((0.037, 0.28, (-6, 4), 10), (0.033, 0.42, (8, 0), 6)),
                  brow=(0.014, 0.08, -0.04, (14, -10)), nose=(-0.08, (0.03, 0.024, 0.022), -6),
                  mouth=(0.0, -0.5, 0.34, 0.12, -4, 0.008), tooth=(0.35, 1.9), ears=(0.04, (0.026, 0.032, 0.012), (1.0, 0.95)),
                  underbite=True),
        hair="tuft",
        style=dict(hips=(8, 0, 0), spine=(8, 0, 0), chest=(12, 0, 0), neck=(-6, 0, 0), head=(-14, 4, 0),
                   shoulders=(4, 4),
                   arms=dict(L=(-84, 14, 18, 8), R=(-80, 14, 22, 10)),
                   stomp=dict(T=1.8, D=1.5, duty=(0.6, 0.6), lift=(0.2, 0.2), toe=(-12, -12), sway=0.09, roll=6,
                              yaw=7, width=(0.05, 0.05), k=0.965, drop=0.06)),
    ),
}
ORDER = ["shirt", "hoodie", "overall", "farmer", "big"]


class Body:
    """A figure's joints in its rest pose (standing, arms hanging down and a little forward and out, legs
    straight down) and the segment and thickness each bone pulls the skin with."""

    def __init__(self, v, P):
        self.v, self.P = v, P
        self.big = v == "big"
        self.q = 1.6 if self.big else 1.0          # more segments on the big one (it is seen bigger)
        self.C = {k: rgb(h) for k, h in P["col"].items()}
        self.T = Torso(P["torso"])
        hd = P["head"]
        self.hd = Head(hd["c"], hd["r"], hd.get("top", 1.0), hd.get("jaw", 1.0), hd.get("chin", 0.0), 1.0, hd.get("brow", 0.0))
        self.crotch = P["torso"][0][0] + 0.015
        self.hip = {}
        self.knee = {}
        self.ankle = {}
        self.sh = {}
        self.elbow = {}
        self.wrist = {}
        self.tip = {}
        self.arm_dir = {}
        self.toe = {}
        self.heel = {}
        L1, L2, Lh = P["arm"]
        fo = P["foot"]
        self.fs = fo["len"] / 0.27      # foot scale
        for s, X in SIDES:
            hip = Vector((X * P["hip_x"], 0.0, P["hip_z"]))
            ankle = Vector((X * (P["hip_x"] + 0.008 * self.fs), 0.0, P["ankle_z"]))
            self.hip[s], self.ankle[s] = hip, ankle
            self.knee[s] = hip.lerp(ankle, P["knee_t"])
            f, o = math.radians(P["arm_fwd"]), math.radians(P["arm_out"])
            d = Vector((X * math.sin(o), -math.cos(o) * math.sin(f), -math.cos(o) * math.cos(f)))
            self.arm_dir[s] = d
            sh = Vector((X * P["sh"][0], P["sh"][1], P["sh"][2]))
            self.sh[s] = sh
            self.elbow[s] = sh + d * L1
            self.wrist[s] = self.elbow[s] + d * L2
            self.tip[s] = self.wrist[s] + d * Lh * P["hand"] / 1.0 * (0.8 if self.big else 1.0)
            yaw = Matrix.Rotation(math.radians(X * fo["out"]), 3, "Z")
            self.toe[s] = ankle + yaw @ Vector((0.0, -0.165 * self.fs, 0.035 * self.fs - P["ankle_z"]))
            self.heel[s] = ankle + yaw @ Vector((0.0, 0.05 * self.fs, 0.04 * self.fs - P["ankle_z"]))
        self.L1 = {s: (self.knee[s] - self.hip[s]).length for s, _ in SIDES}
        self.L2 = {s: (self.ankle[s] - self.knee[s]).length for s, _ in SIDES}
        self.leg_len = self.L1["L"] + self.L2["L"]
        hc = self.hd.c
        self.skull = Vector((0.0, hc.y + 0.01, hc.z - 0.55 * self.hd.rz))
        self.neck_base = Vector((0.0, self.T.section(P["neck_z"])[3], P["neck_z"] - 0.01))
        self.hips_head = Vector((0.0, 0.0, P["hip_z"]))
        top = hc.z + self.hd.rz
        # The bones: head, tail and where its z axis points (its roll).
        self.bones = {
            "Root": (Vector((0, 0, 0)), Vector((0, 0, 0.2 * self.q)), FWD),
            "Hips": (self.hips_head, Vector((0, 0, P["waist_z"])), FWD),
            "Spine": (Vector((0, 0, P["waist_z"])), Vector((0, 0, P["chest_z"])), FWD),
            "Chest": (Vector((0, 0, P["chest_z"])), self.neck_base, FWD),
            "Neck": (self.neck_base, self.skull, FWD),
            "Head": (self.skull, Vector((0.0, self.skull.y, top)), FWD),
        }
        for s, X in SIDES:
            inner = Vector((X * 0.035 * self.q, 0.0, self.neck_base.z - 0.03 * self.q))
            self.bones[f"Shoulder.{s}"] = (inner, self.sh[s], FWD)
            self.bones[f"UpperArm.{s}"] = (self.sh[s], self.elbow[s], FWD)
            self.bones[f"LowerArm.{s}"] = (self.elbow[s], self.wrist[s], FWD)
            self.bones[f"Hand.{s}"] = (self.wrist[s], self.tip[s], FWD)
            self.bones[f"UpperLeg.{s}"] = (self.hip[s], self.knee[s], FWD)
            self.bones[f"LowerLeg.{s}"] = (self.knee[s], self.ankle[s], FWD)
            self.bones[f"Foot.{s}"] = (self.ankle[s], self.toe[s], UP)
        # The segments and thicknesses the skin is weighted by (not always the bone itself: the foot pulls
        # from heel to toe, so the sole follows the foot and not the shin).
        T = self.T
        hw = lambda z: T.section(z)[0]
        ar = P["arm_r"]
        lr = P["leg_r"]
        self.field = {
            "Root": (Vector((0, 0, -9)), Vector((0, 0, -9)), 0.01),
            "Hips": (Vector((0, 0, self.crotch + 0.03 * self.q)), Vector((0, 0, P["waist_z"] - 0.03 * self.q)), hw(P["hip_z"]) * 0.95),
            "Spine": (Vector((0, 0, P["waist_z"] - 0.03 * self.q)), Vector((0, 0, P["chest_z"])), hw(P["waist_z"]) * 0.95),
            "Chest": (Vector((0, 0, P["chest_z"])), Vector((0, self.neck_base.y, self.neck_base.z - 0.03 * self.q)), hw(P["chest_z"])),
            "Neck": (self.neck_base - Vector((0, 0, 0.02 * self.q)), self.skull, P["neck_r"] * 1.3),
            "Head": (self.skull, hc, self.hd.rx),
        }
        for s, X in SIDES:
            self.field[f"Shoulder.{s}"] = (self.bones[f"Shoulder.{s}"][0], self.sh[s], ar[0] * 1.15)
            self.field[f"UpperArm.{s}"] = (self.sh[s], self.elbow[s], ar[0])
            self.field[f"LowerArm.{s}"] = (self.elbow[s], self.wrist[s], ar[2])
            self.field[f"Hand.{s}"] = (self.wrist[s] + self.arm_dir[s] * 0.02 * P["hand"], self.tip[s], 0.04 * P["hand"])
            self.field[f"UpperLeg.{s}"] = (self.hip[s], self.knee[s], lr[0])
            self.field[f"LowerLeg.{s}"] = (self.knee[s], self.ankle[s] + Vector((0, 0, 0.03 * self.fs)), lr[2])
            self.field[f"Foot.{s}"] = (self.heel[s], self.toe[s] + (self.toe[s] - self.heel[s]).normalized() * 0.04 * self.fs,
                                       fo["w"] / 2)
        # The rest pose's hinge axes: an elbow bends its forearm forward about +, a knee its shin back.
        self.elbow_axis = {s: self.arm_dir[s].cross(FWD).normalized() for s, _ in SIDES}
        self.rest_dir = {b: (t - h).normalized() for b, (h, t, _) in self.bones.items()}


# ======== Building a figure's pieces.
def lods(B, lod):
    """Segment counts for a level of detail (LOD1 is for far away: fewer segments, no small details)."""
    q = B.q
    if lod == 0:
        return dict(torso=even(16 * q), limb=even(8 * q), head=even(16 * q), head_rings=int(11 * q), small=even(8 * q),
                    tiny=5, detail=True)
    return dict(torso=8, limb=6, head=10, head_rings=7, small=5, tiny=4, detail=False)


def head_and_face(fig, B, lod):
    P, F, C, hd = B.P, B.P["face"], B.C, B.hd
    S = lods(B, lod)
    skin = C["skin"]
    fig.add(hd.mesh(S["head"], S["head_rings"]), skin, HEAD)
    pupil = rgb("#1b1c1f")
    white = rgb("#ebe8d4")
    # Ears: flattened, turned forward a little so they stick out, one bigger than the other.
    ev, (ew, eh, et), (kl, kr) = F["ears"]
    for (s, X), k in zip(SIDES, (kl, kr)):
        h = X * (math.pi / 2 - 0.08)
        n = hd.n_at(h, ev)
        c = hd.at(h, ev, -0.004)
        y = UP.cross(n).normalized()
        fr = Matrix((n, y, n.cross(y))).transposed()
        R = Matrix.Rotation(math.radians(-X * 18), 3, "Z") @ Matrix.Rotation(math.radians(X * 6), 3, "Y")
        fig.add(blob(c + n * et * 0.5, (et * k, ew * k, eh * k), R @ fr, 6 if lod == 0 else 4, 4 if lod == 0 else 3), skin, HEAD)
    # Nose: a bulb on the middle of the face, drooping a little.
    nv, nr, nd = F["nose"]
    fig.add(blob(hd.at(0.0, nv, nr[1] * 0.45), nr, Matrix.Rotation(math.radians(nd), 3, "X"), 8 if lod == 0 else 5, 5 if lod == 0 else 3),
            tone(skin, 0.93), HEAD)
    # Eyes: big balls standing out of the face, a dark pupil each looking its own way, a thin lid drooping
    # over the top of each, tilted down at the outer side; a tired shadow under them.
    eh_, evv = F["eye_h"], F["eye_v"]
    for (s, X), (re, lid, look, droop) in zip(SIDES, F["eyes"]):
        n = hd.n_at(X * eh_, evv)
        c = hd.at(X * eh_, evv, -re * 0.18)
        fig.add(blob(c, (re, re, re), None, 10 + 2 * B.big if lod == 0 else 6, 7 + B.big if lod == 0 else 4), white, HEAD)
        g = (Matrix.Rotation(math.radians(look[0]), 3, "Z") @ Matrix.Rotation(math.radians(look[1]), 3, "X")) @ n
        pr = re * 0.42
        fig.add(blob(c + g * re * 0.94, (pr, pr, pr * 0.45), UP.rotation_difference(g).to_matrix(), 10 if lod == 0 else 5, 4 if lod == 0 else 2),
                pupil, HEAD)
        axis = Matrix.Rotation(math.radians(X * droop), 3, "Y") @ (Matrix.Rotation(math.radians(22), 3, "X") @ UP)
        fig.add(lid_cap(c, re * 1.07, axis, lid * re, 10 + 2 * B.big if lod == 0 else 6, 3 if lod == 0 else 1), tone(skin, 0.87), HEAD)
        if lod == 0:
            vb = evv - re / hd.rz * 1.0
            fig.add(blob(hd.at(X * (eh_ + 0.03), vb, -0.002), (re * 0.72, 0.006, re * 0.3), face_frame(hd.n_at(X * (eh_ + 0.03), vb)), 6, 3),
                    tone(skin, 0.86), HEAD)
    # Brows: short bars, the inner ends raised (worried), each its own tilt.
    br, b_in, b_out, (tl, tr_) = F["brow"]
    for (s, X), tilt in zip(SIDES, (tl, tr_)):
        re = F["eyes"][0 if s == "L" else 1][0]
        v0 = evv + re / hd.rz * 1.3 + b_in
        h0, h1 = X * (eh_ - 0.22), X * (eh_ + 0.26)
        v1 = v0 + b_out - math.radians(tilt) * 0.25
        p0, p1 = hd.at(h0, v0 + math.radians(tilt) * 0.12, br * 0.9), hd.at(h1, v1, br * 0.6)
        L = (p1 - p0).length
        fig.add(tube(p0, p1, [(-br, 0.0), (0.0, br), (L, br * 0.85), (L + br * 0.85, 0.0)], S["tiny"]), C.get("brow", C["hair"]), HEAD)
    mouth(fig, B, lod)
    hair(fig, B, lod)


def lid_cap(c, R, axis, h, seg, m):
    """A spherical cap round c (radius R) about axis, cut flat at h along it: an eyelid."""
    axis = Vector(axis).normalized()
    u, v = frame_of(axis)
    phc = math.acos(max(-0.95, min(0.95, h / R)))

    def fn(i, th):
        if i == m + 1:
            return c + axis * h
        ph = phc * i / m
        return c + axis * (R * math.cos(ph)) + (u * math.cos(th) + v * math.sin(th)) * (R * math.sin(ph))
    return orient(grid(fn, range(m + 2), seg))


def mouth(fig, B, lod):
    """A goofy open mouth: a dark patch on the face inside a ring of lip, one tooth hanging from the top
    (or standing up from the bottom, for an underbite)."""
    F, C, hd = B.P["face"], B.C, B.hd
    mh, mv, aw, ah, tilt, lip = F["mouth"]
    ca, sa = math.cos(math.radians(tilt)), math.sin(math.radians(tilt))
    m = (12 if lod == 0 else 6) + (4 if B.big and lod == 0 else 0)

    def hv(rho, a):
        x, y = rho * aw * math.cos(a), rho * ah * math.sin(a)
        if y > 0:
            y *= 0.75   # a flatter top edge, a rounder bottom: the jaw hangs open
        return mh + x * ca - y * sa, mv + x * sa + y * ca

    rhos = [0.0, 0.55, 1.02] if lod == 0 else [0.0, 1.02]
    plate = grid(lambda i, a: hd.at(*hv(rhos[i], a), 0.0016 + 0.0008 * i), range(len(rhos)), m)
    fig.add(orient(plate, hd.n_at(mh, mv)), rgb("#3a292f"), HEAD)
    if F.get("tongue") and lod == 0:
        fig.add(blob(hd.at(*hv(0.45, -math.pi / 2), 0.004), (aw * hd.rx * 0.5, 0.006, ah * hd.rz * 0.3), face_frame(hd.n_at(mh, mv)), 8, 4),
                rgb("#8f6a6c"), HEAD)
    cs, ns, rs = [], [], []
    for k in range(m):
        a = 2 * math.pi * k / m
        cs.append(hd.at(*hv(1.0, a), 0.0035))
        ns.append(hd.n_at(*hv(1.0, a)))
        rs.append((hd.at(*hv(1.12, a)) - hd.at(*hv(0.9, a))).normalized())
    lower = lambda i, th: lip * (1.0 + 0.45 * max(0.0, -math.sin(2 * math.pi * i / m)))
    fig.add(torus(cs, ns, rs, lower, 5 if lod == 0 else 3), tone(C["skin"], 0.78), HEAD)
    tp, ts = F["tooth"]
    if F.get("underbite"):
        a, rho = -math.pi / 2 + tp * 0.9, 0.72
    else:
        a, rho = math.pi / 2 - tp * 0.9, 0.66
    hh, vv = hv(rho, a)
    sz = 0.0095 * ts * (hd.rx / 0.104)
    fig.add(blob(hd.at(hh, vv, 0.005), (sz, sz * 0.55, sz * 1.25), face_frame(hd.n_at(hh, vv)), 6 if lod == 0 else 4, 4 if lod == 0 else 2, 0.65),
            rgb("#e6e0c6"), HEAD)
    if F.get("moustache"):
        for s, X in SIDES:
            c = hd.at(X * 0.13, mv + ah * 0.95, 0.013)
            R = face_frame(hd.n_at(X * 0.13, mv + ah)) @ Matrix.Rotation(math.radians(-X * 22), 3, "Y")
            fig.add(blob(c, (0.034, 0.014, 0.014), R, 6 if lod == 0 else 4, 4 if lod == 0 else 3), C["hair"], HEAD)


def tuft(hd, h, v, d, length, r, seg, bend=None):
    """A tuft of hair: a fat tapering curl from the scalp at (h, v), out along d and curling towards bend
    (by default back and down, as if combed by nobody for a long time)."""
    base = hd.at(h, v, 0.006)
    d = Vector(d).normalized()
    bend = Vector(bend) if bend is not None else (Vector((0, 1, -0.6)) - FWD * 0.0)
    b = bend - d * bend.dot(d)
    b = b.normalized() if b.length > 1e-6 else frame_of(d)[0]
    pts = [base - d * 0.006, base] + [base + d * (length * t) + b * (length * 0.4 * t * t) for t in (0.4, 0.78, 0.95, 1.0)]
    return sweep(pts, [0.0, r, r * 0.85, r * 0.55, r * 0.38, 0.0], seg, [b] * len(pts))


def hair(fig, B, lod):
    P, C, hd = B.P, B.C, B.hd
    style = P["hair"]
    rnd = random.Random(101 + ORDER.index(B.v))
    hc = C["hair"]
    S = lods(B, lod)
    k = hd.rx / 0.104
    if style in ("messy", "fringe"):
        front = 0.62 if style == "messy" else 0.44
        line = lambda h: front * (1 + math.cos(h)) / 2 - 0.3 * (1 - math.cos(h)) / 2 + 0.25 * math.sin(h) ** 2
        out = lambda h, v: (0.015 + 0.008 * math.sin(3 * h + 1.3) * math.cos(v) + 0.004 * math.cos(5 * h) * math.cos(v)) * k
        fig.add(hair_shell(hd, line, out, S["head"], 3 if lod == 0 else 2), hc, HEAD)
        if style == "messy":
            tufts = [(0.1, 1.2, 0.05), (0.9, 1.0, 0.045), (-0.8, 1.05, 0.05), (2.6, 0.85, 0.045), (-2.4, 0.9, 0.04), (math.pi, 0.45, 0.035)]
        else:
            tufts = [(0.15, 0.6, -0.05), (-0.3, 0.56, -0.045), (0.55, 0.52, -0.04), (0.35, 1.2, 0.045), (2.8, 0.85, 0.04), (-1.7, 0.9, 0.035)]
        for h, v, L in (tufts if lod == 0 else tufts[:1]):
            n = hd.n_at(h, v)
            if L < 0:   # a fringe tuft, curling down over the forehead
                d, L, bend = n * 0.9 + UP * 0.3, -L, FWD * 0.3 - UP
            else:
                d = n + Vector((rnd.uniform(-0.35, 0.35), rnd.uniform(-0.3, 0.3), 0.35))
                bend = Vector((rnd.uniform(-0.6, 0.6), 0.8, -0.5))
            fig.add(tuft(hd, h, v, d, L * k * 1.05, 0.021 * k, 4, bend), hc, HEAD)
    elif style == "bald":
        # Grey puffs over the ears and round the back, the top bare.
        puffs = ((1.45, 0.28, (0.028, 0.05, 0.04)), (-1.45, 0.28, (0.028, 0.05, 0.04)), (2.4, 0.3, (0.04, 0.035, 0.04)),
                 (-2.4, 0.3, (0.04, 0.035, 0.04)), (math.pi, 0.2, (0.05, 0.03, 0.045)))
        for h, v, r in (puffs if lod == 0 else puffs[:2]):
            fig.add(blob(hd.at(h, v, 0.006), r, face_frame(hd.n_at(h, v)), 6 if lod == 0 else 4, 4 if lod == 0 else 3), hc, HEAD)
        if lod == 0:
            for h, v, bend in ((1.5, 0.58, (1, 0.3, -0.4)), (-1.4, 0.62, (-1, 0.3, -0.4)), (0.15, 1.3, (0.3, 1, -0.2))):
                fig.add(tuft(hd, h, v, hd.n_at(h, v) + UP * 0.4, 0.045, 0.012, 4, Vector(bend)), hc, HEAD)
    elif style == "cap":
        # A flat cap pulled down at the front, grey tufts sticking out under it.
        c = hd.c + Vector((0.0, -0.012, hd.rz * 0.66))
        fig.add(blob(c, (hd.rx * 1.12, hd.ry * 1.16, hd.rz * 0.4), Matrix.Rotation(math.radians(12), 3, "X"),
                     S["head"], 6 if lod == 0 else 4, 0.85), C["cap"], HEAD)
        fig.add(blob(hd.c + Vector((0.0, -hd.ry * 1.02, hd.rz * 0.52)), (hd.rx * 0.88, 0.06, 0.012),
                     Matrix.Rotation(math.radians(16), 3, "X"), 10 if lod == 0 else 6, 4 if lod == 0 else 2, 0.8), C["capband"], HEAD)
        for h, v in (((1.42, 0.3), (-1.42, 0.3), (2.3, 0.27)) if lod == 0 else ()):
            fig.add(tuft(hd, h, v, hd.n_at(h, v) - UP * 0.25, 0.04, 0.014, 4, Vector((0, 0.6, -1))), C["hair"], HEAD)
    elif style == "tuft":
        for h, v, L, lean in ((0.0, 1.35, 0.075, 0.2), (0.4, 1.2, 0.05, 0.5), (-0.5, 1.15, 0.045, -0.5)):
            if lod and L < 0.07:
                continue
            fig.add(tuft(hd, h, v, hd.n_at(h, v) + Vector((lean * 0.4, -0.3, 0.0)), L, 0.022, 5 if lod == 0 else 4, Vector((lean, 1, 0))), hc, HEAD)


def hair_shell(hd, line, out, seg, rows):
    """A cap of hair over the crown down to a hairline: line(h) the hairline (radians above the middle of
    the head) at h round from the front, out(h, v) how far it stands off the scalp. Closed: an inner skin
    just under the scalp and an outer one, joined at the hairline."""
    ks = [("in", f / rows) for f in range(rows + 1)] + [("out", 1 - f / rows) for f in range(rows + 1)]

    def fn(i, th):
        side, f = ks[i]
        h = (th + math.pi / 2 + math.pi) % (2 * math.pi) - math.pi
        v = math.pi / 2 - f * (math.pi / 2 - line(h))
        if side == "in":
            off = -0.004
        elif f > 0.999:
            off = 0.0015
        else:
            off = out(h, v)
        return hd.at(h, v, off)
    return orient(grid(fn, range(len(ks)), seg))


def arm(fig, B, s, X, lod, sleeve=None, cuff=None, sleeve_col=None, roll_col=None, check=None):
    """The skin of an arm from the shoulder ball to the wrist, and its sleeve: sleeve is where the sleeve
    ends (distance along the arm), cuff how ("ragged", "band" or "roll"); check(i, j) colours a checked one."""
    P, C = B.P, B.C
    S = lods(B, lod)
    L1, L2, _ = P["arm"]
    r_sh, r_el, r_fa, r_wr = P["arm_r"]
    p0, d, q = B.sh[s], B.arm_dir[s], B.q
    if "arm_shape" in P:
        # (u, r): u up to 1 along the upper arm, 1..2 along the forearm.
        pts = [(u * L1 if u <= 1 else L1 + (u - 1) * L2, r) for u, r in P["arm_shape"]]
        if lod:
            pts = [pts[0], pts[2], pts[4], pts[6], pts[-1]]
        prof = start_cap(0.0, pts[0][1], 2 if lod == 0 else 1) + pts + end_cap(L1 + L2, pts[-1][1], 1)
    elif lod == 0:
        prof = (start_cap(0.0, r_sh * 1.05, 2) + [(0.0, r_sh * 1.05), (0.45 * L1, r_sh), (L1 - 0.035 * q, r_el * 1.06), (L1, r_el),
                (L1 + 0.04 * q, r_fa), (L1 + 0.55 * L2, r_fa * 0.93), (L1 + L2, r_wr)] + end_cap(L1 + L2, r_wr, 1))
    else:
        prof = start_cap(0.0, r_sh * 1.05, 1) + [(0.0, r_sh * 1.05), (L1, r_el), (L1 + 0.5 * L2, r_fa * 0.95), (L1 + L2, r_wr)] + end_cap(L1 + L2, r_wr, 1)
    limb = Limb(p0, p0 + d, prof, FWD)
    if sleeve is None:
        fig.add(limb.mesh(prof, S["limb"]), C["skin"], ARM(s))
        return
    gap = (0.018 if cuff == "band" else 0.012) * q
    if lod:
        # Far away: one tube, coloured as sleeve up to where the sleeve ends.
        pr = start_cap(0.0, r_sh * 1.05 + gap * 0.6, 1) + [(0.0, r_sh * 1.05 + gap * 0.6), (min(sleeve, L1) * 0.5, r_sh + gap * 0.6),
                                                           (sleeve, limb.r(sleeve) + gap * 0.5), (sleeve + 0.006, limb.r(sleeve + 0.006))]
        pr += [(t, r) for t, r in prof if t > sleeve + 0.01]
        fig.add(limb.mesh(pr, S["limb"]), lambda tag: sleeve_col if tag[0] <= 3 else C["skin"], ARM(s))
        return
    fig.add(limb.mesh(prof, S["limb"]), C["skin"], ARM(s))
    rnd = random.Random(11 + ORDER.index(B.v) * 7 + (s == "R"))
    n = S["limb"]
    teeth = [(0.35 + 0.65 * rnd.random()) * (j % 2) + 0.2 * rnd.random() for j in range(n)]
    sp = start_cap(0.0, r_sh * 1.05 + gap, 2)
    if check is not None:
        # Even rings for the checks, about as far apart as the faces are wide.
        step = 2 * math.pi * (r_sh + gap) / n
        sp += [(t, limb.r(t) + gap) for t in np.arange(0.0, sleeve - 0.01, step)]
    else:
        sp += [(0.0, r_sh * 1.05 + gap)] + [(t, limb.r(t) + gap) for t in (0.3 * L1, 0.65 * L1, L1 - 0.035 * q, L1, L1 + 0.04 * q, L1 + 0.55 * L2)
                                            if t < sleeve - (0.07 if cuff == "band" else 0.015) * q]
    band_from = len(sp)
    if cuff == "band":
        sp.append((sleeve - 0.06 * q, limb.r(sleeve - 0.06 * q) + gap))
    end = len(sp)
    sp += [(sleeve, limb.r(sleeve) + gap * (1.15 if cuff == "roll" else 1.0)), (sleeve - 0.008, limb.r(sleeve) - 0.003), (sleeve - 0.05, 0.0)]

    def zig(i, th):
        if cuff != "ragged" or i < end:
            return 0.0
        return -0.03 * q * teeth[int(round(th / (2 * math.pi) * n)) % n]

    def colour(tag):
        i, j = tag
        if check is not None and 1 <= i < end - 1:
            return check(i, j)
        if cuff == "band" and i >= band_from:
            return roll_col
        return sleeve_col
    fig.add(limb.mesh(sp, n, zig), colour, ARM(s))
    if cuff == "roll":
        # A fat rolled-up cuff round the end of the sleeve.
        c = p0 + d * (sleeve - 0.01 * q)
        u, v = frame_of(d, FWD)
        rr = limb.r(sleeve) + gap * 1.1
        cs = [c + (u * math.cos(a) + v * math.sin(a)) * rr for a in np.linspace(0, 2 * math.pi, n, endpoint=False)]
        fig.add(torus(cs, [(p - c).normalized() for p in cs], [d] * n, 0.015 * q, 4), roll_col, ARM(s))


def hand(fig, B, s, X, lod, fist=False):
    """A big cartoon hand at the wrist: a mitten of a palm, three fat fingers curled a little (claws) and
    a thumb; the big one has fists. The palm faces back and in, so it faces down when the arm reaches."""
    k = B.P["hand"]
    skin = B.C["skin"]
    w = B.arm_dir[s]
    back = Vector((0, 1, 0))
    n = (back - w * back.dot(w)).normalized()
    n = (Quaternion(w, math.radians(-X * 35)) @ n).normalized()   # turned to face in a little
    l = (n.cross(w) * X).normalized()                            # towards the thumb
    W = B.wrist[s]
    R = Matrix((l, n, w)).transposed()
    if fist:
        fig.add(blob(W + w * 0.05 * k, (0.046 * k, 0.032 * k, 0.05 * k), R, 12 if lod == 0 else 6, 7 if lod == 0 else 4, 0.7), skin, HAND(s))
        if lod == 0:
            for j in range(4):
                c = W + w * (0.088 * k) + l * ((j - 1.5) * 0.022 * k) + n * (0.012 * k)
                fig.add(blob(c, (0.012 * k, 0.018 * k, 0.017 * k), R, 6, 4), tone(skin, 0.95), HAND(s))
            tb = W + w * 0.03 * k + l * 0.042 * k
            fig.add(tube(tb, tb + (w * 0.5 + n * 0.6 - l * 0.2).normalized(), [(-0.012 * k, 0), (0.0, 0.013 * k), (0.035 * k, 0.012 * k), (0.047 * k, 0)], 6),
                    skin, HAND(s))
        return
    fig.add(blob(W + w * 0.045 * k, (0.04 * k, 0.02 * k, 0.05 * k), R, 8 if lod == 0 else 5, 5 if lod == 0 else 3, 0.8), skin, HAND(s))
    if lod == 0:
        curl = math.radians(28)
        for j, (spread, length) in enumerate(((-9, 0.058), (0, 0.066), (9, 0.058))):
            base = W + w * (0.08 * k) + l * ((j - 1) * 0.024 * k)
            d = Quaternion(n, math.radians(spread * X)) @ (w * math.cos(curl) + n * math.sin(curl)).normalized()
            L = length * k
            fig.add(tube(base, base + d * L, [(-0.004 * k, 0.0), (0.0, 0.012 * k), (L * 0.6, 0.0115 * k), (L, 0.0)], 5), skin, HAND(s))
        tb = W + w * 0.035 * k + l * 0.03 * k
        d = (w * 0.65 + l * 0.6 + n * 0.35).normalized()
        fig.add(tube(tb, tb + d * 0.05 * k, [(-0.004, 0.0), (0.0, 0.012 * k), (0.032 * k, 0.011 * k), (0.05 * k, 0.0)], 5), skin, HAND(s))
    else:
        tb = W + w * 0.04 * k + l * 0.03 * k
        d = (w * 0.7 + l * 0.6).normalized()
        fig.add(tube(tb, tb + d * 0.045 * k, [(0.0, 0.0), (0.004, 0.013 * k), (0.045 * k, 0.0)], 4), skin, HAND(s))
        fig.add(blob(W + w * 0.1 * k + n * 0.012 * k, (0.036 * k, 0.014 * k, 0.03 * k), R, 4, 3), skin, HAND(s))


def leg_prof(B, s, lod):
    """A leg's radii down from the hip ball to the ankle: [(t, r)], t along the leg from the hip."""
    r_th, r_kn, r_ca, r_an = B.P["leg_r"]
    L = (B.ankle[s] - B.hip[s]).length
    L1, q = B.L1[s], B.q
    if lod:
        return start_cap(0.0, r_th, 1) + [(0.0, r_th), (L1, r_kn), (L1 + 0.35 * (L - L1), r_ca), (L, r_an)]
    return start_cap(0.0, r_th, 2) + [(0.0, r_th), (0.3 * L1, r_th * 0.94), (L1 - 0.05 * q, r_kn * 1.06), (L1, r_kn),
                                     (L1 + 0.05 * q, r_kn * 1.04), (L1 + 0.35 * (L - L1), r_ca), (L, r_an)]


def collar(B, s):
    """A shoe's collar or a boot's shaft round the ankle: its top height, radius at the bottom and top."""
    fo, q = B.P["foot"], B.q
    top = fo.get("shaft", 0.13 * B.fs if fo["kind"] == "trainer" else 0.112 * B.fs)
    margin = (0.022 if fo["kind"] == "welly" else 0.011) * q
    lim = Limb(B.hip[s], B.ankle[s], leg_prof(B, s, 0))
    rb = B.P["leg_r"][3] + margin
    rt = max(rb, lim.r(B.hip[s].z - top) + margin)
    return top, rb, rt


def leg(fig, B, s, X, lod, col, patch=None, patch_col=None):
    """A trouser leg from the hip ball down to its hem: over the shoe's collar (flared) or tucked into a
    boot; patch (t, theta, half size) puts a patch on it."""
    hem_z, over = B.P["hem"]
    S = lods(B, lod)
    H, A = B.hip[s], B.ankle[s]
    base = leg_prof(B, s, lod)
    lim = Limb(H, A, base, FWD)
    t_end = H.z - hem_z
    top, rb, rt = collar(B, s)
    if over:
        r_end = rb + (rt - rb) * max(0.0, min(1.0, (hem_z - A.z) / max(1e-3, top - A.z))) + 0.011 * B.q
    else:
        r_end = lim.r(t_end)
    prof = [(t, r) for t, r in base if t < t_end - 0.07 * B.q]
    if over:
        prof.append((t_end - 0.07 * B.q, lim.r(t_end - 0.07 * B.q) + 0.002))
    prof += [(t_end, r_end), (t_end - 0.008, r_end - 0.006), (t_end - 0.05 * B.q, 0.0)]
    fig.add(lim.mesh(prof, S["limb"]), col, LEG(s))
    if patch is not None and lod == 0:
        t, th, size = patch
        r0 = lim.r(t)
        fig.add(slab(lambda tt, a, off: lim.point(tt, a, off), t - size, t + size, th - size / r0, th + size / r0, 0.004, 0.006, 3, 4),
                patch_col, LEG(s))


def shoe(fig, B, s, X, lod):
    """A big cartoon shoe, boot or welly: the foot part swept from heel to toe over a sole, and a collar
    or shaft round the ankle."""
    P, C = B.P, B.C
    fo = P["foot"]
    kind, k = fo["kind"], B.fs
    A = B.ankle[s]
    yaw = Matrix.Rotation(math.radians(X * fo["out"]), 3, "Z")
    sole_h = fo["sole"]
    upper_col = C.get("shoe", C.get("boot"))
    sole_col = C.get("sole", tone(upper_col, 0.7))
    half_w = fo["w"] / 2
    # (distance from the heel, share of the width, height of the top), for a 0.27 m foot
    st = [(0.0, 0.0, 0.07), (0.018, 0.75, 0.092), (0.07, 0.93, 0.112), (0.15, 1.0, 0.098), (0.21, 0.98, 0.082), (0.255, 0.78, 0.066),
          (0.272, 0.0, 0.05)]
    if lod:
        st = [(0.0, 0.0, 0.07), (0.03, 0.85, 0.1), (0.15, 1.0, 0.1), (0.24, 0.88, 0.072), (0.272, 0.0, 0.05)]
    bulk = 1.1 if kind in ("boot", "welly", "trainer") else 1.0
    heel_y = 0.075 * k
    seg = (8 if lod == 0 else 6) + (4 if B.big and lod == 0 else 0)

    def fn(i, th):
        t, wf, top = st[i]
        y = heel_y - t * k
        hw = half_w * wf * bulk
        zc = (sole_h + top * k * bulk) / 2
        hh = (top * k * bulk - sole_h) / 2
        c, sn = math.cos(th), math.sin(th)
        x = math.copysign(abs(c) ** 0.8, c) * hw
        z = max(zc + math.copysign(abs(sn) ** 0.75, sn) * hh, (sole_h - 0.002) if not lod else 0.0)
        return A + yaw @ Vector((x, y, z - A.z))
    fig.add(orient(grid(fn, range(len(st)), seg)), upper_col, FOOT(s))
    # The sole: the shoe's outline a little wider, flat (far away, the shoe's own flat bottom will do).
    side = [] if lod else [(half_w * wf * bulk * 1.07 + 0.004, heel_y - t * k) for t, wf, _ in st if wf > 0]
    outline = ([(0.0, heel_y + 0.006)] + side + [(0.0, heel_y - st[-1][0] * k - 0.006)] + [(-x, y) for x, y in reversed(side)])
    if side:
        co, faces, tags = prism(outline, 0.0, sole_h + 0.004)
        fig.add(orient(([A + yaw @ (c - Vector((0, 0, A.z))) for c in co], faces, tags)), sole_col, FOOT(s))
    # The collar or shaft round the ankle.
    top, rb, rt = collar(B, s)
    c0 = A.copy()
    z0 = (0.06 * k if kind in ("shoe", "trainer") else sole_h + 0.012) - A.z
    prof = [(z0 - 0.002, 0.0), (z0, rb * 0.98), (0.0, rb), (top - A.z, rt), (top - A.z + 0.004, rt * 0.93), (top - A.z - 0.03, 0.0)]
    if kind == "welly":
        prof = [(z0 - 0.002, 0.0), (z0, rb), (0.0, rb), (top - A.z - 0.03, rt), (top - A.z, rt * 1.05), (top - A.z + 0.004, rt * 0.98),
                (top - A.z - 0.03, 0.0)]
    if lod:
        prof = [(z0 - 0.002, 0.0), (z0, rb), (top - A.z, rt), (top - A.z - 0.03, 0.0)]
    rim = len(prof) - (3 if lod else 4)
    ring_col = C.get("rim", tone(upper_col, 0.85))

    def scol(tag):
        if kind in ("welly", "boot") and tag[0] >= rim:
            return ring_col
        if kind == "trainer" and tag[1] in (seg // 4 - 1, seg // 4) and tag[0] >= 1:
            return C["tab"]
        return upper_col
    fig.add(Limb(c0, c0 + UP, prof, FWD).mesh(prof, seg), scol, FOOT(s))


def neck(fig, B, lod, col=None):
    r = B.P["neck_r"]
    p0 = B.neck_base - Vector((0, 0, 0.07 * B.q))
    p1 = B.hd.c - Vector((0, -0.01, 0.35 * B.hd.rz))
    L = (p1 - p0).length
    fig.add(tube(p0, p1, [(0.0, 0.0), (0.005, r * 1.15), (0.06 * B.q, r), (L, r * 0.95), (L + 0.01, 0.0)], lods(B, lod)["limb"]),
            col or B.C["skin"], NECK)


def ragged(n, amp, rnd):
    """Teeth for a torn hem: every other step pulled down by up to amp."""
    teeth = [(0.35 + 0.65 * rnd.random()) * amp * (j % 2) + 0.25 * amp * rnd.random() for j in range(n)]
    return lambda th: -teeth[int(round(th / (2 * math.pi) * n)) % n]


def th_for_x(T, z, x, back):
    """The angle round the torso at height z where it is x across, in front (or behind)."""
    a, bf, bb, cy, n = T.section(z)
    c = max(-1.0, min(1.0, x / a))
    c = math.copysign(abs(c) ** (n / 2), c)
    s = math.sqrt(max(0.0, 1 - c * c))
    return math.atan2(s if back else -s, c)


def top_for_x(T, x, z0, z1):
    """The height above z0 where the top of the torso (sloping to the neck) is x across."""
    for _ in range(30):
        zm = (z0 + z1) / 2
        if T.section(zm)[0] > x:
            z0 = zm
        else:
            z1 = zm
    return z0


def strap(fig, B, X, x, z_front, z_back, off, width, col, lod, extra_front=(), extra_back=()):
    """A flat strap over the shoulder at x across: up the front from z_front, over the top, down the
    back to z_back, lying off the torso by off."""
    T = B.T
    zt = top_for_x(T, x, B.P["sh"][2] - 0.05, T.rows[-1, 0])
    pts, ups = [], []
    zs_f = [z_front] + list(extra_front) + [B.P["sh"][2] - 0.01, zt - 0.012 * B.q]
    zs_b = [zt - 0.012 * B.q, B.P["sh"][2] - 0.01] + list(extra_back) + [z_back]
    for z in zs_f:
        th = th_for_x(T, z, X * x, False)
        pts.append(T.point(z, th, off))
        ups.append((T.point(z, th, off + 0.05) - T.point(z, th, off)).normalized())
    pts.append(T.point(zt, 0.0 if X > 0 else math.pi, off))
    ups.append(UP.copy())
    for z in zs_b:
        th = th_for_x(T, z, X * x, True)
        pts.append(T.point(z, th, off))
        ups.append((T.point(z, th, off + 0.05) - T.point(z, th, off)).normalized())
    pts = [pts[0] + (pts[0] - pts[1]).normalized() * 0.003] + pts + [pts[-1] + (pts[-1] - pts[-2]).normalized() * 0.003]
    ups = [ups[0]] + ups + [ups[-1]]
    radii = [0.0] + [width] * (len(pts) - 2) + [0.0]
    fig.add(sweep(pts, radii, 4 if lod == 0 else 3, ups, (0.25, 1.0)), col, TORSO)


def build(B, lod):
    """All the pieces of a figure at a level of detail."""
    fig = Figure()
    P, C, T = B.P, B.C, B.T
    S = lods(B, lod)
    seg, q = S["torso"], B.q
    rnd = random.Random(7 + ORDER.index(B.v) * 31 + lod)
    head_and_face(fig, B, lod)
    neck(fig, B, lod)
    v = B.v
    top = P["torso"][-1][0]
    front = -math.pi / 2

    def lower_piece(z_top, off, col):
        zs = np.linspace(B.crotch, z_top, 4 if lod == 0 else 3)
        fig.add(T.mesh([(B.crotch - 0.01, None)] + [(z, off) for z in zs] + [(z_top + 0.01, None)], seg), col, TORSO)

    def upper_piece(hem, off, flare, col, n, zig_amp=0.0, colour=None):
        zz = ragged(seg, zig_amp, rnd) if zig_amp else (lambda th: 0.0)
        zs = list(np.linspace(hem, top - 0.03 * q, n))
        rings = [(hem + 0.07 * q, None), (hem + 0.01, off - 0.014 * q), (hem, off + flare)] + [(z, off) for z in zs[1:]] + [(top, None)]
        fig.add(T.mesh(rings, seg, lambda i, th: zz(th) if i in (1, 2) else 0.0), colour or col, TORSO)

    if v == "shirt":
        hem = P["hip_z"] + 0.04
        lower_piece(hem + 0.07, 0.0, C["trousers"])
        upper_piece(hem, 0.008, 0.012, C["cloth"], 9 if lod == 0 else 5, 0.035)
        if lod == 0:
            for z in (1.06, 1.17, 1.28):
                fig.add(blob(T.point(z, front, 0.011), (0.009, 0.004, 0.009), None, 6, 3), C["button"], TORSO)
            for X in (1, -1):   # collar points
                c = T.point(P["neck_z"] - 0.035, front + X * 0.45, 0.01)
                R = Matrix.Rotation(math.radians(X * 30), 3, "Y") @ Matrix.Rotation(math.radians(-25), 3, "X")
                fig.add(blob(c, (0.03, 0.008, 0.016), R, 6, 4), C["cloth"], TORSO)
        L1 = P["arm"][0]
        arm(fig, B, "L", 1, lod, sleeve=0.62 * L1, cuff="ragged", sleeve_col=C["cloth"])
        arm(fig, B, "R", -1, lod, sleeve=L1 + 0.5 * P["arm"][1], cuff="ragged", sleeve_col=C["cloth"])
        for s, X in SIDES:
            hand(fig, B, s, X, lod)
            leg(fig, B, s, X, lod, C["trousers"], patch=(B.L1[s] + 0.01, 0.4, 0.042) if s == "R" else None, patch_col=C["patch"])
            shoe(fig, B, s, X, lod)
    elif v == "hoodie":
        hem = P["hip_z"] - 0.02
        lower_piece(hem + 0.07, 0.0, C["jeans"])
        upper_piece(hem, 0.022, 0.0, C["cloth"], 8 if lod == 0 else 4,
                    colour=lambda tag: C["band"] if tag[0] in (1, 2) else C["cloth"])
        # The hood, down: a soft roll round the back of the neck, thickest at the back, darker on top
        # (its lining) where it opens.
        nb = B.neck_base
        path, radii = [], []
        nn = 10 if lod == 0 else 6
        for kk in range(nn):
            psi = math.radians(-58 + 296 * kk / (nn - 1))
            back = max(0.0, math.sin(psi))
            rr = P["neck_r"] + 0.045 + 0.012 * back
            path.append(Vector((math.cos(psi) * rr, nb.y + math.sin(psi) * rr + 0.02 * back, nb.z - 0.012 - 0.045 * back)))
            radii.append(0.0 if kk in (0, nn - 1) else 0.024 + 0.026 * back)
        fig.add(sweep(path, radii, 8 if lod == 0 else 5, None, (1.0, 0.8)),
                lambda tag: C["band"] if tag[1] in (0, 1, 7) else C["cloth"], UPPER)
        if lod == 0:
            fig.add(slab(T.point, hem + 0.05, hem + 0.17, front - 0.55, front + 0.55, 0.028, 0.008, 3, 6), C["band"], TORSO)
            for X in (1, -1):
                p0 = T.point(P["neck_z"] - 0.03, front + X * 0.3, 0.032)
                p1 = p0 + Vector((X * 0.004, -0.014, -0.13))
                fig.add(tube(p0, p1, [(0.0, 0.0), (0.002, 0.005), (0.13, 0.005), (0.14, 0.0)], 4), C["string"], UPPER)
        L1, L2, _ = P["arm"]
        for s, X in SIDES:
            arm(fig, B, s, X, lod, sleeve=L1 + L2 - 0.005, cuff="band", sleeve_col=C["cloth"], roll_col=C["band"])
            hand(fig, B, s, X, lod)
            leg(fig, B, s, X, lod, C["jeans"])
            shoe(fig, B, s, X, lod)
    elif v == "overall":
        # One piece from the crotch to the collar; a darker band at the waist.
        wz = P["waist_z"]
        zs = sorted(set([round(z, 4) for z in [B.crotch + 0.012, B.crotch + 0.04] + list(np.linspace(P["hip_z"], top - 0.03, 9 if lod == 0 else 5))]
                        + [wz - 0.02, wz + 0.02]))
        rings = [(B.crotch - 0.01, None)] + [(z, 0.006) for z in zs] + [(top, None)]
        band_i = [i for i, (z, _) in enumerate(rings) if abs(z - (wz - 0.02)) < 1e-3]
        fig.add(T.mesh(rings, seg), lambda tag: C["band"] if tag[0] in band_i else C["cloth"], TORSO)
        if lod == 0:
            for X in (1, -1):   # collar flaps
                c = T.point(P["neck_z"] - 0.04, front + X * 0.5, 0.012)
                R = Matrix.Rotation(math.radians(X * 28), 3, "Y") @ Matrix.Rotation(math.radians(-20), 3, "X")
                fig.add(blob(c, (0.036, 0.009, 0.02), R, 6, 4), C["cloth"], TORSO)
            fig.add(slab(T.point, B.crotch + 0.06, P["neck_z"] - 0.07, front - 0.04, front + 0.04, 0.009, 0.004, 6, 2, 1.0), C["zip"], TORSO)
            fig.add(slab(T.point, P["chest_z"] - 0.04, P["chest_z"] + 0.06, front + 0.28, front + 0.72, 0.01, 0.008, 3, 4), C["pocket"], TORSO)
            fig.add(slab(T.point, P["chest_z"] + 0.01, P["chest_z"] + 0.05, front - 0.72, front - 0.3, 0.009, 0.005, 2, 4, 0.8), C["tag"], TORSO)
        L1 = P["arm"][0]
        for s, X in SIDES:
            arm(fig, B, s, X, lod, sleeve=L1 - 0.02, cuff="roll", sleeve_col=C["cloth"], roll_col=C["roll"])
            hand(fig, B, s, X, lod)
            leg(fig, B, s, X, lod, C["cloth"])
            shoe(fig, B, s, X, lod)
    elif v == "farmer":
        wz = P["waist_z"]
        # The checked shirt, on even rings so the checks come out square.
        ch = (C["check1"], C["check2"], C["check3"])
        check = lambda i, j: ch[(i % 2) + (j % 2)]
        ring = [(wz - 0.06, None)] + [(z, 0.006) for z in np.arange(wz - 0.03, top - 0.03, 0.05 if lod == 0 else 0.1)] + [(top, None)]
        fig.add(T.mesh(ring, seg), (lambda tag: check(*tag)) if lod == 0 else C["check1"], TORSO)
        # Dungarees: trousers up to the waist, a bib in front, a back panel and straps over the shoulders.
        lower_piece(wz + 0.03, 0.012, C["cloth"])
        bib_top = P["chest_z"] + 0.04
        fig.add(slab(T.point, wz - 0.01, bib_top, front - 0.62, front + 0.62, 0.019, 0.008, 3 if lod == 0 else 2, 5 if lod == 0 else 3, 0.7),
                C["cloth"], TORSO)
        fig.add(slab(T.point, wz - 0.01, wz + 0.1, math.pi / 2 - 0.7, math.pi / 2 + 0.7, 0.019, 0.008, 1, 4 if lod == 0 else 2, 0.7), C["cloth"], TORSO)
        for X in (1, -1):
            strap(fig, B, X, 0.1, bib_top - 0.015, wz + 0.09, 0.016, 0.021, C["cloth"], lod, (bib_top + 0.05,) if lod == 0 else (),
                  (P["chest_z"],) if lod == 0 else ())
            if lod == 0:
                c = T.point(bib_top - 0.014, th_for_x(T, bib_top - 0.014, X * 0.1, False), 0.025)
                fig.add(blob(c, (0.011, 0.005, 0.011), None, 6, 3), C["button"], TORSO)
        if lod == 0:
            fig.add(slab(T.point, wz + 0.05, wz + 0.13, front - 0.3, front + 0.3, 0.026, 0.008, 1, 3), C["pocket"], TORSO)
        L1, L2, _ = P["arm"]
        for s, X in SIDES:
            arm(fig, B, s, X, lod, sleeve=L1 + 0.35 * L2, cuff="roll", sleeve_col=C["check1"], roll_col=C["check2"],
                check=check if lod == 0 else None)
            hand(fig, B, s, X, lod)
            leg(fig, B, s, X, lod, C["cloth"])
            shoe(fig, B, s, X, lod)
    elif v == "big":
        hem = P["hip_z"] + 0.06
        lower_piece(hem + 0.12, 0.0, C["trousers"])
        neck_line = 2.13
        # Bare skin round the neck, above the vest's scooped neckline.
        zs = np.linspace(neck_line - 0.16, top - 0.03, 4 if lod == 0 else 3)
        fig.add(T.mesh([(neck_line - 0.18, None)] + [(z, 0.0) for z in zs] + [(top, None)], seg), C["skin"], TORSO)
        # The vest: a sleeveless shirt torn off at the shoulders, a ragged hem over the trousers.
        zz = ragged(seg, 0.07, rnd)
        scoop = lambda th: -0.11 * max(0.0, -math.sin(th)) ** 2 - 0.03 * max(0.0, math.sin(th)) ** 2
        zs = list(np.linspace(hem, neck_line, 9 if lod == 0 else 5))
        vest = ([(hem + 0.1, None), (hem + 0.012, -0.012), (hem, 0.02)] + [(z, 0.014) for z in zs[1:]]
                + [(neck_line - 0.014, -0.006), (neck_line - 0.12, None)])
        nv = len(vest)

        def vz(i, th):
            if i in (1, 2):
                return zz(th)
            if i in (nv - 3, nv - 2):
                return scoop(th)
            if i == nv - 4:
                return scoop(th) * 0.4
            return 0.0
        fig.add(T.mesh(vest, seg, vz), C["cloth"], TORSO)
        # A rope belt.
        nb_ = 16 if lod == 0 else 8
        cs = [T.point(hem + 0.07, 2 * math.pi * kk / nb_, 0.014) for kk in range(nb_)]
        ns = [(T.point(hem + 0.07, 2 * math.pi * kk / nb_, 0.05) - c).normalized() for kk, c in enumerate(cs)]
        fig.add(torus(cs, ns, [UP] * nb_, 0.022, 6 if lod == 0 else 4), C["belt"], TORSO)
        for s, X in SIDES:
            arm(fig, B, s, X, lod)
            hand(fig, B, s, X, lod, fist=True)
            leg(fig, B, s, X, lod, C["trousers"])
            shoe(fig, B, s, X, lod)
    return fig


# ======== Skin weights.
def seg_dist(p, a, b):
    """Distances from the points p (n x 3) to the segment a-b."""
    ab = b - a
    L2 = float(ab @ ab)
    if L2 < 1e-12:
        return np.linalg.norm(p - a, axis=1)
    t = np.clip(((p - a) @ ab) / L2, 0.0, 1.0)
    return np.linalg.norm(p - (a + t[:, None] * ab), axis=1)


def weights(B, fig):
    """A dense (points x bones) weight matrix: each bone a point may follow pulls it by (distance to the
    bone's segment / its thickness) ** -FALLOFF; the four strongest kept, normalised."""
    co = np.array([c[:] for c in fig.co])
    W = np.zeros((len(co), len(NAMES)))
    groups = {}
    for i, a in enumerate(fig.allow):
        groups.setdefault(a, []).append(i)
    for allow, idx in groups.items():
        idx = np.array(idx)
        if len(allow) == 1:
            W[idx, INDEX[allow[0]]] = 1.0
            continue
        pull = np.zeros((len(idx), len(allow)))
        for k, b in enumerate(allow):
            a, c, r = B.field[b]
            d = seg_dist(co[idx], np.array(a[:]), np.array(c[:])) / r
            pull[:, k] = np.maximum(d, 0.05) ** -FALLOFF
        order = np.argsort(-pull, axis=1)
        keep = np.zeros_like(pull, dtype=bool)
        rows = np.arange(len(idx))[:, None]
        keep[rows, order[:, :4]] = True
        pull = np.where(keep, pull, 0.0)
        pull /= pull.sum(axis=1, keepdims=True)
        pull = np.where(pull < 0.01, 0.0, pull)
        pull /= pull.sum(axis=1, keepdims=True)
        if allow[0].startswith("LowerLeg") and len(allow) == 2:
            # A shoe: the shin's pull fades out towards the sole, so a planted sole stays flat on the ground.
            z = co[idx, 2]
            fade = np.clip((z - 0.3 * B.P["ankle_z"]) / (0.6 * B.P["ankle_z"]), 0.0, 1.0)
            pull[:, 0] *= fade * fade * (3 - 2 * fade)
            pull /= pull.sum(axis=1, keepdims=True)
        for k, b in enumerate(allow):
            W[idx, INDEX[b]] = pull[:, k]
    return W


# ======== Blender objects.
def zombie_material():
    m = bpy.data.materials.new("zombie")
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    p.inputs["Roughness"].default_value = 0.8
    p.inputs["Metallic"].default_value = 0.0
    vc = nt.nodes.new("ShaderNodeVertexColor")
    vc.layer_name = "Col"
    nt.links.new(vc.outputs["Color"], p.inputs["Base Color"])
    m.use_backface_culling = True  # exported single-sided
    return m


def make_mesh(name, fig, W, mat, rig_obj):
    me = bpy.data.meshes.new(name)
    me.from_pydata([c[:] for c in fig.co], [], fig.faces)
    me.update()
    ca = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    cols = np.zeros((len(me.loops), 4))
    cols[:, 3] = 1.0
    starts = np.zeros(len(me.polygons), dtype=int)
    counts = np.zeros(len(me.polygons), dtype=int)
    me.polygons.foreach_get("loop_start", starts)
    me.polygons.foreach_get("loop_total", counts)
    for p, (st, n) in enumerate(zip(starts, counts)):
        cols[st:st + n, :3] = fig.col[p]
    ca.data.foreach_set("color_srgb", cols.ravel())
    me.color_attributes.active_color = ca
    me.color_attributes.render_color_index = 0
    me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    me.set_sharp_from_angle(angle=math.radians(72))
    me.materials.append(mat)
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    for b in NAMES:
        g = obj.vertex_groups.new(name=b)
        idx = np.nonzero(W[:, INDEX[b]])[0]
        for i in idx:
            g.add([int(i)], float(W[i, INDEX[b]]), "REPLACE")
    obj.parent = rig_obj
    mod = obj.modifiers.new("Armature", "ARMATURE")
    mod.object = rig_obj
    return obj


def make_rig(B, parent):
    arm = bpy.data.armatures.new(f"zombie_{B.v}_armature")
    obj = bpy.data.objects.new(f"zombie_{B.v}_armature", arm)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = parent
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    for name, par in BONES:
        h, t, z = B.bones[name]
        eb = arm.edit_bones.new(name)
        eb.head, eb.tail = h, t
        eb.align_roll(z)
        eb.use_deform = True
        if par:
            eb.parent = arm.edit_bones[par]
            eb.use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    for pb in obj.pose.bones:
        pb.rotation_mode = "QUATERNION"
    return obj


# ======== Posing: the figure's own little FK/IK, so the clips can be checked against the skin.
class Pose:
    """One frame: rotations (in the figure's own axes, relative to the parent bone), the hips' offset,
    arm aims (directions in the chest's frame), elbow bends, wrist droops, and the ankles' targets with
    the feet's turns (or, for a fall, the legs' own rotations)."""

    def __init__(self):
        self.hips_off = Vector()
        self.hips = Quaternion()
        self.spine = self.chest = self.neck = self.head = Quaternion()
        self.shoulder = {"L": Quaternion(), "R": Quaternion()}
        self.arm = {"L": FWD.copy(), "R": FWD.copy()}
        self.twist = {"L": 0.0, "R": 0.0}
        self.elbow = {"L": 0.0, "R": 0.0}
        self.droop = {"L": 0.0, "R": 0.0}
        self.ankle = {}
        self.foot = {"L": Quaternion(), "R": Quaternion()}
        self.planted = {"L": True, "R": True}
        self.legs_fk = None   # {side: (thigh Q, shin Q, foot Q)} instead of IK
        self.fk_mix = 0.0
        self.k = 0.985
        self.e = {}
        self.follow = 0.0     # how far the arms' aim follows the chest's pitch and roll (0: only its turn)


def solve(B, p):
    """Bone rotations Q (relative, in the figure's axes) and each bone's rest-to-pose transform G."""
    Q, G = {}, {}

    def place(b, q, off=None):
        par = PARENT[b]
        Gp = G[par] if par else Matrix.Identity(4)
        h = B.bones[b][0]
        G[b] = Gp @ Matrix.Translation(h + (off if off is not None else Vector())) @ q.to_matrix().to_4x4() @ Matrix.Translation(-h)
        Q[b] = q

    def D(b):
        return G[b].to_quaternion()

    place("Root", Quaternion())
    place("Hips", p.hips, p.hips_off)
    place("Spine", p.spine)
    place("Chest", p.chest)
    place("Neck", p.neck)
    place("Head", p.head)
    # Arms aim at an elevation in the world, turning with the chest; a fall carries them round with it.
    Dc = D("Chest")
    f = Dc @ FWD
    heading = Quaternion(UP, math.atan2(f.x, -f.y))
    frame = heading.slerp(Dc, p.follow) if p.follow > 0 else heading
    for s, X in SIDES:
        place(f"Shoulder.{s}", p.shoulder[s])
        target = (frame @ p.arm[s]).normalized()
        Wq = Quaternion(target, math.radians(p.twist[s])) @ B.rest_dir[f"UpperArm.{s}"].rotation_difference(target)
        place(f"UpperArm.{s}", D(f"Shoulder.{s}").inverted() @ Wq)
        place(f"LowerArm.{s}", Quaternion(B.elbow_axis[s], math.radians(p.elbow[s])))
        place(f"Hand.{s}", Quaternion(B.elbow_axis[s], math.radians(-p.droop[s])))
    hfwd = (D("Hips") @ FWD)
    hfwd.z = 0
    hfwd.normalize()
    for s, X in SIDES:
        ik = None
        if s in p.ankle:
            H = G["Hips"] @ B.hip[s]
            A = p.ankle[s]
            L1, L2 = B.L1[s], B.L2[s]
            d = A - H
            dist = min(d.length, (L1 + L2) * 0.9999)
            a = d.normalized()
            pdir = hfwd - a * hfwd.dot(a)
            pdir.normalize()
            ca = (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist)
            al = math.acos(max(-1.0, min(1.0, ca)))
            K = H + (a * math.cos(al) + pdir * math.sin(al)) * L1
            Wt = B.rest_dir[f"UpperLeg.{s}"].rotation_difference((K - H).normalized())
            Ws = B.rest_dir[f"LowerLeg.{s}"].rotation_difference((H + a * dist - K).normalized())
            ik = (D("Hips").inverted() @ Wt, Wt.inverted() @ Ws, Ws.inverted() @ p.foot[s])
        if p.legs_fk is not None:
            fk = p.legs_fk[s]
            if ik is None or p.fk_mix >= 1.0:
                ik = fk
            else:
                ik = tuple(a.slerp(b, p.fk_mix) for a, b in zip(ik, fk))
        place(f"UpperLeg.{s}", ik[0])
        place(f"LowerLeg.{s}", ik[1])
        place(f"Foot.{s}", ik[2])
    return Q, G


def skin(G, co, W):
    """The figure's points (n x 3) posed by G as Blender's armature modifier would (linear blend)."""
    M = np.array([np.array(G[b]) for b in NAMES])          # bones x 4 x 4
    ph = np.hstack([co, np.ones((len(co), 1))])
    per = np.einsum("bij,nj->bni", M, ph)[:, :, :3]       # bones x n x 3
    return np.einsum("nb,bni->ni", W, per)


def drop_needed(B, p):
    """How far down (negative) the hips must go so that no planted leg is stretched past p.k of its length."""
    Hm = Matrix.Translation(B.hips_head + p.hips_off) @ p.hips.to_matrix().to_4x4() @ Matrix.Translation(-B.hips_head)
    need = None
    for s, _ in SIDES:
        if not p.planted.get(s) or s not in p.ankle:
            continue
        H = Hm @ B.hip[s]
        A = p.ankle[s]
        reach = B.leg_len * p.k
        hor2 = (H.x - A.x) ** 2 + (H.y - A.y) ** 2
        n = A.z + math.sqrt(max(reach * reach - hor2, 0.0)) - H.z
        need = n if need is None else min(need, n)
    return min(need, 0.0) if need is not None else 0.0


def lower_envelope(raw, passes=40):
    """A smooth curve round a loop that never goes above raw: blur, keep under raw, repeat."""
    sm = np.array(raw, float)
    for _ in range(passes):
        sm = np.minimum(raw, (np.roll(sm, 1) + 2 * sm + np.roll(sm, -1)) / 4)
    return sm


def upper_body(B, p, S, e=None):
    """The posture: torso, head and arms from the variant's style plus the extra angles in e."""
    e = e or {}

    def tri(name):
        base = S.get(name, (0, 0, 0))
        ex = e.get(name, (0, 0, 0))
        return rot(base[0] + ex[0], base[1] + ex[1], base[2] + ex[2])
    p.hips = tri("hips")
    p.spine = tri("spine")
    p.chest = tri("chest")
    p.neck = tri("neck")
    p.head = tri("head")
    shf, shu = S.get("shoulders", (0, 0))
    for s, X in SIDES:
        a = S["arms"][s]
        ex = e.get("arm" + s, (0, 0, 0, 0))
        el, ou, bend, dr = a[0] + ex[0], a[1] + ex[1], a[2] + ex[2], a[3] + ex[3]
        er, orr = math.radians(el), math.radians(ou)
        p.arm[s] = Vector((X * math.sin(orr) * math.cos(er), -math.cos(orr) * math.cos(er), math.sin(er)))
        p.elbow[s] = bend
        p.droop[s] = dr
        sh = e.get("sh" + s, (0, 0))
        p.shoulder[s] = rot(0.0, -X * (shu + sh[1]), -X * (shf + sh[0]))
        p.twist[s] = e.get("tw" + s, 0.0)


def gait(B, G, fast=False):
    """A looping gait: pose(ph) for phase 0..1, with the hips' bob worked out so planted legs never
    stretch. Each foot is planted for duty of the loop, moving back under the body at the walking speed
    (D per loop), then swings forward; the hips sway over the planted foot, the torso lurches, the head
    lolls behind, the arms reach and bob."""
    S = B.P["style"]
    D, T = G["D"], G["T"]
    offs = {"L": 0.0, "R": 0.5}
    duty = dict(zip("LR", G["duty"]))
    lift = dict(zip("LR", G["lift"]))
    toe = dict(zip("LR", G["toe"]))
    width = dict(zip("LR", G["width"]))
    mid = {s: offs[s] + duty[s] / 2 for s in "LR"}
    soles = B.sole
    big = B.big
    sc = B.P["hip_z"] / 0.84

    def feet(p, ph):
        for s, X in SIDES:
            f = (ph - offs[s]) % 1.0
            span = D * duty[s]
            y0 = 0.0
            yaw = Quaternion()
            if f < duty[s]:
                u = f / duty[s]
                y = y0 - span / 2 + span * u
                z, pitch = 0.0, 0.0
                p.planted[s] = True
            else:
                u = (f - duty[s]) / (1 - duty[s])
                e = u * u * u * (u * (u * 6 - 15) + 10)
                y = y0 + span / 2 - span * e
                if toe[s] > 20 and lift[s] < 0.03:   # a dragged foot: toe down all the way
                    pitch = toe[s] * min(1.0, math.sin(math.pi * u) * 2.5)
                elif toe[s] < 0:                     # heavy: toe up for the heel to come down first
                    pitch = 18 * math.sin(math.pi * min(1.0, u * 1.6)) * (1 - u) + toe[s] * smooth((u - 0.5) * 2) * (1 - smooth((u - 0.9) * 10))
                else:
                    pitch = toe[s] * math.sin(math.pi * u) * (1 - u) * 1.6
                z = lift[s] * math.sin(math.pi * u) ** (0.8 if big else 1.0)
                p.planted[s] = False
            fq = Quaternion((1, 0, 0), math.radians(pitch))
            # lift the ankle so no part of the turned foot goes below the ground
            low = min((fq @ c).z for c in soles[s])
            base = min(c.z for c in soles[s])
            z += max(0.0, base - low) + (0.004 if not p.planted[s] else 0.0)
            p.ankle[s] = Vector((X * (B.hip[s].x * X + 0.008 * B.fs + width[s]), y, B.ankle[s].z + z))
            p.foot[s] = fq

    def pose(ph, dz=0.0):
        p = Pose()
        p.k = G["k"]
        cL = math.cos(2 * math.pi * (ph - mid["L"]))
        sL = math.sin(2 * math.pi * (ph - mid["L"]))
        lag = 0.08
        cl = math.cos(2 * math.pi * (ph - mid["L"] - lag))
        c2 = math.cos(4 * math.pi * (ph - offs["L"] - 0.06))
        # The lurch: hurrying, bent well forward, the head bobbing hard and the arms grabbing.
        hurry, bob = (8.0, 2.2) if fast else (0.0, 1.0)
        e = {
            "hips": (hurry * 0.5, G["roll"] * cL, G["yaw"] * cL),
            "spine": (1.5 * bob * c2 + hurry, 0.4 * G["roll"] * cl, -0.4 * G["yaw"] * cL),
            "chest": (2.0 * bob * c2 + hurry, 0.3 * G["roll"] * cl, -0.4 * G["yaw"] * cL),
            "neck": (-2.5 * bob * c2 - hurry * 0.8, -0.5 * G["roll"] * math.cos(2 * math.pi * (ph - mid["L"] - 0.16)), 3 * sL),
            "head": (3.0 * bob * math.cos(4 * math.pi * (ph - offs["L"] - 0.14)) - hurry * 0.8,
                     -0.6 * G["roll"] * math.cos(2 * math.pi * (ph - mid["L"] - 0.2)), 4 * sL if fast else 0.0),
        }
        for s, X in SIDES:
            # Arms forward, bobbing with each step, swinging a little against the legs; frantic in the lurch.
            sw = math.sin(2 * math.pi * (ph - mid[s]))
            if big:
                e["arm" + s] = (26 * sw, 0, 6 * c2 + 8 * sw, 6 * sw)
            elif fast:
                # Grabbing in turn: each arm reaches up and claws down twice a loop, out of step.
                fr = math.sin(2 * math.pi * (2 * ph + (0.0 if s == "L" else 0.4)))
                e["arm" + s] = (8 + 22 * fr + 4 * c2, 6 * math.cos(2 * math.pi * (ph + 0.2 * X)), 18 * max(0.0, -fr) + 4, 22 * fr)
            else:
                e["arm" + s] = (3.5 * c2 + 4 * sw * X * 0.5, 2 * sw, 4 * c2, 5 * c2)
        upper_body(B, p, S, e)
        p.e = e
        p.hips_off = Vector((G["sway"] * cL, 0.0, dz))
        feet(p, ph)
        return p

    # The hips' height: as high as the planted legs allow, smoothed, and for the big one a heavy drop
    # after each footfall.
    n = 120
    raw = [drop_needed(B, pose(k / n)) for k in range(n)]
    env = lower_envelope(raw)
    drop = G.get("drop", 0.0)

    def final(ph):
        dz = float(np.interp(ph * n, np.arange(n + 1), np.append(env, env[0])))
        if drop:
            for s in "LR":
                x = wrap(ph - offs[s] - 0.04)
                dz -= drop * sc * (math.exp(-(x / 0.07) ** 2) if x > -0.02 else math.exp(-(x / 0.02) ** 2))
        return pose(ph, dz)
    return final


def idle(B):
    """A sway on the spot: weight from foot to foot, the head lolling round, arms hanging forward, and a
    twitch of the head once a loop."""
    S = B.P["style"]
    big = B.big
    sc = B.P["hip_z"] / 0.84

    def pose(ph, dz=0.0):
        p = Pose()
        p.k = 0.975
        c = math.cos(2 * math.pi * ph)
        s1 = math.sin(2 * math.pi * ph)
        tw = bump(wrap(ph - 0.62), 0.025)
        br = math.sin(4 * math.pi * ph)
        e = {
            "hips": (0.0, 3.0 * c, 2.0 * s1),
            "spine": (1.0 * br, 1.5 * math.cos(2 * math.pi * (ph - 0.08)), -1.5 * s1),
            "chest": (2.0 * br if big else 1.0 * br, 2.0 * math.cos(2 * math.pi * (ph - 0.12)), -2.0 * s1),
            "neck": (3 * math.sin(2 * math.pi * (ph - 0.2)), -5 * math.cos(2 * math.pi * (ph - 0.2)) + 9 * tw, 4 * s1 - 12 * tw),
            "head": (4 * math.cos(2 * math.pi * (ph - 0.25)), -7 * math.cos(2 * math.pi * (ph - 0.3)) + 16 * tw, 6 * tw),
        }
        for s, X in SIDES:
            sw = math.sin(2 * math.pi * (ph - 0.3 + (0.1 if s == "R" else 0.0)))
            if big:
                e["arm" + s] = (-8 + 4 * sw, 2, 4 + 3 * br, 4)
                e["sh" + s] = (0, 3 * br)
            else:
                e["arm" + s] = (-38 + 5 * sw, 4 + 2 * sw, 4, -6 + 4 * sw)
        upper_body(B, p, S, e)
        p.hips_off = Vector((0.035 * sc * c, 0.0, dz - 0.012 * sc * (1 + math.cos(4 * math.pi * ph)) / 2))
        for s, X in SIDES:
            p.ankle[s] = Vector((X * (B.hip[s].x * X + 0.02 * sc), (-0.06 if s == "L" else 0.07) * sc, B.ankle[s].z))
            p.foot[s] = Quaternion()
            p.planted[s] = True
        return p
    n = 90
    env = lower_envelope([drop_needed(B, pose(k / n)) for k in range(n)])

    def final(ph):
        return pose(ph, float(np.interp(ph * n, np.arange(n + 1), np.append(env, env[0]))))
    return final


def planted_from(B, base):
    """Ankle targets and feet from a pose, to keep them planted through a one-off clip."""
    return {s: base.ankle[s].copy() for s in "LR"}, {s: base.foot[s].copy() for s in "LR"}


def oneshot(B, base_e, tracks, ankles, feet, k=0.985):
    """A one-off clip on planted feet: the posture's angles base_e plus the keyframed extras in tracks
    ({name: [(t, value tuple)]}), the hips kept low enough for both legs."""
    S = B.P["style"]

    def pose(t):
        p = Pose()
        p.k = k
        e = {}
        for name in set(base_e) | set(tracks):
            b = base_e.get(name)
            x = spline(tracks[name], t) if name in tracks else None
            if b is None:
                e[name] = tuple(x)
            elif x is None:
                e[name] = b
            else:
                e[name] = tuple(np.array(b) + np.array(x))
        hips = e.pop("off", (0.0, 0.0, 0.0))
        upper_body(B, p, S, e)
        for s in "LR":
            p.ankle[s], p.foot[s] = ankles[s].copy(), feet[s].copy()
            p.planted[s] = True
        p.hips_off = Vector(hips)
        p.hips_off.z += drop_needed(B, p)
        return p
    return pose


# ======== Clips.
def vec(*a):
    return np.array(a, float)


def looped(B, name, fast=False):
    """A gait clip: its frames (a whole number of key steps, so the last key closes the loop), pose(t)."""
    G = dict(B.P["style"][name])
    n = STEP * int(round(G["T"] * FPS / STEP))
    G["T"] = n / FPS
    f = gait(B, G, fast)
    return f, (n, lambda t: f((t / G["T"]) % 1.0), True, G)


def clips_for(B):
    """{clip: (frames, pose(t in seconds), loop, gait numbers)}."""
    S = B.P["style"]
    sc = B.P["hip_z"] / 0.84
    out = {}
    if B.big:
        st, out["Stomp"] = looped(B, "stomp")
        ref = st(0.0)
    else:
        w, out["Walk"] = looped(B, "walk")
        _, out["Lurch"] = looped(B, "lurch", True)
        ref = w(0.0)
    idl = idle(B)
    out["Idle"] = (90, lambda t, f=idl: f((t / 3.0) % 1.0), True, None)
    ankles, feet = planted_from(B, ref)
    # The walk's phase-0 posture, as the extra angles the one-off clips start from and return to.
    base = {k_: tuple(v_) for k_, v_ in ref.e.items()}
    base["off"] = tuple(ref.hips_off)
    if not B.big:
        att = {
            "off": [(0, vec(0, 0, 0)), (0.3, vec(0, 0.05 * sc, 0.01)), (0.45, vec(0, -0.07 * sc, -0.03)), (0.62, vec(0, -0.05 * sc, -0.02)), (28 / FPS, vec(0, 0, 0))],
            "spine": [(0, vec(0, 0, 0)), (0.3, vec(-6, 0, 4)), (0.45, vec(10, 0, -4)), (0.62, vec(8, 0, -2)), (28 / FPS, vec(0, 0, 0))],
            "chest": [(0, vec(0, 0, 0)), (0.3, vec(-10, 0, 6)), (0.45, vec(16, 0, -6)), (0.62, vec(12, 0, -3)), (28 / FPS, vec(0, 0, 0))],
            "neck": [(0, vec(0, 0, 0)), (0.3, vec(-8, 0, 0)), (0.45, vec(4, 0, 0)), (28 / FPS, vec(0, 0, 0))],
            "head": [(0, vec(0, 0, 0)), (0.3, vec(-10, 4, 0)), (0.45, vec(14, -4, 0)), (0.62, vec(10, 0, 0)), (28 / FPS, vec(0, 0, 0))],
            "armL": [(0, vec(0, 0, 0, 0)), (0.3, vec(58, 24, 50, -30)), (0.44, vec(-12, -14, -10, 30), "hold"), (0.6, vec(-18, -8, 0, 24)), (28 / FPS, vec(0, 0, 0, 0))],
            "armR": [(0, vec(0, 0, 0, 0)), (0.32, vec(62, 22, 54, -30)), (0.46, vec(-10, -16, -12, 30), "hold"), (0.62, vec(-16, -8, 0, 24)), (28 / FPS, vec(0, 0, 0, 0))],
            "shL": [(0, vec(0, 0)), (0.3, vec(-6, 10)), (0.45, vec(10, 0)), (28 / FPS, vec(0, 0))],
            "shR": [(0, vec(0, 0)), (0.32, vec(-6, 10)), (0.47, vec(10, 0)), (28 / FPS, vec(0, 0))],
        }
        out["Attack"] = (28, oneshot(B, base, att, ankles, feet), False, None)
    else:
        T1 = 46 / FPS
        pnd = {
            "off": [(0, vec(0, 0, 0)), (0.5, vec(0, 0.04, 0.02)), (0.62, vec(0, 0.02, 0.0)), (0.78, vec(0, 0.06, -0.42), "hold"),
                    (0.95, vec(0, 0.06, -0.4)), (1.2, vec(0, 0.02, -0.1)), (T1, vec(0, 0, 0))],
            "spine": [(0, vec(0, 0, 0)), (0.5, vec(-12, 0, 0)), (0.78, vec(26, 0, 0), "hold"), (0.95, vec(24, 0, 0)), (T1, vec(0, 0, 0))],
            "chest": [(0, vec(0, 0, 0)), (0.5, vec(-14, 0, 0)), (0.78, vec(26, 0, 0), "hold"), (0.95, vec(24, 0, 0)), (T1, vec(0, 0, 0))],
            "neck": [(0, vec(0, 0, 0)), (0.5, vec(-6, 0, 0)), (0.78, vec(-16, 0, 0)), (T1, vec(0, 0, 0))],
            "head": [(0, vec(0, 0, 0)), (0.5, vec(-16, 0, 0)), (0.78, vec(-14, 0, 0)), (0.9, vec(-4, 0, 0)), (T1, vec(0, 0, 0))],
            "armL": [(0, vec(0, 0, 0, 0)), (0.5, vec(186, 2, 70, 0)), (0.62, vec(178, 0, 50, 0)), (0.78, vec(12, -14, -16, -10), "hold"),
                     (0.95, vec(14, -14, -14, -10)), (T1, vec(0, 0, 0, 0))],
            "armR": [(0, vec(0, 0, 0, 0)), (0.5, vec(182, 2, 72, 0)), (0.62, vec(174, 0, 50, 0)), (0.78, vec(10, -14, -16, -10), "hold"),
                     (0.95, vec(12, -14, -14, -10)), (T1, vec(0, 0, 0, 0))],
            "shL": [(0, vec(0, 0)), (0.5, vec(-4, 14)), (0.78, vec(8, -2)), (T1, vec(0, 0))],
            "shR": [(0, vec(0, 0)), (0.5, vec(-4, 14)), (0.78, vec(8, -2)), (T1, vec(0, 0))],
        }
        # The stomp's arm swing (one arm back, one forward) cancelled while the fists are up and down.
        for side in "LR":
            sw = np.array(base["arm" + side])
            pnd["arm" + side] = [(kk[0], kk[1] - sw * (1.0 if 0.4 <= kk[0] <= 1.0 else 0.0)) + tuple(kk[2:]) for kk in pnd["arm" + side]]
        out["Pound"] = (46, oneshot(B, base, pnd, ankles, feet, k=0.995), False, None)
    fl = {
        "off": [(0, vec(0, 0, 0)), (0.08, vec(0, 0.035 * sc, -0.005)), (0.22, vec(0, -0.008 * sc, 0)), (0.4, vec(0, 0, 0))],
        "spine": [(0, vec(0, 0, 0)), (0.08, vec(-7, 0, -3)), (0.22, vec(2, 0, 1)), (0.4, vec(0, 0, 0))],
        "chest": [(0, vec(0, 0, 0)), (0.08, vec(-14, 3, -5)), (0.22, vec(3, -1, 1)), (0.4, vec(0, 0, 0))],
        "neck": [(0, vec(0, 0, 0)), (0.07, vec(-16, 4, 0)), (0.2, vec(6, -2, 0)), (0.4, vec(0, 0, 0))],
        "head": [(0, vec(0, 0, 0)), (0.09, vec(-14, 10, 6)), (0.24, vec(5, -3, 0)), (0.4, vec(0, 0, 0))],
        "armL": [(0, vec(0, 0, 0, 0)), (0.08, vec(18, 14, 18, -16)), (0.24, vec(-4, -2, -2, 4)), (0.4, vec(0, 0, 0, 0))],
        "armR": [(0, vec(0, 0, 0, 0)), (0.09, vec(22, 12, 20, -18)), (0.25, vec(-4, -2, -2, 4)), (0.4, vec(0, 0, 0, 0))],
        "shL": [(0, vec(0, 0)), (0.08, vec(-4, 8)), (0.4, vec(0, 0))],
        "shR": [(0, vec(0, 0)), (0.08, vec(-4, 8)), (0.4, vec(0, 0))],
    }
    if B.big:
        fl = {k_: [(kk[0], kk[1] * 0.7) + tuple(kk[2:]) for kk in tr] for k_, tr in fl.items()}
    out["Flinch"] = (12, oneshot(B, base, fl, ankles, feet), False, None)
    out["Fall"] = (36, fall(B, base, ref), False, None)
    return out


def fall(B, base, ref):
    """Falls over backwards: knocked back, knees buckle, sits down hard, the back hits the ground, the
    legs kick up and flop down, arms splayed: then lies still. Legs by their own rotations, blended in
    from the walk's planted IK; the hips kept off the ground by checking the skinned mesh (see clips())."""
    S = B.P["style"]
    sc = B.P["hip_z"] / 0.84
    hz = B.P["hip_z"]
    Tn = 36 / FPS
    lie = -(hz - 0.13 * sc)
    tr = {
        "off": [(0, vec(*base["off"])), (0.14, vec(0, 0.05 * sc, base["off"][2] - 0.02)), (0.48, vec(0, 0.22 * sc, -(hz - 0.3 * sc))),
                (0.68, vec(0, 0.34 * sc, lie)), (0.8, vec(0, 0.35 * sc, lie + 0.025 * sc)), (0.92, vec(0, 0.36 * sc, lie)),
                (Tn, vec(0, 0.36 * sc, lie))],
        "hips": [(0, vec(*base["hips"])), (0.14, vec(-10, 0, 0)), (0.48, vec(-38, 4, 6)), (0.68, vec(-88, 6, 8)), (0.8, vec(-84, 5, 8)),
                 (0.92, vec(-90, 4, 8)), (Tn, vec(-90, 4, 8))],
        "spine": [(0, vec(0, 0, 0)), (0.12, vec(-8, 0, 0)), (0.48, vec(-4, 0, 0)), (0.7, vec(0, 0, 0)), (Tn, vec(0, 0, 0))],
        "chest": [(0, vec(0, 0, 0)), (0.12, vec(-12, 4, 0)), (0.48, vec(-6, 0, 0)), (0.7, vec(0, 0, 0)), (Tn, vec(0, 0, 0))],
        "neck": [(0, vec(0, 0, 0)), (0.1, vec(-18, 0, 0)), (0.5, vec(18, 0, 0)), (0.7, vec(-6, 0, 0)), (0.82, vec(6, 0, 18)), (Tn, vec(2, 0, 24))],
        "head": [(0, vec(0, 0, 0)), (0.1, vec(-14, 8, 0)), (0.5, vec(10, 0, 0)), (0.7, vec(-8, 0, 0)), (0.85, vec(2, 10, 14)), (Tn, vec(0, 12, 16))],
        "armL": [(0, vec(0, 0, 0, 0)), (0.12, vec(50, 20, 30, -20)), (0.5, vec(70, 40, 40, -10)), (0.72, vec(20, 75, 20, 0)),
                 (0.9, vec(14, 92, 10, 10)), (Tn, vec(14, 95, 10, 10))],
        "armR": [(0, vec(0, 0, 0, 0)), (0.14, vec(55, 22, 34, -20)), (0.5, vec(66, 44, 44, -10)), (0.74, vec(26, 80, 20, 0)),
                 (0.92, vec(20, 96, 14, 14)), (Tn, vec(20, 98, 14, 14))],
    }
    legs = {
        "L": [(0, vec(0, 0, 0, 0)), (0.14, vec(-6, 2, 14, 0)), (0.48, vec(-62, 8, 90, 10)), (0.7, vec(-82, 12, 60, 24)), (0.86, vec(-24, 12, 30, 20)),
              (0.98, vec(-12, 12, 18, 22)), (Tn, vec(-12, 12, 18, 22))],
        "R": [(0, vec(0, 0, 0, 0)), (0.16, vec(-2, 2, 18, 0)), (0.5, vec(-56, 6, 84, 10)), (0.72, vec(-74, 10, 40, 24)), (0.88, vec(-8, 10, 8, 18)),
              (1.0, vec(-4, 10, 4, 20)), (Tn, vec(-4, 10, 4, 20))],
    }

    def pose(t):
        p = Pose()
        e = {}
        fade = 1.0 - smooth(t / 0.3)   # the walk's own swing at the start, fading out
        for name, keys in tr.items():
            if name in ("off", "hips"):
                continue
            e[name] = tuple(np.array(spline(keys, t)) + np.array(base.get(name, (0.0,) * len(keys[0][1]))) * fade)
        upper_body(B, p, S, e)
        hp = spline(tr["hips"], t)
        p.hips = rot(S["hips"][0] + hp[0], S["hips"][1] + hp[1], S["hips"][2] + hp[2])
        p.hips_off = Vector(spline(tr["off"], t))
        for s, X in SIDES:
            p.ankle[s], p.foot[s] = ref.ankle[s].copy(), ref.foot[s].copy()
            p.planted[s] = False
        fk = {}
        for s, X in SIDES:
            fl_, ab, kn, ft = spline(legs[s], t)
            fk[s] = (rot(fl_, -X * ab, X * 4), rot(kn, 0, 0), rot(-ft, 0, X * 10))
        p.legs_fk = fk
        p.fk_mix = smooth(t / 0.3)
        p.follow = smooth(t / 0.35)
        return p
    return pose


# ======== The figures.
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)
scene = bpy.context.scene
scene.render.fps = FPS
bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
MAT = zombie_material()
FIG = {}
REPORT = {}
for v in ORDER:
    B = Body(v, VARIANTS[v])
    figs = [build(B, 0), build(B, 1)]
    Ws = [weights(B, f) for f in figs]
    top = bpy.data.objects.new(f"zombie_{v}", None)
    scene.collection.objects.link(top)
    rig = make_rig(B, top)
    meshes = [make_mesh(f"zombie_{v}__lod0", figs[0], Ws[0], MAT, rig), make_mesh(f"zombie_{v}_lod1", figs[1], Ws[1], MAT, rig)]
    rest_q = {b: rig.data.bones[b].matrix_local.to_quaternion() for b in NAMES}
    co0 = np.array([c[:] for c in figs[0].co])
    hand_pts = {s: np.nonzero(Ws[0][:, INDEX[f"Hand.{s}"]] > 0.5)[0] for s, _ in SIDES}
    foot_pts = np.nonzero((Ws[0][:, INDEX["Foot.L"]] + Ws[0][:, INDEX["Foot.R"]]) > 0.5)[0]
    # The shoes' undersides, relative to the ankles: what must stay above the ground when a foot turns.
    B.sole = {}
    for s_, _ in SIDES:
        pts = co0[np.nonzero(Ws[0][:, INDEX[f"Foot.{s_}"]] > 0.5)[0]]
        pts = pts[pts[:, 2] < 0.012 * B.fs + 0.002]
        B.sole[s_] = [Vector(c) - B.ankle[s_] for c in pts]
    rig.animation_data_create()
    info = {"height": float(co0[:, 2].max()), "tris": (figs[0].tris(), figs[1].tris()), "clips": {}}
    for clip, (nframes, posef, loop, gaitp) in clips_for(B).items():
        name = f"{v}_{clip}"
        act = bpy.data.actions.new(name)
        rig.animation_data.action = act
        prev = {}
        minz_all, hand_low, hand_fwd, foot_low, planted = [], [], [], [], []
        for f in range(0, nframes + 1, STEP):
            t = f / FPS
            p = posef(t)
            Q, Gm = solve(B, p)
            if clip in ("Fall",):
                # Keep the body on (and, once it has landed, lying on) the ground: the skinned mesh's lowest point.
                pos = skin(Gm, co0, Ws[0])
                low = float(pos[:, 2].min())
                lift = -low if (t >= 0.9 or low < 0) else 0.0
                if t >= 0.9:
                    lift = 0.002 - low
                if abs(lift) > 1e-5:
                    p.hips_off.z += lift
                    for s_ in p.ankle:
                        p.ankle[s_].z += lift
                    Q, Gm = solve(B, p)
            if clip == "Pound":
                pos = skin(Gm, co0, Ws[0])
                low = min(float(pos[hand_pts[s], 2].min()) for s in "LR")
                if 0.74 <= t <= 0.96 and low > 0.0:
                    # Fists on the ground through the hit: crouch the rest of the way.
                    p.hips_off.z -= low
                    Q, Gm = solve(B, p)
                elif low < 0.0:
                    p.hips_off.z -= low
                    Q, Gm = solve(B, p)
            pos = skin(Gm, co0, Ws[0])
            planted.append(dict(p.planted))
            minz_all.append(float(pos[:, 2].min()))
            foot_low.append(float(pos[foot_pts, 2].min()))
            hand_low.append(min(float(pos[hand_pts[s], 2].min()) for s in "LR"))
            hand_fwd.append(max(float(-pos[hand_pts[s], 1].min()) for s in "LR"))
            for b in NAMES:
                pb = rig.pose.bones[b]
                q = rest_q[b].inverted() @ Q[b] @ rest_q[b]
                if b in prev and prev[b].dot(q) < 0:
                    q.negate()
                prev[b] = q.copy()
                pb.rotation_quaternion = q
                pb.keyframe_insert("rotation_quaternion", frame=f, group=b)
                if b in ("Root", "Hips"):
                    pb.location = rest_q[b].inverted() @ (p.hips_off if b == "Hips" else Vector())
                    pb.keyframe_insert("location", frame=f, group=b)
        track = rig.animation_data.nla_tracks.new()
        track.name = name
        track.strips.new(name, 0, act)
        rig.animation_data.action = None
        frames = list(range(0, nframes + 1, STEP))
        ci = {"frames": nframes, "seconds": nframes / FPS, "min_z": min(minz_all), "foot_min_z": min(foot_low)}
        if gaitp:
            ci["loop_distance"] = gaitp["D"]
            ci["speed"] = gaitp["D"] / gaitp["T"]
            ci["planted"] = planted
        if clip == "Attack":
            k = int(np.argmax(hand_fwd))
            ci["hit"] = frames[k] / FPS
            ci["reach"] = hand_fwd[k]
        if clip == "Pound":
            k = next((i for i, z in enumerate(hand_low) if z < 0.005), int(np.argmin(hand_low)))
            ci["hit"] = frames[k] / FPS
            ci["fist_low"] = hand_low
        info["clips"][clip] = ci
    REPORT[v] = info
    FIG[v] = (top, rig, meshes, B)
    print(f"zombie {v}: {info['height']:.3f} m, LOD0 {info['tris'][0]} triangles, LOD1 {info['tris'][1]}")

# ---- Check the loops with Blender's own evaluation: a planted foot must move back at exactly the
# walking speed (loop distance / loop time); report how far it strays from that (its slide).
for v in ORDER:
    top, rig, meshes, B = FIG[v]
    for clip in (("Stomp",) if v == "big" else ("Walk", "Lurch")):
        rig.animation_data.action = bpy.data.actions[f"{v}_{clip}"]
        ci = REPORT[v]["clips"][clip]
        n = ci["frames"]
        speed = ci["speed"]
        worst, runs = 0.0, []
        for s in "LR":
            run = []
            for k, f in enumerate(range(0, n + 1, STEP)):
                scene.frame_set(f)
                h = rig.pose.bones[f"Foot.{s}"].head
                if ci["planted"][k][s]:
                    run.append((f / FPS, h.y, h.x))
                elif run:
                    runs.append(run)
                    run = []
            if run:
                runs.append(run)
        speeds = []
        for run in runs:
            if len(run) < 2:
                continue
            rel = [y - speed * t for t, y, _ in run]
            worst = max(worst, max(rel) - min(rel), max(x for *_, x in run) - min(x for *_, x in run))
            speeds.append((run[-1][1] - run[0][1]) / (run[-1][0] - run[0][0]))
        ci["measured_speed"] = float(np.mean(speeds))
        ci["measured_loop"] = ci["measured_speed"] * n / FPS
        ci["slide"] = worst
        del ci["planted"]
        rig.animation_data.action = None

# ======== Export.
bpy.ops.object.select_all(action="DESELECT")
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format="GLB", use_selection=False, export_yup=True, export_apply=False,
    export_texcoords=False, export_normals=True, export_tangents=False, export_materials="EXPORT",
    export_vertex_color="ACTIVE", export_all_vertex_colors=False, export_attributes=False,
    export_cameras=False, export_lights=False, export_extras=False,
    export_skins=True, export_influence_nb=4, export_all_influences=False, export_def_bones=False,
    export_morph=False, export_animations=True, export_animation_mode="ACTIONS", export_nla_strips=True,
    export_force_sampling=True, export_frame_step=STEP, export_optimize_animation_size=True,
    export_optimize_animation_keep_anim_armature=True, export_anim_slide_to_zero=True,
    export_reset_pose_bones=True, export_rest_position_armature=True, export_anim_single_armature=False,
    export_merge_animation="ACTION", export_bake_animation=False, export_leaf_bone=False,
    export_armature_object_remove=False, export_hierarchy_flatten_bones=False)


def read_glb(path):
    data = open(path, "rb").read()
    jl = struct.unpack("<I", data[12:16])[0]
    j = json.loads(data[20:20 + jl])
    bin_ = data[20 + jl + 8:]
    return j, bin_


def write_glb(path, j, bin_):
    js = json.dumps(j, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    bin_ += b"\0" * (-len(bin_) % 4)
    total = 12 + 8 + len(js) + 8 + len(bin_)
    with open(path, "wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, total))
        fh.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        fh.write(struct.pack("<II", len(bin_), 0x004E4942) + bin_)


COMP = {5126: np.float32, 5123: np.uint16, 5121: np.uint8, 5125: np.uint32}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def raw(j, bin_, i):
    """An accessor's elements, tightly packed, as an (count x components) array of its own type."""
    a = j["accessors"][i]
    bv = j["bufferViews"][a["bufferView"]]
    comp, n = COMP[a["componentType"]], NCOMP[a["type"]]
    item = np.dtype(comp).itemsize * n
    stride = bv.get("byteStride", item)
    base = np.frombuffer(bin_, np.uint8, (a["count"] - 1) * stride + item, bv.get("byteOffset", 0) + a.get("byteOffset", 0))
    rows = np.lib.stride_tricks.as_strided(base, (a["count"], item), (stride, 1))
    return np.frombuffer(rows.tobytes(), comp).reshape(a["count"], n)


def accessor(j, bin_, i):
    """An accessor's values (normalised integers as 0..1)."""
    a = j["accessors"][i]
    arr = raw(j, bin_, i)
    return arr / np.iinfo(arr.dtype).max if a.get("normalized") else arr


def repack(j, bin_):
    """Rewrite the GLB's binary: one tightly packed view per distinct accessor (identical ones, such as
    the key times all of an animation's channels share, stored once); skin weights and vertex colours as
    normalised bytes (8 bits is plenty for flat face colours, and weights are kept summing to exactly 1);
    and animation channels that never leave a bone's rest translation or scale dropped (every clip still
    turns every bone, and moves the hips). Halves the file."""
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
        remap = {o: k for k, o in enumerate(used)}
        a["samplers"] = [a["samplers"][o] for o in used]
        for ch in keep:
            ch["sampler"] = remap[ch["sampler"]]
        a["channels"] = keep
    accs, views, blob, seen = [], [], bytearray(), {}

    def store(i, arr=None, comp=None, normalized=None, target=None):
        meta = {k: v for k, v in j["accessors"][i].items() if k not in ("bufferView", "byteOffset")}
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
                elif name.startswith("COLOR_"):
                    c = accessor(j, bin_, i)
                    at[name] = store(i, np.floor(c * 255 + 0.5).astype(np.uint8), 5121, True, 34962)
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


# Blender can't give two objects one name: the LOD0 meshes were zombie_<v>__lod0; in the GLB they are
# zombie_<v>, like the node holding them (three.js's loader makes the second one zombie_<v>_1).
size_raw = os.path.getsize(OUT)
j, bin_ = read_glb(OUT)
for nd in j["nodes"]:
    if nd.get("name", "").endswith("__lod0"):
        nd["name"] = nd["name"][:-6]
for m in j["meshes"]:
    if m.get("name", "").endswith("__lod0"):
        m["name"] = m["name"][:-6]
j, bin_ = repack(j, bin_)
write_glb(OUT, j, bin_)


# ---- Check what went into the GLB.
j, bin_ = read_glb(OUT)
names = [nd.get("name") for nd in j["nodes"]]
children = {i: nd.get("children", []) for i, nd in enumerate(j["nodes"])}
roots = j["scenes"][0]["nodes"]
print("GLB top-level nodes:", [names[i] for i in roots])
for i in roots:
    v = names[i][len("zombie_"):]
    under = [names[c] for c in children[i]]
    rig_i = children[i][0]
    print(f"  {names[i]} > {under} > {[names[c] for c in children[rig_i]]}")
for si, sk in enumerate(j["skins"]):
    print(f"skin {si}: {len(sk['joints'])} joints:", [names[k] for k in sk["joints"]])
for m in j["meshes"]:
    for pr in m["primitives"]:
        idx = j["accessors"][pr["indices"]]["count"]
        wts = accessor(j, bin_, pr["attributes"]["WEIGHTS_0"])
        col = j["accessors"][pr["attributes"]["COLOR_0"]]
        sums = wts.sum(axis=1)
        assert (np.count_nonzero(wts, axis=1) <= 4).all() and abs(sums - 1).max() < 1e-6
        print(f"  mesh {m['name']}: {idx // 3} triangles, {j['accessors'][pr['attributes']['POSITION']]['count']} vertices, "
              f"weights sum {sums.min():.4f}..{sums.max():.4f}, COLOR_0 {col['componentType']} normalized={col.get('normalized', False)}")
anim_info = {}
for a in j["animations"]:
    tgt = {j["nodes"][c["target"]["node"]]["name"] for c in a["channels"]}
    dur = max(j["accessors"][s["input"]]["max"][0] for s in a["samplers"])
    anim_info[a["name"]] = (dur, len(a["channels"]), len(tgt))
    print(f"  animation {a['name']}: {dur:.3f} s, {len(a['channels'])} channels on {len(tgt)} bones")
size = os.path.getsize(OUT)
print(f"zombies.glb: {size / 1024:.0f} KB (as exported {size_raw / 1024:.0f} KB)")
for v in ORDER:
    info = REPORT[v]
    print(f"{v}: height {info['height']:.3f} m, LOD0 {info['tris'][0]}, LOD1 {info['tris'][1]} triangles")
    for clip, ci in info["clips"].items():
        extra = ""
        if "loop_distance" in ci:
            extra += f", loop {ci['loop_distance']:.3f} m (measured {ci['measured_loop']:.3f}, planted feet slide {ci['slide'] * 1000:.1f} mm), {ci['speed']:.3f} m/s"
        if "hit" in ci:
            extra += f", hit at {ci['hit']:.3f} s"
        print(f"   {clip}: {ci['seconds']:.3f} s ({ci['frames']} frames){extra}, lowest point {ci['min_z']:+.3f} m, feet {ci['foot_min_z']:+.3f} m")


# ======== Preview renders (Eevee, a neutral studio): each figure front and three-quarter, a lineup
# with a 1.8 m pole, contact sheets of the walks, the stomp and the pound, Attack and Fall, the LODs and
# the lineup from 20 m.
if PREVIEW:
    os.makedirs(PREVIEW, exist_ok=True)
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = 32
    scene.view_settings.view_transform = "ACES 1.3"  # the game renders with ACES filmic tone mapping
    scene.view_settings.exposure = -0.6
    scene.render.film_transparent = False
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
        return o
    light("AREA", (-2.5, -3.5, 3.6), 650, 3.5)
    light("AREA", (3.0, -2.0, 2.0), 200, 3.0)
    light("AREA", (0.5, 3.5, 3.0), 300, 2.5)
    light("SUN", (0, 0, 10), 1.2, 6, (0.4, 0.6, 0))
    floor_mat = bpy.data.materials.new("Floor")
    floor_mat.use_nodes = True
    fp = floor_mat.node_tree.nodes["Principled BSDF"]
    fp.inputs["Base Color"].default_value = (0.34, 0.35, 0.34, 1)
    fp.inputs["Roughness"].default_value = 0.95
    bpy.ops.mesh.primitive_plane_add(size=80)
    bpy.context.active_object.data.materials.append(floor_mat)
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    for v in ORDER:
        rig = FIG[v][1]
        for tr in rig.animation_data.nla_tracks:
            tr.mute = True

    def show(only=None, lod=0, x=None):
        """Show only these variants (all if None), at LOD lod, side by side at x positions."""
        for i, v in enumerate(ORDER):
            top, rig, meshes, B = FIG[v]
            vis = only is None or v in only
            meshes[0].hide_render = not (vis and lod == 0)
            meshes[1].hide_render = not (vis and lod == 1)
            top.location = (x[v] if x and v in x else 0.0, 0.0, 0.0)

    def pose(v, clip, t):
        rig = FIG[v][1]
        rig.animation_data.action = bpy.data.actions[f"{v}_{clip}"] if clip else None
        if not clip:
            for pb in rig.pose.bones:
                pb.rotation_quaternion = (1, 0, 0, 0)
                pb.location = (0, 0, 0)
        return int(round(t * FPS))

    def shot(path, loc, target, lens, res=(900, 1100), frame=0):
        scene.frame_set(frame)
        scene.render.resolution_x, scene.render.resolution_y = res
        cam.location = loc
        cam.data.lens = lens
        cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        return path

    def sheet(paths, cols, out):
        """Tile renders into one image, left to right, top to bottom."""
        ims = []
        for pth in paths:
            im = bpy.data.images.load(pth)
            w, h = im.size
            ims.append(np.array(im.pixels[:]).reshape(h, w, 4))
            bpy.data.images.remove(im)
        h, w = ims[0].shape[:2]
        rows = (len(ims) + cols - 1) // cols
        canvas = np.ones((rows * h, cols * w, 4))
        for k, a in enumerate(ims):
            r, c = divmod(k, cols)
            canvas[(rows - 1 - r) * h:(rows - r) * h, c * w:(c + 1) * w] = a
        img = bpy.data.images.new("sheet", cols * w, rows * h, alpha=True)
        img.pixels = canvas.ravel()
        img.filepath_raw = out
        img.file_format = "PNG"
        img.save()
        bpy.data.images.remove(img)
        for pth in paths:
            os.remove(pth)

    tmp = os.path.join(PREVIEW, "_tmp")
    os.makedirs(tmp, exist_ok=True)
    # Each figure on its own: front in its idle sway, three-quarter mid-walk.
    for v in ORDER:
        B = FIG[v][3]
        H = REPORT[v]["height"]
        show([v])
        walk = "Stomp" if v == "big" else "Walk"
        f = pose(v, "Idle", 0.9)
        k = H / 1.8
        shot(os.path.join(PREVIEW, f"{v}_front.png"), (0, -4.6 * k, 0.95 * k), (0, 0, 0.88 * k), 50, frame=f)
        f = pose(v, walk, REPORT[v]["clips"][walk]["seconds"] * 0.18)
        shot(os.path.join(PREVIEW, f"{v}_34.png"), (2.9 * k, -3.6 * k, 1.35 * k), (0, 0, 0.9 * k), 50, frame=f)
        pose(v, None, 0)
        hc = B.hd.c
        shot(os.path.join(PREVIEW, f"{v}_face.png"), (0.22 * k, hc.y - 0.9 * k, hc.z + 0.03), (0, hc.y, hc.z - 0.01), 70, (800, 800), frame=0)
    # The lineup, with a 1.8 m pole marked every half metre.
    xs = {"shirt": -2.4, "hoodie": -1.2, "overall": 0.0, "farmer": 1.2, "big": 2.85}
    pole = []
    for i in range(4):
        z0, z1 = i * 0.5, min(1.8, (i + 1) * 0.5)
        bpy.ops.mesh.primitive_cylinder_add(radius=0.025, depth=z1 - z0, location=(4.3, 0.2, (z0 + z1) / 2))
        o = bpy.context.active_object
        m = bpy.data.materials.new(f"pole{i}")
        m.use_nodes = True
        m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.8, 0.8, 0.78, 1) if i % 2 == 0 else (0.15, 0.15, 0.15, 1)
        o.data.materials.append(m)
        pole.append(o)
    show(None, 0, xs)
    for v in ORDER:
        pose(v, "Idle", 0.9)
    shot(os.path.join(PREVIEW, "lineup.png"), (0.9, -9.5, 1.6), (0.9, 0, 1.15), 40, (1800, 1000), frame=int(0.9 * FPS))
    for v in ORDER:
        pose(v, "Stomp" if v == "big" else "Walk", 0.3)
    shot(os.path.join(PREVIEW, "lineup_walk34.png"), (5.0, -8.5, 2.2), (0.6, 0, 1.0), 40, (1800, 1000), frame=int(0.3 * FPS))
    show(None, 1, xs)
    for v in ORDER:
        pose(v, "Idle", 0.9)
    shot(os.path.join(PREVIEW, "lineup_lod1.png"), (0.9, -9.5, 1.6), (0.9, 0, 1.15), 40, (1800, 1000), frame=int(0.9 * FPS))
    # From 20 m with the game's 72 degree vertical field of view (centre crop).
    show(None, 0, xs)
    cam.data.sensor_fit = "VERTICAL"
    cam.data.angle = math.radians(72)
    scene.render.resolution_x, scene.render.resolution_y = 1920, 1080
    cam.location = (3.0, -19.8, 1.65)
    cam.rotation_euler = (Vector((0.4, 0, 1.0)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.use_border, scene.render.use_crop_to_border = True, True
    scene.render.border_min_x, scene.render.border_max_x = 0.38, 0.62
    scene.render.border_min_y, scene.render.border_max_y = 0.34, 0.62
    scene.frame_set(int(0.3 * FPS))
    scene.render.filepath = os.path.join(PREVIEW, "lineup_20m.png")
    bpy.ops.render.render(write_still=True)
    scene.render.use_border = scene.render.use_crop_to_border = False
    cam.data.sensor_fit = "AUTO"
    for o in pole:
        o.hide_render = True
    # Contact sheets: six frames of each regular walk (side on), the big one's stomp and pound.
    paths = []
    for v in ORDER[:4]:
        show([v])
        T = REPORT[v]["clips"]["Walk"]["seconds"]
        for k in range(6):
            f = pose(v, "Walk", T * k / 6)
            paths.append(shot(os.path.join(tmp, f"w{v}{k}.png"), (4.2, -1.2, 1.0), (0, -0.05, 0.85), 50, (420, 520), f))
    sheet(paths, 6, os.path.join(PREVIEW, "sheet_walk.png"))
    paths = []
    for v in ORDER[:4]:
        show([v])
        T = REPORT[v]["clips"]["Lurch"]["seconds"]
        for k in range(6):
            f = pose(v, "Lurch", T * k / 6)
            paths.append(shot(os.path.join(tmp, f"l{v}{k}.png"), (4.2, -1.2, 1.0), (0, -0.05, 0.85), 50, (420, 520), f))
    sheet(paths, 6, os.path.join(PREVIEW, "sheet_lurch.png"))
    paths = []
    show(["big"])
    for clip in ("Stomp", "Pound"):
        T = REPORT["big"]["clips"][clip]["seconds"]
        for k in range(6):
            t = T * k / 6 if clip == "Stomp" else (0.0, 0.3, 0.5, REPORT["big"]["clips"]["Pound"]["hit"], 1.0, 1.25)[k]
            f = pose("big", clip, t)
            paths.append(shot(os.path.join(tmp, f"b{clip}{k}.png"), (5.2, -3.4, 1.7), (0, -0.2, 1.2), 45, (480, 560), f))
    sheet(paths, 6, os.path.join(PREVIEW, "sheet_big.png"))
    # Attack at the moment the hands hit, and the end of the fall, for each figure.
    paths = []
    for v in ORDER[:4]:
        show([v])
        f = pose(v, "Attack", REPORT[v]["clips"]["Attack"]["hit"])
        paths.append(shot(os.path.join(tmp, f"a{v}.png"), (2.6, -2.6, 1.3), (0, -0.2, 1.0), 45, (600, 700), f))
        f = pose(v, "Attack", 0.28)
        paths.append(shot(os.path.join(tmp, f"a0{v}.png"), (2.6, -2.6, 1.3), (0, -0.2, 1.0), 45, (600, 700), f))
    sheet(paths, 4, os.path.join(PREVIEW, "attack.png"))
    paths = []
    for v in ORDER:
        show([v])
        k = REPORT[v]["height"] / 1.8
        f = pose(v, "Fall", 1.2)
        paths.append(shot(os.path.join(tmp, f"f{v}.png"), (2.6 * k, -2.4 * k, 1.6 * k), (0, 0.5 * k, 0.1), 45, (600, 500), f))
    for v in ORDER[:2]:
        show([v])
        f = pose(v, "Fall", 0.5)
        paths.append(shot(os.path.join(tmp, f"fm{v}.png"), (2.6, -2.4, 1.6), (0, 0.4, 0.5), 45, (600, 500), f))
    sheet(paths, 4, os.path.join(PREVIEW, "fall.png"))
    # The joints at their hardest: shoulders overhead (the attack's wind-up), knees and hips folded
    # (sitting down hard in the fall), the big one's arms overhead and its crouch at the hit.
    paths = []
    for v, clip, t, loc, target in (("shirt", "Attack", 0.3, (1.5, -1.3, 1.6), (0, -0.05, 1.35)),
                                    ("farmer", "Attack", 0.3, (-1.4, -1.4, 1.5), (0, -0.05, 1.25)),
                                    ("hoodie", "Fall", 0.5, (1.6, -1.4, 0.7), (0, 0.15, 0.45)),
                                    ("overall", "Fall", 0.5, (-1.5, -1.5, 0.7), (0, 0.15, 0.4)),
                                    ("big", "Pound", 0.5, (2.6, -2.4, 2.4), (0, -0.1, 2.0)),
                                    ("big", "Pound", REPORT["big"]["clips"]["Pound"]["hit"], (2.6, -2.6, 1.6), (0, -0.4, 0.8))):
        show([v])
        f = pose(v, clip, t)
        paths.append(shot(os.path.join(tmp, f"j{v}{clip}{t}.png"), loc, target, 45, (600, 600), f))
    sheet(paths, 3, os.path.join(PREVIEW, "joints.png"))
    os.rmdir(tmp)
    print("previews in", PREVIEW)
