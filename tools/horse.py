"""Build a saddled riding horse for the meadow in Blender: a generic warmblood type, standing square.

Run (Blender 5, no window):
  blender -b -P tools/horse.py -- <out.glb> [preview_dir]

Our own model, not any breed's or character's. It follows the usual conformation rules, checked
against side, three-quarter and head-on photos of riding horses (used only to compare). It stands
1.65 m at the withers and about the same at the croup. The body is as long as the horse is high
(1.68 m from the point of the shoulder to the point of the buttock). The chest is as deep as the legs
are long (the girth at 0.87 m). The head is 0.64 m long and the neck about one and a half heads,
set high: the poll at 2.0 m, the face 57 degrees below horizontal. The knees bend at 0.49 m, the hocks
at 0.56 m (the point of the hock at 0.58 m), the fetlocks sit at 0.19 m and the hooves are 15 cm long.
Nose to tail it is 2.5 m. About 8,900 triangles.

Every part is lofted through sections along the side view (the body between its topline and underline,
the neck between crest and throat, the head in its own frame between face and jaw, the legs between
their front and back edges), with smooth bumps on the width for the muscles: shoulder, chest, flank,
hip and quarters, the crest, the jowl, cheekbone and the rim round the eye. The mane is a band along
the crest with broad locks falling to the right; the forelock and the end of the tail are locks too.
Bay markings: a blaze, four white socks with a tuft behind each fetlock. The tack (pad, saddle with
knee rolls, girth, leathers and irons, a snaffle bridle with reins) is laid on the body's surface.

Output: one GLB, a mesh per moving part, nested so the game can animate it by rotating them:
  Body                      origin on the ground under the middle of the body
    Neck (and the mane)     origin at the base of the neck inside the shoulders (0.54 m ahead, 1.2 m up)
      Head (and bridle)     origin at the poll joint, under the ears
        Ear_L, Ear_R        origin at the base of each ear
        Reins               origin at the bit, between its rings
    Tail                    origin at the tail root
    Leg_FL, Leg_FR          origin at the shoulder joint above the forearm; the forearm down to the knee
      Shin_FL, Shin_FR      origin in the knee: knee, cannon, fetlock, pastern, hoof
    Leg_BL, Leg_BR          origin at the hip joint; the thigh and gaskin down to the hock
      Shin_BL, Shin_BR      origin in the hock: hock, cannon, fetlock, pastern, hoof
    Tack                    origin at the deepest point of the seat, where the rider sits
L is the horse's left (+x). The horse faces +z in the GLB (Blender -Y) and stands on y = 0, in metres.
Joints are rounded on both pieces, so they stay closed as they bend.

Turning (three.js rotation, radians; degrees here), all about x unless said:
  Neck, Head    + lowers them. To graze: Neck +90, Head -62 (back up), and the muzzle reaches the grass
                with the face near upright. The neck alone at +55 leaves the muzzle 0.58 m up.
  Leg_*         + swings the leg back (the hoof towards -z), - forward.
  Shin_F*       + folds the knee (the lower leg back).  Shin_B*  - folds the hock (the lower leg forward).
  Ear_*         + tips the ear forward, - lays it back; about z it leans out (Ear_L -z, Ear_R +z); about
                y it turns the opening (Ear_L +y outward, Ear_R -y).
  Tail          + lifts it away from the buttocks; about z it swishes (+z to the left).
  Reins         one rigid piece from the bit to the crest: turn it by minus the Head's angle to keep it
                back along the neck. They can't follow the head down to graze, so hide them then.

Materials: Coat (bay; the game tints it per horse), Dark (mane, tail, lower legs, hooves, muzzle, ear
tips), Eye (eyes and nostrils, a little glossy), Marking (the blaze on the head and the socks on the
shins, white; painted in the coat colour for a horse without them), Leather, Pad and Metal (the irons,
bit and its rings). No textures. With preview_dir it also renders the horse from the side, front and
rear three-quarter, its head, grazing, at a trot (and its folded joints up close), at a gallop, the
view from the saddle and three horses in different coats.
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
PREVIEW = argv[1] if len(argv) > 1 else ""

TAU = 2 * math.pi
MID = 0.04                          # the body's middle (u), where the origin goes
HEAD_T, HEAD_ANGLE = (1.215, 2.0), math.radians(57)  # top of the poll; the face line below horizontal
HEAD_SCALE = 1.04                   # the head's sections below are for a 0.62 m head
NECK_PIVOT = (0.58, 1.20)
FRONT_PIVOT, HIND_PIVOT = (0.57, 1.18), (-0.53, 1.28)
KNEE, HOCK = (0.524, 0.485), (-0.705, 0.555)
TAIL_ROOT = (-0.745, 1.50)
SMOOTH = 55                         # degrees: sharper edges than this are kept (hoof soles, straps)


def curve(points):
    """Smooth curve through (u, value) points without overshoot (monotone cubic)."""
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    n = len(points)
    d = [(ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) for i in range(n - 1)]
    m = [d[0]] + [0.0 if d[i - 1] * d[i] <= 0 else (d[i - 1] + d[i]) / 2 for i in range(1, n - 1)] + [d[-1]]

    def f(u):
        if u <= xs[0]:
            return ys[0]
        if u >= xs[-1]:
            return ys[-1]
        i = max(k for k in range(n - 1) if xs[k] <= u)
        h = xs[i + 1] - xs[i]
        t = (u - xs[i]) / h
        h00, h10, h01, h11 = 2 * t**3 - 3 * t**2 + 1, t**3 - 2 * t**2 + t, -2 * t**3 + 3 * t**2, t**3 - t**2
        return h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1]

    return f


def spline_at(keys, s):
    """The point at s (0..1) on a Catmull-Rom spline through the keys (tuples of numbers)."""
    n = len(keys) - 1
    x = min(max(s, 0.0), 1.0) * n
    i = min(int(x), n - 1)
    t = x - i
    p0, p1, p2, p3 = keys[max(i - 1, 0)], keys[i], keys[i + 1], keys[min(i + 2, n)]
    return tuple(0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t ** 3)
                 for a, b, c, d in zip(p0, p1, p2, p3))


def material(name, color, rough=0.8, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    m.use_backface_culling = True  # exported single-sided
    return m


def srgb(h):
    """'#rrggbb' to linear RGB, as the Principled BSDF (and glTF) expect."""
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def sgnpow(v, p):
    return math.copysign(abs(v) ** p, v)


def P(u, z, x=0.0):
    """Side-view point (u forward, z up, x to the horse's left) in Blender coordinates: the horse faces -Y."""
    return Vector((x, MID - u, z))


def H(a, b):
    """A point of the head in the side view: a along the face from the top of the poll, b out of the face."""
    d = Vector((math.cos(HEAD_ANGLE), -math.sin(HEAD_ANGLE)))
    n = Vector((math.sin(HEAD_ANGLE), math.cos(HEAD_ANGLE)))
    p = Vector(HEAD_T) + (d * a + n * b) * HEAD_SCALE
    return (p.x, p.y)


def bumps(x, y, features):
    """1 plus smooth bumps at (x, y), each ("blob", x0, y0, sx, sy, amount) or a blob drawn out along a line,
    ("ridge", x0, y0, x1, y1, sx, sy, amount). Used to swell or hollow a section's width locally."""
    k = 1.0
    for f in features:
        if f[0] == "blob":
            _, x0, y0, sx, sy, amp = f
            d2 = ((x - x0) / sx) ** 2 + ((y - y0) / sy) ** 2
        else:
            _, x0, y0, x1, y1, sx, sy, amp = f
            ax, ay, vx, vy = x0 / sx, y0 / sy, (x1 - x0) / sx, (y1 - y0) / sy
            px, py = x / sx - ax, y / sy - ay
            t = max(0.0, min(1.0, (px * vx + py * vy) / (vx * vx + vy * vy)))
            d2 = (px - t * vx) ** 2 + (py - t * vy) ** 2
        k += amp * math.exp(-d2)
    return k


class Sec:
    """A section across a part. Its chord in the side view runs from F to B ((u, z) pairs), w is its half width
    and xc its centre across. e > 2 squares it off, shift moves the widest point towards F, pinch narrows the
    F side, relief(f, side) swells or hollows the width locally (f runs from 1 at F to -1 at B), and notch
    (depth, spread) pulls the middle of the B side in (the channel under the jaw, the cleft of the heels)."""

    def __init__(self, F, B, w, xc=0.0, e=2.0, shift=0.0, pinch=0.0, relief=None, notch=None):
        self.F, self.B, self.w, self.xc = Vector(F), Vector(B), w, xc
        self.e, self.shift, self.pinch, self.relief, self.notch = e, shift, pinch, relief, notch

    def f_of(self, t):
        f = sgnpow(math.cos(t), 2 / self.e)
        return f + self.shift * (1 - f * f)

    def t_for_f(self, f):
        """The angle (0..pi) at which the section is a fraction f along its chord."""
        lo, hi = 0.0, math.pi
        for _ in range(30):
            mid = (lo + hi) / 2
            lo, hi = (mid, hi) if self.f_of(mid) > f else (lo, mid)
        return (lo + hi) / 2

    def point(self, t):
        mid, half = (self.F + self.B) / 2, (self.F - self.B) / 2
        f = self.f_of(t)
        s = math.sin(t)
        lat = self.w * sgnpow(s, 2 / self.e) * (1 - self.pinch * max(f, 0.0) ** 2)
        if self.relief:
            lat *= self.relief(f, 1 if s >= 0 else -1)
        if self.notch and self.notch[0]:
            depth, spread = self.notch
            d = (t % TAU) - math.pi
            f += depth / half.length * math.exp(-(d / spread) ** 2)
        p = mid + half * f
        return P(p.x, p.y, self.xc + lat)

    def centre(self):
        m = (self.F + self.B) / 2
        return P(m.x, m.y, self.xc)


class Loft:
    """A surface through sections: station(s) gives the section at s (0..1); t goes round it (0 at F)."""

    def __init__(self, station):
        self.station = station

    def point(self, s, t, out=0.0):
        p = self.station(s).point(t)
        return p + self.normal(s, t) * out if out else p

    def normal(self, s, t):
        e = 1e-3
        a, b = self.station(max(s - e, 0.0)).point(t), self.station(min(s + e, 1.0)).point(t)
        sec = self.station(s)
        n = (b - a).cross(sec.point(t + e) - sec.point(t - e))
        if n.length < 1e-9:
            n = sec.point(t) - sec.centre()
        if n.dot(sec.point(t) - sec.centre()) < 0:
            n = -n
        return n.normalized()

    def at_f(self, s, f, side, out=0.0):
        """The surface a fraction f along the section's chord on one side (+1 left, -1 right)."""
        t = self.station(s).t_for_f(f) * side
        return self.point(s, t, out), self.normal(s, t)

    def rings(self, ss, n):
        return [[self.point(s, TAU * k / n) for k in range(n)] for s in ss]


class Part:
    """Pieces gathered into one mesh, each face with its material (an index into MATS)."""

    def __init__(self):
        self.bm = bmesh.new()

    def tube(self, rings, mats, start=None, end=None, loop=False):
        """Quads between consecutive rings, closed with a fan at either end (at the given point, the ring's
        centre if None, open if False), or joined round if loop. mats: one material, one per band, or a
        function (band, face) -> material."""
        bm = self.bm
        if isinstance(mats, int):
            one = mats
            mats = lambda i, k: one  # noqa: E731
        elif isinstance(mats, list):
            per = mats
            mats = lambda i, k: per[min(i, len(per) - 1)]  # noqa: E731
        vs = [[bm.verts.new(p) for p in r] for r in rings]
        if loop:
            vs.append(vs[0])
        n = len(rings[0])
        faces = []
        for i, (a, b) in enumerate(zip(vs, vs[1:])):
            for k in range(n):
                f = bm.faces.new((a[k], a[(k + 1) % n], b[(k + 1) % n], b[k]))
                f.material_index = mats(i, k)
                faces.append(f)
        if not loop:
            for pole, ring, i in ((start, vs[0], 0), (end, vs[-1], len(vs) - 2)):
                if pole is False:
                    continue
                c = bm.verts.new(pole if pole is not None else sum((v.co for v in ring), Vector()) / n)
                for k in range(n):
                    f = bm.faces.new((ring[k], ring[(k + 1) % n], c))
                    f.material_index = mats(i, k)
                    faces.append(f)
        bmesh.ops.recalc_face_normals(bm, faces=faces)

    def blob(self, centre, ax, ay, az, mat, seg=8, rows=5):
        """An ellipsoid round centre with semi-axis vectors ax, ay, az (az through the poles)."""
        c = Vector(centre)
        rings = []
        for j in range(1, rows):
            phi = math.pi * j / rows
            rings.append([c + az * math.cos(phi) + (ax * math.cos(TAU * k / seg) + ay * math.sin(TAU * k / seg))
                          * math.sin(phi) for k in range(seg)])
        self.tube(rings, mat, start=c + az, end=c - az)

    def strip(self, path, normals, widths, thicks, mat, loop=False, tip=False):
        """A strap or a lock of hair along a path: a flat diamond section (width across, thickness along the
        normal). tip ends it in a point."""
        rings = []
        n = len(path)
        for i, (c, nrm) in enumerate(zip(path, normals)):
            tan = path[(i + 1) % n] - path[i - 1] if loop else path[min(i + 1, n - 1)] - path[max(i - 1, 0)]
            side = tan.cross(nrm).normalized()
            up = side.cross(tan).normalized()
            w, th = widths[i] / 2, thicks[i] / 2
            rings.append([c + up * th, c + side * w, c - up * th, c - side * w])
        if tip and not loop:
            end = path[-1] + (path[-1] - path[-2]).normalized() * thicks[-1]
            self.tube(rings, mat, end=end)
        else:
            self.tube(rings, mat, loop=loop)

    def slab(self, outer, inner, mat):
        """A panel of some thickness between two grids of points (rows x columns): its faces, back and edges."""
        bm = self.bm
        vo = [[bm.verts.new(p) for p in row] for row in outer]
        vi = [[bm.verts.new(p) for p in row] for row in inner]
        faces = []
        rows, cols = len(outer), len(outer[0])
        for r in range(rows - 1):
            for c in range(cols - 1):
                faces.append(bm.faces.new((vo[r][c], vo[r][c + 1], vo[r + 1][c + 1], vo[r + 1][c])))
                faces.append(bm.faces.new((vi[r][c], vi[r + 1][c], vi[r + 1][c + 1], vi[r][c + 1])))
        rim = [(0, c) for c in range(cols)] + [(r, cols - 1) for r in range(1, rows)] + \
              [(rows - 1, c) for c in range(cols - 2, -1, -1)] + [(r, 0) for r in range(rows - 2, 0, -1)]
        for (r0, c0), (r1, c1) in zip(rim, rim[1:] + rim[:1]):
            faces.append(bm.faces.new((vo[r0][c0], vi[r0][c0], vi[r1][c1], vo[r1][c1])))
        for f in faces:
            f.material_index = mat
        bmesh.ops.recalc_face_normals(bm, faces=faces)

    def build(self, name, pivot, smooth=SMOOTH):
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        used = sorted({p.material_index for p in me.polygons})
        for m in used:
            me.materials.append(MATS[m])
        remap = {m: i for i, m in enumerate(used)}
        for p in me.polygons:
            p.material_index = remap[p.material_index]
        me.transform(Matrix.Translation(-pivot))
        me.set_sharp_from_angle(angle=math.radians(smooth))
        obj = link(bpy.data.objects.new(name, me))
        obj.location = pivot
        return obj


bpy.ops.wm.read_factory_settings(use_empty=True)
MATS = [material("Coat", srgb("#7a4628")), material("Dark", srgb("#1e1714")), material("Eye", srgb("#0b0706"), 0.3),
        material("Marking", srgb("#f1eee8")), material("Leather", srgb("#3a2416"), 0.6),
        material("Pad", srgb("#ebe3d0"), 0.9), material("Metal", srgb("#c9c9c6"), 0.3, 1.0)]
COAT, DARK, EYE, MARK, LEATHER, PAD, METAL = range(7)

# ---- Body: vertical sections from the buttock to the chest. Topline, underline and half width in the side
# view; the withers and the back narrow towards the top, and the shoulders and quarters are widest low
# down, where they hide the tops of the legs. In front of the withers it slopes down to the chest: hidden
# in the neck when the head is up, the base the neck turns down from when it grazes. The muscles are
# bumps on the width: the shoulder blade and the triceps behind it, the point of the shoulder and the
# chest, the hollow of the flank, the point of the hip and the round of the quarters.
TOP = curve([(-0.815, 1.30), (-0.795, 1.43), (-0.75, 1.515), (-0.65, 1.585), (-0.50, 1.63), (-0.36, 1.625),
             (-0.20, 1.59), (-0.02, 1.545), (0.14, 1.55), (0.26, 1.60), (0.38, 1.65), (0.48, 1.64), (0.60, 1.585),
             (0.72, 1.505), (0.80, 1.43), (0.85, 1.35), (0.88, 1.22)])
BOT = curve([(-0.815, 1.26), (-0.795, 1.13), (-0.75, 1.04), (-0.62, 0.995), (-0.45, 0.99), (-0.33, 0.975),
             (-0.18, 0.925), (0.0, 0.885), (0.18, 0.868), (0.33, 0.865), (0.43, 0.872), (0.54, 0.915), (0.65, 0.97),
             (0.76, 1.03), (0.83, 1.08), (0.88, 1.15)])
WID = curve([(-0.815, 0.05), (-0.795, 0.15), (-0.75, 0.21), (-0.62, 0.25), (-0.45, 0.268), (-0.28, 0.265),
             (-0.05, 0.285), (0.15, 0.28), (0.30, 0.25), (0.45, 0.225), (0.62, 0.218), (0.75, 0.20), (0.83, 0.16),
             (0.88, 0.06)])
PINCH = curve([(-0.815, 0.1), (-0.55, 0.12), (-0.3, 0.2), (0.0, 0.3), (0.22, 0.55), (0.38, 0.8), (0.55, 0.65),
               (0.88, 0.3)])
SHIFT = curve([(-0.815, 0.0), (-0.7, -0.15), (-0.45, -0.15), (-0.25, 0.0), (0.0, 0.03), (0.35, -0.05), (0.55, -0.25),
               (0.8, -0.25), (0.88, -0.1)])
EXP = curve([(-0.815, 2.3), (-0.6, 2.6), (-0.3, 2.3), (0.3, 2.3), (0.6, 2.8), (0.88, 2.4)])
BODY_MUSCLES = [  # in (u, z), metres
    ("ridge", 0.42, 1.55, 0.78, 1.22, 0.07, 0.07, 0.05),     # shoulder blade
    ("ridge", 0.36, 1.45, 0.41, 1.00, 0.035, 0.05, -0.04),   # the line behind the shoulder
    ("blob", 0.50, 1.10, 0.08, 0.10, 0.06),                  # triceps above the elbow
    ("blob", 0.84, 1.16, 0.05, 0.05, 0.07),                  # point of the shoulder
    ("blob", 0.76, 1.00, 0.07, 0.06, 0.06),                  # chest
    ("blob", 0.10, 1.15, 0.25, 0.20, 0.02),                  # ribs
    ("blob", -0.22, 1.40, 0.09, 0.07, -0.05),                # hollow of the flank under the loin
    ("blob", -0.30, 1.12, 0.07, 0.07, -0.03),                # flank in front of the stifle
    ("blob", -0.40, 1.48, 0.05, 0.05, 0.05),                 # point of the hip
    ("blob", -0.60, 1.30, 0.14, 0.12, 0.05),                 # quarters
    ("ridge", -0.70, 1.45, -0.79, 1.10, 0.03, 0.05, -0.03),  # the groove down the back of the thigh
]
U0, U1 = -0.815, 0.88


def body_sec(s):
    u = U0 + (U1 - U0) * s
    top, bot = TOP(u), BOT(u)
    return Sec((u, top), (u, bot), WID(u), e=EXP(u), shift=SHIFT(u), pinch=PINCH(u),
               relief=lambda f, side: bumps(u, (top + bot) / 2 + (top - bot) / 2 * f, BODY_MUSCLES))


BODY = Loft(body_sec)


def body_s(u):
    return (u - U0) / (U1 - U0)


def body_at(u, z, side, out=0.0):
    """The body's surface at height z on one side (+1 left) of its section at u, moved out along the normal."""
    s = body_s(u)
    sec = BODY.station(s)
    f = (z - (sec.F.y + sec.B.y) / 2) / ((sec.F.y - sec.B.y) / 2)
    return BODY.at_f(s, max(-1.0, min(1.0, f)), side, out)


body = Part()
ss = [0.6 * (0.5 - 0.5 * math.cos(math.pi * k / 31)) + 0.4 * k / 31 for k in range(32)]
body.tube(BODY.rings(ss, 22), COAT, start=P(U0 - 0.012, 1.28), end=P(U1 + 0.01, 1.18))
Body = body.build("Body", P(MID, 0.0))

# ---- Head: sections across the face from the back of the poll to the upper lip, in the head's own frame
# (a along the face, b out of it): F on the face (forehead, nasal bone), B under the jaw (jowl, chin).
# Bumps give the bony rim round the eye, the cheekbone and the round jowl; a channel runs between the
# jawbones underneath. The blaze is a strip of faces down the middle of the face.
HEAD = [  # a, face b, jaw b, half width
    (-0.05, -0.045, -0.13, 0.058),
    (-0.02, -0.015, -0.17, 0.08),
    (0.02, 0.012, -0.225, 0.098),
    (0.07, 0.026, -0.262, 0.11),
    (0.12, 0.034, -0.282, 0.116),
    (0.17, 0.037, -0.284, 0.12),
    (0.22, 0.036, -0.262, 0.118),
    (0.27, 0.032, -0.228, 0.102),
    (0.33, 0.026, -0.198, 0.087),
    (0.39, 0.019, -0.178, 0.075),
    (0.45, 0.011, -0.165, 0.068),
    (0.50, 0.004, -0.152, 0.068),
    (0.535, -0.004, -0.135, 0.074),
    (0.565, -0.018, -0.122, 0.077),  # nostrils
    (0.59, -0.04, -0.114, 0.071),
    (0.607, -0.065, -0.108, 0.056),  # upper lip
]
A0, A1 = HEAD[0][0], HEAD[-1][0]
FACE = curve([(a, f) for a, f, _, _ in HEAD])
JAW = curve([(a, j) for a, _, j, _ in HEAD])
HW = curve([(a, w) for a, _, _, w in HEAD])
HEAD_SHIFT = curve([(-0.05, 0.0), (0.15, 0.25), (0.35, 0.2), (0.62, 0.0)])
JAW_CHANNEL = curve([(0.08, 0.0), (0.16, 0.022), (0.40, 0.022), (0.50, 0.0)])
HEAD_FEATURES = [  # in (a, f)
    ("blob", 0.20, 0.62, 0.045, 0.18, 0.12),               # the bony rim round the eye
    ("blob", 0.10, 0.80, 0.04, 0.12, -0.06),               # the hollow above and behind it
    ("ridge", 0.19, -0.05, 0.34, 0.22, 0.03, 0.10, 0.07),  # cheekbone
    ("blob", 0.13, -0.50, 0.07, 0.30, 0.10),               # jowl
    ("blob", 0.565, 0.25, 0.03, 0.30, 0.08),               # flared nostrils
]


def head_sec(s):
    a = A0 + (A1 - A0) * s
    return Sec(H(a, FACE(a)), H(a, JAW(a)), HW(a) * HEAD_SCALE, e=2.4, shift=HEAD_SHIFT(a), pinch=0.12,
               relief=lambda f, side: bumps(a, f, HEAD_FEATURES), notch=(JAW_CHANNEL(a) * HEAD_SCALE, 0.45))


HEAD_LOFT = Loft(head_sec)


def head_at(a, f, side, out=0.0):
    return HEAD_LOFT.at_f((a - A0) / (A1 - A0), f, side, out)


def head_dir(da, db):
    """A direction in the side view of the head (da along the face, db out of it), in Blender coordinates."""
    p0, p1 = H(0, 0), H(da, db)
    return P(p1[0] - p0[0] + MID, p1[1] - p0[1]).normalized()


# ---- Neck: from deep in the shoulders (round its pivot, so it can turn down) up to inside the head.
# Crest on top, the throat underneath, half width; the crest is thickened and the jugular groove runs
# along the lower side.
NECK = [((0.41, 1.38), (0.76, 1.06), 0.12),
        ((0.43, 1.605), (0.84, 1.18), 0.15),
        ((0.58, 1.735), (0.93, 1.34), 0.142),
        ((0.77, 1.86), (1.005, 1.51), 0.118),
        ((0.955, 1.94), (1.05, 1.68), 0.098),
        (H(-0.005, -0.07), H(0.05, -0.215), 0.085),
        (H(0.04, -0.075), H(0.06, -0.13), 0.05)]
NECK_KEYS = [(*c, *t, w) for c, t, w in NECK]
NECK_FEATURES = [("blob", 0.55, 0.78, 0.32, 0.22, 0.12),                  # crest
                 ("ridge", 0.25, -0.45, 0.85, -0.40, 0.05, 0.12, -0.05)]  # jugular groove


def neck_sec(s):
    cu, cz, tu, tz, w = spline_at(NECK_KEYS, s)
    return Sec((cu, cz), (tu, tz), w, e=2.2, pinch=0.3, relief=lambda f, side: bumps(s, f, NECK_FEATURES))


NECK_LOFT = Loft(neck_sec)
neck = Part()
neck.tube(NECK_LOFT.rings([k / 14 for k in range(15)], 18), COAT)
# Mane: a band along the crest, and locks falling from it down the right side (-x).
band = []
for k in range(12):
    s = 0.25 + 0.71 * k / 11
    thick = 0.005 + 0.012 * math.sin(math.pi * k / 11) ** 0.5
    band.append([NECK_LOFT.at_f(s, f, side, out)[0] for f, side, out in
                 ((0.92, 1, 0.004), (1.0, 1, thick), (0.94, -1, thick), (0.86, -1, 0.004),
                  (0.88, -1, -0.008), (0.96, 1, -0.008))])
neck.tube(band, DARK)
# The locks are broad and overlap, lying on the neck, each a little longer or shorter than the next.
MANE = [0.17, 0.21, 0.19, 0.23, 0.2, 0.24, 0.21, 0.23, 0.19, 0.21, 0.17, 0.13]
for i, length in enumerate(MANE):
    s0 = 0.29 + 0.65 * i / 11
    qs = [j / 4 for j in range(5)]
    path, nrms = [], []
    for q in qs:
        s = s0 - 0.04 * q
        t = -(0.03 + (0.5 + 3.6 * length) * q)  # past the widest point of the neck, the ends out of sight
        # Every other lock a little further out, so where they overlap one lies on the next.
        path.append(NECK_LOFT.point(s, t, 0.009 + 0.004 * (i % 2) + 0.004 * q + 0.003 * math.sin(4 * q + i)))
        nrms.append(NECK_LOFT.normal(s, t))
    neck.strip(path, nrms, [0.09 * (1 - 0.35 * q ** 1.5) for q in qs], [0.014 * (1 - 0.4 * q) for q in qs], DARK)
Neck = neck.build("Neck", P(*NECK_PIVOT))

# ---- The head's own mesh.
HN = 18
head_a = [a for a, _, _, _ in HEAD]


def head_mat(i, k):
    a = (head_a[i] + head_a[min(i + 1, len(head_a) - 1)]) / 2
    if a >= 0.51:
        return DARK
    t = TAU * (k + 0.5) / HN
    t = t - TAU if t > math.pi else t
    return MARK if a >= 0.12 and abs(t) < 0.25 else COAT


head = Part()
head.tube(HEAD_LOFT.rings([(a - A0) / (A1 - A0) for a in head_a], HN), head_mat, start=P(*H(A0 - 0.01, -0.085)),
          end=P(*H(0.616, -0.088)))
# Lower lip and chin under the muzzle, the mouth between them.
head.blob(P(*H(0.555, -0.143)), head_dir(1, 0) * 0.044 * HEAD_SCALE, head_dir(0, 1) * 0.03 * HEAD_SCALE,
          Vector((0.05, 0, 0)), DARK)
for side in (1, -1):
    # Eyes: dark and almond-shaped, at the side of the head a third of the way down, under the bony rim.
    c, n = head_at(0.205, 0.55, side, -0.004)
    ax, ay = head_dir(1, 0.2), head_dir(-0.2, 1)
    head.blob(c, ax * 0.031, ay * 0.021, n * 0.014, EYE)
    # The upper lid over it.
    lid = [c + (ax * math.cos(a) * 0.034 + ay * math.sin(a) * 0.024) + n * (0.006 + 0.004 * math.sin(a))
           for a in (0.15, 0.9, 1.57, 2.25, 3.0)]
    head.strip(lid, [n] * 5, [0.008, 0.012, 0.013, 0.012, 0.008], [0.007, 0.009, 0.01, 0.009, 0.007], COAT)
    # Nostrils: long, curved openings on the front of the muzzle.
    c, n = head_at(0.565, 0.22, side, -0.006)
    head.blob(c, head_dir(0.8, 0.6) * 0.027, head_dir(-0.6, 0.8) * 0.012, n * 0.012, EYE, 8, 4)
# Forelock: three locks from between the ears over the forehead.
for t0, a1 in ((-0.2, 0.15), (0.0, 0.2), (0.2, 0.16)):
    qs = [j / 4 for j in range(5)]
    path, nrms = [], []
    for q in qs:
        s = (-0.005 + (a1 + 0.005) * q - A0) / (A1 - A0)
        path.append(HEAD_LOFT.point(s, t0 * (1 + 0.5 * q), 0.009 - 0.003 * q))
        nrms.append(HEAD_LOFT.normal(s, t0 * (1 + 0.5 * q)))
    head.strip(path, nrms, [0.06 * (1 - 0.5 * q ** 1.3) for q in qs], [0.011 * (1 - 0.4 * q) for q in qs], DARK)


def head_path(points, out):
    """(a, f, side) points on the head, lifted by out: the path and its normals."""
    pts = [head_at(a, f, side, out) for a, f, side in points]
    return [p for p, _ in pts], [n for _, n in pts]


# Bridle: the headpiece over the poll and down both cheeks to the bit, a browband, a noseband round the
# nose and a throatlatch hanging under the throat. A plain snaffle: a mouthpiece and a ring either side.
CHEEK = [(0.525, -0.70), (0.46, -0.55), (0.37, -0.36), (0.28, -0.14), (0.19, 0.18), (0.11, 0.46), (0.04, 0.70),
         (-0.01, 0.84)]
crown = [(a, f, 1) for a, f in CHEEK] + [(-0.03, 0.95, 1), (-0.035, 1.0, 1), (-0.03, 0.95, -1)] + \
        [(a, f, -1) for a, f in reversed(CHEEK)]
path, nrms = head_path(crown, 0.005)
head.strip(path, nrms, [0.022] * len(path), [0.006] * len(path), LEATHER)
path, nrms = head_path([(0.045, f, side) for f, side in ((0.6, 1), (0.85, 1), (0.97, 1), (1.0, 1), (0.97, -1),
                                                           (0.85, -1), (0.6, -1))], 0.006)
head.strip(path, nrms, [0.02] * len(path), [0.006] * len(path), LEATHER)
s_nose = (0.40 - A0) / (A1 - A0)
path = [HEAD_LOFT.point(s_nose, TAU * k / 12, 0.006) for k in range(12)]
nrms = [HEAD_LOFT.normal(s_nose, TAU * k / 12) for k in range(12)]
head.strip(path, nrms, [0.026] * 12, [0.007] * 12, LEATHER, loop=True)
latch = [(-0.01, 0.8, 1), (0.0, 0.4, 1), (0.01, 0.0, 1), (0.02, -0.45, 1), (0.025, -0.85, 1), (0.025, -1.0, 1),
         (0.025, -0.85, -1), (0.02, -0.45, -1), (0.01, 0.0, -1), (0.0, 0.4, -1), (-0.01, 0.8, -1)]
pts = [head_at(a, f, side, 0.006 + 0.025 * max(0.0, -f)) for a, f, side in latch]
head.strip([p for p, _ in pts], [n for _, n in pts], [0.016] * len(pts), [0.005] * len(pts), LEATHER)
RING = {side: head_at(0.525, -0.72, side, 0.014)[0] for side in (1, -1)}
for side in (1, -1):
    a_dir, b_dir = head_dir(1, 0), head_dir(0, 1)
    path = [RING[side] + (a_dir * math.cos(TAU * k / 8) + b_dir * math.sin(TAU * k / 8)) * 0.03 for k in range(8)]
    head.strip(path, [Vector((side, 0, 0))] * 8, [0.009] * 8, [0.009] * 8, METAL, loop=True)
head.strip([RING[1], (RING[1] + RING[-1]) / 2, RING[-1]], [head_dir(0, 1)] * 3, [0.011] * 3, [0.011] * 3, METAL)
Head = head.build("Head", P(*H(0.035, -0.085)))

# ---- Ears: pricked, a little forward and out, the opening cupped towards the front (dark inside and at
# the tips). Each its own node, turning about its base.
ears = []
for side, name in ((1, "Ear_L"), (-1, "Ear_R")):
    base, _ = head_at(0.0, 0.86, side, -0.015)
    d = Vector((side * 0.22, -0.12, 1.0)).normalized()
    look = Vector((side * 0.35, -1.0, 0.0))
    fwd = (look - d * d.dot(look)).normalized()
    lat = d.cross(fwd)
    rings = []
    for s, wf, wl in ((0.0, 0.032, 0.03), (0.15, 0.04, 0.03), (0.4, 0.04, 0.026), (0.65, 0.031, 0.019),
                      (0.85, 0.018, 0.011)):
        ring = []
        for k in range(8):
            th = TAU * k / 8
            f, l = wf * math.cos(th), wl * math.sin(th)
            if 0.1 < s < 0.9 and k == 0:
                f = -0.15 * wf  # the hollow of the ear
            ring.append(base + d * (0.165 * s) + fwd * f + lat * l)
        rings.append(ring)
    ear = Part()
    ear.tube(rings, lambda i, k: DARK if k in (0, 7) or i >= 3 else COAT, end=base + d * 0.17)
    ears.append(ear.build(name, base))

# ---- Reins: from the bit rings, hanging under the jaw and back along both sides of the neck to meet on
# the crest in front of the withers. Their own node on the head, turning about the bit.
reins = Part()
for side in (1, -1):
    way = [RING[side] - head_dir(1, 0.3) * 0.028, head_at(0.36, -0.95, side, 0.06)[0],
           head_at(0.17, -0.97, side, 0.05)[0], NECK_LOFT.point(0.80, side * 2.25, 0.016),
           NECK_LOFT.point(0.62, side * 1.85, 0.016), NECK_LOFT.point(0.45, side * 1.25, 0.016),
           NECK_LOFT.point(0.33, side * 0.55, 0.018), NECK_LOFT.point(0.29, side * 0.12, 0.022)]
    keys = [tuple(p) for p in way]
    path = [Vector(spline_at(keys, k / 12)) for k in range(13)]
    reins.strip(path, [Vector((side, 0, 0))] * 13, [0.018] * 13, [0.005] * 13, LEATHER)
Reins = reins.build("Reins", (RING[1] + RING[-1]) / 2)

# ---- Tail: the dock out of the top of the buttocks, carried a little away from them, then the hair
# falling full and wide to below the hocks, with a few locks loose at the end.
TAIL = [  # centre (u, z), half depth, half width
    ((-0.70, 1.53), 0.035, 0.035), ((-0.77, 1.53), 0.042, 0.042), ((-0.83, 1.505), 0.048, 0.05),
    ((-0.87, 1.45), 0.055, 0.06), ((-0.895, 1.37), 0.062, 0.072), ((-0.91, 1.26), 0.07, 0.088),
    ((-0.916, 1.12), 0.076, 0.10), ((-0.913, 0.96), 0.08, 0.108), ((-0.906, 0.80), 0.077, 0.108),
    ((-0.896, 0.64), 0.068, 0.10), ((-0.886, 0.50), 0.052, 0.082), ((-0.876, 0.41), 0.032, 0.05)]
tail = Part()
rings = []
for i, (c, dep, w) in enumerate(TAIL):
    a, b = Vector(TAIL[max(i - 1, 0)][0]), Vector(TAIL[min(i + 1, len(TAIL) - 1)][0])
    t = (b - a).normalized()
    nrm = Vector((t.y, -t.x))  # in the side view, across the tail
    if nrm.x < 0:
        nrm = -nrm
    sec = Sec(Vector(c) + nrm * dep, Vector(c) - nrm * dep, w)
    rings.append([sec.point(TAU * k / 10) for k in range(10)])
tail.tube(rings, DARK, end=P(-0.872, 0.37))
hang = sorted(TAIL[4:], key=lambda r: r[0][1])  # the hanging part, by height
TU, TD, TW = (curve([(c[1], c[0]) for c, d, w in hang]), curve([(c[1], d) for c, d, w in hang]),
              curve([(c[1], w) for c, d, w in hang]))
for ang, z0, z1 in ((math.pi, 0.95, 0.34), (math.pi - 1.0, 0.9, 0.36), (math.pi + 1.0, 0.88, 0.35),
                    (math.pi / 2 - 0.3, 0.85, 0.40), (-math.pi / 2 + 0.3, 0.83, 0.39)):
    qs = [j / 4 for j in range(5)]
    path, nrms = [], []
    for q in qs:
        z = z0 + (z1 - z0) * q
        r = 0.7 + 0.35 * q
        radial = P(math.cos(ang) * TD(max(z, 0.41)), 0, math.sin(ang) * TW(max(z, 0.41))) - P(0, 0)
        path.append(P(TU(max(z, 0.41)), z) + radial * r)
        nrms.append(radial.normalized())
    tail.strip(path, nrms, [0.05 * (1 - 0.75 * q) for q in qs], [0.02 * (1 - 0.6 * q) for q in qs], DARK, tip=True)
Tail = tail.build("Tail", P(*TAIL_ROOT))

# ---- Legs: sections across the leg (front edge, back edge in the side view, half width), from inside the
# body down. Each leg is two pieces: the upper leg to the knee (front) or the hock (hind), and below it the
# shin with the cannon, fetlock, pastern and hoof. Both are rounded over the joint between them, so it
# stays closed when the shin folds. Dark (the points) from the knee and the hock down, a white sock from
# the coronet to above the fetlock, a tuft of hair behind the fetlock, and the hooves with a cleft
# between the heels.
FRONT_UP = [  # front (u, z), back (u, z), half width
    ((0.70, 1.30), (0.47, 1.30), 0.05),      # inside the shoulder
    ((0.73, 1.12), (0.39, 1.12), 0.06),      # upper arm, the elbow behind it
    ((0.67, 0.98), (0.37, 0.98), 0.072),
    ((0.635, 0.88), (0.41, 0.88), 0.078),    # forearm
    ((0.615, 0.78), (0.44, 0.78), 0.066),
    ((0.598, 0.68), (0.455, 0.68), 0.056),
    ((0.586, 0.60), (0.465, 0.60), 0.049),
    ((0.584, 0.555), (0.466, 0.555), 0.048),
    ((0.592, 0.52), (0.456, 0.52), 0.056),   # top of the knee
]
FRONT_DOWN = [
    ((0.592, 0.47), (0.452, 0.47), 0.057),   # knee
    ((0.589, 0.44), (0.462, 0.44), 0.054),
    ((0.573, 0.405), (0.476, 0.405), 0.040),
    ((0.567, 0.33), (0.484, 0.33), 0.030),   # cannon
    ((0.567, 0.25), (0.483, 0.25), 0.031),
    ((0.571, 0.21), (0.472, 0.21), 0.035),
    ((0.577, 0.185), (0.462, 0.185), 0.039),  # fetlock
    ((0.586, 0.15), (0.468, 0.145), 0.038),
    ((0.600, 0.118), (0.502, 0.105), 0.034),  # pastern
    ((0.622, 0.082), (0.530, 0.05), 0.044),  # coronet, where the hair stops
    ((0.627, 0.073), (0.527, 0.04), 0.047),
    ((0.648, 0.036), (0.523, 0.02), 0.058),  # hoof
    ((0.671, 0.0), (0.521, 0.0), 0.064),
]
HIND_UP = [
    ((-0.40, 1.38), (-0.69, 1.38), 0.08),    # inside the croup
    ((-0.34, 1.20), (-0.79, 1.20), 0.088),   # thigh
    ((-0.33, 1.06), (-0.795, 1.06), 0.105),
    ((-0.35, 0.97), (-0.785, 0.97), 0.097),  # stifle in front
    ((-0.40, 0.87), (-0.76, 0.87), 0.08),
    ((-0.48, 0.78), (-0.735, 0.78), 0.064),  # gaskin
    ((-0.565, 0.70), (-0.735, 0.70), 0.052),
    ((-0.625, 0.64), (-0.745, 0.64), 0.047),
    ((-0.655, 0.60), (-0.752, 0.60), 0.047),
]
HIND_DOWN = [
    ((-0.69, 0.61), (-0.785, 0.615), 0.040),  # top of the hock, its point behind
    ((-0.668, 0.565), (-0.797, 0.575), 0.055),
    ((-0.676, 0.52), (-0.783, 0.52), 0.053),
    ((-0.688, 0.475), (-0.782, 0.475), 0.045),
    ((-0.695, 0.44), (-0.785, 0.44), 0.036),
    ((-0.700, 0.34), (-0.790, 0.34), 0.030),  # cannon
    ((-0.700, 0.25), (-0.790, 0.25), 0.032),
    ((-0.699, 0.21), (-0.798, 0.21), 0.035),
    ((-0.697, 0.185), (-0.806, 0.185), 0.039),  # fetlock
    ((-0.690, 0.15), (-0.800, 0.145), 0.037),
    ((-0.673, 0.118), (-0.768, 0.105), 0.033),  # pastern
    ((-0.648, 0.082), (-0.745, 0.05), 0.043),
    ((-0.644, 0.073), (-0.746, 0.04), 0.046),
    ((-0.622, 0.036), (-0.749, 0.02), 0.054),
    ((-0.600, 0.0), (-0.751, 0.0), 0.058),
]
LN = 12  # points round a leg


def leg_ring(F, B, w, xc):
    notch = (0.012, 0.4) if B[1] < 0.06 else None  # the cleft between the heels
    sec = Sec(F, B, w, xc=xc, e=2.1, notch=notch)
    return [sec.point(TAU * k / LN) for k in range(LN)]


def joint_cap(pivot, xc, rd, rw, rv, up):
    """Rings rounding a leg piece over its joint (half an ellipsoid round the pivot), from the joint out,
    and the pole."""
    ju, jz = pivot
    rings = []
    for phi in (0.0, 0.7, 1.2):
        z = jz + (rv if up else -rv) * math.sin(phi)
        c = math.cos(phi)
        rings.append(leg_ring((ju + rd * c, z), (ju - rd * c, z), rw * c, xc))
    return rings, P(ju, jz + (rv if up else -rv), xc)


legs, shins = [], []
for side, tag in ((1, "L"), (-1, "R")):
    for front in (True, False):
        up, down = (FRONT_UP, FRONT_DOWN) if front else (HIND_UP, HIND_DOWN)
        pivot, joint = (FRONT_PIVOT, KNEE) if front else (HIND_PIVOT, HOCK)
        x_top, x_hoof = (0.145, 0.14) if front else (0.16, 0.15)
        x_top, x_hoof = x_top * side, x_hoof * side

        def xc(z):
            return x_hoof + (x_top - x_hoof) * min(1.0, z)

        dark_from = 0.56 if front else 0.62
        mid_z = [(F[1] + B[1]) / 2 for F, B, _ in up]
        leg = Part()
        cap, pole = joint_cap(joint, xc(joint[1]), 0.066 if front else 0.04, 0.055 if front else 0.044,
                              0.055 if front else 0.05, False)
        rings = [leg_ring(F, B, w, xc((F[1] + B[1]) / 2)) for F, B, w in up] + cap
        mats = [DARK if i >= len(up) - 1 or mid_z[i + 1] < dark_from else COAT for i in range(len(rings) - 1)]
        leg.tube(rings, mats, end=pole)
        name = ("Leg_F" if front else "Leg_B") + tag
        legs.append(leg.build(name, P(*pivot, x_top)))

        shin = Part()
        if front:
            cap, pole = joint_cap(joint, xc(joint[1]), 0.064, 0.053, 0.06, True)
            cap = cap[::-1]
        else:
            cap, pole = [], P(-0.738, 0.64, xc(0.64))
        mid_z = [(F[1] + B[1]) / 2 for F, B, _ in down]
        rings = cap + [leg_ring(F, B, w, xc((F[1] + B[1]) / 2)) for F, B, w in down]
        mats = [DARK] * len(cap) + [MARK if 0.07 < (mid_z[i] + mid_z[i + 1]) / 2 < 0.205 else DARK
                                    for i in range(len(down) - 1)]
        sole = down[-1]
        shin.tube(rings, mats, start=pole, end=P((sole[0][0] + sole[1][0]) / 2, 0.003, xc(0.0)))
        # The tuft of hair behind the fetlock (white with the sock).
        bu = min(down, key=lambda r: abs(r[1][1] - 0.15))[1][0]  # back of the fetlock
        tuft = [P(bu + du, z, xc(z)) for du, z in ((0.008, 0.165), (0.004, 0.14), (0.014, 0.115), (0.03, 0.098))]
        shin.strip(tuft, [Vector((side, 0, 0))] * 4, [0.03, 0.026, 0.018, 0.008], [0.02, 0.016, 0.011, 0.005], MARK,
                   tip=True)
        shins.append(shin.build(name.replace("Leg", "Shin"), P(*joint, xc(joint[1]))))

# ---- Tack: a saddle pad, an all-purpose saddle (seat, panels, flaps with knee rolls), the girth, and the
# stirrup leathers and irons hanging from it, all laid on the body's surface.
PAD_T = 0.016
SEAT = curve([(-0.21, 1.745), (-0.17, 1.718), (-0.11, 1.678), (-0.03, 1.650), (0.05, 1.643), (0.14, 1.66),
              (0.22, 1.69), (0.28, 1.725), (0.31, 1.738)])
tack = Part()
# Pad: wraps over the back from one lower edge to the other, cut back along the shoulder in front and
# lifted off the spine.
outer, inner = [], []
for r in range(9):
    v = 2 * r / 8 - 1
    orow, irow = [], []
    for c in range(6):
        uf, ub = 0.40 + 0.11 * abs(v) ** 1.5, -0.28 + 0.02 * abs(v)
        if abs(v) > 0.7:  # round the corners
            k = ((abs(v) - 0.7) / 0.3) ** 2
            uf, ub = uf - 0.03 * k, ub + 0.03 * k
        u = uf + (ub - uf) * c / 5
        s = body_s(u)
        sec = BODY.station(s)
        t = v * sec.t_for_f((1.12 - (sec.F.y + sec.B.y) / 2) / ((sec.F.y - sec.B.y) / 2))
        lift = 0.012 * math.exp(-(t / 0.25) ** 2)
        orow.append(BODY.point(s, t, PAD_T + lift))
        irow.append(BODY.point(s, t, 0.003 + lift))
    outer.append(orow)
    inner.append(irow)
tack.slab(outer, inner, PAD)
# Seat: sections across the back from the cantle to the pommel, a channel over the spine underneath.
T_SEAT = curve([(-0.20, 0.40), (-0.12, 0.60), (0.22, 0.62), (0.30, 0.46)])  # half its width, as an angle
rings = []
for u in (-0.20, -0.185, -0.16, -0.12, -0.06, 0.0, 0.06, 0.12, 0.18, 0.24, 0.28, 0.30):
    s = body_s(u)
    h0 = max(0.05, SEAT(u) - TOP(u) - PAD_T)
    T = T_SEAT(u)
    ts = [T * (1 - 2 * j / 6) for j in range(7)]
    top = [BODY.point(s, t, PAD_T + 0.025 + (h0 - 0.02) * math.cos(t / T * math.pi / 2) ** 0.6) for t in ts]
    under = [BODY.point(s, t, PAD_T + 0.005 + 0.03 * math.exp(-(t / 0.15) ** 2)) for t in ts]
    rings.append(top + under[::-1])
tack.tube(rings, LEATHER)
# Girth: round the barrel just behind the elbows, from under one flap to under the other.
outer, inner = [], []
for r in range(15):
    w = r / 14
    uc = 0.27 + 0.06 * math.sin(math.pi * w)
    orow, irow = [], []
    for du in (0.045, -0.045):
        u = uc + du * (0.75 + 0.25 * math.sin(math.pi * w))
        s = body_s(u)
        sec = BODY.station(s)
        tl = sec.t_for_f((1.22 - (sec.F.y + sec.B.y) / 2) / ((sec.F.y - sec.B.y) / 2))
        t = tl + (TAU - 2 * tl) * w
        orow.append(BODY.point(s, t, 0.029))
        irow.append(BODY.point(s, t, 0.019))
    outer.append(orow)
    inner.append(irow)
tack.slab(outer, inner, LEATHER)
for side in (1, -1):
    # Flaps: forward cut, a knee roll along the front edge.
    outer, inner = [], []
    ZS = [1.50, 1.40, 1.30, 1.21, 1.14]
    for i, z in enumerate(ZS):
        drop = 1.50 - z
        uf, ub = 0.29 + 0.20 * drop, -0.09 + 0.08 * drop
        if i == len(ZS) - 1:
            uf, ub = uf - 0.035, ub + 0.035
        orow, irow = [], []
        for j in range(5):
            u = uf + (ub - uf) * j / 4
            roll = 0.014 if j == 0 and 0 < i < len(ZS) - 1 else 0.0
            orow.append(body_at(u, z, side, PAD_T + 0.025 + roll)[0])
            irow.append(body_at(u, z, side, PAD_T + 0.015)[0])
        outer.append(orow)
        inner.append(irow)
    tack.slab(outer, inner, LEATHER)
    # Stirrup leather from the bar under the skirt down the flap, and the iron hanging from it, its tread
    # along the horse's side as it hangs when nobody is riding.
    path = [body_at(0.22, 1.50, side, 0.05)[0], body_at(0.215, 1.30, side, 0.052)[0],
            body_at(0.21, 1.15, side, 0.052)[0]]
    path.append(Vector((path[-1].x + side * 0.004, path[-1].y, 1.10)))
    tack.strip(path, [Vector((side, 0, 0))] * 4, [0.026] * 4, [0.005] * 4, LEATHER)
    eye = path[-1]
    loop = [(0.0, 1.097), (0.035, 1.08), (0.055, 1.02), (0.054, 0.976), (0.0, 0.973), (-0.054, 0.976),
            (-0.055, 1.02), (-0.035, 1.08)]
    path = [Vector((eye.x, eye.y - du, z)) for du, z in loop]
    tack.strip(path, [Vector((side, 0, 0))] * len(path), [0.011] * len(path), [0.011] * len(path), METAL, loop=True)
    tack.strip([Vector((eye.x, eye.y - 0.05, 0.977)), Vector((eye.x, eye.y + 0.05, 0.977))], [Vector((0, 0, 1))] * 2,
               [0.045] * 2, [0.008] * 2, METAL)
SEAT_AT = P(0.05, SEAT(0.05))
Tack = tack.build("Tack", SEAT_AT)

# ---- Hierarchy: everything hangs off the body; the head, ears and reins off the neck; shins off the legs.
LINKS = [(Neck, Body), (Head, Neck)] + [(e, Head) for e in ears] + [(Reins, Head), (Tail, Body), (Tack, Body)]
LINKS += [(leg, Body) for leg in legs] + [(shin, leg) for shin, leg in zip(shins, legs)]
ALL = [Body, Neck, Head, *ears, Reins, Tail, *legs, *shins, Tack]
pivots = {o.name: o.location.copy() for o in ALL}  # still world space: nothing is parented yet
for child, parent in LINKS:
    child.parent = parent
    child.location = pivots[child.name] - pivots[parent.name]
bpy.context.view_layer.update()

tris = 0
for o in ALL:
    o.data.calc_loop_triangles()
    tris += len(o.data.loop_triangles)
    print(f"  {o.name}: {len(o.data.loop_triangles)} triangles")
print(f"horse: {tris} triangles")

bpy.ops.object.select_all(action="DESELECT")
for o in ALL:
    o.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_texcoords=False, export_cameras=False, export_lights=False)
