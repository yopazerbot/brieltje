"""Build the Tesla Model Y (2025 refresh, black) for the game in Blender, from its real sizes.

Run (Blender 5, no window):
  blender -b -P tools/model_y.py -- <out.glb> [preview_dir] [paint]

Sizes (the maker's owner's manual, "Dimensions"; ev-database.org; automobiledimension.com): length 4.79 m,
width 1.92 m (1.98 m mirrors folded, 2.13 m out), height 1.624 m, wheelbase 2.89 m, overhangs 0.889 m
front and 1.011 m rear, track 1.636 m, ground clearance 0.167 m, 255/45 R19 tyres (0.712 m across).
Glass rake, belt height, roof peak and the lamps' sizes are not published: those were set by eye against
photos of the car, which are only used for comparing and are not part of the output.

The body is lofted from cross-sections along its length: the side profile (the tall rounded nose, hood,
windshield, roof, the long rear glass to the ducktail lip, the tail face), the plan (width) and the
window line. The sides flare out round the wheel arches, which are cut out with a black lip round each.
Panel gaps, the light bar's slot, the headlamps, the intake and the channel under the rear lip are cut
into the body (tools/car_parts.py: Cuts), so they are real grooves and recesses. Window frames, the
lower bumpers, the plate, the lip, mirrors, handles, a cabin (seats, dash, screen, steering wheel) and
the brake calipers are built on or in it. The shade the car casts on itself is baked into a colour per
corner. No logos, badges or lettering; the plate is blank.

Output: one GLB with the body, four wheels (Wheel_FL, Wheel_FR, Wheel_RL, Wheel_RR, one shared mesh)
whose origin is their axle, so the game can roll and steer them (the brake discs roll with them, the
calipers stay in the body), and "Far", a simple copy of the whole car for seeing it far off. Blender's
-Y is the back of the car; in the GLB (three.js axes) the nose points to -z. With preview_dir it also
renders small views there (paint: a colour like 0.6,0.6,0.62 to check the shape; default black).

Materials (the game swaps them by name): Paint, Glass (windshield, front doors), GlassDark (roof, rear
doors, quarter windows, tailgate), Trim, Tyre, Rim, RimDark, LightBar, LampGlass, TailLight, Gap,
Chrome, Disc, Caliper, Interior, Screen, Reflector, Plate.
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import car_parts as cp  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
PREVIEW = os.path.abspath(argv[1]) if len(argv) > 1 else ""
PAINT = tuple(float(v) for v in argv[2].split(",")) if len(argv) > 2 else (0.012, 0.012, 0.013)

L = 4.79           # length
U_F, U_R = 0.889, 3.779  # axles, from the front bumper (wheelbase 2.89; overhangs 0.889 and 1.011 with the plate)
TYRE_R = 0.356     # 255/45 R19
TRACK = 1.636
ARCH_R = 0.425     # wheel arch radius
FLARE = 0.012      # the sides flare out this much round the arches


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


# Side profile: the top of each cross-section (nose, hood, windshield, roof, rear glass, the ducktail lip,
# then the tail face going down) and its underside.
TOP = curve([(0.0, 0.70), (0.06, 0.785), (0.16, 0.81), (0.40, 0.845), (0.80, 0.915), (1.15, 0.985), (1.30, 1.02),
             (1.60, 1.22), (1.90, 1.44), (2.10, 1.545), (2.40, 1.605), (2.75, 1.624), (3.10, 1.607), (3.50, 1.55),
             (3.90, 1.44), (4.25, 1.30), (4.50, 1.19), (4.60, 1.15), (4.66, 1.10), (4.71, 0.90), (4.76, 0.64), (4.78, 0.56)])
BOTTOM = curve([(0.0, 0.30), (0.05, 0.235), (0.16, 0.20), (0.45, 0.18), (1.0, 0.168), (4.30, 0.175), (4.55, 0.24),
                (4.70, 0.31), (4.78, 0.40)])
# Plan: half the body's width (the flare adds FLARE round the arches; the doors stay 15 mm in), and half
# the width of the roof's glass (or of the hood's top).
WIDTH = curve([(0.0, 0.62), (0.03, 0.70), (0.08, 0.78), (0.16, 0.85), (0.35, 0.915), (0.70, 0.942), (1.0, 0.948), (1.45, 0.948),
               (1.70, 0.940), (2.40, 0.932), (3.10, 0.934), (3.50, 0.938), (3.80, 0.938), (4.10, 0.932), (4.35, 0.915), (4.55, 0.875),
               (4.68, 0.82), (4.78, 0.74)])
ROOF = curve([(0.0, 0.40), (0.15, 0.62), (0.60, 0.72), (1.30, 0.76), (2.10, 0.635), (2.70, 0.61), (3.50, 0.59),
              (4.20, 0.57), (4.50, 0.60), (4.65, 0.63), (4.78, 0.54)])
# How far the hood's middle stands over its edges (12 cm at the nose, 5 at the cowl); the roof's crown.
DROP = curve([(0.0, 0.12), (0.15, 0.115), (0.70, 0.08), (1.27, 0.05), (4.78, 0.05)])


# Bottom edge of the side windows: from the windshield's foot, rising a little towards the back.
BELT = curve([(1.30, 1.04), (1.80, 1.095), (2.60, 1.12), (3.40, 1.16), (3.90, 1.215), (4.12, 1.26), (4.50, 1.26)])
GREENHOUSE = (1.30, 4.50)
U_GLASS_END = 4.655  # the tailgate's glass runs back to the lip
U_QW = 4.10       # the side glass (rear quarter window) ends here; behind it the C-pillar is painted
U_B = 2.565        # the B-pillar: clear glass in front of it, dark glass behind
U_WS = 2.40        # the windshield's top edge: the dark roof glass behind it
RAIL = 0.09        # the body-coloured rail along the roof's sides (and the A-pillars)


def belt(u):
    return BELT(u) if GREENHOUSE[0] <= u <= GREENHOUSE[1] else 99.0


def haunch(u, z):
    """The rear haunch: the shoulder over the rear wheel stands out to the full width."""
    return 0.020 * cp.smooth((u - 3.25) / 0.35) * cp.smooth((4.40 - u) / 0.35) * cp.smooth(1 - abs(z - 0.88) / 0.20)


TUCK = (0.04, 0.10)  # the side above its widest point leans in this much (tumblehome), and towards the
                     # back this much more: narrow shoulders over wide haunches


def tuck(u):
    return TUCK[0] + TUCK[1] * cp.smooth((u - 3.0) / 1.1)


def section(u):
    """Half a cross-section at u, from the bottom middle round to the top middle: (x, z) points,
    the belt height and the window's key points (lx, lz: its bottom edge; tx, tz: its top edge; wr: the
    roof glass's edge)."""
    zb, zt, w = BOTTOM(u), TOP(u), WIDTH(u)
    k = min(1.0, w / 0.6)            # the small sections at the tip of the nose scale their details down
    drop = DROP(u) * min(1.0, (zt - zb) / 0.25)
    tk = tuck(u)
    wr = min(ROOF(u), w - (0.10 + RAIL) * k - tk)
    bl = min(belt(u), zt)
    glass = max(0.0, min(1.0, (zt - bl) / 0.1))
    crown = lambda x: zt - drop * (x / w) ** 2
    zs = min(bl, crown(w) - drop)  # top of the side: the shoulder
    rb = min(0.10, (zs - zb) * 0.3)
    pts = [(t * (w - rb), zb) for t in (0.0, 0.5)]
    for a in (0.0, 0.45, 0.85):  # rounded bottom corner
        ang = a * math.pi / 2
        pts.append((w - rb + rb * math.sin(ang) - 0.01 * w, zb + rb - rb * math.cos(ang)))
    n_side = 9
    for i in range(n_side + 1):  # tucked in at the bottom, widest at 60%, rolling in to the shoulder
        t = i / n_side
        z = zb + rb + (zs - zb - rb) * t
        x = w * (0.975 + 0.025 * math.sin(math.pi / 2 * t / 0.6)) if t <= 0.6 else \
            w - 0.03 * ((t - 0.6) / 0.4) ** 2 - tk * ((t - 0.6) / 0.4) ** 1.5
        pts.append((x + haunch(u, z), z))
    lx = w - 0.08 * k - tk
    lz = min(bl + 0.012, crown(lx))
    pts.append((w - 0.035 * k - tk, (zs + lz) / 2 + 0.004 * k))
    pts.append((lx, lz))
    tx = wr + RAIL * k
    tz = crown(tx) - 0.035 * glass
    for t in (0.25, 0.5, 0.75):  # side glass leaning in (or the edge of the hood)
        bow = 0.012 * glass * math.sin(math.pi * t)
        pts.append((lx + (tx - lx) * t + bow, lz + (tz - lz) * t))
    pts.append((tx, tz))
    pts.append(((tx + wr) / 2, crown((tx + wr) / 2) - 0.008 * glass))  # the rail's top
    for t in (0.0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1.0):
        x = wr * (1 - t)
        pts.append((x, crown(x)))
    return pts, bl, {"lx": lx, "lz": lz, "tx": tx, "tz": tz, "wr": wr, "bl": bl, "zt": zt, "zb": zb, "w": w}


