"""The shapes, the hands, the bake, the packing and the preview renders that the tube launcher (tools/guns/bazooka.py)
and the grenade launcher (tools/guns/launcher.py) share. Imported by them inside Blender; not run on its own.

The helpers are tools/lasergun.py's (the laser rifle sets the bar for the guns' finish), taken over as they are, with
a few more: a profile pushed out along the barrel (yprism), an arc of a tube's wall (shell), knurling round a knob.
The hands are tools/weapons.py's own (its "Hands" part, read from that file as tools/lasergun.py reads it), so every
gun's hands are made one way, and weapons.py and weapons.glb stay as they are.
Frame inside Blender: the barrel along +y, up +z, right +x, metres; the exporter turns that into the GLB's frame
(barrel along -z, up +y), and finish() moves the gun so the web of the right hand on the grip is the origin.
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Quaternion, Vector

TOOLS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
scene = bpy.context.scene


def reset():
    global scene
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    return scene


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


def materials():
    """The materials, by the names tools/weapons.py gives them: the game finds them by these names (weapon.ts ROLE, the
    paint look; world/gunSurface.ts, the finish and the wear). The colours are that finish, for the previews."""
    return {
        "Steel": material("Steel", "#4d5056", 0.3, 1.0),        # blued steel: bands, pins, the trigger, the venturi's lip
        "Dark": material("Dark", "#2a2c30", 0.42, 0.7),         # parkerized steel: housings, clamps, the bore, small hardware
        "Polymer": material("Polymer", "#232426", 0.6, 0.0),    # the grips' and the rest's moulded frames
        "Grip": material("Grip", "#202123", 0.88, 0.0),         # rubber: grip panels, pads, the eye cup, the muzzle bumper
        "Olive": material("Olive", "#4c5236", 0.62, 0.0),       # the painted tube and handguard
        "Wood": material("Wood", "#7a4a2b", 0.5, 0.0),          # walnut
        "Warhead": material("Warhead", "#3f4630", 0.5, 0.2),    # the rocket's and the grenade's heads
        "Brass": material("Brass", "#b08a3e", 0.3, 0.9),        # the fuze's cap, the case's rim, a band
        "Dot": material("Dot", "#e8e4d0", 0.4, 0.0),            # the sights' white marks
        "Glass": material("Glass", "#1d3a4c", 0.05, 0.6),       # the optic's lenses (the game makes them mirror the sky)
        # The hands' materials, as tools/weapons.py makes them.
        "Glove": material("Glove", "#26272a", 0.82, 0.0),
        "GloveTrim": material("GloveTrim", "#23251f", 0.8, 0.0),
        "Sleeve": material("Sleeve", "#4b4c3b", 0.9, 0.0),
        # Paintball's kit: coloured per gun in the game.
        "Hopper": material("Hopper", "#2f8cff", 0.15, 0.0),
        "KitTrim": material("KitTrim", "#ffd23f", 0.4, 0.0),
        "Tank": material("Tank", "#dfe3e8", 0.3, 0.5),
    }


M = {}


def link(obj):
    scene.collection.objects.link(obj)
    return obj


def mesh_obj(name, bm, mats):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    return link(bpy.data.objects.new(name, me))


def apply_mod(obj, kind, **props):
    mod = obj.modifiers.new(kind.lower(), kind)
    for k, v in props.items():
        setattr(mod, k, v)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    obj.select_set(False)


def shade(obj, angle=35):
    """Smooth faces, hard edges past `angle`: round parts look round, flats stay flat."""
    for p in obj.data.polygons:
        p.use_smooth = True
    obj.data.set_sharp_from_angle(angle=math.radians(angle))
    return obj


def bevel(obj, width, segments=2, angle=35):
    """Bevel the hard edges, the flats' normals kept square to them (harden): a clean line of light on each edge."""
    shade(obj)
    if width > 0:
        apply_mod(obj, "BEVEL", width=width, segments=segments, limit_method="ANGLE", angle_limit=math.radians(angle),
                  harden_normals=True)
    return obj


