"""Build the tree nurseries' young trees and shrubs (web/src/world/nursery.ts) as real plants, in Blender.

Run (Blender 5, no window):
  blender -b -P tools/nursery.py -- <out.glb> [preview_dir]

  e.g. blender -b -P tools/nursery.py -- web/public/models/nursery.glb

What stands in the rows of a Flemish tree nursery at the end of November, at the plants' real sizes,
built here in code (no image, no cut-out: every leaf is a few small opaque triangles, coloured on its
corners). The broadleaves are bare by now, a few yellow leaves left; the evergreens stand in blocks.

- Whip1, Whip2: an avenue tree's whip of two or three years, 2.2 to 2.6 m, one straight stem with short
  feathers (side shoots) up its length, tied to a bamboo cane with two black rubber ties.
- Standard: a young avenue tree with a clear stem of about 1.9 m and a small crown of five or six
  branches, tied to a sawn wooden stake.
- Maiden: a fruit tree's first-year whip, 1.5 m, feathered from low down, tied to a cane; a few
  yellow-green leaves still on.
- Conifer: a narrow column of arborvitae or yew, 1.3 m, in dense flat sprays of scale leaves.
- BoxBall: a clipped box ball, 0.5 m across, on a short stem; a few leaves turning bronze in the cold.
- Dogwood: red-barked dogwood, a round shrub of 0.9 m of bright red stems, the last purple leaves.
- Rose: a field rose cut back to 0.5 m: a few green and red canes from its knobbly foot, a few dark
  leaves and red hips.
- Hedge: 1.2 m of a row of beech hedge plants (five whips of 0.7 to 1.1 m, 24 cm apart) that keep
  their dry brown leaves all winter; the row's copies stand end to end.

Each in three levels of detail, as the big open-world games draw rows of crops and orchards: the near
model within ten metres or so; the far one (<name>Far), a tenth of its triangles, out to a few tens of
metres; and a stand-in (<name>Stub) of a handful of triangles that keeps the plant's outline and colour,
so a row a hundred metres off keeps its rhythm. The far and stand-in stems carry 0 in the colour's alpha:
the game widens them with distance, so they stay a pixel wide instead of shimmering in and out.

One GLB, one object per model, each standing on its origin (the plant's foot on the ground; the
hedge's row along x), with no normals (the game works them out) and no texture coordinates: the
colours are on the corners (COLOR_0), baked here; the game tints each copy a little.
"""
import json
import math
import os
import random
import struct
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
PREVIEW = argv[1] if len(argv) > 1 else ""

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)

UP = Vector((0, 0, 1))


