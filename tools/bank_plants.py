"""Build the plants that grow along the ponds, ditches and creeks, in Blender.

Run (Blender 5, no window):
  blender -b -P tools/bank_plants.py -- <out.glb> [preview_dir]

  e.g. blender -b -P tools/bank_plants.py -- web/public/models/bank-plants.glb

What stands along a Flemish pond or ditch at the end of November, from the plants' published sizes
(the field guides' and the flora's measures; photos only to compare against):

  Common reed (Phragmites australis)   1.5 to 2.5 m: thin straight stems (about 1 cm), long narrow
      leaves (20 to 45 cm by 1 to 3 cm) standing off them, partly fallen by now, and a feathery plume
      (20 to 35 cm) on top that nods one way. Straw-beige stems and leaves, grey-brown plumes.
  Bulrush (Typha latifolia)            1.5 to 2 m: stiff flat strap leaves 1 to 2.5 cm wide going
      yellow-brown, and on bare stalks the dark brown cigar-shaped head (15 to 20 cm by about 3 cm)
      with the thin spent spike above it; some heads bursting into pale fluff.
  Soft rush (Juncus effusus)           0.5 to 0.8 m: a dense dark green tussock of round leafless
      stems (2 to 4 mm), the outer ones arching out.
  Coarse bank grass                    a tussock 0.3 to 0.6 m: long blades arching outwards and down,
      green with straw-yellow dead blades. It grows on the rim and hangs over it.
  Yellow flag (Iris pseudacorus)       in winter fans of sword leaves about 0.8 m (to 2.5 cm wide),
      yellowing, some bent over.

Real geometry, opaque, coloured on its corners (the attribute Col, linear), no image and no cut-out.
The thin parts are a little thicker than life (stems from 6 mm), so they don't flicker away to nothing
a few metres off. Each plant twice: near (hundreds of triangles) and far (a few dozen), as Reed1 and
Reed1Far. Each stands on its origin (its foot's middle), the stems reaching 15 cm under it so a plant on a
slope has no gap at its foot. The reeds' plumes nod towards +x in the GLB, the bank grass leans its blades
that way more: the game turns them, the plumes downwind and the grass out over the water
(web/src/world/bankPlants.ts). No normals: the game lights each plant as the clump it is.
"""
import math
import os
import random
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
PREVIEW = argv[1] if len(argv) > 1 else ""

bpy.ops.wm.read_factory_settings(use_empty=True)
coll = bpy.context.scene.collection


def lin(hex_colour):
    """An sRGB colour as linear values."""
    h = hex_colour.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return out


def mix(a, b, t):
    return [x + (y - x) * t for x, y in zip(a, b)]


def scale(c, s):
    return [x * s for x in c]


UP = Vector((0, 0, 1))


