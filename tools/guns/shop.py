"""The workshop the pistol's and the pump shotgun's scripts share (tools/guns/pistol.py, tools/guns/shotgun.py).

Not run by itself: each gun's script resets Blender, imports this, sets its materials in `M` and builds from these
helpers. The shapes are tools/lasergun.py's own (prism, lathe, ring, sweep, the cuts and the bevels) and its
packing of the file, read from that file's function definitions as they are, so the guns are built the same way and
lasergun.py stays as it is; the hands are tools/weapons.py's (its "Hands" part, as lasergun.py runs it). Added here:
a loft of rounded sections (a wooden stock), raised texture laid on a surface (a grip's stippling, a wrist's
checkering), the join of a gun under its nodes, the baked shading the game reads, and the preview pictures.
"""
import ast
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Quaternion, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
scene = bpy.context.scene
M = {}  # the gun's materials by key; each gun's script fills it before it builds

# lasergun.py's helpers, taken from its definitions alone (none of its building runs): they live in this module and
# use its `M` and `scene`.
_BORROW = {"srgb", "material", "link", "mesh_obj", "apply_mod", "shade", "bevel", "cut", "prism", "block", "box", "dark", "rbox",
           "zbox", "chamfers", "lathe", "ring", "sweep", "join", "pivot", "empty", "gl", "pack"}
_laser = os.path.join(TOOLS, "lasergun.py")
_tree = ast.parse(open(_laser, encoding="utf-8").read())
_defs = [n for n in _tree.body if isinstance(n, ast.FunctionDef) and n.name in _BORROW]
assert {n.name for n in _defs} == _BORROW, f"lasergun.py lacks {_BORROW - {n.name for n in _defs}}"
exec(compile(ast.Module(body=_defs, type_ignores=[]), _laser, "exec"), globals())


def clean(obj):
    """Weld the points a cut left on top of each other and dissolve the slivers of no area it made where its faces met
    the part's own edges: the next cut needs a closed, clean shape, or it fails and leaves its own faces behind."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.dissolve_degenerate(bm, dist=1e-6, edges=bm.edges)
    bm.to_mesh(obj.data)
    bm.free()


def cut(obj, cutters):
    """lasergun.py's cut (each cutter in turn; a dark() cutter's faces dark), cleaned after each cut. Replaces the
    borrowed one, so prism's cuts go through it."""
    for c in cutters:
        if not c.get("dark"):
            c.data.materials[0] = obj.data.materials[0]
        apply_mod(obj, "BOOLEAN", operation="DIFFERENCE", object=c, solver="EXACT", material_mode="TRANSFER")
        bpy.data.objects.remove(c, do_unlink=True)
        clean(obj)
    if cutters and not obj.data.polygons:
        raise RuntimeError(f"{obj.name}: the cuts left nothing")
    return obj


def hands_kit():
    """tools/weapons.py's "Hands" part (the sculpted arms, Wrap, real_hand, hand, drop_arms), run as lasergun.py runs it."""
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


def screw(x, y, z, s, r=0.0021, mat=None, sides=6):
    """A screw or pin head on a side face at x (s: -1 left, +1 right), standing 1 mm proud."""
    h = 0.0011 * s
    prof = [(0, 0), (0, r), (h, r * 0.8), (h, 0)] if s > 0 else [(h, 0), (h, r * 0.8), (0, r), (0, 0)]
    return lathe("screw", prof, mat or M["Dark"], sides, (x, y, z), "x")


def pin(x, y, z, s, r=0.0022, mat=None):
    """A cross pin's end, flush but for a 0.3 mm dome, with a dark ring round it (the hole it sits in)."""
    h = 0.0004 * s
    out = [lathe("pinring", [(0, 0), (0, r + 0.0006), (h * 0.5, r + 0.0006), (h * 0.5, 0)] if s > 0 else
                 [(h * 0.5, 0), (h * 0.5, r + 0.0006), (0, r + 0.0006), (0, 0)], M["Dark"], 14, (x, y, z), "x")]
    prof = [(0, 0), (0, r), (h, r * 0.75), (h * 1.6, 0)] if s > 0 else [(h * 1.6, 0), (h, r * 0.75), (0, r), (0, 0)]
    out.append(lathe("pin", prof, mat or M["Steel"], 14, (x + 0.0001 * s, y, z), "x", smooth_angle=60))
    return out