def cut(obj, cutters):
    """Cut the cutters out of obj one by one, then throw them away. The faces a cut makes take obj's own material, or
    the dark finish for a cutter marked with dark() (a seam, a groove, a slot)."""
    for c in cutters:
        if not c.get("dark"):
            c.data.materials[0] = obj.data.materials[0]
        apply_mod(obj, "BOOLEAN", operation="DIFFERENCE", object=c, solver="EXACT", material_mode="TRANSFER")
        bpy.data.objects.remove(c, do_unlink=True)
    if cutters and not obj.data.polygons:
        raise RuntimeError(f"{obj.name}: the cuts left nothing")
    return obj


def dark(o):
    """Mark a cutter: the faces it cuts get the dark finish."""
    o["dark"] = 1
    return o


# ---- Shapes ----------------------------------------------------------------------------------

def _extrude(name, pts, a, b, mat):
    """A closed outline `pts` (2D) and its two caps: a(p) and b(p) give each point's two ends in 3D."""
    bm = bmesh.new()
    left = [bm.verts.new(a(p)) for p in pts]
    right = [bm.verts.new(b(p)) for p in pts]
    bm.faces.new(left)
    bm.faces.new(list(reversed(right)))
    n = len(pts)
    for i in range(n):
        bm.faces.new((left[i], left[(i + 1) % n], right[(i + 1) % n], right[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return mesh_obj(name, bm, [mat])


def prism(name, pts, half, mat, bev=0.0012, seg=2, x=0.0, cuts=None):
    """A side profile (points (y, z)) pushed out sideways, `half` its half width (a number, or a function of y),
    centred on `x`. `cuts`: shapes cut out of it before the bevel."""
    hw = half if callable(half) else (lambda y, h=half: h)
    o = _extrude(name, pts, lambda p: (x - hw(p[0]), p[0], p[1]), lambda p: (x + hw(p[0]), p[0], p[1]), mat)
    cut(o, cuts or [])
    return bevel(o, bev, seg)


def yprism(name, pts, y0, y1, mat, bev=0.0012, seg=2, cuts=None):
    """A section across the barrel (points (x, z)) pushed out along it from y0 to y1."""
    o = _extrude(name, pts, lambda p: (p[0], y0, p[1]), lambda p: (p[0], y1, p[1]), mat)
    cut(o, cuts or [])
    return bevel(o, bev, seg)


def zprism(name, pts, z0, z1, mat, bev=0.0012, seg=2, cuts=None):
    """A plan (points (x, y)) pushed out upwards from z0 to z1."""
    o = _extrude(name, pts, lambda p: (p[0], p[1], z0), lambda p: (p[0], p[1], z1), mat)
    cut(o, cuts or [])
    return bevel(o, bev, seg)


def block(name, x0, x1, y0, y1, z0, z1, mat, bev=0.0008, seg=1, cuts=None):
    return prism(name, [(y0, z0), (y1, z0), (y1, z1), (y0, z1)], (x1 - x0) / 2, mat, bev, seg, x=(x0 + x1) / 2, cuts=cuts)


def box(x0, x1, y0, y1, z0, z1):
    """A plain box to cut with."""
    return prism("cutbox", [(y0, z0), (y1, z0), (y1, z1), (y0, z1)], (x1 - x0) / 2, M["Dark"], 0, x=(x0 + x1) / 2)


def rbox(cx, cz, w, h, y0, y1, ang):
    """A box to cut with, w across and h high, centred on (cx, cz), turned by `ang` round the barrel's axis."""
    o = prism("cutbox", [(y0, cz - h / 2), (y1, cz - h / 2), (y1, cz + h / 2), (y0, cz + h / 2)], w / 2, M["Dark"], 0, x=cx)
    o.data.transform(Matrix.Translation((cx, 0, cz)) @ Matrix.Rotation(ang, 4, "Y") @ Matrix.Translation((-cx, 0, -cz)))
    return o


def chamfers(half, ztop, zbot, top, bot, y0, y1):
    """Cutters that chamfer the long edges of a part `half` wide between zbot and ztop (`top`, `bot`: the legs)."""
    out = []
    for s in (-1, 1):
        for c, z in ((top, ztop), (bot, zbot)):
            if c > 0:
                out.append(rbox(s * half, z, c * math.sqrt(2), c * math.sqrt(2), y0, y1, math.radians(45)))
    return out


def lathe(name, prof, mats, sides=24, at=(0.0, 0.0, 0.0), axis="y", turn=0.0, seg_mat=None, smooth_angle=35, loop=False, squash=1.0):
    """Turn a profile [(t, r), ...] round an axis through `at` ('y' along the barrel, 'x' across, 'z' up). The solid lies
    to the right of the profile as it is walked (the outside from back to front, the inside from front to back). A point
    with r = 0 closes the surface; `loop` joins the last point to the first (a tube with a wall). `seg_mat`: the material
    index of each step. `squash`: the second axis across stretched by this much (an oval)."""
    if loop:
        prof = list(prof) + [prof[0]]
    ax = {"y": (Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))),
          "x": (Vector((0, 1, 0)), Vector((1, 0, 0)), Vector((0, 0, 1))),
          "z": (Vector((1, 0, 0)), Vector((0, 0, 1)), Vector((0, 1, 0)))}[axis]
    U, A, V = ax
    c0 = Vector(at)
    bm = bmesh.new()
    rings = []
    for i, (t, r) in enumerate(prof):
        if loop and i == len(prof) - 1:
            rings.append(rings[0])
            continue
        if r <= 0:
            rings.append([bm.verts.new(c0 + A * t)])
            continue
        rings.append([bm.verts.new(c0 + A * t + (U * math.cos(2 * math.pi * k / sides + turn) + V * squash * math.sin(2 * math.pi * k / sides + turn)) * r)
                      for k in range(sides)])
    for i, (ra, rb) in enumerate(zip(rings, rings[1:])):
        (t0, r0), (t1, r1) = prof[i], prof[i + 1]
        dt, dr = t1 - t0, r1 - r0
        for k in range(sides):
            if len(ra) == 1 and len(rb) == 1:
                continue
            if len(ra) == 1:
                f = bm.faces.new((ra[0], rb[k], rb[(k + 1) % sides]))
            elif len(rb) == 1:
                f = bm.faces.new((ra[k], ra[(k + 1) % sides], rb[0]))
            else:
                f = bm.faces.new((ra[k], ra[(k + 1) % sides], rb[(k + 1) % sides], rb[k]))
            a = 2 * math.pi * (k + 0.5) / sides + turn
            radial = U * math.cos(a) + V * math.sin(a)
            want = A * (-dr) + radial * dt
            f.normal_update()
            if f.normal.dot(want) < 0:
                f.normal_flip()
            if seg_mat:
                f.material_index = seg_mat[i]
    o = mesh_obj(name, bm, mats if isinstance(mats, list) else [mats])
    return shade(o, smooth_angle)


def ring(name, t0, t1, r, mat, at, sides=24, axis="y", chamfer=0.0004):
    """A short closed cylinder with chamfered ends: a band, a collar, a screw head."""
    c = min(chamfer, (t1 - t0) / 3, r / 3)
    if c <= 0:
        return lathe(name, [(t0, 0), (t0, r), (t1, r), (t1, 0)], mat, sides, at, axis)
    return lathe(name, [(t0, 0), (t0, r - c), (t0 + c, r), (t1 - c, r), (t1, r - c), (t1, 0)], mat, sides, at, axis)


def band(name, y0, y1, r_in, r_out, mat, at, sides=32, chamfer=0.0008):
    """A ring laid round a barrel or a tube (r_in under its surface): its outer edges chamfered, where the paint wears
    first. Open underneath: its inside lies in the tube, never seen."""
    c = min(chamfer, (y1 - y0) / 3, (r_out - r_in) / 2)
    return lathe(name, [(y0, r_in), (y0, r_out - c), (y0 + c, r_out), (y1 - c, r_out), (y1, r_out - c), (y1, r_in)], mat, sides, at)


def shell(name, y0, y1, r0, r1, a0, a1, mat, at, steps=10, bev=0.001, cuts=None):
    """An arc of a tube's wall (radii r0 to r1) between angles a0 and a1 (degrees round the barrel; 0 to the right,
    90 up), from y0 to y1 round `at`: a pad laid on a tube."""
    cx, cz = at[0], at[2]
    outer = [(cx + r1 * math.cos(math.radians(a0 + (a1 - a0) * i / steps)), cz + r1 * math.sin(math.radians(a0 + (a1 - a0) * i / steps))) for i in range(steps + 1)]
    inner = [(cx + r0 * math.cos(math.radians(a1 - (a1 - a0) * i / steps)), cz + r0 * math.sin(math.radians(a1 - (a1 - a0) * i / steps))) for i in range(steps + 1)]
    o = yprism(name, outer + inner, y0, y1, mat, 0, 1, cuts)
    return bevel(o, bev, 2, 40)


def sweep(name, pts, radii, mat, sides=8):
    """A tube along a centre line with a radius per point, closed at both ends: a cable, a sling loop, a lever."""
    pts = [Vector(p) for p in pts]
    n = len(pts)
    tang = [(pts[min(n - 1, i + 1)] - pts[max(0, i - 1)]).normalized() for i in range(n)]
    up = Vector((0, 0, 1)) if abs(tang[0].z) < 0.9 else Vector((1, 0, 0))
    normal = tang[0].cross(up).normalized()
    frames = []
    for i in range(n):
        if i:
            axis = tang[i - 1].cross(tang[i])
            if axis.length > 1e-6:
                normal = (Matrix.Rotation(tang[i - 1].angle(tang[i]), 3, axis.normalized()) @ normal).normalized()
        frames.append((normal.copy(), tang[i].cross(normal).normalized()))
    bm = bmesh.new()
    rings = [[bm.verts.new(c + (f[0] * math.cos(2 * math.pi * k / sides) + f[1] * math.sin(2 * math.pi * k / sides)) * r)
              for k in range(sides)] for c, r, f in zip(pts, radii, frames)]
    for a, b in zip(rings, rings[1:]):
        for k in range(sides):
            bm.faces.new((a[k], a[(k + 1) % sides], b[(k + 1) % sides], b[k]))
    bm.faces.new(rings[-1])
    bm.faces.new(list(reversed(rings[0])))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = mesh_obj(name, bm, [mat])
    return shade(o, 60)


def knurl(name, t0, t1, r, depth, ridges, mat, at, axis="y", chamfer=0.0006):
    """A knob's knurled rim: `ridges` ridges `depth` deep round a cylinder from t0 to t1, its ends chamfered."""
    n = ridges * 2
    ax = {"y": (Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))),
          "x": (Vector((0, 1, 0)), Vector((1, 0, 0)), Vector((0, 0, 1))),
          "z": (Vector((1, 0, 0)), Vector((0, 0, 1)), Vector((0, 1, 0)))}[axis]
    U, A, V = ax
    c0 = Vector(at)
    bm = bmesh.new()
    rings = []
    for t, inset in ((t0, chamfer), (t0 + chamfer, 0), (t1 - chamfer, 0), (t1, chamfer)):
        rings.append([bm.verts.new(c0 + A * t + (U * math.cos(2 * math.pi * k / n) + V * math.sin(2 * math.pi * k / n)) * (r - (depth if k % 2 else 0) - inset))
                      for k in range(n)])
    for a, b in zip(rings, rings[1:]):
        for k in range(n):
            bm.faces.new((a[k], a[(k + 1) % n], b[(k + 1) % n], b[k]))
    bm.faces.new(rings[0])
    bm.faces.new(list(reversed(rings[-1])))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = mesh_obj(name, bm, [mat])
    return shade(o, 30)


