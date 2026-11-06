"""Build the Tesla Model Y (2025, black) for the game in Blender, from its real sizes.

Run (Blender 5, no window):
  blender -b -P tools/model_y.py -- <out.glb> [preview_dir] [paint]

The body is lofted from cross-sections along its length: the side profile (roof,
hood, tail), the plan (width) and the window line come from the published sizes
(4.79 x 1.92 x 1.62 m, wheelbase 2.89 m, 19-inch wheels) and were checked against
photos of the car. Wheel arches are cut out of it. Everything else is laid on its
surface with ray casts: panel gaps, window frames, door handles, the light bars and
lamps, the black lower bumpers, the plate, the spoiler lip; the mirrors, a cabin
(seats, dash, screen, steering wheel) and the brake calipers are built in place.

Output: one GLB with the body and four wheels (Wheel_FL, Wheel_FR, Wheel_RL,
Wheel_RR, one shared mesh) whose origin is their axle, so the game can roll and
steer them; the brake discs roll with them, the calipers stay in the body.
Blender's -Y is the back of the car; in the GLB (three.js axes) the nose points to
-z. With preview_dir it also renders seven views there (paint: a colour like
0.5,0.5,0.5 to check the shape; default black).

Materials (the game swaps them by name): Paint, Glass, Trim, Tyre, Rim, RimDark,
LightBar, LampGlass, TailLight, and Gap (panel gaps), Chrome (mirror glass, lamp
reflectors), Disc, Caliper, Interior, Screen, Reflector, Plate.
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
PREVIEW = argv[1] if len(argv) > 1 else ""
PAINT = tuple(float(v) for v in argv[2].split(",")) if len(argv) > 2 else (0.012, 0.012, 0.013)

L = 4.79           # length
U_F, U_R = 0.93, 3.82  # axles, from the front bumper (wheelbase 2.89)
TYRE_R = 0.356     # 255/45 R19
TRACK = 1.636
ARCH_R = 0.43      # wheel arch radius
STATIONS = 90


def curve(points):
    """Smooth curve through (u, value) points without overshoot (monotone cubic)."""
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    n = len(points)
    d = [(ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) for i in range(n - 1)]
    m = [d[0]] + [0.0 if d[i - 1] * d[i] <= 0 else (d[i - 1] + d[i]) / 2 for i in range(1, n - 1)] + [d[-1]]
    for i in range(n - 1):
        if d[i] == 0:
            m[i] = m[i + 1] = 0
        else:
            a, b = m[i] / d[i], m[i + 1] / d[i]
            s = a * a + b * b
            if s > 9:
                t = 3 / math.sqrt(s)
                m[i], m[i + 1] = t * a * d[i], t * b * d[i]

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


# Side profile: the top of each cross-section (nose, hood, windshield, roof, rear glass,
# the ducktail lip, then the tail face going down) and its underside.
TOP = curve([(0.0, 0.66), (0.05, 0.745), (0.14, 0.79), (0.40, 0.835), (0.80, 0.915), (1.15, 0.99), (1.30, 1.025),
             (1.60, 1.22), (1.90, 1.44), (2.10, 1.545), (2.40, 1.605), (2.75, 1.624), (3.10, 1.605), (3.50, 1.545),
             (3.90, 1.43), (4.25, 1.29), (4.50, 1.18), (4.60, 1.14), (4.66, 1.08), (4.73, 0.84), (4.79, 0.58)])
BOTTOM = curve([(0.0, 0.43), (0.05, 0.29), (0.16, 0.22), (0.45, 0.20), (1.0, 0.19), (4.30, 0.20), (4.55, 0.26),
                (4.70, 0.32), (4.79, 0.40)])
# Plan: half the body's width, and half the width of the roof (or of the hood's top).
WIDTH = curve([(0.0, 0.62), (0.03, 0.70), (0.08, 0.78), (0.16, 0.85), (0.35, 0.91), (0.70, 0.95), (1.0, 0.96), (3.70, 0.96),
               (4.20, 0.94), (4.50, 0.90), (4.65, 0.85), (4.75, 0.77), (4.79, 0.66)])
ROOF = curve([(0.0, 0.40), (0.15, 0.62), (0.60, 0.72), (1.30, 0.79), (2.10, 0.665), (2.70, 0.64), (3.50, 0.62),
              (4.20, 0.60), (4.50, 0.63), (4.65, 0.65), (4.79, 0.54)])


def rounded_nose(f, u_join, tip, p=3.0):
    """Round the nose off: towards u=0 the curve bends to `tip` like a superellipse (steep at the tip,
    joining the curve at u_join with the same slope)."""
    def g(u):
        if u >= u_join:
            return f(u)
        q = max(0.0, u / u_join)
        return tip + (f(u) - tip) * (1 - (1 - q) ** p) ** (1 / p)
    return g


TOP = rounded_nose(TOP, 0.30, 0.53)
BOTTOM = rounded_nose(BOTTOM, 0.30, 0.47)
WIDTH = rounded_nose(WIDTH, 0.30, 0.05)
# Bottom edge of the side windows: from the windshield's foot, rising a little towards the back.
BELT = curve([(1.30, 1.04), (1.80, 1.10), (2.60, 1.13), (3.40, 1.17), (4.00, 1.21), (4.50, 1.20)])
GREENHOUSE = (1.30, 4.50)
U_QW = 4.06        # the side glass (rear quarter window) ends here; behind it the C-pillar is painted


def belt(u):
    return BELT(u) if GREENHOUSE[0] <= u <= GREENHOUSE[1] else 99.0


def section(u):
    """Half a cross-section at u, from the bottom middle round to the top middle: (x, z) points,
    the belt height and the window's key points (lx, lz: its bottom edge; tx, tz: its top edge)."""
    zb, zt, w = BOTTOM(u), TOP(u), WIDTH(u)
    k = min(1.0, w / 0.6)            # the small sections at the tip of the nose scale their details down
    drop = 0.05 * min(1.0, (zt - zb) / 0.25)
    wr = min(ROOF(u), w - 0.14 * k)
    bl = min(belt(u), zt)
    glass = max(0.0, min(1.0, (zt - bl) / 0.1))
    crown = lambda x: zt - drop * (x / w) ** 2
    zs = min(bl, crown(w) - drop)  # top of the side: the shoulder
    rb = min(0.10, (zs - zb) * 0.3)
    pts = [(t * (w - rb), zb) for t in (0.0, 0.35, 0.7)]
    for a in (0.3, 0.6, 0.85):  # rounded bottom corner
        ang = a * math.pi / 2
        pts.append((w - rb + rb * math.sin(ang) - 0.01 * w, zb + rb - rb * math.cos(ang)))
    for t in (0.0, 0.25, 0.5, 0.75, 1.0):  # tucked in at the bottom, widest at 60%, rolling in to the shoulder
        z = zb + rb + (zs - zb - rb) * t
        x = w * (0.975 + 0.025 * math.sin(math.pi / 2 * t / 0.6)) if t <= 0.6 else w - 0.03 * ((t - 0.6) / 0.4) ** 2
        pts.append((x, z))
    lx = w - 0.08 * k
    lz = min(bl + 0.012, crown(lx))
    pts.append((w - 0.035 * k, (zs + lz) / 2 + 0.004 * k))
    pts.append((lx, lz))
    tx = wr + 0.06 * k
    tz = crown(tx) - 0.035 * glass
    for t in (0.25, 0.5, 0.75):  # side glass leaning in (or the edge of the hood)
        bow = 0.012 * glass * math.sin(math.pi * t)
        pts.append((lx + (tx - lx) * t + bow, lz + (tz - lz) * t))
    pts.append((tx, tz))
    pts.append((wr + 0.02 * k, crown(wr + 0.02 * k) - 0.008 * glass))
    for t in (0.0, 0.25, 0.5, 0.75, 1.0):
        x = wr * (1 - t)
        pts.append((x, crown(x)))
    return pts, bl, {"lx": lx, "lz": lz, "tx": tx, "tz": tz}