def loft(name, sections, mat, sides=28, power=2.6):
    """A smooth body through cross-sections along y, closed at both ends: each (y, zbot, ztop, half width, top) a
    rounded section (a superellipse of `power`) from zbot to ztop, `half width` across its middle and below it, and
    narrowing above it to `top` times that at the top (a stock's comb is narrower than its belly). A sixth value, when
    there, is that section's own power (squarer where a stock meets a receiver). A wooden stock."""
    bm = bmesh.new()
    rings = []
    for sec in sections:
        y, zb, zt, hw, top = sec[:5]
        pw = sec[5] if len(sec) > 5 else power
        zc, hz = (zb + zt) / 2, (zt - zb) / 2
        ring = []
        for k in range(sides):
            a = 2 * math.pi * k / sides
            c, s = math.cos(a), math.sin(a)
            zz = math.copysign(abs(s) ** (2 / pw), s)
            w = hw * (1 + (top - 1) * max(0.0, zz))
            ring.append(bm.verts.new((w * math.copysign(abs(c) ** (2 / pw), c), y, zc + hz * zz)))
        rings.append(ring)
    for a, b in zip(rings, rings[1:]):
        for k in range(sides):
            bm.faces.new((a[k], a[(k + 1) % sides], b[(k + 1) % sides], b[k]))
    bm.faces.new(rings[0])
    bm.faces.new(list(reversed(rings[-1])))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = mesh_obj(name, bm, [mat])
    for p in o.data.polygons:
        p.use_smooth = True
    return o


def inside(pt, poly):
    """Whether the point (a, b) lies inside the polygon [(a, b), ...]."""
    a, b = pt
    n, ins = len(poly), False
    for i in range(n):
        (a0, b0), (a1, b1) = poly[i], poly[(i + 1) % n]
        if (b0 > b) != (b1 > b) and a < a0 + (b - b0) * (a1 - a0) / (b1 - b0):
            ins = not ins
    return ins


def texture(name, target, outline, side, mat, pitch=0.0028, height=0.0005, diamond=1.0, turn=0.0, fill=0.92, tile=False):
    """Raised texture laid on the side of `target` (side -1 the left, +1 the right): little four-sided points in a
    grid inside `outline` ((y, z) points), each found on the surface by a ray from the side and stood on it along its
    normal. A square grid (diamond 1) is a grip's stippling; drawn out along y (diamond over 1) and turned 45 degrees
    it is a wooden wrist's checkering, the points' ridges the lines left between the cut grooves (`tile`: the rows
    staggered half a point, so the diamonds meet edge to edge as cut checkering does)."""
    from mathutils.bvhtree import BVHTree
    bpy.context.view_layer.update()
    me = target.data
    tree = BVHTree.FromPolygons([target.matrix_world @ v.co for v in me.vertices], [list(p.vertices) for p in me.polygons])
    ys = [p[0] for p in outline]
    zs = [p[1] for p in outline]
    du = Vector((0, math.cos(turn), math.sin(turn)))  # the grid's two ways on the side, in (y, z)
    dv = Vector((0, -math.sin(turn), math.cos(turn)))
    pu, pv = pitch * diamond, pitch
    span = max(max(ys) - min(ys), max(zs) - min(zs)) * 1.5
    c0 = Vector((0, (max(ys) + min(ys)) / 2, (max(zs) + min(zs)) / 2))
    bm = bmesh.new()
    cu = pu / 2 if tile else pu  # how far apart the columns are
    nu, nv = int(span / cu) + 1, int(span / pv) + 1
    for i in range(-nu, nu + 1):
        for j in range(-nv, nv + 1):
            c = c0 + du * (i * cu) + dv * (j * pv + (pv / 2 if i % 2 else 0))
            if not inside((c.y, c.z), outline):
                continue
            hit = tree.ray_cast(Vector((side * 0.2, c.y, c.z)), Vector((-side, 0, 0)), 0.4)
            if hit[0] is None:
                continue
            p, n = hit[0], hit[1]
            if n.x * side < 0.3:  # only on the side, not over its rounded edge
                continue
            # The point's base, on the surface and a hair inside it, its corners along the grid's two ways.
            a = (du - n * du.dot(n)).normalized() * (pu * fill / 2)
            b = (dv - n * dv.dot(n)).normalized() * (pv * fill / 2)
            base = p - n * 0.0002
            vs = [bm.verts.new(base + a), bm.verts.new(base + b), bm.verts.new(base - a), bm.verts.new(base - b)]
            tip = bm.verts.new(p + n * height)
            for k in range(4):
                bm.faces.new((vs[k], vs[(k + 1) % 4], tip))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = mesh_obj(name, bm, [mat])
    o.data.set_sharp_from_angle(angle=math.radians(1))
    return o


