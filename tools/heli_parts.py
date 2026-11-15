"""Helpers for the helicopter (tools/helicopter.py), for Blender 5.

Everything here works in the game's axes: x to the right, y up, z to the back (the nose looks along -z).
`G()` turns such a point into Blender's axes (x, -z, y); the glTF export turns it back. The shared steps of
the two Teslas (grooves cut in one boolean, weighted normals, the baked shade, the export) come from
tools/car_parts.py, which is imported and left as it is.

Nothing here comes from a photo: the shapes are made from numbers in tools/helicopter.py.
"""
import math
import os

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

import car_parts as cp

clamp01 = cp.clamp01
smooth = cp.smooth

# Game axes (x right, y up, z back) to Blender's (x, y forward, z up), as a matrix and for a point.
MG = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))


def G(x, y=None, z=None):
    """A point (or direction) in the game's axes as a Blender vector."""
    if y is None:
        x, y, z = x
    return Vector((x, -z, y))


def ungame(v):
    """A Blender vector back in the game's axes."""
    return Vector((v.x, v.z, -v.y))


def curve(points):
    """A smooth curve through (u, value) points without overshoot (a monotone cubic), as in model_y.py."""
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
            return ys[0] + m[0] * (u - xs[0])
        if u >= xs[-1]:
            return ys[-1] + m[-1] * (u - xs[-1])
        lo, hi = 0, n - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if xs[mid] <= u:
                lo = mid
            else:
                hi = mid
        i = lo
        h = xs[i + 1] - xs[i]
        t = (u - xs[i]) / h
        h00, h10, h01, h11 = 2 * t**3 - 3 * t**2 + 1, t**3 - 2 * t**2 + t, -2 * t**3 + 3 * t**2, t**3 - t**2
        return h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1]

    return f


def ease(q, p):
    """A quarter superellipse: 0 at q=0 rising steeply, 1 at q=1 arriving level."""
    q = clamp01(q)
    return (1 - (1 - q) ** p) ** (1 / p)


def lerp(a, b, t):
    return a + (b - a) * t


def resample(pts, n):
    """A polyline of 2D points resampled by its length to n points (the ends kept)."""
    lens = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:])]
    total = sum(lens) or 1.0
    out = []
    k, acc = 0, 0.0
    for j in range(n):
        t = total * j / (n - 1)
        while k < len(lens) - 1 and acc + lens[k] < t:
            acc += lens[k]
            k += 1
        q = 0.0 if lens[k] < 1e-12 else clamp01((t - acc) / lens[k])
        a, b = pts[k], pts[k + 1]
        out.append((a[0] + (b[0] - a[0]) * q, a[1] + (b[1] - a[1]) * q))
    return out


def chaikin(pts, rounds=2, closed=True):
    """Corners cut off a polyline (rounded), `rounds` times."""
    p = list(pts)
    for _ in range(rounds):
        q = []
        rng = range(len(p)) if closed else range(len(p) - 1)
        for i in rng:
            a, b = p[i], p[(i + 1) % len(p)]
            q.append((0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]))
            q.append((0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]))
        if not closed:
            q = [p[0]] + q + [p[-1]]
        p = q
    return p


def inside(pt, poly):
    """Is a 2D point inside a closed polygon (even-odd)?"""
    x, y = pt
    c = False
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % n]
        if (y0 > y) != (y1 > y):
            if x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
                c = not c
    return c


def rounded_rect(a0, a1, b0, b1, r, n=4):
    """A closed rounded rectangle from (a0, b0) to (a1, b1) as a point list (counterclockwise)."""
    pts = []
    for ca, cb, start in ((a1 - r, b1 - r, 0), (a0 + r, b1 - r, 90), (a0 + r, b0 + r, 180), (a1 - r, b0 + r, 270)):
        for i in range(n + 1):
            t = math.radians(start + 90 * i / n)
            pts.append((ca + r * math.cos(t), cb + r * math.sin(t)))
    return pts


