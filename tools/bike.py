"""Build the city bike you can ride (web/src/world/bike.ts) in Blender, from a city bike's usual sizes.

Run (Blender 5, no window):
  blender -b -P tools/bike.py -- <out.glb> [preview_dir]

  e.g. blender -b -P tools/bike.py -- web/public/models/bike.glb

A plain Flemish city bike, no brand, no logos: 28 inch wheels (622 mm rims with 40 mm tyres, 0.70 m
across), 1.12 m between the axles, the bottom bracket 0.29 m up, a 70 degree seat tube and a 68
degree head tube, 170 mm cranks, an upright swept-back handlebar, a sprung saddle, mudguards, a
chain guard, a rear rack with its light, a lamp on the fork and a bell on the left of the bars.

The parts that move are objects of their own, each with its origin where it turns, so the game can
draw every bike in the village with one draw per part (instanced) and move them:
- FramePaint, Frame: the frame's tubes (painted per bike), and what stays with it (saddle, rack,
  mudguard, chain guard, rear light);
- ForkPaint, Steer: the fork (painted), and the stem, bars, grips, bell, lamp and front mudguard.
  Both turn about the steering axis: their origin is on it, their local +Z (the GLB's +Y) along it;
- WheelF, WheelR: one wheel (tyre, rim, spokes, hub), its origin at the axle, rolling about X;
- Crank: the chainring and both arms, origin at the bottom bracket, turning about X;
- PedalL, PedalR: one pedal, its origin on the spindle (the game keeps them level);
- Stand: the kickstand, origin at its pivot, folded up while riding.
Empties mark where the rider sits and holds on: Saddle (the top of the saddle), GripL, GripR.

The bike's origin is on the ground midway between the tyres' contact points. Its front is Blender's
+Y, which the GLB (three.js axes) makes -z, as the cars. Materials name the colours; the game paints
them on the vertices (Paint white, tinted per bike).
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
PREVIEW = argv[1] if len(argv) > 1 else ""

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)

# ---------------------------------------------------------------- sizes (m)
R = 0.349                    # tyre's outer radius: 622 mm rim, 38-40 mm tyre
RIM = 0.311                  # the rim's bead seat
WB = 1.12                    # wheelbase
RA = Vector((0, -WB / 2, R))  # rear axle
FA = Vector((0, WB / 2, R))   # front axle
BB = Vector((0, -0.11, 0.29))  # bottom bracket: 450 mm chainstays
SEAT = math.radians(70)
HEAD = math.radians(68)
CRANK = 0.17
OFFSET = 0.045               # fork rake
U_SEAT = Vector((0, -math.cos(SEAT), math.sin(SEAT)))  # up the seat tube
U_HEAD = Vector((0, -math.cos(HEAD), math.sin(HEAD)))  # up the steering axis
N_HEAD = Vector((0, math.sin(HEAD), math.cos(HEAD)))   # its normal, forwards
AXIS0 = FA - N_HEAD * OFFSET  # the steering axis passes this far behind the front axle


def on_axis(z):
    """The point of the steering axis at height z."""
    return AXIS0 + U_HEAD * ((z - AXIS0.z) / U_HEAD.z)


HT_BOT, HT_TOP = on_axis(0.62), on_axis(0.78)
ST_TOP = BB + U_SEAT * 0.55
SADDLE = BB + U_SEAT * 0.70 + Vector((0, 0, 0.065))  # the seat's top, over the post
STEM = on_axis(0.93)
GRIP_Y, GRIP_Z, GRIP_X = STEM.y - 0.2, 1.0, 0.29


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


PAINT = mat("Paint", "#ffffff", 0.35, 0.2)  # white: the game tints it per bike
TYRE = mat("Tyre", "#161616", 0.9)
METAL = mat("Metal", "#b9bcc0", 0.3, 0.9)
DARK = mat("Dark", "#202022", 0.55, 0.2)
SEATM = mat("Saddle", "#2e2219", 0.6)
LAMP = mat("Lamp", "#f2efe0", 0.15)
RED = mat("Reflector", "#9c1414", 0.3)
GUARD = mat("Guard", "#2a2c2f", 0.4, 0.4)


class Builder:
    """Collects faces (with a material each) for one object, in the bike's space."""

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

    def grid(self, rows, m, closed=False):
        n = len(rows[0])
        vs = [[self.bm.verts.new(tuple(p)) for p in r] for r in rows]
        for i in range(len(rows) - 1):
            for j in range(n if closed else n - 1):
                k = (j + 1) % n
                f = self.bm.faces.new([vs[i][j], vs[i][k], vs[i + 1][k], vs[i + 1][j]])
                f.material_index = self.mi(m)
        return vs

    def cap(self, row, m, flip=False):
        f = self.bm.faces.new(list(reversed(row)) if flip else row)
        f.material_index = self.mi(m)

    def tube(self, pts, r, m, n=6, cap=True):
        """A round tube along a polyline (radius r)."""
        pts = [Vector(p) for p in pts]
        rows = []
        for i, p in enumerate(pts):
            d = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
            side = d.cross(Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))).normalized()
            up = side.cross(d).normalized()
            rows.append([p + r * (math.cos(2 * math.pi * j / n) * side - math.sin(2 * math.pi * j / n) * up) for j in range(n)])
        vs = self.grid(rows, m, closed=True)
        if cap:
            self.cap(vs[0], m, True)
            self.cap(vs[-1], m)

    def ring(self, centre, radius, r, m, n=6, segs=24, a0=0.0, a1=2 * math.pi, flat=None):
        """A tube bent into a circle (or an arc from a0 to a1, 0 the front, going up) in the bike's YZ plane.
        flat: (width, depth) for a flat strip (a mudguard) instead of a round tube."""
        c = Vector(centre)
        full = abs(a1 - a0 - 2 * math.pi) < 1e-6
        k = segs if full else segs + 1
        rows = []
        for i in range(k):
            a = a0 + (a1 - a0) * i / segs
            out = Vector((0, math.cos(a), math.sin(a)))
            p = c + radius * out
            if flat:
                w, d = flat
                # A shallow channel: the middle further out than the edges.
                rows.append([p + out * (d if abs(x) < w * 0.3 else 0) + Vector((x, 0, 0)) for x in (-w / 2, -w * 0.25, w * 0.25, w / 2)])
            else:
                rows.append([p + r * (math.cos(2 * math.pi * j / n) * out + math.sin(2 * math.pi * j / n) * Vector((1, 0, 0))) for j in range(n)])
        if full:
            rows.append(rows[0])
        if flat:
            vs = self.grid(rows, m)
            # The underside, a few millimetres in, facing the wheel.
            self.grid([[p - (p - c).normalized() * 0.003 for p in reversed(row)] for row in rows], m)
            return vs
        return self.grid(rows, m, closed=True)

    def box(self, x0, x1, y0, y1, z0, z1, m):
        c = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
        for q in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
            self.face([c[i] for i in q], m)

    def disc(self, centre, r, x0, x1, m, segs=12):
        """A short cylinder along X (a hub, a lamp's lens)."""
        c = Vector(centre)
        rows = [[c + Vector((x, r * math.cos(2 * math.pi * j / segs), r * math.sin(2 * math.pi * j / segs))) for j in range(segs)] for x in (x0, x1)]
        vs = self.grid(rows, m, closed=True)
        self.cap(vs[0], m, True)
        self.cap(vs[-1], m)

    def done(self, origin=(0, 0, 0), rot=(0, 0, 0), smooth=40):
        """The object, with its origin at `origin` and turned by `rot` (Euler, radians); the points stay where they are."""
        bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=1e-6)
        bmesh.ops.recalc_face_normals(self.bm, faces=list(self.bm.faces))
        world = Matrix.Translation(Vector(origin)) @ Euler(rot).to_matrix().to_4x4()
        bmesh.ops.transform(self.bm, matrix=world.inverted(), verts=self.bm.verts)
        me = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(me)
        self.bm.free()
        for m in self.mats:
            me.materials.append(m)
        obj = bpy.data.objects.new(self.name, me)
        bpy.context.scene.collection.objects.link(obj)
        obj.location = origin
        obj.rotation_euler = rot
        if smooth:
            me.set_sharp_from_angle(angle=math.radians(smooth))
        return obj