def grooves(name, target, outline, side, mat, pitch=0.0026, width=0.0006, turns=(30.0, -30.0), step=0.004, lift=0.00006, border=0.0008):
    """Fine lines laid on the side of `target` (side -1 the left, +1 the right) inside `outline` ((y, z) points): two
    families of parallel lines `pitch` apart, at the angles `turns` (degrees from the barrel's line), each a strip
    `width` wide that follows the surface (found by rays from the side) a hair above it, and a line round the
    outline. In a dark finish on wood they are a wrist's checkering: the cut grooves read as a darker diamond grid. They
    stand out by almost nothing, so no edge of them shows past the part's outline from any side."""
    from mathutils.bvhtree import BVHTree
    bpy.context.view_layer.update()
    me = target.data
    tree = BVHTree.FromPolygons([target.matrix_world @ v.co for v in me.vertices], [list(p.vertices) for p in me.polygons])
    ys = [p[0] for p in outline]
    zs = [p[1] for p in outline]
    c0 = Vector((0, (max(ys) + min(ys)) / 2, (max(zs) + min(zs)) / 2))
    span = max(max(ys) - min(ys), max(zs) - min(zs)) * 0.8
    bm = bmesh.new()

    def hit(y, z):
        h = tree.ray_cast(Vector((side * 0.2, y, z)), Vector((-side, 0, 0)), 0.4)
        return h if h[0] is not None and h[1].x * side > 0.2 else None

    def strip(points):
        """A strip along consecutive surface points [(p, n, d)], d the line's way."""
        prev = None
        for p, n, d in points:
            e = n.cross(d).normalized() * (width / 2)
            a, b = bm.verts.new(p + n * lift - e), bm.verts.new(p + n * lift + e)
            if prev:
                f = bm.faces.new((prev[0], prev[1], b, a))
                f.normal_update()
                if f.normal.dot(n) < 0:  # each strip faces out of the surface
                    f.normal_flip()
            prev = (a, b)

    for deg in turns:
        d = Vector((0, math.cos(math.radians(deg)), math.sin(math.radians(deg))))
        e = Vector((0, -d.z, d.y))
        k = -int(span / pitch) - 1
        while k * pitch <= span:
            run = []
            t = -span
            while t <= span:
                q = c0 + e * (k * pitch) + d * t
                h = hit(q.y, q.z) if inside((q.y, q.z), outline) else None
                if h:
                    run.append((h[0], h[1], d))
                elif run:
                    if len(run) > 1:
                        strip(run)
                    run = []
                t += step
            if len(run) > 1:
                strip(run)
            k += 1
    # The border: the outline itself, inset a little.
    pts = []
    n_out = len(outline)
    for i in range(n_out):
        (y0, z0), (y1, z1) = outline[i % n_out], outline[(i + 1) % n_out]
        seg = math.hypot(y1 - y0, z1 - z0)
        for j in range(max(1, int(seg / step))):
            f = j / max(1, int(seg / step))
            q = c0 + (Vector((0, y0 + (y1 - y0) * f, z0 + (z1 - z0) * f)) - c0) * 0.97
            h = hit(q.y, q.z)
            if h:
                pts.append((h[0], h[1], Vector((0, y1 - y0, z1 - z0)).normalized()))
    width = border  # the strips read it when they are made
    strip(pts + pts[:1])
    o = mesh_obj(name, bm, [mat])
    for p in o.data.polygons:
        p.use_smooth = True
    return o


def finish(w, grip, body, moving, muzzle, sight, kit, hands):
    """Join and name a gun's parts as tools/weapons.py's finish does, move it so `grip` is the origin, hang it under an
    empty. `moving`: {key: (parts, pivot, {"out": a way})}."""
    g = Vector(grip)
    sizes = {}
    for o in body + [p for parts in moving.values() for p in parts[0]]:
        o.data.calc_loop_triangles()
        sizes[o.name.split(".")[0]] = sizes.get(o.name.split(".")[0], 0) + len(o.data.loop_triangles)
    print("largest parts:", sorted(sizes.items(), key=lambda kv: -kv[1])[:14])
    objs = [join(w + "_body", body)]
    for key, parts in moving.items():
        o = join(f"{w}_{key}", parts[0])
        pivot(o, parts[1])
        for k, v in (parts[2] if len(parts) > 2 else {}).items():
            o[k] = gl(Vector(v).normalized())
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
    objs.append(hand_root)
    for h in hands:
        h.location -= g
        h.parent = hand_root
    root = empty(w, (0, 0, 0))
    for o in objs:
        o.parent = root
    tris = 0
    for o in [*objs, *hands]:
        if o.type == "MESH":
            o.data.calc_loop_triangles()
            if o not in hands and not o.name.endswith("_kit"):
                tris += len(o.data.loop_triangles)
            print(f"{o.name}: {len(o.data.loop_triangles)} triangles")
    print(f"{w}: gun {tris} triangles")
    return root


def bake_shade(root):
    """The gun's own shading per face corner, as tools/weapons.py and lasergun.py bake it (gunSurface.ts reads it): red,
    how closed in the spot is, from a fixed set of rays over the gun's own parts; green, 1 on the thin bevels of the
    hard edges, where the finish wears first. The hands one value per point, no worn edges. Not Paintball's kit."""
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


