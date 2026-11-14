"""Shared parts of the two Tesla models (tools/model_y.py and tools/model_3.py), for Blender 5.

Each script builds its own body; these are the steps both take the same way:

- cut grooves, slots and recesses into the body with one boolean (`Cuts`), their walls flat-shaded, so
  a panel gap is a real groove and not a strip laid on the paint;
- flare the body round the wheel arches (`flare`) and lay a lip round each arch (`arch_lip`);
- a wheel with a tyre and a flat aero cover (`aero_wheel`) and a seat (`seat`);
- the far version: the same body at a few rings and points with four plain wheels (`far_car`);
- shading: weighted normals (`weighted_normals`) and the shade the car casts on itself and the
  ground under it, baked into a colour on each corner (`bake_ao`);
- small preview renders (`previews`) and the export (`export`).

Nothing here comes from a photo: the shapes are made from numbers in the two scripts.
"""
import math
import os

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree


def clamp01(v):
    return max(0.0, min(1.0, v))


def smooth(v):
    """0 below 0, 1 above 1, an S-curve between."""
    v = clamp01(v)
    return v * v * (3 - 2 * v)


def apply_mod(obj, mod):
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    obj.select_set(False)


# ---- Boolean cuts: grooves, slots, recesses.

def bar(samples, width, depth, out=0.04, extend=0.0):
    """A closed bar along a line on the surface, for a cut: `samples` are (point, outward normal) along the
    line; the bar is `width` across it (a number, or a function of 0..1 along it), from `out` over the
    surface to `depth` under it. `extend` lengthens it at both ends (m). Returns (verts, faces)."""
    samples = [s for s in samples if s]
    n = len(samples)
    if n < 2:
        return [], []
    # The hits' normals are their facets': smooth them along the line, or the bar twists from facet to facet.
    normals = [sum((samples[j][1] for j in range(max(0, i - 3), min(n, i + 4))), Vector()).normalized() for i in range(n)]
    samples = [(p, nn) for (p, _), nn in zip(samples, normals)]
    rows = []
    for i, (p, nrm) in enumerate(samples):
        a = samples[max(0, i - 1)][0]
        b = samples[min(n - 1, i + 1)][0]
        t = (b - a).normalized()
        s = nrm.cross(t).normalized()
        nn = t.cross(s).normalized()
        if nn.dot(nrm) < 0:
            nn = -nn
        if i == 0:
            p = p - t * extend
        elif i == n - 1:
            p = p + t * extend
        w = width(i / (n - 1)) if callable(width) else width
        rows.append([p + s * w / 2 + nn * out, p - s * w / 2 + nn * out, p - s * w / 2 - nn * depth, p + s * w / 2 - nn * depth])
    verts = [v for r in rows for v in r]
    faces = []
    for i in range(n - 1):
        for k in range(4):
            faces.append((4 * i + k, 4 * i + (k + 1) % 4, 4 * (i + 1) + (k + 1) % 4, 4 * (i + 1) + k))
    faces.append((3, 2, 1, 0))
    faces.append(tuple(4 * (n - 1) + k for k in range(4)))
    return verts, faces