# ---- The nose and the tail. A section that shrinks towards the tip by its own curves changes shape from
# ring to ring (its shoulder, hood edge and corners each go their own way), and a flat cap closing the last
# ring is a fan of long thin triangles: together they put ripples into the bumper's face. So in front of
# U_J and behind U_T every ring is the section there, scaled: across by the half width, up and down
# between the bottom and the top. Each of the three runs along a straight line (the curve's tangent at the
# join, so the surface carries on without a kink) times a quarter superellipse that closes it at the tip:
# upright and flat at the face, rolling round into the hood, the sides and the chin. The rings end in one
# point. The face is then smooth by construction: nothing is pushed or smoothed after the build.
U_N0 = 0.012       # the nose's tip (the front plate stands in front of it, inside the car's length)
U_J = 0.40
U_T = 4.30
NOSE_W, NOSE_T, NOSE_B = (U_J - U_N0, 2.15), (0.16, 3.6), (0.20, 3.6)   # (reach, roundness) of each
TAIL_W, TAIL_T, TAIL_B = (0.30, 4.0), (0.12, 6.0), (0.20, 2.6)
ZC_N, ZC_T = 0.42, 0.70   # the heights where the nose and the tail end


def ease(q, p):
    """A quarter superellipse: 0 at q=0 rising steeply, 1 at q=1 arriving level."""
    q = cp.clamp01(q)
    return (1 - (1 - q) ** p) ** (1 / p)


def tangent(f, u0, u, h=0.01):
    return f(u0) + (f(u0 + h) - f(u0 - h)) / (2 * h) * (u - u0)


def nose_ext(u):
    d = u - U_N0
    return (tangent(WIDTH, U_J, u) * ease(d / NOSE_W[0], NOSE_W[1]),
            ZC_N + (tangent(TOP, U_J, u) - ZC_N) * ease(d / NOSE_T[0], NOSE_T[1]),
            ZC_N - (ZC_N - tangent(BOTTOM, U_J, u)) * ease(d / NOSE_B[0], NOSE_B[1]))


def tail_ext(u):
    d = L - 0.01 - u
    return (tangent(WIDTH, U_T, u) * ease(d / TAIL_W[0], TAIL_W[1]),
            ZC_T + (tangent(TOP, U_T, u) - ZC_T) * ease(d / TAIL_T[0], TAIL_T[1]),
            ZC_T - (ZC_T - tangent(BOTTOM, U_T, u)) * ease(d / TAIL_B[0], TAIL_B[1]))


TEMPLATES = {u: section(u) for u in (U_J, U_T)}


def softened(pts, rounds=40):
    """The same half section with its corners rounded away (a smooth loop), at the same width and height.
    Each point stays near its place on the loop, so the quads between a section and its softened copy
    don't twist."""
    p = list(pts)
    for _ in range(rounds):
        # The two ends lie on the middle line: their neighbours are the next point and its mirror image, so
        # they move up or down with the rest and leave no peak in the middle.
        p = [(0.0, (p[0][1] + p[1][1]) / 2)] + \
            [((a[0] + 2 * c[0] + b[0]) / 4, (a[1] + 2 * c[1] + b[1]) / 4) for a, c, b in zip(p, p[1:], p[2:])] + \
            [(0.0, (p[-1][1] + p[-2][1]) / 2)]
    x1 = max(x for x, _ in p)
    z0, z1 = min(z for _, z in p), max(z for _, z in p)
    X1 = max(x for x, _ in pts)
    Z0, Z1 = min(z for _, z in pts), max(z for _, z in pts)
    return [(x * X1 / x1, Z0 + (z - z0) * (Z1 - Z0) / (z1 - z0)) for x, z in p]


