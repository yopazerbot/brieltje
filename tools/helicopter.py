"""Build the game's helicopter in Blender: a generic light twin with a shrouded tail rotor, from its published
sizes: no maker's name, no logo, no registration, no operator's look, no text at all.

Run (Blender 5, no window):
  blender -b -P tools/helicopter.py -- <out.glb> [preview_dir] [--views a,b] [--livery A|B|C] [--manifest path]
  [--beauty]
With preview_dir: small Eevee review renders there (--views picks some). With --beauty as well: one Cycles
picture instead (beauty.png, 1920 x 1080, 128 samples, denoised): a three-quarter front view in evening light.
The run fails, before anything is written, when a check fails or a budget is broken (65,000 triangles near,
5,000 far, 1,900,000 bytes).

The livery (the game's own, following no real operator): the body in Paint; one broad band in PaintB slanting
back across the cabin, all round the machine, roof and cowling included; the tail in Paint; the rotor cap and the
blade tip bands in PaintC.

Published sizes: fuselage 10.20 m nose to tail, 12.26 m with the rotor turning; main rotor 10.40 m, four
blades on a hub without hinges, the mast leaning 5 degrees forward; the rotor head's top 3.35 m and the fin's
3.51 m over the ground; the tail rotor 1.00 m across in its shroud with ten blades; the fuselage 1.56 m wide.
Shapes the published sizes don't give (the outline from the side, the glazing, the skids' place, the tail's
housing) were set by comparing renders of this model with reference pictures, with the published sizes as
the ruler. The pictures are only used for comparing and are not part of the output.

Axes: metres; the nose looks along -z, x to the right, y up (as the cars). The origin is on the ground
under the main rotor's hub, between the skids. In Blender the nose looks along +y.

Output (the game reads these names; see the manifest):
  Body         the fuselage, the engine cowling, the tail, the skids and the cabin, joined per material
  Detail       small parts the game hides past 40 m (antennas, wipers, handles, pitot tubes, bolts)
  Rotor        spins about its own y (the mast, leaning 5 degrees forward); hub, cuffs, links, dampers, cap;
               Blade_1..Blade_4 under it, one mesh: each pivots at its root (1.15 m out), the blade along
               its local +x, its leading edge to its local -z: droop and coning turn about its local z,
               feathering about its local x
  RotorDisc    a flat ring 0.6 to 5.2 m, coned up 2.5 degrees, for the game's blur (not under Rotor: it
               does not spin); its own y is the mast's
  TailRotor    spins about its own x; hub and ten blades; TailDisc beside it, a ring 0.12 to 0.5 m
  Door_FL/FR   the cockpit doors, their origin on the hinge line at the front edge (turn about local y)
  Door_RL/RR   the sliding doors, their origin in their middle (slide along local +z)
  Stick_Cyclic (pivot at the floor), Stick_Collective (pivot at its back end), with the empties
               Grip_Cyclic, Grip_Collective under them
  Far          the simple copy for far off
  GapLines     the shut lines as loose edges, drawn one pixel wide by the game
  Empties      Seat_0 (pilot, front right) .. Seat_5: the hip point of a seated figure, facing its -z;
               Pedal_L, Pedal_R, Eye_Pilot, Step_L, Step_R
Materials (the game swaps them by name): Paint, PaintB, PaintC (the livery's three colours), Glass, Trim,
Metal, Rubber, Interior, Screen, Gap, LightRed, LightGreen, LightWhite, LightBeacon, LightLanding, RotorBlur.
The baked shade is the colour attribute "AO" (COLOR_0); on the screens it is the picture's colour instead.
"""
import json
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import car_parts as cp  # noqa: E402
import heli_parts as hp  # noqa: E402
from heli_parts import G, across, curve, ease, smooth, clamp01, inside, rbox, place, tube, lathe, Builder  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
pos = [a for a in argv if not a.startswith("--")]
opts = {}
i_ = 0
while i_ < len(argv):
    a = argv[i_]
    if a.startswith("--"):
        if i_ + 1 < len(argv) and not argv[i_ + 1].startswith("--") and a in ("--views", "--livery", "--manifest"):
            opts[a[2:]] = argv[i_ + 1]
            pos.remove(argv[i_ + 1])
            i_ += 1
        else:
            opts[a[2:]] = True
    i_ += 1
OUT = pos[0]
PREVIEW = os.path.abspath(pos[1]) if len(pos) > 1 else ""
VIEWS = opts.get("views", "")
LIVERY = opts.get("livery", "A")

# The three liveries (web/src/brand.css): (Paint, PaintB, PaintC). In the file the first; the game colours
# the three materials per machine.
LIVERIES = {"A": ("#141d3a", "#f7b928", "#fbf6ea"), "B": ("#f7b928", "#141d3a", "#fbf6ea"), "C": ("#fbf6ea", "#141d3a", "#f7b928")}

# ---- Sizes (game axes: z back, y up). The hub is over the origin; the nose at z -3.15, the tail at +7.05.
Z_NOSE, Z_TAIL = -3.15, 7.05
HUB_Y = 3.20               # the rotor's middle (the blades' plane); its cap's top 3.35
MAST_TILT = 5.0            # degrees forward
ROTOR_R = 5.20
BLADE_ROOT = 1.15          # where the blade meets its cuff (its pivot)
CHORD = 0.29
TR_C = (1.85, 5.95)        # the tail rotor's middle (y, z)
TR_R = 0.50
SKID_X = 0.95              # the skid tubes' middles (track 1.90 m: the front reference picture gives 1.78 to 1.94)
SKID_R = 0.045
FLOOR_Y = 0.72
SEAT_Y = 1.10
LINER = 0.03

# ---- The shell: one loft from the nose to the end of the boom (inside the tail's housing).
Z_J = -2.55                # in front of this the nose: the rings close in a point
Z_END = 5.28
Y_TIP = 1.22
TOP = curve([(-2.55, 1.83), (-2.24, 1.95), (-1.86, 2.08), (-1.49, 2.20), (-1.0, 2.27), (-0.4, 2.30), (0.3, 2.34), (0.8, 2.42),
             (1.15, 2.45), (1.5, 2.39), (2.0, 2.25), (2.4, 2.15), (2.8, 2.07), (3.3, 2.04), (4.4, 2.00), (5.0, 1.95), (5.3, 1.93)])
BOT = curve([(-2.55, 0.69), (-2.24, 0.655), (-1.8, 0.632), (-1.0, 0.62), (0.4, 0.62), (0.85, 0.635), (1.25, 0.70), (1.7, 0.94),
             (2.1, 1.21), (2.5, 1.42), (2.8, 1.48), (3.3, 1.495), (4.4, 1.48), (5.3, 1.47)])
W = curve([(-2.55, 0.62), (-2.2, 0.69), (-1.8, 0.74), (-1.4, 0.77), (-0.9, 0.78), (0.3, 0.78), (0.8, 0.765), (1.3, 0.70), (1.8, 0.57),
           (2.3, 0.41), (2.7, 0.29), (3.1, 0.225), (4.0, 0.195), (5.3, 0.165)])
F = curve([(-2.55, 0.46), (-1.8, 0.42), (-0.5, 0.40), (0.8, 0.40), (1.6, 0.44), (2.4, 0.48), (3.0, 0.50), (5.3, 0.50)])
PL = curve([(-2.55, 2.3), (-1.6, 2.8), (0.8, 2.8), (2.0, 2.5), (3.0, 2.2), (5.3, 2.2)])
PU = curve([(-2.55, 2.1), (-1.5, 2.3), (-0.5, 2.5), (1.2, 2.6), (2.4, 2.3), (3.0, 2.1), (5.3, 2.1)])
H_PTS = 25                 # points in half a ring (48 round)


def tangent(f, z0, z, h=0.01):
    return f(z0) + (f(z0 + h) - f(z0 - h)) / (2 * h) * (z - z0)


def params(z):
    """(belly, top, half width, height of the widest as a fraction, lower and upper roundness) at z."""
    if z < Z_J:
        q = (z - Z_NOSE) / (Z_J - Z_NOSE)
        w = tangent(W, Z_J, z) * ease(q, 2.0)
        yt = Y_TIP + (tangent(TOP, Z_J, z) - Y_TIP) * ease(q, 2.2)
        yb = Y_TIP - (Y_TIP - tangent(BOT, Z_J, z)) * ease(q, 2.0)
        return yb, yt, w, F(Z_J), PL(Z_J), PU(Z_J)
    return BOT(z), TOP(z), W(z), F(z), PL(z), PU(z)


_half = {}


def half_section(z, n=H_PTS):
    """Half a ring at z from the bottom middle round the side to the top middle: (x, y) points evenly spaced."""
    key = (round(z, 6), n)
    if key in _half:
        return _half[key]
    yb, yt, w, f, pl, pu = params(z)
    yw = yb + f * (yt - yb)
    K = 90
    pts = []
    for i in range(K + 1):
        a = math.pi / 2 * i / K
        pts.append((w * math.sin(a) ** (2 / pl), yw - (yw - yb) * math.cos(a) ** (2 / pl)))
    for i in range(1, K + 1):
        a = math.pi / 2 * i / K
        pts.append((w * math.cos(a) ** (2 / pu), yw + (yt - yw) * math.sin(a) ** (2 / pu)))
    out = hp.resample(pts, n)
    _half[key] = out
    return out


def shell_x(z, y):
    """The shell's half width at height y (0 above or below it), from the section's own superellipses."""
    yb, yt, w, f, pl, pu = params(z)
    yw = yb + f * (yt - yb)
    if y >= yw:
        q = (y - yw) / (yt - yw)
        if q >= 1:
            return 0.0
        s = q ** (pu / 2)
        return w * math.sqrt(max(0.0, 1 - s * s)) ** (2 / pu)
    q = (yw - y) / (yw - yb)
    if q >= 1:
        return 0.0
    c = q ** (pl / 2)
    return w * math.sqrt(max(0.0, 1 - c * c)) ** (2 / pl)


def shell_y(z, x):
    """The shell's top at x across (the upper half), from the section's own superellipse."""
    yb, yt, w, f, pl, pu = params(z)
    yw = yb + f * (yt - yb)
    q = min(1.0, max(0.0, x / w))
    c = q ** (pu / 2)
    return yw + (yt - yw) * math.sqrt(max(0.0, 1 - c * c)) ** (2 / pu)


def stations():
    """Rings: about 35 mm apart over the nose (along the machine and in the ring's size), then by STEP."""
    N = 3000
    fine = [Z_NOSE + 0.004 + (Z_J - Z_NOSE - 0.004) * i / N for i in range(N + 1)]
    e = [params(z)[:3] for z in fine]
    acc = [0.0]
    for i in range(1, N + 1):
        dz = fine[i] - fine[i - 1]
        acc.append(acc[-1] + max(math.hypot(dz, e[i][k] - e[i - 1][k]) for k in range(3)))
    m = max(2, round(acc[-1] / 0.046))
    out, k = [], 0
    for j in range(m + 1):
        while k < N and acc[k] < acc[-1] * j / m:
            k += 1
        out.append(fine[k])
    step = curve([(-2.55, 0.052), (-1.8, 0.080), (-0.6, 0.085), (0.5, 0.072), (0.9, 0.052), (2.6, 0.058), (3.2, 0.12), (5.3, 0.17)])
    z = Z_J
    while z < Z_END - 1e-6:
        z = min(Z_END, z + step(z))
        out.append(z)
    res = []
    for v in out:
        if not res or v - res[-1] > 1e-4:
            res.append(v)
    return res


# ---- Materials.
def build_materials(livery):
    pa, pb, pc = (hp.srgb(c) for c in LIVERIES[livery])
    m = hp.material
    return {
        "Paint": m("Paint", pa, 0.2, 0.0, coat=1.0),
        "PaintB": m("PaintB", pb, 0.2, 0.0, coat=1.0),
        "PaintC": m("PaintC", pc, 0.2, 0.0, coat=1.0),
        "Glass": m("Glass", (0.05, 0.065, 0.06), 0.03, 0.0, alpha=0.35),
        "Trim": m("Trim", (0.018, 0.018, 0.019), 0.6),
        "Metal": m("Metal", (0.55, 0.56, 0.58), 0.35, 0.9),
        "Rubber": m("Rubber", (0.02, 0.02, 0.02), 0.85),
        "Interior": m("Interior", (0.16, 0.165, 0.17), 0.75),
        "Screen": m("Screen", (0.02, 0.025, 0.03), 0.1, emit=(0.6, 0.7, 0.8), strength=1.5),
        "Gap": m("Gap", (0.0, 0.0, 0.0), 0.9),
        "LightRed": m("LightRed", (0.6, 0.03, 0.02), 0.2, emit=(1.0, 0.05, 0.03), strength=4.0),
        "LightGreen": m("LightGreen", (0.03, 0.5, 0.1), 0.2, emit=(0.05, 1.0, 0.2), strength=4.0),
        "LightWhite": m("LightWhite", (0.8, 0.8, 0.8), 0.2, emit=(1.0, 1.0, 1.0), strength=4.0),
        "LightBeacon": m("LightBeacon", (0.6, 0.04, 0.03), 0.2, emit=(1.0, 0.08, 0.04), strength=4.0),
        "LightLanding": m("LightLanding", (0.85, 0.85, 0.8), 0.1, emit=(1.0, 0.97, 0.9), strength=4.0),
        "RotorBlur": m("RotorBlur", (0.3, 0.3, 0.32), 0.6, alpha=0.25),
    }


bpy.ops.wm.read_factory_settings(use_empty=True)
MAT = build_materials(LIVERY)
ORDER = list(MAT)


def new_builder(name):
    B = Builder(name, MAT)
    B.mats = list(ORDER)
    return B


# ---- The glazing, the seals round it and the colour borders, drawn from the side (z, y): the shell is cut
# along these lines (hp.bisect_polyline), so every border is a clean line on the surface.
def round_corners(poly, r, n=2):
    out = []
    m = len(poly)
    for i in range(m):
        a, b, c = Vector(poly[i - 1]), Vector(poly[i]), Vector(poly[(i + 1) % m])
        da, dc = (a - b), (c - b)
        rr = min(r, 0.4 * da.length, 0.4 * dc.length)
        p1 = b + da.normalized() * rr
        p2 = b + dc.normalized() * rr
        for k in range(n + 1):
            t = k / n
            q = p1 * (1 - t) ** 2 + b * 2 * t * (1 - t) + p2 * t * t
            out.append((q.x, q.y))
    return out