class Cuts:
    """Bars to cut out of the body in one boolean. Each cut's walls get a material (by name) and are
    flat-shaded: their edges are marked sharp, so the paint round them keeps its smooth shading."""

    def __init__(self):
        self.parts = []  # (verts, faces, material name)

    def add(self, verts_faces, mat):
        verts, faces = verts_faces
        if faces:
            self.parts.append((verts, faces, mat))

    def apply(self, body, MAT, order):
        if not self.parts:
            return
        names = sorted({m for _, _, m in self.parts})
        bm = bmesh.new()
        for verts, faces, m in self.parts:
            vs = [bm.verts.new(v) for v in verts]
            for f in faces:
                face = bm.faces.new([vs[i] for i in f])
                face.material_index = names.index(m)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        me = bpy.data.meshes.new("cuts")
        bm.to_mesh(me)
        bm.free()
        temp = []
        for m in names:
            t = bpy.data.materials.new("Cut:" + m)
            temp.append(t)
            me.materials.append(t)
        cutter = bpy.data.objects.new("cuts", me)
        bpy.context.scene.collection.objects.link(cutter)
        mod = body.modifiers.new("cuts", "BOOLEAN")
        mod.operation = "DIFFERENCE"
        mod.solver = "EXACT"
        mod.object = cutter
        mod.use_self = True
        mod.material_mode = "TRANSFER"
        apply_mod(body, mod)
        bpy.data.objects.remove(cutter)
        # The cut's faces: their own material, flat-shaded; the slots past the body's own go.
        me = body.data
        bm = bmesh.new()
        bm.from_mesh(me)
        slot_names = [m.name if m else "" for m in me.materials]
        for f in bm.faces:
            name = slot_names[f.material_index]
            if name.startswith("Cut:"):
                for e in f.edges:
                    e.smooth = False
                f.material_index = order.index(name[4:])
            elif name not in order:
                f.material_index = order.index(name.split(".")[0]) if name.split(".")[0] in order else 0
            else:
                f.material_index = order.index(name)
        bm.to_mesh(me)
        bm.free()
        while len(me.materials) > len(order):
            me.materials.pop()
        for i, m in enumerate(order):
            me.materials[i] = MAT[m]
        for t in temp:
            bpy.data.materials.remove(t)
        self.parts = []


# ---- Wheel arches.

def flare(bm, axles, tyre_r, arch_r, amount, reach=0.16, z_max=1.0):
    """Push the body's sides out round each arch, before the arch is cut: by `amount` at the arch's edge,
    fading out over `reach`. `axles`: their positions along the car (Blender y)."""
    bm.normal_update()
    for v in bm.verts:
        nx = abs(v.normal.x)
        if nx < 0.3 or v.co.z > z_max or v.co.z < 0.05:
            continue
        d = min(math.hypot(v.co.y - y, v.co.z - tyre_r) for y in axles)
        k = 1 - smooth((d - arch_r) / reach)
        if k <= 0:
            continue
        w = smooth((nx - 0.3) / 0.4)
        v.co.x += math.copysign(amount * k * w, v.co.x)


def arch_lip(panel, B, ray, u_axle, tyre_r, r0, width, mat, out=0.006, a0=-30, a1=210, n=32):
    """A band round a wheel arch on the body (a lip): from radius r0 to r0 + width, lifted by `out`, laid
    with the script's `panel`. `ray(u, z)` casts at the body's side (u: m from the nose). Angles in degrees
    from the front of the arch, over the top to its back."""
    def hit(a, r):
        t = math.radians(a)
        return ray(u_axle - r * math.cos(t), tyre_r + r * math.sin(t))
    panel(B, hit, [a0 + (a1 - a0) * i / n for i in range(n + 1)], lambda a: [r0 + 0.001, r0 + width], mat,
          out=out, skirt=out)


# ---- Normals and shade.

def weighted_normals(obj):
    """Shade each corner by the faces round it weighted by their size; the sharp edges stay sharp."""
    mod = obj.modifiers.new("weighted", "WEIGHTED_NORMAL")
    mod.keep_sharp = True
    mod.mode = "FACE_AREA"
    mod.weight = 50
    apply_mod(obj, mod)


def _hemisphere(n):
    """n directions over the +z half sphere, cosine-weighted, the same every run."""
    out = []
    golden = math.pi * (3 - math.sqrt(5))
    for i in range(n):
        r = math.sqrt((i + 0.5) / n)
        a = golden * i
        out.append(Vector((r * math.cos(a), r * math.sin(a), math.sqrt(max(0.0, 1 - r * r)))))
    return out


