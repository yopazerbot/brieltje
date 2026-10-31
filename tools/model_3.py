"""Build the Tesla Model 3 (Highland facelift, 2024+, Deep Blue Metallic) for the game in Blender, from its real sizes.

Run (Blender 5, no window):
  blender -b -P tools/model_3.py -- <out.glb> [preview_dir] [paint]

Same method as tools/model_y.py. The body is lofted from cross-sections along its length: the side
profile (the thin vertical nose, hood, windshield, roof, rear glass, the short deck to the lip, the tail),
the plan (width) and the window line. Each section has the Model 3's side: a tucked-in sill, the widest
line at the height of the wheel tops, a shoulder rolling in to the window line, a crisp edge where the
hood and the boot lid meet the fenders. Wheel arches are cut out of it. Everything else is laid on its
surface with ray casts: panel gaps, the window frames and pillars, door handles, the slim headlights with
their light line, the C-shaped tail lights, the lower intake, the black rear diffuser, the plate, the lip
spoiler, the charge port flap; the mirrors, a cabin (seats, dash, screen, steering wheel) and the brake
calipers are built in place.

Sizes (Tesla's published figures for the Highland, as listed by autotijd.be and basenor.com):
length 4.72 m, width 1.85 m (2.09 m with mirrors), height 1.44 m, wheelbase 2.875 m, overhangs
0.868 m front and 0.977 m rear, track 1.584 m, ground clearance 0.138 m; 19-inch two-tone wheels on
235/40 R19 tyres (0.67 m across). The profile, plan, front and rear outlines, window line, pillars, door
cuts, handles and lamps were measured on the dimensioned Model 3 (2023) drawing from dimensions.com
(side, plan, front and rear views at one scale) and checked against photos on Wikimedia Commons (the
"Tesla Model 3 Highland ..." series). Both were only used for comparison and are not part of the output.
No logos, badges or lettering; the plate is blank.

Output: one GLB with the body and four wheels (Wheel_FL, Wheel_FR, Wheel_RL, Wheel_RR, one shared mesh)
whose origin is their axle, so the game can roll and steer them; the brake discs roll with them, the
calipers stay in the body. Blender's -Y is the back of the car; in the GLB (three.js axes) the nose
points to -z, as with model-y.glb. The glass is tinted and slightly see-through (alpha blend), so the
cabin shows. With preview_dir it also renders views there (paint: a colour like 0.5,0.5,0.5 to check the
shape; default Deep Blue Metallic).

Materials (the same names as model_y.py): Paint, Glass, Trim, Tyre, Rim, RimDark, LightBar, LampGlass,
TailLight, Gap, Chrome, Disc, Caliper, Interior, Screen, Reflector, Plate.
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
PREVIEW = os.path.abspath(argv[1]) if len(argv) > 1 else ""  # absolute: Blender resolves relative render paths elsewhere


def srgb(hexcode):
    """A hex colour as linear RGB (what Blender's colour inputs take)."""
    c = [int(hexcode[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


# Deep Blue Metallic: a deep, slightly purple-leaning blue.
PAINT = tuple(float(v) for v in argv[2].split(",")) if len(argv) > 2 else srgb("1f3c78")

L = 4.72                 # length
U_F, U_R = 0.868, 3.743  # axles, from the front bumper (wheelbase 2.875)
TYRE_R = 0.3353          # 235/40 R19
TRACK = 1.596            # 1.584 published; the tyres' outer walls come flush with the fender lips
ARCH_R = 0.372           # wheel arch radius: about 4 cm over the tyre
STATIONS = 100


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


def clamp01(v):
    return min(1.0, max(0.0, v))


def smooth(v):
    v = clamp01(v)
    return v * v * (3 - 2 * v)


# Side profile, from the drawing: the top of each cross-section (the lower bumper sticking out furthest, the
# thin near-vertical nose up to the hood's sharp front edge at 0.63, the hood rising to the cowl at 1.235,
# the windshield, the roof peaking at 1.44 over the B-pillar, the rear glass down to the deck at 4.2, the
# deck to the lip at 4.68, the tail face under it) and its underside.
TOP = curve([(0.0, 0.365), (0.012, 0.385), (0.024, 0.41), (0.034, 0.47), (0.040, 0.55), (0.046, 0.60), (0.056, 0.625),
             (0.07, 0.640), (0.09, 0.652), (0.12, 0.668), (0.20, 0.710), (0.30, 0.755), (0.40, 0.791), (0.50, 0.822),
             (0.60, 0.848), (0.70, 0.870), (0.80, 0.889), (0.90, 0.905), (1.00, 0.918), (1.10, 0.929), (1.19, 0.940),
             (1.235, 0.951), (1.30, 0.998), (1.40, 1.049), (1.50, 1.097), (1.60, 1.144), (1.70, 1.192), (1.80, 1.235),
             (1.90, 1.280), (2.00, 1.319), (2.10, 1.353), (2.20, 1.382), (2.30, 1.402), (2.40, 1.416), (2.50, 1.427),
             (2.60, 1.433), (2.70, 1.437), (2.85, 1.441), (3.00, 1.436), (3.10, 1.428), (3.20, 1.417), (3.30, 1.404),
             (3.40, 1.388), (3.50, 1.370), (3.60, 1.349), (3.70, 1.325), (3.80, 1.299), (3.90, 1.271), (4.00, 1.238),
             (4.10, 1.205), (4.20, 1.168), (4.30, 1.132), (4.40, 1.094), (4.50, 1.064), (4.58, 1.048), (4.64, 1.041),
             (4.675, 1.034), (4.684, 1.0), (4.688, 0.94), (4.69, 0.87), (4.695, 0.80), (4.703, 0.72), (4.712, 0.64),
             (4.72, 0.57)])
BOTTOM = curve([(0.0, 0.232), (0.02, 0.216), (0.05, 0.207), (0.10, 0.199), (0.20, 0.189), (0.30, 0.181), (0.40, 0.177),
                (0.60, 0.172), (1.00, 0.160), (1.20, 0.155), (3.40, 0.155), (3.90, 0.158), (4.20, 0.163), (4.40, 0.172),
                (4.55, 0.180), (4.64, 0.195), (4.68, 0.215), (4.695, 0.24), (4.70, 0.40), (4.71, 0.48), (4.72, 0.52)])
# Plan, from the drawing: half the body's width (a pointed nose, the front fenders and the rear haunches
# wider than the doors, a rounded tail), and half the width of the hood, the roof or the deck.
WIDTH = curve([(0.0, 0.142), (0.02, 0.298), (0.05, 0.434), (0.10, 0.540), (0.15, 0.615), (0.20, 0.678), (0.30, 0.778),
               (0.40, 0.866), (0.50, 0.906), (0.60, 0.918), (0.80, 0.925), (1.00, 0.925), (1.20, 0.922), (1.40, 0.914),
               (1.60, 0.906), (2.00, 0.905), (2.80, 0.905), (3.20, 0.907), (3.50, 0.918), (3.80, 0.925), (4.00, 0.922),
               (4.20, 0.890), (4.30, 0.851), (4.40, 0.817), (4.50, 0.762), (4.60, 0.640), (4.65, 0.534), (4.68, 0.45),
               (4.70, 0.327), (4.72, 0.12)])
ROOF = curve([(0.0, 0.10), (0.10, 0.40), (0.20, 0.53), (0.30, 0.61), (0.45, 0.69), (0.70, 0.73), (1.00, 0.735),
              (1.235, 0.735), (1.47, 0.735), (1.80, 0.712), (2.20, 0.665), (2.60, 0.632), (3.00, 0.622), (3.50, 0.615),
              (4.00, 0.605), (4.20, 0.61), (4.40, 0.63), (4.55, 0.60), (4.72, 0.30)])
# How far the top falls from the middle to the sides (rounder over the glass), the ridge along the edge of
# the hood and of the boot lid, and how far the glass's foot sits in from the widest line.
DROP = curve([(0.0, 0.05), (1.15, 0.06), (1.30, 0.085), (4.05, 0.085), (4.25, 0.065), (4.72, 0.05)])
RIDGE = lambda u: 0.016 * smooth((u - 0.12) / 0.25) * smooth((1.42 - u) / 0.12) + \
    0.008 * smooth((u - 4.22) / 0.08) * smooth((4.64 - u) / 0.06)
LXD = curve([(0.0, 0.11), (1.40, 0.11), (2.60, 0.115), (3.40, 0.125), (3.90, 0.14), (4.30, 0.14), (4.72, 0.12)])
# Bottom edge of the side windows, from the windshield's foot (the cowl) back, rising to the quarter window's
# tip, then to where the rear glass meets the deck.
BELT = curve([(1.235, 0.950), (1.40, 0.958), (1.47, 0.965), (1.60, 0.971), (2.00, 0.977), (2.60, 0.987), (3.20, 1.002),
              (3.55, 1.018), (3.70, 1.045), (3.85, 1.09), (4.00, 1.145), (4.10, 1.17), (4.20, 1.18)])
GREENHOUSE = (1.235, 4.20)
A_FOOT = 1.47      # the A-pillar's foot: side glass behind it
U_QW = 4.0         # the side glass (the small rear quarter window) ends here; behind it the C-pillar is painted
SIDE_LOW = ((0.0, 0.060), (0.15, 0.055), (0.35, 0.028), (0.65, 0.008))  # (share of the way to the widest line, inset)
SIDE_HIGH = ((0.07, 0.004), (0.12, 0.016), (0.17, 0.042))  # (height over the widest line, inset): the shoulder


def belt(u):
    return BELT(u) if GREENHOUSE[0] <= u <= GREENHOUSE[1] else 99.0


def section(u):
    """Half a cross-section at u, from the bottom middle round to the top middle: (x, z) points,
    the belt height and the key points (lx, lz: the glass's foot or the fender top; tx, tz: the glass's top
    edge; wr: where the roof, hood or deck top ends)."""
    zb, zt, w = BOTTOM(u), TOP(u), WIDTH(u)
    k = min(1.0, w / 0.6)            # the small sections at the nose and tail scale their details down
    drop = DROP(u) * min(1.0, (zt - zb) / 0.25)
    lxd = LXD(u)
    wr = min(ROOF(u), w - (lxd + 0.075) * k)
    bl = min(belt(u), zt)
    g = clamp01((zt - bl) / 0.05)                                      # glass above the belt here
    glass = clamp01((zt - bl) / 0.1) * smooth((u - A_FOOT + 0.04) / 0.08)
    ridge = RIDGE(u)
    crown = lambda x: zt - drop * (x / w) ** 2 + ridge * smooth((x - wr) / (0.03 * k))
    lx = w - lxd * k
    lz = min(bl + 0.012, crown(lx))
    rb = 0.04 * k
    base = zb + rb
    zw = base + min(0.62 * (lz - base), max(0.0, 0.70 - base))        # the widest line, at most 0.70 up
    sc = min(1.0, (lz - zw) / 0.25)
    xb = w - SIDE_LOW[0][1] * k - rb
    pts = [(t * xb, zb) for t in (0.0, 0.4, 0.8)]
    for a in (0.45, 0.8):  # rounded bottom corner of the sill
        ang = a * math.pi / 2
        pts.append((xb + rb * math.sin(ang), zb + rb - rb * math.cos(ang)))
    for f, d in SIDE_LOW:  # the sill tucked in, the side bulging out to the widest line
        pts.append((w - d * k, base + (zw - base) * f))
    pts.append((w, zw))
    for dz, d in SIDE_HIGH:  # the shoulder rolling in
        pts.append((w - d * k, zw + dz * sc))
    zm = zw + 0.17 * sc
    pts.append((w - (0.042 + (lxd - 0.042) * 0.45) * k, zm + (lz - zm) * 0.5))
    pts.append((lx, lz))
    tx = wr + 0.045 * k
    tz = crown(tx) - 0.03 * glass
    for t in (0.25, 0.5, 0.75):  # side glass leaning in (or the fender top)
        x = lx + (tx - lx) * t + 0.012 * glass * math.sin(math.pi * t)
        zl = lz + (tz - lz) * t
        pts.append((x, crown(x) + (zl - crown(x)) * g))
    pts.append((tx, tz))
    xr = wr + 0.02 * k
    pts.append((xr, crown(xr) - 0.006 * glass))
    for t in (0.0, 0.25, 0.5, 0.75, 1.0):
        x = wr * (1 - t)
        pts.append((x, crown(x)))
    return pts, bl, {"lx": lx, "lz": lz, "tx": tx, "tz": tz, "wr": wr}


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
        p.inputs["Coat Roughness"].default_value = 0.02
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
    # Metallic base (dark in the shade, blue sheen in the light) under a glossy clear coat.
    "Paint": material("Paint", PAINT, 0.30, 0.75, coat=1.0),
    "Glass": material("Glass", (0.008, 0.009, 0.011), 0.03, 0.0),
    "Trim": material("Trim", (0.02, 0.02, 0.02), 0.55),
    "Tyre": material("Tyre", (0.015, 0.015, 0.015), 0.85),
    "Rim": material("Rim", (0.50, 0.51, 0.53), 0.28, 0.9),
    "RimDark": material("RimDark", (0.012, 0.012, 0.013), 0.3, 0.3),
    "LightBar": material("LightBar", (0.9, 0.95, 1.0), 0.1, emit=(0.85, 0.92, 1.0), strength=2.5),
    "LampGlass": material("LampGlass", (0.01, 0.01, 0.012), 0.05),
    "TailLight": material("TailLight", (0.5, 0.02, 0.02), 0.2, emit=(1.0, 0.05, 0.03), strength=1.2),
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
# Tinted glass you can just see the cabin through: alpha-blended in the GLB.
MAT["Glass"].node_tree.nodes["Principled BSDF"].inputs["Alpha"].default_value = 0.82
if hasattr(MAT["Glass"], "surface_render_method"):
    MAT["Glass"].surface_render_method = "BLENDED"

# ---- Body: rings of cross-sections, closed at both ends.
# Closer together at the ends, and extra rings where the windshield's foot curves back across the cowl and at
# the lip, so those edges stay clean. The tail stops 1 cm short so the plate on it stays within the length.
L_BODY = L - 0.01
us = [L_BODY * (1 - math.cos(math.pi * i / (STATIONS - 1))) / 2 for i in range(STATIONS)]
for extra in (1.225, 1.245, 1.265, 1.285, 1.305, 1.325, 1.35, 1.375, 1.40, 1.43, 1.46, 1.49, 4.56, 4.585, 4.61, 4.635,
              4.655, 4.668, 4.678):
    us = [u for u in us if abs(u - extra) > 0.008] + [extra]
us.sort()
# The ring where the side glass stops (the rear edge of the quarter window): faces behind it are painted.
U_QW_EDGE = min(us[k] for k in range(1, len(us)) if (us[k - 1] + us[k]) / 2 > U_QW)
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
    bl = min(belt(u), TOP(u))
    name = "Paint"
    if GREENHOUSE[0] + 0.004 < u < GREENHOUSE[1] - 0.004 and z > bl + 0.012 and TOP(u) - bl > 0.012:
        info = section(u)[2]
        if x < info["wr"] + 0.005:
            name = "Glass"  # windshield, glass roof, rear glass
        elif x < info["tx"] + 0.004:
            # The thin painted strip between the side glass and the roof glass: the A-pillars, the roof
            # rails, the rear glass's edges (the inner half of the corner is glass too).
            name = "Paint" if x > info["wr"] + 0.022 else "Glass"
        elif x < info["lx"] - 0.003 and A_FOOT < u < U_QW:
            name = "Glass"  # side windows
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
        bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=ARCH_R, depth=0.7, location=(side * 1.0, L / 2 - u, TYRE_R),
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


FRONT = radial(True, 0.48)
REAR = radial(False, 4.25)


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


def ellipse(ray, ca, cb, ra, rb, n=16):
    """Hits round an ellipse in the ray's (a, b) space, for a closed ribbon."""
    return [ray(ca + ra * math.cos(t), cb + rb * math.sin(t)) for t in across(0, 2 * math.pi, n)[:-1]]


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


def angle_at(ray, x, z):
    """The ray angle whose hit lies at x across the car, at height z (found by halving)."""
    lo, hi = 0.0, 89.0
    for _ in range(28):
        mid = (lo + hi) / 2
        h = ray(mid, z)
        if h is None or h[0].x > x:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2


def where(h):
    """(x, u, z) of a ray hit, for the calibration printout."""
    return None if not h else (round(h[0].x, 3), round(L / 2 - h[0].y, 3), round(h[0].z, 3))


for zc in (0.287, 0.665, 0.72):
    print(f"model_3 front rays at z={zc} (deg: x, u):", [(a, where(FRONT(a, zc))[:2]) for a in range(30, 91, 5) if FRONT(a, zc)])
print("model_3 rear rays at z=0.93 (deg: x, u):", [(a, where(REAR(a, 0.93))[:2]) for a in range(30, 91, 5) if REAR(a, 0.93)])

B = Builder("Details")

# ---- Front: a smooth nose with no grille. The slim headlights sit at the very corners under the hood's
# front edge, a light line along their lower edge; the hood's gap runs across the nose and along the lamps'
# tops, then back along the fender ridges; a narrow black intake low on the bumper.
HL = (angle_at(FRONT, 0.47, 0.665), 88.5)  # the headlights' inner and outer ends, as ray angles


def hl_t(a):
    return clamp01((abs(a) - HL[0]) / (HL[1] - HL[0]))


hl_top = lambda a: 0.664 + 0.106 * hl_t(a) ** 1.4
hl_h = curve([(0.0, 0.0), (0.08, 0.02), (0.40, 0.031), (0.55, 0.038), (0.65, 0.056), (0.85, 0.074), (0.95, 0.075),
              (1.0, 0.055)])
hl_lo = lambda a: hl_top(a) - hl_h(hl_t(a))
hl_a = lambda t: HL[0] + (HL[1] - HL[0]) * t
for s in (-1, 1):
    a_vals = across(s * HL[0], s * HL[1], 32)
    panel(B, FRONT, a_vals, lambda a: across(hl_lo(a), hl_top(a), 3), "LampGlass", out=0.004, skirt=0.004)
    # The light line: along the lower edge from near the inner tip, then up the outer end.
    line = [FRONT(a, hl_lo(a) + 0.0045) for a in across(s * hl_a(0.06), s * hl_a(0.985), 34)]
    line += [FRONT(s * hl_a(0.985), z) for z in across(hl_lo(s * HL[1]) + 0.010, hl_top(s * HL[1]) - 0.008, 3)]
    ribbon(B, line, 0.006, "LightBar", out=0.0058)
    # Inside: a thin chrome reflector band under the top edge, towards the outer end.
    panel(B, FRONT, across(s * hl_a(0.5), s * hl_a(0.95), 12), lambda a: across(hl_top(a) - 0.026, hl_top(a) - 0.014, 1),
          "Chrome", out=0.0050, skirt=0)
# The hood's front gap across the nose, then along the lamps' tops to where the hood's sides turn back.
ribbon(B, [FRONT(a, 0.652 - 0.006 * (1 - (a / HL[0]) ** 2)) for a in across(-HL[0], HL[0], 56)], 0.012, "Gap", out=0.003)
for s in (-1, 1):
    hood_corner = angle_at(FRONT, 0.60, 0.70)
    edge = [FRONT(a, hl_top(a) + 0.006) for a in across(s * HL[0], s * hood_corner, 14)]
    edge = [h for h in edge if h]
    u_join = L / 2 - edge[-1][0].y
    edge += [top_ray(u, s * (key(u, "wr") + 0.004)) for u in across(u_join + 0.03, 1.25, 40)]
    ribbon(B, edge, 0.012, "Gap", out=0.003)
    # Where the bumper meets the front fender: from the lamp's outer end back to the arch.
    ribbon(B, [side_ray(s)(u, z) for u, z in dense([(0.38, 0.705), (0.47, 0.668), (0.56, 0.648), (0.64, 0.632)], 0.02)],
           0.012, "Gap", out=0.003)
# Lower intake: a narrow black slot with rounded ends across the bumper, its mesh bars.
SLOT = angle_at(FRONT, 0.58, 0.287)
slot_h = lambda a: 0.025 * math.sqrt(clamp01(1 - (abs(a) / SLOT) ** 8))
panel(B, FRONT, across(-SLOT, SLOT, 64), lambda a: across(0.287 - slot_h(a), 0.287 + slot_h(a), 2), "Gap", out=0.003,
      skirt=0.003)
for xb in across(-0.48, 0.48, 8):
    ab = math.copysign(angle_at(FRONT, abs(xb), 0.287), xb) if abs(xb) > 1e-6 else 0.0
    ribbon(B, [FRONT(ab, z) for z in across(0.266, 0.308, 3)], 0.008, "Trim", out=0.0042)
ribbon(B, [FRONT(a, 0.287) for a in across(-SLOT + 2, SLOT - 2, 50)], 0.005, "Trim", out=0.0042)


def glass_foot(x):
    """Where the windshield's foot is at x across the car (it curves back towards the A-pillars)."""
    lo, hi = 1.20, 1.60
    for _ in range(24):
        mid = (lo + hi) / 2
        zt, zb, w = TOP(mid), BOTTOM(mid), WIDTH(mid)
        z = zt - DROP(mid) * min(1.0, (zt - zb) / 0.25) * (x / w) ** 2
        if z > belt(mid) + 0.012:
            hi = mid
        else:
            lo = mid
    return hi


# The windshield's black edge along its foot, the wipers parked on it, the black patch round the camera.
ribbon(B, [top_ray(glass_foot(x) + 0.012, x) for x in across(-0.72, 0.72, 60)], 0.032, "LampGlass", out=0.0025)
ribbon(B, [top_ray(glass_foot(x) + 0.05, x) for x in across(-0.60, 0.0, 16)], 0.016, "Trim", out=0.009)
ribbon(B, [top_ray(glass_foot(x) + 0.05, x) for x in across(0.06, 0.56, 14)], 0.016, "Trim", out=0.009)
rounded_panel(B, lambda x, u: top_ray(u, x), 0.0, 2.06, 0.16, 0.10, 0.03, "Gap", na=8, nb=4, out=0.0025, skirt=0)
# The glass roof: black bars across behind the windshield and over the B-pillars (the frame between the panes),
# and a black edge along the glass's sides so the painted rails stay thin.
for ub, wb in ((2.185, 0.085), (2.88, 0.10)):
    wr_b = key(ub, "wr")
    ribbon(B, [top_ray(ub, x) for x in across(-wr_b - 0.005, wr_b + 0.005, 40)], wb, "LampGlass", out=0.003)
    for e in (-1, 1):
        ribbon(B, [top_ray(ub + e * wb / 2, x) for x in across(-wr_b, wr_b, 40)], 0.004, "Gap", out=0.0036)
for s in (-1, 1):
    ribbon(B, [top_ray(u, s * (key(u, "wr") - 0.010)) for u in across(glass_foot(0.70) + 0.02, 4.18, 90)], 0.022,
           "LampGlass", out=0.0028)
# The rear glass's black edge where it meets the deck.
ribbon(B, [top_ray(4.185, x) for x in across(-key(4.185, "wr"), key(4.185, "wr"), 40)], 0.03, "LampGlass", out=0.003)

# ---- Sides.
for s in (-1, 1):
    side = side_ray(s)
    lz = lambda u: key(u, "lz")
    tz = lambda u: key(u, "tz")
    # Door gaps: the front door's front edge, between the doors, the rear door's rear edge round the arch,
    # and their bottom edge above the sill.
    for line in ([(1.47, lz(1.47)), (1.468, 0.80), (1.455, 0.50), (1.44, 0.28)],
                 [(2.635, lz(2.635)), (2.640, 0.80), (2.636, 0.50), (2.628, 0.28)],
                 [(3.60, lz(3.60)), (3.655, 0.95), (3.625, 0.84), (3.50, 0.69), (3.37, 0.55), (3.25, 0.44), (3.12, 0.345),
                  (3.02, 0.29), (2.99, 0.28)]):
        ribbon(B, [side(u, z) for u, z in dense(line, 0.02)], 0.012, "Gap", out=0.003)
    ribbon(B, [side(u, 0.28) for u in across(1.44, 2.99, 40)], 0.012, "Gap", out=0.003)
    # Black window frames: along the glass's foot and its top edge, the B-pillar (leaning back), the divider
    # in front of the quarter window and the quarter window's tip.
    ribbon(B, [side(u, lz(u) + 0.002) for u in across(A_FOOT + 0.015, U_QW_EDGE, 80)], 0.02, "LampGlass", out=0.003)
    ribbon(B, [side(u, max(lz(u) + 0.004, tz(u) - 0.010)) for u in across(A_FOOT + 0.04, U_QW_EDGE, 90)],
           lambda t: 0.006 + 0.016 * min(1.0, t / 0.05), "LampGlass", out=0.003)
    zb_p, zt_p = lz(2.67) + 0.004, tz(2.74) - 0.012
    bp = lambda t, f: side((2.61 + 0.08 * f) + t * ((2.735 + 0.055 * f) - (2.61 + 0.08 * f)), zb_p + f * (zt_p - zb_p))
    panel(B, bp, across(0, 1, 4), lambda t: across(0, 1, 10), "LampGlass", out=0.003, skirt=0.003)
    ribbon(B, [side(3.50 + 0.05 * f, lz(3.5) + 0.004 + f * (tz(3.55) - 0.012 - lz(3.5) - 0.004)) for f in across(0, 1, 8)],
           0.024, "LampGlass", out=0.003)
    ribbon(B, [side(U_QW_EDGE, z) for z in across(lz(U_QW_EDGE), tz(U_QW_EDGE) - 0.006, 4)], 0.02, "LampGlass", out=0.003)
    # Flush door handles: a body-coloured bar in a dark outline, a pocket at its front end.
    for cu, cz in ((2.555, 0.852), (3.52, 0.898)):
        ribbon(B, [side(u, z) for u, z in rounded_rect(cu, cz, 0.178, 0.032, 0.013)], 0.008, "Gap", out=0.0022, closed=True)
        rounded_panel(B, side, cu, cz, 0.170, 0.024, 0.010, "Paint", out=0.0035, skirt=0.0035)
        rounded_panel(B, side, cu - 0.062, cz, 0.038, 0.018, 0.007, "Gap", na=6, nb=3, out=0.0042, skirt=0)
    # Side camera on the front fender, behind the arch: a small dark wedge.
    panel(B, side, across(1.09, 1.22, 8), lambda u: across(0.728 + (u - 1.09) * 0.14, 0.764 - (u - 1.09) * 0.10, 2),
          "LampGlass", out=0.004, skirt=0.004)
    # Where the rear bumper meets the quarter panel: down from the tail light, then forward to the arch.
    ribbon(B, [side(u, z) for u, z in dense([(4.43, 0.95), (4.432, 0.75), (4.425, 0.632), (4.38, 0.605), (4.20, 0.60),
                                             (4.03, 0.60)], 0.02)], 0.012, "Gap", out=0.003)
# Charge port flap, in the left tail light's outer part.
ribbon(B, [side_ray(-1)(u, z) for u, z in rounded_rect(4.525, 0.915, 0.13, 0.09, 0.02, 4)], 0.008, "Gap",
       out=0.0052, closed=True)

# ---- Rear: the lip spoiler on the boot lid, the C-shaped tail lights, the lid's gaps, the plate and the
# black diffuser with its reflector.


def deck_end(x):
    """How far back the deck's top reaches at x across the car (the lid's edge curves forward at the sides)."""
    lo, hi = 4.40, 4.72
    for _ in range(22):
        mid = (lo + hi) / 2
        h = top_ray(mid, x)
        if h and h[0].z > 1.0:
            lo = mid
        else:
            hi = mid
    return lo


# Lip: the deck kicks up into a sharp edge that overhangs the tail.
lip_rows = []
for x in across(-0.52, 0.52, 44):
    k = min(1.0, (0.52 - abs(x)) / 0.16)
    k = max(0.1, k * k * (3 - 2 * k))
    ue = deck_end(x)
    top = [top_ray(ue - d, x) for d in (0.10, 0.065, 0.032, 0.006)]
    if not all(top):
        continue
    lift = (0.0006, 0.003 * k, 0.006 * k, 0.0095 * k)
    row = [h[0] + Vector((0, 0, d)) for h, d in zip(top, lift)]
    edge = row[-1] + Vector((0, -0.026 * k, -0.0015 * k))
    row += [edge, edge + Vector((0, 0, -0.008 * k - 0.002)), top[-1][0] + Vector((0, 0.008, -0.03))]
    lip_rows.append([B.v(p) for p in row])
for r0, r1 in zip(lip_rows, lip_rows[1:]):
    for j in range(len(r0) - 1):
        hint = Vector((0, 0, 1)) if j < 4 else (Vector((0, -1, 0)) if j == 4 else Vector((0, 0, -1)))
        B.face((r0[j], r1[j], r1[j + 1], r0[j + 1]), "Paint", hint)
for r, hint in ((lip_rows[0], Vector((-1, 0, 0))), (lip_rows[-1], Vector((1, 0, 0)))):
    B.face(r, "Paint", hint)
# Tail lights: a slim smoked housing round each corner, from the lid onto the quarter panel. In it a thin light
# in a C (open towards the middle) over a red lens, and a red reflector in the outer part.
TL = (angle_at(REAR, 0.45, 0.94), 84.0)  # inner and outer ends, as ray angles


def tl_t(a):
    return clamp01((abs(a) - TL[0]) / (TL[1] - TL[0]))


tl_top = lambda a: 0.966 + 0.006 * tl_t(a)
tl_h = curve([(0.0, 0.0), (0.05, 0.036), (0.40, 0.058), (0.62, 0.10), (0.86, 0.128), (0.95, 0.112), (1.0, 0.065)])
tl_lo = lambda a: tl_top(a) - tl_h(tl_t(a))
for s in (-1, 1):
    panel(B, REAR, across(s * TL[0], s * TL[1], 40), lambda a: across(tl_lo(a), tl_top(a), 4), "LampGlass", out=0.004,
          skirt=0.004)
    c_end = TL[0] + 0.62 * (TL[1] - TL[0])  # the C's closed end
    zc_hi, zc_lo = tl_top(s * c_end) - 0.010, tl_lo(s * c_end) + 0.013
    rc = (zc_hi - zc_lo) / 2
    path = [(a, tl_top(s * a) - 0.010) for a in across(TL[0] + 2.0, c_end - 3.0, 26)]
    path += [(c_end - 3.0 + 3.0 * math.sin(t), zc_lo + rc + rc * math.cos(t)) for t in across(0, math.pi, 8)[1:-1]]
    path += [(a, tl_lo(s * a) + 0.013) for a in across(c_end - 3.0, TL[0] + 0.30 * (TL[1] - TL[0]), 14)]
    ribbon(B, [REAR(s * a, z) for a, z in path], 0.011, "TailLight", out=0.0062)
    panel(B, REAR, across(s * (TL[0] + 0.30 * (TL[1] - TL[0])), s * (c_end - 1.0), 14),
          lambda a: across(tl_lo(a) + 0.019, tl_top(a) - 0.016, 1), "Reflector", out=0.0052, skirt=0)
    panel(B, REAR, across(s * (c_end + 3.5), s * (TL[1] - 3.0), 8), lambda a: across(tl_lo(a) + 0.016, tl_top(a) - 0.013, 2),
          "Reflector", out=0.0052, skirt=0)
# Boot lid: its sides along the deck and down the tail face, its bottom edge above the bumper.
for s in (-1, 1):
    ribbon(B, [top_ray(u, s * (key(u, "wr") + 0.012)) for u in across(4.20, deck_end(0.5) - 0.01, 24)], 0.012, "Gap", out=0.003)
    ribbon(B, [back_ray(s * x, z) for x, z in dense([(0.60, 1.02), (0.595, 0.92), (0.585, 0.80), (0.565, 0.70), (0.53, 0.656),
                                                     (0.48, 0.646)], 0.012)], 0.012, "Gap", out=0.003)
ribbon(B, [back_ray(x, 0.646) for x in across(-0.48, 0.48, 36)], 0.012, "Gap", out=0.003)
# The plate in a shallow recess on the lid, the rear camera above it.
rounded_panel(B, back_ray, 0.0, 0.74, 0.565, 0.14, 0.016, "Gap", na=20, nb=4, out=0.0045, skirt=0)
rounded_panel(B, back_ray, 0.0, 0.74, 0.52, 0.11, 0.008, "Plate", na=16, nb=3, out=0.0072, skirt=0.0025)
ribbon(B, ellipse(back_ray, 0.0, 0.838, 0.011, 0.011, 12), 0.008, "Gap", out=0.0035, closed=True)
# Black diffuser across the bottom of the bumper, dropping at its ends; the red reflector in its middle.
dif_top = lambda x: 0.38 - 0.19 * smooth((abs(x) - 0.50) / 0.22)
panel(B, back_ray, across(-0.72, 0.72, 56), lambda x: across(0.18, dif_top(x), 6), "Trim", out=0.005, skirt=0.005)
panel(B, back_ray, across(-0.12, 0.12, 8), lambda x: across(0.292, 0.312, 1), "Reflector", out=0.0064, skirt=0)

# ---- Mirrors: a rounded body-coloured housing on a black base and arm, the glass facing back, a lens strip
# low on its front.
for s in (-1, 1):
    x0, x1, yb = 0.835, 1.044, L / 2 - 1.95
    secs = []
    for i in range(12):
        t = i / 11
        cap = math.sqrt(max(0.0, 1 - ((t - 0.7) / 0.3) ** 2)) if t > 0.7 else 1.0
        cap = max(cap, 0.12)
        # Flat top; the bottom curves up towards the door and a little towards the tip.
        z_top = 1.077 + 0.004 * t
        z_bot = 0.962 + (0.034 * (1 - t / 0.45) ** 2 if t < 0.45 else 0.018 * ((t - 0.45) / 0.55) ** 2)
        h = (z_top - z_bot) * cap
        zc = (z_top + z_bot) / 2
        d = (0.086 + 0.022 * math.sin(math.pi * min(1.0, t / 0.8))) * (0.4 + 0.6 * cap)
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
    # The black base on the door's top corner and the arm up to the housing.
    rbox(B, "LampGlass", (0.06, 0.13, 0.03), 0.012, place(s * 0.80, 1.86, 0.976) @ Matrix.Rotation(-s * 0.3, 4, "Y"))
    rbox(B, "LampGlass", (0.075, 0.07, 0.03), 0.012, place(s * 0.835, 1.885, 0.978) @ Matrix.Rotation(-s * 0.35, 4, "Y"))

# ---- Brake calipers: in the body (they must not roll), on the top of each disc, a little to the rear.
for u, alpha, span in ((U_F, 6, 40), (U_R, 30, 44)):
    for s in (-1, 1):
        cx, cy, cz = s * TRACK / 2, L / 2 - u, TYRE_R
        rings_c = []
        for i in range(7):
            a = math.radians(alpha - span / 2 + span * i / 6)
            dy, dz = -math.sin(a), math.cos(a)
            rings_c.append([B.v((cx + s * xl, cy + r * dy, cz + r * dz))
                            for r, xl in ((0.112, -0.046), (0.180, -0.046), (0.180, 0.012), (0.112, 0.012))])
        mid = Vector((cx + s * -0.017, cy - 0.146 * math.sin(math.radians(alpha)), cz + 0.146 * math.cos(math.radians(alpha))))
        for r0, r1 in zip(rings_c, rings_c[1:]):
            for k in range(4):
                q = (r0[k], r1[k], r1[(k + 1) % 4], r0[(k + 1) % 4])
                B.face(q, "Caliper", sum((v.co for v in q), Vector()) / 4 - mid)
        for r in (rings_c[0], rings_c[-1]):
            B.face(r, "Caliper", sum((v.co for v in r), Vector()) / 4 - mid)

# ---- Cabin, seen through the glass: a dark tub (floor, door panels, the wall behind the rear seat), the low
# dash with its vent line reaching forward under the windshield, the landscape screen standing on it, the
# steering wheel (round, on the left), two front seats, the console, the rear bench and the parcel shelf.
tub = []
for u in across(1.48, 4.06, 26):
    info = section(u)[2]
    lx, bl = info["lx"], min(belt(u), TOP(u))
    zt = min(bl, TOP(u) - 0.03) - 0.004
    w_in = lx - 0.045
    arch = clamp01((u - 3.33) / 0.08) * clamp01((4.15 - u) / 0.08)
    w_lo = w_in + (0.60 - w_in) * arch
    floor = 0.30 + 0.30 * clamp01((u - 3.80) / 0.12)
    half = [(lx - 0.008, zt), (w_in, zt), (w_in, bl - 0.08), (w_lo, bl - 0.10), (w_lo, floor + 0.03), (w_lo - 0.03, floor)]
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
# Dash: a long, low rounded block under the windshield, from the cowl back.
dash_sec = [(1.30, 0.905), (1.47, 0.915), (1.62, 0.912), (1.78, 0.902), (1.88, 0.89), (1.925, 0.868), (1.94, 0.835),
            (1.93, 0.76), (1.89, 0.68), (1.80, 0.60), (1.40, 0.58)]
dash = []
for x in (-0.79, -0.775, -0.70, -0.35, 0.0, 0.35, 0.70, 0.775, 0.79):
    k = 0.9 if abs(x) > 0.78 else (0.97 if abs(x) > 0.77 else 1.0)
    cu, cz = 1.65, 0.75
    dash.append([B.v((x, L / 2 - (cu + (u - cu) * k), cz + (z - cz) * k)) for u, z in dash_sec])
dmid = Vector((0, L / 2 - 1.65, 0.75))
for r0, r1 in zip(dash, dash[1:]):
    for j in range(len(dash_sec)):
        q = (r0[j], r0[(j + 1) % len(dash_sec)], r1[(j + 1) % len(dash_sec)], r1[j])
        c = sum((v.co for v in q), Vector()) / 4
        B.face(q, "Interior", Vector((0, c.y - dmid.y, c.z - dmid.z)))
B.face(dash[0], "Interior", Vector((-1, 0, 0)))
B.face(dash[-1], "Interior", Vector((1, 0, 0)))
rbox(B, "Gap", (1.42, 0.012, 0.010), 0.003, place(0.0, 1.938, 0.815), segs=1)  # the vent along the dash
# Screen: landscape, standing on the middle of the dash, leaning back a little.
scr = place(0.0, 1.95, 1.00, -10)
rbox(B, "Interior", (0.37, 0.022, 0.225), 0.006, scr, segs=1)
sv = [B.v(scr @ Vector((x, -0.0115, z))) for x, z in ((-0.172, -0.100), (0.172, -0.100), (0.172, 0.100), (-0.172, 0.100))]
B.face(sv, "Screen", scr.to_3x3() @ Vector((0, -1, 0)))
rbox(B, "Interior", (0.05, 0.07, 0.08), 0.01, place(0.0, 1.94, 0.88, -10))
# Steering wheel: a round rim with two side spokes and one below, the hub, the column into the dash.
sw = place(-0.37, 2.10, 0.86, -24)  # the wheel's face towards the driver (-Y), its top leaning forward
R, r_t, nmaj, nmin = 0.18, 0.016, 36, 8
tor = [[B.v(sw @ Vector(((R + r_t * math.cos(b)) * math.cos(a), r_t * math.sin(b), (R + r_t * math.cos(b)) * math.sin(a))))
        for b in (2 * math.pi * j / nmin for j in range(nmin))] for a in (2 * math.pi * i / nmaj for i in range(nmaj))]
for i in range(nmaj):
    for j in range(nmin):
        q = (tor[i][j], tor[(i + 1) % nmaj][j], tor[(i + 1) % nmaj][(j + 1) % nmin], tor[i][(j + 1) % nmin])
        a = 2 * math.pi * (i + 0.5) / nmaj
        ring_c = sw @ Vector((R * math.cos(a), 0, R * math.sin(a)))
        B.face(q, "Interior", sum((v.co for v in q), Vector()) / 4 - ring_c)
for ang, ln in ((0, 0.125), (180, 0.125), (270, 0.125)):
    m = sw @ Matrix.Rotation(math.radians(-ang), 4, "Y") @ Matrix.Translation((0.10, 0.004, 0))
    rbox(B, "Interior", (ln, 0.02, 0.036), 0.008, m, segs=1)
rbox(B, "Interior", (0.11, 0.055, 0.09), 0.02, sw @ Matrix.Translation((0, -0.012, 0)))
rbox(B, "Interior", (0.06, 0.24, 0.06), 0.015, sw @ Matrix.Translation((0, 0.15, -0.01)), segs=1)
# Front seats (integrated headrests), the console, the rear bench with three headrests, the parcel shelf.
for x in (-0.37, 0.37):
    rbox(B, "Interior", (0.50, 0.50, 0.12), 0.04, place(x, 2.62, 0.48, 5))
    rbox(B, "Interior", (0.50, 0.12, 0.60), 0.045, place(x, 2.94, 0.84, 17))
    rbox(B, "Interior", (0.28, 0.10, 0.20), 0.05, place(x, 3.04, 1.20, 17))
rbox(B, "Interior", (0.22, 0.85, 0.22), 0.04, place(0.0, 2.45, 0.43))
rbox(B, "Interior", (1.24, 0.48, 0.12), 0.045, place(0.0, 3.42, 0.50, 4))
rbox(B, "Interior", (1.24, 0.12, 0.50), 0.045, place(0.0, 3.74, 0.83, 24))
for x in (-0.42, 0.0, 0.42):
    rbox(B, "Interior", (0.24, 0.075, 0.13), 0.03, place(x, 3.84, 1.10, 24))
rbox(B, "Interior", (1.18, 0.30, 0.025), 0.01, place(0.0, 3.93, 1.05, -6), segs=1)

details = B.obj()
bpy.ops.object.select_all(action="DESELECT")
body.select_set(True)
details.select_set(True)
bpy.context.view_layer.objects.active = body
bpy.ops.object.join()
body.data.set_sharp_from_angle(angle=math.radians(65))


# ---- Wheels: one mesh for all four. A 235/40 R19 tyre with a rounded sidewall and three tread grooves; a
# two-tone 19-inch wheel with five pairs of spokes (silver faces, dark sides) in front of a dark barrel; the
# brake disc behind (it rolls with the wheel).
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
    for gx in (0.041, 0.0, -0.041):
        tread += [(gx + 0.0042, 0.3353), (gx + 0.0042, 0.3293), (gx - 0.0042, 0.3293), (gx - 0.0042, 0.3353)]
    loft([(0.0957, 0.2475), (0.1058, 0.2588), (0.1136, 0.2742), (0.1173, 0.2912), (0.1155, 0.3074), (0.1095, 0.3196),
          (0.0994, 0.3289), (0.0865, 0.3340), (0.0736, 0.3353)] + tread +
         [(-0.0736, 0.3353), (-0.0957, 0.3305), (-0.1113, 0.3172), (-0.1173, 0.2912), (-0.1104, 0.2652), (-0.0957, 0.2475)],
         "Tyre")
    # Rim: the flange (the bright lip round the spokes), then the dark barrel going in, closed at the back.
    loft([(0.0957, 0.2485), (0.1035, 0.2455), (0.1053, 0.239), (0.1021, 0.2335), (0.092, 0.231)], "Rim", right=False)
    back = loft([(0.092, 0.231), (-0.087, 0.231)], "RimDark", right=False)[-1]
    W.face(back, "RimDark", Vector((1, 0, 0)))  # the hub side, seen through the spokes
    # Five pairs of spokes: each pair grows from one root at the hub and opens into a V towards the lip;
    # straight blades, narrow at the hub and wide at the lip, folded along a ridge.
    for sp in range(10):
        pair, side = divmod(sp, 2)
        side = 1 if side else -1
        a0 = 2 * math.pi * pair / 5
        root = Vector((math.cos(a0 + side * 0.03), math.sin(a0 + side * 0.03))) * 0.05
        tip = Vector((math.cos(a0 + side * 0.175 + 0.04), math.sin(a0 + side * 0.175 + 0.04))) * 0.2335
        pts = []
        for i in range(7):
            t = i / 6
            c = root.lerp(tip, t)
            r = c.length
            ang = math.atan2(c.y, c.x)
            hw = (0.0068 + 0.0195 * t ** 1.1) / r
            xf = 0.081 + 0.016 * t
            cs = lambda a_, rr=r: (rr * math.cos(a_), rr * math.sin(a_))
            ridge = ang + side * 0.3 * hw  # the fold sits towards the outside of the V
            front = [(xf - 0.008, *cs(ang - hw)), (xf, *cs(ridge)), (xf - 0.008, *cs(ang + hw))]
            rear = [(xf - 0.028, *cs(ang - hw)), (xf - 0.028, *cs(ang + hw))]
            pts.append(([W.v(p) for p in front], [W.v(p) for p in rear], ang))
        for (f0, b0, g0), (f1, b1, g1) in zip(pts, pts[1:]):
            gm = (g0 + g1) / 2
            tang = Vector((0, -math.sin(gm), math.cos(gm)))
            W.face((f0[0], f1[0], f1[1], f0[1]), "Rim", Vector((1, 0, 0)) - tang * 0.5)
            W.face((f0[1], f1[1], f1[2], f0[2]), "Rim", Vector((1, 0, 0)) + tang * 0.5)
            W.face((f0[0], b0[0], b1[0], f1[0]), "RimDark", -tang)
            W.face((f0[2], f1[2], b1[1], b0[1]), "RimDark", tang)
            W.face((b0[0], b0[1], b1[1], b1[0]), "RimDark", Vector((-1, 0, 0)))
    # Hub: a shallow dome with a plain dark centre cap.
    loft([(0.0845, 0.02), (0.0839, 0.034), (0.083, 0.046)], "RimDark", n=30, centre=0.0848)
    loft([(0.083, 0.046), (0.0814, 0.056), (0.0754, 0.064), (0.055, 0.064)], "Rim", n=30)
    # Brake disc with its hat, behind the spokes.
    loft([(0.033, 0.098), (-0.004, 0.106), (-0.004, 0.162), (-0.028, 0.162)], "Disc", n=48, centre=0.033)
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
print(f"model_3: {tris} triangles (body {sum(len(p.vertices) - 2 for p in body.data.polygons)})")

bpy.ops.object.select_all(action="DESELECT")
for o in [body, *wheels]:
    o.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_texcoords=False, export_cameras=False, export_lights=False)

# ---- Preview renders: front and rear three-quarter, side, top, straight front and back, a wheel close up,
# the cabin through the driver's window, orthographic side, front, back and top views at a known scale to
# lay over the drawing, and the angles of three photos.
if PREVIEW:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = 48
    if hasattr(scene.eevee, "use_raytracing"):
        scene.eevee.use_raytracing = True
    scene.render.resolution_x, scene.render.resolution_y = 1280, 720
    # Sky above, a bright horizon and dark ground below, so the paint has something to reflect.
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
    # Dithered here: blended glass in one mesh isn't sorted in Eevee and shows saw teeth where panes overlap.
    if hasattr(MAT["Glass"], "surface_render_method"):
        MAT["Glass"].surface_render_method = "DITHERED"
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    os.makedirs(PREVIEW, exist_ok=True)
    only = set(os.environ.get("VIEWS", "").split(",")) - {""}
    # Orthographic views: (label, location, rotation, metres across the image). The side and top at 232.7 px
    # per metre, the front and back at 426.7, the ground 0.72 m under the middle of the image.
    ortho = {"side_ortho": ((20, 0, 0.72), (math.pi / 2, 0, math.pi / 2), 5.5),
             "front_ortho": ((0, 20, 0.72), (math.pi / 2, 0, math.pi), 3.0),
             "rear_ortho": ((0, -20, 0.72), (math.pi / 2, 0, 0), 3.0),
             "top_ortho": ((0, 0, 20), (0, 0, math.pi / 2), 5.5)}
    views = (("front3q", (5.2, 6.0, 1.45), (0, 0.25, 0.62), 42), ("rear3q", (-5.1, -6.1, 1.6), (0, -0.3, 0.66), 42),
             ("side", (10.5, 0.0, 0.9), (0, 0, 0.7), 50), ("top", None, None, None),
             ("front", (0.6, 8.6, 0.95), (0, 0, 0.62), 50), ("rear", (-0.6, -8.6, 1.0), (0, 0, 0.66), 50),
             ("wheel", (2.1, 2.3, 0.58), (0.80, 1.49, 0.34), 55), ("cabin", (-2.1, 0.75, 1.5), (0.1, 0.3, 0.85), 28),
             ("side_ortho", None, None, None), ("front_ortho", None, None, None), ("rear_ortho", None, None, None),
             ("top_ortho", None, None, None),
             # The angles of three reference photos (front left from close by, rear left, front left), to compare.
             ("match_front", (-2.3, 4.3, 1.45), (0.1, 1.0, 0.5), 22), ("match_rear", (-3.4, -5.2, 1.35), (-0.1, -0.7, 0.62), 30),
             ("match_front2", (-3.3, 4.9, 1.2), (0.0, 0.3, 0.6), 30))
    for label, at, look, lens in views:
        if only and label not in only:
            continue
        cam.data.type = "PERSP"
        scene.render.film_transparent = False
        if label == "top":
            cam.location = (0, 0, 14)
            cam.rotation_euler = (0, 0, math.pi / 2)  # the nose to the right
            cam.data.lens = 75
        elif label in ortho:
            cam.data.type = "ORTHO"
            scene.render.film_transparent = True
            cam.location, cam.rotation_euler, cam.data.ortho_scale = ortho[label]
        else:
            cam.location = at
            cam.data.lens = lens
            d = Vector(look) - Vector(at)
            cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(PREVIEW, f"{label}.png")
        bpy.ops.render.render(write_still=True)