def lin(h):
    """'#rrggbb' to linear RGB, as glTF's vertex colours are."""
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def mix(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


def scale(c, k):
    return tuple(min(1.0, x * k) for x in c)


def vary(c, rng, amount):
    """A colour a little lighter or darker and a little warmer or cooler."""
    k = 1 + (rng.random() * 2 - 1) * amount
    w = (rng.random() * 2 - 1) * amount * 0.5
    return tuple(min(1.0, max(0.0, x * k * (1 + w * s))) for x, s in zip(c, (1, 0, -1)))


MATERIAL = bpy.data.materials.new("Nursery")
MATERIAL.use_nodes = True
_bsdf = MATERIAL.node_tree.nodes["Principled BSDF"]
_attr = MATERIAL.node_tree.nodes.new("ShaderNodeVertexColor")
_attr.layer_name = "Col"
MATERIAL.node_tree.links.new(_attr.outputs["Color"], _bsdf.inputs["Base Color"])
_bsdf.inputs["Roughness"].default_value = 0.9
MATERIAL.use_backface_culling = False

NEAR, FAR, STUB = 0, 1, 2


class Mesh:
    """Corners with their colours (and alpha: 0 on a stem the game widens far off) and faces. `lod` NEAR,
    FAR or STUB; far: a leaf kept with chance `keep`, `grow` times as big, stalks thinner than `thin` m left
    out (its own random numbers, so the plant's own stay those of the near one)."""

    def __init__(self, name, lod, keep=0.3, grow=1.7, thin=0.004, seed=0):
        self.name = name
        self.lod = lod
        self.near = lod == NEAR
        self.keep = keep
        self.grow = grow
        self.thin = thin
        self.pick = random.Random(seed * 7919 + 13)
        self.verts = []
        self.cols = []
        self.faces = []

    def v(self, p, c, a=1.0):
        self.verts.append((p[0], p[1], p[2]))
        self.cols.append((c[0], c[1], c[2], a))
        return len(self.verts) - 1

    def face(self, ids, toward=None):
        ids = list(ids)
        if toward is not None:
            a, b, c = (Vector(self.verts[i]) for i in ids[:3])
            if (b - a).cross(c - a).dot(toward) < 0:
                ids.reverse()
        self.faces.append(ids)

    def tris(self):
        return sum(len(f) - 2 for f in self.faces)

    def obj(self):
        me = bpy.data.meshes.new(self.name)
        me.from_pydata(self.verts, [], self.faces)
        me.update()
        attr = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
        for i, c in enumerate(self.cols):
            attr.data[i].color = c
        me.color_attributes.active_color = attr
        me.materials.append(MATERIAL)
        ob = bpy.data.objects.new(self.name, me)
        bpy.context.scene.collection.objects.link(ob)
        return ob


def tube(m, pts, radii, sides, col, cap=False, far_sides=3, far_fat=1.4, alpha=1.0):
    """A tube along `pts` (radius per point), its rings carried along without twisting; `col(p, d, t)`
    the colour at point p facing d, t along the tube (0..1). Far: `far_sides` sides, every other point,
    `far_fat` times as thick; left out if thinner than the mesh's `thin`. `alpha` 0: widened far off."""
    if not m.near:
        if max(radii) < m.thin:
            return None
        keep = list(range(0, len(pts), 2))
        if keep[-1] != len(pts) - 1:
            keep.append(len(pts) - 1)
        pts = [pts[i] for i in keep]
        radii = [radii[i] * far_fat for i in keep]
        sides = far_sides
    n = len(pts)
    t = (pts[1] - pts[0]).normalized()
    ref = UP if abs(t.z) < 0.9 else Vector((1, 0, 0))
    nrm = t.cross(ref).normalized()
    rings = []
    for i, p in enumerate(pts):
        if i > 0:
            tn = (pts[min(i + 1, n - 1)] - pts[i - 1]).normalized()
            nrm = t.rotation_difference(tn) @ nrm
            t = tn
        b = t.cross(nrm)
        ring = []
        for k in range(sides):
            a = 2 * math.pi * k / sides
            d = nrm * math.cos(a) + b * math.sin(a)
            q = p + d * radii[i]
            ring.append(m.v(q, col(q, d, i / (n - 1)), alpha))
        rings.append(ring)
    for i in range(n - 1):
        for k in range(sides):
            k1 = (k + 1) % sides
            m.face((rings[i][k], rings[i][k1], rings[i + 1][k1], rings[i + 1][k]))
    if cap and sides > 2:
        m.face(rings[-1])
    return rings


def leaf(m, base, fwd, side, length, profile, col, tip_col=None, curl=0.0, fold=0.0):
    """A leaf from `base` along `fwd`, its outline `profile` [(u, half width, lift)] as fractions of `length`.
    Far: one in `keep` as a bigger diamond of two triangles."""
    fwd = fwd.normalized()
    side = (side - fwd * side.dot(fwd)).normalized()
    up = side.cross(fwd).normalized()
    tip_col = tip_col or col
    if not m.near:
        if m.pick.random() > m.keep:
            return
        length *= m.grow
        u, w, _ = max(profile, key=lambda q: q[1])
        profile = [(u, w, 0.0)]

    def at(u, w, z):
        return base + fwd * (u * length) + side * (w * length) + up * ((z - curl * u * u) * length)

    b = m.v(base, col)
    tip = m.v(at(1.0, 0.0, 0.0), tip_col)
    left = [m.v(at(u, w, z + fold * w), mix(col, tip_col, u)) for u, w, z in profile]
    right = [m.v(at(u, -w, z + fold * w), mix(col, tip_col, u)) for u, w, z in profile]
    m.face((b, left[0], right[0]), up)
    for i in range(len(profile) - 1):
        m.face((left[i], left[i + 1], right[i]), up)
        m.face((right[i], left[i + 1], right[i + 1]), up)
    m.face((left[-1], tip, right[-1]), up)


def ball(m, centre, r, col, dark, sides=6):
    """A berry or hip: a small octahedron (near only)."""
    if not m.near:
        return
    ids = [m.v(centre + Vector(d) * r, dark if d[2] < 0 else col)
           for d in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))]
    for a, b in ((0, 2), (2, 1), (1, 3), (3, 0)):
        for c in (4, 5):
            tri = (ids[a], ids[b], ids[c])
            mid = sum((Vector(m.verts[i]) for i in tri), Vector()) / 3
            m.face(tri, mid - centre)


def spine(start, heading, parts, rng=None, wobble=0.0):
    """Points along a stalk that climbs and bends in the upright plane through `heading`:
    parts [(length, pitch at start, pitch at end, steps)], pitch in degrees above level."""
    pts = [start.copy()]
    p = start.copy()
    for length, p0, p1, steps in parts:
        for i in range(steps):
            a = math.radians(p0 + (p1 - p0) * (i + 0.5) / steps)
            h = heading
            if rng and wobble:
                h = Matrix.Rotation((rng.random() - 0.5) * wobble, 3, "Z") @ heading
            p = p + (h * math.cos(a) + UP * math.sin(a)) * (length / steps)
            pts.append(p.copy())
    return pts


def at_along(pts, u):
    """The point and direction a fraction `u` along a polyline."""
    lengths = [(pts[i + 1] - pts[i]).length for i in range(len(pts) - 1)]
    goal = u * sum(lengths)
    for i, seg in enumerate(lengths):
        if goal <= seg or i == len(lengths) - 1:
            f = min(1.0, goal / seg) if seg else 0.0
            return pts[i].lerp(pts[i + 1], f), (pts[i + 1] - pts[i]).normalized()
        goal -= seg
    return pts[-1], (pts[-1] - pts[-2]).normalized()


def cross_strip(m, pts, widths, col, alpha=0.0, turns=(0.0, math.pi / 2)):
    """A stand-in's stalk: flat strips along `pts`, one per angle in `turns` (crossed, so it shows from
    every side), `widths` per point; two triangles per step and strip."""
    for a in turns:
        s = Vector((math.cos(a), math.sin(a), 0))
        ids = [(m.v(p - s * w, col(t), alpha), m.v(p + s * w, col(t), alpha))
               for t, (p, w) in ((i / (len(pts) - 1), q) for i, q in enumerate(zip(pts, widths)))]
        for i in range(len(ids) - 1):
            m.face((ids[i][0], ids[i][1], ids[i + 1][1], ids[i + 1][0]))