def bake_ao(objs, blockers=(), ground=True, rays=24, reach=0.6, lo=0.3, skip=("Glass", "GlassDark")):
    """The shade each corner of `objs` gets from the car itself (and the ground under it): `rays` rays over
    its half sphere, against everything within `reach`; a corner every ray leaves gets 1, one every ray
    hits within a hair gets `lo`. Glass lets light through (the cabin is lit through the windows). Stored
    as the mesh's colour, which the export writes and the game multiplies the material by."""
    verts, polys = [], []
    for o in list(objs) + list(blockers):
        me = o.data
        M = o.matrix_world
        base = len(verts)
        verts += [M @ v.co for v in me.vertices]
        names = [m.name if m else "" for m in me.materials]
        for p in me.polygons:
            if names and names[p.material_index] in skip:
                continue
            polys.append([base + i for i in p.vertices])
    if ground:
        base = len(verts)
        verts += [Vector((-20, -20, 0)), Vector((20, -20, 0)), Vector((20, 20, 0)), Vector((-20, 20, 0))]
        polys.append([base, base + 1, base + 2, base + 3])
    tree = BVHTree.FromPolygons(verts, polys)
    dirs = _hemisphere(rays)
    for o in objs:
        me = o.data
        M = o.matrix_world
        R = M.to_3x3().inverted().transposed()
        # Each corner looks out along its faces' normals weighted by their size: the narrow walls of a
        # groove don't tilt the paint's edge into it.
        acc = [Vector() for _ in me.vertices]
        for p in me.polygons:
            for i in p.vertices:
                acc[i] += p.normal * p.area
        vals = []
        for v in me.vertices:
            n = (R @ (acc[v.index] if acc[v.index].length > 1e-12 else v.normal)).normalized()
            p = M @ v.co + n * 0.003
            t = Vector((1, 0, 0)) if abs(n.x) < 0.9 else Vector((0, 1, 0))
            a = n.cross(t).normalized()
            b = n.cross(a)
            hit = 0.0
            for d in dirs:
                w = a * d.x + b * d.y + n * d.z
                loc, _, _, dist = tree.ray_cast(p, w, reach)
                if loc is not None:
                    hit += 1 - 0.5 * dist / reach
            vals.append(lo + (1 - lo) * (1 - hit / rays))
        attr = me.color_attributes.new("AO", "BYTE_COLOR", "POINT")
        for i, val in enumerate(vals):
            attr.data[i].color = (val, val, val, 1.0)
        me.color_attributes.active_color = attr
        me.color_attributes.render_color_index = me.color_attributes.active_color_index


# ---- Wheel.

