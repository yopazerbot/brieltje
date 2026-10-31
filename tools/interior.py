"""Build the main house's furniture and decor in Blender.

Run (Blender 5, no window):
  blender -b -P tools/interior.py -- <out.glb> [preview_dir]

Our own models (keuken,
leefruimte1, zithoek, hoekraam zitbank, dakterras keuken, slaapkamer, kinderkamer, speelruimte),
at usual sizes for such pieces. No logos, no copies of a product's details.

One GLB with one object per piece, each standing on its own origin (the floor, or the ceiling
fitting for lamps), its front towards +z in the GLB (Blender -Y). The game turns every material
into vertex colours (web/src/world/furnishing.ts), so pieces share a few materials and draw
calls. A material named "Mesh" keeps its UVs and is drawn as an open weave, one named "Lattice"
as an open cane lattice (the rattan shade), and those named "Boucle..." get the game's flecked
cloth. Leaves are two-sided (the game draws one side).

- ShellChair: the dining chair, a boucle shell round a seat cushion on thin cream steel legs.
- TerraceChair: the roof terrace chair, grey seat and back on a thin black frame with arms.
- Kentia: a kentia palm (about 1.8 m) in a tall ribbed brass pot, beside the sofa.
- Ficus: a small-leaved ficus (about 1.5 m) in a crumpled silver pot, by the kitchen glass.
- AcornCap: the oak cap of the acorn pendants over the dining table, for a globe of radius 1.
- BarStool: the island's counter stools in light ash: dished seat, splayed legs, a foot ring.
- Eucalyptus: the table's centrepiece, eucalyptus stems in a tall glass vase and a candle.
- DomeLamp: the black dome pendant in the main bedroom (origin at the ceiling).
- StepLamp: the sage-green stepped cylinder pendant over the kitchen island (origin at the ceiling).
- RattanShade: the wide, shallow woven shade of the children's rooms and the playroom.
"""
import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
PREVIEW = argv[1] if len(argv) > 1 else ""
rnd = random.Random(7)

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)


def srgb(h):
    """'#rrggbb' to linear RGB, as the Principled BSDF (and glTF) expect."""
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


_mats = {}