def turned(obj, ang, axis, at):
    """Turn obj's points by `ang` (radians) round an axis ('X', 'Y', 'Z') through `at`."""
    at = Vector(at)
    obj.data.transform(Matrix.Translation(at) @ Matrix.Rotation(ang, 4, axis) @ Matrix.Translation(-at))
    return obj


def join(name, objs):
    objs = [o for o in objs if o]
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = objs[0]
    o.name = o.data.name = name
    o.select_set(False)
    return o


def pivot(obj, at):
    at = Vector(at)
    obj.data.transform(Matrix.Translation(-at))
    obj.location = at
    return obj


def empty(name, at):
    e = bpy.data.objects.new(name, None)
    e.location = Vector(at)
    e.empty_display_size = 0.01
    return link(e)


def gl(v):
    """A direction from Blender's frame to the GLB's (y up, barrel along -z)."""
    return [round(v[0], 4), round(v[2], 4), round(-v[1], 4)]


def screw(x, y, z, s, r=0.0021, sides=6):
    """A socket-head screw on a side face at x (s: -1 the left side, +1 the right), its head 1 mm proud."""
    h = 0.0011 * s
    return lathe("screw", [(0, 0), (0, r), (h, r * 0.8), (h, 0)] if s > 0 else [(h, 0), (h, r * 0.8), (0, r), (0, 0)], M["Dark"], sides, (x, y, z), "x")