def aero_wheel(Builder, tyre_r, tyre_w, rim_r, seg=40, spokes=5, sweep=0.0, name="Wheel"):
    """One wheel (axle along x, its outside towards +x): a tyre with square shoulders, four tread grooves, a
    flat sidewall band and a rim guard; a narrow dark rim lip; a flat aero cover dished towards the middle
    with `spokes` raised spokes, each with a slot, and a plain cap; the brake disc behind. `sweep` (rad)
    bends the spokes round towards the lip (the Model 3's swept blades)."""
    W = Builder(name)
    hw = tyre_w / 2

    def ring(x, r, n):
        return [W.v((x, r * math.cos(2 * math.pi * k / n), r * math.sin(2 * math.pi * k / n))) for k in range(n)]

    def loft(profile, mat, n=seg, right=True, centre=None):
        rs = [ring(x, r, n) for x, r in profile]
        if centre is not None:
            c = W.v((centre, 0, 0))
            for k in range(n):
                W.face((c, rs[0][k], rs[0][(k + 1) % n]), mat, Vector((1, 0, 0)))
        for (xa, ra), (xb, rb), a, b in zip(profile, profile[1:], rs, rs[1:]):
            nx, nr = (rb - ra, -(xb - xa)) if right else (-(rb - ra), xb - xa)
            for k in range(n):
                th = 2 * math.pi * (k + 0.5) / n
                W.face((a[k], a[(k + 1) % n], b[(k + 1) % n], b[k]), mat, Vector((nx, nr * math.cos(th), nr * math.sin(th))))
        return rs

    # Tyre: outer bead, rim guard, flat sidewall band, square shoulder, tread with four grooves, the inner side.
    R = tyre_r
    side = [(hw - 0.020, rim_r + 0.004), (hw - 0.004, rim_r + 0.012), (hw - 0.002, rim_r + 0.022), (hw - 0.006, rim_r + 0.030),
            (hw, R - 0.060), (hw + 0.001, R - 0.035), (hw - 0.006, R - 0.012), (hw - 0.020, R - 0.002), (hw - 0.030, R)]
    tread = []
    for gx in (0.058, 0.020, -0.020, -0.058):
        g = gx * tyre_w / 0.255
        tread += [(g + 0.005, R), (g + 0.005, R - 0.008), (g - 0.005, R - 0.008), (g - 0.005, R)]
    inner = [(-hw + 0.030, R), (-hw + 0.004, R - 0.020), (-hw + 0.003, rim_r + 0.030), (-hw + 0.016, rim_r + 0.004)]
    loft(side + tread + inner, "Tyre")
    # Rim: a narrow dark lip at the tyre's bead, the barrel going in, closed at the back.
    lip_x = hw - 0.018
    loft([(lip_x - 0.002, rim_r + 0.004), (lip_x + 0.004, rim_r + 0.001), (lip_x + 0.005, rim_r - 0.006), (lip_x, rim_r - 0.012)],
         "RimDark", right=False)
    back = loft([(lip_x, rim_r - 0.012), (lip_x - 0.03, rim_r - 0.014), (-hw + 0.02, rim_r - 0.014)], "RimDark", right=False)[-1]
    W.face(back, "RimDark", Vector((1, 0, 0)))
    # Cover: a disc from the lip to the cap, dished 15 mm towards the middle.
    x_edge = lip_x - 0.004
    dish = lambda r: x_edge - 0.015 * (1 - smooth((r - 0.07) / (rim_r - 0.08)))
    rs = [rim_r - 0.012 - (rim_r - 0.012 - 0.075) * i / 7 for i in range(8)]
    loft([(dish(r), r) for r in rs], "RimDark", right=False)
    cap = dish(0.075)
    loft([(cap, 0.075), (cap + 0.006, 0.070), (cap + 0.009, 0.055)], "RimDark", n=seg, right=False, centre=cap + 0.010)
    # Spokes: raised bars from the cap to the lip, 60 mm wide, a slot down each.
    for sp in range(spokes):
        a0 = 2 * math.pi * sp / spokes
        rows = []
        steps = 8
        for i in range(steps + 1):
            t = i / steps
            r = 0.078 + (rim_r - 0.026 - 0.078) * t
            ang = a0 + sweep * t ** 1.5
            half = 0.030 / r * (0.8 + 0.2 * t)
            slot = 0.006 / r
            x0 = dish(r)
            lift = 0.007
            pts = [(x0, ang - half), (x0 + lift, ang - half + 0.004 / r), (x0 + lift, ang - slot), (x0 + lift - 0.004, ang - slot),
                   (x0 + lift - 0.004, ang + slot), (x0 + lift, ang + slot), (x0 + lift, ang + half - 0.004 / r), (x0, ang + half)]
            rows.append([W.v((x, r * math.cos(a), r * math.sin(a))) for x, a in pts])
        for i, (r0, r1) in enumerate(zip(rows, rows[1:])):
            ang = a0 + sweep * ((i + 0.5) / steps) ** 1.5
            tang = Vector((0, -math.sin(ang), math.cos(ang)))
            for k in range(len(r0) - 1):
                # The profile runs across the spoke over its top: its outside is to its right.
                d = r0[k + 1].co - r0[k].co
                ds, dx = d.dot(tang), d.x
                W.face((r0[k], r1[k], r1[k + 1], r0[k + 1]), "RimDark", tang * -dx + Vector((ds, 0, 0)))
        W.face(rows[0], "RimDark", -Vector((0, math.cos(a0), math.sin(a0))))
        W.face(rows[-1], "RimDark", Vector((0, math.cos(a0 + sweep), math.sin(a0 + sweep))))
    # Brake disc behind the cover (seen through nothing, but in the arch from low down).
    loft([(-0.02, 0.10), (-0.04, 0.11), (-0.04, rim_r - 0.07), (-0.065, rim_r - 0.07)], "Disc", n=24, centre=-0.02)
    obj = W.obj()
    me = obj.data
    me.set_sharp_from_angle(angle=math.radians(40))
    weighted_normals(obj)
    bpy.data.objects.remove(obj)
    return me


# ---- Cabin.

