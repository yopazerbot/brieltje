"""What the carbine (tools/guns/rifle.py) and the bolt-action rifle (tools/guns/sniper.py) share: the materials, the
shape helpers, the hands, and the steps after the modelling (join, bake, export, pack, preview pictures).

Not run by itself: each gun's script imports it (`from rifleparts import *`) inside Blender.

The shape helpers are tools/lasergun.py's own (prism, block, lathe, ring, sweep, cut, bevel, chamfers, screw and the
rest), read from that file as it is and run here, so all three guns are bevelled and cut the same way and lasergun.py
stays as it is. The hands are tools/weapons.py's (real_hand: the sculpted arms posed on the grip and the fore-end), read
the same way, so weapons.py and weapons.glb stay as they are. A few helpers of our own sit below them: a section pushed
along the barrel (rails, blocks round the barrel), ridged knobs (turrets, caps), checkering as small pyramids, slots with
round ends, and Paintball's kit.

Frame, as tools/weapons.py: inside Blender the barrel runs along +y, up is +z, right is +x, metres; the exporter turns
that into the GLB's (barrel along -z, up +y).
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Quaternion, Vector

TOOLS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[0] if argv else ""
PREVIEW = argv[1] if len(argv) > 1 else ""

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def srgb(h):
    """'#rrggbb' to linear RGB, as the Principled BSDF (and glTF) expect."""
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def material(name, color, rough=0.5, metal=0.0, alpha=1.0, glow="", strength=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*srgb(color), 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    if alpha < 1:
        p.inputs["Alpha"].default_value = alpha
        m.surface_render_method = "BLENDED"
    if glow:
        p.inputs["Emission Color"].default_value = (*srgb(glow), 1)
        p.inputs["Emission Strength"].default_value = strength
    m.use_backface_culling = True
    return m


# Three dark finishes that take the light differently, so the gun is never one black: anodised aluminium (the
# receivers, the handguard, the sights' housings, the scope; a dark grey with a soft sheen that mirrors the sky), the
# polymer furniture (grip, stock, magazine; near black and matt), and phosphated steel (the barrels, the gas block,
# the action; a flat grey-black). The game's finish for each is in web/src/world/gunSurface.ts; the colours here are
# that finish, so the previews look as the game does. The shared names (Steel, Dark, Polymer, Grip, Lens, RedDot,
# Glass, Dot) are tools/weapons.py's, with the same roles.
M = {
    "Anod": material("RifleAnodised", "#2a2d32", 0.42, 0.35),
    "Phos": material("RiflePhosphate", "#2e2f30", 0.62, 0.5),
    "Steel": material("Steel", "#4d5056", 0.3, 1.0),       # bright metal: the bolt carrier, the trigger, pins, the bolt
    "Dark": material("Dark", "#2a2c30", 0.42, 0.7),        # small hardware: screws, clamps, the rail's sights
    "Polymer": material("Polymer", "#232426", 0.6, 0.0),   # grip, stock, magazine, trigger guard
    "Grip": material("Grip", "#202123", 0.88, 0.0),        # rubber: the butt pad, the checkered panels, the eyecup
    "Stock": material("SniperStock", "#4a4c42", 0.7, 0.0),  # the bolt-action rifle's stock: a dark grey-green composite
    "Lens": material("Lens", "#7fa6b4", 0.05, 0.0, alpha=0.16),  # the red-dot sight's windows: you look through them
    "RedDot": material("RedDot", "#1a0504", 0.5, 0.0, glow="#ff2a14"),
    "Glass": material("Glass", "#1d3a4c", 0.05, 0.6),      # the scope's lenses (the game mirrors the sky in them)
    "Dot": material("Dot", "#e8e4d0", 0.4, 0.0),           # the selector's plain marks
    "Hopper": material("Hopper", "#2f8cff", 0.15, 0.0),    # Paintball's kit: coloured per gun in the game
    "KitTrim": material("KitTrim", "#ffd23f", 0.4, 0.0),
    "Tank": material("Tank", "#dfe3e8", 0.3, 0.5),
    "Glove": material("Glove", "#26272a", 0.82, 0.0),
    "GloveTrim": material("GloveTrim", "#23251f", 0.8, 0.0),
    "Sleeve": material("Sleeve", "#4b4c3b", 0.9, 0.0),
}

# tools/lasergun.py's shape helpers, run here with these materials and this scene.
_src = open(os.path.join(TOOLS, "lasergun.py"), encoding="utf-8").read()
exec(compile(_src[_src.index("def link(obj):"):_src.index("# ---- The laser rifle ---")], os.path.join(TOOLS, "lasergun.py"), "exec"), globals())


# ---- Helpers of our own ------------------------------------------------------------------------

def xprism(name, pts, y0, y1, mat, bev=0.0, seg=1, cuts=None, angle=35):
    """A cross-section (points (x, z), either winding) pushed along the barrel from y0 to y1: a rail's tooth, a block
    round the barrel, a chassis' section. `cuts`: shapes cut out of it before the bevel."""
    bm = bmesh.new()
    a = [bm.verts.new((x, y0, z)) for x, z in pts]
    b = [bm.verts.new((x, y1, z)) for x, z in pts]
    bm.faces.new(a)
    bm.faces.new(list(reversed(b)))
    n = len(pts)
    for i in range(n):
        bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = mesh_obj(name, bm, [mat])
    cut(o, cuts or [])
    return bevel(o, bev, seg, angle)