def empty(name, at):
    e = bpy.data.objects.new(name, None)
    e.location = at
    bpy.context.scene.collection.objects.link(e)
    return e


# ---------------------------------------------------------------- the frame
def frame_paint():
    b = Builder("FramePaint")
    tt_back = BB + U_SEAT * 0.47
    b.tube([BB, ST_TOP], 0.016, PAINT, n=8)                                   # seat tube
    b.tube([BB, BB.lerp(HT_BOT, 0.5) + Vector((0, 0, 0.01)), HT_BOT], 0.02, PAINT, n=8)  # down tube
    b.tube([tt_back, HT_TOP + Vector((0, 0, -0.03))], 0.016, PAINT, n=8)      # top tube, sloping a little
    b.tube([HT_BOT - U_HEAD * 0.02, HT_TOP + U_HEAD * 0.01], 0.021, PAINT, n=10)  # head tube
    for sx in (-1, 1):
        drop = RA + Vector((sx * 0.065, 0, 0))
        b.tube([BB + Vector((sx * 0.02, 0, 0)), BB.lerp(drop, 0.5) + Vector((sx * 0.035, 0, 0)), drop], 0.0095, PAINT, n=6)  # chainstays
        b.tube([ST_TOP + Vector((sx * 0.014, 0.0, -0.03)), drop], 0.0085, PAINT, n=6)  # seat stays
    return b.done()