OBJ = {o.name: o for o in ALL}


def pose(angles):
    """Turn parts about x (degrees; Tail and Ears may also take (x, y, z)), the rest back to rest."""
    for o in ALL:
        o.rotation_euler = (0, 0, 0)
    Body.location = (0, 0, 0)
    for name, a in angles.items():
        OBJ[name].rotation_euler = [math.radians(v) for v in (a if isinstance(a, tuple) else (a, 0, 0))]
    bpy.context.view_layer.update()


def lowest(objs):
    return min((o.matrix_world @ v.co).z for o in objs for v in o.data.vertices)


def extent(axis, fn):
    return fn((o.matrix_world @ v.co)[axis] for o in ALL for v in o.data.vertices)


pose({})
print(f"horse: withers {max(v.co.z for v in Body.data.vertices):.3f} m, top of the ears {extent(2, max):.3f} m, "
      f"nose to tail {extent(1, max) - extent(1, min):.3f} m, width {extent(0, max) - extent(0, min):.3f} m")
# Grazing: lower the neck until the muzzle is 2 cm off the grass, the head turned back up so its face is near
# upright (GRAZE_FACE below horizontal).
GRAZE_FACE = 85
lo, hi = 0.0, 150.0
for _ in range(40):
    neck_x = (lo + hi) / 2
    pose({"Neck": neck_x, "Head": GRAZE_FACE - math.degrees(HEAD_ANGLE) - neck_x})
    lo, hi = (neck_x, hi) if lowest([Head]) > 0.02 else (lo, neck_x)