def turn_about_bore(o, ang, cz, cx=0.0):
    """Turn a shape by `ang` about the barrel's axis through (cx, cz): a shape made on the right (+x) side goes to
    the side at `ang` from it, measured up from the right (90: the top, 180: the left, 270: underneath)."""
    o.data.transform(Matrix.Translation((cx, 0, cz)) @ Matrix.Rotation(-ang, 4, "Y") @ Matrix.Translation((-cx, 0, -cz)))
    return o


def rounded(y0, y1, zc, w, steps=4):
    """The outline (y, z) of a slot with round ends, y0 to y1 long and w wide, round zc."""
    r = w / 2
    pts = []
    for k in range(steps + 1):  # the front end
        a = -math.pi / 2 + math.pi * k / steps
        pts.append((y1 - r + r * math.cos(a), zc + r * math.sin(a)))
    for k in range(steps + 1):  # the back end
        a = math.pi / 2 + math.pi * k / steps
        pts.append((y0 + r + r * math.cos(a), zc + r * math.sin(a)))
    return pts


def slot(y0, y1, w, x0, x1, zc=0.0, mark=True, corner=0.0, steps=4):
    """A cutter: a slot with round ends on the right side, from x0 to x1 deep; turn it with turn_about_bore. With
    `corner`: a rectangle with its corners cut by that much instead (a handguard's mounting slot)."""
    if corner:
        r, c = w / 2, corner
        pts = [(y0 + c, zc - r), (y1 - c, zc - r), (y1, zc - r + c), (y1, zc + r - c), (y1 - c, zc + r), (y0 + c, zc + r), (y0, zc + r - c),
               (y0, zc - r + c)]
    else:
        pts = rounded(y0, y1, zc, w, steps)
    o = prism("cutslot", pts, (x1 - x0) / 2, M["Dark"], 0, x=(x0 + x1) / 2)
    return dark(o) if mark else o


