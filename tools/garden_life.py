"""Build the everyday things round the main house and the bungalow, in Blender.

Run (Blender 5, no window):
  blender -b -P tools/garden_life.py -- <out.glb> [preview_dir]

Our own models at the usual sizes of such things, no brands, no logos, no house numbers. One GLB
with one object per thing, each standing on its own origin on the ground, its front towards +z in
the GLB (Blender -Y). The game turns every material into vertex colours (web/src/world/yard.ts),
so the props of a garden are one mesh; the bird's materials name its parts, which the game paints
per species and whose wings it folds and flaps in the vertex shader (web/src/world/birds.ts).

- Letterbox: a steel letterbox on a post, for the plot entrance.
- Bike: a city bike on its stand, with mudguards, a carrier and a chain guard.
- Wheelbarrow, Rake, WateringCan: garden tools.
- Table, Chair, Parasol, Lounger, Barbecue: the bungalow's garden furniture.
- Mower, Dock: a robot mower and its charging station.
- Planter, BoxPot: an anthracite planter with an ornamental grass, a pot with a box ball.
- Bird: a small songbird, perched, about 15 cm long; its wings are modelled spread.
"""
import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
PREVIEW = argv[1] if len(argv) > 1 else ""
rnd = random.Random(11)

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
    """Collects vertices and faces (with a material each) for one object."""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.mats = []

    def mi(self, m):
        if m not in self.mats:
            self.mats.append(m)
        return self.mats.index(m)

    def face(self, pts, m):
        f = self.bm.faces.new([self.bm.verts.new(p) for p in pts])
        f.material_index = self.mi(m)
        return f

    def both(self, pts, m):
        """A thin sheet seen from both sides (the game draws one side): the back half a millimetre behind."""
        f = self.face(pts, m)
        f.normal_update()
        n = f.normal
        self.face([tuple(Vector(p) - n * 0.0005) for p in reversed(pts)], m)

    def grid(self, rows, m, closed=False, both=False):
        """Quads between rows of points (each row the same length); closed joins each row's ends."""
        n = len(rows[0])
        vs = [[self.bm.verts.new(p) for p in r] for r in rows]
        for i in range(len(rows) - 1):
            for j in range(n if closed else n - 1):
                k = (j + 1) % n
                f = self.bm.faces.new([vs[i][j], vs[i][k], vs[i + 1][k], vs[i + 1][j]])
                f.material_index = self.mi(m)
                if both:
                    f.normal_update()
                    g = self.bm.faces.new([self.bm.verts.new(tuple(v.co - f.normal * 0.0005)) for v in reversed(f.verts)])
                    g.material_index = f.material_index
        return vs

    def cap(self, row, m, flip=False):
        f = self.bm.faces.new(list(reversed(row)) if flip else row)
        f.material_index = self.mi(m)

    def lathe(self, profile, m, n=24, at=(0, 0, 0), sx=1.0, sy=1.0):
        """Turn a profile [(radius, z)] round the z axis."""
        rows = [[(at[0] + r * math.cos(2 * math.pi * j / n) * sx, at[1] + r * math.sin(2 * math.pi * j / n) * sy, at[2] + z)
                 for j in range(n)] for r, z in profile]
        return self.grid(rows, m, closed=True)

    def tube(self, pts, r, m, n=6, cap=True):
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
            self.cap(vs[0], m, True)
            self.cap(vs[-1], m)

    def ring(self, centre, axis, radius, r, m, n=6, segs=24, a0=0.0, a1=2 * math.pi):
        """A tube bent into a circle (or an arc from a0 to a1) round `axis` through `centre`."""
        axis = Vector(axis).normalized()
        u = axis.cross(Vector((0, 0, 1)) if abs(axis.z) < 0.9 else Vector((1, 0, 0))).normalized()
        v = axis.cross(u)
        full = abs(a1 - a0 - 2 * math.pi) < 1e-6
        k = segs if full else segs + 1
        pts = [Vector(centre) + radius * (math.cos(a0 + (a1 - a0) * i / segs) * u + math.sin(a0 + (a1 - a0) * i / segs) * v) for i in range(k)]
        rows = []
        for i, p in enumerate(pts):
            out = (p - Vector(centre)).normalized()
            rows.append([tuple(p + r * (math.cos(2 * math.pi * j / n) * out + math.sin(2 * math.pi * j / n) * axis)) for j in range(n)])
        if full:
            rows.append(rows[0])
        vs = self.grid(rows, m, closed=True)
        return vs

    def box(self, x0, x1, y0, y1, z0, z1, m):
        c = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
        for q in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
            self.face([c[i] for i in q], m)

    def loft(self, sections, m, top=True, bottom=True):
        """Closed rings (same point count) stacked into a solid, capped at both ends."""
        vs = self.grid(sections, m, closed=True)
        if bottom:
            self.cap(vs[0], m, True)
        if top:
            self.cap(vs[-1], m)
        return vs

    def done(self, smooth=35, fix=True):
        bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=1e-6)
        if fix:
            bmesh.ops.recalc_face_normals(self.bm, faces=list(self.bm.faces))
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