def offset_poly(poly, d):
    """A closed polygon moved inwards by d (outwards for d < 0), each corner along its bisector."""
    n = len(poly)
    area = sum(poly[i][0] * poly[(i + 1) % n][1] - poly[(i + 1) % n][0] * poly[i][1] for i in range(n))
    sgn = 1 if area > 0 else -1  # counterclockwise: the inside is to the left
    out = []
    for i in range(n):
        a, b, c = poly[i - 1], poly[i], poly[(i + 1) % n]
        e0 = Vector((b[0] - a[0], b[1] - a[1]))
        e1 = Vector((c[0] - b[0], c[1] - b[1]))
        if e0.length < 1e-9 or e1.length < 1e-9:
            out.append(b)
            continue
        e0.normalize()
        e1.normalize()
        n0 = Vector((-e0.y, e0.x)) * sgn
        n1 = Vector((-e1.y, e1.x)) * sgn
        bis = n0 + n1
        if bis.length < 1e-6:
            bis = n0
        bis.normalize()
        k = d / max(0.3, bis.dot(n0))
        out.append((b[0] + bis.x * k, b[1] + bis.y * k))
    return out


# ---- Materials.

def srgb(h):
    """'#rrggbb' to linear RGB."""
    h = h.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)


def material(name, color, rough=0.5, metal=0.0, emit=None, strength=0.0, coat=0.0, alpha=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    if coat:
        p.inputs["Coat Weight"].default_value = coat
    if emit:
        p.inputs["Emission Color"].default_value = (*emit, 1)
        p.inputs["Emission Strength"].default_value = strength
    if alpha < 1:
        p.inputs["Alpha"].default_value = alpha
        if hasattr(m, "surface_render_method"):
            m.surface_render_method = "BLENDED"
    return m


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


# ---- A mesh made of many parts, built in the game's axes.

class Builder:
    """A mesh made of many small parts, each face with its material; points in the game's axes."""

    def __init__(self, name, MAT):
        self.name = name
        self.MAT = MAT
        self.bm = bmesh.new()
        self.mats = []

    def v(self, co):
        return self.bm.verts.new(G(co))

    def mat_index(self, mat):
        if mat not in self.mats:
            self.mats.append(mat)
        return self.mats.index(mat)

    def face(self, vs, mat, hint=None):
        """A face; `hint` (game axes) is roughly its outward direction: the face is turned to it."""
        f = self.bm.faces.new(vs)
        f.material_index = self.mat_index(mat)
        if hint is not None:
            f.normal_update()
            if f.normal.dot(G(hint)) < 0:
                f.normal_flip()
        return f

    def merge(self, other, mat=None, matrix=None):
        """Copy a bmesh in (its points in the game's axes, moved by `matrix`); its faces keep their winding."""
        vmap = {}
        for v in other.verts:
            co = (matrix @ v.co) if matrix is not None else v.co
            vmap[v] = self.v(co)
        flip = matrix is not None and matrix.to_3x3().determinant() < 0
        for f in other.faces:
            vs = [vmap[v] for v in f.verts]
            if flip:
                vs.reverse()
            nf = self.bm.faces.new(vs)
            nf.material_index = self.mat_index(mat)

    def grid(self, rows, mat_of, closed=True, hint_of=None):
        """Quads between rows of points (each row a list of BMVerts); closed: each row is a loop.
        mat_of(i, j) gives the material of the quad from row i point j; hint_of(i, j, centre) its outward
        direction (game axes)."""
        faces = []
        for i in range(len(rows) - 1):
            a, b = rows[i], rows[i + 1]
            n = len(a)
            for j in range(n if closed else n - 1):
                k = (j + 1) % n
                q = (a[j], a[k], b[k], b[j])
                if len({id(x) for x in q}) < 4:
                    q = tuple(dict.fromkeys(q))
                    if len(q) < 3:
                        continue
                c = sum((ungame(x.co) for x in q), Vector()) / len(q)
                faces.append(self.face(q, mat_of(i, j), hint_of(i, j, c) if hint_of else None))
        return faces

    def obj(self, smooth_angle=None):
        me = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(me)
        self.bm.free()
        for m in self.mats:
            me.materials.append(self.MAT[m])
        for p in me.polygons:
            p.use_smooth = True
        if smooth_angle is not None:
            me.set_sharp_from_angle(angle=math.radians(smooth_angle))
        return link(bpy.data.objects.new(self.name, me))


def frame_of(d):
    """Two directions square to d (and to each other)."""
    d = Vector(d).normalized()
    t = Vector((0, 1, 0)) if abs(d.y) < 0.9 else Vector((1, 0, 0))
    a = d.cross(t).normalized()
    b = d.cross(a).normalized()
    return a, b


def lathe(B, prof, o, d, n, mat, e1=None, cap0=False, cap1=False, a0=0.0, sweep=2 * math.pi, mat_of=None, scale=(1.0, 1.0)):
    """A surface of revolution: `prof` is a list of (r, t) along the axis from `o` along `d` (game axes);
    rings of n points (an oval with `scale`). Faces look away from the axis where the profile runs with t
    rising (a tube's outside) and towards -d where it runs outwards at one t (a disc's back): give the profile
    in that order, or pass mat_of to pick materials per (i, j)."""
    o, d = Vector(o), Vector(d).normalized()
    if e1 is None:
        e1, e2 = frame_of(d)
    else:
        e1 = Vector(e1).normalized()
        e2 = d.cross(e1).normalized()
    full = abs(sweep - 2 * math.pi) < 1e-9
    m = n if full else n + 1
    rings = []
    for r, t in prof:
        ring = []
        for k in range(m):
            a = a0 + sweep * k / n
            ring.append(B.v(o + d * t + (e1 * math.cos(a) * scale[0] + e2 * math.sin(a) * scale[1]) * r))
        rings.append(ring)

    def hint(i, j, c):
        # Outward: away from the axis, or along it where the profile turns across it (a disc).
        (r0, t0), (r1, t1) = prof[i], prof[i + 1]
        dr, dt = r1 - r0, t1 - t0
        rad = c - (o + d * (c - o).dot(d))
        if rad.length > 1e-9:
            rad.normalize()
        # The profile's normal in (r, t): (dt, -dr) points away from the axis for a profile running along +t.
        return rad * dt + d * (-dr)

    B.grid(rings, mat_of or (lambda i, j: mat), closed=full, hint_of=hint)
    if cap0 and prof[0][0] > 1e-6:
        c = B.v(o + d * prof[0][1])
        for k in range(m if full else m - 1):
            B.face((rings[0][k], rings[0][(k + 1) % m], c), mat, -d)
    if cap1 and prof[-1][0] > 1e-6:
        c = B.v(o + d * prof[-1][1])
        for k in range(m if full else m - 1):
            B.face((rings[-1][k], rings[-1][(k + 1) % m], c), mat, d)
    return rings


def tube(B, pts, r, n, mat, caps=True, radius_of=None):
    """A round tube along a polyline (game axes), its frame carried along without twisting."""
    pts = [Vector(p) for p in pts]
    N = len(pts)
    tangents = []
    for i in range(N):
        a = pts[max(0, i - 1)]
        b = pts[min(N - 1, i + 1)]
        tangents.append((b - a).normalized())
    e1, _ = frame_of(tangents[0])
    rings = []
    for i, (p, t) in enumerate(zip(pts, tangents)):
        e1 = (e1 - t * e1.dot(t)).normalized()
        e2 = t.cross(e1).normalized()
        rr = radius_of(i / (N - 1)) if radius_of else r
        rings.append(([B.v(p + (e1 * math.cos(2 * math.pi * k / n) + e2 * math.sin(2 * math.pi * k / n)) * rr) for k in range(n)], p))

    def hint(i, j, c):
        a, b = rings[i][1], rings[i + 1][1]
        ax = (b - a).normalized()
        rad = c - (a + ax * (c - a).dot(ax))
        return rad

    B.grid([r_[0] for r_ in rings], lambda i, j: mat, closed=True, hint_of=hint)
    if caps:
        B.face(rings[0][0], mat, -tangents[0])
        B.face(rings[-1][0], mat, tangents[-1])


def box_bm(size, radius, segs=1):
    """A box with rounded edges, size (x, y, z), centred at the origin, as a bmesh (game axes)."""
    t = bmesh.new()
    bmesh.ops.create_cube(t, size=1.0)
    bmesh.ops.scale(t, vec=Vector(size), verts=t.verts)
    if radius > 0:
        bmesh.ops.bevel(t, geom=list(t.verts) + list(t.edges), offset=radius, segments=segs, affect="EDGES", profile=0.5)
    return t


def rbox(B, mat, size, radius, matrix, segs=1):
    """A box with rounded edges, size (x, y, z) in the game's axes, placed by a 4x4 matrix (game axes)."""
    t = box_bm(size, radius, segs)
    B.merge(t, mat, matrix)
    t.free()


def place(x, y, z, rx=0.0, ry=0.0, rz=0.0):
    """A matrix in the game's axes: at (x, y, z), turned by rx about x, then ry about y, then rz about z (degrees)."""
    return (Matrix.Translation((x, y, z)) @ Matrix.Rotation(math.radians(ry), 4, "Y") @ Matrix.Rotation(math.radians(rx), 4, "X")
            @ Matrix.Rotation(math.radians(rz), 4, "Z"))


def basis(o, xdir, ydir):
    """A matrix in the game's axes at o whose local x is xdir and local y as near ydir as can be."""
    x = Vector(xdir).normalized()
    z = x.cross(Vector(ydir)).normalized()
    y = z.cross(x).normalized()
    M = Matrix((x, y, z)).transposed().to_4x4()
    M.translation = Vector(o)
    return M


def hexbolt(B, p, nrm, r, h, mat, spin=0.0):
    """A flat six-sided bolt head on a surface at p (game axes) facing along nrm."""
    nrm = Vector(nrm).normalized()
    a, b = frame_of(nrm)
    base = [p - nrm * 0.002 + (a * math.cos(spin + k * math.pi / 3) + b * math.sin(spin + k * math.pi / 3)) * r for k in range(6)]
    top = [q + nrm * (h + 0.002) for q in base]
    vb = [B.v(q) for q in base]
    vt = [B.v(q) for q in top]
    for k in range(6):
        k1 = (k + 1) % 6
        c = (base[k] + base[k1]) / 2 - p
        B.face((vb[k], vb[k1], vt[k1], vt[k]), mat, c)
    B.face(vt, mat, nrm)


def smooth_vertex_normals(bm, rounds=4, keep=None):
    """Smooth a bmesh's corner normals over its neighbours a few times, the surface left where it is: a loft
    whose sections change shape quickly then reflects in calm bands instead of blotches. `keep(v)` marks the
    vertices to leave as they are (sharp lips). Call after normal_update; don't call it again afterwards."""
    bm.normal_update()
    ns = {v: v.normal.copy() for v in bm.verts}
    for _ in range(rounds):
        nxt = {}
        for v in bm.verts:
            if keep and keep(v):
                nxt[v] = ns[v]
                continue
            acc = ns[v] * 2.0
            for e in v.link_edges:
                acc += ns[e.other_vert(v)]
            nxt[v] = acc.normalized() if acc.length > 1e-9 else ns[v]
        ns = nxt
    for v in bm.verts:
        v.normal = ns[v]


# ---- Ray casts against a finished object (game axes in and out).

class Caster:
    def __init__(self, obj):
        self.tree = BVHTree.FromObject(obj, bpy.context.evaluated_depsgraph_get())

    def cast(self, origin, direction, reach=50.0):
        """Where a ray (game axes) meets the object: (point, normal) in the game's axes, or None."""
        loc, nrm, _, _ = self.tree.ray_cast(G(origin), G(direction).normalized(), reach)
        if loc is None:
            return None
        return ungame(loc), ungame(nrm)


def ribbon(B, hits, width, mat, out=0.0025, closed=False):
    """A band of a given width along surface points (from ray casts, game axes), lying on the surface."""
    hits = [h for h in hits if h]
    if len(hits) < 2:
        return
    n = len(hits)
    rows = []
    for i, (p, nrm) in enumerate(hits):
        a = hits[(i - 1) % n][0] if (closed or i > 0) else p
        b = hits[(i + 1) % n][0] if (closed or i < n - 1) else p
        t = b - a
        if t.length < 1e-7:
            continue
        s = nrm.cross(t).normalized()
        w = width(i / (n - 1)) if callable(width) else width
        rows.append((B.v(p + s * w / 2 + nrm * out), B.v(p - s * w / 2 + nrm * out), nrm))
    segs = len(rows) if closed else len(rows) - 1
    for i in range(segs):
        (a0, b0, n0), (a1, b1, n1) = rows[i], rows[(i + 1) % len(rows)]
        B.face((a0, a1, b1, b0), mat, n0 + n1)


def panel(B, ray, a_vals, b_fn, mat, out=0.003, skirt=0.003):
    """A raised panel on a surface (model_y.py's): ray(a, b) hits for each a and each b in b_fn(a), lifted by
    `out`, with an edge that slopes down to the surface a little outside it (a bevel, not a wall)."""
    grid = [[ray(a, b) for b in b_fn(a)] for a in a_vals]
    V = [[(B.v(h[0] + h[1] * out), h) if h else None for h in row] for row in grid]
    na, nb = len(V), len(V[0])
    centre = Vector()
    count = 0
    for i in range(na - 1):
        for j in range(nb - 1):
            q = (V[i][j], V[i + 1][j], V[i + 1][j + 1], V[i][j + 1])
            if all(q) and max((ungame(q[k][0].co) - ungame(q[(k + 1) % 4][0].co)).length for k in range(4)) < 0.15:
                B.face([c[0] for c in q], mat, sum((c[1][1] for c in q), Vector()))
                centre += ungame(q[0][0].co)
                count += 1
    if not skirt or not count:
        return
    centre /= count
    loop = [(0, j) for j in range(nb)] + [(i, nb - 1) for i in range(1, na)] + \
           [(na - 1, j) for j in range(nb - 2, -1, -1)] + [(i, 0) for i in range(na - 2, 0, -1)]
    edges = [((i0, j0), (i1, j1)) for (i0, j0), (i1, j1) in zip(loop, loop[1:] + loop[:1]) if V[i0][j0] and V[i1][j1]]
    away = {}
    for k0, k1 in edges:
        c0, c1 = V[k0[0]][k0[1]], V[k1[0]][k1[1]]
        e = ungame(c1[0].co) - ungame(c0[0].co)
        o = c0[1][1].cross(e)
        if o.dot((ungame(c0[0].co) + ungame(c1[0].co)) / 2 - centre) < 0:
            o = -o
        if o.length > 1e-9:
            o.normalize()
        for k in (k0, k1):
            away[k] = away.get(k, Vector()) + o
    low = {}
    for k0, k1 in edges:
        c0, c1 = V[k0[0]][k0[1]], V[k1[0]][k1[1]]
        for key_, c in ((k0, c0), (k1, c1)):
            if key_ not in low:
                p, nrm = c[1]
                o = away[key_].normalized() if away[key_].length > 1e-9 else Vector()
                low[key_] = B.v(p - nrm * 0.002 + o * min(2.5 * out, 0.012))
        mid = (ungame(c0[0].co) + ungame(c1[0].co)) / 2
        B.face((c0[0], c1[0], low[k1], low[k0]), mat, mid - centre)


def across(a, b, n=40):
    return [a + (b - a) * i / n for i in range(n + 1)]


def dense(pts, step):
    """More points along a polyline, about `step` apart."""
    out = []
    for (a0, b0), (a1, b1) in zip(pts, pts[1:]):
        k = max(1, int(math.hypot(a1 - a0, b1 - b0) / step))
        out += [(a0 + (a1 - a0) * i / k, b0 + (b1 - b0) * i / k) for i in range(k)]
    out.append(pts[-1])
    return out


# ---- Cutting a surface along lines (the glass, the seals, the colour borders follow real edges).

def bisect_polyline(bm, pts, region, normal_axis="x", closed=True, reach=0.004):
    """Cut the faces of a bmesh (Blender axes) along a polyline drawn in one of the game's planes: pts are
    (z, y) points seen from the side (normal_axis "x"), (x, y) from the front ("z") or (x, z) from above ("y").
    Each segment cuts, with a plane square to that view, only the faces it crosses (their corners on both
    sides of the plane, and the face over the segment's length), so the cut runs on the surface exactly along
    the drawn line and leaves the rest of the mesh as it was. `region(centre)` (game axes) limits the faces."""
    segs = list(zip(pts, pts[1:] + (pts[:1] if closed else [])))
    for (a0, b0), (a1, b1) in segs:
        L = math.hypot(a1 - a0, b1 - b0)
        if L < 1e-6:
            continue
        da, db = (a1 - a0) / L, (b1 - b0) / L
        if normal_axis == "x":       # (a, b) = (z, y)
            co = Vector((0.0, b0, a0))
            no = Vector((0.0, da, -db))
            pick = lambda c: (c.z, c.y)
        elif normal_axis == "z":     # (a, b) = (x, y)
            co = Vector((a0, b0, 0.0))
            no = Vector((db, -da, 0.0))
            pick = lambda c: (c.x, c.y)
        else:                        # (a, b) = (x, z)
            co = Vector((a0, 0.0, b0))
            no = Vector((db, 0.0, -da))
            pick = lambda c: (c.x, c.z)
        faces = []
        for f in bm.faces:
            ps = [pick(ungame(v.co)) for v in f.verts]
            sd = [(a - a0) * (-db) + (b - b0) * da for a, b in ps]      # across the segment
            if min(sd) >= -1e-7 or max(sd) <= 1e-7:
                continue
            al = [(a - a0) * da + (b - b0) * db for a, b in ps]         # along it
            if max(al) < -reach or min(al) > L + reach:
                continue
            if region(ungame(f.calc_center_median())):
                faces.append(f)
        if not faces:
            continue
        geom = list({e for f in faces for e in f.edges}) + faces + list({v for f in faces for v in f.verts})
        bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-6, plane_co=G(co), plane_no=G(no).normalized())