def knob(name, r_out, r_in, ridges, t0, t1, mat, at, axis="x", chamfer=0.0006):
    """A ridged knob or cap: a star of `ridges` ridges round the axis from t0 to t1, its ends chamfered (the
    turrets' click marks, a brightness knob, a castle nut's notches)."""
    U, A, V = {"y": (Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))),
               "x": (Vector((0, 1, 0)), Vector((1, 0, 0)), Vector((0, 0, 1))),
               "z": (Vector((1, 0, 0)), Vector((0, 0, 1)), Vector((0, 1, 0)))}[axis]
    c0 = Vector(at)
    bm = bmesh.new()
    n = ridges * 2
    lo, hi = (t0, t1) if t1 > t0 else (t1, t0)
    c = min(chamfer, (hi - lo) / 3)
    layers = [(lo, 1.0 - c / r_out), (lo + c, 1.0), (hi - c, 1.0), (hi, 1.0 - c / r_out)]
    rings = []
    for t, s in layers:
        ring_ = []
        for k in range(n):
            a = 2 * math.pi * k / n
            r = (r_out if k % 2 == 0 else r_in) * s
            ring_.append(bm.verts.new(c0 + A * t + (U * math.cos(a) + V * math.sin(a)) * r))
        rings.append(ring_)
    for ra, rb in zip(rings, rings[1:]):
        for k in range(n):
            bm.faces.new((ra[k], ra[(k + 1) % n], rb[(k + 1) % n], rb[k]))
    bm.faces.new(rings[0])
    bm.faces.new(list(reversed(rings[-1])))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = mesh_obj(name, bm, [mat])
    return shade(o, 30)


def checker(name, centre, u, v, nu, nv, pitch, h, mat, inside=None):
    """Checkering on a flat face: a grid of small four-sided pyramids, `pitch` apart, `h` high, laid in the plane of
    the unit vectors u and v round `centre` (their cross product the way out). `inside(a, b)`: whether the spot a, b
    (metres along u and v from the centre) is on the panel."""
    u, v = Vector(u).normalized(), Vector(v).normalized()
    n = u.cross(v).normalized()
    c = Vector(centre)
    bm = bmesh.new()
    half = pitch * 0.5
    for i in range(nu):
        for j in range(nv):
            a = (i - (nu - 1) / 2) * pitch
            b = (j - (nv - 1) / 2) * pitch + (half if i % 2 else 0.0)
            if inside and not inside(a, b):
                continue
            p = c + u * a + v * b - n * 0.0002
            base = [bm.verts.new(p + u * half), bm.verts.new(p + v * half), bm.verts.new(p - u * half), bm.verts.new(p - v * half)]
            tip = bm.verts.new(p + n * (h + 0.0002))
            for k in range(4):
                bm.faces.new((base[k], base[(k + 1) % 4], tip))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:  # each pyramid's faces away from the panel
        if f.normal.dot(n) < 0:
            f.normal_flip()
    o = mesh_obj(name, bm, [mat])
    for p_ in o.data.polygons:
        p_.use_smooth = False
    return o


def moved(o, m):
    """Move a shape's points by the matrix m (a turn and a place), in its own data."""
    o.data.transform(m)
    return o


def hopper(x, y, ztop, r, side=0.0):
    """Paintball's hopper on the gun's left flank (`side`: the flank's half width) with its top at `ztop`: a rounded
    tub with a lid and a feed neck, as tools/weapons.py makes it."""
    c = Vector((x, y, ztop - r * 1.15))
    neck = block("neck", x + r * 0.7, -side + 0.002, y - r * 0.28, y + r * 0.28, c.z - r * 0.28, c.z + r * 0.28, M["KitTrim"], 0.002)
    prof = [(-0.85, 0.0), (-0.85, 0.35), (-0.78, 0.7), (-0.55, 0.93), (-0.2, 1.0), (0.25, 0.97), (0.6, 0.85), (0.85, 0.62), (0.85, 0.0)]
    tub = lathe("hopper", [(c.z + r * t, r * s) for t, s in prof], M["Hopper"], 18, (c.x, c.y, 0), "z", smooth_angle=60)
    lid = lathe("lid", [(c.z + r * 0.82, 0.0), (c.z + r * 0.82, r * 0.66), (c.z + r * 0.95, r * 0.6), (c.z + r * 1.0, r * 0.4), (c.z + r * 1.0, 0.0)],
                M["KitTrim"], 18, (c.x, c.y, 0), "z", smooth_angle=60)
    for o in (tub, lid):  # an oval tub, longer along the gun
        moved(o, Matrix.Translation((c.x, c.y, 0)) @ Matrix.Diagonal((1.0, 1.25, 1.0, 1.0)) @ Matrix.Translation((-c.x, -c.y, 0)))
    return [neck, tub, lid]