OVAL = [(0.25, 0.3, 0.0), (0.62, 0.3, 0.0)]
DIAMOND = [(0.42, 0.3, 0.0)]
BARK = lin("#5c5044")
BARK_TIP = lin("#6e4c3a")
CANE = lin("#9c8c66")
CANE_DARK = lin("#82724f")
STAKE = lin("#8a7a60")
TIE = lin("#1c1c1a")
YELLOW = [lin("#b3963a"), lin("#c2a446"), lin("#a07a30"), lin("#8c6a2e")]


def tie(m, at, toward, r):
    """A black rubber tie looped round the stem and its cane or stake (near only)."""
    if not m.near:
        return
    side = toward.cross(UP).normalized()
    pts = []
    for k in range(9):
        a = 2 * math.pi * k / 8
        pts.append(at + toward * (0.5 * math.cos(a) * (r + 0.01) + 0.5 * r) + side * math.sin(a) * 0.016)
    tube(m, pts, [0.004] * 9, 3, lambda p, d, t: TIE)


def whip(name, seed, lod, height, feathers, cane, leaves, leaf_cols, low=0.45):
    """A young tree on one straight stem with feathers up it, tied to a bamboo cane."""
    rng = random.Random(seed)
    m = Mesh(name, lod, keep=0.3, grow=1.8, thin=0.0035, seed=seed)
    lean = Vector((rng.uniform(-0.02, 0.02), rng.uniform(-0.02, 0.02), 1)).normalized()
    stem = [Vector((0, 0, -0.06))] + [lean * (height * i / 8) + Vector((rng.uniform(-0.006, 0.006), rng.uniform(-0.006, 0.006), 0)) for i in range(1, 9)]
    r0 = 0.011 + 0.002 * height
    cane_at = Vector((0.03, 0.0, 0.0))
    if lod == STUB:
        # The stem and its cane as one crossed strip, widened far off; the feathered top a thinner haze.
        cross_strip(m, [Vector((0, 0, -0.05)), lean * height], [r0 * 1.3, 0.002],
                    lambda t: mix(mix(scale(CANE, 0.7), BARK, 0.5), BARK_TIP, t))
        # The feathers: two thin slivers angled up from the stem, as a feathered whip's outline reads far off.
        for k in (0, 2):
            a = k * 2.4 + 0.5
            h = Vector((math.cos(a), math.sin(a), 0))
            base = lean * (height * (low + (0.9 - low) * k / 4))
            reach = height * (0.2 - 0.03 * k)
            s = h.cross(UP) * 0.012
            m.face([m.v(base - s, BARK, 0.0), m.v(base + s, BARK, 0.0), m.v(base + h * reach * 0.6 + UP * reach * 0.8, BARK_TIP, 0.0)])
        return m
    tube(m, stem, [r0 * (1 - 0.8 * i / 8) + 0.0012 for i in range(9)], 5,
         lambda p, d, t: scale(mix(BARK, BARK_TIP, t), 0.85 + 0.25 * max(0, d.x * 0.5 + d.z)), far_sides=3, far_fat=1.3, alpha=0.0)
    # The cane: a little longer than the stem's lower two thirds, straw-coloured with darker nodes.
    cane_pts = [cane_at + Vector((0, 0, -0.1)), cane_at + Vector((0.004, 0, cane * 0.5)), cane_at + Vector((0.007, 0.002, cane))]
    tube(m, cane_pts, [0.0065, 0.0058, 0.005], 4,
         lambda p, d, t: scale(CANE if int(p.z / 0.3) % 2 else CANE_DARK, 0.9 + 0.2 * max(0, d.x)), far_sides=3, far_fat=1.3, alpha=0.0)
    for z in (cane * 0.35, cane * 0.85):
        tie(m, lean * z, Vector((1, 0, 0)), 0.03)
    # The feathers: short side shoots in a spiral up the stem, longest a third of the way up, angled up.
    turn = rng.uniform(0, 6.28)
    for k in range(feathers):
        u = low + (0.93 - low) * (k + rng.uniform(0.1, 0.9)) / feathers
        turn += 2.4 + rng.uniform(-0.3, 0.3)
        p, _ = at_along(stem, u)
        h = Vector((math.cos(turn), math.sin(turn), 0))
        reach = height * (0.07 + 0.2 * math.sin(math.pi * min(1, (u - low) / (1 - low) * 0.9 + 0.15))) * rng.uniform(0.7, 1.2)
        up = rng.uniform(38, 58)
        pts = spine(p, h, [(reach, up, up + 8, 3)], rng, 0.3)
        if lod == FAR and k % 2:
            continue  # far: every other feather, the longest kept by their place in the spiral
        if lod == FAR:
            ids = [m.v(p - h.cross(UP) * 0.006, BARK, 0.0), m.v(p + h.cross(UP) * 0.006, BARK, 0.0), m.v(pts[-1], BARK_TIP, 0.0)]
            m.face(ids)
            continue
        tube(m, pts, [0.0045, 0.0034, 0.0024, 0.0014], 3, lambda q, d, t: mix(BARK, BARK_TIP, 0.6 + 0.4 * t))
        if reach > 0.2 and rng.random() < 0.6:
            q, t = at_along(pts, 0.55)
            d = (t + h.cross(UP) * rng.choice((-0.7, 0.7)) + UP * 0.4).normalized()
            tube(m, [q, q + d * reach * 0.2, q + d * reach * 0.35], [0.0022, 0.0018, 0.0011], 3, lambda q, dd, t: BARK_TIP)
        # Buds along it: a darker knot at each node is left to the colour; a leaf or two of the last.
        if k % 2 == 0 and leaves:
            for j in range(rng.randint(0, 2)):
                q, t = at_along(pts, rng.uniform(0.4, 1.0))
                col = vary(leaf_cols[rng.randrange(len(leaf_cols))], rng, 0.12)
                d = (t * 0.5 + h * 0.3 + Vector((0, 0, -0.7))).normalized()
                leaf(m, q, d, d.cross(UP) if abs(d.z) < 0.95 else h, rng.uniform(0.06, 0.09), OVAL, col, scale(col, 1.1), curl=0.25, fold=0.2)
    # A few more on the leader.
    for j in range(leaves // 2):
        q, t = at_along(stem, rng.uniform(0.75, 0.98))
        a = rng.uniform(0, 6.28)
        h = Vector((math.cos(a), math.sin(a), 0))
        col = vary(leaf_cols[rng.randrange(len(leaf_cols))], rng, 0.12)
        d = (h * 0.6 + Vector((0, 0, -0.6))).normalized()
        leaf(m, q, d, h.cross(UP), rng.uniform(0.06, 0.09), OVAL, col, scale(col, 1.1), curl=0.3, fold=0.2)
    return m


def standard(seed, lod):
    """A young avenue tree: a clear stem, a small crown of five or six branches, tied to a wooden stake."""
    rng = random.Random(seed)
    m = Mesh("Standard", lod, keep=0.3, grow=1.6, thin=0.004, seed=seed)
    clear = 1.9
    top = 2.9
    stem = [Vector((0, 0, -0.06))] + [Vector((rng.uniform(-0.008, 0.008), rng.uniform(-0.008, 0.008), top * i / 8)) for i in range(1, 9)]
    stake_at = Vector((0.065, 0.02, 0))
    if lod == STUB:
        cross_strip(m, [Vector((0, 0, -0.05)), Vector((0, 0, top))], [0.04, 0.004],
                    lambda t: mix(scale(BARK, 0.9), BARK_TIP, t))
        # The crown: three thin wedges, as its branches read from far off.
        for k in range(3):
            a = k * 2.1 + 0.3
            h = Vector((math.cos(a), math.sin(a), 0))
            s = h.cross(UP) * 0.03
            base = Vector((0, 0, clear + 0.05))
            tip = base + h * 0.55 + UP * 0.6
            ids = [m.v(base - s, BARK, 0.0), m.v(base + s, BARK, 0.0), m.v(tip, BARK_TIP, 0.0)]
            m.face(ids)
        return m
    tube(m, stem, [0.022 - 0.016 * i / 8 + (0.004 if i == 0 else 0) for i in range(9)], 6,
         lambda p, d, t: scale(mix(lin("#6a6052"), BARK_TIP, t * t), 0.85 + 0.25 * max(0, d.x * 0.5 + d.z)), far_sides=4, far_fat=1.2, alpha=0.0)
    # The stake: sawn, square-ish pine, 1.6 m out of the ground.
    tube(m, [stake_at + Vector((0, 0, -0.1)), stake_at + Vector((0, 0, 1.6))], [0.024, 0.024], 4,
         lambda p, d, t: scale(STAKE, 0.85 + 0.25 * max(0, d.x)), cap=True, far_sides=4, far_fat=1.0, alpha=0.0)
    for z in (0.9, 1.5):
        tie(m, Vector((0, 0, z)), (stake_at.normalized()), 0.065)
    # The crown: scaffold branches from the top of the clear stem, each with a few twigs.
    for b in range(6):
        u = (clear + 0.1 + 0.6 * b / 6) / top
        p, _ = at_along(stem, u)
        a = b * 2.4 + rng.uniform(-0.3, 0.3)
        h = Vector((math.cos(a), math.sin(a), 0))
        reach = rng.uniform(0.45, 0.8) * (1 - 0.4 * b / 6)
        pts = spine(p, h, [(reach, rng.uniform(38, 52), rng.uniform(55, 68), 4)], rng, 0.25)
        tube(m, pts, [0.009, 0.007, 0.005, 0.0035, 0.002], 4, lambda q, d, t: mix(BARK, BARK_TIP, 0.4 + 0.6 * t), far_sides=3)
        for k in range(3):
            q, t = at_along(pts, rng.uniform(0.3, 0.85))
            d = (t + h.cross(UP) * rng.uniform(-0.9, 0.9) + UP * 0.5).normalized()
            tl = reach * rng.uniform(0.25, 0.45)
            tube(m, [q, q + d * tl * 0.5, q + d * tl], [0.003, 0.0022, 0.0012], 3, lambda q, dd, t: BARK_TIP)
        if rng.random() < 0.5:
            q, t = at_along(pts, 0.95)
            col = vary(YELLOW[rng.randrange(4)], rng, 0.12)
            d = (h * 0.5 + Vector((0, 0, -0.8))).normalized()
            leaf(m, q, d, h.cross(UP), 0.08, OVAL, col, scale(col, 1.1), curl=0.3, fold=0.2)
    return m


def conifer(seed, lod):
    """A narrow column of arborvitae: a dark core and dense flat sprays of scale leaves, pointing up and out."""
    rng = random.Random(seed)
    m = Mesh("Conifer", lod, seed=seed)
    height = 1.3
    core = lin("#1c3018")
    greens = [lin("#243e1c"), lin("#2a4624"), lin("#20381c"), lin("#2e4a22")]
    tip_c = lin("#4a6a2c")

    def radius(z):
        """The column's radius at height z: widest a third of the way up, to a soft point."""
        u = z / height
        return 0.04 + 0.2 * math.sin(math.pi * min(1, (u * 0.85 + 0.12))) ** 0.8 * (1 - u * 0.55)

    rings = 5 if lod == NEAR else 3 if lod == FAR else 1
    sides = 8 if lod == NEAR else 6 if lod == FAR else 5
    ids = []
    for i in range(rings + 1):
        z = 0.08 + (height - 0.08) * i / (rings + 1)
        row = []
        for k in range(sides):
            a = 2 * math.pi * (k + 0.5 * (i % 2)) / sides
            r = radius(z) * (0.9 if lod == NEAR else 1.0) * (0.94 + 0.12 * rng.random())
            row.append(m.v(Vector((math.cos(a) * r, math.sin(a) * r, z)), mix(core, greens[0], 0.3 + 0.7 * (lod != NEAR)) if lod else core))
        ids.append(row)
    tip = m.v(Vector((0, 0, height)), tip_c if lod else core)
    foot = m.v(Vector((0, 0, 0.02)), core)
    for i in range(rings):
        for k in range(sides):
            k1 = (k + 1) % sides
            m.face((ids[i][k], ids[i][k1], ids[i + 1][k1], ids[i + 1][k]))
    for k in range(sides):
        m.face((ids[-1][k], ids[-1][(k + 1) % sides], tip))
        m.face((ids[0][(k + 1) % sides], ids[0][k], foot))
    # A short trunk at the foot.
    if lod == STUB:
        return m
    tube(m, [Vector((0, 0, -0.05)), Vector((0, 0, 0.12))], [0.014, 0.012], 4, lambda p, d, t: BARK)
    sprays = 760 if lod == NEAR else 44
    for k in range(sprays):
        # Spread evenly over the column (a spiral, jittered), so no bald patch shows the core.
        z = 0.1 + (height - 0.14) * ((k + rng.random()) / sprays) ** 0.9
        a = k * 2.39996 + rng.uniform(-0.3, 0.3)
        h = Vector((math.cos(a), math.sin(a), 0))
        r = radius(z) * rng.uniform(0.82, 1.0)
        base = h * r * 0.85 + Vector((0, 0, z))
        d = (h * rng.uniform(0.18, 0.32) + UP * rng.uniform(0.8, 1.0)).normalized()
        length = rng.uniform(0.045, 0.065) * (1.0 if lod == NEAR else 2.6)
        col = vary(greens[k % 4], rng, 0.08)
        shade = 0.7 + 0.45 * (z / height)
        # The spray: flat, fanned, broadest at two thirds, its face turned outwards.
        side = h.cross(UP)
        out = d.cross(side).normalized()
        if out.dot(h) < 0:
            out = -out
        w = length * 0.36
        p0 = m.v(base, scale(col, shade * 0.75))
        p1 = m.v(base + d * length * 0.62 + side * w + out * 0.01, scale(col, shade))
        p2 = m.v(base + d * length, scale(tip_c, shade))
        p3 = m.v(base + d * length * 0.62 - side * w + out * 0.01, scale(col, shade))
        m.face((p0, p1, p2), out)
        m.face((p0, p2, p3), out)
    return m


def box_ball(seed, lod):
    """A clipped box ball on a short stem: a dark core under a skin of small leaves, a few bronzed."""
    rng = random.Random(seed)
    m = Mesh("BoxBall", lod, seed=seed)
    centre = Vector((0, 0, 0.29))
    rad = 0.25
    core = lin("#20381c")
    greens = [lin("#30502a"), lin("#3a5a2c"), lin("#2c4a24"), lin("#445e2a")]
    bronze = lin("#5e5a2c")
    if lod != STUB:
        tube(m, [Vector((0, 0, -0.04)), Vector((0, 0, 0.1))], [0.012, 0.011], 4, lambda p, d, t: BARK)
    bm = bmesh.new()
    # Near: a dark core under the leaves; far: the ball itself, bumpy and mottled; the stand-in an icosahedron.
    bmesh.ops.create_icosphere(bm, subdivisions=3 if lod == NEAR else 2 if lod == FAR else 1, radius=1.0)
    base = len(m.verts)
    for v in bm.verts:
        d = v.co.normalized()
        flat = 0.9 if d.z < -0.6 else 1.0  # clipped flatter underneath
        bump = 1 + 0.04 * math.sin(d.x * 9 + seed) * math.sin(d.y * 7) + (0.07 * rng.random() if lod == FAR else 0)
        p = centre + Vector((d.x, d.y, d.z * 0.92 * flat)) * rad * bump * (0.93 if lod == NEAR else 1.0)
        shade = 0.6 + 0.5 * max(0, d.z * 0.5 + 0.5)
        col = core if lod == NEAR else scale(mix(mix(core, greens[rng.randrange(4)], 0.45 + 0.4 * rng.random()), bronze, 0.25 if rng.random() < 0.2 else 0), shade)
        m.v(p, col)
    for f in bm.faces:
        m.face([base + v.index for v in f.verts])
    bm.free()
    if lod == STUB:
        return m
    count = 600 if lod == NEAR else 36
    for k in range(count):
        # Even over the ball (a spiral), each leaf a small pointed oval, its face outwards; far, a few big ones that
        # break its outline, so it reads as a clipped shrub and not a smooth fruit.
        z = 1 - 2 * (k + 0.5) / count
        a = k * 2.39996
        d = Vector((math.cos(a) * math.sqrt(1 - z * z), math.sin(a) * math.sqrt(1 - z * z), z))
        d = (d + Vector((rng.uniform(-0.08, 0.08), rng.uniform(-0.08, 0.08), rng.uniform(-0.08, 0.08)))).normalized()
        p = centre + Vector((d.x, d.y, d.z * 0.92)) * rad * rng.uniform(0.94, 1.0)
        t = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1))).cross(d).normalized()
        col = vary(bronze if rng.random() < 0.12 else greens[rng.randrange(4)], rng, 0.12)
        col = scale(col, 0.65 + 0.5 * max(0, d.z * 0.5 + 0.5))
        size = rng.uniform(0.045, 0.055) * (1.0 if lod == NEAR else 2.4)
        leaf(m, p - t * size * 0.4, t + d * 0.25, d.cross(t), size, DIAMOND, col, scale(col, 1.12))
    return m