def trigger_guard(name, y0, y1, ztop, zbot, half, t=0.004, mat=None):
    pts = [(y0 - 0.006, ztop - 0.012), (y0, zbot + 0.004), (y0 + 0.006, zbot), (y1 - 0.006, zbot), (y1, zbot + 0.006), (y1, ztop),
           (y1 - t, ztop), (y1 - t, zbot + t + 0.003), (y1 - t - 0.004, zbot + t), (y0 + 0.007, zbot + t), (y0 + t, zbot + t + 0.004), (y0 - 0.006 + t, ztop - 0.012)]
    return prism(name, pts, half, mat or M["Polymer"], 0.0008, 1)


def hopper(x, y, ztop, r):
    """Paintball's hopper standing on top at `ztop` (tools/weapons.py's, in these helpers): a rounded tub, a lid, a neck."""
    c = Vector((x, y, ztop + r * 1.15))
    neck = lathe("neck", [(ztop - 0.01, 0), (ztop - 0.01, r * 0.3), (ztop + r * 0.5, r * 0.3), (ztop + r * 0.5, 0)], M["KitTrim"], 12, (x, y, 0), "z")
    prof = [(-0.85, 0), (-0.85, 0.35), (-0.78, 0.7), (-0.55, 0.93), (-0.2, 1.0), (0.25, 0.97), (0.6, 0.85), (0.85, 0.62), (0.85, 0)]
    tub = lathe("hopper", [(c.z + r * t, r * s) for t, s in prof], M["Hopper"], 18, (c.x, c.y, 0), "z", squash=1.25, smooth_angle=60)
    lid = lathe("lid", [(c.z + r * 0.82, 0), (c.z + r * 0.82, r * 0.66), (c.z + r * 0.95, r * 0.6), (c.z + r * 1.0, r * 0.4), (c.z + r * 1.0, 0)], M["KitTrim"], 18,
                (c.x, c.y, 0), "z", squash=1.25, smooth_angle=60)
    return [neck, tub, lid]