def tank(y0, y1, r, at):
    """Paintball's air tank under the barrel: domed ends, a regulator ring at the back, a mount on top."""
    x, z = at
    prof = [(y0, 0), (y0 + r * 0.3, r * 0.7), (y0 + r * 0.9, r), (y1 - r * 0.9, r), (y1 - r * 0.3, r * 0.7), (y1, 0)]
    return [lathe("tank", prof, M["Tank"], 14, (x, 0, z), smooth_angle=60),
            ring("reg", y0 + r * 0.6, y0 + r * 1.6, r * 1.08, M["KitTrim"], (x, 0, z), 14),
            block("mount", x - r * 0.35, x + r * 0.35, (y0 + y1) / 2 - 0.02, (y0 + y1) / 2 + 0.02, z + r * 0.6, z + r * 1.6, M["KitTrim"], 0.001)]


def trigger_guard(name, y0, y1, ztop, zbot, half, t=0.004, mat=None):
    pts = [(y0 - 0.006, ztop - 0.012), (y0, zbot + 0.004), (y0 + 0.006, zbot), (y1 - 0.006, zbot), (y1, zbot + 0.006), (y1, ztop),
           (y1 - t, ztop), (y1 - t, zbot + t + 0.003), (y1 - t - 0.004, zbot + t), (y0 + 0.007, zbot + t), (y0 + t, zbot + t + 0.004), (y0 - 0.006 + t, ztop - 0.012)]
    return prism(name, pts, half, mat or M["Polymer"], 0.0008, 1)


def inside_poly(pts, y, z, shrink=0.85):
    """Whether (y, z) lies inside the polygon pts, shrunk round its middle by `shrink`."""
    cy = sum(p[0] for p in pts) / len(pts)
    cz = sum(p[1] for p in pts) / len(pts)
    q = [(cy + (a - cy) * shrink, cz + (b - cz) * shrink) for a, b in pts]
    hit = False
    for (y0, z0), (y1, z1) in zip(q, q[1:] + q[:1]):
        if (z0 > z) != (z1 > z) and y < y0 + (z - z0) * (y1 - y0) / (z1 - z0):
            hit = not hit
    return hit


def rail(name, y0, y1, zr, skip=(), mat=None):
    """A rail of the standard pattern on top at zr: a dovetailed base 21 mm wide and its teeth, the slots between them
    10.0 mm apart, 5.2 mm wide and 3 mm deep. No teeth where something clamps on it (`skip`: (y0, y1) spans)."""
    mat = mat or M["Anod"]
    parts = [xprism(name, [(-0.0078, zr - 0.001), (0.0078, zr - 0.001), (0.0078, zr + 0.0012), (0.0106, zr + 0.0040), (0.0101, zr + 0.0045),
                           (-0.0101, zr + 0.0045), (-0.0106, zr + 0.0040), (-0.0078, zr + 0.0012)], y0, y1, mat, 0.0003, 1)]
    tooth = [(-0.0106, zr + 0.0040), (0.0106, zr + 0.0040), (0.0080, zr + 0.0066), (0.0073, zr + 0.0075), (-0.0073, zr + 0.0075), (-0.0080, zr + 0.0066)]
    y = y0 + 0.0026
    while y + 0.00478 <= y1 - 0.0015:
        if not any(a - 0.001 < y + 0.0024 < b + 0.001 for a, b in skip):
            parts.append(xprism(name + "T", tooth, y, y + 0.00478, mat))
        y += 0.01001
    return parts