def seat(rbox, B, x, y_back, z_cushion, mat, width=0.50, back_h=0.78, lean=17, rear=False):
    """A seat: a cushion (the script's `rbox`) and a back with its headrest built in, each a rounded shape.
    `y_back`: where the back stands (Blender y), `z_cushion` the cushion's top. The back narrows to the headrest."""
    # Cushion: a rounded slab, its front edge raised a little.
    rbox(B, mat,(width, 0.50, 0.11), 0.045, Matrix.Translation((x, y_back + 0.29, z_cushion - 0.055)) @ Matrix.Rotation(math.radians(5), 4, "X"), segs=2)
    # Back: rounded sections up the back, wide at the shoulders, narrow at the headrest.
    tilt = math.radians(lean)
    prof = [(0.0, 0.92, 0.12), (0.25, 1.0, 0.13), (0.50, 1.0, 0.12), (0.64, 0.90, 0.10), (0.70, 0.56, 0.09),
            (0.76, 0.56, 0.10), (0.94, 0.58, 0.10), (1.0, 0.48, 0.08)]
    if rear:
        prof = [(0.0, 1.0, 0.12), (0.62, 1.0, 0.11), (0.70, 0.60, 0.09), (0.94, 0.60, 0.09), (1.0, 0.50, 0.07)]
    rings = []
    n = 12
    for t, wk, d in prof:
        h = t * back_h
        cy = y_back - math.sin(tilt) * h
        cz = z_cushion + math.cos(tilt) * h
        w = width * wk / 2
        ring = []
        for k in range(n):
            a = 2 * math.pi * k / n
            c, s = math.cos(a), math.sin(a)
            px = math.copysign(abs(c) ** 0.4, c) * w
            py = math.copysign(abs(s) ** 0.6, s) * d / 2
            ring.append(B.v((x + px, cy + py * math.cos(tilt), cz + py * math.sin(tilt))))
        rings.append((ring, Vector((x, cy, cz))))
    for (r0, c0), (r1, c1) in zip(rings, rings[1:]):
        for k in range(n):
            q = (r0[k], r0[(k + 1) % n], r1[(k + 1) % n], r1[k])
            mid = sum((v.co for v in q), Vector()) / 4
            B.face(q, mat, mid - (c0 + c1) / 2)
    B.face(rings[0][0], mat, Vector((0, 0, -1)))
    B.face(rings[-1][0], mat, Vector((0, 0, 1)))


# ---- Far version.

def far_car(name, L, section, rings_u, n_pts, material_of, wheels, tyre_r):
    """The car for seeing it far off: the body's own sections at `rings_u`, each resampled to `n_pts`
    points a side, closed at both ends; four 12-sided black wheels.
    `section(u)` gives a half section as (x, z) points from the bottom middle round to the top middle;
    `material_of(u, x, z, normal)` the material index of each face (called with None for the wheels);
    `wheels` the (x of the outer face, y of the axle) of each wheel: they show on the body's side."""
    bm = bmesh.new()
    rings = []
    for u in rings_u:
        half = section(u)
        # Resample the half section by its length to n_pts points.
        segs = [(half[i], half[i + 1]) for i in range(len(half) - 1)]
        lens = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in segs]
        total = sum(lens) or 1.0
        pts = []
        for j in range(n_pts):
            t = total * j / (n_pts - 1)
            acc = 0.0
            for (a, b), l in zip(segs, lens):
                if acc + l >= t - 1e-9 or (a, b) == segs[-1]:
                    q = 0.0 if l < 1e-9 else min(1.0, (t - acc) / l)
                    pts.append((a[0] + (b[0] - a[0]) * q, a[1] + (b[1] - a[1]) * q))
                    break
                acc += l
        full = pts + [(-x, z) for x, z in reversed(pts[1:-1])]
        rings.append([bm.verts.new((x, L / 2 - u, z)) for x, z in full])
    n = len(rings[0])
    for a, b in zip(rings, rings[1:]):
        for i in range(n):
            bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
    for ring, flip in ((rings[0], True), (rings[-1], False)):
        f = bm.faces.new(ring[::-1] if flip else ring)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    for f in bm.faces:
        c = f.calc_center_median()
        f.material_index = material_of(L / 2 - c.y, abs(c.x), c.z, f.normal)
    # Wheels: 12-sided black discs, as thick as the tyre.
    for wx, wy in wheels:
        ring_o, ring_i = [], []
        for k in range(12):
            a = 2 * math.pi * k / 12
            y, z = wy + tyre_r * math.cos(a), tyre_r + tyre_r * math.sin(a)
            ring_o.append(bm.verts.new((wx, y, z)))
            ring_i.append(bm.verts.new((wx - math.copysign(0.22, wx), y, z)))
        made = [bm.faces.new((ring_o[k], ring_i[k], ring_i[(k + 1) % 12], ring_o[(k + 1) % 12])) for k in range(12)]
        made += [bm.faces.new(ring_o), bm.faces.new(ring_i[::-1])]
        for f in made:
            f.material_index = material_of(None, None, None, None)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return me