def dogwood(seed, lod):
    """Red-barked dogwood: a round shrub of straight bright red stems from one foot, the last leaves purple."""
    rng = random.Random(seed)
    m = Mesh("Dogwood", lod, keep=0.35, grow=1.6, thin=0.0035, seed=seed)
    reds = [lin("#7a2a22"), lin("#8a3226"), lin("#6c2620"), lin("#843628")]
    tip_c = lin("#964230")
    purple = [lin("#5a2a32"), lin("#6a3a2a"), lin("#4e2430")]
    stems = 16 if lod == NEAR else 9 if lod == FAR else 5
    for s in range(stems):
        a = 2 * math.pi * (s + rng.random() * 0.6) / stems
        h = Vector((math.cos(a), math.sin(a), 0))
        tall = rng.uniform(0.7, 1.0)
        lean = rng.uniform(62, 84)
        base = h * rng.uniform(0.01, 0.05)
        red = reds[rng.randrange(4)]
        pts = spine(base + Vector((0, 0, -0.03)), h, [(tall, lean, lean - 6, 4)], rng, 0.1)
        if lod == STUB:
            cross_strip(m, [pts[0], pts[-1]], [0.008, 0.002], lambda t: mix(scale(red, 0.7), tip_c, t), turns=(a + math.pi / 2,))
            continue
        tube(m, pts, [0.0075, 0.006, 0.0048, 0.0035, 0.002], 4, lambda p, d, t: scale(mix(red, tip_c, t), 0.8 + 0.3 * max(0, d.x * 0.5 + d.z)))
        for k in range(rng.randint(1, 3)):
            q, t = at_along(pts, rng.uniform(0.4, 0.8))
            d = (t + h.cross(UP) * rng.uniform(-0.7, 0.7) + h * 0.3).normalized()
            tl = rng.uniform(0.12, 0.25)
            tube(m, [q, q + d * tl * 0.5, q + d * tl], [0.0032, 0.0025, 0.0014], 3, lambda q, dd, t: mix(red, tip_c, 0.7))
            if rng.random() < 0.4:
                col = vary(purple[rng.randrange(3)], rng, 0.12)
                leaf(m, q + d * tl, (d + Vector((0, 0, -0.6))).normalized(), d.cross(UP), rng.uniform(0.06, 0.08), OVAL, col, scale(col, 1.15), curl=0.25, fold=0.2)
    return m