# ---- The hands ---------------------------------------------------------------------------------

def weapons_hands():
    """tools/weapons.py's hands (its "Hands" part: the sculpted arms, real_hand, hand, Wrap), read from that file and run
    here with the helpers it uses, as tools/lasergun.py does: every gun's hands fitted one way, weapons.py unchanged."""
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


# ---- Putting a gun together, its bake and its file -------------------------------------------

def finish(w, grip, body, moving, muzzle, sight, kit, hands):
    """Join and name the parts (the frame of tools/weapons.py's header): `w`_body, each moving part `w`_<key> with its
    pivot and extras, `w`_muzzle, `w`_sight, `w`_kit, the hands under `w`_hands; the grip point made the origin."""
    g = Vector(grip)
    sizes = {}
    for o in body + [p for parts in moving.values() for p in parts[0]]:
        o.data.calc_loop_triangles()
        sizes[o.name.split(".")[0]] = sizes.get(o.name.split(".")[0], 0) + len(o.data.loop_triangles)
    print("largest parts:", sorted(sizes.items(), key=lambda kv: -kv[1])[:30])
    objs = [join(w + "_body", body)]
    for key, parts in moving.items():
        o = join(f"{w}_{key}", parts[0])
        pivot(o, parts[1])
        for k, v in (parts[2] if len(parts) > 2 else {}).items():
            o[k] = gl(Vector(v) - Vector(parts[1])) if k == "knob" else gl(Vector(v).normalized())
        objs.append(o)
    objs += [empty(w + "_muzzle", muzzle), empty(w + "_sight", sight)]
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
    tris = 0
    for o in objs:
        if o.type == "MESH":
            o.data.calc_loop_triangles()
            print(f"{o.name}: {len(o.data.loop_triangles)} triangles")
            if not o.name.endswith("_kit"):
                tris += len(o.data.loop_triangles)
    for h in hands:
        h.data.calc_loop_triangles()
        print(f"{h.name}: {len(h.data.loop_triangles)} triangles")
    print(f"{w}: gun {tris} triangles")
    return root


