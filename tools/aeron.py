"""Build the office chair (after the classic Herman Miller Aeron, size B, graphite) for the game in Blender.

Run (Blender 5, no window):
  blender -b -P tools/aeron.py -- <out.glb> [preview_dir]

Our own model, made from published sizes and checked against photos of the chair (Wikimedia Commons), so it
needs no licence; it carries no names or logos. Size B at a mid seat height of 0.46 m (range 0.41-0.52):
1.07 m tall, 0.68 m wide over the base, 0.67 m deep. The seat frame is 0.49 m wide and 0.46 m deep. The back
is 0.51 m wide at the shoulders and narrows to 0.26 m at the bottom. The arm pads are 0.67 m off the floor.

The back and the seat are woven panels (material Mesh) held in a frame. Each panel's outline is a polygon with
rounded corners. It is filled with rings shrinking to its middle and laid on a curved surface: the back bends
in plan and in profile, the seat is dished and rolls down at the front (the waterfall edge). The frame is a
section swept round the outline. A spine curves from the bottom of the back down under the seat into the tilt
mechanism and carries the loop arms. Below the seat are the gas cylinder in its shroud, a five-star base with
tapered legs and twin-wheel casters.

Output: one GLB with one object, Chair, and the materials Frame, Mesh and Black. glTF axes: +Y up, origin on
the floor in the middle of the base, the seat facing +Z (Blender -Y). The Mesh faces carry UVs that run 0..1
over each panel (u across, v up the back or from the front of the seat to the back) for a weave texture; Mesh
is double-sided. With preview_dir it also renders five views there.
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

R_TIP = 0.292  # base: from the middle to a caster's stem
AHEAD = 0.015  # the seat and back sit this far ahead of the column
FRAME, MESH, BLACK = 0, 1, 2
UP = Vector((0, 0, 1))


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


def smooth(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def spline(points, per=3):
    """Catmull-Rom through tuples of any length (position plus sizes), per samples a span."""
    p = [list(q) for q in points]
    p = [[2 * a - b for a, b in zip(p[0], p[1])]] + p + [[2 * a - b for a, b in zip(p[-1], p[-2])]]
    out = []
    for i in range(1, len(p) - 2):
        for k in range(per):
            t = k / per
            out.append(tuple(0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t**3)
                             for a, b, c, d in zip(p[i - 1], p[i], p[i + 1], p[i + 2])))
    out.append(tuple(p[-2]))
    return out


def squircle(w, h, n=12, e=4.0, bottom=None):
    """Rounded-rectangle section w x h (a superellipse; a flatter underside with bottom)."""
    pts = []
    for k in range(n):
        a = 2 * math.pi * (k + 0.5) / n
        c, s = math.cos(a), math.sin(a)
        eb = bottom if bottom and s < 0 else e
        pts.append((w / 2 * math.copysign(abs(c) ** (2 / eb), c), h / 2 * math.copysign(abs(s) ** (2 / eb), s)))
    return pts


def outline(half, n, cuts=4):
    """Closed outline from its right half (bottom middle up to top middle): corners rounded by corner cutting,
    then n points evenly spaced, counter-clockwise from the bottom middle."""
    pts = [Vector(p) for p in half] + [Vector((-x, y)) for x, y in reversed(half[1:-1])]
    for _ in range(cuts):
        pts = [q for a, b in zip(pts, pts[1:] + pts[:1]) for q in (a * 0.75 + b * 0.25, a * 0.25 + b * 0.75)]
    start = (pts[-1] + pts[0]) / 2
    path = [start] + pts + [start]
    lens = [(b - a).length for a, b in zip(path, path[1:])]
    total = sum(lens)
    out, i, run = [], 0, 0.0
    for j in range(n):
        s = total * j / n
        while run + lens[i] < s:
            run += lens[i]
            i += 1
        out.append(path[i].lerp(path[i + 1], (s - run) / lens[i]))
    return out


def normal_of(surf):
    """Unit normal of a surface (u, v) -> point: du x dv (the back's front, the seat's top)."""
    def n(p, e=1e-3):
        du = surf(p + Vector((e, 0))) - surf(p - Vector((e, 0)))
        dv = surf(p + Vector((0, e))) - surf(p - Vector((0, e)))
        return du.cross(dv).normalized()
    return n


def hexcol(h):
    """sRGB hex to the linear colour Blender (and glTF) store."""
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def material(name, color, rough, cull=True):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Roughness"].default_value = rough
    m.use_backface_culling = cull  # exported as glTF doubleSided = not cull
    return m


bpy.ops.wm.read_factory_settings(use_empty=True)
MATS = [material("Frame", hexcol("#2b2c2f"), 0.55), material("Mesh", hexcol("#1f2023"), 0.8, cull=False),
        material("Black", hexcol("#151515"), 0.6)]
PARTS = []


def emit(name, bm, mat=None, closed=True):
    """Turn a bmesh into an object with the three materials; closed parts get outward normals."""
    if mat is not None:
        for f in bm.faces:
            f.material_index = mat
    if closed:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if not bm.loops.layers.uv.keys():
        bm.loops.layers.uv.new("UVMap")
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in MATS:
        me.materials.append(m)
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    PARTS.append(obj)
    return obj


def tube(bm, stations, caps=True):
    """Loft rings: each station is (centre, x axis, y axis, section points)."""
    rings = [[bm.verts.new(c + ax * x + ay * y) for x, y in pts] for c, ax, ay, pts in stations]
    n = len(rings[0])
    for a, b in zip(rings, rings[1:]):
        for i in range(n):
            bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
    if caps:
        bm.faces.new(rings[0][::-1])
        bm.faces.new(rings[-1])


def transport(path, up):
    """Frames along a path that turn with it without twisting (parallel transport): (side, up) per point."""
    n = up.copy()
    out = []
    for i in range(len(path)):
        t = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
        n = (n - t * n.dot(t)).normalized()
        out.append((t.cross(n), n))
    return out


def lathe(bm, prof, seg, origin, axis):
    """Turned part: (radius, height) profile round an axis, closed at both ends."""
    axis = Vector(axis).normalized()
    u = axis.orthogonal().normalized()
    v = axis.cross(u)
    rings = [[bm.verts.new(Vector(origin) + axis * h + (u * math.cos(a) + v * math.sin(a)) * r)
              for a in (2 * math.pi * k / seg for k in range(seg))] for r, h in prof]
    for a, b in zip(rings, rings[1:]):
        for i in range(seg):
            bm.faces.new((a[i], a[(i + 1) % seg], b[(i + 1) % seg], b[i]))
    bm.faces.new(rings[0][::-1])
    bm.faces.new(rings[-1])


def box(name, centre, size, mat, bevel=0.0, segs=1, matrix=None):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=size, verts=bm.verts)
    if bevel:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=segs, profile=0.5, affect="EDGES")
    bmesh.ops.transform(bm, matrix=(matrix or Matrix()) @ Matrix.Translation(centre), verts=bm.verts)
    return emit(name, bm, mat)


def panel(name, ring, surf, sag=0.0, rings=(1.0, 0.8, 0.6, 0.4, 0.2)):
    """A woven panel inside an outline: rings shrinking to the middle, dished by sag; UVs 0..1 over its bounds."""
    normal = normal_of(surf)
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new("UVMap")
    c = sum(ring, Vector((0, 0))) / len(ring)
    lo = Vector((min(p.x for p in ring), min(p.y for p in ring)))
    size = Vector((max(p.x for p in ring), max(p.y for p in ring))) - lo
    uv = {}

    def vert(q, k):
        v = bm.verts.new(surf(q) - normal(q) * sag * (1 - k * k))
        uv[v] = ((q.x - lo.x) / size.x, (q.y - lo.y) / size.y)
        return v

    loops = [[vert(c + (p - c) * k, k) for p in ring] for k in rings]
    mid = vert(c, 0.0)
    n = len(ring)
    for a, b in zip(loops, loops[1:]):
        for i in range(n):
            bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
    for i in range(n):
        bm.faces.new((loops[-1][i], loops[-1][(i + 1) % n], mid))
    for f in bm.faces:
        for lp in f.loops:
            lp[uvl].uv = uv[lp.vert]
    return emit(name, bm, MESH, closed=False)


def rim(name, ring, surf, section):
    """The frame round a panel: a section (a out from the outline, b along the surface normal) swept round it."""
    normal = normal_of(surf)
    bm = bmesh.new()
    n = len(ring)
    loops = []
    for i, p in enumerate(ring):
        t = (ring[(i + 1) % n] - ring[i - 1]).normalized()
        out = Vector((t.y, -t.x))
        nrm = normal(p)
        loops.append([bm.verts.new(surf(p + out * a) + nrm * b) for a, b in section(p)])
    m = len(loops[0])
    for a, b in zip(loops, loops[1:] + loops[:1]):
        for j in range(m):
            bm.faces.new((a[j], a[(j + 1) % m], b[(j + 1) % m], b[j]))
    return emit(name, bm, FRAME)


# ---- The back: (x, z) on a surface leaning back above the lumbar curve and bent forward at the sides.
BACK_Y = curve([(0.40, 0.255), (0.50, 0.248), (0.58, 0.236), (0.66, 0.236), (0.74, 0.252), (0.84, 0.285),
                (0.94, 0.319), (1.02, 0.349), (1.10, 0.377)])
BACK_BOW = 0.7  # the sides come forward by BOW * x^2


def back_surf(p):
    return Vector((p.x, BACK_Y(p.y) - BACK_BOW * p.x * p.x, p.y))


# Wide shoulders with round corners and an arched top, drawn in to a narrow waist above the seat.
BACK = outline([(0, 0.50), (0.085, 0.50), (0.105, 0.508), (0.11, 0.54), (0.116, 0.58), (0.128, 0.62), (0.15, 0.665),
                (0.178, 0.715), (0.202, 0.78), (0.218, 0.85), (0.228, 0.92), (0.228, 0.96), (0.215, 1.005), (0.17, 1.035),
                (0.09, 1.048), (0, 1.05)], 72)
panel("BackMesh", BACK, back_surf)
rim("BackFrame", BACK, back_surf, lambda p: [(-0.005, 0.007), (0.010, 0.012), (0.022, 0.008), (0.027, -0.004),
                                             (0.024, -0.017), (0.012, -0.023), (0.0, -0.020), (-0.005, -0.008)])


# ---- The seat: (x, y) in plan, tipped back a little, the side rails raised, the front rolling down.
def seat_surf(p):
    return Vector((p.x, p.y, 0.4565 - 0.036 * p.y + 0.008 * (p.x / 0.21) ** 2 - 0.018 * smooth(-0.16, -0.24, p.y)))


SEAT = outline([(0, -0.225), (0.15, -0.226), (0.20, -0.21), (0.212, -0.165), (0.205, -0.06), (0.185, 0.06),
                (0.16, 0.135), (0.11, 0.168), (0, 0.172)], 64)


def seat_section(p):
    f = smooth(-0.10, -0.21, p.y)  # 1 at the front: the frame is wider there and rolls further down
    w, d = 0.026 + 0.014 * f, 0.026 + 0.026 * f
    return [(-0.006, 0.004), (0.004, 0.011), (0.55 * w, 0.012 - 0.006 * f), (0.88 * w, 0.004 - 0.25 * d),
            (w, -0.5 * d), (0.9 * w, -0.9 * d), (0.6 * w, -d), (0.2 * w, -0.024), (-0.006, -0.016)]


panel("SeatMesh", SEAT, seat_surf, sag=0.012)
rim("SeatFrame", SEAT, seat_surf, seat_section)

# ---- Lumbar pad: a curved band behind the mesh, between the frame's sides, taller in the middle.
bm = bmesh.new()
bn = normal_of(back_surf)
ZL = 0.68
stations = []
for i in range(13):
    x = -0.182 + 0.364 * i / 12
    q = Vector((x, ZL))
    tz = (back_surf(q + Vector((0, 1e-3))) - back_surf(q - Vector((0, 1e-3)))).normalized()
    h = 0.072 - 0.024 * (x / 0.182) ** 2
    stations.append((back_surf(q) - bn(q) * 0.017, bn(q), tz, squircle(0.012, h, 10, 3.0)))
tube(bm, stations)
emit("Lumbar", bm, BLACK)

# ---- Spine: a Y. Two branches from the frame's lower sides meet behind the seat; the stem curves down and
# forward into the mechanism.
X = Vector((1, 0, 0))


def swept(bm, ctrl, per, w, h, e=3.5, n=10):
    """A bar along a smooth path through ctrl points, its section w x h turning with it."""
    path = [Vector(p) for p in spline(ctrl, per)]
    tube(bm, [(c, ax, ay, squircle(w, h, n, e)) for c, (ax, ay) in zip(path, transport(path, X.cross(path[1] - path[0])))])


bm = bmesh.new()
path = [Vector((0, y, z)) for y, z in spline([(0.296, 0.50), (0.296, 0.46), (0.282, 0.42), (0.245, 0.39), (0.19, 0.375),
                                              (0.12, 0.37)], 3)]
tube(bm, [(c, X, ay, squircle(0.085, 0.036, 14, 3.5)) for c, (_, ay) in zip(path, transport(path, Vector((0, 1, 0))))])
for s in (-1, 1):
    swept(bm, [(s * 0.138, 0.262, 0.60), (s * 0.125, 0.272, 0.55), (s * 0.08, 0.288, 0.49), (s * 0.02, 0.296, 0.465)],
          3, 0.048, 0.028)
emit("Spine", bm, FRAME)

# ---- Arms: from the spine's branches out round the back of the seat, up a post, forward under a flat pad.
for s in (-1, 1):
    bm = bmesh.new()
    path = [Vector((s * x, y, z)) for x, y, z in spline(
        [(0.10, 0.276, 0.53), (0.19, 0.262, 0.52), (0.25, 0.23, 0.515), (0.282, 0.19, 0.525), (0.288, 0.175, 0.56),
         (0.29, 0.16, 0.60), (0.29, 0.12, 0.625), (0.29, 0.06, 0.633), (0.29, 0.01, 0.635)], 3)]
    tube(bm, [(c, ax, ay, squircle(0.03, 0.045, 10, 3.5)) for c, (ax, ay) in zip(path, transport(path, UP))])
    emit("Arm", bm, FRAME)
    box("ArmSleeve", Vector((s * 0.288, 0.172, 0.565)), (0.058, 0.044, 0.06), FRAME, 0.008, 2)  # the height slide
    bm = bmesh.new()
    tube(bm, [(Vector((s * 0.29, 0.0, 0.638 + z)), X, Vector((0, 1, 0)), squircle(0.088 - 2 * i, 0.26 - 2 * i, 28, 5))
              for z, i in ((0.0, 0.007), (0.006, 0.0), (0.024, 0.0), (0.031, 0.009))])
    emit("ArmPad", bm, BLACK)

# ---- Tilt mechanism under the seat, its tension knob and two levers.
box("Mechanism", Vector((0, 0.045, 0.372)), (0.17, 0.22, 0.075), FRAME, 0.018, 2)
box("MechanismNose", Vector((0, -0.085, 0.385)), (0.13, 0.08, 0.045), FRAME, 0.012, 2)
bm = bmesh.new()
lathe(bm, [(0.011, 0.0), (0.011, 0.035), (0.019, 0.040), (0.020, 0.105), (0.015, 0.115)], 12,
      (0.045, -0.10, 0.36), (0.3, -0.92, -0.25))
emit("TensionKnob", bm, BLACK)
bm = bmesh.new()
path = [Vector(p) for p in ((0.08, -0.01, 0.385), (0.15, -0.025, 0.39), (0.20, -0.05, 0.392))]
tube(bm, [(c, ax, ay, squircle(0.014, 0.008, 8)) for c, (ax, ay) in zip(path, transport(path, UP))])
emit("HeightLever", bm, BLACK)
box("HeightPaddle", Vector((0.212, -0.062, 0.392)), (0.032, 0.05, 0.011), BLACK, 0.004, 1)
bm = bmesh.new()
path = [Vector(p) for p in ((-0.08, 0.07, 0.37), (-0.15, 0.065, 0.36), (-0.19, 0.045, 0.355))]
tube(bm, [(c, ax, ay, squircle(0.012, 0.012, 8)) for c, (ax, ay) in zip(path, transport(path, UP))])
lathe(bm, [(0.012, 0.0), (0.016, 0.008), (0.016, 0.035), (0.011, 0.042)], 12, (-0.19, 0.045, 0.355), (-0.6, -0.8, 0))
emit("TiltLever", bm, BLACK)

# ---- Gas cylinder: the shroud over the cylinder, the piston rising into the mechanism.
bm = bmesh.new()
lathe(bm, [(0.030, 0.17), (0.031, 0.19), (0.031, 0.28), (0.024, 0.29)], 20, (0, 0, 0), UP)
emit("Shroud", bm, FRAME)
bm = bmesh.new()
lathe(bm, [(0.0135, 0.28), (0.0135, 0.345)], 14, (0, 0, 0), UP)
emit("Piston", bm, BLACK)

# ---- Five-star base: a hub, legs that taper and arch down to the casters, a socket at each tip.
bm = bmesh.new()
lathe(bm, [(0.042, 0.095), (0.05, 0.105), (0.052, 0.17), (0.045, 0.185), (0.034, 0.19)], 20, (0, 0, 0), UP)
LEG_TOP = curve([(0.03, 0.172), (0.07, 0.168), (0.15, 0.148), (0.23, 0.125), (R_TIP, 0.112)])
LEG_BOT = curve([(0.03, 0.118), (0.07, 0.112), (0.15, 0.100), (0.23, 0.090), (R_TIP, 0.084)])
LEG_W = curve([(0.03, 0.062), (0.10, 0.052), (0.20, 0.042), (R_TIP, 0.036)])
legs = []
for k in range(5):
    phi = 2 * math.pi * k / 5  # leg 0 points back (+y), under the backrest
    d = Vector((math.sin(phi), math.cos(phi), 0))
    side = Vector((math.cos(phi), -math.sin(phi), 0))
    tube(bm, [(d * r + UP * (LEG_TOP(r) + LEG_BOT(r)) / 2, side, UP, squircle(LEG_W(r), LEG_TOP(r) - LEG_BOT(r), 12, 3.0, 8.0))
              for r in (0.03, 0.07, 0.11, 0.15, 0.19, 0.23, 0.27, R_TIP)])
    lathe(bm, [(0.020, 0.072), (0.021, 0.08), (0.021, 0.108), (0.016, 0.116)], 12, d * R_TIP, UP)
    legs.append((phi, d))
emit("Base", bm, FRAME)

# ---- Twin-wheel casters, trailing outwards: a hood over two wheels on one axle.
for phi, d in legs:
    m = Matrix.Translation(d * R_TIP) @ Matrix.Rotation(-phi, 4, "Z")  # local +y along the leg, +x across it
    box("CasterHood", Vector((0, 0.016, 0.061)), (0.066, 0.062, 0.034), BLACK, 0.01, 2, m)
    box("CasterWeb", Vector((0, 0.022, 0.042)), (0.012, 0.04, 0.04), BLACK, 0.003, 1, m)
    bm = bmesh.new()
    for a in (-1, 1):
        lathe(bm, [(0.010, -0.01), (0.027, -0.01), (0.032, -0.005), (0.032, 0.005), (0.027, 0.01), (0.010, 0.01)],
              14, m @ Vector((a * 0.018, 0.025, 0.032)), m.to_3x3() @ Vector((1, 0, 0)))
    emit("Wheels", bm, BLACK)

# ---- One object, smooth with hard edges kept, then the GLB. Everything above the column moves ahead a little.
for o in PARTS:
    if o.name.split(".")[0] not in ("Shroud", "Piston", "Base", "CasterHood", "CasterWeb", "Wheels"):
        o.data.transform(Matrix.Translation((0, -AHEAD, 0)))
bpy.ops.object.select_all(action="DESELECT")
for o in PARTS:
    o.select_set(True)
chair = PARTS[0]
bpy.context.view_layer.objects.active = chair
bpy.ops.object.join()
chair.name = chair.data.name = "Chair"
for p in chair.data.polygons:
    p.use_smooth = True
chair.data.set_sharp_from_angle(angle=math.radians(48))
tris = sum(len(p.vertices) - 2 for p in chair.data.polygons)
print(f"aeron: {tris} triangles")

bpy.ops.object.select_all(action="DESELECT")
chair.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_cameras=False, export_lights=False)

# ---- Preview renders. Only here the Mesh gets a striped see-through weave (on its UVs), to check them.
if PREVIEW:
    scene = bpy.context.scene
    for engine in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            pass
    scene.render.resolution_x, scene.render.resolution_y = 800, 800
    scene.view_settings.view_transform = "Standard"
    nt = MATS[MESH].node_tree
    wave = nt.nodes.new("ShaderNodeTexWave")
    wave.bands_direction = "X"
    wave.inputs["Scale"].default_value = 40
    coord = nt.nodes.new("ShaderNodeTexCoord")
    nt.links.new(coord.outputs["UV"], wave.inputs["Vector"])
    gt = nt.nodes.new("ShaderNodeMath")
    gt.operation = "GREATER_THAN"
    gt.inputs[1].default_value = 0.45
    nt.links.new(wave.outputs["Fac"], gt.inputs[0])
    ma = nt.nodes.new("ShaderNodeMath")
    ma.operation = "MULTIPLY_ADD"
    ma.inputs[1].default_value = 0.45
    ma.inputs[2].default_value = 0.55
    nt.links.new(gt.outputs[0], ma.inputs[0])
    nt.links.new(ma.outputs[0], nt.nodes["Principled BSDF"].inputs["Alpha"])
    world = bpy.data.worlds.new("Sky")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.75, 0.78, 0.82, 1)
    bg.inputs["Strength"].default_value = 1.0
    scene.world = world
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(40), math.radians(10), math.radians(-30)))
    bpy.context.active_object.data.energy = 4.0
    bpy.ops.mesh.primitive_plane_add(size=20)
    bpy.context.active_object.data.materials.append(material("Ground", (0.5, 0.5, 0.48), 0.9))
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    os.makedirs(PREVIEW, exist_ok=True)
    for label, at, look in (("front34", (1.35, -1.95, 1.25), (0, 0, 0.52)), ("front", (0, -2.7, 0.75), (0, 0, 0.53)),
                            ("side", (2.7, 0, 0.62), (0, 0.03, 0.53)), ("back34", (-1.35, 1.95, 1.3), (0, 0, 0.52)),
                            ("top", (0, -0.01, 2.3), (0, 0, 0.0)), ("base", (0.62, -0.78, 0.42), (0.04, -0.08, 0.16))):
        cam.location = at
        cam.data.lens = 50
        cam.rotation_euler = (Vector(look) - Vector(at)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(PREVIEW, f"{label}.png")
        bpy.ops.render.render(write_still=True)