def edge_at(line, z):
    """Where the polyline `line` of (y, z) points, walked downwards, is at height z."""
    for (y0, z0), (y1, z1) in zip(line, line[1:]):
        if z1 <= z <= z0:
            return y0 + (y1 - y0) * (z - z0) / (z1 - z0)
    return line[-1][0]


# ---- The hands ---------------------------------------------------------------------------------
def weapons_hands():
    """tools/weapons.py's "Hands" part (the sculpted arms, real_hand and hand), read from that file and run with the
    few helpers it uses, as tools/lasergun.py does."""
    path = os.path.join(TOOLS, "weapons.py")
    src = open(path, encoding="utf-8").read()
    part = src[src.index("# ---- Hands ---"):src.index("# ---- The weapons ---")]

    def mesh_obj_smooth(name, bm, mats, smooth=False):
        o = mesh_obj(name, bm, mats)
        if smooth:
            for p in o.data.polygons:
                p.use_smooth = True
        return o

    ns = {"__file__": path, "__name__": "weapons_hands", "math": math, "os": os, "sys": sys, "bmesh": bmesh, "bpy": bpy,
          "Matrix": Matrix, "Quaternion": Quaternion, "Vector": Vector, "M": M, "link": link, "mesh_obj": mesh_obj_smooth,
          "join": join, "pivot": pivot, "gl": gl}
    exec(compile(part, path, "exec"), ns)
    return ns


H = weapons_hands()


# ---- After the modelling -----------------------------------------------------------------------

def tri_count(objs):
    n = 0
    for o in objs:
        if o.type == "MESH":
            o.data.calc_loop_triangles()
            n += len(o.data.loop_triangles)
    return n


def finish(w, grip, body, moving, muzzle, sight, kit, hands):
    """Join and name a gun's parts as tools/weapons.py's finish does, move it so `grip` is the origin, and hang it
    under an empty named `w`. moving: {key: (parts, pivot, extras)}; extras "out" a way (made unit), "knob" a point
    (taken from the pivot)."""
    g = Vector(grip)
    sizes = {}
    for o in body + [p for parts in moving.values() for p in parts[0]]:
        o.data.calc_loop_triangles()
        k = o.name.split(".")[0]
        sizes[k] = sizes.get(k, 0) + len(o.data.loop_triangles)
    print("largest parts:", sorted(sizes.items(), key=lambda kv: -kv[1])[:30])
    objs = [join(w + "_body", body)]
    for key, parts in moving.items():
        o = join(f"{w}_{key}", parts[0])
        pivot(o, parts[1])
        for k, v in (parts[2] if len(parts) > 2 else {}).items():
            o[k] = gl(Vector(v) - Vector(parts[1])) if k == "knob" else gl(Vector(v).normalized())
        objs.append(o)
    objs.append(empty(w + "_muzzle", muzzle))
    objs.append(empty(w + "_sight", sight))
    if kit:
        k = join(w + "_kit", kit)
        for p in k.data.polygons:
            p.use_smooth = True
        objs.append(k)
    for o in objs:
        o.location -= g
    hand_root = empty(w + "_hands", (0, 0, 0))
    for h in hands:
        h.location -= g
        h.parent = hand_root
    objs.append(hand_root)
    root = empty(w, (0, 0, 0))
    for o in objs:
        o.parent = root
    gun = tri_count([o for o in objs if o.type == "MESH" and not o.name.endswith("_kit")])
    for o in [*objs, *hands]:
        if o.type == "MESH":
            print(f"{o.name}: {tri_count([o])} triangles")
    print(f"{w}: gun {gun} triangles")
    return root