def mat(name, hexcol, rough=0.6, metal=0.0):
    if name in _mats:
        return _mats[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*srgb(hexcol), 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    _mats[name] = m
    return m


class Builder:
    """Collects vertices and faces (with a material each, and UVs) for one object."""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.uvl = None  # UVs only where a weave needs them (they would add to the download)
        self.mats = []

    @property
    def uv(self):
        if self.uvl is None:
            self.uvl = self.bm.loops.layers.uv.new("UVMap")
        return self.uvl

    def mi(self, m):
        if m not in self.mats:
            self.mats.append(m)
        return self.mats.index(m)

    def face(self, pts, m, uvs=None):
        uvl = self.uv if uvs else None  # made before any face that uses it
        vs = [self.bm.verts.new(p) for p in pts]
        f = self.bm.faces.new(vs)
        f.material_index = self.mi(m)
        if uvs:
            for lp, t in zip(f.loops, uvs):
                lp[uvl].uv = t
        return f

    def grid(self, rows, m, closed=False, uv=None, both=False):
        """Quads between rows of points (each row the same length); closed joins each row's ends."""
        n = len(rows[0])
        uvl = self.uv if uv else None  # made before any face that uses it
        vs = [[self.bm.verts.new(p) for p in r] for r in rows]
        for i in range(len(rows) - 1):
            for j in range(n if closed else n - 1):
                k = (j + 1) % n
                quad = [vs[i][j], vs[i][k], vs[i + 1][k], vs[i + 1][j]]
                f = self.bm.faces.new(quad)
                f.material_index = self.mi(m)
                if uv:
                    for lp, (a, b) in zip(f.loops, ((i, j), (i, j + 1), (i + 1, j + 1), (i + 1, j))):
                        lp[uvl].uv = uv(a, b)
                if both:
                    g = self.bm.faces.new(list(reversed([self.bm.verts.new(v.co) for v in quad])))
                    g.material_index = f.material_index
        return vs

    def lathe(self, profile, m, n=32, at=(0, 0, 0), sx=1.0, sy=1.0, ribs=None, uv=None):
        """Turn a profile [(radius, z)] round the z axis (ribs: (count, depth) on the radius)."""
        rows = []
        for r, z in profile:
            row = []
            for j in range(n):
                a = 2 * math.pi * j / n
                rr = r + (ribs[1] * math.cos(ribs[0] * a) if ribs and r > 0.02 else 0)
                row.append((at[0] + rr * math.cos(a) * sx, at[1] + rr * math.sin(a) * sy, at[2] + z))
            rows.append(row)
        return self.grid(rows, m, closed=True, uv=uv)

    def tube(self, pts, r, m, n=8, cap=True):
        """A round tube along a polyline (radius r, or a list of radii)."""
        rs = r if isinstance(r, (list, tuple)) else [r] * len(pts)
        pts = [Vector(p) for p in pts]
        rows = []
        for i, p in enumerate(pts):
            d = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
            side = d.cross(Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))).normalized()
            up = side.cross(d).normalized()
            rows.append([tuple(p + rs[i] * (math.cos(2 * math.pi * j / n) * side - math.sin(2 * math.pi * j / n) * up)) for j in range(n)])
        vs = self.grid(rows, m, closed=True)
        if cap:
            for row, rev in ((vs[0], True), (vs[-1], False)):
                f = self.bm.faces.new(list(reversed(row)) if rev else row)
                f.material_index = self.mi(m)

    def box(self, x0, x1, y0, y1, z0, z1, m):
        c = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
        for q in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
            self.face([c[i] for i in q], m)

    def leaf(self, base, direction, normal, length, width, m, fold=0.25, droop=0.0, segs=3, flat=False):
        """A leaf (or palm leaflet) from base along direction, folded along its midrib (or flat), two-sided."""
        d = Vector(direction).normalized()
        nrm = Vector(normal).normalized()
        side = d.cross(nrm).normalized()
        nrm = side.cross(d).normalized()
        mid, left, right = [], [], []
        for i in range(segs + 1):
            t = i / segs
            w = width * math.sin(math.pi * min(1, 0.15 + t * 0.95)) * (1 - 0.3 * t)
            p = Vector(base) + d * (length * t) - nrm * (droop * length * t * t)
            mid.append(tuple(p))
            left.append(tuple(p + side * w - nrm * (fold * w)))
            right.append(tuple(p - side * w - nrm * (fold * w)))
        for a, b in (((left, right),) if flat else ((left, mid), (mid, right))):
            for i in range(segs):
                quad = [a[i], a[i + 1], b[i + 1], b[i]]
                self.face(quad, m)
                # The back, half a millimetre behind (the same points would be merged away).
                self.face([tuple(Vector(q) - nrm * 0.0005) for q in reversed(quad)], m)

    def done(self, smooth=35):
        bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=1e-6)
        me = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(me)
        self.bm.free()
        for m in self.mats:
            me.materials.append(m)
        obj = bpy.data.objects.new(self.name, me)
        bpy.context.scene.collection.objects.link(obj)
        if smooth:
            me.set_sharp_from_angle(angle=math.radians(smooth))
        return obj


def outward(b):
    """Point the faces of closed parts outwards (only for pieces without leaves)."""
    bmesh.ops.recalc_face_normals(b.bm, faces=list(b.bm.faces))