class Plant:
    """One plant's mesh: vertices with a colour each, faces sharing them."""

    def __init__(self, name):
        self.name = name
        self.verts = []
        self.cols = []
        self.faces = []

    def vert(self, co, col):
        self.verts.append(tuple(co))
        self.cols.append((*col, 1.0))
        return len(self.verts) - 1

    def strap(self, path, widths, side, cols):
        """A flat blade along `path`, `widths[i]` across at each point, across `side` (a vector or one per
        point); a width of 0 ends it in one point. Both faces drawn by the game (double-sided)."""
        rows = []
        for i, p in enumerate(path):
            s = side[i] if isinstance(side, list) else side
            w = widths[i] / 2
            if w <= 0:
                rows.append([self.vert(p, cols[i])])
            else:
                rows.append([self.vert(p - s * w, cols[i]), self.vert(p + s * w, cols[i])])
        for a, b in zip(rows, rows[1:]):
            if len(a) == 2 and len(b) == 2:
                self.faces.append((a[0], a[1], b[1], b[0]))
            elif len(a) == 2:
                self.faces.append((a[0], a[1], b[0]))
            elif len(b) == 2:
                self.faces.append((a[0], b[1], b[0]))

    def tube(self, path, radii, cols, sides=3, turn=0.0, caps=False):
        """A thin round stem along `path`, `radii[i]` thick at each point; a radius of 0 ends it in a point."""
        rings = []
        for i, p in enumerate(path):
            d = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
            a = d.cross(Vector((1, 0, 0)) if abs(d.x) < 0.9 else Vector((0, 1, 0))).normalized()
            b = d.cross(a)
            if radii[i] <= 0:
                rings.append([self.vert(p, cols[i])])
                continue
            ring = []
            for k in range(sides):
                t = turn + k / sides * math.tau
                ring.append(self.vert(p + (a * math.cos(t) + b * math.sin(t)) * radii[i], cols[i]))
            rings.append(ring)
        for r0, r1 in zip(rings, rings[1:]):
            if len(r0) > 1 and len(r1) > 1:
                for k in range(sides):
                    self.faces.append((r0[k], r0[(k + 1) % sides], r1[(k + 1) % sides], r1[k]))
            elif len(r0) > 1:
                for k in range(sides):
                    self.faces.append((r0[k], r0[(k + 1) % sides], r1[0]))
            elif len(r1) > 1:
                for k in range(sides):
                    self.faces.append((r0[0], r1[(k + 1) % sides], r1[k]))
        if caps:
            for ring, flip in ((rings[0], True), (rings[-1], False)):
                if len(ring) > 2:
                    self.faces.append(tuple(reversed(ring)) if flip else tuple(ring))

    def triangles(self):
        return sum(len(f) - 2 for f in self.faces)

    def build(self):
        mesh = bpy.data.meshes.new(self.name)
        mesh.from_pydata(self.verts, [], self.faces)
        mesh.update()
        attr = mesh.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
        attr.data.foreach_set("color", [c for col in self.cols for c in col])
        mesh.color_attributes.active_color = attr
        mesh.color_attributes.render_color_index = mesh.color_attributes.active_color_index
        ob = bpy.data.objects.new(self.name, mesh)
        coll.objects.link(ob)
        return ob


def bend(start, direction, length, droop, n):
    """Points along a blade leaving `start` along `direction`, bowing down by `droop` (m at the tip) as it goes."""
    d = direction.normalized()
    return [start + d * (length * i / n) - UP * (droop * (i / n) ** 2) for i in range(n + 1)]


def side_of(path, face=None):
    """A blade's sideways direction at each point: across its run, flat towards `face` (else lying flat)."""
    out = []
    for i in range(len(path)):
        d = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
        ref = face if face is not None else UP
        s = d.cross(ref)
        if s.length < 1e-4:
            s = d.cross(Vector((1, 0, 0)))
        out.append(s.normalized())
    return out


def ring_dir(angle, tilt):
    """A direction `tilt` radians off the vertical, towards `angle` round it."""
    return Vector((math.cos(angle) * math.sin(tilt), math.sin(angle) * math.sin(tilt), math.cos(tilt)))


# ---------------------------------------------------------------- colours (late November, linear)

STRAW = lin("#a48d62")
STRAW_PALE = lin("#b39f76")
STRAW_GREY = lin("#867a66")
PLUME = lin("#6a6256")
PLUME_LIGHT = lin("#928a7b")
TYPHA_LEAF = lin("#a48d4f")
TYPHA_GREEN = lin("#727440")
TYPHA_DRY = lin("#8a6c42")
TYPHA_HEAD = lin("#4a2f1c")
FLUFF = lin("#b9b0a0")
RUSH = lin("#3d5629")
RUSH_LIGHT = lin("#4f6a33")
RUSH_DEAD = lin("#8c7a4c")
GRASS = lin("#5d7533")
GRASS_LIGHT = lin("#748a3e")
GRASS_DEAD = lin("#a8925c")
GRASS_DEAD_PALE = lin("#bba679")
IRIS = lin("#8e9244")
IRIS_YELLOW = lin("#b5a24e")
IRIS_BROWN = lin("#8b6b3d")
IRIS_BASE = lin("#5c6e36")