GRAZE = {"Neck": neck_x, "Head": GRAZE_FACE - math.degrees(HEAD_ANGLE) - neck_x}
# The reins hang from the bit: turn them so that, as far as one rigid piece can, they lie back along the neck
# where they lie when it stands (the far end and two points on the way).
reach = max(v.co.length for v in Reins.data.vertices)
marks = [min(Reins.data.vertices, key=lambda v: abs(v.co.length - reach * k)).co.copy() for k in (0.5, 0.75, 1.0)]
pose({})
on_neck = [Neck.matrix_world.inverted() @ (Reins.matrix_world @ m) for m in marks]
best = None
for r in range(-90, 121):
    pose({**GRAZE, "Reins": r})
    gap = max(((Reins.matrix_world @ m) - (Neck.matrix_world @ n)).length for m, n in zip(marks, on_neck))
    best = min(best or (gap, r), (gap, r))
GRAZE["Reins"] = best[1]
pose({"Neck": 55})
print(f"horse: grazing with the neck at {GRAZE['Neck']:.1f}, the head at {GRAZE['Head']:.1f} and the reins at "
      f"{GRAZE['Reins']} degrees about x (at most {best[0]:.2f} m off the neck); the neck at 55 alone leaves the "
      f"muzzle at {lowest([Head]):.2f} m")