# ---------------------------------------------------------------- the dining chair
def shell_chair():
    """Shell chair: seat 46 cm high, 53 wide, 55 deep, back up to 80 cm. The back
    is a crescent: it meets the seat at the sides and floats about 15 cm over it at the back."""
    b = Builder("ShellChair")
    boucle, metal = mat("Boucle", "#dcd3c5", 0.95), mat("Metal", "#e2ddd3", 0.4, 0.3)
    seat_z, top = 0.465, 0.80
    rows_out, rows_in = [], []
    n_a, n_t = 22, 5
    for i in range(n_t + 1):
        t = i / n_t
        ro, ri = [], []
        for j in range(n_a + 1):
            a = math.radians(-118 + 236 * j / n_a)  # 0 = the middle of the back (+y in Blender)
            low = 0.40 + 0.16 * max(0.0, math.cos(a)) ** 1.5
            high = 0.40 + (top - 0.40) * (0.28 + 0.72 * math.cos(a * 0.62) ** 1.6)
            z = low + (high - low) * t
            flare = 1 + 0.10 * t * t
            rx, ry = 0.255 * flare, 0.245 * flare
            x, y = rx * math.sin(a), 0.03 + ry * math.cos(a)
            ro.append((x, y, z))
            k = 1 - 0.028 / math.hypot(rx, ry) * 1.4
            ri.append((x * k, 0.03 + (y - 0.03) * k, z))
        rows_out.append(ro)
        rows_in.append(ri)
    vo = b.grid(rows_out, boucle)
    vi = b.grid(rows_in, boucle)
    # Close the rim (top edge and the two front ends) and the bottom edge.
    for i in range(n_t):
        for j in (0, n_a):
            b.bm.faces.new([vo[i][j], vo[i + 1][j], vi[i + 1][j], vi[i][j]]).material_index = 0
    for j in range(n_a):
        b.bm.faces.new([vo[n_t][j], vo[n_t][j + 1], vi[n_t][j + 1], vi[n_t][j]]).material_index = 0
        b.bm.faces.new([vo[0][j], vi[0][j], vi[0][j + 1], vo[0][j + 1]]).material_index = 0
    # The seat cushion, a rounded pad inside the shell.
    prof = [(0.0, seat_z), (0.17, seat_z), (0.215, seat_z - 0.008), (0.235, seat_z - 0.03), (0.23, seat_z - 0.055), (0.2, seat_z - 0.065), (0.0, seat_z - 0.065)]
    b.lathe(prof[::-1], boucle, n=22, at=(0, -0.01, 0), sx=1.0, sy=1.0)
    # Legs: thin steel tubes splaying out, a ring of tube under the seat.
    for sx in (-1, 1):
        b.tube([(sx * 0.215, -0.235, 0.0), (sx * 0.19, -0.19, 0.40)], 0.009, metal, n=6)
        b.tube([(sx * 0.225, 0.27, 0.0), (sx * 0.18, 0.17, 0.40)], 0.009, metal, n=6)
    ring = [(0.2 * math.sin(2 * math.pi * k / 16), -0.01 + 0.2 * math.cos(2 * math.pi * k / 16), 0.395) for k in range(17)]
    b.tube(ring, 0.008, metal, n=5, cap=False)
    outward(b)
    return b.done(50)


def terrace_chair():
    """Roof terrace chair: grey seat and back on a thin black steel frame
    with flat armrests, 56 wide, 55 deep, seat 45 cm, back 78 cm."""
    b = Builder("TerraceChair")
    seat, frame = mat("Upholstery", "#74787d", 0.9), mat("Frame", "#1d1e20", 0.5, 0.4)
    b.box(-0.235, 0.235, -0.24, 0.2, 0.405, 0.455, seat)
    b.box(-0.235, 0.235, 0.205, 0.245, 0.56, 0.78, seat)
    for sx in (-1, 1):
        x = sx * 0.265
        b.tube([(x * 1.04, -0.26, 0.0), (x, -0.22, 0.65)], 0.008, frame)        # front leg up to the arm
        b.tube([(x * 1.04, 0.27, 0.0), (x, 0.225, 0.40), (x * 0.98, 0.25, 0.80)], 0.008, frame)  # rear leg and back post
        b.box(x - 0.018, x + 0.018, -0.25, 0.15, 0.645, 0.665, frame)            # flat armrest
        b.tube([(x, -0.22, 0.40), (x, 0.225, 0.40)], 0.007, frame)               # side rail under the seat
        b.tube([(x, 0.24, 0.60), (sx * 0.24, 0.24, 0.60)], 0.006, frame)
    b.tube([(-0.265, -0.2, 0.40), (0.265, -0.2, 0.40)], 0.007, frame)
    outward(b)
    return b.done(40)