def rrect(cx, cy, hx, hy, r, z, n=3):
    """A rounded rectangle (corner radius r, n segments a corner) at height z, counter-clockwise."""
    pts = []
    for k, (sx, sy) in enumerate(((1, -1), (1, 1), (-1, 1), (-1, -1))):
        a0 = -math.pi / 2 + k * math.pi / 2
        for i in range(n + 1):
            a = a0 + (math.pi / 2) * i / n
            pts.append((cx + sx * (hx - r) + r * math.cos(a), cy + sy * (hy - r) + r * math.sin(a), z))
    return pts


# ---------------------------------------------------------------- the street side
def letterbox():
    """A steel letterbox on a square post: box 36 x 28 x 40 cm, its top at 1.35 m, the slot at the front."""
    b = Builder("Letterbox")
    steel, slot, lock = mat("Steel", "#2b2d30", 0.45, 0.6), mat("Slot", "#0d0e0f", 0.8), mat("Lock", "#b9bcbf", 0.3, 1.0)
    b.box(-0.035, 0.035, 0.01, 0.08, -0.3, 0.96, steel)
    b.box(-0.18, 0.18, -0.14, 0.14, 0.95, 1.33, steel)
    b.box(-0.19, 0.19, -0.155, 0.15, 1.33, 1.35, steel)
    b.box(-0.125, 0.125, -0.146, -0.135, 1.25, 1.285, slot)
    b.box(-0.165, 0.165, -0.15, -0.14, 0.965, 1.215, steel)  # the door
    w = [v for row in b.lathe([(0.0, 0.0), (0.008, 0.0), (0.008, 0.008), (0.0, 0.008)], lock, n=8, at=(0.12, -0.15, 1.17)) for v in row]
    bmesh.ops.rotate(b.bm, verts=w, cent=(0.12, -0.15, 1.17), matrix=Vector((0, 0, 1)).rotation_difference(Vector((0, -1, 0))).to_matrix())
    return b.done(30)


def bike():
    """A city bike on its stand: 28 inch wheels, 1.1 m between the axles, swept-back bars, a carrier
    and mudguards; leaning 5 degrees onto its stand on the left."""
    b = Builder("Bike")
    frame, tyre, metal = mat("Frame", "#24382f", 0.4, 0.3), mat("Tyre", "#141414", 0.9), mat("Metal", "#b8bbbe", 0.3, 1.0)
    saddle, grip = mat("Saddle", "#3a2a20", 0.6), mat("Grip", "#1d1a18", 0.7)
    R, hub_z, wb = 0.335, 0.335, 0.55
    for y in (-wb, wb):
        c = (0, y, hub_z)
        b.ring(c, (1, 0, 0), R - 0.02, 0.02, tyre, n=6, segs=28)
        b.ring(c, (1, 0, 0), R - 0.045, 0.008, metal, n=4, segs=28)
        for k in range(16):
            a = 2 * math.pi * (k + 0.5 * (k % 2)) / 16
            side = 0.03 if k % 2 else -0.03
            b.tube([(side, y, hub_z), (0, y + (R - 0.05) * math.cos(a), hub_z + (R - 0.05) * math.sin(a))], 0.0018, metal, n=3, cap=False)
        b.tube([(-0.045, y, hub_z), (0.045, y, hub_z)], 0.018, metal, n=8)
        b.ring(c, (1, 0, 0), R + 0.025, 0.026, frame, n=4, segs=10, a0=math.radians(-10 if y > 0 else 20), a1=math.radians(170 if y > 0 else 200))
    bb = (0, 0.04, 0.28)
    st = (0, 0.21, 0.80)
    ht_b, ht_t = (0, -0.40, 0.64), (0, -0.36, 0.84)
    b.tube([bb, st], 0.017, frame, n=8)
    b.tube([bb, (0, -0.18, 0.36), (0, -0.33, 0.52), ht_b], 0.021, frame, n=8)
    b.tube([(0, 0.18, 0.66), (0, -0.1, 0.70), ht_t], 0.016, frame, n=8)
    b.tube([ht_b, ht_t], 0.022, frame, n=8)
    for sx in (-1, 1):
        b.tube([bb, (sx * 0.055, wb, hub_z)], 0.010, frame, n=6)
        b.tube([(sx * 0.012, 0.20, 0.78), (sx * 0.055, wb, hub_z)], 0.009, frame, n=6)
        b.tube([(sx * 0.03, ht_b[1], ht_b[2]), (sx * 0.045, -0.47, 0.50), (sx * 0.045, -wb, hub_z)], 0.011, frame, n=6)
        # carrier: side rails and struts down to the rear axle
        b.tube([(sx * 0.075, 0.22, 0.79), (sx * 0.075, 0.80, 0.79)], 0.006, metal, n=4)
        b.tube([(sx * 0.075, 0.70, 0.79), (sx * 0.06, wb, hub_z)], 0.006, metal, n=4)
        b.tube([(sx * 0.02, ht_t[1] + 0.02, 1.0), (sx * 0.28, -0.24, 1.03), (sx * 0.30, -0.10, 1.01)], 0.011, metal, n=6)
        b.tube([(sx * 0.302, -0.16, 1.015), (sx * 0.30, -0.06, 1.0)], 0.017, grip, n=8)
        # crank and pedal
        cy, cz = 0.04 + sx * 0.14, 0.28 - sx * 0.06
        b.tube([(sx * 0.07, 0.04, 0.28), (sx * 0.085, cy, cz)], 0.009, metal, n=4)
        b.box(sx * 0.09 - 0.05 if sx > 0 else sx * 0.09 - 0.05, sx * 0.09 + 0.05, cy - 0.04, cy + 0.04, cz - 0.012, cz + 0.012, grip)
    for k in range(5):
        y = 0.24 + k * 0.14
        b.tube([(-0.075, y, 0.79), (0.075, y, 0.79)], 0.005, metal, n=4)
    b.tube([ht_t, (0, -0.35, 1.0)], 0.014, metal, n=6)
    b.ring(bb, (1, 0, 0), 0.1, 0.006, metal, n=4, segs=16)  # the chainring
    b.box(0.05, 0.058, 0.0, wb + 0.03, 0.22, 0.36, frame)    # the chain guard
    b.tube([st, (0, 0.235, 0.95)], 0.013, metal, n=6)
    sad = [rrect(0, 0.25, 0.10 * (1 - 0.55 * max(0, -y)), 0.135, 0.04, 0.0) for y in (0,)][0]
    sad_rows = []
    for z, s in ((0.955, 0.94), (0.985, 1.0), (1.0, 0.85)):
        row = []
        for x, y, _ in sad:
            w = 0.45 + 0.55 * (y - 0.115) / 0.27  # narrow nose at the front
            row.append((x * s * max(0.35, w), y, z))
        sad_rows.append(row)
    b.loft(sad_rows, saddle)
    b.box(-0.04, 0.04, -0.60, -0.54, 0.64, 0.70, metal)      # the lamp on the fork crown
    b.tube([(-0.02, 0.07, 0.28), (-0.17, 0.16, 0.005)], 0.009, metal, n=4)  # the stand
    obj = b.done(40)
    # Lean onto the stand: 5 degrees to the left about the line where the tyres touch the ground.
    obj.rotation_euler = (0, math.radians(-5), 0)
    return obj