def dark_foot(c, h, top):
    """Darker at the foot of a clump, where its own stems shade it."""
    return scale(c, 0.55 + 0.45 * min(1.0, max(0.0, h / top)))


# ---------------------------------------------------------------- common reed

def reed(name, seed, stems, far=False):
    rnd = random.Random(seed)
    p = Plant(name)
    top = 2.4
    for s in range(stems):
        a = rnd.random() * math.tau
        r = 0.38 * math.sqrt(rnd.random())
        foot = Vector((math.cos(a) * r, math.sin(a) * r, -0.15))
        h = rnd.uniform(1.5, 2.5)
        lean = Vector((rnd.uniform(-0.06, 0.06) + 0.04, rnd.uniform(-0.06, 0.06), 1)).normalized()
        tip = foot + lean * (h + 0.15)
        stem_col = mix(STRAW, STRAW_GREY, rnd.random() * 0.6)
        if far:
            # A stem and its leaves as one narrow blade, and a plume as a crossed diamond; a shade darker, as the
            # leaves and the stand's own shadow it stands for darken a real one.
            path = [foot, foot.lerp(tip, 0.55), tip]
            far_col = scale(stem_col, 0.8)
            p.strap(path, [0.035, 0.03, 0.0], side_of(path, Vector((math.cos(a + 1.3), math.sin(a + 1.3), 0))),
                    [dark_foot(far_col, 0, top), far_col, far_col])
        else:
            n = 3
            path = [foot.lerp(tip, i / n) for i in range(n + 1)]
            p.tube(path, [0.008, 0.007, 0.006, 0.004], [dark_foot(stem_col, q.z, top) for q in path], sides=3, turn=rnd.random())
            # The leaves left on it, alternating up the stem and hanging more the higher they sit.
            leaves = rnd.randint(1, 3)
            for k in range(leaves):
                t = rnd.uniform(0.3, 0.85)
                at = foot.lerp(tip, t)
                la = a + k * math.pi + rnd.uniform(-0.5, 0.5)
                out = ring_dir(la, rnd.uniform(0.6, 1.1))
                length = rnd.uniform(0.25, 0.45)
                path_l = bend(at, out, length, rnd.uniform(0.1, 0.3), 4)
                col = mix(STRAW_PALE, STRAW, rnd.random())
                face = Vector((-math.sin(la), math.cos(la), 0)).cross(out)
                p.strap(path_l, [0.012, 0.026, 0.022, 0.013, 0.0], side_of(path_l, face), [dark_foot(col, q.z, top) for q in path_l])
        if rnd.random() < 0.85 and h > 1.65:
            # The plume: a panicle nodding over towards +x from the stem's tip, its many fine branches hanging
            # from a thin axis, so it reads soft and feathery rather than as one shape.
            plume_len = rnd.uniform(0.22, 0.35)
            nod = Vector((1.0, rnd.uniform(-0.35, 0.35), rnd.uniform(0.5, 1.1))).normalized()
            col = mix(PLUME, PLUME_LIGHT, rnd.random())
            axis = bend(tip, nod, plume_len, plume_len * rnd.uniform(0.3, 0.6), 2)
            if far:
                for k in range(2):
                    s = side_of(axis, Vector((0, 1, 0)) if k else UP)
                    p.strap(axis, [0.0, 0.05, 0.0], s, [col, col, col])
            else:
                p.strap(axis, [0.008, 0.006, 0.0], side_of(axis, Vector((0, 1, 0))), [stem_col, col, col])
                d = (axis[2] - axis[0]).normalized()
                ref = d.cross(UP).normalized()
                branches = 7
                for k in range(branches):
                    t = 0.12 + 0.85 * k / (branches - 1)
                    i = min(1, int(t * 2))
                    at = axis[i].lerp(axis[i + 1], t * 2 - i)
                    spin = k * 2.4 + rnd.random() * 0.6
                    away = (ref * math.cos(spin) + d.cross(ref) * math.sin(spin)) * 0.55
                    # Hanging: along the axis, out a little, and down, the longer the nearer the plume's base.
                    way = (d + away - UP * 0.5).normalized()
                    length = plume_len * (0.5 - 0.25 * t) * rnd.uniform(0.8, 1.2)
                    branch = bend(at, way, length, length * 0.25, 2)
                    p.strap(branch, [0.014, 0.01, 0.0], side_of(branch, away.normalized()), [col, mix(col, PLUME_LIGHT, 0.4), scale(PLUME_LIGHT, 1.05)])
    return p