SOFT = {u: softened(TEMPLATES[u][0]) for u in TEMPLATES}
# Where the scaled section's corners (its shoulder, the hood's edge, the bottom corner) would run across the
# face as creases towards the tip, the rings turn into the softened loop: fully within SOFT_N[0] of the tip,
# not at all from SOFT_N[1] on. Further back the corners stay: the creases along the hood.
SOFT_N, SOFT_T = (0.05, 0.24), (0.03, 0.12)


def shell_ring(u):
    """Half a cross-section of the shell at u, as section() gives it (points, belt, key points)."""
    if U_J <= u <= U_T:
        return section(u)
    tu, ext, sr, d = (U_J, nose_ext, SOFT_N, u - U_N0) if u < U_J else (U_T, tail_ext, SOFT_T, L - 0.01 - u)
    pts0, bl0, i0 = TEMPLATES[tu]
    f = 1 - cp.smooth((d - sr[0]) / (sr[1] - sr[0]))
    pts0 = [(a[0] + (s[0] - a[0]) * f, a[1] + (s[1] - a[1]) * f) for a, s in zip(pts0, SOFT[tu])]
    w, t, b = ext(u)
    sx = w / i0["w"]
    mz = lambda z: b + (t - b) * (z - i0["zb"]) / (i0["zt"] - i0["zb"])
    info = {"lx": i0["lx"] * sx, "lz": mz(i0["lz"]), "tx": i0["tx"] * sx, "tz": mz(i0["tz"]), "wr": i0["wr"] * sx,
            "bl": mz(bl0), "zt": t, "zb": b, "w": w}
    return [(x * sx, mz(z)) for x, z in pts0], info["bl"], info


def key(u, name):
    return shell_ring(u)[2][name]


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
    "GlassDark": material("GlassDark", (0.004, 0.005, 0.006), 0.03, 0.0),
    "Trim": material("Trim", (0.02, 0.02, 0.02), 0.55),
    "Tyre": material("Tyre", (0.015, 0.015, 0.015), 0.85),
    "Rim": material("Rim", (0.42, 0.43, 0.45), 0.3, 0.9),
    "RimDark": material("RimDark", (0.012, 0.012, 0.012), 0.3, 0.3),
    "LightBar": material("LightBar", (0.9, 0.95, 1.0), 0.1, emit=(0.85, 0.92, 1.0), strength=4.0),
    "LampGlass": material("LampGlass", (0.01, 0.01, 0.012), 0.05),
    "TailLight": material("TailLight", (0.5, 0.02, 0.02), 0.2, emit=(1.0, 0.05, 0.03), strength=1.5),
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


def body_material(u, x, z, nz):
    """The material of a face of the body at (u, |x|, z) with its normal's height nz."""
    info = shell_ring(u)[2]
    w, bl = info["w"], info["bl"]
    if U_QW < u < U_GLASS_END and x < info["wr"] and nz > 0.25:
        return "GlassDark"  # the tailgate's glass, down below the side windows' line to the lip
    if GREENHOUSE[0] + 0.02 < u < U_GLASS_END and z > bl + 0.015 and x < w - 0.075 and info["zt"] - bl > 0.03:
        if x > info["tx"] - 0.003:  # the side glass
            return "Paint" if u > U_QW else ("Glass" if u < U_B else "GlassDark")
        if x > info["wr"] + 0.003:  # the rail along the roof, the A-pillar
            return "Paint"
        return "Glass" if u < U_WS else "GlassDark"
    if nz < -0.5 and z < 0.32:
        return "Trim"  # underside
    return "Paint"


# ---- Body: rings of cross-sections, closed at both ends in a point.
# 35 mm apart within half a metre of each axle, 70 mm elsewhere; over the nose and the tail about 30 mm
# apart in the ring's size as well as along the car. The tail stops 1 cm short so the plate on it stays
# within the car's length.
L_BODY = L - 0.01
STEP, STEP_NEAR, STEP_END = 0.085, 0.035, 0.034


def end_stations(u_a, u_b, ext, step):
    """Rings from u_a to u_b, about `step` apart measured along the car and in the ring's width, top and bottom."""
    N = 4000
    fine = [u_a + (u_b - u_a) * i / N for i in range(N + 1)]
    e = [ext(u) for u in fine]
    acc = [0.0]
    for i in range(1, N + 1):
        du = fine[i] - fine[i - 1]
        acc.append(acc[-1] + max(math.hypot(du, e[i][k] - e[i - 1][k]) for k in range(3)))
    m = max(2, round(acc[-1] / step))
    out, k = [], 0
    for j in range(m + 1):
        while k < N and acc[k] < acc[-1] * j / m:
            k += 1
        out.append(fine[k])
    return out


def stations():
    us = end_stations(U_N0, U_J, nose_ext, STEP_END)[1:]
    u = U_J
    while u < U_T - 1e-6:
        near = min(abs(u - U_F), abs(u - U_R)) < 0.5
        u += STEP_NEAR if near else STEP
        us.append(min(u, U_T))
    us += end_stations(U_T, L_BODY, tail_ext, STEP_END)[:-1]
    out = []
    for v in us:
        if not out or v - out[-1] > 1e-4:
            out.append(v)
    return out


us = stations()
bm = bmesh.new()
rings = []
for u in us:
    half, _, _ = shell_ring(u)
    full = half + [(-x, z) for x, z in reversed(half[1:-1])]
    rings.append([bm.verts.new((x, L / 2 - u, z)) for x, z in full])
n = len(rings[0])
for a, b in zip(rings, rings[1:]):
    for i in range(n):
        bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