def bake_shade(root):
    """The gun's own shading per face corner, as tools/weapons.py and tools/lasergun.py bake it (gunSurface.ts reads it):
    red: how closed in the spot is, from a fixed set of rays over the gun's own parts; green: 1 on the thin bevels of the
    hard edges, where the finish wears first. The hands: one value per point, no worn edges."""
    from mathutils.bvhtree import BVHTree
    rays, reach = 24, 0.02
    dirs = []
    for i in range(rays):
        u, a = (i + 0.5) / rays, 2 * math.pi * ((i * 0.61803398875) % 1.0)
        dirs.append((math.sqrt(u) * math.cos(a), math.sqrt(u) * math.sin(a), math.sqrt(1 - u)))
    bpy.context.view_layer.update()
    hands = [h for e in root.children if e.name.endswith("_hands") for h in e.children if h.type == "MESH"]
    meshes = [o for o in root.children if o.type == "MESH"] + hands
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


def export(out, root, hands_ns):
    hands_ns["drop_arms"]()  # the sculpt out again before the bake and the export
    bake_shade(root)
    bpy.ops.object.select_all(action="SELECT")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                              export_extras=True, export_texcoords=True, export_cameras=False, export_lights=False,
                              export_vertex_color="ACTIVE", export_active_vertex_color_when_no_material=True)
    pack(out)
    print("written", out, os.path.getsize(out), "bytes")


