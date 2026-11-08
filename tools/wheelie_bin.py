"""Build the household waste containers put out along the streets of Smetlede, in Blender.

Run (Blender 5, no window):
  blender -b -P tools/wheelie_bin.py -- <out.glb> [preview_dir]

  e.g. blender -b -P tools/wheelie_bin.py -- web/public/models/wheelie-bins.glb

Lede collects its household waste through ILvA, the waste authority of the Land van Aalst. Every
household has one grey container for the residual waste and one green one for GFT (garden, fruit
and vegetable waste), each with a chip by which the truck weighs it (gewogen diftar). Paper goes
out in boxes or bundles and PMD in blue bags, so those are not containers. The sizes and the
outside measures (height x width x depth) are the ones ILvA publishes:

  240 L  1.06 x 0.58 x 0.72 m   residual waste only
  140 L  1.08 x 0.51 x 0.56 m   residual waste or GFT
   40 L  0.51 x 0.50 x 0.34 m   residual waste or GFT, a portable one for small homes

  https://www.ilva.be/gewogendiftar/formaten-containers/  (sizes and measures)
  https://www.ilva.be/restfractie  and  https://www.ilva.be/gft  (colours, putting them out)

The 240 L and 140 L are two-wheeled containers to EN 840-1. The details the authority does not
give are taken from the published data sheets of such containers (no maker named on the models):
wheels of 200 mm on a steel axle at the back (Craemer MGBneo 240 data sheet; Contenur C240 and
C140 data sheets), the comb that the truck's lifter takes under the rim on the handle's side, a
lid hinged over that side that opens 270 degrees, a recess for the chip, and feet at the front.
The body tapers towards its foot, so the empty ones stack, and has upright ribs on its sides.
The 40 L has no wheels: ILvA calls it "draagbaar" (portable); it has a grip on the handle's side.

No logo, no sticker, no lettering: the chip's recess is a plain round boss.

One GLB with one object per size, Bin240, Bin140 and Bin40, each standing on its origin (its
foot's middle) with its handle side towards +z in the GLB (Blender -Y), the side ILvA asks to
turn to the street. The body and lid are the material Paint (white): the game tints each
container (web/src/world/wheelieBins.ts) grey or green; the wheels, hubs and axle keep theirs.
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
PREVIEW = argv[1] if len(argv) > 1 else ""

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)

# The tints the game gives them (web/src/world/wheelieBins.ts), here for the previews.
GREY = "#50565b"
GREEN = "#3d6b39"

# The published outside measures (m): height, width, depth.
SIZES = {
    "Bin240": (1.06, 0.58, 0.72),
    "Bin140": (1.08, 0.51, 0.56),
    "Bin40": (0.51, 0.50, 0.34),
}
WHEEL_R = 0.10   # 200 mm wheels (EN 840 two-wheeled containers)
WHEEL_W = 0.045  # the tyre's width
AXLE_R = 0.0125  # a 25 mm steel axle


def srgb(h):
    """'#rrggbb' to linear RGB, as the Principled BSDF (and glTF) expect."""
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


_mats = {}


def mat(name, hexcol, rough=0.5, metal=0.0):
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


PAINT = mat("Paint", "#ffffff", 0.5)    # HDPE, satin: the game tints it per container
TYRE = mat("Tyre", "#1b1b1b", 0.85)     # solid rubber
HUB = mat("Hub", "#303234", 0.55)       # the wheel's plastic centre
STEEL = mat("Steel", "#8e9398", 0.35, 0.8)


class Builder:
    """Collects faces (with a material each) for one object."""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.mats = []

    def mi(self, m):
        if m not in self.mats:
            self.mats.append(m)
        return self.mats.index(m)

    def face(self, pts, m):
        f = self.bm.faces.new([self.bm.verts.new(tuple(p)) for p in pts])
        f.material_index = self.mi(m)
        return f

    def loft(self, rings, m, bottom=True, top=True):
        """Closed rings of the same length stacked into a shell, capped at either end."""
        n = len(rings[0])
        vs = [[self.bm.verts.new(tuple(p)) for p in r] for r in rings]
        for i in range(len(vs) - 1):
            for j in range(n):
                k = (j + 1) % n
                f = self.bm.faces.new([vs[i][j], vs[i][k], vs[i + 1][k], vs[i + 1][j]])
                f.material_index = self.mi(m)
        if bottom:
            self.bm.faces.new(list(reversed(vs[0]))).material_index = self.mi(m)
        if top:
            self.bm.faces.new(vs[-1]).material_index = self.mi(m)

    def box(self, x0, x1, y0, y1, z0, z1, m):
        self.hexa([(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0)], [(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)], m)

    def hexa(self, lo, hi, m):
        """A six-sided block from its bottom four corners and its top four (either may lean)."""
        self.loft([lo, hi], m)

    def cylinder_x(self, cx, cy, cz, r, x0, x1, m, segs=12, bevel=0.0):
        """A cylinder along X from x0 to x1 (a wheel, the axle, the handle bar); `bevel` rounds its rims."""
        def ring(x, rr):
            return [(x, cy + rr * math.cos(2 * math.pi * j / segs), cz + rr * math.sin(2 * math.pi * j / segs)) for j in range(segs)]
        if bevel:
            rings = [ring(x0, r - bevel), ring(x0 + bevel, r), ring(x1 - bevel, r), ring(x1, r - bevel)]
        else:
            rings = [ring(x0, r), ring(x1, r)]
        self.loft(rings, m)

    def cylinder_y(self, cx, cz, r, y0, y1, m, segs=10):
        """A short cylinder along Y (the chip's boss)."""
        rings = [[(cx + r * math.cos(2 * math.pi * j / segs), y, cz + r * math.sin(2 * math.pi * j / segs)) for j in range(segs)] for y in (y0, y1)]
        self.loft(rings, m)

    def done(self, smooth=35):
        bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=1e-6)
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