# ---------------------------------------------------------------- bulrush

def bulrush(name, seed, leaves, heads, fluff, far=False):
    rnd = random.Random(seed)
    p = Plant(name)
    top = 1.9
    for k in range(leaves):
        a = rnd.random() * math.tau
        foot = Vector((math.cos(a) * 0.08, math.sin(a) * 0.08, -0.15)) * rnd.random()
        foot.z = -0.15
        h = rnd.uniform(1.3, 1.95)
        out = ring_dir(a, rnd.uniform(0.05, 0.25))
        kink = rnd.random() < 0.2 and not far
        n = 2 if far else 6
        path = []
        for i in range(n + 1):
            t = i / n
            # Stiff and upright, curving out only near the top; a dead one broken over half way.
            q = foot + Vector((out.x * h * (0.15 * t + 0.55 * t ** 3), out.y * h * (0.15 * t + 0.55 * t ** 3), h * t))
            if kink and t > 0.55:
                q = foot + Vector((out.x * h * 0.2, out.y * h * 0.2, h * 0.55)) + Vector((out.x, out.y, -0.35)).normalized() * h * (t - 0.55)
            path.append(q)
        base = mix(TYPHA_GREEN, TYPHA_LEAF, rnd.random() * 0.5)
        cols = [dark_foot(mix(base, TYPHA_LEAF if i < n else TYPHA_DRY, i / n), path[i].z, top) for i in range(n + 1)]
        face = Vector((-math.sin(a), math.cos(a), 0))
        widths = [0.03, 0.025, 0.0] if far else [0.024, 0.024, 0.023, 0.021, 0.018, 0.012, 0.0]
        p.strap(path, widths, side_of(path, face.cross(out)), cols)
    for k in range(heads):
        a = rnd.random() * math.tau
        foot = Vector((math.cos(a) * 0.05, math.sin(a) * 0.05, -0.15))
        h = rnd.uniform(1.45, 1.85)
        lean = Vector((rnd.uniform(-0.04, 0.04), rnd.uniform(-0.04, 0.04), 1)).normalized()
        head0 = foot + lean * (h - 0.2)
        head1 = foot + lean * h
        spike = foot + lean * (h + 0.12)
        stalk = [foot, foot.lerp(head0, 0.5), head0]
        if far:
            p.strap(stalk, [0.014, 0.012, 0.012], side_of(stalk, Vector((1, 0, 0))), [TYPHA_GREEN, TYPHA_LEAF, TYPHA_LEAF])
            p.tube([head0, head1], [0.02, 0.02], [TYPHA_HEAD, TYPHA_HEAD], sides=4, caps=True)
            continue
        p.tube(stalk, [0.006, 0.0055, 0.005], [dark_foot(TYPHA_GREEN, 0, top), TYPHA_LEAF, TYPHA_LEAF], sides=3)
        # The head: a cigar of 3 cm, rounded at both ends; the male part above it a bare spike.
        cig = [head0.lerp(head1, t) for t in (0.0, 0.08, 0.5, 0.92, 1.0)]
        p.tube(cig, [0.008, 0.0155, 0.0165, 0.015, 0.008], [scale(TYPHA_HEAD, f) for f in (0.8, 1.0, 1.08, 1.0, 0.9)], sides=6, caps=True, turn=rnd.random())
        p.tube([head1, spike], [0.003, 0.0015], [TYPHA_DRY, TYPHA_DRY], sides=3)
        if k < fluff:
            # Bursting: a lumpy tuft of pale seed-fluff breaking out of one side of the head.
            c = head0.lerp(head1, rnd.uniform(0.35, 0.65)) + Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), 0)).normalized() * 0.018
            rings, segs = 4, 6
            ids = []
            for i in range(rings + 1):
                v = i / rings
                row = []
                for j in range(segs):
                    u = j / segs * math.tau
                    rr = 0.03 * math.sin(math.pi * v) * (0.8 + 0.3 * rnd.random())
                    q = c + Vector((math.cos(u) * rr, math.sin(u) * rr, (v - 0.5) * 0.11 + 0.01 * rnd.random()))
                    row.append(p.vert(q, mix(FLUFF, STRAW_PALE, rnd.random() * 0.4)))
                ids.append(row)
            for i in range(rings):
                for j in range(segs):
                    p.faces.append((ids[i][j], ids[i][(j + 1) % segs], ids[i + 1][(j + 1) % segs], ids[i + 1][j]))
    return p