def frame_rest():
    b = Builder("Frame")
    # The seat post and the saddle: a wide sprung seat.
    b.tube([ST_TOP - U_SEAT * 0.01, BB + U_SEAT * 0.70], 0.0125, METAL, n=6)
    s = SADDLE
    rows = []
    for dz, k in ((-0.045, 0.85), (-0.012, 1.0), (0.0, 0.8)):
        row = []
        for j in range(12):
            a = 2 * math.pi * j / 12
            y = 0.13 * math.cos(a)                     # front (+) to back
            w = 0.035 + 0.075 * max(0.0, (0.06 - y) / 0.19)  # narrow nose, wide back
            row.append(s + Vector((w * math.sin(a) * k, y * k - 0.02, dz)))
        rows.append(row)
    vs = b.grid(rows, SEATM, closed=True)
    b.cap(vs[0], SEATM, True)
    b.cap(vs[-1], SEATM)
    for sx in (-1, 1):  # the springs under the back of the seat
        b.tube([s + Vector((sx * 0.05, -0.07, -0.045)), s + Vector((sx * 0.05, -0.07, -0.085))], 0.012, DARK, n=6)
    # The rear rack: two rails, cross bars, struts to the axle and a stay to the seat tube.
    top = RA.z + R + 0.07
    y0, y1 = ST_TOP.y - 0.04, RA.y - 0.24
    for sx in (-1, 1):
        b.tube([(sx * 0.075, y0, top), (sx * 0.075, y1, top), (sx * 0.075, y1 - 0.01, top - 0.04)], 0.0055, METAL, n=4)
        b.tube([(sx * 0.075, RA.y - 0.08, top), (sx * 0.068, RA.y, RA.z + 0.02)], 0.0055, METAL, n=4)
        b.tube([(sx * 0.075, RA.y + 0.12, top), (sx * 0.068, RA.y + 0.01, RA.z + 0.02)], 0.0055, METAL, n=4)
        b.tube([(sx * 0.075, y0, top), (sx * 0.02, ST_TOP.y + 0.01, ST_TOP.z - 0.05)], 0.005, METAL, n=4)
    for k in range(6):
        y = y0 - 0.04 - k * (y0 - y1 - 0.08) / 5
        b.tube([(-0.075, y, top), (0.075, y, top)], 0.0045, METAL, n=4)
    # The rear light under the rack's end, and a reflector.
    b.box(-0.045, 0.045, y1 - 0.035, y1 - 0.005, top - 0.075, top - 0.03, DARK)
    b.box(-0.04, 0.04, y1 - 0.04, y1 - 0.034, top - 0.07, top - 0.035, RED)
    # The rear mudguard round the back wheel, from behind the seat tube over the top to behind the wheel.
    b.ring(RA, R + 0.025, 0, GUARD, segs=14, a0=math.radians(40), a1=math.radians(200), flat=(0.055, 0.006))
    end = RA + (R + 0.03) * Vector((0, math.cos(math.radians(200)), math.sin(math.radians(200))))
    b.box(-0.025, 0.025, end.y - 0.006, end.y - 0.001, end.z - 0.03, end.z + 0.012, RED)
    # The chain guard on the right: a closed case from the chainring to the rear hub.
    gx = 0.052
    # Round the front of the chainring, along the chain, round the back of the rear sprocket.
    pts = [(BB.y + 0.115 * math.cos(math.pi / 2 - math.pi * i / 9), BB.z + 0.115 * math.sin(math.pi / 2 - math.pi * i / 9)) for i in range(10)]
    pts += [(RA.y - 0.05 * math.cos(math.pi / 2 - math.pi * i / 5), RA.z - 0.05 * math.sin(math.pi / 2 - math.pi * i / 5)) for i in range(6)]
    outer = [Vector((gx + 0.012, y, z)) for y, z in pts]
    inner = [Vector((gx, y, z)) for y, z in pts]
    vs = b.grid([inner, outer], GUARD, closed=True)
    b.cap(vs[1], GUARD)
    b.cap(vs[0], GUARD, True)
    # The chain under the guard's open lower edge, a dark strip.
    b.tube([BB + Vector((0.045, -0.02, -0.095)), RA + Vector((0.045, 0.03, -0.035))], 0.004, DARK, n=4)
    # The ring lock on the seat stays (Flanders' bikes all have one).
    b.ring(RA + Vector((0, 0.08, 0.13)), 0.07, 0.012, DARK, n=4, segs=10, a0=math.radians(100), a1=math.radians(280))
    return b.done()