def pack(path):
    """Make the GLB small, as tools/weapons.py does: positions as 16-bit integers (KHR_mesh_quantization), normals as
    signed bytes, the baked shading as two bytes (_SHADE), 16-bit indices."""
    import json
    import struct
    import numpy as np
    raw = open(path, "rb").read()
    jlen = struct.unpack("<I", raw[12:16])[0]
    g = json.loads(raw[20:20 + jlen])
    bin_ = raw[20 + jlen + 8:]
    comps = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}
    dtypes = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}

    def read(i):
        a = g["accessors"][i]
        bv = g["bufferViews"][a["bufferView"]]
        dt = np.dtype(dtypes[a["componentType"]])
        c = comps[a["type"]]
        start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        stride = bv.get("byteStride", dt.itemsize * c)
        return np.ndarray((a["count"], c), dtype=dt, buffer=bin_, offset=start, strides=(stride, dt.itemsize)).copy()

    out = bytearray()
    views, accs = [], []

    def put(arr, ctype, typ, target, normalized=False, stride=None):
        while len(out) % 4:
            out.append(0)
        data = arr.tobytes()
        views.append({"buffer": 0, "byteOffset": len(out), "byteLength": len(data), **({"byteStride": stride} if stride else {}),
                      **({"target": target} if target else {})})
        out.extend(data)
        acc = {"bufferView": len(views) - 1, "componentType": ctype, "count": int(arr.shape[0]), "type": typ}
        if normalized:
            acc["normalized"] = True
        accs.append(acc)
        return len(accs) - 1

    for mesh in g["meshes"]:
        for prim in mesh["primitives"]:
            at = prim["attributes"]
            pos = read(at["POSITION"]).astype(np.float64)
            assert np.abs(pos).max() < 0.999, f"{mesh['name']} reaches past a metre from its node"
            q = np.zeros((len(pos), 4), np.int16)
            q[:, :3] = np.round(pos * 32767).astype(np.int16)
            new = {"POSITION": put(q, 5122, "VEC3", 34962, True, 8)}
            accs[new["POSITION"]]["min"] = [int(x) for x in q[:, :3].min(0)]
            accs[new["POSITION"]]["max"] = [int(x) for x in q[:, :3].max(0)]
            nrm = read(at["NORMAL"]).astype(np.float64)
            n4 = np.zeros((len(nrm), 4), np.int8)
            n4[:, :3] = np.clip(np.round(nrm * 127), -127, 127).astype(np.int8)
            new["NORMAL"] = put(n4, 5120, "VEC3", 34962, True, 4)
            if "COLOR_0" in at:
                col = read(at["COLOR_0"]).astype(np.float64)
                col /= {5123: 65535.0, 5121: 255.0}.get(g["accessors"][at["COLOR_0"]]["componentType"], 1.0)
                s4 = np.zeros((len(col), 4), np.uint8)
                s4[:, :2] = np.clip(np.round(col[:, :2] * 255), 0, 255).astype(np.uint8)
                new["_SHADE"] = put(s4, 5121, "VEC2", 34962, True, 4)
            if "TEXCOORD_0" in at and g["materials"][prim["material"]]["name"] == "Glove":
                uvs = read(at["TEXCOORD_0"]).astype(np.float64)
                new["TEXCOORD_0"] = put(np.clip(np.round(uvs * 65535), 0, 65535).astype(np.uint16), 5123, "VEC2", 34962, True, 4)
            idx = read(prim["indices"]).reshape(-1)
            assert idx.max() < 65536, f"{mesh['name']} has too many points for 16-bit indices"
            prim["indices"] = put(idx.astype(np.uint16), 5123, "SCALAR", 34963)
            prim["attributes"] = new
    g["accessors"], g["bufferViews"] = accs, views
    g["buffers"] = [{"byteLength": len(out)}]
    for k in ("extensionsUsed", "extensionsRequired"):
        g[k] = sorted(set(g.get(k, [])) | {"KHR_mesh_quantization"})
    js = json.dumps(g, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    while len(out) % 4:
        out.append(0)
    glb = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(out)) + struct.pack("<II", len(js), 0x4E4F534A) + js + \
        struct.pack("<II", len(out), 0x004E4942) + bytes(out)
    open(path, "wb").write(glb)


# ---- Preview renders -------------------------------------------------------------------------