# ---- Preview renders.

def world_sky(scene, mode):
    world = bpy.data.worlds.new("Sky")
    world.use_nodes = True
    if hasattr(world, "probe_resolution"):
        world.probe_resolution = "2048"
    nt = world.node_tree
    bg = nt.nodes["Background"]
    coord = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(coord.outputs["Generated"], sep.inputs[0])
    if mode == "stripes":
        # Bands of light and dark round the horizon and over it: their reflections show every ripple.
        mul = nt.nodes.new("ShaderNodeMath")
        mul.operation = "MULTIPLY"
        mul.inputs[1].default_value = 40.0
        sn = nt.nodes.new("ShaderNodeMath")
        sn.operation = "SINE"
        gt = nt.nodes.new("ShaderNodeMath")
        gt.operation = "GREATER_THAN"
        gt.inputs[1].default_value = 0.0
        mr = nt.nodes.new("ShaderNodeMapRange")
        mr.inputs["To Min"].default_value = 0.03
        mr.inputs["To Max"].default_value = 1.6
        nt.links.new(sep.outputs["Z"], mul.inputs[0])
        nt.links.new(mul.outputs[0], sn.inputs[0])
        nt.links.new(sn.outputs[0], gt.inputs[0])
        nt.links.new(gt.outputs[0], mr.inputs["Value"])
        nt.links.new(mr.outputs["Result"], bg.inputs["Color"])
    else:
        ramp = nt.nodes.new("ShaderNodeValToRGB")
        rng = nt.nodes.new("ShaderNodeMapRange")
        rng.inputs["From Min"].default_value = -1
        nt.links.new(sep.outputs["Z"], rng.inputs["Value"])
        nt.links.new(rng.outputs["Result"], ramp.inputs["Fac"])
        els = ramp.color_ramp.elements
        if mode == "night":
            cols = ((0.0, (0.004, 0.004, 0.005)), (0.495, (0.01, 0.01, 0.012)), (0.505, (0.03, 0.035, 0.05)), (1.0, (0.004, 0.006, 0.014)))
        elif mode == "dusk":
            cols = ((0.0, (0.03, 0.025, 0.02)), (0.495, (0.08, 0.05, 0.04)), (0.505, (0.9, 0.45, 0.2)), (0.6, (0.35, 0.25, 0.35)), (1.0, (0.06, 0.08, 0.2)))
        else:
            cols = ((0.0, (0.05, 0.05, 0.045)), (0.495, (0.16, 0.155, 0.14)), (0.505, (0.85, 0.87, 0.9)), (0.62, (0.5, 0.62, 0.8)), (1.0, (0.22, 0.36, 0.62)))
        els[0].position, els[0].color = cols[0][0], (*cols[0][1], 1)
        els[1].position, els[1].color = cols[-1][0], (*cols[-1][1], 1)
        for pos, col in cols[1:-1]:
            e = els.new(pos)
            e.color = (*col, 1)
        nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    scene.world = world
    return world