for rg, tip, flip in ((rings[0], (U_N0, ZC_N), True), (rings[-1], (L_BODY, ZC_T), False)):
    mid = bm.verts.new((0.0, L / 2 - tip[0], tip[1]))
    for i in range(n):
        f = (rg[i], rg[(i + 1) % n], mid)
        bm.faces.new(f[::-1] if flip else f)
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
cp.flare(bm, (L / 2 - U_F, L / 2 - U_R), TYRE_R, ARCH_R, FLARE)
for f in bm.faces:
    c = f.calc_center_median()
    f.material_index = ORDER.index(body_material(L / 2 - c.y, abs(c.x), c.z, f.normal.z))
    f.smooth = True
mesh = bpy.data.meshes.new("Body")
bm.to_mesh(mesh)
bm.free()
body = link(bpy.data.objects.new("Body", mesh))
for m in MAT.values():
    mesh.materials.append(m)

# Wheel arches: cut from the sides (their inside, the liner, is black).
for u in (U_F, U_R):
    for side in (-1, 1):
        bpy.ops.mesh.primitive_cylinder_add(vertices=40, radius=ARCH_R, depth=0.75, location=(side * 1.0, L / 2 - u, TYRE_R),
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
cp.Cuts().apply(body, MAT, ORDER)  # tidies the slots the arch cuts added


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


tree = None


def retree():
    """Ray casts go against the body as it is now."""
    global tree
    tree = BVHTree.FromObject(body, bpy.context.evaluated_depsgraph_get())


retree()


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
    # The edge slopes down to the surface a little outside the panel (a bevel, not a wall): a thin wall
    # facing the sky would catch it and glint as a dotted line from a few metres.
    edges = [((i0, j0), (i1, j1)) for (i0, j0), (i1, j1) in zip(loop, loop[1:] + loop[:1]) if V[i0][j0] and V[i1][j1]]
    away = {}
    for k0, k1 in edges:
        c0, c1 = V[k0[0]][k0[1]], V[k1[0]][k1[1]]
        e = c1[0].co - c0[0].co
        o = c0[1][1].cross(e)
        if o.dot((c0[0].co + c1[0].co) / 2 - centre) < 0:
            o = -o
        if o.length > 1e-9:
            o.normalize()
        for k in (k0, k1):
            away[k] = away.get(k, Vector()) + o
    low = {}
    for k0, k1 in edges:
        c0, c1 = V[k0[0]][k0[1]], V[k1[0]][k1[1]]
        for key_, c in ((k0, c0), (k1, c1)):
            if key_ not in low:
                p, nrm = c[1]
                o = away[key_].normalized() if away[key_].length > 1e-9 else Vector()
                low[key_] = B.v(p - nrm * 0.002 + o * min(2.5 * out, 0.012))
        mid = (c0[0].co + c1[0].co) / 2
        B.face((c0[0], c1[0], low[k1], low[k0]), mat, mid - centre)


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


# ---- Cuts into the body: the panel gaps as grooves (5 mm wide, 4 mm deep), the light bar's slot, the
# headlamps' pods, the intake, the channel under the rear lip.
G_W, G_D = 0.005, 0.004
G_STEP = 0.035  # m between a groove's samples
cuts = cp.Cuts()


def groove(hits, closed=False):
    hits = [h for h in hits if h]
    if closed and hits:
        hits = hits + hits[:2]
    # Its walls are matt black: painted, they caught the sky and glinted as dotted lines.
    cuts.add(cp.bar(hits, G_W, G_D, extend=0.002), "Gap")


def fa(x, z):
    """The angle of the FRONT ray whose hit lies x across the car at height z (signed like x)."""
    return math.copysign(angle_at(FRONT, abs(x), z), x)


# The light bar: a slot just under the hood's leading edge, across the whole nose and a little way round
# the corners into the fenders; the bar's ends.
BAR_A = 80
BAR_Z = lambda a: 0.738 - 0.024 * (abs(a) / BAR_A) ** 2.5
_end = FRONT(BAR_A, BAR_Z(BAR_A))[0]
BAR_END = (L / 2 - _end.y, _end.x)
# The tail: the ducktail lip's rows on the deck and its overhang; the channel under it (bottom, top, how far
# round in REAR's angles); the corner lamps.
LIP_U, LIP_OUT = (4.62, 4.65, 4.675, 4.698), 0.060
CH, CH_A = (1.022, 1.086), 86
TL_A, TL_Z = (60, 86), (0.990, 1.092)
lzf = lambda u: key(u, "lz")
for s in (-1, 1):
    side = side_ray(s)
    # Door gaps: from the window down to the black sill (the last one round the rear arch).
    for line in ([(1.530, lzf(1.53) - 0.004), (1.526, 0.86), (1.522, 0.56), (1.535, 0.33)],
                 [(2.565, lzf(2.565) - 0.004), (2.567, 0.86), (2.570, 0.56), (2.573, 0.33)],
                 [(3.600, lzf(3.60) - 0.004), (3.585, 0.95), (3.548, 0.80), (3.50, 0.70), (3.47, 0.66)]):
        groove([side(u, z) for u, z in dense(line, G_STEP)])
    # Hood (frunk) gaps from the light bar's ends along the creases back to the cowl. (The bumper's face runs
    # into the fenders without a seam.)
    groove([top_ray(u, s * x) for u, x in dense([(BAR_END[0] + 0.03, BAR_END[1] - 0.04), (0.40, 0.775), (0.80, 0.745),
                                                  (1.10, 0.718), (1.27, 0.70)], G_STEP)])
    # The tailgate's sides: across the deck behind the glass, then down the tail to the bumper.
    groove([top_ray(u, s * x) for u, x in dense([(4.40, ROOF(4.40) + 0.10), (4.50, 0.66), (4.56, 0.645)], G_STEP)])
    groove([back_ray(s * x, z) for x, z in dense([(0.56, CH[0] - 0.01), (0.555, 0.75), (0.545, 0.575)], G_STEP)])
groove([top_ray(1.27, x) for x in across(-0.70, 0.70, 40)])  # the hood's back edge under the windshield
groove([side_ray(-1)(u, z) for u, z in rounded_rect(4.46, 0.985, 0.115, 0.088, 0.02, 3)], closed=True)  # charge port
# The tailgate's bottom edge, along the top of the black bumper.
groove([back_ray(x, 0.575) for x in across(-0.545, 0.545, 34)])

cuts.add(cp.bar([FRONT(a, BAR_Z(a)) for a in across(-BAR_A, BAR_A, 50)], 0.026, 0.018, extend=0.004), "LampGlass")
# Headlamps: small dark wedges low at the bumper's outer corners, below and outboard of the bar's ends:
# a thin point inboard, deepest where they wrap round the corner.
HL = (fa(0.56, 0.60), fa(0.92, 0.585))
HL_T = lambda a: abs((abs(a) - HL[0]) / (HL[1] - HL[0]))
HL_Z = lambda a: 0.598 - 0.018 * HL_T(a)          # the wedge's middle: lower at the outer end
HL_H = lambda a: 0.020 + 0.050 * HL_T(a) ** 0.7   # its height
for s in (-1, 1):
    a_vals = across(s * HL[0], s * HL[1], 24)
    cuts.add(cp.bar([FRONT(a, HL_Z(a)) for a in a_vals], lambda t: HL_H(HL[0] + t * (HL[1] - HL[0])), 0.012,
                    extend=0.002), "LampGlass")
# The intake: a wide black opening along the bottom of the bumper's face, 40 mm in.
INTAKE = (fa(0.64, 0.31), 0.307, 0.100)           # its half width (as an angle), middle height, height
# Cut straight back (not along the surface's normal, which turns down and out under the chin and would
# twist the cut's edges).
cuts.add(cp.bar([(h[0], Vector((0, 1, 0))) for h in (FRONT(a, INTAKE[1]) for a in across(-INTAKE[0], INTAKE[0], 40)) if h],
                INTAKE[2], 0.040), "Trim")
# The tail: the channel under the lip from corner to corner (30 mm in) and the taller lamps at the corners.
cuts.add(cp.bar([REAR(a, sum(CH) / 2) for a in across(-CH_A, CH_A, 48)], CH[1] - CH[0], 0.036, extend=0.004), "LampGlass")
for s in (-1, 1):
    cuts.add(cp.bar([REAR(a, sum(TL_Z) / 2) for a in across(s * TL_A[0], s * TL_A[1], 14)], TL_Z[1] - TL_Z[0], 0.024,
                    extend=0.003), "LampGlass")
shell_tris = cp.triangles([body])
cuts.apply(body, MAT, ORDER)
retree()
print(f"model_y: shell {len(us)} rings x {n} points, {shell_tris} triangles; with the cuts {cp.triangles([body])}")

B = Builder("Details")

# ---- Front: the light bar in its slot, the headlamps in their pods, the slats in the intake, the lip.
# 18 mm tall: thinner, it breaks up into dashes from a few metres without the smoothing of the higher presets.
panel(B, FRONT, across(-(BAR_A - 1.5), BAR_A - 1.5, 60), lambda a: [BAR_Z(a) - 0.008, BAR_Z(a) + 0.008], "LightBar",
      out=0.001, skirt=0)
for s in (-1, 1):
    a_vals = across(s * (HL[0] + 0.5), s * (HL[1] - 0.5), 14)
    zc = HL_Z
    hh = lambda a: HL_H(a) / 2
    # The lit line along the wedge's top; under it a reflector at the outer end.
    panel(B, FRONT, a_vals, lambda a: [zc(a) + hh(a) - 0.009, zc(a) + hh(a) - 0.003], "LightBar", out=0.001, skirt=0)
    oa = across(s * (HL[0] + 0.6 * (HL[1] - HL[0])), s * (HL[1] - 1.0), 8)
    panel(B, FRONT, oa, lambda a: [zc(a) - hh(a) + 0.005, zc(a) + hh(a) - 0.013], "Chrome", out=0.004, skirt=0.004)
ia = INTAKE[0] - 2
for z in (INTAKE[1] - 0.030, INTAKE[1], INTAKE[1] + 0.030):  # slats in the intake
    panel(B, FRONT, across(-ia, ia, 45), lambda a, z=z: [z - 0.005, z + 0.005], "Trim", out=0.032, skirt=0.032)
# The black lip under the bumper, the whole width.
panel(B, FRONT, across(-fa(0.90, 0.23), fa(0.90, 0.23), 50), lambda a: [0.198, INTAKE[1] - INTAKE[2] / 2 - 0.004], "Trim",
      out=0.010, skirt=0.010)
ribbon(B, [FRONT(1.4 * math.cos(t), 0.548 + 0.011 * math.sin(t)) for t in across(0, 2 * math.pi, 16)],
       0.010, "Gap", out=0.002, closed=True)  # front camera, in the middle of the face
# The front plate (blank), under the camera.
rounded_panel(B, lambda x, z: cast((x, L / 2 + 1.0, z), (0, -1, 0)), 0.0, 0.445, 0.52, 0.11, 0.008, "Plate", na=16, nb=3,
              out=0.008, skirt=0.004)
# Wipers parked at the foot of the windshield, and the camera housing at its top.
ribbon(B, [top_ray(u, x) for u, x in dense([(1.452, -0.70), (1.43, -0.30), (1.415, 0.02)], 0.03)], 0.016, "Trim", out=0.009)
ribbon(B, [top_ray(u, x) for u, x in dense([(1.445, 0.08), (1.425, 0.35), (1.41, 0.62)], 0.03)], 0.016, "Trim", out=0.009)
rounded_panel(B, lambda x, u: top_ray(u, x), 0.0, 2.29, 0.17, 0.13, 0.03, "Gap", na=8, nb=4, out=0.0025, skirt=0)

# ---- Arches: a black lip round each.
for u in (U_F, U_R):
    for s in (-1, 1):
        cp.arch_lip(panel, B, side_ray(s), u, TYRE_R, ARCH_R, 0.028, "Trim", out=0.006)

# ---- Sides.
for s in (-1, 1):
    side = side_ray(s)
    lz = lambda u: key(u, "lz")
    tz = lambda u: key(u, "tz")
    # Black window frames: the sill, the top edge (wide at the A-pillar), the B-pillar, the pillar between
    # the rear door glass and the quarter window, and the quarter window's rear edge.
    U_QW_EDGE = U_QW
    ribbon(B, [side(u, lz(u) + 0.002) for u in across(1.50, U_QW_EDGE, 28)], 0.022, "LampGlass", out=0.003)
    ribbon(B, [side(u, tz(u) - 0.012) for u in across(1.40, U_QW_EDGE, 28)],
           lambda t: 0.050 - 0.028 * min(1.0, max(0.0, (t - 0.18) / 0.12)), "LampGlass", out=0.003)
    panel(B, side, across(2.505, 2.625, 3), lambda u: across(lz(u) + 0.004, tz(u) - 0.01, 6), "LampGlass", out=0.003,
          skirt=0.003)
    ribbon(B, [side(3.625, z) for z in across(lz(3.625) + 0.004, tz(3.625) - 0.01, 8)], 0.028, "LampGlass", out=0.003)
    ribbon(B, [side(U_QW_EDGE, z) for z in across(lz(U_QW_EDGE), tz(U_QW_EDGE) - 0.012, 8)], 0.03, "LampGlass", out=0.003)
    # Black sill between the arches.
    panel(B, side, across(1.33, 3.37, 24), lambda u: across(0.175, 0.325, 3), "Trim", out=0.005, skirt=0.005)
    # Flush door handles near each door's rear edge: black, a pocket at the front.
    for cu in (2.425, 3.445):
        cz = lz(cu) - 0.092
        rounded_panel(B, side, cu, cz, 0.150, 0.024, 0.01, "Trim", out=0.0035, skirt=0.0035)
        rounded_panel(B, side, cu - 0.058, cz, 0.034, 0.016, 0.007, "Gap", na=6, nb=3, out=0.0042, skirt=0)
    # Side repeater camera on the front fender: a small dark wedge.
    panel(B, side, across(1.385, 1.455, 6), lambda u: across(0.872 + (u - 1.385) * 0.18, 0.898 - (u - 1.385) * 0.12, 2),
          "LampGlass", out=0.004, skirt=0.004)

# ---- Roof: a dark seam where the windshield meets the roof glass.
ribbon(B, [top_ray(U_WS, x) for x in across(-ROOF(U_WS), ROOF(U_WS), 40)], 0.03, "Trim", out=0.002)

# ---- Rear: the spoiler lip, the tail light strip and the corner lamps, the black lower bumper and the plate.
# Ducktail lip: the glass's end kicks up into a sharp edge that stands out over the channel, across the deck
# and tapering into the corners over the lamps.
def on_deck(x):
    h = top_ray(LIP_U[-1], x)
    return h is not None and h[0].z > CH[1] + 0.004 and h[1].z > 0.35


lip_x = 0.0
while lip_x < 0.95 and on_deck(lip_x + 0.01):
    lip_x += 0.01
lip_rows = []
for x in across(-lip_x, lip_x, 44):
    k = cp.smooth((lip_x - abs(x)) / 0.16)
    k = max(0.12, k)
    top = [top_ray(u, x) for u in LIP_U]
    if not all(top):
        continue
    lift = (0.0006, 0.006 * k, 0.013 * k, 0.020 * k)
    row = [h[0] + Vector((0, 0, d)) for h, d in zip(top, lift)]
    edge = row[-1] + Vector((0, -LIP_OUT * k, -0.002 * k))
    row += [edge, edge + Vector((0, 0.006 * k, -0.012 * k - 0.003)), top[-1][0] + Vector((0, 0.008, -0.040))]
    lip_rows.append([B.v(p) for p in row])
for r0, r1 in zip(lip_rows, lip_rows[1:]):
    for j in range(len(r0) - 1):
        hint = Vector((0, 0, 1)) if j < 4 else (Vector((0, -1, 0)) if j == 4 else Vector((0, 0, -1)))
        B.face((r0[j], r1[j], r1[j + 1], r0[j + 1]), "Paint", hint)
for r, hint in ((lip_rows[0], Vector((-1, 0, 0))), (lip_rows[-1], Vector((1, 0, 0)))):
    B.face(r, "Paint", hint)
# In the channel: the red strip along its top from corner to corner; at each corner a taller lamp (a C of
# red in the smoked glass) wrapping round onto the side.
panel(B, REAR, across(-(CH_A - 2), CH_A - 2, 60), lambda a: [CH[1] - 0.018, CH[1] - 0.006], "TailLight", out=0.001, skirt=0)
for s in (-1, 1):
    a0, a1 = TL_A
    c_pts = [(s * (a1 - 1), TL_Z[1] - 0.010), (s * (a0 + 2), TL_Z[1] - 0.010), (s * (a0 + 0.8), TL_Z[1] - 0.022),
             (s * (a0 + 0.8), TL_Z[0] + 0.020), (s * (a0 + 2), TL_Z[0] + 0.010), (s * (a1 - 3), TL_Z[0] + 0.010)]
    ribbon(B, [REAR(a, z) for a, z in dense(c_pts, 0.6)], 0.010, "TailLight", out=0.002)
# Black lower bumper, wrapping round the corners to the arches, a step into the diffuser; the plate; the
# camera over it; a small red reflector at each top corner.
# Its top: level across the tailgate, then falling to the corners, where the body colour comes down round it.
x_at = {}


def lower_top(a):
    if a not in x_at:
        h = REAR(a, 0.40)
        x_at[a] = abs(h[0].x) if h else 1.0
    x = x_at[a]
    return 0.565 - 0.25 * cp.smooth((x - 0.47) / 0.36) - 0.04 * cp.smooth((x - 0.80) / 0.10)


panel(B, REAR, across(-80, 80, 48), lambda a: across(0.20, lower_top(a), 5), "Trim", out=0.006, skirt=0.006)
panel(B, REAR, across(-56, 56, 24), lambda a: across(0.20, 0.28 + 0.02 * (abs(a) / 56) ** 2, 2), "Trim", out=0.020,
      skirt=0.020)  # the diffuser's step
rounded_panel(B, back_ray, 0.0, 0.455, 0.52, 0.11, 0.008, "Plate", na=16, nb=3, out=0.010, skirt=0.004)
ribbon(B, [back_ray(0.012 * math.cos(t), 0.535 + 0.008 * math.sin(t)) for t in across(0, 2 * math.pi, 14)], 0.009, "Gap",
       out=0.008, closed=True)  # rear camera
for s in (-1, 1):
    panel(B, REAR, across(s * 53, s * 61, 6), lambda a: [0.520, 0.534], "Reflector", out=0.008, skirt=0)

# ---- Mirrors: a body-coloured cap on a black foot, the glass facing back, a lens strip at its front edge.
for s in (-1, 1):
    x0, x1, yb = 0.885, 1.075, L / 2 - 1.725
    secs = []
    for i in range(12):
        t = i / 11
        cap = math.sqrt(max(0.0, 1 - ((t - 0.7) / 0.3) ** 2)) if t > 0.7 else 1.0
        cap = max(cap, 0.12)
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
            B.face((vs[i][k], vs[i + 1][k], vs[i + 1][(k + 1) % 16], vs[i][(k + 1) % 16]), "Paint" if i > 0 else "Trim",
                   Vector((0, p.y - cy, p.z - cz)))
    B.face(vs[0], "Trim", Vector((-s, 0, 0)))
    B.face(vs[-1], "Paint", Vector((s, 0, 0)))
    rows = []
    for i in range(1, 10):
        ring = secs[i]
        h = max(p.z for p, _ in ring) - min(p.z for p, _ in ring)
        cz = ring[0][1][1]
        rows.append((B.v((ring[0][0].x, yb - 0.0025, cz - 0.4 * h)), B.v((ring[0][0].x, yb - 0.0025, cz + 0.4 * h))))
    for (a0, b0), (a1, b1) in zip(rows, rows[1:]):
        B.face((a0, a1, b1, b0), "Chrome", Vector((0, -1, 0)))
    strip = []
    for i in range(5, 11):
        pa, (cy, cz) = secs[i][15]
        pb, _ = secs[i][14]
        na = Vector((0, pa.y - cy, pa.z - cz)).normalized()
        nb = Vector((0, pb.y - cy, pb.z - cz)).normalized()
        strip.append((B.v(pa + na * 0.0015), B.v(pb + nb * 0.0015), na + nb))
    for (a0, b0, n0), (a1, b1, _) in zip(strip, strip[1:]):
        B.face((a0, a1, b1, b0), "LampGlass", n0)
    # The foot on the door.
    rbox(B, "Trim", (0.09, 0.07, 0.05), 0.016, place(s * 0.872, 1.70, 1.10) @ Matrix.Rotation(-s * 0.4, 4, "Y"))

# ---- Brake calipers: in the body (they must not roll), on the top of each disc, a little to the rear.
for u, alpha, span in ((U_F, 6, 40), (U_R, 30, 44)):
    for s in (-1, 1):
        cx, cy, cz = s * (TRACK / 2 + 0.005), L / 2 - u, TYRE_R  # round the disc's edge
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

details = B.obj()
details.data.set_sharp_from_angle(angle=math.radians(50))
print(f"model_y: details {cp.triangles([details])} triangles")

# ---- Cabin, seen through the glass: a dark tub (floor, door panels, the boot), the dash with its screen,
# the steering wheel (round, on the left), two front seats, the rear seats and the console between.
C = Builder("Cabin")
tub = []
for u in across(1.40, 4.40, 20):
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
tv = [[C.v((x, L / 2 - u, z)) for x, z in full] for u, full in tub]
for (u0, f0), r0, r1 in zip(tub, tv, tv[1:]):
    for j in range(len(f0) - 1):
        (xa, za), (xb, zb) = f0[j], f0[j + 1]
        dx, dz = xb - xa, zb - za
        C.face((r0[j], r0[j + 1], r1[j + 1], r1[j]), "Interior", Vector((-dz, 0, dx)))
C.face(tv[0][1:-1], "Interior", Vector((0, -1, 0)))
C.face(tv[-1][1:-1], "Interior", Vector((0, 1, 0)))
# Dash: a long rounded block under the windshield.
dash_sec = [(1.40, 0.985), (1.60, 0.982), (1.78, 0.972), (1.86, 0.957), (1.895, 0.928), (1.905, 0.885), (1.895, 0.78),
            (1.86, 0.70), (1.75, 0.62), (1.42, 0.60)]
dash = []
for x in (-0.79, -0.775, -0.70, -0.35, 0.0, 0.35, 0.70, 0.775, 0.79):
    k = 0.9 if abs(x) > 0.78 else (0.97 if abs(x) > 0.77 else 1.0)
    cu, cz = 1.65, 0.80
    dash.append([C.v((x, L / 2 - (cu + (u - cu) * k), cz + (z - cz) * k)) for u, z in dash_sec])
dmid = Vector((0, L / 2 - 1.65, 0.80))
for r0, r1 in zip(dash, dash[1:]):
    for j in range(len(dash_sec)):
        q = (r0[j], r0[(j + 1) % len(dash_sec)], r1[(j + 1) % len(dash_sec)], r1[j])
        c = sum((v.co for v in q), Vector()) / 4
        C.face(q, "Interior", Vector((0, c.y - dmid.y, c.z - dmid.z)))
C.face(dash[0], "Interior", Vector((-1, 0, 0)))
C.face(dash[-1], "Interior", Vector((1, 0, 0)))
# Screen: landscape, standing up on the middle of the dash, leaning back a little.
scr = place(0.0, 1.865, 1.07, -16)
rbox(C, "Interior", (0.36, 0.024, 0.225), 0.006, scr, segs=1)
sv = [C.v(scr @ Vector((x, -0.0125, z))) for x, z in ((-0.168, -0.102), (0.168, -0.102), (0.168, 0.102), (-0.168, 0.102))]
C.face(sv, "Screen", scr.to_3x3() @ Vector((0, -1, 0)))
rbox(C, "Interior", (0.05, 0.07, 0.09), 0.01, place(0.0, 1.86, 0.97, -16), segs=1)
# Steering wheel: a round rim with two side spokes and one below, the hub, the column into the dash.
sw = place(-0.37, 2.02, 0.905, -24)
R, r_t, nmaj, nmin = 0.185, 0.0165, 28, 6
tor = [[C.v(sw @ Vector(((R + r_t * math.cos(b)) * math.cos(a), r_t * math.sin(b), (R + r_t * math.cos(b)) * math.sin(a))))
        for b in (2 * math.pi * j / nmin for j in range(nmin))] for a in (2 * math.pi * i / nmaj for i in range(nmaj))]
for i in range(nmaj):
    for j in range(nmin):
        q = (tor[i][j], tor[(i + 1) % nmaj][j], tor[(i + 1) % nmaj][(j + 1) % nmin], tor[i][(j + 1) % nmin])
        a = 2 * math.pi * (i + 0.5) / nmaj
        ring_c = sw @ Vector((R * math.cos(a), 0, R * math.sin(a)))
        C.face(q, "Interior", sum((v.co for v in q), Vector()) / 4 - ring_c)
for ang, ln in ((0, 0.13), (180, 0.13), (270, 0.13)):
    m = sw @ Matrix.Rotation(math.radians(-ang), 4, "Y") @ Matrix.Translation((0.105, 0.004, 0))
    rbox(C, "Interior", (ln, 0.02, 0.038), 0.008, m, segs=1)
rbox(C, "Interior", (0.115, 0.055, 0.095), 0.02, sw @ Matrix.Translation((0, -0.012, 0)), segs=1)
rbox(C, "Interior", (0.06, 0.24, 0.06), 0.015, sw @ Matrix.Translation((0, 0.15, -0.01)), segs=1)
# Seats: the two in front, three in the back; the console between the front ones.
for x in (-0.37, 0.37):
    cp.seat(rbox, C, x, L / 2 - 2.72, 0.64, "Interior", width=0.50, back_h=0.80, lean=17)
for x in (-0.42, 0.0, 0.42):
    cp.seat(rbox, C, x, L / 2 - 3.68, 0.66, "Interior", width=0.40 if x else 0.36, back_h=0.66, lean=22, rear=True)
rbox(C, "Interior", (0.2, 0.78, 0.25), 0.04, place(0.0, 2.32, 0.48), segs=1)
cabin = C.obj()
cabin.data.set_sharp_from_angle(angle=math.radians(50))
cabin_tris = cp.triangles([cabin])

bpy.ops.object.select_all(action="DESELECT")
for o in (body, details, cabin):
    o.select_set(True)
bpy.context.view_layer.objects.active = body
bpy.ops.object.join()
cp.weighted_normals(body)

# ---- Wheels: one mesh for all four: a 255/45 R19 tyre and a flat black aero cover with five spokes.
wheel_data = cp.aero_wheel(Builder, TYRE_R, 0.255, 0.2413, seg=40, spokes=5)
wheels = []
for name, s, u in (("Wheel_FL", -1, U_F), ("Wheel_FR", 1, U_F), ("Wheel_RL", -1, U_R), ("Wheel_RR", 1, U_R)):
    obj = link(bpy.data.objects.new(name, wheel_data))
    obj.location = (s * TRACK / 2, L / 2 - u, TYRE_R)
    if s < 0:
        obj.rotation_euler = (0, 0, math.pi)  # the wheel's face looks out on the left too
    wheels.append(obj)
bpy.context.view_layer.update()

# ---- Far off: the same body at a few rings and points, plain wheels, the light bars as strips.
FAR_N = 20


def far_section(u):
    return shell_ring(u)[0]


def far_material(u, x, z, nrm):
    if u is None:
        return ORDER.index("Trim")
    name = body_material(u, x, z, nrm.z)
    return ORDER.index("GlassDark" if name.startswith("Glass") else name)


far_us = [U_N0 + 0.004 + (L_BODY - U_N0 - 0.008) * (1 - math.cos(math.pi * i / 35)) / 2 for i in range(36)]
far_me = cp.far_car("Far", L, far_section, far_us, FAR_N, far_material,
                    [(s * (0.962 + FLARE), L / 2 - u) for u in (U_F, U_R) for s in (-1, 1)], TYRE_R)
for m in MAT.values():
    far_me.materials.append(m)
far = link(bpy.data.objects.new("Far", far_me))
FB = Builder("FarLamps")
ribbon(FB, [FRONT(a, BAR_Z(a)) for a in across(-78, 78, 12)], 0.02, "LightBar", out=0.012)
ribbon(FB, [REAR(a, sum(CH) / 2) for a in across(-80, 80, 12)], 0.02, "TailLight", out=0.03)
fl = FB.obj()
bpy.ops.object.select_all(action="DESELECT")
far.select_set(True)
fl.select_set(True)
bpy.context.view_layer.objects.active = far
bpy.ops.object.join()
far.data.set_sharp_from_angle(angle=math.radians(60))

# ---- Shade: the car on itself and on the ground under it, the wheels on themselves, the far copy.
cp.bake_ao([body], blockers=wheels)
cp.bake_ao([wheels[1]], ground=False)
cp.bake_ao([far])

body_tris = cp.triangles([body])
wheel_tris = cp.triangles([wheels[0]])
far_tris = cp.triangles([far])
print(f"model_y: {body_tris + 4 * wheel_tris} triangles near (body {body_tris - cabin_tris}, cabin {cabin_tris}, "
      f"wheel {wheel_tris} each); far {far_tris}")
cp.export([body, *wheels, far], OUT)
print(f"model_y: {os.path.getsize(OUT)} bytes")

if PREVIEW:
    far.hide_render = True
    cp.previews(PREVIEW, (("front3q", (5.4, 6.1, 1.55), (0, 0.25, 0.72), 42), ("rear3q", (-5.3, -6.2, 1.75), (0, -0.3, 0.78), 42),
                          ("side", (10.5, 0.0, 0.95), (0, 0, 0.8), 50), ("wheel", (2.25, 2.35, 0.62), (0.84, 1.46, 0.36), 55),
                          ("front", (0.6, 8.6, 1.05), (0, 0, 0.72), 50), ("nose", (1.3, 4.3, 0.75), (0.25, 2.3, 0.5), 50), ("rear", (-0.6, -8.6, 1.15), (0, 0, 0.8), 50),
                          ("cabin", (-1.9, 3.3, 1.85), (-0.15, 0.55, 0.95), 35), ("tailc", (-2.2, -4.6, 1.0), (0.55, -1.7, 0.7), 40), ("deck", (-0.5, -4.2, 1.9), (0, -2.2, 1.05), 40)), L)