def rose(seed, lod):
    """A field rose cut back: green and red canes from a knobbly foot, a few dark leaves, red hips."""
    rng = random.Random(seed)
    m = Mesh("Rose", lod, keep=0.25, grow=1.7, thin=0.0045, seed=seed)
    canes = [lin("#3e4c24"), lin("#4e5228"), lin("#5a3424"), lin("#4a3a22")]
    leaves = [lin("#22381c"), lin("#2c4220"), lin("#4a2a22"), lin("#384420")]
    hip = lin("#a41e12")
    knob = Vector((0, 0, 0.06))
    if lod != STUB:
        tube(m, [Vector((0, 0, -0.04)), knob], [0.016, 0.018], 5, lambda p, d, t: lin("#4a3a2a"), cap=True)
    n = 9 if lod == NEAR else 6
    for c in range(n):
        a = 2 * math.pi * (c + rng.random() * 0.5) / n
        h = Vector((math.cos(a), math.sin(a), 0))
        tall = rng.uniform(0.35, 0.6)
        lean = rng.uniform(60, 80)
        col = canes[rng.randrange(4)]
        pts = spine(knob + h * 0.01, h, [(tall, lean, lean - 18, 4)], rng, 0.2)
        if lod == STUB:
            cross_strip(m, [pts[0], pts[-1]], [0.01, 0.003], lambda t: scale(col, 0.8 + 0.3 * t), turns=(a + math.pi / 2,))
            continue
        tube(m, pts, [0.0075, 0.0065, 0.0055, 0.0042, 0.003], 4, lambda p, d, t: scale(col, 0.8 + 0.3 * max(0, d.x * 0.5 + d.z)))
        # A side shoot or two, then leaves of five small leaflets on the upper half, and a hip or two.
        for k in range(rng.randint(1, 2)):
            q, t = at_along(pts, rng.uniform(0.35, 0.7))
            d = (t + h.cross(UP) * rng.uniform(-0.8, 0.8) + h * 0.4).normalized()
            tl = rng.uniform(0.12, 0.2)
            tube(m, [q, q + d * tl * 0.5, q + d * tl], [0.004, 0.0032, 0.002], 3, lambda q, dd, t: scale(col, 1.05))
        for k in range(rng.randint(2, 5)):
            q, t = at_along(pts, rng.uniform(0.4, 0.98))
            d = (t * 0.4 + h * 0.6 + Vector((0, 0, -0.2))).normalized()
            stalk = [q, q + d * 0.04, q + d * 0.08]
            lc = vary(leaves[rng.randrange(4)], rng, 0.12)
            for j, u in enumerate((0.3, 0.3, 0.7, 0.7, 1.0)):
                sgn = 1 if j % 2 else -1
                p, _ = at_along(stalk, u)
                side = d.cross(UP).normalized()
                fwd = (d * 0.6 + side * sgn * (0.8 if j < 4 else 0)).normalized()
                leaf(m, p, fwd, fwd.cross(UP), rng.uniform(0.028, 0.036), OVAL, lc, scale(lc, 1.12), curl=0.15, fold=0.2)
        if rng.random() < 0.55:
            ball(m, pts[-1] + Vector((0, 0, 0.008)), 0.008, hip, scale(hip, 0.6))
    return m