# ---------------------------------------------------------------- garden tools
def wheelbarrow():
    """A builder's wheelbarrow: galvanised tray of about 90 litres, green tubes, a pneumatic wheel."""
    b = Builder("Wheelbarrow")
    tray, frame, tyre = mat("Tray", "#8e959a", 0.45, 0.7), mat("Barrow", "#2e5a34", 0.45, 0.3), mat("BarrowTyre", "#141414", 0.9)
    secs = []
    for z, hx, y0, y1 in ((0.32, 0.17, -0.18, 0.22), (0.60, 0.33, -0.55, 0.42), (0.62, 0.345, -0.57, 0.44)):
        secs.append(rrect(0, (y0 + y1) / 2, hx, (y1 - y0) / 2, 0.08, z))
    vs = b.grid(secs, tray, closed=True)
    b.cap(vs[0], tray, True)
    inner = [rrect(0, (y0 + y1) / 2, hx, (y1 - y0) / 2, 0.07, z) for z, hx, y0, y1 in ((0.61, 0.33, -0.55, 0.42), (0.34, 0.16, -0.17, 0.21))]
    vi = b.grid(inner, tray, closed=True)
    b.cap(vi[-1], tray)
    for sx in (-1, 1):
        b.tube([(sx * 0.06, -0.66, 0.19), (sx * 0.17, -0.3, 0.30), (sx * 0.24, 0.3, 0.42), (sx * 0.28, 0.85, 0.56)], 0.016, frame, n=6)
        b.tube([(sx * 0.27, 0.72, 0.535), (sx * 0.285, 0.90, 0.565)], 0.02, tyre, n=6)
        b.tube([(sx * 0.2, 0.15, 0.37), (sx * 0.22, 0.26, 0.0)], 0.013, frame, n=6)
    b.ring((0, -0.66, 0.19), (1, 0, 0), 0.15, 0.04, tyre, n=8, segs=20)
    b.tube([(-0.06, -0.66, 0.19), (0.06, -0.66, 0.19)], 0.03, tray, n=8)
    return b.done(40, fix=False)


def rake():
    """A garden rake standing upright on its head: the game leans it against something."""
    b = Builder("Rake")
    wood, steel = mat("Handle", "#a67c52", 0.6), mat("RakeSteel", "#5b6066", 0.4, 0.8)
    b.tube([(0, 0, 0.06), (0, 0, 1.55)], 0.014, wood, n=6)
    b.box(-0.2, 0.2, -0.012, 0.012, 0.035, 0.06, steel)
    for k in range(14):
        x = -0.19 + k * 0.38 / 13
        b.box(x - 0.004, x + 0.004, -0.004, 0.004, 0.0, 0.04, steel)
    return b.done(30)