def export(out):
    """The whole scene to the GLB, then packed small (lasergun.py's pack)."""
    bpy.ops.object.select_all(action="SELECT")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                              export_extras=True, export_texcoords=True, export_cameras=False, export_lights=False,
                              export_vertex_color="ACTIVE", export_active_vertex_color_when_no_material=True)
    pack(out)
    print("written", out, os.path.getsize(out), "bytes")


def previews(w, root, hands, folder, centre, views, hip, ads, size=(640, 360)):
    """Small Eevee pictures, as lasergun.py renders them: each view in clay (one grey, the shapes alone) and in the
    materials; `hip` and `ads` (the player's views, camera place and height of view in degrees) with the hands; then
    each hand alone in clay. `views`: [(label, camera place, look at)], in the GLB's place (grip at the origin)."""
    os.makedirs(folder, exist_ok=True)
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = size
    try:
        scene.eevee.taa_render_samples = 16
        scene.eevee.use_raytracing = True
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
        o.location = Vector(at)
        o.rotation_euler = (C - o.location).to_track_quat("-Z", "Y").to_euler()

    light("key", C + Vector((-0.6, 0.4, 1.4)), 120, 1.2)
    light("key2", C + Vector((0.6, 0.2, 1.3)), 70, 1.0)
    light("rim", C + Vector((0.0, -1.4, 0.5)), 60, 0.8)
    light("fill", C + Vector((0.0, 1.4, -0.2)), 25, 1.0)
    cam = link(bpy.data.objects.new("cam", bpy.data.cameras.new("cam")))
    scene.camera = cam

    def look(at, target, lens=50):
        cam.location = Vector(at)
        cam.data.sensor_fit = "AUTO"
        cam.data.lens = lens
        cam.data.clip_start = 0.01
        cam.rotation_euler = (Vector(target) - cam.location).to_track_quat("-Z", "Y").to_euler()

    def eye(at, deg):
        cam.location = Vector(at)
        cam.rotation_euler = (math.radians(90), 0, 0)
        cam.data.sensor_fit = "VERTICAL"
        cam.data.angle_y = math.radians(deg)
        cam.data.clip_start = 0.07

    shots = [(label, (lambda a=a, t=t, lens=lens: look(a, t, lens))) for label, a, t, lens in views]
    shots.append(("hip_eye", lambda: eye(*hip)))
    shots.append(("ads_eye", lambda: eye(*ads)))
    clay = bpy.data.materials.new("Clay")
    clay.use_nodes = True
    clay.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.55, 0.54, 0.52, 1)
    clay.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.65
    meshes = [o for o in root.children if o.type == "MESH" and not o.name.endswith("_kit")]
    for o in root.children:
        if o.name.endswith("_kit"):
            o.hide_render = True
    kept = {o.name: [s.material for s in o.material_slots] for o in meshes}
    paint = os.path.join(TOOLS, "..", "web", "public", "models", "glove_color.webp")
    if os.path.exists(paint) and "Glove" in M:
        nodes = M["Glove"].node_tree.nodes
        tex = nodes.new("ShaderNodeTexImage")
        tex.image = bpy.data.images.load(paint)
        M["Glove"].node_tree.links.new(tex.outputs["Color"], nodes["Principled BSDF"].inputs["Base Color"])
    every = [h for h in hands] + [c for h in hands for c in h.children]
    for mode in ("clay", "final"):
        for o in meshes:
            for s, m in zip(o.material_slots, kept[o.name]):
                s.material = clay if mode == "clay" else m
        for label, setup in shots:
            setup()
            for h in every:
                h.hide_render = label not in ("hip_eye", "ads_eye")
            scene.render.filepath = os.path.join(folder, f"{w}_{mode}_{label}.png")
            bpy.ops.render.render(write_still=True)
    kept_h = [(h, [s.material for s in h.material_slots]) for h in hands]
    for h, _ in kept_h:
        for s in h.material_slots:
            s.material = clay
    for h in hands:
        near = [h.matrix_world @ v.co for v in h.data.vertices if v.co.length < 0.13]
        centre_h = sum(near, Vector()) / max(1, len(near))
        for other in every:
            other.hide_render = other is not h
        for o in meshes:
            o.hide_render = False
        for label, off in (("back", Vector((-0.04, -0.5, 0.3))), ("left", Vector((-0.6, -0.05, 0.1))), ("right", Vector((0.6, -0.05, 0.1))),
                           ("under", Vector((-0.1, -0.1, -0.6)))):
            look(centre_h + off, centre_h, 85)
            scene.render.filepath = os.path.join(folder, f"{h.name}_{label}.png")
            bpy.ops.render.render(write_still=True)
    for h, mats in kept_h:
        for s, m in zip(h.material_slots, mats):
            s.material = m
    print("previews in", folder)