def rounded(xh, y0, y1, z, r_back, r_front, segs=3):
    """A rounded rectangle at height z: x from -xh to xh, y from y0 (the handle's side) to y1, counter-clockwise from above."""
    pts = []
    corners = ((xh - r_front, y1 - r_front, r_front, 0.0), (-xh + r_front, y1 - r_front, r_front, 0.5 * math.pi),
               (-xh + r_back, y0 + r_back, r_back, math.pi), (xh - r_back, y0 + r_back, r_back, 1.5 * math.pi))
    for cx, cy, r, a0 in corners:
        for k in range(segs + 1):
            a = a0 + 0.5 * math.pi * k / segs
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a), z))
    return pts


class Body:
    """A tapered body's outline: rows of (z, half width, back y, front y), straight between them."""

    def __init__(self, rows):
        self.rows = rows

    def at(self, z):
        rows = self.rows
        for (z0, *a), (z1, *b) in zip(rows, rows[1:]):
            if z0 <= z <= z1:
                t = (z - z0) / (z1 - z0) if z1 > z0 else 0
                return [u + (v - u) * t for u, v in zip(a, b)]
        return list(rows[0][1:] if z < rows[0][0] else rows[-1][1:])


def wheeled(name):
    """A two-wheeled container to EN 840-1 (the 240 L and the 140 L), from its published H x W x D."""
    H, W, D = SIZES[name]
    big = name == "Bin240"
    b = Builder(name)
    yh = -D / 2 + 0.017               # the handle bar's middle: the back of everything
    zh = H - 0.03
    ylb = -D / 2 + 0.055              # the lid's back edge, over the hinge
    zr = H - 0.035                    # the body's rim, inside the lid
    yax = -D / 2 + WHEEL_R + 0.03     # the axle, under the back wall
    side_in, front_in = (0.05, 0.07) if big else (0.045, 0.055)
    xr = W / 2 - 0.008                # the rim's half width
    yrb, yrf = ylb + 0.012, D / 2 - 0.018
    ybb = yax - 0.03                  # the back of the foot, just in front of the axle
    body = Body([
        (0.04, xr - side_in, ybb, yrf - front_in),
        (zr - 0.075, xr - 0.012, yrb + 0.012, yrf - 0.012),  # up the tapered wall to under the collar
        (zr - 0.075, xr, yrb, yrf),                          # the collar steps out
        (zr, xr, yrb, yrf),
    ])
    rings = []
    # The foot: its floor, then a rounded edge into the wall.
    fx, fb, ff = body.at(0.04)
    rings.append(rounded(fx - 0.02, fb + 0.02, ff - 0.02, 0.025, 0.03, 0.04))
    for z in (0.04, 0.30, zr - 0.075):
        x, y0, y1 = body.at(z - 1e-6 if z == zr - 0.075 else z)
        rings.append(rounded(x, y0, y1, z, 0.03, 0.05))
    rings.append(rounded(xr, yrb, yrf, zr - 0.072, 0.03, 0.05))
    rings.append(rounded(xr, yrb, yrf, zr, 0.03, 0.05))
    b.loft(rings, PAINT)

    # Upright ribs down each side, two per side, standing 8 mm off the tapered wall.
    for frac in (0.3, 0.68):
        for s in (-1, 1):
            z0, z1 = 0.16, zr - 0.09
            lo, hi = body.at(z0), body.at(z1)
            y_lo, y_hi = lo[1] + (lo[2] - lo[1]) * frac, hi[1] + (hi[2] - hi[1]) * frac
            xi_lo, xi_hi = lo[0] - 0.004, hi[0] - 0.004
            xo_lo, xo_hi = lo[0] + 0.008, hi[0] + 0.008
            q = lambda xi, xo, y, z: [(s * xi, y - 0.011, z), (s * xo, y - 0.011, z), (s * xo, y + 0.011, z), (s * xi, y + 0.011, z)]
            lo4, hi4 = q(xi_lo, xo_lo, y_lo, z0), q(xi_hi, xo_hi, y_hi, z1)
            if s < 0:
                lo4, hi4 = lo4[::-1], hi4[::-1]
            b.hexa(lo4, hi4, PAINT)

    # The lid: a skirt round the rim, a bevelled top a little crowned, the hinge's knuckles at the back,
    # a grip lip at the front.
    ylf = D / 2 - 0.012
    b.loft([
        rounded(W / 2, ylb, ylf, H - 0.05, 0.012, 0.05),
        rounded(W / 2, ylb, ylf, H - 0.01, 0.012, 0.05),
        rounded(W / 2 - 0.03, ylb + 0.015, ylf - 0.03, H, 0.01, 0.03),
    ], PAINT)
    b.box(-0.16, 0.16, ylf - 0.02, D / 2, H - 0.062, H - 0.03, PAINT)
    for s in (-1, 1):
        b.cylinder_x(0, ylb + 0.004, H - 0.03, 0.014, s * 0.09, s * 0.17, PAINT, segs=8)

    # The handle: a round bar on two arms that grow out of the body's back corners.
    xa = W / 2 - 0.035
    b.cylinder_x(0, yh, zh, 0.017, -xa, xa, PAINT, segs=8)
    for s in (-1, 1):
        x0, x1 = sorted((s * (W / 2 - 0.075), s * (W / 2 - 0.022)))
        b.hexa([(x0, yh - 0.01, zh - 0.025), (x1, yh - 0.01, zh - 0.025), (x1, yrb + 0.03, zh - 0.12), (x0, yrb + 0.03, zh - 0.12)],
               [(x0, yh - 0.01, zh + 0.012), (x1, yh - 0.01, zh + 0.012), (x1, yrb + 0.03, zh - 0.02), (x0, yrb + 0.03, zh - 0.02)], PAINT)

    # The comb under the collar on the handle's side: a ledge the lifter takes, with gussets under it.
    zc = zr - 0.075
    yw = body.at(zc - 0.06)[1]
    xc = W / 2 - 0.1
    b.box(-xc, xc, yw - 0.032, yw + 0.01, zc - 0.03, zc, PAINT)
    for k in range(7):
        x = -xc + 0.02 + (2 * xc - 0.04) * k / 6
        yb = body.at(zc - 0.09)[1]
        b.hexa([(x - 0.007, yb - 0.004, zc - 0.09), (x + 0.007, yb - 0.004, zc - 0.09), (x + 0.007, yb + 0.01, zc - 0.09), (x - 0.007, yb + 0.01, zc - 0.09)],
               [(x - 0.007, yw - 0.03, zc - 0.03), (x + 0.007, yw - 0.03, zc - 0.03), (x + 0.007, yw + 0.01, zc - 0.03), (x - 0.007, yw + 0.01, zc - 0.03)], PAINT)
    # The chip's recess: a round boss on the back wall under the comb.
    zchip = zc - 0.17
    ychip = body.at(zchip)[1]
    b.cylinder_y(0, zchip, 0.024, ychip - 0.012, ychip + 0.01, PAINT)

    # Wheels and axle at the back, the axle's housing moulded across under the back wall.
    xw = W / 2 - 0.03
    b.box(-(xw - WHEEL_W / 2 - 0.003), xw - WHEEL_W / 2 - 0.003, yax - 0.04, yax + 0.045, WHEEL_R - 0.035, WHEEL_R + 0.06, PAINT)
    b.cylinder_x(0, yax, WHEEL_R, AXLE_R, -(xw + WHEEL_W / 2 + 0.006), xw + WHEEL_W / 2 + 0.006, STEEL, segs=6)
    for s in (-1, 1):
        x0, x1 = sorted((s * (xw - WHEEL_W / 2), s * (xw + WHEEL_W / 2)))
        b.cylinder_x(0, yax, WHEEL_R, WHEEL_R, x0, x1, TYRE, segs=14, bevel=0.008)
        xo = s * (xw + WHEEL_W / 2)
        h0, h1 = sorted((xo - s * 0.004, xo + s * 0.003))
        b.cylinder_x(0, yax, WHEEL_R, 0.06, h0, h1, HUB, segs=10)

    # Two feet under the front, so it stands level on its wheels and them.
    fx, _, ff = body.at(0.04)
    for s in (-1, 1):
        x0, x1 = sorted((s * (fx - 0.09), s * (fx - 0.02)))
        b.box(x0, x1, ff - 0.11, ff - 0.025, 0.0, 0.045, PAINT)
    return b.done()