HEDGE_LEAVES = [lin("#744a26"), lin("#82582e"), lin("#663e20"), lin("#8c6434"), lin("#5a381e")]


def hedge(seed, lod):
    """1.2 m of a row of beech hedge plants along x: five whips 24 cm apart that keep their dry brown leaves."""
    rng = random.Random(seed)
    m = Mesh("Hedge", lod, keep=0.16, grow=2.0, thin=0.0035, seed=seed)
    stem_c = lin("#5a4c40")
    twig_c = lin("#6a5040")
    plants = []
    for i in range(5):
        x = -0.48 + 0.24 * i + rng.uniform(-0.04, 0.04)
        plants.append((Vector((x, rng.uniform(-0.035, 0.035), 0)), rng.uniform(0.7, 1.1)))
    if lod == STUB:
        # Each plant a narrow leafy spindle of brown, turned 45 degrees to the row one way or the other (so a row
        # seen along its length still shows them); the lowest 15 cm open (the stems).
        for i, (base, tall) in enumerate(plants):
            a = math.pi / 4 * (1 if i % 2 else -1)
            s = Vector((math.cos(a), math.sin(a), 0))
            col = HEDGE_LEAVES[i % 4]
            # Its outline: narrow at the foot, ragged on both sides, to a point at the leader.
            outline = [(0.0, 0.15), (0.07, 0.3), (0.1, 0.55), (0.04, 0.85), (0.0, 1.0), (-0.06, 0.75), (-0.09, 0.45), (-0.05, 0.28)]
            ids = [m.v(base + s * (w * 0.7) + Vector((0, 0, max(0.15, tall * u))), scale(col if u > 0.2 else HEDGE_LEAVES[4], 0.45 + 0.3 * u)) for w, u in outline]
            m.face(ids)
        return m
    for base, tall in plants:
        stem = spine(base + Vector((0, 0, -0.04)), Vector((1, 0, 0)), [(tall + 0.04, 88, 82, 5)], rng, 0.6)
        tube(m, stem, [0.007 - 0.005 * i / 5 for i in range(6)], 4, lambda p, d, t: scale(mix(stem_c, twig_c, t), 0.85 + 0.25 * max(0, d.x * 0.5 + d.z)))
        shoots = rng.randint(7, 9)
        for k in range(shoots):
            u = 0.25 + 0.72 * (k + rng.random()) / shoots
            p, _ = at_along(stem, u)
            # Held out across the row more than along it (they are cut back to the row's width).
            a = rng.choice((math.pi / 2, -math.pi / 2)) + rng.uniform(-0.8, 0.8)
            h = Vector((math.cos(a), math.sin(a), 0))
            reach = (0.24 * (1 - u) + 0.1) * rng.uniform(0.8, 1.2)
            pts = spine(p, h, [(reach, 30, 12, 2)], rng, 0.4)
            tube(m, pts, [0.003, 0.0022, 0.0012], 3, lambda q, d, t: twig_c)
            count = int(reach / 0.024) + 2
            for j in range(count):
                q, t = at_along(pts, 0.15 + 0.85 * j / count)
                sgn = 1 if j % 2 else -1
                side = t.cross(UP).normalized()
                d = (side * sgn + t * 0.7 + Vector((0, 0, rng.uniform(-0.3, 0.1)))).normalized()
                col = vary(HEDGE_LEAVES[rng.randrange(5)], rng, 0.1)
                leaf(m, q, d, d.cross(UP), rng.uniform(0.055, 0.075), DIAMOND, scale(col, 0.85), scale(col, 1.1),
                     curl=rng.uniform(0.1, 0.35), fold=rng.uniform(0.1, 0.35))
        # The leader's last leaves.
        for j in range(3):
            q, t = at_along(stem, rng.uniform(0.75, 0.97))
            a = rng.uniform(0, 6.28)
            d = Vector((math.cos(a), math.sin(a), rng.uniform(-0.2, 0.2))).normalized()
            col = vary(HEDGE_LEAVES[rng.randrange(5)], rng, 0.1)
            leaf(m, q, d, d.cross(UP), rng.uniform(0.055, 0.07), DIAMOND, scale(col, 0.85), scale(col, 1.1), curl=0.25, fold=0.25)
    return m