def key(u, name):
    return section(u)[2][name]


def material(name, color, rough=0.5, metal=0.0, emit=None, strength=0.0, coat=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    if coat:
        p.inputs["Coat Weight"].default_value = coat
    if emit:
        p.inputs["Emission Color"].default_value = (*emit, 1)
        p.inputs["Emission Strength"].default_value = strength
    return m


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def apply(obj, mod):
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    obj.select_set(False)


bpy.ops.wm.read_factory_settings(use_empty=True)
MAT = {
    "Paint": material("Paint", PAINT, 0.18, 0.0, coat=1.0),
    "Glass": material("Glass", (0.01, 0.011, 0.012), 0.04, 0.0),
    "Trim": material("Trim", (0.02, 0.02, 0.02), 0.55),
    "Tyre": material("Tyre", (0.015, 0.015, 0.015), 0.85),
    "Rim": material("Rim", (0.42, 0.43, 0.45), 0.3, 0.9),
    "RimDark": material("RimDark", (0.012, 0.012, 0.012), 0.3, 0.3),
    "LightBar": material("LightBar", (0.9, 0.95, 1.0), 0.1, emit=(0.85, 0.92, 1.0), strength=4.0),
    "LampGlass": material("LampGlass", (0.01, 0.01, 0.012), 0.05),
    "TailLight": material("TailLight", (0.5, 0.02, 0.02), 0.2, emit=(1.0, 0.05, 0.03), strength=1.5),
    # New in the second round.
    "Gap": material("Gap", (0.0, 0.0, 0.0), 0.9),
    "Chrome": material("Chrome", (0.8, 0.8, 0.82), 0.06, 1.0),
    "Disc": material("Disc", (0.3, 0.3, 0.31), 0.4, 0.9),
    "Caliper": material("Caliper", (0.07, 0.07, 0.075), 0.45, 0.3),
    "Interior": material("Interior", (0.025, 0.025, 0.027), 0.75),
    "Screen": material("Screen", (0.008, 0.01, 0.014), 0.08),
    "Reflector": material("Reflector", (0.45, 0.02, 0.02), 0.3),
    "Plate": material("Plate", (0.85, 0.85, 0.82), 0.45),
}
ORDER = list(MAT)

# ---- Body: rings of cross-sections, closed at both ends.
# Closer together at the ends. The tail stops 1 cm short so the plate on it stays within the car's length.
L_BODY = L - 0.01
us = [L_BODY * (1 - math.cos(math.pi * i / (STATIONS - 1))) / 2 for i in range(STATIONS)]
# The ring where the side glass stops (the rear edge of the quarter window): faces behind it are painted.
U_QW_EDGE = min(us[k] for k in range(1, STATIONS) if (us[k - 1] + us[k]) / 2 > U_QW)
bm = bmesh.new()
rings = []
for u in us:
    half, _, _ = section(u)
    full = half + [(-x, z) for x, z in reversed(half[1:-1])]
    rings.append([bm.verts.new((x, L / 2 - u, z)) for x, z in full])
n = len(rings[0])
for a, b in zip(rings, rings[1:]):
    for i in range(n):
        bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
for ring, flip in ((rings[0], True), (rings[-1], False)):
    mid = bm.verts.new(sum((v.co for v in ring), Vector()) / n)
    for i in range(n):
        f = (ring[i], ring[(i + 1) % n], mid)
        bm.faces.new(f[::-1] if flip else f)
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
for f in bm.faces:
    c = f.calc_center_median()
    u = L / 2 - c.y
    x, z = abs(c.x), c.z
    w = WIDTH(u)
    bl = min(belt(u), TOP(u))
    name = "Paint"
    if GREENHOUSE[0] + 0.02 < u < GREENHOUSE[1] - 0.02 and z > bl + 0.015 and x < w - 0.075 and TOP(u) - bl > 0.03 \
            and not (u > U_QW and x > ROOF(u) + 0.035):
        name = "Glass"
    elif f.normal.z < -0.6:
        name = "Trim"  # underside
    f.material_index = ORDER.index(name)
mesh = bpy.data.meshes.new("Body")
bm.to_mesh(mesh)
bm.free()
body = link(bpy.data.objects.new("Body", mesh))
for m in MAT.values():
    mesh.materials.append(m)
for p in mesh.polygons:
    p.use_smooth = True

# Wheel arches: cut from the sides (their inside, the liner, is black).
for u in (U_F, U_R):
    for side in (-1, 1):
        bpy.ops.mesh.primitive_cylinder_add(vertices=56, radius=ARCH_R, depth=0.7, location=(side * 1.0, L / 2 - u, TYRE_R),
                                            rotation=(0, math.pi / 2, 0))
        cut = bpy.context.active_object
        cut.data.materials.append(MAT["Trim"])
        mod = body.modifiers.new("arch", "BOOLEAN")
        mod.operation = "DIFFERENCE"
        mod.solver = "EXACT"
        mod.object = cut
        if hasattr(mod, "material_mode"):
            mod.material_mode = "TRANSFER"
        apply(body, mod)
        bpy.data.objects.remove(cut)
body.data.set_sharp_from_angle(angle=math.radians(65))

# ---- Everything else is built into one more mesh, mostly laid on the body's surface.
deps = bpy.context.evaluated_depsgraph_get()
tree = BVHTree.FromObject(body, deps)


class Builder:
    """A mesh made of many small parts, each face with its material."""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.mats = []

    def v(self, co):
        return self.bm.verts.new(co)

    def face(self, vs, mat, hint=None):
        f = self.bm.faces.new(vs)
        if mat not in self.mats:
            self.mats.append(mat)
        f.material_index = self.mats.index(mat)
        if hint is not None:
            f.normal_update()
            if f.normal.dot(hint) < 0:
                f.normal_flip()
        return f

    def merge(self, other, mat):
        """Copy a finished bmesh in (its faces keep their winding)."""
        vmap = {v: self.v(v.co) for v in other.verts}
        for f in other.faces:
            self.face([vmap[v] for v in f.verts], mat)

    def obj(self):
        me = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(me)
        self.bm.free()
        for m in self.mats:
            me.materials.append(MAT[m])
        for p in me.polygons:
            p.use_smooth = True
        return link(bpy.data.objects.new(self.name, me))


def cast(origin, direction):
    """Where a ray meets the body: (point, outward normal), or None."""
    loc, nrm, _, _ = tree.ray_cast(Vector(origin), Vector(direction).normalized())
    return (loc, nrm) if loc is not None else None


def side_ray(s):
    """Rays from the right (s=1) or left (s=-1) side at (u, z)."""
    return lambda u, z: cast((s * 2.0, L / 2 - u, z), (-s, 0, 0))


def top_ray(u, x):
    return cast((x, L / 2 - u, 3.0), (0, 0, -1))


def back_ray(x, z):
    return cast((x, -L / 2 - 1.0, z), (0, 1, 0))


def radial(front, u0):
    """Rays from inside the body (at u0 on the middle line) out through the nose or tail, at an angle
    (degrees, + to the right) and a height: they wrap round the corners."""
    def f(deg, z):
        a = math.radians(deg)
        return cast((0, L / 2 - u0, z), (math.sin(a), math.cos(a) if front else -math.cos(a), 0))
    return f


FRONT = radial(True, 0.42)
REAR = radial(False, 4.30)


def across(a, b, n=40):
    return [a + (b - a) * i / n for i in range(n + 1)]


def dense(pts, step):
    """More points along a polyline, about `step` apart."""
    out = []
    for (a0, b0), (a1, b1) in zip(pts, pts[1:]):
        k = max(1, int(math.hypot(a1 - a0, b1 - b0) / step))
        out += [(a0 + (a1 - a0) * i / k, b0 + (b1 - b0) * i / k) for i in range(k)]
    out.append(pts[-1])
    return out


def rounded_rect(ca, cb, wa, wb, r, n=4):
    """A closed rounded rectangle in some (a, b) space, as a point list."""
    pts = []
    for qa, qb, start in ((1, 1, 0), (-1, 1, 90), (-1, -1, 180), (1, -1, 270)):
        oa, ob = ca + qa * (wa / 2 - r), cb + qb * (wb / 2 - r)
        for i in range(n + 1):
            t = math.radians(start + 90 * i / n)
            pts.append((oa + r * math.cos(t), ob + r * math.sin(t)))
    return pts


def ribbon(B, hits, width, mat, out=0.0025, closed=False):
    """A band of a given width along surface points (from ray casts), lying on the surface."""
    hits = [h for h in hits if h]
    if len(hits) < 2:
        return
    n = len(hits)
    rows = []
    for i, (p, nrm) in enumerate(hits):
        a = hits[(i - 1) % n][0] if (closed or i > 0) else p
        b = hits[(i + 1) % n][0] if (closed or i < n - 1) else p
        t = b - a
        if t.length < 1e-7:
            continue
        s = nrm.cross(t).normalized()
        w = width(i / (n - 1)) if callable(width) else width
        rows.append((B.v(p + s * w / 2 + nrm * out), B.v(p - s * w / 2 + nrm * out), nrm))
    segs = len(rows) if closed else len(rows) - 1
    for i in range(segs):
        (a0, b0, n0), (a1, b1, n1) = rows[i], rows[(i + 1) % len(rows)]
        B.face((a0, a1, b1, b0), mat, n0 + n1)


def panel(B, ray, a_vals, b_fn, mat, out=0.003, skirt=0.003):
    """A raised panel on the body: a grid of ray hits, ray(a, b) for each a and each b in b_fn(a),
    lifted by `out`, with a little edge (skirt) going down into the surface."""
    grid = [[ray(a, b) for b in b_fn(a)] for a in a_vals]
    V = [[(B.v(h[0] + h[1] * out), h) if h else None for h in row] for row in grid]
    na, nb = len(V), len(V[0])
    centre = Vector()
    count = 0
    for i in range(na - 1):
        for j in range(nb - 1):
            q = (V[i][j], V[i + 1][j], V[i + 1][j + 1], V[i][j + 1])
            if all(q) and max((q[k][0].co - q[(k + 1) % 4][0].co).length for k in range(4)) < 0.12:
                B.face([c[0] for c in q], mat, sum((c[1][1] for c in q), Vector()))
                centre += q[0][0].co
                count += 1
    if not skirt or not count:
        return
    centre /= count
    loop = [(0, j) for j in range(nb)] + [(i, nb - 1) for i in range(1, na)] + \
           [(na - 1, j) for j in range(nb - 2, -1, -1)] + [(i, 0) for i in range(na - 2, 0, -1)]
    low = {}
    for (i0, j0), (i1, j1) in zip(loop, loop[1:] + loop[:1]):
        c0, c1 = V[i0][j0], V[i1][j1]
        if not c0 or not c1:
            continue
        for key_, c in (((i0, j0), c0), ((i1, j1), c1)):
            if key_ not in low:
                p, nrm = c[1]
                low[key_] = B.v(p - nrm * 0.002)
        mid = (c0[0].co + c1[0].co) / 2
        B.face((c0[0], c1[0], low[(i1, j1)], low[(i0, j0)]), mat, mid - centre)


def rounded_panel(B, ray, ca, cb, wa, wb, r, mat, na=12, nb=6, out=0.003, skirt=0.003):
    """A raised rounded rectangle centred at (ca, cb) in the ray's (a, b) space."""
    def half(a):
        d = abs(a - ca) - (wa / 2 - r)
        return wb / 2 - r + (math.sqrt(max(0.0, r * r - d * d)) if d > 0 else r)
    a_vals = across(ca - wa / 2 + 1e-4, ca + wa / 2 - 1e-4, na)
    panel(B, ray, a_vals, lambda a: across(cb - half(a), cb + half(a), nb), mat, out, skirt)


def rbox(B, mat, size, radius, matrix, segs=2):
    """A box with rounded edges, size (x, y, z), placed by a 4x4 matrix."""
    t = bmesh.new()
    bmesh.ops.create_cube(t, size=1.0)
    bmesh.ops.scale(t, vec=Vector(size), verts=t.verts)
    bmesh.ops.bevel(t, geom=list(t.verts) + list(t.edges), offset=radius, segments=segs, affect="EDGES", profile=0.5)
    bmesh.ops.transform(t, matrix=matrix, verts=t.verts)
    B.merge(t, mat)
    t.free()


def place(x, u, z, tilt=0.0):
    """A matrix at (x, u, z) in car terms, tilted about the car's X axis (degrees, + leans the top back)."""
    return Matrix.Translation((x, L / 2 - u, z)) @ Matrix.Rotation(math.radians(tilt), 4, "X")


B = Builder("Details")

# ---- Front: the light bar across the nose under the hood's edge, the low headlights at the corners,
# the black lower bumper with its wide intake, and the slots at its corners.
# Angles of the rays from inside the nose map to these x on the surface: 50 -> 0.48 m, 60 -> 0.65, 70 -> 0.80, 80 -> 0.88.
# The light bar: thin in the middle, wider towards the corners, in a dark channel, wrapping round them.
bar_a = across(-80, 80, 80)
panel(B, FRONT, bar_a, lambda a: across(0.731, 0.766, 2), "LampGlass", out=0.003, skirt=0.003)
bar_h = lambda a: 0.0055 + 0.0045 * min(1.0, abs(a) / 66) ** 2
panel(B, FRONT, across(-78.5, 78.5, 80), lambda a: across(0.748 - bar_h(a), 0.749 + bar_h(a), 1), "LightBar", out=0.0045,
      skirt=0)
for s in (-1, 1):
    # Headlight: a slim wedge, deeper at the outer end, its top edge lit, a reflector inside.
    lo = lambda a: 0.603 - 0.03 * (abs(a) - 55) / 21
    hi = lambda a: 0.628 + 0.012 * (abs(a) - 55) / 21
    a_vals = across(s * 55, s * 76, 16)
    panel(B, FRONT, a_vals, lambda a: across(lo(a), hi(a), 3), "LampGlass", out=0.004, skirt=0.004)
    ribbon(B, [FRONT(a, hi(a) - 0.004) for a in a_vals], 0.006, "LightBar", out=0.0055)
    panel(B, FRONT, across(s * 62, s * 70, 5), lambda a: across(lo(a) + 0.008, lo(a) + 0.024, 1), "Chrome", out=0.0052,
          skirt=0)
    # The vertical black slot at the bumper's corner, from the headlight's outer end down to the black band.
    ribbon(B, [FRONT(s * (75.5 - 1.5 * (0.575 - z) / 0.205), z) for z in across(0.575, 0.37, 12)], 0.026, "Trim", out=0.003)
# Lower bumper: a black band almost as wide as the car with the intake in it, the lip below.
panel(B, FRONT, across(-72, 72, 56), lambda a: across(0.224, 0.372 - 0.035 * max(0.0, abs(a) - 62) / 10, 5), "Trim",
      out=0.004, skirt=0.004)
panel(B, FRONT, across(-57, 57, 44), lambda a: across(0.252, 0.350 - 0.012 * max(0.0, abs(a) - 50) / 7, 3), "Gap",
      out=0.0055, skirt=0)
for z in (0.284, 0.318):
    ribbon(B, [FRONT(a, z) for a in across(-56.5, 56.5, 44)], 0.007, "Trim", out=0.0068)
for s in (-1, 1):
    panel(B, FRONT, across(s * 72, s * 84, 6), lambda a: across(0.224, 0.246, 1), "Trim", out=0.004, skirt=0.004)
ribbon(B, [FRONT(0.0 + 1.6 * math.cos(t), 0.405 + 0.011 * math.sin(t)) for t in across(0, 2 * math.pi, 16)],
       0.012, "Gap", out=0.002, closed=True)  # front camera
ribbon(B, [FRONT(50 + 2.6 * math.cos(t), 0.48 + 0.024 * math.sin(t)) for t in across(0, 2 * math.pi, 20)],
       0.005, "Gap", out=0.002, closed=True)  # tow hook cover
for s in (-1, 1):  # where the bumper meets the front fender, from the light bar's end down to the arch
    ribbon(B, [side_ray(s)(u, z) for u, z in dense([(0.24, 0.722), (0.36, 0.672), (0.47, 0.615), (0.53, 0.585)], 0.02)],
           0.007, "Gap")
# Wipers parked at the foot of the windshield, and the camera housing at its top.
ribbon(B, [top_ray(u, x) for u, x in dense([(1.452, -0.70), (1.43, -0.30), (1.415, 0.02)], 0.03)], 0.016, "Trim", out=0.009)
ribbon(B, [top_ray(u, x) for u, x in dense([(1.445, 0.08), (1.425, 0.35), (1.41, 0.62)], 0.03)], 0.016, "Trim", out=0.009)
rounded_panel(B, lambda x, u: top_ray(u, x), 0.0, 2.29, 0.17, 0.13, 0.03, "Gap", na=8, nb=4, out=0.0025, skirt=0)

# ---- Hood (frunk) gaps: along the fender tops back to the cowl, and across under the windshield.
for s in (-1, 1):
    ribbon(B, [top_ray(u, s * x) for u, x in dense([(0.17, 0.80), (0.40, 0.78), (0.80, 0.745), (1.10, 0.718), (1.27, 0.70)],
                                                     0.02)], 0.008, "Gap")
ribbon(B, [top_ray(1.27, x) for x in across(-0.70, 0.70, 50)], 0.008, "Gap")

# ---- Sides.
for s in (-1, 1):
    side = side_ray(s)
    lz = lambda u: key(u, "lz")
    tz = lambda u: key(u, "tz")
    # Door gaps: three lines from the window down to the sill (the last one stops at the arch).
    for line in ([(1.530, lz(1.53)), (1.526, 0.86), (1.522, 0.56), (1.535, 0.345)],
                 [(2.565, lz(2.565)), (2.567, 0.86), (2.570, 0.56), (2.573, 0.345)],
                 [(3.600, lz(3.60)), (3.585, 0.95), (3.548, 0.79), (3.49, 0.672)]):
        ribbon(B, [side(u, z) for u, z in dense(line, 0.02)], 0.008, "Gap")
    # Black window frames: the sill, the top edge (wide at the A-pillar), the B-pillar, the pillar between
    # the rear door glass and the quarter window, and the quarter window's rear edge.
    ribbon(B, [side(u, lz(u) + 0.002) for u in across(1.50, U_QW_EDGE, 70)], 0.022, "LampGlass", out=0.003)
    ribbon(B, [side(u, tz(u) - 0.012) for u in across(1.40, U_QW_EDGE, 70)],
           lambda t: 0.058 - 0.033 * min(1.0, max(0.0, (t - 0.18) / 0.12)), "LampGlass", out=0.003)
    panel(B, side, across(2.505, 2.625, 3), lambda u: across(lz(u) + 0.004, tz(u) - 0.01, 6), "LampGlass", out=0.003,
          skirt=0.003)
    ribbon(B, [side(3.625, z) for z in across(lz(3.625) + 0.004, tz(3.625) - 0.01, 8)], 0.028, "LampGlass", out=0.003)
    ribbon(B, [side(U_QW_EDGE, z) for z in across(lz(U_QW_EDGE), tz(U_QW_EDGE) - 0.012, 8)], 0.03, "LampGlass", out=0.003)
    # Black sill between the arches.
    panel(B, side, across(1.375, 3.375, 30), lambda u: across(0.194, 0.335, 8), "Trim", out=0.005, skirt=0.005)
    # Flush door handles near each door's rear edge: a body-coloured lever in a dark outline, a pocket at its front.
    for cu in (2.425, 3.445):
        cz = lz(cu) - 0.092
        ribbon(B, [side(u, z) for u, z in rounded_rect(cu, cz, 0.172, 0.032, 0.012)], 0.005, "Gap", out=0.0022, closed=True)
        rounded_panel(B, side, cu, cz, 0.166, 0.026, 0.01, "Paint", out=0.0035, skirt=0.0035)
        pocket = cu - 0.058  # its front end (towards the nose)
        rounded_panel(B, side, pocket, cz, 0.04, 0.02, 0.008, "Gap", na=6, nb=3, out=0.0042, skirt=0)
    # Side repeater camera on the front fender: a small dark wedge.
    panel(B, side, across(1.385, 1.455, 6), lambda u: across(0.872 + (u - 1.385) * 0.18, 0.898 - (u - 1.385) * 0.12, 2),
          "LampGlass", out=0.004, skirt=0.004)
# Charge port flap, rear left.
ribbon(B, [side_ray(-1)(u, z) for u, z in rounded_rect(4.46, 0.985, 0.115, 0.088, 0.02, 5)], 0.006, "Gap",
       out=0.0022, closed=True)

# ---- Glass roof: the cross bar behind the windshield, the seam to the tailgate glass; the rear glass's sides.
ribbon(B, [top_ray(2.42, x) for x in across(-ROOF(2.42) - 0.045, ROOF(2.42) + 0.045, 40)], 0.045, "Paint", out=0.003)
ribbon(B, [top_ray(3.72, x) for x in across(-ROOF(3.72) - 0.07, ROOF(3.72) + 0.07, 50)], 0.012, "Gap", out=0.0025)
for s in (-1, 1):
    ribbon(B, [top_ray(u, s * (ROOF(u) + 0.02)) for u in across(3.72, 4.40, 24)], 0.022, "LampGlass", out=0.003)
    # The tailgate's sides across the deck behind the glass.
    ribbon(B, [top_ray(u, s * x) for u, x in dense([(4.40, ROOF(4.40) + 0.025), (4.50, 0.655), (4.585, 0.64)], 0.015)],
           0.008, "Gap")

# ---- Rear: the spoiler lip, the tail light bar, the tailgate's lines, the black lower bumper and the plate.
# Spoiler lip: the deck kicks up into a sharp edge that overhangs the light bar.
lip_rows = []
for x in across(-0.74, 0.74, 56):
    k = min(1.0, (0.74 - abs(x)) / 0.16)
    k = max(0.1, k * k * (3 - 2 * k))
    top = [top_ray(u, x) for u in (4.47, 4.52, 4.565, 4.612)]
    if not all(top):
        continue
    lift = (0.0006, 0.004 * k, 0.010 * k, 0.016 * k)
    row = [h[0] + Vector((0, 0, d)) for h, d in zip(top, lift)]
    edge = row[-1] + Vector((0, -0.045 * k, -0.002 * k))
    row += [edge, edge + Vector((0, 0, -0.011 * k - 0.002)), top[-1][0] + Vector((0, 0.008, -0.036))]
    lip_rows.append([B.v(p) for p in row])
for r0, r1 in zip(lip_rows, lip_rows[1:]):
    for j in range(len(r0) - 1):
        hint = Vector((0, 0, 1)) if j < 4 else (Vector((0, -1, 0)) if j == 4 else Vector((0, 0, -1)))
        B.face((r0[j], r1[j], r1[j + 1], r0[j + 1]), "Paint", hint)
for r, hint in ((lip_rows[0], Vector((-1, 0, 0))), (lip_rows[-1], Vector((1, 0, 0)))):
    B.face(r, "Paint", hint)
# Tail light bar: a smoked housing across the back, the red element in it with a dark inner bar under it,
# a C-shaped lamp at each corner and the rear camera at the top.
panel(B, REAR, across(-74, 74, 80), lambda a: across(1.012, 1.098, 3), "LampGlass", out=0.004, skirt=0.004)
panel(B, REAR, across(-62, 62, 70), lambda a: across(1.046, 1.071, 1), "TailLight", out=0.0055, skirt=0)
ribbon(B, [REAR(a, 1.031) for a in across(-60, 60, 80)], 0.006, "Gap", out=0.0055)
for s in (-1, 1):
    panel(B, REAR, across(s * 63.5, s * 72.5, 8), lambda a: across(1.020, 1.074, 4), "TailLight", out=0.0055, skirt=0)
    panel(B, REAR, across(s * 63.0, s * 70.6, 7), lambda a: across(1.031, 1.062, 2), "LampGlass", out=0.0068, skirt=0)
ribbon(B, [REAR(1.3 * math.cos(t), 1.085 + 0.008 * math.sin(t)) for t in across(0, 2 * math.pi, 14)], 0.009, "Gap",
       out=0.0058, closed=True)
# Tailgate: its sides down from the light bar and its bottom edge.
for s in (-1, 1):
    ribbon(B, [back_ray(s * x, z) for x, z in dense([(0.612, 1.008), (0.608, 0.75), (0.598, 0.585)], 0.015)], 0.008, "Gap")
# Black lower bumper with a crease, wrapping round the corners to the arches; the plate in a recess; reflectors.
lower_top = lambda a: 0.565 if abs(a) < 50 else (0.565 - 0.135 * min(1.0, (abs(a) - 50) / 14) ** 1.5 if abs(a) < 64
                                                 else 0.43 - 0.07 * (abs(a) - 64) / 25)
panel(B, REAR, across(-89, 89, 64), lambda a: across(0.212, lower_top(a), 8), "Trim", out=0.005, skirt=0.005)
ribbon(B, [REAR(a, 0.335) for a in across(-70, 70, 90)], 0.008, "Gap", out=0.0062)
rounded_panel(B, back_ray, 0.0, 0.47, 0.57, 0.135, 0.015, "Gap", na=20, nb=4, out=0.0062, skirt=0)
rounded_panel(B, back_ray, 0.0, 0.47, 0.52, 0.11, 0.008, "Plate", na=16, nb=3, out=0.0085, skirt=0.0025)
for s in (-1, 1):
    panel(B, REAR, across(s * 40, s * 48, 6), lambda a: across(0.538, 0.551, 1), "Reflector", out=0.0062, skirt=0)

# ---- Mirrors: a rounded housing on a short arm, the glass facing back, a lens strip at its front edge.
for s in (-1, 1):
    x0, x1, yb = 0.885, 1.075, L / 2 - 1.725
    secs = []
    for i in range(12):
        t = i / 11
        cap = math.sqrt(max(0.0, 1 - ((t - 0.7) / 0.3) ** 2)) if t > 0.7 else 1.0
        cap = max(cap, 0.12)
        # Flat top; the bottom curves up towards the door and a little towards the tip.
        z_top = 1.212 + 0.006 * t
        z_bot = 1.098 + (0.036 * (1 - t / 0.45) ** 2 if t < 0.45 else 0.022 * ((t - 0.45) / 0.55) ** 2)
        h = (z_top - z_bot) * cap
        zc = (z_top + z_bot) / 2
        d = (0.086 + 0.02 * math.sin(math.pi * min(1.0, t / 0.8))) * (0.4 + 0.6 * cap)
        x = s * (x0 + (x1 - x0) * t)
        ring = []
        for k in range(16):
            th = 2 * math.pi * k / 16
            c, sn = math.cos(th), math.sin(th)
            p = 2.4 if c > 0 else 7.0
            yy = math.copysign(abs(c) ** (2 / p), c) * d / 2
            zz = math.copysign(abs(sn) ** (2 / p), sn) * h / 2
            ring.append((Vector((x, yb + d / 2 + yy, zc + zz)), (yb + d / 2, zc)))
        secs.append(ring)
    vs = [[B.v(p) for p, _ in ring] for ring in secs]
    for i in range(11):
        for k in range(16):
            p, (cy, cz) = secs[i][k]
            B.face((vs[i][k], vs[i + 1][k], vs[i + 1][(k + 1) % 16], vs[i][(k + 1) % 16]), "Paint",
                   Vector((0, p.y - cy, p.z - cz)))
    B.face(vs[0], "Paint", Vector((-s, 0, 0)))
    B.face(vs[-1], "Paint", Vector((s, 0, 0)))
    # Glass on the back face, a little inside the housing's outline.
    rows = []
    for i in range(1, 10):
        ring = secs[i]
        h = max(p.z for p, _ in ring) - min(p.z for p, _ in ring)
        cz = ring[0][1][1]
        rows.append((B.v((ring[0][0].x, yb - 0.0025, cz - 0.4 * h)), B.v((ring[0][0].x, yb - 0.0025, cz + 0.4 * h))))
    for (a0, b0), (a1, b1) in zip(rows, rows[1:]):
        B.face((a0, a1, b1, b0), "Chrome", Vector((0, -1, 0)))
    # Lens strip low on the front, towards the outer end.
    strip = []
    for i in range(5, 11):
        pa, (cy, cz) = secs[i][15]
        pb, _ = secs[i][14]
        na = Vector((0, pa.y - cy, pa.z - cz)).normalized()
        nb = Vector((0, pb.y - cy, pb.z - cz)).normalized()
        strip.append((B.v(pa + na * 0.0015), B.v(pb + nb * 0.0015), na + nb))
    for (a0, b0, n0), (a1, b1, _) in zip(strip, strip[1:]):
        B.face((a0, a1, b1, b0), "LampGlass", n0)
    # The arm from the door.
    rbox(B, "Paint", (0.09, 0.055, 0.04), 0.014, place(s * 0.872, 1.70, 1.098) @ Matrix.Rotation(-s * 0.4, 4, "Y"))

# ---- Brake calipers: in the body (they must not roll), on the top of each disc, a little to the rear.
for u, alpha, span in ((U_F, 6, 40), (U_R, 30, 44)):
    for s in (-1, 1):
        cx, cy, cz = s * TRACK / 2, L / 2 - u, TYRE_R
        rings_c = []
        for i in range(7):
            a = math.radians(alpha - span / 2 + span * i / 6)
            dy, dz = -math.sin(a), math.cos(a)
            rings_c.append([B.v((cx + s * xl, cy + r * dy, cz + r * dz))
                            for r, xl in ((0.122, -0.048), (0.192, -0.048), (0.192, 0.014), (0.122, 0.014))])
        mid = Vector((cx + s * -0.017, cy - 0.157 * math.sin(math.radians(alpha)), cz + 0.157 * math.cos(math.radians(alpha))))
        for r0, r1 in zip(rings_c, rings_c[1:]):
            for k in range(4):
                q = (r0[k], r1[k], r1[(k + 1) % 4], r0[(k + 1) % 4])
                B.face(q, "Caliper", sum((v.co for v in q), Vector()) / 4 - mid)
        for r in (rings_c[0], rings_c[-1]):
            B.face(r, "Caliper", sum((v.co for v in r), Vector()) / 4 - mid)

# ---- Cabin, seen through the glass: a dark tub (floor, door panels, the boot), the dash with its screen,
# the steering wheel (round, on the left), two front seats, the rear bench and the console between.
tub = []
for u in across(1.40, 4.40, 26):
    info = section(u)[2]
    lx, bl = info["lx"], min(belt(u), TOP(u))
    zt = min(bl, TOP(u) - 0.03) - 0.004
    w_in = lx - 0.045
    arch = min(1.0, max(0.0, (u - 3.28) / 0.08)) * min(1.0, max(0.0, (4.38 - u) / 0.08))
    w_lo = w_in + (0.61 - w_in) * arch
    floor = 0.36 + 0.26 * min(1.0, max(0.0, (u - 3.80) / 0.15))
    half = [(lx - 0.008, zt), (w_in, zt), (w_in, 0.875), (w_lo, 0.855), (w_lo, floor + 0.03), (w_lo - 0.03, floor)]
    full = [(-x, z) for x, z in half] + [(x, z) for x, z in reversed(half)]
    tub.append((u, full))
tv = [[B.v((x, L / 2 - u, z)) for x, z in full] for u, full in tub]
for (u0, f0), r0, r1 in zip(tub, tv, tv[1:]):
    for j in range(len(f0) - 1):
        (xa, za), (xb, zb) = f0[j], f0[j + 1]
        dx, dz = xb - xa, zb - za
        B.face((r0[j], r0[j + 1], r1[j + 1], r1[j]), "Interior", Vector((-dz, 0, dx)))
B.face(tv[0][1:-1], "Interior", Vector((0, -1, 0)))
B.face(tv[-1][1:-1], "Interior", Vector((0, 1, 0)))
# Dash: a long rounded block under the windshield.
dash_sec = [(1.40, 0.985), (1.60, 0.982), (1.78, 0.972), (1.86, 0.957), (1.895, 0.928), (1.905, 0.885), (1.895, 0.78),
            (1.86, 0.70), (1.75, 0.62), (1.42, 0.60)]
dash = []
for x in (-0.79, -0.775, -0.70, -0.35, 0.0, 0.35, 0.70, 0.775, 0.79):
    k = 0.9 if abs(x) > 0.78 else (0.97 if abs(x) > 0.77 else 1.0)
    cu, cz = 1.65, 0.80
    dash.append([B.v((x, L / 2 - (cu + (u - cu) * k), cz + (z - cz) * k)) for u, z in dash_sec])
dmid = Vector((0, L / 2 - 1.65, 0.80))
for r0, r1 in zip(dash, dash[1:]):
    for j in range(len(dash_sec)):
        q = (r0[j], r0[(j + 1) % len(dash_sec)], r1[(j + 1) % len(dash_sec)], r1[j])
        c = sum((v.co for v in q), Vector()) / 4
        B.face(q, "Interior", Vector((0, c.y - dmid.y, c.z - dmid.z)))
B.face(dash[0], "Interior", Vector((-1, 0, 0)))
B.face(dash[-1], "Interior", Vector((1, 0, 0)))
# Screen: landscape, standing on the middle of the dash, leaning back a little.
scr = place(0.0, 1.865, 1.07, -16)
rbox(B, "Interior", (0.36, 0.024, 0.225), 0.006, scr, segs=1)
sv = [B.v(scr @ Vector((x, -0.0125, z))) for x, z in ((-0.168, -0.102), (0.168, -0.102), (0.168, 0.102), (-0.168, 0.102))]
B.face(sv, "Screen", scr.to_3x3() @ Vector((0, -1, 0)))
rbox(B, "Interior", (0.05, 0.07, 0.09), 0.01, place(0.0, 1.86, 0.97, -16))
# Steering wheel: a round rim with two side spokes and one below, the hub, the column into the dash.
sw = place(-0.37, 2.02, 0.905, -24)  # the wheel's face towards the driver (-Y), its top leaning forward
R, r_t, nmaj, nmin = 0.185, 0.0165, 36, 8
tor = [[B.v(sw @ Vector(((R + r_t * math.cos(b)) * math.cos(a), r_t * math.sin(b), (R + r_t * math.cos(b)) * math.sin(a))))
        for b in (2 * math.pi * j / nmin for j in range(nmin))] for a in (2 * math.pi * i / nmaj for i in range(nmaj))]
for i in range(nmaj):
    for j in range(nmin):
        q = (tor[i][j], tor[(i + 1) % nmaj][j], tor[(i + 1) % nmaj][(j + 1) % nmin], tor[i][(j + 1) % nmin])
        a = 2 * math.pi * (i + 0.5) / nmaj
        ring_c = sw @ Vector((R * math.cos(a), 0, R * math.sin(a)))
        B.face(q, "Interior", sum((v.co for v in q), Vector()) / 4 - ring_c)
for ang, ln in ((0, 0.13), (180, 0.13), (270, 0.13)):
    m = sw @ Matrix.Rotation(math.radians(-ang), 4, "Y") @ Matrix.Translation((0.105, 0.004, 0))
    rbox(B, "Interior", (ln, 0.02, 0.038), 0.008, m, segs=1)
rbox(B, "Interior", (0.115, 0.055, 0.095), 0.02, sw @ Matrix.Translation((0, -0.012, 0)))
rbox(B, "Interior", (0.06, 0.24, 0.06), 0.015, sw @ Matrix.Translation((0, 0.15, -0.01)), segs=1)
# Front seats (integrated headrests), the console, the rear bench with three headrests.
for x in (-0.37, 0.37):
    rbox(B, "Interior", (0.5, 0.5, 0.13), 0.04, place(x, 2.36, 0.585, 5))
    rbox(B, "Interior", (0.5, 0.12, 0.6), 0.045, place(x, 2.72, 0.93, 17))
    rbox(B, "Interior", (0.30, 0.11, 0.24), 0.05, place(x, 2.835, 1.32, 17))
rbox(B, "Interior", (0.2, 0.78, 0.25), 0.04, place(0.0, 2.32, 0.48))
rbox(B, "Interior", (1.22, 0.48, 0.13), 0.045, place(0.0, 3.36, 0.605, 4))
rbox(B, "Interior", (1.22, 0.12, 0.55), 0.045, place(0.0, 3.70, 0.94, 22))
for x in (-0.42, 0.0, 0.42):
    rbox(B, "Interior", (0.25, 0.08, 0.15), 0.035, place(x, 3.83, 1.275, 22))

details = B.obj()
bpy.ops.object.select_all(action="DESELECT")
body.select_set(True)
details.select_set(True)
bpy.context.view_layer.objects.active = body
bpy.ops.object.join()
body.data.set_sharp_from_angle(angle=math.radians(65))


# ---- Wheels: one mesh for all four. A tyre with a rounded sidewall and three tread grooves; a 19-inch
# wheel with ten twisted spokes in front of a dark barrel; the brake disc behind (it rolls with the wheel).
def wheel_mesh():
    W = Builder("Wheel")
    seg = 56

    def ring(x, r, n):
        return [W.v((x, r * math.cos(2 * math.pi * k / n), r * math.sin(2 * math.pi * k / n))) for k in range(n)]

    def loft(profile, mat, n=seg, right=True, centre=None):
        """Turn an (x, r) profile round the axle. Its outside is on the right of the walking direction
        (or the left); `centre` closes the first ring with a cap at that x."""
        rs = [ring(x, r, n) for x, r in profile]
        if centre is not None:
            c = W.v((centre, 0, 0))
            for k in range(n):
                W.face((c, rs[0][k], rs[0][(k + 1) % n]), mat, Vector((1, 0, 0)))
        for (xa, ra), (xb, rb), a, b in zip(profile, profile[1:], rs, rs[1:]):
            nx, nr = (rb - ra, -(xb - xa)) if right else (-(rb - ra), xb - xa)
            for k in range(n):
                th = 2 * math.pi * (k + 0.5) / n
                W.face((a[k], a[(k + 1) % n], b[(k + 1) % n], b[k]), mat, Vector((nx, nr * math.cos(th), nr * math.sin(th))))
        return rs

    # Tyre, from the outer bead over the shoulder, across the tread with three grooves, to the inner bead.
    tread = []
    for gx in (0.045, 0.0, -0.045):
        tread += [(gx + 0.0045, 0.356), (gx + 0.0045, 0.349), (gx - 0.0045, 0.349), (gx - 0.0045, 0.356)]
    loft([(0.104, 0.248), (0.115, 0.262), (0.1235, 0.281), (0.1275, 0.302), (0.1255, 0.322), (0.119, 0.337),
          (0.108, 0.3485), (0.094, 0.3545), (0.08, 0.356)] + tread +
         [(-0.08, 0.356), (-0.104, 0.3505), (-0.121, 0.334), (-0.1275, 0.302), (-0.12, 0.27), (-0.104, 0.248)], "Tyre")
    # Rim: the flange (the bright lip round the spokes), then the dark barrel going in, closed at the back.
    loft([(0.104, 0.249), (0.1125, 0.2465), (0.1145, 0.240), (0.111, 0.2345), (0.1, 0.232)], "Rim", right=False)
    back = loft([(0.1, 0.232), (-0.095, 0.232)], "RimDark", right=False)[-1]
    W.face(back, "RimDark", Vector((1, 0, 0)))  # the hub side, seen through the spokes
    # Ten spokes: blades narrow at the hub and wide at the lip, folded along a ridge, sweeping a little.
    for sp in range(10):
        a0 = 2 * math.pi * sp / 10
        pts = []
        for i in range(7):
            t = i / 6
            r = 0.05 + (0.236 - 0.05) * t
            ang = a0 + 0.19 * t ** 1.3
            hw = (0.009 + 0.037 * t ** 1.2) / r
            xf = 0.088 + 0.018 * t
            cs = lambda a_, rr=r: (rr * math.cos(a_), rr * math.sin(a_))
            front = [(xf - 0.008, *cs(ang - hw)), (xf, *cs(ang - 0.3 * hw)), (xf - 0.014, *cs(ang + hw))]
            rear = [(xf - 0.03, *cs(ang - hw)), (xf - 0.036, *cs(ang + hw))]
            pts.append(([W.v(p) for p in front], [W.v(p) for p in rear], ang))
        for (f0, b0, g0), (f1, b1, g1) in zip(pts, pts[1:]):
            gm = (g0 + g1) / 2
            tang = Vector((0, -math.sin(gm), math.cos(gm)))
            W.face((f0[0], f1[0], f1[1], f0[1]), "Rim", Vector((1, 0, 0)) - tang * 0.5)
            W.face((f0[1], f1[1], f1[2], f0[2]), "Rim", Vector((1, 0, 0)) + tang * 0.5)
            W.face((f0[0], b0[0], b1[0], f1[0]), "RimDark", -tang)
            W.face((f0[2], f1[2], b1[1], b0[1]), "RimDark", tang)
            W.face((b0[0], b0[1], b1[1], b1[0]), "RimDark", Vector((-1, 0, 0)))
    # Hub: a shallow dome with a dark centre cap.
    loft([(0.0918, 0.02), (0.0912, 0.034), (0.0902, 0.046)], "RimDark", n=30, centre=0.092)
    loft([(0.0902, 0.046), (0.0885, 0.056), (0.082, 0.064), (0.06, 0.064)], "Rim", n=30)
    # Brake disc with its hat, behind the spokes.
    loft([(0.036, 0.098), (-0.004, 0.108), (-0.004, 0.176), (-0.03, 0.176)], "Disc", n=48, centre=0.036)
    me_obj = W.obj()
    me = me_obj.data
    bpy.data.objects.remove(me_obj)
    me.set_sharp_from_angle(angle=math.radians(40))
    return me


wheel_data = wheel_mesh()
wheels = []
for name, s, u in (("Wheel_FL", -1, U_F), ("Wheel_FR", 1, U_F), ("Wheel_RL", -1, U_R), ("Wheel_RR", 1, U_R)):
    obj = link(bpy.data.objects.new(name, wheel_data))
    obj.location = (s * TRACK / 2, L / 2 - u, TYRE_R)
    if s < 0:
        obj.rotation_euler = (0, 0, math.pi)  # the wheel's face looks out on the left too
    wheels.append(obj)

tris = sum(len(p.vertices) - 2 for o in [body, *wheels] for p in o.data.polygons)
print(f"model_y: {tris} triangles (body {sum(len(p.vertices) - 2 for p in body.data.polygons)})")

bpy.ops.object.select_all(action="DESELECT")
for o in [body, *wheels]:
    o.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_texcoords=False, export_cameras=False, export_lights=False)