def watering_can():
    """A zinc watering can of about 10 litres with its rose."""
    b = Builder("WateringCan")
    zinc = mat("Zinc", "#a3a9ad", 0.4, 0.8)
    vs = b.lathe([(0.0, 0.0), (0.11, 0.0), (0.115, 0.01), (0.11, 0.24), (0.09, 0.28), (0.0, 0.29)], zinc, n=20)
    b.tube([(0, -0.08, 0.04), (0, -0.2, 0.17), (0, -0.30, 0.32)], [0.018, 0.014, 0.01], zinc, n=6)
    b.lathe([(0.0, 0.0), (0.03, 0.02), (0.03, 0.03), (0.0, 0.03)], zinc, n=10, at=(0, -0.31, 0.32))
    b.tube([(0, 0.07, 0.28), (0, 0.04, 0.36), (0, -0.04, 0.36), (0, -0.08, 0.27)], 0.009, zinc, n=5)
    b.tube([(0, 0.11, 0.22), (0, 0.15, 0.17), (0, 0.11, 0.08)], 0.008, zinc, n=5)
    return b.done(40)


# ---------------------------------------------------------------- garden furniture
def table():
    """A teak garden table, 160 x 90 cm, 74 cm high, a slatted top on an apron and four square legs."""
    b = Builder("Table")
    teak = mat("Teak", "#9b7b58", 0.75)
    for k in range(7):
        y = -0.45 + k * (0.9 / 7)
        b.box(-0.8, 0.8, y + 0.006, y + 0.9 / 7 - 0.006, 0.71, 0.74, teak)
    for sx in (-1, 1):
        b.box(sx * 0.70 - 0.025, sx * 0.70 + 0.025, -0.38, 0.38, 0.62, 0.71, teak)
        for sy in (-1, 1):
            b.box(sx * 0.72 - 0.028, sx * 0.72 + 0.028, sy * 0.36 - 0.028, sy * 0.36 + 0.028, 0.0, 0.71, teak)
    for sy in (-1, 1):
        b.box(-0.7, 0.7, sy * 0.36 - 0.02, sy * 0.36 + 0.02, 0.62, 0.71, teak)
    return b.done(20, fix=False)


def chair():
    """A teak garden chair with arms: seat 45 cm high, back to 88 cm, slats front to back."""
    b = Builder("Chair")
    teak = mat("Teak", "#9b7b58", 0.75)
    for k in range(5):
        x = -0.23 + k * 0.46 / 5
        b.box(x + 0.006, x + 0.46 / 5 - 0.006, -0.22, 0.2, 0.42, 0.445, teak)
    for sx in (-1, 1):
        x = sx * 0.25
        b.box(x - 0.022, x + 0.022, -0.25, -0.206, 0.0, 0.64, teak)                  # front leg up to the arm
        b.box(x - 0.022, x + 0.022, 0.2, 0.244, 0.0, 0.45, teak)                      # back leg
        b.box(x - 0.03, x + 0.03, -0.27, 0.24, 0.64, 0.665, teak)                     # armrest
        b.box(x - 0.022, x + 0.022, -0.23, 0.22, 0.36, 0.40, teak)                    # side rail
    for z in (0.5, 0.62, 0.74, 0.84):
        b.face([(-0.25, 0.22 + (z - 0.45) * 0.25, z), (0.25, 0.22 + (z - 0.45) * 0.25, z),
                (0.25, 0.24 + (z + 0.07 - 0.45) * 0.25, z + 0.07), (-0.25, 0.24 + (z + 0.07 - 0.45) * 0.25, z + 0.07)], teak)
        b.face([(-0.25, 0.24 + (z + 0.07 - 0.45) * 0.25, z + 0.07), (0.25, 0.24 + (z + 0.07 - 0.45) * 0.25, z + 0.07),
                (0.25, 0.22 + (z - 0.45) * 0.25, z), (-0.25, 0.22 + (z - 0.45) * 0.25, z)], teak)
    for sx in (-1, 1):
        b.box(sx * 0.25 - 0.022, sx * 0.25 + 0.022, 0.2, 0.25, 0.45, 0.9, teak)          # back posts
    b.box(-0.25, 0.25, 0.32, 0.36, 0.88, 0.92, teak)
    return b.done(20, fix=False)