# ---------------------------------------------------------------- the front: fork, bars, lamp
STEER_ORIGIN = HT_BOT
STEER_ROT = (math.pi / 2 - HEAD, 0, 0)  # turned about X: local +Z along the axis, (0, -cos, sin) of the head angle


def fork_paint():
    b = Builder("ForkPaint")
    crown = HT_BOT - U_HEAD * 0.035
    for sx in (-1, 1):
        drop = FA + Vector((sx * 0.05, 0, 0))
        mid = crown.lerp(drop, 0.55) + Vector((sx * 0.045, -0.006, 0))
        b.tube([crown + Vector((sx * 0.035, 0, 0)), mid, drop.lerp(mid, 0.25) + N_HEAD * 0.01, drop], 0.012, PAINT, n=6)
    b.tube([crown + Vector((-0.045, 0, 0)), crown + Vector((0.045, 0, 0))], 0.017, PAINT, n=6)
    return b.done(STEER_ORIGIN, STEER_ROT)


def steer():
    b = Builder("Steer")
    # The steerer up through the head tube, the stem, the swept-back bars and their grips.
    b.tube([HT_TOP + U_HEAD * 0.005, STEM], 0.014, METAL, n=6)
    b.tube([HT_TOP + U_HEAD * 0.0, HT_TOP + U_HEAD * 0.025], 0.02, DARK, n=8)  # the headset's top cup
    bar_mid = STEM + Vector((0, 0.035, 0.01))
    b.tube([STEM, bar_mid], 0.012, METAL, n=6)
    for sx in (-1, 1):
        grip0 = Vector((sx * GRIP_X, GRIP_Y + 0.05, GRIP_Z))
        b.tube([bar_mid, Vector((sx * 0.09, bar_mid.y, bar_mid.z)), Vector((sx * 0.22, bar_mid.y - 0.06, GRIP_Z + 0.005)), grip0], 0.011, METAL, n=6)
        b.tube([grip0, Vector((sx * (GRIP_X + 0.01), GRIP_Y - 0.06, GRIP_Z - 0.005))], 0.017, DARK, n=8)
        # A brake lever under each hand.
        b.tube([Vector((sx * (GRIP_X - 0.06), GRIP_Y + 0.04, GRIP_Z)), Vector((sx * (GRIP_X - 0.03), GRIP_Y - 0.06, GRIP_Z - 0.03))], 0.005, METAL, n=4)
    # The bell, on the left inside the grip.
    bell = Vector((-(GRIP_X - 0.1), GRIP_Y + 0.07, GRIP_Z + 0.03))
    rows = []
    for r, z in ((0.0, 0.025), (0.018, 0.022), (0.026, 0.008), (0.028, -0.004), (0.0, -0.004)):
        rows.append([bell + Vector((r * math.cos(2 * math.pi * j / 10), r * math.sin(2 * math.pi * j / 10), z)) for j in range(10)])
    b.grid(rows, METAL, closed=True)
    # The lamp on the front of the head tube, its lens forwards.
    lamp = HT_BOT + N_HEAD * 0.045 + U_HEAD * 0.03
    b.box(-0.03, 0.03, lamp.y - 0.04, lamp.y + 0.02, lamp.z - 0.028, lamp.z + 0.028, DARK)
    lens = [lamp + Vector((0.026 * math.cos(2 * math.pi * j / 10), 0.021, 0.024 * math.sin(2 * math.pi * j / 10))) for j in range(10)]
    vs = b.grid([lens, [p + Vector((0, 0.004, 0)) for p in lens]], LAMP, closed=True)
    b.cap(vs[1], LAMP)
    b.tube([HT_BOT - U_HEAD * 0.01, lamp + Vector((0, -0.03, 0))], 0.006, DARK, n=4)
    # The front mudguard over the front wheel, and its stays to the dropouts.
    b.ring(FA, R + 0.022, 0, GUARD, segs=12, a0=math.radians(-15), a1=math.radians(150), flat=(0.05, 0.005))
    for sx in (-1, 1):
        b.tube([FA + Vector((sx * 0.05, 0.005, 0)), FA + Vector((sx * 0.028, (R + 0.022) * math.cos(math.radians(-10)), (R + 0.022) * math.sin(math.radians(-10))))], 0.003, METAL, n=3)
    b.box(-0.02, 0.02, FA.y + (R + 0.026) * math.cos(math.radians(-15)), FA.y + (R + 0.026) * math.cos(math.radians(-15)) + 0.005,
          FA.z - 0.11, FA.z - 0.07, RED)  # a white-ish reflector on a city bike's guard is often red too
    return b.done(STEER_ORIGIN, STEER_ROT)