# --------------------------------------------------------------------------------------------- all of them
BUILD = [
    ("Whip1", lambda lod: whip("Whip1", 11, lod, 2.45, 14, 1.75, 4, YELLOW)),
    ("Whip2", lambda lod: whip("Whip2", 29, lod, 2.2, 12, 1.6, 2, YELLOW, low=0.55)),
    ("Standard", lambda lod: standard(41, lod)),
    ("Maiden", lambda lod: whip("Maiden", 53, lod, 1.5, 11, 1.45, 8, [lin("#8a8a34"), lin("#a09038"), lin("#6c7a2c")], low=0.3)),
    ("Conifer", lambda lod: conifer(61, lod)),
    ("BoxBall", lambda lod: box_ball(67, lod)),
    ("Dogwood", lambda lod: dogwood(71, lod)),
    ("Rose", lambda lod: rose(79, lod)),
    ("Hedge", lambda lod: hedge(83, lod)),
]

objs = []
for name, build in BUILD:
    for lod, suffix in ((NEAR, ""), (FAR, "Far"), (STUB, "Stub")):
        mesh = build(lod)
        mesh.name = name + suffix
        ob = mesh.obj()
        objs.append(ob)
        print(f"nursery: {ob.name} {mesh.tris()} triangles, {len(mesh.verts)} corners")