SEAL = 0.022               # the black rubber round each pane
POST = 0.025               # half the windscreen's middle post
AP = [(-2.08, 1.30), (-1.96, 1.56), (-1.82, 1.83), (-1.64, 2.13)]   # the A-pillar (the front door's front edge)


def shift(pts, dz):
    return [(z + dz, y) for z, y in pts]


WS_OUT = [(-3.6, 1.30)] + shift(AP, -0.022) + [(-1.585, 2.21), (-1.55, 2.6), (-3.6, 2.6)]
WS_IN = hp.offset_poly(WS_OUT, SEAL)
CH_OUT = round_corners([(-3.16, 1.20), (-2.24, 1.20), (-2.20, 0.95), (-2.40, 0.90), (-2.80, 0.90), (-3.05, 0.97), (-3.16, 1.06)], 0.06)
CH_IN = hp.offset_poly(CH_OUT, SEAL)
_apb = shift(AP, 0.022)
FW_OUT = round_corners([(-2.017, 1.36), _apb[1], _apb[2], (-1.695, 1.98), (-1.10, 1.98), (-1.10, 1.36)], 0.05)
LW_OUT = round_corners([(-1.98, 1.18), (-1.47, 1.18), (-1.47, 0.93), (-1.92, 0.93)], 0.05)
SW_OUT = hp.rounded_rect(-0.86, 0.25, 1.36, 1.98, 0.09)
RW_OUT = hp.rounded_rect(0.50, 0.80, 1.46, 1.94, 0.07)
SIDE_WINDOWS = [(p, hp.offset_poly(p, SEAL)) for p in (FW_OUT, LW_OUT, SW_OUT, RW_OUT)]
# The doors' shut lines (grooves), seen from the side.
FD = round_corners([(-1.68, 2.06), AP[2], AP[1], AP[0], (-2.11, 1.12), (-2.11, 0.85), (-1.03, 0.85), (-1.03, 2.06)], 0.05)
SD = hp.rounded_rect(-0.97, 0.36, 0.85, 2.06, 0.07)
# The livery: one broad band (PaintB) slanting back across the cabin, all round the machine, between two straight
# lines seen from the side. Everything else on the body is Paint. (A chalk line along it cost a draw call on the body
# and on each door it crosses: left out.)
BAND = (-1.30, 0.50, 1.05 / 2.45, 0.60)   # front edge through (z, y), its lean (dz per dy), width
BAND_EDGES = (0.0, BAND[3])


def band_f(z, y):
    """How far behind the band's front edge a point lies (m along z)."""
    return z - (BAND[0] + BAND[2] * (y - BAND[1]))


def band_line(off):
    """The edge `off` behind the band's front edge, as a side-view line from under the belly to over the cowling."""
    return [(BAND[0] + off + BAND[2] * (y - BAND[1]), y) for y in (0.3, 3.1)]


def paint_zone(z, y):
    return "PaintB" if 0.0 <= band_f(z, y) < BAND[3] else "Paint"


def shell_zone(c, n):
    zy = (c.z, c.y)
    ax = abs(c.x)
    if inside(zy, WS_OUT):
        if ax < POST:
            return "Trim"
        return "Glass" if inside(zy, WS_IN) else "Trim"
    if inside(zy, CH_OUT) and ax > 0.06:
        return "Glass" if inside(zy, CH_IN) else "Trim"
    if abs(n.x) > 0.3 and c.y > 0.85:
        for o, i in SIDE_WINDOWS:
            if inside(zy, o):
                return "Glass" if inside(zy, i) else "Trim"
    return paint_zone(c.z, c.y)


# ---- Build the shell.
us = stations()
SB = new_builder("Shell")
rings = []
for z in us:
    half = half_section(z)
    full = half + [(-x, y) for x, y in reversed(half[1:-1])]
    rings.append([SB.v((x, y, z)) for x, y in full])
n_ring = len(rings[0])


def ring_hint(i, j, c):
    yb, yt = params(c.z)[:2]
    return c - Vector((0, (yb + yt) / 2, c.z))


SB.grid(rings, lambda i, j: "Paint", closed=True, hint_of=ring_hint)
tip = SB.v((0.0, Y_TIP, Z_NOSE))
for k in range(n_ring):
    SB.face((rings[0][k], rings[0][(k + 1) % n_ring], tip), "Paint", Vector((0, 0, -1)))
yb_e, yt_e = params(Z_END)[:2]
endc = SB.v((0.0, (yb_e + yt_e) / 2, Z_END))
for k in range(n_ring):
    SB.face((rings[-1][k], rings[-1][(k + 1) % n_ring], endc), "Paint", Vector((0, 0, 1)))
shell_quads = len(SB.bm.faces)
# The uncut loft, kept to give every corner of the finished shell the smooth surface's normal there: a corner
# a cut adds on an edge would otherwise take its two faces' flat normals and the reflection would kink along
# every border (see smooth_normals below).
REF = SB.bm.copy()
REF.normal_update()
REF.faces.ensure_lookup_table()
REF_TREE = hp.BVHTree.FromBMesh(REF)


def cut_borders(bm, glass_only=False):
    """Cut a loft along the glass's and seals' borders (and the livery's lines): every border on an edge."""
    bisect = hp.bisect_polyline
    lines = [(WS_IN, lambda c: c.y > 1.2 and c.z < -1.3, "x", True), (CH_IN, lambda c: c.z < -2.0 and 0.8 < c.y < 1.3, "x", True)]
    for s in (-1, 1):
        lines.append(([(s * POST, 1.2), (s * POST, 3.0)], lambda c: c.z < -1.4 and c.y > 1.25, "z", False))
        lines.append(([(s * 0.06, 0.8), (s * 0.06, 1.3)], lambda c: c.z < -2.1 and 0.82 < c.y < 1.28, "z", False))
    lines += [(i, lambda c: abs(c.x) > 0.3, "x", True) for o, i in SIDE_WINDOWS]
    if not glass_only:
        lines += [(WS_OUT, lambda c: c.y > 1.2 and c.z < -1.3, "x", True), (CH_OUT, lambda c: c.z < -2.0 and 0.8 < c.y < 1.3, "x", True)]
        lines += [(o, lambda c: abs(c.x) > 0.3, "x", True) for o, i in SIDE_WINDOWS]
        lines += [(band_line(off), lambda c: True, "x", False) for off in BAND_EDGES]
    for pts, region, axis, closed in lines:
        bisect(bm, pts, region, normal_axis=axis, closed=closed)
    bm.normal_update()


bm = SB.bm
cut_borders(bm)
for f in bm.faces:
    c = hp.ungame(f.calc_center_median())
    f.material_index = ORDER.index(shell_zone(c, hp.ungame(f.normal)))
    f.smooth = True

# The liner: a second skin 30 mm inside round the cabin (Interior), a coarser loft of its own cut along the same
# lines, with holes where the glass is, and a dark reveal from each pane's edge in to it, so nobody looks at the
# back of the paint through the glass.
glass_i = ORDER.index("Glass")


def in_cabin(c):
    """Lined: the cabin's walls and roof over its floor (under the floor nobody sees it)."""
    return c.z < 0.95 and c.y > FLOOR_Y + 0.01


LB = new_builder("Liner")
# Round the cockpit (in front of Z_COCK) the lining is the shell's own faces moved in: the pilot sees it close, and
# its holes then match the glass's edges exactly. Behind, a coarser loft of its own (every other ring) is enough.
Z_COCK = -0.95
bm.normal_update()
own = {}
for f in bm.faces:
    c = hp.ungame(f.calc_center_median())
    if not in_cabin(c) or c.z > Z_COCK or f.material_index == glass_i:
        continue
    vs = []
    for v in f.verts:
        if v not in own:
            own[v] = LB.bm.verts.new(v.co - v.normal * LINER)
        vs.append(own[v])
    nf = LB.bm.faces.new(list(reversed(vs)))
    nf.material_index = ORDER.index("Interior")
l_rings = []
for i_z, z in enumerate(us):
    if z > 1.0:
        break
    if z < Z_COCK - 0.05 or i_z % 2:
        continue
    half = half_section(z, 15)
    l_rings.append((z, half + [(-x, y) for x, y in reversed(half[1:-1])]))
ln = len(l_rings[0][1])
lv = []
for z, full in l_rings:
    yb, yt = params(z)[:2]
    cy = (yb + yt) / 2
    ring = []
    for k, (x, y) in enumerate(full):
        a, b = full[k - 1], full[(k + 1) % ln]
        tx, ty = b[0] - a[0], b[1] - a[1]
        nx, ny = ty, -tx
        if nx * x + ny * (y - cy) < 0:
            nx, ny = -nx, -ny
        nl = math.hypot(nx, ny) or 1.0
        ring.append(LB.v((x - nx / nl * LINER, y - ny / nl * LINER, z)))
    lv.append(ring)
LB.grid(lv, lambda i, j: "Interior", closed=True, hint_of=lambda i, j, c: Vector((-c.x, (params(c.z)[0] + params(c.z)[1]) / 2 - c.y, 0)))
cut_borders(LB.bm, glass_only=True)
# Along the doors' outlines too: each door takes its piece of the lining (drawn in its trim), with a clean edge.
for poly in (FD, SD):
    hp.bisect_polyline(LB.bm, poly, lambda c: abs(c.x) > 0.3)
for f in list(LB.bm.faces):
    c = hp.ungame(f.calc_center_median())
    if c.z < Z_COCK - 0.06:
        continue   # the shell's own lining
    if not in_cabin(c) or shell_zone(c, hp.ungame(f.normal)) == "Glass":
        LB.bm.faces.remove(f)
for v in [v for v in LB.bm.verts if not v.link_faces]:
    LB.bm.verts.remove(v)
reveal = {}
for e in bm.edges:
    if len(e.link_faces) != 2:
        continue
    a, b = e.link_faces
    if (a.material_index == glass_i) == (b.material_index == glass_i):
        continue
    c = hp.ungame((e.verts[0].co + e.verts[1].co) / 2)
    if not in_cabin(c):
        continue
    g = a if a.material_index == glass_i else b
    v0, v1 = e.verts
    for v in (v0, v1):
        if v not in reveal:
            inner = own[v] if v in own else LB.bm.verts.new(v.co - v.normal * (LINER + 0.004))
            reveal[v] = (LB.bm.verts.new(v.co), inner)
    (p0, p3), (p1, p2) = reveal[v0], reveal[v1]
    nf = LB.bm.faces.new((p0, p1, p2, p3))
    nf.material_index = ORDER.index("Interior")   # the lining's grey: black, its facets showed from the seats
    # Face it towards the glass's middle.
    nf.normal_update()
    if nf.normal.dot(g.calc_center_median() - (v0.co + v1.co) / 2) < 0:
        nf.normal_flip()
for f in LB.bm.faces:
    f.smooth = True
liner = LB.obj()
liner_tris = cp.triangles([liner])
shell = SB.obj()
shell_tris_pre = cp.triangles([shell])
print(f"helicopter: shell {len(us)} rings x {n_ring} points, {shell_quads} faces before cuts, {shell_tris_pre} triangles; liner {liner_tris}")


# ---- The engine cowling ("doghouse") on the roof: its own loft, its foot sunk into the shell with a little flare.
DH_Z0, DH_Z1, DH_TOP, DH_W = -0.56, 1.12, 2.85, 0.44


def dh_k(z):
    return min(ease((z - DH_Z0) / 0.34, 2.0), ease((DH_Z1 - z) / 0.12, 2.5))


def dh_section(z):
    """Half the cowling's section at z: its foot 35 mm under the roof, its top level (a slight crown), its
    height easing in at the front and out at the back."""
    k = dh_k(z)
    wsc = DH_W * (0.78 + 0.22 * ease((z - DH_Z0) / 0.55, 2.0))
    # A flared foot sunk into the roof, then a quarter superellipse from the side up to the middle of the top.
    out = [(1.09 * wsc, shell_y(z, min(1.09 * wsc, 0.75)) - 0.056), (1.035 * wsc, shell_y(z, min(1.035 * wsc, 0.75)) - 0.035)]
    for i in range(14):
        t = math.pi / 2 * i / 13
        xt = max(0.0, math.cos(t)) ** (2 / 3.4)
        ht = max(0.0, math.sin(t)) ** (2 / 3.4)
        x = xt * wsc
        foot = shell_y(z, min(x, 0.75)) - 0.035
        top = DH_TOP - 0.025 * xt * xt
        out.append((x, foot + ht * (top - foot) * k))
    return out


DB = new_builder("Doghouse")
dz_list = [DH_Z0 + 0.42 * (i / 12) ** 1.4 for i in range(12)] + [z for z in across(DH_Z0 + 0.42, DH_Z1 - 0.16, 18)] + \
          [DH_Z1 - 0.16 + 0.16 * (1 - (1 - i / 8) ** 1.5) for i in range(1, 9)]
d_rings = []
for z in dz_list:
    half = dh_section(z)
    full = half + [(-x, y) for x, y in reversed(half[:-1])]
    d_rings.append([DB.v((x, y, z)) for x, y in full])
DB.grid(d_rings, lambda i, j: "Paint", closed=False, hint_of=lambda i, j, c: c - Vector((0, 2.2, c.z)))
DH_REF = DB.bm.copy()
hp.smooth_vertex_normals(DH_REF, rounds=10)   # its sections change shape quickly at the front: calm the reflections
DH_REF.faces.ensure_lookup_table()
DH_TREE = hp.BVHTree.FromBMesh(DH_REF)
# The livery's band crosses the cowling too: cut along its edges and paint by zone.
for off in BAND_EDGES:
    hp.bisect_polyline(DB.bm, band_line(off), lambda c: True, closed=False)
for f in DB.bm.faces:
    c = hp.ungame(f.calc_center_median())
    f.material_index = ORDER.index(paint_zone(c.z, c.y))
doghouse = DB.obj()