# ---- Preview renders: front and rear three-quarter, side, a wheel close up, the chase camera, the nose.
if PREVIEW:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = 48
    if hasattr(scene.eevee, "use_raytracing"):
        scene.eevee.use_raytracing = True
    scene.render.resolution_x, scene.render.resolution_y = 1280, 720
    # Sky above, a bright horizon and dark ground below, so the black paint has something to reflect.
    world = bpy.data.worlds.new("Sky")
    world.use_nodes = True
    nt = world.node_tree
    coord = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    nt.links.new(coord.outputs["Generated"], sep.inputs[0])
    rng = nt.nodes.new("ShaderNodeMapRange")
    rng.inputs["From Min"].default_value = -1
    nt.links.new(sep.outputs["Z"], rng.inputs["Value"])
    nt.links.new(rng.outputs["Result"], ramp.inputs["Fac"])
    els = ramp.color_ramp.elements
    els[0].position, els[0].color = 0.0, (0.05, 0.05, 0.045, 1)
    els[1].position, els[1].color = 1.0, (0.22, 0.36, 0.62, 1)
    for pos, col in ((0.495, (0.16, 0.155, 0.14, 1)), (0.505, (0.85, 0.87, 0.9, 1)), (0.62, (0.5, 0.62, 0.8, 1))):
        e = els.new(pos)
        e.color = col
    nt.links.new(ramp.outputs["Color"], nt.nodes["Background"].inputs["Color"])
    nt.nodes["Background"].inputs["Strength"].default_value = 1.0
    scene.world = world
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(48), 0, math.radians(35)))
    sun = bpy.context.active_object.data
    sun.energy = 4.0
    sun.angle = math.radians(2)
    bpy.ops.mesh.primitive_plane_add(size=300)
    bpy.context.active_object.data.materials.append(material("Ground", (0.16, 0.16, 0.155), 0.85))
    # The game makes the glass slightly see-through; do the same here so the cabin shows.
    if "Glass" in bpy.data.materials:
        g = bpy.data.materials["Glass"]
        g.node_tree.nodes["Principled BSDF"].inputs["Alpha"].default_value = 0.6
        if hasattr(g, "surface_render_method"):
            g.surface_render_method = "BLENDED"
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    os.makedirs(PREVIEW, exist_ok=True)
    views = (("front3q", (5.4, 6.1, 1.55), (0, 0.25, 0.72), 42), ("rear3q", (-5.3, -6.2, 1.75), (0, -0.3, 0.78), 42),
             ("side", (10.5, 0.0, 0.95), (0, 0, 0.8), 50), ("wheel", (2.25, 2.35, 0.62), (0.84, 1.46, 0.36), 55),
             ("chase", (0.0, -8.2, 2.5), (0, 0.4, 0.85), 35), ("front", (0.6, 8.6, 1.05), (0, 0, 0.72), 50),
             ("cabin", (-1.9, 3.3, 1.85), (-0.15, 0.55, 0.95), 35))
    for label, at, look, lens in views:
        cam.location = at
        cam.data.lens = lens
        d = Vector(look) - Vector(at)
        cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(PREVIEW, f"{label}.png")
        bpy.ops.render.render(write_still=True)