# ---------------------------------------------------------------- soft rush

def rush(name, seed, stems, far=False):
    rnd = random.Random(seed)
    p = Plant(name)
    top = 0.8
    for k in range(stems):
        a = rnd.random() * math.tau
        r = 0.11 * math.sqrt(rnd.random())
        foot = Vector((math.cos(a) * r, math.sin(a) * r, -0.12))
        outer = r / 0.11
        h = rnd.uniform(0.5, 0.82) * (1.0 - 0.15 * outer)
        tilt = 0.08 + 0.75 * outer ** 1.5 * rnd.uniform(0.6, 1.0)
        out = ring_dir(a, tilt)
        dead = rnd.random() < (0.25 if outer > 0.7 else 0.06)
        col = RUSH_DEAD if dead else mix(RUSH, RUSH_LIGHT, rnd.random())
        tipc = mix(col, RUSH_DEAD, 0.55)
        n = 2
        path = bend(foot, out, h + 0.12, (h + 0.12) * 0.25 * outer, n)
        if far:
            p.strap(path, [0.04, 0.03, 0.0], side_of(path, Vector((-math.sin(a), math.cos(a), 0)).cross(out)),
                    [dark_foot(col, 0, top), col, tipc])
        else:
            p.tube(path, [0.0035, 0.003, 0.0], [dark_foot(col, path[0].z, top), dark_foot(col, path[1].z, top), tipc], sides=3, turn=rnd.random())
    return p


# ---------------------------------------------------------------- coarse bank grass

def grass(name, seed, blades, lean, far=False):
    rnd = random.Random(seed)
    p = Plant(name)
    top = 0.55
    for k in range(blades):
        # Towards +x more, by `lean` (the game turns that side out over the water).
        a = rnd.random() * math.tau
        if rnd.random() < lean:
            a = rnd.gauss(0, 0.8)
        r = 0.08 * math.sqrt(rnd.random())
        foot = Vector((math.cos(a) * r, math.sin(a) * r, -0.1))
        length = rnd.uniform(0.55, 0.95)
        tilt = rnd.uniform(0.3, 1.15)
        out = ring_dir(a, tilt)
        dead = rnd.random() < 0.5
        col = mix(GRASS_DEAD, GRASS_DEAD_PALE, rnd.random()) if dead else mix(GRASS, GRASS_LIGHT, rnd.random())
        n = 2 if far else 3
        # Arching out and over, the longer and the more tilted the further down its tip hangs.
        path = bend(foot, out, length, length * rnd.uniform(0.55, 0.95) * math.sin(tilt) + 0.1, n)
        face = Vector((-math.sin(a), math.cos(a), 0)).cross(out)
        widths = [0.045, 0.032, 0.0] if far else [0.014, 0.016, 0.011, 0.0]
        tipc = mix(col, GRASS_DEAD_PALE, 0.4)
        p.strap(path, widths, side_of(path, face), [dark_foot(col, 0, top)] + [col] * (n - 1) + [tipc])
    return p