# ---------------------------------------------------------------- plants
def kentia():
    """Kentia palm in a tall ribbed brass pot, about 1.85 m."""
    b = Builder("Kentia")
    pot, soil, stem = mat("Pot", "#9a7a3c", 0.35, 0.6), mat("Soil", "#3a2c22", 1.0), mat("Stem", "#6b7a3f", 0.8)
    leaves = [mat("Leaf", "#3f6b2e", 0.7), mat("LeafLight", "#5a8a3c", 0.7)]
    prof = [(0.0, 0.0), (0.12, 0.0), (0.15, 0.02), (0.175, 0.12), (0.185, 0.24), (0.175, 0.36), (0.16, 0.44), (0.165, 0.46),
            (0.15, 0.46), (0.145, 0.43)]
    b.lathe(prof, pot, n=40, ribs=(20, 0.004))
    b.lathe([(0.147, 0.43), (0.0, 0.43)], soil, n=24)
    fronds = 9
    for f in range(fronds):
        az = 2 * math.pi * f / fronds + rnd.uniform(-0.25, 0.25)
        el = math.radians(rnd.uniform(64, 84))
        length = rnd.uniform(1.1, 1.55)
        dirh = Vector((math.cos(az), math.sin(az), 0))
        base = Vector((0.03 * math.cos(az), 0.03 * math.sin(az), 0.43))
        pts, dirs = [], []
        n = 14
        p = base.copy()
        d = (dirh * math.cos(el) + Vector((0, 0, math.sin(el)))).normalized()
        for i in range(n + 1):
            pts.append(p.copy())
            dirs.append(d.copy())
            p += d * (length / n)
            # The frond arches over: it bends down more towards the tip.
            d = (d - Vector((0, 0, 0.07 + 0.01 * i))).normalized()
        b.tube([tuple(q) for q in pts], [0.012 * (1 - 0.8 * i / n) for i in range(n + 1)], stem, n=4)
        for i in range(3, n + 1):
            t = i / n
            ll = 0.38 * math.sin(math.pi * (0.2 + 0.75 * t)) + 0.08
            for s in (-1, 1):
                side = dirs[i].cross(Vector((0, 0, 1))).normalized() * s
                ld = (side * 0.75 + dirs[i] * 0.55 - Vector((0, 0, 0.35))).normalized()
                b.leaf(tuple(pts[i]), tuple(ld), (0, 0, 1), ll, 0.022, leaves[(i + f) % 2], fold=0.35, droop=0.45, segs=2, flat=True)
    return b.done(60)


def ficus():
    """Ficus with small leaves in a crumpled silver pot, 1.5 m."""
    b = Builder("Ficus")
    pot, soil, bark = mat("PotSilver", "#8e9399", 0.3, 0.7), mat("Soil", "#3a2c22", 1.0), mat("Bark", "#6e5a45", 0.9)
    leaves = [mat("FicusLeaf", "#2e5528", 0.6), mat("FicusLeafLight", "#4d7a38", 0.6)]
    rows = []
    for i in range(9):
        z = 0.34 * i / 8
        r = 0.15 + 0.025 * math.sin(math.pi * i / 8) + (0.01 if i == 8 else 0)
        rows.append([(r * (1 + 0.06 * math.sin(7 * a + i * 1.7) * math.sin(3 * a + i)) * math.cos(a),
                      r * (1 + 0.06 * math.sin(7 * a + i * 1.7) * math.sin(3 * a + i)) * math.sin(a), z)
                     for a in (2 * math.pi * j / 40 for j in range(40))])
    b.grid(rows, pot, closed=True)
    b.lathe([(0.0, 0.0), (0.15, 0.0)], pot, n=40)
    b.lathe([(0.155, 0.31), (0.0, 0.31)], soil, n=24)
    for t in range(3):
        a0 = 2 * math.pi * t / 3
        pts = [(0.02 * math.cos(a0), 0.02 * math.sin(a0), 0.3)]
        for k in range(1, 8):
            pts.append((0.04 * math.cos(a0 + k * 0.9) * (1 + k * 0.08), 0.04 * math.sin(a0 + k * 0.9) * (1 + k * 0.08), 0.3 + k * 0.17))
        b.tube(pts, [0.016 - 0.0015 * k for k in range(8)], bark, n=6)
        # Branches from the upper trunk, leaves along them.
        for k in range(3, 8):
            az = a0 + k * 2.1 + rnd.uniform(-0.4, 0.4)
            base = Vector(pts[k])
            dr = Vector((math.cos(az), math.sin(az), rnd.uniform(0.15, 0.7))).normalized()
            blen = rnd.uniform(0.22, 0.42) * (1.1 - k * 0.06)
            tip = base + dr * blen - Vector((0, 0, 0.05))
            b.tube([tuple(base), tuple(base.lerp(tip, 0.5) + Vector((0, 0, 0.03))), tuple(tip)], [0.008, 0.006, 0.003], bark, n=4, cap=False)
            for q in range(11):
                at = base.lerp(tip, 0.25 + 0.75 * q / 10) + Vector((rnd.uniform(-0.04, 0.04), rnd.uniform(-0.04, 0.04), rnd.uniform(-0.03, 0.04)))
                ld = Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-0.8, 0.2)))
                b.leaf(tuple(at), tuple(ld), (rnd.uniform(-0.3, 0.3), rnd.uniform(-0.3, 0.3), 1), rnd.uniform(0.06, 0.085), 0.024,
                       leaves[rnd.randrange(2)], fold=0.2, droop=0.2, segs=1)
    # A crown of leaves at the top of the trunks.
    for q in range(60):
        az = rnd.uniform(0, 2 * math.pi)
        rr = rnd.uniform(0.0, 0.3)
        at = Vector((rr * math.cos(az), rr * math.sin(az), rnd.uniform(1.15, 1.5) - rr * 0.4))
        b.leaf(tuple(at), (math.cos(az), math.sin(az), rnd.uniform(-0.6, 0.3)), (0, 0, 1), rnd.uniform(0.06, 0.085), 0.024,
               leaves[rnd.randrange(2)], fold=0.2, droop=0.2, segs=1)
    return b.done(60)