def shade_materials(skip):
    """The baked shade multiplies the material's colour, as in the game."""
    for m in bpy.data.materials:
        if not m.use_nodes or m.name in skip:
            continue
        nt = m.node_tree
        p = nt.nodes.get("Principled BSDF")
        if not p or p.inputs["Base Color"].is_linked:
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


def render_views(folder, views, setup, size=(800, 450), samples=24):
    """Small Eevee renders. `views`: (name, camera at, looking at, lens or -ortho scale, mood); `setup(mood)`
    is called before each mood's first picture (it may show or hide parts)."""
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = samples
    if hasattr(scene.eevee, "use_raytracing"):
        scene.eevee.use_raytracing = True
    scene.render.resolution_x, scene.render.resolution_y = size
    scene.render.image_settings.file_format = "PNG"
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    cam.data.clip_start = 0.05
    cam.data.clip_end = 2000
    scene.camera = cam
    os.makedirs(folder, exist_ok=True)
    mood_now = None
    for label, at, look, lens, mood in views:
        if mood != mood_now:
            setup(mood)
            mood_now = mood
        cam.location = G(at)
        if lens < 0:
            cam.data.type = "ORTHO"
            cam.data.ortho_scale = -lens
        else:
            cam.data.type = "PERSP"
            cam.data.lens = lens
        cam.rotation_euler = (G(look) - G(at)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(folder, f"{label}.png")
        bpy.ops.render.render(write_still=True)