# ---------------------------------------------------------------- wheels, crank, pedals, stand
def wheel(name, at):
    b = Builder(name)
    c = Vector((0, 0, 0))
    b.ring(c, R - 0.019, 0.019, TYRE, n=6, segs=28)                      # the tyre
    b.ring(c, RIM, 0.007, METAL, n=4, segs=28)                           # the rim
    b.disc(c, 0.022, -0.04, 0.04, METAL, segs=8)                         # the hub
    for k in range(18):  # 36 spokes drawn as 18 crossing pairs, half from each flange
        a = 2 * math.pi * k / 18
        side = 0.032 if k % 2 else -0.032
        b.tube([Vector((side, 0.02 * math.cos(a), 0.02 * math.sin(a))),
                Vector((0, RIM * math.cos(a + 0.35 * (1 if k % 2 else -1)), RIM * math.sin(a + 0.35 * (1 if k % 2 else -1))))], 0.0016, METAL, n=3, cap=False)
    me = b.done(smooth=50)
    # Both wheels share the one mesh.
    obj = me
    obj.location = at
    return obj


def crank():
    b = Builder("Crank")
    b.ring(BB + Vector((0.048, 0, 0)), 0.1, 0.005, METAL, n=4, segs=20)        # the chainring
    for k in range(5):
        a = 2 * math.pi * k / 5
        b.tube([BB + Vector((0.048, 0, 0)), BB + Vector((0.048, 0.1 * math.cos(a), 0.1 * math.sin(a)))], 0.006, METAL, n=4)
    b.disc(BB, 0.022, -0.07, 0.07, METAL, segs=8)                               # the axle's cups
    # The right arm forwards and down, the left one opposite (the rest pose: arms along the bike).
    b.tube([BB + Vector((0.072, 0, 0)), BB + Vector((0.078, CRANK, 0))], 0.01, METAL, n=4)
    b.tube([BB + Vector((-0.072, 0, 0)), BB + Vector((-0.078, -CRANK, 0))], 0.01, METAL, n=4)
    return b.done(BB)