def portable():
    """The 40 L: no wheels, a grip on the handle's side, a lid hinged under it, the chip's boss, four feet."""
    H, W, D = SIZES["Bin40"]
    b = Builder("Bin40")
    zr = H - 0.03
    xr = W / 2 - 0.008
    yrb, yrf = -D / 2 + 0.035, D / 2 - 0.012
    body = Body([(0.02, xr - 0.03, yrb + 0.02, yrf - 0.025), (zr - 0.05, xr - 0.006, yrb + 0.004, yrf - 0.006), (zr - 0.05, xr, yrb, yrf), (zr, xr, yrb, yrf)])
    rings = []
    x, y0, y1 = body.at(0.02)
    rings.append(rounded(x - 0.015, y0 + 0.015, y1 - 0.015, 0.01, 0.03, 0.03))
    for z in (0.02, zr - 0.05 - 1e-6):
        x, y0, y1 = body.at(z)
        rings.append(rounded(x, y0, y1, max(z, 0.02), 0.04, 0.04))
    rings.append(rounded(xr, yrb, yrf, zr - 0.047, 0.04, 0.04))
    rings.append(rounded(xr, yrb, yrf, zr, 0.04, 0.04))
    b.loft(rings, PAINT)
    # The lid.
    ylb = -D / 2 + 0.03
    b.loft([rounded(W / 2, ylb, D / 2 - 0.006, H - 0.04, 0.02, 0.04), rounded(W / 2, ylb, D / 2 - 0.006, H - 0.008, 0.02, 0.04),
            rounded(W / 2 - 0.025, ylb + 0.012, D / 2 - 0.03, H, 0.015, 0.025)], PAINT)
    b.box(-0.1, 0.1, D / 2 - 0.016, D / 2, H - 0.05, H - 0.025, PAINT)
    # The grip: a bar along the handle's side, under the lid's hinge, on two short arms.
    yg = -D / 2 + 0.013
    zg = H - 0.06
    b.cylinder_x(0, yg, zg, 0.013, -(W / 2 - 0.07), W / 2 - 0.07, PAINT, segs=8)
    for s in (-1, 1):
        x0, x1 = sorted((s * (W / 2 - 0.09), s * (W / 2 - 0.055)))
        b.box(x0, x1, yg - 0.008, yrb + 0.02, zg - 0.02, zg + 0.015, PAINT)
    # Side ribs, a hand hold under the front to tip it, the chip's boss.
    for s in (-1, 1):
        for frac in (0.35, 0.65):
            lo, hi = body.at(0.06), body.at(zr - 0.07)
            ylo, yhi = lo[1] + (lo[2] - lo[1]) * frac, hi[1] + (hi[2] - hi[1]) * frac
            q = lambda xi, xo, y, z: [(s * xi, y - 0.01, z), (s * xo, y - 0.01, z), (s * xo, y + 0.01, z), (s * xi, y + 0.01, z)]
            lo4, hi4 = q(lo[0] - 0.004, lo[0] + 0.007, ylo, 0.06), q(hi[0] - 0.004, hi[0] + 0.007, yhi, zr - 0.07)
            if s < 0:
                lo4, hi4 = lo4[::-1], hi4[::-1]
            b.hexa(lo4, hi4, PAINT)
    yf = body.at(0.08)[2]
    b.box(-0.12, 0.12, yf - 0.01, yf + 0.018, 0.07, 0.095, PAINT)
    ychip = body.at(zr - 0.16)[1]
    b.cylinder_y(0, zr - 0.16, 0.022, ychip - 0.01, ychip + 0.01, PAINT)
    x, y0, y1 = body.at(0.02)
    for sx in (-1, 1):
        for yy in (y0 + 0.03, y1 - 0.07):
            x0, x1 = sorted((sx * (x - 0.07), sx * (x - 0.02)))
            b.box(x0, x1, yy, yy + 0.04, 0.0, 0.022, PAINT)
    return b.done()