# ---------------------------------------------------------------- yellow flag

def iris(name, seed, fans, far=False):
    rnd = random.Random(seed)
    p = Plant(name)
    top = 0.9
    for f in range(fans):
        fa = rnd.random() * math.tau
        centre = Vector((math.cos(fa) * 0.09, math.sin(fa) * 0.09, -0.12)) * (0 if f == 0 else 1)
        centre.z = -0.12
        plane = rnd.random() * math.pi  # the fan's own plane
        across = Vector((math.cos(plane), math.sin(plane), 0))
        flat = Vector((-math.sin(plane), math.cos(plane), 0))  # the leaves' faces look this way
        count = 4 if far else rnd.randint(5, 7)
        for k in range(count):
            spread = (k / (count - 1) - 0.5) * 2 if count > 1 else 0
            length = rnd.uniform(0.55, 0.95) * (1 - 0.3 * abs(spread))
            tilt = spread * 0.5 + rnd.uniform(-0.08, 0.08)
            d = (UP * math.cos(tilt) + across * math.sin(tilt)).normalized()
            bent = not far and rnd.random() < 0.3
            n = 2 if far else 5
            path = []
            for i in range(n + 1):
                t = i / n
                q = centre + across * spread * 0.02 + d * length * t + across * (math.copysign(1, spread or 1) * 0.12 * length * t ** 2)
                if bent and t > 0.5:
                    knee = centre + d * length * 0.5
                    down = (across * math.copysign(1, spread or 1) - UP * 0.6).normalized()
                    q = knee + down * length * (t - 0.5)
                path.append(q)
            col = mix(IRIS, IRIS_YELLOW, rnd.random() * 0.8)
            cols = [dark_foot(mix(IRIS_BASE, col, min(1, t * 2.5)) if i < n else mix(col, IRIS_BROWN, 0.7), path[i].z, top)
                    for i, t in enumerate(i / n for i in range(n + 1))]
            widths = [0.035, 0.03, 0.0] if far else [0.018, 0.024, 0.025, 0.022, 0.015, 0.0]
            p.strap(path, widths, side_of(path, flat), cols)
    return p


# ---------------------------------------------------------------- build, count, export

plants = [
    reed("Reed1", 11, 21), reed("Reed2", 23, 22), reed("Reed3", 37, 19),
    reed("Reed1Far", 11, 14, far=True), reed("Reed2Far", 23, 15, far=True), reed("Reed3Far", 37, 13, far=True),
    bulrush("Bulrush1", 41, 14, 3, 1), bulrush("Bulrush2", 53, 11, 2, 0),
    bulrush("Bulrush1Far", 41, 10, 3, 0, far=True), bulrush("Bulrush2Far", 53, 8, 2, 0, far=True),
    rush("Rush1", 61, 72), rush("Rush2", 67, 58),
    rush("Rush1Far", 61, 14, far=True), rush("Rush2Far", 67, 12, far=True),
    grass("Grass1", 71, 64, 0.35), grass("Grass2", 79, 56, 0.5), grass("Grass3", 83, 70, 0.25),
    grass("Grass1Far", 71, 18, 0.35, far=True), grass("Grass2Far", 79, 16, 0.5, far=True), grass("Grass3Far", 83, 18, 0.25, far=True),
    iris("Iris1", 89, 3), iris("Iris2", 97, 2),
    iris("Iris1Far", 89, 2, far=True), iris("Iris2Far", 97, 2, far=True),
]
objs = []
for pl in plants:
    ob = pl.build()
    objs.append(ob)
    lo = Vector([min(v[i] for v in pl.verts) for i in range(3)])
    hi = Vector([max(v[i] for v in pl.verts) for i in range(3)])
    print(f"  {pl.name}: {pl.triangles()} triangles, {len(pl.verts)} vertices, {hi.x - lo.x:.2f} x {hi.y - lo.y:.2f} m, {hi.z:.2f} m tall")