def pedal(name, sx):
    b = Builder(name)
    at = BB + Vector((sx * 0.13, sx * CRANK, 0))
    b.box(at.x - 0.045, at.x + 0.045, at.y - 0.035, at.y + 0.035, at.z - 0.012, at.z + 0.012, DARK)
    b.tube([at + Vector((-sx * 0.05, 0, 0)), at], 0.006, METAL, n=4)
    b.box(at.x - 0.03, at.x + 0.03, at.y - 0.037, at.y - 0.035, at.z - 0.008, at.z + 0.008, RED)
    return b.done(at)


def stand():
    b = Builder("Stand")
    pivot = BB + Vector((-0.05, -0.12, -0.005))
    # Down and out to the left: it holds the bike leaning 5 degrees on it.
    foot = Vector((-0.2, pivot.y - 0.05, 0.0))
    b.tube([pivot, foot], 0.008, METAL, n=5)
    b.box(foot.x - 0.02, foot.x + 0.02, foot.y - 0.025, foot.y + 0.025, 0.0, 0.006, METAL)
    return b.done(pivot)


objs = [frame_paint(), frame_rest(), fork_paint(), steer()]
wf = wheel("WheelF", FA)
wr = bpy.data.objects.new("WheelR", wf.data)
wr.location = RA
bpy.context.scene.collection.objects.link(wr)
objs += [wf, wr, crank(), pedal("PedalR", 1), pedal("PedalL", -1), stand()]
marks = [empty("Saddle", SADDLE), empty("GripL", (-GRIP_X, GRIP_Y, GRIP_Z)), empty("GripR", (GRIP_X, GRIP_Y, GRIP_Z))]
total = 0
for o in objs:
    o.data.calc_loop_triangles()
    total += len(o.data.loop_triangles)
    print(f"{o.name}: {len(o.data.loop_triangles)} triangles")
print(f"all: {total} triangles")

bpy.ops.object.select_all(action="DESELECT")
for o in objs + marks:
    o.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=False, export_yup=True,
                          export_cameras=False, export_lights=False, export_extras=False)

# ---------------------------------------------------------------- preview: a side view and a three-quarter view
if PREVIEW:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 900, 600
    world = bpy.data.worlds.new("Sky")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.6, 0.66, 0.75, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.9
    scene.world = world
    PAINT.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*srgb("#24452f"), 1)
    bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, 0))
    bpy.context.active_object.data.materials.append(mat("Ground", "#7a7a76", 0.9))
    bpy.ops.object.light_add(type="SUN", location=(0, 0, 5))
    sun = bpy.context.active_object
    sun.data.energy = 4
    sun.rotation_euler = (math.radians(40), math.radians(10), math.radians(-35))
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    os.makedirs(PREVIEW, exist_ok=True)
    for label, at, target, lens in (("bike_side", (3.2, 0.0, 0.7), (0, 0, 0.55), 40),
                                    ("bike_three", (2.0, 2.2, 1.6), (0, 0, 0.55), 35),
                                    ("bike_back", (-1.0, -2.6, 1.4), (0, 0, 0.6), 35)):
        cam.location = at
        cam.data.lens = lens
        cam.rotation_euler = (Vector(target) - Vector(at)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(PREVIEW, f"{label}.png")
        bpy.ops.render.render(write_still=True)