def eucalyptus():
    """Table centrepiece: eucalyptus stems in a tall glass vase,
    a candle in a glass beside it. Origin at the table top."""
    b = Builder("Eucalyptus")
    glass, water, stem = mat("Glass", "#d3dcda", 0.1), mat("Water", "#b9c9c6", 0.1), mat("EucaStem", "#7a6f5a", 0.8)
    leaves = [mat("EucaLeaf", "#8fa892", 0.8), mat("EucaLeafDark", "#748f7b", 0.8)]
    candle, wick = mat("Candle", "#f2efe6", 0.7), mat("Wick", "#2a2522", 0.9)
    b.lathe([(0.0, 0.0), (0.055, 0.0), (0.058, 0.01), (0.06, 0.26), (0.054, 0.26), (0.052, 0.012), (0.0, 0.012)], glass, n=28)
    b.lathe([(0.051, 0.13), (0.0, 0.13)], water, n=20)
    for s in range(6):
        az = 2 * math.pi * s / 6 + rnd.uniform(-0.3, 0.3)
        lean = rnd.uniform(0.25, 0.55)
        h = rnd.uniform(0.45, 0.7)
        pts = []
        for k in range(8):
            t = k / 7
            pts.append((math.cos(az) * (0.02 + lean * h * t * t), math.sin(az) * (0.02 + lean * h * t * t), 0.05 + h * t))
        b.tube(pts, 0.003, stem, n=4, cap=False)
        for k in range(2, 8):
            p = Vector(pts[k])
            for sgn in (-1, 1):
                side = Vector((-math.sin(az), math.cos(az), 0)) * sgn
                r = 0.026 + 0.012 * rnd.random()
                c = p + side * r * 0.9 + Vector((0, 0, -0.01))
                # Round eucalyptus leaves: small discs on short stalks, turned to every side.
                nrm = (side * 0.6 + Vector((rnd.uniform(-0.4, 0.4), rnd.uniform(-0.4, 0.4), 0.6))).normalized()
                u = nrm.cross(Vector((0, 0, 1))).normalized()
                v = nrm.cross(u).normalized()
                ring = [tuple(c + r * (math.cos(2 * math.pi * q / 8) * u + math.sin(2 * math.pi * q / 8) * v)) for q in range(8)]
                m = leaves[rnd.randrange(2)]
                b.face(ring, m)
                b.face([tuple(Vector(q) - nrm * 0.0005) for q in reversed(ring)], m)
    # The candle in a low glass, to the side of the vase.
    cx, cy = 0.14, -0.06
    b.lathe([(0.0, 0.0), (0.045, 0.0), (0.047, 0.1), (0.042, 0.1), (0.04, 0.008), (0.0, 0.008)], glass, n=24, at=(cx, cy, 0))
    b.lathe([(0.0, 0.008), (0.03, 0.008), (0.03, 0.075), (0.0, 0.072)], candle, n=20, at=(cx, cy, 0))
    b.tube([(cx, cy, 0.07), (cx, cy, 0.085)], 0.0015, wick, n=4)
    return b.done(45)