def parasol():
    """A round parasol of 3 m, open, on a granite foot: canopy rim at 2.05 m, top at 2.5 m."""
    b = Builder("Parasol")
    canvas, alu, stone = mat("Canvas", "#ddd3bd", 0.95), mat("ParasolAlu", "#a9adb0", 0.35, 0.9), mat("Granite", "#3c3d3f", 0.7)
    b.box(-0.24, 0.24, -0.24, 0.24, 0.0, 0.06, stone)
    b.tube([(0, 0, 0.0), (0, 0, 2.52)], 0.022, alu, n=8)
    n, R = 8, 1.5
    rings = []
    for r, z in ((0.02, 2.5), (0.5, 2.36), (1.0, 2.2), (R, 2.02)):
        rings.append([(r * math.cos(2 * math.pi * j / n + math.pi / 8), r * math.sin(2 * math.pi * j / n + math.pi / 8), z) for j in range(n)])
    # The panels sag a little between the ribs.
    sag = []
    for r, z in ((0.02, 2.5), (0.5, 2.36), (1.0, 2.2), (R, 2.02)):
        row = []
        for j in range(n * 2):
            a = 2 * math.pi * j / (n * 2) + math.pi / 8
            rr = r * (1 if j % 2 == 0 else math.cos(math.pi / n))
            row.append((rr * math.cos(a), rr * math.sin(a), z - (0.035 * r / R if j % 2 else 0)))
        sag.append(row)
    b.grid(sag, canvas, closed=True, both=True)
    val = [[(p[0], p[1], p[2]) for p in sag[-1]], [(p[0] * 1.0, p[1] * 1.0, p[2] - 0.13) for p in sag[-1]]]
    b.grid(val, canvas, closed=True, both=True)
    for j in range(n):
        a = 2 * math.pi * j / n + math.pi / 8
        d = (math.cos(a), math.sin(a))
        b.tube([(d[0] * 0.03, d[1] * 0.03, 2.47), (d[0] * 0.5, d[1] * 0.5, 2.33), (d[0] * 1.0, d[1] * 1.0, 2.17), (d[0] * (R - 0.02), d[1] * (R - 0.02), 1.99)], 0.006, alu, n=3)
        b.tube([(d[0] * 0.03, d[1] * 0.03, 1.92), (d[0] * 0.75, d[1] * 0.75, 2.24)], 0.005, alu, n=3)
    b.lathe([(0.0, 0.0), (0.035, 0.0), (0.035, 0.08), (0.0, 0.08)], alu, n=8, at=(0, 0, 1.88))
    b.lathe([(0.0, 0.0), (0.03, 0.0), (0.0, 0.07)], alu, n=8, at=(0, 0, 2.5))
    return b.done(30, fix=False)


def lounger():
    """A sun lounger: aluminium frame, grey textilene, back raised 40 degrees, wheels at the head; 1.95 m long."""
    b = Builder("Lounger")
    alu, sling, wheel = mat("LoungerAlu", "#8d9093", 0.35, 0.9), mat("Sling", "#5d6266", 0.85), mat("LoungerWheel", "#1a1a1a", 0.8)
    z, hinge, foot = 0.34, -0.30, 0.95
    back_len, ang = 0.68, math.radians(40)
    top = (hinge - back_len * math.cos(ang), z + back_len * math.sin(ang))
    for sx in (-1, 1):
        x = sx * 0.31
        b.tube([(x, foot, z), (x, hinge, z), (x, top[0], top[1])], 0.014, alu, n=6)
        b.tube([(x, foot - 0.04, z), (x, foot - 0.04, 0.0)], 0.014, alu, n=6)
        b.tube([(x, hinge + 0.1, z), (x, hinge - 0.05, 0.1)], 0.014, alu, n=6)
        b.ring((x + sx * 0.02, hinge - 0.08, 0.075), (1, 0, 0), 0.06, 0.02, wheel, n=5, segs=10)
        b.tube([(x, hinge - 0.4, top[1] * 0.0 + z), (x, hinge - 0.25, z - 0.12)], 0.012, alu, n=5)
    b.tube([(-0.31, foot, z), (0.31, foot, z)], 0.014, alu, n=6)
    b.tube([(-0.31, top[0], top[1]), (0.31, top[0], top[1])], 0.014, alu, n=6)
    rows = []
    for y, zz in ((foot - 0.02, z + 0.005), (0.3, z - 0.02), (hinge, z), (hinge - back_len * 0.5 * math.cos(ang), z + back_len * 0.5 * math.sin(ang) - 0.012), (top[0] + 0.02, top[1] - 0.01)):
        rows.append([(x, y, zz) for x in (-0.295, 0.0, 0.295)])
    b.grid(rows, sling, both=True)
    return b.done(30, fix=False)