# ---- The tail: the housing round the shrouded rotor with the fin above and the bumper fin below, one surface
# round the duct (each angle a loop: the left side in to the duct, through it, out along the right side).
TCY, TCZ = TR_C
OUTLINE = [(4.98, 1.95), (5.19, 2.33), (5.47, 2.75), (5.72, 3.15), (5.90, 3.40), (6.00, 3.48), (6.10, 3.505), (7.02, 3.505),
           (7.13, 3.465), (6.62, 2.57), (6.72, 2.40), (6.86, 2.20), (6.95, 1.95), (6.98, 1.70), (6.93, 1.45), (6.80, 1.22),
           (6.62, 1.00), (6.50, 0.80), (6.40, 0.735), (5.85, 0.735), (5.72, 0.85), (5.58, 1.05), (5.40, 1.22), (5.18, 1.36),
           (5.00, 1.44)]
OUT_S = hp.chaikin(OUTLINE, 2)


def outline_r(th):
    """Distance from the duct's middle to the outline along the angle th (0 back, 90 up)."""
    d = (math.cos(th), math.sin(th))
    best = None
    n = len(OUT_S)
    for i in range(n):
        (z0, y0), (z1, y1) = OUT_S[i], OUT_S[(i + 1) % n]
        ax, ay = z0 - TCZ, y0 - TCY
        bx, by = z1 - z0, y1 - y0
        den = d[0] * by - d[1] * bx
        if abs(den) < 1e-12:
            continue
        t = (ax * by - ay * bx) / den
        s = (ax * d[1] - ay * d[0]) / den
        if t > 0 and -1e-9 <= s <= 1 + 1e-9:
            best = t if best is None else min(best, t)
    return best