# ---------------------------------------------------------------- lamps and stools
def acorn_cap():
    """The oak cap of an acorn pendant, for an opal globe of radius 1 centred on the origin: it
    covers the top half and flares a little over the globe, with a short stalk on top."""
    b = Builder("AcornCap")
    oak = mat("Oak", "#d2ad80", 0.6)
    outer = [(1.06, -0.04), (1.11, 0.12), (1.11, 0.36), (1.03, 0.6), (0.87, 0.84), (0.62, 1.02), (0.34, 1.12), (0.15, 1.15),
             (0.11, 1.17), (0.1, 1.38), (0.06, 1.42), (0.0, 1.43)]
    inner = [(0.0, 1.0), (0.5, 0.88), (0.82, 0.58), (0.98, 0.2), (1.01, -0.04)]
    b.lathe(inner + outer, oak, n=24)
    return b.done(50)


def bar_stool():
    """Counter stool at the island: light ash, seat 64 cm high, 36 cm across."""
    b = Builder("BarStool")
    ash = mat("Ash", "#d6b38c", 0.65)
    b.lathe([(0.0, 0.645), (0.12, 0.642), (0.17, 0.648), (0.182, 0.655), (0.182, 0.632), (0.17, 0.62), (0.0, 0.62)], ash, n=24)
    b.lathe([(0.13, 0.6), (0.13, 0.62), (0.115, 0.62), (0.115, 0.6), (0.13, 0.6)], ash, n=20)  # apron ring
    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
        b.tube([(0.115 * math.cos(a), 0.115 * math.sin(a), 0.62), (0.2 * math.cos(a), 0.2 * math.sin(a), 0.0)], [0.017, 0.014], ash, n=7)
    ring = [(0.168 * math.cos(2 * math.pi * k / 20), 0.168 * math.sin(2 * math.pi * k / 20), 0.24) for k in range(21)]
    b.tube(ring, 0.011, ash, n=6, cap=False)
    outward(b)
    return b.done(45)


def dome_lamp():
    """Black dome pendant over the main bed: 42 cm across, 26 cm high, hanging
    with its rim 0.85 m below the ceiling. Origin at the ceiling."""
    b = Builder("DomeLamp")
    black, inside, cord = mat("DomeBlack", "#1c1c1e", 0.45, 0.2), mat("DomeInside", "#3a3836", 0.6), mat("Cord", "#151515", 0.8)
    rim = -0.85
    outer = [(0.21, rim), (0.208, rim + 0.03), (0.195, rim + 0.1), (0.165, rim + 0.17), (0.11, rim + 0.225), (0.05, rim + 0.25),
             (0.03, rim + 0.26), (0.03, rim + 0.3), (0.0, rim + 0.3)]
    b.lathe(outer, black, n=28)
    inner = [(0.204, rim + 0.002), (0.19, rim + 0.1), (0.16, rim + 0.165), (0.105, rim + 0.215), (0.0, rim + 0.24)]
    b.lathe(list(reversed(inner)), inside, n=28)
    b.lathe([(0.0, -0.015), (0.06, -0.015), (0.06, 0.0), (0.0, 0.0)], black, n=24)  # ceiling cup
    b.tube([(0, 0, -0.015), (0, 0, rim + 0.3)], 0.003, cord, n=4)
    return b.done(45)


def step_lamp():
    """Sage stepped-cylinder pendant over the island: a 22 cm shade under a
    narrow neck. Origin at the rail on the ceiling; the shade's rim 1.0 m below it."""
    b = Builder("StepLamp")
    sage, inside, cord = mat("Sage", "#b7b58f", 0.55), mat("SageInside", "#e8e2cf", 0.6), mat("Cord", "#151515", 0.8)
    rim = -1.0
    outer = [(0.11, rim), (0.11, rim + 0.17), (0.105, rim + 0.18), (0.05, rim + 0.185), (0.045, rim + 0.19), (0.045, rim + 0.36),
             (0.03, rim + 0.37), (0.0, rim + 0.37)]
    b.lathe(outer, sage, n=24)
    b.lathe([(0.0, rim + 0.17), (0.106, rim + 0.17), (0.106, rim + 0.002)], inside, n=24)
    b.tube([(0, 0, 0.0), (0, 0, rim + 0.37)], 0.003, cord, n=4)
    return b.done(40)