def bake_shade(root):
    """The gun's own shading per face corner, as tools/weapons.py and tools/lasergun.py bake it (gunSurface.ts reads
    it): red, how closed in the spot is, from a fixed set of rays over the gun's own parts; green, 1 on the thin bevels
    of the hard edges, where the finish wears first. The hands one value per point. Not Paintball's kit."""
    from mathutils.bvhtree import BVHTree
    rays, reach = 24, 0.02
    dirs = []
    for i in range(rays):
        u, a = (i + 0.5) / rays, 2 * math.pi * ((i * 0.61803398875) % 1.0)
        dirs.append((math.sqrt(u) * math.cos(a), math.sqrt(u) * math.sin(a), math.sqrt(1 - u)))
    bpy.context.view_layer.update()
    hands = [h for e in root.children if e.name.endswith("_hands") for h in e.children if h.type == "MESH"]
    meshes = [o for o in root.children if o.type == "MESH" and not o.name.endswith("_kit")] + hands
    verts, polys = [], []
    for o in meshes:
        base = len(verts)
        verts += [o.matrix_world @ v.co for v in o.data.vertices]
        polys += [[base + i for i in p.vertices] for p in o.data.polygons]
    tree = BVHTree.FromPolygons(verts, polys)
    for o in meshes:
        me = o.data
        bm = bmesh.new()
        bm.from_mesh(me)
        worn = []
        for f in bm.faces:
            longest = max(e.calc_length() for e in f.edges)
            width = f.calc_area() / longest if longest > 0 else 1
            angles = [e.calc_face_angle_signed() for e in f.edges if len(e.link_faces) == 2]
            strip = width < 0.0032 and longest > 2.5 * width
            worn.append(1.0 if strip and angles and sum(a > math.radians(18) for a in angles) >= 2 and min(angles) > -0.02 else 0.0)
        bm.free()
        attr = me.color_attributes.new("shade", "FLOAT_COLOR", "CORNER")
        mw, rot = o.matrix_world, o.matrix_world.to_3x3()
        if o in hands:
            per = {}
            for v in me.vertices:
                n = (rot @ v.normal).normalized()
                t = n.orthogonal().normalized()
                bi = n.cross(t)
                start = mw @ v.co + n * 0.0006
                closed = 0.0
                for d in dirs:
                    hit = tree.ray_cast(start, t * d[0] + bi * d[1] + n * d[2], reach)
                    if hit[0] is not None:
                        closed += 1 - hit[3] / reach
                per[v.index] = min(1.0, closed / rays)
            for lp in me.loops:
                attr.data[lp.index].color = (per[lp.vertex_index], 0.0, 0.0, 1.0)
        else:
            for p in me.polygons:
                n = (rot @ p.normal).normalized()
                t = n.orthogonal().normalized()
                bi = n.cross(t)
                mid = mw @ p.center
                for li in p.loop_indices:
                    co = mw @ me.vertices[me.loops[li].vertex_index].co
                    start = co + (mid - co) * 0.08 + n * 0.0005
                    closed = 0.0
                    for d in dirs:
                        hit = tree.ray_cast(start, t * d[0] + bi * d[1] + n * d[2], reach)
                        if hit[0] is not None:
                            closed += 1 - hit[3] / reach
                    # In steps of 1/32: neighbouring corners that come out alike share one point in the file.
                    attr.data[li].color = (round(min(1.0, closed / rays) * 32) / 32, worn[p.index], 0.0, 1.0)
        me.color_attributes.active_color = attr
        me.color_attributes.render_color_index = me.color_attributes.find("shade")


# tools/lasergun.py's pack (positions as 16-bit integers, normals as bytes, the baked shading as two bytes), as it is.
_p = _src.index("def pack(path):")
exec(compile(_src[_p:_src.index("\npack(OUT)", _p)], os.path.join(TOOLS, "lasergun.py"), "exec"), globals())


def export(root, out):
    H["drop_arms"]()  # the sculpt out again before the bake and the export
    bake_shade(root)
    bpy.ops.object.select_all(action="SELECT")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                              export_extras=True, export_texcoords=True, export_cameras=False, export_lights=False,
                              export_vertex_color="ACTIVE", export_active_vertex_color_when_no_material=True)
    pack(out)
    print("written", out, os.path.getsize(out), "bytes")