# ---- Preview renders and export.

def previews(folder, views, L, paint_names=("Paint",)):
    """Small Eevee renders (800 x 450, 24 samples) under a plain sky with a bright horizon, the sun and a
    grey ground. `views`: (name, camera at, looking at, lens)."""
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = 24
    if hasattr(scene.eevee, "use_raytracing"):
        scene.eevee.use_raytracing = True
    scene.render.resolution_x, scene.render.resolution_y = 800, 450
    world = bpy.data.worlds.new("Sky")
    world.use_nodes = True
    nt = world.node_tree
    coord = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    rng = nt.nodes.new("ShaderNodeMapRange")
    rng.inputs["From Min"].default_value = -1
    nt.links.new(coord.outputs["Generated"], sep.inputs[0])
    nt.links.new(sep.outputs["Z"], rng.inputs["Value"])
    nt.links.new(rng.outputs["Result"], ramp.inputs["Fac"])
    els = ramp.color_ramp.elements
    els[0].position, els[0].color = 0.0, (0.05, 0.05, 0.045, 1)
    els[1].position, els[1].color = 1.0, (0.22, 0.36, 0.62, 1)
    for pos, col in ((0.495, (0.16, 0.155, 0.14, 1)), (0.505, (0.85, 0.87, 0.9, 1)), (0.62, (0.5, 0.62, 0.8, 1))):
        e = els.new(pos)
        e.color = col
    nt.links.new(ramp.outputs["Color"], nt.nodes["Background"].inputs["Color"])
    scene.world = world
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(48), 0, math.radians(35)))
    sun = bpy.context.active_object.data
    sun.energy = 4.0
    sun.angle = math.radians(2)
    bpy.ops.mesh.primitive_plane_add(size=300)
    g = bpy.data.materials.new("Ground")
    g.use_nodes = True
    g.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.16, 0.16, 0.155, 1)
    bpy.context.active_object.data.materials.append(g)
    for name, alpha in (("Glass", 0.55), ("GlassDark", 0.9)):
        if name in bpy.data.materials:
            m = bpy.data.materials[name]
            m.node_tree.nodes["Principled BSDF"].inputs["Alpha"].default_value = alpha
            if hasattr(m, "surface_render_method"):
                m.surface_render_method = "BLENDED"
    # The baked shade multiplies the paint, as in the game.
    for m in bpy.data.materials:
        if os.environ.get("CAR_PREVIEW_NO_SHADE") or not m.use_nodes or m.name in("Ground", "Glass", "GlassDark", "LightBar", "TailLight"):
            continue
        nt = m.node_tree
        p = nt.nodes.get("Principled BSDF")
        if not p:
            continue
        attr = nt.nodes.new("ShaderNodeAttribute")
        attr.attribute_name = "AO"
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        mix.inputs[6].default_value = p.inputs["Base Color"].default_value
        nt.links.new(attr.outputs["Color"], mix.inputs[7])
        nt.links.new(mix.outputs[2], p.inputs["Base Color"])
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    os.makedirs(folder, exist_ok=True)
    for label, at, look, lens in views:
        cam.location = at
        cam.data.lens = lens
        cam.rotation_euler = (Vector(look) - Vector(at)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(folder, f"{label}.png")
        bpy.ops.render.render(write_still=True)


def export(objs, out):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                              export_texcoords=False, export_cameras=False, export_lights=False,
                              export_vertex_color="ACTIVE", export_all_vertex_colors=False)


def triangles(objs):
    return sum(len(p.vertices) - 2 for o in objs for p in o.data.polygons)