objs = [wheeled("Bin240"), wheeled("Bin140"), portable()]
for o in objs:
    o.data.calc_loop_triangles()
    lo = Vector([min(v.co[i] for v in o.data.vertices) for i in range(3)])
    hi = Vector([max(v.co[i] for v in o.data.vertices) for i in range(3)])
    size = hi - lo
    H, W, D = SIZES[o.name]
    print(f"{o.name}: {len(o.data.loop_triangles)} triangles, model {size.z * 1000:.0f} x {size.x * 1000:.0f} x {size.y * 1000:.0f} mm "
          f"(H x W x D), published {H * 1000:.0f} x {W * 1000:.0f} x {D * 1000:.0f}")

bpy.ops.object.select_all(action="DESELECT")
for o in objs:
    o.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=False, export_yup=True,
                          export_cameras=False, export_lights=False, export_extras=False)

# ---------------------------------------------------------------- preview: each beside its published measures
if PREVIEW:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 960, 420
    world = bpy.data.worlds.new("Sky")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.75, 0.78, 0.82, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.8
    scene.world = world
    bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, 0))
    bpy.context.active_object.data.materials.append(mat("Ground", "#9a9a94", 0.9))
    bpy.ops.object.light_add(type="SUN", location=(0, 0, 5))
    sun = bpy.context.active_object
    sun.data.energy = 3.5
    sun.rotation_euler = (math.radians(35), math.radians(15), math.radians(-30))
    red = mat("Measure", "#d01818", 0.6)
    red.node_tree.nodes["Principled BSDF"].inputs["Emission Color"].default_value = (*srgb("#d01818"), 1)
    red.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 1.0
    grey, green = mat("PaintGrey", GREY, 0.5), mat("PaintGreen", GREEN, 0.5)

    def label(text, at, size=0.05, rot=(math.radians(90), 0, 0)):
        cu = bpy.data.curves.new("Label", type="FONT")
        cu.body = text
        cu.size = size
        cu.align_x = "CENTER"
        ob = bpy.data.objects.new("Label", cu)
        ob.location = at
        ob.rotation_euler = rot
        ob.data.materials.append(red)
        scene.collection.objects.link(ob)
        return ob

    def edge(a, b, r=0.003):
        a, b = Vector(a), Vector(b)
        bpy.ops.mesh.primitive_cylinder_add(vertices=6, radius=r, depth=(b - a).length, location=(a + b) / 2)
        ob = bpy.context.active_object
        ob.rotation_euler = (b - a).to_track_quat("Z", "Y").to_euler()
        ob.data.materials.append(red)
        return ob

    def frame(x, H, W, D):
        """The published box's twelve edges round a container standing at x."""
        cs = [(x + sx * W / 2, sy * D / 2, z) for z in (0, H) for sy in (-1, 1) for sx in (-1, 1)]
        return [edge(cs[i], cs[j]) for i, j in ((0, 1), (2, 3), (4, 5), (6, 7), (0, 2), (1, 3), (4, 6), (5, 7), (0, 4), (1, 5), (2, 6), (3, 7))]

    # Side by side: 240 L grey, 140 L grey, 140 L green, 40 L grey, 40 L green; each in its published box.
    shown = []
    x = 0.0
    for name, paint in (("Bin240", grey), ("Bin140", grey), ("Bin140", green), ("Bin40", grey), ("Bin40", green)):
        H, W, D = SIZES[name]
        src = bpy.data.objects[name]
        ob = src.copy()
        ob.data = src.data.copy()
        ob.data.materials[ob.data.materials.find("Paint")] = paint
        scene.collection.objects.link(ob)
        x += W / 2
        ob.location = (x, 0, 0)
        parts = frame(x, H, W, D)
        parts.append(label(f"{name[3:]} L", (x, -D / 2 - 0.02, H + 0.1), 0.06))
        parts.append(label(f"H {H * 1000:.0f}  W {W * 1000:.0f}  D {D * 1000:.0f} mm", (x, -D / 2 - 0.02, H + 0.04), 0.03))
        shown.append((name, x, ob, parts))
        x += W / 2 + 0.2
    for o in objs:
        o.hide_render = True
    mid = x / 2 - 0.1
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    os.makedirs(PREVIEW, exist_ok=True)
    for label_, at, target, ortho in (("bins_street_side", (mid, -6, 0.65), (mid, 0, 0.65), 3.3),
                                      ("bins_three", (mid + 2.6, -4.2, 2.3), (mid, 0, 0.45), 0),
                                      ("bins_back", (mid - 2.2, 4.2, 1.6), (mid, 0, 0.45), 0)):
        cam.location = at
        cam.data.type = "ORTHO" if ortho else "PERSP"
        if ortho:
            cam.data.ortho_scale = ortho
        cam.data.lens = 40
        cam.rotation_euler = (Vector(target) - Vector(at)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(PREVIEW, f"{label_}.png")
        bpy.ops.render.render(write_still=True)
    # Each size from the side, orthographic, in its published box (the handle's side on the left).
    done = set()
    for name, x, ob, parts in shown:
        if name in done:
            continue
        done.add(name)
        for other in shown:
            for o in [other[2], *other[3]]:
                o.hide_render = other[2] is not ob
        H, W, D = SIZES[name]
        cam.data.type = "ORTHO"
        cam.data.ortho_scale = max(H, D) * 1.5
        cam.location = (x + 8, 0, H / 2 + 0.06)
        cam.rotation_euler = (Vector((x, 0, H / 2 + 0.06)) - cam.location).to_track_quat("-Z", "Y").to_euler()
        scene.render.resolution_x, scene.render.resolution_y = 520, 520
        scene.render.filepath = os.path.join(PREVIEW, f"{name.lower()}_side.png")
        bpy.ops.render.render(write_still=True)