def previews(root, w, out_dir, centre, size, hip, ads=None, closeups=(), res=(560, 315)):
    """Small Eevee pictures, each view in clay (one grey material: the shapes alone) and in the materials: the left,
    the right, the top, three quarters from the front and from the back, any close-ups; the player's hip view and the
    aimed one with the hands (as the game draws them: weapon.ts HIP, a 54 degree view, the grip a quarter size as far
    again); then each hand alone in clay. `size`: about the gun's length, to frame it. A small studio as
    tools/lasergun.py's: a sky that fades to a dark floor for the metal to mirror, a key, a fill and a rim."""
    os.makedirs(out_dir, exist_ok=True)
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = res
    try:
        scene.eevee.taa_render_samples = 16
    except AttributeError:
        pass
    world = bpy.data.worlds.new("Studio")
    world.use_nodes = True
    nt = world.node_tree
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.46
    ramp.color_ramp.elements[0].color = (0.02, 0.02, 0.022, 1)
    ramp.color_ramp.elements[1].position = 0.80
    ramp.color_ramp.elements[1].color = (0.30, 0.32, 0.35, 1)
    band = ramp.color_ramp.elements.new(0.53)
    band.color = (0.9, 0.92, 0.95, 1)
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value, mr.inputs["From Max"].default_value = -1, 1
    nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    nt.links.new(sep.outputs["Z"], mr.inputs["Value"])
    nt.links.new(mr.outputs["Result"], ramp.inputs["Fac"])
    path = nt.nodes.new("ShaderNodeLightPath")
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    a_in, b_in = [i for i in mix.inputs if i.type == "RGBA"][:2]
    mout = [o for o in mix.outputs if o.type == "RGBA"][0]
    b_in.default_value = (0.055, 0.058, 0.063, 1)
    nt.links.new(path.outputs["Is Camera Ray"], mix.inputs[0])
    nt.links.new(ramp.outputs["Color"], a_in)
    nt.links.new(mout, nt.nodes["Background"].inputs["Color"])
    scene.world = world
    C = Vector(centre)

    def light(name, kind, at, energy, size_=0.0, target=C):
        d = bpy.data.lights.new(name, kind)
        d.energy = energy
        if kind == "AREA":
            d.size = size_
        o = link(bpy.data.objects.new(name, d))
        o.location = Vector(at)
        o.rotation_euler = (target - o.location).to_track_quat("-Z", "Y").to_euler()
        return o

    light("key", "AREA", C + Vector((-0.6, 0.4, 1.4)), 120, 1.2)
    light("key2", "AREA", C + Vector((0.6, 0.2, 1.3)), 70, 1.0)
    light("rim", "AREA", C + Vector((0.0, -1.4, 0.5)), 60, 0.8)
    light("fill", "AREA", C + Vector((0.0, 1.4, -0.2)), 25, 1.0)
    cam = link(bpy.data.objects.new("cam", bpy.data.cameras.new("cam")))
    scene.camera = cam

    def look(at, target, lens=50, roll=None):
        cam.location = Vector(at)
        cam.data.sensor_fit = "AUTO"
        cam.data.lens = lens
        cam.data.clip_start = 0.01
        cam.rotation_euler = (Vector(target) - cam.location).to_track_quat("-Z", "Y").to_euler()
        if roll is not None:
            cam.rotation_euler = roll

    d = size * 1.56
    views = [
        ("left", lambda: look(C + Vector((-d, 0, 0.04)), C)),
        ("right", lambda: look(C + Vector((d, 0, 0.04)), C)),
        ("front34", lambda: look(C + Vector((-d * 0.55, d * 0.69, d * 0.26)), C)),
        ("rear34", lambda: look(C + Vector((-d * 0.55, -d * 0.72, d * 0.31)), C)),
        ("top", lambda: look(C + Vector((0, 0, d * 1.07)), C, 50, (0, 0, math.radians(90)))),
    ]
    for label, at, target, lens in closeups:
        views.append((label, (lambda at=at, target=target, lens=lens: look(Vector(at), Vector(target), lens))))
    hx, hy, hz = hip
    hip_far = math.tan(math.radians(36)) / math.tan(math.radians(27))

    def hip_view():
        cam.location = Vector((-hx / 0.25, hz * hip_far / 0.25, -hy / 0.25))
        cam.rotation_euler = (math.radians(90), 0, 0)
        cam.data.sensor_fit = "VERTICAL"
        cam.data.angle_y = math.radians(54)
        cam.data.clip_start = 0.07
    views.append(("hip_eye", hip_view))
    if ads:
        def ads_view():
            s = next(c for c in root.children if c.name == w + "_sight").matrix_world.translation
            cam.location = Vector((s.x, -ads[0], s.z))
            cam.rotation_euler = (math.radians(90), 0, 0)
            cam.data.sensor_fit = "VERTICAL"
            cam.data.angle_y = math.radians(ads[1])
            cam.data.clip_start = 0.07
        views.append(("ads_eye", ads_view))
    clay = bpy.data.materials.new("Clay")
    clay.use_nodes = True
    clay.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.55, 0.54, 0.52, 1)
    clay.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.65
    meshes = [o for o in root.children if o.type == "MESH"]
    kept = {o.name: [s.material for s in o.material_slots] for o in meshes}
    paint = os.path.join(TOOLS, "..", "web", "public", "models", "glove_color.webp")
    if os.path.exists(paint):
        nodes = M["Glove"].node_tree.nodes
        tex = nodes.new("ShaderNodeTexImage")
        tex.image = bpy.data.images.load(paint)
        M["Glove"].node_tree.links.new(tex.outputs["Color"], nodes["Principled BSDF"].inputs["Base Color"])
    hands = [h for e in root.children if e.name.endswith("_hands") for h in e.children if h.type == "MESH"]
    for mode in ("clay", "final"):
        for o in meshes:
            for s, m in zip(o.material_slots, kept[o.name]):
                s.material = clay if mode == "clay" else m
            if o.name.endswith("_kit"):
                o.hide_render = True
        for label, setup in views:
            if mode == "clay" and label in ("hip_eye", "ads_eye"):
                continue
            setup()
            for h in hands:
                h.hide_render = label not in ("hip_eye", "ads_eye")
            scene.render.filepath = os.path.join(out_dir, f"{w}_{mode}_{label}.png")
            bpy.ops.render.render(write_still=True)
    # The paint look with its kit, from the left and from the hip.
    kit = [o for o in meshes if o.name.endswith("_kit")]
    for o in kit:
        o.hide_render = False
    for label, setup in views:
        if label in ("left", "hip_eye"):
            setup()
            for h in hands:
                h.hide_render = label != "hip_eye"
            scene.render.filepath = os.path.join(out_dir, f"{w}_kit_{label}.png")
            bpy.ops.render.render(write_still=True)
    for o in kit:
        o.hide_render = True
    kept_h = [(h, [s.material for s in h.material_slots]) for h in hands]
    for h, _ in kept_h:
        for s in h.material_slots:
            s.material = clay
    for h in hands:
        near = [h.matrix_world @ v.co for v in h.data.vertices if v.co.length < 0.13]
        centre_h = sum(near, Vector()) / max(1, len(near))
        for other in hands:
            other.hide_render = other is not h
        for label, off in (("back", Vector((-0.04, -0.5, 0.3))), ("left", Vector((-0.6, -0.05, 0.1))), ("right", Vector((0.6, -0.05, 0.1))),
                           ("under", Vector((-0.1, -0.1, -0.6)))):
            look(centre_h + off, centre_h, 85)
            scene.render.filepath = os.path.join(out_dir, f"{h.name}_{label}.png")
            bpy.ops.render.render(write_still=True)
    for h, mats in kept_h:
        for s, m in zip(h.material_slots, mats):
            s.material = m
    print("previews in", out_dir)