def barbecue():
    """A kettle barbecue of 57 cm in black enamel on three legs, two with wheels, lid handle on top."""
    b = Builder("Barbecue")
    enamel, steel, wheel, handle = mat("Enamel", "#17181b", 0.3, 0.2), mat("BbqSteel", "#a6aaad", 0.35, 0.9), mat("BbqWheel", "#1a1a1a", 0.8), mat("BbqHandle", "#26221f", 0.6)
    R, zc = 0.285, 0.70
    prof = [(0.0, zc - R * 0.95)]
    for k in range(1, 9):
        a = -math.pi / 2 + (math.pi / 2) * k / 8
        prof.append((R * math.cos(a), zc + R * 0.95 * math.sin(a)))
    b.lathe(prof, enamel, n=24)
    lid = [(R * 1.01, zc + 0.005)]
    for k in range(1, 9):
        a = (math.pi / 2) * k / 8
        lid.append((R * 1.01 * math.cos(a) + (0.0 if k < 8 else 0.0), zc + 0.005 + R * 0.8 * math.sin(a)))
    b.lathe(lid, enamel, n=24)
    b.tube([(-0.1, 0, zc + R * 0.8 + 0.06), (0.1, 0, zc + R * 0.8 + 0.06)], 0.02, handle, n=6)
    for sx in (-1, 1):
        b.tube([(sx * 0.08, 0, zc + R * 0.8), (sx * 0.08, 0, zc + R * 0.8 + 0.06)], 0.006, steel, n=4)
    for k in range(3):
        a = math.pi / 2 + k * 2 * math.pi / 3
        d = (math.cos(a), math.sin(a))
        b.tube([(d[0] * 0.21, d[1] * 0.21, zc - 0.17), (d[0] * 0.33, d[1] * 0.33, 0.08 if k else 0.0)], 0.013, steel, n=6)
        if k:
            b.ring((d[0] * 0.36, d[1] * 0.36, 0.075), (d[0], d[1], 0), 0.065, 0.02, wheel, n=5, segs=12)
    b.lathe([(0.0, 0.17), (0.1, 0.17), (0.12, 0.2), (0.0, 0.2)], steel, n=14)
    tri = [(0.3 * math.cos(math.pi / 2 + k * 2 * math.pi / 3), 0.3 * math.sin(math.pi / 2 + k * 2 * math.pi / 3), 0.18) for k in range(4)]
    b.tube(tri, 0.006, steel, n=3, cap=False)
    return b.done(35, fix=False)


# ---------------------------------------------------------------- the robot mower
def mower():
    """A robot mower: 60 x 44 cm, 26 cm high, a light shell on a dark chassis, two drive wheels at the
    back and a caster at the front, a display hatch and a red stop button."""
    b = Builder("Mower")
    chassis, shell, panel = mat("Chassis", "#2b2e31", 0.6), mat("Shell", "#d9dcda", 0.35), mat("Panel", "#1b1c1e", 0.3)
    button, wheel = mat("Button", "#c8322b", 0.4), mat("MowerWheel", "#18191a", 0.9)
    secs = [rrect(0, 0.0, 0.2, 0.29, 0.12, z) for z in (0.045, 0.16)]
    b.loft(secs, chassis)
    shell_secs = []
    for z, hx, hy, r, cy in ((0.13, 0.215, 0.305, 0.13, 0.0), (0.2, 0.205, 0.29, 0.12, 0.0), (0.245, 0.17, 0.25, 0.1, 0.01), (0.262, 0.11, 0.17, 0.07, 0.02)):
        shell_secs.append(rrect(0, cy, hx, hy, r, z))
    b.loft(shell_secs, shell)
    b.box(-0.07, 0.07, -0.02, 0.1, 0.262, 0.268, panel)
    b.lathe([(0.0, 0.0), (0.022, 0.0), (0.02, 0.012), (0.0, 0.014)], button, n=10, at=(0, -0.06, 0.262))
    for sx in (-1, 1):
        c = (sx * 0.235, 0.14, 0.115)
        w = [v for row in b.lathe([(0.0, -0.03), (0.1, -0.03), (0.115, -0.02), (0.115, 0.02), (0.1, 0.03), (0.0, 0.03)], wheel, n=16) for v in row]
        bmesh.ops.rotate(b.bm, verts=w, cent=(0, 0, 0), matrix=Vector((0, 0, 1)).rotation_difference(Vector((1, 0, 0))).to_matrix())
        bmesh.ops.translate(b.bm, verts=w, vec=c)
    b.ring((0, -0.22, 0.04), (1, 0, 0), 0.03, 0.012, wheel, n=5, segs=10)
    return b.done(35)


def dock():
    """The mower's charging station: a ribbed plate to drive onto and a post with the contacts."""
    b = Builder("Dock")
    body, contact, led = mat("DockBody", "#26282a", 0.6), mat("Contact", "#c0c3c5", 0.3, 1.0), mat("Led", "#5fd36f", 0.4)
    b.loft([rrect(0, 0.08, 0.22, 0.32, 0.05, z) for z in (0.0, 0.025)], body)
    for k in range(6):
        y = -0.12 + k * 0.08
        b.box(-0.18, 0.18, y, y + 0.02, 0.025, 0.035, body)
    b.loft([rrect(0, -0.3, 0.14, 0.07, 0.04, z) for z in (0.0, 0.2)] + [rrect(0, -0.29, 0.11, 0.05, 0.03, 0.24)], body)
    for sx in (-1, 1):
        b.box(sx * 0.06 - 0.015, sx * 0.06 + 0.015, -0.235, -0.22, 0.09, 0.13, contact)
    b.box(-0.012, 0.012, -0.236, -0.226, 0.17, 0.18, led)
    return b.done(35)