def previews(folder, w, root, hands, centre, views, hip, ads, size=(640, 360)):
    """Each view twice, in clay (one grey material, the shapes alone) and in the final materials, in a small studio; the
    player's views with the hands: `hip` (weapon.ts HIP: the grip's place from the hip, drawn as with a 54 degree view)
    and `ads` ((x, y, z) of the eye from the grip in Blender's frame, the view's height in degrees); each hand alone in
    clay. Small pictures: the graphics chip is shared."""
    os.makedirs(folder, exist_ok=True)
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = size
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
    ramp.color_ramp.elements.new(0.53).color = (0.9, 0.92, 0.95, 1)
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value, mr.inputs["From Max"].default_value = -1, 1
    nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    nt.links.new(sep.outputs["Z"], mr.inputs["Value"])
    nt.links.new(mr.outputs["Result"], ramp.inputs["Fac"])
    path = nt.nodes.new("ShaderNodeLightPath")
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    a_in, b_in = [i for i in mix.inputs if i.type == "RGBA"][:2]
    out = [o for o in mix.outputs if o.type == "RGBA"][0]
    b_in.default_value = (0.055, 0.058, 0.063, 1)
    nt.links.new(path.outputs["Is Camera Ray"], mix.inputs[0])
    nt.links.new(ramp.outputs["Color"], a_in)
    nt.links.new(out, nt.nodes["Background"].inputs["Color"])
    scene.world = world
    C = Vector(centre)

    def light(name, at, energy, size):
        d = bpy.data.lights.new(name, "AREA")
        d.energy = energy
        d.size = size
        o = link(bpy.data.objects.new(name, d))
        o.location = C + Vector(at)
        o.rotation_euler = (C - o.location).to_track_quat("-Z", "Y").to_euler()

    light("key", (-0.6, 0.4, 1.4), 120, 1.2)
    light("key2", (0.6, 0.2, 1.3), 70, 1.0)
    light("rim", (0.0, -1.4, 0.5), 60, 0.8)
    light("fill", (0.0, 1.4, -0.2), 25, 1.0)
    cam = link(bpy.data.objects.new("cam", bpy.data.cameras.new("cam")))
    scene.camera = cam

    def look(at, target, lens=50):
        cam.location = Vector(at)
        cam.data.sensor_fit = "AUTO"
        cam.data.lens = lens
        cam.data.clip_start = 0.01
        cam.rotation_euler = (Vector(target) - cam.location).to_track_quat("-Z", "Y").to_euler()

    shots = [(label, (lambda a=a, t=t, l=l: look(a, t, l))) for label, a, t, l in views]
    hx, hy, hz = hip
    hip_far = math.tan(math.radians(36)) / math.tan(math.radians(27))

    def eye(at, deg):
        cam.location = Vector(at)
        cam.rotation_euler = (math.radians(90), 0, 0)
        cam.data.sensor_fit = "VERTICAL"
        cam.data.angle_y = math.radians(deg)
        cam.data.clip_start = 0.07

    shots.append(("hip_eye", lambda: eye((-hx / 0.25, hz * hip_far / 0.25, -hy / 0.25), 54)))
    shots.append(("ads_eye", lambda: eye(ads[0], ads[1])))
    clay = bpy.data.materials.new("Clay")
    clay.use_nodes = True
    clay.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.55, 0.54, 0.52, 1)
    clay.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.65
    meshes = [o for o in root.children if o.type == "MESH"]
    kit = [o for o in meshes if o.name.endswith("_kit")]
    kept = {o.name: [s.material for s in o.material_slots] for o in meshes}
    paint = os.path.join(TOOLS, "..", "web", "public", "models", "glove_color.webp")
    if os.path.exists(paint):
        nodes = M["Glove"].node_tree.nodes
        tex = nodes.new("ShaderNodeTexImage")
        tex.image = bpy.data.images.load(paint)
        M["Glove"].node_tree.links.new(tex.outputs["Color"], nodes["Principled BSDF"].inputs["Base Color"])
    for k in kit:
        k.hide_render = True
    for mode in ("clay", "final"):
        for o in meshes:
            for s, m in zip(o.material_slots, kept[o.name]):
                s.material = clay if mode == "clay" else m
        for label, setup in shots:
            if mode == "clay" and label.endswith("_eye"):
                continue
            setup()
            for h in hands:
                h.hide_render = not label.endswith("_eye")
            scene.render.filepath = os.path.join(folder, f"{w}_{mode}_{label}.png")
            bpy.ops.render.render(write_still=True)
    # The paint look's kit, once: the gun from the left with its hopper.
    for k in kit:
        k.hide_render = False
    for h in hands:
        h.hide_render = True
    shots[0][1]()
    scene.render.filepath = os.path.join(folder, f"{w}_final_kit.png")
    bpy.ops.render.render(write_still=True)
    for k in kit:
        k.hide_render = True
    kept_h = [(h, [s.material for s in h.material_slots]) for h in hands]
    for h, _ in kept_h:
        for s in h.material_slots:
            s.material = clay
    for h in hands:
        near = [h.matrix_world @ v.co for v in h.data.vertices if v.co.length < 0.13]
        mid = sum(near, Vector()) / max(1, len(near))
        for other in hands:
            other.hide_render = other is not h
        for label, off in (("back", Vector((-0.04, -0.5, 0.3))), ("left", Vector((-0.6, -0.05, 0.1))), ("right", Vector((0.6, -0.05, 0.1))),
                           ("under", Vector((-0.1, -0.1, -0.6)))):
            look(mid + off, mid, 85)
            scene.render.filepath = os.path.join(folder, f"{h.name}_{label}.png")
            bpy.ops.render.render(write_still=True)
    print("previews in", folder)
