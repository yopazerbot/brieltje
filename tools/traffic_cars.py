"""The village's everyday cars in Blender: a compact hatchback, an estate and a panel van, for the traffic on
the roads and the cars parked on drives (web/src/world/traffic.ts).

Run (Blender 5, no window):
  blender -b -P tools/traffic_cars.py -- <out.glb> [preview_dir]

Generic shapes, no make or model: the sizes are the usual ones of their class (a compact hatchback
4.25 x 1.79 x 1.46 m on a 2.63 m wheelbase, a family estate 4.69 x 1.83 x 1.47 m on 2.69 m, a mid-roof
panel van 5.53 x 2.03 x 2.50 m on 3.30 m). No logos, badges or lettering; the number plates are blank.

Each body is lofted from cross-sections along its length, as in tools/model_3.py but with far fewer of them:
the side profile (nose, hood, windscreen, roof, rear glass or doors, tail), the plan and the window line give
each section, and each band of a section has its part: the sill, the doors, the black seal under the
windows, the side glass, the roof rail, the roof or the windscreen. The wheel arches are cut out. Laid on the
surface (rays cast at the body): the headlights (a dark housing round a bright reflector), the tail lights
wrapping round the corners, a third brake light, the grille and the intake, the plates, the door seams and
handles, the wipers, the estate's roof rails and the van's rubbing strip; the mirrors are small pods. Behind
the glass a dark cabin: its lining, the seats, the dashboard and the steering wheel, so a window shows a
hint of the inside. The shade the car casts on itself and the ground under it is baked into a colour per
corner (tools/car_parts.py: bake_ao), which the game multiplies in.

Output: one GLB with the three bodies ("hatch", "estate", "van"), a simpler copy of each for seeing them from
afar ("hatch_far" ...: the body at fewer sections, the lamps and plates as small patches, four plain wheels,
no cabin), and one wheel ("wheel", radius 0.32 m, its axle along x through its origin, its face towards +x:
a tyre with rounded shoulders and a five-spoke rim), which the game places, scales and turns itself. Each
body's extras give its axles (y, m from the middle; the nose is at +y in Blender, -z in the game), track and
wheel radius, length, width and height. Materials: Paint (white: the game tints it per car), Glass, Trim,
Lamp, LampDark, Tail, Reverse, Plate, PlateBand, Tyre, Rim, RimDark, Interior, Chrome. With preview_dir it
also renders a few small views there.
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


clamp01 = cp.clamp01
smooth = cp.smooth

# Each kind, measured from the front bumper (u, m): the top of the side profile, the underside, half the
# width, half the width of the roof or hood top, the bottom edge of the side windows, where the windscreen
# and the rear glass are, where the side glass starts and ends, the pillars between (painted, or black for
# the B-pillar), the axles, the wheel and the track; the door seams, the door handles, the lamps' heights.
KINDS = {
    "hatch": dict(
        L=4.25,
        top=[(0, 0.50), (0.03, 0.60), (0.08, 0.68), (0.2, 0.75), (0.5, 0.83), (0.85, 0.89), (1.12, 0.925), (1.4, 1.10),
             (1.7, 1.30), (1.95, 1.415), (2.3, 1.46), (3.0, 1.46), (3.5, 1.435), (3.8, 1.40), (3.86, 1.37), (4.0, 1.20),
             (4.12, 1.04), (4.18, 0.97), (4.22, 0.86), (4.25, 0.55)],
        bottom=[(0, 0.32), (0.15, 0.24), (0.45, 0.19), (3.8, 0.19), (4.1, 0.24), (4.25, 0.34)],
        width=[(0, 0.56), (0.05, 0.72), (0.15, 0.82), (0.35, 0.875), (0.6, 0.895), (3.6, 0.895), (3.9, 0.88), (4.1, 0.84),
               (4.25, 0.70)],
        roof=[(0, 0.40), (0.3, 0.62), (1.12, 0.70), (1.95, 0.64), (3.6, 0.63), (4.25, 0.56)],
        belt=[(1.12, 0.925), (1.6, 0.95), (3.2, 0.99), (3.75, 1.04), (4.18, 0.97)],
        screen=(1.12, 1.95), rear=(3.86, 4.18), glass=(1.32, 3.52), pillars=[(2.52, 2.62, "Trim")],
        axles=(0.88, 3.51), wheel=0.315, track=1.54, lamps=0.63, tails=0.98, tail_h=0.12,
        seams=[1.31, 2.56, 3.33], handles=[2.32, 3.20], seats=(2.30, 3.30), dash=1.42, cabin_end=3.95,
    ),
    "estate": dict(
        L=4.69,
        top=[(0, 0.52), (0.04, 0.63), (0.1, 0.70), (0.3, 0.775), (0.6, 0.84), (1.0, 0.905), (1.2, 0.935), (1.5, 1.12),
             (1.8, 1.32), (2.05, 1.43), (2.4, 1.47), (3.8, 1.465), (4.35, 1.44), (4.5, 1.415), (4.56, 1.36), (4.63, 1.15),
             (4.665, 1.0), (4.68, 0.92), (4.69, 0.60)],
        bottom=[(0, 0.33), (0.15, 0.24), (0.45, 0.19), (4.2, 0.19), (4.5, 0.25), (4.69, 0.36)],
        width=[(0, 0.57), (0.05, 0.74), (0.15, 0.84), (0.35, 0.895), (0.6, 0.915), (4.1, 0.915), (4.4, 0.90), (4.6, 0.86),
               (4.69, 0.74)],
        roof=[(0, 0.42), (0.3, 0.64), (1.2, 0.72), (2.05, 0.66), (4.3, 0.64), (4.69, 0.60)],
        belt=[(1.2, 0.935), (1.7, 0.955), (3.4, 0.985), (4.3, 1.0), (4.6, 1.0)],
        screen=(1.2, 2.05), rear=(4.56, 4.665), glass=(1.4, 4.42), pillars=[(2.58, 2.68, "Trim"), (3.56, 3.66, "Paint")],
        axles=(0.92, 3.61), wheel=0.32, track=1.56, lamps=0.66, tails=1.02, tail_h=0.13,
        seams=[1.36, 2.62, 3.40], handles=[2.38, 3.27], seats=(2.38, 3.40), dash=1.50, cabin_end=4.50,
    ),
    "van": dict(
        L=5.53,
        top=[(0, 0.56), (0.05, 0.74), (0.2, 0.92), (0.45, 1.03), (0.72, 1.10), (1.0, 1.42), (1.3, 1.80), (1.55, 2.12),
             (1.8, 2.36), (2.1, 2.47), (2.5, 2.50), (5.35, 2.50), (5.48, 2.47), (5.53, 2.40)],
        bottom=[(0, 0.40), (0.2, 0.32), (0.6, 0.29), (5.2, 0.31), (5.45, 0.36), (5.53, 0.42)],
        width=[(0, 0.80), (0.06, 0.92), (0.25, 0.98), (0.6, 1.0), (5.4, 1.0), (5.53, 0.985)],
        roof=[(0, 0.70), (0.72, 0.88), (1.8, 0.93), (5.53, 0.95)],
        belt=[(0.72, 1.10), (1.2, 1.16), (2.25, 1.20)],
        screen=(0.72, 1.62), rear=(9, 9), glass=(1.08, 2.18), pillars=[],
        axles=(0.95, 4.25), wheel=0.35, track=1.72, lamps=0.95, tails=0.95, tail_h=0.55,
        seams=[1.40, 2.22, 2.30, 3.52], handles=[2.06, 2.46], seats=(1.95, None), dash=1.05, cabin_end=2.26,
    ),
}


def srgb(hexcode):
    c = [int(hexcode[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def material(name, color, rough=0.5, metal=0.0, coat=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    if coat:
        p.inputs["Coat Weight"].default_value = coat
        p.inputs["Coat Roughness"].default_value = 0.03
    return m


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


bpy.ops.wm.read_factory_settings(use_empty=True)
# The game reads each part's colour, roughness and metalness from these (world/traffic.ts).
MAT = {
    "Paint": material("Paint", (0.8, 0.8, 0.8), 0.3, 0.3, coat=1.0),
    "Glass": material("Glass", (0.008, 0.009, 0.011), 0.03),
    "Trim": material("Trim", srgb("1c1d1f"), 0.6),
    "Lamp": material("Lamp", srgb("9a9ea6"), 0.15, 0.7),
    "LampDark": material("LampDark", srgb("17181b"), 0.2, 0.3),
    "Tail": material("Tail", srgb("8a1414"), 0.22),
    "Reverse": material("Reverse", srgb("d8d9dc"), 0.15, 0.2),
    "Plate": material("Plate", srgb("e6e6e0"), 0.45),
    "PlateBand": material("PlateBand", srgb("1f3d8f"), 0.45),
    "Tyre": material("Tyre", srgb("1a1a1a"), 0.88),
    "Rim": material("Rim", srgb("b4b7bc"), 0.3, 0.85),
    "RimDark": material("RimDark", srgb("2a2b2e"), 0.45, 0.4),
    "Interior": material("Interior", srgb("26272a"), 0.8),
    "Chrome": material("Chrome", srgb("d0d2d6"), 0.06, 1.0),
}
ORDER = list(MAT)
MAT["Glass"].node_tree.nodes["Principled BSDF"].inputs["Alpha"].default_value = 0.82
if hasattr(MAT["Glass"], "surface_render_method"):
    MAT["Glass"].surface_render_method = "DITHERED"


class Builder:
    """A mesh made of many small parts, each face with its material."""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()

    def v(self, co):
        return self.bm.verts.new(co)

    def face(self, vs, mat, hint=None):
        f = self.bm.faces.new(vs)
        f.material_index = ORDER.index(mat)
        if hint is not None:
            f.normal_update()
            if f.normal.dot(hint) < 0:
                f.normal_flip()
        return f

    def merge(self, other, mat):
        vmap = {v: self.v(v.co) for v in other.verts}
        for f in other.faces:
            self.face([vmap[v] for v in f.verts], mat)

    def obj(self):
        me = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(me)
        self.bm.free()
        for m in MAT.values():
            me.materials.append(m)
        for p in me.polygons:
            p.use_smooth = True
        return link(bpy.data.objects.new(self.name, me))


def across(a, b, n):
    return [a + (b - a) * i / n for i in range(n + 1)]


def panel(B, ray, a_vals, b_fn, mat, out=0.006, skirt=True, longest=0.25):
    """A raised patch on the body: a grid of ray hits, ray(a, b) for each a and each b in b_fn(a), lifted by
    `out`, with a bevelled edge sloping back down into the surface (a wall facing the sky would glint)."""
    grid = [[ray(a, b) for b in b_fn(a)] for a in a_vals]
    V = [[(B.v(h[0] + h[1] * out), h) if h else None for h in row] for row in grid]
    na, nb = len(V), len(V[0])
    centre, count = Vector(), 0
    for i in range(na - 1):
        for j in range(nb - 1):
            q = (V[i][j], V[i + 1][j], V[i + 1][j + 1], V[i][j + 1])
            if all(q) and max((q[k][0].co - q[(k + 1) % 4][0].co).length for k in range(4)) < longest:
                B.face([c[0] for c in q], mat, sum((c[1][1] for c in q), Vector()))
                centre += q[0][0].co
                count += 1
    if not skirt or not count:
        return
    centre /= count
    loop = [(0, j) for j in range(nb)] + [(i, nb - 1) for i in range(1, na)] + \
           [(na - 1, j) for j in range(nb - 2, -1, -1)] + [(i, 0) for i in range(na - 2, 0, -1)]
    edges = [(k0, k1) for k0, k1 in zip(loop, loop[1:] + loop[:1]) if V[k0[0]][k0[1]] and V[k1[0]][k1[1]]]
    away = {}
    for k0, k1 in edges:
        c0, c1 = V[k0[0]][k0[1]], V[k1[0]][k1[1]]
        o = c0[1][1].cross(c1[0].co - c0[0].co)
        if o.dot((c0[0].co + c1[0].co) / 2 - centre) < 0:
            o = -o
        if o.length > 1e-9:
            o.normalize()
        for k in (k0, k1):
            away[k] = away.get(k, Vector()) + o
    low = {}
    for k0, k1 in edges:
        c0, c1 = V[k0[0]][k0[1]], V[k1[0]][k1[1]]
        for key, c in ((k0, c0), (k1, c1)):
            if key not in low:
                p, nrm = c[1]
                o = away[key].normalized() if away[key].length > 1e-9 else Vector()
                low[key] = B.v(p - nrm * 0.002 + o * min(2.0 * out, 0.012))
        B.face((c0[0], c1[0], low[k1], low[k0]), mat, (c0[0].co + c1[0].co) / 2 - centre)


def ribbon(B, hits, width, mat, out=0.004):
    """A band of a given width along surface points (from ray casts), lying on the surface."""
    hits = [h for h in hits if h]
    if len(hits) < 2:
        return
    n = len(hits)
    rows = []
    for i, (p, nrm) in enumerate(hits):
        t = hits[min(n - 1, i + 1)][0] - hits[max(0, i - 1)][0]
        if t.length < 1e-7:
            continue
        s = nrm.cross(t).normalized()
        rows.append((B.v(p + s * width / 2 + nrm * out), B.v(p - s * width / 2 + nrm * out), nrm))
    for (a0, b0, n0), (a1, b1, n1) in zip(rows, rows[1:]):
        B.face((a0, a1, b1, b0), mat, n0 + n1)


def box(B, mat, size, matrix, taper=1.0):
    """A plain box of size (x, y, z), its top `taper` times as wide, placed by a 4x4 matrix."""
    vs = []
    for z in (-0.5, 0.5):
        k = taper if z > 0 else 1.0
        for x, y in ((-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5)):
            vs.append(B.v(matrix @ Vector((x * size[0] * k, y * size[1], z * size[2]))))
    c = matrix @ Vector()
    for q in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
        f = [vs[i] for i in q]
        B.face(f, mat, sum((v.co for v in f), Vector()) / 4 - c)


def pod(B, mat, at, length, ry, rz, out_dir, n=8, rings=((0.0, 0.35), (0.25, 0.9), (0.7, 1.0), (1.0, 0.75))):
    """A rounded pod (a mirror housing) from `at` outwards along x (out_dir: +1 or -1)."""
    rs = []
    for t, k in rings:
        c = at + Vector((out_dir * length * t, 0, 0))
        rs.append([B.v(c + Vector((0, ry * k * math.cos(2 * math.pi * i / n), rz * k * math.sin(2 * math.pi * i / n))))
                   for i in range(n)])
    centre = at + Vector((out_dir * length * 0.5, 0, 0))
    for a, b in zip(rs, rs[1:]):
        for i in range(n):
            f = (a[i], a[(i + 1) % n], b[(i + 1) % n], b[i])
            B.face(f, mat, sum((v.co for v in f), Vector()) / 4 - centre)
    B.face(rs[-1], mat, Vector((out_dir, 0, 0)))


def build(name, k):
    """The near body of one kind: shell, arches, parts on the surface and the cabin, joined."""
    L = k["L"]
    van = name == "van"
    TOP, BOTTOM, WIDTH, ROOF, BELT = (curve(k[n]) for n in ("top", "bottom", "width", "roof", "belt"))
    gh = (k["screen"][0], k["rear"][1] if k["rear"][0] < 9 else k["glass"][1] + 0.08)
    r_arch = k["wheel"] + (0.06 if van else 0.055)

    def belt(u):
        zt = TOP(u)
        return min(BELT(u), zt) if gh[0] <= u <= gh[1] else zt - 0.035

    def section(u):
        """Half a cross-section at u, from the bottom middle round to the top middle: 13 (x, z) points. The
        bands between them: 0, 1 underside and rocker; 2 sill; 3, 4 the doors; 5 the shoulder; 6 the seal
        under the glass; 7, 8 the side glass; 9 the roof rail; 10, 11 the roof, the windscreen or the rear glass."""
        zb, zt, w = BOTTOM(u), TOP(u), WIDTH(u)
        bl = belt(u)
        wr = min(ROOF(u), w - 0.05)
        sc = clamp01((w - 0.25) / 0.45)  # the small sections at the very ends scale their details down
        inset = (0.03 if van else 0.08) * sc
        lx = w - inset
        crown = (0.012 if van else 0.045) * min(1.0, (zt - bl) / 0.2 + 0.4)
        tx = min(lx - 0.005, wr + 0.03 * sc)
        tz = zt - crown * 0.8
        zw = zb + (0.45 if van else 0.55) * max(0.0, bl - zb)
        zsh = zw + 0.7 * (bl - zw)
        lean = (0.008 if van else 0.022) * sc
        pts = [(0.0, zb), (w - 0.07 * sc, zb), (w - 0.022 * sc, zb + 0.03 * sc), (w - 0.01 * sc, zb + 0.11 * sc),
               (w, zw), (w - 0.004 * sc, zsh), (lx + 0.012 * sc, bl - 0.004), (lx, bl + 0.006),
               ((lx + tx) / 2 + lean, (bl + tz) / 2), (tx, tz), (wr, zt - crown * 0.25), (wr * 0.5, zt - crown * 0.06),
               (0.0, zt)]
        # Keep the heights in order where the bands collapse (the hood, the tail).
        for i in range(4, 10):
            pts[i] = (pts[i][0], max(pts[i][1], pts[i - 1][1] + 1e-4))
        return pts, bl, wr, tx

    def band_material(u, j):
        """The material of band j of the section at u."""
        zt, bl = TOP(u), belt(u)
        glassy = gh[0] < u < gh[1] and zt - bl > 0.05
        if j <= 1:
            return "Trim"
        # The lower lip of the bumpers in black plastic; the van's bumpers black all over.
        if not van and j == 2 and (u < 0.22 or u > k["L"] - 0.18):
            return "Trim"
        if van and j <= 3 and (u < 0.32 or u > k["L"] - 0.12):
            return "Trim"
        if j == 6 and glassy and k["glass"][0] < u < k["glass"][1]:
            return "Trim"
        if j in (7, 8) and glassy and k["glass"][0] < u < k["glass"][1]:
            return next((p[2] for p in k["pillars"] if p[0] < u < p[1]), "Glass")
        if j in (10, 11) and glassy and (k["screen"][0] < u < k["screen"][1] or k["rear"][0] < u < k["rear"][1]):
            return "Glass"
        return "Paint"

    # Stations: closer at the ends, and on the edges of the windows and pillars.
    us = [L * (1 - math.cos(math.pi * i / 20)) / 2 for i in range(21)]
    edges = [*k["screen"], *k["glass"], *(k["rear"] if k["rear"][0] < 9 else ())] + [e for p in k["pillars"] for e in p[:2]]
    for e in edges:
        us = [u for u in us if abs(u - e) > 0.06] + [e]
    us = sorted(u for u in us if 0 <= u <= L)
    bm = bmesh.new()
    rings = []
    for u in us:
        half = section(u)[0]
        full = half + [(-x, z) for x, z in reversed(half[1:-1])]
        rings.append([bm.verts.new((x, L / 2 - u, z)) for x, z in full])
    n = len(rings[0])
    for ia, (a, b) in enumerate(zip(rings, rings[1:])):
        um = (us[ia] + us[ia + 1]) / 2
        for i in range(n):
            f = bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
            j = i if i < 12 else 23 - i
            f.material_index = ORDER.index(band_material(um, j))
    for ring, flip in ((rings[0], True), (rings[-1], False)):
        mid = bm.verts.new(sum((v.co for v in ring), Vector()) / n)
        for i in range(n):
            f = (ring[i], ring[(i + 1) % n], mid)
            face = bm.faces.new(f[::-1] if flip else f)
            low = face.calc_center_median().z < BOTTOM(0 if flip else L) + 0.06 or (van and flip)
            face.material_index = ORDER.index("Trim" if low else "Paint")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:
        if f.normal.z < -0.6:
            f.material_index = ORDER.index("Trim")  # the underside
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    body = link(bpy.data.objects.new(name, mesh))
    for m in MAT.values():
        mesh.materials.append(m)
    for p in mesh.polygons:
        p.use_smooth = True

    # Wheel arches, their inside black.
    for u in k["axles"]:
        bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=r_arch, depth=2.6, location=(0, L / 2 - u, k["wheel"]),
                                            rotation=(0, math.pi / 2, 0))
        cut = bpy.context.active_object
        cut.data.materials.append(MAT["Trim"])
        mod = body.modifiers.new("arch", "BOOLEAN")
        mod.operation = "DIFFERENCE"
        mod.solver = "EXACT"
        mod.object = cut
        if hasattr(mod, "material_mode"):
            mod.material_mode = "TRANSFER"
        cp.apply_mod(body, mod)
        bpy.data.objects.remove(cut)
    body.data.set_sharp_from_angle(angle=math.radians(40))

    # ---- Parts on the surface.
    tree = BVHTree.FromObject(body, bpy.context.evaluated_depsgraph_get())

    def cast(o, d):
        loc, nrm, _, _ = tree.ray_cast(Vector(o), Vector(d).normalized())
        return (loc, nrm) if loc is not None else None

    side = lambda s: (lambda u, z: cast((s * 2.0, L / 2 - u, z), (-s, 0, 0)))
    front = lambda x, z: cast((x, L / 2 + 1.0, z), (0, -1, 0))
    back = lambda x, z: cast((x, -L / 2 - 1.0, z), (0, 1, 0))
    top = lambda u, x: cast((x, L / 2 - u, 4.0), (0, 0, -1))

    B = Builder(name + "_parts")
    W0 = WIDTH(L / 2)
    lz, tz_, th = k["lamps"], k["tails"], k["tail_h"]
    Wf, Wr = WIDTH(0.12), WIDTH(L - 0.1)
    for s in (-1, 1):
        # Headlights: a dark housing out to the front corner, a bright reflector inside it.
        if van:
            x0, x1 = 0.56, Wf - 0.05
            hz = lambda t: (lz - 0.09, lz + 0.10 - 0.02 * t)
        else:
            x0, x1 = 0.36, Wf - 0.11
            hz = lambda t: (lz - 0.045 + 0.015 * t, lz + 0.045 + 0.03 * t)
        t_of = lambda x: (abs(x) - x0) / (x1 - x0)
        panel(B, front, [s * x for x in across(x0, x1, 4)], lambda x: across(*hz(t_of(x)), 2), "LampDark", out=0.006)
        panel(B, front, [s * x for x in across(x0 + 0.03, x1 - 0.06, 3)],
              lambda x: (lambda lo, hi: across(lo + 0.018, hi - 0.018, 2))(*hz(t_of(x))), "Lamp", out=0.009, skirt=False)
        # Tail lights out to the rear corners; a small reverse lamp at the inner end.
        if van:
            xs = [s * x for x in across(Wr - 0.15, Wr - 0.03, 2)]
            panel(B, back, xs, lambda x: across(tz_ - th / 2, tz_ + th / 2, 6), "Tail", out=0.008)
            panel(B, back, xs, lambda x: across(tz_ - th / 2 - 0.1, tz_ - th / 2 - 0.01, 1), "Reverse", out=0.008)
        else:
            t0 = Wr - 0.44
            tb = lambda x: (tz_ - th / 2 - 0.03 * (abs(x) - t0) / 0.42, tz_ + th / 2)
            panel(B, back, [s * x for x in across(t0, Wr - 0.02, 4)], lambda x: across(*tb(x), 2), "Tail", out=0.007)
            panel(B, back, [s * x for x in across(t0 + 0.02, t0 + 0.12, 1)],
                  lambda x: across(tz_ - th / 2 + 0.015, tz_ - 0.01, 1), "Reverse", out=0.010, skirt=False)
        # Mirrors: a pod on the door at the front corner of the glass, its foot black, its face a mirror.
        um = k["glass"][0] + (0.10 if not van else 0.12)
        zm = belt(um) + (0.07 if not van else 0.16)
        h = side(s)(um, zm)
        if h:
            foot = h[0] + Vector((0, 0, 0))
            size = (0.17, 0.065, 0.055) if not van else (0.22, 0.09, 0.16)
            pod(B, "Trim" if van else "Paint", foot, size[0], size[1], size[2], s)
            mface = foot + Vector((s * size[0] * 0.55, -size[1] * 0.92, 0))
            box(B, "Chrome", (size[0] * 0.75, 0.006, size[2] * 1.5), Matrix.Translation(mface))
            box(B, "Trim", (0.05, 0.05, 0.03), Matrix.Translation(foot + Vector((s * 0.02, 0, -size[2] * 0.6))))
        # Door seams: thin dark lines from the sill to the window, above the arches.
        for u in k["seams"]:
            z_lo = BOTTOM(u) + 0.12
            for ua in k["axles"]:
                if abs(u - ua) < r_arch:
                    z_lo = max(z_lo, k["wheel"] + math.sqrt(r_arch ** 2 - (u - ua) ** 2) + 0.02)
            z_hi = belt(u) - 0.012 if gh[0] < u < gh[1] else TOP(u) - 0.05
            if z_hi - z_lo > 0.1:
                ribbon(B, [side(s)(u, z) for z in across(z_lo, z_hi, 6)], 0.008, "Trim", out=0.003)
        # Door handles.
        for u in k["handles"]:
            zh = belt(u) - (0.09 if not van else 0.16)
            panel(B, side(s), across(u - 0.07, u + 0.07, 2), lambda a: across(zh - 0.014, zh + 0.014, 1), "Trim", out=0.007)
        # Side marker of the van, a rubbing strip along its side.
        if van:
            ribbon(B, [side(s)(u, 0.62) for u in across(0.45, L - 0.2, 12) if not any(abs(u - a) < r_arch + 0.03 for a in k["axles"])],
                   0.08, "Trim", out=0.005)
    # Grille and intake (dark), blank plates front and rear with a blue band.
    if van:
        panel(B, front, across(-0.52, 0.52, 8), lambda x: across(0.64, lz + 0.1, 3), "Trim", out=0.008)
        pz_f, pz_r = 0.50, 0.50
    else:
        panel(B, front, across(-0.30, 0.30, 6), lambda x: across(lz - 0.04, lz + 0.025, 1), "Trim", out=0.007)
        panel(B, front, across(-0.42, 0.42, 6), lambda x: across(0.30, 0.45 - 0.05 * (abs(x) / 0.42) ** 2, 2), "Trim", out=0.006)
        pz_f, pz_r = 0.40, tz_ - 0.25
    for ray, pz in ((front, pz_f), (back, pz_r)):
        panel(B, ray, across(-0.26, -0.22, 1), lambda x: across(pz - 0.055, pz + 0.055, 1), "PlateBand", out=0.012, skirt=False)
        panel(B, ray, across(-0.22, 0.26, 4), lambda x: across(pz - 0.055, pz + 0.055, 1), "Plate", out=0.012)
    # A third brake light, high on the tailgate or the rear doors.
    zt_r = TOP(L - 0.15) - (0.08 if not van else 0.06)
    panel(B, back, across(-0.13 if not van else -0.18, 0.13 if not van else 0.18, 2), lambda x: across(zt_r - 0.02, zt_r + 0.02, 1),
          "Tail", out=0.01)
    # Wipers at the foot of the windscreen.
    u_w = k["screen"][0] + 0.05
    for x0 in (-0.55, 0.0) if not van else (-0.75, 0.0):
        ribbon(B, [top(u_w + 0.03 * i / 6, x0 + 0.5 * i / 6) for i in range(7)], 0.015, "Trim", out=0.01)
    # The hood's front edge and the tailgate's or rear doors' seams.
    if not van:
        u_h = 0.33 if name == "hatch" else 0.36
        ribbon(B, [top(u_h + 0.04 * (x / 0.75) ** 2, x) for x in across(-0.75, 0.75, 10)], 0.007, "Trim", out=0.003)
        ribbon(B, [back(x, tz_ - th / 2 - 0.06) for x in across(-(W0 - 0.45), W0 - 0.45, 6)], 0.007, "Trim", out=0.003)
    else:
        ribbon(B, [back(0.0, z) for z in across(0.6, 2.35, 6)], 0.012, "Trim", out=0.004)
        for x in (-0.55, 0.55):  # the rear doors' windows, and a dark wall behind them
            panel(B, back, across(x - 0.34, x + 0.34, 4), lambda _: across(1.62, 2.18, 3), "Glass", out=0.008)
        box(B, "Interior", (1.8, 0.02, 1.0), Matrix.Translation((0, -L / 2 + 0.3, 1.85)))
        ribbon(B, [back(x, 0.62) for x in across(-0.95, 0.95, 6)], 0.10, "Trim", out=0.012)  # the step bumper's top
    if name == "estate":  # roof rails
        for s in (-1, 1):
            for u in across(1.9, 4.3, 1):
                h = top(u, s * 0.58)
                if h:
                    box(B, "Trim", (0.035, 0.05, 0.045), Matrix.Translation(h[0] + Vector((0, 0, 0.018))))
            a, b = top(1.9, s * 0.58), top(4.3, s * 0.58)
            if a and b:
                mid = (a[0] + b[0]) / 2 + Vector((0, 0, 0.045))
                d = b[0] - a[0]
                box(B, "Trim", (0.03, d.length, 0.025), Matrix.Translation(mid) @ Matrix.Rotation(math.atan2(d.z, -d.y), 4, "X"))

    # ---- The cabin behind the glass: a dark lining where the shell isn't glass, seats, dashboard, wheel.
    u0, u1 = k["dash"], k["cabin_end"]
    cus = across(u0, u1, 5)
    lb = bmesh.new()
    lrings = []
    for u in cus:
        pts = section(u)[0]
        zb, zt, w = BOTTOM(u), TOP(u), WIDTH(u)
        zf = zb + 0.16
        inner = [(0.0, zf), (w - 0.06, zf)] + [(max(0.0, x - 0.045), min(z, zt - 0.035)) for x, z in pts[3:]]
        inner = [(x, max(z, zf)) for x, z in inner]
        full = inner + [(-x, z) for x, z in reversed(inner[1:-1])]
        lrings.append([lb.verts.new((x, L / 2 - u, z)) for x, z in full])
    ln = len(lrings[0])
    for ia, (a, b) in enumerate(zip(lrings, lrings[1:])):
        um = (cus[ia] + cus[ia + 1]) / 2
        for i in range(ln):
            # Bands of the lining: 0 the floor, 1 up to the sill, then the shell's bands 3..11.
            j = i if i < 11 else 21 - i
            band = j + 1 if j >= 2 else -1
            if band >= 0 and band_material(um, band) == "Glass":
                continue
            f = lb.faces.new((a[i], b[i], b[(i + 1) % ln], a[(i + 1) % ln]))  # facing in
            f.material_index = ORDER.index("Interior")
    # The ends: at the front a wall up to the dashboard's top (the windscreen stays clear above it), at the
    # back a whole wall (the boot, or the van's bulkhead behind the cab).
    z_dash = belt(u0 + 0.18) - 0.02
    for ring, flip, cap in ((lrings[0], False, z_dash), (lrings[-1], True, 99.0)):
        flat = [lb.verts.new((v.co.x, v.co.y, min(v.co.z, cap))) for v in ring]
        mid = lb.verts.new(sum((v.co for v in flat), Vector()) / ln)
        for i in range(ln):
            f = (flat[i], flat[(i + 1) % ln], mid)
            lb.faces.new(f[::-1] if flip else f).material_index = ORDER.index("Interior")
    lining = bpy.data.meshes.new(name + "_lining")
    lb.to_mesh(lining)
    lb.free()
    lo = link(bpy.data.objects.new(name + "_lining", lining))
    for m in MAT.values():
        lining.materials.append(m)
    # Seats: cushion, back and headrest; the rear bench one wide back with two headrests.
    zc = BOTTOM(L / 2) + (0.33 if not van else 0.5)
    ys, yr = k["seats"]
    for x in (-0.38, 0.38) if not van else (-0.5, 0.45):
        y = L / 2 - ys
        box(B, "Interior", (0.48, 0.48, 0.12), Matrix.Translation((x, y + 0.26, zc)))
        box(B, "Interior", (0.48, 0.12, 0.58), Matrix.Translation((x, y - 0.02, zc + 0.33)) @ Matrix.Rotation(math.radians(-14), 4, "X"), 0.9)
        box(B, "Interior", (0.26, 0.10, 0.18), Matrix.Translation((x, y - 0.09, zc + 0.73)) @ Matrix.Rotation(math.radians(-10), 4, "X"))
    if yr:
        y = L / 2 - yr
        box(B, "Interior", (1.30, 0.46, 0.12), Matrix.Translation((0, y + 0.26, zc - 0.02)))
        box(B, "Interior", (1.30, 0.12, 0.55), Matrix.Translation((0, y - 0.02, zc + 0.30)) @ Matrix.Rotation(math.radians(-18), 4, "X"))
        for x in (-0.4, 0.4):
            box(B, "Interior", (0.24, 0.09, 0.15), Matrix.Translation((x, y - 0.11, zc + 0.65)) @ Matrix.Rotation(math.radians(-15), 4, "X"))
    # Dashboard and steering wheel (the driver on the left).
    ud = k["dash"] + 0.18
    zd = belt(ud) - 0.02
    box(B, "Interior", (2 * WIDTH(ud) - 0.2, 0.38, 0.22), Matrix.Translation((0, L / 2 - ud, zd - 0.06)))
    sw = Matrix.Translation((-0.38 if not van else -0.5, L / 2 - ud - 0.32, zd + 0.02)) @ Matrix.Rotation(math.radians(65 if not van else 40), 4, "X")
    ring_o = []
    for i in range(8):
        a = 2 * math.pi * i / 8
        ring_o.append([B.v(sw @ Vector(((0.19 + 0.016 * math.cos(b)) * math.cos(a), (0.19 + 0.016 * math.cos(b)) * math.sin(a),
                                         0.016 * math.sin(b)))) for b in (0, 2 * math.pi / 3, 4 * math.pi / 3)])
    for i in range(8):
        a, b = ring_o[i], ring_o[(i + 1) % 8]
        for j in range(3):
            f = (a[j], b[j], b[(j + 1) % 3], a[(j + 1) % 3])
            c = sw @ Vector((0.19 * math.cos(2 * math.pi * (i + 0.5) / 8), 0.19 * math.sin(2 * math.pi * (i + 0.5) / 8), 0))
            B.face(f, "Interior", sum((v.co for v in f), Vector()) / 4 - c)
    po = B.obj()

    bpy.ops.object.select_all(action="DESELECT")
    for o in (po, lo):
        o.select_set(True)
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    body["axles"] = [round(L / 2 - u, 3) for u in k["axles"]]
    body["track"] = k["track"]
    body["wheel"] = k["wheel"]
    body["length"] = L
    body["width"] = round(2 * WIDTH(L / 2), 3)
    body["height"] = round(max(p[1] for p in k["top"]), 3)
    body.data.set_sharp_from_angle(angle=math.radians(40))
    return body, section, band_material


def far_body(name, k, section, band_material):
    """The far copy: the body at fewer sections and points, closed at the ends; plain wheels; the lamps and
    plates as small patches."""
    L = k["L"]
    van = name == "van"
    us = [L * (1 - math.cos(math.pi * i / 9)) / 2 for i in range(10)]
    for e in (k["screen"][0], k["glass"][0], k["glass"][1]):
        us = [u for u in us if abs(u - e) > 0.12] + [e]
    us.sort()
    keep = [0, 3, 4, 6, 7, 9, 10, 12]  # of the 13 section points
    bm = bmesh.new()
    rings = []
    for u in us:
        half = [section(u)[0][i] for i in keep]
        full = half + [(-x, z) for x, z in reversed(half[1:-1])]
        rings.append([bm.verts.new((x, L / 2 - u, z)) for x, z in full])
    n = len(rings[0])
    band_of = [0, 3, 4, 6, 7, 9, 10]  # the near band each far band stands for
    for ia, (a, b) in enumerate(zip(rings, rings[1:])):
        um = (us[ia] + us[ia + 1]) / 2
        for i in range(n):
            f = bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
            j = i if i < len(keep) - 1 else n - 1 - i
            f.material_index = ORDER.index(band_material(um, band_of[j]))
    for ring, flip in ((rings[0], True), (rings[-1], False)):
        f = bm.faces.new(ring[::-1] if flip else ring)
        f.material_index = ORDER.index("Paint")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    for f in bm.faces:
        c = f.calc_center_median()
        if f.normal.z < -0.6 or (van and c.z < 0.66 and (L / 2 - c.y < 0.32 or L / 2 - c.y > L - 0.12)):
            f.material_index = ORDER.index("Trim")
    # Wheels: 8-sided black discs with a grey middle, as thick as the tyre.
    for ua in k["axles"]:
        for s in (-1, 1):
            wx, wy, r = s * (k["track"] / 2 + 0.1), L / 2 - ua, k["wheel"]
            ro, ri = [], []
            for i in range(8):
                a = 2 * math.pi * i / 8
                ro.append(bm.verts.new((wx, wy + r * math.cos(a), r + r * math.sin(a))))
                ri.append(bm.verts.new((wx - s * 0.2, wy + r * math.cos(a), r + r * math.sin(a))))
            made = [bm.faces.new((ro[i], ri[i], ri[(i + 1) % 8], ro[(i + 1) % 8])) for i in range(8)]
            for f in made:
                f.material_index = ORDER.index("Tyre")
            hub = bm.verts.new((wx, wy, r))
            for i in range(8):
                f = bm.faces.new((ro[i], ro[(i + 1) % 8], hub))
                f.material_index = ORDER.index("Rim" if i % 2 else "Tyre")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name + "_far")
    bm.to_mesh(me)
    bm.free()
    for m in MAT.values():
        me.materials.append(m)
    far = link(bpy.data.objects.new(name + "_far", me))
    # Lamps and plates: small patches lifted well clear (seen only from afar).
    tree = BVHTree.FromObject(far, bpy.context.evaluated_depsgraph_get())

    def cast(o, d):
        loc, nrm, _, _ = tree.ray_cast(Vector(o), Vector(d))
        return (loc, nrm) if loc is not None else None

    front = lambda x, z: cast((x, L / 2 + 1, z), (0, -1, 0))
    back = lambda x, z: cast((x, -L / 2 - 1, z), (0, 1, 0))
    FB = Builder(name + "_farparts")
    w = curve(k["width"])(0.4)
    lz, tz_, th = k["lamps"], k["tails"], k["tail_h"]
    for s in (-1, 1):
        x0, x1 = sorted((s * 0.42, s * (w - 0.1)))
        panel(FB, front, (x0, x1), lambda x: (lz - 0.05, lz + 0.06), "Lamp", out=0.03, skirt=False, longest=2.0)
        wr = curve(k["width"])(L - 0.15)
        x0, x1 = sorted((s * (wr - 0.45), s * (wr - 0.12)))
        panel(FB, back, (x0, x1), lambda x: (tz_ - th / 2, tz_ + th / 2), "Tail", out=0.03, skirt=False, longest=2.0)
    pz_f, pz_r = (0.5, 0.5) if van else (0.4, tz_ - 0.25)
    panel(FB, front, (-0.26, 0.26), lambda x: (pz_f - 0.055, pz_f + 0.055), "Plate", out=0.035, skirt=False, longest=2.0)
    panel(FB, back, (-0.26, 0.26), lambda x: (pz_r - 0.055, pz_r + 0.055), "Plate", out=0.035, skirt=False, longest=2.0)
    fo = FB.obj()
    bpy.ops.object.select_all(action="DESELECT")
    fo.select_set(True)
    far.select_set(True)
    bpy.context.view_layer.objects.active = far
    bpy.ops.object.join()
    far.data.set_sharp_from_angle(angle=math.radians(50))
    return far


def wheel():
    """One wheel, radius 0.32 m and 0.205 m wide, its axle along x and its face towards +x: a tyre with rounded
    shoulders, and a five-spoke rim with dark windows between the spokes, a lip and a cap."""
    W = Builder("wheel")
    n = 15  # three steps per spoke: the spoke and a window two steps wide
    R, hw, rim_r = 0.32, 0.1025, 0.215

    def ring(x, r):
        return [W.v((x, r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n))) for i in range(n)]

    def loft(profile, mat, outward):
        rs = [ring(x, r) for x, r in profile]
        for (xa, ra), (xb, rb), a, b in zip(profile, profile[1:], rs, rs[1:]):
            for i in range(n):
                th = 2 * math.pi * (i + 0.5) / n
                nx, nr = (rb - ra, -(xb - xa)) if outward else (-(rb - ra), xb - xa)
                W.face((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]), mat, Vector((nx, nr * math.cos(th), nr * math.sin(th))))
        return rs

    # The tyre from the outer bead over the tread to the inner side.
    tyre = [(hw - 0.012, rim_r + 0.004), (hw, R - 0.05), (hw - 0.012, R - 0.012), (hw - 0.035, R), (-hw + 0.035, R),
            (-hw + 0.012, R - 0.012), (-hw + 0.01, rim_r)]
    loft(tyre, "Tyre", True)
    # The rim's lip, then the face: spokes flush, windows 3 cm in, the hub.
    xf = hw - 0.02
    lip = loft([(hw - 0.012, rim_r + 0.004), (xf + 0.004, rim_r - 0.004), (xf, rim_r - 0.02)], "Rim", False)
    r_out, r_hub = rim_r - 0.02, 0.07
    outer = lip[-1]
    hub_ring = ring(xf + 0.004, r_hub)
    deep_o = ring(xf - 0.03, r_out - 0.005)
    deep_h = ring(xf - 0.03, r_hub + 0.01)
    for i in range(n):
        i1 = (i + 1) % n
        th = 2 * math.pi * (i + 0.5) / n
        radial = Vector((0, math.cos(th), math.sin(th)))
        if i % 3 == 0:  # a spoke, a little domed
            W.face((outer[i], outer[i1], hub_ring[i1], hub_ring[i]), "Rim", Vector((1, 0, 0)))
        else:  # a window: its floor dark, its walls round it
            W.face((deep_o[i], deep_o[i1], deep_h[i1], deep_h[i]), "RimDark", Vector((1, 0, 0)))
            W.face((outer[i], outer[i1], deep_o[i1], deep_o[i]), "RimDark", -radial)
            W.face((hub_ring[i], hub_ring[i1], deep_h[i1], deep_h[i]), "RimDark", radial)
    for i in range(n):  # the spokes' sides
        i1 = (i + 1) % n
        if i % 3 == 0:
            for a, edge in ((i, -1), (i1, 1)):
                tang = Vector((0, -math.sin(2 * math.pi * a / n), math.cos(2 * math.pi * a / n))) * edge
                W.face((outer[a], hub_ring[a], deep_h[a], deep_o[a]), "RimDark", tang)
    cap = W.v((xf + 0.012, 0, 0))
    for i in range(n):
        W.face((hub_ring[i], hub_ring[(i + 1) % n], cap), "Rim", Vector((1, 0, 0)))
    o = W.obj()
    o.data.set_sharp_from_angle(angle=math.radians(45))
    return o


objs, fars = [], []
for name, k in KINDS.items():
    body, section, band_material = build(name, k)
    objs.append(body)
    fars.append(far_body(name, k, section, band_material))
wheel_obj = wheel()
for o in objs:
    cp.bake_ao([o], reach=0.6, rays=48)
for o in fars:
    cp.bake_ao([o], reach=0.6, rays=24)
cp.bake_ao([wheel_obj], ground=False, rays=32, reach=0.15)
everything = objs + [wheel_obj] + fars
for o in everything:
    per = {}
    for p in o.data.polygons:
        m = o.data.materials[p.material_index].name
        per[m] = per.get(m, 0) + len(p.vertices) - 2
    print(f"traffic_cars: {o.name} {cp.triangles([o])} triangles ({', '.join(f'{m} {n}' for m, n in per.items())})")
# As cp.export, with the extras (axles, track ...) on the bodies.
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.object.select_all(action="DESELECT")
for o in everything:
    o.select_set(True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_texcoords=False, export_cameras=False, export_lights=False, export_extras=True,
                          export_vertex_color="ACTIVE", export_all_vertex_colors=False)
print(f"traffic_cars: {os.path.getsize(OUT)} bytes")

if PREVIEW:
    # The three side by side with their wheels, each in its own paint; the far copies beside them.
    paints = [srgb("7b1d1d"), srgb("1f3555"), srgb("e8e9eb")]
    for i, o in enumerate(objs):
        o.location.x = (i - 1) * 3.0
        pm = material(f"Paint{i}", paints[i], 0.3, 0.3, coat=1.0)
        for j, m in enumerate(o.data.materials):
            if m and m.name == "Paint":
                o.data.materials[j] = pm
        for y in o["axles"]:
            for s in (-1, 1):
                w = link(bpy.data.objects.new("w", wheel_obj.data))
                sc = o["wheel"] / 0.32
                w.scale = (sc, sc, sc)
                w.rotation_euler = (0, 0, 0 if s > 0 else math.pi)
                w.location = (o.location.x + s * (o["track"] / 2), y, o["wheel"])
    wheel_obj.location.z = -5
    for i, o in enumerate(fars):
        o.location = ((i - 1) * 3.0, -9.0, 0)
    views = [("front3q", (7.0, 8.5, 2.2), (0, 0, 0.8), 35), ("rear3q", (-7.0, -8.5, 2.4), (0, 0, 0.9), 35),
             ("side", (14, 0.3, 1.2), (0, 0, 1.0), 40), ("close", (2.4, 4.6, 1.5), (-0.6, 0.6, 0.8), 30),
             ("wheel", (-5.6, 2.6, 0.7), (-3.8, 1.25, 0.32), 45), ("far", (12, -16, 3), (0, -9, 0.8), 40)]
    only = set(os.environ.get("VIEWS", "").split(",")) - {""}
    cp.previews(PREVIEW, [v for v in views if not only or v[0] in only], 5.0)