def outline_angles(n):
    """n angles round the duct: half evenly spaced, half by the outline's length (more where it is far)."""
    lens = [0.0]
    m = len(OUT_S)
    for i in range(m):
        a, b = OUT_S[i], OUT_S[(i + 1) % m]
        lens.append(lens[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    total = lens[-1]
    start = math.atan2(OUT_S[0][1] - TCY, OUT_S[0][0] - TCZ)
    angs = []
    for k in range(n):
        t = total * k / n
        i = max(j for j in range(m) if lens[j] <= t)
        q = (t - lens[i]) / max(1e-9, lens[i + 1] - lens[i])
        a, b = OUT_S[i], OUT_S[(i + 1) % m]
        p = (a[0] + (b[0] - a[0]) * q, a[1] + (b[1] - a[1]) * q)
        ang = math.atan2(p[1] - TCY, p[0] - TCZ)
        angs.append(ang)
    # Unwrap to a monotone run from the start.
    out = [angs[0]]
    for a in angs[1:]:
        while a - out[-1] > math.pi:
            a -= 2 * math.pi
        while a - out[-1] < -math.pi:
            a += 2 * math.pi
        out.append(a)
    sgn = 1 if out[-1] > out[0] else -1
    uni = [start + sgn * 2 * math.pi * k / n for k in range(n)]
    return [0.5 * a + 0.5 * b for a, b in zip(out, uni)], sgn


H_FAR = curve([(-180, 0.20), (-150, 0.19), (-130, 0.08), (-110, 0.055), (-75, 0.055), (-55, 0.15), (-30, 0.17), (20, 0.17),
               (45, 0.075), (60, 0.06), (150, 0.06), (165, 0.19), (180, 0.20)])
DUCT = [(0.600, -0.208), (0.560, -0.194), (0.527, -0.165), (0.509, -0.125), (0.505, -0.06), (0.505, 0.06),
        (0.510, 0.125), (0.528, 0.170), (0.562, 0.199), (0.600, 0.208)]
RING_R = 0.74              # inside this the shroud's ring


def half_thick(th, r):
    deg = math.degrees(math.atan2(math.sin(th), math.cos(th)))
    hf = H_FAR(deg)
    return hf + (0.21 - hf) * (1 - smooth((r - 0.66) / 0.5))


def tail_profile(th):
    """One loop round the housing at angle th: (r, x) from the outline down the left side, through the duct, up
    the right side back to the outline."""
    R = outline_r(th)
    rr = min(half_thick(th, R - 0.1), (R - 0.62) * 0.55)
    r_e = R - rr
    side = [0.62, 0.655, 0.695, RING_R] + [RING_R + (r_e - RING_R) * (i / 5) ** 0.9 for i in range(1, 6)]
    side = [min(r, r_e - 0.002 * (len(side) - i)) if i >= 4 else r for i, r in enumerate(side)]
    h_e = half_thick(th, r_e)
    rnd = [(r_e + rr * math.sin(math.radians(a)), h_e * math.cos(math.radians(a))) for a in (30, 55, 75)]
    right = [(r, half_thick(th, r)) for r in side] + rnd
    left = [(r, -x) for r, x in reversed(right)]
    return [(R, 0.0)] + left[:-1] + DUCT + right[1:]


N_TAIL = 56
t_angles, t_sgn = outline_angles(N_TAIL)
TB = new_builder("Tail")
t_rings = []
t_prof = []
fin_k = None
for th in t_angles:
    prof = tail_profile(th)
    t_prof.append(prof)
    ring = []
    for r, x in prof:
        ring.append(TB.v((x, TCY + r * math.sin(th), TCZ + r * math.cos(th))))
    t_rings.append(ring)
n_prof = len(t_prof[0])
duct0 = 1 + (n_prof - 1 - len(DUCT)) // 2  # index where the duct starts in each loop


def tail_mat(i, j):
    return "Paint"   # the tail is the body's colour all over (the livery's band is on the cabin)


def tail_hint(i, j, c):
    th = t_angles[i]
    r, x = t_prof[i][j]
    r2, x2 = t_prof[i][(j + 1) % n_prof]
    # The loop runs from the outline down the left (-x) side, through the duct, out on the right side: its
    # outside is to the left of its direction in (r, x) seen with r up and x to the right... simply: away from
    # the slab's middle plane on the sides, towards the axis inside the duct.
    rm = (r + r2) / 2
    xm = (x + x2) / 2
    radial = Vector((0, math.sin(th), math.cos(th)))
    if rm < 0.606 and abs(xm) < 0.2:
        return -radial
    if abs(xm) < 1e-4:
        return radial
    return Vector((math.copysign(1, xm), 0, 0)) + radial * (0.3 if rm > 0.9 else 0.0)


# Quads between neighbouring angles (each loop is closed).
for i in range(N_TAIL):
    a, b = t_rings[i], t_rings[(i + 1) % N_TAIL]
    for j in range(n_prof):
        k = (j + 1) % n_prof
        q = (a[j], a[k], b[k], b[j])
        c = sum((hp.ungame(v.co) for v in q), Vector()) / 4
        TB.face(q, tail_mat(i, j), tail_hint(i, j, c))
# Its normals smoothed (the duct's lips left sharp), for smooth_normals below: the chase camera looks down on it.
TAIL_REF = TB.bm.copy()
hp.smooth_vertex_normals(TAIL_REF, rounds=12,
                         keep=lambda v: math.hypot(v.co.z - TCY, -v.co.y - TCZ) < 0.64)
TAIL_REF.faces.ensure_lookup_table()
TAIL_TREE = hp.BVHTree.FromBMesh(TAIL_REF)
tail = TB.obj()


# ---- Grooves, recesses and slots, cut into the shell and the cowling in one boolean each (car_parts.Cuts).
G_W, G_D, G_LIFT, G_STEP = 0.008, 0.005, 0.0025, 0.02
GAP_LINES = []
shell_cast = hp.Caster(shell)


def side_hit(z, y, s):
    """A hit on the shell's side from the right (s=1) or left (s=-1)."""
    return shell_cast.cast((s * 3.0, y, z), (-s, 0, 0))


def under_hit(x, z):
    return shell_cast.cast((x, -1.0, z), (0, 1, 0))


def to_b(hits):
    return [(G(p), G(n)) for p, n in hits if p is not None]


def groove(cuts, hits, closed=False, lines=True):
    """A shut line: a groove cut along every third hit (cheap), and its line along every hit. Give the hits about
    2 cm apart: a line drawn by chords further apart dips under a curved skin between its points and shows as dashes."""
    hits = [h for h in hits if h]
    if closed and hits:
        hits = hits + hits[:2]
    bar = hits[::3] + ([hits[-1]] if (len(hits) - 1) % 3 else [])
    cuts.add(cp.bar(to_b(bar), G_W, G_D, extend=0.002), "Gap")
    if lines:
        GAP_LINES.append([p + n.normalized() * G_LIFT for p, n in hits])


def cyl_cut(cuts, p, n, r, depth, mat, out=0.05, seg=20):
    """A round recess (game axes) at p into the surface along -n."""
    n = Vector(n).normalized()
    a, b = hp.frame_of(n)
    verts = []
    for d in (out, -depth):
        for k in range(seg):
            t = 2 * math.pi * k / seg
            verts.append(G(p + n * d + (a * math.cos(t) + b * math.sin(t)) * r))
    faces = [tuple(range(seg))[::-1], tuple(range(seg, 2 * seg))]
    for k in range(seg):
        faces.append((k, (k + 1) % seg, seg + (k + 1) % seg, seg + k))
    cuts.add((verts, faces), mat)


def rect_cut(cuts, p, n, up, w, h, depth, mat, out=0.05):
    """A rectangular recess w across, h along `up`, at p into the surface along -n (game axes)."""
    n = Vector(n).normalized()
    u = (Vector(up) - n * Vector(up).dot(n)).normalized()
    s = n.cross(u)
    verts = []
    for d in (out, -depth):
        for cu, cs in ((-1, -1), (-1, 1), (1, 1), (1, -1)):
            verts.append(G(p + n * d + u * cu * h / 2 + s * cs * w / 2))
    faces = [(3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    cuts.add((verts, faces), mat)


cuts = cp.Cuts()
for s in (-1, 1):
    groove(cuts, [side_hit(z, y, s) for z, y in hp.dense(FD + FD[:1], G_STEP)])
    groove(cuts, [side_hit(z, y, s) for z, y in hp.dense(SD + SD[:1], G_STEP)])
    # The rear (clamshell) doors under the boom: their front edge and top on each side.
    groove(cuts, [side_hit(z, y, s) for z, y in hp.dense([(1.06, 0.66), (1.06, 1.46), (1.13, 1.55), (2.38, 1.57)], G_STEP)])
groove(cuts, [under_hit(0.0, z) for z in across(1.08, 2.36, 64)])  # where the two meet

# Lamps sit in round recesses: two landing lamps under the chin, one under the belly.
LAMPS = []                 # (point, normal, radius, material)
for s in (-1, 1):
    h = shell_cast.cast((s * 0.22, -1.0, -2.62), (0, 1, 0))
    LAMPS.append((h[0], h[1], 0.045, "LightLanding"))
h = shell_cast.cast((0.0, -1.0, -0.35), (0, 1, 0))
LAMPS.append((h[0], h[1], 0.05, "LightLanding"))
# The strobe under the boom.
h = shell_cast.cast((0.0, -1.0, 3.70), (0, 1, 0))
LAMPS.append((h[0], h[1], 0.035, "LightWhite"))
for p, n, r, mat in LAMPS:
    cyl_cut(cuts, p, n, r + 0.012, 0.03, "Trim")

# Louvres on the engine deck behind the cowling (each side), cut as a shallow recess with slats laid in it.
LOUVRES = []
for s in (-1, 1):
    h = side_hit(1.32, 2.12, s)
    LOUVRES.append((h, s))
    rect_cut(cuts, h[0], h[1], (0, 1, 0.25), 0.26, 0.14, 0.03, "Gap")
cuts.apply(shell, MAT, ORDER)
print(f"helicopter: shell with its cuts {cp.triangles([shell])} triangles")

# The cowling's intakes (front) and side grilles.
dcuts = cp.Cuts()
dh_cast = hp.Caster(doghouse)
INTAKES = []
for s in (-1, 1):
    h = dh_cast.cast((s * 0.21, 2.70, -2.0), (0, 0, 1))
    INTAKES.append((h, s))
    rect_cut(dcuts, h[0], h[1], (0, 1, 0), 0.26, 0.10, 0.06, "Gap")
    h2 = dh_cast.cast((s * 2.0, 2.62, 0.62), (-s, 0, 0))
    INTAKES.append((h2, s))
    rect_cut(dcuts, h2[0], h2[1], (0, 1, 0), 0.30, 0.12, 0.025, "Gap")
dcuts.apply(doghouse, MAT, ORDER)


# ---- Parts laid on or built round the body (they join it).
P = new_builder("Parts")
body_cast = hp.Caster(shell)

# Window seals' gap lines: none (the seal is the line). Lamps: a lens in each recess, a dark surround.
for p, n, r, mat in LAMPS:
    lathe(P, [(r + 0.006, -0.026), (r, -0.012), (r * 0.8, -0.006), (0.0, -0.002)], p, n, 20, mat)
for h, s in LOUVRES:
    p, n = h
    u = (Vector((0, 1, 0.25)) - n * Vector((0, 1, 0.25)).dot(n)).normalized()
    sd = n.cross(u)
    for k in range(5):
        c = p + u * (-0.05 + 0.025 * k) - n * 0.012
        rbox(P, "Trim", (0.24, 0.008, 0.02), 0.0, hp.basis(c, sd, u) @ place(0, 0, 0, rx=30), segs=1)
for h, s in INTAKES:
    p, n = h
    up = Vector((0, 1, 0))
    u = (up - n * up.dot(n)).normalized()
    sd = n.cross(u)
    for k in range(4):
        c = p + u * (-0.035 + 0.023 * k) - n * 0.015
        rbox(P, "Trim", (0.26 if abs(n.z) > 0.5 else 0.28, 0.006, 0.02), 0.0, hp.basis(c, sd, u), segs=1)

# The mast's fairing on the cowling and the fixed swashplate ring on three actuators (they don't turn).
tilt = math.radians(MAST_TILT)
MAST_D = Vector((0, math.cos(tilt), -math.sin(tilt)))
HUB = Vector((0, HUB_Y, 0))


def on_mast(t):
    return HUB + MAST_D * t


lathe(P, [(0.20, -0.42), (0.19, -0.38), (0.15, -0.34), (0.13, -0.33)], HUB, MAST_D, 24, "Paint")
lathe(P, [(0.13, -0.33), (0.10, -0.33)], HUB, MAST_D, 24, "Trim")
lathe(P, [(0.205, -0.262), (0.205, -0.236), (0.12, -0.236)], HUB, MAST_D, 24, "Metal", cap0=False)
lathe(P, [(0.12, -0.262), (0.205, -0.262)], HUB, MAST_D, 24, "Metal")
for k in range(3):
    a = math.radians(30 + 120 * k)
    base = on_mast(-0.40) + Vector((math.cos(a) * 0.16, 0, math.sin(a) * 0.16))
    top = on_mast(-0.262) + Vector((math.cos(a) * 0.16, 0, math.sin(a) * 0.16))
    tube(P, [base, top], 0.022, 10, "Metal")

# Exhausts: an oval black fairing on each side of the engine deck with a steel pipe looking out and back.
EXH = []
EXH_Z, EXH_Y = 1.36, 2.20
for s in (-1, 1):
    # The black shield on the cowling, an ellipse lying on it.
    hp.panel(P, lambda zz, yy, s=s: side_hit(zz, yy, s), across(EXH_Z - 0.27, EXH_Z + 0.27, 12),
             lambda zz: across(EXH_Y - 0.125 * math.sqrt(max(0.0, 1 - ((zz - EXH_Z) / 0.27) ** 2)) - 0.001,
                               EXH_Y + 0.125 * math.sqrt(max(0.0, 1 - ((zz - EXH_Z) / 0.27) ** 2)) + 0.001, 4), "Trim", out=0.004, skirt=0.004)
    p, n = side_hit(EXH_Z + 0.08, EXH_Y + 0.01, s)
    # The pipe comes out of the shield's back half looking back, out and a little up: an oval duct with a
    # steel lip and a dark inside.
    q0 = p - n * 0.10 - Vector((0, 0, 0.16))
    q1 = p + n * 0.045 + Vector((0, 0.01, 0.07))
    d = (q1 - q0).normalized()
    EXH.append((p, d, s))
    up = Vector((0, 1, 0))
    eu = (up - d * up.dot(d)).normalized()
    es = d.cross(eu).normalized()
    lathe(P, [(1.0, -(q1 - q0).length), (1.0, 0.0)], q1, d, 16, "Trim", e1=es, scale=(0.105, 0.068))
    lathe(P, [(1.0, -0.012), (1.06, 0.0), (1.10, 0.012), (1.05, 0.024), (0.94, 0.02), (0.90, -0.03)], q1, d, 16, "Metal", e1=es, scale=(0.105, 0.068))
    lathe(P, [(0.90, -0.07), (0.0, -0.07)], q1, d, 12, "Gap", e1=es, scale=(0.105, 0.068))
# Hinges for the rear (clamshell) doors and the cockpit doors.
for s in (-1, 1):
    for z, y in ((1.06, 0.82), (1.06, 1.30)):
        hh = side_hit(z - 0.03, y, s)
        rbox(P, "Trim", (0.03, 0.08, 0.06), 0.0, hp.basis(hh[0] + hh[1] * 0.012, Vector((0, 0, 1)), Vector((0, 1, 0))), segs=1)
    for z, y in ((-2.10, 1.05), (-2.04, 1.48)):
        hh = side_hit(z, y, s)
        rbox(P, "Trim", (0.06, 0.07, 0.03), 0.0, hp.basis(hh[0] + hh[1] * 0.01, Vector((0, 0, 1)), Vector((0, 1, 0))), segs=1)
    # The sliding door's rail behind it, at its foot and at its top.
    for y in (0.93, 1.99):
        hp.panel(P, lambda zz, yy: side_hit(zz, yy, s), across(0.40, 1.02, 14), lambda zz: [y - 0.012, y + 0.012], "Metal",
                 out=0.010, skirt=0.010)

# The horizontal stabiliser through the boom with its two end plates.
STAB_Y = 1.53


def aerofoil(n=12, t=0.12, camber=0.0):
    """A closed aerofoil as (chord fraction from the leading edge, thickness offset) points: the leading edge,
    over the top to the trailing edge and back under it."""
    xs = [0.0, 0.025, 0.09, 0.22, 0.42, 0.68, 1.0]
    up = []
    for x in xs:
        yt_ = 5 * t * (0.2969 * math.sqrt(x) - 0.1260 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1015 * x ** 4)
        yc = camber * 4 * x * (1 - x)
        up.append((x, yc + max(yt_, 0.012 * t / 0.12 if x > 0.95 else yt_)))
    lo = [(x, 2 * (camber * 4 * x * (1 - x)) - y) for x, y in up]
    return up + list(reversed(lo[1:]))   # 13 points: the leading edge once, the trailing edge with its thickness


AF = aerofoil()


def wing(B, sections, mat_of, close=True):
    """A lofted wing: sections are lists of game-axis points (same count, closed loops); capped at both ends."""
    vs = [[B.v(p) for p in sec] for sec in sections]
    n = len(vs[0])
    for i in range(len(vs) - 1):
        ca = sum(sections[i], Vector()) / n
        cb = sum(sections[i + 1], Vector()) / n
        for j in range(n):
            q = (vs[i][j], vs[i][(j + 1) % n], vs[i + 1][(j + 1) % n], vs[i + 1][j])
            c = sum((hp.ungame(v.co) for v in q), Vector()) / 4
            axis = (cb - ca).normalized()
            mid = ca + axis * (c - ca).dot(axis)
            B.face(q, mat_of(i, j), c - mid)
    if close:
        c0, c1 = sum(sections[0], Vector()) / n, sum(sections[1], Vector()) / n
        cN, cM = sum(sections[-1], Vector()) / n, sum(sections[-2], Vector()) / n
        B.face(vs[0], mat_of(0, 0), c0 - c1)
        B.face(vs[-1], mat_of(len(vs) - 2, 0), cN - cM)
    return vs


def stab_section(x, chord, z_le, y, thick, inverted=True):
    pts = []
    for cx, cy in AF:
        yy = cy * chord * thick / 0.12 * (-1 if inverted else 1)
        pts.append(Vector((x, y + yy, z_le + cx * chord)))
    return pts


secs = [stab_section(x, 0.52 - 0.08 * abs(x) / 1.29, 4.05 + 0.06 * abs(x) / 1.29, STAB_Y, 0.13) for x in across(-1.29, 1.29, 8)]
wing(P, secs, lambda i, j: "Paint")
for s in (-1, 1):
    plate = []
    for k, y in enumerate(across(1.06, 2.04, 6)):
        f_ = (y - 1.06) / 0.98
        chord = 0.40 - 0.10 * f_
        z_le = 4.06 + 0.26 * f_ ** 1.2
        sec = []
        for cx, cy in AF:
            sec.append(Vector((s * 1.31 + s * cy * chord * 0.11 / 0.12 * 0.5, y, z_le + cx * chord)))
        plate.append(sec)
    wing(P, plate, lambda i, j: "Paint")
    # Its navigation lamp: a small housing on the outside with a lens (red left, green right).
    c = Vector((s * 1.335, 1.60, 4.36))
    rbox(P, "Trim", (0.035, 0.07, 0.11), 0.01, place(c.x, c.y, c.z), segs=1)
    lathe(P, [(0.032, 0.0), (0.03, 0.012), (0.018, 0.024), (0.0, 0.028)], c + Vector((s * 0.016, 0, 0)), Vector((s, 0, 0)), 16,
          "LightGreen" if s > 0 else "LightRed")
# The tail light at the back of the housing and the beacon on the fin's top.
tail_cast = hp.Caster(tail)
ht = tail_cast.cast((0.0, 1.70, 9.0), (0, 0, -1))
rbox(P, "Trim", (0.07, 0.07, 0.04), 0.012, hp.basis(ht[0] + ht[1] * 0.012, Vector((1, 0, 0)), Vector((0, 1, 0))), segs=1)
lathe(P, [(0.032, 0.0), (0.03, 0.012), (0.018, 0.022), (0.0, 0.026)], ht[0] + ht[1] * 0.03, ht[1], 16, "LightWhite")
hb = tail_cast.cast((0.0, 5.0, 6.45), (0, -1, 0))
lathe(P, [(0.05, -0.01), (0.05, 0.02), (0.046, 0.022)], hb[0], Vector((0, 1, 0)), 16, "Trim", cap1=True)
lathe(P, [(0.040, 0.022), (0.039, 0.05), (0.03, 0.075), (0.015, 0.088), (0.0, 0.091)], hb[0], Vector((0, 1, 0)), 16, "LightBeacon")

# The tail rotor's still parts: the gearbox fairing on the right, eleven vanes behind the blades, the drive
# shaft's fairing from the boom's side of the duct to the hub.
TRC = Vector((0, TCY, TCZ))
lathe(P, [(0.0, 0.215), (0.07, 0.212), (0.115, 0.195), (0.135, 0.16), (0.14, 0.10), (0.14, 0.04)], TRC, Vector((1, 0, 0)), 24, "Metal")
for k in range(11):
    a = 2 * math.pi * k / 11 + 0.2
    a2 = a + math.radians(18)
    p0 = TRC + Vector((0.10, math.sin(a) * 0.13, math.cos(a) * 0.13))
    p1 = TRC + Vector((0.10, math.sin(a2) * 0.508, math.cos(a2) * 0.508))
    d = (p1 - p0).normalized()
    rbox(P, "Metal", ((p1 - p0).length, 0.085, 0.012), 0.0, hp.basis((p0 + p1) / 2, d, Vector((1, 0, 0))), segs=1)
rbox(P, "Metal", (0.10, 0.05, 0.38), 0.02, place(0.07, TCY, TCZ - 0.32), segs=1)

# ---- Skids: two tubes with their noses curved up and their tails a little, two bowed cross tubes on saddles,
# a boarding step on each skid under each door, wear shoes under the tubes.
SK_Y = SKID_R + 0.008


def skid_path():
    pts = [(1.08, SK_Y + 0.05), (1.05, SK_Y + 0.022), (1.0, SK_Y + 0.005)]
    pts += [(z, SK_Y) for z in across(0.95, -2.05, 6)]
    for a in across(0, 60, 8)[1:]:
        t = math.radians(a)
        pts.append((-2.05 - 0.33 * math.sin(t), SK_Y + 0.33 * (1 - math.cos(t))))
    t = math.radians(60)
    pts.append((pts[-1][0] - 0.06 * math.sin(t), pts[-1][1] + 0.06 * math.cos(t)))
    return pts


for s in (-1, 1):
    tube(P, [Vector((s * SKID_X, y, z)) for z, y in skid_path()], SKID_R, 12, "Trim")
    for z0 in (-1.95, -0.6, 0.55):
        rbox(P, "Metal", (0.055, 0.012, 0.32), 0.0, place(s * SKID_X, 0.006, z0), segs=1)
CROSS = [(SKID_X, 0.07), (SKID_X, 0.22), (SKID_X - 0.02, 0.35), (SKID_X - 0.08, 0.45), (SKID_X - 0.20, 0.525), (0.55, 0.565), (0.25, 0.578), (0.0, 0.58)]
CROSS_Z = (-1.62, 0.28)
for cz in CROSS_Z:
    path = [Vector((x, y, cz)) for x, y in CROSS] + [Vector((-x, y, cz)) for x, y in reversed(CROSS[:-1])]
    tube(P, path, 0.04, 10, "Trim")
    for s in (-1, 1):
        rbox(P, "Metal", (0.12, 0.05, 0.13), 0.0, place(s * 0.30, 0.61, cz), segs=1)
for s in (-1, 1):
    for zst in (-1.55, -0.40):
        tube(P, [Vector((s * SKID_X, SK_Y + 0.03, zst)), Vector((s * (SKID_X + 0.04), 0.20, zst))], 0.016, 8, "Trim")
        rbox(P, "Metal", (0.10, 0.016, 0.22), 0.0, place(s * (SKID_X + 0.05), 0.215, zst), segs=1)

# ---- The cabin, seen through the glass and from the pilot's seat: floor, rear wall, six seats, the instrument
# panel under its glare shield on a centre pedestal, the overhead panel, the sticks' boots, two pairs of pedals.
C = new_builder("Cabin")
SEATS = [("Seat_0", 0.37, -1.28, False), ("Seat_1", -0.37, -1.28, False), ("Seat_2", 0.37, 0.55, False), ("Seat_3", -0.37, 0.55, False),
         ("Seat_4", 0.37, -0.50, True), ("Seat_5", -0.37, -0.50, True)]
# Floor.
fz = across(-2.62, 0.95, 36)
frows = []
for z in fz:
    y = max(FLOOR_Y, BOT(max(z, Z_J)) + 0.07 if z >= Z_J else params(z)[0] + 0.07)
    xh = shell_x(z, y + 0.03) - LINER - 0.012
    frows.append([C.v((x, y, z)) for x in across(-xh, xh, 8)])
C.grid(frows, lambda i, j: "Interior", closed=False, hint_of=lambda i, j, c: Vector((0, 1, 0)))
# Rear wall.
zb = 0.95
half = [p for p in half_section(zb, 61) if p[1] >= FLOOR_Y - 0.01]
wall = [(max(0.0, x - LINER - 0.01), min(y, params(zb)[1] - LINER - 0.01)) for x, y in half]
wv = [C.v((x, y, zb)) for x, y in wall] + [C.v((-x, y, zb)) for x, y in reversed(wall[:-1]) if x > 1e-4]
C.face(wv, "Interior", Vector((0, 0, -1)))


def seat(Bd, x, zh, aft, front):
    """A seat whose hip point is at (x, SEAT_Y, zh), facing -z (or +z when aft)."""
    s = -1 if aft else 1
    M = place(x, 0, zh, ry=180 if aft else 0)
    rbox(Bd, "Interior", (0.48, 0.10, 0.46), 0.035, M @ place(0, SEAT_Y - 0.10, -0.10, rx=-4), segs=1)
    back = M @ place(0, SEAT_Y + 0.27, 0.17, rx=12)
    rbox(Bd, "Interior", (0.48, 0.66, 0.10), 0.035, back, segs=1)
    rbox(Bd, "Interior", (0.26, 0.20, 0.10), 0.03, back @ place(0, 0.43, -0.01), segs=1)
    for sx in (-0.09, 0.09):
        rbox(Bd, "Trim", (0.045, 0.62, 0.008), 0.0, back @ place(sx, 0.0, -0.054), segs=1)
    rbox(Bd, "Trim", (0.44, 0.045, 0.008), 0.0, M @ place(0, SEAT_Y - 0.03, -0.30, rx=80), segs=1)
    rbox(Bd, "Trim", (0.40, SEAT_Y - 0.15 - FLOOR_Y, 0.36), 0.0, M @ place(0, (SEAT_Y - 0.15 + FLOOR_Y) / 2, -0.06), segs=1)
    if front:
        for sx in (-0.15, 0.15):
            rbox(Bd, "Metal", (0.04, 0.025, 0.60), 0.0, M @ place(sx, FLOOR_Y + 0.012, -0.05), segs=1)


for name, x, zh, aft in SEATS:
    seat(C, x, zh, aft, not aft and zh < -1)
# Instrument panel: its face leaning back, the glare shield over it, the pedestal down to the floor.
PANEL = place(0, 1.25, -2.10, rx=-18)
rbox(C, "Interior", (1.10, 0.40, 0.08), 0.02, PANEL, segs=2)
rbox(C, "Trim", (1.02, 0.04, 0.24), 0.02, place(0, 1.465, -2.15, rx=-6), segs=2)
rbox(C, "Interior", (0.26, 0.34, 0.52), 0.03, place(0, FLOOR_Y + 0.17, -1.92, rx=0), segs=2)
rbox(C, "Interior", (0.26, 0.08, 0.50), 0.02, place(0, FLOOR_Y + 0.36, -1.90, rx=-8), segs=2)
SCREEN_PICS = []           # (vertices' game points, colours) laid over the screens: their colours replace the shade


def screen_quad(Mx, x0, y0, x1, y1, col, lift):
    """A flat quad on the panel's face (towards the seats, its local +z)."""
    pts = [Mx @ Vector((x0, y0, 0.041 + lift)), Mx @ Vector((x1, y0, 0.041 + lift)), Mx @ Vector((x1, y1, 0.041 + lift)),
           Mx @ Vector((x0, y1, 0.041 + lift))]
    C.face([C.v(p) for p in pts], "Screen", Mx.to_3x3() @ Vector((0, 0, 1)))
    SCREEN_PICS.append((pts, col))


SKY, GROUND, DARK, GREEN, AMBER, WHITE = (0.10, 0.35, 0.85), (0.55, 0.30, 0.10), (0.01, 0.015, 0.03), (0.15, 0.85, 0.30), (0.95, 0.65, 0.10), (0.85, 0.88, 0.92)
for k, sx in enumerate((-0.37, 0.0, 0.37)):
    w2, h2 = 0.10, 0.08
    screen_quad(PANEL, sx - w2, -0.11, sx + w2, 0.05, DARK, 0.002)
    if k != 1:
        # The pilot's and co-pilot's attitude screen: sky over ground, a little tilted; a ring gauge beside it.
        screen_quad(PANEL, sx - 0.085, -0.02, sx - 0.005, 0.04, SKY, 0.003)
        screen_quad(PANEL, sx - 0.085, -0.08, sx - 0.005, -0.02, GROUND, 0.003)
        cx, cy, R1, R2 = sx + 0.05, -0.02, 0.035, 0.027
        for j in range(16):
            a0, a1 = 2 * math.pi * j / 16, 2 * math.pi * (j + 1) / 16
            if j > 11:
                continue
            pts = [PANEL @ Vector((cx + R2 * math.cos(a0), cy + R2 * math.sin(a0), 0.044)), PANEL @ Vector((cx + R1 * math.cos(a0), cy + R1 * math.sin(a0), 0.044)),
                   PANEL @ Vector((cx + R1 * math.cos(a1), cy + R1 * math.sin(a1), 0.044)), PANEL @ Vector((cx + R2 * math.cos(a1), cy + R2 * math.sin(a1), 0.044))]
            C.face([C.v(p) for p in pts], "Screen", PANEL.to_3x3() @ Vector((0, 0, 1)))
            SCREEN_PICS.append((pts, GREEN))
    else:
        # The engine screen: bars.
        for j, hgt in enumerate((0.09, 0.11, 0.07, 0.10, 0.06)):
            bx = sx - 0.08 + j * 0.035
            screen_quad(PANEL, bx, -0.095, bx + 0.022, -0.095 + hgt, GREEN if j < 3 else AMBER, 0.003)
for sx in (-0.17, 0.17):
    screen_quad(PANEL, sx - 0.06, 0.08, sx + 0.06, 0.16, DARK, 0.002)
    screen_quad(PANEL, sx - 0.045, 0.10, sx + 0.045, 0.14, WHITE if sx > 0 else AMBER, 0.003)
# Knobs and switches: rows of small boxes on the panel's lower edge and the pedestal.
for k in range(11):
    rbox(C, "Trim", (0.018, 0.018, 0.02), 0.0, PANEL @ place(-0.40 + k * 0.08, -0.165, 0.05), segs=1)
for row in range(4):
    for k in range(4):
        rbox(C, "Trim", (0.014, 0.014, 0.018), 0.0, place(-0.08 + k * 0.04, FLOOR_Y + 0.405 - row * 0.012, -2.08 + row * 0.08, rx=-8), segs=1)
# Overhead panel between the pilots.
roof_in = shell_y(-1.35, 0.0) - LINER
rbox(C, "Interior", (0.30, 0.05, 0.50), 0.015, place(0, roof_in - 0.03, -1.40), segs=1)
for k in range(6):
    rbox(C, "Trim", (0.014, 0.02, 0.014), 0.0, place(-0.08 + (k % 3) * 0.08, roof_in - 0.06, -1.55 + (k // 3) * 0.25), segs=1)
# Ceiling lamps over the rear cabin (in the screens' material: a soft light).
for zl in (-0.25, 0.45):
    yl = shell_y(zl, 0.0) - LINER - 0.004
    pts = [Vector((-0.08, yl, zl - 0.05)), Vector((0.08, yl, zl - 0.05)), Vector((0.08, yl, zl + 0.05)), Vector((-0.08, yl, zl + 0.05))]
    C.face([C.v(p) for p in pts], "Screen", Vector((0, -1, 0)))
    SCREEN_PICS.append((pts, (1.0, 0.92, 0.75)))
# Pedals, two pairs, on arms from under the panel.
PEDALS = {}
for px in (0.25, 0.49, -0.25, -0.49):
    zp = -2.18
    tube(C, [Vector((px, 1.08, zp - 0.08)), Vector((px, 0.88, zp))], 0.012, 8, "Metal")
    rbox(C, "Trim", (0.08, 0.15, 0.02), 0.006, place(px, 0.85, zp + 0.005, rx=-62), segs=1)
    PEDALS[px] = Vector((px, 0.86, zp - 0.005))
# The cyclic's boot at the floor (the stick itself is its own node).
for sx in (0.37, -0.37):
    lathe(C, [(0.075, 0.0), (0.06, 0.04), (0.035, 0.08), (0.02, 0.10)], Vector((sx, FLOOR_Y, -1.62)), Vector((0, 1, 0)), 12, "Trim")
cabin = C.obj(smooth_angle=50)
parts = P.obj(smooth_angle=50)
print(f"helicopter: parts {cp.triangles([parts])}, cabin {cp.triangles([cabin])} triangles")

# ---- Detail (the game hides it past 40 m): pitot tubes, wipers, antennas, handles, bolts, step treads.
D = new_builder("Detail")
for s in (-1, 1):
    h = side_hit(-2.48, 1.245, s)
    p, n = h
    tube(D, [p - n * 0.01, p + n * 0.05, p + n * 0.07 + Vector((0, 0, -0.03)), p + n * 0.07 + Vector((0, 0, -0.20))], 0.008, 8, "Metal")
front_cast = hp.Caster(shell)


def front_hit(x, y):
    return front_cast.cast((x, y, -6.0), (0, 0, 1))


for s in (-1, 1):
    arm = [front_hit(s * (0.075 + 0.04 * t), 1.33 + 0.52 * t) for t in across(0, 1, 10)]
    tube(D, [h[0] + h[1] * 0.012 for h in arm if h], 0.009, 8, "Trim")
    blade_ = [front_hit(s * (0.105 + 0.04 * t), 1.40 + 0.44 * t) for t in across(0, 1, 10)]
    tube(D, [h[0] + h[1] * 0.02 for h in blade_ if h], 0.008, 8, "Trim")
    hp_ = front_hit(s * 0.075, 1.335)
    lathe(D, [(0.022, -0.005), (0.022, 0.02), (0.0, 0.026)], hp_[0], hp_[1], 10, "Trim")
# Antennas: a swept blade on the boom, one under the belly, a whip on the roof.
for (z, up) in ((3.30, 1), (0.10, -1)):
    h = shell_cast.cast((0.0, 5.0 if up > 0 else -1.0, z), (0, -up, 0))
    rbox(D, "Trim", (0.014, 0.17, 0.11), 0.005, place(0, h[0].y + up * 0.08, h[0].z + 0.03, rx=up * -18), segs=1)
hw = shell_cast.cast((0.30, 5.0, -1.10), (0, -1, 0))
tube(D, [hw[0], hw[0] + Vector((0, 0.55, 0.12))], 0.006, 6, "Trim")
# Door handles: a bevelled bar standing off the door on two posts.
for s in (-1, 1):
    for z, y in ((-1.80, 1.02), (-0.80, 1.26)):
        h = side_hit(z, y, s)
        p, n = h
        rbox(D, "Metal", (0.16, 0.022, 0.018), 0.006, hp.basis(p + n * 0.03, Vector((0, 0, 1)), Vector((0, 1, 0))), segs=1)
        for dz in (-0.06, 0.06):
            q = side_hit(z + dz, y, s)
            tube(D, [q[0] - q[1] * 0.005, q[0] + q[1] * 0.03], 0.008, 6, "Metal")
# Bolts: rows along the nose band, along the cowling's foot, round the exhausts, round the boom's joint.
nb = 0
for s in (-1, 1):
    for z in across(-3.02, -2.16, 10):
        h = side_hit(z, 1.25, s)
        if h:
            hp.hexbolt(D, h[0], h[1], 0.007, 0.004, "Metal")
            nb += 1
    for z in across(-0.55, 1.0, 16):
        h = dh_cast.cast((s * 2.0, shell_y(z, DH_W) + 0.06, z), (-s, 0, 0))
        if h:
            hp.hexbolt(D, h[0], h[1], 0.007, 0.004, "Metal")
            nb += 1
    for p, d, ss in EXH:
        if ss != s:
            continue
        a, b = hp.frame_of(d)
        for k in range(8):
            t = 2 * math.pi * k / 8
            h = shell_cast.cast(p + d * 0.02 + (a * math.cos(t) + b * math.sin(t)) * 0.14 + Vector((s * 0.4, 0, 0)), (-s, 0, 0))
            if h:
                hp.hexbolt(D, h[0], h[1], 0.007, 0.004, "Metal")
                nb += 1
for k in range(16):
    t = 2 * math.pi * k / 16
    o = Vector((math.sin(t) * 0.6, 1.72 + math.cos(t) * 0.6, 4.98))
    h = tail_cast.cast(o, Vector((0, 1.72, 4.98)) - o + Vector((0, 0, 0.05)))
    if h and abs(h[0].z - 5.0) < 0.12:
        hp.hexbolt(D, h[0], h[1], 0.007, 0.004, "Metal")
        nb += 1
# Static wicks on the stabiliser's trailing edge.
for s in (-1, 1):
    for x in (0.95, 1.2):
        tube(D, [Vector((s * x, STAB_Y, 4.55)), Vector((s * x, STAB_Y - 0.01, 4.68))], 0.006, 6, "Trim")
# Non-slip treads on the steps.
for s in (-1, 1):
    for zst in (-1.55, -0.40):
        for k in range(3):
            rbox(D, "Trim", (0.08, 0.006, 0.02), 0.0, place(s * (SKID_X + 0.05), 0.226, zst - 0.06 + 0.06 * k), segs=1)
detail = D.obj(smooth_angle=65)
# The cowling's access panels as lines only.
for s in (-1, 1):
    for path in ([(0.30, 2.30), (0.30, 2.80)], [(-0.45, 2.66), (1.00, 2.66)], [(1.18, 2.20), (2.05, 2.05)]):
        pts = hp.dense(path, 0.04)
        hits = [dh_cast.cast((s * 2.0, y, z), (-s, 0, 0)) if z < 1.1 else shell_cast.cast((s * 2.0, y, z), (-s, 0, 0)) for z, y in pts]
        hits = [h for h in hits if h]
        if len(hits) > 1:
            GAP_LINES.append([p + n * G_LIFT for p, n in hits])
print(f"helicopter: detail {cp.triangles([detail])} triangles, {nb} bolts")


# ---- The rotor: hub, four cuffs, pitch links, dampers, the swashplate's turning ring, the cap. In the rotor's
# own axes (y along the mast, blade 1 along +x, turning anticlockwise seen from above: leading edges to -z).
def blade_section(chord, pitch, z_le=None, thick=0.12, n=None):
    """A blade section (local: chord along z, the leading edge to -z, thickness along y) about its quarter chord."""
    z_le = -0.25 * chord if z_le is None else z_le
    pts = []
    c, s = math.cos(math.radians(pitch)), math.sin(math.radians(pitch))
    for cx, cy in AF:
        zz = z_le + cx * chord
        yy = cy * chord * thick / 0.12
        yy = math.copysign(max(abs(yy), 0.003), yy) if cx > 0.9 else yy
        # Pitch: the leading edge (at -z) up for a positive angle.
        pts.append((yy * c - zz * s, zz * c + yy * s))
    return pts   # (y, z)


ROOT_PITCH, TIP_PITCH = 6.0, -4.0
R = new_builder("RotorHub")
# Mast and the turning swashplate ring with its lugs; scissors.
lathe(R, [(0.075, -0.40), (0.075, 0.0)], Vector((0, 0, 0)), Vector((0, 1, 0)), 16, "Metal")
lathe(R, [(0.19, -0.226), (0.19, -0.196), (0.10, -0.196)], Vector(), Vector((0, 1, 0)), 24, "Metal")
lathe(R, [(0.10, -0.226), (0.19, -0.226)], Vector(), Vector((0, 1, 0)), 24, "Metal")
lathe(R, [(0.10, -0.196), (0.10, -0.226)], Vector(), Vector((0, 1, 0)), 24, "Metal")
for k in range(4):
    a = math.radians(90 * k)
    rot = Matrix.Rotation(a, 4, "Y")
    rbox(R, "Metal", (0.06, 0.03, 0.04), 0.008, rot @ place(0.19, -0.21, -0.11), segs=1)
rbox(R, "Trim", (0.025, 0.12, 0.03), 0.008, place(0.0, -0.15, 0.12, rx=30), segs=1)
rbox(R, "Trim", (0.025, 0.10, 0.03), 0.008, place(0.0, -0.08, 0.11, rx=-30), segs=1)
# Hub plate: a thick disc with a raised ring of bolts.
lathe(R, [(0.0, 0.045), (0.20, 0.045), (0.24, 0.03), (0.24, -0.03), (0.20, -0.045), (0.0, -0.045)][::-1], Vector(), Vector((0, 1, 0)), 24, "Metal")
for k in range(12):
    a = 2 * math.pi * k / 12
    hp.hexbolt(R, Vector((math.cos(a) * 0.17, 0.045, math.sin(a) * 0.17)), Vector((0, 1, 0)), 0.012, 0.008, "Metal", spin=a)
# Cuffs: an oval tube from the hub flattening into the blade's root section at BLADE_ROOT.
ROOT_SEC = blade_section(CHORD, ROOT_PITCH)
oval = []
nA = len(AF)
for i in range(nA):
    t = 2 * math.pi * i / nA
    oval.append((0.058 * math.sin(t), -0.085 * math.cos(t) + 0.0))   # (y, z): i=0 at the leading edge (-z), then up
for k in range(4):
    rot = Matrix.Rotation(math.radians(90 * k), 4, "Y")
    secs = []
    for r in (0.20, 0.36, 0.42, 0.48, 0.70, 0.92, BLADE_ROOT):
        q = smooth((r - 0.60) / (BLADE_ROOT - 0.60))
        sec = []
        for (oy, oz), (ry, rz) in zip(oval, ROOT_SEC):
            sec.append(rot @ Vector((r, oy + (ry - oy) * q, oz + (rz - oz) * q)))
        secs.append(sec)
    wing(R, secs, lambda i, j: "PaintC" if i == 2 else "Metal", close=False)
    # Close the cuff's inner end against the hub.
    # Pitch horn on the leading edge's side, the link down to the turning ring.
    horn = rot @ Vector((0.30, -0.02, -0.105))
    rbox(R, "Metal", (0.05, 0.05, 0.07), 0.01, rot @ place(0.30, -0.015, -0.085), segs=1)
    ring = rot @ Vector((0.19, -0.205, -0.11))
    tube(R, [ring, horn], 0.012, 8, "Metal")
    for pt in (ring, horn):
        lathe(R, [(0.0, -0.022), (0.018, -0.012), (0.018, 0.012), (0.0, 0.022)], pt, rot @ Vector((0, 0, 1)), 8, "Metal")
    # Lead-lag damper: a ribbed drum under the cuff near the hub.
    prof = []
    for j in range(6):
        x = 0.22 + j * 0.016
        prof += [(0.046, x), (0.052, x + 0.008)]
    prof = [(0.0, 0.215)] + prof + [(0.0, prof[-1][1] + 0.004)]
    lathe(R, prof, rot @ Vector((0, -0.085, 0.0)), rot @ Vector((1, 0, 0)), 10, "Rubber")
# The cap over the hub: a broad shallow dome.
lathe(R, [(0.0, 0.158), (0.12, 0.152), (0.24, 0.132), (0.32, 0.105), (0.37, 0.07), (0.385, 0.045), (0.375, 0.04), (0.33, 0.06), (0.0, 0.10)],
      Vector(), Vector((0, 1, 0)), 32, "PaintC")
rotor_hub = R.obj(smooth_angle=45)


# One blade (its own axes: along +x from its root, the leading edge to -z), shared by the four.
def blade_mesh():
    Bb = new_builder("BladeShape")
    L = ROTOR_R - BLADE_ROOT
    span = [0.0, 0.06, 0.3, 0.7, 1.2, 1.7, 2.2, 2.55, 2.6, 2.9, 2.95, 3.3, 3.55, 3.56, 3.68, 3.75, 3.76, 3.83, 3.89, 3.94, 3.98, 4.01,
            4.03, 4.045]
    secs = []
    for s_ in span:
        r = s_ / L
        pitch = ROOT_PITCH + (TIP_PITCH - ROOT_PITCH) * r
        # The tip: its leading edge swept back over the last 0.45 m, the trailing edge rounding in over the last
        # 0.15 m, the last few centimetres closing round towards a point.
        q = clamp01((s_ - 3.6) / (L - 3.6))
        z_le = -0.25 * CHORD + 0.13 * q ** 2
        z_te = 0.75 * CHORD - 0.05 * clamp01((s_ - 3.90) / (L - 3.90)) ** 2
        k = math.sqrt(max(0.0, 1 - (clamp01((s_ - 3.97) / (L - 3.97))) ** 2)) if s_ > 3.97 else 1.0
        k = max(k, 0.18)
        mid = (z_le + z_te) / 2
        z_le, z_te = mid + (z_le - mid) * k, mid + (z_te - mid) * k
        chord = z_te - z_le
        sec = blade_section(chord, pitch, z_le=z_le, thick=0.12 * min(1.0, 0.5 + 0.5 * chord / 0.2))
        secs.append([Vector((s_, y, z)) for y, z in sec])
    nP = len(AF)

    def bmat(i, j):
        s0 = span[i]
        if 3.55 <= s0 < 3.75:
            return "PaintC"
        if j in (0, nP - 1, 1) or j == nP - 2:
            return "Metal"
        return "Trim"
    vs = wing(Bb, secs, bmat, close=False)
    # Root: closed flat (it sits against the cuff's end); tip: closed round.
    Bb.face(vs[0], "Trim", Vector((-1, 0, 0)))
    tipc = Bb.v(Vector((L, 0.0, sum(p.z for p in secs[-1]) / nP)))
    for j in range(nP):
        Bb.face((vs[-1][j], vs[-1][(j + 1) % nP], tipc), "PaintC", Vector((1, 0, 0)))
    # Trim tab at the trailing edge.
    rbox(Bb, "Trim", (0.25, 0.006, 0.05), 0.002, place(2.725, 0.0, 0.75 * CHORD + 0.02), segs=1)
    o = Bb.obj(smooth_angle=40)
    return o


blade_obj = blade_mesh()
blade_data = blade_obj.data
bpy.data.objects.remove(blade_obj)


def gmat(T):
    """A transform in the game's axes as a Blender one."""
    return hp.MG @ T @ hp.MG.inverted()


ROTOR_T = Matrix.Translation((0, HUB_Y, 0)) @ Matrix.Rotation(-tilt, 4, "X")
rotor_hub.name = "Rotor"
rotor_hub.data.name = "RotorShape"
rotor_hub.matrix_world = gmat(ROTOR_T)
blades = []
for k in range(4):
    b = hp.link(bpy.data.objects.new(f"Blade_{k + 1}", blade_data))
    b.parent = rotor_hub
    b.matrix_parent_inverse = Matrix.Identity(4)
    b.matrix_basis = gmat(Matrix.Rotation(math.radians(90 * k), 4, "Y") @ Matrix.Translation((BLADE_ROOT, 0, 0)))
    blades.append(b)

# Blur discs (the game shades them): the main one with the rotor's tilt but not spinning; the tail's.
DK = new_builder("RotorDisc")
cone = math.tan(math.radians(2.5))
drings = [[DK.v((r * math.cos(2 * math.pi * k / 64), r * cone, -r * math.sin(2 * math.pi * k / 64))) for k in range(64)] for r in across(0.6, ROTOR_R, 4)]
DK.grid(drings, lambda i, j: "RotorBlur", closed=True, hint_of=lambda i, j, c: Vector((0, 1, 0)))
rotor_disc = DK.obj()
rotor_disc.matrix_world = gmat(ROTOR_T)

# The tail rotor: hub and ten blades unevenly spaced (in pairs, as on the real ones, to spread their sound).
T = new_builder("TailRotor")
lathe(T, [(0.0, -0.12), (0.06, -0.117), (0.10, -0.105), (0.125, -0.08), (0.13, -0.04), (0.13, 0.05)], Vector(), Vector((1, 0, 0)), 24, "Metal")
TR_ANG = [0.0, 32.0, 68.0, 104.0, 140.0, 180.0, 212.0, 248.0, 284.0, 320.0]
for a in TR_ANG:
    secs = []
    for r in (0.12, 0.25, 0.38, 0.495):
        pitch = math.radians(28 - 12 * (r - 0.12) / 0.375)
        ca, sa = math.cos(math.radians(a)), math.sin(math.radians(a))
        radial = Vector((0, sa, ca))
        tang = Vector((0, ca, -sa))
        ch, th = 0.068, 0.012
        sec = []
        for cx, cy in ((-0.5, 0.0), (0.0, 0.5), (0.5, 0.0), (0.0, -0.5)):
            u = Vector((math.cos(pitch), 0, 0)) * 0 + tang * math.cos(pitch) + Vector((1, 0, 0)) * math.sin(pitch)
            v = Vector((1, 0, 0)) * math.cos(pitch) - tang * math.sin(pitch)
            sec.append(radial * r + u * cx * ch + v * cy * th + Vector((-0.04, 0, 0)))
        secs.append(sec)
    wing(T, secs, lambda i, j: "Metal")
tail_rotor = T.obj(smooth_angle=40)
tail_rotor.matrix_world = gmat(Matrix.Translation((0, TCY, TCZ)))
TD = new_builder("TailDisc")
trings = [[TD.v((-0.04, r * math.sin(2 * math.pi * k / 32), r * math.cos(2 * math.pi * k / 32))) for k in range(32)] for r in (0.12, 0.31, TR_R)]
TD.grid(trings, lambda i, j: "RotorBlur", closed=True, hint_of=lambda i, j, c: Vector((1, 0, 0)))
tail_disc = TD.obj()
tail_disc.matrix_world = gmat(Matrix.Translation((0, TCY, TCZ)))

# ---- The sticks (nodes the game leans).
CYC_PIVOT = Vector((0.37, FLOOR_Y, -1.62))
CYC_GRIP = Vector((0.37, SEAT_Y + 0.18, -1.28 - 0.45))
COL_PIVOT = Vector((0.11, 0.98, -0.95))
COL_GRIP = Vector((0.11, SEAT_Y + 0.10, -1.28 - 0.20))
SC = new_builder("Stick_Cyclic")
tube(SC, [Vector((0, 0.04, 0)), CYC_GRIP - CYC_PIVOT - Vector((0, 0.06, 0))], 0.014, 10, "Trim")
rbox(SC, "Trim", (0.045, 0.13, 0.05), 0.015, place(*(CYC_GRIP - CYC_PIVOT), rx=-10), segs=2)
stick_c = SC.obj(smooth_angle=50)
stick_c.matrix_world = Matrix.Translation(G(CYC_PIVOT))
SL_ = new_builder("Stick_Collective")
tube(SL_, [Vector((0, 0, 0)), COL_GRIP - COL_PIVOT + Vector((0, 0, 0.06))], 0.016, 10, "Trim")
rbox(SL_, "Trim", (0.05, 0.05, 0.14), 0.015, place(*(COL_GRIP - COL_PIVOT)) @ place(0, 0, 0, rx=-24), segs=2)
rbox(SL_, "Trim", (0.06, 0.06, 0.06), 0.01, place(0, 0, 0), segs=1)
stick_l = SL_.obj(smooth_angle=50)
stick_l.matrix_world = Matrix.Translation(G(COL_PIVOT))

# ---- Join the body; normals; the doors cut out of it along their grooves.
bpy.ops.object.select_all(action="DESELECT")
for o in (shell, liner, doghouse, tail, parts, cabin):
    o.select_set(True)
bpy.context.view_layer.objects.active = shell
bpy.ops.object.join()
body = shell
body.name = "Body"
body.data.name = "BodyShape"


def drop_loose(obj):
    """Loose edges and points off a mesh (before its normals are set: writing a bmesh back would lose them). With
    the shut lines exported as lines, a stray edge left by a cut would go into the file as a line in the mesh's
    first material."""
    bm_ = bmesh.new()
    bm_.from_mesh(obj.data)
    loose_e = [e for e in bm_.edges if not e.link_faces]
    bmesh.ops.delete(bm_, geom=loose_e, context="EDGES")
    loose_v = [v for v in bm_.verts if not v.link_faces]
    bmesh.ops.delete(bm_, geom=loose_v, context="VERTS")
    bm_.to_mesh(obj.data)
    bm_.free()
    print(f"helicopter: {obj.name}: {len(loose_e)} loose edges, {len(loose_v)} loose points removed")


drop_loose(body)
cp.weighted_normals(body)


def smooth_normals(obj):
    """Every corner of a face lying on the shell's surface takes the smooth surface's normal there (the uncut
    loft's corner normals, blended across its face), so the reflections run on unbroken across the glass's
    borders, the seals and the colour lines. Groove walls and anything off the surface keep theirs."""
    from mathutils.interpolate import poly_3d_calc
    me = obj.data
    out = [c.vector.copy() for c in me.corner_normals]
    M = obj.matrix_world
    cos_lim = math.cos(math.radians(30))
    done = 0
    refs = ((REF_TREE, REF), (DH_TREE, DH_REF), (TAIL_TREE, TAIL_REF))
    for p in me.polygons:
        c = M @ p.center
        best = None
        for tree, rb in refs:
            hit = tree.find_nearest(c, 0.004)
            if hit[0] is not None and (best is None or hit[3] < best[0][3]):
                best = (hit, tree, rb)
        if best is None or p.normal.dot(best[0][1]) < cos_lim:
            continue
        _, tree, rb = best
        for li in p.loop_indices:
            co = M @ me.vertices[me.loops[li].vertex_index].co
            loc2, _, idx2, _ = tree.find_nearest(co, 0.01)
            if loc2 is None:
                continue
            f = rb.faces[idx2]
            w = poly_3d_calc([v.co for v in f.verts], loc2)
            n = sum((v.normal * wi for v, wi in zip(f.verts, w)), Vector())
            out[li] = n.normalized()
        done += 1
    me.normals_split_custom_set(out)
    print(f"helicopter: smooth normals on {done} faces")


smooth_normals(body)


def door_of(c):
    """Which door a point of the body belongs to (by the grooves' outlines, and near the skin), or None."""
    if abs(c.x) < 0.25:
        return None
    for name, poly in (("Door_F", FD), ("Door_R", SD)):
        if inside((c.z, c.y), poly):
            if abs(c.x) > shell_x(c.z, c.y) - 0.075:
                return name + ("R" if c.x > 0 else "L")
    return None


DOOR_ORIGIN = {}
for s, side in ((1, "R"), (-1, "L")):
    DOOR_ORIGIN["Door_F" + side] = Vector((s * shell_x(-2.10, 1.45), 1.45, -2.10))
    DOOR_ORIGIN["Door_R" + side] = Vector((s * shell_x(-0.30, 1.45), 1.45, -0.30))
doors = {}
for name in sorted(DOOR_ORIGIN):
    # Split in edit mode (the normals fixed above go with the faces).
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_mode(type="FACE")
    bpy.ops.mesh.select_all(action="DESELECT")
    bme = bmesh.from_edit_mesh(body.data)
    for f in bme.faces:
        if door_of(hp.ungame(f.calc_center_median())) == name:
            f.select_set(True)
    bmesh.update_edit_mesh(body.data)
    bpy.ops.mesh.separate(type="SELECTED")
    bpy.ops.object.mode_set(mode="OBJECT")
    new = [o for o in bpy.context.selected_objects if o is not body][0]
    new.name = name
    new.data.name = name + "Shape"
    o_b = G(DOOR_ORIGIN[name])
    new.data.transform(Matrix.Translation(-o_b))
    new.location = o_b
    # Drop the material slots it doesn't use.
    doors[name] = new
print("helicopter: doors " + ", ".join(f"{k} {cp.triangles([v])}" for k, v in doors.items()))


def used_mats(obj):
    """The materials an object's faces use (each is one draw call in the game)."""
    return sorted({obj.data.materials[p.material_index].name for p in obj.data.polygons})


def remap_mats(obj, mapping):
    """Draw some materials as others on this object (a door's groove walls and inner panel as its trim)."""
    me = obj.data
    names = [m.name for m in me.materials]
    for p in me.polygons:
        n = names[p.material_index]
        if n in mapping:
            p.material_index = names.index(mapping[n])


for o in doors.values():
    remap_mats(o, {"Gap": "Trim", "Interior": "Trim", "Metal": "Trim"})

# ---- The far copy: the shell's own sections at 30 rings of 20 points, the cowling as a block, the tail as a
# flat outline with a dark disc, skids as bars; paint, the sweep, dark glass and trim.
FB = new_builder("Far")
far_z = [Z_NOSE + 0.004 + (Z_END - Z_NOSE - 0.004) * (1 - math.cos(math.pi * i / 29)) / 2 for i in range(30)]
fr = []
for z in far_z:
    half = half_section(z, 11)
    full = half + [(-x, y) for x, y in reversed(half[1:-1])]
    fr.append([FB.v((x, y, z)) for x, y in full])


def far_mat(i, j):
    zz = (far_z[i] + far_z[i + 1]) / 2
    half = half_section(zz, 11)
    jj = j if j < 10 else 20 - j - 1
    jj = min(max(jj, 0), 9)
    y = (half[jj][1] + half[jj + 1][1]) / 2
    x = (half[jj][0] + half[jj + 1][0]) / 2
    if inside((zz, y), WS_OUT) or (inside((zz, y), CH_OUT)) or (x > 0.3 and any(inside((zz, y), o) for o, _ in SIDE_WINDOWS)):
        return "Glass"
    return "PaintB" if paint_zone(zz, y) != "Paint" else "Paint"


FB.grid(fr, far_mat, closed=True, hint_of=ring_hint)
ftip = FB.v((0.0, Y_TIP, Z_NOSE))
nfr = len(fr[0])
for k in range(nfr):
    FB.face((fr[0][k], fr[0][(k + 1) % nfr], ftip), "Paint", Vector((0, 0, -1)))
fe = FB.v((0.0, (yb_e + yt_e) / 2, Z_END))
for k in range(nfr):
    FB.face((fr[-1][k], fr[-1][(k + 1) % nfr], fe), "Paint", Vector((0, 0, 1)))
# Cowling.
dzf = across(DH_Z0 + 0.1, DH_Z1 - 0.02, 6)
dfr = []
for z in dzf:
    half = dh_section(z)
    sel = [half[i] for i in (0, 4, 9, 12, 15)]
    full = sel + [(-x, y) for x, y in reversed(sel[:-1])]
    dfr.append([FB.v((x, y, z)) for x, y in full])
FB.grid(dfr, lambda i, j: "PaintB" if paint_zone((dzf[i] + dzf[i + 1]) / 2, DH_TOP) != "Paint" else "Paint", closed=False,
        hint_of=lambda i, j, c: c - Vector((0, 2.2, c.z)))
FB.face(dfr[0], "Paint", Vector((0, 0, -1)))
FB.face(dfr[-1], "Paint", Vector((0, 0, 1)))
# Tail: the outline as a slab (two sides and an edge), the duct as a dark disc on each side.
ang_f = [t_angles[i] for i in range(0, N_TAIL, 3)]
nfa = len(ang_f)
for s in (-1, 1):
    vo = [FB.v((s * half_thick(th, outline_r(th) - 0.15) * 0.8, TCY + outline_r(th) * math.sin(th), TCZ + outline_r(th) * math.cos(th))) for th in ang_f]
    vi = [FB.v((s * 0.2, TCY + 0.55 * math.sin(th), TCZ + 0.55 * math.cos(th))) for th in ang_f]
    for k in range(nfa):
        q = (vo[k], vo[(k + 1) % nfa], vi[(k + 1) % nfa], vi[k])
        FB.face(q, "Paint", Vector((s, 0, 0)))
    FB.face(vi, "Trim", Vector((s, 0, 0)))
# Skids and cross tubes as square bars; the stabiliser as a plate.
for s in (-1, 1):
    sp = skid_path()
    tube(FB, [Vector((s * SKID_X, y, z)) for z, y in sp[::3] + [sp[-1]]], 0.04, 4, "Trim")
for cz in CROSS_Z:
    rbox(FB, "Trim", (2 * SKID_X, 0.06, 0.06), 0.0, place(0, 0.56, cz), segs=1)
    for s in (-1, 1):
        rbox(FB, "Trim", (0.06, 0.50, 0.06), 0.0, place(s * (SKID_X - 0.02), 0.30, cz), segs=1)
rbox(FB, "Paint", (2.62, 0.06, 0.48), 0.0, place(0, STAB_Y, 4.31), segs=1)
far = FB.obj(smooth_angle=60)

# ---- Shade.
cp.bake_ao([body], blockers=[rotor_hub, *doors.values(), detail])
for o in doors.values():
    cp.bake_ao([o], blockers=[body])
cp.bake_ao([detail], blockers=[body])
cp.bake_ao([rotor_hub], ground=False)
blade_tmp = bpy.data.objects["Blade_1"]
cp.bake_ao([blade_tmp], ground=False)
cp.bake_ao([tail_rotor], blockers=[body], ground=False)
cp.bake_ao([stick_c, stick_l], blockers=[body])
cp.bake_ao([far])


def liner_shade(obj):
    """The cabin's lining and the panes' reveals are a coarse skin: their baked shade came out in blotches, so they
    get an even one instead, a little darker low down."""
    me = obj.data
    attr = me.color_attributes["AO"]
    names = [m.name for m in me.materials]
    M = obj.matrix_world
    done = set()
    for p in me.polygons:
        if names[p.material_index] not in ("Interior", "Trim"):
            continue
        c = M @ p.center
        loc, _, _, dist = REF_TREE.find_nearest(c, 0.05)
        if loc is None or not 0.006 < dist < 0.045:
            continue
        for vi in p.vertices:
            if vi in done:
                continue
            y = hp.ungame(M @ me.vertices[vi].co).y
            v = 0.55 + 0.3 * clamp01((y - 0.9) / 1.2)
            attr.data[vi].color = (v, v, v, 1.0)
            done.add(vi)


for o in (body, *doors.values()):
    liner_shade(o)
for o in (rotor_disc, tail_disc):
    attr = o.data.color_attributes.new("AO", "BYTE_COLOR", "POINT")
    for i in range(len(o.data.vertices)):
        attr.data[i].color = (1, 1, 1, 1)
# The screens' pictures: their corners' colours replace the shade.
pic = {}
for pts, col in SCREEN_PICS:
    for p in pts:
        pic[tuple(round(v, 4) for v in G(p))] = col
attr = body.data.color_attributes["AO"]
scr_i = [i for i, m in enumerate(body.data.materials) if m.name == "Screen"][0]
scr_verts = {v for p in body.data.polygons if p.material_index == scr_i for v in p.vertices}
hit = 0
for vi in scr_verts:
    key = tuple(round(v, 4) for v in body.data.vertices[vi].co)
    if key in pic:
        c = pic[key]
        attr.data[vi].color = (*c, 1.0)
        hit += 1
print(f"helicopter: screen corners coloured {hit} of {len(scr_verts)}")

# ---- The shut lines as lines.
lbm = bmesh.new()
for path in GAP_LINES:
    vs = [lbm.verts.new(G(p)) for p in path]
    for a, b in zip(vs, vs[1:]):
        lbm.edges.new((a, b))
lme = bpy.data.meshes.new("GapLines")
lbm.to_mesh(lme)
lbm.free()
gap_lines = hp.link(bpy.data.objects.new("GapLines", lme))

# ---- Empties: seats (facing their -z), grips, pedals, the pilot's eye, where one stands to board.
empties = []


def empty(name, p, aft=False, parent=None):
    e = hp.link(bpy.data.objects.new(name, None))
    e.empty_display_size = 0.1
    T_ = Matrix.Translation(p) @ (Matrix.Rotation(math.pi, 4, "Y") if aft else Matrix.Identity(4))
    if parent is not None:
        e.parent = parent
        e.matrix_parent_inverse = Matrix.Identity(4)
        e.matrix_basis = gmat(Matrix.Translation(p - parent_game[parent.name]))
    else:
        e.matrix_world = gmat(T_)
    empties.append(e)
    return e


parent_game = {"Stick_Cyclic": CYC_PIVOT, "Stick_Collective": COL_PIVOT}
for name, x, zh, aft in SEATS:
    empty(name, Vector((x, SEAT_Y, zh)), aft)
empty("Grip_Cyclic", CYC_GRIP, parent=stick_c)
empty("Grip_Collective", COL_GRIP, parent=stick_l)
empty("Pedal_L", PEDALS[0.25])
empty("Pedal_R", PEDALS[0.49])
empty("Eye_Pilot", Vector((0.37, SEAT_Y + 0.76, -1.28 - 0.02)))   # a seated eye: 0.76 m over the hip
empty("Step_L", Vector((-1.30, 0.0, -0.40)))
empty("Step_R", Vector((1.30, 0.0, -0.40)))
bpy.context.view_layer.update()

# ---- Checks (the run fails on one).
errors = []


def game_bounds(objs):
    lo, hi = Vector((1e9,) * 3), Vector((-1e9,) * 3)
    for o in objs:
        M = o.matrix_world
        for v in o.data.vertices:
            p = hp.ungame(M @ v.co)
            lo = Vector(map(min, lo, p))
            hi = Vector(map(max, hi, p))
    return lo, hi


lo, hi = game_bounds([body, *doors.values()])
skid_low = min(hp.ungame(body.matrix_world @ v.co).y for v in body.data.vertices)
if abs(skid_low) > 0.002:
    errors.append(f"lowest point at y {skid_low:.4f}, not 0")
if abs(lo.z - Z_NOSE) > 0.03:
    errors.append(f"nose at z {lo.z:.3f}")
if abs(hi.z - Z_TAIL) > 0.03:
    errors.append(f"tail end at z {hi.z:.3f}")
for name in ("Body", "Detail", "Rotor", "Blade_1", "Blade_2", "Blade_3", "Blade_4", "RotorDisc", "TailRotor", "TailDisc", "Door_FL", "Door_FR",
             "Door_RL", "Door_RR", "Stick_Cyclic", "Stick_Collective", "Far", "GapLines", "Seat_0", "Seat_1", "Seat_2", "Seat_3", "Seat_4",
             "Seat_5", "Grip_Cyclic", "Grip_Collective", "Pedal_L", "Pedal_R", "Eye_Pilot", "Step_L", "Step_R"):
    if name not in bpy.data.objects:
        errors.append(f"missing node {name}")
piv = [hp.ungame(b.matrix_world.translation) for b in blades]
hubw = hp.ungame(rotor_hub.matrix_world.translation)
if max(abs((p - hubw).length - BLADE_ROOT) for p in piv) > 1e-4:
    errors.append("blade pivots not on a circle")
dr = max((hp.ungame(rotor_disc.matrix_world @ v.co) - hubw).length for v in rotor_disc.data.vertices)
if abs(dr - ROTOR_R) > 0.01:
    errors.append(f"disc radius {dr:.3f}")
# Room over each seat: up from the hip to the liner or the roof.
body_tree = hp.Caster(body)
for name, x, zh, aft in SEATS:
    h = body_tree.cast((x, SEAT_Y + 0.05, zh), (0, 1, 0))
    free = (h[0].y - SEAT_Y) if h else 9
    print(f"helicopter: {name} free above the hip {free:.3f} m")
    if free < 0.88:
        errors.append(f"{name}: only {free:.3f} m over the hip")


# Sizes as built, against the published ones (heli.md section 2) and the interface (section 5).
def ys_at(objs, test):
    out = []
    for o in objs:
        M = o.matrix_world
        out += [hp.ungame(M @ v.co) for v in o.data.vertices if test(hp.ungame(M @ v.co))]
    return out


skid_pts = ys_at([body], lambda p: p.y < 0.006 and abs(abs(p.x) - SKID_X) < 0.06)
disc_front = min(hp.ungame(rotor_disc.matrix_world @ v.co).z for v in rotor_disc.data.vertices)
cap_top = max(p.y for p in ys_at([rotor_hub], lambda p: True))
fin_top = max(p.y for p in ys_at([body], lambda p: p.z > 5.9 and abs(p.x) < 0.25 and p.y < 3.52))
SIZES = {
    "length_rotor_turning": round(hi.z - disc_front, 3),
    "fuselage_length": round(hi.z - lo.z, 3),
    "height_rotor_head": round(cap_top, 3),
    "height_fin": round(fin_top, 3),
    "rotor_diameter": round(2 * dr, 3),
    "blades": len(blades),
    "blade_chord": CHORD,
    "tail_rotor_diameter": round(2 * max(math.hypot(v.co.y, v.co.z) for v in tail_rotor.data.vertices), 3),
    "tail_rotor_blades": len(TR_ANG),
    "fuselage_width": round(2 * max(W(z) for z in us), 3),
    "skid_track": round(2 * SKID_X, 3),
    "skid_contact_z": [round(min(p.z for p in skid_pts), 3), round(max(p.z for p in skid_pts), 3)],
    "skid_outer_x": round(max(abs(p.x) for p in ys_at([body], lambda p: p.y < 0.3)), 3),
    "cabin_width_max": round(2 * max(W(z) for z in us), 3),
}
print("helicopter: sizes " + json.dumps(SIZES))
if abs(fin_top - 3.51) > 0.03 or abs(cap_top - 3.35) > 0.03 or abs(SIZES["length_rotor_turning"] - 12.26) > 0.05:
    errors.append("a published height or length is off by more than 3 cm")

def count_lines(obj):
    return sum(1 for e in obj.data.edges if e.is_loose)


tri_body = cp.triangles([body])
tri_near = tri_body + cp.triangles([detail, rotor_hub, tail_rotor, stick_c, stick_l, *doors.values()]) + 4 * cp.triangles([blades[0]]) + \
    cp.triangles([rotor_disc, tail_disc])
tri_far = cp.triangles([far])


def prims(o):
    """Draw calls an object makes: one per material its faces use, one more for loose edges (lines)."""
    return len(used_mats(o)) + (1 if count_lines(o) else 0)


# Draw calls, every primitive counted: at rest (blades, tail rotor; no discs) and in flight (discs instead of
# blades and tail rotor); the far copy is drawn instead of all of them past 90 m.
fixed = sum(prims(o) for o in (body, detail, rotor_hub, stick_c, stick_l, gap_lines, *doors.values()))
draws_rest = fixed + sum(prims(b) for b in blades) + prims(tail_rotor)
draws_flight = fixed + prims(rotor_disc) + prims(tail_disc)
draws_file = draws_rest + prims(rotor_disc) + prims(tail_disc) + prims(far)
for o in (body, detail, rotor_hub, blades[0], tail_rotor, stick_c, stick_l, *doors.values(), far):
    print(f"helicopter: {o.name} draws {', '.join(used_mats(o))}")
print(f"helicopter: {tri_near} triangles near (body {tri_body}, detail {cp.triangles([detail])}, rotor hub {cp.triangles([rotor_hub])}, "
      f"blade {cp.triangles([blades[0]])} each, tail rotor {cp.triangles([tail_rotor])}, doors {cp.triangles(list(doors.values()))}, "
      f"discs {cp.triangles([rotor_disc, tail_disc])}); far {tri_far}; draw calls at rest {draws_rest}, in flight {draws_flight}, "
      f"primitives in the file {draws_file}")
print(f"helicopter: bounds x {lo.x:.3f}..{hi.x:.3f}, y {lo.y:.3f}..{hi.y:.3f}, z {lo.z:.3f}..{hi.z:.3f}")
if tri_near > 65000:
    errors.append(f"{tri_near} triangles near, over the 65,000 budget")
if tri_far > 5000:
    errors.append(f"far copy {tri_far} triangles, over 5,000")
for o in (body, detail, rotor_hub, tail_rotor, stick_c, stick_l, far, *doors.values()):
    if count_lines(o):
        errors.append(f"{o.name} has {count_lines(o)} loose edges")


# ---- Export: to a file beside the output first; it replaces the output only when every check has passed.
def export(objs, out):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                              export_texcoords=False, export_cameras=False, export_lights=False,
                              export_vertex_color="ACTIVE", export_all_vertex_colors=False, use_mesh_edges=True)


def fail(msgs):
    for e in msgs:
        print("helicopter: CHECK FAILED " + e)
    sys.exit(1)


if errors:
    fail(errors)
export_objs = [body, detail, rotor_hub, *blades, rotor_disc, tail_rotor, tail_disc, *doors.values(), stick_c, stick_l, far, gap_lines, *empties]
TMP = os.path.abspath(OUT) + ".part.glb"
export(export_objs, TMP)
size = os.path.getsize(TMP)
print(f"helicopter: {size} bytes")
if size > 1_900_000:
    os.remove(TMP)
    fail([f"{size} bytes, over the 1,900,000 budget"])
os.replace(TMP, OUT)

if "manifest" in opts:
    man = {"nodes": {}, "triangles": {}, "anchors": {}}
    for o in export_objs:
        M = o.matrix_world
        p = hp.ungame(M.translation)
        q = (hp.MG.inverted() @ M @ hp.MG).to_euler()
        man["nodes"][o.name] = {"position": [round(v, 4) for v in p], "rotation_deg": [round(math.degrees(a), 3) for a in q],
                                "parent": o.parent.name if o.parent else None}
        if o.type == "MESH" and o.data.polygons:
            man["triangles"][o.name] = cp.triangles([o])
    man["bounds"] = {"min": [round(v, 4) for v in lo], "max": [round(v, 4) for v in hi]}
    man["sizes"] = SIZES
    man["draw_calls"] = {"at_rest": draws_rest, "in_flight": draws_flight, "primitives_in_file": draws_file}
    man["materials"] = {o.name: used_mats(o) for o in export_objs if o.type == "MESH" and o.data.polygons}
    man["near_triangles"] = tri_near
    man["far_triangles"] = tri_far
    man["bytes"] = size
    os.makedirs(os.path.dirname(os.path.abspath(opts["manifest"])), exist_ok=True)
    with open(opts["manifest"], "w", newline="\n") as fh:
        json.dump(man, fh, indent=1)
        fh.write("\n")

# ---- Review renders.
if PREVIEW:
    far.hide_render = True
    gap_lines.hide_render = True
    hp.shade_materials({"Glass", "RotorBlur", "Screen", "LightRed", "LightGreen", "LightWhite", "LightBeacon", "LightLanding", "Ground"})
    scn = bpy.context.scene
    bpy.ops.mesh.primitive_plane_add(size=400)
    ground = bpy.context.active_object
    gm = bpy.data.materials.new("Ground")
    gm.use_nodes = True
    gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.16, 0.16, 0.155, 1)
    ground.data.materials.append(gm)
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(48), 0, math.radians(35)))
    sun = bpy.context.active_object
    sun.data.angle = math.radians(2)
    grey = hp.material("PreviewGrey", (0.75, 0.75, 0.77), 0.02, 1.0)   # a mirror: every ripple shows in it
    for m in list(MAT.values()) + [grey]:
        if m.name != "RotorBlur":
            m.use_backface_culling = True   # as the game draws them (one side)
    scr = MAT["Screen"].node_tree
    sat = scr.nodes.new("ShaderNodeAttribute")
    sat.attribute_name = "AO"
    scr.links.new(sat.outputs["Color"], scr.nodes["Principled BSDF"].inputs["Emission Color"])
    paint_orig = {}

    def setup(mood):
        sky = "stripes" if mood.startswith("stripes") else mood
        hp.world_sky(scn, "day" if sky in ("day", "flight") else sky)
        sun.data.energy = {"night": 0.0, "dusk": 1.2}.get(sky, 4.0)
        sun.rotation_euler = (math.radians(78 if sky == "dusk" else 48), 0, math.radians(35))
        ground.hide_render = sky in ("stripes", "under")
        if sky == "under":
            hp.world_sky(scn, "day")
        # In flight: lifted 6 m, the nose 8 degrees down, banked 12 degrees to the right.
        flight = mood == "flight"
        pose_m = gmat(Matrix.Translation((0, 6, 0)) @ Matrix.Rotation(math.radians(-12), 4, "Z") @ Matrix.Rotation(math.radians(-8), 4, "X")) \
            if flight else Matrix.Identity(4)
        for o in machine:
            o.matrix_world = pose_m @ rest[o.name]
        for o in (body, *doors.values()):
            for i, m in enumerate(o.data.materials):
                if m.name.startswith("Paint") or m.name == "PreviewGrey":
                    key = (o.name, i)
                    paint_orig.setdefault(key, m)
                    o.data.materials[i] = grey if mood.startswith("stripes") else paint_orig[key]
        for b in blades:
            b.hide_render = flight
        rotor_disc.hide_render = not flight
        tail_disc.hide_render = not flight
        tail_rotor.hide_render = flight

    machine = [o for o in export_objs if o.parent is None]
    rest = {o.name: o.matrix_world.copy() for o in machine}

    V = [
        ("stripes_side", (14, 1.6, 1.9), (0, 1.5, 1.9), 35, "stripes"),
        ("stripes_front34", (-7.5, 2.4, -8.5), (0, 1.4, -0.8), 40, "stripes"),
        ("stripes_top", (3.0, 14.0, 1.0), (0, 1.5, 1.0), 35, "stripes"),
        ("front", (0, 1.65, -12), (0, 1.5, 1.9), 50, "day"), ("front34_l", (-8.5, 1.65, -8.5 + 1.9), (0, 1.5, 1.9), 50, "day"),
        ("side_l", (-12, 1.65, 1.9), (0, 1.5, 1.9), 50, "day"), ("rear34_l", (-8.5, 1.65, 10.4), (0, 1.5, 1.9), 50, "day"),
        ("rear", (0, 1.65, 13.9), (0, 1.5, 1.9), 50, "day"), ("rear34_r", (8.5, 1.65, 10.4), (0, 1.5, 1.9), 50, "day"),
        ("side_r", (12, 1.65, 1.9), (0, 1.5, 1.9), 50, "day"), ("front34_r", (8.5, 1.65, -6.6), (0, 1.5, 1.9), 50, "day"),
        ("top", (0, 30, 1.0), (0, 0, 1.0001), -12.0, "day"), ("below", (0, -10, 1.0), (0, 1, 1.0001), -12.0, "under"),
        ("side_ortho", (-30, 1.8, 1.95), (0, 1.8, 1.95), -11.2, "day"), ("front_ortho", (0, 1.8, -30), (0, 1.8, 0), -6.3, "day"),
        ("cockpit_door", (1.9, 1.55, -1.45), (0.2, 1.2, -1.7), 24, "day"), ("cockpit_eye", (0.37, 1.86, -1.30), (0.2, 1.3, -3.0), 20, "day"),
        ("cabin", (-2.2, 1.9, -0.2), (0.2, 1.1, -0.4), 24, "day"),
        ("pillar", (0.30, 1.86, -1.30), (0.75, 1.6, -2.1), 28, "day"),
        ("head_close", (1.6, 3.6, -1.4), (0, 3.15, 0), 40, "day"), ("shroud_close", (-2.6, 1.9, 6.5), (0, 1.9, 6.0), 40, "day"),
        ("skids_close", (2.6, 0.6, -3.4), (0.8, 0.3, -1.4), 35, "day"), ("nose_close", (1.6, 1.4, -5.2), (0, 1.25, -2.7), 40, "day"),
        ("exhaust_close", (2.4, 3.0, 2.9), (0.5, 2.2, 1.4), 40, "day"),
        ("flight_chase", (0, 12.0, 14.0), (0, 8.0, 0), 31, "flight"), ("flight_below", (-5, 0.6, -9), (0, 7.5, 0.5), 30, "flight"),
        ("far_90", (60, 3, -60), (0, 1.5, 1.5), 140, "day"),
        ("night", (6.5, 1.65, -7.5), (0, 1.4, 0.8), 40, "night"),
    ]
    if VIEWS:
        want = VIEWS.split(",")
        V = [v for v in V if v[0] in want]
    if "beauty" not in opts:
        hp.render_views(PREVIEW, V, setup)
    else:
        # One picture for Yoshi: Cycles, a low three-quarter front view on a plain pad in evening light, the cabin
        # lit from inside. The renderer's own light and shadow do what the baked shade does in the game, so the
        # paint doesn't take the baked shade here.
        for m in bpy.data.materials:
            nt = m.node_tree if m.use_nodes else None
            p = nt.nodes.get("Principled BSDF") if nt else None
            if p and p.inputs["Base Color"].is_linked and m.name != "Screen":
                mix = p.inputs["Base Color"].links[0].from_node
                if mix.bl_idname == "ShaderNodeMix":
                    p.inputs["Base Color"].default_value = mix.inputs[6].default_value
                    nt.links.remove(p.inputs["Base Color"].links[0])
        scn.render.engine = "CYCLES"
        scn.cycles.device = "CPU"
        scn.cycles.samples = 128
        scn.cycles.use_denoising = True
        scn.render.resolution_x, scn.render.resolution_y = 1920, 1080
        scn.render.image_settings.file_format = "PNG"
        world = hp.world_sky(scn, "dusk")
        world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.6
        sun.data.energy = 3.5
        sun.data.color = (1.0, 0.64, 0.40)
        sun.data.angle = math.radians(1.0)
        sun.rotation_euler = (math.radians(80), 0, math.radians(-135))
        gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.11, 0.11, 0.105, 1)
        gm.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.7
        # The pad: a plain, lighter concrete disc 12 m across, 2 cm high.
        bpy.ops.mesh.primitive_cylinder_add(vertices=96, radius=6.0, depth=0.02, location=(0, -0.6, -0.009))
        pad = bpy.context.active_object
        pm = hp.material("Pad", (0.32, 0.31, 0.29), 0.8)
        pad.data.materials.append(pm)
        # The cabin lit: a warm soft light under the roof, the screens a little brighter.
        bpy.ops.object.light_add(type="AREA", location=G((0.0, 2.05, -0.6)))
        lamp = bpy.context.active_object
        lamp.data.energy = 60
        lamp.data.size = 1.2
        lamp.data.color = (1.0, 0.86, 0.68)
        MAT["Screen"].node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 3.0
        for o in (rotor_disc, tail_disc, far, gap_lines):
            o.hide_render = True
        cam_at, cam_look = G((-6.6, 1.05, -7.4)), G((0.0, 1.75, 0.3))
        bpy.ops.object.camera_add(location=cam_at)
        cam = bpy.context.active_object
        cam.data.lens = 35
        cam.rotation_euler = (cam_look - cam_at).to_track_quat("-Z", "Y").to_euler()
        scn.camera = cam
        os.makedirs(PREVIEW, exist_ok=True)
        scn.render.filepath = os.path.join(PREVIEW, f"beauty_{LIVERY}.png")
        bpy.ops.render.render(write_still=True)
        print("helicopter: beauty render written to " + scn.render.filepath)