pose({})

# Gaits for the previews (degrees about x). Trot: the left fore and right hind swing forward together,
# folded, while the other pair carries the horse. Gallop: the leading right fore reaching to land, the
# left fore pushing off behind, both hind legs swinging under.
TROT = {"Leg_FL": -18, "Shin_FL": 80, "Leg_FR": 14, "Shin_FR": 4, "Leg_BL": 15, "Shin_BL": -8, "Leg_BR": -16,
        "Shin_BR": -50, "Neck": 6, "Head": -3, "Reins": 3, "Tail": 15}
GALLOP = {"Leg_FR": -32, "Shin_FR": 6, "Leg_FL": 24, "Shin_FL": 35, "Leg_BL": -26, "Shin_BL": -65, "Leg_BR": -8,
          "Shin_BR": -40, "Neck": 18, "Head": -12, "Reins": 12, "Tail": 40, "Ear_L": -20, "Ear_R": -20}

# ---- Preview renders.
if PREVIEW:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 1280, 900
    world = bpy.data.worlds.new("Sky")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.55, 0.65, 0.8, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.8
    scene.world = world
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(50), 0, math.radians(40)))
    bpy.context.active_object.data.energy = 3.5
    bpy.ops.mesh.primitive_plane_add(size=60)
    bpy.context.active_object.data.materials.append(material("Grass", srgb("#55703a"), 0.9))
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    os.makedirs(PREVIEW, exist_ok=True)

    def shoot(label, at, target, lens=50):
        cam.location = at
        cam.data.lens = lens
        cam.rotation_euler = (Vector(target) - Vector(at)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(PREVIEW, f"{label}.png")
        bpy.ops.render.render(write_still=True)

    def stand_on(shin_names):
        """Lower or raise the horse until the lowest of these hooves touches the grass."""
        bpy.context.view_layer.update()
        Body.location.z -= lowest([OBJ[n] for n in shin_names])
        bpy.context.view_layer.update()

    pose({})
    shoot("horse_side", (7.5, 0.0, 1.0), (0, 0, 0.95))
    shoot("horse_front34", (4.2, -5.0, 1.7), (0, -0.3, 1.0))
    shoot("horse_rear34", (-4.0, 4.6, 1.8), (0, 0.2, 0.9))
    shoot("horse_head", (1.5, -2.5, 2.0), (0, -1.05, 1.72))
    pose(GRAZE)
    Reins.hide_render = True  # as the game should while grazing: a rigid rein can't follow the head down
    shoot("horse_grazing", (6.0, -2.5, 1.3), (0, -0.4, 0.8))
    Reins.hide_render = False
    pose(TROT)
    stand_on(["Shin_FR", "Shin_BL"])
    shoot("horse_trot", (6.5, -2.0, 1.1), (0, -0.2, 0.85))
    shoot("horse_trot_joints", (2.2, -1.6, 0.6), (0, -0.05, 0.45), 40)  # the folded knee and hock up close
    pose(GALLOP)
    stand_on(["Shin_FR"])
    shoot("horse_gallop", (7.5, 0.0, 1.0), (0, -0.1, 1.0))
    pose({})
    eye = Tack.matrix_world.translation + Vector((0, 0, 0.85))
    shoot("horse_saddle_view", eye, eye + Vector((0, -2.6, -1.45)), 24)

    def another(at, turn, colours, angles, hide=()):
        """A second horse sharing the meshes, recoloured the way the game will do it (materials by name)."""
        mats = {m.name: m for m in MATS}
        mats.update({name: material(name, srgb(c)) for name, c in colours.items()})
        copies = {o.name: link(o.copy()) for o in ALL}
        for o in ALL:
            c = copies[o.name]
            if o.parent:
                c.parent = copies[o.parent.name]
            for slot in c.material_slots:
                name = slot.material.name
                slot.link = "OBJECT"
                slot.material = mats[name]
            a = angles.get(o.name, 0)
            c.rotation_euler = [math.radians(v) for v in (a if isinstance(a, tuple) else (a, 0, 0))]
            c.hide_render = o.name in hide
        copies["Body"].location = at
        copies["Body"].rotation_euler.z = turn

    pose({})
    # A chestnut without markings (Marking painted in the coat colour), grazing, and a grey.
    another((-2.9, 1.6, 0), math.radians(40), {"Coat": "#a3592c", "Dark": "#7a3e1c", "Marking": "#a3592c"}, GRAZE,
            hide=("Reins",))
    another((2.7, 2.4, 0), math.radians(150), {"Coat": "#c9c7c1", "Dark": "#5c5854"}, {})
    shoot("horse_three", (4.5, -8.5, 2.4), (0, 1.0, 0.8), 40)