# ---------------------------------------------------------------- plants in pots
def planter():
    """A tall square planter in anthracite fibreclay (40 cm, 75 high) with an ornamental grass in autumn colour."""
    b = Builder("Planter")
    pot, soil = mat("Fibreclay", "#38393b", 0.85), mat("Soil", "#2e241c", 1.0)
    blades = [mat("Grass", "#8b955a", 0.8), mat("GrassStraw", "#c2b27e", 0.8)]
    b.loft([rrect(0, 0, 0.18, 0.18, 0.015, 0.0), rrect(0, 0, 0.2, 0.2, 0.015, 0.75)], pot, top=False)
    b.face(rrect(0, 0, 0.185, 0.185, 0.015, 0.72), soil)
    for k in range(70):
        a = rnd.uniform(0, 2 * math.pi)
        lean = rnd.uniform(0.15, 1.1)
        length = rnd.uniform(0.45, 0.85)
        base = Vector((math.cos(a) * rnd.uniform(0, 0.08), math.sin(a) * rnd.uniform(0, 0.08), 0.72))
        d = Vector((math.cos(a) * math.sin(lean * 0.6), math.sin(a) * math.sin(lean * 0.6), math.cos(lean * 0.6)))
        side = Vector((-math.sin(a), math.cos(a), 0)) * 0.006
        pts, prev = [], base
        for i in range(5):
            t = i / 4
            p = base + d * length * t - Vector((0, 0, lean * 0.3 * length * t * t)) + Vector((math.cos(a), math.sin(a), 0)) * lean * 0.25 * length * t * t
            w = 1 - t * 0.9
            pts.append((p + side * w, p - side * w))
        m = blades[k % 2]
        for i in range(4):
            b.both([tuple(pts[i][0]), tuple(pts[i][1]), tuple(pts[i + 1][1]), tuple(pts[i + 1][0])], m)
    return b.done(0, fix=False)


def box_pot():
    """A round anthracite pot (45 cm) with a clipped box ball of about 50 cm."""
    b = Builder("BoxPot")
    pot, leaf = mat("Fibreclay", "#38393b", 0.85), mat("Box", "#3c5b2e", 0.9)
    b.lathe([(0.0, 0.0), (0.17, 0.0), (0.2, 0.05), (0.225, 0.38), (0.235, 0.4), (0.21, 0.4), (0.2, 0.37), (0.0, 0.37)], pot, n=20)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=0.26, location=(0, 0, 0.6))
    ball = bpy.context.active_object
    for v in ball.data.vertices:
        n = v.co.normalized()
        v.co = v.co * (1 + rnd.uniform(-0.06, 0.06))
    bm = bmesh.new()
    bm.from_mesh(ball.data)
    bpy.data.objects.remove(ball)
    for f in bm.faces:
        b.face([tuple(v.co + Vector((0, 0, 0.6))) for v in f.verts], leaf)
    bm.free()
    return b.done(0)


# ---------------------------------------------------------------- the bird
def bird():
    """A small songbird (sparrow size, 15 cm), perched: origin between its feet, looking along -y.
    The wings are modelled spread (span along x from the shoulders); the game folds them onto the
    back when perched and flaps them in flight. Materials name the parts."""
    b = Builder("Bird")
    body, belly, head = mat("BirdBody", "#7a5a3c", 0.9), mat("BirdBelly", "#c9b9a0", 0.9), mat("BirdHead", "#6b6460", 0.9)
    beak, eye, legs = mat("BirdBeak", "#3a3530", 0.5), mat("BirdEye", "#0a0a0a", 0.2), mat("BirdLegs", "#7d6a58", 0.8)
    wing_l, wing_r, tail = mat("BirdWingL", "#6b4e33", 0.9), mat("BirdWingR", "#6b4e33", 0.9), mat("BirdTail", "#4f3b2a", 0.9)
    # Body: an egg along y, belly below the middle line (two materials), centre 6 cm up.
    n, rows_t, rows_b = 10, [], []
    prof = [(-0.055, 0.004), (-0.045, 0.022), (-0.025, 0.031), (0.0, 0.032), (0.025, 0.027), (0.045, 0.016), (0.06, 0.004)]
    rings = []
    for y, r in prof:
        rings.append([(r * math.cos(2 * math.pi * j / n), y, 0.062 + r * 1.05 * math.sin(2 * math.pi * j / n)) for j in range(n)])
    for i in range(len(rings) - 1):
        for j in range(n):
            k = (j + 1) % n
            m = belly if (math.sin(2 * math.pi * (j + 0.5) / n) < -0.2) else body
            b.face([rings[i][j], rings[i][k], rings[i + 1][k], rings[i + 1][j]], m)
    b.cap([b.bm.verts.new(p) for p in rings[0]], body, True)
    b.cap([b.bm.verts.new(p) for p in rings[-1]], body)
    # Head: a ball at the front, a little up; beak and eyes.
    hc = Vector((0, -0.058, 0.088))
    hr = 0.021
    hrows = []
    for i in range(6):
        t = math.pi * i / 5
        hrows.append([tuple(hc + Vector((hr * math.sin(t) * math.cos(2 * math.pi * j / 8), hr * math.sin(t) * math.sin(2 * math.pi * j / 8), hr * math.cos(t)))) for j in range(8)])
    b.grid(hrows, head, closed=True)
    b.face([tuple(hc + Vector((0.006, -0.017, 0.0))), tuple(hc + Vector((-0.006, -0.017, 0.0))), tuple(hc + Vector((0, -0.036, -0.004)))], beak)
    b.face([tuple(hc + Vector((-0.006, -0.017, 0.0))), tuple(hc + Vector((0, -0.017, -0.008))), tuple(hc + Vector((0, -0.036, -0.004)))], beak)
    b.face([tuple(hc + Vector((0, -0.017, -0.008))), tuple(hc + Vector((0.006, -0.017, 0.0))), tuple(hc + Vector((0, -0.036, -0.004)))], beak)
    for sx in (-1, 1):
        e = hc + Vector((sx * 0.0195, -0.008, 0.005))
        b.face([tuple(e + Vector((0, -0.004, -0.004))), tuple(e + Vector((0, 0.004, -0.004))), tuple(e + Vector((0, 0.004, 0.004))), tuple(e + Vector((0, -0.004, 0.004)))][:: sx], eye)
    # Tail: a flat wedge behind, tilted up a little.
    b.both([(-0.012, 0.045, 0.068), (0.012, 0.045, 0.068), (0.024, 0.115, 0.078), (-0.024, 0.115, 0.078)], tail)
    # Wings, spread: from the shoulder (x = +-0.02, 7 cm up) out to +-0.12, chord 6 cm tapering.
    for sx, m in ((-1, wing_l), (1, wing_r)):
        pts = [(sx * 0.018, -0.03, 0.075), (sx * 0.06, -0.033, 0.077), (sx * 0.105, -0.022, 0.077), (sx * 0.125, 0.0, 0.076),
               (sx * 0.1, 0.022, 0.076), (sx * 0.05, 0.03, 0.075), (sx * 0.018, 0.025, 0.075)]
        ctr = (sx * 0.06, 0.0, 0.0765)
        for i in range(len(pts) - 1):
            b.both([ctr, pts[i], pts[i + 1]][:: -sx if sx < 0 else 1], m)
    for sx in (-1, 1):
        b.tube([(sx * 0.008, -0.005, 0.035), (sx * 0.009, -0.003, 0.0)], 0.0022, legs, n=3)
        b.face([(sx * 0.009, -0.003, 0.001), (sx * 0.004, -0.022, 0.001), (sx * 0.014, -0.022, 0.001)], legs)
    return b.done(0, fix=False)