bpy.ops.object.select_all(action="DESELECT")
for o in objs:
    o.select_set(True)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=False, export_yup=True,
                          export_texcoords=False, export_normals=False, export_materials="NONE",
                          export_cameras=False, export_lights=False,
                          export_vertex_color="ACTIVE", export_all_vertex_colors=False)


def byte_colours(path):
    """The exporter writes the corners' colours as four 16-bit numbers; a byte each is plenty. Rewrites the GLB
    with each COLOR_0 as normalised bytes (glTF allows it), every other block as it was."""
    data = open(path, "rb").read()
    jlen = struct.unpack_from("<I", data, 12)[0]
    j = json.loads(data[20:20 + jlen])
    blen = struct.unpack_from("<I", data, 20 + jlen)[0]
    blob = data[28 + jlen:28 + jlen + blen]
    colours = {p["attributes"]["COLOR_0"] for me in j["meshes"] for p in me["primitives"] if "COLOR_0" in p["attributes"]}
    used = [a["bufferView"] for a in j["accessors"]]
    assert len(used) == len(set(used)) and not any("byteStride" in v for v in j["bufferViews"]), "one block per accessor"
    out = bytearray()
    for i, acc in enumerate(j["accessors"]):
        view = j["bufferViews"][acc["bufferView"]]
        raw = blob[view.get("byteOffset", 0):view.get("byteOffset", 0) + view["byteLength"]]
        if i in colours:
            assert acc["componentType"] == 5123 and acc["type"] == "VEC4"
            values = struct.unpack(f"<{len(raw) // 2}H", raw)
            raw = bytes(min(255, (v * 255 + 32767) // 65535) for v in values)
            acc["componentType"] = 5121
            acc["normalized"] = True
            acc.pop("byteOffset", None)
        view["byteOffset"] = len(out)
        view["byteLength"] = len(raw)
        out += raw
        out += b"\0" * (-len(out) % 4)
    j["buffers"][0]["byteLength"] = len(out)
    text = json.dumps(j, separators=(",", ":")).encode()
    text += b" " * (-len(text) % 4)
    total = 12 + 8 + len(text) + 8 + len(out)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(text), 0x4E4F534A) + text)
        f.write(struct.pack("<II", len(out), 0x004E4942) + bytes(out))


byte_colours(OUT)
print(f"nursery: {os.path.getsize(OUT)} bytes")

# ---------------------------------------------------------------- previews: each group, near, far and stand-in
if PREVIEW:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 960, 540
    world = bpy.data.worlds.new("Sky")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.7, 0.75, 0.82, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.9
    scene.world = world
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
    floor = bpy.data.materials.new("Floor")
    floor.use_nodes = True
    floor.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*lin("#4a3a2a"), 1)
    bpy.context.active_object.data.materials.append(floor)
    bpy.ops.object.light_add(type="SUN", location=(0, 0, 5))
    sun = bpy.context.active_object
    sun.data.energy = 3.5
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(-35))
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    cam.data.lens = 35
    os.makedirs(PREVIEW, exist_ok=True)
    groups = {
        "trees": ["Whip1", "Whip2", "Standard", "Maiden"],
        "shrubs": ["Conifer", "BoxBall", "Dogwood", "Rose", "Hedge"],
    }
    for label, names in groups.items():
        for o in objs:
            o.hide_render = True
        spacing = 1.3 if label == "shrubs" else 1.4
        for i, n in enumerate(names):
            for suffix, row in (("", 0.0), ("Far", 2.4), ("Stub", 4.8)):
                o = bpy.data.objects[n + suffix]
                o.hide_render = False
                o.location = (i * spacing, row, 0)
        mid = (len(names) - 1) * spacing / 2
        tall = 1.5 if label == "trees" else 0.6
        cam.location = (mid + 0.8, -5.5, tall + 1.2)
        target = Vector((mid, 2.0, tall * 0.6))
        cam.rotation_euler = (target - Vector(cam.location)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(PREVIEW, f"{label}.png")
        bpy.ops.render.render(write_still=True)