def rattan_shade():
    """Wide, flat open-weave shade: 80 cm across and only 16 cm
    deep, a saucer of thin cane in an open lattice of 5 cm diamonds, its rim 0.55 m below the
    ceiling. The lattice is drawn as a see-through pattern ("Lattice" material, UVs set for the
    diamonds); a solid cane rim at the edge and a woven hub round the top. Origin at the ceiling."""
    b = Builder("RattanShade")
    lattice, cane, cord = mat("Lattice", "#c9a471", 0.8), mat("Cane", "#b38a57", 0.7), mat("Cord", "#151515", 0.8)
    rim = -0.55
    prof = [(0.40, rim), (0.394, rim + 0.04), (0.37, rim + 0.085), (0.31, rim + 0.125), (0.21, rim + 0.15), (0.07, rim + 0.16)]
    n = 48
    # Arc length along the profile for the v coordinate.
    s = [0.0]
    for (r0, z0), (r1, z1) in zip(prof, prof[1:]):
        s.append(s[-1] + math.hypot(r1 - r0, z1 - z0))
    cell = 0.05
    rows = [[(r * math.cos(2 * math.pi * j / n), r * math.sin(2 * math.pi * j / n), z) for j in range(n + 1)] for r, z in prof]

    def uv(i, j):
        u = j / n * 2 * math.pi * 0.3 / cell / 36  # cells round a mean radius of 30 cm
        v = s[i] / cell / 36
        return (u + v, u - v)

    b.grid(rows, lattice, uv=uv)
    ring = [(0.40 * math.cos(2 * math.pi * k / 32), 0.40 * math.sin(2 * math.pi * k / 32), rim) for k in range(33)]
    b.tube(ring, 0.006, cane, n=4, cap=False)
    b.lathe([(0.0, rim + 0.17), (0.07, rim + 0.16), (0.075, rim + 0.15), (0.0, rim + 0.15)], cane, n=24)  # the hub
    b.lathe([(0.0, -0.015), (0.06, -0.015), (0.06, 0.0), (0.0, 0.0)], cane, n=24)
    b.tube([(0, 0, -0.015), (0, 0, rim + 0.17)], 0.003, cord, n=4)
    return b.done(40)


objs = [shell_chair(), terrace_chair(), kentia(), ficus(), acorn_cap(), bar_stool(), eucalyptus(), dome_lamp(), step_lamp(), rattan_shade()]
for i, o in enumerate(objs):
    o.data.calc_loop_triangles()
    print(f"{o.name}: {len(o.data.loop_triangles)} triangles")

bpy.ops.object.select_all(action="DESELECT")
for o in objs:
    o.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_cameras=False, export_lights=False)

# ---------------------------------------------------------------- preview: all pieces in a row
if PREVIEW:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 1800, 700
    world = bpy.data.worlds.new("Room")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.55, 0.55, 0.56, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.8
    scene.world = world
    spots = {"ShellChair": (0, 0, 0), "TerraceChair": (0.7, 0, 0), "Kentia": (1.7, 0.2, 0), "Ficus": (2.9, 0.2, 0),
             "BarStool": (3.7, 0, 0), "Eucalyptus": (4.3, 0, 0.4), "AcornCap": (4.9, 0, 1.6), "DomeLamp": (5.6, 0, 2.3),
             "StepLamp": (6.3, 0, 2.3), "RattanShade": (7.3, 0, 2.3)}
    for o in objs:
        o.location = spots[o.name]
        if o.name == "AcornCap":
            o.scale = (0.1, 0.1, 0.1)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.1, location=(4.9, 0, 1.6))
    bpy.context.active_object.data.materials.append(mat("Opal", "#f4f1ea", 0.3))
    bpy.ops.mesh.primitive_plane_add(size=30, location=(3.5, 0, 0))
    bpy.context.active_object.data.materials.append(mat("Floor", "#9a948c", 0.8))
    bpy.ops.object.light_add(type="SUN", location=(0, 0, 5))
    sun = bpy.context.active_object
    sun.data.energy = 3.5
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(-30))
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    os.makedirs(PREVIEW, exist_ok=True)
    for label, at, target, lens in (("interior_row", (3.6, -7.5, 1.6), (3.6, 0, 1.0), 30),
                                    ("interior_chairs", (0.6, -2.0, 1.1), (0.4, 0, 0.45), 40),
                                    ("interior_plants", (2.3, -3.0, 1.2), (2.3, 0.2, 0.9), 35),
                                    ("interior_lamps", (6.0, -3.0, 1.2), (6.1, 0, 1.6), 35)):
        cam.location = at
        cam.data.lens = lens
        cam.rotation_euler = (Vector(target) - Vector(at)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(PREVIEW, f"{label}.png")
        bpy.ops.render.render(write_still=True)