objs = [letterbox(), bike(), wheelbarrow(), rake(), watering_can(), table(), chair(),
        parasol(), lounger(), barbecue(), mower(), dock(), planter(), box_pot(), bird()]
for o in objs:
    o.data.calc_loop_triangles()
    print(f"{o.name}: {len(o.data.loop_triangles)} triangles")

bpy.ops.object.select_all(action="DESELECT")
for o in objs:
    o.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_cameras=False, export_lights=False)

# ---------------------------------------------------------------- preview: everything in two rows
if PREVIEW:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 1800, 900
    world = bpy.data.worlds.new("Sky")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.6, 0.66, 0.75, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.9
    scene.world = world
    spots = {"Letterbox": (0.9, 0, 0), "Bike": (2.0, 0.3, 0), "Wheelbarrow": (3.4, 0, 0), "Rake": (4.3, 0.3, 0),
             "WateringCan": (4.9, 0, 0), "Table": (0.5, 3.5, 0), "Chair": (0.5, 2.8, 0),
             "Parasol": (0.5, 3.5, 0), "Lounger": (2.8, 3.5, 0), "Barbecue": (4.2, 3.2, 0), "Mower": (5.4, 3.0, 0), "Dock": (5.4, 3.7, 0),
             "Planter": (6.5, 3.4, 0), "BoxPot": (7.3, 3.4, 0), "Bird": (5.0, 2.4, 0)}
    for o in objs:
        o.location = spots[o.name]
        if o.name == "Bird":
            o.scale = (4, 4, 4)
    bpy.ops.mesh.primitive_plane_add(size=40, location=(3.5, 2, 0))
    bpy.context.active_object.data.materials.append(mat("Lawn", "#5f7a3c", 0.9))
    bpy.ops.object.light_add(type="SUN", location=(0, 0, 5))
    sun = bpy.context.active_object
    sun.data.energy = 4
    sun.rotation_euler = (math.radians(45), math.radians(10), math.radians(-35))
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    os.makedirs(PREVIEW, exist_ok=True)
    for label, at, target, lens in (("life_row", (3.6, -7.0, 3.2), (3.6, 1.5, 0.6), 28),
                                    ("life_close", (2.0, -2.8, 1.5), (2.0, 0.2, 0.5), 32),
                                    ("life_back", (3.0, 0.2, 2.2), (3.0, 3.6, 0.6), 26),
                                    ("life_bird", (5.0, 1.6, 0.5), (5.0, 2.4, 0.3), 50)):
        cam.location = at
        cam.data.lens = lens
        cam.rotation_euler = (Vector(target) - Vector(at)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(PREVIEW, f"{label}.png")
        bpy.ops.render.render(write_still=True)