bpy.ops.object.select_all(action="DESELECT")
for o in objs:
    o.select_set(True)
bpy.context.view_layer.objects.active = objs[0]
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_texcoords=False, export_normals=False, export_vertex_color="ACTIVE", export_materials="NONE",
                          export_cameras=False, export_lights=False, export_extras=False)
print("wrote", OUT, os.path.getsize(OUT), "bytes")

# ---------------------------------------------------------------- preview: each kind near and far, with a metre
if PREVIEW:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 1200, 480
    world = bpy.data.worlds.new("Sky")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.62, 0.68, 0.76, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.9
    scene.world = world
    look = bpy.data.materials.new("Look")
    look.use_nodes = True
    look.use_backface_culling = False
    bsdf = look.node_tree.nodes["Principled BSDF"]
    attr = look.node_tree.nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"
    look.node_tree.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.9
    for o in objs:
        o.data.materials.append(look)
    ground = bpy.data.materials.new("Ground")
    ground.use_nodes = True
    ground.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.12, 0.16, 0.08, 1)
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
    bpy.context.active_object.data.materials.append(ground)
    red = bpy.data.materials.new("Metre")
    red.use_nodes = True
    red.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.8, 0.02, 0.02, 1)
    bpy.ops.object.light_add(type="SUN", location=(0, 0, 5))
    sun = bpy.context.active_object
    sun.data.energy = 3.2
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(-35))
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    scene.camera = cam
    os.makedirs(PREVIEW, exist_ok=True)
    by_name = {o.name: o for o in objs}
    groups = {
        "reed": ["Reed1", "Reed2", "Reed3", "Reed1Far", "Reed2Far", "Reed3Far"],
        "bulrush": ["Bulrush1", "Bulrush2", "Bulrush1Far", "Bulrush2Far"],
        "rush_grass_iris": ["Rush1", "Rush2", "Grass1", "Grass2", "Grass3", "Iris1", "Iris2"],
        "far_small": ["Rush1Far", "Rush2Far", "Grass1Far", "Grass2Far", "Grass3Far", "Iris1Far", "Iris2Far"],
    }
    bpy.ops.mesh.primitive_cube_add(size=1)
    bar = bpy.context.active_object
    bar.data.materials.append(red)
    for label, names in groups.items():
        for o in objs:
            o.hide_render = o.name not in names
        x = 0.0
        tall = 0.0
        for n in names:
            ob = by_name[n]
            w = max(v.co.x for v in ob.data.vertices) - min(v.co.x for v in ob.data.vertices)
            x += w / 2 + 0.15
            ob.location = (x, 0, 0)
            x += w / 2 + 0.15
            tall = max(tall, max(v.co.z for v in ob.data.vertices))
        bar.location = (-0.1, 0, 0.5)
        bar.scale = (0.03, 0.03, 1.0)
        mid = x / 2
        # From the side, square on (orthographic, the red bar a metre), and from a little above at three-quarters.
        for view, at, ortho in (("side", (mid, -30, tall * 0.5), max(x + 0.6, tall * 2.6)), ("three", (mid + x * 0.3, -x * 0.9, tall * 1.1), 0)):
            cam.location = at
            cam.data.type = "ORTHO" if ortho else "PERSP"
            cam.data.ortho_scale = ortho or 1
            cam.data.lens = 35
            cam.rotation_euler = (Vector((mid, 0, tall * (0.5 if ortho else 0.35))) - Vector(at)).to_track_quat("-Z", "Y").to_euler()
            scene.render.filepath = os.path.join(PREVIEW, f"{label}_{view}.png")
            bpy.ops.render.render(write_still=True)
        for n in names:
            by_name[n].location = (0, 0, 0)
